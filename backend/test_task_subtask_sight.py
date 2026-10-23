"""A private subtask stays in sight of whoever sees its private parent
(Oct 22 2026, integration review of the Planner parity batch).

A subtask is never wider than its parent (tasks._narrow_to_parent), so a
subtask under a private task is private too. task_util.ParentSight keeps it
in sight of the people who can see that parent - its owner, assignees,
followers and project people - up the parent chain, in ONE rule shared by
the single-task checks, GET /tasks, the delta, search and My Day:

- the parent's owner makes it private and still sees a subtask somebody
  else owns; an assignee adds a subtask and the owner sees it;
- an outsider sees neither, and a private subtask under an ORG-WIDE parent
  is as hidden as ever;
- a list resolves parents in a constant number of queries;
- making a task private takes its org-wide subtasks along with a trace
  ("N subtasks made private too"), and opening it again brings exactly
  those back - never one set by hand since, never one under a still-private
  task.

Throwaway SQLite, no network.  python -m pytest test_task_subtask_sight.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402
from sqlalchemy import event  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
from routers import task_my_day as MD  # noqa: E402
from routers import tasks as T  # noqa: E402
from routers.task_util import ParentSight, gen_id, now_iso, task_visible_to  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

OWNER = {"email": "owner@greensglobal.com", "level": 1}
HELPER = {"email": "helper@greensglobal.com", "level": 1}     # an assignee of the parent
OTHER = {"email": "other@greensglobal.com", "level": 1}       # owns a subtask
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
MEMBER = {"email": "member@greensglobal.com", "level": 1}     # on the restricted project
OTHERCO = {"email": "b@greensglobal.com", "level": 3}         # a manager in another company
COA, COB = "co-a", "co-b"
TODAY = "2026-10-22"


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
                  models.NexusNotification, models.NexusEmployee, models.NexusSetting, models.TaskTablePref,
                  models.TaskChecklistItem):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u, co in ((OWNER, COA), (HELPER, COA), (OTHER, COA), (OUTSIDER, COA), (MEMBER, COA), (OTHERCO, COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], status="active",
                                             first_name=u["email"].split("@")[0], company=co))
        self.db.commit()
        cache.settings_config.invalidate()
        self.bg = BackgroundTasks()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def task(self, **kw):
        kw.setdefault("project_id", "")
        kw.setdefault("company_id", COA)
        kw.setdefault("status", "not_started")
        kw.setdefault("created_by", kw.get("owner_email") or OWNER["email"])
        t = models.Task(id=gen_id(), title=kw.pop("title", "Pump"), code=f"T-{gen_id()[:6]}",
                        attachment_ids=[], activity_ids=[], subtask_ids=[], created_at=now_iso(),
                        modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def tree(self, top_level="org", kid_level="org", **top):
        top.setdefault("owner_email", OWNER["email"])
        parent = self.task(title="Parent", access_level=top_level, **top)
        kid = self.task(title="Kid", access_level=kid_level, parent_task_id=parent.id,
                        owner_email=OTHER["email"], created_by=OTHER["email"])
        parent.subtask_ids = [kid.id]
        self.db.commit()
        return parent, kid

    def patch(self, t, user=OWNER, **fields):
        return T.update_task(t.id, T.TaskUpdate(**fields), self.bg, user=user, db=self.db)

    def row(self, tid):
        self.db.expire_all()
        return self.db.get(models.Task, tid)

    def sees(self, user, tid):
        """The single-task rule (require_task_role's), the list, and the delta."""
        self.db.expire_all()
        one = task_visible_to(self.db, user, self.db.get(models.Task, tid))
        listed = any(r["id"] == tid for r in T.list_tasks(user=user, db=self.db))
        delta = any(r["id"] == tid for r in T.list_tasks_delta(since="", user=user, db=self.db)["tasks"])
        self.assertEqual(len({one, listed, delta}), 1, (one, listed, delta))
        return one

    def can_open(self, user, tid):
        try:
            T.list_checklist(tid, user=user, db=self.db)
            return True
        except HTTPException as e:
            self.db.rollback()
            self.assertEqual(e.status_code, 404)
            return False


class SightTests(Base):
    def test_the_owner_makes_the_parent_private_and_still_sees_the_subtask(self):
        parent, kid = self.tree(assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]])
        self.patch(parent, access_level="restricted")
        self.assertEqual(self.row(kid.id).access_level, "restricted")
        for who in (OWNER, HELPER, OTHER):
            self.assertTrue(self.sees(who, kid.id), who)
            self.assertTrue(self.can_open(who, kid.id), who)
        self.assertFalse(self.sees(OUTSIDER, kid.id))
        self.assertFalse(self.can_open(OUTSIDER, kid.id))

    def test_an_assignee_adds_a_subtask_and_the_owner_sees_it(self):
        parent = self.task(title="Parent", access_level="restricted", owner_email=OWNER["email"],
                           assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]])
        sub = T.create_task(T.TaskCreate(title="By helper", parent_task_id=parent.id), self.bg, user=HELPER, db=self.db)
        self.assertEqual(sub["accessLevel"], "restricted")
        self.assertTrue(self.sees(OWNER, sub["id"]))
        self.assertTrue(self.can_open(OWNER, sub["id"]))
        self.assertFalse(self.sees(OUTSIDER, sub["id"]))

    def test_down_the_chain_and_through_the_parents_project(self):
        project = models.TaskProject(id=gen_id(), name="Secret", access_level="restricted", owner_email=OWNER["email"],
                                     member_emails=[MEMBER["email"]], created_at=now_iso(), company_id=COA)
        self.db.add(project)
        self.db.commit()
        top = self.task(title="Top", access_level="restricted", project_id=project.id, owner_email=OWNER["email"])
        mid = self.task(title="Mid", access_level="restricted", parent_task_id=top.id, owner_email=OTHER["email"])
        low = self.task(title="Low", access_level="restricted", parent_task_id=mid.id, owner_email=OTHER["email"])
        for who in (OWNER, MEMBER):
            self.assertTrue(self.sees(who, low.id), who)
        self.assertFalse(self.sees(OUTSIDER, low.id))

    def test_a_private_subtask_under_an_org_wide_parent_stays_hidden(self):
        parent, kid = self.tree(kid_level="restricted")
        self.assertTrue(self.sees(OUTSIDER, parent.id))
        self.assertFalse(self.sees(OUTSIDER, kid.id))
        self.assertFalse(self.sees(OWNER, kid.id))   # the parent's owner gets nothing from an org parent either
        self.assertFalse(self.can_open(OUTSIDER, kid.id))

    def test_a_trashed_or_cyclic_parent_confers_nothing(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted")
        parent.parent_task_id = kid.id          # bad data: a loop
        self.db.commit()
        self.assertTrue(self.sees(OWNER, kid.id))
        self.assertFalse(self.sees(OUTSIDER, kid.id))
        parent.parent_task_id, parent.deleted_at = "", now_iso()
        self.db.commit()
        self.assertFalse(self.sees(OWNER, kid.id))

    def test_the_company_wall_comes_first(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        parent, kid = self.tree(top_level="restricted", kid_level="restricted")
        self.assertTrue(self.sees(OWNER, kid.id))
        self.assertFalse(any(r["id"] == kid.id for r in T.list_tasks(user=OTHERCO, db=self.db)))
        with self.assertRaises(HTTPException) as e:
            T.list_checklist(kid.id, user=OTHERCO, db=self.db)
        self.assertEqual(e.exception.status_code, 404)

    def test_my_day_agrees(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted")
        kid.assignee_email, kid.assignee_emails, kid.due_on = HELPER["email"], [HELPER["email"]], TODAY
        self.db.commit()
        # The owner adds the subtask (seen through the parent) to their own day.
        MD.add_to_my_day(MD.MyDayTask(day=TODAY, task_id=kid.id), user=OWNER, db=self.db)
        mine = MD.get_my_day(day=TODAY, user=OWNER, db=self.db)
        self.assertIn(kid.id, [t["id"] for t in mine["tasks"]])
        with self.assertRaises(HTTPException) as e:
            MD.add_to_my_day(MD.MyDayTask(day=TODAY, task_id=kid.id), user=OUTSIDER, db=self.db)
        self.assertEqual(e.exception.status_code, 404)

    def test_a_list_resolves_parents_in_a_constant_number_of_queries(self):
        def build(n):
            for i in range(n):
                p = self.task(title=f"P{i}", access_level="restricted", owner_email=OWNER["email"])
                k = self.task(title=f"K{i}", access_level="restricted", parent_task_id=p.id, owner_email=OTHER["email"])
                self.task(title=f"G{i}", access_level="restricted", parent_task_id=k.id, owner_email=OTHER["email"])

        def selects(rows):
            seen = []

            def on(conn, cursor, statement, *a):
                if statement.lstrip().upper().startswith("SELECT"):
                    seen.append(statement)
            event.listen(database.engine, "before_cursor_execute", on)
            try:
                ps = ParentSight(self.db, rows)
                vis = [t for t in rows if T.task_is_visible(t, OWNER, set(), ps)]
            finally:
                event.remove(database.engine, "before_cursor_execute", on)
            return len(seen), len(vis)

        build(3)
        self.db.expire_all()
        # Only the grandchildren in hand: their parents and grandparents are read in batches.
        few = [t for t in self.db.query(models.Task).all() if t.title.startswith("G")]
        q_few, v_few = selects(few)
        build(30)
        self.db.expire_all()
        many = [t for t in self.db.query(models.Task).all() if t.title.startswith("G")]
        q_many, v_many = selects(many)
        self.assertEqual((v_few, v_many), (3, 33))
        self.assertLessEqual(q_many, 2)             # one batch per level of the chain
        self.assertEqual(q_few, q_many)
        # A whole list (every row loaded already) costs no parent query at all.
        self.db.expire_all()
        everything = self.db.query(models.Task).all()
        self.assertEqual(selects(everything)[0], 0)


class CascadeTests(Base):
    def acts(self, tid, type_="subtasks_access"):
        self.db.expire_all()
        return [a for a in self.db.query(models.TaskActivity).filter_by(entity_id=tid, type=type_).order_by(
            models.TaskActivity.at).all()]

    def test_made_private_leaves_a_trace_and_opening_brings_exactly_those_back(self):
        parent, kid = self.tree()
        own = self.task(title="Own private", access_level="restricted", parent_task_id=parent.id)
        hand = self.task(title="Set by hand later", access_level="org", parent_task_id=parent.id)
        parent.subtask_ids = [kid.id, own.id, hand.id]
        self.db.commit()
        self.patch(parent, access_level="restricted")
        acts = self.acts(parent.id)
        self.assertEqual([a.detail for a in acts], ["2 subtasks made private too"])
        self.assertEqual(sorted(acts[0].field_change["subtaskIds"]), sorted([kid.id, hand.id]))
        self.assertEqual(self.row(kid.id).narrowed_by, parent.id)
        # Someone sets one by hand meanwhile (it stays private: the parent still is).
        self.patch(hand, access_level="restricted")
        self.assertEqual(self.row(hand.id).narrowed_by, "")
        self.patch(parent, access_level="org")
        self.assertEqual(self.row(kid.id).access_level, "org")
        self.assertEqual(self.row(kid.id).narrowed_by, "")
        self.assertEqual(self.row(own.id).access_level, "restricted")    # never one of the cascade
        self.assertEqual(self.row(hand.id).access_level, "restricted")   # set by hand since
        self.assertEqual(self.acts(parent.id)[-1].detail, "1 subtask opened to everyone again")

    def test_opening_again_never_widens_under_a_still_private_task(self):
        top, mid = self.tree()
        low = self.task(title="Low", access_level="org", parent_task_id=mid.id)
        mid.subtask_ids = [low.id]
        self.db.commit()
        self.patch(top, access_level="restricted")
        self.assertEqual((self.row(mid.id).access_level, self.row(low.id).access_level), ("restricted", "restricted"))
        self.patch(mid, user=OTHER, access_level="restricted")   # by hand: mid keeps it
        self.patch(top, access_level="org")
        self.assertEqual(self.row(mid.id).access_level, "restricted")
        self.assertEqual(self.row(low.id).access_level, "restricted")   # its parent is still private

    def test_nothing_to_take_along_writes_nothing(self):
        parent, kid = self.tree(kid_level="restricted")
        self.patch(parent, access_level="restricted")
        self.patch(parent, access_level="org")
        self.assertEqual(self.acts(parent.id), [])
        self.assertEqual(self.row(kid.id).access_level, "restricted")

    def test_a_subtask_under_a_private_task_cannot_be_opened_by_hand(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted")
        with self.assertRaises(HTTPException) as e:
            self.patch(kid, user=OTHER, access_level="org")   # its own owner
        self.db.rollback()
        self.assertEqual(e.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
