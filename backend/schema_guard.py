"""Schema work once per deploy, not once per worker start.

gunicorn runs 8 workers and retires each after ~1,000 requests, and every one
of them used to run create_all, ~380 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
(each takes an exclusive table lock before deciding it is a no-op), the RLS
sweep, the one-shot data UPDATEs and the check-then-insert startup seeds. Two
workers starting together could both pass a seed's "is it there?" check and
both insert.

HOW (Postgres): a worker takes a session-level advisory lock on a connection of
its own, BLOCKING - it must not start serving before the schema is ready, or
queries against a column that is not there yet 500. Holding the lock, it
compares a fingerprint of the work (main.py's source + the model table/column
set) with the one in `nexus_schema_state`:

  * same      -> release, skip. "[startup] schema: up to date, skipped"
  * different -> run the work, store the fingerprint, release.
                 "[startup] schema: applied (fingerprint ...)"

FAILURE MODE - always toward running the work, never toward skipping it. The
work is idempotent and running it in every worker is exactly what happened
before this file existed, so that is the fallback for everything: no
fingerprint, no lock connection, a lock wait that times out (a stuck peer), a
state table that cannot be read. The only way to skip is a lock held AND a
stored fingerprint read back equal to ours. The fingerprint is stored only when
the work reported success, so a failed run is retried by the next worker.

NEXUS_FORCE_MIGRATIONS=1 ignores the stored fingerprint (the work runs in every
worker start while it is set, still one at a time).

The lock lives on ONE dedicated connection, detached from the pool: advisory
locks belong to the session, so lock and unlock must be the same connection,
and closing a detached connection really closes it - which drops the lock even
if the unlock statement never ran. Same reasoning as changelog_auto.try_lock.

SQLite (local dev, the tests): one process, no advisory locks - the work just
runs, as before.
"""
import hashlib
import os

from sqlalchemy import text

LOCK_KEY = 794220            # stable advisory-lock id (794213-794216 are taken)
STATE_TABLE = "nexus_schema_state"
# How long a worker waits for a peer that is doing the schema work. gunicorn
# kills a worker that has not finished starting within --timeout (120 s), so
# the wait plus this worker's own fallback run has to fit inside that.
DEFAULT_LOCK_WAIT_SECONDS = 60
# The engine connects with statement_timeout=25000; put it back once the lock
# is held so the bookkeeping statements cannot hang either.
_STATEMENT_TIMEOUT_MS = 25000


def force_requested() -> bool:
    return os.getenv("NEXUS_FORCE_MIGRATIONS", "").strip().lower() in ("1", "true", "yes")


def lock_wait_seconds() -> int:
    try:
        return max(1, min(110, int(os.getenv("NEXUS_MIGRATION_LOCK_WAIT_SECONDS", ""))))
    except ValueError:
        return DEFAULT_LOCK_WAIT_SECONDS


def compute_fingerprint(source, metadata, extra: str = "") -> str:
    """sha256 of the migration source text + every model table.column (and its
    type name) + `extra`. Appending a migration statement, or adding a model
    column, changes it."""
    h = hashlib.sha256()
    h.update(source if isinstance(source, bytes) else source.encode("utf-8"))
    h.update(b"\x00models\x00")
    for name in sorted(metadata.tables):
        for col in sorted(metadata.tables[name].columns, key=lambda c: c.name):
            h.update(f"{name}.{col.name}:{type(col.type).__name__}\n".encode("utf-8"))
    h.update(b"\x00extra\x00" + extra.encode("utf-8"))
    return h.hexdigest()


def open_lock_connection(engine):
    """A connection of our own, autocommit, outside the pool."""
    conn = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
    try:
        conn.detach()
    except Exception:
        conn.close()
        raise
    return conn


def _is_timeout(exc) -> bool:
    code = getattr(getattr(exc, "orig", None), "pgcode", None)
    # 55P03 lock_not_available (lock_timeout), 57014 query_canceled (statement_timeout)
    return code in ("55P03", "57014") or "timeout" in str(exc).lower()


def acquire_lock(conn, wait_seconds: int) -> bool:
    """Block until we hold the advisory lock. False when the wait timed out
    (a peer has held it too long); any other failure raises."""
    ms = int(wait_seconds) * 1000
    # lock_timeout is what ends the wait; statement_timeout is raised just past
    # it (the engine default of 25 s would cut the wait short) and backs it up.
    conn.execute(text(f"SET lock_timeout = {ms}"))
    conn.execute(text(f"SET statement_timeout = {ms + 5000}"))
    try:
        conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": LOCK_KEY})
    except Exception as e:
        if _is_timeout(e):
            return False
        raise
    conn.execute(text("SET lock_timeout = 0"))
    conn.execute(text(f"SET statement_timeout = {_STATEMENT_TIMEOUT_MS}"))
    return True


def release_lock(conn, locked: bool) -> None:
    """Unlock (if held) and close. Never raises: the connection is detached, so
    close() ends the session and Postgres drops the lock with it regardless."""
    if conn is None:
        return
    try:
        if locked:
            conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
    except Exception as e:  # noqa: BLE001 - close() below still frees the lock
        print(f"[startup] schema: advisory unlock failed, closing the connection instead: {e}")
    finally:
        try:
            conn.close()
        except Exception as e:  # noqa: BLE001
            print(f"[startup] schema: lock connection close failed: {e}")


def read_fingerprint(conn):
    conn.execute(text(
        f"CREATE TABLE IF NOT EXISTS {STATE_TABLE} ("
        "id INTEGER PRIMARY KEY, fingerprint VARCHAR, applied_at TIMESTAMPTZ, applied_by VARCHAR)"
    ))
    row = conn.execute(text(f"SELECT fingerprint FROM {STATE_TABLE} WHERE id = 1")).first()
    return row[0] if row else None


def store_fingerprint(conn, fingerprint: str) -> None:
    conn.execute(text(
        f"CREATE TABLE IF NOT EXISTS {STATE_TABLE} ("
        "id INTEGER PRIMARY KEY, fingerprint VARCHAR, applied_at TIMESTAMPTZ, applied_by VARCHAR)"
    ))
    # New table - RLS per CLAUDE.md (the startup sweep normally got here first).
    conn.execute(text(f"ALTER TABLE {STATE_TABLE} ENABLE ROW LEVEL SECURITY"))
    conn.execute(text(
        f"INSERT INTO {STATE_TABLE} (id, fingerprint, applied_at, applied_by) "
        "VALUES (1, :fp, now(), :by) "
        "ON CONFLICT (id) DO UPDATE SET fingerprint = :fp, applied_at = now(), applied_by = :by"
    ), {"fp": fingerprint, "by": f"{os.getenv('WEBSITE_INSTANCE_ID', 'local')[:20]}:{os.getpid()}"})


def run_once_per_deploy(engine, is_sqlite: bool, fingerprint_fn, work) -> str:
    """Run `work()` unless another process already ran it for this fingerprint.

    `work` does the schema work and returns True when it all went through (only
    then is the fingerprint stored). Returns "applied" or "skipped"."""
    if is_sqlite:
        work()
        print("[startup] schema: applied (SQLite - no once-per-deploy guard)")
        return "applied"

    fingerprint = None
    try:
        fingerprint = fingerprint_fn()
    except Exception as e:  # noqa: BLE001 - bookkeeping must never block the work
        print(f"[startup] schema: *** fingerprint unavailable, running migrations unguarded: {e}")

    conn = None
    locked = False
    try:
        if fingerprint:
            try:
                conn = open_lock_connection(engine)
                locked = acquire_lock(conn, lock_wait_seconds())
                if not locked:
                    print(f"[startup] schema: *** waited {lock_wait_seconds()}s for another worker's "
                          f"migrations and it still holds the lock - running them here anyway")
            except Exception as e:  # noqa: BLE001
                print(f"[startup] schema: *** advisory lock unavailable, running migrations unguarded: {e}")
            if locked and force_requested():
                print("[startup] schema: NEXUS_FORCE_MIGRATIONS set - ignoring the stored fingerprint")
            elif locked:
                try:
                    if read_fingerprint(conn) == fingerprint:
                        print("[startup] schema: up to date, skipped")
                        return "skipped"
                except Exception as e:  # noqa: BLE001
                    print(f"[startup] schema: *** stored fingerprint unreadable, running migrations: {e}")

        ok = work()

        note = ""
        if not fingerprint:
            note = ", not recorded"
        elif not ok:
            note = ", not recorded - the run reported problems, so the next worker start retries it"
        else:
            try:
                if conn is None:
                    raise RuntimeError("no bookkeeping connection")
                store_fingerprint(conn, fingerprint)
            except Exception as e:  # noqa: BLE001
                note = f", not recorded: {e}"
        print(f"[startup] schema: applied (fingerprint {(fingerprint or 'unavailable')[:12]}{note})")
        return "applied"
    finally:
        release_lock(conn, locked)
