"""Row-level access scopes (Roles & Access - external users, Jul 2026).

Admins narrow WHICH records a person can see within a module they already have
access to - mainly to sandbox external/guest users (a client scoped to one
property sees only that property). Enforcement lives in auth.scoped_ids(), which
data endpoints call to get the allowed id set. This router is just the admin CRUD
behind the scope picker on a person's Access tab.

module_id='hr' rows are special: auth.hr_scope() reads them to limit an
INTERNAL admin's People/Time/Leave access to specific companies (scope_type
'entity', Neil Aug 25). Scopes are read live on every request - no cache to
invalidate; adds/removes bite immediately.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
import auth
from auth import require_administrator, require_owner
from models import NexusAccessScope, HrEntity

router = APIRouter(prefix="/access-scopes", tags=["Access Scopes"])

_SCOPE_TYPES = ("property", "project", "entity", "fund")


def _serialize(s: NexusAccessScope) -> dict:
    return {"id": s.id, "email": s.email, "moduleId": s.module_id,
            "scopeType": s.scope_type, "scopeId": s.scope_id}


def _guard_walled(user: dict, db: Session, email: str, scope_type: str = "",
                  module_id: str = "", scope_id: str = "") -> None:
    """The company wall on scope rows (Neil, 11/02/2026). A Super
    Administrator (company_scope None) is never limited. Anyone walled - an
    Administrator, always - may work only on a person inside their companies
    (404 otherwise), never on themself or on another Administrator / Super
    Administrator (403), and never on an `entity` row (403): entity rows
    WIDEN company_scope(), so they are the walls themselves. A scope id that
    names a company, or any id on the `hr` / `company` modules (read as
    company ids by hr_scope), must be one of the caller's companies, and a
    `project` id must be a project of theirs."""
    scope = auth.company_scope(user, db)
    if scope is None and not auth.bound_by_super_rules(user, db):
        return
    email = (email or "").lower()
    if scope is not None:
        auth.assert_person_in_scope(email, user, db)
    if scope_type == "entity":
        raise HTTPException(403, "Only a Super Administrator limits a person to companies")
    if email == (user.get("email") or "").lower():
        raise HTTPException(403, "You can't change your own access limits")
    if auth.level_for(email, db) >= auth._LEVELS["administrator"]:
        raise HTTPException(403, "Only a Super Administrator changes an Administrator's access limits")
    sid = (scope_id or "").strip()
    if not sid or scope is None:   # walls off: any company's ids
        return
    names_company = db.query(HrEntity.id).filter(HrEntity.id == sid).first() is not None
    if (names_company or module_id in ("hr", "company")) and sid not in scope:
        raise HTTPException(404, "Not found")
    if scope_type == "project":
        from models import TaskProject
        from routers.task_util import row_company
        proj = db.query(TaskProject).filter(TaskProject.id == sid).first()
        if not proj or not auth.company_ok(row_company(db, proj), scope):
            raise HTTPException(404, "Not found")


@router.get("/{email}")
def list_scopes(email: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    auth.assert_person_in_scope(email.lower(), user, db)
    rows = (db.query(NexusAccessScope)
            .filter(NexusAccessScope.email == email.lower())
            .order_by(NexusAccessScope.module_id, NexusAccessScope.scope_type).all())
    return [_serialize(s) for s in rows]


class ScopeIn(BaseModel):
    module_id:  str
    scope_type: str
    scope_id:   str


@router.post("/{email}", status_code=201)
def add_scope(email: str, body: ScopeIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    email = email.lower()
    if not body.module_id.strip() or not body.scope_id.strip():
        raise HTTPException(400, "module_id and scope_id are required")
    if body.scope_type not in _SCOPE_TYPES:
        raise HTTPException(400, f"scope_type must be one of {_SCOPE_TYPES}")
    _guard_walled(user, db, email, body.scope_type, body.module_id.strip(), body.scope_id)
    # Idempotent: don't stack duplicate (module, scope) rows for the same person.
    existing = (db.query(NexusAccessScope)
                .filter(NexusAccessScope.email == email,
                        NexusAccessScope.module_id == body.module_id.strip(),
                        NexusAccessScope.scope_id == body.scope_id.strip()).first())
    if not existing:
        db.add(NexusAccessScope(
            id=str(uuid.uuid4()), email=email, module_id=body.module_id.strip(),
            scope_type=body.scope_type, scope_id=body.scope_id.strip(),
            created_by=user["email"], created_at=datetime.now(timezone.utc).isoformat()))
        db.commit()
    rows = db.query(NexusAccessScope).filter(NexusAccessScope.email == email).all()
    return [_serialize(s) for s in rows]


@router.delete("/{email}/{scope_id}")
def remove_scope(email: str, scope_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    row = (db.query(NexusAccessScope)
           .filter(NexusAccessScope.id == scope_id,
                   NexusAccessScope.email == email.lower()).first())
    auth.assert_person_in_scope(email.lower(), user, db)
    if row:
        # Removing a limit WIDENS what the person sees, so it passes the same
        # wall as adding one (an entity row is a Super Administrator's alone).
        _guard_walled(user, db, email, row.scope_type, row.module_id, row.scope_id)
        db.delete(row); db.commit()
    rows = db.query(NexusAccessScope).filter(NexusAccessScope.email == email.lower()).all()
    return [_serialize(s) for s in rows]


# ── Multi-company walls: the master arm switch (Aug 2026) ─────────────────────
# Two-segment path so it doesn't collide with the /{email} routes above.
class WallsIn(BaseModel):
    on: bool


@router.get("/config/walls")
def get_walls(user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    from models import NexusSetting, NexusGroup, NexusGroupMember
    row = db.query(NexusSetting).filter(NexusSetting.key == "company_walls").first()
    on = bool(row and (row.value or "").strip().lower() in ("on", "1", "true", "yes"))
    ga_ids = [g.id for g in db.query(NexusGroup.id).filter(NexusGroup.is_global_admin == 1).all()]
    ga_members = (db.query(NexusGroupMember).filter(NexusGroupMember.group_id.in_(ga_ids)).count()
                  if ga_ids else 0)
    return {"on": on, "globalAdminGroups": len(ga_ids), "globalAdmins": ga_members}


@router.put("/config/walls")
def set_walls(body: WallsIn, user: dict = Depends(require_owner), db: Session = Depends(get_db)):
    """Arm or disarm the company walls - a Super Administrator's switch only
    (Neil, 11/02/2026: an Administrator is walled, and the walled never move
    the wall). Refuses to arm if it would lock the caller out (walls on + a
    Global Admins group exists that they are not in). Writes an audit row and
    invalidates the cached flag so it bites immediately."""
    import cache
    import auth
    from models import NexusSetting, AuditLog
    if body.on and not auth.is_global_admin(user, db):
        raise HTTPException(400, "You would be locked out - add yourself to a "
                                 "Super Administrators group before arming the walls.")
    now = datetime.now(timezone.utc).isoformat()
    row = db.query(NexusSetting).filter(NexusSetting.key == "company_walls").first()
    if not row:
        row = NexusSetting(key="company_walls"); db.add(row)
    row.value = "on" if body.on else ""
    row.updated_by = user["email"]
    row.updated_at = now
    db.add(AuditLog(timestamp=now, user_email=user["email"], user_role=user.get("role", ""),
                    action="company_walls_" + ("armed" if body.on else "disarmed"),
                    resource_type="tenancy", resource_id="company_walls"))
    db.commit()
    cache.settings_config.invalidate()
    return {"on": bool(body.on)}
