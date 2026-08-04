"""
Permission regression tests for the task router.

These endpoints were ALL unguarded (QA audit, Aug 2026): bulk_update bypassed
the editor check PATCH /tasks/{id} enforces, comment edit/delete took no `user`
at all so anyone could rewrite or remove anyone's comment, and the section and
attachment endpoints had no role check either.

Each test below asserts a DENIAL - the case that was silently allowed before -
so a future refactor that drops a guard fails here instead of shipping.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_permissions -v
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
from routers.tasks import (
    bulk_update, edit_comment, delete_comment, add_attachment, delete_attachment,
    create_section, update_section, delete_section,
    BulkUpdate, CommentUpdate, AttachmentCreate, SectionBody,
)

# level < 3 -> not a manager, so project roles actually apply (is_manager
# bypasses everything, which is why every test here uses a plain employee).
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
AUTHOR = {"email": "author@greensglobal.com", "level": 1}
MANAGER = {"email": "boss@greensglobal.com", "level": 3}


class TaskPermissionTests(unittest.TestCase):
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
                  models.TaskSection, models.TaskProject, models.TaskTeam,
                  models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()
        # A restricted project the outsider has no role on.
        self.project = models.TaskProject(id=gen_id(), name="Locked", access_level="restricted",
                                          owner_email=AUTHOR["email"], member_roles={},
                                          created_at=now_iso())
        self.db.add(self.project)
        self.task = models.Task(id=gen_id(), title="T", code="TASK-1", access_level="restricted",
                                project_id=self.project.id, created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.task)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _comment(self, author=AUTHOR["email"]):
        c = models.TaskComment(id=gen_id(), task_id=self.task.id, author_email=author,
                               body="<p>original</p>", created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        return c

    def _attachment(self, added_by=AUTHOR["email"]):
        a = models.TaskAttachment(id=gen_id(), task_id=self.task.id, name="f.png",
                                  kind="image", url="data:x", added_at=now_iso(), added_by=added_by)
        self.db.add(a)
        self.db.commit()
        return a

    # ── bulk_update ──────────────────────────────────────────────────────
    def test_bulk_update_denies_a_user_without_editor(self):
        """The bypass: _BULK_ALLOWED covers assignee/project/completed/due_on,
        so this was a way to mutate a task you could only view."""
        with self.assertRaises(HTTPException) as ctx:
            bulk_update(BulkUpdate(ids=[self.task.id], patch={"completed": True}),
                        user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertFalse(self.db.get(models.Task, self.task.id).completed)

    def test_bulk_update_is_all_or_nothing(self):
        """One forbidden id fails the whole call - a partial apply would leave
        the caller unable to tell which ids were skipped."""
        open_task = models.Task(id=gen_id(), title="Open", access_level="org",
                                created_at=now_iso(), modified_at=now_iso())
        self.db.add(open_task)
        self.db.commit()
        with self.assertRaises(HTTPException):
            bulk_update(BulkUpdate(ids=[open_task.id, self.task.id], patch={"priority": "high"}),
                        user=OUTSIDER, db=self.db)
        self.db.rollback()
        self.assertNotEqual(self.db.get(models.Task, open_task.id).priority, "high")

    def test_bulk_update_allows_a_manager(self):
        bulk_update(BulkUpdate(ids=[self.task.id], patch={"priority": "high"}),
                    user=MANAGER, db=self.db)
        self.assertEqual(self.db.get(models.Task, self.task.id).priority, "high")

    # ── comments ─────────────────────────────────────────────────────────
    def test_only_the_author_may_edit_a_comment_body(self):
        c = self._comment()
        with self.assertRaises(HTTPException) as ctx:
            edit_comment(c.id, CommentUpdate(body="<p>hijacked</p>"), user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertEqual(self.db.get(models.TaskComment, c.id).body, "<p>original</p>")

    def test_even_a_manager_may_not_rewrite_someone_elses_comment(self):
        """Managers bypass every other project-role check here, but rewriting
        another person's words is different in kind from access."""
        c = self._comment()
        with self.assertRaises(HTTPException):
            edit_comment(c.id, CommentUpdate(body="<p>edited by boss</p>"), user=MANAGER, db=self.db)
        self.db.rollback()
        self.assertEqual(self.db.get(models.TaskComment, c.id).body, "<p>original</p>")

    def test_the_author_can_edit_their_own_comment(self):
        c = self._comment()
        edit_comment(c.id, CommentUpdate(body="<p>fixed a typo</p>"), user=AUTHOR, db=self.db)
        self.assertEqual(self.db.get(models.TaskComment, c.id).body, "<p>fixed a typo</p>")

    def test_pinning_requires_editor_not_authorship(self):
        c = self._comment()
        with self.assertRaises(HTTPException) as ctx:
            edit_comment(c.id, CommentUpdate(pinned=True), user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        edit_comment(c.id, CommentUpdate(pinned=True), user=MANAGER, db=self.db)
        self.assertTrue(self.db.get(models.TaskComment, c.id).pinned)

    def test_an_outsider_cannot_delete_a_comment(self):
        c = self._comment()
        with self.assertRaises(HTTPException) as ctx:
            delete_comment(c.id, user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(models.TaskComment, c.id))

    def test_the_author_can_delete_their_own_comment(self):
        c = self._comment()
        delete_comment(c.id, user=AUTHOR, db=self.db)
        self.assertIsNone(self.db.get(models.TaskComment, c.id))

    def test_an_editor_can_moderate_someone_elses_comment(self):
        c = self._comment()
        delete_comment(c.id, user=MANAGER, db=self.db)
        self.assertIsNone(self.db.get(models.TaskComment, c.id))

    # ── attachments ──────────────────────────────────────────────────────
    def test_an_outsider_cannot_attach_to_a_restricted_task(self):
        with self.assertRaises(HTTPException) as ctx:
            add_attachment(self.task.id, AttachmentCreate(name="x.png", url="data:x"),
                           user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_attaching_needs_only_commenter_so_comment_attachments_still_work(self):
        """Deliberately NOT editor: a commenter attaches files while composing a
        comment, and requiring editor would 403 exactly that flow."""
        self.project.member_roles = {AUTHOR["email"]: "commenter"}
        self.db.commit()
        a = add_attachment(self.task.id, AttachmentCreate(name="ok.png", url="data:x"),
                           user=AUTHOR, db=self.db)
        self.assertEqual(a["name"], "ok.png")

    def test_an_outsider_cannot_delete_someone_elses_attachment(self):
        a = self._attachment()
        with self.assertRaises(HTTPException) as ctx:
            delete_attachment(a.id, user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(models.TaskAttachment, a.id))

    def test_the_uploader_can_remove_their_own_attachment(self):
        a = self._attachment(added_by=OUTSIDER["email"])
        delete_attachment(a.id, user=OUTSIDER, db=self.db)
        self.assertIsNone(self.db.get(models.TaskAttachment, a.id))

    # ── sections ─────────────────────────────────────────────────────────
    def test_an_outsider_cannot_create_a_section_in_a_restricted_project(self):
        with self.assertRaises(HTTPException) as ctx:
            create_section(SectionBody(project_id=self.project.id, name="Sneaky"),
                           user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_an_outsider_cannot_rename_or_delete_a_section(self):
        s = models.TaskSection(id=gen_id(), project_id=self.project.id, name="Real",
                               position=0, created_at=now_iso())
        self.db.add(s)
        self.db.commit()
        with self.assertRaises(HTTPException):
            update_section(s.id, SectionBody(name="Renamed"), user=OUTSIDER, db=self.db)
        self.db.rollback()
        with self.assertRaises(HTTPException):
            delete_section(s.id, user=OUTSIDER, db=self.db)
        self.db.rollback()
        still = self.db.get(models.TaskSection, s.id)
        self.assertIsNotNone(still)
        self.assertEqual(still.name, "Real")

    def test_a_workspace_level_section_stays_unrestricted(self):
        """project_id "" is workspace-level, matching how a task with no project
        is treated - not something this change should start blocking."""
        out = create_section(SectionBody(project_id="", name="Global"), user=OUTSIDER, db=self.db)
        self.assertEqual(out["name"], "Global")


if __name__ == "__main__":
    unittest.main()
