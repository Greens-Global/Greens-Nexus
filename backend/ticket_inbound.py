"""Inbound email -> tickets (Email to Ticket, Oct 2026 - step 4 of the ticket plan).

The support mailbox (`inboundMailbox` in ticket_notify_config, e.g.
support@greensglobal.com) is read every minute. Each message becomes one of:

  comment   a REPLY to a ticket email: a public comment on that ticket by
            whoever sent it;
  created   a NEW email from an active, internal Nexus person: a new ticket
            they are the requester of;
  refused   nothing - logged with the reason.

**Created and commented through the app's own paths.** A new ticket goes
through routers/tickets.file_ticket - the function POST /task-tickets runs -
so the approval gate, the default assignee (ticket_auto_assign), the honest
SLA clock (ticket_sla.start), the requester's "we received your ticket" email
and the desk's notice all happen exactly as for a ticket filed in the app. A
reply goes through routers/tickets.post_ticket_comment - what POST
/task-tickets/{id}/comments runs - after the SAME permission check
(_require_ticket_participant: the requester, whoever filed it for them, a
collaborator, the pending approver, or a desk agent inside the company wall),
so bells, mentions, history, the first-response stamp, the email and the Teams
message are identical. An emailed reply is never an internal note. Never write
a TaskTicket or TaskComment row from here directly.

**How a reply finds its ticket**, strongest first (resolve_ticket):
  address       every ticket email's Reply-To is `support+t<id>.<sig>@...`
                while this is on (ticket_inbound_parse.outbound_reply_to).
                Signed, so it cannot be forged or tampered into another ticket.
                Survives every client's Reply / Reply All.
  headers       In-Reply-To / References against the internetMessageId of the
                mail we sent. graph_mail sends by create-draft -> send, and the
                draft's id IS the sent message's Message-ID, so ticket_email_log
                already stores it - no header of our own is needed (Graph only
                accepts custom headers prefixed X-, so a Message-ID of our own
                cannot be set anyway). Empty when the sender mailbox only has
                Mail.Send (graph_mail falls back to /sendMail), which is why it
                is not the first route.
  conversation  Outlook's thread id against what we sent, same as Tasks.
  thread        In-Reply-To / References / thread id against messages that
                already became a ticket or comment - so Reply All on the
                ORIGINAL email (before any ticket email exists) lands on that
                ticket instead of filing a second one.
  subject       "Ticket #12" in the subject (every ticket email's subject starts
                with it), only for a ticket the sender may comment on; when
                there is none, the email is simply a new one.
A message that names a ticket by address, headers, conversation or thread but
cannot be used (the ticket is gone, or the sender may not comment on it) is
refused - never turned into a second, new ticket.

**Sender authenticity**: behind the domain's DMARC p=reject, Exchange's own
verdict (Authentication-Results / ARC, X-MS-Exchange-Organization-AuthAs) is
read by mail_inbound.auth_verdict - a fail is refused, and the row keeps what
was seen. **Emailed mailto links** are unwrapped unless written as an
@mention of someone who can see the ticket (unwrap_mailtos) - in the drawer a
mailto link is a mention, and a mention adds a watcher.

**Gated three ways**, exactly like Tasks: `inboundEnabled` (off by default),
the deployed worker only (leader.is_deployed_worker, in main.py and again in the
loop body), and a Postgres advisory lock of its own. It never reads the Tasks
reply mailbox: saving that address is refused (clean_settings_patch), and a
drain whose mailbox matches it does nothing.

**Every message gets a TicketInboundEmail row**, refusals included. There is
no auto-reply to a refused sender: answering mail that may itself be automated
is how a mail loop starts. New tickets are capped per sender per hour
(NEW_TICKETS_PER_HOUR) so a forwarding rule gone wrong cannot file hundreds.

Attachments go to the PRIVATE ticket-evidence bucket the drawer uploads to,
stored as canonical URLs (opened through /files/view), and recorded through
routers/tickets.record_ticket_attachment. Best effort per file, like Tasks.
"""
import asyncio
import html as html_lib
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import BackgroundTasks, HTTPException

import graph_mail
import mail_inbound
import models
import task_files
import task_inbound_parse as body_parse
import ticket_inbound_parse as parse
import ticket_notify
from database import SessionLocal
from ticket_code import ticket_no

_LOOP_SEC = 60
# main.py staggers its loops' first runs; task_inbound takes 120, this the next
# free slot.
_STARTUP_DELAY_SEC = 135
# Distinct from task_inbound's (0x7A5C0DE1), the ticket-code lock (7310052) and
# every other advisory lock in the app: the two drains must never block each
# other, and neither must ever share a pass.
_LOCK_KEY = 0x71C4E7B0
EVIDENCE_BUCKET = "ticket-evidence"

# A forwarding rule pointed at the mailbox, or a person's mail client stuck
# re-sending, must not become hundreds of tickets. Past this many NEW tickets
# from one sender in an hour the rest are refused (replies are not limited).
NEW_TICKETS_PER_HOUR = 10
# The raw message, before any cleaning. Past this it is refused rather than
# parsed - a body this size is a newsletter or a mistake, not a request. What
# survives cleaning is then capped like a Tasks reply (MAX_BODY_CHARS).
MAX_RAW_BODY_CHARS = 1_000_000
# CC'd colleagues become collaborators on a new ticket - at most this many.
MAX_CC_COLLABORATORS = 20

_VIDEO_EXT = (".mp4", ".mov", ".webm", ".m4v", ".avi")

# Graph, re-exported so tests stub them on this module (see file_files).
list_unread = mail_inbound.list_unread
get_message = mail_inbound.get_message
list_attachments = mail_inbound.list_attachments
fetch_attachment_bytes = mail_inbound.fetch_attachment_bytes
fetch_attachment = mail_inbound.fetch_attachment


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Config ───────────────────────────────────────────────────────────────────
def mailbox_of(cfg: dict) -> str:
    return (cfg.get("inboundMailbox") or "").strip().lower()


def is_enabled(cfg: dict) -> bool:
    return bool(cfg.get("inboundEnabled")) and "@" in mailbox_of(cfg)


def tasks_mailbox(db) -> str:
    """The mailbox the Tasks drain reads (task_inbound_parse.reply_mailbox) -
    the one this must never be."""
    import task_notify
    return body_parse.reply_mailbox(task_notify.get_settings(db))


def _own_mailboxes(db, cfg: dict) -> list[str]:
    """Every mailbox the app itself sends from or reads. Mail FROM one of these
    is ours coming back (a notification bouncing round), never a person."""
    import task_notify
    tcfg = task_notify.get_settings(db)
    return [m for m in (mailbox_of(cfg), cfg.get("fromMailbox") or "", graph_mail.DEFAULT_FROM_EMAIL or "",
                        body_parse.reply_mailbox(tcfg), tcfg.get("fromMailbox") or "") if m and "@" in m]


def clean_settings_patch(db, patch: dict, user: dict | None = None) -> dict:
    """The inbound half of a ticket notification settings save, checked.
    Raises ValueError with the reason to show (PermissionError when the
    caller may not change it). Leaves every other key alone.

      - inboundEnabled / inboundMailbox: changed by Global Admins only;

      - inboundMailbox: an address, and never the Tasks reply mailbox (two
        drains must never read one mailbox - each would mark the other's mail
        read and file it away);
      - inboundDefaultDepartment: {companyId: departmentId}, each department
        one of THAT company's (People > Companies > Departments). Behind
        the company wall: `user` sets or clears entries only for companies
        their scope admits (auth.company_ok); every other company's entry is
        kept exactly as stored, whatever the patch says about it."""
    patch = dict(patch or {})
    current = ticket_notify.get_settings(db)
    if user is not None:
        import auth
        # The switch and the mailbox are the whole workspace's - Global
        # Admins only. The settings form sends its whole copy back, so only a
        # CHANGE is refused; company supervisors still set their own
        # company's default department.
        changes = (("inboundEnabled" in patch
                    and bool(patch.get("inboundEnabled")) != bool(current.get("inboundEnabled")))
                   or ("inboundMailbox" in patch
                       and str(patch.get("inboundMailbox") or "").strip().lower() != mailbox_of(current)))
        if changes and not auth.is_global_admin(user, db):
            raise PermissionError("Only a Global Admin can turn Email to Ticket on or off or change its mailbox.")
    if "inboundMailbox" in patch:
        mb = str(patch.get("inboundMailbox") or "").strip().lower()
        if mb and ("@" not in mb or " " in mb):
            raise ValueError("The support mailbox must be an email address.")
        patch["inboundMailbox"] = mb
    if "inboundEnabled" in patch:
        patch["inboundEnabled"] = bool(patch.get("inboundEnabled"))
    mailbox = patch.get("inboundMailbox", mailbox_of(current))
    enabled = patch.get("inboundEnabled", bool(current.get("inboundEnabled")))
    if mailbox and mail_inbound.same_mailbox(mailbox, tasks_mailbox(db)):
        raise ValueError("That is the Tasks reply mailbox. Email to ticket needs its own mailbox - "
                         "two readers on one mailbox would take each other's mail.")
    if enabled and not mailbox:
        raise ValueError("Enter the support mailbox to read before turning on email to ticket.")
    if "inboundDefaultDepartment" in patch:
        raw = patch.get("inboundDefaultDepartment") or {}
        if not isinstance(raw, dict):
            raise ValueError("Default departments must be a company-to-department map.")
        import auth
        scope = auth.company_scope(user, db) if user is not None else None
        stored = current.get("inboundDefaultDepartment") or {}
        # Not theirs to change: kept as stored, never taken from the patch.
        out = {c: d for c, d in stored.items() if not auth.company_ok(c, scope)}
        for cid, did in raw.items():
            cid, did = str(cid or "").strip(), str(did or "").strip()
            if not cid or not did or not auth.company_ok(cid, scope):
                continue
            dept = (db.query(models.HrDepartment)
                    .filter(models.HrDepartment.id == did, models.HrDepartment.company_id == cid).first())
            if dept is None:
                if stored.get(cid) == did:
                    continue    # deleted since it was chosen: dropped, not a reason to block the save
                raise ValueError("A default department must be one of that company's departments.")
            out[cid] = did
        patch["inboundDefaultDepartment"] = out
    return patch


# ── Who sent it ──────────────────────────────────────────────────────────────
def _user_for(db, email: str) -> dict:
    """The signed-in user dict get_current_user would build for this person -
    the identity every permission check in routers/tickets.py takes."""
    import auth
    role, level = auth._role_for((email or "").lower(), db)
    return {"email": (email or "").lower(), "role": role, "level": level}


def _employee(db, email: str):
    from sqlalchemy import func
    return (db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.work_email) == (email or "").lower()).first())


def resolve_sender(db, from_email: str) -> tuple[str, str]:
    """(nexus email, refusal reason). mail_inbound.resolve_person - the rule
    the Tasks drain uses - and then: on the Nexus People list, active and
    internal. There is no public portal (agreed): a guest or external account
    cannot email the desk, and nor can a role holder with no People record
    (their ticket would have no company)."""
    from routers import tickets as T
    # resolve_person matches on the local part only on our own domains, so
    # "neil@gmail.com" is never read as neil@greensglobal.com.
    author, why = mail_inbound.resolve_person(db, (from_email or "").strip().lower())
    if not author:
        return "", why
    emp = _employee(db, author)
    if emp is not None and (emp.identity_type or "") in ("guest", "external"):
        return "", f"{author} is a guest or external account (there is no public portal)"
    if not T._internal_person(db, author):
        return "", f"{author} is not an active person on the Nexus People list"
    return author, ""


# ── Which ticket ─────────────────────────────────────────────────────────────
def _live_ticket(db, ticket_id: str):
    # A confidential (Ask HR) ticket is found too: a reply to its email lands
    # on it - comment_refusal (the API's own reader rule, may_read included)
    # decides every comment before it is posted.
    import ticket_confidential
    return (ticket_confidential.include(db.query(models.TaskTicket))
            .filter(models.TaskTicket.id == ticket_id).first()) if ticket_id else None


def resolve_ticket(db, cfg: dict, msg: dict, headers: dict, user: dict | None = None):
    """(ticket, how). `how` without a ticket = the message names a ticket that
    no longer exists (refused, never a new ticket). (None, "") = a new email.
    Routes, strongest first (the module docstring has why):

      address       the signed plus address;
      headers       In-Reply-To / References = mail we sent (ticket_email_log);
      conversation  Outlook's thread id = mail we sent;
      thread        In-Reply-To / References / thread id = a message that
                    already became a ticket or a comment (ticket_inbound_email)
                    - Reply All on the ORIGINAL email lands on its ticket, not
                    on a second one;
      subject       "Ticket #N" in the subject - only a ticket `user` may
                    comment on (newest first, if legacy codes repeat); none =
                    a new email."""
    tid = parse.ticket_id_from_recipients(mailbox_of(cfg), mail_inbound.recipients_of(msg))
    if tid:
        return _live_ticket(db, tid), "address"

    L = models.TicketEmailLog
    refs = mail_inbound.referenced_ids(headers)
    if refs:
        row = (db.query(L).filter(L.internet_message_id.in_(refs), L.internet_message_id != "")
               .order_by(L.created_at.desc()).first())
        if row:
            return _live_ticket(db, row.ticket_id), "headers"

    conv = (msg.get("conversationId") or "").strip()
    if conv:
        row = (db.query(L).filter(L.conversation_id == conv)
               .order_by(L.created_at.desc()).first())
        if row:
            return _live_ticket(db, row.ticket_id), "conversation"

    E = models.TicketInboundEmail
    seen = []
    if refs:
        seen.append(E.internet_message_id.in_(refs))
    if conv:
        seen.append(E.conversation_id == conv)
    if seen:
        from sqlalchemy import or_
        row = (db.query(E).filter(or_(*seen), E.ticket_id != "", E.outcome.in_(("created", "comment")))
               .order_by(E.processed_at.desc()).first())
        if row:
            return _live_ticket(db, row.ticket_id), "thread"

    code = parse.subject_ticket_code(msg.get("subject") or "")
    if code and user is not None:
        import ticket_confidential
        for t in (ticket_confidential.include(db.query(models.TaskTicket)).filter(models.TaskTicket.code == code)
                  .order_by(models.TaskTicket.created_at.desc(), models.TaskTicket.id).all()):
            if not comment_refusal(db, user, t):
                return t, "subject"
    return None, ""


def comment_refusal(db, user: dict, t) -> str:
    """"" when this person may comment on this ticket by the API's own rule
    (_conversation_ticket_or_404 + _require_ticket_participant), else why not."""
    from routers import tickets as T
    try:
        T._conversation_ticket_or_404(db, t.id, confidential=True)
        T._require_ticket_participant(db, user, t)
    except HTTPException:
        return f"{user['email']} cannot comment on {ticket_no(t.code) or 'that ticket'}"
    return ""


# ── Body ─────────────────────────────────────────────────────────────────────
def _raw(part: dict | None) -> tuple[str, str]:
    part = part or {}
    return (part.get("content") or ""), (part.get("contentType") or "html").lower()


def _new_part(msg: dict) -> tuple[str, str]:
    """The message's new words: Exchange's uniqueBody (quoted history already
    removed), else the whole body - the same preference the Tasks drain has."""
    content, ctype = _raw(msg.get("uniqueBody"))
    if content.strip():
        return content, ctype
    return _raw(msg.get("body"))


def _clean(content: str, ctype: str) -> str:
    return (body_parse.clean_body(text=content) if ctype == "text"
            else body_parse.clean_body(html=content))


def _description(msg: dict) -> str:
    """A new ticket's description. The new words (uniqueBody) first; when
    that is empty - a forward with nothing typed above it - the forwarded
    message itself, sanitized, is the request."""
    content, ctype = _new_part(msg)
    out = _clean(content, ctype)
    if out:
        return out
    content, ctype = _raw(msg.get("body"))
    if ctype == "text":
        out = body_parse.plain_to_html(content)
    else:
        out = body_parse.sanitize_html(content)
    if not body_parse.has_text(out):
        return ""
    if len(out) > body_parse.MAX_BODY_CHARS:
        out = out[:body_parse.MAX_BODY_CHARS] + "<p>[This email was truncated]</p>"
    return out


_MAILTO_A = re.compile(r'<a href="mailto:([^"]*)">(.*?)</a>', re.I | re.S)


def unwrap_mailtos(db, t, html: str) -> str:
    """An emailed reply's mailto links, made safe for the mention parser.

    In the drawer a mailto link IS a mention, and a mention puts that person
    on the ticket. In an email, mailto links are mostly a signature or an
    address someone typed - so each is unwrapped to its text, unless its text
    starts with "@" (written as a mention) AND the address is an active
    internal person whose company can see this ticket."""
    from routers import tickets as T

    def keep(m):
        email = html_lib.unescape(m.group(1)).split("?", 1)[0].strip().lower()
        text = re.sub(r"<[^>]*>", "", m.group(2))
        if text.strip().startswith("@") and T._internal_person(db, email):
            emp = _employee(db, email)
            company = (t.company_id or "").strip()
            if emp is not None and (not company or (emp.company or "") == company):
                return m.group(0)
        return m.group(2)

    return _MAILTO_A.sub(keep, html or "")


# ── Attachments ──────────────────────────────────────────────────────────────
def file_files(db, cfg: dict, msg: dict, t, user: dict, kept_html: str,
               atts: list[dict]) -> tuple[int, list[str]]:
    """File a message's attachments onto a ticket (mail_inbound.file_attachments):
    bytes into the private ticket-evidence bucket, each one recorded by
    routers/tickets.record_ticket_attachment like a drawer upload. A OneDrive
    link is not filed - a ticket's files must be our storage
    (items._validate_photo_url) - and is named in the row instead."""
    from routers import tickets as T
    from routers.items import _validate_photo_url

    def store(name, raw, content_type):
        return task_files.store_bytes(name, raw, content_type, bucket=EVIDENCE_BUCKET, folder="email")

    def add_row(*, name, url, kind, size):
        try:
            _validate_photo_url(url, "Attachment url")
        except HTTPException:
            raise ValueError("a shared link, not a file - attach the file itself") from None
        if (name or "").lower().endswith(_VIDEO_EXT):
            kind = "video"
        T.record_ticket_attachment(db, t, user, name=name[:250], size=size, kind=kind, url=url)

    stored, skips = mail_inbound.file_attachments(
        mailbox_of(cfg), msg, atts, kept_html, store=store, add_row=add_row,
        fetch_detail=lambda *a: fetch_attachment(*a),
        fetch_bytes=lambda *a: fetch_attachment_bytes(*a))
    if stored:
        db.commit()
    return stored, skips


def _list_files(cfg: dict, msg: dict) -> list[dict]:
    if not msg.get("hasAttachments"):
        return []
    try:
        return list_attachments(mailbox_of(cfg), msg.get("id") or "")
    except Exception as e:
        print(f"[ticket-inbound] could not list attachments: {e}")
        return []


def _run_after(bt: BackgroundTasks) -> None:
    """The route's after-the-response work (emails, Teams messages), run here
    in order - this already is a worker thread, nobody is waiting on it."""
    for task in list(bt.tasks):
        try:
            task.func(*task.args, **task.kwargs)
        except Exception as e:
            print(f"[ticket-inbound] follow-up failed: {e}")


def _collaborators(db, cfg: dict, msg: dict, author: str) -> list[str]:
    """Colleagues on the To / CC line of a new email: active internal Nexus
    people of the sender's company, not the sender and not one of our own
    mailboxes."""
    from routers import tickets as T
    own = _own_mailboxes(db, cfg)
    company = T.company_for(db, author)
    out = []
    for addr in mail_inbound.recipients_of(msg):
        if any(mail_inbound.same_mailbox(addr, m) for m in own):
            continue
        email, _why = resolve_sender(db, addr)
        # Only colleagues of the ticket's own company: someone behind the
        # company wall could not open it anyway.
        if email and email != author and email not in out and T.company_for(db, email) == company:
            out.append(email)
        if len(out) >= MAX_CC_COLLABORATORS:
            break
    return out


def _new_tickets_last_hour(db, emails: set) -> int:
    E = models.TicketInboundEmail
    since = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    return (db.query(E).filter(E.outcome == "created", E.from_email.in_(sorted(emails)),
                               E.processed_at >= since).count())


# ── Ingest ───────────────────────────────────────────────────────────────────
def ingest_message(db, cfg: dict, msg: dict) -> str:
    """One fetched message -> a comment, a new ticket, or a row saying why
    neither. Returns the outcome written (or "duplicate")."""
    from routers import tickets as T

    msg_id = msg.get("id") or ""
    imid = (msg.get("internetMessageId") or "").strip() or f"graph:{msg_id}"
    E = models.TicketInboundEmail
    earlier = db.query(E).filter(E.internet_message_id == imid).first()
    if earlier is not None:
        # Seen again: the outcome committed but the message was never marked
        # handled (a crash or Graph error after the commit). Nothing is done
        # twice - and the row says what the crash may have cost.
        note = ("ticket already created; files/receipt may be missing" if earlier.outcome == "created"
                else "comment already posted; files/emails may be missing" if earlier.outcome == "comment"
                else "")
        if note and note not in (earlier.reason or ""):
            earlier.reason = "; ".join(x for x in (earlier.reason, note) if x)[:500]
            db.commit()
        return "duplicate"

    headers = mail_inbound.headers_of(msg)
    sender = mail_inbound.sender_of(msg)
    row = E(id=str(uuid.uuid4()), internet_message_id=imid, graph_message_id=msg_id,
            conversation_id=(msg.get("conversationId") or ""), from_email=sender,
            subject=(msg.get("subject") or "")[:500],
            # Provisional, as in Tasks: overwritten with the files actually
            # filed; on a refusal it stays 1 as a flag that files were lost.
            attachment_count=1 if msg.get("hasAttachments") else 0,
            received_at=(msg.get("receivedDateTime") or ""), status="failed", outcome="failed",
            processed_at=_now())

    def finish(outcome: str, reason: str = "", status: str = "") -> str:
        row.outcome = outcome
        row.status = status or {"comment": "posted", "created": "posted",
                                "refused": "rejected"}.get(outcome, "failed")
        row.reason, row.processed_at = (reason or "")[:500], _now()
        db.add(row)
        db.commit()
        return outcome

    # ── never a person ──
    if not sender or any(mail_inbound.same_mailbox(sender, m) for m in _own_mailboxes(db, cfg)):
        return finish("refused", "mail from one of our own mailboxes", status="ignored")
    if body_parse.is_auto_reply(headers):
        return finish("refused", "automated mail (out-of-office, bounce, list or a forwarding rule)",
                      status="ignored")
    # Defense in depth behind DMARC p=reject (mail_inbound.auth_verdict).
    authentic, row.auth_summary = mail_inbound.auth_verdict(msg)
    if not authentic:
        return finish("refused", "sender failed authentication")
    raw_len = max(len(_raw(msg.get("body"))[0]), len(_raw(msg.get("uniqueBody"))[0]))
    if raw_len > MAX_RAW_BODY_CHARS:
        return finish("refused", f"the message is too large (over {MAX_RAW_BODY_CHARS // 1000} KB of text)")

    # ── who ──
    author, why = resolve_sender(db, sender)
    if not author:
        return finish("refused", why)
    user = _user_for(db, author)

    # ── a reply? ──
    t, how = resolve_ticket(db, cfg, msg, headers, user)
    row.matched_by = how
    if how and t is None:
        return finish("refused", "the ticket this replies to no longer exists")
    if t is not None:
        row.ticket_id = t.id
        refusal = comment_refusal(db, user, t)
        if refusal:
            return finish("refused", refusal)
        content, ctype = _new_part(msg)
        text = unwrap_mailtos(db, t, _clean(content, ctype))
        kept_html = body_parse.strip_quoted_html(content) if ctype != "text" else ""
        files = _list_files(cfg, msg)          # Graph, before the row lock below
        # Locked like the route: an @mention adds watchers (a JSON read-modify-write).
        t = T._conversation_ticket_or_404(db, t.id, lock=True, confidential=True)
        if not text and not files:
            return finish("refused", "reply had no new text (only quoted history or a signature)",
                          status="ignored")
        row.outcome, row.status, row.reason = "comment", "posted", ""
        db.add(row)                   # committed with the comment, in one transaction
        bt = BackgroundTasks()
        if text:
            try:
                c = T.post_ticket_comment(db, t, user, text, False, bt)
            except Exception as e:
                db.rollback()
                return finish("failed", f"could not post the comment: {e}")
            row.comment_id = c.id
        else:
            db.commit()               # files only: no empty comment, the files say it
            row.reason = "files only, no text"
        if files:
            stored, skips = file_files(db, cfg, msg, t, user, kept_html, files)
            row.attachment_count = stored
            if skips:
                row.reason = "; ".join(([row.reason] if row.reason else []) + skips)[:500]
        else:
            row.attachment_count = 0
        row.processed_at = _now()
        db.commit()
        _run_after(bt)
        return "comment"

    # ── a new ticket ──
    company = T.company_for(db, author)
    dept_id = ((cfg.get("inboundDefaultDepartment") or {}).get(company) or "") if company else ""
    dept = (db.query(models.HrDepartment)
            .filter(models.HrDepartment.id == dept_id, models.HrDepartment.company_id == company).first()
            if dept_id else None)
    if dept is None:
        return finish("refused", "no default department is set for the sender's company")
    if _new_tickets_last_hour(db, {sender, author}) >= NEW_TICKETS_PER_HOUR:
        return finish("refused", f"over the limit of {NEW_TICKETS_PER_HOUR} new tickets an hour from one sender")

    subject = parse.clean_subject(msg.get("subject") or "")
    description = _description(msg)
    files = _list_files(cfg, msg)
    if not subject and not description and not files:
        return finish("refused", "empty email (no subject, text or files)", status="ignored")
    content, ctype = _new_part(msg)
    kept_html = body_parse.strip_quoted_html(content) if ctype != "text" else ""

    body = T.TicketBody(subject=subject or "(No Subject)", description=description, type="other",
                        priority="medium", hr_department_id=dept.id, requester_email="",
                        watcher_emails=_collaborators(db, cfg, msg, author))
    row.outcome, row.status, row.reason = "created", "posted", ""
    db.add(row)                       # committed with the ticket, in one transaction
    bt = BackgroundTasks()
    try:
        out = T.file_ticket(body, bt, user, db, arrived_by="email")
    except HTTPException as e:
        db.rollback()
        return finish("refused", f"the ticket could not be filed: {e.detail}")
    except Exception as e:
        db.rollback()
        return finish("failed", f"the ticket could not be filed: {e}")
    row.ticket_id = out["id"]
    row.matched_by = ""
    if files:
        t = db.query(models.TaskTicket).filter(models.TaskTicket.id == out["id"]).first()
        stored, skips = file_files(db, cfg, msg, t, user, kept_html, files)
        row.attachment_count = stored
        if skips:
            row.reason = "; ".join(skips)[:500]
    else:
        row.attachment_count = 0
    row.processed_at = _now()
    db.commit()
    _run_after(bt)
    return "created"


# ── Drain ────────────────────────────────────────────────────────────────────
def drain_once(db) -> dict:
    """One pass over the unread mail. Synchronous by design - the caller runs it
    in a thread (CLAUDE.md: a blocking Graph call on the event loop freezes
    every request the worker is serving)."""
    counts = {"seen": 0, "comment": 0, "created": 0, "refused": 0, "failed": 0, "duplicate": 0}
    cfg = ticket_notify.get_settings(db)
    if not is_enabled(cfg):
        return counts
    mailbox = mailbox_of(cfg)
    if mail_inbound.same_mailbox(mailbox, tasks_mailbox(db)):
        # Refused on save; this covers the Tasks side being changed to match
        # later. The Tasks drain keeps the mailbox, this one stands down.
        print("[ticket-inbound] support mailbox is the Tasks reply mailbox - not reading it")
        return counts
    # Held on its own connection for the whole pass (mail_inbound.pass_lock).
    with mail_inbound.pass_lock(db, _LOCK_KEY) as mine:
        if not mine:
            return counts          # another worker is draining
        _drain_batch(db, cfg, mailbox, counts)
    return counts


def _drain_batch(db, cfg: dict, mailbox: str, counts: dict) -> None:
    for stub in list_unread(mailbox):
        msg_id = stub.get("id") or ""
        counts["seen"] += 1
        try:
            msg = get_message(mailbox, msg_id)
            outcome = ingest_message(db, cfg, msg)
        except Exception as e:
            # Not even judged - stays unread and is retried next pass.
            db.rollback()
            print(f"[ticket-inbound] {msg_id}: {e}")
            counts["failed"] += 1
            continue
        counts[outcome] = counts.get(outcome, 0) + 1
        try:
            mail_inbound.mark_handled(mailbox, msg_id, tag="ticket-inbound")
        except Exception as e:
            # The outcome is committed; it comes back next pass and the
            # unique index makes it a no-op.
            print(f"[ticket-inbound] could not mark {msg_id} handled: {e}")


def _drain_in_thread() -> None:
    """The loop's blocking body. Asks is_deployed_worker again here, not only
    in main.py: a laptop pointed at the shared database must never read the
    live support mailbox."""
    import leader
    if not leader.is_deployed_worker():
        return
    db = SessionLocal()
    try:
        counts = drain_once(db)
        if counts["seen"]:
            print(f"[ticket-inbound] {counts}")
    finally:
        db.close()


async def ticket_inbound_loop() -> None:
    """Started once from main.py's lifespan, behind is_deployed_worker(). The
    blocking body runs via asyncio.to_thread, and no exception is ever allowed
    to kill the loop."""
    await asyncio.sleep(_STARTUP_DELAY_SEC)
    while True:
        try:
            await asyncio.to_thread(_drain_in_thread)
        except Exception:
            pass
        await asyncio.sleep(_LOOP_SEC)
