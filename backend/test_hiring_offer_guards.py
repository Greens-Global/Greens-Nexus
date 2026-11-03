"""Two hiring guards (Pranshu, 11/03/2026).

- An offer is never sent with no hiring packet to follow it - not even when
  the request carries its own `hire_packet_id` (the server picks the packet;
  that value used to skip the check and was then thrown away).
- A company's HR contact may list several emails: the hiring flow uses the
  first one still here, never nobody.

    python -m pytest test_hiring_offer_guards.py
"""
from types import SimpleNamespace

import database
import hiring_decision
import hiring_openings
import hiring_screening
import hr_life_events as hle
import models
from test_hr_offer import OfferCase
from test_hr_packet_review import CO, HR


class OfferNeedsAPacketTests(OfferCase):
    def test_a_sent_hire_packet_id_does_not_skip_the_no_packet_check(self):
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).filter_by(event="hire").delete()
        db.commit()
        db.close()
        r = self._offer(hire_packet_id="made-up")
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("No hiring packet is set up", r.json()["detail"])


class HrContactListTests(OfferCase):
    def setUp(self):
        super().setUp()
        db = database.SessionLocal()
        db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": f"gone@nowhere.test, {HR}"})
        db.commit()
        db.close()

    def test_every_hiring_reader_takes_the_first_contact_still_here(self):
        db = database.SessionLocal()
        try:
            self.assertEqual(hiring_screening.hr_contacts_here(db, CO), [HR])
            self.assertEqual(hle.offer_from_people(db, CO, "")["hr"], HR)
            cand = db.query(models.HrCandidate).filter_by(id="cand-1").first()
            self.assertEqual(hiring_decision.decider(db, cand), HR)
            self.assertIn(HR, hiring_screening.screeners(db, cand))
            op = SimpleNamespace(hiring_owner_email="", company=CO)
            self.assertEqual(hiring_openings.applicant_owner(db, op), HR)
        finally:
            db.close()
