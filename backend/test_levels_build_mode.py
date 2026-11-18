"""Build Mode grant levels (11/12/2026, routers/dev_notes.py): Viewer sees pins
and sessions, Editor drops pins, comments and works their own, Full also
changes, dismisses and checks anyone's pins and renames any session; purging
media stays a Super Administrator's.

    python -m pytest test_levels_build_mode.py
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
VIEWER, EDITOR, FULL = "bm.viewer" + D, "bm.editor" + D, "bm.full" + D
PIN = {"kind": "bug", "priority": "normal", "comment": "The button is off", "route": "tasks"}


class BuildModeLevelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            kit.reset(db, models.DevNote, models.DevNoteSession, models.NexusSetting)
            for em in (VIEWER, EDITOR, FULL):
                kit.person(db, em)
            kit.grant(db, VIEWER, "build-mode:viewer")
            kit.grant(db, EDITOR, "build-mode:editor")
            kit.grant(db, FULL, "build-mode:full")
            db.commit()
        finally:
            db.close()
        kit.refresh()

    def _pin_by(self, email: str) -> str:
        kit.as_(email)
        r = self.client.post("/dev-notes", json=PIN)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def test_viewer_sees_pins_but_drops_none(self):
        kit.as_(VIEWER)
        self.assertEqual(self.client.get("/dev-notes").status_code, 200)
        self.assertEqual(self.client.get("/dev-notes/sessions").status_code, 200)
        self.assertEqual(self.client.post("/dev-notes", json=PIN).status_code, 403)

    def test_editor_works_own_pins_only(self):
        mine = self._pin_by(EDITOR)
        theirs = self._pin_by(FULL)
        kit.as_(EDITOR)
        self.assertEqual(self.client.patch(f"/dev-notes/{mine}", json={"comment": "Clearer"}).status_code, 200)
        self.assertEqual(self.client.post(f"/dev-notes/{theirs}/thread", json={"text": "Seen"}).status_code, 200)
        self.assertEqual(self.client.patch(f"/dev-notes/{theirs}", json={"status": "dismissed"}).status_code, 403)

    def test_full_works_anyones_pins_but_never_purges(self):
        theirs = self._pin_by(EDITOR)
        kit.as_(FULL)
        self.assertEqual(self.client.patch(f"/dev-notes/{theirs}", json={"status": "dismissed"}).status_code, 200)
        self.assertEqual(self.client.post("/dev-notes/purge").status_code, 403)


if __name__ == "__main__":
    unittest.main()
