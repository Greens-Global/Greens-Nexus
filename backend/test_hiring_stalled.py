"""Hiring steps waiting (hiring_stalled.py, Pranshu 11/03/2026): a details form
not sent, a Verify And Send not done, a signed offer whose packet never started
- one bell per person who can move them, rewritten in place, closed when
nothing waits; nothing to the candidate.

    python -m pytest test_hiring_stalled.py -q
"""
from datetime import datetime, timedelta, timezone

import database
import hiring_stalled
import hr_reminder_config
import models
from test_hr_offer import OfferCase
from test_hr_packet_review import CAND, CO, HR, HR2


def _ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _ev(db, eid, kind, status, by, days, flags=(), **kw):
    db.add(models.HrLifeEvent(id=eid, kind=kind, status=status, entity_id=CO, candidate_id="cand-1",
                              subject_name=f"Person {eid}", subject_email=CAND, created_by=by, created_at=_ago(days),
                              updated_at=_ago(days), inputs={}, flags=list(flags), **kw))


def _bells(db):
    return {n.recipient: n for n in db.query(models.NexusNotification).filter_by(type=hiring_stalled.NTYPE)}


class HiringStalledTests(OfferCase):
    def setUp(self):
        super().setUp()
        db = database.SessionLocal()
        _ev(db, "intake-old", "hire", "intake", HR, 5, intake_sent_at=_ago(5), setting_id="s-hire")
        _ev(db, "review-new", "hire", "review", HR, 1, setting_id="s-hire")
        _ev(db, "offer-old", "offer", "review", HR2, 4, setting_id="s-offer")
        _ev(db, "no-packet", "offer", "completed", "gone@nowhere.test", 6, completed_at=_ago(6),
            setting_id="s-offer", flags=[{"code": "packet_not_started", "message": "No hiring packet."}])
        db.commit()
        db.close()

    def test_each_quiet_step_goes_to_who_can_move_it_and_closes_when_done(self):
        self.assertGreater(hiring_stalled.run_daily(), 0)
        db = database.SessionLocal()
        try:
            bells = _bells(db)
            self.assertNotIn(CAND, bells)                          # never the candidate
            hr = bells[HR].body
            self.assertIn("Person intake-old", hr)                 # HR started it
            self.assertIn("Send Link Again", hr)
            self.assertNotIn("review-new", hr)                     # 1 day is not quiet yet
            self.assertIn("Person offer-old", hr)                  # HR verifies it
            self.assertIn("Person no-packet", hr)                  # its starter left: the HR chain
            self.assertIn("Start Hiring Packet", hr)
            self.assertIn("Person offer-old", bells[HR2].body)     # HR2 started it
            self.assertNotIn("intake-old", bells[HR2].body)
            self.assertRegex(hr, r"since \d\d/\d\d/\d{4}")         # US dates, never ISO
        finally:
            db.close()

        self.assertEqual(hiring_stalled.run_daily(), 0)            # same list, same day: no new bell

        db = database.SessionLocal()
        db.query(models.HrLifeEvent).update({"status": "voided"})
        db.commit()
        db.close()
        hiring_stalled.run_daily()
        db = database.SessionLocal()
        try:
            self.assertTrue(all(b.actioned for b in _bells(db).values()))
        finally:
            db.close()

    def test_a_bell_about_one_candidate_opens_their_card(self):
        import json
        hiring_stalled.run_daily()
        db = database.SessionLocal()
        try:
            self.assertEqual(json.loads(_bells(db)[HR].action), {"view": "hr", "sub": "hr-hiring-cand-1"})
        finally:
            db.close()
        self.assertEqual(hiring_stalled.action_for({"a", "b"}), hiring_stalled.ACTION)   # several: the board

    def test_the_setting_turns_it_off_and_sets_the_quiet_days(self):
        db = database.SessionLocal()
        hr_reminder_config.save_config(db, {"hiringStalled": {"afterDays": 10}}, {"email": HR})
        db.close()
        self.assertEqual(hiring_stalled.run_daily(), 0)            # nothing is 10 days quiet
        db = database.SessionLocal()
        hr_reminder_config.save_config(db, {"hiringStalled": {"enabled": False, "afterDays": 1}}, {"email": HR})
        db.close()
        self.assertEqual(hiring_stalled.run_daily(), 0)
        with self.assertRaises(hr_reminder_config.ReminderConfigError):
            hr_reminder_config.validate({"hiringStalled": {"afterDays": 0}})
