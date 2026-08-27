"""Task trash: permanent purge of tasks soft-deleted 90+ days ago.

Deleting a task now marks it (Task.deleted_at/deleted_by, see models.py and the
do_orm_execute hook in database.py) instead of dropping the row, so it can be
restored via POST /tasks/{id}/restore for a grace window. This loop is what
ends that window: past NEXUS_TASK_TRASH_RETENTION_DAYS (default 90; 0 or
unset-to-nonpositive disables), a trashed task is removed for good, through
task_util.purge_task_permanently - the same cascade routers/tasks.py's
delete_task used to run immediately, before soft delete existed.

Every qualifying row is purged independently rather than only walking
top-level trashed tasks and cascading into their subtasks: a subtask can be
trashed on its own with its parent still live (DELETE /tasks/{id} on a
subtask), and that row would never be reached by a parent-only sweep.
purge_task_permanently is safe to call twice on the same id (a subtask already
removed alongside its parent just matches zero rows the second time), so a
parent and child landing in the same batch costs a few no-op queries, never a
correctness problem.

Single-runner: sync-worker gated in main.py (a laptop must never permanently
delete live task data) plus a Postgres advisory lock so one worker sweeps at a
time - same shape as screenshot_retention.py.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from database import SessionLocal
from models import Task
from routers.task_util import purge_task_permanently, asana_push_deleted

_LOCK_KEY = 794215     # stable advisory-lock id (screenshot loops use 794213/794214)
_BATCH = 25


def _retention_days() -> int:
    try:
        return int(os.getenv("NEXUS_TASK_TRASH_RETENTION_DAYS", "90"))
    except ValueError:
        return 90


def _sweep_batch(days: int) -> int:
    """Purge up to _BATCH trashed tasks older than `days`. Returns count
    purged, or -1 when nothing is expired."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
    db = SessionLocal()
    is_pg = db.bind.dialect.name == "postgresql"
    try:
        if is_pg and not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar():
            return 0   # another worker holds it
        try:
            # deleted_at is a UTC ISO string, so lexicographic < is chronological <.
            rows = (db.query(Task).execution_options(include_deleted=True)
                    .filter(Task.deleted_at != "", Task.deleted_at < cutoff)
                    .limit(_BATCH).all())
            if not rows:
                return -1
            purged = 0
            for t in rows:
                if purge_task_permanently(db, t.id, actor_email=""):
                    purged += 1
                db.commit()
            if purged:
                asana_push_deleted()
            return purged
        finally:
            if is_pg:
                db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
                db.commit()
    finally:
        db.close()


async def trash_purge_loop():
    await asyncio.sleep(300)   # let startup settle
    while True:
        days = _retention_days()
        if days <= 0:
            await asyncio.sleep(6 * 3600)   # disabled - recheck the env later
            continue
        try:
            n = await asyncio.to_thread(_sweep_batch, days)
            if n > 0:
                print(f"[task-trash] permanently deleted {n} task(s) older than {days}d")
            # Full batch => likely more expired; drain quickly. Otherwise daily-ish.
            await asyncio.sleep(5 if n >= _BATCH else 6 * 3600)
        except Exception as e:
            print(f"[task-trash] sweep failed: {e}")
            await asyncio.sleep(600)
