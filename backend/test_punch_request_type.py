"""The Type on an employee's punch request (Pranshu, Oct 13).

An employee asking to add time picks Regular / Break / Sick / Vacation /
Personal. A leave Type rides on the clock-in request as its category and is
set on the clock-in when the approver approves it, so the block lands as that
leave. Other kinds never carry a category.

    python -m pytest test_punch_request_type.py
"""
import unittest
from datetime import datetime, timedelta, timezone

from test_timesheet_review import ReviewCase, EMP, MGR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
from routers import timeclock  # noqa: E402


class PunchRequestTypeTests(ReviewCase):
    def _ask(self, kind, at, category):
        return timeclock.create_punch_request(
            timeclock.PunchRequestIn(action="add", punch_kind=kind, at=at, tz_offset_min=0,
                                     reason="Doctor in the afternoon", category=category),
            user={"email": EMP, "level": 1}, db=self.db)

    def test_a_leave_type_rides_on_the_clock_in_and_lands_on_approval(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        t_in = (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S")
        t_out = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")
        r_in = self._ask("in", t_in, "Sick")
        r_out = self._ask("out", t_out, "Sick")
        self.assertEqual(r_in["category"], "Sick")
        self.assertEqual(r_out["category"], "")            # only the clock-in carries it
        timeclock.decide_punch_request(r_in["id"], timeclock.PunchRequestDecision(status="approved"),
                                       user={"email": MGR, "level": 4}, db=self.db)
        self.db.expire_all()
        q = self.db.get(models.PunchRequest, r_in["id"])
        tp = self.db.get(models.TimePunch, q.applied_punch_id)
        self.assertEqual((tp.kind, tp.category), ("in", "Sick"))
        self.assertEqual(timeclock._leave_class(tp.category), "sick")

    def test_regular_leaves_the_category_empty(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        r = self._ask("in", (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S"), "")
        self.assertEqual(r["category"], "")


if __name__ == "__main__":
    unittest.main()
