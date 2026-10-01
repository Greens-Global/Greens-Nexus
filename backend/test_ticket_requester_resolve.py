"""
The requester can mark their OWN ticket Resolved while it is still Open or
being worked (Neil, Oct 1 2026: "a colleague helped me") - with an optional
"What fixed it?" comment, posted as a public reply. Nothing else opens up:
they still cannot set other statuses, or touch fields they could not before.

Also covers the list's Latest Comment column: one public reply per ticket for
the requester (internal notes never leak), the desk sees internal ones.

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
BYSTANDER = {"email": "bystander@greensglobal.com", "level": 1}


class RequesterResolveTests(unittest.TestCase):
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
        auth._grants_for = lambda email, db: ({"tickets": 99} if email in (ASSIGNEE["email"], MANAGER["email"]) else {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    def _ticket(self, status, assignee="", tid="t1"):
        t = models.TaskTicket(id=tid, code=f"TIC-{tid}", subject="Printer jam", status=status,
                              priority="medium", requester_email=REQUESTER["email"],
                              assignee_email=assignee, created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    def _update(self, user, tid="t1", **fields):
        return T.update_ticket(tid, T.TicketUpdate(**fields), BackgroundTasks(), user=user, db=self.db)

    def _comments(self, tid="t1"):
        return self.db.query(models.TaskComment).filter(models.TaskComment.task_id == tid).all()

    # ── the requester may resolve ───────────────────────────────────────────
    def test_requester_resolves_an_open_ticket_without_a_comment(self):
        self._ticket("open")
        out = self._update(REQUESTER, status="resolved")
        self.assertEqual(out["status"], "resolved")
        self.assertTrue(out["resolvedAt"])
        self.assertEqual(out["resolutionNote"], "Resolved by the requester.")
        self.assertEqual(self._comments(), [])

    def test_requester_resolves_an_in_progress_ticket_someone_else_holds(self):
        """In progress + assigned locks the requester out of every FIELD - but
        marking it Resolved is still theirs to do."""
        self._ticket("in_progress", assignee=ASSIGNEE["email"])
        out = self._update(REQUESTER, status="resolved", comment="<p>Sagar fixed the cable</p>")
        self.assertEqual(out["status"], "resolved")
        self.assertIn("Sagar fixed the cable", out["resolutionNote"])

    def test_the_comment_is_posted_as_a_public_reply(self):
        self._ticket("open")
        self._update(REQUESTER, status="resolved", comment="Restarted it", comment_internal=True)
        rows = self._comments()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].body, "Restarted it")
        self.assertFalse(rows[0].internal)
        self.assertEqual(rows[0].author_email, REQUESTER["email"])

    def test_resolving_is_on_the_audit_trail(self):
        self._ticket("waiting_user")
        self._update(REQUESTER, status="resolved")
        kinds = [a.type for a in self.db.query(models.TaskActivity)
                 .filter(models.TaskActivity.entity_id == "t1").all()]
        self.assertIn("status_changed", kinds)
        self.assertIn("resolution_note", kinds)

    def test_a_written_note_is_kept_as_given(self):
        self._ticket("open")
        out = self._update(REQUESTER, status="resolved", resolution_note="Turned it off and on")
        self.assertEqual(out["resolutionNote"], "Turned it off and on")

    # ── and nothing more ────────────────────────────────────────────────────
    def test_requester_still_cannot_set_other_statuses(self):
        for start, target in (("open", "in_progress"), ("open", "on_hold"), ("in_progress", "waiting_vendor"),
                              ("open", "closed"), ("closed", "resolved")):
            with self.subTest(start=start, target=target):
                self.db.query(models.TaskTicket).delete()
                self.db.commit()
                self._ticket(start, assignee=ASSIGNEE["email"] if start == "in_progress" else "")
                with self.assertRaises(HTTPException) as ctx:
                    self._update(REQUESTER, status=target)
                self.assertEqual(ctx.exception.status_code, 403)

    def test_resolving_does_not_open_up_other_fields(self):
        self._ticket("in_progress", assignee=ASSIGNEE["email"])
        with self.assertRaises(HTTPException) as ctx:
            self._update(REQUESTER, status="resolved", priority="urgent")
        self.assertEqual(ctx.exception.status_code, 403)
        t = self.db.get(models.TaskTicket, "t1")
        self.assertEqual((t.status, t.priority), ("in_progress", "medium"))

    def test_someone_elses_ticket_still_refused(self):
        self._ticket("open")
        with self.assertRaises(HTTPException) as ctx:
            self._update(BYSTANDER, status="resolved")
        self.assertEqual(ctx.exception.status_code, 403)

    def test_the_desk_still_needs_a_written_resolution(self):
        self._ticket("in_progress", assignee=ASSIGNEE["email"])
        with self.assertRaises(HTTPException) as ctx:
            self._update(ASSIGNEE, status="resolved")
        self.assertEqual(ctx.exception.status_code, 400)
        out = self._update(MANAGER, status="resolved", resolution_note="Swapped the toner")
        self.assertEqual(out["status"], "resolved")

    # ── latest comment on the list ──────────────────────────────────────────
    def test_latest_comment_never_leaks_an_internal_note_to_the_requester(self):
        self._ticket("open")
        self._ticket("open", tid="t2")
        add = T.add_ticket_comment
        add("t1", T.TicketCommentBody(body="<p>Looking into it</p>"), BackgroundTasks(), user=MANAGER, db=self.db)
        add("t1", T.TicketCommentBody(body="desk only", internal=True), BackgroundTasks(), user=MANAGER, db=self.db)
        mine = {d["id"]: d for d in T.list_tickets(mine=True, user=REQUESTER, db=self.db)}
        self.assertEqual(mine["t1"]["latestComment"]["preview"], "Looking into it")
        self.assertFalse(mine["t1"]["latestComment"]["internal"])
        self.assertEqual(mine["t1"]["latestComment"]["authorId"], MANAGER["email"])
        self.assertIsNone(mine["t2"]["latestComment"])
        desk = {d["id"]: d for d in T.list_tickets(user=MANAGER, db=self.db)}
        self.assertEqual(desk["t1"]["latestComment"]["preview"], "desk only")
        self.assertTrue(desk["t1"]["latestComment"]["internal"])

    def test_the_update_reply_carries_the_latest_comment(self):
        self._ticket("open")
        out = self._update(REQUESTER, status="resolved", comment="<p>All good now &amp; working</p>")
        self.assertEqual(out["latestComment"]["preview"], "All good now & working")


if __name__ == "__main__":
    unittest.main()
