"""
Unit tests for asana_rescue - the pre-cancellation attachment rescue.

Uses a throwaway sqlite file so it never touches the real dev DB or Supabase,
and mocks the Asana API + storage layers. No network, no token needed.

Run with: python -m unittest test_asana_rescue -v
"""
import os
import tempfile
import unittest
from unittest import mock

# Must happen before `import database` - DATABASE_URL is read at module import
# time to build the engine.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database
import models
from routers.task_util import gen_id, now_iso
import asana_rescue


SUPA = "https://occ.supabase.co/storage/v1/object/public/task-files/tasks/x-file.pdf"


class UrlAtRiskTests(unittest.TestCase):
    def test_asana_hosts_are_at_risk(self):
        self.assertTrue(asana_rescue.url_at_risk(
            "https://asana-user-private-us-east-1.s3.amazonaws.com.asanausercontent.com/x?sig=1"))
        self.assertTrue(asana_rescue.url_at_risk("https://asanausercontent.com/a/b"))
        self.assertTrue(asana_rescue.url_at_risk("https://app.asana.com/app/asana/-/get_asset?asset_id=1"))

    def test_safe_hosts_are_not(self):
        self.assertFalse(asana_rescue.url_at_risk(SUPA))
        self.assertFalse(asana_rescue.url_at_risk("https://drive.google.com/file/d/abc"))
        self.assertFalse(asana_rescue.url_at_risk(""))
        # Similar-looking but different registrable domain must not match.
        self.assertFalse(asana_rescue.url_at_risk("https://notasana.com/x"))


class DecideTests(unittest.TestCase):
    """The pure decision logic - one branch per rescue outcome."""

    def test_asana_hosted_file_is_downloaded(self):
        action, url = asana_rescue.decide(
            {"host": "asana", "download_url": "https://asanausercontent.com/fresh", "size": 100})
        self.assertEqual(action, "download")
        self.assertEqual(url, "https://asanausercontent.com/fresh")

    def test_blank_host_counts_as_asana_hosted(self):
        action, _ = asana_rescue.decide(
            {"host": "", "download_url": "https://asanausercontent.com/fresh"})
        self.assertEqual(action, "download")

    def test_external_host_resolves_to_first_safe_url(self):
        action, url = asana_rescue.decide(
            {"host": "gdrive", "download_url": "",
             "view_url": "https://drive.google.com/file/d/abc",
             "permanent_url": "https://app.asana.com/app/asana/-/get_asset?asset_id=1"})
        self.assertEqual(action, "external")
        self.assertEqual(url, "https://drive.google.com/file/d/abc")

    def test_external_host_with_only_asana_urls_fails(self):
        action, reason = asana_rescue.decide(
            {"host": "dropbox",
             "view_url": "https://app.asana.com/x", "permanent_url": "https://app.asana.com/y"})
        self.assertEqual((action, reason), ("failed", "external-no-safe-url"))

    def test_no_metadata_fails(self):
        self.assertEqual(asana_rescue.decide(None), ("failed", "no-metadata"))

    def test_missing_download_url_fails(self):
        self.assertEqual(asana_rescue.decide({"host": "asana"}), ("failed", "no-download-url"))

    def test_oversize_fails_rather_than_downloading(self):
        action, reason = asana_rescue.decide(
            {"host": "asana", "download_url": "https://asanausercontent.com/big",
             "size": asana_rescue.MAX_FILE_BYTES + 1})
        self.assertEqual((action, reason), ("failed", "oversize"))


class TokenFallbackTests(unittest.TestCase):
    def test_403_falls_back_to_the_second_token(self):
        calls = []

        def fake_get(path, token):
            calls.append(token)
            if token == "svc":
                return None, 403
            return {"data": {"host": "asana"}}, None

        with mock.patch.object(asana_rescue, "_get_json", side_effect=fake_get):
            meta = asana_rescue.fetch_attachment_meta("123", ["svc", "setup"])
        self.assertEqual(meta, {"host": "asana"})
        self.assertEqual(calls, ["svc", "setup"])

    def test_hard_error_does_not_try_the_next_token(self):
        with mock.patch.object(asana_rescue, "_get_json", return_value=(None, 500)) as g:
            self.assertIsNone(asana_rescue.fetch_attachment_meta("123", ["svc", "setup"]))
        g.assert_called_once()


class RunRescueTests(unittest.TestCase):
    """The worker end to end on sqlite, network + storage mocked."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskAttachment, models.AsanaAttachmentLink, models.AsanaSyncConfig):
            self.db.query(m).delete()
        self.db.add(models.AsanaSyncConfig(id="singleton", token="svc", setup_token="setup",
                                           rescue_running_at=now_iso()))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _att(self, url, gid=None, name="file.pdf"):
        a = models.TaskAttachment(id=gen_id(), task_id="t1", name=name, url=url,
                                  added_at=now_iso())
        self.db.add(a)
        if gid is not None:
            self.db.add(models.AsanaAttachmentLink(id=gen_id(), nexus_attachment_id=a.id,
                                                   asana_attachment_gid=gid,
                                                   created_at=now_iso()))
        self.db.commit()
        return a.id

    def _run(self, metas):
        """Run run_rescue with fetch_attachment_meta answering from `metas`
        (gid -> meta dict or None) and the download + storage layers faked."""
        def fake_meta(gid, tokens):
            return metas.get(gid)

        def fake_download(url):
            fd, path = tempfile.mkstemp()
            with os.fdopen(fd, "wb") as fh:
                fh.write(b"x" * 10)
            return path, 10, "application/pdf"

        with mock.patch.object(asana_rescue, "fetch_attachment_meta", side_effect=fake_meta), \
             mock.patch.object(asana_rescue, "_download_to_temp", side_effect=fake_download), \
             mock.patch.object(asana_rescue.task_files, "store_bytes", return_value=SUPA), \
             mock.patch.object(asana_rescue.time, "sleep"):
            return asana_rescue.run_rescue(database.SessionLocal)

    def test_full_run_covers_every_outcome(self):
        old_a = "https://asanausercontent.com/signed/a.pdf?sig=1"
        old_b = "https://app.asana.com/app/asana/-/get_asset?asset_id=9"
        a = self._att(old_a, gid="101")                       # asana-hosted -> rescued
        b = self._att(old_b, gid="102")                       # external pointer -> resolved
        c = self._att("https://asanausercontent.com/c", gid="103")   # meta fetch fails
        d = self._att("https://asanausercontent.com/d", gid="migrated-inline:x")  # marker gid
        e = self._att(SUPA, gid="105")                        # already safe -> not scanned

        counts = self._run({
            "101": {"host": "asana", "download_url": "https://asanausercontent.com/fresh-a",
                    "size": 10, "name": "a.pdf"},
            "102": {"host": "gdrive", "view_url": "https://drive.google.com/file/d/abc"},
            "103": None,
        })

        self.assertEqual(counts["scanned"], 4)          # e never enters the scan
        self.assertEqual(counts["rescued"], 1)
        self.assertEqual(counts["external_resolved"], 1)
        self.assertEqual(counts["failed"], 1)
        self.assertEqual(counts["no_gid"], 1)
        self.assertEqual(counts["bytes_rescued"], 10)

        db = database.SessionLocal()
        try:
            ra = db.get(models.TaskAttachment, a)
            self.assertEqual(ra.url, SUPA)
            self.assertEqual(ra.original_asana_url, old_a)   # audit trail kept
            rb = db.get(models.TaskAttachment, b)
            self.assertEqual(rb.url, "https://drive.google.com/file/d/abc")
            self.assertEqual(rb.original_asana_url, old_b)
            # Failed + marker-gid rows are left byte-for-byte untouched.
            self.assertEqual(db.get(models.TaskAttachment, c).url, "https://asanausercontent.com/c")
            self.assertEqual(db.get(models.TaskAttachment, c).original_asana_url, "")
            self.assertEqual(db.get(models.TaskAttachment, d).url, "https://asanausercontent.com/d")
            self.assertEqual(db.get(models.TaskAttachment, e).url, SUPA)
            # The one-at-a-time guard is released even though rows failed.
            cfg = db.query(models.AsanaSyncConfig).first()
            self.assertEqual(cfg.rescue_running_at, "")
        finally:
            db.close()

    def test_rerun_is_idempotent_and_retries_only_failures(self):
        a = self._att("https://asanausercontent.com/signed/a.pdf", gid="101")
        c = self._att("https://asanausercontent.com/c", gid="103")
        meta_a = {"host": "asana", "download_url": "https://asanausercontent.com/fresh-a",
                  "size": 10, "name": "a.pdf"}
        self._run({"101": meta_a, "103": None})

        # Second run: a is rescued (off the at-risk scan), c now succeeds.
        counts = self._run({"101": meta_a,
                            "103": {"host": "asana", "size": 10, "name": "c.pdf",
                                    "download_url": "https://asanausercontent.com/fresh-c"}})
        self.assertEqual(counts["scanned"], 1)
        self.assertEqual(counts["rescued"], 1)
        db = database.SessionLocal()
        try:
            self.assertEqual(db.get(models.TaskAttachment, c).url, SUPA)
            # a's audit URL still points at its ORIGINAL address (first write wins).
            self.assertEqual(db.get(models.TaskAttachment, a).original_asana_url,
                             "https://asanausercontent.com/signed/a.pdf")
        finally:
            db.close()

    def test_no_token_reports_and_releases_guard(self):
        db = database.SessionLocal()
        cfg = db.query(models.AsanaSyncConfig).first()
        cfg.token, cfg.setup_token = "", ""
        db.commit()
        db.close()

        counts = asana_rescue.run_rescue(database.SessionLocal)

        self.assertEqual(counts["rescued"], 0)
        self.assertEqual(asana_rescue.status_snapshot().get("state"), "failed")
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AsanaSyncConfig).first().rescue_running_at, "")
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
