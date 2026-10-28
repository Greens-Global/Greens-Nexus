"""Live overtime alert (Neil, Oct 17 2026).

shift_rules.py warns about overtime while a schedule is being BUILT; this
watches the clock. Every five minutes (`overtime_loop`, in a thread) it looks
at the people clocked in right now and tells their manager when one of them is
about to cross into overtime:

  - DAILY: within `otAlertDailyLeadMin` (30 by default) of 8 worked hours in
    the work day - people on the California ('ca') overtime rule only;
  - WEEKLY: within `otAlertWeeklyLeadMin` (120 by default) of 40 hours of
    straight time in the PAYROLL week (Sunday - Saturday) - 'ca' and
    'federal'. Under 'ca' only straight time counts toward the 40 (the
    timecard's anti-pyramiding), so a CA person past 8 hours today cannot
    reach weekly overtime today by the clock: the earlier crossing is the
    one reported, never both.

The minutes are the TIME SHEET's: routers/timeclock._compute_timecard runs on
the week with the open shift closed at "now" for the math only (`open_until`,
nothing stored), so rounding, breaks, the paid rest-break credit, auto-lunch,
leave classes (Sick / PTO never feed overtime) and the 7th-day rule all come
from the one engine and its _ot_split. Someone already in overtime today is
not "soon" and gets nothing. Someone on a break is skipped until they are
back (their clock is not running, so a crossing time would be wrong).

Who: active people with a running shift whose overtime rule
(shift_rules.config_for: the rate row, else the country; exempt from time
tracking -> 'none') is 'ca' or 'federal', who are not on fixed (monthly)
pay, and whose company has `otAlertOn` (Shifts settings, per company, OFF by
default: a CA team on 8-hour days would otherwise hear about every person
every day). Told: the person's manager and their Backup Manager (the
no-show scan's _recipients_for with no team, so no schedulers; the company's
HR contact only when there is nobody else) - never the person, never a
broadcast. There is no per-person mute for this kind of notice yet.

One bell per person per threshold per period: the ref key is
`ot_soon:daily:<email>:<work date>` / `ot_soon:weekly:<email>:<week start>`
and a key that already has a notice for that recipient is never written
again, so a restart, a second tick or a manager reading and clearing it never
brings it back. A quiet (priority 0) custom_alert; Open goes to the person's
timecard on that pay period. Times are on the employee's own clock (the
browser offset of the punch that opened the shift), 12-hour.

Cost per tick: one read of the last 16 hours of punches; when anyone is
clocked in, the settings / rule reads of shift_rules.config_for, one read of
those people's week of punches, and the full timecard ONLY for people whose
cheap upper bound (elapsed clock time, no breaks taken off) could put them
inside a lead window and who have not been told yet.

Never imports routers.timeclock at module level (it is a large router).
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from database import SessionLocal
from notify_rollup import upsert_rollup
import job_switch

SCAN_SEC = 5 * 60
OPEN_WINDOW_MIN = 16 * 60    # timeclock._MAX_SHIFT_MIN: an older open punch is not a running shift
DAY_OT_MIN = 8 * 60          # timeclock._DAY_OT_MIN
WEEK_OT_MIN = 40 * 60        # timeclock._WEEK_OT_MIN
DEFAULT_DAILY_LEAD = 30
DEFAULT_WEEKLY_LEAD = 120
_BOUND_SLACK = 15            # minutes added to the cheap bound (rounding to the nearest 5 per punch)
# {email: work date} of people already in overtime that work day: overtime
# only grows within a day, so nothing more can be "soon" for them until the
# next one - their timecard is not recomputed every tick until they clock
# out. Per process; a restart only costs one recompute each.
_OVER_TODAY: dict = {}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _parse(s: str) -> Optional[datetime]:
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _hm(minutes: int) -> str:
    m = max(0, int(minutes or 0))
    return f"{m // 60}h {m % 60}m"


def _lead(cfg: dict, key: str, default: int) -> int:
    try:
        return max(0, int(cfg.get(key, default)))
    except (TypeError, ValueError):
        return default


def _keys(email: str, work_date: str, week_start: str) -> dict:
    return {"daily": f"ot_soon:daily:{email}:{work_date}", "weekly": f"ot_soon:weekly:{email}:{week_start}"}


# ── The projection ───────────────────────────────────────────────────────

def project(rule: str, today_min: int, today_ot: int, week_straight: int) -> Optional[tuple]:
    """The next overtime crossing for someone whose clock is running:
    ('daily' | 'weekly', minutes from now) or None.

    `today_min` = the work day's worked minutes so far (leave excluded),
    `today_ot` = its overtime + double time so far, `week_straight` = the
    payroll week's straight-time minutes so far, today included - all from
    the timecard's own _ot_split. Already in overtime today (daily, weekly,
    the CA 7th day) = None: it is not "soon" any more."""
    rule = (rule or "").lower()
    if rule not in ("ca", "federal") or today_ot > 0:
        return None
    daily = (DAY_OT_MIN - today_min) if rule == "ca" else None
    if daily is not None and daily <= 0:
        return None
    weekly = WEEK_OT_MIN - week_straight
    # Under 'ca' a minute past 8 hours today is daily overtime and no longer
    # counts toward the weekly 40: weekly comes first only if it comes sooner.
    if weekly > 0 and (daily is None or weekly < daily):
        return ("weekly", weekly)
    if daily is not None:
        return ("daily", daily)
    return None


def _bounds(punches: list, work_date: str, week_start: str, now: datetime) -> tuple:
    """(day, week) UPPER bounds on worked minutes: clock time from each
    clock-in to its clock-out (or now), no breaks taken off, plus slack for
    rounding. Only decides whether the full timecard is worth running."""
    day = week = 0.0
    segs = 0
    open_in = open_date = None
    for p in punches:
        t = _parse(p.at)
        if t is None:
            continue
        if p.kind == "in":
            open_in, open_date = t, p.local_date or ""
        elif p.kind == "out" and open_in is not None:
            span = (t - open_in).total_seconds() / 60
            if week_start <= open_date <= work_date:
                week += span
                segs += 1
                if open_date == work_date:
                    day += span
            open_in = None
    if open_in is not None and week_start <= open_date <= work_date:
        span = (now - open_in).total_seconds() / 60
        week += span
        segs += 1
        if open_date == work_date:
            day += span
    slack = _BOUND_SLACK + 5 * segs
    return day + slack, week + slack


# ── The scan ─────────────────────────────────────────────────────────────

def open_shifts(db: Session, now: datetime) -> dict:
    """{email(lower): (last punch, the clock-in that opened the shift)} for
    everyone whose newest punch in the last 16 hours is not a clock-out."""
    floor = _iso(now - timedelta(minutes=OPEN_WINDOW_MIN))
    rows = (db.query(models.TimePunch)
            .filter(models.TimePunch.voided == 0, models.TimePunch.at >= floor,
                    models.TimePunch.at <= _iso(now))
            .order_by(models.TimePunch.at).all())
    latest, opened = {}, {}
    for p in rows:
        em = (p.employee_email or "").strip().lower()
        if not em:
            continue
        latest[em] = p
        if p.kind == "in":
            opened[em] = p
        elif p.kind == "out":
            opened.pop(em, None)
    return {em: (p, opened[em]) for em, p in latest.items() if p.kind != "out" and em in opened}


def _week_punches(db: Session, emails: list, since: str) -> dict:
    out: dict = {}
    if not emails:
        return out
    for p in (db.query(models.TimePunch)
              .filter(func.lower(models.TimePunch.employee_email).in_(emails), models.TimePunch.voided == 0,
                      models.TimePunch.local_date >= since)
              .order_by(models.TimePunch.at).all()):
        out.setdefault((p.employee_email or "").lower(), []).append(p)
    return out


def _sent(db: Session, keys: list) -> set:
    """{(recipient, ref key)} already written - any state, read or closed."""
    if not keys:
        return set()
    return {((n.recipient or "").lower(), n.ref_id) for n in
            db.query(models.NexusNotification.recipient, models.NexusNotification.ref_id)
            .filter(models.NexusNotification.ref_id.in_(keys)).all()}


def _when(now: datetime, minutes: int, tz_offset_min: int) -> str:
    """The crossing on the employee's clock (JS getTimezoneOffset: local =
    UTC - offset), 12-hour; the date too when it is not today there."""
    from shift_attendance import _clock12
    local_now = now.replace(tzinfo=None) - timedelta(minutes=tz_offset_min or 0)
    at = local_now + timedelta(minutes=minutes)
    text = _clock12(at)
    if at.date() != local_now.date():
        text += f" on {at.strftime('%m/%d/%Y')}"
    return text


def _body(kind: str, name: str, when: str, today_min: int, week_total: int, week_straight: int) -> str:
    if kind == "daily":
        return f"{name} has worked {_hm(today_min)} today and reaches daily overtime at {when}."
    regular = "" if week_total == week_straight else f" ({_hm(week_straight)} regular)"
    return f"{name} has worked {_hm(week_total)} this week{regular} and reaches weekly overtime at {when}."


def overtime_scan(db: Session, now_utc: datetime = None) -> dict:
    """One pass. Returns {open, checked, alerts}."""
    from routers.timeclock import _compute_timecard, _timecard_action, _week_start_str
    from shift_attendance import _active, _name, _people, _recipient_people, _recipients_for
    from shift_rules import config_for

    now = now_utc or _utcnow()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    summary = {"open": 0, "checked": 0, "alerts": 0}
    running = open_shifts(db, now)
    summary["open"] = len(running)
    for em in [e for e in _OVER_TODAY if e not in running]:
        _OVER_TODAY.pop(em, None)   # clocked out: forget them
    if not running:
        return summary
    conf = config_for(db, list(running))

    # Who could be told at all: the company switch, a rule with overtime, a
    # lead that is on, not on a break.
    plan = {}   # email -> (cfg, rule, kinds, last, opened, work_date, week_start)
    for em, (last, opened) in running.items():
        cfg, rule = conf.get(em) or ({}, "none")
        if rule not in ("ca", "federal") or not bool(cfg.get("otAlertOn", False)):
            continue
        if last.kind == "break_start":
            continue
        kinds = {}
        if rule == "ca" and _lead(cfg, "otAlertDailyLeadMin", DEFAULT_DAILY_LEAD) > 0:
            kinds["daily"] = _lead(cfg, "otAlertDailyLeadMin", DEFAULT_DAILY_LEAD)
        if _lead(cfg, "otAlertWeeklyLeadMin", DEFAULT_WEEKLY_LEAD) > 0:
            kinds["weekly"] = _lead(cfg, "otAlertWeeklyLeadMin", DEFAULT_WEEKLY_LEAD)
        if not kinds or not (opened.local_date or ""):
            continue
        work_date = opened.local_date
        plan[em] = (cfg, rule, kinds, last, opened, work_date, _week_start_str(work_date))
    if not plan:
        return summary

    fixed = {(r.employee_email or "").lower() for r in
             db.query(models.PayrollRate.employee_email)
             .filter(func.lower(models.PayrollRate.employee_email).in_(list(plan)),
                     models.PayrollRate.pay_type == "fixed").all()}
    people = _people(db, [em for em in plan if em not in fixed])
    plan = {em: v for em, v in plan.items() if em not in fixed and _active(people.get(em))}
    if not plan:
        return summary
    company_ids = sorted({people[em].company for em in plan if people[em].company})
    hr_contacts = ({e.id: (e.hr_contact_email or "") for e in
                    db.query(models.HrEntity).filter(models.HrEntity.id.in_(company_ids)).all()}
                   if company_ids else {})
    _recipient_people(db, people, {}, hr_contacts)
    recipients = {em: _recipients_for("", people[em], people, {}, hr_contacts) for em in plan}
    keys = {em: _keys(em, v[5], v[6]) for em, v in plan.items()}
    sent = _sent(db, [k for em in plan for k in keys[em].values()])
    week_punches = _week_punches(db, list(plan), min(v[6] for v in plan.values()))

    for em, (cfg, rule, kinds, last, opened, work_date, week_start) in plan.items():
        if _OVER_TODAY.get(em) == work_date:
            continue
        rcpts = recipients[em]
        # Thresholds not yet told to everyone who should hear them.
        todo = {k: lead for k, lead in kinds.items() if any((r, keys[em][k]) not in sent for r in rcpts)}
        if not todo:
            continue
        day_bound, week_bound = _bounds(week_punches.get(em, []), work_date, week_start, now)
        could = (("daily" in todo and day_bound >= DAY_OT_MIN - todo["daily"])
                 or ("weekly" in todo and week_bound >= WEEK_OT_MIN - todo["weekly"]))
        if not could:
            continue
        summary["checked"] += 1
        card = _compute_timecard(db, opened.employee_email, week_start, work_date, open_until=_iso(now))
        days = [d for d in (card.get("days") or []) if week_start <= (d.get("date") or "") <= work_date]
        worked = lambda d: int(d.get("regMin") or 0) + int(d.get("otMin") or 0) + int(d.get("dtMin") or 0)  # noqa: E731
        today = next((d for d in days if d.get("date") == work_date), {})
        today_min = worked(today)
        today_ot = int(today.get("otMin") or 0) + int(today.get("dtMin") or 0)
        week_straight = sum(int(d.get("regMin") or 0) for d in days)
        week_total = sum(worked(d) for d in days)
        if today_ot > 0:
            _OVER_TODAY[em] = work_date
        nxt = project(rule, today_min, today_ot, week_straight)
        if not nxt:
            continue
        kind, minutes = nxt
        if kind not in todo or not (0 < minutes <= todo[kind]):
            continue
        person = people[em]
        name = _name(person) or em
        when = _when(now, minutes, opened.tz_offset_min or 0)
        action = {**_timecard_action(db, em, work_date), "kind": "overtime_soon"}
        for r in rcpts:
            if (r, keys[em][kind]) in sent:
                continue
            upsert_rollup(db, recipient=r, key=keys[em][kind], title=f"Overtime Soon - {name}",
                          line=_body(kind, name, when, today_min, week_total, week_straight),
                          action=action, company=person.company or "", replace=True, priority=0)
            sent.add((r, keys[em][kind]))
            summary["alerts"] += 1
    db.commit()
    return summary


def _tick() -> dict:
    if job_switch.off("overtime_watch"):   # Workflows > Automations switch
        return {}
    db = SessionLocal()
    try:
        return overtime_scan(db)
    except Exception as e:   # noqa: BLE001 - a bad row must not kill the loop
        db.rollback()
        print(f"[overtime-watch] scan failed: {e}")
        return {}
    finally:
        db.close()


async def overtime_loop():
    """Started from main.py's lifespan on the elected leader, beside
    noshow_loop. The scan is synchronous DB work, so it runs in a thread;
    nothing here touches the event loop."""
    await asyncio.sleep(150)
    while True:
        s = await asyncio.to_thread(_tick)
        if s and s.get("alerts"):
            print(f"[overtime-watch] {s}")
        # A break that never ended (Oct 20 2026) rides the same tick - see
        # break_watch.py; its tick() never raises.
        import break_watch
        b = await asyncio.to_thread(break_watch.tick)
        if b and (b.get("nudged") or b.get("escalated")):
            print(f"[break-watch] {b}")
        await asyncio.sleep(SCAN_SEC)
