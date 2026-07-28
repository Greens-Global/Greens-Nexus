"""Roles & Access redesign (Jul 2026) — Job Roles.

A Job Role is a reusable template driven by a person's job description. It is
stored as an Access Group (nexus_groups) flagged is_job_role=1 that ALSO carries
a seniority tier + a plain-language description. Assigning a job role to a person:

  * makes them the single member-of-one job-role group (their primary role) —
    reassigning removes them from any other job-role group, and
  * sets their tier (nexus_roles.role) from the job role's tier.

Module access still flows through ordinary group membership, so the resolver
(auth._module_level / _role_for) is UNCHANGED. Plain groups (is_job_role=0) stay
the additive layer on top. Effective access = union of the job-role bundle + all
additional groups, exactly as today.

Tier guardrails mirror roles.py / groups.assign_group_role: only IT/Global Admins
can assign, only below their own level (unless owner), and a non-owner can't
reassign someone who is already an admin.
"""
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database import get_db
from models import NexusGroup, NexusGroupMember, NexusRole, NexusEmployee
from auth import get_current_user, require_administrator, invalidate_role_cache, _MODULE_LEVEL_RANK
from routers.roles import VALID_ROLES, ROLE_LEVEL, _get_role
from routers.groups import ModuleGrant, _parse_modules, _modules_csv

router = APIRouter(prefix="/jobroles", tags=["jobroles"])


def _ts() -> str:
    return datetime.utcnow().isoformat()


# Starter job-role templates so the screen opens with a usable reference matrix
# instead of a blank grid (mirrors groups._seed_if_empty). Module ids match
# RoleContext MODULES; levels ∈ viewer/editor/full/owner.
STARTER_ROLES = [
    ("Crew Member", "employee", "Front-line site worker. Clocks in, works their own tasks, sees their own HR.",
     "dashboard:viewer,tasks:editor,myhr:viewer,timeclock:editor,sop:viewer"),
    ("Site Supervisor", "supervisor", "Runs day-to-day site operations, equipment and their crew.",
     "dashboard:viewer,tasks:editor,myhr:viewer,timeclock:full,hr:viewer,inventory:editor,property-asset:viewer,documents:viewer,sop:editor,manager-dashboard:viewer"),
    ("Project Manager", "manager", "Owns construction projects end to end, including budgets and vendors.",
     "dashboard:viewer,tasks:full,manager-dashboard:viewer,hr:viewer,inventory:editor,property-asset:editor,ops:full,operations:editor,development:editor,documents:editor,timeclock:full,sop:editor,accounting:viewer"),
    ("Accountant", "supervisor", "Manages transactions, invoices and vendors day to day.",
     "dashboard:viewer,tasks:editor,accounting:full,investor-relations:viewer,documents:editor,myhr:viewer,sop:viewer"),
    ("HR Manager", "manager", "Owns the people lifecycle, time & attendance, and payroll data.",
     "dashboard:viewer,hr:full,myhr:viewer,timeclock:full,documents:full,manager-dashboard:viewer,tasks:editor,sop:editor"),
    ("Marketing Lead", "supervisor", "Runs campaigns, ads and online reputation.",
     "dashboard:viewer,marketing:full,tasks:editor,documents:viewer,sop:viewer"),
]


def _seed_if_empty(db: Session):
    if db.query(NexusGroup).filter(NexusGroup.is_job_role == 1).count() > 0:  # noqa: E712
        return
    now = _ts()
    stamp = now[:10].replace("-", "")
    for i, (name, tier, desc, mods) in enumerate(STARTER_ROLES):
        db.add(NexusGroup(id=f"JR{stamp}seed{i:02d}", name=name, is_job_role=1,
                          tier=tier, description=desc, allowed_modules=mods,
                          created_by="system", created_at=now))
    db.commit()


def _member_emails(db: Session, group_id: str) -> list[str]:
    return [m.email for m in db.query(NexusGroupMember).filter(NexusGroupMember.group_id == group_id).all()]


def _serialize(jr: NexusGroup, db: Session) -> dict:
    members = _member_emails(db, jr.id)
    return {
        "id": jr.id,
        "name": jr.name,
        "tier": (jr.tier or "employee"),
        "description": jr.description or "",
        "allowed_modules": _parse_modules(jr.allowed_modules or ""),
        "member_count": len(members),
        "members": members,
        "monitoring_exempt": bool(getattr(jr, "monitoring_exempt", False)),
        "default_manager_email": (getattr(jr, "default_manager_email", "") or ""),
        "created_by": jr.created_by,
        "created_at": jr.created_at,
    }


# ── Schemas ──────────────────────────────────────────────────────────────────

class JobRoleBody(BaseModel):
    name: str
    tier: str = "employee"
    description: Optional[str] = ""
    allowed_modules: Optional[list[ModuleGrant]] = []
    monitoring_exempt: Optional[bool] = False
    default_manager_email: Optional[str] = ""

class JobRoleUpdate(BaseModel):
    name: Optional[str] = None
    tier: Optional[str] = None
    description: Optional[str] = None
    allowed_modules: Optional[list[ModuleGrant]] = None
    monitoring_exempt: Optional[bool] = None
    default_manager_email: Optional[str] = None

class AssignBody(BaseModel):
    email: str

class ApplyManagerBody(BaseModel):
    manager_email: str


def _clean_tier(tier: str) -> str:
    t = (tier or "employee").lower().strip()
    return t if t in VALID_ROLES else "employee"


def _guard_can_assign_tier(user: dict, tier: str):
    """Same delegation rules as roles.PUT/{email}: need admin+, and (unless owner)
    can only grant a tier strictly below your own. Top tiers stay a deliberate act."""
    if user["level"] < ROLE_LEVEL["administrator"]:
        raise HTTPException(status_code=403, detail="Need IT Admin or Global Admin role to assign job roles")
    if user["role"] != "owner" and ROLE_LEVEL.get(tier, 1) >= user["level"]:
        raise HTTPException(status_code=403, detail="You can only assign roles below your own level")


# ── Routes ───────────────────────────────────────────────────────────────────

@router.get("")
def list_job_roles(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    _seed_if_empty(db)
    roles = db.query(NexusGroup).filter(NexusGroup.is_job_role == 1).order_by(NexusGroup.name).all()  # noqa: E712
    return [_serialize(r, db) for r in roles]


@router.post("")
def create_job_role(body: JobRoleBody, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Job role name is required")
    tier = _clean_tier(body.tier)
    _guard_can_assign_tier(user, tier)  # can't create a role whose tier you couldn't grant

    now = _ts()
    jr = NexusGroup(
        id=f"JR{now.replace('-', '').replace(':', '').replace('.', '')[:17]}",
        name=name,
        is_job_role=1,
        tier=tier,
        description=(body.description or "").strip(),
        allowed_modules=_modules_csv(body.allowed_modules),
        monitoring_exempt=1 if body.monitoring_exempt else 0,
        default_manager_email=(body.default_manager_email or "").lower().strip(),
        created_by=user["email"],
        created_at=now,
    )
    db.add(jr)
    db.commit()
    return _serialize(jr, db)


@router.put("/{jr_id}")
def update_job_role(jr_id: str, body: JobRoleUpdate, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    jr = db.query(NexusGroup).filter(NexusGroup.id == jr_id, NexusGroup.is_job_role == 1).first()  # noqa: E712
    if not jr:
        raise HTTPException(status_code=404, detail="Job role not found")

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Job role name is required")
        jr.name = name
    if body.description is not None:
        jr.description = body.description.strip()
    if body.allowed_modules is not None:
        jr.allowed_modules = _modules_csv(body.allowed_modules)
    if body.monitoring_exempt is not None:
        jr.monitoring_exempt = 1 if body.monitoring_exempt else 0
    if body.default_manager_email is not None:
        jr.default_manager_email = body.default_manager_email.lower().strip()

    tier_changed = False
    if body.tier is not None:
        new_tier = _clean_tier(body.tier)
        _guard_can_assign_tier(user, new_tier)
        tier_changed = new_tier != (jr.tier or "employee")
        jr.tier = new_tier

    db.flush()

    # Editing a job-role template is a live reference: if the tier changed, every
    # current holder's tier moves with it (module edits already propagate because
    # access reads the group's allowed_modules live).
    if tier_changed:
        for email in _member_emails(db, jr.id):
            row = db.query(NexusRole).filter(NexusRole.email == email).first()
            if row:
                row.role = jr.tier
            else:
                db.add(NexusRole(email=email, role=jr.tier, assigned_by=user["email"]))
            invalidate_role_cache(email)

    db.commit()
    return _serialize(jr, db)


@router.delete("/{jr_id}")
def delete_job_role(jr_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    jr = db.query(NexusGroup).filter(NexusGroup.id == jr_id, NexusGroup.is_job_role == 1).first()  # noqa: E712
    if not jr:
        raise HTTPException(status_code=404, detail="Job role not found")
    members = _member_emails(db, jr_id)
    if members:
        raise HTTPException(status_code=409, detail=f"Reassign {len(members)} people off this job role before deleting it")
    db.delete(jr)
    db.commit()
    return {"deleted": jr_id}


@router.post("/{jr_id}/assign")
def assign_job_role(jr_id: str, body: AssignBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Set a person's primary job role: enforce single-membership across job-role
    groups, add them to this one, and set their tier from the role."""
    jr = db.query(NexusGroup).filter(NexusGroup.id == jr_id, NexusGroup.is_job_role == 1).first()  # noqa: E712
    if not jr:
        raise HTTPException(status_code=404, detail="Job role not found")

    email = body.email.lower().strip()
    if not email:
        raise HTTPException(status_code=400, detail="Email is required")
    tier = _clean_tier(jr.tier or "employee")
    _guard_can_assign_tier(user, tier)
    # A non-owner cannot reassign someone who is already an admin/owner.
    if user["role"] != "owner" and ROLE_LEVEL.get(_get_role(email, db), 1) >= ROLE_LEVEL["administrator"]:
        raise HTTPException(status_code=403, detail="Only a Global Admin can change another admin's access")

    now = _ts()
    # single primary: drop membership in every OTHER job-role group
    other_ids = [g.id for g in db.query(NexusGroup.id).filter(
        NexusGroup.is_job_role == 1, NexusGroup.id != jr_id).all()]  # noqa: E712
    if other_ids:
        db.query(NexusGroupMember).filter(
            NexusGroupMember.email == email,
            NexusGroupMember.group_id.in_(other_ids),
        ).delete(synchronize_session=False)

    if not db.query(NexusGroupMember).filter(
        NexusGroupMember.group_id == jr_id, NexusGroupMember.email == email).first():
        db.add(NexusGroupMember(group_id=jr_id, email=email, added_by=user["email"], added_at=now))

    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
    # The job role IS the person's title now (Visesh, Jul 28): the card header
    # showed a stale M365-imported title ("Construction Associate") while the
    # role said "Marketing Lead". Overwrite deliberately — the M365 sync only
    # backfills an EMPTY job_title, so this assignment survives future syncs;
    # "Push to M365" carries it back to Entra when wanted.
    if emp and (jr.name or "").strip():
        emp.job_title = jr.name.strip()

    # Role's default manager/approver: copy onto the person's card ONLY if they
    # have no manager yet — per-person Manager stays the source of truth, so an
    # existing (deliberate) assignment is never clobbered by a role change.
    default_mgr = (getattr(jr, "default_manager_email", "") or "").strip()
    if default_mgr and default_mgr != email:
        if emp and not (emp.manager_email or "").strip():
            emp.manager_email = default_mgr

    row = db.query(NexusRole).filter(NexusRole.email == email).first()
    if row:
        row.role = tier
        row.assigned_by = user["email"]
    else:
        db.add(NexusRole(email=email, role=tier, assigned_by=user["email"]))
    invalidate_role_cache(email)

    db.commit()
    return {"assigned": email, "job_role": jr.name, "tier": tier}


@router.post("/{jr_id}/unassign")
def unassign_job_role(jr_id: str, body: AssignBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Remove a person from a job role. Since a job role is their single primary
    role, this also resets their tier to employee (a lingering tier would keep
    them over-privileged). Their additive groups are untouched."""
    jr = db.query(NexusGroup).filter(NexusGroup.id == jr_id, NexusGroup.is_job_role == 1).first()  # noqa: E712
    if not jr:
        raise HTTPException(status_code=404, detail="Job role not found")
    email = body.email.lower().strip()
    _guard_can_assign_tier(user, _clean_tier(jr.tier or "employee"))
    if user["role"] != "owner" and ROLE_LEVEL.get(_get_role(email, db), 1) >= ROLE_LEVEL["administrator"]:
        raise HTTPException(status_code=403, detail="Only a Global Admin can change another admin's access")

    db.query(NexusGroupMember).filter(
        NexusGroupMember.group_id == jr_id, NexusGroupMember.email == email).delete(synchronize_session=False)
    row = db.query(NexusRole).filter(NexusRole.email == email).first()
    if row:
        row.role = "employee"
        row.assigned_by = user["email"]
    invalidate_role_cache(email)
    db.commit()
    return {"unassigned": email}


@router.post("/{jr_id}/apply-manager")
def apply_role_manager(jr_id: str, body: ApplyManagerBody,
                       user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Bulk backfill: set `manager_email` (the timesheet approver) on EVERY current
    member of this job role — the "ten people in one click" path. Overwrites
    existing managers by design (that's what a backfill is for); individual cards
    can still be changed afterwards, per-person Manager remains the truth."""
    jr = db.query(NexusGroup).filter(NexusGroup.id == jr_id, NexusGroup.is_job_role == 1).first()  # noqa: E712
    if not jr:
        raise HTTPException(status_code=404, detail="Job role not found")
    mgr = (body.manager_email or "").lower().strip()
    if not mgr:
        raise HTTPException(status_code=400, detail="Manager email is required")
    if not db.query(NexusEmployee).filter(NexusEmployee.work_email == mgr).first():
        raise HTTPException(status_code=400, detail="That manager isn't in the People directory")
    changed = 0
    for email in _member_emails(db, jr_id):
        if email == mgr:
            continue    # a person can't be their own approver
        emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == email).first()
        if emp and (emp.manager_email or "").lower().strip() != mgr:
            emp.manager_email = mgr
            changed += 1
    db.commit()
    return {"roleId": jr_id, "manager": mgr, "updated": changed}


@router.get("/effective/{email}")
def effective_access(email: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Resolve a person's effective access for the on-card Access tab: their tier,
    primary job role, additional groups, and the winning per-module level with
    provenance (via the job role vs. added manually via a group)."""
    email = email.lower().strip()
    groups = (
        db.query(NexusGroup)
        .join(NexusGroupMember, NexusGroupMember.group_id == NexusGroup.id)
        .filter(NexusGroupMember.email == email)
        .all()
    )
    job_role = None
    extra_groups = []
    modules: dict[str, dict] = {}
    for g in groups:
        is_role = bool(g.is_job_role)
        if is_role:
            job_role = {"id": g.id, "name": g.name, "tier": (g.tier or "employee"), "description": g.description or ""}
        else:
            extra_groups.append({"id": g.id, "name": g.name})
        for grant in _parse_modules(g.allowed_modules or ""):
            rank = _MODULE_LEVEL_RANK.get(grant["level"], 1)
            cur = modules.get(grant["id"])
            if not cur or rank > cur["rank"]:
                modules[grant["id"]] = {"level": grant["level"], "rank": rank, "source": g.name, "via_role": is_role}

    resolved = [
        {"module": mid, "level": m["level"], "source": m["source"], "manual": not m["via_role"]}
        for mid, m in sorted(modules.items())
    ]
    return {
        "email": email,
        "tier": _get_role(email, db),
        "job_role": job_role,
        "extra_groups": extra_groups,
        "modules": resolved,
    }
