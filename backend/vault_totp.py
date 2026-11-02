"""Authenticator codes for shared logins (Credentials, Oct 29 2026).

A shared account with two-step sign-in (the bank portal, the domain
registrar, the Microsoft admin account) could not live in the vault, because
the code lived on one person's phone. A credential can now hold the
authenticator key the site showed at setup (the text under the QR code, or
the otpauth:// link), encrypted like the password; the vault shows the
current six-digit code to whoever may open the credential.

RFC 6238 TOTP: HMAC-SHA1 over the 30-second counter, six digits - what
Google Authenticator, Microsoft Authenticator and every site that offers a
QR code use by default. No dependency: hmac + struct from the standard
library.
"""
import base64
import hmac
import re
import struct
import time
from hashlib import sha1
from urllib.parse import parse_qs, unquote, urlparse

PERIOD = 30
DIGITS = 6


def normalize(raw: str) -> str:
    """The base32 key from what a person pastes: the bare key with spaces,
    lower-case or dashes, or the whole otpauth://totp/... link. Returns ''
    when it is not a usable key."""
    s = (raw or "").strip()
    if s.lower().startswith("otpauth://"):
        q = parse_qs(urlparse(unquote(s)).query)
        s = (q.get("secret") or [""])[0]
    s = re.sub(r"[\s\-]", "", s).upper().rstrip("=")
    if not s or re.search(r"[^A-Z2-7]", s):
        return ""
    try:
        base64.b32decode(s + "=" * (-len(s) % 8), casefold=True)
    except Exception:
        return ""
    return s


def code_at(secret_b32: str, at: float | None = None) -> tuple[str, int]:
    """(six-digit code, seconds until it changes) for the key, at `at` (now)."""
    now = time.time() if at is None else at
    counter = int(now // PERIOD)
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), sha1).digest()
    offset = digest[-1] & 0x0F
    number = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{number % (10 ** DIGITS):0{DIGITS}d}", PERIOD - int(now % PERIOD)
