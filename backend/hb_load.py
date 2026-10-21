"""Hummingbird export -> the hb_* tables (Oct 21 2026).

    python -m hb_load "E:\\HB DATA"                 # load, then rebuild the history
    python -m hb_load "E:\\HB DATA" --by you@greensglobal.com
    python -m hb_load --rebuild-only                # recompute from the hb_* tables

It writes to whatever DATABASE_URL points at (no DATABASE_URL = the local
greens_nexus.db). A Postgres target also needs --yes, so a stray shell
variable cannot load a shared database by accident.

The folder holds the four JSON files pulled from HB's API on Sep 12 2026:
  *nectar*export*.json         properties (summary, units, space groups, space
                               mix, rate management), active leases, leads, promotions
  *historical_leases*.json     every lease ever (all_leases) + invoices / ledger
                               / metrics of the closed ones
  *lease_details*.json         invoices / ledger / metrics of the active leases
  *reports_export*.json        HB's reports per property (management summary,
                               occupancy statistics, rental / space activity,
                               transfers, insurance coverage, ...)

Re-running is safe: every row is keyed by HB's own id and replaced. Each run
writes an hb_loads row (files, their generated_at and sha256, row counts).

PRIVACY. The export carries tenant names, contacts and ledgers. `clean`
removes contact and identity fields at any depth (cubby_sync.strip_pii's key
list plus HB's own name / note keys) and every report row is copied from a
whitelist of fields, so no tenant name, email, phone, address or free text
reaches the database. Invoice and ledger lines are summarized per lease and
month. Nothing here prints a row.
"""
from __future__ import annotations

import argparse
import gc
import glob
import hashlib
import json
import os
import sys
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import delete, insert

from cubby_sync import _PII as _CONTACT_KEYS

APP_KEYS = ("applicationData",)
CHUNK = 1000

# Exact keys (lowercased, underscores removed) that hold a person's name, a
# free-text note or an access code - on top of cubby_sync._PII's substrings.
_HB_DROP = {"first", "middle", "last", "salutation", "suffix", "firstname", "lastname", "middlename", "fullname",
            "companyname", "username", "notes", "note",
            "content", "msg", "message", "tenants", "createdby", "modifiedby", "voidedbycontactid", "code",
            "accountnumber", "bsbnumber", "accountname", "zip", "city", "extras", "reason", "lease"}


def clean(value):
    """A copy without contact / identity / free-text fields, at any depth.
    Any key starting with "tenant" goes too (tenant_name, tenant_first_name,
    tenant_city ...)."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            n = str(k).lower().replace("_", "")
            if n in _HB_DROP or n.startswith("tenant") or any(p in n for p in _CONTACT_KEYS):
                continue
            out[k] = clean(v)
        return out
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def payload(x):
    """HB answers come wrapped two ways: {status, data} or
    {status, body: {applicationData: {<app>: [{data}]}}}. The `data`, or None."""
    if not isinstance(x, dict):
        return None
    if isinstance(x.get("data"), (dict, list)):
        return x["data"]
    body = x.get("body") if isinstance(x.get("body"), dict) else x.get("json")
    if isinstance(body, dict):
        for apps in (body.get("applicationData") or {}).values():
            if isinstance(apps, list) and apps and isinstance(apps[0], dict):
                return apps[0].get("data")
    return None


def _day(v) -> str:
    return str(v or "")[:10]


def _num(v):
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _g(v) -> str:
    n = _num(v)
    return "" if n is None else f"{n:g}"


def short_name(name: str) -> str:
    """" Greens Storage, Temecula" -> "Temecula"."""
    n = (name or "").strip()
    return n.split(",")[-1].strip() if "," in n else n.replace("Greens Storage", "").strip()


def unit_type_name(width, length, category: str) -> str:
    """Cubby's pricing group name for an HB space: "10' x 10' Storage - Interior, Lower"."""
    return f"{_g(width) or '0'}' x {_g(length) or '0'}' {(category or '').strip()}".strip()


def _rid(kind: str, row: dict) -> str:
    return kind + ":" + hashlib.sha1(json.dumps(row, sort_keys=True, default=str).encode()).hexdigest()[:24]


def _pick(row: dict, keys) -> dict:
    return {k: row.get(k) for k in keys if k in row}


# ── Reports file ──────────────────────────────────────────────────────────────

MOVE_IN_KEYS = ("property_id", "unit_id", "lease_id", "unit_number", "unit_type", "unit_size", "category_name",
                "unit_area", "move_in_date", "rent", "insurance_premium", "promotion_amount", "promotion_names",
                "space_rate", "variance", "days_vacant")
MOVE_OUT_KEYS = ("property_id", "unit_id", "lease_id", "unit_number", "unit_type", "unit_size", "category_name",
                 "unit_area", "move_out_date", "days_in_space", "rent", "insurance_premium", "space_rate",
                 "variance", "auction")
SPACE_ACTIVITY_KEYS = ("property_id", "lease_id", "transfer_id", "activity_date", "activity", "space_number",
                       "move_in_date", "move_out_date", "space_price", "tenant_rent", "promotion_names",
                       "discount_names", "last_rent_change", "days_rented")
TRANSFER_KEYS = ("property_id", "transfer_date", "out_unit_id", "out_unit_number", "out_unit_size",
                 "out_unit_category", "out_lease_id", "out_lease_start_date", "out_rent", "in_unit_id",
                 "in_unit_number", "in_unit_size", "in_unit_category", "in_lease_id", "in_rent", "out_total_days")
COVERAGE_KEYS = ("property_id", "space_id", "lease_id", "invoice_id", "insurance_start_date", "insurance_end_date",
                 "invoice_period_start", "invoice_period_end", "insurance_name", "insurance_coverage",
                 "insurance_premium", "insurance_paid_amount", "insurance_overall_amount",
                 "insurance_credited_amount", "insurance_refunded_amount", "is_new_coverage",
                 "is_cancelled_coverage", "is_paid", "move_in_date", "transaction_date")


def _report_row(kind, raw, keys, day_key, lease_key="lease_id", unit_key="unit_id"):
    row = clean(_pick(raw, keys))
    # tenant_rent is the RENT a tenant paid, not a person - put it back after clean().
    if "tenant_rent" in keys and "tenant_rent" in raw:
        row["tenant_rent"] = raw.get("tenant_rent")
    return {"id": _rid(kind, row), "kind": kind, "property_id": str(raw.get("property_id") or ""),
            "day": _day(raw.get(day_key)), "lease_id": str(raw.get(lease_key) or ""),
            "unit_id": str(raw.get(unit_key) or ""), "data": row}


def rows_from_reports(doc: dict) -> dict:
    """{"report_rows", "reports", "premiums" {invoice id: insurance premium}, "as_of"}."""
    as_of = _day((doc.get("meta") or {}).get("today") or (doc.get("meta") or {}).get("generated_at"))
    report_rows, reports, premiums = [], [], defaultdict(float)
    for key, value in (doc.get("reports") or {}).items():
        kind, _, rest = key.partition(":")
        data = payload(value)
        if data is None:
            continue
        rep = data.get("report") if isinstance(data, dict) and "report" in data else data
        if kind == "rental-activity" and isinstance(rep, dict):
            for r in rep.get("rentalActivityMoveIn") or []:
                report_rows.append(_report_row("move_in", r, MOVE_IN_KEYS, "move_in_date"))
            for r in rep.get("rentalActivityMoveOut") or []:
                report_rows.append(_report_row("move_out", r, MOVE_OUT_KEYS, "move_out_date"))
        elif kind == "space-activity" and isinstance(rep, list):
            for r in rep:
                report_rows.append(_report_row("space_activity", r, SPACE_ACTIVITY_KEYS, "activity_date", unit_key="-"))
        elif kind == "transfer" and isinstance(rep, list):
            for r in rep:
                report_rows.append(_report_row("transfer", r, TRANSFER_KEYS, "transfer_date", "in_lease_id", "in_unit_id"))
        elif kind == "coverage-details" and isinstance(rep, list):
            for r in rep:
                if r.get("invoice_id"):
                    premiums[str(r["invoice_id"])] += _num(r.get("insurance_premium")) or 0
                report_rows.append(_report_row("coverage", r, COVERAGE_KEYS, "invoice_period_start", unit_key="space_id"))
        else:
            prop = rest.split(":")[0] if rest not in ("all", "company") else ""
            reports.append({"id": key, "kind": kind, "property_id": prop, "as_of": as_of, "data": clean(data)})
    # A row can be listed twice (same lease, same day): one copy each.
    uniq = {r["id"]: r for r in report_rows}
    return {"report_rows": list(uniq.values()), "reports": reports, "premiums": dict(premiums), "as_of": as_of,
            "properties": [{"id": p.get("id"), "name": p.get("name")} for p in doc.get("properties") or []]}


# ── Nectar export (properties, units, active leases, leads) ───────────────────

LEASE_DATA_DROP = ("Tenants", "CreatedBy", "OpenInvoices", "notes", "terms", "code")


def lease_row(le: dict, *, detail_metrics: dict | None = None) -> dict:
    unit = le.get("Unit") or {}
    metrics = detail_metrics or le.get("Metrics") or {}
    end = _day(le.get("end_date") or le.get("moved_out"))
    autopay = metrics.get("has_autopay")
    return {
        "id": str(le["id"]), "property_id": str(unit.get("property_id") or le.get("property_id") or ""),
        "unit_id": str(le.get("unit_id") or unit.get("id") or ""), "status": int(le.get("status") or 0),
        "standing": str((le.get("Standing") or {}).get("name") or ""), "start_date": _day(le.get("start_date")),
        "end_date": end, "rent": _num(le.get("rent")), "move_in_rent": _num(le.get("move_in_rent")),
        "is_transferred": int(le.get("is_transferred") or 0),
        "has_autopay": None if autopay is None else int(bool(autopay)),
        "decline_insurance": None if le.get("decline_insurance") is None else int(le.get("decline_insurance") or 0),
        "total_rent_raises": le.get("total_rent_raises"), "last_rent_raise": _day(le.get("last_rent_raise")),
        "auction_status": str(le.get("auction_status") or ""),
        "data": clean({k: v for k, v in le.items() if k not in LEASE_DATA_DROP}),
    }


def rows_from_nectar(doc: dict) -> dict:
    meta = doc.get("meta") or {}
    exported = str(meta.get("generated_at") or "")
    props, units, reports = [], [], []
    for p in doc.get("properties") or []:
        s = p.get("summary") or {}
        pid = str(s.get("id") or "")
        if not pid:
            continue
        props.append({"id": pid, "name": (s.get("name") or "").strip(), "short_name": short_name(s.get("name")),
                      "number": str(s.get("number") or ""), "unit_count": int(s.get("unit_count") or 0),
                      "exported_at": exported, "data": clean(s)})
        for u in p.get("units") or []:
            cat = ((u.get("Category") or {}).get("name") or "").strip()
            # A space's description is free text staff typed - it can name a tenant
            # ("held for ..."), so it is not kept.
            data = clean({k: v for k, v in u.items() if k not in ("Lease", "Address", "Images", "Floorplan", "description")})
            data["leaseId"] = str((u.get("Lease") or {}).get("id") or "")
            units.append({"id": str(u["id"]), "property_id": pid, "number": str(u.get("number") or ""),
                          "space_type": str(u.get("type") or ""), "category": cat,
                          "width": _num(u.get("width")), "length": _num(u.get("length")),
                          "unit_type": unit_type_name(u.get("width"), u.get("length"), cat),
                          "state": str(u.get("state") or ""), "price": _num(u.get("price")),
                          "set_rate": _num(u.get("set_rate")), "data": data})
        for k in ("space_groups", "space_mix", "rate_management", "tax_rates", "reservation_settings",
                  "report_management_summary"):
            if k in p:
                kind = k.replace("_", "-")
                reports.append({"id": f"{kind}:{pid}", "kind": kind, "property_id": pid, "as_of": _day(exported),
                                "data": clean(payload(p[k]) if payload(p[k]) is not None else p[k])})
    for k in ("promotions", "rate_changes"):
        if k in doc:
            v = doc[k]
            reports.append({"id": f"{k.replace('_', '-')}:company", "kind": k.replace("_", "-"), "property_id": "",
                            "as_of": _day(exported), "data": clean(payload(v) if isinstance(v, dict) and payload(v) is not None else {"rows": v})})
    leases = {str(le["id"]): lease_row(le) for le in doc.get("leases") or [] if le.get("id")}
    leads = []
    for ld in doc.get("leads") or []:
        if not ld.get("id"):
            continue
        leads.append({"id": str(ld["id"]), "property_id": str(ld.get("property_id") or ""),
                      "created": str(ld.get("created") or ""), "status": str(ld.get("status") or ""),
                      "source": str(ld.get("source") or ""), "lease_id": str(ld.get("lease_id") or ""),
                      "unit_id": str(ld.get("unit_id") or ""), "category_id": str(ld.get("category_id") or ""),
                      "data": {"moveInDate": _day(ld.get("move_in_date")), "modified": str(ld.get("modified") or "")}})
    return {"properties": props, "units": units, "leases": leases, "leads": leads, "reports": reports,
            "exported_at": exported}


# ── Lease money (invoices + ledger -> one row per lease and month) ────────────

def lease_months(lease_id: str, property_id: str, detail: dict, premiums: dict) -> list[dict]:
    inv = payload(detail.get("invoices")) or {}
    led = payload(detail.get("ledger")) or {}
    rows: dict[str, dict] = {}

    def row(month):
        return rows.setdefault(month, {"id": f"{lease_id}:{month}", "lease_id": lease_id, "property_id": property_id,
                                       "month": month, "rent": None, "invoiced": 0.0, "discounts": 0.0,
                                       "insurance": 0.0, "charged": 0.0, "paid": 0.0, "data": {"inv": [], "pay": []}})
    rent_first: dict[str, str] = {}
    for i in (inv.get("invoices") if isinstance(inv, dict) else None) or []:
        if int(i.get("status") or 0) == -1 or i.get("void_date") or i.get("voided_at"):
            continue
        due = _day(i.get("due") or i.get("date"))
        start = _day(i.get("period_start")) or due
        if not due:
            continue
        amount = _num(i.get("amount")) or 0
        sub = _num(i.get("subtotal")) or 0
        prem = premiums.get(str(i.get("id")), 0)
        r = row(due[:7])
        r["charged"] += amount
        # b = what was still open on this invoice at export: an invoice open
        # then was open at every month-end since it fell due.
        r["data"]["inv"].append({"d": due, "a": round(amount, 2), "b": round(_num(i.get("balance")) or 0, 2)})
        r2 = row(start[:7])
        r2["invoiced"] += sub
        r2["discounts"] += _num(i.get("total_discounts")) or 0
        r2["insurance"] += prem
        if (i.get("type") or "") == "auto" and (start[:7] not in rent_first or start < rent_first[start[:7]]):
            rent_first[start[:7]] = start
            r2["rent"] = round(sub - prem, 2)
    for e in (led.get("ledger") if isinstance(led, dict) else None) or []:
        amt = _num(e.get("payments"))
        if not amt or str(e.get("status") or "").lower() == "void":
            continue
        d = _day(e.get("date"))
        if not d:
            continue
        r = row(d[:7])
        r["paid"] += amt
        r["data"]["pay"].append({"d": d, "a": round(amt, 2)})
    for r in rows.values():
        for k in ("invoiced", "discounts", "insurance", "charged", "paid"):
            r[k] = round(r[k], 2)
    return list(rows.values())


def metrics_of(detail: dict) -> dict:
    m = payload(detail.get("metrics")) or {}
    return m.get("metrics") if isinstance(m, dict) and isinstance(m.get("metrics"), dict) else {}


# ── Writing ───────────────────────────────────────────────────────────────────

def write(db, model, rows: list[dict], load_id: str) -> int:
    """Replace rows by id: delete the ids, insert the new rows, in chunks."""
    if not rows:
        return 0
    seen = {}
    for r in rows:
        seen[r["id"]] = {**r, "load_id": load_id}
    # Every row carries the same keys (a missing one is NULL). SQLAlchemy batches
    # an executemany into multi-row INSERTs only when the rows share one key set;
    # mixed rows (some with `rent`, some without) fell back to one INSERT per
    # row - 63k round trips to Supabase, hours instead of seconds (Oct 21 2026).
    # A key a row lacks takes the column's own default (what the INSERT stored
    # before), never NULL - '' means "still in" for end_date, for one.
    keys = set().union(*(r.keys() for r in seen.values()))
    cols = model.__table__.c

    def _default(k):
        d = cols[k].default if k in cols else None
        if d is None:
            return None
        if d.is_scalar:
            return d.arg
        if d.is_callable:          # SQLAlchemy wraps default=list / dict to take a context
            return d.arg(None)
        return None

    defaults = {k: _default(k) for k in keys}
    rows = [{k: (r[k] if k in r else defaults[k]) for k in keys} for r in seen.values()]
    ids = [r["id"] for r in rows]
    for i in range(0, len(ids), CHUNK):
        db.execute(delete(model).where(model.id.in_(ids[i:i + CHUNK])))
    # One multi-row INSERT per chunk (insert().values(list)): a plain
    # executemany still went out in 1-3 row statements through the Supabase
    # pooler, about a second each from here.
    for i in range(0, len(rows), CHUNK):
        db.execute(insert(model).values(rows[i:i + CHUNK]))
    db.commit()
    return len(rows)


def _file_meta(path: str, generated: str) -> dict:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return {"name": os.path.basename(path), "size": os.path.getsize(path), "sha256": h.hexdigest(),
            "generatedAt": generated}


def find_files(folder: str) -> dict:
    def one(pattern):
        hits = sorted(glob.glob(os.path.join(folder, pattern)))
        return hits[0] if hits else ""
    return {"nectar": one("*nectar*export*.json"), "historical": one("*historical_leases*.json"),
            "details": one("*lease_details*.json"), "reports": one("*reports_export*.json")}


def _read(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load(db, files: dict, by: str = "hb-load", rebuild: bool = True, log=print) -> dict:
    """Load the export into the hb_* tables. `files` = find_files()'s shape;
    a missing file is skipped with a warning. Returns the hb_loads row as a dict."""
    import hb_models as hm
    run = hm.HbLoad(id=str(uuid.uuid4()), started_at=now_iso(), loaded_by=by, status="running",
                    files=[], counts={}, sites=[], warnings=[])
    db.add(run)
    db.commit()
    counts: dict[str, int] = defaultdict(int)
    warnings: list[str] = []
    metas: list[dict] = []
    try:
        premiums: dict = {}
        as_of = ""
        if files.get("reports"):
            doc = _read(files["reports"])
            metas.append(_file_meta(files["reports"], str((doc.get("meta") or {}).get("generated_at") or "")))
            got = rows_from_reports(doc)
            del doc
            premiums, as_of = got["premiums"], got["as_of"]
            counts["hb_report_rows"] += write(db, hm.HbReportRow, got["report_rows"], run.id)
            counts["hb_reports"] += write(db, hm.HbReport, got["reports"], run.id)
            log(f"reports: {len(got['report_rows'])} report rows, {len(got['reports'])} reports")
            del got
            gc.collect()
        else:
            warnings.append("No reports export file - rental activity and coverage were not loaded.")

        leases: dict[str, dict] = {}
        if files.get("nectar"):
            doc = _read(files["nectar"])
            got = rows_from_nectar(doc)
            metas.append(_file_meta(files["nectar"], got["exported_at"]))
            del doc
            import ops_budget as ob
            fac_by_short = {f["shortName"].lower(): f["id"] for f in ob.facilities(db)}
            for p in got["properties"]:
                p["ops_facility_id"] = fac_by_short.get(p["short_name"].lower(), "")
                if not p["ops_facility_id"]:
                    warnings.append(f"{p['name']}: no Ops Budget facility named {p['short_name']} - its history is not shown there.")
            counts["hb_properties"] += write(db, hm.HbProperty, got["properties"], run.id)
            counts["hb_units"] += write(db, hm.HbUnit, got["units"], run.id)
            counts["hb_leads"] += write(db, hm.HbLead, got["leads"], run.id)
            counts["hb_reports"] += write(db, hm.HbReport, got["reports"], run.id)
            leases = got["leases"]
            log(f"nectar: {len(got['properties'])} properties, {len(got['units'])} units, {len(leases)} active leases, "
                f"{len(got['leads'])} leads")
            del got
            gc.collect()
        else:
            warnings.append("No nectar export file - properties and units were not loaded.")

        month_rows: list[dict] = []
        if files.get("historical"):
            doc = _read(files["historical"])
            metas.append(_file_meta(files["historical"], str((doc.get("meta") or {}).get("generated_at") or "")))
            details = doc.get("new_historical_lease_details") or {}
            for le in doc.get("all_leases") or []:
                if not le.get("id"):
                    continue
                lid = str(le["id"])
                d = details.get(lid) or {}
                row = lease_row(le, detail_metrics=metrics_of(d) or None)
                if lid in leases:          # the active lease's own record is richer; keep its fields
                    row = {**row, **{k: v for k, v in leases[lid].items() if v not in (None, "")}}
                leases[lid] = row
                if d:
                    month_rows += lease_months(lid, row["property_id"], d, premiums)
            del doc, details
            gc.collect()
        else:
            warnings.append("No historical leases file - closed leases were not loaded.")

        if files.get("details"):
            doc = _read(files["details"])
            metas.append(_file_meta(files["details"], str((doc.get("meta") or {}).get("generated_at") or "")))
            for lid, d in (doc.get("lease_details") or {}).items():
                lid = str(lid)
                le = leases.get(lid)
                if le is None:
                    continue
                m = metrics_of(d)
                if m.get("has_autopay") is not None:
                    le["has_autopay"] = int(bool(m["has_autopay"]))
                month_rows += lease_months(lid, le["property_id"], d, premiums)
            del doc
            gc.collect()
        else:
            warnings.append("No lease details file - active leases' invoices and payments were not loaded.")

        counts["hb_leases"] += write(db, hm.HbLease, list(leases.values()), run.id)
        counts["hb_lease_months"] += write(db, hm.HbLeaseMonth, month_rows, run.id)
        log(f"leases: {len(leases)}, lease-months: {len(month_rows)}")
        del month_rows, leases
        gc.collect()

        run.files, run.counts, run.warnings = metas, dict(counts), warnings
        db.commit()
        if rebuild:
            import hb_history
            sites = hb_history.rebuild(db, by=by, as_of=as_of)
            run.sites = sites
            counts["ops_metric_month"] = sum(s.get("metricRows", 0) for s in sites)
            counts["hb_rate_months"] = sum(s.get("rateRows", 0) for s in sites)
            run.counts = dict(counts)
            for s in sites:
                warnings += [f"{s['name']}: {w}" for w in s.get("warnings", [])]
            run.warnings = warnings
        run.status, run.finished_at = "ok", now_iso()
        db.commit()
    except Exception as e:  # noqa: BLE001 - recorded, then re-raised
        db.rollback()
        run = db.get(hm.HbLoad, run.id)
        run.status, run.finished_at = "failed", now_iso()
        run.files, run.counts, run.warnings = metas, dict(counts), warnings
        run.error = type(e).__name__   # never the message: a DB error can quote row values
        db.commit()
        raise
    return load_json(run)


def load_json(r) -> dict:
    return {"id": r.id, "startedAt": r.started_at or "", "finishedAt": r.finished_at or "", "by": r.loaded_by or "",
            "status": r.status, "files": r.files or [], "counts": r.counts or {}, "sites": r.sites or [],
            "warnings": (r.warnings or [])[:50], "error": r.error or ""}


def _target(url: str) -> str:
    if not url or url.startswith("sqlite"):
        return url or "sqlite:///./greens_nexus.db"
    from sqlalchemy.engine import make_url
    u = make_url(url)
    return f"{u.drivername}://{u.host}:{u.port or ''}/{u.database}"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m hb_load", description="Load the Hummingbird export into the hb_* tables.")
    ap.add_argument("folder", nargs="?", default="", help="folder holding the four HB JSON files")
    ap.add_argument("--by", default="hb-load", help="who is loading (recorded on the load log)")
    ap.add_argument("--no-rebuild", action="store_true", help="load only; do not recompute the history")
    ap.add_argument("--rebuild-only", action="store_true", help="recompute the history from the hb_* tables")
    ap.add_argument("--yes", action="store_true", help="required when DATABASE_URL is not SQLite")
    a = ap.parse_args(argv)
    url = os.environ.get("DATABASE_URL", "")
    print(f"Target database: {_target(url)}")
    if url and not url.startswith("sqlite") and not a.yes:
        print("This is not a local SQLite database. Re-run with --yes to load it.")
        return 2
    import database
    import hb_models  # noqa: F401 - registers the tables
    import models
    import ops_budget_models  # noqa: F401
    models.Base.metadata.create_all(bind=database.engine)
    db = database.SessionLocal()
    t0 = time.time()
    try:
        if a.rebuild_only:
            import hb_history
            sites = hb_history.rebuild(db, by=a.by)
            for s in sites:
                print(f"{s['name']}: {s['first']} - {s['last']}, {s['metricRows']} metric rows, {s['rateRows']} rate rows")
        else:
            files = find_files(a.folder)
            missing = [k for k, v in files.items() if not v]
            if len(missing) == 4:
                print(f"No HB export files found in {a.folder!r}.")
                return 1
            out = load(db, files, by=a.by, rebuild=not a.no_rebuild)
            print(f"Load {out['status']}: " + ", ".join(f"{k} {v}" for k, v in sorted(out["counts"].items())))
            for s in out["sites"]:
                print(f"  {s['name']}: {s['first']} - {s['last']}, {s['metricRows']} metric rows, {s['rateRows']} rate rows")
            for w in out["warnings"]:
                print(f"  warning: {w}")
    finally:
        db.close()
    print(f"Done in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
