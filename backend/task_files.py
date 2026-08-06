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
    rows = q.order_by(models.TaskAttachment.id).limit(batch).all()
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

    remaining = await asyncio.to_thread(_count)
    if not remaining:
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
