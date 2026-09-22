"""In-mail actions for task notification emails (Sept 2026).

Two layers, both added to a finished email by `decorate()`:

1. **Outlook Actionable Message card.** An Adaptive Card embedded in the email's
   <head> as `<script type="application/adaptivecard+json">`. Outlook (desktop,
   web, mobile) renders it IN the email: a status dropdown, Mark Complete, and
   an "Add Comment" box that opens inside the message - or, for a mention, the
   comment itself with a reply box under it. Each button is an Action.Http POST
   to /mail-actions/card, which Outlook signs with a Microsoft-issued JWT naming
   the person who clicked (verified in routers/mail_actions.py). The endpoint
   answers with a refreshed card, so the email updates in place ("Marked
   complete").

   Only rendered when NEXUS_AM_ORIGINATOR is set. Getting that id, and making
   the actions work, is a one-time setup at https://aka.ms/ActionableMessagesPortal
   (the Actionable Email Developer Dashboard - open outlook.office.com first,
   or it renders blank):

     1. Register an app in Entra ID for this API, "Expose an API", and set its
        Application ID URI to the AppIdUri the provider registration generates
        (api://auth-am-<guid>/<guid>). Preauthorize the Actions app id
        48af08dc-f6d2-435f-b2a7-069abd99c086 on that scope.
     2. Register the provider: sender mailbox, the API's base URL as the target,
        scope "Organization", and the MsEntra Auth section from step 1. An
        Exchange admin approves it, and grants tenant consent from the
        dashboard's AAD Consent page.
     3. Set NEXUS_AM_ORIGINATOR (the id it issues) and NEXUS_AM_AUDIENCE (that
        same AppIdUri) on the API.

   Microsoft retired the legacy (EAT) token on June 8, 2026 - action requests
   now carry an Entra ID token, which is what routers/mail_actions validates.
   Without the originator Outlook ignores the card, so it is simply not
   emitted; and none of this can work from a laptop, because Outlook has to
   reach the action URL over public HTTPS.

2. **Signed action links** in the HTML body, for every other client (and for
   Outlook before the registration is approved): "Mark Complete", "Change
   Status", "Add Comment" / "Reply". Each opens a small page served by the API
   (/mail-actions/page) carrying a signed, expiring token for exactly one task
   and one recipient. GET only ever renders a form - link scanners (Safe Links)
   prefetch URLs, so nothing may change on GET.

Both layers act as a real person through the SAME task update / comment code
the app uses (routers/tasks.update_task / add_comment), so permission checks,
activity, notifications and recurrence behave exactly as they do in Nexus.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from html import escape

from mail_text import rich_to_email_html

# ── Configuration ────────────────────────────────────────────────────────────

AM_ORIGINATOR = os.getenv("NEXUS_AM_ORIGINATOR", "").strip()

# Same key the signed reply-to address uses (task_inbound_parse.py), with its
# own context prefix so a token for one purpose can never be replayed as the
# other. The DEV fallback protects nothing, which is fine on a laptop.
_SECRET = (os.getenv("NEXUS_VAULT_KEY", "").strip()
           or "nexus-task-reply-DEV-ONLY-key-set-NEXUS_VAULT_KEY").encode()
_CONTEXT = b"task-mail-action:v1:"

TOKEN_TTL_SEC = 30 * 24 * 3600   # a month: long enough for a reminder read late

# Events that get the full action set (status, complete, comment).
ACTION_EVENTS = {"created", "assigned", "due_soon", "overdue", "recurring",
                 "follower_added", "modified", "commented", "mentioned"}
# Events that show the comment that triggered them, with a reply box under it.
COMMENT_EVENTS = {"commented", "mentioned"}

BUILTIN_STATUSES = [("not_started", "Not Started"), ("in_progress", "In Progress"),
                    ("completed", "Completed")]

# Preset set for the "React" action (Sep 2026 - "add emojis for tasks so we
# can react"). Fixed and small on purpose: an open picker needs its own UI,
# and these six cover the reactions people actually reach for in Teams/Slack.
REACTION_EMOJIS = ["\U0001F44D", "❤️", "\U0001F389", "\U0001F44F", "\U0001F602", "\U0001F525"]
# 👍 ❤️ 🎉 👏 😂 🔥


def api_base() -> str:
    """Public https base of THIS API - what Outlook and the fallback links call.
    Same derivation as asana_sync.public_base (Azure host, or NEXUS_API_BASE to
    override); a laptop falls back to the local uvicorn port so the fallback
    page can still be exercised by hand."""
    override = os.getenv("NEXUS_API_BASE", "").strip().rstrip("/")
    if override:
        return override
    host = os.getenv("WEBSITE_HOSTNAME", "").strip()
    return f"https://{host}" if host else "http://localhost:8000"


# ── Signed tokens ────────────────────────────────────────────────────────────

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_token(task_id: str, recipient: str, *, now: float | None = None) -> str:
    """Opaque `<payload>.<sig>` binding one task to one recipient until expiry."""
    payload = json.dumps({"t": task_id, "r": (recipient or "").lower(),
                          "e": int((now or time.time()) + TOKEN_TTL_SEC)},
                         separators=(",", ":")).encode()
    sig = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:16]
    return f"{_b64(payload)}.{_b64(sig)}"


def verify_token(token: str, *, now: float | None = None) -> dict | None:
    """{"task_id", "recipient"} for a valid, unexpired token - else None."""
    try:
        p64, s64 = (token or "").split(".", 1)
        payload = _unb64(p64)
        want = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(want, _unb64(s64)):
            return None
        data = json.loads(payload)
        if int(data.get("e", 0)) < (now or time.time()):
            return None
        return {"task_id": data["t"], "recipient": data.get("r", "")}
    except Exception:
        return None


# ── Status options ───────────────────────────────────────────────────────────

def status_options(db, project_id: str = "") -> list[tuple[str, str]]:
    """The statuses the task's project offers, same scoping as the board
    (routers/tasks.list_custom_statuses): built-ins, then custom statuses that
    are global or belong to this project, in their set order."""
    import models
    opts = list(BUILTIN_STATUSES)
    try:
        rows = sorted(db.query(models.TaskCustomStatus).all(), key=lambda s: s.position or 0)
    except Exception:
        rows = []
    for s in rows:
        scoped = [p for p in (s.project_ids or []) if p]
        if not scoped or (project_id and project_id in scoped):
            opts.append((s.id, s.label or s.id))
    return opts


def status_label(status: str, options: list[tuple[str, str]]) -> str:
    for key, label in options:
        if key == status:
            return label
    return "Recurring" if status == "recurring" else (status or "-").replace("_", " ").title()


# ── Adaptive Card (Outlook Actionable Message) ───────────────────────────────

def _plain(html: str, limit: int = 600) -> str:
    """Comment HTML -> plain text for a card TextBlock (cards render markdown,
    not HTML)."""
    import re
    s = re.sub(r"<br\s*/?>|</p>|</li>", "\n", html or "", flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    import html as _h
    s = _h.unescape(s).strip()
    return (s[:limit] + "…") if len(s) > limit else s


def _http(title: str, action: str, token: str, body: str = "") -> dict:
    """An Action.Http that posts to the card endpoint. The token and action ride
    in the URL; the body carries ONLY the typed text, raw (text/plain) - putting
    free text inside a JSON body template breaks the moment someone types a
    quote, because Outlook substitutes {{input.value}} without escaping it."""
    return {
        "type": "Action.Http", "title": title, "method": "POST",
        "url": f"{api_base()}/mail-actions/card?token={token}&action={action}",
        "body": body, "headers": [{"name": "Content-Type", "value": "text/plain"}],
    }


def build_card(*, t: dict, event_type: str, token: str, options: list[tuple[str, str]],
               comment_body: str = "", comment_author: str = "",
               outcome: str = "") -> dict:
    """The card for one recipient. `outcome` is a line shown at the top after an
    action ("Marked complete by you") when the endpoint refreshes the card."""
    done = t.get("status") == "completed"
    facts = [{"title": k, "value": v or "-"} for k, v in (
        ("Status", status_label(t.get("status", ""), options)),
        ("Project", t.get("projectName")),
        ("Assignee", t.get("assigneeName") or "Unassigned"),
        ("Priority", (t.get("priority") or "").title()),
        ("Due Date", t.get("dueDateDisplay")),
    )]
    body: list[dict] = []
    if outcome:
        body.append({"type": "TextBlock", "text": outcome, "weight": "bolder",
                     "color": "good", "wrap": True})
    body += [
        {"type": "TextBlock", "text": t.get("title") or "Task", "size": "large",
         "weight": "bolder", "wrap": True},
        {"type": "FactSet", "facts": facts},
    ]
    actions: list[dict] = []
    if event_type in COMMENT_EVENTS and comment_body:
        who = comment_author or "Someone"
        body += [
            {"type": "TextBlock", "text": f"{who} wrote:", "weight": "bolder",
             "spacing": "medium", "wrap": True},
            {"type": "Container", "style": "emphasis", "items": [
                {"type": "TextBlock", "text": _plain(comment_body), "wrap": True}]},
            # The reply box sits right under the comment, not behind a button -
            # replying is the whole point of a mention email.
            {"type": "Input.Text", "id": "reply", "isMultiline": True,
             "placeholder": "Write a reply…"},
        ]
        actions.append(_http("Send Reply", "reply", token, "{{reply.value}}"))
    else:
        actions.append({"type": "Action.ShowCard", "title": "Add Comment", "card": {
            "type": "AdaptiveCard",
            "body": [{"type": "Input.Text", "id": "comment", "isMultiline": True,
                      "placeholder": "Write a comment…"}],
            "actions": [_http("Post Comment", "comment", token, "{{comment.value}}")],
        }})
    if not done:
        actions.append({"type": "Action.ShowCard", "title": "Change Status", "card": {
            "type": "AdaptiveCard",
            "body": [{"type": "Input.ChoiceSet", "id": "status", "style": "compact",
                      "value": t.get("status") or "not_started",
                      "choices": [{"title": label, "value": key} for key, label in options]}],
            "actions": [_http("Update Status", "status", token, "{{status.value}}")],
        }})
        actions.append(_http("Mark Complete", "complete", token))
    actions.append({"type": "Action.OpenUrl", "title": "Open in Nexus", "url": t.get("taskUrl") or ""})
    return {
        "type": "AdaptiveCard", "version": "1.0", "originator": AM_ORIGINATOR,
        # The card IS the email wherever it renders - showing the HTML body
        # under it as well would print every detail twice.
        "hideOriginalBody": True,
        "body": body, "actions": actions,
    }


# ── HTML fallback buttons ────────────────────────────────────────────────────

def _page_url(token: str, do: str) -> str:
    return f"{api_base()}/mail-actions/page?token={token}&do={do}"


def fallback_actions_html(*, event_type: str, token: str, done: bool) -> str:
    """Secondary buttons under the main CTA. Plain links (every client renders
    them); each opens the /mail-actions/page form for that action."""
    btn = ("display:inline-block;margin:4px;padding:8px 14px;border-radius:8px;"
           "border:1px solid #d1d5db;color:#1f2937;text-decoration:none;"
           "font-size:13px;font-weight:600;background:#ffffff")
    links = []
    if event_type in COMMENT_EVENTS:
        links.append(("Reply", "reply"))
    else:
        links.append(("Add Comment", "comment"))
    if not done:
        links += [("Change Status", "status"), ("Mark Complete", "complete")]
    items = "".join(f"<a href='{escape(_page_url(token, do))}' style='{btn}'>{escape(label)}</a>"
                    for label, do in links)
    return f"<div style='margin:12px 0 0;text-align:center'>{items}</div>"


def settings_url() -> str:
    """The recipient's own email settings - the header menu's "Email Settings"
    (EmailSettingsModal.jsx), which TopHeader.jsx opens on ?emailSettings=1 on
    whatever screen the app lands - the Dashboard here, which every employee
    can open, unlike a Tasks URL."""
    from app_url import app_url
    return f"{app_url()}/dashboard?emailSettings=1"


def footer_links_html(*, token: str = "") -> str:
    """Footer line on every task email: mute this one task (when there is a
    task to mute) and the way to the person's own email settings - the
    anti-spam controls have to be reachable from the email that annoyed them."""
    link = "color:#2563eb;text-decoration:none;font-weight:600"
    parts = []
    if token:
        parts.append(f"<a href='{escape(_page_url(token, 'mute'))}' style='{link}'>Mute This Task</a>")
    parts.append(f"<a href='{escape(settings_url())}' style='{link}'>Email Settings</a>")
    return "<br><span style='display:inline-block;margin-top:6px'>" + " &nbsp;·&nbsp; ".join(parts) + "</span>"


def task_links_html(task_id: str, recipient: str, *, done: bool = False) -> str:
    """Compact per-task action links for a row of the daily summary email."""
    token = sign_token(task_id, recipient)
    link = "color:#2563eb;text-decoration:none;font-size:12.5px;font-weight:600"
    items = [("Add Comment", "comment")]
    if not done:
        items = [("Mark Complete", "complete"), ("Change Status", "status")] + items
    items.append(("Mute", "mute"))
    return " &nbsp;·&nbsp; ".join(f"<a href='{escape(_page_url(token, do))}' style='{link}'>{escape(label)}</a>"
                                  for label, do in items)


# ── Entry point ──────────────────────────────────────────────────────────────

ACTIONS_SLOT = "<!--NEXUS-MAIL-ACTIONS-->"
FOOTER_SLOT = "<!--NEXUS-MAIL-FOOTER-->"


def decorate(html: str, *, event_type: str, t: dict, recipient: str, options: list[tuple[str, str]],
             comment_body: str = "", comment_author: str = "") -> str:
    """Adds the fallback action buttons (at task_email_html's actions slot) and,
    when an originator is configured, the Outlook card. Events without actions
    (completed, deleted) come back unchanged apart from the empty slot."""
    if event_type not in ACTION_EVENTS or not t.get("id"):
        # No actions - but still the way to mute / manage (a deleted task has
        # nothing left to mute, only the settings link).
        mute_token = sign_token(t["id"], recipient) if t.get("id") and event_type != "deleted" else ""
        return html.replace(ACTIONS_SLOT, "").replace(FOOTER_SLOT, footer_links_html(token=mute_token))
    token = sign_token(t["id"], recipient)
    html = html.replace(FOOTER_SLOT, footer_links_html(token=token))
    done = t.get("status") == "completed"
    html = html.replace(ACTIONS_SLOT, fallback_actions_html(event_type=event_type, token=token, done=done))
    if not AM_ORIGINATOR:
        return html
    card = build_card(t=t, event_type=event_type, token=token, options=options,
                      comment_body=comment_body, comment_author=comment_author)
    # "</" inside a <script> would end the tag early - escape it in the JSON.
    card_json = json.dumps(card, ensure_ascii=False).replace("</", "<\\/")
    return ("<html><head><meta http-equiv='Content-Type' content='text/html; charset=utf-8'>"
            f"<script type='application/adaptivecard+json'>{card_json}</script>"
            f"</head><body>{html}</body></html>")


def comment_html(text: str) -> str:
    """Plain text typed into an email -> the rich comment HTML the app stores
    (one paragraph per line, escaped)."""
    lines = [ln.strip() for ln in (text or "").replace("\r\n", "\n").split("\n")]
    paras = [f"<p>{escape(ln)}</p>" for ln in lines if ln]
    return "".join(paras)


# Re-exported for the page renderer so the fallback page shows the comment the
# same way the email did.
comment_preview_html = rich_to_email_html
