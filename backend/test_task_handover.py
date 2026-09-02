"""
Unit tests for routers.task_projects.handover_person - the task side of HR
offboarding (routers/hr.py change_status), mirroring items.force_return_person.

Uses a throwaway sqlite file so it never touches the real dev DB
(greens_nexus.db) or Supabase. No network needed.

Run with: python -m unittest test_task_handover -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.task_util import gen_id, now_iso
from routers.task_projects import (handover_person, resolve_handover_target,
                                   HANDOVER_FALLBACK_EMAIL)

LEAVER = "leaver@greensglobal.com"
KEEPER = "keeper@greensglobal.com"
BOSS = "boss@greensglobal.com"


class HandoverPersonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskProject, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="e1", first_name="Dana", last_name="Reed",
                                         work_email=LEAVER, status="offboarded"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _task(self, **kw):
        kw.setdefault("assignee_email", LEAVER)
        kw.setdefault("project_id", "")
        kw.setdefault("parent_task_id", "")
        kw.setdefault("created_at", now_iso())
        t = models.Task(id=gen_id(), title=kw.pop("title", "A task"), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _project(self, pid, **kw):
        kw.setdefault("owner_email", LEAVER)
        p = models.TaskProject(id=pid, name=f"Project {pid}", **kw)
        self.db.add(p)
        self.db.commit()
        return p

    # ── reassignment ────────────────────────────────────────────────────────
    def test_open_tasks_are_reassigned(self):
        t = self._task()

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(out["reassigned"], 1)
        self.assertEqual(self.db.get(models.Task, t.id).assignee_email, KEEPER)

    def test_completed_tasks_are_skipped_by_default(self):
        done = self._task(title="Done", completed=True)

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(out["reassigned"], 0)
        self.assertEqual(self.db.get(models.Task, done.id).assignee_email, LEAVER)

    def test_completed_tasks_are_included_when_asked(self):
        done = self._task(title="Done", completed=True)

        out = handover_person(self.db, LEAVER, KEEPER, include_completed=True)
        self.db.commit()

        self.assertEqual(out["reassigned"], 1)
        self.assertEqual(self.db.get(models.Task, done.id).assignee_email, KEEPER)

    def test_other_peoples_tasks_are_untouched(self):
        mine = self._task(assignee_email="someone@greensglobal.com")

        handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(self.db.get(models.Task, mine.id).assignee_email, "someone@greensglobal.com")

    # ── the handover project ────────────────────────────────────────────────
    def test_project_less_tasks_are_collected_into_a_handover_project(self):
        homeless = self._task(title="My Tasks item")

        out = handover_person(self.db, LEAVER, KEEPER, actor="hr@greensglobal.com")
        self.db.commit()

        project = self.db.get(models.TaskProject, out["projectId"])
        self.assertIsNotNone(project)
        self.assertEqual(project.owner_email, KEEPER)
        self.assertIn(KEEPER, project.member_emails)
        self.assertIn("Dana Reed", project.name)       # named from the People record
        self.assertEqual(out["moved"], 1)
        self.assertEqual(self.db.get(models.Task, homeless.id).project_id, project.id)

    def test_tasks_already_in_a_project_stay_there_and_are_linked_in(self):
        """Moving these would strip a live project of the work its team is still
        running - so the task keeps its project and GAINS the handover one as an
        extra (Sagar, Sept 2 2026). One row in both places, so an edit made from
        either view is the same edit."""
        self._project("proj-live", owner_email="lead@greensglobal.com")
        filed = self._task(title="Real work", project_id="proj-live")

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        row = self.db.get(models.Task, filed.id)
        self.assertEqual(row.project_id, "proj-live")       # still on its own board
        self.assertIn(out["projectId"], row.project_ids)    # ...and listed in the handover
        self.assertEqual(row.assignee_email, KEEPER)
        self.assertEqual(out["moved"], 0)
        self.assertEqual(out["linked"], 1)

    def test_a_moved_task_is_not_also_linked(self):
        """A homeless task IS the handover project's now - listing it twice would
        double-count it."""
        self._task(title="My Tasks item")

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(out["moved"], 1)
        self.assertEqual(out["linked"], 0)
        row = self.db.query(models.Task).filter(models.Task.title == "My Tasks item").first()
        self.assertEqual(row.project_id, out["projectId"])
        self.assertEqual(row.project_ids or [], [])

    def test_linking_keeps_any_extra_projects_the_task_already_had(self):
        self._project("proj-live", owner_email="lead@greensglobal.com")
        filed = self._task(title="Real work", project_id="proj-live",
                           project_ids=["proj-extra"])

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        row = self.db.get(models.Task, filed.id)
        self.assertEqual(row.project_ids, ["proj-extra", out["projectId"]])

    def test_handover_project_exists_even_with_nothing_homeless(self):
        """It still holds the clear-up task - see the clear-up tests below."""
        self._project("proj-live", owner_email="lead@greensglobal.com")
        self._task(project_id="proj-live")

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertNotEqual(out["projectId"], "")
        self.assertEqual(out["moved"], 0)   # the filed task stayed where it was

    def test_nothing_to_hand_over_creates_nothing(self):
        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(out["projectId"], "")
        self.assertEqual(out["taskId"], "")
        self.assertEqual(self.db.query(models.TaskProject).count(), 0)
        self.assertEqual(self.db.query(models.Task).count(), 0)

    # ── the project's name and the clear-up task ────────────────────────────
    def test_project_is_named_after_the_person_who_left(self):
        self._task()

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        project = self.db.get(models.TaskProject, out["projectId"])
        self.assertEqual(project.name, "Dana Reed's previously assigned Tasks")

    def test_a_clear_up_task_lands_on_the_person_who_inherited_the_work(self):
        """The handover has to reach someone's list, not just sit in a project
        nobody was told about."""
        self._task()

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        review = self.db.get(models.Task, out["taskId"])
        self.assertIsNotNone(review)
        self.assertEqual(review.assignee_email, KEEPER)
        self.assertEqual(review.assignee_emails, [KEEPER])
        self.assertEqual(review.project_id, out["projectId"])
        self.assertIn("Dana Reed", review.title)
        self.assertFalse(review.completed)
        self.assertTrue(review.due_on)          # dated, so it can't sit forever

    def test_the_clear_up_task_is_not_itself_handed_over(self):
        """It is created after the sweep, so it must not be counted as one of
        the departing person's reassigned tasks."""
        self._task()

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(out["reassigned"], 1)

    def test_subtasks_are_reassigned_but_never_moved(self):
        """A subtask carries project_id='' and reaches its project through its
        parent - relocating one on its own would detach it."""
        parent = self._task(title="Parent", project_id="proj-live")
        sub = self._task(title="Sub", parent_task_id=parent.id)

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(self.db.get(models.Task, sub.id).assignee_email, KEEPER)
        self.assertEqual(self.db.get(models.Task, sub.id).project_id, "")
        # ...but it IS linked, which is what makes a subtask under someone
        # else's parent still show up in the handover list.
        self.assertIn(out["projectId"], self.db.get(models.Task, sub.id).project_ids)
        self.assertEqual(out["moved"], 0)

    # ── owned projects ──────────────────────────────────────────────────────
    def test_owned_projects_transfer_so_none_is_left_ownerless(self):
        self._project("proj-mine")

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        p = self.db.get(models.TaskProject, "proj-mine")
        self.assertEqual(out["projectsTransferred"], 1)
        self.assertEqual(p.owner_email, KEEPER)
        self.assertIn(KEEPER, p.member_emails)
        self.assertEqual((p.member_roles or {}).get(KEEPER), "owner")

    def test_owned_projects_transfer_even_with_no_tasks_at_all(self):
        self._project("proj-mine")

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(out["reassigned"], 0)
        self.assertEqual(out["projectsTransferred"], 1)

    # ── guards ──────────────────────────────────────────────────────────────
    def test_missing_or_self_targeted_handover_is_a_noop(self):
        t = self._task()

        for a, b in ((LEAVER, ""), ("", KEEPER), (LEAVER, LEAVER)):
            out = handover_person(self.db, a, b)
            self.assertEqual(out, {"reassigned": 0, "moved": 0, "linked": 0,
                                   "projectsTransferred": 0, "projectId": "",
                                   "taskId": "", "toEmail": ""})
        self.assertEqual(self.db.get(models.Task, t.id).assignee_email, LEAVER)
        self.assertEqual(self.db.query(models.TaskProject).count(), 0)


class ResolveHandoverTargetTests(unittest.TestCase):
    """Who inherits the work when the offboarding form's picker is left blank.
    Blank means "you pick", not "skip" - skipping used to leave the tasks on an
    account that no longer signs in."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.NexusEmployee).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _emp(self, email, status="active", manager_email="", eid=None):
        self.db.add(models.NexusEmployee(id=eid or gen_id(), first_name="X", last_name="Y",
                                         work_email=email, status=status,
                                         manager_email=manager_email))
        self.db.commit()

    def test_the_named_person_wins(self):
        self._emp(LEAVER, status="offboarded", manager_email=BOSS)
        self._emp(BOSS)
        self._emp(KEEPER)
        self.assertEqual(resolve_handover_target(self.db, LEAVER, KEEPER), KEEPER)

    def test_blank_falls_back_to_the_supervisor(self):
        self._emp(LEAVER, status="offboarded", manager_email=BOSS)
        self._emp(BOSS)
        self.assertEqual(resolve_handover_target(self.db, LEAVER, ""), BOSS)

    def test_no_supervisor_falls_back_to_the_workspace_owner(self):
        self._emp(LEAVER, status="offboarded")
        self.assertEqual(resolve_handover_target(self.db, LEAVER, ""), HANDOVER_FALLBACK_EMAIL)

    def test_an_offboarded_supervisor_is_skipped(self):
        """A whole team leaving must not chain the work onto another dead
        account."""
        self._emp(LEAVER, status="offboarded", manager_email=BOSS)
        self._emp(BOSS, status="offboarded")
        self.assertEqual(resolve_handover_target(self.db, LEAVER, ""), HANDOVER_FALLBACK_EMAIL)

    def test_a_person_is_never_handed_their_own_work(self):
        self._emp(LEAVER, status="offboarded", manager_email=LEAVER)
        self.assertEqual(resolve_handover_target(self.db, LEAVER, LEAVER), HANDOVER_FALLBACK_EMAIL)


if __name__ == "__main__":
    unittest.main()
