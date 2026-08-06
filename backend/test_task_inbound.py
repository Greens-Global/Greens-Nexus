"""
Inbound email -> task comment (Task Inbound Email, Aug 2026).

Two halves, both covered here:

  parsing   the signed reply address, spotting machine-generated mail, and
            turning a real client's reply HTML into a comment body. Pure
            functions, so the fiddly part of email is tested without a mailbox.
  ingest    what becomes of one fetched message: whose comment it is, whether
            they are allowed to post it, and the row written when they are not.

The refusals matter more than the happy path. A mailbox that anyone on the
internet can mail is the least trusted input this app has, and every test below
that asserts "rejected" is a way someone else's words could otherwise have been
posted onto a task under a colleague's name.

Uses a throwaway sqlite file. No network - Graph is never called; ingest_message
is fed the message dicts Graph would have returned.

Run with: python -m unittest test_task_inbound -v
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import atexit

import database
import models
import task_inbound as inbound
import task_inbound_parse as parse
import task_notify
from routers import task_util
from routers.task_util import gen_id, now_iso

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop_the_scratch_db():
    """Module scope, not per class: two TestCases share this database, and a
    per-class tearDown would delete the file out from under the second one."""
    database.engine.dispose()
    try:
        os.remove(_tmp_db.name)
    except OSError:
        pass

MAILBOX = "tasks@greensglobal.com"
CFG = {"inboundEnabled": True, "inboundMailbox": MAILBOX, "replyTo": MAILBOX}
SENDER = "sagar.shoundik@greensglobal.com"
RELAY = "sagar.shoundik@greensg.onmicrosoft.com"   # the same human, via the guest relay


def _msg(**kw):
    """A Graph message, with only the fields a test cares about overridden."""
    m = {
        "id": kw.get("id", "AAMk" + uuid.uuid4().hex[:12]),
        "subject": kw.get("subject", "Re: Fix the pump"),
        "from": {"emailAddress": {"address": kw.get("sender", SENDER)}},
        "toRecipients": [{"emailAddress": {"address": a}} for a in kw.get("to", [MAILBOX])],
        "ccRecipients": [],
        "receivedDateTime": "2026-08-05T09:00:00Z",
        "conversationId": kw.get("conversation", ""),
        "internetMessageId": kw.get("imid", f"<{uuid.uuid4().hex}@greensglobal.com>"),
        "internetMessageHeaders": [{"name": k, "value": v}
                                   for k, v in (kw.get("headers") or {}).items()],
        "body": {"contentType": "html", "content": kw.get("body", "")},
        "hasAttachments": kw.get("has_attachments", False),
    }
    if "unique" in kw:
        m["uniqueBody"] = {"contentType": "html", "content": kw["unique"]}
    return m


# ── Parsing (no DB) ──────────────────────────────────────────────────────────
class ReplyAddressTests(unittest.TestCase):
    def setUp(self):
        self.task_id = gen_id()

    def test_the_address_round_trips_to_its_task(self):
        addr = parse.reply_address(MAILBOX, self.task_id)
        self.assertTrue(addr.startswith("tasks+"))
        self.assertEqual(parse.task_id_from_recipients(MAILBOX, [addr]), self.task_id)

    def test_a_forged_token_resolves_to_nothing(self):
        """Without the signature, knowing any task id would be enough to post a
        comment on it by email."""
        forged = f"tasks+{uuid.uuid4().hex}.deadbeef@greensglobal.com"
        self.assertEqual(parse.task_id_from_recipients(MAILBOX, [forged]), "")

    def test_a_tampered_task_id_resolves_to_nothing(self):
        addr = parse.reply_address(MAILBOX, self.task_id)
        local, domain = addr.split("@")
        hexid, sig = local.split("+", 1)[1].split(".")
        other = uuid.uuid4().hex                       # someone else's task, our signature
        self.assertEqual(parse.task_id_from_recipients(MAILBOX, [f"tasks+{other}.{sig}@{domain}"]), "")

    def test_another_domain_is_not_our_mailbox(self):
        addr = parse.reply_address(MAILBOX, self.task_id)
        spoofed = addr.replace("@greensglobal.com", "@evil.example")
        self.assertEqual(parse.task_id_from_recipients(MAILBOX, [spoofed]), "")

    def test_it_is_found_among_several_recipients(self):
        addr = parse.reply_address(MAILBOX, self.task_id)
        others = ["neil@greensglobal.com", MAILBOX, addr]
        self.assertEqual(parse.task_id_from_recipients(MAILBOX, others), self.task_id)


class AutoReplyTests(unittest.TestCase):
    def test_a_person_writing_a_reply_is_not_automated(self):
        self.assertFalse(parse.is_auto_reply({"Auto-Submitted": "no", "Subject": "Re: x"}))

    def test_out_of_office_and_bounces_are_refused(self):
        """The loop this prevents: a reply posts a comment, the comment mails
        the followers, a follower's out-of-office answers the mailbox."""
        for headers in ({"Auto-Submitted": "auto-replied"},
                        {"Precedence": "bulk"},
                        {"X-Autoreply": "yes"},
                        {"Return-Path": "<>"},
                        {"List-Id": "<announce.greensglobal.com>"}):
            with self.subTest(headers=headers):
                self.assertTrue(parse.is_auto_reply(headers))


class CleanBodyTests(unittest.TestCase):
    def test_outlook_divs_keep_their_line_breaks(self):
        out = parse.clean_body(html="<div>Ordered the seal.</div><div>Arrives Friday.</div>")
        self.assertEqual(out, "Ordered the seal.<br>Arrives Friday.")

    def test_quoted_history_is_cut(self):
        html = ('<div>On it.</div><div id="appendonsend"></div>'
                '<div>From: Nexus<br>Sent: Tuesday<br>The original notification</div>')
        self.assertEqual(parse.clean_body(html=html), "On it.")

    def test_a_signature_block_is_cut(self):
        html = '<div>Done.</div><div id="Signature"><p>Sagar Shoundik | Greens Global</p></div>'
        self.assertEqual(parse.clean_body(html=html), "Done.")

    def test_a_gmail_quote_is_cut(self):
        html = '<div>Approved.</div><blockquote class="gmail_quote">old mail</blockquote>'
        self.assertEqual(parse.clean_body(html=html), "Approved.")

    def test_script_and_style_go_with_their_contents(self):
        """Stored HTML that is re-rendered in the drawer AND inlined into the
        outbound notification mail - the client sanitizer never runs on that
        second path, so it has to be clean before it is stored."""
        html = '<p>hi<script>steal(document.cookie)</script><style>b{}</style></p>'
        self.assertEqual(parse.clean_body(html=html), "<p>hi</p>")

    def test_event_handlers_and_script_urls_do_not_survive(self):
        html = '<p onmouseover="steal()">click <a href="javascript:steal()">here</a></p>'
        out = parse.clean_body(html=html)
        self.assertNotIn("onmouseover", out)
        self.assertNotIn("javascript:", out)
        self.assertIn("click here", out)

    def test_a_real_link_and_a_mention_survive(self):
        """Mentions ARE mailto links (extract_mentions) - stripping them would
        silently stop an emailed reply from ever mentioning anyone."""
        html = '<p><a href="mailto:neil@greensglobal.com">@Neil</a> see <a href="https://x.test/a">this</a></p>'
        out = parse.clean_body(html=html)
        self.assertIn('href="mailto:neil@greensglobal.com"', out)
        self.assertIn('href="https://x.test/a"', out)

    def test_images_are_dropped(self):
        """Every signature carries a logo, and a cid: reference points at bytes
        no browser here can resolve. Phase 2 files real attachments properly."""
        out = parse.clean_body(html='<p>done <img src="cid:logo123"></p>')
        self.assertNotIn("img", out)
        self.assertIn("done", out)

    def test_a_plain_text_reply_becomes_paragraphs(self):
        out = parse.clean_body(text="Ordered the seal.\n\nArrives Friday.\n\n-- \nSagar")
        self.assertEqual(out, "<p>Ordered the seal.</p><p>Arrives Friday.</p>")

    def test_nothing_but_a_quote_is_nothing(self):
        self.assertEqual(parse.clean_body(html='<blockquote>the original</blockquote>'), "")
        self.assertEqual(parse.clean_body(html='<div id="Signature">Sagar</div>'), "")

    def test_an_enormous_reply_is_truncated_not_stored_whole(self):
        out = parse.clean_body(html="<p>" + ("x" * 60000) + "</p>")
        self.assertLess(len(out), parse.MAX_BODY_CHARS + 100)
        self.assertIn("truncated", out)


# ── Ingest (DB, no network) ──────────────────────────────────────────────────
class _MailboxCase(unittest.TestCase):
    """One task, one known sender, nothing else - shared by the ingest and
    attachment cases. Holds no tests of its own, so neither class re-runs the
    other's."""

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.TaskAttachment, models.TaskActivity,
                  models.TaskProject, models.TaskNotification, models.NexusNotification,
                  models.TaskEmailLog, models.TaskInboundEmail, models.NexusEmployee,
                  models.NexusRole):
            self.db.query(m).delete()
        self.db.commit()

        self.task = models.Task(id=gen_id(), title="Fix the pump", code="TASK-1",
                                assignee_email="neil@greensglobal.com", follower_emails=[],
                                comment_ids=[], activity_ids=[],
                                created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.task)
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Sagar", last_name="Shoundik",
                                         work_email=SENDER, status="active"))
        self.db.commit()

        # auth caches role levels for 120s in a module global, so a role granted
        # by one test would otherwise still apply in the next one.
        import auth
        auth.invalidate_role_cache()

        self._real_push = task_util.asana_push_comment
        self._real_notify = task_notify.notify_task_event
        task_util.asana_push_comment = lambda cid: None
        task_notify.notify_task_event = lambda *a, **kw: None

    def tearDown(self):
        task_util.asana_push_comment = self._real_push
        task_notify.notify_task_event = self._real_notify
        self.db.close()

    def _row(self):
        return self.db.query(models.TaskInboundEmail).one()

    def _comments(self):
        return self.db.query(models.TaskComment).all()

    def _reply_to_task(self, **kw):
        kw.setdefault("to", [parse.reply_address(MAILBOX, self.task.id)])
        kw.setdefault("body", "<div>Ordered the seal.</div>")
        return _msg(**kw)

    def _attachments(self):
        return self.db.query(models.TaskAttachment).all()


class IngestTests(_MailboxCase):
    # ── the happy path ───────────────────────────────────────────────────
    def test_a_reply_becomes_a_comment_by_its_sender(self):
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task()), "posted")
        c = self._comments()[0]
        self.assertEqual(c.task_id, self.task.id)
        self.assertEqual(c.author_email, SENDER)
        self.assertEqual(c.body, "Ordered the seal.")
        self.assertEqual(self.task.comment_ids, [c.id])

    def test_the_comment_carries_the_full_side_effects(self):
        """It goes through create_comment, so the activity feed sees it too -
        an emailed comment is not a lesser comment."""
        inbound.ingest_message(self.db, CFG, self._reply_to_task())
        self.assertEqual([a.type for a in self.db.query(models.TaskActivity).all()], ["commented"])

    def test_the_row_records_what_happened(self):
        inbound.ingest_message(self.db, CFG, self._reply_to_task())
        row = self._row()
        self.assertEqual((row.status, row.matched_by, row.task_id), ("posted", "address", self.task.id))
        self.assertEqual(row.comment_id, self._comments()[0].id)

    def test_uniquebody_is_preferred_over_body(self):
        """Exchange has already stripped the quoted history in uniqueBody."""
        msg = self._reply_to_task(unique="<div>Just this.</div>",
                                  body="<div>Just this.</div><div>quoted original</div>")
        inbound.ingest_message(self.db, CFG, msg)
        self.assertEqual(self._comments()[0].body, "Just this.")

    def test_the_same_message_twice_posts_one_comment(self):
        """The message is marked read only after the comment commits, so a crash
        in between shows it to the next pass again."""
        msg = self._reply_to_task()
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "posted")
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "duplicate")
        self.assertEqual(len(self._comments()), 1)

    # ── routing ──────────────────────────────────────────────────────────
    def test_a_reply_routes_by_threading_header_when_the_address_is_gone(self):
        self.db.add(models.TaskEmailLog(id=gen_id(), task_id=self.task.id, task_code="TASK-1",
                                        event_type="assigned", idempotency_key=gen_id(),
                                        recipient=SENDER, internet_message_id="<sent-1@nexus>",
                                        status="sent", created_at=now_iso()))
        self.db.commit()
        msg = _msg(to=[MAILBOX], headers={"In-Reply-To": "<sent-1@nexus>"},
                   body="<div>On it.</div>")
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "posted")
        self.assertEqual(self._row().matched_by, "headers")

    def test_a_reply_routes_by_conversation_as_a_last_resort(self):
        self.db.add(models.TaskEmailLog(id=gen_id(), task_id=self.task.id, task_code="TASK-1",
                                        event_type="assigned", idempotency_key=gen_id(),
                                        recipient=SENDER, conversation_id="conv-9",
                                        status="sent", created_at=now_iso()))
        self.db.commit()
        msg = _msg(to=[MAILBOX], conversation="conv-9", body="<div>On it.</div>")
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "posted")
        self.assertEqual(self._row().matched_by, "conversation")

    def test_mail_that_matches_no_task_is_rejected_with_a_reason(self):
        status = inbound.ingest_message(self.db, CFG, _msg(to=[MAILBOX], body="<p>hello?</p>"))
        self.assertEqual(status, "rejected")
        self.assertIn("match", self._row().reason)
        self.assertEqual(self._comments(), [])

    # ── who is allowed to post ───────────────────────────────────────────
    def test_a_stranger_cannot_comment(self):
        msg = self._reply_to_task(sender="attacker@evil.example")
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "rejected")
        self.assertIn("not a known Nexus person", self._row().reason)
        self.assertEqual(self._comments(), [])

    def test_the_onmicrosoft_relay_is_the_same_person(self):
        """Outlook may deliver as the guest relay; matching only the full
        address would refuse a colleague's own reply."""
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task(sender=RELAY)),
                         "posted")
        self.assertEqual(self._comments()[0].author_email, SENDER)

    def test_an_ambiguous_local_part_is_refused_not_guessed(self):
        """Two people whose addresses differ only by domain: attributing the
        comment to either one is attributing someone's words to someone else."""
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Sagar", last_name="Other",
                                         work_email="sagar.shoundik@greens.example", status="active"))
        self.db.commit()
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task(sender=RELAY)),
                         "rejected")
        self.assertIn("more than one", self._row().reason)

    def test_an_offboarded_sender_is_refused(self):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=SENDER).one()
        emp.status = "offboarded"
        self.db.commit()
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task()), "rejected")
        self.assertIn("offboarded", self._row().reason)

    def _lock_the_task_into_a_restricted_project(self):
        project = models.TaskProject(id=gen_id(), name="Locked", access_level="restricted",
                                     owner_email="neil@greensglobal.com", member_roles={},
                                     created_at=now_iso())
        self.db.add(project)
        self.task.project_id = project.id
        self.db.commit()

    def test_project_permissions_are_not_bypassed_by_email(self):
        """The endpoint requires commenter access; arriving by mail must not be
        a way around a restricted project."""
        self._lock_the_task_into_a_restricted_project()
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task()), "rejected")
        self.assertIn("commenter access", self._row().reason)
        self.assertEqual(self._comments(), [])

    def test_a_manager_keeps_the_bypass_they_have_in_the_app(self):
        """is_manager bypasses every project role in the drawer. If replying by
        email did not, the same person would be refused by mail and allowed in
        the app on the same task."""
        self._lock_the_task_into_a_restricted_project()
        self.db.add(models.NexusRole(email=SENDER, role="manager"))
        self.db.commit()
        import auth
        auth.invalidate_role_cache(SENDER)
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task()), "posted")

    # ── what is not a comment ────────────────────────────────────────────
    def test_an_out_of_office_is_ignored(self):
        msg = self._reply_to_task(headers={"Auto-Submitted": "auto-replied"},
                                  body="<p>I am on leave until Monday.</p>")
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "ignored")
        self.assertEqual(self._comments(), [])

    def test_the_mailbox_talking_to_itself_is_ignored(self):
        msg = self._reply_to_task(sender=MAILBOX)
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "ignored")

    def test_a_reply_with_no_new_words_is_ignored(self):
        msg = self._reply_to_task(body='<div id="Signature">Sagar Shoundik</div>')
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "ignored")
        self.assertIn("no new text", self._row().reason)
        self.assertEqual(self._comments(), [])

    # ── the two halves meet ──────────────────────────────────────────────
    def test_the_address_a_notification_sends_is_the_one_ingest_reads(self):
        """The contract between task_notify (which sets Reply-To) and this
        module (which reads it). Tested end to end because each half is
        individually correct in a way that proves nothing: a reply address the
        sender never actually puts on the mail routes nobody's reply."""
        sent = {}
        real_send = task_notify.graph_mail.send_mail

        def fake_send(**kw):
            sent.update(kw)
            return {"messageId": "m1", "conversationId": "c1", "internetMessageId": "<i1@x>"}

        task_notify.graph_mail.send_mail = fake_send
        try:
            task_notify._send_one(self.db, task_id=self.task.id, task_code="TASK-1",
                                  event_type="assigned", idem_suffix="1", recipient=SENDER,
                                  role="assignee", subject="You were assigned a task",
                                  html="<p>hi</p>", cfg={"fromMailbox": MAILBOX, "replyTo": MAILBOX})
        finally:
            task_notify.graph_mail.send_mail = real_send

        reply_to = sent["reply_to"]
        self.assertNotEqual(reply_to, MAILBOX)                      # it is sub-addressed
        self.assertEqual(parse.task_id_from_recipients(MAILBOX, [reply_to]), self.task.id)
        # And a reply that lands on it comes back to this task.
        self.assertEqual(inbound.ingest_message(self.db, CFG, _msg(to=[reply_to],
                                                                   body="<div>On it.</div>")), "posted")
        self.assertEqual(self._comments()[0].task_id, self.task.id)

    # ── the gate ─────────────────────────────────────────────────────────
    def test_the_drain_does_nothing_until_it_is_switched_on(self):
        """Off by default - it needs a mailbox with the Mail.ReadWrite grant,
        so on any instance without one this must be inert, not erroring."""
        task_notify.save_settings(self.db, {"inboundEnabled": False}, "test")
        self.assertEqual(inbound.drain_once(self.db)["seen"], 0)


class AttachmentTests(_MailboxCase):
    """Files on a reply (Phase 2).

    Graph and Supabase are both stubbed: what is under test is which files are
    filed, which are refused, and what a failure does to the comment - none of
    which needs bytes to actually move.
    """

    def setUp(self):
        super().setUp()
        self.uploaded = []
        self.fetched = []
        self.detail_calls = []
        self.atts = []
        # What the per-attachment GET returns: the two properties the list
        # response cannot carry (see _ATT_FIELDS).
        self.detail = {"sourceUrl": "https://greensglobal-my.sharepoint.com/f.docx",
                       "contentId": ""}
        self._real = (inbound.list_attachments, inbound.fetch_attachment_bytes,
                      inbound.fetch_attachment, inbound.task_files.store_bytes)
        inbound.list_attachments = lambda mbx, mid: self.atts
        inbound.fetch_attachment_bytes = lambda mbx, mid, aid: (self.fetched.append(aid) or b"x" * 2048)
        inbound.fetch_attachment = lambda mbx, mid, aid: (self.detail_calls.append(aid) or self.detail)

        def fake_store(name, raw, content_type):
            self.uploaded.append((name, len(raw), content_type))
            return f"https://sb.test/storage/v1/object/public/task-files/{name}"

        inbound.task_files.store_bytes = fake_store

    def tearDown(self):
        (inbound.list_attachments, inbound.fetch_attachment_bytes,
         inbound.fetch_attachment, inbound.task_files.store_bytes) = self._real
        super().tearDown()

    def _file(self, **kw):
        """Shaped like Graph's LIST response - base properties only, so a test
        cannot accidentally rely on a contentId the real call never returns."""
        return {"@odata.type": kw.get("odata", "#microsoft.graph.fileAttachment"),
                "id": kw.get("id", uuid.uuid4().hex), "name": kw.get("name", "site.jpg"),
                "contentType": kw.get("content_type", "image/jpeg"),
                "size": kw.get("size", 2048), "isInline": kw.get("inline", False)}

    def test_a_file_is_uploaded_and_linked_to_the_comment(self):
        self.atts = [self._file(name="pump.jpg")]
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True)),
                         "posted")
        a = self._attachments()[0]
        self.assertEqual((a.name, a.kind, a.size), ("pump.jpg", "image", "2 KB"))
        self.assertEqual(a.comment_id, self._comments()[0].id)
        self.assertEqual(a.added_by, SENDER)
        self.assertIn(a.id, self.task.attachment_ids)

    def test_the_bytes_go_to_storage_not_into_the_row(self):
        """A data: URL in the row is exactly what the Asana push skips, so an
        emailed attachment stored that way would never leave Nexus."""
        self.atts = [self._file()]
        inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True))
        self.assertEqual(len(self.uploaded), 1)
        self.assertTrue(self._attachments()[0].url.startswith("https://"))
        self.assertNotIn("data:", self._attachments()[0].url)

    def test_a_reply_that_is_only_photos_is_still_a_comment(self):
        self.atts = [self._file()]
        msg = self._reply_to_task(has_attachments=True,
                                  body='<div id="Signature">Sagar</div>')
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "posted")
        self.assertEqual(self._comments()[0].body, "")
        self.assertEqual(len(self._attachments()), 1)

    def test_a_signature_logo_is_not_attached_to_the_task(self):
        """Every branded signature carries one. Attaching it to the task on
        every single reply is the noise this rule exists to stop - and because
        the signature is cut before this runs, deciding costs no Graph call."""
        self.atts = [self._file(name="logo.png", inline=True)]
        msg = self._reply_to_task(has_attachments=True,
                                  body='<div>On it.</div><div id="Signature">'
                                       '<img src="cid:logo@greens"></div>')
        self.assertEqual(inbound.ingest_message(self.db, CFG, msg), "posted")
        self.assertEqual(self._attachments(), [])
        self.assertEqual(self._row().attachment_count, 0)
        self.assertEqual(self.detail_calls, [])

    def test_a_screenshot_pasted_into_the_reply_is_kept(self):
        """Same inline flag as the logo above - the difference is that this one
        is referenced from the text the person actually wrote. Its content id is
        not in the list response, so this is also the case that pays for the
        per-attachment fetch."""
        self.detail = {"contentId": "shot@outlook"}
        self.atts = [self._file(name="shot.png", inline=True)]
        msg = self._reply_to_task(has_attachments=True,
                                  body='<div>Looks like this: <img src="cid:shot@outlook">'
                                       '</div><div id="Signature">Sagar</div>')
        inbound.ingest_message(self.db, CFG, msg)
        self.assertEqual([a.name for a in self._attachments()], ["shot.png"])
        self.assertEqual(len(self.detail_calls), 1)

    def test_a_file_over_the_cap_is_refused_and_named(self):
        self.atts = [self._file(name="drone.mov", size=40 * 1024 * 1024)]
        inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True))
        self.assertEqual(self._attachments(), [])
        self.assertIn("drone.mov", self._row().reason)
        self.assertIn("25 MB", self._row().reason)

    def test_an_attached_email_is_skipped_with_a_reason(self):
        self.atts = [self._file(name="Fwd: quote", odata="#microsoft.graph.itemAttachment")]
        inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True))
        self.assertEqual(self._attachments(), [])
        self.assertIn("attached email", self._row().reason)

    def test_a_onedrive_link_is_kept_as_a_link(self):
        """The bytes stay in the sender's OneDrive - copying them would
        duplicate a file whose sharing they control."""
        self.atts = [self._file(name="spec.docx", odata="#microsoft.graph.referenceAttachment")]
        inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True))
        a = self._attachments()[0]
        self.assertEqual(a.name, "spec.docx")
        self.assertTrue(a.url.startswith("https://greensglobal-my.sharepoint.com"))
        self.assertEqual(self.uploaded, [])          # nothing was copied

    def test_one_failed_upload_does_not_lose_the_comment(self):
        """The comment is already committed when files are fetched. A storage
        outage must cost the file, not the reply."""
        inbound.task_files.store_bytes = lambda name, raw, ct: ""   # storage down
        self.atts = [self._file(name="pump.jpg")]
        self.assertEqual(inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True)),
                         "posted")
        self.assertEqual(len(self._comments()), 1)
        self.assertEqual(self._attachments(), [])
        self.assertIn("pump.jpg", self._row().reason)

    def test_one_bad_file_does_not_stop_the_good_ones(self):
        self.atts = [self._file(name="huge.mov", size=40 * 1024 * 1024),
                     self._file(name="ok.jpg")]
        inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True))
        self.assertEqual([a.name for a in self._attachments()], ["ok.jpg"])
        self.assertEqual(self._row().attachment_count, 1)

    def test_an_absurd_number_of_files_is_capped_and_reported(self):
        self.atts = [self._file(name=f"f{i}.jpg") for i in range(inbound._MAX_ATTACHMENTS + 3)]
        inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True))
        self.assertEqual(len(self._attachments()), inbound._MAX_ATTACHMENTS)
        self.assertIn("3 more files", self._row().reason)

    def test_each_file_lands_in_the_activity_feed(self):
        self.atts = [self._file(name="pump.jpg")]
        inbound.ingest_message(self.db, CFG, self._reply_to_task(has_attachments=True))
        types = [a.type for a in self.db.query(models.TaskActivity).all()]
        self.assertEqual(sorted(types), ["attached", "commented"])

    def test_files_are_only_fetched_when_the_reply_actually_has_some(self):
        """hasAttachments is false on most replies - a Graph call per message to
        learn that is a call per message wasted."""
        self.atts = [self._file()]
        inbound.ingest_message(self.db, CFG, self._reply_to_task())
        self.assertEqual(self.fetched, [])
        self.assertEqual(self._attachments(), [])


class StorageNamingTests(unittest.TestCase):
    """Properties this module RELIES on from task_files, which owns task bytes.

    Not testing someone else's module for its own sake - an emailed attachment
    is named by a stranger, so "two people send photo.jpg" and "someone sends
    ../../etc/passwd" are this path's problem even though the fix lives there.
    """

    def test_two_files_of_the_same_name_do_not_collide(self):
        import task_files
        # The object key is uuid-prefixed, so the second photo.jpg cannot
        # overwrite the first.
        a = task_files._safe_name("photo.jpg")
        self.assertEqual(a, "photo.jpg")

    def test_a_hostile_filename_cannot_escape_the_folder(self):
        import task_files
        for hostile in ("../../etc/passwd", "..\..\windows\system32", "a/b/c.png"):
            with self.subTest(name=hostile):
                safe = task_files._safe_name(hostile)
                self.assertNotIn("/", safe)
                self.assertNotIn("\\", safe)
                self.assertNotIn("..", safe)


if __name__ == "__main__":
    unittest.main()
