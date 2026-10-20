"""
The team Time Sheet carries the EMPLOYEE's display zone (Visesh, Oct 20 2026):
/payroll returns `zoneKey` - 'india' for India-based staff (their punches are
on IST, or no punch yet and their People country is India), 'california' for
US staff - so the card opens in India time for them (lib/displayTz.js
useEmployeeZone). Hourly and fixed-salary cards both.

Throwaway sqlite. Run with: python -m pytest -q test_timecard_zone_key.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import database                   # noqa: E402
import main                       # noqa: E402,F401 - registers every model
import models                     # noqa: E402
from routers import timeclock     # noqa: E402

RAJ = "tz.raj@greensglobal.com"     # India, hourly, punches on IST
PRIYA = "tz.priya@greensglobal.com" # India, fixed salary, no punches yet
AMY = "tz.amy@greensglobal.com"     # US, hourly, punches on Pacific
ADMIN = {"email": "tz.admin@greensglobal.com"}


class ZoneKeyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.TimePunch, models.PayrollRate):
            self.db.query(m).delete()
        for em, country in ((RAJ, "IN"), (PRIYA, "IN"), (AMY, "US")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name="T", last_name="Z", work_email=em,
                                             status="active", deleted_at="", country=country))
        self.db.add(models.PayrollRate(employee_email=RAJ, hourly_rate=5, overtime_rule="none", currency="INR"))
        self.db.add(models.PayrollRate(employee_email=PRIYA, pay_type="fixed", monthly_salary=50000, currency="INR",
                                       overtime_rule="none"))
        self.db.add(models.PayrollRate(employee_email=AMY, hourly_rate=25))
        for em, off in ((RAJ, -330), (AMY, 420)):
            self.db.add(models.TimePunch(id=f"p-{em}", employee_email=em, kind="in", at="2026-10-14T04:00:00",
                                         local_date="2026-10-14", tz_offset_min=off, created_at="2026-10-14T04:00:00"))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _card(self, em):
        with mock.patch.object(timeclock, "_visible_emails", return_value=None), \
             mock.patch.object(timeclock, "_no_pay", side_effect=lambda _db, _u, card: card):
            return timeclock.payroll_timecard(email=em, start="2026-10-11", end="2026-10-24",
                                              user=ADMIN, _su={}, db=self.db)

    def test_india_staff_open_in_india_time(self):
        self.assertEqual(self._card(RAJ)["zoneKey"], "india")

    def test_india_fixed_salary_with_no_punches_reads_their_country(self):
        self.assertEqual(self._card(PRIYA)["zoneKey"], "india")

    def test_us_staff_open_in_california_time(self):
        self.assertEqual(self._card(AMY)["zoneKey"], "california")


if __name__ == "__main__":
    unittest.main()
