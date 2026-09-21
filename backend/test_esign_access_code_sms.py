"""
The access code goes out by TEXT, with the signer's invite (Sagar, Sep 21 2026).

The code is the second factor on top of the emailed link - which is exactly
what the certificate claims ("plus an out-of-band access code",
services/certificate.py). So Nexus texts it or the sender shares it by hand;
it is never emailed, because a code in the same inbox as the link is one
channel wearing two hats.

    python -m unittest test_esign_access_code_sms
"""
import os
import tempfile
import unittest
import uuid
from unittest.mock import patch

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
# A throwaway database: these tests write sign events, and hr_sign_events is
# append-only by trigger - there is no cleaning up after them.
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import database          # noqa: E402
import models            # noqa: E402
from routers import esign   # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

SENDER = "sender.code@greensglobal.com"
SIGNER = "signer.code@example.com"


class AccessCodeSmsTests(unittest.TestCase):
    def setUp(self):
        self.req_id = f"req-code-{uuid.uuid4()}"
        self.db = database.SessionLocal()
        self.req = models.HrSignRequest(id=self.req_id, title="Vendor NDA", status="pending",
                                        routing="sequential", current_order=1, created_by=SENDER,
                                        created_at="2026-09-21T00:00:00+00:00")
        self.db.add(self.req)
        self.db.commit()

    def tearDown(self):
        for m in (models.HrSignEvent, models.HrSignParty, models.HrSignRequest):
            self.db.query(m).filter(m.request_id == self.req_id).delete() if m is not models.HrSignRequest \
                else self.db.query(m).filter(m.id == self.req_id).delete()
        self.db.commit()
        self.db.close()

    def _party(self, **kw):
        p = models.HrSignParty(id=f"party-{uuid.uuid4()}", request_id=self.req_id, name="Sam Vendor",
                               email=SIGNER, kind="external", party_role="signer", ordinal=1,
                               status="waiting", **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def _events(self):
        return [(e.type, e.detail) for e in self.db.query(models.HrSignEvent)
                .filter(models.HrSignEvent.request_id == self.req_id).all()]

    def test_the_code_is_texted_when_the_sender_asked_for_it(self):
        p = self._party(access_code="K7P2-QX9M", phone="+1 555 0142", code_sms=True)
        with patch.object(esign.sentdm, "send_otp", return_value=(True, "")) as sms:
            esign._send_access_code_sms(self.db, p, self.req)
        self.assertEqual(sms.call_count, 1)
        phone, code, fallback = sms.call_args[0]
        self.assertEqual(code, "K7P2-QX9M")
        self.assertIn("K7P2-QX9M", fallback)
        self.assertIn("Vendor NDA", fallback)
        types = [t for t, _ in self._events()]
        self.assertIn("access_code_sent", types)
        detail = next(d for t, d in self._events() if t == "access_code_sent")
        self.assertIn("0142", detail)          # masked, last four only
        self.assertNotIn("K7P2", detail)       # the code itself never lands in the log

    def test_nothing_is_texted_without_the_ask_a_code_or_a_number(self):
        for kw in ({"access_code": "K7P2-QX9M", "phone": "+1 555 0142", "code_sms": False},
                   {"access_code": "", "phone": "+1 555 0142", "code_sms": True},
                   {"access_code": "K7P2-QX9M", "phone": "", "code_sms": True}):
            with self.subTest(**kw):
                p = self._party(**kw)
                with patch.object(esign.sentdm, "send_otp", return_value=(True, "")) as sms:
                    esign._send_access_code_sms(self.db, p, self.req)
                sms.assert_not_called()

    def test_a_failed_text_is_recorded_and_never_raises(self):
        """An SMS hiccup must not lose the envelope - the sender can still read
        the code off the request and pass it on - but it has to be evidence."""
        p = self._party(access_code="K7P2-QX9M", phone="+1 555 0142", code_sms=True)
        with patch.object(esign.sentdm, "send_otp", return_value=(False, "carrier rejected")):
            esign._send_access_code_sms(self.db, p, self.req)
        types = [t for t, _ in self._events()]
        self.assertIn("access_code_send_failed", types)
        self.assertNotIn("access_code_sent", types)

    def test_an_exception_from_the_sms_client_is_contained(self):
        p = self._party(access_code="K7P2-QX9M", phone="+1 555 0142", code_sms=True)
        with patch.object(esign.sentdm, "send_otp", side_effect=RuntimeError("boom")):
            esign._send_access_code_sms(self.db, p, self.req)   # must not raise
        self.assertIn("access_code_send_failed", [t for t, _ in self._events()])

    def test_the_code_is_never_put_in_the_invite_email(self):
        """The certificate calls it out-of-band; emailing it to the same inbox
        as the link would make that untrue."""
        p = self._party(access_code="K7P2-QX9M", phone="+1 555 0142", code_sms=True)
        sender = {"name": "Sagar", "email": SENDER}
        with patch.object(esign, "_send_sign_email", return_value=(True, "")) as mail, \
             patch.object(esign.sentdm, "send_otp", return_value=(True, "")):
            esign._notify_party(self.db, p, self.req, "Sagar")
        self.assertEqual(mail.call_count, 1)
        self.assertNotIn("K7P2-QX9M", str(mail.call_args))
        self.assertEqual(p.status, "notified")
        _ = sender


if __name__ == "__main__":
    unittest.main()
