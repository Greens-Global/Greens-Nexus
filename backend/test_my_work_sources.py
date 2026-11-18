"""
My Work as ONE list (Neil, 11/13/2026) - my_work_sources.py and the wider
GET /me/work.

Pins:
  * the registry: every source's rows land in one list with its key, the
    chips (`sources`) list only sources with something in them, and a source
    that fails is named in `errors` while the others still show (a failed
    load never looks like an empty list); "no access" (HTTPException) is
    quiet;
  * Yours To Do: only the caller's own to-dos (scope "act") reach My Work -
    never a decision on someone else's request - and only the sources flagged
    `acts` are run. A source that builds an act row without the flag fails
    here, so the list cannot drift from Approvals;
  * Time Sheet: the action states of timesheet_due become one row each, in
    the briefing's own words, opening that period's Time Sheet; "with the
    manager" is not a to-do;
  * Training: a course assigned and not finished is a row; one the person
    opened by themselves is not;
  * a row from every source is grouped by the caller's day like a task.

Throwaway sqlite. No network. Run ALONE: python -m pytest test_my_work_sources.py
"""
import os
import re
import tempfile
import unittest
from unittest import mock

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

from fastapi import HTTPException

import approvals_inbox
import database
import models
import my_work_sources as S
from routers import my_work as MW

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


ME = "sagar.shoundik@greensglobal.com"
USER = {"email": ME, "level": 1}
TODAY = "2026-11-13"


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self._saved = list(S.SOURCES)
        self.addCleanup(lambda: S.SOURCES.__setitem__(slice(None), self._saved))
        S.SOURCES[:] = []
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)

    def _collect(self):
        return S.collect(self.db, USER, ME, 0, TODAY)

    def test_rows_carry_their_source_and_chips_list_only_what_has_rows(self):
        S.source("a", "Alpha")(lambda db, user, me, ctx: [S.item("todo", "1", title="One"), S.item("todo", "2", title="Two")])
        S.source("b", "Beta")(lambda db, user, me, ctx: [])
        S.source("c", "Gamma")(lambda db, user, me, ctx: [S.item("course", "9", title="Nine")])
        out = self._collect()
        self.assertEqual([(i["id"], i["source"]) for i in out["items"]], [("1", "a"), ("2", "a"), ("9", "c")])
        self.assertEqual(out["sources"], [{"key": "a", "label": "Alpha", "count": 2}, {"key": "c", "label": "Gamma", "count": 1}])
        self.assertEqual(out["errors"], [])

    def test_a_failing_source_is_named_and_the_others_still_show(self):
        def boom(db, user, me, ctx):
            raise ValueError("module down")
        S.source("a", "Alpha")(lambda db, user, me, ctx: [S.item("todo", "1", title="One")])
        S.source("b", "Training")(boom)
        out = self._collect()
        self.assertEqual([i["id"] for i in out["items"]], ["1"])
        self.assertEqual(out["errors"], [{"source": "b", "label": "Training"}])

    def test_no_access_is_quiet(self):
        def denied(db, user, me, ctx):
            raise HTTPException(403, "no")
        S.source("a", "Alpha")(denied)
        out = self._collect()
        self.assertEqual((out["items"], out["sources"], out["errors"]), ([], [], []))

    def test_ctx_carries_the_callers_day_and_offset(self):
        seen = {}
        S.source("a", "Alpha")(lambda db, user, me, ctx: seen.update(ctx) or [])
        S.collect(self.db, USER, ME, 300, TODAY)
        self.assertEqual(seen, {"tz_offset_min": 300, "today": TODAY})

    def test_item_shape(self):
        it = S.item("todo", "nexus_sign:7", title="NDA", where="Documents To Sign", due_on="2026-11-20T00:00:00",
                    status_label="Waiting on You", priority="nonsense", link={"view": "myhr", "sub": "sign:7"},
                    cta="Review & Sign")
        self.assertEqual(it, {"kind": "todo", "id": "nexus_sign:7", "code": "", "title": "NDA",
                              "project": "Documents To Sign", "dueOn": "2026-11-20", "status": "todo",
                              "statusLabel": "Waiting on You", "priority": "medium", "unread": False,
                              "view": "myhr", "sub": "sign:7", "link": {"view": "myhr", "sub": "sign:7"},
                              "cta": "Review & Sign", "detail": ""})

    def test_the_shipped_sources_in_chip_order(self):
        self.assertEqual([s.key for s in self._saved], ["tasks", "tickets", "todo", "timesheet", "training"])


class YoursToDoTests(unittest.TestCase):
    def setUp(self):
        self._saved = list(approvals_inbox.SOURCES)
        self.addCleanup(lambda: approvals_inbox.SOURCES.__setitem__(slice(None), self._saved))
        approvals_inbox.SOURCES[:] = []
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)

    def _src(self, key, rows, acts, label="Label"):
        calls = []
        def fn(db, user, ctx):
            calls.append(1)
            return rows() if callable(rows) else rows
        approvals_inbox.source(key, label, "work", acts=acts)(fn)
        return calls

    def test_only_act_rows_from_sources_flagged_acts(self):
        row = approvals_inbox.row
        mine = row("nexus_sign", "p1", title="Sign the NDA", scope="act", due="2026-11-20",
                   actions=(approvals_inbox.a_open("Review & Sign"),), link={"view": "myhr", "sub": "sign:p1"})
        theirs = row("perf_review", "r1", title="Review Bo's goals")            # decide: stays in Approvals
        a = self._src("nexus_sign", [mine], True, "Documents To Sign")
        b = self._src("perf_review", [theirs], True, "Performance Reviews")
        c = self._src("time_off", [row("time_off", "t1", title="Ana's leave")], False)
        got = approvals_inbox.yours_to_do(self.db, USER)
        self.assertEqual([r["key"] for r in got["rows"]], ["nexus_sign:p1"])
        self.assertEqual(got["rows"][0]["sourceLabel"], "Documents To Sign")
        self.assertEqual((len(a), len(b), len(c)), (1, 1, 0))   # the decide-only source never ran
        items = S._yours_to_do(self.db, USER, ME, {})
        self.assertEqual(len(items), 1)
        it = items[0]
        self.assertEqual((it["kind"], it["id"], it["title"], it["project"], it["dueOn"], it["cta"], it["link"]),
                         ("todo", "nexus_sign:p1", "Sign the NDA", "Documents To Sign", "2026-11-20",
                          "Review & Sign", {"view": "myhr", "sub": "sign:p1"}))

    def test_a_failed_module_with_nothing_else_is_an_error_not_an_empty_list(self):
        def boom():
            raise ValueError("esign down")
        self._src("nexus_sign", boom, True, "Documents To Sign")
        self.assertEqual(approvals_inbox.yours_to_do(self.db, USER)["errors"],
                         [{"source": "nexus_sign", "label": "Documents To Sign"}])
        with self.assertRaises(RuntimeError):
            S._yours_to_do(self.db, USER, ME, {})

    def test_no_access_is_quiet(self):
        def denied():
            raise HTTPException(403, "no")
        self._src("nexus_sign", denied, True)
        self.assertEqual(approvals_inbox.yours_to_do(self.db, USER), {"rows": [], "errors": []})


class ActFlagStaysTrue(unittest.TestCase):
    """Every approvals source whose code builds a scope="act" row carries
    acts=True - read from the file, so a new one cannot be forgotten."""

    def test_every_source_that_makes_an_act_row_is_flagged(self):
        text = open(os.path.join(os.path.dirname(os.path.abspath(approvals_inbox.__file__)), "approvals_inbox.py"),
                    encoding="utf-8").read()
        blocks = re.split(r"(?m)^(?=@source\()", text)[1:]
        self.assertGreater(len(blocks), 30)
        makers = []
        for b in blocks:
            head = b.split("\n", 1)[0]
            # the block ends at the next top-level statement that is not part of this function
            body = re.split(r"(?m)^(?=def yours_to_do|def collect|# ── Who the caller is)", b)[0]
            if 'scope="act"' in body:
                makers.append(head)
                self.assertIn("acts=True", head, f"{head} builds an act row without acts=True")
        self.assertGreaterEqual(len(makers), 8)
        flagged = [s.key for s in approvals_inbox.SOURCES if s.acts]
        self.assertEqual(len(flagged), len(makers))


class TimeSheetTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)

    def _rows(self, due):
        import timesheet_due
        with mock.patch.object(timesheet_due, "due_cached", return_value=due):
            return S._timesheet(self.db, USER, ME, {})

    def test_action_states_become_rows_in_the_briefings_words(self):
        base = {"start": "2026-10-25", "end": "2026-11-07", "payType": "hourly", "today": TODAY,
                "approver": "Max Lee", "approverEmail": "max@greensglobal.com", "workedMin": 4800,
                "blocker": "", "extraTimePending": 0, "since": "2026-11-08T00:00:00"}
        rows = self._rows([{**base, "state": "submit"},
                           {**base, "state": "with_manager"}])          # an update, not a to-do
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["kind"], r["title"], r["project"], r["dueOn"], r["statusLabel"], r["cta"]),
                         ("timesheet", "Submit Your Time Sheet", "Time Sheet", "2026-11-07", "Not Submitted",
                          "Review and Submit"))
        self.assertEqual(r["link"], {"view": "timeclock", "sub": "timesheet", "start": "2026-10-25",
                                     "payType": "hourly", "submit": True})
        self.assertEqual(MW.bucket_of(r["dueOn"], TODAY), "overdue")     # the period is over

    def test_the_last_day_is_due_today(self):
        r = self._rows([{"start": "2026-11-01", "end": TODAY, "payType": "hourly", "today": TODAY, "state": "closes_today",
                         "approver": "Max Lee", "approverEmail": "max@greensglobal.com", "workedMin": 60,
                         "blocker": "", "extraTimePending": 0, "since": f"{TODAY}T00:00:00"}])[0]
        self.assertEqual((r["statusLabel"], MW.bucket_of(r["dueOn"], TODAY)), ("Closes Today", "today"))

    def test_nobody_to_send_it_to_opens_without_submit(self):
        r = self._rows([{"start": "2026-11-01", "end": "2026-11-14", "payType": "hourly", "today": TODAY, "state": "submit",
                         "approver": "", "approverEmail": "", "workedMin": 60, "blocker": "",
                         "extraTimePending": 0, "since": "2026-11-15T00:00:00"}])[0]
        self.assertEqual((r["title"], r["cta"]), ("Check Your Time Sheet", "Review Time Sheet"))
        self.assertNotIn("submit", r["link"])


class TrainingTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        S._training_cache.invalidate()
        self.addCleanup(S._training_cache.invalidate)

    def test_assigned_courses_are_rows_and_self_started_ones_are_not(self):
        from routers import kb_training
        due = [{"id": "c1", "title": "Gate Safety", "assigned": True, "due_date": "2026-11-10", "my_status": "Overdue"},
               {"id": "c2", "title": "Leading With Nexus", "assigned": True, "due_date": "", "my_status": "In Progress"},
               {"id": "c3", "title": "Browsed It", "assigned": False, "due_date": "", "my_status": "In Progress"}]
        with mock.patch.object(kb_training, "my_training_summary", return_value={"due": due}):
            rows = S._training(self.db, USER, ME, {})
        self.assertEqual([(r["kind"], r["id"], r["dueOn"], r["statusLabel"], r["cta"]) for r in rows],
                         [("course", "c1", "2026-11-10", "Not Started", "Start"),
                          ("course", "c2", "", "In Progress", "Continue")])
        self.assertEqual(rows[0]["link"], {"view": "sop", "sub": "course:c1"})
        self.assertEqual(MW.bucket_of(rows[0]["dueOn"], TODAY), "overdue")

    def test_cached_rows_do_not_carry_a_callers_stamp(self):
        from routers import kb_training
        due = [{"id": "c1", "title": "Gate Safety", "assigned": True, "due_date": "", "my_status": "Not Started"}]
        with mock.patch.object(kb_training, "my_training_summary", return_value={"due": due}) as m:
            first = S._training(self.db, USER, ME, {})
            first[0]["source"] = "stamped"
            second = S._training(self.db, USER, ME, {})
        self.assertNotIn("source", second[0])
        self.assertEqual(m.call_count, 1)        # one read a minute per person


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self._saved = list(S.SOURCES)
        self.addCleanup(lambda: S.SOURCES.__setitem__(slice(None), self._saved))
        S.SOURCES[:] = []
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        p = mock.patch.object(MW, "local_today", return_value=TODAY)
        p.start()
        self.addCleanup(p.stop)

    def test_every_kind_is_grouped_by_the_callers_day_and_errors_ride_along(self):
        def boom(db, user, me, ctx):
            raise ValueError("down")
        S.source("todo", "Yours To Do")(lambda db, user, me, ctx: [
            S.item("todo", "nexus_sign:1", title="Sign", due_on="2026-11-12"),
            S.item("todo", "perf_plan:2", title="Plan")])
        S.source("training", "Training")(lambda db, user, me, ctx: [S.item("course", "c1", title="Course", due_on=TODAY)])
        S.source("timesheet", "Time Sheet")(boom)
        out = MW.my_work(tz_offset_min=0, user=USER, db=self.db)
        self.assertEqual([x["id"] for x in out["overdue"]], ["nexus_sign:1"])
        self.assertEqual([x["id"] for x in out["today"]], ["c1"])
        self.assertEqual([x["id"] for x in out["later"]], ["perf_plan:2"])
        self.assertEqual(out["counts"]["total"], 3)
        self.assertEqual(out["sources"], [{"key": "todo", "label": "Yours To Do", "count": 2},
                                          {"key": "training", "label": "Training", "count": 1}])
        self.assertEqual(out["errors"], [{"source": "timesheet", "label": "Time Sheet"}])


if __name__ == "__main__":
    unittest.main()
