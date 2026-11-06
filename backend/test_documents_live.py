"""
Sheets and live editing in Documents (Neil, 11/05/2026, routers/documents.py
"Working together"): a sheet is a document of kind 'sheet'; the owner shares
with Can Edit / Can View; a share opens the document even in a Personal
folder; an editor changes title and content only; the live key goes to
editors only and rotates when an editor leaves; live saves carry the epoch and
rev (409 otherwise); a save outside the live session drops the live state;
live saves do not flood the version history.

    python -m pytest test_documents_live.py
"""
import os
import tempfile
import unittest
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import auth              # noqa: E402
import database          # noqa: E402
import models            # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
import main              # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

OWNER = "live.owner@greensglobal.com"
EDITOR = "live.editor@greensglobal.com"
VIEWER = "live.viewer@greensglobal.com"
STRANGER = "live.stranger@greensglobal.com"

SHEET = {"type": "nexus-sheet", "v": 1, "tabs": [{"id": "t1", "name": "Sheet 1", "frozenRows": 0, "frozenCols": 0,
                                                    "rows": ["r1"], "cols": ["c1"], "cells": {"r1.c1": {"v": 5}},
                                                    "sizes": {}}]}
EPOCH = "epoch_abcdefgh"


class LiveDocuments(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.Document, models.DocumentVersion, models.DocFolder, models.NexusRole,
                  models.NexusNotification):
            db.query(m).delete()
        db.commit()
        db.close()
        self.as_user(OWNER)
        self._dir = mock.patch("routers.notes._directory_person", side_effect=lambda db, user, email: {"email": email})
        self._dir.start()
        # The sheet sits in the owner's Personal folder: only a share opens it.
        folders = self.client.get("/documents/folders").json()
        personal = next(f["id"] for f in folders if f.get("key") == "personal")
        r = self.client.post("/documents", json={"title": "Budget", "kind": "sheet", "content": SHEET, "folderId": personal})
        self.assertEqual(r.status_code, 200, r.text)
        self.did = r.json()["id"]
        self.assertEqual(r.json()["kind"], "sheet")

    def tearDown(self):
        self._dir.stop()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_user(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth._role_cache.clear()

    def share(self, email, can):
        self.as_user(OWNER)
        r = self.client.put(f"/documents/{self.did}/share", json={"email": email, "can": can})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def seed(self):
        r = self.client.post(f"/documents/{self.did}/collab/seed", json={"rev": 1, "ydoc": "AAAA", "yepoch": EPOCH})
        self.assertEqual(r.status_code, 200, r.text)

    def test_sheet_needs_a_sheet_snapshot(self):
        r = self.client.post("/documents", json={"title": "Bad", "kind": "sheet", "content": {"type": "doc"}})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/documents", json={"title": "Bad", "kind": "chart"})
        self.assertEqual(r.status_code, 400)

    def test_share_opens_a_personal_document_and_lists_it(self):
        self.as_user(STRANGER)
        self.assertEqual(self.client.get(f"/documents/{self.did}").status_code, 404)
        self.share(VIEWER, "view")
        self.as_user(VIEWER)
        r = self.client.get(f"/documents/{self.did}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["access"], "view")
        self.assertEqual(r.json()["sharedWith"], [])          # a viewer does not see who else
        rows = [x for x in self.client.get("/documents/library").json() if x["id"] == self.did]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["docKind"], "sheet")
        self.assertEqual(rows[0]["shareCan"], "view")
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.NexusNotification).filter(
                models.NexusNotification.recipient == VIEWER).count(), 1)
        finally:
            db.close()

    def test_viewer_cannot_write_or_get_the_key(self):
        self.share(VIEWER, "view")
        self.as_user(VIEWER)
        self.assertEqual(self.client.patch(f"/documents/{self.did}", json={"title": "Mine"}).status_code, 403)
        self.assertEqual(self.client.get(f"/documents/{self.did}/collab").status_code, 403)
        head = self.client.get(f"/documents/{self.did}/head").json()
        self.assertNotIn("keyTag", head)

    def test_editor_changes_content_not_owner_fields(self):
        self.share(EDITOR, "edit")
        self.as_user(EDITOR)
        self.assertEqual(self.client.patch(f"/documents/{self.did}", json={"title": "Budget 2027"}).status_code, 200)
        self.assertEqual(self.client.patch(f"/documents/{self.did}", json={"status": "archived"}).status_code, 403)
        self.assertEqual(self.client.put(f"/documents/{self.did}/share",
                                         json={"email": STRANGER, "can": "edit"}).status_code, 403)
        self.assertEqual(self.client.patch(f"/documents/{self.did}", json={"content": {"type": "doc"}}).status_code, 400)

    def test_live_key_rotates_when_an_editor_leaves(self):
        self.share(EDITOR, "edit")
        self.as_user(EDITOR)
        first = self.client.get(f"/documents/{self.did}/collab").json()
        self.assertTrue(first["key"] and first["channel"].startswith("nx-doc-"))
        self.share(EDITOR, "view")
        self.as_user(OWNER)
        again = self.client.get(f"/documents/{self.did}/collab").json()
        self.assertNotEqual(first["key"], again["key"])
        self.assertNotEqual(first["channel"], again["channel"])

    def test_seed_first_wins_and_live_saves_check_epoch_and_rev(self):
        self.seed()
        r = self.client.post(f"/documents/{self.did}/collab/seed", json={"rev": 1, "ydoc": "BBBB", "yepoch": "other_epoch1"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"]["collab"]["yepoch"], EPOCH)
        ok = self.client.patch(f"/documents/{self.did}", json={"content": SHEET, "ydoc": "CCCC", "yepoch": EPOCH, "rev": 1})
        self.assertEqual(ok.status_code, 200, ok.text)
        stale = self.client.patch(f"/documents/{self.did}", json={"content": SHEET, "ydoc": "DDDD", "yepoch": EPOCH, "rev": 1})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["collab"]["ydoc"], "CCCC")
        wrong = self.client.patch(f"/documents/{self.did}", json={"content": SHEET, "ydoc": "EEEE", "yepoch": "nope_nope1", "rev": 2})
        self.assertEqual(wrong.status_code, 409)
        self.assertTrue(wrong.json()["detail"]["epoch"])

    def test_save_outside_live_drops_state_and_live_saves_do_not_flood_versions(self):
        self.seed()
        for rev in (1, 2, 3):
            r = self.client.patch(f"/documents/{self.did}", json={"content": SHEET, "ydoc": "CCCC", "yepoch": EPOCH, "rev": rev})
            self.assertEqual(r.status_code, 200, r.text)
        versions = self.client.get(f"/documents/{self.did}/versions").json()
        self.assertEqual(len(versions), 1)                    # "Created" only: the same person, minutes apart
        changed = {**SHEET, "tabs": [{**SHEET["tabs"][0], "cells": {"r1.c1": {"v": 6}}}]}
        r = self.client.patch(f"/documents/{self.did}", json={"content": changed})
        self.assertEqual(r.status_code, 200)
        head = self.client.get(f"/documents/{self.did}/head").json()
        self.assertEqual(head["yepoch"], "")
        self.assertEqual(len(self.client.get(f"/documents/{self.did}/versions").json()), 2)

    def test_administrator_reaching_a_document_only_by_share_gets_the_share_level(self):
        self.share(STRANGER, "view")
        db = database.SessionLocal()
        db.add(models.NexusRole(email=STRANGER, role="administrator"))
        db.commit(); db.close()
        self.as_user(STRANGER)
        import auth as _auth
        with mock.patch.object(_auth, "company_scope", return_value={"other-company"}), \
             mock.patch.object(_auth, "company_of", return_value="owner-company"):
            self.assertEqual(self.client.get(f"/documents/{self.did}").json()["access"], "view")
            self.assertEqual(self.client.patch(f"/documents/{self.did}", json={"title": "Taken"}).status_code, 403)
            self.assertEqual(self.client.get(f"/documents/{self.did}/collab").status_code, 403)
            self.assertEqual(self.client.post(f"/documents/{self.did}/archive").status_code, 403)
            self.assertEqual(self.client.put(f"/documents/{self.did}/share", json={"email": EDITOR, "can": "edit"}).status_code, 403)

    def test_final_document_is_never_live_and_sheet_does_not_export(self):
        self.assertEqual(self.client.get(f"/documents/{self.did}/export/pdf").status_code, 400)
        self.assertEqual(self.client.patch(f"/documents/{self.did}", json={"status": "final"}).status_code, 200)
        self.assertEqual(self.client.get(f"/documents/{self.did}/collab").status_code, 409)


if __name__ == "__main__":
    unittest.main()
