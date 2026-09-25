"""
Time and leave alerts reach the employee's OWN manager and the Global Admins -
nobody else (Pranshu, Sep 25).

Before: a timecard edit made by the employee's manager (or for someone with no
manager on file), and a timesheet request from someone with no manager, went
out as a broadcast (recipient=''), which every Manager-level account and above
reads. So Sagar, a manager, saw "Timecard edited" rows for Visesh's team on his
home screen. The Home screen's "Time off to review" also counted every pending
request in the company.

Throwaway sqlite. No network.

Run with: python -m unittest test_team_alert_recipients -v
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
from routers.dashboards import _time_off_pending  # noqa: E402


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


PRANSHU = "pranshu@example.com"   # reports to Visesh
VISESH = "visesh@example.com"     # manager
SAGAR = "sagar@example.com"       # a manager, but not Pranshu's
NEIL = "neil@example.com"         # Global Admin (role 'owner')
ITADMIN = "it@example.com"        # IT Admin (role 'administrator') - not a Global Admin
ORPHAN = "orphan@example.com"     # no manager on file
SAGARS_REPORT = "report@example.com"


class TeamAlertTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.NexusNotification, models.TimeOffRequest, models.NexusEmployee, models.NexusRole):
            self.db.query(m).delete()
        for email, mgr in ((PRANSHU, VISESH), (VISESH, NEIL), (SAGAR, NEIL), (ORPHAN, ""),
                           (SAGARS_REPORT, SAGAR)):
            self.db.add(models.NexusEmployee(
                id=str(uuid.uuid4()), work_email=email, first_name=email.split("@")[0].title(),
                last_name="Test", manager_email=mgr, status="active"))
        for email, role in ((VISESH, "manager"), (SAGAR, "manager"), (NEIL, "owner"),
                            (ITADMIN, "administrator")):
            self.db.add(models.NexusRole(email=email, role=role))
        self.db.commit()

    def _recipients(self):
        rows = self.db.query(models.NexusNotification).all()
        return sorted(r.recipient for r in rows)

    # ── Who gets told ────────────────────────────────────────────────────
    def test_employee_event_goes_to_their_manager_and_global_admins(self):
        got = timeclock._team_alert_recipients(self.db, PRANSHU, PRANSHU)
        self.assertEqual(sorted(got), sorted([VISESH, NEIL]))

    def test_other_managers_and_it_admins_are_not_told(self):
        got = timeclock._team_alert_recipients(self.db, PRANSHU, PRANSHU)
        self.assertNotIn(SAGAR, got)
        self.assertNotIn(ITADMIN, got)

    def test_the_manager_who_made_the_change_is_not_told_but_global_admins_are(self):
        self.assertEqual(timeclock._team_alert_recipients(self.db, PRANSHU, VISESH), [NEIL])

    def test_no_manager_on_file_still_reaches_global_admins(self):
        self.assertEqual(timeclock._team_alert_recipients(self.db, ORPHAN, ORPHAN), [NEIL])

    # ── Nothing is ever broadcast ────────────────────────────────────────
    def test_timecard_edit_by_the_manager_is_not_a_broadcast(self):
        """The screenshot case: the manager edits their own report's punch."""
        timeclock._notify_timecard_change(self.db, employee_email=PRANSHU, actor_email=VISESH,
                                          body="Visesh edited Pranshu's in punch")
        self.db.commit()
        self.assertEqual(self._recipients(), [NEIL])

    def test_timesheet_request_without_a_manager_is_not_a_broadcast(self):
        timeclock._notify_approvers(self.db, employee_email=ORPHAN, title="Timesheet fix requested",
                                    body="please fix")
        self.db.commit()
        self.assertEqual(self._recipients(), [NEIL])

    def test_time_off_request_goes_to_manager_and_global_admins_only(self):
        timeclock.request_timeoff(
            timeclock.TimeOffIn(type="vacation", start_date="2026-10-01", end_date="2026-10-02"),
            user={"email": PRANSHU, "level": 1}, db=self.db)
        self.assertEqual(self._recipients(), sorted([VISESH, NEIL]))

    # ── Home screen "Time off to review" ─────────────────────────────────
    def _pending(self, email):
        self.db.add(models.TimeOffRequest(id=str(uuid.uuid4()), employee_email=email, type="vacation",
                                          start_date="2026-10-01", end_date="2026-10-01",
                                          status="pending", created_at="2026-09-25T00:00:00"))
        self.db.commit()

    def test_time_off_count_is_only_my_direct_reports(self):
        self._pending(PRANSHU)
        self._pending(SAGARS_REPORT)
        self.assertEqual(_time_off_pending(self.db, {"level": 3}, VISESH), 1)
        self.assertEqual(_time_off_pending(self.db, {"level": 3}, SAGAR), 1)
        self.assertEqual(_time_off_pending(self.db, {"level": 4}, ITADMIN), 0)

    def test_global_admin_sees_the_whole_company(self):
        self._pending(PRANSHU)
        self._pending(SAGARS_REPORT)
        self.assertEqual(_time_off_pending(self.db, {"level": 5}, NEIL), 2)


if __name__ == "__main__":
    unittest.main()
