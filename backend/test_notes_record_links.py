"""Record links and note templates in Notes (Neil, 11/06/2026) - routers/notes.py.

  - A [[ link is <a data-type="recordLink" data-ref="<kind>:<id>" title="T">T</a>:
    the sanitizer keeps data-type and data-ref, drops a ref that is not one of
    note / task / job / kb with a plain id, and never keeps an href on it.
  - GET /notes/mentions?ref= lists the notes the caller may read that link to
    the record: their own live notes and the ones shared with them, never a
    trashed note, a stranger's note or the note itself; a bad ref is 400.
  - Use as Template works on a plain note (the templates view lists it, kind
    'note') and is refused on a daily scratchpad.

Uses a throwaway sqlite file.

Run with: python -m pytest test_notes_record_links.py   (one file per process - CLAUDE.md)
"""
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
from routers.notes import sanitize_note                  # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

AMY = "amy@greensglobal.com"
BOB = "bob@greensglobal.com"
CAT = "cat@greensglobal.com"
TODAY = "2026-11-06"


def link(ref, title="Fix the gate"):
    return f'<a data-type="recordLink" data-ref="{ref}" title="{title}">{title}</a>'


class RecordLinkSanitizerTest(unittest.TestCase):
    def test_a_record_link_keeps_its_kind_and_ref(self):
        out = sanitize_note(f"<p>See {link('task:abc-123')}</p>")
        self.assertIn('data-type="recordLink"', out)
        self.assertIn('data-ref="task:abc-123"', out)
        self.assertIn('title="Fix the gate"', out)
        self.assertIn(">Fix the gate</a>", out)

    def test_every_offered_kind_is_kept(self):
        for ref in ("note:note_ab12", "task:t1", "job:42", "kb:6f1c2a9e-0b1d-4c3e-9f00-123456789abc"):
            self.assertIn(f'data-ref="{ref}"', sanitize_note(f"<p>{link(ref)}</p>"), ref)

    def test_an_unknown_kind_or_a_url_is_dropped(self):
        for ref in ("payroll:1", "task:javascript:alert(1)", "task:../../x", "task:", "task:a b", "https://evil.example"):
            out = sanitize_note(f"<p>{link(ref)}</p>")
            self.assertNotIn("data-ref", out, ref)
            self.assertNotIn("evil.example", out, ref)
            self.assertIn("Fix the gate", out, ref)

    def test_a_record_link_never_carries_an_href(self):
        out = sanitize_note('<p><a data-type="recordLink" data-ref="task:t1" href="https://evil.example/">x</a></p>')
        self.assertIn('data-ref="task:t1"', out)
        self.assertNotIn("href", out)

    def test_an_ordinary_link_is_unchanged(self):
        out = sanitize_note('<p><a href="https://nexus.example/x" data-ref="task:t1">x</a></p>')
        self.assertIn('href="https://nexus.example/x"', out)


class CalloutToggleSanitizerTest(unittest.TestCase):
    """Callouts and toggles (11/07/2026): the only <div>s a note keeps."""

    def test_a_callout_keeps_its_tone_and_words(self):
        out = sanitize_note('<div data-type="callout" data-tone="warning"><p>Hard hats on</p></div>')
        self.assertEqual(out, '<div data-type="callout" data-tone="warning"><p>Hard hats on</p></div>')

    def test_a_toggle_keeps_its_summary_and_state(self):
        out = sanitize_note('<div data-type="toggle" data-summary="Gate &quot;A&quot; notes" data-open="false"><p>x</p></div>')
        self.assertIn('data-type="toggle"', out)
        self.assertIn('data-summary="Gate &quot;A&quot; notes"', out)
        self.assertIn('data-open="false"', out)
        self.assertIn("<p>x</p></div>", out)

    def test_bad_values_and_plain_divs_are_dropped(self):
        out = sanitize_note('<div data-type="callout" data-tone="red" style="x" onclick="y"><p>a</p></div>')
        self.assertEqual(out, '<div data-type="callout"><p>a</p></div>')
        self.assertEqual(sanitize_note('<div class="x"><p>b</p></div>'), "<p>b</p>")
        self.assertNotIn("data-open", sanitize_note('<div data-type="toggle" data-open="maybe"><p>c</p></div>'))

    def test_a_plain_div_inside_a_callout_never_closes_it_early(self):
        out = sanitize_note('<div data-type="callout"><div><p>in</p></div><p>still in</p></div><p>after</p>')
        self.assertEqual(out, '<div data-type="callout"><p>in</p><p>still in</p></div><p>after</p>')

    def test_a_div_inside_a_dropped_tree_is_gone(self):
        out = sanitize_note('<script><div data-type="callout">x</div></script><p>ok</p>')
        self.assertEqual(out, "<p>ok</p>")


class MentionsTest(unittest.TestCase):
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
        self.as_(AMY)
        app = FastAPI()
        app.include_router(notes.router)
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def as_(self, email):
        self.user = {"email": email, "name": email.split("@")[0].title(), "role": "employee", "level": 1}

    def note(self, title, body="", **kw):
        r = self.client.post("/notes", json={"title": title, "body": body, "day": TODAY, **kw})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def mentions(self, ref):
        r = self.client.get("/notes/mentions", params={"ref": ref})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_lists_only_the_notes_the_caller_may_read(self):
        mine = self.note("Site Walk", f"<p>{link('task:t1')}</p>")
        self.note("Unrelated", "<p>nothing here</p>")
        self.note("Other task", f"<p>{link('task:t10')}</p>")     # task:t1 must not match task:t10
        self.as_(BOB)
        bobs = self.note("Bob's private", f"<p>{link('task:t1')}</p>")
        shared = self.note("Bob shared", f"<p>{link('task:t1')}</p>")
        self.client.put(f"/notes/{shared['id']}/share", json={"email": AMY, "can": "read"})
        self.as_(AMY)
        r = self.mentions("task:t1")
        self.assertEqual(sorted(n["id"] for n in r["notes"]), sorted([mine["id"], shared["id"]]))
        self.assertEqual(r["total"], 2)
        self.assertNotIn(bobs["id"], [n["id"] for n in r["notes"]])
        row = next(n for n in r["notes"] if n["id"] == shared["id"])
        self.assertEqual(row["owner"], BOB)
        self.assertFalse(row["mine"])
        self.as_(CAT)
        self.assertEqual(self.mentions("task:t1")["notes"], [])

    def test_a_trashed_note_and_the_note_itself_are_not_listed(self):
        target = self.note("Target")
        self_ref = self.client.patch(f"/notes/{target['id']}", json={"rev": target["rev"], "body": f"<p>{link('note:' + target['id'])}</p>"})
        self.assertEqual(self_ref.status_code, 200, self_ref.text)
        other = self.note("Points at it", f"<p>{link('note:' + target['id'])}</p>")
        gone = self.note("Trashed", f"<p>{link('note:' + target['id'])}</p>")
        self.client.post(f"/notes/{gone['id']}/trash")
        self.assertEqual([n["id"] for n in self.mentions(f"note:{target['id']}")["notes"]], [other["id"]])

    def test_a_bad_ref_is_refused(self):
        for ref in ("", "payroll:1", "task:%", "task:a b"):
            self.assertEqual(self.client.get("/notes/mentions", params={"ref": ref}).status_code, 400, ref)


class NoteTemplatesTest(MentionsTest):
    def test_a_note_can_be_a_template_and_a_daily_cannot(self):
        n = self.note("1:1 Agenda", "<h2>Wins</h2>")
        r = self.client.patch(f"/notes/{n['id']}", json={"rev": n["rev"], "template": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["template"])
        self.assertEqual(r.json()["rev"], n["rev"])          # a mark: no rev move
        rows = self.client.get("/notes?view=templates").json()["notes"]
        self.assertEqual([(x["id"], x["kind"]) for x in rows], [(n["id"], "note")])
        d = self.client.post("/notes", json={"kind": "daily", "day": TODAY}).json()
        self.assertEqual(self.client.patch(f"/notes/{d['id']}", json={"rev": d["rev"], "template": True}).status_code, 400)
        # A share with Can Edit never marks it.
        self.client.put(f"/notes/{n['id']}/share", json={"email": BOB, "can": "edit"})
        self.as_(BOB)
        cur = self.client.get(f"/notes/{n['id']}").json()
        self.assertEqual(self.client.patch(f"/notes/{n['id']}", json={"rev": cur["rev"], "template": False}).status_code, 403)
        self.assertEqual(self.client.get("/notes?view=templates").json()["notes"], [])


class SeenByTest(MentionsTest):
    def test_the_owner_sees_who_opened_it_and_a_sharer_does_not(self):
        n = self.note("Plan", "<p>v1</p>")
        self.assertEqual(self.client.get(f"/notes/{n['id']}").json()["seenBy"], [])
        for email in (BOB, CAT):
            self.client.put(f"/notes/{n['id']}/share", json={"email": email, "can": "edit"})
        self.as_(BOB)
        got = self.client.get(f"/notes/{n['id']}").json()
        self.assertNotIn("seenBy", got)                      # a sharer never learns who else has it
        self.as_(AMY)
        cur = self.client.get(f"/notes/{n['id']}").json()
        self.assertEqual(cur["seenBy"], [{"email": BOB, "latest": True}])
        # Amy changes the words: Bob has not seen the latest any more.
        self.client.patch(f"/notes/{n['id']}", json={"rev": cur["rev"], "body": "<p>v2</p>"})
        self.assertEqual(self.client.get(f"/notes/{n['id']}").json()["seenBy"], [{"email": BOB, "latest": False}])
        # Someone no longer shared is not listed.
        self.client.delete(f"/notes/{n['id']}/share/{BOB}")
        self.assertEqual(self.client.get(f"/notes/{n['id']}").json()["seenBy"], [])


if __name__ == "__main__":
    unittest.main()
