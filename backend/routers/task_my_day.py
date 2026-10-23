"""Tasks > My Day (Neil, Oct 22 2026) - Microsoft Planner / To Do's "My Day".

A short, personal "what I'm doing today" list. Each day it starts with the
tasks assigned to the person that are due that day, plus anything they add.
It empties at midnight in THEIR local time: the picks do not carry over, and
the tasks themselves are never changed by any of this. Nobody else sees it.

Storage: one JSON document on the person's own task_table_prefs row
(models.TaskTablePref.my_day), never a table of its own -
    {"day": "YYYY-MM-DD", "added": [task id, ...], "dismissed": [task id, ...],
     "order": [task id, ...]}
Membership and order are kept apart:
- `added` is the person's PICKS - only what they put on the list themselves.
- The list's other members are worked out on every read: the person's tasks
  due that day ("due-today tasks"), less `dismissed` (the ones they took off
  today). A due-today task is never stored as a pick, so it leaves the list
  by itself when it is reassigned or its date moves.
- `order` is only for sorting. A reorder writes it and nothing else; the ids
  it names come first, in that order, and everything it does not name follows
  (picks newest first, then due-today tasks by priority).
The day is the person's local date, sent by the browser (tasks/lib.js
todayISO) and accepted only within a day of the server's UTC date. A stored
day that is not the requested one reads as an empty list: the reset is lazy,
no job runs at midnight.

Sight: the list only ever shows tasks the caller can see right now - the same
company wall (wall_tasks) and per-task rule (task_visible_to) every list and
the drawer apply - on read AND on add. Adding a task you can see but are not
assigned is fine (it is your list); a task that is deleted, restricted away
from you or walled off later simply drops out, silently.

Writes are one operation each (add / remove / reorder) applied to the row as
it stands under a row lock, so two tabs never lose each other's change.
"""
import re
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import String, cast, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
from auth import company_scope, get_current_user, module_owner_acts_as, require_any_module_grant
from database import get_db
from routers.task_util import (
    _emp_company_map, gen_id, is_manager, now_iso, task_assignees, task_company, task_is_visible,
    task_visible_to, visible_project_ids,
)

# The Tasks router's own gate: the same three dependencies, so My Day is
# reachable by exactly the people who can reach the task list.
router = APIRouter(prefix="/tasks/my-day", tags=["Tasks"],
                   dependencies=[Depends(get_current_user), Depends(require_any_module_grant("tasks", "tickets")),
                                 Depends(module_owner_acts_as("tasks", 3))])

MAX_ADDED = 200        # a day's picks - far above any real day
MAX_DISMISSED = 400
MAX_ORDER = 600        # ids a reorder may name (picks + due-today tasks)
SUGGEST_CAP = 10       # per suggestion group
RECENT_DAYS = 7        # "Recently Assigned"
GROUPS = ("overdue", "dueTomorrow", "inProgress", "recentlyAssigned")
_PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _check_day(day) -> str:
    """The person's local date: YYYY-MM-DD, and within a day of the server's
    UTC date - every time zone's today is one of those three days."""
    s = (day or "").strip()
    if not _DAY.match(s):
        raise HTTPException(400, "The day must be a date (YYYY-MM-DD)")
    try:
        d = date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, "The day must be a real date")
    if abs((d - datetime.now(timezone.utc).date()).days) > 1:
        raise HTTPException(400, "My Day only plans today")
    return s


def _ids(raw, cap: int) -> list[str]:
    out, seen = [], set()
    for v in raw if isinstance(raw, list) else []:
        s = str(v or "").strip()
        if s and len(s) <= 64 and s not in seen:
            seen.add(s)
            out.append(s)
    return out[:cap]


def _state(row, day: str) -> dict:
    """Today's list from the row. Another day's document is an empty list."""
    raw = row.my_day if row is not None and isinstance(row.my_day, dict) else {}
    if raw.get("day") != day:
        return {"day": day, "added": [], "dismissed": [], "order": []}
    return {"day": day, "added": _ids(raw.get("added"), MAX_ADDED),
            "dismissed": _ids(raw.get("dismissed"), MAX_DISMISSED),
            "order": _ids(raw.get("order"), MAX_ORDER)}


def _row(db: Session, email: str, lock: bool = False):
    q = db.query(models.TaskTablePref).filter(models.TaskTablePref.owner_email == email)
    if lock:
        # populate_existing: a row this session already holds is re-read
        # under the lock, never trusted from before it.
        q = q.with_for_update().populate_existing()
    return q.first()


def _locked_row(db: Session, email: str):
    """The caller's prefs row, locked for this transaction - created when they
    have none. Two first writes racing on the unique owner_email: the loser
    rolls back and takes the winner's row."""
    row = _row(db, email, lock=True)
    if row is not None:
        return row
    now = now_iso()
    db.add(models.TaskTablePref(id=gen_id(), owner_email=email, prefs={}, created_at=now, updated_at=now))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
    row = _row(db, email, lock=True)
    if row is None:   # pragma: no cover - the insert above either stood or lost to one that did
        raise HTTPException(409, "Please try again")
    return row


def _save(db: Session, row, state: dict) -> None:
    # Callers build their answer BEFORE this: the commit expires every row the
    # session holds, and reading them afterwards would reload them one by one.
    row.my_day = {"day": state["day"], "added": state["added"][:MAX_ADDED],
                  "dismissed": state["dismissed"][-MAX_DISMISSED:],
                  "order": state["order"][:MAX_ORDER]}   # reassigned, never mutated
    row.updated_at = now_iso()
    db.commit()


def _today_state_for_write(row, day: str) -> dict:
    """The stored list for `day`, refusing a write from a tab still on
    yesterday once another tab has started today - it would wipe today's
    list. The browser reloads on 409."""
    raw = row.my_day if isinstance(row.my_day, dict) else {}
    if str(raw.get("day") or "") > day:
        raise HTTPException(409, "Your day has already moved on. Reload My Day.")
    return _state(row, day)


def _due(t) -> str:
    return (t.due_on or "")[:10]


def _mine_filter(me: str):
    """SQL half of "assigned to me" - task_assignees confirms each row."""
    return or_(func.lower(models.Task.assignee_email) == me,
               func.lower(cast(models.Task.assignee_emails, String)).like(f'%"{me}"%'))


class _Sight:
    """Who-can-see-what for ONE request, each part worked out at most once
    and shared by every check the request makes: the company scope and the
    employee -> company map (the wall, as wall_tasks applies it), and the
    caller's visible projects (task_visible_to) - built only for a row the
    cheap checks (manager, org task, owner / creator / assignee / follower)
    do not settle."""
    def __init__(self, db: Session, user: dict):
        self.db, self.user = db, user
        self.scope = company_scope(user, db)
        self.manager = is_manager(user)
        self._emp = None
        self._visible = None

    def walled_in(self, t) -> bool:
        if self.scope is None:
            return True
        if self._emp is None:
            self._emp = _emp_company_map(self.db)
        return task_company(t, self._emp) in self.scope

    def __call__(self, t) -> bool:
        if t is None or t.deleted_at or not self.walled_in(t):
            return False
        if self.manager or task_is_visible(t, self.user, set()):
            return True
        if self._visible is None:
            self._visible = visible_project_ids(self.db, self.user)
        return task_visible_to(self.db, self.user, t, self._visible)


def _gather(db: Session, sight: _Sight, me: str, day: str, added: list) -> dict:
    """Every row today's list and its suggestions can draw on, in a constant
    number of queries: my work (open, or due today - a finished due-today task
    stays for the day) and the picks; `seen` = the ones the caller may see."""
    mine = [t for t in (db.query(models.Task)
                        .filter(_mine_filter(me),
                                or_(models.Task.completed == False,  # noqa: E712
                                    models.Task.due_on.like(f"{day}%")))
                        .all())
            if me in task_assignees(t)]
    by_id = {t.id: t for t in mine}
    want = [i for i in added if i not in by_id]
    if want:
        # Live rows only - the default query leaves the bin out.
        for t in db.query(models.Task).filter(models.Task.id.in_(want)).all():
            by_id[t.id] = t
    return {"mine": mine, "by_id": by_id, "seen": {i for i, t in by_id.items() if sight(t)}}


def _list_ids(state: dict, g: dict) -> list[str]:
    """Today's list, in display order (see the module docstring)."""
    day, seen = state["day"], g["seen"]
    dismissed = set(state["dismissed"])
    picks = [i for i in state["added"] if i in seen]
    pick_set = set(picks)
    auto = sorted((t for t in g["mine"]
                   if t.id in seen and _due(t) == day and t.id not in dismissed and t.id not in pick_set),
                  key=lambda t: (_PRIORITY_RANK.get(t.priority or "medium", 2), (t.title or "").lower()))
    base = picks + [t.id for t in auto]
    on = set(base)
    first = [i for i in state["order"] if i in on]
    first_set = set(first)
    return first + [i for i in base if i not in first_set]


def _payload(db: Session, me: str, state: dict, g: dict) -> dict:
    """Today's list and the suggestions, from what _gather read."""
    from routers.tasks import task_to_dict   # the list views' own shape
    day = state["day"]
    tomorrow = (date.fromisoformat(day) + timedelta(days=1)).isoformat()
    shown = _list_ids(state, g)
    in_list = set(shown)
    seen = g["seen"]

    # Suggestions: my open work outside today's list, each task in one group.
    open_mine = [t for t in g["mine"] if not t.completed and t.id in seen and t.id not in in_list]
    recent = _recently_assigned(db, me, open_mine)
    pools = {
        "overdue": sorted((t for t in open_mine if _due(t) and _due(t) < day),
                          key=lambda t: (_due(t), _PRIORITY_RANK.get(t.priority or "medium", 2))),
        "dueTomorrow": sorted((t for t in open_mine if _due(t) == tomorrow),
                              key=lambda t: (_PRIORITY_RANK.get(t.priority or "medium", 2), (t.title or "").lower())),
        "inProgress": sorted((t for t in open_mine if (t.status or "") == "in_progress"),
                             key=lambda t: t.modified_at or "", reverse=True),
        "recentlyAssigned": sorted((t for t in open_mine if t.id in recent),
                                   key=lambda t: recent[t.id], reverse=True),
    }
    taken: set = set()
    suggestions = []
    for key in GROUPS:
        rows = []
        for t in pools[key]:
            if t.id in taken:
                continue
            taken.add(t.id)
            rows.append(task_to_dict(t))
            if len(rows) >= SUGGEST_CAP:
                break
        suggestions.append({"key": key, "tasks": rows})

    return {
        "day": day,
        "tasks": [task_to_dict(g["by_id"][i]) for i in shown],
        "addedIds": [i for i in state["added"] if i in seen],
        "dismissedIds": sorted(state["dismissed"]),
        "orderIds": [i for i in state["order"] if i in in_list],
        "suggestions": suggestions,
    }


def _is_occurrence(t) -> bool:
    """A recurring task's occurrence: made by the schedule, not handed to me."""
    rec = t.recurrence if isinstance(t.recurrence, dict) else None
    return bool(rec) or (t.status or "") == "recurring"


def _recently_assigned(db: Session, me: str, rows: list) -> dict:
    """{task id: when} for my open tasks somebody else put me on in the last
    RECENT_DAYS:
    - created for me by someone else - not a recurring task's next occurrence,
      which the schedule makes and nobody hands over;
    - or an assignee change by someone else whose recorded change (field
      history) shows me ADDED. A row with no recorded change cannot say who
      was added, so it does not count."""
    if not rows:
        return {}
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)).isoformat()
    out: dict = {}
    for t in rows:
        if ((t.created_at or "") >= cutoff and (t.created_by or "").lower() != me
                and not _is_occurrence(t)):
            out[t.id] = t.created_at
    ids = [t.id for t in rows]
    for i in range(0, len(ids), 500):
        for a in (db.query(models.TaskActivity.entity_id, models.TaskActivity.at,
                           models.TaskActivity.actor_email, models.TaskActivity.field_change)
                  .filter(models.TaskActivity.entity_kind == "task",
                          models.TaskActivity.type == "assignee_changed",
                          models.TaskActivity.at >= cutoff,
                          models.TaskActivity.entity_id.in_(ids[i:i + 500])).all()):
            if (a.actor_email or "").lower() == me:
                continue
            ch = a.field_change if isinstance(a.field_change, dict) else None
            if ch is None:
                continue
            to = {str(e).lower() for e in (ch.get("to") or [])}
            frm = {str(e).lower() for e in (ch.get("from") or [])}
            if me not in to or me in frm:
                continue
            if (a.at or "") > (out.get(a.entity_id) or ""):
                out[a.entity_id] = a.at
    return out


# ── Endpoints ────────────────────────────────────────────────────────────────
class MyDayTask(BaseModel):
    day: str
    task_id: str
    # False: only take the task off `dismissed` - a due-today task put back
    # (Undo) returns as a due-today task, not as a pick.
    pick: bool = True


class MyDayOrder(BaseModel):
    day: str
    task_ids: list[str]


@router.get("")
def get_my_day(day: str = Query(...), user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Today's list (`tasks`, in order) and `suggestions` (Overdue, Due
    Tomorrow, In Progress, Recently Assigned; ten each)."""
    day = _check_day(day)
    me = user["email"].lower()
    state = _state(_row(db, me), day)
    sight = _Sight(db, user)
    return _payload(db, me, state, _gather(db, sight, me, day, state["added"]))


@router.post("/add")
def add_to_my_day(body: MyDayTask, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put a task at the top of today's list. Any task the caller can see -
    it is their own list, so being assigned is not required. 404 (never 403)
    for one they cannot, like every per-task route."""
    day = _check_day(body.day)
    me = user["email"].lower()
    sight = _Sight(db, user)
    tid = (body.task_id or "").strip()
    t = db.query(models.Task).filter(models.Task.id == tid).first() if tid else None
    if not sight(t):
        raise HTTPException(404, "Task not found")
    row = _locked_row(db, me)
    state = _today_state_for_write(row, day)
    dismissed = [i for i in state["dismissed"] if i != tid]
    if body.pick:
        added = [tid] + [i for i in state["added"] if i != tid]
        if len(added) > MAX_ADDED:
            raise HTTPException(400, f"My Day holds up to {MAX_ADDED} tasks")
        state = {**state, "added": added, "dismissed": dismissed,
                 "order": [tid] + [i for i in state["order"] if i != tid]}
    else:
        state = {**state, "dismissed": dismissed}
    out = _payload(db, me, state, _gather(db, sight, me, day, state["added"]))
    _save(db, row, state)
    return out


@router.post("/remove")
def remove_from_my_day(body: MyDayTask, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take a task off today's list. The task is not touched. A due-today
    task is remembered as dismissed so it does not come straight back."""
    day = _check_day(body.day)
    me = user["email"].lower()
    tid = (body.task_id or "").strip()
    if not tid or len(tid) > 64:
        raise HTTPException(400, "Which task?")
    row = _locked_row(db, me)
    state = _today_state_for_write(row, day)
    state = {**state, "added": [i for i in state["added"] if i != tid],
             "dismissed": [i for i in state["dismissed"] if i != tid] + [tid],
             "order": [i for i in state["order"] if i != tid]}
    out = _payload(db, me, state, _gather(db, _Sight(db, user), me, day, state["added"]))
    _save(db, row, state)
    return out


@router.put("/order")
def reorder_my_day(body: MyDayOrder, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put today's list in the order given. Only the ORDER changes: nothing
    becomes a pick, nothing leaves. Ids not on the list right now are ignored
    (one removed in another tab is not brought back); ids the order does not
    name keep their place after it, so a stale tab never drops one."""
    day = _check_day(body.day)
    me = user["email"].lower()
    if len(body.task_ids or []) > MAX_ORDER:
        raise HTTPException(400, "That is too many tasks to order")
    sight = _Sight(db, user)
    row = _locked_row(db, me)
    state = _today_state_for_write(row, day)
    g = _gather(db, sight, me, day, state["added"])
    on_list = set(_list_ids(state, g))
    named = [i for i in _ids(body.task_ids, MAX_ORDER) if i in on_list]
    named_set = set(named)
    state = {**state, "order": named + [i for i in state["order"] if i not in named_set]}
    out = _payload(db, me, state, g)
    _save(db, row, state)
    return out
