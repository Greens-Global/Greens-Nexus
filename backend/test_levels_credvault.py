"""Credentials grant levels (11/12/2026, routers/credvault.py _can_modify):
Viewer uses shared logins, Editor also creates and imports, Full also manages
every credential on its side of the wall (edit, share, transfer, trash,
delete) the way an administrator does.

    python -m pytest test_levels_credvault.py
"""
import unittest

import levels_testkit as kit

kit.bind_db()

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
OWNER, VIEWER, EDITOR, FULL = "cv.owner" + D, "cv.viewer" + D, "cv.editor" + D, "cv.full" + D


class CredvaultLevelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            kit.reset(db, models.VaultCredential, models.VaultAccessLog)
            for em in (OWNER, VIEWER, EDITOR, FULL):
                kit.person(db, em)
            kit.grant(db, VIEWER, "credvault:viewer")
            kit.grant(db, EDITOR, "credvault:editor")
            kit.grant(db, FULL, "credvault:full")
            db.add(models.VaultCredential(id="c1", name="Bank", dept="IT", owner_email=OWNER, created_by=OWNER))
            db.commit()
        finally:
            db.close()
        kit.refresh()

    def test_viewer_sees_but_cannot_create_or_remove(self):
        kit.as_(VIEWER)
        self.assertEqual(self.client.get("/credvault/credentials").status_code, 200)
        r = self.client.post("/credvault/credentials", json={"name": "New", "dept": "IT", "secret": "Sup3r-secret-pw!"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.delete("/credvault/credentials/c1").status_code, 403)

    def test_editor_creates_but_cannot_remove_someone_elses(self):
        kit.as_(EDITOR)
        r = self.client.post("/credvault/credentials", json={"name": "New", "dept": "IT", "secret": "Sup3r-secret-pw!"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.delete("/credvault/credentials/c1").status_code, 403)
        self.assertEqual(self.client.post("/credvault/credentials/c1/transfer", json={"ownerEmail": EDITOR}).status_code, 403)

    def test_full_manages_every_credential(self):
        kit.as_(FULL)
        self.assertEqual(self.client.post("/credvault/credentials/c1/transfer", json={"ownerEmail": FULL}).status_code, 200)
        self.assertEqual(self.client.delete("/credvault/credentials/c1").status_code, 200)
        db = database.SessionLocal()
        try:
            self.assertTrue(db.get(models.VaultCredential, "c1").deleted_at)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
