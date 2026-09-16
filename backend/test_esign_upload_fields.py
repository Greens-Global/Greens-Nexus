"""Nexus Sign upload fields - the mandatory-attachment path, end to end.

Review sections 7 and 8: a realistic packet asks the signer for files, the
signer must not be able to finish without them, and where those files end up
must not be ambiguous. So this drives the real endpoints and then reads the
real record:

    send (with an upload field)  ->  gates  ->  finish is REFUSED
          ->  attach  ->  finish  ->  the file is on the certificate

What it is actually guarding:

  * a required upload field blocks Finish on the SERVER, not just on screen -
    a POST straight at /sign has to hit the same wall;
  * the upload endpoint sits behind both gates, so the public URL is not an
    open file drop;
  * re-uploading supersedes rather than accumulates, so "what did they submit"
    has one answer;
  * one party cannot read another party's attachment;
  * the fully executed certificate names the file and states its digest.

    python -m unittest test_esign_upload_fields
"""
import hashlib
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

SENDER = "sender.upload@greensglobal.com"
GROUP = "grp-nexus-sign-upload"
ENTITY = "ent-nexus-sign-upload"


def _pdf(pages=1, text="Subcontract") -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"{text} - page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


class UploadFieldTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Uploads", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=SENDER))
            db.add(models.HrEntity(id=ENTITY, name="Greens Residential, Inc."))
            db.commit()
            esign._ensure_document_classes(db)
        finally:
            db.close()
        cache.module_grants.invalidate()

        self.codes = {}
        self._real_send = esign.sign_otp._send_email

        def _capture(to_email, code, title, sender_name):
            self.codes[to_email] = code
            return ""

        esign.sign_otp._send_email = _capture
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

    # ── helpers ─────────────────────────────────────────────────────────────

    def _send(self, required=True, parties=None):
        """One signer, a signature field and an upload field asking for a COI."""
        payload = {
            "title": "Master Services Agreement",
            "entityId": ENTITY,
            "routing": "sequential",
            "excludedAck": True,
            "documentClass": "subcontract",
            "governingLaw": "TX",
            "fields": [
                {"id": "sig1", "role": "a", "type": "sign", "page": 0,
                 "x": 0.1, "y": 0.8, "w": 0.3, "h": 0.06, "required": True},
                {"id": "coi", "role": "a", "type": "upload", "page": 0,
                 "label": "Certificate of insurance",
                 "x": 0.1, "y": 0.6, "w": 0.3, "h": 0.04, "required": required},
            ],
            "parties": parties or [
                {"roleKey": "a", "name": "Dana Fields", "email": "dana@partner.example",
                 "kind": "external", "ordinal": 1, "partyRole": "signer"}],
        }
        r = self.client.post("/esign/requests/pdf",
                             files={"file": ("MSA.pdf", _pdf(), "application/pdf")},
                             data={"payload": json.dumps(payload)})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        db = database.SessionLocal()
        try:
            rows = (db.query(models.HrSignParty)
                    .filter(models.HrSignParty.request_id == rid)
                    .order_by(models.HrSignParty.ordinal).all())
            return rid, [(p.token, p.email) for p in rows]
        finally:
            db.close()

    def _clear_gates(self, token, email):
        r = self.client.post(f"/esign/public/{token}/consent", json={"agreed": True})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post(f"/esign/public/{token}/otp/request", json={"channel": "email"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post(f"/esign/public/{token}/otp/verify", json={"code": self.codes[email]})
        self.assertEqual(r.status_code, 200, r.text)

    def _attach(self, token, blob=b"%PDF-1.4 insurance", name="COI.pdf", field="coi"):
        return self.client.post(f"/esign/public/{token}/upload",
                                files={"file": (name, blob, "application/pdf")},
                                data={"field_id": field})

    def _sign(self, token, who="Dana Fields"):
        return self.client.post(f"/esign/public/{token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": who,
            "format_demonstrated": "pdf_rendered_in_session",
            "pages_viewed": 1, "pages_total": 1})

    # ── the guard ───────────────────────────────────────────────────────────

    def test_finish_is_refused_while_a_required_upload_is_missing(self):
        _, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        r = self._sign(token)
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Certificate of insurance", r.json()["detail"])

    def test_an_optional_upload_does_not_block_finish(self):
        _, parties = self._send(required=False)
        token, email = parties[0]
        self._clear_gates(token, email)
        self.assertEqual(self._sign(token).status_code, 200)

    def test_attaching_the_file_unblocks_finish(self):
        _, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        r = self._attach(token)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["name"], "COI.pdf")
        self.assertEqual(self._sign(token).status_code, 200)

    # ── the gates apply to the upload endpoint too ──────────────────────────

    def test_upload_is_refused_before_consent(self):
        _, parties = self._send()
        token, _ = parties[0]
        r = self._attach(token)
        # 409, the same answer _require_consented gives the one-time code -
        # the step is out of order, not forbidden.
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("disclosure", r.json()["detail"])

    def test_upload_is_refused_before_the_code_is_verified(self):
        _, parties = self._send()
        token, _ = parties[0]
        self.client.post(f"/esign/public/{token}/consent", json={"agreed": True})
        r = self._attach(token)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("one-time code", r.json()["detail"])

    # ── what is accepted ────────────────────────────────────────────────────

    def test_an_executable_is_refused(self):
        _, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        r = self._attach(token, blob=b"MZ\x90\x00", name="payload.exe")
        self.assertEqual(r.status_code, 400, r.text)

    def test_a_pdf_that_is_not_a_pdf_is_refused(self):
        _, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        r = self._attach(token, blob=b"not a pdf at all", name="COI.pdf")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("valid PDF", r.json()["detail"])

    def test_an_unknown_field_is_refused(self):
        _, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        r = self._attach(token, field="not-a-field")
        self.assertEqual(r.status_code, 400, r.text)

    # ── one answer to "what did they submit" ────────────────────────────────

    def test_re_uploading_supersedes_rather_than_accumulates(self):
        rid, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        self._attach(token, blob=b"%PDF-1.4 first", name="first.pdf")
        self._attach(token, blob=b"%PDF-1.4 second", name="second.pdf")
        p = self.client.get(f"/esign/public/{token}").json()
        self.assertEqual([u["name"] for u in p["uploads"]], ["second.pdf"])
        # The replaced file is kept, not deleted - it is still evidence of what
        # happened, it just no longer satisfies the field.
        db = database.SessionLocal()
        try:
            rows = db.query(models.HrSignUpload).filter(
                models.HrSignUpload.request_id == rid).all()
            self.assertEqual(len(rows), 2)
            self.assertEqual(sum(1 for r in rows if not r.superseded_at), 1)
        finally:
            db.close()

    def test_a_returning_signer_sees_what_they_already_attached(self):
        _, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        self._attach(token)
        p = self.client.get(f"/esign/public/{token}").json()
        self.assertEqual(p["uploads"][0]["fieldId"], "coi")
        self.assertEqual(p["uploads"][0]["label"], "Certificate of insurance")

    # ── who may read it ─────────────────────────────────────────────────────

    def test_one_signer_cannot_read_another_signers_attachment(self):
        rid, parties = self._send(parties=[
            {"roleKey": "a", "name": "Dana Fields", "email": "dana@partner.example",
             "kind": "external", "ordinal": 1, "partyRole": "signer"},
            {"roleKey": "b", "name": "Sam Rowe", "email": "sam@partner.example",
             "kind": "external", "ordinal": 2, "partyRole": "signer"},
        ])
        (tok_a, mail_a), (tok_b, mail_b) = parties
        self._clear_gates(tok_a, mail_a)
        upload_id = self._attach(tok_a).json()["id"]
        self.assertEqual(self._sign(tok_a).status_code, 200)
        # Dana reaches her own file.
        self.assertEqual(
            self.client.get(f"/esign/public/{tok_a}/upload/{upload_id}").status_code, 200)
        # Sam, on the same envelope, does not.
        self._clear_gates(tok_b, mail_b)
        self.assertEqual(
            self.client.get(f"/esign/public/{tok_b}/upload/{upload_id}").status_code, 404)

    def test_the_sender_sees_every_attachment_on_the_envelope(self):
        rid, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        self._attach(token)
        rows = self.client.get(f"/esign/requests/{rid}/uploads").json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["partyName"], "Dana Fields")
        self.assertEqual(rows[0]["label"], "Certificate of insurance")

    # ── the record ──────────────────────────────────────────────────────────

    def test_the_certificate_names_the_file_and_states_its_digest(self):
        rid, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        blob = b"%PDF-1.4 insurance certificate"
        self._attach(token, blob=blob, name="Acme COI 2026.pdf")
        self.assertEqual(self._sign(token).status_code, 200)

        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == rid).first()
            self.assertEqual(req.status, "completed")
            snap = req.certificate_snapshot
            atts = snap.get("attachments") or []
            self.assertEqual(len(atts), 1, "the attachment is missing from the certificate")
            self.assertEqual(atts[0]["name"], "Acme COI 2026.pdf")
            self.assertEqual(atts[0]["label"], "Certificate of insurance")
            self.assertEqual(atts[0]["party"], "Dana Fields")
            self.assertEqual(atts[0]["sha256"], hashlib.sha256(blob).hexdigest())
            # ...and it is stated on the rendered certificate, not only in the
            # snapshot dict nobody reads.
            self.assertIn("Acme COI 2026.pdf", req.certificate_html)
            self.assertIn("Certificate of insurance", req.certificate_html)
        finally:
            db.close()

    def test_the_sealed_page_records_the_filename(self):
        rid, parties = self._send()
        token, email = parties[0]
        self._clear_gates(token, email)
        self._attach(token, name="Acme COI 2026.pdf")
        self.assertEqual(self._sign(token).status_code, 200)

        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == rid).first()
            path = req.final_pdf_path
        finally:
            db.close()
        got = esign._storage_fetch(esign._DOC_BUCKET, path)
        self.assertTrue(got.is_success)
        from pypdf import PdfReader
        text = PdfReader(io.BytesIO(got.content)).pages[0].extract_text() or ""
        self.assertIn("Acme COI 2026.pdf", text.replace("\n", " "))


class JurisdictionAndTimestampTests(unittest.TestCase):
    """Review sections 18 and 19 - two claims the certificate used to make
    regardless of what was actually true."""

    def test_no_jurisdiction_chosen_still_cites_a_real_authority(self):
        """The default is NO governing state. The old default was 'CA', which
        put "the State of California" on the certificate of a contract signed
        between Texas and Delhi."""
        from services.certificate import _authority_clause, _declaration_law
        env = {"governing_law": "", "governing_law_label": ""}
        self.assertIn("15 U.S.C. 7001-7031", _authority_clause(env))
        self.assertIn("applicable jurisdiction", _authority_clause(env))
        self.assertNotIn("California", _authority_clause(env))
        self.assertEqual(_declaration_law(env), "the United States of America")

    def test_a_chosen_state_is_named(self):
        from services.certificate import _authority_clause, _declaration_law
        env = {"governing_law": "TX", "governing_law_label": "Texas"}
        self.assertIn("Texas", _authority_clause(env))
        self.assertIn("Texas", _declaration_law(env))

    def test_india_cites_its_own_statute_not_ueta(self):
        from services.certificate import _authority_clause, _declaration_law
        env = {"governing_law": "IN", "governing_law_label": "India"}
        clause = _authority_clause(env)
        self.assertIn("Information Technology Act, 2000", clause)
        self.assertNotIn("Uniform Electronic Transactions Act", clause)
        self.assertEqual(_declaration_law(env), "India")

    def test_the_timestamp_row_follows_the_configuration(self):
        """It used to say "Not a third-party RFC 3161 timestamp" unconditionally
        - a false statement on a legal record the moment a TSA is configured."""
        import importlib
        import services.seal as seal
        keep = (os.environ.get("NEXUS_ESIGN_TSA_URL"), os.environ.get("NEXUS_ESIGN_SEAL"))
        try:
            os.environ.pop("NEXUS_ESIGN_TSA_URL", None)
            os.environ["NEXUS_ESIGN_SEAL"] = "dev"
            self.assertIn("Not a third-party", seal.timestamp_sentence())

            os.environ["NEXUS_ESIGN_TSA_URL"] = "http://timestamp.digicert.com"
            on = seal.timestamp_sentence()
            self.assertIn("timestamp.digicert.com", on)
            self.assertNotIn("Not a third-party", on)

            # A TSA with sealing off applies no token, and says so rather than
            # claiming one.
            os.environ["NEXUS_ESIGN_SEAL"] = "off"
            self.assertIn("no token was applied", seal.timestamp_sentence())
        finally:
            for k, v in zip(("NEXUS_ESIGN_TSA_URL", "NEXUS_ESIGN_SEAL"), keep):
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            importlib.reload(seal)


if __name__ == "__main__":
    unittest.main()
