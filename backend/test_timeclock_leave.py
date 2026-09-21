"""Time Clock: Sick / Vacation hours as their own pay class (Charmi, Sep 21).

A punch pair tagged with a Sick / Vacation job category is paid leave: it shows
as its own "Total Sick hours" / "Total Vacation hours" line like SwipeClock,
is paid at the base rate, and never feeds the overtime split - but it still
counts in the day's / period's workedMin (the attested total).

    python -m unittest test_timeclock_leave
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database
import main  # noqa: F401 - app import wires the DB
import models
from routers.timeclock import _compute_timecard, _leave_class

models.Base.metadata.create_all(bind=database.engine)

EMP = "leavetest.hourly@greensglobal.com"
RATE = 21.5
START, END = "2026-09-06", "2026-09-12"   # Sunday-anchored week


class LeaveClassTests(unittest.TestCase):
    def test_classification(self):
        for cat, want in (("Sick Day", "sick"), ("sick", "sick"), ("Sick Leave", "sick"),
                          ("Vacation", "vacation"), ("PTO", "vacation"), ("Annual Leave", "vacation"),
                          ("Paid Time Off", "vacation"),
                          ("Operations-GS", ""), ("", ""), (None, ""), ("Sickle cell clinic", "")):
            self.assertEqual(_leave_class(cat), want, cat)


class LeaveTimecardTests(unittest.TestCase):
    def setUp(self):
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id=f"emp-{EMP}", first_name="Vicki", last_name="Test",
                                        work_email=EMP, company="", status="active", deleted_at=""))
            db.add(models.PayrollRate(employee_email=EMP, hourly_rate=RATE, overtime_rule="ca",
                                      pay_type="hourly"))
            # Sun: 4h Vacation. Mon-Thu: 8h worked. Fri: 8h Sick Day. Sat: 8h worked.
            # Worked = 40h exactly -> no weekly OT. If leave leaked into the OT
            # split the week would read 52h and pay 12h at 1.5x.
            plan = [("2026-09-06", 4, "Vacation"),
                    ("2026-09-07", 8, ""), ("2026-09-08", 8, ""), ("2026-09-09", 8, ""), ("2026-09-10", 8, ""),
                    ("2026-09-11", 8, "Sick Day"),
                    ("2026-09-12", 8, "")]
            for i, (day, hours, cat) in enumerate(plan):
                db.add(models.TimePunch(id=f"leave-in-{i}", employee_email=EMP, kind="in",
                                        at=f"{day}T15:00:00", local_date=day, tz_offset_min=0,
                                        category=cat, voided=0, created_at=f"{day}T15:00:00"))
                db.add(models.TimePunch(id=f"leave-out-{i}", employee_email=EMP, kind="out",
                                        at=f"{day}T{15 + hours:02d}:00:00", local_date=day, tz_offset_min=0,
                                        voided=0, created_at=f"{day}T{15 + hours:02d}:00:00"))
            db.commit()
        finally:
            db.close()

    def tearDown(self):
        self._cleanup()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email == EMP).delete(synchronize_session=False))
            db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == EMP).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_leave_is_its_own_pay_class_and_stays_out_of_overtime(self):
        db = database.SessionLocal()
        try:
            card = _compute_timecard(db, EMP, START, END)
        finally:
            db.close()
        T = card["totals"]
        self.assertEqual(T["regMin"], 40 * 60)
        self.assertEqual(T["otMin"], 0)
        self.assertEqual(T["dtMin"], 0)
        self.assertEqual(T["sickMin"], 8 * 60)
        self.assertEqual(T["vacationMin"], 4 * 60)
        # attested / TOTALS line = work + leave, like SwipeClock's 52:00
        self.assertEqual(T["workedMin"], 52 * 60)
        self.assertAlmostEqual(T["regPay"], 40 * RATE, places=2)
        self.assertAlmostEqual(T["sickPay"], 8 * RATE, places=2)
        self.assertAlmostEqual(T["vacationPay"], 4 * RATE, places=2)
        self.assertAlmostEqual(T["totalPay"], 52 * RATE, places=2)

        days = {d["date"]: d for d in card["days"]}
        fri = days["2026-09-11"]
        self.assertEqual((fri["sickMin"], fri["regMin"], fri["otMin"], fri["workedMin"]), (480, 0, 0, 480))
        seg = fri["segments"][0]
        self.assertEqual(seg["payClass"], "sick")
        self.assertEqual(seg["leaveMin"], 480)
        self.assertEqual(seg["regMin"], 0)
        self.assertAlmostEqual(seg["amount"], 8 * RATE, places=2)
        sun = days["2026-09-06"]
        self.assertEqual((sun["vacationMin"], sun["regMin"], sun["workedMin"]), (240, 0, 240))
        mon = days["2026-09-07"]
        self.assertEqual(mon["segments"][0]["payClass"], "")
        self.assertEqual((mon["regMin"], mon["sickMin"], mon["vacationMin"]), (480, 0, 0))


if __name__ == "__main__":
    unittest.main()
