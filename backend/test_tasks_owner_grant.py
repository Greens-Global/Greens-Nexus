"""
An Owner grant on Tasks makes its holder a manager inside the Task module
(Oct 15 2026): Urmi held Tasks at Owner through an Access Group and still had
no Manage button, because every Task-module manager check read the global
role only. auth.module_owner_acts_as raises the request's level on the Task
routers; auth.level_in_module answers the same question about someone else.

Neither reaches outside the module, and an external account never rises.

Uses a throwaway sqlite file. No network.
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

import auth
import cache
import database
import models
from routers import tasks as T, task_config as TC, task_projects as TP

OWNER  = "owner@greensglobal.com"    # Tasks at Owner through a group
EDITOR = "editor@greensglobal.com"   # Tasks at Editor
GUEST  = "guest@partner.com"         # external account, Tasks at Owner


class TasksOwnerGrantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusGroup, models.NexusGroupMember, models.NexusEmployee, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.NexusGroup(id="g1", name="Task Owners", allowed_modules="tasks:owner,tickets:viewer"))
        self.db.add(models.NexusGroup(id="g2", name="Task Editors", allowed_modules="tasks:editor"))
        self.db.add(models.NexusGroupMember(group_id="g1", email=OWNER))
        self.db.add(models.NexusGroupMember(group_id="g1", email=GUEST))
        self.db.add(models.NexusGroupMember(group_id="g2", email=EDITOR))
        self.db.add(models.NexusEmployee(id="e1", work_email=GUEST, first_name="Gus", last_name="Guest",
                                         identity_type="external", status="active"))
        self.db.commit()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        auth.invalidate_external_cache()

    def tearDown(self):
        self.db.close()

    def _lift(self, user, module="tasks"):
        return auth.module_owner_acts_as(module, 3)(user=user, db=self.db)

    # ── the request's own caller ─────────────────────────────────────────────
    def test_a_tasks_owner_is_a_manager_in_the_module(self):
        self.assertEqual(self._lift({"email": OWNER, "level": 1})["level"], 3)

    def test_an_editor_grant_changes_nothing(self):
        self.assertEqual(self._lift({"email": EDITOR, "level": 1})["level"], 1)

    def test_a_higher_role_is_never_lowered(self):
        self.assertEqual(self._lift({"email": OWNER, "level": 5})["level"], 5)

    def test_the_grant_only_counts_for_its_own_module(self):
        self.assertEqual(self._lift({"email": OWNER, "level": 1}, module="tickets")["level"], 1)

    def test_an_external_account_stays_an_employee(self):
        self.assertEqual(self._lift({"email": GUEST, "level": 1, "external": True})["level"], 1)

    # ── someone else, by address ─────────────────────────────────────────────
    def test_level_in_module_by_address(self):
        self.assertEqual(auth.level_in_module(OWNER, "tasks", 3, self.db), 3)
        self.assertEqual(auth.level_in_module(EDITOR, "tasks", 3, self.db), 1)
        self.assertEqual(auth.level_in_module(GUEST, "tasks", 3, self.db), 1)
        self.assertEqual(auth.level_for(OWNER, self.db), 1)   # the role itself is untouched

    # ── wired on every Task router, ahead of the endpoint checks ─────────────
    def test_every_task_router_carries_the_lift(self):
        for router in (T.router, TC.router, TP.router):
            calls = [d.dependency for d in router.dependencies]
            self.assertTrue(any(getattr(c, "__name__", "") == "_lift" for c in calls), router)

    def test_require_manager_sees_the_lift_in_the_same_request(self):
        """The lift edits the request's shared user dict, so it must run
        before - and be seen by - an endpoint's require_manager."""
        router = APIRouter(dependencies=[Depends(auth.get_current_user),
                                         Depends(auth.module_owner_acts_as("tasks", 3))])

        @router.get("/manage-only", dependencies=[Depends(auth.require_manager)])
        def manage_only(user: dict = Depends(auth.get_current_user)):
            return {"level": user["level"]}

        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        for email, status in ((OWNER, 200), (EDITOR, 401)):
            app.dependency_overrides[auth.get_current_user] = lambda e=email: {"email": e, "level": 1}
            res = client.get("/manage-only")
            self.assertEqual(res.status_code, status, email)
        app.dependency_overrides[auth.get_current_user] = lambda: {"email": OWNER, "level": 1}
        self.assertEqual(client.get("/manage-only").json(), {"level": 3})


if __name__ == "__main__":
    unittest.main()
