"""
Referential-integrity regressions (QA audit, Aug 2026) plus the Asana
duplicate-comment race.

Covers the leftovers after the permission/validation/notification passes:
  M-2  deleting a section left its tasks pointing at a section that no longer
       resolves, so they vanished from section-grouped views.
  M-8  an attachment could be tagged with a comment belonging to a DIFFERENT
       task.
  L-3  a dependency on a nonexistent task id was accepted.
  L-5  a collaborator that wasn't an email address was accepted.
  ---  a pull racing an outbound push created a SECOND copy of a comment
       Nexus had just pushed (the [Nexus - ...] duplicate seen on dev).

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_integrity -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException, BackgroundTasks

import database
import models
import asana_sync
from routers.task_util import gen_id, now_iso
from routers.tasks import (
    delete_section, add_attachment, update_task, AttachmentCreate, TaskUpdate,
)

USER = {"email": "sagar@greensglobal.com", "level": 3}


class ReferentialIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskSection, models.TaskComment,
                  models.TaskAttachment, models.TaskProject, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _task(self, **kw):
        t = models.Task(id=gen_id(), title="T", code="TASK-1", status="not_started",
                        created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    # ── M-2 ──────────────────────────────────────────────────────────────
    def test_deleting_a_section_releases_its_tasks(self):
        s = models.TaskSection(id=gen_id(), project_id="", name="Doing",
                               position=0, created_at=now_iso())
        self.db.add(s)
        self.db.commit()
        t = self._task(section_id=s.id)
        before = t.modified_at

        delete_section(s.id, user=USER, db=self.db)

        refreshed = self.db.get(models.Task, t.id)
        self.assertEqual(refreshed.section_id, "")
        self.assertNotEqual(refreshed.modified_at, before,
                            "modified_at must bump so GET /tasks/delta carries the change")

    def test_deleting_a_section_leaves_other_sections_tasks_alone(self):
        keep = models.TaskSection(id=gen_id(), project_id="", name="Keep",
                                  position=0, created_at=now_iso())
        drop = models.TaskSection(id=gen_id(), project_id="", name="Drop",
                                  position=1, created_at=now_iso())
        self.db.add_all([keep, drop])
        self.db.commit()
        kept = self._task(section_id=keep.id)

        delete_section(drop.id, user=USER, db=self.db)

        self.assertEqual(self.db.get(models.Task, kept.id).section_id, keep.id)

    # ── M-8 ──────────────────────────────────────────────────────────────
    def test_an_attachment_cannot_borrow_a_comment_from_another_task(self):
        a, b = self._task(), self._task()
        c = models.TaskComment(id=gen_id(), task_id=a.id, author_email=USER["email"],
                               body="<p>on task a</p>", created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        with self.assertRaises(HTTPException) as ctx:
            add_attachment(b.id, AttachmentCreate(name="x.png", url="data:x", comment_id=c.id),
                           user=USER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_an_attachment_on_its_own_tasks_comment_is_fine(self):
        a = self._task()
        c = models.TaskComment(id=gen_id(), task_id=a.id, author_email=USER["email"],
                               body="<p>hi</p>", created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        out = add_attachment(a.id, AttachmentCreate(name="x.png", url="data:x", comment_id=c.id),
                             user=USER, db=self.db)
        self.assertEqual(out["commentId"], c.id)

    def test_an_unknown_comment_id_is_rejected(self):
        a = self._task()
        with self.assertRaises(HTTPException):
            add_attachment(a.id, AttachmentCreate(name="x.png", url="data:x",
                                                  comment_id="no-such-comment"),
                           user=USER, db=self.db)

    def test_a_task_level_attachment_still_needs_no_comment(self):
        a = self._task()
        out = add_attachment(a.id, AttachmentCreate(name="x.png", url="data:x"),
                             user=USER, db=self.db)
        self.assertIsNone(out["commentId"])

    # ── L-3 ──────────────────────────────────────────────────────────────
    def test_a_dependency_on_a_nonexistent_task_is_rejected(self):
        """It looks blocked in the payload but the completion gate ignores it,
        so the task behaves as if it were not blocked at all."""
        t = self._task()
        with self.assertRaises(HTTPException) as ctx:
            update_task(t.id, TaskUpdate(blocked_by_ids=["ghost-id"]),
                        BackgroundTasks(), user=USER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_a_dependency_on_a_real_task_still_works(self):
        a, b = self._task(), self._task()
        out = update_task(a.id, TaskUpdate(blocked_by_ids=[b.id]),
                          BackgroundTasks(), user=USER, db=self.db)
        self.assertEqual(out["blockedByIds"], [b.id])

    # ── L-5 ──────────────────────────────────────────────────────────────
    def test_a_collaborator_must_be_an_email_address(self):
        t = self._task()
        with self.assertRaises(HTTPException) as ctx:
            update_task(t.id, TaskUpdate(follower_emails=["not-an-address"]),
                        BackgroundTasks(), user=USER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 422)

    def test_real_addresses_are_still_accepted_and_normalized(self):
        t = self._task()
        out = update_task(t.id, TaskUpdate(follower_emails=["A.B@greensglobal.com", "a.b@greensglobal.com"]),
                          BackgroundTasks(), user=USER, db=self.db)
        self.assertEqual(out["followerIds"], ["a.b@greensglobal.com"])


class AsanaCommentRaceTests(unittest.TestCase):
    """push_comment POSTs the story, THEN commits the AsanaCommentLink. A pull
    arriving in between (the webhook fires the moment the story exists) found no
    link and created a duplicate - the [Nexus - ...] copy seen on dev."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.AsanaCommentLink,
                  models.AsanaActivityLink, models.TaskActivity, models.AsanaSyncConfig):
            self.db.query(m).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", enabled=True, token="tok"))
        self.db.commit()
        self.task = models.Task(id=gen_id(), title="T", code="TASK-1",
                                created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.task)
        self.db.commit()
        self.counts = {"created": 0, "updated": 0, "comments": 0, "activities": 0,
                       "attachments": 0, "deleted": 0}

    def tearDown(self):
        self.db.close()

    def _nexus_comment(self, body, author="ankush@greensglobal.com", ago_seconds=5):
        made = (datetime.now(timezone.utc) - timedelta(seconds=ago_seconds)).isoformat()
        c = models.TaskComment(id=gen_id(), task_id=self.task.id, author_email=author,
                               body=body, created_at=made)
        self.db.add(c)
        self.db.commit()
        return c

    def _story(self, text, gid="story-1"):
        class FakeAsana:
            def get(self, path, **kw):
                if path.endswith("/stories"):
                    return [{"gid": gid, "type": "comment", "text": text,
                             "created_at": datetime.now(timezone.utc).isoformat(),
                             "created_by": {"name": "Sai", "email": "sai@greensglobal.com"}}]
                return []
        return FakeAsana()

    def test_a_pushed_comment_coming_back_does_not_duplicate(self):
        """The race: the Nexus comment exists but its link never committed."""
        self._nexus_comment("<p>Please review the comments</p>")

        asana_sync._pull_stories(self.db, self._story("Please review the comments"),
                                 "A1", self.task.id, self.counts)

        self.assertEqual(self.db.query(models.TaskComment).count(), 1,
                         "the inbound story must adopt the existing comment, not add a second")

    def test_adopting_repairs_the_missing_link(self):
        """So the next pull short-circuits on the gid instead of re-checking."""
        c = self._nexus_comment("<p>Please review</p>")

        asana_sync._pull_stories(self.db, self._story("Please review"), "A1",
                                 self.task.id, self.counts)

        link = self.db.query(models.AsanaCommentLink).filter(
            models.AsanaCommentLink.nexus_comment_id == c.id).first()
        self.assertIsNotNone(link)
        self.assertEqual(link.asana_story_gid, "story-1")

    def test_a_second_pull_is_a_no_op(self):
        self._nexus_comment("<p>Please review</p>")
        for _ in range(3):
            asana_sync._pull_stories(self.db, self._story("Please review"), "A1",
                                     self.task.id, self.counts)
        self.assertEqual(self.db.query(models.TaskComment).count(), 1)
        self.assertEqual(self.db.query(models.AsanaCommentLink).count(), 1)

    def test_a_genuinely_new_asana_comment_is_still_imported(self):
        """The adoption must not swallow real inbound comments."""
        self._nexus_comment("<p>something Nexus said</p>")

        asana_sync._pull_stories(self.db, self._story("a totally different remark"),
                                 "A1", self.task.id, self.counts)

        self.assertEqual(self.db.query(models.TaskComment).count(), 2)

    def test_an_already_linked_comment_is_never_adopted_twice(self):
        """Only UNLINKED comments are candidates, so a real Asana comment that
        happens to repeat earlier text still lands."""
        c = self._nexus_comment("<p>duplicate text</p>")
        self.db.add(models.AsanaCommentLink(id=gen_id(), nexus_comment_id=c.id,
                                            asana_story_gid="older-story", created_at=now_iso()))
        self.db.commit()

        asana_sync._pull_stories(self.db, self._story("duplicate text", gid="new-story"),
                                 "A1", self.task.id, self.counts)

        self.assertEqual(self.db.query(models.TaskComment).count(), 2)

    def test_an_old_lookalike_comment_is_not_adopted(self):
        """Outside the window, identical text is coincidence, not our push."""
        self._nexus_comment("<p>status update</p>", ago_seconds=60 * 60 * 24 * 30)

        asana_sync._pull_stories(self.db, self._story("status update"), "A1",
                                 self.task.id, self.counts)

        self.assertEqual(self.db.query(models.TaskComment).count(), 2)

    def test_adoption_ignores_markup_differences(self):
        """The pushed body round-trips through _to_asana_html/_from_asana_html,
        so it never comes back byte-identical - matching is on visible text."""
        self._nexus_comment("<p><strong>Ship</strong> it</p>")

        asana_sync._pull_stories(self.db, self._story("Ship it"), "A1",
                                 self.task.id, self.counts)

        self.assertEqual(self.db.query(models.TaskComment).count(), 1)


if __name__ == "__main__":
    unittest.main()
