"""Timesheet review endpoints (Sep 2026) - the hand-offs between an employee
and their manager before a timesheet is signed in Nexus Sign. The rules live
in timesheet_review.py; this file only decides who may call what.

Signing itself happens in Nexus Sign (/esign/mine/{party_id}/...), which calls
back into timesheet_review when a party signs, declines, or completes it.
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

import timesheet_review as tsr
from auth import get_current_user
from database import get_db
from models import TimesheetReview
from routers.esign import _client_meta
from routers.timeclock import _visible_emails, require_team_write

router = APIRouter(prefix="/timesheet-review", tags=["Timesheet review"],
                   dependencies=[Depends(get_current_user)])


class SubmitIn(BaseModel):
    start: str = ""      # any date in the period; omit for the current one
    note: str = ""


class NoteIn(BaseModel):
    note: str = ""


def _review(db: Session, rid: str) -> TimesheetReview:
    r = db.query(TimesheetReview).filter(TimesheetReview.id == rid).first()
    if not r:
        raise HTTPException(404, "Timesheet review not found")
    return r


def _as_reviewer(db: Session, user: dict, r: TimesheetReview) -> str:
    """The manager side: the employee's reviewer, or anyone whose team scope
    covers them (HR). Never the employee on their own timesheet."""
    me = (user.get("email") or "").lower()
    if me == r.employee_email:
        raise HTTPException(403, "You can't review your own timesheet.")
    scope = _visible_emails(db, user)
    if me != r.manager_email and scope is not None and r.employee_email not in scope:
        raise HTTPException(404, "Timesheet review not found")
    return me


@router.post("/submit")
def submit(body: SubmitIn, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = tsr.submit(db, user["email"], (body.start or "").strip(), body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, user["email"], False)


@router.post("/{rid}/send-back")
def send_back(rid: str, body: NoteIn, user: dict = Depends(require_team_write),
              db: Session = Depends(get_db)):
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    tsr.send_back(db, r, me, body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/{rid}/agree")
def agree(rid: str, body: NoteIn, request: Request, user: dict = Depends(require_team_write),
          db: Session = Depends(get_db)):
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    ip, ua = _client_meta(request)
    tsr.agree(db, r, me, body.note, ip=ip, user_agent=ua)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)
