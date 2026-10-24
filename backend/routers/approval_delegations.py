"""Delegate My Approvals (Neil, Oct 17 2026) - the endpoints. The routing
rules live in approval_delegation.py; this file decides who may set what.

  GET  /approval-delegations/mine        my delegations + the ones naming me
  GET  /approval-delegations/options     who may cover me (up or across) and
                                         the days I am off (?delegator_email= HR)
  POST /approval-delegations/mine        name a stand-in for a date range
  POST /approval-delegations/{id}/revoke the delegator, whoever set it, or HR
  GET  /approval-delegations             HR / admin: everyone's (company-scoped)
  POST /approval-delegations             HR / admin: set one for someone
"""
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import approval_delegation as ad
from auth import get_current_user
from database import get_db
from models import ApprovalDelegation

router = APIRouter(prefix="/approval-delegations", tags=["Approval delegation"],
                   dependencies=[Depends(get_current_user)])


class DelegationIn(BaseModel):
    delegate_email: str
    start_date: str
    end_date: str
    note: Optional[str] = ""
    delegator_email: Optional[str] = ""     # HR / admin only: whose approvals


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hr_admin_scope(user: dict, db: Session):
    """(is HR admin, company scope). HR admin = an administrator or a Full HR
    grant (timesheet_review.is_hr's bar). The manager tier never is - its
    People scope is its own team. scope None = every company."""
    from auth import _LEVELS, _MODULE_LEVEL_RANK, _module_level, hr_scope, is_team_scope
    email = (user.get("email") or "").lower()
    if not (user.get("level", 0) >= _LEVELS["administrator"]
            or _module_level(email, "hr", db) >= _MODULE_LEVEL_RANK["full"]):
        return False, set()
    scope = hr_scope(user, db)
    if is_team_scope(scope):
        return False, set()
    return True, scope


def _in_admin_scope(db: Session, scope, email: str) -> bool:
    return scope is None or ad._company(db, email) in scope


def _tell_delegate(db: Session, d: ApprovalDelegation, actor: str, revoked: bool = False) -> None:
    """One bell to the stand-in when they are named, and when it is revoked -
    ONE notice per stand-in, delegator and day, rewritten in place, so a
    repeated create / revoke does not stack bells. When the stand-in ends it
    themselves, the delegator hears instead."""
    from notify_company import notification_company
    from notify_rollup import upsert_rollup
    from routers.timeclock import _us_span
    span = _us_span(d.start_date, d.end_date)
    day = datetime.now(timezone.utc).date().isoformat()
    if revoked and actor == d.delegate_email:
        upsert_rollup(db, recipient=d.delegator_email, key=f"deleg-end:{d.delegate_email}:{day}",
                      title="Approval Cover Ended",
                      line=f"{ad.display_name(db, d.delegate_email)} no longer covers your approvals ({span}). "
                           "Pick someone else if you still need cover.",
                      company=notification_company(db, d.delegator_email), requested_by=actor, replace=True)
        return
    if d.delegate_email == actor:
        return
    who = ad.display_name(db, d.delegator_email)
    key = f"deleg:{d.delegator_email}:{day}"
    company = notification_company(db, d.delegate_email)
    if revoked:
        upsert_rollup(db, recipient=d.delegate_email, key=key, title="Approval Cover Canceled",
                      line=f"You no longer cover {who}'s approvals ({span}).",
                      company=company, requested_by=actor, replace=True)
        return
    upsert_rollup(db, recipient=d.delegate_email, key=key, title="You Are Covering Approvals",
                  line=f"{who} asked you to cover their approvals {span} - their time sheets, punch fixes and time "
                       f"off come to you too, marked \"For {who}\"." + (f' "{d.note[:200]}"' if d.note else ""),
                  action={"view": "hr", "sub": "hr-time"}, company=company, requested_by=actor,
                  replace=True)


def _create(db: Session, delegator: str, body: DelegationIn, actor: str) -> dict:
    s, e = ad.check_new(db, delegator, body.delegate_email, body.start_date, body.end_date)
    d = ApprovalDelegation(id=str(uuid.uuid4()), delegator_email=delegator,
                           delegate_email=(body.delegate_email or "").strip().lower(),
                           start_date=s, end_date=e, note=(body.note or "").strip()[:400],
                           created_by=actor, created_at=_now(), revoked_at="", revoked_by="")
    db.add(d)
    _tell_delegate(db, d, actor)
    db.commit()
    return ad.serialize(db, d)


def _current(db: Session, q):
    """Not revoked and not over (on the delegator's calendar), soonest first."""
    rows = [d for d in q.filter(ApprovalDelegation.revoked_at == "").all()
            if (d.end_date or "") >= ad._today_for(db, d.delegator_email)]
    return sorted(rows, key=lambda d: (d.start_date or "", d.delegator_email))


@router.get("/mine")
def mine(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").lower()
    given = _current(db, db.query(ApprovalDelegation).filter(ApprovalDelegation.delegator_email == me))
    covering = _current(db, db.query(ApprovalDelegation).filter(ApprovalDelegation.delegate_email == me))
    org = ad._org(db)
    return {"canDelegate": ad.can_delegate(db, me),
            "delegations": [ad.serialize(db, d, org=org) for d in given],
            "covering": [ad.serialize(db, d, org=org) for d in covering]}


@router.get("/options")
def options(delegator_email: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The form's choices (Neil, Oct 20): the people who may cover - up the
    reporting line or across, never down - and the delegator's upcoming
    approved time off and holidays, the only days a delegation may cover.
    A delegator other than me is HR / admin only."""
    me = (user.get("email") or "").lower()
    who = (delegator_email or "").strip().lower() or me
    if who != me:
        admin, scope = _hr_admin_scope(user, db)
        if not admin:
            raise HTTPException(403, "Only HR can see someone else's delegation options.")
        if not _in_admin_scope(db, scope, who):
            raise HTTPException(403, "That person is outside the companies you manage.")
    elif not ad.can_delegate(db, me):
        return {"delegates": [], "offRanges": []}
    return {"delegates": ad.eligible_delegates(db, who), "offRanges": ad.off_ranges(db, who)}


@router.post("/mine")
def create_mine(body: DelegationIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").lower()
    if (body.delegator_email or "").strip().lower() not in ("", me):
        raise HTTPException(403, "You can only delegate your own approvals here.")
    return _create(db, me, body, me)


@router.post("/{did}/revoke")
def revoke(did: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    me = (user.get("email") or "").lower()
    d = db.query(ApprovalDelegation).filter(ApprovalDelegation.id == did).with_for_update().first()
    if not d:
        raise HTTPException(404, "Delegation not found")
    admin, scope = _hr_admin_scope(user, db)
    # The delegator, whoever set it, HR - or the stand-in declining / ending it.
    if (me not in (d.delegator_email, d.created_by, d.delegate_email)
            and not (admin and _in_admin_scope(db, scope, d.delegator_email))):
        raise HTTPException(404, "Delegation not found")
    if d.revoked_at:
        return ad.serialize(db, d)
    d.revoked_at, d.revoked_by = _now(), me
    _tell_delegate(db, d, me, revoked=True)
    db.commit()
    return ad.serialize(db, d)


@router.get("")
def list_all(include_past: bool = False, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR / admin: every delegation in their companies - current and upcoming,
    plus (include_past) the revoked and ended ones as the record."""
    admin, scope = _hr_admin_scope(user, db)
    if not admin:
        raise HTTPException(403, "Only HR can see everyone's delegations.")
    q = db.query(ApprovalDelegation)
    if include_past:
        rows = sorted(q.all(), key=lambda d: (d.start_date or "", d.delegator_email), reverse=True)
    else:
        rows = _current(db, q)
    # Company scope first, THEN the cap - another company's rows must not use it up.
    rows = [d for d in rows if _in_admin_scope(db, scope, d.delegator_email)][:500]
    org = ad._org(db)
    return [ad.serialize(db, d, org=org) for d in rows]


@router.post("")
def create_for(body: DelegationIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """HR / admin sets a delegation for someone (they are out unexpectedly)."""
    admin, scope = _hr_admin_scope(user, db)
    if not admin:
        raise HTTPException(403, "Only HR can set delegations for someone else.")
    me = (user.get("email") or "").lower()
    delegator = (body.delegator_email or "").strip().lower() or me
    if delegator != me:
        from models import NexusEmployee
        from sqlalchemy import func
        emp = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == delegator).first()
        if not emp:
            raise HTTPException(422, "Pick whose approvals these are from the Nexus People list.")
        if (emp.status or "active") not in ("active", "onboarding"):
            raise HTTPException(422, f"{ad.display_name(db, delegator)} is no longer active, so there are no "
                                     "approvals of theirs to cover.")
        if not _in_admin_scope(db, scope, delegator):
            raise HTTPException(403, "That person is outside the companies you manage.")
    if not _in_admin_scope(db, scope, (body.delegate_email or "").strip().lower()):
        raise HTTPException(403, "The person covering is outside the companies you manage.")
    return _create(db, delegator, body, me)
