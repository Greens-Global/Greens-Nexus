"""One-shot migration: move Asset Management photos and documents that were
stored as base64 data: URLs inside the workspace JSON into the private
`asset-files` bucket, leaving the canonical URL on the record.

Runs as a leader job from main.py's lifespan on the deployed API (where the
storage service key lives), in a thread (never on the event loop), in small
batches; idempotent - a migrated value no longer starts with data:, so restarts
resume where it stopped and once the backlog is empty every boot is one scan.
The workspace ts is bumped after each batch so open tabs pull the new URLs.
"""
import asyncio
import base64
import os
import re
import time

import httpx

from database import SessionLocal
from models import PropertyAsset, PropertyRecord, PropertyWorkspaceMeta
from routers.property_assets import PROPERTY_FILE_FIELDS, RECORD_FILE_FIELDS

_BUCKET = "asset-files"
_BATCH = 20
_DATA_URL = re.compile(r"^data:([^;,]+)?(;base64)?,(.*)$", re.S)
_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf",
        "text/plain": "txt", "text/csv": "csv", "application/msword": "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx"}


def _creds():
    return os.getenv("SUPABASE_URL", "").strip().rstrip("/"), os.getenv("SUPABASE_SERVICE_KEY", "").strip()


def storage_configured() -> bool:
    url, key = _creds()
    return bool(url and key)


def _upload(path: str, raw: bytes, content_type: str) -> str:
    base, key = _creds()
    with httpx.Client(timeout=120) as c:
        r = c.post(f"{base}/storage/v1/object/{_BUCKET}/{path}", content=raw, headers={
            "Authorization": f"Bearer {key}", "apikey": key,
            "Content-Type": content_type, "x-upsert": "true", "cache-control": "31536000"})
    if r.status_code >= 400:
        raise RuntimeError(f"Supabase {r.status_code}: {r.text[:200]}")
    return f"{base}/storage/v1/object/public/{_BUCKET}/{path}"


def _move(data_url: str, folder: str, owner: str, n: int) -> str:
    """One data: URL -> the bucket; the stored URL back. Not a data URL -> unchanged."""
    m = _DATA_URL.match(data_url or "")
    if not m:
        return data_url
    content_type = m.group(1) or "application/octet-stream"
    raw = base64.b64decode(m.group(3)) if m.group(2) else m.group(3).encode()
    ext = _EXT.get(content_type, "bin")
    return _upload(f"{folder}/{owner}/migrated-{n}-{int(time.time())}.{ext}", raw, content_type)


def _migrate_row(payload: dict, keys, folder: str, owner: str) -> bool:
    """Moves every data: URL in `keys` (and `images`); True when anything changed."""
    changed = False
    n = 0
    for k in keys:
        v = payload.get(k)
        if isinstance(v, str) and v.startswith("data:"):
            n += 1
            payload[k] = _move(v, folder, owner, n)
            changed = True
    images = payload.get("images")
    if isinstance(images, list):
        out = []
        for v in images:
            if isinstance(v, str) and v.startswith("data:"):
                n += 1
                out.append(_move(v, folder, owner, n))
                changed = True
            else:
                out.append(v)
        if changed:
            payload["images"] = out
            if payload.get("image", "").startswith("data:") or (out and payload.get("image") in (None, "")):
                payload["image"] = out[0] if out else ""
    return changed


def _batch() -> int:
    """Migrates up to _BATCH rows; how many rows it changed."""
    db = SessionLocal()
    done = 0
    try:
        for p in db.query(PropertyAsset).all():
            if done >= _BATCH:
                break
            payload = dict(p.payload or {})
            if _migrate_row(payload, PROPERTY_FILE_FIELDS, "photos", p.id):
                p.payload = payload
                done += 1
        for r in db.query(PropertyRecord).all():
            if done >= _BATCH:
                break
            payload = dict(r.payload or {})
            if _migrate_row(payload, RECORD_FILE_FIELDS, "documents", r.property_id or "unfiled"):
                r.payload = payload
                done += 1
        if done:
            meta = db.get(PropertyWorkspaceMeta, 1)
            if meta is not None:
                meta.ts = int(time.time() * 1000)
            db.commit()
        return done
    finally:
        db.close()


def _remaining() -> int:
    db = SessionLocal()
    try:
        n = 0
        for p in db.query(PropertyAsset).all():
            n += sum(1 for v in [(p.payload or {}).get(k) for k in PROPERTY_FILE_FIELDS] + list((p.payload or {}).get("images") or [])
                     if isinstance(v, str) and v.startswith("data:"))
        for r in db.query(PropertyRecord).all():
            n += sum(1 for k in RECORD_FILE_FIELDS if str((r.payload or {}).get(k) or "").startswith("data:"))
        return n
    finally:
        db.close()


async def asset_files_migration_loop():
    if not storage_configured():
        print("[asset-files] migration skipped: storage not configured")
        return
    remaining = await asyncio.to_thread(_remaining)
    if not remaining:
        return
    print(f"[asset-files] migrating {remaining} inline files to the asset-files bucket")
    while True:
        try:
            moved = await asyncio.to_thread(_batch)
        except Exception as e:  # noqa: BLE001 - a storage blip must not kill the API
            print(f"[asset-files] migration paused: {e}")
            await asyncio.sleep(300)
            continue
        if not moved:
            print("[asset-files] migration complete")
            return
        await asyncio.sleep(2)
