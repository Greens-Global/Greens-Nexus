"""Deletes that promise the file is gone really remove it (11/02/2026, the
legal compliance pass):

  * a removed or replaced profile photo leaves the public avatars bucket
    (avatar_files.forget) - only the person's own folder, only when no person
    row still shows it, never from a laptop;
  * deleting an HR document removes the file first and keeps the row when
    storage refuses, instead of orphaning the file.

Run on its own: `python -m pytest test_storage_deletes.py` (one file per
process - see CLAUDE.md)."""
import os
import unittest
import uuid

import _testdb  # noqa: F401  - a throwaway database whatever runner imports this file

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import avatar_files  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import hr as hr_router  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

SB = "https://proj.supabase.co"
ADMIN = "stordel.admin@greensglobal.com"


class Resp:
    def __init__(self, code, text=""):
        self.status_code = code
        self.is_success = 200 <= code < 300
        self.text = text


class _Base(unittest.TestCase):
    def setUp(self):
        self._env = {k: os.environ.get(k) for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "NEXUS_DEV_EMAIL")}
        os.environ["SUPABASE_URL"] = SB
        os.environ["SUPABASE_SERVICE_KEY"] = "svc"
        self.calls = []
        self._orig = (avatar_files.httpx.delete, avatar_files._deployed)
        avatar_files.httpx.delete = lambda url, **k: (self.calls.append(url), Resp(200))[1]
        avatar_files._deployed = lambda: True
        self._cleanup()

    def tearDown(self):
        avatar_files.httpx.delete, avatar_files._deployed = self._orig
        self._cleanup()
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email.like("stordel.%")).delete(
                synchronize_session=False)
            db.query(models.HrDocument).filter(models.HrDocument.uploaded_by.like("stordel.%")).delete(
                synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("stordel.%")).delete(
                synchronize_session=False)
            db.query(models.HrSignRequest).filter(models.HrSignRequest.title == "stordel envelope").delete(
                synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _emp(self, photo=""):
        db = database.SessionLocal()
        try:
            eid = str(uuid.uuid4())
            db.add(models.NexusEmployee(id=eid, work_email=f"stordel.{eid[:6]}@greensglobal.com",
                                        first_name="S", last_name="D", photo_url=photo))
            db.commit()
            return eid
        finally:
            db.close()


class AvatarTests(_Base):
    def _url(self, eid, name="a.png"):
        return f"{SB}/storage/v1/object/public/avatars/{eid}/{name}"

    def test_deletes_the_persons_old_photo(self):
        eid = self._emp()
        db = database.SessionLocal()
        try:
            self.assertTrue(avatar_files.forget(db, self._url(eid), eid))
        finally:
            db.close()
        self.assertEqual(self.calls, [f"{SB}/storage/v1/object/avatars/{eid}/a.png"])

    def test_keeps_a_photo_someone_still_shows_and_other_folders(self):
        eid = self._emp()
        self._emp(photo=self._url(eid, "shared.png"))
        db = database.SessionLocal()
        try:
            self.assertFalse(avatar_files.forget(db, self._url(eid, "shared.png"), eid))   # still shown
            self.assertFalse(avatar_files.forget(db, self._url("someone-else"), eid))     # not their folder
            self.assertFalse(avatar_files.forget(db, f"{SB}/storage/v1/object/public/avatars/logos/x.png", eid))
            self.assertFalse(avatar_files.forget(db, "https://elsewhere.test/a.png", eid))
        finally:
            db.close()
        self.assertEqual(self.calls, [])

    def test_never_from_a_laptop(self):
        avatar_files._deployed = lambda: False
        eid = self._emp()
        db = database.SessionLocal()
        try:
            self.assertFalse(avatar_files.forget(db, self._url(eid), eid))
        finally:
            db.close()
        self.assertEqual(self.calls, [])


class HrDocumentDeleteTests(_Base):
    def setUp(self):
        super().setUp()
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=ADMIN, role="owner"))
            db.commit()
        finally:
            db.close()
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        auth.invalidate_role_cache(ADMIN)
        self._req = hr_router.httpx.request
        hr_router._SUPABASE_URL, hr_router._SUPABASE_SERVICE_KEY = SB, "svc"

    def tearDown(self):
        hr_router.httpx.request = self._req
        auth.SKIP_AUTH = self._skip
        super().tearDown()

    def _doc(self, path=None):
        eid = self._emp()
        db = database.SessionLocal()
        try:
            did = str(uuid.uuid4())
            db.add(models.HrDocument(id=did, employee_id=eid, kind="other", file_name="f.pdf",
                                     storage_path=path or f"{eid}/f.pdf", uploaded_by=ADMIN))
            db.commit()
            return did
        finally:
            db.close()

    def _track(self, code=200, text=""):
        self.storage_calls = []

        def req(*a, **k):
            self.storage_calls.append(a)
            return Resp(code, text)
        hr_router.httpx.request = req

    def test_a_signed_envelopes_sealed_pdf_is_kept(self):
        # esign files an HrDocument pointing at the envelope's own sealed PDF.
        path = f"esign/{uuid.uuid4()}/final.pdf"
        db = database.SessionLocal()
        try:
            db.add(models.HrSignRequest(id=str(uuid.uuid4()), title="stordel envelope", final_pdf_path=path))
            db.commit()
        finally:
            db.close()
        self._track(200)
        did = self._doc(path)
        self.assertEqual(self.client.delete(f"/hr/documents/{did}").status_code, 200)
        self.assertFalse(self._exists(did))     # the row goes
        self.assertEqual(self.storage_calls, [])   # the envelope's file stays

    def test_a_duplicate_row_keeps_the_file(self):
        path = f"dup/{uuid.uuid4()}.pdf"
        self._track(200)
        first, second = self._doc(path), self._doc(path)
        self.assertEqual(self.client.delete(f"/hr/documents/{first}").status_code, 200)
        self.assertEqual(self.storage_calls, [])
        self.assertTrue(self._exists(second))
        self.assertEqual(self.client.delete(f"/hr/documents/{second}").status_code, 200)
        self.assertEqual(len(self.storage_calls), 1)   # the last one takes the file

    def test_a_400_counts_as_gone_only_when_it_says_not_found(self):
        self._track(400, '{"statusCode":"404","error":"not_found","message":"Object not found"}')
        did = self._doc()
        self.assertEqual(self.client.delete(f"/hr/documents/{did}").status_code, 200)
        self.assertFalse(self._exists(did))
        for code, text in ((400, '{"error":"InvalidKey"}'), (401, ""), (403, "")):
            with self.subTest(code=code):
                self._track(code, text)
                did = self._doc()
                self.assertEqual(self.client.delete(f"/hr/documents/{did}").status_code, 503)
                self.assertTrue(self._exists(did))

    def _exists(self, did):
        db = database.SessionLocal()
        try:
            return db.query(models.HrDocument).filter(models.HrDocument.id == did).first() is not None
        finally:
            db.close()

    def test_storage_refusal_keeps_the_row(self):
        hr_router.httpx.request = lambda *a, **k: Resp(500)
        did = self._doc()
        self.assertEqual(self.client.delete(f"/hr/documents/{did}").status_code, 503)
        self.assertTrue(self._exists(did))

    def test_deleted_file_removes_the_row(self):
        hr_router.httpx.request = lambda *a, **k: Resp(200)
        did = self._doc()
        self.assertEqual(self.client.delete(f"/hr/documents/{did}").status_code, 200)
        self.assertFalse(self._exists(did))

    def test_already_missing_file_still_removes_the_row(self):
        hr_router.httpx.request = lambda *a, **k: Resp(404)
        did = self._doc()
        self.assertEqual(self.client.delete(f"/hr/documents/{did}").status_code, 200)
        self.assertFalse(self._exists(did))


if __name__ == "__main__":
    unittest.main()
