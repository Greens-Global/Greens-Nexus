"""Notes (Dashboard > Notes, Neil Oct 29 2026) - routers/notes.py.

  - Only the owner and the people a note is shared with read it; anyone else
    gets 404. A read share cannot save; an edit share saves title and body
    but not pin / color / tags / day; a trashed note is the owner's alone.
  - Saves carry the rev they were read with: a stale rev is 409 with the
    server copy.
  - The body is sanitized: scripts and handlers go, checklists, mentions and
    alignment stay.
  - List views and counts (all / pinned / today / shared / trash), month,
    tag and search filters.
  - The daily scratchpad: one per owner and day, append makes it on the first
    line and adds a '[ ]' line as a checklist item.
  - Trash, restore, delete forever only from the Trash and only by the owner.
  - Share only with Nexus People, one bell; Leave; versions and restore.

Uses a throwaway sqlite file.

Run with: python -m pytest test_notes.py   (one file per process - CLAUDE.md)
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
DEE = "dee@greensglobal.com"
OUTSIDER = "someone@example.com"     # not in Nexus People
TODAY = "2026-10-29"


class NotesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        db = database.SessionLocal()
        for email, first in ((AMY, "Amy"), (BOB, "Bob"), (CAT, "Cat"), (DEE, "Dee")):
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

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def as_(self, email):
        self.user = {"email": email, "name": email.split("@")[0].title(), "role": "employee", "level": 1}

    def make(self, **kw):
        kw.setdefault("title", "Plan")
        kw.setdefault("body", "<p>Hello</p>")
        kw.setdefault("day", TODAY)
        r = self.client.post("/notes", json=kw)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    # ── access ─────────────────────────────────────────────────────────────
    def test_private_to_owner(self):
        n = self.make()
        self.as_(BOB)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)
        self.assertEqual(self.client.patch(f"/notes/{n['id']}", json={"rev": 1, "title": "x"}).status_code, 404)
        self.assertEqual(self.client.get("/notes").json()["notes"], [])

    def test_read_share_reads_but_cannot_save(self):
        n = self.make()
        r = self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "read"})
        self.assertEqual(r.status_code, 200, r.text)
        self.as_(BOB)
        got = self.client.get(f"/notes/{n['id']}").json()
        self.assertEqual(got["can"], "read")
        self.assertFalse(got["mine"])
        self.assertEqual([s["email"] for s in got["sharedWith"]], [BOB])   # never the whole list
        self.assertEqual(self.client.patch(f"/notes/{n['id']}", json={"rev": got["rev"], "body": "x"}).status_code, 403)
        self.as_(CAT)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)

    def test_edit_share_saves_body_not_owner_fields(self):
        n = self.make()
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        self.as_(BOB)
        rev = self.client.get(f"/notes/{n['id']}").json()["rev"]
        r = self.client.patch(f"/notes/{n['id']}", json={"rev": rev, "body": "<p>Bob was here</p>"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["updatedBy"], BOB)
        r = self.client.patch(f"/notes/{n['id']}", json={"rev": r.json()["rev"], "pinned": True})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.client.post(f"/notes/{n['id']}/trash").status_code, 403)

    def test_trashed_note_hidden_from_share(self):
        n = self.make()
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        self.client.post(f"/notes/{n['id']}/trash")
        self.as_(BOB)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)
        self.assertEqual(self.client.get("/notes?view=shared").json()["notes"], [])

    # ── concurrency ────────────────────────────────────────────────────────
    def test_stale_rev_is_409_with_server_copy(self):
        n = self.make()
        r1 = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>First</p>"})
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["rev"], n["rev"] + 1)
        r2 = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Second</p>"})
        self.assertEqual(r2.status_code, 409)
        detail = r2.json()["detail"]
        self.assertIn("First", detail["note"]["body"])
        self.assertEqual(detail["note"]["rev"], r1.json()["rev"])

    # ── sanitizer ──────────────────────────────────────────────────────────
    def test_body_sanitized_keeps_editor_markup(self):
        body = ('<p style="text-align: center" onclick="x()">Hi<script>alert(1)</script></p>'
                '<ul data-type="taskList"><li data-type="taskItem" data-checked="true">'
                '<label><input type="checkbox" checked><span></span></label><div><p>Done</p></div></li></ul>'
                '<p><span data-type="mention" data-id="bob@greensglobal.com" data-label="Bob">@Bob</span>'
                ' <a href="javascript:alert(1)">bad</a> <a href="https://greensglobal.com">good</a></p>'
                '<img src="https://evil.example/x.png"><p style="color:red">Red</p>')
        with mock.patch.object(notes, "_own_image", lambda src: "greensglobal" in src):
            n = self.make(body=body)
        out = n["body"]
        self.assertNotIn("script", out)
        self.assertNotIn("onclick", out)
        self.assertNotIn("javascript", out)
        self.assertNotIn("evil.example", out)
        self.assertNotIn("color:red", out)
        self.assertNotIn("<input", out)
        self.assertIn('style="text-align: center"', out)
        self.assertIn('data-type="taskItem" data-checked="true"', out)
        self.assertIn('data-type="mention" data-id="bob@greensglobal.com" data-label="Bob"', out)
        self.assertIn('href="https://greensglobal.com"', out)
        self.assertIn("Done", out)

    def test_voice_notes_and_videos_kept_only_from_our_storage(self):
        own = "https://store.supabase.co/storage/v1/object/public/task-files/notes/1-a.webm"
        body = (f'<p>Before</p><audio src="{own}" controls autoplay onplay="x()"><source src="https://evil.example/a.mp3">'
                'Your browser cannot play this</audio>'
                f'<video src="{own.replace(".webm", ".mp4")}" controls playsinline loop></video>'
                '<audio src="https://evil.example/b.mp3" controls></audio>'
                '<video src="javascript:alert(1)"></video><p>After</p>')
        with mock.patch.object(notes, "_own_image", lambda src: src.startswith("https://store.supabase.co/")):
            out = self.make(body=body)["body"]
        self.assertIn(f'<audio src="{own}" controls preload="metadata"></audio>', out)
        self.assertIn('<video src="https://store.supabase.co/storage/v1/object/public/task-files/notes/1-a.mp4" '
                      'controls playsinline preload="metadata"></video>', out)
        for bad in ("evil.example", "javascript", "autoplay", "onplay", "loop", "<source", "cannot play"):
            self.assertNotIn(bad, out)
        self.assertEqual(out.count("<audio"), 1)
        self.assertEqual(out.count("<video"), 1)
        self.assertTrue(out.startswith("<p>Before</p>") and out.endswith("<p>After</p>"))
        # An unclosed player does not swallow what follows it.
        with mock.patch.object(notes, "_own_image", lambda src: True):
            tail = self.make(body=f'<audio src="{own}"><p>Still here</p>')["body"]
        self.assertIn("<p>Still here</p>", tail)
        # A player is not words: the preview and search skip it.
        self.assertEqual(notes.plain_text(out), "Before\nAfter")

    def test_plain_text_becomes_paragraphs(self):
        n = self.make(body="one\ntwo & three")
        self.assertEqual(n["body"], "<p>one</p><p>two &amp; three</p>")

    # ── list ───────────────────────────────────────────────────────────────
    def test_list_views_counts_and_filters(self):
        a = self.make(title="Budget review", body="<p>Quarterly numbers</p>", tags=["Finance", "finance", "#Q4"])
        self.make(title="Old", day="2026-09-10", pinned=True)
        t = self.make(title="Trash me")
        self.client.post(f"/notes/{t['id']}/trash")
        self.as_(BOB)
        b = self.make(title="Bob shares")
        self.client.put(f"/notes/{b['id']}/share", json={"email": AMY})
        self.as_(AMY)
        r = self.client.get(f"/notes?today={TODAY}").json()
        self.assertEqual(r["counts"], {"all": 3, "pinned": 1, "today": 2, "shared": 1, "trash": 1})
        self.assertEqual(r["tags"], ["Finance", "Q4"])
        self.assertEqual(a["tags"], ["Finance", "Q4"])
        titles = lambda q: sorted(n["title"] for n in self.client.get(f"/notes?{q}").json()["notes"])   # noqa: E731
        self.assertEqual(titles("view=pinned"), ["Old"])
        self.assertEqual(titles("view=shared"), ["Bob shares"])
        self.assertEqual(titles("view=trash"), ["Trash me"])
        self.assertEqual(titles(f"view=today&today={TODAY}"), ["Bob shares", "Budget review"])
        self.assertEqual(titles("month=2026-09"), ["Old"])
        self.assertEqual(titles("tag=finance"), ["Budget review"])
        self.assertEqual(titles("q=quarterly+budget"), ["Budget review"])
        self.assertEqual(self.client.get("/notes?month=2026/09").status_code, 400)

    # ── daily ──────────────────────────────────────────────────────────────
    def test_daily_append_and_one_per_day(self):
        self.assertIsNone(self.client.get(f"/notes/daily?day={TODAY}").json()["note"])
        r = self.client.post("/notes/daily/append", json={"day": TODAY, "text": "Call the plumber"})
        self.assertEqual(r.status_code, 200, r.text)
        first = r.json()
        self.assertEqual(first["kind"], "daily")
        r = self.client.post("/notes/daily/append", json={"day": TODAY, "text": "[ ] Order <filters>"})
        n = r.json()
        self.assertEqual(n["id"], first["id"])
        self.assertGreater(n["rev"], first["rev"])     # an editor holding the old rev must not overwrite it
        self.assertIn("<p>Call the plumber</p>", n["body"])
        self.assertIn('data-checked="false"><p>Order &lt;filters&gt;</p>', n["body"])
        again = self.client.post("/notes", json={"kind": "daily", "day": TODAY}).json()
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(self.client.get(f"/notes/daily?day={TODAY}").json()["note"]["id"], first["id"])

    def test_append_bumps_rev_of_untouched_daily(self):
        made = self.client.post("/notes", json={"kind": "daily", "day": TODAY}).json()
        n = self.client.post("/notes/daily/append", json={"day": TODAY, "text": "x"}).json()
        self.assertEqual(n["rev"], made["rev"] + 1)

    # ── trash / delete ─────────────────────────────────────────────────────
    def test_delete_forever_only_from_trash(self):
        n = self.make()
        self.assertEqual(self.client.delete(f"/notes/{n['id']}").status_code, 409)
        self.client.post(f"/notes/{n['id']}/trash")
        self.assertEqual(self.client.patch(f"/notes/{n['id']}", json={"rev": 99, "body": "x"}).status_code, 409)
        r = self.client.post(f"/notes/{n['id']}/restore")
        self.assertEqual(r.json()["trashedAt"], "")
        self.client.post(f"/notes/{n['id']}/trash")
        self.as_(BOB)
        self.assertEqual(self.client.delete(f"/notes/{n['id']}").status_code, 404)
        self.as_(AMY)
        self.assertEqual(self.client.delete(f"/notes/{n['id']}").status_code, 204)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)

    # ── sharing ────────────────────────────────────────────────────────────
    def test_share_only_nexus_people_one_bell(self):
        n = self.make(title="Launch")
        self.assertEqual(self.client.put(f"/notes/{n['id']}/share", json={"email": OUTSIDER}).status_code, 400)
        self.assertEqual(self.client.put(f"/notes/{n['id']}/share", json={"email": AMY}).status_code, 400)
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "read"})
        r = self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        self.assertEqual(r.json()["sharedWith"], [{"email": BOB, "can": "edit"}])
        bells = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == BOB).all()
        self.assertEqual(len(bells), 1)
        self.assertEqual(json.loads(bells[0].action), {"view": "dashboard", "sub": f"notes:{n['id']}"})
        self.assertIn("Launch", bells[0].body)

    def test_unshare_and_leave(self):
        n = self.make()
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB})
        self.client.put(f"/notes/{n['id']}/share", json={"email": CAT})
        self.as_(BOB)
        self.assertEqual(self.client.delete(f"/notes/{n['id']}/share/{CAT}").status_code, 403)
        self.assertEqual(self.client.delete(f"/notes/{n['id']}/share/{BOB}").status_code, 200)
        self.assertEqual(self.client.get(f"/notes/{n['id']}").status_code, 404)
        self.as_(AMY)
        r = self.client.delete(f"/notes/{n['id']}/share/{CAT}")
        self.assertEqual(r.json()["sharedWith"], [])

    # ── versions ───────────────────────────────────────────────────────────
    def test_versions_kept_and_restored(self):
        n = self.make(body="<p>Version one</p>")
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Version two</p>"}).json()
        # A second save inside ten minutes keeps no new copy.
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Version three</p>"}).json()
        vs = self.client.get(f"/notes/{n['id']}/versions").json()
        self.assertEqual([v["body"] for v in vs], ["<p>Version one</p>"])
        # Once the newest copy is old, the next save keeps another.
        old = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
        self.db.query(models.NexusNoteVersion).update({"created_at": old})
        self.db.commit()
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Version four</p>"}).json()
        vs = self.client.get(f"/notes/{n['id']}/versions").json()
        self.assertEqual([v["body"] for v in vs], ["<p>Version three</p>", "<p>Version one</p>"])
        r = self.client.post(f"/notes/{n['id']}/versions/{vs[1]['id']}/restore")
        self.assertEqual(r.json()["body"], "<p>Version one</p>")
        bodies = [v["body"] for v in self.client.get(f"/notes/{n['id']}/versions").json()]
        self.assertIn("<p>Version four</p>", bodies)      # the note as it stood was kept first

    def test_versions_thin_by_age_never_by_count(self):
        n = self.make(body="<p>0</p>")
        now = datetime.now(timezone.utc)
        ages = [timedelta(minutes=m) for m in range(5, 200, 5)]                    # 39 copies today: all kept
        ages += [timedelta(days=2, minutes=m) for m in (0, 10, 20, 70)]           # two hours, two days ago
        ages += [timedelta(days=30, hours=h) for h in (0, 3, 30)]                  # two days, a month ago
        for i, age in enumerate(ages):
            self.db.add(models.NexusNoteVersion(id=f"nv_t{i}", note_id=n["id"], title="", body=f"<p>{i}</p>",
                                                rev=1, saved_by=AMY, created_at=(now - age).isoformat()))
        self.db.commit()
        notes._thin_versions(self.db, n["id"])
        self.db.commit()
        left = self.db.query(models.NexusNoteVersion).filter(models.NexusNoteVersion.note_id == n["id"]).all()
        recent = [v for v in left if now - datetime.fromisoformat(v.created_at) < notes.KEEP_ALL]
        self.assertEqual(len(recent), 39)                                         # far past the old cap of 50 overall
        mid = [v for v in left if notes.KEEP_ALL <= now - datetime.fromisoformat(v.created_at) < notes.KEEP_HOURLY]
        self.assertEqual(len(mid), len({datetime.fromisoformat(v.created_at).strftime("%Y-%m-%dT%H") for v in mid}))
        self.assertLessEqual(len(mid), 3)
        old = [v for v in left if now - datetime.fromisoformat(v.created_at) >= notes.KEEP_HOURLY]
        self.assertEqual(len(old), len({datetime.fromisoformat(v.created_at).strftime("%Y-%m-%d") for v in old}))
        self.assertGreaterEqual(len(old), 1)                                      # the oldest history is never all gone

    def test_copy_is_named_for_whoever_wrote_the_words_not_who_shared(self):
        n = self.shared()
        self.as_(BOB)
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Bob wrote</p>"}).json()
        self.as_(AMY)
        n = self.client.put(f"/notes/{n['id']}/share", json={"email": CAT, "can": "read"}).json()   # sets updated_by = Amy
        old = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        self.db.query(models.NexusNoteVersion).update({"created_at": old})
        self.db.commit()
        self.as_(BOB)
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Bob again</p>"}).json()
        newest = self.client.get(f"/notes/{n['id']}/versions").json()[0]
        self.assertEqual((newest["body"], newest["savedBy"]), ("<p>Bob wrote</p>", BOB))


    # ── working together (Oct 30 2026) ─────────────────────────────────────
    def shared(self, can="edit", body="<p>Amy wrote this</p>"):
        n = self.make(body=body)
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": can})
        return self.client.get(f"/notes/{n['id']}").json()

    def test_a_new_author_keeps_the_previous_words_under_their_name(self):
        n = self.shared()
        self.as_(BOB)
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Bob changed it</p>"}).json()
        vs = self.client.get(f"/notes/{n['id']}/versions").json()
        self.assertEqual([(v["body"], v["savedBy"]) for v in vs], [("<p>Amy wrote this</p>", AMY)])
        # Bob again, minutes later: no new copy.
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Bob again</p>"}).json()
        self.assertEqual(len(self.client.get(f"/notes/{n['id']}/versions").json()), 1)
        # Amy straight back (co-typing turns): no copy at every turn.
        self.as_(AMY)
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Amy back</p>"}).json()
        self.assertEqual(len(self.client.get(f"/notes/{n['id']}/versions").json()), 1)
        # Bob takes over a few minutes later: Amy's words are kept under Amy's name.
        old = (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat()
        self.db.query(models.NexusNoteVersion).update({"created_at": old})
        self.db.commit()
        self.as_(BOB)
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Bob later</p>"}).json()
        vs = self.client.get(f"/notes/{n['id']}/versions").json()
        self.assertEqual([(v["body"], v["savedBy"]) for v in vs][0], ("<p>Amy back</p>", AMY))

    def test_updated_dot_for_someone_elses_change_until_opened(self):
        n = self.shared()
        self.as_(BOB)
        row = lambda: next(x for x in self.client.get("/notes").json()["notes"] if x["id"] == n["id"])  # noqa: E731
        self.assertTrue(row()["unseen"])                         # new to Bob
        self.client.get(f"/notes/{n['id']}")
        self.assertFalse(row()["unseen"])
        self.as_(AMY)
        n2 = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>More</p>"}).json()
        self.assertFalse(next(x for x in self.client.get("/notes").json()["notes"] if x["id"] == n["id"])["unseen"])
        self.assertEqual(n2["editedBy"], AMY)
        self.as_(BOB)
        self.assertTrue(row()["unseen"])
        # A change that is not to the words (Amy pins it) raises no dot.
        self.client.get(f"/notes/{n['id']}")
        self.as_(AMY)
        self.client.patch(f"/notes/{n['id']}", json={"rev": n2["rev"], "pinned": True})
        self.as_(BOB)
        self.assertFalse(row()["unseen"])

    def test_presence_shows_others_and_expires(self):
        n = self.shared()
        self.client.put(f"/notes/{n['id']}/share", json={"email": CAT, "can": "read"})
        self.as_(BOB)
        self.client.post(f"/notes/{n['id']}/presence", json={"state": "editing"})
        self.as_(CAT)
        r = self.client.post(f"/notes/{n['id']}/presence", json={"state": "editing"}).json()
        self.assertEqual(r["people"], [{"email": BOB, "state": "editing"}])
        self.as_(AMY)
        r = self.client.post(f"/notes/{n['id']}/presence", json={"state": "viewing"}).json()
        self.assertEqual(sorted((p["email"], p["state"]) for p in r["people"]),
                         [(BOB, "editing"), (CAT, "viewing")])           # read-only is only ever viewing
        self.assertEqual(r["rev"], self.client.get(f"/notes/{n['id']}").json()["rev"])
        old = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
        self.db.query(models.NexusNotePresence).filter(models.NexusNotePresence.email == BOB).update({"at": old})
        self.db.commit()
        r = self.client.post(f"/notes/{n['id']}/presence", json={}).json()
        self.assertEqual([p["email"] for p in r["people"]], [CAT])
        self.as_("dan@greensglobal.com")
        self.assertEqual(self.client.post(f"/notes/{n['id']}/presence", json={}).status_code, 404)

    def test_a_reader_sees_only_the_owner_and_editors_here(self):
        n = self.shared()                                          # Bob can edit
        for who in (CAT, DEE):
            self.client.put(f"/notes/{n['id']}/share", json={"email": who, "can": "read"})
        for who, state in ((AMY, "viewing"), (BOB, "editing"), (DEE, "viewing")):
            self.as_(who)
            self.client.post(f"/notes/{n['id']}/presence", json={"state": state})
        self.as_(CAT)
        r = self.client.post(f"/notes/{n['id']}/presence", json={}).json()
        self.assertEqual(sorted(p["email"] for p in r["people"]), [AMY, BOB])     # never the other reader
        self.as_(BOB)
        r = self.client.post(f"/notes/{n['id']}/presence", json={"state": "editing"}).json()
        self.assertEqual(sorted(p["email"] for p in r["people"]), [AMY, CAT, DEE])

    def test_collab_key_editors_only_and_rotated_when_an_editor_goes(self):
        n = self.shared()
        self.client.put(f"/notes/{n['id']}/share", json={"email": CAT, "can": "edit"})
        k1 = self.client.get(f"/notes/{n['id']}/collab").json()
        self.assertEqual(len(k1["key"]), 44)                       # 32 bytes, base64
        self.assertTrue(k1["channel"].startswith("nx-note-"))
        self.assertNotIn(n["id"], k1["channel"])
        self.as_(BOB)
        self.assertEqual(self.client.get(f"/notes/{n['id']}/collab").json()["key"], k1["key"])
        self.as_("dan@greensglobal.com")
        self.assertEqual(self.client.get(f"/notes/{n['id']}/collab").status_code, 404)
        self.as_(AMY)
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "read"})     # made read-only
        self.as_(BOB)
        self.assertEqual(self.client.get(f"/notes/{n['id']}/collab").status_code, 403)
        self.as_(AMY)
        k2 = self.client.get(f"/notes/{n['id']}/collab").json()
        self.assertNotEqual(k2["key"], k1["key"])
        self.assertNotEqual(k2["channel"], k1["channel"])
        tag = self.client.post(f"/notes/{n['id']}/presence", json={}).json()["keyTag"]
        self.assertEqual(tag, k2["keyTag"])
        self.client.delete(f"/notes/{n['id']}/share/{CAT}")                                # an editor removed
        self.assertNotEqual(self.client.get(f"/notes/{n['id']}/collab").json()["key"], k2["key"])
        # Live sessions learn the key moved on from the heartbeat; a reader is never told.
        self.assertNotEqual(self.client.post(f"/notes/{n['id']}/presence", json={}).json()["keyTag"], tag)
        self.as_(BOB)
        self.assertNotIn("keyTag", self.client.post(f"/notes/{n['id']}/presence", json={}).json())

    def test_seed_once_then_saves_carry_the_epoch(self):
        n = self.shared()
        r = self.client.post(f"/notes/{n['id']}/collab/seed", json={"rev": n["rev"], "ydoc": "AAEC", "yepoch": "epoch-amy-1"})
        self.assertEqual(r.status_code, 200, r.text)
        self.as_(BOB)
        r = self.client.post(f"/notes/{n['id']}/collab/seed", json={"rev": n["rev"], "ydoc": "BBBB", "yepoch": "epoch-bob-1"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"]["collab"], {"ydoc": "AAEC", "yepoch": "epoch-amy-1", "rev": n["rev"]})
        bad = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>x</p>", "ydoc": "CC", "yepoch": "epoch-bob-1"})
        self.assertEqual(bad.status_code, 409)
        self.assertTrue(bad.json()["detail"]["epoch"])
        ok = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Bob live</p>", "ydoc": "AAEDDD", "yepoch": "epoch-amy-1"})
        self.assertEqual(ok.status_code, 200, ok.text)
        stale = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>y</p>", "ydoc": "Z", "yepoch": "epoch-amy-1"})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["collab"]["ydoc"], "AAEDDD")    # merge it in and try again
        # A save from a screen that is not co-typing drops the state.
        self.as_(AMY)
        cur = ok.json()
        self.client.patch(f"/notes/{n['id']}", json={"rev": cur["rev"], "body": "<p>Quick Note words</p>"})
        st = self.client.get(f"/notes/{n['id']}/collab").json()
        self.assertEqual((st["ydoc"], st["yepoch"]), ("", ""))
        self.assertEqual(self.client.post(f"/notes/{n['id']}/collab/seed",
                                          json={"rev": st["rev"], "ydoc": "x", "yepoch": "bad epoch!"}).status_code, 400)

    def test_live_state_routes_refuse_readers_strangers_and_the_trash(self):
        n = self.shared(can="read")
        seed = {"rev": n["rev"], "ydoc": "AAEC", "yepoch": "epoch-123456"}
        self.as_(BOB)                                                             # read-only
        self.assertEqual(self.client.post(f"/notes/{n['id']}/collab/seed", json=seed).status_code, 403)
        self.assertEqual(self.client.post(f"/notes/{n['id']}/collab/reset").status_code, 403)
        r = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "ydoc": "AAEC", "yepoch": "epoch-123456"})
        self.assertEqual(r.status_code, 403)
        self.as_("dan@greensglobal.com")                                          # a stranger
        self.assertEqual(self.client.post(f"/notes/{n['id']}/collab/seed", json=seed).status_code, 404)
        self.assertEqual(self.client.post(f"/notes/{n['id']}/collab/reset").status_code, 404)
        self.as_(AMY)
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        self.client.post(f"/notes/{n['id']}/trash")
        self.as_(BOB)                                                             # an editor, but trashed
        self.assertEqual(self.client.get(f"/notes/{n['id']}/collab").status_code, 404)

    def test_reset_drops_the_live_state_and_keeps_the_words(self):
        n = self.shared()
        self.client.post(f"/notes/{n['id']}/collab/seed", json={"rev": n["rev"], "ydoc": "AAEC", "yepoch": "epoch-123456"})
        self.as_(BOB)
        self.assertEqual(self.client.post(f"/notes/{n['id']}/collab/reset").json(), {"ok": True})
        st = self.client.get(f"/notes/{n['id']}/collab").json()
        self.assertEqual((st["ydoc"], st["yepoch"], st["body"], st["rev"]), ("", "", "<p>Amy wrote this</p>", n["rev"]))

    def test_append_and_restore_drop_the_live_state(self):
        r = self.client.post("/notes/daily/append", json={"day": TODAY, "text": "first"}).json()
        self.client.post(f"/notes/{r['id']}/collab/seed", json={"rev": r["rev"], "ydoc": "AA", "yepoch": "epoch-123456"})
        self.client.post("/notes/daily/append", json={"day": TODAY, "text": "second"})
        self.assertEqual(self.client.get(f"/notes/{r['id']}/collab").json()["yepoch"], "")
        n = self.make(body="<p>One</p>")
        n = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "body": "<p>Two</p>"}).json()
        self.client.post(f"/notes/{n['id']}/collab/seed", json={"rev": n["rev"], "ydoc": "AA", "yepoch": "epoch-123456"})
        v = self.client.get(f"/notes/{n['id']}/versions").json()[0]
        self.client.post(f"/notes/{n['id']}/versions/{v['id']}/restore")
        self.assertEqual(self.client.get(f"/notes/{n['id']}/collab").json()["yepoch"], "")


if __name__ == "__main__":
    unittest.main()
