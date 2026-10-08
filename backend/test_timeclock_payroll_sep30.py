"""Payroll rules from the Charmi call of 09/30/2026 (Part A, items A3-A6).

    A3  pay history priced per day: payroll_rate_history + _rate_on, hourly and
        fixed cards price each day at the rate in effect that day, a period
        with two rates reports the split
    A4  India daily rate = monthly x 12 / working days in that calendar year
        (days minus Saturdays and Sundays; holidays stay in the denominator)
    A5  weekend pay = max(floor, 1.35 x daily x min(hours, full) / full),
        floor Rs 500 in INR, 0 otherwise - never a typed amount
    A6  attendance bands: full day >= full_day_hours - 60 min, half day >= 4 h,
        absent below 4 h
    + the Pay & Benefits save path appends history rows and carries the OT
      rule / full-day hours / exemption onto PayrollRate

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_timeclock_payroll_sep30.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import main  # noqa: E402,F401 - app import wires the DB
import models  # noqa: E402
from routers import hr  # noqa: E402
from routers.timeclock import (_attendance_bands, _compute_timecard, _fixed_card, _rate_on,  # noqa: E402
                               _weekend_pay, _working_days_in_year)

models.Base.metadata.create_all(bind=database.engine)

HOURLY = "sep30.hourly@greensglobal.com"
FIXED = "sep30.fixed@greensglobal.com"
ENTITY_IN, ENTITY_US = "ent-sep30-in", "ent-sep30-us"


def _wipe():
    db = database.SessionLocal()
    try:
        for em in (HOURLY, FIXED):
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email == em).delete(synchronize_session=False))
            for m in (models.PayrollRate, models.PayrollRateHistory, models.TimePunch, models.TimeApproval):
                db.query(m).filter(m.employee_email == em).delete(synchronize_session=False)
        db.query(models.HrEntity).filter(models.HrEntity.id.in_([ENTITY_IN, ENTITY_US])).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _punch(db, em, day, hours, start_h=4, i=0):
    """One in/out pair on `day` (UTC times; tz_offset 0 so local date = day)."""
    db.add(models.TimePunch(id=f"{em}-{day}-{i}-in", employee_email=em, kind="in",
                            at=f"{day}T{start_h:02d}:00:00", local_date=day, tz_offset_min=0,
                            voided=0, created_at=f"{day}T{start_h:02d}:00:00"))
    end_min = int(round((start_h + hours) * 60))
    db.add(models.TimePunch(id=f"{em}-{day}-{i}-out", employee_email=em, kind="out",
                            at=f"{day}T{end_min // 60:02d}:{end_min % 60:02d}:00", local_date=day,
                            tz_offset_min=0, voided=0, created_at=f"{day}T{end_min // 60:02d}:{end_min % 60:02d}:00"))


class FormulaTests(unittest.TestCase):
    def test_working_days_in_year(self):
        # 2026 starts on a Thursday: 52 weeks + 1 weekday -> 261 (104 weekend days)
        self.assertEqual(_working_days_in_year(2026), 261)
        self.assertEqual(_working_days_in_year(2027), 261)   # starts Friday
        self.assertEqual(_working_days_in_year(2028), 260)   # leap, starts Saturday
        self.assertEqual(_working_days_in_year(2024), 262)   # leap, starts Monday

    def test_weekend_pay_pro_rata_and_floor(self):
        daily = 1000.0
        self.assertEqual(_weekend_pay(daily, 8 * 60, 8, "INR"), 1350.0)       # full day: 1.35 x daily
        self.assertEqual(_weekend_pay(daily, 4 * 60, 8, "INR"), 675.0)        # half the hours, half the pay
        self.assertEqual(_weekend_pay(daily, 2 * 60, 8, "INR"), 500.0)        # 337.50 lifts to the Rs 500 floor
        self.assertEqual(_weekend_pay(daily, 2 * 60, 8, "USD"), 337.5)        # no floor outside INR
        self.assertEqual(_weekend_pay(daily, 10 * 60, 8, "INR"), 1350.0)      # capped at a full day
        self.assertEqual(_weekend_pay(daily, 0, 8, "INR"), 500.0)             # open punch: the floor
        self.assertEqual(_weekend_pay(daily, 0, 8, "USD"), 0.0)

    def test_attendance_bands(self):
        self.assertEqual(_attendance_bands(8), (7 * 60, 4 * 60))
        self.assertEqual(_attendance_bands(9), (8 * 60, 4 * 60))
        self.assertEqual(_attendance_bands(4), (3 * 60, 3 * 60))   # half never above full


class FixedCardTests(unittest.TestCase):
    """September 2026 (fully elapsed) for a Rs 30,000 / month employee."""
    SALARY = 30000.0

    def setUp(self):
        _wipe()
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id=f"emp-{FIXED}", first_name="Priya", last_name="Test",
                                        work_email=FIXED, company="", status="active", deleted_at=""))
            db.add(models.PayrollRate(employee_email=FIXED, pay_type="fixed", currency="INR",
                                      monthly_salary=self.SALARY, full_day_hours=8, overtime_rule="none",
                                      weekend_ot_amount=1000))   # typed amount must be IGNORED
            _punch(db, FIXED, "2026-09-01", 7.25)   # Tue: 7h15 >= 7h -> full day
            _punch(db, FIXED, "2026-09-02", 6.5)    # Wed: 6h30 -> half day
            _punch(db, FIXED, "2026-09-03", 3.5)    # Thu: 3h30 -> absent
            _punch(db, FIXED, "2026-09-05", 4)      # Sat: 4h weekend
            _punch(db, FIXED, "2026-09-06", 1)      # Sun: 1h weekend -> floor
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        _wipe()

    def test_daily_rate_bands_and_weekend_pay(self):
        db = database.SessionLocal()
        try:
            card = _fixed_card(db, FIXED, "2026-09-15")
        finally:
            db.close()
        daily = self.SALARY * 12 / 261
        self.assertEqual(card["workingDaysInYear"], 261)
        self.assertAlmostEqual(card["dailyRate"], round(daily, 2), places=2)
        self.assertEqual(card["bands"], {"fullMin": 420, "halfMin": 240})
        self.assertEqual(card["weekendFloor"], 500.0)
        self.assertEqual(card["weekendMultiplier"], 1.35)
        self.assertNotIn("weekendOtAmount", card)
        st = {d["date"]: d for d in card["fixedDays"]}
        self.assertEqual(st["2026-09-01"]["status"], "present")
        self.assertEqual(st["2026-09-02"]["status"], "half")
        self.assertEqual(st["2026-09-03"]["status"], "absent")
        self.assertEqual(st["2026-09-04"]["status"], "absent")   # no punches, day elapsed
        self.assertEqual(st["2026-09-05"]["status"], "weekend_worked")
        self.assertAlmostEqual(st["2026-09-05"]["bonus"], round(1.35 * daily * 4 / 8, 2), places=2)
        self.assertEqual(st["2026-09-06"]["bonus"], 500.0)   # 1h -> 232 lifts to the floor
        self.assertEqual(st["2026-09-12"]["status"], "weekend")
        T = card["totals"]
        self.assertEqual(T["weekendDaysWorked"], 2)
        self.assertAlmostEqual(T["weekendBonus"], round(1.35 * daily * 4 / 8, 2) + 500.0, places=2)
        absent = sum(1 for d in card["fixedDays"] if d["status"] == "absent")
        half = sum(1 for d in card["fixedDays"] if d["status"] == "half")
        self.assertEqual(half, 1)
        self.assertAlmostEqual(T["deduction"], round(absent * daily + half * daily / 2, 2), places=1)
        self.assertAlmostEqual(T["salaryForPeriod"], self.SALARY, places=2)
        self.assertAlmostEqual(T["totalPay"], round(T["salaryForPeriod"] - T["deduction"] + T["weekendBonus"], 2), places=2)
        self.assertEqual(card["rateSplits"], [])

    def test_mid_month_raise_prices_each_day(self):
        db = database.SessionLocal()
        try:
            db.add(models.PayrollRateHistory(id="h-f-1", employee_email=FIXED, effective_date="",
                                             pay_type="fixed", monthly_salary=30000, currency="INR", overtime_rule="none"))
            db.add(models.PayrollRateHistory(id="h-f-2", employee_email=FIXED, effective_date="2026-09-16",
                                             pay_type="fixed", monthly_salary=36000, currency="INR", overtime_rule="none"))
            rr = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == FIXED).first()
            rr.monthly_salary = 36000
            db.commit()
            card = _fixed_card(db, FIXED, "2026-09-15")
        finally:
            db.close()
        self.assertEqual(card["monthlySalary"], 36000.0)                       # in effect at month end
        self.assertAlmostEqual(card["salaryForPeriod"], 15 / 30 * 30000 + 15 / 30 * 36000, places=2)
        self.assertEqual([(s["from"], s["through"], s["monthlySalary"]) for s in card["rateSplits"]],
                         [("2026-09-01", "2026-09-15", 30000.0), ("2026-09-16", "2026-09-30", 36000.0)])
        st = {d["date"]: d for d in card["fixedDays"]}
        self.assertAlmostEqual(st["2026-09-03"]["deduct"], round(30000 * 12 / 261, 2), places=2)   # old rate
        self.assertAlmostEqual(st["2026-09-17"]["deduct"], round(36000 * 12 / 261, 2), places=2)   # new rate


class HourlyPerDayPricingTests(unittest.TestCase):
    START, END = "2026-09-06", "2026-09-19"

    def setUp(self):
        _wipe()
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id=f"emp-{HOURLY}", first_name="Hal", last_name="Test",
                                        work_email=HOURLY, company="", status="active", deleted_at=""))
            db.add(models.PayrollRate(employee_email=HOURLY, pay_type="hourly", hourly_rate=25, overtime_rule="ca"))
            _punch(db, HOURLY, "2026-09-07", 8)   # Mon, old rate
            _punch(db, HOURLY, "2026-09-10", 8)   # Thu, new rate
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        _wipe()

    def test_no_history_means_current_rate_since_always(self):
        db = database.SessionLocal()
        try:
            self.assertEqual(_rate_on(db, HOURLY, "2020-01-01")["hourlyRate"], 25.0)
            card = _compute_timecard(db, HOURLY, self.START, self.END)
        finally:
            db.close()
        self.assertEqual(card["totals"]["regPay"], 16 * 25.0)
        self.assertEqual(card["rateSplits"], [])

    def test_raise_applies_from_its_effective_date(self):
        db = database.SessionLocal()
        try:
            db.add(models.PayrollRateHistory(id="h-h-1", employee_email=HOURLY, effective_date="",
                                             pay_type="hourly", hourly_rate=20, currency="USD", overtime_rule="ca"))
            db.add(models.PayrollRateHistory(id="h-h-2", employee_email=HOURLY, effective_date="2026-09-09",
                                             pay_type="hourly", hourly_rate=25, currency="USD", overtime_rule="ca"))
            db.commit()
            self.assertEqual(_rate_on(db, HOURLY, "2026-09-08")["hourlyRate"], 20.0)
            self.assertEqual(_rate_on(db, HOURLY, "2026-09-09")["hourlyRate"], 25.0)
            card = _compute_timecard(db, HOURLY, self.START, self.END)
        finally:
            db.close()
        self.assertEqual(card["rate"], 25.0)   # headline = in effect on the period's last day
        self.assertEqual(card["totals"]["regPay"], 8 * 20.0 + 8 * 25.0)
        by = {d["date"]: d for d in card["days"]}
        self.assertEqual(by["2026-09-07"]["rate"], 20.0)
        self.assertEqual(by["2026-09-07"]["segments"][0]["amount"], 160.0)
        self.assertEqual(by["2026-09-10"]["segments"][0]["amount"], 200.0)
        self.assertEqual([(s["from"], s["through"], s["rate"]) for s in card["rateSplits"]],
                         [("2026-09-06", "2026-09-08", 20.0), ("2026-09-09", "2026-09-19", 25.0)])

    def test_finalized_snapshot_stays_authoritative(self):
        import json
        db = database.SessionLocal()
        try:
            db.add(models.PayrollRateHistory(id="h-h-3", employee_email=HOURLY, effective_date="2026-09-09",
                                             pay_type="hourly", hourly_rate=25, currency="USD", overtime_rule="ca"))
            db.add(models.TimeApproval(id="fin-sep30", employee_email=HOURLY, period_start=self.START,
                                       period_end=self.END, worked_min=960, approved_by="hr@x", approved_at="2026-09-20T00:00:00",
                                       kind="final", note=json.dumps({"rate": 18.0, "rule": "ca"})))
            db.commit()
            card = _compute_timecard(db, HOURLY, self.START, self.END)
        finally:
            db.close()
        self.assertEqual(card["rate"], 18.0)
        self.assertEqual(card["totals"]["regPay"], 16 * 18.0)
        self.assertEqual(card["rateSplits"], [])


class CompensationSaveTests(unittest.TestCase):
    """The Pay & Benefits save path (hr.py): PayrollRate is derived, history is appended."""

    def setUp(self):
        _wipe()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=ENTITY_IN, name="Greens India", country="IN"))
            db.add(models.HrEntity(id=ENTITY_US, name="Greens US", country="US"))
            db.add(models.NexusEmployee(id=f"emp-{FIXED}", first_name="Priya", last_name="Test",
                                        work_email=FIXED, company=ENTITY_IN, status="active", deleted_at=""))
            db.add(models.NexusEmployee(id=f"emp-{HOURLY}", first_name="Hal", last_name="Test",
                                        work_email=HOURLY, company=ENTITY_US, status="active", deleted_at=""))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        _wipe()

    def _save(self, db, em, comp, by="hr.sep30@greensglobal.com"):
        emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == em).first()
        emp.compensation = comp
        hr.ensure_rate_history(db, em, by=by)
        hr.sync_rate_from_comp(db, emp)
        db.flush()
        hr.append_rate_history(db, emp, comp.get("effectiveDate", ""), by=by)
        db.commit()
        return emp

    def test_default_overtime_rule_follows_company_country(self):
        db = database.SessionLocal()
        try:
            emp_in = self._save(db, FIXED, {"base": 30000, "payBasis": "salary", "frequency": "monthly", "currency": "INR"})
            emp_us = self._save(db, HOURLY, {"base": 25, "payBasis": "hourly", "currency": "USD"})
            r_in = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == FIXED).first()
            r_us = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == HOURLY).first()
            self.assertEqual(r_in.overtime_rule, "none")
            self.assertEqual(r_us.overtime_rule, "ca")
            self.assertEqual(hr.payroll_fields(db, emp_in)["defaultOvertimeRule"], "none")
            self.assertEqual(hr.payroll_fields(db, emp_us)["overtimeRule"], "ca")
            # An explicit choice wins; the timecard-only fields ride along. A
            # stale timeTrackingExempt is ignored - the exemption is set on the
            # role in Settings > Access since Oct 2.
            self._save(db, HOURLY, {"base": 25, "payBasis": "hourly", "currency": "USD",
                                    "overtimeRule": "federal", "fullDayHours": 9, "timeTrackingExempt": True})
            r_us = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == HOURLY).first()
            self.assertEqual((r_us.overtime_rule, r_us.full_day_hours, r_us.time_tracking_exempt or 0), ("federal", 9.0, 0))
            self.assertFalse(hr.payroll_fields(db, emp_us)["timeTrackingExempt"])
        finally:
            db.close()

    def test_history_rows_on_save(self):
        db = database.SessionLocal()
        try:
            # First record: no effective date -> one "since always" row.
            emp = self._save(db, HOURLY, {"base": 20, "payBasis": "hourly", "currency": "USD"})
            rows = hr._rate_history_rows(db, HOURLY)
            self.assertEqual([(r.effective_date, r.hourly_rate) for r in rows], [("", 20.0)])
            # A raise effective 10/15: the prior rate stays as the '' row, the new one is dated.
            self._save(db, HOURLY, {"base": 25, "payBasis": "hourly", "currency": "USD", "effectiveDate": "2026-10-15"})
            rows = hr._rate_history_rows(db, HOURLY)
            self.assertEqual([(r.effective_date, r.hourly_rate) for r in rows], [("", 20.0), ("2026-10-15", 25.0)])
            self.assertEqual(rows[-1].created_by, "hr.sep30@greensglobal.com")
            # Saving the same effective date again corrects that row, no new period.
            self._save(db, HOURLY, {"base": 26, "payBasis": "hourly", "currency": "USD", "effectiveDate": "2026-10-15"})
            rows = hr._rate_history_rows(db, HOURLY)
            self.assertEqual([(r.effective_date, r.hourly_rate) for r in rows], [("", 20.0), ("2026-10-15", 26.0)])
            # Benefits-only save (pay unchanged): nothing appended.
            self._save(db, HOURLY, {"base": 26, "payBasis": "hourly", "currency": "USD", "effectiveDate": "2026-11-01"})
            self.assertEqual(len(hr._rate_history_rows(db, HOURLY)), 2)
            # The timecard reads the row in effect that day.
            self.assertEqual(_rate_on(db, HOURLY, "2026-10-14")["hourlyRate"], 20.0)
            self.assertEqual(_rate_on(db, HOURLY, "2026-10-15")["hourlyRate"], 26.0)
            # History out: newest first, with who changed it.
            out = hr.rate_history_out(db, emp)
            self.assertEqual([(h["effectiveDate"], h["base"], h["payBasis"]) for h in out],
                             [("2026-10-15", 26.0, "hourly"), ("", 20.0, "hourly")])
            self.assertEqual(out[0]["changedBy"], "hr.sep30@greensglobal.com")
        finally:
            db.close()

    def test_backfill_from_existing_rate_without_history(self):
        db = database.SessionLocal()
        try:
            # A person from before Sep 30: a PayrollRate exists, no history.
            db.add(models.PayrollRate(employee_email=FIXED, pay_type="fixed", currency="INR", monthly_salary=30000))
            db.commit()
            emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == FIXED).first()
            self.assertEqual(hr.rate_history_out(db, emp)[0]["base"], 30000.0)   # shown as "since always"
            self._save(db, FIXED, {"base": 36000, "payBasis": "salary", "frequency": "monthly", "currency": "INR",
                                   "effectiveDate": "2026-10-15"})
            rows = hr._rate_history_rows(db, FIXED)
            self.assertEqual([(r.effective_date, r.monthly_salary) for r in rows], [("", 30000.0), ("2026-10-15", 36000.0)])
            self.assertEqual(_rate_on(db, FIXED, "2026-10-01")["monthlySalary"], 30000.0)
            self.assertEqual(_rate_on(db, FIXED, "2026-10-31")["monthlySalary"], 36000.0)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
