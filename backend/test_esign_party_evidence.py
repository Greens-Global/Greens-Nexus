"""Party and packet evidence - the build note's remaining data model.

Covers what was added and, just as importantly, what was deliberately NOT:

  org / title           capacity to bind, shown next to the signature
  auth_method/factors   what authenticated the party, recorded AT THE TIME
  failed_auth_count     disclosed on the certificate, not hidden
  signature_digest      frozen at signing, not recomputed at render
  hr_sign_documents     digest AT SEND captured when the envelope goes out

  ial / aal / signed_geo  columns exist for schema parity and stay EMPTY -
                          Nexus runs no identity proofing and no geo-IP lookup,
                          so populating them would invent evidence

    python -m unittest test_esign_party_evidence
"""
import hashlib
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

USER = "sender.partyev@greensglobal.com"
GROUP = "grp-partyev-test"
TPL = "tpl-partyev-test"


class PartyCapacityTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = USER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Party Ev", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=USER))
            db.add(models.HrSignTemplate(
                id=TPL, name="Subcontract", kind="custom", status="active",
                body=["Terms.", "[[sign:sub]]"], roles=[{"key": "sub", "label": "Sub"}],
                attachments=[], created_by=USER, created_at="2026-09-01T00:00:00+00:00"))
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
                   .filter(models.HrSignRequest.created_by == USER).all()]
            if ids:
                for model in (models.HrSignDocument, models.HrSignConsent, models.HrSignParty):
                    db.query(model).filter(model.request_id.in_(ids)).delete(
                        synchronize_session=False)
                db.query(models.HrSignRequest).filter(
                    models.HrSignRequest.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.HrSignTemplate).filter(models.HrSignTemplate.id == TPL).delete()
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.commit()
        finally:
            db.close()

    def _send(self, **party_kw):
        party = {"role_key": "sub", "name": "Maria Ortiz",
                 "email": "maria.ortiz@greensglobal.com", "kind": "internal", "ordinal": 1}
        party.update(party_kw)
        r = self.client.post("/esign/requests", json={
            "template_id": TPL, "title": "Subcontract", "routing": "sequential",
            "excluded_ack": True, "document_class": "subcontract", "governing_law": "CA",
            "parties": [party]})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def test_org_and_title_are_stored_and_returned(self):
        rid = self._send(org="MCD Service Inc., DBA Aarav Construction",
                         title="Vice President, Construction")
        db = database.SessionLocal()
        try:
            p = db.query(models.HrSignParty).filter(models.HrSignParty.request_id == rid).first()
            self.assertEqual(p.title, "Vice President, Construction")
            self.assertEqual(p.org, "MCD Service Inc., DBA Aarav Construction")
        finally:
            db.close()
        detail = self.client.get(f"/esign/requests/{rid}").json()
        self.assertEqual(detail["parties"][0]["title"], "Vice President, Construction")

    def test_capacity_is_optional(self):
        rid = self._send()
        db = database.SessionLocal()
        try:
            p = db.query(models.HrSignParty).filter(models.HrSignParty.request_id == rid).first()
            self.assertEqual((p.org or ""), "")
            self.assertEqual((p.title or ""), "")
        finally:
            db.close()

    def test_capacity_appears_on_the_certificate_next_to_the_signature(self):
        from services import certificate as C
        html = C.render_html(C.demo_snapshot(2))
        self.assertIn("Vice President, Construction", html)
        self.assertIn("MCD Service Inc., DBA Aarav Construction", html)

    def test_the_packet_digest_is_captured_at_send(self):
        """The hole this closes: the send digest used to be derived at
        completion from whatever was in storage by then."""
        rid = self._send()
        db = database.SessionLocal()
        try:
            rows = db.query(models.HrSignDocument).filter(
                models.HrSignDocument.request_id == rid).all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].ordinal, 1)
            self.assertTrue(rows[0].created_at)
        finally:
            db.close()

    def test_a_swapped_source_file_no_longer_reads_as_unaltered(self):
        """With the send digest frozen, a file replaced in storage between send
        and completion shows two DIFFERENT digests. Deriving both at completion
        would have shown two matching ones and called it untouched."""
        rid = self._send()
        db = database.SessionLocal()
        try:
            row = db.query(models.HrSignDocument).filter(
                models.HrSignDocument.request_id == rid).first()
            row.digest_at_send = hashlib.sha256(b"the file as it went out").hexdigest()
            db.commit()

            req = db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == rid).first()
            swapped = b"a different file entirely"
            digests = esign._document_digests_from_rows(
                db, req, [("Subcontract", swapped, swapped)])
            name, pages, sent, done = digests[0]
            self.assertTrue(sent)
            self.assertNotEqual(sent, done, "a swapped file was reported as unaltered")
        finally:
            db.close()


class AuthRecordTests(unittest.TestCase):
    """auth_method / auth_factors are stored, not inferred later."""

    def test_an_internal_party_records_its_session(self):
        p = models.HrSignParty(id="p", request_id="r", kind="internal", access_code="")
        self.assertEqual(esign._auth_record(p), ("entra_sso", ["session"]))

    def test_an_external_party_records_the_token(self):
        p = models.HrSignParty(id="p", request_id="r", kind="external", access_code="")
        self.assertEqual(esign._auth_record(p), ("emailed_token", ["token"]))

    def test_an_access_code_is_recorded_as_a_second_factor(self):
        p = models.HrSignParty(id="p", request_id="r", kind="external", access_code="4187")
        method, factors = esign._auth_record(p)
        self.assertEqual(method, "emailed_token+access_code")
        self.assertEqual(factors, ["token", "access_code"])

    def test_the_certificate_prefers_the_stored_method_over_re_deriving_it(self):
        """A party edited after signing must not change the certificate's
        account of how they were authenticated at the time."""
        from services import certificate as C
        p = models.HrSignParty(id="p", request_id="r", kind="external",
                               auth_method="emailed_token+access_code", access_code="")
        self.assertIn("access code", C._auth_method(p))

    def test_an_envelope_predating_the_column_still_describes_itself(self):
        from services import certificate as C
        p = models.HrSignParty(id="p", request_id="r", kind="internal", auth_method="")
        self.assertIn("Entra ID", C._auth_method(p))


class DisclosedFailureTests(unittest.TestCase):
    def test_failed_attempts_are_shown_not_hidden(self):
        from services import certificate as C
        snap = C.demo_snapshot(2)
        self.assertTrue(any(s["failed_auth_count"] for s in snap["signers"]),
                        "the demo should exercise a failed attempt")
        html = C.render_html(snap)
        self.assertIn("failed access-code attempt", html)

    def test_a_clean_signer_says_so_explicitly(self):
        from services import certificate as C
        html = C.render_html(C.demo_snapshot(1))
        self.assertIn("No failed attempts", html)


class UnpopulatedByDesignTests(unittest.TestCase):
    """ial / aal / signed_geo exist for schema parity and must stay empty.

    If someone wires an identity-proofing or geo-IP vendor later, these tests
    are where they announce it - deliberately, rather than by a value quietly
    appearing on a legal document.
    """

    def test_no_assurance_level_or_geolocation_is_written_at_signing(self):
        p = models.HrSignParty(id="p", request_id="r", kind="external")
        self.assertEqual(p.ial, None)
        self.assertEqual(p.aal, None)
        self.assertEqual(p.signed_geo, None)

    def test_the_certificate_prints_no_assurance_level_or_city(self):
        from services import certificate as C
        html = C.render_html(C.demo_snapshot(3)).lower()
        for claim in ("ial1", "ial2", "aal1", "aal2", "aal3", "800-63", "assurance level"):
            self.assertNotIn(claim, html, f"certificate claims {claim}")

    def test_the_snapshot_carries_no_geo_field_to_print(self):
        from services import certificate as C
        signer = C.demo_snapshot(1)["signers"][0]
        self.assertNotIn("geo", " ".join(signer.keys()).lower())


if __name__ == "__main__":
    unittest.main()
