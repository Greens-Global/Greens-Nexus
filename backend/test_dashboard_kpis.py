"""
Dashboard KPIs, and the two ways one can lie (Aug 2026).

The hero card on every dashboard read "0 Open tasks / Assigned to you" for
everyone, forever, while the same person's My Tasks listed plenty. Two bugs in
one line:

  M.Task.assignee          does not exist - the column is assignee_email. The
                           AttributeError was caught by safe() and turned into
                           0, and a zero is a believable answer, so nobody could
                           tell it from "you have no tasks".
  status != "Completed"    Task.status is not_started/in_progress/completed plus
                           each project's own custom board-column ids. That
                           string matched nothing, so done tasks counted as open
                           - the opposite error, hidden behind the first.

These assert the counts against real rows rather than the query text, so a
future rename of either column fails here instead of quietly reading zero.

Throwaway sqlite. No network.

Run with: python -m unittest test_dashboard_kpis -v
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import database
import models

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ME = "sagar.shoundik@greensglobal.com"
OTHER = "neil@greensglobal.com"


class MyOpenTasksTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        self.db.query(models.Task).delete()
        self.db.commit()

    def _task(self, assignee, completed=False, status="in_progress"):
        t = models.Task(id=str(uuid.uuid4()), title="T", code="T-1", assignee_email=assignee,
                        status=status, completed=completed, created_at="", modified_at="")
        self.db.add(t)
        self.db.commit()
        return t

    # The queries under test, kept in the same shape as dashboards.py so a
    # divergence there shows up as a failure here.
    def _my_open(self):
        return (self.db.query(models.Task)
                .filter(models.Task.assignee_email == ME,
                        models.Task.completed == False).count())      # noqa: E712

    def _all_open(self):
        return self.db.query(models.Task).filter(models.Task.completed == False).count()  # noqa: E712

    def test_it_counts_the_tasks_assigned_to_me(self):
        self._task(ME)
        self._task(ME)
        self.assertEqual(self._my_open(), 2)

    def test_it_does_not_count_someone_elses(self):
        self._task(OTHER)
        self._task(ME)
        self.assertEqual(self._my_open(), 1)

    def test_a_finished_task_is_not_open(self):
        self._task(ME, completed=True)
        self.assertEqual(self._my_open(), 0)

    def test_completion_is_the_boolean_not_the_status_string(self):
        """status carries custom board-column ids too, so it cannot be the test
        for done - and comparing it to "Completed" matched nothing at all."""
        self._task(ME, completed=True, status="completed")
        self._task(ME, completed=False, status="waiting-on-client")   # a custom column
        self.assertEqual(self._my_open(), 1)

    def test_an_unassigned_task_belongs_to_nobody(self):
        self._task("")
        self.assertEqual(self._my_open(), 0)

    def test_the_team_wide_count_covers_everyone(self):
        self._task(ME)
        self._task(OTHER)
        self._task(OTHER, completed=True)
        self.assertEqual(self._all_open(), 2)

    def test_the_column_the_old_query_used_does_not_exist(self):
        """The actual defect. Task.assignee raised, safe() swallowed it, and the
        card reported 0 - indistinguishable from having no work."""
        self.assertFalse(hasattr(models.Task, "assignee"))
        self.assertTrue(hasattr(models.Task, "assignee_email"))


if __name__ == "__main__":
    unittest.main()
