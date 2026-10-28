"""HR letters an employee requests from My HR (Neil, Oct 27 2026).

The employee sees only their own requests; HR for the person's company
(its HR contact, an administrator, a Full HR grant) sees and issues them,
nobody else; a Salary Certificate's pay is generated only by an issuer with
Pay & Benefits; the envelope's ONLY signer is the company's Authorized
Signatory (the HR contact when there is none); the sealed letter lands in
the employee's My HR documents and queues its Egnyte filing.

    python -m pytest test_hr_letters.py
"""
import io
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402
from pypdf import PdfReader  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import hr_letters as hl  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import esign  # noqa: E402

D = "@greensglobal.com"
CO, OTHER = "co-letters", "co-other"
HR = "hana.hr" + D            # Greens Letters' HR contact - no Pay & Benefits
SIGNER = "sam.signer" + D     # Greens Letters' Authorized Signatory - an owner
EMP = "erin.emp" + D
PEER = "pat.peer" + D         # another employee of the same company
OTHER_HR = "olga.hr" + D      # the other company's HR contact
COMP_HR = "carl.pay" + D      # HR of Greens Letters by a Full HR grant, with Pay & Benefits


def _text(pdf: bytes) -> str:
    return "".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages)


class HrLettersCase(unittest.TestCase):
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
        for m in (models.HrLetterRequest, models.DocTemplate, models.DocTemplateVersion, models.HrSignParty,
                  models.HrSignRequest, models.HrSignConsent, models.HrSignDocument, models.HrSignSeal,
                  models.HrSignOtpChallenge, models.HrSignEvent, models.NexusEmployee, models.HrEntity,
                  models.HrDocument, models.NexusNotification, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Letters", legal_name="Greens Letters, LLC",
                                    hr_contact_email=HR, signatory_email=SIGNER))
        self.db.add(models.HrEntity(id=OTHER, name="Other Co", legal_name="Other Co, Inc.", hr_contact_email=OTHER_HR))
        people = (("e-hr", HR, "Hana", CO, {"job_title": "HR Generalist"}),
                  ("e-signer", SIGNER, "Sam", CO, {"job_title": "Chief Executive Officer"}),
                  ("e-emp", EMP, "Erin", CO, {"job_title": "Site Coordinator", "department": "Operations",
                                              "start_date": "2024-03-04", "employment_type": "full_time",
                                              "compensation": {"base": 6250, "payBasis": "salary",
                                                               "frequency": "monthly", "currency": "USD"},
                                              "personal": {"currentAddress": "12 Pine Street, Austin, TX 78701"}}),
                  ("e-peer", PEER, "Pat", CO, {}),
                  ("e-ohr", OTHER_HR, "Olga", OTHER, {}),
                  ("e-comp", COMP_HR, "Carl", CO, {}))
        for eid, email, first, company, extra in people:
            self.db.add(models.NexusEmployee(id=eid, work_email=email, first_name=first, last_name="Test",
                                             company=company, status="active", **extra))
        self.db.add(models.NexusRole(email=SIGNER, role="owner"))
        self.db.add(models.NexusGroup(id="g-hr-full", name="HR Full", allowed_modules="hr:full,hr_comp:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-hr-full", email=COMP_HR))
        self.db.add(models.NexusAccessScope(id="s-comp", email=COMP_HR, module_id="hr", scope_type="entity", scope_id=CO))
        self.db.commit()
        esign._ensure_document_classes(self.db)
        self.codes = {}
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_storage_configured", esign._storage_configured)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda party, req, sender, custom=None: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._storage_configured = lambda: False
        self.as_(EMP)

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self.db.query(models.NexusAccessScope).delete()
        self.db.commit()
        self.db.close()

    # ── helpers ──
    def as_(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        cache.module_grants.invalidate()
        auth._role_cache.clear()

    def ask(self, letter_type="employment_verification", **kw):
        self.as_(kw.pop("who", EMP))
        r = self.client.post("/letter-requests", json={"letter_type": letter_type, "purpose": "Apartment lease",
                                                        "addressed_to": "Oak Leasing", **kw})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def row(self, rid):
        self.db.expire_all()
        return self.db.query(models.HrLetterRequest).filter_by(id=rid).first()

    def sign(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/verify",
                                json={"code": self.codes[party.email]}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 1, "pages_total": 1})
        self.assertEqual(r.status_code, 200, r.text)

    def issue(self, rid, who=HR, **body):
        self.as_(who)
        return self.client.post(f"/letter-requests/{rid}/issue", json={"excluded_ack": True, **body})


class EmployeeSideTests(HrLettersCase):
    def test_types_request_and_only_my_own(self):
        types = self.client.get("/letter-requests/types").json()
        self.assertEqual([t["key"] for t in types], list(hl.TYPE_KEYS))
        mine = self.ask(needed_by="2099-01-15")
        self.assertEqual((mine["status"], mine["statusLabel"]), ("requested", "Requested"))
        self.assertNotIn("employeeEmail", mine)                  # the HR shape is HR's
        self.assertEqual([r["id"] for r in self.client.get("/letter-requests/mine").json()], [mine["id"]])
        self.as_(PEER)
        self.assertEqual(self.client.get("/letter-requests/mine").json(), [])
        self.assertEqual(self.client.get("/letter-requests/queue").json(), {"canReview": False, "requests": []})
        self.assertEqual(self.client.get(f"/letter-requests/{mine['id']}/review").status_code, 404)
        # HR heard of it: one bell for the company's HR contact.
        bells = self.db.query(models.NexusNotification).filter_by(ref_id=mine["id"]).all()
        self.assertEqual([b.recipient for b in bells], [HR])
        self.assertIn("01/15/2099", bells[0].body)                # US dates, never ISO

    def test_one_open_request_per_type_and_a_purpose_is_required(self):
        self.ask()
        r = self.client.post("/letter-requests", json={"letter_type": "employment_verification", "purpose": "Bank"})
        self.assertEqual(r.status_code, 409)
        r = self.client.post("/letter-requests", json={"letter_type": "experience_letter", "purpose": " "})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/letter-requests", json={"letter_type": "experience_letter", "purpose": "Bank",
                                                       "needed_by": "2020-01-01"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("already passed", r.json()["detail"])

    def test_a_type_turned_off_for_the_company_cannot_be_requested(self):
        self.as_(HR)
        cfg = self.client.get(f"/letter-requests/settings?company_id={CO}")
        self.assertEqual(cfg.status_code, 403)                    # the HR contact alone holds no HR grant
        self.as_(SIGNER)                                          # an owner: every company
        types = {t["key"]: {"on": t["key"] != "visa_noc", "templateId": ""} for t in hl.LETTER_TYPES}
        r = self.client.put(f"/letter-requests/settings?company_id={CO}", json={"types": types})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["hasOverride"])
        self.as_(EMP)
        self.assertNotIn("visa_noc", [t["key"] for t in self.client.get("/letter-requests/types").json()])
        r = self.client.post("/letter-requests", json={"letter_type": "visa_noc", "purpose": "Trip"})
        self.assertEqual(r.status_code, 400)
        self.as_(COMP_HR)                                         # scoped to one company: not the default for all
        self.assertEqual(self.client.put("/letter-requests/settings", json={"types": types}).status_code, 403)


class HrScopeTests(HrLettersCase):
    def test_hr_sees_their_own_companies_only(self):
        mine = self.ask()
        self.as_(HR)
        q = self.client.get("/letter-requests/queue").json()
        self.assertEqual([r["id"] for r in q["requests"]], [mine["id"]])
        self.assertEqual(q["requests"][0]["employeeEmail"], EMP)
        self.as_(OTHER_HR)
        self.assertEqual(self.client.get("/letter-requests/queue").json()["requests"], [])
        self.assertEqual(self.client.get(f"/letter-requests/{mine['id']}/review").status_code, 404)
        self.assertEqual(self.issue(mine["id"], who=OTHER_HR).status_code, 404)
        self.as_(COMP_HR)                                         # a Full HR grant scoped to the company
        self.assertEqual(len(self.client.get("/letter-requests/queue").json()["requests"]), 1)

    def test_a_person_who_moved_companies_is_their_new_hrs(self):
        # Release review (Oct 27): HR scope is the person's CURRENT company at
        # review / issue time, not the company stamped when they asked.
        mine = self.ask()
        self.db.query(models.NexusEmployee).filter_by(id="e-emp").update({"company": OTHER})
        self.db.commit()
        self.as_(HR)
        self.assertEqual(self.client.get("/letter-requests/queue").json()["requests"], [])
        self.assertEqual(self.client.get(f"/letter-requests/{mine['id']}/review").status_code, 404)
        self.as_(OTHER_HR)
        self.assertEqual([r["id"] for r in self.client.get("/letter-requests/queue").json()["requests"]], [mine["id"]])
        self.assertEqual(self.client.get(f"/letter-requests/{mine['id']}/review").status_code, 200)

    def test_hr_never_reviews_their_own_request(self):
        own = self.ask(who=HR)
        self.as_(HR)
        self.assertEqual(self.client.get(f"/letter-requests/{own['id']}/review").status_code, 404)
        self.assertNotIn(own["id"], [r["id"] for r in self.client.get("/letter-requests/queue").json()["requests"]])

    def test_review_then_decline_tells_the_employee_in_one_bell(self):
        mine = self.ask()
        self.as_(HR)
        self.assertEqual(self.client.post(f"/letter-requests/{mine['id']}/start-review").json()["status"], "in_review")
        r = self.client.post(f"/letter-requests/{mine['id']}/decline", json={"reason": " "})
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/letter-requests/{mine['id']}/decline", json={"reason": "We need your new address first."})
        self.assertEqual(r.json()["status"], "declined")
        bells = self.db.query(models.NexusNotification).filter_by(ref_id=mine["id"], recipient=EMP).all()
        self.assertEqual(len(bells), 1)                           # updated in place, never one per step
        self.assertIn("Declined", bells[0].title)
        self.assertIn("new address", bells[0].body)
        self.as_(EMP)
        self.assertEqual(self.client.get("/letter-requests/mine").json()[0]["declineReason"],
                         "We need your new address first.")


class PayTests(HrLettersCase):
    def test_salary_certificate_pay_only_with_pay_and_benefits(self):
        mine = self.ask("salary_certificate", purpose="Car loan")
        self.as_(HR)                                              # no hr_comp
        review = self.client.get(f"/letter-requests/{mine['id']}/review").json()
        self.assertTrue(review["printsPay"])
        self.assertEqual(review["payFields"], [])
        self.assertFalse(review["canIssue"])
        pdf = self.client.post(f"/letter-requests/{mine['id']}/preview", json={}).content
        self.assertIn("[Pay]", _text(pdf))
        self.assertNotIn("6,250", _text(pdf))
        r = self.client.put(f"/letter-requests/{mine['id']}/values", json={"pay_values": {"salary": "$1.00"}})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.issue(mine["id"]).status_code, 403)
        self.assertEqual(self.row(mine["id"]).status, "requested")     # a refused issue changes nothing
        # The figure never rides on the employee's own view.
        self.as_(EMP)
        self.assertNotIn("6,250", str(self.client.get("/letter-requests/mine").json()))
        # Pay & Benefits: the figure prints, and it issues.
        self.as_(COMP_HR)
        review = self.client.get(f"/letter-requests/{mine['id']}/review").json()
        self.assertEqual(review["payFields"][0]["value"], "$6,250.00 per month")
        self.assertIn("6,250.00", _text(self.client.post(f"/letter-requests/{mine['id']}/preview", json={}).content))
        r = self.issue(mine["id"], who=COMP_HR, pay_values={"salary": "$75,000.00 per year"})
        self.assertEqual(r.status_code, 200, r.text)
        env = self.db.query(models.HrSignRequest).filter_by(id=r.json()["signRequestId"]).first()
        self.assertTrue(env.prints_pay)
        self.assertEqual(self.row(mine["id"]).values, {})          # pay never lands in the plain values

    def test_a_signatory_without_pay_access_cannot_sign_a_salary_certificate(self):
        ent = self.db.query(models.HrEntity).filter_by(id=CO).first()
        ent.signatory_email = PEER
        self.db.commit()
        mine = self.ask("salary_certificate", purpose="Car loan")
        r = self.issue(mine["id"], who=COMP_HR)
        self.assertEqual(r.status_code, 409)
        self.assertIn("Pay & Benefits", r.json()["detail"])


class EnvelopeTests(HrLettersCase):
    def _issued(self, letter_type="employment_verification"):
        mine = self.ask(letter_type)
        r = self.issue(mine["id"], values={"addressed_to": "Oak Leasing, Attn: Leasing Office"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "awaiting_signature")
        return mine["id"], r.json()["signRequestId"]

    def test_the_letter_prints_the_person_us_dates_and_the_signer(self):
        mine = self.ask(needed_by="")
        self.as_(HR)
        review = self.client.get(f"/letter-requests/{mine['id']}/review").json()
        self.assertTrue(review["canIssue"], review["problems"])
        self.assertEqual(review["signer"]["email"], SIGNER)
        self.assertNotIn("salary", [f["token"] for f in review["fields"]])
        text = _text(self.client.post(f"/letter-requests/{mine['id']}/preview",
                                      json={"values": {"addressed_to": "First National Bank"}}).content)
        for want in ("Erin Test", "Site Coordinator", "Operations", "03/04/2024", "full-time", "First National Bank",
                     "Apartment lease", "Sam Test", "Chief Executive Officer", "Greens Letters, LLC"):
            self.assertIn(want, text)
        self.assertNotIn("2024-03-04", text)
        self.assertNotIn("{{", text)
        # A value HR clears is missing, never printed blank.
        r = self.issue(mine["id"], values={"department": ""})
        self.assertEqual(r.status_code, 409)
        self.assertIn("Department", r.json()["detail"])

    def test_the_company_signatory_is_the_only_signer(self):
        rid, env_id = self._issued()
        parties = self.db.query(models.HrSignParty).filter_by(request_id=env_id).all()
        self.assertEqual([(p.email, p.party_role, p.kind) for p in parties], [(SIGNER, "signer", "internal")])
        self.assertNotIn(EMP, [p.email for p in parties])
        env = self.db.query(models.HrSignRequest).filter_by(id=env_id).first()
        self.assertEqual((env.link_kind, env.link_id, env.employee_id), ("hr_letter", rid, "e-emp"))
        self.assertEqual(self.row(rid).values, {"addressed_to": "Oak Leasing, Attn: Leasing Office"})
        self.assertEqual(self.row(rid).signer_email, SIGNER)

    def test_no_signatory_falls_back_to_the_hr_contact(self):
        ent = self.db.query(models.HrEntity).filter_by(id=CO).first()
        ent.signatory_email = ""
        self.db.commit()
        mine = self.ask()
        r = self.issue(mine["id"], who=COMP_HR)
        self.assertEqual(r.status_code, 200, r.text)
        parties = self.db.query(models.HrSignParty).filter_by(request_id=r.json()["signRequestId"]).all()
        self.assertEqual([p.email for p in parties], [HR])

    def test_issuing_your_own_signature_hands_back_the_signing_party(self):
        mine = self.ask()
        r = self.issue(mine["id"], who=SIGNER)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["signPartyId"])

    def test_sealed_letter_lands_in_my_hr_documents(self):
        rid, env_id = self._issued("address_proof")
        party = self.db.query(models.HrSignParty).filter_by(request_id=env_id, email=SIGNER).first()
        self.sign(party)
        req = self.row(rid)
        self.assertEqual(req.status, "issued")
        self.assertEqual(req.filing_status, "pending")             # the Egnyte pass files it, in its thread
        self.as_(EMP)
        docs = self.client.get("/myhr/documents").json()
        self.assertEqual([d["requestId"] for d in docs], [env_id])
        self.assertEqual(self.client.get("/letter-requests/mine").json()[0]["documentId"], env_id)
        self.assertEqual(self.db.query(models.HrDocument).filter_by(employee_id="e-emp").count(), 1)
        bell = self.db.query(models.NexusNotification).filter_by(ref_id=rid, recipient=EMP).all()
        self.assertEqual(len(bell), 1)
        self.assertIn("Issued", bell[0].title)
        # Someone else cannot download it.
        self.as_(PEER)
        self.assertEqual(self.client.get(f"/myhr/documents/{env_id}/download").status_code, 403)
        # Egnyte not connected: the pass settles it quietly.
        hl.process_filing()
        self.assertEqual(self.row(rid).filing_status, "skipped")

    def test_a_declined_signature_returns_the_letter_to_review(self):
        rid, env_id = self._issued()
        party = self.db.query(models.HrSignParty).filter_by(request_id=env_id, email=SIGNER).first()
        r = self.client.post(f"/esign/public/{party.token}/decline", json={"reason": "Wrong title"})
        self.assertEqual(r.status_code, 200, r.text)
        req = self.row(rid)
        self.assertEqual((req.status, req.sign_request_id), ("in_review", ""))
        self.assertIn("Wrong title", req.note)
        bell = self.db.query(models.NexusNotification).filter_by(ref_id=rid, recipient=HR).all()
        self.assertEqual(len(bell), 1)                            # the issuer's one bell for this request
        self.assertIn("Not Signed", bell[0].title)


if __name__ == "__main__":
    unittest.main()
