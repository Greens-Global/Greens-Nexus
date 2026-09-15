"""Nexus Sign - the external signer's journey, end to end.

The review's P0 list is almost entirely about ORDER and about what is true at
each step, so this drives the real endpoints in the real order rather than
asserting on helpers:

    send  ->  open link  ->  consent  ->  one-time code  ->  document
          ->  sign  ->  fully executed  ->  certificate

What it is actually guarding:

  * the document is WITHHELD until both gates are cleared - the server never
    ships a URL the signer is not yet entitled to, so the gate survives a
    client that ignores it;
  * no signature completes without a verified code;
  * the certificate names the real source document, the real sending entity,
    US-ordered dates, "Fully Executed", and the code that authorized each
    signature.

    python -m unittest test_esign_nexus_sign_flow
"""
import io
import json
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import esign

SENDER = "sender.flow@greensglobal.com"
GROUP = "grp-nexus-sign-flow"
ENTITY = "ent-nexus-sign-flow"


def _pdf(pages=1, text="Subcontract") -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"{text} - page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


class NexusSignFlowTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Flow", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=SENDER))
            db.add(models.HrEntity(id=ENTITY, name="Greens Residential, Inc."))
            db.commit()
            esign._ensure_document_classes(db)
        finally:
            db.close()
        cache.module_grants.invalidate()

        # Capture the code instead of mailing it, so the test is identical on a
        # machine that happens to have Graph credentials configured.
        self.codes = {}
        self._real_send = esign.sign_otp._send_email

        def _capture(to_email, code, title, sender_name):
            self.codes[to_email] = code
            return ""

        esign.sign_otp._send_email = _capture
        # Outbound mail and the Egnyte copy are side effects, not behavior
        # under test; both are already best-effort in the engine.
        self._real_sign_mail = esign._send_sign_email
        self._real_sealed_mail = esign._send_sealed_email
        self._real_push = esign._egnyte_push
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._egnyte_push = lambda *a, **k: (True, "filed in Egnyte /Shared/test")

    def tearDown(self):
        esign.sign_otp._send_email = self._real_send
        esign._send_sign_email = self._real_sign_mail
        esign._send_sealed_email = self._real_sealed_mail
        esign._egnyte_push = self._real_push
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            ids = [r.id for r in db.query(models.HrSignRequest)
                   .filter(models.HrSignRequest.created_by == SENDER).all()]
            if ids:      # audit events are append-only and stay, by design
                for m in (models.HrSignConsent, models.HrSignParty,
                          models.HrSignDocument, models.HrSignSeal,
                          models.HrSignOtpChallenge):
                    db.query(m).filter(m.request_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.HrSignRequest).filter(
                    models.HrSignRequest.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.query(models.HrEntity).filter(models.HrEntity.id == ENTITY).delete()
            db.commit()
        finally:
            db.close()

    # ── helpers ─────────────────────────────────────────────────────────────

    def _send(self, filename="Master Services Agreement.pdf", phone=""):
        """One external signer, one placed signature field."""
        payload = {
            "title": "Master Services Agreement",
            "entityId": ENTITY,
            "routing": "sequential",
            "excludedAck": True,
            "documentClass": "subcontract",
            "governingLaw": "TX",
            "fields": [{"id": "sig1", "role": "a", "type": "sign", "page": 0,
                        "x": 0.1, "y": 0.8, "w": 0.3, "h": 0.06, "required": True}],
            "parties": [{"roleKey": "a", "name": "Dana Fields",
                         "email": "dana@partner.example", "kind": "external",
                         "ordinal": 1, "partyRole": "signer", "phone": phone}],
        }
        r = self.client.post("/esign/requests/pdf",
                             files={"file": (filename, _pdf(), "application/pdf")},
                             data={"payload": json.dumps(payload)})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        db = database.SessionLocal()
        try:
            party = db.query(models.HrSignParty).filter(
                models.HrSignParty.request_id == rid).first()
            return rid, party.token, party.email
        finally:
            db.close()

    def _req(self, rid):
        db = database.SessionLocal()
        try:
            return db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == rid).first()
        finally:
            db.close()

    def _consent(self, token):
        r = self.client.post(f"/esign/public/{token}/consent", json={"agreed": True})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _verify_code(self, token, email, channel="email"):
        r = self.client.post(f"/esign/public/{token}/otp/request", json={"channel": channel})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post(f"/esign/public/{token}/otp/verify",
                             json={"code": self.codes[email]})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _sign(self, token):
        return self.client.post(f"/esign/public/{token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": "Dana Fields",
            "format_demonstrated": "pdf_rendered_in_session",
            "pages_viewed": 1, "pages_total": 1})

    # ── the journey ─────────────────────────────────────────────────────────

    def test_the_document_is_withheld_until_consent(self):
        _, token, _ = self._send()
        p = self.client.get(f"/esign/public/{token}").json()
        self.assertEqual(p["gate"], "consent")
        self.assertNotIn("pdfUrl", p, "the document was sent before consent")
        self.assertNotIn("fields", p)
        # ...but the signer still learns who is asking, and can take a copy.
        self.assertEqual(p["sender"]["email"], SENDER)
        self.assertTrue(p["copyUrl"])

    def test_the_document_is_withheld_until_the_code_is_verified(self):
        _, token, email = self._send()
        self._consent(token)
        p = self.client.get(f"/esign/public/{token}").json()
        self.assertEqual(p["gate"], "otp")
        self.assertNotIn("pdfUrl", p, "the document was sent before verification")
        self.assertEqual([c["channel"] for c in p["otpChannels"]], ["email"])

        self._verify_code(token, email)
        p = self.client.get(f"/esign/public/{token}").json()
        self.assertEqual(p["gate"], "")
        self.assertTrue(p["pdfUrl"], "the document was still withheld after both gates")

    def test_sms_is_offered_only_when_the_sender_supplied_a_number(self):
        _, token, _ = self._send(phone="(949) 555-0134")
        self._consent(token)
        p = self.client.get(f"/esign/public/{token}").json()
        self.assertEqual([c["channel"] for c in p["otpChannels"]], ["email", "sms"])
        self.assertTrue(p["otpChannels"][1]["masked"].endswith("0134"))

    def test_no_signature_completes_without_a_verified_code(self):
        rid, token, _ = self._send()
        self._consent(token)
        r = self._sign(token)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self._req(rid).status, "pending")

    def test_a_spent_code_cannot_be_replayed(self):
        """A forwarded email must not let someone sign twice, or sign after the
        signer already did."""
        _, token, email = self._send()
        self._consent(token)
        code = None
        self.client.post(f"/esign/public/{token}/otp/request", json={"channel": "email"})
        code = self.codes[email]
        self.assertEqual(self.client.post(f"/esign/public/{token}/otp/verify",
                                          json={"code": code}).status_code, 200)
        again = self.client.post(f"/esign/public/{token}/otp/verify", json={"code": code})
        self.assertEqual(again.status_code, 400, again.text)

    def test_the_full_journey_ends_fully_executed(self):
        rid, token, email = self._send()
        self._consent(token)
        self._verify_code(token, email)
        r = self._sign(token)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "completed")

        req = self._req(rid)
        self.assertEqual(req.status, "completed")
        self.assertTrue(req.final_pdf_path)
        self.assertTrue(req.final_sha256)
        self.assertTrue(req.certificate_html)

    def test_the_certificate_states_what_actually_happened(self):
        rid, token, email = self._send(filename="Master Services Agreement.pdf")
        self._consent(token)
        self._verify_code(token, email)
        self.assertEqual(self._sign(token).status_code, 200)

        snap = self._req(rid).certificate_snapshot
        env = snap["envelope"]
        # Status: never "Pending" on a finished envelope (review section 17.3).
        self.assertEqual(env["status"], "Fully Executed")
        # The real sending entity, not a hardcoded one (section 17.5).
        self.assertEqual(env["entity"], "Greens Residential, Inc.")
        # The real document name, not "source.pdf" (section 17.6).
        names = [d["name"] for d in snap["documents"]]
        self.assertTrue(any("Master Services Agreement" in n for n in names), names)
        self.assertFalse(any(n == "source.pdf" for n in names), names)
        # The code that authorized the signature (section 17.7).
        signer = snap["signers"][0]
        self.assertEqual(signer["otp"]["channel"], "email")
        self.assertTrue(signer["otp"]["verified_at"])
        # The snapshot carries the human LABEL; the raw stored value is on the
        # party row. Assert both, so neither can drift from the other.
        self.assertIn("one-time code", signer["auth_method"])
        db = database.SessionLocal()
        try:
            party = db.query(models.HrSignParty).filter(
                models.HrSignParty.request_id == rid).one()
            self.assertTrue(party.auth_method.endswith("+otp"), party.auth_method)
            self.assertIn("otp:email", party.auth_factors or [])
        finally:
            db.close()

        html = self._req(rid).certificate_html
        self.assertIn("Nexus Sign", html)
        self.assertIn("Fully Executed", html)
        self.assertIn("Code by email, verified", html)
        # US date ordering on the certificate (section 17.4): MM-DD-YYYY, and
        # no ISO YYYY-MM-DD left anywhere a reader would see it.
        self.assertRegex(html, r"\b\d{2}-\d{2}-\d{4}\b")
        self.assertNotRegex(html, r">\s*\d{4}-\d{2}-\d{2}[ T<]")

    def test_consent_is_recorded_before_the_signature_not_with_it(self):
        rid, token, email = self._send()
        self._consent(token)
        db = database.SessionLocal()
        try:
            row = db.query(models.HrSignConsent).filter(
                models.HrSignConsent.request_id == rid).one()
            # Recorded at the gate, with no format claim yet - the document had
            # deliberately not rendered, so there was nothing to demonstrate.
            self.assertTrue(row.accepted_at)
            self.assertEqual(row.format_demonstrated, "")
            self.assertTrue(row.disclosure_digest)
        finally:
            db.close()

        self._verify_code(token, email)
        self.assertEqual(self._sign(token).status_code, 200)

        db = database.SessionLocal()
        try:
            rows = db.query(models.HrSignConsent).filter(
                models.HrSignConsent.request_id == rid).all()
            self.assertEqual(len(rows), 1, "signing created a second consent row")
            # The viewer's report lands on the SAME row at signing time.
            self.assertEqual(rows[0].format_demonstrated, "pdf_rendered_in_session")
        finally:
            db.close()

    def test_the_audit_trail_names_each_step_in_order(self):
        rid, token, email = self._send()
        self._consent(token)
        self._verify_code(token, email)
        self.assertEqual(self._sign(token).status_code, 200)
        db = database.SessionLocal()
        try:
            kinds = [e.type for e in db.query(models.HrSignEvent)
                     .filter(models.HrSignEvent.request_id == rid)
                     .order_by(models.HrSignEvent.seq).all()]
        finally:
            db.close()
        for step in ("created", "consented", "otp_sent", "otp_verified", "signed", "completed"):
            self.assertIn(step, kinds, kinds)
        self.assertLess(kinds.index("consented"), kinds.index("otp_sent"),
                        "a code was sent before consent was taken")
        self.assertLess(kinds.index("otp_verified"), kinds.index("signed"),
                        "a signature landed before the code was verified")


if __name__ == "__main__":
    unittest.main()
