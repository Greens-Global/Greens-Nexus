"""Asset Management (property portfolio) — Ankush's module.

The frontend (frontend/src/views/AssetModule.jsx) treats its data as one
workspace blob: { properties, warranties, inspections, documents, ahj,
utilities, vendors, logs }. It used to live in the browser's localStorage;
this router moves it to a shared Supabase-backed store so every user sees the
same portfolio.

Storage is intentionally simple: the property objects and each child row are
kept whole in JSON `payload` columns (the data is semi-structured — free-form
snapshot/timeline/permit sheets plus a wide, evolving set of header fields), so
the workspace round-trips losslessly with no per-field schema churn. The
dataset is tiny (~24 properties + a few hundred child rows), so a whole-blob
GET / replace-all PUT is the pragmatic, low-risk shape. Later phases can promote
warranty/inspection date columns for expiry notifications.
"""
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from auth import get_current_user
from models import PropertyAsset, PropertyRecord, PropertyActivityLog

router = APIRouter(tags=["Asset Management"])

# The flat child collections the module persists alongside properties + logs.
COLLECTIONS = ["warranties", "inspections", "documents", "ahj", "utilities", "vendors"]


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
    logs: List[Dict[str, Any]] = []


@router.get("/property-assets/workspace")
def get_workspace(db: Session = Depends(get_db), user=Depends(get_current_user)):
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
    return ws


@router.put("/property-assets/workspace")
def put_workspace(ws: Workspace, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Replace the whole workspace. Tiny dataset → delete-all + re-insert in one
    request is simplest and matches the module's whole-blob save semantics."""
    now = _now()
    email = (user or {}).get("email", "")

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

    db.commit()
    return {"ok": True, "properties": len(ws.properties)}
