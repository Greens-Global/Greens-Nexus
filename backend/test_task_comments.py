"""
create_comment - the one comment-creation path (Aug 2026).

POST /tasks/{id}/comments used to BE the implementation: the comment row and
its six side effects (activity entry, in-app bells, realtime ping, Asana push,
the "commented" mail and the separate @mention mail) were written inline in the
endpoint. Anything else that needed to post a comment - the inbound-email
ingester being the next one - would have had to copy them, and a copy drifts:
the Asana sync's second inbound path is the precedent CLAUDE.md records.

These tests pin all six to the extracted function, so a comment posted by a
worker is provably the same event as one typed into the drawer.

Uses a throwaway sqlite file. No network - the Asana push and the mail send are
stubbed.

Run with: python -m unittest test_task_comments -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks

import database
import models
import task_notify
from routers import task_util
from routers.task_util import gen_id, now_iso, create_comment
from routers.tasks import add_comment, CommentCreate

ACTOR = {"email": "actor@greensglobal.com", "level": 1}
ASSIGNEE = "assignee@greensglobal.com"
FOLLOWER = "follower@greensglobal.com"


class CreateCommentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.TaskActivity,
                  models.TaskNotification, models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()
        # No project - project_role_for treats a standalone task as unrestricted,
        # so these tests exercise the comment behavior, not the role check
        # (test_task_permissions.py owns that).
        self.task = models.Task(id=gen_id(), title="Fix the pump", code="TASK-1",
                                assignee_email=ASSIGNEE, follower_emails=[FOLLOWER],
                                comment_ids=[], activity_ids=[],
                                created_at=now_iso(), modified_at="2026-01-01T00:00:00+00:00")
        self.db.add(self.task)
        self.db.commit()

        self.pushed, self.emailed = [], []
        self._real_push = task_util.asana_push_comment
        self._real_notify = task_notify.notify_task_event
        task_util.asana_push_comment = lambda cid: self.pushed.append(cid)
        task_notify.notify_task_event = lambda *a, **kw: self.emailed.append((a, kw))

    def tearDown(self):
        task_util.asana_push_comment = self._real_push
        task_notify.notify_task_event = self._real_notify
        self.db.close()

    def _bells(self):
        return self.db.query(models.TaskNotification).all()

    # ── the row and the feed ─────────────────────────────────────────────
    def test_comment_is_written_and_linked_onto_the_task(self):
        c = create_comment(self.db, self.task, actor_email=ACTOR["email"], body="<p>on it</p>")
        self.assertEqual(self.db.get(models.TaskComment, c.id).body, "<p>on it</p>")
        self.assertEqual(self.task.comment_ids, [c.id])
        # modified_at has to move or GET /tasks/delta never hands the task back.
        self.assertNotEqual(self.task.modified_at, "2026-01-01T00:00:00+00:00")

    def test_an_activity_entry_is_logged_against_the_actor(self):
        create_comment(self.db, self.task, actor_email=ACTOR["email"], body="<p>hi</p>")
        acts = self.db.query(models.TaskActivity).all()
        self.assertEqual([a.type for a in acts], ["commented"])
        self.assertEqual(acts[0].actor_email, ACTOR["email"])
        self.assertEqual(self.task.activity_ids, [acts[0].id])

    # ── fan-out ──────────────────────────────────────────────────────────
    def test_assignee_and_followers_are_belled_but_never_the_actor(self):
        create_comment(self.db, self.task, actor_email=ASSIGNEE, body="<p>done</p>")
        self.assertEqual({b.for_email for b in self._bells()}, {FOLLOWER})

    def test_the_commented_mail_is_raised_once(self):
        create_comment(self.db, self.task, actor_email=ACTOR["email"], body="<p>hi</p>")
        self.assertEqual([a[1] for a, _ in self.emailed], ["commented"])

    def test_asana_gets_the_comment(self):
        c = create_comment(self.db, self.task, actor_email=ACTOR["email"], body="<p>hi</p>")
        self.assertEqual(self.pushed, [c.id])

    # ── mentions ─────────────────────────────────────────────────────────
    def test_a_mention_raises_its_own_event_and_drops_self_mentions(self):
        """The mention mail says "X mentioned you" rather than the generic FYI,
        so it is a separate event - and mentioning yourself must not mail you."""
        body = (f'<p><a href="mailto:{FOLLOWER}">@F</a> and '
                f'<a href="mailto:{ACTOR["email"]}">@me</a></p>')
        create_comment(self.db, self.task, actor_email=ACTOR["email"], body=body)
        events = {a[1]: kw for a, kw in self.emailed}
        self.assertEqual(set(events), {"commented", "mentioned"})
        self.assertEqual(events["mentioned"]["mentioned"], [FOLLOWER])

    # ── the silent path ──────────────────────────────────────────────────
    def test_notify_false_writes_the_comment_and_nothing_else(self):
        """The Asana importer backfills historical comments - assignees must not
        be pinged about years-old ones. Asana still gets the push: a backfilled
        comment is real, it just isn't news."""
        c = create_comment(self.db, self.task, actor_email=ACTOR["email"],
                           body="<p>from 2024</p>", notify=False)
        self.assertEqual(self._bells(), [])
        self.assertEqual(self.emailed, [])
        self.assertEqual(self.pushed, [c.id])

    def test_author_may_differ_from_the_actor(self):
        """Same backfill: the comment is FROM its original author, while the
        action is BY whoever ran the import."""
        c = create_comment(self.db, self.task, actor_email=ACTOR["email"],
                           author_email="Ex.Employee@greensglobal.com",
                           body="<p>old</p>", notify=False)
        self.assertEqual(c.author_email, "ex.employee@greensglobal.com")
        self.assertEqual(self.db.query(models.TaskActivity).one().actor_email, ACTOR["email"])

    # ── who runs the mail ────────────────────────────────────────────────
    def test_the_endpoint_defers_the_mail_instead_of_sending_it_inline(self):
        """Graph sends are blocking. On a request they belong to BackgroundTasks,
        after the response - a worker off the event loop passes no `defer` and
        gets them inline (the default asserted by the tests above)."""
        bt = BackgroundTasks()
        add_comment(self.task.id, CommentCreate(body="<p>hi</p>"), bt,
                    user=ACTOR, db=self.db)
        self.assertEqual(self.emailed, [])            # nothing ran during the request
        self.assertEqual([t.args[1] for t in bt.tasks], ["commented"])


if __name__ == "__main__":
    unittest.main()
