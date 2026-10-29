"""My Numbers - the Performance scorecard (Neil, Oct 29 2026). perf_metrics
on a throwaway database: each number from seeded rows through the module's
own calculation (tasks, tickets, time sheets, training seeded for real; the
attendance and hours sources are the Shifts and Workforce Scorecard engines,
whose outputs are stood in for here - their own tests cover their rules), a
number that does not apply is available: False, confidential HR tickets
never count, and a source that fails never blanks the card.

Run with: python -m pytest test_perf_metrics.py -q
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
import perf_metrics as pm  # noqa: E402

EMP, OTHER = "emp.pm@greensglobal.com", "other.pm@greensglobal.com"
TODAY = date(2026, 10, 29)
START, END = "2026-10-01", "2026-10-29"


def _iso(d: str, hour: int = 12) -> str:
    return datetime.fromisoformat(f"{d}T{hour:02d}:00:00").replace(tzinfo=timezone.utc).isoformat()


class MetricsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        pm.clear_cache()
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskTicket, models.TimesheetReview, models.TimeApproval, models.KbCourse,
                  models.KbCourseAssignment, models.KbCourseProgress, models.NexusEmployee):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="e1", work_email=EMP, first_name="Erin", last_name="T", status="active"))
        self.db.commit()
        # The attendance and hours engines stand in empty unless a test says otherwise.
        self._p = [mock.patch("shift_attendance.actuals", return_value={"people": {}}),
                   mock.patch("workforce_scorecard.build_report", return_value={"people": []})]
        for p in self._p:
            p.start()

    def tearDown(self):
        for p in self._p:
            p.stop()
        self.db.close()

    def card(self, email=EMP):
        return {m["key"]: m for m in pm.scorecard(self.db, email, START, END, today=TODAY)["metrics"]}

    def task(self, tid, *, done_on="", due="", who=EMP, deleted=""):
        self.db.add(models.Task(id=tid, title=tid, assignee_email=who, assignee_emails=[who], completed=bool(done_on),
                                completed_at=_iso(done_on) if done_on else "", due_on=due, deleted_at=deleted,
                                type="task"))

    def test_nothing_applies_to_a_new_person(self):
        c = self.card()
        self.assertEqual(set(c), set(pm.ORDER))
        self.assertFalse(any(m["available"] for m in c.values()))
        self.assertTrue(all(m["display"] == "" and m["value"] is None for m in c.values()))

    def test_tasks(self):
        self.task("t1", done_on="2026-10-05", due="2026-10-06")    # on time
        self.task("t2", done_on="2026-10-10", due="2026-10-08")    # late
        self.task("t3", done_on="2026-10-12")                      # no due date: done, not judged
        self.task("t4", done_on="2026-09-20", due="2026-09-30")    # before the period
        self.task("t5", due="2026-10-20")                          # open, overdue today
        self.task("t6", due="2026-11-20")                          # open, not due
        self.task("t7", done_on="2026-10-07", due="2026-10-06", who=OTHER)
        self.task("t8", done_on="2026-10-07", due="2026-10-09", deleted="2026-10-08")
        self.db.commit()
        c = self.card()
        self.assertEqual((c["tasks_done"]["value"], c["tasks_done"]["display"]), (3, "3"))
        self.assertEqual((c["tasks_on_time"]["value"], c["tasks_on_time"]["display"]), (50.0, "50%"))
        self.assertEqual(c["tasks_on_time"]["detail"], "1 of 2 with a due date")
        self.assertEqual((c["tasks_overdue"]["value"], c["tasks_overdue"]["good"]), (1, "low"))

    def test_tickets_resolved_and_first_reply_target(self):
        def t(tid, created, **kw):
            self.db.add(models.TaskTicket(id=tid, subject=tid, assignee_email=EMP, requester_email="req@x.com",
                                          created_at=_iso(created, 9), **kw))
        t("k1", "2026-10-02", status="resolved", resolved_at=_iso("2026-10-03"),
          first_response_due_at=_iso("2026-10-02", 17), first_response_at=_iso("2026-10-02", 10))   # met
        t("k2", "2026-10-04", status="closed", resolved_at=_iso("2026-10-06"),
          first_response_due_at=_iso("2026-10-04", 17), first_response_at=_iso("2026-10-05", 10))   # missed
        t("k3", "2026-10-10", status="open", first_response_due_at=_iso("2026-10-10", 17),
          first_response_at=_iso("2026-10-10", 11))                                                 # met, open
        # A confidential HR desk ticket is invisible to every query - never a metric.
        t("k4", "2026-10-11", status="resolved", resolved_at=_iso("2026-10-12"), confidential_desk="hr",
          first_response_due_at=_iso("2026-10-11", 17), first_response_at=_iso("2026-10-11", 10))
        self.db.commit()
        c = self.card()
        self.assertEqual(c["tickets_resolved"]["value"], 2)
        self.assertEqual((c["ticket_sla"]["value"], c["ticket_sla"]["detail"]), (66.7, "2 of 3 on target"))

    def test_time_sheets_signed_on_time(self):
        for pid, end, agreed, signed in (("p1", "2026-10-11", "2026-10-12", "2026-10-13"),   # within 3 days
                                         ("p2", "2026-10-25", "2026-10-26", "2026-10-30"),   # 4 days: late
                                         ("p3", "2026-09-27", "2026-09-28", "2026-09-28")):  # before the period
            start = (date.fromisoformat(end) - timedelta(days=13)).isoformat()
            self.db.add(models.TimesheetReview(id=pid, employee_email=EMP, period_start=start, period_end=end,
                                               status="completed", agreed_at=_iso(agreed)))
            self.db.add(models.TimeApproval(id=f"a-{pid}", employee_email=EMP, period_start=start, period_end=end,
                                            kind="employee_sign", approved_at=_iso(signed), revoked=0))
        self.db.commit()
        c = self.card()
        self.assertEqual((c["timesheets"]["value"], c["timesheets"]["detail"]), (50.0, "1 of 2 signed on time"))

    def test_required_training(self):
        for cid in ("c1", "c2"):
            self.db.add(models.KbCourse(id=cid, title=cid, status="published", lessons="[]"))
            self.db.add(models.KbCourseAssignment(id=f"as-{cid}", course_id=cid, user_email=EMP))
        self.db.add(models.KbCourse(id="c3", title="draft", status="draft", lessons="[]"))
        self.db.add(models.KbCourseAssignment(id="as-c3", course_id="c3", user_email=EMP))   # not published: not counted
        self.db.add(models.KbCourseProgress(id="pr1", course_id="c1", user_email=EMP, completed_at="2026-10-02", passed=True))
        self.db.commit()
        c = self.card()
        self.assertEqual((c["training"]["value"], c["training"]["detail"]), (50.0, "1 of 2 complete"))

    def test_attendance_and_hours_come_from_their_engines(self):
        for p in self._p:
            p.stop()
        acts = {"people": {EMP: {"judged": 20, "late": 2, "noShow": 1}}}
        week = {"people": [{"days": [
            {"date": "2026-10-05", "scored": True, "expectedMin": 480, "workedMin": 420, "leaveMin": 0},
            {"date": "2026-10-06", "scored": True, "expectedMin": 480, "workedMin": 0, "leaveMin": 480},
            {"date": "2026-09-30", "scored": True, "expectedMin": 480, "workedMin": 0, "leaveMin": 0},   # outside
            {"date": "2026-10-07", "scored": False, "expectedMin": 480, "workedMin": 0, "leaveMin": 0}]}]}
        calls = []
        with mock.patch("shift_attendance.actuals", return_value=acts) as a, \
                mock.patch("workforce_scorecard.build_report", side_effect=lambda *x, **k: calls.append(x[3]) or (week if len(calls) == 1 else {"people": []})):
            c = self.card()
        self.assertEqual(a.call_args[0][1:4], ([EMP], START, END))
        self.assertEqual((c["on_time"]["value"], c["on_time"]["detail"]), (85.0, "17 of 20 shifts on time"))
        self.assertEqual((c["no_shows"]["value"], c["no_shows"]["good"]), (1, "low"))
        self.assertEqual((c["hours"]["value"], c["hours"]["detail"]), (93.8, "15 of 16 hours"))
        self.assertEqual(calls[0], date(2026, 9, 28))     # the scorecard's own week starts, through the period
        self._p = [mock.patch("shift_attendance.actuals", return_value={"people": {}}),
                   mock.patch("workforce_scorecard.build_report", return_value={"people": []})]
        for p in self._p:
            p.start()

    def test_a_failing_source_never_blanks_the_card(self):
        self.task("t1", done_on="2026-10-05", due="2026-10-06")
        self.db.commit()
        with mock.patch.object(pm, "_tickets", side_effect=RuntimeError("boom")):
            c = self.card()
        self.assertFalse(c["tickets_resolved"]["available"])
        self.assertTrue(c["tasks_done"]["available"])

    def test_one_metric_and_the_cache(self):
        self.task("t1", done_on="2026-10-05", due="2026-10-06")
        self.db.commit()
        self.assertEqual(pm.metric(self.db, EMP, "tasks_done", START, END, today=TODAY)["value"], 1)
        self.task("t2", done_on="2026-10-06", due="2026-10-06")
        self.db.commit()
        self.assertEqual(pm.metric(self.db, EMP, "tasks_done", START, END, today=TODAY)["value"], 1)   # remembered
        pm.clear_cache()
        self.assertEqual(pm.metric(self.db, EMP, "tasks_done", START, END, today=TODAY)["value"], 2)
        with self.assertRaises(KeyError):
            pm.metric(self.db, EMP, "sick_days", START, END, today=TODAY)

    def test_a_period_past_today_is_read_to_today(self):
        out = pm.scorecard(self.db, EMP, "2026-10-01", "2026-12-31", today=TODAY)
        self.assertEqual(out["period"]["readTo"], "2026-10-29")
        self.assertEqual(pm.quarter_period(TODAY), ("2026-10-01", "2026-10-29"))
        self.assertEqual(pm.month_period(TODAY), ("2026-10-01", "2026-10-29"))

    def test_never_leave_pay_or_hr(self):
        keys = " ".join(pm.METRICS)
        for word in ("sick", "leave", "pto", "vacation", "pay", "salary", "hr_"):
            self.assertNotIn(word, keys)


if __name__ == "__main__":
    unittest.main()
