"""Signed one-click action links for the Daily Briefing email (Sep 2026 - see
daily_briefing.py's module-accordion header for the "collapsed by module, act
without opening Nexus" ask). Same shape as task_mail_actions.py's tokens, with
its own context prefix so a token minted for one purpose can never be replayed
as the other, and its own recipient-bound routing (routers/briefing_actions.py)
- GET only ever renders a confirm page, never mutates, because link scanners
(Outlook Safe Links, Gmail) prefetch every URL in a message.

Scope is deliberately narrow: only a row that is a single yes/no decision with
no photo or picker attached gets a token (task approval, a single time-off
request). Checkout/handover/receipt/assignment rows stay "Open in Nexus" -
CLAUDE.md's "photos are evidence" rule and the allocator-picker on checkout
approval mean those genuinely need the app, not a stub reason to skip them.
"""
import base64
import hashlib
import hmac
import json
import time

import task_mail_actions

# Same key task_mail_actions.py signs with, own context prefix.
_SECRET = task_mail_actions._SECRET
_CONTEXT = b"briefing-mail-action:v1:"

TOKEN_TTL_SEC = 14 * 24 * 3600   # the briefing is daily - two weeks covers a
                                  # slow reader without a link that outlives
                                  # the decision it names


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign_token(kind: str, entity_id: str, action: str, recipient: str, *, now: float | None = None) -> str:
    """Opaque `<payload>.<sig>` binding one decision (kind+id+action) to one
    recipient until expiry."""
    payload = json.dumps({"k": kind, "id": entity_id, "a": action, "r": (recipient or "").lower(),
                          "e": int((now or time.time()) + TOKEN_TTL_SEC)},
                         separators=(",", ":")).encode()
    sig = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:16]
    return f"{_b64(payload)}.{_b64(sig)}"


def verify_token(token: str, *, now: float | None = None) -> dict | None:
    """{"kind", "id", "action", "recipient"} for a valid, unexpired token - else None."""
    try:
        p64, s64 = (token or "").split(".", 1)
        payload = _unb64(p64)
        want = hmac.new(_SECRET, _CONTEXT + payload, hashlib.sha256).digest()[:16]
        if not hmac.compare_digest(want, _unb64(s64)):
            return None
        data = json.loads(payload)
        if int(data.get("e", 0)) < (now or time.time()):
            return None
        return {"kind": data["k"], "id": data["id"], "action": data["a"], "recipient": data.get("r", "")}
    except Exception:
        return None


def action_url(kind: str, entity_id: str, action: str, recipient: str) -> str:
    token = sign_token(kind, entity_id, action, recipient)
    return f"{task_mail_actions.api_base()}/briefing-actions/page?token={token}"
