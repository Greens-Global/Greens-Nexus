"""Compare With QuickBooks - Leave Balances (11/20/2026).

Charmi, 11/20/2026: three people's leave balances were "not matching"
QuickBooks. Neil, same day: "Need a real solution not a bug fix manual."

QuickBooks still accrues its own vacation on every paycheck while Nexus keeps
the balance from finalized Time Sheets, so the two drift for reasons that are
rules, not data errors: QuickBooks' rate is typed per person and is not moved
on a work anniversary; QuickBooks accrues on every PAID hour while a policy
may count hours WORKED; a Time Sheet not finalized in Nexus is not in its
balance yet. Finding which one, by hand, per person, is what this replaces.

HR uploads QuickBooks' Time Off report (the Excel export, one block per
employee: Date, Chk Num, Period Start, Period End, Hours, Vac Accrued, Vac
Used, Vac Balance, Sick Accrued, Sick Used, Sick Balance). For every person
it lines the two up AS OF the report's last pay period and names each
difference with its cause and its hours, so the parts add up to the gap:

  opening      the imported opening balance is not what QuickBooks had then
  rate         QuickBooks earns N h a year, the policy M h (anniversary)
  hours        QuickBooks counted paid hours, Nexus worked hours (or back)
  used         a different number of leave hours taken in a period
  not_final    a period QuickBooks paid is not finalized in Nexus
  adjust       an HR adjustment in Nexus
  other        whatever is left - shown, never hidden

Pure read: nothing is written, nothing is sent to QuickBooks, the file is not
kept. Nexus never treats QuickBooks as right or wrong; it says why they differ
so HR fixes the side that is wrong (a rate in QuickBooks, a policy, a Time
Sheet to finalize).
"""
from __future__ import annotations

import io
import re
from datetime import date, datetime

from sqlalchemy.orm import Session

import leave_balances as lb
import models

MAX_BYTES = 3 * 1024 * 1024
TOL = 0.05                       # hours - QuickBooks rounds to the cent of an hour

_COLS = {
    "period start": "start", "period end": "end", "hours": "hours",
    "vac accrued": "vacAcc", "vac used": "vacUsed", "vac balance": "vacBal",
    "sick accrued": "sickAcc", "sick used": "sickUsed", "sick balance": "sickBal",
}
_CODE = re.compile(r"\(\s*([A-Za-z]{1,4}-?\d{1,6})\s*\)")
_HOURS_NOTE = re.compile(r"on ([0-9.]+) h (worked|paid)")


# ── Reading the report ──────────────────────────────────────────────────────

def _day(v) -> str:
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v or "").strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    return ""


def _num(v) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if x != x or abs(x) < 1e-5 else x


def split_name(raw: str) -> tuple[str, str]:
    """'Pat Q Example(E-0001)' -> ('Pat Q Example', 'E-0001');
    'Sam Sample ( (E-0002)' -> ('Sam Sample', 'E-0002')."""
    raw = str(raw or "").strip()
    m = _CODE.search(raw)
    code = m.group(1).upper() if m else ""
    name = _CODE.sub(" ", raw)
    name = re.sub(r"[()]", " ", name)
    return re.sub(r"\s+", " ", name).strip(), code


def parse_report(data: bytes) -> list[dict]:
    """[{name, code, rows: [{start, end, hours, vacAcc, ...}]}], rows oldest
    first. Reads the sheet whose header row names Period End and Vac Balance;
    a person is the one-cell row above their header. Raises ValueError with
    words HR can act on."""
    if not data:
        raise ValueError("Choose the QuickBooks Time Off report.")
    if len(data) > MAX_BYTES:
        raise ValueError("That file is larger than 3 MB - export the Time Off report only.")
    try:
        import openpyxl
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:  # noqa: BLE001 - any unreadable file gets the same answer
        raise ValueError("That is not an Excel file Nexus can read. Export the Time Off report from QuickBooks as Excel (.xlsx).")
    people: list[dict] = []
    for ws in wb.worksheets:
        cur, cols = None, None
        for row in ws.iter_rows(values_only=True):
            cells = list(row)
            vals = [c for c in cells if c is not None and str(c).strip() != ""]
            if not vals:
                continue
            heads = {str(c).strip().lower(): i for i, c in enumerate(cells) if isinstance(c, str)}
            if "period end" in heads and "vac balance" in heads:
                cols = {key: heads[h] for h, key in _COLS.items() if h in heads}
                continue
            if len(vals) == 1 and isinstance(vals[0], str):
                name, code = split_name(vals[0])
                if name:
                    cur = {"name": name, "code": code, "rows": []}
                    people.append(cur)
                cols = None
                continue
            if cur is None or not cols or "end" not in cols:
                continue
            end = _day(cells[cols["end"]]) if cols["end"] < len(cells) else ""
            if not end:
                continue                      # the person's total line
            r = {k: (_num(cells[i]) if i < len(cells) else 0.0) for k, i in cols.items() if k not in ("start", "end")}
            r["start"] = _day(cells[cols["start"]]) if "start" in cols and cols["start"] < len(cells) else ""
            r["end"] = end
            cur["rows"].append(r)
    wb.close()
    people = [p for p in people if p["rows"]]
    if not people:
        raise ValueError("No employees found. Use QuickBooks' Time Off report - one block per employee "
                         "with Period End, Vac Balance and Sick Balance columns.")
    for p in people:
        p["rows"] = _merge_checks(p["rows"])
    return people


def _merge_checks(rows: list) -> list:
    """One row per pay period: a second check for the same period (a void,
    a bonus check) adds its accrual and use; the balance is the later one."""
    out: dict = {}
    for r in rows:
        k = (r.get("start") or "", r["end"])
        if k not in out:
            out[k] = dict(r)
            continue
        m = out[k]
        for f in ("hours", "vacAcc", "vacUsed", "sickAcc", "sickUsed"):
            m[f] = m.get(f, 0.0) + r.get(f, 0.0)
        m["vacBal"], m["sickBal"] = r.get("vacBal", 0.0), r.get("sickBal", 0.0)
    return sorted(out.values(), key=lambda r: (r["end"], r.get("start") or ""))


# ── Matching people ─────────────────────────────────────────────────────────

def _norm(s: str) -> str:
    return re.sub(r"[^a-z ]", "", (s or "").lower()).strip()


def match(qb: list, emps: list) -> tuple[dict, list]:
    """({email: qb person}, [qb people with no match]). By employee code
    first (the IIF writes "Name(E-0001)"), then first + last name, then a
    unique last name with the same first initial (Jon / John)."""
    by_code = {(e.employee_code or "").strip().upper(): e for e in emps if (e.employee_code or "").strip()}
    by_name: dict = {}
    by_last: dict = {}
    for e in emps:
        f, la = _norm(e.first_name), _norm(e.last_name)
        by_name.setdefault((f.split(" ")[0] if f else "", la.split(" ")[-1] if la else ""), []).append(e)
        if la:
            by_last.setdefault(la.split(" ")[-1], []).append(e)
    out, missing = {}, []
    for p in qb:
        e = by_code.get(p["code"]) if p["code"] else None
        if e is None:
            toks = _norm(p["name"]).split()
            if len(toks) >= 2:
                hits = by_name.get((toks[0], toks[-1])) or []
                if len(hits) != 1:
                    hits = [x for x in (by_name.get((toks[-1], toks[0])) or [])] if not hits else hits
                if len(hits) != 1:
                    hits = [x for x in by_last.get(toks[-1], []) if _norm(x.first_name)[:1] == toks[0][:1]]
                e = hits[0] if len(hits) == 1 else None
        email = (getattr(e, "work_email", "") or "").strip().lower() if e is not None else ""
        if not email or email in out:
            missing.append({"name": p["name"], "code": p["code"]})
            continue
        out[email] = p
    return out, missing


# ── Lining them up ──────────────────────────────────────────────────────────

def _rate(hours: float, acc: float) -> float:
    """Hours a year QuickBooks earns at, from one period: accrued / hours x 2080."""
    return round(acc / hours * 2080, 1) if hours > 0.01 else 0.0


def _us(d: str) -> str:
    try:
        return date.fromisoformat(d).strftime("%m/%d/%Y")
    except (TypeError, ValueError):
        return d or ""


def _h(x: float) -> str:
    """Hours as a person reads them: "2h 58m", never "2.97 h" (Neil, 11/04/2026)."""
    m = int(round(abs(x) * 60))
    return f"{m // 60}h {m % 60:02d}m"


def compare_person(db: Session, emp, qb: dict, pols: dict | None = None) -> dict:
    """One person: Nexus and QuickBooks as of QuickBooks' last period, and
    the reasons they differ."""
    email = (emp.work_email or "").strip().lower()
    name = f"{emp.first_name or ''} {emp.last_name or ''}".strip() or email
    cut = lb.cutover_for(db, email, emp)
    base = {"email": email, "name": name, "qbName": qb["name"], "qbCode": qb["code"], "cutover": cut}
    if not cut:
        return {**base, "state": "not_live", "lines": []}
    rows = qb["rows"]
    asof = rows[-1]["end"]
    if asof < cut:
        return {**base, "state": "not_live", "asOf": asof, "lines": []}   # the report ends before Nexus starts
    pol = lb.policy_for(db, email, emp, pols)
    vp = pol.get("vacation") or {}
    start = lb._start(emp)
    ledger = lb._rows(db, email)
    b = lb.balances(db, email, today=date.fromisoformat(asof), pols=pols, emp=emp, rows=ledger, cut=cut)
    nx_vac = float((b.get("vacation") or {}).get("available") or 0)
    nx_sick = float((b.get("sick") or {}).get("available") or 0)
    qb_vac, qb_sick = rows[-1].get("vacBal", 0.0), rows[-1].get("sickBal", 0.0)
    lines: list[dict] = []

    # The opening: QuickBooks' balance after the last period ending on or
    # before the cutover against the imported row.
    before = [r for r in rows if r["end"] <= cut]
    after = [r for r in rows if r["end"] > cut]
    open_rows = {r.bucket: float(r.hours or 0) for r in ledger if r.kind == "opening"}
    if before:
        for bucket, key in (("vacation", "vacBal"), ("sick", "sickBal")):
            if bucket == "sick" and before[-1]["end"][:4] != asof[:4]:
                continue      # last year's sick does not carry (use it or lose it)
            q, n = before[-1].get(key, 0.0), open_rows.get(bucket)
            if n is None:
                if abs(q) > TOL:
                    lines.append({"bucket": bucket, "kind": "opening", "hours": -q,
                                  "text": f"No opening balance in Nexus. QuickBooks had {_h(q)} on {_us(before[-1]['end'])}."})
            elif abs(n - q) > TOL:
                lines.append({"bucket": bucket, "kind": "opening", "hours": n - q,
                              "text": f"The opening balance is {_h(n)}; QuickBooks had {_h(q)} on {_us(before[-1]['end'])}."})
    elif after:
        lines.append({"bucket": "vacation", "kind": "note", "hours": 0.0,
                      "text": "The report starts after the Nexus start date, so the opening balance is not checked."})

    # Each period QuickBooks paid after the cutover.
    finals = {}
    for r in (db.query(models.TimeApproval)
              .filter(models.TimeApproval.employee_email == email, models.TimeApproval.kind == "final",
                      models.TimeApproval.revoked == 0, models.TimeApproval.period_end > cut).all()):
        finals[r.period_start] = r
    by_ref: dict = {}
    for r in ledger:
        if r.ref_id:
            by_ref.setdefault(r.ref_id, []).append(r)
    counted_refs = set()
    for q in after:
        span = f"{_us(q.get('start'))} - {_us(q['end'])}"
        fin = finals.get(q.get("start") or "")
        if fin is None:
            net_v = q.get("vacAcc", 0.0) - q.get("vacUsed", 0.0)
            net_s = -q.get("sickUsed", 0.0)        # QuickBooks' sick accrual is compared with the grant below
            if abs(net_v) > TOL:
                lines.append({"bucket": "vacation", "kind": "not_final", "hours": -net_v, "period": span,
                              "text": f"{span} is not finalized in Nexus, so its {_h(q.get('vacAcc', 0))} earned"
                                      + (f" and {_h(q.get('vacUsed', 0))} used" if q.get("vacUsed") else "")
                                      + " are not counted yet."})
            if abs(net_s) > TOL:
                lines.append({"bucket": "sick", "kind": "not_final", "hours": -net_s, "period": span,
                              "text": f"{span} is not finalized in Nexus, so its {_h(q.get('sickUsed', 0))} of sick time is not taken off yet."})
            continue
        counted_refs.add(fin.id)
        mine = by_ref.get(fin.id, [])
        n_acc = sum(float(r.hours or 0) for r in mine if r.bucket == "vacation" and r.kind == "accrual" and r.effective_date > cut)
        n_used_v = -sum(float(r.hours or 0) for r in mine if r.bucket == "vacation" and r.kind == "used" and r.effective_date > cut)
        n_used_s = -sum(float(r.hours or 0) for r in mine if r.bucket == "sick" and r.kind == "used" and r.effective_date > cut)
        q_acc = q.get("vacAcc", 0.0)
        if abs(n_acc - q_acc) > TOL:
            lines.extend(_accrual_reasons(span, q, n_acc, mine, vp, start))
        if abs(n_used_v - q.get("vacUsed", 0.0)) > TOL:
            lines.append({"bucket": "vacation", "kind": "used", "hours": -(n_used_v - q.get("vacUsed", 0.0)), "period": span,
                          "text": f"{span}: Nexus took {_h(n_used_v)} of vacation, QuickBooks {_h(q.get('vacUsed', 0))}."})
        if abs(n_used_s - q.get("sickUsed", 0.0)) > TOL:
            lines.append({"bucket": "sick", "kind": "used", "hours": -(n_used_s - q.get("sickUsed", 0.0)), "period": span,
                          "text": f"{span}: Nexus took {_h(n_used_s)} of sick time, QuickBooks {_h(q.get('sickUsed', 0))}."})

    # Nexus rows QuickBooks has no period for, and HR's own adjustments.
    for r in ledger:
        if r.kind == "opening" or not (cut < (r.effective_date or "") <= asof):
            continue
        if r.kind == "adjust" or (r.kind in ("carryover", "forfeit", "payout") and not r.ref_id):
            lines.append({"bucket": r.bucket, "kind": "adjust", "hours": float(r.hours or 0),
                          "text": f"{_us(r.effective_date)}: HR adjustment of {'+' if (r.hours or 0) >= 0 else '-'}{_h(float(r.hours or 0))}"
                                  + (f" - {r.note}" if r.note else "") + "."})
        elif r.ref_id and r.ref_id not in counted_refs and r.kind in ("accrual", "used") and r.ref_id in {f.id for f in finals.values()}:
            fin = next(f for f in finals.values() if f.id == r.ref_id)
            if not any((q.get("start") or "") == fin.period_start for q in after):
                lines.append({"bucket": r.bucket, "kind": "extra_period", "hours": float(r.hours or 0),
                              "period": f"{_us(fin.period_start)} - {_us(fin.period_end)}",
                              "text": f"{_us(fin.period_start)} - {_us(fin.period_end)} is finalized in Nexus but not in the QuickBooks report "
                                      f"({'+' if (r.hours or 0) >= 0 else '-'}{_h(float(r.hours or 0))} {r.bucket})."})
    # Sick time given at once: the policy's grant in Nexus against what
    # QuickBooks accrued after the start date (its January 40 h).
    grant = (b.get("sick") or {}).get("grant") or {}
    n_grant = float(grant.get("hours") or 0) if grant.get("date", "") > cut else 0.0
    q_grant = sum(q.get("sickAcc", 0.0) for q in after if q["end"][:4] == asof[:4])
    if abs(n_grant - q_grant) > TOL:
        lines.append({"bucket": "sick", "kind": "grant", "hours": n_grant - q_grant,
                      "text": f"Sick time given: the policy {_h(n_grant)}"
                              + (f" on {_us(grant['date'])}" if n_grant else "")
                              + f", QuickBooks {_h(q_grant)}."})

    out = {**base, "asOf": asof, "policy": pol.get("name", ""), "lines": lines}
    for bucket, nx, q in (("vacation", nx_vac, qb_vac), ("sick", nx_sick, qb_sick)):
        diff = round(nx - q, 2)
        explained = round(sum(x["hours"] for x in lines if x["bucket"] == bucket), 2)
        rest = round(diff - explained, 2)
        if abs(rest) > TOL:
            lines.append({"bucket": bucket, "kind": "other", "hours": rest,
                          "text": f"{'+' if rest >= 0 else '-'}{_h(rest)} of {bucket} that the report and the ledger do not explain - open the person's history."})
        out[bucket] = {"nexus": round(nx, 2), "quickbooks": round(q, 2), "difference": diff}
    out["state"] = "matches" if all(abs(out[k]["difference"]) <= TOL for k in ("vacation", "sick")) else "differs"
    return out


def _accrual_reasons(span: str, q: dict, n_acc: float, mine: list, vp: dict, start) -> list:
    """Why one period's vacation earned differs: the rate, the hours, or both.
    The two parts add up to the difference exactly."""
    q_acc, q_hours = q.get("vacAcc", 0.0), q.get("hours", 0.0)
    base = float(vp.get("baseHoursPerYear") or 2080)
    q_rate = _rate(q_hours, q_acc)                                   # h a year
    n_rate, since = (lb.tier_since(vp.get("tiers"), start, lb._years_on(start, date.fromisoformat(q["end"])))
                     if start else (0.0, ""))
    n_hours = None
    for r in mine:
        m = _HOURS_NOTE.search(r.note or "") if r.kind == "accrual" else None
        if m:
            n_hours = float(m.group(1))
    if n_hours is None and n_rate:
        n_hours = n_acc / (n_rate / base)
    out = []
    if n_hours is None:
        return [{"bucket": "vacation", "kind": "rate", "hours": n_acc - q_acc, "period": span,
                 "text": f"{span}: Nexus earned {_h(n_acc)}, QuickBooks {_h(q_acc)}."}]
    # Rate effect on Nexus's hours, then the hours effect at QuickBooks' rate.
    rate_part = n_hours * (n_rate - q_rate) / base
    hours_part = (n_acc - q_acc) - rate_part
    if abs(rate_part) > TOL:
        why = f" ({lb._years_on(start, date.fromisoformat(since))} years on {_us(since)})" if since else ""
        out.append({"bucket": "vacation", "kind": "rate", "hours": rate_part, "period": span,
                    "text": f"{span}: QuickBooks earns {q_rate:.0f}h a year, the policy {n_rate:.0f}h a year{why}."})
    if abs(hours_part) > TOL:
        word = "paid" if vp.get("basis") == "paid" else "worked"
        out.append({"bucket": "vacation", "kind": "hours", "hours": hours_part, "period": span,
                    "text": f"{span}: QuickBooks earned on {_h(q_hours)} paid, Nexus on {_h(n_hours)} {word}."})
    if not out:
        out.append({"bucket": "vacation", "kind": "rate", "hours": n_acc - q_acc, "period": span,
                    "text": f"{span}: Nexus earned {_h(n_acc)}, QuickBooks {_h(q_acc)}."})
    return out


def compare(db: Session, data: bytes, emps: list) -> dict:
    """The whole report against the people in the caller's reach."""
    qb = parse_report(data)
    matched, missing = match(qb, emps)
    pols = lb.policies(db)
    by_email = {(e.work_email or "").strip().lower(): e for e in emps}
    people = []
    for email, p in matched.items():
        try:
            people.append(compare_person(db, by_email[email], p, pols))
        except Exception as e:  # noqa: BLE001 - one person never stops the report
            people.append({"email": email, "name": p["name"], "state": "error", "lines": [],
                           "error": str(e)[:200]})
    order = {"differs": 0, "error": 1, "not_live": 2, "matches": 3}
    people.sort(key=lambda x: (order.get(x["state"], 9), x.get("name") or ""))
    in_report = set(matched)
    not_in_report = sorted(
        (f"{e.first_name or ''} {e.last_name or ''}".strip()
         for em, e in by_email.items() if em not in in_report and lb.cutover_for(db, em, e)
         and not lb.benefit_exempt(e)))
    return {"people": people, "unmatched": missing, "notInReport": not_in_report,
            "periodEnd": max((p["rows"][-1]["end"] for p in qb), default="")}
