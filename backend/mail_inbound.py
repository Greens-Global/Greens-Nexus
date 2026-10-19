"""The shared half of reading a mailbox (Oct 2026): what Task Inbound Email
(task_inbound.py) and Ticket Inbound Email (ticket_inbound.py) both need.

Moved out of task_inbound.py unchanged when tickets learned to read mail, so
the two drains cannot drift on the parts that are not about tasks or tickets:

  - Microsoft Graph (app-only): list the unread inbox, fetch one message with
    its `uniqueBody` and headers, its attachments, and file a handled message
    into "Nexus Processed";
  - message shape: headers, sender, recipients, the message-ids a reply
    answers;
  - plus addressing: `local+token@domain` built and read back, and "is this the
    same mailbox" with any sub-address ignored;
  - who sent it: an address -> a Nexus person (resolve_person), refusing an
    ambiguous match rather than guessing;
  - the Postgres advisory lock each drain holds for a whole pass;
  - filing a message's attachments one by one (file_attachments), where
    storage and the row it becomes are the caller's.

Synchronous throughout - both drains run in a worker thread (asyncio.to_thread),
never on the event loop.
"""
import re
from contextlib import contextmanager

import httpx
from sqlalchemy import text as sql_text

import graph_mail
import models
import task_inbound_parse as parse

GRAPH = "https://graph.microsoft.com/v1.0"
BATCH = 25
PROCESSED_FOLDER = "Nexus Processed"

# What a message must carry to be judged. `uniqueBody` is the new content only,
# with the quoted history already removed by Exchange - far more reliable than
# unquoting it ourselves, and the reason each message is fetched individually
# instead of taken from the list response (which serves neither uniqueBody nor
# internetMessageHeaders).
MSG_FIELDS = ("id,subject,from,toRecipients,ccRecipients,receivedDateTime,"
              "conversationId,internetMessageId,internetMessageHeaders,"
              "body,uniqueBody,hasAttachments")

# Base-type properties only. contentBytes is excluded because it would inline
# every file's base64 into the list response; contentId and sourceUrl because
# they live on the DERIVED types (fileAttachment/referenceAttachment) and
# selecting them across a mixed collection is not something the API promises to
# accept. Both are fetched per attachment, only when actually needed - see
# fetch_attachment.
ATT_FIELDS = "id,name,contentType,size,isInline"
# A message with more files than this is a mailing-list digest or a mistake.
# The cap bounds one message's work; what is left behind is named in the row.
MAX_ATTACHMENTS = 20
# A gunicorn worker reads the whole file into memory to store it, so this is a
# memory budget rather than a policy - same reasoning as every other upload cap
# in the app.
MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

_folder_cache: dict[str, str] = {}


# ── Graph ────────────────────────────────────────────────────────────────────
def _hdrs() -> dict:
    return {"Authorization": f"Bearer {graph_mail.access_token()}",
            "Content-Type": "application/json"}


def _get(url: str, params: dict | None = None) -> dict:
    r = httpx.get(url, headers=_hdrs(), params=params, timeout=20)
    if not r.is_success:
        raise RuntimeError(f"Graph GET {r.status_code}: {r.text[:300]}")
    return r.json()


def list_unread(mailbox: str, top: int = BATCH) -> list[dict]:
    """Unread messages in the inbox, ids only - the body of each is fetched
    separately (see MSG_FIELDS). No $orderby: Graph rejects some
    filter+orderby combinations on messages outright, and within one batch the
    order does not matter."""
    data = _get(f"{GRAPH}/users/{mailbox}/mailFolders/inbox/messages",
                {"$filter": "isRead eq false", "$top": top, "$select": "id"})
    return data.get("value", []) or []


def get_message(mailbox: str, msg_id: str) -> dict:
    return _get(f"{GRAPH}/users/{mailbox}/messages/{msg_id}", {"$select": MSG_FIELDS})


def list_attachments(mailbox: str, msg_id: str) -> list[dict]:
    return _get(f"{GRAPH}/users/{mailbox}/messages/{msg_id}/attachments",
                {"$select": ATT_FIELDS}).get("value") or []


def fetch_attachment_bytes(mailbox: str, msg_id: str, att_id: str) -> bytes:
    r = httpx.get(f"{GRAPH}/users/{mailbox}/messages/{msg_id}/attachments/{att_id}/$value",
                  headers=_hdrs(), timeout=60)
    if not r.is_success:
        raise RuntimeError(f"Graph attachment {r.status_code}: {r.text[:200]}")
    return r.content


def fetch_attachment(mailbox: str, msg_id: str, att_id: str) -> dict:
    """The full attachment resource, for the properties the list response cannot
    carry: `sourceUrl` on a link attachment, `contentId` on an inline one. One
    extra call, made only for those two cases."""
    return _get(f"{GRAPH}/users/{mailbox}/messages/{msg_id}/attachments/{att_id}")


def processed_folder_id(mailbox: str) -> str:
    """Id of the folder handled mail is filed into, created on first use.

    Filing rather than only marking read: the inbox then shows exactly what the
    drain has not dealt with, which is the one view an operator wants when
    something looks stuck."""
    if mailbox in _folder_cache:
        return _folder_cache[mailbox]
    found = _get(f"{GRAPH}/users/{mailbox}/mailFolders",
                 {"$filter": f"displayName eq '{PROCESSED_FOLDER}'"}).get("value") or []
    if found:
        _folder_cache[mailbox] = found[0]["id"]
        return _folder_cache[mailbox]
    r = httpx.post(f"{GRAPH}/users/{mailbox}/mailFolders", headers=_hdrs(),
                   json={"displayName": PROCESSED_FOLDER}, timeout=20)
    if not r.is_success:
        raise RuntimeError(f"Graph create-folder {r.status_code}: {r.text[:300]}")
    _folder_cache[mailbox] = r.json()["id"]
    return _folder_cache[mailbox]


def mark_handled(mailbox: str, msg_id: str, tag: str = "task-inbound") -> None:
    """Read + filed. Called only after the outcome is committed, so a crash
    before this leaves the message unread and it is simply seen again - which
    the internet_message_id unique index then turns into a no-op."""
    httpx.patch(f"{GRAPH}/users/{mailbox}/messages/{msg_id}", headers=_hdrs(),
                json={"isRead": True}, timeout=20)
    try:
        httpx.post(f"{GRAPH}/users/{mailbox}/messages/{msg_id}/move", headers=_hdrs(),
                   json={"destinationId": processed_folder_id(mailbox)}, timeout=20)
    except Exception as e:
        # Read but unfiled is a cosmetic failure - it must not make the drain
        # re-process a message it has already acted on.
        print(f"[{tag}] could not file {msg_id}: {e}")


# ── Message shape ────────────────────────────────────────────────────────────
def headers_of(msg: dict) -> dict:
    return {(h.get("name") or "").lower(): (h.get("value") or "")
            for h in (msg.get("internetMessageHeaders") or [])}


def sender_of(msg: dict) -> str:
    return (((msg.get("from") or {}).get("emailAddress") or {}).get("address") or "").strip().lower()


def recipients_of(msg: dict, keys=("toRecipients", "ccRecipients")) -> list[str]:
    out = []
    for key in keys:
        for r in msg.get(key) or []:
            addr = ((r or {}).get("emailAddress") or {}).get("address") or ""
            if addr:
                out.append(addr.strip().lower())
    return out


def referenced_ids(headers: dict) -> list[str]:
    """Message-ids this reply claims to answer, newest first. `References` is a
    whole thread's worth, `In-Reply-To` just the parent."""
    raw = f'{headers.get("in-reply-to", "")} {headers.get("references", "")}'
    return [p for p in raw.split() if p.startswith("<") and p.endswith(">")]


# ── Plus addressing ──────────────────────────────────────────────────────────
def bare_address(addr: str) -> str:
    """`Support+t1a2b.c3@x.com` -> `support@x.com`: the mailbox, without any
    sub-address - what two settings must be compared on to know whether they
    name one mailbox."""
    addr = (addr or "").strip().lower()
    if "@" not in addr:
        return addr
    local, domain = addr.rsplit("@", 1)
    return f"{local.split('+', 1)[0]}@{domain}"


def same_mailbox(a: str, b: str) -> bool:
    a, b = bare_address(a), bare_address(b)
    return bool(a) and "@" in a and a == b


def plus_address(mailbox: str, token: str) -> str:
    """`local+token@domain` for a mailbox. Never stacks a second sub-address,
    and hands a value with no '@' back unchanged."""
    mailbox = (mailbox or "").strip()
    if "@" not in mailbox:
        return mailbox
    local, domain = mailbox.rsplit("@", 1)
    local = local.split("+", 1)[0]
    return f"{local}+{token}@{domain}"


def plus_tokens(mailbox: str, addresses) -> list[str]:
    """The sub-address tokens on any of `addresses` that are this mailbox
    (same local part and domain), lower-cased, in order."""
    base = (mailbox or "").strip().lower()
    if "@" not in base:
        return []
    base_local, base_domain = base.rsplit("@", 1)
    base_local = base_local.split("+", 1)[0]
    out = []
    for addr in addresses or []:
        addr = (addr or "").strip().lower()
        if "@" not in addr:
            continue
        local, domain = addr.rsplit("@", 1)
        if domain != base_domain or "+" not in local:
            continue
        head, sub = local.split("+", 1)
        if head == base_local:
            out.append(sub)
    return out


# ── Who sent it ──────────────────────────────────────────────────────────────
def resolve_person(db, from_email: str) -> tuple[str, str]:
    """(nexus email, rejection reason). The address a reply is sent FROM is not
    always the address Nexus knows a person by: Outlook may deliver as the
    @greensg.onmicrosoft.com relay for the same human. Matched on the local
    part, exactly as the Asana sync resolves identity - but only on our own
    domains - and an ambiguous local part is refused rather than guessed:
    guessing here attributes someone's words to someone else."""
    addr = (from_email or "").strip().lower()
    if not addr or "@" not in addr:
        return "", "no sender address"

    emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == addr).first()
    # The local-part match exists for the @greensg.onmicrosoft.com relay. On
    # any other domain it would read neil@gmail.com as neil@greensglobal.com,
    # so it is allowed only on our own domains (auth.INTERNAL_DOMAINS); an
    # exact work_email or NexusRole match is unaffected.
    import auth
    if not emp and addr.rsplit("@", 1)[1] in auth.INTERNAL_DOMAINS:
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


# ── The pass lock ────────────────────────────────────────────────────────────
@contextmanager
def pass_lock(db, key: int):
    """Hold `key` for a whole drain pass: yields True when this process has it,
    False when another worker is draining.

    On its OWN connection (engine.connect()), never the ORM session's: the
    drain commits after every message, and a lock on the session's pooled
    connection is at the mercy of whatever that connection does between
    commits. And transaction-scoped (pg_try_advisory_xact_lock inside one
    transaction held open for the pass), not session-scoped: through
    Supabase's transaction pooler (port 6543) a SESSION lock lands on one
    server connection and is never released when the client closes
    (schema_guard.py's note), while a transaction pins its server connection
    until it ends - so the lock goes when the pass does, however it ends.
    No-op on SQLite, where there is only ever one process."""
    bind = db.get_bind()
    if bind.dialect.name != "postgresql":
        yield True
        return
    conn = bind.connect()
    trans = conn.begin()
    try:
        got = bool(conn.execute(sql_text("SELECT pg_try_advisory_xact_lock(:k)"), {"k": key}).scalar())
        yield got
    finally:
        try:
            trans.rollback()            # ends the transaction: the lock goes with it
        except Exception:
            pass
        conn.close()


# ── Sender authenticity ──────────────────────────────────────────────────────
# Defense in depth behind the domain's own DMARC p=reject / SPF -all: what
# Exchange Online concluded about the message, read from its headers.
_AUTH_HEADERS = ("authentication-results", "arc-authentication-results")
_VERDICT_RE = re.compile(r"\b(dmarc|compauth|spf|dkim)=([a-z]+)", re.I)


def header_values(msg: dict, name: str) -> list[str]:
    """Every value of one header - headers_of keeps only the last of a name
    that repeats, and Authentication-Results / ARC do repeat."""
    name = name.lower()
    return [(h.get("value") or "") for h in (msg.get("internetMessageHeaders") or [])
            if (h.get("name") or "").lower() == name]


def auth_verdict(msg: dict) -> tuple[bool, str]:
    """(allowed, summary). Refused when Exchange says the sender failed:
    dmarc=fail or compauth=fail in Authentication-Results (or ARC), or
    X-MS-Exchange-Organization-AuthAs present and not "Internal". Headers
    absent = allowed - whether Graph exposes them is not yet verified, and a
    header we cannot count on is not one to hard-require - with the summary
    saying so, so the first real messages show what is there."""
    seen: dict[str, str] = {}
    for name in _AUTH_HEADERS:
        for value in header_values(msg, name):
            for key, verdict in _VERDICT_RE.findall(value):
                key, verdict = key.lower(), verdict.lower()
                # Any failure wins over a pass from another hop.
                if seen.get(key) != "fail":
                    seen[key] = verdict
    auth_as = " ".join(header_values(msg, "x-ms-exchange-organization-authas")).strip()
    parts = [f"{k}={seen[k]}" for k in ("dmarc", "compauth", "spf", "dkim") if k in seen]
    if auth_as:
        parts.append(f"authas={auth_as}")
    summary = ("auth: " + " ".join(parts)) if parts else "auth: no authentication headers"
    failed = (seen.get("dmarc") == "fail" or seen.get("compauth") == "fail"
              or (auth_as and auth_as.lower() != "internal"))
    return (not failed), summary[:200]


# ── Attachments ──────────────────────────────────────────────────────────────
def inline_belongs_to_the_message(mailbox: str, msg: dict, att: dict, kept_html: str,
                                  fetch_detail=None) -> bool:
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
        cid = (fetch_detail or fetch_attachment)(mailbox, msg.get("id") or "",
                                                 att.get("id") or "").get("contentId") or ""
    return parse.inline_is_referenced(kept_html, cid)


def file_attachments(mailbox: str, msg: dict, atts: list[dict], kept_html: str, *,
                     store, add_row, fetch_detail=None, fetch_bytes=None,
                     max_files: int = MAX_ATTACHMENTS,
                     max_bytes: int = MAX_ATTACHMENT_BYTES) -> tuple[int, list[str]]:
    """Walk a message's attachments and file each one. Returns (stored, skips).

    The caller owns where bytes go and what a filed file becomes:
      store(name, raw, content_type) -> url ("" = could not be stored)
      add_row(name=, url=, kind=, size=) -> None
    `fetch_detail` / `fetch_bytes` default to the Graph calls above; a caller
    passes its own so a test that stubs Graph on that caller's module still
    reaches here.

    Best effort per file, and deliberately so: the comment or ticket is already
    committed by the time this runs, and one file that will not download must
    not look like the message failed. Every skip is named for the log row
    instead of being swallowed."""
    fetch_detail = fetch_detail or fetch_attachment
    fetch_bytes = fetch_bytes or fetch_attachment_bytes
    stored, skips = 0, []
    for att in atts[:max_files]:
        kind_odata = (att.get("@odata.type") or "")
        name = (att.get("name") or "attachment").strip()
        try:
            if "itemAttachment" in kind_odata:
                # A forwarded email as an attachment. Filing it would mean
                # storing a whole message, headers and all, as a file.
                skips.append(f'"{name}" is an attached email')
                continue
            if "referenceAttachment" in kind_odata:
                url = (fetch_detail(mailbox, msg.get("id") or "",
                                    att.get("id") or "").get("sourceUrl") or "").strip()
                if not url.lower().startswith("https://"):
                    skips.append(f'"{name}" is a link we could not resolve')
                    continue
                # Kept as a link: the bytes live in the sender's OneDrive and
                # copying them would silently duplicate a file whose sharing
                # they control.
                add_row(name=name, url=url, kind="doc", size="")
                stored += 1
                continue

            if att.get("isInline") and not inline_belongs_to_the_message(
                    mailbox, msg, att, kept_html, fetch_detail):
                continue        # signature logo - not a skip worth reporting
            size = int(att.get("size") or 0)
            if size > max_bytes:
                skips.append(f'"{name}" is over {max_bytes // 1024 // 1024} MB')
                continue
            raw = fetch_bytes(mailbox, msg.get("id") or "", att.get("id") or "")
            content_type = att.get("contentType") or "application/octet-stream"
            url = store(name, raw, content_type)
            if not url:
                skips.append(f'"{name}" could not be stored')
                continue
            add_row(name=name, url=url,
                    kind="image" if content_type.lower().startswith("image/") else "doc",
                    size=f"{max(1, round(len(raw) / 1024))} KB")
            stored += 1
        except Exception as e:
            skips.append(f'"{name}" could not be filed: {e}')
    if len(atts) > max_files:
        skips.append(f"{len(atts) - max_files} more files were not filed")
    return stored, skips
