"""Admin config for the Nexus Daily Briefing (Aug 2026). GET/PUT the
NexusSetting-backed `daily_briefing_config` blob that daily_briefing.py's
scan loop reads every pass - `mode` (off|test|live) and `test_recipients`.

Global-Admin gated: this flag controls whether every employee in the company
starts receiving a daily email, so it sits behind require_administrator like
branding.py's config, not the lower require_manager bar ticket settings use.
Frontend panel added Sep 20 (see AdminConsole.jsx / DailyBriefingSettings.jsx).
"""
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

import models
from auth import get_current_user, require_administrator
from database import get_db
import daily_briefing

router = APIRouter(prefix="/daily-briefing", tags=["Daily Briefing"])


class ConfigIn(BaseModel):
    mode: Optional[str] = None                 # off|test|live
    test_recipients: Optional[list] = None
    outlook_card: Optional[bool] = None


# ── My Briefing page (any signed-in employee, their own briefing only) ─────

@router.get("/me")
def my_briefing(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return daily_briefing.my_briefing(db, user["email"])


class ActIn(BaseModel):
    kind: str                  # decision | task
    id: str
    action: str                # decision: approve|reject; task: comment|react|status|complete
    decision_kind: str = ""    # task_approval | timeoff_approval | ticket_approval
    text: str = ""             # comment, reaction, status value, or rejection reason


@router.post("/me/act")
def act_on_my_briefing(body: ActIn, request: Request, bt: BackgroundTasks,
                       user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Runs one action from the My Briefing page as the signed-in person,
    through the same code the email links use (routers/briefing_actions and
    routers/mail_actions), so permission checks and notifications behave
    exactly as they do everywhere else in Nexus."""
    if body.kind == "decision":
        from routers.briefing_actions import _execute
        if body.action not in ("approve", "reject"):
            raise HTTPException(400, "Unknown action")
        subject, status = _execute(db, bt, user=user, kind=body.decision_kind, entity_id=body.id,
                                   action=body.action, note=body.text)
        return {"ok": True, "message": f"{subject} {status}."}
    if body.kind == "task":
        from routers.mail_actions import _perform
        if body.action not in ("comment", "react", "status", "complete"):
            raise HTTPException(400, "Unknown action")
        return {"ok": True, "message": _perform(request, db, user=user, task_id=body.id, action=body.action,
                                                text=body.text, bt=bt) + "."}
    raise HTTPException(400, "Unknown action")


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
    """Clears one employee's dedupe row AND immediately re-evaluates and
    sends their briefing right now - scoped to exactly this one employee,
    not a company-wide scan, and with no effect on daily_briefing_loop's own
    15-minute timer (every other employee keeps being scanned on the normal
    schedule, completely untouched by this).

    Deliberately bypasses _trigger_due's shift-window wait: that check
    exists to space out the AUTOMATIC per-shift trigger, but this is an
    admin explicitly asking for it right now (Pranshu, Sep 20 - "resend
    should trigger the mail right away for that particular employee, but
    for rest it should behave normally"), so a closed window is not a
    reason to refuse - only a reason not to pretend this was the normal
    automatic trigger. Still goes through the exact same content-build and
    send path (build_sections / render_email / graph_mail.send_mail) as
    every other briefing, so it behaves like a real one, not a special case.

    _acquire_employee_lock still applies, so this can't race a concurrent
    automatic scan pass hitting the same employee at the same instant."""
    row = db.query(models.NexusDailyBriefingLog).filter(models.NexusDailyBriefingLog.id == log_id).first()
    if not row:
        raise HTTPException(404, "Log entry not found.")
    email = row.employee_email
    db.delete(row)
    db.commit()

    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
    if not emp:
        return {"ok": True, "sentNow": False, "reason": "Employee record not found - cleared the log row only."}

    try:
        daily_briefing._acquire_employee_lock(db, email)
        cfg = daily_briefing.get_settings(db)
        # Reuse the shift's own resolved date when the window happens to be
        # open right now (matches what the automatic scan would have used);
        # fall back to today's UTC date otherwise - _trigger_due returns ""
        # for briefing_date exactly when it's not due, which is also the
        # case we're deliberately overriding here.
        _due, briefing_date, _ = daily_briefing._trigger_due(db, email)
        if not briefing_date:
            briefing_date = datetime.now(timezone.utc).date().isoformat()
        daily_briefing._send_one(db, emp, cfg, briefing_date)   # commits internally
    except Exception as e:
        db.rollback()
        # Re-raised as an HTTPException (not left to the app's catch-all
        # Exception handler) specifically so this admin-gated action reports
        # the real cause instead of a blanket "Internal server error" - the
        # 500 surfaced on Sep 20 with zero diagnostic detail otherwise
        # available short of an Azure log-stream login nobody in this
        # session had.
        raise HTTPException(500, f"Force resend failed for {email}: {type(e).__name__}: {e}")

    sent_row = (db.query(models.NexusDailyBriefingLog)
                .filter(models.NexusDailyBriefingLog.employee_email == email,
                        models.NexusDailyBriefingLog.briefing_date == briefing_date)
                .order_by(models.NexusDailyBriefingLog.created_at.desc()).first())
    return {"ok": True, "sentNow": bool(sent_row and sent_row.sent_at),
            "mode": cfg.get("mode", "off"),
            "hadContent": bool(sent_row and (sent_row.red_count or sent_row.amber_count or sent_row.green_count))}
