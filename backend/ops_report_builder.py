"""Operations > Report Builder (Neil, Ops review, Oct 20 2026): "I want to
take this variable, this variable, combine the two, and create a metric."

A report is a SPEC, never SQL:
  dataset     one of DATASETS (units, rentals, payments, leads, moves)
  dimensions  up to MAX_DIMS of that dataset's dimensions (facility, unit type, month...)
  measures    [{id, agg: count|sum|avg|min|max, field}] - fields from the dataset's list
  formulas    [{id, label, expr, format}] - arithmetic over measure ids and
              earlier formula ids (e.g. "rent / occupied_area"), parsed here
              into a tree; no eval, no names outside the spec
  filters     [{dimension, values}] - exact matches on a dimension
  period      a preset (this-month, last-month, last-7, last-30, last-90,
              this-year, last-12, all) or custom {from, to}; datasets with a
              date filter on it, units (a snapshot) ignore it
  facilities  [] = every facility
Anything not in the registry is refused with 422 (`SpecError`) - the
registry is the whitelist, and rows are read through ops_reports.Data, whose
fields carry no phone, email or address.

Saved reports (ops_saved_reports) keep a spec, who may see it (the owner, or
the Operations team when shared), and an optional schedule: weekly (a
weekday) or monthly (a day 1-28). The schedule loop - the "autopilot" - sends
each due report once per period to its recipients: one email per report,
with the table in the body and the CSV attached (graph_mail, from the Nexus
mailbox). A send is claimed with a conditional UPDATE on last_sent_period, so
two workers cannot both send; a failed send gives the claim back and is
retried at most once an hour.
"""
from __future__ import annotations

import asyncio
import csv
import html as _html
import io
import re
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import ops_reports

MAX_DIMS = 3
MAX_MEASURES = 8
MAX_FORMULAS = 6
MAX_FILTERS = 6
MAX_GROUPS = 2000
MAX_RECIPIENTS = 25
SEND_HOUR = 7                    # local (Pacific) hour a due report goes out
RETRY_AFTER_SEC = 3600
SCAN_EVERY_SEC = 10 * 60
TZ = "America/Los_Angeles"
_ID = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
AGGS = {"count": "Count", "sum": "Sum", "avg": "Average", "min": "Minimum", "max": "Maximum"}
FORMATS = {"number", "money", "pct", "area"}
PERIODS = {"this-month": "This Month", "last-month": "Last Month", "last-7": "Last 7 Days", "last-30": "Last 30 Days",
           "last-90": "Last 90 Days", "this-year": "This Year", "last-12": "Last 12 Months", "all": "All Time",
           "custom": "Custom"}
SCHEDULES = {"": "Not Scheduled", "weekly": "Weekly", "monthly": "Monthly"}
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


class SpecError(Exception):
    pass


# ── The registry (the whitelist) ──────────────────────────────────────────────
# dims: key -> label. fields: key -> (label, format). date: the row key the
# period filters on (None = a snapshot as of the last sync).

DATASETS = {
    "units": {
        "label": "Units", "about": "Every unit as of the last Cubby sync: one row per unit.", "date": None,
        "dims": {"facility": "Facility", "unit_type": "Unit Type", "size": "Size", "status": "Status"},
        "fields": {"area": ("Area (Sq Ft)", "area"), "occupied": ("Occupied (1 or 0)", "number"),
                   "vacant": ("Vacant (1 or 0)", "number"), "off_market": ("Off Market (1 or 0)", "number"),
                   "occupied_area": ("Occupied Sq Ft", "area"), "street_rate": ("Street Rate", "money"),
                   "rent": ("Monthly Rent (Rented Units)", "money"), "balance": ("Balance Due", "money")},
    },
    "rentals": {
        "label": "Rentals", "about": "Every tenancy, past and current: one row per lease, dated by its move-in.", "date": "move_in",
        "dims": {"facility": "Facility", "unit_type": "Unit Type", "month": "Move-In Month", "move_out_month": "Move-Out Month",
                 "status": "Status"},
        "fields": {"rent": ("Monthly Rent", "money"), "area": ("Area (Sq Ft)", "area"), "stay_days": ("Length of Stay (Days)", "number"),
                   "active": ("Active (1 or 0)", "number")},
    },
    "payments": {
        "label": "Payments", "about": "Every payment Cubby recorded (from 09/15/2026): one row per payment, dated by payment date.",
        "date": "date",
        "dims": {"facility": "Facility", "month": "Month", "week": "Week Starting", "method": "Method", "status": "Status"},
        "fields": {"amount": ("Amount", "money"), "collected": ("Collected (Succeeded)", "money"),
                   "succeeded": ("Succeeded (1 or 0)", "number"), "failed": ("Failed (1 or 0)", "number")},
    },
    "leads": {
        "label": "Leads", "about": "Every lead: one row per lead, dated by when it was created.", "date": "created",
        "dims": {"facility": "Facility", "month": "Month Created", "status": "Status", "source": "Source"},
        "fields": {"converted": ("Converted (1 or 0)", "number"), "reserved": ("Reserved (1 or 0)", "number"),
                   "open": ("Open (1 or 0)", "number"), "lost": ("Lost (1 or 0)", "number")},
    },
    "moves": {
        "label": "Move-Ins and Move-Outs", "about": "One row per move-in and per move-out, dated by the move.", "date": "date",
        "dims": {"facility": "Facility", "month": "Month", "kind": "Move", "unit_type": "Unit Type"},
        "fields": {"rent": ("Monthly Rent", "money"), "area": ("Area (Sq Ft)", "area"), "net": ("Net (+1 In, -1 Out)", "number"),
                   "move_in": ("Move-In (1 or 0)", "number"), "move_out": ("Move-Out (1 or 0)", "number")},
    },
}


def registry() -> dict:
    return {
        "datasets": [{"key": k, "label": v["label"], "about": v["about"], "dated": bool(v["date"]),
                      "dimensions": [{"key": dk, "label": dl} for dk, dl in v["dims"].items()],
                      "fields": [{"key": fk, "label": fl, "format": ff} for fk, (fl, ff) in v["fields"].items()]}
                     for k, v in DATASETS.items()],
        "aggregations": [{"key": k, "label": v} for k, v in AGGS.items()],
        "formats": sorted(FORMATS), "periods": [{"key": k, "label": v} for k, v in PERIODS.items()],
        "schedules": [{"key": k, "label": v} for k, v in SCHEDULES.items()], "weekdays": WEEKDAYS,
        "limits": {"dimensions": MAX_DIMS, "measures": MAX_MEASURES, "formulas": MAX_FORMULAS, "recipients": MAX_RECIPIENTS},
    }


# ── Formulas: a tiny arithmetic language over measure ids ─────────────────────

_TOKEN = re.compile(r"\s*(?:(\d+(?:\.\d+)?)|([a-z][a-z0-9_]*)|(.))")


def parse_formula(expr: str, known: set[str]):
    """expr -> a tree of ("num", x) | ("ref", id) | (op, left, right) | ("neg", x).
    Only numbers, the ids in `known`, + - * / and parentheses."""
    expr = (expr or "").strip()
    if not expr or len(expr) > 200:
        raise SpecError("A formula needs 1 to 200 characters")
    tokens = []
    for num, name, other in _TOKEN.findall(expr):
        if num:
            tokens.append(("num", float(num)))
        elif name:
            if name not in known:
                raise SpecError(f"The formula uses '{name}', which is not a measure in this report")
            tokens.append(("ref", name))
        elif other.strip():
            if other not in "+-*/()":
                raise SpecError(f"A formula can use + - * / and parentheses only, not '{other}'")
            tokens.append(("op", other))
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else None

    def take():
        nonlocal pos
        pos += 1
        return tokens[pos - 1]

    def expr_():
        node = term()
        while peek() and peek()[0] == "op" and peek()[1] in "+-":
            node = (take()[1], node, term())
        return node

    def term():
        node = factor()
        while peek() and peek()[0] == "op" and peek()[1] in "*/":
            node = (take()[1], node, factor())
        return node

    def factor():
        t = peek()
        if t is None:
            raise SpecError("The formula ends too soon")
        if t == ("op", "-"):
            take()
            return ("neg", factor())
        if t == ("op", "("):
            take()
            node = expr_()
            if peek() != ("op", ")"):
                raise SpecError("A parenthesis is not closed")
            take()
            return node
        if t[0] in ("num", "ref"):
            return take()
        raise SpecError(f"Unexpected '{t[1]}' in the formula")
    tree = expr_()
    if pos != len(tokens):
        raise SpecError("The formula has something extra at the end")
    return tree


def evaluate(tree, values: dict):
    """None when a value is missing or a division is by zero."""
    kind = tree[0]
    if kind == "num":
        return tree[1]
    if kind == "ref":
        v = values.get(tree[1])
        return float(v) if v is not None else None
    if kind == "neg":
        v = evaluate(tree[1], values)
        return -v if v is not None else None
    a, b = evaluate(tree[1], values), evaluate(tree[2], values)
    if a is None or b is None:
        return None
    if kind == "+":
        return a + b
    if kind == "-":
        return a - b
    if kind == "*":
        return a * b
    return a / b if b else None


# ── Spec validation ───────────────────────────────────────────────────────────

def validate(spec: dict) -> dict:
    """A clean copy of the spec, or SpecError. Unknown keys are dropped;
    unknown datasets, dimensions, fields, aggregations or ids are refused."""
    if not isinstance(spec, dict):
        raise SpecError("A report spec is an object")
    ds_key = spec.get("dataset")
    ds = DATASETS.get(ds_key)
    if not ds:
        raise SpecError("Pick a dataset")
    dims = spec.get("dimensions") or []
    if not isinstance(dims, list) or len(dims) > MAX_DIMS or len(set(dims)) != len(dims):
        raise SpecError(f"Pick up to {MAX_DIMS} different dimensions")
    for d in dims:
        if d not in ds["dims"]:
            raise SpecError(f"'{d}' is not a dimension of {ds['label']}")
    measures = []
    raw = spec.get("measures") or []
    if not isinstance(raw, list) or not raw or len(raw) > MAX_MEASURES:
        raise SpecError(f"Add 1 to {MAX_MEASURES} measures")
    ids = set()
    for m in raw:
        if not isinstance(m, dict):
            raise SpecError("A measure is an object")
        mid, agg, field = str(m.get("id") or ""), m.get("agg"), m.get("field") or ""
        if not _ID.match(mid) or mid in ids:
            raise SpecError("Each measure needs its own short id (lowercase letters, numbers, _)")
        if agg not in AGGS:
            raise SpecError(f"'{agg}' is not an aggregation")
        if agg != "count" or field:
            if field not in ds["fields"]:
                raise SpecError(f"'{field}' is not a field of {ds['label']}")
        ids.add(mid)
        label = str(m.get("label") or "").strip()[:60] or (
            "Count" if agg == "count" and not field else f"{AGGS[agg]} of {ds['fields'][field][0]}")
        measures.append({"id": mid, "agg": agg, "field": field, "label": label})
    formulas = []
    raw = spec.get("formulas") or []
    if not isinstance(raw, list) or len(raw) > MAX_FORMULAS:
        raise SpecError(f"Add up to {MAX_FORMULAS} formulas")
    for f in raw:
        if not isinstance(f, dict):
            raise SpecError("A formula is an object")
        fid = str(f.get("id") or "")
        if not _ID.match(fid) or fid in ids:
            raise SpecError("Each formula needs its own short id (lowercase letters, numbers, _)")
        fmt = f.get("format") or "number"
        if fmt not in FORMATS:
            raise SpecError(f"'{fmt}' is not a number format")
        parse_formula(f.get("expr") or "", ids)
        ids.add(fid)
        formulas.append({"id": fid, "label": str(f.get("label") or fid).strip()[:60], "expr": str(f["expr"]).strip(), "format": fmt})
    filters = []
    raw = spec.get("filters") or []
    if not isinstance(raw, list) or len(raw) > MAX_FILTERS:
        raise SpecError(f"Add up to {MAX_FILTERS} filters")
    for f in raw:
        dim = (f or {}).get("dimension")
        vals = (f or {}).get("values") or []
        if dim not in ds["dims"]:
            raise SpecError(f"'{dim}' is not a dimension of {ds['label']}")
        if not isinstance(vals, list) or not vals or len(vals) > 50:
            raise SpecError("A filter needs 1 to 50 values")
        filters.append({"dimension": dim, "values": [str(v)[:120] for v in vals]})
    period = spec.get("period") or "this-month"
    if period not in PERIODS:
        raise SpecError("Pick a period")
    out = {"dataset": ds_key, "dimensions": list(dims), "measures": measures, "formulas": formulas,
           "filters": filters, "period": period, "facilities": [], "sort": None}
    if period == "custom":
        try:
            a, b = date.fromisoformat(spec.get("from") or ""), date.fromisoformat(spec.get("to") or "")
        except ValueError:
            raise SpecError("A custom period needs a start and an end date") from None
        if a > b:
            raise SpecError("The period starts after it ends")
        out["from"], out["to"] = a.isoformat(), b.isoformat()
    facs = spec.get("facilities") or []
    if not isinstance(facs, list) or len(facs) > 50 or not all(isinstance(f, str) and len(f) < 80 for f in facs):
        raise SpecError("Facilities are a list of facility ids")
    out["facilities"] = facs
    sort = spec.get("sort") or None
    if sort:
        if not isinstance(sort, dict) or sort.get("by") not in (ids | set(dims)):
            raise SpecError("Sort by a dimension or a measure of this report")
        out["sort"] = {"by": sort["by"], "desc": bool(sort.get("desc"))}
    return out


def period_range(spec: dict, today: date) -> tuple[str, str]:
    p = spec.get("period") or "this-month"
    if p == "custom":
        return spec["from"], spec["to"]
    if p == "all":
        return "2000-01-01", today.isoformat()
    if p == "last-month":
        first = today.replace(day=1)
        end = first - timedelta(days=1)
        return end.replace(day=1).isoformat(), end.isoformat()
    back = {"last-7": 6, "last-30": 29, "last-90": 89}
    if p in back:
        return (today - timedelta(days=back[p])).isoformat(), today.isoformat()
    if p == "this-year":
        return f"{today.year}-01-01", today.isoformat()
    if p == "last-12":
        try:
            a = today.replace(year=today.year - 1) + timedelta(days=1)
        except ValueError:   # Feb 29
            a = today.replace(year=today.year - 1, day=28) + timedelta(days=1)
        return a.isoformat(), today.isoformat()
    return today.replace(day=1).isoformat(), today.isoformat()


# ── Rows per dataset ──────────────────────────────────────────────────────────

def _monday(iso: str) -> str:
    d = date.fromisoformat(iso)
    return (d - timedelta(days=d.weekday())).isoformat()


def _rows(dataset: str, d: ops_reports.Data, a: str, b: str) -> list[dict]:
    short = {f["id"]: f["short"] for f in d.facs}
    out = []
    if dataset == "units":
        owed = defaultdict(int)
        for r in d.receivables():
            owed[(r["fid"], r["unitId"])] += r["total"]
        for u in d.units.values():
            rented = u["status"] == "RENTED"
            out.append({"facility": short[u["fid"]], "unit_type": u["type"], "size": u["size"] or "Unknown", "status": u["statusLabel"],
                        "area": u["area"], "occupied": 1 if rented else 0, "vacant": 1 if u["status"] == "VACANT" else 0,
                        "off_market": 0 if rented or u["status"] == "VACANT" else 1, "occupied_area": u["area"] if rented else 0,
                        "street_rate": u["street"], "rent": u["rent"] if rented else None,
                        "balance": owed.get((u["fid"], u["id"]), 0) if rented else None})
    elif dataset == "rentals":
        for r in d.rentals():
            if not (r["moveIn"] and a <= r["moveIn"] <= b):
                continue
            today = d.fac[r["fid"]]["today"]
            active = not r["moveOut"] or r["moveOut"] > today.isoformat()
            end = date.fromisoformat(r["moveOut"]) if r["moveOut"] and not active else today
            out.append({"facility": short[r["fid"]], "unit_type": r["type"], "month": r["moveIn"][:7],
                        "move_out_month": r["moveOut"][:7] if r["moveOut"] else "None", "status": "Active" if active else "Ended",
                        "move_in": r["moveIn"], "rent": r["rent"], "area": r["area"],
                        "stay_days": (end - date.fromisoformat(r["moveIn"])).days, "active": 1 if active else 0})
    elif dataset == "payments":
        for p in d.payments(a, b):
            ok = p["status"] == "SUCCEEDED"
            out.append({"facility": short[p["fid"]], "date": p["date"], "month": p["date"][:7], "week": _monday(p["date"]),
                        "method": ops_reports._tidy(p["method"]) or "Other", "status": ops_reports._tidy(p["status"]),
                        "amount": p["amount"], "collected": p["amount"] if ok else None, "succeeded": 1 if ok else 0,
                        "failed": 1 if p["status"] in ops_reports.FAILED else 0})
    elif dataset == "leads":
        for ld in d.leads():
            if not (ld["created"] and a <= ld["created"] <= b) or ld["status"] == "DUPLICATE":
                continue
            st = ld["status"]
            out.append({"facility": short[ld["fid"]], "created": ld["created"], "month": ld["created"][:7],
                        "status": ops_reports._tidy(st), "source": ops_reports._tidy(ld["source"]) or "Unknown",
                        "converted": 1 if st == "CONVERTED" else 0, "reserved": 1 if st == "RESERVATION" else 0,
                        "open": 1 if st in ("NEW", "IN_PROGRESS_HOT", "IN_PROGRESS_COLD", "ON_HOLD", "RESERVATION") else 0,
                        "lost": 1 if st in ("LOST", "ARCHIVED", "CLOSED") else 0})
    elif dataset == "moves":
        for r in d.rentals():
            base = {"facility": short[r["fid"]], "unit_type": r["type"], "rent": r["rent"], "area": r["area"]}
            if r["moveIn"] and a <= r["moveIn"] <= b:
                out.append({**base, "date": r["moveIn"], "month": r["moveIn"][:7], "kind": "Move-In", "net": 1, "move_in": 1, "move_out": 0})
            if r["moveOut"] and a <= r["moveOut"] <= b:
                out.append({**base, "date": r["moveOut"], "month": r["moveOut"][:7], "kind": "Move-Out", "net": -1, "move_in": 0, "move_out": 1})
    return out


def aggregate(spec: dict, rows: list[dict]) -> dict:
    """Group, measure, compute formulas. Pure - the tests feed it rows."""
    ds = DATASETS[spec["dataset"]]
    for f in spec["filters"]:
        allowed = set(f["values"])
        rows = [r for r in rows if str(r.get(f["dimension"], "")) in allowed]
    dims = spec["dimensions"]
    groups: dict = defaultdict(list)
    for r in rows:
        groups[tuple(str(r.get(k, "")) for k in dims)].append(r)
    if len(groups) > MAX_GROUPS:
        raise SpecError(f"That makes {len(groups):,} lines; pick fewer or broader dimensions (at most {MAX_GROUPS:,})")
    trees = []
    known = {m["id"] for m in spec["measures"]}
    for f in spec["formulas"]:
        trees.append((f, parse_formula(f["expr"], known)))
        known.add(f["id"])

    def measure(m, items):
        if m["agg"] == "count":
            return len(items) if not m["field"] else sum(1 for r in items if r.get(m["field"]) is not None)
        vals = [r[m["field"]] for r in items if r.get(m["field"]) is not None]
        if m["agg"] == "sum":
            return sum(vals)
        if not vals:
            return None
        if m["agg"] == "avg":
            return sum(vals) / len(vals)
        return min(vals) if m["agg"] == "min" else max(vals)

    def line(items):
        vals = {m["id"]: measure(m, items) for m in spec["measures"]}
        for f, tree in trees:
            v = evaluate(tree, vals)
            vals[f["id"]] = v * 100 if (v is not None and f["format"] == "pct") else v
        return vals
    # A pct formula is stored as a percent (ratio x 100); later formulas see that value.
    out_rows = [{**{k: key[i] for i, k in enumerate(dims)}, **line(items)} for key, items in groups.items()]
    sort = spec.get("sort")
    if sort:
        by = sort["by"]
        present = sorted((r for r in out_rows if r.get(by) is not None), key=lambda r: r[by], reverse=sort["desc"])
        out_rows = present + [r for r in out_rows if r.get(by) is None]     # blanks last either way
    else:
        out_rows.sort(key=lambda r: tuple(r.get(k, "") for k in dims))

    def fmt_of(m):
        if m["agg"] == "count":
            return "int"
        f = ds["fields"][m["field"]][1]
        return "num" if f == "number" else f
    cols = [{"key": k, "label": ds["dims"][k], "type": "text"} for k in dims]
    cols += [{"key": m["id"], "label": m["label"], "type": fmt_of(m)} for m in spec["measures"]]
    cols += [{"key": f["id"], "label": f["label"], "type": "num" if f["format"] == "number" else f["format"]} for f in spec["formulas"]]
    return {"columns": cols, "rows": out_rows, "totals": line(rows), "count": len(rows)}


def run(spec: dict) -> dict:
    """Validate and run a spec against the synced Cubby rows. Blocking."""
    from database import SessionLocal
    spec = validate(spec)
    db = SessionLocal()
    try:
        try:
            d = ops_reports.Data(db, spec["facilities"] or None)
        except ops_reports.ReportError as e:
            raise SpecError(e.message) from e
        a, b = period_range(spec, d.today)
        rows = _rows(spec["dataset"], d, a, b)
    finally:
        db.close()
    out = aggregate(spec, rows)
    ds = DATASETS[spec["dataset"]]
    return {**out, "spec": spec, "dataset": ds["label"],
            "period": {"from": a, "to": b, "label": PERIODS[spec["period"]]} if ds["date"] else None,
            "facility": ", ".join(f["short"] for f in d.facs) if spec["facilities"] else "All Facilities",
            "asOf": d.today.isoformat()}


# ── Rendering (email + CSV) ───────────────────────────────────────────────────

def us_date(iso: str) -> str:
    return f"{iso[5:7]}/{iso[8:10]}/{iso[:4]}" if len(iso or "") >= 10 else ""


def _cell(v, t: str) -> str:
    if v is None or v == "":
        return ""
    if t == "money":
        return f"${v / 100:,.2f}"
    if t == "pct":
        return f"{v:.1f}%"
    if t in ("int", "area"):
        return f"{round(v):,}"
    if t == "num":
        return f"{v:,.2f}" if isinstance(v, float) and not float(v).is_integer() else f"{v:,.0f}"
    s = str(v)
    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        return us_date(s)
    if re.match(r"^\d{4}-\d{2}$", s):
        return f"{s[5:7]}/{s[:4]}"
    return s


def to_csv(result: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = result["columns"]
    w.writerow([c["label"] for c in cols])
    for r in result["rows"]:
        row = []
        for c in cols:
            v, t = r.get(c["key"]), c["type"]
            if v is None or v == "":
                s = ""
            elif t == "money":
                s = f"{v / 100:.2f}"
            elif t in ("int", "area"):
                s = str(round(v))
            elif t == "pct":
                s = f"{v:.1f}"
            elif t == "num":
                s = f"{round(v, 4):g}"
            else:
                s = _cell(v, "text")
            if s and s[0] in "=+-@" and not re.match(r"^-?\d", s):
                s = "'" + s    # a name a spreadsheet would run as a formula
            row.append(s)
        w.writerow(row)
    return buf.getvalue()


def render_email(name: str, result: dict, owner: str) -> tuple[str, str]:
    period = result.get("period")
    when = f"{us_date(period['from'])} - {us_date(period['to'])}" if period else f"as of {us_date(result['asOf'])}"
    subject = f"Ops Report: {name} ({when})"
    cols = result["columns"]
    th = "".join(f"<th style=\"text-align:{'left' if c['type'] == 'text' else 'right'};padding:6px 10px;border-bottom:2px solid #e5e7eb;"
                 f"font-size:12px;color:#374151\">{_html.escape(c['label'])}</th>" for c in cols)
    body_rows = []
    for r in result["rows"][:200]:
        tds = "".join(f"<td style=\"text-align:{'left' if c['type'] == 'text' else 'right'};padding:5px 10px;border-bottom:1px solid #f1f5f9;"
                      f"font-size:13px\">{_html.escape(_cell(r.get(c['key']), c['type']))}</td>" for c in cols)
        body_rows.append(f"<tr>{tds}</tr>")
    tot = "".join(f"<td style=\"text-align:{'left' if c['type'] == 'text' else 'right'};padding:6px 10px;font-weight:600;font-size:13px\">"
                  f"{'Total' if i == 0 and c['type'] == 'text' else _html.escape(_cell(result['totals'].get(c['key']), c['type'])) if c['type'] != 'text' else ''}</td>"
                  for i, c in enumerate(cols))
    more = (f"<p style=\"font-size:12px;color:#6b7280\">Showing 200 of {len(result['rows']):,} lines; the attached spreadsheet has them all.</p>"
            if len(result["rows"]) > 200 else "")
    html = (f"<div style=\"font-family:Inter,Segoe UI,Arial,sans-serif;color:#111827\">"
            f"<h2 style=\"font-size:18px;margin:0 0 4px\">{_html.escape(name)}</h2>"
            f"<p style=\"margin:0 0 14px;font-size:13px;color:#6b7280\">{_html.escape(result['dataset'])} - "
            f"{_html.escape(result['facility'])} - {_html.escape(when)}</p>"
            f"<table style=\"border-collapse:collapse\"><thead><tr>{th}</tr></thead><tbody>{''.join(body_rows)}"
            f"<tr>{tot}</tr></tbody></table>{more}"
            f"<p style=\"margin-top:16px;font-size:12px;color:#6b7280\">Scheduled in Nexus Operations > Reports > Report Builder by "
            f"{_html.escape(owner)}. Figures from Cubby, synced every 15 minutes.</p></div>")
    return subject, html


# ── Schedules ("autopilot") ───────────────────────────────────────────────────

def _local_now() -> datetime:
    return datetime.now(ZoneInfo(TZ))


def due_period(schedule: str, day: int, now: datetime) -> str:
    """The period key this schedule owes a send for at `now`, or '' when it
    is not time yet. weekly: the date of this week's send day; monthly: YYYY-MM."""
    if schedule == "weekly":
        target = (now.date() - timedelta(days=now.weekday())) + timedelta(days=max(0, min(6, day)))
        if now.date() > target or (now.date() == target and now.hour >= SEND_HOUR):
            return target.isoformat()
        return ""
    if schedule == "monthly":
        target = now.date().replace(day=max(1, min(28, day)))
        if now.date() > target or (now.date() == target and now.hour >= SEND_HOUR):
            return now.strftime("%Y-%m")
    return ""


def _claim(db, report_id: str, period: str, previous: str) -> bool:
    import models
    from sqlalchemy import or_
    R = models.OpsSavedReport
    n = (db.query(R).filter(R.id == report_id, or_(R.last_sent_period.is_(None), R.last_sent_period != period))
         .update({R.last_sent_period: period, R.last_attempt_at: datetime.now(timezone.utc).isoformat()},
                 synchronize_session=False))
    db.commit()
    return n == 1


def send_report(db, row, period: str = "", to: list[str] | None = None) -> dict:
    """Run a saved report and email it (one email to every recipient). Raises
    graph_mail.GraphMailError when the mail does not go."""
    import graph_mail
    result = run(row.spec or {})
    subject, html = render_email(row.name, result, row.owner_email)
    recipients = to if to is not None else list(row.recipients or [])
    if not recipients:
        raise graph_mail.GraphMailError("No recipient")
    stamp = (result.get("period") or {}).get("to") or result["asOf"]
    fname = f"{re.sub(r'[^A-Za-z0-9 _-]', '', row.name)[:60] or 'Ops Report'} - {us_date(stamp).replace('/', '-')}.csv"
    graph_mail.send_mail(from_email=graph_mail.DEFAULT_FROM_EMAIL, to=recipients, cc=None, subject=subject, html=html,
                         attachments=[(fname, "text/csv", ("﻿" + to_csv(result)).encode("utf-8"))])
    return {"sent": True, "to": recipients, "lines": len(result["rows"])}


def scan_once(now: datetime | None = None) -> int:
    """Send every saved report whose schedule is due. Blocking. Returns sends."""
    import graph_mail
    import models
    from database import SessionLocal
    if not graph_mail.graph_configured() or not graph_mail.DEFAULT_FROM_EMAIL:
        return 0
    now = now or _local_now()
    sent = 0
    db = SessionLocal()
    try:
        R = models.OpsSavedReport
        rows = db.query(R).filter(R.schedule.in_(("weekly", "monthly"))).all()
        for row in rows:
            period = due_period(row.schedule, row.schedule_day or 0, now)
            if not period or period == (row.last_sent_period or ""):
                continue
            if row.last_attempt_at and ops_reports._age(row.last_attempt_at) < RETRY_AFTER_SEC and row.last_error:
                continue
            previous = row.last_sent_period or ""
            if not _claim(db, row.id, period, previous):
                continue
            db.refresh(row)
            try:
                send_report(db, row, period)
                row.last_sent_at, row.last_error = datetime.now(timezone.utc).isoformat(), ""
                db.commit()
                sent += 1
            except Exception as e:  # noqa: BLE001 - give the claim back; retried after RETRY_AFTER_SEC
                db.rollback()
                db.refresh(row)
                row.last_sent_period, row.last_error = previous, f"{type(e).__name__}: {str(e)[:200]}"
                db.commit()
                print(f"[ops-reports] scheduled send failed for {row.id}: {type(e).__name__}")
        return sent
    finally:
        db.close()


WARM_KINDS = ("general-ledger-cash", "merchant-disbursements")


def warm() -> int:
    """Snapshot style, like cubby_snapshot_loop: keep this month's ledger and
    disbursements per facility fresh in ops_report_cache, so the first person
    to open them does not wait on Cubby. cached() only calls Cubby when a copy
    is older than its TTL. Blocking. Returns the reports read."""
    import cubby
    if not cubby.configured():
        return 0
    n = 0
    for kind in WARM_KINDS:
        try:
            ops_reports.run(kind)
            n += 1
        except Exception as e:  # noqa: BLE001 - a warm-up is a bonus
            print(f"[ops-reports] warm {kind} skipped: {type(e).__name__}")
    return n


async def ops_report_schedule_loop():
    """Started from main.py on the deployed worker. Sends due saved reports
    and keeps the current month's Cubby reports cached. Both run in a thread
    (CLAUDE.md: never block the event loop)."""
    await asyncio.sleep(240)
    while True:
        try:
            n = await asyncio.to_thread(scan_once)
            if n:
                print(f"[ops-reports] sent {n} scheduled report(s)")
        except Exception as e:  # noqa: BLE001
            print(f"[ops-reports] schedule loop error: {type(e).__name__}")
        try:    # scheduled catalog reports (Operations > Reports > Scheduled) ride the same loop
            import ops_report_schedules
            n = await asyncio.to_thread(ops_report_schedules.scan_once)
            if n:
                print(f"[ops-reports] sent {n} scheduled report file(s)")
        except Exception as e:  # noqa: BLE001
            print(f"[ops-reports] scheduled export loop error: {type(e).__name__}")
        try:
            await asyncio.to_thread(warm)
        except Exception as e:  # noqa: BLE001
            print(f"[ops-reports] warm-up error: {type(e).__name__}")
        await asyncio.sleep(SCAN_EVERY_SEC)


def new_id() -> str:
    return str(uuid.uuid4())
