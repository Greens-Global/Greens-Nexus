"""Consent and document class - acceptance criteria 10 and 11.

 10  the consent screen is standalone when governing_law = 'CA'
 11  an envelope in an ESIGN-excluded document class cannot be sent

Plus the consent EVIDENCE the build note asks for and a version string alone
cannot give: the digest of the exact disclosure text shown, and the format the
signer demonstrated they could open (15 U.S.C. 7001(c)(1)(C)(ii)).

    python -m unittest test_esign_consent
"""
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

SENDER = "sender.consent@greensglobal.com"
GROUP = "grp-consent-test"
TPL = "tpl-consent-test"


class DocumentClassBlockTests(unittest.TestCase):
    """Criterion 11."""

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Consent Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=SENDER))
            db.add(models.HrSignTemplate(
                id=TPL, name="Mutual NDA", kind="nda", status="active",
                body=["Body.", "[[sign:party_a]]"],
                roles=[{"key": "party_a", "label": "Party A"}], attachments=[],
                created_by=SENDER, created_at="2026-09-01T00:00:00+00:00"))
            db.commit()
            esign._ensure_document_classes(db)
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
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
                db.query(models.HrSignConsent).filter(
                    models.HrSignConsent.request_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.HrSignParty).filter(
                    models.HrSignParty.request_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.HrSignRequest).filter(
                    models.HrSignRequest.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.HrSignTemplate).filter(models.HrSignTemplate.id == TPL).delete()
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.commit()
        finally:
            db.close()

    def _body(self, **kw):
        d = {"template_id": TPL, "title": "NDA", "routing": "sequential", "excluded_ack": True,
             "document_class": "nda", "governing_law": "CA",
             "parties": [{"role_key": "party_a", "name": "Ada", "email": "ada@greensglobal.com",
                          "kind": "internal", "ordinal": 1}]}
        d.update(kw)
        return d

    def test_an_excluded_class_is_refused_with_the_citation(self):
        # Not every exclusion is ESIGN 7003 - the notary case is Cal. Civ. Code
        # 1633.11 / Gov. Code 16.5 - so assert that SOME statute is named and
        # an alternative is offered, not one particular section.
        for code in ("will", "eviction_notice", "residential_default", "hazmat", "notarial"):
            r = self.client.post("/esign/requests", json=self._body(document_class=code))
            self.assertEqual(r.status_code, 422, f"{code} was allowed through")
            detail = r.json()["detail"]
            self.assertTrue("U.S.C." in detail or "Civ. Code" in detail or "Gov. Code" in detail,
                            f"{code}: no statute cited in the refusal - {detail!r}")
            self.assertIn("cannot be signed electronically", detail)

    def test_a_permitted_class_goes_through(self):
        r = self.client.post("/esign/requests", json=self._body(document_class="subcontract"))
        self.assertEqual(r.status_code, 200, r.text)

    def test_an_unknown_class_is_rejected_rather_than_ignored(self):
        r = self.client.post("/esign/requests", json=self._body(document_class="not_a_class"))
        self.assertEqual(r.status_code, 400)

    def test_nothing_is_created_when_the_class_is_blocked(self):
        self.client.post("/esign/requests", json=self._body(document_class="will"))
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.HrSignRequest)
                             .filter(models.HrSignRequest.created_by == SENDER).count(), 0)
        finally:
            db.close()

    def test_the_class_list_marks_which_ones_the_law_forbids(self):
        rows = self.client.get("/esign/document-classes").json()
        blocked = {c["code"]: c for c in rows if not c["electronicPermitted"]}
        self.assertIn("will", blocked)
        self.assertIn("eviction_notice", blocked)
        self.assertIn("residential_default", blocked)   # Greens Residential
        for c in blocked.values():
            self.assertTrue(c["citation"], f"{c['code']} is blocked with no citation")
            self.assertTrue(c["note"], f"{c['code']} is blocked with no alternative offered")

    def test_the_governing_law_is_stored_on_the_envelope(self):
        r = self.client.post("/esign/requests", json=self._body(governing_law="TX"))
        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == r.json()["id"]).first()
            self.assertEqual(req.governing_law, "TX")
            self.assertEqual(req.document_class, "nda")
        finally:
            db.close()


class StandaloneConsentTests(unittest.TestCase):
    """Criterion 10 - the signing payload tells the UI to gate on CA."""

    def setUp(self):
        self.db = database.SessionLocal()

    def tearDown(self):
        self.db.close()

    def _payload(self, law):
        req = models.HrSignRequest(id=f"env-{uuid.uuid4()}", title="T", source="template",
                                   status="pending", routing="sequential", body_snapshot=[],
                                   created_by=SENDER, created_at="2026-09-01T00:00:00+00:00",
                                   governing_law=law, current_order=1)
        party = models.HrSignParty(id=str(uuid.uuid4()), request_id=req.id, role_key="a",
                                   name="Ada", email="ada@greensglobal.com", kind="external",
                                   ordinal=1, status="notified", party_role="signer")
        return esign._render_payload(self.db, req, party)

    def test_california_requires_a_standalone_consent_screen(self):
        self.assertTrue(self._payload("CA")["standaloneConsent"])

    def test_other_states_keep_the_inline_consent(self):
        self.assertFalse(self._payload("TX")["standaloneConsent"])

    def test_the_payload_carries_the_disclosure_and_its_digest(self):
        p = self._payload("CA")
        self.assertEqual(p["disclosureDigest"], esign._disclosure_digest())
        self.assertEqual(len(p["disclosures"]), len(esign._ESIGN_DISCLOSURES))

    def test_the_digest_covers_the_actual_text_not_just_the_version(self):
        """Change any wording and the digest must move - that is the whole
        point of digesting the disclosure rather than labelling it."""
        before = esign._disclosure_digest()
        original = esign._ESIGN_DISCLOSURES[0]
        try:
            esign._ESIGN_DISCLOSURES[0] = (original[0], original[1] + " Extra sentence.")
            self.assertNotEqual(esign._disclosure_digest(), before)
        finally:
            esign._ESIGN_DISCLOSURES[0] = original
        self.assertEqual(esign._disclosure_digest(), before)


class ConsentRecordTests(unittest.TestCase):
    """The consent evidence written when a signer actually signs."""

    def test_a_consent_row_records_digest_format_and_standing_basis(self):
        db = database.SessionLocal()
        try:
            rec = models.HrSignConsent(
                id=str(uuid.uuid4()), party_id="p1", request_id="r1",
                disclosure_version=esign._CONSENT_VERSION,
                disclosure_digest=esign._disclosure_digest(), scope="transaction",
                format_demonstrated="pdf_rendered_in_session", accepted_at="2026-09-01T00:00:00+00:00",
                accepted_ip="198.51.100.1", session_id="sess-1",
                standing_basis="Employment agreement")
            db.add(rec)
            db.commit()
            got = db.query(models.HrSignConsent).filter(models.HrSignConsent.id == rec.id).first()
            self.assertEqual(got.disclosure_digest, esign._disclosure_digest())
            self.assertEqual(got.format_demonstrated, "pdf_rendered_in_session")
            self.assertEqual(got.scope, "transaction")
            self.assertEqual(got.withdrawn_at, "")
            db.delete(got)
            db.commit()
        finally:
            db.close()

    def test_the_certificate_shows_the_demonstrated_format(self):
        self.assertIn("PDF rendered", esign._FORMAT_LABELS["pdf_rendered_in_session"])


if __name__ == "__main__":
    unittest.main()
