"""Ticket-update Teams DM (Sept 2026) - the queue insert and the Graph
create-or-get-chat payload shape.

Throwaway sqlite, no network - the Graph call is mocked; _sweep/delivery are
exercised in teams_post.py's own retry loop and aren't re-tested here (same
scope teams_post.py's BOD/EOD half has today: no unit coverage of the retry
sweep itself, only of the pure logic around it).

Run with: python -m unittest test_ticket_teams_dm -v
"""
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch, MagicMock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_APP_URL", "https://nexus.test")

import atexit

import database
import models
from routers.tickets import _queue_requester_teams_dm
import teams_post

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


REQUESTER = "sagar.shoundik@greensglobal.com"
AGENT = "itadmin@greensglobal.com"


def _ticket(**over):
    t = models.TaskTicket(
        id=str(uuid.uuid4()), code="000042", subject="Printer jam",
        requester_email=REQUESTER, status="open", priority="medium",
    )
    for k, v in over.items():
        setattr(t, k, v)
    return t


class QueueingTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.query(models.TicketTeamsMessage).delete()
        self.db.commit()
        self.db.close()

    def test_an_agent_update_queues_a_dm_to_the_requester(self):
        t = _ticket()
        _queue_requester_teams_dm(self.db, t, AGENT)
        self.db.commit()
        rows = self.db.query(models.TicketTeamsMessage).filter_by(ticket_id=t.id).all()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row.agent_email, AGENT)
        self.assertEqual(row.requester_email, REQUESTER)
        self.assertIn("000042", row.html)
        self.assertIn("has been updated", row.html)

    def test_the_link_goes_through_support_not_the_gated_tickets_module(self):
        # The same Access Restricted trap the email link had - see
        # ticket_mail_templates._ticket_url's for_requester param.
        t = _ticket()
        _queue_requester_teams_dm(self.db, t, AGENT)
        self.db.commit()
        row = self.db.query(models.TicketTeamsMessage).filter_by(ticket_id=t.id).first()
        self.assertIn("/support?ticket=", row.html)
        self.assertNotIn("/tickets?ticket=", row.html)

    def test_the_requester_editing_their_own_ticket_gets_no_dm(self):
        t = _ticket()
        _queue_requester_teams_dm(self.db, t, REQUESTER)
        self.db.commit()
        self.assertEqual(self.db.query(models.TicketTeamsMessage).filter_by(ticket_id=t.id).count(), 0)

    def test_a_ticket_with_no_requester_on_file_is_skipped(self):
        t = _ticket(requester_email="")
        _queue_requester_teams_dm(self.db, t, AGENT)
        self.db.commit()
        self.assertEqual(self.db.query(models.TicketTeamsMessage).filter_by(ticket_id=t.id).count(), 0)

    def test_email_casing_does_not_defeat_the_self_edit_skip(self):
        t = _ticket(requester_email=REQUESTER.upper())
        _queue_requester_teams_dm(self.db, t, REQUESTER.lower())
        self.db.commit()
        self.assertEqual(self.db.query(models.TicketTeamsMessage).filter_by(ticket_id=t.id).count(), 0)


class ChatCreationPayloadTests(unittest.TestCase):
    """get_or_create_one_on_one_chat's Graph request shape - Microsoft
    documents oneOnOne creation as idempotent (a pair that already has a chat
    gets that chat back unchanged), which is why the caller doesn't check
    first; this only proves the request Nexus sends is the one Graph expects."""

    @patch("teams_post.httpx.post")
    def test_the_request_names_both_members_as_owners(self, mock_post):
        mock_post.return_value = MagicMock(status_code=201, json=lambda: {"id": "19:chat-id"})
        chat_id = teams_post.get_or_create_one_on_one_chat("tok", AGENT, REQUESTER)
        self.assertEqual(chat_id, "19:chat-id")
        _, kwargs = mock_post.call_args
        body = kwargs["json"]
        self.assertEqual(body["chatType"], "oneOnOne")
        bound = [m["user@odata.bind"] for m in body["members"]]
        self.assertTrue(any(AGENT in b for b in bound))
        self.assertTrue(any(REQUESTER in b for b in bound))
        self.assertTrue(all(m["roles"] == ["owner"] for m in body["members"]))

    @patch("teams_post.httpx.post")
    def test_a_graph_error_raises_with_the_status_and_body(self, mock_post):
        mock_post.return_value = MagicMock(status_code=403, text="Chat.Create not consented")
        with self.assertRaises(RuntimeError) as ctx:
            teams_post.get_or_create_one_on_one_chat("tok", AGENT, REQUESTER)
        self.assertIn("403", str(ctx.exception))
        self.assertIn("Chat.Create not consented", str(ctx.exception))


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.query(models.TicketTeamsMessage).delete()
        self.db.commit()
        self.db.close()

    def _row(self, **over):
        row = models.TicketTeamsMessage(
            id=str(uuid.uuid4()), ticket_id="t1", agent_email=AGENT,
            requester_email=REQUESTER, html="<p>hi</p>", created_at="2026-09-08T00:00:00Z",
        )
        for k, v in over.items():
            setattr(row, k, v)
        self.db.add(row)
        self.db.commit()
        return row

    @patch("teams_post.send_chat_message")
    @patch("teams_post.get_or_create_one_on_one_chat")
    @patch("bff_session.graph_token_for_email")
    def test_a_cached_chat_id_skips_re_creating_the_chat(self, mock_token, mock_create, mock_send):
        mock_token.return_value = "tok"
        row = self._row(chat_id="19:already-known")
        ok = teams_post.deliver_ticket_row(self.db, row)
        self.assertTrue(ok)
        mock_create.assert_not_called()
        mock_send.assert_called_once_with("tok", "19:already-known", row.html)
        self.assertEqual(row.sent, 1)

    @patch("bff_session.graph_token_for_email")
    def test_no_session_token_is_recorded_not_silently_dropped(self, mock_token):
        mock_token.return_value = ""
        row = self._row()
        ok = teams_post.deliver_ticket_row(self.db, row)
        self.assertFalse(ok)
        self.assertEqual(row.sent, 0)
        self.assertIn("no usable session token", row.send_error)
        self.assertEqual(row.attempts, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
