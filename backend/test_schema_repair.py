"""A model column missing from the database must be repaired, not served as 500s.

This reproduces the shape of the outage that took the Task module down for days
(Aug 2026) and pins the recovery:

    * `tasks` was missing three columns the model declares.
    * SQLAlchemy therefore emitted `SELECT tasks.assignee_emails ...`, the
      database refused, and EVERY read and write on tasks failed with a 500 -
      while /health and /health/ready both stayed green, because the app was
      alive and the database was reachable. One table simply could not be read.
    * The migration that would have added the column had failed and been
      swallowed, by design, so nothing said so out loud.

_verify_model_columns closes that: it compares the models against the live
schema after every migration pass, adds whatever is missing, and records what
it could not add for /health/schema to report.

    python -m unittest test_schema_repair
"""
import importlib
import os
import pathlib
import sqlite3
import tempfile
import unittest


def _fresh_app(db_path):
    """Boot the app against `db_path`, running startup migrations + repair."""
    os.environ["DATABASE_URL"] = f"sqlite:///{db_path.as_posix()}"
    os.environ["NEXUS_SKIP_AUTH"] = "true"
    import database
    importlib.reload(database)          # new engine bound to db_path
    # models is deliberately NOT reloaded: re-executing it would re-declare
    # every Table on the same MetaData and raise "already defined". The model
    # definitions do not depend on the connection, only the engine does.
    import main
    importlib.reload(main)              # picks up the reloaded engine
    return main


class SchemaRepairTests(unittest.TestCase):
    def setUp(self):
        self.db = pathlib.Path(tempfile.mkdtemp()) / "repair.db"
        self._prev = {k: os.environ.get(k) for k in ("DATABASE_URL", "NEXUS_SKIP_AUTH")}

    def tearDown(self):
        for k, v in self._prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _columns(self):
        raw = sqlite3.connect(self.db)
        try:
            return [r[1] for r in raw.execute("PRAGMA table_info(tasks)")]
        finally:
            raw.close()

    def test_a_dropped_column_is_put_back_on_the_next_boot(self):
        from fastapi.testclient import TestClient

        main = _fresh_app(self.db)
        with TestClient(main.app):
            pass
        self.assertIn("assignee_emails", self._columns(), "baseline should be whole")
        self.assertEqual(main.SCHEMA_GAPS, [], "a healthy schema reports no gaps")

        # Exactly the state dev was in: the column the model declares is absent.
        raw = sqlite3.connect(self.db)
        raw.execute("ALTER TABLE tasks DROP COLUMN assignee_emails")
        raw.commit()
        raw.close()
        self.assertNotIn("assignee_emails", self._columns())

        # Queries really do fail in that state - this is the 500 users saw.
        import models
        from database import SessionLocal
        s = SessionLocal()
        try:
            with self.assertRaises(Exception):
                s.query(models.Task).all()
        finally:
            s.close()

        # Restart: the repair pass puts it back and the API works again.
        main = _fresh_app(self.db)
        with TestClient(main.app) as c:
            self.assertIn("assignee_emails", self._columns(),
                          "the repair pass must re-add a missing model column")
            self.assertEqual(main.SCHEMA_GAPS, [])
            self.assertEqual(c.get("/health/schema").json()["ok"], True)

    def test_health_schema_reports_a_whole_schema_as_ok(self):
        from fastapi.testclient import TestClient

        main = _fresh_app(self.db)
        with TestClient(main.app) as c:
            body = c.get("/health/schema").json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["missingColumns"], [])
        # slotPressure is Postgres-only; on SQLite it is correctly empty rather
        # than an error, since there is no 1600-attribute limit to report on.
        self.assertEqual(body["slotPressure"], {})


if __name__ == "__main__":
    unittest.main()
