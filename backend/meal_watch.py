"""California meal reminder at 4.5 hours (Charmi + Neil, Teams Oct 20 2026).

California wants a 30-minute meal break that starts by the end of the 5th
hour of work (ca_breaks.FIRST_BY_MIN). Charmi: "Nexus should send reminders
for all CA employees meal reminder at 4.5 hours ... if they have already
clocked out then no reminder". Neil: "CA employees salary/hourly with time
tracking enabled".

Every minute, inside shift_attendance's no-show loop (in a thread), this
looks at everyone clocked in and WORKING (not on a break) and adds up the
day's work from their punches (the opening clock-in's local date; every
Start Break / End Break and clock-out / clock-in in between is a gap):

  - once the day's work reaches `mealReminderMin` (Shifts settings, per
    company, 270 = 4.5 hours by default, 0 = off) and is still under 5
    hours, the person gets ONE bell, "Meal Break Reminder", with the
    deadline on their own clock, 12-hour - keyed `meal_due:<work date>`,
    so a second tick or a restart never repeats it;
  - nothing when a break of 30+ minutes already came before the 5th hour,
    when they are on a break or clocked out, or once 5 hours have passed
    (the deadline is gone; the time sheet's meal detection takes over).

Who: ca_breaks.reminder_scope (California, hourly AND salaried), active,
never anyone exempt from time tracking. The reminder never changes pay.
Delivery matches break_watch.py's "Still on Break?": the bell.

Never imports routers.timeclock at module level (it is a large router).
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from database import SessionLocal
from notify_rollup import upsert_rollup

DEFAULT_REMIND_MIN = 270
MAX_REMIND_MIN = 295            # must land before the 5-hour deadline
PREFIX = "meal_due:"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _parse(s: str):
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def remind_min(cfg: dict) -> int:
    try:
        return min(MAX_REMIND_MIN, max(0, int(cfg.get("mealReminderMin", DEFAULT_REMIND_MIN))))
    except (TypeError, ValueError):
        return DEFAULT_REMIND_MIN


def hr_min(minutes: int) -> str:
    """'4 hr 30 min' / '4 hr' / '45 min'."""
    m = max(0, int(minutes or 0))
    h, r = divmod(m, 60)
    if h and r:
        return f"{h} hr {r} min"
    return f"{h} hr" if h else f"{r} min"


def day_work(punches: list, now: datetime):
    """(work minutes so far, [{"at": work minutes before it, "min": length}])
    for one person's punches of the day in time order, the shift still open
    at `now`. None when the punches cannot be read."""
    work, start = 0.0, None
    gaps, gap_from = [], None
    for p in punches:
        t = _parse(p.at)
        if t is None:
            return None
        if p.kind in ("in", "break_end"):
            if start is None:
                if gap_from is not None:
                    gaps.append({"at": int(work), "min": int((t - gap_from).total_seconds() // 60)})
                    gap_from = None
                start = t
        elif p.kind in ("out", "break_start"):
            if start is not None:
                work += max(0.0, (t - start).total_seconds() / 60)
                start, gap_from = None, t
    if start is None:
        return None          # not working right now
    work += max(0.0, (now - start).total_seconds() / 60)
    return int(work), gaps


def meal_scan(db: Session, now_utc: datetime = None) -> dict:
    """One pass. Returns {working, reminded}."""
    from ca_breaks import FIRST_BY_MIN, MEAL_MIN, reminder_scope
    from overtime_watch import OPEN_WINDOW_MIN, _iso, open_shifts
    from routers.timeclock import _leave_class, time_tracking_exempt_emails
    from shift_attendance import _active, _clock12, _people
    from shift_rules import config_for

    now = now_utc or _utcnow()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    summary = {"working": 0, "reminded": 0}
    working = {em: (last, opened) for em, (last, opened) in open_shifts(db, now).items()
               if last.kind in ("in", "break_end") and not _leave_class(getattr(opened, "category", ""))}
    summary["working"] = len(working)
    if not working:
        return summary
    emails = list(working)
    exempt = time_tracking_exempt_emails(db)
    people = _people(db, emails)
    rates = {(r.employee_email or "").lower(): r for r in
             db.query(models.PayrollRate).filter(func.lower(models.PayrollRate.employee_email).in_(emails)).all()}
    conf = None
    due = []
    for em, (last, opened) in working.items():
        emp = people.get(em)
        if em in exempt or not _active(emp) or not reminder_scope(db, em, rates.get(em), emp=emp):
            continue
        if conf is None:
            conf = config_for(db, emails)
        limit = remind_min((conf.get(em) or ({}, ""))[0])
        if not limit:
            continue
        day = opened.local_date or ""
        punches = (db.query(models.TimePunch)
                   .filter(func.lower(models.TimePunch.employee_email) == em, models.TimePunch.voided == 0,
                           models.TimePunch.at >= _iso(now - timedelta(minutes=OPEN_WINDOW_MIN)),
                           models.TimePunch.at <= _iso(now))
                   .order_by(models.TimePunch.at).all())
        # The work day = from its first punch on; a shift past midnight
        # keeps its later punches (they carry the next date).
        first = next((i for i, p in enumerate(punches) if (p.local_date or "") == day), None)
        tl = day_work(punches[first:], now) if first is not None else None
        if tl is None:
            continue
        work_min, gaps = tl
        if any(g["min"] >= MEAL_MIN and g["at"] <= FIRST_BY_MIN for g in gaps):
            continue         # the meal is already taken
        if limit <= work_min < FIRST_BY_MIN:
            due.append((em, day, last, work_min))
    if not due:
        return summary
    keys = [f"{PREFIX}{day}" for _em, day, _p, _m in due]
    written = {((n.recipient or "").lower(), n.ref_id) for n in
               db.query(models.NexusNotification.recipient, models.NexusNotification.ref_id)
               .filter(models.NexusNotification.ref_id.in_(keys)).all()}
    for em, day, last, work_min in due:
        key = f"{PREFIX}{day}"
        if (em, key) in written:
            continue
        by = now + timedelta(minutes=FIRST_BY_MIN - work_min)
        clock = _clock12(by.replace(tzinfo=None) - timedelta(minutes=last.tz_offset_min or 0))
        upsert_rollup(db, recipient=em, key=key, title="Meal Break Reminder",
                      line=(f"You have worked {hr_min(work_min)}. Take your 30-minute meal break "
                            f"before 5 hours (by {clock})."),
                      action={"view": "timeclock", "kind": "meal_due"},
                      company=getattr(people.get(em), "company", "") or "", priority=0)
        written.add((em, key))
        summary["reminded"] += 1
    db.commit()
    return summary


def tick() -> dict:
    db = SessionLocal()
    try:
        return meal_scan(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[meal-watch] scan failed: {e}")
        return {}
    finally:
        db.close()
