"""
HR's Finalize Without Employee Signature (Oct 17) - the way out for an
employee who never signs (left the company, unreachable), so the period still
finalizes and reaches payroll's finalized-only IIF and approved-only exports.

    python -m unittest test_timesheet_review_unsigned
"""
import unittest
from datetime import datetime, timedelta, timezone

from test_timesheet_review_matrix import MatrixCase, EMP, MGR, HR, OTHER

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402

URL = "/timesheet-review/finalize-unsigned"


class FinalizeUnsignedTests(MatrixCase):
    def _age(self, days):
        """Pretend the card went to the employee `days` days ago."""
        r = self._rv()
        old = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        r.rounds = [{**e, "at": old} for e in (r.rounds or [])]
        self.db.commit()

    def _leave(self):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).first()
        emp.status = "inactive"
        self.db.commit()

    def _post(self, actor, reason="Left the company, never signed"):
        self._as(actor)
        return self.client.post(URL, json={"email": EMP, "start": self.ps, "reason": reason})

    def _assert_finalized(self, approver):
        self.db.expire_all()
        self.assertEqual(self._status(), "completed")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))
        rows = self.db.query(models.TimeApproval).filter_by(employee_email=EMP, period_start=self.ps,
                                                            period_end=self.pe, revoked=0).all()
        kinds = {a.kind: a for a in rows}
        self.assertNotIn("employee_sign", kinds)          # nobody pretends they signed
        self.assertEqual(kinds["manager"].approved_by, approver)
        self.assertIn("without the employee's signature", kinds["manager"].note)
        # Payroll's approved-only export now counts them.
        self.assertIn(EMP, timeclock._approved_emails(self.db, [], self.ps, self.pe))

    def test_active_employee_waits_then_hr_finalizes(self):
        self._to("signing")
        req_id = self._rv().sign_request_id
        r = self._post(HR)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("has until", r.json()["detail"])
        self._age(tsr.UNSIGNED_WAIT_DAYS + 1)
        r = self._post(HR)
        self.assertEqual(r.status_code, 200, r.text)
        self._assert_finalized(MGR)                       # the manager's approval stands
        req = self.db.query(models.HrSignRequest).filter_by(id=req_id).first()
        self.assertEqual(req.status, "voided")
        log = tsr.approval_log(self.db, self._rv())
        self.assertTrue(any(line.startswith("Approved by") for line in log), log)
        self.assertTrue(any("Finalized without the employee's signature" in line for line in log), log)
        self.assertTrue(self.db.query(models.NexusNotification).filter_by(
            recipient=MGR, title="Time Sheet Finalized by HR").first())

    def test_hr_edited_card_waiting_for_resign(self):
        self._to("approved")
        self.assertEqual(self._post(HR).status_code, 409)
        self._age(tsr.UNSIGNED_WAIT_DAYS + 1)
        self.assertEqual(self._post(HR).status_code, 200)
        self._assert_finalized(MGR)

    def test_active_employee_not_yet_approved_is_refused(self):
        for state in ("not_submitted", "with_manager", "with_employee"):
            with self.subTest(state=state):
                self._fresh()
                self._to(state)
                r = self._post(HR)
                self.assertEqual(r.status_code, 409, r.text)
                self.assertIn("manager approves", r.json()["detail"])

    def test_someone_who_left_is_finalized_from_any_open_state(self):
        for state in ("not_submitted", "with_manager", "with_employee", "signing", "approved", "unlocked"):
            with self.subTest(state=state):
                self._fresh()
                self._to(state)
                self._leave()
                st = tsr.state_for(self.db, EMP, self.ps, HR, True)
                self.assertTrue(st["canFinalizeUnsigned"], st.get("finalizeUnsignedBlocker"))
                self.assertTrue(st["employeeLeft"])
                r = self._post(HR)
                self.assertEqual(r.status_code, 200, r.text)
                approved = state in ("signing", "approved")
                self._assert_finalized(MGR if approved else HR)

    def test_only_hr(self):
        self._to("signing")
        self._leave()
        for actor in (EMP, MGR, OTHER):
            with self.subTest(actor=actor):
                self.assertEqual(self._post(actor).status_code, 403)
                self.assertFalse(tsr.state_for(self.db, EMP, self.ps, actor, actor != EMP)
                                 .get("canFinalizeUnsigned"))
        self.assertEqual(self._status(), "signing")

    def test_reason_required(self):
        self._to("signing")
        self._leave()
        self.assertEqual(self._post(HR, reason="  ").status_code, 422)
        self.assertEqual(self._status(), "signing")

    def test_unresolved_punches_block_until_fixed(self):
        self._leave()
        self._punch(self.pe, "in", "16:00:00")            # a clock-in with no clock-out
        self.db.commit()
        r = self._post(HR)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertFalse(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))

    def test_twice_and_unlock_round_trip(self):
        self._to("signing")
        self._leave()
        self.assertEqual(self._post(HR).status_code, 200)
        r = self._post(HR)
        self.assertEqual(r.status_code, 409)
        self.assertIn("already finalized", r.json()["detail"])
        # HR's Unlock still works, and the period can be finalized again.
        timeclock.unfinalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.ps, end=self.pe),
                                      user={"email": HR, "level": 4}, db=self.db)
        self.assertEqual(self._status(), "unlocked")
        self.assertEqual(self._post(HR).status_code, 200)
        self._assert_finalized(HR)


if __name__ == "__main__":
    unittest.main()
