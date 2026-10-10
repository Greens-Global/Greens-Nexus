"""
Comment threads, reactions and assigned comments (Oct 2026).

A reply joins its root's thread (a reply to a reply too), the thread's
earlier voices are told, a reaction toggles and tells the author once, an
assigned comment is an action item with its own bell and email that the
author, the assignee or an editor can resolve, and a root with replies is
not something its author can take down alone.

Uses a throwaway sqlite file. No network - the mail send is stubbed.

Run with: python -m unittest test_task_comment_threads -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402
from routers.tasks import (  # noqa: E402
    add_comment, edit_comment, delete_comment, react_to_comment, list_comments,
    CommentCreate, CommentUpdate, ReactionBody,
)

MANAGER = {"email": "boss@greensglobal.com", "level": 3}
AUTHOR = {"email": "author@greensglobal.com", "level": 1}
REPLIER = {"email": "replier@greensglobal.com", "level": 1}
ASSIGNEE = {"email": "assignee@greensglobal.com", "level": 1}
READER = {"email": "reader@greensglobal.com", "level": 1}


class CommentThreadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.TaskActivity, models.TaskProject,
                  models.TaskNotification, models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()
        # A restricted project: AUTHOR and REPLIER edit, ASSIGNEE comments, READER views.
        self.project = models.TaskProject(
            id=gen_id(), name="P", access_level="restricted", owner_email=MANAGER["email"],
            member_emails=[AUTHOR["email"], REPLIER["email"], ASSIGNEE["email"], READER["email"]],
            member_roles={AUTHOR["email"]: "editor", REPLIER["email"]: "editor",
                          ASSIGNEE["email"]: "commenter", READER["email"]: "viewer"},
            created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.project)
        self.task = models.Task(id=gen_id(), title="Fix the pump", code="TASK-1", project_id=self.project.id,
                                access_level="restricted", assignee_email="", assignee_emails=[],
                                follower_emails=[], comment_ids=[], activity_ids=[],
                                created_at=now_iso(), modified_at=now_iso(), created_by=MANAGER["email"])
        self.db.add(self.task)
        self.db.commit()
        self.emailed = []
        self._real_notify = task_notify.notify_task_event
        task_notify.notify_task_event = lambda *a, **kw: self.emailed.append((a, kw))
        self.bg = BackgroundTasks()

    def tearDown(self):
        task_notify.notify_task_event = self._real_notify
        self.db.close()

    def _post(self, user, body="<p>hi</p>", **kw):
        return add_comment(self.task.id, CommentCreate(body=body, **kw), self.bg, user=user, db=self.db)

    def _bells(self, email):
        return self.db.query(models.TaskNotification).filter(models.TaskNotification.for_email == email).all()

    def _events(self, kind):
        # The endpoint defers emails through BackgroundTasks, which a unit test
        # never runs - the queued calls are what create_comment asked for.
        return [(t.args, t.kwargs) for t in self.bg.tasks if len(t.args) > 1 and t.args[1] == kind]

    # ── threads ─────────────────────────────────────────────────────────────
    def test_a_reply_joins_the_root_and_a_reply_to_a_reply_joins_the_same_thread(self):
        root = self._post(AUTHOR, "<p>Which pump?</p>")
        reply = self._post(REPLIER, "<p>The east one</p>", parent_id=root["id"])
        deeper = self._post(AUTHOR, "<p>Thanks</p>", parent_id=reply["id"])
        self.assertEqual(reply["parentId"], root["id"])
        self.assertEqual(deeper["parentId"], root["id"], "one level: a reply to a reply sits under the root")
        rows = list_comments(self.task.id, user=AUTHOR, db=self.db)
        self.assertEqual([r["parentId"] for r in rows], [None, root["id"], root["id"]])

    def test_a_reply_to_a_comment_on_another_task_is_refused(self):
        other = models.Task(id=gen_id(), title="Other", code="TASK-2", comment_ids=[], activity_ids=[],
                            created_at=now_iso(), modified_at=now_iso())
        self.db.add(other)
        self.db.commit()
        stray = models.TaskComment(id=gen_id(), task_id=other.id, author_email=AUTHOR["email"], body="x",
                                   created_at=now_iso())
        self.db.add(stray)
        self.db.commit()
        with self.assertRaises(HTTPException) as cm:
            self._post(AUTHOR, parent_id=stray.id)
        self.assertEqual(cm.exception.status_code, 404)

    def test_a_reply_tells_the_threads_earlier_voices_but_not_the_actor(self):
        root = self._post(AUTHOR, "<p>Which pump?</p>")
        self._post(REPLIER, "<p>East</p>", parent_id=root["id"])
        self.assertEqual(len(self._bells(AUTHOR["email"])), 1, "the root's author hears the reply")
        self.assertEqual(self._bells(REPLIER["email"]), [])
        # A third voice: both earlier participants are told, each once.
        self._post(MANAGER, "<p>Agreed</p>", parent_id=root["id"])
        self.assertEqual(len(self._bells(AUTHOR["email"])), 2)
        self.assertEqual(len(self._bells(REPLIER["email"])), 1)
        a, kw = self._events("commented")[-1]
        self.assertEqual(set(kw["thread_participants"]), {AUTHOR["email"], REPLIER["email"]})
        self.assertTrue(kw["reply"])

    # ── reactions ───────────────────────────────────────────────────────────
    def test_reactions_toggle_and_tell_the_author_once(self):
        root = self._post(AUTHOR)
        out = react_to_comment(root["id"], ReactionBody(emoji="👍"), user=READER, db=self.db)
        self.assertEqual(out["reactions"], {"👍": [READER["email"]]})
        self.assertEqual(len(self._bells(AUTHOR["email"])), 1)
        out = react_to_comment(root["id"], ReactionBody(emoji="👍"), user=REPLIER, db=self.db)
        self.assertEqual(out["reactions"]["👍"], [READER["email"], REPLIER["email"]])
        out = react_to_comment(root["id"], ReactionBody(emoji="👍"), user=READER, db=self.db)
        self.assertEqual(out["reactions"]["👍"], [REPLIER["email"]])
        self.assertEqual(len(self._bells(AUTHOR["email"])), 2, "a toggle off is silent")
        react_to_comment(root["id"], ReactionBody(emoji="👍"), user=REPLIER, db=self.db)
        self.assertEqual(react_to_comment(root["id"], ReactionBody(emoji="🎉"), user=AUTHOR, db=self.db)["reactions"],
                         {"🎉": [AUTHOR["email"]]})
        self.assertEqual(len(self._bells(AUTHOR["email"])), 2, "reacting to your own comment tells nobody")

    def test_only_offered_reactions_are_accepted(self):
        root = self._post(AUTHOR)
        with self.assertRaises(HTTPException) as cm:
            react_to_comment(root["id"], ReactionBody(emoji="💩"), user=READER, db=self.db)
        self.assertEqual(cm.exception.status_code, 422)

    # ── assigned comments ───────────────────────────────────────────────────
    def test_an_assigned_comment_is_a_bell_and_its_own_email(self):
        c = self._post(AUTHOR, "<p>Please order the part</p>", assignee_email=ASSIGNEE["email"])
        self.assertEqual(c["assigneeId"], ASSIGNEE["email"])
        bells = self._bells(ASSIGNEE["email"])
        self.assertEqual([b.title for b in bells], ["A comment was assigned to you"])
        ev = self._events("comment_assigned")
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0][1]["comment_assignee"], ASSIGNEE["email"])

    def test_resolving_is_for_the_author_the_assignee_or_an_editor(self):
        c = self._post(AUTHOR, assignee_email=ASSIGNEE["email"])
        with self.assertRaises(HTTPException):
            edit_comment(c["id"], CommentUpdate(resolved=True), user=READER, db=self.db)
        out = edit_comment(c["id"], CommentUpdate(resolved=True), user=ASSIGNEE, db=self.db)
        self.assertTrue(out["resolvedAt"])
        self.assertEqual(out["resolvedBy"], ASSIGNEE["email"])
        self.assertEqual([b.title for b in self._bells(AUTHOR["email"])], ["Your comment was resolved"])
        acts = [a.type for a in self.db.query(models.TaskActivity).all()]
        self.assertIn("comment_resolved", acts)
        out = edit_comment(c["id"], CommentUpdate(resolved=False), user=REPLIER, db=self.db)   # an editor reopens
        self.assertFalse(out["resolvedAt"])
        self.assertIn("comment_reopened", [a.type for a in self.db.query(models.TaskActivity).all()])

    def test_handing_a_comment_on_tells_the_new_person_and_clearing_it_clears_resolution(self):
        c = self._post(AUTHOR)
        out = edit_comment(c["id"], CommentUpdate(assignee_email=ASSIGNEE["email"]), user=AUTHOR, db=self.db)
        self.assertEqual(out["assigneeId"], ASSIGNEE["email"])
        self.assertEqual(len(self._bells(ASSIGNEE["email"])), 1)
        with self.assertRaises(HTTPException):
            edit_comment(c["id"], CommentUpdate(assignee_email=READER["email"]), user=READER, db=self.db)
        edit_comment(c["id"], CommentUpdate(resolved=True), user=ASSIGNEE, db=self.db)
        out = edit_comment(c["id"], CommentUpdate(assignee_email=""), user=AUTHOR, db=self.db)
        self.assertFalse(out["assigneeId"])
        self.assertFalse(out["resolvedAt"])

    # ── deleting a thread ───────────────────────────────────────────────────
    def test_an_author_cannot_delete_a_root_with_replies_but_a_manager_removes_the_thread(self):
        root = self._post(AUTHOR)
        self._post(REPLIER, parent_id=root["id"])
        with self.assertRaises(HTTPException) as cm:
            delete_comment(root["id"], user=AUTHOR, db=self.db)
        self.assertEqual(cm.exception.status_code, 409)
        delete_comment(root["id"], user=MANAGER, db=self.db)
        self.assertEqual(self.db.query(models.TaskComment).count(), 0)
        self.db.refresh(self.task)
        self.assertEqual(self.task.comment_ids, [])


if __name__ == "__main__":
    unittest.main()
