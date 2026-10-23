"""Board card previews - Planner's "Show On Card" (Oct 22 2026).

- tasks.card_preview: "" Automatic, checklist, description, none, or
  image:<id> - an image file of THIS task (422 otherwise). Editors only;
  the company wall stands.
- The task list carries `cardPreview`, built in bulk: the first image file
  (its current version, stored in Nexus - never an Egnyte or outside link),
  else up to 5 open checklist lines plus "more", else nothing; a set mode
  wins. The description is plain text, 200 characters at most.
- Never another task's file, never a hidden task's preview, and two queries
  at most however many tasks are listed.
- Copies (the next occurrence of a repeating task, a duplicated project)
  keep the mode but never a picked image.

Throwaway SQLite, no network.  python -m pytest test_task_card_preview.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import event

import cache
import database
import models
import task_card_preview as CP
from routers import task_config as C
from routers import task_projects as P
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

EDITOR = {"email": "editor@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
MANAGER = {"email": "manager@greensglobal.com", "level": 3}
DIRECTORY = [EDITOR, VIEWER, OUTSIDER, MANAGER]
# Our own storage: the configured Supabase project's, else any storage-shaped URL.
STORE = (CP._STORAGE_PREFIX or "https://abc.supabase.co/storage/v1/object/public/") + "task-files"


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskProject, models.TaskAttachment, models.TaskChecklistItem,
                  models.TaskActivity, models.TaskNotification, models.NexusNotification,
                  models.NexusEmployee, models.NexusSetting, models.TaskSavedView, models.TaskSection):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u in DIRECTORY:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"],
                                             first_name=u["email"].split("@")[0], status="active"))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    # -- seed helpers --------------------------------------------------------
    def project(self, **kw):
        kw.setdefault("access_level", "restricted")
        kw.setdefault("member_roles", {EDITOR["email"]: "editor", VIEWER["email"]: "viewer"})
        kw.setdefault("member_emails", [EDITOR["email"], VIEWER["email"]])
        p = models.TaskProject(id=gen_id(), name=kw.pop("name", "Board"), created_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def task(self, **kw):
        kw.setdefault("title", "T")
        kw.setdefault("status", "not_started")
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def file(self, t, name="photo.png", kind="image", url=None, at="2026-10-01T00:00:00", **kw):
        a = models.TaskAttachment(id=gen_id(), task_id=t.id, name=name, kind=kind,
                                  url=url if url is not None else f"{STORE}/{t.id}/{name}", added_at=at, **kw)
        self.db.add(a)
        t.attachment_ids = list(t.attachment_ids or []) + [a.id]
        self.db.commit()
        return a

    def lines(self, t, n, done=0):
        for i in range(n):
            self.db.add(models.TaskChecklistItem(id=gen_id(), task_id=t.id, title=f"Step {i + 1}",
                                                 done=i < done, position=float(i), created_at=now_iso()))
        t.checklist_total = n
        t.checklist_done = done
        self.db.commit()

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def patch(self, t, user, **fields):
        return T.update_task(t.id, T.TaskUpdate(**fields), BackgroundTasks(), user=user, db=self.db)

    def listed(self, user):
        return {r["id"]: r for r in T.list_tasks(user=user, db=self.db)}


class SettingTests(Base):
    def test_an_editor_sets_each_mode(self):
        p = self.project()
        t = self.task(project_id=p.id, access_level="restricted")
        for mode in ("checklist", "description", "none", ""):
            out = self.patch(t, EDITOR, card_preview=mode)
            self.assertEqual(out["cardPreviewMode"], mode)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, t.id).card_preview, "")

    def test_a_picked_image_must_be_an_image_file_of_this_task(self):
        p = self.project()
        t = self.task(project_id=p.id)
        other = self.task(project_id=p.id)
        mine = self.file(t)
        theirs = self.file(other)
        doc = self.file(t, name="spec.pdf", kind="doc")
        link = self.file(t, name="Drawings.png", kind="egnyte", url="https://greens.egnyte.com/navigate/file/x")
        inline = self.file(t, name="inline.png", url="data:image/png;base64,AAAA")
        out = self.patch(t, EDITOR, card_preview=f"image:{mine.id}")
        self.assertEqual(out["cardPreviewMode"], f"image:{mine.id}")
        for bad in (f"image:{theirs.id}", f"image:{doc.id}", f"image:{link.id}", f"image:{inline.id}",
                    "image:", "image:nope", "cover", "image:" + "x" * 200):
            self.assertEqual(self.code(lambda: self.patch(t, EDITOR, card_preview=bad)), 422, bad)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, t.id).card_preview, f"image:{mine.id}")

    def test_a_viewer_and_an_outsider_are_refused(self):
        p = self.project()
        t = self.task(project_id=p.id, access_level="restricted")
        self.assertEqual(self.code(lambda: self.patch(t, VIEWER, card_preview="none")), 403)
        self.assertIn(self.code(lambda: self.patch(t, OUTSIDER, card_preview="none")), (403, 404))
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, t.id).card_preview or "", "")

    def test_the_company_wall_holds(self):
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == MANAGER["email"]).update({"company": "co-a"})
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        t = self.task(company_id="co-b", access_level="org")
        self.assertEqual(self.code(lambda: self.patch(t, MANAGER, card_preview="none")), 404)

    def test_bulk_edit_cannot_set_it(self):
        t = self.task(access_level="org")
        T.bulk_update(T.BulkUpdate(ids=[t.id], patch={"card_preview": "none", "priority": "high"}), user=MANAGER, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, t.id).card_preview or "", "")


class PayloadTests(Base):
    def test_automatic_takes_the_first_image_at_its_current_version(self):
        t = self.task(access_level="org")
        self.file(t, name="notes.txt", kind="other", at="2026-10-01T00:00:00")
        self.file(t, name="Drawings.png", kind="egnyte", url="https://greens.egnyte.com/x", at="2026-10-01T00:00:01")
        self.file(t, name="inline.png", url="data:image/png;base64,AAAA", at="2026-10-01T00:00:02")
        first = self.file(t, name="site.jpg", kind="other", at="2026-10-02T00:00:00")   # an image by its name
        self.file(t, name="later.png", at="2026-10-03T00:00:00")
        v2 = self.file(t, name="site-v2.jpg", at="2026-10-04T00:00:00", version_group=first.id, version=2)
        self.lines(t, 3)
        p = self.listed(MANAGER)[t.id]["cardPreview"]
        self.assertEqual(p["kind"], "image")
        self.assertEqual(p["id"], v2.id)
        self.assertEqual(p["name"], "site-v2.jpg")
        self.assertTrue(p["url"].startswith(STORE))

    def test_automatic_falls_back_to_the_open_checklist_then_nothing(self):
        t = self.task(access_level="org")
        self.file(t, name="spec.pdf", kind="doc")
        self.lines(t, 8, done=2)
        p = self.listed(MANAGER)[t.id]["cardPreview"]
        self.assertEqual(p["kind"], "checklist")
        self.assertEqual([i["title"] for i in p["items"]], ["Step 3", "Step 4", "Step 5", "Step 6", "Step 7"])
        self.assertEqual(p["more"], 1)
        bare = self.task(access_level="org", description="<p>Has words</p>")
        self.assertIsNone(self.listed(MANAGER)[bare.id]["cardPreview"])

    def test_a_set_mode_wins(self):
        t = self.task(access_level="org", card_preview="description",
                      description="<p>Pour the <b>footings</b> &amp; cure</p><script>alert(1)</script><style>p{}</style>")
        self.file(t)
        self.lines(t, 2)
        none = self.task(access_level="org", card_preview="none")
        self.file(none)
        lst = self.task(access_level="org", card_preview="checklist")
        self.file(lst)
        self.lines(lst, 2)
        rows = self.listed(MANAGER)
        self.assertEqual(rows[t.id]["cardPreview"], {"kind": "description", "text": "Pour the footings & cure"})
        self.assertIsNone(rows[none.id]["cardPreview"])
        self.assertEqual(rows[lst.id]["cardPreview"]["kind"], "checklist")

    def test_the_description_is_cut_to_200_characters(self):
        t = self.task(access_level="org", card_preview="description", description="word " * 100)
        text = self.listed(MANAGER)[t.id]["cardPreview"]["text"]
        self.assertLessEqual(len(text), 201)
        self.assertTrue(text.endswith("…"))
        self.assertNotIn("<", CP.plain_text("<div><p>a</p><ul><li>b</li></ul></div>"))
        self.assertEqual(CP.plain_text("a < b and c > d"), "a < b and c > d")

    def test_a_picked_image_wins_and_a_gone_one_falls_back(self):
        t = self.task(access_level="org")
        first = self.file(t, name="a.png", at="2026-10-01T00:00:00")
        second = self.file(t, name="b.png", at="2026-10-02T00:00:00")
        self.patch(t, MANAGER, card_preview=f"image:{second.id}")
        self.assertEqual(self.listed(MANAGER)[t.id]["cardPreview"]["id"], second.id)
        self.db.delete(self.db.get(models.TaskAttachment, second.id))
        self.db.commit()
        self.assertEqual(self.listed(MANAGER)[t.id]["cardPreview"]["id"], first.id)
        # A picked file shows its newest version.
        self.patch(t, MANAGER, card_preview=f"image:{first.id}")
        v2 = self.file(t, name="a-v2.png", at="2026-10-05T00:00:00", version_group=first.id, version=2)
        self.assertEqual(self.listed(MANAGER)[t.id]["cardPreview"]["id"], v2.id)

    def test_never_another_tasks_file(self):
        a = self.task(access_level="org")
        b = self.task(access_level="org")
        theirs = self.file(b)
        # A's id list naming B's file (bad data) still shows nothing of B's.
        a.attachment_ids = [theirs.id]
        a.card_preview = f"image:{theirs.id}"
        self.db.commit()
        rows = self.listed(MANAGER)
        self.assertIsNone(rows[a.id]["cardPreview"])
        self.assertEqual(rows[b.id]["cardPreview"]["id"], theirs.id)

    def test_a_hidden_task_has_no_preview_in_the_list(self):
        p = self.project(member_roles={EDITOR["email"]: "editor"}, member_emails=[EDITOR["email"]])
        hidden = self.task(project_id=p.id, access_level="restricted")
        self.file(hidden)
        rows = self.listed(VIEWER)
        self.assertNotIn(hidden.id, rows)
        delta = T.list_tasks_delta(since="", user=VIEWER, db=self.db)
        self.assertNotIn(hidden.id, {r["id"] for r in delta["tasks"]})
        self.assertIn(hidden.id, self.listed(EDITOR))

    def test_the_delta_and_a_patch_carry_it(self):
        t = self.task(access_level="org")
        self.lines(t, 1)
        delta = T.list_tasks_delta(since="", user=MANAGER, db=self.db)
        self.assertEqual({r["id"]: r for r in delta["tasks"]}[t.id]["cardPreview"]["kind"], "checklist")
        out = self.patch(t, MANAGER, card_preview="description", description="Hello")
        self.assertEqual(out["cardPreview"], {"kind": "description", "text": "Hello"})

    def test_two_queries_at_most_for_many_tasks(self):
        tasks = []
        for i in range(40):
            t = self.task(access_level="org", card_preview=["", "checklist", "description", "none"][i % 4],
                          description=f"<p>Task {i}</p>")
            if i % 3 == 0:
                self.file(t)
            if i % 2 == 0:
                self.lines(t, 7)
            tasks.append(t)
        self.db.expire_all()
        rows = self.db.query(models.Task).all()
        seen = []

        def count(conn, cursor, statement, params, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                seen.append(statement)

        event.listen(database.engine, "before_cursor_execute", count)
        try:
            out = CP.card_previews(self.db, rows)
        finally:
            event.remove(database.engine, "before_cursor_execute", count)
        self.assertLessEqual(len(seen), 2, seen)
        self.assertTrue(any(v["kind"] == "image" for v in out.values()))
        self.assertTrue(all(len(v["items"]) <= 5 for v in out.values() if v["kind"] == "checklist"))
        # Nothing to show: no query at all.
        seen.clear()
        event.listen(database.engine, "before_cursor_execute", count)
        try:
            self.assertEqual(CP.card_previews(self.db, [r for r in rows if r.card_preview == "none"]), {})
        finally:
            event.remove(database.engine, "before_cursor_execute", count)
        self.assertEqual(seen, [])


class CopyTests(Base):
    def test_copyable(self):
        self.assertEqual(CP.copyable("checklist"), "checklist")
        self.assertEqual(CP.copyable("image:abc"), "")
        self.assertEqual(CP.copyable(None), "")

    def test_the_next_occurrence_keeps_the_mode_but_not_a_picked_image(self):
        for mode, want in (("description", "description"), ("image", "")):
            t = self.task(access_level="org", status="recurring", due_on="2026-10-20",
                          recurrence={"freq": "daily", "interval": 1})
            if mode == "image":
                a = self.file(t)
                t.card_preview = f"image:{a.id}"
            else:
                t.card_preview = mode
            self.db.commit()
            self.patch(t, MANAGER, completed=True)
            self.db.expire_all()
            nxt = (self.db.query(models.Task)
                   .filter(models.Task.id != t.id, models.Task.title == t.title, models.Task.completed.is_(False)).all())
            self.assertTrue(nxt, mode)
            self.assertEqual({x.card_preview for x in nxt}, {want})
            for x in nxt:
                self.db.delete(x)
            self.db.commit()

    def test_a_duplicated_project_keeps_the_mode_but_not_a_picked_image(self):
        p = self.project(access_level="org", owner_email=MANAGER["email"])
        a = self.task(project_id=p.id, title="Shows text", card_preview="description")
        b = self.task(project_id=p.id, title="Shows a photo")
        f = self.file(b)
        b.card_preview = f"image:{f.id}"
        self.db.commit()
        out = P.duplicate_project(p.id, P.DuplicateProjectBody(name="Copy"), user=MANAGER, db=self.db)
        copies = {t.title: t.card_preview for t in self.db.query(models.Task).filter(models.Task.project_id == out["id"]).all()}
        self.assertEqual(copies, {"Shows text": "description", "Shows a photo": ""})
        self.assertEqual(a.card_preview, "description")

    def test_a_new_task_never_takes_a_picked_image(self):
        out = T.create_task(T.TaskCreate(title="Copy", card_preview="image:abc"), BackgroundTasks(), user=MANAGER, db=self.db)
        self.assertEqual(out["cardPreviewMode"], "")
        out = T.create_task(T.TaskCreate(title="Copy 2", card_preview="checklist"), BackgroundTasks(), user=MANAGER, db=self.db)
        self.assertEqual(out["cardPreviewMode"], "checklist")


class BoardLayoutTests(Base):
    def test_a_default_board_keeps_its_columns(self):
        self.assertEqual(P.clean_default_view({"view": "board", "group": "status", "lanes": "label", "columns": "due"}),
                         {"view": "board", "group": "status", "lanes": "label", "columns": "due"})
        self.assertEqual(P.clean_default_view({"view": "list", "group": "status", "lanes": "label", "columns": "due"}),
                         {"view": "list", "group": "status"})
        self.assertEqual(P.clean_default_view({"view": "board", "lanes": "x" * 65}), {"view": "board"})
        self.assertEqual(P.clean_default_view({"view": "board", "columns": "nonsense"}), {"view": "board"})

    def test_a_saved_board_view_keeps_its_columns(self):
        out = C.create_saved_view(C.SavedViewBody(name="Due", view="board", group="assignee", board_columns="due"),
                                  user=EDITOR, db=self.db)
        self.assertEqual((out["view"], out["group"], out["boardColumns"]), ("board", "assignee", "due"))
        bad = C.create_saved_view(C.SavedViewBody(name="Odd", view="board", board_columns="weird"), user=EDITOR, db=self.db)
        self.assertEqual(bad["boardColumns"], "")


if __name__ == "__main__":
    unittest.main()
