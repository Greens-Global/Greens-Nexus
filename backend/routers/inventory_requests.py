import os
import threading
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import httpx
from database import get_db
from auth import get_current_user
from models import InventoryRequest, InventoryItem

# Valid predecessor statuses for each target status — guards against illegal
# jumps like pending -> allocated or re-approving an already-resolved request.
_VALID_TRANSITIONS = {
    "approved":  {"pending"},
    "rejected":  {"pending"},
    "allocated": {"approved"},
    "returned":  {"allocated"},
}

_DAMAGE_KEYWORDS = ("damaged", "broken", "cracked", "lost", "destroyed", "unusable", "retired")


def _reserve_stock(db: Session, item_id: str, qty: int) -> bool:
    """Atomically decrement available_qty, but only if enough stock remains.
    A single UPDATE...WHERE is atomic at the row level in Postgres — no explicit
    locking needed, and it can't race two simultaneous allocations into negative
    stock the way a SELECT-then-UPDATE would."""
    result = db.execute(
        text("UPDATE inventory_items SET available_qty = available_qty - :qty, "
             "last_updated = :now WHERE id = :id AND available_qty >= :qty"),
        {"qty": qty, "id": item_id, "now": datetime.now(timezone.utc).isoformat()},
    )
    return result.rowcount > 0


def _release_stock(db: Session, item_id: str, qty: int, damaged: bool) -> None:
    """Atomically restore stock on return. A damaged/lost/retired unit never
    re-enters circulation — it comes off both available_qty and total_qty."""
    now = datetime.now(timezone.utc).isoformat()
    if damaged:
        db.execute(
            text("UPDATE inventory_items SET total_qty = GREATEST(total_qty - :qty, 0), "
                 "last_updated = :now WHERE id = :id"),
            {"qty": qty, "id": item_id, "now": now},
        )
    else:
        db.execute(
            text("UPDATE inventory_items SET "
                 "available_qty = LEAST(available_qty + :qty, total_qty), "
                 "last_updated = :now WHERE id = :id"),
            {"qty": qty, "id": item_id, "now": now},
        )

_SUPABASE_URL = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")


def _post_inventory_event(request_id: str, status: str, affected_email: str) -> None:
    try:
        httpx.post(
            f"{_SUPABASE_URL}/rest/v1/inventory_events",
            headers={
                "apikey": _SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={
                "request_id": request_id,
                "status": status,
                "affected_email": affected_email,
            },
            timeout=5.0,
        )
    except Exception:
        pass


def _fire_inventory_event(request_id: str, status: str, affected_email: str) -> None:
    """Insert a row into inventory_events so Supabase Realtime notifies clients.
    Fire-and-forget: runs on a background thread so a slow/down Supabase never
    holds the request thread (and its checked-out DB connection) hostage for
    up to 5 seconds — that was compounding pool contention under load."""
    if not _SUPABASE_URL or not _SUPABASE_SERVICE_KEY:
        return
    threading.Thread(
        target=_post_inventory_event,
        args=(request_id, status, affected_email),
        daemon=True,
    ).start()

router = APIRouter(prefix="/inventory-requests", tags=["inventory-requests"], dependencies=[Depends(get_current_user)])


class RequestIn(BaseModel):
    id:                  str
    item_id:             str
    item_name:           str
    requested_by:        str
    requested_by_email:  str = ""
    raised_by:           str
    department:          str
    quantity:            int = 1
    days:                int = 1
    reason:              str = ""


class StatusUpdate(BaseModel):
    status:             str
    resolved_by:        Optional[str] = ""
    reject_reason:      Optional[str] = ""
    allocated_by:       Optional[str] = ""
    return_photo_name:  Optional[str] = ""
    return_photo_url:   Optional[str] = ""
    condition_note:     Optional[str] = ""


def _to_dict(r: InventoryRequest) -> dict:
    return {
        "id":                r.id,
        "itemId":            r.item_id,
        "itemName":          r.item_name,
        "requestedBy":       r.requested_by,
        "requestedByEmail":  r.requested_by_email,
        "raisedBy":          r.raised_by,
        "department":        r.department,
        "quantity":          r.quantity,
        "days":              r.days,
        "reason":            r.reason,
        "status":            r.status,
        "createdAt":         r.created_at,
        "resolvedAt":        r.resolved_at  or None,
        "resolvedBy":        r.resolved_by  or None,
        "rejectReason":      r.reject_reason or None,
        "allocatedAt":       r.allocated_at  or None,
        "allocatedBy":       r.allocated_by  or None,
        "returnedAt":        r.returned_at   or None,
        "returnPhotoName":   r.return_photo_name or None,
        "returnPhotoUrl":    r.return_photo_url  or None,
        "conditionNote":     r.condition_note    or None,
    }


def _item_to_dict(i: InventoryItem) -> dict:
    return {
        "id":         i.id,
        "name":       i.name,
        "category":   i.category,
        "department": i.department,
        "available":  i.available_qty,
        "total":      i.total_qty,
    }


@router.get("/items")
def list_items(db: Session = Depends(get_db)):
    """Live stock levels — the single source of truth for available/total counts.
    Replaces the static mock data the frontend used to carry locally."""
    rows = db.query(InventoryItem).order_by(InventoryItem.department, InventoryItem.name).all()
    return [_item_to_dict(i) for i in rows]


@router.get("")
def list_requests(email: Optional[str] = None, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(InventoryRequest).order_by(InventoryRequest.created_at.desc())
    if user["level"] < 3:
        # Non-managers only see their own requests regardless of email param
        q = q.filter(InventoryRequest.requested_by_email == user["email"])
    elif email:
        # Managers can optionally filter by a specific email
        q = q.filter(InventoryRequest.requested_by_email == email.lower())
    return [_to_dict(r) for r in q.all()]


@router.post("")
def create_request(body: RequestIn, db: Session = Depends(get_db)):
    if db.query(InventoryRequest).filter(InventoryRequest.id == body.id).first():
        raise HTTPException(409, "A request with this id already exists")

    now = datetime.now(timezone.utc).isoformat()
    row = InventoryRequest(
        id=body.id,
        item_id=body.item_id,
        item_name=body.item_name,
        requested_by=body.requested_by,
        requested_by_email=body.requested_by_email.lower(),
        raised_by=body.raised_by,
        department=body.department,
        quantity=body.quantity,
        days=body.days,
        reason=body.reason,
        status="pending",
        created_at=now,
    )
    db.add(row)
    db.commit()
    _fire_inventory_event(row.id, "pending", row.requested_by_email or "")
    return _to_dict(row)


@router.patch("/{req_id}")
def update_request(req_id: str, body: StatusUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(InventoryRequest).filter(InventoryRequest.id == req_id).first()
    if not row:
        return {"ok": False, "error": "not found"}

    if body.status in ("approved", "rejected") and user["level"] < 3:
        raise HTTPException(403, "Manager or above required to approve or reject requests")
    if body.status == "allocated" and user["level"] < 2:
        raise HTTPException(403, "Supervisor or above required to allocate items")
    if body.status == "returned" and user["level"] < 2 and row.requested_by_email.lower() != user["email"]:
        raise HTTPException(403, "You can only return your own items")

    valid_predecessors = _VALID_TRANSITIONS.get(body.status)
    if valid_predecessors is not None and row.status not in valid_predecessors:
        raise HTTPException(409, f"Cannot move a '{row.status}' request to '{body.status}'")

    now = datetime.now(timezone.utc).isoformat()

    if body.status in ("approved", "rejected"):
        row.resolved_at = now
        row.resolved_by = body.resolved_by or ""
        if body.status == "rejected":
            row.reject_reason = body.reject_reason or ""

    elif body.status == "allocated":
        # Reserve stock atomically before flipping status — if there isn't enough
        # available, fail the whole request rather than allocating phantom units.
        if not _reserve_stock(db, row.item_id, row.quantity):
            db.rollback()
            raise HTTPException(409, "Not enough stock available to allocate this request")
        row.allocated_at = now
        row.allocated_by = body.allocated_by or ""

    elif body.status == "returned":
        note = (body.condition_note or "").lower()
        damaged = any(k in note for k in _DAMAGE_KEYWORDS)
        _release_stock(db, row.item_id, row.quantity, damaged)
        row.returned_at       = now
        row.return_photo_name = body.return_photo_name or ""
        row.return_photo_url  = body.return_photo_url  or ""
        row.condition_note    = body.condition_note    or ""

    row.status = body.status
    db.commit()
    _fire_inventory_event(req_id, row.status, row.requested_by_email or "")
    return _to_dict(row)
