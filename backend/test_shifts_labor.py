"""Scheduled labor cost on the shift planner (Frontline Reach, Neil 11/02/2026):
GET /timeclock/schedule/labor prices the planner's live shifts at each
person's rate on that day.
    python -m pytest test_shifts_labor.py
"""
import os
import tempfile
import unittest
# A throwaway sqlite of its own, so `python -m unittest test_shifts_labor`
# never ALTERs or clears a local greens_nexus.db (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text  # noqa: E402
with database.engine.connect() as _c:
    for _sql in ("ALTER TABLE scheduled_shifts ADD COLUMN published INTEGER DEFAULT 1",
                 "ALTER TABLE scheduled_shifts ADD COLUMN pending_delete INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN break_min INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN weather_status VARCHAR DEFAULT ''",
                 "ALTER TABLE scheduled_shifts ADD COLUMN activities_json TEXT DEFAULT ''",
                 "ALTER TABLE payroll_rates ADD COLUMN pay_type VARCHAR DEFAULT 'hourly'",
                 "ALTER TABLE payroll_rates ADD COLUMN currency VARCHAR DEFAULT 'USD'"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

ADMIN = "labor.admin@greensglobal.com"
HOURLY = "labor.hourly@greensglobal.com"     # $20, raised to $30 from TUE
FIXED = "labor.fixed@greensglobal.com"       # fixed pay: counted, not priced
NORATE = "labor.norate@greensglobal.com"     # hourly with no rate row
MGR = "labor.mgr@greensglobal.com"           # manager tier: hours only, pay hidden
STAFF = "labor.staff@greensglobal.com"
MON, TUE, WED = "2026-11-16", "2026-11-17", "2026-11-18"
ROLE_EMAILS = (ADMIN, MGR)


class LaborTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, HOURLY, FIXED, NORATE, MGR, STAFF):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].split("@")[0], last_name="X",
                                            work_email=em, status="active", deleted_at="",
                                            manager_email=MGR if em in (HOURLY, FIXED) else ""))
            db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
            db.add(models.PayrollRate(employee_email=HOURLY, pay_type="hourly", hourly_rate=30, overtime_rule="ca", currency="USD"))
            db.add(models.PayrollRateHistory(id="lab-h-1", employee_email=HOURLY, effective_date="", pay_type="hourly", hourly_rate=20, currency="USD", created_at="2026-01-01T00:00:00"))
            db.add(models.PayrollRateHistory(id="lab-h-2", employee_email=HOURLY, effective_date=TUE, pay_type="hourly", hourly_rate=30, currency="USD", created_at="2026-11-01T00:00:00"))
            db.add(models.PayrollRate(employee_email=FIXED, pay_type="fixed", hourly_rate=0, monthly_salary=4000, currency="USD"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        self._as(ADMIN)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusRole).filter(models.NexusRole.email.in_(list(ROLE_EMAILS))).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("labor.%")).delete(synchronize_session=False))
            db.query(models.PayrollRate).filter(models.PayrollRate.employee_email.like("labor.%")).delete(synchronize_session=False)
            db.query(models.PayrollRateHistory).filter(models.PayrollRateHistory.employee_email.like("labor.%")).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("labor.%")) |
                (models.ScheduledShift.created_by.like("labor.%"))).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _place(self, email, day, start="09:00", end="17:00", break_min=0, published=1, **kw):
        db = database.SessionLocal()
        try:
            import uuid
            db.add(models.ScheduledShift(id=str(uuid.uuid4()), employee_email=email, work_date=day,
                                         start_hhmm=start, end_hhmm=end, break_min=break_min,
                                         published=published, created_by=ADMIN, created_at="2026-11-01T00:00:00", **kw))
            db.commit()
        finally:
            db.close()

    def _labor(self, start=MON, end=WED):
        return self.client.get(f"/timeclock/schedule/labor?start={start}&end={end}")

    def test_hours_are_net_of_unpaid_breaks_and_priced_at_the_rate_of_that_day(self):
        self._place(HOURLY, MON, break_min=30)   # 7.5 h at $20 (before the raise)
        self._place(HOURLY, TUE)                 # 8 h at $30 (the raise applies from TUE)
        r = self._labor()
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertAlmostEqual(d["hours"], 15.5)
        self.assertAlmostEqual(d["cost"], 7.5 * 20 + 8 * 30)
        self.assertEqual(d["currency"], "USD")
        by_day = {x["day"]: x for x in d["days"]}
        self.assertAlmostEqual(by_day[MON]["hours"], 7.5)
        self.assertAlmostEqual(by_day[MON]["cost"], 150.0)
        self.assertAlmostEqual(by_day[TUE]["cost"], 240.0)
        self.assertEqual(d["payHidden"], False)

    def test_fixed_pay_is_counted_not_priced_and_no_rate_is_counted(self):
        self._place(FIXED, MON, "09:00", "13:00")    # 4 h, fixed pay
        self._place(NORATE, MON, "09:00", "12:00")   # 3 h, nobody has set a rate
        d = self._labor().json()
        self.assertAlmostEqual(d["hours"], 7.0)
        self.assertAlmostEqual(d["cost"], 0.0)
        self.assertEqual(d["fixedPayPeople"], 1)
        self.assertEqual(d["peopleWithoutRate"], 1)

    def test_cancelled_removing_and_open_shifts_are_left_out_and_drafts_are_split(self):
        self._place(HOURLY, MON)                                   # 8 h published
        self._place(HOURLY, TUE, published=0)                      # 8 h draft at $30
        self._place(HOURLY, WED, weather_status="cancelled")       # a weather day: nothing
        self._place(HOURLY, WED, "18:00", "20:00", pending_delete=1)  # being removed: nothing
        self._place("", MON, "09:00", "17:00", open_slots=2)       # an open shift has no one to price
        d = self._labor().json()
        self.assertAlmostEqual(d["hours"], 16.0)
        self.assertAlmostEqual(d["published"]["hours"], 8.0)
        self.assertAlmostEqual(d["published"]["cost"], 160.0)
        self.assertAlmostEqual(d["draft"]["hours"], 8.0)
        self.assertAlmostEqual(d["draft"]["cost"], 240.0)
        self.assertEqual([x["day"] for x in d["days"] if x["hours"]], [MON, TUE])

    def test_two_currencies_give_no_single_total_only_the_parts(self):
        """A US and an India team under one scheduler: $ and Rs do not add,
        so `cost` is null and `currency` blank while `costs` carries each."""
        INR = "labor.inr@greensglobal.com"
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id=f"emp-{INR}", first_name="Inr", last_name="X", work_email=INR,
                                        status="active", deleted_at="", manager_email=""))
            db.add(models.PayrollRate(employee_email=INR, pay_type="hourly", hourly_rate=500, currency="INR"))
            db.commit()
        finally:
            db.close()
        self._place(HOURLY, TUE)                      # 8 h at $30
        self._place(INR, TUE, "09:00", "13:00")       # 4 h at Rs 500
        d = self._labor().json()
        self.assertAlmostEqual(d["hours"], 12.0)
        self.assertIsNone(d["cost"])
        self.assertEqual(d["currency"], "")
        self.assertEqual(d["costs"], {"USD": 240.0, "INR": 2000.0})
        # One currency: the total is in it.
        db = database.SessionLocal()
        try:
            db.query(models.ScheduledShift).filter(models.ScheduledShift.employee_email == INR).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        d = self._labor().json()
        self.assertAlmostEqual(d["cost"], 240.0)
        self.assertEqual(d["currency"], "USD")

    def test_a_manager_sees_hours_but_never_pay(self):
        self._place(HOURLY, MON)
        self._as(MGR)
        r = self._labor()
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertAlmostEqual(d["hours"], 8.0)
        self.assertIsNone(d["cost"])
        self.assertIsNone(d["peopleWithoutRate"])
        self.assertIsNone(d["fixedPayPeople"])
        self.assertTrue(d["payHidden"])
        self.assertNotIn("cost", d["days"][0]) if d["days"] else None

    def test_a_manager_only_counts_the_people_they_manage(self):
        self._place(HOURLY, MON)     # reports to MGR
        self._place(NORATE, MON)     # does not
        self._as(MGR)
        d = self._labor().json()
        self.assertAlmostEqual(d["hours"], 8.0)

    def test_staff_are_refused(self):
        self._as(STAFF)
        self.assertEqual(self._labor().status_code, 403)

    def test_bad_dates_are_refused(self):
        self.assertEqual(self._labor("2026-11-20", "2026-11-10").status_code, 400)
        self.assertEqual(self._labor("nope", WED).status_code, 400)


if __name__ == "__main__":
    unittest.main()
