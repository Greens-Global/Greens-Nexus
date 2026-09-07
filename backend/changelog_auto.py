"""Automatic "What's New" drafting (Sept 2026).

The changelog has had a "Generate from git" button in Manage since July: pull
recent commits, let Claude fold them into plain-English, user-facing entries,
file them as Pending Review for an admin to publish. Nothing ever pressed it
on a schedule, so the review queue only filled when somebody remembered.

This loop presses it - on the deployed API only, dev and prod. It calls
routers.task_config.run_changelog_generation, the same function the button
calls, so there is one generation path and a field added to it shows up in
both (asana_sync's rule; a second inbound path silently drifts).

TWO TRIGGERS, ONE SWEEP. The timer below is the backstop; the fast path is
GitHub's push webhook (routers/github_webhook.py), which fires on every merge
to the branch this deployment tracks. Neither runs a generation itself - both
just move the persisted due time, and the single loop here does the work. That
is deliberate: a webhook arrives on whichever of the 8 gunicorn workers answers
it, and a two-minute Claude call inside a request would be killed by the deploy
restart that same merge triggers.

WHY next_run_at IS PERSISTED, not slept. Merging to dev restarts the dev API,
often several times a day. A loop that slept 24h from boot would be killed at
hour 3 every time and never fire. The due time lives in NexusSetting
(key="changelog_auto_state") so it survives restarts: a boot mid-interval just
waits out the remainder, and a boot past the due time generates once. It is
also what makes the webhook safe - a push that lands mid-deploy leaves the due
time behind, and the instance that comes back up honors it.

Gating, three layers, each answering a different question:
  - is_deployed_worker() in main.py - is this the deployed API at all? A laptop
    must never spend the shared Anthropic key or file drafts into the live
    review queue.
  - leader election (leader.py) - one deployed instance out of however many.
  - the Postgres advisory lock below - belt and braces across a leadership flap
    mid-generation, when a Claude call can be in flight for up to two minutes.

Env:
  NEXUS_CHANGELOG_AUTO=false             turn the loop off (default on)
  NEXUS_CHANGELOG_INTERVAL_HOURS=24      backstop sweep interval (default 24)
  NEXUS_CHANGELOG_AUTHOR=...             authorId stamped on generated drafts
  NEXUS_CHANGELOG_MERGE_DELAY_MINUTES=5  wait after a merge before drafting
  NEXUS_CHANGELOG_MAX_DEFER_MINUTES=30   cap on how far a merge burst defers
Plus what the generation itself needs on the server: ANTHROPIC_API_KEY,
GITHUB_TOKEN (Contents:Read), NEXUS_CHANGELOG_BRANCH=main on prod, and
GITHUB_WEBHOOK_SECRET for the push webhook.
"""
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

import models
from database import SessionLocal

_STATE_KEY = "changelog_auto_state"
_LOCK_KEY = 794216          # stable advisory-lock id (task_trash.py holds 794215)
_SETTLE_SECONDS = 300       # let startup finish before the first check
_POLL_SECONDS = 60          # one indexed settings read unless a sweep is due;
                            # tight enough that a merge-triggered due time is
                            # picked up within a minute of landing
_RETRY_HOURS = 1            # backoff after a failed sweep, so a broken key or a
                            # rate limit cannot re-fire every poll


def _enabled() -> bool:
    return os.getenv("NEXUS_CHANGELOG_AUTO", "true").strip().lower() not in ("0", "false", "no", "off")


def _interval_hours() -> float:
    try:
        h = float(os.getenv("NEXUS_CHANGELOG_INTERVAL_HOURS", "24"))
    except ValueError:
        return 24.0
    return h if h > 0 else 24.0


def _merge_delay_minutes() -> float:
    """Gap between a merge landing and the draft being written. Not just
    debounce: a backend merge redeploys and restarts this API a few minutes
    later, and waiting that out means the generation runs on the instance that
    stays up rather than being killed halfway through a Claude call."""
    try:
        return max(0.0, float(os.getenv("NEXUS_CHANGELOG_MERGE_DELAY_MINUTES", "5")))
    except ValueError:
        return 5.0


def _max_defer_minutes() -> float:
    try:
        return max(1.0, float(os.getenv("NEXUS_CHANGELOG_MAX_DEFER_MINUTES", "30")))
    except ValueError:
        return 30.0


def _author() -> str:
    return os.getenv("NEXUS_CHANGELOG_AUTHOR", "system").strip().lower() or "system"


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── Persisted schedule ─────────────────────────────────────────────────────

def _read_state(db) -> dict:
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _STATE_KEY).first()
    if not row or not row.value:
        return {}
    try:
        return json.loads(row.value) or {}
    except (TypeError, ValueError):
        return {}


def _write_state(db, patch: dict) -> None:
    state = _read_state(db)
    state.update(patch)
    row = db.query(models.NexusSetting).filter(models.NexusSetting.key == _STATE_KEY).first()
    if not row:
        row = models.NexusSetting(key=_STATE_KEY)
        db.add(row)
    row.value = json.dumps(state)
    row.updated_by = "system"
    row.updated_at = _now().isoformat()
    db.commit()


def _due(state: dict) -> bool:
    """No recorded due time (first ever run) counts as due."""
    nxt = state.get("next_run_at")
    if not nxt:
        return True
    try:
        when = datetime.fromisoformat(str(nxt))
    except ValueError:
        return True
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return _now() >= when


# ── Merge trigger ──────────────────────────────────────────────────────────

def mark_due_after_merge(reason: str = "merge") -> str:
    """Bring the next sweep forward to shortly after a merge. Sync - the
    webhook calls it via asyncio.to_thread.

    Coalescing, and why it has a ceiling: each merge pushes the due time out by
    the delay again, so ten merges in an afternoon produce ONE draft covering
    all ten rather than ten drafts racing each other. Left uncapped that would
    starve on a busy day - every merge landing inside the delay window would
    postpone the run forever - so the deferral is capped at
    _max_defer_minutes() past the first merge in the burst (`pending_since`).
    Returns a short description of what it scheduled, for the log line.
    """
    now = _now()
    target = now + timedelta(minutes=_merge_delay_minutes())
    db = SessionLocal()
    try:
        state = _read_state(db)
        pending_since = state.get("pending_since")
        if pending_since:
            try:
                first = datetime.fromisoformat(str(pending_since))
                if first.tzinfo is None:
                    first = first.replace(tzinfo=timezone.utc)
                # Never defer past the ceiling measured from the burst's start.
                target = min(target, first + timedelta(minutes=_max_defer_minutes()))
            except ValueError:
                pending_since = None
        # An earlier due time already pending (the backstop came due, or a
        # previous merge is closer) wins - never push a sweep later than it
        # was already going to run.
        if (existing := state.get("next_run_at")):
            try:
                when = datetime.fromisoformat(str(existing))
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
                target = min(target, when)
            except ValueError:
                pass
        _write_state(db, {"next_run_at": target.isoformat(),
                          "pending_since": pending_since or now.isoformat(),
                          "pending_reason": reason})
        wait = max(0, round((target - now).total_seconds() / 60))
        return f"drafting in ~{wait} min"
    finally:
        db.close()


# ── One sweep (sync - always called via asyncio.to_thread) ─────────────────

def _sweep() -> dict | None:
    """Generate if the persisted due time has passed. Returns the generation
    result, or None when it was not due / another worker holds the lock."""
    from routers.task_config import run_changelog_generation

    db = SessionLocal()
    is_pg = db.bind.dialect.name == "postgresql"
    locked = False
    try:
        if is_pg:
            locked = bool(db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _LOCK_KEY}).scalar())
            if not locked:
                return None     # another worker is mid-sweep
        state = _read_state(db)
        if not _due(state):
            return None
        reason = state.get("pending_reason") or "scheduled"
        try:
            result = run_changelog_generation(db, _author())
        except Exception as e:      # noqa: BLE001 - never let one bad sweep kill the loop
            db.rollback()
            _write_state(db, {"next_run_at": (_now() + timedelta(hours=_RETRY_HOURS)).isoformat(),
                              "last_error": str(e)[:300],
                              "last_error_at": _now().isoformat(),
                              "pending_reason": reason})
            raise
        _write_state(db, {"next_run_at": (_now() + timedelta(hours=_interval_hours())).isoformat(),
                          "last_run_at": _now().isoformat(),
                          "last_created": result.get("created", 0),
                          "last_reason": reason,
                          "last_error": "",
                          "pending_since": "", "pending_reason": ""})
        result["reason"] = reason
        return result
    finally:
        if is_pg and locked:
            db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
            db.commit()
        db.close()


async def changelog_generate_loop():
    """Draft "What's New" entries from recent commits on a schedule."""
    await asyncio.sleep(_SETTLE_SECONDS)
    while True:
        if not _enabled():
            await asyncio.sleep(6 * 3600)   # off - recheck the env later
            continue
        try:
            # Off the event loop: this does DB work AND an up-to-2-minute Claude
            # call, either of which would freeze the whole worker inline.
            result = await asyncio.to_thread(_sweep)
            if result is not None:
                created = result.get("created", 0)
                trigger = result.get("reason", "scheduled")
                if created:
                    print(f"[changelog] auto-drafted {created} update(s) from "
                          f"{result.get('scanned', 0)} commit(s) via {result.get('source')} "
                          f"({trigger}) - pending review")
                else:
                    print(f"[changelog] auto-sweep ({trigger}) found nothing to draft "
                          f"({result.get('message', 'no user-facing commits')})")
        except Exception as e:      # noqa: BLE001
            print(f"[changelog] auto-sweep failed: {e}")
        await asyncio.sleep(_POLL_SECONDS)
