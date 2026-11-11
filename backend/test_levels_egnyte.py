"""Files (egnyte) grant levels (11/12/2026, routers/egnyte.py): Viewer browses
and downloads, Editor uploads, renames, moves and makes folders, Full also
deletes; supervisor+ keep every write; Wiring stays the Manager tier's.

    python -m pytest test_levels_egnyte.py
"""
import unittest
from unittest import mock

import levels_testkit as kit

kit.bind_db()

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import egnyte_oauth  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from services import egnyte as svc  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
VIEWER, EDITOR, FULL = "eg.viewer" + D, "eg.editor" + D, "eg.full" + D
MOVE = {"path": "/Shared/A/x.pdf", "destination": "/Shared/B/x.pdf"}


class EgnyteLevelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            kit.reset(db)
            for em in (VIEWER, EDITOR, FULL):
                kit.person(db, em)
            kit.grant(db, VIEWER, "egnyte:viewer")
            kit.grant(db, EDITOR, "egnyte:editor")
            kit.grant(db, FULL, "egnyte:full")
            db.commit()
        finally:
            db.close()
        kit.refresh()
        self._patches = [
            mock.patch.object(svc, "configured", lambda: True),
            mock.patch.object(egnyte_oauth, "oauth_configured", lambda: False),
            mock.patch.object(svc, "list_folder", lambda *a, **k: {"files": [], "folders": []}),
            mock.patch.object(svc, "move_item", lambda *a, **k: {"ok": True}),
            mock.patch.object(svc, "delete_item", lambda *a, **k: {"ok": True}),
        ]
        for p in self._patches:
            p.start()
            self.addCleanup(p.stop)

    def test_viewer_browses_only(self):
        kit.as_(VIEWER)
        self.assertEqual(self.client.get("/egnyte/folder", params={"path": "/Shared"}).status_code, 200)
        self.assertEqual(self.client.post("/egnyte/fs/move", json=MOVE).status_code, 401)
        self.assertEqual(self.client.post("/egnyte/fs/delete", json={"path": "/Shared/A/x.pdf"}).status_code, 401)

    def test_editor_moves_but_does_not_delete(self):
        kit.as_(EDITOR)
        self.assertEqual(self.client.post("/egnyte/fs/move", json=MOVE).status_code, 200)
        self.assertEqual(self.client.post("/egnyte/fs/delete", json={"path": "/Shared/A/x.pdf"}).status_code, 401)

    def test_full_deletes_but_wiring_stays_manager(self):
        kit.as_(FULL)
        self.assertEqual(self.client.post("/egnyte/fs/delete", json={"path": "/Shared/A/x.pdf"}).status_code, 200)
        self.assertEqual(self.client.get("/egnyte/wiring").status_code, 401)


if __name__ == "__main__":
    unittest.main()
