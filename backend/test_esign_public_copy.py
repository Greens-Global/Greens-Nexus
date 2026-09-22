"""
"Download a copy to read or print" has to hand back the DOCUMENT (Sagar,
Sep 22 2026: "downloading an empty html doc").

The signing page points a plain <a download> at /esign/public/{token}/copy.
For a PDF envelope that endpoint answered with a JSON object describing a
signed URL, so the browser dutifully saved that JSON instead of the file. It
now redirects to the file. The retention right itself (UETA section 8) is
unchanged: available before signing, and logged.

    python -m unittest test_esign_public_copy
"""
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database          # noqa: E402
import models            # noqa: E402
from routers import esign   # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

SIGNED = "https://storage.example/object/sign/docs/envelope.pdf?token=abc"


class PublicCopyTests(unittest.TestCase):
    def setUp(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        self.db = database.SessionLocal()
        self.req_id = f"req-copy-{uuid.uuid4()}"
        self.token = uuid.uuid4().hex
        self.db.add(models.HrSignRequest(id=self.req_id, title="Vendor NDA", status="pending",
                                         routing="sequential", current_order=1,
                                         source="pdf", pdf_storage_path="envelopes/nda.pdf",
                                         created_by="sender@greensglobal.com",
                                         created_at="2026-09-22T00:00:00+00:00"))
        self.db.add(models.HrSignParty(id=f"party-{uuid.uuid4()}", request_id=self.req_id,
                                       name="Sam Vendor", email="sam@example.com", kind="external",
                                       party_role="signer", ordinal=1, status="notified",
                                       token=self.token))
        self.db.commit()
        app = FastAPI()
        app.include_router(esign.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_it_redirects_to_the_file_instead_of_describing_it(self):
        result = esign._StorageResult(True, json_data={"url": SIGNED, "expiresIn": 300})
        with patch.object(esign, "_storage_signed_url", return_value=result):
            r = self.client.get(f"/esign/public/{self.token}/copy", follow_redirects=False)
        self.assertEqual(r.status_code, 302)
        self.assertEqual(r.headers["location"], SIGNED)
        self.assertNotIn("application/json", r.headers.get("content-type", ""))

    def test_taking_a_copy_is_still_recorded(self):
        """The retention right is evidence: the certificate shows the signer
        had the terms while deciding."""
        result = esign._StorageResult(True, json_data={"url": SIGNED, "expiresIn": 300})
        with patch.object(esign, "_storage_signed_url", return_value=result):
            self.client.get(f"/esign/public/{self.token}/copy", follow_redirects=False)
        kinds = [e.type for e in self.db.query(models.HrSignEvent)
                 .filter(models.HrSignEvent.request_id == self.req_id).all()]
        self.assertIn("copy_retained", kinds)

    def test_a_storage_failure_still_says_so_plainly(self):
        result = esign._StorageResult(False, text="no such object")
        with patch.object(esign, "_storage_signed_url", return_value=result):
            r = self.client.get(f"/esign/public/{self.token}/copy", follow_redirects=False)
        self.assertEqual(r.status_code, 502)


if __name__ == "__main__":
    unittest.main()
