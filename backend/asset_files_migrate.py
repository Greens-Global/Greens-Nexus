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
# Rows whose move failed this process: logged once, skipped, so one bad row never
# stalls the rest (and never re-uploads the files before it on every retry).
_SKIP: set = set()
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
            if str(payload.get("image") or "").startswith("data:") or (out and not payload.get("image")):
                payload["image"] = out[0] if out else ""
    return changed


def _moves_for(payload: dict, keys, folder: str, owner: str) -> dict:
    """Uploads every data: URL in `keys` (and `images`); {data_url: bucket_url}.
    Only the uploads - nothing is written to the row here."""
    moves: dict = {}
    n = 0
    for k in keys:
        v = payload.get(k)
        if isinstance(v, str) and v.startswith("data:") and v not in moves:
            n += 1
            moves[v] = _move(v, folder, owner, n)
    for v in payload.get("images") or []:
        if isinstance(v, str) and v.startswith("data:") and v not in moves:
            n += 1
            moves[v] = _move(v, folder, owner, n)
    return moves


def _apply_moves(payload: dict, keys, moves: dict) -> bool:
    """Substitutes the uploaded URLs into a row AS IT IS NOW; True when anything changed."""
    changed = False
    for k in keys:
        v = payload.get(k)
        if isinstance(v, str) and v in moves:
            payload[k] = moves[v]
            changed = True
    images = payload.get("images")
    if isinstance(images, list):
        out = [moves.get(v, v) if isinstance(v, str) else v for v in images]
        if out != images:
            payload["images"] = out
            changed = True
            if str(payload.get("image") or "").startswith("data:") or (out and not payload.get("image")):
                payload["image"] = out[0] if out else ""
    return changed


def _commit_moves(db, row, keys, moves: dict) -> bool:
    """The uploads took seconds; someone may have saved the row meanwhile. Under
    the workspace lock, re-read the row and substitute only the values it still
    holds - a user's edit is never reverted, and a value they replaced is simply
    not touched. The row's stamp does not move (a tab's queued edit still lands;
    _carry_over in the router keeps the moved URL then)."""
    db.query(PropertyWorkspaceMeta).filter(PropertyWorkspaceMeta.id == 1).with_for_update().first()
    db.refresh(row)
    payload = dict(row.payload or {})
    if not _apply_moves(payload, keys, moves):
        db.rollback()
        return False
    row.payload = payload
    meta = db.get(PropertyWorkspaceMeta, 1)
    if meta is not None:
        meta.ts = int(time.time() * 1000)
    db.commit()                                  # each row lands on its own
    return True


def _batch() -> int:
    """Migrates up to _BATCH rows; how many rows it changed."""
    db = SessionLocal()
    done = 0
    try:
        for p in db.query(PropertyAsset).all():
            if done >= _BATCH or p.id in _SKIP:
                continue
            try:
                moves = _moves_for(dict(p.payload or {}), PROPERTY_FILE_FIELDS, "photos", p.id)
            except Exception as e:  # noqa: BLE001 - one row's bad file must not stall the rest
                print(f"[asset-files] {p.id}: {e} - skipped")
                _SKIP.add(p.id)
                continue
            if moves and _commit_moves(db, p, PROPERTY_FILE_FIELDS, moves):
                done += 1
        for r in db.query(PropertyRecord).all():
            if done >= _BATCH or r.id in _SKIP:
                continue
            try:
                moves = _moves_for(dict(r.payload or {}), RECORD_FILE_FIELDS, "documents", r.property_id or "unfiled")
            except Exception as e:  # noqa: BLE001
                print(f"[asset-files] record {r.id}: {e} - skipped")
                _SKIP.add(r.id)
                continue
            if moves and _commit_moves(db, r, RECORD_FILE_FIELDS, moves):
                done += 1
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
    from leader import is_background_leader
    while True:
        if not is_background_leader():            # one worker moves files, not eight
            await asyncio.sleep(60)
            continue
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
