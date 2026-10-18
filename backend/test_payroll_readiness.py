"""Payroll Readiness (Neil, Oct 17 2026) - payroll_readiness.py + its routes.

  - The rules on their own: thresholds (25% OR 8 hours by default, a change
    under an hour is never a percentage jump), the variance lines, the week
    vs. 8-week average, the overtime jump, 2+ missing clock-outs, and which
    review states read as Not Ready.
  - Settings per company: defaults <- tenant row <- sparse company override.
  - End to end on a real timecard: every figure equals the timecard engine's
    own totals, the exceptions (not approved, approved but unsigned, missing
    punches, no pay rate), the variance and anomaly flags, salaried people on
    their month, and the routes' access - managers see their team only and no
    money; only HR may change the thresholds.

    python -m unittest test_payroll_readiness -v
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import payroll_readiness as pr  # noqa: E402
from routers import timeclock  # noqa: E402

CFG = dict(pr.DEFAULTS)
ENT, ENT2 = "ent-pr-1", "ent-pr-2"
ADMIN, MGR, EMP, EMP2, SAL, OTHER = (f"{n}.pr@greensglobal.com" for n in ("admin", "mgr", "emp", "emp2", "sal", "other"))
ANCHOR = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")


class RuleTests(unittest.TestCase):
    def test_threshold_is_percent_or_hours(self):
        self.assertTrue(pr.over_threshold(9 * 60 + 1, 0, 25, 8))          # over 8 hours
        self.assertFalse(pr.over_threshold(8 * 60, 0, 25, 8))             # exactly 8 is not over
        self.assertTrue(pr.over_threshold(50 * 60, 38 * 60, 25, 8))       # +31.6%
        self.assertFalse(pr.over_threshold(45 * 60, 40 * 60, 25, 8))      # +12.5%, 5h
        self.assertFalse(pr.over_threshold(150, 100, 25, 8))              # +50% but under an hour

    def test_variance_lines_and_reasons(self):
        cur = {"hours": 100 * 60, "ot": 20 * 60, "leave": 0, "pay": 2300.0}
        prev = {"hours": 80 * 60, "ot": 0, "leave": 0, "pay": 1600.0}
        rows = {v["metric"]: v for v in pr.variance(cur, prev, 80 * 60, CFG)}
        self.assertTrue(rows["hours"]["flag"])
        self.assertEqual(rows["hours"]["reason"], "Hours 100.0h vs. 80.0h last period (+25%)")
        self.assertTrue(rows["ot"]["flag"])
        self.assertEqual(rows["ot"]["reason"], "Overtime 20.0h vs. 0.0h last period (+20.0h)")
        self.assertFalse(rows["leave"]["flag"])
        self.assertTrue(rows["pay"]["flag"])
        self.assertEqual(rows["pay"]["reason"], "Gross pay $2,300.00 vs. $1,600.00 last period (+44%)")
        self.assertTrue(rows["scheduled"]["flag"])
        self.assertIn("expected from the schedule", rows["scheduled"]["reason"])
        # Nothing to compare with (a first period) = no previous-period lines.
        only = pr.variance(cur, {}, None, CFG, compare_prev=False)
        self.assertEqual(only, [])
        self.assertEqual(pr.money(1234.5, "INR"), "INR 1,234.50")

    def test_week_vs_average(self):
        hist = [40 * 60] * 8
        flags = pr.week_anomalies([("2026-09-06", 40 * 60), ("2026-09-13", 60 * 60)], hist, CFG)
        self.assertEqual([f["week"] for f in flags], ["2026-09-13"])
        self.assertEqual(flags[0]["reason"], "Week of 09/13/2026: 60.0h, far from the 8-week average of 40.0h (+50%)")
        self.assertEqual(pr.week_anomalies([("2026-09-13", 60 * 60)], [40 * 60] * 2, CFG), [])   # too little history
        self.assertEqual(len(pr.week_anomalies([("2026-09-13", 0)], [40 * 60] * 4, CFG)), 1)     # a week with nothing

    def test_ot_jump_and_missing_clock_outs(self):
        self.assertEqual(pr.ot_jump(9 * 60, 1 * 60, CFG)[0]["reason"], "Overtime up from 1.0h last period to 9.0h")
        self.assertEqual(pr.ot_jump(5 * 60, 1 * 60, CFG), [])     # +4h is not over 4
        exc = [{"date": "2026-09-07", "type": "missing_out"}, {"date": "2026-09-08", "type": "missing_out"},
               {"date": "2026-09-08", "type": "missing_break_end"}]
        self.assertEqual(pr.missing_outs(exc, CFG)[0]["reason"],
                         "2 missing clock-outs this period (09/07/2026, 09/08/2026)")
        self.assertEqual(pr.missing_outs(exc[:1], CFG), [])

    def test_review_states(self):
        base = {"periodOpen": False, "periodEnd": "2026-09-19", "hasHours": True, "rateSet": True}
        types = lambda f: [(x["type"], x["blocking"]) for x in pr.readiness_exceptions({**base, **f})]  # noqa: E731
        self.assertEqual(types({}), [("not_approved", True)])
        self.assertEqual(types({"reviewStatus": "with_employee"}), [("not_approved", True)])
        self.assertEqual(types({"reviewStatus": "signing"}), [("not_signed", True)])
        self.assertEqual(types({"reviewStatus": "approved"}), [("not_signed", True)])
        self.assertEqual(types({"reviewStatus": "completed"}), [])
        self.assertEqual(types({"finalized": True}), [])
        self.assertEqual(types({"periodOpen": True}), [("period_open", False)])
        self.assertEqual(types({"finalized": True, "rateSet": False, "pendingFixes": 2, "outOfFenceDays": 1}),
                         [("pending_fixes", True), ("no_rate", True), ("out_of_location", False)])
        # No hours = nothing to approve or price; a salaried person still needs a salary.
        self.assertEqual(types({"hasHours": False, "rateSet": False}), [])
        self.assertEqual(types({"hasHours": False, "fixed": True, "rateSet": False}), [("no_rate", True)])
        lbl = pr.readiness_exceptions({**base, "finalized": True, "pendingFixes": 1})[0]["label"]
        self.assertEqual(lbl, "1 punch fix waiting for a decision")

    def test_closed_month(self):
        self.assertEqual(pr.closed_month("2026-10-10"), ("2026-09-01", "2026-09-30"))
        self.assertEqual(pr.closed_month("2026-09-30"), ("2026-09-01", "2026-09-30"))
        s, e = timeclock._pay_period(pr.default_anchor(date(2026, 10, 17)))
        self.assertEqual((s, e), ("2026-09-20", "2026-10-03"))   # 10/04 - 10/17 is still running


class DbCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev_email = os.environ.get("NEXUS_DEV_EMAIL")
        self.db = database.SessionLocal()
        for m in (models.TimesheetReview, models.TimePunch, models.TimeApproval, models.NexusEmployee,
                  models.HrEntity, models.PayrollRate, models.PayrollRateHistory, models.NexusRole,
                  models.NexusSetting, models.PunchRequest, models.ScheduledShift, models.ShiftAssignment):
            self.db.query(m).delete()
        self.db.add_all([models.HrEntity(id=ENT, name="Greens PR One"), models.HrEntity(id=ENT2, name="Greens PR Two")])
        for email, mgr, company in ((ADMIN, "", ENT), (MGR, "", ENT), (EMP, MGR, ENT), (EMP2, MGR, ENT),
                                    (SAL, MGR, ENT), (OTHER, ADMIN, ENT2)):
            first = email.split(".")[0].title()
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Pr",
                                             company=company, manager_email=mgr, status="active", country="US",
                                             employment_type="full_time", start_date="2025-01-01"))
        self.db.add_all([models.NexusRole(email=ADMIN, role="administrator", assigned_by="t"),
                         models.NexusRole(email=MGR, role="manager", assigned_by="t")])
        self.db.add_all([models.PayrollRate(employee_email=EMP, pay_type="hourly", hourly_rate=20, overtime_rule="ca"),
                         models.PayrollRate(employee_email=OTHER, pay_type="hourly", hourly_rate=25, overtime_rule="ca"),
                         models.PayrollRate(employee_email=SAL, pay_type="fixed", monthly_salary=6000, currency="USD")])
        self.start, self.end = timeclock._pay_period(ANCHOR)
        self.s = date.fromisoformat(self.start)
        # Eight weeks of history and the previous period: 5 x 8h, Monday to Friday.
        for w in range(-8, 0):
            self._week(EMP, w, 8)
            self._week(OTHER, w, 8)
        # This period: an ordinary week, then 5 x 12h.
        self._week(EMP, 0, 8)
        self._week(EMP, 1, 12)
        self._week(OTHER, 0, 8)
        self._week(OTHER, 1, 8)
        # Emp2: two shifts that never clocked out, one whole one, no pay rate.
        d1, d2, d3 = (self.s + timedelta(days=i) for i in (1, 2, 3))
        self._punch(EMP2, d1, "in", 8)
        self._punch(EMP2, d2, "in", 8)
        self._punch(EMP2, d3, "in", 8)
        self._punch(EMP2, d3, "out", 16)
        self.db.commit()
        pr.clear_cache()
        auth._role_cache.clear()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._prev_email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev_email
        self.db.close()

    def _punch(self, email, day, kind, hour):
        ds = day.isoformat()
        at = f"{ds}T{hour:02d}:00:00"
        self.db.add(models.TimePunch(id=f"p-{email}-{ds}-{kind}-{hour}", employee_email=email, kind=kind, at=at,
                                     local_date=ds, tz_offset_min=0, created_at=at))

    def _week(self, email, w, hours):
        for i in range(1, 6):    # Monday..Friday of the Sunday week
            day = self.s + timedelta(days=7 * w + i)
            self._punch(email, day, "in", 8)
            self._punch(email, day, "out", 8 + hours)

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _report(self, scope=None):
        return {r["email"]: r for r in pr.build(self.db, scope, ANCHOR)["rows"]}


class ReportTests(DbCase):
    def test_figures_are_the_timecards(self):
        r = self._report()[EMP]
        card = timeclock._compute_timecard(self.db, EMP, self.start, self.end)["totals"]
        self.assertEqual(r["totals"]["hoursMin"], card["workedMin"])
        self.assertEqual(r["totals"]["otMin"], card["otMin"] + card["dtMin"])
        self.assertEqual(r["totals"]["grossPay"], card["totalPay"])
        self.assertEqual(r["totals"]["hoursMin"], 100 * 60)
        ps, pe = timeclock._pay_period((self.s - timedelta(days=1)).isoformat())
        prev = timeclock._compute_timecard(self.db, EMP, ps, pe)["totals"]
        self.assertEqual(r["totals"]["prevHoursMin"], prev["workedMin"])
        self.assertEqual(r["totals"]["prevGrossPay"], prev["totalPay"])

    def test_exceptions(self):
        rows = self._report()
        emp = {x["type"] for x in rows[EMP]["exceptions"]}
        self.assertEqual(emp, {"not_approved"})
        self.assertFalse(rows[EMP]["ready"])
        emp2 = {x["type"] for x in rows[EMP2]["exceptions"]}
        self.assertTrue({"not_approved", "missing_punches", "no_rate"} <= emp2, emp2)
        self.assertIn("missing_clock_outs", {a["type"] for a in rows[EMP2]["anomalies"]})
        # A first period with hours has nothing to compare with.
        self.assertFalse([v for v in rows[EMP2]["variance"] if v["against"] == "previous"])

    def test_signature_and_finalized(self):
        self.db.add(models.TimesheetReview(id="r1", employee_email=EMP, period_start=self.start,
                                           period_end=self.end, status="signing"))
        self.db.commit()
        self.assertEqual([x["type"] for x in self._report()[EMP]["exceptions"]], ["not_signed"])
        self.db.query(models.TimesheetReview).update({"status": "completed"})
        self.db.commit()
        pr.clear_cache()
        r = self._report()[EMP]
        self.assertEqual(r["exceptions"], [])
        self.assertTrue(r["ready"])

    def test_variance_and_anomalies(self):
        r = self._report()[EMP]
        flagged = {v["metric"] for v in r["variance"] if v["flag"]}
        self.assertTrue({"hours", "ot", "pay"} <= flagged, flagged)
        sched = [v for v in r["variance"] if v["metric"] == "scheduled"]
        self.assertEqual(sched[0]["reference"], 80 * 60)       # US standard day, ten weekdays
        kinds = [a["type"] for a in r["anomalies"]]
        self.assertIn("ot_jump", kinds)
        weeks = [a["week"] for a in r["anomalies"] if a["type"] == "week_vs_average"]
        self.assertEqual(weeks, [(self.s + timedelta(days=7)).isoformat()])
        # A steady person raises nothing.
        o = self._report()[OTHER]
        self.assertEqual(o["anomalies"], [])
        self.assertEqual([v for v in o["variance"] if v["flag"]], [])

    def test_salaried_use_their_month(self):
        r = self._report()[SAL]
        ms, me = pr.closed_month(self.end)
        self.assertEqual((r["payType"], r["periodStart"], r["periodEnd"]), ("fixed", ms, me))

    def test_company_threshold_override(self):
        pr.save_settings(self.db, ENT2, {"varianceHours": 1, "variancePct": 1}, ADMIN)
        self.assertEqual(pr.get_settings(self.db, ENT2)["varianceHours"], 1)
        self.assertEqual(pr.get_settings(self.db, ENT)["varianceHours"], 8)
        # OTHER (ENT2) worked 80h vs 80h - still nothing; widen the gap by an hour.
        self._punch(OTHER, self.s + timedelta(days=6), "in", 8)
        self._punch(OTHER, self.s + timedelta(days=6), "out", 10)
        self.db.commit()
        o = self._report()[OTHER]
        self.assertIn("hours", {v["metric"] for v in o["variance"] if v["flag"]})
        # The override is sparse: a key equal to the tenant's is not stored.
        pr.save_settings(self.db, ENT2, {"anomalyHours": 10}, ADMIN)
        self.assertNotIn("anomalyHours", pr._saved(self.db, ENT2))
        pr.save_settings(self.db, ENT2, {}, ADMIN, reset=True)
        self.assertFalse(pr.has_override(self.db, ENT2))
        self.assertEqual(pr.clean({"variancePct": "900", "x": 1, "anomalyHours": "nope"}), {"variancePct": 500})


class RouteTests(DbCase):
    def test_admin_sees_everyone_with_pay(self):
        self._as(ADMIN)
        res = self.client.get(f"/payroll-readiness/report?start={ANCHOR}")
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        emails = {r["email"] for r in body["rows"]}
        self.assertTrue({EMP, EMP2, OTHER, SAL} <= emails, emails)
        self.assertFalse(body["payHidden"])
        self.assertIn("grossPay", next(r for r in body["rows"] if r["email"] == EMP)["totals"])
        self.assertEqual(body["summary"]["people"], len(body["rows"]))

    def test_manager_sees_team_hours_only(self):
        self._as(MGR)
        res = self.client.get(f"/payroll-readiness/report?start={ANCHOR}")
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        emails = {r["email"] for r in body["rows"]}
        self.assertNotIn(OTHER, emails)
        self.assertIn(EMP, emails)
        self.assertTrue(body["payHidden"])
        for r in body["rows"]:
            self.assertNotIn("grossPay", r["totals"])
            self.assertNotIn("pay", {v["metric"] for v in r["variance"]})
            self.assertNotIn("$", " ".join(v["reason"] for v in r["variance"]))

    def test_employee_is_refused(self):
        self._as(EMP)
        self.assertIn(self.client.get("/payroll-readiness/report").status_code, (401, 403))

    def test_bad_date(self):
        self._as(ADMIN)
        self.assertEqual(self.client.get("/payroll-readiness/report?start=10/01/2026").status_code, 400)

    def test_settings_are_hrs(self):
        self._as(MGR)
        s = self.client.get("/payroll-readiness/settings").json()
        self.assertFalse(s["canEdit"])
        self.assertEqual(s["settings"]["variancePct"], 25)
        r = self.client.put("/payroll-readiness/settings", json={"settings": {"variancePct": 30}})
        self.assertEqual(r.status_code, 403, r.text)
        self._as(ADMIN)
        s = self.client.get("/payroll-readiness/settings").json()
        self.assertTrue(s["canEdit"] and s["canEditDefault"])
        r = self.client.put("/payroll-readiness/settings", json={"company": ENT, "settings": {"variancePct": 30}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["settings"]["variancePct"], 30)
        self.assertTrue(r.json()["override"])
        self.assertEqual(self.client.put("/payroll-readiness/settings",
                                         json={"company": "nope", "settings": {}}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
