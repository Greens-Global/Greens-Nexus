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

import httpx
from sqlalchemy import text as sql_text

import graph_mail
import models
import task_inbound_parse as parse
import task_notify
from database import SessionLocal
from routers.task_util import (can_comment, create_comment, fire_task_event, gen_id,
                               log_activity, project_for_task)
import task_files

_GRAPH = "https://graph.microsoft.com/v1.0"
_LOOP_SEC = 60
# main.py's lifespan already staggers its background loops at 15s intervals from
# 60s; this takes the next free slot. A cold start that fires every loop at once
# competes with the first real requests.
_STARTUP_DELAY_SEC = 120
_BATCH = 25
_PROCESSED_FOLDER = "Nexus Processed"
# Distinct from asana_sync's pull lock - the two are unrelated and must not
# block each other.
_LOCK_KEY = 0x7A5C0DE1

# What a message must carry to be judged. `uniqueBody` is the new content only,
# with the quoted history already removed by Exchange - far more reliable than
# unquoting it ourselves, and the reason each message is fetched individually
# instead of taken from the list response (which serves neither uniqueBody nor
# internetMessageHeaders).
_MSG_FIELDS = ("id,subject,from,toRecipients,ccRecipients,receivedDateTime,"
               "conversationId,internetMessageId,internetMessageHeaders,"
               "body,uniqueBody,hasAttachments")

_folder_cache: dict[str, str] = {}


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


# ── Graph ────────────────────────────────────────────────────────────────────
def _hdrs() -> dict:
    return {"Authorization": f"Bearer {graph_mail.access_token()}",
            "Content-Type": "application/json"}


def _get(url: str, params: dict | None = None) -> dict:
    r = httpx.get(url, headers=_hdrs(), params=params, timeout=20)
    if not r.is_success:
        raise RuntimeError(f"Graph GET {r.status_code}: {r.text[:300]}")
    return r.json()


def list_unread(mailbox: str, top: int = _BATCH) -> list[dict]:
    """Unread messages in the inbox, ids only - the body of each is fetched
    separately (see _MSG_FIELDS). No $orderby: Graph rejects some
    filter+orderby combinations on messages outright, and within one batch the
    order does not matter."""
    data = _get(f"{_GRAPH}/users/{mailbox}/mailFolders/inbox/messages",
                {"$filter": "isRead eq false", "$top": top, "$select": "id"})
    return data.get("value", []) or []


def get_message(mailbox: str, msg_id: str) -> dict:
    return _get(f"{_GRAPH}/users/{mailbox}/messages/{msg_id}", {"$select": _MSG_FIELDS})


# Base-type properties only. contentBytes is excluded because it would inline
# every file's base64 into the list response; contentId and sourceUrl because
# they live on the DERIVED types (fileAttachment/referenceAttachment) and
# selecting them across a mixed collection is not something the API promises to
# accept. Both are fetched per attachment, only when actually needed - see
# fetch_attachment.
_ATT_FIELDS = "id,name,contentType,size,isInline"
# A reply with more files than this is a mailing-list digest or a mistake. The
# cap bounds one message's work; what is left behind is named in the row.
_MAX_ATTACHMENTS = 20
# A gunicorn worker reads the whole file into memory to store it, so this is a
# memory budget rather than a policy - same reasoning as every other upload cap
# in the app.
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024


def list_attachments(mailbox: str, msg_id: str) -> list[dict]:
    return _get(f"{_GRAPH}/users/{mailbox}/messages/{msg_id}/attachments",
                {"$select": _ATT_FIELDS}).get("value") or []


def fetch_attachment_bytes(mailbox: str, msg_id: str, att_id: str) -> bytes:
    r = httpx.get(f"{_GRAPH}/users/{mailbox}/messages/{msg_id}/attachments/{att_id}/$value",
                  headers=_hdrs(), timeout=60)
    if not r.is_success:
        raise RuntimeError(f"Graph attachment {r.status_code}: {r.text[:200]}")
    return r.content


def fetch_attachment(mailbox: str, msg_id: str, att_id: str) -> dict:
    """The full attachment resource, for the properties the list response cannot
    carry: `sourceUrl` on a link attachment, `contentId` on an inline one. One
    extra call, made only for those two cases."""
    return _get(f"{_GRAPH}/users/{mailbox}/messages/{msg_id}/attachments/{att_id}")


def _processed_folder_id(mailbox: str) -> str:
    """Id of the folder handled mail is filed into, created on first use.

    Filing rather than only marking read: the inbox then shows exactly what the
    drain has not dealt with, which is the one view an operator wants when
    something looks stuck."""
    if mailbox in _folder_cache:
        return _folder_cache[mailbox]
    found = _get(f"{_GRAPH}/users/{mailbox}/mailFolders",
                 {"$filter": f"displayName eq '{_PROCESSED_FOLDER}'"}).get("value") or []
    if found:
        _folder_cache[mailbox] = found[0]["id"]
        return _folder_cache[mailbox]
    r = httpx.post(f"{_GRAPH}/users/{mailbox}/mailFolders", headers=_hdrs(),
                   json={"displayName": _PROCESSED_FOLDER}, timeout=20)
    if not r.is_success:
        raise RuntimeError(f"Graph create-folder {r.status_code}: {r.text[:300]}")
    _folder_cache[mailbox] = r.json()["id"]
    return _folder_cache[mailbox]


def mark_handled(mailbox: str, msg_id: str) -> None:
    """Read + filed. Called only after the outcome is committed, so a crash
    before this leaves the message unread and it is simply seen again - which
    the internet_message_id unique index then turns into a no-op."""
    httpx.patch(f"{_GRAPH}/users/{mailbox}/messages/{msg_id}", headers=_hdrs(),
                json={"isRead": True}, timeout=20)
    try:
        httpx.post(f"{_GRAPH}/users/{mailbox}/messages/{msg_id}/move", headers=_hdrs(),
                   json={"destinationId": _processed_folder_id(mailbox)}, timeout=20)
    except Exception as e:
        # Read but unfiled is a cosmetic failure - it must not make the drain
        # re-process a message it has already turned into a comment.
        print(f"[task-inbound] could not file {msg_id}: {e}")


# ── Message shape helpers ────────────────────────────────────────────────────
def _headers(msg: dict) -> dict:
    return {(h.get("name") or "").lower(): (h.get("value") or "")
            for h in (msg.get("internetMessageHeaders") or [])}


def _sender(msg: dict) -> str:
    return (((msg.get("from") or {}).get("emailAddress") or {}).get("address") or "").strip().lower()


def _recipients(msg: dict) -> list[str]:
    out = []
    for key in ("toRecipients", "ccRecipients"):
        for r in msg.get(key) or []:
            addr = ((r or {}).get("emailAddress") or {}).get("address") or ""
            if addr:
                out.append(addr.strip().lower())
    return out


def _referenced_ids(headers: dict) -> list[str]:
    """Message-ids this reply claims to answer, newest first. `References` is a
    whole thread's worth, `In-Reply-To` just the parent."""
    raw = f'{headers.get("in-reply-to", "")} {headers.get("references", "")}'
    return [p for p in raw.split() if p.startswith("<") and p.endswith(">")]


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
    """(nexus email, rejection reason). The address a reply is sent FROM is not
    always the address Nexus knows a person by: Outlook may deliver as the
    @greensg.onmicrosoft.com relay for the same human. Matched on the local
    part, exactly as the Asana sync resolves identity, and an ambiguous local
    part is refused rather than guessed - guessing here attributes someone's
    words to someone else."""
    addr = (from_email or "").strip().lower()
    if not addr or "@" not in addr:
        return "", "no sender address"

    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == addr).first()
    if not emp:
        local = addr.split("@", 1)[0]
        matches = [e for e in db.query(models.NexusEmployee)
                   .filter(models.NexusEmployee.work_email.like(f"{local}@%")).all()
                   if (e.work_email or "").split("@", 1)[0].lower() == local]
        if len(matches) > 1:
            return "", f"'{local}' matches more than one employee"
        emp = matches[0] if matches else None

    if emp:
        if (emp.status or "") in ("inactive", "offboarded"):
            return "", f"{emp.work_email} is {emp.status}"
        return (emp.work_email or "").lower(), ""

    # Not in the people directory, but the app may still know them as a role
    # holder (the directory is curated and lags a new starter).
    role = db.query(models.NexusRole).filter(models.NexusRole.email == addr).first()
    if role:
        return addr, ""
    return "", "sender is not a known Nexus person"


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


def _inline_belongs_to_the_reply(mailbox: str, msg: dict, att: dict, kept_html: str) -> bool:
    """Whether an inline image is one the sender put in their message, rather
    than the logo in their signature.

    The signature was cut before this ran, so its <img> is gone and its content
    id is referenced nowhere. If the kept text references no `cid:` at all,
    nothing inline can belong to it and the answer is no without asking Graph
    anything - which is the common case, since most replies carry only a
    signature."""
    if "cid:" not in (kept_html or "").lower():
        return False
    cid = att.get("contentId") or ""
    if not cid:
        cid = fetch_attachment(mailbox, msg.get("id") or "",
                               att.get("id") or "").get("contentId") or ""
    return parse.inline_is_referenced(kept_html, cid)


def store_attachments(db, mailbox: str, msg: dict, task, comment_id: str,
                      author: str, kept_html: str, atts: list[dict]) -> tuple[int, list[str]]:
    """File a reply's attachments against its comment. Returns (stored, skips).

    Best effort per file, and deliberately so: the comment is already committed
    by the time this runs, and one file that will not download must not look
    like the reply failed. That is the rule the drawer already follows
    ("one failed upload must never look like the comment failed too") - the
    difference here is that nobody is watching, so every skip is named in the
    TaskInboundEmail row instead of being swallowed."""
    stored, skips = 0, []
    for att in atts[:_MAX_ATTACHMENTS]:
        kind_odata = (att.get("@odata.type") or "")
        name = (att.get("name") or "attachment").strip()
        try:
            if "itemAttachment" in kind_odata:
                # A forwarded email as an attachment. Filing it would mean
                # storing a whole message, headers and all, as a task file.
                skips.append(f'"{name}" is an attached email')
                continue
            if "referenceAttachment" in kind_odata:
                url = (fetch_attachment(mailbox, msg.get("id") or "",
                                        att.get("id") or "").get("sourceUrl") or "").strip()
                if not url.lower().startswith("https://"):
                    skips.append(f'"{name}" is a link we could not resolve')
                    continue
                # Kept as a link: the bytes live in the sender's OneDrive and
                # copying them would silently duplicate a file whose sharing
                # they control.
                _attachment_row(db, task, comment_id, author, name=name, url=url,
                                kind="doc", size="")
                stored += 1
                continue

            if att.get("isInline") and not _inline_belongs_to_the_reply(
                    mailbox, msg, att, kept_html):
                continue        # signature logo - not a skip worth reporting
            size = int(att.get("size") or 0)
            if size > MAX_ATTACHMENT_BYTES:
                skips.append(f'"{name}" is over {MAX_ATTACHMENT_BYTES // 1024 // 1024} MB')
                continue
            raw = fetch_attachment_bytes(mailbox, msg.get("id") or "", att.get("id") or "")
            content_type = att.get("contentType") or "application/octet-stream"
            url = task_files.store_bytes(name, raw, content_type)
            if not url:
                skips.append(f'"{name}" could not be stored')
                continue
            _attachment_row(db, task, comment_id, author, name=name, url=url,
                            kind="image" if content_type.lower().startswith("image/") else "doc",
                            size=f"{max(1, round(len(raw) / 1024))} KB")
            stored += 1
        except Exception as e:
            skips.append(f'"{name}" could not be filed: {e}')
    if len(atts) > _MAX_ATTACHMENTS:
        skips.append(f"{len(atts) - _MAX_ATTACHMENTS} more files were not filed")
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
    """Session-scoped, not transaction-scoped: the drain commits after every
    message, and a pg_advisory_XACT_lock would be released by the first of
    those - handing the rest of the batch to whichever of the 8 workers asked
    next. No-op on SQLite, where there is only ever one process."""
    if db.bind.dialect.name != "postgresql":
        return True
    return bool(db.execute(sql_text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar())


def _release_lock(db) -> None:
    if db.bind.dialect.name == "postgresql":
        try:
            db.execute(sql_text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
            db.commit()
        except Exception:
            pass


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
