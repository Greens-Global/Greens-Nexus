"""Task attachment bytes belong in Supabase Storage, not in Postgres.

Until Aug 2026 two paths wrote base64 `data:` URLs into task_attachments.url:
the Asana pull (small inbound files) and the frontend composer (files under
2 MB). That put file BYTES in the database - 5.7 GB of a 5.9 GB prod DB was
this one column. Store the bytes in the `task-files` bucket instead and keep
only the public URL in the row, same as every other upload in the app.

Callers are all synchronous (threadpool endpoints / the sync worker thread),
so the blocking httpx call here never runs on the event loop.

migrate_attachments_to_storage.py drains the pre-existing inlined rows.
"""
import base64
import os
import re
import uuid

import httpx

TASK_FILES_BUCKET = "task-files"

_DATA_URL_RE = re.compile(r"^data:([^;,]+)?(;base64)?,", re.IGNORECASE)


def _creds():
    url = (os.getenv("SUPABASE_URL", "") or "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    return url, key


def storage_configured() -> bool:
    url, key = _creds()
    return bool(url and key)


def _safe_name(name: str) -> str:
    """Storage object keys: keep the extension readable, drop anything risky."""
    name = (name or "file").strip().replace("\\", "/").split("/")[-1]
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "file"
    return name[-80:]


def store_bytes(name: str, raw: bytes, content_type: str) -> str:
    """Upload bytes to the task-files bucket; return the public URL, or "" on
    any failure (callers keep whatever URL they already had - never worse than
    the previous inline behavior)."""
    url, key = _creds()
    if not (url and key and raw):
        return ""
    path = f"tasks/{uuid.uuid4().hex}-{_safe_name(name)}"
    try:
        r = httpx.post(
            f"{url}/storage/v1/object/{TASK_FILES_BUCKET}/{path}",
            headers={"Authorization": f"Bearer {key}", "apikey": key,
                     "Content-Type": content_type or "application/octet-stream",
                     "Cache-Control": "31536000"},
            content=raw, timeout=60)
    except Exception:
        return ""
    if not r.is_success:
        return ""
    return f"{url}/storage/v1/object/public/{TASK_FILES_BUCKET}/{path}"


def store_file(name: str, fileobj, size: int, content_type: str) -> str:
    """store_bytes for a file too big to hold in RAM: streams `fileobj` (an
    open binary file positioned at 0) to the same bucket/path scheme and
    returns the public URL, or "" on any failure. `size` is sent as an
    explicit Content-Length so the body is not chunk-encoded (httpx would
    otherwise line-iterate a raw file object, which corrupts binary data -
    hence the chunk generator). Used by the Asana attachment rescue, whose
    over-5MB files are exactly the ones _pull_attachments never inlined."""
    url, key = _creds()
    if not (url and key and size):
        return ""
    path = f"tasks/{uuid.uuid4().hex}-{_safe_name(name)}"

    def _chunks():
        while True:
            block = fileobj.read(1024 * 1024)
            if not block:
                return
            yield block

    try:
        r = httpx.post(
            f"{url}/storage/v1/object/{TASK_FILES_BUCKET}/{path}",
            headers={"Authorization": f"Bearer {key}", "apikey": key,
                     "Content-Type": content_type or "application/octet-stream",
                     "Content-Length": str(size),
                     "Cache-Control": "31536000"},
            content=_chunks(), timeout=600)
    except Exception:
        return ""
    if not r.is_success:
        return ""
    return f"{url}/storage/v1/object/public/{TASK_FILES_BUCKET}/{path}"


def data_url_to_storage(name: str, data_url: str) -> str:
    """Decode a base64 `data:` URL and store it; "" when it isn't one, isn't
    base64, or the upload fails."""
    m = _DATA_URL_RE.match(data_url or "")
    if not m or not m.group(2):          # not a data: URL / not base64-encoded
        return ""
    mime = m.group(1) or "application/octet-stream"
    try:
        raw = base64.b64decode((data_url or "")[m.end():], validate=False)
    except Exception:
        return ""
    return store_bytes(name, raw, mime)


# ── Backlog migration (rows inlined before Aug 2026) ─────────────────────────
def migrate_inlined_batch(db, batch: int = 25, skip_ids=None):
    """Move up to `batch` inlined rows to storage. Returns
    (migrated, newly_failed_ids, fetched).

    Push-safety: the Asana push sweep offers any http(s) attachment with no
    AsanaAttachmentLink row back to Asana. Every data: URL exists only because
    the file CAME FROM Asana, so a migrated row without a link gets a marker
    ("migrated-inline:<id>", never a real gid) in the same transaction as the
    URL rewrite - suppresses outbound push, invisible to inbound dedupe."""
    import models
    from routers.task_util import now_iso, gen_id
    q = db.query(models.TaskAttachment).filter(models.TaskAttachment.url.like("data:%"))
    if skip_ids:
        q = q.filter(~models.TaskAttachment.id.in_(skip_ids))
    # FOR UPDATE SKIP LOCKED: every gunicorn worker on the leader instance runs
    # this loop (leader.py's lease is per INSTANCE - WEBSITE_INSTANCE_ID is the
    # same for all workers), so without row claims they'd grab the SAME batch
    # and upload duplicate copies. Locked rows are simply someone else's batch.
    # No-op on SQLite (local dev), harmless there.
    rows = (q.order_by(models.TaskAttachment.id).limit(batch)
            .with_for_update(skip_locked=True).all())
    migrated, failed = 0, []
    for a in rows:
        stored = data_url_to_storage(a.name, a.url)
        if not stored:
            failed.append(a.id)
            continue
        a.url = stored
        if not db.query(models.AsanaAttachmentLink).filter(
                models.AsanaAttachmentLink.nexus_attachment_id == a.id).first():
            db.add(models.AsanaAttachmentLink(
                id=gen_id(), nexus_attachment_id=a.id,
                asana_attachment_gid=f"migrated-inline:{a.id}", created_at=now_iso()))
        migrated += 1
    db.commit()
    return migrated, failed, len(rows)


def sweep_orphaned_objects(db) -> int:
    """Delete task-files objects no task_attachments row references. Orphans
    come from the pre-SKIP LOCKED days (every worker uploaded its own copy of
    the same batch) and from attachment rows deleted after upload. Only
    objects older than 15 minutes are touched - an object younger than that
    may belong to a row another worker has uploaded but not yet committed.
    Idempotent and safe to run from several workers at once (a double delete
    is a 404). Returns the number of objects deleted."""
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import text

    url, key = _creds()
    if not (url and key):
        return 0
    headers = {"Authorization": f"Bearer {key}", "apikey": key}

    referenced = set()
    marker = f"/{TASK_FILES_BUCKET}/"
    for (u,) in db.execute(text(
            "SELECT url FROM task_attachments WHERE url LIKE :p"),
            {"p": f"%{marker}%"}):
        referenced.add((u or "").split(marker, 1)[1])

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=15)
    orphans, offset = [], 0
    while True:
        try:
            r = httpx.post(f"{url}/storage/v1/object/list/{TASK_FILES_BUCKET}",
                           headers=headers, timeout=60,
                           json={"prefix": "tasks", "limit": 1000, "offset": offset,
                                 "sortBy": {"column": "name", "order": "asc"}})
        except Exception:
            return 0
        if not r.is_success:
            return 0
        page = r.json() or []
        for o in page:
            name = o.get("name") or ""
            created = (o.get("created_at") or "").replace("Z", "+00:00")
            try:
                too_new = datetime.fromisoformat(created) > cutoff
            except Exception:
                too_new = True                      # unparseable age: leave it
            if name and f"tasks/{name}" not in referenced and not too_new:
                orphans.append(f"tasks/{name}")
        if len(page) < 1000 or offset > 50000:      # runaway guard
            break
        offset += 1000

    deleted = 0
    for i in range(0, len(orphans), 100):
        chunk = orphans[i:i + 100]
        try:
            r = httpx.request("DELETE", f"{url}/storage/v1/object/{TASK_FILES_BUCKET}",
                              headers=headers, json={"prefixes": chunk}, timeout=60)
            if r.is_success:
                deleted += len(chunk)
        except Exception:
            break
    return deleted


async def attachment_migration_loop():
    """One-shot leader job (main.py lifespan): drain the inlined backlog in
    gentle batches, then exit. Idempotent - migrated rows stop matching
    `data:%`, so restarts/redeploys resume where it left off, and once the
    backlog is empty every future boot is a single COUNT. All DB/HTTP work in
    a thread - never on the event loop (CLAUDE.md)."""
    import asyncio
    from sqlalchemy import text
    from database import SessionLocal

    if not storage_configured():
        print("[task-files] backlog migration skipped: storage not configured")
        return

    def _count():
        db = SessionLocal()
        try:
            return db.execute(text(
                "SELECT count(*) FROM task_attachments WHERE url LIKE 'data:%'")).scalar() or 0
        finally:
            db.close()

    def _sweep():
        db = SessionLocal()
        try:
            return sweep_orphaned_objects(db)
        finally:
            db.close()

    remaining = await asyncio.to_thread(_count)
    if not remaining:
        # Backlog already drained - still sweep (cheap: one query + a few list
        # calls) so orphans from earlier runs or deleted rows get cleaned up.
        swept = await asyncio.to_thread(_sweep)
        if swept:
            print(f"[task-files] swept {swept} orphaned storage objects")
        return
    print(f"[task-files] migrating {remaining} inlined attachments to storage")
    failed, total_done = set(), 0
    while True:
        def _batch():
            db = SessionLocal()
            try:
                return migrate_inlined_batch(db, 25, failed)
            finally:
                db.close()
        try:
            done, new_failed, fetched = await asyncio.to_thread(_batch)
        except Exception as e:                     # transient DB/storage blip -
            print(f"[task-files] batch error, retrying in 60s: {e}")
            await asyncio.sleep(60)                # back off, never crash the job
            continue
        failed.update(new_failed)
        total_done += done
        if fetched == 0:
            break
        if total_done and total_done % 500 < 25:
            print(f"[task-files] {total_done} migrated, {len(failed)} undecodable so far")
        await asyncio.sleep(2)
    print(f"[task-files] backlog migration complete: {total_done} moved, "
          f"{len(failed)} undecodable (left inline)")
    # Other workers may still be mid-batch; the sweep's 15-minute age guard
    # protects their uploads, so waiting out the guard here isn't needed.
    swept = await asyncio.to_thread(_sweep)
    if swept:
        print(f"[task-files] swept {swept} orphaned storage objects")
