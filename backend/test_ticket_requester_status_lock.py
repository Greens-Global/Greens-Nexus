"""
A ticket's requester cannot jump status around directly - only close or
reopen it, and only once it is actually resolved/closed (Sep 10 2026,
Pranshu: "if the ticket is resolved then requester should get the option to
close the ticket or reopen the ticket. that's it").

Before this, a requester had unrestricted field access pre-in_progress
(_ticket_edit_scope), which let them set status to anything - "In Progress"
or "Resolved" with nobody actually working it, skipping the Mark Resolved/
Reopen flows that capture a resolution or a reason.

The assignee and a manager are untouched by this - only the pure requester
(not also the assignee, not privileged) is narrowed.

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
ASSIGNEE  = {"email": "assignee@greensglobal.com", "level": 1}
MANAGER   = {"email": "manager@greensglobal.com", "level": 3}


class RequesterStatusLockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket,):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _ticket(self, status, assignee=""):
        t = models.TaskTicket(id="t1", code="TIC-1", subject="s", status=status,
                              priority="medium", requester_email=REQUESTER["email"],
                              assignee_email=assignee, created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    def _update(self, user, **fields):
        return T.update_ticket("t1", T.TicketUpdate(**fields), BackgroundTasks(), user=user, db=self.db)

    # ── blocked for the requester ─────────────────────────────────────────
    def test_requester_cannot_jump_open_straight_to_resolved(self):
        self._ticket("open")
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, status="resolved", resolution="fixed")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_requester_cannot_jump_open_straight_to_in_progress(self):
        self._ticket("open")
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, status="in_progress")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_requester_cannot_reopen_an_open_ticket(self):
        """Reopen only makes sense from resolved/closed - not a real status
        to begin with."""
        self._ticket("open")
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, status="reopened", reopen_reason="not fixed")
        self.assertEqual(ctx.exception.status_code, 403)

    # ── allowed for the requester, resolved/closed only ───────────────────
    def test_requester_can_confirm_a_resolved_ticket_closed(self):
        self._ticket("resolved")
        out = self._update(REQUESTER, status="closed")
        self.assertEqual(out["status"], "closed")

    def test_requester_can_reopen_a_resolved_ticket(self):
        self._ticket("resolved")
        out = self._update(REQUESTER, status="reopened", reopen_reason="still broken")
        self.assertEqual(out["status"], "reopened")

    def test_requester_can_reopen_a_closed_ticket(self):
        self._ticket("closed")
        out = self._update(REQUESTER, status="reopened", reopen_reason="came back")
        self.assertEqual(out["status"], "reopened")

    def test_requester_cannot_close_a_closed_ticket_straight_to_resolved(self):
        self._ticket("closed")
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, status="resolved")
        self.assertEqual(ctx.exception.status_code, 403)

    # ── untouched: assignee and manager keep full status control ──────────
    def test_the_assignee_on_their_own_ticket_is_not_narrowed(self):
        """A requester who is ALSO the assignee (self-assigned) is working
        it, not just asking - full status control, same as any assignee."""
        self._ticket("open", assignee=REQUESTER["email"])
        out = self._update(REQUESTER, status="resolved", resolution="fixed")
        self.assertEqual(out["status"], "resolved")

    def test_a_manager_is_never_narrowed(self):
        self._ticket("open")
        out = self._update(MANAGER, status="resolved", resolution="fixed")
        self.assertEqual(out["status"], "resolved")


if __name__ == "__main__":
    unittest.main()
