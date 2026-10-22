"""Moving tasks in the subtask tree (Neil, Oct 22 2026).

"Move To..." in the drawer and the list is a PATCH of parent_task_id:
  - a subtask moves under another task (last among its new siblings), or
    becomes a top-level task in its project (optionally into a section);
  - a top-level task becomes a subtask;
  - never under itself or its own subtree, never deeper than
    MAX_SUBTASK_DEPTH;
  - leaving a project takes editor on it, joining one takes editor there;
  - behind the company wall a task moves only under a task of its company;
  - the whole subtree goes into the new project, trashed rows included, so
    a restore lands in the right place;
  - under a restricted parent the moved rows become restricted too;
  - an activity line says what happened; every row the move touched is in
    the next GET /tasks/delta.

Throwaway SQLite, no network.  python -m pytest test_task_subtask_move.py
"""
import os
import tempfile
import time
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import tasks as T  # noqa: E402
from routers.task_util import gen_id, now_iso  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

OWNER = {"email": "owner@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
MANAGER = {"email": "manager@greensglobal.com", "level": 3}
DIRECTORY = [OWNER, EDITOR, VIEWER, MANAGER]


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
        for m in (models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification,
                  models.NexusNotification, models.NexusEmployee, models.TaskSection, models.NexusSetting,
                  models.TaskDeleteLog, models.NexusAccessScope, models.TaskChecklistItem):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u in DIRECTORY:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"],
                                             first_name=u["email"].split("@")[0], status="active"))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        cache.settings_config.invalidate()

    # ── helpers ──
    def project(self, name="Ops", **kw):
        kw.setdefault("access_level", "restricted")
        kw.setdefault("owner_email", OWNER["email"])
        p = models.TaskProject(id=gen_id(), name=name, created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def task(self, title="T", parent=None, **kw):
        kw.setdefault("status", "not_started")
        kw.setdefault("created_by", OWNER["email"])
        if parent is not None:
            kw.setdefault("project_id", parent.project_id)
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", title=title, created_at=now_iso(),
                        modified_at=now_iso(), parent_task_id=parent.id if parent is not None else "", **kw)
        self.db.add(t)
        if parent is not None:
            parent.subtask_ids = list(parent.subtask_ids or []) + [t.id]
        self.db.commit()
        return t

    def row(self, tid):
        self.db.expire_all()
        return (self.db.query(models.Task).execution_options(include_deleted=True)
                .filter(models.Task.id == tid).first())

    def move(self, t, user=OWNER, **fields):
        return T.update_task(t.id, T.TaskUpdate(**fields), BackgroundTasks(), user=user, db=self.db)

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def activity(self, tid):
        self.db.expire_all()
        return [a.detail for a in self.db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_id == tid, models.TaskActivity.type == "moved").all()]


class MoveTests(Base):
    def setUp(self):
        super().setUp()
        self.ops = self.project("Ops")

    def test_a_subtask_moves_under_another_task_and_lands_last(self):
        a = self.task("A", project_id=self.ops.id)
        b = self.task("B", project_id=self.ops.id)
        kid = self.task("Kid", parent=a)
        first = self.task("First", parent=b, position=5)
        second = self.task("Second", parent=b, position=9)
        self.move(kid, parent_task_id=b.id)
        self.assertEqual(self.row(kid.id).parent_task_id, b.id)
        self.assertEqual(self.row(a.id).subtask_ids, [])
        self.assertEqual(self.row(b.id).subtask_ids, [first.id, second.id, kid.id])
        self.assertGreater(self.row(kid.id).position, 9)
        self.assertEqual(self.activity(kid.id), [f"moved this task under {b.code}"])

    def test_a_subtask_becomes_a_top_level_task_in_its_project_and_section(self):
        a = self.task("A", project_id=self.ops.id)
        kid = self.task("Kid", parent=a, project_id="")      # an Asana-style blank subtask
        sec = models.TaskSection(id=gen_id(), project_id=self.ops.id, name="Later", custom=True)
        self.db.add(sec)
        self.db.commit()
        self.move(kid, parent_task_id="", section_id=sec.id)
        r = self.row(kid.id)
        self.assertEqual((r.parent_task_id, r.project_id, r.section_id), ("", self.ops.id, sec.id))
        self.assertEqual(self.row(a.id).subtask_ids, [])
        self.assertEqual(self.activity(kid.id), ["made this a top-level task"])

    def test_a_section_of_another_project_is_refused(self):
        other = self.project("Other")
        a = self.task("A", project_id=self.ops.id)
        kid = self.task("Kid", parent=a)
        sec = models.TaskSection(id=gen_id(), project_id=other.id, name="Theirs", custom=True)
        self.db.add(sec)
        self.db.commit()
        self.assertEqual(self.code(lambda: self.move(kid, parent_task_id="", section_id=sec.id)), 422)
        self.assertEqual(self.row(kid.id).parent_task_id, a.id)

    def test_a_top_level_task_becomes_a_subtask_and_leaves_its_section(self):
        sec = models.TaskSection(id=gen_id(), project_id=self.ops.id, name="Now", custom=True)
        self.db.add(sec)
        self.db.commit()
        a = self.task("A", project_id=self.ops.id)
        b = self.task("B", project_id=self.ops.id, section_id=sec.id)
        self.move(b, parent_task_id=a.id)
        r = self.row(b.id)
        self.assertEqual((r.parent_task_id, r.section_id), (a.id, ""))
        self.assertEqual(self.row(a.id).subtask_ids, [b.id])

    def test_a_skip_rule_goes_when_the_subtask_becomes_top_level(self):
        a = self.task("A", project_id=self.ops.id, recurrence={"freq": "weekly", "interval": 1})
        kid = self.task("Kid", parent=a, recurrence={"skip": True})
        self.move(kid, parent_task_id="")
        self.assertIsNone(self.row(kid.id).recurrence)

    def test_moving_under_itself_or_its_own_subtree_is_refused(self):
        top = self.task("Top", project_id=self.ops.id)
        mid = self.task("Mid", parent=top)
        leaf = self.task("Leaf", parent=mid)
        self.assertEqual(self.code(lambda: self.move(top, parent_task_id=top.id)), 422)
        self.assertEqual(self.code(lambda: self.move(top, parent_task_id=mid.id)), 422)
        self.assertEqual(self.code(lambda: self.move(top, parent_task_id=leaf.id)), 422)
        self.assertEqual(self.row(top.id).parent_task_id, "")

    def test_a_move_past_the_depth_limit_is_refused(self):
        chain = [self.task("L0", project_id=self.ops.id)]
        for i in range(1, T.MAX_SUBTASK_DEPTH + 1):     # levels 0..20: the deepest sits 20 down
            chain.append(self.task(f"L{i}", parent=chain[-1]))
        branch = self.task("Branch", project_id=self.ops.id)
        self.task("Branch kid", parent=branch)
        self.assertEqual(self.code(lambda: self.move(branch, parent_task_id=chain[-2].id)), 422)
        self.move(branch, parent_task_id=chain[-3].id)   # 18 + 1 + 1 = 20 still fits
        self.assertEqual(self.row(branch.id).parent_task_id, chain[-3].id)

    def test_the_subtree_comes_along_and_series_keep_rolling(self):
        a = self.task("A", project_id=self.ops.id)
        b = self.task("B", project_id=self.ops.id)
        kid = self.task("Kid", parent=a, recurrence={"freq": "weekly", "interval": 1, "seriesId": "s1"},
                        status="recurring", due_on="2026-10-05")
        grandkid = self.task("Grandkid", parent=kid)
        self.move(kid, parent_task_id=b.id)
        self.assertEqual(self.row(grandkid.id).parent_task_id, kid.id)
        self.assertEqual(self.row(kid.id).subtask_ids, [grandkid.id])
        # Completing the moved repeating subtask rolls its next copy under B.
        self.move(kid, completed=True)
        nxt_id = self.row(kid.id).recurrence.get("nextOccurrenceId")
        self.assertTrue(nxt_id)
        self.assertEqual(self.row(nxt_id).parent_task_id, b.id)


class CrossProjectTests(Base):
    def setUp(self):
        super().setUp()
        self.src = self.project("Source", member_emails=[EDITOR["email"]], member_roles={EDITOR["email"]: "editor"})
        self.dst = self.project("Dest", member_emails=[EDITOR["email"]], member_roles={EDITOR["email"]: "editor"})

    def _tree(self):
        a = self.task("A", project_id=self.src.id, team_id="team-x")
        kid = self.task("Kid", parent=a, team_id="team-x")
        leaf = self.task("Leaf", parent=kid, project_id="")
        binned = self.task("Binned", parent=kid, deleted_at="2026-10-01T00:00:00+00:00",
                           deleted_by=OWNER["email"])
        target = self.task("Target", project_id=self.dst.id)
        return a, kid, leaf, binned, target

    def test_the_whole_subtree_moves_into_the_new_project(self):
        a, kid, leaf, binned, target = self._tree()
        self.move(kid, user=EDITOR, parent_task_id=target.id)
        r = self.row(kid.id)
        self.assertEqual((r.parent_task_id, r.project_id, r.team_id), (target.id, self.dst.id, ""))
        self.assertEqual(self.row(leaf.id).project_id, "", "a blank subtask keeps reaching it via its parent")
        self.assertEqual(self.row(binned.id).project_id, self.dst.id, "the binned one too")

    def test_editor_on_both_projects_is_needed(self):
        a, kid, leaf, binned, target = self._tree()
        self.src.member_roles = {EDITOR["email"]: "viewer"}
        self.db.commit()
        # Assigned the subtask (an editor grant on THAT task), but only a viewer
        # of the project it would leave.
        kid.assignee_emails, kid.assignee_email = [EDITOR["email"]], EDITOR["email"]
        self.db.commit()
        self.assertEqual(self.code(lambda: self.move(kid, user=EDITOR, parent_task_id=target.id)), 403)
        self.assertEqual(self.row(kid.id).parent_task_id, a.id)
        self.src.member_roles = {EDITOR["email"]: "editor"}
        self.dst.member_roles = {EDITOR["email"]: "viewer"}
        self.db.commit()
        self.assertEqual(self.code(lambda: self.move(kid, user=EDITOR, parent_task_id=target.id)), 403)
        self.assertEqual(self.row(kid.id).project_id, self.src.id)

    def test_a_viewer_cannot_move_at_all(self):
        a, kid, leaf, binned, target = self._tree()
        self.src.member_roles = {EDITOR["email"]: "editor", VIEWER["email"]: "viewer"}
        self.src.member_emails = [EDITOR["email"], VIEWER["email"]]
        self.db.commit()
        other = self.task("Other", project_id=self.src.id)
        self.assertEqual(self.code(lambda: self.move(kid, user=VIEWER, parent_task_id=other.id)), 403)
        self.assertEqual(self.code(lambda: self.move(kid, user=VIEWER, parent_task_id="")), 403)

    def test_a_restricted_target_the_caller_cannot_see_is_404(self):
        a, kid, leaf, binned, target = self._tree()
        hidden = self.project("HR")
        secret = self.task("Salary review", project_id=hidden.id, access_level="restricted")
        self.assertEqual(self.code(lambda: self.move(kid, user=EDITOR, parent_task_id=secret.id)), 404)

    def test_restore_after_a_move_lands_in_the_new_project(self):
        a, kid, leaf, binned, target = self._tree()
        self.move(kid, user=EDITOR, parent_task_id=target.id)
        T.delete_task(kid.id, BackgroundTasks(), user=OWNER, db=self.db)
        self.assertTrue(self.row(leaf.id).deleted_at)
        T.restore_task(kid.id, user=OWNER, db=self.db)
        self.assertEqual(self.row(kid.id).parent_task_id, target.id)
        self.assertIn(kid.id, self.row(target.id).subtask_ids)
        self.assertFalse(self.row(leaf.id).deleted_at)
        self.assertEqual(self.row(leaf.id).parent_task_id, kid.id)

    def test_a_restricted_parent_restricts_what_moves_under_it(self):
        a, kid, leaf, binned, target = self._tree()
        target.access_level = "restricted"
        open_task = self.task("Open", project_id=self.dst.id, access_level="org")
        open_kid = self.task("Open kid", parent=open_task, access_level="org")
        self.db.commit()
        self.move(open_task, user=EDITOR, parent_task_id=target.id)
        self.assertEqual(self.row(open_task.id).access_level, "restricted")
        self.assertEqual(self.row(open_kid.id).access_level, "restricted")

    def test_the_delta_hands_every_moved_row_to_other_clients(self):
        a, kid, leaf, binned, target = self._tree()
        since = now_iso()
        time.sleep(0.01)
        self.move(kid, user=EDITOR, parent_task_id=target.id)
        out = T.list_tasks_delta(since=since, user=MANAGER, db=self.db)
        ids = {t["id"] for t in out["tasks"]}
        self.assertTrue({kid.id, leaf.id, a.id, target.id} <= ids, ids)
        moved = {t["id"]: t for t in out["tasks"]}
        self.assertEqual(moved[kid.id]["parentTaskId"], target.id)

    def test_a_subtask_ids_pull_moves_the_subtree_too(self):
        a, kid, leaf, binned, target = self._tree()
        self.move(target, user=EDITOR, subtask_ids=[kid.id])
        r = self.row(kid.id)
        self.assertEqual((r.parent_task_id, r.project_id), (target.id, self.dst.id))
        self.assertEqual(self.activity(kid.id), [f"moved this task under {target.code}"])


class WallTests(Base):
    def setUp(self):
        super().setUp()
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        (self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == EDITOR["email"])
         .update({"company": "co-a"}))
        self.db.commit()
        cache.settings_config.invalidate()

    def test_another_companys_task_is_not_a_target(self):
        mine = self.task("Mine", company_id="co-a", created_by=EDITOR["email"])
        theirs = self.task("Theirs", company_id="co-b")
        self.assertEqual(self.code(lambda: self.move(mine, user=EDITOR, parent_task_id=theirs.id)), 404)
        self.assertEqual(self.row(mine.id).parent_task_id, "")

    def test_two_companies_never_share_a_subtree(self):
        # Somebody who works in both companies still cannot hang one's task
        # under the other's.
        self.db.add(models.NexusAccessScope(id=gen_id(), email=EDITOR["email"], module_id="tasks",
                                            scope_type="entity", scope_id="co-b"))
        self.db.commit()
        mine = self.task("Mine", company_id="co-a", created_by=EDITOR["email"])
        theirs = self.task("Theirs", company_id="co-b", created_by=EDITOR["email"])
        self.assertEqual(self.code(lambda: self.move(mine, user=EDITOR, parent_task_id=theirs.id)), 422)
        same = self.task("Same company", company_id="co-a", created_by=EDITOR["email"])
        self.move(mine, user=EDITOR, parent_task_id=same.id)
        self.assertEqual(self.row(mine.id).parent_task_id, same.id)


if __name__ == "__main__":
    unittest.main()
