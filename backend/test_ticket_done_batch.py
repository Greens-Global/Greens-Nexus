"""
The ticket drawer holds every change until Done and sends them as ONE save
(Pranshu, Oct 1 2026: "till the time I click on Done it should not update the
ticket, nor post the mail or message to the requester... all details should
get saved and trigger the message and mails").

So one PATCH carrying priority + status + assignee + a reply must record all
of it and queue exactly ONE email and ONE Teams DM to the requester - with
the reply riding inside that email, not in a second one.

Uses a throwaway sqlite file. No network: BackgroundTasks are inspected, never run.
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import database
import models
from routers.task_util import now_iso
from routers import tickets as T

REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
AGENT = {"email": "agent@greensglobal.com", "level": 3}
OTHER = "other.agent@greensglobal.com"


class DoneBatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        import auth
        self._grants = auth._grants_for
        auth._grants_for = lambda email, db: ({"tickets": 99} if email == AGENT["email"] else {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TicketTeamsMessage):
            self.db.query(m).delete()
        self.db.commit()
        self.db.add(models.TaskTicket(id="t1", code="000001", subject="Printer jam", status="open",
                                      priority="medium", requester_email=REQUESTER["email"],
                                      created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    def _save(self, user, **fields):
        bg = BackgroundTasks()
        T.update_ticket("t1", T.TicketUpdate(**fields), bg, user=user, db=self.db)
        emails = [t for t in bg.tasks if t.func is T.notify_ticket_event]
        dms = [t for t in bg.tasks if t.func is T._deliver_teams_dm]
        return emails, dms

    def _comments(self):
        return self.db.query(models.TaskComment).filter_by(task_id="t1").all()

    def test_fields_and_a_reply_save_together_with_one_email_and_one_dm(self):
        emails, dms = self._save(AGENT, priority="high", status="in_progress",
                                 assignee_email=OTHER, comment="<p>On it - swapping the toner.</p>")
        t = self.db.get(models.TaskTicket, "t1")
        self.assertEqual((t.priority, t.status, t.assignee_email), ("high", "in_progress", OTHER))
        self.assertEqual(len(self._comments()), 1)
        self.assertEqual(len(emails), 1)
        self.assertEqual(len(dms), 1)
        self.assertEqual(self.db.query(models.TicketTeamsMessage).count(), 1)
        # The reply rides in the one email that went out.
        self.assertIn("swapping the toner", emails[0].kwargs.get("latest_comment", ""))

    def test_a_status_and_priority_change_with_a_reply_sends_only_the_reply(self):
        # Oct 1 (Neil): status moves and priority are not mailed to the
        # requester any more - the reply that came with them is. (Was: one
        # "updated" email naming the status and priority changes.)
        emails, dms = self._save(AGENT, priority="high", status="pending", comment="<p>Waiting on parts.</p>")
        self.assertEqual(len(emails), 1)
        self.assertEqual(emails[0].args[1], "updated")
        self.assertEqual(emails[0].kwargs["update_kind"], "New comment added")
        self.assertIn("Waiting on parts", emails[0].kwargs["latest_comment"])
        self.assertEqual(len(dms), 1)

    def test_a_status_and_priority_change_alone_sends_nothing(self):
        emails, dms = self._save(AGENT, priority="high", status="pending")
        self.assertEqual((emails, dms), ([], []))

    def test_a_reply_alone_still_sends_the_conversation_email(self):
        emails, dms = self._save(AGENT, comment="<p>Can you send a photo?</p>")
        self.assertEqual(len(self._comments()), 1)
        self.assertEqual(len(emails), 1)
        self.assertEqual(emails[0].kwargs["update_kind"], "New comment added")
        self.assertEqual(len(dms), 1)

    def test_an_internal_note_tells_the_requester_nothing(self):
        emails, dms = self._save(AGENT, comment="<p>Toner on backorder.</p>", comment_internal=True)
        self.assertEqual(len(self._comments()), 1)
        self.assertTrue(self._comments()[0].internal)
        self.assertEqual((emails, dms), ([], []))

    def test_an_empty_editor_is_not_a_reply(self):
        emails, dms = self._save(AGENT, comment="<p></p>")
        self.assertEqual(self._comments(), [])
        self.assertEqual((emails, dms), ([], []))

    def test_a_requester_reply_needs_no_field_scope(self):
        # Once picked up, the requester may not edit fields - but a reply
        # is only ever gated on being a participant.
        t = self.db.get(models.TaskTicket, "t1")
        t.status, t.assignee_email = "in_progress", OTHER
        self.db.commit()
        self._save(REQUESTER, comment="<p>Still jammed.</p>")
        self.assertEqual(len(self._comments()), 1)

    def test_an_outsider_cannot_reply_through_the_save(self):
        with self.assertRaises(HTTPException) as ctx:
            self._save({"email": "stranger@greensglobal.com", "level": 1}, comment="<p>hi</p>")
        self.assertEqual(ctx.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
