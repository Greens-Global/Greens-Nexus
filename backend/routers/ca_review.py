"""California Review routes (Neil, Oct 18 2026) - see ca_review.py.

HR only: the team audience (require_team_read) minus the manager tier
(timeclock._pay_hidden - managers never see it), behind the same fresh
step-up as Payroll Readiness because the minimum-wage flag names a pay rate,
inside the caller's own scope (_visible_emails). Resolving / reopening and
the minimum-wage setting need the team-write audience, still HR only.

Plain `def` routes: FastAPI runs them in a thread, so the per-person
timecard loop never blocks the event loop.
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import ca_review
from database import get_db
from routers.stepup import require_stepup
from routers.timeclock import _pay_hidden, _visible_emails, require_team_read, require_team_write

router = APIRouter(prefix="/ca-review", tags=["california-review"])


def _hr_only(db: Session, user: dict) -> None:
    if _pay_hidden(db, user):
        raise HTTPException(403, "The California Review is for HR.")


def _check_date(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    try:
        return date.fromisoformat(v).isoformat()
    except ValueError:
        raise HTTPException(400, "start must be a date (YYYY-MM-DD)")


def _in_scope(db: Session, user: dict, email: str) -> str:
    em = (email or "").strip().lower()
    if not em:
        raise HTTPException(400, "email is required")
    scope = _visible_emails(db, user)
    if scope is not None and em not in scope:
        raise HTTPException(403, "Outside your team")
    return em


@router.get("/report")
def report(start: str = "", user: dict = Depends(require_team_read), _su: dict = Depends(require_stepup),
           db: Session = Depends(get_db)):
    _hr_only(db, user)
    return ca_review.build(db, _visible_emails(db, user), _check_date(start))


class FlagIn(BaseModel):
    email: str
    periodStart: str
    key: str
    note: str = ""


@router.post("/resolve")
def resolve(body: FlagIn, user: dict = Depends(require_team_write), _su: dict = Depends(require_stepup),
            db: Session = Depends(get_db)):
    _hr_only(db, user)
    em = _in_scope(db, user, body.email)
    return ca_review.resolve(db, em, _check_date(body.periodStart), body.key, body.note, user["email"])


@router.post("/reopen")
def reopen(body: FlagIn, user: dict = Depends(require_team_write), _su: dict = Depends(require_stepup),
           db: Session = Depends(get_db)):
    _hr_only(db, user)
    em = _in_scope(db, user, body.email)
    return ca_review.reopen(db, em, _check_date(body.periodStart), body.key, user["email"])


class SettingsIn(BaseModel):
    minWage: float


@router.get("/settings")
def get_settings(user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    _hr_only(db, user)
    return {**ca_review.get_settings(db), "defaults": dict(ca_review.DEFAULTS)}


@router.put("/settings")
def put_settings(body: SettingsIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    _hr_only(db, user)
    from auth import _LEVELS
    if int(user.get("level", 0)) < _LEVELS["administrator"]:
        from auth import _module_level, _MODULE_LEVEL_RANK
        if _module_level(user["email"], "hr", db) < _MODULE_LEVEL_RANK["full"]:
            raise HTTPException(403, "Only HR administrators change the California minimum wage.")
    return ca_review.save_settings(db, {"minWage": body.minWage}, user["email"])
