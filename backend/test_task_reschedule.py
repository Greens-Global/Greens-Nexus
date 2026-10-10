"""
Dependency-aware rescheduling (task_schedule.py, Oct 2026): moving a blocker
later pushes what waits on it just far enough, down the chain, keeping each
task's duration; moving it earlier pulls nothing; a dependent the actor may
not edit is reported, not moved.

Uses a throwaway sqlite file. No network - the mail send is stubbed.

Run with: python -m unittest test_task_reschedule -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
from task_schedule import required_shift  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from routers.tasks import reschedule_task, RescheduleBody  # noqa: E402

MANAGER = {"email": "boss@greensglobal.com", "level": 3}
PLANNER = {"email": "planner@greensglobal.com", "level": 1}


def _task(**kw):
    base = dict(id=gen_id(), code="T", title=kw.pop("title", "t"), status="not_started", completed=False,
                assignee_email="", assignee_emails=[], follower_emails=[], blocked_by_ids=[], blocking_ids=[],
                dependency_types={}, comment_ids=[], activity_ids=[], due_history=[],
                created_at=now_iso(), modified_at=now_iso(), created_by=MANAGER["email"])
    base.update(kw)
    return models.Task(**base)


class RequiredShiftTests(unittest.TestCase):
    """Pure function."""

    def test_each_type(self):
        b = _task(start_on="2026-10-05", due_on="2026-10-10")
        self.assertEqual(required_shift(b, _task(start_on="2026-10-08", due_on="2026-10-12"), "FS"), 2)
        self.assertEqual(required_shift(b, _task(start_on="2026-10-10", due_on="2026-10-12"), "FS"), 0, "starting the day the blocker is due is allowed")
        self.assertEqual(required_shift(b, _task(start_on="2026-10-03", due_on="2026-10-12"), "SS"), 2)
        self.assertEqual(required_shift(b, _task(start_on="2026-10-01", due_on="2026-10-08"), "FF"), 2)
        self.assertEqual(required_shift(b, _task(start_on="2026-10-01", due_on="2026-10-03"), "SF"), 2)

    def test_no_dates_means_no_shift(self):
        b = _task(start_on="2026-10-05", due_on="2026-10-10")
        self.assertEqual(required_shift(b, _task(), "FS"), 0)
        self.assertEqual(required_shift(_task(), _task(due_on="2026-10-01"), "FS"), 0)

    def test_a_due_only_dependent_uses_its_due_as_start(self):
        b = _task(start_on="2026-10-05", due_on="2026-10-10")
        self.assertEqual(required_shift(b, _task(due_on="2026-10-07"), "FS"), 3)


class RescheduleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls._real_notify = task_notify.notify_task_event
        task_notify.notify_task_event = lambda *a, **kw: None

    @classmethod
    def tearDownClass(cls):
        task_notify.notify_task_event = cls._real_notify
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskProject, models.TaskNotification):
            self.db.query(m).delete()
        self.db.commit()
        self.bg = BackgroundTasks()

    def tearDown(self):
        self.db.close()

    def _chain(self, *specs):
        """specs: (title, start, due, dep_type_from_previous or None). Links each to the one before."""
        rows = []
        for title, start, due, dep in specs:
            t = _task(title=title, start_on=start, due_on=due)
            if rows:
                prev = rows[-1]
                t.blocked_by_ids = [prev.id]
                t.dependency_types = {prev.id: dep or "FS"}
                prev.blocking_ids = list(prev.blocking_ids or []) + [t.id]
            self.db.add(t)
            rows.append(t)
        self.db.commit()
        return rows

    def _fresh(self, t):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == t.id).first()

    def test_moving_a_blocker_later_pushes_the_chain_keeping_durations(self):
        a, b, c = self._chain(("A", "2026-10-01", "2026-10-03", None),
                              ("B", "2026-10-03", "2026-10-06", "FS"),     # 4-day bar starting the day A is due
                              ("C", "2026-10-08", "2026-10-09", "FS"))     # 2 days of slack after B
        out = reschedule_task(a.id, RescheduleBody(start_on="2026-10-03", due_on="2026-10-05"), self.bg, user=MANAGER, db=self.db)
        self.assertEqual(out["task"]["dueOn"], "2026-10-05")
        self.assertEqual([m["title"] for m in out["moved"]], ["B"], "C had slack: B's new due 10/08 still lets C start 10/08")
        b2, c2 = self._fresh(b), self._fresh(c)
        self.assertEqual((b2.start_on, b2.due_on), ("2026-10-05", "2026-10-08"))
        self.assertEqual((c2.start_on, c2.due_on), ("2026-10-08", "2026-10-09"))
        self.assertEqual(b2.due_history[-1]["source"], "cascade")
        self.assertIn("Moved with", b2.due_history[-1]["note"])

    def test_the_push_carries_on_down_the_chain(self):
        a, b, c = self._chain(("A", "2026-10-01", "2026-10-03", None),
                              ("B", "2026-10-03", "2026-10-04", "FS"),
                              ("C", "2026-10-04", "2026-10-05", "FS"))
        out = reschedule_task(a.id, RescheduleBody(due_on="2026-10-10"), self.bg, user=MANAGER, db=self.db)
        self.assertEqual(sorted(m["title"] for m in out["moved"]), ["B", "C"])
        self.assertEqual((self._fresh(b).start_on, self._fresh(b).due_on), ("2026-10-10", "2026-10-11"))
        self.assertEqual((self._fresh(c).start_on, self._fresh(c).due_on), ("2026-10-11", "2026-10-12"))

    def test_moving_earlier_pulls_nothing(self):
        a, b = self._chain(("A", "2026-10-05", "2026-10-10", None), ("B", "2026-10-12", "2026-10-14", "FS"))
        out = reschedule_task(a.id, RescheduleBody(start_on="2026-10-01", due_on="2026-10-03"), self.bg, user=MANAGER, db=self.db)
        self.assertEqual(out["moved"], [])
        self.assertEqual((self._fresh(b).start_on, self._fresh(b).due_on), ("2026-10-12", "2026-10-14"))

    def test_start_to_start_and_finish_to_finish(self):
        a, b = self._chain(("A", "2026-10-01", "2026-10-05", None), ("B", "2026-10-01", "2026-10-20", "SS"))
        reschedule_task(a.id, RescheduleBody(start_on="2026-10-04", due_on="2026-10-08"), self.bg, user=MANAGER, db=self.db)
        self.assertEqual((self._fresh(b).start_on, self._fresh(b).due_on), ("2026-10-04", "2026-10-23"))
        c, d = self._chain(("C", "2026-10-01", "2026-10-05", None), ("D", "2026-09-20", "2026-10-05", "FF"))
        reschedule_task(c.id, RescheduleBody(due_on="2026-10-09"), self.bg, user=MANAGER, db=self.db)
        self.assertEqual((self._fresh(d).start_on, self._fresh(d).due_on), ("2026-09-24", "2026-10-09"))

    def test_a_completed_or_undated_dependent_is_left_alone(self):
        a, b = self._chain(("A", "2026-10-01", "2026-10-03", None), ("B", "2026-10-03", "2026-10-04", "FS"))
        b.completed = True
        c = _task(title="C", blocked_by_ids=[a.id], dependency_types={a.id: "FS"})
        a.blocking_ids = list(a.blocking_ids) + [c.id]
        self.db.add(c)
        self.db.commit()
        out = reschedule_task(a.id, RescheduleBody(due_on="2026-10-10"), self.bg, user=MANAGER, db=self.db)
        self.assertEqual(out["moved"], [])

    def test_cascade_off_moves_only_the_task(self):
        a, b = self._chain(("A", "2026-10-01", "2026-10-03", None), ("B", "2026-10-03", "2026-10-04", "FS"))
        out = reschedule_task(a.id, RescheduleBody(due_on="2026-10-10", cascade=False), self.bg, user=MANAGER, db=self.db)
        self.assertEqual(out["moved"], [])
        self.assertEqual(self._fresh(b).start_on, "2026-10-03")

    def test_a_dependent_the_actor_cannot_edit_is_reported_not_moved(self):
        locked = models.TaskProject(id=gen_id(), name="Locked", access_level="restricted", owner_email=MANAGER["email"],
                                    member_emails=[], member_roles={}, created_at=now_iso(), modified_at=now_iso())
        self.db.add(locked)
        a, b = self._chain(("A", "2026-10-01", "2026-10-03", None), ("B", "2026-10-03", "2026-10-04", "FS"))
        a.assignee_emails, a.assignee_email = [PLANNER["email"]], PLANNER["email"]   # the planner may edit their own task
        b.project_id, b.access_level = locked.id, "restricted"
        self.db.commit()
        out = reschedule_task(a.id, RescheduleBody(due_on="2026-10-10"), self.bg, user=PLANNER, db=self.db)
        self.assertEqual(out["moved"], [])
        self.assertEqual([s["title"] for s in out["skipped"]], ["B"])
        self.assertEqual(self._fresh(b).start_on, "2026-10-03")

    def test_nothing_to_move_is_refused(self):
        (a,) = self._chain(("A", "2026-10-01", "2026-10-03", None))
        with self.assertRaises(HTTPException):
            reschedule_task(a.id, RescheduleBody(), self.bg, user=MANAGER, db=self.db)


if __name__ == "__main__":
    unittest.main()
