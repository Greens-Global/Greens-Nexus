"""Actions taken from inside a task notification email (Sept 2026) - see
task_mail_actions.py for the email side.

Two public entry points, neither behind the app's own login:

  POST /mail-actions/card   Outlook Actionable Messages. Outlook signs every
                            request with a Microsoft-issued JWT; we verify it
                            (issuer, audience, the AM app id, our own sender)
                            and act as the person it names. The signed token in
                            the URL only picks the task.
  GET/POST /mail-actions/page
                            The fallback for other clients: a small page. The
                            signed token IS the authorization here - it binds
                            one task to the one person the email went to, and
                            expires. GET never changes anything (link scanners
                            prefetch URLs); only the form's POST acts.

Either way the change goes through routers/tasks.update_task / add_comment as
that person, so the same permission checks, activity log, notifications and
recurrence roll-forward apply as in the app.
"""
from __future__ import annotations

import asyncio
import time
from html import escape

import httpx
import jwt as pyjwt
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from jwt.algorithms import RSAAlgorithm

import auth
import models
import task_mail_actions as tma
from app_url import app_url
from database import SessionLocal

router = APIRouter(prefix="/mail-actions", tags=["Mail Actions"])

# ── Microsoft Actionable Message token (https://learn.microsoft.com/outlook/
#    actionable-messages/security-requirements) ─────────────────────────────
AM_ISSUER = "https://substrate.office.com/sts/"
AM_APP_ID = "48af08dc-f6d2-435f-b2a7-069abd99c086"
AM_KEYS_URL = "https://substrate.office.com/sts/common/discovery/keys"
_am_keys: dict = {"keys": None, "at": 0.0}


def _am_signing_key(token: str):
    kid = pyjwt.get_unverified_header(token).get("kid")
    if not _am_keys["keys"] or time.time() - _am_keys["at"] > 3600:
        _am_keys.update({"keys": httpx.get(AM_KEYS_URL, timeout=10).json().get("keys", []),
                         "at": time.time()})
    for k in _am_keys["keys"] or []:
        if k.get("kid") == kid:
            return RSAAlgorithm.from_jwk(k)
    raise pyjwt.InvalidTokenError("unknown signing key")


def _sender_mailboxes(db) -> set[str]:
    import graph_mail
    import task_notify
    cfg = task_notify.get_settings(db)
    return {m.strip().lower() for m in (cfg.get("fromMailbox"), graph_mail.DEFAULT_FROM_EMAIL) if m}


def am_performer(authorization: str, db) -> str:
    """Email of the person who clicked, from Outlook's bearer token. Raises 401
    for anything that is not a genuine Actionable Message request from an email
    this system sent."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Actionable Message token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        claims = pyjwt.decode(token, _am_signing_key(token), algorithms=["RS256"],
                              audience=tma.api_base(), issuer=AM_ISSUER)
    except Exception as exc:
        raise HTTPException(401, f"Invalid Actionable Message token: {exc}")
    if claims.get("appid") != AM_APP_ID:
        raise HTTPException(401, "Token was not issued for Actionable Messages")
    if (claims.get("sender") or "").lower() not in _sender_mailboxes(db):
        raise HTTPException(401, "Email was not sent by this system")
    performer = (claims.get("sub") or "").strip().lower()
    if "@" not in performer:
        raise HTTPException(401, "Token names no user")
    return performer


# ── Acting as a person ───────────────────────────────────────────────────────

def _user_for(request: Request, email: str, db) -> dict:
    role, level = auth._role_for(email, db)
    return auth.apply_external_policy(request, {"email": email, "role": role, "level": level})


def _perform(request: Request, db, *, user: dict, task_id: str, action: str, text: str,
             bt: BackgroundTasks) -> str:
    """Apply one action as `user`; returns the confirmation line. HTTPException
    from the task router (403/404/422) propagates unchanged."""
    from routers import tasks as tasks_router
    text = (text or "").strip()
    if action in ("comment", "reply"):
        if not text:
            raise HTTPException(422, "Write something first.")
        body = tma.comment_html(text)
        if action == "reply":
            # A reply to a mention @mentions whoever wrote it, so they hear back
            # the same way they reached you.
            author = _last_mentioner(db, task_id, user["email"])
            if author:
                name = escape(_name(db, author))
                body = body.replace("<p>", f"<p><a href=\"mailto:{escape(author)}\">@{name}</a> ", 1)
        tasks_router.add_comment(task_id, tasks_router.CommentCreate(body=body), bt,
                                 notify=True, user=user, db=db)
        return "Reply posted" if action == "reply" else "Comment posted"
    if action == "complete":
        tasks_router.update_task(task_id, tasks_router.TaskUpdate(completed=True), bt, user=user, db=db)
        return "Marked complete"
    if action == "status":
        t = db.query(models.Task).filter(models.Task.id == task_id).first()
        valid = {k for k, _ in tma.status_options(db, getattr(t, "project_id", "") or "")}
        if text not in valid:
            raise HTTPException(422, "Pick a status from the list.")
        tasks_router.update_task(task_id, tasks_router.TaskUpdate(status=text), bt, user=user, db=db)
        label = tma.status_label(text, tma.status_options(db, getattr(t, "project_id", "") or ""))
        return f"Status changed to {label}"
    if action == "react":
        if text not in tma.REACTION_EMOJIS:
            raise HTTPException(422, "Pick a reaction from the list.")
        t = db.query(models.Task).filter(models.Task.id == task_id).first()
        if not t:
            raise HTTPException(404, "Task not found")
        # Same bar as commenting, not editor - reacting is lighter-weight than
        # changing the task, and require_task_role already treats any assignee
        # as at least an editor, so this only actually gates a non-assignee.
        from routers.task_util import require_task_role
        require_task_role(db, user, t, "commenter")
        reactions = dict(t.reactions or {})
        holders = set(reactions.get(text) or [])
        toggled_on = user["email"] not in holders
        holders.symmetric_difference_update({user["email"]})
        if holders:
            reactions[text] = sorted(holders)
        else:
            reactions.pop(text, None)
        t.reactions = reactions
        db.commit()
        return f"Reacted {text}" if toggled_on else f"Removed your {text} reaction"
    if action == "mute":
        # The recipient's own preference, not a change to the task - so no
        # task role is needed, only that the signed link was theirs.
        import task_notify_prefs
        task_notify_prefs.mute_task(db, user["email"], task_id)
        return "Emails muted for this task. You can unmute it in your email settings"
    raise HTTPException(400, "Unknown action")


def _name(db, email: str) -> str:
    import task_notify
    return task_notify._name_of(db, email)


def _last_mentioner(db, task_id: str, me: str) -> str:
    """Author of the most recent comment on the task that mentions `me`."""
    rows = (db.query(models.TaskComment).filter(models.TaskComment.task_id == task_id)
            .order_by(models.TaskComment.created_at.desc()).limit(50).all())
    for c in rows:
        if f"mailto:{me}" in (c.body or "").lower() and (c.author_email or "").lower() != me:
            return (c.author_email or "").lower()
    return ""


def _fresh_card(db, task_id: str, recipient: str, token: str, outcome: str) -> dict:
    import task_notify
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    ctx = task_notify._task_context(db, t, recipient) if t else {"id": task_id, "title": "Task"}
    opts = tma.status_options(db, getattr(t, "project_id", "") or "")
    return tma.build_card(t=ctx, event_type="assigned", token=token, options=opts, outcome=outcome)


# ── Outlook card endpoint ────────────────────────────────────────────────────

@router.post("/card")
async def card_action(request: Request, token: str = "", action: str = ""):
    info = tma.verify_token(token)
    if not info:
        return _card_error("This email's actions have expired. Open the task in Nexus instead.", 400)
    text = (await request.body()).decode("utf-8", "replace")
    # Everything below is blocking (JWKS fetch, DB, the task router) - off the
    # event loop, per CLAUDE.md, so one click can never stall the worker.
    return await asyncio.to_thread(_card_action_sync, request, info, token, action, text)


def _card_action_sync(request: Request, info: dict, token: str, action: str, text: str):
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        if auth.SKIP_AUTH:
            performer = info["recipient"]   # laptop only: no Outlook to sign the call
        else:
            performer = am_performer(request.headers.get("authorization", ""), db)
        user = _user_for(request, performer, db)
        outcome = _perform(request, db, user=user, task_id=info["task_id"], action=action, text=text, bt=bt)
        card = _fresh_card(db, info["task_id"], info["recipient"], token, f"{outcome} by you.")
    except HTTPException as e:
        return _card_error(str(e.detail), e.status_code)
    finally:
        db.close()
    return JSONResponse(card, background=bt, headers={
        "CARD-UPDATE-IN-BODY": "true", "CARD-ACTION-STATUS": outcome})


def _card_error(message: str, status: int) -> JSONResponse:
    # Outlook shows CARD-ACTION-STATUS under the card when the call fails.
    return JSONResponse({"detail": message}, status_code=status,
                        headers={"CARD-ACTION-STATUS": message[:200]})


# ── Fallback page (non-Outlook clients) ──────────────────────────────────────

_PAGE_TITLES = {"comment": "Add Comment", "reply": "Reply", "status": "Change Status",
                "complete": "Mark Complete", "react": "React", "mute": "Mute This Task"}


def _page(title: str, inner: str) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title></head>
<body style="margin:0;background:#f4f5f7;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:32px auto;padding:0 16px">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">
<div style="background:#0f3d2e;padding:16px 24px;color:#fff;font-weight:700;letter-spacing:3px">GREENS GLOBAL</div>
<div style="padding:22px 24px">{inner}</div></div></div></body></html>""")


def _task_header(t) -> str:
    return (f"<h2 style='margin:0 0 4px;font-size:18px'>{escape(t.title or 'Task')}</h2>"
            f"<p style='margin:0 0 16px;font-size:13px;color:#6b7280'>"
            f"<a href='{escape(app_url())}/tasks/mine?task={escape(t.id)}' style='color:#2563eb'>Open in Nexus</a></p>")


_BTN = ("display:inline-block;border:none;border-radius:8px;background:#248f4b;color:#fff;"
        "font-size:14px;font-weight:700;padding:10px 22px;cursor:pointer")


@router.get("/page", response_class=HTMLResponse)
def action_page(token: str = "", do: str = "comment"):
    info = tma.verify_token(token)
    if not info:
        return _page("Link Expired", "<p>This link has expired. Open the task in Nexus instead.</p>")
    db = SessionLocal()
    try:
        t = db.query(models.Task).filter(models.Task.id == info["task_id"]).first()
        if not t:
            return _page("Task Not Found", "<p>This task no longer exists.</p>")
        do = do if do in _PAGE_TITLES else "comment"
        if do == "react":
            # One click, not two - each emoji is its own form (a shared outer
            # form can't carry six different `text` values at once) so tapping
            # an emoji submits immediately instead of picking-then-confirming.
            btns = "".join(
                f"<form method='post' action='/mail-actions/page' style='display:inline-block;margin:0 6px 6px 0'>"
                f"<input type='hidden' name='token' value='{escape(token)}'>"
                f"<input type='hidden' name='action' value='react'>"
                f"<input type='hidden' name='text' value='{escape(emoji)}'>"
                f"<button type='submit' style='font-size:22px;line-height:1;border:1px solid #e5e7eb;"
                f"border-radius:10px;background:#fff;padding:8px 12px;cursor:pointer'>{emoji}</button></form>"
                for emoji in tma.REACTION_EMOJIS)
            return _page("React", _task_header(t) +
                        "<p style='margin:0 0 12px;font-size:14px'>Tap a reaction:</p>"
                        f"<div>{btns}</div>")
        field = ""
        if do in ("comment", "reply"):
            field = ("<textarea name='text' rows='5' required autofocus style='width:100%;box-sizing:border-box;"
                     "border:1px solid #d1d5db;border-radius:8px;padding:10px;font:inherit;font-size:14px'"
                     f" placeholder='{'Write a reply…' if do == 'reply' else 'Write a comment…'}'></textarea>")
        elif do == "status":
            opts = "".join(f"<option value='{escape(k)}'{' selected' if k == t.status else ''}>{escape(v)}</option>"
                           for k, v in tma.status_options(db, t.project_id or ""))
            field = ("<select name='text' style='width:100%;border:1px solid #d1d5db;border-radius:8px;"
                     f"padding:9px;font:inherit;font-size:14px'>{opts}</select>")
        elif do == "mute":
            field = ("<p style='margin:0;font-size:14px'>Stop all emails about this task? "
                     "You will still be emailed if someone mentions you on it.</p>")
        elif do == "complete":
            field = "<p style='margin:0;font-size:14px'>Mark this task as complete?</p>"
        form = (f"<form method='post' action='/mail-actions/page'>"
                f"<input type='hidden' name='token' value='{escape(token)}'>"
                f"<input type='hidden' name='action' value='{escape(do)}'>{field}"
                f"<p style='margin:16px 0 0'><button type='submit' style='{_BTN}'>{escape(_PAGE_TITLES[do])}</button></p></form>")
        return _page(_PAGE_TITLES[do], _task_header(t) + form)
    finally:
        db.close()


@router.post("/page", response_class=HTMLResponse)
async def action_page_submit(request: Request):
    form = dict(await request.form())
    return await asyncio.to_thread(_action_page_submit_sync, request, form)


def _action_page_submit_sync(request: Request, form: dict):
    info = tma.verify_token(str(form.get("token") or ""))
    if not info:
        return _page("Link Expired", "<p>This link has expired. Open the task in Nexus instead.</p>")
    db = SessionLocal()
    bt = BackgroundTasks()
    try:
        t = db.query(models.Task).filter(models.Task.id == info["task_id"]).first()
        if not t:
            return _page("Task Not Found", "<p>This task no longer exists.</p>")
        header = _task_header(t)
        try:
            user = _user_for(request, info["recipient"], db)
            outcome = _perform(request, db, user=user, task_id=t.id, action=str(form.get("action") or ""),
                               text=str(form.get("text") or ""), bt=bt)
        except HTTPException as e:
            return _page("Could Not Save", header + f"<p style='color:#b91c1c'>{escape(str(e.detail))}</p>")
        resp = _page("Done", header + f"<p style='font-size:15px;font-weight:600;color:#15803d'>{escape(outcome)}.</p>"
                     "<p style='font-size:13px;color:#6b7280'>You can close this page.</p>")
        resp.background = bt
        return resp
    finally:
        db.close()


# Kept for main.py's CSRF exemption list.
PUBLIC_PATHS = ("/mail-actions/card", "/mail-actions/page")
