"""Pure helpers for email -> ticket (Ticket Inbound Email, Oct 2026): the
signed reply address that routes a reply back to its ticket, the "Ticket #N"
tag in a subject, and turning a subject line into a ticket title.

No DB, no network - imported by ticket_notify.py (which sets the Reply-To on
every ticket email) as well as ticket_inbound.py (which reads it back), so it
must stay free of anything that imports the tickets router.

**The reply address is signed**, like the Tasks one (task_inbound_parse.py):
`support+t<ticket hex>.<hmac>@...`. The `t` keeps a ticket token from ever
reading as a task token, and the HMAC is computed over "ticket:" + the id, so a
task's signature can never be replayed onto a ticket either. Without the HMAC,
knowing a ticket id would be enough to address its thread - the sender must
still be allowed to comment on it, but the address itself should prove the
mail is a reply to us.
"""
import hashlib
import hmac
import re
import uuid

import mail_inbound
import secret_box
from ticket_code import normalize

# Same secret as the vault and the task reply address (secret_box.py: one
# secret to manage on Azure). The dev fallback is deterministic and protects
# nothing - a laptop never reads the mailbox (leader.is_deployed_worker).
_SECRET = secret_box.signing_secret("nexus-ticket-reply-DEV-ONLY-key-set-NEXUS_VAULT_KEY")

_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_TOKEN = re.compile(r"^t([0-9a-f]{32})\.([0-9a-f]{8})$")


def _sign(hexid: str) -> str:
    return hmac.new(_SECRET, f"ticket:{hexid}".encode(), hashlib.sha256).hexdigest()[:8]


def reply_address(mailbox: str, ticket_id: str) -> str:
    """`support+t<hex>.<sig>@domain` for one ticket, or the plain mailbox when
    the id is not a uuid (such a reply still routes by threading headers or
    the subject tag)."""
    mailbox = (mailbox or "").strip()
    if "@" not in mailbox:
        return mailbox
    hexid = (ticket_id or "").replace("-", "").lower()
    if not _HEX32.match(hexid):
        return mailbox
    return mail_inbound.plus_address(mailbox, f"t{hexid}.{_sign(hexid)}")


def ticket_id_from_recipients(mailbox: str, addresses) -> str:
    """The ticket id a reply is addressed to, or "" - checked against the HMAC,
    so a hand-typed or tampered sub-address resolves to nothing."""
    for sub in mail_inbound.plus_tokens(mailbox, addresses):
        m = _TOKEN.match(sub)
        if m and hmac.compare_digest(m.group(2), _sign(m.group(1))):
            return str(uuid.UUID(m.group(1)))
    return ""


def outbound_reply_to(cfg: dict, ticket_id: str) -> str:
    """The Reply-To a ticket email carries. With inbound email on, the signed
    per-ticket address of the support mailbox, so a reply reaches its ticket;
    off, exactly what it always was - the plain `replyTo` setting (blank =
    none)."""
    mailbox = (cfg.get("inboundMailbox") or "").strip()
    if cfg.get("inboundEnabled") and "@" in mailbox:
        return reply_address(mailbox, ticket_id)
    return cfg.get("replyTo") or ""


# ── Subjects ────────────────────────────────────────────────────────────────
# Every ticket email's subject starts "Ticket #12 - ..." (ticket_code.ticket_no,
# ticket_mail_templates._ticket_subject), so a reply's subject carries it too.
_TAG = re.compile(r"\bticket\s*#\s*(\d{1,9})\b", re.I)
# Reply / forward noise in the languages Outlook writes it in, repeated.
_NOISE = re.compile(r"^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|tr|rv|r)\s*(?:\[\d+\])?\s*:\s*)+", re.I)


def subject_ticket_code(subject: str) -> str:
    """The stored code ("000012") a subject's "Ticket #12" names, or ""."""
    m = _TAG.search(subject or "")
    return normalize(m.group(1)) if m else ""


def clean_subject(subject: str) -> str:
    """A new ticket's title from an email subject: Re:/Fwd: noise and
    surrounding whitespace removed, never longer than a ticket title should
    be. "" when nothing is left."""
    s = _NOISE.sub("", subject or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s[:200]
