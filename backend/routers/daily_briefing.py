"""Admin config for the Nexus Daily Briefing (Aug 2026). GET/PUT the
NexusSetting-backed `daily_briefing_config` blob that daily_briefing.py's
scan loop reads every pass - `mode` (off|test|live) and `test_recipients`.

Global-Admin gated: this flag controls whether every employee in the company
starts receiving a daily email, so it sits behind require_administrator like
branding.py's config, not the lower require_manager bar ticket settings use.
Frontend panel added Sep 20 (see AdminConsole.jsx / DailyBriefingSettings.jsx).
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

import models
from auth import require_administrator
from database import get_db
import daily_briefing

router = APIRouter(prefix="/daily-briefing", tags=["Daily Briefing"])


class ConfigIn(BaseModel):
    mode: Optional[str] = None                 # off|test|live
    test_recipients: Optional[list] = None


@router.get("/config", dependencies=[Depends(require_administrator)])
def get_config(db: Session = Depends(get_db)):
    return daily_briefing.get_settings(db)


@router.put("/config", dependencies=[Depends(require_administrator)])
def update_config(body: ConfigIn, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if patch.get("mode") not in (None, "off", "test", "live"):
        patch.pop("mode", None)
    return daily_briefing.save_settings(db, patch, user["email"])


@router.get("/log", dependencies=[Depends(require_administrator)])
def get_log(employee_email: str = "", limit: int = 50, offset: int = 0, db: Session = Depends(get_db)):
    """Every scan attempt logged by _send_one - the only way to actually see
    WHY a given employee did or didn't get mail, short of DB/log-stream
    access. `sent_at` is blank for three different reasons that look
    identical without the other columns: mode was off, there was nothing to
    report (red/amber/green all 0), or the Graph send itself failed (mode is
    test/live AND at least one count is nonzero) - the frontend distinguishes
    these instead of the admin having to guess (Pranshu, Sep 20 - "very
    strange and anxious issue" when mail kept not arriving with no way to
    see why)."""
    q = db.query(models.NexusDailyBriefingLog)
    if employee_email:
        q = q.filter(models.NexusDailyBriefingLog.employee_email == employee_email.strip().lower())
    total = q.count()
    rows = q.order_by(models.NexusDailyBriefingLog.created_at.desc()).offset(offset).limit(min(limit, 200)).all()
    return {"total": total, "rows": [{
        "id": r.id, "employeeEmail": r.employee_email, "briefingDate": r.briefing_date,
        "sentAt": r.sent_at or "", "mode": r.mode, "redCount": r.red_count or 0,
        "amberCount": r.amber_count or 0, "greenCount": r.green_count or 0,
        "createdAt": r.created_at,
    } for r in rows]}


@router.delete("/log/{log_id}", dependencies=[Depends(require_administrator)])
def force_resend(log_id: str, db: Session = Depends(get_db)):
    """Clears one employee's dedupe row for one calendar day so the next
    scan pass (within SCAN_EVERY_SEC, up to 15 min) can trigger them again -
    for when a shift or the mode was edited AFTER that day's briefing had
    already fired, which otherwise silently blocks any retrigger until the
    NEXT calendar day (Pranshu, Sep 20: "the shift is set up at 3:45am but I
    have not received the mail" - the dedupe had nothing to do with the new
    shift time, it was still holding the slot from an earlier trigger under
    the old one).

    This does NOT send mail itself - it only clears the row that was
    blocking a retrigger. Whether anything actually sends still depends on
    _trigger_due finding the employee's (possibly just-edited) shift window
    currently open and daily-briefing mode being test/live with content."""
    row = db.query(models.NexusDailyBriefingLog).filter(models.NexusDailyBriefingLog.id == log_id).first()
    if not row:
        raise HTTPException(404, "Log entry not found.")
    db.delete(row)
    db.commit()
    return {"ok": True}
