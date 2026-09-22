"""Executes a Daily Briefing one-click action (see briefing_mail_actions.py).

Same GET-renders/POST-executes split as routers/mail_actions.py, and reuses
its confirm-page chrome and "act as the person the token names" helper rather
than re-deriving either. Three kinds exist so far - task_approval,
timeoff_approval, ticket_approval - because those are the only Action
Required rows that are a plain yes/no decision (see briefing_mail_actions.py's
module docstring for why the rest stay "Open in Nexus"). ticket_approval's
reject still needs one text field (Nexus requires a reason when rejecting a
ticket request) - the confirm page adds it only for that one case rather than
carrying a note field the other two kinds don't use.
"""
import asyncio
from html import escape

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import func

import auth
import briefing_mail_actions
import daily_briefing
import models
from database import SessionLocal
from routers.mail_actions import _BTN, _page, _user_for, am_performer

router = APIRouter(prefix="/briefing-actions", tags=["Briefing Actions"])

_KIND_LABELS = {"task_approval": "task", "timeoff_approval": "time off request",
                "ticket_approval": "ticket"}


def _execute(db, bt: BackgroundTasks, *, user: dict, kind: str, entity_id: str, action: str,
            note: str = "") -> tuple:
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
    if kind == "ticket_approval":
        from routers import tickets as tickets_router
        t = db.query(models.TaskTicket).filter(models.TaskTicket.id == entity_id).first()
        if not t:
            raise HTTPException(404, "This ticket no longer exists.")
        if (t.approval_status or "none") != "pending":
            raise HTTPException(409, f"Already {t.approval_status}.")
        # decide_approval fully re-checks "only the named approver (or an
        # administrator) may decide" inside its own body, unlike decide_timeoff
        # above - it does not lean on its require_ticket_desk DI dependency for
        # anything the decision itself needs (that dependency gates general
        # ticket-board access, a different, broader question), so no extra
        # explicit gate is required here. decide_approval also independently
        # enforces the reason-required-on-reject rule if the confirm page's own
        # required-field check is ever bypassed.
        tickets_router.decide_approval(entity_id, tickets_router.ApprovalBody(decision=action, note=note),
                                       bt, user=user, db=db)
        return t.subject or "This ticket", status
    raise HTTPException(400, "Unknown action")


# ── Outlook Actionable Message card ──────────────────────────────────────
# See briefing_mail_actions.build_card - one consolidated card covering
# every Action Required row, refreshed to whatever is STILL pending after
# each click (not just a confirmation of the one thing just decided).

def _card_error(message: str, status: int) -> JSONResponse:
    return JSONResponse({"detail": message}, status_code=status,
                        headers={"CARD-ACTION-STATUS": message[:200]})


@router.post("/card")
async def card_action(request: Request, token: str = ""):
    info = briefing_mail_actions.verify_token(token)
    if not info:
        return _card_error("This link has expired. Open Nexus to take this action instead.", 400)
    text = (await request.body()).decode("utf-8", "replace")
    # Everything below is blocking (JWKS fetch, DB, the task/timeoff/ticket
    # routers) - off the event loop, per CLAUDE.md, so one click can never
    # stall the worker.
    return await asyncio.to_thread(_card_action_sync, request, info, text)


def _card_action_sync(request: Request, info: dict, text: str):
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        if auth.SKIP_AUTH:
            performer = info["recipient"]   # laptop only: no Outlook to sign the call
        else:
            performer = am_performer(request.headers.get("authorization", ""), db)
        user = _user_for(request, performer, db)
        subject, status = _execute(db, bt, user=user, kind=info["kind"], entity_id=info["id"],
                                   action=info["action"], note=text)
        outcome = f"{subject} {status}."
        # Rebuild the FULL remaining list for this recipient, not just this
        # one outcome - a manager with several pending items who acts on one
        # should still see the others in the refreshed card, not lose them.
        my_reports = {(e.work_email or "").lower(): e for e in
                      db.query(models.NexusEmployee)
                      .filter(func.lower(models.NexusEmployee.manager_email) == info["recipient"].lower()).all()}
        rows = daily_briefing._red_rows(db, info["recipient"], my_reports)
        card = briefing_mail_actions.build_card(rows, info["recipient"], outcome=outcome)
    except HTTPException as e:
        return _card_error(str(e.detail), e.status_code)
    finally:
        db.close()
    return JSONResponse(card, background=bt, headers={
        "CARD-UPDATE-IN-BODY": "true", "CARD-ACTION-STATUS": outcome})


@router.get("/page", response_class=HTMLResponse)
def action_page(token: str = ""):
    info = briefing_mail_actions.verify_token(token)
    if not info:
        return _page("Link Expired", "<p>This link has expired. Open Nexus to take this action instead.</p>")
    label = _KIND_LABELS.get(info["kind"], "item")
    verb = "Approve" if info["action"] == "approve" else "Reject"
    # Ticket rejection is the one decision here that Nexus requires a reason
    # for (routers/tickets.decide_approval) - task/time-off rejection need
    # nothing extra, so the field only appears for this one combination.
    needs_note = info["kind"] == "ticket_approval" and info["action"] == "reject"
    note_field = ("<textarea name='note' required placeholder='Reason for rejecting (required)' "
                  "style='width:100%;min-height:80px;margin:4px 0 16px;padding:8px;"
                  "border:1px solid #d1d5db;border-radius:6px;font:inherit;box-sizing:border-box'>"
                  "</textarea>") if needs_note else ""
    form = (f"<p style='margin:0 0 16px;font-size:14px'>{escape(verb)} this {escape(label)}?</p>"
            f"<form method='post' action='/briefing-actions/page'>"
            f"<input type='hidden' name='token' value='{escape(token)}'>"
            f"{note_field}"
            f"<button type='submit' style='{_BTN}'>{escape(verb)}</button></form>")
    return _page(f"{verb} {label.title()}", form)


@router.post("/page", response_class=HTMLResponse)
async def action_page_submit(request: Request):
    form = dict(await request.form())
    return await asyncio.to_thread(_action_page_submit_sync, request, str(form.get("token") or ""),
                                   str(form.get("note") or ""))


def _action_page_submit_sync(request: Request, token: str, note: str = "") -> HTMLResponse:
    info = briefing_mail_actions.verify_token(token)
    if not info:
        return _page("Link Expired", "<p>This link has expired. Open Nexus to take this action instead.</p>")
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        user = _user_for(request, info["recipient"], db)
        try:
            subject, status = _execute(db, bt, user=user, kind=info["kind"], entity_id=info["id"],
                                       action=info["action"], note=note)
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
PUBLIC_PATHS = ("/briefing-actions/page", "/briefing-actions/card")
