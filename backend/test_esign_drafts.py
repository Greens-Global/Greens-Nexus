"""
Send for Signature drafts (Sagar, Sep 22 2026: "add a draft button that will
keep the Send signatures which were stopped in the mid").

Filling one of these in is twenty minutes of work - recipients, field
placement, a message, an expiry - and closing the wizard threw all of it away.
A draft keeps the wizard's own state AND the source PDF: the field coordinates
were placed on that exact file, so handing back a different one would move
every field on the page.

Private to the owner, because what someone is drafting is nobody else's
business.

    python -m unittest test_esign_drafts
"""
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi.testclient import TestClient   # noqa: E402

import auth                # noqa: E402
import database            # noqa: E402
import main                # noqa: E402
import models              # noqa: E402
from routers import esign  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ME = "sagar.shoundik@greensglobal.com"
SOMEONE_ELSE = "maria.ortiz@greensglobal.com"

PAYLOAD = {
    "title": "Joining Letter", "source": "pdf", "routing": "sequential",
    "parties": [{"name": "Test Sagar", "email": "test@partner.example",
                 "kind": "external", "party_role": "signer"}],
    "fields": [{"id": "f1", "type": "sign", "page": 0, "x": 0.1, "y": 0.6,
                "w": 0.3, "h": 0.06, "role": "r1"}],
}


class DraftTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ME
        self.db = database.SessionLocal()
        self.db.query(models.HrSignDraft).delete()
        self.db.commit()

    def tearDown(self):
        self.db.query(models.HrSignDraft).delete()
        self.db.commit()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _save(self, payload=None, draft_id="", with_file=False):
        data = {"payload": json.dumps(payload or PAYLOAD)}
        if draft_id:
            data["id"] = draft_id
        files = {"file": ("nda.pdf", io.BytesIO(b"%PDF-1.4 tiny"), "application/pdf")} \
            if with_file else None
        with patch.object(esign, "_storage_put",
                          return_value=esign._StorageResult(True, json_data={})):
            return self.client.post("/esign/drafts", data=data, files=files)

    def test_a_draft_keeps_the_wizard_state_verbatim(self):
        r = self._save()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["title"], "Joining Letter")
        self.assertEqual(body["recipients"], 1)
        # The field placement survives, or resuming would lose the work.
        self.assertEqual(body["payload"]["fields"][0]["x"], 0.1)

    def test_saving_again_updates_the_same_draft_rather_than_piling_up(self):
        first = self._save().json()
        again = self._save({**PAYLOAD, "title": "Joining Letter v2"}, draft_id=first["id"]).json()
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(again["title"], "Joining Letter v2")
        self.assertEqual(len(self.client.get("/esign/drafts").json()), 1)

    def test_the_source_pdf_is_kept_with_it(self):
        """The fields were placed on THAT file - a draft that could not hand it
        back would be worse than none."""
        body = self._save(with_file=True).json()
        self.assertTrue(body["hasFile"])
        self.assertEqual(body["fileName"], "nda.pdf")

    def test_a_draft_is_private_to_whoever_saved_it(self):
        mine = self._save().json()
        os.environ["NEXUS_DEV_EMAIL"] = SOMEONE_ELSE
        self.assertEqual(self.client.get("/esign/drafts").json(), [])
        # And they cannot reach it by id either.
        self.assertEqual(self.client.delete(f"/esign/drafts/{mine['id']}").status_code, 404)

    def test_deleting_one_removes_it(self):
        mine = self._save().json()
        self.assertEqual(self.client.delete(f"/esign/drafts/{mine['id']}").status_code, 200)
        self.assertEqual(self.client.get("/esign/drafts").json(), [])

    def test_a_payload_that_is_not_json_is_refused(self):
        r = self.client.post("/esign/drafts", data={"payload": "not json"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("JSON", r.json()["detail"])

    def test_an_untitled_draft_still_lists_as_something(self):
        body = self._save({"parties": []}).json()
        self.assertEqual(body["title"], "Untitled")
        self.assertEqual(body["recipients"], 0)

    def test_the_newest_draft_is_listed_first(self):
        a = self._save({**PAYLOAD, "title": "First"}).json()
        b = self._save({**PAYLOAD, "title": "Second"}).json()
        row = self.db.query(models.HrSignDraft).filter(models.HrSignDraft.id == a["id"]).first()
        row.updated_at = "2026-01-01T00:00:00+00:00"      # make the order unambiguous
        self.db.commit()
        titles = [d["title"] for d in self.client.get("/esign/drafts").json()]
        self.assertEqual(titles[0], "Second")
        self.assertEqual(b["title"], "Second")


if __name__ == "__main__":
    unittest.main()
