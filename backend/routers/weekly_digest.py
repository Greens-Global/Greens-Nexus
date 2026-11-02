"""Admin config for the Weekly Digest (Sep 28 2026) - see weekly_digest.py.

Global-Admin gated, the same bar as the Daily Briefing's config
(routers/daily_briefing.py): this decides whether every employee starts
getting a weekly email. Frontend: components/WeeklyDigestSettings.jsx.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

import models
from auth import require_administrator
from database import get_db
import daily_briefing
import settings_walls
import weekly_digest

router = APIRouter(prefix="/weekly-digest", tags=["Weekly Digest"])


class ConfigIn(BaseModel):
    mode: Optional[str] = None                 # off|test|live
    test_recipients: Optional[list] = None
    sendDay: Optional[int] = None              # 1 = Monday .. 7 = Sunday
    leadMinutes: Optional[int] = None          # 30..360 before the shift starts
    includeNoShift: Optional[bool] = None
    defaultSendTime: Optional[str] = None      # local "HH:MM", 24h
    defaultTimeZone: Optional[str] = None      # IANA name
    outlookCard: Optional[bool] = None         # the refreshing Outlook card on top


@router.get("/config", dependencies=[Depends(require_administrator)])
def get_config(db: Session = Depends(get_db)):
    return weekly_digest.get_settings(db)


@router.put("/config")
def update_config(body: ConfigIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        patch = weekly_digest.validate(patch)
    except ValueError as e:
        raise HTTPException(400, str(e))
    # Whether everyone gets it, and who the tests go to, is the whole
    # organization's (Neil, 11/02/2026): Super Administrators only.
    settings_walls.refuse_change(db, user, weekly_digest.get_settings(db), patch, ("mode", "test_recipients"))
    return weekly_digest.save_settings(db, patch, user["email"])


@router.get("/log")
def get_log(employee_email: str = "", limit: int = 50, offset: int = 0,
            user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Every weekly scan attempt, so "why didn't X get it" is answerable: a
    blank sentAt means mode was off, nothing was overdue, or the send failed -
    the mode and counts tell them apart (same as the daily /log). Only the
    people inside the caller's company wall (11/02/2026)."""
    q = settings_walls.scope_query(db, user, db.query(models.NexusWeeklyDigestLog),
                                   models.NexusWeeklyDigestLog.employee_email)
    if employee_email:
        q = q.filter(models.NexusWeeklyDigestLog.employee_email == employee_email.strip().lower())
    total = q.count()
    rows = q.order_by(models.NexusWeeklyDigestLog.created_at.desc()).offset(offset).limit(min(limit, 200)).all()
    return {"total": total, "rows": [{
        "id": r.id, "employeeEmail": r.employee_email, "weekStart": r.week_start,
        "sentAt": r.sent_at or "", "mode": r.mode, "overdueCount": r.overdue_count or 0,
        "teamCount": r.team_count or 0, "createdAt": r.created_at,
    } for r in rows]}


@router.delete("/log/{log_id}")
def force_resend(log_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Clears one person's dedupe row and sends their digest right now,
    whatever the day or their shift - the same build/send path as the scan,
    for this one person only (same shape as the daily force_resend)."""
    row = db.query(models.NexusWeeklyDigestLog).filter(models.NexusWeeklyDigestLog.id == log_id).first()
    if not row or not settings_walls.in_scope(db, user, row.employee_email):
        raise HTTPException(404, "Log entry not found.")
    email = row.employee_email
    db.delete(row)
    db.commit()
    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    if not emp:
        return {"ok": True, "sentNow": False, "reason": "Employee record not found - cleared the log row only."}
    try:
        weekly_digest.acquire_employee_lock(db, email)
        cfg = weekly_digest.get_settings(db)
        local_now = daily_briefing._shift_local_now(daily_briefing._person_zone(db, email, cfg))
        result = weekly_digest.send_one(db, emp, cfg, local_now.date(), local_now)   # commits
    except Exception as e:
        db.rollback()
        raise HTTPException(500, f"Force resend failed for {email}: {type(e).__name__}: {e}")
    return {"ok": True, "sentNow": result["sent"], "mode": result["mode"], "hadContent": result["hadContent"]}


class TestSendIn(BaseModel):
    employee_email: str
    to: Optional[list] = None      # default: the test recipients, else the admin themselves


@router.post("/test-send")
def test_send(body: TestSendIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Send Test Digest: builds one employee's real digest now and mails it
    only to the test recipients (or to the admin), in any mode and on any day.
    Logs nothing, so the person's real weekly send is unaffected."""
    from sqlalchemy import func
    import graph_mail
    email = (body.employee_email or "").strip().lower()
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first()) if email else None
    if not emp or not settings_walls.in_scope(db, user, emp.work_email):
        raise HTTPException(404, "No employee with that email.")
    cfg = weekly_digest.get_settings(db)
    to = [str(e).strip() for e in (body.to or cfg.get("test_recipients") or []) if str(e).strip()] or [user["email"]]
    # Who a test goes to is the Super Administrators' (Neil, 11/02/2026):
    # anyone else sends to the saved test recipients or to themselves.
    allowed = {str(e).strip().lower() for e in (cfg.get("test_recipients") or [])} | {user["email"].lower()}
    import auth
    if any(e.lower() not in allowed for e in to) and not auth.is_global_admin(user, db):
        raise HTTPException(403, "Only a Super Administrator can send a test to other addresses.")
    try:
        result = weekly_digest.send_test(db, emp, cfg, to)
    except graph_mail.GraphMailError as e:
        raise HTTPException(502, f"The email could not be sent: {e}")
    return {**result, "recipients": to, "employeeEmail": emp.work_email}
