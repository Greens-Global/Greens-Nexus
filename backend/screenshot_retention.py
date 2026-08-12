"""Retention sweep: delete work-monitoring screenshots older than
NEXUS_SHOT_RETENTION_DAYS (default 90; 0 or unset-to-nonpositive disables).

Why: frames accumulate forever otherwise - the dedicated time-monitoring bucket
would balloon, and surveillance imagery has no business outliving its review
window. Payroll disputes resolve within a cycle or two; 90 days comfortably
covers that.

How: mirrors screenshot_migrate.py - a gated background loop on the deployed API
(where the storage service key lives). Each pass deletes up to a batch of
expired frames: storage object first, DB row after, so a failed storage delete
retries next pass instead of orphaning bytes with no row pointing at them.
Rows mid-bucket-migration (bucket = '') still live in hr-docs, so the delete
targets the row's own bucket, falling back to hr-docs.

Single-runner: sync-worker gated (a laptop must never delete live storage) plus
a Postgres advisory lock so one worker/instance sweeps at a time.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

from database import SessionLocal
from models import TimeScreenshot, AgentActivity
from sqlalchemy import text

from routers.hr import _DOC_BUCKET, _SHOT_BUCKET
from screenshot_migrate import _delete, _readable

_LOCK_KEY = 794214     # stable advisory-lock id (migrate loop uses 794213)
_BATCH = 40


def _retention_days() -> int:
    try:
        return int(os.getenv("NEXUS_SHOT_RETENTION_DAYS", "90"))
    except ValueError:
        return 90


def _sweep_batch(days: int) -> int:
    """Delete up to _BATCH frames older than `days`. Returns count deleted,
    or -1 when nothing is expired."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
    db = SessionLocal()
    is_pg = db.bind.dialect.name == "postgresql"
    try:
        if is_pg and not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar():
            return 0   # another worker holds it
        try:
            # `at` is a UTC ISO string, so lexicographic < is chronological <.
            rows = (db.query(TimeScreenshot)
                    .filter(TimeScreenshot.at < cutoff)
                    .limit(_BATCH).all())
            if not rows:
                return -1
            deleted = 0
            for row in rows:
                if row.storage_path:
                    bucket = row.bucket or _DOC_BUCKET
                    _delete(bucket, row.storage_path)
                    if _readable(bucket, row.storage_path):
                        continue   # storage delete failed; keep the row, retry next pass
                db.delete(row)
                db.commit()
                deleted += 1
            return deleted
        finally:
            if is_pg:
                db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
                db.commit()
    finally:
        db.close()


def _purge_activity(days: int) -> int:
    """Bulk-delete agent_activity rows older than `days` (DB rows only, no storage).
    These accumulate fast at scale (~1 row per app-segment per minute per person),
    so without this the table grows unbounded."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
    db = SessionLocal()
    is_pg = db.bind.dialect.name == "postgresql"
    try:
        if is_pg and not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY + 1}).scalar():
            return 0
        try:
            n = db.query(AgentActivity).filter(AgentActivity.at < cutoff).delete(synchronize_session=False)
            db.commit()
            return int(n or 0)
        finally:
            if is_pg:
                db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY + 1})
                db.commit()
    finally:
        db.close()


async def screenshot_retention_loop():
    await asyncio.sleep(300)   # let startup (and the bucket migration) settle
    while True:
        days = _retention_days()
        if days <= 0:
            await asyncio.sleep(6 * 3600)   # disabled - recheck the env later
            continue
        try:
            n = await asyncio.to_thread(_sweep_batch, days)
            if n > 0:
                print(f"[shot-retention] deleted {n} frames older than {days}d")
            # Once the screenshot backlog is drained, purge expired activity rows too
            # (one bulk DB delete per cycle).
            if n <= 0:
                a = await asyncio.to_thread(_purge_activity, days)
                if a:
                    print(f"[shot-retention] deleted {a} activity rows older than {days}d")
            # Full batch => likely more expired; drain quickly. Otherwise daily-ish.
            await asyncio.sleep(5 if n >= _BATCH else 6 * 3600)
        except Exception as e:
            print(f"[shot-retention] sweep failed: {e}")
            await asyncio.sleep(600)
