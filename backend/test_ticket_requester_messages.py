"""
What a ticket's requester is EMAILED and messaged on TEAMS about (Neil, Oct 1
2026). Ankush: "whenever I open this ticket she gets a message on Teams".
Neil: only three things reach the requester outside the bell -

  * the ticket was ASSIGNED ("...has been assigned to Ankush Narkhede"),
  * a public REPLY from someone else, with the reply's text in the message,
  * the ticket was RESOLVED or CLOSED (with the resolution note).

Status moves, priority, field edits, attachments and opening the ticket send
nothing. One message per save. The URL is a short masked link
("Open Ticket #27"), never pasted raw. Nobody is messaged about their own
action. The bell is unchanged (test_ticket_requester_bell.py).

Throwaway sqlite file; no network - Graph mail is mocked, Teams rows are
inspected in the queue, BackgroundTasks are inspected and never run.
Run one file per process: python -m pytest test_ticket_requester_messages.py
"""
import os
import re
import tempfile
import unittest
from unittest.mock import patch

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_APP_URL"] = "https://nexus.test"

from fastapi import BackgroundTasks

import database
import models
import ticket_notify
import ticket_mail_templates as tmpl
from routers.task_util import now_iso
from routers import tickets as T

REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
AGENT = {"email": "ankush.narkhede@greensglobal.com", "level": 3}
OTHER = "olive.agent@greensglobal.com"
LINK = "https://nexus.test/support?ticket=t1"


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        import auth
        self._grants = auth._grants_for
        auth._grants_for = lambda email, db: ({"tickets": 99} if email == AGENT["email"] else {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TicketTeamsMessage, models.TaskAttachment,
                  models.NexusNotification, models.TaskNotification, models.NexusEmployee,
                  models.TicketEmailLog, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="e-ank", first_name="Ankush", last_name="Narkhede",
                                         work_email=AGENT["email"], status="active", deleted_at=""))
        self.db.add(models.NexusEmployee(id="e-oli", first_name="Olive", last_name="Agent",
                                         work_email=OTHER, status="active", deleted_at=""))
        self.db.add(models.TaskTicket(id="t1", code="000027", subject="Printer jam", status="open",
                                      priority="medium", requester_email=REQUESTER["email"],
                                      created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    # helpers -----------------------------------------------------------
    def _ticket(self):
        self.db.expire_all()
        return self.db.get(models.TaskTicket, "t1")

    def _set(self, **fields):
        t = self._ticket()
        for k, v in fields.items():
            setattr(t, k, v)
        self.db.commit()

    def _save(self, user, **fields):
        """One PATCH (the drawer's Done). Returns (email tasks, teams rows)."""
        bg = BackgroundTasks()
        T.update_ticket("t1", T.TicketUpdate(**fields), bg, user=user, db=self.db)
        return self._split(bg)

    def _comment(self, user, text, internal=False):
        bg = BackgroundTasks()
        T.add_ticket_comment("t1", T.TicketCommentBody(body=text, internal=internal), bg, user=user, db=self.db)
        return self._split(bg)

    def _split(self, bg):
        emails = [t for t in bg.tasks if t.func is T.notify_ticket_event]
        dm_tasks = [t for t in bg.tasks if t.func is T._deliver_teams_dm]
        rows = self.db.query(models.TicketTeamsMessage).filter_by(ticket_id="t1").all()
        self.assertEqual(len(dm_tasks), len(rows), "every queued DM gets one inline delivery attempt")
        return emails, rows


class TeamsMessageTests(_Base):
    """Which saves put a Teams message in the requester's queue, and what it says."""

    def test_assigning_sends_one_message_naming_the_assignee(self):
        emails, dms = self._save(AGENT, assignee_email=OTHER)
        self.assertEqual(len(dms), 1)
        self.assertIn('Ticket #27 "Printer jam" has been assigned to Olive Agent.', dms[0].html)
        self.assertEqual(dms[0].requester_email, REQUESTER["email"])
        self.assertEqual(dms[0].agent_email, AGENT["email"])   # posted as the agent
        self.assertEqual([e.args[1] for e in emails], ["assigned"])

    def test_self_assigning_counts_as_assigned(self):
        # "Opened" by the desk = an agent picking it up.
        _, dms = self._save(AGENT, assignee_email=AGENT["email"])
        self.assertEqual(len(dms), 1)
        self.assertIn("has been assigned to Ankush Narkhede.", dms[0].html)

    def test_a_public_reply_sends_the_reply_text(self):
        emails, dms = self._save(AGENT, comment="<p>Can you send a photo of the tray?</p>")
        self.assertEqual(len(dms), 1)
        self.assertIn('Ankush Narkhede replied on Ticket #27 "Printer jam":', dms[0].html)
        self.assertIn("<blockquote>Can you send a photo of the tray?</blockquote>", dms[0].html)
        self.assertEqual(len(emails), 1)
        self.assertEqual(emails[0].args[1], "updated")
        self.assertIn("photo of the tray", emails[0].kwargs["latest_comment"])

    def test_resolving_sends_the_resolution(self):
        emails, dms = self._save(AGENT, status="resolved", resolution_note="Replaced the toner.")
        self.assertEqual(len(dms), 1)
        self.assertIn('Ticket #27 "Printer jam" has been resolved.', dms[0].html)
        self.assertIn("<b>Resolution:</b> Replaced the toner.", dms[0].html)
        self.assertEqual([e.args[1] for e in emails], ["resolved"])

    def test_closing_says_closed(self):
        _, dms = self._save(AGENT, status="closed", resolution_note="Duplicate of #26.")
        self.assertEqual(len(dms), 1)
        self.assertIn("has been closed.", dms[0].html)

    def test_assign_and_reply_in_one_save_is_one_message_with_both(self):
        emails, dms = self._save(AGENT, assignee_email=OTHER, priority="high",
                                 comment="<p>Olive will swap the toner today.</p>")
        self.assertEqual(len(dms), 1)
        html = dms[0].html
        self.assertIn("has been assigned to Olive Agent.", html)
        self.assertIn("Ankush Narkhede replied:", html)
        self.assertIn("Olive will swap the toner today.", html)
        self.assertEqual(len(emails), 1)
        self.assertEqual(emails[0].args[1], "assigned")
        self.assertIn("swap the toner", emails[0].kwargs["latest_comment"])

    def test_resolve_with_a_reply_is_one_message(self):
        emails, dms = self._save(AGENT, status="resolved", resolution_note="New toner.",
                                 comment="<p>All set - try printing again.</p>")
        self.assertEqual(len(dms), 1)
        self.assertIn("has been resolved.", dms[0].html)
        self.assertIn("All set - try printing again.", dms[0].html)
        self.assertEqual([e.args[1] for e in emails], ["resolved"])

    def test_the_url_is_a_masked_link_not_pasted_raw(self):
        _, dms = self._save(AGENT, assignee_email=OTHER)
        html = dms[0].html
        self.assertIn(f'<a href="{LINK}">Open Ticket #27</a>', html)
        # The URL appears exactly once - inside the href, never as visible text.
        self.assertEqual(html.count("https://"), 1)
        visible = re.sub(r"<[^>]+>", "", html)
        self.assertNotIn("https://", visible)
        self.assertNotIn("/tickets?ticket=", html)

    def test_reply_markup_is_reduced_to_safe_text(self):
        _, dms = self._save(AGENT, comment='<p>Hi <b>there</b></p><script>alert(1)</script><img src=x onerror=alert(2)>')
        html = dms[0].html
        self.assertIn("Hi there", html)
        self.assertNotIn("<script", html)
        self.assertNotIn("onerror", html)

    # ── what does NOT message ──────────────────────────────────────────────
    def test_status_moves_send_nothing(self):
        self._set(status="in_progress", assignee_email=OTHER)
        for status in ("on_hold", "waiting_user", "in_progress"):
            emails, dms = self._save(AGENT, status=status)
            self.assertEqual((emails, dms), ([], []), status)

    def test_a_priority_change_sends_nothing(self):
        self.assertEqual(self._save(AGENT, priority="urgent"), ([], []))

    def test_field_edits_send_nothing(self):
        self.assertEqual(self._save(AGENT, subject="Printer jam floor 2", description="<p>More</p>",
                                    type="incident", resolution="fixed"), ([], []))

    def test_unassigning_sends_nothing(self):
        self._set(status="in_progress", assignee_email=OTHER)
        self.assertEqual(self._save(AGENT, assignee_email=""), ([], []))

    def test_an_internal_note_sends_nothing(self):
        self.assertEqual(self._save(AGENT, comment="<p>Toner on backorder.</p>", comment_internal=True), ([], []))
        self.assertEqual(self._comment(AGENT, "<p>Still backordered.</p>", internal=True), ([], []))

    def test_the_requesters_own_reply_sends_them_nothing(self):
        self._set(status="in_progress", assignee_email=OTHER)
        emails, dms = self._save(REQUESTER, comment="<p>Still jammed.</p>")
        self.assertEqual(dms, [])
        emails2, dms2 = self._comment(REQUESTER, "<p>Any news?</p>")
        self.assertEqual(dms2, [])
        # The email task may still be queued (the desk side decides its own
        # recipients) - but the requester is never on it; see EmailPolicyTests.
        for e in emails + emails2:
            self.assertFalse(ticket_notify.requester_hears(e.args[1], e.args[2], REQUESTER["email"], e.kwargs))

    def test_the_requester_confirming_sends_them_nothing(self):
        self._set(status="resolved", assignee_email=OTHER, resolution_note="Done", resolved_at=now_iso())
        self.assertEqual(self._save(REQUESTER, status="closed", csat_rating=5), ([], []))

    def test_the_desk_closing_an_already_resolved_ticket_sends_nothing(self):
        # They were told when it was resolved; auto-close is silent too.
        self._set(status="resolved", assignee_email=OTHER, resolution_note="Done", resolved_at=now_iso())
        self.assertEqual(self._save(AGENT, status="closed"), ([], []))

    def test_a_reopen_by_the_desk_sends_no_teams_message(self):
        self._set(status="resolved", assignee_email=OTHER, resolution_note="Done", resolved_at=now_iso())
        emails, dms = self._save(AGENT, status="reopened")
        self.assertEqual(dms, [])
        # The desk/assignee still get the reopen email; the requester is filtered.
        self.assertEqual([e.args[1] for e in emails], ["reopened"])
        self.assertFalse(ticket_notify.requester_hears("reopened", AGENT["email"], REQUESTER["email"], emails[0].kwargs))

    def test_an_attachment_sends_nothing(self):
        bg = BackgroundTasks()
        T.add_ticket_attachment("t1", T.TicketAttachmentBody(name="receipt.pdf", url=""), bg,
                                user=AGENT, db=self.db)
        self.assertEqual(self._split(bg), ([], []))

    def test_comments_switched_off_sends_no_reply_message(self):
        ticket_notify.save_settings(self.db, {"commentsTrigger": False}, "admin@x.com")
        self.assertEqual(self._comment(AGENT, "<p>hello</p>"), ([], []))
        self.assertEqual(self._save(AGENT, comment="<p>hello again</p>"), ([], []))

    # ── opening a ticket ──────────────────────────────────────────────────
    def test_opening_a_ticket_sends_nothing(self):
        self._set(status="in_progress", assignee_email=OTHER)
        for who in (AGENT, REQUESTER):
            T.list_ticket_comments("t1", user=who, db=self.db)
            T.list_ticket_attachments("t1", user=who, db=self.db)
            T.list_ticket_activity("t1", user=who, db=self.db)
            T.mark_ticket_seen("t1", user=who, db=self.db)
        T.list_tickets(user=AGENT, db=self.db)
        self.assertEqual(self.db.query(models.TicketTeamsMessage).count(), 0)

    def test_done_with_nothing_really_changed_sends_nothing(self):
        # Same values sent back (an old client, or a drawer that re-sends what
        # it loaded) - not a change, so not news.
        self._set(status="in_progress", assignee_email=OTHER, description="<p>x</p>")
        self.assertEqual(self._save(AGENT, status="in_progress", assignee_email=OTHER, priority="medium",
                                    description="<p>x</p>", subject="Printer jam"), ([], []))
        self.assertEqual(self._save(AGENT), ([], []))
        self.assertEqual(self._save(AGENT, comment="<p></p>"), ([], []))


class CommentEndpointTests(_Base):
    def test_a_desk_reply_through_the_comments_endpoint_carries_the_text(self):
        emails, dms = self._comment(AGENT, "<p>Restarted the spooler.</p>")
        self.assertEqual(len(dms), 1)
        self.assertIn("<blockquote>Restarted the spooler.</blockquote>", dms[0].html)
        self.assertIn(f'<a href="{LINK}">Open Ticket #27</a>', dms[0].html)
        self.assertEqual(len(emails), 1)
        self.assertEqual(emails[0].kwargs["latest_comment"], "<p>Restarted the spooler.</p>")


class TemplateTests(unittest.TestCase):
    def test_nothing_to_say_is_empty(self):
        self.assertEqual(tmpl.requester_teams_dm_html(code="000027", subject="x", link=LINK), "")
        self.assertEqual(tmpl.requester_teams_dm_html(code="000027", subject="x", link=LINK, comment="<p></p>"), "")

    def test_subject_is_escaped(self):
        html = tmpl.requester_teams_dm_html(code="000027", subject='<b>"x"</b>', link=LINK, assigned_to="A")
        self.assertNotIn("<b>\"x\"</b>", html)
        self.assertIn("&lt;b&gt;", html)


class EmailPolicyTests(_Base):
    """notify_ticket_event end to end with Graph mocked: who actually gets mail."""

    def _run(self, event, actor, **kw):
        sent = []

        def fake_send(*, from_email, to, cc, subject, html, reply_to=""):
            sent.extend(to)
            return {}
        with patch.object(ticket_notify.graph_mail, "send_mail", side_effect=fake_send):
            ticket_notify.notify_ticket_event("t1", event, actor, **kw)
        return sent

    def test_a_status_only_update_mails_nobody(self):
        self._set(status="on_hold", assignee_email=OTHER)
        self.assertEqual(self._run("updated", AGENT["email"], update_kind="Status changed to On Hold"), [])

    def test_a_reply_mails_the_requester(self):
        self._set(status="in_progress", assignee_email=OTHER)
        self.assertEqual(self._run("updated", AGENT["email"], update_kind="New comment added",
                                   latest_comment="<p>hi</p>"), [REQUESTER["email"]])

    def test_a_reply_on_a_resolved_ticket_still_mails_the_requester(self):
        self._set(status="resolved", assignee_email=OTHER)
        self.assertEqual(self._run("updated", AGENT["email"], update_kind="New comment added",
                                   latest_comment="<p>One more thing</p>"), [REQUESTER["email"]])

    def test_the_requesters_own_reply_does_not_mail_them(self):
        self._set(status="in_progress", assignee_email=OTHER)
        self.assertEqual(self._run("updated", REQUESTER["email"], update_kind="New comment added",
                                   latest_comment="<p>hi</p>"), [])

    def test_assigned_mails_the_requester(self):
        self._set(status="in_progress", assignee_email=OTHER)
        self.assertIn(REQUESTER["email"], self._run("assigned", AGENT["email"]))

    def test_resolved_mails_the_requester(self):
        self._set(status="resolved", assignee_email=OTHER, resolution_note="Done")
        got = self._run("resolved", AGENT["email"])
        self.assertIn(REQUESTER["email"], got)
        self.assertIn(OTHER, got)

    def test_a_requester_resolving_their_own_ticket_mails_the_assignee_not_them(self):
        self._set(status="resolved", assignee_email=OTHER, resolution_note="Fixed itself")
        got = self._run("resolved", REQUESTER["email"])
        self.assertIn(OTHER, got)
        self.assertNotIn(REQUESTER["email"], got)
        # ...and no Teams message to them either.
        self.assertIsNone(T._queue_requester_teams_dm(self.db, self._ticket(), REQUESTER["email"], closed=True))

    def test_a_requester_reopening_mails_the_assignee_not_them(self):
        self._set(status="reopened", assignee_email=OTHER)
        got = self._run("reopened", REQUESTER["email"], reopen_reason="Still broken")
        self.assertIn(OTHER, got)
        self.assertNotIn(REQUESTER["email"], got)

    def test_a_desk_reopen_without_a_reply_does_not_mail_the_requester(self):
        self._set(status="reopened", assignee_email=OTHER)
        got = self._run("reopened", AGENT["email"])
        self.assertIn(OTHER, got)
        self.assertNotIn(REQUESTER["email"], got)

    def test_the_creation_receipt_still_goes_even_when_they_raised_it(self):
        self.assertIn(REQUESTER["email"], self._run("created", REQUESTER["email"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
