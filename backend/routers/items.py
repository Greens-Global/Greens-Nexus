import io
import os
import threading
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import or_, func, text as sa_text
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import httpx
from database import get_db
from auth import get_current_user, require_level_or_module
from models import Item, ItemCheckout, ItemCartEntry, ItemAssignment, NexusRole, NexusNotification, AuditLog

_VALID_TRANSITIONS = {
    "approved":         {"pending"},
    "rejected":         {"pending", "approved"},
    "pending_receipt":  {"approved"},
    "allocated":        {"approved", "pending_receipt"},
    "returned":         {"allocated"},
    "cancelled":        {"pending", "approved", "rejected"},
}

_ROLE_LEVEL = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}

_ITEM_TYPES    = ["Devices", "Tools", "Vehicles", "Equipment", "Keys", "Other"]
_ITEM_STATUSES = ["available", "checked_out", "permanently_assigned", "retired"]

_TYPE_DEFAULT_OWNER = {
    "Devices":   "IT",
    "Tools":     "Construction (MCD)",
    "Vehicles":  "Construction",
    "Equipment": "",
    "Keys":      "Operations (Oversite)",
    "Other":     "",
}

_DAMAGE_KEYWORDS = ("damaged", "broken", "cracked", "lost", "destroyed", "unusable", "retired")

require_items_admin  = require_level_or_module(_ROLE_LEVEL["manager"], "inventory", "editor")
require_items_delete = require_level_or_module(_ROLE_LEVEL["owner"],   "inventory", "full")

_SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Valid photo URL prefix — only allow URLs pointing to our own Supabase storage
# so fake/external evidence cannot be submitted.
_STORAGE_PREFIX = f"{_SUPABASE_URL}/storage/v1/object/public/" if _SUPABASE_URL else None


def _validate_photo_url(url: Optional[str], field: str) -> None:
    """Raise 400 if url is non-empty and does not originate from our storage bucket."""
    if not url or not url.strip():
        return
    if _STORAGE_PREFIX and not url.startswith(_STORAGE_PREFIX):
        raise HTTPException(400, f"{field} must be a Supabase storage URL")


def _notify(db: Session, *, type: str, recipient: str, title: str, body: str,
            ref_id: str = "", item_name: str = "", requested_by: str = "") -> None:
    row = NexusNotification(
        id=str(uuid.uuid4()),
        type=type,
        recipient=recipient.lower() if recipient else "",
        title=title,
        body=body,
        ref_id=ref_id,
        item_name=item_name,
        requested_by=requested_by,
        action="",
        actioned=False,
        read_by="",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(row)


def _title_case_email(email: str) -> str:
    local = email.split("@", 1)[0]
    return " ".join(p.capitalize() for p in local.replace("_", ".").split(".") if p)


def _post_item_event(checkout_id: str, status: str, affected_email: str) -> None:
    try:
        httpx.post(
            f"{_SUPABASE_URL}/rest/v1/inventory_events",
            headers={
                "apikey": _SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            # affected_email deliberately blank: inventory_events is anon-readable
            # for realtime pings, so nothing personal may be written into it.
            # Clients never used the field — they refetch via the authed API.
            json={"request_id": checkout_id, "status": status, "affected_email": ""},
            timeout=5.0,
        )
    except Exception:
        pass


def _fire_item_event(checkout_id: str, status: str, affected_email: str) -> None:
    if not _SUPABASE_URL or not _SUPABASE_SERVICE_KEY:
        return
    threading.Thread(
        target=_post_item_event,
        args=(checkout_id, status, affected_email),
        daemon=True,
    ).start()


router = APIRouter(prefix="/items", tags=["items"], dependencies=[Depends(get_current_user)])


# ── Serialisers ───────────────────────────────────────────────────────────────

def _item_to_dict(i: Item) -> dict:
    return {
        "id":            i.id,
        "name":          i.name,
        "itemType":      i.item_type,
        "make":          i.make,
        "model":         i.model,
        "year":          i.year,
        "department":    i.department,
        "defaultOwner":  i.default_owner,
        "ownershipType": i.ownership_type,
        "status":        i.status,
        "location":      i.location,
        "photoUrl":      i.photo_url,
        "createdBy":     i.created_by,
        "createdAt":     i.created_at,
        "assignedToEmail": i.assigned_to_email or "",
        "assignedToName":  i.assigned_to_name  or "",
        "assignedAt":      i.assigned_at       or "",
        # NULL (pre-migration rows) must read as True — photos required by default
        "pictureRequired": True if i.picture_required is None else bool(i.picture_required),
        "assetValue":      float(i.asset_value or 0),
    }


def _checkout_to_dict(c: ItemCheckout) -> dict:
    return {
        "id":                      c.id,
        "itemId":                  c.item_id,
        "itemName":                c.item_name,
        "itemType":                c.item_type,
        "requestedBy":             c.requested_by,
        "requestedByEmail":        c.requested_by_email,
        "raisedBy":                c.raised_by,
        "department":              c.department,
        "days":                    c.days,
        "reason":                  c.reason,
        "status":                  c.status,
        "createdAt":               c.created_at,
        "resolvedAt":              c.resolved_at              or None,
        "resolvedBy":              c.resolved_by              or None,
        "rejectReason":            c.reject_reason            or None,
        "assignedAllocatorEmail":  c.assigned_allocator_email or None,
        "assignedAllocatorName":   c.assigned_allocator_name  or None,
        "allocatedAt":             c.allocated_at             or None,
        "allocatedBy":             c.allocated_by             or None,
        "checkoutPhotoUrl":        c.checkout_photo_url       or None,
        "checkoutPhotoName":       c.checkout_photo_name      or None,
        "returnedAt":              c.returned_at              or None,
        "returnPhotoUrl":          c.return_photo_url         or None,
        "returnPhotoName":         c.return_photo_name        or None,
        "conditionNote":           c.condition_note           or None,
        "orderId":                 c.order_id                 or "",
        "handoverPhotoBy":         c.handover_photo_by        or "",
        "handoverBatch":           bool(c.handover_batch)     if c.handover_batch is not None else False,
        "receiptPhotoUrl":         c.receipt_photo_url        or None,
        "receiptPhotoName":        c.receipt_photo_name       or None,
        "handedOverAt":            c.handed_over_at           or None,
        "extensionDays":           c.extension_days           or 0,
        "extensionReason":         c.extension_reason         or "",
        "extensionStatus":         c.extension_status         or "",
        "approverEmail":           c.approver_email           or "",
        "approverName":            c.approver_name            or "",
    }


# ── Item CRUD ─────────────────────────────────────────────────────────────────

class ItemCreate(BaseModel):
    name:           str
    item_type:      Optional[str] = "Other"
    make:           Optional[str] = ""
    model:          Optional[str] = ""
    year:           Optional[str] = ""
    department:     Optional[str] = ""
    default_owner:  Optional[str] = ""
    ownership_type: Optional[str] = "transient"
    location:       Optional[str] = ""
    photo_url:      Optional[str] = ""
    picture_required: Optional[bool]  = True
    asset_value:      Optional[float] = 0


class ItemUpdate(BaseModel):
    name:           Optional[str] = None
    item_type:      Optional[str] = None
    make:           Optional[str] = None
    model:          Optional[str] = None
    year:           Optional[str] = None
    department:     Optional[str] = None
    default_owner:  Optional[str] = None
    ownership_type: Optional[str] = None
    status:         Optional[str] = None
    location:       Optional[str] = None
    photo_url:      Optional[str] = None
    picture_required: Optional[bool]  = None
    asset_value:      Optional[float] = None


class ItemImportRow(BaseModel):
    name:           str
    item_type:      Optional[str] = "Other"
    make:           Optional[str] = ""
    model:          Optional[str] = ""
    year:           Optional[str] = ""
    department:     Optional[str] = ""
    default_owner:  Optional[str] = ""
    ownership_type: Optional[str] = "transient"
    location:       Optional[str] = ""


class ItemImportRequest(BaseModel):
    items: list[ItemImportRow]


@router.get("")
def list_items(
    department: Optional[str] = None,
    item_type:  Optional[str] = None,
    status:     Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Item).order_by(Item.department, Item.item_type, Item.name)
    if department:
        q = q.filter(Item.department == department)
    if item_type:
        q = q.filter(Item.item_type == item_type)
    if status:
        q = q.filter(Item.status == status)
    items = q.all()

    # Enrich each item with live checkout activity so ALL users (not just
    # managers who see every checkout) know when an item is taken or under
    # review — prevents submitting a cart that will 409 at the server.
    active_cos = db.query(
        ItemCheckout.item_id,
        ItemCheckout.requested_by,
        ItemCheckout.status,
        ItemCheckout.created_at,
        ItemCheckout.days,
        ItemCheckout.allocated_at,
        ItemCheckout.handed_over_at,
    ).filter(
        ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"])
    ).all()
    active_map = {row.item_id: row for row in active_cos}

    result = []
    for i in items:
        d = _item_to_dict(i)
        co = active_map.get(i.id)
        # hasActiveRequest: true when a checkout blocks new requests (not yet allocated)
        d["hasActiveRequest"] = co is not None and co.status in ("pending", "approved", "pending_receipt")
        # activeRequestedBy / activeDueDate: for "In Use — [Name] — available in X days".
        # The clock starts at physical handover (allocated/handed-over), not at the
        # request — approval delay must not eat into the employee's checkout days.
        d["activeRequestedBy"] = co.requested_by if co else None
        if co and co.days:
            try:
                from datetime import timedelta
                start_iso = co.allocated_at or co.handed_over_at or co.created_at
                start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
                due = start + timedelta(days=int(co.days))
                d["activeDueDate"] = due.isoformat()
            except Exception:
                d["activeDueDate"] = None
        else:
            d["activeDueDate"] = None
        result.append(d)
    return result


@router.post("", status_code=201)
def create_item(body: ItemCreate, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty")
    now = datetime.now(timezone.utc).isoformat()
    item = Item(
        id=str(uuid.uuid4()),
        name=name,
        item_type=(body.item_type or "Other").strip(),
        make=(body.make or "").strip(),
        model=(body.model or "").strip(),
        year=(body.year or "").strip(),
        department=(body.department or "").strip(),
        default_owner=(body.default_owner or "").strip(),
        ownership_type=(body.ownership_type or "transient").strip(),
        # Permanent items start AVAILABLE too — "permanently_assigned" only
        # happens via the assignment flow once a real person accepts it.
        # Auto-stamping it at creation made unassigned items show as assigned.
        status="available",
        location=(body.location or "").strip(),
        photo_url=(body.photo_url or "").strip(),
        created_by=user["email"],
        created_at=now,
        picture_required=True if body.picture_required is None else bool(body.picture_required),
        asset_value=float(body.asset_value or 0),
    )
    db.add(item)
    db.commit()
    return _item_to_dict(item)


@router.post("/import")
def import_items(body: ItemImportRequest, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc).isoformat()
    created = skipped = 0
    for row in body.items:
        name = (row.name or "").strip()
        if not name:
            skipped += 1
            continue
        ownership = (row.ownership_type or "transient").strip().lower()
        if ownership not in ("permanent", "transient"):
            ownership = "transient"
        item_type = (row.item_type or "Other").strip()
        if item_type not in _ITEM_TYPES:
            item_type = "Other"
        db.add(Item(
            id=str(uuid.uuid4()),
            name=name,
            item_type=item_type,
            make=(row.make or "").strip(),
            model=(row.model or "").strip(),
            year=(row.year or "").strip(),
            department=(row.department or "").strip(),
            default_owner=(row.default_owner or _TYPE_DEFAULT_OWNER.get(item_type, "")).strip(),
            ownership_type=ownership,
            status="available",  # assignment flow sets permanently_assigned once accepted
            location=(row.location or "").strip(),
            photo_url="",
            created_by=user["email"],
            created_at=now,
        ))
        created += 1
    db.commit()
    return {"created": created, "skipped": skipped}


# ── Persistent cart (must be before /{item_id} wildcards) ────────────────────

class CartAddBody(BaseModel):
    item_id:   str
    item_name: str
    item_type: str = "Other"

@router.get("/cart")
def get_cart(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = (user.get("preferred_username") or user.get("email") or "").lower()
    rows = db.query(ItemCartEntry).filter(ItemCartEntry.user_email == email).order_by(ItemCartEntry.added_at).all()
    return [{"id": r.id, "itemId": r.item_id, "itemName": r.item_name, "itemType": r.item_type, "addedAt": r.added_at} for r in rows]

@router.post("/cart")
def add_to_cart(body: CartAddBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = (user.get("preferred_username") or user.get("email") or "").lower()
    # Validate item exists and is requestable
    item = db.query(Item).filter(Item.id == body.item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    if item.ownership_type != "transient":
        raise HTTPException(400, "Only transient items can be added to cart")
    if item.status != "available":
        raise HTTPException(409, f'"{item.name}" is not currently available')
    existing = db.query(ItemCartEntry).filter(ItemCartEntry.user_email == email, ItemCartEntry.item_id == body.item_id).first()
    if existing:
        return {"id": existing.id, "itemId": existing.item_id, "itemName": existing.item_name, "itemType": existing.item_type, "addedAt": existing.added_at}
    entry = ItemCartEntry(
        id=str(uuid.uuid4()), user_email=email,
        item_id=body.item_id, item_name=body.item_name, item_type=body.item_type,
        added_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(entry)
    db.commit()
    return {"id": entry.id, "itemId": entry.item_id, "itemName": entry.item_name, "itemType": entry.item_type, "addedAt": entry.added_at}

@router.delete("/cart/{item_id}")
def remove_from_cart(item_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = (user.get("preferred_username") or user.get("email") or "").lower()
    db.query(ItemCartEntry).filter(ItemCartEntry.user_email == email, ItemCartEntry.item_id == item_id).delete()
    db.commit()
    return {"ok": True}

@router.delete("/cart")
def clear_cart(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = (user.get("preferred_username") or user.get("email") or "").lower()
    db.query(ItemCartEntry).filter(ItemCartEntry.user_email == email).delete()
    db.commit()
    return {"ok": True}


@router.patch("/{item_id}")
def update_item(item_id: str, body: ItemUpdate, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    if body.name is not None:
        n = body.name.strip()
        if not n:
            raise HTTPException(400, "Name cannot be empty")
        item.name = n
    if body.item_type  is not None:
        t = body.item_type.strip()
        if t and t not in _ITEM_TYPES:
            raise HTTPException(400, f"Invalid item_type. Must be one of: {', '.join(_ITEM_TYPES)}")
        item.item_type = t
    if body.make           is not None: item.make           = body.make.strip()
    if body.model          is not None: item.model          = body.model.strip()
    if body.year           is not None: item.year           = body.year.strip()
    if body.department     is not None: item.department     = body.department.strip()
    if body.default_owner  is not None: item.default_owner  = body.default_owner.strip()
    if body.ownership_type is not None:
        ot = body.ownership_type.strip().lower()
        if ot and ot not in ("permanent", "transient"):
            raise HTTPException(400, "ownership_type must be 'permanent' or 'transient'")
        item.ownership_type = ot
    if body.status is not None:
        s = body.status.strip()
        if s and s not in _ITEM_STATUSES:
            raise HTTPException(400, f"Invalid status. Must be one of: {', '.join(_ITEM_STATUSES)}")
        item.status = s
    if body.location  is not None: item.location  = body.location.strip()
    if body.photo_url is not None: item.photo_url = body.photo_url.strip()
    if body.picture_required is not None: item.picture_required = bool(body.picture_required)
    if body.asset_value      is not None: item.asset_value      = float(body.asset_value)
    db.commit()
    return _item_to_dict(item)


@router.delete("/{item_id}")
def delete_item(item_id: str, user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    active = db.query(ItemCheckout).filter(
        ItemCheckout.item_id == item_id,
        ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"]),
    ).count()
    if active:
        raise HTTPException(409, "Cannot delete an item with an active checkout against it")
    db.delete(item)
    db.commit()
    return {"ok": True}


# ── Checkouts ─────────────────────────────────────────────────────────────────

class CheckoutIn(BaseModel):
    id:                  Optional[str] = None  # ignored — server generates
    item_id:             str
    item_name:           str
    item_type:           Optional[str] = ""
    requested_by:        str
    requested_by_email:  str = ""
    raised_by:           str
    department:          str = ""
    days:                int = 1
    reason:              str = ""
    checkout_photo_url:  Optional[str] = ""
    checkout_photo_name: Optional[str] = ""
    order_id:            Optional[str] = ""
    approver_email:      Optional[str] = ""   # manager who should receive the approval notification
    approver_name:       Optional[str] = ""

    def validate_days(self):
        if not (1 <= self.days <= 90):
            raise HTTPException(400, "days must be between 1 and 90")

    def validate_lengths(self):
        if len(self.reason) > 1000:
            raise HTTPException(400, "reason too long (max 1000 chars)")
        if len(self.requested_by) > 200:
            raise HTTPException(400, "requested_by too long")


class CheckoutStatusUpdate(BaseModel):
    status:                    str
    resolved_by:               Optional[str] = ""
    reject_reason:             Optional[str] = ""
    assigned_allocator_email:  Optional[str] = ""
    assigned_allocator_name:   Optional[str] = ""
    allocated_by:              Optional[str] = ""
    checkout_photo_url:        Optional[str] = ""
    checkout_photo_name:       Optional[str] = ""
    return_photo_name:         Optional[str] = ""
    return_photo_url:          Optional[str] = ""
    condition_note:            Optional[str] = ""
    handover_photo_by:         Optional[str] = ""   # 'allocator' | 'employee'
    handover_batch:            Optional[bool] = False
    receipt_photo_url:         Optional[str] = ""
    receipt_photo_name:        Optional[str] = ""
    handed_over_at:            Optional[str] = ""


@router.get("/checkouts")
def list_checkouts(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(ItemCheckout).order_by(ItemCheckout.created_at.desc())
    if user["level"] < 3:
        q = q.filter(or_(
            ItemCheckout.requested_by_email == user["email"],
            ItemCheckout.assigned_allocator_email == user["email"],
        ))
    return [_checkout_to_dict(c) for c in q.limit(2000).all()]


@router.post("/checkouts", status_code=201)
def create_checkout(body: CheckoutIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    body.validate_days()
    body.validate_lengths()
    if not body.reason.strip():
        raise HTTPException(400, "Reason for checkout is required")

    # Server always generates the checkout ID — client-supplied IDs are ignored
    # to prevent ID injection / collision attacks.
    server_id = f"ICHK-{uuid.uuid4().hex[:8].upper()}-{uuid.uuid4().hex[:8].upper()}"

    item = db.query(Item).filter(Item.id == body.item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    if item.ownership_type != "transient":
        raise HTTPException(400, "Only transient items can be checked out")
    if item.status != "available":
        raise HTTPException(409, f'"{item.name}" is no longer available — it may have just been taken by someone else')

    # Verify no active checkout exists for this item (race condition guard)
    active = db.query(ItemCheckout).filter(
        ItemCheckout.item_id == body.item_id,
        ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"]),
    ).first()
    if active:
        raise HTTPException(409, f'"{item.name}" already has an active checkout request')
    live_assignment = db.query(ItemAssignment).filter(
        ItemAssignment.item_id == body.item_id,
        ItemAssignment.status.in_(["pending_acceptance", "active", "return_initiated"]),
    ).first()
    if live_assignment:
        raise HTTPException(409, f'"{item.name}" is permanently assigned and cannot be checked out')

    now = datetime.now(timezone.utc).isoformat()
    # Managers and above don't need a separate approval for their own checkouts
    is_manager = user.get("level", 1) >= 3
    requester_email = body.requested_by_email.lower()
    user_email = user.get("email", "").lower()
    self_checkout = is_manager and requester_email == user_email
    initial_status = "approved" if self_checkout else "pending"

    order_id = (body.order_id or "").strip()
    row = ItemCheckout(
        id=server_id,
        item_id=body.item_id,
        item_name=body.item_name,
        item_type=body.item_type or "",
        requested_by=body.requested_by,
        requested_by_email=requester_email,
        raised_by=body.raised_by,
        department=body.department,
        days=body.days,
        reason=body.reason,
        status=initial_status,
        created_at=now,
        resolved_at=now if self_checkout else "",
        resolved_by=body.requested_by if self_checkout else "",
        checkout_photo_url=body.checkout_photo_url or "",
        checkout_photo_name=body.checkout_photo_name or "",
        order_id=order_id,
        approver_email=(body.approver_email or "").lower().strip(),
        approver_name=(body.approver_name or "").strip(),
    )
    db.add(row)
    if initial_status == "pending":
        # One notification per order — if this order_id already has a checkout_pending
        # notification, skip to avoid spamming managers with N alerts for one cart.
        # Cart submits POST all items concurrently, so take an advisory lock on the
        # order_id first; otherwise every request sees "no notification yet" and
        # the dedupe check races into N duplicates.
        if order_id and db.get_bind().dialect.name == "postgresql":
            db.execute(sa_text("SELECT pg_advisory_xact_lock(hashtext(:oid))"), {"oid": order_id})
        ref_for_notif = order_id if order_id else server_id
        # Only an UN-actioned notification counts as "already notified" — a
        # re-request rejoining an old order must ping the manager again even
        # though the order's original notification was long since handled.
        already_notified = order_id and db.query(NexusNotification).filter(
            NexusNotification.ref_id == order_id,
            NexusNotification.type == "checkout_pending",
            NexusNotification.actioned == False,
        ).first()
        if not already_notified:
            # Targeted: only the manager the employee picked gets the notification.
            # Empty approver (legacy clients / managers raising on behalf) falls back
            # to the all-managers broadcast. The request itself remains visible in
            # every manager's Checkouts tab regardless — anyone can still approve.
            _notify(db, type="checkout_pending", recipient=(body.approver_email or "").lower().strip(),
                    title=f"Checkout Request — {body.requested_by}",
                    body=f"{body.requested_by} has submitted a Checkout Request. Please review, approve or reject.",
                    ref_id=ref_for_notif, item_name=body.item_name, requested_by=body.requested_by)
    db.commit()
    _fire_item_event(server_id, initial_status, row.requested_by_email or "")
    return _checkout_to_dict(row)


@router.patch("/checkouts/{checkout_id}")
def update_checkout(checkout_id: str, body: CheckoutStatusUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(ItemCheckout).filter(ItemCheckout.id == checkout_id).first()
    if not row:
        return {"ok": False, "error": "not found"}

    if row.order_id:
        # Serialize concurrent updates within the same order. "Approve All" /
        # "Hand Over All" / "Return All" fire one PATCH per item in parallel;
        # without this lock each transaction reads its siblings as unchanged
        # and the order-level notification batching below double-fires (one
        # notification per item instead of one per order). FOR UPDATE makes
        # the transactions queue, so each sees the previous one's commit.
        db.query(ItemCheckout).filter(
            ItemCheckout.order_id == row.order_id
        ).with_for_update().all()
        db.refresh(row)

    # Validate photo URLs to prevent fake evidence from external sources
    _validate_photo_url(body.checkout_photo_url, "checkout_photo_url")
    _validate_photo_url(body.receipt_photo_url,  "receipt_photo_url")
    _validate_photo_url(body.return_photo_url,   "return_photo_url")

    if body.status in ("approved", "rejected") and user["level"] < 3:
        raise HTTPException(403, "Manager or above required to approve or reject checkouts")
    if body.status == "approved" and not (body.assigned_allocator_email or "").strip():
        raise HTTPException(400, "Pick who should allocate this item before approving")
    if body.status == "pending_receipt":
        is_assignee = row.assigned_allocator_email and row.assigned_allocator_email.lower() == user["email"]
        if not is_assignee and user["level"] < 3:
            raise HTTPException(403, "Only the assigned allocator or a manager can initiate handover")
    if body.status == "allocated":
        is_assignee  = row.assigned_allocator_email and row.assigned_allocator_email.lower() == user["email"]
        is_requester = row.requested_by_email and row.requested_by_email.lower() == user["email"]
        if not is_assignee and not is_requester and user["level"] < 3:
            raise HTTPException(403, "Only the assigned allocator, the requester, or a manager can confirm handover")
    if body.status == "returned" and user["level"] < 2 and row.requested_by_email.lower() != user["email"]:
        raise HTTPException(403, "You can only return your own items")
    if body.status == "cancelled" and row.requested_by_email.lower() != user["email"]:
        raise HTTPException(403, "You can only cancel your own checkouts")

    valid_predecessors = _VALID_TRANSITIONS.get(body.status)
    if valid_predecessors is not None and row.status not in valid_predecessors:
        raise HTTPException(409, f"Cannot move a '{row.status}' checkout to '{body.status}'")

    now = datetime.now(timezone.utc).isoformat()
    item = db.query(Item).filter(Item.id == row.item_id).first()

    if body.status in ("approved", "rejected"):
        row.resolved_at = now
        row.resolved_by = body.resolved_by or ""
        if body.status == "approved":
            row.assigned_allocator_email = (body.assigned_allocator_email or "").lower().strip()
            row.assigned_allocator_name  = (body.assigned_allocator_name  or "").strip()
        else:
            row.reject_reason = body.reject_reason or ""

    elif body.status == "cancelled":
        row.resolved_at = now
        row.resolved_by = body.resolved_by or ""

    elif body.status == "pending_receipt":
        # Supervisor confirmed physical handover; employee will upload receipt photo
        row.handed_over_at    = now
        row.handover_photo_by = "employee"
        row.handover_batch    = bool(body.handover_batch)
        if body.checkout_photo_url:
            row.checkout_photo_url  = body.checkout_photo_url
            row.checkout_photo_name = body.checkout_photo_name or ""
        row.allocated_by = body.allocated_by or ""

    elif body.status == "allocated":
        coming_from_pending_receipt = row.status == "pending_receipt"
        if not coming_from_pending_receipt:
            # Direct allocator-photo handover: item must still be available
            if item and item.status != "available":
                raise HTTPException(409, "Item is no longer available to allocate")
            row.handed_over_at    = now
            row.handover_photo_by = body.handover_photo_by or "allocator"
            row.handover_batch    = bool(body.handover_batch)
            if body.checkout_photo_url:
                row.checkout_photo_url  = body.checkout_photo_url
                row.checkout_photo_name = body.checkout_photo_name or ""
        else:
            # Employee confirming receipt after supervisor initiated handover
            row.receipt_photo_url  = body.receipt_photo_url  or ""
            row.receipt_photo_name = body.receipt_photo_name or ""
        row.allocated_at = now
        row.allocated_by = body.allocated_by or row.allocated_by or ""
        if item:
            item.status = "checked_out"

    elif body.status == "returned":
        note = (body.condition_note or "").lower()
        damaged = any(k in note for k in _DAMAGE_KEYWORDS)
        row.returned_at      = now
        row.return_photo_name = body.return_photo_name or ""
        row.return_photo_url  = body.return_photo_url  or ""
        row.condition_note   = body.condition_note    or ""
        if item:
            item.status = "retired" if damaged else "available"
        # A pending extension is moot once the item is back — clear it and
        # action the managers' extension notification so it leaves their bell.
        if row.extension_status == "pending":
            row.extension_days   = 0
            row.extension_reason = ""
            row.extension_status = ""
            stale_ext = db.query(NexusNotification).filter(
                NexusNotification.type == "extension_pending",
                NexusNotification.actioned == False,
                NexusNotification.ref_id == checkout_id,
            ).first()
            if stale_ext:
                stale_ext.actioned = True

    row.status = body.status

    # Auto-mark the checkout_pending notification as actioned so it clears from
    # all managers' bells even when the approval happens via the Checkouts tab.
    # For order-level approvals: mark actioned once ALL items in the order are
    # no longer pending (handles item-by-item approval from the Checkouts tab).
    if body.status in ("approved", "rejected", "cancelled"):
        ref_ids = [checkout_id]
        if row.order_id:
            ref_ids.append(row.order_id)
            # Check if any sibling items in this order are still pending
            sibling_pending = db.query(ItemCheckout).filter(
                ItemCheckout.order_id == row.order_id,
                ItemCheckout.id != checkout_id,
                ItemCheckout.status == "pending",
            ).count()
            if sibling_pending > 0:
                ref_ids = []  # don't action yet — order not fully resolved
        if ref_ids:
            pending_notif = db.query(NexusNotification).filter(
                NexusNotification.type == "checkout_pending",
                NexusNotification.actioned == False,
                NexusNotification.ref_id.in_(ref_ids),
            ).first()
            if pending_notif:
                pending_notif.actioned = True

    if body.status in ("approved", "rejected"):
        if row.order_id:
            # Tally all siblings' current status (not yet committed — exclude current item)
            siblings = db.query(ItemCheckout).filter(
                ItemCheckout.order_id == row.order_id,
                ItemCheckout.id != checkout_id,
            ).all()
            approved_names = [s.item_name for s in siblings if s.status == "approved"]
            rejected_names = [s.item_name for s in siblings if s.status == "rejected"]
            still_pending  = [s.item_name for s in siblings if s.status == "pending"]

            # Add current item to the right bucket
            if body.status == "approved":
                approved_names.append(row.item_name)
            else:
                rejected_names.append(row.item_name)

            all_resolved = len(still_pending) == 0

            # Build title and body. Neil: say "request", not "order", and put
            # Approved / Not approved on separate lines (bell renders pre-line).
            if all_resolved:
                if approved_names and rejected_names:
                    notif_type = "approved"
                    notif_title = f"Request update: {len(approved_names)} approved, {len(rejected_names)} rejected"
                    parts = []
                    if approved_names:
                        parts.append(f"Approved: {', '.join(approved_names)}")
                    if rejected_names:
                        parts.append(f"Not approved: {', '.join(rejected_names)}")
                    notif_body = "\n".join(parts)
                elif approved_names:
                    notif_type = "approved"
                    notif_title = f"Request approved: {len(approved_names)} item{'s' if len(approved_names) != 1 else ''}"
                    notif_body = f"All {len(approved_names)} items from your request were approved. Your allocator will hand them over shortly."
                else:
                    notif_type = "rejected"
                    notif_title = f"Request rejected: {len(rejected_names)} item{'s' if len(rejected_names) != 1 else ''}"
                    notif_body = f"Your {len(rejected_names)}-item request was not approved.\nReason: {row.reject_reason or 'No reason given.'}"
            else:
                total = len(approved_names) + len(rejected_names) + len(still_pending)
                notif_type = "approved" if approved_names else "rejected"
                notif_title = f"Request partially processed — {len(approved_names) + len(rejected_names)} of {total} items"
                parts = []
                if approved_names:
                    parts.append(f"Approved: {', '.join(approved_names)}")
                if rejected_names:
                    parts.append(f"Not approved: {', '.join(rejected_names)}")
                parts.append(f"Still pending: {', '.join(still_pending)}")
                notif_body = "\n".join(parts)

            # Update existing order notification if one exists, otherwise create
            existing = db.query(NexusNotification).filter(
                NexusNotification.ref_id == row.order_id,
                NexusNotification.recipient == (row.requested_by_email or "").lower(),
                NexusNotification.type.in_(["approved", "rejected"]),
                NexusNotification.actioned == False,
            ).first()
            if existing:
                existing.type    = notif_type
                existing.title   = notif_title
                existing.body    = notif_body
                existing.read_by = ""  # re-surface as unread
            else:
                _notify(db, type=notif_type, recipient=row.requested_by_email,
                        title=notif_title, body=notif_body,
                        ref_id=row.order_id, item_name=row.item_name, requested_by=row.requested_by)

            # Allocator notification — one updating notification per order, listing
            # every item assigned to them, instead of one ping per item.
            if body.status == "approved" and row.assigned_allocator_email:
                alloc_email = row.assigned_allocator_email.lower()
                assigned_names = [s.item_name for s in siblings
                                  if s.status == "approved" and (s.assigned_allocator_email or "").lower() == alloc_email]
                assigned_names.append(row.item_name)
                if len(assigned_names) == 1:
                    alloc_title = f"Hand over: {row.item_name}"
                    alloc_body  = f"Please hand {row.item_name} over to {row.requested_by}."
                else:
                    alloc_title = f"Hand over {len(assigned_names)} items to {row.requested_by}"
                    alloc_body  = f"Please hand over: {', '.join(assigned_names)}."
                existing_alloc = db.query(NexusNotification).filter(
                    NexusNotification.ref_id == row.order_id,
                    NexusNotification.recipient == alloc_email,
                    NexusNotification.type == "allocate_request",
                    NexusNotification.actioned == False,
                ).first()
                if existing_alloc:
                    existing_alloc.title   = alloc_title
                    existing_alloc.body    = alloc_body
                    existing_alloc.read_by = ""
                else:
                    _notify(db, type="allocate_request", recipient=row.assigned_allocator_email,
                            title=alloc_title, body=alloc_body,
                            ref_id=row.order_id, item_name=row.item_name, requested_by=row.requested_by)
        else:
            # Solo item (no order) — one notification per action
            if body.status == "approved":
                _notify(db, type="approved", recipient=row.requested_by_email,
                        title=f"Checkout approved: {row.item_name}",
                        body=f"Your request for {row.item_name} was approved. {row.assigned_allocator_name or 'Someone'} will hand it over to you.",
                        ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
                if row.assigned_allocator_email:
                    _notify(db, type="allocate_request", recipient=row.assigned_allocator_email,
                            title=f"Hand over: {row.item_name}",
                            body=f"Please hand {row.item_name} over to {row.requested_by}.",
                            ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
            else:
                _notify(db, type="rejected", recipient=row.requested_by_email,
                        title=f"Checkout rejected: {row.item_name}",
                        body=f"Your request for {row.item_name} was not approved. Reason: {row.reject_reason or 'No reason given.'}",
                        ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
    elif body.status == "pending_receipt":
        if row.order_id:
            # One updating "confirm receipt" notification per order. The old
            # last-item-only gate meant handing over PART of an order produced
            # no notification at all — the missed-notification bug from the
            # Jun 10 demo. Same update-in-place pattern as approvals/returns;
            # the FOR UPDATE lock at the top of this endpoint makes it race-safe.
            handed = db.query(ItemCheckout).filter(
                ItemCheckout.order_id == row.order_id,
                ItemCheckout.id != checkout_id,
                ItemCheckout.status == "pending_receipt",
            ).count() + 1  # +1 for current row (autoflush off — not yet visible)
            notif_title = f"Confirm receipt: {handed} item{'s' if handed != 1 else ''}"
            notif_body = (f"{row.item_name} has been handed over. Please confirm receipt and upload a photo." if handed == 1
                          else f"{handed} items from your request have been handed over. Please confirm receipt and upload a photo for each.")
            existing = db.query(NexusNotification).filter(
                NexusNotification.ref_id == row.order_id,
                NexusNotification.recipient == (row.requested_by_email or "").lower(),
                NexusNotification.type == "allocated",
                NexusNotification.actioned == False,
            ).first()
            if existing:
                existing.title   = notif_title
                existing.body    = notif_body
                existing.read_by = ""  # re-surface as unread
            else:
                _notify(db, type="allocated", recipient=row.requested_by_email,
                        title=notif_title, body=notif_body,
                        ref_id=row.order_id, item_name=row.item_name, requested_by=row.requested_by)
        else:
            _notify(db, type="allocated", recipient=row.requested_by_email,
                    title=f"Confirm receipt: {row.item_name}",
                    body=f"{row.item_name} has been handed over to you. Please confirm receipt and upload a photo.",
                    ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
    elif body.status == "allocated":
        # For order batches: only notify once, when ALL items in the order are allocated
        if row.order_id:
            sibling_not_allocated = db.query(ItemCheckout).filter(
                ItemCheckout.order_id == row.order_id,
                ItemCheckout.id != checkout_id,
                ItemCheckout.status.notin_(["allocated", "returned", "cancelled"]),
            ).count()
            if sibling_not_allocated == 0:
                # All items now allocated — send one consolidated notification
                order_count = db.query(ItemCheckout).filter(
                    ItemCheckout.order_id == row.order_id,
                    ItemCheckout.status == "allocated",
                ).count() + 1  # +1 for current item (not yet committed)
                _notify(db, type="allocated", recipient=row.requested_by_email,
                        title=f"Request confirmed: {order_count} item{'' if order_count == 1 else 's'} with you",
                        body=f"All {order_count} items from your request are confirmed. Please return them within {row.days} day(s).",
                        ref_id=row.order_id, item_name=row.item_name, requested_by=row.requested_by)
            # else: don't send individual notifications mid-batch
        else:
            _notify(db, type="allocated", recipient=row.requested_by_email,
                    title=f"Item confirmed: {row.item_name}",
                    body=f"{row.item_name} checkout is complete. Please return it within {row.days} day(s).",
                    ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
    elif body.status == "returned":
        # Only notify the allocator — skip if unset to avoid broadcasting to all users
        if row.assigned_allocator_email:
            if row.order_id:
                # One updating notification per order: tally as items come back
                siblings = db.query(ItemCheckout).filter(
                    ItemCheckout.order_id == row.order_id,
                    ItemCheckout.id != checkout_id,
                ).all()
                returned_names = [s.item_name for s in siblings if s.status == "returned"] + [row.item_name]
                still_out      = [s.item_name for s in siblings if s.status in ("approved", "pending_receipt", "allocated")]

                if still_out:
                    total = len(returned_names) + len(still_out)
                    notif_title = f"Returns in progress: {len(returned_names)} of {total} items back"
                    notif_body  = (f"{row.requested_by} returned: {', '.join(returned_names)}. "
                                   f"Still out: {', '.join(still_out)}.")
                else:
                    notif_title = f"Request returned: {len(returned_names)} item{'s' if len(returned_names) != 1 else ''}"
                    notif_body  = (f"{row.requested_by} returned all {len(returned_names)} items: "
                                   f"{', '.join(returned_names)}."
                                   + (f" Condition: {row.condition_note}" if row.condition_note else ""))

                existing = db.query(NexusNotification).filter(
                    NexusNotification.ref_id == row.order_id,
                    NexusNotification.recipient == (row.assigned_allocator_email or "").lower(),
                    NexusNotification.type == "item_returned",
                    NexusNotification.actioned == False,
                ).first()
                if existing:
                    existing.title   = notif_title
                    existing.body    = notif_body
                    existing.read_by = ""  # re-surface as unread
                else:
                    _notify(db, type="item_returned", recipient=row.assigned_allocator_email,
                            title=notif_title, body=notif_body,
                            ref_id=row.order_id, item_name=row.item_name, requested_by=row.requested_by)
            else:
                _notify(db, type="item_returned", recipient=row.assigned_allocator_email,
                        title=f"Item returned: {row.item_name}",
                        body=f"{row.requested_by} returned {row.item_name}. Condition: {row.condition_note or 'No notes.'}",
                        ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)

    db.commit()
    _fire_item_event(checkout_id, row.status, row.requested_by_email or "")
    return _checkout_to_dict(row)


# ── Extension requests ────────────────────────────────────────────────────────

class ExtensionRequest(BaseModel):
    days:   int
    reason: Optional[str] = ""


class ExtensionResolve(BaseModel):
    action: str                      # 'approve' | 'reject'
    note:   Optional[str] = ""


@router.post("/checkouts/{checkout_id}/extension")
def request_extension(checkout_id: str, body: ExtensionRequest, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Employee asks for more days on an item they currently hold."""
    row = db.query(ItemCheckout).filter(ItemCheckout.id == checkout_id).first()
    if not row:
        raise HTTPException(404, "Checkout not found")
    if row.status != "allocated":
        raise HTTPException(400, "Extensions can only be requested for items in use")
    if (row.requested_by_email or "").lower() != user["email"].lower() and user["level"] < _ROLE_LEVEL["manager"]:
        raise HTTPException(403, "Only the person holding the item can request an extension")
    if row.extension_status == "pending":
        raise HTTPException(400, "An extension request is already awaiting approval")
    if not (body.reason or "").strip():
        raise HTTPException(400, "A reason is required to request an extension")
    days = max(1, min(90, int(body.days or 1)))

    row.extension_days   = days
    row.extension_reason = (body.reason or "").strip()
    row.extension_status = "pending"

    # Neil: title leads with the ITEM and the days — the requester is already
    # shown on the card. Reason goes on its own line (bell renders pre-line).
    _notify(db, type="extension_pending", recipient="",
            title=f"Extension Request — {row.item_name} (+{days} day{'s' if days != 1 else ''})",
            body=f"{row.requested_by} requested {days} more day{'s' if days != 1 else ''} for {row.item_name}."
                 + (f"\nReason: {row.extension_reason}" if row.extension_reason else ""),
            ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)

    db.commit()
    _fire_item_event(checkout_id, row.status, row.requested_by_email or "")
    return _checkout_to_dict(row)


@router.post("/checkouts/{checkout_id}/extension/resolve")
def resolve_extension(checkout_id: str, body: ExtensionResolve, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Manager approves or rejects a pending extension request."""
    if user["level"] < _ROLE_LEVEL["manager"]:
        raise HTTPException(403, "Manager or above required to resolve extensions")
    # Row lock: two managers resolving the same extension concurrently must not
    # both pass the pending check (approve twice = days added twice).
    row = db.query(ItemCheckout).filter(ItemCheckout.id == checkout_id).with_for_update().first()
    if not row:
        raise HTTPException(404, "Checkout not found")
    if row.extension_status != "pending":
        raise HTTPException(400, "No pending extension request on this checkout")

    action = (body.action or "").lower().strip()
    if action not in ("approve", "reject"):
        raise HTTPException(400, "action must be 'approve' or 'reject'")

    ext_days = row.extension_days or 0
    if action == "approve":
        row.days = (row.days or 1) + ext_days
        _notify(db, type="extension_approved", recipient=row.requested_by_email,
                title=f"Extension approved: {row.item_name}",
                body=f"Your extension of {ext_days} day{'s' if ext_days != 1 else ''} for {row.item_name} was approved. New checkout period: {row.days} days.",
                ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
    else:
        _notify(db, type="extension_declined", recipient=row.requested_by_email,
                title=f"Extension declined: {row.item_name}",
                body=f"Your extension request for {row.item_name} was declined."
                     + (f" Note: {body.note.strip()}" if (body.note or "").strip() else "")
                     + " Please return the item by the original due date.",
                ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)

    row.extension_days   = 0
    row.extension_reason = ""
    row.extension_status = ""

    # Clear the managers' extension_pending notification
    pending_notif = db.query(NexusNotification).filter(
        NexusNotification.type == "extension_pending",
        NexusNotification.actioned == False,
        NexusNotification.ref_id == checkout_id,
    ).first()
    if pending_notif:
        pending_notif.actioned = True

    db.commit()
    _fire_item_event(checkout_id, row.status, row.requested_by_email or "")
    return _checkout_to_dict(row)


# ── AI photo fill ─────────────────────────────────────────────────────────────
# Claude (with web search) finds the manufacturer's product image for items
# missing a photo; we download it into our own Supabase bucket so the catalog
# never hot-links external URLs. These are stock photos — managers can replace
# them with real unit photos via Assign Photos at any time.

_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_GOOGLE_CSE_KEY    = os.getenv("GOOGLE_CSE_KEY", "")   # Google Custom Search JSON API key
_GOOGLE_CSE_CX     = os.getenv("GOOGLE_CSE_CX", "")    # Programmable Search Engine id (image search on)
_IMG_CTYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


def _google_image_candidates(query: str, errors: Optional[list] = None) -> list:
    """Direct product-image URLs via the official Google image search API —
    the most reliable source when configured (retail sites bot-wall scrapers).
    Failures are recorded in `errors` so quota exhaustion is visible instead of
    masquerading as "no results"."""
    if not _GOOGLE_CSE_KEY or not _GOOGLE_CSE_CX:
        return []
    try:
        with httpx.Client(timeout=20) as client:
            r = client.get("https://www.googleapis.com/customsearch/v1", params={
                "key": _GOOGLE_CSE_KEY, "cx": _GOOGLE_CSE_CX,
                "q": query, "searchType": "image", "num": 5, "safe": "active",
            })
            if r.status_code != 200:
                if errors is not None:
                    try:
                        msg = r.json().get("error", {}).get("message", "")[:160]
                    except Exception:
                        msg = r.text[:160]
                    errors.append(f"google {r.status_code}: {msg}")
                return []
            return [it.get("link", "") for it in r.json().get("items", []) if it.get("link")]
    except Exception as e:
        if errors is not None:
            errors.append(f"google exc: {str(e)[:120]}")
        return []


def _openverse_image_candidates(query: str) -> list:
    """Keyless CC-image fallback — usually a photo of a similar model rather
    than the exact product render, but beats no photo at all."""
    try:
        with httpx.Client(timeout=20) as client:
            r = client.get("https://api.openverse.org/v1/images/", params={"q": query, "page_size": 5})
            if r.status_code != 200:
                return []
            return [res.get("url", "") for res in r.json().get("results", []) if res.get("url")]
    except Exception:
        return []


def _find_product_page_urls(item) -> list:
    """Ask Claude (web search enabled) for candidate product pages — we then try
    each one's preview image until one validates. Amazon is excluded (bot-walls
    every server-side fetch); retail/manufacturer pages with og:image work."""
    import re
    desc = " ".join(x for x in [item.make, item.model, item.name] if x).strip() or item.name
    payload = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1024,
        "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
        "messages": [{
            "role": "user",
            "content": (
                f"Search the web for this product: {desc}. "
                "Give me up to 3 product page URLs that clearly show this product — prefer retailer "
                "product pages (Grainger, Acme Tools, Zoro, Toolstop, eBay listings, CDW, B&H) or the "
                "manufacturer's page. Do NOT use amazon.com links (they block automated access). "
                "Direct image URLs (.jpg/.png/.webp) are even better if you find them. "
                "Reply with ONLY the URLs, one per line, nothing else. If you find nothing, reply NONE."
            ),
        }],
    }
    import time
    data = None
    with httpx.Client(timeout=60) as client:
        for attempt in range(3):
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": _ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json=payload,
            )
            if r.status_code == 429 and attempt < 2:
                # Tier-1 API keys have tight per-minute limits — wait and retry,
                # but capped so a single item never approaches the HTTP timeout
                wait = min(float(r.headers.get("retry-after", 15)), 30)
                time.sleep(wait)
                continue
            r.raise_for_status()
            data = r.json()
            break
    if data is None:
        return []
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    urls = [u.rstrip(").,]") for u in re.findall(r"https?://[^\s\"'<>]+", text)]
    # Drop amazon links if Claude ignored the instruction
    return [u for u in urls if "amazon." not in u.lower()][:3]


# Image URLs that are obviously NOT product photos (site chrome) — reject them
_BAD_IMG_HINTS = ("logo", "sprite", "icon", "favicon", "placeholder", "badge", "banner")


def _looks_like_junk_image(url: str) -> bool:
    low = url.lower()
    return any(h in low for h in _BAD_IMG_HINTS) or low.endswith((".svg", ".gif"))


def _fetch_image_to_storage(img_url: str, item_id: str, _depth: int = 0) -> str:
    """Download an image (following one og:image hop if Claude gave a page URL)
    and store it in the item-photos bucket. Returns the public URL or ''."""
    import re
    from urllib.parse import urljoin
    if _depth > 1 or not img_url:
        return ""
    # verify=False ONLY for third-party product sites — many retail/manufacturer
    # sites serve incomplete cert chains that strict validation rejects (browsers
    # AIA-fetch the intermediates, Python doesn't). Risk is negligible here: the
    # payload is a public stock photo, content-type and size validated below,
    # and reviewed by a manager. Our Anthropic/Supabase calls keep strict TLS.
    with httpx.Client(timeout=10, follow_redirects=True, verify=False) as client:
        try:
            resp = client.get(img_url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                "Accept": "text/html,image/avif,image/webp,image/*,*/*;q=0.8",
            })
            if resp.status_code in (403, 429):
                # Wikimedia (and friends) block fake browser UAs from datacenter
                # IPs but serve honest, descriptive bot UAs per their policy
                resp = client.get(img_url, headers={
                    "User-Agent": "GreensNexusCatalogBot/1.0 (+https://nexus.greensglobal.com; internal asset catalog)",
                    "Accept": "image/*,text/html;q=0.5",
                })
        except httpx.HTTPError:
            return ""  # slow/dead host — fail fast, the caller tries the next candidate
        if resp.status_code != 200:
            return ""
        ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype.startswith("text/html"):
            # Got a product page instead of an image — collect candidate images in
            # quality order: JSON-LD product image, og:image, twitter:image. Skip
            # obvious site chrome (logos, icons, .svg/.gif).
            html = resp.text
            candidates = []
            for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S):
                m = re.search(r'"image"\s*:\s*\[?\s*"(https?://[^"]+)"', block)
                if m:
                    candidates.append(m.group(1))
            for pat in (
                r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)',
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image(?::secure_url)?["\']',
                r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)',
                r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)',
            ):
                m = re.search(pat, html)
                if m:
                    candidates.append(m.group(1))
            for cand in candidates:
                resolved = urljoin(str(resp.url), cand)
                if _looks_like_junk_image(resolved):
                    continue
                got = _fetch_image_to_storage(resolved, item_id, _depth + 1)
                if got:
                    return got
            return ""
        if ctype not in _IMG_CTYPES:
            return ""
        content = resp.content
        if len(content) < 8 * 1024 or len(content) > 8 * 1024 * 1024:
            return ""  # tracking pixel / logo-sized, or unreasonably large
        path = f"item-photos/ai-{item_id}-{uuid.uuid4().hex[:6]}.{_IMG_CTYPES[ctype]}"
    # Upload on a SEPARATE client with strict TLS — verify=False above is only
    # for the third-party retail sites, never for our own infrastructure.
    with httpx.Client(timeout=30) as upload_client:
        up = upload_client.post(
            f"{_SUPABASE_URL}/storage/v1/object/item-photos/{path}",
            headers={
                "Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}",
                "apikey": _SUPABASE_SERVICE_KEY,
                "Content-Type": ctype,
                "x-upsert": "true",
                "cache-control": "max-age=31536000",  # unique paths — browsers cache immutably
            },
            content=content,
        )
        if up.status_code not in (200, 201):
            return ""
        return f"{_SUPABASE_URL}/storage/v1/object/public/item-photos/{path}"


class AutoPhotoRequest(BaseModel):
    item_ids: list[str]
    replace:  bool = False   # True → overwrite existing photos (manager selected specific rows)


@router.post("/auto-photos")
def auto_fill_photos(body: AutoPhotoRequest, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    if not _ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI photo fill is not configured — add ANTHROPIC_API_KEY to the backend app settings")
    if not _SUPABASE_URL or not _SUPABASE_SERVICE_KEY:
        raise HTTPException(503, "Supabase storage is not configured on the backend")

    results = []
    for item_id in body.item_ids[:5]:  # cap per call — the client batches
        item = db.query(Item).filter(Item.id == item_id).first()
        if not item:
            results.append({"item_id": item_id, "status": "not_found"})
            continue
        if item.photo_url and not body.replace:
            results.append({"item_id": item_id, "status": "already_has_photo"})
            continue
        try:
            desc = " ".join(x for x in [item.make, item.model, item.name] if x).strip() or item.name
            # SPEED CONTRACT: with Google configured the pipeline is Google →
            # Openverse, both ~1-2s calls — an item succeeds or fails FAST.
            # Claude web search (rate-limit sleeps, up to a minute per item) is
            # only ever used when no Google key exists at all.
            # Query relaxation: "Make Model Name" can be too specific for the
            # site-restricted index — fall back to the bare item name.
            src_errors = []
            sources = _google_image_candidates(desc, src_errors)
            if not sources and desc != item.name:
                sources = _google_image_candidates(item.name, src_errors)
            if not sources:
                sources = _openverse_image_candidates(desc)
            if not sources and desc != item.name:
                sources = _openverse_image_candidates(item.name)
            if not sources and not _GOOGLE_CSE_KEY:
                try:
                    sources = _find_product_page_urls(item)
                except Exception:
                    sources = []
            if not sources:
                results.append({"item_id": item_id, "status": "no_image", "item_name": item.name,
                                "detail": "; ".join(src_errors[:2]) or "all sources returned zero results"})
                continue
            public_url = ""
            tried = []
            for src in sources[:3]:  # at most 3 download attempts per item
                public_url = _fetch_image_to_storage(src, item.id)
                tried.append(src)
                if public_url:
                    break
            if not public_url:
                results.append({"item_id": item_id, "status": "download_failed", "item_name": item.name,
                                "detail": f"no usable image on: {' | '.join(t[:200] for t in tried)}"})
                continue
            item.photo_url = public_url
            db.commit()
            results.append({"item_id": item_id, "status": "ok", "photo_url": public_url, "item_name": item.name})
        except Exception as e:
            db.rollback()
            results.append({"item_id": item_id, "status": "error", "detail": str(e)[:200], "item_name": item.name})
    return {"results": results}



# -- Permanent assignments ------------------------------------------------------

def _camel(snake: str) -> str:
    parts = snake.split("_")
    return parts[0] + "".join(p.title() for p in parts[1:])


def _assignment_to_dict(a: ItemAssignment) -> dict:
    return {_camel(c.name): (getattr(a, c.name) or "") for c in ItemAssignment.__table__.columns}


class AssignmentCreate(BaseModel):
    assignee_email: str
    assignee_name:  Optional[str] = ""


class AssignmentAccept(BaseModel):
    photo_url:  Optional[str] = ""
    photo_name: Optional[str] = ""
    note:       Optional[str] = ""


class AssignmentReturnInit(BaseModel):
    reason:     str = "normal"     # normal | dead | lost
    photo_url:  Optional[str] = ""
    photo_name: Optional[str] = ""
    note:       Optional[str] = ""


class AssignmentReturnAccept(BaseModel):
    disposition: str = "stock"     # stock | retired


_LIVE_ASSIGN = ["pending_acceptance", "active", "return_initiated"]


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _action_notif(db: Session, ntype: str, ref_id: str):
    n = db.query(NexusNotification).filter(
        NexusNotification.type == ntype,
        NexusNotification.ref_id == ref_id,
        NexusNotification.actioned == False,
    ).first()
    if n:
        n.actioned = True


@router.get("/assignments")
def list_assignments(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(ItemAssignment).order_by(ItemAssignment.created_at.desc())
    if user["level"] < 3:
        q = q.filter(ItemAssignment.assignee_email == user["email"])
    return [_assignment_to_dict(a) for a in q.limit(1000).all()]


@router.post("/{item_id}/assign", status_code=201)
def assign_item(item_id: str, body: AssignmentCreate, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    live = db.query(ItemAssignment).filter(
        ItemAssignment.item_id == item_id, ItemAssignment.status.in_(_LIVE_ASSIGN)).first()
    if live:
        raise HTTPException(409, "Item already has a live assignment - use reassign")
    co = db.query(ItemCheckout).filter(
        ItemCheckout.item_id == item_id,
        ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"])).first()
    if co:
        raise HTTPException(409, "Item has an active checkout - recover it first")
    a = ItemAssignment(
        id=f"ASG-{uuid.uuid4().hex[:10].upper()}", item_id=item_id, item_name=item.name,
        assignee_email=body.assignee_email.lower().strip(),
        assignee_name=(body.assignee_name or "").strip(),
        assigned_by=user.get("name") or "", assigned_by_email=user["email"],
        status="pending_acceptance", created_at=_now_iso(),
    )
    db.add(a)
    _notify(db, type="perm_assign", recipient=a.assignee_email,
            title=f"Item assigned to you: {item.name}",
            body=f"{a.assigned_by or 'A manager'} assigned {item.name} to you permanently. Please accept it with a photo in My Items.",
            ref_id=a.id, item_name=item.name, requested_by=a.assignee_name)
    db.commit()
    return _assignment_to_dict(a)


@router.post("/{item_id}/reassign", status_code=201)
def reassign_item(item_id: str, body: AssignmentCreate, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """Start the return flow for the current holder; accepting that return
    auto-creates the next assignment for the new person."""
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    cur = db.query(ItemAssignment).filter(
        ItemAssignment.item_id == item_id, ItemAssignment.status == "active").with_for_update().first()
    if not cur:
        raise HTTPException(409, "No active assignment on this item - use assign")
    cur.status = "return_initiated"
    cur.return_reason = "reassign"
    cur.return_initiated_at = _now_iso()
    cur.next_assignee_email = body.assignee_email.lower().strip()
    cur.next_assignee_name  = (body.assignee_name or "").strip()
    _notify(db, type="perm_assign", recipient=cur.assignee_email,
            title=f"Please return: {item.name}",
            body=f"{item.name} is being reassigned to {cur.next_assignee_name or cur.next_assignee_email}. Please return it with a photo from My Items.",
            ref_id=cur.id, item_name=item.name, requested_by=cur.assignee_name)
    db.commit()
    return _assignment_to_dict(cur)


@router.post("/assignments/{assignment_id}/accept")
def accept_assignment(assignment_id: str, body: AssignmentAccept, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _validate_photo_url(body.photo_url, "photo_url")
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if a.assignee_email != user["email"]:
        raise HTTPException(403, "Only the assignee can accept this assignment")
    if a.status != "pending_acceptance":
        raise HTTPException(409, "Assignment is not awaiting acceptance")
    if not body.photo_url:
        raise HTTPException(400, "A photo of the received item is required")
    a.status = "active"
    a.accept_photo_url, a.accept_photo_name = body.photo_url, body.photo_name or ""
    a.accept_note, a.accepted_at = (body.note or "").strip(), _now_iso()
    item = db.query(Item).filter(Item.id == a.item_id).first()
    if item:
        item.status = "permanently_assigned"
        item.ownership_type = "permanent"
        item.assigned_to_email, item.assigned_to_name, item.assigned_at = a.assignee_email, a.assignee_name, a.accepted_at
    note_part = f' Condition note: "{a.accept_note}"' if a.accept_note else ""
    _notify(db, type="perm_update", recipient=a.assigned_by_email,
            title=f"Assignment accepted: {a.item_name}",
            body=f"{a.assignee_name or a.assignee_email} accepted {a.item_name}.{note_part}",
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    _action_notif(db, "perm_assign", a.id)
    db.commit()
    return _assignment_to_dict(a)


@router.post("/assignments/{assignment_id}/decline")
def decline_assignment(assignment_id: str, body: AssignmentReturnInit, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if a.assignee_email != user["email"]:
        raise HTTPException(403, "Only the assignee can decline")
    if a.status != "pending_acceptance":
        raise HTTPException(409, "Assignment is not awaiting acceptance")
    a.status = "declined"
    a.return_note = (body.note or "").strip()
    _notify(db, type="perm_update", recipient=a.assigned_by_email,
            title=f"Assignment declined: {a.item_name}",
            body=f"{a.assignee_name or a.assignee_email} declined {a.item_name}." + (f' Reason: "{a.return_note}"' if a.return_note else ""),
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    _action_notif(db, "perm_assign", a.id)
    db.commit()
    return _assignment_to_dict(a)


@router.post("/assignments/{assignment_id}/initiate-return")
def initiate_assignment_return(assignment_id: str, body: AssignmentReturnInit, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _validate_photo_url(body.photo_url, "photo_url")
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if a.assignee_email != user["email"] and user["level"] < 3:
        raise HTTPException(403, "Only the assignee or a manager can initiate a return")
    if a.status not in ("active", "return_initiated"):
        raise HTTPException(409, "Assignment is not active")
    reason = (body.reason or "normal").lower()
    if reason not in ("normal", "dead", "lost"):
        raise HTTPException(400, "reason must be normal, dead or lost")
    if reason != "lost" and not body.photo_url and a.status == "active":
        raise HTTPException(400, "A return photo is required (unless the item is lost)")
    keep_chain = a.return_reason == "reassign"   # reassignment return keeps its target
    a.status = "return_initiated"
    if not keep_chain:
        a.return_reason = reason
    a.return_photo_url, a.return_photo_name = body.photo_url or "", body.photo_name or ""
    a.return_note = (body.note or "").strip()
    a.return_initiated_at = _now_iso()
    flag = {"dead": "ITEM DEAD - ", "lost": "ITEM LOST - ", "reassign": "Reassignment - "}.get(a.return_reason, "")
    _notify(db, type="perm_return", recipient="",
            title=f"{flag}Return to confirm: {a.item_name}",
            body=f"{a.assignee_name or a.assignee_email} initiated a return of {a.item_name}"
                 + (f' - "{a.return_note}"' if a.return_note else ".")
                 + " Verify and accept it in Checkouts > Assignments.",
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    db.commit()
    return _assignment_to_dict(a)


@router.post("/assignments/{assignment_id}/accept-return")
def accept_assignment_return(assignment_id: str, body: AssignmentReturnAccept, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < 2:
        raise HTTPException(403, "Supervisor or above required to accept returns")
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if a.status != "return_initiated":
        raise HTTPException(409, "No return awaiting acceptance")
    dispo = body.disposition if body.disposition in ("stock", "retired") else "stock"
    a.status = "closed"
    a.disposition = dispo
    a.return_accepted_by, a.return_accepted_at = user.get("name") or user["email"], _now_iso()
    item = db.query(Item).filter(Item.id == a.item_id).first()
    if item:
        item.assigned_to_email = item.assigned_to_name = item.assigned_at = ""
        item.status = "retired" if dispo == "retired" else "available"
    _notify(db, type="perm_update", recipient=a.assignee_email,
            title=f"Return accepted: {a.item_name}",
            body=f"Your return of {a.item_name} was accepted by {a.return_accepted_by}. You are no longer responsible for it.",
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    _action_notif(db, "perm_return", a.id)
    # Reassignment chain: spawn the next assignment automatically
    if a.return_reason == "reassign" and a.next_assignee_email and item and item.status == "available":
        nxt = ItemAssignment(
            id=f"ASG-{uuid.uuid4().hex[:10].upper()}", item_id=a.item_id, item_name=a.item_name,
            assignee_email=a.next_assignee_email, assignee_name=a.next_assignee_name,
            assigned_by=a.return_accepted_by, assigned_by_email=user["email"],
            status="pending_acceptance", created_at=_now_iso(),
        )
        db.add(nxt)
        _notify(db, type="perm_assign", recipient=nxt.assignee_email,
                title=f"Item assigned to you: {a.item_name}",
                body=f"{a.item_name} has been reassigned to you. Please accept it with a photo in My Items.",
                ref_id=nxt.id, item_name=a.item_name, requested_by=nxt.assignee_name)
    db.commit()
    return _assignment_to_dict(a)


@router.post("/assignments/{assignment_id}/cancel")
def cancel_assignment(assignment_id: str, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """Manager cancel / force-recover. Pending -> cancelled; active/returning -> closed, item back to stock."""
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if a.status not in _LIVE_ASSIGN:
        raise HTTPException(409, "Assignment is already closed")
    was_pending = a.status == "pending_acceptance"
    a.status = "cancelled" if was_pending else "closed"
    a.disposition = "" if was_pending else "stock"
    a.return_accepted_by, a.return_accepted_at = user.get("name") or user["email"], _now_iso()
    item = db.query(Item).filter(Item.id == a.item_id).first()
    if item and not was_pending:
        item.assigned_to_email = item.assigned_to_name = item.assigned_at = ""
        item.status = "available"
    _notify(db, type="perm_update", recipient=a.assignee_email,
            title=f"Assignment {'cancelled' if was_pending else 'closed'}: {a.item_name}",
            body=f"{a.return_accepted_by} {'cancelled the pending assignment of' if was_pending else 'force-recovered'} {a.item_name}."
                 + ("" if was_pending else " You are no longer responsible for it."),
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    _action_notif(db, "perm_assign", a.id)
    _action_notif(db, "perm_return", a.id)
    db.commit()
    return _assignment_to_dict(a)


# ── Allocators / Approvers ────────────────────────────────────────────────────

@router.get("/approvers")
def list_approvers(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Manager-level users an employee can address their checkout request to.
    Open to all authenticated users — only names/emails/roles are exposed."""
    rows = db.query(NexusRole).filter(NexusRole.role.in_(
        [role for role, level in _ROLE_LEVEL.items() if level >= _ROLE_LEVEL["manager"]]
    )).order_by(NexusRole.email).all()
    return [
        {"email": r.email, "name": r.display_name or _title_case_email(r.email), "role": r.role}
        for r in rows
    ]


@router.get("/allocators")
def list_allocators(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] < _ROLE_LEVEL["manager"]:
        raise HTTPException(403, "Manager or above required")
    rows = db.query(NexusRole).filter(NexusRole.role.in_(
        [role for role, level in _ROLE_LEVEL.items() if level >= _ROLE_LEVEL["supervisor"]]
    )).order_by(NexusRole.email).all()
    return [
        {"email": r.email, "name": r.display_name or _title_case_email(r.email), "role": r.role}
        for r in rows
    ]


# ── Report ────────────────────────────────────────────────────────────────────

_REPORT_HEADERS = [
    "Item", "Type", "Make", "Model", "Department", "Location", "Owner",
    "Ownership", "Status", "Requested By", "Days", "Reason",
    "Request Date", "Allocated Date", "Allocated By", "Returned Date", "Condition",
]


def _report_rows(db: Session, *, department, item_type, status, requested_by=None):
    q = db.query(ItemCheckout, Item).outerjoin(
        Item, ItemCheckout.item_id == Item.id
    ).order_by(ItemCheckout.created_at.desc())
    if department:
        q = q.filter(ItemCheckout.department == department)
    if item_type:
        q = q.filter(func.lower(Item.item_type) == item_type.lower().strip())
    if status:
        q = q.filter(ItemCheckout.status == status)
    if requested_by:
        # Comma-separated names — match any (case-insensitive substring per name)
        names = [n.strip() for n in requested_by.split(",") if n.strip()]
        if names:
            q = q.filter(or_(*[ItemCheckout.requested_by.ilike(f"%{n}%") for n in names]))
    rows = []
    for c, item in q.all():
        rows.append([
            c.item_name, item.item_type if item else "", item.make if item else "",
            item.model if item else "", c.department, item.location if item else "",
            item.default_owner if item else "", item.ownership_type if item else "",
            c.status, c.requested_by, c.days, c.reason,
            c.created_at[:10] if c.created_at else "",
            c.allocated_at[:10] if c.allocated_at else "", c.allocated_by or "",
            c.returned_at[:10] if c.returned_at else "", c.condition_note or "",
        ])
    return rows


@router.get("/report")
def export_report(
    format:       str = "excel",
    department:   Optional[str] = None,
    item_type:    Optional[str] = None,
    status:       Optional[str] = None,
    requested_by: Optional[str] = None,
    user: dict = Depends(require_items_admin),
    db: Session = Depends(get_db),
):
    rows  = _report_rows(db, department=department, item_type=item_type, status=status, requested_by=requested_by)
    stamp = datetime.utcnow().strftime("%Y%m%d")

    if format == "pdf":
        try:
            from reportlab.lib import colors
            from reportlab.lib.pagesizes import landscape, A4
            from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
        except ImportError:
            raise HTTPException(500, "reportlab not installed")
        buf = io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=landscape(A4), title="Items Checkout Report")
        table = Table([_REPORT_HEADERS] + rows, repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1A1A2E")),
            ("TEXTCOLOR",  (0, 0), (-1, 0), colors.white),
            ("FONTSIZE",   (0, 0), (-1, -1), 6.5),
            ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
            ("GRID",       (0, 0), (-1, -1), 0.5, colors.HexColor("#DDDDDD")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F5F5FA")]),
            ("VALIGN",     (0, 0), (-1, -1), "MIDDLE"),
        ]))
        doc.build([table])
        buf.seek(0)
        return StreamingResponse(buf, media_type="application/pdf",
            headers={"Content-Disposition": f"attachment; filename=items_report_{stamp}.pdf"})

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
    except ImportError:
        raise HTTPException(500, "openpyxl not installed")
    wb = Workbook()
    ws = wb.active
    ws.title = "Items Checkout Report"
    hf = PatternFill(start_color="1A1A2E", end_color="1A1A2E", fill_type="solid")
    hfont = Font(bold=True, color="FFFFFF")
    for col, h in enumerate(_REPORT_HEADERS, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.font = hfont
        cell.fill = hf
        cell.alignment = Alignment(horizontal="center")
    for row in rows:
        ws.append(row)
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = min(
            max((len(str(c.value or "")) for c in col), default=0) + 4, 40
        )
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=items_report_{stamp}.xlsx"},
    )


# ── Audit log ─────────────────────────────────────────────────────────────────

@router.get("/audit-log")
def items_audit_log(
    q:      Optional[str] = None,
    limit:  int = 100,
    offset: int = 0,
    user: dict = Depends(require_items_admin),
    db: Session = Depends(get_db),
):
    query = db.query(AuditLog).filter(AuditLog.resource_type.in_(["items", "item_checkouts", "inventory-requests"]))
    if q:
        needle = q.strip()
        query = query.filter(or_(
            AuditLog.details.contains(needle),
            AuditLog.user_email.contains(needle.lower()),
            AuditLog.action.contains(needle),
            AuditLog.resource_id.contains(needle),
        ))
    total = query.count()
    rows  = query.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "rows": [
            {"id": r.id, "timestamp": r.timestamp, "user_email": r.user_email,
             "user_role": r.user_role, "action": r.action,
             "resource_id": r.resource_id, "details": r.details}
            for r in rows
        ],
    }

