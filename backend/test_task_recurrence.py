"""
Recurrence generation tests (Aug 28): Weekly gained multi-day selection, and
two freq kinds were added - Periodic ("N days after completion", not a
calendar date) and Custom ("every N day/week/month/year", reusing the
weekly multi-day path when its unit is 'week'). Daily/Weekly/Monthly/Yearly's
existing single-day behavior is covered here too, as a regression guard.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_recurrence -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks

import database
import models
from routers.task_util import gen_id, now_iso
from routers.tasks import _next_due, update_task, TaskUpdate

USER = {"email": "sagar@greensglobal.com", "level": 3}


class NextDueTests(unittest.TestCase):
    """Pure function - no DB needed."""

    def test_daily(self):
        self.assertEqual(_next_due("2026-08-27", {"freq": "daily"}), "2026-08-28")

    def test_weekly_single_legacy_day(self):
        # 2026-08-27 is a Thursday (weekday 3); dayOfWeek 5 = Friday (frontend Sun=0).
        self.assertEqual(_next_due("2026-08-27", {"freq": "weekly", "dayOfWeek": 5}), "2026-08-28")

    def test_weekly_multi_day_picks_the_nearest(self):
        # Mon(1) and Fri(5) selected; nearest after Thursday 08/27 is Friday 08/28.
        r = {"freq": "weekly", "daysOfWeek": [1, 5]}
        self.assertEqual(_next_due("2026-08-27", r), "2026-08-28")

    def test_weekly_multi_day_wraps_to_next_week(self):
        # Only Monday(1) selected; nearest Monday after Thursday 08/27 is 08/31.
        r = {"freq": "weekly", "daysOfWeek": [1]}
        self.assertEqual(_next_due("2026-08-27", r), "2026-08-31")

    def test_weekly_no_days_falls_back_to_plain_interval(self):
        self.assertEqual(_next_due("2026-08-27", {"freq": "weekly"}), "2026-09-03")

    def test_monthly_day_of_month(self):
        self.assertEqual(_next_due("2026-08-27", {"freq": "monthly", "dayOfMonth": 5}), "2026-09-05")

    def test_yearly(self):
        self.assertEqual(_next_due("2026-08-27", {"freq": "yearly"}), "2027-08-27")

    def test_custom_every_2_days(self):
        r = {"freq": "custom", "unit": "day", "interval": 2}
        self.assertEqual(_next_due("2026-08-27", r), "2026-08-29")

    def test_custom_every_2_weeks_on_selected_days(self):
        # Mon+Wed every 2 weeks from Thursday 08/27: nearest is Mon 08/31,
        # then +1 extra week (interval-1) = 09/07.
        r = {"freq": "custom", "unit": "week", "interval": 2, "daysOfWeek": [1, 3]}
        self.assertEqual(_next_due("2026-08-27", r), "2026-09-07")

    def test_custom_every_3_months(self):
        r = {"freq": "custom", "unit": "month", "interval": 3, "dayOfMonth": 1}
        self.assertEqual(_next_due("2026-08-27", r), "2026-11-01")

    def test_custom_every_2_years(self):
        r = {"freq": "custom", "unit": "year", "interval": 2}
        self.assertEqual(_next_due("2026-08-27", r), "2028-08-27")


class PeriodicSpawnTests(unittest.TestCase):
    """Periodic is completion-relative, so it goes through _spawn_next_occurrence
    (which picks completed_at as the base) rather than _next_due."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _task(self, **kw):
        now = now_iso()
        t = models.Task(id=gen_id(), title="Water the plants", status="not_started",
                        assignee_email=USER["email"], assignee_emails=[USER["email"]],
                        created_at=now, modified_at=now, created_by=USER["email"], **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def test_next_due_ignores_a_stale_due_date_and_uses_completion_day(self):
        # Due a week ago; periodic recurrence must anchor to TODAY (when it was
        # actually finished), not that stale due date - otherwise finishing it
        # late would make every future occurrence land in the past too.
        t = self._task(due_on="2020-01-01", recurrence={"freq": "periodic", "daysAfterCompletion": 3})
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), user=USER, db=self.db)
        self.db.refresh(t)
        spawned = (self.db.query(models.Task)
                     .filter(models.Task.title == t.title, models.Task.id != t.id).first())
        self.assertIsNotNone(spawned)
        from datetime import datetime, timedelta, timezone
        # now_iso() (what completed_at was stamped with) is UTC - date.today()
        # is local and can disagree with it near midnight in either direction.
        expected = (datetime.now(timezone.utc).date() + timedelta(days=3)).isoformat()
        self.assertEqual(spawned.due_on, expected)

    def test_the_spawned_task_carries_the_same_periodic_rule_forward(self):
        t = self._task(recurrence={"freq": "periodic", "daysAfterCompletion": 5})
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), user=USER, db=self.db)
        spawned = (self.db.query(models.Task)
                     .filter(models.Task.title == t.title, models.Task.id != t.id).first())
        self.assertEqual(spawned.recurrence, {"freq": "periodic", "daysAfterCompletion": 5})

    def test_count_still_ends_a_periodic_series(self):
        t = self._task(recurrence={"freq": "periodic", "daysAfterCompletion": 1, "count": 1})
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), user=USER, db=self.db)
        spawned = (self.db.query(models.Task)
                     .filter(models.Task.title == t.title, models.Task.id != t.id).first())
        self.assertIsNone(spawned)   # count=1 was the last occurrence


if __name__ == "__main__":
    unittest.main(verbosity=2)
