"""
Notification regression tests (QA audit, Aug 2026).

Two defects, both silent:
  - the overdue re-reminder condition inverted BOTH halves of its own
    docstring: "only once" mailed every day forever, and the default setting
    stayed silent on the day a task actually went overdue.
  - bulk_update wrote no activity and sent no notification at all, so
    reassigning fifty tasks told nobody and left no audit trail.

Uses a throwaway sqlite file. No network - the mail send itself is stubbed,
these cover the scheduling and fan-out decisions around it.

Run with: python -m unittest test_task_notifications -v
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
import task_notify
from routers.task_util import gen_id, now_iso
from routers.tasks import bulk_update, BulkUpdate

ACTOR = {"email": "actor@greensglobal.com", "level": 3}
ASSIGNEE = "assignee@greensglobal.com"


class OverdueScheduleTests(unittest.TestCase):
    """The re-reminder cadence, driven through the real scan so the fix is
    verified where it actually runs rather than in a re-implementation."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskEmailLog, models.NexusSetting, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()
        self.sent = []
        self._real_send = task_notify._send_one
        task_notify._send_one = lambda db, **kw: self.sent.append(kw)

    def tearDown(self):
        task_notify._send_one = self._real_send
        self.db.close()

    def _overdue_task(self, days):
        """A task that went overdue `days` days ago (1 == yesterday)."""
        t = models.Task(id=gen_id(), title="Late", code="TASK-1", assignee_email=ASSIGNEE,
                        due_on=(date.today() - timedelta(days=days)).isoformat(),
                        completed=False, created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    def _set_repeat(self, value):
        task_notify.save_settings(self.db, {"overdueRepeatDays": value}, "test")

    def _run_on_day(self, overdue_days, repeat):
        self.db.query(models.Task).delete()
        self.db.query(models.TaskEmailLog).delete()
        self.db.commit()
        self._overdue_task(overdue_days)
        self._set_repeat(repeat)
        self.sent.clear()
        task_notify._due_reminders_once(self.db)
        return [s for s in self.sent if s.get("event_type") == "overdue"]

    def test_repeat_zero_mails_only_on_the_first_day(self):
        """'0 = only once' used to mail EVERY day forever, because 0 is falsy
        so the skip guard never ran."""
        self.assertEqual(len(self._run_on_day(1, 0)), 1, "day 1 must mail")
        for day in (2, 3, 5, 30):
            with self.subTest(overdue_day=day):
                self.assertEqual(self._run_on_day(day, 0), [], f"day {day} must stay silent")

    def test_the_default_mails_on_the_day_it_goes_overdue(self):
        """With the default 3, day 1 gave 1 % 3 != 0 -> skipped, so the day a
        task actually went overdue was silent."""
        self.assertEqual(len(self._run_on_day(1, 3)), 1)

    def test_the_default_then_repeats_every_three_days_from_the_first(self):
        for day in (4, 7, 10):
            with self.subTest(overdue_day=day):
                self.assertEqual(len(self._run_on_day(day, 3)), 1)
        for day in (2, 3, 5, 6):
            with self.subTest(overdue_day=day):
                self.assertEqual(self._run_on_day(day, 3), [])

    def test_repeat_one_mails_daily(self):
        for day in (1, 2, 3, 4):
            with self.subTest(overdue_day=day):
                self.assertEqual(len(self._run_on_day(day, 1)), 1)

    def test_a_completed_overdue_task_is_never_chased(self):
        self._set_repeat(3)
        t = self._overdue_task(1)
        t.completed = True
        self.db.commit()
        self.sent.clear()
        task_notify._due_reminders_once(self.db)
        self.assertEqual([s for s in self.sent if s.get("event_type") == "overdue"], [])

    def test_a_task_due_today_is_not_overdue(self):
        self._set_repeat(3)
        t = models.Task(id=gen_id(), title="Today", code="TASK-2", assignee_email=ASSIGNEE,
                        due_on=date.today().isoformat(), completed=False,
                        created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        self.sent.clear()
        task_notify._due_reminders_once(self.db)
        self.assertEqual([s for s in self.sent if s.get("event_type") == "overdue"], [])


class BulkNotificationTests(unittest.TestCase):
    """bulk_update used to write no activity and send no notification."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskNotification,
                  models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _tasks(self, n):
        out = []
        for i in range(n):
            t = models.Task(id=gen_id(), title=f"T{i}", code=f"TASK-{i:03d}",
                            status="not_started", created_at=now_iso(), modified_at=now_iso())
            self.db.add(t)
            out.append(t)
        self.db.commit()
        return out

    def _notifications_for(self, email):
        return self.db.query(models.TaskNotification).filter(
            models.TaskNotification.for_email == email).all()

    def test_bulk_reassign_notifies_the_new_assignee(self):
        tasks = self._tasks(3)
        bulk_update(BulkUpdate(ids=[t.id for t in tasks], patch={"assignee_email": ASSIGNEE}),
                    user=ACTOR, db=self.db)
        self.assertEqual(len(self._notifications_for(ASSIGNEE)), 1)

    def test_a_multi_task_reassign_sends_ONE_notification_not_one_each(self):
        """Fifty pings for one action is the failure mode CLAUDE.md warns about."""
        tasks = self._tasks(12)
        bulk_update(BulkUpdate(ids=[t.id for t in tasks], patch={"assignee_email": ASSIGNEE}),
                    user=ACTOR, db=self.db)
        notes = self._notifications_for(ASSIGNEE)
        self.assertEqual(len(notes), 1)
        self.assertIn("12", notes[0].title)

    def test_a_single_task_bulk_reads_like_a_normal_assignment(self):
        t = self._tasks(1)[0]
        bulk_update(BulkUpdate(ids=[t.id], patch={"assignee_email": ASSIGNEE}),
                    user=ACTOR, db=self.db)
        note = self._notifications_for(ASSIGNEE)[0]
        self.assertEqual(note.title, "You were assigned a task")
        self.assertEqual(note.task_id, t.id)

    def test_bulk_writes_an_activity_row_per_task(self):
        tasks = self._tasks(4)
        bulk_update(BulkUpdate(ids=[t.id for t in tasks], patch={"assignee_email": ASSIGNEE}),
                    user=ACTOR, db=self.db)
        acts = self.db.query(models.TaskActivity).filter(
            models.TaskActivity.type == "assignee_changed").all()
        self.assertEqual(len(acts), 4)

    def test_bulk_completion_is_recorded_in_the_activity_log(self):
        tasks = self._tasks(2)
        bulk_update(BulkUpdate(ids=[t.id for t in tasks], patch={"completed": True}),
                    user=ACTOR, db=self.db)
        acts = self.db.query(models.TaskActivity).filter(
            models.TaskActivity.type == "completed").all()
        self.assertEqual(len(acts), 2)

    def test_assigning_to_yourself_does_not_notify_you(self):
        tasks = self._tasks(2)
        bulk_update(BulkUpdate(ids=[t.id for t in tasks], patch={"assignee_email": ACTOR["email"]}),
                    user=ACTOR, db=self.db)
        self.assertEqual(self._notifications_for(ACTOR["email"]), [])

    def test_a_patch_that_changes_nothing_notifies_nobody(self):
        tasks = self._tasks(2)
        for t in tasks:
            t.assignee_email = ASSIGNEE
        self.db.commit()
        bulk_update(BulkUpdate(ids=[t.id for t in tasks], patch={"assignee_email": ASSIGNEE}),
                    user=ACTOR, db=self.db)
        self.assertEqual(self._notifications_for(ASSIGNEE), [])


if __name__ == "__main__":
    unittest.main()
