import io
import os
import threading
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import or_, func
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import httpx
from database import get_db
from auth import get_current_user, require_level_or_module
from models import Item, ItemCheckout, ItemCartEntry, NexusRole, NexusNotification, AuditLog

_VALID_TRANSITIONS = {
    "approved":  {"pending"},
    "rejected":  {"pending"},
    "allocated": {"approved"},
    "returned":  {"allocated"},
    "cancelled": {"pending", "approved"},
}

_ROLE_LEVEL = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}

_ITEM_TYPES = ["Devices", "Tools", "Vehicles", "Equipment", "Keys", "Other"]

_TYPE_DEFAULT_OWNER = {
    "Devices":   "IT",
    "Tools":     "Construction (MCD)",
    "Vehicles":  "Fleet / Operations",
    "Equipment": "",
    "Keys":      "Operations (Oversite)",
    "Other":     "",
}

_DAMAGE_KEYWORDS = ("damaged", "broken", "cracked", "lost", "destroyed", "unusable", "retired")

require_items_admin  = require_level_or_module(_ROLE_LEVEL["manager"], "inventory", "editor")
require_items_delete = require_level_or_module(_ROLE_LEVEL["owner"],   "inventory", "full")

_SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")


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
            json={"request_id": checkout_id, "status": status, "affected_email": affected_email},
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
    return [_item_to_dict(i) for i in q.all()]


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
        status="available" if (body.ownership_type or "transient") == "transient" else "permanently_assigned",
        location=(body.location or "").strip(),
        photo_url=(body.photo_url or "").strip(),
        created_by=user["email"],
        created_at=now,
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
            status="available" if ownership == "transient" else "permanently_assigned",
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
    if body.item_type  is not None: item.item_type      = body.item_type.strip()
    if body.make       is not None: item.make           = body.make.strip()
    if body.model      is not None: item.model          = body.model.strip()
    if body.year       is not None: item.year           = body.year.strip()
    if body.department is not None: item.department     = body.department.strip()
    if body.default_owner  is not None: item.default_owner  = body.default_owner.strip()
    if body.ownership_type is not None: item.ownership_type = body.ownership_type.strip()
    if body.status     is not None: item.status         = body.status.strip()
    if body.location   is not None: item.location       = body.location.strip()
    if body.photo_url  is not None: item.photo_url      = body.photo_url.strip()
    db.commit()
    return _item_to_dict(item)


@router.delete("/{item_id}")
def delete_item(item_id: str, user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    active = db.query(ItemCheckout).filter(
        ItemCheckout.item_id == item_id,
        ItemCheckout.status.in_(["pending", "approved", "allocated"]),
    ).count()
    if active:
        raise HTTPException(409, "Cannot delete an item with an active checkout against it")
    db.delete(item)
    db.commit()
    return {"ok": True}


# ── Checkouts ─────────────────────────────────────────────────────────────────

class CheckoutIn(BaseModel):
    id:                  str
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

    def validate_days(self):
        if not (1 <= self.days <= 90):
            raise HTTPException(400, "days must be between 1 and 90")


class CheckoutStatusUpdate(BaseModel):
    status:                    str
    resolved_by:               Optional[str] = ""
    reject_reason:             Optional[str] = ""
    assigned_allocator_email:  Optional[str] = ""
    assigned_allocator_name:   Optional[str] = ""
    allocated_by:              Optional[str] = ""
    return_photo_name:         Optional[str] = ""
    return_photo_url:          Optional[str] = ""
    condition_note:            Optional[str] = ""


@router.get("/checkouts")
def list_checkouts(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    q = db.query(ItemCheckout).order_by(ItemCheckout.created_at.desc())
    if user["level"] < 3:
        q = q.filter(or_(
            ItemCheckout.requested_by_email == user["email"],
            ItemCheckout.assigned_allocator_email == user["email"],
        ))
    return [_checkout_to_dict(c) for c in q.all()]


@router.post("/checkouts", status_code=201)
def create_checkout(body: CheckoutIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    body.validate_days()
    if not body.reason.strip():
        raise HTTPException(400, "Reason for checkout is required")

    if db.query(ItemCheckout).filter(ItemCheckout.id == body.id).first():
        raise HTTPException(409, "A checkout with this id already exists")

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
        ItemCheckout.status.in_(["pending", "approved", "allocated"]),
    ).first()
    if active:
        raise HTTPException(409, f'"{item.name}" already has an active checkout request')

    now = datetime.now(timezone.utc).isoformat()
    # Managers and above don't need a separate approval for their own checkouts
    is_manager = user.get("level", 1) >= 3
    requester_email = body.requested_by_email.lower()
    user_email = user.get("email", "").lower()
    self_checkout = is_manager and requester_email == user_email
    initial_status = "approved" if self_checkout else "pending"

    order_id = (body.order_id or "").strip()
    row = ItemCheckout(
        id=body.id,
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
    )
    db.add(row)
    if initial_status == "pending":
        # One notification per order — if this order_id already has a checkout_pending
        # notification, skip to avoid spamming managers with N alerts for one cart.
        ref_for_notif = order_id if order_id else body.id
        already_notified = order_id and db.query(NexusNotification).filter(
            NexusNotification.ref_id == order_id,
            NexusNotification.type == "checkout_pending",
        ).first()
        if not already_notified:
            _notify(db, type="checkout_pending", recipient="",
                    title=f"Checkout request from {body.requested_by}",
                    body=f"{body.requested_by} submitted a checkout — \"{body.reason}\"",
                    ref_id=ref_for_notif, item_name=body.item_name, requested_by=body.requested_by)
    db.commit()
    _fire_item_event(row.id, initial_status, row.requested_by_email or "")
    return _checkout_to_dict(row)


@router.patch("/checkouts/{checkout_id}")
def update_checkout(checkout_id: str, body: CheckoutStatusUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(ItemCheckout).filter(ItemCheckout.id == checkout_id).first()
    if not row:
        return {"ok": False, "error": "not found"}

    if body.status in ("approved", "rejected") and user["level"] < 3:
        raise HTTPException(403, "Manager or above required to approve or reject checkouts")
    if body.status == "approved" and not (body.assigned_allocator_email or "").strip():
        raise HTTPException(400, "Pick who should allocate this item before approving")
    if body.status == "allocated":
        is_assignee = row.assigned_allocator_email and row.assigned_allocator_email.lower() == user["email"]
        if not is_assignee and user["level"] < 3:
            raise HTTPException(403, "Only the assigned allocator (or a manager) can mark this as allocated")
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

    elif body.status == "allocated":
        if item and item.status != "available":
            raise HTTPException(409, "Item is no longer available to allocate")
        row.allocated_at = now
        row.allocated_by = body.allocated_by or ""
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

    row.status = body.status

    if body.status == "approved":
        _notify(db, type="approved", recipient=row.requested_by_email,
                title=f"Checkout approved: {row.item_name}",
                body=f"Your request for {row.item_name} was approved. {row.assigned_allocator_name or 'Someone'} will hand it over to you.",
                ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
    elif body.status == "rejected":
        _notify(db, type="rejected", recipient=row.requested_by_email,
                title=f"Checkout rejected: {row.item_name}",
                body=f"Your request for {row.item_name} was not approved. Reason: {row.reject_reason or 'No reason given.'}",
                ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
    elif body.status == "allocated":
        _notify(db, type="allocated", recipient=row.requested_by_email,
                title=f"Item ready: {row.item_name}",
                body=f"{row.item_name} has been handed over to you. Please return it within {row.days} day(s).",
                ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)
    elif body.status == "returned":
        _notify(db, type="item_returned", recipient="",
                title=f"Item returned: {row.item_name}",
                body=f"{row.requested_by} returned {row.item_name}. Condition: {row.condition_note or 'No notes.'}",
                ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)

    db.commit()
    _fire_item_event(checkout_id, row.status, row.requested_by_email or "")
    return _checkout_to_dict(row)


# ── Allocators ────────────────────────────────────────────────────────────────

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


def _report_rows(db: Session, *, department, item_type, status):
    q = db.query(ItemCheckout, Item).outerjoin(
        Item, ItemCheckout.item_id == Item.id
    ).order_by(ItemCheckout.created_at.desc())
    if department:
        q = q.filter(ItemCheckout.department == department)
    if item_type:
        q = q.filter(func.lower(Item.item_type) == item_type.lower().strip())
    if status:
        q = q.filter(ItemCheckout.status == status)
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
    format:     str = "excel",
    department: Optional[str] = None,
    item_type:  Optional[str] = None,
    status:     Optional[str] = None,
    user: dict = Depends(require_items_admin),
    db: Session = Depends(get_db),
):
    rows  = _report_rows(db, department=department, item_type=item_type, status=status)
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

