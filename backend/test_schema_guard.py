"""Schema work runs once per deploy, and never gets skipped by mistake.

schema_guard.py lets ONE process per deploy run create_all + the migrations +
the startup seeds while the other gunicorn workers wait and then skip. The rule
these pin: the only way to skip is "lock held AND stored fingerprint equals
ours" - every breakage falls back to running the work, as before the guard.

The Postgres side (advisory lock, nexus_schema_state) is exercised here against
a FAKE connection that records the SQL it is sent - no real Postgres is touched.

    python -m unittest test_schema_guard
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from sqlalchemy import Column, Integer, MetaData, String, Table  # noqa: E402

import schema_guard  # noqa: E402


class _Result:
    def __init__(self, row=None):
        self._row = row

    def first(self):
        return self._row


class _PgError(Exception):
    """Shaped like a SQLAlchemy DBAPIError wrapping a psycopg2 error."""
    def __init__(self, msg, pgcode):
        super().__init__(msg)
        self.orig = mock.Mock(pgcode=pgcode)


class FakeConn:
    """Stands in for the dedicated lock connection."""
    def __init__(self, stored=None, lock_error=None, read_error=None, store_error=None,
                 unlock_error=None):
        self.stored = stored
        self.lock_error, self.read_error = lock_error, read_error
        self.store_error, self.unlock_error = store_error, unlock_error
        self.sql = []
        self.closed = False
        self.locked = False

    def execute(self, stmt, params=None):
        sql = str(stmt)
        self.sql.append(sql)
        if "pg_advisory_lock" in sql:
            if self.lock_error:
                raise self.lock_error
            self.locked = True
        elif "pg_advisory_unlock" in sql:
            if self.unlock_error:
                raise self.unlock_error
            self.locked = False
        elif sql.startswith("SELECT fingerprint"):
            if self.read_error:
                raise self.read_error
            return _Result((self.stored,) if self.stored is not None else None)
        elif sql.startswith("INSERT INTO nexus_schema_state"):
            if self.store_error:
                raise self.store_error
            self.stored = params["fp"]
        return _Result()

    def close(self):
        self.closed = True
        self.locked = False          # a closed session drops its advisory locks

    def ran(self, needle):
        return any(needle in s for s in self.sql)


class GuardCase(unittest.TestCase):
    def setUp(self):
        self.calls = 0
        self.work_result = True
        os.environ.pop("NEXUS_FORCE_MIGRATIONS", None)
        self.addCleanup(os.environ.pop, "NEXUS_FORCE_MIGRATIONS", None)

    def work(self):
        self.calls += 1
        return self.work_result

    def run_guard(self, conn, fingerprint_fn=lambda: "fp-new", open_error=None):
        opener = mock.Mock(side_effect=open_error) if open_error else mock.Mock(return_value=conn)
        with mock.patch.object(schema_guard, "open_lock_connection", opener):
            return schema_guard.run_once_per_deploy(object(), False, fingerprint_fn, self.work)


class RunOncePerDeployTests(GuardCase):
    def test_match_skips_the_work(self):
        conn = FakeConn(stored="fp-new")
        self.assertEqual(self.run_guard(conn), "skipped")
        self.assertEqual(self.calls, 0)
        self.assertTrue(conn.ran("pg_advisory_unlock"))
        self.assertTrue(conn.closed)

    def test_mismatch_runs_and_stores(self):
        conn = FakeConn(stored="fp-old")
        self.assertEqual(self.run_guard(conn), "applied")
        self.assertEqual(self.calls, 1)
        self.assertEqual(conn.stored, "fp-new")
        self.assertTrue(conn.ran("ENABLE ROW LEVEL SECURITY"))
        self.assertTrue(conn.closed)

    def test_first_ever_run_stores(self):
        conn = FakeConn(stored=None)
        self.assertEqual(self.run_guard(conn), "applied")
        self.assertEqual((self.calls, conn.stored), (1, "fp-new"))

    def test_lock_is_taken_before_the_fingerprint_is_read_and_released_after_the_store(self):
        conn = FakeConn(stored="fp-old")
        self.run_guard(conn)
        order = [next(i for i, s in enumerate(conn.sql) if needle in s) for needle in
                 ("pg_advisory_lock", "SELECT fingerprint", "INSERT INTO nexus_schema_state",
                  "pg_advisory_unlock")]
        self.assertEqual(order, sorted(order))

    def test_work_sees_the_lock_held(self):
        conn = FakeConn(stored="fp-old")
        seen = []
        with mock.patch.object(schema_guard, "open_lock_connection", return_value=conn):
            schema_guard.run_once_per_deploy(object(), False, lambda: "fp-new",
                                             lambda: seen.append(conn.locked) or True)
        self.assertEqual(seen, [True])
        self.assertFalse(conn.locked)

    def test_force_env_runs_even_on_a_match(self):
        os.environ["NEXUS_FORCE_MIGRATIONS"] = "1"
        conn = FakeConn(stored="fp-new")
        self.assertEqual(self.run_guard(conn), "applied")
        self.assertEqual(self.calls, 1)
        self.assertFalse(conn.ran("SELECT fingerprint"))

    def test_failed_work_is_not_recorded(self):
        self.work_result = False
        conn = FakeConn(stored="fp-old")
        self.assertEqual(self.run_guard(conn), "applied")
        self.assertEqual(conn.stored, "fp-old")       # next worker start retries

    def test_work_raising_still_releases_the_lock(self):
        conn = FakeConn(stored="fp-old")
        with mock.patch.object(schema_guard, "open_lock_connection", return_value=conn):
            with self.assertRaises(RuntimeError):
                schema_guard.run_once_per_deploy(
                    object(), False, lambda: "fp-new", mock.Mock(side_effect=RuntimeError("boom")))
        self.assertTrue(conn.ran("pg_advisory_unlock"))
        self.assertTrue(conn.closed)


class BookkeepingFailureTests(GuardCase):
    """Whatever breaks in the guard, the migrations still run."""

    def test_fingerprint_raising(self):
        conn = FakeConn(stored="fp-new")
        out = self.run_guard(conn, fingerprint_fn=mock.Mock(side_effect=OSError("no source")))
        self.assertEqual((out, self.calls), ("applied", 1))
        self.assertEqual(conn.sql, [])                 # ran exactly as before: no lock, no state

    def test_lock_connection_unavailable(self):
        out = self.run_guard(None, open_error=RuntimeError("too many clients"))
        self.assertEqual((out, self.calls), ("applied", 1))

    def test_lock_wait_times_out(self):
        conn = FakeConn(stored="fp-new", lock_error=_PgError("canceling statement due to lock timeout", "55P03"))
        out = self.run_guard(conn)
        self.assertEqual((out, self.calls), ("applied", 1))   # NOT skipped, despite the match
        self.assertFalse(conn.ran("SELECT fingerprint"))
        self.assertFalse(conn.ran("pg_advisory_unlock"))      # never held it
        self.assertTrue(conn.closed)

    def test_lock_statement_erroring(self):
        conn = FakeConn(stored="fp-new", lock_error=_PgError("permission denied", "42501"))
        out = self.run_guard(conn)
        self.assertEqual((out, self.calls), ("applied", 1))
        self.assertTrue(conn.closed)

    def test_stored_fingerprint_unreadable(self):
        conn = FakeConn(stored="fp-new", read_error=RuntimeError("relation is broken"))
        out = self.run_guard(conn)
        self.assertEqual((out, self.calls), ("applied", 1))
        self.assertTrue(conn.ran("pg_advisory_unlock"))

    def test_store_failing_is_not_fatal(self):
        conn = FakeConn(stored="fp-old", store_error=RuntimeError("read-only"))
        out = self.run_guard(conn)
        self.assertEqual((out, self.calls), ("applied", 1))
        self.assertTrue(conn.closed)

    def test_unlock_failing_still_closes_the_connection(self):
        conn = FakeConn(stored="fp-old", unlock_error=RuntimeError("connection reset"))
        self.assertEqual(self.run_guard(conn), "applied")
        self.assertTrue(conn.closed)


class LockTests(unittest.TestCase):
    def test_acquire_bounds_the_wait_then_restores_the_timeouts(self):
        conn = FakeConn()
        self.assertTrue(schema_guard.acquire_lock(conn, 60))
        self.assertEqual(conn.sql, [
            "SET lock_timeout = 60000",
            "SET statement_timeout = 65000",      # past the engine's 25 s default
            "SELECT pg_advisory_lock(:k)",
            "SET lock_timeout = 0",
            "SET statement_timeout = 25000",
        ])

    def test_timeout_is_false_other_errors_raise(self):
        for code in ("55P03", "57014"):
            self.assertFalse(schema_guard.acquire_lock(FakeConn(lock_error=_PgError("x", code)), 1))
        with self.assertRaises(_PgError):
            schema_guard.acquire_lock(FakeConn(lock_error=_PgError("permission denied", "42501")), 1)

    def test_release_without_a_connection_is_a_no_op(self):
        schema_guard.release_lock(None, False)

    def test_lock_connection_is_detached_from_the_pool(self):
        """Runs against real SQLite: detach() must leave a usable connection
        that the pool no longer owns."""
        from database import engine
        conn = schema_guard.open_lock_connection(engine)
        try:
            self.assertTrue(conn.connection.is_valid)
            self.assertIsNone(conn.connection._connection_record)
        finally:
            conn.close()

    def test_lock_wait_env(self):
        with mock.patch.dict(os.environ, {"NEXUS_MIGRATION_LOCK_WAIT_SECONDS": "5"}):
            self.assertEqual(schema_guard.lock_wait_seconds(), 5)
        with mock.patch.dict(os.environ, {"NEXUS_MIGRATION_LOCK_WAIT_SECONDS": "9999"}):
            self.assertEqual(schema_guard.lock_wait_seconds(), 110)   # under gunicorn's 120 s
        with mock.patch.dict(os.environ, {"NEXUS_MIGRATION_LOCK_WAIT_SECONDS": "junk"}):
            self.assertEqual(schema_guard.lock_wait_seconds(), 60)


class FingerprintTests(unittest.TestCase):
    SOURCE = 'migrations = [\n    "ALTER TABLE a ADD COLUMN IF NOT EXISTS x VARCHAR",\n]\n'

    def _meta(self, extra_col=False):
        md = MetaData()
        cols = [Column("id", Integer, primary_key=True), Column("x", String)]
        if extra_col:
            cols.append(Column("y", String))
        Table("a", md, *cols)
        return md

    def test_stable(self):
        self.assertEqual(schema_guard.compute_fingerprint(self.SOURCE, self._meta()),
                         schema_guard.compute_fingerprint(self.SOURCE.encode(), self._meta()))

    def test_changes_when_a_migration_statement_is_appended(self):
        appended = self.SOURCE.replace(
            "]\n", '    "ALTER TABLE a ADD COLUMN IF NOT EXISTS y VARCHAR",\n]\n')
        self.assertNotEqual(schema_guard.compute_fingerprint(self.SOURCE, self._meta()),
                            schema_guard.compute_fingerprint(appended, self._meta()))

    def test_changes_when_a_model_column_is_added(self):
        self.assertNotEqual(schema_guard.compute_fingerprint(self.SOURCE, self._meta()),
                            schema_guard.compute_fingerprint(self.SOURCE, self._meta(extra_col=True)))

    def test_changes_with_extra(self):
        self.assertNotEqual(schema_guard.compute_fingerprint(self.SOURCE, self._meta()),
                            schema_guard.compute_fingerprint(self.SOURCE, self._meta(), "tasks"))


class MainWiringTests(unittest.TestCase):
    """main.py's side: the real fingerprint, the fallback, the SQLite path."""

    @classmethod
    def setUpClass(cls):
        import main
        cls.main = main

    def test_real_fingerprint_covers_the_migration_list_and_the_models(self):
        main = self.main
        fp = main._schema_fingerprint()
        self.assertEqual(len(fp), 64)
        self.assertEqual(fp, main._schema_fingerprint())
        with open(main.__file__, "rb") as f:
            source = f.read()
        self.assertIn(b"ALTER TABLE items ADD COLUMN IF NOT EXISTS", source)   # the list is in what is hashed
        self.assertEqual(fp, schema_guard.compute_fingerprint(source, main.models.Base.metadata, ""))
        with mock.patch.dict(os.environ, {"NEXUS_REBUILD_TABLES": "tasks"}):
            self.assertNotEqual(fp, main._schema_fingerprint())

    def test_guard_blowing_up_still_runs_the_schema_work(self):
        main = self.main
        with mock.patch.object(schema_guard, "run_once_per_deploy", side_effect=RuntimeError("guard broke")), \
                mock.patch.object(main, "_schema_work", return_value=True) as work:
            self.assertEqual(main._ensure_schema(), "applied")
        work.assert_called_once()

    def test_guard_blowing_up_after_the_work_does_not_run_it_twice(self):
        main = self.main

        def _guard(engine, is_sqlite, fingerprint_fn, work):
            work()
            raise RuntimeError("store exploded")
        with mock.patch.object(schema_guard, "run_once_per_deploy", side_effect=_guard), \
                mock.patch.object(main, "_schema_work", return_value=True) as work:
            self.assertEqual(main._ensure_schema(), "applied")
        work.assert_called_once()

    def test_sqlite_always_runs_with_no_lock(self):
        main = self.main
        with mock.patch.object(main, "_schema_work", return_value=True) as work, \
                mock.patch.object(schema_guard, "open_lock_connection") as opener:
            self.assertEqual(main._ensure_schema(), "applied")
        work.assert_called_once()
        opener.assert_not_called()

    def test_schema_work_runs_the_seeds_and_reports_gaps(self):
        main = self.main
        with mock.patch.object(main.models.Base.metadata, "create_all"), \
                mock.patch.object(main, "_run_migrations"), \
                mock.patch.object(main, "_startup_seeds") as seeds:
            self.assertTrue(main._schema_work())
            seeds.assert_called_once()
            with mock.patch.object(main, "SCHEMA_GAPS", ["tasks.x"]):
                self.assertFalse(main._schema_work())       # a missing column: do not record
        with mock.patch.object(main.models.Base.metadata, "create_all"), \
                mock.patch.object(main, "_run_migrations", side_effect=RuntimeError("db down")), \
                mock.patch.object(main, "_startup_seeds"):
            self.assertFalse(main._schema_work())

    def test_postgres_skip_does_not_touch_the_schema(self):
        """A worker that finds the fingerprint already stored runs no DDL."""
        main = self.main
        conn = FakeConn(stored=main._schema_fingerprint())
        with mock.patch.object(main, "DATABASE_URL", "postgresql://x"), \
                mock.patch.object(schema_guard, "open_lock_connection", return_value=conn), \
                mock.patch.object(main, "_schema_work") as work, \
                mock.patch.object(main, "_measure_slot_pressure") as pressure:
            self.assertEqual(main._ensure_schema(), "skipped")
        work.assert_not_called()
        pressure.assert_called_once()                       # /health/schema still gets its readout


class LeaderReleaseTests(unittest.TestCase):
    def setUp(self):
        import leader
        self.leader = leader
        self._prev = (leader._is_leader, leader._released, leader._IS_SQLITE)
        self.addCleanup(self._restore)

    def _restore(self):
        self.leader._is_leader, self.leader._released, self.leader._IS_SQLITE = self._prev

    def _fake_engine(self, rowcount):
        conn = mock.MagicMock()
        conn.execute.return_value = mock.Mock(rowcount=rowcount)
        engine = mock.MagicMock()
        engine.begin.return_value.__enter__.return_value = conn
        return engine, conn

    def test_sqlite_has_nothing_to_release(self):
        self.assertTrue(self.leader._IS_SQLITE)
        self.assertFalse(self.leader.release_lease())

    def test_release_only_touches_our_own_lease(self):
        leader = self.leader
        leader._IS_SQLITE = False
        engine, conn = self._fake_engine(rowcount=1)
        with mock.patch.object(leader, "engine", engine):
            self.assertTrue(leader.release_lease())
        stmt, params = conn.execute.call_args[0]
        self.assertIn("holder = :me", str(stmt))
        self.assertEqual(params["me"], leader._INSTANCE)
        self.assertGreater(params["stale"], leader._LEASE_STALE_SECONDS)   # stale to every claimant
        self.assertFalse(leader.is_background_leader())

    def test_not_the_leader_releases_nothing(self):
        leader = self.leader
        leader._IS_SQLITE = False
        engine, _ = self._fake_engine(rowcount=0)
        with mock.patch.object(leader, "engine", engine):
            self.assertFalse(leader.release_lease())

    def test_no_reclaim_after_release(self):
        leader = self.leader
        leader._IS_SQLITE = False
        engine, conn = self._fake_engine(rowcount=1)
        with mock.patch.object(leader, "engine", engine):
            leader.release_lease()
            conn.execute.reset_mock()
            self.assertFalse(leader._claim_lease())
        conn.execute.assert_not_called()

    def test_lifespan_shutdown_releases_and_survives_a_failure(self):
        import main
        from fastapi.testclient import TestClient
        with mock.patch.object(self.leader, "release_lease", side_effect=RuntimeError("db gone")) as rel:
            with TestClient(main.app) as client:
                self.assertEqual(client.get("/health").status_code, 200)
        rel.assert_called_once()


if __name__ == "__main__":
    unittest.main()
