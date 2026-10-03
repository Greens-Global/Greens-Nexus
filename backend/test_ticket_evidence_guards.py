"""
Ticket attachments, pictures and comment bodies (Oct 2026, tickets on phones).

The reply composer used to read a pasted or picked photo into the comment as a
base64 data: URL - a phone photo became a multi-MB comment row, activity
preview, email and Teams DM. The composer now uploads to ticket-evidence and
embeds by URL; the server refuses anything that still inlines a picture, caps
the comment length, and holds attachment/picture URLs to the same
Supabase-storage rule as item photos (routers/items.py _validate_photo_url).

What these pin:
  * a normal reply, an @mention, and a reply embedding an uploaded picture by
    URL still go through, on both the comments endpoint and the drawer's Done
    (update_ticket's `comment`);
  * a data: picture or an oversized body is refused with a clear status;
  * an attachment URL must be ours.

Uses a throwaway sqlite file. No network. Run on its own (one file per process).
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
from routers.task_util import gen_id, now_iso
from routers import tickets as T
from routers import items as I

AGENT = {"email": "agent@greensglobal.com", "level": 1}
REQUESTER = "requester@greensglobal.com"
STORE = "https://proj.supabase.co/storage/v1/object/public/"
GOOD_URL = STORE + "ticket-evidence/image-1-abc.jpg"
DATA_IMG = '<p>look</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" />'


class TicketEvidenceGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls._prefix = I._STORAGE_PREFIX
        I._STORAGE_PREFIX = STORE   # what a deployed API has (SUPABASE_URL set)

    @classmethod
    def tearDownClass(cls):
        I._STORAGE_PREFIX = cls._prefix
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskAttachment, models.TaskActivity,
                  models.TaskNotification, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        self.db.add(models.NexusGroup(id="g1", name="Service Desk", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroupMember(group_id="g1", email=AGENT["email"]))
        self.t = models.TaskTicket(id=gen_id(), code="000001", subject="Gate keypad dead",
                                   status="open", priority="medium", requester_email=REQUESTER,
                                   watcher_emails=[], created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.t)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    # ── helpers ───────────────────────────────────────────────────────────────
    def _comment(self, body):
        return T.add_ticket_comment(self.t.id, T.TicketCommentBody(body=body), BackgroundTasks(),
                                    user=AGENT, db=self.db)

    def _done(self, user=AGENT, **fields):
        return T.update_ticket(self.t.id, T.TicketUpdate(**fields), BackgroundTasks(),
                               user=user, db=self.db)

    def _attach(self, url, name="photo.jpg"):
        body = T.TicketAttachmentBody(name=name, size="12 KB", kind="image", url=url)
        return T.add_ticket_attachment(self.t.id, body, BackgroundTasks(), user=AGENT, db=self.db)

    def _status(self, fn, *a, **kw):
        with self.assertRaises(HTTPException) as cm:
            fn(*a, **kw)
        return cm.exception.status_code, str(cm.exception.detail)

    def _comments(self):
        return self.db.query(models.TaskComment).filter(models.TaskComment.task_id == self.t.id).all()

    # ── comments: what must keep working ─────────────────────────────────────
    def test_plain_reply_is_saved(self):
        self._comment("<p>Rebooted the controller, try now</p>")
        self.assertEqual(len(self._comments()), 1)

    def test_reply_with_uploaded_picture_by_url_is_saved(self):
        """What the composer sends after the fix: the picture lives in storage."""
        self._comment(f'<p>here</p><img src="{GOOD_URL}" style="max-width:100%">')
        self.assertIn(GOOD_URL, self._comments()[0].body)

    def test_reply_with_mention_is_saved(self):
        self._comment('<p><a href="mailto:neil@greensglobal.com">@Neil</a> fyi</p>')
        self.assertEqual(len(self._comments()), 1)

    def test_text_talking_about_data_urls_is_not_refused(self):
        self._comment("<p>the field accepts data: values and image/png types</p>")
        self.assertEqual(len(self._comments()), 1)

    def test_done_reply_with_uploaded_picture_is_saved(self):
        self._done(comment=f'<p>fixed</p><img src="{GOOD_URL}">')
        self.assertEqual(len(self._comments()), 1)

    def test_text_quoting_a_data_uri_is_not_refused(self):
        """A pasted log or HTML snippet arrives escaped - text, not a tag."""
        for html in ("<p>the bad row had data:image/png;base64,iVBORw0KGgo in it</p>",
                     "<pre><code>&lt;img src=\"data:image/png;base64,AAAA\"&gt;</code></pre>",
                     "<p>it was sent as src=data:image/png</p>"):
            self._comment(html)
        self.assertEqual(len(self._comments()), 3)

    def test_done_accepts_escaped_data_uri_text(self):
        """Mark Resolved's note goes through textToHtml (escapes < and >)."""
        self._done(comment="<p>log: &lt;img src=&quot;data:image/png;base64,AAAA&quot;&gt;</p>")
        self.assertEqual(len(self._comments()), 1)

    def test_photo_only_reply_on_done_is_kept(self):
        """A reply that is just a picture is content, not an empty document."""
        self._done(comment=f'<p></p><img src="{GOOD_URL}"><p></p>')
        self.assertEqual(len(self._comments()), 1)

    def test_empty_document_on_done_is_still_dropped(self):
        self._done(comment="<p></p><p>&nbsp;</p>", priority="high")
        self.assertEqual(self._comments(), [])

    # ── comments: what is refused ────────────────────────────────────────────
    def test_inline_data_picture_is_refused_on_comment(self):
        code, msg = self._status(self._comment, DATA_IMG)
        self.assertEqual(code, 422)
        self.assertIn("uploaded", msg)
        self.assertEqual(self._comments(), [])

    def test_inline_data_picture_is_refused_on_done(self):
        code, _ = self._status(self._done, comment=DATA_IMG, priority="high")
        self.assertEqual(code, 422)
        self.db.refresh(self.t)
        self.assertEqual(self.t.priority, "medium")   # nothing in the save went through
        self.assertEqual(self._comments(), [])

    def test_single_quoted_or_bare_data_src_is_refused(self):
        for html in ("<img src='data:image/jpeg;base64,/9j/4AAQ'>", "<img src=data:image/gif;base64,R0lGOD>",
                     '<a href="data:image/png;base64,AAAA">x</a>',
                     '<img alt="x" srcset="data:image/png;base64,AAAA 2x">',
                     '<IMG SRC = "DATA:image/png;base64,AAAA">'):
            code, _ = self._status(self._comment, html)
            self.assertEqual(code, 422, html)

    def test_oversized_comment_is_refused(self):
        code, msg = self._status(self._comment, "<p>" + "x" * (T.COMMENT_MAX_CHARS + 1) + "</p>")
        self.assertEqual(code, 413)
        self.assertIn("too long", msg)
        code, _ = self._status(self._done, comment="x" * (T.COMMENT_MAX_CHARS + 1))
        self.assertEqual(code, 413)

    def test_comment_at_the_cap_is_accepted(self):
        self._comment("x" * T.COMMENT_MAX_CHARS)
        self.assertEqual(len(self._comments()), 1)

    # ── attachments ──────────────────────────────────────────────────────────
    def test_storage_attachment_is_recorded(self):
        out = self._attach(GOOD_URL)
        self.assertEqual(out["url"], GOOD_URL)

    def test_foreign_or_inline_attachment_url_is_refused(self):
        for url in ("https://evil.example.com/x.jpg", "data:image/png;base64,AAAA"):
            code, _ = self._status(self._attach, url)
            self.assertEqual(code, 400, url)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 0)

    # ── ticket pictures (images) ─────────────────────────────────────────────
    def test_images_must_be_storage_urls(self):
        # The requester of a still-Open ticket may edit every field.
        me = {"email": REQUESTER, "level": 0}
        self._done(user=me, images=[GOOD_URL])
        self.db.refresh(self.t)
        self.assertEqual(self.t.images, [GOOD_URL])
        code, _ = self._status(self._done, user=me, images=["https://evil.example.com/a.png"])
        self.assertEqual(code, 400)
        code, _ = self._status(self._done, user=me, images=["data:image/png;base64,AAAA"])
        self.assertEqual(code, 422)

    def test_create_refuses_foreign_images(self):
        body = T.TicketBody(subject="x", images=["https://evil.example.com/a.png"])
        code, _ = self._status(T.create_ticket, body, BackgroundTasks(), user=AGENT, db=self.db)
        self.assertEqual(code, 400)

    def test_check_images_accepts_empty(self):
        T._check_images(None)
        T._check_images([])


if __name__ == "__main__":
    unittest.main()
