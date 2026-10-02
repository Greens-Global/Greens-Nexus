"""
BOD/EOD messages and Work Logs follow the SHIFT's day, in any time zone (Oct 2).

Pranshu works 6:30 PM - 2:30 AM IST. His End-of-day message, sent at 2:30 AM
on Oct 2, was filed under Oct 2, and People > Work Logs paired it with that
2:30 AM clock-out - every night-shift EOD showed a day late, disagreeing with
the timecard (which already puts an overnight shift on the day it started).
The rule now, everywhere: a shift's day is its clock-in's local date, from the
punching device's own offset; a message belongs to the shift it is written in.

Uses a throwaway sqlite file.

    python -m unittest test_shift_day
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
import shift_day  # noqa: E402
from routers import timeclock  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

IN_EMP = "night.india@greensglobal.com"     # IST: getTimezoneOffset() = -330
US_EMP = "night.pacific@greensglobal.com"   # PDT: getTimezoneOffset() = 420
IST, PDT = -330, 420


def _punch(db, email, pid, kind, utc_at, tz):
    db.add(models.TimePunch(id=pid, employee_email=email, kind=kind, at=utc_at,
                            local_date=shift_day.local_date_at(utc_at, tz),
                            tz_offset_min=tz, voided=0, created_at=utc_at))


def _send(db, email, kind, utc_now, tz):
    """POST /timeclock/bod as `email` at the frozen moment `utc_now`."""
    body = timeclock.BodIn(kind=kind, message=f"{kind} message", sent=True, tz_offset_min=tz)
    with mock.patch.object(timeclock, "_now_iso", return_value=utc_now):
        r = timeclock.record_bod(body, user={"email": email}, db=db)
    return db.query(models.TimeBod).filter(models.TimeBod.id == r["id"]).first()


class ShiftDayTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimeBod, models.TimePunch, models.NexusEmployee, models.NexusNotification):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        self.db.close()

    # ── India, 6:30 PM - 2:30 AM IST on Oct 1 (13:00 - 21:00 UTC) ──────────
    def _india_shift(self, out=True):
        _punch(self.db, IN_EMP, "i-in", "in", "2026-10-01T13:00:00", IST)        # 6:30 PM IST Oct 1
        if out:
            _punch(self.db, IN_EMP, "i-out", "out", "2026-10-01T21:00:00", IST)  # 2:30 AM IST Oct 2
        self.db.commit()

    def test_a_2_30_am_eod_is_filed_under_the_evening_the_shift_began(self):
        self._india_shift(out=False)
        bod = _send(self.db, IN_EMP, "bod", "2026-10-01T12:58:00", IST)          # 6:28 PM, before clock-in
        eod = _send(self.db, IN_EMP, "eod", "2026-10-01T20:59:00", IST)          # 2:29 AM Oct 2, shift open
        self.assertEqual((bod.local_date, eod.local_date), ("2026-10-01", "2026-10-01"))
        self.assertEqual(eod.created_at, "2026-10-01T20:59:00")                   # real send time kept

    def test_an_eod_sent_just_after_the_clock_out_still_belongs_to_that_shift(self):
        self._india_shift()
        eod = _send(self.db, IN_EMP, "eod", "2026-10-01T21:10:00", IST)          # 2:40 AM, after the out
        self.assertEqual(eod.local_date, "2026-10-01")

    def test_the_next_evening_bod_starts_a_new_day(self):
        self._india_shift()
        bod = _send(self.db, IN_EMP, "bod", "2026-10-02T12:55:00", IST)          # 6:25 PM Oct 2
        self.assertEqual(bod.local_date, "2026-10-02")

    def test_the_timecard_drawer_pairs_the_after_midnight_clock_out_with_its_day(self):
        self._india_shift()
        _send(self.db, IN_EMP, "eod", "2026-10-01T20:59:00", IST)
        day1 = timeclock.bod_for_day(email=IN_EMP, date="2026-10-01", user={"email": IN_EMP}, db=self.db)
        day2 = timeclock.bod_for_day(email=IN_EMP, date="2026-10-02", user={"email": IN_EMP}, db=self.db)
        self.assertEqual((day1["punchInAt"], day1["punchOutAt"]), ("2026-10-01T13:00:00", "2026-10-01T21:00:00"))
        self.assertEqual((day1["punchInTz"], day1["punchOutTz"]), (IST, IST))
        self.assertIsNotNone(day1["eod"])
        # Oct 2 does not borrow the previous night's clock-out or EOD.
        self.assertEqual((day2["punchOutAt"], day2["eod"]), ("", None))

    def test_work_logs_pair_by_shift(self):
        # Two consecutive nights: each day's EOD sits beside its own clock-out.
        self._india_shift()
        _punch(self.db, IN_EMP, "i-in2", "in", "2026-10-02T13:00:00", IST)
        _punch(self.db, IN_EMP, "i-out2", "out", "2026-10-02T21:38:00", IST)     # 3:08 AM Oct 3
        self.db.commit()
        rows = (self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == IN_EMP)
                .order_by(models.TimePunch.at).all())
        b = shift_day.shift_bounds_by_day(rows)
        self.assertEqual(b["2026-10-01"]["last_out"], "2026-10-01T21:00:00")
        self.assertEqual(b["2026-10-02"]["last_out"], "2026-10-02T21:38:00")
        self.assertNotIn("2026-10-03", b)

    # ── US Pacific, 10 PM - 6 AM PDT on Oct 1 (05:00 - 13:00 UTC on Oct 2) ──
    def test_a_us_night_shift_files_under_its_own_evening_too(self):
        _punch(self.db, US_EMP, "u-in", "in", "2026-10-02T05:00:00", PDT)        # 10:00 PM PDT Oct 1
        self.db.commit()
        eod = _send(self.db, US_EMP, "eod", "2026-10-02T12:55:00", PDT)          # 5:55 AM PDT Oct 2
        self.assertEqual(eod.local_date, "2026-10-01")

    def test_status_after_midnight_still_counts_the_evening_bod(self):
        # Inside the night shift after midnight, "today" is still the shift's day:
        # the BOD sent at 6:28 PM satisfies it, so no second BOD is asked for.
        self._india_shift(out=False)
        _send(self.db, IN_EMP, "bod", "2026-10-01T12:58:00", IST)
        with mock.patch.object(timeclock, "_now_iso", return_value="2026-10-01T19:30:00"):   # 1:00 AM IST
            self.assertEqual(shift_day.shift_day(self.db, IN_EMP, "2026-10-01T19:30:00", IST), "2026-10-01")

    def test_the_backfill_moves_only_messages_inside_another_days_shift(self):
        import backfill_bod_shift_day as bf
        self._india_shift()
        # Old rows, dated the way the bug filed them (the send-time calendar date).
        for rid, kind, at, day in (("old-eod", "eod", "2026-10-01T20:59:00", "2026-10-02"),
                                   ("old-bod", "bod", "2026-10-01T12:58:00", "2026-10-01"),
                                   ("loose", "eod", "2026-10-03T08:00:00", "2026-10-03")):
            self.db.add(models.TimeBod(id=rid, employee_email=IN_EMP, kind=kind, local_date=day,
                                       message="m", created_at=at))
        self.db.commit()
        moves = {r.id: (old, new) for r, old, new in bf.plan(self.db)}
        self.assertEqual(moves, {"old-eod": ("2026-10-02", "2026-10-01")})

    def test_the_wall_clock_date_comes_from_the_device_offset(self):
        self.assertEqual(shift_day.local_date_at("2026-10-01T21:00:00", IST), "2026-10-02")
        self.assertEqual(shift_day.local_date_at("2026-10-02T05:00:00", PDT), "2026-10-01")


if __name__ == "__main__":
    unittest.main()
