"""Today's shift on GET /timeclock/status (Neil, 11/02/2026, mock
https://claude.ai/artifact/PwncxMck8YaSkFkQ8hmTHE section 1): the clock draws
a shift track from the expected start to the expected end, so the status
payload carries `todayShift` from the ONE rule, shift_expect.

  - a published placement today wins (source 'scheduled'), times in UTC
  - an overnight placement ends the morning after
  - no placement: the usual-hours preset on its working days ('preset')
  - a weather-cancelled day, no schedule at all, or a placement with no
    end: null - the client draws no track (never a made-up 8 hours)

Run with: python -m pytest test_status_today_shift.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

# A throwaway sqlite of its own (CLAUDE.md: one test file per process).
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth               # noqa: E402
import cache              # noqa: E402
import database           # noqa: E402
import main               # noqa: E402
import models             # noqa: E402
import shift_expect       # noqa: E402

AMY = "ts.amy@greensglobal.com"
TZ = "America/Chicago"
PRESET = "preset-ts"


class TodayShiftStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = AMY
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.Shift, models.ShiftAssignment, models.ScheduledShift,
                  models.TimePunch, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="emp-amy", first_name="Amy", last_name="Lee", work_email=AMY,
                                         status="active", deleted_at="", country="US"))
        self.db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        # The status route's workday with no punches and a 0 offset is the UTC date.
        self.today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev

    def _place(self, start, end, weather="", rid="s-1"):
        self.db.add(models.ScheduledShift(id=rid, employee_email=AMY, work_date=self.today, start_hhmm=start,
                                          end_hhmm=end, published=1, timezone=TZ, created_by="test",
                                          weather_status=weather))
        self.db.commit()

    def _shift(self):
        return self.client.get("/timeclock/status").json()["todayShift"]

    def _utc(self, hhmm, day_offset=0):
        dd = datetime.strptime(self.today, "%Y-%m-%d").date() + timedelta(days=day_offset)
        local = datetime.strptime(f"{dd.isoformat()} {hhmm}", "%Y-%m-%d %H:%M")
        return shift_expect.to_utc(local, TZ).strftime("%Y-%m-%dT%H:%M:%SZ")

    def test_published_placement_gives_start_and_end_in_utc(self):
        self._place("09:00", "17:30")
        s = self._shift()
        self.assertEqual((s["start"], s["end"], s["source"], s["date"]), ("09:00", "17:30", "scheduled", self.today))
        self.assertEqual(s["startUtc"], self._utc("09:00"))
        self.assertEqual(s["endUtc"], self._utc("17:30"))

    def test_overnight_placement_ends_the_morning_after(self):
        self._place("22:00", "06:00")
        s = self._shift()
        self.assertEqual(s["startUtc"], self._utc("22:00"))
        self.assertEqual(s["endUtc"], self._utc("06:00", day_offset=1))

    def test_preset_on_a_working_day_when_nothing_is_placed(self):
        self.db.add(models.Shift(id=PRESET, name="Day", code="D", start_hhmm="07:00", end_hhmm="15:30",
                                 grace_min=5, timezone=TZ, days="1,2,3,4,5,6,7"))
        self.db.add(models.ShiftAssignment(id="a-1", employee_email=AMY, shift_id=PRESET,
                                           assigned_at="2026-01-01T00:00:00"))
        self.db.commit()
        s = self._shift()
        self.assertEqual((s["start"], s["end"], s["source"]), ("07:00", "15:30", "preset"))
        self.assertEqual(s["endUtc"], self._utc("15:30"))

    def test_nothing_expected_is_null(self):
        self.assertIsNone(self._shift(), "no schedule at all")
        self._place("09:00", "17:00", weather="cancelled")
        self.assertIsNone(self._shift(), "a weather-cancelled day is not a shift")

    def test_a_placement_with_no_end_draws_no_track(self):
        self._place("09:00", "")
        self.assertIsNone(self._shift())


if __name__ == "__main__":
    unittest.main()
