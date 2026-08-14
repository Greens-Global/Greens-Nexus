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
    """Scan the portfolio for upcoming/overdue dates and raise ONE deduped bell
    notification per item (broadcast to managers - recipient=''). Idempotent: a
    reminder is keyed by (type, ref_id) so re-running on every module open never
    duplicates. Called by the module on open (Nexus has no scheduler for this)."""
    today = date.today()
    props = {p.id: p for p in db.query(PropertyAsset).all()}
    records = db.query(PropertyRecord).all()
    # Existing asset reminders, so we don't re-create them.
    existing = {
        (n.type, n.ref_id)
        for n in db.query(NexusNotification).filter(NexusNotification.type.like("asset_%")).all()
    }
    created = 0

    def remind(ntype: str, ref_id: str, title: str, body: str, item_name: str):
        nonlocal created
        if (ntype, ref_id) in existing:
            return
        db.add(NexusNotification(
            id=str(uuid.uuid4()), type=ntype, recipient="", title=title, body=body,
            ref_id=ref_id, item_name=item_name, requested_by="", action="",
            actioned=False, read_by="", created_at=datetime.now(timezone.utc).isoformat(),
        ))
        existing.add((ntype, ref_id))
        created += 1

    def pname(pid: str) -> str:
        p = props.get(pid)
        return (p.name if p else "") or pid

    # Warranties expiring within 90 days (or already expired).
    for r in records:
        p = r.payload or {}
        if r.collection == "warranties":
            d = _parse_ymd(p.get("expiration"))
            if d is not None and (d - today).days <= 90:
                nm = pname(r.property_id)
                overdue = (d - today).days < 0
                remind("asset_warranty_expiry", r.id,
                       f"Warranty {'expired' if overdue else 'expiring soon'}: {p.get('scope') or 'warranty'}",
                       f"{nm}: warranty “{p.get('scope', '')}” {'expired' if overdue else 'expires'} {p.get('expiration')}.",
                       nm)
        elif r.collection == "inspections":
            d = _parse_ymd(p.get("nextDue"))
            if d is not None and (d - today).days <= 30:
                nm = pname(r.property_id)
                overdue = (d - today).days < 0
                remind("asset_inspection_due", r.id,
                       f"Inspection {'overdue' if overdue else 'due soon'}: {p.get('type') or 'inspection'}",
                       f"{nm}: “{p.get('type', '')}” {'was due' if overdue else 'is due'} {p.get('nextDue')}.",
                       nm)

    # Vehicle/equipment registration, insurance, and next-service dates (on the asset payload).
    for pid, p in props.items():
        pl = p.payload or {}
        if (pl.get("kind") or "") not in ("vehicle", "equipment"):
            continue
        for key, label, ntype, window in [
            ("regExpiration", "Registration", "asset_reg_expiry", 60),
            ("insExpiration", "Insurance", "asset_ins_expiry", 60),
            ("nextServiceDate", "Service", "asset_service_due", 30),
        ]:
            d = _parse_ymd(pl.get(key))
            if d is not None and (d - today).days <= window:
                overdue = (d - today).days < 0
                remind(ntype, f"{pid}:{key}",
                       f"{label} {'overdue' if overdue else 'due soon'}: {p.name}",
                       f"{p.name}: {label.lower()} date {pl.get(key)}.", p.name)

    if created:
        db.commit()
    return {"created": created}
