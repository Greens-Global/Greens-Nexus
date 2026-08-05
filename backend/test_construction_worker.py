"""Construction Egnyte sweep - the failure modes that lose a record copy.

The happy path is a two-line call into services/egnyte.py. What is worth testing
is what happens when it does NOT work: an unconfigured integration, a permanent
Egnyte rejection, and a transient one. Getting the last two the wrong way round
either burns a file's retries on a bad token, or retries a 404 forever.

Run with: python -m unittest test_construction_worker -v
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import database
import models
import construction_worker as worker
from services import egnyte as egnyte_svc


def _iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


class SweepTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for M in (models.ConstructionMedia, models.ConstructionDailyLog,
                  models.ConstructionProject, models.ConstructionAIJob):
            self.db.query(M).delete()
        self.db.add(models.ConstructionProject(id="p1", name="Valley Center", created_at=_iso()))
        self.db.add(models.ConstructionDailyLog(id="l1", project_id="p1", log_date="2026-08-04",
                                                author_email="w@greensglobal.com", status="submitted"))
        self.db.add(models.ConstructionMedia(
            id="m1", project_id="p1", daily_log_id="l1", kind="photo",
            url="https://example.test/m1.jpg", mime_type="image/jpeg",
            uploaded_by="sagar.shoundik@greensglobal.com", uploaded_at=_iso(),
            taken_at="2026-08-04T09:13:22Z", description="Formwork",
            egnyte_status="pending"))
        self.db.add(models.ConstructionAIJob(id="j1", project_id="p1", kind="egnyte_sync",
                                             subject_id="m1", status="queued",
                                             attempts=0, max_attempts=4, queued_at=_iso()))
        self.db.commit()
        self._saved = {k: os.environ.get(k) for k in ("EGNYTE_DOMAIN", "EGNYTE_TOKEN")}
        os.environ["EGNYTE_DOMAIN"] = "greens.egnyte.com"
        os.environ["EGNYTE_TOKEN"] = "tok"
        self._file_one = worker._file_one

    def tearDown(self):
        worker._file_one = self._file_one
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.db.close()

    def _media(self):
        db = database.SessionLocal()
        try:
            return db.query(models.ConstructionMedia).filter(models.ConstructionMedia.id == "m1").first()
        finally:
            db.close()

    def _job(self):
        db = database.SessionLocal()
        try:
            return db.query(models.ConstructionAIJob).filter(models.ConstructionAIJob.id == "j1").first()
        finally:
            db.close()

    def test_unconfigured_egnyte_leaves_the_row_pending(self):
        """The record copy is deferred, never lost. Failing the row because an
        operator has not set EGNYTE_TOKEN would discard the day's evidence for a
        configuration problem."""
        os.environ.pop("EGNYTE_DOMAIN", None)
        os.environ.pop("EGNYTE_TOKEN", None)
        self.assertEqual(worker.sweep_once()["skipped"], 1)
        self.assertEqual(self._media().egnyte_status, "pending")

    def test_success_records_the_path_and_deep_link(self):
        def ok(db, media):
            media.egnyte_path = "/Shared/x/y.jpg"
            media.egnyte_web_url = "https://greens.egnyte.com/app#/y.jpg"
            media.egnyte_status = "uploaded"
            media.egnyte_synced_at = _iso()
        worker._file_one = ok
        self.assertEqual(worker.sweep_once()["filed"], 1)
        m = self._media()
        self.assertEqual(m.egnyte_status, "uploaded")
        self.assertTrue(m.egnyte_web_url)
        self.assertEqual(self._job().status, "done")

    def test_a_permanent_egnyte_error_dies_immediately(self):
        """401/403/404/409 will not fix themselves. Retrying a bad token four
        times just delays the operator finding out."""
        def forbidden(db, media):
            raise egnyte_svc.EgnyteError("Could not upload to Egnyte: denied", 403)
        worker._file_one = forbidden
        self.assertEqual(worker.sweep_once()["dead"], 1)
        self.assertEqual(self._media().egnyte_status, "failed")
        self.assertEqual(self._job().status, "dead")
        self.assertEqual(self._job().attempts, 1)   # not four

    def test_a_transient_error_stays_pending_for_the_next_tick(self):
        def flaky(db, media):
            raise egnyte_svc.EgnyteError("Could not upload to Egnyte: upstream", 502)
        worker._file_one = flaky
        self.assertEqual(worker.sweep_once()["failed"], 1)
        self.assertEqual(self._media().egnyte_status, "pending")
        self.assertEqual(self._job().attempts, 1)
        self.assertEqual(self._job().status, "queued")

    def test_a_transient_error_gives_up_at_max_attempts(self):
        """Otherwise a permanently unreachable object is retried every minute
        forever, and the queue never drains."""
        def flaky(db, media):
            raise egnyte_svc.EgnyteError("upstream", 502)
        worker._file_one = flaky
        for _ in range(4):
            worker.sweep_once()
        self.assertEqual(self._media().egnyte_status, "failed")
        self.assertEqual(self._job().status, "dead")

    def test_network_errors_are_retryable_not_permanent(self):
        """httpx raises its own exceptions, not EgnyteError - they carry no
        .status, so the permanent check must not treat them as fatal."""
        def offline(db, media):
            raise ConnectionError("connection reset")
        worker._file_one = offline
        self.assertEqual(worker.sweep_once()["failed"], 1)
        self.assertEqual(self._media().egnyte_status, "pending")

    def test_deleted_media_is_not_filed(self):
        db = database.SessionLocal()
        m = db.query(models.ConstructionMedia).filter(models.ConstructionMedia.id == "m1").first()
        m.deleted_at = _iso()
        db.commit(); db.close()
        worker._file_one = lambda db, media: self.fail("must not touch deleted media")
        self.assertEqual(worker.sweep_once()["filed"], 0)

    def test_lock_key_differs_from_the_asana_pull(self):
        """Sharing Asana's advisory-lock key would make the two sweeps block each
        other for no reason."""
        import asana_sync
        self.assertNotEqual(worker._CONSTRUCTION_SWEEP_LOCK_KEY,
                            asana_sync._ASANA_PULL_LOCK_KEY)


if __name__ == "__main__":
    unittest.main()
