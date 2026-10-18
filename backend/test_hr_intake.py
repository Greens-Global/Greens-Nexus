"""The candidate's details link (Oct 14) - "Hey, tell me your name, your
address ... You fill it all in. Then it generates that hiring paperwork
instantly" (Neil).

Start Hiring Packet with "the candidate fills in their details" emails a link;
the candidate's page shows nothing beyond the role (no pay); their submit
generates the documents and asks the verifier; the link works once, dies
with the offer, is stored only as a hash, and a fresh one kills the old.

    python -m pytest test_hr_intake.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import role_change as rc  # noqa: E402

D = "@greensglobal.com"
CO = "co-intake"
HR = "charmi.hr" + D
CAND = "jane.doe@gmail.com"

OFFER = {"pages": [{"id": "p1", "json": {"type": "doc", "content": [
    {"type": "paragraph", "content": [{"type": "text", "text": "Dear "}, {"type": "mergeField", "attrs": {"token": "first_name"}},
                                      {"type": "text", "text": " at "}, {"type": "mergeField", "attrs": {"token": "address"}}]},
    {"type": "signatureBlock", "attrs": {"role": "company"}}, {"type": "signatureBlock", "attrs": {"role": "employee"}}]}}]}


class IntakeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        for m in (models.HrLifeEvent, models.HrPacketSetting, models.DocTemplate, models.DocTemplateVersion,
                  models.Document, models.DocumentVersion, models.HrCandidate, models.HrStageEvent,
                  models.NexusEmployee, models.HrEntity, models.NexusNotification, models.NexusGroup,
                  models.NexusGroupMember):
            db.query(m).delete()
        db.add(models.HrEntity(id=CO, name="Greens Test", legal_name="Greens Test, LLC", hr_contact_email=HR))
        db.add(models.NexusEmployee(id="e-hr", work_email=HR, first_name="Charmi", last_name="Shah", company=CO, status="active"))
        db.add(models.NexusGroup(id="g-comp", name="People + Pay", allowed_modules="hr:editor,hr_comp:viewer"))
        db.add(models.NexusGroupMember(group_id="g-comp", email=HR))
        db.add(models.DocTemplate(id="t-offer", name="Offer Letter", category="hr", status="active", version=1, content=OFFER,
                                  department="", published_version=1, published_meta={}))
        db.add(models.DocTemplateVersion(id="v1", template_id="t-offer", version_no=1, content=OFFER))
        db.add(models.HrPacketSetting(id="s-hire", entity_id=CO, event="hire", worker_type="any", engine="documents",
                                      template_id="", name="Hiring", doc_template_ids=["t-offer"], subject_role="employee",
                                      flow=[{"key": "company", "role": "hr", "action": "sign"},
                                            {"key": "employee", "role": "employee", "action": "sign"}], verify_role="hr"))
        db.add(models.HrCandidate(id="cand-1", first_name="Jen", last_name="Doe", email=CAND, role_title="Analyst",
                                  stage="offer", company=CO, created_by=HR, created_at="2026-10-01T00:00:00"))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        os.environ["NEXUS_DEV_EMAIL"] = HR
        self.sent = []
        self._real_send, rc.send_emails = rc.send_emails, lambda batch: self.sent.extend(batch)

    def tearDown(self):
        rc.send_emails = self._real_send
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _start(self):
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json={
            "intake": "candidate",
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28"},
            "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"}})
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        return out, out["intakeUrl"].rsplit("/", 1)[-1]

    def _ev(self, eid):
        db = database.SessionLocal()
        try:
            return db.query(models.HrLifeEvent).filter_by(id=eid).first()
        finally:
            db.close()

    def _values(self, **kw):
        v = {"first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
             "emergency_name": "John Doe"}
        v.update(kw)
        return {"values": v}

    def test_the_candidate_fills_in_their_details_and_the_documents_are_generated(self):
        out, token = self._start()
        self.assertEqual(out["status"], "intake")
        ev = self._ev(out["id"])
        self.assertEqual(ev.documents, [])
        self.assertNotIn(token, (ev.intake_token_hash, str(ev.inputs)))       # only the hash is kept
        self.assertEqual(len(self.sent), 1)
        to, subject, html = self.sent[0]
        self.assertEqual(to, CAND)
        self.assertIn(f"/intake/{token}", html)
        self.assertNotIn("85,000", html)

        page = self.client.get(f"/hr/intake/public/{token}").json()
        self.assertEqual((page["state"], page["role"], page["firstName"]), ("open", "Analyst", "Jen"))
        self.assertNotIn("pay", str(page).lower().replace("payroll", ""))

        r = self.client.post(f"/hr/intake/public/{token}", json=self._values(address=""))
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.post(f"/hr/intake/public/{token}", json=self._values())
        self.assertEqual(r.status_code, 200, r.text)
        ev = self._ev(out["id"])
        self.assertEqual((ev.status, ev.subject_name, ev.intake["address"]), ("review", "Jane Doe", "12 Pine St"))
        self.assertEqual(len(ev.documents), 1)
        db = database.SessionLocal()
        self.assertEqual(db.query(models.HrCandidate).filter_by(id="cand-1").first().first_name, "Jane")
        self.assertTrue(db.query(models.NexusNotification).filter(models.NexusNotification.recipient == HR,
                        models.NexusNotification.title.like("Ready to Verify%")).first())
        db.close()
        # used once
        self.assertEqual(self.client.post(f"/hr/intake/public/{token}", json=self._values()).status_code, 409)
        self.assertEqual(self.client.get(f"/hr/intake/public/{token}").json()["state"], "submitted")

    def test_asking_again_kills_the_old_link(self):
        out, old = self._start()
        r = self.client.post(f"/hr/life-events/{out['id']}/reopen-intake")
        self.assertEqual(r.status_code, 200, r.text)
        new = r.json()["intakeUrl"].rsplit("/", 1)[-1]
        self.assertNotEqual(old, new)
        self.assertEqual(self.client.get(f"/hr/intake/public/{old}").status_code, 404)
        self.assertEqual(self.client.get(f"/hr/intake/public/{new}").json()["state"], "open")

    def test_the_link_dies_with_the_offer(self):
        out, token = self._start()
        db = database.SessionLocal()
        db.query(models.HrLifeEvent).filter_by(id=out["id"]).update({"intake_expires_on": "2020-01-01"})
        db.commit()
        db.close()
        self.assertEqual(self.client.get(f"/hr/intake/public/{token}").json()["state"], "expired")
        self.assertEqual(self.client.post(f"/hr/intake/public/{token}", json=self._values()).status_code, 410)

    def test_a_voided_packet_closes_the_link(self):
        out, token = self._start()
        self.assertEqual(self.client.post(f"/hr/life-events/{out['id']}/void").status_code, 200)
        self.assertEqual(self.client.get(f"/hr/intake/public/{token}").json()["state"], "closed")

    def test_wrong_tokens_are_refused(self):
        self.assertEqual(self.client.get("/hr/intake/public/not-a-real-token").status_code, 404)
        self.assertEqual(self.client.post("/hr/intake/public/not-a-real-token", json=self._values()).status_code, 404)


if __name__ == "__main__":
    unittest.main()
