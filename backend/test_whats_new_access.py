"""What's New writes by tier (Neil, Oct 12 2026; server-side since 11/12/2026).

  - anyone with a Tasks or Tickets grant may SUBMIT an entry: it lands as
    Pending Review whatever status the body says, and nobody is belled;
  - only the Manager tier (level 3+) edits, deletes or publishes;
  - a manager may create an entry as Released, edit it and delete it.

    python -m pytest test_whats_new_access.py
"""
import os
import tempfile
import unittest

# A throwaway sqlite of its own (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EMP = "wn.emp@greensglobal.com"        # employee with a Tasks grant
MGR = "wn.mgr@greensglobal.com"        # manager (level 3) with the same grant
FOLLOWER = "wn.follow@greensglobal.com"  # follows the Tasks module
GROUP = "grp-wn-tasks"
RELEASED = {"title": "Faster Boards", "module": "Tasks", "type": "Improvement", "status": "Released"}


class WhatsNewAccessTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        try:
            for m in (models.NexusEmployee, models.NexusRole, models.NexusGroup, models.NexusGroupMember,
                      models.TaskChangelogEntry, models.ChangelogEntryHistory, models.ChangelogSubscription,
                      models.NexusNotification):
                db.query(m).execution_options(include_deleted=True).delete(synchronize_session=False)
            for em, role in ((EMP, "employee"), (MGR, "manager"), (FOLLOWER, "employee")):
                db.add(models.NexusEmployee(id=f"e-{em}", first_name="Test", last_name="Person", work_email=em,
                                            status="active", deleted_at=""))
                db.add(models.NexusRole(email=em, role=role))
            db.add(models.NexusGroup(id=GROUP, name="WN Tasks", allowed_modules="tasks:editor"))
            for em in (EMP, MGR):
                db.add(models.NexusGroupMember(group_id=GROUP, email=em))
            db.add(models.ChangelogSubscription(email=FOLLOWER, modules=["tasks"], categories=[]))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client

    def _bells(self):
        db = database.SessionLocal()
        try:
            return db.query(models.NexusNotification).count()
        finally:
            db.close()

    def test_employee_submission_lands_pending_and_bells_nobody(self):
        r = self._as(EMP).post("/task-changelog", json={"payload": RELEASED})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["status"], "Pending Review")
        self.assertEqual(self._bells(), 0)

    def test_employee_cannot_edit_or_delete(self):
        r = self._as(MGR).post("/task-changelog", json={"payload": RELEASED})
        eid = r.json()["id"]
        r = self._as(EMP).patch(f"/task-changelog/{eid}", json={"payload": {**RELEASED, "title": "Mine"}})
        self.assertIn(r.status_code, (401, 403), r.text)
        r = self._as(EMP).delete(f"/task-changelog/{eid}")
        self.assertIn(r.status_code, (401, 403), r.text)
        db = database.SessionLocal()
        try:
            self.assertEqual(db.get(models.TaskChangelogEntry, eid).payload["title"], "Faster Boards")
        finally:
            db.close()

    def test_manager_creates_released_edits_and_deletes(self):
        r = self._as(MGR).post("/task-changelog", json={"payload": RELEASED})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(r.json()["status"], "Released")
        self.assertEqual(self._bells(), 1)       # the follower was told
        eid = r.json()["id"]
        r = self._as(MGR).patch(f"/task-changelog/{eid}", json={"payload": {**RELEASED, "title": "Faster Boards 2"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["title"], "Faster Boards 2")
        r = self._as(MGR).delete(f"/task-changelog/{eid}")
        self.assertEqual(r.status_code, 204, r.text)


if __name__ == "__main__":
    unittest.main()
