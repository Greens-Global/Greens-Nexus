"""Boards - a whiteboard is a note (Neil, 11/02/2026) - routers/notes.py.

  - kind 'board': the drawing is JSON in `scene` (never the HTML sanitizer),
    2,000,000 characters at most (413 past it), refused (400) unless it is a
    JSON object with type 'nexus-board'. A plain note or a daily never takes
    a scene.
  - The owner and a Can Edit share save the scene; a Can View share is 403;
    a stranger 404. A scene saved outside a live session drops the co-typing
    state like a body save does.
  - `thumbUrl` must be our Supabase storage ('' clears); `source` names where
    a Mark Up came from (kind task | ticket | note | walkthrough | file, id,
    label <= 200, url ours or '').
  - List rows carry kind, thumbUrl and source but never the scene; the single
    GET carries the scene. The words inside text elements are indexed for
    search and the preview.
  - Versions keep the scene and restore puts it back; the list carries
    shapes / words only, GET /versions/{id} one copy in full. GET /collab for a board
    carries the scene so the first editor can seed the live state from it.
  - Notes and the daily scratchpad are unchanged.

Uses a throwaway sqlite file.

Run with: python -m pytest test_notes_boards.py   (one file per process - CLAUDE.md)
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

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
TODAY = "2026-11-02"
OWN = "https://store.supabase.co/storage/v1/object/public/task-files/notes/boards/note_1/thumb.png"


def scene(*texts, look="clean", extra=None):
    """A nexus-board scene with one text element per word given."""
    els = [{"id": f"t{i}", "type": "text", "x": 10 * i, "y": 0, "text": t, "version": 1, "versionNonce": i,
            "isDeleted": False} for i, t in enumerate(texts)]
    s = {"type": "nexus-board", "version": 1, "look": look, "elements": els,
         "appState": {"viewBackgroundColor": "#ffffff", "gridSize": 20}, "files": {}}
    if extra:
        s.update(extra)
    return json.dumps(s)


class BoardsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        for email, first in ((AMY, "Amy"), (BOB, "Bob"), (CAT, "Cat")):
            db.add(models.NexusEmployee(id=gen_id(), first_name=first, last_name="Test", work_email=email,
                                        company="gg", status="active"))
        db.commit()
        db.close()

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusNote, models.NexusNoteVersion, models.NexusNotePresence, models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()
        self.user = {"email": AMY, "name": "Amy Test", "role": "employee", "level": 1}
        app = FastAPI()
        app.include_router(notes.router)
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.own = mock.patch.object(notes, "_own_image", lambda src: src.startswith("https://store.supabase.co/"))
        self.own.start()

    def tearDown(self):
        self.own.stop()
        self.db.rollback()
        self.db.close()

    def as_(self, email):
        self.user = {"email": email, "name": email.split("@")[0].title(), "role": "employee", "level": 1}

    def board(self, **kw):
        kw.setdefault("kind", "board")
        kw.setdefault("title", "Yard Layout")
        kw.setdefault("day", TODAY)
        r = self.client.post("/notes", json=kw)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def patch(self, n, **kw):
        kw.setdefault("rev", n["rev"])
        return self.client.patch(f"/notes/{n['id']}", json=kw)

    # ── create and read ────────────────────────────────────────────────────
    def test_a_board_is_a_note_with_a_scene(self):
        n = self.board(scene=scene("Gate A", "Wash bay"))
        self.assertEqual(n["kind"], "board")
        self.assertEqual(json.loads(n["scene"])["type"], "nexus-board")
        self.assertEqual(len(json.loads(n["scene"])["elements"]), 2)
        self.assertEqual(n["thumbUrl"], "")
        self.assertIsNone(n["source"])
        self.assertEqual(n["body"], "")
        # The words on the board are its preview and its search index.
        self.assertEqual(n["preview"], "Gate A\nWash bay")
        self.assertEqual(n["words"], 4)
        got = self.client.get(f"/notes/{n['id']}").json()
        self.assertEqual(got["scene"], n["scene"])
        rows = self.client.get("/notes").json()["notes"]
        self.assertEqual(rows[0]["kind"], "board")
        self.assertIn("thumbUrl", rows[0])
        self.assertIn("source", rows[0])
        self.assertNotIn("scene", rows[0])
        self.assertEqual(self.client.get("/notes?q=wash").json()["notes"][0]["id"], n["id"])

    def test_a_board_without_a_scene_starts_empty(self):
        n = self.board()
        s = json.loads(n["scene"])
        self.assertEqual(s["type"], "nexus-board")
        self.assertEqual(s["elements"], [])
        self.assertEqual(s["look"], "clean")
        # templateKey is the client's business - accepted, nothing stored.
        n2 = self.board(templateKey="kanban")
        self.assertEqual(json.loads(n2["scene"])["elements"], [])

    def test_a_scene_is_compacted_json_never_sanitized_html(self):
        raw = json.dumps({"type": "nexus-board", "version": 1, "look": "sketch", "elements": [
            {"id": "a", "type": "text", "text": "<b>bold</b> & <script>x</script>", "version": 1}],
            "appState": {}, "files": {}}, indent=2)
        n = self.board(scene=raw)
        s = json.loads(n["scene"])
        self.assertEqual(s["elements"][0]["text"], "<b>bold</b> & <script>x</script>")
        self.assertNotIn("\n", n["scene"])
        self.assertEqual(n["preview"], "<b>bold</b> & <script>x</script>")

    # ── saving ─────────────────────────────────────────────────────────────
    def test_owner_saves_the_scene_and_the_live_state_drops(self):
        n = self.board(scene=scene("One"))
        self.db.query(models.NexusNote).update({"ydoc": "AAEC", "yepoch": "epoch-000001"})
        self.db.commit()
        r = self.patch(n, scene=scene("One", "Two"))
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["rev"], 2)
        self.assertEqual(len(json.loads(out["scene"])["elements"]), 2)
        self.assertEqual(out["preview"], "One\nTwo")
        row = self.db.query(models.NexusNote).filter_by(id=n["id"]).first()
        self.db.refresh(row)
        self.assertEqual((row.ydoc, row.yepoch), ("", ""))

    def test_a_live_save_keeps_the_state(self):
        n = self.board(scene=scene("One"))
        self.db.query(models.NexusNote).update({"yepoch": "epoch-000001"})
        self.db.commit()
        r = self.patch(n, scene=scene("One", "Two"), ydoc="AAEC", yepoch="epoch-000001")
        self.assertEqual(r.status_code, 200, r.text)
        row = self.db.query(models.NexusNote).filter_by(id=n["id"]).first()
        self.db.refresh(row)
        self.assertEqual((row.ydoc, row.yepoch), ("AAEC", "epoch-000001"))

    def test_edit_share_saves_read_share_and_strangers_cannot(self):
        n = self.board(scene=scene("One"))
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        self.client.put(f"/notes/{n['id']}/share", json={"email": CAT, "can": "read"})
        n = self.client.get(f"/notes/{n['id']}").json()
        self.as_(BOB)
        r = self.patch(n, scene=scene("One", "Bob"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["preview"], "One\nBob")
        n = r.json()
        self.as_(CAT)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").json()["scene"], n["scene"])
        self.assertEqual(self.patch(n, scene=scene("Cat")).status_code, 403)
        self.assertEqual(self.patch(n, thumbUrl=OWN).status_code, 403)
        self.as_("stranger@greensglobal.com")
        self.assertEqual(self.patch(n, scene=scene("X")).status_code, 404)

    def test_too_large_or_not_a_board_is_refused(self):
        n = self.board(scene=scene("One"))
        big = scene(*(["x" * 1000] * 2100))
        self.assertGreater(len(big), notes.SCENE_MAX)
        r = self.patch(n, scene=big)
        self.assertEqual(r.status_code, 413)
        self.assertIn("board", r.json()["detail"].lower())
        for bad in ("not json", json.dumps({"type": "other"}), json.dumps([1, 2]), json.dumps({"type": "nexus-board", "elements": "no"})):
            self.assertEqual(self.patch(n, scene=bad).status_code, 400, bad)
        self.assertEqual(self.client.post("/notes", json={"kind": "board", "scene": "{"}).status_code, 400)
        # The last good scene stays.
        self.assertEqual(self.client.get(f"/notes/{n['id']}").json()["preview"], "One")

    def test_a_plain_note_or_a_daily_never_takes_a_scene(self):
        n = self.client.post("/notes", json={"title": "Plan", "body": "<p>Hello</p>", "day": TODAY}).json()
        self.assertEqual(n["kind"], "note")
        self.assertEqual(n["scene"], "")
        self.assertEqual(self.patch(n, scene=scene("x")).status_code, 400)
        d = self.client.post("/notes", json={"kind": "daily", "day": TODAY, "scene": scene("x")}).json()
        self.assertEqual(d["kind"], "daily")
        self.assertEqual(d["scene"], "")
        # A board takes no body.
        b = self.board(body="<p>words</p>", scene=scene("One"))
        self.assertEqual(b["body"], "")
        self.assertEqual(self.patch(b, body="<p>x</p>").status_code, 400)

    # ── thumbnail and source ───────────────────────────────────────────────
    def test_thumbnail_must_be_our_storage(self):
        n = self.board(scene=scene("One"))
        r = self.patch(n, thumbUrl=OWN)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["thumbUrl"], OWN)
        self.assertEqual(self.client.get("/notes").json()["notes"][0]["thumbUrl"], OWN)
        n = r.json()
        self.assertEqual(self.patch(n, thumbUrl="https://evil.example/x.png").status_code, 400)
        r = self.patch(n, thumbUrl="")
        self.assertEqual(r.json()["thumbUrl"], "")
        # A thumbnail is not a change to the drawing: no new rev snapshot, no words change.
        self.assertEqual(r.json()["preview"], "One")

    def test_source_says_where_a_mark_up_came_from(self):
        src = {"kind": "ticket", "id": "tk_1", "label": "Screenshot on #42", "url": "/tickets?ticket=tk_1"}
        n = self.board(title="Mark Up: Screenshot on #42", scene=scene("One"), source=src)
        self.assertEqual(n["source"], src)
        self.assertEqual(self.client.get("/notes").json()["notes"][0]["source"]["kind"], "ticket")
        for bad in ({"kind": "email", "id": "1", "label": "x"}, {"kind": "task", "label": "x"},
                    {"kind": "task", "id": "1", "label": "x" * 201},
                    {"kind": "task", "id": "1", "label": "x", "url": "https://evil.example/"}):
            self.assertEqual(self.client.post("/notes", json={"kind": "board", "source": bad}).status_code, 400, bad)
        r = self.patch(n, source={"kind": "file", "id": "f1", "label": "plan.pdf", "url": OWN})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["source"]["url"], OWN)
        r = self.patch(r.json(), source=None)
        self.assertEqual(r.json()["source"]["kind"], "file")    # None leaves it; {} clears it
        r = self.patch(r.json(), source={})
        self.assertIsNone(r.json()["source"])

    # ── versions and collab ────────────────────────────────────────────────
    def test_versions_keep_the_scene_and_restore_puts_it_back(self):
        n = self.board(scene=scene("One"))
        n = self.patch(n, scene=scene("One", "Two")).json()
        vs = self.client.get(f"/notes/{n['id']}/versions").json()
        self.assertEqual(len(vs), 1)
        self.assertNotIn("scene", vs[0])     # the list is light; one version carries the drawing
        full = self.client.get(f"/notes/{n['id']}/versions/{vs[0]['id']}").json()
        self.assertEqual(json.loads(full["scene"])["elements"][0]["text"], "One")
        self.assertEqual((vs[0]["words"], vs[0]["shapes"]), (1, 1))
        old = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
        self.db.query(models.NexusNoteVersion).update({"created_at": old})
        self.db.commit()
        n = self.patch(n, scene=scene("Three")).json()
        vs = self.client.get(f"/notes/{n['id']}/versions").json()
        self.assertEqual([v["shapes"] for v in vs], [2, 1])
        r = self.client.post(f"/notes/{n['id']}/versions/{vs[1]['id']}/restore")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["preview"], "One")
        self.assertEqual(json.loads(r.json()["scene"])["elements"][0]["text"], "One")

    def test_collab_carries_the_scene_and_the_first_editor_seeds(self):
        n = self.board(scene=scene("One"))
        c = self.client.get(f"/notes/{n['id']}/collab").json()
        self.assertEqual(c["kind"], "board")
        self.assertEqual(c["scene"], n["scene"])
        self.assertEqual(c["ydoc"], "")
        r = self.client.post(f"/notes/{n['id']}/collab/seed", json={"rev": n["rev"], "ydoc": "AAEC", "yepoch": "epoch-000001"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get(f"/notes/{n['id']}/collab").json()["yepoch"], "epoch-000001")
        # A plain note's collab answer is as before: no scene.
        p = self.client.post("/notes", json={"title": "Plan", "body": "<p>Hello</p>", "day": TODAY}).json()
        c2 = self.client.get(f"/notes/{p['id']}/collab").json()
        self.assertEqual(c2["kind"], "note")
        self.assertNotIn("scene", c2)

    def test_trash_restore_and_delete_forever_work_for_boards(self):
        n = self.board(scene=scene("One"))
        self.assertTrue(self.client.post(f"/notes/{n['id']}/trash").json()["trashedAt"])
        self.assertEqual(self.client.get("/notes?view=trash").json()["notes"][0]["kind"], "board")
        self.assertEqual(self.client.post(f"/notes/{n['id']}/restore").json()["trashedAt"], "")
        self.client.post(f"/notes/{n['id']}/trash")
        self.assertEqual(self.client.delete(f"/notes/{n['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)

    def test_notes_and_the_daily_scratchpad_are_unchanged(self):
        n = self.client.post("/notes", json={"title": "Plan", "body": "<p>Hello <b>x</b></p>", "day": TODAY}).json()
        self.assertEqual(n["body"], "<p>Hello <b>x</b></p>")
        self.assertEqual(n["preview"], "Hello x")
        r = self.client.post("/notes/daily/append", json={"day": TODAY, "text": "[ ] call Bob"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn('data-type="taskItem"', r.json()["body"])
        self.assertEqual(r.json()["kind"], "daily")

    # ── review fix pass (11/02/2026) ───────────────────────────────────────
    def row(self, note_id):
        r = self.db.query(models.NexusNote).filter_by(id=note_id).first()
        self.db.refresh(r)
        return r

    def test_an_empty_body_on_a_board_is_a_no_op(self):
        n = self.board(scene=scene("One"))
        r = self.patch(n, body="", scene=scene("One", "Two"))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["body"], "")
        self.assertEqual(r.json()["preview"], "One\nTwo")
        r = self.patch(r.json(), body="")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["rev"], 2)          # nothing said: the rev stays
        self.assertEqual(self.patch(r.json(), body="<p>words</p>").status_code, 400)

    def test_a_thumbnail_or_a_source_alone_never_moves_the_rev(self):
        n = self.board(scene=scene("One"))
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        n = self.client.get(f"/notes/{n['id']}").json()
        before = self.row(n["id"])
        rev, at, by = before.rev, before.updated_at, before.updated_by
        self.as_(BOB)
        r = self.patch(n, thumbUrl=OWN)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["rev"], rev)
        r = self.patch(n, source={"kind": "task", "id": "t1", "label": "Photo", "url": "/tasks?task=t1"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["rev"], rev)
        after = self.row(n["id"])
        self.assertEqual((after.rev, after.updated_at, after.updated_by), (rev, at, by))
        self.assertEqual(after.thumb_url, OWN)
        # Amy's save from the same rev is not refused for Bob's picture.
        self.as_(AMY)
        self.assertEqual(self.patch(n, scene=scene("One", "Two")).status_code, 200)

    def test_moving_the_view_is_stored_but_is_never_content(self):
        n = self.board(scene=scene("One"))
        self.db.query(models.NexusNote).update({"ydoc": "AAEC", "yepoch": "epoch-000001"})
        self.db.commit()
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        n = self.client.get(f"/notes/{n['id']}").json()
        rev = n["rev"]
        self.as_(BOB)
        moved = json.loads(scene("One"))
        moved["appState"].update({"scrollX": 400, "scrollY": -120, "zoom": {"value": 2}})
        r = self.patch(n, scene=json.dumps(moved))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["rev"], rev)
        self.assertEqual(json.loads(r.json()["scene"])["appState"]["scrollX"], 400)   # still stored
        row = self.row(n["id"])
        self.assertEqual((row.ydoc, row.yepoch), ("AAEC", "epoch-000001"))     # live state kept
        self.assertEqual(self.db.query(models.NexusNoteVersion).count(), 0)    # no snapshot
        self.as_(AMY)
        self.assertFalse(self.client.get("/notes").json()["notes"][0]["unseen"])   # no Updated dot
        # A new shape, a new picture or a new look is content.
        self.as_(BOB)
        n = r.json()
        n = self.patch(n, scene=scene("One", "Two")).json()
        self.assertEqual(n["rev"], rev + 1)
        pic = json.loads(n["scene"])
        pic["files"] = {"f1": {"id": "f1", "mimeType": "image/png", "url": OWN, "created": 1}}
        n2 = self.patch(n, scene=json.dumps(pic)).json()
        self.assertEqual(n2["rev"], rev + 2)
        pic["look"] = "sketch"
        self.assertEqual(self.patch(n2, scene=json.dumps(pic)).json()["rev"], rev + 3)
        self.as_(AMY)
        self.assertTrue(self.client.get("/notes").json()["notes"][0]["unseen"])

    def test_a_source_link_is_a_nexus_page_never_another_site(self):
        ok = ("/tickets?ticket=tk_1", "/tasks/t1", "/notes", "/dashboard#notes", "/support?x=1")
        bad = ("//evil.com", "//evil.com/x", "/\\evil.com", "/%2F%2Fevil.com", "/tickets/%2f%2fevil.com",
               "/tickets%5Cx", "/elsewhere", "/ticketsx", "https://evil.com/")
        for url in ok:
            r = self.client.post("/notes", json={"kind": "board", "source": {"kind": "task", "id": "1", "label": "x", "url": url}})
            self.assertEqual(r.status_code, 201, url)
        for url in bad:
            r = self.client.post("/notes", json={"kind": "board", "source": {"kind": "task", "id": "1", "label": "x", "url": url}})
            self.assertEqual(r.status_code, 400, url)

    def test_a_kept_version_list_carries_counts_and_one_version_carries_the_scene(self):
        n = self.board(scene=scene("One", "Two"))
        n = self.patch(n, scene=scene("Three")).json()
        vs = self.client.get(f"/notes/{n['id']}/versions").json()
        self.assertEqual(len(vs), 1)
        self.assertNotIn("scene", vs[0])
        self.assertEqual((vs[0]["shapes"], vs[0]["words"]), (2, 2))
        r = self.client.get(f"/notes/{n['id']}/versions/{vs[0]['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        one = r.json()
        self.assertEqual(one["id"], vs[0]["id"])
        self.assertEqual(one["shapes"], 2)
        self.assertEqual([e["text"] for e in json.loads(one["scene"])["elements"]], ["One", "Two"])
        self.assertEqual(self.client.get(f"/notes/{n['id']}/versions/nv_missing").status_code, 404)
        # The list's access rule: a Can View share reads it, a stranger gets 404.
        self.client.put(f"/notes/{n['id']}/share", json={"email": CAT, "can": "read"})
        self.as_(CAT)
        self.assertEqual(self.client.get(f"/notes/{n['id']}/versions/{vs[0]['id']}").status_code, 200)
        self.as_("stranger@greensglobal.com")
        self.assertEqual(self.client.get(f"/notes/{n['id']}/versions/{vs[0]['id']}").status_code, 404)
        # A version of another note is not found through this one.
        self.as_(AMY)
        other = self.board(scene=scene("X"))
        self.assertEqual(self.client.get(f"/notes/{other['id']}/versions/{vs[0]['id']}").status_code, 404)
        # A plain note's version carries no board fields.
        p = self.client.post("/notes", json={"title": "Plan", "body": "<p>Hello</p>", "day": TODAY}).json()
        self.patch(p, body="<p>Hello again</p>")
        pv = self.client.get(f"/notes/{p['id']}/versions").json()[0]
        self.assertNotIn("shapes", pv)
        self.assertNotIn("scene", self.client.get(f"/notes/{p['id']}/versions/{pv['id']}").json())

    def test_an_empty_scene_resets_the_board(self):
        n = self.board(scene=scene("One", look="sketch"))
        r = self.patch(n, scene="")
        self.assertEqual(r.status_code, 200, r.text)
        s = json.loads(r.json()["scene"])
        self.assertEqual((s["type"], s["elements"], s["look"]), ("nexus-board", [], "clean"))
        self.assertEqual(r.json()["preview"], "")

    def test_a_thumbnail_is_a_board_s_alone(self):
        p = self.client.post("/notes", json={"title": "Plan", "body": "<p>Hello</p>", "day": TODAY}).json()
        r = self.patch(p, thumbUrl=OWN)
        self.assertEqual(r.status_code, 400)
        self.assertIn("board", r.json()["detail"].lower())

    def test_a_picture_stored_inline_is_refused(self):
        n = self.board(scene=scene("One"))
        for f in ({"id": "f1", "mimeType": "image/png", "url": "data:image/png;base64,AAAA"},
                  {"id": "f1", "mimeType": "image/png", "url": " DATA:image/png;base64,AAAA"},
                  {"id": "f1", "mimeType": "image/png", "url": OWN, "dataURL": "data:image/png;base64,AAAA"}):
            raw = scene("One", extra={"files": {"f1": f}})
            r = self.patch(n, scene=raw)
            self.assertEqual(r.status_code, 400, f)
            self.assertEqual(r.json()["detail"], "Pictures on a board must be stored files")
            self.assertEqual(self.client.post("/notes", json={"kind": "board", "scene": raw}).status_code, 400)
        ok = self.patch(n, scene=scene("One", extra={"files": {"f1": {"id": "f1", "mimeType": "image/png", "url": OWN}}}))
        self.assertEqual(ok.status_code, 200, ok.text)

    def test_the_scene_is_parsed_once_per_save(self):
        n = self.board(scene=scene("One"))
        real = notes._parse_scene
        with mock.patch.object(notes, "_parse_scene", side_effect=real) as spy:
            self.assertEqual(self.patch(n, scene=scene("One", "Two")).status_code, 200)
        self.assertEqual(spy.call_count, 1)


if __name__ == "__main__":
    unittest.main()
