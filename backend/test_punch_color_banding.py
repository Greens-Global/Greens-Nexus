"""People > Time > Payroll color banding (Pranshu, Oct 19 2026): each punch in
a time sheet's punchMeta says whether it is exactly as the clock took it
("clock" - green on the card) and whether HR entered or last changed it
("byHr" - blue). HR is timesheet_review.is_hr: the company's HR contact, an
administrator or a Full HR grant; a manager is not HR.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_punch_color_banding.py -q
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
from routers import timeclock as tc  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

CO = "pcb-co"
EMP = "pcb.emp@greensglobal.com"
HR = "pcb.hr@greensglobal.com"        # the company's HR contact
MGR = "pcb.mgr@greensglobal.com"      # the employee's manager - not HR
DAY = "2026-09-15"


def _punch(db, pid, kind, hhmm, source="web", **kw):
    at = f"{DAY}T{hhmm}:00"
    db.add(models.TimePunch(id=pid, employee_email=EMP, kind=kind, at=at, local_date=DAY, tz_offset_min=0,
                            voided=0, created_at=at, source=source, geo_status="", **kw))


class ColorBandingTests(unittest.TestCase):
    def setUp(self):
        self.db = db = database.SessionLocal()
        db.add(models.HrEntity(id=CO, name="Banding Co", hr_contact_email=HR))
        db.add(models.NexusEmployee(id="pcb-emp", first_name="Erin", last_name="Band", work_email=EMP,
                                    company=CO, status="active", deleted_at=""))
        db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", hourly_rate=20.0,
                                  overtime_rule="federal", currency="USD"))
        _punch(db, "pcb-1", "in", "08:00")                                         # straight off the clock
        _punch(db, "pcb-2", "out", "12:00", adjusted_by=HR, adjusted_at="2026-09-16T10:00:00",
               original_at=f"{DAY}T12:10:00")                                     # changed by HR
        _punch(db, "pcb-3", "in", "13:00", adjusted_by=MGR, adjusted_at="2026-09-16T10:00:00",
               original_at=f"{DAY}T13:05:00")                                     # changed by the manager
        _punch(db, "pcb-4", "out", "17:00", source="manual", created_by=HR)        # entered by HR
        db.commit()

    def tearDown(self):
        db = self.db
        db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP).delete(synchronize_session=False)
        db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == EMP).delete(synchronize_session=False)
        (db.query(models.NexusEmployee).execution_options(include_deleted=True)
           .filter(models.NexusEmployee.work_email == EMP).delete(synchronize_session=False))
        db.query(models.HrEntity).filter(models.HrEntity.id == CO).delete(synchronize_session=False)
        db.commit()
        db.close()

    def test_clock_and_hr_flags(self):
        meta = tc._compute_timecard(self.db, EMP, "2026-09-13", "2026-09-26")["punchMeta"]
        flags = {pid: (meta[pid]["clock"], meta[pid]["byHr"]) for pid in ("pcb-1", "pcb-2", "pcb-3", "pcb-4")}
        self.assertEqual(flags, {
            "pcb-1": (True, False),    # green
            "pcb-2": (False, True),    # blue - HR changed it
            "pcb-3": (False, False),   # a manager's change is neither
            "pcb-4": (False, True),    # blue - HR entered it
        })


if __name__ == "__main__":
    unittest.main()
