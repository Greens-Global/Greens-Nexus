"""Legal holds, statutory-form locks and authentication order.

Acceptance criteria 9, 12 and 13 of the build note:

  9  a signer cannot reach the document before authenticated_at is set
 12  statutory-form templates reject body-text edits
 13  a legal hold blocks purge; purge runs once the hold is released

    python -m unittest test_esign_retention
"""
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import esign

USER = "holder.retention@greensglobal.com"
GROUP = "grp-retention-test"


def _iso(days_ago):
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


class RetentionHoldTests(unittest.TestCase):
    """Criterion 13."""

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = USER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Retention Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=USER))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.old = self._envelope(completed_days_ago=400)
        self.recent = self._envelope(completed_days_ago=10)

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
                db.query(models.HrSignRetentionHold).filter(
                    models.HrSignRetentionHold.request_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.HrSignParty).filter(
                    models.HrSignParty.request_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.HrSignRequest).filter(
                    models.HrSignRequest.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.commit()
        finally:
            db.close()

    def _envelope(self, completed_days_ago):
        db = database.SessionLocal()
        try:
            rid = f"env-ret-{uuid.uuid4()}"
            db.add(models.HrSignRequest(
                id=rid, title="Completed Agreement", source="pdf", status="completed",
                routing="sequential", created_by=USER, created_at=_iso(completed_days_ago + 5),
                completed_at=_iso(completed_days_ago), final_pdf_path=f"esign/{rid}/final.pdf"))
            db.commit()
            return rid
        finally:
            db.close()

    def test_a_hold_blocks_the_purge_and_releasing_it_lets_the_purge_run(self):
        r = self.client.post(f"/esign/requests/{self.old}/holds",
                             json={"reason": "Dispute with subcontractor"})
        self.assertEqual(r.status_code, 200, r.text)
        hold_id = r.json()["id"]

        db = database.SessionLocal()
        try:
            held = esign.purge_expired_envelopes(db, retain_days=365, dry_run=True)
            self.assertIn(self.old, held["held"])
            self.assertNotIn(self.old, held["eligible"])

            # A real purge must also refuse it, not just the dry run.
            done = esign.purge_expired_envelopes(db, retain_days=365, dry_run=False)
            self.assertNotIn(self.old, done["purged"])
            self.assertIsNotNone(db.query(models.HrSignRequest)
                                 .filter(models.HrSignRequest.id == self.old).first())
        finally:
            db.close()

        rel = self.client.post(f"/esign/requests/{self.old}/holds/{hold_id}/release")
        self.assertEqual(rel.status_code, 200, rel.text)

        db = database.SessionLocal()
        try:
            done = esign.purge_expired_envelopes(db, retain_days=365, dry_run=False)
            self.assertIn(self.old, done["purged"])
            self.assertIsNone(db.query(models.HrSignRequest)
                              .filter(models.HrSignRequest.id == self.old).first())
        finally:
            db.close()

    def test_purge_leaves_records_inside_the_retention_window_alone(self):
        db = database.SessionLocal()
        try:
            out = esign.purge_expired_envelopes(db, retain_days=365, dry_run=True)
            self.assertNotIn(self.recent, out["eligible"])
            self.assertNotIn(self.recent, out["held"])
        finally:
            db.close()

    def test_purge_is_a_dry_run_unless_the_caller_says_otherwise(self):
        db = database.SessionLocal()
        try:
            out = esign.purge_expired_envelopes(db, retain_days=365)
            self.assertTrue(out["dryRun"])
            self.assertEqual(out["purged"], [])
            self.assertIsNotNone(db.query(models.HrSignRequest)
                                 .filter(models.HrSignRequest.id == self.old).first())
        finally:
            db.close()

    def test_a_hold_and_its_release_are_both_on_the_audit_chain(self):
        r = self.client.post(f"/esign/requests/{self.recent}/holds", json={"reason": "Audit"})
        self.client.post(f"/esign/requests/{self.recent}/holds/{r.json()['id']}/release")
        db = database.SessionLocal()
        try:
            events = (db.query(models.HrSignEvent)
                      .filter(models.HrSignEvent.request_id == self.recent)
                      .order_by(models.HrSignEvent.seq).all())
            types = [e.type for e in events]
            self.assertIn("hold_placed", types)
            self.assertIn("hold_released", types)
            self.assertTrue(esign._verify_chain(events)["valid"])
        finally:
            db.close()

    def test_a_hold_needs_a_reason(self):
        r = self.client.post(f"/esign/requests/{self.recent}/holds", json={"reason": "   "})
        self.assertEqual(r.status_code, 400)

    def test_releasing_twice_is_refused(self):
        r = self.client.post(f"/esign/requests/{self.recent}/holds", json={"reason": "x"})
        hid = r.json()["id"]
        self.client.post(f"/esign/requests/{self.recent}/holds/{hid}/release")
        again = self.client.post(f"/esign/requests/{self.recent}/holds/{hid}/release")
        self.assertEqual(again.status_code, 409)


class StatutoryFormLockTests(unittest.TestCase):
    """Criterion 12."""

    TPL = "tpl-statutory-test"

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = USER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Retention Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=USER))
            db.add(models.HrSignTemplate(
                id=self.TPL, name="CA Conditional Waiver on Progress Payment", kind="custom",
                status="active", body_locked=True,
                body=["NOTICE: THIS DOCUMENT WAIVES THE CLAIMANT'S LIEN RIGHTS...",
                      "[[sign:claimant]]"],
                roles=[{"key": "claimant", "label": "Claimant"}], attachments=[],
                created_by=USER, created_at="2026-09-01T00:00:00+00:00"))
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
            db.query(models.HrSignTemplate).filter(models.HrSignTemplate.id == self.TPL).delete()
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete()
            db.commit()
        finally:
            db.close()

    def _patch(self, **kw):
        d = {"name": "CA Conditional Waiver on Progress Payment", "kind": "custom"}
        d.update(kw)
        return self.client.patch(f"/esign/templates/{self.TPL}", json=d)

    def test_editing_the_body_of_a_statutory_form_is_refused(self):
        r = self._patch(body=["Some wording we prefer.", "[[sign:claimant]]"])
        self.assertEqual(r.status_code, 422)
        self.assertIn("statutory form", r.json()["detail"])

    def test_the_body_is_actually_unchanged_after_a_refused_edit(self):
        self._patch(body=["Rewritten."])
        db = database.SessionLocal()
        try:
            row = db.query(models.HrSignTemplate).filter(
                models.HrSignTemplate.id == self.TPL).first()
            self.assertTrue(row.body[0].startswith("NOTICE:"))
        finally:
            db.close()

    def test_resending_the_identical_body_is_allowed(self):
        """Saving the form without touching its text must not be an error -
        the lock is on CHANGING the wording, not on saving the template."""
        db = database.SessionLocal()
        try:
            body = list(db.query(models.HrSignTemplate).filter(
                models.HrSignTemplate.id == self.TPL).first().body)
        finally:
            db.close()
        self.assertEqual(self._patch(body=body).status_code, 200)

    def test_renaming_a_statutory_form_is_still_allowed(self):
        r = self._patch(name="CA Conditional Waiver (progress payment)")
        self.assertEqual(r.status_code, 200)

    def test_an_unlocked_template_can_still_be_edited(self):
        db = database.SessionLocal()
        try:
            row = db.query(models.HrSignTemplate).filter(
                models.HrSignTemplate.id == self.TPL).first()
            row.body_locked = False
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._patch(body=["Anything.", "[[sign:claimant]]"]).status_code, 200)


class AuthenticationOrderTests(unittest.TestCase):
    """Criterion 9 - authenticated_at is set before a document is rendered."""

    def setUp(self):
        self.client = TestClient(main.app)
        self.db = database.SessionLocal()
        self.rid = f"env-auth-{uuid.uuid4()}"
        self.token = f"tok{uuid.uuid4().hex}"
        self.db.add(models.HrSignRequest(
            id=self.rid, title="Auth Order", source="template", status="pending",
            routing="sequential", body_snapshot=["Body.", "[[sign:a]]"], current_order=1,
            created_by=USER, created_at="2026-09-01T00:00:00+00:00"))
        self.party = models.HrSignParty(
            id=str(uuid.uuid4()), request_id=self.rid, role_key="a", name="Ext Signer",
            email="ext.signer@partner.example", kind="external", ordinal=1,
            status="notified", party_role="signer", token=self.token, access_code="7788")
        self.db.add(self.party)
        self.db.commit()

    def tearDown(self):
        self.db.query(models.HrSignParty).filter(
            models.HrSignParty.request_id == self.rid).delete()
        self.db.query(models.HrSignRequest).filter(
            models.HrSignRequest.id == self.rid).delete()
        self.db.commit()
        self.db.close()

    def test_a_wrong_access_code_renders_nothing_and_sets_no_authentication(self):
        r = self.client.get(f"/esign/public/{self.token}", headers={"x-access-code": "0000"})
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertTrue(data.get("locked"))
        self.assertNotIn("body", data)          # no document content whatsoever
        self.assertNotIn("documents", data)
        self.db.expire_all()
        party = self.db.query(models.HrSignParty).filter(
            models.HrSignParty.id == self.party.id).first()
        self.assertEqual(party.authenticated_at, "")

    def test_the_correct_code_authenticates_before_the_document_is_returned(self):
        r = self.client.get(f"/esign/public/{self.token}", headers={"x-access-code": "7788"})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json().get("locked"))
        self.db.expire_all()
        party = self.db.query(models.HrSignParty).filter(
            models.HrSignParty.id == self.party.id).first()
        self.assertTrue(party.authenticated_at, "document was rendered with no authenticated_at")

    def test_an_unknown_token_renders_nothing(self):
        self.assertEqual(self.client.get("/esign/public/not-a-real-token").status_code, 404)


if __name__ == "__main__":
    unittest.main()


class RetentionCopyTests(unittest.TestCase):
    """N8 / UETA section 8 - a signer can keep a copy WHILE deciding."""

    def setUp(self):
        self.client = TestClient(main.app)
        self.db = database.SessionLocal()
        self.rid = f"env-copy-{uuid.uuid4()}"
        self.token = f"tok{uuid.uuid4().hex}"
        self.db.add(models.HrSignRequest(
            id=self.rid, title="Retention Copy Agreement", source="template", status="pending",
            routing="sequential", body_snapshot=["The terms.", "[[sign:a]]"], current_order=1,
            created_by=USER, created_at="2026-09-01T00:00:00+00:00"))
        self.db.add(models.HrSignParty(
            id=str(uuid.uuid4()), request_id=self.rid, role_key="a", name="Ext Signer",
            email="ext@partner.example", kind="external", ordinal=1, status="notified",
            party_role="signer", token=self.token))
        self.db.commit()

    def tearDown(self):
        self.db.query(models.HrSignParty).filter(
            models.HrSignParty.request_id == self.rid).delete()
        self.db.query(models.HrSignRequest).filter(
            models.HrSignRequest.id == self.rid).delete()
        self.db.commit()
        self.db.close()

    def test_a_copy_is_downloadable_before_signing(self):
        r = self.client.get(f"/esign/public/{self.token}/copy")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], "application/pdf")
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertIn("attachment", r.headers.get("content-disposition", ""))

    def test_taking_a_copy_does_not_require_consenting_first(self):
        self.db.expire_all()
        party = self.db.query(models.HrSignParty).filter(
            models.HrSignParty.request_id == self.rid).first()
        self.assertEqual(party.consent_at or "", "")
        self.assertEqual(self.client.get(f"/esign/public/{self.token}/copy").status_code, 200)

    def test_the_retention_download_is_audited(self):
        self.client.get(f"/esign/public/{self.token}/copy")
        self.db.expire_all()
        types = [e.type for e in self.db.query(models.HrSignEvent)
                 .filter(models.HrSignEvent.request_id == self.rid).all()]
        self.assertIn("copy_retained", types)

    def test_the_payload_offers_the_copy_link_to_an_external_signer(self):
        payload = self.client.get(f"/esign/public/{self.token}").json()
        self.assertIn("/copy", payload["copyUrl"])
        self.assertIn(self.token, payload["copyUrl"])
