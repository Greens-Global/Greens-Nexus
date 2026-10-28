"""The runner loop (spec 6.2): leader-only, every 5 seconds, all of it in
a thread (`await asyncio.to_thread(tick)` - never a database call on the
event loop). One tick:

  1. refreshes the subscribed-key setting (which event keys active
     workflows use - the request workers write high-volume events only
     for those);
  2. once a minute, pauses workflows that can no longer run (owner gone,
     grant lost, action missing) as needs_attention;
  3. resumes due waits (delays, retries, expired budgets) - always, so a
     run already waiting finishes even while everything is paused
     (Review Focus 4);
  4. unless everything is paused: claims up to 200 unprocessed outbox rows
     with one conditional UPDATE (`processed_at == ''`) and runs the
     workflows each starts; fires due schedules and date triggers;
  5. approval reminders and expiry;
  6. purges: outbox 7 days (a wanted row never processed is reported to
     the Global Admins), step rows 90 days, runs 180 days.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import models
from workflows import approvals, catalog, engine, scheduler
from workflows import settings as wf_settings

# `workflows.emit` the attribute is the re-exported FUNCTION; the module
# holds the subscribed-key cache.
emit = importlib.import_module("workflows.emit")

CLAIM_BATCH = 200
TICK_SECONDS = 5
FIRST_WAIT = 90
EVENT_DAYS = 7
STEP_DAYS = 90
RUN_DAYS = 180
_last_health = 0.0
_last_purge = 0.0


def _iso(dt: Optional[datetime] = None) -> str:
    return (dt or datetime.now(timezone.utc)).isoformat()


# ── the database's part of the catalog ───────────────────────────────────────
def sync_db_catalog(db) -> None:
    """Once per tick, before any run context is built: the HR pack registers
    the custom fields and the checklist / letter template choices that only
    the database knows (`packs.hr.sync_catalog`). Never raises."""
    try:
        from workflows.packs import hr as hr_pack
        hr_pack.sync_catalog(db)
    except Exception as e:   # noqa: BLE001 - the static catalog still runs
        print(f"[workflows] catalog sync failed: {type(e).__name__}: {str(e)[:200]}")


# ── subscribed keys ──────────────────────────────────────────────────────────
def refresh_subscribed(db) -> list[str]:
    keys = set()
    for wf in db.query(models.Workflow).filter(models.Workflow.status == "active").all():
        trig = wf.trigger if isinstance(wf.trigger, dict) else {}
        if trig.get("kind") == "event" and trig.get("event"):
            keys.add(str(trig["event"]))
    keys_sorted = sorted(keys)
    row = db.get(models.NexusSetting, emit.SUBSCRIBED_KEY)
    value = json.dumps(keys_sorted)
    if row is None:
        db.add(models.NexusSetting(key=emit.SUBSCRIBED_KEY, value=value, updated_by="workflows@nexus",
                                   updated_at=_iso()))
    elif row.value != value:
        row.value, row.updated_at = value, _iso()
    db.commit()
    emit.refresh_subscribed(keys_sorted)
    return keys_sorted


# ── health ───────────────────────────────────────────────────────────────────
def check_health(db) -> int:
    n = 0
    for wf in db.query(models.Workflow).filter(models.Workflow.status == "active").all():
        reason = engine.check_health(db, wf)
        if reason:
            engine.pause_needs_attention(db, wf, reason)
            db.commit()
            n += 1
    return n


# ── the outbox ───────────────────────────────────────────────────────────────
def claim_events(db, now: Optional[datetime] = None, limit: int = CLAIM_BATCH) -> list[models.WorkflowEvent]:
    """Take up to `limit` unprocessed rows with one conditional UPDATE
    (ops_report_schedules._claim's pattern): a row another process took
    first is not in the result."""
    E = models.WorkflowEvent
    stamp = _iso(now)
    # a row older than the outbox window is never run: the purge drops it
    # and says so (spec 6.5)
    cutoff = ((now or datetime.now(timezone.utc)) - timedelta(days=EVENT_DAYS)).isoformat()
    ids = [r.id for r in db.query(E.id).filter(E.processed_at == "", E.at >= cutoff)
           .order_by(E.at).limit(limit).all()]
    if not ids:
        return []
    n = (db.query(E).filter(E.id.in_(ids), E.processed_at == "")
         .update({E.processed_at: stamp, E.attempts: E.attempts + 1}, synchronize_session=False))
    db.commit()
    if not n:
        return []
    return db.query(E).filter(E.id.in_(ids), E.processed_at == stamp).order_by(E.at).all()


def process_events(db, rows: list) -> int:
    runs = 0
    for ev in rows:
        try:
            runs += len(engine.handle_event(db, ev))
        except Exception as e:   # noqa: BLE001 - one bad event never stops the rest
            try:
                db.rollback()
            except Exception:   # noqa: BLE001
                pass
            print(f"[workflows] event {ev.id} ({ev.key}) failed: {type(e).__name__}: {str(e)[:200]}")
            try:
                row = db.get(models.WorkflowEvent, ev.id)
                if row is not None:
                    row.error = f"{type(e).__name__}: {str(e)[:300]}"
                    db.commit()
            except Exception:   # noqa: BLE001
                db.rollback()
    return runs


# ── waits ────────────────────────────────────────────────────────────────────
def resume_due(db, now: Optional[datetime] = None, limit: int = 100) -> int:
    W = models.WorkflowWait
    stamp = _iso(now)
    due = (db.query(W).filter(W.due_at != "", W.due_at <= stamp, W.claimed_at == "")
           .order_by(W.due_at).limit(limit).all())
    n = 0
    for w in due:
        taken = (db.query(W).filter(W.id == w.id, W.claimed_at == "")
                 .update({W.claimed_at: stamp}, synchronize_session=False))
        db.commit()
        if not taken:
            continue
        w = db.get(W, w.id)
        if w is None:
            continue
        try:
            if w.kind == "approval":
                engine.resume(db, w, outcome="expired")
            else:
                engine.resume(db, w)
            n += 1
        except Exception as e:   # noqa: BLE001
            db.rollback()
            print(f"[workflows] resume of run {w.run_id} failed: {type(e).__name__}: {str(e)[:200]}")
    return n


# ── schedules and dates ──────────────────────────────────────────────────────
def fire_schedules(db, now: Optional[datetime] = None) -> int:
    n = 0
    for wf, cid, period in scheduler.due_schedules(db, now):
        key = f"wf:{wf.id}:{cid}:{period}"
        if not scheduler.claim(db, wf, key):
            continue
        company = db.get(models.HrEntity, cid)
        try:
            run = engine.run_for(db, wf, trigger_kind="schedule", entity=catalog.ENTITIES.get("company"),
                                 subject=company, dedupe_key=key)
            n += 1 if run is not None else 0
        except Exception as e:   # noqa: BLE001
            db.rollback()
            print(f"[workflows] schedule {wf.id} for {cid} failed: {type(e).__name__}: {str(e)[:200]}")
    return n


def fire_dates(db, now: Optional[datetime] = None) -> int:
    n = 0
    for wf, row, day in scheduler.due_dates(db, now):
        sid = str(getattr(row, "id", "") or "")
        key = f"wf:{wf.id}:{sid}:{day}"
        if not scheduler.claim(db, wf, key):
            continue
        ent = catalog.ENTITIES.get(str((wf.trigger or {}).get("entity") or ""))
        try:
            run = engine.run_for(db, wf, trigger_kind="date", entity=ent, subject=row, dedupe_key=key)
            n += 1 if run is not None else 0
        except Exception as e:   # noqa: BLE001
            db.rollback()
            print(f"[workflows] date trigger {wf.id} for {sid} failed: {type(e).__name__}: {str(e)[:200]}")
    return n


# ── purge ────────────────────────────────────────────────────────────────────
def purge(db, now: Optional[datetime] = None) -> int:
    now = now or datetime.now(timezone.utc)
    E, S, R = models.WorkflowEvent, models.WorkflowRunStep, models.WorkflowRun
    old = (now - timedelta(days=EVENT_DAYS)).isoformat()
    lost = db.query(E).filter(E.at < old, E.processed_at == "", E.wanted == 1).count()
    if lost:
        from workflows.recipients import global_admins
        engine._bell(db, global_admins(db), "wf-outbox-dropped", "Workflow Events Dropped",
                     f"{lost} event" + ("" if lost == 1 else "s") + f" a workflow wanted waited more than {EVENT_DAYS} days "
                     "and were dropped unprocessed", priority=1)
    n = db.query(E).filter(E.at < old).delete(synchronize_session=False)
    old_steps = (now - timedelta(days=STEP_DAYS)).isoformat()
    n += db.query(S).filter(S.started_at < old_steps, S.started_at != "").delete(synchronize_session=False)
    old_runs = (now - timedelta(days=RUN_DAYS)).isoformat()
    n += db.query(R).filter(R.started_at < old_runs, R.status.in_(["succeeded", "failed", "skipped", "cancelled", "test"])
                            ).delete(synchronize_session=False)
    db.commit()
    return n


# ── the tick ─────────────────────────────────────────────────────────────────
def tick(now: Optional[datetime] = None, *, force_health: bool = False, force_purge: bool = False) -> dict:
    """One pass. Blocking - call it from a thread."""
    global _last_health, _last_purge
    from database import SessionLocal
    catalog.load_packs()
    now = now or datetime.now(timezone.utc)
    out = {"events": 0, "runs": 0, "resumed": 0, "scheduled": 0, "purged": 0, "attention": 0, "approvals": {}}
    db = SessionLocal()
    try:
        sync_db_catalog(db)
        refresh_subscribed(db)
        mono = time.monotonic()
        if force_health or mono - _last_health > 60:
            out["attention"] = check_health(db)
            _last_health = mono
        out["resumed"] = resume_due(db, now)
        paused = bool(wf_settings.get(db).get("pausedAll"))
        if not paused:
            rows = claim_events(db, now)
            out["events"] = len(rows)
            out["runs"] = process_events(db, rows)
            out["scheduled"] = fire_schedules(db, now) + fire_dates(db, now)
        out["approvals"] = approvals.sweep(db, now)
        if force_purge or mono - _last_purge > 3600:
            out["purged"] = purge(db, now)
            _last_purge = mono
    finally:
        db.close()
    return out


async def workflows_loop():
    """Every 5 s in the leader, the tick in a thread. Any failure is one
    line; the loop never dies."""
    await asyncio.sleep(FIRST_WAIT)
    while True:
        try:
            await asyncio.to_thread(tick)
        except Exception as e:   # noqa: BLE001 - a failed tick is logged, the next one runs
            print(f"[workflows] tick failed: {type(e).__name__}: {str(e)[:200]}")
        await asyncio.sleep(TICK_SECONDS)
