"""GET /tasks/activity/mine - the Updates card on the Tasks Home (Oct 14 2026).

Other people's recent changes to the tasks I am assigned to or follow, newest
first; my own actions, the Asana sync markers, tasks I am not on and tasks in
the Trash stay out.

Run with: python -m pytest test_task_my_activity.py
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi.routing import APIRoute

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

ME = {"email": "neil@greensglobal.com", "level": 3}
OTHER = "sagar@greensglobal.com"


def _ago(minutes: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


class MyActivityTests(unittest.TestCase):
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

    def _task(self, code, **kw):
        t = models.Task(id=gen_id(), code=code, title=f"{code} title", created_at=now_iso(),
                        modified_at=now_iso(), **kw)
        self.db.add(t)
        return t

    def _act(self, t, actor, type="commented", at=None, detail=""):
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=t.id,
                                        entity_code=t.code, entity_title=t.title, type=type,
                                        actor_email=actor, at=at or now_iso(), detail=detail))

    def test_the_route_is_registered_where_the_task_id_route_cannot_shadow_it(self):
        route = next(r for r in T.router.routes
                     if isinstance(r, APIRoute) and "GET" in r.methods and r.path == "/tasks/activity/mine")
        self.assertIs(route.endpoint, T.my_task_activity)

    def test_only_other_peoples_changes_on_my_tasks_newest_first(self):
        assigned = self._task("TASK-A", assignee_emails=[ME["email"]])
        followed = self._task("TASK-F", assignee_emails=[OTHER], follower_emails=["Neil@GreensGlobal.com"])
        not_mine = self._task("TASK-N", assignee_emails=[OTHER])
        trashed = self._task("TASK-T", assignee_emails=[ME["email"]], deleted_at=now_iso())
        self._act(assigned, OTHER, at=_ago(30), detail="changed status to in_progress")
        self._act(followed, OTHER, type="completed", at=_ago(5), detail="completed this task")
        self._act(assigned, ME["email"], at=_ago(1))                       # my own action
        self._act(assigned, OTHER, type="synced_from_asana", at=_ago(2))   # sync bookkeeping
        self._act(not_mine, OTHER, at=_ago(3))
        self._act(trashed, OTHER, at=_ago(4))
        self._act(assigned, OTHER, at=_ago(60 * 24 * 20))                 # outside the window
        self.db.commit()

        rows = T.my_task_activity(limit=30, days=14, user=ME, db=self.db)
        self.assertEqual([(r["entityCode"], r["relation"]) for r in rows],
                         [("TASK-F", "collaborator"), ("TASK-A", "assignee")])
        self.assertEqual(rows[0]["taskId"], followed.id)
        self.assertEqual(rows[1]["detail"], "changed status to in_progress")

    def test_limit_and_window_are_honored_and_capped(self):
        t = self._task("TASK-A", assignee_emails=[ME["email"]])
        for i in range(5):
            self._act(t, OTHER, at=_ago(i + 1))
        self.db.commit()
        self.assertEqual(len(T.my_task_activity(limit=2, days=14, user=ME, db=self.db)), 2)
        self.assertEqual(len(T.my_task_activity(limit=1, days=14, user=ME, db=self.db)), 1)
        # a zero falls back to the defaults (30 rows, 14 days), never to nothing
        self.assertEqual(len(T.my_task_activity(limit=0, days=0, user=ME, db=self.db)), 5)
        self.assertEqual(len(T.my_task_activity(limit=500, days=14, user=ME, db=self.db)), 5)

    def test_nothing_for_someone_on_no_task(self):
        t = self._task("TASK-A", assignee_emails=[OTHER])
        self._act(t, OTHER)
        self.db.commit()
        self.assertEqual(T.my_task_activity(user={"email": "dean@greensglobal.com", "level": 1}, db=self.db), [])
        self.assertEqual(T.my_task_activity(user={"email": "", "level": 1}, db=self.db), [])


if __name__ == "__main__":
    unittest.main()
