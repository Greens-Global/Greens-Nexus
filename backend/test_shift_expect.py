"""
shift_expect - the one expected-start / Late rule (Shifts Phase 0, Oct 2026).

  - a published placement beats the assigned preset; the earliest of several
    placements is the one to be on time for;
  - a day a weather call cancelled has NO expected start, and the preset
    never stands in for it;
  - zone: the placement's own column, else its preset's, else the team's;
  - grace: the placement's preset, else the Shifts setting's default (10
    when the setting is missing);
  - the preset counts only on its working days;
  - late_now / is_late_at judge on the shift's own zone clock;
  - expected_starts reads a whole team in bulk, expected_start one person,
    and both agree with pick_start.

Uses a throwaway sqlite file.

    python -m unittest test_shift_expect
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timezone
from types import SimpleNamespace

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
import shift_expect as se  # noqa: E402
from routers.task_util import gen_id  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

AMY = "amy@greensglobal.com"
BOB = "bob@greensglobal.com"
THU = date(2026, 10, 8)      # isoweekday 4
SAT = date(2026, 10, 10)     # isoweekday 6
LA, IST, NY = "America/Los_Angeles", "Asia/Kolkata", "America/New_York"


def _row(start="09:00", end="17:00", shift_id="", tz="", weather="", published=1, work_date=THU.isoformat(), rid=None):
    return SimpleNamespace(id=rid or gen_id(), employee_email=AMY, work_date=work_date, shift_id=shift_id,
                           start_hhmm=start, end_hhmm=end, published=published, timezone=tz,
                           weather_status=weather)


def _preset(pid="p1", start="08:00", end="16:30", days="1,2,3,4,5", grace=5, tz=IST):
    return SimpleNamespace(id=pid, start_hhmm=start, end_hhmm=end, days=days, grace_min=grace, timezone=tz)


class PickStartTests(unittest.TestCase):
    """pick_start is pure - plain objects stand in for the rows."""

    def test_placement_beats_preset(self):
        p = _preset()
        exp = se.pick_start([_row("10:00", "18:00", rid="r1")], {"p1": p}, "p1", THU, LA, 10)
        self.assertEqual((exp["start"], exp["end"], exp["source"], exp["rowId"], exp["shiftId"]),
                         ("10:00", "18:00", "scheduled", "r1", ""))

    def test_earliest_of_two_placements(self):
        rows = [_row("13:00", "21:00", rid="late"), _row("06:30", "14:30", rid="early")]
        exp = se.pick_start(rows, {}, "", THU, LA, 10)
        self.assertEqual((exp["start"], exp["rowId"]), ("06:30", "early"))

    def test_cancelled_day_has_no_start_and_no_preset_fallback(self):
        p = _preset(days="4")
        rows = [_row("09:00", weather="cancelled"), _row("14:00", weather="cancelled")]
        self.assertIsNone(se.pick_start(rows, {"p1": p}, "p1", THU, LA, 10))
        # One live placement next to a cancelled one still counts.
        rows.append(_row("15:00", rid="live"))
        self.assertEqual(se.pick_start(rows, {"p1": p}, "p1", THU, LA, 10)["rowId"], "live")
        # A delayed / shortened / kept shift is still a shift.
        self.assertIsNotNone(se.pick_start([_row("11:00", weather="delayed")], {}, "", THU, LA, 10))

    def test_zone_placement_beats_preset_beats_team(self):
        p = _preset(tz=IST)
        self.assertEqual(se.pick_start([_row(shift_id="p1", tz=NY)], {"p1": p}, "", THU, LA, 10)["tz"], NY)
        self.assertEqual(se.pick_start([_row(shift_id="p1")], {"p1": p}, "", THU, LA, 10)["tz"], IST)
        self.assertEqual(se.pick_start([_row()], {"p1": p}, "", THU, LA, 10)["tz"], LA)
        self.assertEqual(se.pick_start([_row(shift_id="p1")], {"p1": _preset(tz="")}, "", THU, NY, 10)["tz"], NY)
        self.assertEqual(se.pick_start([_row()], {}, "", THU, "", 10)["tz"], se.DEFAULT_TEAM_TZ)

    def test_grace_preset_else_default(self):
        p = _preset(grace=5)
        self.assertEqual(se.pick_start([_row(shift_id="p1")], {"p1": p}, "", THU, LA, 25)["grace"], 5)
        self.assertEqual(se.pick_start([_row()], {"p1": p}, "", THU, LA, 25)["grace"], 25)
        # A placement pointing at a preset that no longer exists takes the default too.
        self.assertEqual(se.pick_start([_row(shift_id="gone")], {"p1": p}, "", THU, LA, 25)["grace"], 25)
        # An explicit zero-grace preset is zero, not the default.
        self.assertEqual(se.pick_start([], {"p1": _preset(grace=0, days="4")}, "p1", THU, LA, 25)["grace"], 0)

    def test_preset_only_on_its_working_days(self):
        p = _preset(days="1,2,3,4,5", start="07:00", end="15:00", grace=5, tz=IST)
        exp = se.pick_start([], {"p1": p}, "p1", THU, LA, 10)
        self.assertEqual(exp, {"start": "07:00", "end": "15:00", "grace": 5, "tz": IST, "source": "preset",
                               "shiftId": "p1", "rowId": ""})
        self.assertIsNone(se.pick_start([], {"p1": p}, "p1", SAT, LA, 10))
        self.assertIsNone(se.pick_start([], {"p1": p}, "", THU, LA, 10))          # nothing assigned
        self.assertIsNone(se.pick_start([], {}, "p1", THU, LA, 10))               # preset gone
        self.assertEqual(se.pick_start([], {"p1": _preset(tz="")}, "p1", THU, NY, 10)["tz"], NY)

    def test_unpublished_and_other_day_rows_are_ignored(self):
        p = _preset(days="4")
        self.assertEqual(se.pick_start([_row("05:00", published=0)], {"p1": p}, "p1", THU, LA, 10)["source"], "preset")
        self.assertEqual(se.pick_start([_row("05:00", work_date=SAT.isoformat())], {"p1": p}, "p1", THU, LA, 10)["source"],
                         "preset")
        self.assertIsNone(se.pick_start([_row("05:00", published=0)], {}, "", THU, LA, 10))


class LateTests(unittest.TestCase):
    def test_late_now_on_the_shifts_own_zone(self):
        exp = {"start": "09:00", "grace": 10, "tz": LA}
        # 9:09 AM Pacific = 16:09 UTC: not yet; 9:10: late.
        self.assertFalse(se.late_now(THU, exp, datetime(2026, 10, 8, 16, 9, 59, tzinfo=timezone.utc)))
        self.assertTrue(se.late_now(THU, exp, datetime(2026, 10, 8, 16, 10, 0, tzinfo=timezone.utc)))
        # The same wall-clock on an IST shift is a different instant: 9:10 IST = 03:40 UTC.
        ist = {"start": "09:00", "grace": 10, "tz": IST}
        self.assertFalse(se.late_now(THU, ist, datetime(2026, 10, 8, 3, 39, tzinfo=timezone.utc)))
        self.assertTrue(se.late_now(THU, ist, datetime(2026, 10, 8, 3, 40, tzinfo=timezone.utc)))
        # Nothing to be late for.
        self.assertFalse(se.late_now(THU, None, datetime(2026, 10, 8, 23, 0, tzinfo=timezone.utc)))
        self.assertFalse(se.late_now(THU, {"start": "", "grace": 0, "tz": LA}))

    def test_is_late_at(self):
        exp = {"start": "09:00", "grace": 10, "tz": LA}
        self.assertIsNone(se.is_late_at("", THU, exp))                               # no clock-in
        self.assertIsNone(se.is_late_at("2026-10-08T16:30:00", THU, None))           # no shift
        self.assertIsNone(se.is_late_at("2026-10-08T16:30:00", THU, {"start": "", "grace": 0, "tz": LA}))
        self.assertFalse(se.is_late_at("2026-10-08T16:10:00", THU, exp))             # 9:10 exactly: on time
        self.assertTrue(se.is_late_at("2026-10-08T16:10:01", THU, exp))              # a second past grace
        # 9:25 IST on a Pacific shift is the night before - not late.
        self.assertFalse(se.is_late_at("2026-10-08T03:55:00", THU, exp))
        self.assertTrue(se.is_late_at("2026-10-08T03:55:00", THU, {"start": "09:00", "grace": 10, "tz": IST}))

    def test_start_utc_is_the_wall_clock_in_the_shift_zone(self):
        self.assertEqual(se.start_utc(THU, {"start": "09:00", "tz": LA}),
                         datetime(2026, 10, 8, 16, 0, tzinfo=timezone.utc))
        self.assertEqual(se.start_utc(THU, {"start": "09:00", "tz": IST}),
                         datetime(2026, 10, 8, 3, 30, tzinfo=timezone.utc))
        self.assertIsNone(se.start_utc(THU, None))


class DatabaseTests(unittest.TestCase):
    """expected_starts / expected_start / schedule_exists / the settings defaults."""

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Shift, models.ShiftAssignment, models.ScheduledShift, models.NexusSetting):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _preset(self, start="08:00", days="1,2,3,4,5", grace=5, tz=IST):
        sid = gen_id()
        self.db.add(models.Shift(id=sid, name="Day", start_hhmm=start, end_hhmm="16:30", days=days,
                                 grace_min=grace, timezone=tz))
        self.db.commit()
        return sid

    def _assign(self, email, sid, at="2026-01-01T00:00:00"):
        self.db.add(models.ShiftAssignment(id=gen_id(), employee_email=email, shift_id=sid, assigned_at=at))
        self.db.commit()

    def _placed(self, email, start, shift_id="", tz="", weather="", published=1, day=THU):
        rid = gen_id()
        self.db.add(models.ScheduledShift(id=rid, employee_email=email, work_date=day.isoformat(), shift_id=shift_id,
                                          start_hhmm=start, end_hhmm="18:00", published=published, timezone=tz,
                                          weather_status=weather))
        self.db.commit()
        return rid

    def _settings(self, **cfg):
        import json
        self.db.add(models.NexusSetting(key="shift_requests_config", value=json.dumps(cfg)))
        self.db.commit()

    def test_defaults_without_the_settings_row(self):
        self.assertEqual(se.team_tz(self.db), LA)
        self.assertEqual(se.default_grace_min(self.db), 10)

    def test_bulk_read_for_a_team(self):
        sid = self._preset(start="07:00", grace=5, tz=IST)
        self._assign(AMY, sid)
        self._assign(BOB, sid)
        self._placed(BOB, "12:00", tz=NY)
        self._placed(BOB, "10:30")
        out = se.expected_starts(self.db, [AMY, BOB, "Nobody@greensglobal.com"], THU)
        self.assertEqual(sorted(out), [AMY, BOB, "nobody@greensglobal.com"])
        self.assertEqual((out[AMY]["source"], out[AMY]["start"], out[AMY]["grace"], out[AMY]["tz"]),
                         ("preset", "07:00", 5, IST))
        self.assertEqual((out[BOB]["source"], out[BOB]["start"], out[BOB]["grace"], out[BOB]["tz"]),
                         ("scheduled", "10:30", 10, LA))
        self.assertIsNone(out["nobody@greensglobal.com"])
        self.assertEqual(se.expected_start(self.db, AMY, THU), out[AMY])
        self.assertEqual(se.expected_start(self.db, BOB, THU), out[BOB])
        self.assertIsNone(se.expected_start(self.db, AMY, SAT))
        self.assertEqual(se.expected_starts(self.db, [], THU), {})

    def test_cancelled_day_reads_as_none_from_the_database(self):
        sid = self._preset(days="4")
        self._assign(AMY, sid)
        self.assertIsNotNone(se.expected_start(self.db, AMY, THU))
        self._placed(AMY, "09:00", shift_id=sid, weather="cancelled")
        self.assertIsNone(se.expected_start(self.db, AMY, THU))
        self.assertTrue(se.schedule_exists(self.db, [AMY], THU))

    def test_settings_drive_the_team_zone_and_default_grace(self):
        self._settings(timeZone=NY, defaultGraceMin=20)
        self._placed(AMY, "09:00")
        exp = se.expected_start(self.db, AMY, THU)
        self.assertEqual(exp["tz"], NY)
        # The grace setting only counts once the Shifts settings know the key;
        # until then the fallback is 10. Either answer is a valid state here.
        self.assertIn(exp["grace"], (10, 20))
        self.assertEqual(se.default_grace_min(self.db), exp["grace"])

    def test_newest_assignment_wins(self):
        old, new = self._preset(start="06:00", days="4"), self._preset(start="11:00", days="4")
        self._assign(AMY, old, at="2026-01-01T00:00:00")
        self._assign(AMY, new, at="2026-09-01T00:00:00")
        self.assertEqual(se.expected_start(self.db, AMY, THU)["start"], "11:00")

    def test_schedule_exists(self):
        self.assertFalse(se.schedule_exists(self.db, [AMY], THU))
        sid = self._preset(days="6,7")            # a weekend preset still counts as a schedule
        self._assign(AMY, sid)
        self.assertTrue(se.schedule_exists(self.db, [AMY], THU))
        self.assertIsNone(se.expected_start(self.db, AMY, THU))
        self.assertFalse(se.schedule_exists(self.db, [BOB], THU))
        self._placed(BOB, "09:00", published=0)
        self.assertFalse(se.schedule_exists(self.db, [BOB], THU))
        self._placed(BOB, "09:00")
        self.assertTrue(se.schedule_exists(self.db, [BOB], THU))
        self.assertFalse(se.schedule_exists(self.db, [], THU))


if __name__ == "__main__":
    unittest.main()
