"""A bare TipTap doc saved through the API is stored the way the editor saves
it - {pages: [{id, json}], header, footer} - so it never renders as a blank
PDF (Oct 23 walkthrough: a template made by a script printed only "Page 1").

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_documents_page_format.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers.documents import as_pages  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)
ADMIN = "admin.pages.test@greensglobal.com"
BARE = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hello"}]}]}


class PageFormatTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        db = database.SessionLocal()
        db.query(models.NexusRole).delete()
        db.add(models.NexusRole(email=ADMIN, role="owner"))
        db.commit()
        db.close()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip

    def test_a_bare_doc_is_wrapped_and_a_paged_one_kept(self):
        wrapped = as_pages(BARE)
        self.assertEqual(wrapped["pages"][0]["json"], BARE)
        paged = {"pages": [{"id": "p1", "json": BARE}], "header": None, "footer": None}
        self.assertIs(as_pages(paged), paged)

    def test_template_saves_store_pages(self):
        r = self.client.post("/documents/templates", json={"name": "Script Made", "category": "hr", "content": BARE})
        self.assertEqual(r.status_code, 200, r.text)
        tid = r.json()["id"]
        db = database.SessionLocal()
        try:
            row = db.query(models.DocTemplate).filter(models.DocTemplate.id == tid).first()
            self.assertEqual(row.content["pages"][0]["json"], BARE)
        finally:
            db.close()
        r = self.client.patch(f"/documents/templates/{tid}", json={"content": BARE})
        self.assertIn(r.status_code, (200, 201), r.text)
        db = database.SessionLocal()
        try:
            row = db.query(models.DocTemplate).filter(models.DocTemplate.id == tid).first()
            self.assertIn("pages", row.content)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
