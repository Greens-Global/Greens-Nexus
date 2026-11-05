""""Changed Since You Approved" and the team list's review status (Neil,
11/04/2026, the Time Sheet table pass):

  * state_for carries changedDays ([{date, before, after}] minutes) and
    changedSince (the approval time) once the manager approved - [] when
    nothing moved, the day HR edited when it did - and nothing at all when
    the snapshot is no longer the approval's (a resubmit after a reopen);
  * a card the route already computed is reused, one for another window is not;
  * GET /timeclock/team rows carry review {status, agreedAt} and finalized,
    found by the period that holds the window's middle day (a monthly review
    from a bi-weekly window too).

Runs on test_timesheet_review's throwaway database, one file per process:
    python -m pytest test_timesheet_changed_days.py -q
"""
import unittest
import uuid

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ANCHOR  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402


class ChangedDays(ReviewCase):
    def _state(self, **kw):
        self.db.expire_all()
        return tsr.state_for(self.db, EMP, self.start, MGR, True, **kw)

    def test_nothing_before_an_approval(self):
        self.assertNotIn("changedDays", self._state())                      # not submitted
        tsr.submit(self.db, EMP, ANCHOR, "All in")
        self.assertNotIn("changedDays", self._state())                      # with the manager, never approved

    def test_approved_then_hr_edits_a_punch(self):
        r = self._to_signing()
        st = self._state()
        self.assertEqual(st["status"], "signing")
        self.assertEqual((st["changedDays"], st["changedSince"]), ([], r.agreed_at))
        # HR moves the clock-out half an hour later (no approval needed - _hr_override).
        tsr.guard_edit(self.db, EMP, self.start, HR)
        self.db.query(models.TimePunch).filter_by(id=f"p-{self.start}-out-23:00:00").delete()
        self._punch(self.start, "out", "23:30:00")
        self.db.commit()
        st = self._state()
        self.assertEqual(st["status"], "approved")
        self.assertEqual(st["changedDays"], [{"date": self.start, "before": 420, "after": 450}])
        self.assertEqual(st["changedSince"], r.agreed_at)
        # The route's own card is read as is; a card for another window is ignored.
        card = timeclock._compute_timecard(self.db, EMP, self.start, self.end)
        self.assertEqual(self._state(card=card)["changedDays"], [{"date": self.start, "before": 420, "after": 450}])
        other = timeclock._compute_timecard(self.db, EMP, self.end, self.end)
        self.assertEqual(self._state(card=other)["changedDays"], [{"date": self.start, "before": 420, "after": 450}])

    def test_a_reopen_still_compares_with_the_approval(self):
        self._to_signing()
        tsr.guard_edit(self.db, EMP, self.start, MGR)        # the manager's change reopens it
        self.db.query(models.TimePunch).filter_by(id=f"p-{self.start}-out-23:00:00").delete()
        self._punch(self.start, "out", "22:00:00")
        self.db.commit()
        st = self._state()
        self.assertEqual(st["status"], "with_manager")
        self.assertEqual(st["changedDays"], [{"date": self.start, "before": 420, "after": 360}])

    def test_a_resubmit_after_the_approval_says_nothing(self):
        self._to_signing()
        tsr.guard_edit(self.db, EMP, self.start, HR)          # back to "approved"
        self.db.commit()
        tsr.submit(self.db, EMP, ANCHOR, "I do not agree")    # overwrites last_snapshot
        st = self._state()
        self.assertEqual(st["status"], "with_manager")
        self.assertNotIn("changedDays", st)
        self.assertNotIn("changedSince", st)


class TeamReviewStatus(ReviewCase):
    def _team(self, start, end):
        out = timeclock.team_timesheet(start=start, end=end, user={"email": HR, "level": 5}, db=self.db)
        return {r["email"]: r for r in out["rows"]}

    def test_rows_carry_the_review_and_finalized(self):
        row = self._team(self.start, self.end)[EMP]
        self.assertEqual((row["review"], row["finalized"]), ({"status": "not_submitted", "agreedAt": ""}, False))
        r = self._to_signing()
        row = self._team(self.start, self.end)[EMP]
        self.assertEqual(row["review"], {"status": "signing", "agreedAt": r.agreed_at})
        self.db.add(models.TimeApproval(id="fin-team", employee_email=EMP, period_start=self.start,
                                        period_end=self.end, worked_min=420, approved_by=HR,
                                        approved_at=f"{self.end}T20:00:00", revoked=0, kind="final"))
        self.db.commit()
        self.assertTrue(self._team(self.start, self.end)[EMP]["finalized"])

    def test_a_monthly_review_is_found_from_a_two_week_window(self):
        self.db.add(models.TimesheetReview(id=str(uuid.uuid4()), employee_email=MGR, period_start="2026-09-01",
                                           period_end="2026-09-30", pay_type="fixed", status="completed",
                                           agreed_at="2026-10-01T10:00:00", rounds=[], last_snapshot={},
                                           created_at="2026-10-01T09:00:00"))
        self.db.add(models.TimesheetReview(id=str(uuid.uuid4()), employee_email=MGR, period_start="2026-09-01",
                                           period_end="2026-09-30", pay_type="fixed", status="cancelled",
                                           rounds=[], last_snapshot={}, created_at="2026-10-02T09:00:00"))
        self.db.commit()
        review, final = timeclock._team_review_status(self.db, [MGR, EMP], "2026-09-13", "2026-09-26")
        self.assertEqual(review, {MGR: {"status": "completed", "agreedAt": "2026-10-01T10:00:00"}})
        self.assertEqual(final, set())
        # Outside the month: nothing.
        self.assertEqual(timeclock._team_review_status(self.db, [MGR], "2026-10-04", "2026-10-17")[0], {})


if __name__ == "__main__":
    unittest.main()
