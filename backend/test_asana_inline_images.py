"""
Inline images pulled from Asana (Aug 2026).

The bug: an image pasted into an Asana comment rendered in Nexus as a broken
glyph next to the bare filename. Asana sends the image inside html_text as an
<img> pointing at an Asana asset URL, _from_asana_html passes html through
verbatim, and those URLs are session-authenticated - so a browser holding a
Nexus session gets refused.

The bytes were already here the whole time: Asana exposes a pasted image as an
attachment, and _pull_attachments downloads it. The repair is to repoint the
tag, which is why _pull_attachments now runs BEFORE _pull_stories.

Asana's exact markup for a pasted image is not something this codebase can pin
down from the outside - the shapes below are the ones it plausibly sends
(gid on the tag, gid in the URL, neither), and the rewriter has to survive all
of them. Anything it cannot resolve becomes a link rather than staying a broken
image, and says so in the sweep output.

Throwaway sqlite. No network - the Asana client is stubbed.

Run with: python -m unittest test_asana_inline_images -v
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

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


GID = "1209876543210"
PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="


class _FakeAsana:
    """Only the one call the fallback makes."""

    def __init__(self, rows=None):
        self.rows = rows or []
        self.calls = []

    def get(self, path, **params):
        self.calls.append(path)
        return self.rows


class InlineImageTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)   # see DescriptionRepairTests.setUp
        for m in (models.Task, models.TaskAttachment, models.AsanaAttachmentLink,
                  models.AsanaTaskLink):
            self.db.query(m).delete()
        self.db.commit()
        self.task = models.Task(id=str(uuid.uuid4()), title="Pump", code="TASK-1",
                                description="", created_at="", modified_at="")
        self.db.add(self.task)
        self.db.commit()

    def _pulled_attachment(self, gid=GID, name="image.png", url=PNG):
        """The state _pull_attachments leaves behind for a pasted image."""
        a = models.TaskAttachment(id=str(uuid.uuid4()), task_id=self.task.id, name=name,
                                  kind="image", url=url, added_at="", added_by="asana-sync")
        self.db.add(a)
        self.db.flush()
        self.db.add(models.AsanaAttachmentLink(id=str(uuid.uuid4()), nexus_attachment_id=a.id,
                                               asana_attachment_gid=gid, created_at=""))
        self.db.commit()
        return a

    def rewrite(self, html, asana=None):
        return asana_sync._rewrite_asana_images(self.db, asana, html, self.task.id, "555")

    # ── the shapes Asana might send ──────────────────────────────────────
    def test_gid_on_the_tag_is_repointed_at_the_downloaded_copy(self):
        self._pulled_attachment()
        out = self.rewrite(
            f'<p>testing from Asana <img data-asana-gid="{GID}" '
            f'src="https://app.asana.com/app/asana/-/get_asset?asset_id={GID}" alt="image.png"></p>')
        self.assertIn(PNG, out)
        self.assertNotIn("app.asana.com", out)

    def test_gid_only_in_the_url_is_still_found(self):
        self._pulled_attachment()
        out = self.rewrite(
            f'<p><img src="https://app.asana.com/app/asana/-/get_asset?asset_id={GID}" alt="image.png"></p>')
        self.assertIn(PNG, out)

    def test_attachments_path_in_the_url_is_still_found(self):
        self._pulled_attachment()
        out = self.rewrite(f'<p><img src="https://app.asana.com/attachments/{GID}/download"></p>')
        self.assertIn(PNG, out)

    def test_no_gid_anywhere_falls_back_to_the_filename(self):
        # Weak, but scoped to this one task, and it beats a broken image.
        self._pulled_attachment(name="image.png")
        out = self.rewrite('<p><img src="https://app.asana.com/whatever" alt="image.png"></p>')
        self.assertIn(PNG, out)

    def test_the_alt_text_survives_the_rewrite(self):
        self._pulled_attachment()
        out = self.rewrite(f'<img data-asana-gid="{GID}" alt="site photo.png">')
        self.assertIn('alt="site photo.png"', out)

    # ── what must NOT be touched ─────────────────────────────────────────
    def test_an_image_already_stored_by_nexus_is_left_alone(self):
        html = f'<p>Commenting from Nexus <img src="{PNG}"></p>'
        self.assertEqual(self.rewrite(html), html)

    def test_a_public_image_from_another_host_is_left_alone(self):
        html = '<p><img src="https://example.test/logo.png" alt="logo"></p>'
        self.assertEqual(self.rewrite(html), html)

    def test_html_with_no_images_is_returned_untouched(self):
        html = '<p>Just words and a <a href="https://x.test">link</a></p>'
        self.assertEqual(self.rewrite(html), html)

    # ── when it cannot be resolved ───────────────────────────────────────
    def test_an_unresolvable_image_becomes_a_link_not_a_broken_glyph(self):
        """A reader who can see the filename and click through to Asana is
        better served than one staring at a broken image."""
        out = self.rewrite('<p><img src="https://app.asana.com/app/asana/-/get_asset?asset_id=999" alt="image.png"></p>')
        self.assertNotIn("<img", out)
        self.assertIn('href="https://app.asana.com/app/asana/-/get_asset?asset_id=999"', out)
        self.assertIn("image.png", out)

    def test_a_srcless_tag_degrades_to_its_filename(self):
        out = self.rewrite('<p>see <img data-asana-gid="404" alt="image.png"></p>')
        self.assertNotIn("<img", out)
        self.assertIn("image.png", out)

    # ── the fetch fallback ───────────────────────────────────────────────
    def test_an_attachment_the_pull_skipped_is_fetched_by_gid(self):
        """Over _ATTACHMENT_MAX_BYTES the pull keeps the Asana view URL, which is
        exactly the URL a browser cannot load - so the rewriter fetches."""
        # The only test here that reaches Asana's CDN, so the only one that
        # needs the integration live (test_asana_severed covers the refusal).
        os.environ["NEXUS_ASANA_ENABLED"] = "true"
        self.addCleanup(os.environ.pop, "NEXUS_ASANA_ENABLED", None)
        asana = _FakeAsana([{"gid": GID, "name": "image.png", "size": 10,
                             "host": "asana", "download_url": "https://dl.test/x.png"}])
        called = {}

        class _Resp:
            def read(self):
                called["read"] = True
                return b"\x89PNG\r\n\x1a\n"

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        real = asana_sync.urllib.request.urlopen
        asana_sync.urllib.request.urlopen = lambda url, timeout=0: _Resp()
        try:
            out = self.rewrite(f'<img data-asana-gid="{GID}" alt="image.png">', asana=asana)
        finally:
            asana_sync.urllib.request.urlopen = real
        self.assertIn("data:image/png;base64,", out)
        self.assertTrue(called.get("read"))

    def test_several_images_cost_one_attachment_request(self):
        asana = _FakeAsana([])
        self.rewrite(
            '<img data-asana-gid="1"><img data-asana-gid="2"><img data-asana-gid="3">',
            asana=asana)
        self.assertEqual(len(asana.calls), 1)


class DescriptionRepairTests(unittest.TestCase):
    """The same repair on a task description, plus the digest bookkeeping that
    stops it from being pushed straight back out."""

    def setUp(self):
        self.db = database.SessionLocal()
        # Closed in tearDown, and tearDown only runs if setUp finishes - a setUp
        # that raises half way leaves this session holding a write transaction,
        # which on sqlite blocks the next test's DELETE instead of failing it.
        self.addCleanup(self.db.close)
        for m in (models.Task, models.TaskAttachment, models.AsanaAttachmentLink,
                  models.AsanaTaskLink):
            self.db.query(m).delete()
        self.db.commit()
        self.task = models.Task(
            id=str(uuid.uuid4()), title="Pump", code="TASK-1", created_at="", modified_at="",
            description=f'<p>Spec <img data-asana-gid="{GID}" src="https://app.asana.com/x" alt="plan.png"></p>')
        self.db.add(self.task)
        a = models.TaskAttachment(id=str(uuid.uuid4()), task_id=self.task.id, name="plan.png",
                                  kind="image", url=PNG, added_at="", added_by="asana-sync")
        self.db.add(a)
        self.db.flush()
        self.db.add(models.AsanaAttachmentLink(id=str(uuid.uuid4()), nexus_attachment_id=a.id,
                                               asana_attachment_gid=GID, created_at=""))
        # No tearDown here either - addCleanup above already closes the session.
        self.link = models.AsanaTaskLink(id=str(uuid.uuid4()), nexus_task_id=self.task.id,
                                         asana_gid="555", last_hash="stale",
                                         last_inbound_hash="inbound", last_synced_at="")
        self.db.add(self.link)
        self.db.commit()

    def test_the_description_image_is_repointed(self):
        asana_sync._repair_description_images(self.db, None, "555", self.task.id)
        self.db.commit()
        self.assertIn(PNG, self.db.get(models.Task, self.task.id).description)

    def test_the_nexus_digest_is_refreshed_so_the_fix_is_not_pushed_back(self):
        """Without this, the outbound sweep reads the repair as a local edit and
        pushes the description to Asana - where _to_asana_html strips <img>,
        deleting the image this just repaired."""
        asana_sync._repair_description_images(self.db, None, "555", self.task.id)
        self.db.commit()
        link = self.db.get(models.AsanaTaskLink, self.link.id)
        self.assertNotEqual(link.last_hash, "stale")
        self.assertEqual(link.last_hash, asana_sync._task_digest(self.db, self.task))

    def test_the_asana_side_digest_is_left_alone(self):
        # last_inbound_hash describes what ASANA holds, which this did not touch.
        asana_sync._repair_description_images(self.db, None, "555", self.task.id)
        self.db.commit()
        self.assertEqual(self.db.get(models.AsanaTaskLink, self.link.id).last_inbound_hash, "inbound")

    def test_a_description_with_no_images_is_not_rewritten_at_all(self):
        self.task.description = "<p>Nothing to see</p>"
        self.link.last_hash = "stale"
        self.db.commit()
        asana_sync._repair_description_images(self.db, None, "555", self.task.id)
        self.db.commit()
        self.assertEqual(self.db.get(models.AsanaTaskLink, self.link.id).last_hash, "stale")


if __name__ == "__main__":
    unittest.main()
