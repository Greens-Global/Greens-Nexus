"""Tasks > My Day (Oct 22 2026) - routers/task_my_day.py.

- The list starts each day with my tasks due that day (finished ones stay),
  plus what I add; another day's picks read as an empty list.
- A due-today task I take off stays off (dismissed) until I add it back.
- I may add any task I can see, assigned or not. A restricted task, one over
  the company wall, and a deleted one are refused on add and dropped on read.
- The day is my local date: a real date within a day of the server's.
- Suggestions: Overdue / Due Tomorrow / In Progress / Recently Assigned, ten
  each, never a task already on the list, each task in one group.
- Two tabs never lose each other's change; a tab still on yesterday cannot
  wipe today's list. Nothing here changes a task.

Throwaway SQLite, no network.  python -m pytest test_task_my_day.py
"""
import os
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException

import cache
import database
import models
from routers import task_my_day as M
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

ME = {"email": "me@greensglobal.com", "level": 1}
OTHER = {"email": "other@greensglobal.com", "level": 1}
BOSS = {"email": "boss@greensglobal.com", "level": 3}
BEMP = {"email": "bemp@greensglobal.com", "level": 1}
COA, COB = "co-a", "co-b"

_UTC = datetime.now(timezone.utc).date()
TODAY = _UTC.isoformat()
TOMORROW = (_UTC + timedelta(days=1)).isoformat()
YESTERDAY = (_UTC - timedelta(days=1)).isoformat()


def _days_ago(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


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
        for m in (models.Task, models.TaskProject, models.TaskActivity, models.TaskTablePref,
                  models.NexusEmployee, models.NexusSetting, models.TaskTeam, models.NexusRole):
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u, co in ((ME, COA), (OTHER, COA), (BOSS, COA), (BEMP, COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], status="active",
                                             first_name=u["email"].split("@")[0], company=co))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    # -- helpers -------------------------------------------------------------
    def task(self, **kw):
        kw.setdefault("title", "T")
        kw.setdefault("status", "not_started")
        kw.setdefault("owner_email", OTHER["email"])
        kw.setdefault("created_by", OTHER["email"])
        kw.setdefault("created_at", _days_ago(30))
        kw.setdefault("modified_at", _days_ago(30))
        who = kw.pop("assignee", None)
        if who:
            kw["assignee_email"] = who["email"]
            kw["assignee_emails"] = [who["email"]]
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def get(self, user=ME, day=TODAY):
        return M.get_my_day(day=day, user=user, db=self.db)

    def add(self, t, user=ME, day=TODAY, db=None, pick=True):
        tid = t if isinstance(t, str) else t.id
        return M.add_to_my_day(M.MyDayTask(day=day, task_id=tid, pick=pick), user=user, db=db or self.db)

    def remove(self, t, user=ME, day=TODAY):
        tid = t if isinstance(t, str) else t.id
        return M.remove_from_my_day(M.MyDayTask(day=day, task_id=tid), user=user, db=self.db)

    def order(self, ids, user=ME, day=TODAY, db=None):
        return M.reorder_my_day(M.MyDayOrder(day=day, task_ids=ids), user=user, db=db or self.db)

    def ids(self, payload):
        return [t["id"] for t in payload["tasks"]]

    def group(self, payload, key):
        return [t["id"] for g in payload["suggestions"] if g["key"] == key for t in g["tasks"]]

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def arm_walls(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def store(self, added, dismissed=(), day=TODAY, user=ME):
        """Write a My Day document directly - what an earlier add left behind."""
        self.db.add(models.TaskTablePref(id=gen_id(), owner_email=user["email"], prefs={},
                                         my_day={"day": day, "added": list(added), "dismissed": list(dismissed)}))
        self.db.commit()


class ListTests(Base):
    def test_starts_with_my_tasks_due_today_finished_ones_included(self):
        due = self.task(title="Due", assignee=ME, due_on=TODAY, priority="low")
        urgent = self.task(title="Urgent", assignee=ME, due_on=TODAY, priority="urgent")
        done = self.task(title="Done", assignee=ME, due_on=TODAY, completed=True, status="completed")
        self.task(title="Later", assignee=ME, due_on=TOMORROW)
        self.task(title="Theirs", assignee=OTHER, due_on=TODAY)
        self.task(title="No date", assignee=ME)
        got = self.get()
        self.assertEqual(set(self.ids(got)), {due.id, urgent.id, done.id})
        self.assertEqual(self.ids(got)[0], urgent.id)            # priority first among the due-today tasks
        self.assertEqual(got["addedIds"], [])
        # The list views' shape, so the client renders a row the same everywhere.
        self.assertEqual(got["tasks"][0], T.task_to_dict(urgent))

    def test_a_second_assignee_counts_too(self):
        t = self.task(assignee_email=OTHER["email"], assignee_emails=[OTHER["email"], ME["email"]], due_on=TODAY)
        self.assertEqual(self.ids(self.get()), [t.id])

    def test_adds_go_to_the_top_ahead_of_due_today_tasks(self):
        auto = self.task(title="Auto", assignee=ME, due_on=TODAY)
        a = self.task(title="A", access_level="org")
        b = self.task(title="B", access_level="org")
        self.add(a)
        got = self.add(b)
        self.assertEqual(self.ids(got), [b.id, a.id, auto.id])
        self.assertEqual(got["addedIds"], [b.id, a.id])

    def test_resets_on_a_new_day_and_the_old_picks_do_not_carry_over(self):
        a = self.task(title="A", access_level="org")
        self.add(a)
        self.assertEqual(self.ids(self.get()), [a.id])
        self.assertEqual(self.ids(self.get(day=TOMORROW)), [])
        # The first write of the new day starts from empty.
        b = self.task(title="B", access_level="org")
        got = self.add(b, day=TOMORROW)
        self.assertEqual(got["addedIds"], [b.id])

    def test_a_tab_still_on_yesterday_cannot_wipe_today(self):
        a = self.task(title="A", access_level="org")
        self.add(a, day=TODAY)
        self.assertEqual(self.code(lambda: self.add(self.task(access_level="org"), day=YESTERDAY)), 409)
        self.assertEqual(self.code(lambda: self.remove(a, day=YESTERDAY)), 409)
        self.assertEqual(self.ids(self.get()), [a.id])

    def test_dismissed_due_today_task_stays_off_until_added_back(self):
        t = self.task(assignee=ME, due_on=TODAY)
        got = self.remove(t)
        self.assertEqual(self.ids(got), [])
        self.assertEqual(got["dismissedIds"], [t.id])
        self.assertEqual(self.ids(self.get()), [])
        got = self.add(t)
        self.assertEqual(self.ids(got), [t.id])
        self.assertEqual(got["dismissedIds"], [])

    def test_removing_a_pick_never_touches_the_task(self):
        t = self.task(title="Keep me", access_level="org", due_on=TOMORROW)
        before = (t.modified_at, t.due_on, t.status, t.completed)
        self.add(t)
        self.remove(t)
        self.order([t.id])
        self.db.refresh(t)
        self.assertEqual((t.modified_at, t.due_on, t.status, t.completed), before)
        self.assertEqual(self.db.query(models.TaskActivity).count(), 0)

    def test_my_day_is_mine_alone(self):
        t = self.task(access_level="org")
        self.add(t)
        self.assertEqual(self.ids(self.get(user=OTHER)), [])


class AccessTests(Base):
    def test_a_task_i_can_see_but_am_not_on_can_be_added(self):
        org = self.task(title="Org-wide", access_level="org", assignee=OTHER)
        followed = self.task(title="Followed", access_level="restricted", assignee=OTHER,
                             follower_emails=[ME["email"]])
        p = models.TaskProject(id=gen_id(), name="Mine", access_level="restricted", member_emails=[ME["email"]],
                               created_at=now_iso())
        self.db.add(p)
        self.db.commit()
        in_project = self.task(title="In my project", access_level="restricted", project_id=p.id, assignee=OTHER)
        for t in (org, followed, in_project):
            self.add(t)
        self.assertEqual(set(self.ids(self.get())), {org.id, followed.id, in_project.id})

    def test_restricted_task_refused_on_add_and_hidden_on_read(self):
        secret = self.task(title="Secret", access_level="restricted", assignee=OTHER)
        self.assertEqual(self.code(lambda: self.add(secret)), 404)
        self.store([secret.id])
        got = self.get()
        self.assertEqual(self.ids(got), [])
        self.assertEqual(got["addedIds"], [])
        self.assertNotIn("Secret", str(got))

    def test_a_task_that_goes_private_drops_out_silently(self):
        t = self.task(access_level="org", assignee=OTHER)
        self.add(t)
        t.access_level = "restricted"
        self.db.commit()
        self.assertEqual(self.ids(self.get()), [])

    def test_unknown_and_deleted_tasks_are_refused_and_dropped(self):
        self.assertEqual(self.code(lambda: self.add("no-such-task")), 404)
        t = self.task(access_level="org")
        self.add(t)
        t.deleted_at = now_iso()
        self.db.commit()
        self.assertEqual(self.ids(self.get()), [])
        self.assertEqual(self.code(lambda: self.add(t)), 404)
        mine = self.task(assignee=ME, due_on=TODAY, deleted_at=now_iso())
        self.assertNotIn(mine.id, self.ids(self.get()))

    def test_company_wall_on_add_and_on_read(self):
        b_task = self.task(title="B side", access_level="org", owner_email=BEMP["email"],
                           created_by=BEMP["email"], company_id=COB)
        self.add(b_task)                                       # walls off: an org task is anyone's
        self.arm_walls()
        self.assertEqual(self.ids(self.get()), [])             # walls on: gone from my list
        self.assertEqual(self.code(lambda: self.add(b_task)), 404)
        # Even a manager stops at the wall; inside it a manager sees everything.
        self.assertEqual(self.code(lambda: self.add(b_task, user=BOSS)), 404)
        a_secret = self.task(title="A secret", access_level="restricted", company_id=COA)
        self.assertEqual(self.ids(self.add(a_secret, user=BOSS)), [a_secret.id])

    def test_day_validation(self):
        t = self.task(access_level="org")
        for bad in ("", "today", "2026-1-5", "2026-02-30", "1999-01-01", (_UTC + timedelta(days=3)).isoformat()):
            self.assertEqual(self.code(lambda: self.get(day=bad)), 400, bad)
            self.assertEqual(self.code(lambda: self.add(t, day=bad)), 400, bad)
        for ok in (YESTERDAY, TODAY, TOMORROW):            # every time zone's today
            self.get(day=ok)


class SuggestionTests(Base):
    def test_groups_and_what_goes_in_each(self):
        overdue = self.task(title="Overdue", assignee=ME, due_on=YESTERDAY)
        tomorrow = self.task(title="Tomorrow", assignee=ME, due_on=TOMORROW)
        doing = self.task(title="Doing", assignee=ME, status="in_progress")
        recent = self.task(title="Recent", assignee=ME, created_at=_days_ago(2))
        self.task(title="Old", assignee=ME, created_at=_days_ago(20))
        self.task(title="Mine, made by me", assignee=ME, created_at=_days_ago(1), created_by=ME["email"])
        self.task(title="Done overdue", assignee=ME, due_on=YESTERDAY, completed=True)
        self.task(title="Theirs overdue", assignee=OTHER, due_on=YESTERDAY)
        got = self.get()
        self.assertEqual([g["key"] for g in got["suggestions"]], list(M.GROUPS))
        self.assertEqual(self.group(got, "overdue"), [overdue.id])
        self.assertEqual(self.group(got, "dueTomorrow"), [tomorrow.id])
        self.assertEqual(self.group(got, "inProgress"), [doing.id])
        self.assertEqual(self.group(got, "recentlyAssigned"), [recent.id])

    def test_reassigned_to_me_recently_by_someone_else(self):
        handed = self.task(title="Handed over", assignee=ME, created_at=_days_ago(40))
        took = self.task(title="I took it", assignee=ME, created_at=_days_ago(40))
        stale = self.task(title="Long ago", assignee=ME, created_at=_days_ago(40))
        legacy = self.task(title="No recorded change", assignee=ME, created_at=_days_ago(40))
        kept = self.task(title="Already mine", assignee=ME, created_at=_days_ago(40))
        for t, actor, at, change in (
            (handed, OTHER, _days_ago(1), {"field": "assigneeIds", "from": [OTHER["email"]], "to": [ME["email"]]}),
            (took, ME, _days_ago(1), {"field": "assigneeIds", "from": [], "to": [ME["email"]]}),
            (stale, OTHER, _days_ago(9), {"field": "assigneeIds", "from": [], "to": [ME["email"]]}),
            # Written before field history: it cannot say who was added.
            (legacy, OTHER, _days_ago(1), None),
            # Somebody else was added beside me: not news to me.
            (kept, OTHER, _days_ago(1), {"field": "assigneeIds", "from": [ME["email"]], "to": [ME["email"], OTHER["email"]]}),
        ):
            self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=t.id, type="assignee_changed",
                                            actor_email=actor["email"], at=at, field_change=change))
        self.db.commit()
        self.assertEqual(self.group(self.get(), "recentlyAssigned"), [handed.id])

    def test_a_recurring_occurrence_is_not_recently_assigned(self):
        self.task(title="Weekly report", assignee=ME, created_at=_days_ago(1),
                  recurrence={"freq": "weekly", "interval": 1})
        self.task(title="Recurring status", assignee=ME, created_at=_days_ago(1), status="recurring")
        handed = self.task(title="Handed", assignee=ME, created_at=_days_ago(1))
        self.assertEqual(self.group(self.get(), "recentlyAssigned"), [handed.id])

    def test_each_group_caps_at_ten_and_overdue_is_oldest_first(self):
        days = [(_UTC - timedelta(days=n)).isoformat() for n in range(1, 13)]
        rows = [self.task(title=f"Late {d}", assignee=ME, due_on=d) for d in days]
        got = self.get()
        self.assertEqual(len(self.group(got, "overdue")), M.SUGGEST_CAP)
        self.assertEqual(self.group(got, "overdue")[0], rows[-1].id)   # the most overdue first

    def test_never_a_task_already_on_the_list_and_each_task_once(self):
        both = self.task(title="Late and doing", assignee=ME, due_on=YESTERDAY, status="in_progress")
        picked = self.task(title="Picked", assignee=ME, due_on=YESTERDAY)
        got = self.add(picked)
        self.assertEqual(self.group(got, "overdue"), [both.id])
        self.assertEqual(self.group(got, "inProgress"), [])
        flat = [i for g in got["suggestions"] for i in (t["id"] for t in g["tasks"])]
        self.assertNotIn(picked.id, flat)

    def test_suggestions_respect_the_wall(self):
        self.arm_walls()
        self.task(title="Over the wall", assignee=ME, due_on=YESTERDAY, company_id=COB,
                  owner_email=BEMP["email"], created_by=BEMP["email"])
        self.assertEqual(self.group(self.get(), "overdue"), [])


class OrderAndConcurrencyTests(Base):
    def test_reorder_moves_picks_and_due_today_tasks(self):
        auto = self.task(title="Auto", assignee=ME, due_on=TODAY)
        a = self.task(title="A", access_level="org")
        b = self.task(title="B", access_level="org")
        self.add(a)
        self.add(b)                                      # [b, a, auto]
        got = self.order([auto.id, a.id, b.id])
        self.assertEqual(self.ids(got), [auto.id, a.id, b.id])
        self.assertEqual(got["orderIds"], [auto.id, a.id, b.id])
        self.assertEqual(got["addedIds"], [b.id, a.id])          # ordering never makes a pick

    def test_a_reordered_due_today_task_still_leaves_when_reassigned_or_moved(self):
        auto = self.task(title="Auto", assignee=ME, due_on=TODAY)
        moved = self.task(title="Moved", assignee=ME, due_on=TODAY)
        a = self.task(title="A", access_level="org")
        self.add(a)
        self.order([auto.id, moved.id, a.id])
        self.assertEqual(self.ids(self.get()), [auto.id, moved.id, a.id])
        auto.assignee_email, auto.assignee_emails = OTHER["email"], [OTHER["email"]]
        moved.due_on = TOMORROW
        self.db.commit()
        got = self.get()
        self.assertEqual(self.ids(got), [a.id])
        # ...and comes back in its place if it is due today and mine again.
        moved.due_on = TODAY
        self.db.commit()
        self.assertEqual(self.ids(self.get()), [moved.id, a.id])

    def test_new_picks_go_on_top_of_a_saved_order(self):
        auto = self.task(title="Auto", assignee=ME, due_on=TODAY)
        a = self.task(title="A", access_level="org")
        self.add(a)
        self.order([auto.id, a.id])
        b = self.task(title="B", access_level="org")
        self.assertEqual(self.ids(self.add(b)), [b.id, auto.id, a.id])

    def test_undo_puts_a_due_today_task_back_as_one_not_as_a_pick(self):
        auto = self.task(title="Auto", assignee=ME, due_on=TODAY)
        a = self.task(title="A", access_level="org")
        self.add(a)
        self.order([auto.id, a.id])
        self.remove(auto)
        got = self.add(auto, pick=False)
        self.order([auto.id, a.id])
        got = self.get()
        self.assertEqual(self.ids(got), [auto.id, a.id])
        self.assertEqual(got["addedIds"], [a.id])
        self.assertEqual(got["dismissedIds"], [])

    def test_reorder_ignores_what_is_not_on_the_list(self):
        a = self.task(access_level="org")
        removed = self.task(access_level="org")
        secret = self.task(access_level="restricted", assignee=OTHER)
        self.add(a)
        self.add(removed)
        self.remove(removed)
        got = self.order([secret.id, removed.id, "made-up", a.id])
        self.assertEqual(self.ids(got), [a.id])
        self.assertEqual(got["addedIds"], [a.id])
        self.assertEqual(got["orderIds"], [a.id])

    def test_two_tabs_never_lose_each_others_change(self):
        a = self.task(title="A", access_level="org")
        b = self.task(title="B", access_level="org")
        c = self.task(title="C", access_level="org")
        self.add(c)
        other_tab = database.SessionLocal()
        try:
            # The second tab's session already holds the row as it was.
            stale = M._row(other_tab, ME["email"])
            self.assertEqual(stale.my_day["added"], [c.id])
            self.add(a)                                   # the first tab adds A
            self.add(b, db=other_tab)                     # the second adds B on top of A
            got = self.get()
            self.assertEqual(self.ids(got), [b.id, a.id, c.id])
            # A reorder from a tab that never saw A keeps A.
            self.order([c.id, b.id], db=other_tab)
            self.assertEqual(self.ids(self.get()), [c.id, b.id, a.id])
        finally:
            other_tab.close()

    def test_lives_on_its_own_column_beside_the_table_prefs(self):
        from routers import task_prefs as P
        P.set_table_prefs("mytasks", P.TablePrefIn(order=["title"]), user=ME, db=self.db)
        a = self.task(access_level="org")
        self.add(a)
        P.reset_all_prefs(user=ME, db=self.db)              # "Restore all" leaves today alone
        P.set_table_prefs("mytasks", P.TablePrefIn(order=["dueOn"]), user=ME, db=self.db)
        self.assertEqual(self.ids(self.get()), [a.id])
        self.assertEqual(P.get_prefs(user=ME, db=self.db)["prefs"], {"mytasks": {"order": ["dueOn"]}})

    def test_a_first_write_that_loses_the_insert_race_takes_the_winners_row(self):
        a = self.task(title="A", access_level="org")
        b = self.task(title="B", access_level="org")
        self.store([a.id])                   # the other tab's first write stood...
        real = M._row
        calls = {"n": 0}

        def late(db, email, lock=False):     # ...after this request looked and saw no row
            calls["n"] += 1
            return None if calls["n"] == 1 else real(db, email, lock)
        with mock.patch.object(M, "_row", late):
            got = self.add(b)
        self.assertEqual(self.ids(got), [b.id, a.id])
        self.assertEqual(self.db.query(models.TaskTablePref).filter(
            models.TaskTablePref.owner_email == ME["email"]).count(), 1)

    def test_a_request_costs_the_same_queries_however_long_the_list(self):
        from sqlalchemy import event

        def count(call):
            n = {"q": 0}

            def on(*_a, **_k):
                n["q"] += 1
            event.listen(database.engine, "before_cursor_execute", on)
            try:
                call()
            finally:
                event.remove(database.engine, "before_cursor_execute", on)
            return n["q"]

        p = models.TaskProject(id=gen_id(), name="Mine", access_level="restricted", member_emails=[ME["email"]],
                               created_at=now_iso(), company_id=COA)
        self.db.add(p)
        self.db.commit()

        def fill(k):
            for i in range(k):
                # Seen only through my project: the one check that needs the project scan.
                self.add(self.task(title=f"In project {i}", access_level="restricted", project_id=p.id, assignee=OTHER))
                self.task(title=f"Due {i}", assignee=ME, due_on=TODAY, project_id="p-x", access_level="restricted")
                self.add(self.task(title=f"Org {i}", access_level="org"))
                self.task(title=f"Late {i}", assignee=ME, due_on=YESTERDAY)
        self.arm_walls()
        fill(2)
        small = (count(lambda: self.get()), count(lambda: self.order([])), count(lambda: self.add(self.task(access_level="org"))))
        fill(20)
        self.assertEqual((count(lambda: self.get()), count(lambda: self.order([])),
                          count(lambda: self.add(self.task(access_level="org")))), small)


class GuestAndRouteTests(Base):
    def test_an_external_guest_cannot_add_an_org_task(self):
        guest = {"email": "guest@partner.com", "level": 1, "external": True}
        org = self.task(title="Org-wide", access_level="org", assignee=OTHER)
        self.assertEqual(self.code(lambda: self.add(org, user=guest)), 404)
        theirs = self.task(title="Theirs", access_level="org", assignee=guest)
        self.assertEqual(self.ids(self.add(theirs, user=guest)), [theirs.id])

    def test_the_routes_resolve_ahead_of_the_per_task_routes(self):
        import auth
        import main
        from fastapi.testclient import TestClient
        self.db.query(models.NexusRole).filter(models.NexusRole.email == ME["email"]).delete()
        self.db.add(models.NexusRole(email=ME["email"], role="administrator"))
        self.db.commit()
        auth.invalidate_role_cache()
        t = self.task(title="Org", access_level="org")
        with mock.patch.object(auth, "SKIP_AUTH", True), mock.patch.dict(os.environ, {"NEXUS_DEV_EMAIL": ME["email"]}):
            client = TestClient(main.app)
            r = client.get(f"/tasks/my-day?day={TODAY}")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertIn("suggestions", r.json())
            r = client.post("/tasks/my-day/add", json={"day": TODAY, "task_id": t.id})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual([x["id"] for x in r.json()["tasks"]], [t.id])
            r = client.put("/tasks/my-day/order", json={"day": TODAY, "task_ids": [t.id]})
            self.assertEqual(r.status_code, 200, r.text)
            r = client.post("/tasks/my-day/remove", json={"day": TODAY, "task_id": t.id})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["tasks"], [])
            # A bad day is My Day's own 400, not a task route's 404 / 405.
            self.assertEqual(client.get("/tasks/my-day?day=nope").status_code, 400)
        auth.invalidate_role_cache()


if __name__ == "__main__":
    unittest.main()
