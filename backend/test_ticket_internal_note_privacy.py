"""
Internal notes never reach the requester - through any door.

The Conversation tab already hid internal notes from the requester, but each
note also logs a "commented" activity row whose detail carries a preview of
the note ({"internal": true, "preview": "..."}), and GET
/task-tickets/{id}/activity handed every row to every participant - so the
requester (or a cc'd colleague, or a guest) read the desk's notes on the
Activity tab. These pin that the activity feed, the list's latestComment, the
bells and @mentions, and the Tasks workspace activity log all follow the
Conversation tab's rule (_sees_internal).

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.
Run on its own: python -m pytest test_ticket_internal_note_privacy.py
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks

import database
import models
from routers.task_util import log_activity, now_iso
from routers import tasks as TK
from routers import tickets as T

REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
AGENT = {"email": "agent@greensglobal.com", "level": 1}
AGENT2 = "agent2@greensglobal.com"
WATCHER = {"email": "watcher@greensglobal.com", "level": 1}   # cc'd, no desk grant
DESK = {AGENT["email"], AGENT2}

SECRET = "Requester is on a final warning, do not escalate"
PUBLIC = "Can you send a photo of the error?"


def mention(email, name):
    return f'<p>fyi <a href="mailto:{email}">@{name}</a></p>'


class InternalNotePrivacyTests(unittest.TestCase):
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
        auth._grants_for = lambda email, db: ({"tickets": 99} if (email or "").lower() in DESK else {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.TicketTeamsMessage,
                  models.NexusNotification, models.TaskNotification):
            self.db.query(m).delete()
        self.db.add(models.TaskTicket(id="t1", code="000041", subject="Laptop will not boot", status="open",
                                      priority="medium", requester_email=REQUESTER["email"],
                                      watcher_emails=[WATCHER["email"]],
                                      created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _comment(self, body, internal=False, user=AGENT):
        return T.add_ticket_comment("t1", T.TicketCommentBody(body=body, internal=internal),
                                    BackgroundTasks(), user=user, db=self.db)

    def _activity(self, user):
        return T.list_ticket_activity("t1", user=user, db=self.db)

    def _previews(self, user):
        out = []
        for a in self._activity(user):
            if a["type"] == "commented" and a["detail"].startswith("{"):
                out.append(json.loads(a["detail"])["preview"])
        return out

    def _bells(self, who):
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == who).all())

    def _both(self):
        self._comment(f"<p>{PUBLIC}</p>")
        self._comment(f"<p>{SECRET}</p>", internal=True)

    # ── the Activity tab ─────────────────────────────────────────────────────
    def test_requester_sees_the_public_reply_but_not_the_internal_note(self):
        self._both()
        previews = self._previews(REQUESTER)
        self.assertTrue(any(PUBLIC in p for p in previews), previews)
        self.assertFalse(any(SECRET in p for p in previews), previews)
        self.assertNotIn(SECRET, json.dumps(self._activity(REQUESTER)))

    def test_a_ccd_watcher_does_not_see_the_internal_note_either(self):
        self._both()
        self.assertNotIn(SECRET, json.dumps(self._activity(WATCHER)))

    def test_a_guest_never_sees_the_internal_note(self):
        self._both()
        guest = {"email": WATCHER["email"], "level": 1, "external": True}
        self.assertNotIn(SECRET, json.dumps(self._activity(guest)))

    def test_the_desk_sees_both(self):
        self._both()
        previews = self._previews(AGENT)
        self.assertTrue(any(PUBLIC in p for p in previews), previews)
        self.assertTrue(any(SECRET in p for p in previews), previews)

    def test_a_desk_member_on_their_own_ticket_follows_the_conversation_rule(self):
        # Same rule as list_ticket_comments: a desk member who raised the
        # ticket (and is not working it) does not see its internal notes.
        self.db.query(models.TaskTicket).filter(models.TaskTicket.id == "t1").update(
            {"requester_email": AGENT2})
        self.db.commit()
        self._both()
        raiser = {"email": AGENT2, "level": 1}
        self.assertNotIn(SECRET, json.dumps(self._activity(raiser)))
        comments = T.list_ticket_comments("t1", user=raiser, db=self.db)
        self.assertFalse(any(SECRET in c["body"] for c in comments))

    def test_legacy_plain_text_and_other_rows_are_kept(self):
        log_activity(self.db, type="commented", actor_email=AGENT["email"], entity_kind="ticket",
                     entity_id="t1", entity_code="000041", entity_title="x", detail="commented")
        log_activity(self.db, type="status_changed", actor_email=AGENT["email"], entity_kind="ticket",
                     entity_id="t1", entity_code="000041", entity_title="x", detail="{not json")
        self.db.commit()
        details = [a["detail"] for a in self._activity(REQUESTER)]
        self.assertIn("commented", details)
        self.assertIn("{not json", details)

    def test_is_internal_activity_parser(self):
        self.assertTrue(T._is_internal_activity(json.dumps({"internal": True, "preview": "x"})))
        self.assertFalse(T._is_internal_activity(json.dumps({"internal": False, "preview": "x"})))
        self.assertFalse(T._is_internal_activity("changed status to Open"))
        self.assertFalse(T._is_internal_activity("{broken"))
        self.assertFalse(T._is_internal_activity("[1, 2]"))
        self.assertFalse(T._is_internal_activity(None))

    # ── the list's Latest Comment column ─────────────────────────────────────
    def test_latest_comment_for_the_requester_is_never_internal(self):
        self._both()   # the internal note is the newest
        [row] = T.list_tickets(mine=False, user=REQUESTER, db=self.db)
        self.assertIsNotNone(row["latestComment"])
        self.assertFalse(row["latestComment"]["internal"])
        self.assertIn(PUBLIC, row["latestComment"]["preview"])
        self.assertNotIn(SECRET, json.dumps(row))

    def test_latest_comment_for_the_desk_can_be_internal(self):
        self._both()
        row = next(r for r in T.list_tickets(mine=False, user=AGENT, db=self.db) if r["id"] == "t1")
        self.assertTrue(row["latestComment"]["internal"])

    def test_update_ticket_reply_row_never_carries_an_internal_latest_comment_to_the_requester(self):
        self._comment(f"<p>{PUBLIC}</p>")
        self._comment(f"<p>{SECRET}</p>", internal=True)
        d = T._with_latest_comment(self.db, self.db.get(models.TaskTicket, "t1"), REQUESTER, {})
        self.assertIn(PUBLIC, d["latestComment"]["preview"])

    # ── bells and @mentions ──────────────────────────────────────────────────
    def test_an_internal_note_bells_only_the_desk(self):
        self.db.query(models.TaskTicket).filter(models.TaskTicket.id == "t1").update(
            {"watcher_emails": [WATCHER["email"], AGENT2]})
        self.db.commit()
        self._comment(f"<p>{SECRET}</p>", internal=True)
        self.assertEqual(self._bells(REQUESTER["email"]), [])
        self.assertEqual(self._bells(WATCHER["email"]), [])
        self.assertEqual(len(self._bells(AGENT2)), 1)

    def test_mentioning_the_requester_in_an_internal_note_tells_them_nothing(self):
        self._comment(mention(REQUESTER["email"], "Requester"), internal=True)
        self.assertEqual(self._bells(REQUESTER["email"]), [])

    def test_mentioning_a_non_desk_colleague_in_an_internal_note_does_not_add_them(self):
        outsider = "outsider@greensglobal.com"
        self._comment(mention(outsider, "Outsider"), internal=True)
        t = self.db.get(models.TaskTicket, "t1")
        self.assertNotIn(outsider, [e.lower() for e in (t.watcher_emails or [])])
        self.assertEqual(self._bells(outsider), [])

    def test_mentioning_a_desk_colleague_in_an_internal_note_still_works(self):
        self._comment(mention(AGENT2, "Agent Two"), internal=True)
        t = self.db.get(models.TaskTicket, "t1")
        self.assertIn(AGENT2, [e.lower() for e in (t.watcher_emails or [])])
        self.assertEqual(len(self._bells(AGENT2)), 1)

    def test_a_public_mention_of_a_non_desk_colleague_is_unchanged(self):
        outsider = "outsider@greensglobal.com"
        self._comment(mention(outsider, "Outsider"))
        t = self.db.get(models.TaskTicket, "t1")
        self.assertIn(outsider, [e.lower() for e in (t.watcher_emails or [])])
        self.assertEqual(len(self._bells(outsider)), 1)

    # ── the Tasks workspace Activity Log ─────────────────────────────────────
    def test_the_tasks_workspace_activity_log_carries_no_ticket_rows(self):
        self._both()
        log_activity(self.db, type="created", actor_email=AGENT["email"], entity_kind="task",
                     entity_id="task-1", entity_code="1", entity_title="A task", detail="created")
        self.db.commit()
        rows = TK.global_activity(limit=500, db=self.db)
        self.assertTrue(any(r["entityId"] == "task-1" for r in rows))
        self.assertFalse(any(r["entityKind"] == "ticket" for r in rows))
        self.assertNotIn(SECRET, json.dumps(rows))


if __name__ == "__main__":
    unittest.main()
