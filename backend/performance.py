"""Performance: goals and 1:1s (Neil, Oct 27 2026).

Kept plain on purpose - Neil: Keka's performance module confuses its users.
Everyone works it from Workday > Performance (their own goals and 1:1s; a
manager also sees their team there), HR from People > Performance (the
company's goals). routers/performance.py is the API; this file holds the
rules, so the screen, the reminders and the tests read the same ones.

WHO SEES WHAT
  Goals
    personal / department goal - its owner, the owner's manager chain (their
      manager, that manager's manager, ... - `chain`), and HR for the owner's
      company (`hr_reach`); a department goal also to everyone in that
      department of that company;
    company goal - everyone in the company, plus HR for it.
    A manager sees only their own team (the Oct 6 rule): someone outside
    their reporting line is never visible to them, whatever their role.
  1:1s - the manager and the direct report, nobody else; the manager's
    private notes are the manager's alone and never leave the server for
    anyone else.

WHO MAY CHANGE WHAT
  personal goal - created by the person for themselves, by their manager for
    a direct report, or by HR; edited / checked in by the owner, their manager
    chain or HR;
  department goal - created by HR, or by a manager for their own department
    (owned by themselves); company goal - HR only.
  A goal is never deleted, only archived; check-ins are history.

HR here ("HR++") = People write access that is not the manager tier's own-team
view: an administrator, an "hr" Access Group grant at Editor or above, or the
company's HR contact - each limited to the companies their People access
covers (auth.hr_scope).

REMINDERS (performance_loop, every 30 minutes, in a thread)
  * a 1:1 tomorrow (on the series' own clock) with nothing on its agenda -
    one notice per person per day, however many 1:1s it covers;
  * a goal with no check-in for `checkinEveryDays` (Settings > Performance,
    per company; 0 = off) - one notice per owner, rewritten in place, and each
    goal is counted at most once per period.
  Both go through notify_rollup, so they grow one notice instead of stacking.
"""
from __future__ import annotations

import asyncio
import calendar
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import scoped_settings

SETTINGS_KEY = "performance"
DEFAULTS = {"checkinEveryDays": 14, "oneOnOneReminder": True}
CHECKIN_DAYS_MAX = 90

LEVELS = ("company", "department", "personal")
MEASURES = ("percent", "number", "done")
STATUSES = ("on_track", "at_risk", "off_track", "done")
STATUS_LABELS = {"on_track": "On Track", "at_risk": "At Risk", "off_track": "Off Track", "done": "Done"}
CADENCES = ("once", "weekly", "biweekly", "monthly")
CADENCE_LABELS = {"once": "Does Not Repeat", "weekly": "Weekly", "biweekly": "Every 2 Weeks", "monthly": "Monthly"}
DEFAULT_TZ = "America/Los_Angeles"
LOOP_EVERY_SEC = 30 * 60


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return str(uuid.uuid4())


def _low(s) -> str:
    return (s or "").strip().lower()


# ── People ───────────────────────────────────────────────────────────────────

def employee(db: Session, email: str) -> Optional[models.NexusEmployee]:
    e = _low(email)
    if not e:
        return None
    return (db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.work_email) == e).first())


def name_of(db: Session, email: str) -> str:
    emp = employee(db, email)
    if emp:
        n = (emp.display_name or "").strip() or f"{emp.first_name or ''} {emp.last_name or ''}".strip()
        if n:
            return n
    return email or ""


def _active(emp) -> bool:
    return emp is not None and (emp.status or "active") not in ("inactive", "offboarded")


def chain(db: Session, email: str, limit: int = 25) -> list:
    """The person's manager, that manager's manager, ... (loop-safe).
    Remembered on the request's session - a list checks it per row."""
    key = ("perf_chain", _low(email))
    if key in db.info:
        return db.info[key]
    out, seen = [], {_low(email)}
    cur = employee(db, email)
    while cur is not None and len(out) < limit:
        mgr = _low(cur.manager_email)
        if not mgr or mgr in seen:
            break
        out.append(mgr)
        seen.add(mgr)
        cur = employee(db, mgr)
    db.info[key] = out
    return out


def is_above(db: Session, viewer: str, email: str) -> bool:
    """Is `viewer` in `email`'s manager chain?"""
    v = _low(viewer)
    return bool(v) and v != _low(email) and v in chain(db, email)


def direct_reports(db: Session, manager: str) -> list:
    m = _low(manager)
    if not m:
        return []
    rows = (db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.manager_email) == m).all())
    return [e for e in rows if _active(e) and _low(e.work_email) and _low(e.work_email) != m]


def below(db: Session, manager: str) -> list:
    """Everyone under `manager` by Reports To, all the way down (no backups:
    the same line `chain` walks up)."""
    m = _low(manager)
    rows = db.query(models.NexusEmployee).all()
    under: dict = {}
    for e in rows:
        if _active(e) and _low(e.work_email) and _low(e.manager_email):
            under.setdefault(_low(e.manager_email), []).append(e)
    out, seen, todo = [], {m}, [m]
    while todo:
        for e in under.get(todo.pop(), []):
            em = _low(e.work_email)
            if em not in seen:
                seen.add(em)
                out.append(e)
                todo.append(em)
    return out


def person_out(db: Session, emp) -> dict:
    return {"email": _low(emp.work_email), "name": name_of(db, emp.work_email),
            "title": emp.job_title or "", "department": emp.department or "",
            "company": emp.company or "", "manager": _low(emp.manager_email)}


# ── HR reach ─────────────────────────────────────────────────────────────────

def _contact_companies(db: Session, email: str) -> set:
    e = _low(email)
    return {r.id for r in db.query(models.HrEntity.id)
            .filter(func.lower(models.HrEntity.hr_contact_email) == e).all()} if e else set()


def hr_reach(db: Session, user: dict):
    """Which companies this caller is HR for here: None = every company, a set
    of company ids, or False = not HR. The manager tier's own-team People view
    is a manager here, not HR."""
    import auth
    if user.get("external"):
        return False
    me = _low(user.get("email"))
    key = ("perf_hr_reach", me, user.get("level", 0))
    if key in db.info:
        return db.info[key]
    db.info[key] = reach = _hr_reach(db, user, me, auth)
    return reach


def _hr_reach(db: Session, user: dict, me: str, auth):
    contacts = _contact_companies(db, me)
    people_write = (user.get("level", 0) >= auth._LEVELS["administrator"]
                    or auth._module_level(me, "hr", db) >= auth._MODULE_LEVEL_RANK["editor"])
    if people_write and not auth.hr_team_limited(user):
        scope = auth.hr_scope(user, db)
        if scope is None:
            return None
        return set(scope) | contacts
    return contacts or False


def hr_for(db: Session, user: dict, company_id: str) -> bool:
    reach = hr_reach(db, user)
    if reach is False:
        return False
    if reach is None:
        return True
    return bool(company_id) and company_id in reach


def hr_for_person(db: Session, user: dict, email: str) -> bool:
    emp = employee(db, email)
    return emp is not None and hr_for(db, user, emp.company or "")


def companies_out(db: Session, reach) -> list:
    rows = db.query(models.HrEntity).order_by(models.HrEntity.name).all()
    return [{"id": e.id, "name": e.name or ""} for e in rows if reach is None or e.id in reach]


def require_internal(user: dict) -> None:
    if user.get("external"):
        raise HTTPException(403, "Performance is for employees")


# ── Settings ─────────────────────────────────────────────────────────────────

def clean_settings(cfg: dict) -> dict:
    out = dict(DEFAULTS)
    try:
        out["checkinEveryDays"] = max(0, min(CHECKIN_DAYS_MAX, int(cfg.get("checkinEveryDays", DEFAULTS["checkinEveryDays"]))))
    except (TypeError, ValueError):
        out["checkinEveryDays"] = DEFAULTS["checkinEveryDays"]
    out["oneOnOneReminder"] = bool(cfg.get("oneOnOneReminder", DEFAULTS["oneOnOneReminder"]))
    return out


def settings_for_company(db: Session, company_id: str = "") -> dict:
    return clean_settings(scoped_settings.get(db, SETTINGS_KEY, DEFAULTS, company_id))


def settings_for(db: Session, email: str) -> dict:
    return settings_for_company(db, scoped_settings.company_of_email(db, email))


# ── Goals ────────────────────────────────────────────────────────────────────

def progress(g: models.PerfGoal) -> int:
    """0-100, from the measure."""
    cur = float(g.current_value or 0)
    if g.measure == "done":
        return 100 if cur >= 1 else 0
    if g.measure == "number":
        start, target = float(g.start_value or 0), float(g.target_value or 0)
        if target == start:
            return 100 if cur >= target else 0
        pct = (cur - start) / (target - start) * 100
    else:
        pct = cur
    return int(max(0, min(100, round(pct))))


def can_see_goal(db: Session, user: dict, g: models.PerfGoal, me_emp=None) -> bool:
    me = _low(user.get("email"))
    if user.get("external"):
        return False
    if _low(g.owner_email) == me or (_low(g.created_by) == me and g.level != "personal"):
        return True
    if hr_for(db, user, g.company_id or ""):
        return True
    if me_emp is None:
        me_emp = employee(db, me)
    my_company = (me_emp.company if me_emp else "") or ""
    if g.level == "company":
        return (g.company_id or "") == my_company
    if g.level == "department" and me_emp is not None and my_company == (g.company_id or "") \
            and _low(me_emp.department) and _low(me_emp.department) == _low(g.department):
        return True
    return is_above(db, me, g.owner_email)


def can_edit_goal(db: Session, user: dict, g: models.PerfGoal) -> bool:
    me = _low(user.get("email"))
    if user.get("external") or g.archived_at:
        return False
    if hr_for(db, user, g.company_id or ""):
        return True
    if g.level == "company":
        return _low(g.owner_email) == me
    return _low(g.owner_email) == me or is_above(db, me, g.owner_email)


def _would_cycle(db: Session, goal_id: str, parent_id: str) -> bool:
    cur, seen = parent_id, set()
    while cur and cur not in seen:
        if cur == goal_id:
            return True
        seen.add(cur)
        row = db.get(models.PerfGoal, cur)
        cur = row.parent_id if row else ""
    return False


def check_parent(db: Session, user: dict, goal_id: str, parent_id: str) -> str:
    pid = (parent_id or "").strip()
    if not pid:
        return ""
    p = db.get(models.PerfGoal, pid)
    if p is None or p.archived_at or not can_see_goal(db, user, p):
        raise HTTPException(400, "Pick a goal you can see to support.")
    if goal_id and _would_cycle(db, goal_id, pid):
        raise HTTPException(400, "A goal cannot support itself or a goal under it.")
    return pid


def check_create(db: Session, user: dict, level: str, owner: str, company_id: str, department: str) -> tuple:
    """Who may create which goal. Returns (owner, company_id, department) as
    stored; raises 403/400 with words a person can act on."""
    me = _low(user.get("email"))
    require_internal(user)
    if level not in LEVELS:
        raise HTTPException(400, "Pick Company, Department or Personal.")
    owner = _low(owner) or me
    owner_emp = employee(db, owner)
    if level == "company":
        cid = (company_id or "").strip() or ((owner_emp.company if owner_emp else "") or "")
        if not cid or not hr_for(db, user, cid):
            raise HTTPException(403, "Company goals are set by HR.")
        return owner, cid, ""
    if owner_emp is None:
        raise HTTPException(400, "The owner must be in Nexus People.")
    cid = owner_emp.company or ""
    if level == "department":
        dept = (department or "").strip() or (owner_emp.department or "")
        if not dept:
            raise HTTPException(400, "Pick the department.")
        # HR names the company the department belongs to (People > Performance
        # has one picked); else it is the owner's.
        picked = (company_id or "").strip()
        if picked and hr_for(db, user, picked):
            return owner, picked, dept
        if hr_for(db, user, cid):
            return owner, cid, dept
        if owner == me and direct_reports(db, me) and _low(dept) == _low(owner_emp.department):
            return owner, cid, owner_emp.department or dept
        raise HTTPException(403, "Department goals are set by HR or the department's manager, for their own department.")
    # personal
    if owner == me or hr_for(db, user, cid):
        return owner, cid, owner_emp.department or ""
    if _low(owner_emp.manager_email) == me:
        return owner, cid, owner_emp.department or ""
    raise HTTPException(403, "You can set goals for yourself and the people who report to you.")


def goal_out(db: Session, user: dict, g: models.PerfGoal, *, names: Optional[dict] = None,
             parents: Optional[dict] = None) -> dict:
    names = names if names is not None else {}
    owner = _low(g.owner_email)
    if owner not in names:
        names[owner] = name_of(db, owner)
    # The goal it supports is named only to someone who may see that goal.
    parent_title = ""
    if g.parent_id:
        p = parents.get(g.parent_id) if parents is not None else db.get(models.PerfGoal, g.parent_id)
        if p is not None and can_see_goal(db, user, p):
            parent_title = p.title
    return {
        "id": g.id, "level": g.level, "companyId": g.company_id or "", "department": g.department or "",
        "ownerEmail": owner, "ownerName": names[owner], "title": g.title, "description": g.description or "",
        "measure": g.measure, "startValue": g.start_value or 0, "targetValue": g.target_value or 0,
        "currentValue": g.current_value or 0, "unit": g.unit or "", "status": g.status,
        "statusLabel": STATUS_LABELS.get(g.status, g.status), "progress": progress(g),
        "startOn": g.start_on or "", "dueOn": g.due_on or "", "parentId": g.parent_id or "",
        "parentTitle": parent_title, "lastCheckinAt": g.last_checkin_at or "", "archived": bool(g.archived_at),
        "createdBy": g.created_by or "", "createdAt": g.created_at or "", "updatedAt": g.updated_at or "",
        "canEdit": can_edit_goal(db, user, g),
    }


def apply_checkin(db: Session, g: models.PerfGoal, by: str, value, status: str, note: str) -> models.PerfGoalCheckin:
    if status and status not in STATUSES:
        raise HTTPException(400, "Pick On Track, At Risk, Off Track or Done.")
    if value is not None:
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise HTTPException(400, "The progress must be a number.")
        if g.measure == "percent":
            value = max(0.0, min(100.0, value))
        elif g.measure == "done":
            value = 1.0 if value >= 1 else 0.0
        g.current_value = value
    if g.measure == "done" and value == 1.0:
        status = "done"     # ticking Done is the goal being done, whatever status was picked
    if status:
        g.status = status
    now = now_iso()
    g.last_checkin_at = now
    g.updated_at = now
    row = models.PerfGoalCheckin(id=new_id(), goal_id=g.id, by_email=_low(by), at=now,
                                 value=g.current_value, status=g.status, note=(note or "").strip()[:4000])
    db.add(row)
    return row


# ── 1:1 meetings: when they fall ─────────────────────────────────────────────

def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def parse_local(s: str) -> datetime:
    try:
        return datetime.strptime((s or "")[:16], "%Y-%m-%dT%H:%M")
    except ValueError:
        raise HTTPException(400, "Pick a valid date and time.")


def to_utc(local: datetime, tz: str) -> datetime:
    return local.replace(tzinfo=zone(tz)).astimezone(timezone.utc)


def utc_str(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(s: str) -> Optional[datetime]:
    try:
        return datetime.strptime((s or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _add_months(d: datetime, months: int) -> Optional[datetime]:
    """The same day of the month `months` later, or None when that month has
    no such day (Outlook's monthly series skips it too)."""
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    if d.day > calendar.monthrange(y, m)[1]:
        return None
    return d.replace(year=y, month=m)


def occurrence(s: models.PerfOneOnOne, k: int) -> Optional[datetime]:
    """The k-th meeting of the series (0 = the first) as UTC, kept at the
    same wall time on the series' clock; None for a skipped month."""
    first = parse_local(s.first_local)
    if k == 0:
        return to_utc(first, s.time_zone)
    if s.cadence == "weekly":
        local = first + timedelta(days=7 * k)
    elif s.cadence == "biweekly":
        local = first + timedelta(days=14 * k)
    elif s.cadence == "monthly":
        local = _add_months(first, k)
        if local is None:
            return None
    else:
        return None
    return to_utc(local, s.time_zone)


def next_occurrence_after(s: models.PerfOneOnOne, after: datetime, cap: int = 2000) -> Optional[datetime]:
    if s.cadence == "once":
        first = occurrence(s, 0)
        return first if first and first > after else None
    for k in range(cap):
        at = occurrence(s, k)
        if at is not None and at > after:
            return at
    return None


def graph_recurrence(s: models.PerfOneOnOne) -> Optional[dict]:
    """Graph's patternedRecurrence for the series - on its own clock."""
    if s.cadence == "once":
        return None
    first = parse_local(s.first_local)
    start = first.strftime("%Y-%m-%d")
    if s.cadence == "monthly":
        pattern = {"type": "absoluteMonthly", "interval": 1, "dayOfMonth": first.day}
    else:
        pattern = {"type": "weekly", "interval": 2 if s.cadence == "biweekly" else 1,
                   "daysOfWeek": [first.strftime("%A").lower()], "firstDayOfWeek": "sunday"}
    return {"pattern": pattern, "range": {"type": "noEnd", "startDate": start}}


def ensure_upcoming(db: Session, s: models.PerfOneOnOne, now: Optional[datetime] = None) -> Optional[models.PerfMeeting]:
    """Keep one meeting row ahead: when no scheduled meeting is still to come
    (or under way), make the next one. Past meetings stay as history; a
    meeting nobody opened while the series was idle is not back-filled."""
    if s.status != "active" or s.cadence == "once" or not pair_current(db, s):
        return None
    now = now or datetime.now(timezone.utc)
    # Serialize two requests (or the loop) making the same next meeting: the
    # series row is locked before its meetings are read (a no-op on SQLite).
    db.query(models.PerfOneOnOne.id).filter(models.PerfOneOnOne.id == s.id).with_for_update().first()
    rows = db.query(models.PerfMeeting).filter(models.PerfMeeting.series_id == s.id).all()
    rows += [o for o in db.new if isinstance(o, models.PerfMeeting) and o.series_id == s.id and o not in rows]
    live_from = now - timedelta(minutes=int(s.duration_min or 30))
    for m in rows:
        at = parse_utc(m.at)
        if at and at >= live_from and m.status == "scheduled":
            return None
    latest = max((parse_utc(m.at) for m in rows if parse_utc(m.at)), default=None)
    after = max(live_from, latest) if latest else live_from
    nxt = next_occurrence_after(s, after)
    if nxt is None:
        return None
    m = models.PerfMeeting(id=new_id(), series_id=s.id, at=utc_str(nxt), status="scheduled", created_at=now_iso())
    db.add(m)
    return m


def local_label(at_utc: str, tz: str) -> str:
    """MM/DD/YYYY at 9:30 AM on the series' clock."""
    dt = parse_utc(at_utc)
    if not dt:
        return ""
    loc = dt.astimezone(zone(tz))
    return f"{loc.strftime('%m/%d/%Y')} at {loc.strftime('%I:%M %p').lstrip('0')} {loc.strftime('%Z')}".rstrip()


def pair_current(db: Session, s: models.PerfOneOnOne) -> bool:
    """Is this still a manager and their direct report, both still here? A
    1:1 whose report moved to another manager (or either person left) stops
    making meetings and reminders and becomes read-only history."""
    key = ("perf_pair", s.id)
    if key in db.info:
        return db.info[key]
    rep_emp, mgr_emp = employee(db, s.report_email), employee(db, s.manager_email)
    ok = _active(rep_emp) and _active(mgr_emp) and _low(rep_emp.manager_email) == _low(s.manager_email)
    db.info[key] = ok
    return ok


def require_live(db: Session, s: models.PerfOneOnOne) -> None:
    if s.status != "active" or not pair_current(db, s):
        raise HTTPException(409, "This 1:1 is history now - it can be read, not changed.")


def series_side(s: models.PerfOneOnOne, email: str) -> str:
    e = _low(email)
    if e == _low(s.manager_email):
        return "manager"
    if e == _low(s.report_email):
        return "report"
    return ""


def require_side(s: Optional[models.PerfOneOnOne], user: dict) -> str:
    """A 1:1 is the two people's only - anyone else gets a 404."""
    side = series_side(s, user.get("email")) if s is not None else ""
    if not side or user.get("external"):
        raise HTTPException(404, "1:1 not found")
    return side


# ── Reminders ────────────────────────────────────────────────────────────────

def _remind_agendas(db: Session, now: datetime) -> int:
    """A 1:1 tomorrow with an empty agenda: one notice per person per day."""
    import notify_rollup
    soon = (now + timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = (db.query(models.PerfMeeting)
            .filter(models.PerfMeeting.status == "scheduled", models.PerfMeeting.at > utc_str(now),
                    models.PerfMeeting.at <= soon, models.PerfMeeting.agenda_nudged_at == "").all())
    sent = 0
    for m in rows:
        s = db.get(models.PerfOneOnOne, m.series_id)
        if s is None or s.status != "active" or not pair_current(db, s):
            continue
        z = zone(s.time_zone)
        at = parse_utc(m.at)
        if at is None or at.astimezone(z).date() != (now.astimezone(z) + timedelta(days=1)).date():
            continue
        if not settings_for_company(db, s.company_id or "")["oneOnOneReminder"]:
            continue
        has = db.query(models.PerfAgendaItem.id).filter(models.PerfAgendaItem.meeting_id == m.id).first()
        m.agenda_nudged_at = now_iso()
        if has:
            continue
        day = at.astimezone(z).date().isoformat()
        when = local_label(m.at, s.time_zone)
        for me, other in ((s.manager_email, s.report_email), (s.report_email, s.manager_email)):
            notify_rollup.upsert_rollup(
                db, recipient=me, key=f"perf-1on1-agenda:{day}", title="Add to Your 1:1 Agenda",
                line=f"Your 1:1 with {name_of(db, other)} is tomorrow ({when}) and the agenda is empty.",
                action={"view": "myhr", "sub": f"performance:1on1:{s.id}"},
                company=s.company_id or "")
            sent += 1
    return sent


def _remind_checkins(db: Session, now: datetime) -> int:
    """Goals with no check-in for the company's period: one notice per owner,
    rewritten in place, each goal counted at most once per period."""
    import notify_rollup
    rows = (db.query(models.PerfGoal)
            .filter(models.PerfGoal.archived_at == "", models.PerfGoal.status != "done").all())
    by_owner: dict = {}
    for g in rows:
        owner = _low(g.owner_email)
        if not owner:
            continue
        days = settings_for_company(db, g.company_id or "")["checkinEveryDays"]
        if days <= 0:
            continue
        cutoff = now - timedelta(days=days)
        last = _parse_any(g.last_checkin_at) or _parse_any(g.created_at)
        nudged = _parse_any(g.checkin_nudged_at)
        if last is None or last > cutoff or (nudged is not None and nudged > cutoff):
            continue
        g.checkin_nudged_at = now_iso()
        by_owner.setdefault(owner, []).append((g, days))
    for owner, items in by_owner.items():
        titles = ", ".join(g.title for g, _ in items[:4]) + (f" and {len(items) - 4} more" if len(items) > 4 else "")
        days = items[0][1]
        notify_rollup.upsert_rollup(
            db, recipient=owner, key="perf-goal-checkin", title="Goal Check-In Due",
            line=(f"{len(items)} {'goal has' if len(items) == 1 else 'goals have'} had no check-in for "
                  f"{days} days: {titles}."),
            action={"view": "myhr", "sub": "performance"}, replace=True,
            company=(items[0][0].company_id or ""))
    return len(by_owner)


def _parse_any(s: str) -> Optional[datetime]:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def reminders_pass(now: Optional[datetime] = None) -> dict:
    """One pass of the loop: keep the next meeting of every recurring 1:1,
    then the two reminders. Its own session; sync - run it in a thread."""
    from database import SessionLocal
    now = now or datetime.now(timezone.utc)
    db = SessionLocal()
    try:
        for s in db.query(models.PerfOneOnOne).filter(models.PerfOneOnOne.status == "active").all():
            ensure_upcoming(db, s, now)
        db.flush()
        out = {"agendas": _remind_agendas(db, now), "checkins": _remind_checkins(db, now)}
        db.commit()
        return out
    finally:
        db.close()


async def performance_loop():
    """Started from main.py's lifespan. Blocking work goes to a thread - never
    on the event loop (CLAUDE.md)."""
    await asyncio.sleep(120)
    while True:
        try:
            await asyncio.to_thread(reminders_pass)
        except Exception as e:   # noqa: BLE001 - the loop must survive a bad pass
            print(f"[performance] reminders pass failed: {type(e).__name__}: {e}")
        await asyncio.sleep(LOOP_EVERY_SEC)
