"""
Tasks data-integrity fixes (Oct 21 2026).

  1. A recurring series has a real identity (`seriesId` on the rule): two
     independent tasks with the same title, project, people and rule are two
     series - neither is closed as Missed for the other. Rows from before
     series ids keep their old grouping (fingerprint + company, plus their
     nextOccurrenceId chain).
  2. The next occurrence keeps the "also in" projects and the series id, and
     two completions racing on one occurrence spawn ONE next occurrence.
  3. A "due date arrives" rule that completes a recurring task rolls it
     forward through the same completion path a person's tick uses - and
     still fires no other rule (the engine never chains).
  4. Trash takes a task's whole subtree, stamped so restore brings back
     exactly that set; a project's subtasks go with the project.
  5. A parent change moves the id between the two parents' subtask lists;
     a subtask_ids PATCH keeps each child's parent_task_id in step, no loops.
  6. /tasks/delta tells a client to drop a task it can no longer see.
  7. The Excel export's filename date is MM-DD-YYYY.

Uses a throwaway sqlite file. No network - task_notify's email send is stubbed.

Run with: python -m pytest -q test_task_integrity_fixes.py   (one file per process)
"""
import os
import tempfile
import time
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import task_automation  # noqa: E402
import task_notify  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from routers.tasks import (  # noqa: E402
    create_task, update_task, delete_task, restore_task, list_tasks_delta, export_tasks_excel,
    spawn_scheduled_occurrences, _spawn_next_occurrence, TaskCreate, TaskUpdate,
)
from routers.task_projects import delete_project, list_recycle_bin, restore_from_recycle_bin  # noqa: E402
from routers.task_config import create_rule, RuleBody, _clean_rule  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

BOSS = {"email": "boss@greensglobal.com", "level": 3}
DEAN = {"email": "dean@greensglobal.com", "level": 1}
SAM = "sam@greensglobal.com"
WEEKLY_MON = {"freq": "weekly", "interval": 1, "daysOfWeek": [1]}
TODAY = "2026-09-28"   # a Monday


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls._real_notify = task_notify.notify_task_event
        cls.sent = []
        task_notify.notify_task_event = lambda *a, **kw: cls.sent.append(a)

    @classmethod
    def tearDownClass(cls):
        task_notify.notify_task_event = cls._real_notify

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskProject, models.TaskDeleteLog,
                  models.TaskAutomationRule, models.TaskAutomationRun, models.TaskNotification,
                  models.TaskChecklistItem):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        type(self).sent.clear()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _row(self, tid):
        self.db.expire_all()
        return (self.db.query(models.Task).execution_options(include_deleted=True)
                .filter(models.Task.id == tid).first())

    def _add(self, title="Task", **kw):
        now = now_iso()
        kw.setdefault("status", "not_started")
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", title=title,
                        created_at=now, modified_at=now, created_by=BOSS["email"], **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _create(self, **kw):
        return create_task(TaskCreate(title=kw.pop("title", "Take out all Trash"), **kw),
                           BackgroundTasks(), user=BOSS, db=self.db)

    def _patch(self, tid, user=BOSS, **kw):
        return update_task(tid, TaskUpdate(**kw), BackgroundTasks(), user=user, db=self.db)

    def _project(self, name="Ops"):
        p = models.TaskProject(id=gen_id(), name=name, access_level="org", owner_email=BOSS["email"],
                               member_emails=[], created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        return p


# ── 1 + 2. Series identity and the roll-forward ──────────────────────────────
class SeriesIdentityTests(_Case):
    def _open_on(self, due):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.due_on == due,
                                                 models.Task.completed == False).all()  # noqa: E712

    def test_a_new_recurring_task_is_its_own_series(self):
        t = self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON), assignee_emails=[SAM])
        self.assertEqual(self._row(t["id"]).recurrence["seriesId"], t["id"])

    def test_two_identical_independent_tasks_both_keep_repeating(self):
        a = self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON), assignee_emails=[SAM])
        b = self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON), assignee_emails=[SAM])
        spawned = spawn_scheduled_occurrences(self.db, TODAY)
        self.assertEqual(len(spawned), 2, "each series gets its own next occurrence")
        self.assertEqual(sorted(s.recurrence["seriesId"] for s in spawned), sorted([a["id"], b["id"]]))
        # Each old one closes as Missed for ITS OWN next occurrence - neither
        # was swallowed by the other.
        self.assertEqual(len(self._open_on("2026-09-28")), 2)
        spawned = spawn_scheduled_occurrences(self.db, "2026-10-05")
        self.assertEqual(len(spawned), 2, "and both keep going the week after")

    def test_a_copy_of_a_rule_never_brings_its_series_id(self):
        a = self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON))
        rule = self._row(a["id"]).recurrence
        b = self._create(due_on="2026-09-21", recurrence=dict(rule))   # what Duplicate sends
        self.assertEqual(self._row(b["id"]).recurrence["seriesId"], b["id"])

    def test_editing_the_rule_keeps_the_series_id_whatever_the_editor_sends(self):
        a = self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON))
        self._patch(a["id"], recurrence={"freq": "weekly", "daysOfWeek": [2], "seriesId": "someone-else"})
        self.assertEqual(self._row(a["id"]).recurrence["seriesId"], a["id"])
        self._patch(a["id"], recurrence={"freq": "weekly", "daysOfWeek": [3]})
        self.assertEqual(self._row(a["id"]).recurrence["seriesId"], a["id"])

    def test_switching_repeat_on_starts_a_series(self):
        t = self._create(due_on="2026-09-21")
        self._patch(t["id"], recurrence=dict(WEEKLY_MON))
        self.assertEqual(self._row(t["id"]).recurrence["seriesId"], t["id"])

    def test_a_legacy_series_stays_without_an_id_when_its_rule_is_edited(self):
        t = self._add(due_on="2026-09-21", recurrence=dict(WEEKLY_MON))
        self._patch(t.id, recurrence={"freq": "weekly", "daysOfWeek": [1], "interval": 1, "seriesId": "x"})
        self.assertNotIn("seriesId", self._row(t.id).recurrence)

    def test_legacy_duplicates_still_collapse_but_not_across_companies(self):
        # Rows from before series ids: the old fingerprint still groups them -
        # now with the company in it.
        for _ in range(2):
            self._add("Payroll Import", due_on="2026-09-21", recurrence=dict(WEEKLY_MON), company_id="co-a",
                      assignee_emails=[SAM], assignee_email=SAM)
        self._add("Payroll Import", due_on="2026-09-21", recurrence=dict(WEEKLY_MON), company_id="co-b",
                  assignee_emails=[SAM], assignee_email=SAM)
        spawned = spawn_scheduled_occurrences(self.db, TODAY)
        self.assertEqual(sorted(s.company_id for s in spawned), ["co-a", "co-b"])

    def test_a_legacy_chain_and_its_new_occurrences_stay_one_series(self):
        # An id-less occurrence rolls forward: the copy carries a series id
        # named after it, and the two (plus an id-less straggler with the same
        # fingerprint) are still ONE series on the next scans.
        old = self._add("Payroll Import", due_on="2026-09-14", recurrence=dict(WEEKLY_MON),
                        completed=True, status="completed", completed_at="2026-09-14T10:00:00")
        head = self._add("Payroll Import", due_on="2026-09-21", recurrence=dict(WEEKLY_MON))
        [nxt] = spawn_scheduled_occurrences(self.db, TODAY)
        self.assertEqual(nxt.recurrence["seriesId"], head.id)
        self.assertEqual(self._row(old.id).recurrence.get("nextOccurrenceId"), head.id)
        self.assertNotIn("seriesId", self._row(head.id).recurrence, "the legacy row is left as it was")
        self.assertEqual(self._row(head.id).status, "missed")
        [later] = spawn_scheduled_occurrences(self.db, "2026-10-05")
        self.assertEqual(later.recurrence["seriesId"], head.id)
        self.assertEqual(len(self._open_on("2026-10-05")), 1)
        self.assertEqual(self._row(nxt.id).status, "missed")

    def test_the_next_occurrence_keeps_the_also_in_projects(self):
        t = self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON), project_ids=["p-extra"])
        self._patch(t["id"], completed=True)
        self.db.expire_all()
        nxt = self.db.query(models.Task).filter(models.Task.id != t["id"]).one()
        self.assertEqual(nxt.project_ids, ["p-extra"])
        self.assertEqual(nxt.recurrence["seriesId"], t["id"])

    def test_two_completions_racing_spawn_one_next_occurrence(self):
        t = self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON))
        # Request A loaded the row before request B completed it.
        other = database.SessionLocal()
        try:
            stale = other.query(models.Task).filter(models.Task.id == t["id"]).one()
            _ = stale.recurrence
            self._patch(t["id"], completed=True)                # request B lands first
            self.assertIsNone(_spawn_next_occurrence(other, stale, BOSS), "A sees B's marker")
            self.assertTrue(stale.recurrence.get("nextOccurrenceId"))
            other.commit()
        finally:
            other.close()
        self.db.expire_all()
        self.assertEqual(self.db.query(models.Task).count(), 2)

    def test_a_template_never_stores_a_series_id(self):
        self.assertEqual(_clean_rule({**WEEKLY_MON, "seriesId": "abc", "nextOccurrenceId": "x"}), WEEKLY_MON)


# ── 3. Automation completes a recurring task ─────────────────────────────────
class AutomationCompletionTests(_Case):
    def test_a_due_date_rule_that_completes_a_recurring_task_rolls_it_forward(self):
        today = task_automation.business_today().isoformat()
        create_rule(RuleBody(name="Close on the day", trigger={"type": "due_date_arrives", "value": 0},
                             actions=[{"type": "set_status", "value": "completed"}], conditions=[]), db=self.db)
        # Would fire if the engine chained off the automated completion.
        create_rule(RuleBody(name="Tag completions", trigger={"type": "status_changed", "value": "completed"},
                             actions=[{"type": "add_tag", "value": "chained"}], conditions=[]), db=self.db)
        t = self._create(due_on=today, recurrence={"freq": "daily"}, assignee_emails=[SAM])
        self.assertEqual(task_automation.run_scheduled(self.db, today), 1)
        row = self._row(t["id"])
        self.assertTrue(row.completed)
        self.assertTrue(row.completed_at)
        nxt_id = row.recurrence.get("nextOccurrenceId")
        self.assertTrue(nxt_id, "the series rolled forward")
        nxt = self._row(nxt_id)
        self.assertFalse(nxt.completed)
        self.assertEqual(nxt.recurrence["seriesId"], t["id"])
        self.assertEqual(nxt.created_by, BOSS["email"], "created as the owner/creator, not the rule")
        done = (self.db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_id == t["id"], models.TaskActivity.type == "completed").one())
        self.assertEqual(done.actor_email, task_automation.AUTOMATION_ACTOR)
        self.assertIn((t["id"], "completed", task_automation.AUTOMATION_ACTOR), type(self).sent)
        # No chain: the other rule never ran, on either task.
        self.assertNotIn("chained", row.tags or [])
        self.assertNotIn("chained", nxt.tags or [])
        # Re-running the same day changes nothing more.
        self.assertEqual(task_automation.run_scheduled(self.db, today), 0)
        self.assertEqual(self.db.query(models.Task).count(), 2)


# ── 4. Trash cascade ─────────────────────────────────────────────────────────
class TrashCascadeTests(_Case):
    def _tree(self):
        top = self._add("Rewire keypad", project_id="")
        mid = self._add("Order parts", parent_task_id=top.id)
        leaf = self._add("Collect quote", parent_task_id=mid.id)
        top.subtask_ids, mid.subtask_ids = [mid.id], [leaf.id]
        self.db.commit()
        return top, mid, leaf

    def test_deleting_a_task_bins_its_whole_subtree(self):
        top, mid, leaf = self._tree()
        delete_task(top.id, BackgroundTasks(), user=BOSS, db=self.db)
        for r in (top, mid, leaf):
            self.assertTrue(self._row(r.id).deleted_at)
        self.assertEqual(self._row(top.id).deleted_with, "")
        self.assertEqual({self._row(mid.id).deleted_with, self._row(leaf.id).deleted_with}, {top.id})
        logged = {d.task_id for d in self.db.query(models.TaskDeleteLog).all()}
        self.assertEqual(logged, {top.id, mid.id, leaf.id})
        # The bin lists the task, not each step under it.
        names = [r["name"] for r in list_recycle_bin(scope="", user=BOSS, db=self.db)]
        self.assertEqual(names, ["Rewire keypad"])

    def test_a_cycle_in_the_data_does_not_hang_the_delete(self):
        a = self._add("A")
        b = self._add("B", parent_task_id=a.id)
        a.parent_task_id = b.id      # already-broken data
        self.db.commit()
        delete_task(a.id, BackgroundTasks(), user=BOSS, db=self.db)
        self.assertTrue(self._row(b.id).deleted_at)

    def test_restore_brings_back_exactly_what_went_with_it(self):
        top, mid, leaf = self._tree()
        gone_before = self._add("Cancelled step", parent_task_id=top.id)
        top.subtask_ids = [mid.id, gone_before.id]
        self.db.commit()
        delete_task(gone_before.id, BackgroundTasks(), user=BOSS, db=self.db)   # binned on its own first
        time.sleep(0.001)
        delete_task(top.id, BackgroundTasks(), user=BOSS, db=self.db)
        restore_task(top.id, user=BOSS, db=self.db)
        for r in (top, mid, leaf):
            self.assertEqual(self._row(r.id).deleted_at, "")
            self.assertEqual(self._row(r.id).deleted_with, "")
        self.assertTrue(self._row(gone_before.id).deleted_at, "deleted separately earlier: stays binned")
        self.assertEqual(self._row(top.id).subtask_ids, [mid.id])
        self.assertEqual(self._row(mid.id).subtask_ids, [leaf.id])

    def test_the_recycle_bin_restore_brings_the_subtree_too(self):
        top, mid, leaf = self._tree()
        delete_task(top.id, BackgroundTasks(), user=BOSS, db=self.db)
        r = restore_from_recycle_bin("task", top.id, user=BOSS, db=self.db)
        self.assertEqual(r["restored"], 3)
        self.assertEqual(self._row(leaf.id).deleted_at, "")

    def test_a_restored_subtask_rejoins_its_live_parent(self):
        top, mid, leaf = self._tree()
        delete_task(mid.id, BackgroundTasks(), user=BOSS, db=self.db)
        self.assertEqual(self._row(top.id).subtask_ids, [])
        self.assertTrue(self._row(leaf.id).deleted_at, "the subtask's own subtask goes with it")
        restore_task(mid.id, user=BOSS, db=self.db)
        self.assertEqual(self._row(top.id).subtask_ids, [mid.id])
        self.assertEqual(self._row(leaf.id).deleted_at, "")

    def test_a_subtask_binned_with_its_parent_before_the_stamp_existed_comes_back(self):
        # Trash from before Oct 21: the direct subtasks went in with the same
        # deleted_at and no deleted_with. One deleted separately has its own.
        top = self._add("Old parent")
        same = self._add("Went with it", parent_task_id=top.id)
        apart = self._add("Deleted earlier", parent_task_id=top.id)
        stamp = now_iso()
        for r in (top, same):
            r.deleted_at, r.deleted_by = stamp, BOSS["email"]
        apart.deleted_at, apart.deleted_by = "2026-01-01T00:00:00+00:00", BOSS["email"]
        self.db.commit()
        restore_task(top.id, user=BOSS, db=self.db)
        self.assertEqual(self._row(same.id).deleted_at, "")
        self.assertTrue(self._row(apart.id).deleted_at)

    def test_deleting_a_project_bins_its_subtasks_and_restoring_it_brings_them_back(self):
        p = self._project()
        top = self._add("Task in project", project_id=p.id)
        sub = self._add("Its subtask", parent_task_id=top.id)       # project_id blank, as subtasks are
        top.subtask_ids = [sub.id]
        self.db.commit()
        out = delete_project(p.id, user=BOSS, db=self.db)
        self.assertEqual(out["tasks"], 2)
        self.assertTrue(self._row(sub.id).deleted_at)
        self.assertEqual(self._row(sub.id).deleted_with, p.id)
        restore_from_recycle_bin("project", p.id, user=BOSS, db=self.db)
        self.assertEqual(self._row(sub.id).deleted_at, "")
        self.assertEqual(self._row(top.id).subtask_ids, [sub.id])

    def test_nothing_is_hard_deleted(self):
        top, mid, leaf = self._tree()
        delete_task(top.id, BackgroundTasks(), user=BOSS, db=self.db)
        self.assertEqual(self.db.query(models.Task).execution_options(include_deleted=True).count(), 3)


# ── 5. Reparenting ───────────────────────────────────────────────────────────
class HierarchyTests(_Case):
    def test_a_parent_change_moves_the_id_between_the_two_lists(self):
        old = self._add("Old parent")
        new = self._add("New parent")
        kid = self._add("Kid", parent_task_id=old.id)
        old.subtask_ids = [kid.id]
        self.db.commit()
        self._patch(kid.id, parent_task_id=new.id)
        self.assertEqual(self._row(old.id).subtask_ids, [])
        self.assertEqual(self._row(new.id).subtask_ids, [kid.id])

    def test_an_unknown_parent_is_refused(self):
        kid = self._add("Kid")
        with self.assertRaises(HTTPException) as e:
            self._patch(kid.id, parent_task_id="no-such-task")
        self.assertEqual(e.exception.status_code, 422)

    def test_the_existing_parent_cycle_guard_still_holds(self):
        a = self._add("A")
        b = self._add("B", parent_task_id=a.id)
        with self.assertRaises(HTTPException):
            self._patch(a.id, parent_task_id=b.id)

    def test_listing_a_task_as_a_subtask_moves_it_under_this_one(self):
        old = self._add("Old parent")
        new = self._add("New parent")
        kid = self._add("Kid", parent_task_id=old.id)
        old.subtask_ids = [kid.id]
        self.db.commit()
        self._patch(new.id, subtask_ids=[kid.id])
        self.assertEqual(self._row(kid.id).parent_task_id, new.id)
        self.assertEqual(self._row(old.id).subtask_ids, [])

    def test_taking_a_task_off_the_list_makes_it_top_level(self):
        p = self._add("Parent")
        kid = self._add("Kid", parent_task_id=p.id)
        p.subtask_ids = [kid.id]
        self.db.commit()
        self._patch(p.id, subtask_ids=[])
        self.assertEqual(self._row(kid.id).parent_task_id, "")

    def test_a_task_cannot_list_itself_or_its_ancestor(self):
        top = self._add("Top")
        mid = self._add("Mid", parent_task_id=top.id)
        top.subtask_ids = [mid.id]
        self.db.commit()
        with self.assertRaises(HTTPException):
            self._patch(mid.id, subtask_ids=[mid.id])
        with self.assertRaises(HTTPException):
            self._patch(mid.id, subtask_ids=[top.id])
        with self.assertRaises(HTTPException):
            self._patch(mid.id, subtask_ids=["no-such-task"])
        self.assertEqual(self._row(top.id).parent_task_id, "")

    def test_reordering_the_same_subtasks_changes_no_parent(self):
        p = self._add("Parent")
        a = self._add("A", parent_task_id=p.id)
        b = self._add("B", parent_task_id=p.id)
        p.subtask_ids = [a.id, b.id]
        self.db.commit()
        self._patch(p.id, subtask_ids=[b.id, a.id])
        self.assertEqual(self._row(p.id).subtask_ids, [b.id, a.id])
        self.assertEqual({self._row(a.id).parent_task_id, self._row(b.id).parent_task_id}, {p.id})


# ── Review fixes (Oct 21 2026) ───────────────────────────────────────────────
class LegacyGroupingUnchangedTests(_Case):
    """Rows from before series ids group exactly as on origin/dev: by their
    fingerprint only. A link between two id-less rows is not followed, so an
    edited chain is not merged and closed as Missed by surprise."""

    def _chain(self, older_kw, newer_kw):
        newer = self._add(due_on="2026-09-21", recurrence=dict(WEEKLY_MON), **newer_kw)
        older = self._add(due_on="2026-09-14", recurrence={**WEEKLY_MON, "nextOccurrenceId": newer.id},
                          **older_kw)
        return older, newer

    def test_a_chain_whose_title_changed_leaves_the_older_one_open(self):
        older, newer = self._chain({"title": "Rent roll - Sep"}, {"title": "Rent roll - Oct"})
        sub = self._add("Collect statements", parent_task_id=older.id)
        spawn_scheduled_occurrences(self.db, TODAY)
        o = self._row(older.id)
        self.assertEqual((o.completed, o.status), (False, "not_started"))
        self.assertFalse(self._row(sub.id).completed, "its open subtask is untouched too")
        self.assertEqual(self._row(newer.id).status, "missed", "the newer one rolls as before")

    def test_a_chain_whose_assignee_changed_leaves_the_older_one_open(self):
        older, newer = self._chain({"title": "Payroll", "assignee_emails": [SAM], "assignee_email": SAM},
                                   {"title": "Payroll", "assignee_emails": [DEAN["email"]],
                                    "assignee_email": DEAN["email"]})
        spawn_scheduled_occurrences(self.db, TODAY)
        o = self._row(older.id)
        self.assertEqual((o.completed, o.status), (False, "not_started"))

    def test_a_legacy_head_and_its_first_copy_with_an_id_are_one_series(self):
        head = self._add("Payroll", due_on="2026-09-21", recurrence=dict(WEEKLY_MON))
        [nxt] = spawn_scheduled_occurrences(self.db, TODAY)
        self.assertEqual(nxt.recurrence["seriesId"], head.id)
        self.assertNotIn("seriesId", self._row(head.id).recurrence)
        from routers.tasks import _series_groups
        self.db.expire_all()
        rows = self.db.query(models.Task).all()
        self.assertEqual(len(_series_groups(rows, {r.id: r for r in rows})), 1)


class ScheduleLockTests(_Case):
    def test_the_schedule_skips_a_head_somebody_has_locked(self):
        # On Postgres a row held by another transaction comes back empty under
        # SKIP LOCKED. SQLite has no row locks, so stand that in: the head is
        # invisible to the re-read, and the dialect reads as Postgres.
        t = self._add("Payroll", due_on="2026-09-21", recurrence=dict(WEEKLY_MON),
                      deleted_at="2026-09-22T00:00:00+00:00")
        dialect = self.db.bind.dialect
        real = dialect.name
        dialect.name = "postgresql"
        try:
            self.assertIsNone(_spawn_next_occurrence(self.db, t, BOSS, skip_locked=True))
        finally:
            dialect.name = real
        self.assertEqual(self.db.query(models.Task).execution_options(include_deleted=True).count(), 1)

    def test_each_new_occurrence_is_its_own_commit(self):
        for who in (SAM, DEAN["email"]):
            self._create(due_on="2026-09-21", recurrence=dict(WEEKLY_MON), assignee_emails=[who])
        commits = []
        real_commit = self.db.commit
        self.db.commit = lambda: (commits.append(1), real_commit())[1]
        try:
            self.assertEqual(len(spawn_scheduled_occurrences(self.db, TODAY)), 2)
        finally:
            self.db.commit = real_commit
        self.assertGreaterEqual(len(commits), 2)


class HierarchyAccessTests(_Case):
    def setUp(self):
        super().setUp()
        self.mine = self._add("Mine", assignee_emails=[DEAN["email"]], assignee_email=DEAN["email"])

    def test_cannot_pull_a_task_they_cannot_see_under_their_own(self):
        p = models.TaskProject(id=gen_id(), name="HR", access_level="private", owner_email=BOSS["email"],
                               member_emails=[], created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        hidden = self._add("Salary review", project_id=p.id, access_level="private")
        with self.assertRaises(HTTPException) as e:
            self._patch(self.mine.id, user=DEAN, subtask_ids=[hidden.id])
        self.assertEqual(e.exception.status_code, 404)
        self.assertEqual(self._row(hidden.id).parent_task_id, "")

    def test_cannot_pull_a_task_they_can_only_view(self):
        p = models.TaskProject(id=gen_id(), name="HR", access_level="private", owner_email=BOSS["email"],
                               member_emails=[DEAN["email"]], member_roles={DEAN["email"]: "viewer"},
                               created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        viewed = self._add("Policy", project_id=p.id, access_level="private")
        with self.assertRaises(HTTPException) as e:
            self._patch(self.mine.id, user=DEAN, subtask_ids=[viewed.id])
        self.assertEqual(e.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            self._patch(self.mine.id, user=DEAN, parent_task_id=viewed.id)
        self.assertEqual(self._row(self.mine.id).parent_task_id, "")

    def test_cannot_pull_another_companys_task(self):
        import cache
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Dean", last_name="D", work_email=DEAN["email"],
                                         status="active", deleted_at="", company="co-a"))
        self.mine.company_id = "co-a"
        self.db.commit()
        cache.settings_config.invalidate()
        try:
            theirs = self._add("Beta work", company_id="co-b")
            with self.assertRaises(HTTPException) as e:
                self._patch(self.mine.id, user=DEAN, subtask_ids=[theirs.id])
            self.assertEqual(e.exception.status_code, 404)
            self.assertEqual(self._row(theirs.id).parent_task_id, "")
        finally:
            self.db.rollback()
            self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
            self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == DEAN["email"]).delete()
            self.db.commit()
            cache.settings_config.invalidate()

    def test_their_own_tasks_still_move(self):
        kid = self._add("Kid", assignee_emails=[DEAN["email"]], assignee_email=DEAN["email"])
        self._patch(self.mine.id, user=DEAN, subtask_ids=[kid.id])
        self.assertEqual(self._row(kid.id).parent_task_id, self.mine.id)


class PurgeAndRestoreTests(_Case):
    def test_purging_a_task_takes_its_whole_binned_subtree(self):
        from routers.tasks import delete_task_permanent
        top = self._add("Top")
        mid = self._add("Mid", parent_task_id=top.id)
        leaf = self._add("Leaf", parent_task_id=mid.id)
        for t, kids in ((top, [mid.id]), (mid, [leaf.id])):
            t.subtask_ids = kids
        self.db.commit()
        delete_task(top.id, BackgroundTasks(), user=BOSS, db=self.db)
        delete_task_permanent(top.id, user=BOSS, db=self.db)
        self.assertEqual(self.db.query(models.Task).execution_options(include_deleted=True).count(), 0)

    def test_purging_a_project_takes_its_subtasks_at_every_depth(self):
        from routers.task_projects import purge_from_recycle_bin
        p = self._project()
        top = self._add("Top", project_id=p.id)
        mid = self._add("Mid", parent_task_id=top.id)
        self._add("Leaf", parent_task_id=mid.id)
        delete_project(p.id, user=BOSS, db=self.db)
        purge_from_recycle_bin("project", p.id, user=BOSS, db=self.db)
        self.assertEqual(self.db.query(models.Task).execution_options(include_deleted=True).count(), 0)

    def test_a_live_task_under_a_purged_one_is_kept_as_top_level(self):
        from routers.tasks import delete_task_permanent
        top = self._add("Old parent", deleted_at=now_iso(), deleted_by=BOSS["email"])
        live = self._add("Restored long ago", parent_task_id=top.id)
        delete_task_permanent(top.id, user=BOSS, db=self.db)
        row = self._row(live.id)
        self.assertIsNotNone(row)
        self.assertEqual(row.parent_task_id, "")

    def test_a_subtask_cannot_come_back_under_a_binned_parent(self):
        top = self._add("Top")
        sub = self._add("Sub", parent_task_id=top.id)
        top.subtask_ids = [sub.id]
        self.db.commit()
        delete_task(sub.id, BackgroundTasks(), user=BOSS, db=self.db)
        delete_task(top.id, BackgroundTasks(), user=BOSS, db=self.db)
        with self.assertRaises(HTTPException) as e:
            restore_task(sub.id, user=BOSS, db=self.db)
        self.assertEqual(e.exception.status_code, 409)
        self.assertEqual(e.exception.detail, "Restore its parent task first - it is in the Recycle Bin.")
        with self.assertRaises(HTTPException):
            restore_from_recycle_bin("task", sub.id, user=BOSS, db=self.db)
        self.assertTrue(self._row(sub.id).deleted_at)
        restore_task(top.id, user=BOSS, db=self.db)
        restore_task(sub.id, user=BOSS, db=self.db)          # parent back: now it may
        self.assertEqual(self._row(sub.id).deleted_at, "")
        self.assertIn(sub.id, self._row(top.id).subtask_ids)


# ── 6. Delta drops what the caller can no longer see ─────────────────────────
class DeltaTests(_Case):
    def test_a_task_made_invisible_comes_back_as_deleted(self):
        t = self._add("Private", access_level="private", follower_emails=[DEAN["email"]])
        first = list_tasks_delta(since="", user=DEAN, db=self.db)
        self.assertIn(t.id, [x["id"] for x in first["tasks"]])
        time.sleep(0.01)
        row = self._row(t.id)
        row.follower_emails, row.modified_at = [], now_iso()
        self.db.commit()
        nxt = list_tasks_delta(since=first["serverTime"], user=DEAN, db=self.db)
        self.assertNotIn(t.id, [x["id"] for x in nxt["tasks"]])
        self.assertIn(t.id, nxt["deletedIds"])

    def test_a_task_binned_with_its_project_comes_back_as_deleted(self):
        p = self._project()
        t = self._add("In project", project_id=p.id)
        since = list_tasks_delta(since="", user=BOSS, db=self.db)["serverTime"]
        time.sleep(0.01)
        delete_project(p.id, user=BOSS, db=self.db)
        self.assertIn(t.id, list_tasks_delta(since=since, user=BOSS, db=self.db)["deletedIds"])

    def test_deleted_then_restored_in_one_window_is_live(self):
        t = self._add("Back again")
        since = list_tasks_delta(since="", user=BOSS, db=self.db)["serverTime"]
        time.sleep(0.01)
        delete_task(t.id, BackgroundTasks(), user=BOSS, db=self.db)
        restore_task(t.id, user=BOSS, db=self.db)
        res = list_tasks_delta(since=since, user=BOSS, db=self.db)
        self.assertIn(t.id, [x["id"] for x in res["tasks"]])
        self.assertNotIn(t.id, res["deletedIds"])

    def test_the_first_load_never_reports_deletions(self):
        self._add("Private", access_level="private")
        self.assertEqual(list_tasks_delta(since="", user=DEAN, db=self.db)["deletedIds"], [])


# ── 7. Export filename ───────────────────────────────────────────────────────
class ExportFilenameTests(_Case):
    def test_the_date_is_us_order(self):
        self._add("Anything")
        r = export_tasks_excel(today="2026-10-21", user=BOSS, db=self.db)
        disposition = r.headers["content-disposition"]
        self.assertIn('filename="10-21-2026 - Task Export.xlsx"', disposition)
        self.assertNotIn("2026-10-21", disposition)


if __name__ == "__main__":
    unittest.main(verbosity=2)
