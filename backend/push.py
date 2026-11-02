"""Web Push for the bell (Frontline Reach, Neil 11/02/2026).

Nexus is a web app; installed to a phone's home screen it can still be tapped
on the shoulder through the browser's push service. This module is the whole
server half:

  configured()          - the three VAPID settings are present on the server
  queue_push(...)       - one nexus_push_outbox row per recipient who has a
                          subscribed device; a no-op until configured
  push_loop()           - the lifespan task: drains the outbox every 5 s, the
                          sends run in a thread (never on the event loop)
  the after_insert hook - every nexus_notifications row with a named
                          recipient is queued, so each module's bell notice
                          pushes without the module knowing about push

Design calls
  - Push follows the bell, nothing else: same title and body, one push per
    bell row. A person a module did not bell is not pushed; a broadcast row
    (recipient None - managers' shared inbox) is not pushed either, there is
    no device list for "all managers" and the bell already shows it.
  - OFF until an administrator sets NEXUS_VAPID_PRIVATE_KEY,
    NEXUS_VAPID_PUBLIC_KEY and NEXUS_VAPID_SUBJECT (a mailto: or https URL)
    in the Azure app settings. The keys are never generated or stored here;
    `/health` reports `secrets.push` so a missing setting is visible.
  - A device the push service says is gone (404 / 410) is deleted; five
    consecutive failures of any other kind disable it. A later successful
    subscribe from the same browser replaces the row.
  - The payload is the notice only (title, body, url, tag) - nothing a lock
    screen should not show, same as the bell. The tag is per ROW
    (`<type>:<ref or id>`): same-tag notices replace each other on the
    device, so a shared tag would silently swallow the first of two task
    bells thirty seconds apart.
  - A send waits SEND_TIMEOUT seconds at most; one hung push service must
    not hold the whole outbox (the loop awaits the thread).
  - Workflows > Automations lists the loop as `push`; off = the outbox waits.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import event
from sqlalchemy.orm import Session

import database
import job_switch
import models

VAPID_PRIVATE = "NEXUS_VAPID_PRIVATE_KEY"
VAPID_PUBLIC = "NEXUS_VAPID_PUBLIC_KEY"
VAPID_SUBJECT = "NEXUS_VAPID_SUBJECT"

DISABLE_AFTER = 5          # consecutive failures before a device is disabled
BATCH = 200                # outbox rows per pass
LOOP_SECONDS = 5
TTL_SECONDS = 24 * 3600    # the push service keeps an undelivered notice this long
SEND_TIMEOUT = 10          # seconds per send; a hung push service is a failure, not a stall


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def configured() -> bool:
    return all(os.getenv(k, "").strip() for k in (VAPID_PRIVATE, VAPID_PUBLIC, VAPID_SUBJECT))


def public_key() -> str:
    return os.getenv(VAPID_PUBLIC, "").strip()


# ── queueing ────────────────────────────────────────────────────────────────

def queue_push(db: Session, recipients: list, title: str, body: str, url: str = "", tag: str = "") -> int:
    """Write one outbox row per recipient who has at least one live device.
    Returns the rows written. Does not commit: the caller's transaction does
    (the after_insert hook runs inside the notice's own flush)."""
    if not configured():
        return 0
    emails = sorted({(e or "").strip().lower() for e in (recipients or []) if (e or "").strip()})
    if not emails:
        return 0
    subscribed = {r[0] for r in db.query(models.NexusPushSubscription.email)
                  .filter(models.NexusPushSubscription.email.in_(emails),
                          models.NexusPushSubscription.disabled.is_(False)).distinct().all()}
    now = _now_iso()
    n = 0
    for em in emails:
        if em not in subscribed:
            continue
        db.add(models.NexusPushOutbox(id=f"po_{uuid.uuid4().hex}", email=em, title=(title or "")[:200],
                                      body=(body or "")[:500], url=(url or "")[:500], tag=(tag or "")[:80],
                                      created_at=now, sent_at="", error=""))
        n += 1
    return n


def _url_for(n: models.NexusNotification) -> str:
    """The screen a tap should open: the bell's own action link when it has
    one, else the dashboard, where the bell lives."""
    try:
        act = json.loads(n.action or "null") if n.action else None
    except ValueError:
        act = None
    if isinstance(act, dict):
        for k in ("url", "href", "path"):
            v = act.get(k)
            # Same-origin paths only: "//host/x" and "\\host" resolve to
            # another site in the worker's `new URL(url, origin)`.
            if isinstance(v, str) and v.startswith("/") and not v.startswith(("//", "/\\")):
                return v
    return "/"


def _tag_for(n: models.NexusNotification) -> str:
    return f"{n.type or 'notice'}:{n.ref_id or n.id or ''}"[:80]


@event.listens_for(models.NexusNotification, "after_insert")
def _queue_for_notice(mapper, connection, target):   # noqa: ARG001 - SQLAlchemy's signature
    """Every bell row with a named recipient becomes a push. Runs inside the
    notice's flush, on the same connection, so it commits or rolls back with
    the notice; broadcast rows (recipient None / '') are skipped. The queue
    runs in a SAVEPOINT: on Postgres a failed statement would otherwise leave
    the notice's own transaction aborted, so the except below could not keep
    its promise - with the savepoint the push row is what rolls back, and the
    bell still commits."""
    if not configured():
        return
    rcpt = (target.recipient or "").strip().lower()
    if not rcpt:
        return
    try:
        # create_savepoint: the session opens a SAVEPOINT on the notice's
        # connection, commit() releases it, rollback() undoes only the push
        # rows - the outer transaction (the bell) is never touched.
        sess = Session(bind=connection, join_transaction_mode="create_savepoint")
        try:
            queue_push(sess, [rcpt], target.title or "Nexus", target.body or "", _url_for(target), _tag_for(target))
            sess.commit()
        except Exception:
            sess.rollback()
            raise
        finally:
            sess.close()
    except Exception as e:   # never let push break the notice that caused it
        print(f"[push] queue skipped: {e}")


# ── sending ─────────────────────────────────────────────────────────────────

def _send_one(sub: models.NexusPushSubscription, payload: dict) -> tuple[bool, str, bool]:
    """-> (ok, error, gone). `gone` = the push service says the device is no
    longer there (404 / 410) and the subscription should be deleted."""
    try:
        from pywebpush import WebPushException, webpush
    except ImportError as e:   # the dependency is in requirements.txt; say so plainly
        return False, f"pywebpush missing: {e}", False
    try:
        webpush(
            subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
            data=json.dumps(payload),
            vapid_private_key=os.getenv(VAPID_PRIVATE, "").strip(),
            vapid_claims={"sub": os.getenv(VAPID_SUBJECT, "").strip()},
            ttl=TTL_SECONDS,
            timeout=SEND_TIMEOUT,
        )
        return True, "", False
    except WebPushException as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        return False, f"{status or ''} {e}".strip()[:300], status in (404, 410)
    except Exception as e:   # DNS, TLS, a timeout - counted as a failure, not a gone device
        return False, (str(e) or type(e).__name__)[:300], False


def _send_batch(db: Session | None = None) -> int:
    """One pass over the outbox: send every waiting row to each of the
    person's live devices. Returns the rows handled. Runs in a thread."""
    if not configured() or job_switch.off("push"):
        return 0
    own = db is None
    db = db or database.SessionLocal()
    handled = 0
    try:
        rows = (db.query(models.NexusPushOutbox).filter(models.NexusPushOutbox.sent_at == "")
                .order_by(models.NexusPushOutbox.created_at).limit(BATCH).all())
        if not rows:
            return 0
        emails = sorted({r.email for r in rows})
        subs = (db.query(models.NexusPushSubscription)
                .filter(models.NexusPushSubscription.email.in_(emails),
                        models.NexusPushSubscription.disabled.is_(False)).all())
        by_email: dict = {}
        for s in subs:
            by_email.setdefault(s.email, []).append(s)
        now = _now_iso()
        dead: set = set()   # subscriptions deleted or disabled earlier in THIS pass: not sent to again
        for row in rows:
            payload = {"title": row.title, "body": row.body, "url": row.url or "/", "tag": row.tag or ""}
            errors = []
            for sub in by_email.get(row.email, []):
                if sub.id in dead:
                    continue
                ok, err, gone = _send_one(sub, payload)
                if ok:
                    sub.failures = 0
                    sub.last_ok_at = now
                elif gone:
                    db.delete(sub)
                    dead.add(sub.id)
                else:
                    sub.failures = int(sub.failures or 0) + 1
                    if sub.failures >= DISABLE_AFTER:
                        sub.disabled = True
                        dead.add(sub.id)
                    errors.append(err)
            row.sent_at = now
            row.error = "; ".join(errors)[:500]
            handled += 1
        db.commit()
        return handled
    except Exception as e:
        db.rollback()
        print(f"[push] send pass failed: {e}")
        return handled
    finally:
        if own:
            db.close()


async def push_loop():
    """Lifespan task (leader only, like the other loops): drain the outbox
    every few seconds. Every send runs off the event loop."""
    await asyncio.sleep(20)   # let startup settle
    while True:
        try:
            await asyncio.to_thread(_send_batch)
        except Exception as e:
            print(f"[push] loop error: {e}")
        await asyncio.sleep(LOOP_SECONDS)
