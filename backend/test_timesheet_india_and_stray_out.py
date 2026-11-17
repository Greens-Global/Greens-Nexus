"""
Two Time Sheet fixes from 11/17/2026.

1. India is not reviewed in Nexus yet (Charmi: "India employees are still not
   using this module for billing, so approval should not reflect"): a person
   who works in India is left off the reviewer's lists (not_reviewed and
   waiting_on) while timesheet_review.REVIEW_INDIA is off.
2. A stray morning clock-out (Valinda): she forgot to clock out on 11/04 and
   pressed Clock Out a moment before her 11/05 clock-in. Adding the real 11/04
   clock-out was refused as "a clock-out before the clock-in" on 11/05.

    python -m unittest test_timesheet_india_and_stray_out
"""
import unittest
from types import SimpleNamespace as N

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402


class IndiaLeftOffTheReviewLists(ReviewCase):
    def setUp(self):
        super().setUp()
        self.ls, _le, _pt = tsr.last_closed_period(self.db, EMP)
        self.db.query(models.TimePunch).delete()
        self.db.add(models.TimePunch(id="p-in", employee_email=EMP, kind="in", at=f"{self.ls}T16:00:00",
                                     local_date=self.ls, tz_offset_min=0, created_at=f"{self.ls}T16:00:00"))
        self.db.add(models.TimePunch(id="p-out", employee_email=EMP, kind="out", at=f"{self.ls}T20:00:00",
                                     local_date=self.ls, tz_offset_min=0, created_at=f"{self.ls}T20:00:00"))
        self.db.commit()

    def _country(self, code):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).first()
        emp.country = code
        self.db.commit()

    def test_a_us_person_is_listed(self):
        self._country("US")
        self.assertIn(EMP, [x["employeeEmail"] for x in tsr.not_reviewed(self.db, MGR)])

    def test_an_india_person_is_not_listed(self):
        self._country("IN")
        self.assertNotIn(EMP, [x["employeeEmail"] for x in tsr.not_reviewed(self.db, MGR)])
        self.assertTrue(tsr.outside_review(self.db, EMP))

    def test_the_switch_brings_india_back(self):
        self._country("IN")
        prev, tsr.REVIEW_INDIA = tsr.REVIEW_INDIA, True
        try:
            self.assertIn(EMP, [x["employeeEmail"] for x in tsr.not_reviewed(self.db, MGR)])
        finally:
            tsr.REVIEW_INDIA = prev

    def test_a_submitted_india_sheet_is_not_waiting_either(self):
        self._country("US")
        tsr.submit(self.db, EMP, self.ls)
        self.db.commit()
        self.assertIn(EMP, [r.employee_email for r in tsr.waiting_on(self.db, MGR)])
        self._country("IN")
        self.assertNotIn(EMP, [r.employee_email for r in tsr.waiting_on(self.db, MGR)])


def _p(pid, kind, at, day):
    return N(id=pid, kind=kind, at=at, local_date=day)


D4, D5 = "2026-11-04", "2026-11-05"
# Valinda's 11/04 - 11/05 as they are on prod (UTC; Pacific, offset 480).
VALINDA = [
    _p("a", "in", "2026-11-04T16:38:56", D4), _p("b", "break_start", "2026-11-04T22:11:37", D4),
    _p("c", "break_end", "2026-11-05T01:41:15", D4),
    _p("d", "out", "2026-11-05T16:42:45", D5),        # the stray: 11/04's forgotten clock-out, pressed 11/05
    _p("e", "in", "2026-11-05T16:42:59", D5), _p("f", "break_start", "2026-11-05T20:48:00", D5),
    _p("g", "break_end", "2026-11-06T01:21:57", D5), _p("h", "out", "2026-11-06T01:33:46", D5),
]


class StrayMorningClockOut(unittest.TestCase):
    def _inv(self, rows):
        return timeclock._inverted_days(rows, {D4, D5})

    def test_adding_the_forgotten_clock_out_is_not_an_inversion(self):
        added = VALINDA + [_p("new", "out", "2026-11-05T01:41:00", D4)]
        self.assertEqual(self._inv(added) - self._inv(VALINDA), set())

    def test_a_real_out_before_in_is_still_caught(self):
        self.assertEqual(self._inv([_p("o", "out", f"{D5}T08:00:00", D5), _p("i", "in", f"{D5}T09:00:00", D5)]),
                         {D5})
        # ...also with a second, complete shift later that day.
        self.assertEqual(self._inv([_p("o", "out", f"{D5}T08:00:00", D5), _p("i", "in", f"{D5}T09:00:00", D5),
                                    _p("i2", "in", f"{D5}T13:00:00", D5), _p("o2", "out", f"{D5}T17:00:00", D5)]),
                         {D5})


class LoneClockOutMessage(ReviewCase):
    def test_a_lone_clock_out_on_an_empty_day_says_reject_and_add_time_off(self):
        day = "2026-11-13"
        req = models.PunchRequest(id="rq-1", employee_email=EMP, action="add", punch_kind="out",
                                  at=f"{day}T01:00:00", local_date=day, tz_offset_min=0,
                                  reason="Use vacation day please", status="pending")
        msg = timeclock._cannot_apply_msg(self.db, [req], {(day, "out_without_in")},
                                          [_p("rq-1", "out", f"{day}T01:00:00", day)])
        self.assertIn("Reject this and use Add on 11/13/2026", msg)
        self.assertIn('"Use vacation day please"', msg)

    def test_a_manager_adds_the_forgotten_clock_out(self):
        self.db.query(models.TimePunch).delete()
        for p in VALINDA:
            self.db.add(models.TimePunch(id=p.id, employee_email=EMP, kind=p.kind, at=p.at, local_date=p.local_date,
                                         tz_offset_min=480, created_at=p.at))
        self.db.commit()
        try:
            timeclock._guard_punch_order(self.db, EMP, kind="out", at="2026-11-05T01:41:00", local_date=D4)
        except HTTPException as e:   # pragma: no cover - the bug
            self.fail(e.detail)


if __name__ == "__main__":
    unittest.main()
