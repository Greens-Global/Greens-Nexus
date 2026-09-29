"""
A punch change or a time-off request reaches the employee's manager AND the HR
contact of their company (Charmi, Sep 25: "the pop-up should go to the
appropriate manager of that person. And HR" - the manager acts, HR steps in
when the manager has not). Still never a broadcast, never the person who did
it, and one company's HR contact never hears about another company's people.

Throwaway sqlite. No network.

Run with: python -m unittest test_team_alert_hr_contact -v
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import database
import models

models.Base.metadata.create_all(bind=database.engine)

from routers import timeclock  # noqa: E402


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


EMP = "amy@example.com"          # Greens Global, reports to MGR
MGR = "valinda@example.com"
HR = "charmi@example.com"        # HR contact of Greens Global
OTHER_EMP = "vinod@example.com"  # another company, reports to MGR too
OTHER_HR = "darshana@example.com"
OWNER = "neil@example.com"       # Global Admin
CO = "co-greens-global-test"
OTHER_CO = "co-sc-medi-test"


class HrContactTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.NexusNotification, models.NexusEmployee, models.NexusRole, models.HrEntity):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Global", hr_contact_email=f" {HR.upper()} "))
        self.db.add(models.HrEntity(id=OTHER_CO, name="SC Medi Center", hr_contact_email=OTHER_HR))
        for email, mgr, co in ((EMP, MGR, CO), (OTHER_EMP, MGR, OTHER_CO), (MGR, OWNER, CO), (HR, OWNER, CO)):
            self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), work_email=email, first_name=email.split("@")[0].title(),
                                             last_name="Test", manager_email=mgr, company=co, status="active"))
        self.db.add(models.NexusRole(email=OWNER, role="owner"))
        self.db.commit()

    def _recipients(self):
        return sorted(r.recipient for r in self.db.query(models.NexusNotification).all())

    def test_manager_and_the_companys_hr_contact_and_global_admins(self):
        self.assertEqual(sorted(timeclock._team_alert_recipients(self.db, EMP, EMP)), sorted([MGR, HR, OWNER]))

    def test_each_company_has_its_own_hr_contact(self):
        got = timeclock._team_alert_recipients(self.db, OTHER_EMP, OTHER_EMP)
        self.assertIn(OTHER_HR, got)
        self.assertNotIn(HR, got)

    def test_hr_is_not_told_about_what_hr_did(self):
        self.assertEqual(sorted(timeclock._team_alert_recipients(self.db, EMP, HR)), sorted([MGR, OWNER]))

    def test_hr_contact_who_is_also_the_manager_is_told_once(self):
        ent = self.db.query(models.HrEntity).filter(models.HrEntity.id == CO).first()
        ent.hr_contact_email = MGR
        self.db.commit()
        self.assertEqual(sorted(timeclock._team_alert_recipients(self.db, EMP, EMP)), sorted([MGR, OWNER]))

    def test_no_hr_contact_on_file_changes_nothing(self):
        ent = self.db.query(models.HrEntity).filter(models.HrEntity.id == CO).first()
        ent.hr_contact_email = ""
        self.db.commit()
        self.assertEqual(sorted(timeclock._team_alert_recipients(self.db, EMP, EMP)), sorted([MGR, OWNER]))

    def test_a_punch_change_request_reaches_manager_and_hr(self):
        timeclock._notify_approvers(self.db, employee_email=EMP, title="Timesheet fix requested", body="add an in punch")
        self.db.commit()
        self.assertEqual(self._recipients(), sorted([MGR, HR, OWNER]))

    def test_a_time_off_request_reaches_manager_and_hr(self):
        timeclock.request_timeoff(
            timeclock.TimeOffIn(type="vacation", start_date="2026-10-01", end_date="2026-10-02"),
            user={"email": EMP, "level": 1}, db=self.db)
        self.assertEqual(self._recipients(), sorted([MGR, HR, OWNER]))


if __name__ == "__main__":
    unittest.main()
