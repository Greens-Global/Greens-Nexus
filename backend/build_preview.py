"""Hosted previews for Build Mode pins (11/13/2026, docs/Build-Mode.md 8.11).

Cloudflare Pages already builds every pushed branch of the dev site at its own
address, `https://<branch>.greens-nexus-dev.pages.dev`, and the build carries
the same `/api` Pages Function as dev (frontend/functions/api), which sends a
preview host to the DEV backend - never production. What a preview could not
do was sign anyone in: Microsoft only returns to the addresses registered on
the Entra app, and every branch has a new one.

So the preview borrows the dev site's sign-in, the way OAuth hands over a code
with PKCE:

1. The preview keeps a random verifier in its own tab and sends the browser to
   `https://dev.nexus.greensglobal.com/api/auth/preview-handoff?to=<preview
   origin>&next=<path>&challenge=<sha256(verifier)>`.
2. The dev site (signed in by its own session cookie, signing in first when it
   is not) checks the person may use Build Mode and that `to` is one of OUR
   preview addresses, keeps a single-use code for 60 seconds and sends the
   browser back to `<to><next>#nx_preview=<code>` - in the fragment, so the
   code never reaches a server log.
3. The preview POSTs the code with its verifier to its own
   `/api/auth/preview-claim`; the backend checks both, spends the code and
   sets an ordinary session cookie on the preview's address (first-party
   through the proxy).

A code taken from the address bar is useless without the verifier, which
never left the preview's tab. The session behaves like any session of that
person on dev (the same idle expiry, the same permissions), with no Microsoft
tokens behind it, so a preview cannot post to Teams as them.

On only where the API is the DEV API (`NEXUS_APP_URL` is the dev site) or
where `NEXUS_PREVIEW_HOST_SUFFIX` names the preview suffix; the setting
`off` turns it off anywhere. Codes live in `external_login_codes` with
purpose `preview` (hashed, single use - the table's own rules), `channel`
holding the preview origin.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

DEV_SITE = "https://dev.nexus.greensglobal.com"
DEFAULT_SUFFIX = ".greens-nexus-dev.pages.dev"
PURPOSE = "preview"
CODE_TTL_S = 60

_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_B64URL = re.compile(r"[A-Za-z0-9_-]{43}")      # a sha256 digest, base64url, no padding
_CODE = re.compile(r"[A-Za-z0-9_-]{40,64}")


def _app_url() -> str:
    return os.getenv("NEXUS_APP_URL", "").strip().rstrip("/")


def host_suffix() -> str:
    """The preview host suffix this API accepts, or '' when hosted previews
    are off here. Read at call time so a setting change needs no code."""
    raw = os.getenv("NEXUS_PREVIEW_HOST_SUFFIX", "").strip().lower()
    if raw == "off":
        return ""
    if raw:
        return raw if raw.startswith(".") else "." + raw
    return DEFAULT_SUFFIX if _app_url() == DEV_SITE else ""


def preview_origin(value: str, suffix: str | None = None) -> str:
    """`https://<one label><suffix>` exactly - no path, port, user or second
    label - normalized, else ''. Parsed, never prefix-matched, so
    `https://x.greens-nexus-dev.pages.dev.evil.example` and
    `https://a@x.greens-nexus-dev.pages.dev` are both refused."""
    suffix = host_suffix() if suffix is None else suffix
    value = str(value or "").strip()
    if not suffix or not value or len(value) > 200:
        return ""
    try:
        p = urlparse(value)
        port = p.port
    except ValueError:
        return ""
    host = (p.hostname or "").lower()
    if (p.scheme != "https" or port is not None or p.username or p.password or "@" in p.netloc
            or p.path not in ("", "/") or p.query or p.fragment or not host.endswith(suffix)):
        return ""
    label = host[: -len(suffix)]
    if not _LABEL.fullmatch(label):
        return ""
    return f"https://{host}"


def preview_url_ok(url: str) -> bool:
    """A full link into a preview (any path) - what a pin may carry. Accepted
    on any API: the address only says where to look, the sign-in is the dev
    API's."""
    url = str(url or "").strip()
    if not url or len(url) > 1000:
        return False
    try:
        p = urlparse(url)
        port = p.port
    except ValueError:
        return False
    base = f"{p.scheme}://{p.netloc}" if p.netloc else ""
    return port is None and bool(preview_origin(base, host_suffix() or DEFAULT_SUFFIX))


def safe_next(value: str) -> str:
    """A path on the preview: starts with one '/', no scheme or host."""
    value = str(value or "").strip()
    if not value.startswith("/") or value.startswith("//") or "\\" in value or len(value) > 1000:
        return "/"
    if any(ord(ch) < 32 for ch in value):
        return "/"
    return value


def challenge_ok(value: str) -> bool:
    return bool(_B64URL.fullmatch(str(value or "")))


def challenge_of(verifier: str) -> str:
    digest = hashlib.sha256(str(verifier or "").encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _hash(code: str, challenge: str) -> str:
    return hashlib.sha256(f"{code}.{challenge}".encode()).hexdigest()


def _iso(dt: datetime | None = None) -> str:
    return (dt or datetime.now(timezone.utc)).isoformat()


def issue(db, email: str, origin: str, challenge: str, ip: str = "") -> str:
    """Keep one single-use code for `email` on `origin`, bound to the
    challenge; returns the code (shown once, kept only as a hash)."""
    from models import ExternalLoginCode
    code = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    db.add(ExternalLoginCode(
        id=str(uuid.uuid4()), email=(email or "").lower(), code_hash=_hash(code, challenge),
        purpose=PURPOSE, channel=origin, expires_at=_iso(now + timedelta(seconds=CODE_TTL_S)),
        attempts=0, created_ip=(ip or "")[:100], consumed_at="", created_at=_iso(now)))
    db.commit()
    return code


def claim(db, code: str, verifier: str, origin: str = "") -> str:
    """Spend a code: the email it was issued for, or '' when the code is
    unknown, spent, expired, for another preview, or the verifier does not
    match. The row is locked and spent in one transaction, so two claims of
    the same code cannot both win."""
    from models import ExternalLoginCode
    code = str(code or "")
    verifier = str(verifier or "")
    if not _CODE.fullmatch(code) or not (43 <= len(verifier) <= 128):
        return ""
    row = (db.query(ExternalLoginCode)
           .filter(ExternalLoginCode.code_hash == _hash(code, challenge_of(verifier)),
                   ExternalLoginCode.purpose == PURPOSE,
                   ExternalLoginCode.consumed_at == "")
           .with_for_update().first())
    if not row:
        return ""
    row.consumed_at = _iso()
    db.commit()
    if row.expires_at and row.expires_at < _iso():
        return ""
    # The browser names the page that sent the claim; when it does, it must
    # be the preview the code was issued for.
    if origin and origin.rstrip("/").lower() != (row.channel or "").lower():
        return ""
    return row.email or ""
