"""The Recycle Bin: soft delete for projects, portfolios and teams (Sept 2026).

Deleting any of those used to be `db.delete(row)` - permanent, with no way back
short of rebuilding it by hand. They are now binned like tasks already were, and
this pins the parts that are easy to get subtly wrong:

  - a binned container disappears from ORDINARY reads (the global
    _hide_soft_deleted hook, not a filter at each of ~70 query sites) but is
    still there to restore;
  - deleting a project takes its tasks WITH it and restore brings back exactly
    that set - not tasks somebody had already binned on purpose beforehand;
  - membership survives the round trip, because the old hard delete severed it
    and a project restored with no teams or portfolio is not a restore;
  - "mine" means mine even for a Global Admin.

Run with: python -m unittest test_recycle_bin -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import database
import models
from routers.task_util import gen_id, now_iso
from routers.task_projects import (
    delete_portfolio, delete_team, list_recycle_bin,
    restore_from_recycle_bin, purge_from_recycle_bin,
)


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(
            f"{__name__} deletes rows and is pointed at {actual!r}, not its own "
            f"temp database. Another test module imported `database` first. "
            f"Run it on its own: python -m unittest {__name__}"
        )


_assert_isolated()

OWNER = {"email": "dean@greensglobal.com", "level": 1}
OTHER = {"email": "miranda@greensglobal.com", "level": 1}
BOSS = {"email": "neil@greensglobal.com", "level": 3}


class _RecycleCase(unittest.TestCase):
    """Fixtures only - no tests, so the two classes below do not re-run each
    other's the way an inherited TestCase silently does."""

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
        for m in (models.Task, models.TaskProject, models.TaskPortfolio, models.TaskTeam,
                  models.TaskProjectTemplate, models.TaskTemplate):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    # -- fixtures ----------------------------------------------------------
    def _project(self, name="GSM Maintenance", portfolio_id=""):
        p = models.TaskProject(id=gen_id(), name=name, portfolio_id=portfolio_id,
                               created_at=now_iso(), modified_at=now_iso())
        self.db.add(p); self.db.commit()
        return p

    def _task(self, title, project_id="", **kw):
        t = models.Task(id=gen_id(), title=title, project_id=project_id, activity_ids=[],
                        created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t); self.db.commit()
        return t

    def _portfolio(self, name="Operations", parent_id=""):
        p = models.TaskPortfolio(id=gen_id(), name=name, parent_id=parent_id, project_ids=[],
                                 created_at=now_iso(), modified_at=now_iso())
        self.db.add(p); self.db.commit()
        return p

    def _team(self, name="Frontend", project_ids=None):
        t = models.TaskTeam(id=gen_id(), name=name, project_ids=project_ids or [],
                            created_at=now_iso())
        self.db.add(t); self.db.commit()
        return t

    def _kinds(self, scope="", user=BOSS):
        return {(r["kind"], r["name"]) for r in list_recycle_bin(scope=scope, user=user, db=self.db)}


class RecycleBinTests(_RecycleCase):
    """Soft delete for the containers."""

    # -- the hook: binned things vanish from ordinary reads -----------------
    def test_a_binned_portfolio_disappears_from_ordinary_reads(self):
        pf = self._portfolio()
        self.assertEqual(self.db.query(models.TaskPortfolio).count(), 1)
        delete_portfolio(pf.id, user=OWNER, db=self.db)
        self.assertEqual(self.db.query(models.TaskPortfolio).count(), 0)      # hidden
        self.assertEqual(self.db.query(models.TaskPortfolio)
                         .execution_options(include_deleted=True).count(), 1)  # still there

    def test_a_binned_team_disappears_but_its_tasks_keep_pointing_at_it(self):
        tm = self._team()
        t = self._task("Rewire", team_id=tm.id)
        delete_team(tm.id, user=OWNER, db=self.db)
        self.db.refresh(t)
        # team_id intact - the old hard delete cleared it, which made restoring
        # a team give you an empty team.
        self.assertEqual(t.team_id, tm.id)
        self.assertEqual(self.db.query(models.TaskTeam).count(), 0)

    def test_restoring_a_team_puts_its_tasks_back_in_it(self):
        tm = self._team()
        self._task("Rewire", team_id=tm.id)
        delete_team(tm.id, user=OWNER, db=self.db)
        restore_from_recycle_bin("team", tm.id, user=OWNER, db=self.db)
        self.assertEqual(self.db.query(models.TaskTeam).count(), 1)

    # -- the listing -------------------------------------------------------
    def test_the_bin_lists_every_kind_together(self):
        delete_portfolio(self._portfolio().id, user=OWNER, db=self.db)
        delete_team(self._team().id, user=OWNER, db=self.db)
        self.assertEqual(self._kinds(), {("portfolio", "Operations"), ("team", "Frontend")})

    def test_scope_mine_is_not_widened_for_a_manager(self):
        delete_portfolio(self._portfolio().id, user=OWNER, db=self.db)
        self.assertEqual(self._kinds(scope="mine", user=BOSS), set())
        self.assertEqual(self._kinds(scope="mine", user=OWNER), {("portfolio", "Operations")})

    def test_the_unscoped_listing_is_refused_below_manager(self):
        with self.assertRaises(HTTPException) as e:
            list_recycle_bin(scope="", user=OWNER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    # -- restore is not allowed to be a lie --------------------------------
    def test_a_binned_portfolio_keeps_its_membership_for_restore(self):
        pf = self._portfolio()
        proj = self._project(portfolio_id=pf.id)
        pf.project_ids = [proj.id]
        self.db.commit()
        delete_portfolio(pf.id, user=OWNER, db=self.db)
        self.db.refresh(proj)
        # NOT severed: the old hard delete cleared portfolio_id, which would
        # hand back an empty portfolio on restore.
        self.assertEqual(proj.portfolio_id, pf.id)
        restore_from_recycle_bin("portfolio", pf.id, user=OWNER, db=self.db)
        self.db.refresh(pf)
        self.assertEqual(pf.project_ids, [proj.id])

    def test_a_binned_sub_portfolio_is_restored_under_its_parent(self):
        parent = self._portfolio("Operations")
        child = self._portfolio("Maintenance", parent_id=parent.id)
        delete_portfolio(child.id, user=OWNER, db=self.db)
        restore_from_recycle_bin("portfolio", child.id, user=OWNER, db=self.db)
        self.db.refresh(child)
        self.assertEqual(child.parent_id, parent.id)

    # -- the purge really is permanent -------------------------------------
    def test_purging_a_portfolio_severs_what_the_soft_delete_kept(self):
        pf = self._portfolio()
        proj = self._project(portfolio_id=pf.id)
        delete_portfolio(pf.id, user=OWNER, db=self.db)
        purge_from_recycle_bin("portfolio", pf.id, user=OWNER, db=self.db)
        self.db.refresh(proj)
        self.assertEqual(proj.portfolio_id, "")     # only NOW is the link cut
        self.assertEqual(self.db.query(models.TaskPortfolio)
                         .execution_options(include_deleted=True).count(), 0)

    def test_purging_a_sub_portfolio_parent_lifts_its_children(self):
        parent = self._portfolio("Operations")
        child = self._portfolio("Maintenance", parent_id=parent.id)
        delete_portfolio(parent.id, user=OWNER, db=self.db)
        purge_from_recycle_bin("portfolio", parent.id, user=OWNER, db=self.db)
        self.db.refresh(child)
        self.assertEqual(child.parent_id, "")

    # -- permissions -------------------------------------------------------
    def test_someone_else_cannot_restore_what_you_binned(self):
        pf = self._portfolio()
        delete_portfolio(pf.id, user=OWNER, db=self.db)
        with self.assertRaises(HTTPException) as e:
            restore_from_recycle_bin("portfolio", pf.id, user=OTHER, db=self.db)
        self.assertEqual(e.exception.status_code, 403)

    def test_a_manager_can_restore_anything(self):
        pf = self._portfolio()
        delete_portfolio(pf.id, user=OWNER, db=self.db)
        restore_from_recycle_bin("portfolio", pf.id, user=BOSS, db=self.db)
        self.assertEqual(self.db.query(models.TaskPortfolio).count(), 1)

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            restore_from_recycle_bin("banana", "x", user=BOSS, db=self.db)
        self.assertEqual(e.exception.status_code, 422)

    def test_restoring_something_that_is_not_binned_is_a_404(self):
        pf = self._portfolio()
        with self.assertRaises(HTTPException) as e:
            restore_from_recycle_bin("portfolio", pf.id, user=BOSS, db=self.db)
        self.assertEqual(e.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()


class ProjectCascadeTests(_RecycleCase):
    """Deleting a project takes its tasks with it - the hard delete did, and a
    project restored empty is not a restore. `deleted_with` is what makes the
    round trip exact."""

    def _delete_project(self, proj, user=OWNER):
        # Called directly rather than through the endpoint: delete_project also
        # talks to the Asana sync, which is severed and irrelevant here.
        now = now_iso()
        for t in (self.db.query(models.Task).execution_options(include_deleted=True)
                  .filter(models.Task.project_id == proj.id,
                          (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None))).all()):
            t.deleted_at, t.deleted_by, t.deleted_with, t.modified_at = now, user["email"], proj.id, now
        proj.deleted_at, proj.deleted_by, proj.modified_at = now, user["email"], now
        self.db.commit()

    def test_binning_a_project_bins_its_tasks(self):
        p = self._project()
        self._task("Order parts", p.id)
        self._delete_project(p)
        self.assertEqual(self.db.query(models.Task).count(), 0)          # hidden
        self.assertEqual(self.db.query(models.Task)
                         .execution_options(include_deleted=True).count(), 1)

    def test_restoring_a_project_brings_its_tasks_back(self):
        p = self._project()
        self._task("Order parts", p.id)
        self._delete_project(p)
        r = restore_from_recycle_bin("project", p.id, user=OWNER, db=self.db)
        self.assertEqual(r["restored"], 2)                                # project + task
        self.assertEqual(self.db.query(models.Task).count(), 1)

    def test_a_task_binned_BEFORE_the_project_stays_binned(self):
        # The reason deleted_with exists: restoring the project must not
        # resurrect something somebody deleted on purpose beforehand.
        p = self._project()
        keep = self._task("Order parts", p.id)
        already = self._task("Cancelled item", p.id)
        already.deleted_at, already.deleted_by = now_iso(), OTHER["email"]
        self.db.commit()
        self._delete_project(p)
        restore_from_recycle_bin("project", p.id, user=OWNER, db=self.db)
        self.db.refresh(keep); self.db.refresh(already)
        self.assertEqual(keep.deleted_at, "")
        self.assertNotEqual(already.deleted_at, "")

    def test_the_bin_lists_a_project_as_one_row_not_two_hundred(self):
        p = self._project()
        for i in range(5):
            self._task(f"Task {i}", p.id)
        self._delete_project(p)
        rows = list_recycle_bin(scope="", user=BOSS, db=self.db)
        self.assertEqual([r["kind"] for r in rows], ["project"])
        self.assertIn("5 tasks binned with it", rows[0]["detail"])


class TemplateTests(_RecycleCase):
    """Both template kinds. A template is hand-built from a project that may
    since have changed, so a mis-click is not something you can simply redo."""

    def _project_template(self, name="Property Turnover"):
        t = models.TaskProjectTemplate(id=gen_id(), name=name, payload={},
                                       created_at=now_iso(), modified_at=now_iso(),
                                       created_by=OWNER["email"], owner_email=OWNER["email"])
        self.db.add(t); self.db.commit()
        return t

    def _task_template(self, name="Weekly site check"):
        t = models.TaskTemplate(id=gen_id(), name=name, patch={}, subtask_titles=[],
                                created_at=now_iso())
        self.db.add(t); self.db.commit()
        return t

    def _bin(self, tpl, kind_model):
        tpl.deleted_at, tpl.deleted_by = now_iso(), OWNER["email"]
        self.db.commit()

    def test_a_binned_project_template_leaves_ordinary_reads(self):
        t = self._project_template()
        self._bin(t, models.TaskProjectTemplate)
        self.assertEqual(self.db.query(models.TaskProjectTemplate).count(), 0)
        self.assertEqual(self.db.query(models.TaskProjectTemplate)
                         .execution_options(include_deleted=True).count(), 1)

    def test_both_template_kinds_appear_in_the_bin_and_are_told_apart(self):
        self._bin(self._project_template(), models.TaskProjectTemplate)
        self._bin(self._task_template(), models.TaskTemplate)
        rows = list_recycle_bin(scope="", user=BOSS, db=self.db)
        self.assertEqual({r["kind"] for r in rows}, {"template", "task_template"})
        self.assertEqual({r["detail"] for r in rows}, {"Project template", "Task template"})

    def test_a_project_template_restores(self):
        t = self._project_template()
        self._bin(t, models.TaskProjectTemplate)
        restore_from_recycle_bin("template", t.id, user=OWNER, db=self.db)
        self.assertEqual(self.db.query(models.TaskProjectTemplate).count(), 1)

    def test_a_task_template_restores(self):
        t = self._task_template()
        self._bin(t, models.TaskTemplate)
        restore_from_recycle_bin("task_template", t.id, user=OWNER, db=self.db)
        self.assertEqual(self.db.query(models.TaskTemplate).count(), 1)

    def test_purging_a_template_is_permanent(self):
        t = self._project_template()
        self._bin(t, models.TaskProjectTemplate)
        purge_from_recycle_bin("template", t.id, user=OWNER, db=self.db)
        self.assertEqual(self.db.query(models.TaskProjectTemplate)
                         .execution_options(include_deleted=True).count(), 0)
