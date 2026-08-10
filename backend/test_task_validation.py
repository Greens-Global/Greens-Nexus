"""
Validation regression tests for the task router.

Every case here was ACCEPTED and stored verbatim before (QA audit, Aug 2026).
Each had a real downstream effect, noted per test - these aren't tidiness
checks, so a future "relax this, it's annoying" change should have to argue
with the consequence rather than just the rule.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_validation -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException, BackgroundTasks

import database
import models
from routers.task_util import gen_id, now_iso
from routers.tasks import (
    create_task, update_task, bulk_update, validate_task_payload, task_activity,
    TaskCreate, TaskUpdate, BulkUpdate,
)

USER = {"email": "sagar@greensglobal.com", "level": 3}


class TaskValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskCustomStatus, models.TaskProject):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _task(self, **kw):
        t = models.Task(id=gen_id(), title="T", code="TASK-1", status="not_started",
                        priority="medium", created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _create(self, **kw):
        kw.setdefault("title", "New")
        return create_task(TaskCreate(**kw), BackgroundTasks(), user=USER, db=self.db)

    def _update(self, tid, **kw):
        return update_task(tid, TaskUpdate(**kw), BackgroundTasks(), user=USER, db=self.db)

    # ── status / priority ────────────────────────────────────────────────
    def test_unknown_status_is_rejected(self):
        """Board and list views GROUP by status - an unknown value creates a
        phantom column and misses every statusMeta lookup."""
        with self.assertRaises(HTTPException) as c:
            self._create(status="totally-not-a-status")
        self.assertEqual(c.exception.status_code, 422)

    def test_a_custom_status_id_is_accepted(self):
        """Validation must not break the workspace's own custom statuses."""
        s = models.TaskCustomStatus(id=gen_id(), label="Blocked", color="#f00", position=1)
        self.db.add(s)
        self.db.commit()
        out = self._create(status=s.id)
        self.assertEqual(out["status"], s.id)

    def test_every_builtin_status_is_accepted(self):
        for st in ("not_started", "in_progress", "completed", "recurring"):
            with self.subTest(status=st):
                self.assertEqual(self._create(status=st)["status"], st)

    def test_unknown_priority_is_rejected(self):
        with self.assertRaises(HTTPException) as c:
            self._create(priority="megaurgent")
        self.assertEqual(c.exception.status_code, 422)

    # ── dates ────────────────────────────────────────────────────────────
    def test_malformed_due_date_is_rejected(self):
        """The reminder scan parses due_on with date.fromisoformat inside a
        try/except that CONTINUES on failure, so a typo'd date silently
        disabled reminders for that task forever."""
        with self.assertRaises(HTTPException) as c:
            self._create(due_on="not-a-date")
        self.assertEqual(c.exception.status_code, 422)

    def test_malformed_start_date_is_rejected(self):
        with self.assertRaises(HTTPException):
            self._create(start_on="2026-13-45")

    def test_a_valid_date_and_a_blank_date_both_pass(self):
        self.assertEqual(self._create(due_on="2026-09-01")["dueOn"], "2026-09-01")
        self.assertIsNone(self._create(due_on="")["dueOn"])

    # ── numbers ──────────────────────────────────────────────────────────
    def test_negative_hours_are_rejected(self):
        """Workload sums estimate/actual per assignee; a negative silently
        REDUCES someone's apparent load."""
        for field in ("estimate_hours", "actual_hours"):
            with self.subTest(field=field):
                with self.assertRaises(HTTPException):
                    self._create(**{field: -5})

    def test_zero_and_positive_hours_are_fine(self):
        self.assertEqual(self._create(estimate_hours=0)["estimateHours"], 0)
        self.assertEqual(self._create(estimate_hours=3.5)["estimateHours"], 3.5)

    # ── title ────────────────────────────────────────────────────────────
    def test_blank_title_is_rejected(self):
        for bad in ("", "   "):
            with self.subTest(title=repr(bad)):
                with self.assertRaises(HTTPException):
                    self._create(title=bad)

    # ── normalization (not rejection - a UI slip shouldn't fail a save) ──
    def test_tags_are_deduped_and_stripped(self):
        out = self._create(tags=["dup", "DUP", "", "   ", " Keep "])
        self.assertEqual(out["tags"], ["dup", "Keep"])

    def test_collaborators_are_deduped_and_lowercased(self):
        out = self._create(follower_emails=["A@x.com", "a@x.com", "", "b@x.com"])
        self.assertEqual(out["followerIds"], ["a@x.com", "b@x.com"])

    # ── structural cycles ────────────────────────────────────────────────
    def test_a_task_cannot_be_its_own_parent(self):
        """topLevel() drops anything with a parentTaskId, and a self-parent
        never nests under anything either - the task vanishes from the UI."""
        t = self._task()
        with self.assertRaises(HTTPException) as c:
            self._update(t.id, parent_task_id=t.id)
        self.assertEqual(c.exception.status_code, 422)

    def test_a_circular_parent_chain_is_rejected(self):
        a, b = self._task(), self._task()
        self._update(b.id, parent_task_id=a.id)
        with self.assertRaises(HTTPException):
            self._update(a.id, parent_task_id=b.id)

    def test_a_legitimate_subtask_still_works(self):
        a, b = self._task(), self._task()
        out = self._update(b.id, parent_task_id=a.id)
        self.assertEqual(out["parentTaskId"], a.id)

    def test_a_task_cannot_block_itself(self):
        t = self._task()
        with self.assertRaises(HTTPException):
            self._update(t.id, blocked_by_ids=[t.id])

    def test_a_mutual_dependency_cycle_is_rejected(self):
        """_check_dependency_gate refuses completion while a blocker is open,
        so a cycle leaves BOTH tasks permanently uncompletable."""
        a, b = self._task(), self._task()
        self._update(a.id, blocked_by_ids=[b.id])
        with self.assertRaises(HTTPException) as c:
            self._update(b.id, blocked_by_ids=[a.id])
        self.assertEqual(c.exception.status_code, 422)

    def test_a_longer_dependency_cycle_is_rejected(self):
        a, b, c = self._task(), self._task(), self._task()
        self._update(a.id, blocked_by_ids=[b.id])
        self._update(b.id, blocked_by_ids=[c.id])
        with self.assertRaises(HTTPException):
            self._update(c.id, blocked_by_ids=[a.id])

    def test_a_legitimate_dependency_chain_still_works(self):
        a, b = self._task(), self._task()
        out = self._update(a.id, blocked_by_ids=[b.id])
        self.assertEqual(out["blockedByIds"], [b.id])

    def test_cycle_detection_terminates_on_already_cyclic_data(self):
        """Rows written before this validation existed can already be cyclic;
        the walk must not hang on them."""
        a, b = self._task(), self._task()
        a.blocked_by_ids = [b.id]
        b.blocked_by_ids = [a.id]      # pre-existing cycle, straight to the DB
        self.db.commit()
        c = self._task()
        with self.assertRaises(HTTPException):
            self._update(c.id, blocked_by_ids=[a.id, c.id])

    # ── bulk parity ──────────────────────────────────────────────────────
    def test_bulk_rejects_an_unknown_status(self):
        """Bulk was a way around update_task's validation."""
        t = self._task()
        with self.assertRaises(HTTPException) as c:
            bulk_update(BulkUpdate(ids=[t.id], patch={"status": "bogus"}), user=USER, db=self.db)
        self.assertEqual(c.exception.status_code, 422)
        self.db.rollback()
        self.assertEqual(self.db.get(models.Task, t.id).status, "not_started")

    def test_bulk_rejects_a_malformed_date(self):
        t = self._task()
        with self.assertRaises(HTTPException):
            bulk_update(BulkUpdate(ids=[t.id], patch={"due_on": "soon"}), user=USER, db=self.db)

    def test_bulk_still_applies_a_valid_patch(self):
        t = self._task()
        bulk_update(BulkUpdate(ids=[t.id], patch={"priority": "high"}), user=USER, db=self.db)
        self.assertEqual(self.db.get(models.Task, t.id).priority, "high")

    # ── existing bad data stays editable ─────────────────────────────────
    def test_a_task_holding_a_legacy_bad_value_can_still_be_patched(self):
        """Only fields PRESENT in the payload are validated, so a row written
        before this existed doesn't become uneditable."""
        t = self._task()
        t.status = "legacy-garbage"           # straight to the DB, bypassing the API
        self.db.commit()
        out = self._update(t.id, title="renamed anyway")
        self.assertEqual(out["title"], "renamed anyway")


class TaskActivityFeedTests(unittest.TestCase):
    """A task's own Activity tab shows what people did, not the sync's
    bookkeeping. "Created/Updated from Asana" is logged once per inbound apply
    and sits directly beside the real story it produced, so on one task's
    timeline it is pure duplication."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity):
            self.db.query(m).delete()
        self.t = models.Task(id=gen_id(), title="T", code="TASK-1", created_at=now_iso(),
                             modified_at=now_iso())
        self.db.add(self.t)
        for kind, actor, detail in (
                ("synced_from_asana", "asana-sync", "Updated from Asana"),
                ("asana_due_date_changed", "sagar@greensglobal.com", "changed the due date to Aug 22"),
                ("completed", "sagar@greensglobal.com", "completed this task")):
            self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=self.t.id,
                                            type=kind, actor_email=actor, at=now_iso(), detail=detail))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_the_sync_marker_is_hidden_from_a_tasks_own_activity(self):
        out = task_activity(self.t.id, db=self.db)

        self.assertNotIn("synced_from_asana", [a["type"] for a in out])

    def test_real_entries_are_untouched(self):
        details = [a["detail"] for a in task_activity(self.t.id, db=self.db)]

        self.assertIn("changed the due date to Aug 22", details)
        self.assertIn("completed this task", details)

    def test_the_marker_is_still_recorded_for_the_workspace_feed(self):
        """Hidden on the task, not deleted - the global feed still answers
        "where did this change come from"."""
        kept = self.db.query(models.TaskActivity).filter_by(type="synced_from_asana").count()

        self.assertEqual(kept, 1)


class CompletionCouplingTests(unittest.TestCase):
    """`status` and `completed` are one fact in two columns and must never
    disagree.

    Reported from the running app: a task sat under the Completed heading with
    its status chip reading "Completed", no strikethrough, an empty circle, and
    a drawer still offering "Mark complete". Two write paths allowed it -
    create_task hardcoded completed=False beside whatever status it was handed,
    and bulk_update wrote `status` through a plain setattr. Both are one click
    away in the UI: the "+ Add task..." row inherits its group's status, and the
    multi-select Status dropdown goes through bulk.

    It is not only cosmetic. task_notify's due scan filters on `completed`, so
    every one of these keeps being emailed as overdue after it is finished.
    """

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskCustomStatus, models.TaskProject):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _create(self, **kw):
        kw.setdefault("title", "New")
        return create_task(TaskCreate(**kw), BackgroundTasks(), user=USER, db=self.db)

    def _update(self, tid, **kw):
        return update_task(tid, TaskUpdate(**kw), BackgroundTasks(), user=USER, db=self.db)

    def _bulk(self, ids, patch):
        return bulk_update(BulkUpdate(ids=ids, patch=patch), user=USER, db=self.db)

    def test_creating_a_task_into_the_completed_group_marks_it_complete(self):
        out = self._create(title="TTTttt", status="completed")

        self.assertTrue(out["completed"], "no strikethrough, and it keeps emailing as overdue")
        self.assertTrue(out["completedAt"])

    def test_creating_an_ordinary_task_is_unchanged(self):
        out = self._create(title="Normal", status="in_progress")

        self.assertFalse(out["completed"])
        self.assertFalse(out["completedAt"])   # _nz serialises "" as None

    def test_bulk_setting_status_completed_sets_the_flag(self):
        a = self._create(title="A")
        b = self._create(title="B")

        rows = self._bulk([a["id"], b["id"]], {"status": "completed"})

        for r in rows:
            self.assertTrue(r["completed"], "bulk left the flag off, so the row showed as open")
            self.assertTrue(r["completedAt"])

    def test_bulk_reopening_clears_the_flag(self):
        a = self._create(title="A")
        self._update(a["id"], completed=True)

        rows = self._bulk([a["id"]], {"status": "in_progress"})

        self.assertFalse(rows[0]["completed"], "a reopened task stayed parked in Completed")
        self.assertFalse(rows[0]["completedAt"])

    def test_bulk_completed_flag_still_drags_status_with_it(self):
        a = self._create(title="A", status="in_progress")

        rows = self._bulk([a["id"]], {"completed": True})

        self.assertEqual(rows[0]["status"], "completed")

    def test_the_two_columns_agree_however_completion_is_reached(self):
        """create, PATCH status, PATCH completed, bulk status, bulk completed."""
        for label, make in (
                ("create", lambda: self._create(title="c", status="completed")),
                ("patch status", lambda: self._update(self._create(title="p1")["id"], status="completed")),
                ("patch flag", lambda: self._update(self._create(title="p2")["id"], completed=True)),
                ("bulk status", lambda: self._bulk([self._create(title="b1")["id"]], {"status": "completed"})[0]),
                ("bulk flag", lambda: self._bulk([self._create(title="b2")["id"]], {"completed": True})[0])):
            with self.subTest(path=label):
                out = make()
                self.assertEqual((out["status"], out["completed"]), ("completed", True))


class ReciprocalDependencyTests(unittest.TestCase):
    """blocked_by_ids and blocking_ids are two ends of one edge.

    The reverse end used to be written by the browser, as a second request
    right after the first (TaskDetailDrawer's addDep/removeDep). Every other
    route to the same edge - the bulk endpoint, a script, or that second call
    simply failing - left the graph one-sided, so the drawer's "Blocking" panel
    under-reported. These pin the server owning both ends in one transaction.
    """

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskCustomStatus, models.TaskProject):
            self.db.query(m).delete()
        self.db.commit()
        self.a = self._task("A")
        self.b = self._task("B")

    def tearDown(self):
        self.db.close()

    def _task(self, title):
        t = models.Task(id=gen_id(), title=title, code=f"TASK-{title}", status="not_started",
                        priority="medium", created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    def _update(self, tid, **kw):
        return update_task(tid, TaskUpdate(**kw), BackgroundTasks(), user=USER, db=self.db)

    def _reload(self, t):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == t.id).first()

    def test_setting_blocked_by_points_the_blocker_back(self):
        self._update(self.a.id, blocked_by_ids=[self.b.id], dependency_types={self.b.id: "FS"})

        self.assertEqual(self._reload(self.b).blocking_ids, [self.a.id])

    def test_clearing_blocked_by_removes_the_reverse_pointer(self):
        self._update(self.a.id, blocked_by_ids=[self.b.id])
        self._update(self.a.id, blocked_by_ids=[])

        self.assertEqual(self._reload(self.b).blocking_ids, [])

    def test_setting_blocking_points_the_blocked_task_back(self):
        """Symmetric: the drawer can write either end, and either must mirror."""
        self._update(self.a.id, blocking_ids=[self.b.id])

        self.assertEqual(self._reload(self.b).blocked_by_ids, [self.a.id])

    def test_the_clients_redundant_second_call_is_idempotent(self):
        """The drawer still makes its own reverse call. It must not double up."""
        self._update(self.a.id, blocked_by_ids=[self.b.id])
        self._update(self.b.id, blocking_ids=[self.a.id])

        self.assertEqual(self._reload(self.b).blocking_ids, [self.a.id])
        self.assertEqual(self._reload(self.a).blocked_by_ids, [self.b.id])

    def test_swapping_a_dependency_detaches_the_old_blocker(self):
        c = self._task("C")
        self._update(self.a.id, blocked_by_ids=[self.b.id])
        self._update(self.a.id, blocked_by_ids=[c.id])

        self.assertEqual(self._reload(self.b).blocking_ids, [])
        self.assertEqual(self._reload(c).blocking_ids, [self.a.id])

    def test_an_unrelated_edit_leaves_the_graph_alone(self):
        self._update(self.a.id, blocked_by_ids=[self.b.id])
        before = self._reload(self.b).modified_at
        self._update(self.a.id, title="renamed, nothing to do with dependencies")

        self.assertEqual(self._reload(self.b).blocking_ids, [self.a.id])
        self.assertEqual(self._reload(self.b).modified_at, before)


class ValidatePayloadUnitTests(unittest.TestCase):
    """validate_task_payload in isolation - no task_id, so the structural
    checks are skipped and only field-level rules apply (the bulk_update case)."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()

    def test_absent_fields_are_not_invented(self):
        data = {"title": "ok"}
        self.assertEqual(validate_task_payload(self.db, data), {"title": "ok"})

    def test_none_values_do_not_trip_the_enum_checks(self):
        validate_task_payload(self.db, {"status": None, "priority": None})


if __name__ == "__main__":
    unittest.main()
