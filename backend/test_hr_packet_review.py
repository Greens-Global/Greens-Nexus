"""HR packets built from Documents - start, review, verify and send (Oct 14).

Start Hiring Packet -> the documents are generated at once from the
PUBLISHED templates -> only the verifier (whoever the packet's Verified By
role resolves to today) can Verify And Send -> one Nexus Sign envelope with
every field on the lines the templates drew -> the company signs, then the
candidate -> they are hired, and their details land on People.

Runs the REAL Nexus Sign engine (consent, one-time code, sealing) against
its own temporary database; mail and storage are local stand-ins.

    python -m pytest test_hr_packet_review.py
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
import hr_packet_docs as hpd  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import esign  # noqa: E402

D = "@greensglobal.com"
CO = "co-review"
HR = "charmi.hr" + D          # HR contact - verifies and signs for the company; Pay & Benefits
HR2 = "hal.hr" + D            # another HR writer with Pay & Benefits - not the verifier
PLAIN = "pat.people" + D      # People editor without Pay & Benefits
MGR = "max.mgr" + D
CAND = "jane.doe@gmail.com"


def _doc(*nodes):
    return {"pages": [{"id": "p1", "json": {"type": "doc", "content": list(nodes)}}]}


def _p(*parts):
    return {"type": "paragraph", "content": [
        {"type": "mergeField", "attrs": {"token": x[2:-2]}} if x.startswith("{{") else {"type": "text", "text": x}
        for x in parts]}


def _sig(role):
    return {"type": "signatureBlock", "attrs": {"role": role}}


OFFER = _doc(_p("Dear ", "{{first_name}}", " ", "{{last_name}}", ","),
             _p("Role: ", "{{job_title}}", ". Pay: ", "{{salary}}", ". Hours: ", "{{work_schedule}}", "."),
             _p("Start: ", "{{start_date}}", ". Address on file: ", "{{address}}", "."),
             _p("Sincerely, ", "{{signer.company}}"), _sig("company"), _sig("employee"))
NDA = _doc(_p("Confidentiality for ", "{{full_name}}", "."), _sig("employee"))


class ReviewCase(unittest.TestCase):
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
                  models.HrSignEvent, models.HrCandidate, models.HrStageEvent, models.NexusEmployee,
                  models.HrEntity, models.HrDocument, models.NexusNotification, models.NexusRole,
                  models.NexusGroup, models.NexusGroupMember, models.HrChecklist, models.HrChecklistItem,
                  models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens Test", legal_name="Greens Test, LLC", hr_contact_email=HR))
        for email, first, last in ((HR, "Charmi", "Shah"), (HR2, "Hal", "Hr"), (PLAIN, "Pat", "People"),
                                   (MGR, "Max", "Mgr")):
            self.db.add(models.NexusEmployee(id=f"e-{first}", work_email=email, first_name=first, last_name=last,
                                             company=CO, status="active", job_title=f"{first} Title",
                                             employee_code=f"GG-00{len(first)}"))
        self.db.add(models.NexusGroup(id="g-comp", name="People + Pay", allowed_modules="hr:editor,hr_comp:viewer"))
        self.db.add(models.NexusGroup(id="g-hr", name="People", allowed_modules="hr:editor"))
        for em in (HR, HR2):
            self.db.add(models.NexusGroupMember(group_id="g-comp", email=em))
        self.db.add(models.NexusGroupMember(group_id="g-hr", email=PLAIN))
        meta = {"fieldDefs": [], "signerRoles": [], "mergeOverrides": {}, "letterheadId": "", "requiresLetterhead": False}
        for tid, name, content in (("t-offer", "Offer Letter", OFFER), ("t-nda", "NDA", NDA)):
            self.db.add(models.DocTemplate(id=tid, name=name, category="hr", status="active", version=1,
                                           content=content, department="", published_version=1, published_meta=meta))
            self.db.add(models.DocTemplateVersion(id=f"v-{tid}", template_id=tid, version_no=1, content=content))
        self.db.add(models.HrPacketSetting(
            id="s-hire", entity_id=CO, event="hire", worker_type="any", engine="documents", template_id="",
            name="Analyst Hiring", doc_template_ids=["t-offer", "t-nda"], subject_role="employee",
            flow=[{"key": "company", "role": "hr", "action": "sign"},
                  {"key": "employee", "role": "employee", "action": "sign"}],
            verify_role="hr", email_message="Welcome!"))
        self.db.add(models.HrCandidate(id="cand-1", first_name="Jen", last_name="Doe", email=CAND, role_title="Analyst",
                                       department="Accounting", stage="offer", company=CO, created_by=HR,
                                       created_at="2026-10-01T00:00:00"))
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

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)
        self.db.close()

    # ── helpers ────────────────────────────────────────────────────────────
    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who

    def _start(self, **kw):
        body = {"inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28",
                           "manager_email": MGR, "employment_type": "full_time",
                           "work_start": "09:00", "work_end": "17:30", "work_days": ["mon", "tue", "wed", "thu", "fri"]},
                "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"},
                "details": {"first_name": "Jane", "last_name": "Doe", "phone": "555-0100",
                            "address": "12 Pine St, Springfield", "emergency_name": "John Doe",
                            "emergency_relationship": "Brother", "emergency_phone": "555-0101"}}
        body.update(kw)
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _review(self, eid):
        r = self.client.get(f"/hr/life-events/{eid}/review")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _verify(self, eid, review=None, **kw):
        review = review or self._review(eid)
        return self.client.post(f"/hr/life-events/{eid}/verify-and-send",
                                json={"excluded_ack": True, "seen": review["seen"], **kw})

    def _party(self, rid, email):
        self.db.expire_all()
        return self.db.query(models.HrSignParty).filter_by(request_id=rid, email=email).first()

    def _sign(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 1, "pages_total": 1})
        self.assertEqual(r.status_code, 200, r.text)

    def _ev(self, eid):
        self.db.expire_all()
        return self.db.query(models.HrLifeEvent).filter_by(id=eid).first()

    def _publish_new_offer(self):
        db = database.SessionLocal()
        t = db.query(models.DocTemplate).filter_by(id="t-offer").first()
        content = _doc(_p("Dear ", "{{first_name}}", ", NEW WORDING."), _sig("company"), _sig("employee"))
        t.content, t.version, t.published_version = content, 2, 2
        db.add(models.DocTemplateVersion(id="v-offer-2", template_id="t-offer", version_no=2, content=content))
        db.commit()
        db.close()


class JourneyTests(ReviewCase):
    def test_start_review_verify_sign_hire(self):
        ev = self._start()
        self.assertEqual(ev["status"], "review")
        eid = ev["id"]
        rows = self.db.query(models.Document).filter_by(life_event_id=eid).all()
        self.assertEqual(sorted(r.title for r in rows), ["NDA - Jane Doe", "Offer Letter - Jane Doe"])
        for r in rows:
            self.assertEqual((r.source, r.status, r.candidate_id, r.template_version), ("hr-packet", "final", "cand-1", 1))
            self.assertNotIn("salary", r.merge_overrides)               # pay is never stored on a document
            self.assertEqual(self.client.get(f"/documents/{r.id}").status_code, 404)   # not through Documents
        # the verifier was asked
        self.assertTrue(self.db.query(models.NexusNotification).filter(
            models.NexusNotification.recipient == HR, models.NexusNotification.title.like("Ready to Verify%")).first())
        review = self._review(eid)
        self.assertTrue(review["canVerify"], review["problems"])
        self.assertEqual(review["problems"], [])
        # The person signs first, the company countersigns (Neil, Oct 22 2026).
        self.assertEqual([r["name"] for r in review["recipients"]], ["Jane Doe", "Charmi Shah"])
        self.assertEqual(review["payText"], "$85,000.00 per year")
        pdf = self.client.get(f"/hr/life-events/{eid}/documents/{review['documents'][0]['documentId']}/pdf")
        self.assertEqual(pdf.status_code, 200)

        r = self._verify(eid, review)
        self.assertEqual(r.status_code, 200, r.text)
        ev = self._ev(eid)
        self.assertEqual(ev.status, "sent")                  # nobody signs for the company at send
        self.assertEqual(ev.verified_by, HR)
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()
        self.assertEqual((req.link_kind, req.link_id, req.prints_pay, req.document_class), ("life_event", eid, 1, "employment"))
        fields = list(req.fields or []) + [f for d in (req.documents or []) for f in (d.get("fields") or [])]
        self.assertEqual({f["role"] for f in fields}, {"company", "employee"})
        self.assertEqual(len({f["id"] for f in fields}), len(fields))          # ids unique across documents
        self.assertEqual(self.invited, [CAND])                                # the person is invited first
        self.assertEqual(r.json()["senderPartyId"], "")                       # HR has nothing to sign yet
        self.assertEqual(self._party(req.id, HR).status, "waiting")

        self._sign(self._party(req.id, CAND))
        self.assertEqual(self._ev(eid).status, "sent")
        self.assertEqual(self.invited, [CAND, HR])                            # then the company countersigns
        self._sign(self._party(req.id, HR))
        ev = self._ev(eid)
        self.assertEqual(ev.status, "completed", ev.apply_note)
        cand = self.db.query(models.HrCandidate).filter_by(id="cand-1").first()
        self.assertEqual(cand.stage, "hired")
        emp = self.db.query(models.NexusEmployee).filter_by(id=cand.employee_id).first()
        self.assertEqual((emp.first_name, emp.job_title, emp.start_date, emp.phone),
                         ("Jane", "Analyst", "2030-11-02", "555-0100"))
        self.assertEqual(emp.personal["currentAddress"], "12 Pine St, Springfield")
        self.assertEqual(emp.personal["emergency"]["name"], "John Doe")
        self.assertEqual(emp.compensation["base"], round(85000 / 12, 2))
        self.assertEqual({r.employee_id for r in self.db.query(models.Document).filter_by(life_event_id=eid)}, {emp.id})
        self.assertTrue(self.db.query(models.HrChecklist).filter_by(employee_id=emp.id, kind="onboarding").first())


class VerifierTests(ReviewCase):
    def test_only_the_resolved_verifier_can_send(self):
        eid = self._start()["id"]
        self._as(HR2)
        review = self._review(eid)
        self.assertFalse(review["canVerify"])
        self.assertEqual(review["verifier"]["email"], HR)
        r = self._verify(eid, review)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("Only Charmi Shah", r.text)
        # changing the company's HR contact moves the verifier
        db = database.SessionLocal()
        db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": HR2})
        db.commit()
        db.close()
        # ...and the company signer's printed name ({{signer.company}}) with
        # it: the unsent documents regenerate, so what was reviewed is stale.
        stale = review
        self.assertEqual(self._verify(eid, stale).status_code, 409)
        fresh = self._review(eid)
        self.assertEqual(fresh["verifier"]["email"], HR2)
        self.assertEqual(self._verify(eid, fresh).status_code, 200)

    def test_a_verifier_without_pay_access_is_a_blocking_problem(self):
        db = database.SessionLocal()
        db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": PLAIN})
        db.commit()
        db.close()
        eid = self._start()["id"]
        self._as(PLAIN)
        review = self._review(eid)
        self.assertFalse(review["canVerify"])
        self.assertNotIn("pay", review)
        self.assertTrue(any("cannot see pay" in p for p in review["problems"]), review["problems"])
        self.assertEqual(self._verify(eid, review).status_code, 403)


class DynamicTests(ReviewCase):
    def test_a_publish_regenerates_and_a_stale_verify_is_refused(self):
        eid = self._start()["id"]
        stale = self._review(eid)
        self._publish_new_offer()
        review = self._review(eid)
        self.assertTrue(review["outdated"])
        self.assertFalse(review["canVerify"])
        before = self.db.query(models.Document).filter_by(life_event_id=eid).count()
        self.assertEqual(self._verify(eid, stale).status_code, 409)           # regenerates, then refuses
        after = self._review(eid)
        self.assertFalse(after["outdated"])
        offer = next(d for d in after["documents"] if d["templateId"] == "t-offer")
        self.assertEqual((offer["templateVersion"], offer["version"]), (2, 2))
        self.assertEqual(self.db.query(models.Document).filter_by(life_event_id=eid).count(), before)
        self.assertEqual(self._verify(eid, after).status_code, 200)

    def test_regenerate_is_idempotent_and_reads_write_nothing(self):
        eid = self._start()["id"]
        self._publish_new_offer()
        for _ in range(2):
            self._review(eid)
        self.assertEqual(self._ev(eid).documents[0]["version"], 1)            # GET wrote nothing
        r1 = self.client.post(f"/hr/life-events/{eid}/regenerate").json()
        r2 = self.client.post(f"/hr/life-events/{eid}/regenerate").json()
        self.assertEqual(r1["seen"], r2["seen"])
        self.assertEqual(r2["documents"][0]["version"], 2)

    def test_autosaves_without_publish_change_nothing(self):
        eid = self._start()["id"]
        db = database.SessionLocal()
        t = db.query(models.DocTemplate).filter_by(id="t-offer").first()
        for i in range(20):
            t.version += 1
            t.content = _doc(_p(f"half typed {i}"))
            db.commit()
        db.close()
        review = self._review(eid)
        self.assertFalse(review["outdated"])
        self.assertEqual(self._verify(eid, review).status_code, 200)

    def test_editing_values_regenerates_but_never_changes_the_role(self):
        eid = self._start()["id"]
        r = self.client.patch(f"/hr/life-events/{eid}/values", json={"inputs": {"role_id": "other-role"}})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.patch(f"/hr/life-events/{eid}/values",
                              json={"details": {"first_name": "Janet", "last_name": "Doe"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["documents"][0]["version"], 2)
        self.assertEqual(self._ev(eid).subject_name, "Janet Doe")


class PayTests(ReviewCase):
    def test_text_only_pay_prints_and_is_flagged_for_pay_and_benefits(self):
        eid = self._start(pay=None, pay_values={"salary": "$22.00 per hour plus commission"})["id"]
        review = self._review(eid)
        self.assertEqual(review["payText"], "$22.00 per hour plus commission")
        for r in self.db.query(models.Document).filter_by(life_event_id=eid):
            self.assertNotIn("commission", str(r.merge_overrides))
        self.assertEqual(self._verify(eid, review).status_code, 200)
        req_id = self._ev(eid).sign_request_id
        self._sign(self._party(req_id, CAND))          # the person first (Neil, Oct 22 2026)
        self._sign(self._party(req_id, HR))
        ev = self._ev(eid)
        self.assertEqual(ev.status, "completed")
        self.assertTrue(any(f["code"] == "pay_not_recorded" for f in ev.flags))

    def test_pay_only_for_pay_and_benefits(self):
        self._as(PLAIN)
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json={
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28"},
            "pay_values": {"salary": "$1"}, "details": {"first_name": "Jane", "last_name": "Doe"}})
        self.assertEqual(r.status_code, 403, r.text)

    def test_a_non_comp_reader_cannot_open_a_pay_document(self):
        eid = self._start()["id"]
        did = self._review(eid)["documents"][0]["documentId"]
        self._as(PLAIN)
        self.assertEqual(self.client.get(f"/hr/life-events/{eid}/documents/{did}/pdf").status_code, 403)


class GuardTests(ReviewCase):
    def test_void_before_send_archives_and_sends_nothing(self):
        eid = self._start()["id"]
        r = self.client.post(f"/hr/life-events/{eid}/void")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._ev(eid).status, "voided")
        self.assertEqual({d.status for d in self.db.query(models.Document).filter_by(life_event_id=eid)}, {"archived"})
        self.assertEqual(self.db.query(models.HrSignRequest).count(), 0)

    def test_one_open_packet_per_candidate(self):
        self._start()
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json={
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28"},
            "details": {"first_name": "Jane", "last_name": "Doe"}})
        self.assertEqual(r.status_code, 409, r.text)

    def test_hr_records_lists_packet_documents_without_values(self):
        eid = self._start()["id"]
        rows = self.client.get("/hr/packet-documents").json()
        self.assertEqual(sorted(r["title"] for r in rows), ["NDA - Jane Doe", "Offer Letter - Jane Doe"])
        self.assertTrue(all(r["eventId"] == eid and r["status"] == "In Review" for r in rows))
        self.assertNotIn("85,000", str(rows))
        self.assertFalse(any(r["locked"] for r in rows))
        self._as(PLAIN)                                   # People editor without Pay & Benefits
        self.assertTrue(all(r["locked"] for r in self.client.get("/hr/packet-documents").json()))
        self._as(CAND)                                    # nobody in People
        self.assertEqual(self.client.get("/hr/packet-documents").status_code, 403)

    def test_status_at_send(self):
        hr = {"email": HR, "ordinal": 1, "partyRole": "signer"}
        cand = {"email": CAND, "ordinal": 2, "partyRole": "signer"}
        self.assertEqual(hpd.status_at_send([hr, cand], CAND), "awaiting_sender")
        self.assertEqual(hpd.status_at_send([{**cand, "ordinal": 1}], CAND), "sent")
        self.assertEqual(hpd.status_at_send([{**hr, "partyRole": "cc"}, cand], CAND), "sent")
        self.assertEqual(hpd.status_at_send([hr], "Jane.Doe@Gmail.com"), "awaiting_sender")    # never raises

    def test_a_stale_envelope_never_moves_the_event(self):
        eid = self._start()["id"]
        self.assertEqual(self._verify(eid).status_code, 200)
        ev = self._ev(eid)
        old = models.HrSignRequest(id="old-req", link_kind="life_event", link_id=eid)
        self.assertIsNone(hle._for(self.db, old))
        self.assertIsNotNone(hle._for(self.db, self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()))


if __name__ == "__main__":
    unittest.main()
