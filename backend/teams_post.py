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
