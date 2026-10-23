"""Feature requests are tickets (Oct 23 2026) - feature_requests.py.

  - A request typed in What's New files a Feature Request ticket; its card
    links the ticket. One filed in Tickets gets a What's New card too.
  - The card's conversation IS the ticket thread: a reply in What's New lands
    on the ticket and a ticket reply shows in What's New (internal notes
    never do). Only the requester and What's New managers may use it.
  - Every new request queues one post for the Nexus - Feedback and Bugs
    Teams chat; delivery posts as the first person who can (requester,
    assignee, NEXUS_FEEDBACK_CHAT_POSTERS) and keeps the reason when nobody can.

Throwaway sqlite, no network. Run with: python -m unittest test_feature_requests -v
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from fastapi import BackgroundTasks, HTTPException   # noqa: E402

import database                                      # noqa: E402
import feature_requests as FR                        # noqa: E402
import models                                        # noqa: E402
import teams_post                                    # noqa: E402
from routers import changelog_lifecycle as L         # noqa: E402
from routers import tickets as TK                    # noqa: E402

AMY = {"email": "amy@greensglobal.com", "level": 1}
BOB = {"email": "bob@greensglobal.com", "level": 1}
ADMIN = {"email": "admin@greensglobal.com", "level": 3}
CHAT = "19:feedback@thread.v2"


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.ChangelogFeedback, models.TaskTicket, models.TaskComment, models.TicketTeamsMessage,
                  models.NexusSetting, models.NexusEmployee, models.NexusNotification):
            self.db.query(m).delete()
        self.db.add_all([
            models.NexusEmployee(id="1", work_email=AMY["email"], first_name="Amy", last_name="Bolanos", status="active"),
            models.NexusEmployee(id="2", work_email=BOB["email"], first_name="Bob", last_name="Lee", status="active"),
            models.NexusEmployee(id="3", work_email=ADMIN["email"], first_name="Ada", last_name="Min", status="active"),
        ])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _raise(self, note="Export the time sheet to Excel\nwith the totals", module="Workday"):
        return L.raise_request(L.NewRequestBody(note=note, module=module), AMY, self.db, BackgroundTasks())

    def _chat_rows(self):
        return self.db.query(models.TicketTeamsMessage).filter_by(kind=FR.KIND).all()


class FilingTests(_Case):
    def test_a_whats_new_request_is_a_feature_request_ticket(self):
        card = self._raise()
        t = self.db.query(models.TaskTicket).filter_by(id=card["ticketId"]).one()
        self.assertEqual((t.type, t.requester_email, t.subject, t.application),
                         ("feature_request", AMY["email"], "Export the time sheet to Excel", "Nexus"))
        self.assertEqual(t.type_fields.get("svc_helpSubtopic"), "Workday")
        self.assertEqual((card["module"], card["status"], card["ticketCode"]), ("Workday", "New", TK.ticket_no(t.code)))
        self.assertIn("with the totals", card["note"])
        self.assertEqual(self.db.query(models.ChangelogFeedback).count(), 1)     # one card, not two
        self.assertEqual(L.my_requests(AMY, self.db)[0]["ticketId"], t.id)

    def test_a_ticket_filed_in_tickets_gets_a_whats_new_card(self):
        body = TK.TicketBody(subject="Dark mode", description="<p>Please add <b>dark mode</b></p>",
                             type="feature_request")
        out = TK.file_ticket(body, BackgroundTasks(), AMY, self.db)
        card = self.db.query(models.ChangelogFeedback).filter_by(ticket_id=out["id"]).one()
        self.assertEqual((card.kind, card.email, card.note), ("request", AMY["email"], "Please add dark mode"))
        self.assertEqual(len(self._chat_rows()), 1)

    def test_other_ticket_types_are_left_alone(self):
        TK.file_ticket(TK.TicketBody(subject="Printer jammed", type="incident"), BackgroundTasks(), AMY, self.db)
        self.assertEqual(self.db.query(models.ChangelogFeedback).count(), 0)
        self.assertEqual(self._chat_rows(), [])

    def test_each_request_queues_one_feedback_chat_post(self):
        card = self._raise()
        [row] = self._chat_rows()
        self.assertEqual((row.ticket_id, row.sent, row.chat_id), (card["ticketId"], 0, ""))
        self.assertIn("New Feature Request", row.html)
        self.assertIn("Export the time sheet to Excel", row.html)
        self.assertIn("Amy Bolanos", row.html)
        self.assertNotIn("<script", FR.chat_html(self.db, self.db.query(models.TaskTicket).one(), "<script>x</script>"))


class ThreadTests(_Case):
    def test_whats_new_and_the_ticket_share_one_thread(self):
        card = self._raise()
        L.add_request_comment(card["id"], L.RequestCommentBody(body="Also <CSV> please"), AMY, self.db, BackgroundTasks())
        t = self.db.query(models.TaskTicket).one()
        # The desk answers on the ticket - publicly, and with an internal note.
        TK.post_ticket_comment(self.db, t, ADMIN, "<p>Planned for next sprint</p>", False, BackgroundTasks())
        self.db.add(models.TaskComment(id="n1", task_id=t.id, author_email=ADMIN["email"], body="desk only",
                                       internal=True, created_at="9999"))
        self.db.commit()
        on_ticket = [c.body for c in self.db.query(models.TaskComment).filter_by(task_id=t.id).order_by(models.TaskComment.created_at)]
        self.assertEqual(on_ticket[0], "<p>Also &lt;CSV&gt; please</p>")
        seen = L.request_comments(card["id"], AMY, self.db)
        self.assertEqual([c["text"] for c in seen], ["Also <CSV> please", "Planned for next sprint"])
        self.assertEqual(L.my_requests(AMY, self.db)[0]["commentCount"], 2)

    def test_only_the_requester_and_managers_use_the_thread(self):
        card = self._raise()
        with self.assertRaises(HTTPException) as e:
            L.request_comments(card["id"], BOB, self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.assertEqual(L.request_comments(card["id"], ADMIN, self.db), [])

    def test_an_old_request_without_a_ticket_says_so(self):
        self.db.add(models.ChangelogFeedback(id="old", entry_id="", email=AMY["email"], kind="request", note="x"))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            L.request_comments("old", AMY, self.db)
        self.assertEqual(e.exception.status_code, 404)


class DeliveryTests(_Case):
    def _deliver(self, tokens, chats, sent):
        def send(tok, chat_id, html):
            if tok not in chats:
                raise RuntimeError("Graph 403: not a member")
            sent.append((tok, chat_id))
        with mock.patch("bff_session.graph_token_for_email", side_effect=lambda db, email, *a: tokens.get(email, "")), \
             mock.patch.object(FR, "find_chat", side_effect=lambda tok: CHAT if tok in chats else ""), \
             mock.patch.object(teams_post, "send_chat_message", side_effect=send):
            row = self._chat_rows()[0]
            return teams_post.deliver_ticket_row(self.db, row), row

    def test_posts_as_the_requester_when_they_are_in_the_chat(self):
        self._raise()
        sent = []
        ok, row = self._deliver({AMY["email"]: "amy-tok"}, {"amy-tok"}, sent)
        self.assertTrue(ok)
        self.assertEqual(sent, [("amy-tok", CHAT)])
        self.assertEqual((row.sent, row.agent_email, row.chat_id), (1, AMY["email"], CHAT))
        self.assertEqual(FR._cached_chat_id(self.db), CHAT)

    def test_falls_back_to_the_configured_posters(self):
        self._raise()
        sent = []
        with mock.patch.dict(os.environ, {"NEXUS_FEEDBACK_CHAT_POSTERS": ADMIN["email"]}):
            ok, row = self._deliver({AMY["email"]: "amy-tok", ADMIN["email"]: "ada-tok"}, {"ada-tok"}, sent)
        self.assertTrue(ok)
        self.assertEqual(sent, [("ada-tok", CHAT)])
        self.assertEqual(row.agent_email, ADMIN["email"])

    def test_nobody_able_to_post_keeps_the_reason(self):
        self._raise()
        ok, row = self._deliver({AMY["email"]: "amy-tok"}, set(), [])
        self.assertFalse(ok)
        self.assertEqual(row.sent, 0)
        self.assertIn("not in a chat named Nexus - Feedback and Bugs", row.send_error)

    def test_a_dm_row_still_goes_the_dm_way(self):
        self.db.add(models.TicketTeamsMessage(id="dm1", ticket_id="t", agent_email=ADMIN["email"],
                                              requester_email=AMY["email"], html="<p>hi</p>", chat_id="c1"))
        self.db.commit()
        row = self.db.query(models.TicketTeamsMessage).filter_by(id="dm1").one()
        with mock.patch("bff_session.graph_token_for_email", return_value="tok"), \
             mock.patch.object(teams_post, "send_chat_message") as send, \
             mock.patch.object(FR, "deliver") as fr:
            self.assertTrue(teams_post.deliver_ticket_row(self.db, row))
        fr.assert_not_called()
        send.assert_called_once_with("tok", "c1", "<p>hi</p>")



class StatusSyncTests(_Case):
    def _set(self, card, status, note=""):
        return L.set_request_status(card["id"], L.RequestStatusBody(status=status, note=note), ADMIN, self.db)

    def _ticket(self):
        self.db.expire_all()
        return self.db.query(models.TaskTicket).one()

    def _request(self):
        self.db.expire_all()
        return self.db.query(models.ChangelogFeedback).one()

    def _move_ticket(self, status, note=""):
        import ticket_sla
        t = self._ticket()
        ticket_sla.set_status(t, status)
        if note:
            t.resolution_note = note
        self.db.commit()

    def test_the_ticket_follows_the_request(self):
        card = self._raise()
        self._set(card, "Planned")
        self.assertEqual(self._ticket().status, "in_progress")
        out = self._set(card, "Shipped", "In the 10/30 release")
        t = self._ticket()
        self.assertEqual((t.status, t.resolution_note), ("resolved", "In the 10/30 release"))
        self.assertTrue(t.resolved_at)
        # Not echoed back: the request keeps what the manager set.
        self.assertEqual((out["status"], self._request().status, self._request().status_by),
                         ("Shipped", "Shipped", ADMIN["email"]))
        self._set(card, "Declined", "Out of scope")
        self.assertEqual(self._ticket().status, "closed")
        self._set(card, "New")
        t = self._ticket()
        self.assertEqual((t.status, t.resolution_note, t.resolved_at), ("open", "", ""))

    def test_a_waiting_ticket_stays_waiting(self):
        card = self._raise()
        self._move_ticket("waiting_user")
        self._set(card, "Under Review")
        self.assertEqual(self._ticket().status, "waiting_user")

    def test_the_request_follows_a_finished_or_reopened_ticket(self):
        card = self._raise()
        self._move_ticket("in_progress")
        self.assertEqual(self._request().status, "")              # still New
        self._move_ticket("resolved", "Added in Reports")
        r = self._request()
        self.assertEqual((r.status, r.status_note, r.status_by), ("Shipped", "Added in Reports", "ticket"))
        bells = self.db.query(models.NexusNotification).filter_by(recipient=AMY["email"]).all()
        self.assertEqual([b.title for b in bells], ["Your Request Shipped"])
        self._move_ticket("closed")                                # resolved -> closed is the normal end
        self.assertEqual(self._request().status, "Shipped")
        self._move_ticket("open")                                  # reopened
        self.assertEqual(self._request().status, "In Progress")
        self.assertEqual(L.my_requests(AMY, self.db)[0]["id"], card["id"])

    def test_a_ticket_closed_without_resolving_declines_the_request(self):
        self._raise()
        self._move_ticket("closed", "Duplicate of TKT-000004")
        r = self._request()
        self.assertEqual((r.status, r.status_note), ("Declined", "Duplicate of TKT-000004"))


if __name__ == "__main__":
    unittest.main()
