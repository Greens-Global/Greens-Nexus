"""
Neil, 10/08 - a timesheet-signing fix, on top of test_timesheet_review's
real-engine fixture (same throwaway database):

  * A punch fix the employee asked for, approved while the agreed timesheet is
    out for signature, RECALLS the envelope (voids it, the review returns to
    the manager for another round) instead of refusing the approver with
    "decline it in Nexus Sign". A rejection changes no hours and never touches
    the envelope.

    python -m unittest test_timesheet_review_oct8
"""
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402


class Oct8FixTests(ReviewCase):
    def _pending_fix(self, rid, kind, hhmm):
        self.db.add(models.PunchRequest(id=rid, employee_email=EMP, employee_name="Erin Test", action="add",
                                        punch_kind=kind, at=f"{self.start}T{hhmm}", local_date=self.start,
                                        tz_offset_min=0, reason="Forgot", status="pending",
                                        created_at=f"{self.start}T23:30:00"))
        self.db.commit()

    def test_approving_a_punch_fix_recalls_the_envelope(self):
        r = self._to_signing()
        rid = r.sign_request_id
        self._pending_fix("pr-lunch", "break_end", "19:30:00")
        out = timeclock.decide_punch_request("pr-lunch", timeclock.PunchRequestDecision(status="approved"),
                                             user={"email": MGR, "level": 4}, db=self.db)
        self.assertEqual(out["status"], "approved")
        self.db.expire_all()
        self.assertEqual(self.db.get(models.HrSignRequest, rid).status, "voided")
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id), ("with_manager", ""))
        last = r.rounds[-1]
        self.assertEqual((last["action"], last["by"]), ("recalled", MGR))
        self.assertIn("break end punch added", last["note"])
        self.assertTrue(self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP,
                                                               models.TimePunch.kind == "break_end",
                                                               models.TimePunch.voided == 0).first())
        # The manager agrees to a fresh version and it goes out again.
        tsr.agree(self.db, self._r(), MGR, "With the lunch")
        self.assertEqual(self._r().status, "signing")

    def test_rejecting_a_punch_fix_never_touches_the_envelope(self):
        r = self._to_signing()
        rid = r.sign_request_id
        self._pending_fix("pr-no", "in", "15:00:00")
        timeclock.decide_punch_request("pr-no", timeclock.PunchRequestDecision(status="rejected", note="No"),
                                       user={"email": MGR, "level": 4}, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.HrSignRequest, rid).status, "pending")
        self.assertEqual(self._r().status, "signing")


if __name__ == "__main__":
    unittest.main()
