"""Dependency-aware rescheduling (Oct 2026).

Tasks have carried blocked-by links with a type (FS / SS / FF / SF) for a
while, and the Timeline drew the arrows, but moving a blocker never moved
what waited on it - the Gantt was a picture. This module is the push: when
a task's dates move LATER, every task downstream of it that would now break
its dependency is shifted just enough to satisfy it again, keeping its own
duration, and the shift carries on down the chain.

Rules (dates are whole days, start may be blank, due may be blank):
  FS  the dependent may not START before the blocker is DUE
  SS  the dependent may not START before the blocker STARTS
  FF  the dependent may not be DUE before the blocker is DUE
  SF  the dependent may not be DUE before the blocker STARTS

Moving a blocker EARLIER never pulls dependents in - a task can legitimately
sit later than its blocker requires, and nobody asked for it to move. A
dependent with no dates at all is not on the schedule and is left alone.
A dependent the actor may not edit is left alone and reported, so the UI
can say so rather than the chain silently stopping there.

Only the dependents' rows are written here; the caller commits and sends
the notifications (routers/tasks.reschedule_task).
"""
from __future__ import annotations

from collections import deque
from datetime import date, timedelta
from typing import Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
import task_due
import task_history
from routers.task_util import now_iso

MAX_CHAIN = 2000   # a chain longer than this is a data problem, not a schedule
# A task pushed more often than this in one drag is in a loop, not a chain
# (A -> B -> C -> B). The API refuses to create such links, but imported and
# legacy rows can carry them; walking the loop to MAX_CHAIN would move the
# dates out by years and write a history line per hop.
MAX_PUSHES_PER_TASK = 50


def _day(iso: str) -> date | None:
    try:
        return date.fromisoformat((iso or "")[:10])
    except ValueError:
        return None


def _plus(iso: str, days: int) -> str:
    d = _day(iso)
    return (d + timedelta(days=days)).isoformat() if d else ""


def required_shift(blocker: models.Task, dep: models.Task, dep_type: str) -> int:
    """How many days later `dep` must move to respect `dep_type` against
    `blocker` as both stand now. 0 when it already does, or when either side
    has no date to compare."""
    b_start = _day(blocker.start_on) or _day(blocker.due_on)
    b_due = _day(blocker.due_on) or _day(blocker.start_on)
    d_start = _day(dep.start_on) or _day(dep.due_on)
    d_due = _day(dep.due_on) or _day(dep.start_on)
    if not (b_start and b_due and d_start and d_due):
        return 0
    dep_type = (dep_type or "FS").upper()
    if dep_type == "SS":
        gap = (b_start - d_start).days
    elif dep_type == "FF":
        gap = (b_due - d_due).days
    elif dep_type == "SF":
        gap = (b_start - d_due).days
    else:   # FS
        gap = (b_due - d_start).days
    return max(0, gap)


def push_dependents(db: Session, root: models.Task, *, actor: str,
                    can_edit: Callable[[models.Task], bool]) -> tuple[list[models.Task], list[models.Task]]:
    """Shift everything downstream of `root` that its new dates now break.
    Returns (moved, skipped): `moved` rows have new dates written (and their
    due history recorded); `skipped` are dependents the actor may not edit.
    Breadth-first over blocking_ids so a task two blockers push is handled
    after both have settled where they can."""
    moved: dict[str, models.Task] = {}
    skipped: dict[str, models.Task] = {}
    original_due: dict[str, str] = {}   # where each moved task's due stood before this drag
    hist_before: dict[str, dict] = {}   # field history: each moved task before this drag
    pushes: dict[str, int] = {}
    queue = deque([root])
    hops = 0
    while queue and hops < MAX_CHAIN:
        hops += 1
        blocker = queue.popleft()
        ids = [i for i in (blocker.blocking_ids or []) if i]
        if not ids:
            continue
        deps = (db.query(models.Task).filter(models.Task.id.in_(ids),
                                             (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)))
                .all())
        for dep in deps:
            if dep.id == root.id or dep.completed:
                continue
            dep_type = (dep.dependency_types or {}).get(blocker.id, "FS")
            delta = required_shift(blocker, dep, dep_type)
            if delta <= 0:
                continue
            if dep.id in skipped:
                continue
            if not can_edit(dep):
                skipped[dep.id] = dep
                continue
            pushes[dep.id] = pushes.get(dep.id, 0) + 1
            if pushes[dep.id] > MAX_PUSHES_PER_TASK:
                raise HTTPException(409, f"\"{dep.title}\" and the tasks it waits on depend on each other in a loop. "
                                         "Fix those links before moving the chain.")
            original_due.setdefault(dep.id, (dep.due_on or "")[:10])
            if dep.id not in hist_before:
                hist_before[dep.id] = task_history.snapshot(dep)
            if dep.start_on:
                dep.start_on = _plus(dep.start_on, delta)
            if dep.due_on:
                dep.due_on = _plus(dep.due_on, delta)
            dep.modified_at = now_iso()
            moved[dep.id] = dep
            queue.append(dep)
    # One history line per task for one drag - from where it stood to where it
    # ends - even when two blockers each pushed it on the way (A blocks B and
    # C, B blocks C). A line per hop double-counted the extension.
    for tid, dep in moved.items():
        if (dep.due_on or "")[:10] != original_due[tid]:
            task_due.record_due_change(db, dep, original_due[tid], dep.due_on or "", actor=actor, source="cascade",
                                       note=f"Moved with \"{root.title}\"")
        # The start date's history (the due date's is the line above).
        task_history.record(db, dep, hist_before[tid], actor, only={"startOn"})
    return list(moved.values()), list(skipped.values())


# ── Automatic scheduling (Neil, 11/08/2026) ──────────────────────────────────
# OpenProject's model. A task in "auto" mode is PLACED by the engine: its start
# is the latest of its predecessors' (due + lag + 1 working day), keeping its
# own length in working days, or - when it has subtasks - it spans them (first
# start to last due). A "manual" task is never moved; the Timeline marks a
# manual successor that starts too early (the amber bracket) and leaves it.
# Every task starts manual, so nothing moves until somebody switches one.
#
# Working days are Monday to Friday minus the project company's mandatory
# holidays, read through the same holiday_policies rule every other holiday
# reader uses; a task with no project counts weekends only.
AUTO = "auto"
MAX_AUTO_TASKS = 500
# shortcut: holidays are read for one window around today (a year back, three
# ahead); a chain scheduled beyond it counts weekends only. Widen if a project
# is ever planned further out.
_HOLIDAY_WINDOW = (365, 3 * 365)


def is_auto(t) -> bool:
    return (getattr(t, "schedule_mode", "") or "manual") == AUTO


class Calendar:
    """Working days: Monday to Friday minus `off` (ISO dates)."""

    def __init__(self, off=None):
        self.off = set(off or ())

    def is_working(self, d: date) -> bool:
        return d.weekday() < 5 and d.isoformat() not in self.off

    def add_working(self, d: date, n: int) -> date:
        """`n` working days on from `d` (back when `n` is negative); a `d`
        that is not a working day first moves to the next (previous) one."""
        step = 1 if n >= 0 else -1
        while not self.is_working(d):
            d += timedelta(days=step)
        for _ in range(abs(n)):
            d += timedelta(days=step)
            while not self.is_working(d):
                d += timedelta(days=step)
        return d

    def span(self, d0: date, d1: date) -> int:
        """Working days from d0 to d1 inclusive - a task's length; at least 1."""
        if d1 < d0:
            d0, d1 = d1, d0
        return max(1, sum(1 for i in range((d1 - d0).days + 1) if self.is_working(d0 + timedelta(days=i))))

    def between(self, d0: date, d1: date) -> int:
        """Signed working days from d0 to d1 - how far a due date slipped."""
        if d0 == d1:
            return 0
        lo, hi = (d0, d1) if d1 > d0 else (d1, d0)
        n = sum(1 for i in range(1, (hi - lo).days + 1) if self.is_working(lo + timedelta(days=i)))
        return n if d1 > d0 else -n


def company_holidays(db: Session, company_id: str) -> set:
    """The company's mandatory holidays (ISO dates): the same rows and the
    same country rule the schedule's Fill Automatically reads
    (timeclock._company_holidays_for_many -> holiday_policies), applied to
    the company itself rather than to one person."""
    if not company_id:
        return set()
    import holiday_policies
    today = date.today()
    lo = (today - timedelta(days=_HOLIDAY_WINDOW[0])).isoformat()
    hi = (today + timedelta(days=_HOLIDAY_WINDOW[1])).isoformat()
    rows = (db.query(models.HrCompanyHoliday)
            .filter(models.HrCompanyHoliday.company_id == company_id,
                    models.HrCompanyHoliday.date >= lo, models.HrCompanyHoliday.date <= hi).all())
    if not rows:
        return set()
    country = holiday_policies.company_countries(db, [company_id]).get(company_id, "")
    return {d for d, h in holiday_policies.holidays_by_date(rows, country).items()
            if (h.get("type") or "mandatory") != "optional"}


def calendar_for(db: Session, project) -> Calendar:
    """The working-day calendar of a project's company; weekends only without a project."""
    if project is None:
        return Calendar()
    from routers.task_util import row_company
    return Calendar(company_holidays(db, row_company(db, project)))


def _calendar(db: Session, t: models.Task, cache: dict) -> Calendar:
    from routers.task_util import project_for_task
    project = project_for_task(db, t)
    key = project.id if project is not None else ""
    if key not in cache:
        cache[key] = calendar_for(db, project)
    return cache[key]


def _live(db: Session, ids) -> list:
    ids = [i for i in (ids or []) if i]
    return db.query(models.Task).filter(models.Task.id.in_(ids)).all() if ids else []


def _int(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _place(db: Session, t: models.Task, cache: dict, actor: str):
    """Compute and write `t`'s dates from its subtasks, else its predecessors.
    None when nothing changes (or there is nothing to place it by); else
    {id, title, cause, causeId, from, to}, with the due history and the start
    date's field history written."""
    old_start, old_due = _day(t.start_on), _day(t.due_on)
    kids = [k for k in db.query(models.Task).filter(models.Task.parent_task_id == t.id).all()
            if _day(k.start_on) or _day(k.due_on)]
    if kids:
        start = min(_day(k.start_on) or _day(k.due_on) for k in kids)
        due = max(_day(k.due_on) or _day(k.start_on) for k in kids)
        cause, note = None, "Moved with its subtasks"
    else:
        preds = [p for p in _live(db, t.blocked_by_ids) if _day(p.due_on) or _day(p.start_on)]
        if not preds:
            return None
        cal = _calendar(db, t, cache)
        lags = t.dependency_lags if isinstance(t.dependency_lags, dict) else {}
        best = None
        for p in preds:
            lag = _int(lags.get(p.id, 0))
            s = cal.add_working(_day(p.due_on) or _day(p.start_on), lag + 1)
            if best is None or s > best[0]:
                best = (s, p, lag)
        start, cause, lag = best
        due = cal.add_working(start, (cal.span(old_start, old_due) if old_start and old_due else 1) - 1)
        note = f"Moved by {cause.title}" + (f" ({lag:+d} working day{'s' if abs(lag) != 1 else ''})" if lag else "")
    if start == old_start and due == old_due:
        return None
    hist_before = task_history.snapshot(t)
    frm = {"start": t.start_on or "", "due": (t.due_on or "")[:10]}
    t.start_on, t.due_on = start.isoformat(), due.isoformat()
    t.modified_at = now_iso()
    entry = task_due.record_due_change(db, t, frm["due"], t.due_on, actor=actor, source="auto", note=note)
    if entry is not None and cause is not None:
        entry["cause"] = cause.id   # the dict already sits in the new due_history list
    task_history.record(db, t, hist_before, actor, only={"startOn"})
    return {"id": t.id, "title": t.title, "cause": cause.title if cause is not None else "its subtasks",
            "causeId": cause.id if cause is not None else "", "from": frm,
            "to": {"start": t.start_on, "due": t.due_on}}


def reschedule_successors(db: Session, changed: models.Task, *, actor: str, also=()) -> list[dict]:
    """Place every auto task that `changed` reaches: `changed` itself when it
    is auto, then breadth-first through the tasks it blocks (blocking_ids)
    and its parent, each task once, MAX_AUTO_TASKS in all, going no further
    past a manual task or one that did not move. `also` is extra ids to
    start from (the parent a subtask just left). Runs inside the caller's
    transaction - flushed first so its queries see the edit that caused it -
    and writes only rows; the caller commits and tells people
    (routers/tasks._announce_auto_moves). Returns the moves."""
    db.flush()
    moves: list[dict] = []
    cache: dict = {}
    queue = deque([(changed.id, True)] + [(i, True) for i in also if i])
    visited: set = set()
    while queue and len(visited) < MAX_AUTO_TASKS:
        tid, root = queue.popleft()
        if not tid or tid in visited:
            continue
        visited.add(tid)
        t = changed if tid == changed.id else (_live(db, [tid]) or [None])[0]
        if t is None:
            continue
        moved = None
        if is_auto(t) and not t.completed:
            moved = _place(db, t, cache, actor)
            if moved is not None:
                moves.append(moved)
        if root or moved is not None:
            for sid in (t.blocking_ids or []):
                queue.append((sid, False))
            if t.parent_task_id:
                queue.append((t.parent_task_id, False))
    return moves
