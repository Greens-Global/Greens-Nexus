"""Workforce Scorecard (Oct 10 2026) - see workforce_scorecard.py.

The report itself is open to anyone holding the `workforce-scorecard` grant
(their own reporting line; Full grant or administrator+ = everyone). The
email settings and delivery log are Global-Admin gated, the same bar as the
Weekly Digest: they decide whether every manager starts getting a weekly
email. Frontend: components/workforce/Scorecard.jsx (the tab) and
components/WorkforceScorecardSettings.jsx (Settings > Workforce Scorecard).
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
from auth import require_administrator, require_module_grant
from database import get_db
import graph_mail
import workforce_scorecard as sc

router = APIRouter(prefix="/workforce-scorecard", tags=["Workforce Scorecard"])
_read = require_module_grant(sc.MODULE_ID, "viewer")


def _week(week_start: str, cfg: dict, db: Session, email: str) -> date:
    if not week_start:
        return sc.default_week(db, email, cfg)
    try:
        d = date.fromisoformat(week_start[:10])
    except ValueError:
        raise HTTPException(400, "week_start must be YYYY-MM-DD.")
    return sc.week_start_for(d, cfg)


def _use(db: Session, user: dict, scope: str) -> tuple:
    """(emails, kind, can_see_company) to score. The grant decides what the
    caller MAY see (direct reports by default, the reporting line with Editor,
    everyone with Full / admin); someone allowed everyone still gets their
    direct reports unless they ask for `all`. Asking for more than the grant
    allows is silently answered with what it does allow."""
    allowed, kind = sc.scope_for(db, user)
    if kind == "all" and scope != "all":
        return sc.direct_reports(db, user["email"]), "direct", True
    return allowed, kind, kind == "all"


@router.get("/report")
def report(week_start: str = "", scope: str = "team", user: dict = Depends(_read), db: Session = Depends(get_db)):
    """The scorecard for one week. `scope=all` needs company-wide rights
    (Full grant or administrator+); anyone else silently gets what their
    grant allows, and the response says which it is (`scope`: direct | line |
    all) plus whether `all` is available."""
    cfg = sc.get_settings(db)
    ws = _week(week_start, cfg, db, user["email"])
    use, kind, company = _use(db, user, scope)
    out = sc.build_report(db, use, cfg, ws, kind)
    out["canSeeCompany"] = company
    out["weekStartDay"] = cfg.get("weekStart", "monday")
    return out


class EmailMeIn(BaseModel):
    week_start: Optional[str] = ""
    scope: Optional[str] = "team"


@router.post("/email-me")
def email_me(body: EmailMeIn, user: dict = Depends(_read), db: Session = Depends(get_db)):
    """Mails the caller the scorecard they are looking at. Logs nothing, so
    their scheduled weekly send is unaffected."""
    cfg = sc.get_settings(db)
    ws = _week(body.week_start or "", cfg, db, user["email"])
    use, kind, _ = _use(db, user, body.scope or "team")
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == user["email"].lower()).first())
    if not emp:
        raise HTTPException(404, "Your employee record was not found.")
    try:
        r = sc.send_test(db, emp, use, cfg, [emp.work_email], ws, kind, test=False)
    except graph_mail.GraphMailError as e:
        raise HTTPException(502, f"The email could not be sent: {e}")
    return {**r, "to": emp.work_email, "weekStart": ws.isoformat()}


# ── Admin: settings, log, tests ───────────────────────────────────────────

class ConfigIn(BaseModel):
    mode: Optional[str] = None
    test_recipients: Optional[list] = None
    sendDay: Optional[int] = None
    sendTime: Optional[str] = None
    defaultTimeZone: Optional[str] = None
    weekStart: Optional[str] = None
    payTypes: Optional[list] = None
    standards: Optional[dict] = None
    shortToleranceMin: Optional[int] = None
    onTrackPct: Optional[int] = None
    belowPct: Optional[int] = None
    workingTimeOffTypes: Optional[list] = None
    companyRecipients: Optional[list] = None


@router.get("/config", dependencies=[Depends(require_administrator)])
def get_config(db: Session = Depends(get_db)):
    return sc.get_settings(db)


@router.put("/config")
def update_config(body: ConfigIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        patch = sc.validate(patch)
        return sc.save_settings(db, patch, user["email"])
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.get("/recipients", dependencies=[Depends(require_administrator)])
def list_recipients(db: Session = Depends(get_db)):
    """Who the next send would go to and with what scope - so "why did / didn't
    X get it" is answerable before going live."""
    cfg = sc.get_settings(db)
    return {"rows": [{"email": emp.work_email, "name": sc._name(emp), "scope": kind,
                      "peopleInScope": None if scope is None else len(scope)}
                     for emp, scope, kind in sc.recipients(db, cfg)]}


@router.get("/log", dependencies=[Depends(require_administrator)])
def get_log(manager_email: str = "", limit: int = 50, offset: int = 0, db: Session = Depends(get_db)):
    q = db.query(models.NexusWorkforceScorecardLog)
    if manager_email:
        q = q.filter(models.NexusWorkforceScorecardLog.manager_email == manager_email.strip().lower())
    total = q.count()
    rows = q.order_by(models.NexusWorkforceScorecardLog.created_at.desc()).offset(offset).limit(min(limit, 200)).all()
    return {"total": total, "rows": [{
        "id": r.id, "managerEmail": r.manager_email, "weekStart": r.week_start, "scope": r.scope,
        "sentAt": r.sent_at or "", "mode": r.mode, "peopleCount": r.people_count or 0,
        "absentCount": r.absent_count or 0, "belowCount": r.below_count or 0, "createdAt": r.created_at,
    } for r in rows]}


def _recipient(db: Session, email: str, cfg: dict):
    for emp, scope, kind in sc.recipients(db, cfg):
        if emp.work_email.lower() == email:
            return emp, scope, kind
    return None, None, ""


@router.delete("/log/{log_id}", dependencies=[Depends(require_administrator)])
def force_resend(log_id: str, db: Session = Depends(get_db)):
    """Clears one manager's dedupe row for that week and sends their scorecard
    for it right now, whatever the day (same shape as the digest's)."""
    row = db.query(models.NexusWorkforceScorecardLog).filter(models.NexusWorkforceScorecardLog.id == log_id).first()
    if not row:
        raise HTTPException(404, "Log entry not found.")
    email, week = row.manager_email, row.week_start
    db.delete(row)
    db.commit()
    cfg = sc.get_settings(db)
    emp, scope, kind = _recipient(db, email, cfg)
    if not emp:
        return {"ok": True, "sentNow": False, "reason": "No longer a recipient (grant removed or not active) - cleared the log row only."}
    try:
        sc.acquire_lock(db, email)
        result = sc.send_one(db, emp, scope, cfg, date.fromisoformat(week), kind)   # commits
    except Exception as e:
        db.rollback()
        raise HTTPException(500, f"Force resend failed for {email}: {type(e).__name__}: {e}")
    return {"ok": True, "sentNow": result["sent"], "mode": result["mode"], "hadContent": result["hadContent"]}


class TestSendIn(BaseModel):
    manager_email: str
    week_start: Optional[str] = ""
    to: Optional[list] = None      # default: the test recipients, else the admin themselves


@router.post("/test-send")
def test_send(body: TestSendIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Builds one manager's real scorecard now (with the scope their grant
    gives them) and mails it only to the test recipients or the admin."""
    cfg = sc.get_settings(db)
    email = (body.manager_email or "").strip().lower()
    emp, scope, kind = _recipient(db, email, cfg) if email else (None, None, "")
    if not emp:
        raise HTTPException(404, "That person is not a scorecard recipient - give their role the Workforce Scorecard grant first.")
    to = [str(e).strip() for e in (body.to or cfg.get("test_recipients") or []) if str(e).strip()] or [user["email"]]
    ws = _week(body.week_start or "", cfg, db, emp.work_email)
    try:
        result = sc.send_test(db, emp, scope, cfg, to, ws, kind)
    except graph_mail.GraphMailError as e:
        raise HTTPException(502, f"The email could not be sent: {e}")
    return {**result, "recipients": to, "managerEmail": emp.work_email, "weekStart": ws.isoformat(), "scope": kind}
