"""The offer letter, then the hiring packet (Neil and Charmi, Oct 14).

    "There is a document to sign, but it's a single document called an offer
    letter ... If they don't accept the offer letter, you don't send them a
    hiring packet."

Move To Offer -> HR answers (employee or contractor, where, the role, start,
pay, the letter's own questions) -> the ONE offer letter for that kind of
hire -> verified -> the candidate signs, the offer's only signer (no login) ->
hired -> the hiring packet starts by itself: the person gets a link to their
details form (no login), the documents fill themselves from it, they sign.
Runs the real Nexus Sign engine on the review tests' fixture.

    python -m pytest test_hr_offer.py
"""
import re
import time
import unittest

import database
import hr_life_events as hle
import models
import role_change as rc
from routers.documents import _clean_field_defs
from test_hr_packet_review import CAND, CO, HR, MGR, ReviewCase, _doc, _p, _sig

LETTER = _doc(_p("Dear ", "{{full_name}}", ", we offer you ", "{{job_title}}", " as an ", "{{worker_type}}", "."),
              _p("Pay: ", "{{salary}}", ". Location: ", "{{work_location}}", ". Probation: ", "{{probation_period}}", "."),
              _sig("company"), _sig("employee"))
INDIA = _doc(_p("Contract for ", "{{full_name}}", " - fee ", "{{salary}}", "."), _sig("company"), _sig("employee"))
INTAKE_DOC = _doc(_p("Name ", "{{full_name}}", " PAN ", "{{pan_number}}", " Address ", "{{address}}", "."), _sig("company"),
                  _sig("employee"))
PROBATION = {"token": "probation_period", "label": "Probation Period", "type": "text", "source": "hr"}
PAN = {"token": "pan_number", "label": "PAN Number", "type": "text", "source": "person", "sensitive": True,
       "required": True}


def _tpl(db, tid, name, content, defs=(), category="offer_letter"):
    meta = {"fieldDefs": _clean_field_defs(list(defs)), "signerRoles": [], "mergeOverrides": {}, "letterheadId": "",
            "requiresLetterhead": False}
    db.add(models.DocTemplate(id=tid, name=name, category=category, status="active", version=1, content=content,
                              department="", published_version=1, published_meta=meta))
    db.add(models.DocTemplateVersion(id=f"v-{tid}", template_id=tid, version_no=1, content=content))


def _setting(db, sid, event, name, docs, worker_type="any", country=""):
    db.add(models.HrPacketSetting(
        id=sid, entity_id=CO, event=event, worker_type=worker_type, country=country, engine="documents",
        template_id="", name=name, doc_template_ids=docs, subject_role="employee",
        flow=[{"key": "company", "role": "hr", "action": "sign"}, {"key": "employee", "role": "employee", "action": "sign"}],
        verify_role="hr"))


class OfferCase(ReviewCase):
    def setUp(self):
        super().setUp()
        db = database.SessionLocal()
        db.query(models.HrEntity).filter_by(id=CO).update({"country": "US"})
        _tpl(db, "t-letter", "Offer Of Employment", LETTER, [PROBATION])
        _tpl(db, "t-india", "India Contractor Offer", INDIA)
        _tpl(db, "t-intake", "Onboarding Requirements", INTAKE_DOC, [PAN], category="hr")
        # The job description goes out after the offer letter (Neil, 11/03/2026).
        _tpl(db, "t-jd", "Job Description", _doc(_p("Duties: ", "{{role_description}}")), category="job_description")
        _setting(db, "s-offer", "offer", "US Employee Offer", ["t-letter"], worker_type="employee", country="US")
        _setting(db, "s-offer-in", "offer", "India Contractor Offer", ["t-india"], worker_type="contractor", country="IN")
        db.query(models.HrPacketSetting).filter_by(id="s-hire").update({"doc_template_ids": ["t-intake"]})
        db.query(models.HrCandidate).filter_by(id="cand-1").update({"stage": "interview"})
        db.commit()
        db.close()
        self.mails = []
        self._send = rc.send_emails
        rc.send_emails = lambda batch: self.mails.extend(batch)

    def tearDown(self):
        rc.send_emails = self._send
        super().tearDown()

    def _offer(self, **inputs):
        body = {"inputs": {"worker_type": "employee", "employment_type": "full_time", "job_title": "Analyst",
                           "start_date": "2030-11-02", "offer_expires": "2030-10-28", "manager_email": MGR,
                           "work_location": "Irvine, CA", "merge": {"probation_period": "90 days"},
                           "jd_template_id": "t-jd", "new_role_duties": "Reconciles accounts.", **inputs},
                "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"}}
        return self.client.post("/hr/candidates/cand-1/offer/start", json=body)

    def _send_and_sign(self, eid):
        review = self._review(eid)
        self.assertTrue(review["canVerify"], review["problems"])
        r = self._verify(eid, review)
        self.assertEqual(r.status_code, 200, r.text)
        req = self._ev(eid).sign_request_id
        # The person signs first; the company countersigns a hiring packet
        # after them and never signs an offer at all (Neil, Oct 22 2026).
        self._sign(self._party(req, CAND))
        if self._ev(eid).kind != "offer":
            self._sign(self._party(req, HR))

    def _wait_for_mail(self):
        for _ in range(50):
            if self.mails:
                return self.mails[-1]
            time.sleep(0.1)
        self.fail("no email was sent")


class OptionsTests(OfferCase):
    def test_the_letter_follows_employee_or_contractor_and_country(self):
        base = "/hr/candidates/cand-1/offer/options"
        none = self.client.get(base).json()
        self.assertIsNone(none["offerLetter"])                 # HR answers first - never guessed
        self.assertEqual(none["country"], "US")
        emp = self.client.get(base, params={"worker_type": "employee"}).json()
        self.assertEqual(emp["offerLetter"]["name"], "US Employee Offer")
        self.assertEqual([q["token"] for q in emp["offerLetter"]["hrQuestions"]], ["probation_period"])
        self.assertIn("work_location", emp["offerLetter"]["prints"])
        self.assertEqual(emp["hiringPacket"]["name"], "Analyst Hiring")
        self.assertEqual(emp["hiringPacket"]["personQuestions"], ["PAN Number"])
        us_contractor = self.client.get(base, params={"worker_type": "contractor"}).json()
        self.assertIsNone(us_contractor["offerLetter"])
        self.assertIn("No offer letter is set up for a Contractor in United States", us_contractor["missing"])
        india = self.client.get(base, params={"worker_type": "contractor", "country": "IN"}).json()
        self.assertEqual(india["offerLetter"]["name"], "India Contractor Offer")

    def test_an_uploaded_pdf_packet_never_follows_an_offer(self):
        # it cannot start by itself - the Documents packet is picked instead
        db = database.SessionLocal()
        db.add(models.HrPacketSetting(id="s-old-pdf", entity_id=CO, event="hire", worker_type="any", engine="pdf",
                                      template_id="old-tpl", name="", role_ids=[], subject_role="employee"))
        db.query(models.HrCandidate).filter_by(id="cand-1").update({"role_id": ""})
        db.commit()
        db.close()
        opts = self.client.get("/hr/candidates/cand-1/offer/options", params={"worker_type": "employee"}).json()
        self.assertEqual(opts["hiringPacket"]["name"], "Analyst Hiring")

    def test_hr_must_say_employee_or_contractor(self):
        r = self._offer(worker_type="")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Employee or a Contractor", r.json()["detail"])

    def test_the_old_packet_send_waits_for_the_offer(self):
        db = database.SessionLocal()
        db.query(models.HrCandidate).filter_by(id="cand-1").update({"stage": "offer"})
        db.commit()
        db.close()
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json={
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28",
                       "employment_type": "full_time"},
            "details": {"first_name": "Jane", "last_name": "Doe", "phone": "1", "address": "x"}})
        self.assertEqual(r.status_code, 409)
        self.assertIn("Send the offer letter first", r.json()["detail"])


class JourneyTests(OfferCase):
    def test_an_offer_is_signed_by_the_candidate_only(self):
        """Neil, Oct 22 2026: "Offer is just saying, do you accept?" - an old
        company-first config with a saved HR signature (Signs Once) still
        sends the candidate as the ONE signer: no company party, nothing
        preset, and the letter's company block draws no field."""
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).filter_by(id="s-offer").update({
            "flow": [{"key": "company", "role": "hr", "action": "sign", "once": True},
                     {"key": "employee", "role": "employee", "action": "sign"}],
            "saved_signatures": [{"step": "company", "role": "hr", "entityId": CO, "email": HR, "name": "Charmi Shah",
                                  "kind": "typed", "data": "HR Saved", "adoptedAt": "2026-10-01T00:00:00+00:00",
                                  "replacedAt": ""}]})
        db.commit()
        db.close()
        offer = self._offer().json()
        review = self._review(offer["id"])
        self.assertEqual([r["email"] for r in review["recipients"]], [CAND])
        self.assertEqual(review["signOnce"], [])
        r = self._verify(offer["id"], review)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["senderPartyId"], "")
        ev = self._ev(offer["id"])
        self.assertEqual(ev.status, "sent")
        parties = self.db.query(models.HrSignParty).filter_by(request_id=ev.sign_request_id).all()
        self.assertEqual([(p.email, p.party_role, p.auth_method or "") for p in parties], [(CAND, "signer", "")])
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()
        fields = list(req.fields or []) + [f for d in (req.documents or []) for f in (d.get("fields") or [])]
        self.assertEqual({f["role"] for f in fields}, {"employee"})
        self.assertEqual(self.invited, [CAND])
        self._sign(self._party(ev.sign_request_id, CAND))
        self.assertEqual(self._ev(offer["id"]).status, "completed", self._ev(offer["id"]).apply_note)

    def test_offer_signed_hires_them_and_the_packet_follows_with_no_login(self):
        r = self._offer()
        self.assertEqual(r.status_code, 200, r.text)
        offer = r.json()
        self.assertEqual((offer["kind"], offer["status"]), ("offer", "review"))
        cand = self.db.query(models.HrCandidate).filter_by(id="cand-1").first()
        self.assertEqual(cand.stage, "offer")                  # Move To Offer moves them
        row = self.db.query(models.Document).filter_by(life_event_id=offer["id"], template_id="t-letter").one()
        self.assertEqual(row.merge_overrides["work_location"], "Irvine, CA")
        self.assertEqual(row.merge_overrides["worker_type"], "Employee")
        self.assertEqual(row.merge_overrides["probation_period"], "90 days")
        self.assertNotIn("salary", row.merge_overrides)

        self._send_and_sign(offer["id"])
        ev = self._ev(offer["id"])
        self.assertEqual(ev.status, "completed", ev.apply_note)
        # ONE document: the letter, the job description after it, then the tick box the candidate ticked.
        req = self.db.query(models.HrSignRequest).filter_by(id=ev.sign_request_id).first()
        self.assertEqual(req.documents or [], [])
        ack = [f for f in req.fields or [] if f["type"] == "check"]
        self.assertEqual([(f["label"], f["role"], f["required"]) for f in ack],
                         [("I have read the job description", "employee", True)])
        self.db.expire_all()
        cand = self.db.query(models.HrCandidate).filter_by(id="cand-1").first()
        self.assertEqual(cand.stage, "hired")                  # the signed offer is the hire
        emp = self.db.query(models.NexusEmployee).filter_by(id=cand.employee_id).one()
        self.assertEqual((emp.status, emp.job_title), ("onboarding", "Analyst"))

        # the hiring packet started by itself and emailed a no-login link
        packet = self.db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1", kind="hire").one()
        self.assertEqual((packet.status, packet.employee_id), ("intake", emp.id))
        self.assertTrue(packet.inputs["after_offer"])
        to, subject, html = self._wait_for_mail()
        self.assertEqual(to, CAND)
        self.assertIn("onboarding paperwork", html)
        token = re.search(r"/intake/([A-Za-z0-9_\-]+)", html).group(1)
        self.assertEqual(hle.intake_by_token(self.db, token).id, packet.id)

        # the person fills their details - the documents' own question included
        page = self.client.get(f"/hr/intake/public/{token}").json()
        self.assertEqual([f["key"] for f in page["form"]], ["pan_number"])
        self.assertTrue(page["form"][0]["sensitive"])
        self.assertTrue(page["afterOffer"])
        self.assertEqual(page["prefill"]["first_name"], "Jen")          # what the offer already knew
        self.assertNotIn("salary", str(page))                            # never pay
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {
            "first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
            "answers": {"pan_number": "ABCDE1234F"}}})
        self.assertEqual(r.status_code, 200, r.text)
        # Submit And Continue (Pranshu, 11/04/2026): the packet opens for signing at once - no HR
        # stop, no second email - and the page carries them straight to it.
        self.invited.clear()
        ev = self._ev(packet.id)
        self.assertEqual(ev.status, "sent")
        self.assertIn("/sign/", r.json()["signUrl"])
        self.assertNotIn(CAND, self.invited)
        self.assertEqual(self.client.get(f"/hr/intake/public/{token}").json()["signUrl"], r.json()["signUrl"])   # back on the link
        self._sign(self._party(ev.sign_request_id, CAND))
        self._sign(self._party(ev.sign_request_id, HR))          # the company countersigns after them
        self.assertEqual(self.client.get(f"/hr/intake/public/{token}").json()["signUrl"], "")    # nothing left to sign
        packet = self._ev(packet.id)
        self.assertEqual(packet.status, "completed", packet.apply_note)
        # the checklist ticks itself: offer signed, then the pre-boarding packet
        import hr_checklists as hc
        self.db.expire_all()
        emp_row = self.db.query(models.NexusEmployee).filter_by(id=emp.id).one()
        cl = self.db.query(models.HrChecklist).filter_by(employee_id=emp.id, kind="onboarding").one()
        hc.sync(self.db, cl, emp_row)
        self.db.commit()
        done = {i.key: i.status for i in self.db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id)}
        self.assertEqual((done.get("ON-02"), done.get("ON-04")), ("done", "done"))
        self.assertIn("paperwork is complete", packet.apply_note)
        self.db.expire_all()
        emp = self.db.query(models.NexusEmployee).filter_by(id=emp.id).one()
        self.assertEqual(emp.personal["currentAddress"], "12 Pine St")
        # still one person, still hired
        self.assertEqual(self.db.query(models.NexusEmployee).filter_by(personal_email=CAND).count()
                         + self.db.query(models.NexusEmployee).filter_by(work_email=CAND).count(), 1)

    def test_no_offer_goes_out_with_no_hiring_packet_to_follow_it(self):
        """Neil, Oct 22: a hire who signs and then waits on paperwork nobody set
        up is the failure to prevent - the offer is refused up front, saying
        what is missing and where to set it up."""
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).filter_by(id="s-hire").delete()
        db.commit()
        db.close()
        r = self._offer()
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("No hiring packet is set up", r.json()["detail"])
        self.assertIn("before sending the offer", r.json()["detail"])

    def test_a_missing_packet_never_undoes_the_hire_and_hr_can_start_it_later(self):
        offer = self._offer().json()
        # The packet goes away after the offer went out (removed, or changed).
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).filter_by(id="s-hire").delete()
        db.commit()
        db.close()
        self._send_and_sign(offer["id"])
        ev = self._ev(offer["id"])
        self.assertEqual(ev.status, "completed")
        self.assertIn("packet_not_started", [f["code"] for f in ev.flags])
        self.db.expire_all()
        self.assertEqual(self.db.query(models.HrCandidate).filter_by(id="cand-1").one().stage, "hired")
        # HR sets the packet up, then starts it from the card
        db = database.SessionLocal()
        _setting(db, "s-hire-2", "hire", "Analyst Hiring", ["t-intake"])
        db.commit()
        db.close()
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/after-offer")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "intake")
        self.assertIn("/intake/", r.json()["intakeUrl"])
        self.assertNotIn("packet_not_started", [f["code"] for f in self._ev(offer["id"]).flags])

    def test_one_open_offer_and_no_reject_under_it(self):
        eid = self._offer().json()["id"]
        self.assertEqual(self._offer().status_code, 409)
        r = self.client.patch("/hr/candidates/cand-1", json={"stage": "rejected"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("offer letter", r.json()["detail"])
        self.assertEqual(self.client.post(f"/hr/life-events/{eid}/void").status_code, 200)
        self.assertEqual(self._ev(eid).status, "voided")


class ReviewFixTests(OfferCase):
    """The holes a cold review found (Oct 14)."""

    def test_a_roles_own_letter_still_follows_employee_or_contractor(self):
        db = database.SessionLocal()
        cand = db.query(models.HrCandidate).filter_by(id="cand-1").one()
        cand.role_id = "role-x"
        db.add(models.NexusGroup(id="role-x", name="Analyst", department="Accounting", is_job_role=1, company_id=CO))
        _setting(db, "s-role-con", "offer", "Analyst Contractor Letter", ["t-india"], worker_type="contractor")
        db.flush()
        db.query(models.HrPacketSetting).filter_by(id="s-role-con").update({"role_ids": ["role-x"]})
        db.commit()
        db.close()
        base = "/hr/candidates/cand-1/offer/options"
        self.assertEqual(self.client.get(base, params={"worker_type": "employee"}).json()["offerLetter"]["name"],
                         "US Employee Offer")
        self.assertEqual(self.client.get(base, params={"worker_type": "contractor"}).json()["offerLetter"]["name"],
                         "Analyst Contractor Letter")
        # "Other (a new role)" never falls back to the card's role
        other = self.client.get(base, params={"worker_type": "contractor", "new_role": "1"}).json()
        self.assertIsNone(other["offerLetter"])

    def test_a_voided_packet_starts_again_and_an_old_date_never_strands_it(self):
        offer = self._offer().json()
        self._send_and_sign(offer["id"])
        packet = self.db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1", kind="hire").one()
        db = database.SessionLocal()
        row = db.query(models.HrLifeEvent).filter_by(id=packet.id).one()
        row.inputs = {**row.inputs, "due_on": "2020-01-01"}
        db.commit()
        db.close()
        r = self.client.post(f"/hr/life-events/{packet.id}/reopen-intake")
        self.assertEqual(r.status_code, 200, r.text)                 # refreshed, not refused
        self.assertGreater(self._ev(packet.id).inputs["due_on"], "2026-01-01")
        self.assertEqual(self.client.post(f"/hr/life-events/{packet.id}/void").status_code, 200)
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/after-offer")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotEqual(r.json()["id"], packet.id)
        self.assertEqual(r.json()["status"], "intake")

    def test_editing_an_offers_pay_keeps_the_packets_pay_questions(self):
        db = database.SessionLocal()
        fee = _doc(_p("Monthly fee ", "{{monthly_fee}}", " for ", "{{full_name}}"), _sig("company"), _sig("employee"))
        _tpl(db, "t-fee", "Fee Schedule", fee, [{"token": "monthly_fee", "label": "Monthly Fee", "type": "text",
                                                  "source": "hr", "pay": True}], category="hr")
        db.query(models.HrPacketSetting).filter_by(id="s-hire").update({"doc_template_ids": ["t-intake", "t-fee"]})
        db.commit()
        db.close()
        r = self._offer()
        self.assertEqual(r.status_code, 200, r.text)
        eid = r.json()["id"]
        db = database.SessionLocal()
        db.query(models.HrLifeEvent).filter_by(id=eid).update({"pay_values": {"monthly_fee": "$5,000"}})
        db.commit()
        db.close()
        r = self.client.patch(f"/hr/life-events/{eid}/values",
                              json={"pay_values": {"monthly_fee": "$5,500", "salary": "$85,000 per year"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._ev(eid).pay_values["monthly_fee"], "$5,500")
        # and pay never rides in HR's plain answers
        db = database.SessionLocal()
        db.query(models.HrLifeEvent).filter_by(id=eid).update({"status": "voided"})
        db.commit()
        db.close()
        r = self._offer(merge={"probation_period": "90 days", "monthly_fee": "$1"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("is pay", r.json()["detail"])

    def test_the_role_from_the_offer_is_applied_when_the_work_email_lands(self):
        from routers.hr import adopt_pending_role
        db = database.SessionLocal()
        db.add(models.NexusGroup(id="role-y", name="Analyst", department="Accounting", is_job_role=1, company_id=CO,
                                 job_description="Reconciles accounts."))
        db.query(models.HrCandidate).filter_by(id="cand-1").update({"role_id": "role-y"})
        db.commit()
        db.close()
        offer = self._offer(role_id="role-y").json()
        self._send_and_sign(offer["id"])
        self.db.expire_all()
        emp = self.db.query(models.NexusEmployee).filter_by(
            id=self.db.query(models.HrCandidate).filter_by(id="cand-1").one().employee_id).one()
        emp.work_email = "jane.new@greensglobal.com"
        adopt_pending_role(self.db, emp, HR)
        self.db.commit()
        self.assertTrue(self.db.query(models.NexusGroupMember).filter_by(group_id="role-y", email="jane.new@greensglobal.com").first())

    def test_no_mark_hired_by_hand_under_an_open_offer(self):
        self._offer()
        r = self.client.patch("/hr/candidates/cand-1", json={"stage": "hired"})
        self.assertEqual(r.status_code, 409)


class BuildingBlockTests(OfferCase):
    """One packet per kind of hire; the team's own NDA is added for the person
    (Neil: "there's a different confidentiality agreement for each team")."""

    def _blocks(self, rows):
        hire = next(s for s in self.client.get("/hr/packets").json()["settings"] if s["id"] == "s-hire")
        return self.client.put("/hr/packets/documents", json={
            "id": "s-hire", "entity_id": CO, "event": "hire", "name": hire["name"], "doc_template_ids": ["t-intake"],
            "flow": hire["flow"], "verify_role": "hr", "extra_docs": rows, "country": hire["country"] or "US"})

    def test_the_teams_document_joins_the_packet_for_that_team_only(self):
        db = database.SessionLocal()
        _tpl(db, "t-ca-acct", "Accounting CA", _doc(_p("CA for ", "{{full_name}}"), _sig("employee")), category="hr")
        _tpl(db, "t-ca-it", "IT CA", _doc(_p("IT CA for ", "{{full_name}}"), _sig("employee")), category="hr")
        db.commit()
        db.close()
        r = self._blocks([{"match": "department", "value": "Accounting", "templateIds": ["t-ca-acct"]},
                          {"match": "department", "value": "IT", "templateIds": ["t-ca-it"]}])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([x["templateNames"] for x in r.json()["extraDocs"]], [["Accounting CA"], ["IT CA"]])
        self.assertEqual(self._blocks([{"match": "department", "value": "IT", "templateIds": []}]).status_code, 400)

        offer = self._offer().json()                         # an Analyst - in Accounting
        self._send_and_sign(offer["id"])
        packet = self.db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1", kind="hire").one()
        token = re.search(r"/intake/([A-Za-z0-9_\-]+)", self._wait_for_mail()[2]).group(1)
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {
            "first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
            "answers": {"pan_number": "ABCDE1234F"}}})
        self.assertEqual(r.status_code, 200, r.text)
        titles = sorted(d.title for d in self.db.query(models.Document).filter_by(life_event_id=packet.id))
        self.assertEqual(titles, ["Accounting CA - Jane Doe", "Onboarding Requirements - Jane Doe"])



class PreviewTests(OfferCase):
    """Preview before Create (Neil, 11/04/2026): the letter and its job
    description as Create would make them - and nothing is kept."""

    def _preview(self):
        body = {"inputs": {"worker_type": "employee", "employment_type": "full_time", "job_title": "Analyst",
                           "start_date": "2030-11-02", "offer_expires": "2030-10-28", "manager_email": MGR,
                           "work_location": "Irvine, CA", "merge": {"probation_period": "90 days"},
                           "jd_template_id": "t-jd", "new_role_duties": "Reconciles accounts.",
                           "work_start": "09:00", "work_end": "17:00"},
                "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"}}
        return self.client.post("/hr/candidates/cand-1/offer/preview", json=body)

    def test_preview_is_the_letter_then_the_job_description_and_saves_nothing(self):
        import base64
        import io
        from pypdf import PdfReader
        r = self._preview()
        self.assertEqual(r.status_code, 200, r.text)
        pdf = base64.b64decode(r.json()["pdf"])
        self.assertTrue(pdf.startswith(b"%PDF"))
        text = "".join(pg.extract_text() or "" for pg in PdfReader(io.BytesIO(pdf)).pages)
        self.assertIn("Analyst", text)                            # the letter, filled in
        self.assertIn("Reconciles accounts", text)                # the job description follows the letter
        self.assertIn("Job Description Acknowledgment", text)     # then its read-it page
        self.assertEqual(r.json()["unfilled"], [])
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1").count(), 0)
            self.assertEqual(db.query(models.Document).filter(models.Document.candidate_id == "cand-1").count(), 0)
            self.assertEqual(db.query(models.HrCandidate).filter_by(id="cand-1").one().stage, "interview")
            self.assertEqual(db.query(models.NexusNotification).count(), self._bells_before)
        finally:
            db.close()
        self.assertEqual(self._offer().status_code, 200)          # Create still works after a preview

    def setUp(self):
        super().setUp()
        db = database.SessionLocal()
        self._bells_before = db.query(models.NexusNotification).count()
        db.close()



class InPersonTests(OfferCase):
    """Print And Send (Pranshu / Neil, 11/04/2026): "I'm hiring that employee
    manually, like face to face, not through the electronic signature"."""

    def test_print_and_send_emails_nobody_and_the_uploaded_copy_hires_them(self):
        r = self._offer()
        self.assertEqual(r.status_code, 200, r.text)
        eid = r.json()["id"]
        self.invited.clear()
        r = self._verify(eid, self._review(eid), in_person=True)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn(CAND, self.invited)                         # not emailed
        ev = self._ev(eid)
        self.assertTrue(ev.inputs.get("in_person"))
        log = self.db.query(models.HrSignEvent).filter_by(request_id=ev.sign_request_id).all()
        self.assertFalse([e for e in log if e.type == "sent"])       # so the automatic chase never emails them
        printed = self.client.get(f"/hr/life-events/{eid}/print")
        self.assertEqual(printed.status_code, 200, printed.text)
        self.assertTrue(printed.content.startswith(b"%PDF"))
        up = self.client.post(f"/hr/life-events/{eid}/signed-in-person",
                              files={"file": ("signed.pdf", printed.content, "application/pdf")})
        self.assertEqual(up.status_code, 200, up.text)
        ev = self._ev(eid)
        self.assertEqual(ev.status, "completed")
        self.assertTrue(ev.employee_id)                              # hired, the same as an e-signed offer
        party = self._party(ev.sign_request_id, CAND)
        self.assertEqual((party.status, party.signature_kind), ("signed", "paper"))
        again = self.client.post(f"/hr/life-events/{eid}/signed-in-person",
                                 files={"file": ("signed.pdf", printed.content, "application/pdf")})
        self.assertEqual(again.status_code, 409)

    def test_an_electronic_offer_has_nothing_to_print(self):
        eid = self._offer().json()["id"]
        self.assertEqual(self._verify(eid, self._review(eid)).status_code, 200)
        self.assertIn(CAND, self.invited)
        self.assertEqual(self.client.get(f"/hr/life-events/{eid}/print").status_code, 409)



class SubmitAndContinueTests(OfferCase):
    """Submit And Continue (Pranshu, 11/04/2026) never skips what HR's check
    would stop on: a Signs Once nobody adopted keeps the packet for review."""

    def test_a_packet_hr_must_still_finish_waits_for_review(self):
        db = database.SessionLocal()
        db.query(models.HrPacketSetting).filter_by(id="s-hire").update({"flow": [
            {"key": "company", "role": "hr", "action": "sign", "once": True},
            {"key": "employee", "role": "employee", "action": "sign"}]})
        db.commit()
        db.close()
        offer = self._offer().json()
        self._send_and_sign(offer["id"])
        html = self._wait_for_mail()[2]
        token = re.search(r"/intake/([A-Za-z0-9_\-]+)", html).group(1)
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {
            "first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
            "answers": {"pan_number": "ABCDE1234F"}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["signUrl"], "")
        packet = self.db.query(models.HrLifeEvent).filter_by(candidate_id="cand-1", kind="hire").one()
        self.assertEqual(self._ev(packet.id).status, "review")
        self.assertTrue(self._ev(packet.id).intake.get("first_name"))         # their details are kept


class WelcomeEmailTests(OfferCase):
    """Welcome aboard (Pranshu, 11/04/2026): once the hiring packet is signed
    the new hire's email names their manager, HR and IT, with how to reach them."""

    def test_the_welcome_names_manager_hr_and_it_support(self):
        import types
        import hr_life_email as hm
        IT = "ivy.it@greensglobal.com"
        self.db.add(models.NexusEmployee(id="e-ivy", work_email=IT, first_name="Ivy", last_name="Tech", company=CO,
                                         status="active", job_title="IT Administrator", phone="555-0199"))
        self.db.query(models.NexusEmployee).filter_by(work_email=MGR).update({"phone": "555-0111"})
        self.db.query(models.HrEntity).filter_by(id=CO).update({"it_contact_email": IT})
        self.db.commit()
        ev = types.SimpleNamespace(inputs={"manager_email": MGR, "job_title": "Analyst", "start_date": "2030-11-02"},
                                   employee_id="", entity_id=CO, subject_email=CAND, kind="hire")
        contacts = hm.welcome_contacts(self.db, ev)
        self.assertEqual([(c["kind"], c["email"]) for c in contacts], [("manager", MGR), ("hr", HR), ("it", IT)])
        self.assertEqual((contacts[0]["name"], contacts[0]["phone"], contacts[0]["title"]), ("Max Mgr", "555-0111", "Max Title"))
        subject, html = hm.compose("hire", stage="completed", role="subject", first_name="Jane", company="Greens Test, LLC",
                                   location="", inputs=ev.inputs, pay={}, manager="Max Mgr", note="", docs=[], link="",
                                   sender={"name": "Charmi Shah", "email": HR}, contacts=contacts,
                                   party=types.SimpleNamespace(email=CAND, name="Jane Doe"),
                                   req=types.SimpleNamespace(id="req-1", title="Hiring Packet - Jane Doe", created_at="2030-10-20"))
        self.assertIn("Welcome to the team, Jane", subject)
        for text in ("Your Manager", "Human Resources", "IT Support", "Ivy Tech", "mailto:ivy.it@greensglobal.com",
                     "tel:555-0111", "no question is too small"):
            self.assertIn(text, html)
        self.assertNotIn("—", html)                   # never an em dash in copy

    def test_someone_who_left_is_never_named(self):
        import types
        import hr_life_email as hm
        self.db.query(models.NexusEmployee).filter_by(work_email=MGR).update({"status": "offboarded"})
        self.db.commit()
        ev = types.SimpleNamespace(inputs={"manager_email": MGR}, employee_id="", entity_id=CO, subject_email=CAND, kind="hire")
        self.assertEqual([c["kind"] for c in hm.welcome_contacts(self.db, ev)], ["hr"])


class RoleJdFromDocumentsTests(OfferCase):
    """A role's job description kept in Documents (Pranshu, 11/04/2026): linked,
    so the offer prints that template's published wording - no duties typed,
    nothing picked on Make An Offer."""

    def test_the_roles_documents_template_goes_after_the_letter(self):
        db = database.SessionLocal()
        _tpl(db, "t-jd-admin", "Admin Associate JD", _doc(_p("Admin duties from Documents.")), category="job_description")
        db.add(models.NexusGroup(id="jr-admin", name="Analyst", is_job_role=1, company_id=CO, department="Accounting",
                                 job_description="", jd_template_id="t-jd-admin"))
        db.commit()
        db.close()
        r = self._offer(role_id="jr-admin", jd_template_id="", new_role_duties="")
        self.assertEqual(r.status_code, 200, r.text)
        ev = self._ev(r.json()["id"])
        self.assertEqual(ev.inputs["jd_template_id"], "t-jd-admin")
        self.assertIn("t-jd-admin", [d["templateId"] for d in ev.documents])


if __name__ == "__main__":
    unittest.main()
