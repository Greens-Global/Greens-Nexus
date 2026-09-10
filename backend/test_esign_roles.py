"""Recipient roles - build note section 3.

Six roles, and the test that matters for each is that it behaves DIFFERENTLY
from `signer`. A role that routed and completed exactly like a signer would be
a label pretending to be a control, which is why they were not added earlier.

  signer / countersigner / witness   sign
  approver                           approves, never signs, and HOLDS the
                                     envelope until they do
  certified_delivery                 acknowledges receipt, never signs, and
                                     also holds the envelope
  cc                                 never acts, never blocks

    python -m unittest test_esign_roles
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

USER = "sender.roles@greensglobal.com"
GROUP = "grp-roles-test"


class RoleEngineTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = USER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Roles", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=USER))
            db.commit()
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
                for m in (models.HrSignConsent, models.HrSignParty, models.HrSignDocument):
                    db.query(m).filter(m.request_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.HrSignRequest).filter(
                    models.HrSignRequest.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.commit()
        finally:
            db.close()

    def _envelope(self, roles, routing="sequential"):
        """An envelope with one party per role, in the order given."""
        db = database.SessionLocal()
        try:
            rid = f"env-roles-{uuid.uuid4()}"
            db.add(models.HrSignRequest(
                id=rid, title="Role Test", source="template", status="pending",
                routing=routing, body_snapshot=["Body.", "[[sign:a]]"], current_order=1,
                created_by=USER, created_at="2026-09-01T00:00:00+00:00"))
            parties = []
            for i, role in enumerate(roles, 1):
                p = models.HrSignParty(
                    id=str(uuid.uuid4()), request_id=rid, role_key="a",
                    name=f"{role.title()} {i}", email=f"{role}{i}@partner.example",
                    kind="external", ordinal=i, status="notified", party_role=role,
                    token=f"tok{uuid.uuid4().hex}")
                db.add(p)
                parties.append(p)
            db.commit()
            return rid, [(p.id, p.token, p.party_role) for p in parties]
        finally:
            db.close()

    def _party(self, pid):
        db = database.SessionLocal()
        try:
            return db.query(models.HrSignParty).filter(models.HrSignParty.id == pid).first()
        finally:
            db.close()

    # ── an approver is not a signer ─────────────────────────────────────────
    def test_an_approver_cannot_use_the_signing_endpoint(self):
        _, parties = self._envelope(["approver", "signer"])
        _, token, _ = parties[0]
        r = self.client.post(f"/esign/public/{token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": "Approver 1"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("does not sign", r.json()["detail"])

    def test_a_signer_cannot_use_the_approval_endpoint(self):
        _, parties = self._envelope(["signer", "approver"])
        _, token, _ = parties[0]
        r = self.client.post(f"/esign/public/{token}/act", json={"consent": True})
        self.assertEqual(r.status_code, 400)
        self.assertIn("signing endpoint", r.json()["detail"])

    def test_approving_records_approved_not_signed(self):
        _, parties = self._envelope(["approver", "signer"])
        pid, token, _ = parties[0]
        r = self.client.post(f"/esign/public/{token}/act",
                             json={"consent": True, "note": "Budget confirmed"})
        self.assertEqual(r.status_code, 200, r.text)
        p = self._party(pid)
        self.assertEqual(p.status, "approved")
        self.assertEqual(p.signature_kind or "", "", "an approver must have no signature")
        self.assertEqual(p.signature_data or "", "")
        self.assertTrue(p.consent_at, "an approver still consents to transact electronically")

    def test_an_outstanding_approver_holds_the_envelope(self):
        """The whole point of the role: signatures alone must not complete it."""
        rid, parties = self._envelope(["signer", "approver"])
        _, signer_token, _ = parties[0]
        r = self.client.post(f"/esign/public/{signer_token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": "Signer 1"})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == rid).first()
            self.assertEqual(req.status, "pending",
                             "the envelope completed while an approver was outstanding")
            self.assertEqual(req.current_order, 2, "the turn did not pass to the approver")
        finally:
            db.close()

    # ── certified delivery ──────────────────────────────────────────────────
    def test_certified_delivery_acknowledges_and_never_signs(self):
        _, parties = self._envelope(["certified_delivery", "signer"])
        pid, token, _ = parties[0]
        r = self.client.post(f"/esign/public/{token}/act", json={"consent": True})
        self.assertEqual(r.status_code, 200, r.text)
        p = self._party(pid)
        self.assertEqual(p.status, "acknowledged")
        self.assertTrue(p.acknowledged_at)
        self.assertEqual(p.signature_data or "", "")

    def test_an_outstanding_delivery_acknowledgment_holds_the_envelope(self):
        rid, parties = self._envelope(["signer", "certified_delivery"])
        _, token, _ = parties[0]
        self.client.post(f"/esign/public/{token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": "Signer 1"})
        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == rid).first()
            self.assertEqual(req.status, "pending")
        finally:
            db.close()

    # ── signing roles ───────────────────────────────────────────────────────
    def test_countersigner_and_witness_sign_like_signers(self):
        for role in ("countersigner", "witness"):
            _, parties = self._envelope([role, "signer"])
            pid, token, _ = parties[0]
            r = self.client.post(f"/esign/public/{token}/sign", json={
                "consent": True, "signature_kind": "typed", "signature_data": "Name"})
            self.assertEqual(r.status_code, 200, f"{role}: {r.text}")
            self.assertEqual(self._party(pid).status, "signed")

    def test_an_envelope_needs_at_least_one_signing_party(self):
        """Approvers and acknowledgments alone do not execute a document."""
        from routers.esign import _validate_parties, PartyIn
        only_approver = [PartyIn(role_key="a", name="A", email="a@x.example",
                                 kind="external", ordinal=1, party_role="approver")]
        with self.assertRaises(Exception) as ctx:
            _validate_parties(only_approver, set())
        self.assertIn("signing party", str(ctx.exception))

    def test_an_unknown_role_is_rejected(self):
        """With a valid signer present, so it is the ROLE check that fires and
        not the earlier "at least one signing party" guard."""
        from routers.esign import _validate_parties, PartyIn
        bad = [PartyIn(role_key="a", name="S", email="s@x.example", kind="external",
                       ordinal=1, party_role="signer"),
               PartyIn(role_key="a", name="N", email="n@x.example", kind="external",
                       ordinal=2, party_role="notary")]
        with self.assertRaises(Exception) as ctx:
            _validate_parties(bad, set())
        self.assertIn("party_role must be one of", str(ctx.exception))

    # ── cc is unchanged ─────────────────────────────────────────────────────
    def test_a_cc_never_holds_the_envelope(self):
        rid, parties = self._envelope(["signer", "cc"])
        _, token, _ = parties[0]
        r = self.client.post(f"/esign/public/{token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": "Signer 1"})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(models.HrSignRequest.id == rid).first()
            # Only signer + cc: with the signature in, nothing is outstanding.
            self.assertNotEqual(req.status, "pending",
                                "a CC recipient blocked completion")
        finally:
            db.close()

    def test_a_cc_cannot_act_at_all(self):
        _, parties = self._envelope(["signer", "cc"])
        _, cc_token, _ = parties[1]
        self.assertEqual(
            self.client.post(f"/esign/public/{cc_token}/act", json={"consent": True}).status_code,
            400)


class RoleHelperTests(unittest.TestCase):
    """The role predicates the engine routes on."""

    def _p(self, role, status="notified"):
        return models.HrSignParty(id="p", request_id="r", party_role=role, status=status)

    def test_only_signing_roles_sign(self):
        for role in ("signer", "countersigner", "witness"):
            self.assertTrue(esign._signs(self._p(role)), role)
        for role in ("approver", "certified_delivery", "cc"):
            self.assertFalse(esign._signs(self._p(role)), role)

    def test_done_means_what_the_role_actually_did(self):
        self.assertTrue(esign._is_done(self._p("signer", "signed")))
        self.assertFalse(esign._is_done(self._p("signer", "approved")))
        self.assertTrue(esign._is_done(self._p("approver", "approved")))
        self.assertFalse(esign._is_done(self._p("approver", "signed")),
                         "an approver must never be completed by a signature")
        self.assertTrue(esign._is_done(self._p("certified_delivery", "acknowledged")))
        self.assertTrue(esign._is_done(self._p("cc", "waiting")), "a CC is never outstanding")

    def test_notary_is_not_an_available_role(self):
        """Notarial documents are blocked by the excluded-record class instead -
        Nexus performs no notarial act."""
        self.assertNotIn("notary", esign._PARTY_ROLES)


class RoleCertificateTests(unittest.TestCase):
    """Section 2 must say what each party did, not assume everyone signed."""

    def test_an_approver_is_not_described_as_having_signed(self):
        from services import certificate as C
        snap = C.demo_snapshot(2)
        snap["signers"][1].update({"role": "approver", "role_label": "Approver",
                                   "signs": False, "status": "approved",
                                   "signature_kind": "", "signature_digest": ""})
        html = C.render_html(snap)
        self.assertIn("Approver", html)
        self.assertIn("Approved - no signature", html)

    def test_a_certified_delivery_recipient_shows_a_receipt(self):
        from services import certificate as C
        snap = C.demo_snapshot(2)
        snap["signers"][1].update({"role": "certified_delivery",
                                   "role_label": "Certified delivery", "signs": False,
                                   "status": "acknowledged", "signature_kind": "",
                                   "signature_digest": ""})
        html = C.render_html(snap)
        self.assertIn("Certified delivery", html)
        self.assertIn("Receipt acknowledged - no signature", html)

    def test_the_signature_count_excludes_non_signing_roles(self):
        from services import certificate as C
        snap = C.demo_snapshot(3)
        snap["signers"][2].update({"role": "approver", "signs": False, "status": "approved"})
        # two signers of two, with an approver alongside - not "2 of 3".
        self.assertIn("2 of 2", C.render_html(snap))


if __name__ == "__main__":
    unittest.main()
