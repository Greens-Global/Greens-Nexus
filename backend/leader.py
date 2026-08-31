"""Single-leader election for the in-app background jobs.

The background loops (HR reminders, ticket/task email retries + due-date reminders,
the long-session "still clocked in?" nudge) run INSIDE the web app. With one web
instance that's fine; with two or more, every instance would run them and every
email/notification would go out TWICE. This elects exactly one leader so they run
once.

HOW: a heartbeat lease row in `nexus_leader`. Every ~15s each instance tries, in a
single atomic UPSERT, to claim or renew the lease; whoever holds a fresh lease is the
leader and runs the jobs, the others don't. If the leader stops heart-beating
(crash/restart), another instance claims the stale lease within ~45s and takes over,
starting the loops itself.

WHY A LEASE, not a Postgres advisory lock: a session-level advisory lock has to be
held on one persistent connection, which breaks through PgBouncer / the Supabase
transaction pooler (the very thing you adopt when you scale out). A one-statement
lease UPSERT works through the pooler unchanged.

SQLite (local dev): a single process, so there's nothing to coordinate - the jobs
just run, no lease.

NOT managed here: Asana sync. It already has its own advisory-lock + is_sync_worker
gating, so it's multi-instance-safe on its own.
"""
import asyncio
import os
import uuid

from sqlalchemy import text

from database import engine, DATABASE_URL

_IS_SQLITE = DATABASE_URL.startswith("sqlite")
# Stable per-process identity. Azure sets WEBSITE_INSTANCE_ID (unique per instance);
# locally we make one up so two dev processes wouldn't fight (they won't - SQLite is
# short-circuited above anyway).
_INSTANCE = os.getenv("WEBSITE_INSTANCE_ID") or ("local-" + uuid.uuid4().hex[:10])
_HEARTBEAT_SECONDS = 15
_LEASE_STALE_SECONDS = 45   # a leader silent this long is considered dead
# Hard ceiling on ONE claim attempt. The DB call runs in asyncio's to_thread
# executor (small, and separate from the pool that serves sync endpoints); if a
# claim ever wedges, this bounds the wait so the loop retries next cycle instead
# of renewal silently stopping forever. connect_timeout/statement_timeout on the
# engine free the wedged thread itself so the executor can't fill with zombies.
_CLAIM_TIMEOUT_SECONDS = 20

_is_leader = _IS_SQLITE     # single-process local dev is always the leader


def is_background_leader() -> bool:
    """True on the one instance that should run the background jobs. The loops can
    call this each iteration as a belt-and-suspenders guard, but the manager below
    already starts/stops them on leadership changes."""
    return _is_leader


def is_deployed_worker() -> bool:
    """Is this the DEPLOYED API rather than somebody's laptop?

    A different question from is_background_leader() above, which picks one
    instance out of several deployed ones. This one asks whether the process is
    deployed at all - the gate for jobs that touch shared, real-world state: the
    task reply mailbox, live Supabase storage, the Microsoft directory, and
    permanent deletes. A laptop pointed at DATABASE_URL passes the leader check
    (SQLite short-circuits it, and even on Postgres it can win the lease), so
    only this can stop it.

    WHY IT LIVES HERE (Sept 1 2026): those jobs used to ask
    asana_sync.is_sync_worker(), which answered the same question by accident -
    it read WEBSITE_SITE_NAME. Severing Asana (Aug 27) put "is Asana enabled?"
    in front of that check, and six unrelated loops silently stopped on dev and
    prod: the task email drain, both screenshot sweeps, the construction sweep,
    the nightly M365 writeback and the task trash purge. Nothing failed loudly -
    they simply never started. The lesson is that a predicate two features share
    belongs to neither of them, so this copy is owned by the background-jobs
    module and is not affected by any integration's kill switch.

    NEXUS_ASANA_SYNC_WORKER is still honored so a laptop deliberately opted in
    before this split keeps behaving the way its owner set it up to."""
    for var in ("NEXUS_BACKGROUND_WORKER", "NEXUS_ASANA_SYNC_WORKER"):
        if os.getenv(var, "").strip().lower() in ("1", "true", "yes"):
            return True
    return bool(os.getenv("WEBSITE_SITE_NAME"))   # set by Azure App Service


# Atomic claim/renew: take the lease if it's ours or if the current holder has gone
# stale. RETURNING yields a row only when the write happened -> we hold it.
_CLAIM = text(
    "INSERT INTO nexus_leader (id, holder, heartbeat_at) VALUES (1, :me, now()) "
    "ON CONFLICT (id) DO UPDATE SET holder = :me, heartbeat_at = now() "
    "WHERE nexus_leader.holder = :me "
    "   OR nexus_leader.heartbeat_at < now() - make_interval(secs => :stale) "
    "RETURNING holder"
)


def _ensure_table():
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS nexus_leader ("
            "id INTEGER PRIMARY KEY, holder VARCHAR, heartbeat_at TIMESTAMPTZ)"
        ))


def _claim_lease() -> bool:
    """Sync (runs in a worker thread): atomically claim or renew the lease.
    Returns True if this instance now holds it."""
    with engine.begin() as conn:
        return conn.execute(_CLAIM, {"me": _INSTANCE, "stale": _LEASE_STALE_SECONDS}).first() is not None


async def elect_and_run(start_jobs):
    """Run `start_jobs()` (which starts the background loops and returns their asyncio
    Tasks) ONLY while this instance holds the leader lease; cancel them when it loses
    leadership; keep retrying forever so a dead leader is replaced. On SQLite the jobs
    just run once with no election.

    Fail-open: if the lease table can't be reached at startup, run the jobs unmanaged
    rather than silently halting every reminder/notification. On a single instance
    that's correct; if it ever fired with two instances you'd see duplicate sends and
    know to look."""
    global _is_leader

    if _IS_SQLITE:
        _is_leader = True
        start_jobs()
        return

    try:
        await asyncio.to_thread(_ensure_table)
    except Exception as e:
        print(f"[leader] lease table unavailable, running jobs unmanaged: {e}")
        _is_leader = True
        start_jobs()
        return

    tasks = []
    running = False
    while True:
        try:
            # DB call off the event loop - never block the worker (CLAUDE.md).
            # wait_for caps a wedged claim so renewal resumes next cycle rather
            # than the whole loop hanging on it forever.
            won = await asyncio.wait_for(
                asyncio.to_thread(_claim_lease), timeout=_CLAIM_TIMEOUT_SECONDS)
        except Exception as e:
            # A transient DB blip (or a claim timeout) must not flip leadership
            # (which would double-start or needlessly stop jobs) - keep the current
            # state and try again next cycle.
            print(f"[leader] heartbeat error, keeping current state: {e}")
            won = running

        if won and not running:
            print(f"[leader] acquired leadership ({_INSTANCE[:14]}) - starting background jobs")
            tasks = start_jobs() or []
            running = True
        elif not won and running:
            print("[leader] lost leadership - stopping background jobs")
            for t in tasks:
                try:
                    t.cancel()
                except Exception:
                    pass
            tasks = []
            running = False

        _is_leader = won
        await asyncio.sleep(_HEARTBEAT_SECONDS)
