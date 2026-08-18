"""sent.dm - unified messaging client (SMS channel first), Aug 18.

Delivers the external-login 6-digit codes by text. Deliberately tiny: ONE
send_code function against sent.dm's Send Message endpoint
(POST https://api.sent.dm/v3/messages, Bearer auth, body {to, channel, text} -
per docs.sent.dm). API key from NEXUS_SENTDM_KEY; when unset or a send fails,
callers degrade automatically to the emailed code (routers/external_auth.py) -
SMS is an upgrade, never a dependency.

Only ever called from sync `def` endpoints (FastAPI threadpool), so the
outbound HTTP never sits on the async event loop. Never log the code itself -
log only delivery status.
"""
import os

import httpx

_API_URL = "https://api.sent.dm/v3/messages"


def configured() -> bool:
    return bool(os.getenv("NEXUS_SENTDM_KEY", "").strip())


def send_code(phone: str, code: str) -> tuple[bool, str]:
    """Text `code` to `phone` (E.164, e.g. +14155551234). Returns (ok, error) -
    never raises, so a messaging outage can only ever degrade to email."""
    key = os.getenv("NEXUS_SENTDM_KEY", "").strip()
    if not key:
        return False, "sent.dm not configured (NEXUS_SENTDM_KEY unset)"
    if not (phone or "").strip():
        return False, "no phone number on file"
    try:
        resp = httpx.post(
            _API_URL,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={
                "to": [phone.strip()],
                "channel": ["sms"],
                "text": (f"{code} is your Greens Global Nexus verification code. "
                         "It expires in 10 minutes. Never share it."),
            },
            timeout=15,
        )
        if resp.status_code in (200, 201, 202):
            return True, ""
        return False, f"sent.dm returned {resp.status_code}"
    except Exception as exc:      # noqa: BLE001 - degrade, never crash a login request
        return False, f"sent.dm unreachable: {type(exc).__name__}"
