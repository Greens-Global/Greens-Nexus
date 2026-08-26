"""A column must never be both ADDed and DROPped in the same migration list.

Both lists in main.py run on EVERY boot. If one adds a column and another line
in the same list drops it, then every single restart creates a fresh attnum and
immediately abandons it. Postgres never reclaims a dropped column's attnum - no
VACUUM does, not even VACUUM FULL - so the table creeps toward the hard limit of
1600 attributes and then refuses EVERY new column, forever.

That is not hypothetical. It happened twice:

  * task_projects.department_ids - found and fixed by removing the ADD.
  * tasks.department_id          - the identical pair, missed at the time. It
                                   burned one slot per restart until dev's
                                   `tasks` hit 1600, at which point
                                   tasks.position, tasks.project_ids and
                                   tasks.assignee_emails could not be added.
                                   Every query on tasks then 500'd while
                                   /health and /health/ready stayed green.

The comment left behind after the first fix was not enough to stop the second,
so this is a test rather than a note.

    python -m unittest test_migration_hygiene
"""
import pathlib
import re
import unittest

MAIN = pathlib.Path(__file__).with_name("main.py").read_text(encoding="utf-8")

# The two lists are built in the same function: the sqlite one first, then the
# Postgres one. Splitting on the Postgres list's opening keeps each self
# contained without having to execute main.py.
_SPLIT = MAIN.index("    migrations = [")
SQLITE_LIST = MAIN[:_SPLIT]
POSTGRES_LIST = MAIN[_SPLIT:]

ADD_RE = re.compile(r'ALTER TABLE (\w+) ADD COLUMN (?:IF NOT EXISTS )?"?(\w+)"?')
DROP_RE = re.compile(r'ALTER TABLE (\w+) DROP COLUMN (?:IF EXISTS )?"?(\w+)"?')


def _pairs(source):
    """{(table, column)} added and dropped, ignoring commented-out lines - a
    line explaining why an ADD was REMOVED must not read as an ADD."""
    live = "\n".join(ln for ln in source.splitlines() if not ln.strip().startswith("#"))
    return set(ADD_RE.findall(live)), set(DROP_RE.findall(live))


class TestNoAddDropChurn(unittest.TestCase):
    def _check(self, name, source):
        adds, drops = _pairs(source)
        both = sorted(adds & drops)
        self.assertEqual(
            both, [],
            f"\n\n{name}: these columns are ADDed and DROPped in the same list, which "
            f"runs on every boot:\n"
            + "\n".join(f"  - {t}.{c}" for t, c in both)
            + "\n\nEach restart burns one attribute slot that Postgres never gives back. "
              "Keep the DROP (databases that still have the column need it gone) and "
              "delete the ADD, leaving a comment saying why - see tasks.department_id.\n",
        )

    def test_sqlite_list_has_no_add_drop_pair(self):
        self._check("sqlite_migrations", SQLITE_LIST)

    def test_postgres_list_has_no_add_drop_pair(self):
        self._check("migrations (postgres)", POSTGRES_LIST)


class TestTheTwoKnownOffenders(unittest.TestCase):
    """Named explicitly so a re-introduction fails with the history attached
    rather than as an anonymous pair."""

    def test_tasks_department_id_is_not_added(self):
        adds, _ = _pairs(MAIN)
        self.assertNotIn(
            ("tasks", "department_id"), adds,
            "tasks.department_id must never be ADDed again - this pair took dev's "
            "tasks table to the 1600-column limit and broke every tasks query.",
        )

    def test_task_projects_department_ids_is_not_added(self):
        adds, _ = _pairs(MAIN)
        self.assertNotIn(
            ("task_projects", "department_ids"), adds,
            "task_projects.department_ids must never be ADDed again - the first "
            "table this bug took out.",
        )


if __name__ == "__main__":
    unittest.main()
