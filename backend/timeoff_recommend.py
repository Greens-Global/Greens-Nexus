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


class Memo:
    """What a LIST of pending requests reads over and over, read once per
    request (11/02/2026): the settings per company, the leave policies, and
    per person their employee row, balances, local today and holidays;
    teammates per manager. `_TimeoffPrivacy` holds one for the whole list
    (timeclock._ser_timeoff), so 40 pending rows cost one settings read per
    company and one of each per person, not 40 of each. A call with no memo
    makes a throwaway one - the same answers, no cache."""

    def __init__(self, db: Session, emp_lookup=None):
        self.db = db
        self._emp_lookup = emp_lookup       # the privacy helper's employee map, when there is one
        self._emps: dict = {}
        self._settings: dict = {}
        self._pols = None
        self._balances: dict = {}
        self._today: dict = {}
        self._holidays: dict = {}
        self._mates: dict = {}

    def emp(self, email: str):
        email = (email or "").strip().lower()
        if email not in self._emps:
            if self._emp_lookup is not None:
                self._emps[email] = self._emp_lookup(email)
            else:
                self._emps[email] = (self.db.query(models.NexusEmployee)
                                     .filter(func.lower(models.NexusEmployee.work_email) == email).first())
        return self._emps[email]

    def settings(self, email: str) -> dict:
        from routers.shift_requests import get_settings
        emp = self.emp(email)
        company = ((emp.company if emp is not None else "") or "")
        if company not in self._settings:
            self._settings[company] = get_settings(self.db, company)
        return self._settings[company]

    def pols(self) -> dict:
        if self._pols is None:
            import leave_balances
            self._pols = leave_balances.policies(self.db)
        return self._pols

    def balances(self, email: str) -> dict:
        email = (email or "").strip().lower()
        if email not in self._balances:
            import leave_balances
            self._balances[email] = leave_balances.balances(self.db, email, pols=self.pols(), emp=self.emp(email))
        return self._balances[email]

    def today(self, email: str) -> str:
        email = (email or "").strip().lower()
        if email not in self._today:
            from routers.timeclock import _employee_today
            self._today[email] = _employee_today(self.db, email)
        return self._today[email]

    def holidays(self, email: str, lo: str, hi: str) -> set:
        email = (email or "").strip().lower()
        key = (email, lo, hi)
        if key not in self._holidays:
            from routers.timeclock import _holiday_days
            self._holidays[key] = {d for (_e, d) in _holiday_days(self.db, [email], lo, hi)}
        return self._holidays[key]

    def mates(self, mgr: str) -> dict:
        """{email: employee} of everyone reporting to `mgr`."""
        mgr = (mgr or "").strip().lower()
        if mgr not in self._mates:
            out = {}
            for e in (self.db.query(models.NexusEmployee)
                      .filter(func.lower(models.NexusEmployee.manager_email) == mgr).all()):
                em = (e.work_email or "").strip().lower()
                if em:
                    out[em] = e
            self._mates[mgr] = out
        return self._mates[mgr]


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


def working_days(db: Session, req, memo: Memo | None = None) -> list[str]:
    """The request's working days (ISO): weekdays, minus the person's own
    company holidays - mandatory ones, the same days the planner's Fill
    Automatically leaves empty (timeclock._holiday_days)."""
    d0, d1 = _day(req.start_date), _day(req.end_date or req.start_date)
    if not d0 or not d1 or d1 < d0:
        return []
    memo = memo or Memo(db)
    email = (req.employee_email or "").strip().lower()
    off = memo.holidays(email, d0.isoformat(), d1.isoformat())
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


def _balance(db: Session, req, days: list, memo: Memo | None = None) -> tuple[bool | None, str]:
    """(ok, reason) - (None, '') when there is nothing to check: unpaid
    leave (no bucket) or no live balance for the person."""
    import leave_balances
    memo = memo or Memo(db)
    email = (req.employee_email or "").strip().lower()
    pols = memo.pols()
    pol = leave_balances.policy_for(db, email, emp=memo.emp(email), pols=pols)
    bucket = leave_balances.bucket_of(req.type, pol)
    if not bucket:
        return None, ""
    b = memo.balances(email)
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


def _has_manager(db: Session, req) -> bool:
    email = (req.employee_email or "").strip().lower()
    emp = db.query(models.NexusEmployee).filter(func.lower(models.NexusEmployee.work_email) == email).first()
    return bool(((emp.manager_email if emp is not None else "") or "").strip())


def _teammates_off(db: Session, req, memo: Memo | None = None) -> list[str]:
    """One sentence per teammate (same manager) with approved or pending
    time off inside the request's span; [] when nobody is."""
    memo = memo or Memo(db)
    email = (req.employee_email or "").strip().lower()
    emp = memo.emp(email)
    mgr = ((emp.manager_email if emp is not None else "") or "").strip().lower()
    if not mgr:
        return []
    mates = {em: e for em, e in memo.mates(mgr).items() if em != email}
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


def _notice(db: Session, req, notice_days: int, memo: Memo | None = None) -> tuple[bool, str]:
    """(ok, reason) on how far ahead the request starts, by the PERSON's
    own calendar day (timeclock._employee_today)."""
    memo = memo or Memo(db)
    start = _day(req.start_date)
    today = _day(memo.today((req.employee_email or "").strip().lower()))
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


def recommend(db: Session, req, memo: Memo | None = None) -> dict:
    """{"tone": "good" | "check", "label": ..., "reasons": [sentences]} for one
    request. What needs a look is listed first, then what is fine. `memo`
    (a Memo) is shared across a list so the settings, policies and each
    person's balances are read once."""
    memo = memo or Memo(db)
    cfg = memo.settings(req.employee_email or "")
    notice_days = int(cfg.get("timeOffNoticeDays", 7) or 0)
    short_days = int(cfg.get("timeOffShortDays", 3) or 1)
    days = working_days(db, req, memo)
    fine, look = [], []
    ok, why = _balance(db, req, days, memo)
    if ok is not None:
        (fine if ok else look).append(why)
    mates = _teammates_off(db, req, memo)
    if mates:
        look.extend(mates)
    elif _has_manager(db, req):
        # No manager = no team to speak of: saying nobody is off would claim
        # a check that was never made.
        fine.append("Nobody else on the team is off those days.")
    ok, why = _notice(db, req, notice_days, memo)
    if why:
        (fine if ok else look).append(why)
    if len(days) > short_days:
        look.append(f"{len(days)} working days - longer than the usual {short_days}.")
    tone = CHECK if look else GOOD
    return {"tone": tone, "label": LABELS[tone], "reasons": look + fine}


def for_decider(db: Session, req, memo: Memo | None = None) -> dict | None:
    """The recommendation to show a DECIDER of a pending request, or None
    (not pending, or it could not be worked out - the list never breaks
    over a hint). Pass one `memo` for a whole list."""
    if (getattr(req, "status", "") or "") != "pending":
        return None
    try:
        return recommend(db, req, memo)
    except Exception:  # noqa: BLE001 - a hint is never worth a 500
        log.warning("time-off recommendation failed for %s", getattr(req, "id", "?"), exc_info=True)
        return None
