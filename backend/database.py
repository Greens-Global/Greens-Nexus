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
        connect_args={"sslmode": "require", "options": "-c statement_timeout=25000"},
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


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
