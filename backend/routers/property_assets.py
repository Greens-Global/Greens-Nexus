"""Asset Management (property portfolio) - Ankush's module.

The frontend (frontend/src/views/AssetModule.jsx) treats its data as one
workspace blob: { properties, warranties, inspections, documents, ahj,
utilities, vendors, logs }. It used to live in the browser's localStorage;
this router moves it to a shared Supabase-backed store so every user sees the
same portfolio.

Storage is intentionally simple: the property objects and each child row are
kept whole in JSON `payload` columns (the data is semi-structured - free-form
snapshot/timeline/permit sheets plus a wide, evolving set of header fields), so
the workspace round-trips losslessly with no per-field schema churn. The
dataset is tiny (~24 properties + a few hundred child rows), so a whole-blob
GET / replace-all PUT is the pragmatic, low-risk shape. Later phases can promote
warranty/inspection date columns for expiry notifications.
"""
import time
import uuid
from datetime import datetime, timezone, date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import require_module_grant
from models import PropertyAsset, PropertyRecord, PropertyActivityLog, PropertyWorkspaceMeta, NexusNotification

router = APIRouter(tags=["Asset Management"])

# Screen access is grant-driven (property-asset Access Group grant); mirror it
# here so the API can't be read/overwritten by users the UI hides it from.
require_asset_read  = require_module_grant("property-asset", "viewer")
require_asset_write = require_module_grant("property-asset", "editor")

# The flat child collections the module persists alongside properties + logs.
# vservice/odometer are the vehicle & equipment service/maintenance + odometer logs.
COLLECTIONS = ["warranties", "inspections", "documents", "ahj", "utilities", "vendors",
               "vservice", "odometer", "vdocs", "maintenance"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Workspace(BaseModel):
    properties: List[Dict[str, Any]] = []
    warranties: List[Dict[str, Any]] = []
    inspections: List[Dict[str, Any]] = []
    documents: List[Dict[str, Any]] = []
    ahj: List[Dict[str, Any]] = []
    utilities: List[Dict[str, Any]] = []
    vendors: List[Dict[str, Any]] = []
    vservice: List[Dict[str, Any]] = []
    odometer: List[Dict[str, Any]] = []
    vdocs: List[Dict[str, Any]] = []
    maintenance: List[Dict[str, Any]] = []
    logs: List[Dict[str, Any]] = []
    # Optimistic-concurrency marker: the server _ts this client's copy is based
    # on. None = legacy client that predates the guard (accepted, so a deploy
    # doesn't hard-break tabs that haven't reloaded yet).
    baseTs: Optional[int] = None


@router.get("/property-assets/workspace")
def get_workspace(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """Return the whole portfolio workspace in the shape the module renders."""
    ws: Dict[str, Any] = {"properties": []}
    for c in COLLECTIONS:
        ws[c] = []
    for p in db.query(PropertyAsset).all():
        obj = dict(p.payload or {})
        obj["id"] = p.id  # the id is the source of truth on the row
        ws["properties"].append(obj)
    for r in db.query(PropertyRecord).all():
        if r.collection in ws:
            ws[r.collection].append(r.payload or {})
    ws["logs"] = [l.payload or {} for l in db.query(PropertyActivityLog).all()]
    # Server-stamped freshness marker - clients pull whenever this moves past the
    # last value they saw (value-only edits move it too, unlike the log count).
    meta = db.get(PropertyWorkspaceMeta, 1)
    ws["_ts"] = (meta.ts if meta else 0) or 0
    return ws


@router.get("/property-assets/workspace/ts")
def get_workspace_ts(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """Just the workspace freshness marker (server epoch ms), from the one-row meta
    table. The module's background poll runs every 7s; having it check THIS first -
    a few bytes - instead of re-pulling the whole portfolio blob (properties +
    records + activity logs) means it only downloads the full workspace when
    something actually changed. That full-blob poll was a top pooler-egress driver."""
    meta = db.get(PropertyWorkspaceMeta, 1)
    return {"_ts": (meta.ts if meta else 0) or 0}


@router.put("/property-assets/workspace")
def put_workspace(ws: Workspace, db: Session = Depends(get_db), user=Depends(require_asset_write)):
    """Replace the whole workspace. Tiny dataset → delete-all + re-insert in one
    request is simplest and matches the module's whole-blob save semantics."""
    now = _now()
    email = (user or {}).get("email", "")

    # Refuse a STALE overwrite: this is a whole-blob replace, so a client whose
    # copy predates the server's would silently erase everything saved since it
    # last pulled (mid-edit sessions suppress pulls, so long sessions get very
    # stale). 409 'stale' → the client pulls, merges by row id, and retries -
    # nobody's work is dropped on either side.
    cur_meta = db.get(PropertyWorkspaceMeta, 1)
    server_ts = (cur_meta.ts if cur_meta else 0) or 0
    if ws.baseTs is not None and server_ts and ws.baseTs < server_ts:
        raise HTTPException(status_code=409,
                            detail="stale: the portfolio changed since this tab last pulled - merge and retry")

    # Refuse a wipe: a client that booted during an outage starts from an EMPTY
    # store, and its first save would replace-all a populated portfolio with
    # nothing. Deleting the genuinely-last asset (server count <= 1) is allowed;
    # 0-over-many can only be a broken client. 409 → the client's sync queue
    # drops the write and re-pulls instead of retrying forever.
    if not ws.properties and db.query(PropertyAsset).count() > 1:
        raise HTTPException(status_code=409, detail="Refusing to replace a populated portfolio with an empty one")

    db.query(PropertyRecord).delete()
    db.query(PropertyActivityLog).delete()
    db.query(PropertyAsset).delete()
    db.flush()

    for p in ws.properties:
        pid = str(p.get("id") or "").strip()
        if not pid:
            continue
        db.add(PropertyAsset(
            id=pid,
            name=str(p.get("name") or ""),
            manager=str(p.get("manager") or ""),
            asset_type=str(p.get("assetType") or ""),
            parent_id=str(p.get("parentId") or ""),
            payload=p,
            updated_at=now,
            updated_by=email,
        ))

    for c in COLLECTIONS:
        for r in (getattr(ws, c) or []):
            rid = str(r.get("id") or "").strip()
            if not rid:
                continue
            db.add(PropertyRecord(
                id=rid,
                property_id=str(r.get("propertyId") or ""),
                collection=c,
                payload=r,
                updated_at=now,
            ))

    for entry in ws.logs:
        lid = str(entry.get("id") or "").strip()
        if not lid:
            continue
        db.add(PropertyActivityLog(
            id=lid,
            property_id=str(entry.get("propertyId") or ""),
            payload=entry,
            created_at=str(entry.get("ts") or now),
        ))

    # Stamp the workspace's freshness marker with SERVER time (epoch ms) so pull
    # decisions never depend on any client's clock.
    ts_ms = int(time.time() * 1000)
    meta = db.get(PropertyWorkspaceMeta, 1)
    if meta is None:
        meta = PropertyWorkspaceMeta(id=1)
        db.add(meta)
    meta.ts = ts_ms
    meta.updated_by = email
    meta.updated_at = now

    db.commit()
    return {"ok": True, "properties": len(ws.properties), "_ts": ts_ms}


def _parse_ymd(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except Exception:
        return None


@router.post("/property-assets/reminders/scan")
def scan_reminders(db: Session = Depends(get_db), user=Depends(require_asset_read)):
    """Run the asset date alerts now. Same targeted logic as the daily scan
    (equipment_reminders.run_asset_alerts): each alert goes to the asset's
    manager (IT Admins when nobody is set), never a broadcast, with the lead
    days from Settings > Equipment Reminders."""
    import equipment_reminders
    created = equipment_reminders.run_asset_alerts(db)
    if created:
        db.commit()
    return {"created": created}
