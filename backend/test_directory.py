"""Contact Directory (routers/directory.py, Oct 2026).

Every internal person can read it; it carries contact fields only (never the
HR record); externals, guests and offboarded people are left out; today's
availability comes from punches, time off, leave and company holidays, and a
confidential time-off request never says more than "Off Today". HR users also
get the completeness gaps.

    python -m unittest test_directory -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
ADMIN = "ada.admin" + D
BOSS = "bo.boss" + D
STAFF = "sam.staff" + D
LEAVE = "lee.leave" + D
GONE = "gail.gone" + D
GUEST = "guest@partner.example"
CO = "co-dir-test"
# Dates are judged in each person's own zone (every test person is in
# California), so "today" here is the Pacific date, not the UTC one.
from zoneinfo import ZoneInfo  # noqa: E402
TODAY = datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()


class DirectoryTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusRole, models.HrEntity, models.HrDepartment, models.TimePunch,
                  models.TimeOffRequest, models.HrLeaveRequest, models.HrCompanyHoliday, models.ScheduledShift,
                  models.NexusGroup, models.NexusGroupMember):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=CO, name="Dir Test Co"))
        db.add(models.HrDepartment(id="d-acct", company_id=CO, name="Accounting", lead_email=BOSS))
        db.add(models.HrDepartment(id="d-it", company_id=CO, name="IT"))
        people = [
            ("e-admin", ADMIN, "", "IT", "active", "internal"),
            ("e-boss", BOSS, ADMIN, "Accounting", "active", "internal"),
            ("e-staff", STAFF, BOSS, "Accounting", "active", "internal"),
            ("e-leave", LEAVE, BOSS, "Accounting", "active", "internal"),
            ("e-gone", GONE, BOSS, "Accounting", "offboarded", "internal"),
            ("e-guest", GUEST, "", "", "active", "guest"),
        ]
        for eid, em, mgr, dept, status, ident in people:
            db.add(models.NexusEmployee(
                id=eid, first_name=em.split("@")[0].split(".")[0].title(), last_name="T", work_email=em,
                manager_email=mgr, department=dept, company=CO, status=status, identity_type=ident,
                job_title="Analyst", phone="(760) 555-0100", office_phone="(760) 555-0200", country="US", state="CA",
                personal_email="private@example.com", personal={"dob": "1990-01-01"},
                compensation={"base": 5200}, bank=[{"number": "000123456789"}], deleted_at=""))
        db.add(models.NexusRole(email=ADMIN, role="administrator", display_name="Ada"))
        now = datetime.now(timezone.utc)
        db.add(models.TimePunch(id="p1", employee_email=STAFF, kind="in", at=(now - timedelta(hours=2)).isoformat(),
                                local_date=TODAY, tz_offset_min=420, created_at=now.isoformat()))
        db.add(models.TimeOffRequest(id="t1", employee_email=LEAVE, type="sick", start_date=TODAY,
                                     end_date=(datetime.fromisoformat(TODAY) + timedelta(days=2)).date().isoformat(), status="approved",
                                     note="surgery", confidential=1, created_at=now.isoformat()))
        db.commit()
        db.close()
        cache.contact_directory.invalidate()
        cache.module_grants.invalidate()
        auth._role_cache.clear()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _get(self, who=STAFF):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client.get("/directory")

    def test_an_employee_reads_contact_fields_only(self):
        r = self._get(STAFF)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        emails = {p["email"] for p in body["people"]}
        self.assertEqual(emails, {ADMIN, BOSS, STAFF, LEAVE})       # no guest, no offboarded
        self.assertNotIn("gaps", body)
        me = next(p for p in body["people"] if p["email"] == STAFF)
        self.assertEqual(me["managerEmail"], BOSS)
        self.assertEqual(me["managerName"], "Bo T")
        self.assertEqual(me["mobile"], "(760) 555-0100")
        self.assertEqual(me["officePhone"], "(760) 555-0200")
        self.assertEqual(me["companyName"], "Dir Test Co")
        self.assertEqual(me["timeZone"], "America/Los_Angeles")
        text = r.text
        for leak in ("private@example.com", "1990-01-01", "5200", "000123456789", "personalEmail", "compensation", "bank", "_id"):
            self.assertNotIn(leak, text, leak)

    def test_department_lead_is_flagged_from_the_department_row(self):
        body = self._get(STAFF).json()
        boss = next(p for p in body["people"] if p["email"] == BOSS)
        self.assertEqual(boss["departmentRole"], "lead")
        self.assertEqual([d["name"] for d in body["departments"]], ["Accounting", "IT"])
        self.assertEqual(body["companies"], [{"id": CO, "name": "Dir Test Co"}])

    def test_availability_from_punches_and_time_off(self):
        body = self._get(STAFF).json()
        by = {p["email"]: p for p in body["people"]}
        self.assertEqual(by[STAFF]["availability"]["state"], "in")
        self.assertEqual(by[STAFF]["availability"]["label"], "Clocked In")
        self.assertTrue(by[STAFF]["availability"]["detail"].startswith("since "))
        off = by[LEAVE]["availability"]
        self.assertEqual(off["state"], "off")
        self.assertEqual(off["label"], "Off Today")
        self.assertTrue(off["detail"].startswith("through "))
        self.assertIsNone(by[BOSS]["availability"])
        # A confidential request's type and note never reach the directory.
        self.assertNotIn("sick", str(off).lower())
        self.assertNotIn("surgery", body and str(body))

    def test_company_holiday_and_leave_and_shift(self):
        db = database.SessionLocal()
        db.add(models.HrCompanyHoliday(id="h1", company_id=CO, date=TODAY, name="Founders Day"))
        db.add(models.HrLeaveRequest(id="l1", employee_id="e-boss", leave_type="annual", start_date=TODAY,
                                     end_date=TODAY, status="approved"))
        db.add(models.ScheduledShift(id="s1", employee_email=ADMIN, work_date=TODAY, start_hhmm="09:00", end_hhmm="17:30"))
        db.commit()
        db.close()
        body = self._get(STAFF).json()
        by = {p["email"]: p for p in body["people"]}
        self.assertEqual(by[BOSS]["availability"], {"state": "off", "label": "On Leave", "detail": ""})
        self.assertEqual(by[ADMIN]["availability"], {"state": "scheduled", "label": "Scheduled", "detail": "9:00 AM - 5:30 PM"})
        # Clocked in beats the holiday; a person with nothing else gets the holiday.
        self.assertEqual(by[STAFF]["availability"]["state"], "in")
        self.assertEqual(by[LEAVE]["availability"]["state"], "off")

    def test_hr_sees_the_gaps(self):
        body = self._get(ADMIN).json()
        gaps = body["gaps"]
        self.assertEqual(gaps["manager"], [ADMIN])
        self.assertEqual(gaps["photo"], sorted([ADMIN, BOSS, STAFF, LEAVE]))
        self.assertEqual(gaps["departmentLead"], ["IT"])
        self.assertEqual(gaps["jobTitle"], [])

    def test_the_roster_is_cached_but_availability_is_live(self):
        self._get(STAFF)
        db = database.SessionLocal()
        db.add(models.TimePunch(id="p2", employee_email=STAFF, kind="out", at=datetime.now(timezone.utc).isoformat(),
                                local_date=TODAY, tz_offset_min=420, created_at=datetime.now(timezone.utc).isoformat()))
        db.commit()
        db.close()
        by = {p["email"]: p for p in self._get(STAFF).json()["people"]}
        self.assertEqual(by[STAFF]["availability"]["state"], "out")

    def test_a_guest_is_refused(self):
        r = self._get(GUEST)
        self.assertEqual(r.status_code, 403, r.text)


if __name__ == "__main__":
    unittest.main()
