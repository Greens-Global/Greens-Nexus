"""The numbers signed are the numbers finalized (Neil's Time Clock audit, Oct 20 2026).

A Time Sheet out for the employee's signature was finalized from whatever the
card computed at the moment of the signature. A pay setting changed while it
waited (auto-lunch, rounding, the break policy, the overtime rule, the pay
type) meant the signed PDF and the finalized hours disagreed. Now the totals
the PDF prints are frozen on the round that sent it, and the signature's
completion recomputes and compares:

  * unchanged -> finalized exactly as before;
  * changed   -> NOT finalized: back with the manager (totals_changed round,
    the envelope logged as superseded), the manager and the employee told;
    a fresh approval sends the current numbers, and that signature finalizes.

On test_timesheet_review's real Nexus Sign fixture (its own throwaway database).

    python -m unittest test_timesheet_signed_totals
"""
import json
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, ANCHOR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402


class SignedTotalsTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.NexusNotification).delete()
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == timeclock._AUTOLUNCH_KEY).delete()
        self.db.commit()

    def tearDown(self):
        self.db.query(models.NexusSetting).filter(models.NexusSetting.key == timeclock._AUTOLUNCH_KEY).delete()
        self.db.commit()
        super().tearDown()

    def _autolunch_on(self):
        self.db.add(models.NexusSetting(key=timeclock._AUTOLUNCH_KEY,
                                        value=json.dumps({"enabled": True, "afterMin": 360, "deductMin": 30})))
        self.db.commit()

    def test_the_sending_round_freezes_what_the_pdf_prints(self):
        r = self._to_signing()
        sent = r.rounds[-1]
        self.assertEqual((sent["action"], sent["envelope"]), ("agreed", r.sign_request_id))
        self.assertEqual(sent["signed"]["totals"]["workedMin"], 420)
        self.assertEqual(sent["signed"]["days"], {self.start: 420})

    def test_unchanged_totals_finalize_as_before(self):
        r = self._to_signing()
        self._sign(self._parties(r.sign_request_id)["employee"])
        r = self._r()
        self.assertEqual(r.status, "completed")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.start, self.end))
        self.assertNotIn("totals_changed", [e["action"] for e in r.rounds])

    def test_a_pay_setting_changed_while_out_for_signature_sends_it_back(self):
        r = self._to_signing()
        rid = r.sign_request_id
        self._autolunch_on()                    # 7h shift, no break: 30 minutes come off
        self._sign(self._parties(rid)["employee"])
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id, r.agreed_fingerprint), ("with_manager", "", ""))
        self.assertFalse(timeclock._finalized_row(self.db, EMP, self.start, self.end))
        self.assertEqual(self.db.query(models.TimeApproval).filter_by(employee_email=EMP, revoked=0).count(), 0)
        last = r.rounds[-1]
        self.assertEqual((last["action"], last["note"]), ("totals_changed", tsr.TOTALS_CHANGED_NOTE))
        self.assertIn("Total Worked 7h 00m -> 6h 30m", last["drift"])
        # The signed envelope is kept as the record, logged superseded.
        ev = (self.db.query(models.HrSignEvent)
              .filter(models.HrSignEvent.request_id == rid, models.HrSignEvent.type == "superseded").one())
        self.assertIn("Pay settings changed after approval", ev.detail)
        # The manager and the employee hear it, through the reopen path's words.
        self.db.expire_all()
        bells = {n.recipient: n for n in self.db.query(models.NexusNotification)
                 .filter(models.NexusNotification.title == "Time Sheet Back for Review").all()}
        self.assertIn(MGR, bells)
        self.assertIn(EMP, bells)
        self.assertIn("6h 30m", bells[MGR].body)

        # A fresh approval sends the current numbers; that signature finalizes.
        tsr.approve(self.db, r, MGR, "Auto-lunch applies")
        r = self._r()
        self.assertEqual(r.rounds[-1]["signed"]["totals"]["workedMin"], 390)
        self._sign(self._parties(r.sign_request_id)["employee"])
        r = self._r()
        self.assertEqual(r.status, "completed")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.start, self.end))

    def test_an_envelope_from_before_the_check_still_finalizes(self):
        r = self._to_signing()
        rid = r.sign_request_id
        r.rounds = [{k: v for k, v in e.items() if k not in ("envelope", "signed")} for e in r.rounds]
        self.db.commit()
        self._autolunch_on()
        self._sign(self._parties(rid)["employee"])
        self.assertEqual(self._r().status, "completed")

    def test_drift_words(self):
        sent = {"payType": "hourly", "totals": {"regMin": 480, "workedMin": 480}, "days": {"2026-10-05": 480}}
        now = {"payType": "hourly", "totals": {"regMin": 450, "workedMin": 450}, "days": {"2026-10-05": 450}}
        self.assertEqual(tsr.totals_drift(sent, now),
                         ["Regular 8h 00m -> 7h 30m", "Total Worked 8h 00m -> 7h 30m", "10/05/2026 8h 00m -> 7h 30m"])
        self.assertEqual(tsr.totals_drift(sent, sent), [])
        self.assertEqual(tsr.totals_drift(sent, {**now, "payType": "fixed"}), ["Pay type hourly -> fixed"])
        self.assertEqual(tsr.totals_drift({}, now), [])


if __name__ == "__main__":
    unittest.main()
