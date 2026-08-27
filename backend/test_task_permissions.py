"""
Permission regression tests for the task router.

These endpoints were ALL unguarded (QA audit, Aug 2026): bulk_update bypassed
the editor check PATCH /tasks/{id} enforces, comment edit/delete took no `user`
at all so anyone could rewrite or remove anyone's comment, and the section and
attachment endpoints had no role check either.

Each test below asserts a DENIAL - the case that was silently allowed before -
so a future refactor that drops a guard fails here instead of shipping.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_permissions -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException, BackgroundTasks

import database
import models
from routers.task_util import gen_id, now_iso, project_role_for
from routers.tasks import (
    bulk_update, edit_comment, delete_comment, add_attachment, delete_attachment,
    create_section, update_section, delete_section, update_task, delete_task, add_comment,
    search_everything, person_profile,
    BulkUpdate, CommentUpdate, CommentCreate, AttachmentCreate, SectionBody, TaskUpdate,
)

# level < 3 -> not a manager, so project roles actually apply (is_manager
# bypasses everything, which is why every test here uses a plain employee).
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
AUTHOR = {"email": "author@greensglobal.com", "level": 1}
MANAGER = {"email": "boss@greensglobal.com", "level": 3}


class TaskPermissionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.TaskAttachment,
                  models.TaskSection, models.TaskProject, models.TaskTeam,
                  models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()
        # A restricted project the outsider has no role on.
        self.project = models.TaskProject(id=gen_id(), name="Locked", access_level="restricted",
                                          owner_email=AUTHOR["email"], member_roles={},
                                          created_at=now_iso())
        self.db.add(self.project)
        self.task = models.Task(id=gen_id(), title="T", code="TASK-1", access_level="restricted",
                                project_id=self.project.id, created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.task)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _comment(self, author=AUTHOR["email"]):
        c = models.TaskComment(id=gen_id(), task_id=self.task.id, author_email=author,
                               body="<p>original</p>", created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        return c

    def _attachment(self, added_by=AUTHOR["email"]):
        a = models.TaskAttachment(id=gen_id(), task_id=self.task.id, name="f.png",
                                  kind="image", url="data:x", added_at=now_iso(), added_by=added_by)
        self.db.add(a)
        self.db.commit()
        return a

    # ── bulk_update ──────────────────────────────────────────────────────
    def test_bulk_update_denies_a_user_without_editor(self):
        """The bypass: _BULK_ALLOWED covers assignee/project/completed/due_on,
        so this was a way to mutate a task you could only view."""
        with self.assertRaises(HTTPException) as ctx:
            bulk_update(BulkUpdate(ids=[self.task.id], patch={"completed": True}),
                        user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertFalse(self.db.get(models.Task, self.task.id).completed)

    def test_bulk_update_is_all_or_nothing(self):
        """One forbidden id fails the whole call - a partial apply would leave
        the caller unable to tell which ids were skipped."""
        open_task = models.Task(id=gen_id(), title="Open", access_level="org",
                                created_at=now_iso(), modified_at=now_iso())
        self.db.add(open_task)
        self.db.commit()
        with self.assertRaises(HTTPException):
            bulk_update(BulkUpdate(ids=[open_task.id, self.task.id], patch={"priority": "high"}),
                        user=OUTSIDER, db=self.db)
        self.db.rollback()
        self.assertNotEqual(self.db.get(models.Task, open_task.id).priority, "high")

    def test_bulk_update_allows_a_manager(self):
        bulk_update(BulkUpdate(ids=[self.task.id], patch={"priority": "high"}),
                    user=MANAGER, db=self.db)
        self.assertEqual(self.db.get(models.Task, self.task.id).priority, "high")

    # ── comments ─────────────────────────────────────────────────────────
    def test_only_the_author_may_edit_a_comment_body(self):
        c = self._comment()
        with self.assertRaises(HTTPException) as ctx:
            edit_comment(c.id, CommentUpdate(body="<p>hijacked</p>"), user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertEqual(self.db.get(models.TaskComment, c.id).body, "<p>original</p>")

    def test_even_a_manager_may_not_rewrite_someone_elses_comment(self):
        """Managers bypass every other project-role check here, but rewriting
        another person's words is different in kind from access."""
        c = self._comment()
        with self.assertRaises(HTTPException):
            edit_comment(c.id, CommentUpdate(body="<p>edited by boss</p>"), user=MANAGER, db=self.db)
        self.db.rollback()
        self.assertEqual(self.db.get(models.TaskComment, c.id).body, "<p>original</p>")

    def test_the_author_can_edit_their_own_comment(self):
        c = self._comment()
        edit_comment(c.id, CommentUpdate(body="<p>fixed a typo</p>"), user=AUTHOR, db=self.db)
        self.assertEqual(self.db.get(models.TaskComment, c.id).body, "<p>fixed a typo</p>")

    def test_pinning_requires_editor_not_authorship(self):
        c = self._comment()
        with self.assertRaises(HTTPException) as ctx:
            edit_comment(c.id, CommentUpdate(pinned=True), user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        edit_comment(c.id, CommentUpdate(pinned=True), user=MANAGER, db=self.db)
        self.assertTrue(self.db.get(models.TaskComment, c.id).pinned)

    def test_an_outsider_cannot_delete_a_comment(self):
        c = self._comment()
        with self.assertRaises(HTTPException) as ctx:
            delete_comment(c.id, user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(models.TaskComment, c.id))

    def test_the_author_can_delete_their_own_comment(self):
        c = self._comment()
        delete_comment(c.id, user=AUTHOR, db=self.db)
        self.assertIsNone(self.db.get(models.TaskComment, c.id))

    def test_an_editor_can_moderate_someone_elses_comment(self):
        c = self._comment()
        delete_comment(c.id, user=MANAGER, db=self.db)
        self.assertIsNone(self.db.get(models.TaskComment, c.id))

    # ── attachments ──────────────────────────────────────────────────────
    def test_an_outsider_cannot_attach_to_a_restricted_task(self):
        with self.assertRaises(HTTPException) as ctx:
            add_attachment(self.task.id, AttachmentCreate(name="x.png", url="data:x"),
                           user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_attaching_needs_only_commenter_so_comment_attachments_still_work(self):
        """Deliberately NOT editor: a commenter attaches files while composing a
        comment, and requiring editor would 403 exactly that flow."""
        self.project.member_roles = {AUTHOR["email"]: "commenter"}
        self.db.commit()
        a = add_attachment(self.task.id, AttachmentCreate(name="ok.png", url="data:x"),
                           user=AUTHOR, db=self.db)
        self.assertEqual(a["name"], "ok.png")

    def test_an_outsider_cannot_delete_someone_elses_attachment(self):
        a = self._attachment()
        with self.assertRaises(HTTPException) as ctx:
            delete_attachment(a.id, user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(models.TaskAttachment, a.id))

    def test_the_uploader_can_remove_their_own_attachment(self):
        a = self._attachment(added_by=OUTSIDER["email"])
        delete_attachment(a.id, user=OUTSIDER, db=self.db)
        self.assertIsNone(self.db.get(models.TaskAttachment, a.id))

    # ── sections ─────────────────────────────────────────────────────────
    def test_an_outsider_cannot_create_a_section_in_a_restricted_project(self):
        with self.assertRaises(HTTPException) as ctx:
            create_section(SectionBody(project_id=self.project.id, name="Sneaky"),
                           user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)

    def test_an_outsider_cannot_rename_or_delete_a_section(self):
        s = models.TaskSection(id=gen_id(), project_id=self.project.id, name="Real",
                               position=0, created_at=now_iso())
        self.db.add(s)
        self.db.commit()
        with self.assertRaises(HTTPException):
            update_section(s.id, SectionBody(name="Renamed"), user=OUTSIDER, db=self.db)
        self.db.rollback()
        with self.assertRaises(HTTPException):
            delete_section(s.id, user=OUTSIDER, db=self.db)
        self.db.rollback()
        still = self.db.get(models.TaskSection, s.id)
        self.assertIsNotNone(still)
        self.assertEqual(still.name, "Real")

    def test_a_workspace_level_section_stays_unrestricted(self):
        """project_id "" is workspace-level, matching how a task with no project
        is treated - not something this change should start blocking."""
        out = create_section(SectionBody(project_id="", name="Global"), user=OUTSIDER, db=self.db)
        self.assertEqual(out["name"], "Global")


class HeaderSearchTests(unittest.TestCase):
    """GET /tasks/search backs the header magnifier, which used to match module
    NAMES only - typing a task's title found nothing. Search must never widen
    what someone can see, so the visibility rule is the same one the task list
    applies."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskProject, models.TaskTeam, models.TaskPortfolio,
                  models.NexusEmployee):
            self.db.query(m).delete()
        open_p = models.TaskProject(id="p-open", name="Marketing Site", access_level="org",
                                    created_at=now_iso())
        locked = models.TaskProject(id="p-locked", name="Secret Rebrand", access_level="restricted",
                                    owner_email=AUTHOR["email"], member_emails=[], member_roles={},
                                    created_at=now_iso())
        self.db.add_all([open_p, locked])
        self.db.add(models.Task(id="t-open", code="TASK-1", title="Rebrand the footer",
                                project_id="p-open", access_level="org",
                                created_at=now_iso(), modified_at=now_iso()))
        self.db.add(models.Task(id="t-secret", code="TASK-2", title="Rebrand pricing page",
                                project_id="p-locked", access_level="restricted",
                                created_at=now_iso(), modified_at=now_iso()))
        self.db.add(models.NexusEmployee(id="e1", first_name="Ashley", last_name="Vizcarra",
                                         work_email="ashley@greensglobal.com",
                                         job_title="Operations", status="active"))
        self.db.add(models.NexusEmployee(id="e2", first_name="Gone", last_name="Person",
                                         work_email="gone@greensglobal.com",
                                         job_title="Former", status="offboarded"))
        self.db.add(models.TaskPortfolio(id="pf1", name="Rebrand Portfolio", created_at=now_iso()))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _search(self, q, user=OUTSIDER):
        return search_everything(q=q, user=user, db=self.db)

    def test_it_finds_a_task_by_title(self):
        titles = [t["title"] for t in self._search("footer")["tasks"]]

        self.assertIn("Rebrand the footer", titles)

    def test_it_finds_a_task_by_code(self):
        self.assertEqual([t["code"] for t in self._search("task-1")["tasks"]], ["TASK-1"])

    def test_a_task_in_a_project_you_cannot_see_never_appears(self):
        titles = [t["title"] for t in self._search("rebrand", user=OUTSIDER)["tasks"]]

        self.assertIn("Rebrand the footer", titles)
        self.assertNotIn("Rebrand pricing page", titles, "search must not widen visibility")

    def test_a_manager_sees_the_restricted_one(self):
        titles = [t["title"] for t in self._search("rebrand", user=MANAGER)["tasks"]]

        self.assertIn("Rebrand pricing page", titles)

    def test_it_groups_projects_portfolios_and_people(self):
        out = self._search("rebrand")

        self.assertEqual([p["name"] for p in out["portfolios"]], ["Rebrand Portfolio"])
        self.assertEqual([p["name"] for p in self._search("marketing")["projects"]], ["Marketing Site"])
        self.assertEqual([p["name"] for p in self._search("ashley")["people"]], ["Ashley Vizcarra"])

    def test_offboarded_people_are_not_offered(self):
        self.assertEqual(self._search("gone")["people"], [])

    def test_a_restricted_project_is_not_listed_to_an_outsider(self):
        self.assertEqual(self._search("secret")["projects"], [])

    def test_one_character_does_not_search(self):
        """Every keystroke would otherwise scan the workspace to return
        everything, which is neither useful nor cheap."""
        r = self._search("r")
        self.assertEqual({k: v for k, v in r.items() if k != "totals"},
                         {"tasks": [], "projects": [], "portfolios": [],
                          "teams": [], "people": []})
        self.assertFalse(any((r.get("totals") or {}).values()))

    def test_a_prefix_match_outranks_a_match_in_the_middle(self):
        self.db.add(models.Task(id="t3", code="TASK-3", title="Zebra rebrand notes",
                                project_id="p-open", access_level="org",
                                created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()

        titles = [t["title"] for t in self._search("rebrand")["tasks"]]

        self.assertEqual(titles[0], "Rebrand the footer")

    def test_a_completed_task_is_not_offered(self):
        """A struck-through, checked-off row in search results reads as noise,
        not a find - work that's done is not what a search bar is for."""
        self.db.add(models.Task(id="t-done", code="TASK-4", title="Rebrand old banner",
                                project_id="p-open", access_level="org", completed=True,
                                created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()

        titles = [t["title"] for t in self._search("rebrand")["tasks"]]

        self.assertNotIn("Rebrand old banner", titles)


class PersonProfileTests(unittest.TestCase):
    """GET /tasks/people/{email} backs a person's page. Two of its four task
    buckets are relative to the VIEWER - "what did I give them" and "where do we
    overlap" - which is the point of opening somebody's page rather than reading
    their task list."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskProject, models.TaskTeam, models.NexusEmployee):
            self.db.query(m).delete()
        self.them = "ashley@greensglobal.com"
        self.me = OUTSIDER["email"]
        self.db.add(models.TaskProject(id="p1", name="Ops", access_level="org", created_at=now_iso()))
        self.db.add(models.NexusEmployee(id="e1", first_name="Ashley", last_name="Vizcarra",
                                         work_email=self.them, job_title="Ops Manager",
                                         status="active", identity_type="internal"))
        self._task("theirs alone", assignee=self.them, creator="someone@greensglobal.com")
        self._task("i gave them this", assignee=self.them, creator=self.me)
        self._task("they handed out", assignee="third@greensglobal.com", creator=self.them)
        self._task("we both follow", assignee="third@greensglobal.com",
                   creator="third@greensglobal.com", followers=[self.them, self.me])
        self._task("nothing to do with either of us", assignee="third@greensglobal.com",
                   creator="third@greensglobal.com")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _task(self, title, assignee="", creator="", followers=None):
        self.db.add(models.Task(id=gen_id(), code=f"T-{title[:4]}", title=title,
                                project_id="p1", access_level="org",
                                assignee_email=assignee, created_by=creator,
                                follower_emails=followers or [],
                                created_at=now_iso(), modified_at=now_iso()))

    def _titles(self, bucket, user=OUTSIDER):
        out = person_profile(self.them, user=user, db=self.db)
        return [t["title"] for t in out["tasks"][bucket]]

    def test_all_is_everything_assigned_to_them(self):
        self.assertEqual(sorted(self._titles("assigned")),
                         ["i gave them this", "theirs alone"])

    def test_assigned_by_you_is_only_what_the_viewer_gave_them(self):
        self.assertEqual(self._titles("assignedByYou"), ["i gave them this"])

    def test_assigned_by_them_is_what_they_handed_out(self):
        self.assertEqual(self._titles("created"), ["they handed out"])

    def test_collaborating_with_you_needs_both_of_you_on_it(self):
        self.assertEqual(self._titles("collaboratingWithYou"), ["we both follow"])

    def test_a_stranger_sees_no_relationship_buckets(self):
        stranger = {"email": "nobody@greensglobal.com", "level": 1}

        self.assertEqual(self._titles("assignedByYou", user=stranger), [])
        self.assertEqual(self._titles("collaboratingWithYou", user=stranger), [])
        self.assertEqual(sorted(self._titles("assigned", user=stranger)),
                         ["i gave them this", "theirs alone"])

    def test_your_own_page_does_not_claim_you_collaborate_with_yourself(self):
        out = person_profile(self.me, user=OUTSIDER, db=self.db)

        self.assertEqual(out["tasks"]["collaboratingWithYou"], [])

    def test_the_person_and_their_rollup_come_through(self):
        out = person_profile(self.them, user=OUTSIDER, db=self.db)

        self.assertEqual(out["person"]["name"], "Ashley Vizcarra")
        self.assertEqual(out["person"]["jobTitle"], "Ops Manager")
        self.assertTrue(out["person"]["inDirectory"])
        self.assertEqual(out["stats"]["open"], 2)

    def test_somebody_with_no_directory_row_still_gets_a_page(self):
        out = person_profile("guest@partner.com", user=OUTSIDER, db=self.db)

        self.assertFalse(out["person"]["inDirectory"])
        self.assertEqual(out["person"]["identityType"], "external")

    def test_it_never_shows_work_the_viewer_cannot_open(self):
        self.db.add(models.TaskProject(id="p2", name="Locked", access_level="restricted",
                                       owner_email="owner@greensglobal.com",
                                       member_emails=[], member_roles={}, created_at=now_iso()))
        # Created by a third party, not the viewer: task_is_visible rightly
        # grants you anything you created, so a task the viewer made would be
        # visible on its own merits and prove nothing here.
        self.db.add(models.Task(id=gen_id(), code="T-SEC", title="secret work",
                                project_id="p2", access_level="restricted",
                                assignee_email=self.them, created_by="owner@greensglobal.com",
                                created_at=now_iso(), modified_at=now_iso()))
        self.db.commit()

        self.assertNotIn("secret work", self._titles("assigned"))
        self.assertIn("secret work", self._titles("assigned", user=MANAGER))


class AssigneeOwnTaskTests(unittest.TestCase):
    """Being handed the work is the grant.

    visible_project_ids has always let an assignee SEE a project through a task
    they hold in it, but project_role_for gave them no role - so somebody
    assigned a task in a project they are not a member of could open it, watch
    it sit in My Tasks, and be refused when they tried to tick it complete.
    Scoped to that ONE task: everything else in the project still answers to
    project_role_for, and deleting is deliberately not included.
    """

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.TaskAttachment,
                  models.TaskProject, models.TaskTeam, models.TaskActivity):
            self.db.query(m).delete()
        self.project = models.TaskProject(id=gen_id(), name="GST Operations",
                                          access_level="restricted", owner_email="owner@greensglobal.com",
                                          member_emails=[], member_roles={}, created_at=now_iso())
        self.db.add(self.project)
        self.mine = self._task(assignee=OUTSIDER["email"])
        self.theirs = self._task(assignee="someone.else@greensglobal.com")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _task(self, assignee=""):
        t = models.Task(id=gen_id(), title="T", code=f"TASK-{gen_id()[:4]}", status="not_started",
                        priority="medium", access_level="restricted", project_id=self.project.id,
                        assignee_email=assignee, created_at=now_iso(), modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    def _update(self, task, user, **kw):
        return update_task(task.id, TaskUpdate(**kw), BackgroundTasks(), user=user, db=self.db)

    def test_an_assignee_can_complete_their_own_task(self):
        out = self._update(self.mine, OUTSIDER, completed=True)

        self.assertTrue(out["completed"])

    def test_an_assignee_can_edit_the_fields_of_their_own_task(self):
        out = self._update(self.mine, OUTSIDER, status="in_progress", priority="high")

        self.assertEqual((out["status"], out["priority"]), ("in_progress", "high"))

    def test_it_does_not_spread_to_anybody_elses_task(self):
        with self.assertRaises(HTTPException) as ctx:
            self._update(self.theirs, OUTSIDER, completed=True)

        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()

    def test_an_assignee_can_comment_on_their_own_task(self):
        add_comment(self.mine.id, CommentCreate(body="<p>on it</p>"), BackgroundTasks(),
                    user=OUTSIDER, db=self.db)

        self.assertEqual(self.db.query(models.TaskComment).filter_by(task_id=self.mine.id).count(), 1)

    def test_an_assignee_can_delete_their_own_task(self):
        delete_task(self.mine.id, BackgroundTasks(), user=OUTSIDER, db=self.db)

        # Trashed (Aug 27), not gone: hidden from a normal query (database.py's
        # global soft-delete filter) but still there via the same
        # include_deleted escape hatch the restore endpoint uses.
        self.assertIsNone(self.db.query(models.Task).filter(models.Task.id == self.mine.id).first())
        row = (self.db.query(models.Task).execution_options(include_deleted=True)
                 .filter(models.Task.id == self.mine.id).first())
        self.assertIsNotNone(row)
        self.assertTrue(row.deleted_at)

    def test_an_assignee_cannot_delete_somebody_elses_task(self):
        with self.assertRaises(HTTPException) as ctx:
            delete_task(self.theirs.id, BackgroundTasks(), user=OUTSIDER, db=self.db)

        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(models.Task, self.theirs.id))

    def test_deleting_your_own_task_takes_its_subtasks_with_it(self):
        """The one place this grant reaches past the task it is scoped to: the
        cascade removes children, which can belong to other people. Pinned so
        the blast radius is a decision on the record rather than a surprise."""
        child = self._task(assignee="someone.else@greensglobal.com")
        child.parent_task_id = self.mine.id
        self.mine.subtask_ids = [child.id]
        self.db.commit()

        delete_task(self.mine.id, BackgroundTasks(), user=OUTSIDER, db=self.db)

        self.assertIsNone(self.db.query(models.Task).filter(models.Task.id == child.id).first())
        row = (self.db.query(models.Task).execution_options(include_deleted=True)
                 .filter(models.Task.id == child.id).first())
        self.assertIsNotNone(row)
        self.assertTrue(row.deleted_at)

    def test_bulk_lets_an_assignee_act_on_their_own_and_no_further(self):
        rows = bulk_update(BulkUpdate(ids=[self.mine.id], patch={"completed": True}),
                           user=OUTSIDER, db=self.db)
        self.assertTrue(rows[0]["completed"])

        with self.assertRaises(HTTPException):
            bulk_update(BulkUpdate(ids=[self.mine.id, self.theirs.id], patch={"completed": True}),
                        user=OUTSIDER, db=self.db)
        self.db.rollback()

    def test_an_assignee_does_not_become_a_project_owner(self):
        """Capped at editor - this must never stand in for project settings."""
        self.assertEqual(project_role_for(self.db, OUTSIDER["email"], self.project), None)


class ShareListRoleTests(unittest.TestCase):
    """What a bare member_emails entry means.

    Reported from production: someone shown as **Editor** in the Share panel was
    refused with "You need at least editor access". The panel's role picker
    renders `memberRoles[email] || 'editor'`, so a person listed with no explicit
    role LOOKS like an editor; project_role_for counted only member_roles and
    teams, so they resolved to no role at all. A bare entry is how the Asana
    sync grants access and how every grant predating the role map was stored, so
    this covered most of a synced project's roster.
    """

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskProject, models.TaskTeam):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _project(self, **kw):
        kw.setdefault("access_level", "restricted")
        kw.setdefault("member_emails", [])
        kw.setdefault("member_roles", {})
        p = models.TaskProject(id=gen_id(), name="GST Operations",
                               owner_email="owner@greensglobal.com", created_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def test_listed_with_no_explicit_role_is_an_editor(self):
        p = self._project(member_emails=["ashley@greensglobal.com"])

        self.assertEqual(project_role_for(self.db, "ashley@greensglobal.com", p), "editor")

    def test_an_explicit_viewer_is_still_only_a_viewer(self):
        p = self._project(member_emails=["ashley@greensglobal.com"],
                          member_roles={"ashley@greensglobal.com": "viewer"})

        self.assertEqual(project_role_for(self.db, "ashley@greensglobal.com", p), "viewer")

    def test_an_explicit_commenter_is_not_promoted(self):
        p = self._project(member_emails=["ashley@greensglobal.com"],
                          member_roles={"ashley@greensglobal.com": "commenter"})

        self.assertEqual(project_role_for(self.db, "ashley@greensglobal.com", p), "commenter")

    def test_somebody_not_on_the_list_still_has_no_role(self):
        p = self._project(member_emails=["ashley@greensglobal.com"])

        self.assertIsNone(project_role_for(self.db, "stranger@greensglobal.com", p))

    def test_a_viewer_team_does_not_hold_a_listed_person_down(self):
        """Ashley's real shape: on the Share list herself AND in a Viewer team.
        The best grant wins, as it always has for teams."""
        p = self._project(member_emails=["ashley@greensglobal.com"])
        self.db.add(models.TaskTeam(id=gen_id(), name="Operations", project_ids=[p.id],
                                    member_emails=["ashley@greensglobal.com"], access_role="viewer"))
        self.db.commit()

        self.assertEqual(project_role_for(self.db, "ashley@greensglobal.com", p), "editor")

    def test_a_viewer_team_alone_is_still_view_only(self):
        p = self._project()
        self.db.add(models.TaskTeam(id=gen_id(), name="Operations", project_ids=[p.id],
                                    member_emails=["beth@greensglobal.com"], access_role="viewer"))
        self.db.commit()

        self.assertEqual(project_role_for(self.db, "beth@greensglobal.com", p), "viewer")

    def test_the_owner_still_outranks_everything(self):
        p = self._project(member_emails=["owner@greensglobal.com"])

        self.assertEqual(project_role_for(self.db, "owner@greensglobal.com", p), "owner")

    def test_case_does_not_decide_whether_someone_can_edit(self):
        p = self._project(member_emails=["Ashley@GreensGlobal.com"])

        self.assertEqual(project_role_for(self.db, "ashley@greensglobal.com", p), "editor")


class OrgTaskCommentTests(unittest.TestCase):
    """Comments on an ORG-visible task (QA audit, Aug 2026).

    Every case above uses a `restricted` project, so "outsider" always failed the
    project-role check and the tests passed for a reason that had nothing to do
    with comment ownership. On a task with no project - or one in an org-level
    project - every signed-in employee IS an editor, and that was the whole guard
    on deleting a comment. So any colleague could delete anyone's comment from a
    thread used as the record of who said what, leaving nothing behind to show
    it happened. Moderation now takes manager+, matching edit_comment, which
    already treats someone else's words as different in kind from access.
    """

    @classmethod
    def setUpClass(cls):
        # Its own create_all: unittest orders classes alphabetically, so this one
        # runs BEFORE TaskPermissionTests.setUpClass would have made the tables.
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.Task, models.TaskComment, models.TaskProject, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()
        # No project at all - the most permissive shape a task can have.
        self.task = models.Task(id=gen_id(), title="T", code="TASK-9", access_level="org",
                                project_id="", created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.task)
        self.db.commit()

    def _comment(self, author=AUTHOR["email"]):
        c = models.TaskComment(id=gen_id(), task_id=self.task.id, author_email=author,
                               body="<p>on the record</p>", created_at=now_iso())
        self.db.add(c)
        self.db.commit()
        return c

    def test_a_colleague_cannot_delete_your_comment_on_an_org_task(self):
        c = self._comment()
        with self.assertRaises(HTTPException) as ctx:
            delete_comment(c.id, user=OUTSIDER, db=self.db)
        self.assertEqual(ctx.exception.status_code, 403)
        self.db.rollback()
        self.assertIsNotNone(self.db.get(models.TaskComment, c.id))

    def test_the_author_can_still_delete_their_own(self):
        c = self._comment(author=OUTSIDER["email"])
        delete_comment(c.id, user=OUTSIDER, db=self.db)
        self.assertIsNone(self.db.get(models.TaskComment, c.id))

    def test_a_manager_can_still_moderate(self):
        """The capability is narrowed, not removed."""
        c = self._comment()
        delete_comment(c.id, user=MANAGER, db=self.db)
        self.assertIsNone(self.db.get(models.TaskComment, c.id))

    def test_the_comment_body_cannot_carry_an_author(self):
        """create_comment() takes an author_email so the Asana importer and the
        inbound-email ingester can attribute a backfilled comment to whoever
        wrote it - but both call it in-process. On the HTTP body it let any
        signed-in caller post a comment signed as a colleague. Nothing ever sent
        it, so the field is gone; pydantic ignores it if an old client still does."""
        self.assertNotIn("author_email", CommentCreate.model_fields)
        posted = CommentCreate(**{"body": "hi", "author_email": "someone.else@greensglobal.com"})
        self.assertFalse(getattr(posted, "author_email", None))


if __name__ == "__main__":
    unittest.main()
