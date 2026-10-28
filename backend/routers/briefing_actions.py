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
from datetime import datetime, timedelta, timezone
from html import escape

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from sqlalchemy import func

import auth
import briefing_mail_actions
import models
import task_mail_actions
from database import SessionLocal
from routers.mail_actions import _BTN, _page, _perform, _user_for, am_performer

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
        # decide_timeoff also refuses self-approval and, for a confidential
        # request, anyone but its approvers - so the type below is only ever
        # shown to someone allowed to see it.
        timeclock_router.decide_timeoff(entity_id, timeclock_router.TimeOffDecision(status=status),
                                        user=user, db=db)
        label = "Confidential time off" if timeclock_router._is_confidential(r) else r.type
        return f"{label} request", status
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


# ── Outlook card (briefing_card.py) ──────────────────────────────────────
# Every button in the Outlook version of the briefing posts here: kind=decision
# (an Approve/Reject token from briefing_mail_actions) or kind=task (a task
# token from task_mail_actions, same actions as the task email card). The
# answer is the whole briefing card redrawn for the same window (d, s), so the
# email updates in place and everything else still pending stays in view.

def _card_error(message: str, status: int) -> JSONResponse:
    # Outlook shows CARD-ACTION-STATUS under the card when the call fails.
    return JSONResponse({"detail": message}, status_code=status,
                        headers={"CARD-ACTION-STATUS": message[:200]})


@router.post("/card")
async def card_action(request: Request, kind: str = "", token: str = "", action: str = "",
                      d: str = "", s: str = "", v: str = ""):
    if kind == "decision":
        info = briefing_mail_actions.verify_token(token)
        if info and info["kind"] == "refresh":
            info = None
    elif kind == "refresh":
        info = briefing_mail_actions.verify_token(token)
        if info and info["kind"] != "refresh":
            info = None
    elif kind == "task":
        info = task_mail_actions.verify_token(token)
    else:
        info = None
    if not info:
        return _card_error("This briefing's buttons have expired. Open Nexus to take this action instead.", 400)
    text = (await request.body()).decode("utf-8", "replace")
    # Everything below is blocking (JWKS fetch, DB, the routers it calls) -
    # off the event loop, per CLAUDE.md.
    if kind == "refresh":
        return await asyncio.to_thread(_card_refresh_sync, request, info, d, s, v)
    return await asyncio.to_thread(_card_action_sync, request, kind, info, action, text, d, s, v)


def _card_refresh_sync(request: Request, info: dict, briefing_date: str, since_iso: str, variant: str):
    """Outlook opening the email (autoInvokeAction - briefing_card.py): the
    card redrawn with only what still waits on its owner, nothing decided.
    Someone else opening a forwarded copy gets an error, so Outlook keeps the
    card it had - the owner's list is not theirs to see."""
    import daily_briefing
    db = SessionLocal()
    try:
        recipient = info["recipient"]
        if not auth.SKIP_AUTH:
            performer = am_performer(request.headers.get("authorization", ""), db)
            if (performer or "").lower() != (recipient or "").lower():
                return _card_error("This card belongs to someone else.", 403)
        card = _refreshed_card(db, daily_briefing, recipient, briefing_date, since_iso, "", variant,
                               always=True)
    except HTTPException as e:
        return _card_error(str(e.detail), e.status_code)
    finally:
        db.close()
    return JSONResponse(card, headers={"CARD-UPDATE-IN-BODY": "true"})


def _card_action_sync(request: Request, kind: str, info: dict, action: str, text: str,
                      briefing_date: str, since_iso: str, variant: str = ""):
    import daily_briefing
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        recipient = info["recipient"]
        if auth.SKIP_AUTH:
            performer = recipient   # laptop only: no Outlook to sign the call
        else:
            performer = am_performer(request.headers.get("authorization", ""), db)
        user = _user_for(request, performer, db)
        if kind == "decision" and _is_bundle(info):
            raise HTTPException(400, "Open this link in a browser to choose which requests to decide.")
        if kind == "decision":
            subject, status = _execute(db, bt, user=user, kind=info["kind"], entity_id=info["id"],
                                       action=info["action"], note=text)
            outcome = f"{subject} {status}"
        else:
            outcome = _perform(request, db, user=user, task_id=info["task_id"], action=action,
                               text=text, bt=bt)
        outcome = f"{outcome}. Done by you."
        if (performer or "").lower() != (recipient or "").lower():
            # A forwarded copy: the action ran as the person who clicked, but
            # the briefing's owner's list is not theirs to see.
            import briefing_card
            from app_url import app_url
            card = briefing_card.outcome_only_card(outcome, app_url())
        else:
            card = _refreshed_card(db, daily_briefing, recipient, briefing_date, since_iso, outcome, variant)
    except HTTPException as e:
        return _card_error(str(e.detail), e.status_code)
    finally:
        db.close()
    return JSONResponse(card, background=bt, headers={
        "CARD-UPDATE-IN-BODY": "true", "CARD-ACTION-STATUS": outcome[:200]})


def _refreshed_card(db, daily_briefing, recipient: str, briefing_date: str, since_iso: str,
                    outcome: str, variant: str = "", always: bool = False) -> dict:
    if variant == "weekly":
        # The Weekly Digest's card: its own Needs Your Attention rows, as of now.
        import weekly_digest
        today = daily_briefing._recipient_local_now(db, recipient).date()
        sections = weekly_digest.build_sections(db, recipient, today)
        return weekly_digest.card(sections, recipient, today, outcome, always=True)
    try:
        datetime.strptime(briefing_date, "%Y-%m-%d")
    except ValueError:
        briefing_date = datetime.now(timezone.utc).date().isoformat()
    if not since_iso:
        # An empty cursor would match every row ever - fall back to the same
        # first-run window a brand-new employee gets.
        since_iso = (datetime.now(timezone.utc) - timedelta(hours=daily_briefing.LOOKBACK_HOURS_FIRST_RUN)
                     ).strftime("%Y-%m-%dT%H:%M:%S")
    sections = daily_briefing.build_sections(db, recipient, since_iso, briefing_date)
    if variant == "quick":
        # Clicked on the Quick Actions card: redraw that card, not the full one.
        return daily_briefing.quick_card(sections, briefing_date, since_iso, outcome, email=recipient,
                                         always=always)
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == recipient.lower()).first())
    return daily_briefing.outlook_card(
        db, recipient, ((emp.first_name if emp else "") or "").strip(), sections, briefing_date, since_iso,
        greeting=daily_briefing._greeting(daily_briefing._recipient_local_now(db, recipient)),
        logo_url=daily_briefing._logo_url(db), outcome=outcome)


def _who(db, email: str) -> str:
    email = (email or "").lower()
    if not email:
        return ""
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    return (f"{emp.first_name or ''} {emp.last_name or ''}".strip() if emp else "") or email


def _decided_line(db, kind: str, entity_id: str) -> str:
    """"" while the item still waits on a decision - else one sentence saying
    where it stands (Neil, Oct 26: an email cannot change after it is sent,
    so a link to an already-approved request still read "Reject this time
    off request?"). Every page checks this when it OPENS, so the buttons
    shown are always the ones that still apply."""
    import daily_briefing
    if kind == "timeoff_approval":
        r = db.query(models.TimeOffRequest).filter(models.TimeOffRequest.id == entity_id).first()
        if not r:
            return "This request no longer exists."
        status, by, at = r.status, r.approver, r.decided_at
    elif kind == "ticket_approval":
        t = db.query(models.TaskTicket).filter(models.TaskTicket.id == entity_id).first()
        if not t:
            return "This ticket no longer exists."
        status, by, at = t.approval_status or "none", "", t.approval_decided_at
        if status == "none":
            return "This ticket no longer needs approval."
    elif kind == "task_approval":
        t = db.query(models.Task).filter(models.Task.id == entity_id).first()
        if not t:
            return "This task no longer exists."
        status, by, at = t.approval_status or "none", "", ""
        if status == "none":
            return "This task no longer needs approval."
    else:
        return ""
    if status == "pending":
        return ""
    words = {"changes_requested": "sent back for changes"}.get(status, status)
    line = f"Already {words}"
    if by:
        line += f" by {_who(db, by)}"
    if at:
        line += f" on {daily_briefing._fmt_date(str(at)[:10])}"
    return line + "."


def _decided_page(line: str) -> HTMLResponse:
    from app_url import app_url
    return _page("Already Decided",
                 f"<p style='font-size:15px;font-weight:600;margin:0 0 8px'>{escape(line)}</p>"
                 "<p style='font-size:13px;color:#6b7280;margin:0 0 16px'>Nothing is waiting on you here. "
                 "To change a decision, open it in Nexus.</p>"
                 f"<a href='{escape(app_url())}' style='{_BTN};text-decoration:none'>Open Nexus</a>")


def _ids(info: dict) -> list:
    """The request ids a token names - one, or several for a bundled row
    (daily_briefing._bundle_buttons joins them with commas)."""
    return [i for i in str(info.get("id") or "").split(",") if i]


def _is_bundle(info: dict) -> bool:
    return info["kind"] == "timeoff_approval" and len(_ids(info)) > 1


_EXPIRED = "<p>This link has expired. Open Nexus to take this action instead.</p>"


def _bundle_page(token: str, info: dict) -> HTMLResponse:
    """Several time-off requests from one employee on one page (Neil, Oct 26):
    a checkbox each, all ticked, and both decisions at the bottom - the
    button clicked in the email first. Only requests still pending are
    listed; the dates and type are what the email already showed its
    recipient (_leave_labeler keeps a confidential type hidden)."""
    import daily_briefing
    db = SessionLocal()
    try:
        reqs = (db.query(models.TimeOffRequest)
                .filter(models.TimeOffRequest.id.in_(_ids(info))).all())
        reqs.sort(key=lambda r: r.start_date or "")
        pending = [r for r in reqs if r.status == "pending"]
        if not pending:
            return _decided_page(f"All {len(reqs)} requests have already been decided."
                                 if reqs else "These requests no longer exist.")
        leave = daily_briefing._leave_labeler(db, info["recipient"])
        who = (pending[0].employee_email or "").lower()
        emp = (db.query(models.NexusEmployee)
               .filter(func.lower(models.NexusEmployee.work_email) == who).first())
        name = (f"{emp.first_name or ''} {emp.last_name or ''}".strip() if emp else "") or who
        rows = "".join(
            "<label style='display:flex;align-items:center;gap:12px;padding:12px 4px;"
            "border-top:1px solid #e5e7eb;font-size:14px;cursor:pointer'>"
            f"<input type='checkbox' name='ids' value='{escape(r.id)}' checked "
            "style='width:18px;height:18px;margin:0;flex:none'>"
            f"<span><span style='font-weight:600'>{escape(daily_briefing._fmt_date(r.start_date))} - "
            f"{escape(daily_briefing._fmt_date(r.end_date))}</span> "
            f"<span style='color:#6b7280'>({escape(leave(r))})</span></span></label>"
            for r in pending)
        # Decided since the email went out: shown, but no longer pickable.
        rows += "".join(
            "<div style='display:flex;align-items:center;gap:12px;padding:12px 4px;"
            "border-top:1px solid #e5e7eb;font-size:14px;color:#6b7280'>"
            "<span style='width:18px;flex:none;text-align:center'>&#10003;</span>"
            f"<span><span style='font-weight:600'>{escape(daily_briefing._fmt_date(r.start_date))} - "
            f"{escape(daily_briefing._fmt_date(r.end_date))}</span> ({escape(leave(r))}) - "
            f"{escape(_decided_line(db, 'timeoff_approval', r.id))}</span></div>"
            for r in reqs if r.status != "pending")
        order = ("approve", "reject") if info["action"] == "approve" else ("reject", "approve")
        colors = {"approve": "#1f7a40", "reject": "#b91c1c"}
        buttons = "".join(
            f"<button type='submit' name='decision' value='{d}' "
            f"style='{_BTN};background:{colors[d]};margin:0 8px 8px 0'>{d.title()} Selected</button>"
            for d in order)
        plural = "" if len(pending) == 1 else "s"
        form = (f"<p style='margin:0 0 12px;font-size:14px'>{escape(name)} has {len(pending)} pending "
                f"time off request{plural}. Untick any you want to leave for later.</p>"
                "<form method='post' action='/briefing-actions/page'>"
                f"<input type='hidden' name='token' value='{escape(token)}'>"
                f"<div style='border-bottom:1px solid #e5e7eb;margin-bottom:18px'>{rows}</div>"
                f"{buttons}</form>")
        return _page(f"Time Off - {name}", form)
    finally:
        db.close()


@router.get("/page", response_class=HTMLResponse)
def action_page(token: str = ""):
    info = briefing_mail_actions.verify_token(token)
    if not info:
        return _page("Link Expired", _EXPIRED)
    if _is_bundle(info):
        return _bundle_page(token, info)
    db = SessionLocal()
    try:
        line = _decided_line(db, info["kind"], info["id"])
    finally:
        db.close()
    if line:
        return _decided_page(line)
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
    form = await request.form()
    return await asyncio.to_thread(_action_page_submit_sync, request, str(form.get("token") or ""),
                                   str(form.get("note") or ""), str(form.get("decision") or ""),
                                   [str(i) for i in form.getlist("ids")])


def _bundle_submit(request: Request, info: dict, decision: str, picked: list) -> HTMLResponse:
    """Decides the ticked requests of a bundle, each through _execute exactly
    as a single one is - a refused request (already decided, out of scope)
    is reported and never stops the rest. Only ids the token names count;
    either decision may be made, since the email carried both buttons."""
    import daily_briefing
    if decision not in ("approve", "reject"):
        decision = info["action"]
    wanted = set(picked)
    chosen = [i for i in _ids(info) if i in wanted]
    if not chosen:
        return _page("Nothing Selected", "<p>Tick at least one request, then try again - "
                     "your browser's Back button returns to the list.</p>")
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        user = _user_for(request, info["recipient"], db)
        reqs = {r.id: (r.start_date, r.end_date) for r in db.query(models.TimeOffRequest)
                .filter(models.TimeOffRequest.id.in_(chosen)).all()}
        chosen.sort(key=lambda i: (reqs.get(i) or ("",))[0] or "")   # date order, as listed
        word = "Approved" if decision == "approve" else "Rejected"
        lines, done = [], 0
        for rid in chosen:
            span = reqs.get(rid)
            when = (f"{daily_briefing._fmt_date(span[0])} - {daily_briefing._fmt_date(span[1])}"
                    if span else "A request")
            try:
                _execute(db, bt, user=user, kind="timeoff_approval", entity_id=rid, action=decision)
                done += 1
                result = f"<span style='color:#1f7a40;font-weight:600'>{word}</span>"
            except HTTPException as e:
                db.rollback()
                result = f"<span style='color:#b91c1c'>{escape(str(e.detail))}</span>"
            lines.append(f"<li style='margin:4px 0'>{escape(when)}: {result}</li>")
        if done:
            head = (f"<p style='font-size:15px;font-weight:600;color:#1f7a40'>"
                    f"{done} request{'' if done == 1 else 's'} {word.lower()}.</p>")
        else:
            head = "<p style='font-size:15px;font-weight:600;color:#b91c1c'>Nothing was saved.</p>"
        resp = _page("Done" if done else "Could Not Save",
                     f"{head}<ul style='padding-left:18px;font-size:14px'>{''.join(lines)}</ul>"
                     "<p style='font-size:13px;color:#6b7280'>You can close this page.</p>")
        resp.background = bt
        return resp
    finally:
        db.close()


def _action_page_submit_sync(request: Request, token: str, note: str = "", decision: str = "",
                             picked: list | None = None) -> HTMLResponse:
    info = briefing_mail_actions.verify_token(token)
    if not info:
        return _page("Link Expired", _EXPIRED)
    if _is_bundle(info):
        return _bundle_submit(request, info, decision, picked or [])
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        user = _user_for(request, info["recipient"], db)
        try:
            subject, status = _execute(db, bt, user=user, kind=info["kind"], entity_id=info["id"],
                                       action=info["action"], note=note)
        except HTTPException as e:
            return _page("Could Not Save", f"<p style='color:#b91c1c'>{escape(str(e.detail))}</p>")
        resp = _page("Done", f"<p style='font-size:15px;font-weight:600;color:#1f7a40'>"
                     f"{escape(subject)} {escape(status)}.</p>"
                     "<p style='font-size:13px;color:#6b7280'>You can close this page.</p>")
        resp.background = bt
        return resp
    finally:
        db.close()


# Kept for main.py's CSRF exemption list.
PUBLIC_PATHS = ("/briefing-actions/page", "/briefing-actions/card")
