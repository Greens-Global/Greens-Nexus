"""My Work (Essentials, Oct 7) - the signed-in person's open work, bucketed by
when it is due, for the My Work dashboard tile.

GET /me/work?tz_offset_min=<minutes> answers "what am I responsible for, and
what is due?" in ONE place, so the tile never re-derives the rule:

  tasks    open (not completed, not in the trash) tasks the caller is an
           assignee of - task_util.task_assignees, the same answer /tasks
           gives, behind the same company wall (wall_tasks).
  tickets  open (not resolved / closed, not deleted) tickets the caller
           raised, filed on someone's behalf, or is assigned to - the
           list_tickets `mine` rule plus the assignee, behind the same wall.

Grouped by due date in the CALLER'S local day (tz_offset_min is
Date.getTimezoneOffset(), minutes behind UTC, as /timeclock/status reads it):
  overdue  due before today
  today    due today
  week     due in the next 7 days
  later    no due date, or further out
Each group is sorted by due date then priority (urgent first), capped at
GROUP_CAP rows; `counts` carries the uncapped totals.

Only the caller's rows leave the database: both queries filter by
assignee / requester in SQL (the JSON assignee list by a text match, confirmed
in Python with task_assignees) - never the whole table.
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import String, cast, func, or_
from sqlalchemy.orm import Session

import models
from auth import get_current_user
from database import get_db
from routers.task_util import task_assignees, wall_tasks

router = APIRouter(prefix="", tags=["My Work"])

GROUP_CAP = 50
WEEK_DAYS = 7
PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}
TICKET_CLOSED = ("resolved", "closed")
# Labels the Tasks module draws for its built-in statuses (tasks/theme.js);
# a project's custom board column is looked up by id below.
TASK_STATUS_LABEL = {"not_started": "Not Started", "in_progress": "In Progress",
                     "completed": "Completed", "recurring": "Recurring"}
TICKET_STATUS_LABEL = {"open": "Open", "new": "Open", "in_progress": "In Progress",
                       "waiting_user": "Waiting for User", "waiting_vendor": "Waiting for Vendor",
                       "on_hold": "On Hold", "reopened": "Reopened",
                       "resolved": "Resolved", "closed": "Closed"}


def local_today(tz_offset_min: int, now: datetime | None = None) -> str:
    """The caller's calendar date as YYYY-MM-DD. tz_offset_min follows
    Date.getTimezoneOffset(): +300 for New York (UTC-5), so local = UTC - offset
    - the same arithmetic as timeclock._local_date."""
    now = now or datetime.now(timezone.utc)
    try:
        off = int(tz_offset_min or 0)
    except (TypeError, ValueError):
        off = 0
    off = max(-14 * 60, min(14 * 60, off))
    return (now - timedelta(minutes=off)).strftime("%Y-%m-%d")


def bucket_of(due_on: str, today: str) -> str:
    """Which group a due date lands in for `today` (both YYYY-MM-DD; a blank
    or unreadable date is 'later')."""
    due = (due_on or "").strip()[:10]
    if len(due) != 10:
        return "later"
    try:
        d = datetime.strptime(due, "%Y-%m-%d").date()
        t = datetime.strptime(today, "%Y-%m-%d").date()
    except ValueError:
        return "later"
    if d < t:
        return "overdue"
    if d == t:
        return "today"
    if d <= t + timedelta(days=WEEK_DAYS):
        return "week"
    return "later"


def _sort_key(item: dict) -> tuple:
    # Undated rows sink to the end of their (always 'later') group.
    return (item.get("dueOn") or "9999-12-31", PRIORITY_RANK.get(item.get("priority") or "medium", 2),
            item.get("title") or "")


def _title_case(s: str) -> str:
    return (s or "").replace("_", " ").title()


# ── Tasks ────────────────────────────────────────────────────────────────────
def _my_open_tasks(db: Session, user: dict, me: str) -> list:
    """Open tasks the caller is assigned to. The JSON assignee list is matched as
    text in SQL (SQLite stores JSON as text; Postgres casts json -> text) so only
    the caller's rows are fetched, then confirmed with task_assignees - the one
    correct way to ask "is this person on this task" (task_util)."""
    needle = f'%"{me}"%'
    q = (db.query(models.Task)
         .filter(models.Task.completed == False,  # noqa: E712
                 or_(func.lower(models.Task.assignee_email) == me,
                     func.lower(cast(models.Task.assignee_emails, String)).like(needle))))
    rows = [t for t in wall_tasks(db, user, q.all())
            if me in task_assignees(t) and (t.type or "task") != "section"]
    if not rows:
        return []
    # Names for the project column and custom status labels - one query each,
    # only for the ids these rows use. A subtask reaches its project through
    # its parent (project_id blank by convention - task_util.project_for_task).
    orphan_parents = {t.parent_task_id for t in rows if not t.project_id and t.parent_task_id}
    parent_project = {}
    if orphan_parents:
        parent_project = {p.id: p.project_id for p in
                          db.query(models.Task.id, models.Task.project_id)
                          .filter(models.Task.id.in_(orphan_parents)).all()}
    project_ids = {t.project_id or parent_project.get(t.parent_task_id or "", "") for t in rows} - {"", None}
    names = {}
    if project_ids:
        names = {p.id: p.name or "" for p in
                 db.query(models.TaskProject.id, models.TaskProject.name)
                 .filter(models.TaskProject.id.in_(project_ids)).all()}
    custom_ids = {t.status for t in rows if t.status and t.status not in TASK_STATUS_LABEL}
    custom = {}
    if custom_ids:
        custom = {s.id: s.label or "" for s in
                  db.query(models.TaskCustomStatus.id, models.TaskCustomStatus.label)
                  .filter(models.TaskCustomStatus.id.in_(custom_ids)).all()}
    out = []
    for t in rows:
        status = t.status or "not_started"
        pid = t.project_id or parent_project.get(t.parent_task_id or "", "")
        out.append({
            "kind": "task", "id": t.id, "code": t.code or "", "title": t.title or "Untitled task",
            "project": names.get(pid, ""), "dueOn": (t.due_on or "")[:10],
            "status": status,
            "statusLabel": TASK_STATUS_LABEL.get(status) or custom.get(status) or _title_case(status),
            "priority": t.priority or "medium", "unread": False,
            # navigate('tasks') then nexus:open-task {taskId} - lib/openTarget.js.
            "view": "tasks", "sub": "", "taskId": t.id,
        })
    return out


# ── Tickets ──────────────────────────────────────────────────────────────────
def _my_open_tickets(db: Session, user: dict, me: str) -> list:
    """Open tickets the caller raised (or filed for someone - list_tickets'
    `mine` rule) or is assigned to. Resolved / closed are done; deleted ones
    never load (database._hide_soft_deleted)."""
    import auth
    from routers.tickets import _has_desk_grant, dept_name
    T = models.TaskTicket
    q = (db.query(T)
         .filter(or_(T.status.is_(None), T.status.notin_(TICKET_CLOSED)),
                 or_(func.lower(T.requester_email) == me,
                     func.lower(T.created_by_email) == me,
                     func.lower(T.assignee_email) == me)))
    rows = q.all()
    # Company wall, exactly as list_tickets applies it.
    scope = auth.company_scope(user, db)
    if scope is not None:
        rows = [t for t in rows if (t.company_id or "") in scope]
    if not rows:
        return []
    # Where a ticket opens for this person - the Tickets desk for agents, the
    # Support screen (own requests, same drawer) for everyone else; the bell
    # and the Ticket Queue tile make the same call (teamWidgets.ticketViewFor).
    view = "tickets" if _has_desk_grant(user, db) else "support"
    dept_cache: dict = {}
    out = []
    for t in rows:
        dept_id = t.department_id or ""
        if dept_id not in dept_cache:
            dept_cache[dept_id] = dept_name(db, dept_id) if dept_id else ""
        status = t.status if (t.status and t.status != "new") else "open"
        # The unread dot is the requester's (mark_ticket_seen): a reply or
        # change they have not opened yet - the same compare Support.jsx makes.
        is_requester = (t.requester_email or "").lower() == me
        unread = bool(is_requester and (t.requester_update_at or "")
                      and (t.requester_update_at or "") > (t.requester_seen_at or ""))
        out.append({
            "kind": "ticket", "id": t.id, "code": t.code or "", "title": t.subject or "Untitled ticket",
            "project": dept_cache[dept_id] or t.application or t.service_area or _title_case(t.type or "request"),
            "dueOn": (t.sla_due_on or "")[:10],
            "status": status, "statusLabel": TICKET_STATUS_LABEL.get(status) or _title_case(status),
            "priority": t.priority or "medium", "unread": unread,
            # navigate(view) then nexus:open-ticket {ticketId} - lib/openTarget.js.
            "view": view, "sub": "", "ticketId": t.id,
        })
    return out


def group_items(items: list, today: str) -> dict:
    """Bucket, sort and cap - the whole rule, shared by the endpoint and tests."""
    groups = {"overdue": [], "today": [], "week": [], "later": []}
    for it in items:
        groups[bucket_of(it.get("dueOn") or "", today)].append(it)
    counts = {k: len(v) for k, v in groups.items()}
    counts["total"] = sum(counts.values())
    for k in groups:
        groups[k] = sorted(groups[k], key=_sort_key)[:GROUP_CAP]
    groups["counts"] = counts
    groups["localDate"] = today
    return groups


@router.get("/me/work")
def my_work(tz_offset_min: int = 0, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").strip().lower()
    today = local_today(tz_offset_min)
    if not me:
        return group_items([], today)
    items = _my_open_tasks(db, user, me) + _my_open_tickets(db, user, me)
    return group_items(items, today)
