"""A boot's migration pass must not take table locks it does not need
(Nov 4 2026).

`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` takes an exclusive lock on its
table before deciding it is a no-op, and every read of the table queues
behind it while it waits. A staging boot waited behind prod's long time sheet
reads and froze every time_punches read on prod (punch in, Add Break). So a
statement whose work is already in the live schema is not sent, and anything
that does run carries a short lock_timeout.

Run alone: python -m pytest test_migration_boot_locks.py
"""
import ast
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "main.py"), encoding="utf-8").read()


def _load_helpers():
    """Pull the two regexes and the decision function out of main.py without
    importing it (importing main builds the whole app)."""
    tree = ast.parse(SRC)
    keep = [n for n in tree.body
            if (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in
                ("_ADD_COLUMN_RE", "_ENABLE_RLS_RE", "MIGRATION_LOCK_TIMEOUT") for t in n.targets))
            or (isinstance(n, ast.FunctionDef) and n.name == "_migration_already_applied")]
    ns = {"re": re}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "main.py", "exec"), ns)
    return ns


def _pg_migrations():
    tree = ast.parse(SRC)
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_run_migrations")
    lst = next(n for n in ast.walk(fn) if isinstance(n, ast.Assign)
               and any(getattr(t, "id", "") == "migrations" for t in n.targets))
    return [ast.literal_eval(e) for e in lst.value.elts if isinstance(e, ast.Constant)]


H = _load_helpers()
applied = H["_migration_already_applied"]


class AlreadyAppliedTests(unittest.TestCase):
    def test_existing_column_is_not_sent(self):
        sql = "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edit_reason VARCHAR DEFAULT ''"
        self.assertTrue(applied(sql, {("time_punches", "edit_reason")}, set()))

    def test_missing_column_is_sent(self):
        sql = "ALTER TABLE time_punches ADD COLUMN IF NOT EXISTS edit_reason VARCHAR DEFAULT ''"
        self.assertFalse(applied(sql, {("time_punches", "other")}, set()))
        self.assertFalse(applied(sql, {("other_table", "edit_reason")}, set()))

    def test_rls_already_on_is_not_sent(self):
        sql = "ALTER TABLE construction_photo_pairs ENABLE ROW LEVEL SECURITY"
        self.assertTrue(applied(sql, set(), {"construction_photo_pairs"}))
        self.assertFalse(applied(sql, set(), set()))

    def test_everything_else_always_runs(self):
        for sql in ("UPDATE items SET status = 'available' WHERE status = 'x'",
                    "CREATE INDEX IF NOT EXISTS ix_a ON a (b)",
                    "ALTER TABLE items ALTER COLUMN name DROP NOT NULL",
                    "ALTER TABLE items ADD COLUMN plain_add VARCHAR"):
            self.assertFalse(applied(sql, {("items", "name"), ("items", "plain_add")}, {"items"}), sql)

    def test_an_unread_schema_sends_everything(self):
        # _live_schema returns empty sets when the catalog cannot be read.
        for sql in _pg_migrations():
            self.assertFalse(applied(sql, set(), set()))


class RealListTests(unittest.TestCase):
    def test_nearly_every_statement_is_recognized(self):
        stmts = _pg_migrations()
        known = [s for s in stmts if H["_ADD_COLUMN_RE"].match(s) or H["_ENABLE_RLS_RE"].match(s)]
        self.assertGreater(len(stmts), 1000)
        self.assertGreater(len(known) / len(stmts), 0.8)

    def test_every_sent_statement_carries_a_lock_timeout(self):
        loop = SRC[SRC.index("have_cols, rls_on = _live_schema(conn)"):]
        loop = loop[:loop.index("_measure_slot_pressure(conn)")]
        self.assertLess(loop.index("SET LOCAL lock_timeout"), loop.index("conn.execute(text(sql))"))
        self.assertRegex(H["MIGRATION_LOCK_TIMEOUT"], r"^\d+s$")


if __name__ == "__main__":
    unittest.main()
