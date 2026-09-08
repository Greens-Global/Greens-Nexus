"""Server-side Teams delivery for BOD/EOD posts (guaranteed-delivery queue).

The browser only COMPOSES the message; delivery is the backend's job. Each
`time_bod` row with html + channel_id and sent=0 is an undelivered post: the
/timeclock/bod endpoint makes one inline attempt so the common case lands
instantly, and `teams_post_loop` (leader-gated, main.py) retries the rest until
they deliver. The post goes out AS THE USER via a delegated Graph token minted
from their server-side BFF session (bff_session.graph_token_for_email) - the
confidential-client refresh chain lives ~90 days rolling, which is what removes
the browser-side 24h token cliff that made client-side posting lossy.

Retry policy: every RETRY_EVERY_SEC for up to MAX_ATTEMPTS or MAX_AGE_HOURS,
whichever comes first. A row that exhausts both stays sent=0 with its last
send_error recorded - visible in the row, never silently dropped. Rows from
pre-Aug-5 clients (html='') are never touched: those posted client-side and
reported their own outcome.

Ticket-update DMs (Sept 2026, bottom of this file) reuse the same queue
shape and retry policy for a second, unrelated source table
(`ticket_teams_message`) - see get_or_create_one_on_one_chat /
deliver_ticket_row / ticket_teams_post_loop.
"""
import asyncio
from datetime import datetime, timezone, timedelta

import httpx

GRAPH = "https://graph.microsoft.com/v1.0"
RETRY_EVERY_SEC = 180
MAX_ATTEMPTS = 40          # with the loop cadence this spans well past a workday
MAX_AGE_HOURS = 48         # after this the message is stale - stop trying


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def send_chat_message(token: str, chat_id: str, html: str) -> None:
    """POST one message into a Teams chat as the token's user. Raises on failure
    so the caller records the reason. Mirrors the frontend's postChatMessage."""
    r = httpx.post(
        f"{GRAPH}/chats/{chat_id}/messages",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"body": {"contentType": "html", "content": html}},
        timeout=15,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Graph {r.status_code}: {r.text[:180]}")


def deliver_row(db, row) -> bool:
    """One delivery attempt for a queued TimeBod row; commits the outcome either
    way. Synchronous (outbound HTTP) - callers must be off the event loop:
    sync endpoints run in FastAPI's threadpool, the loop uses to_thread."""
    import bff_session
    row.attempts = (row.attempts or 0) + 1
    row.last_try_at = _now_iso()
    try:
        tok = bff_session.graph_token_for_email(db, row.employee_email)
        if not tok:
            raise RuntimeError("no usable session token (signed out everywhere, or Teams consent missing)")
        send_chat_message(tok, row.channel_id, row.html)
        row.sent = 1
        row.send_error = ""
        db.commit()
        return True
    except Exception as e:
        row.send_error = str(e)[:300]
        db.commit()
        return False


def _sweep_once() -> int:
    from database import SessionLocal
    from models import TimeBod
    db = SessionLocal()
    delivered = 0
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=MAX_AGE_HOURS)).isoformat()
        rows = (db.query(TimeBod)
                .filter(TimeBod.sent == 0, TimeBod.html != "", TimeBod.channel_id != "",
                        TimeBod.attempts < MAX_ATTEMPTS, TimeBod.created_at >= cutoff)
                .order_by(TimeBod.created_at.asc()).limit(25).all())
        for row in rows:
            if deliver_row(db, row):
                delivered += 1
    finally:
        db.close()
    return delivered


async def teams_post_loop():
    """Leader-gated retry sweep (started from main.py's background jobs). All
    blocking work rides to_thread - never the event loop (Aug 2 freeze rule)."""
    while True:
        try:
            n = await asyncio.to_thread(_sweep_once)
            if n:
                print(f"[teams-post] delivered {n} queued post(s)")
        except Exception as e:
            print(f"[teams-post] sweep failed: {e}")
        await asyncio.sleep(RETRY_EVERY_SEC)


# ── Ticket-update Teams DMs ──────────────────────────────────────────────────
# Same guaranteed-delivery shape as the BOD/EOD queue above, but a 1:1 DM
# rather than a pre-bound channel post - Graph has to be asked to create the
# chat, not just told where an existing one is.

def get_or_create_one_on_one_chat(token: str, agent_upn: str, requester_upn: str) -> str:
    """Returns the id of the 1:1 chat between these two, creating it if they
    have never messaged before. Graph documents oneOnOne creation as
    idempotent: POSTing for a pair that already has a chat returns that chat
    unchanged rather than erroring, so callers don't need to check first -
    but the caller here still caches the id once known (row.chat_id) so a
    retry after a transient failure doesn't repeat the create call. Requires
    the delegated Chat.Create scope in addition to Chat.ReadBasic/
    ChatMessage.Send - if the Azure AD app hasn't been granted it yet, this
    raises and the row's send_error records exactly that (never silently
    dropped, same as every other failure mode in this queue)."""
    body = {
        "chatType": "oneOnOne",
        "members": [
            {"@odata.type": "#microsoft.graph.aadUserConversationMember", "roles": ["owner"],
             "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{agent_upn}')"},
            {"@odata.type": "#microsoft.graph.aadUserConversationMember", "roles": ["owner"],
             "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{requester_upn}')"},
        ],
    }
    r = httpx.post(
        f"{GRAPH}/chats",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body, timeout=15,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Graph {r.status_code}: {r.text[:180]}")
    return r.json()["id"]


def deliver_ticket_row(db, row) -> bool:
    """One delivery attempt for a queued TicketTeamsMessage row; commits the
    outcome either way. Synchronous - see deliver_row's note above."""
    import bff_session
    row.attempts = (row.attempts or 0) + 1
    row.last_try_at = _now_iso()
    try:
        tok = bff_session.graph_token_for_email(db, row.agent_email)
        if not tok:
            raise RuntimeError("no usable session token for the agent (signed out everywhere, or Teams consent missing)")
        chat_id = row.chat_id
        if not chat_id:
            chat_id = get_or_create_one_on_one_chat(tok, row.agent_email, row.requester_email)
            row.chat_id = chat_id
        send_chat_message(tok, chat_id, row.html)
        row.sent = 1
        row.send_error = ""
        db.commit()
        return True
    except Exception as e:
        row.send_error = str(e)[:300]
        db.commit()
        return False


def _sweep_ticket_once() -> int:
    from database import SessionLocal
    from models import TicketTeamsMessage
    db = SessionLocal()
    delivered = 0
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=MAX_AGE_HOURS)).isoformat()
        rows = (db.query(TicketTeamsMessage)
                .filter(TicketTeamsMessage.sent == 0, TicketTeamsMessage.html != "",
                        TicketTeamsMessage.attempts < MAX_ATTEMPTS, TicketTeamsMessage.created_at >= cutoff)
                .order_by(TicketTeamsMessage.created_at.asc()).limit(25).all())
        for row in rows:
            if deliver_ticket_row(db, row):
                delivered += 1
    finally:
        db.close()
    return delivered


async def ticket_teams_post_loop():
    """Leader-gated retry sweep for ticket-update DMs - same cadence and
    lifecycle as teams_post_loop, kept separate since the two queue tables
    and delivery shapes (channel post vs. 1:1 DM creation) differ."""
    while True:
        try:
            n = await asyncio.to_thread(_sweep_ticket_once)
            if n:
                print(f"[ticket-teams-post] delivered {n} queued message(s)")
        except Exception as e:
            print(f"[ticket-teams-post] sweep failed: {e}")
        await asyncio.sleep(RETRY_EVERY_SEC)
