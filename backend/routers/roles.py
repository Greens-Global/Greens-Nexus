import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import get_db
from models import NexusRole

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
    role:        str
    assigned_by: str   # email of the person making the change


@router.get("/me")
def get_my_role(email: str, db: Session = Depends(get_db)):
    """Return the Nexus role for the given email. Defaults to 'employee'."""
    _seed_if_empty(db)
    role = _get_role(email, db)
    return {"email": email.lower(), "role": role}


@router.get("")
def get_all_roles(db: Session = Depends(get_db)):
    """Return all explicit role assignments."""
    rows = db.query(NexusRole).all()
    return [{"email": r.email, "role": r.role, "assigned_by": r.assigned_by} for r in rows]


@router.put("/{email}")
def assign_role(email: str, body: RoleAssignment, db: Session = Depends(get_db)):
    """Assign a role to a user. Requester must be administrator or owner."""
    target_email    = email.lower().strip()
    requester_email = body.assigned_by.lower().strip()
    new_role        = body.role.lower().strip()

    if new_role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role '{new_role}'")

    requester_role  = _get_role(requester_email, db)
    requester_level = ROLE_LEVEL.get(requester_role, 1)
    target_level    = ROLE_LEVEL.get(new_role, 1)

    if requester_level < ROLE_LEVEL["administrator"]:
        raise HTTPException(status_code=403, detail="Need administrator or owner role to manage roles")

    # Non-owners cannot assign a role higher than their own
    if target_level > requester_level and requester_role != "owner":
        raise HTTPException(status_code=403, detail="Cannot assign a role higher than your own")

    row = db.query(NexusRole).filter(NexusRole.email == target_email).first()
    if row:
        row.role        = new_role
        row.assigned_by = requester_email
    else:
        row = NexusRole(email=target_email, role=new_role, assigned_by=requester_email)
        db.add(row)
    db.commit()
    return {"email": target_email, "role": new_role}
