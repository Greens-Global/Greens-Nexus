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


class ApprovePeriodIn(BaseModel):
    email: str
    start: str = ""      # any date in the period
    note: str = ""


def _review(db: Session, rid: str) -> TimesheetReview:
    r = db.query(TimesheetReview).filter(TimesheetReview.id == rid).first()
    if not r:
        raise HTTPException(404, "Timesheet review not found")
    return r


def _reviewer_of(db: Session, user: dict, employee_email: str, manager_email: str = "") -> str:
    """The manager side: the employee's reviewer, or anyone whose team scope
    covers them (HR). Never the employee on their own timesheet."""
    me = (user.get("email") or "").lower()
    employee_email = (employee_email or "").lower()
    if me == employee_email:
        raise HTTPException(403, "You can't review your own timesheet.")
    scope = _visible_emails(db, user)
    if me != (manager_email or "").lower() and scope is not None and employee_email not in scope:
        raise HTTPException(404, "Timesheet review not found")
    return me


def _as_reviewer(db: Session, user: dict, r: TimesheetReview) -> str:
    return _reviewer_of(db, user, r.employee_email, r.manager_email)


@router.get("/waiting")
def waiting(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Timesheets submitted to the caller for review - the list at the top of
    People > Time (Sep 29). Empty for anyone nobody reports to."""
    me = (user.get("email") or "").lower()
    # Oct 16: plus the closed periods of the caller's people that nobody has
    # submitted - the manager reviews first.
    return {"reviews": [tsr.queue_row(db, r) for r in tsr.waiting_on(db, me)] + tsr.not_reviewed(db, me),
            # ...and the agreed timesheets waiting on the caller's SIGNATURE
            # (manager or HR turn), signed in place from the same card (Oct 16).
            "toSign": tsr.to_sign(db, me)}


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


@router.post("/{rid}/approve")
def approve(rid: str, body: NoteIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    """The manager's Review & Approve (Oct 16) - no signature, a logged click."""
    r = _review(db, rid)
    me = _as_reviewer(db, user, r)
    tsr.approve(db, r, me, body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/approve")
def approve_period(body: ApprovePeriodIn, user: dict = Depends(require_team_write),
                   db: Session = Depends(get_db)):
    """Review & Approve a period the employee has not submitted (Oct 16)."""
    email = (body.email or "").strip().lower()
    me = _reviewer_of(db, user, email, tsr.manager_of(db, email))
    r = tsr.approve_period(db, email, (body.start or "").strip(), me, body.note)
    return tsr.state_for(db, r.employee_email, r.period_start, me, True)


@router.post("/{rid}/sign")
def employee_sign(rid: str, request: Request, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """The employee's Approve & Sign: sends the envelope with them as the
    only signer and answers with their party, so the signing screen opens."""
    r = _review(db, rid)
    me = (user.get("email") or "").lower()
    if me != r.employee_email:
        raise HTTPException(404, "Timesheet review not found")
    ip, ua = _client_meta(request)
    tsr.employee_approve(db, r, me, ip=ip, user_agent=ua)
    return tsr.state_for(db, r.employee_email, r.period_start, me, False)
