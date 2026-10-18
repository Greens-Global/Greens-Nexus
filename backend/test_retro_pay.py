"""Retro Pay report (Neil, Oct 17 2026) - routers/retro_pay.py.

A raise back-dated into a FINALIZED period is owed off-cycle: the report
prices the period as finalized (snapshot rate) and again at the current rate
history, same hours and OT rule, and returns the difference.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_retro_pay.py -q
"""
import json
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
from routers import retro_pay as rp  # noqa: E402
from routers.stepup import require_stepup  # noqa: E402
from routers.timeclock import _compute_timecard, require_team_read_pay  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

HOURLY = "retro.hourly@greensglobal.com"
FIXED = "retro.fixed@greensglobal.com"
PS, PE = "2026-09-13", "2026-09-26"     # a Sunday-to-Saturday pay period
ADMIN = {"email": "retro.admin@greensglobal.com", "level": 5}


def _wipe():
    db = database.SessionLocal()
    try:
        for em in (HOURLY, FIXED):
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email == em).delete(synchronize_session=False))
            for m in (models.PayrollRate, models.PayrollRateHistory, models.TimePunch, models.TimeApproval):
                db.query(m).filter(m.employee_email == em).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()


def _punch(db, em, day, hours, start_h=4):
    db.add(models.TimePunch(id=f"{em}-{day}-in", employee_email=em, kind="in", at=f"{day}T{start_h:02d}:00:00",
                            local_date=day, tz_offset_min=0, voided=0, created_at=f"{day}T{start_h:02d}:00:00"))
    end = start_h + hours
    db.add(models.TimePunch(id=f"{em}-{day}-out", employee_email=em, kind="out", at=f"{day}T{end:02d}:00:00",
                            local_date=day, tz_offset_min=0, voided=0, created_at=f"{day}T{end:02d}:00:00"))


def _hist(db, em, eff, rate, created, pay_type="hourly", salary=0.0, currency="USD"):
    db.add(models.PayrollRateHistory(id=f"{em}-{eff or 'always'}", employee_email=em, effective_date=eff,
                                     pay_type=pay_type, hourly_rate=rate, monthly_salary=salary,
                                     currency=currency, overtime_rule="ca", created_at=created))


def _finalize(db, em, ps, pe, snap):
    db.add(models.TimeApproval(id=f"{em}-{ps}-final", employee_email=em, period_start=ps, period_end=pe,
                               worked_min=0, approved_by=ADMIN["email"], approved_at="2026-09-28T12:00:00",
                               kind="final", note=json.dumps(snap), revoked=0))


def _run(**kw):
    db = database.SessionLocal()
    try:
        return rp.retro_pay(start=kw.get("start", "2026-08-01"), end=kw.get("end", "2026-10-17"),
                            email=kw.get("email", ""), user=ADMIN, _su={}, db=db)
    finally:
        db.close()


class HourlyRetroTests(unittest.TestCase):
    def setUp(self):
        _wipe()
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id=f"emp-{HOURLY}", first_name="Rita", last_name="Retro",
                                        work_email=HOURLY, company="", status="active", deleted_at=""))
            db.add(models.PayrollRate(employee_email=HOURLY, pay_type="hourly", hourly_rate=20.0,
                                      overtime_rule="ca", currency="USD"))
            _hist(db, HOURLY, "", 20.0, "2026-01-01T00:00:00")
            _punch(db, HOURLY, "2026-09-14", 10)   # Mon: 8 reg + 2 OT (before the raise)
            _punch(db, HOURLY, "2026-09-15", 13)   # Tue: 8 reg + 4 OT + 1 DT (CA daily rule)
            _punch(db, HOURLY, "2026-09-16", 8)    # Wed: 8 reg
            _finalize(db, HOURLY, PS, PE, {"rate": 20.0, "rule": "ca", "payType": "hourly", "currency": "USD",
                                           "monthlySalary": 0.0, "fullDayHours": 8.0})
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        _wipe()

    def _raise(self, eff, rate):
        db = database.SessionLocal()
        try:
            _hist(db, HOURLY, eff, rate, "2026-10-10T09:00:00")   # entered AFTER the finalize
            row = db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == HOURLY).first()
            row.hourly_rate = rate
            db.commit()
        finally:
            db.close()

    def test_backdated_raise_owes_the_difference_with_ot_multipliers(self):
        self._raise("2026-09-15", 25.0)
        out = _run()
        self.assertEqual(len(out["people"]), 1)
        p = out["people"][0]
        self.assertEqual((p["email"], p["currency"]), (HOURLY, "USD"))
        it = p["periods"][0]
        self.assertEqual((it["periodStart"], it["periodEnd"], it["changedFrom"]), (PS, PE, "2026-09-15"))
        # Hours on the changed days only (Tue + Wed): 16 reg, 4 OT, 1 DT.
        self.assertEqual(it["hours"], {"regMin": 16 * 60, "otMin": 4 * 60, "dtMin": 60, "leaveMin": 0, "holidayDays": 0})
        self.assertEqual(it["ratePaid"], 20.0)
        self.assertEqual([r["rate"] for r in it["rateNow"]], [25.0])
        # $5/h more on 16 reg + 4 OT x1.5 + 1 DT x2 = 16 + 6 + 2 = 24 paid hours -> $120.00.
        self.assertEqual(it["owedByClass"]["regular"], 80.0)
        self.assertEqual(it["owedByClass"]["overtime"], 30.0)
        self.assertEqual(it["owedByClass"]["doubleTime"], 10.0)
        self.assertEqual(it["owed"], 120.0)
        # Paid side is what the finalized card pays: Mon 8x20 + 2x30, Tue 8x20 + 4x30 + 1x40, Wed 8x20.
        self.assertEqual(it["paid"]["total"], 160 + 60 + 160 + 120 + 40 + 160)
        self.assertEqual(it["now"]["total"], it["paid"]["total"] + 120.0)
        self.assertEqual(p["owed"], 120.0)
        self.assertEqual(out["totals"], [{"currency": "USD", "people": 1, "periods": 1, "regMin": 960, "otMin": 240,
                                          "dtMin": 60, "leaveMin": 0, "paid": 700.0, "now": 820.0, "owed": 120.0}])
        self.assertEqual(out["checkManually"], [])

    def test_backdated_cut_is_negative(self):
        self._raise("2026-09-16", 18.5)
        it = _run()["people"][0]["periods"][0]
        self.assertEqual(it["hours"]["regMin"], 8 * 60)
        self.assertEqual(it["owed"], -12.0)    # 8h x -$1.50

    def test_raise_after_the_finalized_period_shows_nothing(self):
        self._raise("2026-10-01", 25.0)
        out = _run()
        self.assertEqual((out["people"], out["totals"], out["checkManually"]), ([], [], []))

    def test_range_and_employee_filters(self):
        self._raise("2026-09-15", 25.0)
        self.assertEqual(_run(start="2026-10-01", end="2026-10-17")["people"], [])   # period outside the range
        self.assertEqual(_run(email="someone.else@greensglobal.com")["people"], [])
        self.assertEqual(len(_run(email=HOURLY.upper())["people"]), 1)

    def test_finalized_data_is_unchanged(self):
        self._raise("2026-09-15", 25.0)
        db = database.SessionLocal()
        try:
            def state():
                fin = [(a.id, a.note, a.revoked, a.worked_min, a.approved_at) for a in
                       db.query(models.TimeApproval).filter(models.TimeApproval.employee_email == HOURLY).all()]
                hist = sorted((h.id, h.effective_date, h.hourly_rate) for h in
                              db.query(models.PayrollRateHistory).filter(models.PayrollRateHistory.employee_email == HOURLY).all())
                punches = sorted((p.id, p.at, p.voided) for p in
                                 db.query(models.TimePunch).filter(models.TimePunch.employee_email == HOURLY).all())
                return fin, hist, punches
            before = state()
            card_before = _compute_timecard(db, HOURLY, PS, PE)["totals"]["totalPay"]
        finally:
            db.close()
        _run()
        db = database.SessionLocal()
        try:
            self.assertEqual(state(), before)
            # The finalized card still pays the snapshot rate.
            self.assertEqual(_compute_timecard(db, HOURLY, PS, PE)["totals"]["totalPay"], card_before)
            self.assertEqual(card_before, 700.0)
        finally:
            db.close()

    def test_guarded_like_the_payroll_export(self):
        route = next(r for r in main.app.routes if getattr(r, "path", "") == "/timeclock/retro-pay")
        calls = {d.call for d in route.dependant.dependencies}
        self.assertIn(require_team_read_pay, calls)   # the manager tier never sees pay
        self.assertIn(require_stepup, calls)          # fresh identity check, like the export


class FixedRetroTests(unittest.TestCase):
    def setUp(self):
        _wipe()
        db = database.SessionLocal()
        try:
            db.add(models.PayrollRate(employee_email=FIXED, pay_type="fixed", monthly_salary=33000.0, currency="INR"))
            _hist(db, FIXED, "", 0, "2026-01-01T00:00:00", pay_type="fixed", salary=30000.0, currency="INR")
            _hist(db, FIXED, "2026-09-01", 0, "2026-10-05T00:00:00", pay_type="fixed", salary=33000.0, currency="INR")
            _finalize(db, FIXED, "2026-09-01", "2026-09-30", {"rate": 0.0, "rule": "none", "payType": "fixed",
                                                              "currency": "INR", "monthlySalary": 30000.0,
                                                              "fullDayHours": 8.0, "totalPay": 30000.0})
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        _wipe()

    def test_salaried_month_is_listed_to_check_manually(self):
        out = _run()
        self.assertEqual(out["people"], [])
        m = out["checkManually"]
        self.assertEqual(len(m), 1)
        self.assertEqual((m[0]["email"], m[0]["currency"], m[0]["ratePaid"]), (FIXED, "INR", 30000.0))
        self.assertEqual([r["rate"] for r in m[0]["rateNow"]], [33000.0])
        self.assertIn("Monthly salary", m[0]["reason"])


if __name__ == "__main__":
    unittest.main()
