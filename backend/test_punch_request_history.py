"""A decided punch request stays readable (Neil, Oct 29 2026).

"If an employee submits an edit and manager++ edits or approves their
changes, the employee and manager can still see the history of what the
request was." The request row keeps what the employee asked; approving
with a changed Type records it in the note; the approver's Decided list
(status=decided) and the employee's own list both return it with who
decided, by name.

    python -m pytest test_punch_request_history.py
"""
import unittest
from datetime import datetime, timedelta, timezone

from test_timesheet_review import ReviewCase, EMP, MGR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
from routers import timeclock  # noqa: E402


class PunchRequestHistoryTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.PunchRequest).delete()
        self.db.commit()

    def _ask(self, kind, at, category="", reason="Forgot to clock in"):
        return timeclock.create_punch_request(
            timeclock.PunchRequestIn(action="add", punch_kind=kind, at=at, tz_offset_min=0,
                                     reason=reason, category=category),
            user={"email": EMP, "level": 1}, db=self.db)

    def _decided(self, **kw):
        return timeclock.list_punch_requests(status="decided", from_=kw.get("from_", ""), to=kw.get("to", ""),
                                             user={"email": MGR, "level": 4}, db=self.db)

    def test_an_approved_type_change_keeps_what_was_asked_for_both_sides(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        r = self._ask("in", (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S"), "Personal", "Doctor visit")
        # Its clock-out too: a lone clock-in would leave an open shift.
        self._ask("out", (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S"), "", "Doctor visit")
        timeclock.decide_punch_request(r["id"], timeclock.PunchRequestDecision(status="approved", category="Sick"),
                                       user={"email": MGR, "level": 4}, db=self.db)
        self.db.expire_all()

        rows = self._decided()
        mine = [x for x in rows if x["id"] == r["id"]]
        self.assertEqual(len(mine), 1)
        row = mine[0]
        self.assertEqual(row["status"], "approved")
        self.assertEqual(row["reason"], "Doctor visit")
        self.assertIn("Type changed from Personal to Sick", row["decisionNote"])
        self.assertEqual(row["decidedBy"], MGR)
        self.assertTrue(row["decidedByName"])

        own = [x for x in timeclock.my_punch_requests(user={"email": EMP}, db=self.db) if x["id"] == r["id"]]
        self.assertEqual(own[0]["reason"], "Doctor visit")
        self.assertIn("Type changed from Personal to Sick", own[0]["decisionNote"])
        self.assertTrue(own[0]["decidedByName"])

    def test_pending_and_out_of_range_requests_are_not_in_the_history(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        r = self._ask("in", (now - timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S"))
        self.assertNotIn(r["id"], [x["id"] for x in self._decided()])
        timeclock.decide_punch_request(r["id"], timeclock.PunchRequestDecision(status="rejected", note="Not on the schedule"),
                                       user={"email": MGR, "level": 4}, db=self.db)
        self.db.expire_all()
        self.assertIn(r["id"], [x["id"] for x in self._decided()])
        # Bounded by the day the punch is for.
        self.assertNotIn(r["id"], [x["id"] for x in self._decided(from_="2000-01-01", to="2000-01-31")])

    def test_a_rejected_punch_edit_keeps_the_time_asked_for_and_the_note(self):
        day = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
        self._punch(day, "in", "09:00:00")
        self._punch(day, "out", "17:00:00")
        self.db.commit()
        pid = f"p-{day}-in-09:00:00"
        timeclock.request_punch_edit(timeclock.PunchEditIn(punch_id=pid, at=f"{day}T08:30:00", reason="Came in early"),
                                     user={"email": EMP, "level": 1}, db=self.db)
        timeclock.decide_punch_edit(pid, timeclock.PunchEditDecision(status="rejected", note="Badge shows 9:00"),
                                    user={"email": MGR, "level": 4}, db=self.db)
        self.db.expire_all()
        p = self.db.get(models.TimePunch, pid)
        self.assertEqual((p.edit_status, p.pending_at), ("rejected", ""))
        self.assertEqual(p.at[:19], f"{day}T09:00:00")                 # the time sheet did not move
        self.assertEqual(p.edit_requested_at, f"{day}T08:30:00")        # but what was asked is kept
        self.assertEqual(p.edit_note, "Badge shows 9:00")
        self.assertEqual(p.edit_reason, "Came in early")


if __name__ == "__main__":
    unittest.main()
