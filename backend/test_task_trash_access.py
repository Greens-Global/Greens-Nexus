"""Who can dig a task back out of the Trash (Sept 2026).

Restore and permanent-delete were manager-only, so a person who deleted their
own task by mistake - and missed the few seconds the undo toast lives for - had
to go and ask someone. Now the person who DELETED it can also undo it, and the
Trash listing shows a non-manager exactly their own deletions.

The tests that matter are the boundaries: that a non-manager cannot reach into
someone else's deletion, and that opening the listing up did not turn it into a
window on the whole workspace.

Run with: python -m unittest test_task_trash_access -v
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
from routers import tasks as tasks_router
from routers.task_util import gen_id, now_iso
from routers.tasks import list_deleted_tasks, restore_task, delete_task_permanent


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

OWNER = {"email": "dean@greensglobal.com", "level": 1}      # deleted it
OTHER = {"email": "miranda@greensglobal.com", "level": 1}   # did not
BOSS = {"email": "neil@greensglobal.com", "level": 3}       # manager


class TrashAccessTests(unittest.TestCase):
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
        self.db.query(models.Task).delete()
        self.db.commit()
        self._push = tasks_router.asana_push_deleted
        tasks_router.asana_push_deleted = lambda *a, **kw: None
        self.mine = self._trashed("Keypad rewire", OWNER["email"])
        self.theirs = self._trashed("Q3 tax filing", OTHER["email"])

    def tearDown(self):
        tasks_router.asana_push_deleted = self._push
        self.db.close()

    def _trashed(self, title, by):
        t = models.Task(id=gen_id(), title=title, code="T", activity_ids=[],
                        deleted_at=now_iso(), deleted_by=by,
                        created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    # -- the listing -------------------------------------------------------
    def test_scope_mine_is_what_you_deleted(self):
        titles = [t["title"] for t in list_deleted_tasks(scope="mine", user=OWNER, db=self.db)]
        self.assertEqual(titles, ["Keypad rewire"])

    def test_scope_mine_also_covers_a_task_you_are_assigned(self):
        # Somebody else binned a task off your plate - the case you most need
        # the bin for.
        theirs = self._trashed("Replace ballast", OTHER["email"])
        theirs.assignee_emails = [OWNER["email"]]
        self.db.commit()
        titles = {t["title"] for t in list_deleted_tasks(scope="mine", user=OWNER, db=self.db)}
        self.assertEqual(titles, {"Keypad rewire", "Replace ballast"})

    def test_scope_mine_is_not_widened_for_a_manager(self):
        # The bug this fixes: a Global Admin opening their OWN bin was handed
        # the whole company's deletions. Role decides what Manage shows; it does
        # not decide what "mine" means.
        titles = [t["title"] for t in list_deleted_tasks(scope="mine", user=BOSS, db=self.db)]
        self.assertEqual(titles, [])

    def test_the_unscoped_listing_is_the_whole_workspace_for_a_manager(self):
        titles = {t["title"] for t in list_deleted_tasks(user=BOSS, db=self.db)}
        self.assertEqual(titles, {"Keypad rewire", "Q3 tax filing"})

    def test_the_unscoped_listing_is_refused_to_everyone_else(self):
        with self.assertRaises(HTTPException) as e:
            list_deleted_tasks(user=OWNER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    # -- restore -----------------------------------------------------------
    def test_you_can_restore_what_you_deleted(self):
        restore_task(self.mine.id, user=OWNER, db=self.db)
        self.db.refresh(self.mine)
        self.assertEqual(self.mine.deleted_at, "")

    def test_you_cannot_restore_someone_elses_deletion(self):
        with self.assertRaises(HTTPException) as e:
            restore_task(self.theirs.id, user=OWNER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.db.refresh(self.theirs)
        self.assertNotEqual(self.theirs.deleted_at, "")

    def test_the_assignee_can_restore_what_someone_else_binned(self):
        self.theirs.assignee_emails = [OWNER["email"]]
        self.db.commit()
        restore_task(self.theirs.id, user=OWNER, db=self.db)
        self.db.refresh(self.theirs)
        self.assertEqual(self.theirs.deleted_at, "")

    def test_a_manager_can_restore_anyones(self):
        restore_task(self.theirs.id, user=BOSS, db=self.db)
        self.db.refresh(self.theirs)
        self.assertEqual(self.theirs.deleted_at, "")

    # -- permanent delete --------------------------------------------------
    def test_you_can_permanently_delete_what_you_deleted(self):
        # Id captured first: touching an attribute on the ORM instance after the
        # row is gone makes SQLAlchemy try to refresh it and raise.
        tid = self.mine.id
        delete_task_permanent(tid, user=OWNER, db=self.db)
        gone = (self.db.query(models.Task).execution_options(include_deleted=True)
                .filter(models.Task.id == tid).first())
        self.assertIsNone(gone)

    def test_you_cannot_permanently_delete_someone_elses(self):
        with self.assertRaises(HTTPException) as e:
            delete_task_permanent(self.theirs.id, user=OWNER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)
        still = (self.db.query(models.Task).execution_options(include_deleted=True)
                 .filter(models.Task.id == self.theirs.id).first())
        self.assertIsNotNone(still)


if __name__ == "__main__":
    unittest.main()
