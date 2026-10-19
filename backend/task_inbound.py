"""Inbound email -> task comment (Task Inbound Email, Aug 2026).

Reply to any task notification and the reply becomes a comment on that task,
authored by whoever sent it. The mirror image of task_notify.py, which sends
those notifications; the pure parsing/address half is task_inbound_parse.py.

**The comment is created through routers.task_util.create_comment**, the same
function POST /tasks/{id}/comments calls - so a comment that arrives by email
lands in the activity feed, the bells, Asana and the follow-on notification
mails exactly like one typed into the drawer. Never post a comment from here by
writing a TaskComment row directly; that is the second-inbound-path mistake
CLAUDE.md records against the Asana sync, and it drifts silently.

**Every message gets a TaskInboundEmail row**, including the ones that become
nothing. "I replied and nothing happened" is the question this module will be
asked, and by the time it is asked the message is read and filed - the row is
the only remaining evidence.

**Gated three ways**, because the cost of getting this wrong is posting a
stranger's mail onto a task, or posting the same comment eight times:
  - `inboundEnabled` in task_notify_config, off by default;
  - `is_sync_worker()`, so no developer's laptop drains the shared mailbox;
  - a Postgres advisory lock, because the deployed API is 8 gunicorn PROCESSES
    on one instance and each one starts this loop.

**What is refused**, all logged with a reason rather than silently dropped:
mail from an address that is not a known Nexus person (matched on the local
part - Outlook may deliver from the @greensg.onmicrosoft.com relay for the same
human), a sender who lacks commenter rights on the project, anything
machine-generated (see is_auto_reply - an out-of-office bouncing off the
notification that this very comment triggers is the loop to avoid), and a reply
that resolves to no task.

There is no auto-reply telling a rejected sender why. Answering a mailbox that
just received mail from an auto-responder is how a mail loop starts, and it
needs its own rate limiting to be safe - a follow-up, deliberately not here.

**Attachments are filed, not inlined.** Bytes go to Supabase storage
(task_files.py) and become TaskAttachment rows linked to the comment,
because a `data:` URL in the row would never reach Asana. Files are best effort:
the comment is already committed when they are fetched, so one that will not
download is named in the row's `reason` rather than failing the reply. A reply
that is nothing but photos is still a comment.
"""
import asyncio
import uuid
from datetime import datetime, timezone

import mail_inbound
import models
import task_inbound_parse as parse
import task_notify
from database import SessionLocal
from routers.task_util import (can_comment, create_comment, fire_task_event, gen_id,
                               log_activity, project_for_task)
import task_files

_LOOP_SEC = 60
# main.py's lifespan already staggers its background loops at 15s intervals from
# 60s; this takes the next free slot. A cold start that fires every loop at once
# competes with the first real requests.
_STARTUP_DELAY_SEC = 120
# Distinct from asana_sync's pull lock - the two are unrelated and must not
# block each other.
_LOCK_KEY = 0x7A5C0DE1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Config ───────────────────────────────────────────────────────────────────
def mailbox_of(cfg: dict) -> str:
    """The mailbox to read - resolved by parse.reply_mailbox, the single answer
    the outbound half uses too. They must not compute this separately; see that
    function for what happened when they did."""
    return parse.reply_mailbox(cfg)


def is_enabled(cfg: dict) -> bool:
    return bool(cfg.get("inboundEnabled")) and "@" in mailbox_of(cfg)


# ── Graph and message shape ──────────────────────────────────────────────────
# Shared with ticket_inbound.py (mail_inbound.py, Oct 2026) - moved there
# unchanged and re-exported under the names this module always used, so a test
# that stubs one of them here still reaches every call below.
_GRAPH = mail_inbound.GRAPH
_MSG_FIELDS = mail_inbound.MSG_FIELDS
_ATT_FIELDS = mail_inbound.ATT_FIELDS
_MAX_ATTACHMENTS = mail_inbound.MAX_ATTACHMENTS
MAX_ATTACHMENT_BYTES = mail_inbound.MAX_ATTACHMENT_BYTES
list_unread = mail_inbound.list_unread
get_message = mail_inbound.get_message
list_attachments = mail_inbound.list_attachments
fetch_attachment_bytes = mail_inbound.fetch_attachment_bytes
fetch_attachment = mail_inbound.fetch_attachment
_headers = mail_inbound.headers_of
_sender = mail_inbound.sender_of
_recipients = mail_inbound.recipients_of
_referenced_ids = mail_inbound.referenced_ids


def mark_handled(mailbox: str, msg_id: str) -> None:
    mail_inbound.mark_handled(mailbox, msg_id, tag="task-inbound")


# ── Resolution ───────────────────────────────────────────────────────────────
def resolve_task(db, cfg: dict, msg: dict, headers: dict):
    """(task, how) for a reply, or (None, ""). Three routes, strongest first:

    address      the signed sub-address the notification set as Reply-To. Exact
                 and forge-proof (task_inbound_parse.reply_address).
    headers      In-Reply-To/References against what we sent (TaskEmailLog).
                 Survives clients that rewrite recipients but not ones that
                 strip threading headers.
    conversation Outlook's own thread id. Weakest - it is stable inside the
                 tenant and rewritten across some external hops - so it is the
                 last resort rather than the first."""
    tid = parse.task_id_from_recipients(mailbox_of(cfg), _recipients(msg))
    if tid:
        t = db.query(models.Task).filter(models.Task.id == tid).first()
        if t:
            return t, "address"

    refs = _referenced_ids(headers)
    if refs:
        row = (db.query(models.TaskEmailLog)
               .filter(models.TaskEmailLog.internet_message_id.in_(refs))
               .order_by(models.TaskEmailLog.created_at.desc()).first())
        if row:
            t = db.query(models.Task).filter(models.Task.id == row.task_id).first()
            if t:
                return t, "headers"

    conv = (msg.get("conversationId") or "").strip()
    if conv:
        row = (db.query(models.TaskEmailLog)
               .filter(models.TaskEmailLog.conversation_id == conv)
               .order_by(models.TaskEmailLog.created_at.desc()).first())
        if row:
            t = db.query(models.Task).filter(models.Task.id == row.task_id).first()
            if t:
                return t, "conversation"
    return None, ""


def resolve_author(db, from_email: str) -> tuple[str, str]:
    """(nexus email, rejection reason) - mail_inbound.resolve_person, the one
    address-to-person rule both inbound drains use."""
    return mail_inbound.resolve_person(db, from_email)


# ── Attachments ──────────────────────────────────────────────────────────────
def _attachment_row(db, task, comment_id: str, author: str, *, name: str,
                    url: str, kind: str, size: str) -> None:
    """One TaskAttachment, linked to the comment the reply became - the same
    shape the drawer's own attach-while-commenting flow produces
    (uploadPendingAttachments), so an emailed file renders as a card under its
    comment rather than only in the task-level list."""
    aid = gen_id()
    db.add(models.TaskAttachment(id=aid, task_id=task.id, name=name[:250], size=size,
                                 kind=kind, url=url, added_at=_now(), added_by=author,
                                 comment_id=comment_id))
    task.attachment_ids = list(task.attachment_ids or []) + [aid]
    act = log_activity(db, type="attached", actor_email=author, entity_id=task.id,
                       entity_code=task.code, entity_title=task.title,
                       detail=f'attached "{name}"')
    task.activity_ids = list(task.activity_ids or []) + [act]
    task.modified_at = _now()


def store_attachments(db, mailbox: str, msg: dict, task, comment_id: str,
                      author: str, kept_html: str, atts: list[dict]) -> tuple[int, list[str]]:
    """File a reply's attachments against its comment. Returns (stored, skips).

    Best effort per file, and deliberately so: the comment is already committed
    by the time this runs, and one file that will not download must not look
    like the reply failed. That is the rule the drawer already follows
    ("one failed upload must never look like the comment failed too") - the
    difference here is that nobody is watching, so every skip is named in the
    TaskInboundEmail row instead of being swallowed."""
    def add_row(**kw):
        _attachment_row(db, task, comment_id, author, **kw)

    # Looked up here at call time (not bound once at import) so the stubs a
    # test puts on this module are the ones used.
    stored, skips = mail_inbound.file_attachments(
        mailbox, msg, atts, kept_html, store=task_files.store_bytes, add_row=add_row,
        fetch_detail=lambda *a: fetch_attachment(*a),
        fetch_bytes=lambda *a: fetch_attachment_bytes(*a),
        max_files=_MAX_ATTACHMENTS, max_bytes=MAX_ATTACHMENT_BYTES)
    if stored:
        db.commit()
        # The comment already fired its own event, before these existed.
        fire_task_event(task.id, "attachment")
    return stored, skips


# ── Ingest ───────────────────────────────────────────────────────────────────
def ingest_message(db, cfg: dict, msg: dict) -> str:
    """Turn one fetched message into a comment, or into a row explaining why
    not. Returns the status written."""
    msg_id = msg.get("id") or ""
    imid = (msg.get("internetMessageId") or "").strip() or f"graph:{msg_id}"

    if db.query(models.TaskInboundEmail).filter(
            models.TaskInboundEmail.internet_message_id == imid).first():
        return "duplicate"

    headers = _headers(msg)
    sender = _sender(msg)
    row = models.TaskInboundEmail(
        id=str(uuid.uuid4()), internet_message_id=imid, graph_message_id=msg_id,
        conversation_id=(msg.get("conversationId") or ""), from_email=sender,
        subject=(msg.get("subject") or "")[:500],
        # Provisional: on a reply that becomes a comment this is overwritten
        # with the number of files actually FILED. On one that is refused it
        # stays 1 as a flag, so "they replied with photos and got nothing"
        # is visible in the log rather than lost with the message.
        attachment_count=1 if msg.get("hasAttachments") else 0,
        received_at=(msg.get("receivedDateTime") or ""), status="failed",
        processed_at=_now(),
    )

    def finish(status: str, reason: str = "") -> str:
        row.status, row.reason, row.processed_at = status, reason[:500], _now()
        db.add(row)
        db.commit()
        return status

    if not sender or sender == mailbox_of(cfg):
        return finish("ignored", "mail from the task mailbox itself")
    if parse.is_auto_reply(headers):
        return finish("ignored", "automated mail (out-of-office, bounce or list)")

    task, how = resolve_task(db, cfg, msg, headers)
    if not task:
        # Name which of the three routes was even available. "Could not match"
        # on its own sent us looking at the wrong half: the real cause was that
        # the notifications carried no Reply-To, so no reply could ever have a
        # token - and nothing in the row said so.
        why = []
        if not parse.task_id_from_recipients(mailbox_of(cfg), _recipients(msg)):
            why.append("no signed reply address on it")
        if not _referenced_ids(headers):
            why.append("no threading headers")
        elif not db.query(models.TaskEmailLog).filter(
                models.TaskEmailLog.internet_message_id.in_(_referenced_ids(headers))).first():
            why.append("its threading headers match nothing we sent")
        if not (msg.get("conversationId") or "").strip():
            why.append("no conversation id")
        return finish("rejected", "could not match this reply to a task: " + ", ".join(why))
    row.task_id, row.matched_by = task.id, how

    author, why = resolve_author(db, sender)
    if not author:
        return finish("rejected", why)
    if not can_comment(db, author, project_for_task(db, task)):
        return finish("rejected", f"{author} does not have commenter access to this project")

    raw_html = ((msg.get("uniqueBody") or {}).get("content")
                or (msg.get("body") or {}).get("content") or "")
    body = parse.clean_body(html=raw_html)
    # The part of the reply that is the person's own writing. Only used to tell
    # an image they embedded from the logo in their signature - see
    # inline_is_referenced.
    kept_html = parse.strip_quoted_html(raw_html)

    files = []
    if msg.get("hasAttachments"):
        try:
            files = list_attachments(mailbox_of(cfg), msg.get("id") or "")
        except Exception as e:
            print(f"[task-inbound] could not list attachments: {e}")

    if not body and not files:
        return finish("ignored", "reply had no new text (only quoted history or a signature)")

    # Added BEFORE the comment so create_comment's commit persists both in one
    # transaction. A crash between them therefore cannot leave a comment with
    # no row - which would let the next pass post it a second time.
    row.status, row.reason = "posted", ""
    db.add(row)
    try:
        # No `defer`: this already runs in a worker thread (see _drain_once),
        # so the notification emails can send inline.
        # An empty body is legitimate here: a reply that is only photos is
        # still a comment, and CommentAttachments renders the files under it.
        c = create_comment(db, task, actor_email=author, body=body)
    except Exception as e:
        db.rollback()
        return finish("failed", f"could not post the comment: {e}")
    row.comment_id = c.id

    if files:
        stored, skips = store_attachments(db, mailbox_of(cfg), msg, task, c.id, author,
                                          kept_html, files)
        row.attachment_count = stored
        if skips:
            row.reason = "; ".join(skips)[:500]
    row.processed_at = _now()
    db.commit()
    return "posted"


# ── Drain ────────────────────────────────────────────────────────────────────
def _acquire_lock(db) -> bool:
    return mail_inbound.try_lock(db, _LOCK_KEY)


def _release_lock(db) -> None:
    mail_inbound.release_lock(db, _LOCK_KEY)


def drain_once(db) -> dict:
    """One pass over the unread mail. Synchronous by design - the caller runs it
    in a thread (CLAUDE.md: a blocking Graph call on the event loop freezes
    every request the worker is serving, CORS preflights included)."""
    counts = {"seen": 0, "posted": 0, "rejected": 0, "ignored": 0, "failed": 0, "duplicate": 0}
    cfg = task_notify.get_settings(db)
    if not is_enabled(cfg):
        return counts
    mailbox = mailbox_of(cfg)
    if not _acquire_lock(db):
        return counts          # another worker is draining
    try:
        for stub in list_unread(mailbox):
            msg_id = stub.get("id") or ""
            counts["seen"] += 1
            try:
                msg = get_message(mailbox, msg_id)
                status = ingest_message(db, cfg, msg)
            except Exception as e:
                # A message we could not even fetch or judge stays unread and
                # is retried next pass; log it so a persistent one is visible.
                print(f"[task-inbound] {msg_id}: {e}")
                counts["failed"] += 1
                continue
            counts[status] = counts.get(status, 0) + 1
            try:
                mark_handled(mailbox, msg_id)
            except Exception as e:
                # The outcome is already committed. One message we cannot mark
                # must not abandon the rest of the batch - it comes back next
                # pass and the unique index turns it into a no-op.
                print(f"[task-inbound] could not mark {msg_id} handled: {e}")
    finally:
        _release_lock(db)
    return counts


def _drain_once() -> None:
    db = SessionLocal()
    try:
        counts = drain_once(db)
        if counts["seen"]:
            print(f"[task-inbound] {counts}")
    finally:
        db.close()


async def task_inbound_loop() -> None:
    """Started once from main.py's lifespan, behind is_sync_worker(). Same shape
    as task_notify_loop: the blocking body runs via asyncio.to_thread, and no
    exception is ever allowed to kill the loop."""
    await asyncio.sleep(_STARTUP_DELAY_SEC)
    while True:
        try:
            await asyncio.to_thread(_drain_once)
        except Exception:
            pass
        await asyncio.sleep(_LOOP_SEC)
