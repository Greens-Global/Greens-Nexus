"""Approving punch requests when one stray request sits among real pairs
(Pranshu, Oct 13).

Five pending requests, as on the Action Log that could not approve anything:
two overnight shifts (6:30 PM to 2:00 AM Pacific) asked for as clock-in +
clock-out, and one lone 9:00 AM clock-in between them with no clock-out.
Approving either clock-in pulled all five into one chain; the lone clock-in
sank it, and the request on its own failed too. Each pair now goes in with
its own other half; the lone clock-in still cannot be approved on its own.

    python -m pytest test_punch_request_stray.py
"""
import unittest
import uuid
from datetime import date, timedelta

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
from routers import timeclock  # noqa: E402

HR = {"email": MGR, "level": 4}


class StrayRequestTests(ReviewCase):
    def setUp(self):
        super().setUp()
        d0 = date.fromisoformat(self.start) + timedelta(days=21)      # clear of the fixture's punches
        self.d = [(d0 + timedelta(days=k)).isoformat() for k in range(3)]
        d, n = self.d, 0
        self.ids = {k: f"{k}-{uuid.uuid4().hex[:8]}" for k in ("rq-in-1", "rq-out-1", "rq-stray", "rq-in-2", "rq-out-2")}
        # (id, kind, UTC time, Pacific local date) - Pacific = UTC-7
        for rid, kind, at, ld in (
            ("rq-in-1", "in", f"{d[1]}T01:30:00", d[0]),     # 6:30 PM day 0
            ("rq-out-1", "out", f"{d[1]}T09:00:00", d[1]),   # 2:00 AM day 1
            ("rq-stray", "in", f"{d[1]}T16:00:00", d[1]),    # 9:00 AM day 1, no clock-out
            ("rq-in-2", "in", f"{d[2]}T01:30:00", d[1]),     # 6:30 PM day 1
            ("rq-out-2", "out", f"{d[2]}T09:00:00", d[2]),   # 2:00 AM day 2
        ):
            n += 1
            self.db.add(models.PunchRequest(id=self.ids[rid], employee_email=EMP, employee_name="Erin Test", action="add",
                                            punch_kind=kind, at=at, local_date=ld, tz_offset_min=420,
                                            reason="worked late", status="pending",
                                            created_at=f"{d[2]}T12:00:0{n}"))
        (self.db.query(models.TimePunch)
         .filter(models.TimePunch.employee_email == EMP, models.TimePunch.local_date.in_(self.d)).delete())
        self.db.commit()

    def _decide(self, rid):
        return timeclock.decide_punch_request(self.ids[rid], timeclock.PunchRequestDecision(status="approved"),
                                              user=HR, db=self.db)

    def _status(self, rid):
        self.db.expire_all()
        return self.db.get(models.PunchRequest, self.ids[rid]).status

    def test_each_pair_goes_in_with_its_own_other_half(self):
        self._decide("rq-in-1")
        self.assertEqual((self._status("rq-in-1"), self._status("rq-out-1")), ("approved", "approved"))
        self.assertEqual(self._status("rq-stray"), "pending")
        # The approver clicking the clock-OUT of the second pair works too.
        self._decide("rq-out-2")
        self.assertEqual((self._status("rq-in-2"), self._status("rq-out-2")), ("approved", "approved"))
        live = (self.db.query(models.TimePunch)
                .filter(models.TimePunch.employee_email == EMP, models.TimePunch.voided == 0,
                        models.TimePunch.local_date.in_(self.d)).all())
        self.assertEqual(sorted((p.kind, p.at) for p in live),
                         sorted([("in", f"{self.d[1]}T01:30:00"), ("out", f"{self.d[1]}T09:00:00"),
                                 ("in", f"{self.d[2]}T01:30:00"), ("out", f"{self.d[2]}T09:00:00")]))

    def test_the_lone_clock_in_still_cannot_go_in_alone(self):
        self._decide("rq-in-1")
        self._decide("rq-in-2")
        with self.assertRaises(HTTPException) as e:
            self._decide("rq-stray")
        self.assertEqual(e.exception.status_code, 409)
        self.assertEqual(self._status("rq-stray"), "pending")


if __name__ == "__main__":
    unittest.main()
