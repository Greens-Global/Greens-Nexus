"""HR corrects a finalized time sheet (Neil, Oct 22 2026).

"HR should always be able to unlock and modify ... but requires re signing if
already signed. Employee must accept the changes, legally, always. ... HR /
Global Admin only - supervisor shouldn't be the one making a change like
that." Pranshu, Oct 22: unchanged = Re-lock without a new signature; a
corrected card not signed or declined in UNSIGNED_WAIT_DAYS is accepted as
sent; the manager is told.

    python -m pytest test_timesheet_correction.py
"""
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from test_timesheet_review_matrix import MatrixCase, EMP, MGR, HR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402

REASON = "Wrong lunch on Monday"


class CorrectionCase(MatrixCase):
    def _signed(self):
        self._to("completed")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))

    def _unlock(self, actor=HR, reason=REASON):
        timeclock.unfinalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.ps, end=self.pe, reason=reason),
                                      user={"email": actor, "level": 4}, db=self.db)

    def _hr_change(self):
        self._punch(self.pe, "in", "10:00:00")
        self._punch(self.pe, "out", "10:30:00")
        tsr.guard_edit(self.db, EMP, self.pe, HR)
        self.db.commit()

    def _bells(self, to):
        self.db.expire_all()
        return [n.title for n in self.db.query(models.NexusNotification).filter_by(recipient=to).all()]


class UnlockTests(CorrectionCase):
    def test_only_hr_unlocks_and_says_why(self):
        self._signed()
        for who in (MGR, EMP):
            with self.assertRaises(HTTPException) as e:
                self._unlock(who)
            self.assertEqual(e.exception.status_code, 403)
        with self.assertRaises(HTTPException) as e:
            self._unlock(reason="  ")
        self.assertEqual(e.exception.status_code, 422)
        self._unlock()
        self.assertEqual(self._status(), "correcting")
        self.assertFalse(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))
        self.assertIn("Time Sheet Unlocked by HR", self._bells(EMP))
        self.assertIn("Time Sheet Unlocked by HR", self._bells(MGR))     # the manager is told
        log = tsr.approval_log(self.db, self._rv())
        self.assertTrue(any(line.startswith("Signed by") for line in log), log)
        self.assertTrue(any("Unlocked for corrections" in line and REASON in line for line in log), log)

    def test_while_unlocked_only_hr_changes_it(self):
        self._signed()
        self._unlock()
        for who in (MGR, EMP):
            with self.assertRaises(HTTPException) as e:
                tsr.guard_edit(self.db, EMP, self.ps, who)
            self.assertEqual(e.exception.status_code, 403)
            self.assertIn("Only HR", e.exception.detail)
        self._as(EMP)                                  # an employee's punch fix is refused too
        r = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "break_start", "at": f"{self.ps}T19:00:00",
            "tz_offset_min": 0, "reason": "lunch"})
        self.assertEqual(r.status_code, 403, r.text)
        with self.assertRaises(HTTPException):
            tsr.approve_period(self.db, EMP, self.ps, MGR)
        tsr.guard_edit(self.db, EMP, self.ps, HR)      # HR goes ahead
        mgr = tsr.state_for(self.db, EMP, self.ps, MGR, True)
        self.assertTrue(mgr["inCorrection"])
        self.assertFalse(mgr["canApprove"] or mgr.get("canSendCorrection") or mgr.get("canRelock"))


class FinishTests(CorrectionCase):
    def test_nothing_changed_relocks_without_a_signature(self):
        self._signed()
        self._unlock()
        st = tsr.state_for(self.db, EMP, self.ps, HR, True)
        self.assertTrue(st["canRelock"])
        self.assertFalse(st["canSendCorrection"])
        with self.assertRaises(HTTPException) as e:
            tsr.send_correction(self.db, self._rv(), HR)
        self.assertEqual(e.exception.status_code, 409)
        tsr.relock(self.db, self._rv(), HR)
        self.db.commit()
        self.assertEqual(self._status(), "completed")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))

    def test_a_change_must_be_signed_again(self):
        self._signed()
        self._unlock()
        self._hr_change()
        st = tsr.state_for(self.db, EMP, self.ps, HR, True)
        self.assertTrue(st["canSendCorrection"])
        with self.assertRaises(HTTPException):
            tsr.relock(self.db, self._rv(), HR)
        with self.assertRaises(HTTPException):
            tsr.send_correction(self.db, self._rv(), MGR)     # never the supervisor
        tsr.send_correction(self.db, self._rv(), HR)
        self.db.commit()
        rv = self._rv()
        self.assertEqual(rv.status, "signing")
        req = self.db.query(models.HrSignRequest).filter_by(id=rv.sign_request_id).first()
        self.assertIn("accepted as sent", req.message)
        # The earlier signature no longer covers these hours.
        self.assertFalse(self.db.query(models.TimeApproval).filter_by(
            employee_email=EMP, kind="employee_sign", revoked=0).all())
        self.assertTrue(tsr.state_for(self.db, EMP, self.ps, EMP, False)["correction"]["acceptBy"])
        self._sign_now()
        self.assertEqual(self._status(), "completed")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))
        self.assertIn("Corrected Time Sheet Signed", self._bells(MGR))

    def test_a_decline_comes_back_to_hr_not_the_manager(self):
        self._signed()
        self._unlock()
        self._hr_change()
        tsr.send_correction(self.db, self._rv(), HR)
        self.db.commit()
        self._decline(self._parties(self._rv().sign_request_id)["employee"], "Tuesday is wrong too")
        self.assertEqual(self._status(), "correcting")
        self.assertIn("Corrected Time Sheet Declined", self._bells(HR))
        tsr.send_correction(self.db, self._rv(), HR)   # HR fixes and sends it again
        self.db.commit()
        self._sign_now()
        self.assertEqual(self._status(), "completed")


class AutoAcceptTests(CorrectionCase):
    def _sent(self):
        self._signed()
        self._unlock()
        self._hr_change()
        tsr.send_correction(self.db, self._rv(), HR)
        self.db.commit()

    def test_not_signed_in_time_is_accepted_as_sent(self):
        self._sent()
        now = datetime.now(timezone.utc)
        self.assertEqual(tsr.accept_unsigned_corrections(self.db, now + timedelta(days=tsr.UNSIGNED_WAIT_DAYS - 1)), 0)
        self.assertEqual(self._status(), "signing")
        envelope = self._rv().sign_request_id
        self.assertEqual(tsr.accept_unsigned_corrections(self.db, now + timedelta(days=tsr.UNSIGNED_WAIT_DAYS, hours=1)), 1)
        self.db.commit()
        self.assertEqual(self._status(), "completed")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))
        self.assertEqual(self.db.query(models.HrSignRequest).filter_by(id=envelope).one().status, "voided")
        self.assertIn("Corrected Time Sheet Accepted", self._bells(EMP))
        self.assertIn("Corrected Time Sheet Accepted", self._bells(MGR))
        self.assertTrue(any("not signed within" in line for line in tsr.approval_log(self.db, self._rv())))

    def test_an_ordinary_signature_wait_is_never_auto_accepted(self):
        self._to("signing")               # a normal approval out to sign: HR's Finalize Without Signature only
        later = datetime.now(timezone.utc) + timedelta(days=30)
        self.assertEqual(tsr.accept_unsigned_corrections(self.db, later), 0)
        self.assertEqual(self._status(), "signing")
