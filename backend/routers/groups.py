from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import NexusGroup, NexusGroupMember, NexusRole
from auth import get_current_user, require_administrator, invalidate_role_cache
from routers.roles import VALID_ROLES, ROLE_LEVEL, _get_role

router = APIRouter(prefix="/groups", tags=["groups"])

STARTER_GROUPS = ["Accounting", "Construction", "IT", "Admin", "HR", "Ops", "Managers", "Investor", "Leadership"]


def _ts():
    return datetime.utcnow().isoformat()


def _seed_if_empty(db: Session):
    """Pre-populate the starter groups so Access Manager isn't an empty state."""
    if db.query(NexusGroup).count() > 0:
        return
    now = _ts()
    for i, name in enumerate(STARTER_GROUPS):
        db.add(NexusGroup(id=f"GRP{now[:10].replace('-', '')}{i:02d}", name=name, created_by="system", created_at=now))
    db.commit()


def _serialize(group: NexusGroup, db: Session) -> dict:
    members = db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group.id).all()
    return {
        "id": group.id,
        "name": group.name,
        "department": group.department or "",
        "allowed_modules": [m for m in (group.allowed_modules or "").split(",") if m],
        "created_by": group.created_by,
        "created_at": group.created_at,
        "members": [m.email for m in members],
    }


def _modules_csv(modules: list[str]) -> str:
    return ",".join(sorted({m.strip().lower() for m in (modules or []) if m.strip()}))


# ── Schemas ──────────────────────────────────────────────────────────────────

class GroupCreate(BaseModel):
    name: str
    department: Optional[str] = ""
    allowed_modules: Optional[list[str]] = []
    member_emails: Optional[list[str]] = []

class GroupUpdate(BaseModel):
    name: Optional[str] = None
    department: Optional[str] = None
    allowed_modules: Optional[list[str]] = None

class MembersUpdate(BaseModel):
    emails: list[str]

class GroupRoleAssignment(BaseModel):
    role: str
    assigned_by: str


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("")
def list_groups(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    _seed_if_empty(db)
    groups = db.query(NexusGroup).order_by(NexusGroup.created_at).all()
    return [_serialize(g, db) for g in groups]


@router.post("")
def create_group(body: GroupCreate, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")

    now = _ts()
    group = NexusGroup(
        id=f"GRP{now.replace('-', '').replace(':', '').replace('.', '')[:17]}",
        name=name,
        department=(body.department or "").strip(),
        allowed_modules=_modules_csv(body.allowed_modules),
        created_by=user["email"],
        created_at=now,
    )
    db.add(group)
    db.flush()

    for email in body.member_emails or []:
        email = email.lower().strip()
        if email:
            db.add(NexusGroupMember(group_id=group.id, email=email, added_by=user["email"], added_at=now))

    db.commit()
    return _serialize(group, db)


@router.put("/{group_id}")
def update_group(group_id: str, body: GroupUpdate, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    group = db.query(NexusGroup).filter(NexusGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Group name is required")
        group.name = name
    if body.department is not None:
        group.department = body.department.strip()
    if body.allowed_modules is not None:
        group.allowed_modules = _modules_csv(body.allowed_modules)

    db.commit()
    return _serialize(group, db)


@router.delete("/{group_id}")
def delete_group(group_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    group = db.query(NexusGroup).filter(NexusGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id).delete()
    db.delete(group)
    db.commit()
    return {"deleted": group_id}


@router.post("/{group_id}/members")
def add_members(group_id: str, body: MembersUpdate, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    group = db.query(NexusGroup).filter(NexusGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    now = _ts()
    existing = {m.email for m in db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id).all()}
    added = 0
    for email in body.emails or []:
        email = email.lower().strip()
        if email and email not in existing:
            db.add(NexusGroupMember(group_id=group_id, email=email, added_by=user["email"], added_at=now))
            existing.add(email)
            added += 1

    if added:
        db.commit()
    return _serialize(group, db)


@router.delete("/{group_id}/members/{email}")
def remove_member(group_id: str, email: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    group = db.query(NexusGroup).filter(NexusGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    target = email.lower().strip()
    row = db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id, NexusGroupMember.email == target).first()
    if row:
        db.delete(row)
        db.commit()
    return _serialize(group, db)


@router.post("/{group_id}/assign-role")
def assign_group_role(group_id: str, body: GroupRoleAssignment, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Bulk-assign a role to every member of the group, enforcing the same
    delegation rules as the single-user PUT /roles/{email} (roles.py:99-114) —
    requesters can only grant roles strictly below their own level (unless
    owner) and cannot touch existing admins."""
    group = db.query(NexusGroup).filter(NexusGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    new_role = body.role.lower().strip()
    if new_role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"Invalid role '{new_role}'")

    requester_level = user["level"]
    target_level = ROLE_LEVEL.get(new_role, 1)
    if requester_level < ROLE_LEVEL["administrator"]:
        raise HTTPException(status_code=403, detail="Need IT Admin or Global Admin role to manage roles")
    if user["role"] != "owner" and target_level >= requester_level:
        raise HTTPException(status_code=403, detail="You can only grant access up to one level below your own role")

    members = db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id).all()
    updated, skipped = [], []
    now = _ts()

    for m in members:
        email = m.email
        if user["role"] != "owner":
            existing_role = _get_role(email, db)
            if ROLE_LEVEL.get(existing_role, 1) >= ROLE_LEVEL["administrator"]:
                skipped.append({"email": email, "reason": "Only a Global Admin can change another admin's access"})
                continue

        row = db.query(NexusRole).filter(NexusRole.email == email).first()
        if row:
            row.role = new_role
            row.assigned_by = user["email"]
        else:
            db.add(NexusRole(email=email, role=new_role, assigned_by=user["email"]))
        invalidate_role_cache(email)
        updated.append(email)

    db.commit()
    return {"updated": updated, "skipped": skipped, "assigned_at": now}
