"""Pay period close alerts and stalled-sheet escalation (Oct 19 2026).

An audit of the Time Clock found that nobody was TOLD when a pay period
closed: an approver learned about the Time Sheets waiting on them only by
opening Workday > Time Sheet, and a sheet nobody approved - or one approved
but never signed - just sat there. Every half hour (`period_close_loop`, in a
thread) this scan keeps three kinds of priority notices current:

  1. PERIOD CLOSE - after a pay period's last day, each approver gets ONE
     notice per period listing the Time Sheets waiting on them (names and a
     count). The approver is whoever timesheet_review says reviews that
     person: manager_of (the manager, else the company's first manager, else
     the company's HR contact who can act), else the Global Admins
     (timesheet_review.no_approver). "Waiting on them" = the same rows their
     Time Sheets to Review list shows: a review "with_manager", or a closed
     period with hours and no review that is not finalized
     (timesheet_review.not_reviewed), over the last LOOKBACK_PERIODS closed
     periods, never before REVIEW_LAUNCH.
     ref_id `period-close:{approver}:{start}:{end}`.
  2. APPROVAL STALLED - a sheet still waiting on its approver more than
     `timesheetEscalateDays` days (per company, Shifts settings, default 2;
     0 = off) after the period ended goes to the approver's own manager,
     else the employee's company HR contact - never back to the approver.
     ref_id `period-stalled:{recipient}:{start}:{end}`.
  3. SIGNATURE STALLED - an approved sheet the employee has not signed
     UNSIGNED_WAIT_DAYS after it went to them (the same clock
     finalize_unsigned_blocker uses, so the notice never arrives before HR
     can act on it; someone who left is listed at once) goes to the company's
     HR contact, else the Global Admins - the people who may Finalize
     Without Employee Signature. ref_id `sign-stalled:{recipient}:{start}:{end}`.

Each is one rollup per recipient per period, rewritten in place
(notify_rollup.upsert_rollup, replace): it comes back to the top, unread,
only when a NEW name joins it; a shrinking list is a quiet update. When a
notice's list is empty it is resolved (actioned, priority 0) with a closing
line - the bar across the top goes away by itself as sheets get approved.

"Today" is each employee's own local date (the offset of their latest punch,
like _employee_today), from `now_utc` - passed in by tests.

Never imports routers.timeclock at module level (it is a large router).
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session

from database import SessionLocal
from models import NexusEmployee, NexusNotification, NexusRole, TimePunch, TimesheetReview
from notify_rollup import resolve_rollup, upsert_rollup

CHECK_EVERY_SEC = 30 * 60
DEFAULT_ESCALATE_DAYS = 2
NAMES_SHOWN = 12

CLOSE, STALLED, UNSIGNED = "period-close", "period-stalled", "sign-stalled"
_REVIEWER_ACTION = {"view": "timeclock", "sub": "timesheet"}


def _span(start: str, end: str) -> str:
    import timesheet_review
    return f"{timesheet_review.us_date(start)} - {timesheet_review.us_date(end)}"


def _ref(kind: str, recipient: str, start: str, end: str) -> str:
    return f"{kind}:{recipient}:{start}:{end}"


def _split_ref(ref: str) -> tuple:
    """(kind, recipient, start, end) - an email never holds a colon."""
    kind, rest = ref.split(":", 1)
    recipient, start, end = rest.rsplit(":", 2)
    return kind, recipient, start, end


def _names(names: list) -> str:
    names = sorted(set(names))
    shown = ", ".join(names[:NAMES_SHOWN])
    return shown + (f" and {len(names) - NAMES_SHOWN} more" if len(names) > NAMES_SHOWN else "")


def _sheets(n: int) -> str:
    return f"{n} time sheet{'s' if n != 1 else ''}"


def _global_admins(db: Session) -> list:
    return sorted({(r.email or "").strip().lower() for r in
                   db.query(NexusRole).filter(NexusRole.role == "owner").all() if r.email})


def _today(db: Session, email: str, now_utc: datetime) -> str:
    import timesheet_review
    return (now_utc - timedelta(minutes=timesheet_review._offset(db, email))).date().isoformat()


def _closed_periods(db: Session, email: str, today: str) -> list:
    """timesheet_review.closed_periods, judged against `today` instead of the
    wall clock: the last LOOKBACK_PERIODS periods that are over, newest first."""
    import timesheet_review
    s, _e, _pt = timesheet_review.period_for(db, email, today)
    out = []
    for _ in range(max(1, timesheet_review.LOOKBACK_PERIODS)):
        s, e, pt = timesheet_review.period_for(db, email, (date.fromisoformat(s) - timedelta(days=1)).isoformat())
        out.append((s, e, pt))
    return out


def _days_after(today: str, end: str) -> int:
    return (date.fromisoformat(today) - date.fromisoformat(end)).days


def _escalate_days(db: Session, company: str, cache: dict) -> int:
    if company not in cache:
        from routers.shift_requests import get_settings
        try:
            cache[company] = max(0, int(get_settings(db, company).get("timesheetEscalateDays",
                                                                       DEFAULT_ESCALATE_DAYS)))
        except (TypeError, ValueError):
            cache[company] = DEFAULT_ESCALATE_DAYS
    return cache[company]


def _skip_level(db: Session, approver: str, employee: str) -> str:
    """Who hears that `approver` has not approved: their own manager, else
    the employee's company HR contact; '' when that is nobody new."""
    import timesheet_review
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == approver).first()
    for cand in (((emp.manager_email if emp else "") or "").strip().lower(),
                 timesheet_review.hr_of(db, employee)):
        if cand and cand not in (approver, employee):
            return cand
    return ""


def _parse(iso: str):
    try:
        t = datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _collect(db: Session, now_utc: datetime) -> dict:
    """{ref_id: {"recipient", "kind", "start", "end", "payType", "names": [...],
    "lines": [...]}} for every notice that should be open right now."""
    import timesheet_review as tr
    from routers.timeclock import _finalized_row, time_tracking_exempt_emails
    want: dict = {}

    def add(kind, recipient, start, end, pay_type, name, line=None, days=0):
        key = _ref(kind, recipient, start, end)
        slot = want.setdefault(key, {"recipient": recipient, "kind": kind, "start": start, "end": end,
                                     "payType": pay_type, "names": [], "lines": [], "days": days})
        slot["days"] = min(slot["days"] or days, days or slot["days"])
        slot["names"].append(name)
        slot["lines"].append(line or name)

    exempt = time_tracking_exempt_emails(db)
    admins = _global_admins(db)
    esc_cache: dict = {}
    for emp in (db.query(NexusEmployee)
                .filter(NexusEmployee.status.in_(("active", "onboarding")), NexusEmployee.work_email != "").all()):
        em = (emp.work_email or "").strip().lower()
        if not em or em in exempt:
            continue
        today = _today(db, em, now_utc)
        approvers = None
        for start, end, pay_type in _closed_periods(db, em, today):
            if end < tr.REVIEW_LAUNCH:
                break
            if _finalized_row(db, em, start, end):
                continue
            r = (db.query(TimesheetReview)
                 .filter(TimesheetReview.employee_email == em, TimesheetReview.period_start == start,
                         TimesheetReview.status != "unlocked")
                 .order_by(TimesheetReview.created_at.desc()).first())
            if r is not None and r.status != "with_manager":
                continue          # with the employee, out for signature (below) or done
            if r is None and not (db.query(TimePunch.id)
                                  .filter(TimePunch.employee_email == em, TimePunch.voided == 0,
                                          TimePunch.local_date >= start, TimePunch.local_date <= end).first()):
                continue          # no hours, nothing to approve
            if approvers is None:
                lead = tr.manager_of(db, em)
                approvers = [lead] if lead else [a for a in admins if a != em]
            name = tr.display_name(db, em)
            for a in approvers:
                add(CLOSE, a, start, end, pay_type, name)
            days = _escalate_days(db, emp.company or "", esc_cache)
            if days and len(approvers) == 1 and _days_after(today, end) > days:
                up = _skip_level(db, approvers[0], em)
                if up:
                    add(STALLED, up, start, end, pay_type, name,
                        f"{name} (waiting on {tr.display_name(db, approvers[0])})", days=days)

    # Signature stalled: straight from the reviews out for the employee's signature.
    for r in (db.query(TimesheetReview)
              .filter(TimesheetReview.status.in_(("approved", "signing")),
                      TimesheetReview.period_end >= tr.REVIEW_LAUNCH).all()):
        em = (r.employee_email or "").lower()
        if _finalized_row(db, em, r.period_start, r.period_end):
            continue
        left = tr._has_left(db, em)
        since = _parse(tr._waiting_since(r))
        if not left and (since is None or now_utc < since + timedelta(days=tr.UNSIGNED_WAIT_DAYS)):
            continue
        hr = tr.hr_of(db, em)
        recipients = [hr] if hr and hr != em else [a for a in admins if a != em]
        name = tr.display_name(db, em)
        for h in recipients:
            add(UNSIGNED, h, r.period_start, r.period_end, r.pay_type or "hourly", name,
                f"{name} (left the company)" if left else name)
    return want


def _words(slot: dict) -> tuple:
    import timesheet_review as tr
    n, span = len(slot["names"]), _span(slot["start"], slot["end"])
    lines = _names(slot["lines"])
    if slot["kind"] == CLOSE:
        return ("Time Sheets to Approve",
                f"The pay period {span} has closed. {_sheets(n)} {'is' if n == 1 else 'are'} waiting on "
                f"your approval: {lines}.")
    if slot["kind"] == STALLED:
        return ("Time Sheet Approvals Overdue",
                f"{_sheets(n)} for {span} {'is' if n == 1 else 'are'} still not approved more than "
                f"{slot['days']} day{'s' if slot['days'] != 1 else ''} after the pay period ended: {lines}.")
    return ("Time Sheets Waiting on Signatures",
            f"{_sheets(n)} for {span} {'was' if n == 1 else 'were'} approved but not signed after "
            f"{tr.UNSIGNED_WAIT_DAYS} days: {lines}. Remind them, or use Finalize Without Employee "
            f"Signature in People > Time > Payroll.")


def _action(slot: dict) -> dict:
    if slot["kind"] == CLOSE:
        return dict(_REVIEWER_ACTION)
    return {"view": "hr", "sub": "hr-time", "start": slot["start"], "payType": slot["payType"]}


_CLOSED_WORDS = {
    CLOSE: ("Time Sheets Approved", "Every time sheet for {span} that was waiting on you is approved."),
    STALLED: ("Overdue Time Sheets Cleared", "Every overdue time sheet for {span} is now approved."),
    UNSIGNED: ("Unsigned Time Sheets Cleared",
               "Every time sheet for {span} that was waiting on a signature is signed or finalized."),
}


def scan(db: Session, now_utc: datetime | None = None) -> dict:
    """One pass: write / refresh / resolve the notices. Commits. Returns
    counts {opened, updated, resolved}."""
    from notify_company import notification_company
    now_utc = now_utc or datetime.now(timezone.utc)
    want = _collect(db, now_utc)
    stats = {"opened": 0, "updated": 0, "resolved": 0}
    for key, slot in want.items():
        title, body = _words(slot)
        old = (db.query(NexusNotification)
               .filter(NexusNotification.recipient == slot["recipient"], NexusNotification.ref_id == key,
                       NexusNotification.type == "custom_alert", NexusNotification.actioned == False)  # noqa: E712
               .first())
        if old is not None and old.body == body and old.title == title:
            continue
        # Back to the top, unread, only when someone new joined the list.
        fresh = old is None or any(n not in (old.body or "") for n in slot["names"])
        if upsert_rollup(db, recipient=slot["recipient"], key=key, title=title, line=body,
                         action=_action(slot), company=notification_company(db, slot["recipient"]),
                         replace=True, quiet=not fresh, priority=1, open_only=True):
            stats["opened"] += 1
        else:
            stats["updated"] += 1
    prefixes = [NexusNotification.ref_id.like(f"{k}:%") for k in (CLOSE, STALLED, UNSIGNED)]
    for n in (db.query(NexusNotification)
              .filter(or_(*prefixes), NexusNotification.type == "custom_alert",
                      NexusNotification.actioned == False).all()):  # noqa: E712
        if n.ref_id in want:
            continue
        try:
            kind, recipient, start, end = _split_ref(n.ref_id)
        except ValueError:
            continue
        if recipient != (n.recipient or "").lower() or kind not in _CLOSED_WORDS:
            continue
        title, line = _CLOSED_WORDS[kind]
        if resolve_rollup(db, recipient=recipient, key=n.ref_id, title=title, line=line.format(span=_span(start, end))):
            stats["resolved"] += 1
    db.commit()
    return stats


def _tick() -> dict:
    db = SessionLocal()
    try:
        return scan(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[period-close] scan failed: {e}")
        return {}
    finally:
        db.close()


async def period_close_loop():
    """Started from main.py's lifespan on the elected leader. The scan is
    synchronous DB work, so it runs in a thread (CLAUDE.md: never block the
    event loop)."""
    await asyncio.sleep(180)
    while True:
        s = await asyncio.to_thread(_tick)
        if s and any(s.values()):
            print(f"[period-close] {s}")
        await asyncio.sleep(CHECK_EVERY_SEC)
