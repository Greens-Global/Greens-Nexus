"""Custom date range on an hourly Time Sheet (Neil, 11/05/2026) -
routers/timeclock._range_card and GET /timeclock/payroll?custom=true.

A range is a VIEW: overtime still comes from the full Sunday-Saturday week,
so a range that starts mid-week shows the overtime that week really earned.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_timesheet_custom_range.py -q
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
from fastapi import HTTPException  # noqa: E402
from routers.timeclock import _compute_timecard, _range_card, payroll_timecard  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EM = "range.hourly@greensglobal.com"
ADMIN = {"email": "range.admin@greensglobal.com", "level": 5}
DAYS = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]   # Mon-Fri, week of Sun 09/13


def _punch(db, day, hours, start_h=4):
    db.add(models.TimePunch(id=f"{day}-in", employee_email=EM, kind="in", at=f"{day}T{start_h:02d}:00:00",
                            local_date=day, tz_offset_min=0, voided=0, created_at=f"{day}T{start_h:02d}:00:00"))
    db.add(models.TimePunch(id=f"{day}-out", employee_email=EM, kind="out", at=f"{day}T{start_h + hours:02d}:00:00",
                            local_date=day, tz_offset_min=0, voided=0, created_at=f"{day}T{start_h + hours:02d}:00:00"))


class CustomRangeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db = database.SessionLocal()
        try:
            # Federal rule: overtime only past 40 hours in the week, so the
            # Friday of a 5 x 10-hour week is all overtime.
            db.add(models.PayrollRate(employee_email=EM, hourly_rate=20.0, overtime_rule="federal", pay_type="hourly"))
            for d in DAYS:
                _punch(db, d, 10)
            db.commit()
        finally:
            db.close()

    def _card(self, start, end):
        db = database.SessionLocal()
        try:
            return _range_card(db, EM, start, end)
        finally:
            db.close()

    def test_mid_week_start_keeps_the_weeks_overtime(self):
        c = self._card("2026-09-18", "2026-09-18")
        t = c["totals"]
        self.assertEqual((t["regMin"], t["otMin"]), (0, 600))   # alone it would read 10 regular hours
        self.assertEqual(t["totalPay"], 300.0)                   # 10 h x $20 x 1.5
        self.assertEqual([d["date"] for d in c["days"]], ["2026-09-18"])
        self.assertEqual(c["customRange"], {"start": "2026-09-18", "end": "2026-09-18"})

    def test_two_ranges_add_up_to_the_week(self):
        a, b = self._card("2026-09-13", "2026-09-16"), self._card("2026-09-17", "2026-09-19")
        db = database.SessionLocal()
        try:
            whole = _compute_timecard(db, EM, "2026-09-13", "2026-09-19")["totals"]
        finally:
            db.close()
        for k in ("regMin", "otMin", "workedMin", "totalPay"):
            self.assertAlmostEqual(a["totals"][k] + b["totals"][k], whole[k], places=2, msg=k)

    def test_limits(self):
        with self.assertRaises(HTTPException):
            self._card("2026-09-18", "2026-09-10")
        with self.assertRaises(HTTPException):
            self._card("2025-01-01", "2026-09-18")

    def test_endpoint_is_a_view(self):
        db = database.SessionLocal()
        try:
            c = payroll_timecard(email=EM, start="2026-09-16", end="2026-09-30", custom=True, user=ADMIN, _su={}, db=db)
        finally:
            db.close()
        self.assertIn("customRange", c)
        self.assertNotIn("review", c)
        self.assertNotIn("advanceRepayments", c)
        self.assertEqual(c["totals"]["otMin"], 600)   # Wed-Fri of that week: Friday is the overtime


if __name__ == "__main__":
    unittest.main()
