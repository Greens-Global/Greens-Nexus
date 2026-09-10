"""Excluded-record guardrail (ESIGN 15 U.S.C. 7003 / Cal. Civ. Code 1633.3).

An electronic signature has NO legal effect on a will, a divorce filing, a
court order, an eviction or foreclosure notice, a utility or insurance
cancellation, a product recall, or hazmat transport papers. Nothing about the
audit trail rescues one - the only fix is not sending it here. So the sender
has to confirm the document type, the SERVER enforces it (a wizard checkbox is
not a guardrail - the API is reachable without the wizard), and the
acknowledgment is written into the hash-chained log and onto the certificate.

    python -m unittest test_esign_excluded
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

SENDER = "sender.excluded@greensglobal.com"
GROUP = "grp-excluded-test"
TPL = "tpl-excluded-test"


class ExcludedRecordGuardrailTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = SENDER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="E-sign Excluded Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=SENDER))
            db.add(models.HrSignTemplate(
                id=TPL, name="Mutual NDA", kind="nda", status="active",
                body=["This agreement is between the parties.", "[[sign:party_a]]"],
                roles=[{"key": "party_a", "label": "Party A"}], attachments=[],
                created_by=SENDER, created_at="2026-09-01T00:00:00+00:00"))
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
                   .filter(models.HrSignRequest.created_by == SENDER).all()]
            # hr_sign_events is append-only at the database level - the audit
            # rows these sends produce stay, exactly as they would in
            # production. Only the envelope and its parties are cleaned up.
            if ids:
                db.query(models.HrSignParty).filter(
                    models.HrSignParty.request_id.in_(ids)).delete(synchronize_session=False)
            if ids:
                db.query(models.HrSignRequest).filter(
                    models.HrSignRequest.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.HrSignTemplate).filter(models.HrSignTemplate.id == TPL).delete()
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.commit()
        finally:
            db.close()

    def _body(self, **kw):
        d = {"template_id": TPL, "title": "Mutual NDA", "routing": "sequential",
             "parties": [{"role_key": "party_a", "name": "Ada Signer",
                          "email": "ada.signer@greensglobal.com", "kind": "internal", "ordinal": 1}]}
        d.update(kw)
        return d

    # ── the guardrail ───────────────────────────────────────────────────────
    def test_a_send_without_the_acknowledgment_is_refused(self):
        r = self.client.post("/esign/requests", json=self._body())
        self.assertEqual(r.status_code, 422)
        self.assertIn("excluded record type", r.json()["detail"])

    def test_an_explicit_false_is_refused_too(self):
        r = self.client.post("/esign/requests", json=self._body(excluded_ack=False))
        self.assertEqual(r.status_code, 422)

    def test_nothing_is_created_when_the_send_is_refused(self):
        """The refusal must happen before any row is written - a half-created
        envelope with no parties would be worse than the send it blocked."""
        self.client.post("/esign/requests", json=self._body())
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.HrSignRequest)
                             .filter(models.HrSignRequest.created_by == SENDER).count(), 0)
        finally:
            db.close()

    def test_an_acknowledged_send_records_who_confirmed_and_when(self):
        r = self.client.post("/esign/requests", json=self._body(excluded_ack=True))
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            req = db.query(models.HrSignRequest).filter(
                models.HrSignRequest.id == r.json()["id"]).first()
            self.assertEqual(req.excluded_ack_by, SENDER)
            self.assertTrue(req.excluded_ack_at)
        finally:
            db.close()

    def test_the_acknowledgment_lands_in_the_hash_chained_audit_log(self):
        r = self.client.post("/esign/requests", json=self._body(excluded_ack=True))
        db = database.SessionLocal()
        try:
            events = (db.query(models.HrSignEvent)
                      .filter(models.HrSignEvent.request_id == r.json()["id"])
                      .order_by(models.HrSignEvent.seq).all())
            acks = [e for e in events if e.type == "acknowledged"]
            self.assertEqual(len(acks), 1)
            self.assertIn("7003", acks[0].detail)
            self.assertIn(SENDER, acks[0].detail)
            # and the chain still replays with the extra event in it
            self.assertTrue(esign._verify_chain(events)["valid"])
        finally:
            db.close()

    # ── the list the wizard renders ─────────────────────────────────────────
    def test_the_category_list_is_served_so_the_ui_cannot_drift(self):
        r = self.client.get("/esign/excluded-categories")
        self.assertEqual(r.status_code, 200)
        rows = r.json()
        self.assertEqual(len(rows), len(esign._EXCLUDED_RECORD_CATEGORIES))
        blob = " ".join(f"{x['label']} {x['citation']}" for x in rows).lower()
        for must in ("will", "divorce", "court order", "eviction", "utility",
                     "recall", "hazardous", "notary"):
            self.assertIn(must, blob)
        self.assertTrue(all(x["citation"] for x in rows))


if __name__ == "__main__":
    unittest.main()
