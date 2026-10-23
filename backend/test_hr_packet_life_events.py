"""Promotion letters and separation packages built from Documents (Oct 14).

The same engine as the hiring packet: generated at once from the PUBLISHED
templates, checked by the verifier, sent as one Nexus Sign envelope. A
promotion applies the new role, title and pay when signed; a separation's
offboarding goes ahead on its own schedule and never waits on the paperwork,
whose package follows the leaver to their personal email.

    python -m pytest test_hr_packet_life_events.py
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
import hr_life_events as hle  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import esign  # noqa: E402

D = "@greensglobal.com"
CO = "co-life"
HR = "charmi.hr" + D
MGR = "max.mgr" + D
ERIN = "erin.emp" + D
ERIN_HOME = "erin@home.example"


def _doc(*nodes):
    return {"pages": [{"id": "p1", "json": {"type": "doc", "content": list(nodes)}}]}


def _p(*parts):
    return {"type": "paragraph", "content": [
        {"type": "mergeField", "attrs": {"token": x[2:-2]}} if x.startswith("{{") else {"type": "text", "text": x}
        for x in parts]}


def _sig(role):
    return {"type": "signatureBlock", "attrs": {"role": role}}


PROMO = _doc(_p("Dear ", "{{first_name}}", ", from ", "{{old_title}}", " to ", "{{new_title}}", " on ",
                "{{effective_date}}", " at ", "{{salary}}", "."), _sig("employee"), _sig("manager"))
SEPARATION = _doc(_p("Dear ", "{{first_name}}", ", your last day is ", "{{last_day}}", " (", "{{separation_type}}", ")."),
                  _sig("company"), _sig("employee"))


class LifeEventDocsCase(unittest.TestCase):
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
        self.db = database.SessionLocal()
        for m in (models.HrLifeEvent, models.HrPacketSetting, models.DocTemplate, models.DocTemplateVersion,
                  models.Document, models.DocumentVersion, models.HrSignParty, models.HrSignRequest,
                  models.HrSignConsent, models.HrSignDocument, models.HrSignSeal, models.HrSignOtpChallenge,
                  models.HrSignEvent, models.NexusEmployee, models.HrEntity, models.HrDocument,
                  models.NexusNotification, models.NexusRole, models.NexusGroup, models.NexusGroupMember,
                  models.HrChecklist, models.HrChecklistItem, models.TimeApproval, models.PayrollRate,
                  models.PayrollRateHistory):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Test", legal_name="Greens Test, LLC", hr_contact_email=HR))
        for eid, email, first, extra in (("e-hr", HR, "Charmi", {}), ("e-mgr", MGR, "Max", {}),
                                         ("e-erin", ERIN, "Erin", {"manager_email": MGR, "personal_email": ERIN_HOME,
                                                                   "job_title": "IT Dev Associate I"})):
            self.db.add(models.NexusEmployee(id=eid, work_email=email, first_name=first, last_name="Test",
                                             company=CO, status="active", **extra))
        self.db.add(models.NexusRole(email=HR, role="owner"))           # Pay & Benefits, and may assign any role
        self.db.add(models.NexusGroup(id="g-comp", name="Pay", allowed_modules="hr:editor,hr_comp:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-comp", email=MGR))   # the manager signs a pay letter
        for gid, name in (("jr-1", "IT Dev Associate I"), ("jr-2", "IT Dev Associate II")):
            self.db.add(models.NexusGroup(id=gid, name=name, department="IT", is_job_role=1, tier="employee", company_id=CO))
        self.db.add(models.NexusGroupMember(group_id="jr-1", email=ERIN))
        meta = {"fieldDefs": [], "signerRoles": [], "mergeOverrides": {}, "letterheadId": "", "requiresLetterhead": False}
        for tid, content in (("t-promo", PROMO), ("t-sep", SEPARATION)):
            self.db.add(models.DocTemplate(id=tid, name=tid, category="hr", status="active", version=1, content=content,
                                           department="", published_version=1, published_meta=meta))
            self.db.add(models.DocTemplateVersion(id=f"v-{tid}", template_id=tid, version_no=1, content=content))
        self.db.add(models.HrPacketSetting(
            id="s-promo", entity_id=CO, event="promotion", worker_type="any", engine="documents", template_id="",
            name="Promotion Letter", doc_template_ids=["t-promo"], subject_role="employee", verify_role="hr",
            flow=[{"key": "employee", "role": "employee", "action": "sign"},
                  {"key": "manager", "role": "manager", "action": "sign"}]))
        self.db.add(models.HrPacketSetting(
            id="s-sep", entity_id=CO, event="separation", worker_type="any", engine="documents", template_id="",
            name="Separation Package", doc_template_ids=["t-sep"], subject_role="employee", verify_role="hr",
            flow=[{"key": "company", "role": "hr", "action": "sign"},
                  {"key": "employee", "role": "employee", "action": "sign"}]))
        self.db.commit()
        esign._ensure_document_classes(self.db)
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        os.environ["NEXUS_DEV_EMAIL"] = HR
        self.codes, self.invited = {}, []
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_storage_configured", esign._storage_configured)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda party, req, sender, custom=None: self.invited.append(party.email) or (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._storage_configured = lambda: False
        import routers.hr as hr_router
        self._patched.append((hr_router, "apply_status_change", hr_router.apply_status_change))
        real = hr_router.apply_status_change

        def no_m365(db, emp, body, by):     # the status change itself, without Microsoft 365
            emp.status = "offboarded"
            return {}
        hr_router.apply_status_change = no_m365
        self._real_status_change = real

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self.db.close()

    def _ev(self, eid):
        self.db.expire_all()
        return self.db.query(models.HrLifeEvent).filter_by(id=eid).first()

    def _party(self, rid, email):
        self.db.expire_all()
        return self.db.query(models.HrSignParty).filter_by(request_id=rid, email=email).first()

    def _sign(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 1, "pages_total": 1})
        self.assertEqual(r.status_code, 200, r.text)

    def _verify(self, eid):
        review = self.client.get(f"/hr/life-events/{eid}/review").json()
        self.assertTrue(review["canVerify"], review.get("problems"))
        r = self.client.post(f"/hr/life-events/{eid}/verify-and-send", json={"excluded_ack": True, "seen": review["seen"]})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()


class PromotionDocsTests(LifeEventDocsCase):
    def test_letter_generated_verified_signed_and_applied(self):
        body = {"inputs": {"change_type": "promotion", "role_id": "jr-2", "effective_date": "2030-01-01",
                           "reason": "Exceeded targets"},
                "pay": {"base": 40, "payBasis": "hourly", "currency": "USD"}}
        preview = self.client.post("/hr/employees/e-erin/promotion/preview", json=body).json()
        self.assertEqual(preview["engine"], "documents")
        self.assertEqual([r["name"] for r in preview["recipients"]], ["Erin Test", "Max Test"])
        self.assertEqual(self.client.post("/hr/employees/e-erin/promotion", json={**body, "excluded_ack": True}).status_code, 409)
        r = self.client.post("/hr/employees/e-erin/promotion/start", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        eid = r.json()["id"]
        self.assertEqual(r.json()["status"], "review")
        sent = self._verify(eid)
        self.assertEqual(sent["status"], "sent")                    # the employee signs first
        req = self._ev(eid).sign_request_id
        self._sign(self._party(req, ERIN))
        self._sign(self._party(req, MGR))
        ev = self._ev(eid)
        self.assertEqual(ev.status, "completed", ev.apply_note)
        emp = self.db.query(models.NexusEmployee).filter_by(id="e-erin").first()
        self.assertEqual(emp.job_title, "IT Dev Associate II")
        self.assertEqual(emp.compensation["base"], 40.0)
        self.assertEqual([m.group_id for m in self.db.query(models.NexusGroupMember).filter_by(email=ERIN)], ["jr-2"])


class SeparationDocsTests(LifeEventDocsCase):
    def _offboard(self, last_day):
        r = self.client.post("/hr/employees/e-erin/offboard", json={
            "inputs": {"last_day": last_day, "exit_type": "resignation", "send_package": True,
                       "offboarding": {"mailboxAction": "remove"}}, "excluded_ack": True})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_a_scheduled_offboarding_waits_for_nobody_and_the_package_goes_after_verify(self):
        ev = self._offboard("2030-06-30")
        self.assertEqual((ev["status"], ev["applyStatus"]), ("review", "scheduled"))
        self.assertEqual(ev["subjectEmail"], ERIN)                 # still here: the work email
        sent = self._verify(ev["id"])
        self.assertEqual(sent["status"], "sent")                  # the person signs first (Neil, Oct 22 2026)
        req = self._ev(ev["id"]).sign_request_id
        self._sign(self._party(req, ERIN))
        self.assertEqual(self._ev(ev["id"]).status, "sent")       # the company countersigns after
        self._sign(self._party(req, HR))
        self.assertEqual(self._ev(ev["id"]).status, "completed")
        self.assertEqual(self._ev(ev["id"]).apply_status, "scheduled")   # Left on the day, not at signing

    def test_leaving_today_offboards_now_and_the_package_goes_to_their_personal_email(self):
        today = hle._today()
        ev = self._offboard(today)
        self.assertEqual(ev["status"], "review")
        self.assertEqual(ev["applyStatus"], "applied")
        self.assertEqual(ev["subjectEmail"], ERIN_HOME)
        self._verify(ev["id"])
        req = self._ev(ev["id"]).sign_request_id
        self.assertEqual(self._party(req, ERIN_HOME).kind, "external")

    def test_canceling_before_the_package_is_sent_archives_it(self):
        ev = self._offboard("2030-06-30")
        r = self.client.post(f"/hr/life-events/{ev['id']}/cancel-offboarding")
        self.assertEqual(r.status_code, 200, r.text)
        ev = self._ev(ev["id"])
        self.assertEqual((ev.status, ev.apply_status), ("voided", "canceled"))
        self.assertEqual({d.status for d in self.db.query(models.Document).filter_by(life_event_id=ev.id)}, {"archived"})
        self.assertEqual(self.db.query(models.HrSignRequest).count(), 0)


if __name__ == "__main__":
    unittest.main()
