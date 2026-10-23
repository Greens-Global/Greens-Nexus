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
  - a move never changes anyone's access level, and never moves a private
    row into a wider project unless the mover could open it up anyway;
  - two crossing moves cannot make a loop (checked again after the lock);
  - an Undo puts back position, section, team and a skip rule;
  - an activity line says what happened (never naming a private parent);
    every row the move touched is in the next GET /tasks/delta;
  - search never names a parent the caller cannot see.
HR checklist tasks are covered in test_hr_checklists.py.

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


    def test_crossing_moves_cannot_make_a_loop(self):
        # X-under-P is checked, then - before its rows are locked - another
        # request lands P-under-X. The check after the lock sees it.
        x = self.task("X", project_id=self.ops.id)
        p = self.task("P", project_id=self.ops.id)
        real = T._lock_task_rows
        fired = []

        def racing_lock(db, ids, skip_locked=False):
            if not fired:
                fired.append(1)
                other = database.SessionLocal()
                try:
                    row = other.query(models.Task).filter(models.Task.id == p.id).first()
                    row.parent_task_id = x.id
                    other.commit()
                finally:
                    other.close()
            return real(db, ids, skip_locked)

        T._lock_task_rows = racing_lock
        try:
            self.assertEqual(self.code(lambda: self.move(x, parent_task_id=p.id)), 422)
        finally:
            T._lock_task_rows = real
        self.assertEqual(self.row(x.id).parent_task_id, "")
        self.assertEqual(self.row(p.id).parent_task_id, x.id)

    def test_undo_puts_back_the_place_section_team_and_skip_rule(self):
        sec = models.TaskSection(id=gen_id(), project_id=self.ops.id, name="Later", custom=True)
        self.db.add(sec)
        self.db.commit()
        a = self.task("A", project_id=self.ops.id, recurrence={"freq": "weekly", "interval": 1})
        kid = self.task("Kid", parent=a, recurrence={"skip": True}, position=3)
        self.move(kid, parent_task_id="")
        self.assertIsNone(self.row(kid.id).recurrence)
        # The Undo sends what the task had.
        self.move(self.row(kid.id), parent_task_id=a.id, position=3, recurrence={"skip": True})
        r = self.row(kid.id)
        self.assertEqual((r.parent_task_id, r.position, r.recurrence), (a.id, 3, {"skip": True}))
        top = self.task("Top", project_id=self.ops.id, section_id=sec.id, team_id="team-1", position=7)
        self.move(top, parent_task_id=a.id)
        self.move(self.row(top.id), parent_task_id="", project_id=self.ops.id, section_id=sec.id,
                  team_id="team-1", position=7)
        r = self.row(top.id)
        self.assertEqual((r.parent_task_id, r.section_id, r.team_id, r.position), ("", sec.id, "team-1", 7))

    def test_a_subtree_keeps_its_sections_when_the_project_does_not_change(self):
        sec = models.TaskSection(id=gen_id(), project_id=self.ops.id, name="Now", custom=True)
        self.db.add(sec)
        self.db.commit()
        a = self.task("A", project_id=self.ops.id)
        b = self.task("B", project_id=self.ops.id)
        kid = self.task("Kid", parent=a)
        grand = self.task("Grand", parent=kid, section_id=sec.id)
        self.move(kid, parent_task_id=b.id)
        self.assertEqual(self.row(grand.id).section_id, sec.id)

    def test_a_blank_child_taken_off_the_list_keeps_its_project(self):
        a = self.task("A", project_id=self.ops.id)
        kid = self.task("Kid", parent=a, project_id="")
        self.move(a, subtask_ids=[])
        r = self.row(kid.id)
        self.assertEqual((r.parent_task_id, r.project_id), ("", self.ops.id))


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

    def test_a_move_never_widens_and_narrows_under_a_private_parent(self):
        # Oct 22 2026 (privacy fix): under a restricted parent the moved task
        # and its subtree become at least as private as the parent - a subtask
        # is never wider than the task it sits under. Moving back out (the
        # Undo) never widens anything: opening a task to everyone is its own
        # act, with its own right (_may_open_up).
        a = self.task("A", created_by=EDITOR["email"], access_level="org")
        c = self.task("C", parent=a, created_by=OWNER["email"], access_level="org")
        r = self.task("Private parent", created_by=EDITOR["email"], access_level="restricted")
        self.move(a, user=EDITOR, parent_task_id=r.id)
        self.assertEqual((self.row(a.id).access_level, self.row(c.id).access_level), ("restricted", "restricted"))
        self.assertEqual(self.activity(a.id), ["moved this task under another task - now private, like the task it is under"],
                         "a private parent's code stays out of the history")
        self.move(self.row(a.id), user=EDITOR, parent_task_id="")
        self.assertEqual((self.row(a.id).access_level, self.row(c.id).access_level), ("restricted", "restricted"))

    def test_private_tasks_do_not_move_into_a_wider_project(self):
        # Assigned a restricted standalone task (editor on THAT task), but not
        # its owner or creator: may not widen it directly, nor by moving it
        # under a task in an org-wide project.
        org = self.project("Org", access_level="org")
        x = self.task("Org task", project_id=org.id, created_by=EDITOR["email"])
        secret = self.task("Secret", created_by=OWNER["email"], owner_email=OWNER["email"],
                           access_level="restricted", assignee_email=EDITOR["email"],
                           assignee_emails=[EDITOR["email"]])
        kid = self.task("Secret kid", parent=secret, created_by=OWNER["email"], access_level="restricted")
        self.assertEqual(self.code(lambda: self.move(secret, user=EDITOR, access_level="org")), 403)
        self.assertEqual(self.code(lambda: self.move(self.row(secret.id), user=EDITOR, parent_task_id=x.id)), 403)
        s, k = self.row(secret.id), self.row(kid.id)
        self.assertEqual((s.parent_task_id, s.project_id, k.project_id), ("", "", ""))
        # Its owner may.
        self.move(self.row(secret.id), user=OWNER, parent_task_id=x.id)
        self.assertEqual(self.row(secret.id).project_id, org.id)
        self.assertEqual(self.row(secret.id).access_level, "restricted")

    def test_one_private_subtask_is_enough_to_refuse(self):
        a, kid, leaf, binned, target = self._tree()
        # Owner-created private step somewhere down the tree: a project editor
        # of the source may move it (the same person may open it up).
        leaf.access_level = "restricted"
        self.db.commit()
        self.move(kid, user=EDITOR, parent_task_id=target.id)
        self.assertEqual(self.row(leaf.id).access_level, "restricted")
        # A standalone tree has no project editor: a private row in it needs
        # its owner, creator or a manager.
        top = self.task("Mine", created_by=EDITOR["email"])
        self.task("Theirs", parent=top, created_by=OWNER["email"], access_level="restricted")
        self.assertEqual(self.code(lambda: self.move(top, user=EDITOR, parent_task_id=target.id)), 403)
        self.move(self.row(top.id), user=MANAGER, parent_task_id=target.id)
        self.assertEqual(self.row(top.id).parent_task_id, target.id)

    def test_an_assignee_who_only_views_the_project_can_lift_a_blank_subtask_out(self):
        p = self.project("Restricted", member_roles={EDITOR["email"]: "viewer"}, member_emails=[EDITOR["email"]])
        top = self.task("Top", project_id=p.id)
        sub = self.task("Sub", parent=top, project_id="", assignee_email=EDITOR["email"],
                        assignee_emails=[EDITOR["email"]])
        self.move(sub, user=EDITOR, parent_task_id="")
        r = self.row(sub.id)
        self.assertEqual((r.parent_task_id, r.project_id), ("", p.id))
        sub2 = self.task("Sub2", parent=top, project_id=p.id, assignee_email=EDITOR["email"],
                         assignee_emails=[EDITOR["email"]])
        self.move(sub2, user=EDITOR, parent_task_id="", project_id=p.id)   # the hint the client sends
        self.assertEqual(self.row(sub2.id).parent_task_id, "")

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


class PrivateParentTests(Base):
    def test_search_does_not_name_a_parent_the_caller_cannot_see(self):
        hidden = self.project("HR")
        secret = self.task("Salary review", project_id=hidden.id, access_level="restricted")
        open_kid = self.task("Quarterly survey", parent=secret, project_id="", access_level="org")
        out = T.search_everything(q="quarterly", limit=6, user=VIEWER, db=self.db)
        [hit] = [t for t in out["tasks"] if t["id"] == open_kid.id]
        self.assertEqual(hit["parentTitle"], "")
        out = T.search_everything(q="quarterly", limit=6, user=MANAGER, db=self.db)
        self.assertEqual([t["parentTitle"] for t in out["tasks"]], ["Salary review"])


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
