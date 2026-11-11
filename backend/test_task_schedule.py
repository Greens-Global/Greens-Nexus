"""Automatic scheduling, schedule baselines and project status (Neil, 11/08/2026).

- task_schedule.reschedule_successors: a manual task never moves; an auto
  successor lands on its predecessor's due + lag + 1 working day (lag 0, +2,
  -1), skipping weekends and the project company's holidays, keeping its
  length; an auto parent spans its subtasks; a chain of three moves; a loop
  in the links ends; 500 tasks at most; the due history line says
  source "auto" and who moved it; one notify event per moved task; the
  preview writes nothing; switching to auto places the task at once.
- Baselines: take / list / diff (added, removed, moved with slipDays) and
  a non-member of a restricted project is refused.
- Project status: set with the actor and the time by an editor, refused for
  a viewer, an unknown word is 422.

Throwaway SQLite, no network.  python -m pytest test_task_schedule.py
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException
from sqlalchemy import event

import cache
import database
import models
import task_schedule
from routers import task_projects as P
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

CO = "co-a"
OWNER = {"email": "owner@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
PEOPLE = (OWNER, EDITOR, VIEWER, OUTSIDER)
ASSIGNEE_LIKE = VIEWER["email"]
PID = "p-gate"

# 2026-11-09 is a Monday; 11/14 and 11/15 the weekend; 11/16 the holiday below.
MON, TUE, WED, THU, FRI = "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"
MON2, TUE2, WED2, THU2, FRI2 = "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"
HOLIDAY = MON2

_CLEAR = (models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification, models.NexusNotification,
          models.NexusEmployee, models.HrEntity, models.HrCompanyHoliday, models.TaskProjectBaseline,
          models.TaskEmailQueue, models.NexusSetting)


class Recorder:
    """A BackgroundTasks that only remembers what was queued."""

    def __init__(self):
        self.calls = []

    def add_task(self, fn, *a, **kw):
        self.calls.append((fn, a, kw))

    def notified(self, kind="modified"):
        return [(a, kw) for fn, a, kw in self.calls if fn is T.notify_task_event and a[1] == kind]


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
        self.db.add(models.HrEntity(id=CO, name="Greens Test Co", country="US"))
        for u in PEOPLE:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], company=CO,
                                             first_name=u["email"].split("@")[0], status="active"))
        self.db.add(models.TaskProject(
            id=PID, name="Escondido Gate Rebuild", owner_email=OWNER["email"], access_level="restricted",
            company_id=CO, member_emails=[EDITOR["email"], VIEWER["email"]],
            member_roles={EDITOR["email"]: "editor", VIEWER["email"]: "viewer"},
            created_at=now_iso(), modified_at=now_iso(), created_by=OWNER["email"]))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    # -- helpers ---------------------------------------------------------------
    def task(self, title, start="", due="", mode="manual", blocked_by=(), blocking=(), lags=None, **kw):
        kw.setdefault("owner_email", OWNER["email"])
        kw.setdefault("created_by", OWNER["email"])
        kw.setdefault("project_id", PID)
        kw.setdefault("status", "not_started")
        kw.setdefault("company_id", CO)
        t = models.Task(id=kw.pop("id", gen_id()), code=f"T-{gen_id()[:6]}", title=title,
                        priority="medium", start_on=start, due_on=due, schedule_mode=mode,
                        blocked_by_ids=list(blocked_by), blocking_ids=list(blocking), dependency_lags=lags or {},
                        created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def link(self, pred, succ):
        pred.blocking_ids = list(pred.blocking_ids or []) + [succ.id]
        succ.blocked_by_ids = list(succ.blocked_by_ids or []) + [pred.id]
        self.db.commit()

    def patch(self, t, user=OWNER, bg=None, **fields):
        return T.update_task(t.id, T.TaskUpdate(**fields), bg or Recorder(), user=user, db=self.db)

    def dates(self, t):
        self.db.refresh(t)
        return (t.start_on or "", (t.due_on or "")[:10])

    def holiday(self, day=HOLIDAY):
        self.db.add(models.HrCompanyHoliday(id=gen_id(), company_id=CO, date=day, name="Founders Day"))
        self.db.commit()

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def arm_walls(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def history(self, t):
        self.db.refresh(t)
        return [h["source"] for h in (t.due_history or [])]


class CalendarTests(unittest.TestCase):
    def test_working_day_arithmetic(self):
        cal = task_schedule.Calendar({HOLIDAY})
        fri = date.fromisoformat(FRI)
        self.assertEqual(cal.add_working(fri, 1).isoformat(), TUE2)      # over the weekend and the holiday
        self.assertEqual(cal.add_working(fri, 0).isoformat(), FRI)
        self.assertEqual(cal.add_working(fri, -1).isoformat(), THU)
        self.assertEqual(cal.add_working(date.fromisoformat("2026-11-14"), 0).isoformat(), TUE2)   # a Saturday
        self.assertEqual(cal.span(date.fromisoformat(THU), date.fromisoformat(TUE2)), 3)   # Thu, Fri, Tue
        self.assertEqual(cal.between(date.fromisoformat(FRI), date.fromisoformat(WED2)), 2)
        self.assertEqual(cal.between(date.fromisoformat(WED2), date.fromisoformat(FRI)), -2)
        self.assertEqual(cal.between(fri, fri), 0)


class EngineTests(Base):
    def test_manual_successor_never_moves(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", MON2, WED2, blocked_by=[a.id])
        self.link(a, b)
        out = self.patch(a, due_on=THU)
        self.assertNotIn("moved", out)
        self.assertEqual(self.dates(b), (MON2, WED2))

    def test_auto_successor_follows_with_lag_zero_keeping_its_length(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", MON2, WED2, mode="auto", blocked_by=[a.id])   # 3 working days
        self.link(a, b)
        out = self.patch(a, due_on=THU)
        self.assertEqual(self.dates(b), (FRI, TUE2))   # Fri, Mon, Tue
        self.assertEqual([m["id"] for m in out["moved"]], [b.id])
        self.assertEqual(out["moved"][0]["from"], {"start": MON2, "due": WED2})
        self.assertEqual(out["moved"][0]["to"], {"start": FRI, "due": TUE2})
        self.assertEqual(out["moved"][0]["task"]["startOn"], FRI)

    def test_positive_and_negative_lags(self):
        a = self.task("Posts", MON, THU)
        b = self.task("Gate Install", MON2, WED2, mode="auto", blocked_by=[a.id], lags={a.id: 2})
        self.link(a, b)
        self.patch(a, due_on=THU)   # no date change: the lag is applied through the engine on any edit
        self.patch(b, dependency_lags={a.id: 2})
        self.assertEqual(self.dates(b), (TUE2, THU2))     # Thu + 3 working days = Tue
        self.patch(b, dependency_lags={a.id: -1})
        self.assertEqual(self.dates(b), (THU, MON2))      # Thu + 0 = Thu, three working days
        self.db.refresh(b)
        self.assertEqual(b.dependency_lags, {a.id: -1})

    def test_weekend_is_skipped(self):
        a = self.task("Demo", MON, WED)
        b = self.task("Footings", THU, THU, mode="auto", blocked_by=[a.id])
        self.link(a, b)
        self.patch(a, due_on=FRI)
        self.assertEqual(self.dates(b), (MON2, MON2))

    def test_company_holiday_is_skipped(self):
        self.holiday()
        a = self.task("Demo", MON, WED)
        b = self.task("Footings", THU, THU, mode="auto", blocked_by=[a.id])
        self.link(a, b)
        self.patch(a, due_on=FRI)
        self.assertEqual(self.dates(b), (TUE2, TUE2))

    def test_task_with_no_project_counts_weekends_only(self):
        self.holiday()
        a = self.task("Demo", MON, WED, project_id="")
        b = self.task("Footings", THU, THU, mode="auto", blocked_by=[a.id], project_id="")
        self.link(a, b)
        self.patch(a, due_on=FRI)
        self.assertEqual(self.dates(b), (MON2, MON2))

    def test_auto_parent_spans_its_subtasks(self):
        p = self.task("Gate", TUE, FRI, mode="auto")
        c1 = self.task("Hinges", TUE, THU, parent_task_id=p.id, project_id="")
        c2 = self.task("Latch", WED, FRI, parent_task_id=p.id, project_id="")
        p.subtask_ids = [c1.id, c2.id]
        self.db.commit()
        out = self.patch(c2, due_on=FRI2)
        self.assertEqual(self.dates(p), (TUE, FRI2))
        self.assertEqual(out["moved"][0]["cause"], "its subtasks")

    def test_chain_of_three(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", WED, THU, mode="auto", blocked_by=[a.id])
        c = self.task("Posts", FRI, MON2, mode="auto", blocked_by=[b.id])
        self.link(a, b)
        self.link(b, c)
        out = self.patch(a, due_on=WED)
        self.assertEqual(self.dates(b), (THU, FRI))
        self.assertEqual(self.dates(c), (MON2, TUE2))
        self.assertEqual([m["id"] for m in out["moved"]], [b.id, c.id])

    def test_a_loop_in_the_links_ends(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("B", WED, WED, mode="auto", blocked_by=[a.id])
        c = self.task("C", THU, THU, mode="auto", blocked_by=[b.id])
        self.link(a, b)
        self.link(b, c)
        # Legacy data: C also points back at B.
        c.blocking_ids = [b.id]
        self.db.commit()
        out = self.patch(a, due_on=WED)
        ids = [m["id"] for m in out["moved"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(self.dates(b), (THU, THU))

    def test_five_hundred_tasks_at_most_and_a_bounded_number_of_queries(self):
        a = self.task("Root", MON, MON)
        prev, chain = a, []
        for i in range(520):
            t = models.Task(id=f"c{i:03d}", code=f"C-{i}", title=f"Step {i}", status="not_started", priority="medium",
                            start_on=MON, due_on=MON, schedule_mode="auto", company_id=CO, project_id=PID,
                            owner_email=OWNER["email"], created_by=OWNER["email"],
                            blocked_by_ids=[prev.id], blocking_ids=[], created_at=now_iso(), modified_at=now_iso())
            prev.blocking_ids = [t.id]
            self.db.add(t)
            chain.append(t)
            prev = t
        self.db.commit()
        # The project's rows are read once up front, not once per task
        # (item 8 of the review): a handful of READS for 500 moves. The
        # writes are the moves' own - each one's activity rows go to the
        # Workflows outbox as they are logged (one INSERT each, not counted).
        reads = []

        def count(_conn, _cursor, statement, *_a, **_k):
            if statement.lstrip().upper().startswith("SELECT"):
                reads.append(statement)
        event.listen(database.engine, "before_cursor_execute", count)
        try:
            moves = task_schedule.reschedule_successors(self.db, a, actor=OWNER["email"])
        finally:
            event.remove(database.engine, "before_cursor_execute", count)
        self.assertLess(len(reads), 40, reads[:5])
        self.db.commit()
        self.assertEqual(len(moves), task_schedule.MAX_AUTO_TASKS - 1)   # the root is one of the 500 visited
        self.assertEqual(self.dates(chain[0]), (TUE, TUE))
        self.assertEqual(self.dates(chain[1]), (WED, WED))
        self.assertEqual(self.dates(chain[519]), (MON, MON))              # beyond the cap: untouched

    def test_history_says_auto_and_who_moved_it(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", MON2, WED2, mode="auto", blocked_by=[a.id], lags={a.id: 2})
        self.link(a, b)
        self.patch(a, due_on=THU)   # Thu + 3 working days: Tue 11/17 to Thu 11/19
        self.db.refresh(b)
        self.assertEqual((b.start_on, b.due_on), (TUE2, THU2))
        last = b.due_history[-1]
        self.assertEqual(last["source"], "auto")
        self.assertEqual(last["by"], OWNER["email"])
        self.assertEqual(last["note"], "Moved by Demo (+2 working days)")
        self.assertEqual(last["cause"], a.id)
        self.assertEqual((last["from"], last["to"]), (WED2, b.due_on))
        starts = [x for x in self.db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == b.id).all()
                  if isinstance(x.field_change, dict) and x.field_change.get("field") == "startOn"]
        self.assertEqual(len(starts), 1)

    def test_one_notify_event_per_moved_task(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", WED, THU, mode="auto", blocked_by=[a.id])
        c = self.task("Posts", FRI, MON2, mode="auto", blocked_by=[b.id])
        self.link(a, b)
        self.link(b, c)
        rec = Recorder()
        self.patch(a, bg=rec, due_on=WED)
        auto = [(args, kw) for args, kw in rec.notified() if "Rescheduled automatically" in kw.get("update_kind", "")]
        self.assertEqual(sorted(args[0] for args, _ in auto), sorted([b.id, c.id]))
        self.assertTrue(all(kw["due_changed"] for _, kw in auto))

    def test_preview_writes_nothing(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", MON2, WED2, blocked_by=[a.id])
        self.link(a, b)
        out = T.schedule_preview(b.id, T.SchedulePreviewBody(schedule_mode="auto"), user=OWNER, db=self.db)
        self.assertEqual([(m["id"], m["to"]["start"]) for m in out["moved"]], [(b.id, WED)])
        fresh = database.SessionLocal()
        try:
            row = fresh.query(models.Task).filter(models.Task.id == b.id).first()
            self.assertEqual((row.schedule_mode, row.start_on, row.due_on), ("manual", MON2, WED2))
            self.assertEqual(row.due_history or [], [])
            self.assertEqual(fresh.query(models.TaskActivity).filter(models.TaskActivity.entity_id == b.id).count(), 0)
        finally:
            fresh.close()

    def test_switching_to_auto_places_the_task_at_once(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", MON2, WED2, blocked_by=[a.id])
        self.link(a, b)
        out = self.patch(b, schedule_mode="auto")
        self.assertEqual(out["scheduleMode"], "auto")
        self.assertEqual([m["id"] for m in out["moved"]], [b.id])
        self.assertEqual(self.dates(b), (WED, FRI))

    def test_dragging_an_auto_task_changes_its_length_only(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", WED, THU, mode="auto", blocked_by=[a.id])
        self.link(a, b)
        self.patch(b, start_on=FRI, due_on=MON2)   # a move: back to Wed, same two days
        self.assertEqual(self.dates(b), (WED, THU))
        self.patch(b, due_on=FRI)                  # the end edge: three days now
        self.assertEqual(self.dates(b), (WED, FRI))

    def test_bad_values_are_refused(self):
        a = self.task("Demo", MON, TUE)
        self.assertEqual(self.code(lambda: self.patch(a, schedule_mode="magic")), 422)
        self.assertEqual(self.code(lambda: self.patch(a, dependency_lags={"x": "soon"})), 422)
        self.assertEqual(self.code(lambda: self.patch(a, dependency_lags={"x": 400})), 422)

    def test_completed_auto_task_is_left_alone(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", MON2, WED2, mode="auto", blocked_by=[a.id], completed=True, status="completed")
        self.link(a, b)
        self.patch(a, due_on=THU)
        self.assertEqual(self.dates(b), (MON2, WED2))

    # Review item 1: only what the actor may edit moves, and only what they
    # may see is named in the answer.
    def test_a_successor_the_actor_may_not_edit_stays_and_stops_the_walk(self):
        self.db.add(models.TaskProject(id="p-other", name="Theirs", owner_email=OUTSIDER["email"],
                                       access_level="restricted", company_id=CO, member_emails=[], member_roles={},
                                       created_at=now_iso(), modified_at=now_iso(), created_by=OUTSIDER["email"]))
        self.db.commit()
        a = self.task("Demo", MON, TUE)
        theirs = self.task("Their Footings", WED, THU, mode="auto", blocked_by=[a.id], project_id="p-other",
                           owner_email=OUTSIDER["email"], created_by=OUTSIDER["email"])
        after = self.task("Posts", FRI, FRI, mode="auto", blocked_by=[theirs.id])
        self.link(a, theirs)
        self.link(theirs, after)
        out = self.patch(a, due_on=WED)
        self.assertNotIn("moved", out)
        self.assertEqual(self.dates(theirs), (WED, THU))   # not the owner's to move
        self.assertEqual(self.dates(after), (FRI, FRI))    # the walk stopped at it
        # The preview answers the same: nothing.
        self.assertEqual(T.schedule_preview(a.id, T.SchedulePreviewBody(), user=OWNER, db=self.db)["moved"], [])

    def test_moved_payload_names_only_what_the_caller_may_see(self):
        a = self.task("Demo", MON, TUE)
        moves = [{"id": a.id, "title": "Demo", "cause": "x", "causeId": "y", "from": {"start": MON, "due": TUE},
                  "to": {"start": TUE, "due": WED}}]
        seen = T._moved_payload(self.db, moves, lambda r: True)
        self.assertEqual(seen[0]["task"]["id"], a.id)
        self.assertEqual(seen[0]["title"], "Demo")
        hidden = T._moved_payload(self.db, moves, lambda r: False)
        self.assertEqual(hidden, [{"id": a.id, "from": {"start": MON, "due": TUE}, "to": {"start": TUE, "due": WED}}])

    # Review item 2: the dependency type decides where the successor lands.
    def test_dependency_types_place_the_successor(self):
        a = self.task("Demo", MON, WED)                                   # Mon 11/09 - Wed 11/11
        b = self.task("Footings", THU, FRI, mode="auto", blocked_by=[a.id])   # two working days
        self.link(a, b)
        cases = [
            ("SS", 0, (MON, TUE)),      # start = Demo's start
            ("SS", 1, (TUE, WED)),
            ("FF", 0, (TUE, WED)),      # due = Demo's due, start = due - 1
            ("FF", 2, (THU, FRI)),      # due = Wed + 2 = Fri
            ("SF", 1, (MON, TUE)),      # due = Demo's start + 1 = Tue
            ("FS", 0, (THU, FRI)),      # the default: due + 1
        ]
        for kind, lag, want in cases:
            with self.subTest(kind=kind, lag=lag):
                self.patch(b, dependency_types={a.id: kind}, dependency_lags={a.id: lag})
                self.assertEqual(self.dates(b), want)

    # Review item 3: a Timeline drag writes ONE line per moved task - the
    # engine's for an auto successor, the cascade's for a manual one after it.
    def test_timeline_drag_moves_an_auto_successor_once(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", WED, THU, mode="auto", blocked_by=[a.id])
        c = self.task("Posts", THU, FRI, blocked_by=[b.id])
        self.link(a, b)
        self.link(b, c)
        out = T.reschedule_task(a.id, T.RescheduleBody(start_on=TUE, due_on=WED), Recorder(), user=OWNER, db=self.db)
        self.assertEqual(self.dates(b), (THU, FRI))
        self.assertEqual(self.history(b), ["auto"])
        self.assertEqual(self.dates(c), (FRI, "2026-11-14"))   # pushed one calendar day by the cascade, as before
        self.assertEqual(self.history(c), ["cascade"])
        self.assertEqual(int(b.due_extension_count or 0), 0)
        self.assertEqual(sorted(m["id"] for m in out["moved"]), sorted([b.id, c.id]))
        self.assertEqual(self.db.query(models.TaskNotification).filter(models.TaskNotification.task_id == b.id,
                                                                         models.TaskNotification.kind == "task_due_changed").count(), 0)

    # Review item 4: the engine's move leaves the negotiation and the count alone.
    def test_auto_move_touches_no_agreement_or_extension_count(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", WED, THU, mode="auto", blocked_by=[a.id], due_agreement="proposed",
                      due_proposal={"dueOn": FRI2, "by": ASSIGNEE_LIKE, "at": now_iso()}, due_extension_count=2)
        self.link(a, b)
        self.patch(a, due_on=THU)
        self.db.refresh(b)
        self.assertEqual((b.start_on, b.due_on), (FRI, MON2))
        self.assertEqual(b.due_agreement, "proposed")
        self.assertEqual(b.due_proposal["dueOn"], FRI2)
        self.assertEqual(b.due_extension_count, 2)
        self.assertFalse(b.due_history[-1]["extension"])
        self.assertEqual(self.db.query(models.TaskNotification).filter(models.TaskNotification.task_id == b.id).count(), 0)


class BaselineTests(Base):
    def test_take_diff_and_delete(self):
        a = self.task("Demo", MON, TUE)
        b = self.task("Footings", WED, THU)
        gone = self.task("Old Fence", MON, MON)
        sub = self.task("Hinges", WED, WED, parent_task_id=b.id, project_id="")
        base = P.take_baseline(PID, P.BaselineBody(), user=EDITOR, db=self.db)
        self.assertRegex(base["name"], r"^Baseline \d\d/\d\d/\d{4}$")
        self.assertEqual(base["count"], 4)
        self.assertEqual(base["takenBy"], EDITOR["email"])
        self.assertEqual([x["id"] for x in P.list_baselines(PID, user=VIEWER, db=self.db)], [base["id"]])

        self.patch(b, due_on=TUE2)                  # Thu -> Tue over the weekend: Fri, Mon, Tue = three working days
        gone.deleted_at = now_iso()
        self.db.commit()
        new = self.task("Paint", FRI, FRI)
        diff = P.baseline_diff(PID, base["id"], user=VIEWER, db=self.db)
        self.assertEqual([x["id"] for x in diff["added"]], [new.id])
        self.assertEqual([x["id"] for x in diff["removed"]], [gone.id])
        self.assertEqual(diff["moved"], [{"id": b.id, "title": "Footings", "from": {"start": WED, "due": THU},
                                          "to": {"start": WED, "due": TUE2}, "slipDays": 3}])
        self.assertEqual(diff["unchanged"], 2)
        self.assertEqual(len(diff["snapshot"]), 4)

        self.assertEqual(self.code(lambda: P.delete_baseline(PID, base["id"], user=EDITOR, db=self.db)), 403)
        P.delete_baseline(PID, base["id"], user=OWNER, db=self.db)
        self.assertEqual(P.list_baselines(PID, user=OWNER, db=self.db), [])

    def test_holiday_counts_in_the_slip(self):
        self.holiday()
        b = self.task("Footings", WED, FRI)
        base = P.take_baseline(PID, P.BaselineBody(name="Plan A"), user=OWNER, db=self.db)
        self.assertEqual(base["name"], "Plan A")
        self.patch(b, due_on=TUE2)
        diff = P.baseline_diff(PID, base["id"], user=OWNER, db=self.db)
        self.assertEqual(diff["moved"][0]["slipDays"], 1)

    def test_non_member_is_refused(self):
        base = P.take_baseline(PID, P.BaselineBody(), user=OWNER, db=self.db)
        self.assertEqual(self.code(lambda: P.list_baselines(PID, user=OUTSIDER, db=self.db)), 403)
        self.assertEqual(self.code(lambda: P.baseline_diff(PID, base["id"], user=OUTSIDER, db=self.db)), 403)
        self.assertEqual(self.code(lambda: P.take_baseline(PID, P.BaselineBody(), user=VIEWER, db=self.db)), 403)

    # Review item 6: the snapshot is the whole project; a reader sees only
    # their part of both sides, so nothing is added / removed by sight.
    def test_snapshot_is_the_full_project_and_the_diff_is_the_readers_view(self):
        self.arm_walls()
        mine = self.task("Footings", WED, THU)
        theirs = self.task("Their Fence", MON, TUE, company_id="co-b", owner_email=OUTSIDER["email"],
                           created_by=OUTSIDER["email"])
        base = P.take_baseline(PID, P.BaselineBody(), user=EDITOR, db=self.db)
        self.assertEqual(base["count"], 2)                      # the full project, the other company's row included
        diff = P.baseline_diff(PID, base["id"], user=VIEWER, db=self.db)
        self.assertEqual([s["id"] for s in diff["snapshot"]], [mine.id])
        self.assertEqual((diff["added"], diff["removed"], diff["moved"], diff["unchanged"]), ([], [], [], 1))
        # Trashed and still over the wall: not listed as removed either.
        theirs.deleted_at = now_iso()
        self.db.commit()
        diff = P.baseline_diff(PID, base["id"], user=VIEWER, db=self.db)
        self.assertEqual(diff["removed"], [])
        self.assertNotIn("Their Fence", str(diff))
        # Trashed on the reader's own side: that one IS removed.
        mine.deleted_at = now_iso()
        self.db.commit()
        diff = P.baseline_diff(PID, base["id"], user=VIEWER, db=self.db)
        self.assertEqual([r["id"] for r in diff["removed"]], [mine.id])


class ProjectStatusTests(Base):
    def test_editor_sets_status_with_actor_and_time(self):
        out = P.update_project(PID, P.ProjectBody(status="at_risk", status_note="Permits are late"), user=EDITOR, db=self.db)
        self.assertEqual((out["status"], out["statusNote"], out["statusSetBy"]), ("at_risk", "Permits are late", EDITOR["email"]))
        self.assertTrue(out["statusSetAt"])
        # The same status sent again stamps nothing new.
        again = P.update_project(PID, P.ProjectBody(status="at_risk"), user=OWNER, db=self.db)
        self.assertEqual(again["statusSetBy"], EDITOR["email"])

    def test_viewer_and_outsider_are_refused(self):
        self.assertEqual(self.code(lambda: P.update_project(PID, P.ProjectBody(status="on_track"), user=VIEWER, db=self.db)), 403)
        self.assertEqual(self.code(lambda: P.update_project(PID, P.ProjectBody(status="on_track"), user=OUTSIDER, db=self.db)), 403)
        self.assertEqual(self.code(lambda: P.update_project(PID, P.ProjectBody(status="purple"), user=OWNER, db=self.db)), 422)
        # Status alone is editor work; a rename with it is still the owner's.
        self.assertEqual(self.code(lambda: P.update_project(PID, P.ProjectBody(status="on_track", name="X"), user=EDITOR, db=self.db)), 403)

    def test_never_set_project_reads_as_unset(self):
        p = P.project_to_dict(self.db.query(models.TaskProject).filter(models.TaskProject.id == PID).first())
        self.assertIsNone(p["statusSetAt"])
        self.assertIsNone(p["statusSetBy"])

    # Review item 5: the Edit form saving a legacy row ('' / None) stamps nothing.
    def test_legacy_status_saved_back_as_not_started_stamps_nothing(self):
        p = self.db.query(models.TaskProject).filter(models.TaskProject.id == PID).first()
        for legacy in ("", None):
            p.status = legacy
            self.db.commit()
            out = P.update_project(PID, P.ProjectBody(status="not_started", name="Escondido Gate Rebuild"), user=OWNER, db=self.db)
            self.assertIsNone(out["statusSetAt"], legacy)
        out = P.update_project(PID, P.ProjectBody(status="on_track"), user=OWNER, db=self.db)
        self.assertTrue(out["statusSetAt"])


if __name__ == "__main__":
    unittest.main()
