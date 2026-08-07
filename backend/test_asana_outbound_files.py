"""
Nexus -> Asana: attachments and pasted images (Aug 2026).

Two bugs, one cause. Asana only takes an EXTERNAL attachment by URL and fetches
that URL itself, with none of our credentials - so anything Nexus holds as a
`data:` URI is unreachable to it.

  attachments   _push_attachments skipped every data: row, on the reasoning that
                such rows only exist because _pull_attachments inlined a file
                that came FROM Asana. False: the Nexus uploader stores every file
                under 2 MB the same way. On the database this was found on, 8 of
                14 attachments were Nexus-origin data: rows that had never been
                pushed and never would be.

  pasted images live inside the comment body as a data: URI, and _to_asana_html
                strips <img> outright. Its comment claimed "the file itself still
                reaches Asana through the attachment push" - which was not true,
                because of the bug above.

Both now route through task_files.py - the module that drained 5.7 GB of
inlined attachments out of the prod DB: the bytes get a real address,
and a TaskAttachment row carries them to Asana as an external attachment.

Throwaway sqlite. No network - Supabase and the Asana POST are both stubbed.

Run with: python -m unittest test_asana_outbound_files -v
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import asana_sync
import database
import models
import task_files

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
HOSTED = "https://sb.test/storage/v1/object/public/task-files/task-email/t1/abc.png"


class _Cfg:
    token = "tok"
    workspace_gid = "1"


class _Base(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.Task, models.TaskComment, models.TaskAttachment,
                  models.AsanaAttachmentLink, models.AsanaTaskLink, models.AsanaCommentLink):
            self.db.query(m).delete()
        self.db.commit()
        self.task = models.Task(id=str(uuid.uuid4()), title="Pump", code="TASK-1",
                                description="", attachment_ids=[], comment_ids=[],
                                created_at="", modified_at="")
        self.db.add(self.task)
        self.db.commit()

        self.posted = []
        # Same calls, with the token - which attachment attribution turns on.
        self.posted_with_token = []
        self.uploaded = []
        self._real = (asana_sync._asana_post, task_files.data_url_to_storage,
                      task_files.storage_configured)
        asana_sync._asana_post = lambda tok, path, body: (
            self.posted.append((path, body))
            or self.posted_with_token.append((tok, path, body))
            or {"gid": "asana-att-1"})
        task_files.data_url_to_storage = lambda name, uri: (
            self.uploaded.append((name, len(uri))) or HOSTED)
        task_files.storage_configured = lambda: True
        self.addCleanup(self._restore)

    def _restore(self):
        (asana_sync._asana_post, task_files.data_url_to_storage,
         task_files.storage_configured) = self._real

    def _attachment(self, url, name="photo.png", linked=False):
        a = models.TaskAttachment(id=str(uuid.uuid4()), task_id=self.task.id, name=name,
                                  kind="image", url=url, added_at="", added_by="sagar@x")
        self.db.add(a)
        self.db.flush()
        if linked:
            self.db.add(models.AsanaAttachmentLink(id=str(uuid.uuid4()), nexus_attachment_id=a.id,
                                                   asana_attachment_gid="from-asana", created_at=""))
        self.db.commit()
        return a


class AttachmentPushTests(_Base):
    def test_a_nexus_uploaded_file_is_hosted_then_pushed(self):
        """The bug: every file under 2 MB is stored as a data: URI, and every one
        of them was silently skipped."""
        a = self._attachment(PNG_URI)
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.db.commit()
        self.assertEqual(len(self.uploaded), 1)
        self.assertEqual(self.posted[0][0], "/attachments")
        self.assertEqual(self.posted[0][1]["data"]["url"], HOSTED)
        self.assertEqual(self.posted[0][1]["data"]["resource_subtype"], "external")
        # The row is repaired, so the next push is a plain link push.
        self.assertEqual(self.db.get(models.TaskAttachment, a.id).url, HOSTED)

    def test_a_file_that_came_from_asana_is_never_pushed_back(self):
        """The AsanaAttachmentLink is the correct test for 'Asana already has
        this' - and it is what makes the data: upload above safe."""
        self._attachment(PNG_URI, linked=True)
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(self.uploaded, [])
        self.assertEqual(self.posted, [])

    def test_an_already_hosted_file_is_pushed_without_re_uploading(self):
        self._attachment("https://sb.test/already/there.png")
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(self.uploaded, [])
        self.assertEqual(self.posted[0][1]["data"]["url"], "https://sb.test/already/there.png")

    def test_pushing_twice_does_not_duplicate_it_in_asana(self):
        self._attachment(PNG_URI)
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.db.commit()
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(len(self.posted), 1)

    def test_storage_being_down_costs_the_file_not_the_sync(self):
        task_files.data_url_to_storage = lambda name, uri: ""   # storage down
        self._attachment(PNG_URI)
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")   # must not raise
        self.assertEqual(self.posted, [])

    def test_a_row_with_no_url_at_all_is_skipped(self):
        # The uploader stores files over 2 MB with no url. There are no bytes
        # anywhere to host, so there is nothing to push.
        self._attachment("")
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(self.posted, [])


class BacklogTests(_Base):
    """The attachments the old skip left behind have to actually go out.

    This is the half that nearly shipped broken: _push_digest hashed attachment
    IDS, so a task whose attachment set had not changed matched last_push_hash
    forever and _push_extras never ran again. Fixing the skip alone would have
    sent NEW attachments while every already-stuck one stayed stuck - and the
    tests would all have passed."""

    def test_an_unpushed_attachment_makes_the_task_look_changed(self):
        a = self._attachment(PNG_URI)
        before = asana_sync._push_digest(self.db, self.task)
        self.db.add(models.AsanaAttachmentLink(id=str(uuid.uuid4()), nexus_attachment_id=a.id,
                                               asana_attachment_gid="g1", created_at=""))
        self.db.commit()
        self.assertNotEqual(before, asana_sync._push_digest(self.db, self.task),
                            "pushing an attachment must change the push digest")

    def test_the_digest_settles_once_everything_is_pushed(self):
        self._attachment(PNG_URI)
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.db.commit()
        d1 = asana_sync._push_digest(self.db, self.task)
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.db.commit()
        self.assertEqual(d1, asana_sync._push_digest(self.db, self.task))
        self.assertEqual(len(self.posted), 1)


class InlineImagePushTests(_Base):
    def test_a_pasted_image_becomes_a_hosted_attachment(self):
        html = f'<p>Look at this <img src="{PNG_URI}" alt="crack.png"></p>'
        out = asana_sync._externalize_inline_images(self.db, self.task, html)
        self.db.commit()
        self.assertIn(HOSTED, out)
        self.assertNotIn("data:image", out)
        rows = self.db.query(models.TaskAttachment).all()
        self.assertEqual([r.name for r in rows], ["crack.png"])
        self.assertEqual(rows[0].url, HOSTED)
        self.assertIn(rows[0].id, self.db.get(models.Task, self.task.id).attachment_ids)

    def test_a_comment_image_is_hosted_without_becoming_a_second_copy(self):
        """The attachment carries the bytes to Asana; it must NOT carry a
        comment_id, or the drawer draws a card for an image that is already
        visible inline in that same comment - the screenshot twice."""
        out = asana_sync._externalize_inline_images(
            self.db, self.task, f'<p><img src="{PNG_URI}"></p>', comment_id="c1")
        self.db.commit()
        self.assertIn(HOSTED, out)
        self.assertEqual(self.db.query(models.TaskAttachment).one().comment_id, "")

    def test_html_with_no_pasted_image_is_untouched(self):
        html = '<p>Just words and <img src="https://x.test/a.png"></p>'
        self.assertEqual(asana_sync._externalize_inline_images(self.db, self.task, html), html)
        self.assertEqual(self.uploaded, [])

    def test_without_storage_configured_the_comment_still_goes(self):
        """A laptop with no SUPABASE_URL must be able to push a comment, minus
        the image - not fail the sync."""
        task_files.storage_configured = lambda: False
        html = f'<p><img src="{PNG_URI}"></p>'
        self.assertEqual(asana_sync._externalize_inline_images(self.db, self.task, html), html)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 0)

    def test_a_failed_upload_leaves_the_image_where_it_was(self):
        task_files.data_url_to_storage = lambda name, uri: ""   # upload failed
        html = f'<p><img src="{PNG_URI}"></p>'
        self.assertEqual(asana_sync._externalize_inline_images(self.db, self.task, html), html)
        self.assertEqual(self.db.query(models.TaskAttachment).count(), 0)

    def test_several_pasted_images_each_become_their_own_attachment(self):
        html = f'<p><img src="{PNG_URI}" alt="a.png"><img src="{PNG_URI}" alt="b.png"></p>'
        asana_sync._externalize_inline_images(self.db, self.task, html)
        self.db.commit()
        self.assertEqual(sorted(r.name for r in self.db.query(models.TaskAttachment).all()),
                         ["a.png", "b.png"])

    def test_an_unnamed_paste_still_gets_a_filename(self):
        asana_sync._externalize_inline_images(self.db, self.task, f'<img src="{PNG_URI}">')
        self.db.commit()
        self.assertEqual(self.db.query(models.TaskAttachment).one().name, "pasted-image.png")


if __name__ == "__main__":
    unittest.main()


class AttributionTests(_Base):
    """Attachments must land under the person who added them, like comments do.

    Asana attributes an action to whoever owns the token that performed it and
    offers no impersonation parameter. push_comment already posts under the
    author's own grant; before this, every attachment went under the service
    token - so a file someone uploaded, or one that arrived by email under their
    name, showed in Asana as added by "Nexus".
    """

    def setUp(self):
        super().setUp()
        self.grants = {}
        self._real_token_for = asana_sync.asana_oauth.token_for
        asana_sync.asana_oauth.token_for = lambda db, email: self.grants.get((email or "").lower())
        self.addCleanup(self._restore_oauth)

    def _restore_oauth(self):
        asana_sync.asana_oauth.token_for = self._real_token_for

    def _tokens_used(self):
        return [tok for tok, path, body in self.posted_with_token]

    def test_a_file_goes_under_the_uploaders_own_grant(self):
        self.grants["sagar@x"] = "sagar-token"
        self._attachment("https://sb.test/a.png", name="a.png")
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(self._tokens_used(), ["sagar-token"])

    def test_someone_with_no_grant_falls_back_to_the_service_token(self):
        self._attachment("https://sb.test/a.png")          # no grant registered
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(self._tokens_used(), [_Cfg.token])

    def test_a_file_from_asana_is_never_attributed_to_a_person(self):
        """asana-sync is a stamp, not a human - there is nobody to post as."""
        self.grants["asana-sync"] = "should-never-be-used"
        a = self._attachment("https://sb.test/a.png")
        a.added_by = "asana-sync"
        self.db.commit()
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(self._tokens_used(), [_Cfg.token])

    def test_a_revoked_grant_still_gets_the_file_there(self):
        """Degrade rather than lose - the same rule push_comment follows."""
        self.grants["sagar@x"] = "revoked"
        calls = []

        def post(tok, path, body):
            calls.append(tok)
            if tok == "revoked":
                raise RuntimeError("Asana said no (403 Forbidden)")
            return {"gid": "att-1"}
        asana_sync._asana_post = post

        self._attachment("https://sb.test/a.png")
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.db.commit()
        self.assertEqual(calls, ["revoked", _Cfg.token])
        # And it is recorded, so the next sweep does not try again.
        self.assertEqual(self.db.query(models.AsanaAttachmentLink).count(), 1)

    def test_an_error_that_is_not_a_permission_problem_is_not_retried(self):
        self.grants["sagar@x"] = "sagar-token"
        calls = []

        def post(tok, path, body):
            calls.append(tok)
            raise RuntimeError("500 Server Error")
        asana_sync._asana_post = post

        self._attachment("https://sb.test/a.png")
        asana_sync._push_attachments(self.db, _Cfg(), self.task, "999")
        self.assertEqual(calls, ["sagar-token"])   # no service-token retry
        self.assertEqual(self.db.query(models.AsanaAttachmentLink).count(), 0)

    def test_a_pasted_comment_image_is_credited_to_the_comment_author(self):
        """Not to the task's assignee, who may have had nothing to do with it -
        added_by is what decides the Asana user."""
        self.task.assignee_email = "neil@x"
        self.db.commit()
        asana_sync._externalize_inline_images(
            self.db, self.task, f'<p><img src="{PNG_URI}"></p>',
            comment_id="c1", author="sagar@x")
        self.db.commit()
        self.assertEqual(self.db.query(models.TaskAttachment).one().added_by, "sagar@x")

    def test_a_description_image_falls_back_to_the_task_creator(self):
        self.task.created_by = "ankush@x"
        self.task.assignee_email = "neil@x"
        self.db.commit()
        asana_sync._externalize_inline_images(
            self.db, self.task, f'<p><img src="{PNG_URI}"></p>', author="")
        self.db.commit()
        self.assertEqual(self.db.query(models.TaskAttachment).one().added_by, "ankush@x")


class ConcurrencyGuardTests(unittest.TestCase):
    """Two files mailed in as a reply became eight attachments in Asana.

    _push_attachments reads "has this been pushed?", makes an HTTP round trip,
    then writes the link. Dev runs 8 gunicorn WORKER PROCESSES and
    nexus_attachment_id carries no unique constraint, so all eight can sit
    inside that window, all read "no link", and all POST.
    """

    class _FakeDialect:
        def __init__(self, name):
            self.name = name

    class _FakeBind:
        def __init__(self, name):
            self.dialect = ConcurrencyGuardTests._FakeDialect(name)

    class _FakeDB:
        def __init__(self, dialect):
            self.bind = ConcurrencyGuardTests._FakeBind(dialect)
            self.executed = []

        def execute(self, stmt, params=None):
            self.executed.append((str(stmt), params))

    def test_it_takes_a_postgres_advisory_lock(self):
        db = self._FakeDB("postgresql")
        asana_sync._acquire_attachment_push_lock(db, "task-1")
        self.assertEqual(len(db.executed), 1)
        self.assertIn("pg_advisory_xact_lock", db.executed[0][0])

    def test_the_lock_is_per_task_so_tasks_do_not_queue_behind_each_other(self):
        a, b = self._FakeDB("postgresql"), self._FakeDB("postgresql")
        asana_sync._acquire_attachment_push_lock(a, "task-1")
        asana_sync._acquire_attachment_push_lock(b, "task-2")
        self.assertNotEqual(a.executed[0][1]["key"], b.executed[0][1]["key"])

    def test_the_same_task_always_maps_to_the_same_key(self):
        a, b = self._FakeDB("postgresql"), self._FakeDB("postgresql")
        asana_sync._acquire_attachment_push_lock(a, "task-1")
        asana_sync._acquire_attachment_push_lock(b, "task-1")
        self.assertEqual(a.executed[0][1]["key"], b.executed[0][1]["key"])

    def test_the_key_fits_in_a_postgres_bigint(self):
        # pg_advisory_xact_lock takes bigint; an oversized key errors at runtime.
        db = self._FakeDB("postgresql")
        asana_sync._acquire_attachment_push_lock(db, "task-1")
        self.assertLess(db.executed[0][1]["key"], 2 ** 63 - 1)

    def test_sqlite_is_left_alone(self):
        db = self._FakeDB("sqlite")
        asana_sync._acquire_attachment_push_lock(db, "task-1")
        self.assertEqual(db.executed, [])
