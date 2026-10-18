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
  - One long timecard per hourly person, split by payroll week, gives the
    same figures as the standalone period cards (CA daily / weekly / 7th-day
    overtime, an overnight shift across the period line, a mid-period raise,
    sick time, a paid holiday); a finalized period whose frozen rate differs
    gets its own card. The bulk status reads equal the one-person helpers.
  - The export's warning judges what the export carries: hourly people on
    every pay period overlapping its dates, salaried people on its month.
  - Cost: the query count for 100 people, before (the first cut) and after.

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
                  models.NexusSetting, models.PunchRequest, models.ScheduledShift, models.ShiftAssignment,
                  models.HrCompanyHoliday):
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


class SplitTests(DbCase):
    """The long card's split must equal the standalone period cards."""
    HARD = "hard.pr@greensglobal.com"

    def _hard_case(self):
        self.db.add(models.NexusEmployee(id="id-hard", work_email=self.HARD, first_name="Hard", last_name="Pr",
                                         company=ENT, manager_email=MGR, status="active", country="US",
                                         employment_type="full_time", start_date="2025-01-01"))
        self.db.add(models.PayrollRate(employee_email=self.HARD, pay_type="hourly", hourly_rate=26, overtime_rule="ca"))
        ps = self.s - timedelta(days=14)
        # Rate history: 20 until the 4th day of this period, then 26.
        self.db.add_all([models.PayrollRateHistory(id="h1", employee_email=self.HARD, effective_date="",
                                                   pay_type="hourly", hourly_rate=20, overtime_rule="ca"),
                         models.PayrollRateHistory(id="h2", employee_email=self.HARD,
                                                   effective_date=(self.s + timedelta(days=3)).isoformat(),
                                                   pay_type="hourly", hourly_rate=26, overtime_rule="ca")])
        hol = ps + timedelta(days=5)
        for w in range(-8, 2):
            # Seven days in a row, 9h each: daily OT, weekly OT over 40, the 7th day.
            for i in range(7):
                day = self.s + timedelta(days=7 * w + i)
                if day == hol:
                    continue
                self._punch(self.HARD, day, "in", 7)
                self._punch(self.HARD, day, "out", 16)
        # An overnight shift from the previous period's last evening into this period.
        last = self.s - timedelta(days=1)
        self._punch(self.HARD, last, "in", 17)
        self.db.add(models.TimePunch(id="p-hard-overnight-out", employee_email=self.HARD, kind="out",
                                     at=f"{self.s.isoformat()}T02:00:00", local_date=self.s.isoformat(),
                                     tz_offset_min=0, created_at=f"{self.s.isoformat()}T02:00:00"))
        # A sick block this period, and a paid holiday nobody worked last period.
        sick = (self.s + timedelta(days=9)).isoformat()
        self.db.add_all([models.TimePunch(id="p-hard-sick-in", employee_email=self.HARD, kind="in",
                                          at=f"{sick}T17:00:00", local_date=sick, tz_offset_min=0,
                                          created_at=f"{sick}T17:00:00", category="Sick"),
                         models.TimePunch(id="p-hard-sick-out", employee_email=self.HARD, kind="out",
                                          at=f"{sick}T20:00:00", local_date=sick, tz_offset_min=0,
                                          created_at=f"{sick}T20:00:00")])
        self.db.add(models.HrCompanyHoliday(id="hol-1", company_id=ENT, date=hol.isoformat(), name="Test Day",
                                            type="mandatory"))
        self.db.commit()
        return ps.isoformat(), last.isoformat()

    def test_split_equals_standalone_cards(self):
        ps, pe = self._hard_case()
        hist = (self.s - timedelta(days=56)).isoformat()
        long_card = timeclock._compute_timecard(self.db, self.HARD, hist, self.end)
        for a, b in ((self.start, self.end), (ps, pe)):
            alone = pr._figures(timeclock._compute_timecard(self.db, self.HARD, a, b))
            self.assertEqual(pr.split_figures(long_card, a, b), alone, (a, b))
            self.assertGreater(alone["ot"], 0)
        prev_alone = timeclock._compute_timecard(self.db, self.HARD, ps, pe)["totals"]
        self.assertGreater(prev_alone["holidayPay"], 0)
        cur_alone = timeclock._compute_timecard(self.db, self.HARD, self.start, self.end)
        self.assertGreater(cur_alone["totals"]["sickMin"], 0)
        self.assertGreater(len(cur_alone["rateSplits"]), 1)          # the raise lands inside the period
        # And the report carries exactly those.
        r = self._report()[self.HARD]
        self.assertEqual((r["totals"]["hoursMin"], r["totals"]["grossPay"]),
                         (cur_alone["totals"]["workedMin"], cur_alone["totals"]["totalPay"]))
        self.assertEqual(r["totals"]["prevGrossPay"], prev_alone["totalPay"])

    def test_a_finalized_period_keeps_its_frozen_rate(self):
        ps = (self.s - timedelta(days=14)).isoformat()
        pe = (self.s - timedelta(days=1)).isoformat()
        self.db.add(models.TimeApproval(id="fin-1", employee_email=EMP, period_start=ps, period_end=pe,
                                        kind="final", revoked=0, approved_by=ADMIN,
                                        approved_at="2026-01-01T00:00:00", note='{"rate": 31.0, "rule": "ca"}'))
        self.db.commit()
        pinned = timeclock._compute_timecard(self.db, EMP, ps, pe)["totals"]["totalPay"]
        hist = (self.s - timedelta(days=56)).isoformat()
        unpinned = pr.split_figures(timeclock._compute_timecard(self.db, EMP, hist, self.end), ps, pe)["pay"]
        self.assertNotEqual(pinned, unpinned)
        self.assertEqual(self._report()[EMP]["totals"]["prevGrossPay"], pinned)

    def test_bulk_status_equals_the_one_person_helpers(self):
        import timesheet_review as tsr
        d = (self.s + timedelta(days=2)).isoformat()
        self.db.add(models.PunchRequest(id="pr-1", employee_email=EMP, status="pending", action="add",
                                        punch_kind="out", at=f"{d}T20:00:00", local_date=d))
        self.db.query(models.TimePunch).filter(models.TimePunch.id == f"p-{EMP2}-{d}-in-8").update(
            {"edit_status": "pending", "pending_at": f"{d}T09:00:00"})
        self.db.add_all([models.TimesheetReview(id="rv-1", employee_email=EMP, period_start=self.start,
                                                period_end=self.end, status="with_manager", created_at="2026-01-01"),
                         models.TimesheetReview(id="rv-2", employee_email=EMP, period_start=self.start,
                                                period_end=self.end, status="signing", created_at="2026-01-02"),
                         models.TimeApproval(id="fin-2", employee_email=OTHER, period_start=self.start,
                                             period_end=self.end, kind="final", revoked=0)])
        self.db.commit()
        people = [EMP, EMP2, OTHER, SAL]
        b = pr._bulk_status(self.db, people, self.start, self.end)
        for em in people:
            rv = tsr.active_review(self.db, em, self.start)
            self.assertEqual(b["review"].get(em, ""), rv.status if rv else "", em)
            self.assertEqual(em in b["final"], bool(timeclock._finalized_row(self.db, em, self.start, self.end)), em)
            self.assertEqual(b["fixes"].get(em, 0), timeclock._pending_fixes(self.db, em, self.start, self.end), em)
        self.assertEqual(b["fixes"], {EMP: 1, EMP2: 1})


class ExportCheckTests(DbCase):
    def test_periods_an_export_carries(self):
        X = pr.export_periods("2026-10-01", "2026-10-31")
        self.assertEqual(X["hourly"], [("2026-09-20", "2026-10-03"), ("2026-10-04", "2026-10-17"),
                                       ("2026-10-18", "2026-10-31")])
        self.assertEqual((X["monthStart"], X["monthEnd"]), ("2026-10-01", "2026-10-31"))
        self.assertEqual(pr.export_periods("2026-09-20", "2026-10-03")["hourly"], [("2026-09-20", "2026-10-03")])

    def test_a_salaried_month_export_judges_salaried_people_on_that_month(self):
        ms, me = timeclock._month_bounds(self.start)
        self.db.add(models.TimeApproval(id="fin-s", employee_email=SAL, period_start=ms, period_end=me,
                                        kind="final", revoked=0))
        self._punch(SAL, date.fromisoformat(ms) + timedelta(days=1), "in", 9)
        self._punch(SAL, date.fromisoformat(ms) + timedelta(days=1), "out", 17)
        self.db.commit()
        rows = pr.check_export(self.db, None, ms, me)["rows"]
        self.assertEqual([(r["periodStart"], r["periodEnd"], r["ready"]) for r in rows if r["email"] == SAL],
                         [(ms, me, True)])
        # Hourly people: every pay period the month touches that they worked in.
        hourly = {p for p, _e in pr.export_periods(ms, me)["hourly"]}
        emp = {r["periodStart"] for r in rows if r["email"] == EMP}
        self.assertTrue(emp and emp <= hourly, emp)
        self.assertTrue(all(not r["ready"] for r in rows if r["email"] == EMP))
        self.assertFalse(any(r["variance"] or r["anomalies"] for r in rows))
        # A bi-weekly export judges that one period for hourly people.
        two = pr.check_export(self.db, None, self.start, self.end)["rows"]
        self.assertEqual({(r["periodStart"], r["periodEnd"]) for r in two if r["payType"] == "hourly"},
                         {(self.start, self.end)})

    def test_route(self):
        self._as(MGR)
        res = self.client.get(f"/payroll-readiness/export-check?start={self.start}&end={self.end}")
        self.assertEqual(res.status_code, 200, res.text)
        emails = {r["email"] for r in res.json()["rows"]}
        self.assertIn(EMP, emails)
        self.assertNotIn(OTHER, emails)
        self.assertEqual(self.client.get(
            f"/payroll-readiness/export-check?start={self.end}&end={self.start}").status_code, 400)
        self.assertEqual(self.client.get(
            "/payroll-readiness/export-check?start=2026-01-01&end=2026-06-01").status_code, 400)


# The first cut (a3fec758) ran 5,161 queries for the report over this same
# seed: 100 hourly people, ten weeks of punches each (about 51 a person).
QUERIES_BEFORE = 5161


class CostTests(DbCase):
    def test_hundred_people_query_budget(self):
        import time as _time
        from sqlalchemy import event
        self.db.query(models.TimePunch).delete()
        self.db.query(models.NexusEmployee).delete()
        self.db.query(models.PayrollRate).delete()
        for n in range(100):
            em = f"load{n}.pr@greensglobal.com"
            self.db.add(models.NexusEmployee(id=f"id-load{n}", work_email=em, first_name=f"Load{n}", last_name="Pr",
                                             status="active", country="US", start_date="2025-01-01"))
            self.db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20))
            for w in range(-8, 2):
                for i in range(1, 6):
                    day = self.s + timedelta(days=7 * w + i)
                    self._punch(em, day, "in", 8)
                    self._punch(em, day, "out", 16 + n % 3)
        self.db.commit()
        count = [0]

        def tick(*_a, **_k):
            count[0] += 1
        event.listen(database.engine, "before_cursor_execute", tick)
        try:
            t0 = _time.monotonic()
            rows = pr.build(self.db, None, ANCHOR)["rows"]
            took = _time.monotonic() - t0
        finally:
            event.remove(database.engine, "before_cursor_execute", tick)
        self.assertEqual(len(rows), 100)
        print(f"\n[payroll readiness] {len(rows)} people: {count[0]} queries in {took:.2f}s "
              f"(first cut: {QUERIES_BEFORE})")
        self.assertLess(count[0], QUERIES_BEFORE // 2)


if __name__ == "__main__":
    unittest.main()
