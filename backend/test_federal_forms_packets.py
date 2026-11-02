"""Federal forms in hiring packets and on the person record (Neil, 11/02/2026,
the federal forms plan, Task 8).

A US hiring packet whose setting lists `federal_forms` carries the W-4, the
I-9 and the Direct Deposit Authorization after its Documents, the person
first and an HR step added for the I-9 when the flow has none; a non-US
company gets none. The person record sends one form by itself
(POST /hr/employees/{eid}/federal-forms/send) for HR++ only. A signed direct
deposit lands on Pay & Benefits, the SSN lands nowhere but the sealed PDF,
the checklist rows tick on their signals, the daily edition watch bells once
per state, and an expired edition is refused with the exact sentence.

    python -m pytest test_federal_forms_packets.py
"""
import json
import os
import re
import tempfile
import unittest
from datetime import date

# A throwaway sqlite of its own, so `python -m unittest test_federal_forms_packets`
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
import hr_checklist_seed  # noqa: E402
import hr_checklists as hc  # noqa: E402
import hr_packet_docs as hpd  # noqa: E402
import job_switch  # noqa: E402
import main  # noqa: E402
import middleware_hardening  # noqa: E402
import models  # noqa: E402
from federal_forms import editions, watch  # noqa: E402
from routers import esign  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
CO, CO_IN = "co-fed", "co-fed-in"
HR = "charmi.hr" + D          # the US company's HR contact, Pay & Benefits - HR++
ACCT = "amy.acct" + D         # the Accounting department head - the payroll bells
MGR = "max.mgr" + D           # a People editor who is NOT HR++ (no contact, no admin, no Full grant)
ADMIN = "neil.owner" + D      # administrator
CAND = "jane.doe@gmail.com"
ANA = "ana.diaz" + D          # an employee already in People (the standalone send)
IVY = "ivy.in" + D            # an employee of the India company
GOOD_SSN, GOOD_ROUTING, GOOD_ACCOUNT = "123-45-6789", "021000021", "000123456789"
PINNED = date(2026, 11, 2)    # the day this file was written; the editions are read against it


class _Frozen(date):
    """federal_forms.editions reads date.today() through its module global."""
    value = PINNED

    @classmethod
    def today(cls):
        return cls.value


def _doc(*nodes):
    return {"pages": [{"id": "p1", "json": {"type": "doc", "content": list(nodes)}}]}


def _p(*parts):
    return {"type": "paragraph", "content": [
        {"type": "mergeField", "attrs": {"token": x[2:-2]}} if x.startswith("{{") else {"type": "text", "text": x}
        for x in parts]}


def _sig(role):
    return {"type": "signatureBlock", "attrs": {"role": role, "label": ""}}


NDA = _doc(_p("Confidentiality for ", "{{full_name}}", "."), _sig("employee"))
SAMPLE = {"ssn": GOOD_SSN, "routing": GOOD_ROUTING, "account": GOOD_ACCOUNT, "zip": "92562",
          "date_mmddyyyy": "01/15/1990", "date_or_na": "N/A", "money": "0", "percent": "100",
          "alien_number": "A123456789", "i94": "12345678901", "passport": "X1234567 Mexico", "ein": "12-3456789"}


def _fill(fields, role, **on):
    """Every required text box of `role` filled with a value of its format,
    plus the checks and overrides given (by bare form field id)."""
    out = {}
    for f in fields:
        if f.get("role") != role:
            continue
        bare = f.get("formField") or f["id"]
        if bare in on:
            out[f["id"]] = on[bare]
        elif f.get("type") == "text" and f.get("required") and not f.get("value"):
            out[f["id"]] = SAMPLE.get(f.get("format", ""), "Sample")   # a prefilled box keeps its value
    return out


class FederalPacketCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)   # every model module is imported by now
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._rl = middleware_hardening.RequestRateLimit.ENABLED
        middleware_hardening.RequestRateLimit.ENABLED = False
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self.db = database.SessionLocal()
        for m in (models.HrLifeEvent, models.HrPacketSetting, models.DocTemplate, models.DocTemplateVersion,
                  models.Document, models.DocumentVersion, models.HrSignParty, models.HrSignRequest,
                  models.HrSignConsent, models.HrSignDocument, models.HrSignSeal, models.HrSignOtpChallenge,
                  models.HrSignEvent, models.HrCandidate, models.HrStageEvent, models.NexusEmployee,
                  models.HrEntity, models.HrDocument, models.NexusNotification, models.NexusRole,
                  models.NexusGroup, models.NexusGroupMember, models.HrChecklist, models.HrChecklistItem,
                  models.HrChecklistTemplate, models.NexusSetting, models.HrDepartment, models.Task):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Test", legal_name="Greens Test, LLC", country="US",
                                    tax_id="12-3456789", registered_address="100 Main St, Murrieta, CA 92562",
                                    hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO_IN, name="Greens India", legal_name="Greens India Pvt Ltd", country="IN",
                                    hr_contact_email=HR))
        for email, first, last, co in ((HR, "Charmi", "Shah", CO), (ACCT, "Amy", "Acct", CO), (MGR, "Max", "Mgr", CO),
                                       (ADMIN, "Neil", "Owner", CO)):
            self.db.add(models.NexusEmployee(id=f"e-{first}", work_email=email, first_name=first, last_name=last,
                                             company=co, status="active", job_title=f"{first} Title"))
        self.db.add(models.NexusEmployee(id="e-ana", work_email=ANA, personal_email="ana@gmail.com", first_name="Ana",
                                         last_name="Diaz", company=CO, status="onboarding", employment_type="full_time",
                                         start_date="2026-11-16", bank=[]))
        self.db.add(models.NexusEmployee(id="e-ivy", work_email=IVY, first_name="Ivy", last_name="In", company=CO_IN,
                                         status="active", employment_type="full_time", start_date="2026-11-16"))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator"))
        self.db.add(models.NexusGroup(id="g-comp", name="People + Pay", allowed_modules="hr:editor,hr_comp:viewer"))
        self.db.add(models.NexusGroup(id="g-hr", name="People", allowed_modules="hr:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-comp", email=HR))
        self.db.add(models.NexusGroupMember(group_id="g-hr", email=MGR))
        self.db.add(models.HrDepartment(id="d-acct", company_id=CO, name="Accounting", lead_email=ACCT))
        meta = {"fieldDefs": [], "signerRoles": [], "mergeOverrides": {}, "letterheadId": "", "requiresLetterhead": False}
        self.db.add(models.DocTemplate(id="t-nda", name="NDA", category="hr", status="active", version=1, content=NDA,
                                       department="", published_version=1, published_meta=meta))
        self.db.add(models.DocTemplateVersion(id="v-nda", template_id="t-nda", version_no=1, content=NDA))
        self.db.add(models.HrCandidate(id="cand-1", first_name="Jen", last_name="Doe", email=CAND, role_title="Analyst",
                                       department="Accounting", stage="offer", company=CO, created_by=HR,
                                       created_at="2026-10-01T00:00:00"))
        self.db.commit()
        esign._ensure_document_classes(self.db)
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        job_switch.invalidate()
        os.environ["NEXUS_DEV_EMAIL"] = HR
        self.codes, self.invited = {}, []
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_graph_send_mail", esign._graph_send_mail),
                         (esign, "_egnyte_push", esign._egnyte_push),
                         (esign, "_storage_configured", esign._storage_configured),
                         (editions, "date", editions.date)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda party, req, sender, custom=None: self.invited.append(party.email) or (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._graph_send_mail = lambda **kw: (True, "")
        esign._egnyte_push = lambda *a, **k: (True, "")
        esign._storage_configured = lambda: False          # local files only - never the shared buckets
        _Frozen.value = PINNED
        editions.date = _Frozen

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        middleware_hardening.RequestRateLimit.ENABLED = self._rl
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self.db.close()

    # ── helpers ────────────────────────────────────────────────────────────
    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def _setting(self, flow=None, forms=("w4", "i9", "direct_deposit"), entity=CO, **kw):
        base = dict(id="s-hire", entity_id=entity, event="hire", worker_type="any", engine="documents",
                    template_id="", name="Analyst Hiring", doc_template_ids=["t-nda"], subject_role="employee",
                    flow=flow or [{"key": "employee", "role": "employee", "action": "sign"}],
                    verify_role="hr", email_message="Welcome!", country="US" if entity == CO else "IN",
                    federal_forms=list(forms))
        base.update(kw)
        self.db.add(models.HrPacketSetting(**base))
        self.db.commit()

    def _start(self, **kw):
        body = {"inputs": {"job_title": "Analyst", "start_date": "2030-11-04", "offer_expires": "2030-10-28",
                           "manager_email": MGR, "employment_type": "full_time"},
                "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"},
                "details": {"first_name": "Jane", "last_name": "Doe", "phone": "555-0100",
                            "address": "12 Pine St, Springfield", "emergency_name": "John Doe",
                            "emergency_relationship": "Brother", "emergency_phone": "555-0101"}}
        body.update(kw)
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _verify(self, eid):
        r = self.client.get(f"/hr/life-events/{eid}/review")
        self.assertEqual(r.status_code, 200, r.text)
        review = r.json()
        return self.client.post(f"/hr/life-events/{eid}/verify-and-send",
                                json={"excluded_ack": True, "seen": review["seen"]})

    def _req(self, eid):
        self.db.expire_all()
        ev = self.db.query(models.HrLifeEvent).filter_by(id=eid).first()
        return self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()

    def _parties(self, rid):
        self.db.expire_all()
        return (self.db.query(models.HrSignParty).filter_by(request_id=rid)
                .order_by(models.HrSignParty.ordinal).all())

    def _gates(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        self.assertEqual(r.status_code, 200, r.text)

    def _sign(self, party, values):
        return self.client.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "field_values": values, "format_demonstrated": "pdf_rendered_in_session",
            "pages_viewed": 1, "pages_total": 1})

    def _bells(self, to, prefix=""):
        self.db.expire_all()
        rows = self.db.query(models.NexusNotification).filter_by(recipient=to).all()
        return [n for n in rows if n.title.startswith(prefix)]

    @staticmethod
    def _by_kind(req):
        return {d.get("formKind"): d for d in (req.documents or []) if d.get("formKind")}

    @staticmethod
    def _field(doc, bare):
        return next(f for f in doc["fields"] if (f.get("formField") or f["id"]) == bare)


class PacketTests(FederalPacketCase):
    def test_us_hire_packet_carries_the_forms_person_first_hr_added_signed_and_applied(self):
        self._setting()
        eid = self._start()["id"]
        r = self._verify(eid)
        self.assertEqual(r.status_code, 200, r.text)
        req = self._req(eid)
        docs = self._by_kind(req)
        # Three more documents after the packet's own, in the registry's order.
        self.assertEqual(list(docs), ["w4", "i9", "direct_deposit"])
        self.assertEqual([d["name"] for d in req.documents],
                         ["Form W-4 (2026).pdf", "Form I-9 (01/20/25).pdf", "Direct Deposit Authorization (v1).pdf"])
        self.assertEqual(req.prints_pay, 1)                        # sensitive boxes restrict the envelope
        # The person first; an HR step added for the I-9, resolved to the HR contact.
        parties = self._parties(req.id)
        self.assertEqual([(p.email, p.role_key, p.ordinal) for p in parties], [(CAND, "employee", 1), (HR, "hr", 2)])
        self.assertEqual(self.invited, [CAND])
        # Field ids are unique across the packet; the bare form id travels as formField.
        every = list(req.fields or []) + [f for d in req.documents for f in d["fields"]]
        self.assertEqual(len({f["id"] for f in every}), len(every))
        w4, i9, dd = docs["w4"], docs["i9"], docs["direct_deposit"]
        self.assertEqual(self._field(w4, "ssn")["id"], "w4-ssn")
        self.assertTrue(self._field(w4, "ssn")["sensitive"])
        # Merge-sourced boxes print the company and the hire - nobody types them.
        self.assertEqual((self._field(w4, "employer_ein")["type"], self._field(w4, "employer_ein")["value"]),
                         ("merge", "12-3456789"))
        self.assertEqual(self._field(w4, "employer_first_date")["value"], "11/04/2030")
        self.assertEqual(self._field(w4, "employer_name_address")["value"],
                         "Greens Test, LLC, 100 Main St, Murrieta, CA 92562")
        self.assertEqual(self._field(dd, "employer_name")["value"], "Greens Test, LLC")
        self.assertEqual(self._field(i9, "business_name")["value"], "Greens Test, LLC")
        # The I-9's first day is HR's to confirm: prefilled, editable, required by Section 2.
        first_day = self._field(i9, "first_day")
        self.assertEqual((first_day["type"], first_day["role"], first_day["value"], first_day["required"]),
                         ("text", "hr", "11/04/2030", True))
        self.assertEqual({f["role"] for f in i9["fields"] if f.get("source") == "hr"}, {"hr"})
        self.assertEqual({f["role"] for f in w4["fields"] if f.get("source") == "person"}, {"employee"})

        # Jane signs. Two filing statuses is a form rule, not a format: 422 with the field.
        jane = parties[0]
        self._gates(jane)
        values = {}
        for kind, doc in docs.items():
            values.update(_fill(doc["fields"], "employee"))
        bad = {**values, "w4-filing_single": "true", "w4-filing_joint": "true", "i9-citizen_us": "true",
               "direct_deposit-dd1_type_checking": "true"}
        r = self._sign(jane, bad)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["detail"]["field"], "w4-filing_single")
        self.assertNotIn(GOOD_SSN, r.text)
        good = {**values, "w4-filing_single": "true", "i9-citizen_us": "true",
                "direct_deposit-dd1_type_checking": "true", "direct_deposit-dd1_bank": "Chase"}
        r = self._sign(jane, good)
        self.assertEqual(r.status_code, 200, r.text)
        stored = self._parties(req.id)[0].field_values
        for fid in ("w4-ssn", "i9-ssn", "direct_deposit-dd1_routing", "direct_deposit-dd1_account"):
            self.assertTrue(str(stored.get(fid, "")).startswith("enc:"), fid)
        self.assertNotIn(GOOD_SSN, json.dumps(stored))
        # Section 1 done: the HR contact hears when Section 2 is due (3 business days from the first day).
        due = hc.due_for("2030-11-04", "2030-11-04", "S", 3, True, set())
        due_us = f"{due[5:7]}/{due[8:10]}/{due[:4]}"
        self.assertEqual([n.title for n in self._bells(HR, "I-9 Section 2 Due")],
                         [f"I-9 Section 2 Due {due_us} - Jane Doe"])
        self.assertEqual(self.invited, [CAND, HR])

        # HR signs Section 2: without a document recorded, 422 names the List A box.
        charmi = self._parties(req.id)[1]
        self._gates(charmi)
        hr_values = _fill(i9["fields"], "hr")
        r = self._sign(charmi, hr_values)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertEqual(r.json()["detail"]["field"], "i9-a1_title")
        r = self._sign(charmi, {**hr_values, "i9-a1_title": "U.S. Passport", "i9-a1_authority": "U.S. Department of State",
                                "i9-a1_number": "123456789", "i9-a1_expiry": "05/31/2032"})
        self.assertEqual(r.status_code, 200, r.text)
        # The first day HR never retyped was stored from its prefill.
        self.assertEqual(self._parties(req.id)[1].field_values.get("i9-first_day"), "11/04/2030")

        # Everyone signed: hired, the bank account on Pay & Benefits, the SSN nowhere.
        self.db.expire_all()
        ev = self.db.query(models.HrLifeEvent).filter_by(id=eid).first()
        self.assertEqual(ev.status, "completed", ev.apply_note)
        emp = self.db.query(models.NexusEmployee).filter_by(id=ev.employee_id).first()
        self.assertEqual(emp.bank, [{"holder": "Jane Doe", "bankName": "Chase", "routingOrIfsc": GOOD_ROUTING,
                                     "number": GOOD_ACCOUNT, "type": "checking", "source": "direct_deposit"}])
        record = json.dumps({"personal": emp.personal, "compliance": emp.compliance, "bank": emp.bank,
                             "custom": getattr(emp, "custom_fields", None)})
        self.assertNotIn("123456789", record.replace("-", "").replace(GOOD_ACCOUNT, ""))
        self.assertNotIn(GOOD_SSN, record)
        # One bell each to the Accounting owner, pointing at the person's Documents tab.
        titles = sorted(n.title for n in self._bells(ACCT))
        self.assertEqual(titles, ["Direct Deposit Signed - Jane Doe", "W-4 Signed - Jane Doe"])
        for n in self._bells(ACCT):
            self.assertEqual(json.loads(n.action)["sub"], f"hr-documents-{emp.id}")
            self.assertNotIn("123", n.body)
        # The checklist rows ticked on their signals.
        cl = self.db.query(models.HrChecklist).filter_by(employee_id=emp.id, kind="onboarding").first()
        self.assertIsNotNone(cl)
        items = {i.key: i for i in self.db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id).all()}
        for key in ("ON-05", "ON-18", "ON-23"):
            self.assertEqual((key, items[key].status, items[key].done_by), (key, "done", "Nexus"))
        self.assertIn("W-4", items["ON-05"].done_reason)
        self.assertIn("Section 1", items["ON-18"].done_reason)
        self.assertIn("Section 2", items["ON-23"].done_reason)

    def test_an_existing_hr_sign_step_takes_the_i9(self):
        self._setting(flow=[{"key": "company", "role": "hr", "action": "sign"},
                            {"key": "employee", "role": "employee", "action": "sign"}])
        eid = self._start()["id"]
        r = self._verify(eid)
        self.assertEqual(r.status_code, 200, r.text)
        req = self._req(eid)
        self.assertEqual([(p.email, p.role_key) for p in self._parties(req.id)], [(CAND, "employee"), (HR, "company")])
        i9 = self._by_kind(req)["i9"]
        self.assertEqual({f["role"] for f in i9["fields"] if f.get("source") == "hr"}, {"company"})

    def test_a_non_us_company_gets_no_forms(self):
        self._setting(entity=CO_IN)
        self.db.query(models.HrCandidate).filter_by(id="cand-1").update({"company": CO_IN})
        self.db.commit()
        eid = self._start()["id"]
        self.assertEqual(self._verify(eid).status_code, 200)
        req = self._req(eid)
        self.assertEqual(self._by_kind(req), {})
        self.assertEqual(len(self._parties(req.id)), 1)

    def test_an_expired_edition_is_refused_at_verify(self):
        self._setting(forms=("w4",))
        eid = self._start()["id"]
        _Frozen.value = date(2027, 2, 1)     # January is the grace month; February is not
        r = self._verify(eid)
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"], "The Form W-4 edition in Nexus (2026) expired on 01/31/2027. "
                                             "Ask an administrator to update it before sending.")
        self.db.expire_all()
        self.assertEqual(self.db.query(models.HrLifeEvent).filter_by(id=eid).first().status, "review")

    def test_packet_settings_accept_the_forms_for_a_hiring_packet(self):
        body = {"entity_id": CO, "event": "hire", "name": "US Hiring", "doc_template_ids": ["t-nda"],
                "flow": [{"key": "employee", "role": "employee", "action": "sign"}], "verify_role": "hr",
                "country": "US", "worker_type": "employee", "federalForms": ["w4", "bogus"]}
        r = self.client.put("/hr/packets/documents", json=body)
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.put("/hr/packets/documents", json={**body, "federalForms": ["i9", "w4", "i9"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["federalForms"], ["w4", "i9"])         # registry order, de-duplicated
        r = self.client.put("/hr/packets/documents", json={**body, "id": r.json()["id"], "federal_forms": ["direct_deposit"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["federalForms"], ["direct_deposit"])


class StandaloneSendTests(FederalPacketCase):
    def _send(self, eid, kind):
        return self.client.post(f"/hr/employees/{eid}/federal-forms/send", json={"kind": kind})

    def test_hr_sends_one_form_from_the_person_record_a_manager_cannot(self):
        r = self._send("e-ana", "w4")
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual(out["kind"], "w4")
        req = self.db.query(models.HrSignRequest).filter_by(id=out["id"]).first()
        self.assertEqual((req.link_kind, req.link_id, req.employee_id, req.entity_id, req.prints_pay),
                         ("federal_form", "e-ana:w4", "e-ana", CO, 1))
        self.assertEqual(req.title, "Form W-4 - Ana Diaz")
        self.assertEqual([(p.email, p.role_key, p.kind) for p in self._parties(req.id)], [(ANA, "employee", "internal")])
        self.assertEqual(self._by_kind(req), {})               # the one document IS the source PDF
        self.assertEqual(req.documents, [])
        self.assertEqual(self._field({"fields": req.fields}, "employer_first_date")["value"], "11/16/2026")
        self.assertEqual(self._field({"fields": req.fields}, "ssn")["id"], "w4-ssn")
        self.assertEqual(hpd.federal_subfolder("w4"), "Tax and Payroll Forms")
        self.assertEqual(hpd.federal_subfolder("i9"), "Form I-9")
        self.assertEqual(hpd.federal_subfolder("direct_deposit"), "Tax and Payroll Forms")
        # A second W-4 while the first is out is refused.
        self.assertEqual(self._send("e-ana", "w4").status_code, 409)
        # The I-9: the person, then HR.
        r = self._send("e-ana", "i9")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(p.email, p.role_key) for p in self._parties(r.json()["id"])], [(ANA, "employee"), (HR, "hr")])
        # Not HR++: a People editor who is neither the HR contact nor an administrator.
        self._as(MGR)
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self.assertEqual(self._send("e-ana", "direct_deposit").status_code, 403)
        # An administrator is HR++ everywhere.
        self._as(ADMIN)
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self.assertEqual(self._send("e-ana", "direct_deposit").status_code, 200)
        # Never your own record.
        self.assertEqual(self._send("e-Neil", "w4").status_code, 403)

    def test_refusals(self):
        self.assertEqual(self._send("e-ana", "w9").status_code, 400)                      # not a federal form here
        r = self._send("e-ivy", "w4")                                                      # an India company
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("US", r.json()["detail"])
        self.assertEqual(self._send("nobody", "w4").status_code, 404)
        _Frozen.value = date(2027, 6, 1)
        r = self._send("e-ana", "i9")
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"], "The Form I-9 edition in Nexus (01/20/25) expired on 05/31/2027. "
                                             "Ask an administrator to update it before sending.")

    def test_status_route(self):
        r = self.client.get("/hr/federal-forms/status")
        self.assertEqual(r.status_code, 200, r.text)
        forms = {f["kind"]: f for f in r.json()["forms"]}
        self.assertEqual(list(forms), ["w4", "i9", "direct_deposit"])
        self.assertEqual((forms["i9"]["editionLabel"], forms["i9"]["expires"], forms["i9"]["state"]),
                         ("01/20/25", "05/31/2027", "ok"))
        self.assertEqual((forms["w4"]["expires"], forms["w4"]["state"]), ("01/31/2027", "ok"))
        self.assertTrue(forms["w4"]["sourceUrl"].startswith("https://www.irs.gov/"))
        self.assertEqual(r.json()["today"], "11/02/2026")
        _Frozen.value = date(2026, 12, 15)
        self.assertEqual(self.client.get("/hr/federal-forms/status").json()["forms"][0]["state"], "expiring")
        self._as(MGR)
        cache.module_grants.invalidate()
        self.assertEqual(self.client.get("/hr/federal-forms/status").status_code, 200)   # any People reader


class WatchTests(FederalPacketCase):
    def _refs(self):
        self.db.expire_all()
        return sorted((n.recipient, n.ref_id, n.title) for n in self.db.query(models.NexusNotification).all()
                      if n.ref_id.startswith("fedform:"))

    def test_the_daily_watch_bells_once_per_kind_and_state_to_hr_and_administrators(self):
        self.assertEqual(watch.run_daily(), 0)                 # 11/02/2026: everything current
        self.assertEqual(self._refs(), [])
        _Frozen.value = date(2027, 4, 15)                       # I-9 expiring, the 2026 W-4 expired
        n = watch.run_daily()
        refs = self._refs()
        self.assertEqual(n, 4)
        self.assertEqual(refs, sorted([
            (ADMIN, "fedform:i9:expiring", "Form I-9 Edition Expires 05/31/2027"),
            (ADMIN, "fedform:w4:expired", "Form W-4 Edition Expired - Sending Is Paused"),
            (HR, "fedform:i9:expiring", "Form I-9 Edition Expires 05/31/2027"),
            (HR, "fedform:w4:expired", "Form W-4 Edition Expired - Sending Is Paused")]))
        self.assertEqual(watch.run_daily(), 0)                 # the same state the next day: nothing new
        self.assertEqual(self._refs(), refs)
        # Switched off in Workflows > Automations: nothing, even on a new state.
        job_switch.set_off(self.db, "federal_forms", True, ADMIN)
        self.db.commit()
        job_switch.invalidate()
        _Frozen.value = date(2027, 6, 1)
        self.assertEqual(watch.run_daily(), 0)
        job_switch.set_off(self.db, "federal_forms", False, ADMIN)
        self.db.commit()
        job_switch.invalidate()
        self.assertEqual(watch.run_daily(), 2)                 # the I-9 moved to expired: one more per person
        self.assertIn((HR, "fedform:i9:expired", "Form I-9 Edition Expired - Sending Is Paused"), self._refs())
        self.assertIn("federal_forms", [j["key"] for j in __import__("workflows.automations").automations.jobs()])

    def test_w4_warning_wording_from_december(self):
        _Frozen.value = date(2026, 12, 1)
        watch.run_daily()
        self.assertIn((HR, "fedform:w4:expiring", "2027 Form W-4 Due In January"), self._refs())


class ChecklistSeedTests(FederalPacketCase):
    def test_seed_rows_carry_the_signals(self):
        rows = {r["key"]: r for r in hr_checklist_seed.ONBOARDING}
        self.assertEqual(rows["ON-05"]["signal"], "envelope:w4+direct_deposit")
        self.assertEqual(rows["ON-05"]["owner"], "accounting")
        self.assertIn("Nexus Sign", rows["ON-05"]["hint"])
        self.assertIn("(Neil, 11/02/2026)", rows["ON-05"]["hint"])
        self.assertEqual(rows["ON-18"]["signal"], "envelope:i9_s1")
        self.assertEqual(rows["ON-23"]["signal"], "id_on_file|envelope:i9_s2")
        for key in ("envelope:w4+direct_deposit", "envelope:i9_s1", "envelope:i9_s2"):
            self.assertTrue(hc.signal_label(key), key)

    def test_backfill_retrofits_seeded_templates_once(self):
        old = [dict(r) for r in hr_checklist_seed.ONBOARDING]
        for r in old:
            if r["key"] in ("ON-05", "ON-18"):
                r["signal"] = ""
            if r["key"] == "ON-23":
                r["signal"] = "id_on_file"
        self.db.add(models.HrChecklistTemplate(id="tpl-lib", kind="onboarding", entity_id="", name="Onboarding",
                                               items=old, updated_by="seed", updated_at="2026-10-01T00:00:00"))
        self.db.commit()
        self.assertEqual(hc.backfill_federal_forms(self.db), 1)
        self.db.expire_all()
        items = {r["key"]: r for r in self.db.query(models.HrChecklistTemplate).filter_by(id="tpl-lib").one().items}
        self.assertEqual(items["ON-05"]["signal"], "envelope:w4+direct_deposit")
        self.assertEqual(items["ON-18"]["signal"], "envelope:i9_s1")
        self.assertEqual(items["ON-23"]["signal"], "id_on_file|envelope:i9_s2")
        self.assertEqual(hc.backfill_federal_forms(self.db), 0)

    def test_the_and_condition_needs_both_forms(self):
        emp = self.db.query(models.NexusEmployee).filter_by(id="e-ana").first()
        self.assertFalse(hc._sig_envelope(self.db, emp, "w4+direct_deposit"))
        for kind, rid in (("w4", "r-w4"), ("direct_deposit", "r-dd")):
            self.db.add(models.HrSignRequest(id=rid, title=kind, employee_id="e-ana", status="completed",
                                             documents=[{"name": "x.pdf", "path": "p", "fields": [], "formKind": kind}]))
            self.db.commit()
            self.assertEqual(hc._sig_envelope(self.db, emp, "w4+direct_deposit"), kind == "direct_deposit")
        self.assertTrue(hc._sig_envelope(self.db, emp, "w4"))
        self.assertFalse(hc._sig_envelope(self.db, emp, "i9_s2"))
        # Section 1: the person's part signed on a pending I-9 envelope; Section 2: the envelope completed.
        self.db.add(models.HrSignRequest(id="r-i9", title="I-9", employee_id="e-ana", status="pending", pdf_storage_path="p",
                                         documents=[{"name": "i9.pdf", "path": "p", "formKind": "i9", "fields": [
                                             {"id": "i9-ssn", "role": "employee", "type": "text", "source": "person"},
                                             {"id": "i9-a1_title", "role": "hr", "type": "text", "source": "hr"}]}]))
        self.db.add(models.HrSignParty(id="p-ana", request_id="r-i9", role_key="employee", name="Ana", email=ANA,
                                       ordinal=1, status="waiting"))
        self.db.commit()
        self.assertFalse(hc._sig_envelope(self.db, emp, "i9_s1"))
        self.db.query(models.HrSignParty).filter_by(id="p-ana").update({"status": "signed"})
        self.db.commit()
        self.assertTrue(hc._sig_envelope(self.db, emp, "i9_s1"))
        self.assertFalse(hc._sig_envelope(self.db, emp, "i9_s2"))
        self.db.query(models.HrSignRequest).filter_by(id="r-i9").update({"status": "completed"})
        self.db.commit()
        self.assertTrue(hc._sig_envelope(self.db, emp, "i9_s2"))


class FormatsOneSourceTests(unittest.TestCase):
    def test_esign_formats_is_the_federal_forms_module(self):
        import esign_formats
        from federal_forms import formats
        self.assertIs(esign_formats.check, formats.check)
        self.assertIs(esign_formats.mask, formats.mask)
        self.assertIs(esign_formats.FORMATS, formats.FORMATS)
        self.assertEqual(formats.mask("ssn", GOOD_SSN), "***-**-6789")
        self.assertEqual(formats.mask("routing", GOOD_ROUTING), "••••0021")
        self.assertEqual(formats.mask("ssn", ""), "***-**-****")
        self.assertNotEqual(formats.check("account", "1234-5678"), "")        # digits only, like the screen's mask
        self.assertTrue(re.fullmatch(r"\d{2}/\d{2}/\d{4}", editions.status("i9")["expires"]))


if __name__ == "__main__":
    unittest.main()
