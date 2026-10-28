"""ONE scoped HR rule (release review, Oct 27 2026).

Who is HR for a person - for the HR-only steps added in the October HR release
(time off's second approval, salary advances, leave Year-End, HR Only custom
fields, Extra Time):

  * the HR contact of the person's company (People > Companies; one email or a
    comma list), or
  * an administrator / owner, or a Full People (`hr`) grant, whose People scope
    (`auth.hr_scope` - the company walls when they are armed, the `hr` scope
    rows otherwise) covers the person's company.

The manager tier's own-team view of People (`auth.hr_team_limited`) is never
HR, and nobody is HR on their own record. `timesheet_review.is_hr` predates
this release and stays as it is; new HR features ask here.
"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from models import HrEntity, NexusEmployee


def _norm(email) -> str:
    return (email or "").strip().lower()


def hr_contacts(db: Session, company_id: str) -> list:
    if not company_id:
        return []
    ent = db.query(HrEntity).filter(HrEntity.id == company_id).first()
    raw = (getattr(ent, "hr_contact_email", "") or "") if ent else ""
    return [e.strip().lower() for e in raw.split(",") if e.strip()]


def _user(db: Session, user_or_email) -> dict:
    import auth
    if isinstance(user_or_email, dict):
        return user_or_email
    email = _norm(user_or_email)
    return {"email": email, "level": auth.level_for(email, db)}


def wide_hr(db: Session, user_or_email) -> bool:
    """Administrator / owner, or a Full People grant - not the manager tier's
    own-team view. (Scope still applies: see is_hr_for / is_hr_for_company.)"""
    import auth
    user = _user(db, user_or_email)
    me = _norm(user.get("email"))
    if not me or user.get("external"):
        return False
    if int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"]:
        return True
    return (not auth.hr_team_limited(user)
            and auth._module_level(me, "hr", db) >= auth._MODULE_LEVEL_RANK["full"])


def _scope(db: Session, user: dict):
    import auth
    return auth.hr_scope(user, db)


def is_hr_for_company(db: Session, user_or_email, company_id: str) -> bool:
    """HR for a company: its HR contact, or wide HR whose scope covers it.
    Company '' (untagged) needs an unrestricted caller."""
    import auth
    user = _user(db, user_or_email)
    me = _norm(user.get("email"))
    if not me or user.get("external"):
        return False
    cid = company_id or ""
    if me in hr_contacts(db, cid):
        return True
    if not wide_hr(db, user):
        return False
    scope = _scope(db, user)
    if auth.is_team_scope(scope):
        return False
    return scope is None or (bool(cid) and cid in scope)


def is_hr_for(db: Session, user_or_email, email: str) -> bool:
    """HR for this person (see the module docstring). Never on your own
    record. A caller checking a long list memoizes per person itself."""
    user = _user(db, user_or_email)
    me, email = _norm(user.get("email")), _norm(email)
    if not me or not email or me == email:
        return False
    emp = (db.query(NexusEmployee)
           .filter(func.lower(NexusEmployee.work_email) == email).first())
    return emp is not None and is_hr_for_company(db, user, emp.company or "")


def hr_anywhere(db: Session, user_or_email) -> bool:
    """Could this caller be HR for anyone - so an HR side is worth showing."""
    user = _user(db, user_or_email)
    me = _norm(user.get("email"))
    if not me:
        return False
    if wide_hr(db, user):
        return True
    return (db.query(HrEntity.id)
            .filter(func.lower(HrEntity.hr_contact_email).contains(me)).first()) is not None
