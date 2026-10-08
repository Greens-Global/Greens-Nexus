"""
Neil, 10/08 - two timesheet-signing fixes, on top of test_timesheet_review's
real-engine fixture (same throwaway database):

  * A punch fix the employee asked for, approved while the agreed timesheet is
    out for signature, RECALLS the envelope (voids it, the review returns to
    the manager for another round) instead of refusing the approver with
    "decline it in Nexus Sign". A rejection changes no hours and never touches
    the envelope.
  * A signer who is signed in to Nexus can take the one-time code INSIDE Nexus
    (bell + toast), listed before email; an emailed-link signer never sees it.

    python -m unittest test_timesheet_review_oct8
"""
import os
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import esign, timeclock  # noqa: E402


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

    def test_a_signed_in_signer_can_take_the_code_in_nexus(self):
        r = self._to_signing()
        p = self._parties(r.sign_request_id)["employee"]
        auth.SKIP_AUTH, os.environ["NEXUS_DEV_EMAIL"] = True, EMP
        self.db.query(models.NexusNotification).delete()
        self.db.commit()
        try:
            c = self.client
            me = c.get(f"/esign/mine/{p.id}")
            self.assertEqual(me.status_code, 200, me.text)
            self.assertEqual(c.post(f"/esign/mine/{p.id}/consent", json={"agreed": True}).status_code, 200)
            chans = [x["channel"] for x in c.get(f"/esign/mine/{p.id}").json()["otpChannels"]]
            self.assertEqual(chans, ["nexus", "email"])          # in-Nexus first, email still there
            # The emailed link (a public signer) never sees the in-Nexus channel.
            pub = [x["channel"] for x in c.get(f"/esign/public/{p.token}").json()["otpChannels"]]
            self.assertEqual(pub, ["email"])
            self.assertEqual(c.post(f"/esign/public/{p.token}/otp/request", json={"channel": "nexus"}).status_code, 400)
            out = c.post(f"/esign/mine/{p.id}/otp/request", json={"channel": "nexus"})
            self.assertEqual(out.status_code, 200, out.text)
            self.assertEqual(out.json()["channel"], "nexus")
            self.db.expire_all()
            notes = (self.db.query(models.NexusNotification)
                     .filter(models.NexusNotification.recipient == EMP).all())
            self.assertEqual(len(notes), 1)
            code = notes[0].title.rsplit(" ", 1)[1]
            self.assertRegex(code, r"^\d{6}$")
            self.assertNotIn(EMP, self.codes)                   # nothing was emailed
            v = c.post(f"/esign/mine/{p.id}/otp/verify", json={"code": code})
            self.assertEqual(v.status_code, 200, v.text)
            self.assertEqual(esign.sign_otp.summary_for_certificate(self.db, p)["channel"], "nexus")
        finally:
            os.environ.pop("NEXUS_DEV_EMAIL", None)


if __name__ == "__main__":
    unittest.main()
