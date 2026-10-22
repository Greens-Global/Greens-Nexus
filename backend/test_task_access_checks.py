"""Tasks per-task access checks (Oct 21 2026).

- A RESTRICTED task with no project: project_role_for reads "no project" as
  editor for everyone, so anybody holding its id could edit, delete, comment
  on, attach to or save it as a template. Now the task must also be one the
  caller can see (owner, creator, assignee, collaborator; managers).
- Dependencies: the other end of an edge must be a task the caller can see
  and edit.
- Attachments point at a file uploaded to Nexus (or an inline data: file),
  never javascript: / an outside link.
- New assignees / collaborators must be current directory people.
- Only an owner / creator / project editor / manager opens a restricted task
  to the whole organization - not an assignee as such.
- Moving or linking a task into a project takes editor there.
- Required custom fields: an edit may not clear one or move the task into a
  project where one is empty; unrelated edits of older tasks still save.
- Clearing a due date and then setting a later one is an extension.

Throwaway SQLite, no network.  python -m pytest test_task_access_checks.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import cache
import database
import models
from routers import task_config as C
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

OWNER = {"email": "owner@greensglobal.com", "level": 1}
ASSIGNEE = {"email": "assignee@greensglobal.com", "level": 1}
FOLLOWER = {"email": "follower@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
MANAGER = {"email": "manager@greensglobal.com", "level": 3}
DIRECTORY = [OWNER, ASSIGNEE, FOLLOWER, OUTSIDER, MANAGER]


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
                  models.NexusEmployee, models.TaskCustomField, models.TaskTemplate, models.TaskTeam,
                  models.NexusSetting, models.TaskChecklistItem):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u in DIRECTORY:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"],
                                             first_name=u["email"].split("@")[0], status="active"))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email="leaver@greensglobal.com",
                                         first_name="Leaver", status="offboarded"))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()

    def task(self, **kw):
        kw.setdefault("title", "T")
        kw.setdefault("status", "not_started")
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def secret(self, **kw):
        """A restricted task with no project: owner, creator, one assignee, one follower."""
        kw.setdefault("access_level", "restricted")
        return self.task(owner_email=OWNER["email"], created_by=OWNER["email"],
                         assignee_email=ASSIGNEE["email"], assignee_emails=[ASSIGNEE["email"]],
                         follower_emails=[FOLLOWER["email"]], **kw)

    def project(self, **kw):
        kw.setdefault("access_level", "restricted")
        p = models.TaskProject(id=gen_id(), name=kw.pop("name", "Locked"), created_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def patch(self, t, user, **fields):
        return T.update_task(t.id, T.TaskUpdate(**fields), BackgroundTasks(), user=user, db=self.db)


class StandaloneRestrictedTests(Base):
    def test_an_outsider_cannot_touch_a_restricted_standalone_task(self):
        t = self.secret()
        self.assertEqual(self.code(lambda: self.patch(t, OUTSIDER, title="mine now")), 404)
        self.assertEqual(self.code(lambda: T.delete_task(t.id, BackgroundTasks(), user=OUTSIDER, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.add_comment(t.id, T.CommentCreate(body="hi"), BackgroundTasks(),
                                                         user=OUTSIDER, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.add_attachment(t.id, T.AttachmentCreate(name="f", url="data:x"),
                                                            user=OUTSIDER, db=self.db)), 404)
        self.assertEqual(self.code(lambda: C.save_task_as_template(t.id, C.SaveAsTemplateBody(),
                                                                   user=OUTSIDER, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.create_task(T.TaskCreate(title="sub", parent_task_id=t.id),
                                                         BackgroundTasks(), user=OUTSIDER, db=self.db)), 404)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, t.id).title, "T")

    def test_everyone_on_it_and_a_manager_still_can(self):
        t = self.secret()
        for i, who in enumerate((OWNER, ASSIGNEE, FOLLOWER, MANAGER)):
            self.assertEqual(self.patch(t, who, title=f"v{i}")["title"], f"v{i}")
        T.add_comment(t.id, T.CommentCreate(body="ok"), BackgroundTasks(), notify=False, user=FOLLOWER, db=self.db)

    def test_an_org_standalone_task_is_unchanged(self):
        t = self.task(access_level="org", created_by=OWNER["email"])
        self.assertEqual(self.patch(t, OUTSIDER, title="edited")["title"], "edited")

    def test_an_external_cannot_edit_an_org_project_task_they_were_never_given(self):
        guest = {"email": "guest@partner.com", "level": 1, "external": True}
        p = self.project(access_level="org", name="Open")
        t = self.task(project_id=p.id, access_level="org")
        self.assertEqual(self.code(lambda: self.patch(t, guest, title="x")), 404)
        p2 = self.project(access_level="org", name="Shared", member_emails=[guest["email"]])
        t2 = self.task(project_id=p2.id, access_level="org")
        self.assertEqual(self.patch(t2, guest, title="ok")["title"], "ok")   # a member of that one

    def test_deleting_a_comment_or_file_on_a_task_you_cannot_see(self):
        t = self.secret()
        c = models.TaskComment(id=gen_id(), task_id=t.id, author_email=OUTSIDER["email"], body="x",
                               created_at=now_iso())
        a = models.TaskAttachment(id=gen_id(), task_id=t.id, name="f", url="data:x", added_by=OUTSIDER["email"])
        self.db.add_all([c, a])
        self.db.commit()
        self.assertEqual(self.code(lambda: T.delete_comment(c.id, user=OUTSIDER, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.delete_attachment(a.id, user=OUTSIDER, db=self.db)), 404)


class DependencyTests(Base):
    def test_blocking_a_task_you_cannot_see_is_refused(self):
        mine = self.task(access_level="org", created_by=OUTSIDER["email"])
        hidden = self.secret()
        self.assertEqual(self.code(lambda: self.patch(mine, OUTSIDER, blocking_ids=[hidden.id])), 404)
        self.assertEqual(self.code(lambda: self.patch(mine, OUTSIDER, blocked_by_ids=[hidden.id])), 404)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, hidden.id).blocked_by_ids or [], [])

    def test_blocking_a_task_you_can_only_view_is_refused(self):
        p = self.project(member_roles={OUTSIDER["email"]: "viewer"}, member_emails=[OUTSIDER["email"]])
        mine = self.task(access_level="org", created_by=OUTSIDER["email"])
        theirs = self.task(project_id=p.id, access_level="restricted")
        self.assertEqual(self.code(lambda: self.patch(mine, OUTSIDER, blocking_ids=[theirs.id])), 403)

    def test_a_blocker_out_of_sight_can_still_be_removed(self):
        hidden = self.secret()
        mine = self.task(access_level="org", created_by=OUTSIDER["email"], blocked_by_ids=[hidden.id])
        hidden.blocking_ids = [mine.id]
        self.db.commit()
        out = self.patch(mine, OUTSIDER, blocked_by_ids=[])
        self.assertEqual(out["blockedByIds"], [])

    def test_editable_dependencies_and_the_cycle_guard_still_work(self):
        a = self.task(access_level="org")
        b = self.task(access_level="org")
        self.patch(a, OUTSIDER, blocked_by_ids=[b.id])
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, b.id).blocking_ids, [a.id])
        self.assertEqual(self.code(lambda: self.patch(b, OUTSIDER, blocked_by_ids=[a.id])), 422)


class AttachmentUrlTests(Base):
    def _add(self, url):
        t = self.task(access_level="org")
        return T.add_attachment(t.id, T.AttachmentCreate(name="f.png", url=url), user=OUTSIDER, db=self.db)

    def test_script_and_odd_schemes_are_refused(self):
        for url in ("javascript:alert(1)", "JavaScript:alert(1)", "vbscript:x", "file:///etc/passwd", "//evil.com/x"):
            self.assertEqual(self.code(lambda u=url: self._add(u)), 400, url)

    def test_only_our_storage_when_storage_is_configured(self):
        import routers.items as items
        with mock.patch.object(items, "_STORAGE_PREFIX", "https://proj.supabase.co/storage/v1/object/public/"):
            self.assertEqual(self.code(lambda: self._add("https://evil.example.com/x.png")), 400)
            ok = self._add("https://proj.supabase.co/storage/v1/object/public/task-files/tasks/1.png")
            self.assertTrue(ok["url"].endswith("1.png"))

    def test_inline_and_blank_files_still_save(self):
        self.assertEqual(self._add("data:image/png;base64,AAAA")["name"], "f.png")
        self.assertEqual(self._add("")["name"], "f.png")


class PeopleTests(Base):
    def test_an_outside_address_cannot_be_assigned_or_follow(self):
        self.assertEqual(self.code(lambda: T.create_task(T.TaskCreate(title="x", assignee_emails=["x@gmail.com"]),
                                                         BackgroundTasks(), user=OWNER, db=self.db)), 422)
        self.assertEqual(self.code(lambda: T.create_task(T.TaskCreate(title="x", follower_emails=["x@gmail.com"]),
                                                         BackgroundTasks(), user=OWNER, db=self.db)), 422)
        t = self.task(access_level="org")
        self.assertEqual(self.code(lambda: self.patch(t, OWNER, assignee_emails=["x@gmail.com"])), 422)
        self.assertEqual(self.code(lambda: self.patch(t, OWNER, follower_emails=["leaver@greensglobal.com"])), 422)
        self.assertEqual(self.code(lambda: T.bulk_update(T.BulkUpdate(ids=[t.id], patch={"assignee_emails": ["x@gmail.com"]}),
                                                         user=OWNER, db=self.db)), 422)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, t.id).assignee_emails or [], [])

    def test_people_already_on_a_task_are_not_rechecked(self):
        t = self.task(access_level="org", assignee_email="leaver@greensglobal.com",
                      assignee_emails=["leaver@greensglobal.com"], follower_emails=["gone@old.com"])
        out = self.patch(t, OWNER, title="still editable", assignee_emails=["leaver@greensglobal.com", ASSIGNEE["email"]])
        self.assertEqual(out["assigneeIds"], ["leaver@greensglobal.com", ASSIGNEE["email"]])

    def test_the_caller_can_always_follow(self):
        stranger = {"email": "admin-service@greensglobal.com", "level": 1}   # not on the People list
        t = self.task(access_level="org")
        out = self.patch(t, stranger, follower_emails=[stranger["email"]])
        self.assertIn(stranger["email"], out["followerIds"])


class OpenUpTests(Base):
    def test_only_owner_creator_project_editor_or_manager_open_a_task_up(self):
        t = self.secret()
        self.assertEqual(self.code(lambda: self.patch(t, ASSIGNEE, access_level="org")), 403)
        self.assertEqual(self.code(lambda: self.patch(t, FOLLOWER, access_level="org")), 403)
        self.assertEqual(self.patch(t, OWNER, access_level="org")["accessLevel"], "org")
        t2 = self.secret()
        self.assertEqual(self.patch(t2, MANAGER, access_level="org")["accessLevel"], "org")
        # In a project: its editors may (the assignee here is only a viewer).
        p = self.project(member_roles={FOLLOWER["email"]: "editor", ASSIGNEE["email"]: "viewer"},
                         member_emails=[FOLLOWER["email"], ASSIGNEE["email"]])
        t3 = self.secret(project_id=p.id)
        self.assertEqual(self.code(lambda: self.patch(t3, ASSIGNEE, access_level="org")), 403)
        self.assertEqual(self.patch(t3, FOLLOWER, access_level="org")["accessLevel"], "org")
        # Narrowing is not widening: an assignee may still restrict.
        t4 = self.task(access_level="org", assignee_emails=[ASSIGNEE["email"]])
        self.assertEqual(self.patch(t4, ASSIGNEE, access_level="restricted")["accessLevel"], "restricted")


class MoveIntoProjectTests(Base):
    def test_moving_into_a_project_takes_editor_there(self):
        locked = self.project()
        t = self.task(access_level="org", created_by=OUTSIDER["email"])
        self.assertEqual(self.code(lambda: self.patch(t, OUTSIDER, project_id=locked.id)), 403)
        self.assertEqual(self.code(lambda: self.patch(t, OUTSIDER, project_ids=[locked.id])), 403)
        self.assertEqual(self.code(lambda: T.bulk_update(T.BulkUpdate(ids=[t.id], patch={"project_id": locked.id}),
                                                         user=OUTSIDER, db=self.db)), 403)
        self.assertEqual(self.code(lambda: self.patch(t, OUTSIDER, project_id="no-such-project")), 404)
        mine = self.project(member_roles={OUTSIDER["email"]: "editor"}, member_emails=[OUTSIDER["email"]])
        self.assertEqual(self.patch(t, OUTSIDER, project_id=mine.id)["projectId"], mine.id)
        # Out of a project again needs nothing more than editing the task.
        self.assertIsNone(self.patch(t, OUTSIDER, project_id="")["projectId"])


class RequiredFieldTests(Base):
    def setUp(self):
        super().setUp()
        self.p = self.project(access_level="org", name="Ops")
        self.q = self.project(access_level="org", name="Finance")
        self.db.add(models.TaskCustomField(id="prop", name="Property", type="text",
                                           required_project_ids=[self.p.id, self.q.id]))
        self.db.commit()

    def test_an_older_task_missing_the_value_still_takes_unrelated_edits(self):
        t = self.task(project_id=self.p.id, access_level="org")
        self.assertEqual(self.patch(t, OWNER, title="Renamed")["title"], "Renamed")
        T.bulk_update(T.BulkUpdate(ids=[t.id], patch={"priority": "high"}), user=OWNER, db=self.db)

    def test_clearing_a_required_value_is_refused(self):
        t = self.task(project_id=self.p.id, access_level="org", custom_field_values={"prop": "Escondido"})
        self.assertEqual(self.code(lambda: self.patch(t, OWNER, custom_field_values={})), 422)
        self.assertEqual(self.code(lambda: T.bulk_update(
            T.BulkUpdate(ids=[t.id], patch={"custom_field_values": {"prop": ""}}), user=OWNER, db=self.db)), 422)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, t.id).custom_field_values, {"prop": "Escondido"})

    def test_moving_into_a_project_where_it_is_empty_is_refused(self):
        t = self.task(access_level="org")
        self.assertEqual(self.code(lambda: self.patch(t, OWNER, project_id=self.p.id)), 422)
        self.assertEqual(self.code(lambda: T.bulk_update(T.BulkUpdate(ids=[t.id], patch={"project_id": self.p.id}),
                                                         user=OWNER, db=self.db)), 422)
        self.assertEqual(self.patch(t, OWNER, project_id=self.p.id,
                                    custom_field_values={"prop": "Escondido"})["projectId"], self.p.id)


class DueClearTests(Base):
    def test_clearing_then_pushing_past_the_approval_line_is_held_for_approval(self):
        # Two extensions already: the next one needs approval. Clearing the date
        # first used to make the new date "a first date" and skip the ask.
        t = self.task(access_level="org", created_by=OWNER["email"], assignee_emails=[ASSIGNEE["email"]],
                      due_on="2026-10-10", due_agreement="accepted", due_extension_count=2,
                      due_history=[{"at": now_iso(), "from": "", "to": "2026-10-01", "by": OWNER["email"],
                                    "source": "app", "extension": False},
                                   {"at": now_iso(), "from": "2026-10-01", "to": "2026-10-05", "by": ASSIGNEE["email"],
                                    "source": "app", "extension": True},
                                   {"at": now_iso(), "from": "2026-10-05", "to": "2026-10-10", "by": ASSIGNEE["email"],
                                    "source": "app", "extension": True}])
        self.patch(t, ASSIGNEE, due_on="")
        self.db.refresh(t)
        self.assertEqual(t.due_history[-1].get("agreement"), "accepted")
        self.patch(t, ASSIGNEE, due_on="2026-10-20")
        self.db.refresh(t)
        self.assertEqual(t.due_agreement, "extension_requested")
        self.assertEqual((t.due_proposal or {}).get("dueOn"), "2026-10-20")
        self.assertEqual(t.due_extension_count, 2)   # not counted until approved

    def test_an_unconfirmed_target_cleared_and_reset_is_still_negotiation(self):
        t = T.create_task(T.TaskCreate(title="x", assignee_emails=[ASSIGNEE["email"]], due_on="2026-10-10"),
                          BackgroundTasks(), user=OWNER, db=self.db)
        row = self.db.get(models.Task, t["id"])
        self.assertEqual(row.due_agreement, "pending")
        self.patch(row, OWNER, due_on="")
        self.patch(row, OWNER, due_on="2026-10-20")
        self.db.refresh(row)
        self.assertEqual(row.due_extension_count, 0)


if __name__ == "__main__":
    unittest.main()
