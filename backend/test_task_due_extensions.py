"""Due-date accountability (Neil, Sep 24) - task_due.py.

Worth pinning: what counts as an extension (only a LATER date replacing an
AGREED one - never the first date, an earlier date, a cleared date, or a
target the assignee never confirmed), that every write path logs the move, the
requester/assignee negotiation, the manager bell on the 3rd extension, and the
per-person record.

Run with: python -m unittest test_task_due_extensions -v
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import database
import models
import task_due
from routers import tasks as tasks_router
from routers.task_util import gen_id
from routers.tasks import (create_task, update_task, bulk_update, confirm_due, propose_due, respond_due,
                           TaskCreate, TaskUpdate, BulkUpdate, DueProposal, DueAnswer)


def _assert_isolated():
    # Same guard as test_task_start_date: these setUp() deletes must never land
    # in a developer's real database.
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}. "
                           f"Run it on its own: python -m unittest {__name__}")


_assert_isolated()

BOSS = {"email": "boss@greensglobal.com", "level": 1}
SAGAR = {"email": "sagar@greensglobal.com", "level": 1}
MANAGER = {"email": "neil@greensglobal.com", "level": 3}


class DueCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskNotification,
                  models.NexusNotification, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id=gen_id(), work_email=SAGAR["email"], first_name="Sagar",
                                         manager_email=MANAGER["email"]))
        self.db.commit()
        self._push = tasks_router._asana_push
        tasks_router._asana_push = lambda *a, **kw: None

    def tearDown(self):
        tasks_router._asana_push = self._push
        self.db.close()

    def _create(self, user=BOSS, **fields):
        fields.setdefault("title", "Finish Nexus Sign")
        fields.setdefault("assignee_emails", [SAGAR["email"]])
        d = create_task(TaskCreate(**fields), BackgroundTasks(), user=user, db=self.db)
        return self.db.get(models.Task, d["id"])

    def _patch(self, t, user=SAGAR, **fields):
        update_task(t.id, TaskUpdate(**fields), BackgroundTasks(), user=user, db=self.db)
        self.db.refresh(t)
        return t


class ExtensionCountTests(DueCase):
    def test_target_set_for_someone_else_is_pending(self):
        t = self._create(due_on="2026-09-25")
        self.assertEqual(t.due_agreement, "pending")
        self.assertEqual(len(t.due_history), 1)
        self.assertEqual(t.due_extension_count, 0)

    def test_own_date_is_agreed(self):
        t = self._create(user=SAGAR, due_on="2026-09-25")
        self.assertEqual(t.due_agreement, "accepted")

    def test_pushing_an_agreed_date_later_counts(self):
        t = self._create(user=SAGAR, due_on="2026-09-25")
        self._patch(t, due_on="2026-09-29")
        self._patch(t, due_on="2026-10-02")
        self.assertEqual(t.due_extension_count, 2)
        self.assertEqual([h["extension"] for h in t.due_history], [False, True, True])
        self.assertEqual(t.due_history[-1]["by"], SAGAR["email"])

    def test_earlier_first_or_cleared_dates_do_not_count(self):
        t = self._create(user=SAGAR)
        self._patch(t, due_on="2026-09-25")       # first date
        self._patch(t, due_on="2026-09-23")       # earlier
        self._patch(t, due_on="")                 # cleared
        self._patch(t, due_on="2026-10-01")       # set again
        self.assertEqual(t.due_extension_count, 0)
        self.assertEqual(len(t.due_history), 4)

    def test_unchanged_date_logs_nothing(self):
        t = self._create(user=SAGAR, due_on="2026-09-25")
        self._patch(t, due_on="2026-09-25", title="Renamed")
        self.assertEqual(len(t.due_history), 1)

    def test_renegotiating_an_unconfirmed_target_is_not_an_extension(self):
        t = self._create(due_on="2026-09-25")     # pending for Sagar
        self._patch(t, user=BOSS, due_on="2026-09-30")
        self.assertEqual(t.due_extension_count, 0)
        self.assertEqual(t.due_agreement, "pending")

    def test_requester_moving_an_agreed_date_counts_and_needs_reconfirming(self):
        t = self._create(user=SAGAR, due_on="2026-09-25")
        self._patch(t, user=BOSS, due_on="2026-09-30")
        self.assertEqual(t.due_extension_count, 1)
        self.assertEqual(t.due_agreement, "pending")

    def test_move_is_on_the_activity_timeline(self):
        t = self._create(user=SAGAR, due_on="2026-09-25")
        self._patch(t, due_on="2026-09-29")
        acts = self.db.query(models.TaskActivity).filter(models.TaskActivity.type == "due_changed").all()
        self.assertEqual(len(acts), 1)
        self.assertIn("09/25/2026 to 09/29/2026", acts[0].detail)
        self.assertIn(acts[0].id, t.activity_ids)

    def test_bulk_edits_are_counted_too(self):
        t = self._create(user=SAGAR, due_on="2026-09-25")
        bulk_update(BulkUpdate(ids=[t.id], patch={"due_on": "2026-09-28"}), user=SAGAR, db=self.db)
        self.db.refresh(t)
        self.assertEqual(t.due_extension_count, 1)
        self.assertEqual(t.due_history[-1]["source"], "bulk")

    def test_requester_is_belled_when_the_date_moves(self):
        t = self._create(user=BOSS, due_on="2026-09-25")
        self.db.query(models.TaskNotification).delete()
        self.db.commit()
        self._patch(t, due_on="2026-09-29")
        n = self.db.query(models.TaskNotification).filter(
            models.TaskNotification.for_email == BOSS["email"]).all()
        self.assertEqual([x.kind for x in n], ["task_due_changed"])

    def test_manager_is_belled_on_the_third_extension_only(self):
        t = self._create(user=SAGAR, due_on="2026-09-20")
        for d in ("2026-09-21", "2026-09-22"):
            self._patch(t, due_on=d)
        mgr = lambda: self.db.query(models.TaskNotification).filter(  # noqa: E731
            models.TaskNotification.for_email == MANAGER["email"]).count()
        self.assertEqual(mgr(), 0)
        self._patch(t, due_on="2026-09-23")
        self.assertEqual(mgr(), 1)
        self._patch(t, due_on="2026-09-24")
        self.assertEqual(mgr(), 1)


class NegotiationTests(DueCase):
    def test_assignee_confirms(self):
        t = self._create(due_on="2026-09-25")
        confirm_due(t.id, user=SAGAR, db=self.db)
        self.db.refresh(t)
        self.assertEqual(t.due_agreement, "accepted")

    def test_only_the_assignee_can_confirm(self):
        t = self._create(due_on="2026-09-25")
        with self.assertRaises(HTTPException) as e:
            confirm_due(t.id, user=BOSS, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    def test_accepted_proposal_moves_the_date_without_counting(self):
        t = self._create(due_on="2026-09-25")
        propose_due(DueProposal(due_on="2026-10-02", note="Blocked on legal"), t.id, user=SAGAR, db=self.db)
        self.db.refresh(t)
        self.assertEqual(t.due_agreement, "proposed")
        respond_due(DueAnswer(accept=True), t.id, user=BOSS, db=self.db)
        self.db.refresh(t)
        self.assertEqual((t.due_on, t.due_agreement, t.due_extension_count), ("2026-10-02", "accepted", 0))
        self.assertEqual(t.due_history[-1]["source"], "proposal")

    def test_declined_proposal_keeps_the_date_pending(self):
        t = self._create(due_on="2026-09-25")
        propose_due(DueProposal(due_on="2026-10-02"), t.id, user=SAGAR, db=self.db)
        respond_due(DueAnswer(accept=False, note="Friday please"), t.id, user=BOSS, db=self.db)
        self.db.refresh(t)
        self.assertEqual((t.due_on, t.due_agreement, t.due_proposal), ("2026-09-25", "pending", None))

    def test_requester_can_suggest_a_third_date(self):
        t = self._create(due_on="2026-09-25")
        propose_due(DueProposal(due_on="2026-10-02"), t.id, user=SAGAR, db=self.db)
        respond_due(DueAnswer(counter_on="2026-09-29", note="Tuesday works"), t.id, user=BOSS, db=self.db)
        self.db.refresh(t)
        # The new target goes back to the assignee - and it is not an extension.
        self.assertEqual((t.due_on, t.due_agreement, t.due_proposal, t.due_extension_count),
                         ("2026-09-29", "pending", None, 0))
        self.assertEqual(t.due_history[-1]["source"], "counter")
        confirm_due(t.id, user=SAGAR, db=self.db)

    def test_a_counter_must_be_a_new_date(self):
        t = self._create(due_on="2026-09-25")
        propose_due(DueProposal(due_on="2026-10-02"), t.id, user=SAGAR, db=self.db)
        with self.assertRaises(HTTPException) as e:
            respond_due(DueAnswer(counter_on="2026-10-02"), t.id, user=BOSS, db=self.db)
        self.assertEqual(e.exception.status_code, 422)

    def test_a_bystander_cannot_answer(self):
        t = self._create(due_on="2026-09-25")
        propose_due(DueProposal(due_on="2026-10-02"), t.id, user=SAGAR, db=self.db)
        with self.assertRaises(HTTPException) as e:
            respond_due(DueAnswer(accept=True), t.id, user={"email": "x@greensglobal.com", "level": 1}, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        respond_due(DueAnswer(accept=True), t.id, user=MANAGER, db=self.db)   # a manager can

    def test_agreed_dates_cannot_be_proposed_around(self):
        # Proposing is for an unconfirmed target; once agreed, moving it counts.
        t = self._create(user=SAGAR, due_on="2026-09-25")
        with self.assertRaises(HTTPException) as e:
            propose_due(DueProposal(due_on="2026-10-02"), t.id, user=SAGAR, db=self.db)
        self.assertEqual(e.exception.status_code, 409)

    def test_reassigning_asks_the_new_holder(self):
        t = self._create(user=SAGAR, due_on="2026-09-25")
        self._patch(t, user=BOSS, assignee_emails=["other@greensglobal.com"])
        self.assertEqual(t.due_agreement, "pending")


class PersonRecordTests(unittest.TestCase):
    def _t(self, **kw):
        base = dict(id=gen_id(), title="x", assignee_emails=["p@x.com"], completed=False, completed_at="",
                    due_on="", due_extension_count=0, due_history=[], due_agreement="")
        base.update(kw)
        return models.Task(**base)

    def test_record(self):
        today = date(2026, 9, 24)
        tasks = [
            self._t(completed=True, completed_at="2026-09-10T10:00:00", due_on="2026-09-12"),   # on time
            self._t(completed=True, completed_at="2026-09-15T10:00:00", due_on="2026-09-12"),   # late
            self._t(due_on="2026-09-20", due_extension_count=3,
                    due_history=[{"extension": True, "by": "p@x.com"}] * 3),                     # stale + overdue
            self._t(completed=True, completed_at="2026-01-01T00:00:00", due_on="2025-12-01"),   # outside window
            self._t(assignee_emails=["someone@x.com"], due_on="2026-09-01"),                    # not theirs
        ]
        r = task_due.person_record(tasks, "p@x.com", today=today)
        self.assertEqual((r["completedWithDueDate"], r["completedLate"], r["onTimePct"]), (2, 1, 50))
        self.assertEqual((r["openOverdue"], r["totalExtensions"], r["selfExtensions"]), (1, 3, 3))
        self.assertEqual(r["flags"], ["1 open task extended 3+ times"])


if __name__ == "__main__":
    unittest.main()
