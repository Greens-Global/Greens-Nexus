"""Open in Word (routers/doc_word_link.py): a reader gets a short-lived signed
link Word fetches with no sign-in; the file is the Export DOCX render; an
expired, tampered or foreign token, or a person who can no longer read the
document, gets nothing.

    python -m pytest test_doc_word_link.py
"""
import os
import tempfile
import time
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import auth              # noqa: E402
import database          # noqa: E402
import models            # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import main              # noqa: E402
from routers import doc_word_link  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

OWNER = "word.owner@greensglobal.com"
OTHER = "word.other@greensglobal.com"
BODY = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Net 30 terms"}]}]}


class WordLinkTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.Document, models.DocFolder, models.NexusRole):
            db.query(m).delete()
        self.did = f"doc-{uuid.uuid4()}"
        db.add(models.Document(id=self.did, title="Vendor Agreement: Q4", owner_email=OWNER, created_by=OWNER,
                               content={"pages": [{"json": BODY}]}, status="draft"))
        self.private = f"doc-{uuid.uuid4()}"
        db.add(models.DocFolder(id="f-personal", name="Personal", key="personal", owner_email=OWNER))
        db.add(models.Document(id=self.private, title="Draft", owner_email=OWNER, created_by=OWNER,
                               folder_id="f-personal", content={"pages": []}, status="draft"))
        db.commit()
        db.close()
        self.as_user(OWNER)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_user(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth._role_cache.clear()

    def _link(self, did):
        r = self.client.post(f"/documents/word-link/{did}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["path"]

    def _fetch_signed_out(self, url):
        auth.SKIP_AUTH = False          # Word carries no sign-in
        try:
            return self.client.get(url)
        finally:
            auth.SKIP_AUTH = True

    def _file(self, token):
        return self._fetch_signed_out(f"http://x/documents/word-file/{token}/a.docx").status_code

    def test_word_opens_the_docx_with_no_sign_in(self):
        url = self._link(self.did)
        self.assertTrue(url.endswith("/Vendor-Agreement-Q4.docx"), url)
        r = self._fetch_signed_out(url)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.content.startswith(b"PK"))          # a real .docx (zip)
        self.assertIn("wordprocessingml", r.headers["content-type"])
        self.assertEqual(r.headers["cache-control"], "no-store")

    def test_expired_tampered_and_unreadable_links_get_nothing(self):
        old = doc_word_link.make_token(self.did, OWNER, now=time.time() - doc_word_link.LINK_TTL_S - 5)
        self.assertEqual(self._file(old), 404)
        good = doc_word_link.make_token(self.did, OWNER)
        self.assertEqual(self._file(good[:-3] + ("AAA" if not good.endswith("AAA") else "BBB")), 404)
        # A token naming someone who cannot read the document is refused at fetch time.
        self.assertEqual(self._file(doc_word_link.make_token(self.private, OTHER)), 404)

    def test_a_link_is_only_made_for_a_document_you_can_read(self):
        self.as_user(OTHER)
        self.assertEqual(self.client.post(f"/documents/word-link/{self.private}").status_code, 404)
        self.assertEqual(self.client.post("/documents/word-link/no-such-doc").status_code, 404)


if __name__ == "__main__":
    unittest.main()
