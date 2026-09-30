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
        # The assignee and the manager work the desk: give them the tickets
        # grant the PATCH route checks for (the requester needs none - it is
        # their own ticket).
        import auth
        self._grants = auth._grants_for
        auth._grants_for = lambda email, db: ({"tickets": 99} if email in (ASSIGNEE["email"], MANAGER["email"]) else {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket,):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
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
        out = self._update(REQUESTER, status="closed", csat_rating=5)
        self.assertEqual(out["status"], "closed")
        self.assertEqual(out["csatRating"], 5)

    def test_confirming_needs_a_star_rating(self):
        """Neil, Sep 30: confirming a resolution rates whoever handled it,
        1-5 stars; the comment stays optional."""
        self._ticket("resolved")
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, status="closed")
        self.assertEqual(ctx.exception.status_code, 400)

    def test_requester_edits_only_while_open(self):
        self._ticket("open")
        self.assertEqual(self._update(REQUESTER, description="more detail")["description"], "more detail")

    def test_requester_cannot_edit_once_it_left_open(self):
        self._ticket("waiting_user")
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, description="more detail")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_someone_elses_ticket_is_refused_without_a_grant(self):
        self._ticket("open")
        with self.assertRaises(HTTPException) as ctx:
            self._update({"email": "bystander@greensglobal.com", "level": 1}, priority="high")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_resolving_needs_a_written_resolution(self):
        self._ticket("in_progress", assignee=ASSIGNEE["email"])
        with self.assertRaises(HTTPException) as ctx:
            self._update(ASSIGNEE, status="resolved", resolution="fixed")
        self.assertEqual(ctx.exception.status_code, 400)
        out = self._update(ASSIGNEE, status="resolved", resolution="fixed", resolution_note="Replaced the bulb")
        self.assertEqual(out["resolutionNote"], "Replaced the bulb")

    def test_assigning_an_open_ticket_moves_it_to_in_progress(self):
        self._ticket("open")
        out = self._update(MANAGER, assignee_email=ASSIGNEE["email"])
        self.assertEqual(out["status"], "in_progress")

    def test_the_requester_never_sees_an_internal_note(self):
        self._ticket("open")
        self.db.query(models.TaskComment).delete()
        self.db.commit()
        T.add_ticket_comment("t1", T.TicketCommentBody(body="desk only", internal=True), BackgroundTasks(), user=MANAGER, db=self.db)
        T.add_ticket_comment("t1", T.TicketCommentBody(body="hi there"), BackgroundTasks(), user=MANAGER, db=self.db)
        mine = [c["body"] for c in T.list_ticket_comments("t1", user=REQUESTER, db=self.db)]
        self.assertEqual(mine, ["hi there"])
        desk = [c["body"] for c in T.list_ticket_comments("t1", user=MANAGER, db=self.db)]
        self.assertEqual(sorted(desk), ["desk only", "hi there"])

    def test_a_reply_lights_the_dot_and_opening_it_clears_it(self):
        self._ticket("open")
        T.add_ticket_comment("t1", T.TicketCommentBody(body="any update?"), BackgroundTasks(), user=MANAGER, db=self.db)
        t = self.db.query(models.TaskTicket).get("t1")
        self.assertTrue(t.requester_update_at)
        self.assertFalse(t.requester_seen_at)
        T.mark_ticket_seen("t1", user=REQUESTER, db=self.db)
        self.db.refresh(t)
        self.assertGreaterEqual(t.requester_seen_at, t.requester_update_at)

    def test_an_update_by_someone_else_lights_the_requesters_dot(self):
        self._ticket("open")
        self.assertFalse(self._update(REQUESTER, description="x").get("requesterUpdateAt"))
        self.assertTrue(self._update(MANAGER, priority="high")["requesterUpdateAt"])

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
        out = self._update(REQUESTER, status="resolved", resolution="fixed", resolution_note="done")
        self.assertEqual(out["status"], "resolved")

    def test_a_manager_is_never_narrowed(self):
        self._ticket("open")
        out = self._update(MANAGER, status="resolved", resolution="fixed", resolution_note="done")
        self.assertEqual(out["status"], "resolved")


if __name__ == "__main__":
    unittest.main()
