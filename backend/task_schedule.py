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

from sqlalchemy.orm import Session

import models
import task_due
from routers.task_util import now_iso

MAX_CHAIN = 2000   # a chain longer than this is a data problem, not a schedule


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
            old_due = (dep.due_on or "")[:10]
            if dep.start_on:
                dep.start_on = _plus(dep.start_on, delta)
            if dep.due_on:
                dep.due_on = _plus(dep.due_on, delta)
            dep.modified_at = now_iso()
            if (dep.due_on or "")[:10] != old_due:
                task_due.record_due_change(db, dep, old_due, dep.due_on or "", actor=actor, source="cascade",
                                           note=f"Moved with \"{root.title}\"")
            moved[dep.id] = dep
            queue.append(dep)
    return list(moved.values()), list(skipped.values())
