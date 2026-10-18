"""CA meal / rest premium lines and the meal waiver (Neil, Oct 17 2026) - the
rules live in ca_breaks.py; this file decides who may call what.

  * Premium lines: the manager side (inside their scope, never their own
    card - #635's no-self-decide rule) adds a Meal Premium / Rest Premium to a CA-rule
    employee's worked day, or removes one with a reason (the row stays, with
    who / when / why). Every change goes through timesheet_review.guard_edit
    like any other change to the pay (one side at a time; after approval it
    reopens to the manager; HR's override), and a finalized period is locked.
    These are approval decisions, so they take require_approval_write like
    the timesheet-review routes (#633): a live stand-in may act on the
    delegator's people - exactly those whose time sheet they could approve -
    and the line records "for <delegator>" plus an audit row.
  * The waiver: HR (timesheet_review.is_hr) sends it in Nexus Sign from the
    person's profile and may revoke it; the manager side may read it, and
    the employee reads their own.

Plain `def` routes: FastAPI runs them in a thread.
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import ca_breaks
import models
import timesheet_review as tsr
from auth import get_current_user
from database import get_db
from routers.esign import _client_meta
from routers.timeclock import (_audit_delegated, _decided_note, _guard_not_finalized, _guard_review,
                               _visible_emails, require_approval_write, require_team_read, require_team_write)

router = APIRouter(prefix="/ca-breaks", tags=["CA meal and rest breaks"],
                   dependencies=[Depends(get_current_user)])


def _in_scope(db: Session, user: dict, email: str) -> str:
    em = (email or "").strip().lower()
    if not em:
        raise HTTPException(400, "email is required")
    scope = _visible_emails(db, user)
    if scope is not None and em not in scope:
        raise HTTPException(403, "Outside your team")
    return em


class PremiumIn(BaseModel):
    email: str
    date: str
    kind: str            # meal | rest
    note: str = ""


class RemoveIn(BaseModel):
    reason: str = ""


@router.post("/premiums")
def add_premium(body: PremiumIn, user: dict = Depends(require_approval_write), db: Session = Depends(get_db)):
    em = _in_scope(db, user, body.email)
    me = user["email"].lower()
    if me == em:
        raise HTTPException(403, "You can't add premiums to your own time sheet.")
    day = (body.date or "").strip()[:10]
    try:
        date.fromisoformat(day)
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")
    if not ca_breaks.is_ca(db, em):
        raise HTTPException(409, "Meal and rest premiums are only for hourly staff on the California overtime rule.")
    _guard_not_finalized(db, em, day)
    _guard_review(db, em, day, me)
    p = ca_breaks.add_premium(db, em, day, (body.kind or "").lower(), me, source="manager",
                              note=_decided_note(db, user, em, (body.note or "").strip()))
    if p is None:
        db.rollback()
        raise HTTPException(409, f"That day already has a {'Meal' if body.kind == 'meal' else 'Rest'} Premium.")
    _audit_delegated(db, user, em, f"Added {ca_breaks.KIND_LABEL.get(p.kind, p.kind)}", "time_break_premiums", p.id)
    db.commit()
    return ca_breaks.premium_dict(p)


@router.post("/premiums/{pid}/remove")
def remove_premium(pid: str, body: RemoveIn, user: dict = Depends(require_approval_write),
                   db: Session = Depends(get_db)):
    p = (db.query(models.TimeBreakPremium).filter(models.TimeBreakPremium.id == pid)
         .with_for_update().first())
    if not p:
        raise HTTPException(404, "Premium not found")
    em = _in_scope(db, user, p.employee_email)
    me = user["email"].lower()
    if me == em:
        raise HTTPException(403, "You can't change premiums on your own time sheet.")
    _guard_not_finalized(db, em, p.local_date)
    if len((body.reason or "").strip()) < 3:
        raise HTTPException(422, "Say why this premium is removed.")
    if p.status != "active":
        raise HTTPException(409, "This premium was already removed.")
    _guard_review(db, em, p.local_date, me)
    ca_breaks.remove_premium(p, me, _decided_note(db, user, em, body.reason.strip()))
    _audit_delegated(db, user, em, f"Removed {ca_breaks.KIND_LABEL.get(p.kind, p.kind)}", "time_break_premiums", p.id)
    db.commit()
    return ca_breaks.premium_dict(p)


# ── The meal waiver ───────────────────────────────────────────────────────

class WaiverIn(BaseModel):
    email: str
    note: str = ""


@router.get("/waiver")
def waiver(email: str, user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    em = _in_scope(db, user, email)
    out = ca_breaks.waiver_state(db, em)
    out["canManage"] = tsr.is_hr(db, user["email"], em)
    return out


@router.get("/waiver/mine")
def my_waiver(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    out = ca_breaks.waiver_state(db, user["email"].lower())
    out["canManage"] = False
    return out


@router.post("/waiver/send")
def send_waiver(body: WaiverIn, request: Request, user: dict = Depends(require_team_write),
                db: Session = Depends(get_db)):
    em = _in_scope(db, user, body.email)
    if not tsr.is_hr(db, user["email"], em):
        raise HTTPException(403, "Only HR sends the meal waiver.")
    ip, ua = _client_meta(request)
    ca_breaks.send_waiver(db, em, user["email"], ip=ip, user_agent=ua)
    out = ca_breaks.waiver_state(db, em)
    out["canManage"] = True
    return out


@router.post("/waiver/revoke")
def revoke_waiver(body: WaiverIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    em = _in_scope(db, user, body.email)
    if not tsr.is_hr(db, user["email"], em):
        raise HTTPException(403, "Only HR revokes the meal waiver.")
    ca_breaks.revoke_waiver(db, em, user["email"], body.note)
    out = ca_breaks.waiver_state(db, em)
    out["canManage"] = True
    return out
