"""
The Daily Briefing's "Approve: <name>'s timesheet fixes" row stops asking
about a fix that can no longer matter (Oct 15 2026 - August fixes from the
SwipeClock overlap were still listed in October): once its pay period ended
more than a week ago (payroll runs the week after a period closes), or while
its period is finalized and locked. The fix itself is never changed.

Throwaway sqlite, no network. Dates are relative to today: the rule is.

Run with: python -m unittest test_daily_briefing_punch_fixes -v
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_APP_URL", "https://nexus.test")

import database
import models
import daily_briefing
from routers import timeclock as tc

AMY = "amy@greensglobal.com"
TODAY = datetime.now(timezone.utc).date()


def period_of(d: date) -> tuple:
    s, e = tc._pay_period(d.isoformat())
    return date.fromisoformat(s), date.fromisoformat(e)


class PunchFixRowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.PunchRequest, models.TimeApproval, models.NexusEmployee):
            self.db.query(m).delete()
        self.amy = models.NexusEmployee(id="e1", work_email=AMY, first_name="Amy", last_name="Bolanos")
        self.db.add(self.amy)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _edit(self, d: date):
        day = d.isoformat()
        self.db.add(models.TimePunch(id=f"p{day}", employee_email=AMY, kind="in", at=f"{day}T09:00:00",
                                     local_date=day, voided=0, edit_status="pending",
                                     pending_at=f"{day}T08:30:00", edited_at=f"{day}T12:00:00"))

    def _request(self, d: date):
        day = d.isoformat()
        self.db.add(models.PunchRequest(id=f"r{day}", employee_email=AMY, action="add", punch_kind="out",
                                        at=f"{day}T17:00:00", local_date=day, status="pending",
                                        created_at=f"{day}T18:00:00"))

    def _rows(self):
        self.db.commit()
        return daily_briefing._punch_fix_rows(self.db, {AMY: self.amy})

    def test_this_periods_fixes_are_listed(self):
        self._edit(TODAY)
        self._request(TODAY)
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertIn("Time Sheet Fixes (2)", rows[0]["title"])

    def test_a_fix_from_a_long_closed_period_is_left_out(self):
        self._edit(TODAY - timedelta(days=60))   # August, in October
        self._request(TODAY - timedelta(days=61))
        self.assertEqual(self._rows(), [])

    def test_the_week_after_a_period_closes_is_the_cutoff(self):
        start, _ = period_of(TODAY)
        last_period_day = start - timedelta(days=1)
        self._edit(last_period_day)
        still_listed = (TODAY - last_period_day).days <= daily_briefing.PUNCH_FIX_GRACE_DAYS
        self.assertEqual(len(self._rows()), 1 if still_listed else 0)

    def test_a_finalized_period_is_left_out_even_within_the_week(self):
        start, end = period_of(TODAY)
        self._edit(TODAY)
        self.db.add(models.TimeApproval(id="f1", employee_email=AMY, period_start=start.isoformat(),
                                        period_end=end.isoformat(), kind="final", revoked=0))
        self.assertEqual(self._rows(), [])

    def test_the_fix_itself_is_untouched(self):
        self._edit(TODAY - timedelta(days=60))
        self._rows()
        p = self.db.query(models.TimePunch).one()
        self.assertEqual((p.edit_status, bool(p.pending_at)), ("pending", True))


if __name__ == "__main__":
    unittest.main()
