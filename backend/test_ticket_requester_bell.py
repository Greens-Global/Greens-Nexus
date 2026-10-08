"""
The requester hears about every update to their ticket in the bell (Oct 1:
"Requester should get In-App Notifications into the notification bell for any
update on their tickets").

One bell per save, naming what changed - a status move, an assignment, a new
priority, edited details, a reply that came with them - plus a file attached
or the ticket sent for approval. Their own changes never bell them, and an
internal note never reaches them.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.
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
from routers.task_util import now_iso
from routers import tickets as T

REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
AGENT = {"email": "agent@greensglobal.com", "level": 3}
OTHER = "other.agent@greensglobal.com"


class RequesterBellTests(unittest.TestCase):
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
        for m in (models.TaskTicket, models.TaskComment, models.TicketTeamsMessage, models.TaskAttachment,
                  models.NexusNotification, models.TaskNotification, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="e-other", first_name="Olive", last_name="Agent", work_email=OTHER,
                                         status="active", deleted_at=""))
        self.db.add(models.TaskTicket(id="t1", code="000027", subject="Printer jam", status="open",
                                      priority="medium", requester_email=REQUESTER["email"],
                                      created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    def _save(self, user, **fields):
        T.update_ticket("t1", T.TicketUpdate(**fields), BackgroundTasks(), user=user, db=self.db)

    def _bells(self, who=REQUESTER["email"]):
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == who)
                .order_by(models.NexusNotification.created_at).all())

    def test_a_priority_change_alone_bells_the_requester(self):
        self._save(AGENT, priority="high")
        [b] = self._bells()
        self.assertEqual(b.title, "Your ticket was updated")
        self.assertIn("Ticket #27 · Printer jam", b.body)
        self.assertIn("Priority set to High", b.body)
        self.assertIn('"ticketId": "t1"', b.action)

    def test_an_assignment_names_who_has_it_in_the_status_bell(self):
        # Assigning an Open ticket also moves it to In Progress - one bell.
        self._save(AGENT, assignee_email=OTHER)
        [b] = self._bells()
        self.assertEqual(b.title, "Your ticket moved to In Progress")
        self.assertIn("Assigned to Olive Agent", b.body)

    def test_edited_details_are_named(self):
        self._save(AGENT, subject="Printer jam on floor 2", description="<p>More detail</p>")
        [b] = self._bells()
        self.assertIn("Updated the title and description", b.body)

    def test_a_save_with_a_reply_is_still_one_bell(self):
        self._save(AGENT, priority="high", status="pending", comment="<p>Waiting on parts.</p>")
        bells = self._bells()
        self.assertEqual(len(bells), 1, [b.title for b in bells])
        self.assertIn("new reply", bells[0].body)

    def test_a_reply_alone_keeps_its_own_bell(self):
        self._save(AGENT, comment="<p>Can you send a photo?</p>")
        [b] = self._bells()
        self.assertEqual(b.title, "New comment on a ticket")

    def test_an_internal_note_never_reaches_the_requester(self):
        self._save(AGENT, comment="<p>Toner on backorder.</p>", comment_internal=True)
        self.assertEqual(self._bells(), [])

    def test_resolving_says_resolved(self):
        self._save(AGENT, status="resolved", resolution_note="Replaced the toner.")
        [b] = self._bells()
        self.assertEqual(b.title, "Your ticket was Resolved")

    def test_the_requesters_own_changes_do_not_bell_them(self):
        self._save(REQUESTER, subject="Printer jam - urgent")
        self.assertEqual(self._bells(), [])

    def test_the_assignee_still_hears_about_a_status_move(self):
        t = self.db.get(models.TaskTicket, "t1")
        t.status, t.assignee_email = "in_progress", OTHER
        self.db.commit()
        self._save(AGENT, status="pending")
        self.assertEqual([b.title for b in self._bells(OTHER)], ["Ticket moved to Pending"])
        self.assertEqual(len(self._bells()), 1)

    def test_a_file_attached_by_the_desk_bells_the_requester(self):
        T.add_ticket_attachment("t1", T.TicketAttachmentBody(name="receipt.pdf", url=""), BackgroundTasks(),
                                user=AGENT, db=self.db)
        [b] = self._bells()
        self.assertIn('File attached: "receipt.pdf"', b.body)

    def test_the_requesters_own_attachment_does_not_bell_them(self):
        T.add_ticket_attachment("t1", T.TicketAttachmentBody(name="photo.png", url=""), BackgroundTasks(),
                                user=REQUESTER, db=self.db)
        self.assertEqual(self._bells(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
