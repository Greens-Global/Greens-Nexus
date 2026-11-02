from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from database import get_db
from models import NexusGroup, NexusGroupMember, NexusRole
import auth
from auth import get_current_user, require_administrator, invalidate_role_cache, _MODULE_LEVEL_RANK, _LEVELS
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


def _parse_modules(raw: str) -> list[dict]:
    """Decode 'inventory:full,it' → [{"id": "inventory", "level": "full"}, {"id": "it", "level": "viewer"}].
    A bare module id with no ':level' suffix (old data, or a malformed grant)
    defaults to "viewer" - matching the original visibility-only behaviour."""
    out = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        mid, _, level = part.partition(":")
        mid = mid.strip().lower()
        if not mid:
            continue
        level = level.strip().lower()
        if level not in _MODULE_LEVEL_RANK:
            level = "viewer"
        out.append({"id": mid, "level": level})
    return out


def _serialize(group: NexusGroup, db: Session) -> dict:
    members = db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group.id).all()
    return {
        "id": group.id,
        "name": group.name,
        "department": group.department or "",
        "allowed_modules": _parse_modules(group.allowed_modules or ""),
        "created_by": group.created_by,
        "created_at": group.created_at,
        "members": [m.email for m in members],
        # Roles & Access redesign: job-role templates live in this same table.
        "is_job_role": bool(getattr(group, "is_job_role", False)),
        "tier": getattr(group, "tier", "") or "",
        "description": getattr(group, "description", "") or "",
        "monitoring_exempt": bool(getattr(group, "monitoring_exempt", False)),
        "bod_exempt": bool(getattr(group, "bod_exempt", False)),
        "time_tracking_exempt": bool(getattr(group, "time_tracking_exempt", False)),
        # Multi-company walls: a company_id makes this a per-company ROLE; the
        # is_global_admin flag makes its members Global Admins (see the walls).
        "company_id": getattr(group, "company_id", "") or "",
        "is_global_admin": bool(getattr(group, "is_global_admin", False)),
    }


def _modules_csv(modules: "list[ModuleGrant]") -> str:
    """Encode [{"id": "inventory", "level": "full"}, ...] → 'inventory:full,it:viewer',
    deduping by module id (last grant for a given module wins) and validating levels."""
    seen: dict[str, str] = {}
    for m in modules or []:
        mid = (m.id or "").strip().lower()
        if not mid:
            continue
        level = (m.level or "viewer").strip().lower()
        if level not in _MODULE_LEVEL_RANK:
            level = "viewer"
        seen[mid] = level
    return ",".join(f"{mid}:{level}" for mid, level in sorted(seen.items()))


# ── Schemas ──────────────────────────────────────────────────────────────────

class ModuleGrant(BaseModel):
    """One screen + the permission level the group grants for it - mirrors a
    folder-permission row (Viewer/Editor/Full/Owner), so visibility and
    capability are decided together as a single, explicit, auditable choice."""
    id: str
    level: str = "viewer"

class GroupCreate(BaseModel):
    name: str
    department: Optional[str] = ""
    allowed_modules: Optional[list[ModuleGrant]] = []
    member_emails: Optional[list[str]] = []
    monitoring_exempt: Optional[bool] = False
    bod_exempt: Optional[bool] = False
    time_tracking_exempt: Optional[bool] = False
    company_id: Optional[str] = ""            # HrEntity.id -> a per-company role
    is_global_admin: Optional[bool] = False   # members see past the company walls

class GroupUpdate(BaseModel):
    name: Optional[str] = None
    department: Optional[str] = None
    allowed_modules: Optional[list[ModuleGrant]] = None
    monitoring_exempt: Optional[bool] = None
    bod_exempt: Optional[bool] = None
    time_tracking_exempt: Optional[bool] = None
    company_id: Optional[str] = None
    is_global_admin: Optional[bool] = None

class MembersUpdate(BaseModel):
    emails: list[str]

class GroupRoleAssignment(BaseModel):
    role: str
    assigned_by: str


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("")
def list_groups(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if user["level"] >= 4:
        # Administrators see the groups for management in the Access Manager -
        # a walled one (an Administrator, always: Neil, 11/02/2026) only their
        # companies' groups and the shared ones, and in each only the members
        # inside their companies (or with no company). A Super Administrator
        # sees every group and every member.
        _seed_if_empty(db)
        groups = db.query(NexusGroup).order_by(NexusGroup.created_at).all()
        scope = auth.company_scope(user, db)
        if scope is not None:
            groups = [g for g in groups if auth.company_ok(g.company_id or "", scope, shared_when_blank=True)]
            emp_co = auth.company_of_email_map(db)
            result = [_serialize(g, db) for g in groups]
            for g in result:
                g["members"] = [m for m in g["members"]
                                if auth.company_ok(emp_co.get(m.lower(), ""), scope, shared_when_blank=True)]
            return result
    else:
        # All other users only receive the groups they belong to - enough for the
        # frontend to compute myGrantedModules without exposing org-wide group data
        member_ids = [r.group_id for r in db.query(NexusGroupMember.group_id).filter(
            NexusGroupMember.email == user["email"]
        ).all()]
        groups = db.query(NexusGroup).filter(NexusGroup.id.in_(member_ids)).order_by(NexusGroup.created_at).all() if member_ids else []
    result = [_serialize(g, db) for g in groups]
    if user["level"] < 4:
        # Non-admins must not see other members' emails - they only need to
        # know they're in the group (for myGrantedModules computation).
        for g in result:
            g["members"] = [user["email"]] if user["email"] in g["members"] else []
    return result


def _require_super_for_flagged(user: dict, group: NexusGroup | None = None, flagging: bool = False) -> None:
    """A group flagged is_global_admin makes its members Super Administrators
    in reach (auth.is_global_admin), so only a Super Administrator (level 5)
    may create one, flag one, or change a flagged group at all - its name,
    its grants, its members, or delete it (Neil, 11/02/2026). A level-4
    caller editing a plain group is unchanged."""
    if user["level"] >= _LEVELS["owner"]:
        return
    if flagging or (group is not None and getattr(group, "is_global_admin", 0)):
        raise HTTPException(status_code=403, detail="Only a Super Administrator can change a Super Administrators group")


def _guard_group_company(user: dict, db: Session, company_id: str, existing: bool = True) -> None:
    """The company wall on groups (Neil, 11/02/2026). A walled caller - an
    Administrator, always - works only on their own companies' groups: a
    group of another company is 404 (403 when they name that company for a
    new group), and a SHARED group (company '') reaches every company, so
    creating, editing or filling one is a Super Administrator's."""
    scope = auth.company_scope(user, db)
    if scope is None:
        return
    cid = (company_id or "").strip()
    if not cid:
        raise HTTPException(status_code=403, detail="Only a Super Administrator can change a shared group - pick your company for it")
    if cid not in scope:
        if existing:
            raise HTTPException(status_code=404, detail="Group not found")
        raise HTTPException(status_code=403, detail="You can only manage groups for your own company")


def _guard_members(user: dict, db: Session, emails) -> None:
    """Every member a walled caller adds must be inside their companies (or
    have no company - a guest / external); anyone else is 404."""
    scope = auth.company_scope(user, db)
    if scope is None:
        return
    for email in emails or []:
        email = (email or "").lower().strip()
        if email and not auth.person_in_scope(email, scope, db):
            raise HTTPException(status_code=404, detail="Not found")


def _guard_owner_only_grants(user: dict, db: Session, modules, before: str = "") -> None:
    """A grant on a module only a Super Administrator opens without one
    (auth.OWNER_ONLY_GRANTS: Personal Financial Statements, compensation,
    deleting people, Workflows' organization face) is a Super
    Administrator's to give - in a group or a job role. Only an ADDED or
    RAISED grant is refused, so an Administrator can still rename a group a
    Super Administrator gave one, or take it away."""
    if auth.is_global_admin(user, db):
        return
    had = set(auth.owner_only_grants_in(_parse_modules(before or "")))
    had_levels = {m["id"]: _MODULE_LEVEL_RANK.get(m["level"], 1) for m in _parse_modules(before or "")}
    for m in modules or []:
        mid = ((m.get("id") if isinstance(m, dict) else m.id) or "").strip().lower()
        lvl = ((m.get("level") if isinstance(m, dict) else m.level) or "viewer").strip().lower()
        if not auth.owner_only_grants_in([{"id": mid, "level": lvl}]):
            continue
        if mid in had and _MODULE_LEVEL_RANK.get(lvl, 1) <= had_levels.get(mid, 0):
            continue
        raise HTTPException(status_code=403, detail="Only a Super Administrator can grant this module")


def _guard_holds_owner_only(user: dict, db: Session, group: NexusGroup) -> None:
    """Putting someone into a group or job role that carries a Super-only
    grant hands them that grant - a Super Administrator's call too."""
    if auth.owner_only_grants_in(_parse_modules(group.allowed_modules or "")) and not auth.is_global_admin(user, db):
        raise HTTPException(status_code=403, detail="Only a Super Administrator can add people to a group with this access")


@router.post("")
def create_group(body: GroupCreate, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")
    _require_super_for_flagged(user, flagging=bool(body.is_global_admin))
    _guard_group_company(user, db, body.company_id or "", existing=False)
    _guard_owner_only_grants(user, db, body.allowed_modules)
    _guard_members(user, db, body.member_emails)

    now = _ts()
    group = NexusGroup(
        id=f"GRP{now.replace('-', '').replace(':', '').replace('.', '')[:17]}",
        name=name,
        department=(body.department or "").strip(),
        allowed_modules=_modules_csv(body.allowed_modules),
        monitoring_exempt=1 if body.monitoring_exempt else 0,
        bod_exempt=1 if body.bod_exempt else 0,
        time_tracking_exempt=1 if body.time_tracking_exempt else 0,
        company_id=(body.company_id or "").strip(),
        is_global_admin=1 if body.is_global_admin else 0,
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
    _require_super_for_flagged(user, group, flagging=bool(body.is_global_admin))
    _guard_group_company(user, db, group.company_id or "")
    if body.company_id is not None:
        _guard_group_company(user, db, body.company_id or "", existing=False)
    if body.allowed_modules is not None:
        _guard_owner_only_grants(user, db, body.allowed_modules, before=group.allowed_modules or "")

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Group name is required")
        group.name = name
    if body.department is not None:
        group.department = body.department.strip()
    if body.allowed_modules is not None:
        group.allowed_modules = _modules_csv(body.allowed_modules)
    if body.monitoring_exempt is not None:
        group.monitoring_exempt = 1 if body.monitoring_exempt else 0
    if body.bod_exempt is not None:
        group.bod_exempt = 1 if body.bod_exempt else 0
    if body.time_tracking_exempt is not None:
        group.time_tracking_exempt = 1 if body.time_tracking_exempt else 0
    if body.company_id is not None:
        new_company = (body.company_id or "").strip()
        # A job role's company decides which company wall its holders sit
        # behind, so moving one goes through PUT /jobroles/{id}, which checks
        # every holder's company and the caller's scope. Not here.
        if group.is_job_role and new_company != (group.company_id or "").strip():
            raise HTTPException(status_code=400, detail="Change a job role's company from Settings > Company Settings > Roles")
        group.company_id = new_company
    if body.is_global_admin is not None:
        group.is_global_admin = 1 if body.is_global_admin else 0

    db.commit()
    return _serialize(group, db)


@router.delete("/{group_id}")
def delete_group(group_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    group = db.query(NexusGroup).filter(NexusGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    _require_super_for_flagged(user, group)
    _guard_group_company(user, db, group.company_id or "")

    db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id).delete()
    db.delete(group)
    db.commit()
    return {"deleted": group_id}


def _refuse_job_role(group: NexusGroup):
    """A job role's members change only through Assign / Change Role, which
    check the company wall and tier and log the reason (Neil, Oct 22: no
    "changing role up and changing role down without some sort of a log")."""
    if group.is_job_role:
        raise HTTPException(status_code=400, detail="This is a job role - use Assign or Change Role, which keeps the reason in their role history.")


@router.post("/{group_id}/members")
def add_members(group_id: str, body: MembersUpdate, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    group = db.query(NexusGroup).filter(NexusGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    _require_super_for_flagged(user, group)
    _guard_group_company(user, db, group.company_id or "")
    _refuse_job_role(group)
    _guard_holds_owner_only(user, db, group)
    _guard_members(user, db, body.emails)

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
    _require_super_for_flagged(user, group)
    _guard_group_company(user, db, group.company_id or "")
    _refuse_job_role(group)
    _guard_members(user, db, [email])

    target = email.lower().strip()
    row = db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id, NexusGroupMember.email == target).first()
    if row:
        db.delete(row)
        db.commit()
    return _serialize(group, db)


@router.post("/{group_id}/assign-role")
def assign_group_role(group_id: str, body: GroupRoleAssignment, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Bulk-assign a role to every member of the group, enforcing the same
    delegation rules as the single-user PUT /roles/{email} (roles.py:99-114) -
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
        raise HTTPException(status_code=403, detail="Need Administrator or Super Administrator role to manage roles")
    if user["role"] != "owner" and target_level >= requester_level:
        raise HTTPException(status_code=403, detail="You can only grant access up to one level below your own role")

    _guard_group_company(user, db, group.company_id or "")
    scope = auth.company_scope(user, db)
    members = db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id).all()
    updated, skipped = [], []
    now = _ts()

    for m in members:
        email = m.email
        if not auth.person_in_scope(email, scope, db):
            continue    # outside the caller's companies: not theirs to touch, not named back
        if user["role"] != "owner":
            existing_role = _get_role(email, db)
            if ROLE_LEVEL.get(existing_role, 1) >= ROLE_LEVEL["administrator"]:
                skipped.append({"email": email, "reason": "Only a Super Administrator can change another admin's access"})
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
