"""External users (Entra B2B guests) - admin CRUD behind the Roles & Access
"External Users" panel (Aug 17).

The allowlist model: a guest invited into the Entra tenant can sign in to
Microsoft, but Nexus only accepts them if an ACTIVE identity_type='guest' row
exists in nexus_employees for their invited email (enforced centrally in
auth.apply_external_policy - default-deny). This router manages those rows:

- list / enroll / deactivate / reactivate / edit an external user
- their module access flows through the normal Access Group machinery: the
  router keeps one auto-managed "External - ..." group per distinct grant set
  (never a per-person group), so the Groups tab stays readable and auditable.
- grantable modules are restricted to auth.EXTERNAL_SAFE_MODULES; the API
  surface each grant opens for an external is auth.EXTERNAL_MODULE_PREFIXES.

External rows are EXCLUDED from /myhr/directory (people pickers) and can never
hold a role above employee (auth caps them), so they never receive
manager-broadcast notifications and never pollute org-wide people lists.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import get_db
from auth import (require_administrator, invalidate_external_cache,
                  invalidate_role_cache, INTERNAL_DOMAINS, EXTERNAL_SAFE_MODULES)
from models import NexusEmployee, NexusGroup, NexusGroupMember
from routers.groups import _parse_modules
import cache

router = APIRouter(prefix="/external-users", tags=["External Users"])

_EXTERNAL_TYPES = ("guest", "external")
_GROUP_PREFIX = "External - "

# What a new external user gets when the admin doesn't pick modules explicitly
# (Neil's partner-collaboration case): work the tasks/tickets they participate
# in, nothing else. Task/ticket data is participation-scoped for externals
# (task_util visibility + tickets never grant the desk queue). Documents is
# deliberately NOT in the default: the Documents module is org-visible for any
# grant holder (documents._visible), so granting it shows an external EVERY
# shared company document - grant it only as a deliberate choice until
# per-external scoping lands there.
_DEFAULT_MODULES = [{"id": "tasks", "level": "editor"},
                    {"id": "tickets", "level": "editor"}]

_LEVELS = ("viewer", "editor")   # externals never get full/owner (delete/manage)

_MODULE_LABELS = {"tasks": "Tasks", "tickets": "Tickets", "documents": "Documents",
                  "sop": "Knowledge Base", "external-links": "External Links"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_modules(modules) -> list[dict]:
    """Validate a grant list against the external-safe set. Raises 400 on
    anything outside it - an admin must never be able to open an internal-only
    module to an external through this endpoint."""
    out, seen = [], set()
    for m in modules or []:
        mid = (m.get("id") or "").strip().lower()
        level = (m.get("level") or "viewer").strip().lower()
        if not mid or mid in seen:
            continue
        if mid not in EXTERNAL_SAFE_MODULES:
            raise HTTPException(400, f"Module '{mid}' cannot be granted to external users")
        if level not in _LEVELS:
            raise HTTPException(400, f"Level must be one of {_LEVELS} for external users")
        seen.add(mid)
        out.append({"id": mid, "level": level})
    return sorted(out, key=lambda g: g["id"])


def _modules_csv(modules: list[dict]) -> str:
    return ",".join(f"{g['id']}:{g['level']}" for g in modules)


def _group_name(modules: list[dict]) -> str:
    if not modules:
        return _GROUP_PREFIX + "No Access"
    return _GROUP_PREFIX + " + ".join(
        f"{_MODULE_LABELS.get(g['id'], g['id'])} ({g['level'].capitalize()})" for g in modules)


def _ensure_group(db: Session, modules: list[dict], admin_email: str) -> NexusGroup | None:
    """Find or create the auto-managed 'External - ...' group carrying exactly
    this grant set. One group per distinct set - the 7-9 partner users who share
    a set share a group."""
    if not modules:
        return None
    csv = _modules_csv(modules)
    grp = (db.query(NexusGroup)
           .filter(NexusGroup.name.like(_GROUP_PREFIX + "%"),
                   NexusGroup.allowed_modules == csv).first())
    if grp:
        return grp
    grp = NexusGroup(
        id=f"EXTGRP{uuid.uuid4().hex[:12].upper()}",
        name=_group_name(modules),
        department="",
        allowed_modules=csv,
        created_by=admin_email,
        created_at=_now(),
    )
    db.add(grp)
    db.flush()   # autoflush=False - make the row visible to this transaction
    return grp


def _set_membership(db: Session, email: str, modules: list[dict], admin_email: str) -> None:
    """Point this external's membership at the right 'External - ...' group,
    removing them from any other auto-managed external group first. Manually
    added (non 'External - ') groups are left alone - admins may still layer
    extra groups through the normal Groups tab if they choose."""
    ext_group_ids = [g.id for g in db.query(NexusGroup)
                     .filter(NexusGroup.name.like(_GROUP_PREFIX + "%")).all()]
    if ext_group_ids:
        (db.query(NexusGroupMember)
         .filter(NexusGroupMember.email == email,
                 NexusGroupMember.group_id.in_(ext_group_ids))
         .delete(synchronize_session=False))
    grp = _ensure_group(db, modules, admin_email)
    if grp:
        db.add(NexusGroupMember(group_id=grp.id, email=email,
                                added_by=admin_email, added_at=_now()))


def _modules_for(db: Session, email: str) -> list[dict]:
    rows = (db.query(NexusGroup.allowed_modules)
            .join(NexusGroupMember, NexusGroupMember.group_id == NexusGroup.id)
            .filter(NexusGroupMember.email == email).all())
    best: dict[str, str] = {}
    rank = {"viewer": 1, "editor": 2, "full": 3, "owner": 4}
    for (csv,) in rows:
        for g in _parse_modules(csv or ""):
            if rank.get(g["level"], 1) > rank.get(best.get(g["id"], ""), 0):
                best[g["id"]] = g["level"]
    return [{"id": mid, "level": lvl} for mid, lvl in sorted(best.items())]


def _serialize(db: Session, e: NexusEmployee) -> dict:
    email = (e.work_email or "").lower()
    return {
        "id": e.id,
        "email": email,
        "firstName": e.first_name or "",
        "lastName": e.last_name or "",
        "name": (e.display_name or "").strip() or f"{e.first_name} {e.last_name}".strip() or email,
        "company": getattr(e, "external_company", "") or "",
        "status": e.status or "active",
        "identityType": e.identity_type or "guest",
        "invitedBy": getattr(e, "invited_by", "") or "",
        "expiresAt": getattr(e, "expires_at", "") or "",
        "createdAt": e.created_at or "",
        "modules": _modules_for(db, email),
    }


def _invalidate(email: str) -> None:
    invalidate_external_cache(email)
    invalidate_role_cache(email)
    cache.module_grants.invalidate(email)
    cache.people_directory.invalidate()


# ── Schemas ──────────────────────────────────────────────────────────────────

class ModuleGrantIn(BaseModel):
    id: str
    level: str = "viewer"

class ExternalUserCreate(BaseModel):
    email:      str
    first_name: str
    last_name:  Optional[str] = ""
    company:    Optional[str] = ""
    expires_at: Optional[str] = ""      # ISO date; empty = no expiry
    modules:    Optional[list[ModuleGrantIn]] = None   # None = default set

class ExternalUserUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name:  Optional[str] = None
    company:    Optional[str] = None
    status:     Optional[str] = None    # active | inactive
    expires_at: Optional[str] = None
    modules:    Optional[list[ModuleGrantIn]] = None


# ── Routes (admin-gated - this is access management) ─────────────────────────

@router.get("/meta")
def external_users_meta(user: dict = Depends(require_administrator)):
    """What the admin panel may grant: the external-safe module set + the
    default proposal for a new external user."""
    return {
        "modules": [{"id": mid, "label": _MODULE_LABELS.get(mid, mid)} for mid in EXTERNAL_SAFE_MODULES],
        "levels": list(_LEVELS),
        "defaults": _DEFAULT_MODULES,
        "internalDomains": list(INTERNAL_DOMAINS),
    }


@router.get("")
def list_external_users(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    rows = (db.query(NexusEmployee)
            .filter(NexusEmployee.identity_type.in_(_EXTERNAL_TYPES))
            .order_by(NexusEmployee.created_at.desc()).all())
    return [_serialize(db, e) for e in rows]


@router.post("", status_code=201)
def enroll_external_user(body: ExternalUserCreate,
                         user: dict = Depends(require_administrator),
                         db: Session = Depends(get_db)):
    email = (body.email or "").lower().strip()
    if "@" not in email or " " in email:
        raise HTTPException(400, "A valid email address is required")
    domain = email.rpartition("@")[2]
    if domain in INTERNAL_DOMAINS:
        raise HTTPException(400, "That is a company email - employees sign in with their Microsoft account and are managed in People, not here")
    if not (body.first_name or "").strip():
        raise HTTPException(400, "first_name is required")

    existing = (db.query(NexusEmployee)
                .filter(func.lower(NexusEmployee.work_email) == email).first())
    if existing:
        if (existing.identity_type or "internal") in _EXTERNAL_TYPES:
            raise HTTPException(409, "This email is already enrolled as an external user - edit or reactivate it instead")
        raise HTTPException(400, "This email already belongs to a person in People")

    modules = _clean_modules([{"id": m.id, "level": m.level} for m in body.modules] if body.modules is not None
                             else _DEFAULT_MODULES)
    now = _now()
    row = NexusEmployee(
        id=str(uuid.uuid4()),
        employee_code="",            # externals never get a GG-xxx code
        first_name=body.first_name.strip(),
        last_name=(body.last_name or "").strip(),
        work_email=email,
        identity_type="guest",       # Entra B2B guest login (Tier B in the July plan)
        status="active",
        external_company=(body.company or "").strip(),
        invited_by=user["email"],
        expires_at=(body.expires_at or "").strip(),
        created_by=user["email"],
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.flush()
    _set_membership(db, email, modules, user["email"])
    db.commit()
    _invalidate(email)
    return _serialize(db, row)


@router.patch("/{email}")
def update_external_user(email: str, body: ExternalUserUpdate,
                         user: dict = Depends(require_administrator),
                         db: Session = Depends(get_db)):
    email = email.lower().strip()
    row = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email,
                   NexusEmployee.identity_type.in_(_EXTERNAL_TYPES)).first())
    if not row:
        raise HTTPException(404, "External user not found")

    if body.status is not None:
        if body.status not in ("active", "inactive"):
            raise HTTPException(400, "status must be 'active' or 'inactive'")
        row.status = body.status
    if body.first_name is not None:
        if not body.first_name.strip():
            raise HTTPException(400, "first_name cannot be empty")
        row.first_name = body.first_name.strip()
    if body.last_name is not None:
        row.last_name = body.last_name.strip()
    if body.company is not None:
        row.external_company = body.company.strip()
    if body.expires_at is not None:
        row.expires_at = body.expires_at.strip()
    if body.modules is not None:
        _set_membership(db, email, _clean_modules([{"id": m.id, "level": m.level} for m in body.modules]), user["email"])

    row.updated_at = _now()
    db.commit()
    _invalidate(email)
    return _serialize(db, row)
