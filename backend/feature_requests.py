"""Feature requests are tickets (Oct 23 2026).

One feature request is ONE record: a ticket of type `feature_request`, with
one conversation - the ticket's comments. Whichever door it came in by:

  - What's New > Feature Request (or "request a feature" on an update):
    `file_from_whats_new` files the ticket through tickets.file_ticket, the
    same intake every ticket takes.
  - Tickets / Help Center > Feature Request: filed as any ticket is.

`after_filed` (called by tickets.file_ticket for every feature_request
ticket) then:

  - keeps What's New's status card for it - a `changelog_feedback` row (kind
    "request") pointing at the ticket by `ticket_id`. The card carries the
    road-to-shipping status (New ... Shipped) and the bells that follow it;
    its comments ARE the ticket's (changelog_lifecycle's request comment
    routes read and write the ticket thread through post_ticket_comment), so a
    reply typed in What's New or in the ticket drawer is the same reply.
  - posts the request to the "Nexus - Feedback and Bugs" Teams chat, through
    the ticket Teams queue (`ticket_teams_message`, kind "feedback_chat"),
    so it retries like every other Teams post (teams_post.py).

The Teams post goes out as a person (delegated Graph token): the requester
when they are in the chat, else the ticket's assignee, else the people named
in NEXUS_FEEDBACK_CHAT_POSTERS (comma-separated emails) - so the Nexus team
can make sure it always lands. The chat is found by its name
(NEXUS_FEEDBACK_CHAT_TOPIC, default below) among the poster's chats, and its
id is remembered in NexusSetting. Nobody able to post = the row keeps the
reason in send_error (the desk's Teams log shows it), never dropped silently.
"""
import html as html_lib
import json
import os
import re

import httpx

import models
from routers.task_util import gen_id, now_iso

KIND = "feedback_chat"
CHAT_TOPIC_DEFAULT = "Nexus - Feedback and Bugs"
CHAT_ID_KEY = "feedback_chat_id"
GRAPH = "https://graph.microsoft.com/v1.0"
MAX_CHAT_PAGES = 20


def chat_topic() -> str:
    return (os.getenv("NEXUS_FEEDBACK_CHAT_TOPIC") or CHAT_TOPIC_DEFAULT).strip()


def _env_posters() -> list:
    raw = os.getenv("NEXUS_FEEDBACK_CHAT_POSTERS") or ""
    return [e.strip().lower() for e in raw.split(",") if e.strip()]


# ── Text helpers ───────────────────────────────────────────────────────────

def html_to_text(s: str) -> str:
    """A ticket description or comment (rich-editor HTML) as plain text."""
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", s or "")
    s = re.sub(r"<[^>]*>", "", s)
    s = html_lib.unescape(s).replace("\xa0", " ")
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def text_to_html(s: str) -> str:
    """Plain text typed in What's New, as the ticket thread stores it."""
    lines = (s or "").strip().split("\n")
    return "".join(f"<p>{html_lib.escape(line) or '<br>'}</p>" for line in lines)


def subject_from(note: str) -> str:
    first = next((ln.strip() for ln in (note or "").splitlines() if ln.strip()), "Feature request")
    return first if len(first) <= 90 else first[:87].rstrip() + "..."


def _ticket_text(t) -> str:
    """What a ticket filed in Tickets asks for, for the What's New card."""
    tf = t.type_fields if isinstance(t.type_fields, dict) else {}
    parts = [html_to_text(t.description or "")]
    if not parts[0]:
        parts = [str(tf.get("currentProblem") or "").strip(), str(tf.get("proposedSolution") or "").strip()]
    text = "\n\n".join(p for p in parts if p)
    return text or (t.subject or "")


def _module_of(t) -> str:
    tf = t.type_fields if isinstance(t.type_fields, dict) else {}
    return str(tf.get("svc_helpSubtopic") or tf.get("module") or "").strip()


# ── Filing from What's New ─────────────────────────────────────────────────

def file_from_whats_new(db, user: dict, background_tasks, note: str, module: str = "",
                        entry_id: str = ""):
    """File the Feature Request ticket for a request typed in What's New and
    return its What's New card (the changelog_feedback row after_filed made)."""
    from routers import tickets
    note = (note or "").strip()[:2000]
    module = (module or "").strip()[:80]
    type_fields = {"currentProblem": note}
    if module:
        type_fields["svc_helpSubtopic"] = module
    body = tickets.TicketBody(subject=subject_from(note), description=text_to_html(note),
                              type="feature_request", priority="medium", application="Nexus",
                              type_fields=type_fields)
    out = tickets.file_ticket(body, background_tasks, user, db,
                              whats_new={"note": note, "module": module, "entry_id": entry_id or ""})
    F = models.ChangelogFeedback
    return db.query(F).filter(F.ticket_id == out["id"]).first()


def after_filed(db, t, background_tasks, whats_new: dict | None = None) -> None:
    """A feature_request ticket was just committed (tickets.file_ticket): give
    it its What's New card, and queue its post to the feedback chat. Commits.
    Never raises - the ticket is filed whatever happens here."""
    try:
        F = models.ChangelogFeedback
        if db.query(F).filter(F.ticket_id == t.id).first() is None:
            wn = whats_new or {}
            db.add(F(id=gen_id(), entry_id=wn.get("entry_id") or "", email=(t.requester_email or "").lower(),
                     kind="request", helpful=1, note=(wn.get("note") or _ticket_text(t))[:2000],
                     created_at=t.created_at or now_iso(), status="",
                     module=(wn.get("module") or _module_of(t))[:80], ticket_id=t.id))
        row = queue_chat_post(db, t, (whats_new or {}).get("note") or "")
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        print(f"[feature-requests] after_filed {t.id}: {e}")
        return
    if row is not None:
        from routers.tickets import _deliver_teams_dm
        background_tasks.add_task(_deliver_teams_dm, row.id)


# ── The Teams post ─────────────────────────────────────────────────────────

def chat_html(db, t, note: str = "") -> str:
    from app_url import app_url
    from ticket_code import ticket_no
    from ticket_notify import _name_of
    import ticket_mail_templates as tmpl
    e = html_lib.escape
    text = (note or _ticket_text(t)).strip()
    if len(text) > 800:
        text = text[:797].rstrip() + "..."
    body = "<br>".join(e(line) for line in text.splitlines())
    module = _module_of(t)
    who = _name_of(db, t.requester_email or "") or (t.requester_email or "")
    meta = f"From {e(who)}" + (f" · {e(module)}" if module else "")
    link = tmpl._ticket_url(app_url(), t.id)
    return (f"<p><strong>New Feature Request</strong> · {e(ticket_no(t.code))}</p>"
            f"<p><strong>{e(t.subject or '')}</strong></p>"
            + (f"<p>{body}</p>" if body and text != (t.subject or "").strip() else "")
            + f"<p>{meta}</p>"
            + (f'<p><a href="{e(link)}">Open in Nexus</a> - reply on the ticket so the whole conversation stays in one place.</p>'
               if link != "#" else ""))


def queue_chat_post(db, t, note: str = ""):
    """Queue (not send) the feedback-chat post for a new feature_request
    ticket. Caller commits, then hands the row to _deliver_teams_dm."""
    requester = (t.requester_email or "").strip().lower()
    if not requester:
        return None
    row = models.TicketTeamsMessage(id=gen_id(), ticket_id=t.id, agent_email=requester,
                                    requester_email=requester, html=chat_html(db, t, note),
                                    created_at=now_iso(), kind=KIND)
    db.add(row)
    return row


def _cached_chat_id(db) -> str:
    s = db.query(models.NexusSetting).filter(models.NexusSetting.key == CHAT_ID_KEY).first()
    if not s:
        return ""
    try:
        v = json.loads(s.value or "{}")
    except (TypeError, ValueError):
        return ""
    return v.get("chatId", "") if v.get("topic") == chat_topic() else ""


def _remember_chat_id(db, chat_id: str) -> None:
    s = db.query(models.NexusSetting).filter(models.NexusSetting.key == CHAT_ID_KEY).first()
    if s is None:
        s = models.NexusSetting(key=CHAT_ID_KEY)
        db.add(s)
    s.value = json.dumps({"topic": chat_topic(), "chatId": chat_id})


def find_chat(token: str) -> str:
    """The id of the chat named chat_topic() among the token user's chats, or ''."""
    want = chat_topic().lower()
    url = f"{GRAPH}/me/chats?$top=50"
    for _ in range(MAX_CHAT_PAGES):
        r = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=15)
        if r.status_code >= 400:
            raise RuntimeError(f"Graph {r.status_code}: {r.text[:120]}")
        data = r.json()
        for c in data.get("value") or []:
            if (c.get("topic") or "").strip().lower() == want:
                return c.get("id") or ""
        url = data.get("@odata.nextLink")
        if not url:
            break
    return ""


def _posters(db, row) -> list:
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == row.ticket_id).first()
    out = [(row.requester_email or "").lower(), (getattr(t, "assignee_email", "") or "").lower(), *_env_posters()]
    return list(dict.fromkeys(e for e in out if e))


def deliver(db, row) -> bool:
    """One delivery attempt for a claimed feedback-chat row (teams_post.
    deliver_ticket_row calls this after _claim). Commits the outcome."""
    import bff_session
    from teams_post import send_chat_message
    errors = []
    cached = row.chat_id or _cached_chat_id(db)
    for who in _posters(db, row):
        tok = bff_session.graph_token_for_email(db, who)
        if not tok:
            errors.append(f"{who}: no Teams session")
            continue
        try:
            chat_id = cached or find_chat(tok)
            if not chat_id:
                errors.append(f"{who}: not in a chat named {chat_topic()}")
                continue
            send_chat_message(tok, chat_id, row.html)
        except Exception as e:  # noqa: BLE001 - next person may be in the chat
            errors.append(f"{who}: {str(e)[:120]}")
            continue
        row.chat_id, row.agent_email, row.sent, row.send_error = chat_id, who, 1, ""
        _remember_chat_id(db, chat_id)
        db.commit()
        return True
    if cached and not row.chat_id:
        # Nobody could post into the remembered chat: look it up afresh next time.
        _remember_chat_id(db, "")
    row.send_error = ("; ".join(errors) or "nobody to post as")[:300]
    db.commit()
    return False


# ── One status story (Oct 23 2026) ─────────────────────────────────────────
# The request's status (set in What's New > Manage) leads and the ticket
# follows it; a ticket finished or reopened in Tickets moves the request too,
# so neither side is left looking open while the other is done.
#
#   request New                              -> ticket Open
#   request Under Review / Planned / In Prog -> ticket In Progress
#                                               (a Waiting ticket stays Waiting)
#   request Shipped                          -> ticket Resolved (note = resolution)
#   request Declined                         -> ticket Closed   (note = reason)
#
#   ticket Resolved                          -> request Shipped  (unless already done)
#   ticket Closed                            -> request Declined (unless already done)
#   ticket reopened from Resolved / Closed   -> request In Progress
#   any other ticket move                    -> request unchanged
#
# The ticket's own resolved/closed email and Teams message are NOT sent for a
# change made from What's New: the requester's What's New bell is the one
# notice. FROM_REQUEST marks a ticket write made here so the flush hook
# (feature_request_sync.py) does not echo it back onto the request.

FROM_REQUEST = "_nx_status_from_request"
DONE = ("resolved", "closed")
TICKET_FOR_REQUEST = {"New": "open", "Under Review": "in_progress", "Planned": "in_progress",
                      "In Progress": "in_progress", "Shipped": "resolved", "Declined": "closed"}


def push_status_to_ticket(db, r, actor_email: str) -> str:
    """The request's status just changed in What's New: move its ticket to
    match. Returns the ticket status set ('' when nothing moved). Caller commits."""
    import ticket_sla
    import ticket_mail_templates as tmpl
    from routers.task_util import log_activity
    if not getattr(r, "ticket_id", ""):
        return ""
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == r.ticket_id).with_for_update().first()
    status = r.status or "New"
    target = TICKET_FOR_REQUEST.get(status)
    if t is None or not target or t.status == target:
        return ""
    if target == "in_progress" and (t.status or "") in ticket_sla.WAITING_STATUSES:
        return ""                     # the desk is waiting on someone - leave it waiting
    setattr(t, FROM_REQUEST, True)
    ticket_sla.set_status(t, target)
    now = now_iso()
    if target in DONE:
        t.resolved_at = t.resolved_at or now
        t.resolution_note = ((r.status_note or "").strip() or f"{status} in What's New.")[:2000]
    else:
        t.resolved_at, t.resolution, t.resolution_note = "", "", ""
    t.modified_at = now
    log_activity(db, type="status_changed", actor_email=actor_email, entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail=f"changed status to {tmpl.status_label(target)} (request marked {status} in What's New)")
    return target


def request_status_for(old: str, new: str, current: str) -> str:
    """What a ticket move from `old` to `new` makes its request, or ''."""
    done = current in ("Shipped", "Declined")
    if new == "resolved" and not done:
        return "Shipped"
    if new == "closed" and not done:
        return "Declined"
    if (old or "") in DONE and new not in DONE and done:
        return "In Progress"
    return ""


def pull_status_from_ticket(db, t, old: str) -> None:
    """A feature_request ticket's status moved (any path - the flush hook
    calls this): carry it onto the request and ring the requester. Never
    raises into the flush."""
    from routers.changelog_lifecycle import _status, notify_request
    F = models.ChangelogFeedback
    with db.no_autoflush:
        r = db.query(F).filter(F.ticket_id == t.id, F.kind == "request").first()
        if r is None:
            return
        target = request_status_for(old, t.status or "", _status(r))
        if not target:
            return
        r.status = target
        if target in ("Shipped", "Declined"):
            r.status_note = (t.resolution_note or "").strip()[:1000]
        r.status_by, r.status_at = "ticket", now_iso()
        if r.notified_status == target:
            r.notified_status = ""
        notify_request(db, r)
