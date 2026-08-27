import os
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "sqlite:///./greens_nexus.db"
)

if DATABASE_URL.startswith("sqlite"):
    # `timeout` is how long a statement waits for the write lock before giving
    # up. SQLite's default is 0, so any read taken while something holds the
    # lock fails instantly with "database is locked" - which on a laptop means
    # a long write (the Asana import sweep) 500s every other request and the
    # whole app sits on a spinner.
    engine = create_engine(DATABASE_URL,
                           connect_args={"check_same_thread": False, "timeout": 30})

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record):
        """WAL lets readers carry on while a writer is mid-transaction; the
        default journal blocks them outright.

        busy_timeout is set FIRST so the journal_mode switch itself waits for
        the lock instead of failing on the spot, and the whole thing is
        best-effort: switching to WAL needs exclusive access, so a connection
        opened while a long write is in flight can still be refused - and
        raising here would fail EVERY connection and take the app down over a
        performance tweak. WAL is a property of the file, so once any one
        connection sets it, it stays set."""
        try:
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA busy_timeout=30000")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()
        except Exception as e:      # noqa: BLE001 - never block a connection
            print(f"[db] sqlite pragma skipped: {e}")
else:
    # psycopg2-binary bundles its own libpq - no system dependencies needed on
    # Azure App Service. sslmode=require encrypts without verifying the cert chain;
    # Supabase's intermediate CA isn't in Azure's trust store so verify-full fails.
    url = DATABASE_URL
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg2://", 1)
    elif url.startswith("postgresql+pg8000://"):
        url = url.replace("postgresql+pg8000://", "postgresql+psycopg2://", 1)
    engine = create_engine(
        url,
        # application_name makes our connections self-identifying in
        # pg_stat_activity (otherwise they're anonymous rows hiding behind the
        # Supavisor pooler's own label when diagnosing connection pressure).
        # connect_timeout bounds NEW-connection establishment: pool_pre_ping only
        # tests EXISTING pooled connections, so without this a stalled connect to
        # the Supabase pooler hangs the caller indefinitely. That is what wedged
        # asyncio's to_thread executor and silently stopped the leader-lease
        # renewal (background reminders/notifications) after a few minutes.
        connect_args={"sslmode": "require", "application_name": "nexus-api",
                      "connect_timeout": 10,
                      "options": "-c statement_timeout=25000"},
        # Connection budget: Supabase max_connections=60, ~10 reserved for
        # superuser/internal → ~50 usable, shared by BOTH deployment slots while
        # a deploy overlaps. The old 3+5 per worker × 8 workers = 64 potential
        # OVERSHOT that ceiling - bursts (one page load fans out 10-15 calls)
        # intermittently hit "too many clients" → instant OperationalError →
        # random 500s on any endpoint (Jul 24 diagnosis). 2+3 × 8 workers = 40
        # caps prod safely under the limit; short bursts beyond it queue for up
        # to pool_timeout instead of erroring. pool_pre_ping replaces stale
        # connections transparently; pool_recycle retires them before Supabase's
        # pooler drops them.
        pool_size=2,
        max_overflow=3,
        pool_timeout=10,
        pool_pre_ping=True,
        pool_recycle=300,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Cache invalidation rides the session lifecycle (see cache.py) so no writer
# has to remember to call it.
import cache as _cache  # noqa: E402 - needs SessionLocal to exist first
_cache.wire(SessionLocal)


class Base(DeclarativeBase):
    pass


# ── soft-deleted people are hidden everywhere, automatically ─────────────────
# "Remove from Nexus" (Aug 11) stops dropping the nexus_employees row and marks
# it instead, so it can be restored with pay, compliance and history intact.
#
# WHY THIS IS A GLOBAL HOOK rather than a filter on each query. NexusEmployee is
# read from 64 places across 31 modules - the directory, org chart, people
# pickers, approver lists, notifications, timeclock, tickets, e-sign, Asana
# sync. Relying on every one of those to remember `.filter(deleted_at == "")`
# guarantees a leak: a removed person keeps appearing in a picker somewhere, and
# whoever adds the 65th query has no way to know the rule exists. Most of those
# files also belong to other developers, who should not have to take a change
# for this. Same reasoning the cache already uses above: ride the session so no
# caller has to remember.
#
# Escape hatch: .execution_options(include_deleted=True) - used by the HR
# Deleted filter and the restore endpoint, which are the only places that
# legitimately need to SEE a removed person.
@event.listens_for(SessionLocal, "do_orm_execute")
def _hide_soft_deleted(state):
    if not state.is_select or state.is_column_load or state.is_relationship_load:
        return
    if state.execution_options.get("include_deleted", False):
        return
    from sqlalchemy.orm import with_loader_criteria   # local: models imports us
    from models import NexusEmployee, Task
    # NULL as well as "" - a row that existed before the column was added
    # reads back NULL on databases that do not backfill.
    _live = lambda cls: (cls.deleted_at == "") | (cls.deleted_at.is_(None))
    state.statement = state.statement.options(
        with_loader_criteria(NexusEmployee, _live, include_aliases=True),
        # Task trash (Aug 27): same reasoning as NexusEmployee above, and even
        # more load-bearing - GET /tasks alone does `db.query(Task).all()` with
        # nothing else in the codebase filtering deleted_at, so a per-call-site
        # filter would leak a trashed task into some list the moment a 91st
        # reader forgot to add it. Escape hatch is the same
        # .execution_options(include_deleted=True), used by the Deleted Tasks
        # tab, the restore endpoint, and trash_purge_loop.
        with_loader_criteria(Task, _live, include_aliases=True),
    )


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
