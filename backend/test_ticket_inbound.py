"""
Email to ticket (Oct 2026, ticket_inbound.py).

What a message to the support mailbox becomes, and what it must never become:

  new email   -> a ticket, through the same create path as the app
                 (routers/tickets.file_ticket): default department per company,
                 default assignee, honest SLA, the requester's receipt, the
                 desk notice, CC'd colleagues as collaborators, "Via Email";
  reply       -> a public comment, through the same path as the drawer
                 (post_ticket_comment), found by the signed plus address, the
                 threading headers or the "Ticket #N" subject tag, allowed only
                 for someone the API would let comment;
  refused     -> a logged row and nothing else: unknown / external / guest /
                 offboarded senders, automated mail, our own mailboxes, no
                 permission, no default department, the hourly limit, an
                 oversized body;
  the gate    -> switched off, not the deployed worker, or the lock held: the
                 mailbox is not even listed;
  outbound    -> Reply-To becomes the signed per-ticket address only while
                 inbound is on; the support mailbox can never be the Tasks one.

Throwaway sqlite, through the real routes where the API is the comparison.
Graph, storage and Teams are stubbed - nothing touches the network.

Run with: python -m pytest test_ticket_inbound.py -q
"""
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from fastapi import FastAPI                     # noqa: E402
from fastapi.testclient import TestClient       # noqa: E402

import auth                                     # noqa: E402
import cache                                    # noqa: E402
import database                                 # noqa: E402
import mail_inbound                             # noqa: E402
import models                                   # noqa: E402
import task_notify                              # noqa: E402
import ticket_inbound as inbound                # noqa: E402
import ticket_inbound_parse as parse            # noqa: E402
import ticket_notify                            # noqa: E402
import ticket_taxonomy                          # noqa: E402
from routers import tickets as T                # noqa: E402
from routers.task_util import gen_id            # noqa: E402

SUPPORT = "support@greensglobal.com"
SENDER_BOX = "nexus@greensglobal.com"
TASKS_BOX = "tasks@greensglobal.com"
REQ = "req@greensglobal.com"
RELAY = "req@greensg.onmicrosoft.com"
AGENT = "agent@greensglobal.com"
ADMIN = "admin@greensglobal.com"
COLLEAGUE = "colleague@greensglobal.com"
OTHER = "other@greensglobal.com"
LEFT = "left@greensglobal.com"
GUEST = "guest@partner.example"
INDIA = "india@greensglobal.com"

USERS = {REQ: 1, AGENT: 1, ADMIN: 4, COLLEAGUE: 1, OTHER: 1, LEFT: 1, GUEST: 1, INDIA: 1}


def _msg(**kw):
    """A Graph message, only the fields a test cares about overridden."""
    m = {
        "id": kw.get("id", "AAMk" + uuid.uuid4().hex[:12]),
        "subject": kw.get("subject", "Printer jam on 3"),
        "from": {"emailAddress": {"address": kw.get("sender", REQ)}},
        "toRecipients": [{"emailAddress": {"address": a}} for a in kw.get("to", [SUPPORT])],
        "ccRecipients": [{"emailAddress": {"address": a}} for a in kw.get("cc", [])],
        "receivedDateTime": "2026-10-19T16:00:00Z",
        "conversationId": kw.get("conversation", ""),
        "internetMessageId": kw.get("imid", f"<{uuid.uuid4().hex}@greensglobal.com>"),
        "internetMessageHeaders": [{"name": k, "value": v} for k, v in (kw.get("headers") or {}).items()],
        "body": {"contentType": "html", "content": kw.get("body", "<div>The printer on 3 is jammed.</div>")},
        "hasAttachments": kw.get("has_attachments", False),
    }
    if "unique" in kw:
        m["uniqueBody"] = {"contentType": "html", "content": kw["unique"]}
    return m


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        app = FastAPI()
        app.include_router(T.router)
        cls.who = {"email": REQ}
        app.dependency_overrides[auth.get_current_user] = lambda: {
            "email": cls.who["email"], "role": "employee", "level": USERS[cls.who["email"]]}
        cls.c = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.TaskTicket, models.TaskComment, models.TaskAttachment, models.TaskActivity,
                  models.TaskNotification, models.NexusNotification, models.NexusEmployee, models.NexusRole,
                  models.NexusGroup, models.NexusGroupMember, models.NexusSetting, models.HrDepartment,
                  models.HrEntity, models.TicketDepartment, models.TicketEmailLog, models.TicketTeamsMessage,
                  models.TicketInboundEmail):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        self.db.add(models.HrEntity(id="co1", name="Greens"))
        self.db.add(models.HrEntity(id="co2", name="Greens India"))
        for email, co, status, kind in ((REQ, "co1", "active", "internal"), (AGENT, "co1", "active", "internal"),
                                        (ADMIN, "co1", "active", "internal"),
                                        (COLLEAGUE, "co1", "active", "internal"),
                                        (OTHER, "co1", "active", "internal"),
                                        (LEFT, "co1", "offboarded", "internal"),
                                        (GUEST, "co1", "active", "guest"),
                                        (INDIA, "co2", "active", "internal")):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0].title(),
                                             last_name="Person", company=co, status=status, identity_type=kind))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator"))
        self.db.add(models.NexusGroup(id="desk", name="Service Desk", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroupMember(group_id="desk", email=AGENT))
        self.db.add(models.HrDepartment(id="dIT", company_id="co1", name="IT"))
        self.db.add(models.HrDepartment(id="dIT2", company_id="co2", name="IT"))
        self.db.commit()
        T._sync_ticket_departments(self.db)
        auth.invalidate_role_cache()
        auth.invalidate_external_cache()
        cache.settings_config.invalidate()
        self.addCleanup(cache.settings_config.invalidate)

        self.sent = []
        p = patch("graph_mail.send_mail", side_effect=lambda **kw: (self.sent.append(kw) or {}))
        p.start()
        self.addCleanup(p.stop)
        p = patch("teams_post.deliver_ticket_row", return_value={})
        p.start()
        self.addCleanup(p.stop)

        task_notify.save_settings(self.db, {"replyTo": TASKS_BOX}, "test")
        self.cfg = ticket_notify.save_settings(self.db, {
            "inboundEnabled": True, "inboundMailbox": SUPPORT, "fromMailbox": SENDER_BOX,
            "inboundDefaultDepartment": {"co1": "dIT"}}, "test")

    # ── helpers ──────────────────────────────────────────────────────────
    def as_(self, email):
        type(self).who["email"] = email
        return self.c

    def ingest(self, msg):
        return inbound.ingest_message(self.db, ticket_notify.get_settings(self.db), msg)

    def rows(self):
        self.db.expire_all()
        return self.db.query(models.TicketInboundEmail).all()

    def row(self):
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        return rows[0]

    def tickets(self):
        self.db.expire_all()
        return self.db.query(models.TaskTicket).all()

    def ticket(self, tid):
        self.db.expire_all()
        return self.db.query(models.TaskTicket).filter_by(id=tid).one()

    def comments(self, tid):
        self.db.expire_all()
        return self.db.query(models.TaskComment).filter_by(task_id=tid).order_by(models.TaskComment.created_at).all()

    def bells(self, email, kind):
        self.db.expire_all()
        return self.db.query(models.TaskNotification).filter_by(for_email=email, kind=kind).count()

    def mails(self, tid):
        self.db.expire_all()
        return {(m.event_type, m.recipient, m.recipient_role)
                for m in self.db.query(models.TicketEmailLog).filter_by(ticket_id=tid).all()}

    def activity(self, tid, kind):
        self.db.expire_all()
        return self.db.query(models.TaskActivity).filter_by(entity_id=tid, type=kind).count()

    def file_in_app(self, who=REQ, **body):
        body.setdefault("subject", "Monitor flickers")
        body.setdefault("type", "incident")
        body.setdefault("hr_department_id", "dIT")
        r = self.as_(who).post("/task-tickets", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def refused(self, msg, reason_part, status="rejected"):
        before = len(self.tickets())
        self.assertEqual(self.ingest(msg), "refused")
        r = self.row()
        self.assertEqual((r.outcome, r.status), ("refused", status))
        self.assertIn(reason_part, r.reason)
        self.assertEqual(len(self.tickets()), before)
        return r


# ── Parsing (no DB) ──────────────────────────────────────────────────────────
class AddressTests(unittest.TestCase):
    def test_the_reply_address_round_trips(self):
        tid = gen_id()
        addr = parse.reply_address(SUPPORT, tid)
        self.assertTrue(addr.startswith("support+t"))
        self.assertEqual(parse.ticket_id_from_recipients(SUPPORT, [OTHER, addr]), tid)

    def test_forged_and_tampered_tokens_resolve_to_nothing(self):
        tid = gen_id()
        addr = parse.reply_address(SUPPORT, tid)
        sig = addr.split("@")[0].split(".")[1]
        self.assertEqual(parse.ticket_id_from_recipients(SUPPORT, [f"support+t{uuid.uuid4().hex}.{sig}@greensglobal.com"]), "")
        self.assertEqual(parse.ticket_id_from_recipients(SUPPORT, [f"support+t{uuid.uuid4().hex}.deadbeef@greensglobal.com"]), "")
        self.assertEqual(parse.ticket_id_from_recipients(SUPPORT, [addr.replace("greensglobal.com", "evil.example")]), "")

    def test_a_task_reply_token_is_not_a_ticket_token(self):
        import task_inbound_parse as tparse
        tid = gen_id()
        task_addr = tparse.reply_address(SUPPORT, tid)
        self.assertEqual(parse.ticket_id_from_recipients(SUPPORT, [task_addr]), "")

    def test_subjects(self):
        self.assertEqual(parse.clean_subject("RE: Fwd: FW:  Printer   jam "), "Printer jam")
        self.assertEqual(parse.subject_ticket_code('RE: Ticket #12 - Greens ("Printer") - Open'), "000012")
        self.assertEqual(parse.subject_ticket_code("Printer jam"), "")

    def test_same_mailbox_ignores_sub_addresses_and_case(self):
        self.assertTrue(mail_inbound.same_mailbox("Support+x@greensglobal.com", SUPPORT))
        self.assertFalse(mail_inbound.same_mailbox(TASKS_BOX, SUPPORT))


# ── New tickets ──────────────────────────────────────────────────────────────
class NewTicketTests(_Base):
    def test_a_new_email_files_a_ticket_like_the_app(self):
        self.assertEqual(self.ingest(_msg(subject="Fwd: RE: Printer jam on 3")), "created")
        t = self.tickets()[0]
        self.assertEqual((t.requester_email, t.created_by_email, t.company_id, t.hr_department_id),
                         (REQ, REQ, "co1", "dIT"))
        self.assertEqual((t.subject, t.type, t.priority, t.status, t.source),
                         ("Printer jam on 3", "other", "medium", "open", "email"))
        self.assertIn("jammed", t.description)
        # Honest SLA started, exactly as create_ticket starts it.
        self.assertTrue(t.sla_due_at and t.first_response_due_at)
        self.assertEqual(t.first_response_at or "", "")
        self.assertEqual(self.activity(t.id, "created"), 1)
        # The requester's receipt, and the desk (no roster = administrators) told.
        self.assertIn(("created", REQ, "requester"), self.mails(t.id))
        self.assertIn(("created", ADMIN, "it_admin"), self.mails(t.id))
        self.assertGreater(self.bells(ADMIN, "ticket_needs_assignment"), 0)
        r = self.row()
        self.assertEqual((r.outcome, r.status, r.ticket_id), ("created", "posted", t.id))

    def test_the_relay_address_is_the_same_person(self):
        self.assertEqual(self.ingest(_msg(sender=RELAY)), "created")
        self.assertEqual(self.tickets()[0].requester_email, REQ)

    def test_the_default_assignee_takes_it(self):
        row = self.db.query(models.TicketDepartment).filter_by(id="dIT").one()
        row.default_assignee_email = AGENT
        self.db.commit()
        self.ingest(_msg())
        t = self.tickets()[0]
        self.assertEqual((t.assignee_email, t.status), (AGENT, "in_progress"))
        self.assertEqual(self.activity(t.id, "auto_assigned"), 1)
        self.assertEqual(self.bells(AGENT, "ticket_assigned"), 1)
        self.assertIn(("assigned", AGENT, "assignee"), self.mails(t.id))
        self.assertNotIn(("created", ADMIN, "it_admin"), self.mails(t.id))

    def test_the_approval_gate_applies(self):
        ticket_taxonomy.save_config(self.db, {"types": {"other": {"requiresApproval": True}}}, "test")
        self.ingest(_msg())
        self.assertEqual(self.tickets()[0].approval_status, "pending")

    def test_cc_colleagues_become_collaborators(self):
        self.ingest(_msg(cc=[COLLEAGUE, "vendor@outside.example", SUPPORT, LEFT, REQ, INDIA]))
        t = self.tickets()[0]
        self.assertEqual(t.watcher_emails, [COLLEAGUE])
        self.assertEqual(self.bells(COLLEAGUE, "ticket_collaborator"), 1)

    def test_the_list_says_via_email(self):
        self.ingest(_msg())
        listed = self.as_(REQ).get("/task-tickets?mine=true").json()
        self.assertEqual(listed[0]["source"], "email")
        app = self.file_in_app()
        self.assertIsNone(app["source"])

    def test_the_same_message_twice_is_one_ticket(self):
        msg = _msg()
        self.assertEqual(self.ingest(msg), "created")
        self.assertEqual(self.ingest(msg), "duplicate")
        self.assertEqual(len(self.tickets()), 1)
        self.assertEqual(len(self.rows()), 1)

    def test_a_message_seen_again_after_a_crash_says_what_may_be_missing(self):
        msg = _msg()
        self.ingest(msg)
        self.assertEqual(self.ingest(msg), "duplicate")
        self.assertIn("ticket already created; files/receipt may be missing", self.row().reason)

    def test_a_forward_with_nothing_typed_keeps_the_forwarded_text(self):
        body = ('<div id="divRplyFwdMsg">From: Vendor<br>Sent: Monday</div>'
                '<div>Your invoice 4411 is overdue.</div>')
        self.ingest(_msg(subject="FW: Invoice 4411", body=body, unique=""))
        self.assertIn("invoice 4411", self.tickets()[0].description.lower())


# ── Replies ──────────────────────────────────────────────────────────────────
class ReplyTests(_Base):
    def setUp(self):
        super().setUp()
        self.t = self.file_in_app()
        self.sent.clear()

    def test_a_desk_agent_reply_by_address_is_a_comment_with_every_side_effect(self):
        msg = _msg(sender=AGENT, to=[parse.reply_address(SUPPORT, self.t["id"])],
                   subject=f"RE: Ticket #{int(self.t['code'])} - Monitor", body="<div>Swapping the cable now.</div>")
        self.assertEqual(self.ingest(msg), "comment")
        c = self.comments(self.t["id"])[-1]
        self.assertEqual((c.author_email, c.body, bool(c.internal)), (AGENT, "Swapping the cable now.", False))
        t = self.ticket(self.t["id"])
        self.assertTrue(t.first_response_at)               # honest SLA: the desk responded
        self.assertEqual(self.bells(REQ, "ticket_comment"), 1)
        self.assertEqual(self.activity(t.id, "commented"), 1)
        self.assertIn(("updated", REQ, "requester"), self.mails(t.id))
        r = self.row()
        self.assertEqual((r.outcome, r.matched_by, r.ticket_id, r.comment_id), ("comment", "address", t.id, c.id))
        self.assertEqual(len(self.tickets()), 1)            # never a second ticket

    def _waiting(self, tid):
        r = self.as_(ADMIN).patch(f"/task-tickets/{tid}", json={"status": "waiting_user"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.ticket(tid).sla_paused_at)

    def test_a_requester_reply_resumes_a_waiting_ticket_in_the_app(self):
        """The drawer sends its reply as `comment` on the one PATCH it makes
        at Done (TicketsView -> api.updateTaskTicket)."""
        self._waiting(self.t["id"])
        r = self.as_(REQ).patch(f"/task-tickets/{self.t['id']}", json={"comment": "<p>Here it is</p>"})
        self.assertEqual(r.status_code, 200, r.text)
        t = self.ticket(self.t["id"])
        self.assertEqual(t.status, "open")                  # nobody has it yet
        self.assertEqual(t.sla_paused_at or "", "")         # the SLA clock runs again
        self.db.expire_all()
        lines = [a.detail for a in self.db.query(models.TaskActivity)
                 .filter_by(entity_id=t.id, type="status_changed").all()]
        self.assertEqual(lines[-1], "changed status to Open")

    def test_the_comments_endpoint_resumes_too(self):
        self._waiting(self.t["id"])
        r = self.as_(REQ).post(f"/task-tickets/{self.t['id']}/comments", json={"body": "<p>Here it is</p>"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.ticket(self.t["id"]).status, "open")

    def test_a_save_that_sets_the_status_itself_wins(self):
        self.as_(ADMIN).patch(f"/task-tickets/{self.t['id']}", json={"assignee_email": AGENT})
        self._waiting(self.t["id"])
        r = self.as_(AGENT).patch(f"/task-tickets/{self.t['id']}",
                                  json={"comment": "<p>Still waiting</p>", "status": "waiting_vendor"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.ticket(self.t["id"]).status, "waiting_vendor")

    def test_a_desk_agents_own_ticket_resumes_like_anyones(self):
        own = self.file_in_app(who=AGENT, subject="My laptop")
        self.as_(ADMIN).patch(f"/task-tickets/{own['id']}", json={"assignee_email": ADMIN})
        self._waiting(own["id"])
        r = self.as_(AGENT).patch(f"/task-tickets/{own['id']}", json={"comment": "<p>Done that</p>"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.ticket(own["id"]).status, "in_progress")

    def test_a_requester_reply_by_email_resumes_an_assigned_ticket_to_in_progress(self):
        self.as_(ADMIN).patch(f"/task-tickets/{self.t['id']}", json={"assignee_email": AGENT})
        self._waiting(self.t["id"])
        before = self.bells(AGENT, "ticket_status")
        self.assertEqual(self.ingest(_msg(to=[parse.reply_address(SUPPORT, self.t["id"])],
                                          body="<p>Here it is</p>")), "comment")
        t = self.ticket(self.t["id"])
        self.assertEqual(t.status, "in_progress")
        self.assertEqual(t.sla_paused_at or "", "")
        self.assertEqual(self.bells(AGENT, "ticket_status"), before + 1)   # the assignee hears it moved

    def test_a_desk_agents_reply_never_moves_the_status(self):
        self.as_(ADMIN).patch(f"/task-tickets/{self.t['id']}", json={"assignee_email": AGENT})
        self._waiting(self.t["id"])
        r = self.as_(AGENT).post(f"/task-tickets/{self.t['id']}/comments", json={"body": "<p>Any update?</p>"})
        self.assertEqual(r.status_code, 201, r.text)
        self.ingest(_msg(sender=AGENT, to=[parse.reply_address(SUPPORT, self.t["id"])], body="<p>Ping</p>"))
        t = self.ticket(self.t["id"])
        self.assertEqual(t.status, "waiting_user")
        self.assertTrue(t.sla_paused_at)

    def test_a_reply_by_subject_tag(self):
        msg = _msg(subject=f"RE: Ticket #{int(self.t['code'])} - Greens (\"Monitor flickers\") - Open",
                   body="<p>Still flickering.</p>")
        self.assertEqual(self.ingest(msg), "comment")
        self.assertEqual(self.row().matched_by, "subject")
        self.assertEqual(self.comments(self.t["id"])[-1].author_email, REQ)

    def test_a_reply_by_threading_header(self):
        self.db.add(models.TicketEmailLog(id=gen_id(), ticket_id=self.t["id"], ticket_code=self.t["code"],
                                          event_type="created", idempotency_key=gen_id(), recipient=REQ,
                                          internet_message_id="<sent-1@greensglobal.com>", status="sent"))
        self.db.commit()
        msg = _msg(subject="RE: hello", headers={"In-Reply-To": "<sent-1@greensglobal.com>"},
                   body="<p>Thanks</p>")
        self.assertEqual(self.ingest(msg), "comment")
        self.assertEqual(self.row().matched_by, "headers")

    def test_an_at_mention_of_a_colleague_who_can_see_it_pulls_them_in(self):
        msg = _msg(to=[parse.reply_address(SUPPORT, self.t["id"])],
                   body=f'<p><a href="mailto:{COLLEAGUE}">@Colleague</a> can you look?</p>')
        self.ingest(msg)
        self.assertIn(COLLEAGUE, self.ticket(self.t["id"]).watcher_emails)

    def test_a_plain_mailto_link_adds_nobody(self):
        """Signatures and typed addresses are mailto links too - in an email
        they are not mentions, and the link is unwrapped to its text."""
        msg = _msg(to=[parse.reply_address(SUPPORT, self.t["id"])],
                   body=f'<p>Ask <a href="mailto:{COLLEAGUE}">{COLLEAGUE}</a> about it.</p>')
        self.ingest(msg)
        t = self.ticket(self.t["id"])
        self.assertNotIn(COLLEAGUE, t.watcher_emails or [])
        body = self.comments(t.id)[-1].body
        self.assertNotIn("mailto:", body)
        self.assertIn(COLLEAGUE, body)

    def test_an_at_mention_of_someone_behind_the_wall_adds_nobody(self):
        msg = _msg(to=[parse.reply_address(SUPPORT, self.t["id"])],
                   body=f'<p><a href="mailto:{INDIA}">@India</a> thoughts?</p>')
        self.ingest(msg)
        self.assertNotIn(INDIA, self.ticket(self.t["id"]).watcher_emails or [])

    def test_someone_off_the_ticket_cannot_reply_to_it(self):
        msg = _msg(sender=OTHER, to=[parse.reply_address(SUPPORT, self.t["id"])])
        self.refused(msg, "cannot comment")
        self.assertEqual(self.comments(self.t["id"]), [])

    def test_a_subject_tag_of_someone_elses_ticket_is_just_a_new_email(self):
        """Only the subject route falls through: "Ticket #N" in a subject is
        not proof of a reply, and the sender cannot see #N anyway."""
        self.assertEqual(self.ingest(_msg(sender=OTHER, subject=f"Same as Ticket #{int(self.t['code'])}")),
                         "created")
        self.assertEqual(self.comments(self.t["id"]), [])
        self.assertEqual(len(self.tickets()), 2)
        self.assertEqual(self.row().matched_by, "")

    def test_the_plus_address_of_someone_elses_ticket_is_still_refused(self):
        self.refused(_msg(sender=OTHER, to=[parse.reply_address(SUPPORT, self.t["id"])],
                          subject=f"RE: Ticket #{int(self.t['code'])}"), "cannot comment")

    def test_a_reply_to_a_deleted_ticket_is_refused(self):
        tid = self.t["id"]
        r = self.as_(ADMIN).delete(f"/task-tickets/{tid}")
        self.assertEqual(r.status_code, 204, r.text)
        self.refused(_msg(to=[parse.reply_address(SUPPORT, tid)]), "no longer exists")

    def test_reply_all_on_the_original_email_is_a_comment_not_a_second_ticket(self):
        original = _msg(cc=[COLLEAGUE], imid="<orig-1@greensglobal.com>", conversation="conv-orig",
                        subject="Wifi down on 2")
        self.assertEqual(self.ingest(original), "created")
        tid = next(t.id for t in self.tickets() if t.subject == "Wifi down on 2")
        reply = _msg(sender=COLLEAGUE, cc=[REQ], subject="RE: Wifi down on 2", conversation="conv-orig",
                     headers={"In-Reply-To": "<orig-1@greensglobal.com>"}, body="<p>Same here.</p>")
        self.assertEqual(self.ingest(reply), "comment")
        self.assertEqual(len(self.tickets()), 2)            # the setUp ticket and this one
        self.assertEqual(self.comments(tid)[-1].author_email, COLLEAGUE)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.TicketInboundEmail)
                         .filter_by(internet_message_id=reply["internetMessageId"]).one().matched_by, "thread")
        # The thread id alone (a client that drops In-Reply-To) is enough too.
        again = _msg(subject="RE: Wifi down on 2", conversation="conv-orig", body="<p>Back up now.</p>")
        self.assertEqual(self.ingest(again), "comment")

    def test_a_reply_with_no_new_words_is_not_a_comment(self):
        self.refused(_msg(to=[parse.reply_address(SUPPORT, self.t["id"])],
                          body='<div id="Signature">Req Person</div>'), "no new text", status="ignored")


# ── Refusals ─────────────────────────────────────────────────────────────────
class RefusalTests(_Base):
    def test_an_unknown_sender(self):
        self.refused(_msg(sender="stranger@evil.example"), "not a known Nexus person")

    def test_a_colleagues_name_at_another_domain_is_not_that_colleague(self):
        """resolve_person matches the local part (for the onmicrosoft relay);
        outside our own domains that would file a ticket as REQ for anyone
        who signs up for req@ somewhere else."""
        self.refused(_msg(sender="req@evil.example"), "not a known Nexus person")

    def test_a_guest_or_external_account(self):
        self.refused(_msg(sender=GUEST), "guest or external")

    def test_an_offboarded_person(self):
        self.refused(_msg(sender=LEFT), "offboarded")

    def test_automated_mail(self):
        self.refused(_msg(headers={"Auto-Submitted": "auto-replied"}), "automated", status="ignored")
        self.db.query(models.TicketInboundEmail).delete()
        self.db.commit()
        self.refused(_msg(headers={"List-Id": "<news.greensglobal.com>"}), "automated", status="ignored")

    def test_our_own_mailboxes(self):
        for box in (SUPPORT, SENDER_BOX, TASKS_BOX):
            with self.subTest(box=box):
                self.db.query(models.TicketInboundEmail).delete()
                self.db.commit()
                self.refused(_msg(sender=box), "our own mailboxes", status="ignored")

    def test_failed_authentication_is_refused(self):
        for headers in ({"Authentication-Results": "spf=pass smtp.mailfrom=greensglobal.com; dmarc=fail action=none"},
                        {"Authentication-Results": "dmarc=pass; compauth=fail reason=601"},
                        {"X-MS-Exchange-Organization-AuthAs": "Anonymous"}):
            with self.subTest(headers=headers):
                self.db.query(models.TicketInboundEmail).delete()
                self.db.commit()
                r = self.refused(_msg(headers=headers), "sender failed authentication")
                self.assertTrue(r.auth_summary.startswith("auth: "))

    def test_an_explicit_pass_wins_over_a_non_internal_authas(self):
        self.assertEqual(self.ingest(_msg(headers={"Authentication-Results": "dmarc=pass action=none",
                                                   "X-MS-Exchange-Organization-AuthAs": "Anonymous"})), "created")
        self.assertIn("authas=Anonymous", self.row().auth_summary)
        self.db.query(models.TicketInboundEmail).delete()
        self.db.commit()
        self.assertEqual(self.ingest(_msg(headers={"Authentication-Results": "compauth=pass reason=100",
                                                   "X-MS-Exchange-Organization-AuthAs": "Anonymous"})), "created")

    def test_passing_or_absent_authentication_is_allowed_and_recorded(self):
        self.ingest(_msg(headers={"Authentication-Results": "spf=pass; dkim=pass; dmarc=pass action=none; compauth=pass",
                                  "X-MS-Exchange-Organization-AuthAs": "Internal"}))
        self.assertEqual(self.row().auth_summary,
                         "auth: dmarc=pass compauth=pass spf=pass dkim=pass authas=Internal")
        self.db.query(models.TicketInboundEmail).delete()
        self.db.commit()
        self.assertEqual(self.ingest(_msg()), "created")
        self.assertEqual(self.row().auth_summary, "auth: no authentication headers")

    def test_an_inbox_rule_forward_loop_is_refused(self):
        for headers in ({"X-MS-Exchange-Inbox-Rules-Loop": REQ},
                        {"X-MS-Exchange-Generated-Message-Source": "Mailbox Rules Agent"},
                        {"X-MS-Exchange-Organization-AutoForwarded": "true"}):
            with self.subTest(headers=headers):
                self.db.query(models.TicketInboundEmail).delete()
                self.db.commit()
                self.refused(_msg(headers=headers), "forwarding rule", status="ignored")

    def test_no_default_department_for_the_company(self):
        self.refused(_msg(sender=INDIA), "no default department")

    def test_an_oversized_body(self):
        self.refused(_msg(body="<p>" + "x" * (inbound.MAX_RAW_BODY_CHARS + 10) + "</p>"), "too large")

    def test_the_hourly_limit_on_new_tickets(self):
        for _ in range(inbound.NEW_TICKETS_PER_HOUR):
            self.assertEqual(self.ingest(_msg()), "created")
        self.assertEqual(self.ingest(_msg()), "refused")
        self.db.expire_all()
        last = (self.db.query(models.TicketInboundEmail)
                .filter_by(outcome="refused").one())
        self.assertIn("limit", last.reason)
        self.assertEqual(len(self.tickets()), inbound.NEW_TICKETS_PER_HOUR)
        # Another person is not held to this sender's count.
        self.assertEqual(self.ingest(_msg(sender=COLLEAGUE)), "created")


# ── Attachments ──────────────────────────────────────────────────────────────
class AttachmentTests(_Base):
    def setUp(self):
        super().setUp()
        self.atts, self.stored = [], []
        self.detail = {"sourceUrl": "https://greensglobal-my.sharepoint.com/f.docx", "contentId": ""}
        for name, fn in (("list_attachments", lambda mbx, mid: self.atts),
                         ("fetch_attachment_bytes", lambda mbx, mid, aid: b"x" * 4096),
                         ("fetch_attachment", lambda mbx, mid, aid: self.detail)):
            p = patch.object(inbound, name, side_effect=fn)
            p.start()
            self.addCleanup(p.stop)

        def fake_store(name, raw, content_type, bucket="task-files", folder="tasks"):
            self.stored.append((name, bucket, folder))
            return f"https://sb.test/storage/v1/object/public/{bucket}/{folder}/{name}"

        p = patch.object(inbound.task_files, "store_bytes", side_effect=fake_store)
        p.start()
        self.addCleanup(p.stop)

    def _file(self, **kw):
        return {"@odata.type": kw.get("odata", "#microsoft.graph.fileAttachment"),
                "id": uuid.uuid4().hex, "name": kw.get("name", "jam.jpg"),
                "contentType": kw.get("content_type", "image/jpeg"), "size": 4096, "isInline": False}

    def _attachments(self, tid):
        self.db.expire_all()
        return self.db.query(models.TaskAttachment).filter_by(task_id=tid).all()

    def test_files_on_a_new_email_go_to_the_private_evidence_bucket(self):
        self.atts = [self._file(name="jam.jpg"), self._file(name="clip.mov", content_type="video/quicktime")]
        self.ingest(_msg(has_attachments=True))
        t = self.tickets()[0]
        self.assertEqual({(n, b) for n, b, _ in self.stored}, {("jam.jpg", "ticket-evidence"), ("clip.mov", "ticket-evidence")})
        files = {a.name: a for a in self._attachments(t.id)}
        self.assertEqual((files["jam.jpg"].kind, files["clip.mov"].kind), ("image", "video"))
        self.assertIn("/object/public/ticket-evidence/", files["jam.jpg"].url)     # canonical URL stored
        self.assertEqual(files["jam.jpg"].added_by, REQ)
        self.assertEqual(self.row().attachment_count, 2)
        self.assertEqual(self.activity(t.id, "attached"), 2)

    def test_files_on_a_reply_land_on_that_ticket(self):
        t = self.file_in_app()
        self.atts = [self._file(name="photo.jpg")]
        self.ingest(_msg(sender=AGENT, to=[parse.reply_address(SUPPORT, t["id"])], has_attachments=True))
        self.assertEqual([a.name for a in self._attachments(t["id"])], ["photo.jpg"])
        self.assertEqual(self.bells(REQ, "ticket_updated"), 1)        # "File attached", as in the drawer

    def test_a_onedrive_link_is_not_filed_on_a_ticket(self):
        self.atts = [self._file(name="spec.docx", odata="#microsoft.graph.referenceAttachment")]
        with patch("routers.items._STORAGE_PREFIX", "https://sb.test/storage/v1/object/public/"):
            self.ingest(_msg(has_attachments=True))
        self.assertEqual(self._attachments(self.tickets()[0].id), [])
        self.assertIn("spec.docx", self.row().reason)


# ── The gate ─────────────────────────────────────────────────────────────────
class GateTests(_Base):
    def setUp(self):
        super().setUp()
        self.listed = []
        self.handled = []
        self.queue = []
        p = patch.object(inbound, "list_unread",
                         side_effect=lambda mbx, top=25: (self.listed.append(mbx) or [{"id": m["id"]} for m in self.queue]))
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(inbound, "get_message",
                         side_effect=lambda mbx, mid: next(m for m in self.queue if m["id"] == mid))
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(mail_inbound, "mark_handled",
                         side_effect=lambda mbx, mid, tag="": self.handled.append(mid))
        p.start()
        self.addCleanup(p.stop)

    def test_a_pass_reads_files_and_marks_handled(self):
        self.queue = [_msg()]
        counts = inbound.drain_once(self.db)
        self.assertEqual((counts["seen"], counts["created"]), (1, 1))
        self.assertEqual(self.listed, [SUPPORT])
        self.assertEqual(self.handled, [self.queue[0]["id"]])

    def test_switched_off_reads_nothing(self):
        ticket_notify.save_settings(self.db, {"inboundEnabled": False}, "test")
        self.queue = [_msg()]
        self.assertEqual(inbound.drain_once(self.db)["seen"], 0)
        self.assertEqual(self.listed, [])

    def test_not_the_deployed_worker_reads_nothing(self):
        self.queue = [_msg()]
        with patch("leader.is_deployed_worker", return_value=False):
            inbound._drain_in_thread()
        self.assertEqual(self.listed, [])

    def test_the_lock_held_elsewhere_reads_nothing(self):
        self.queue = [_msg()]
        from contextlib import contextmanager

        @contextmanager
        def held(db, key):
            yield False

        with patch.object(mail_inbound, "pass_lock", held):
            self.assertEqual(inbound.drain_once(self.db)["seen"], 0)
        self.assertEqual(self.listed, [])

    def test_the_tasks_mailbox_is_never_read_here(self):
        task_notify.save_settings(self.db, {"replyTo": SUPPORT}, "test")   # changed on the Tasks side later
        self.queue = [_msg()]
        self.assertEqual(inbound.drain_once(self.db)["seen"], 0)
        self.assertEqual(self.listed, [])


# ── Outbound Reply-To and settings ───────────────────────────────────────────
class OutboundAndSettingsTests(_Base):
    def test_reply_to_is_the_signed_ticket_address_only_while_inbound_is_on(self):
        t = self.file_in_app()
        reply_tos = {kw.get("reply_to") for kw in self.sent}
        self.assertEqual(reply_tos, {parse.reply_address(SUPPORT, t["id"])})
        # ...and a reply landing on it comes back to this ticket.
        self.assertEqual(parse.ticket_id_from_recipients(SUPPORT, list(reply_tos)), t["id"])

        ticket_notify.save_settings(self.db, {"inboundEnabled": False, "replyTo": "helpdesk@greensglobal.com"}, "test")
        self.sent.clear()
        self.file_in_app(subject="Another")
        self.assertEqual({kw.get("reply_to") for kw in self.sent}, {"helpdesk@greensglobal.com"})

    def test_the_tasks_mailbox_is_refused_on_save(self):
        for box in (TASKS_BOX, "Tasks+anything@greensglobal.com"):
            with self.subTest(box=box):
                r = self.as_(ADMIN).put("/task-tickets/notify/settings", json={"inboundMailbox": box})
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn("Tasks", r.json()["detail"])
        self.assertEqual(ticket_notify.get_settings(self.db)["inboundMailbox"], SUPPORT)
        ok = self.as_(ADMIN).put("/task-tickets/notify/settings", json={"inboundMailbox": "Help@GreensGlobal.com"})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["inboundMailbox"], "help@greensglobal.com")

    def test_a_default_department_must_be_that_companys(self):
        bad = self.as_(ADMIN).put("/task-tickets/notify/settings",
                                  json={"inboundDefaultDepartment": {"co1": "dIT2"}})
        self.assertEqual(bad.status_code, 400, bad.text)
        ok = self.as_(ADMIN).put("/task-tickets/notify/settings",
                                 json={"inboundDefaultDepartment": {"co1": "dIT", "co2": "dIT2", "co3": ""}})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["inboundDefaultDepartment"], {"co1": "dIT", "co2": "dIT2"})

    def test_a_department_deleted_since_does_not_block_the_save(self):
        self.db.query(models.HrDepartment).filter_by(id="dIT").delete()
        self.db.commit()
        r = self.as_(ADMIN).put("/task-tickets/notify/settings",
                                json={"inboundDefaultDepartment": {"co1": "dIT"}, "autoCloseDays": 3})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["inboundDefaultDepartment"], {})

    def test_default_departments_respect_the_company_wall(self):
        """ADMIN works for co1 only once walls are on: co2's entry is kept
        exactly as stored, whatever the save says about it."""
        ticket_notify.save_settings(self.db, {"inboundDefaultDepartment": {"co1": "dIT", "co2": "dIT2"}}, "test")
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        # A populated Global Admins group: from then on an administrator's
        # level alone no longer reaches across companies (auth.is_global_admin).
        self.db.add(models.NexusGroup(id="ga", name="Global Admins", is_global_admin=1))
        self.db.add(models.NexusGroupMember(group_id="ga", email="ga@greensglobal.com"))
        self.db.commit()
        cache.settings_config.invalidate()
        put = lambda d: self.as_(ADMIN).put("/task-tickets/notify/settings",      # noqa: E731
                                            json={"inboundDefaultDepartment": d})
        r = put({"co1": ""})                                    # clears their own company's
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["inboundDefaultDepartment"], {"co2": "dIT2"})
        r = put({"co1": "dIT", "co2": "dBogus"})                # another company's: ignored
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["inboundDefaultDepartment"], {"co1": "dIT", "co2": "dIT2"})
        r = put({})                                             # dropping it from the payload does not clear it
        self.assertEqual(r.json()["inboundDefaultDepartment"], {"co2": "dIT2"})

    def test_the_switch_and_mailbox_are_global_admins_only(self):
        self.db.add(models.NexusGroup(id="ga", name="Global Admins", is_global_admin=1))
        self.db.add(models.NexusGroupMember(group_id="ga", email="ga@greensglobal.com"))
        self.db.commit()
        cfg = self.as_(ADMIN).get("/task-tickets/notify/settings").json()
        self.assertEqual(self.as_(ADMIN).put("/task-tickets/notify/settings",
                                             json={"inboundEnabled": False}).status_code, 403)
        self.assertEqual(self.as_(ADMIN).put("/task-tickets/notify/settings",
                                             json={"inboundMailbox": "help@greensglobal.com"}).status_code, 403)
        # The form's whole copy, unchanged, still saves - with a default department of their own.
        cfg["inboundDefaultDepartment"] = {"co1": "dIT"}
        cfg["autoCloseDays"] = 7
        r = self.as_(ADMIN).put("/task-tickets/notify/settings", json=cfg)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["inboundEnabled"])

    def test_the_manual_drain_is_the_deployed_workers_only(self):
        with patch("leader.is_deployed_worker", return_value=False):
            r = self.as_(ADMIN).post("/task-tickets/inbound/drain")
        self.assertEqual(r.status_code, 409, r.text)

    def test_switching_on_needs_a_mailbox(self):
        ticket_notify.save_settings(self.db, {"inboundEnabled": False, "inboundMailbox": ""}, "test")
        r = self.as_(ADMIN).put("/task-tickets/notify/settings", json={"inboundEnabled": True})
        self.assertEqual(r.status_code, 400, r.text)

    def test_the_log_is_for_supervisors(self):
        self.ingest(_msg())
        self.ingest(_msg(sender="stranger@evil.example"))
        r = self.as_(ADMIN).get("/task-tickets/inbound/log")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["total"], 2)
        created = next(x for x in body["rows"] if x["outcome"] == "created")
        self.assertTrue(created["ticketCode"])
        self.assertEqual(self.as_(ADMIN).get("/task-tickets/inbound/log?outcome=refused").json()["total"], 1)
        self.assertIn(self.as_(REQ).get("/task-tickets/inbound/log").status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
