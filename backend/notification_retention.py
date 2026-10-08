"""Notification retention: every bell notification lives 30 days, then goes.

Clearing a notification no longer deletes it (Neil, 10/01): the row is CLOSED
for that person (NexusNotification.closed_by) and sits under the bell's Closed
list, where Restore brings it back - an accidental Clear All costs nothing.
This sweep is the only thing that removes rows: once a notification is
RETENTION_DAYS old (from created_at, whoever read or closed it) it is deleted.

Single-runner: deployed-worker gated in main.py (a laptop pointed at the
shared dev database must never delete live rows) plus a Postgres advisory
lock so one worker sweeps at a time - same shape as task_trash.py.
"""
import asyncio

from sqlalchemy import text

from database import SessionLocal
from models import NexusNotification
from routers.notifications import retention_cutoff

_LOCK_KEY = 794216     # stable advisory-lock id (task trash is 794215)
_BATCH = 500


def sweep_batch() -> int:
    """Delete up to _BATCH notifications older than the retention window.
    Returns the number removed."""
    cutoff = retention_cutoff()
    db = SessionLocal()
    is_pg = db.bind.dialect.name == "postgresql"
    try:
        if is_pg and not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar():
            return 0   # another worker holds it
        try:
            # created_at is a UTC ISO string, so lexicographic < is chronological <.
            ids = [r.id for r in (db.query(NexusNotification.id)
                                  .filter(NexusNotification.created_at < cutoff)
                                  .limit(_BATCH).all())]
            if not ids:
                return 0
            n = (db.query(NexusNotification)
                 .filter(NexusNotification.id.in_(ids))
                 .delete(synchronize_session=False))
            db.commit()
            return int(n or 0)
        finally:
            if is_pg:
                db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
                db.commit()
    finally:
        db.close()


async def notification_retention_loop():
    await asyncio.sleep(240)   # let startup settle
    while True:
        try:
            n = await asyncio.to_thread(sweep_batch)
            if n > 0:
                print(f"[notif-retention] removed {n} notification(s) past the 30-day window")
            # A full batch means more is waiting; otherwise a few times a day.
            await asyncio.sleep(5 if n >= _BATCH else 6 * 3600)
        except Exception as e:
            print(f"[notif-retention] sweep failed: {e}")
            await asyncio.sleep(600)
