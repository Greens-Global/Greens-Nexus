"""Bulk date changes and the Calendar drag (Neil, Oct 22 2026).

The batch bar's Dates action sends `dates` to POST /tasks/bulk instead of a
patch: Shift By N Days (+/-, optionally counting weekdays only), Set Due Date,
Set Start Date, Clear Due Date. Each task moves from ITS OWN stored date under
the row lock; start and due move together; a task with no due date is skipped
by a shift; the usual walls, roles and due-date approval rules apply; the
answer adds {changed, skipped, sentForApproval} around the usual task list.

The Calendar drag is a single PATCH of start + due: when the due date has to
wait for approval, the start waits with it.

Throwaway SQLite, no network.  python -m pytest test_task_bulk_dates.py
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
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

BOSS = {"email": "boss@greensglobal.com", "level": 1}
SAGAR = {"email": "sagar@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
MANAGER = {"email": "neil@greensglobal.com", "level": 3}
COA, COB = "co-a", "co-b"
AMGR = {"email": "amgr@greensglobal.com", "level": 3}

_CLEAR = (models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification,
          models.NexusNotification, models.NexusEmployee, models.NexusSetting, models.TaskChecklistItem)


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
        for m in _CLEAR:
            self.db.query(m).execution_options(include_deleted=True).delete()
        for email, mgr, co in ((SAGAR["email"], MANAGER["email"], COA), (BOSS["email"], "", COA),
                               (VIEWER["email"], "", COA), (MANAGER["email"], "", COA),
                               (AMGR["email"], "", COA), ("bemp@greensglobal.com", "", COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0],
                                             manager_email=mgr, status="active", company=co))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def task(self, **kw):
        kw.setdefault("title", "T")
        kw.setdefault("status", "not_started")
        kw.setdefault("created_by", SAGAR["email"])
        kw.setdefault("assignee_email", SAGAR["email"])
        kw.setdefault("assignee_emails", [SAGAR["email"]])
        kw.setdefault("due_agreement", "accepted" if kw.get("due_on") else "")
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def dates(self, ids, user=SAGAR, **dates):
        return T.bulk_update(T.BulkUpdate(ids=ids, dates=T.BulkDates(**dates)), user=user, db=self.db)

    def fresh(self, t):
        self.db.expire_all()
        return self.db.get(models.Task, t.id)

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code


class ShiftTests(Base):
    def test_shift_later_moves_start_and_due_across_a_month(self):
        t = self.task(start_on="2026-10-28", due_on="2026-10-30")
        out = self.dates([t.id], op="shift", days=3)
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on), ("2026-10-31", "2026-11-02"))
        self.assertEqual((out["changed"], out["skipped"], out["sentForApproval"]), (1, 0, 0))
        self.assertEqual(out["tasks"][0]["dueOn"], "2026-11-02")
        # Logged like any bulk move of the date.
        self.assertEqual(t.due_history[-1]["source"], "bulk")
        self.assertEqual(t.due_history[-1]["from"], "2026-10-30")

    def test_shift_earlier_across_a_year(self):
        t = self.task(start_on="2026-12-30", due_on="2027-01-02")
        self.dates([t.id], op="shift", days=-3)
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on), ("2026-12-27", "2026-12-30"))

    def test_skip_weekends_counts_weekdays_and_lands_on_one(self):
        fri = self.task(due_on="2026-10-30")                          # Fri -> Mon 11/02
        sat = self.task(due_on="2026-10-31")                          # Sat -> Mon 11/02
        wed = self.task(start_on="2026-10-26", due_on="2026-10-28")   # Mon/Wed
        self.dates([fri.id, sat.id, wed.id], op="shift", days=1, skip_weekends=True)
        self.assertEqual(self.fresh(fri).due_on, "2026-11-02")
        self.assertEqual(self.fresh(sat).due_on, "2026-11-02")
        self.dates([wed.id], op="shift", days=4, skip_weekends=True)
        w = self.fresh(wed)
        # Tue 10/27 / Thu 10/29 after the +1, then 4 weekdays over the weekend.
        self.assertEqual((w.start_on, w.due_on), ("2026-11-02", "2026-11-04"))

    def test_skip_weekends_backwards(self):
        mon = self.task(due_on="2026-11-02")
        self.dates([mon.id], op="shift", days=-1, skip_weekends=True)
        self.assertEqual(self.fresh(mon).due_on, "2026-10-30")       # Monday - 1 weekday = Friday
        thu = self.task(due_on="2027-01-07")
        self.dates([thu.id], op="shift", days=-5, skip_weekends=True)
        self.assertEqual(self.fresh(thu).due_on, "2026-12-31")

    def test_tasks_without_a_due_date_are_skipped(self):
        dated = self.task(due_on="2026-10-30")
        start_only = self.task(start_on="2026-10-20")
        undated = self.task()
        out = self.dates([dated.id, start_only.id, undated.id], op="shift", days=2)
        self.assertEqual((out["changed"], out["skipped"]), (1, 2))
        self.assertEqual(self.fresh(start_only).start_on, "2026-10-20")
        self.assertEqual(self.fresh(undated).due_on or "", "")
        self.assertEqual(len(out["tasks"]), 3)

    def test_each_task_moves_from_its_own_date(self):
        a = self.task(due_on="2026-10-01")
        b = self.task(due_on="2026-12-15")
        self.dates([a.id, b.id], op="shift", days=7)
        self.assertEqual((self.fresh(a).due_on, self.fresh(b).due_on), ("2026-10-08", "2026-12-22"))

    def test_recurring_occurrence_moves_alone_and_keeps_its_rule(self):
        rule = {"freq": "weekly", "daysOfWeek": [1], "seriesId": "s-1"}
        occ = self.task(due_on="2026-10-26", recurrence=dict(rule))
        later = self.task(due_on="2026-11-02", recurrence=dict(rule))
        self.dates([occ.id], op="shift", days=2)
        occ, later = self.fresh(occ), self.fresh(later)
        self.assertEqual(occ.due_on, "2026-10-28")
        self.assertEqual(occ.recurrence, rule)
        self.assertEqual(later.due_on, "2026-11-02")
        self.assertEqual(self.db.query(models.Task).count(), 2)   # nothing spawned

    def test_bad_requests(self):
        t = self.task(due_on="2026-10-30")
        self.assertEqual(self.code(lambda: self.dates([t.id], op="shift", days=0)), 422)
        self.assertEqual(self.code(lambda: self.dates([t.id], op="shift", days=99999)), 422)
        self.assertEqual(self.code(lambda: self.dates([t.id], op="set_due", on="10/30/2026")), 422)
        self.assertEqual(self.code(lambda: self.dates([t.id], op="set_due")), 422)
        self.assertEqual(self.code(lambda: self.dates([t.id], op="nudge")), 422)
        self.assertEqual(self.code(lambda: T.bulk_update(
            T.BulkUpdate(ids=[t.id], patch={"priority": "high"}, dates=T.BulkDates(op="clear_due")),
            user=SAGAR, db=self.db)), 422)
        self.assertEqual(self.fresh(t).due_on, "2026-10-30")


class SetAndClearTests(Base):
    def test_set_due_set_start_and_clear(self):
        a = self.task(due_on="2026-10-30")
        b = self.task()
        out = self.dates([a.id, b.id], op="set_due", on="2026-11-05")
        self.assertEqual(out["changed"], 2)
        self.assertEqual((self.fresh(a).due_on, self.fresh(b).due_on), ("2026-11-05", "2026-11-05"))
        out = self.dates([a.id, b.id], op="set_start", on="2026-11-01")
        self.assertEqual(out["changed"], 2)
        self.assertEqual(self.fresh(a).start_on, "2026-11-01")
        out = self.dates([a.id, b.id], op="clear_due")
        self.assertEqual(out["changed"], 2)
        self.assertEqual((self.fresh(a).due_on, self.fresh(b).due_on), ("", ""))
        # Clearing again changes nothing.
        self.assertEqual(self.dates([a.id], op="clear_due")["changed"], 0)

    def test_the_plain_bulk_answer_is_still_a_list(self):
        a = self.task(due_on="2026-10-30")
        out = T.bulk_update(T.BulkUpdate(ids=[a.id], patch={"priority": "high"}), user=SAGAR, db=self.db)
        self.assertIsInstance(out, list)


class ApprovalTests(Base):
    def test_a_third_extension_is_sent_for_approval_and_the_start_waits(self):
        t = self.task(start_on="2026-10-26", due_on="2026-10-30", due_extension_count=2)
        out = self.dates([t.id], op="shift", days=3)
        self.assertEqual((out["changed"], out["sentForApproval"]), (0, 1))
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on), ("2026-10-26", "2026-10-30"))
        self.assertEqual(t.due_agreement, "extension_requested")
        self.assertEqual(t.due_proposal["dueOn"], "2026-11-02")
        bells = self.db.query(models.TaskNotification).filter(
            models.TaskNotification.kind == "task_due_extension_requested").all()
        self.assertEqual([b.for_email for b in bells], [MANAGER["email"]])

    def test_a_manager_moves_it_without_asking(self):
        t = self.task(due_on="2026-10-30", due_extension_count=2)
        out = self.dates([t.id], user=MANAGER, op="shift", days=3)
        self.assertEqual((out["changed"], out["sentForApproval"]), (1, 0))
        self.assertEqual(self.fresh(t).due_on, "2026-11-02")

    def test_moving_earlier_never_needs_approval(self):
        t = self.task(due_on="2026-10-30", due_extension_count=5)
        out = self.dates([t.id], op="shift", days=-2)
        self.assertEqual(out["sentForApproval"], 0)
        self.assertEqual(self.fresh(t).due_on, "2026-10-28")

    def test_one_bell_per_requester_for_the_batch(self):
        a = self.task(due_on="2026-10-30", created_by=BOSS["email"])
        b = self.task(due_on="2026-10-31", created_by=BOSS["email"])
        self.dates([a.id, b.id], op="shift", days=-1)
        bells = self.db.query(models.TaskNotification).filter(
            models.TaskNotification.kind == "task_due_changed").all()
        self.assertEqual([(n.for_email, n.title) for n in bells], [(BOSS["email"], "2 Due Dates Changed")])

    def test_single_edit_holds_the_start_with_the_due_date(self):
        t = self.task(start_on="2026-10-26", due_on="2026-10-30", due_extension_count=2)
        T.update_task(t.id, T.TaskUpdate(start_on="2026-10-29", due_on="2026-11-02"), BackgroundTasks(),
                      user=SAGAR, db=self.db)
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on), ("2026-10-26", "2026-10-30"))
        self.assertEqual(t.due_proposal["dueOn"], "2026-11-02")
        # A move that needs no approval still takes both.
        T.update_task(t.id, T.TaskUpdate(start_on="2026-10-22", due_on="2026-10-27"), BackgroundTasks(),
                      user=SAGAR, db=self.db)
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on), ("2026-10-22", "2026-10-27"))


class AccessTests(Base):
    def test_a_viewer_is_refused_and_nothing_moves(self):
        p = models.TaskProject(id=gen_id(), name="Locked", access_level="restricted", created_at=now_iso(),
                               member_roles={VIEWER["email"]: "viewer"}, member_emails=[VIEWER["email"]])
        self.db.add(p)
        self.db.commit()
        t = self.task(due_on="2026-10-30", project_id=p.id, created_by=BOSS["email"],
                      assignee_email="", assignee_emails=[])
        self.assertEqual(self.code(lambda: self.dates([t.id], user=VIEWER, op="shift", days=1)), 403)
        self.assertEqual(self.fresh(t).due_on, "2026-10-30")

    def test_walls_refuse_another_companys_task(self):
        a = self.task(due_on="2026-10-30", company_id=COA)
        b = self.task(due_on="2026-10-30", company_id=COB, created_by="bemp@greensglobal.com",
                      assignee_email="bemp@greensglobal.com", assignee_emails=["bemp@greensglobal.com"])
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()
        self.assertEqual(self.code(lambda: self.dates([a.id, b.id], user=AMGR, op="shift", days=1)), 404)
        self.assertEqual((self.fresh(a).due_on, self.fresh(b).due_on), ("2026-10-30", "2026-10-30"))
        out = self.dates([a.id], user=AMGR, op="shift", days=1)
        self.assertEqual(out["changed"], 1)


if __name__ == "__main__":
    unittest.main()
