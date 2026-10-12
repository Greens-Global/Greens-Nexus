"""Backup Manager (Neil, Oct 13).

Who the backup is (set on the profile, else the manager's manager, else the
company's HR contact), and that the backup gets the manager's rights over the
employee: timecard scope, People team scope, the review queue.

    python -m pytest test_backup_manager.py
"""
import os
import tempfile
import unittest
import uuid

# Its own throwaway database (CLAUDE.md).
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import auth                                                                      # noqa: E402
import backup_manager                                                            # noqa: E402
import database                                                                  # noqa: E402
import models                                                                    # noqa: E402
import timesheet_review                                                          # noqa: E402
from models import HrEntity, NexusEmployee, TimesheetReview                      # noqa: E402
from routers.timeclock import _visible_emails                                    # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

CO = "co-backup"
HR = "hr.contact@greensglobal.com"
BOSS = "boss@greensglobal.com"        # the manager's manager
MGR = "mgr@greensglobal.com"
EMP = "emp@greensglobal.com"
SUB = "sub@greensglobal.com"          # reports to EMP
TOP = "top@greensglobal.com"          # reports to nobody
COVER = "cover@greensglobal.com"      # a backup set by hand


def _emp(db, em, mgr="", backup=""):
    db.add(NexusEmployee(id=str(uuid.uuid4()), work_email=em, first_name=em.split("@")[0], last_name="T",
                         manager_email=mgr, backup_manager_email=backup, company=CO, status="active"))


class BackupManagerTest(unittest.TestCase):
    def setUp(self):
        db = database.SessionLocal()
        try:
            for m in (TimesheetReview, NexusEmployee, HrEntity):
                db.query(m).delete()
            db.add(HrEntity(id=CO, name="Backup Co", hr_contact_email=HR))
            _emp(db, BOSS)
            _emp(db, MGR, BOSS)
            _emp(db, EMP, MGR)
            _emp(db, SUB, EMP)
            _emp(db, TOP)
            _emp(db, COVER, BOSS)
            _emp(db, HR)
            db.commit()
        finally:
            db.close()
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()

    def _set_backup(self, em, backup):
        self.db.query(NexusEmployee).filter(NexusEmployee.work_email == em).update({"backup_manager_email": backup})
        self.db.commit()

    def test_default_is_the_managers_manager_then_hr(self):
        self.assertEqual(backup_manager.backup_of(self.db, EMP), (BOSS, "manager"))
        self.assertEqual(backup_manager.backup_of(self.db, MGR), (HR, "hr"))      # boss has no manager
        self.assertEqual(backup_manager.backup_of(self.db, TOP), (HR, "hr"))      # no manager at all
        self.assertEqual(backup_manager.backup_of(self.db, HR), ("", ""))         # never their own backup

    def test_a_backup_set_on_the_profile_wins(self):
        self._set_backup(EMP, COVER)
        self.assertEqual(backup_manager.backup_of(self.db, EMP), (COVER, "set"))
        self.assertIn(EMP, backup_manager.backed_up_by(self.db, COVER))
        self.assertNotIn(EMP, backup_manager.backed_up_by(self.db, BOSS))

    def test_backup_gets_the_managers_timecard_scope(self):
        self._set_backup(EMP, COVER)
        scope = _visible_emails(self.db, {"email": COVER, "level": 3})
        self.assertIn(EMP, scope)
        self.assertNotIn(SUB, scope)              # one level down, like a manager's directs
        self.assertNotIn(EMP, _visible_emails(self.db, {"email": "nobody@greensglobal.com", "level": 3}))

    def test_backup_gets_the_team_below_in_people(self):
        self._set_backup(EMP, COVER)
        team = auth.team_emails(self.db, COVER)
        self.assertEqual(team, {EMP, SUB})

    def test_backup_sees_the_timesheet_waiting_on_the_manager(self):
        self._set_backup(EMP, COVER)
        self.db.add(TimesheetReview(id="r1", employee_email=EMP, period_start="2026-10-01", period_end="2026-10-31",
                                    pay_type="hourly", manager_email=MGR, status="with_manager", rounds=[],
                                    last_snapshot={}))
        self.db.commit()
        self.assertEqual([r.id for r in timesheet_review.waiting_on(self.db, MGR)], ["r1"])
        self.assertEqual([r.id for r in timesheet_review.waiting_on(self.db, COVER)], ["r1"])
        self.assertEqual(timesheet_review.waiting_on(self.db, TOP), [])


if __name__ == "__main__":
    unittest.main()
