import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import NexusRole
from auth import get_current_user, require_administrator, require_level, invalidate_role_cache

router = APIRouter(prefix="/roles", tags=["roles"])

VALID_ROLES = {"employee", "supervisor", "manager", "administrator", "owner"}

ROLE_LEVEL = {
    "employee":      1,
    "supervisor":    2,
    "manager":       3,
    "administrator": 4,
    "owner":         5,
}


def _seed_if_empty(db: Session):
    """If the nexus_roles table is empty, seed the owner from env var."""
    owner_email = os.getenv("NEXUS_OWNER_EMAIL", "").lower().strip()
    if not owner_email:
        return
    if db.query(NexusRole).count() == 0:
        db.add(NexusRole(email=owner_email, role="owner", assigned_by="system"))
        db.commit()


def _get_role(email: str, db: Session) -> str:
    row = db.query(NexusRole).filter(NexusRole.email == email.lower()).first()
    return row.role if row else "employee"


class RoleAssignment(BaseModel):
    role:         str
    assigned_by:  str   # email of the person making the change
    display_name: Optional[str] = ""  # from Microsoft Graph — lets us show names instead of emails elsewhere

class SyncRequest(BaseModel):
    emails: list[str]


@router.post("/sync")
def sync_users(body: SyncRequest, user: dict = Depends(require_level(4)), db: Session = Depends(get_db)):
    """Insert all provided emails with role='employee' if they don't already have a row."""
    new_count = 0
    for email in body.emails:
        email = email.lower().strip()
        if not email:
            continue
        exists = db.query(NexusRole).filter(NexusRole.email == email).first()
        if not exists:
            db.add(NexusRole(email=email, role="employee", assigned_by="system"))
            new_count += 1
    if new_count:
        db.commit()
    return {"synced": new_count, "total": len(body.emails)}


@router.get("/me")
def get_my_role(
    user: dict = Depends(get_current_user),
    db:   Session = Depends(get_db),
):
    """Return the caller's role — identity is taken from the verified token, never from a param."""
    _seed_if_empty(db)
    role = _get_role(user["email"], db)
    return {"email": user["email"], "role": role}


@router.get("")
def get_all_roles(
    user: dict = Depends(require_administrator),
    db:   Session = Depends(get_db),
):
    """Return all role assignments. Requires administrator or above."""
    rows = db.query(NexusRole).all()
    return [{"email": r.email, "role": r.role, "display_name": r.display_name or "", "assigned_by": r.assigned_by} for r in rows]


@router.put("/{email}")
def assign_role(
    email: str,
    body:  RoleAssignment,
    user:  dict = Depends(get_current_user),
    db:    Session = Depends(get_db),
):
    """Assign a role. Requester identity comes from the verified token — not the request body."""
    target_email = email.lower().strip()
    new_role     = body.role.lower().strip()

    if new_role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role '{new_role}'")

    requester_level = user["level"]
    target_level    = ROLE_LEVEL.get(new_role, 1)

    if requester_level < ROLE_LEVEL["administrator"]:
        raise HTTPException(status_code=403, detail="Need administrator or owner role to manage roles")

    if target_level > requester_level and user["role"] != "owner":
        raise HTTPException(status_code=403, detail="Cannot assign a role higher than your own")

    display_name = (body.display_name or "").strip()

    row = db.query(NexusRole).filter(NexusRole.email == target_email).first()
    if row:
        row.role        = new_role
        row.assigned_by = user["email"]
        if display_name:
            row.display_name = display_name
    else:
        row = NexusRole(email=target_email, role=new_role, display_name=display_name, assigned_by=user["email"])
        db.add(row)
    db.commit()
    invalidate_role_cache(target_email)
    return {"email": target_email, "role": new_role}
