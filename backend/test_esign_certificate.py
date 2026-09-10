"""Certificate of Completion - content and, above all, honesty.

The certificate is the document that gets handed to a court, an auditor or a
counterparty. Two failure modes matter:

1. Missing evidence - no consent record, no attribution, no digests, no
   retention statement. These tests pin the sections that carry them.
2. CLAIMED evidence that does not exist. Nexus hashes and hash-chains; it does
   NOT apply a PAdES/CAdES seal, hold keys in an HSM, use an AATL certificate
   or obtain RFC 3161 timestamps. Printing any of those would be a false
   statement inside a document offered as evidence, so there is a test whose
   whole job is to fail if such wording ever appears.

    python -m unittest test_esign_certificate
"""
import hashlib
import io
import os
import re
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import models
from routers import esign


def _party(**kw):
    d = dict(id=str(uuid.uuid4()), request_id="req-cert", role_key="sub", name="Maria Ortiz",
             email="maria.ortiz@greensglobal.com", kind="internal", ordinal=1, status="signed",
             signature_kind="drawn", signature_data="data:image/png;base64,AAAA",
             consent_at="2026-08-24T09:22:41+00:00", consent_text_version=esign._CONSENT_VERSION,
             ip="198.51.100.47",
             user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36",
             viewed_at="2026-08-24T09:22:10+00:00", signed_at="2026-08-24T09:31:18+00:00",
             party_role="signer", access_code="", decline_reason="")
    d.update(kw)
    return models.HrSignParty(**d)


def _request(**kw):
    d = dict(id="req-cert", title="Subcontract Agreement", source="pdf", status="completed",
             routing="sequential", created_by="maria.ortiz@greensglobal.com",
             created_at="2026-08-24T09:21:03+00:00", completed_at="2026-08-27T16:41:52+00:00",
             expires_on="", verify_token="tok-cert", entity_id="",
             fields=[{"id": "SIG_SUB_REP", "role": "sub", "type": "sign", "page": 16}],
             documents=[], pdf_storage_path="esign/x/sub.pdf")
    d.update(kw)
    return models.HrSignRequest(**d)


def _consent_row(party_id):
    return models.HrSignConsent(
        id="c-" + party_id, party_id=party_id, request_id="req-cert",
        disclosure_version=esign._CONSENT_VERSION, disclosure_digest=esign._disclosure_digest(),
        scope="transaction", format_demonstrated="pdf_rendered_in_session",
        accepted_at="2026-08-24T09:22:41+00:00", accepted_ip="198.51.100.47",
        session_id="s1", standing_basis="", withdrawn_at="", withdrawal_method="")


def _events(req_id="req-cert"):
    out, prev = [], req_id
    for i, (t, detail) in enumerate([("created", "envelope created"), ("sent", "notified"),
                                     ("viewed", "opened"), ("consented", "consented"),
                                     ("signed", "signed (drawn)")], 1):
        at = f"2026-08-24T{9 + i:02d}:00:00+00:00"
        hh = esign._event_hash(prev, req_id, t, detail, "198.51.100.47", "ua", at, i,
                               party_id="", version=esign._HASH_VERSION)
        out.append(models.HrSignEvent(id=str(uuid.uuid4()), request_id=req_id, type=t,
                                      detail=detail, ip="198.51.100.47", user_agent="ua",
                                      at=at, seq=i, event_hash=hh,
                                      hash_version=esign._HASH_VERSION))
        prev = hh
    return out


def _text(pdf_bytes: bytes) -> str:
    """Extracted text with runs of whitespace flattened - a table cell wraps
    mid-heading in the PDF, and no assertion here is about line breaks."""
    from pypdf import PdfReader
    raw = "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf_bytes)).pages)
    return re.sub(r"\s+", " ", raw)


class CertificateTests(unittest.TestCase):
    def test_the_event_fixture_is_itself_a_verifying_chain(self):
        """Guard against a silently broken fixture: several assertions below
        would still pass against a chain that does not verify."""
        self.assertTrue(esign._verify_chain(_events())["valid"])

    def setUp(self):
        body = b"%PDF-1.4 content " * 50
        self.digests = [("Subcontract Agreement.pdf", 18,
                         hashlib.sha256(body).hexdigest(), hashlib.sha256(body + b"s").hexdigest()),
                        ("Exhibit A.pdf", 4, hashlib.sha256(b"a").hexdigest(),
                         hashlib.sha256(b"a").hexdigest())]
        self.content_sha = hashlib.sha256(body).hexdigest()

    def _snapshot(self, req=None, parties=None, events=None, consents=None, entity_name=""):
        """The certificate is rendered from a snapshot now - one frozen dict
        that both the HTML certificate of record and the sealed PDF read, so
        the two can never state different facts."""
        req = req or _request()
        events = _events() if events is None else events
        return esign.build_certificate_snapshot(
            req=req, parties=parties or [_party()], events=events, consents=consents or {},
            doc_digests=self.digests, content_sha=self.content_sha, entity_name=entity_name,
            generated_at="2026-08-27T16:41:57+00:00",
            system={"name": esign._SOR_NAME, "operator": esign._SOR_OPERATOR,
                    "support": esign._SUPPORT_CONTACT,
                    "verify_url": f"http://localhost:5173/verify/{req.verify_token}",
                    "retention": esign._RETENTION_POLICY},
            chain=esign._verify_chain(events))

    def _build(self, req=None, parties=None, events=None, **kw):
        return _text(esign._certificate_pdf(self._snapshot(req, parties, events, **kw)))

    def _html(self, req=None, parties=None, events=None, **kw):
        return esign.render_certificate_html(self._snapshot(req, parties, events, **kw))

    # ── it must not claim controls that do not exist ────────────────────────
    def test_claims_no_seal_timestamp_or_key_custody_it_does_not_have(self):
        text = self._build().lower()
        for phrase in ("pades", "cades", "b-lta", "trusted timestamp", "fips 140",
                       "hardware security module", "adobe approved trust list", "aatl",
                       "worm", "seal intact", "seal profile", "key custody", "digicert",
                       "ial2", "aal2", "800-63"):
            self.assertNotIn(phrase, text, f"certificate asserts {phrase!r}, which Nexus does not do")
        # RFC 3161 may appear ONLY in the sentence that disclaims it.
        for sentence in text.split("."):
            if "rfc 3161" in sentence:
                self.assertIn("not a third-party", sentence,
                              "RFC 3161 is mentioned as something other than a disclaimer")

    def test_states_plainly_what_the_integrity_evidence_actually_is(self):
        text = self._build()
        self.assertIn("Not a third-party RFC 3161 timestamp", text)
        self.assertIn("carries no embedded PKI signature", text)

    # ── the evidence it must carry ─────────────────────────────────────────
    def test_carries_the_consent_record_for_each_signer(self):
        """The one-page certificate cites the disclosure VERSION and DIGEST per
        signer rather than reprinting the text (build note section 7 + criterion
        6). The digest is what makes the citation evidence: the exact bytes
        shown are pinned, and the text itself stays retrievable by version."""
        consents = {"p-consent": _consent_row("p-consent")}
        parties = [_party(id="p-consent")]
        text = self._build(parties=parties, consents=consents)
        self.assertIn(esign._CONSENT_VERSION, text)
        self.assertIn("7001(c)", text)
        self.assertIn(esign._disclosure_digest()[:32], text.replace(" ", ""))
        self.assertIn("PDF rendered in session", text)
        self.assertIn("No withdrawal recorded", text)

    def test_the_disclosure_text_behind_the_cited_version_is_still_retrievable(self):
        for heading, _ in esign._disclosures():
            self.assertIn(heading, esign._disclosure_text())
        for must in ("paper copy", "withdraw", "Scope of your consent", "Hardware and software"):
            self.assertIn(must, esign._disclosure_text())

    def test_carries_attribution_evidence_for_each_signer(self):
        text = self._build(parties=[
            _party(),
            _party(role_key="gc", name="Daniel Reyes", email="d.reyes@coastline.example",
                   kind="external", ordinal=2, access_code="4187", signature_kind="typed",
                   signature_data="Daniel Reyes", ip="203.0.113.211",
                   user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 19_2 like Mac OS X) Safari/604.1"),
        ])
        self.assertIn("Maria Ortiz", text)
        self.assertIn("198.51.100.47", text)
        self.assertIn("Windows", text)
        self.assertIn("Microsoft Entra ID single", text.replace("\n", " "))
        self.assertIn("Daniel Reyes", text)
        self.assertIn("access code", text)
        self.assertIn("iOS", text)                      # not "macOS" - iPhone UAs say "like Mac OS X"
        self.assertIn("SIG_SUB_REP", text.replace("\n", ""))

    def test_carries_per_document_digests_and_the_signed_content_digest(self):
        text = self._build().replace("\n", "")
        self.assertIn(self.content_sha[:32], text)
        for _, _, sent_sha, done_sha in self.digests:
            self.assertIn(sent_sha[:32], text)
            self.assertIn(done_sha[:32], text)

    def test_carries_retention_access_and_verification(self):
        text = self._build().replace("\n", " ")
        self.assertIn("7001(d)", text)
        self.assertIn("verify/tok-cert", text)
        self.assertIn("Retention", text)

    def test_carries_a_custodian_certification_left_blank_for_a_person(self):
        text = self._build()
        self.assertIn("Certification of records custodian", text)
        self.assertIn("902(11)", text)
        self.assertIn("penalty of perjury", text)
        self.assertIn("Name and title of custodian", text)
        # It must not pre-fill a signer: a system cannot swear about itself.
        self.assertNotIn("Custodian of Records, Nexus Platform", text)

    # ── it must report the truth about the audit chain ─────────────────────
    def test_does_not_assert_a_withdrawal_status_nothing_tracks(self):
        """Nexus records no consent withdrawal anywhere, so the certificate may
        report the absence of a record - never assert the fact."""
        text = self._build()
        self.assertNotIn("Not withdrawn", text)
        self.assertIn("No withdrawal recorded", text)

    def test_reports_a_broken_hash_chain_instead_of_hiding_it(self):
        events = _events()
        events[2].detail = "tampered after the fact"     # breaks the chain from here on
        text = self._build(events=events)
        self.assertIn("BROKEN", text)
        self.assertIn("REPLAY FAILED", text.replace("\n", " "))

    def test_reports_an_unavailable_chain_for_pre_upgrade_envelopes(self):
        legacy = [models.HrSignEvent(id="e1", request_id="req-cert", type="created", detail="x",
                                     at="2026-01-01T00:00:00+00:00", seq=0, event_hash="")]
        text = self._build(events=legacy)
        self.assertIn("Not available", text)

    def test_records_a_declined_signer_with_the_reason(self):
        text = self._build(parties=[_party(status="declined", signature_kind="",
                                           signature_data="", decline_reason="Terms not agreed")])
        self.assertIn("Declined", text)
        self.assertIn("Terms not agreed", text)

    def test_pages_are_numbered_and_carry_the_envelope_id(self):
        text = _text(esign._certificate_pdf(self._snapshot()))
        self.assertIn("Page 1", text)
        self.assertIn("req-cert", text)


class UserAgentTests(unittest.TestCase):
    def test_mobile_agents_are_not_reported_as_desktop(self):
        ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_2 like Mac OS X) Version/19.2 Safari/604.1"
        self.assertEqual(esign._ua_summary(ios), "iOS - Safari")
        mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15"
        self.assertEqual(esign._ua_summary(mac), "macOS - Safari")

    def test_edge_is_not_reported_as_chrome(self):
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0"
        self.assertEqual(esign._ua_summary(ua), "Windows 10/11 - Edge")

    def test_an_unknown_agent_is_never_guessed(self):
        self.assertEqual(esign._ua_summary("curl/8.4.0"), "Unrecognized user agent")
        self.assertEqual(esign._ua_summary(""), "")


class DisclosureTests(unittest.TestCase):
    def test_the_signing_payload_carries_the_disclosures_the_certificate_cites(self):
        """The certificate says these were shown before consent - so they have
        to actually reach the signing screen."""
        import database
        db = database.SessionLocal()
        try:
            payload = esign._render_payload(db, _request(source="template", body_snapshot=[]),
                                            _party())
        finally:
            db.close()
        self.assertEqual(payload["consentVersion"], esign._CONSENT_VERSION)
        self.assertEqual([d["heading"] for d in payload["disclosures"]],
                         [h for h, _ in esign._disclosures()])
        self.assertTrue(all(d["body"] for d in payload["disclosures"]))

    def test_the_support_contact_is_filled_in_not_left_as_a_placeholder(self):
        for _, body in esign._disclosures():
            self.assertNotIn("{support}", body)


if __name__ == "__main__":
    unittest.main()


class DeterminismTests(unittest.TestCase):
    """Criterion 5 and 9 - same snapshot in, byte-identical HTML out.

    The Playwright suite (frontend/src/lib/certificateLayout.test.js) measures
    real layout; this pins determinism at the Python boundary, including that
    the snapshot itself is stable and JSON-round-trippable - it is stored on the
    envelope and re-rendered from storage to prove the certificate was not
    hand-edited.
    """

    def setUp(self):
        from services import certificate
        self.C = certificate
        self.snap = certificate.demo_snapshot(3)

    def test_one_hundred_renders_are_byte_identical(self):
        first = self.C.render_html(self.snap)
        digests = {hashlib.sha256(self.C.render_html(self.snap).encode("utf-8")).hexdigest()
                   for _ in range(100)}
        self.assertEqual(len(digests), 1)
        self.assertEqual(hashlib.sha256(first.encode("utf-8")).hexdigest(), digests.pop())

    def test_a_snapshot_survives_json_and_still_renders_identically(self):
        import json
        before = self.C.render_html(self.snap)
        after = self.C.render_html(json.loads(json.dumps(self.snap)))
        self.assertEqual(before, after)

    def test_the_renderer_reads_no_clock(self):
        """generated_at comes from the snapshot. If the renderer ever calls a
        clock, changing only that field would not change the output."""
        a = self.C.render_html(self.C.demo_snapshot(2))
        snap_b = self.C.demo_snapshot(2)
        snap_b["generated_at"] = "2030-01-01T00:00:00+00:00"
        self.assertNotEqual(a, self.C.render_html(snap_b))
        self.assertIn("2030-01-01", self.C.render_html(snap_b))

    def test_every_digest_printed_is_lowercase_hex(self):
        """Criterion 8."""
        html = self.C.render_html(self.snap)
        hexes = [m.replace("<wbr>", "").strip()
                 for m in re.findall(r'class="hex">(.*?)<', html, re.S)]
        hexes = [h for h in hexes if h and h != "-"]
        self.assertGreater(len(hexes), 3)
        for h in hexes:
            self.assertRegex(h, r"^[0-9a-f]+$")

    def test_the_qr_is_inline_with_no_script_or_external_reference(self):
        html = self.C.render_html(self.snap)
        self.assertIn('shape-rendering="crispEdges"', html)
        self.assertNotIn("<script", html.lower())
        self.assertNotIn("<img", html.lower())

    def test_the_same_url_always_produces_the_same_qr(self):
        a = self.C.qr_svg("https://nexus.greensglobal.com/verify/abc123")
        b = self.C.qr_svg("https://nexus.greensglobal.com/verify/abc123")
        c = self.C.qr_svg("https://nexus.greensglobal.com/verify/abc124")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_the_html_and_the_sealed_pdf_state_the_same_facts(self):
        """One snapshot, two renderings - they must not disagree."""
        html = self.C.render_html(self.snap)
        pdf = _text(esign._certificate_pdf(self.snap))
        env = self.snap["envelope"]
        for value in (env["id"], env["name"], env["initiated_by"],
                      self.snap["integrity"]["chain_head"][:32],
                      self.snap["signers"][0]["name"]):
            self.assertIn(value, html, f"{value!r} missing from the HTML certificate")
            self.assertIn(value, pdf.replace(" ", "") if len(value) == 32 else pdf,
                          f"{value!r} missing from the sealed PDF")
