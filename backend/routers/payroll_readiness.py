"""Payroll Readiness routes (Neil, Oct 17 2026) - see payroll_readiness.py.

Access mirrors the Payroll time sheet (GET /timeclock/payroll): the team
audience (require_team_read), a fresh step-up because the report carries pay,
the caller's own scope (timeclock._visible_emails), and the manager tier gets
the report with every money figure removed (timeclock._pay_hidden). The
thresholds are HR's: the team-write audience minus the manager tier, inside
their own company scope (auth.hr_scope).

Every route is a plain `def`: FastAPI runs it in a thread, so the per-person
timecard loop never blocks the event loop.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

import models
import payroll_readiness as pr
from database import get_db
from routers.stepup import require_stepup
from routers.timeclock import _pay_hidden, _visible_emails, require_team_read, require_team_write

router = APIRouter(prefix="/payroll-readiness", tags=["payroll-readiness"])


def _check_date(v: str) -> str:
    v = (v or "").strip()
    if not v:
        return ""
    try:
        return date.fromisoformat(v).isoformat()
    except ValueError:
        raise HTTPException(400, "start must be a date (YYYY-MM-DD)")


@router.get("/report")
def readiness_report(start: str = "", refresh: bool = False, user: dict = Depends(require_team_read),
                     _su: dict = Depends(require_stepup), db: Session = Depends(get_db)):
    """Readiness, variance and anomalies for the pay period containing `start`
    (default: the last bi-weekly period that is over; salaried people: the
    latest month ended by then)."""
    anchor = _check_date(start)
    scope = _visible_emails(db, user)
    hidden = _pay_hidden(db, user)
    # Keyed by the period, so the panel ('' = last closed) and the export's
    # confirm (the period's start) share one report.
    key = (user["email"].lower(), pr.periods(anchor or pr.default_anchor())["start"], hidden)
    if refresh:
        pr.clear_cache()
    report = pr.cached(key, lambda: pr.build(db, scope, anchor))
    return pr.strip_pay(report) if hidden else {**report, "payHidden": False}


def _editable_companies(db: Session, user: dict):
    """None = the tenant default and every company; else the company ids this
    HR person may change (their hr_scope)."""
    from auth import hr_scope, is_team_scope
    scope = hr_scope(user, db)
    if scope is None:
        return None
    if is_team_scope(scope):
        return set()
    return set(scope)


def _can_edit(db: Session, user: dict) -> bool:
    from auth import _module_level
    if _pay_hidden(db, user):
        return False
    return int(user.get("level", 0)) >= 3 or _module_level(user["email"], "hr", db) >= 2


@router.get("/settings")
def readiness_settings(company: str = "", user: dict = Depends(require_team_read), db: Session = Depends(get_db)):
    cid = (company or "").strip()
    can = _can_edit(db, user)
    allowed = _editable_companies(db, user) if can else set()
    ents = db.query(models.HrEntity.id, models.HrEntity.name).order_by(models.HrEntity.name).all()
    return {"company": cid, "settings": pr.get_settings(db, cid), "tenant": pr.get_settings(db),
            "defaults": dict(pr.DEFAULTS), "limits": {k: list(v) for k, v in pr.LIMITS.items()},
            "override": pr.has_override(db, cid),
            "canEdit": can and (allowed is None or (bool(cid) and cid in allowed)),
            "canEditDefault": can and allowed is None,
            "companies": [{"id": i, "name": n or i} for i, n in ents if can and (allowed is None or i in allowed)]}


class SettingsIn(BaseModel):
    company: str = ""
    settings: dict = {}
    reset: Optional[bool] = False


@router.put("/settings")
def save_readiness_settings(body: SettingsIn, user: dict = Depends(require_team_write), db: Session = Depends(get_db)):
    if not _can_edit(db, user):
        raise HTTPException(403, "Only HR can change the payroll readiness thresholds")
    cid = (body.company or "").strip()
    allowed = _editable_companies(db, user)
    if allowed is not None and (not cid or cid not in allowed):
        raise HTTPException(403, "Outside your companies")
    if cid and not db.query(models.HrEntity.id).filter(models.HrEntity.id == cid).first():
        raise HTTPException(404, "Company not found")
    saved = pr.save_settings(db, cid, body.settings or {}, user["email"], reset=bool(body.reset))
    return {"company": cid, "settings": saved, "override": pr.has_override(db, cid)}
