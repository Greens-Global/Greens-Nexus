"""GET /tasks/activity - the workspace Activity Log (Sep 30 review).

It used to take no user: anybody holding a Tasks OR Tickets grant could pull
up to 2,000 rows of every task's titles, status changes and assignments, in
every project and company. It is only shown on Manage > Activity Log, a
manager-only tab, so the route now takes the Tasks grant and manager level,
and a manager behind a company wall sees only their side's task rows.

Run with: python -m pytest test_task_global_activity.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException
from fastapi.routing import APIRoute

import auth
import database
import models
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Run it on its own: python -m pytest {__name__}.py"
        )


_assert_isolated()

EMPLOYEE = {"email": "dean@greensglobal.com", "level": 1}
MANAGER = {"email": "neil@greensglobal.com", "level": 3}


def _activity_route() -> APIRoute:
    for r in T.router.routes:
        if isinstance(r, APIRoute) and r.path == "/tasks/activity" and "GET" in r.methods:
            return r
    raise AssertionError("GET /tasks/activity is not registered")


class GlobalActivityAccessTests(unittest.TestCase):
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
        for m in (models.TaskActivity, models.Task):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _guards(self):
        return [d.dependency for d in _activity_route().dependencies]

    # -- the route's own gates -------------------------------------------------
    def test_route_requires_the_tasks_grant_and_manager_level(self):
        names = [getattr(g, "__qualname__", "") for g in self._guards()]
        self.assertTrue(any(n.startswith("require_module_grant") for n in names), names)
        self.assertTrue(any(n.startswith("require_level") for n in names), names)

    def test_an_employee_is_refused(self):
        level = next(g for g in self._guards()
                     if getattr(g, "__qualname__", "").startswith("require_level"))
        with self.assertRaises(HTTPException):
            level(user=EMPLOYEE)
        self.assertEqual(level(user=MANAGER), MANAGER)

    def test_a_manager_without_the_tasks_grant_is_refused(self):
        grant = next(g for g in self._guards()
                     if getattr(g, "__qualname__", "").startswith("require_module_grant"))
        with self.assertRaises(HTTPException) as e:
            grant(user=MANAGER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    # -- the company wall ------------------------------------------------------
    def _seed(self):
        for code, company in (("TASK-A", "co-a"), ("TASK-B", "co-b")):
            t = models.Task(id=gen_id(), code=code, title=f"{code} title", company_id=company,
                            created_at=now_iso(), modified_at=now_iso())
            self.db.add(t)
            self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=t.id,
                                            entity_code=code, entity_title=t.title,
                                            type="created", actor_email=MANAGER["email"], at=now_iso()))
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="project", entity_id="p1",
                                        entity_code="Roof", entity_title="Roof", type="created",
                                        actor_email=MANAGER["email"], at=now_iso()))
        self.db.commit()

    def _codes(self, user):
        return {r["entityCode"] for r in T.global_activity_feed(limit=500, user=user, db=self.db)}

    def test_walls_off_returns_every_row(self):
        self._seed()
        self.assertEqual(self._codes(MANAGER), {"TASK-A", "TASK-B", "Roof"})

    def test_a_walled_manager_sees_only_their_companys_task_rows(self):
        self._seed()
        with mock.patch.object(auth, "company_scope", return_value={"co-a"}):
            self.assertEqual(self._codes(MANAGER), {"TASK-A", "Roof"})


if __name__ == "__main__":
    unittest.main()
