"""Outbound mail via Microsoft Graph - app-only (client-credentials) flow.

Same auth pattern already used independently in routers/notifications.py,
routers/hr.py, routers/esign.py and routers/qa.py (AZURE_TENANT_ID /
AZURE_CLIENT_ID / AZURE_CLIENT_SECRET + a shared-mailbox sender). This module
exists so the Ticket Notification workflow doesn't add a 5th copy of that
token-fetch logic - those other call sites are left as-is (each is a small,
independently-shipped feature; not touching them keeps this change scoped to
tickets).

Unlike the existing `send_alert` (routers/notifications.py), which calls
`/sendMail` directly, this sends via create-draft → send-by-id. `/sendMail` is
fire-and-forget and returns no body - no message id, so nothing to store for
"which Outlook thread does this belong to." Create+send gives back `id`,
`conversationId` and `internetMessageId` from the create response, which the
Ticket Notification workflow needs to store (delivery log, future threading).
It costs one extra HTTP round-trip; for ticket emails (not high-volume
transactional alerts) that's the right trade.
"""
import os
import time

import httpx

_AZURE_TENANT_ID     = os.getenv("AZURE_TENANT_ID", "")
_AZURE_CLIENT_ID     = os.getenv("AZURE_CLIENT_ID", "")
_AZURE_CLIENT_SECRET = os.getenv("AZURE_CLIENT_SECRET", "")
# Default sender - the admin-configurable override (NexusSetting, see
# ticket_notify.py) takes precedence when set; this is only the fallback.
DEFAULT_FROM_EMAIL = os.getenv("NEXUS_FROM_EMAIL", "")


class GraphMailError(Exception):
    pass


def graph_configured() -> bool:
    return bool(_AZURE_TENANT_ID and _AZURE_CLIENT_ID and _AZURE_CLIENT_SECRET)


def _graph_token() -> str:
    if not graph_configured():
        raise GraphMailError(
            "Email not configured - set AZURE_CLIENT_SECRET (and AZURE_TENANT_ID/"
            "AZURE_CLIENT_ID) in env vars, and grant the Entra app the Mail.Send "
            "application permission."
        )
    resp = httpx.post(
        f"https://login.microsoftonline.com/{_AZURE_TENANT_ID}/oauth2/v2.0/token",
        data={
            "grant_type":    "client_credentials",
            "client_id":     _AZURE_CLIENT_ID,
            "client_secret": _AZURE_CLIENT_SECRET,
            "scope":         "https://graph.microsoft.com/.default",
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


_token_cache: tuple[str, float] = ("", 0.0)


def access_token() -> str:
    """The app-only Graph token, for callers that talk to Graph directly rather
    than through send_mail - task_inbound.py reads the task mailbox. Same
    reasoning as this module's docstring: one token-fetch, not a sixth copy.

    Cached, unlike the send path: draining a mailbox is several Graph calls per
    message (fetch, mark read, file it), and a token round trip in front of each
    one would cost more than the work. Entra tokens last an hour; 45 minutes
    leaves room for a slow batch to finish on the token it started with."""
    global _token_cache
    tok, expires = _token_cache
    if tok and time.time() < expires:
        return tok
    tok = _graph_token()
    _token_cache = (tok, time.time() + 45 * 60)
    return tok


def send_mail(*, from_email: str, to: list[str], cc: list[str] | None,
              subject: str, html: str, reply_to: str = "") -> dict:
    """Sends one email; returns {messageId, conversationId, internetMessageId}
    on success. Raises GraphMailError on any failure (unconfigured, HTTP
    error, network error) - callers must catch this, never let it propagate
    into a ticket-mutating request (email delivery must never block a ticket
    operation)."""
    if not from_email:
        raise GraphMailError("No sender mailbox configured (NexusSetting ticket_notify_config.fromMailbox / NEXUS_FROM_EMAIL)")
    if not to:
        raise GraphMailError("No recipient")
    try:
        token = _graph_token()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        message = {
            "subject": subject,
            "body": {"contentType": "HTML", "content": html},
            "toRecipients": [{"emailAddress": {"address": e}} for e in to],
        }
        if cc:
            message["ccRecipients"] = [{"emailAddress": {"address": e}} for e in cc]
        if reply_to:
            message["replyTo"] = [{"emailAddress": {"address": reply_to}}]

        # 1) Create the draft - this response carries the ids we need to store.
        # NOTE: creating a draft WRITES to the mailbox, so it needs the
        # Mail.ReadWrite APPLICATION permission - Mail.Send alone only covers
        # /sendMail. With just Mail.Send, this step 403s (ErrorAccessDenied);
        # rather than fail the email, fall back to fire-and-forget /sendMail
        # below (the message still goes out, we just get no ids to store for
        # Outlook threading). Grant Mail.ReadWrite (ideally scoped to the
        # sender mailbox with an Exchange application access policy) to get
        # the full draft flow + threading back.
        create_resp = httpx.post(
            f"https://graph.microsoft.com/v1.0/users/{from_email}/messages",
            headers=headers, json=message, timeout=15,
        )
        if create_resp.status_code == 403:
            send_resp = httpx.post(
                f"https://graph.microsoft.com/v1.0/users/{from_email}/sendMail",
                headers=headers, json={"message": message, "saveToSentItems": True}, timeout=15,
            )
            if not send_resp.is_success:
                raise GraphMailError(f"Graph sendMail failed ({send_resp.status_code}): {send_resp.text[:500]}")
            return {"messageId": "", "conversationId": "", "internetMessageId": ""}
        if not create_resp.is_success:
            raise GraphMailError(f"Graph create-message failed ({create_resp.status_code}): {create_resp.text[:500]}")
        created = create_resp.json()
        message_id = created.get("id", "")

        # 2) Send it by id.
        send_resp = httpx.post(
            f"https://graph.microsoft.com/v1.0/users/{from_email}/messages/{message_id}/send",
            headers=headers, timeout=15,
        )
        if not send_resp.is_success:
            raise GraphMailError(f"Graph send-message failed ({send_resp.status_code}): {send_resp.text[:500]}")

        return {
            "messageId": message_id,
            "conversationId": created.get("conversationId", ""),
            "internetMessageId": created.get("internetMessageId", ""),
        }
    except GraphMailError:
        raise
    except Exception as e:
        raise GraphMailError(str(e)) from e
