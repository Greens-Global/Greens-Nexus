"""
Unit tests for routers.task_projects.handover_person — the task side of HR
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
from routers.task_projects import handover_person

LEAVER = "leaver@greensglobal.com"
KEEPER = "keeper@greensglobal.com"


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

    def test_tasks_already_in_a_project_stay_there(self):
        """The whole point of the project-less filter: moving these would strip a
        live project of the work its team is still running."""
        self._project("proj-live", owner_email="lead@greensglobal.com")
        filed = self._task(title="Real work", project_id="proj-live")

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(self.db.get(models.Task, filed.id).project_id, "proj-live")
        self.assertEqual(self.db.get(models.Task, filed.id).assignee_email, KEEPER)
        self.assertEqual(out["moved"], 0)

    def test_no_handover_project_is_created_when_nothing_is_homeless(self):
        self._project("proj-live", owner_email="lead@greensglobal.com")
        self._task(project_id="proj-live")

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(out["projectId"], "")
        self.assertEqual(self.db.query(models.TaskProject).count(), 1)

    def test_subtasks_are_reassigned_but_never_moved(self):
        """A subtask carries project_id='' and reaches its project through its
        parent — relocating one on its own would detach it."""
        parent = self._task(title="Parent", project_id="proj-live")
        sub = self._task(title="Sub", parent_task_id=parent.id)

        out = handover_person(self.db, LEAVER, KEEPER)
        self.db.commit()

        self.assertEqual(self.db.get(models.Task, sub.id).assignee_email, KEEPER)
        self.assertEqual(self.db.get(models.Task, sub.id).project_id, "")
        self.assertEqual(out["moved"], 0)
        self.assertEqual(out["projectId"], "")

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
            self.assertEqual(out, {"reassigned": 0, "moved": 0,
                                   "projectsTransferred": 0, "projectId": ""})
        self.assertEqual(self.db.get(models.Task, t.id).assignee_email, LEAVER)
        self.assertEqual(self.db.query(models.TaskProject).count(), 0)


if __name__ == "__main__":
    unittest.main()
