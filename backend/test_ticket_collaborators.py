"""
Collaborators on a ticket (Oct 14 2026, Sagar: "a collaborator option on the
tickets as in the task module"). They are the ticket's watcher_emails: they
can open it, reply and hear about it. Anyone who may edit the ticket at all
may add or remove them - the requester after it left Open, a desk agent
triaging it, even someone locked out of an in-progress ticket's fields - and
each one added gets a bell.

Uses a throwaway sqlite file. No network.
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
ASSIGNEE = {"email": "assignee@greensglobal.com", "level": 1}
AGENT = {"email": "agent@greensglobal.com", "level": 1}
NEW = "urmi@greensglobal.com"


class TicketCollaboratorTests(unittest.TestCase):
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
        auth._grants_for = lambda email, db: ({"tickets": 99} if email in (ASSIGNEE["email"], AGENT["email"]) else {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskNotification, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    def _ticket(self, status, assignee="", watchers=None):
        t = models.TaskTicket(id="t1", code="TIC-1", subject="Printer down", status=status,
                              priority="medium", requester_email=REQUESTER["email"],
                              assignee_email=assignee, watcher_emails=watchers or [],
                              created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    def _update(self, user, **fields):
        T.update_ticket("t1", T.TicketUpdate(**fields), BackgroundTasks(), user=user, db=self.db)
        self.db.expire_all()
        return self.db.get(models.TaskTicket, "t1")

    def test_the_requester_adds_one_after_the_ticket_left_open(self):
        self._ticket("waiting_user")
        t = self._update(REQUESTER, watcher_emails=[NEW])
        self.assertEqual(t.watcher_emails, [NEW])

    def test_a_desk_agent_adds_one_while_triaging(self):
        self._ticket("open")
        t = self._update(AGENT, watcher_emails=[NEW])
        self.assertEqual(t.watcher_emails, [NEW])

    def test_collaborators_stay_editable_while_it_is_locked_to_its_assignee(self):
        self._ticket("in_progress", assignee=ASSIGNEE["email"])
        t = self._update(REQUESTER, watcher_emails=[NEW])
        self.assertEqual(t.watcher_emails, [NEW])
        # ...but nothing else is, and the refusal still says why.
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, priority="high")
        self.assertIn("in progress and assigned", ctx.exception.detail)

    def test_addresses_are_cleaned_and_kept_once(self):
        self._ticket("open")
        t = self._update(AGENT, watcher_emails=[" Urmi@GreensGlobal.com ", NEW, ""])
        self.assertEqual(t.watcher_emails, [NEW])

    def test_each_one_added_gets_a_bell_and_the_trail_says_so(self):
        self._ticket("open", watchers=["old@greensglobal.com"])
        self._update(AGENT, watcher_emails=[NEW, AGENT["email"]])
        bells = self.db.query(models.TaskNotification).filter(models.TaskNotification.kind == "ticket_collaborator").all()
        self.assertEqual([b.for_email for b in bells], [NEW])   # not the agent who added themselves
        kinds = {a.type for a in self.db.query(models.TaskActivity).all()}
        self.assertTrue({"watcher_added", "watcher_removed"} <= kinds)


if __name__ == "__main__":
    unittest.main()
