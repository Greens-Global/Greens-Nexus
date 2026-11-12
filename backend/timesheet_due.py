"""A person's OWN Time Sheets that are not finalized yet (Neil, 11/12/2026).

"When a pay period has come to an end, people need to finalize their time
sheet and submit it for approval" - and the reminder stays in their Daily
Briefing until the time sheet is finalized. ONE rule, read by:

  - the Daily Briefing (daily_briefing._timecard_rows: Action Required, and
    _timecard_update_rows: Updates for You while it is with the manager),
  - the Weekly Digest (it reads the briefing's Action Required rows),
  - My Briefing and the dashboard's My Day (the same rows),
  - the bell (reminders.run_daily_scan: the period's last day and the day
    after it closes).

Who: everyone who keeps a Time Sheet - hourly (bi-weekly), salaried on
bi-weekly or monthly pay, and contractors (India contractors included) on
the calendar month. The period is the one their own Time Sheet shows
(timesheet_review.period_for) and "today" is their own local date
(timeclock._employee_today), so an India contractor's month ends at IST
midnight. Never: time-tracking exempt people (Settings > Access), anyone not
active or onboarding, a period with no punch in it (the rule the manager's
Time Sheets to Review list uses - timesheet_review.not_reviewed), a period
ending before timesheet_review.REVIEW_LAUNCH, or a finalized period.

How far back: every closed period since the review launch, up to
LOOKBACK_CAP periods - a period stays until it is finalized, not only the
last few (Neil: "continues to show up ... until the sheet is finalized").

States (one per period):
  closes_today  the current period's last day, not sent yet
  submit        over, not sent (blocker = what stops Submit, '' when nothing)
  resubmit      the manager sent it back
  with_manager  sent; the manager reviews it (an update, not an action)
  correcting    HR unlocked it to correct it (an update)
A review out for the employee's signature ("signing") is the Nexus Sign row
(daily_briefing._esign_action_rows) and one HR changed after approval
("approved") is "Sign Your Updated Time Sheet" (_timesheet_review_rows) -
not repeated here.

`due_cached` keeps one person's answer for a minute (cache.timesheet_due,
dropped by every commit to a time sheet table) because My Day reloads often
and the hours on each row cost a time card computation.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session

from models import NexusEmployee, NexusNotification, TimePunch, TimesheetReview

LOOKBACK_CAP = 26           # a year of bi-weekly periods, two years of months
BELL_TYPE = "timecard_sign"  # the bell's notification type (kept from before 11/12/2026)

ACTION_STATES = ("closes_today", "submit", "resubmit")
UPDATE_STATES = ("with_manager", "correcting")


def _tsr():
    import timesheet_review
    return timesheet_review


def _tc():
    from routers import timeclock
    return timeclock


def _keeps_time_sheet(db: Session, email: str) -> bool:
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    if emp is None or (emp.status or "active") not in ("active", "onboarding"):
        return False
    return not _tc().is_time_tracking_exempt(db, email)


def _periods(db: Session, email: str, today: str, lookback: int = LOOKBACK_CAP) -> list:
    """[(start, end, pay_type, is_current)] - the current period, then every
    closed one back to the review launch (at most `lookback`), oldest first."""
    tsr = _tsr()
    s, e, pt = tsr.period_for(db, email, today)
    out = [(s, e, pt, True)]
    for _ in range(lookback):
        prev = (date.fromisoformat(s) - timedelta(days=1)).isoformat()
        s, e, pt = tsr.period_for(db, email, prev)
        if e < tsr.REVIEW_LAUNCH:
            break
        out.append((s, e, pt, False))
    return list(reversed(out))


def _reviews(db: Session, email: str, floor: str) -> dict:
    """period_start -> the review timesheet_review.active_review would pick."""
    tsr = _tsr()
    live = tsr.ACTIVE + ("completed",)
    best: dict = {}
    for r in (db.query(TimesheetReview)
              .filter(TimesheetReview.employee_email == email, TimesheetReview.period_start >= floor).all()):
        if r.status not in live:
            continue
        cur = best.get(r.period_start)
        if cur is None or (r.created_at or "") > (cur.created_at or ""):
            best[r.period_start] = r
    return best


def _last_round(r: TimesheetReview, actions: tuple) -> dict:
    return next((x for x in reversed(list(r.rounds or [])) if x.get("action") in actions), {})


def due(db: Session, email: str, *, figures: bool = True, lookback: int = LOOKBACK_CAP) -> list:
    """The person's Time Sheets waiting on something, oldest first - one dict
    per period (see the module docstring). `figures`: also the hours, what
    blocks Submit, the approver's name and the Extra Time count (the bell
    needs none of them). `lookback`: how many closed periods to look at."""
    email = (email or "").strip().lower()
    if not email:
        return []
    tsr, tc = _tsr(), _tc()
    # Nobody who has not punched since the review launch has a period to
    # list - the cheap question first (most of the people a scan meets).
    punched = sorted({d for (d,) in db.query(TimePunch.local_date).distinct()
                      .filter(TimePunch.employee_email == email, TimePunch.voided == 0,
                              TimePunch.local_date >= tsr._lookback_floor()).all() if d})
    if not punched or not _keeps_time_sheet(db, email):
        return []
    today = tc._employee_today(db, email)
    periods = _periods(db, email, today, lookback)
    floor = periods[0][0]
    reviews = _reviews(db, email, floor)
    approver = None
    out = []
    for start, end, pay_type, current in periods:
        if current and today != end:
            continue            # still running, and not its last day
        if not any(start <= d <= end for d in punched):
            continue
        r = reviews.get(start)
        status = r.status if r is not None else ""
        if status in ("completed", "signing", "approved"):
            continue            # finalized, or the signature rows cover it
        if status != tsr.CORRECTING and tc._finalized_row(db, email, start, end):
            continue
        if not status:
            state = "closes_today" if current else "submit"
        elif status == "with_employee":
            state = "resubmit"
        elif status == "with_manager":
            state = "with_manager"
        elif status == tsr.CORRECTING:
            state = "correcting"
        else:
            continue
        row = {"start": start, "end": end, "payType": pay_type, "state": state, "current": current,
               "today": today, "reviewId": r.id if r is not None else ""}
        if state == "closes_today":
            row["since"] = f"{end}T00:00:00"
        elif state == "submit":
            row["since"] = f"{(date.fromisoformat(end) + timedelta(days=1)).isoformat()}T00:00:00"
        elif state == "resubmit":
            back = _last_round(r, ("sent_back",))   # send_back is the one way in
            row["since"], row["note"] = back.get("at") or r.updated_at or "", back.get("note") or ""
            row["sentBackBy"] = tsr.display_name(db, back["by"]) if back.get("by") else ""
        elif state == "with_manager":
            sent = _last_round(r, ("submitted", "resubmitted"))
            row["since"] = sent.get("at") or r.updated_at or ""
        else:
            row["since"] = _last_round(r, ("unlocked",)).get("at") or r.updated_at or ""
        if figures:
            if approver is None:
                mgr = tsr.manager_of(db, email)
                approver = (mgr, tsr.display_name(db, mgr) if mgr else "")
            row["approverEmail"], row["approver"] = approver
            if state in ACTION_STATES:
                card = tsr.card_for(db, email, start, end, pay_type)
                row["workedMin"] = int((card.get("totals") or {}).get("workedMin") or 0)
                # What Submit would refuse with; never on the last day itself,
                # when a shift may still be running.
                row["blocker"] = "" if current else tsr.submit_blocker(db, email, start, end)
                try:
                    from routers import extra_time
                    row["extraTimePending"] = extra_time.pending_count(db, email, start, end)
                except Exception:   # noqa: BLE001 - a count must never cost the reminder
                    row["extraTimePending"] = 0
        out.append(row)
    return out


def due_cached(db: Session, email: str) -> list:
    """due() with figures, kept a minute per person (cache.timesheet_due)."""
    import cache
    key = (email or "").strip().lower()
    return cache.timesheet_due.get_or_load(key, lambda: due(db, key))


# ── The bell ─────────────────────────────────────────────────────────────────

def bell_for(db: Session, email: str) -> dict | None:
    """The one Submit Your Time Sheet bell due for this person today, or None:
    on the period's last day ("closes today") and on the first day after it
    closed, while it has not been sent. ref_id is the period start (the last
    day) or `<start>:closed` (the day after), so each is sent once."""
    tsr = _tsr()
    for row in due(db, email, figures=False, lookback=1):   # only the period that just closed matters
        today = row["today"]
        label = f"{tsr.us_date(row['start'])} - {tsr.us_date(row['end'])}"
        action = {"view": "timeclock", "sub": "timesheet", "email": (email or "").lower(),
                  "start": row["start"], "payType": row["payType"]}
        if row["state"] == "closes_today":
            return {"ref_id": row["start"], "action": action,
                    "body": f"Your time sheet for {label} closes today. After your last shift, review your "
                            "hours and submit it to your manager for approval."}
        day_after = (date.fromisoformat(row["end"]) + timedelta(days=1)).isoformat()
        if row["state"] == "submit" and today == day_after:
            return {"ref_id": f"{row['start']}:closed", "action": action,
                    "body": f"Your time sheet for {label} has closed. Review your hours and submit it to your "
                            "manager for approval so you are paid on time."}
    return None


def settle_bells(db: Session, email: str, start: str) -> int:
    """The Submit Your Time Sheet bells of one period are done once it is sent
    (or approved without being sent): the priority bar across the top of the
    screen goes away. Never raises (a savepoint, so a failed read cannot
    abort the caller's transaction); the caller commits."""
    try:
        sp = db.begin_nested()
    except Exception:   # noqa: BLE001
        return 0
    try:
        n = 0
        for row in (db.query(NexusNotification)
                    .filter(NexusNotification.type == BELL_TYPE,
                            NexusNotification.recipient == (email or "").lower(),
                            NexusNotification.ref_id.in_([start, f"{start}:closed"]),
                            or_(NexusNotification.actioned == False,  # noqa: E712
                                NexusNotification.actioned.is_(None))).all()):
            row.actioned = True
            n += 1
        sp.commit()
        return n
    except Exception:   # noqa: BLE001 - a bell must never cost a submission
        sp.rollback()
        return 0
