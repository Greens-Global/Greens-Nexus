"""The slot-exhaustion rebuild must stay asleep unless it is explicitly asked.

_rebuild_slot_exhausted_tables rewrites a table that has hit Postgres's 1600
attribute-slot limit. That is data-bearing, so the guards matter more than the
happy path: a rebuild that fires when nobody asked, or on a healthy table, or
on a name that came from somewhere untrusted, would be far worse than the
outage it exists to cure.

The rewrite itself is Postgres-only SQL and is not exercised here - there is no
Postgres in this test environment. What IS pinned is that nothing happens
without NEXUS_REBUILD_TABLES, that a healthy table is left alone, that a
suspicious name is refused, and that the whole thing is a no-op on SQLite.

    python -m unittest test_rebuild_guard
"""
import os
import unittest
from unittest import mock

import main


class _Conn:
    """Records what would be executed, and answers the slot-count probe."""

    def __init__(self, live=41, slots=41, fail_probe=False):
        self.live, self.slots, self.fail_probe = live, slots, fail_probe
        self.statements = []
        self.rolled_back = 0
        self.commits = 0

    def execute(self, stmt, params=None):
        sql = str(stmt)
        self.statements.append(sql)
        if "pg_attribute" in sql:
            if self.fail_probe:
                raise RuntimeError("relation does not exist")
            return mock.Mock(fetchone=lambda: (self.live, self.slots))
        return mock.Mock(scalar=lambda: 0, fetchone=lambda: (0, 0))

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rolled_back += 1

    def ddl(self):
        return [s for s in self.statements if "pg_attribute" not in s]


class TestRebuildGuards(unittest.TestCase):
    def _run(self, env, database_url="postgresql://x/y", **conn_kw):
        conn = _Conn(**conn_kw)
        with mock.patch.dict(os.environ, env, clear=False), \
             mock.patch.object(main, "DATABASE_URL", database_url):
            main._rebuild_slot_exhausted_tables(conn)
        return conn

    def test_does_nothing_without_the_env_var(self):
        conn = self._run({"NEXUS_REBUILD_TABLES": ""}, slots=1599)
        self.assertEqual(conn.statements, [], "must not even probe unless asked")

    def test_does_nothing_on_sqlite(self):
        conn = self._run({"NEXUS_REBUILD_TABLES": "tasks"},
                         database_url="sqlite:///./x.db", slots=1599)
        self.assertEqual(conn.statements, [])

    def test_leaves_a_healthy_table_alone(self):
        # A normal table here has well under 60 slots. Only a table that has
        # actually burned through them is a rebuild candidate.
        conn = self._run({"NEXUS_REBUILD_TABLES": "tasks"}, live=41, slots=41)
        self.assertEqual(conn.ddl(), [], "a healthy table must not be rewritten")

    def test_refuses_a_suspicious_table_name(self):
        conn = self._run({"NEXUS_REBUILD_TABLES": 'tasks"; DROP TABLE users; --'}, slots=1599)
        self.assertEqual(conn.statements, [], "an unsafe identifier must never reach SQL")

    def test_survives_a_table_that_does_not_exist(self):
        conn = self._run({"NEXUS_REBUILD_TABLES": "nope"}, slots=1599, fail_probe=True)
        self.assertEqual(conn.ddl(), [])
        self.assertGreaterEqual(conn.rolled_back, 1, "a failed probe must roll back")

    def test_rebuild_never_drops_the_original(self):
        # The single most important property: on a slot-exhausted table it
        # renames the original aside and keeps it. A DROP here would make a bad
        # run unrecoverable.
        conn = self._run({"NEXUS_REBUILD_TABLES": "tasks"}, live=38, slots=1599)
        ddl = " ".join(conn.ddl())
        self.assertIn("CREATE TABLE", ddl)
        self.assertIn("INSERT INTO", ddl)
        self.assertIn("RENAME TO", ddl)
        self.assertNotIn("DROP TABLE", ddl, "the original table must never be dropped")
        self.assertNotIn("TRUNCATE", ddl)

    def test_rebuild_verifies_row_counts_before_swapping(self):
        conn = self._run({"NEXUS_REBUILD_TABLES": "tasks"}, live=38, slots=1599)
        joined = " ".join(conn.ddl())
        self.assertIn("count(*)", joined, "row counts must be compared before the swap")


class TestFiresOnAnAlreadyBrokenTable(unittest.TestCase):
    """The automatic path: no env var, no human. It may only fire on a table
    that is BOTH slot-exhausted AND missing model columns - i.e. one that
    already answers nothing, where a rebuild is the only thing that can help."""

    def _run(self, gaps, pressure, env=""):
        conn = _Conn(live=38, slots=1600)
        with mock.patch.dict(os.environ, {"NEXUS_REBUILD_TABLES": env}, clear=False), \
             mock.patch.object(main, "DATABASE_URL", "postgresql://x/y"), \
             mock.patch.object(main, "SCHEMA_GAPS", gaps), \
             mock.patch.object(main, "SLOT_PRESSURE", pressure):
            main._rebuild_slot_exhausted_tables(conn)
        return conn

    FULL = {"tasks": {"live": 38, "used": 1600, "limit": 1600}}

    def test_rebuilds_a_full_table_that_is_missing_columns(self):
        conn = self._run(["tasks.assignee_emails", "tasks.position"], self.FULL)
        ddl = " ".join(conn.ddl())
        self.assertIn("CREATE TABLE", ddl)
        self.assertIn("RENAME TO", ddl)
        self.assertNotIn("DROP TABLE", ddl)

    def test_leaves_a_full_table_alone_while_it_still_works(self):
        # THE safety property. A table can sit at 1600 slots and serve every
        # query perfectly well - it just cannot take a NEW column. Rewriting
        # that is a judgment call somebody should make, not something to do
        # unasked. Only the missing columns make it already-broken.
        conn = self._run([], self.FULL)
        self.assertEqual(conn.ddl(), [],
                         "a full but working table must not be rebuilt automatically")

    def test_leaves_a_broken_table_alone_if_it_is_not_slot_exhausted(self):
        # Missing columns with slots to spare is a different problem - the ADD
        # simply failed for some other reason, and _verify_model_columns will
        # keep retrying it. A rebuild would not be the fix.
        roomy = {"tasks": {"live": 38, "used": 60, "limit": 1600}}
        conn = self._run(["tasks.assignee_emails"], roomy)
        self.assertEqual(conn.ddl(), [])

    def test_a_full_broken_table_is_not_queued_twice_when_also_named(self):
        conn = self._run(["tasks.assignee_emails"], self.FULL, env="tasks")
        self.assertEqual(len([s for s in conn.ddl() if "CREATE TABLE" in s]), 1)

    def test_only_the_broken_table_is_touched(self):
        pressure = {
            "tasks": {"live": 38, "used": 1600, "limit": 1600},
            "task_projects": {"live": 20, "used": 1595, "limit": 1600},   # full, but fine
        }
        conn = self._run(["tasks.assignee_emails"], pressure)
        ddl = " ".join(conn.ddl())
        self.assertIn('"tasks"', ddl)
        self.assertNotIn("task_projects", ddl,
                         "a neighbouring full-but-working table must be left alone")


if __name__ == "__main__":
    unittest.main()
