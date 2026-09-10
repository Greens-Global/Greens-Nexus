"""Documents (DMS) - the read boundary as tests.

The module header promises "a Personal-folder document is only visible to its
owner", but for a long time only the LIST endpoints enforced it (_visible).
Fetch-by-id, version history, export and duplicate all fetched the row straight
off its primary key, so a colleague holding the id - from a link, a search
result, an old bookmark - could read, browse the full edit history of, export
and copy someone else's personal draft. _get_readable closes that; these tests
are what stops it reopening.

Also covers the two organize-related guards that landed with the folders/tags
UI: a document cannot be filed into somebody else's Personal folder, and tags
are normalized (trimmed, lowercased, de-duped) so tag search behaves.

    python -m unittest test_documents_scoping
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)

OWNER = "owner.docscope@greensglobal.com"
OTHER = "other.docscope@greensglobal.com"
CO = "co-docscope-test"
EMP_OWNER = "emp-owner-docscope"
EMP_OTHER = "emp-other-docscope"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class DocumentsScopingTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            # Both people sit in the SAME company, so the company wall is
            # neutral here whether or not it is armed on this database - these
            # tests are about the Personal-folder rule, nothing else.
            db.add(models.HrEntity(id=CO, name="Doc Scope Test Co"))
            db.add(models.NexusEmployee(id=EMP_OWNER, first_name="Odette", last_name="Owner",
                                        work_email=OWNER, company=CO, deleted_at=""))
            db.add(models.NexusEmployee(id=EMP_OTHER, first_name="Otto", last_name="Other",
                                        work_email=OTHER, company=CO, deleted_at=""))
            db.commit()
        finally:
            db.close()

        # Seed each person's folders (GET /folders lazily creates them) and
        # hold on to the two that matter.
        _as(OWNER)
        owner_folders = self.client.get("/documents/folders").json()
        self.owner_personal = next(f["id"] for f in owner_folders
                                   if f["key"] == "personal" and f["ownerEmail"] == OWNER)
        self.shared_folder = next(f["id"] for f in owner_folders if f["key"] == "hr")
        _as(OTHER)
        other_folders = self.client.get("/documents/folders").json()
        self.other_personal = next(f["id"] for f in other_folders
                                   if f["key"] == "personal" and f["ownerEmail"] == OTHER)

        _as(OWNER)
        self.personal_doc = self.client.post("/documents", json={
            "title": "Owner private draft", "folderId": self.owner_personal,
            "content": {"body": {"type": "doc", "content": []}},
        }).json()
        self.shared_doc = self.client.post("/documents", json={
            "title": "Owner shared draft", "folderId": self.shared_folder,
            "content": {"body": {"type": "doc", "content": []}},
        }).json()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            folder_ids = [f.id for f in db.query(models.DocFolder)
                          .filter(models.DocFolder.owner_email.in_([OWNER, OTHER])).all()]
            doc_ids = [d.id for d in db.query(models.Document)
                       .filter(models.Document.owner_email.in_([OWNER, OTHER])).all()]
            if doc_ids:
                db.query(models.DocumentVersion).filter(
                    models.DocumentVersion.document_id.in_(doc_ids)).delete(synchronize_session=False)
                db.query(models.Document).filter(
                    models.Document.id.in_(doc_ids)).delete(synchronize_session=False)
            if folder_ids:
                db.query(models.DocFolder).filter(
                    models.DocFolder.id.in_(folder_ids)).delete(synchronize_session=False)
            db.query(models.DocFolder).filter(models.DocFolder.name == "Docscope Test Folder").delete(
                synchronize_session=False)
            db.query(models.NexusEmployee).filter(
                models.NexusEmployee.id.in_([EMP_OWNER, EMP_OTHER])).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id == CO).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    # ── the boundary ────────────────────────────────────────────────────────
    def test_personal_document_is_404_by_id_for_everyone_else(self):
        did = self.personal_doc["id"]
        _as(OTHER)
        self.assertEqual(self.client.get(f"/documents/{did}").status_code, 404)

    def test_personal_document_history_and_copy_are_404_for_everyone_else(self):
        """The three paths that used to go straight to the primary key."""
        did = self.personal_doc["id"]
        _as(OWNER)
        versions = self.client.get(f"/documents/{did}/versions").json()
        self.assertTrue(versions, "owner should see the seeded v1")
        vid = versions[0]["id"]

        _as(OTHER)
        self.assertEqual(self.client.get(f"/documents/{did}/versions").status_code, 404)
        self.assertEqual(self.client.get(f"/documents/{did}/versions/{vid}").status_code, 404)
        self.assertEqual(self.client.post(f"/documents/{did}/duplicate").status_code, 404)

    def test_personal_document_export_is_404_for_everyone_else(self):
        did = self.personal_doc["id"]
        _as(OTHER)
        self.assertEqual(self.client.get(f"/documents/{did}/export/pdf").status_code, 404)
        self.assertEqual(self.client.get(f"/documents/{did}/export/docx").status_code, 404)

    def test_owner_is_not_locked_out_of_their_own_document(self):
        did = self.personal_doc["id"]
        _as(OWNER)
        self.assertEqual(self.client.get(f"/documents/{did}").status_code, 200)
        self.assertEqual(self.client.get(f"/documents/{did}/versions").status_code, 200)

    def test_shared_folder_documents_stay_org_visible(self):
        """The fix must not turn the DMS into a pile of private silos."""
        did = self.shared_doc["id"]
        _as(OTHER)
        self.assertEqual(self.client.get(f"/documents/{did}").status_code, 200)
        listed = [d["id"] for d in self.client.get("/documents").json()]
        self.assertIn(did, listed)
        self.assertNotIn(self.personal_doc["id"], listed)

    # ── organize guards ─────────────────────────────────────────────────────
    def test_cannot_file_a_document_into_someone_elses_personal_folder(self):
        _as(OTHER)
        mine = self.client.post("/documents", json={"title": "Otto draft"}).json()
        r = self.client.patch(f"/documents/{mine['id']}",
                              json={"folderId": self.owner_personal})
        self.assertEqual(r.status_code, 403)
        # ...and into their OWN personal folder is fine.
        ok = self.client.patch(f"/documents/{mine['id']}", json={"folderId": self.other_personal})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["folderId"], self.other_personal)

    def test_tags_are_normalized_on_create_and_update(self):
        _as(OWNER)
        made = self.client.post("/documents", json={
            "title": "Tagged", "tags": ["  HR ", "hr", "Urgent", "", "HR"]}).json()
        self.assertEqual(made["tags"], ["hr", "urgent"])
        patched = self.client.patch(f"/documents/{made['id']}", json={"tags": ["Board", " board "]}).json()
        self.assertEqual(patched["tags"], ["board"])

    def test_tagging_a_document_does_not_add_a_version(self):
        """Re-filing/re-tagging must not pollute the edit history."""
        did = self.shared_doc["id"]
        _as(OWNER)
        before = len(self.client.get(f"/documents/{did}/versions").json())
        self.client.patch(f"/documents/{did}", json={"tags": ["quarterly"], "folderId": self.shared_folder})
        after = len(self.client.get(f"/documents/{did}/versions").json())
        self.assertEqual(before, after)

    def test_adding_a_shared_folder_is_admin_only(self):
        _as(OTHER)
        r = self.client.post("/documents/folders", json={"name": "Docscope Test Folder"})
        self.assertEqual(r.status_code, 403)


if __name__ == "__main__":
    unittest.main()
