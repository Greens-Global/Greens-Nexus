"""Payroll Ready to Export (Neil, Oct 19 2026): when the last time sheet of a
company's pay period is finalized, the company's HR contact gets one bell
saying the QuickBooks export is ready, with the sick / vacation hours in it.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_payroll_ready_notice.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import main  # noqa: E402,F401 - app import wires the DB
import models  # noqa: E402
from routers import timeclock as tc  # noqa: E402

CO, OTHER_CO = "pr-co", "pr-co-2"
A, B, X = "pr.ann@greensglobal.com", "pr.ben@greensglobal.com", "pr.xavi@greensglobal.com"
HR_EMAIL = "pr.charmi@greensglobal.com"
HR = {"email": "pr.admin@greensglobal.com", "level": 5, "role": "administrator"}
PS, PE = "2026-09-13", "2026-09-26"
PDT = 420
_SEQ = [0]


def _p(db, em, kind, local, cat=""):
    _SEQ[0] += 1
    at = (datetime.strptime(local, "%Y-%m-%dT%H:%M") + timedelta(minutes=PDT)).strftime("%Y-%m-%dT%H:%M:%S")
    db.add(models.TimePunch(id=f"pr-{_SEQ[0]:04d}", employee_email=em, kind=kind, at=at, local_date=local[:10],
                            tz_offset_min=PDT, voided=0, created_at=at, source="web", geo_status="", category=cat))


class PayrollReadyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = db = database.SessionLocal()
        for m in (models.TimePunch, models.PayrollRate, models.TimeApproval, models.NexusNotification,
                  models.HrEntity):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        db.add(models.HrEntity(id=CO, name="Greens Storage", country="US", hr_contact_email=HR_EMAIL))
        db.add(models.HrEntity(id=OTHER_CO, name="Other Co", country="US"))
        for em, co in ((A, CO), (B, CO), (X, OTHER_CO), (HR_EMAIL, CO)):
            db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].title(), last_name="Test",
                                        work_email=em, company=co, status="active", deleted_at="", country="US"))
        for em in (A, B, X):
            db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20.0,
                                      overtime_rule="ca", currency="USD"))
            _p(db, em, "in", "2026-09-14T08:00")
            _p(db, em, "out", "2026-09-14T16:00")
        _p(db, B, "in", "2026-09-15T08:00", cat="Sick Day")
        _p(db, B, "out", "2026-09-15T12:00", cat="Sick Day")
        db.commit()

    def tearDown(self):
        self.db.close()

    def _ready(self):
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.title == "Payroll Ready to Export").all())

    def _finalize(self, em):
        tc.finalize_timecard(tc.FinalizeIn(email=em, start=PS, end=PE, allow_exceptions=True), user=HR, db=self.db)

    def test_hr_hears_once_when_the_last_sheet_is_finalized(self):
        self._finalize(A)
        self.assertEqual(self._ready(), [])            # Ben is still open
        self._finalize(X)
        self.assertEqual(self._ready(), [])            # another company's sheet changes nothing
        self._finalize(B)
        bells = self._ready()
        self.assertEqual(len(bells), 1)
        n = bells[0]
        self.assertEqual(n.recipient, HR_EMAIL)
        self.assertEqual(n.priority, 1)
        self.assertIn("All 2 time sheets for Greens Storage, 09/13/2026 - 09/26/2026, are finalized", n.body)
        self.assertIn("4 h sick, 0 h vacation", n.body)
        # Unlock and finalize again: no second bell for the same period.
        tc.unfinalize_timecard(tc.FinalizeIn(email=B, start=PS, end=PE), user=HR, db=self.db)
        self._finalize(B)
        self.assertEqual(len(self._ready()), 1)

    def test_no_hr_contact_no_bell(self):
        self.db.query(models.HrEntity).filter(models.HrEntity.id == CO).update({"hr_contact_email": ""})
        self.db.commit()
        self._finalize(A)
        self._finalize(B)
        self.assertEqual(self._ready(), [])


if __name__ == "__main__":
    unittest.main()
