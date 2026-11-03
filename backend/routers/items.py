import io
import json
import os
import re
import threading
import uuid
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, false as sa_false, or_, func, text as sa_text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import httpx
import safe_fetch
from database import get_db
from auth import get_current_user, require_level_or_module, company_of
from models import Item, ItemCheckout, ItemCartEntry, ItemAssignment, ItemCustomField, ItemType, NexusRole, NexusNotification, AuditLog, NexusEmployee

_VALID_TRANSITIONS = {
    "approved":         {"pending"},
    "rejected":         {"pending", "approved"},
    "pending_receipt":  {"approved"},
    "allocated":        {"approved", "pending_receipt"},
    "returned":         {"allocated"},
    # P1-3: a stuck pending_receipt (allocator handed over, employee never confirmed
    # receipt) is cancelled ONLY through the reconcile-state endpoint (an items
    # manager) - never by a PATCH, the requester's included (Nov 2026).
    "cancelled":        {"pending", "approved", "rejected"},
}

_ROLE_LEVEL = {"employee": 1, "supervisor": 2, "manager": 3, "administrator": 4, "owner": 5}

# Controlled list of item types - add/edit is dropdown-only, and an unrecognised
# type on IMPORT now lands in "Other" for cleanup rather than spawning a junk type
# (Neil). To add a real new type, add it here (a deliberate, rare change).
_ITEM_TYPES    = ["Computer", "Peripheral", "Networking", "Server", "Storage",
                  "IP Camera", "Devices", "Tools", "Equipment", "Vehicles",
                  "Furniture", "Keys", "Other"]
_ITEM_STATUSES = ["available", "checked_out", "permanently_assigned", "retired"]
# Operational status (Neil) - what condition/deployment state the unit is in. SEPARATE
# from the lifecycle `status` above (which is auto-driven by checkouts/assignments).
# '' = unset. Mirror _OP_STATUSES on the frontend if you change this list.
_OP_STATUSES   = ["deployed", "in_storage", "in_repair", "needs_replacement", "retired", "lost"]
# Op statuses that are declared AGAINST a person - they capture an op_status_person
# and notify that person. Anything else clears the person. Mirror _OP_STATUS_PERSON
# on the frontend (OP_STATUS_PERSON) if you change this set.
_OP_STATUS_PERSON = {"lost", "retired"}
_CUSTOM_FIELD_TYPES = ["text", "number", "date", "select", "boolean", "url"]
# Soft-deleted items are restorable for this many days, then purged for good.
_RECYCLE_BIN_DAYS = 30

_TYPE_DEFAULT_OWNER = {
    "Devices":   "IT",
    "Tools":     "Construction (MCD)",
    "Vehicles":  "Construction",
    "Equipment": "",
    "Keys":      "Operations (Oversite)",
    "Other":     "",
}

# P1-13: return condition is now an explicit enum on the return payload instead of
# sniffing the free-text note for damage keywords (which false-matched "undamaged",
# "not broken", etc. and wrongly retired items). Only these values alter op_status.
_RETURN_CONDITIONS = ("ok", "damaged", "lost")

require_items_admin  = require_level_or_module(_ROLE_LEVEL["manager"], "inventory", "editor")
require_items_delete = require_level_or_module(_ROLE_LEVEL["owner"],   "inventory", "full")


def require_custom_field_delete(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """require_items_delete's rule (Super Administrator, or an Inventory grant
    at Full) for DELETE /custom-fields, refusing with 403 - never 401. The
    frontend reads a 401 as a dead session (token refresh, then a full
    sign-in), so a manager or Inventory editor who clicked Delete was bounced
    as if signed out (11/02/2026). 401 stays get_current_user's, for a missing
    or invalid session. The shared auth.require_level* gates still answer 401
    and are left as they are: tests across the suite pin that status."""
    from auth import _module_level, _MODULE_LEVEL_RANK
    if (user.get("level", 1) >= _ROLE_LEVEL["owner"]
            or _module_level(user["email"], "inventory", db) >= _MODULE_LEVEL_RANK["full"]):
        return user
    raise HTTPException(403, "Only a Super Administrator or someone with Full Inventory access can delete a custom field.")


def _is_items_manager(user: dict, db) -> bool:
    """Inline version of require_items_admin for checks INSIDE handlers:
    global manager+ OR an Access-Group grant of inventory at editor or above.
    The raw `user["level"] >= 3` checks this replaces ignored module grants, so
    an Employee-tier person with 'Item Management: Full' was blocked from
    approve/allocate/manage despite the grant (Jul 24 - India Admin Team)."""
    from auth import _module_level, _MODULE_LEVEL_RANK
    return (user.get("level", 1) >= _ROLE_LEVEL["manager"]
            or _module_level(user["email"], "inventory", db) >= _MODULE_LEVEL_RANK["editor"])


# ── Company walls (Neil green-lit, 11/02/2026) ────────────────────────────────
# An item carries company_id (stamped from its creator); a checkout and an
# assignment belong to their ITEM's company. On every route:
#   * lists keep only rows whose item the caller's company_scope admits
#     (scope None = unwalled - a Super Administrator, or levels 1-3 while the
#     walls are off - so nothing changes for them);
#   * an act on one row outside the scope answers 404, never 403
#     (auth.assert_company), so existence never leaks across the wall;
#   * the PARTIES to a row - a checkout's requester and allocator, an
#     assignment's assignee - always see and act on their own row: they hold
#     the item, and a wall must never strand it with them. The wall governs
#     everyone acting on somebody else's row (managers, approvers).

_LIVE_CHECKOUT = ["pending", "approved", "pending_receipt", "allocated"]


def _me(user: dict) -> str:
    return (user.get("email") or "").strip().lower()


def _scope(user: dict, db: Session):
    import auth
    return auth.company_scope(user, db)


def _item_ok(item, scope) -> bool:
    """Does `scope` admit this item (None = an item that no longer exists)?"""
    import auth
    return auth.company_ok((getattr(item, "company_id", "") or "") if item is not None else "", scope)


def _wall_item(item, user: dict, db: Session) -> None:
    """404 when the caller's company scope does not admit `item`."""
    import auth
    auth.assert_company((getattr(item, "company_id", "") or "") if item is not None else "", user, db)


def _wall_item_id(item_id: str, user: dict, db: Session) -> None:
    """_wall_item for a row that only carries the item's id."""
    import auth
    if auth.company_scope(user, db) is None:
        return
    found = db.query(Item.company_id).filter(Item.id == item_id).first()
    auth.assert_company((found[0] if found else "") or "", user, db)


def _checkout_party(row, user: dict) -> bool:
    me = _me(user)
    return bool(me) and me in ((row.requested_by_email or "").lower(),
                               (row.assigned_allocator_email or "").lower())


def _assignment_party(a, user: dict) -> bool:
    me = _me(user)
    return bool(me) and me == (a.assignee_email or "").lower()


def _wall_checkout(row, user: dict, db: Session) -> None:
    if not _checkout_party(row, user):
        _wall_item_id(row.item_id, user, db)


def _wall_assignment(a, user: dict, db: Session) -> None:
    if not _assignment_party(a, user):
        _wall_item_id(a.item_id, user, db)


def visible_item_ids(db: Session, user: dict, scope="unset") -> Optional[set]:
    """The ids of every item the caller's company scope admits, or None when
    the caller is unwalled (then nothing needs filtering). Lists and the
    Approvals sources (approvals_inbox) filter their rows through it."""
    import auth
    if scope == "unset":
        scope = auth.company_scope(user, db)
    if scope is None:
        return None
    if not scope:
        return set()
    return {r[0] for r in db.query(Item.id).filter(Item.company_id.in_(list(scope))).all()}


def _display_name(db: Session, email: str) -> str:
    """The People name for an email ("Visesh Lodha"), else one made from it."""
    em = (email or "").strip().lower()
    if not em:
        return ""
    row = (db.query(NexusEmployee.first_name, NexusEmployee.last_name)
           .filter(func.lower(NexusEmployee.work_email) == em).first())
    name = f"{(row[0] or '') if row else ''} {(row[1] or '') if row else ''}".strip()
    return name or _title_case_email(em)


def _nexus_person(db: Session, email: str):
    em = (email or "").strip().lower()
    if not em:
        return None
    return (db.query(NexusEmployee)
            .filter(func.lower(NexusEmployee.work_email) == em)
            .filter(or_(NexusEmployee.status.is_(None), NexusEmployee.status != "offboarded")).first())


def _require_person(db: Session, email: str, user: dict, what: str = "person") -> None:
    """People pickers are the curated Nexus People list (CLAUDE.md): a
    requester, assignee or allocator must be a current Nexus person inside
    the caller's company scope. One message for both misses, so the answer
    never says whether someone exists across the wall."""
    import auth
    em = (email or "").strip().lower()
    if not em or _nexus_person(db, em) is None or not auth.person_in_scope(em, auth.company_scope(user, db), db):
        raise HTTPException(400, f"Pick the {what} from the Nexus People list.")


def _tag_item(response, item_id: str) -> None:
    """Name the item on the response (X-Item-Id) so the audit middleware
    threads a checkout / assignment step into that item's history."""
    if response is not None and item_id:
        response.headers["X-Item-Id"] = item_id


def _refuse_lost(item) -> None:
    """A lost item stays out of circulation until an items manager marks it
    found (changes its status in Item Management)."""
    if item is not None and (item.op_status or "") == "lost":
        raise HTTPException(400, f'"{item.name}" is marked Lost. An items manager must mark it found '
                                 "(change its status) before it can be checked out or assigned again.")


def _items_managers_for(db: Session, company_id: str, exclude=()) -> list:
    """Named recipients for an items-manager bell about one company's item:
    every current Nexus person in that company who is an items manager
    (_is_items_manager's rule - the manager tier or above, or an Inventory
    grant at Editor or above). Empty when nobody qualifies; the caller then
    falls back to the managers' broadcast, stamped with the company."""
    from auth import _MODULE_LEVEL_RANK
    from models import NexusGroup, NexusGroupMember
    mgr_roles = [r for r, lvl in _ROLE_LEVEL.items() if lvl >= _ROLE_LEVEL["manager"]]
    emails = {(r[0] or "").lower() for r in db.query(NexusRole.email).filter(NexusRole.role.in_(mgr_roles)).all()}
    gids = []
    for gid, mods in db.query(NexusGroup.id, NexusGroup.allowed_modules).filter(
            NexusGroup.allowed_modules.like("%inventory%")).all():
        for part in (mods or "").split(","):
            mid, _, lvl = part.strip().partition(":")
            if mid == "inventory" and _MODULE_LEVEL_RANK.get(lvl, _MODULE_LEVEL_RANK["viewer"]) >= _MODULE_LEVEL_RANK["editor"]:
                gids.append(gid)
                break
    if gids:
        emails |= {(m[0] or "").lower() for m in db.query(NexusGroupMember.email)
                   .filter(NexusGroupMember.group_id.in_(gids)).all()}
    emails.discard("")
    skip = {(e or "").lower() for e in exclude}
    if not emails:
        return []
    out = []
    for em, co in (db.query(NexusEmployee.work_email, NexusEmployee.company)
                   .filter(func.lower(NexusEmployee.work_email).in_(list(emails)))
                   .filter(or_(NexusEmployee.status.is_(None), NexusEmployee.status != "offboarded")).all()):
        em = (em or "").lower()
        if em and em not in skip and (co or "") == (company_id or ""):
            out.append(em)
    return sorted(set(out))

_SUPABASE_URL         = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Valid photo URL prefix - only allow URLs pointing to our own Supabase storage
# so fake/external evidence cannot be submitted.
_STORAGE_PREFIX = f"{_SUPABASE_URL}/storage/v1/object/public/" if _SUPABASE_URL else None


def _validate_photo_url(url: Optional[str], field: str) -> None:
    """Raise 400 if url is non-empty and does not originate from our storage bucket."""
    if not url or not url.strip():
        return
    if _STORAGE_PREFIX and not url.startswith(_STORAGE_PREFIX):
        raise HTTPException(400, f"{field} must be a Supabase storage URL")


def _notify(db: Session, *, type: str, recipient: str, title: str, body: str,
            ref_id: str = "", item_name: str = "", requested_by: str = "",
            about_email: str = "", company: Optional[str] = None) -> NexusNotification:
    """One bell row. `requested_by` is a DISPLAY name (shown on the card) -
    the company is stamped from an EMAIL: `company` when the caller knows the
    item's, else the company of `about_email` (the requester / assignee the
    notice is about), else the recipient's. It decides who sees a broadcast
    (recipient '') through the bell's company wall. Stamping it from the
    display name (as before Nov 2026) always gave '' - so once the walls
    were armed, every items broadcast went to the Super Administrators only."""
    if company is None:
        company = company_of(about_email or recipient, db) if (about_email or recipient) else ""
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
        company=company or "",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(row)
    return row


def _bells(db: Session, ntype: str, ref_id: str, recipient=None, title_prefix: str = "") -> list:
    """The un-actioned bells of one workflow (type + ref), optionally for one
    recipient and/or whose title starts with `title_prefix`."""
    q = db.query(NexusNotification).filter(
        NexusNotification.type == ntype,
        NexusNotification.ref_id == ref_id,
        NexusNotification.actioned == False,  # noqa: E712
    )
    if recipient is not None:
        q = q.filter(NexusNotification.recipient == (recipient or "").lower())
    rows = q.all()
    if title_prefix:
        rows = [n for n in rows if (n.title or "").startswith(title_prefix)]
    return rows


def _notify_team(db: Session, *, type: str, recipients: list, title: str, body: str,
                 ref_id: str, item_name: str = "", requested_by: str = "",
                 about_email: str = "", company: str = "") -> None:
    """The bell for a decision an items manager makes, sent to NAMED people
    (the approver, else the items managers of the item's company) - never
    the '' broadcast unless nobody could be named. One row per person per
    workflow, updated in place (re-surfaced as unread) when it fires again."""
    people = sorted({(r or "").strip().lower() for r in recipients if (r or "").strip()})
    if not people:
        live = _bells(db, type, ref_id, "")
        if live:
            for n in live:
                n.title, n.body, n.read_by = title, body, ""
            return
        _notify(db, type=type, recipient="", title=title, body=body, ref_id=ref_id,
                item_name=item_name, requested_by=requested_by, about_email=about_email,
                company=company or None)
        return
    for em in people:
        live = _bells(db, type, ref_id, em)
        if live:
            for n in live:
                n.title, n.body, n.read_by = title, body, ""
            continue
        _notify(db, type=type, recipient=em, title=title, body=body, ref_id=ref_id,
                item_name=item_name, requested_by=requested_by, about_email=about_email)


def _notify_op_status_declaration(db: Session, *, op_status: str, person_email: str,
                                  person_name: str, item_name: str) -> None:
    """Tell the person an op_status was declared against. Lost carries a friendly
    keep-it-safe disclaimer; other person-statuses (retired) get a neutral note.
    Server-side only (employees can't POST notifications) - one per declaration."""
    email = (person_email or "").lower().strip()
    if not email or op_status not in _OP_STATUS_PERSON:
        return
    if op_status == "lost":
        title = "An item was reported lost under your name"
        body  = (f"{item_name} has been recorded as Lost by you. Please take extra "
                 "care to keep your assigned equipment safe going forward - and if "
                 "this was logged by mistake, let your manager know.")
    else:  # retired
        title = "An item was retired under your name"
        body  = (f"{item_name} has been retired under your name and taken out of "
                 "active service. No action needed.")
    _notify(db, type=f"op_status_{op_status}", recipient=email,
            title=title, body=body, item_name=item_name)


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
            # Clients never used the field - they refetch via the authed API.
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
        "serialNumber":  i.serial_number or "",
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
        "assignedToLocation": i.assigned_to_location or "",
        "assignedAt":      i.assigned_at       or "",
        # NULL (pre-migration rows) must read as True - photos required by default
        "pictureRequired": True if i.picture_required is None else bool(i.picture_required),
        "assetValue":      float(i.asset_value or 0),
        "opStatus":        i.op_status or "",
        "opStatusPersonEmail": i.op_status_person_email or "",
        "opStatusPersonName":  i.op_status_person_name or "",
        "customFields":    i.custom_fields if isinstance(i.custom_fields, dict) else {},
        "deletedAt":       i.deleted_at or "",
        "deletedBy":       i.deleted_by or "",
        "deletedLocation": i.deleted_location or "",
    }


def _custom_field_to_dict(f: ItemCustomField) -> dict:
    return {
        "id":            f.id,
        "fieldKey":      f.field_key,
        "label":         f.label,
        "fieldType":     f.field_type,
        "options":       f.options if isinstance(f.options, list) else [],
        "appliesToType": f.applies_to_type or "",
        "sortOrder":     f.sort_order or 0,
    }


def _checkout_to_dict(c: ItemCheckout, zones=None) -> dict:
    """`zones` (item_due.Zones) dates dueDate in the borrower's own zone;
    without it (a payload built where no db is at hand) it reads the
    default zone. dueAt / dueDate are blank until the item changes hands."""
    import item_due
    return {
        **item_due.due_fields(c, zones),
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
        # The return date picked on the calendar (YYYY-MM-DD, the borrower's
        # zone) - what a request shows before the handover; '' = a days request.
        "requestedDueDate":        c.requested_due_date       or "",
    }


# ── Item CRUD ─────────────────────────────────────────────────────────────────

class ItemCreate(BaseModel):
    name:           str
    # Optional (Add Item's Serial field, 11/02/2026): blank = the next GG-#####.
    serial_number:  Optional[str] = ""
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
    op_status:        Optional[str]  = ""
    op_status_person_email: Optional[str] = ""
    op_status_person_name:  Optional[str] = ""
    custom_fields:    Optional[dict] = None


class ItemUpdate(BaseModel):
    name:           Optional[str] = None
    item_type:      Optional[str] = None
    make:           Optional[str] = None
    model:          Optional[str] = None
    year:           Optional[str] = None
    department:     Optional[str] = None
    default_owner:  Optional[str] = None
    ownership_type: Optional[str] = None
    # P1-3: lifecycle `status` is intentionally NOT writable here - it is derived
    # solely from checkout/assignment transitions (a raw write could strand an idle
    # item as "checked_out" and make it permanently un-requestable). Use the
    # reconcile-state endpoint to re-derive it. op_status (operational) stays writable.
    location:       Optional[str] = None
    photo_url:      Optional[str] = None
    picture_required: Optional[bool]  = None
    asset_value:      Optional[float] = None
    op_status:        Optional[str]  = None
    op_status_person_email: Optional[str] = None
    op_status_person_name:  Optional[str] = None
    custom_fields:    Optional[dict] = None


class ItemImportRow(BaseModel):
    name:           str
    serial_number:  Optional[str] = ""
    item_type:      Optional[str] = "Other"
    make:           Optional[str] = ""
    model:          Optional[str] = ""
    year:           Optional[str] = ""
    department:     Optional[str] = ""
    default_owner:  Optional[str] = ""
    ownership_type: Optional[str] = "transient"
    location:       Optional[str] = ""
    custom_fields:  Optional[dict] = None


class ItemImportRequest(BaseModel):
    items: list[ItemImportRow]
    # A row whose serial belongs to an item in the Recycle Bin is skipped and
    # reported unless the import says to restore those items (Nov 2026).
    restore_deleted: Optional[bool] = False


@router.get("")
def list_items(
    department: Optional[str] = None,
    item_type:  Optional[str] = None,
    status:     Optional[str] = None,
    user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Soft-deleted items (deleted_at set) are hidden from the normal catalogue -
    # they live in GET /deleted until restored or purged (Ankush). NULL = legacy row.
    q = db.query(Item).filter(or_(Item.deleted_at.is_(None), Item.deleted_at == "")) \
          .order_by(Item.department, Item.item_type, Item.name)
    if department:
        q = q.filter(Item.department == department)
    if item_type:
        q = q.filter(Item.item_type == item_type)
    if status:
        q = q.filter(Item.status == status)
    items = q.all()
    # Company wall: once armed, only items in the caller's companies (Global Admin
    # sees all; untagged/shared items are Global-Admin-only). Off = unchanged.
    import auth
    _scope = auth.company_scope(user, db)
    if _scope is not None:
        items = [i for i in items if auth.company_ok(getattr(i, "company_id", ""), _scope)]

    # Enrich each item with live checkout activity so ALL users (not just
    # managers who see every checkout) know when an item is taken or under
    # review - prevents submitting a cart that will 409 at the server.
    active_cos = db.query(
        ItemCheckout.item_id,
        ItemCheckout.requested_by,
        ItemCheckout.requested_by_email,
        ItemCheckout.status,
        ItemCheckout.created_at,
        ItemCheckout.days,
        ItemCheckout.allocated_at,
        ItemCheckout.handed_over_at,
        ItemCheckout.requested_due_date,
    ).filter(
        ItemCheckout.status.in_(_LIVE_CHECKOUT)
    ).all()
    active_map = {row.item_id: row for row in active_cos}

    import item_due
    zones = item_due.Zones(db)
    result = []
    for i in items:
        d = _item_to_dict(i)
        co = active_map.get(i.id)
        # hasActiveRequest: true when a checkout blocks new requests (not yet allocated)
        d["hasActiveRequest"] = co is not None and co.status in ("pending", "approved", "pending_receipt")
        # activeRequestedBy / activeDueDate: for "In Use - [Name] - available in X days".
        # The clock starts at the physical handover (item_due - the one clock):
        # approval delay must not eat into the employee's checkout days.
        # activeDueDay is that due date in the borrower's own time zone.
        d["activeRequestedBy"] = co.requested_by if co else None
        d["activeDueDate"] = None
        d["activeDueDay"] = None
        if co and co.days:
            at = item_due.due_at(co)
            if at is not None:
                d["activeDueDate"] = at.isoformat()
                d["activeDueDay"] = item_due.due_date(co, zones.get(co.requested_by_email)).isoformat()
        result.append(d)
    return result


@router.get("/signature")
def items_signature(db: Session = Depends(get_db)):
    """Cheap change-digest for the inventory fallback poll. The DB hashes the rows
    internally and returns two short strings, so the poll asks "did anything
    change?" for ~70 bytes instead of re-pulling the whole ~1000-item catalog every
    30s - that single poll was ~95% of the database's pooler egress. The client
    re-fetches the full list only when a digest flips; realtime still drives the
    instant updates. `items` covers item rows PLUS the checkouts the list's
    availability enrichment reads; `checkouts` covers the checkouts list.

    Cheap aggregate (Nov 2026): the old digest cast EVERY row of both tables to
    text and md5'd the joined string on every poll of every open tab. Now each
    table is summarized as row count + the sum of its rows' `xmin` (the id of
    the transaction that last wrote the row): any insert or delete moves the
    count, any update gives the row a new xmin and moves the sum - with no row
    serialized at all. A false "changed" only costs one refetch; it is a
    "did anything change?" probe, never data. On a backend without xmin
    (local SQLite dev) it returns empty strings and the client just falls
    back to always-fetching, exactly as before."""
    if db.get_bind().dialect.name != "postgresql":
        return {"items": "", "checkouts": ""}
    try:
        row = db.execute(sa_text(
            "SELECT "
            "  (SELECT count(*)::text || '.' || coalesce(sum(xmin::text::bigint), 0)::text FROM items) AS i_sig, "
            "  (SELECT count(*)::text || '.' || coalesce(sum(xmin::text::bigint), 0)::text FROM item_checkouts) AS c_sig"
        )).first()
        items_sig, co_sig = (row[0] or ""), (row[1] or "")
        return {"items": f"{items_sig}:{co_sig}", "checkouts": co_sig}
    except Exception:
        db.rollback()
        return {"items": "", "checkouts": ""}


# ── Serial numbers ────────────────────────────────────────────────────────────
# Each physical unit carries a static, Nexus-assigned serial (GG-#####). It is the
# identity the CSV import upserts on - names are NOT unique (10 identical laptops),
# so keying on name silently merged distinct units into one row (Sai, Jun 2026).

_SERIAL_RE = re.compile(r"^GG-(\d+)$", re.IGNORECASE)


def _serial_start(db: Session) -> int:
    """Next free auto-serial number. Scanned ONCE per import - autoflush=False means
    rows added during the loop are not visible to a re-query, so callers keep a local
    counter and never re-scan mid-batch."""
    top = 0
    for (s,) in db.query(Item.serial_number).all():
        m = _SERIAL_RE.match((s or "").strip())
        if m:
            top = max(top, int(m.group(1)))
    return top + 1


def _fmt_serial(n: int) -> str:
    return f"GG-{n:05d}"


# Spreadsheets use "N/A", "-", "none" etc. to mean "no value" - store them as blank
# so they don't render as real data (e.g. a Model column showing "... N/A").
_NA_TOKENS = {"", "n/a", "na", "n.a.", "n.a", "none", "null", "nil", "-", "–", "-"}


def _clean_field(v) -> str:
    s = (v or "").strip()
    return "" if s.lower() in _NA_TOKENS else s


# A loose "key" for a type so spelling/case/plural variants collapse to ONE type -
# "Office", "office", "OFFICES " all key to "office" (Neil: be smart about it). The
# valid set is the manager-curated item_types table; a static fallback canon covers
# the rare case where the table can't be read.
def _type_key(s) -> str:
    s = re.sub(r"\s+", " ", (s or "").strip().lower())
    if len(s) > 3 and s.endswith("ies"):                                  # batteries → battery
        return s[:-3] + "y"
    if len(s) > 4 and s.endswith(("ches", "shes", "ses", "xes", "zes")):  # boxes → box
        return s[:-2]
    if len(s) > 2 and s.endswith("s") and not s.endswith("ss"):           # cameras → camera
        return s[:-1]
    return s

def _build_canon(names) -> dict:
    return {_type_key(t): t for t in names}

_TYPE_CANON = _build_canon(_ITEM_TYPES)           # static fallback


def _seed_types_if_empty(db: Session) -> None:
    if db.query(ItemType).first():
        return
    now = _now_iso()
    for i, t in enumerate(_ITEM_TYPES):
        db.add(ItemType(name=t, sort_order=i, created_by="system", created_at=now))
    db.commit()


def _type_names(db: Session) -> list:
    _seed_types_if_empty(db)
    return [r.name for r in db.query(ItemType).order_by(ItemType.sort_order, ItemType.name).all()]


def _type_canon(db: Session) -> dict:
    return _build_canon(_type_names(db))


_AI_TYPE_MODEL = "claude-opus-4-8"

def _ai_match_types(new_labels: list, existing: list) -> dict:
    """Map each NEW label to an EXISTING type when it's the same kind of item - a
    spelling/abbreviation/plural/case variant (e.g. "IP Cams" → "IP Camera") - else
    None (it becomes a new type). Distinct items stay distinct (Laptop ≠ Computer,
    CCTV ≠ IP Camera). Returns {} with no API key or on error, so the caller just
    creates new types. One call per import keeps it cheap."""
    key = os.getenv("ANTHROPIC_API_KEY", "")
    if not key or not new_labels:
        return {}
    prompt = (
        "You normalise item-TYPE labels for a physical asset inventory.\n\n"
        f"EXISTING TYPES: {json.dumps(existing)}\n"
        f"NEW LABELS: {json.dumps(new_labels)}\n\n"
        "For each NEW LABEL decide if it is merely a spelling / abbreviation / plural / "
        "case variant of an EXISTING TYPE - i.e. the SAME kind of physical item.\n"
        'SAME (map it): "IP Cams" = "IP Camera"; "Laptops" = "Laptop"; "cctv camera" = "IP Camera" only if no better match.\n'
        'DIFFERENT - DO NOT MERGE: "Laptop" vs "Computer"; "CCTV" vs "IP Camera"; "Server" vs "Storage". '
        "These are genuinely different items even if related.\n"
        "Be conservative: only map when it is clearly the SAME item. Return ONLY a JSON object "
        "mapping each new label to the EXACT existing-type text it matches, or null if it is new. No prose."
    )
    try:
        with httpx.Client(timeout=30) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={"model": _AI_TYPE_MODEL, "max_tokens": 600, "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            data = r.json()
        txt = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        m = re.search(r"\{.*\}", txt, re.S)   # tolerate fences / stray text
        out = json.loads(m.group(0)) if m else {}
        return {k: v for k, v in out.items() if isinstance(k, str)}
    except Exception as e:  # noqa: BLE001
        print(f"[items] AI type match failed: {e}")
        return {}


def _normalize_type(raw, canon=None) -> str:
    s = _clean_field(raw)
    if not s:
        return "Other"
    # Match by the loose key so office/offices/OFFICE all land on the same type.
    # Anything with no match funnels to "Other" (the Add/Edit dropdowns can't produce
    # unknowns; CSV import auto-creates them - see import_items).
    return (canon or _TYPE_CANON).get(_type_key(s), "Other")


def _content_sig(name, item_type, make, model, year, department, location, ownership) -> tuple:
    """Identity of a serial-less row by its descriptive content (case-insensitive).
    Re-importing the same file matches each row to one existing unit by this sig, so
    it updates in place instead of duplicating - while two genuinely identical units
    still occupy two slots in the multiset and never collapse."""
    return tuple((x or "").strip().lower()
                 for x in (name, item_type, make, model, year, department, location, ownership))


@router.post("", status_code=201)
def create_item(body: ItemCreate, response: Response, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty")
    # P1-14: catalogue photos must come from our Supabase storage - same guard the
    # checkout/assignment evidence paths use - so external URLs can't land in every
    # user's catalogue.
    _validate_photo_url(body.photo_url, "photo_url")
    now = datetime.now(timezone.utc).isoformat()
    # A serial typed on Add Item is the unit's own (a manufacturer's or an
    # asset tag); it must be free - a clash is a 409 with the reason. Blank =
    # the next Nexus-assigned GG-#####.
    own_serial = _clean_field(body.serial_number)[:80]
    if own_serial:
        _check_serial_free(db, Item(id=""), own_serial)
    # Retry the rare serial race: two simultaneous adds can compute the same next
    # GG-##### and collide on the unique index. Recompute and retry a few times.
    for attempt in range(5 if not own_serial else 1):
        item = Item(
            id=str(uuid.uuid4()),
            serial_number=own_serial or _fmt_serial(_serial_start(db)),
            company_id=company_of(user, db),   # company wall: stamp creator's company
            name=name,
            item_type=_normalize_type(body.item_type, _type_canon(db)),
            make=(body.make or "").strip(),
            model=(body.model or "").strip(),
            year=(body.year or "").strip(),
            department=(body.department or "").strip(),
            default_owner=(body.default_owner or "").strip(),
            ownership_type=(body.ownership_type or "transient").strip(),
            # Permanent items start AVAILABLE too - "permanently_assigned" only
            # happens via the assignment flow once a real person accepts it.
            # Auto-stamping it at creation made unassigned items show as assigned.
            status="available",
            location=(body.location or "").strip(),
            photo_url=(body.photo_url or "").strip(),
            created_by=user["email"],
            created_at=now,
            picture_required=True if body.picture_required is None else bool(body.picture_required),
            asset_value=float(body.asset_value or 0),
            op_status=(body.op_status or "").strip() if (body.op_status or "").strip() in _OP_STATUSES else "",
            op_status_person_email=(body.op_status_person_email or "").lower().strip() if (body.op_status or "").strip() in _OP_STATUS_PERSON else "",
            op_status_person_name=(body.op_status_person_name or "").strip() if (body.op_status or "").strip() in _OP_STATUS_PERSON else "",
            custom_fields=body.custom_fields if isinstance(body.custom_fields, dict) else {},
        )
        db.add(item)
        try:
            db.commit()
            if (item.op_status or "") in _OP_STATUS_PERSON and item.op_status_person_email:
                _notify_op_status_declaration(db, op_status=item.op_status, person_email=item.op_status_person_email,
                                              person_name=item.op_status_person_name or "", item_name=item.name)
                db.commit()
            # Stamp the new id so the audit middleware can record WHICH item was
            # added (the path has no id on a POST) - lets the audit log thread an
            # item's full history by id, not just by name.
            response.headers["X-Created-Id"] = item.id
            return _item_to_dict(item)
        except IntegrityError:
            db.rollback()
    if own_serial:
        raise HTTPException(409, f"Serial {own_serial} is already used by another item.")
    raise HTTPException(409, "Could not assign a unique serial number - please try again.")


@router.post("/import")
def import_items(body: ItemImportRequest, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    now = datetime.now(timezone.utc).isoformat()
    created = updated = skipped = 0

    # Matching order: (1) SERIAL - the stable identity. (2) For rows with a BLANK
    # serial, a CONTENT signature matched as a MULTISET: re-importing the same file
    # maps each row onto one existing unit (so it updates in place instead of
    # duplicating), yet two genuinely identical units keep two slots and never
    # collapse. A blank-serial row only creates a NEW unit when no unclaimed match
    # is left - then it gets the next Nexus-assigned GG-#####.
    #
    # Company walls (Nov 2026): rows match ONLY the caller's own items - an item
    # of another company is never updated by somebody else's spreadsheet - and
    # never an item in the Recycle Bin unless `restore_deleted` asks for it (a
    # matched deleted item is then restored). A serial already taken by an
    # item the import may not touch is reported in `conflicts` and skipped
    # (the serial index is unique - creating a second one was a 500).
    scope = _scope(user, db)
    by_serial: dict[str, Item] = {}
    sig_pool: dict[tuple, deque] = defaultdict(deque)
    taken: dict[str, str] = {}         # serial -> why this import may not use it
    for it in db.query(Item).all():
        s = (it.serial_number or "").strip().lower()
        mine = _item_ok(it, scope)
        deleted = bool(it.deleted_at)
        if not mine:
            if s:
                taken.setdefault(s, "used by an item you cannot edit")
            continue
        if deleted and not body.restore_deleted:
            if s:
                taken.setdefault(s, "belongs to an item in the Recycle Bin - restore it first")
            continue
        if s:
            by_serial.setdefault(s, it)
        if not deleted:
            sig_pool[_content_sig(it.name, it.item_type, it.make, it.model, it.year,
                                  it.department, it.location, it.ownership_type)].append(it)
    conflicts: list = []
    restored = 0

    claimed: set[str] = set()          # existing items already matched this import
    next_serial = _serial_start(db)    # scanned once - see _serial_start
    _seed_types_if_empty(db)
    _type_rows = db.query(ItemType).all()
    canon = _build_canon([r.name for r in _type_rows])   # built once, extended below
    next_type_order = max([r.sort_order for r in _type_rows], default=0) + 1
    added_types: list = []             # new types this import created (manager-initiated)
    # Resolve any new type labels ONCE, up front. The AI maps same-item variants onto
    # an existing type (IP Cams → IP Camera) but keeps distinct items distinct; whatever
    # it doesn't match becomes a brand-new type. After this, the row loop just normalises.
    _raw_types  = {_clean_field(r.item_type) for r in body.items if _clean_field(r.item_type)}
    _new_labels = [t for t in _raw_types if _type_key(t) not in canon and len(t) <= 40]
    _ai_map = _ai_match_types(_new_labels, [r.name for r in _type_rows]) if _new_labels else {}
    for label in _new_labels:
        k = _type_key(label)
        if k in canon:
            continue
        match = _ai_map.get(label)
        match_key = _type_key(match) if isinstance(match, str) and match.strip() else None
        if match_key and match_key in canon:
            canon[k] = canon[match_key]    # variant of an existing type → reuse it
        else:
            db.add(ItemType(name=label, sort_order=next_type_order, created_by=user["email"], created_at=now))
            canon[k] = label
            next_type_order += 1
            added_types.append(label)

    def _claim_by_sig(sig):
        pool = sig_pool.get(sig)
        while pool:
            cand = pool.popleft()
            if cand.id not in claimed:
                return cand
        return None

    for row in body.items:
        name = (row.name or "").strip()
        if not name:
            skipped += 1
            continue
        ownership = (row.ownership_type or "transient").strip().lower()
        if ownership not in ("permanent", "transient"):
            ownership = "transient"
        item_type = _normalize_type(row.item_type, canon)   # canon resolved above
        make       = _clean_field(row.make)
        model      = _clean_field(row.model)
        year       = _clean_field(row.year)
        department = _clean_field(row.department)
        location   = _clean_field(row.location)
        default_owner = _clean_field(row.default_owner) or _TYPE_DEFAULT_OWNER.get(item_type, "")

        # Custom-field values supplied on the row (keyed by field_key). Blanks are
        # ignored so a sparse spreadsheet never wipes an existing value.
        row_cf = {k: v for k, v in (row.custom_fields or {}).items() if v not in (None, "")}

        serial = (row.serial_number or "").strip()
        if serial:
            existing = by_serial.get(serial.lower())   # same serial = same unit (repeats collapse)
            if existing is None and serial.lower() in taken:
                conflicts.append({"name": name, "serial": serial, "reason": taken[serial.lower()]})
                skipped += 1
                continue
        else:
            existing = _claim_by_sig(_content_sig(name, item_type, make, model, year, department, location, ownership))

        if existing is not None:
            # Update descriptive fields in place. Serial, status, photo, and the
            # assignment lifecycle are deliberately preserved.
            claimed.add(existing.id)   # so a later blank-serial row can't re-match this unit by content
            if existing.deleted_at:     # only reachable with restore_deleted
                _restore(existing)
                restored += 1
            existing.name          = name
            existing.item_type     = item_type
            existing.make          = make
            existing.model         = model
            existing.year          = year
            existing.department    = department
            existing.default_owner = default_owner
            existing.ownership_type = ownership
            existing.location      = location
            if row_cf:
                existing.custom_fields = {**(existing.custom_fields or {}), **row_cf}
            updated += 1
        else:
            # Honour a serial the CSV supplied; otherwise assign the next GG-#####,
            # skipping any already taken in the DB or earlier in this same file.
            if not serial:
                while _fmt_serial(next_serial).lower() in by_serial or _fmt_serial(next_serial).lower() in taken:
                    next_serial += 1
                serial = _fmt_serial(next_serial)
                next_serial += 1
            new_item = Item(
                id=str(uuid.uuid4()),
                serial_number=serial,
                company_id=company_of(user, db),   # company wall
                name=name,
                item_type=item_type,
                make=make,
                model=model,
                year=year,
                department=department,
                default_owner=default_owner,
                ownership_type=ownership,
                status="available",  # assignment flow sets permanently_assigned once accepted
                location=location,
                photo_url="",
                custom_fields=row_cf,
                created_by=user["email"],
                created_at=now,
            )
            db.add(new_item)
            by_serial[serial.lower()] = new_item  # a repeated explicit serial within the file collapses
            # NOT added to sig_pool: two identical rows in one file are two distinct
            # new units, so the second must not match the first.
            created += 1
    db.commit()
    # Report any types this import created so the UI can refresh the type list.
    return {"created": created, "updated": updated, "skipped": skipped,
            "added_types": sorted(set(added_types)), "restored": restored,
            "conflicts": conflicts}


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
def add_to_cart(body: CartAddBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    email = (user.get("preferred_username") or user.get("email") or "").lower()
    # Validate item exists and is requestable
    item = db.query(Item).filter(Item.id == body.item_id).first()
    if not item or item.deleted_at:
        raise HTTPException(404, "Item not found")
    import auth   # company wall: can't request another company's item
    auth.assert_company(getattr(item, "company_id", "") or "", user, db)
    if item.ownership_type != "transient":
        raise HTTPException(400, "Only transient items can be added to cart")
    _refuse_lost(item)
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
    _tag_item(response, item.id)
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


def _check_ownership_change(db: Session, item: Item, new_ownership: str) -> None:
    """An item someone holds (or has asked for) keeps its ownership: flipping
    it mid-flight strands the checkout or assignment (a transient item
    "permanently assigned", a permanent one checked out). Recover it first."""
    if not new_ownership or new_ownership == (item.ownership_type or ""):
        return
    live_co = db.query(ItemCheckout.id).filter(
        ItemCheckout.item_id == item.id, ItemCheckout.status.in_(_LIVE_CHECKOUT)).first()
    live_asg = db.query(ItemAssignment.id).filter(
        ItemAssignment.item_id == item.id,
        ItemAssignment.status.in_(["pending_acceptance", "active", "return_initiated"])).first()
    if live_co or live_asg:
        raise HTTPException(409, f'"{item.name}" is checked out or assigned right now - recover it before '
                                 "changing whether it is Permanent or Temporary.")


def _check_serial_free(db: Session, item: Item, serial: str) -> None:
    """Serials are unique (ix_items_serial_unique): a clash is a 409 with a
    reason, never the database's 500."""
    s = (serial or "").strip()
    if not s:
        return
    clash = (db.query(Item.id).filter(func.lower(Item.serial_number) == s.lower(), Item.id != item.id).first())
    if clash:
        raise HTTPException(409, f"Serial {s} is already used by another item.")


@router.patch("/{item_id}")
def update_item(item_id: str, body: ItemUpdate, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    import auth   # company wall: can't edit another company's item
    auth.assert_company(getattr(item, "company_id", "") or "", user, db)
    # P1-14: validate any new catalogue photo URL originates from our storage bucket.
    if body.photo_url is not None:
        _validate_photo_url(body.photo_url, "photo_url")
    if body.name is not None:
        n = body.name.strip()
        if not n:
            raise HTTPException(400, "Name cannot be empty")
        item.name = n
    if body.item_type  is not None:
        item.item_type = _normalize_type(body.item_type, _type_canon(db))
    if body.make           is not None: item.make           = body.make.strip()
    if body.model          is not None: item.model          = body.model.strip()
    if body.year           is not None: item.year           = body.year.strip()
    if body.department     is not None: item.department     = body.department.strip()
    if body.default_owner  is not None: item.default_owner  = body.default_owner.strip()
    if body.ownership_type is not None:
        ot = body.ownership_type.strip().lower()
        if ot and ot not in ("permanent", "transient"):
            raise HTTPException(400, "ownership_type must be 'permanent' or 'transient'")
        _check_ownership_change(db, item, ot)
        item.ownership_type = ot
    # P1-3: lifecycle `status` is derived-only - no raw write here (see ItemUpdate and
    # POST /items/{id}/reconcile-state). op_status below is the operational field.
    if body.location  is not None: item.location  = body.location.strip()
    if body.photo_url is not None: item.photo_url = body.photo_url.strip()
    if body.picture_required is not None: item.picture_required = bool(body.picture_required)
    if body.asset_value      is not None: item.asset_value      = float(body.asset_value)
    # Op status + the person it's declared against (lost/retired). Capture a fresh
    # declaration so we notify that person exactly once (on status or person change).
    notify_decl = None
    if body.op_status is not None:
        op = body.op_status.strip()
        if op and op not in _OP_STATUSES:
            raise HTTPException(400, f"Invalid op_status. Must be one of: {', '.join(_OP_STATUSES)}")
        prev_op    = item.op_status or ""
        prev_email = (item.op_status_person_email or "").lower()
        item.op_status = op
        if op in _OP_STATUS_PERSON:
            if body.op_status_person_email is not None:
                item.op_status_person_email = body.op_status_person_email.lower().strip()
            if body.op_status_person_name is not None:
                item.op_status_person_name = body.op_status_person_name.strip()
            new_email = (item.op_status_person_email or "").lower()
            if new_email and (op != prev_op or new_email != prev_email):
                notify_decl = (op, new_email, item.op_status_person_name or "", item.name)
        else:
            # status is no longer person-bound - drop any stale declaration person
            item.op_status_person_email = ""
            item.op_status_person_name  = ""
    if body.custom_fields is not None:
        # Merge: only the keys sent are changed; a key set to '' / None clears that field.
        merged = dict(item.custom_fields or {})
        for k, v in body.custom_fields.items():
            if v in (None, ""):
                merged.pop(k, None)
            else:
                merged[k] = v
        item.custom_fields = merged
    if notify_decl:
        _notify_op_status_declaration(db, op_status=notify_decl[0], person_email=notify_decl[1],
                                      person_name=notify_decl[2], item_name=notify_decl[3])
    db.commit()
    return _item_to_dict(item)


def _soft_delete(item: Item, user_email: str) -> None:
    """Mark an item deleted instead of dropping the row, so it can be restored and
    carries a "Deleted In" (location at deletion time) - Ankush. The serial/index
    stay reserved until the row is restored or purged."""
    item.deleted_at = datetime.now(timezone.utc).isoformat()
    item.deleted_by = user_email
    item.deleted_location = item.location or ""


@router.delete("/{item_id}")
def delete_item(item_id: str, user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item or item.deleted_at:
        raise HTTPException(404, "Item not found")
    _wall_item(item, user, db)
    active = db.query(ItemCheckout).filter(
        ItemCheckout.item_id == item_id,
        ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"]),
    ).count()
    if active:
        raise HTTPException(409, "Cannot delete an item with an active checkout against it")
    live_assignment = db.query(ItemAssignment).filter(
        ItemAssignment.item_id == item_id,
        ItemAssignment.status.in_(["pending_acceptance", "active", "return_initiated"]),
    ).count()
    if live_assignment:
        raise HTTPException(409, "Cannot delete an item someone is still assigned - recover it first")
    _soft_delete(item, user["email"])
    db.commit()
    return {"ok": True}


class BulkDeleteRequest(BaseModel):
    ids: list[str]


@router.post("/bulk-delete")
def bulk_delete_items(body: BulkDeleteRequest, user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    """Soft-delete many items in ONE transaction instead of one request per item
    (the client used to loop, which made deleting 30+ items take 10-20s). Items
    with an active checkout are skipped and reported as `blocked`."""
    ids = [i for i in (body.ids or []) if i]
    if not ids:
        return {"deleted": 0, "blocked": [], "notFound": []}

    # One query each: which of these items still have a live checkout, and which
    # actually exist - instead of N round-trips.
    active_item_ids = {
        row.item_id for row in db.query(ItemCheckout.item_id).filter(
            ItemCheckout.item_id.in_(ids),
            ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"]),
        ).all()
    }
    # Live permanent assignments block deletion the same way live checkouts do -
    # deleting a held item orphans the assignment once the recycle bin purges.
    assigned_item_ids = {
        row.item_id for row in db.query(ItemAssignment.item_id).filter(
            ItemAssignment.item_id.in_(ids),
            ItemAssignment.status.in_(["pending_acceptance", "active", "return_initiated"]),
        ).all()
    }
    scope = _scope(user, db)
    items = [it for it in db.query(Item).filter(Item.id.in_(ids), or_(Item.deleted_at.is_(None), Item.deleted_at == "")).all()
             if _item_ok(it, scope)]   # another company's item reads as not found
    found_ids = {it.id for it in items}

    blocked, deleted = [], 0
    for it in items:
        if it.id in active_item_ids:
            blocked.append({"id": it.id, "name": it.name, "reason": "active checkout"})
            continue
        if it.id in assigned_item_ids:
            blocked.append({"id": it.id, "name": it.name, "reason": "live assignment"})
            continue
        _soft_delete(it, user["email"])
        deleted += 1
    db.commit()  # single commit for the whole batch

    return {
        "deleted": deleted,
        "blocked": blocked,
        "notFound": [i for i in ids if i not in found_ids],
    }


@router.get("/deleted")
def list_deleted_items(user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    """The recycle bin - soft-deleted items, most-recently-deleted first, so a
    bad 'select all + delete' is recoverable (Ankush). A READ: nothing is
    deleted here (Nov 2026 - it used to purge expired rows for good on every
    open). Deleting forever is POST /items/recycle-bin/delete-expired, an
    explicit act."""
    scope = _scope(user, db)
    rows = db.query(Item).filter(Item.deleted_at.isnot(None), Item.deleted_at != "") \
             .order_by(Item.deleted_at.desc()).limit(2000).all()
    return [_item_to_dict(i) for i in rows if _item_ok(i, scope)]


@router.post("/recycle-bin/delete-expired")
def delete_expired_forever(user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    """Delete forever the items that have sat in the Recycle Bin longer than
    the retention window (_RECYCLE_BIN_DAYS), within the caller's company
    scope. An explicit act (the screen should confirm it with a hold - it
    cannot be taken back), never a side effect of a read. An item that was
    ever checked out or assigned is KEPT - deleting it would orphan the
    history rows that point at it - and is counted in `kept`."""
    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(days=_RECYCLE_BIN_DAYS)).isoformat()
    scope = _scope(user, db)
    expired = [it for it in db.query(Item).filter(
        Item.deleted_at.isnot(None), Item.deleted_at != "", Item.deleted_at < cutoff).all()
        if _item_ok(it, scope)]
    ids = [it.id for it in expired]
    with_history = set()
    if ids:
        with_history |= {r[0] for r in db.query(ItemCheckout.item_id).filter(ItemCheckout.item_id.in_(ids)).all()}
        with_history |= {r[0] for r in db.query(ItemAssignment.item_id).filter(ItemAssignment.item_id.in_(ids)).all()}
    deleted = 0
    for it in expired:
        if it.id in with_history:
            continue
        db.delete(it)
        deleted += 1
    db.commit()
    return {"deleted": deleted, "kept": len(expired) - deleted}


class RestoreRequest(BaseModel):
    ids: list[str]


def _restore(item: Item) -> None:
    item.deleted_at = item.deleted_by = item.deleted_location = ""


@router.post("/{item_id}/restore")
def restore_item(item_id: str, user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    _wall_item(item, user, db)
    if not item.deleted_at:
        raise HTTPException(409, "Item is not deleted")
    _restore(item)
    db.commit()
    return _item_to_dict(item)


@router.post("/bulk-restore")
def bulk_restore_items(body: RestoreRequest, user: dict = Depends(require_items_delete), db: Session = Depends(get_db)):
    ids = [i for i in (body.ids or []) if i]
    if not ids:
        return {"restored": 0}
    restored = 0
    scope = _scope(user, db)
    for it in db.query(Item).filter(Item.id.in_(ids), Item.deleted_at.isnot(None), Item.deleted_at != "").all():
        if not _item_ok(it, scope):
            continue
        _restore(it)
        restored += 1
    db.commit()
    return {"restored": restored}


class BulkUpdateRequest(BaseModel):
    ids:    list[str]
    fields: dict          # only the descriptive fields the user chose to change


# Fields a batch edit may touch. Serial is the static identity and is never editable
# here; status/photo/assignment lifecycle are owned by their own flows.
_BATCH_EDITABLE = {
    "name", "item_type", "make", "model", "year",
    "department", "default_owner", "ownership_type", "location", "op_status",
    "asset_value",
}


@router.post("/bulk-update")
def bulk_update_items(body: BulkUpdateRequest, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """Apply the SAME field changes to many items in one transaction - the Manage
    tab's Batch Edit. Only whitelisted descriptive fields are written, and only the
    keys the user actually chose to change are present in `fields`."""
    ids = [i for i in (body.ids or []) if i]
    changes = {k: v for k, v in (body.fields or {}).items() if k in _BATCH_EDITABLE}
    if not ids or not changes:
        return {"updated": 0}

    # Normalise the way create/import do, so batch edits stay consistent with them.
    if "item_type" in changes:
        changes["item_type"] = _normalize_type(changes["item_type"], _type_canon(db))
    if "ownership_type" in changes:
        o = (changes["ownership_type"] or "transient").strip().lower()
        changes["ownership_type"] = o if o in ("permanent", "transient") else "transient"
    if "op_status" in changes:
        op = (changes["op_status"] or "").strip()
        if op and op not in _OP_STATUSES:
            raise HTTPException(400, f"Invalid op_status. Must be one of: {', '.join(_OP_STATUSES)}")
        changes["op_status"] = op
    if "name" in changes:
        nm = (changes["name"] or "").strip()
        if not nm:
            raise HTTPException(400, "Name cannot be empty")
        changes["name"] = nm
    for k in ("make", "model", "year", "department", "default_owner", "location"):
        if k in changes:
            changes[k] = (changes[k] or "").strip()
    if "asset_value" in changes:
        try:
            changes["asset_value"] = float(changes["asset_value"] or 0)
        except (ValueError, TypeError):
            changes["asset_value"] = 0.0

    updated = 0
    blocked = []
    op_changed = "op_status" in changes
    scope = _scope(user, db)
    for it in db.query(Item).filter(Item.id.in_(ids), or_(Item.deleted_at.is_(None), Item.deleted_at == "")).all():
        if not _item_ok(it, scope):
            continue                      # another company's item: not found, untouched
        if "ownership_type" in changes:
            try:
                _check_ownership_change(db, it, changes["ownership_type"])
            except HTTPException:
                blocked.append({"id": it.id, "name": it.name, "reason": "checked out or assigned"})
                continue
        for k, v in changes.items():
            setattr(it, k, v)
        # A batch can't attach a per-item person, so drop any stale declaration when
        # the op_status is changed in bulk (set the person via single Edit instead).
        if op_changed:
            it.op_status_person_email = ""
            it.op_status_person_name  = ""
        updated += 1
    db.commit()
    return {"updated": updated, "blocked": blocked}


# ── Custom fields ─────────────────────────────────────────────────────────────
# Admin-defined extra fields surfaced in the item Details panel (Ankush). The
# definition lives in item_custom_fields; the per-item value lives in
# items.custom_fields keyed by field_key, so the main table stays lean.

def _slugify_key(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (label or "").strip().lower()).strip("_")
    return s or "field"


class CustomFieldIn(BaseModel):
    field_key:       Optional[str]  = ""
    label:           str
    field_type:      Optional[str]  = "text"
    options:         Optional[list] = None
    applies_to_type: Optional[str]  = ""
    sort_order:      Optional[int]  = 0


@router.get("/custom-fields")
def list_custom_fields(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(ItemCustomField).order_by(ItemCustomField.sort_order, ItemCustomField.label).all()
    return [_custom_field_to_dict(f) for f in rows]


@router.post("/custom-fields", status_code=201)
def create_custom_field(body: CustomFieldIn, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    label = (body.label or "").strip()
    if not label:
        raise HTTPException(400, "Label cannot be empty")
    ftype = (body.field_type or "text").strip().lower()
    if ftype not in _CUSTOM_FIELD_TYPES:
        raise HTTPException(400, f"Invalid field type. Must be one of: {', '.join(_CUSTOM_FIELD_TYPES)}")
    # Derive a stable key from the label, kept unique across definitions.
    base = (body.field_key or "").strip() or _slugify_key(label)
    existing = {f.field_key for f in db.query(ItemCustomField.field_key).all()}
    key, n = base, 2
    while key in existing:
        key = f"{base}_{n}"; n += 1
    f = ItemCustomField(
        id=str(uuid.uuid4()), field_key=key, label=label, field_type=ftype,
        options=[str(o).strip() for o in (body.options or []) if str(o).strip()] if ftype == "select" else [],
        applies_to_type=(body.applies_to_type or "").strip(),
        sort_order=int(body.sort_order or 0),
        created_by=user["email"], created_at=datetime.now(timezone.utc).isoformat(),
    )
    db.add(f)
    db.commit()
    return _custom_field_to_dict(f)


@router.patch("/custom-fields/{field_id}")
def update_custom_field(field_id: str, body: CustomFieldIn, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    f = db.query(ItemCustomField).filter(ItemCustomField.id == field_id).first()
    if not f:
        raise HTTPException(404, "Custom field not found")
    if body.label is not None and body.label.strip():
        f.label = body.label.strip()
    if body.field_type:
        ftype = body.field_type.strip().lower()
        if ftype not in _CUSTOM_FIELD_TYPES:
            raise HTTPException(400, f"Invalid field type. Must be one of: {', '.join(_CUSTOM_FIELD_TYPES)}")
        f.field_type = ftype
    if body.options is not None:
        f.options = [str(o).strip() for o in body.options if str(o).strip()] if f.field_type == "select" else []
    if body.applies_to_type is not None:
        f.applies_to_type = body.applies_to_type.strip()
    if body.sort_order is not None:
        f.sort_order = int(body.sort_order or 0)
    db.commit()
    return _custom_field_to_dict(f)


@router.delete("/custom-fields/{field_id}")
def delete_custom_field(field_id: str, user: dict = Depends(require_custom_field_delete), db: Session = Depends(get_db)):
    f = db.query(ItemCustomField).filter(ItemCustomField.id == field_id).first()
    if not f:
        raise HTTPException(404, "Custom field not found")
    db.delete(f)  # per-item values stay in items.custom_fields but stop showing - harmless
    db.commit()
    return {"ok": True}


# ── Item types (manager-curated) ──────────────────────────────────────────────
# Managers extend the type list here; a CSV can't invent one (it funnels to Other).
class ItemTypeIn(BaseModel):
    name: str


@router.get("/types")
def list_item_types(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    # Cached (cache.py): fetched on every Inventory mount, changes only via the
    # Manage tab (whose writes invalidate it through the ItemType watch).
    import cache
    return cache.item_types.get_or_load("all", lambda: _type_names(db))


@router.post("/types", status_code=201)
def add_item_type(body: ItemTypeIn, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Type name cannot be empty")
    if len(name) > 40:
        raise HTTPException(400, "Type name is too long (40 characters max)")
    _seed_types_if_empty(db)
    rows = db.query(ItemType).all()
    # Dedupe by the loose key so office/offices/OFFICE collapse to one type.
    if any(_type_key(r.name) == _type_key(name) for r in rows):
        return _type_names(db)
    nxt = max([r.sort_order for r in rows], default=0) + 1
    db.add(ItemType(name=name, sort_order=nxt, created_by=user["email"], created_at=_now_iso()))
    db.commit()
    return _type_names(db)


# ── Type settings: Borrowable and the longest loan (Neil, 11/02/2026) ────────
# Borrow lists only the types people can borrow. Each type has a switch; until
# an admin flips it, a type is borrowable when it has temporary (checkout)
# items or no items yet, and not when every item of it is permanent (laptops,
# phones). Its longest loan caps the return date Borrow offers; 0 = the
# 90-day ceiling every checkout already had.

_LOAN_CEILING_DAYS = 90


def _type_row(db: Session, name: str):
    key = (name or "").strip().lower()
    if not key:
        return None
    return next((r for r in db.query(ItemType).all() if (r.name or "").strip().lower() == key), None)


def _loan_cap(db: Session, type_name: str) -> int:
    """The most days a Borrow request may ask for on an item of this type."""
    row = _type_row(db, type_name)
    cap = int(getattr(row, "max_loan_days", 0) or 0) if row else 0
    return min(cap, _LOAN_CEILING_DAYS) if cap > 0 else _LOAN_CEILING_DAYS


def _type_borrowable(row, transient: int, permanent: int) -> bool:
    """The effective switch: the admin's when set, else the default rule."""
    if row is not None and row.borrowable is not None:
        return bool(row.borrowable)
    return transient > 0 or permanent == 0


class ItemTypeSettingsIn(BaseModel):
    borrowable:    Optional[bool] = None   # None = leave as it is
    use_default:   Optional[bool] = False  # True = back to the default rule
    max_loan_days: Optional[int] = None    # 0 = no type cap (the 90-day ceiling)


def _type_settings(db: Session, user: dict) -> list:
    _seed_types_if_empty(db)
    scope = _scope(user, db)
    counts: dict = defaultdict(lambda: [0, 0])   # type key -> [transient, permanent]
    for it in db.query(Item).filter(or_(Item.deleted_at.is_(None), Item.deleted_at == "")).all():
        if not _item_ok(it, scope):
            continue
        c = counts[(it.item_type or "").strip().lower()]
        c[0 if (it.ownership_type or "transient") == "transient" else 1] += 1
    out = []
    for r in db.query(ItemType).order_by(ItemType.sort_order, ItemType.name).all():
        t, p = counts.get((r.name or "").strip().lower(), [0, 0])
        cap = int(r.max_loan_days or 0)
        out.append({"name": r.name, "borrowable": _type_borrowable(r, t, p),
                    "borrowableSet": None if r.borrowable is None else bool(r.borrowable),
                    "maxLoanDays": cap,
                    "loanCapDays": min(cap, _LOAN_CEILING_DAYS) if cap > 0 else _LOAN_CEILING_DAYS,
                    "temporaryCount": t, "permanentCount": p})
    return out


@router.get("/types/settings")
def list_item_type_settings(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Each type with its Borrowable switch (effective, and the admin's own
    choice or null), its longest loan and how many items of it the caller can
    see. Borrow reads it to hide the types people cannot borrow."""
    return _type_settings(db, user)


@router.patch("/types/{name}")
def update_item_type_settings(name: str, body: ItemTypeSettingsIn, user: dict = Depends(require_items_admin),
                              db: Session = Depends(get_db)):
    row = _type_row(db, name)
    if row is None:
        raise HTTPException(404, "Item type not found")
    if body.use_default:
        row.borrowable = None
    elif body.borrowable is not None:
        row.borrowable = bool(body.borrowable)
    if body.max_loan_days is not None:
        days = int(body.max_loan_days)
        if days < 0 or days > _LOAN_CEILING_DAYS:
            raise HTTPException(400, f"The longest loan is 0 (no cap) to {_LOAN_CEILING_DAYS} days")
        row.max_loan_days = days
    db.commit()
    return _type_settings(db, user)


@router.delete("/types/{name}")
def delete_item_type(name: str, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    if name.strip().lower() == "other":
        raise HTTPException(400, "“Other” is the fallback type and can't be removed.")
    row = next((r for r in db.query(ItemType).all() if r.name.lower() == name.strip().lower()), None)
    if row:
        db.delete(row)
        db.commit()
    return _type_names(db)


# ── Checkouts ─────────────────────────────────────────────────────────────────

class CheckoutIn(BaseModel):
    id:                  Optional[str] = None  # ignored - server generates
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
    # The return date picked on Borrow's calendar (YYYY-MM-DD, the borrower's
    # own zone - Neil, 11/02/2026). When given it sets `days`; see item_due.
    due_date:            Optional[str] = ""

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
    condition:                 Optional[str] = "ok"  # P1-13: ok | damaged | lost (return only)
    handover_photo_by:         Optional[str] = ""   # 'allocator' | 'employee'
    handover_batch:            Optional[bool] = False
    receipt_photo_url:         Optional[str] = ""
    receipt_photo_name:        Optional[str] = ""
    handed_over_at:            Optional[str] = ""


_HISTORY_CAP = 2000


@router.get("/checkouts")
def list_checkouts(history_limit: int = _HISTORY_CAP, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Every LIVE checkout the caller may see (pending, approved, handed over,
    in use - never capped: a cap used to drop live rows once the table passed
    2,000, so an item someone holds vanished from every list), plus the most
    recent finished ones up to `history_limit` (at most 5,000). Managers see
    their companies' rows (the wall) and their own; everyone else their own
    as requester or allocator. Newest first."""
    me = _me(user)
    mine = or_(func.lower(ItemCheckout.requested_by_email) == me,
               func.lower(ItemCheckout.assigned_allocator_email) == me)
    base = db.query(ItemCheckout)
    if not _is_items_manager(user, db):
        base = base.filter(mine)
    else:
        allowed = visible_item_ids(db, user)
        if allowed is not None:
            base = base.filter(or_(ItemCheckout.item_id.in_(list(allowed)), mine) if allowed else mine)
    cap = max(0, min(int(history_limit or 0), 5000))
    live = base.filter(ItemCheckout.status.in_(_LIVE_CHECKOUT)).order_by(ItemCheckout.created_at.desc()).all()
    done = (base.filter(ItemCheckout.status.notin_(_LIVE_CHECKOUT))
            .order_by(ItemCheckout.created_at.desc()).limit(cap).all()) if cap else []
    rows = sorted(live + done, key=lambda c: c.created_at or "", reverse=True)
    import item_due
    zones = item_due.Zones(db)
    return [_checkout_to_dict(c, zones) for c in rows]


@router.post("/checkouts", status_code=201)
def create_checkout(body: CheckoutIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    body.validate_days()
    body.validate_lengths()
    if not body.reason.strip():
        raise HTTPException(400, "Reason for checkout is required")

    # Server always generates the checkout ID - client-supplied IDs are ignored
    # to prevent ID injection / collision attacks.
    server_id = f"ICHK-{uuid.uuid4().hex[:8].upper()}-{uuid.uuid4().hex[:8].upper()}"

    # P1-1: lock the item row so two concurrent checkout requests can't both pass the
    # availability / active-checkout check and double-book the same unit. FOR UPDATE
    # serializes them; the loser then sees the winner's committed state below.
    item = db.query(Item).filter(Item.id == body.item_id).with_for_update().first()
    if not item or item.deleted_at:
        raise HTTPException(404, "Item not found")
    _wall_item(item, user, db)   # company wall: never another company's item (404)
    if item.ownership_type != "transient":
        raise HTTPException(400, "Only transient items can be checked out")
    _refuse_lost(item)
    type_row = _type_row(db, item.item_type)
    if type_row is not None and type_row.borrowable is False:
        raise HTTPException(400, f"{item.item_type} items are not borrowable")
    # Who it is for: anyone may raise a request on someone's behalf (ops staff
    # checking items out for a crew member - Neil), but that person must be a
    # current Nexus person inside the caller's company scope; so must the
    # manager it is addressed to.
    _validate_photo_url(body.checkout_photo_url, "checkout_photo_url")
    requester_email = (body.requested_by_email or "").lower().strip() or _me(user)
    if requester_email != _me(user):
        _require_person(db, requester_email, user, "person this request is for")
    if (body.approver_email or "").strip():
        _require_person(db, body.approver_email, user, "manager to approve this request")
    if item.status != "available":
        raise HTTPException(409, f'"{item.name}" is no longer available - it may have just been taken by someone else')

    # The return date (Neil, 11/02/2026): the date picked on the calendar sets
    # the loan length - the days from the borrower's today to it - capped by
    # the type's longest loan. An older client still sends a number of days,
    # capped the same way.
    import item_due
    picked_iso = ""
    cap = _loan_cap(db, item.item_type)
    if (body.due_date or "").strip():
        try:
            picked = date.fromisoformat(body.due_date.strip()[:10])
        except ValueError:
            raise HTTPException(400, "The return date must be a date (YYYY-MM-DD)")
        tz = item_due.zone_for(db, requester_email)
        days = item_due.loan_days(picked, tz)
        if days < 1:
            raise HTTPException(400, "Pick a return date after today")
        if days > cap:
            last = item_due.local_today(tz) + timedelta(days=cap)
            raise HTTPException(400, f"{item.item_type or 'This item'} can be borrowed for up to {cap} days - "
                                     f"pick a return date on or before {last.strftime('%m/%d/%Y')}")
        body.days = days
        picked_iso = picked.isoformat()
    elif body.days > cap:
        raise HTTPException(400, f"{item.item_type or 'This item'} can be borrowed for up to {cap} days")

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
    # Managers and above (or an inventory editor+ grant) don't need a separate
    # approval for their own checkouts
    is_manager = _is_items_manager(user, db)
    user_email = _me(user)
    self_checkout = is_manager and requester_email == user_email
    initial_status = "approved" if self_checkout else "pending"

    order_id = (body.order_id or "").strip()
    row = ItemCheckout(
        id=server_id,
        item_id=body.item_id,
        item_name=item.name,                        # the catalog's, never the client's copy
        item_type=item.item_type or body.item_type or "",
        requested_by=body.requested_by,
        requested_by_email=requester_email,
        raised_by=body.raised_by,
        department=body.department,
        days=body.days,
        reason=body.reason,
        status=initial_status,
        created_at=now,
        resolved_at=now if self_checkout else "",
        resolved_by=_display_name(db, user_email) if self_checkout else "",
        checkout_photo_url=body.checkout_photo_url or "",
        checkout_photo_name=body.checkout_photo_name or "",
        order_id=order_id,
        approver_email=(body.approver_email or "").lower().strip(),
        approver_name=(body.approver_name or "").strip(),
        requested_due_date=picked_iso,
    )
    db.add(row)
    if initial_status == "pending":
        # One notification per order - if this order_id already has a checkout_pending
        # notification, skip to avoid spamming managers with N alerts for one cart.
        # Cart submits POST all items concurrently, so take an advisory lock on the
        # order_id first; otherwise every request sees "no notification yet" and
        # the dedupe check races into N duplicates.
        if order_id and db.get_bind().dialect.name == "postgresql":
            db.execute(sa_text("SELECT pg_advisory_xact_lock(hashtext(:oid))"), {"oid": order_id})
        ref_for_notif = order_id if order_id else server_id
        # Only an UN-actioned notification counts as "already notified" - a
        # re-request rejoining an old order must ping the manager again even
        # though the order's original notification was long since handled.
        already_notified = _bells(db, "checkout_pending", order_id) if order_id else []
        # Item count + total $ value of the order so far (this row included) -
        # the manager sees what's at stake before approving. autoflush is off,
        # so the current row is counted manually.
        sib_item_ids = [r[0] for r in db.query(ItemCheckout.item_id).filter(
            ItemCheckout.order_id == order_id,
            ItemCheckout.id != server_id,
            ItemCheckout.status == "pending",
        ).all()] if order_id else []
        order_count = len(sib_item_ids) + 1
        val_rows = db.query(Item).filter(Item.id.in_(set(sib_item_ids + [body.item_id]))).all()
        total_value = sum(float(i.asset_value or 0) for i in val_rows)
        notif_body = (f"{body.requested_by} has submitted a Checkout Request - "
                      f"{order_count} item{'s' if order_count != 1 else ''}"
                      + (f", total value **${total_value:,.0f}**" if total_value > 0 else "")
                      + ".\nPlease review, approve or reject.")
        if not already_notified:
            # Targeted: only the manager the employee picked gets the notification.
            # No approver picked (legacy clients / managers raising on behalf): the
            # items managers of the ITEM's company, by name (Nov 2026 - it was the
            # all-managers broadcast, stamped with no company, so once the walls
            # were armed nobody but the Super Administrators saw it). The '' broadcast
            # is left only for a company with no items manager at all. The request
            # itself stays in every items manager's Checkouts tab regardless.
            approver = (body.approver_email or "").lower().strip()
            to = [approver] if approver else _items_managers_for(
                db, item.company_id or "", exclude=[requester_email])
            _notify_team(db, type="checkout_pending", recipients=to,
                         title=f"Checkout Request - {body.requested_by}", body=notif_body,
                         ref_id=ref_for_notif, item_name=item.name, requested_by=body.requested_by,
                         about_email=requester_email, company=item.company_id or "")
        else:
            # Subsequent cart items: refresh the count/value on the existing
            # notification(s) (the realtime ping pushes the new body to open bells)
            for n in already_notified:
                n.body = notif_body
    db.commit()
    _fire_item_event(server_id, initial_status, row.requested_by_email or "")
    _tag_item(response, row.item_id)
    return _checkout_to_dict(row, item_due.Zones(db))


def _settle_handover_bells(db: Session, row: ItemCheckout, prev_status: str) -> None:
    """Keep the two handover bells true once `row` has moved on (Nov 2026 -
    they used to linger after the work was done):
      * the allocator's "Hand over" bell (allocate_request) lists only the
        items still waiting for them (approved) - actioned when none is left
        (the item handed over, rejected or cancelled);
      * the requester's "Confirm receipt" bell counts only the items still
        to confirm (pending_receipt) - actioned when none is left (receipt
        confirmed, or the handover cancelled).
    One bell per order (or per solo checkout), updated in place. autoflush is
    off, so `row`'s new status is applied by hand."""
    ref = row.order_id or row.id
    sibs = (db.query(ItemCheckout).filter(ItemCheckout.order_id == row.order_id, ItemCheckout.id != row.id).all()
            if row.order_id else [])
    alloc = (row.assigned_allocator_email or "").lower()
    if alloc and prev_status == "approved" and row.status != "approved":
        waiting = [s.item_name for s in sibs
                   if s.status == "approved" and (s.assigned_allocator_email or "").lower() == alloc]
        for n in _bells(db, "allocate_request", ref, alloc):
            if not waiting:
                n.actioned = True
            elif len(waiting) == 1:
                n.title, n.body = f"Hand over: {waiting[0]}", f"Please hand {waiting[0]} over to {row.requested_by}."
            else:
                n.title = f"Hand over {len(waiting)} items to {row.requested_by}"
                n.body = f"Please hand over: {', '.join(waiting)}."
    if prev_status == "pending_receipt" and row.status != "pending_receipt":
        left = [s for s in sibs if s.status == "pending_receipt"]
        for n in _bells(db, "allocated", ref, row.requested_by_email, title_prefix="Confirm receipt"):
            if not left:
                n.actioned = True
            else:
                n.title = f"Confirm receipt: {len(left)} item{'s' if len(left) != 1 else ''}"
                n.body = (f"{left[0].item_name} has been handed over. Please confirm receipt and upload a photo."
                          if len(left) == 1 else
                          f"{len(left)} items from your request have been handed over. "
                          "Please confirm receipt and upload a photo for each.")


@router.patch("/checkouts/{checkout_id}")
def update_checkout(checkout_id: str, body: CheckoutStatusUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    # Lock order (Nov 2026): an order's rows are locked TOGETHER, in id order,
    # behind the same advisory lock create_checkout takes on the order id -
    # never "this row first, then its siblings". "Approve All" / "Hand Over
    # All" / "Return All" fire one PATCH per item in parallel; locking the own
    # row first meant two of them could each hold one row and wait on the
    # other's (a deadlock Postgres broke by failing one Approve). Locking the
    # rows also serializes the order-level notification batching below, so
    # each transaction sees the previous one's commit (one bell per order).
    # A SOLO checkout (no order) locks its own row (P1-2: a concurrent
    # approve + cancel could otherwise both read "pending").
    head = db.query(ItemCheckout.order_id).filter(ItemCheckout.id == checkout_id).first()
    if head is None:
        # Was a 200 {"ok": false} fake-success - clients checking resp.ok showed
        # success on a vanished/stale checkout (Jul 14 audit family).
        raise HTTPException(404, "Checkout not found")
    row = None
    if head[0]:
        if db.get_bind().dialect.name == "postgresql":
            db.execute(sa_text("SELECT pg_advisory_xact_lock(hashtext(:oid))"), {"oid": head[0]})
        for r in (db.query(ItemCheckout).filter(ItemCheckout.order_id == head[0])
                  .order_by(ItemCheckout.id).with_for_update().all()):
            if r.id == checkout_id:
                row = r
    if row is None:
        row = db.query(ItemCheckout).filter(ItemCheckout.id == checkout_id).with_for_update().first()
    if not row:
        raise HTTPException(404, "Checkout not found")
    _wall_checkout(row, user, db)   # company wall: 404 unless a party or in scope

    # Validate photo URLs to prevent fake evidence from external sources
    _validate_photo_url(body.checkout_photo_url, "checkout_photo_url")
    _validate_photo_url(body.receipt_photo_url,  "receipt_photo_url")
    _validate_photo_url(body.return_photo_url,   "return_photo_url")

    me = _me(user)
    items_mgr = _is_items_manager(user, db)   # manager+ OR inventory grant editor+
    is_allocator = bool(row.assigned_allocator_email) and row.assigned_allocator_email.lower() == me
    is_requester = bool(row.requested_by_email) and row.requested_by_email.lower() == me
    if body.status in ("approved", "rejected") and not items_mgr:
        raise HTTPException(403, "Manager or above required to approve or reject checkouts")
    if body.status == "approved":
        if not (body.assigned_allocator_email or "").strip():
            raise HTTPException(400, "Pick who should allocate this item before approving")
        _require_person(db, body.assigned_allocator_email, user, "allocator")
    if body.status == "pending_receipt":
        if not is_allocator and not items_mgr:
            raise HTTPException(403, "Only the assigned allocator or a manager can initiate handover")
    if body.status == "allocated":
        if not is_allocator and not is_requester and not items_mgr:
            raise HTTPException(403, "Only the assigned allocator, the requester, or a manager can confirm handover")
        # Evidence (Nov 2026): the requester only CONFIRMS RECEIPT of an item the
        # allocator has handed over - they never hand it to themselves straight
        # from "approved", skipping the allocator and the handover photo.
        if is_requester and not is_allocator and not items_mgr and row.status != "pending_receipt":
            raise HTTPException(403, "Your allocator hands the item over first - confirm receipt once they have.")
    if body.status == "returned" and not (is_requester or is_allocator or items_mgr):
        # Evidence (Nov 2026): the holder, the allocator who handed it over, or an
        # items manager checks an item back in - not any supervisor.
        raise HTTPException(403, "Only the person holding the item, its allocator or an items manager can check it back in")
    if body.status == "cancelled":
        # P1-7: the requester can always self-cancel; a manager (or inventory
        # editor+ grant) may also cancel a still-pending/approved checkout on
        # someone's behalf (symmetric with assignment force-cancel). The
        # requester is then told WHO cancelled it (below). A handed-over item
        # (pending_receipt) is cancelled only by an items manager through
        # POST /items/{id}/reconcile-state (Nov 2026): the item is physically
        # with someone, so the requester cannot just make the record vanish.
        if not is_requester and not items_mgr:
            raise HTTPException(403, "You can only cancel your own checkouts")
        if row.status == "pending_receipt":
            raise HTTPException(409, "This item was already handed over - ask an items manager to cancel the handover")
        if items_mgr and not is_requester and row.status not in ("pending", "approved"):
            raise HTTPException(409, "A manager can only cancel a pending or approved checkout")

    valid_predecessors = _VALID_TRANSITIONS.get(body.status)
    if valid_predecessors is not None and row.status not in valid_predecessors:
        raise HTTPException(409, f"Cannot move a '{row.status}' checkout to '{body.status}'")

    now = datetime.now(timezone.utc).isoformat()
    item = db.query(Item).filter(Item.id == row.item_id).first()
    prev_status = row.status
    actor_name = _display_name(db, me)   # who acted comes from the session, never the client
    if body.status == "approved" or (body.status == "allocated" and prev_status == "approved"):
        _refuse_lost(item)   # a lost item is not approved or handed over until found

    # Photos are evidence: the handover, the receipt and the return each need one,
    # unless the item is flagged photo-optional (picture_required False, e.g. keys).
    # Checked here, before anything is mutated. A handover photo already on the row
    # counts. Not asked for:
    #   - pending_receipt: the allocator chose "employee takes the photo", so the
    #     evidence is the receipt photo the employee uploads on the next step;
    #   - a lost item (nothing to photograph);
    #   - a check-in by an ITEMS MANAGER on the holder's behalf with a reason
    #     (force return - the holder is not there to photograph it; the reason
    #     is the record). The allocator returning it on the holder's behalf
    #     still needs a photo (Nov 2026): they have the item in hand.
    if not item or item.picture_required is None or item.picture_required:
        def _has(*urls):
            return any((u or "").strip() for u in urls)
        if body.status == "allocated" and row.status != "pending_receipt" \
                and not _has(body.checkout_photo_url, row.checkout_photo_url):
            raise HTTPException(400, "A handover photo is required")
        if body.status == "allocated" and row.status == "pending_receipt" \
                and not _has(body.receipt_photo_url):
            raise HTTPException(400, "A receipt photo is required")
        if body.status == "returned" and not _has(body.return_photo_url):
            lost = (body.condition or "ok").lower().strip() == "lost"
            on_behalf = items_mgr and not is_requester and _has(body.condition_note)
            if not lost and not on_behalf:
                raise HTTPException(400, "A return photo is required (unless the item is lost)")

    if body.status in ("approved", "rejected"):
        row.resolved_at = now
        row.resolved_by = actor_name
        if body.status == "approved":
            row.assigned_allocator_email = (body.assigned_allocator_email or "").lower().strip()
            row.assigned_allocator_name  = (body.assigned_allocator_name  or "").strip()
        else:
            row.reject_reason = body.reject_reason or ""

    elif body.status == "cancelled":
        row.resolved_at = now
        # P1-7: record WHO cancelled - the acting user, from the session.
        row.resolved_by = actor_name

    elif body.status == "pending_receipt":
        # Supervisor confirmed physical handover; employee will upload receipt photo
        row.handed_over_at    = now
        row.handover_photo_by = "employee"
        row.handover_batch    = bool(body.handover_batch)
        if body.checkout_photo_url:
            row.checkout_photo_url  = body.checkout_photo_url
            row.checkout_photo_name = body.checkout_photo_name or ""
        row.allocated_by = actor_name

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
        # The allocator who handed it over stays on record when the requester
        # confirms receipt; a direct handover records whoever handed it over.
        row.allocated_by = (row.allocated_by or actor_name) if coming_from_pending_receipt else actor_name
        if item:
            item.status = "checked_out"

    elif body.status == "returned":
        # P1-13: explicit condition enum (ok|damaged|lost) instead of sniffing the
        # free-text note for damage keywords. Only damaged/lost change op_status; the
        # note stays free-text. Defaults to "ok" so pre-enum callers keep working.
        condition = (body.condition or "ok").lower().strip()
        if condition not in _RETURN_CONDITIONS:
            condition = "ok"
        row.returned_at      = now
        row.return_photo_name = body.return_photo_name or ""
        row.return_photo_url  = body.return_photo_url  or ""
        row.condition_note   = body.condition_note    or ""
        if item:
            # Lifecycle status returns to available (derived from the checkout ending);
            # a damaged/lost declaration is recorded on the SEPARATE op_status field.
            item.status = "available"
            if condition == "lost":
                item.op_status = "lost"
                item.op_status_person_email = (row.requested_by_email or "").lower()
                item.op_status_person_name  = row.requested_by or ""
                _notify_op_status_declaration(
                    db, op_status="lost",
                    person_email=item.op_status_person_email,
                    person_name=item.op_status_person_name, item_name=item.name)
            elif condition == "damaged":
                item.op_status = "in_repair"
        # A pending extension is moot once the item is back - clear it and
        # action the managers' extension notification so it leaves their bell.
        if row.extension_status == "pending":
            row.extension_days   = 0
            row.extension_reason = ""
            row.extension_status = ""
            for stale_ext in _bells(db, "extension_pending", checkout_id):
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
                ref_ids = []  # don't action yet - order not fully resolved
        for ref in ref_ids:
            # Every named copy (approver, or each items manager) clears together.
            for pending_notif in _bells(db, "checkout_pending", ref):
                pending_notif.actioned = True

    if body.status in ("approved", "rejected"):
        if row.order_id:
            # Tally all siblings' current status (not yet committed - exclude current item)
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
                        parts.append(f"Approved: **{', '.join(approved_names)}**")
                    if rejected_names:
                        parts.append(f"Not approved: **{', '.join(rejected_names)}**")
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
                notif_title = f"Request partially processed - {len(approved_names) + len(rejected_names)} of {total} items"
                parts = []
                if approved_names:
                    parts.append(f"Approved: **{', '.join(approved_names)}**")
                if rejected_names:
                    parts.append(f"Not approved: **{', '.join(rejected_names)}**")
                parts.append(f"Still pending: **{', '.join(still_pending)}**")
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

            # Allocator notification - one updating notification per order, listing
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
            # Solo item (no order) - one notification per action
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
            # no notification at all - the missed-notification bug from the
            # Jun 10 demo. Same update-in-place pattern as approvals/returns;
            # the FOR UPDATE lock at the top of this endpoint makes it race-safe.
            handed = db.query(ItemCheckout).filter(
                ItemCheckout.order_id == row.order_id,
                ItemCheckout.id != checkout_id,
                ItemCheckout.status == "pending_receipt",
            ).count() + 1  # +1 for current row (autoflush off - not yet visible)
            notif_title = f"Confirm receipt: {handed} item{'s' if handed != 1 else ''}"
            notif_body = (f"{row.item_name} has been handed over. Please confirm receipt and upload a photo." if handed == 1
                          else f"{handed} items from your request have been handed over. Please confirm receipt and upload a photo for each.")
            # Only the "Confirm receipt" bell - the order's "Request confirmed"
            # bell carries the same type and ref.
            existing = next(iter(_bells(db, "allocated", row.order_id, row.requested_by_email,
                                        title_prefix="Confirm receipt")), None)
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
        # For order batches: only notify once, when ALL items in the order are
        # allocated. A sibling that was rejected or cancelled is settled too -
        # leaving "rejected" out meant an order with one rejected item never
        # got its "Request confirmed" (Nov 2026).
        if row.order_id:
            sibling_not_allocated = db.query(ItemCheckout).filter(
                ItemCheckout.order_id == row.order_id,
                ItemCheckout.id != checkout_id,
                ItemCheckout.status.notin_(["allocated", "returned", "cancelled", "rejected"]),
            ).count()
            if sibling_not_allocated == 0:
                # All items now allocated - send one consolidated notification
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
        # Only notify the allocator - skip if unset to avoid broadcasting to all users
        if row.assigned_allocator_email:
            if row.order_id:
                # One updating notification per order: tally as items come back
                siblings = db.query(ItemCheckout).filter(
                    ItemCheckout.order_id == row.order_id,
                    ItemCheckout.id != checkout_id,
                ).all()
                returned_names = [s.item_name for s in siblings if s.status == "returned"] + [row.item_name]
                still_out      = [s.item_name for s in siblings if s.status in ("approved", "pending_receipt", "allocated")]

                # Neil's format: bold name, then each list on its own line with
                # bold item names (bell renders **bold** markers)
                if still_out:
                    total = len(returned_names) + len(still_out)
                    notif_title = f"Returns in progress: {len(returned_names)} of {total} items back"
                    notif_body  = (f"**{row.requested_by}**\n"
                                   f"Returned: **{', '.join(returned_names)}**\n"
                                   f"Still out: **{', '.join(still_out)}**")
                else:
                    notif_title = f"Request returned: {len(returned_names)} item{'s' if len(returned_names) != 1 else ''}"
                    notif_body  = (f"**{row.requested_by}** returned all {len(returned_names)} items:\n"
                                   f"**{', '.join(returned_names)}**"
                                   + (f"\nCondition: {row.condition_note}" if row.condition_note else ""))

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
    elif body.status == "cancelled":
        # P1-7: when a MANAGER cancels someone else's request, tell the requester who
        # did it - a targeted "cancelled by {manager}" note, NOT a rejection. A plain
        # self-cancel needs no notification.
        if row.requested_by_email and row.requested_by_email.lower() != user["email"].lower():
            actor = _title_case_email(user["email"])
            _notify(db, type="cancelled", recipient=row.requested_by_email,
                    title=f"Checkout cancelled: {row.item_name}",
                    body=f"Your request for {row.item_name} was cancelled by {actor}.",
                    ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by)

    _settle_handover_bells(db, row, prev_status)
    db.commit()
    _fire_item_event(checkout_id, row.status, row.requested_by_email or "")
    import item_due
    _tag_item(response, row.item_id)
    return _checkout_to_dict(row, item_due.Zones(db))


# ── Extension requests ────────────────────────────────────────────────────────

class ExtensionRequest(BaseModel):
    days:   Optional[int] = 1
    reason: Optional[str] = ""
    # The new return date picked on the calendar (Neil, 11/02/2026); when
    # given it sets the extra days (the new date minus the current due date).
    new_due_date: Optional[str] = ""


class ExtensionResolve(BaseModel):
    action: str                      # 'approve' | 'reject'
    note:   Optional[str] = ""


@router.post("/checkouts/{checkout_id}/extension")
def request_extension(checkout_id: str, body: ExtensionRequest, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    """Employee asks for more days on an item they currently hold."""
    # P1-2: lock the checkout row so two concurrent extension requests can't both pass
    # the "already pending" check below - otherwise they double-create the pending
    # extension and fire a duplicate broadcast to managers.
    row = db.query(ItemCheckout).filter(ItemCheckout.id == checkout_id).with_for_update().first()
    if not row:
        raise HTTPException(404, "Checkout not found")
    _wall_checkout(row, user, db)
    if row.status != "allocated":
        raise HTTPException(400, "Extensions can only be requested for items in use")
    if (row.requested_by_email or "").lower() != user["email"].lower() and not _is_items_manager(user, db):
        raise HTTPException(403, "Only the person holding the item can request an extension")
    if row.extension_status == "pending":
        raise HTTPException(400, "An extension request is already awaiting approval")
    if not (body.reason or "").strip():
        raise HTTPException(400, "A reason is required to request an extension")
    import item_due
    if (body.new_due_date or "").strip():
        try:
            new_due = date.fromisoformat(body.new_due_date.strip()[:10])
        except ValueError:
            raise HTTPException(400, "The new return date must be a date (YYYY-MM-DD)")
        current = item_due.due_date(row, item_due.zone_for(db, row.requested_by_email))
        if current is None:
            raise HTTPException(400, "This checkout has no due date yet")
        days = (new_due - current).days
        if days < 1:
            raise HTTPException(400, f"Pick a date after the current due date ({current.strftime('%m/%d/%Y')})")
    else:
        days = max(1, int(body.days or 1))
    # An extension is the manager-approved exception to the type's longest
    # loan, so it is held only to the 90-day ceiling for the whole loan.
    if (row.days or 0) + days > _LOAN_CEILING_DAYS:
        raise HTTPException(400, f"A checkout can run for at most {_LOAN_CEILING_DAYS} days in all")

    row.extension_days   = days
    row.extension_reason = (body.reason or "").strip()
    row.extension_status = "pending"

    # Neil: title leads with the ITEM and the days - the requester is already
    # shown on the card. Reason goes on its own line (bell renders pre-line).
    # Sent to NAMED people (Nov 2026): the manager who approved the checkout,
    # else the items managers of the item's company - it was a '' broadcast
    # stamped with no company, invisible to every walled manager.
    item = db.query(Item.company_id).filter(Item.id == row.item_id).first()
    company = (item[0] if item else "") or ""
    approver = (row.approver_email or "").lower().strip()
    to = [approver] if approver and approver != (row.requested_by_email or "").lower() else \
        _items_managers_for(db, company, exclude=[row.requested_by_email])
    _notify_team(db, type="extension_pending", recipients=to,
                 title=f"Extension Request - {row.item_name} (+{days} day{'s' if days != 1 else ''})",
                 body=f"{row.requested_by} requested {days} more day{'s' if days != 1 else ''} for {row.item_name}."
                      + (f"\nReason: {row.extension_reason}" if row.extension_reason else ""),
                 ref_id=checkout_id, item_name=row.item_name, requested_by=row.requested_by,
                 about_email=row.requested_by_email or "", company=company)

    db.commit()
    _fire_item_event(checkout_id, row.status, row.requested_by_email or "")
    _tag_item(response, row.item_id)
    return _checkout_to_dict(row, item_due.Zones(db))


@router.post("/checkouts/{checkout_id}/extension/resolve")
def resolve_extension(checkout_id: str, body: ExtensionResolve, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    """Manager approves or rejects a pending extension request."""
    if not _is_items_manager(user, db):
        raise HTTPException(403, "Manager or above required to resolve extensions")
    # Row lock: two managers resolving the same extension concurrently must not
    # both pass the pending check (approve twice = days added twice).
    row = db.query(ItemCheckout).filter(ItemCheckout.id == checkout_id).with_for_update().first()
    if not row:
        raise HTTPException(404, "Checkout not found")
    _wall_item_id(row.item_id, user, db)   # the manager decides only for their companies
    if row.extension_status != "pending":
        raise HTTPException(400, "No pending extension request on this checkout")

    action = (body.action or "").lower().strip()
    if action not in ("approve", "reject"):
        raise HTTPException(400, "action must be 'approve' or 'reject'")

    ext_days = row.extension_days or 0
    if action == "approve":
        import item_due
        if (row.requested_due_date or "").strip():
            # The picked date moves with the extension (item_due's rule reads it
            # when the handover came on the day of the request).
            current = item_due.due_date(row, item_due.zone_for(db, row.requested_by_email))
            if current is not None:
                row.requested_due_date = (current + timedelta(days=ext_days)).isoformat()
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

    # Clear the managers' extension_pending notification (every named copy)
    for pending_notif in _bells(db, "extension_pending", checkout_id):
        pending_notif.actioned = True

    db.commit()
    _fire_item_event(checkout_id, row.status, row.requested_by_email or "")
    import item_due
    _tag_item(response, row.item_id)
    return _checkout_to_dict(row, item_due.Zones(db))


# ── Reconcile lifecycle state ─────────────────────────────────────────────────

class ReconcileStateIn(BaseModel):
    # Optionally cancel a stuck pending_receipt checkout (allocator handed over, the
    # employee never confirmed receipt) as part of the same admin action. P1-3.
    cancel_checkout_id: Optional[str] = ""


@router.post("/{item_id}/reconcile-state")
def reconcile_item_state(item_id: str, body: ReconcileStateIn,
                         user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """P1-3: re-derive an item's lifecycle status from its LIVE checkouts/assignments,
    replacing the old raw `status` write (which could strand an item). Optionally
    rescues a stuck `pending_receipt` checkout by cancelling it (the only exit that
    state previously lacked). Manager-guarded (require_items_admin)."""
    item = db.query(Item).filter(Item.id == item_id).with_for_update().first()
    if not item or item.deleted_at:
        raise HTTPException(404, "Item not found")
    _wall_item(item, user, db)

    cancelled_id = ""
    if (body.cancel_checkout_id or "").strip():
        co = db.query(ItemCheckout).filter(
            ItemCheckout.id == body.cancel_checkout_id.strip(),
            ItemCheckout.item_id == item_id,
        ).with_for_update().first()
        if not co:
            raise HTTPException(404, "Checkout not found on this item")
        if co.status != "pending_receipt":
            raise HTTPException(409, "Only a stuck pending_receipt checkout can be cancelled here")
        co.status      = "cancelled"
        co.resolved_at = _now_iso()
        co.resolved_by = _display_name(db, user["email"])
        cancelled_id   = co.id
        _settle_handover_bells(db, co, "pending_receipt")   # the "Confirm receipt" bell goes
        # Tell the requester their unconfirmed handover was cancelled by a manager.
        if co.requested_by_email:
            _notify(db, type="cancelled", recipient=co.requested_by_email,
                    title=f"Checkout cancelled: {co.item_name}",
                    body=f"Your unconfirmed handover of {co.item_name} was cancelled by "
                         f"{_title_case_email(user['email'])} to free the item.",
                    ref_id=co.id, item_name=co.item_name, requested_by=co.requested_by)

    # Derive from live rows. autoflush is off, so a row cancelled just above is still
    # matched by a status filter in SQL - load by item and judge status in Python so
    # the just-cancelled row is correctly seen as no longer live.
    assignments = db.query(ItemAssignment).filter(ItemAssignment.item_id == item_id).all()
    checkouts   = db.query(ItemCheckout).filter(ItemCheckout.item_id == item_id).all()
    live_active_assign = any(a.status == "active" for a in assignments)
    live_allocated_co  = any(c.status == "allocated" for c in checkouts)

    if live_active_assign:
        new_status = "permanently_assigned"
    elif live_allocated_co:
        new_status = "checked_out"
    elif item.status == "retired":
        new_status = "retired"   # a terminal retire stands unless something live overrides it
    else:
        new_status = "available"

    old_status  = item.status
    item.status = new_status
    db.commit()
    return {"ok": True, "item": _item_to_dict(item),
            "previousStatus": old_status, "status": new_status,
            "cancelledCheckoutId": cancelled_id}


# ── AI photo fill ─────────────────────────────────────────────────────────────
# Claude (with web search) finds the manufacturer's product image for items
# missing a photo; we download it into our own Supabase bucket so the catalog
# never hot-links external URLs. These are stock photos - managers can replace
# them with real unit photos via Assign Photos at any time.

_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_GOOGLE_CSE_KEY    = os.getenv("GOOGLE_CSE_KEY", "")   # Google Custom Search JSON API key
_GOOGLE_CSE_CX     = os.getenv("GOOGLE_CSE_CX", "")    # Programmable Search Engine id (image search on)
_IMG_CTYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


def _google_image_candidates(query: str, errors: Optional[list] = None) -> list:
    """Direct product-image URLs via the official Google image search API -
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
    """Keyless CC-image fallback - usually a photo of a similar model rather
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
    """Ask Claude (web search enabled) for candidate product pages - we then try
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
                "Give me up to 3 product page URLs that clearly show this product - prefer retailer "
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
                # Tier-1 API keys have tight per-minute limits - wait and retry,
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


# Image URLs that are obviously NOT product photos (site chrome) - reject them
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
    # The URL came from a model (or from a page it pointed at), so it goes
    # through safe_fetch: public hosts only, checked on every redirect and on
    # the og:image hop below, strict TLS, size-capped while downloading. This
    # used to run with verify=False because some retail/manufacturer sites
    # serve an incomplete cert chain (browsers AIA-fetch the intermediates,
    # Python doesn't); those sites now simply fail and the next candidate is
    # tried - an unverified connection is not worth one more stock photo.
    try:
        resp = safe_fetch.fetch(img_url, max_bytes=8 * 1024 * 1024, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "text/html,image/avif,image/webp,image/*,*/*;q=0.8",
        })
        if resp.status_code in (403, 429):
            # Wikimedia (and friends) block fake browser UAs from datacenter
            # IPs but serve honest, descriptive bot UAs per their policy
            resp = safe_fetch.fetch(img_url, max_bytes=8 * 1024 * 1024, headers={
                "User-Agent": "GreensNexusCatalogBot/1.0 (+https://nexus.greensglobal.com; internal asset catalog)",
                "Accept": "image/*,text/html;q=0.5",
            })
    except (httpx.HTTPError, safe_fetch.FetchRefused):
        return ""  # slow/dead/refused host - fail fast, the caller tries the next candidate
    if resp.status_code != 200:
        return ""
    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype.startswith("text/html"):
        # Got a product page instead of an image - collect candidate images in
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
    with httpx.Client(timeout=30) as upload_client:
        up = upload_client.post(
            f"{_SUPABASE_URL}/storage/v1/object/item-photos/{path}",
            headers={
                "Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}",
                "apikey": _SUPABASE_SERVICE_KEY,
                "Content-Type": ctype,
                "x-upsert": "true",
                "cache-control": "max-age=31536000",  # unique paths - browsers cache immutably
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
    # The image searches (Google when configured, else the keyless Openverse)
    # need no AI, so AI being off is no reason to refuse (Nov 2026 - this used
    # to 503 without an Anthropic key). Claude's web search is used only when
    # the AI switch is on AND a key is set (ai_switch - Neil, Oct 29 2026),
    # and only when no Google key exists at all.
    import ai_switch
    ai_ok = bool(_ANTHROPIC_API_KEY) and ai_switch.enabled()
    if not _SUPABASE_URL or not _SUPABASE_SERVICE_KEY:
        raise HTTPException(503, "Supabase storage is not configured on the backend")

    results = []
    scope = _scope(user, db)
    for item_id in body.item_ids[:5]:  # cap per call - the client batches
        item = db.query(Item).filter(Item.id == item_id).first()
        if not item or not _item_ok(item, scope):
            results.append({"item_id": item_id, "status": "not_found"})
            continue
        if item.photo_url and not body.replace:
            results.append({"item_id": item_id, "status": "already_has_photo"})
            continue
        try:
            desc = " ".join(x for x in [item.make, item.model, item.name] if x).strip() or item.name
            # SPEED CONTRACT: with Google configured the pipeline is Google →
            # Openverse, both ~1-2s calls - an item succeeds or fails FAST.
            # Claude web search (rate-limit sleeps, up to a minute per item) is
            # only ever used when no Google key exists at all.
            # Query relaxation: "Make Model Name" can be too specific for the
            # site-restricted index - fall back to the bare item name.
            src_errors = []
            sources = _google_image_candidates(desc, src_errors)
            if not sources and desc != item.name:
                sources = _google_image_candidates(item.name, src_errors)
            if not sources:
                sources = _openverse_image_candidates(desc)
            if not sources and desc != item.name:
                sources = _openverse_image_candidates(item.name)
            if not sources and not _GOOGLE_CSE_KEY and ai_ok:
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
    # Manager option: activate immediately instead of waiting for the assignee
    # to accept. Permanent assignments only (this model is only used there).
    skip_acceptance: Optional[bool] = False


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
    """Action a workflow's bell - every named copy of it (one per items
    manager since Nov 2026), not just the first row found."""
    for n in _bells(db, ntype, ref_id):
        n.actioned = True


def _activate_assignment_direct(a: "ItemAssignment", item: "Item", now: str):
    """Manager skipped acceptance: flip the assignment straight to active and
    stamp the item pointers exactly the way accept_assignment does."""
    a.status = "active"
    a.accepted_at = now
    a.accept_note = "Assigned directly by manager - acceptance skipped"
    if item:
        item.status = "permanently_assigned"
        item.ownership_type = "permanent"
        item.assigned_to_email, item.assigned_to_name, item.assigned_at = a.assignee_email, a.assignee_name, now
        item.assigned_to_location = ""  # a person now holds it - drop any prior location assignment


def _clear_batch_assign_notif(db: Session, assignee_email: str):
    """P1-4: retire a lingering bulk-assign summary bell for this assignee. The batch
    "N items assigned to you" perm_assign carries the first assignment's id as ref_id;
    _action_notif only clears the single-assign notif that matches the exact assignment
    just handled, so the summary would otherwise stick around until (if ever) the FIRST
    listed item is acted on. Its title starts with the item count (a digit), whereas
    single-assign / reassign notifs start with text ("Item assigned…", "Please return…"),
    so we can safely clear the summary once the assignee acts on ANY item in the batch."""
    email = (assignee_email or "").lower()
    for n in db.query(NexusNotification).filter(
        NexusNotification.type == "perm_assign",
        NexusNotification.recipient == email,
        NexusNotification.actioned == False,
    ).all():
        if n.title[:1].isdigit():
            n.actioned = True


@router.get("/assignments")
def list_assignments(history_limit: int = 1000, user: dict = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    """Every LIVE assignment (awaiting acceptance, active, being returned -
    never capped: a cap used to drop live rows once the table passed 1,000)
    plus the most recent finished ones up to `history_limit` (at most 5,000).
    Managers see their companies' items (the wall) and their own; everyone
    else their own. Newest first."""
    me = _me(user)
    mine = func.lower(ItemAssignment.assignee_email) == me
    base = db.query(ItemAssignment)
    if not _is_items_manager(user, db):
        base = base.filter(mine)
    else:
        allowed = visible_item_ids(db, user)
        if allowed is not None:
            base = base.filter(or_(ItemAssignment.item_id.in_(list(allowed)), mine) if allowed else mine)
    cap = max(0, min(int(history_limit or 0), 5000))
    live = base.filter(ItemAssignment.status.in_(_LIVE_ASSIGN)).order_by(ItemAssignment.created_at.desc()).all()
    done = (base.filter(ItemAssignment.status.notin_(_LIVE_ASSIGN))
            .order_by(ItemAssignment.created_at.desc()).limit(cap).all()) if cap else []
    rows = sorted(live + done, key=lambda a: a.created_at or "", reverse=True)
    return [_assignment_to_dict(a) for a in rows]


@router.post("/{item_id}/assign", status_code=201)
def assign_item(item_id: str, body: AssignmentCreate, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    # P1-1: lock the item row so two concurrent assigns can't both pass the
    # live-assignment / active-checkout checks below and double-assign the same unit.
    item = db.query(Item).filter(Item.id == item_id).with_for_update().first()
    if not item or item.deleted_at:
        raise HTTPException(404, "Item not found")
    _wall_item(item, user, db)
    _refuse_lost(item)
    _require_person(db, body.assignee_email, user, "person to assign it to")
    if item.ownership_type != "permanent":
        # Accepting an assignment force-flips ownership to permanent - a silent
        # one-way change that pulls the item out of the checkout catalogue.
        # Require the explicit ownership edit first instead.
        raise HTTPException(400, f'"{item.name}" is a temporary item - it gets checked out, not permanently assigned. '
                                 "Change its ownership to Permanent first if it should live with one person.")
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
        assigned_by=_title_case_email(user["email"]), assigned_by_email=user["email"],
        status="pending_acceptance", created_at=_now_iso(),
    )
    db.add(a)
    if body.skip_acceptance:
        _activate_assignment_direct(a, item, _now_iso())
        _notify(db, type="perm_assign", recipient=a.assignee_email,
                title=f"Item assigned to you: {item.name}",
                body=f"{a.assigned_by or 'A manager'} assigned {item.name} to you permanently. It's already active in My Items - nothing to accept.",
                ref_id=a.id, item_name=item.name, requested_by=a.assignee_name)
    else:
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
    item = db.query(Item).filter(Item.id == item_id).with_for_update().first()
    if not item or item.deleted_at:
        raise HTTPException(404, "Item not found")
    _wall_item(item, user, db)
    _refuse_lost(item)
    _require_person(db, body.assignee_email, user, "person to reassign it to")
    cur = db.query(ItemAssignment).filter(
        ItemAssignment.item_id == item_id, ItemAssignment.status == "active").with_for_update().first()
    if not cur:
        raise HTTPException(409, "No active assignment on this item - use assign")
    # Reassigning to the same person it's already with is a no-op that would
    # pointlessly bounce the item through a return - reject it (Neil).
    if body.assignee_email.lower().strip() == (cur.assignee_email or "").lower().strip():
        raise HTTPException(409, f"{item.name} is already assigned to {cur.assignee_name or cur.assignee_email}.")
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


class AssignLocationIn(BaseModel):
    location: str = ""


@router.post("/{item_id}/assign-location")
def assign_item_to_location(item_id: str, body: AssignLocationIn, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """Set WHERE an item lives. Location is just physical placement now (Visesh):
    it's independent of who holds it, so this never touches the person assignment or
    the lifecycle - an item can be at GG Corp AND assigned to a person. Empty clears
    the location. (Kept the legacy assigned_to_location in sync for older views.)"""
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item or item.deleted_at:
        raise HTTPException(404, "Item not found")
    _wall_item(item, user, db)
    loc = (body.location or "").strip()
    item.location = loc
    item.assigned_to_location = ""  # retire the legacy "assigned to a place" flag
    db.commit()
    return _item_to_dict(item)


def _bulk_assign_blocked(db: Session, ids: list[str]) -> set:
    """Ids that can't be (re)assigned because a live person-assignment or an active
    checkout is in flight - recover those first."""
    blocked = set()
    for a in db.query(ItemAssignment).filter(
            ItemAssignment.item_id.in_(ids), ItemAssignment.status.in_(_LIVE_ASSIGN)).all():
        blocked.add(a.item_id)
    for c in db.query(ItemCheckout).filter(
            ItemCheckout.item_id.in_(ids),
            ItemCheckout.status.in_(["pending", "approved", "pending_receipt", "allocated"])).all():
        blocked.add(c.item_id)
    return blocked


class BulkAssignLocationIn(BaseModel):
    ids:      list[str]
    location: str = ""


@router.post("/bulk-assign-location")
def bulk_assign_to_location(body: BulkAssignLocationIn, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """Set WHERE many items live at once. Location is physical placement only
    (Visesh) - independent of who holds them - so this just sets `location` and never
    touches the person assignment or lifecycle. Empty clears it."""
    ids = [i for i in (body.ids or []) if i]
    loc = (body.location or "").strip()
    if not ids:
        return {"assigned": 0, "skipped": []}
    assigned = 0
    scope = _scope(user, db)
    for it in db.query(Item).filter(Item.id.in_(ids), or_(Item.deleted_at.is_(None), Item.deleted_at == "")).all():
        if not _item_ok(it, scope):
            continue                      # another company's item: untouched
        it.location = loc
        it.assigned_to_location = ""
        assigned += 1
    db.commit()
    return {"assigned": assigned, "skipped": []}


class BulkAssignPersonIn(BaseModel):
    ids:            list[str]
    assignee_email: str
    assignee_name:  str = ""
    skip_acceptance: bool = False


@router.post("/bulk-assign")
def bulk_assign_to_person(body: BulkAssignPersonIn, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """Assign many items to a PERSON at once. Each item gets its own pending
    acceptance assignment (the assignee accepts with a photo from My Items); the
    assignee is notified once with the total, not per item (batch-notification rule)."""
    ids = [i for i in (body.ids or []) if i]
    email = (body.assignee_email or "").lower().strip()
    name  = (body.assignee_name or "").strip()
    if not ids or not email:
        return {"assigned": 0, "skipped": []}
    _require_person(db, email, user, "person to assign them to")
    # P1-1: lock the item rows FIRST (in id order), then scan for live claims:
    # create_checkout and assign_item lock the item row too, so nothing can
    # slip a claim in after the scan. Scanning before the locks (as before
    # Nov 2026) left exactly that window open.
    scope = _scope(user, db)
    locked = [it for it in db.query(Item).filter(
        Item.id.in_(ids), or_(Item.deleted_at.is_(None), Item.deleted_at == ""))
        .order_by(Item.id).with_for_update().all() if _item_ok(it, scope)]
    blocked = _bulk_assign_blocked(db, [it.id for it in locked]) if locked else set()
    assigned, names = 0, []
    first_asg_id = ""
    for it in locked:
        if it.ownership_type != "permanent" or (it.op_status or "") == "lost":
            blocked.add(it.id)   # temporary items are checked out, never person-assigned; lost ones wait to be found
            continue
        if it.id in blocked:
            continue
        asg_id = f"ASG-{uuid.uuid4().hex[:10].upper()}"
        if not first_asg_id:
            first_asg_id = asg_id
        asg = ItemAssignment(
            id=asg_id, item_id=it.id, item_name=it.name,
            assignee_email=email, assignee_name=name,
            assigned_by=_title_case_email(user["email"]), assigned_by_email=user["email"],
            status="pending_acceptance", created_at=_now_iso(),
        )
        db.add(asg)
        if body.skip_acceptance:
            _activate_assignment_direct(asg, it, _now_iso())
        assigned += 1
        names.append(it.name)
    if assigned:
        preview = ", ".join(names[:5]) + ("…" if len(names) > 5 else "")
        # P1-4: give the batch bell a stable ref_id (the first assignment id) so it can
        # be deep-linked AND auto-cleared - with ref_id="" it could never be actioned
        # and lingered forever. Accepting/declining ANY item from the batch clears it
        # (see _clear_batch_assign_notif in accept/decline).
        tail = ("They're already active in My Items - nothing to accept."
                if body.skip_acceptance else "Accept each with a photo in My Items.")
        _notify(db, type="perm_assign", recipient=email,
                title=f"{assigned} item{'s' if assigned != 1 else ''} assigned to you",
                body=f"{_title_case_email(user['email'])} assigned you {assigned} item{'s' if assigned != 1 else ''}: {preview}. {tail}",
                ref_id=first_asg_id, item_name=names[0] if names else "", requested_by=name)
    db.commit()
    return {"assigned": assigned, "skipped": sorted(blocked & set(ids))}


@router.post("/assignments/{assignment_id}/accept")
def accept_assignment(assignment_id: str, body: AssignmentAccept, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    _validate_photo_url(body.photo_url, "photo_url")
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if (a.assignee_email or "").lower() != _me(user):
        raise HTTPException(403, "Only the assignee can accept this assignment")
    if a.status != "pending_acceptance":
        raise HTTPException(409, "Assignment is not awaiting acceptance")
    # Photo is OPTIONAL on permanent-assignment acceptance (Neil, Jul 17) -
    # checkout handover/receipt/return photos remain mandatory elsewhere.
    a.status = "active"
    a.accept_photo_url, a.accept_photo_name = body.photo_url or "", body.photo_name or ""
    a.accept_note, a.accepted_at = (body.note or "").strip(), _now_iso()
    item = db.query(Item).filter(Item.id == a.item_id).first()
    if item:
        item.status = "permanently_assigned"
        item.ownership_type = "permanent"
        item.assigned_to_email, item.assigned_to_name, item.assigned_at = a.assignee_email, a.assignee_name, a.accepted_at
        item.assigned_to_location = ""  # a person now holds it - drop any prior location assignment
    note_part = f' Condition note: "{a.accept_note}"' if a.accept_note else ""
    _notify(db, type="perm_update", recipient=a.assigned_by_email,
            title=f"Assignment accepted: {a.item_name}",
            body=f"{a.assignee_name or a.assignee_email} accepted {a.item_name}.{note_part}",
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    _action_notif(db, "perm_assign", a.id)
    _clear_batch_assign_notif(db, a.assignee_email)   # P1-4: clear the bulk-assign summary
    db.commit()
    _tag_item(response, a.item_id)
    return _assignment_to_dict(a)


@router.post("/assignments/{assignment_id}/decline")
def decline_assignment(assignment_id: str, body: AssignmentReturnInit, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    if (a.assignee_email or "").lower() != _me(user):
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
    _clear_batch_assign_notif(db, a.assignee_email)   # P1-4: clear the bulk-assign summary
    db.commit()
    _tag_item(response, a.item_id)
    return _assignment_to_dict(a)


def _return_recipients(db: Session, a: "ItemAssignment") -> tuple:
    """(named recipients, item company) for a return to accept: the items
    managers of the item's company plus the manager who assigned it - never
    the holder. Before Nov 2026 this was a '' broadcast stamped with no
    company (invisible to every walled manager)."""
    found = db.query(Item.company_id).filter(Item.id == a.item_id).first()
    company = (found[0] if found else "") or ""
    holder = (a.assignee_email or "").lower()
    to = _items_managers_for(db, company, exclude=[holder])
    by = (a.assigned_by_email or "").lower()
    if by and by != holder and _nexus_person(db, by) is not None:
        to = sorted(set(to) | {by})
    return to, company


def _drop_reassign_chain(db: Session, a: "ItemAssignment", why_manager: str, why_person: str) -> None:
    """A reassignment that will not go ahead: tell the manager who started it
    (else the items managers of the item's company) and the person who was
    promised the item, then clear next_assignee_* so nothing dangles (P1-6)."""
    if not a.next_assignee_email:
        return
    dropped_name = a.next_assignee_name or a.next_assignee_email
    dropped_email = a.next_assignee_email
    to = [a.assigned_by_email] if a.assigned_by_email else []
    if not to:
        to, _company = _return_recipients(db, a)
    for em in to:
        _notify(db, type="perm_update", recipient=em,
                title=f"Reassignment cancelled: {a.item_name}",
                body=why_manager.format(item=a.item_name, person=dropped_name),
                ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name, about_email=a.assignee_email)
    _notify(db, type="perm_update", recipient=dropped_email,
            title=f"Reassignment cancelled: {a.item_name}",
            body=why_person.format(item=a.item_name, person=dropped_name),
            ref_id=a.id, item_name=a.item_name, requested_by=dropped_name)
    a.next_assignee_email = ""
    a.next_assignee_name = ""


@router.post("/assignments/{assignment_id}/initiate-return")
def initiate_assignment_return(assignment_id: str, body: AssignmentReturnInit, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    _validate_photo_url(body.photo_url, "photo_url")
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    _wall_assignment(a, user, db)
    if (a.assignee_email or "").lower() != _me(user) and not _is_items_manager(user, db):
        raise HTTPException(403, "Only the assignee or a manager can initiate a return")
    if a.status not in ("active", "return_initiated"):
        raise HTTPException(409, "Assignment is not active")
    reason = (body.reason or "normal").lower()
    if reason not in ("normal", "dead", "lost"):
        raise HTTPException(400, "reason must be normal, dead or lost")
    # Evidence: a return needs a photo unless the item is lost - the reassign
    # path included (Nov 2026: a manager's Reassign puts the row in
    # return_initiated with no photo, and the holder's return then went
    # through without one). A photo already on the row counts, so sending the
    # return again never needs a second one.
    new_photo = (body.photo_url or "").strip()
    if reason != "lost" and not new_photo and not (a.return_photo_url or "").strip():
        raise HTTPException(400, "A return photo is required (unless the item is lost)")
    # A reassignment return keeps its target - unless the holder reports the
    # item lost or dead, which the accept step must see (it then drops the chain).
    keep_chain = a.return_reason == "reassign" and reason == "normal"
    first_time = a.status == "active"
    a.status = "return_initiated"
    if not keep_chain:
        a.return_reason = reason
    if new_photo:                 # never wipe a photo already given
        a.return_photo_url, a.return_photo_name = new_photo, body.photo_name or ""
    if (body.note or "").strip():
        a.return_note = body.note.strip()
    if first_time or not a.return_initiated_at:
        a.return_initiated_at = _now_iso()
    flag = {"dead": "ITEM DEAD - ", "lost": "ITEM LOST - ", "reassign": "Reassignment - "}.get(a.return_reason, "")
    to, company = _return_recipients(db, a)
    # One bell per return, per person, updated in place when the holder sends
    # it again (never a second broadcast).
    _notify_team(db, type="perm_return", recipients=to,
                 title=f"{flag}Return to confirm: {a.item_name}",
                 body=f"{a.assignee_name or a.assignee_email} initiated a return of {a.item_name}"
                      + (f' - "{a.return_note}"' if a.return_note else ".")
                      + " Verify and accept it in Checkouts > Assignments.",
                 ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name,
                 about_email=a.assignee_email, company=company)
    db.commit()
    _tag_item(response, a.item_id)
    return _assignment_to_dict(a)


@router.post("/assignments/{assignment_id}/accept-return")
def accept_assignment_return(assignment_id: str, body: AssignmentReturnAccept, user: dict = Depends(get_current_user), db: Session = Depends(get_db), response: Response = None):
    if user["level"] < 2 and not _is_items_manager(user, db):
        raise HTTPException(403, "Supervisor or above required to accept returns")
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    _wall_item_id(a.item_id, user, db)   # the checker-in is never a party - always walled
    if (a.assignee_email or "").lower() == _me(user):
        # The holder never signs off their own return (Nov 2026) - someone else
        # looks at the item and the photo.
        raise HTTPException(403, "You can't accept your own return - another supervisor or items manager checks it in")
    if a.status != "return_initiated":
        raise HTTPException(409, "No return awaiting acceptance")
    if a.return_reason != "lost" and not (a.return_photo_url or "").strip():
        # The reassign path: the manager asked for it back, the holder has not
        # returned it with a photo yet. Recover takes it back without one.
        raise HTTPException(400, "The holder has not returned it with a photo yet - ask them to return it from "
                                 "My Items, or use Recover to take it back without one")
    dispo = body.disposition if body.disposition in ("stock", "retired") else "stock"
    lost = a.return_reason == "lost"
    a.status = "closed"
    a.disposition = dispo
    a.return_accepted_by, a.return_accepted_at = _display_name(db, user["email"]), _now_iso()
    item = db.query(Item).filter(Item.id == a.item_id).with_for_update().first()
    if item:
        item.assigned_to_email = item.assigned_to_name = item.assigned_at = ""
        item.status = "retired" if dispo == "retired" else "available"
        if lost:
            # M1 (Nov 2026): a lost return is recorded as LOST - before, it went
            # straight back to stock as if it were on the shelf. It stays out of
            # circulation (_refuse_lost) until an items manager marks it found.
            item.op_status = "lost"
            item.op_status_person_email = (a.assignee_email or "").lower()
            item.op_status_person_name = a.assignee_name or ""
            _notify_op_status_declaration(db, op_status="lost", person_email=item.op_status_person_email,
                                          person_name=item.op_status_person_name, item_name=item.name)
    _notify(db, type="perm_update", recipient=a.assignee_email,
            title=f"Return accepted: {a.item_name}",
            body=f"Your return of {a.item_name} was accepted by {a.return_accepted_by}. You are no longer responsible for it.",
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    _action_notif(db, "perm_return", a.id)
    # Reassignment chain: spawn the next assignment automatically - but ONLY if the
    # item actually ends up back in stock and in service. P1-6: retired, lost or
    # dead on return, the promised next assignee is told it is not coming.
    if a.next_assignee_email:
        if item and item.status == "available" and not lost and a.return_reason == "reassign":
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
        else:
            word = "lost" if lost else (a.return_reason if a.return_reason == "dead" else dispo)
            _drop_reassign_chain(
                db, a,
                "{item} was accepted back as '" + word + "', so the pending reassignment to {person} "
                "did not go ahead. Assign it again once it is back in service.",
                "{item} was going to be reassigned to you but was taken out of service on return, "
                "so it will not be coming to you. No action needed.")
    db.commit()
    _tag_item(response, a.item_id)
    return _assignment_to_dict(a)


def force_return_person(db: Session, email: str, actor_email: str) -> dict:
    """Force-return everything a departing person holds so no equipment stays out
    to a worker who has left. Called by HR offboarding - Items stays the single
    source of truth for these state transitions. Operates in the CALLER's session
    (the caller commits); no per-item notifications, as this is a bulk admin
    action - except the ones somebody else is waiting on (M8, Nov 2026).

      • Handed-over checkouts (pending_receipt / allocated) -> returned, item freed;
        a pending extension is cleared with its managers' bell.
      • Not-yet-handed checkouts (pending / approved)       -> cancelled; the
        approval and hand-over bells are actioned.
      • Live permanent assignments                          -> closed, item back to stock;
        a reassignment in flight is dropped and the person promised the item
        (and the manager who started it) is told.

    Returns {"checkouts": n, "assignments": n}."""
    email = (email or "").strip().lower()
    if not email:
        return {"checkouts": 0, "assignments": 0}
    now = _now_iso()
    actor = _display_name(db, actor_email)

    checkouts = db.query(ItemCheckout).filter(
        func.lower(ItemCheckout.requested_by_email) == email,
        ItemCheckout.status.in_(_LIVE_CHECKOUT),
    ).order_by(ItemCheckout.id).with_for_update().all()
    for c in checkouts:
        prev = c.status
        handed_over = c.status in ("pending_receipt", "allocated")
        c.status = "returned" if handed_over else "cancelled"
        if handed_over:
            c.returned_at = now
            c.condition_note = c.condition_note or f"Auto-returned on offboarding by {actor}"
            item = db.query(Item).filter(Item.id == c.item_id).first()
            if item and item.status == "checked_out":
                item.status = "available"
        else:
            c.resolved_at, c.resolved_by = now, actor
        if (c.extension_status or "") == "pending":
            c.extension_days, c.extension_reason, c.extension_status = 0, "", ""
            _action_notif(db, "extension_pending", c.id)
        if prev == "pending":
            _action_notif(db, "checkout_pending", c.id)
            if c.order_id:
                _action_notif(db, "checkout_pending", c.order_id)
        _settle_handover_bells(db, c, prev)

    assignments = db.query(ItemAssignment).filter(
        func.lower(ItemAssignment.assignee_email) == email,
        ItemAssignment.status.in_(_LIVE_ASSIGN),
    ).order_by(ItemAssignment.id).with_for_update().all()
    for a in assignments:
        a.status = "closed"
        a.disposition = "stock"
        a.return_accepted_by, a.return_accepted_at = actor, now
        item = db.query(Item).filter(Item.id == a.item_id).first()
        if item:
            item.assigned_to_email = item.assigned_to_name = item.assigned_at = ""
            item.status = "available"
        _drop_reassign_chain(
            db, a,
            "{item} was taken back when its holder was offboarded, so the pending reassignment to "
            "{person} did not go ahead. Assign it again if needed.",
            "{item} was going to be reassigned to you, but its holder left and it was taken back "
            "into stock, so it will not be coming to you automatically. No action needed.")
        _action_notif(db, "perm_assign", a.id)
        _action_notif(db, "perm_return", a.id)

    return {"checkouts": len(checkouts), "assignments": len(assignments)}


@router.post("/assignments/{assignment_id}/cancel")
def cancel_assignment(assignment_id: str, user: dict = Depends(require_items_admin), db: Session = Depends(get_db), response: Response = None):
    """Manager cancel / force-recover. Pending -> cancelled; active/returning -> closed, item back to stock."""
    a = db.query(ItemAssignment).filter(ItemAssignment.id == assignment_id).with_for_update().first()
    if not a:
        raise HTTPException(404, "Assignment not found")
    _wall_item_id(a.item_id, user, db)
    if a.status not in _LIVE_ASSIGN:
        raise HTTPException(409, "Assignment is already closed")
    was_pending = a.status == "pending_acceptance"
    a.status = "cancelled" if was_pending else "closed"
    a.disposition = "" if was_pending else "stock"
    a.return_accepted_by, a.return_accepted_at = _display_name(db, user["email"]), _now_iso()
    item = db.query(Item).filter(Item.id == a.item_id).first()
    if item and not was_pending:
        item.assigned_to_email = item.assigned_to_name = item.assigned_at = ""
        item.status = "available"
    _notify(db, type="perm_update", recipient=a.assignee_email,
            title=f"Assignment {'cancelled' if was_pending else 'closed'}: {a.item_name}",
            body=f"{a.return_accepted_by} {'cancelled the pending assignment of' if was_pending else 'force-recovered'} {a.item_name}."
                 + ("" if was_pending else " You are no longer responsible for it."),
            ref_id=a.id, item_name=a.item_name, requested_by=a.assignee_name)
    # P1-6: if this was a reassign-in-flight, a next assignee was promised the item.
    # Force-recover closes the assignment without spawning that next assignment.
    _drop_reassign_chain(
        db, a,
        "{item} was force-recovered, so the pending reassignment to {person} did not go ahead. "
        "Assign it again if needed.",
        "{item} was going to be reassigned to you but was recovered by a manager, "
        "so it will not be coming to you. No action needed.")
    _action_notif(db, "perm_assign", a.id)
    _action_notif(db, "perm_return", a.id)
    db.commit()
    _tag_item(response, a.item_id)
    return _assignment_to_dict(a)


# ── Allocators / Approvers ────────────────────────────────────────────────────

def _nexus_people_only(db: Session, rows):
    """Restrict role-holder rows to people on the curated Nexus People list
    (nexus_employees) and use their People name. Role grants can exist for any
    M365 account; pickers must only ever offer real Nexus people (Neil, Jul 17)."""
    people = {
        (e.work_email or "").lower(): f"{e.first_name} {e.last_name}".strip()
        for e in db.query(NexusEmployee)
                   .filter(NexusEmployee.status != "offboarded")
                   .filter(NexusEmployee.work_email != "").all()
    }
    out = []
    for r in rows:
        name = people.get((r.email or "").lower())
        if name is None:
            continue
        out.append({"email": r.email, "name": name or r.display_name or _title_case_email(r.email),
                    "role": r.role})
    return sorted(out, key=lambda p: p["name"].lower())


@router.get("/approvers")
def list_approvers(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Manager-level users an employee can address their checkout request to.
    Open to all authenticated users - only names/emails/roles are exposed."""
    import cache

    def _load():
        rows = db.query(NexusRole).filter(NexusRole.role.in_(
            [role for role, level in _ROLE_LEVEL.items() if level >= _ROLE_LEVEL["manager"]]
        )).order_by(NexusRole.email).all()
        return _nexus_people_only(db, rows)
    # Same payload for every caller; role changes invalidate via the watch. The
    # company wall is applied after the cache: a walled caller is offered only
    # managers inside their scope (one outside it could never see the request).
    return _people_in_scope(db, user, cache.role_holders.get_or_load("approvers", _load))


@router.get("/allocators")
def list_allocators(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not _is_items_manager(user, db):
        raise HTTPException(403, "Manager or above required")
    import cache

    def _load():
        rows = db.query(NexusRole).filter(NexusRole.role.in_(
            [role for role, level in _ROLE_LEVEL.items() if level >= _ROLE_LEVEL["supervisor"]]
        )).order_by(NexusRole.email).all()
        return _nexus_people_only(db, rows)
    # Permission check stays OUTSIDE the cache; the payload itself is the same
    # for everyone who passes it - the company wall is applied after it.
    return _people_in_scope(db, user, cache.role_holders.get_or_load("allocators", _load))


def _people_in_scope(db: Session, user: dict, people: list) -> list:
    """Picker rows whose person the caller's company scope admits."""
    import auth
    scope = auth.company_scope(user, db)
    if scope is None:
        return people
    companies = auth.company_of_email_map(db)   # one read, not one per row
    blank_ok = auth.admits_blank(scope)
    return [p for p in people
            if auth.company_ok(companies.get((p.get("email") or "").lower(), ""), scope, shared_when_blank=blank_ok)]


# ── Report ────────────────────────────────────────────────────────────────────

_REPORT_HEADERS = [
    "Item", "Type", "Make", "Model", "Department", "Location", "Owner",
    "Ownership", "Status", "Requested By", "Days", "Reason",
    "Request Date", "Allocated Date", "Allocated By", "Returned Date", "Condition",
]


def _us_day(iso: str) -> str:
    """MM/DD/YYYY for the stored UTC timestamp's date (US format everywhere)."""
    try:
        return datetime.fromisoformat(str(iso or "")[:10]).strftime("%m/%d/%Y")
    except ValueError:
        return ""


def _report_rows(db: Session, *, department, item_type, status, requested_by=None, scope=None):
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
        # Comma-separated names - match any (case-insensitive substring per name)
        names = [n.strip() for n in requested_by.split(",") if n.strip()]
        if names:
            q = q.filter(or_(*[ItemCheckout.requested_by.ilike(f"%{n}%") for n in names]))
    rows = []
    for c, item in q.all():
        if scope is not None and not _item_ok(item, scope):
            continue                      # company wall: only the caller's companies' items
        rows.append([
            c.item_name, item.item_type if item else "", item.make if item else "",
            item.model if item else "", c.department, item.location if item else "",
            item.default_owner if item else "", item.ownership_type if item else "",
            c.status, c.requested_by, c.days, c.reason,
            _us_day(c.created_at), _us_day(c.allocated_at), c.allocated_by or "",
            _us_day(c.returned_at), c.condition_note or "",
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
    rows  = _report_rows(db, department=department, item_type=item_type, status=status,
                         requested_by=requested_by, scope=_scope(user, db))
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
    start:  Optional[str] = None,   # ISO instant, inclusive - the viewer's local midnight
    end:    Optional[str] = None,   # ISO instant, exclusive
    user: dict = Depends(require_items_admin),
    db: Session = Depends(get_db),
):
    query = db.query(AuditLog).filter(AuditLog.resource_type.in_(["items", "item_checkouts", "inventory-requests"]))
    # Company wall: a walled manager reads the history of their companies'
    # items (and those items' checkouts), plus the rows with no record id
    # (bulk edits, imports) written by people of their companies.
    scope = _scope(user, db)
    if scope is not None:
        item_ids = sorted(visible_item_ids(db, user, scope) or [])
        co_ids = [r[0] for r in db.query(ItemCheckout.id).filter(ItemCheckout.item_id.in_(item_ids)).all()] if item_ids else []
        actors = [(e[0] or "").lower() for e in db.query(NexusEmployee.work_email)
                  .filter(NexusEmployee.company.in_(list(scope))).all() if e[0]] if scope else []
        conds = []
        if item_ids or co_ids:
            conds.append(AuditLog.resource_id.in_(item_ids + co_ids))
        if actors:
            conds.append(and_(or_(AuditLog.resource_id.is_(None), AuditLog.resource_id == ""),
                              func.lower(AuditLog.user_email).in_(actors)))
        query = query.filter(or_(*conds)) if conds else query.filter(sa_false())
    if q:
        needle = q.strip()
        query = query.filter(or_(
            AuditLog.details.contains(needle),
            AuditLog.user_email.contains(needle.lower()),
            AuditLog.action.contains(needle),
            AuditLog.resource_id.contains(needle),
        ))
    # The date filter runs here, not on the page the browser holds (Nov 2026):
    # the screen sends the bounds of the days picked in the viewer's own zone.
    # Stored timestamps are UTC ISO strings, so the bounds are compared as UTC.
    for bound, op in ((start, "ge"), (end, "lt")):
        if not (bound or "").strip():
            continue
        try:
            at = datetime.fromisoformat(bound.strip().replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(400, "start / end must be ISO date-times")
        at = (at if at.tzinfo else at.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()
        query = query.filter(AuditLog.timestamp >= at if op == "ge" else AuditLog.timestamp < at)
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    total = query.count()
    rows  = query.order_by(AuditLog.timestamp.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "rows": [
            {"id": r.id, "timestamp": r.timestamp, "user_email": r.user_email,
             "user_role": r.user_role, "action": r.action,
             "resource_id": r.resource_id, "details": r.details,
             "undone_at": r.undone_at or "", "undone_by": r.undone_by or ""}
            for r in rows
        ],
    }


# Columns the audit Undo is allowed to restore (1:1 with the audit field names the
# frontend tracks). Scalar columns only - no relations, no side effects.
# P1-3: lifecycle "status" removed - it is derived from checkouts/assignments, never
# restored as a raw string (an undo could otherwise strand an item's lifecycle state).
_UNDO_ITEM_COLS = {
    "name", "item_type", "make", "model", "year", "department", "location",
    "default_owner", "ownership_type", "serial_number",
    "op_status", "op_status_person_name", "asset_value", "photo_url",
}


class AuditUndoRequest(BaseModel):
    audit_id: int
    # IGNORED since Nov 2026 - the server rebuilds the previous values from the
    # audit log itself (_previous_values). Kept so older clients still validate.
    fields: Optional[dict] = None


# Audit actions that carry an item's field values in `details` (the request
# body the audit middleware copied) - the events an edit's "before" is read from.
_FIELD_EVENT_WORDS = ("added", "updated", "edited", "imported")


def _previous_values(db: Session, row: AuditLog) -> dict:
    """What an "Updated item" audit row changed FROM, rebuilt on the server
    (H4, Nov 2026 - the client used to send the "previous" values, so any
    value at all could be written through Undo). For every undoable field
    the row set, the value is the one the item's latest EARLIER field event
    (an add, an edit, an import, an earlier undo) recorded for that field.
    A field with no earlier record is left out - there is no known "before"."""
    try:
        details = json.loads(row.details or "{}")
    except (TypeError, ValueError):
        details = {}
    if not isinstance(details, dict):
        return {}
    wanted = [f for f in _UNDO_ITEM_COLS if f in details]
    if not wanted or not row.resource_id:
        return {}
    earlier = (db.query(AuditLog)
               .filter(AuditLog.resource_type == "items", AuditLog.resource_id == row.resource_id,
                       or_(AuditLog.timestamp < row.timestamp,
                           and_(AuditLog.timestamp == row.timestamp, AuditLog.id < row.id)))
               .order_by(AuditLog.timestamp.desc(), AuditLog.id.desc()).all())
    out = {}
    for e in earlier:
        if not any(w in (e.action or "").lower() for w in _FIELD_EVENT_WORDS):
            continue
        try:
            d = json.loads(e.details or "{}")
        except (TypeError, ValueError):
            continue
        if not isinstance(d, dict):
            continue
        for f in wanted:
            if f not in out and f in d:
                out[f] = d[f]
        if len(out) == len(wanted):
            break
    return out


def _apply_undo_fields(db: Session, item: Item, values: dict) -> dict:
    """Put `values` back on `item` through the same rules an edit obeys
    (update_item): storage-only photos, a known ownership that does not
    strand a live checkout / assignment, a known op status, the type list,
    a non-empty name and a serial no other item uses (409, never a 500)."""
    applied = {}
    canon = None
    for k, v in values.items():
        if k not in _UNDO_ITEM_COLS:
            continue
        if k == "asset_value":
            try:
                v = float(v or 0)
            except (TypeError, ValueError):
                v = 0.0
        elif k == "photo_url":
            v = str(v or "").strip()
            _validate_photo_url(v, "photo_url")
        elif k == "ownership_type":
            v = str(v or "").strip().lower()
            if v not in ("permanent", "transient"):
                raise HTTPException(400, "The previous ownership can't be restored")
            _check_ownership_change(db, item, v)
        elif k == "op_status":
            v = str(v or "").strip()
            if v and v not in _OP_STATUSES:
                raise HTTPException(400, "The previous status can't be restored")
        elif k == "item_type":
            canon = canon or _type_canon(db)
            v = _normalize_type(v, canon)
        elif k == "name":
            v = str(v or "").strip()
            if not v:
                raise HTTPException(400, "Name cannot be empty")
        elif k == "serial_number":
            v = str(v or "").strip()
            _check_serial_free(db, item, v)
        else:
            v = str(v if v is not None else "").strip()
        setattr(item, k, v)
        applied[k] = v
    # Reverted off a person-bound state: drop the stale person.
    if "op_status" in applied and applied["op_status"] not in _OP_STATUS_PERSON:
        item.op_status_person_email = ""
        item.op_status_person_name = ""
    return applied


@router.post("/audit-undo")
def undo_audit_entry(body: AuditUndoRequest, user: dict = Depends(require_items_admin), db: Session = Depends(get_db)):
    """Revert a single item add / edit / delete recorded in the audit log.

    Edits restore the previous values the SERVER rebuilds from the log
    (_previous_values - the client's `fields` are ignored) through the edit
    rules (_apply_undo_fields); adds are soft-deleted; deletes are restored.
    The audit row is locked, so two Undo clicks cannot both pass the "already
    undone" check. The original entry is marked undone and a new canonical
    entry (carrying a "reason") records the reversal.
    """
    row = db.query(AuditLog).filter(AuditLog.id == body.audit_id).with_for_update().first()
    if not row or row.resource_type != "items":
        raise HTTPException(404, "Audit entry not found")
    if row.undone_at:
        raise HTTPException(409, "This change was already undone")

    action = (row.action or "").lower()
    iid    = row.resource_id or ""
    email  = user["email"]
    now    = datetime.now(timezone.utc).isoformat()
    item   = db.query(Item).filter(Item.id == iid).with_for_update().first() if iid else None
    if item is not None:
        _wall_item(item, user, db)

    applied, reason, new_action = {}, "", ""

    if action.startswith("added item"):
        if not item:
            raise HTTPException(404, "That item no longer exists")
        if item.deleted_at:
            raise HTTPException(409, "That item is already deleted")
        active = db.query(ItemCheckout).filter(
            ItemCheckout.item_id == iid,
            ItemCheckout.status.in_(_LIVE_CHECKOUT),
        ).count()
        live_asg = db.query(ItemAssignment).filter(
            ItemAssignment.item_id == iid,
            ItemAssignment.status.in_(["pending_acceptance", "active", "return_initiated"]),
        ).count()
        if active or live_asg:
            raise HTTPException(409, "Can't undo - the item is checked out or assigned right now")
        _soft_delete(item, email)
        reason, new_action = "Undo - removed the added item", f"Deleted item {iid}"

    elif action.startswith("deleted item"):
        if not item:
            raise HTTPException(404, "That item no longer exists")
        if not item.deleted_at:
            raise HTTPException(409, "That item is not deleted")
        _restore(item)
        reason, new_action = "Undo - restored the deleted item", f"Restored item {iid}"

    elif action.startswith("updated item"):
        if not item:
            raise HTTPException(404, "That item no longer exists")
        applied = _apply_undo_fields(db, item, _previous_values(db, row))
        if not applied:
            raise HTTPException(400, "Nothing to restore for this change")
        reason, new_action = "Undo - restored previous value(s)", f"Updated item {iid}"

    else:
        raise HTTPException(400, "This kind of change can't be undone")

    row.undone_at = now
    row.undone_by = email

    details = {"path": "/items/audit-undo", "status": 200, "reason": reason, "undo_of": row.id}
    details.update(applied)
    db.add(AuditLog(
        timestamp=now, user_email=email, user_role="",
        action=new_action, resource_type="items", resource_id=iid,
        details=json.dumps(details), ip_address="",
    ))
    try:
        db.commit()
    except IntegrityError:
        # The serial index caught a clash a concurrent edit made after the check.
        db.rollback()
        raise HTTPException(409, "That serial is already used by another item")
    return {"ok": True, "undone_id": row.id}
