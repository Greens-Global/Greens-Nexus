"""The start date fills itself in when a task leaves Not Started (Sept 2026).

The List view's Timeline column is a start->due range, but until now the only
way to get a start date was to open that one cell and type it, so almost nothing
had one and every Gantt bar was a one-day stub. Moving off Not Started is the
moment work began, so that is when the date is recorded - on every path that
writes a status, since a board drag, a bulk action and a drawer click are the
same event to the person doing them.

A task created straight into a started column has no transition to catch, so
creation applies the same rule from the other end: the created date IS the start
date.

What is worth pinning: that it never OVERWRITES (a hand-set date, one from
Asana, or one from an earlier trip through Not Started is the truth about when
work started), that it only fires on the transition and not on every later edit,
and that all three write paths - create, PATCH and bulk - behave identically.

Run with: python -m unittest test_task_start_date -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks

import database
import models
import task_notify
from routers import tasks as tasks_router
from routers.task_util import gen_id, now_iso
from routers.tasks import create_task, update_task, bulk_update, TaskCreate, TaskUpdate, BulkUpdate

# A test that DELETES rows must prove its own isolation before it deletes any.
#
# unittest runs every module named on one command line in ONE process, so
# `import database` happens once: whichever module is imported FIRST fixes
# DATABASE_URL for all of them, and the assignment above is a dead letter for
# the rest. Run after a module that does not set it (test_app_boot does not),
# and these setUp() deletes land in the developer's real local greens_nexus.db.
# That is not hypothetical - it happened on 2026-09-07 and took the local task,
# project and portfolio rows with it. So the binding is checked, not assumed.
def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

ACTOR = {"email": "actor@greensglobal.com", "level": 1}
# UTC, exactly as the code derives it. date.today() is server-LOCAL, and these
# two tests went red at 02:52 IST on 2026-09-08 - the local clock had rolled
# over and UTC had not, so the test was asserting a different day's date than
# the one being written. That mismatch was real in the CODE too (create used
# UTC, the transition used local), which is what the failure actually found.
TODAY = datetime.now(timezone.utc).isoformat()[:10]


class _StartDateCase(unittest.TestCase):
    """Shared fixture only - no tests of its own, so the classes below don't
    re-run each other's."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        # Two classes share this fixture, so both run this - the second finds
        # the file already gone.
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskNotification):
            self.db.query(m).delete()
        self.db.commit()
        # Asana push and mail are network; this is about the column.
        self._push = tasks_router._asana_push
        self._notify = task_notify.notify_task_event
        tasks_router._asana_push = lambda *a, **kw: None
        task_notify.notify_task_event = lambda *a, **kw: None

    def tearDown(self):
        tasks_router._asana_push = self._push
        task_notify.notify_task_event = self._notify
        self.db.close()

    def _task(self, **kw):
        t = models.Task(id=gen_id(), title="Reconcile QuickBooks", code="TASK-1",
                        status=kw.pop("status", "not_started"), activity_ids=[],
                        created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _patch(self, t, **fields):
        update_task(t.id, TaskUpdate(**fields), BackgroundTasks(), user=ACTOR, db=self.db)
        self.db.refresh(t)
        return t

    def _create(self, **fields):
        fields.setdefault("title", "Born in progress")
        return create_task(TaskCreate(**fields), BackgroundTasks(), user=ACTOR, db=self.db)


class StartDateStampTests(_StartDateCase):
    """Moving a task off Not Started."""

    # ── the rule ──────────────────────────────────────────────────────────
    def test_leaving_not_started_stamps_today(self):
        t = self._task()
        self.assertEqual(self._patch(t, status="in_progress").start_on, TODAY)

    def test_straight_to_completed_counts_as_starting(self):
        # Ticking a task off without ever moving it to In Progress is still work
        # that happened - the range must not stay empty.
        t = self._task()
        self.assertEqual(self._patch(t, status="completed").start_on, TODAY)

    def test_a_hand_set_start_date_is_never_overwritten(self):
        t = self._task(start_on="2026-01-15")
        self.assertEqual(self._patch(t, status="in_progress").start_on, "2026-01-15")

    def test_a_date_sent_in_the_same_patch_wins_over_the_stamp(self):
        t = self._task()
        self.assertEqual(self._patch(t, status="in_progress", start_on="2026-02-02").start_on,
                         "2026-02-02")

    def test_reopening_and_restarting_keeps_the_original_date(self):
        t = self._task()
        self._patch(t, status="in_progress")
        self._patch(t, status="not_started")     # back to the top of the board
        t.start_on = "2026-03-03"                # as if it had started back then
        self.db.commit()
        self.assertEqual(self._patch(t, status="in_progress").start_on, "2026-03-03")

    def test_edits_that_do_not_change_status_stamp_nothing(self):
        t = self._task()
        self.assertEqual(self._patch(t, title="Renamed", priority="high").start_on, "")

    def test_moving_between_started_statuses_stamps_nothing(self):
        # Only the FIRST move off Not Started counts; a task with no start date
        # that is already in progress is not "starting" again.
        t = self._task(status="in_progress")
        self.assertEqual(self._patch(t, status="completed").start_on, "")

    # ── the other write path ──────────────────────────────────────────────
    def test_bulk_status_change_stamps_every_row_the_same_way(self):
        fresh, dated, running = self._task(), self._task(start_on="2026-01-15"), self._task(status="in_progress")
        bulk_update(BulkUpdate(ids=[fresh.id, dated.id, running.id],
                               patch={"status": "in_progress"}), user=ACTOR, db=self.db)
        for t in (fresh, dated, running):
            self.db.refresh(t)
        self.assertEqual(fresh.start_on, TODAY)         # started now
        self.assertEqual(dated.start_on, "2026-01-15")  # already knew when
        self.assertEqual(running.start_on, "")          # was never in Not Started


class CreatedIntoAStartedColumnTests(_StartDateCase):
    """Creation is the third write path. The "+ Add task" row inherits its
    group's status, so a card added under In Progress is born started."""

    def test_created_into_a_started_column_starts_today(self):
        self.assertEqual(self._create(status="in_progress")["startOn"], TODAY)

    def test_created_into_not_started_has_no_start_date(self):
        self.assertIsNone(self._create(status="not_started")["startOn"])
        self.assertIsNone(self._create()["startOn"])     # status defaults to not_started

    def test_created_completed_still_gets_a_start_date(self):
        # Logging work that is already finished: it started and ended today.
        self.assertEqual(self._create(status="completed")["startOn"], TODAY)

    def test_an_explicit_start_date_wins_over_the_created_date(self):
        self.assertEqual(self._create(status="in_progress", start_on="2026-04-04")["startOn"],
                         "2026-04-04")

    def test_both_write_paths_agree_on_what_day_it_is(self):
        # The bug this pins: create derived its date from now_iso() (UTC) while
        # the transition used date.today() (server-local). East of UTC they are
        # different days for hours at a time, so two tasks started seconds apart
        # got start dates a day apart depending on which path they came in by.
        born = self._create(status="in_progress")
        moved = self._patch(self._task(), status="in_progress")
        self.assertEqual(born["startOn"], moved.start_on)

    def test_the_start_date_matches_the_task_own_created_date(self):
        # Both come from the same now_iso(), so they can never disagree - the
        # point of deriving one from the other rather than calling date.today().
        row = self._create(status="in_progress")
        self.assertEqual(row["startOn"], row["createdAt"][:10])


if __name__ == "__main__":
    unittest.main()
