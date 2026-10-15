"""
An open shift's breaks never shrink the day's finished hours (Oct 14).

`_day_summaries` (the status payload's per-day `workedMin`, which the
dashboard's Time Clock / My Time tiles add the live shift to) used to fold the
still-open shift's breaks into the day's break total and subtract them from
the CLOSED segments' worked time - a 1h morning shift plus an open one with a
30m break read 30m. The pay engine (_compute_timecard) records the open
segment as 0 worked with its own break and leaves the others alone; the
summary now matches it. breakMin still reports every break of the day.

Pure function, no database rows needed.

    python -m unittest test_day_summary_open_shift
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import models  # noqa: E402
from routers.timeclock import _day_summaries  # noqa: E402

EMP = "open.shift@greensglobal.com"
DAY = "2026-10-14"


def _p(pid, kind, hhmm):
    at = f"{DAY}T{hhmm}:00"
    return models.TimePunch(id=pid, employee_email=EMP, kind=kind, at=at, local_date=DAY,
                            tz_offset_min=0, voided=0, created_at=at, geo_status="", source="web",
                            adjusted_by="", edit_status="")


class OpenShiftBreakTests(unittest.TestCase):
    def test_open_shift_break_does_not_reduce_closed_hours(self):
        punches = [
            _p("1", "in", "08:00"), _p("2", "out", "09:00"),              # 60 closed
            _p("3", "in", "10:00"), _p("4", "break_start", "11:00"), _p("5", "break_end", "11:30"),   # open
        ]
        day = _day_summaries(punches)[DAY]
        self.assertEqual(day["workedMin"], 60)
        self.assertEqual(day["breakMin"], 30)
        self.assertIn("missing_out", day["flags"])

    def test_closed_shift_still_deducts_its_break(self):
        punches = [
            _p("1", "in", "08:00"), _p("2", "break_start", "10:00"), _p("3", "break_end", "10:30"),
            _p("4", "out", "12:00"),
        ]
        day = _day_summaries(punches)[DAY]
        self.assertEqual(day["workedMin"], 210)
        self.assertEqual(day["breakMin"], 30)


if __name__ == "__main__":
    unittest.main()
