"""Who may read a task's comments, attachments and activity, and who may delete
a saved view or mark a notification read (Sep 30 review, item 2).

Each of these checked less than the screen implied. A task hidden from
somebody's lists still gave up its comments to anyone holding its id; a saved
view or a bell entry could be removed or cleared by id by anyone with the
Tasks grant. The rule everywhere is the one the lists already apply, and a
refusal reads as "not found" so the id tells the caller nothing.

Uses a throwaway sqlite file. Run with: python -m unittest test_task_data_access -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers.task_util import gen_id, now_iso
from routers.tasks import list_attachments, list_comments, task_activity
from routers.task_config import delete_saved_view, mark_notification_read


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

OWNER = {"email": "dean@greensglobal.com", "level": 1}
MEMBER = {"email": "miranda@greensglobal.com", "level": 1}
OUTSIDER = {"email": "charmi@greensglobal.com", "level": 1}
BOSS = {"email": "neil@greensglobal.com", "level": 3}
ADMIN = {"email": "admin@greensglobal.com", "level": 4}


class TaskDataAccessTests(unittest.TestCase):
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
        for m in (models.Task, models.TaskProject, models.TaskTeam, models.TaskComment,
                  models.TaskSavedView, models.TaskNotification):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        self.proj = models.TaskProject(id=gen_id(), name="Roof replacement", access_level="restricted",
                                       owner_email=OWNER["email"], member_emails=[MEMBER["email"]],
                                       created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.proj)
        # Restricted, in a restricted project: visible only through the project.
        self.task = self._task("Order shingles", project_id=self.proj.id)
        self.db.add(models.TaskComment(id=gen_id(), task_id=self.task.id, author_email=OWNER["email"],
                                       body="Supplier quote attached", created_at=now_iso()))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _task(self, title, **kw):
        t = models.Task(id=gen_id(), title=title, code=f"TASK-{gen_id()[:6]}", access_level="restricted",
                        created_by=OWNER["email"], created_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _not_found(self, fn, *args, **kw):
        with self.assertRaises(HTTPException) as e:
            fn(*args, **kw)
        self.assertEqual(e.exception.status_code, 404)

    # -- comments, attachments, activity -----------------------------------
    def test_someone_off_the_project_cannot_read_a_tasks_sub_resources(self):
        for read in (list_comments, list_attachments, task_activity):
            self._not_found(read, self.task.id, user=OUTSIDER, db=self.db)

    def test_people_who_can_see_the_task_still_can(self):
        for who in (OWNER, MEMBER, BOSS):
            self.assertEqual(len(list_comments(self.task.id, user=who, db=self.db)), 1)
            list_attachments(self.task.id, user=who, db=self.db)
            task_activity(self.task.id, user=who, db=self.db)

    def test_being_assigned_the_task_is_enough(self):
        t = self._task("Call the inspector", project_id=self.proj.id, assignee_email=OUTSIDER["email"])
        self.assertEqual(list_comments(t.id, user=OUTSIDER, db=self.db), [])

    def test_an_org_wide_task_stays_open_to_everyone(self):
        t = self._task("Fire drill")
        t.access_level = "org"
        self.db.commit()
        self.assertEqual(list_comments(t.id, user=OUTSIDER, db=self.db), [])

    def test_a_subtask_is_reached_through_its_parents_project(self):
        # A subtask carries no project of its own.
        sub = self._task("Measure the ridge", parent_task_id=self.task.id)
        self.assertEqual(list_comments(sub.id, user=MEMBER, db=self.db), [])
        self._not_found(list_comments, sub.id, user=OUTSIDER, db=self.db)

    def test_a_task_that_is_not_there_is_still_not_found(self):
        self._not_found(list_comments, "no-such-task", user=BOSS, db=self.db)

    # -- saved views -------------------------------------------------------
    def _view(self, owner, scope="task"):
        v = models.TaskSavedView(id=gen_id(), owner_email=owner["email"], name="Mine", scope=scope,
                                 created_at=now_iso())
        self.db.add(v)
        self.db.commit()
        return v.id

    def _views(self):
        return self.db.query(models.TaskSavedView).count()

    def test_a_saved_view_can_only_be_deleted_by_its_owner(self):
        vid = self._view(OWNER)
        delete_saved_view(vid, user=OUTSIDER, db=self.db)
        delete_saved_view(vid, user=BOSS, db=self.db)       # not even a manager: it is personal
        self.assertEqual(self._views(), 1)
        delete_saved_view(vid, user=OWNER, db=self.db)
        self.assertEqual(self._views(), 0)

    def test_a_ticket_view_is_not_deleted_through_the_task_route(self):
        vid = self._view(OWNER, scope="ticket")
        delete_saved_view(vid, user=OWNER, db=self.db)
        self.assertEqual(self._views(), 1)

    # -- notifications -----------------------------------------------------
    def _notif(self, for_email):
        n = models.TaskNotification(id=gen_id(), for_email=for_email, kind="assigned", title="x",
                                    read=False, created_at=now_iso())
        self.db.add(n)
        self.db.commit()
        return n

    def test_only_the_recipient_can_mark_a_notification_read(self):
        n = self._notif(OWNER["email"])
        self._not_found(mark_notification_read, n.id, user=OUTSIDER, db=self.db)
        self._not_found(mark_notification_read, n.id, user=ADMIN, db=self.db)
        self.db.refresh(n)
        self.assertFalse(n.read)
        mark_notification_read(n.id, user=OWNER, db=self.db)
        self.db.refresh(n)
        self.assertTrue(n.read)

    def test_an_admins_notification_is_for_administrators(self):
        n = self._notif("admins")
        self._not_found(mark_notification_read, n.id, user=BOSS, db=self.db)   # level 3 is not "admins"
        mark_notification_read(n.id, user=ADMIN, db=self.db)
        self.db.refresh(n)
        self.assertTrue(n.read)


if __name__ == "__main__":
    unittest.main()
