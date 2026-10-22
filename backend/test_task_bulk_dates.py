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
from unittest import mock

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

_CLEAR = (models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification, models.TaskEmailQueue,
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


class HeldStartTests(Base):
    """Review fix 1: the start held with an extension request moves on approval."""
    def _held_single(self):
        t = self.task(start_on="2026-10-26", due_on="2026-10-30", due_extension_count=2)
        T.update_task(t.id, T.TaskUpdate(start_on="2026-10-29", due_on="2026-11-02"), BackgroundTasks(),
                      user=SAGAR, db=self.db)
        return self.fresh(t)

    def test_approval_moves_the_held_start_too(self):
        t = self._held_single()
        self.assertEqual(t.due_proposal["startOn"], "2026-10-29")
        T.respond_due(T.DueAnswer(accept=True), t.id, user=MANAGER, db=self.db)
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on), ("2026-10-29", "2026-11-02"))

    def test_decline_and_withdraw_drop_it(self):
        t = self._held_single()
        T.respond_due(T.DueAnswer(accept=False), t.id, user=MANAGER, db=self.db)
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on, t.due_proposal), ("2026-10-26", "2026-10-30", None))
        u = self._held_single()
        T.withdraw_due(u.id, user=SAGAR, db=self.db)
        u = self.fresh(u)
        self.assertEqual((u.start_on, u.due_proposal), ("2026-10-26", None))

    def test_bulk_held_shift_carries_the_start_through_approval(self):
        t = self.task(start_on="2026-10-26", due_on="2026-10-30", due_extension_count=2)
        self.dates([t.id], op="shift", days=3)
        self.assertEqual(self.fresh(t).due_proposal["startOn"], "2026-10-29")
        T.respond_due(T.DueAnswer(accept=True), t.id, user=MANAGER, db=self.db)
        t = self.fresh(t)
        self.assertEqual((t.start_on, t.due_on), ("2026-10-29", "2026-11-02"))


class UndoTests(Base):
    """Review fix 2: Undo of a drag takes the move out instead of making another."""
    def move(self, t, user=SAGAR, **fields):
        T.update_task(t.id, T.TaskUpdate(**fields), BackgroundTasks(), user=user, db=self.db)
        return self.fresh(t)

    def undo(self, t, user=SAGAR, at=None):
        t = self.fresh(t)
        return T.undo_due(t.id, T.DueUndo(at=at or t.due_history[-1]["at"]), user=user, db=self.db)

    def bells(self):
        self.db.expire_all()
        return self.db.query(models.TaskNotification).filter(
            models.TaskNotification.kind.in_(["task_due_changed", "task_due_extended"])).count()

    def test_undo_of_an_earlier_move_counts_nothing_and_withdraws_the_bell(self):
        t = self.task(start_on="2026-10-26", due_on="2026-10-30", created_by=BOSS["email"])
        hist_before = len(t.due_history or [])
        t = self.move(t, start_on="2026-10-22", due_on="2026-10-26")
        self.assertEqual(self.bells(), 1)                      # the requester heard about the move
        at = t.due_history[-1]["at"]
        # The move's own email, and one for a title change made meanwhile.
        own = models.TaskEmailQueue(id=gen_id(), recipient=BOSS["email"], task_id=t.id, event_type="modified",
                                    actor_email=SAGAR["email"], status="pending", created_at=now_iso(),
                                    payload={"update_kind": "Due date changed", "due_entry_at": at})
        title = models.TaskEmailQueue(id=gen_id(), recipient=BOSS["email"], task_id=t.id, event_type="modified",
                                      actor_email=SAGAR["email"], status="pending", created_at=now_iso(),
                                      payload={"update_kind": "Title changed"})
        self.db.add_all([own, title])
        self.db.commit()
        own_id, title_id = own.id, title.id
        out = self.undo(t)
        t = self.fresh(t)
        self.assertEqual((out["dueOn"], t.start_on, t.due_on), ("2026-10-30", "2026-10-26", "2026-10-30"))
        self.assertEqual(t.due_extension_count or 0, 0)
        self.assertEqual(len(t.due_history or []), hist_before)
        self.assertEqual(t.due_agreement, "accepted")
        self.assertEqual(self.bells(), 0)
        q = self.db.get(models.TaskEmailQueue, own_id)
        self.assertEqual((q.status, q.drop_reason), ("dropped", "undone"))
        self.assertEqual(self.db.get(models.TaskEmailQueue, title_id).status, "pending")

    def test_undo_of_an_extension_takes_the_count_back(self):
        t = self.task(due_on="2026-10-30")
        t = self.move(t, due_on="2026-11-02")
        self.assertEqual(t.due_extension_count, 1)
        self.undo(t)
        t = self.fresh(t)
        self.assertEqual((t.due_on, t.due_extension_count), ("2026-10-30", 0))

    def test_undo_restores_a_pending_negotiation(self):
        t = self.task(due_on="2026-10-30", created_by=BOSS["email"], due_agreement="pending")
        t = self.move(t, user=BOSS, due_on="2026-10-28")
        self.undo(t, user=BOSS)
        self.assertEqual(self.fresh(t).due_agreement, "pending")

    def test_undo_is_refused_when_it_is_not_the_callers_latest_move(self):
        t = self.task(due_on="2026-10-30")
        t = self.move(t, due_on="2026-10-28")
        at = t.due_history[-1]["at"]
        # Somebody else's undo, or a stale entry, is refused.
        self.assertEqual(self.code(lambda: self.undo(t, user=MANAGER)), 409)
        self.assertEqual(self.code(lambda: self.undo(t, at="2026-01-01T00:00:00+00:00")), 409)
        # The date moved again since: the first move can no longer be undone.
        t = self.move(t, due_on="2026-10-27")
        self.assertEqual(self.code(lambda: self.undo(t, at=at)), 409)
        # Too late.
        hist = list(t.due_history)
        hist[-1] = {**hist[-1], "at": "2026-01-01T00:00:00+00:00"}
        t.due_history = hist
        self.db.commit()
        self.assertEqual(self.code(lambda: self.undo(t)), 409)

    def test_the_move_records_which_entry_its_email_reports(self):
        t = self.task(due_on="2026-10-30", created_by=BOSS["email"])
        bg = BackgroundTasks()
        T.update_task(t.id, T.TaskUpdate(due_on="2026-10-28"), bg, user=SAGAR, db=self.db)
        t = self.fresh(t)
        kw = [x.kwargs for x in bg.tasks if x.args[1:2] == ("modified",)][0]
        self.assertEqual(kw["due_entry_at"], t.due_history[-1]["at"])

    def test_undo_reads_under_the_row_lock(self):
        t = self.task(due_on="2026-10-30")
        t = self.move(t, due_on="2026-10-28")
        with mock.patch.object(T, "_lock_task_rows", wraps=T._lock_task_rows) as lock:
            self.undo(t)
        lock.assert_called_once_with(self.db, [t.id])

    def test_a_timeline_move_is_not_undone_here(self):
        t = self.task(due_on="2026-10-30")
        T.reschedule_task(t.id, T.RescheduleBody(due_on="2026-10-28"), BackgroundTasks(), user=SAGAR, db=self.db)
        t = self.fresh(t)
        self.assertEqual(t.due_history[-1]["undo"]["via"], "reschedule")
        self.assertEqual(self.code(lambda: self.undo(t)), 409)
        self.assertEqual(self.fresh(t).due_on, "2026-10-28")

    def test_a_held_move_has_nothing_to_undo(self):
        t = self.task(due_on="2026-10-30", due_extension_count=2)
        t = self.move(t, due_on="2026-11-02")
        self.assertEqual(t.due_agreement, "extension_requested")
        self.assertEqual(self.code(lambda: self.undo(t, at=t.due_proposal["at"])), 409)


class SeriesOrderTests(Base):
    """Review fix 3: an open occurrence may not land on or before the one before it."""
    def series(self):
        rule = {"freq": "weekly", "daysOfWeek": [1], "seriesId": "s-9"}
        nxt_id = gen_id()
        prev = self.task(due_on="2026-10-12", completed=True, status="completed",
                         recurrence={**rule, "nextOccurrenceId": nxt_id})
        cur = models.Task(id=nxt_id, code="T-cur", title="T", status="recurring", created_by=SAGAR["email"],
                          assignee_email=SAGAR["email"], assignee_emails=[SAGAR["email"]], due_on="2026-10-19",
                          due_agreement="accepted", recurrence=dict(rule),
                          created_at=now_iso(), modified_at=now_iso())
        self.db.add(cur)
        self.db.commit()
        return prev, cur

    def test_single_edit_is_refused_with_the_previous_date(self):
        _, cur = self.series()
        with self.assertRaises(HTTPException) as e:
            T.update_task(cur.id, T.TaskUpdate(due_on="2026-10-12"), BackgroundTasks(), user=SAGAR, db=self.db)
        self.db.rollback()
        self.assertEqual(e.exception.status_code, 422)
        self.assertIn("(10/12/2026)", e.exception.detail)
        T.update_task(cur.id, T.TaskUpdate(due_on="2026-10-13"), BackgroundTasks(), user=SAGAR, db=self.db)
        self.assertEqual(self.fresh(cur).due_on, "2026-10-13")

    def test_bulk_leaves_it_and_says_why(self):
        _, cur = self.series()
        other = self.task(due_on="2026-10-20")
        out = self.dates([cur.id, other.id], op="shift", days=-7)
        self.assertEqual((out["changed"], out["blocked"]), (1, 1))
        self.assertEqual(out["blockedTasks"][0]["id"], cur.id)
        self.assertEqual(out["blockedTasks"][0]["code"], "series")
        self.assertEqual(self.fresh(cur).due_on, "2026-10-19")
        out = self.dates([cur.id], op="set_due", on="2026-10-10")
        self.assertEqual(out["blocked"], 1)

    def test_a_completed_occurrence_and_a_later_move_are_fine(self):
        prev, cur = self.series()
        T.update_task(prev.id, T.TaskUpdate(due_on="2026-10-11"), BackgroundTasks(), user=SAGAR, db=self.db)
        self.assertEqual(self.dates([cur.id], op="shift", days=2)["changed"], 1)

    def test_a_completed_occurrence_may_not_pass_the_live_one(self):
        prev, cur = self.series()
        for day in ("2026-10-19", "2026-10-25"):
            with self.assertRaises(HTTPException) as e:
                T.update_task(prev.id, T.TaskUpdate(due_on=day), BackgroundTasks(), user=SAGAR, db=self.db)
            self.db.rollback()
            self.assertEqual(e.exception.status_code, 422)
            self.assertIn("(10/19/2026)", e.exception.detail)
        out = self.dates([prev.id], op="shift", days=7)
        self.assertEqual(out["blocked"], 1)
        self.assertEqual(self.fresh(prev).due_on, "2026-10-12")

    def test_a_reopened_missed_copy_may_move(self):
        prev, cur = self.series()
        prev.completed, prev.status = False, "not_started"
        prev.recurrence = {**prev.recurrence, "closedAsMissed": "2026-10-19T00:00:00+00:00"}
        late = self.task(due_on="2026-10-05", recurrence={"freq": "weekly", "daysOfWeek": [1], "seriesId": "s-9",
                                                          "nextOccurrenceId": prev.id})
        self.db.commit()
        T.update_task(prev.id, T.TaskUpdate(due_on="2026-10-02"), BackgroundTasks(), user=SAGAR, db=self.db)
        self.assertEqual(self.fresh(prev).due_on, "2026-10-02")
        self.assertEqual(self.fresh(late).due_on, "2026-10-05")

    def test_shifting_the_whole_series_together_is_judged_on_the_new_dates(self):
        prev, cur = self.series()
        out = self.dates([prev.id, cur.id], op="shift", days=-7)
        self.assertEqual((out["changed"], out["blocked"]), (2, 0))
        self.assertEqual((self.fresh(prev).due_on, self.fresh(cur).due_on), ("2026-10-05", "2026-10-12"))
        out = self.dates([prev.id, cur.id], op="shift", days=10)
        self.assertEqual((out["changed"], out["blocked"]), (2, 0))

    def test_only_the_series_candidates_are_read(self):
        prev, cur = self.series()
        other = self.task(title="Something else", due_on="2026-10-20", recurrence={"freq": "daily"})
        other_id, prev_id, cur_id = other.id, prev.id, cur.id
        self.db.expunge_all()
        cur = self.db.get(models.Task, cur_id)
        members = T._series_members(self.db, cur)
        self.assertEqual({m.id for m in members}, {prev_id, cur_id})
        self.assertNotIn(other_id, {o.id for o in self.db.identity_map.values()})


class ReviewRoundThreeTests(Base):
    def test_bulk_held_due_with_a_reassignment_keeps_the_request(self):
        t = self.task(due_on="2026-10-30", due_extension_count=2)
        T.bulk_update(T.BulkUpdate(ids=[t.id], patch={"due_on": "2026-11-02",
                                                      "assignee_emails": [SAGAR["email"], BOSS["email"]]}),
                      user=SAGAR, db=self.db)
        t = self.fresh(t)
        self.assertEqual(t.due_agreement, "extension_requested")
        self.assertEqual(t.due_proposal["dueOn"], "2026-11-02")
        T.respond_due(T.DueAnswer(accept=True), t.id, user=MANAGER, db=self.db)
        self.assertEqual(self.fresh(t).due_on, "2026-11-02")

    def test_answered_dates_move_the_checklist_step(self):
        held = self.task(due_on="2026-10-30", due_extension_count=2)
        T.update_task(held.id, T.TaskUpdate(due_on="2026-11-02"), BackgroundTasks(), user=SAGAR, db=self.db)
        proposed = self.task(due_on="2026-10-30", created_by=BOSS["email"], due_agreement="proposed",
                             due_proposal={"dueOn": "2026-11-04", "by": SAGAR["email"]})
        countered = self.task(due_on="2026-10-30", created_by=BOSS["email"], due_agreement="proposed",
                              due_proposal={"dueOn": "2026-11-04", "by": SAGAR["email"]})
        with mock.patch("hr_checklists.task_due_changed") as hook:
            T.respond_due(T.DueAnswer(accept=True), held.id, user=MANAGER, db=self.db)      # approve
            self.assertEqual(hook.call_args[0][1].id, held.id)
            T.respond_due(T.DueAnswer(accept=True), proposed.id, user=BOSS, db=self.db)     # accept proposal
            self.assertEqual(hook.call_args[0][1].id, proposed.id)
            T.respond_due(T.DueAnswer(counter_on="2026-11-01"), countered.id, user=BOSS, db=self.db)   # counter
            self.assertEqual(hook.call_args[0][1].id, countered.id)
            self.assertEqual(hook.call_count, 3)
            T.respond_due(T.DueAnswer(accept=False), self._held_again(), user=MANAGER, db=self.db)   # decline
            self.assertEqual(hook.call_count, 3)
        self.assertEqual(self.fresh(countered).due_on, "2026-11-01")

    def _held_again(self):
        t = self.task(due_on="2026-10-30", due_extension_count=2)
        T.update_task(t.id, T.TaskUpdate(due_on="2026-11-02"), BackgroundTasks(), user=SAGAR, db=self.db)
        return t.id


class ReviewLowTests(Base):
    def test_checklist_sync_runs_only_for_a_date_that_really_moved(self):
        held = self.task(due_on="2026-10-30", due_extension_count=2)
        moved = self.task(due_on="2026-10-30")
        with mock.patch("hr_checklists.task_due_changed") as hook:
            T.update_task(held.id, T.TaskUpdate(due_on="2026-11-02"), BackgroundTasks(), user=SAGAR, db=self.db)
            self.assertEqual(hook.call_count, 0)
            self.dates([held.id], op="shift", days=3)
            self.assertEqual(hook.call_count, 0)
            T.update_task(moved.id, T.TaskUpdate(due_on="2026-10-28"), BackgroundTasks(), user=SAGAR, db=self.db)
            self.assertEqual(hook.call_count, 1)
            self.dates([moved.id], op="shift", days=-1)
            self.assertEqual(hook.call_count, 2)

    def test_an_unreadable_start_is_no_start_and_an_unreadable_due_is_reported(self):
        a = self.task(start_on="soon", due_on="2026-10-30")
        b = self.task(due_on="2026-13-45")
        out = self.dates([a.id, b.id], op="shift", days=1)
        self.assertEqual((out["changed"], out["skipped"], out["blocked"]), (1, 0, 1))
        a = self.fresh(a)
        self.assertEqual((a.start_on, a.due_on), ("soon", "2026-10-31"))
        self.assertEqual(out["blockedTasks"][0]["code"], "unreadable")

    def test_bulk_requester_bell_says_extended(self):
        t = self.task(due_on="2026-10-30", created_by=BOSS["email"])
        self.dates([t.id], op="shift", days=2)
        n = self.db.query(models.TaskNotification).filter(models.TaskNotification.kind == "task_due_changed").one()
        self.assertEqual(n.title, "Due Date Extended")

    def test_walls_and_roles_are_checked_before_any_lock(self):
        p = models.TaskProject(id=gen_id(), name="Locked", access_level="restricted", created_at=now_iso(),
                               member_roles={VIEWER["email"]: "viewer"}, member_emails=[VIEWER["email"]])
        self.db.add(p)
        self.db.commit()
        t = self.task(due_on="2026-10-30", project_id=p.id, created_by=BOSS["email"],
                      assignee_email="", assignee_emails=[])
        with mock.patch.object(T, "_lock_task_rows", wraps=T._lock_task_rows) as lock:
            self.assertEqual(self.code(lambda: self.dates([t.id], user=VIEWER, op="shift", days=1)), 403)
            lock.assert_not_called()
            self.dates([t.id], user=MANAGER, op="shift", days=1)
            lock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
