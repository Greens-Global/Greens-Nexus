"""Time Clock asks from Charmi, Oct 21 2026.

1. The AM / PM guard (long_shift.py): a typed time that makes a shift longer
   than 11 hours is flagged with SwipeClock's question - "Did you mean
   9:40 AM?" - and an employee's request is refused (422) unless they
   confirm it with a reason. Real overnight shifts are untouched.
2. Two missed days in a row are approved one day at a time: approving one
   day's clock-in brings its own clock-out, never the next day's pair.
   The approver can also change the Type of a requested block.
3. Personal time is its own pay class everywhere a total is frozen or
   printed: the signed totals, the Time Sheet summary, never Regular.

    python -m unittest test_time_charmi_oct21
"""
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import long_shift  # noqa: E402
import models  # noqa: E402
import timesheet_pdf  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402

HR = {"email": MGR, "level": 4}
UTC = timezone.utc


def _dt(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)


class LongShiftRuleTests(unittest.TestCase):
    def test_pm_typed_for_am_is_flagged_with_the_flip(self):
        issue = long_shift.check([("in", _dt("2026-10-13T08:30"))], "out", _dt("2026-10-13T21:40"))
        self.assertEqual(issue["minutes"], 13 * 60 + 10)
        self.assertEqual(issue["message"], "This makes the shift 13 hr 10 min long (8:30 AM to 9:40 PM). "
                                           "Did you mean 9:40 AM? Check AM / PM. For a time after midnight, "
                                           "pick the next day.")
        self.assertEqual(issue["suggestAt"], "2026-10-13T09:40:00")

    def test_swipeclocks_case_a_morning_out_on_the_next_day(self):
        # In 9:00 AM, out typed as 5:40 AM the next day - meant 5:40 PM.
        issue = long_shift.check([("in", _dt("2026-10-13T09:00"))], "out", _dt("2026-10-14T05:40"))
        self.assertIn("(9:00 AM to 5:40 AM the next day)", issue["message"])
        self.assertEqual(issue["suggestAt"], "2026-10-13T17:40:00")

    def test_employee_zone_is_used_for_the_words(self):
        # Pacific (offset 420): 8:30 AM - 9:40 PM local.
        issue = long_shift.check([("in", _dt("2026-10-13T15:30"))], "out", _dt("2026-10-14T04:40"), 420)
        self.assertIn("(8:30 AM to 9:40 PM)", issue["message"])
        self.assertIn("Did you mean 9:40 AM?", issue["message"])

    def test_overnight_and_normal_shifts_pass(self):
        self.assertIsNone(long_shift.check([("in", _dt("2026-10-13T22:00"))], "out", _dt("2026-10-14T06:00")))
        self.assertIsNone(long_shift.check([("in", _dt("2026-10-13T08:00"))], "out", _dt("2026-10-13T19:00")))
        # A clock-in with nothing after it has no span yet.
        self.assertIsNone(long_shift.check([], "in", _dt("2026-10-13T08:00")))
        # Out before in is the order guard's business, not this one.
        self.assertIsNone(long_shift.check([("in", _dt("2026-10-13T08:00"))], "out", _dt("2026-10-13T07:00")))

    def test_a_real_long_shift_has_no_suggestion(self):
        issue = long_shift.check([("in", _dt("2026-10-13T07:00"))], "out", _dt("2026-10-13T19:00"))
        self.assertEqual(issue["minutes"], 12 * 60)
        self.assertNotIn("Did you mean", issue["message"])
        self.assertTrue(issue["message"].startswith("This makes the shift 12 hr long (7:00 AM to 7:00 PM)."))

    def test_moving_a_clock_in_and_a_break_far_from_the_first_punch(self):
        issue = long_shift.check([("out", _dt("2026-10-13T17:00"))], "in", _dt("2026-10-13T05:00"))
        self.assertEqual(issue["minutes"], 12 * 60)
        # A break typed 8:30 PM on a shift that began 8:00 AM - meant 8:30 AM.
        issue = long_shift.check([("in", _dt("2026-10-13T08:00"))], "break_start", _dt("2026-10-13T20:30"))
        self.assertIn("Did you mean 8:30 AM?", issue["message"])


class EmployeeRequestGuardTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.day = (datetime.now(UTC) - timedelta(days=3)).strftime("%Y-%m-%d")
        self.db.query(models.PunchRequest).delete()
        self.db.commit()

    def _ask(self, kind, hhmm, **kw):
        body = timeclock.PunchRequestIn(action="add", punch_kind=kind, at=f"{self.day}T{hhmm}:00",
                                        tz_offset_min=0, reason=kw.pop("reason", "Forgot to punch"), **kw)
        return timeclock.create_punch_request(body, user={"email": EMP}, db=self.db)

    def test_long_out_is_refused_with_the_message_then_confirmed(self):
        self._ask("in", "08:30")
        with self.assertRaises(HTTPException) as e:
            self._ask("out", "21:40")
        self.assertEqual(e.exception.status_code, 422)
        self.assertEqual(e.exception.detail["code"], "long_shift")
        self.assertIn("Did you mean 9:40 AM?", e.exception.detail["message"])
        # Confirm without a reason is still refused; with one it goes, flagged.
        with self.assertRaises(HTTPException):
            self._ask("out", "21:40", confirm_long=True, reason=" ")
        r = self._ask("out", "21:40", confirm_long=True, reason="Covered the night shift")
        self.assertIn("(Long shift confirmed: 13 hr 10 min)", r["reason"])

    def test_a_normal_pair_needs_no_confirmation(self):
        self._ask("in", "08:30")
        r = self._ask("out", "17:00")
        self.assertEqual(r["reason"], "Forgot to punch")


class OneDayAtATimeTests(ReviewCase):
    def setUp(self):
        super().setUp()
        d0 = date.fromisoformat(self.start) + timedelta(days=21)
        self.d = [(d0 + timedelta(days=k)).isoformat() for k in range(2)]
        self.db.query(models.PunchRequest).delete()
        (self.db.query(models.TimePunch)
         .filter(models.TimePunch.employee_email == EMP, models.TimePunch.local_date.in_(self.d)).delete())
        self.ids = {}
        n = 0
        for day in self.d:
            for kind, hhmm, cat in (("in", "09:00", "Personal"), ("out", "17:00", "")):
                n += 1
                rid = f"{kind}-{day}-{uuid.uuid4().hex[:6]}"
                self.ids[(day, kind)] = rid
                self.db.add(models.PunchRequest(id=rid, employee_email=EMP, employee_name="Erin Test", action="add",
                                                punch_kind=kind, at=f"{day}T{hhmm}:00", local_date=day,
                                                tz_offset_min=0, reason="Off sick", status="pending",
                                                category=cat if kind == "in" else "",
                                                created_at=f"{day}T18:00:0{n}"))
        self.db.commit()

    def _decide(self, day, kind, **kw):
        return timeclock.decide_punch_request(self.ids[(day, kind)],
                                              timeclock.PunchRequestDecision(status=kw.pop("status", "approved"), **kw),
                                              user=HR, db=self.db)

    def _status(self, day, kind):
        self.db.expire_all()
        return self.db.get(models.PunchRequest, self.ids[(day, kind)]).status

    def test_each_day_is_approved_on_its_own(self):
        self._decide(self.d[0], "in")
        self.assertEqual((self._status(self.d[0], "in"), self._status(self.d[0], "out")), ("approved", "approved"))
        self.assertEqual((self._status(self.d[1], "in"), self._status(self.d[1], "out")), ("pending", "pending"))
        # The second day, from its clock-out, brings its own clock-in.
        self._decide(self.d[1], "out")
        self.assertEqual((self._status(self.d[1], "in"), self._status(self.d[1], "out")), ("approved", "approved"))

    def test_the_second_day_can_be_rejected_alone(self):
        self._decide(self.d[1], "in", status="rejected", note="Not that day")
        self.assertEqual(self._status(self.d[1], "in"), "rejected")
        self.assertEqual(self._status(self.d[0], "in"), "pending")

    def test_approver_changes_the_type(self):
        r = self._decide(self.d[0], "in", category="Sick")
        self.assertIn("Type changed from Personal to Sick.", r["decisionNote"])
        p = self.db.query(models.TimePunch).filter(models.TimePunch.id == r["appliedPunchId"]).first()
        self.assertEqual(p.category, "Sick")


class PersonalTimeTests(ReviewCase):
    """Amy's card: Tue 8 h Personal, four 8 h worked days - 32 h Regular,
    8 h Personal, no overtime."""

    def setUp(self):
        super().setUp()
        self.db.add(models.PayrollRate(employee_email=EMP, hourly_rate=20.0, overtime_rule="ca", pay_type="hourly"))
        d0 = date.fromisoformat(self.start) + timedelta(days=7)          # the period's second week (Sunday)
        self.wk = [(d0 + timedelta(days=k)).isoformat() for k in range(7)]
        (self.db.query(models.TimePunch)
         .filter(models.TimePunch.employee_email == EMP, models.TimePunch.local_date.in_(self.wk)).delete())
        for i, (day, cat) in enumerate(zip(self.wk[1:6], ("", "Personal", "", "", ""))):
            self.db.add(models.TimePunch(id=f"pers-in-{i}", employee_email=EMP, kind="in", at=f"{day}T09:00:00",
                                         local_date=day, tz_offset_min=0, category=cat, created_at=f"{day}T09:00:00"))
            self.db.add(models.TimePunch(id=f"pers-out-{i}", employee_email=EMP, kind="out", at=f"{day}T17:00:00",
                                         local_date=day, tz_offset_min=0, created_at=f"{day}T17:00:00"))
        self.db.commit()
        self.card = timeclock._compute_timecard(self.db, EMP, self.wk[0], self.wk[-1])

    def test_personal_is_its_own_pay_class(self):
        t = self.card["totals"]
        self.assertEqual(t["personalMin"], 480)
        self.assertEqual(t["regMin"], 32 * 60)
        self.assertEqual(t["otMin"], 0)
        self.assertAlmostEqual(t["personalPay"], 160.0)
        self.assertEqual(t["workedMin"], 40 * 60)
        day = next(d for d in self.card["days"] if d["date"] == self.wk[2])
        self.assertEqual((day["regMin"], day["personalMin"]), (0, 480))

    def test_the_summary_and_the_signed_totals_carry_it(self):
        rows = timesheet_pdf.hourly_summary(self.card)
        self.assertTrue(any(r[0].startswith("Total Personal hours") for r in rows), rows)
        signed = tsr.signed_totals(self.card, "hourly")
        self.assertEqual(signed["totals"]["personalMin"], 480)
        # A round frozen before Personal was a signed key is not "changed".
        old = {**signed, "totals": {k: v for k, v in signed["totals"].items() if k != "personalMin"}}
        self.assertEqual(tsr.totals_drift(old, signed), [])
        moved = {**signed, "totals": {**signed["totals"], "personalMin": 240}}
        self.assertEqual(tsr.totals_drift(moved, signed), ["Personal 4h 00m -> 8h 00m"])


if __name__ == "__main__":
    unittest.main()
