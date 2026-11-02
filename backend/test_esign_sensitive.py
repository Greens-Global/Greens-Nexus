"""Nexus Sign field formats, encrypted sensitive values and the restricted
sealed PDF (Neil, 11/02/2026 - the federal forms plan, Task 7).

A text box may carry a `format` (ssn, routing, account, ein, zip,
date_mmddyyyy) and may be `sensitive`. The engine refuses a value that does
not fit (422 with the field id), stores a sensitive value encrypted
("enc:<token>") and decrypts it only while stamping the PDF; every other
reader - the co-signer's screen, the audit trail - sees the mask. An envelope
with a sensitive field is restricted like a pay letter: prints_pay, link-only
completion emails, Pay & Benefits to download, a viewed_final event each time
the sealed PDF is served.

    python -m pytest test_esign_sensitive.py
"""
import io
import json
import os
import tempfile
import unittest
import uuid

# A throwaway sqlite of its own, so `python -m unittest test_esign_sensitive`
# never ALTERs or clears a local greens_nexus.db (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_FROM_EMAIL", "nexus@greensglobal.com")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import middleware_hardening  # noqa: E402
import models  # noqa: E402
import secret_box  # noqa: E402
import esign_formats  # noqa: E402
from routers import esign  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
SENDER = "sal.sender" + D       # People editor + Pay & Benefits
HR_ONLY = "hal.hr" + D          # People editor, no Pay & Benefits grant
GOOD_SSN = "123-45-6789"
GOOD_ROUTING = "021000021"      # passes the ABA checksum
GOOD_ACCOUNT = "000123456789"


def _pdf(pages=1) -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"Form - page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


def _geom(i):
    return {"x": 0.1, "y": 0.1 + (i % 8) * 0.1, "w": 0.3, "h": 0.05}


SENSITIVE_FIELDS = [
    {"id": "sig", "type": "sign", "page": 0, "label": "Signature", "role": "a"},
    {"id": "ssn", "type": "text", "page": 0, "label": "Social Security Number", "role": "a",
     "format": "ssn", "sensitive": True},
    {"id": "routing", "type": "text", "page": 0, "label": "Routing Number", "role": "a",
     "format": "routing", "sensitive": True},
    {"id": "acct", "type": "text", "page": 0, "label": "Account Number", "role": "a",
     "format": "account", "sensitive": True},
    {"id": "zip", "type": "text", "page": 0, "label": "ZIP", "role": "a", "format": "zip"},
    # Sensitive with a format that carries no digits to show, and sensitive
    # with no format at all: both must mask, never show themselves.
    {"id": "passport", "type": "text", "page": 0, "label": "Foreign Passport", "role": "a",
     "format": "passport", "sensitive": True},
    {"id": "secret", "type": "text", "page": 0, "label": "Mother's Maiden Name", "role": "a",
     "sensitive": True},
    {"id": "hr_sig", "type": "sign", "page": 0, "label": "HR Signature", "role": "hr"},
]
GOOD_PASSPORT = "X1234567 Mexico"
GOOD_SECRET = "Quetzalcoatl"
GOOD_VALUES = {"ssn": GOOD_SSN, "routing": GOOD_ROUTING, "acct": GOOD_ACCOUNT, "zip": "92626",
               "passport": GOOD_PASSPORT, "secret": GOOD_SECRET}

PLAIN_FIELDS = [
    {"id": "sig", "type": "sign", "page": 0, "label": "Signature", "role": "a"},
    {"id": "note", "type": "text", "page": 0, "label": "Note", "role": "a"},
]


class SensitiveFieldTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._rl = middleware_hardening.RequestRateLimit.ENABLED
        middleware_hardening.RequestRateLimit.ENABLED = False
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        db = database.SessionLocal()
        try:
            for m in (models.NexusGroupMember, models.NexusGroup):
                db.query(m).delete()
            db.add(models.NexusGroup(id="g-comp", name="People + Pay",
                                     allowed_modules="hr:editor,hr_comp:viewer"))
            db.add(models.NexusGroup(id="g-hr", name="People Editors", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id="g-comp", email=SENDER))
            db.add(models.NexusGroupMember(group_id="g-hr", email=HR_ONLY))
            db.commit()
            esign._ensure_document_classes(db)
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()

        self.codes = {}
        self.mails = []
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_graph_send_mail", esign._graph_send_mail),
                         (esign, "_egnyte_push", esign._egnyte_push)]

        def _capture_code(to_email, code, title, sender_name):
            self.codes[to_email] = code
            return ""

        def _capture_mail(**kw):
            self.mails.append(kw)
            return True, ""

        esign.sign_otp._send_email = _capture_code
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._graph_send_mail = _capture_mail
        esign._egnyte_push = lambda *a, **k: (True, "")

    def tearDown(self):
        for obj, name, orig in self._patched:
            setattr(obj, name, orig)
        middleware_hardening.RequestRateLimit.ENABLED = self._rl
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    # ── helpers ────────────────────────────────────────────────────────────

    def _send(self, fields, with_hr=True, expect=200):
        placed = [{**f, **_geom(i)} for i, f in enumerate(fields)]
        roles = {f["role"] for f in placed}
        tag = uuid.uuid4().hex[:8]
        parties = [{"roleKey": "a", "name": "Ana Diaz", "email": f"ana.{tag}@partner.example",
                    "kind": "external", "ordinal": 1, "partyRole": "signer"}]
        if "hr" in roles and with_hr:
            parties.append({"roleKey": "hr", "name": "Hal HR", "email": HR_ONLY,
                            "kind": "internal", "ordinal": 2, "partyRole": "signer"})
        payload = {"title": f"Form W-4 {tag}", "routing": "sequential", "excludedAck": True,
                   "documentClass": "employment", "governingLaw": "CA",
                   "fields": placed, "parties": parties}
        r = self.client.post("/esign/requests/pdf",
                             files={"file": (f"w4-{tag}.pdf", _pdf(), "application/pdf")},
                             data={"payload": json.dumps(payload)})
        self.assertEqual(r.status_code, expect, r.text)
        return r

    def _parties(self, rid):
        db = database.SessionLocal()
        try:
            rows = (db.query(models.HrSignParty).filter(models.HrSignParty.request_id == rid)
                    .order_by(models.HrSignParty.ordinal).all())
            return [(p.role_key, p.token, p.email, p.id) for p in rows]
        finally:
            db.close()

    def _clear_gates(self, token, email):
        self.assertEqual(self.client.post(f"/esign/public/{token}/consent",
                                          json={"agreed": True}).status_code, 200)
        self.client.post(f"/esign/public/{token}/otp/request", json={"channel": "email"})
        self.assertEqual(self.client.post(f"/esign/public/{token}/otp/verify",
                                          json={"code": self.codes[email]}).status_code, 200)

    def _sign(self, token, values, signature="Ana Diaz"):
        return self.client.post(f"/esign/public/{token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": signature,
            "field_values": values, "format_demonstrated": "pdf_rendered_in_session",
            "pages_viewed": 1, "pages_total": 1})

    def _open_sensitive(self):
        """A W-4-shaped envelope with Ana's gates cleared; returns (rid, parties)."""
        rid = self._send(SENSITIVE_FIELDS).json()["id"]
        parties = self._parties(rid)
        _, token, email, _ = parties[0]
        self._clear_gates(token, email)
        return rid, parties

    def _req(self, rid):
        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == rid).first()
            party = (db.query(models.HrSignParty).filter(models.HrSignParty.request_id == rid)
                     .order_by(models.HrSignParty.ordinal).first())
            events = [e.type for e in db.query(models.HrSignEvent)
                      .filter(models.HrSignEvent.request_id == rid).all()]
            return req, party, events
        finally:
            db.close()

    # ── the formats module ──────────────────────────────────────────────────

    def test_formats_check_and_mask(self):
        ok = esign_formats.check
        self.assertEqual(ok("ssn", GOOD_SSN), "")
        self.assertEqual(ok("ssn", "123456789"), "")
        for bad in ("000-45-6789", "666-45-6789", "900-45-6789", "123-00-6789", "123-45-0000",
                    "12-345-6789", "abc"):
            self.assertTrue(ok("ssn", bad), bad)
        # A blank is not a format problem - the engine's own required check
        # reports it (one module with the forms package, Task 8).
        self.assertEqual(ok("ssn", ""), "")
        self.assertEqual(ok("routing", GOOD_ROUTING), "")
        self.assertTrue(ok("routing", "021000022"))      # checksum off by one
        self.assertTrue(ok("routing", "02100002"))
        self.assertEqual(ok("account", "1234"), "")
        self.assertEqual(ok("account", "1" * 17), "")
        self.assertTrue(ok("account", "123"))
        self.assertTrue(ok("account", "1" * 18))
        self.assertTrue(ok("account", "1234-5678"))
        self.assertEqual(ok("ein", "12-3456789"), "")
        self.assertTrue(ok("ein", "123-456789"))
        self.assertEqual(ok("zip", "92626"), "")
        self.assertEqual(ok("zip", "92626-1234"), "")
        self.assertTrue(ok("zip", "9262"))
        self.assertEqual(ok("date_mmddyyyy", "11/02/2026"), "")
        self.assertTrue(ok("date_mmddyyyy", "2026-11-02"))
        self.assertTrue(ok("date_mmddyyyy", "13/02/2026"))
        self.assertEqual(ok("", "anything"), "")
        self.assertEqual(ok("nope", "anything"), "")
        self.assertEqual(esign_formats.mask("ssn", GOOD_SSN), "***-**-6789")
        self.assertEqual(esign_formats.mask("account", GOOD_ACCOUNT), "••••6789")
        self.assertEqual(esign_formats.mask("routing", GOOD_ROUTING), "••••0021")
        self.assertEqual(esign_formats.mask("zip", "92626"), "••26")
        self.assertEqual(esign_formats.mask("ssn", ""), "***-**-****")
        # Never the value: a passport, an unknown format and no format at all
        # all mask to the blank shape (11/02/2026).
        self.assertEqual(esign_formats.mask("passport", "X1234567 Mexico"), "•••••")
        self.assertEqual(esign_formats.mask("", "Plain Secret"), "•••••")
        self.assertEqual(esign_formats.mask("nope", "Plain Secret"), "•••••")
        self.assertEqual(esign_formats.mask("ein", "12-3456789"), "••89")
        self.assertEqual(esign_formats.mask("ein", ""), "•••••")

    # ── placing the fields ──────────────────────────────────────────────────

    def test_clean_fields_accepts_format_and_sensitive_and_refuses_the_rest(self):
        got = esign._clean_fields([{"id": "s", "type": "text", "format": "ssn", "sensitive": 1,
                                    "role": "a", **_geom(0)}])
        self.assertEqual(got[0]["format"], "ssn")
        self.assertIs(got[0]["sensitive"], True)
        plain = esign._clean_fields([{"id": "n", "type": "text", "role": "a", **_geom(0)}])
        self.assertNotIn("format", plain[0])
        self.assertNotIn("sensitive", plain[0])
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as cm:
            esign._clean_fields([{"id": "s", "type": "text", "format": "phone", "role": "a"}])
        self.assertEqual(cm.exception.status_code, 400)
        with self.assertRaises(HTTPException) as cm:
            esign._clean_fields([{"id": "c", "type": "check", "format": "ssn", "role": "a"}])
        self.assertEqual(cm.exception.status_code, 400)
        with self.assertRaises(HTTPException) as cm:
            esign._clean_fields([{"id": "c", "type": "check", "sensitive": True, "role": "a"}])
        self.assertEqual(cm.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            esign._clean_fields([{"id": "x", "type": "hologram", "role": "a"}])

    def test_a_document_entry_keeps_its_form_kind(self):
        docs = esign._clean_documents([{"name": "W-4.pdf", "path": "esign/x/w4.pdf",
                                        "formKind": "w4", "fields": []},
                                       {"name": "Plain.pdf", "path": "esign/x/p.pdf", "fields": []}])
        self.assertEqual(docs[0]["formKind"], "w4")
        self.assertNotIn("formKind", docs[1])
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as cm:
            esign._clean_documents([{"name": "x", "path": "p", "formKind": {"a": 1}, "fields": []}])
        self.assertEqual(cm.exception.status_code, 400)

    def test_an_envelope_with_a_sensitive_field_is_restricted_from_creation(self):
        rid = self._send(SENSITIVE_FIELDS).json()["id"]
        req, _, _ = self._req(rid)
        self.assertEqual(req.prints_pay, 1)
        plain = self._send(PLAIN_FIELDS).json()["id"]
        req, _, _ = self._req(plain)
        self.assertEqual(req.prints_pay, 0)

    # ── signing ────────────────────────────────────────────────────────────

    def test_a_wrong_format_is_422_naming_the_field(self):
        _, parties = self._open_sensitive()
        token = parties[0][1]
        for fid, bad in (("ssn", "000-12-3456"), ("routing", "123456789"), ("acct", "12"),
                         ("zip", "4567")):
            r = self._sign(token, {**GOOD_VALUES, fid: bad})
            self.assertEqual(r.status_code, 422, f"{fid}: {r.text}")
            self.assertEqual(r.json()["detail"]["field"], fid)
            self.assertTrue(r.json()["detail"]["message"].endswith("."))
            self.assertNotIn(bad, r.text)

    def test_a_sensitive_value_is_stored_encrypted_and_decrypts_to_the_input(self):
        rid, parties = self._open_sensitive()
        r = self._sign(parties[0][1], GOOD_VALUES)
        self.assertEqual(r.status_code, 200, r.text)
        _, party, _ = self._req(rid)
        for fid, plain in (("ssn", GOOD_SSN), ("routing", GOOD_ROUTING), ("acct", GOOD_ACCOUNT),
                           ("passport", GOOD_PASSPORT), ("secret", GOOD_SECRET)):
            stored = party.field_values[fid]
            self.assertTrue(stored.startswith("enc:"), stored)
            self.assertNotIn(plain, json.dumps(party.field_values))
            self.assertEqual(secret_box.decrypt(stored[4:]), plain)
        self.assertEqual(party.field_values["zip"], "92626")   # a format alone is not sensitive

    def test_a_co_signer_sees_the_mask_never_the_token_or_the_value(self):
        rid, parties = self._open_sensitive()
        self.assertEqual(self._sign(parties[0][1], GOOD_VALUES).status_code, 200)
        hr_token = parties[1][1]
        payload = self.client.get(f"/esign/public/{hr_token}").json()
        filled = payload["filledByOthers"]
        self.assertEqual(filled["ssn"], "***-**-6789")
        self.assertEqual(filled["routing"], "••••0021")
        self.assertEqual(filled["acct"], "••••6789")
        self.assertEqual(filled["zip"], "92626")
        self.assertEqual(filled["passport"], "•••••")
        self.assertEqual(filled["secret"], "•••••")
        text = json.dumps(payload)
        self.assertNotIn("enc:", text)
        for plain in (GOOD_SSN, GOOD_ROUTING, GOOD_ACCOUNT, GOOD_PASSPORT, GOOD_SECRET):
            self.assertNotIn(plain, text)
        # The signer's own re-open shows the mask too - a token is never sent.
        own = self.client.get(f"/esign/public/{parties[0][1]}").json()
        self.assertEqual(own["myValues"]["ssn"], "***-**-6789")
        self.assertEqual(own["myValues"]["passport"], "•••••")
        self.assertEqual(own["myValues"]["secret"], "•••••")
        self.assertNotIn("enc:", json.dumps(own))
        for plain in (GOOD_PASSPORT, GOOD_SECRET):
            self.assertNotIn(plain, json.dumps(own))

    def test_the_stamped_pdf_carries_the_plain_value(self):
        from pypdf import PdfReader
        rid, parties = self._open_sensitive()
        self.assertEqual(self._sign(parties[0][1], GOOD_VALUES).status_code, 200)
        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == rid).first()
            rows = db.query(models.HrSignParty).filter(models.HrSignParty.request_id == rid).all()
            stamped = esign._stamp_pdf(_pdf(), req.fields, rows)
        finally:
            db.close()
        text = "".join(p.extract_text() for p in PdfReader(io.BytesIO(stamped)).pages)
        self.assertIn(GOOD_SSN, text)
        self.assertIn(GOOD_ROUTING, text)
        self.assertNotIn("enc:", text)

    # ── completion ─────────────────────────────────────────────────────────

    def _complete(self, fields, values):
        rid = self._send(fields).json()["id"]
        parties = self._parties(rid)
        for role, token, email, _ in parties:
            if role == "a":
                self._clear_gates(token, email)
                r = self._sign(token, values)
            else:
                # The internal HR signer goes through the same public engine.
                self._clear_gates(token, email)
                r = self._sign(token, {}, signature="Hal HR")
            self.assertEqual(r.status_code, 200, r.text)
        req, _, events = self._req(rid)
        self.assertEqual(req.status, "completed")
        return rid, parties

    def test_a_restricted_completion_email_carries_the_link_only(self):
        self.mails.clear()
        rid, _ = self._complete(SENSITIVE_FIELDS, GOOD_VALUES)
        req, _, _ = self._req(rid)
        self.assertEqual(req.prints_pay, 1)
        completed = [m for m in self.mails if "Completed" in m["subject"]]
        self.assertGreaterEqual(len(completed), 2)   # sender, Ana, Hal
        for m in completed:
            self.assertIsNone(m["pdf"], m["subject"])
            self.assertNotIn("is attached", m["html"])
        # Control: an ordinary envelope still attaches the sealed PDF.
        self.mails.clear()
        plain_fields = [f for f in PLAIN_FIELDS]
        rid = self._send(plain_fields).json()["id"]
        role, token, email, _ = self._parties(rid)[0]
        self._clear_gates(token, email)
        self.assertEqual(self._sign(token, {"note": "hi"}).status_code, 200)
        completed = [m for m in self.mails if "Completed" in m["subject"]]
        self.assertTrue(completed)
        self.assertTrue(all(m["pdf"] is not None for m in completed))

    def test_the_final_pdf_needs_pay_access_and_is_logged_as_viewed(self):
        rid, parties = self._complete(SENSITIVE_FIELDS, GOOD_VALUES)
        os.environ["NEXUS_DEV_EMAIL"] = HR_ONLY
        r = self.client.get(f"/esign/requests/{rid}/download")
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("Pay & Benefits", r.text)
        _, _, events = self._req(rid)
        self.assertNotIn("viewed_final", events)
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        r = self.client.get(f"/esign/requests/{rid}/download")
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            ev = (db.query(models.HrSignEvent)
                  .filter(models.HrSignEvent.request_id == rid,
                          models.HrSignEvent.type == "viewed_final").all())
        finally:
            db.close()
        self.assertEqual(len(ev), 1)
        self.assertIn(SENDER, ev[0].detail)
        # The signer's own copy through the public link is logged the same way.
        ana_token = parties[0][1]
        r = self.client.get(f"/esign/public/{ana_token}/download")
        self.assertEqual(r.status_code, 200, r.text)
        _, _, events = self._req(rid)
        self.assertEqual(events.count("viewed_final"), 2)

    def test_a_plain_envelope_download_writes_no_viewed_final(self):
        rid = self._send(PLAIN_FIELDS).json()["id"]
        role, token, email, _ = self._parties(rid)[0]
        self._clear_gates(token, email)
        self.assertEqual(self._sign(token, {"note": "hi"}).status_code, 200)
        os.environ["NEXUS_DEV_EMAIL"] = HR_ONLY
        self.assertEqual(self.client.get(f"/esign/requests/{rid}/download").status_code, 200)
        _, _, events = self._req(rid)
        self.assertNotIn("viewed_final", events)

    # ── audit ──────────────────────────────────────────────────────────────

    def test_a_sign_party_field_values_json_is_redacted_in_audit_rows(self):
        import audit_capture
        # The whole JSON, not a word match: the SSN sits under the field's
        # own id ("ssn", "acct", "secret"...) inside one column.
        self.assertEqual(audit_capture._redact_reason("hr_sign_parties", "field_values"),
                         "sensitive")
        self.assertEqual(audit_capture._redact_reason("hr_sign_parties", "FIELD_VALUES"),
                         "sensitive")
        self.assertEqual(audit_capture._redact_reason("hr_sign_parties", "status"), "")
        self.assertEqual(audit_capture._redact_reason("task_tickets", "field_values"), "")


if __name__ == "__main__":
    unittest.main()
