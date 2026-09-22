"""Required fields on a realistic packet - review section 7.

The walkthrough asked specifically for a document with roughly eight required
fields over six pages, mixing signature, text, checkbox, dropdown and radio.
Everything here is built on exactly that shape, because the failure modes only
appear at that size: a single field on a single page can be satisfied by
accident.

The rule under test is the blunt one - "the signer must not be able to finish
while mandatory fields are incomplete" - and it is tested against the API, not
the screen. The signing UI blocks Finish, but a POST straight to /sign skips
the UI entirely, so client-side blocking alone would mean the rule does not
actually hold.

    python -m unittest test_esign_required_fields
"""
import io
import json
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
# The flood backstop is not what this suite tests, and it counts: a packet this
# size takes four /esign/public/ calls to open, so fourteen envelopes in two
# seconds go straight past the 30/min anonymous budget and every assertion
# reads 429 instead of the thing under test. Must be set before main imports -
# the middleware reads it at class-definition time.
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import esign

SENDER = "sender.fields@greensglobal.com"
GROUP = "grp-required-fields"
PAGES = 6


def _pdf(pages=PAGES) -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"Services Agreement - page {i + 1} of {pages}")
        c.showPage()
    c.save()
    return buf.getvalue()


# Eight required fields spread over all six pages, plus two deliberately
# optional ones so the test can tell "blocked because required" apart from
# "blocked because empty".
FIELDS = [
    {"id": "sig_client",   "type": "sign",     "page": 0, "label": "Client signature"},
    {"id": "legal_name",   "type": "text",     "page": 0, "label": "Legal entity name"},
    {"id": "tax_id",       "type": "text",     "page": 1, "label": "Tax ID"},
    {"id": "term",         "type": "dropdown", "page": 2, "label": "Contract term",
     "options": ["12 months", "24 months", "36 months"]},
    {"id": "billing",      "type": "radio",    "page": 3, "label": "Billing cycle",
     "options": ["Monthly", "Quarterly"]},
    {"id": "insured",      "type": "check",    "page": 4, "label": "Insurance confirmed"},
    {"id": "w9",           "type": "check",    "page": 4, "label": "W-9 on file"},
    {"id": "notice_addr",  "type": "text",     "page": 5, "label": "Notice address"},
    # Optional - must never block Finish.
    {"id": "cost_center",  "type": "text",     "page": 1, "label": "Cost center", "required": False},
    {"id": "comments",     "type": "text",     "page": 5, "label": "Comments",    "required": False},
]

REQUIRED_IDS = [f["id"] for f in FIELDS if f.get("required", True) and f["type"] != "sign"]

COMPLETE = {
    "legal_name": "Coastline Concrete & Grading, Inc.",
    "tax_id": "88-1234567",
    "term": "24 months",
    "billing": "Quarterly",
    "insured": True,
    "w9": True,
    "notice_addr": "1400 Harbor Blvd, Suite 200, Costa Mesa CA 92626",
}


def _geom(i):
    """Boxes that never overlap and stay inside the page."""
    return {"x": 0.1, "y": 0.1 + (i % 6) * 0.12, "w": 0.3, "h": 0.05}


class RequiredFieldTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Fields", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=SENDER))
            db.commit()
            esign._ensure_document_classes(db)
        finally:
            db.close()
        cache.module_grants.invalidate()

        self.codes = {}
        self._real_send = esign.sign_otp._send_email
        self._real_sign_mail = esign._send_sign_email
        self._real_sealed_mail = esign._send_sealed_email
        self._real_push = esign._egnyte_push

        def _capture(to_email, code, title, sender_name):
            self.codes[to_email] = code
            return ""

        esign.sign_otp._send_email = _capture
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._egnyte_push = lambda *a, **k: (True, "")

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
                          models.HrSignOtpChallenge):
                    db.query(m).filter(m.request_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.HrSignRequest).filter(
                    models.HrSignRequest.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.commit()
        finally:
            db.close()

    def _open_envelope(self, extra=()):
        """Send the six-page packet and clear both gates, returning the token."""
        fields = []
        for i, f in enumerate([*FIELDS, *extra]):
            fields.append({**f, "role": "a", **_geom(i)})
        payload = {
            "title": "Services Agreement", "routing": "sequential", "excludedAck": True,
            "documentClass": "subcontract", "governingLaw": "TX", "fields": fields,
            "parties": [{"roleKey": "a", "name": "Dana Fields", "email": "dana@partner.example",
                         "kind": "external", "ordinal": 1, "partyRole": "signer"}],
        }
        r = self.client.post("/esign/requests/pdf",
                             files={"file": ("Services Agreement.pdf", _pdf(), "application/pdf")},
                             data={"payload": json.dumps(payload)})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        db = database.SessionLocal()
        try:
            party = db.query(models.HrSignParty).filter(
                models.HrSignParty.request_id == rid).first()
            token, email = party.token, party.email
        finally:
            db.close()
        self.assertEqual(self.client.post(f"/esign/public/{token}/consent",
                                          json={"agreed": True}).status_code, 200)
        self.client.post(f"/esign/public/{token}/otp/request", json={"channel": "email"})
        self.assertEqual(self.client.post(f"/esign/public/{token}/otp/verify",
                                          json={"code": self.codes[email]}).status_code, 200)
        return rid, token

    def _sign(self, token, values, signature="Dana Fields"):
        return self.client.post(f"/esign/public/{token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": signature,
            "field_values": values, "format_demonstrated": "pdf_rendered_in_session",
            "pages_viewed": PAGES, "pages_total": PAGES})

    # ── the packet itself ───────────────────────────────────────────────────

    def test_the_packet_carries_every_field_across_every_page(self):
        rid, token = self._open_envelope()
        payload = self.client.get(f"/esign/public/{token}").json()
        self.assertEqual(payload["gate"], "")
        mine = payload["myFields"]
        self.assertEqual(len(mine), len(FIELDS))
        self.assertEqual(sorted({f["page"] for f in mine}), list(range(PAGES)),
                         "fields did not survive across all six pages")
        self.assertEqual({f["type"] for f in mine},
                         {"sign", "text", "dropdown", "radio", "check"})
        # Options survive the round trip, or a dropdown renders empty.
        term = next(f for f in mine if f["id"] == "term")
        self.assertEqual(term["options"], ["12 months", "24 months", "36 months"])

    def test_the_required_flag_is_stored_not_assumed(self):
        rid, _ = self._open_envelope()
        db = database.SessionLocal()
        try:
            stored = {f["id"]: f["required"]
                      for f in db.query(models.HrSignRequest)
                      .filter(models.HrSignRequest.id == rid).first().fields}
        finally:
            db.close()
        self.assertFalse(stored["cost_center"])
        self.assertFalse(stored["comments"])
        for fid in REQUIRED_IDS + ["sig_client"]:
            self.assertTrue(stored[fid], fid)

    # ── the rule ────────────────────────────────────────────────────────────

    def test_each_missing_required_field_blocks_the_signature_by_name(self):
        """One at a time, so a field that silently stopped being enforced shows
        up as its own failure rather than hiding behind another."""
        for fid in REQUIRED_IDS:
            _, token = self._open_envelope()
            values = {k: v for k, v in COMPLETE.items() if k != fid}
            r = self._sign(token, values)
            self.assertEqual(r.status_code, 400, f"{fid} did not block signing: {r.text}")
            label = next(f["label"] for f in FIELDS if f["id"] == fid)
            self.assertIn(label, r.json()["detail"],
                          f"{fid} blocked signing but was not named")

    def test_a_blank_checkbox_blocks_even_though_it_posts_a_value(self):
        """False is a value; it is not a completed acknowledgment."""
        _, token = self._open_envelope()
        r = self._sign(token, {**COMPLETE, "insured": False})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Insurance confirmed", r.json()["detail"])

    def test_whitespace_is_not_an_answer(self):
        _, token = self._open_envelope()
        r = self._sign(token, {**COMPLETE, "tax_id": "   "})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Tax ID", r.json()["detail"])

    def test_auto_filled_name_and_date_boxes_never_block_finish(self):
        """A name or date box is drawn by _finalize from the party row and
        signed_at, and the signing screen shows it read-only - so the signer
        has nothing to type and these can never be "still empty". Demanding a
        submitted value made Finish impossible on every envelope carrying one
        (Sagar, Sep 22 2026)."""
        _, token = self._open_envelope(extra=[
            {"id": "printed_name", "type": "name", "page": 0, "label": "Name"},
            {"id": "signed_on", "type": "date", "page": 0, "label": "Date"},
        ])
        r = self._sign(token, COMPLETE)   # no value for either of them
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "completed")

    def test_optional_fields_never_block(self):
        _, token = self._open_envelope()
        r = self._sign(token, COMPLETE)   # cost_center and comments left out
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "completed")

    def test_a_complete_packet_seals_with_every_value_recorded(self):
        rid, token = self._open_envelope()
        self.assertEqual(self._sign(token, COMPLETE).status_code, 200)
        db = database.SessionLocal()
        try:
            party = db.query(models.HrSignParty).filter(
                models.HrSignParty.request_id == rid).one()
            req = db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == rid).first()
        finally:
            db.close()
        self.assertEqual(party.status, "signed")
        for k, v in COMPLETE.items():
            self.assertEqual(party.field_values.get(k), v, k)
        self.assertEqual(req.status, "completed")
        self.assertTrue(req.final_pdf_path)
        # Six source pages plus the certificate: the packet was not truncated
        # while being stamped and merged.
        from pypdf import PdfReader
        blob = esign._storage_fetch(esign._DOC_BUCKET, req.final_pdf_path)
        self.assertTrue(blob.is_success)
        self.assertGreater(len(PdfReader(io.BytesIO(blob.content)).pages), PAGES)

    def test_a_signature_is_still_required_alongside_the_fields(self):
        _, token = self._open_envelope()
        r = self._sign(token, COMPLETE, signature="")
        self.assertEqual(r.status_code, 400, r.text)


if __name__ == "__main__":
    unittest.main()
