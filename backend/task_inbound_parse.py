"""Pure helpers for the email <-> task bridge: the reply address that routes a
message back to its task, and turning a reply's body into a comment body.

No DB, no network, no Graph - every function here is a value in, a value out, so
the fiddly half of inbound email (which client quoted what, where a signature
starts, what HTML is safe to store) is unit-testable without a mailbox. The
side-effecting half lives in task_inbound.py.

Two things worth knowing before editing:

**The reply address is signed.** `tasks+<task hex>.<hmac>@…` - without the HMAC,
anyone who can guess a task id could post a comment on any task in the company
by emailing the mailbox. Plus addressing is enabled tenant-wide in Exchange
Online (`AllowPlusAddressInRecipients`), so the sub-address survives the round
trip and Reply/Reply-All in every client keeps it in To.

**The body is sanitized here, not at render time.** A comment body is stored as
HTML and rendered as HTML (`sanitizeRichHtml`, tasks/lib.js), but it is ALSO
inlined into the outbound notification email that fans the comment out to the
assignee and followers - the client sanitizer never runs on that path. An
emailed reply is the only comment body written by someone the app has not
authenticated in-session, so it is sanitized on the way in, once, at the trust
boundary. The tag set mirrors RICH_TAGS in tasks/lib.js so nothing survives
here that the renderer would only strip later.
"""
import hashlib
import hmac
import os
import re
import uuid
from html import escape
from html.parser import HTMLParser

# Same secret as the vault (secret_box.py's reasoning: one secret to manage on
# Azure rather than two). The dev fallback is deterministic so a laptop can
# round-trip an address without any setup - it protects nothing, which is fine
# because a laptop's backend is not the sync worker and never reads the mailbox.
_SECRET = (os.getenv("NEXUS_VAULT_KEY", "").strip()
           or "nexus-task-reply-DEV-ONLY-key-set-NEXUS_VAULT_KEY").encode()

_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_TOKEN = re.compile(r"^([0-9a-f]{32})\.([0-9a-f]{8})$")


def _sign(hexid: str) -> str:
    return hmac.new(_SECRET, hexid.encode(), hashlib.sha256).hexdigest()[:8]


def reply_address(mailbox: str, task_id: str) -> str:
    """`tasks+<hex>.<sig>@greensglobal.com` for one task.

    Falls back to the plain mailbox when the id isn't a uuid (nothing in this
    codebase generates another shape, but a fallback beats a malformed
    Reply-To) - such a reply still routes by threading headers."""
    mailbox = (mailbox or "").strip()
    if "@" not in mailbox:
        return mailbox
    hexid = (task_id or "").replace("-", "").lower()
    if not _HEX32.match(hexid):
        return mailbox
    local, domain = mailbox.rsplit("@", 1)
    local = local.split("+", 1)[0]        # never stack a second sub-address
    return f"{local}+{hexid}.{_sign(hexid)}@{domain}"


def task_id_from_recipients(mailbox: str, addresses) -> str:
    """The task id a reply is addressed to, or "" - checked against the HMAC, so
    a hand-typed or tampered sub-address resolves to nothing rather than to
    someone else's task."""
    base = (mailbox or "").strip().lower()
    if "@" not in base:
        return ""
    base_local, base_domain = base.rsplit("@", 1)
    base_local = base_local.split("+", 1)[0]
    for addr in addresses or []:
        addr = (addr or "").strip().lower()
        if "@" not in addr:
            continue
        local, domain = addr.rsplit("@", 1)
        if domain != base_domain or "+" not in local:
            continue
        head, sub = local.split("+", 1)
        if head != base_local:
            continue
        m = _TOKEN.match(sub)
        if not m:
            continue
        hexid, sig = m.group(1), m.group(2)
        if not hmac.compare_digest(sig, _sign(hexid)):
            continue
        return str(uuid.UUID(hexid))
    return ""


# ── Automated mail ───────────────────────────────────────────────────────────
# An out-of-office bouncing off the "new comment" notification, which is itself
# sent BECAUSE of an inbound reply, is the loop this module has to not start.
# The actor is already excluded from their own notification, so the remaining
# risk is machine mail, and machine mail announces itself in the headers.
_AUTO_HEADERS = ("x-autoreply", "x-autorespond", "x-auto-response-suppress",
                 "x-mailer-daemon", "list-id", "list-unsubscribe")
_AUTO_PRECEDENCE = ("bulk", "auto_reply", "autoreply", "junk", "list")


def is_auto_reply(headers: dict) -> bool:
    """`headers` keyed by lowercased name (see task_inbound._headers)."""
    h = {(k or "").lower(): (v or "").strip() for k, v in (headers or {}).items()}
    if h.get("auto-submitted", "no").lower() != "no":
        return True
    if h.get("precedence", "").lower() in _AUTO_PRECEDENCE:
        return True
    # A null return path is what a bounce/DSN carries.
    if h.get("return-path", "").replace(" ", "") == "<>":
        return True
    return any(k in h for k in _AUTO_HEADERS)


# ── Quoted history and signatures ────────────────────────────────────────────
# Graph's `uniqueBody` already strips most quoted history, which is why this
# module asks for it. These are the leftovers it does not catch, and the case
# where uniqueBody is unavailable and `body` is all we have.
_HTML_CUTS = (
    'id="appendonsend"',        # Outlook: everything after is the quoted original
    'id="divrplyfwdmsg"',       # Outlook reply/forward header block
    'id="signature"',
    'class="gmail_quote"',
    'class="gmail_signature"',
    'class="moz-cite-prefix"',
    "-----original message-----",
)
_TEXT_CUTS = re.compile(
    r"(?im)^\s*(?:--\s*$"
    r"|_{10,}\s*$"
    r"|-{5,}\s*original message\s*-{5,}"
    r"|from:\s.+\bsent:\s"
    r"|on\s.{0,80}\bwrote:\s*$"
    r"|sent from my \w+"
    r"|get outlook for \w+)"
)


def strip_quoted_html(html: str) -> str:
    """Cut at the earliest quote/signature marker. Substring search on purpose:
    these are client-emitted ids and classes, not a grammar, and a parser would
    give a false sense of rigor over what is inherently a heuristic."""
    s = html or ""
    low = s.lower()
    cut = len(s)
    for marker in _HTML_CUTS:
        i = low.find(marker)
        if i != -1:
            # Back up to the start of the tag carrying the marker.
            start = low.rfind("<", 0, i)
            cut = min(cut, start if start != -1 else i)
    return s[:cut]


def strip_quoted_text(text: str) -> str:
    m = _TEXT_CUTS.search(text or "")
    return (text or "")[:m.start()] if m else (text or "")


def inline_is_referenced(html: str, content_id: str) -> bool:
    """Whether `cid:<content_id>` appears in this stretch of HTML.

    Fed the KEPT part of the reply (strip_quoted_html), it is what separates an
    image the sender actually put in their message from the logo in their
    signature: the signature's <img> lives in the part that was cut, so its
    content id is not referenced here. Without this every reply from anyone with
    a branded signature would attach a copy of the company logo to the task.

    Graph returns the id sometimes bracketed, sometimes not; the HTML never
    brackets it."""
    cid = (content_id or "").strip().strip("<>").lower()
    return bool(cid) and f"cid:{cid}" in (html or "").lower()


# ── HTML sanitizing ──────────────────────────────────────────────────────────
# Mirrors RICH_TAGS/RICH_ATTRS in tasks/lib.js. `img` is deliberately NOT here:
# an emailed image is either a signature logo or a cid: reference to a real
# attachment, and neither is a thing to store in a comment body. Phase 2 turns
# genuine attachments into TaskAttachment rows instead.
_ALLOWED = {"p", "br", "b", "strong", "i", "em", "u", "s", "strike", "del",
            "code", "pre", "ul", "ol", "li", "a", "h1", "h2", "h3", "h4",
            "hr", "mark"}
_VOID = {"br", "hr"}
# Dropped WITH their contents - a quoted reply, and anything executable.
_DROP_TREE = {"script", "style", "head", "title", "blockquote", "form",
              "iframe", "object", "embed", "svg", "math"}
# Unwrapped, but they end a line: Outlook writes every paragraph as a <div>, and
# unwrapping those without this runs the whole message into one line.
_BREAK_ON_CLOSE = {"div", "tr"}
_SAFE_URL = re.compile(r"^(https?:|mailto:)", re.I)

MAX_BODY_CHARS = 20000


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.open = []          # allowed tags we actually emitted, for closing
        self.drop_tag = ""      # tag whose subtree we're inside
        self.drop_depth = 0

    def handle_starttag(self, tag, attrs):
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth += 1
            return
        if tag in _DROP_TREE:
            self.drop_tag, self.drop_depth = tag, 1
            return
        if tag not in _ALLOWED:
            return                                  # unwrap: children survive
        if tag in _VOID:
            self.out.append(f"<{tag}>")
            return
        if tag == "a":
            href = ""
            for k, v in attrs:
                if (k or "").lower() == "href" and _SAFE_URL.match((v or "").strip()):
                    href = (v or "").strip()
            if not href:
                return                              # a link to nowhere: unwrap it
            self.out.append(f'<a href="{escape(href, quote=True)}">')
        else:
            self.out.append(f"<{tag}>")
        self.open.append(tag)

    def handle_startendtag(self, tag, attrs):
        if not self.drop_depth and tag in _VOID:
            self.out.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if self.drop_depth:
            if tag == self.drop_tag:
                self.drop_depth -= 1
                if not self.drop_depth:
                    self.drop_tag = ""
            return
        if tag in self.open:
            # Close anything left dangling inside it - email HTML is rarely well
            # formed, and an unclosed <b> would otherwise bold the rest.
            while self.open:
                t = self.open.pop()
                self.out.append(f"</{t}>")
                if t == tag:
                    break
        if tag in _BREAK_ON_CLOSE and tag not in _ALLOWED:
            self.out.append("<br>")

    def handle_data(self, data):
        if not self.drop_depth and data:
            self.out.append(escape(data, quote=False))

    def result(self) -> str:
        while self.open:
            self.out.append(f"</{self.open.pop()}>")
        return "".join(self.out)


def sanitize_html(html: str) -> str:
    p = _Sanitizer()
    p.feed(html or "")
    p.close()
    out = p.result()
    out = re.sub(r"(?:\s|&nbsp;|<br>)+$", "", out)          # trailing blank lines
    out = re.sub(r"(?:<br>\s*){3,}", "<br><br>", out)       # runs of empty lines
    return out.strip()


def has_text(html: str) -> bool:
    """Whether anything but markup and whitespace survived."""
    return bool(re.sub(r"<[^>]*>|&nbsp;|\s", "", html or ""))


def plain_to_html(text: str) -> str:
    """Same shape richBodyHtml (tasks/lib.js) produces for a plain-text body, so
    a reply from a text-only client renders like every other comment."""
    lines = [escape(l.strip(), quote=False) for l in (text or "").splitlines()]
    return "".join(f"<p>{l}</p>" for l in lines if l)


def clean_body(*, html: str = "", text: str = "") -> str:
    """A reply's body as a comment body: HTML preferred, plain text as fallback,
    quoted history and signature cut, sanitized, truncated if absurd.

    Returns "" when nothing is left - a reply that is only a signature, or only
    the quoted original, is not a comment. The caller decides what that means
    (with attachments it is still worth posting; without, it is dropped)."""
    if html and html.strip():
        body = sanitize_html(strip_quoted_html(html))
    else:
        body = plain_to_html(strip_quoted_text(text))
    if not has_text(body):
        return ""
    if len(body) > MAX_BODY_CHARS:
        # The full message stays in the mailbox; a comment is not an archive.
        body = body[:MAX_BODY_CHARS] + "<p>[This reply was truncated]</p>"
    return body
