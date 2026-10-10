"""
Time entries (Oct 2026): a timer per person, typed-in minutes, the rollup
into actual_hours, who may edit what, and the weekly sheet. Separate from
Time Clock punches by design - nothing here touches a timesheet.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_time -v
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
from routers.task_util import gen_id, now_iso, purge_task_permanently  # noqa: E402
from routers.tasks import (  # noqa: E402
    create_task, update_task, delete_task, TaskCreate, TaskUpdate,
    add_time_entry, start_timer, stop_my_timer, my_running_timer, my_time_entries,
    update_time_entry, delete_time_entry, list_time_entries,
    TimeEntryCreate, TimeEntryUpdate, TimerStop,
)

MANAGER = {"email": "boss@greensglobal.com", "level": 3}
SAM = {"email": "sam@greensglobal.com", "level": 1}
PRIYA = {"email": "priya@greensglobal.com", "level": 1}
READER = {"email": "reader@greensglobal.com", "level": 1}


class TimeEntryTests(unittest.TestCase):
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
        for m in (models.Task, models.TaskTimeEntry, models.TaskActivity, models.TaskProject, models.TaskDeleteLog):
            self.db.query(m).delete()
        self.db.commit()
        self.bg = BackgroundTasks()
        self.project = models.TaskProject(
            id=gen_id(), name="P", access_level="restricted", owner_email=MANAGER["email"],
            member_emails=[SAM["email"], PRIYA["email"], READER["email"]],
            member_roles={SAM["email"]: "editor", PRIYA["email"]: "commenter", READER["email"]: "viewer"},
            created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.project)
        self.db.commit()
        self.a = create_task(TaskCreate(title="A", project_id=self.project.id), self.bg, user=MANAGER, db=self.db)
        self.b = create_task(TaskCreate(title="B", project_id=self.project.id), self.bg, user=MANAGER, db=self.db)

    def tearDown(self):
        self.db.close()

    def _task(self, tid):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == tid).first()

    # ── manual entries and the rollup ───────────────────────────────────────
    def test_typed_minutes_roll_up_into_actual_hours(self):
        out = add_time_entry(self.a["id"], TimeEntryCreate(minutes=90, note="calls"), user=SAM, db=self.db)
        self.assertEqual(out["entry"]["source"], "manual")
        self.assertEqual(out["task"]["actualHours"], 1.5)
        self.assertEqual(out["task"]["timeEntryCount"], 1)
        add_time_entry(self.a["id"], TimeEntryCreate(minutes=30), user=PRIYA, db=self.db)   # a commenter may log
        self.assertEqual(self._task(self.a["id"]).actual_hours, 2.0)
        acts = [x.type for x in self.db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == self.a["id"]).all()]
        self.assertEqual(acts.count("time_logged"), 2)

    def test_a_viewer_may_not_log_time_but_may_read_it(self):
        with self.assertRaises(HTTPException):
            add_time_entry(self.a["id"], TimeEntryCreate(minutes=10), user=READER, db=self.db)
        add_time_entry(self.a["id"], TimeEntryCreate(minutes=10), user=SAM, db=self.db)
        self.assertEqual(len(list_time_entries(self.a["id"], user=READER, db=self.db)), 1)

    def test_minutes_are_bounded(self):
        for bad in (0, -5, 24 * 60 + 1):
            with self.assertRaises(HTTPException):
                add_time_entry(self.a["id"], TimeEntryCreate(minutes=bad), user=SAM, db=self.db)

    def test_actual_hours_cannot_be_typed_over_once_entries_exist(self):
        update_task(self.a["id"], TaskUpdate(actual_hours=3), self.bg, user=SAM, db=self.db)   # no entries yet: fine
        add_time_entry(self.a["id"], TimeEntryCreate(minutes=60), user=SAM, db=self.db)
        self.assertEqual(self._task(self.a["id"]).actual_hours, 1.0, "the rollup replaced the typed number")
        with self.assertRaises(HTTPException) as cm:
            update_task(self.a["id"], TaskUpdate(actual_hours=5), self.bg, user=SAM, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)

    # ── the timer ───────────────────────────────────────────────────────────
    def test_start_stop_and_one_timer_per_person(self):
        self.assertIsNone(my_running_timer(user=SAM, db=self.db))
        out = start_timer(self.a["id"], user=SAM, db=self.db)
        self.assertTrue(out["entry"]["running"])
        self.assertIsNone(out["stopped"])
        self.assertEqual(my_running_timer(user=SAM, db=self.db)["task"]["id"], self.a["id"])
        self.assertIsNone(my_running_timer(user=PRIYA, db=self.db), "timers are personal")
        # Starting on another task stops the first one.
        out = start_timer(self.b["id"], user=SAM, db=self.db)
        self.assertEqual(out["stopped"]["task"]["id"], self.a["id"])
        self.assertGreaterEqual(out["stopped"]["entry"]["minutes"], 1, "a short timer rounds up to a minute")
        self.assertEqual(self._task(self.a["id"]).time_entry_count, 1)
        # Starting again on the same task is a no-op.
        again = start_timer(self.b["id"], user=SAM, db=self.db)
        self.assertEqual(again["entry"]["id"], out["entry"]["id"])
        stopped = stop_my_timer(TimerStop(note="done"), user=SAM, db=self.db)
        self.assertEqual(stopped["entry"]["note"], "done")
        self.assertFalse(stopped["entry"]["running"])
        self.assertIsNone(stop_my_timer(TimerStop(), user=SAM, db=self.db))
        self.assertEqual(self._task(self.b["id"]).time_entry_count, 1)

    def test_a_running_entry_is_not_counted_and_cannot_be_edited(self):
        out = start_timer(self.a["id"], user=SAM, db=self.db)
        self.assertEqual(self._task(self.a["id"]).time_entry_count, 0)
        with self.assertRaises(HTTPException) as cm:
            update_time_entry(out["entry"]["id"], TimeEntryUpdate(minutes=5), user=SAM, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)

    # ── editing and deleting ────────────────────────────────────────────────
    def test_only_the_owner_or_a_manager_edits_an_entry(self):
        e = add_time_entry(self.a["id"], TimeEntryCreate(minutes=60), user=SAM, db=self.db)["entry"]
        with self.assertRaises(HTTPException):
            update_time_entry(e["id"], TimeEntryUpdate(minutes=30), user=PRIYA, db=self.db)
        out = update_time_entry(e["id"], TimeEntryUpdate(minutes=30, billable=True), user=MANAGER, db=self.db)
        self.assertEqual(out["entry"]["minutes"], 30)
        self.assertTrue(out["entry"]["billable"])
        self.assertEqual(out["task"]["actualHours"], 0.5)
        with self.assertRaises(HTTPException):
            delete_time_entry(e["id"], user=PRIYA, db=self.db)
        out = delete_time_entry(e["id"], user=SAM, db=self.db)
        self.assertEqual(out["task"]["timeEntryCount"], 0)

    # ── the weekly sheet ────────────────────────────────────────────────────
    def test_my_entries_in_a_window(self):
        today = date.today()
        add_time_entry(self.a["id"], TimeEntryCreate(minutes=60, on=today.isoformat()), user=SAM, db=self.db)
        add_time_entry(self.b["id"], TimeEntryCreate(minutes=45, on=(today - timedelta(days=3)).isoformat()), user=SAM, db=self.db)
        add_time_entry(self.b["id"], TimeEntryCreate(minutes=15, on=(today - timedelta(days=20)).isoformat()), user=SAM, db=self.db)
        add_time_entry(self.b["id"], TimeEntryCreate(minutes=99, on=today.isoformat()), user=PRIYA, db=self.db)
        rows = my_time_entries(from_="", to="", user=SAM, db=self.db)
        self.assertEqual(sorted(r["minutes"] for r in rows), [45, 60], "last 7 days, mine only")
        self.assertTrue(all(r["taskTitle"] for r in rows))
        rows = my_time_entries(from_=(today - timedelta(days=30)).isoformat(), to=today.isoformat(), user=SAM, db=self.db)
        self.assertEqual(len(rows), 3)

    def test_purge_removes_entries(self):
        add_time_entry(self.a["id"], TimeEntryCreate(minutes=5), user=SAM, db=self.db)
        delete_task(self.a["id"], self.bg, user=MANAGER, db=self.db)
        self.assertTrue(purge_task_permanently(self.db, self.a["id"], MANAGER["email"]))
        self.db.commit()
        self.assertEqual(self.db.query(models.TaskTimeEntry).count(), 0)


if __name__ == "__main__":
    unittest.main()
