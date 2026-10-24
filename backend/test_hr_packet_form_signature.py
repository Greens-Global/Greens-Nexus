"""HR packets: the packet's own Details Form and Signs Once (Oct 14).

  - Details Form: any country, any field. The person fills it from their link
    (or HR does); each answer is a {{variable}}. Sensitive answers travel like
    pay - Pay & Benefits only, never on a document row; Last 4 Only answers
    are cut down before they are stored.
  - Signs Once: the company signs a packet once; the adopted signature goes on
    every packet after it. When the company's HR contact changes, the new
    holder must sign once before the next packet can go.

Builds on the review tests' fixture (one temporary database for this run).

    python -m pytest test_hr_packet_form_signature.py
"""
import io
import unittest

from pypdf import PdfReader

import database
import hr_packet_docs as hpd
import models
from services import sign_otp
from test_hr_packet_review import CAND, CO, HR, HR2, PLAIN, ReviewCase, _doc, _p, _sig

INDIA = _doc(_p("Contractor ", "{{full_name}}", " PAN ", "{{pan_number}}", " Aadhaar ", "{{aadhaar_number}}",
                " born ", "{{date_of_birth}}", " account ", "{{account_type}}", " client ", "{{client_name}}",
                " pay ", "{{salary}}", "."), _sig("employee"))
FORM = [{"type": "heading", "label": "Identity"},
        {"label": "PAN Number", "type": "text", "required": True, "sensitive": True},
        {"label": "Aadhaar Number", "type": "text", "last4": True},
        {"label": "Date Of Birth", "type": "date", "required": True},
        {"label": "Account Type", "type": "choice", "options": ["Savings", "Current"]}]
ANSWERS = {"pan_number": "ABCDE1234F", "aadhaar_number": "1234 5678 9012", "date_of_birth": "1990-01-31",
           "account_type": "Savings"}
CLIENT = {"token": "client_name", "label": "Client Name", "type": "text", "default": "Greens Global LLC"}


def _text(pdf_bytes) -> str:
    return "".join(pg.extract_text() or "" for pg in PdfReader(io.BytesIO(pdf_bytes)).pages)


class FormCase(ReviewCase):
    def setUp(self):
        super().setUp()
        meta = {"fieldDefs": [CLIENT], "signerRoles": [], "mergeOverrides": {}, "letterheadId": "",
                "requiresLetterhead": False}
        self.db.add(models.DocTemplate(id="t-india", name="India Agreement", category="hr", status="active", version=1,
                                       content=INDIA, department="", field_defs=[CLIENT], published_version=1,
                                       published_meta=meta))
        self.db.add(models.DocTemplateVersion(id="v-t-india", template_id="t-india", version_no=1, content=INDIA))
        s = self.db.query(models.HrPacketSetting).filter_by(id="s-hire").first()
        s.doc_template_ids = ["t-offer", "t-nda", "t-india"]
        s.details_form = hpd.clean_form(FORM)
        self.db.commit()

    def _set_once(self, once=True):
        db = database.SessionLocal()
        s = db.query(models.HrPacketSetting).filter_by(id="s-hire").first()
        s.flow = [{"key": "company", "role": "hr", "action": "sign", **({"once": True} if once else {})},
                  {"key": "employee", "role": "employee", "action": "sign"}]
        db.commit()
        db.close()

    def _start_with(self, answers=None, **kw):
        body = {"details": {"first_name": "Jane", "last_name": "Doe", "phone": "555-0100",
                            "address": "12 Pine St, Springfield", "answers": answers if answers is not None else ANSWERS}}
        body.update(kw)
        return self._start(**body)

    def _sign_once(self, who, step="company"):
        self._as(who)
        r = self.client.post("/hr/packets/s-hire/sign-once/code", json={"step": step})
        if r.status_code != 200:
            return r
        return self.client.post("/hr/packets/s-hire/sign-once", json={
            "step": step, "consent": True, "signature_kind": "typed", "signature_data": "Signed Once",
            "code": self.codes[who]})


class FormRules(unittest.TestCase):
    def test_the_form_is_checked_when_it_is_saved(self):
        out = hpd.clean_form(FORM)
        self.assertEqual([f["key"] for f in out], ["", "pan_number", "aadhaar_number", "date_of_birth", "account_type"])
        self.assertTrue(out[2]["last4"] and out[1]["sensitive"])
        for bad, says in (([{"label": "Phone", "type": "text"}], "already fills"),
                          ([{"label": "Monthly Salary", "type": "text"}], "reads as pay"),
                          ([{"label": "PAN", "type": "text"}, {"label": "pan", "type": "text"}], "both be"),
                          ([{"label": "Account", "type": "choice", "options": ["Only"]}], "at least two"),
                          ([{"label": "", "type": "text"}], "needs a label"),
                          ([{"label": "X", "type": "signature"}], "Unknown field type")):
            with self.assertRaises(hpd.PacketProblem) as ctx:
                hpd.clean_form(bad)
            self.assertIn(says, str(ctx.exception))

    def test_answers_are_checked_against_their_field(self):
        s = models.HrPacketSetting(details_form=hpd.clean_form(FORM))
        a = hpd.clean_answers(s, ANSWERS)
        self.assertEqual(a["aadhaar_number"], "XXXX 9012")            # never stored in full
        for bad in ({"date_of_birth": "31/01/1990"}, {"account_type": "Checking"}):
            with self.assertRaises(hpd.PacketProblem):
                hpd.clean_answers(s, {**ANSWERS, **bad})
        with self.assertRaises(hpd.PacketProblem):
            hpd.clean_answers(s, {"aadhaar_number": "1"}, require=False)
        with self.assertRaises(hpd.PacketProblem) as ctx:
            hpd.clean_answers(s, {}, require=True)
        self.assertIn("PAN Number", str(ctx.exception))
        # the masked value shown back on review is kept as it is
        self.assertEqual(hpd.clean_answers(s, {"aadhaar_number": "XXXX 9012"}, {"aadhaar_number": "XXXX 9012"})
                         ["aadhaar_number"], "XXXX 9012")


class DetailsFormTests(FormCase):
    def test_the_candidate_fills_the_form_and_sensitive_answers_stay_restricted(self):
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json={
            "intake": "candidate",
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28",
                       "manager_email": "max.mgr@greensglobal.com", "employment_type": "full_time"},
            "pay": {"base": 45000, "payBasis": "salary", "frequency": "monthly", "currency": "INR"}})
        self.assertEqual(r.status_code, 200, r.text)
        eid, token = r.json()["id"], r.json()["intakeUrl"].rsplit("/", 1)[-1]
        page = self.client.get(f"/hr/intake/public/{token}").json()
        self.assertEqual([f["label"] for f in page["form"]],
                         ["Identity", "PAN Number", "Aadhaar Number", "Date Of Birth", "Account Type"])
        base = {"first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St"}
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {**base, "answers": {"date_of_birth": "1990-01-31"}}})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("PAN Number", r.text)
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": {**base, "answers": ANSWERS}})
        self.assertEqual(r.status_code, 200, r.text)

        ev = self._ev(eid)
        self.assertEqual(ev.intake["answers"]["aadhaar_number"], "XXXX 9012")
        for row in self.db.query(models.Document).filter_by(life_event_id=eid):
            self.assertNotIn("pan_number", row.merge_overrides)       # Sensitive: never on a document row
        india = self.db.query(models.Document).filter_by(life_event_id=eid, template_id="t-india").first()
        self.assertEqual(india.merge_overrides["date_of_birth"], "01/31/1990")

        review = self._review(eid)
        pan = next(a for a in review["answers"] if a.get("key") == "pan_number")
        self.assertEqual((pan["value"], pan["locked"]), ("ABCDE1234F", False))
        self.assertNotIn("answers", review["details"])
        text = _text(self.client.get(f"/hr/life-events/{eid}/documents/{india.id}/pdf").content)
        for want in ("ABCDE1234F", "XXXX 9012", "01/31/1990", "Savings", "Greens Global LLC", "Rs. 45,000.00 per month"):
            self.assertIn(want, text)
        self.assertNotIn("■", text)

        self._as(PLAIN)                                              # People editor without Pay & Benefits
        review = self._review(eid)
        pan = next(a for a in review["answers"] if a.get("key") == "pan_number")
        self.assertEqual((pan["value"], pan["locked"]), ("", True))
        doc = next(d for d in review["documents"] if d["templateId"] == "t-india")
        self.assertFalse(doc["canOpen"])
        self.assertEqual(self.client.get(f"/hr/life-events/{eid}/documents/{india.id}/pdf").status_code, 403)
        # editing details without Pay & Benefits keeps the Sensitive answer
        r = self.client.patch(f"/hr/life-events/{eid}/values", json={"details": {
            "first_name": "Jane", "last_name": "Doe", "answers": {"date_of_birth": "1991-02-01",
                                                                   "aadhaar_number": "XXXX 9012"}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._ev(eid).intake["answers"]["pan_number"], "ABCDE1234F")

    def test_a_required_answer_left_empty_by_hr_blocks_sending(self):
        eid = self._start_with(answers={"date_of_birth": "1990-01-31"})["id"]
        review = self._review(eid)
        self.assertFalse(review["canVerify"])
        self.assertTrue(any("PAN Number" in p for p in review["problems"]), review["problems"])

    def test_only_personal_details_land_on_people(self):
        eid = self._start_with()["id"]
        self.assertEqual(self._verify(eid).status_code, 200)
        req = self._ev(eid).sign_request_id
        self._sign(self._party(req, CAND))          # the person first (Neil, Oct 22 2026)
        self._sign(self._party(req, HR))
        ev = self._ev(eid)
        self.assertEqual(ev.status, "completed", ev.apply_note)
        cand = self.db.query(models.HrCandidate).filter_by(id="cand-1").first()
        emp = self.db.query(models.NexusEmployee).filter_by(id=cand.employee_id).first()
        # Oct 16: date of birth and the ID fill Personal Details; the other answers (account type, PAN)
        # stay on the packet - no Hiring Details rows
        self.assertNotIn("packetDetails", emp.personal)
        self.assertEqual((emp.personal["dob"], emp.personal["nationalId"]), ("1990-01-31", "XXXX 9012"))
        self.assertEqual(emp.bank or [], [])

    def test_the_editor_is_offered_the_variables_a_template_needs(self):
        cat = self.client.get("/hr/packets").json()
        india = next(t for t in cat["docTemplates"] if t["id"] == "t-india")
        # client_name has a Default Value and salary is pay - neither is asked for
        self.assertEqual([v["token"] for v in india["variables"]],
                         ["aadhaar_number", "account_type", "date_of_birth", "pan_number"])
        hire = next(s for s in cat["settings"] if s["id"] == "s-hire")
        self.assertEqual(len(hire["detailsForm"]), 5)

    def test_saving_a_packet_checks_its_form(self):
        cat = self.client.get("/hr/packets").json()
        s = next(x for x in cat["settings"] if x["id"] == "s-hire")
        body = {"id": "s-hire", "entity_id": CO, "event": "hire", "name": s["name"], "doc_template_ids": s["docTemplateIds"],
                "flow": [{"key": f["key"], "role": f["role"], "action": f["action"]} for f in s["flow"]],
                "verify_role": "hr", "country": s["country"] or "US",
                "details_form": FORM + [{"label": "Phone", "type": "text"}]}
        r = self.client.put("/hr/packets/documents", json=body)
        self.assertEqual(r.status_code, 400)
        self.assertIn("already fills", r.text)
        body["details_form"] = FORM
        r = self.client.put("/hr/packets/documents", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([f["key"] for f in r.json()["detailsForm"]][1], "pan_number")


class SignsOnceTests(FormCase):
    def test_hr_signs_once_and_it_goes_on_by_itself(self):
        self._set_once()
        eid = self._start_with()["id"]
        review = self._review(eid)
        self.assertFalse(review["canVerify"])
        self.assertEqual([(s["name"], s["signed"], s["isMe"]) for s in review["signOnce"]], [("Charmi Shah", False, True)])
        self.assertTrue(any("signs this packet once" in p for p in review["problems"]))
        # only the person who holds HR for the company can
        r = self._sign_once(HR2)
        self.assertEqual(r.status_code, 403, r.text)
        self._as(HR)
        self.client.post("/hr/packets/s-hire/sign-once/code", json={"step": "company"})
        bad = self.client.post("/hr/packets/s-hire/sign-once", json={
            "step": "company", "consent": True, "signature_kind": "typed", "signature_data": "C", "code": "000000"})
        self.assertEqual(bad.status_code, 400)
        r = self.client.post("/hr/packets/s-hire/sign-once", json={      # the code just sent is still good
            "step": "company", "consent": True, "signature_kind": "typed", "signature_data": "Signed Once",
            "code": self.codes[HR]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()[0]["signed"])

        review = self._review(eid)
        self.assertTrue(review["canVerify"], review["problems"])
        self.assertEqual(self._verify(eid, review).status_code, 200)
        ev = self._ev(eid)
        self.assertEqual(ev.status, "sent")                          # nobody signs ahead of the person
        self.assertEqual(self.invited, [CAND])                       # HR is never asked again
        # Neil, Oct 22 2026: the company never signs before the person - the
        # saved signature rides on the party but is NOT applied at send.
        company = self._party(ev.sign_request_id, HR)
        self.assertEqual((company.status, company.auth_method, company.signed_at or ""),
                         ("waiting", "saved_signature", ""))
        self.assertEqual(self.client.get("/esign/mine").json(), [])  # nothing waiting for HR

        self._sign(self._party(ev.sign_request_id, CAND))
        # ...and goes on by itself the moment the person has signed.
        cand, company = self._party(ev.sign_request_id, CAND), self._party(ev.sign_request_id, HR)
        self.assertEqual((company.status, company.signature_data), ("signed", "Signed Once"))
        self.assertGreater(company.signed_at, cand.signed_at)
        self.assertTrue(sign_otp.summary_for_certificate(self.db, company).get("verified_at"))
        self.assertEqual(self.invited, [CAND])                       # HR is never asked
        self.assertEqual(self._ev(eid).status, "completed", self._ev(eid).apply_note)

        # the next hire needs no signature from HR at all
        db = database.SessionLocal()
        db.add(models.HrCandidate(id="cand-2", first_name="Ravi", last_name="K", email="ravi@gmail.com",
                                  role_title="Analyst", department="Accounting", stage="offer", company=CO,
                                  created_by=HR, created_at="2026-10-01T00:00:00"))
        db.commit()
        db.close()
        r = self.client.post("/hr/candidates/cand-2/hiring-packet/start", json={
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28",
                       "manager_email": "max.mgr@greensglobal.com", "employment_type": "full_time",
                       "timings_text": "40 hours a week"},
            "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"},
            "details": {"first_name": "Ravi", "last_name": "K", "address": "9 Elm St", "answers": ANSWERS}})
        self.assertEqual(r.status_code, 200, r.text)
        nxt = self._review(r.json()["id"])
        self.assertTrue(nxt["canVerify"], nxt["problems"])

    def test_a_new_hr_contact_signs_once_again(self):
        self._set_once()
        self.assertEqual(self._sign_once(HR).status_code, 200)
        db = database.SessionLocal()
        db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": HR2})
        db.commit()
        db.close()
        eid = self._start_with()["id"]
        self._as(HR2)
        review = self._review(eid)
        self.assertFalse(review["canVerify"])
        self.assertEqual([(s["name"], s["signed"]) for s in review["signOnce"]], [("Hal Hr", False)])
        self.assertEqual(self._sign_once(HR).status_code, 403)       # the old HR no longer can
        status = self._sign_once(HR2)
        self.assertEqual(status.status_code, 200, status.text)
        self._as(HR2)
        self.assertTrue(self._review(eid)["canVerify"])
        recs = self.db.query(models.HrPacketSetting).filter_by(id="s-hire").first().saved_signatures
        self.db.expire_all()
        recs = self.db.query(models.HrPacketSetting).filter_by(id="s-hire").first().saved_signatures
        self.assertEqual([(r["email"], bool(r["replacedAt"])) for r in recs], [(HR, True), (HR2, False)])

    def test_signs_once_is_only_for_a_company_role(self):
        db = database.SessionLocal()
        s = db.query(models.HrPacketSetting).filter_by(id="s-hire").first()
        s.flow = [{"key": "company", "role": "hr", "action": "sign"},
                  {"key": "employee", "role": "employee", "action": "sign", "once": True}]
        self.assertTrue(any("cannot Sign Once" in p for p in hpd.config_problems(db, s)))
        db.close()


class PrintTests(FormCase):
    def test_offer_in_rupees_prints_without_a_black_box(self):
        eid = self._start_with(pay={"base": 45000, "payBasis": "salary", "frequency": "monthly", "currency": "INR"})["id"]
        offer = self.db.query(models.Document).filter_by(life_event_id=eid, template_id="t-offer").first()
        text = _text(self.client.get(f"/hr/life-events/{eid}/documents/{offer.id}/pdf").content)
        self.assertIn("Rs. 45,000.00 per month", text)
        self.assertNotIn("■", text)


if __name__ == "__main__":
    unittest.main()


class ProfileFromAnswers(unittest.TestCase):
    """Pranshu, Oct 16: the person's form fills Personal Details and the bank
    account on Pay & Benefits - nothing else reaches People."""

    FIELDS = [{"key": "gender"}, {"key": "aadhaar_number", "sensitive": True}, {"key": "bank_account_number", "sensitive": True}]

    def test_personal_details_and_a_bank_account(self):
        import hr_life_events as hle
        personal, bank = {}, [{"number": "999", "bankName": "Old"}]
        hle._profile_from_answers(self.FIELDS, {
            "date_of_birth": "1990-01-31", "gender": "prefer not to say", "aadhaar_number": "1234 5678 9012",
            "bank_account_number": "50100", "ifsc_code": "HDFC0001", "bank_name": "HDFC",
            "account_type": "Savings Account", "pan_number": "ABCDE1234F"}, personal, bank, "Jane Doe")
        self.assertEqual(personal, {"dob": "1990-01-31", "gender": "Prefer not to say"})    # Sensitive ID stays off
        self.assertEqual(bank[1], {"holder": "Jane Doe", "bankName": "HDFC", "routingOrIfsc": "HDFC0001",
                                   "number": "50100", "type": "savings"})
        hle._profile_from_answers(self.FIELDS, {"bank_account_number": "50100"}, personal, bank, "Jane Doe")
        self.assertEqual(len(bank), 2)                                                      # same account never twice

    def test_matched_by_label_too(self):
        import hr_life_events as hle
        personal, bank = {}, []
        hle._profile_from_answers([{"key": "q1", "label": "Date of Birth"}, {"key": "q2", "label": "Aadhaar Number"},
                                   {"key": "q3", "label": "Bank Account Number"},
                                   {"key": "q4", "label": "Account Holder Name (as per bank records)"},
                                   {"key": "q5", "label": "Nationality"}],
                                  {"q1": "1990-01-31", "q2": "XXXX 9012", "q3": "7729", "q4": "MANNY", "q5": "Indian"},
                                  personal, bank, "Jane Doe")
        self.assertEqual(personal, {"dob": "1990-01-31", "nationalId": "XXXX 9012"})
        self.assertEqual(bank, [{"holder": "MANNY", "bankName": "", "routingOrIfsc": "", "number": "7729", "type": "checking"}])

    def test_a_date_that_is_not_a_date_stays_off(self):
        import hr_life_events as hle
        personal = {}
        hle._profile_from_answers([], {"dob": "31st Jan"}, personal, [], "")
        self.assertEqual(personal, {})
