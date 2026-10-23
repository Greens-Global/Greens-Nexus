"""A subtask private only BECAUSE of its private parent stays in sight of
whoever sees that parent (Oct 22 2026, integration review of the Planner
parity batch).

A subtask is never wider than its parent (tasks._narrow_to_parent). When a
subtask is private only because of its parent - made, moved, converted,
copied or cascaded under a private task - it carries narrowed_by == its
parent, and task_util.ParentSight lets the parent's people see it, up the
chain while each link is inherited. ONE rule, shared by the single-task
checks, GET /tasks, the delta, search and My Day:

- the parent's owner makes it private and still sees a subtask somebody
  else owns; an assignee adds a subtask and the owner sees it;
- a subtask somebody made private BY HAND gets nothing from its parent (a
  parent's follower never sees it); externals never get the hop; a parent
  over the company wall grants nothing; an outsider sees nothing; a private
  subtask under an ORG-WIDE parent is as hidden as ever;
- a move re-stamps the marker only for someone who may open the task up;
- a level re-sent unchanged keeps the marker; a list resolves parents in a
  constant number of queries; the delta re-judges inherited subtasks;
- making a task private takes its org-wide subtasks along with a trace
  ("N subtasks made private too"), and opening it again brings back the
  ones private only because of it - never one set by hand since, never one
  under a still-private task.

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
EXT = {"email": "guest@vendor.com", "level": 1, "external": True}
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

    def tree(self, top_level="org", kid_level="org", inherited=False, **top):
        """A parent (owned by OWNER) and one subtask owned by OTHER.
        `inherited`: the subtask is private only because of the parent."""
        top.setdefault("owner_email", OWNER["email"])
        parent = self.task(title="Parent", access_level=top_level, **top)
        kid = self.task(title="Kid", access_level=kid_level, parent_task_id=parent.id,
                        owner_email=OTHER["email"], created_by=OTHER["email"],
                        narrowed_by=parent.id if inherited else "")
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
        self.assertEqual((self.row(kid.id).access_level, self.row(kid.id).narrowed_by), ("restricted", parent.id))
        for who in (OWNER, HELPER, OTHER):
            self.assertTrue(self.sees(who, kid.id), who)
            self.assertTrue(self.can_open(who, kid.id), who)
        self.assertFalse(self.sees(OUTSIDER, kid.id))
        self.assertFalse(self.can_open(OUTSIDER, kid.id))

    def test_an_assignee_adds_a_subtask_and_the_owner_sees_it(self):
        parent = self.task(title="Parent", access_level="restricted", owner_email=OWNER["email"],
                           assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]])
        sub = T.create_task(T.TaskCreate(title="By helper", parent_task_id=parent.id), self.bg, user=HELPER, db=self.db)
        self.assertEqual((sub["accessLevel"], sub["narrowedBy"]), ("restricted", parent.id))
        self.assertTrue(self.sees(OWNER, sub["id"]))
        self.assertTrue(self.can_open(OWNER, sub["id"]))
        self.assertFalse(self.sees(OUTSIDER, sub["id"]))
        # Made private on purpose: no marker, nothing from the parent.
        own = T.create_task(T.TaskCreate(title="Mine alone", parent_task_id=parent.id, access_level="restricted"),
                            self.bg, user=HELPER, db=self.db)
        self.assertEqual(own["narrowedBy"], "")
        self.assertFalse(self.sees(OWNER, own["id"]))

    def test_a_hand_restricted_subtask_stays_hidden_from_the_parents_followers(self):
        parent = self.task(title="Offsite", access_level="restricted", owner_email=OWNER["email"],
                           follower_emails=[HELPER["email"]])
        kid = self.task(title="Severance", access_level="restricted", parent_task_id=parent.id,
                        owner_email=OTHER["email"], created_by=OTHER["email"])
        self.assertTrue(self.sees(HELPER, parent.id))
        self.assertFalse(self.sees(HELPER, kid.id))
        with self.assertRaises(HTTPException) as e:
            self.patch(kid, user=HELPER, title="renamed")
        self.db.rollback()
        self.assertEqual(e.exception.status_code, 404)

    def test_an_external_never_gets_the_hop(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True,
                                follower_emails=[EXT["email"]])
        self.assertTrue(task_visible_to(self.db, EXT, self.row(parent.id)))
        self.assertFalse(self.sees(EXT, kid.id))
        self.assertTrue(self.sees(OWNER, kid.id))

    def test_down_the_chain_and_through_the_parents_project(self):
        project = models.TaskProject(id=gen_id(), name="Secret", access_level="restricted", owner_email=OWNER["email"],
                                     member_emails=[MEMBER["email"]], created_at=now_iso(), company_id=COA)
        self.db.add(project)
        self.db.commit()
        top = self.task(title="Top", access_level="restricted", project_id=project.id, owner_email=OWNER["email"])
        mid = self.task(title="Mid", access_level="restricted", parent_task_id=top.id, owner_email=OTHER["email"],
                        narrowed_by=top.id)
        low = self.task(title="Low", access_level="restricted", parent_task_id=mid.id, owner_email=OTHER["email"],
                        narrowed_by=mid.id)
        for who in (OWNER, MEMBER):
            self.assertTrue(self.sees(who, low.id), who)
        self.assertFalse(self.sees(OUTSIDER, low.id))
        # A hand-set link breaks the chain for the parent's own people.
        lone = self.task(title="Lone", access_level="restricted", owner_email=OWNER["email"])
        a = self.task(title="A", access_level="restricted", parent_task_id=lone.id, owner_email=OTHER["email"])
        b = self.task(title="B", access_level="restricted", parent_task_id=a.id, owner_email=OTHER["email"],
                      narrowed_by=a.id)
        self.assertFalse(self.sees(OWNER, a.id))
        self.assertFalse(self.sees(OWNER, b.id))

    def test_a_private_subtask_under_an_org_wide_parent_stays_hidden(self):
        parent, kid = self.tree(kid_level="restricted", inherited=True)   # even with a stale marker
        self.assertTrue(self.sees(OUTSIDER, parent.id))
        self.assertFalse(self.sees(OUTSIDER, kid.id))
        self.assertFalse(self.sees(OWNER, kid.id))
        self.assertFalse(self.can_open(OUTSIDER, kid.id))

    def test_a_trashed_or_cyclic_parent_confers_nothing(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True)
        parent.parent_task_id, parent.narrowed_by = kid.id, kid.id       # bad data: a loop
        self.db.commit()
        self.assertTrue(self.sees(OWNER, kid.id))
        self.assertFalse(self.sees(OUTSIDER, kid.id))
        self.assertFalse(self.sees(OUTSIDER, parent.id))
        parent.parent_task_id, parent.narrowed_by, parent.deleted_at = "", "", now_iso()
        self.db.commit()
        self.assertFalse(self.sees(OWNER, kid.id))

    def test_the_company_wall(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True)
        self.assertTrue(self.sees(OWNER, kid.id))
        self.assertFalse(any(r["id"] == kid.id for r in T.list_tasks(user=OTHERCO, db=self.db)))
        with self.assertRaises(HTTPException) as e:
            T.list_checklist(kid.id, user=OTHERCO, db=self.db)
        self.assertEqual(e.exception.status_code, 404)
        # A parent over the wall grants nothing, even to a (stale) follower of it.
        far = self.task(title="B parent", access_level="restricted", owner_email=OTHERCO["email"],
                        created_by=OTHERCO["email"], company_id=COB, follower_emails=[OUTSIDER["email"]])
        near = self.task(title="A kid", access_level="restricted", parent_task_id=far.id, company_id=COA,
                         owner_email=OTHER["email"], created_by=OTHER["email"], narrowed_by=far.id)
        self.assertFalse(self.sees(OUTSIDER, near.id))
        self.assertFalse(self.can_open(OUTSIDER, near.id))

    def test_my_day_agrees(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True)
        kid.assignee_email, kid.assignee_emails, kid.due_on = HELPER["email"], [HELPER["email"]], TODAY
        self.db.commit()
        MD.add_to_my_day(MD.MyDayTask(day=TODAY, task_id=kid.id), user=OWNER, db=self.db)
        mine = MD.get_my_day(day=TODAY, user=OWNER, db=self.db)
        self.assertIn(kid.id, [t["id"] for t in mine["tasks"]])
        with self.assertRaises(HTTPException) as e:
            MD.add_to_my_day(MD.MyDayTask(day=TODAY, task_id=kid.id), user=OUTSIDER, db=self.db)
        self.assertEqual(e.exception.status_code, 404)

    def test_a_move_carries_the_marker_only_for_someone_who_may_open_it_up(self):
        # The reviewer's scenario: K private on purpose, HELPER only its assignee;
        # Q is HELPER's own private task, OUTSIDER follows it.
        k = self.task(title="Private K", access_level="restricted", owner_email=OTHER["email"],
                      created_by=OTHER["email"], assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]])
        q = self.task(title="Q", access_level="restricted", owner_email=HELPER["email"],
                      created_by=HELPER["email"], follower_emails=[OUTSIDER["email"]])
        self.patch(k, user=HELPER, parent_task_id=q.id)
        self.assertEqual(self.row(k.id).narrowed_by, "")
        self.assertFalse(self.sees(OUTSIDER, k.id))
        # Private because of an old parent: an assignee's move clears the
        # marker (K stays private to its own people)...
        old = self.task(title="Old", access_level="restricted", owner_email=OTHER["email"])
        k2 = self.task(title="K2", access_level="restricted", parent_task_id=old.id, owner_email=OTHER["email"],
                       created_by=OTHER["email"], assignee_email=HELPER["email"], assignee_emails=[HELPER["email"]],
                       narrowed_by=old.id)
        self.patch(k2, user=HELPER, parent_task_id=q.id)
        self.assertEqual(self.row(k2.id).narrowed_by, "")
        self.assertFalse(self.sees(OUTSIDER, k2.id))
        # ...its owner's move carries it to the new parent.
        k3 = self.task(title="K3", access_level="restricted", parent_task_id=old.id, owner_email=OTHER["email"],
                       created_by=OTHER["email"], narrowed_by=old.id)
        q.follower_emails = [OUTSIDER["email"], OTHER["email"]]
        self.db.commit()
        self.patch(k3, user=OTHER, parent_task_id=q.id)
        self.assertEqual(self.row(k3.id).narrowed_by, q.id)
        self.assertTrue(self.sees(OUTSIDER, k3.id))
        # An org-wide task moved under a private one is private because of it.
        k4 = self.task(title="K4", access_level="org", owner_email=HELPER["email"], created_by=HELPER["email"])
        self.patch(k4, user=HELPER, parent_task_id=q.id)
        self.assertEqual((self.row(k4.id).access_level, self.row(k4.id).narrowed_by), ("restricted", q.id))
        self.assertTrue(self.sees(OUTSIDER, k4.id))

    def test_the_same_level_re_sent_keeps_the_marker(self):
        parent, kid = self.tree()
        self.patch(parent, access_level="restricted")
        self.patch(kid, user=OTHER, access_level="restricted", title="just a rename")
        self.assertEqual(self.row(kid.id).narrowed_by, parent.id)
        self.patch(parent, access_level="org")
        self.assertEqual(self.row(kid.id).access_level, "org")

    def test_the_delta_re_judges_inherited_subtasks(self):
        parent, kid = self.tree(top_level="restricted", kid_level="restricted", inherited=True,
                                follower_emails=[HELPER["email"]])
        first = T.list_tasks_delta(since="", user=HELPER, db=self.db)
        self.assertIn(kid.id, [t["id"] for t in first["tasks"]])
        self.patch(parent, follower_emails=[])
        after = T.list_tasks_delta(since=first["serverTime"], user=HELPER, db=self.db)
        self.assertIn(parent.id, after["deletedIds"])
        self.assertIn(kid.id, after["deletedIds"])
        self.patch(parent, follower_emails=[HELPER["email"]])
        back = T.list_tasks_delta(since=after["serverTime"], user=HELPER, db=self.db)
        self.assertIn(kid.id, [t["id"] for t in back["tasks"]])

    def test_a_parent_made_private_mid_create_makes_a_private_subtask(self):
        parent = self.task(title="P", access_level="org", owner_email=OWNER["email"])
        self.db.get(models.Task, parent.id).access_level      # held in this session
        other = database.SessionLocal()
        other.get(models.Task, parent.id).access_level = "restricted"
        other.commit()
        other.close()
        out = T.create_task(T.TaskCreate(title="kid", parent_task_id=parent.id), self.bg, user=OWNER, db=self.db)
        self.assertEqual((out["accessLevel"], out["narrowedBy"]), ("restricted", parent.id))

    def test_a_list_resolves_parents_in_a_constant_number_of_queries(self):
        def build(n):
            for i in range(n):
                p = self.task(title=f"P{i}", access_level="restricted", owner_email=OWNER["email"])
                k = self.task(title=f"K{i}", access_level="restricted", parent_task_id=p.id,
                              owner_email=OTHER["email"], narrowed_by=p.id)
                self.task(title=f"G{i}", access_level="restricted", parent_task_id=k.id,
                          owner_email=OTHER["email"], narrowed_by=k.id)

        def selects(rows):
            seen = []

            def on(conn, cursor, statement, *a):
                if statement.lstrip().upper().startswith("SELECT"):
                    seen.append(statement)
            event.listen(database.engine, "before_cursor_execute", on)
            try:
                ps = ParentSight(self.db, rows, user=OWNER)
                vis = [t for t in rows if T.task_is_visible(t, OWNER, set(), ps)]
            finally:
                event.remove(database.engine, "before_cursor_execute", on)
            return len(seen), len(vis)

        build(3)
        self.db.expire_all()
        few = [t for t in self.db.query(models.Task).all() if t.title.startswith("G")]
        q_few, v_few = selects(few)
        build(30)
        self.db.expire_all()
        many = [t for t in self.db.query(models.Task).all() if t.title.startswith("G")]
        q_many, v_many = selects(many)
        self.assertEqual((v_few, v_many), (3, 33))
        # One batch per level of the chain, plus the viewer's company scope once.
        # (the settings read behind the scope may be cached by then - never more).
        self.assertLessEqual(q_few, 3)
        self.assertLessEqual(q_many, q_few)
        self.db.expire_all()
        everything = self.db.query(models.Task).all()
        self.assertLessEqual(selects(everything)[0], 1)   # parents all in hand: the scope read only


class CascadeTests(Base):
    def acts(self, tid, type_="subtasks_access"):
        self.db.expire_all()
        return [a for a in self.db.query(models.TaskActivity).filter_by(entity_id=tid, type=type_).order_by(
            models.TaskActivity.at).all()]

    def test_made_private_leaves_a_trace_and_opening_brings_back_the_inherited_ones(self):
        parent, kid = self.tree()
        own = self.task(title="Own private", access_level="restricted", parent_task_id=parent.id)
        hand = self.task(title="Set by hand later", access_level="org", parent_task_id=parent.id)
        low = self.task(title="Below kid", access_level="org", parent_task_id=kid.id)
        parent.subtask_ids, kid.subtask_ids = [kid.id, own.id, hand.id], [low.id]
        self.db.commit()
        self.patch(parent, access_level="restricted")
        acts = self.acts(parent.id)
        self.assertEqual([a.detail for a in acts], ["3 subtasks made private too"])
        self.assertEqual(sorted(acts[0].field_change["subtaskIds"]), sorted([kid.id, hand.id, low.id]))
        self.assertEqual((self.row(kid.id).narrowed_by, self.row(low.id).narrowed_by), (parent.id, kid.id))
        self.assertEqual(self.row(own.id).narrowed_by, "")
        self.patch(parent, access_level="org")
        self.assertEqual((self.row(kid.id).access_level, self.row(low.id).access_level), ("org", "org"))
        self.assertEqual(self.row(kid.id).narrowed_by, "")
        self.assertEqual(self.row(own.id).access_level, "restricted")    # never one of the cascade
        self.assertEqual(self.acts(parent.id)[-1].detail, "3 subtasks opened to everyone again")

    def test_a_level_changed_by_hand_is_not_opened_again(self):
        parent, kid = self.tree()
        sib = self.task(title="Sibling", access_level="org", parent_task_id=parent.id, owner_email=OTHER["email"])
        parent.subtask_ids = [kid.id, sib.id]
        self.db.commit()
        self.patch(parent, access_level="restricted")
        self.patch(parent, access_level="org")
        # OTHER makes the sibling private by hand (a hand change under a
        # private parent is refused, so under the open one): no marker.
        self.patch(sib, user=OTHER, access_level="restricted")
        self.assertEqual(self.row(sib.id).narrowed_by, "")
        self.patch(parent, access_level="restricted")
        self.patch(parent, access_level="org")
        self.assertEqual(self.row(sib.id).access_level, "restricted")
        self.assertEqual(self.row(kid.id).access_level, "org")

    def test_opening_again_never_widens_under_a_still_private_task(self):
        top, mid = self.tree()
        low = self.task(title="Low", access_level="org", parent_task_id=mid.id)
        mid.subtask_ids = [low.id]
        self.db.commit()
        self.patch(top, access_level="restricted")
        self.assertEqual((self.row(mid.id).access_level, self.row(low.id).access_level), ("restricted", "restricted"))
        # mid made private on purpose (its marker gone - set here as data:
        # a hand change of a subtask under a private task is refused).
        m = self.row(mid.id)
        m.narrowed_by = ""
        self.db.commit()
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

    def test_a_level_change_and_completing_a_repeating_task_are_two_steps(self):
        rule = {"freq": "weekly", "interval": 1, "daysOfWeek": [1]}
        t = self.task(title="Weekly", access_level="org", owner_email=OWNER["email"], due_on="2026-10-19",
                      recurrence=dict(rule))
        with self.assertRaises(HTTPException) as e:
            self.patch(t, access_level="restricted", completed=True)
        self.db.rollback()
        self.assertEqual(e.exception.status_code, 422)
        self.patch(t, access_level="restricted")
        self.patch(t, completed=True)
        nxt = self.db.query(models.Task).filter(models.Task.title == "Weekly", models.Task.id != t.id).one()
        self.assertEqual(nxt.access_level, "restricted")


if __name__ == "__main__":
    unittest.main()
