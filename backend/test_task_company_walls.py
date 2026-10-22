"""Tasks module company walls (Oct 21 2026).

The task lists and per-task routes already stopped at the company wall; the
rest of the module did not. A manager clears every role check, so behind a
wall a company-A manager could still bulk-edit company-B tasks by id, list,
edit and delete company-B projects, teams and portfolios, read company-B
automation rules, templates, custom fields, statuses and intake forms (and
have their rules fire on company-B tasks), and find company-B names in
search and the Activity Log.

Each test arms the walls for real (the NexusSetting switch) with a level-3
manager in company A - not a Global Admin - and checks the wall holds, and
that with the walls OFF nothing changes. Throwaway SQLite, no network.

    python -m pytest test_task_company_walls.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import cache
import database
import models
import task_automation
from routers import task_config as C
from routers import task_projects as P
from routers import tasks as T
from routers.task_util import gen_id, now_iso, require_task_role


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

COA, COB = "co-a", "co-b"
AMGR = {"email": "amgr@greensglobal.com", "level": 3}    # company A manager (not a Global Admin)
AEMP = {"email": "aemp@greensglobal.com", "level": 1}
BEMP = {"email": "bemp@greensglobal.com", "level": 1}
GA = {"email": "ga@greensglobal.com", "level": 4}        # bootstrap Global Admin (no GA group)

_CLEAR = (models.Task, models.TaskProject, models.TaskPortfolio, models.TaskTeam, models.TaskMemberRequest,
          models.TaskAutomationRule, models.TaskAutomationRun, models.TaskTemplate, models.TaskCustomField,
          models.TaskCustomStatus, models.TaskIntakeForm, models.TaskActivity, models.TaskNotification,
          models.NexusNotification, models.NexusEmployee, models.NexusSetting, models.TaskProjectBookmark,
          models.TaskChecklistItem)


class WallsBase(unittest.TestCase):
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
        for m in _CLEAR:
            self.db.query(m).execution_options(include_deleted=True).delete()
        for email, co in ((AMGR["email"], COA), (AEMP["email"], COA), (BEMP["email"], COB),
                          ("bmgr@greensglobal.com", COB), (GA["email"], COA)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0],
                                             status="active", company=co))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def arm(self, on=True):
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
        if on:
            self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    # -- seed helpers --------------------------------------------------------
    def task(self, company, **kw):
        kw.setdefault("title", f"{company} task")
        kw.setdefault("status", "not_started")
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", company_id=company,
                        created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def project(self, company, name=None, **kw):
        kw.setdefault("access_level", "org")
        p = models.TaskProject(id=gen_id(), name=name or f"{company} project", company_id=company,
                               created_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        return e.exception.status_code


class TaskWallTests(WallsBase):
    def test_bulk_refuses_any_id_over_the_wall_and_changes_nothing(self):
        a, b = self.task(COA), self.task(COB)
        self.arm()
        self.assertEqual(self.code(lambda: T.bulk_update(
            T.BulkUpdate(ids=[a.id, b.id], patch={"priority": "urgent"}), user=AMGR, db=self.db)), 404)
        self.db.expire_all()
        self.assertEqual({t.priority for t in self.db.query(models.Task).all()}, {"medium"})
        # Their own company's task alone goes through.
        out = T.bulk_update(T.BulkUpdate(ids=[a.id], patch={"priority": "urgent"}), user=AMGR, db=self.db)
        self.assertEqual(out[0]["priority"], "urgent")

    def test_bulk_with_walls_off_is_unchanged(self):
        a, b = self.task(COA), self.task(COB)
        out = T.bulk_update(T.BulkUpdate(ids=[a.id, b.id], patch={"priority": "low"}), user=AMGR, db=self.db)
        self.assertEqual({r["priority"] for r in out}, {"low"})

    def test_require_task_role_walls_a_manager(self):
        b = self.task(COB)
        self.arm()
        self.assertEqual(self.code(lambda: require_task_role(self.db, AMGR, b, "editor")), 404)
        require_task_role(self.db, GA, b, "editor")          # a Global Admin is not walled
        self.arm(False)
        require_task_role(self.db, AMGR, b, "editor")        # walls off: as before

    def test_single_patch_and_delete_over_the_wall_are_404(self):
        b = self.task(COB)
        self.arm()
        self.assertEqual(self.code(lambda: T.update_task(b.id, T.TaskUpdate(priority="low"), BackgroundTasks(),
                                                         user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.delete_task(b.id, BackgroundTasks(), user=AMGR, db=self.db)), 404)

    def test_a_subtask_cannot_be_hung_under_another_companys_task(self):
        b = self.task(COB)
        self.arm()
        self.assertEqual(self.code(lambda: T.create_task(T.TaskCreate(title="sneaky", parent_task_id=b.id),
                                                         BackgroundTasks(), user=AMGR, db=self.db)), 404)

    def test_a_task_cannot_be_created_in_another_companys_project(self):
        pb = self.project(COB)
        self.arm()
        self.assertEqual(self.code(lambda: T.create_task(T.TaskCreate(title="x", project_id=pb.id),
                                                         BackgroundTasks(), user=AMGR, db=self.db)), 404)


class ProjectWallTests(WallsBase):
    def test_projects_list_and_by_id(self):
        pa, pb = self.project(COA), self.project(COB)
        self.arm()
        self.assertEqual({p["id"] for p in P.list_projects(user=AMGR, db=self.db)}, {pa.id})
        self.assertEqual(self.code(lambda: P.update_project(pb.id, P.ProjectBody(name="x"), user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: P.delete_project(pb.id, user=AMGR, db=self.db)), 404)
        self.assertEqual({p["id"] for p in P.list_projects(user=GA, db=self.db)}, {pa.id, pb.id})

    def test_a_project_owned_by_company_b_with_no_stamp_is_walled_by_its_owner(self):
        legacy = models.TaskProject(id=gen_id(), name="legacy", owner_email=BEMP["email"], access_level="org")
        self.db.add(legacy)
        self.db.commit()
        self.arm()
        self.assertEqual(P.list_projects(user=AMGR, db=self.db), [])

    def test_create_stamps_the_creators_company(self):
        out = P.create_project(P.ProjectBody(name="New"), user=AMGR, db=self.db)
        row = self.db.query(models.TaskProject).filter(models.TaskProject.id == out["id"]).first()
        self.assertEqual(row.company_id, COA)

    def test_walls_off_lists_everything(self):
        self.project(COA)
        self.project(COB)
        self.assertEqual(len(P.list_projects(user=AMGR, db=self.db)), 2)

    def test_teams(self):
        pa, pb = self.project(COA), self.project(COB)
        ta = models.TaskTeam(id=gen_id(), name="A team", project_ids=[pa.id], created_by=AEMP["email"])
        tb = models.TaskTeam(id=gen_id(), name="B team", project_ids=[pb.id], created_by=BEMP["email"])
        legacy = models.TaskTeam(id=gen_id(), name="Legacy B", project_ids=[pb.id])   # no creator: its project's
        self.db.add_all([ta, tb, legacy])
        self.db.commit()
        self.arm()
        self.assertEqual({t["id"] for t in P.list_teams(user=AMGR, db=self.db)}, {ta.id})
        self.assertEqual(self.code(lambda: P.update_team(tb.id, P.TeamBody(name="x"), user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: P.delete_team(tb.id, user=AMGR, db=self.db)), 404)
        # A manager cannot put their team on another company's project either.
        self.assertEqual(self.code(lambda: P.update_team(ta.id, P.TeamBody(project_ids=[pa.id, pb.id]),
                                                         user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: P.create_team(P.TeamBody(name="t", project_ids=[pb.id]),
                                                         user=AMGR, db=self.db)), 404)

    def test_portfolios(self):
        pa, pb = self.project(COA), self.project(COB)
        fa = models.TaskPortfolio(id=gen_id(), name="A pf", company_id=COA, project_ids=[pa.id, pb.id])
        fb = models.TaskPortfolio(id=gen_id(), name="B pf", company_id=COB, project_ids=[])
        self.db.add_all([fa, fb])
        self.db.commit()
        self.arm()
        listed = P.list_portfolios(user=AMGR, db=self.db)
        self.assertEqual([p["id"] for p in listed], [fa.id])
        self.assertEqual(listed[0]["projectIds"], [pa.id])     # B's project inside A's portfolio is hidden
        self.assertEqual(self.code(lambda: P.update_portfolio(fb.id, P.PortfolioBody(name="x"),
                                                              user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: P.delete_portfolio(fb.id, user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: P.move_projects_between_portfolios(
            P.MoveProjectsBody(project_ids=[pa.id, pb.id], portfolio_id=fa.id), user=AMGR, db=self.db)), 404)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.TaskProject, pb.id).portfolio_id or "", "")   # nothing moved

    def test_member_requests(self):
        ta = models.TaskTeam(id=gen_id(), name="A", created_by=AEMP["email"])
        tb = models.TaskTeam(id=gen_id(), name="B", created_by=BEMP["email"])
        self.db.add_all([ta, tb])
        self.db.add(models.TaskMemberRequest(id="r-a", department_id=ta.id, user_email="x@y.com"))
        self.db.add(models.TaskMemberRequest(id="r-b", department_id=tb.id, user_email="x@y.com"))
        self.db.commit()
        self.arm()
        self.assertEqual({m["id"] for m in P.list_member_requests(user=AMGR, db=self.db)}, {"r-a"})
        self.assertEqual(self.code(lambda: P.raise_member_request(
            P.MemberRequestBody(team_id=tb.id, user_email="x@y.com"), user=AMGR, db=self.db)), 404)
        self.arm(False)
        self.assertEqual(len(P.list_member_requests(user=AMGR, db=self.db)), 2)


class ConfigWallTests(WallsBase):
    def _rule(self, company, name):
        r = models.TaskAutomationRule(id=gen_id(), name=name, company_id=company, enabled=True,
                                      trigger={"type": "created"}, conditions=[],
                                      actions=[{"type": "add_tag", "value": name}], created_at=now_iso())
        self.db.add(r)
        self.db.commit()
        return r

    def test_rules_list_create_edit(self):
        shared, ra, rb = self._rule("", "shared"), self._rule(COA, "a"), self._rule(COB, "b")
        self.arm()
        self.assertEqual({r["id"] for r in C.list_rules(user=AMGR, db=self.db)}, {shared.id, ra.id})
        made = C.create_rule(C.RuleBody(name="new", trigger={"type": "created"},
                                        actions=[{"type": "add_tag", "value": "x"}]), user=AMGR, db=self.db)
        self.assertEqual(self.db.get(models.TaskAutomationRule, made["id"]).company_id, COA)
        self.assertEqual(self.code(lambda: C.update_rule(rb.id, C.RuleBody(enabled=False), user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: C.update_rule(shared.id, C.RuleBody(enabled=False),
                                                         user=AMGR, db=self.db)), 403)
        self.assertEqual(self.code(lambda: C.delete_rule(rb.id, user=AMGR, db=self.db)), 404)
        C.update_rule(shared.id, C.RuleBody(enabled=False), user=GA, db=self.db)    # a Global Admin may

    def test_rules_made_with_walls_off_are_shared(self):
        made = C.create_rule(C.RuleBody(name="new", trigger={"type": "created"},
                                        actions=[{"type": "add_tag", "value": "x"}]), user=AMGR, db=self.db)
        self.assertEqual(self.db.get(models.TaskAutomationRule, made["id"]).company_id, "")

    def test_a_company_rule_fires_only_on_that_companys_tasks(self):
        self._rule("", "shared")
        self._rule(COB, "b-only")
        t = self.task(COA)
        before = task_automation.snapshot(t)
        task_automation.run_for_change(self.db, t, event="created", before=before)
        self.assertEqual(t.tags, ["shared"])     # the shared rule fired, company B's did not
        tb = self.task(COB)
        task_automation.run_for_change(self.db, tb, event="created", before=task_automation.snapshot(tb))
        self.assertEqual(sorted(tb.tags), ["b-only", "shared"])

    def test_templates_fields_statuses_forms(self):
        self.db.add_all([
            models.TaskTemplate(id="tpl-a", name="A", company_id=COA, patch={}),
            models.TaskTemplate(id="tpl-b", name="B", company_id=COB, patch={}),
            models.TaskTemplate(id="tpl-s", name="S", company_id="", patch={}),
            models.TaskCustomField(id="f-a", name="A", type="text", company_id=COA),
            models.TaskCustomField(id="f-b", name="B", type="text", company_id=COB),
            models.TaskCustomStatus(id="s-b", label="B", company_id=COB),
            models.TaskCustomStatus(id="s-s", label="S", company_id=""),
            models.TaskIntakeForm(id="i-b", title="B", company_id=COB),
            models.TaskIntakeForm(id="i-s", title="S", company_id=""),
        ])
        self.db.commit()
        self.arm()
        self.assertEqual({t["id"] for t in C.list_templates(user=AMGR, db=self.db)}, {"tpl-a", "tpl-s"})
        self.assertEqual({f["id"] for f in C.list_custom_fields(user=AMGR, db=self.db)}, {"f-a"})
        self.assertEqual({s["id"] for s in T.list_custom_statuses(user=AMGR, db=self.db)}, {"s-s"})
        self.assertEqual({f["id"] for f in C.list_intake_forms(user=AMGR, db=self.db)}, {"i-s"})
        self.assertEqual(self.code(lambda: C.update_custom_field("f-b", C.CustomFieldBody(name="x"),
                                                                 user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: T.update_custom_status("s-b", T.CustomStatusBody(label="x"),
                                                                  user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: C.delete_intake_form("i-b", user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: C.use_template("tpl-b", C.UseTemplateBody(), BackgroundTasks(),
                                                          user=AMGR, db=self.db)), 404)
        made = C.create_intake_form(C.IntakeFormBody(title="mine"), user=AMGR, db=self.db)
        self.assertEqual(self.db.get(models.TaskIntakeForm, made["id"]).company_id, COA)

    def test_a_company_required_field_binds_only_that_companys_tasks(self):
        p = self.project(COA)
        self.db.add(models.TaskCustomField(id="req-b", name="B Only", type="text", required=True, company_id=COB))
        self.db.add(models.TaskCustomField(id="req-s", name="Shared", type="text", required=True, company_id=""))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            T.create_task(T.TaskCreate(title="x", project_id=p.id), BackgroundTasks(), user=AMGR, db=self.db)
        self.assertIn("Shared", e.exception.detail)
        self.assertNotIn("B Only", e.exception.detail)
        T.create_task(T.TaskCreate(title="x", project_id=p.id, custom_field_values={"req-s": "v"}),
                      BackgroundTasks(), user=AMGR, db=self.db)


class CustomStatusDeleteTests(WallsBase):
    def test_deleting_a_status_moves_its_tasks_to_not_started(self):
        self.db.add(models.TaskCustomStatus(id="waiting", label="Waiting"))
        self.db.commit()
        live = self.task(COA, status="waiting")
        binned = self.task(COA, status="waiting", deleted_at=now_iso())
        other = self.task(COA, status="in_progress")
        T.delete_custom_status("waiting", user=AMGR, db=self.db)
        self.db.expire_all()
        q = self.db.query(models.Task).execution_options(include_deleted=True)
        self.assertEqual(q.filter(models.Task.id == live.id).first().status, "not_started")
        self.assertEqual(q.filter(models.Task.id == binned.id).first().status, "not_started")
        self.assertEqual(q.filter(models.Task.id == other.id).first().status, "in_progress")
        self.assertIsNone(self.db.get(models.TaskCustomStatus, "waiting"))


class UseTemplateAssigneeTests(WallsBase):
    def test_a_subtask_assignee_outside_the_directory_is_refused(self):
        self.db.add(models.TaskTemplate(id="tpl", name="T", patch={},
                                        subtasks=[{"title": "s", "assigneeIds": ["stranger@outside.com"]}]))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            C.use_template("tpl", C.UseTemplateBody(), BackgroundTasks(), user=AMGR, db=self.db)
        self.assertEqual(e.exception.status_code, 422)
        self.assertEqual(self.db.query(models.Task).count(), 0)   # nothing half-built

    def test_a_subtask_assignee_in_another_company_is_refused(self):
        self.db.add(models.TaskTemplate(id="tpl", name="T", patch={},
                                        subtasks=[{"title": "s", "assigneeIds": [BEMP["email"]]}]))
        self.db.commit()
        self.assertEqual(self.code(lambda: C.use_template("tpl", C.UseTemplateBody(), BackgroundTasks(),
                                                          user=AMGR, db=self.db)), 422)

    def test_a_directory_person_is_fine(self):
        self.db.add(models.TaskTemplate(id="tpl", name="T", patch={},
                                        subtasks=[{"title": "s", "assigneeIds": [AEMP["email"]]}]))
        self.db.commit()
        out = C.use_template("tpl", C.UseTemplateBody(), BackgroundTasks(), user=AMGR, db=self.db)
        sub = self.db.get(models.Task, out["subtaskIds"][0])
        self.assertEqual(sub.assignee_emails, [AEMP["email"]])


class RecycleBinWallTests(WallsBase):
    def test_the_bin_and_its_restore_are_walled(self):
        pa = self.project(COA, deleted_at=now_iso(), deleted_by=AMGR["email"])
        pb = self.project(COB, deleted_at=now_iso(), deleted_by="bmgr@greensglobal.com")
        self.arm()
        self.assertEqual({r["id"] for r in P.list_recycle_bin(user=AMGR, db=self.db)}, {pa.id})
        self.assertEqual(self.code(lambda: P.restore_from_recycle_bin("project", pb.id, user=AMGR, db=self.db)), 404)
        self.assertEqual(self.code(lambda: P.purge_from_recycle_bin("project", pb.id, user=AMGR, db=self.db)), 404)
        self.arm(False)
        self.assertEqual(len(P.list_recycle_bin(user=AMGR, db=self.db)), 2)


class SearchWallTests(WallsBase):
    def test_search_walls_every_group(self):
        self.project(COA, name="Roof A")
        self.project(COB, name="Roof B")
        self.db.add(models.TaskPortfolio(id=gen_id(), name="Roof pf B", company_id=COB))
        self.db.add(models.TaskTeam(id=gen_id(), name="Roof team B", created_by=BEMP["email"]))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email="roofer.b@greensglobal.com", first_name="Roofer",
                                         status="active", company=COB))
        self.db.commit()
        self.arm()
        out = T.search_everything(q="roof", user=AMGR, db=self.db)
        self.assertEqual([p["name"] for p in out["projects"]], ["Roof A"])
        self.assertEqual(out["portfolios"], [])
        self.assertEqual(out["teams"], [])
        self.assertEqual(out["people"], [])
        self.arm(False)
        out = T.search_everything(q="roof", user=AMGR, db=self.db)
        self.assertEqual(len(out["projects"]), 2)
        self.assertEqual(len(out["people"]), 1)


if __name__ == "__main__":
    unittest.main()
