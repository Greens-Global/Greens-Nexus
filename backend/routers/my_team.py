"""My Team (Essentials, Oct 7) - a supervisor's team today (clocked in / out /
on leave / late) and what of theirs is overdue, for the My Team dashboard
tile (minRole 'supervisor' in widgets.jsx).

Gating: `require_level(2)` - supervisor and up, the same level the dashboards
router's `scope=team` KPIs unlock on (`user["level"] >= 2`).

Who is "my team" (the one rule for both endpoints, `team_members`):
  - supervisor (level 2): their DIRECT reports - `nexus_employees.manager_email`
    == them, the same lookup the Daily Briefing (`daily_briefing.build_sections`)
    and the dashboards' time_off_pending use;
  - manager and up (level 3+): everyone below them in the reporting line, all
    the way down - `auth.team_emails`, the tree People shows the manager tier.
  Deleted and offboarded people are left out, and when the multi-company walls
  are armed the team is cut to the caller's `company_scope`, the same way every
  other module intersects it (an untagged person is then hidden, as elsewhere).

Today's buckets (`/me/team/today`), one person in exactly ONE of them,
in beats late beats onLeave beats out:
  in      - an open shift right now: the last non-voided punch is a clock-in or
            a break inside the 16-hour pairing guard (timeclock._clocked_in_now's
            rule, read for the whole team in one query);
  late    - a shift scheduled for today (a PUBLISHED scheduled_shifts row, else
            the person's default preset on one of its days - what
            /timeclock/my-schedule shows them) whose start plus the 15-minute
            grace has passed, and no clock-in on today's date yet. Someone on
            approved leave or a company holiday is never late - a default
            preset recurs every week, so without this every vacation day
            would read as a missed shift;
  onLeave - approved time off covering today (daily_briefing._approved_leave's
            filter), or a company holiday for them (timeclock's company +
            country rule, `_company_holidays_for_many`);
  out     - everyone else.
`scheduleAvailable` says whether anyone on the team has a shift to be late
for at all; the tile hides its Late tile when nobody does.

Overdue (`/me/team/overdue`): open tasks assigned to a team member due before
today (the weekly digest's rule: completed == False, dated, not a section, not
deleted, `task_assignees` for the match) and tickets assigned to them past
their SLA date (tickets._sla_breached), one row per person, worst first.

Every query is cut to the team's emails (IN filters); the task match is done
in Python because assignee_emails is a JSON list with no containment
predicate that works on both SQLite and Postgres (same as weekly_digest).
"""
from datetime import datetime, timezone, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from auth import require_level, team_emails, company_scope, company_ok
from database import get_db
from routers.task_util import task_assignees

router = APIRouter(prefix="", tags=["My Team"])

require_supervisor = require_level(2)

GRACE_MIN = 15          # a shift start this many minutes gone with no clock-in = late
OVERDUE_CAP = 20
_MAX_SHIFT_MIN = 16 * 60   # timeclock's pairing guard: an older open punch is a missing clock-out, not "in"
_DEFAULT_TEAM_TZ = "America/Los_Angeles"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    """Punch-table shape: UTC, second precision, no zone marker."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")


def _iso_z(s: str) -> str:
    """A punch stamp for the browser: UTC made explicit so Date.parse reads it right."""
    s = (s or "")[:19]
    return f"{s}Z" if s else ""


def _parse(s: str) -> Optional[datetime]:
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or _DEFAULT_TEAM_TZ)
    except Exception:
        return ZoneInfo(_DEFAULT_TEAM_TZ)


def _team_tz(db: Session) -> str:
    """The team time zone from the shift settings (Teams "Team time zone"),
    the zone a shift with no preset runs on."""
    try:
        from routers.shift_requests import get_settings
        return get_settings(db).get("timeZone") or _DEFAULT_TEAM_TZ
    except Exception:
        return _DEFAULT_TEAM_TZ


def _local_today(db: Session, now: datetime, tz_offset_min: Optional[int]) -> str:
    """The caller's calendar date. With the browser's getTimezoneOffset it is
    exact (UTC - offset, as timeclock._local_date); without it, the team time
    zone's date - the tile's api call carries no offset."""
    if tz_offset_min is not None:
        return (now - timedelta(minutes=int(tz_offset_min))).strftime("%Y-%m-%d")
    return now.astimezone(_zone(_team_tz(db))).strftime("%Y-%m-%d")


def _name(e: models.NexusEmployee) -> str:
    return ((e.display_name or "").strip()
            or f"{e.first_name or ''} {e.last_name or ''}".strip()
            or (e.work_email or ""))


def team_members(db: Session, user: dict) -> dict:
    """{email(lower): NexusEmployee} for the caller's team - direct reports for
    a supervisor, the whole reporting tree for a manager and up. The caller is
    never in it."""
    me = (user.get("email") or "").lower()
    if int(user.get("level", 0)) >= 3:
        emails = set(team_emails(db, me))
    else:
        emails = {(r.work_email or "").lower() for r in
                  db.query(models.NexusEmployee.work_email)
                  .filter(func.lower(models.NexusEmployee.manager_email) == me).all()
                  if r.work_email}
    emails.discard(me)
    if not emails:
        return {}
    rows = (db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.work_email).in_(sorted(emails))).all())
    scope = company_scope(user, db)
    out = {}
    for e in rows:
        em = (e.work_email or "").lower()
        if not em or (e.deleted_at or "") or (e.status or "") == "offboarded":
            continue
        if scope is not None and not company_ok(e.company or "", scope):
            continue
        out[em] = e
    return out


def _open_shifts(db: Session, emails: list, now: datetime) -> dict:
    """{email: clock-in UTC stamp} for everyone whose last non-voided punch is
    a clock-in or a break inside the pairing guard (timeclock._clocked_in_now),
    from one read of the team's recent punches. A punch older than the guard
    cannot be an open shift, so the window is the guard plus a day of slack
    for the clock-in behind an overnight break punch."""
    since = _iso(now - timedelta(minutes=_MAX_SHIFT_MIN) - timedelta(days=1))
    rows = (db.query(models.TimePunch)
            .filter(models.TimePunch.employee_email.in_(emails),
                    models.TimePunch.voided == 0,
                    models.TimePunch.at >= since,
                    models.TimePunch.at <= _iso(now + timedelta(minutes=5)))
            .order_by(models.TimePunch.at, models.TimePunch.created_at).all())
    by_person: dict = {}
    for p in rows:
        by_person.setdefault((p.employee_email or "").lower(), []).append(p)
    out = {}
    for em, punches in by_person.items():
        last = punches[-1]
        if last.kind == "out":
            continue
        t = _parse(last.at)
        if not t or (now - t).total_seconds() > _MAX_SHIFT_MIN * 60:
            continue   # stale open shift - the timesheet already shows it as Missing
        opened = next((p for p in reversed(punches) if p.kind == "in"), last)
        out[em] = {"since": _iso_z(opened.at), "onBreak": last.kind == "break_start"}
    return out


def _punched_in_today(db: Session, emails: list, today: str) -> dict:
    """{email: first clock-in stamp today} - who has already started (or started
    and finished) a shift dated today."""
    rows = (db.query(models.TimePunch)
            .filter(models.TimePunch.employee_email.in_(emails),
                    models.TimePunch.voided == 0,
                    models.TimePunch.local_date == today)
            .order_by(models.TimePunch.at).all())
    first_in, last_out = {}, {}
    for p in rows:
        em = (p.employee_email or "").lower()
        if p.kind == "in":
            first_in.setdefault(em, p.at)
        elif p.kind == "out":
            last_out[em] = p.at
    return {"in": first_in, "out": last_out}


def _leave_today(db: Session, emails: list, today: str) -> dict:
    """{email: {since, detail, until}} for approved time off covering today."""
    rows = (db.query(models.TimeOffRequest)
            .filter(func.lower(models.TimeOffRequest.employee_email).in_(emails),
                    models.TimeOffRequest.status == "approved",
                    models.TimeOffRequest.start_date <= today,
                    models.TimeOffRequest.end_date >= today).all())
    out = {}
    for r in sorted(rows, key=lambda r: (r.start_date or "", r.id or "")):
        em = (r.employee_email or "").lower()
        if em in out:
            continue
        kind = (r.type or "").replace("_", " ").strip()
        label = "Time off" if getattr(r, "confidential", 0) or not kind else kind[:1].upper() + kind[1:]
        out[em] = {"since": r.start_date or today, "until": r.end_date or today, "detail": label}
    return out


def _holidays_today(db: Session, people: dict, today: str) -> dict:
    """{email: holiday name} for everyone whose company calendar has today as
    a holiday that applies to their country (timeclock's rule)."""
    from routers.timeclock import _company_holidays_for_many
    out = {}
    for em, days in _company_holidays_for_many(db, people, today, today).items():
        h = days.get(today)
        if h and (h.get("type") or "mandatory") != "optional":
            out[em] = h.get("name") or "Company holiday"
    return out


def _shift_starts(db: Session, emails: list, today: str, team_tz: str) -> dict:
    """{email: shift start (UTC datetime)} for everyone scheduled today: a
    PUBLISHED placed shift first, else the default preset on one of its days -
    the same two sources /timeclock/my-schedule shows a person."""
    presets = {s.id: s for s in db.query(models.Shift).all()}
    out = {}

    def start_at(hhmm: str, tz: str):
        try:
            y, m, d = (int(x) for x in today.split("-"))
            hh, mm = (int(x) for x in (hhmm or "09:00").split(":")[:2])
            return datetime(y, m, d, hh, mm, tzinfo=_zone(tz)).astimezone(timezone.utc)
        except (ValueError, TypeError):
            return None

    placed = (db.query(models.ScheduledShift)
              .filter(models.ScheduledShift.employee_email.in_(emails),
                      models.ScheduledShift.work_date == today,
                      models.ScheduledShift.published == 1)
              .order_by(models.ScheduledShift.start_hhmm).all())
    for r in placed:
        em = (r.employee_email or "").lower()
        if em in out:
            continue
        p = presets.get(r.shift_id)
        tz = ((getattr(r, "timezone", "") or "").strip()
              or ((p.timezone or "") if p is not None else "") or team_tz)
        t = start_at(r.start_hhmm, tz)
        if t:
            out[em] = t
    weekday = str(datetime.strptime(today, "%Y-%m-%d").isoweekday())
    assigned = False
    for a in (db.query(models.ShiftAssignment)
              .filter(models.ShiftAssignment.employee_email.in_(emails)).all()):
        em = (a.employee_email or "").lower()
        p = presets.get(a.shift_id)
        if p is None:
            continue
        assigned = True
        if em in out:
            continue
        days = {d.strip() for d in (p.days or "").split(",") if d.strip()}
        if weekday not in days:
            continue
        t = start_at(p.start_hhmm, p.timezone or team_tz)
        if t:
            out[em] = t
    return {"starts": out, "available": bool(out) or assigned or bool(placed)}


def _person(e: models.NexusEmployee, since: str = "", detail: str = "", **extra) -> dict:
    row = {"email": (e.work_email or "").lower(), "name": _name(e), "since": since or "", "detail": detail or ""}
    row.update(extra)
    return row


@router.get("/me/team/today")
def my_team_today(tz_offset_min: Optional[int] = None,
                  user: dict = Depends(require_supervisor), db: Session = Depends(get_db)):
    now = _utcnow()
    today = _local_today(db, now, tz_offset_min)
    people = team_members(db, user)
    emails = sorted(people)
    out = {"in": [], "out": [], "onLeave": [], "late": [], "scheduleAvailable": False,
           "date": today, "at": _iso_z(_iso(now))}
    if emails:
        open_now = _open_shifts(db, emails, now)
        today_punches = _punched_in_today(db, emails, today)
        leave = _leave_today(db, emails, today)
        holidays = _holidays_today(db, people, today)
        sched = _shift_starts(db, emails, today, _team_tz(db))
        out["scheduleAvailable"] = sched["available"]
        cutoff = now - timedelta(minutes=GRACE_MIN)
        for em in emails:
            e = people[em]
            if em in open_now:
                out["in"].append(_person(e, open_now[em]["since"],
                                         "On break" if open_now[em]["onBreak"] else "Clocked in",
                                         onBreak=open_now[em]["onBreak"]))
                continue
            start = sched["starts"].get(em)
            if start is not None and start <= cutoff and em not in today_punches["in"] \
                    and em not in leave and em not in holidays:
                out["late"].append(_person(e, _iso_z(_iso(start)), "Scheduled, not clocked in"))
                continue
            if em in leave:
                out["onLeave"].append(_person(e, leave[em]["since"], leave[em]["detail"], until=leave[em]["until"]))
                continue
            if em in holidays:
                out["onLeave"].append(_person(e, today, holidays[em], until=today))
                continue
            last_out = today_punches["out"].get(em, "")
            if last_out:
                out["out"].append(_person(e, _iso_z(last_out), "Clocked out"))
            elif start is not None:
                out["out"].append(_person(e, _iso_z(_iso(start)), "Shift later today"))
            else:
                out["out"].append(_person(e, "", "Not clocked in"))
        for key in ("in", "late", "onLeave", "out"):
            out[key].sort(key=lambda r: (r["name"].lower(), r["email"]))
    out["counts"] = {k: len(out[k]) for k in ("in", "out", "onLeave", "late")}
    return out


def _overdue_tasks(db: Session, emails: set, today: str) -> dict:
    """{email: [(due_on, task)]} - open, dated, live tasks due before today
    with a team member on them (weekly_digest._open_dated_tasks' filter)."""
    rows = (db.query(models.Task)
            .filter(models.Task.completed == False,  # noqa: E712
                    models.Task.due_on != "",
                    models.Task.due_on < today,
                    models.Task.type != "section",
                    (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None))).all())
    out: dict = {}
    for t in rows:
        due = (t.due_on or "")[:10]
        if len(due) != 10:
            continue
        for em in set(task_assignees(t)) & emails:
            out.setdefault(em, []).append((due, t))
    return out


def _breached_tickets(db: Session, emails: list, today: str) -> dict:
    """{email: [(sla_due_on, ticket)]} - open tickets assigned to a team member
    whose SLA date has passed (tickets._sla_breached)."""
    from routers.tickets import _sla_breached
    rows = (db.query(models.TaskTicket)
            .filter(func.lower(models.TaskTicket.assignee_email).in_(emails),
                    models.TaskTicket.status.notin_(["resolved", "closed"]),
                    models.TaskTicket.sla_due_on != "",
                    models.TaskTicket.sla_due_on < today,
                    (models.TaskTicket.deleted_at == "") | (models.TaskTicket.deleted_at.is_(None))).all())
    out: dict = {}
    for t in rows:
        if _sla_breached(t):
            out.setdefault((t.assignee_email or "").lower(), []).append(((t.sla_due_on or "")[:10], t))
    return out


@router.get("/me/team/overdue")
def my_team_overdue(tz_offset_min: Optional[int] = None,
                    user: dict = Depends(require_supervisor), db: Session = Depends(get_db)):
    now = _utcnow()
    today = _local_today(db, now, tz_offset_min)
    people = team_members(db, user)
    if not people:
        return {"people": [], "date": today}
    emails = sorted(people)
    tasks = _overdue_tasks(db, set(emails), today)
    tickets = _breached_tickets(db, emails, today)
    rows = []
    for em in emails:
        ts, tk = tasks.get(em, []), tickets.get(em, [])
        if not ts and not tk:
            continue
        items = ([(d, "task", t.id, t.code or "", t.title or "") for d, t in ts]
                 + [(d, "ticket", t.id, t.code or "", t.subject or "") for d, t in tk])
        items.sort(key=lambda x: (x[0], x[4].lower()))
        d, kind, iid, code, title = items[0]
        rows.append({"email": em, "name": _name(people[em]),
                     "overdueTasks": len(ts), "breachedTickets": len(tk),
                     "worst": {"kind": kind, "id": iid, "code": code, "title": title, "dueOn": d}})
    # Worst first: the most items behind, then the longest-overdue worst item.
    rows.sort(key=lambda r: (-(r["overdueTasks"] + r["breachedTickets"]), r["worst"]["dueOn"], r["name"].lower()))
    return {"people": rows[:OVERDUE_CAP], "total": len(rows), "date": today}
