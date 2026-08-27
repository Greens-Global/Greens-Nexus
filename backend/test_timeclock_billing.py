"""Time Clock: all-hourly team timesheet (Charmi) + billable-by-location (Neil).

- /timeclock/team must list EVERY hourly employee in scope, including those with
  ZERO punches in the period (they get a workedMin=0 row), and must exclude
  salaried-fixed / time-tracking-exempt people.
- /timeclock/billable-by-location returns per-employee worked-minutes split by
  work site (segment-based), so a worker who clocks in at property A and later
  at property B bills each.

    python -m unittest test_timeclock_billing
"""
import os
import unittest
from datetime import datetime, timezone, timedelta

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text
with database.engine.connect() as _c:
    for _s in ("ALTER TABLE nexus_groups ADD COLUMN bod_exempt INTEGER DEFAULT 0",
               "ALTER TABLE nexus_employees ADD COLUMN geofence_radius_m INTEGER DEFAULT 0"):
        try:
            _c.execute(_text(_s)); _c.commit()
        except Exception:
            pass

ADMIN = "billtest.admin@greensglobal.com"
E_PUNCH = "billtest.punch@greensglobal.com"   # hourly, has punches
E_NONE = "billtest.none@greensglobal.com"     # hourly, NO punches
E_EXEMPT = "billtest.exempt@greensglobal.com" # salaried-exempt (must be hidden)
E_FIXED = "billtest.fixed@greensglobal.com"   # salaried, NOT exempt - must appear on the team list (Charmi, Aug 28)
GROUP = "grp-billtest"
SITE_A = "site-a-billtest"
SITE_B = "site-b-billtest"


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class BillingTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em, fn in ((ADMIN, "Admin"), (E_PUNCH, "Pat"), (E_NONE, "Vicky"),
                           (E_EXEMPT, "Sal"), (E_FIXED, "Charmi")):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test",
                                            work_email=em, company="", status="active", deleted_at=""))
            # admin gets an hr grant so require_team_read admits them (whole company)
            db.add(models.NexusGroup(id=GROUP, name="Bill Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            # exempt person: fixed pay + time_tracking_exempt (off the timesheet)
            db.add(models.PayrollRate(employee_email=E_EXEMPT,
                                      pay_type="fixed", time_tracking_exempt=1))
            # salaried but NOT exempt: must appear on the team list even with no punches
            db.add(models.PayrollRate(employee_email=E_FIXED,
                                      pay_type="fixed", time_tracking_exempt=0))
            # two geofenced work sites (properties)
            db.add(models.HrWorkSite(id=SITE_A, name="Rental A", latitude="33.6846", longitude="-117.8265", radius_m=150))
            db.add(models.HrWorkSite(id=SITE_B, name="Rental B", latitude="34.0522", longitude="-118.2437", radius_m=150))
            # E_PUNCH: clock in/out at Rental A, then in/out at Rental B, same day
            today = datetime.now(timezone.utc).replace(hour=15, minute=0, second=0, microsecond=0)
            ld = today.strftime("%Y-%m-%d")
            def punch(pid, kind, at, wsid, wsname, lat, lng):
                db.add(models.TimePunch(id=pid, employee_email=E_PUNCH, kind=kind, at=_iso(at),
                                        local_date=ld, tz_offset_min=0, lat=lat, lng=lng,
                                        work_site_id=wsid, work_site_name=wsname, geo_status="in_fence",
                                        voided=0, created_at=_iso(at)))
            punch("p1", "in",  today,                        SITE_A, "Rental A", "33.6846", "-117.8265")
            punch("p2", "out", today + timedelta(hours=2),   SITE_A, "Rental A", "33.6846", "-117.8265")
            punch("p3", "in",  today + timedelta(hours=2, minutes=30), SITE_B, "Rental B", "34.0522", "-118.2437")
            punch("p4", "out", today + timedelta(hours=4, minutes=30), SITE_B, "Rental B", "34.0522", "-118.2437")
            db.commit()
            self.ld = ld
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("billtest.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.PayrollRate).filter(models.PayrollRate.employee_email.in_((E_EXEMPT, E_FIXED))).delete(synchronize_session=False)
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id.in_((SITE_A, SITE_B))).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.employee_email.like("billtest.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_team_lists_all_hourly_including_no_punch_and_excludes_exempt(self):
        r = self.client.get(f"/timeclock/team?start={self.ld}&end={self.ld}")
        self.assertEqual(r.status_code, 200, r.text)
        rows = {row["email"]: row for row in r.json()["rows"]}
        self.assertIn(E_PUNCH, rows)                 # has punches
        self.assertIn(E_NONE, rows)                  # NO punches - must still appear (Charmi)
        self.assertEqual(rows[E_NONE]["workedMin"], 0)
        self.assertNotIn(E_EXEMPT, rows)             # salaried-EXEMPT stays off the timesheet
        self.assertIn(E_FIXED, rows)                 # salaried, not exempt - now shows (Charmi, Aug 28)
        self.assertEqual(rows[E_FIXED]["payType"], "fixed")

    def test_billable_by_location_splits_two_sites(self):
        r = self.client.get(f"/timeclock/billable-by-location?start={self.ld}&end={self.ld}")
        self.assertEqual(r.status_code, 200, r.text)
        rows = {row["email"]: row for row in r.json()["rows"]}
        self.assertIn(E_PUNCH, rows)
        by = {x["workSite"]: x["workedMin"] for x in rows[E_PUNCH]["byLocation"]}
        self.assertIn("Rental A", by)
        self.assertIn("Rental B", by)
        self.assertGreater(by["Rental A"], 0)
        self.assertGreater(by["Rental B"], 0)


if __name__ == "__main__":
    unittest.main()
