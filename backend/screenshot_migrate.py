"""One-time migration: move work-monitoring screenshots out of the shared
`hr-docs` bucket into a dedicated private `time-monitoring` bucket.

Why: surveillance frames are a different data class from HR paperwork - different
retention, access scope, egress profile, and blast radius. They only lived in
hr-docs because `_store_shot` reused the HR-doc storage helpers.

How: runs as a gated background loop on the deployed API (where the storage
service key lives). For each legacy row it copies the object server-side, verifies
it's readable in the new bucket, flips the row's `bucket`, then deletes the
hr-docs source. Idempotent and batched; self-idles once every frame is on the new
bucket. New frames already write straight to the new bucket (see `_store_shot`),
so only pre-split rows (bucket = '') need moving.

Single-runner: gated to the sync worker (deployed API, not a developer laptop),
and a Postgres advisory lock keeps one worker/instance migrating at a time.
"""
import asyncio

import httpx
from sqlalchemy import text

from database import SessionLocal
from models import TimeScreenshot
from routers.hr import _SUPABASE_URL, _DOC_BUCKET, _SHOT_BUCKET, _storage_headers

_LOCK_KEY = 794213     # stable advisory-lock id for this migration
_BATCH = 40


def _copy(path: str):
    """hr-docs/<path> -> time-monitoring/<path>. Prefer Supabase's server-side copy
    (no bytes over the wire); fall back to download+upload if it isn't supported.
    Returns True on success, 'missing' if the source is already gone, else False."""
    try:
        r = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/copy",
                       headers={**_storage_headers(), "Content-Type": "application/json"},
                       json={"bucketId": _DOC_BUCKET, "sourceKey": path,
                             "destinationBucket": _SHOT_BUCKET, "destinationKey": path},
                       timeout=30)
        if r.is_success:
            return True
    except Exception:
        pass
    try:
        g = httpx.get(f"{_SUPABASE_URL}/storage/v1/object/{_DOC_BUCKET}/{path}",
                      headers=_storage_headers(), timeout=60)
        if g.status_code == 404:
            return "missing"
        if not g.is_success:
            return False
        u = httpx.post(f"{_SUPABASE_URL}/storage/v1/object/{_SHOT_BUCKET}/{path}",
                       headers={**_storage_headers(), "Content-Type": "image/jpeg", "x-upsert": "true"},
                       content=g.content, timeout=60)
        return u.is_success
    except Exception:
        return False


def _readable(bucket: str, path: str) -> bool:
    """One-byte ranged GET - confirms the object exists in `bucket` before we delete
    the source, with negligible egress."""
    try:
        r = httpx.get(f"{_SUPABASE_URL}/storage/v1/object/{bucket}/{path}",
                      headers={**_storage_headers(), "Range": "bytes=0-0"}, timeout=20)
        return r.status_code in (200, 206)
    except Exception:
        return False


def _delete(bucket: str, path: str):
    try:
        httpx.request("DELETE", f"{_SUPABASE_URL}/storage/v1/object/{bucket}/{path}",
                      headers=_storage_headers(), timeout=20)
    except Exception:
        pass   # best-effort cleanup; an orphaned source is harmless


def _migrate_batch() -> int:
    """Move up to _BATCH frames. Returns count moved, or -1 when nothing remains."""
    db = SessionLocal()
    is_pg = db.bind.dialect.name == "postgresql"
    try:
        if is_pg and not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar():
            return 0   # another worker holds it
        try:
            rows = (db.query(TimeScreenshot)
                    .filter((TimeScreenshot.bucket == "") | (TimeScreenshot.bucket.is_(None)))
                    .limit(_BATCH).all())
            if not rows:
                return -1
            moved = 0
            for row in rows:
                if not row.storage_path:
                    row.bucket = _SHOT_BUCKET; db.commit(); continue   # nothing to move
                res = _copy(row.storage_path)
                if res == "missing":
                    row.bucket = _SHOT_BUCKET; db.commit(); continue   # source gone; mark done
                if res and _readable(_SHOT_BUCKET, row.storage_path):
                    _delete(_DOC_BUCKET, row.storage_path)
                    row.bucket = _SHOT_BUCKET
                    db.commit()
                    moved += 1
                # else: leave untouched (still bucket='') - retried next batch
            return moved
        finally:
            if is_pg:
                db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
                db.commit()
    finally:
        db.close()


async def screenshot_migration_loop():
    await asyncio.sleep(150)   # let startup settle
    idle = False
    while True:
        try:
            n = await asyncio.to_thread(_migrate_batch)
            if n == -1:
                if not idle:
                    print("[shot-migrate] all screenshots on the time-monitoring bucket")
                idle = True
                await asyncio.sleep(3600)      # done - occasional recheck
            else:
                idle = False
                if n:
                    print(f"[shot-migrate] moved {n} frames to time-monitoring")
                await asyncio.sleep(3 if n else 60)
        except Exception as e:
            print(f"[shot-migrate] batch failed: {e}")
            await asyncio.sleep(120)
