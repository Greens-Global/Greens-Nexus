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

HR here ("HR++") is the one HR rule every HR module uses (timesheet_review
.is_hr - time sheets, time off's second approval, salary advances, letters,
probation, exits): an administrator or owner, a FULL "hr" Access Group grant,
or the company's HR contact (Neil, Oct 27 2026 - an Editor grant is not HR).
An administrator or a Full grant is limited to the companies their People
access covers (auth.hr_scope); an HR contact to their own companies. The
manager tier's own-team People view is a manager here, not HR.

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
import job_switch

SETTINGS_KEY = "performance"
DEFAULTS = {"checkinEveryDays": 14, "oneOnOneReminder": True}
CHECKIN_DAYS_MAX = 90

LEVELS = ("company", "department", "personal")
MEASURES = ("percent", "number", "done")
# Status is COMPUTED (Oct 29 2026, docs/superpowers/specs/2026-10-29-
# performance-simple-design.md): Done when the target is met, else On Track /
# At Risk / Behind from progress against the time gone in the goal's period;
# No Data Yet for a Nexus-measured goal whose number does not apply yet. The
# hand-picked status of the first build is ignored ("off_track" reads as Behind).
STATUSES = ("on_track", "at_risk", "behind", "done", "no_data")
STATUS_LABELS = {"on_track": "On Track", "at_risk": "At Risk", "behind": "Behind", "done": "Done",
                 "no_data": "No Data Yet", "off_track": "Behind"}
MAX_OPEN_GOALS = 5
DEFAULT_PERIOD_MONTHS = 6
REFRESH_HOURS = 6            # how often the loop re-reads a Nexus-measured goal
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
    # The same three doors as timesheet_review.is_hr: administrator / owner,
    # a Full HR grant, the company's HR contact.
    contacts = _contact_companies(db, me)
    people_write = (user.get("level", 0) >= auth._LEVELS["administrator"]
                    or auth._module_level(me, "hr", db) >= auth._MODULE_LEVEL_RANK["full"])
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


def can_see_person(db: Session, user: dict, email: str) -> bool:
    """A person's numbers, goals and reviews: the person, their reporting
    chain, HR for their company - never a peer."""
    me, who = _low(user.get("email")), _low(email)
    if user.get("external") or not who:
        return False
    return who == me or is_above(db, me, who) or hr_for_person(db, user, who)


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

def _metric_def(g):
    """The Nexus number a goal is measured by - PERSONAL goals only: a
    company or department goal is read by the whole company or department,
    and would publish its owner's own numbers to them (a stray key on one is
    ignored here, so no read can ever show it)."""
    import perf_metrics
    if not getattr(g, "metric_key", "") or (g.level or "personal") != "personal":
        return None
    return perf_metrics.METRICS.get(g.metric_key or "")


def progress(g: models.PerfGoal) -> int:
    """0-100, from the measure (a Nexus-measured goal: its number against the
    target - for a 'less is better' number, 100 while it is within target)."""
    cur = float(g.current_value or 0)
    md = _metric_def(g)
    if md is not None:
        target = float(g.target_value or 0)
        if md[2] == "low":
            return 100 if cur <= target else 0
        if target <= 0:
            return 100
        return int(max(0, min(100, round(cur / target * 100))))
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


def local_today() -> str:
    return datetime.now(timezone.utc).astimezone(zone(DEFAULT_TZ)).strftime("%Y-%m-%d")


def goal_period(g: models.PerfGoal) -> tuple:
    """(start, end) of the goal's period, ISO; end '' = open-ended."""
    start = (g.period_start or g.start_on or (g.created_at or "")[:10] or local_today())[:10]
    end = (g.period_end or g.due_on or "")[:10]
    return start, end


MEASURED_MAX_DAYS = 396     # a measured goal reads at most 13 months (every week is a scorecard pass)


def measured_window(g: models.PerfGoal, today: Optional[str] = None) -> tuple:
    """The span a Nexus-measured goal's number is read over: its period, up
    to today, never more than the last 13 months of it."""
    from datetime import date as _d
    today = today or local_today()
    start, end = goal_period(g)
    end = min(end or today, today) if end else today
    floor = (_d.fromisoformat(end) - timedelta(days=MEASURED_MAX_DAYS)).isoformat()
    return max(start, floor) if start else floor, end


def _elapsed(start: str, end: str, today: str) -> Optional[float]:
    """Share of the period gone, 0..1 (None when it has no end)."""
    if not end:
        return None
    from datetime import date as _d
    try:
        d0, d1, t = _d.fromisoformat(start), _d.fromisoformat(end), _d.fromisoformat(today)
    except ValueError:
        return None
    span = (d1 - d0).days or 1
    return max(0.0, min(1.0, (t - d0).days / span))


def refresh_metric(db: Session, g: models.PerfGoal, today: Optional[str] = None) -> bool:
    """A Nexus-measured goal's number for its period, read from the person's
    scorecard (perf_metrics.metric - the one calculation). Sets
    current_value; returns whether the number applies to them at all."""
    if _metric_def(g) is None:
        return True
    import perf_metrics
    from datetime import date as _d
    today = today or local_today()
    start, end = measured_window(g, today)
    try:
        m = perf_metrics.metric(db, g.owner_email, g.metric_key, start, end, today=_d.fromisoformat(today))
    except (KeyError, ValueError):
        return False
    if not m.get("available"):
        return False
    g.current_value = float(m["value"] or 0)
    return True


def computed_status(g: models.PerfGoal, today: Optional[str] = None, applies: bool = True) -> str:
    today = today or local_today()
    md = _metric_def(g)
    if md is not None and not applies:
        return "no_data"
    start, end = goal_period(g)
    ended = bool(end) and today > end
    if md is not None and (md[3] in ("rate", "now") or md[2] == "low"):
        # A rate, a point-in-time number or a "less is better" count is
        # judged as it stands; it is Done only once the period is over with
        # the target met.
        target = float(g.target_value or 0)
        cur = float(g.current_value or 0)
        met = cur <= target if md[2] == "low" else cur >= target
        if met:
            return "done" if ended else "on_track"
        if md[2] == "low" or ended:
            return "behind"
        return "at_risk" if target and cur >= 0.9 * target else "behind"
    p = progress(g)
    if p >= 100:
        return "done"
    share = _elapsed(start, end, today)
    if share is None:
        return "on_track"
    if ended:
        return "behind"
    expected = share * 100
    if p >= expected:
        return "on_track"
    return "at_risk" if p >= 0.7 * expected else "behind"


def is_open(g: models.PerfGoal, today: Optional[str] = None) -> bool:
    """Counts toward the 5-goal cap: not archived, not Done, period not over."""
    today = today or local_today()
    _s, end = goal_period(g)
    if g.archived_at or (end and end < today):
        return False
    return computed_status(g, today) != "done"


def open_goal_count(db: Session, owner: str, exclude_id: str = "") -> int:
    rows = (db.query(models.PerfGoal).filter(models.PerfGoal.owner_email == _low(owner),
                                             models.PerfGoal.level == "personal",
                                             models.PerfGoal.archived_at == "").all())
    today = local_today()
    return sum(1 for g in rows if g.id != exclude_id and is_open(g, today))


def needs_approval(db: Session, creator: str, owner: str, level: str) -> bool:
    """An employee's own personal goal waits for their manager (or HR) to
    approve it; one the manager or HR sets is agreed at once, and so is one
    for someone with no manager."""
    if level != "personal" or _low(creator) != _low(owner):
        return False
    emp = employee(db, owner)
    return bool(emp is not None and _low(emp.manager_email) and _low(emp.manager_email) != _low(owner))


def can_approve_goal(db: Session, user: dict, g: models.PerfGoal) -> bool:
    me = _low(user.get("email"))
    if user.get("external") or g.archived_at or g.approved_at or g.level != "personal":
        return False
    if me == _low(g.owner_email):
        return False
    return is_direct_manager(db, me, g.owner_email) or hr_for(db, user, g.company_id or "")


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


def is_direct_manager(db: Session, viewer: str, email: str) -> bool:
    emp = employee(db, email)
    v = _low(viewer)
    return bool(v) and emp is not None and _low(emp.manager_email) == v and v != _low(email)


def can_edit_goal(db: Session, user: dict, g: models.PerfGoal) -> bool:
    """The owner, their DIRECT manager and HR change a goal; anyone higher
    up the chain reads it (Oct 29 2026 spec: the manager's manager reads)."""
    return not g.archived_at and may_change_goal(db, user, g)


def may_change_goal(db: Session, user: dict, g: models.PerfGoal) -> bool:
    """can_edit_goal's who, archived or not (Restore asks this)."""
    me = _low(user.get("email"))
    if user.get("external"):
        return False
    if hr_for(db, user, g.company_id or ""):
        return True
    if g.level == "company":
        return _low(g.owner_email) == me
    return _low(g.owner_email) == me or is_direct_manager(db, me, g.owner_email)


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
             parents: Optional[dict] = None, today: Optional[str] = None) -> dict:
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
    today = today or local_today()
    applies = refresh_metric(db, g, today)
    status = computed_status(g, today, applies)
    md = _metric_def(g)
    start, end = goal_period(g)
    can_edit = can_edit_goal(db, user, g)
    return {
        "id": g.id, "level": g.level, "companyId": g.company_id or "", "department": g.department or "",
        "ownerEmail": owner, "ownerName": names[owner], "title": g.title, "description": g.description or "",
        "measure": g.measure, "startValue": g.start_value or 0, "targetValue": g.target_value or 0,
        "currentValue": g.current_value or 0, "unit": (md[1] if md else g.unit) or "", "status": status,
        "statusLabel": STATUS_LABELS.get(status, status), "progress": progress(g),
        "metricKey": (g.metric_key or "") if md else "", "metricLabel": md[0] if md else "", "metricGood": md[2] if md else "high",
        "measuredByNexus": md is not None, "periodStart": start, "periodEnd": end,
        "startOn": g.start_on or "", "dueOn": g.due_on or end, "parentId": g.parent_id or "",
        "parentTitle": parent_title, "lastCheckinAt": g.last_checkin_at or "", "archived": bool(g.archived_at),
        "proposed": g.level == "personal" and not (g.approved_at or ""),
        "approvedAt": g.approved_at or "", "approvedBy": g.approved_by or "",
        "createdBy": g.created_by or "", "createdAt": g.created_at or "", "updatedAt": g.updated_at or "",
        "canEdit": can_edit, "canCheckIn": can_edit and md is None, "canApprove": can_approve_goal(db, user, g),
        "canRestore": bool(g.archived_at) and may_change_goal(db, user, g),
    }


def apply_checkin(db: Session, g: models.PerfGoal, by: str, value, status: str, note: str) -> models.PerfGoalCheckin:
    """A by-hand goal's new number and a note. The status is worked out from
    the number (computed_status) - a status a caller sends is ignored. A
    Nexus-measured goal has no check-ins: its number comes in by itself."""
    if getattr(g, "metric_key", ""):
        raise HTTPException(400, "This goal is measured by Nexus - its number updates by itself.")
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
    g.status = computed_status(g)
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
            .filter(models.PerfGoal.archived_at == "", models.PerfGoal.metric_key == "").all())
    today = local_today()
    by_owner: dict = {}
    for g in rows:
        owner = _low(g.owner_email)
        if not owner or not is_open(g, today):
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


def refresh_measured_goals(db: Session, now: Optional[datetime] = None) -> int:
    """Keep the stored number and status of every live Nexus-measured goal
    current (the screens compute them on read; this is what lists, counts and
    exports see between reads). Every few hours per goal is plenty."""
    today = local_today()
    now = now or datetime.now(timezone.utc)
    rows = (db.query(models.PerfGoal)
            .filter(models.PerfGoal.archived_at == "", models.PerfGoal.metric_key != "",
                    models.PerfGoal.level == "personal").all())
    n = 0
    for g in rows:
        last = _parse_any(g.updated_at)
        if last is not None and now - last < timedelta(hours=REFRESH_HOURS):
            continue
        _s, end = goal_period(g)
        if end and end < today and g.status in ("done", "behind"):
            continue
        applies = refresh_metric(db, g, today)
        g.status = computed_status(g, today, applies)
        g.updated_at = now_iso()
        n += 1
    return n


def reminders_pass(now: Optional[datetime] = None) -> dict:
    """One pass of the loop: keep the next meeting of every recurring 1:1,
    the two reminders, the Nexus-measured goals' numbers, and the review
    cycles' members and automatic reminders (perf_reviews.loop_pass). Its own
    session; sync - run it in a thread."""
    if job_switch.off("performance"):   # Workflows > Automations switch
        return {}
    from database import SessionLocal
    import perf_reviews
    now = now or datetime.now(timezone.utc)
    db = SessionLocal()
    try:
        for s in db.query(models.PerfOneOnOne).filter(models.PerfOneOnOne.status == "active").all():
            ensure_upcoming(db, s, now)
        db.flush()
        out = {"agendas": _remind_agendas(db, now), "checkins": _remind_checkins(db, now)}
        db.commit()
        out["measured"] = refresh_measured_goals(db, now)
        db.commit()
        out["reviews"] = perf_reviews.loop_pass(db)
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
