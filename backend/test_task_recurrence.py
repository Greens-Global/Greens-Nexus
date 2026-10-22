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

    # Nth weekday of the month (Oct 13 2026, Asana parity). Weekdays are the
    # frontend's 0=Sunday numbering: 3=Wednesday, 4=Thursday, 5=Friday.
    def test_the_4th_friday_still_ahead_this_month_comes_first(self):
        r = {"freq": "monthly", "weekOfMonth": 4, "weekday": 5}
        self.assertEqual(_next_due("2026-10-01", r), "2026-10-23")

    def test_the_4th_friday_after_this_months(self):
        r = {"freq": "monthly", "weekOfMonth": 4, "weekday": 5}
        self.assertEqual(_next_due("2026-10-23", r), "2026-11-27")

    def test_the_3rd_wednesday_already_past_moves_to_next_month(self):
        r = {"freq": "monthly", "weekOfMonth": 3, "weekday": 3}
        self.assertEqual(_next_due("2026-10-23", r), "2026-11-18")

    def test_the_last_friday(self):
        r = {"freq": "monthly", "weekOfMonth": -1, "weekday": 5}
        self.assertEqual(_next_due("2026-10-23", r), "2026-10-30")
        self.assertEqual(_next_due("2026-10-30", r), "2026-11-27")

    def test_a_5th_friday_the_month_lacks_falls_back_to_its_last(self):
        r = {"freq": "monthly", "weekOfMonth": 5, "weekday": 5}
        self.assertEqual(_next_due("2026-10-30", r), "2026-11-27")

    def test_every_2_months_on_the_2nd_tuesday(self):
        r = {"freq": "custom", "unit": "month", "interval": 2, "weekOfMonth": 2, "weekday": 2}
        self.assertEqual(_next_due("2026-10-13", r), "2026-12-08")

    def test_the_last_day_of_the_month(self):
        r = {"freq": "monthly", "dayOfMonth": -1}
        self.assertEqual(_next_due("2026-01-31", r), "2026-02-28")
        self.assertEqual(_next_due("2026-02-28", r), "2026-03-31")

    def test_yearly_on_the_4th_thursday_of_november(self):
        r = {"freq": "yearly", "weekOfMonth": 4, "weekday": 4, "monthOfYear": 11}
        self.assertEqual(_next_due("2026-03-01", r), "2026-11-26")
        self.assertEqual(_next_due("2026-11-26", r), "2027-11-25")

    # Every N weeks on several days (Oct 13 2026): the rest of this week's
    # days first, THEN skip ahead. 1=Monday, 4=Thursday.
    def test_every_2_weeks_on_monday_and_thursday(self):
        r = {"freq": "custom", "unit": "week", "interval": 2, "daysOfWeek": [1, 4]}
        dates, cur = [], "2026-10-19"
        for _ in range(4):
            cur = _next_due(cur, r)
            dates.append(cur)
        self.assertEqual(dates, ["2026-10-22", "2026-11-02", "2026-11-05", "2026-11-16"])

    def test_every_2_weeks_on_one_day_is_unchanged(self):
        r = {"freq": "custom", "unit": "week", "interval": 2, "daysOfWeek": [1]}
        self.assertEqual(_next_due("2026-10-19", r), "2026-11-02")
        # Starting off the rule's day: the next Monday two weeks on from this week.
        self.assertEqual(_next_due("2026-10-14", r), "2026-10-26")

    def test_weekly_on_several_days(self):
        r = {"freq": "weekly", "daysOfWeek": [1, 3, 5]}
        self.assertEqual(_next_due("2026-10-19", r), "2026-10-21")
        self.assertEqual(_next_due("2026-10-23", r), "2026-10-26")

    def test_a_weekday_rule_always_moves_forward(self):
        # The daily roll-forward steps _next_due until it passes today, and
        # stops if a step does not move - every rule must strictly advance.
        rules = [{"freq": "monthly", "weekOfMonth": w, "weekday": d} for w in (1, 2, 3, 4, 5, -1) for d in range(7)]
        for r in rules:
            cur = "2026-01-01"
            for _ in range(30):
                nxt = _next_due(cur, r)
                self.assertGreater(nxt, cur, r)
                cur = nxt


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
        # Plus the series id (Oct 21 2026) - this row predates ids, so the
        # series is named after it.
        self.assertEqual(spawned.recurrence, {"freq": "periodic", "daysAfterCompletion": 5, "seriesId": t.id})

    def test_count_still_ends_a_periodic_series(self):
        t = self._task(recurrence={"freq": "periodic", "daysAfterCompletion": 1, "count": 1})
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), user=USER, db=self.db)
        spawned = (self.db.query(models.Task)
                     .filter(models.Task.title == t.title, models.Task.id != t.id).first())
        self.assertIsNone(spawned)   # count=1 was the last occurrence


class OneOpenOccurrenceTests(unittest.TestCase):
    """Oct 2: a series has ONE open occurrence. When the next date arrives
    before the current one is done, the current one closes as Missed - closed
    (no more overdue emails, out of the open lists) but never counted as done
    work - and the new one is created. Existing stacks of open copies collapse
    the same way. Missed is the system's status only."""

    WEEKLY_MON = {"freq": "weekly", "interval": 1, "daysOfWeek": [1]}
    TODAY = "2026-09-28"   # a Monday

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.Task).delete()
        self.db.query(models.TaskActivity).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _task(self, due, *, completed=False, assignee="gm04@greensstorage.com"):
        tid = gen_id()
        self.db.add(models.Task(id=tid, code=f"TASK-{due}", title="Payroll Import", due_on=due, completed=completed,
                                status="completed" if completed else "recurring",
                                completed_at=(due + "T17:00:00") if completed else "",
                                assignee_email=assignee, assignee_emails=[assignee],
                                recurrence=dict(self.WEEKLY_MON), created_at=now_iso()))
        self.db.commit()
        return tid

    def _run(self, today=None):
        from routers.tasks import spawn_scheduled_occurrences
        return spawn_scheduled_occurrences(self.db, today or self.TODAY)

    def _get(self, tid):
        self.db.expire_all()
        return self.db.get(models.Task, tid)

    def _open(self):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.completed == False).all()  # noqa: E712

    def test_an_unfinished_occurrence_closes_as_missed_when_the_next_one_comes(self):
        old = self._task("2026-09-21")
        [new] = self._run()
        t = self._get(old)
        self.assertEqual((t.completed, t.status, t.completed_at), (True, "missed", ""))
        self.assertEqual([x.due_on for x in self._open()], ["2026-09-28"])
        note = (self.db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == old,
                                                          models.TaskActivity.type == "closed_missed").one())
        self.assertEqual(note.actor_email, "system")
        self.assertEqual(note.detail, f"Closed as Missed - the next occurrence {new.code} is due 09/28/2026")

    def test_a_completed_occurrence_is_left_alone(self):
        done = self._task("2026-09-21", completed=True)
        self._run()
        t = self._get(done)
        self.assertEqual((t.status, t.completed_at), ("completed", "2026-09-21T17:00:00"))

    def test_an_existing_stack_of_open_copies_collapses_to_one(self):
        ids = [self._task(d) for d in ("2026-09-07", "2026-09-14", "2026-09-21")]
        self._run()
        self.assertEqual([x.due_on for x in self._open()], ["2026-09-28"])
        self.assertEqual({self._get(i).status for i in ids}, {"missed"})

    def test_running_again_creates_nothing_and_closes_nothing_more(self):
        self._task("2026-09-21")
        self._run()
        self.assertEqual(self._run(), [])
        self.assertEqual(len(self._open()), 1)

    def test_a_reopened_missed_copy_stays_open(self):
        from routers.tasks import _apply_completion
        old = self._task("2026-09-21")
        self._run()
        t = self._get(old)
        _apply_completion(t, False, True)                       # someone reopens it to finish late
        self.assertEqual(t.status, "not_started")
        self.db.commit()
        self._run("2026-10-05")                                 # next week's roll
        self.assertFalse(self._get(old).completed)              # not closed again
        self.assertEqual(sorted(x.due_on for x in self._open()), ["2026-09-21", "2026-10-05"])

    def test_missed_is_never_a_status_anyone_can_set(self):
        from routers.tasks import _valid_statuses
        self.assertNotIn("missed", _valid_statuses(self.db))

    def test_a_missed_copy_never_counts_as_completed_work(self):
        import daily_briefing
        old = self._task("2026-09-21")
        self._run()
        rows = daily_briefing._manager_task_completion_rows(
            self.db, "mgr@greensstorage.com", "2026-09-01T00:00:00",
            {"gm04@greensstorage.com": models.NexusEmployee(first_name="Gm", last_name="Four",
                                                             work_email="gm04@greensstorage.com")})
        self.assertEqual(rows, [])
        self.assertEqual(self._get(old).completed_at, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)


class ScheduledSeriesTests(unittest.TestCase):
    """The daily schedule creates ONE occurrence per series per date (Sep 28).
    Before, every unmarked row of a series spawned its own copy - occurrences
    completed before Sep 18 had no `nextOccurrenceId` marker - so a weekly
    task showed up 13 times on the same Monday."""

    WEEKLY_MON = {"freq": "weekly", "interval": 1, "daysOfWeek": [1]}
    TODAY = "2026-09-28"   # a Monday

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.Task).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _task(self, due, *, completed=False, rec=None, assignee="gm04@greensstorage.com", **kw):
        tid = gen_id()
        self.db.add(models.Task(id=tid, title="Take out all Trash", due_on=due, completed=completed,
                                completed_at=(due + "T17:00:00") if completed else "",
                                assignee_email=assignee, assignee_emails=[assignee],
                                recurrence=dict(rec or self.WEEKLY_MON), created_at=now_iso(), **kw))
        self.db.commit()
        return tid

    def _run(self, today=None):
        from routers.tasks import spawn_scheduled_occurrences
        return spawn_scheduled_occurrences(self.db, today or self.TODAY)

    def _open_on(self, due):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.due_on == due,
                                                 models.Task.completed == False).all()  # noqa: E712

    def test_old_completed_occurrences_spawn_one_copy_not_one_each(self):
        # Completed before Sep 18: each kept its rule and no marker.
        for due in ("2026-09-07", "2026-09-14", "2026-09-21"):
            self._task(due, completed=True)
        self.assertEqual(len(self._run()), 1)
        self.assertEqual(len(self._open_on("2026-09-28")), 1)
        self.assertEqual(self._run(), [])   # same day again: nothing new

    def test_existing_duplicate_chains_collapse_into_one(self):
        # Three parallel chains, each with an open copy due last Monday.
        for _ in range(3):
            self._task("2026-09-21")
        self.assertEqual(len(self._run()), 1)
        self.assertEqual(len(self._open_on("2026-09-28")), 1)
        # Next week still only one.
        self.assertEqual(len(self._run("2026-10-05")), 1)
        self.assertEqual(len(self._open_on("2026-10-05")), 1)

    def test_a_date_the_series_already_has_is_not_created_again(self):
        self._task("2026-09-21")
        self._task("2026-09-28")    # this week's already exists
        self.assertEqual(self._run(), [])
        self.assertEqual(len(self._open_on("2026-09-28")), 1)

    def test_completing_a_superseded_copy_does_not_start_a_new_chain(self):
        a, b = self._task("2026-09-21"), self._task("2026-09-21")
        self._run()   # one of them carries the series; the other is stamped
        self.db.expire_all()
        stamped = [t for t in self.db.query(models.Task).filter(models.Task.id.in_([a, b])).all()
                   if (t.recurrence or {}).get("nextOccurrenceId")]
        self.assertEqual(len(stamped), 2)

    def test_tasks_in_the_recycle_bin_never_spawn(self):
        self._task("2026-09-21", deleted_at="2026-09-22T00:00:00")
        self.assertEqual(self._run(), [])

    def test_different_series_each_get_their_own(self):
        self._task("2026-09-21", assignee="gm04@greensstorage.com")
        self._task("2026-09-21", assignee="gm05@greensstorage.com")
        self.assertEqual(len(self._run()), 2)


class _SubtaskSeriesBase(unittest.TestCase):
    """A yearly main task with three subtasks, for the tests below."""

    YEARLY = {"freq": "yearly", "month": 4, "dayOfMonth": 15}

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskChecklistItem):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _add(self, **kw):
        now = now_iso()
        kw.setdefault("status", "not_started")
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", created_at=now, modified_at=now,
                        created_by=USER["email"], **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _series(self):
        parent = self._add(title="Tax Return - RJK MD Inc", due_on="2026-04-15", status="recurring",
                           recurrence=dict(self.YEARLY), custom_field_values={"ent": "rjk"},
                           assignee_email="viral@greensglobal.com", assignee_emails=["viral@greensglobal.com"])
        a = self._add(title="Collect K-1s", parent_task_id=parent.id, position=0.0, due_on="2026-03-01",
                      completed=True, status="completed", completed_at="2026-03-01T10:00:00",
                      custom_field_values={"ent": "rjk"}, assignee_emails=["urmi@greensglobal.com"])
        b = self._add(title="File extension", parent_task_id=parent.id, position=1.0, due_on="2026-04-10",
                      recurrence={"skip": True})
        c = self._add(title="Send to CPA", parent_task_id=parent.id, position=2.0)
        self.db.add(models.TaskChecklistItem(id=gen_id(), task_id=a.id, title="Ask the bank", done=True,
                                             position=0.0, created_at=now_iso()))
        self.db.commit()
        return parent, a, b, c

    def _complete(self, t):
        update_task(t.id, TaskUpdate(completed=True), BackgroundTasks(), user=USER, db=self.db)
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.title == t.title, models.Task.id != t.id).one()


class SubtasksTravelTests(_SubtaskSeriesBase):
    """Oct 14 2026 (Neil): a recurring task's subtasks come with it to the next
    occurrence - open again, in order, dates moved by the main task's shift -
    and one switched off ({"skip": true}) stays behind. A Missed occurrence
    takes its open subtasks with it."""

    def test_subtasks_come_along_open_and_in_order(self):
        parent, a, b, c = self._series()
        nxt = self._complete(parent)
        subs = (self.db.query(models.Task).filter(models.Task.parent_task_id == nxt.id)
                .order_by(models.Task.position).all())
        self.assertEqual([s.title for s in subs], ["Collect K-1s", "Send to CPA"])
        self.assertEqual(nxt.subtask_ids, [s.id for s in subs])
        self.assertTrue(all(not s.completed and s.status == "not_started" for s in subs))
        self.assertEqual(len({s.code for s in subs} | {nxt.code}), 3)

    def test_due_dates_move_with_the_main_task_and_fields_stay(self):
        parent, a, *_ = self._series()
        nxt = self._complete(parent)
        self.assertEqual(nxt.due_on, "2027-04-15")
        k1 = self.db.query(models.Task).filter(models.Task.parent_task_id == nxt.id,
                                               models.Task.title == "Collect K-1s").one()
        self.assertEqual(k1.due_on, "2027-03-01")
        self.assertEqual(k1.custom_field_values, {"ent": "rjk"})
        self.assertEqual(k1.assignee_emails, ["urmi@greensglobal.com"])
        items = self.db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == k1.id).all()
        self.assertEqual([(i.title, i.done) for i in items], [("Ask the bank", False)])
        self.assertEqual(k1.checklist_total, 1)

    def test_a_missed_occurrence_closes_its_open_subtasks(self):
        from routers.tasks import _close_as_missed
        parent, a, b, c = self._series()
        _close_as_missed(self.db, parent, "test")
        self.db.commit()
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, c.id).status, "missed")
        self.assertEqual(self.db.get(models.Task, a.id).status, "completed")   # finished stays finished


class SubtaskOwnScheduleTests(_SubtaskSeriesBase):
    """Oct 14 2026 (Sagar): a subtask repeats with its main task by default,
    but can be given a schedule of its own. Each copy goes under the main
    task's CURRENT occurrence; when the main task repeats, an open one moves
    to the new occurrence instead of being copied, and a Missed main task
    does not close it."""

    MONTHLY = {"freq": "monthly", "dayOfMonth": 1}

    def _own(self, parent, **kw):
        return self._add(title="Reconcile bank", parent_task_id=parent.id, position=3.0,
                         due_on="2026-03-01", recurrence=dict(self.MONTHLY), status="recurring", **kw)

    def test_completing_it_makes_the_next_copy_under_the_same_main_task(self):
        parent = self._add(title="Year-end close", due_on="2026-12-31")   # does not repeat
        own = self._own(parent)
        nxt = self._complete(own)
        self.assertEqual(nxt.parent_task_id, parent.id)
        self.assertEqual(nxt.due_on, "2026-04-01")
        self.assertEqual(nxt.position, 3.0)
        self.db.expire_all()
        self.assertIn(nxt.id, self.db.get(models.Task, parent.id).subtask_ids)

    def test_the_next_copy_goes_under_the_main_tasks_current_occurrence(self):
        parent, *_ = self._series()
        own = self._own(parent)
        own.completed, own.status = True, "completed"   # done before the main task rolled
        self.db.commit()
        new_parent = self._complete(parent)
        from routers.tasks import _spawn_next_occurrence
        self.db.expire_all()
        own = self.db.get(models.Task, own.id)
        nxt = _spawn_next_occurrence(self.db, own, USER)
        self.db.commit()
        self.assertEqual(nxt.parent_task_id, new_parent.id)

    def test_an_open_one_moves_with_the_main_task_not_copied(self):
        parent, *_ = self._series()
        own = self._own(parent)
        new_parent = self._complete(parent)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, own.id).parent_task_id, new_parent.id)
        self.assertIn(own.id, new_parent.subtask_ids)
        self.assertNotIn(own.id, self.db.get(models.Task, parent.id).subtask_ids or [])
        copies = self.db.query(models.Task).filter(models.Task.title == "Reconcile bank").count()
        self.assertEqual(copies, 1)

    def test_a_missed_main_task_leaves_it_open(self):
        from routers.tasks import _close_as_missed
        parent, a, b, c = self._series()
        own = self._own(parent)
        _close_as_missed(self.db, parent, "test")
        self.db.commit()
        self.db.expire_all()
        self.assertFalse(self.db.get(models.Task, own.id).completed)
        self.assertEqual(self.db.get(models.Task, c.id).status, "missed")

    def test_the_daily_schedule_rolls_it_forward(self):
        from routers.tasks import spawn_scheduled_occurrences
        parent = self._add(title="Year-end close", due_on="2026-12-31")
        own = self._own(parent)
        spawned = spawn_scheduled_occurrences(self.db, "2026-04-02")
        self.assertEqual([(t.title, t.parent_task_id, t.due_on) for t in spawned],
                         [("Reconcile bank", parent.id, "2026-04-01")])
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, own.id).status, "missed")

    def test_the_same_step_under_two_main_tasks_is_two_series(self):
        from routers.tasks import spawn_scheduled_occurrences
        p1 = self._add(title="Close - RJK", due_on="2026-12-31")
        p2 = self._add(title="Close - AUS", due_on="2026-12-31")
        self._own(p1)
        self._own(p2)
        spawned = spawn_scheduled_occurrences(self.db, "2026-04-02")
        self.assertEqual(sorted(t.parent_task_id for t in spawned), sorted([p1.id, p2.id]))
