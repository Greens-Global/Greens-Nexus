"""Submit And Continue never does what HR's check would not (review of
11/04/2026): a packet that needs a second person to verify it waits for
review, nobody is named as verifier of documents no one checked by hand,
and a packet signed in person is never offered for online signing.

    python -m pytest test_intake_release_guards.py
"""
import re
import types
import unittest

import database
import hr_packet_docs as hpd
import models
from test_hr_offer import OfferCase


class ReleaseGuardTests(OfferCase):
    def _to_details(self):
        offer = self._offer().json()
        self._send_and_sign(offer["id"])
        token = re.search(r"/intake/([A-Za-z0-9_\-]+)", self._wait_for_mail()[2]).group(1)
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {
            "first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
            "answers": {"pan_number": "ABCDE1234F"}}})
        self.assertEqual(r.status_code, 200, r.text)
        return r, self.db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1", kind="hire").one()

    def test_released_packet_names_no_verifier(self):
        r, packet = self._to_details()
        ev = self._ev(packet.id)
        self.assertEqual(ev.status, "sent")
        self.assertEqual(ev.verified_by, "")          # nobody checked these documents by hand

    def test_a_packet_that_needs_a_second_checker_waits_for_review(self):
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).filter_by(id="s-hire").update({"verify_distinct": True})
        db.commit()
        db.close()
        r, packet = self._to_details()
        self.assertEqual(r.json()["signUrl"], "")
        self.assertEqual(self._ev(packet.id).status, "review")

    def test_a_packet_signed_in_person_has_no_online_link(self):
        ev = types.SimpleNamespace(sign_request_id="req-1", status="sent", inputs={"in_person": True}, subject_email="x@y.z")
        self.assertEqual(hpd.subject_sign_link(self.db, ev), "")


if __name__ == "__main__":
    unittest.main()
