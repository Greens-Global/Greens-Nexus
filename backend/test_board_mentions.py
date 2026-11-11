"""Board comment @mentions send a bell (Neil, 11/10/2026) - routers/notes.py
POST /notes/{id}/board-mentions.

  - Only people who can open the board (owner and shares) are belled, never
    the caller; everyone else comes back in `skipped`.
  - A Can View share is 403, a stranger 404, a plain note 400, a bad pin 400.
  - One bell per person, board and pin: a second mention rewrites it in place.

Uses a throwaway sqlite file.

Run with: python -m pytest test_board_mentions.py   (one file per process - CLAUDE.md)
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "amy@greensglobal.com"

from fastapi import FastAPI                              # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import database                                          # noqa: E402
import models                                            # noqa: E402
from auth import get_current_user                        # noqa: E402
from routers import notes                                # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

AMY = "amy@greensglobal.com"
BOB = "bob@greensglobal.com"
CAT = "cat@greensglobal.com"
DAN = "dan@greensglobal.com"


class BoardMentionsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        for email, first in ((AMY, "Amy"), (BOB, "Bob"), (CAT, "Cat"), (DAN, "Dan")):
            db.add(models.NexusEmployee(id=gen_id(), first_name=first, last_name="Test", work_email=email,
                                        company="gg", status="active"))
        db.commit()
        db.close()

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusNote, models.NexusNoteVersion, models.NexusNotePresence, models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()
        self.as_(AMY)
        app = FastAPI()
        app.include_router(notes.router)
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        r = self.client.post("/notes", json={"kind": "board", "title": "Yard Layout"})
        self.assertEqual(r.status_code, 201, r.text)
        self.board = r.json()
        self.client.put(f"/notes/{self.board['id']}/share", json={"email": BOB, "can": "edit"})
        self.client.put(f"/notes/{self.board['id']}/share", json={"email": CAT, "can": "read"})

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def as_(self, email):
        self.user = {"email": email, "name": email.split("@")[0].title(), "role": "employee", "level": 1}

    def mention(self, emails, text="Can you check the gate?", pin="c_1", note=None):
        return self.client.post(f"/notes/{(note or self.board)['id']}/board-mentions",
                                json={"pin": pin, "text": text, "emails": emails})

    def bells(self, recipient):
        self.db.expire_all()
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == recipient,
                        models.NexusNotification.ref_id.like("board-mention:%")).all())

    def test_owner_mentions_an_editor_and_a_reader_and_both_get_a_bell(self):
        r = self.mention([BOB.upper(), CAT, BOB])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"sent": [BOB, CAT], "skipped": []})
        (b,) = self.bells(BOB)
        self.assertEqual(b.title, "Mentioned on a Board")
        self.assertEqual(b.body, "Amy mentioned you on Yard Layout: Can you check the gate?")
        self.assertEqual(json.loads(b.action),
                         {"view": "dashboard", "sub": f"notes:{self.board['id']}~c_1"})
        self.assertEqual(b.ref_id, f"board-mention:{self.board['id']}:c_1")
        self.assertEqual(len(self.bells(CAT)), 1)

    def test_editor_mentions_the_owner(self):
        self.as_(BOB)
        r = self.mention([AMY])
        self.assertEqual(r.json(), {"sent": [AMY], "skipped": []})
        self.assertEqual(len(self.bells(AMY)), 1)

    def test_non_member_and_self_are_skipped(self):
        r = self.mention([DAN, AMY, "nobody@elsewhere.com"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"sent": [], "skipped": [DAN, AMY, "nobody@elsewhere.com"]})
        self.assertEqual(self.bells(DAN) + self.bells(AMY), [])

    def test_viewer_is_403_and_stranger_is_404(self):
        self.as_(CAT)
        self.assertEqual(self.mention([AMY]).status_code, 403)
        self.as_(DAN)
        self.assertEqual(self.mention([AMY]).status_code, 404)
        self.assertEqual(self.bells(AMY), [])

    def test_trashed_board_is_403(self):
        self.client.post(f"/notes/{self.board['id']}/trash")
        self.assertEqual(self.mention([BOB]).status_code, 403)

    def test_plain_note_is_400(self):
        note = self.client.post("/notes", json={"title": "Plain"}).json()
        self.assertEqual(self.mention([BOB], note=note).status_code, 400)

    def test_second_mention_on_the_same_pin_updates_in_place(self):
        self.mention([BOB])
        self.assertEqual(self.mention([BOB], text="x" * 300).status_code, 200)
        (b,) = self.bells(BOB)
        self.assertFalse(b.read_by)
        self.assertTrue(b.body.endswith("..."))
        self.assertLess(len(b.body), 200)
        self.mention([BOB], pin="c_2")      # another comment is its own bell
        self.assertEqual(len(self.bells(BOB)), 2)

    def test_bad_input_is_refused(self):
        for kw in ({"pin": "bad pin!"}, {"pin": ""}, {"pin": "a" * 65}, {"text": "   "}, {"text": "x" * 1001}):
            self.assertEqual(self.mention([BOB], **kw).status_code, 400, kw)
        self.assertEqual(self.mention([]).status_code, 400)
        self.assertEqual(self.mention([f"p{i}@x.com" for i in range(21)]).status_code, 400)
        self.assertEqual(self.bells(BOB), [])


if __name__ == "__main__":
    unittest.main()
