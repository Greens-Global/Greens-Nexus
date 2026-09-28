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
    return weekly_digest.save_settings(db, patch, user["email"])


@router.get("/log", dependencies=[Depends(require_administrator)])
def get_log(employee_email: str = "", limit: int = 50, offset: int = 0, db: Session = Depends(get_db)):
    """Every weekly scan attempt, so "why didn't X get it" is answerable: a
    blank sentAt means mode was off, nothing was overdue, or the send failed -
    the mode and counts tell them apart (same as the daily /log)."""
    q = db.query(models.NexusWeeklyDigestLog)
    if employee_email:
        q = q.filter(models.NexusWeeklyDigestLog.employee_email == employee_email.strip().lower())
    total = q.count()
    rows = q.order_by(models.NexusWeeklyDigestLog.created_at.desc()).offset(offset).limit(min(limit, 200)).all()
    return {"total": total, "rows": [{
        "id": r.id, "employeeEmail": r.employee_email, "weekStart": r.week_start,
        "sentAt": r.sent_at or "", "mode": r.mode, "overdueCount": r.overdue_count or 0,
        "teamCount": r.team_count or 0, "createdAt": r.created_at,
    } for r in rows]}


@router.delete("/log/{log_id}", dependencies=[Depends(require_administrator)])
def force_resend(log_id: str, db: Session = Depends(get_db)):
    """Clears one person's dedupe row and sends their digest right now,
    whatever the day or their shift - the same build/send path as the scan,
    for this one person only (same shape as the daily force_resend)."""
    row = db.query(models.NexusWeeklyDigestLog).filter(models.NexusWeeklyDigestLog.id == log_id).first()
    if not row:
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
