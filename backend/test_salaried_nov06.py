"""Salaried Time Sheet fixes from the Charmi call of 11/06/2026.

    1 / 3  weekend pay (1.35 x daily by hours) is India only - a US salaried
           weekend day shows its hours and earns nothing extra
    2      a salary paid BI-WEEKLY (Pay & Benefits' Pay Frequency) gets the
           14-day pay period, not the month, from 11/01/2026; contractors and
           monthly salaries keep the month; saving the inline Payroll wage
           keeps the frequency

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_salaried_nov06.py -q
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
import timesheet_review  # noqa: E402
from routers.hr import sync_comp_from_rate  # noqa: E402
from routers.timeclock import _fixed_card, _period_of  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

US = "nov06.us@greensglobal.com"
IN = "nov06.in@greensglobal.com"
BIW = "nov06.biweekly@greensglobal.com"
CON = "nov06.contractor@greensglobal.com"
EVERYONE = (US, IN, BIW, CON)
SALARY = 6000.0


def _punch(db, em, day, hours, start_h=4):
    end_min = int(round((start_h + hours) * 60))
    for kind, at in (("in", f"{day}T{start_h:02d}:00:00"), ("out", f"{day}T{end_min // 60:02d}:{end_min % 60:02d}:00")):
        db.add(models.TimePunch(id=f"{em}-{day}-{kind}", employee_email=em, kind=kind, at=at, local_date=day,
                                tz_offset_min=0, voided=0, created_at=at))


def _person(db, em, *, country, currency, frequency="monthly", employment_type="employee"):
    db.add(models.NexusEmployee(id=f"emp-{em}", first_name="Test", last_name=em.split("@")[0], work_email=em,
                                company="", status="active", deleted_at="", country=country,
                                employment_type=employment_type,
                                compensation={"payBasis": "salary", "frequency": frequency, "base": SALARY,
                                              "currency": currency}))
    db.add(models.PayrollRate(employee_email=em, pay_type="fixed", currency=currency, monthly_salary=SALARY,
                              full_day_hours=8, overtime_rule="none"))


class SalariedNov06(unittest.TestCase):
    def setUp(self):
        db = database.SessionLocal()
        try:
            _person(db, US, country="US", currency="USD")
            _person(db, IN, country="IN", currency="INR")
            _person(db, BIW, country="US", currency="USD", frequency="biweekly")
            _person(db, CON, country="US", currency="USD", frequency="biweekly", employment_type="contractor")
            for em in (US, IN):
                _punch(db, em, "2026-09-05", 4)   # a Saturday
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        db = database.SessionLocal()
        try:
            for em in EVERYONE:
                (db.query(models.NexusEmployee).execution_options(include_deleted=True)
                   .filter(models.NexusEmployee.work_email == em).delete(synchronize_session=False))
                for m in (models.PayrollRate, models.PayrollRateHistory, models.TimePunch):
                    db.query(m).filter(m.employee_email == em).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _card(self, em, anchor):
        db = database.SessionLocal()
        try:
            return _fixed_card(db, em, anchor)
        finally:
            db.close()

    # ── 1 / 3: weekend pay is India only ────────────────────────────────────
    def test_us_salaried_weekend_earns_nothing_extra(self):
        card = self._card(US, "2026-09-15")
        sat = {d["date"]: d for d in card["fixedDays"]}["2026-09-05"]
        self.assertEqual((sat["status"], sat["bonus"]), ("weekend_worked", 0.0))
        self.assertEqual(sat["workedMin"], 240)              # the hours still show
        self.assertEqual(card["totals"]["weekendBonus"], 0.0)
        self.assertIs(card["weekendPay"], False)

    def test_india_salaried_weekend_keeps_its_pay(self):
        card = self._card(IN, "2026-09-15")
        daily = SALARY * 12 / 261
        sat = {d["date"]: d for d in card["fixedDays"]}["2026-09-05"]
        self.assertAlmostEqual(sat["bonus"], max(500.0, round(1.35 * daily * 4 / 8, 2)), places=2)   # unchanged formula, Rs 500 floor
        self.assertIs(card["weekendPay"], True)

    # ── 2: bi-weekly salaried periods ───────────────────────────────────────
    def test_biweekly_salary_gets_the_pay_period(self):
        card = self._card(BIW, "2026-11-05")
        self.assertEqual((card["periodStart"], card["periodEnd"], card["periodKind"]),
                         ("2026-11-01", "2026-11-14", "biweekly"))
        self.assertEqual(len(card["fixedDays"]), 14)
        self.assertAlmostEqual(card["totals"]["salaryForPeriod"], round(SALARY * 12 / 26, 2), places=2)

    def test_biweekly_before_11_01_too(self):
        """Charmi, 11/06/2026: Valinda's 10/18 - 10/31 period is the payroll
        being run now - a bi-weekly salary is bi-weekly in October too."""
        card = self._card(BIW, "2026-10-20")
        self.assertEqual((card["periodStart"], card["periodEnd"], card["periodKind"]),
                         ("2026-10-18", "2026-10-31", "biweekly"))
        self.assertAlmostEqual(card["totals"]["salaryForPeriod"], round(SALARY * 12 / 26, 2), places=2)

    def test_a_month_finalized_as_a_month_stays_monthly(self):
        db = database.SessionLocal()
        try:
            db.add(models.TimeApproval(id="nov06-final-sep", employee_email=BIW, period_start="2026-09-01",
                                       period_end="2026-09-30", kind="final", revoked=0))
            db.commit()
        finally:
            db.close()
        try:
            for anchor, want in (("2026-09-10", ("2026-09-01", "2026-09-30", "month")),
                                 ("2026-10-20", ("2026-10-18", "2026-10-31", "biweekly"))):
                card = self._card(BIW, anchor)
                self.assertEqual((card["periodStart"], card["periodEnd"], card["periodKind"]), want, anchor)
        finally:
            db = database.SessionLocal()
            db.query(models.TimeApproval).filter(models.TimeApproval.id == "nov06-final-sep").delete()
            db.commit()
            db.close()

    def test_monthly_salary_and_contractors_keep_the_month(self):
        for em in (US, CON):
            card = self._card(em, "2026-11-05")
            self.assertEqual((card["periodStart"], card["periodEnd"], card["periodKind"]),
                             ("2026-11-01", "2026-11-30", "month"), em)

    def test_review_and_period_helpers_follow_the_frequency(self):
        db = database.SessionLocal()
        try:
            self.assertEqual(timesheet_review.period_for(db, BIW, "2026-11-20"), ("2026-11-15", "2026-11-28", "fixed"))
            self.assertEqual(timesheet_review.period_for(db, US, "2026-11-20"), ("2026-11-01", "2026-11-30", "fixed"))
            self.assertEqual(_period_of(db, BIW, "2026-11-20"), ("2026-11-15", "2026-11-28"))
        finally:
            db.close()

    def test_saving_the_payroll_wage_keeps_a_biweekly_frequency(self):
        db = database.SessionLocal()
        try:
            sync_comp_from_rate(db, BIW)
            comp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == BIW).first().compensation
            self.assertEqual(comp["frequency"], "biweekly")
            self.assertAlmostEqual(comp["base"], round(SALARY * 12 / 26, 2), places=2)   # per bi-weekly period
            sync_comp_from_rate(db, US)
            comp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == US).first().compensation
            self.assertEqual((comp["frequency"], comp["base"]), ("monthly", SALARY))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
