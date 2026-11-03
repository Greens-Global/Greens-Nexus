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
from unittest import mock
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
import today_shift        # noqa: E402

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
        today_shift.clear_cache()

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

    def _on(self, day):
        """The workday's own entry in todayShifts (a preset also runs the day
        before and after, which may sit in the list near midnight)."""
        got = [x for x in self.client.get("/timeclock/status").json()["todayShifts"] if x["date"] == day]
        self.assertEqual(len(got), 1)
        return got[0]

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
        s = self._on(self.today)
        self.assertEqual((s["start"], s["end"], s["source"]), ("07:00", "15:30", "preset"))
        self.assertEqual(s["endUtc"], self._utc("15:30"))

    def test_nothing_expected_is_null(self):
        self.assertIsNone(self._shift(), "no schedule at all")
        self._place("09:00", "17:00", weather="cancelled")
        self.assertIsNone(self._shift(), "a weather-cancelled day is not a shift")

    def test_a_placement_with_no_end_draws_no_track(self):
        self._place("09:00", "")
        self.assertIsNone(self._shift())


    # ── split shifts, day edges, cache and safety (review, 11/02/2026) ──
    def test_split_shift_lists_every_placement(self):
        """A second placement later the same day is its own shift, never
        'past your shift end' of the first: todayShifts carries both."""
        self._place("08:00", "12:00", rid="s-am")
        self._place("16:00", "20:00", rid="s-pm")
        body = self.client.get("/timeclock/status").json()
        mine = [x for x in body["todayShifts"] if x["date"] == self.today]
        self.assertEqual([(x["start"], x["end"]) for x in mine], [("08:00", "12:00"), ("16:00", "20:00")])
        self.assertIn(body["todayShift"], mine)

    def test_expected_shifts_keeps_the_one_rule(self):
        d = datetime.strptime(self.today, "%Y-%m-%d").date()
        self._place("16:00", "20:00", rid="s-pm")
        self._place("08:00", "12:00", rid="s-am")
        self._place("13:00", "14:00", weather="cancelled", rid="s-wx")
        got = shift_expect.expected_shifts(self.db, AMY, [d])[d]
        self.assertEqual([(x["start"], x["source"]) for x in got], [("08:00", "scheduled"), ("16:00", "scheduled")])
        # Late / the early hint still read the earliest, unchanged.
        self.assertEqual(shift_expect.expected_start(self.db, AMY, d)["start"], "08:00")

    def test_pick_running_then_soon_then_last_ended(self):
        def sp(s, e):
            return {"startUtc": s, "endUtc": e, "date": "2026-11-02"}
        am, pm = sp("2026-11-02T08:00:00Z", "2026-11-02T12:00:00Z"), sp("2026-11-02T16:00:00Z", "2026-11-02T20:00:00Z")
        at = lambda h, m=0: datetime(2026, 11, 2, h, m, tzinfo=timezone.utc)   # noqa: E731
        self.assertIs(today_shift.pick([am, pm], at(9)), am, "running")
        self.assertIs(today_shift.pick([am, pm], at(17)), pm, "the second placement while it runs")
        self.assertIs(today_shift.pick([am, pm], at(13)), pm, "the next one within four hours")
        self.assertIs(today_shift.pick([am, pm], at(21)), pm, "the last one that ended")
        self.assertIs(today_shift.pick([am], at(3)), am, "nothing ended yet: the next one")
        self.assertIsNone(today_shift.pick([], at(9)))
        # 23:50 before a midnight shift: the upcoming one, not the one that ended.
        late = sp("2026-11-02T14:00:00Z", "2026-11-02T18:00:00Z")
        midnight = {"startUtc": "2026-11-03T00:00:00Z", "endUtc": "2026-11-03T08:00:00Z", "date": "2026-11-03"}
        self.assertIs(today_shift.pick([late, midnight], at(23, 50)), midnight)

    def test_spans_frame_the_day_before_and_after(self):
        """The day before's overnight shift stays while it ended within six
        hours (or is still running past midnight); the day after's joins
        when it starts within six hours."""
        d = date_ = datetime(2026, 11, 3).date()
        prev, nxt = d - timedelta(days=1), d + timedelta(days=1)
        night = {"start": "22:00", "end": "06:00", "tz": "UTC", "source": "scheduled"}
        early = {"start": "01:00", "end": "09:00", "tz": "UTC", "source": "scheduled"}
        by_day = {prev: [night], date_: [], nxt: [early]}
        at = lambda dd, h, m=0: datetime(dd.year, dd.month, dd.day, h, m, tzinfo=timezone.utc)   # noqa: E731
        self.assertEqual([x["date"] for x in today_shift.spans(by_day, d, at(d, 0, 30))], [prev.isoformat()],
                         "00:30, a 22:00 shift from the day before is still running")
        self.assertEqual([x["date"] for x in today_shift.spans(by_day, d, at(d, 6, 5))], [prev.isoformat()],
                         "just clocked out of it at 06:00 - still drawn, as Shift complete")
        self.assertEqual(today_shift.spans(by_day, d, at(d, 13)), [], "gone six hours after its end")
        self.assertEqual([x["date"] for x in today_shift.spans(by_day, d, at(d, 20))], [nxt.isoformat()],
                         "the day after's 01:00 shift, five hours out")

    def test_cached_per_person_and_workday_for_a_minute(self):
        self._place("09:00", "17:30", rid="s-1")
        first = self._shift()
        self._place("10:00", "18:00", rid="s-2")
        self.assertEqual(self._shift(), first, "a poll inside the minute reads the cached answer")
        real = today_shift.time.monotonic
        with mock.patch.object(today_shift.time, "monotonic", lambda: real() + today_shift.CACHE_SECONDS + 1):
            mine = [x for x in self.client.get("/timeclock/status").json()["todayShifts"] if x["date"] == self.today]
        self.assertEqual(len(mine), 2, "read again once the minute is up")

    def test_a_failed_lookup_never_breaks_the_status(self):
        """The read runs in a savepoint: a database error inside it leaves
        the status answering (on Postgres it would otherwise abort the whole
        transaction and every later query of the request)."""
        from sqlalchemy import text

        def boom(db, *a, **k):
            db.execute(text("select * from no_such_table_today_shift"))

        with mock.patch.object(today_shift, "_compute", boom):
            r = self.client.get("/timeclock/status")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIsNone(body["todayShift"])
        self.assertEqual(body["todayShifts"], [])
        self.assertIsNone(body["earlyWarning"])
        self.assertIn("allowed", body)


if __name__ == "__main__":
    unittest.main()
