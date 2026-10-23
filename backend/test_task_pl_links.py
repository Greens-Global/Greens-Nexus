"""Web links and Convert to Subtask (Neil, Oct 22 2026 - Planner parity).

Web links:
- POST /tasks/{id}/links takes http(s) only, with a host, no user name or
  password, no hidden characters or backslash, at most 2,000 characters,
  and never a link into Nexus's own storage; the address is normalized and
  stored as a kind "link" attachment. Nothing is fetched.
- Rights are the attachment rights: adding = commenter; changing or removing
  = the person who added it, or an editor - and never a viewer. Walls and
  restricted tasks hold. Links are not versioned, and an uploaded file
  cannot pose as one.
- A link never reaches the storage machinery: /files/view does not take it,
  and copies (task to ticket, duplicate project, Save As Template) carry
  links exactly as they carry Egnyte links - not at all.

Convert to Subtask:
- POST /tasks/checklist/{item}/convert makes the subtask through
  _create_task (people checks, automation, the batched email), removes the
  line and logs it on the parent, in one commit. Editors only; a line that
  has gone is 409; a private parent makes a private subtask; HR checklist
  tasks are refused.

Throwaway SQLite, no network.  python -m pytest test_task_pl_links.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import files as F  # noqa: E402
from routers import task_config as TC  # noqa: E402
from routers import task_projects as P  # noqa: E402
from routers import tasks as T  # noqa: E402
from routers import tickets as TK  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

OWNER = {"email": "owner@greensglobal.com", "level": 1}
COMMENTER = {"email": "commenter@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
OTHERCO = {"email": "b@greensglobal.com", "level": 3}
LEFT = "left@greensglobal.com"
COA, COB = "co-a", "co-b"
SUPA = {"SUPABASE_URL": "https://proj.supabase.co"}


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
        for m in (models.Task, models.TaskProject, models.TaskComment, models.TaskAttachment,
                  models.TaskActivity, models.TaskNotification, models.NexusNotification,
                  models.NexusEmployee, models.NexusSetting, models.TaskTicket, models.TaskChecklistItem,
                  models.TaskTemplate, models.TaskSection, models.HrChecklistItem):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u, co in ((OWNER, COA), (COMMENTER, COA), (VIEWER, COA), (EDITOR, COA), (OUTSIDER, COA),
                      (OTHERCO, COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], status="active",
                                             first_name=u["email"].split("@")[0], company=co))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email=LEFT, status="offboarded",
                                         first_name="left", company=COA))
        self.db.commit()
        cache.settings_config.invalidate()
        self.project = models.TaskProject(
            id=gen_id(), name="Plans", access_level="restricted", owner_email=OWNER["email"],
            member_roles={COMMENTER["email"]: "commenter", VIEWER["email"]: "viewer",
                          EDITOR["email"]: "editor"},
            created_at=now_iso(), company_id=COA)
        self.db.add(self.project)
        self.db.commit()
        self.t = self.task()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def task(self, **kw):
        kw.setdefault("project_id", self.project.id)
        kw.setdefault("company_id", COA)
        t = models.Task(id=gen_id(), title="Pump", code=f"T-{gen_id()[:6]}", status="not_started",
                        attachment_ids=[], activity_ids=[], subtask_ids=[], created_at=now_iso(),
                        modified_at=now_iso(), created_by=OWNER["email"], **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def detail(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.detail

    def arm_walls(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def task_row(self, tid=None):
        self.db.expire_all()
        return self.db.get(models.Task, tid or self.t.id)


# ── Web links ────────────────────────────────────────────────────────────────
class LinkValidationTests(Base):
    GOOD = [
        ("https://example.com/page", "https://example.com/page"),
        ("http://example.com", "http://example.com"),
        ("  https://Example.COM/A?b=1#c  ", "https://example.com/A?b=1#c"),
        ("HTTPS://example.com:443/x", "https://example.com/x"),
        ("http://example.com:80/x", "http://example.com/x"),
        ("https://example.com:8443/x", "https://example.com:8443/x"),
        ("example.com/page", "https://example.com/page"),
        ("www.example.com:8080/x", "https://www.example.com:8080/x"),
        ("https://example.com/my file.pdf", "https://example.com/my%20file.pdf"),
        ("https://example.com/caf\u00e9", "https://example.com/caf%C3%A9"),
        ("https://example.com/a%20b?q=%2F", "https://example.com/a%20b?q=%2F"),
        ("https://b\u00fccher.example/x", "https://xn--bcher-kva.example/x"),
        ("https://[2001:db8::1]:8080/x", "https://[2001:db8::1]:8080/x"),
        ("https://site.example/files/view?menu=1", "https://site.example/files/view?menu=1"),
        ("http://192.168.1.10/x", "http://192.168.1.10/x"),
        ("https://[2001:0db8:0000::0001]/", "https://[2001:db8::1]/"),
        ("https://a-b.c0.example/", "https://a-b.c0.example/"),
        ("https://greens.sharepoint.com/:w:/r/sites/Ops/Doc.docx?d=w1&csf=1",
         "https://greens.sharepoint.com/:w:/r/sites/Ops/Doc.docx?d=w1&csf=1"),
    ]
    BAD = [
        "", "   ", "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<b>x</b>",
        "file:///etc/passwd", "vbscript:msgbox(1)", "mailto:a@b.com", "ftp://example.com/x",
        "localhost:3000/x", "/relative/path", "//example.com/x", "https:example.com",
        "https://user:pass@example.com/", "https://user@example.com/", "https://example.com\\@evil.com/",
        "https://exa mple.com/", "https://example.com/\x00", "https://example.com/a\nb",
        "https://example.com/\u202eexe.pdf", "https://exa\u200bmple.com/", "https://example.com/\x7f",
        "https:///path-only", "https://:443/", "https://example.com:99999/", "https://[bad/",
        "https://exa!mple.com/", "https://example.com/" + "a" * 2000,
        "https://proj.supabase.co/storage/v1/object/public/task-files/a.png",
        "https://example.com/?next=https://proj.supabase.co/storage/v1/object/sign/task-files/a.png",
        "https://api.nexus.example/files/view?u=https%3A%2F%2Fproj.supabase.co%2Fx",
        # Host labels (L3).
        "https://exa_mple.com/", "https://-bad.com/", "https://bad-.com/", "https://a..b.com/",
        "https://.example.com/", "https://example.com./x", "https://" + "a" * 64 + ".com/",
        "http://0x7f.0.0.1/", "http://2130706433/", "http://256.1.1.1/", "http://1.2.3/",
        "https://[fe80::1%25eth0]/", "https://[::zz]/",
        # Our storage, however it is spelled (L1), or carried along (L2).
        "http://proj.supabase.co/storage/v1/object/public/task-files/a.png",
        "https://PROJ.supabase.co:443/storage%2Fv1%2Fobject/public/task-files/a.png",
        "https://proj.supabase.co/x/storage%252Fv1%252Fobject",
        "https://proj.supabase.co./storage/v1/object/public/task-files/a.png",
        "https://example.com/#https://proj.supabase.co/storage/v1/object/public/x",
        "https://example.com/?next=https%3A%2F%2Fproj.supabase.co%2Fstorage%2Fv1%2Fx",
        "https://example.com/#/api/files/view?u=x",
        "https://example.com/?r=%2Ffiles%2Fview%3Fu%3Dx",
    ]

    def test_good_links_are_normalized(self):
        with mock.patch.dict(os.environ, SUPA):
            for raw, want in self.GOOD:
                self.assertEqual(T._check_web_link(raw), want, raw)

    def test_bad_links_are_refused_with_a_400(self):
        with mock.patch.dict(os.environ, SUPA):
            for raw in self.BAD:
                with self.assertRaises(HTTPException, msg=repr(raw)) as e:
                    T._check_web_link(raw)
                self.assertEqual(e.exception.status_code, 400, repr(raw))
                self.assertNotIn("\u2014", e.exception.detail)

    def test_own_storage_is_read_from_the_parsed_link(self):
        with mock.patch.dict(os.environ, SUPA):
            for u in ("https://proj.supabase.co./storage/v1/x", "http://proj.supabase.co:8443/storage/v1/x",
                      "https://proj.supabase.co/storage%2Fv1%2Fx", "https://e.com/files/view?a=1&u=2",
                      "https://e.com/p#https://proj.supabase.co./storage/v1/x"):
                self.assertTrue(T._own_file_url(u), u)
            self.assertFalse(T._own_file_url("https://proj.supabase.co.evil.example/storage/v1/x"))
            self.assertFalse(T._own_file_url("https://example.com/storage/v1/x"))
            self.assertFalse(T._own_file_url("https://example.com/files/view?menu=1"))

    def test_the_stored_link_is_never_a_storage_url(self):
        # The viewer and api.js rewrite only canonical storage URLs; no
        # accepted link is one, so neither ever touches a link.
        with mock.patch.dict(os.environ, SUPA), mock.patch.object(F, "_SUPABASE_URL", SUPA["SUPABASE_URL"]):
            for raw, _ in self.GOOD:
                self.assertIsNone(F.parse_public_url(T._check_web_link(raw)), raw)
            self.assertIsNotNone(F.parse_public_url(
                "https://proj.supabase.co/storage/v1/object/public/task-files/a.png"))
            self.assertEqual(self.code(lambda: F.view_file(u="https://example.com/a.png", user=OWNER)), 400)


class LinkTests(Base):
    def add(self, url="https://example.com/spec", user=OWNER, t=None, name=""):
        return T.add_web_link((t or self.t).id, T.WebLinkCreate(url=url, name=name), user=user, db=self.db)

    def edit(self, aid, user=OWNER, **kw):
        return T.update_web_link(aid, T.WebLinkUpdate(**kw), user=user, db=self.db)

    def listed(self, user=OWNER, t=None):
        return T.list_attachments((t or self.t).id, user=user, db=self.db)

    def test_adding_a_link_records_a_link_row_and_an_attached_entry(self):
        r = self.add("Example.com/spec", name="  The Spec\u200b ")
        self.assertEqual((r["kind"], r["url"], r["name"], r["size"]), ("link", "https://example.com/spec", "The Spec", ""))
        self.assertEqual((r["versionCount"], r["groupAddedBy"]), (1, OWNER["email"]))
        row = self.task_row()
        self.assertEqual(row.attachment_ids, [r["id"]])
        acts = self.db.query(models.TaskActivity).filter_by(entity_id=self.t.id).all()
        self.assertEqual([(a.type, a.detail) for a in acts], [("attached", 'added link "The Spec"')])
        # Like a new file: nobody is notified.
        self.assertEqual(self.db.query(models.TaskNotification).count(), 0)
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)
        self.assertEqual([x["kind"] for x in self.listed()], ["link"])

    def test_without_a_name_the_address_is_the_name(self):
        r = self.add("https://example.com/a")
        self.assertEqual(r["name"], "https://example.com/a")
        acts = self.db.query(models.TaskActivity).filter_by(entity_id=self.t.id).all()
        self.assertEqual(acts[0].detail, 'added link "example.com"')

    def test_nothing_is_fetched(self):
        import httpx
        with mock.patch.object(httpx, "get", side_effect=AssertionError("fetched")), \
                mock.patch.object(httpx, "post", side_effect=AssertionError("fetched")), \
                mock.patch.object(httpx.Client, "send", side_effect=AssertionError("fetched")):
            r = self.add("https://169.254.169.254/latest/meta-data")
            self.edit(r["id"], url="http://localhost:8000/admin")

    def test_the_same_address_twice_is_a_friendly_409(self):
        self.add("https://example.com/a", name="A")
        self.assertIn('"A"', self.detail(lambda: self.add("HTTPS://EXAMPLE.com/a")))
        self.assertEqual(len(self.listed()), 1)

    def test_rights_are_the_attachment_rights(self):
        self.assertEqual(self.add(user=COMMENTER)["kind"], "link")
        self.assertEqual(self.code(lambda: self.add("https://example.com/v", user=VIEWER)), 403)
        self.assertEqual(self.code(lambda: self.add("https://example.com/o", user=OUTSIDER)), 403)

    def test_who_may_edit(self):
        mine = self.add("https://example.com/c", user=COMMENTER)
        theirs = self.add("https://example.com/o", user=OWNER)
        # The person who added it: yes. Another commenter's link: no.
        self.assertEqual(self.edit(mine["id"], user=COMMENTER, name="Mine")["name"], "Mine")
        self.assertEqual(self.code(lambda: self.edit(theirs["id"], user=COMMENTER, name="x")), 403)
        # An editor edits anyone's.
        self.assertEqual(self.edit(theirs["id"], user=EDITOR, url="https://example.com/p")["url"],
                         "https://example.com/p")
        # A viewer never - not even a link they added before being made viewer.
        old = models.TaskAttachment(id=gen_id(), task_id=self.t.id, name="v", url="https://example.com/v",
                                    kind="link", added_by=VIEWER["email"], added_at=now_iso())
        self.db.add(old)
        self.db.commit()
        self.assertEqual(self.code(lambda: self.edit(old.id, user=VIEWER, name="x")), 403)
        # Somebody with no role on the project (the task is org-wide, so seen): no.
        self.assertEqual(self.code(lambda: self.edit(mine["id"], user=OUTSIDER, name="x")), 403)

    def test_edit_rules(self):
        r = self.add("https://example.com/a")
        # No custom name: the name follows the address.
        out = self.edit(r["id"], url="https://example.com/b")
        self.assertEqual((out["url"], out["name"]), ("https://example.com/b", "https://example.com/b"))
        out = self.edit(r["id"], name="Spec")
        self.assertEqual(out["name"], "Spec")
        # A custom name is kept when only the address changes; blank goes back to the address.
        out = self.edit(r["id"], url="https://example.com/c")
        self.assertEqual((out["url"], out["name"]), ("https://example.com/c", "Spec"))
        out = self.edit(r["id"], name="  ")
        self.assertEqual(out["name"], "https://example.com/c")
        # The edit is validated like an add, and may not duplicate another link.
        self.add("https://example.com/d")
        self.assertEqual(self.code(lambda: self.edit(r["id"], url="javascript:alert(1)")), 400)
        self.assertEqual(self.code(lambda: self.edit(r["id"], url="https://example.com/d")), 409)
        types = [a.type for a in self.db.query(models.TaskActivity).filter_by(entity_id=self.t.id).all()]
        self.assertEqual(types.count("attachment_changed"), 4)

    def test_only_a_link_is_edited_here(self):
        f = T.add_attachment(self.t.id, T.AttachmentCreate(name="plan.pdf", url="data:x"), user=OWNER, db=self.db)
        self.assertEqual(self.code(lambda: self.edit(f["id"], name="x")), 422)
        # Somebody who cannot see the task learns nothing - not even the kind.
        secret = self.task(project_id="", access_level="restricted", owner_email=OWNER["email"])
        g = T.add_attachment(secret.id, T.AttachmentCreate(name="plan.pdf", url="data:x"), user=OWNER, db=self.db)
        self.assertEqual(self.code(lambda: self.edit(g["id"], user=OUTSIDER, name="x")), 404)

    def test_removed_like_any_file(self):
        r = self.add(user=COMMENTER, name="Spec")
        self.assertEqual(self.code(lambda: T.delete_attachment(r["id"], user=VIEWER, db=self.db)), 403)
        T.delete_attachment(r["id"], user=COMMENTER, db=self.db)
        self.assertEqual(self.listed(), [])
        self.assertIn('removed link "Spec"',
                      [a.detail for a in self.db.query(models.TaskActivity).filter_by(entity_id=self.t.id).all()])

    def test_a_link_is_not_versioned(self):
        r = self.add()
        self.assertEqual(self.code(lambda: T.add_attachment_version(
            r["id"], T.AttachmentVersionCreate(name="x.pdf", url="data:y"), user=OWNER, db=self.db)), 422)

    def test_an_uploaded_file_cannot_pose_as_a_link(self):
        for kind in ("link", "Link", " link "):
            self.assertEqual(self.code(lambda k=kind: T.add_attachment(
                self.t.id, T.AttachmentCreate(name="x", url="data:x", kind=k), user=OWNER, db=self.db)), 422)
        f = T.add_attachment(self.t.id, T.AttachmentCreate(name="plan.pdf", url="data:x"), user=OWNER, db=self.db)
        self.assertEqual(self.code(lambda: T.add_attachment_version(
            f["id"], T.AttachmentVersionCreate(name="x", url="data:y", kind="link"), user=OWNER, db=self.db)), 422)

    def test_the_file_route_still_refuses_outside_urls(self):
        import routers.items as items
        with mock.patch.object(items, "_STORAGE_PREFIX", "https://proj.supabase.co/storage/v1/object/public/"):
            self.assertEqual(self.code(lambda: T.add_attachment(
                self.t.id, T.AttachmentCreate(name="x", url="https://example.com/x"), user=OWNER, db=self.db)), 400)

    def test_company_wall_and_restricted_task(self):
        self.arm_walls()
        self.assertEqual(self.code(lambda: self.add(user=OTHERCO)), 404)
        r = self.add()
        self.assertEqual(self.code(lambda: self.edit(r["id"], user=OTHERCO, name="x")), 404)
        self.assertEqual(self.code(lambda: T.delete_attachment(r["id"], user=OTHERCO, db=self.db)), 404)
        secret = self.task(project_id="", access_level="restricted", owner_email=OWNER["email"])
        self.assertEqual(self.code(lambda: self.add(t=secret, user=COMMENTER)), 404)

    def test_a_trashed_task_takes_no_link_changes(self):
        r = self.add()
        self.t.deleted_at = now_iso()
        self.db.commit()
        self.assertEqual(self.code(lambda: self.add("https://example.com/new")), 404)
        self.assertEqual(self.code(lambda: self.edit(r["id"], name="x")), 404)


class LinkCopyTests(Base):
    """Copies carry web links exactly as they carry Egnyte links: not at all.
    A ticket keeps files in our storage; a duplicate or a template copies a
    task's work, never its files or history."""

    def setUp(self):
        super().setUp()
        self.file = T.add_attachment(self.t.id, T.AttachmentCreate(name="plan.pdf", url="data:x"),
                                     user=OWNER, db=self.db)
        self.link = T.add_web_link(self.t.id, T.WebLinkCreate(url="https://example.com/spec"), user=OWNER, db=self.db)
        self.db.add(models.TaskAttachment(id=gen_id(), task_id=self.t.id, name="Lease", kind="egnyte",
                                          url="https://greens.egnyte.com/fl/x", added_by=OWNER["email"],
                                          added_at=now_iso()))
        self.db.commit()

    def test_task_to_ticket_copies_files_but_no_links(self):
        tk = models.TaskTicket(id=gen_id(), code="TK-1", subject="S", created_at=now_iso())
        self.db.add(tk)
        self.db.commit()
        TK._copy_task_files(self.db, self.t, tk, OWNER["email"])
        self.db.commit()
        names = [r.name for r in self.db.query(models.TaskAttachment).filter_by(task_id=tk.id).all()]
        self.assertEqual(names, ["plan.pdf"])

    def test_duplicate_project_and_templates_carry_no_attachments(self):
        out = P.duplicate_project(self.project.id, P.DuplicateProjectBody(name="Copy"), user=OWNER, db=self.db)
        copies = self.db.query(models.Task).filter(models.Task.project_id == out["id"]).all()
        self.assertTrue(copies)
        self.assertTrue(all(not (c.attachment_ids or []) for c in copies))
        self.assertEqual(self.db.query(models.TaskAttachment).filter(
            models.TaskAttachment.task_id.in_([c.id for c in copies])).count(), 0)
        tpl = TC.save_task_as_template(self.t.id, TC.SaveAsTemplateBody(name="Pump"), user=OWNER, db=self.db)
        self.assertNotIn("example.com", repr(tpl))


# ── Convert to Subtask ───────────────────────────────────────────────────────
class ConvertTests(Base):
    def setUp(self):
        super().setUp()
        self.parent = self.task(assignee_email=EDITOR["email"], assignee_emails=[EDITOR["email"]],
                                priority="high", follower_emails=[COMMENTER["email"]])
        self.bg = BackgroundTasks()

    def line(self, title="Call the vendor", t=None, **kw):
        out = T.add_checklist_items((t or self.parent).id, T.ChecklistItemCreate(title=title, **kw),
                                    user=OWNER, db=self.db)
        return out["items"][0]

    def convert(self, item_id, user=OWNER):
        self.bg = BackgroundTasks()
        return T.convert_checklist_item(item_id, self.bg, user=user, db=self.db)

    def test_happy_path(self):
        keep = self.line("Keep me")
        item = self.line("Call the vendor", assignee_email=COMMENTER["email"])
        out = self.convert(item["id"])
        sub, parent = out["subtask"], out["task"]
        self.assertEqual((sub["title"], sub["parentTaskId"], sub["priority"]),
                         ("Call the vendor", self.parent.id, "high"))
        self.assertEqual(sub["assigneeIds"], [COMMENTER["email"]])
        self.assertEqual(sub["projectId"], self.project.id)
        self.assertIn(COMMENTER["email"], sub["followerIds"])
        self.assertFalse(sub["completed"])
        self.assertIn(sub["id"], parent["subtaskIds"])
        self.assertEqual((parent["checklistTotal"], parent["checklistDone"]), (1, 0))
        # The parent comes back with its board card's preview (the client swaps
        # it in): the converted line is already off the card.
        self.assertEqual([x["title"] for x in parent["cardPreview"]["items"]], ["Keep me"])
        left = T.list_checklist(self.parent.id, user=OWNER, db=self.db)
        self.assertEqual([x["id"] for x in left], [keep["id"]])
        acts = self.db.query(models.TaskActivity).filter_by(entity_id=self.parent.id,
                                                            type="checklist_converted").all()
        self.assertEqual([a.detail for a in acts], ['made checklist item "Call the vendor" a subtask'])
        created = self.db.query(models.TaskActivity).filter_by(entity_id=sub["id"], type="created").count()
        self.assertEqual(created, 1)

    def test_notifications_go_through_notify_task_event(self):
        item = self.line(assignee_email=COMMENTER["email"])
        sent = []
        with mock.patch.object(T, "notify_task_event", lambda *a, **kw: sent.append(a)):
            out = self.convert(item["id"])
            for job in self.bg.tasks:
                job.func(*job.args, **job.kwargs)
        self.assertIn((out["subtask"]["id"], "created", OWNER["email"]), sent)
        # The assignee's bell is the one any new subtask rings.
        bells = self.db.query(models.TaskNotification).filter_by(task_id=out["subtask"]["id"]).all()
        self.assertEqual([(b.kind, b.for_email) for b in bells], [("task_assigned", COMMENTER["email"])])

    def test_a_line_naming_nobody_takes_the_parents_assignees(self):
        out = self.convert(self.line()["id"])
        self.assertEqual(out["subtask"]["assigneeIds"], [EDITOR["email"]])

    def test_a_ticked_line_becomes_a_completed_subtask(self):
        item = self.line()
        T.update_checklist_item(item["id"], T.ChecklistItemUpdate(done=True), user=OWNER, db=self.db)
        out = self.convert(item["id"])
        self.assertTrue(out["subtask"]["completed"])
        self.assertEqual((out["task"]["checklistTotal"], out["task"]["checklistDone"]), (0, 0))

    def test_viewer_and_commenter_are_refused(self):
        item = self.line()
        self.assertEqual(self.code(lambda: self.convert(item["id"], user=VIEWER)), 403)
        self.assertEqual(self.code(lambda: self.convert(item["id"], user=COMMENTER)), 403)
        self.assertEqual(self.code(lambda: self.convert(item["id"], user=OUTSIDER)), 403)
        self.assertEqual(len(T.list_checklist(self.parent.id, user=OWNER, db=self.db)), 1)
        self.assertEqual(self.task_row(self.parent.id).subtask_ids, [])
        self.assertEqual(self.convert(item["id"], user=EDITOR)["subtask"]["title"], "Call the vendor")

    def test_company_wall(self):
        item = self.line()
        self.arm_walls()
        self.assertEqual(self.code(lambda: self.convert(item["id"], user=OTHERCO)), 404)

    def test_an_item_that_has_gone_is_a_409(self):
        item = self.line()
        self.convert(item["id"])
        self.assertIn("no longer there", self.detail(lambda: self.convert(item["id"])))
        other = self.line("Another")
        T.delete_checklist_item(other["id"], user=OWNER, db=self.db)
        self.assertEqual(self.code(lambda: self.convert(other["id"])), 409)
        self.assertEqual(self.code(lambda: self.convert("no-such-item")), 409)

    def test_an_item_removed_while_we_waited_is_a_409(self):
        # SQLite has no row locks, so the other request's removal is run in
        # the gap between the first read and the locked re-read (inside the
        # HR check, which sits there): the re-read must find the line gone.
        item = self.line()
        orig = T._is_hr_checklist_task

        def meanwhile(db, t):
            db2 = database.SessionLocal()
            try:
                T.delete_checklist_item(item["id"], user=OWNER, db=db2)
            finally:
                db2.close()
            return orig(db, t)
        with mock.patch.object(T, "_is_hr_checklist_task", meanwhile):
            self.assertEqual(self.code(lambda: self.convert(item["id"])), 409)
        self.assertEqual(self.task_row(self.parent.id).subtask_ids, [])
        self.assertEqual(self.db.query(models.Task).filter_by(parent_task_id=self.parent.id).count(), 0)

    def test_a_restricted_parent_makes_a_restricted_subtask(self):
        secret = self.task(project_id="", access_level="restricted", owner_email=OWNER["email"],
                           assignee_emails=[OWNER["email"]], assignee_email=OWNER["email"])
        item = self.line(t=secret)
        # A private task stays hidden: 404 to somebody who cannot see it.
        self.assertEqual(self.code(lambda: self.convert(item["id"], user=OUTSIDER)), 404)
        out = self.convert(item["id"])
        self.assertEqual(out["subtask"]["accessLevel"], "restricted")
        # Somebody who cannot see the parent cannot see the subtask either.
        self.assertEqual(self.code(lambda: T.list_checklist(out["subtask"]["id"], user=OUTSIDER, db=self.db)), 404)
        # An org parent in a restricted project: the project's level, as for any subtask.
        out = self.convert(self.line()["id"])
        self.assertEqual(out["subtask"]["accessLevel"], "restricted")

    def test_an_assignee_no_longer_in_the_directory_is_dropped(self):
        item = self.line(assignee_email=COMMENTER["email"])
        self.db.query(models.TaskChecklistItem).filter_by(id=item["id"]).update({"assignee_email": LEFT})
        self.db.commit()
        out = self.convert(item["id"])
        self.assertEqual(out["subtask"]["assigneeIds"], [])
        self.assertEqual([d["email"] for d in out["subtask"]["droppedPeople"]], [LEFT])
        noted = self.db.query(models.TaskActivity).filter_by(entity_id=out["subtask"]["id"],
                                                             type="people_not_added").count()
        self.assertEqual(noted, 1)

    def test_hr_checklist_tasks_are_refused(self):
        hr = self.task(hr_checklist=True)
        item = self.line(t=hr)
        self.assertEqual(self.detail(lambda: self.convert(item["id"])),
                         "This is an HR checklist task. Its subtasks come from the HR checklist, "
                         "so this item stays on the checklist.")
        self.assertEqual(len(T.list_checklist(hr.id, user=OWNER, db=self.db)), 1)
        # A step's subtask (linked from an HR checklist row) too.
        step = self.task(parent_task_id=hr.id)
        self.db.add(models.HrChecklistItem(id=gen_id(), checklist_id="cl", task_id=step.id, title="Step"))
        self.db.commit()
        self.db.query(models.Task).filter_by(id=step.id).update({"hr_checklist": False})
        self.db.commit()
        item = self.line(t=step)
        self.assertEqual(self.code(lambda: self.convert(item["id"])), 422)

    def test_a_ticked_line_becomes_a_subtask_quietly(self):
        item = self.line(assignee_email=COMMENTER["email"])
        T.update_checklist_item(item["id"], T.ChecklistItemUpdate(done=True), user=OWNER, db=self.db)
        bells = self.db.query(models.NexusNotification).count()   # the line's own hand-off bell
        out = self.convert(item["id"])
        self.assertTrue(out["subtask"]["completed"])
        self.assertEqual(self.db.query(models.TaskNotification).filter_by(task_id=out["subtask"]["id"]).count(), 0)
        self.assertEqual(self.db.query(models.NexusNotification).count(), bells)
        self.assertNotIn(T.notify_task_event, [job.func for job in self.bg.tasks])

    def test_every_checklist_write_locks_the_task_before_the_line(self):
        a = self.line("A")
        b = self.line("B")
        c = self.line("C")
        order = []
        real_task, real_line = T._lock_task_rows, T._relock_line

        def lock_task(db, ids, **kw):
            order.append("task")
            return real_task(db, ids, **kw)

        def lock_line(db, t, item_id):
            order.append("line")
            return real_line(db, t, item_id)
        writes = (
            lambda: T.add_checklist_items(self.parent.id, T.ChecklistItemCreate(title="D"), user=OWNER, db=self.db),
            lambda: T.update_checklist_item(a["id"], T.ChecklistItemUpdate(done=True), user=OWNER, db=self.db),
            lambda: T.delete_checklist_item(b["id"], user=OWNER, db=self.db),
            lambda: T.reorder_checklist(self.parent.id, T.ChecklistOrder(ids=[c["id"], a["id"]]), user=OWNER, db=self.db),
            lambda: self.convert(c["id"]),
        )
        with mock.patch.object(T, "_lock_task_rows", lock_task), mock.patch.object(T, "_relock_line", lock_line):
            for w in writes:
                order.clear()
                w()
                self.assertEqual(order[0], "task", order)
                if "line" in order:
                    self.assertLess(order.index("task"), order.index("line"))

    def test_a_line_removed_while_waiting_on_the_task(self):
        # SQLite has no row locks: the other request's removal runs inside
        # the task lock call, and the line re-read after it finds it gone.
        def removing(item_id):
            real = T._lock_task_rows
            state = {"done": False}

            def fake(db, ids, **kw):
                if not state["done"]:
                    state["done"] = True
                    db2 = database.SessionLocal()
                    try:
                        db2.query(models.TaskChecklistItem).filter_by(id=item_id).delete()
                        db2.commit()
                    finally:
                        db2.close()
                return real(db, ids, **kw)
            return mock.patch.object(T, "_lock_task_rows", fake)
        a = self.line("A")
        with removing(a["id"]):
            self.assertEqual(self.code(lambda: self.convert(a["id"])), 409)
        b = self.line("B")
        with removing(b["id"]):
            self.assertEqual(self.code(lambda: T.update_checklist_item(
                b["id"], T.ChecklistItemUpdate(done=True), user=OWNER, db=self.db)), 404)
        c = self.line("C")
        with removing(c["id"]):
            self.assertEqual(self.code(lambda: T.delete_checklist_item(c["id"], user=OWNER, db=self.db)), 404)
        self.assertEqual(self.db.query(models.Task).filter_by(parent_task_id=self.parent.id).count(), 0)

    def test_a_trashed_parent_is_not_found(self):
        item = self.line()
        self.parent.deleted_at = now_iso()
        self.db.commit()
        self.assertEqual(self.code(lambda: self.convert(item["id"])), 404)


# ── A subtask is never wider than its parent ─────────────────────────────────
class SubtaskPrivacyTests(Base):
    """Pre-existing gap fixed Oct 22 2026: Add Subtask under a private task
    with no project made an org-wide subtask (the level came from the
    project only); a move kept the moved rows' own level."""

    def setUp(self):
        super().setUp()
        self.bg = BackgroundTasks()
        self.secret = self.task(project_id="", access_level="restricted", owner_email=OWNER["email"])

    def create(self, **kw):
        return T.create_task(T.TaskCreate(**kw), self.bg, user=OWNER, db=self.db)

    def level(self, tid):
        return self.task_row(tid).access_level

    def test_add_subtask_under_a_private_task(self):
        sub = self.create(title="Sub", parent_task_id=self.secret.id)
        self.assertEqual(sub["accessLevel"], "restricted")
        # An explicit org-wide level is narrowed, never wider than the parent.
        sub = self.create(title="Sub 2", parent_task_id=self.secret.id, access_level="org")
        self.assertEqual(sub["accessLevel"], "restricted")
        self.assertEqual(self.code(lambda: T.list_checklist(sub["id"], user=OUTSIDER, db=self.db)), 404)
        # Under an org-wide task with no project nothing changes.
        open_parent = self.task(project_id="", access_level="org")
        self.assertEqual(self.create(title="Sub 3", parent_task_id=open_parent.id)["accessLevel"], "org")

    def test_duplicate_with_subtasks(self):
        # The drawer's Duplicate: the copy carries the private level
        # (duplicateTaskData), then each subtask is made under the copy.
        copy = self.create(title="Pump (copy)", access_level="restricted")
        sub = self.create(title="Step (copy)", parent_task_id=copy["id"])
        self.assertEqual(sub["accessLevel"], "restricted")
        sub = self.create(title="Step 2 (copy)", parent_task_id=copy["id"], access_level="org")
        self.assertEqual(sub["accessLevel"], "restricted")

    def test_move_under_a_private_task_narrows_the_subtree(self):
        top = self.task(project_id="", access_level="org")
        kid = self.task(project_id="", access_level="org", parent_task_id=top.id)
        top.subtask_ids = [kid.id]
        self.db.commit()
        T.update_task(top.id, T.TaskUpdate(parent_task_id=self.secret.id), self.bg, user=OWNER, db=self.db)
        self.assertEqual((self.level(top.id), self.level(kid.id)), ("restricted", "restricted"))
        moved = self.db.query(models.TaskActivity).filter_by(entity_id=top.id, type="moved").one()
        self.assertIn("now private", moved.detail)
        self.assertEqual(self.code(lambda: T.list_checklist(kid.id, user=OUTSIDER, db=self.db)), 404)

    def test_a_move_never_widens(self):
        private = self.task(project_id="", access_level="restricted", owner_email=OWNER["email"])
        open_parent = self.task(project_id="", access_level="org")
        T.update_task(private.id, T.TaskUpdate(parent_task_id=open_parent.id), self.bg, user=OWNER, db=self.db)
        self.assertEqual(self.level(private.id), "restricted")
        moved = self.db.query(models.TaskActivity).filter_by(entity_id=private.id, type="moved").one()
        self.assertNotIn("now private", moved.detail)

    # Integration (Oct 22 2026): the rule holds on every path, not only on
    # create and move - an edit, the parent going private, a repeat.
    def test_a_subtask_under_a_private_task_cannot_be_opened_up(self):
        sub = self.create(title="Sub", parent_task_id=self.secret.id)
        self.assertEqual(self.code(lambda: T.update_task(sub["id"], T.TaskUpdate(access_level="org"), self.bg,
                                                         user=OWNER, db=self.db)), 422)
        self.assertEqual(self.level(sub["id"]), "restricted")
        # Opening the parent first opens the way.
        T.update_task(self.secret.id, T.TaskUpdate(access_level="org"), self.bg, user=OWNER, db=self.db)
        T.update_task(sub["id"], T.TaskUpdate(access_level="org"), self.bg, user=OWNER, db=self.db)
        self.assertEqual(self.level(sub["id"]), "org")

    def test_making_a_task_private_takes_its_open_subtasks_with_it(self):
        top = self.task(project_id="", access_level="org", owner_email=OWNER["email"])
        kid = self.task(project_id="", access_level="org", parent_task_id=top.id)
        grandkid = self.task(project_id="", access_level="org", parent_task_id=kid.id)
        top.subtask_ids, kid.subtask_ids = [kid.id], [grandkid.id]
        self.db.commit()
        T.update_task(top.id, T.TaskUpdate(access_level="restricted"), self.bg, user=OWNER, db=self.db)
        self.assertEqual([self.level(x.id) for x in (top, kid, grandkid)], ["restricted"] * 3)
        self.assertEqual(self.code(lambda: T.list_checklist(grandkid.id, user=OUTSIDER, db=self.db)), 404)

    def test_a_repeat_never_makes_a_wider_copy(self):
        # An org-wide subtask left under a private task from before the rule:
        # its next occurrence, and the copy a repeating private task carries,
        # are private.
        rule = {"freq": "weekly", "interval": 1, "daysOfWeek": [1]}
        own = self.task(project_id="", access_level="org", parent_task_id=self.secret.id,
                        due_on="2026-10-19", recurrence=dict(rule))
        nxt = T._spawn_next_occurrence(self.db, own, OWNER, notify=False)
        self.db.commit()
        self.assertEqual(nxt.access_level, "restricted")
        main = self.task(project_id="", access_level="restricted", owner_email=OWNER["email"],
                         due_on="2026-10-19", recurrence=dict(rule))
        legacy = self.task(project_id="", access_level="org", parent_task_id=main.id)
        main.subtask_ids = [legacy.id]
        self.db.commit()
        T.update_task(main.id, T.TaskUpdate(completed=True), self.bg, user=OWNER, db=self.db)
        self.db.expire_all()
        nxt_main = self.db.query(models.Task).filter(models.Task.title == main.title, models.Task.id != main.id,
                                                     models.Task.recurrence.isnot(None),
                                                     models.Task.parent_task_id == "").all()
        copies = self.db.query(models.Task).filter(models.Task.parent_task_id.in_([m.id for m in nxt_main])).all()
        self.assertTrue(copies)
        self.assertTrue(all(c.access_level == "restricted" for c in copies))


if __name__ == "__main__":
    unittest.main()
