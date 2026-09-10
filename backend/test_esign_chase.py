"""E-sign chasing - the automatic half of "remind" (Documents module).

Reminding a stalled signer was a button only: the sender got an "expiring soon"
alert, but nothing ever reached the person actually holding the envelope up,
and an envelope with no expiry date could sit silently forever. Expiry itself
was lazy - a passed-expiry request kept reading as "pending" until somebody
happened to open it.

These cover the sweep that closes both: chase after N quiet days, at most
_MAX_AUTO_CHASES times, never chase someone whose turn it is not, and expire +
tell the sender on the date.

    python -m unittest test_esign_chase
"""
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database
import models
import reminders

models.Base.metadata.create_all(bind=database.engine)

SENDER = "sender.chase@greensglobal.com"
SIGNER = "signer.chase@greensglobal.com"
SIGNER2 = "signer2.chase@greensglobal.com"
REQ = "req-chase-test"   # replaced per test in setUp


def _ago(days):
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


class EsignChaseTests(unittest.TestCase):
    def setUp(self):
        global REQ
        REQ = f"req-chase-{uuid.uuid4()}"
        self._cleanup()
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()
        self._cleanup()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            # hr_sign_events is append-only at the database level now, so the
            # rows this fixture inserts cannot be deleted - and should not be.
            # Each test gets a fresh envelope id instead, so no chase decision
            # is ever made against a previous test's events.
            pass
            db.query(models.HrSignParty).filter(models.HrSignParty.request_id == REQ).delete()
            db.query(models.HrSignRequest).filter(models.HrSignRequest.id == REQ).delete()
            db.query(models.NexusNotification).filter(
                models.NexusNotification.ref_id == REQ).delete()
            db.commit()
        finally:
            db.close()

    def _envelope(self, *, last_contact_days, auto_chases=0, expires_on="",
                  party_status="notified", routing="sequential"):
        """A pending envelope waiting on one internal signer, last contacted
        `last_contact_days` ago, with `auto_chases` automatic nudges already
        behind it."""
        db = self.db
        db.add(models.HrSignRequest(
            id=REQ, title="Vendor NDA", status="pending", routing=routing,
            current_order=1, created_by=SENDER, expires_on=expires_on,
            created_at=_ago(30)))
        pid = f"party-{uuid.uuid4()}"
        db.add(models.HrSignParty(
            id=pid, request_id=REQ, name="Sam Signer", email=SIGNER, kind="internal",
            party_role="signer", ordinal=1, status=party_status))
        db.add(models.HrSignEvent(id=str(uuid.uuid4()), request_id=REQ, party_id=pid,
                                  type="sent", detail="notified", at=_ago(last_contact_days), seq=1))
        for i in range(auto_chases):
            db.add(models.HrSignEvent(
                id=str(uuid.uuid4()), request_id=REQ, party_id=pid, type="reminded",
                detail=f"automatic reminder - no response in 3 days ({i + 1} of 3)",
                at=_ago(last_contact_days), seq=2 + i))
        db.commit()
        return pid

    def _events(self, pid, type_):
        return (self.db.query(models.HrSignEvent)
                .filter(models.HrSignEvent.request_id == REQ,
                        models.HrSignEvent.party_id == pid,
                        models.HrSignEvent.type == type_).all())

    def _bells(self, ntype):
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.ref_id == REQ,
                        models.NexusNotification.type == ntype).all())

    # ── chasing ─────────────────────────────────────────────────────────────
    def test_chases_a_signer_who_has_gone_quiet(self):
        pid = self._envelope(last_contact_days=5)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        auto = self._events(pid, "reminded")
        self.assertEqual(len(auto), 1)
        self.assertTrue(auto[0].detail.startswith("automatic reminder"))
        # The signer gets the bell, not the sender.
        bells = (self.db.query(models.NexusNotification)
                 .filter(models.NexusNotification.ref_id == REQ).all())
        self.assertEqual([b.recipient for b in bells], [SIGNER])

    def test_does_not_chase_before_the_quiet_period(self):
        pid = self._envelope(last_contact_days=1)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(self._events(pid, "reminded"), [])

    def test_running_twice_in_a_day_does_not_double_chase(self):
        """The nudge dates itself, so the second run sees a fresh contact."""
        pid = self._envelope(last_contact_days=5)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(len(self._events(pid, "reminded")), 1)

    def test_stops_after_the_cap_and_hands_back_to_the_sender(self):
        pid = self._envelope(last_contact_days=9, auto_chases=2)
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(len(self._events(pid, "reminded")), 3)   # 2 seeded + the last one
        stalled = self._bells("esign_stalled")
        self.assertEqual(len(stalled), 1)
        self.assertEqual(stalled[0].recipient, SENDER)

        # A further run adds nothing at all - the cap holds.
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(len(self._events(pid, "reminded")), 3)

    def test_never_chases_a_party_whose_turn_it_is_not(self):
        pid = self._envelope(last_contact_days=9)
        other = f"party-{uuid.uuid4()}"
        self.db.add(models.HrSignParty(
            id=other, request_id=REQ, name="Second Signer", email=SIGNER2,
            kind="internal", party_role="signer", ordinal=2, status="waiting"))
        self.db.add(models.HrSignEvent(id=str(uuid.uuid4()), request_id=REQ, party_id=other,
                                       type="sent", detail="x", at=_ago(9), seq=9))
        self.db.commit()
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(len(self._events(pid, "reminded")), 1)    # order 1: chased
        self.assertEqual(self._events(other, "reminded"), [])      # order 2: not their turn

    def test_does_not_chase_a_signer_who_already_signed(self):
        pid = self._envelope(last_contact_days=9, party_status="signed")
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(self._events(pid, "reminded"), [])

    def test_does_not_chase_an_envelope_that_is_already_past_expiry(self):
        pid = self._envelope(last_contact_days=9,
                             expires_on=(datetime.now(timezone.utc).date() - timedelta(days=2)).isoformat())
        reminders.run_esign_chase(self.db)
        self.db.commit()
        self.assertEqual(self._events(pid, "reminded"), [])

    # ── expiry ──────────────────────────────────────────────────────────────
    def test_expires_a_passed_envelope_and_tells_the_sender(self):
        self._envelope(last_contact_days=1,
                       expires_on=(datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat())
        reminders.run_esign_expiry(self.db)
        self.db.commit()
        req = self.db.query(models.HrSignRequest).filter(models.HrSignRequest.id == REQ).first()
        self.assertEqual(req.status, "expired")
        expired = self._bells("esign_expired")
        self.assertEqual(len(expired), 1)
        self.assertEqual(expired[0].recipient, SENDER)

    def test_leaves_an_unexpired_envelope_alone(self):
        self._envelope(last_contact_days=1,
                       expires_on=(datetime.now(timezone.utc).date() + timedelta(days=5)).isoformat())
        reminders.run_esign_expiry(self.db)
        self.db.commit()
        req = self.db.query(models.HrSignRequest).filter(models.HrSignRequest.id == REQ).first()
        self.assertEqual(req.status, "pending")
        self.assertEqual(self._bells("esign_expired"), [])

    def test_a_non_iso_expiry_date_never_expires_on_a_guess(self):
        """US-format dates exist in this app - one must not lose a string
        compare and instantly expire a live envelope."""
        self._envelope(last_contact_days=1, expires_on="12/31/2026")
        reminders.run_esign_expiry(self.db)
        self.db.commit()
        req = self.db.query(models.HrSignRequest).filter(models.HrSignRequest.id == REQ).first()
        self.assertEqual(req.status, "pending")


if __name__ == "__main__":
    unittest.main()
