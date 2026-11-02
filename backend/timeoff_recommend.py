"""Time-off approval recommendation (Neil, 11/02/2026, from the Homebase
audit): a soft hint beside a PENDING request for the people who decide it -
"Recommended: Approve" or "Check First" - with the reasons in plain words.

Nothing here approves or rejects anything. The manager's Approve / Reject
buttons are unchanged, no route reads the hint, and a request with no
recommendation (a problem working one out) is simply shown without it.

"Recommended: Approve" when ALL hold, else "Check First":
  * the balance covers it - leave_balances.balances, the hours it needs
    being its working days (weekdays minus the person's own company
    holidays - Review Focus 2) at the policy's hours a day, or its window
    on a part day; skipped when the type has no bucket (unpaid) or the
    person has no live balance yet;
  * nobody else on the team (the same manager_email) has approved or
    pending time off inside the span;
  * it starts at least `timeOffNoticeDays` (Settings > Shifts & Scheduling,
    per company; default 7) days ahead of the person's own today;
  * it is at most `timeOffShortDays` (default 3) working days.

Reasons are sentences: "Balance covers it (32 h left after).", "Nobody else
on the team is off those days.", "Requested 12 days ahead." - or for a
check: "Balance is 8 h short.", "Ana Diaz is also off 11/14/2026.", "Starts
in 2 days.", "5 working days." Dates are MM/DD/YYYY (CLAUDE.md).
"""
import logging
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

import models

log = logging.getLogger("nexus.timeoff_recommend")

GOOD, CHECK = "good", "check"
LABELS = {GOOD: "Recommended: Approve", CHECK: "Check First"}
_MAX_NAMED = 3          # teammates named one by one; the rest are counted


def _day(iso) -> date | None:
    try:
        return date.fromisoformat(str(iso or "")[:10])
    except (TypeError, ValueError):
        return None


def _us(d) -> str:
    d = d if isinstance(d, date) else _day(d)
    return d.strftime("%m/%d/%Y") if d else ""


def _h(v: float) -> str:
    """Hours for a sentence: 24, 7.5 - never 24.0."""
    return f"{round(float(v), 2):g}"


def working_days(db: Session, req) -> list[str]:
    """The request's working days (ISO): weekdays, minus the person's own
    company holidays - mandatory ones, the same days the planner's Fill
    Automatically leaves empty (timeclock._holiday_days)."""
    d0, d1 = _day(req.start_date), _day(req.end_date or req.start_date)
    if not d0 or not d1 or d1 < d0:
        return []
    from routers.timeclock import _holiday_days
    email = (req.employee_email or "").strip().lower()
    off = {d for (_e, d) in _holiday_days(db, [email], d0.isoformat(), d1.isoformat())}
    out, d = [], d0
    while d <= d1 and len(out) < 400:
        if d.weekday() < 5 and d.isoformat() not in off:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def needed_hours(db: Session, req, hours_per_day: float, days: list | None = None) -> float:
    """Hours the request draws from a balance: its window on a part day,
    else its working days at the policy's hours a day."""
    import leave_balances
    if (getattr(req, "start_time", "") or "") and (getattr(req, "end_time", "") or ""):
        return leave_balances.request_hours(req, hours_per_day)
    return len(days if days is not None else working_days(db, req)) * float(hours_per_day or 8)


def _balance(db: Session, req, days: list) -> tuple[bool | None, str]:
    """(ok, reason) - (None, '') when there is nothing to check: unpaid
    leave (no bucket) or no live balance for the person."""
    import leave_balances
    email = (req.employee_email or "").strip().lower()
    pols = leave_balances.policies(db)
    pol = leave_balances.policy_for(db, email, pols=pols)
    bucket = leave_balances.bucket_of(req.type, pol)
    if not bucket:
        return None, ""
    b = leave_balances.balances(db, email, pols=pols)
    if not b.get("live"):
        return None, ""
    if bucket in ("vacation", "sick"):
        bk = b.get(bucket)
    else:
        bk = next((t for t in (b.get("extraTypes") or []) if t.get("id") == bucket), None)
    if not bk:
        return None, ""
    # What is approved ahead is already spoken for; other PENDING requests
    # are not (the manager sees each one on its own, like the request bell).
    have = float(bk.get("available") or 0) - float(bk.get("upcoming") or 0)
    need = needed_hours(db, req, float((b.get("policy") or {}).get("hoursPerDay") or 8), days)
    left = have - need
    if left < 0:
        return False, f"Balance is {_h(-left)} h short."
    return True, f"Balance covers it ({_h(left)} h left after)."


def _teammates_off(db: Session, req) -> list[str]:
    """One sentence per teammate (same manager) with approved or pending
    time off inside the request's span; [] when nobody is."""
    email = (req.employee_email or "").strip().lower()
    emp = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == email).first()
    mgr = ((emp.manager_email if emp is not None else "") or "").strip().lower()
    if not mgr:
        return []
    mates = {}
    for e in db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.manager_email) == mgr).all():
        em = (e.work_email or "").strip().lower()
        if em and em != email:
            mates[em] = e
    if not mates:
        return []
    d0 = (req.start_date or "")[:10]
    d1 = (req.end_date or req.start_date or "")[:10]
    rows = (db.query(models.TimeOffRequest)
            .filter(func.lower(models.TimeOffRequest.employee_email).in_(sorted(mates)),
                    models.TimeOffRequest.status.in_(["approved", "pending"]),
                    models.TimeOffRequest.start_date <= d1, models.TimeOffRequest.end_date >= d0)
            .order_by(models.TimeOffRequest.start_date.asc(), models.TimeOffRequest.employee_email.asc()).all())
    out, seen = [], set()
    for r in rows:
        if r.id == req.id:
            continue
        em = (r.employee_email or "").strip().lower()
        e = mates.get(em)
        name = (f"{e.first_name or ''} {e.last_name or ''}".strip() if e is not None else "") \
            or em.split("@")[0].replace(".", " ").title()
        a, b = max((r.start_date or "")[:10], d0), min((r.end_date or r.start_date or "")[:10], d1)
        when = _us(a) if a == b else f"{_us(a)} - {_us(b)}"
        if (em, when) in seen:
            continue
        seen.add((em, when))
        out.append(f"{name} is also off {when}.")
    if len(out) > _MAX_NAMED:
        more = len(out) - _MAX_NAMED
        out = out[:_MAX_NAMED] + [f"{more} more on the team {'is' if more == 1 else 'are'} off those days."]
    return out


def _notice(db: Session, req, notice_days: int) -> tuple[bool, str]:
    """(ok, reason) on how far ahead the request starts, by the PERSON's
    own calendar day (timeclock._employee_today)."""
    from routers.timeclock import _employee_today
    start = _day(req.start_date)
    today = _day(_employee_today(db, (req.employee_email or "").strip().lower()))
    if not start or not today:
        return True, ""
    ahead = (start - today).days
    if ahead >= notice_days:
        if ahead > 1:
            return True, f"Requested {ahead} days ahead."
        return True, "Requested 1 day ahead." if ahead == 1 else ("Starts today." if ahead == 0 else "Already started.")
    if ahead < 0:
        return False, "Already started."
    if ahead == 0:
        return False, "Starts today."
    return False, "Starts in 1 day." if ahead == 1 else f"Starts in {ahead} days."


def recommend(db: Session, req) -> dict:
    """{"tone": "good" | "check", "label": ..., "reasons": [sentences]} for one
    request. What needs a look is listed first, then what is fine."""
    from routers.shift_requests import settings_for
    cfg = settings_for(db, req.employee_email or "")
    notice_days = int(cfg.get("timeOffNoticeDays", 7) or 0)
    short_days = int(cfg.get("timeOffShortDays", 3) or 1)
    days = working_days(db, req)
    fine, look = [], []
    ok, why = _balance(db, req, days)
    if ok is not None:
        (fine if ok else look).append(why)
    mates = _teammates_off(db, req)
    if mates:
        look.extend(mates)
    else:
        fine.append("Nobody else on the team is off those days.")
    ok, why = _notice(db, req, notice_days)
    if why:
        (fine if ok else look).append(why)
    if len(days) > short_days:
        look.append(f"{len(days)} working days.")
    tone = CHECK if look else GOOD
    return {"tone": tone, "label": LABELS[tone], "reasons": look + fine}


def for_decider(db: Session, req) -> dict | None:
    """The recommendation to show a DECIDER of a pending request, or None
    (not pending, or it could not be worked out - the list never breaks
    over a hint)."""
    if (getattr(req, "status", "") or "") != "pending":
        return None
    try:
        return recommend(db, req)
    except Exception:  # noqa: BLE001 - a hint is never worth a 500
        log.warning("time-off recommendation failed for %s", getattr(req, "id", "?"), exc_info=True)
        return None
