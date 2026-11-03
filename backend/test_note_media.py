"""Delete Forever on a note removes its files too (note_media.py, 11/02/2026):
only task-files objects under notes/, only when no other row points at them,
only on the deployed API, and the delete route still answers 204 when the
storage call fails.

Run on its own: `python -m pytest test_note_media.py` (one file per process -
see CLAUDE.md)."""
import os
import unittest
import uuid

import _testdb  # noqa: F401  - a throwaway database whatever runner imports this file

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import note_media  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

BASE = "https://proj.supabase.co/storage/v1/object/public/task-files/"
OWNER = "notemedia.owner@greensglobal.com"


class FakeResp:
    def __init__(self, code=200, data=None):
        self.status_code = code
        self.is_success = 200 <= code < 300
        self._data = data

    def json(self):
        return self._data


class PathsTests(unittest.TestCase):
    def test_finds_canonical_and_viewer_links_under_notes_only(self):
        body = (f'<audio src="{BASE}notes/1-abc.webm"></audio>'
                f'<img src="https://api.test/files/view?u={BASE.replace(":", "%3A").replace("/", "%2F")}notes%2Fboards%2Fn1%2F2-x.png">'
                f'<img src="{BASE}tasks/9-other.png">')
        self.assertEqual(note_media.paths_in(body, None, ""),
                         {"notes/1-abc.webm", "notes/boards/n1/2-x.png"})

    def test_refuses_path_tricks(self):
        self.assertEqual(note_media.paths_in(f'"{BASE}notes/../tasks/x.png"'), set())


class PurgeTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = OWNER
        self._env = {k: os.environ.get(k) for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY")}
        os.environ["SUPABASE_URL"] = "https://proj.supabase.co"
        os.environ["SUPABASE_SERVICE_KEY"] = "svc"
        self.deleted = []
        self.listed = []
        self._orig = (note_media.httpx.delete, note_media.httpx.post, note_media._deployed)

        def fake_delete(url, **kw):
            self.deleted.append(url.split("/task-files/", 1)[1])
            return FakeResp(200)

        def fake_post(url, json=None, **kw):
            self.listed.append(json["prefix"])
            return FakeResp(200, [{"name": "old-thumb.png", "id": "x"}])
        note_media.httpx.delete = fake_delete
        note_media.httpx.post = fake_post
        note_media._deployed = lambda: True
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=OWNER, role="employee"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(OWNER)

    def tearDown(self):
        note_media.httpx.delete, note_media.httpx.post, note_media._deployed = self._orig
        self._cleanup()
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusNote).filter(models.NexusNote.owner_email.like("notemedia.%")).delete(
                synchronize_session=False)
            db.query(models.TaskAttachment).filter(models.TaskAttachment.added_by.like("notemedia.%")).delete(
                synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("notemedia.%")).delete(
                synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _note(self, body, trashed=True, scene="", thumb=""):
        db = database.SessionLocal()
        try:
            nid = "note_" + uuid.uuid4().hex[:10]
            db.add(models.NexusNote(id=nid, owner_email=OWNER, title="T", body=body, scene=scene, thumb_url=thumb,
                                    trashed_at="2026-11-01T00:00:00Z" if trashed else ""))
            db.commit()
            return nid
        finally:
            db.close()

    def test_delete_forever_removes_the_notes_own_files_and_keeps_shared_ones(self):
        nid = self._note(f'<audio src="{BASE}notes/1-voice.webm"></audio><img src="{BASE}notes/boards/x/2-shared.png">',
                         thumb=f"{BASE}notes/boards/x/3-thumb.png")
        self._note(f'<img src="{BASE}notes/boards/x/2-shared.png">', trashed=False)   # another note uses it
        db = database.SessionLocal()
        try:
            db.add(models.TaskAttachment(id=uuid.uuid4().hex, task_id="t1", name="m.png",
                                         url=f"{BASE}notes/boards/x/3-thumb.png", added_by=OWNER))
            db.commit()
        finally:
            db.close()
        r = self.client.delete(f"/notes/{nid}")
        self.assertEqual(r.status_code, 204, r.text)
        self.assertIn("notes/1-voice.webm", self.deleted)
        self.assertNotIn("notes/boards/x/2-shared.png", self.deleted)   # another note
        self.assertNotIn("notes/boards/x/3-thumb.png", self.deleted)    # a task attachment
        self.assertEqual(self.listed, [f"notes/boards/{nid}"])
        self.assertIn(f"notes/boards/{nid}/old-thumb.png", self.deleted)  # the board's own folder

    def test_a_laptop_never_deletes_live_storage(self):
        note_media._deployed = lambda: False
        nid = self._note(f'<audio src="{BASE}notes/1-voice.webm"></audio>')
        self.assertEqual(self.client.delete(f"/notes/{nid}").status_code, 204)
        self.assertEqual(self.deleted, [])

    def test_a_storage_failure_still_deletes_the_note(self):
        def boom(*a, **k):
            raise RuntimeError("storage down")
        note_media.httpx.delete = boom
        nid = self._note(f'<audio src="{BASE}notes/1-voice.webm"></audio>')
        self.assertEqual(self.client.delete(f"/notes/{nid}").status_code, 204)
        db = database.SessionLocal()
        try:
            self.assertIsNone(db.query(models.NexusNote).filter(models.NexusNote.id == nid).first())
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
