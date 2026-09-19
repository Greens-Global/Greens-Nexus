"""Executes a Daily Briefing one-click action (see briefing_mail_actions.py).

Same GET-renders/POST-executes split as routers/mail_actions.py, and reuses
its confirm-page chrome and "act as the person the token names" helper rather
than re-deriving either. Only two kinds exist so far - task_approval and
timeoff_approval - because those are the only Action Required rows that are a
plain yes/no with no photo or picker attached (see briefing_mail_actions.py's
module docstring for why the rest stay "Open in Nexus").
"""
import asyncio
from html import escape

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse

import briefing_mail_actions
import models
from database import SessionLocal
from routers.mail_actions import _BTN, _page, _user_for

router = APIRouter(prefix="/briefing-actions", tags=["Briefing Actions"])

_KIND_LABELS = {"task_approval": "task", "timeoff_approval": "time off request"}


def _execute(db, bt: BackgroundTasks, *, user: dict, kind: str, entity_id: str, action: str) -> tuple:
    """Applies the decision through the SAME endpoint function the app itself
    calls, so permission checks, notifications and activity behave exactly as
    they do in Nexus. Returns (subject, status) for the confirmation line."""
    status = "approved" if action == "approve" else "rejected"
    if kind == "task_approval":
        from routers import tasks as tasks_router
        t = db.query(models.Task).filter(models.Task.id == entity_id).first()
        if not t:
            raise HTTPException(404, "This task no longer exists.")
        if t.approval_status != "pending":
            raise HTTPException(409, f"Already {t.approval_status}.")
        # bt must be the SAME BackgroundTasks the response ends up carrying -
        # update_task queues the approval/rejection notification onto it
        # rather than sending inline, and a discarded instance means the task
        # owner is never told the decision was made.
        tasks_router.update_task(entity_id, tasks_router.TaskUpdate(approval_status=status),
                                 bt, user=user, db=db)
        return t.title or "This task", status
    if kind == "timeoff_approval":
        from routers import timeclock as timeclock_router
        # decide_timeoff's own require_team_write dependency only runs through
        # FastAPI's DI, which a direct Python call bypasses - so the level/
        # module threshold has to be checked here explicitly, or a manager
        # below it (who never sees an Approve button in the app either) could
        # still approve from the email. decide_timeoff's OWN scope check
        # (direct-report/company scope) still runs unconditionally below.
        timeclock_router.require_team_write(user=user, db=db)
        r = db.query(models.TimeOffRequest).filter(models.TimeOffRequest.id == entity_id).first()
        if not r:
            raise HTTPException(404, "This request no longer exists.")
        if r.status != "pending":
            raise HTTPException(409, f"Already {r.status}.")
        timeclock_router.decide_timeoff(entity_id, timeclock_router.TimeOffDecision(status=status),
                                        user=user, db=db)
        return f"{r.type} request", status
    raise HTTPException(400, "Unknown action")


@router.get("/page", response_class=HTMLResponse)
def action_page(token: str = ""):
    info = briefing_mail_actions.verify_token(token)
    if not info:
        return _page("Link Expired", "<p>This link has expired. Open Nexus to take this action instead.</p>")
    label = _KIND_LABELS.get(info["kind"], "item")
    verb = "Approve" if info["action"] == "approve" else "Reject"
    form = (f"<p style='margin:0 0 16px;font-size:14px'>{escape(verb)} this {escape(label)}?</p>"
            f"<form method='post' action='/briefing-actions/page'>"
            f"<input type='hidden' name='token' value='{escape(token)}'>"
            f"<button type='submit' style='{_BTN}'>{escape(verb)}</button></form>")
    return _page(f"{verb} {label.title()}", form)


@router.post("/page", response_class=HTMLResponse)
async def action_page_submit(request: Request):
    form = dict(await request.form())
    return await asyncio.to_thread(_action_page_submit_sync, request, str(form.get("token") or ""))


def _action_page_submit_sync(request: Request, token: str) -> HTMLResponse:
    info = briefing_mail_actions.verify_token(token)
    if not info:
        return _page("Link Expired", "<p>This link has expired. Open Nexus to take this action instead.</p>")
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        user = _user_for(request, info["recipient"], db)
        try:
            subject, status = _execute(db, bt, user=user, kind=info["kind"], entity_id=info["id"], action=info["action"])
        except HTTPException as e:
            return _page("Could Not Save", f"<p style='color:#b91c1c'>{escape(str(e.detail))}</p>")
        resp = _page("Done", f"<p style='font-size:15px;font-weight:600;color:#15803d'>"
                     f"{escape(subject)} {escape(status)}.</p>"
                     "<p style='font-size:13px;color:#6b7280'>You can close this page.</p>")
        resp.background = bt
        return resp
    finally:
        db.close()


# Kept for main.py's CSRF exemption list.
PUBLIC_PATHS = ("/briefing-actions/page",)
