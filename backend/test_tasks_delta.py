"""
Unit tests for GET /tasks/delta (routers.tasks.list_tasks_delta) - the
incremental fetch TasksContext uses instead of re-shipping the whole
workspace on every 45s poll / realtime ping.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_tasks_delta -v
"""
import os
import tempfile
import time
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.task_util import gen_id, now_iso
from routers.tasks import list_tasks_delta, add_comment, edit_comment, add_attachment, delete_task, \
    CommentCreate, CommentUpdate, AttachmentCreate
from fastapi import BackgroundTasks

MANAGER = {"email": "manager@greensglobal.com", "level": 3}


class TasksDeltaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.TaskAttachment,
                  models.TaskActivity, models.TaskDeleteLog):
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

    # ── basic incremental behavior ───────────────────────────────────────
    def test_since_empty_returns_everything_with_no_deletions(self):
        self._task()
        self._task()

        res = list_tasks_delta(since="", user=MANAGER, db=self.db)

        self.assertEqual(len(res["tasks"]), 2)
        self.assertEqual(res["deletedIds"], [])
        self.assertTrue(res["serverTime"])

    def test_since_a_future_timestamp_returns_nothing(self):
        self._task()
        future = "9999-01-01T00:00:00+00:00"

        res = list_tasks_delta(since=future, user=MANAGER, db=self.db)

        self.assertEqual(res["tasks"], [])

    def test_a_task_modified_after_since_is_returned(self):
        t = self._task()
        checkpoint = list_tasks_delta(since="", user=MANAGER, db=self.db)["serverTime"]
        time.sleep(0.01)
        t.title = "Changed"
        t.modified_at = now_iso()
        self.db.commit()

        res = list_tasks_delta(since=checkpoint, user=MANAGER, db=self.db)

        self.assertEqual(len(res["tasks"]), 1)
        self.assertEqual(res["tasks"][0]["title"], "Changed")

    def test_an_unmodified_task_does_not_reappear(self):
        self._task()
        checkpoint = list_tasks_delta(since="", user=MANAGER, db=self.db)["serverTime"]
        time.sleep(0.01)

        res = list_tasks_delta(since=checkpoint, user=MANAGER, db=self.db)

        self.assertEqual(res["tasks"], [])

    def test_serverTime_from_one_call_works_as_since_on_the_next(self):
        self._task()
        r1 = list_tasks_delta(since="", user=MANAGER, db=self.db)
        time.sleep(0.01)
        self._task()

        r2 = list_tasks_delta(since=r1["serverTime"], user=MANAGER, db=self.db)

        self.assertEqual(len(r2["tasks"]), 1)

    # ── deletions ─────────────────────────────────────────────────────────
    def test_a_deleted_task_id_appears_in_deletedIds_and_not_in_tasks(self):
        t = self._task()
        checkpoint = list_tasks_delta(since="", user=MANAGER, db=self.db)["serverTime"]
        time.sleep(0.01)
        delete_task(t.id, BackgroundTasks(), user=MANAGER, db=self.db)

        res = list_tasks_delta(since=checkpoint, user=MANAGER, db=self.db)

        self.assertEqual(res["tasks"], [])
        self.assertIn(t.id, res["deletedIds"])

    def test_deleting_subtasks_tombstones_them_too(self):
        parent = self._task()
        child = self._task(parent_task_id=parent.id)
        checkpoint = list_tasks_delta(since="", user=MANAGER, db=self.db)["serverTime"]
        time.sleep(0.01)
        delete_task(parent.id, BackgroundTasks(), user=MANAGER, db=self.db)

        res = list_tasks_delta(since=checkpoint, user=MANAGER, db=self.db)

        self.assertIn(parent.id, res["deletedIds"])
        self.assertIn(child.id, res["deletedIds"])

    def test_since_empty_never_reports_deletions(self):
        """The mount-load call (since="") must not carry deletedIds for tasks
        deleted before the client ever knew about them - there is nothing to
        remove from a cache that never had them."""
        t = self._task()
        delete_task(t.id, BackgroundTasks(), user=MANAGER, db=self.db)

        res = list_tasks_delta(since="", user=MANAGER, db=self.db)

        self.assertEqual(res["deletedIds"], [])

    # ── the modified_at correctness gap this change closes ────────────────
    def test_a_new_comment_bumps_the_parent_tasks_modified_at(self):
        t = self._task()
        checkpoint = list_tasks_delta(since="", user=MANAGER, db=self.db)["serverTime"]
        time.sleep(0.01)
        add_comment(t.id, CommentCreate(body="hi"), BackgroundTasks(), notify=False, user=MANAGER, db=self.db)

        res = list_tasks_delta(since=checkpoint, user=MANAGER, db=self.db)

        self.assertEqual([r["id"] for r in res["tasks"]], [t.id])

    def test_editing_a_comment_bumps_the_parent_tasks_modified_at(self):
        t = self._task()
        c = add_comment(t.id, CommentCreate(body="hi"), BackgroundTasks(), notify=False, user=MANAGER, db=self.db)
        checkpoint = list_tasks_delta(since="", user=MANAGER, db=self.db)["serverTime"]
        time.sleep(0.01)
        edit_comment(c["id"], CommentUpdate(pinned=True), user=MANAGER, db=self.db)

        res = list_tasks_delta(since=checkpoint, user=MANAGER, db=self.db)

        self.assertEqual([r["id"] for r in res["tasks"]], [t.id])

    def test_a_new_attachment_bumps_the_parent_tasks_modified_at(self):
        t = self._task()
        checkpoint = list_tasks_delta(since="", user=MANAGER, db=self.db)["serverTime"]
        time.sleep(0.01)
        add_attachment(t.id, AttachmentCreate(name="f.png", kind="image", url="data:x"),
                       user=MANAGER, db=self.db)

        res = list_tasks_delta(since=checkpoint, user=MANAGER, db=self.db)

        self.assertEqual([r["id"] for r in res["tasks"]], [t.id])


if __name__ == "__main__":
    unittest.main()
