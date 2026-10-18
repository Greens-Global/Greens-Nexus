"""People > Time > Payroll > Retro Pay (Neil, Oct 17 2026).

A FINALIZED period keeps the pay rate it was finalized with (the snapshot in
the 'final' TimeApproval row's note - see timeclock.finalize_timecard), so a
raise HR enters later with an effective date inside that period never
re-prices it. This report finds those periods and says who is owed what, so
payroll can pay the difference off-cycle through the payroll provider.

    GET /timeclock/retro-pay?start=&end=&email=

For every finalized period overlapping [start, end] (default: the last six
months) whose CURRENT rate history (timeclock._rate_on) prices some day
differently from the snapshot, it returns per person, per period:
  - the hours on the changed days by pay class (regular, OT 1.5x, DT 2x,
    leave at the base rate) and the company holidays credited on them,
  - the rate paid (snapshot) and the rate now in effect on those days,
  - the pay by class both ways and the difference owed (positive = the
    person is owed money, negative = they were overpaid),
with totals per person and per currency.

There is NO second pay calculation: both sides are timeclock._compute_timecard
on the same period - once as finalized (the snapshot rate), once with
reprice=True (the snapshot OT rule, each day at the current history rate).
The hours split is therefore identical and only the rate differs.

Read only: nothing finalized is changed. Fixed-salary months are listed as
"check manually" (their snapshot pins the whole monthly result, so there is
nothing to re-price against), and so is a period whose currency or pay type
changed, or one finalized before snapshots were stored.

Access: the payroll export's guard - require_team_read_pay (the manager tier
never sees pay) plus a fresh step-up (require_stepup), limited to the
caller's people (_visible_emails).
"""
import json
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import TimeApproval
from routers.stepup import require_stepup
from routers.timeclock import (_compute_timecard, _display_name, _rate_history, _rate_on, _rate_splits,
                               _us_day, _visible_emails, require_team_read_pay)

router = APIRouter(prefix="/timeclock/retro-pay", tags=["timeclock"])

DEFAULT_DAYS = 183     # "the last six months"
MAX_DAYS = 731         # two years per run - each changed period prices two timecards
_LEAVE = ("sickPay", "vacationPay", "personalPay")


def _r2(v) -> float:
    return round(float(v or 0) + 0.0, 2)


def _day(v: str, what: str) -> date:
    try:
        return date.fromisoformat(v)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{what} must be YYYY-MM-DD")


def _days(a: str, b: str) -> list:
    d0, d1 = date.fromisoformat(a), date.fromisoformat(b)
    return [(d0 + timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


def _same(a: float, b: float) -> bool:
    return abs(float(a or 0) - float(b or 0)) < 0.00005   # rates carry at most 4 decimals


def _pay_parts(t: dict) -> dict:
    """The card's pay by class, in cents."""
    return {"regular": _r2(t.get("regPay")), "overtime": _r2(t.get("otPay")), "doubleTime": _r2(t.get("dtPay")),
            "leave": _r2(sum(float(t.get(k) or 0) for k in _LEAVE)), "holiday": _r2(t.get("holidayPay")),
            "total": _r2(t.get("totalPay"))}


def _manual(em: str, name: str, row, currency: str, reason: str, paid=None, now=None) -> dict:
    return {"email": em, "name": name, "periodStart": row.period_start, "periodEnd": row.period_end,
            "finalizedAt": row.approved_at or "", "currency": currency, "reason": reason,
            "ratePaid": paid, "rateNow": now or []}


def _period(db: Session, em: str, row, hist: list, name_of) -> tuple:
    """(kind, payload) for one finalized period: kind 'owed', 'manual' or ''
    (nothing to pay). Never writes."""
    ps, pe = row.period_start, row.period_end
    try:
        snap = json.loads(row.note or "")
    except (TypeError, ValueError):
        snap = None
    if not isinstance(snap, dict) or "rate" not in snap:
        # Finalized before the rate was stored with the period: what was paid
        # is not on record. Only worth a look when a dated change was entered
        # after the finalize and takes effect on or before the period's end.
        late = [h for h in hist if (h.created_at or "") > (row.approved_at or "")
                and (h.effective_date or "") <= pe]
        if late:
            return "manual", _manual(em, name_of(em), row, (late[-1].currency or "USD"),
                                     "Finalized before pay rates were saved with the period, so the rate paid "
                                     "is not on record. Compare the payroll provider's records.")
        return "", None
    days = _days(ps, pe)
    now_of = {d: _rate_on(db, em, d, hist=hist) for d in days}
    # A snapshot from before currencies were stored: the currency is taken as
    # unchanged (the one in effect on the period's last day).
    cur = snap.get("currency") or now_of[pe]["currency"]
    name = name_of(em)

    if (snap.get("payType") or "hourly") == "fixed":
        paid = float(snap.get("monthlySalary") or 0)
        changed = [d for d in days if not _same(now_of[d]["monthlySalary"], paid)
                   or now_of[d]["payType"] != "fixed" or now_of[d]["currency"] != cur]
        if not changed:
            return "", None
        runs = _rate_splits(changed, {d: now_of[d]["monthlySalary"] for d in changed}, "rate")
        return "manual", _manual(em, name, row, cur,
                                 "Monthly salary: the finalized month keeps its whole result (deductions and "
                                 "weekend pay included), so the difference is not worked out here. Re-run the "
                                 "month with the salary now in effect.", paid=paid, now=runs)

    paid_rate = float(snap.get("rate") or 0)
    # Finalized since Oct 17 2026, a period keeps the rate EACH day was priced
    # at ("rates"); an older snapshot holds one rate for every day.
    _paid_days = snap.get("rates") if isinstance(snap.get("rates"), dict) else {}

    def paid_on(d: str) -> float:
        return float(_paid_days.get(d, paid_rate))
    odd = [d for d in days if now_of[d]["payType"] != "hourly" or now_of[d]["currency"] != cur]
    if odd:
        runs = _rate_splits(odd, {d: now_of[d]["hourlyRate"] for d in odd}, "rate")
        return "manual", _manual(em, name, row, cur,
                                 f"The pay type or currency in effect from {_us_day(odd[0])} differs from the one the "
                                 f"period was finalized with, so the two cannot be compared.",
                                 paid=paid_rate, now=runs)
    changed = [d for d in days if not _same(now_of[d]["hourlyRate"], paid_on(d))]
    if not changed:
        return "", None

    was = _compute_timecard(db, em, ps, pe)                 # as finalized: the snapshot rate
    is_ = _compute_timecard(db, em, ps, pe, reprice=True)   # same hours, each day at today's history
    pw, pn = _pay_parts(was.get("totals") or {}), _pay_parts(is_.get("totals") or {})
    owed = _r2(pn["total"] - pw["total"])
    if owed == 0:
        return "", None   # the rate changed only on days with nothing paid
    ch = set(changed)
    hrs = {"regMin": 0, "otMin": 0, "dtMin": 0, "leaveMin": 0, "holidayDays": 0}
    for d in is_.get("days") or []:
        if d.get("date") not in ch:
            continue
        hrs["regMin"] += int(d.get("regMin") or 0)
        hrs["otMin"] += int(d.get("otMin") or 0)
        hrs["dtMin"] += int(d.get("dtMin") or 0)
        hrs["leaveMin"] += int((d.get("sickMin") or 0) + (d.get("vacationMin") or 0) + (d.get("personalMin") or 0))
        if d.get("holidayPay"):
            hrs["holidayDays"] += 1
    diff = {k: _r2(pn[k] - pw[k]) for k in pn}
    diff["total"] = owed
    return "owed", {
        "email": em, "name": name, "periodStart": ps, "periodEnd": pe, "finalizedAt": row.approved_at or "",
        "currency": cur, "overtimeRule": snap.get("rule") or "ca",
        "changedFrom": changed[0], "changedThrough": changed[-1], "changedDays": len(changed),
        "hours": hrs, "ratePaid": paid_on(changed[-1]),
        "rateNow": _rate_splits(changed, {d: now_of[d]["hourlyRate"] for d in changed}, "rate"),
        "paid": pw, "now": pn, "owedByClass": diff, "owed": owed,
    }


@router.get("")
def retro_pay(start: str = "", end: str = "", email: str = "",
              user: dict = Depends(require_team_read_pay),
              _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    today = datetime.now(timezone.utc).date()
    d1 = _day(end, "end") if end else today
    d0 = _day(start, "start") if start else d1 - timedelta(days=DEFAULT_DAYS)
    if d0 > d1:
        raise HTTPException(400, "start must be on or before end")
    if (d1 - d0).days > MAX_DAYS:
        raise HTTPException(400, "Pick a range of two years or less")
    s, e = d0.isoformat(), d1.isoformat()
    em_only = (email or "").strip().lower()
    scope = _visible_emails(db, user)
    if em_only and scope is not None and em_only not in scope:
        raise HTTPException(403, "Outside your team")

    q = (db.query(TimeApproval)
         .filter(TimeApproval.kind == "final", TimeApproval.revoked == 0,
                 TimeApproval.period_end >= s, TimeApproval.period_start <= e))
    if em_only:
        q = q.filter(TimeApproval.employee_email == em_only)
    seen, rows = set(), []
    for r in q.order_by(TimeApproval.employee_email, TimeApproval.period_start).all():
        em = (r.employee_email or "").lower()
        if scope is not None and em not in scope:
            continue
        k = (em, r.period_start, r.period_end)
        if k in seen or not r.period_start or not r.period_end:
            continue
        seen.add(k)
        rows.append((em, r))

    hist_of: dict = {}
    names: dict = {}

    def name_of(em: str) -> str:
        if em not in names:
            names[em] = _display_name(db, em)
        return names[em]
    people: dict = {}
    manual = []
    for em, r in rows:
        if em not in hist_of:
            hist_of[em] = _rate_history(db, em)
        if not hist_of[em]:
            continue   # no dated rate change on record - nothing can be back-dated
        kind, item = _period(db, em, r, hist_of[em], name_of)
        if kind == "manual":
            manual.append(item)
        elif kind == "owed":
            p = people.setdefault((em, item["currency"]), {"email": em, "name": item["name"],
                                                           "currency": item["currency"], "periods": [], "owed": 0.0})
            p["periods"].append(item)
            p["owed"] = _r2(p["owed"] + item["owed"])

    out = sorted(people.values(), key=lambda p: (p["name"].lower(), p["currency"]))
    totals: dict = {}
    for p in out:
        t = totals.setdefault(p["currency"], {"currency": p["currency"], "people": 0, "periods": 0,
                                              "regMin": 0, "otMin": 0, "dtMin": 0, "leaveMin": 0,
                                              "paid": 0.0, "now": 0.0, "owed": 0.0})
        t["people"] += 1
        for it in p["periods"]:
            t["periods"] += 1
            for k in ("regMin", "otMin", "dtMin", "leaveMin"):
                t[k] += it["hours"][k]
            t["paid"] = _r2(t["paid"] + it["paid"]["total"])
            t["now"] = _r2(t["now"] + it["now"]["total"])
            t["owed"] = _r2(t["owed"] + it["owed"])
    manual.sort(key=lambda m: (m["name"].lower(), m["periodStart"]))
    return {"start": s, "end": e, "email": em_only, "people": out,
            "totals": sorted(totals.values(), key=lambda t: t["currency"]), "checkManually": manual}
