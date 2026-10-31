"""
The desk's Needs Reply queue (Neil, 10/31/2026): every row of GET /task-tickets
carries `needsReply`, worked out here from the latest PUBLIC comment the list
already fetches - so the desk, the phone strip and a saved view all agree.

A ticket needs a reply when it is live, not paused, not waiting for an
approval, not something its own assignee filed for themselves, and either
nobody from the desk has answered yet (no first response) or the requester
wrote last.

Uses a throwaway sqlite file. No network.
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
from routers.task_util import gen_id, now_iso
from routers import tickets as T

ADMIN = {"email": "admin@greensglobal.com", "level": 4}
REQ = "req@greensglobal.com"
AGENT = "agent@greensglobal.com"


class NeedsReplyRuleTests(unittest.TestCase):
    """_needs_reply on its own: the rule, case by case."""

    def _t(self, **over):
        base = dict(status="open", approval_status="none", requester_email=REQ,
                    assignee_email=AGENT, first_response_at="", sla_paused_at="")
        base.update(over)
        return models.TaskTicket(**base)

    def test_no_first_response_yet(self):
        self.assertTrue(T._needs_reply(self._t(), None))

    def test_requester_wrote_last(self):
        t = self._t(first_response_at="2026-10-01T10:00:00")
        self.assertTrue(T._needs_reply(t, {"authorId": REQ}))

    def test_desk_wrote_last(self):
        t = self._t(first_response_at="2026-10-01T10:00:00")
        self.assertFalse(T._needs_reply(t, {"authorId": AGENT}))
        self.assertFalse(T._needs_reply(t, None))

    def test_requester_case_does_not_matter(self):
        t = self._t(first_response_at="2026-10-01T10:00:00", requester_email=REQ.upper())
        self.assertTrue(T._needs_reply(t, {"authorId": REQ}))

    def test_paused_approval_and_closed_never(self):
        self.assertFalse(T._needs_reply(self._t(sla_paused_at="2026-10-01T10:00:00"), None))
        self.assertFalse(T._needs_reply(self._t(approval_status="pending"), None))
        self.assertFalse(T._needs_reply(self._t(status="resolved"), None))
        self.assertFalse(T._needs_reply(self._t(status="closed"), None))

    def test_self_filed_and_worked_never(self):
        self.assertFalse(T._needs_reply(self._t(requester_email=AGENT, assignee_email=AGENT), None))

    def test_unassigned_still_counts(self):
        self.assertTrue(T._needs_reply(self._t(assignee_email=""), None))

    def test_new_is_live(self):
        # ticket_to_dict normalizes "new" to "open"; the rule must agree it is live.
        self.assertTrue(T._needs_reply(self._t(status="new", first_response_at=""), None))

    def test_no_requester_and_an_authorless_comment_is_not_the_requester(self):
        # A mail-in / guest row: "" == "" must not read as "the requester wrote last".
        t = self._t(requester_email="", first_response_at="2026-10-01T10:00:00")
        self.assertFalse(T._needs_reply(t, {"authorId": ""}))
        self.assertFalse(T._needs_reply(t, {"authorId": AGENT}))

    def test_a_third_party_writing_last_is_not_the_requester(self):
        # The filer (created_by) or a watcher writing last reads as the desk's
        # side - the flag follows counts_as_response (anyone but the requester
        # answers), not _resume_on_requester_reply's wider "requester" set.
        t = self._t(first_response_at="2026-10-01T10:00:00", created_by_email="filer@greensglobal.com")
        self.assertFalse(T._needs_reply(t, {"authorId": "filer@greensglobal.com"}))
        self.assertFalse(T._needs_reply(t, {"authorId": "watcher@greensglobal.com"}))


class NeedsReplyOnTheListTests(unittest.TestCase):
    """GET /task-tickets carries the flag, reading the public thread only."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _ticket(self, subject, **over):
        fields = dict(id=gen_id(), code=f"TIC-{gen_id()[:4]}", subject=subject, status="open",
                      priority="medium", requester_email=REQ, assignee_email=AGENT,
                      first_response_at="2026-10-01T10:00:00", created_at=now_iso(), modified_at=now_iso())
        fields.update(over)
        t = models.TaskTicket(**fields)
        self.db.add(t)
        self.db.commit()
        return t

    def _comment(self, t, author, when, internal=False):
        self.db.add(models.TaskComment(id=gen_id(), task_id=t.id, author_email=author, body="x",
                                       created_at=when, internal=internal))
        self.db.commit()

    def _flags(self):
        return {r["subject"]: r["needsReply"] for r in T.list_tickets(mine=False, user=ADMIN, db=self.db)}

    def test_every_row_carries_the_flag(self):
        self._ticket("fresh", first_response_at="")
        self._ticket("answered")
        flags = self._flags()
        self.assertEqual(flags, {"fresh": True, "answered": False})

    def test_requester_reply_after_the_desk_turns_it_on(self):
        t = self._ticket("thread")
        self._comment(t, AGENT, "2026-10-02T10:00:00")
        self.assertEqual(self._flags()["thread"], False)
        self._comment(t, REQ, "2026-10-03T10:00:00")
        self.assertEqual(self._flags()["thread"], True)

    def test_an_internal_note_after_the_requester_does_not_count_as_a_reply(self):
        t = self._ticket("noted")
        self._comment(t, REQ, "2026-10-03T10:00:00")
        self._comment(t, AGENT, "2026-10-04T10:00:00", internal=True)
        # The public thread still ends on the requester - the desk owes an answer.
        self.assertEqual(self._flags()["noted"], True)

    def test_closed_and_pending_approval_rows_are_off(self):
        self._ticket("closed", status="closed", first_response_at="")
        self._ticket("gated", approval_status="pending", first_response_at="")
        self.assertEqual(self._flags(), {"closed": False, "gated": False})

    def test_the_support_list_carries_the_flag_too(self):
        # ?mine=true (the Support page) reads the same rule: "the desk owes you
        # an answer" is harmless to the requester and keeps one dict shape.
        self._ticket("mine", first_response_at="")
        rows = T.list_tickets(mine=True, user={"email": REQ, "level": 1}, db=self.db)
        self.assertEqual([(r["subject"], r["needsReply"]) for r in rows], [("mine", True)])

    def test_a_single_ticket_response_carries_the_flag(self):
        # PATCH replaces the row in the browser's list; without the flag the
        # client would fall back on latestComment - the desk's internal-
        # inclusive one - and an internal note would read as the answer.
        t = self._ticket("patched")
        self._comment(t, REQ, "2026-10-03T10:00:00")
        self._comment(t, AGENT, "2026-10-04T10:00:00", internal=True)
        out = T.update_ticket(t.id, T.TicketUpdate(priority="high"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertEqual(out["priority"], "high")
        self.assertTrue(out["needsReply"])
        self.assertTrue(out["latestComment"]["internal"])   # the desk still sees its note
        self._comment(t, AGENT, "2026-10-05T10:00:00")
        out = T.update_ticket(t.id, T.TicketUpdate(priority="medium"), BackgroundTasks(), user=ADMIN, db=self.db)
        self.assertFalse(out["needsReply"])


if __name__ == "__main__":
    unittest.main()
