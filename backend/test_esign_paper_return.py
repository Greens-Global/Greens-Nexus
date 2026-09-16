"""Nexus Sign paper signing - the whole flow, not a dead end.

Neil, Sep 16, walking through DocuSign's paper path: the product must carry the
signer all the way - "how would you like to return it? ... first download this
and then scan it in" - rather than declining and dropping them back in their
inbox to work it out.

So the path under test is: consent, choose paper, upload the scan, and the
envelope completes with a WET signature on the record.

What it is actually guarding:

  * a returned paper copy COMPLETES the signature - it is not a decline;
  * consent still comes first, but a one-time code is deliberately NOT demanded
    (the wet signature is the authentication, and requiring a code from someone
    who chose not to sign online would defeat the option);
  * the certificate calls it a wet signature rather than printing "Paper" and
    letting a reader assume someone clicked something;
  * the scan is retained as evidence with its digest;
  * the envelope ID lands on every page of the finished document.

    python -m unittest test_esign_paper_return
"""
import io
import json
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import esign

SENDER = "sender.paper@greensglobal.com"
GROUP = "grp-nexus-sign-paper"
ENTITY = "ent-nexus-sign-paper"


def _pdf(pages=1) -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"Agreement - page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


class PaperReturnTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Paper", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=SENDER))
            db.add(models.HrEntity(id=ENTITY, name="Greens Residential, Inc."))
            db.commit()
            esign._ensure_document_classes(db)
        finally:
            db.close()
        cache.module_grants.invalidate()

        self._real_sign_mail = esign._send_sign_email
        self._real_sealed_mail = esign._send_sealed_email
        self._real_push = esign._egnyte_push
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._egnyte_push = lambda *a, **k: (True, "filed in Egnyte /Shared/test")

    def tearDown(self):
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
            if ids:
                for m in (models.HrSignConsent, models.HrSignParty,
                          models.HrSignDocument, models.HrSignSeal,
                          models.HrSignOtpChallenge, models.HrSignUpload):
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

    def _send(self, pages=3):
        payload = {
            "title": "Master Services Agreement",
            "entityId": ENTITY,
            "routing": "sequential",
            "excludedAck": True,
            "documentClass": "subcontract",
            "fields": [{"id": "sig1", "role": "a", "type": "sign", "page": 0,
                        "x": 0.1, "y": 0.8, "w": 0.3, "h": 0.06, "required": True}],
            "parties": [{"roleKey": "a", "name": "Dana Fields",
                         "email": "dana@partner.example", "kind": "external",
                         "ordinal": 1, "partyRole": "signer"}],
        }
        r = self.client.post("/esign/requests/pdf",
                             files={"file": ("MSA.pdf", _pdf(pages), "application/pdf")},
                             data={"payload": json.dumps(payload)})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        db = database.SessionLocal()
        try:
            party = db.query(models.HrSignParty).filter(
                models.HrSignParty.request_id == rid).first()
            return rid, party.token
        finally:
            db.close()

    def _consent(self, token):
        r = self.client.post(f"/esign/public/{token}/consent", json={"agreed": True})
        self.assertEqual(r.status_code, 200, r.text)

    def _return_paper(self, token, blob=b"%PDF-1.4 wet signed", name="signed-scan.pdf"):
        return self.client.post(f"/esign/public/{token}/paper",
                                files={"file": (name, blob, "application/pdf")})

    def _req(self, rid):
        db = database.SessionLocal()
        try:
            return db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == rid).first()
        finally:
            db.close()

    # ── the flow ────────────────────────────────────────────────────────────

    def test_returning_paper_completes_the_envelope(self):
        rid, token = self._send()
        self._consent(token)
        r = self._return_paper(token)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "completed")
        self.assertEqual(self._req(rid).status, "completed")

    def test_no_one_time_code_is_demanded(self):
        """Deliberate: the wet signature authenticates, and demanding a code
        from someone who chose not to sign online defeats the option."""
        _, token = self._send()
        self._consent(token)
        self.assertEqual(self._return_paper(token).status_code, 200)

    def test_consent_is_still_required_first(self):
        _, token = self._send()
        r = self._return_paper(token)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("disclosure", r.json()["detail"])

    def test_it_is_a_signature_not_a_decline(self):
        rid, token = self._send()
        self._consent(token)
        self._return_paper(token)
        db = database.SessionLocal()
        try:
            party = db.query(models.HrSignParty).filter(
                models.HrSignParty.request_id == rid).first()
            self.assertEqual(party.status, "signed")
            self.assertEqual(party.signature_kind, "paper")
            self.assertTrue(party.signed_at)
        finally:
            db.close()

    def test_the_scan_is_retained_with_its_digest(self):
        import hashlib
        rid, token = self._send()
        self._consent(token)
        blob = b"%PDF-1.4 the actual wet signed scan"
        self._return_paper(token, blob=blob, name="Dana signed.pdf")
        db = database.SessionLocal()
        try:
            row = (db.query(models.HrSignUpload)
                   .filter(models.HrSignUpload.request_id == rid,
                           models.HrSignUpload.field_id == esign.PAPER_FIELD_ID,
                           models.HrSignUpload.superseded_at == "").first())
            self.assertIsNotNone(row, "the returned scan was not retained")
            self.assertEqual(row.name, "Dana signed.pdf")
            self.assertEqual(row.sha256, hashlib.sha256(blob).hexdigest())
        finally:
            db.close()

    def test_a_junk_file_is_refused(self):
        _, token = self._send()
        self._consent(token)
        r = self._return_paper(token, blob=b"MZ\x90\x00", name="payload.exe")
        self.assertEqual(r.status_code, 400, r.text)

    # ── the record ──────────────────────────────────────────────────────────

    def test_the_certificate_calls_it_a_wet_signature(self):
        rid, token = self._send()
        self._consent(token)
        self._return_paper(token)
        html = self._req(rid).certificate_html
        self.assertIn("Wet signature", html)
        self.assertIn("signed on paper", html)

    def test_the_certificate_does_not_claim_a_one_time_code(self):
        rid, token = self._send()
        self._consent(token)
        self._return_paper(token)
        self.assertIn("No one-time code", self._req(rid).certificate_html)

    def test_the_envelope_id_is_on_every_page(self):
        rid, token = self._send(pages=4)
        self._consent(token)
        self._return_paper(token)
        req = self._req(rid)
        got = esign._storage_fetch(esign._DOC_BUCKET, req.final_pdf_path)
        self.assertTrue(got.is_success)
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(got.content))
        # The four content pages each carry it; the certificate stamps its own.
        for i in range(4):
            text = (reader.pages[i].extract_text() or "").replace("\n", " ")
            self.assertIn(rid, text, f"page {i + 1} is missing the envelope ID")
            self.assertIn(f"Page {i + 1} of 4", text)


class HistoryTests(PaperReturnTests):
    """The history panel - Neil: "This is actually excellent ... you need to get
    this exactly right." Right means it reads as a narrative and withholds the
    other parties' network detail."""

    def test_history_tells_the_story_in_order(self):
        rid, token = self._send()
        self._consent(token)
        r = self.client.get(f"/esign/public/{token}/history")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["envelopeId"], rid)
        kinds = [e["type"] for e in body["events"]]
        self.assertIn("created", kinds)
        self.assertIn("sent", kinds)
        self.assertIn("consented", kinds)
        # Ordered, and each entry is named in English rather than by its code.
        labels = [e["label"] for e in body["events"]]
        self.assertIn("Envelope created", labels)
        self.assertIn("Electronic records disclosure accepted", labels)
        self.assertEqual(body["events"], sorted(body["events"], key=lambda e: e["at"]))

    def test_history_marks_the_viewers_own_actions(self):
        _, token = self._send()
        self._consent(token)
        events = self.client.get(f"/esign/public/{token}/history").json()["events"]
        consent = next(e for e in events if e["type"] == "consented")
        self.assertTrue(consent["you"], "the signer's own action is not marked")
        # Their own network detail is shown back to them...
        self.assertTrue(consent["ip"])
        # ...but the envelope's creation, which was the SENDER's action, is not.
        created = next(e for e in events if e["type"] == "created")
        self.assertFalse(created["you"])
        self.assertEqual(created["ip"], "", "another party's IP leaked to a public page")

    def test_history_hides_the_plumbing(self):
        """Sealing and archiving describe what the system did to store the
        record; they mean nothing to the person who signed it."""
        _, token = self._send()
        self._consent(token)
        self._return_paper(token)
        kinds = {e["type"] for e in
                 self.client.get(f"/esign/public/{token}/history").json()["events"]}
        self.assertIn("completed", kinds)
        self.assertFalse(kinds & esign._HISTORY_HIDDEN, f"operational events leaked: {kinds}")


if __name__ == "__main__":
    unittest.main()
