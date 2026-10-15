"""HR packets: who fills each variable - the template says (Oct 14).

Neil: "Pranshu is going to let you fill in everything and the document will
make itself." A template variable is marked Ask The Person (asked on the
person's own form) or HR Answers (asked of HR when the offer is made). The
person's form is BUILT FROM the documents - each question once - so HR never
keeps a second list; a Private answer travels like pay. Builds on the review
tests' fixture (one temporary database for this run).

    python -m pytest test_hr_packet_sources.py
"""
import unittest

import database
import hr_packet_docs as hpd
import models
from routers.documents import _clean_field_defs
from test_hr_packet_review import CAND, ReviewCase, _doc, _p, _sig

PAN = {"token": "pan_number", "label": "PAN Number", "type": "text", "source": "person", "sensitive": True,
       "required": True}
BANK = {"token": "bank_name", "label": "Bank Name", "type": "text", "source": "person"}
PROBATION = {"token": "probation_period", "label": "Probation Period", "type": "text", "source": "hr"}
NDA2 = _doc(_p("PAN ", "{{pan_number}}", " at ", "{{bank_name}}", ". Probation: ", "{{probation_period}}", "."),
            _sig("employee"))


def _publish(db, tid, content, defs, version=2):
    t = db.query(models.DocTemplate).filter_by(id=tid).first()
    t.content, t.version, t.published_version = content, version, version
    t.published_meta = {**(t.published_meta or {}), "fieldDefs": _clean_field_defs(defs)}
    db.add(models.DocTemplateVersion(id=f"v-{tid}-{version}", template_id=tid, version_no=version, content=content))


class SourceTests(ReviewCase):
    def setUp(self):
        super().setUp()
        db = database.SessionLocal()
        _publish(db, "t-nda", NDA2, [PAN, BANK, PROBATION])
        db.commit()
        db.close()

    def test_the_source_survives_a_template_save(self):
        out = {d["token"]: d for d in _clean_field_defs([PAN, PROBATION, {**BANK, "source": "robot"}])}
        self.assertEqual((out["pan_number"]["source"], out["pan_number"]["sensitive"]), ("person", True))
        self.assertEqual(out["probation_period"]["source"], "hr")
        self.assertEqual(out["bank_name"]["source"], "")                  # unknown source dropped

    def test_a_contractors_fee_is_pay(self):
        for token in ("monthly_contractual_fee", "contractual_monthly_payment", "retainer"):
            self.assertTrue(hpd.is_pay_token(token), token)

    def test_the_packet_lists_what_the_documents_ask_and_nothing_is_unfilled(self):
        hire = next(s for s in self.client.get("/hr/packets").json()["settings"] if s["id"] == "s-hire")
        self.assertEqual([f["key"] for f in hire["templateForm"]], ["pan_number", "bank_name"])
        self.assertTrue(hire["templateForm"][0]["sensitive"])
        self.assertEqual([q["token"] for q in hire["hrQuestions"]], ["probation_period"])
        checks = {c["key"]: c for c in hire["readiness"]}
        self.assertTrue(checks["variables"]["ok"], checks["variables"])

    def test_the_persons_answers_fill_the_documents_and_a_private_one_never_lands_on_a_row(self):
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json={
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28",
                       "employment_type": "full_time", "extra": {}, "merge": {"probation_period": "90 days"}},
            "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"},
            "details": {"first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
                        "answers": {"pan_number": "ABCDE1234F", "bank_name": "HDFC"}}})
        self.assertEqual(r.status_code, 200, r.text)
        eid = r.json()["id"]
        rows = self.db.query(models.Document).filter_by(life_event_id=eid).all()
        nda = next(x for x in rows if x.template_id == "t-nda")
        self.assertEqual(nda.merge_overrides.get("bank_name"), "HDFC")
        self.assertNotIn("pan_number", nda.merge_overrides)             # Private - merged at render only
        review = self.client.get(f"/hr/life-events/{eid}/review").json()
        self.assertEqual([a["key"] for a in review["answers"]], ["pan_number", "bank_name"])
        nda_doc = next(d for d in review["documents"] if d["templateId"] == "t-nda")
        self.assertTrue(nda_doc["printsPay"])
        self.assertEqual(nda_doc["unresolved"], [])

    def test_the_person_is_asked_every_question_once_on_their_link(self):
        r = self.client.post("/hr/candidates/cand-1/hiring-packet/start", json={
            "intake": "candidate",
            "inputs": {"job_title": "Analyst", "start_date": "2030-11-02", "offer_expires": "2030-10-28",
                       "employment_type": "full_time", "merge": {"probation_period": "90 days"}}})
        self.assertEqual(r.status_code, 200, r.text)
        token = r.json()["intakeUrl"].rsplit("/", 1)[-1]
        page = self.client.get(f"/hr/intake/public/{token}").json()
        self.assertEqual([f["key"] for f in page["form"]], ["pan_number", "bank_name"])
        # a required question from the documents must be answered
        values = {"first_name": "Jane", "last_name": "Doe", "phone": "555-0100", "address": "12 Pine St",
                  "answers": {"bank_name": "HDFC"}}
        self.assertEqual(self.client.post(f"/hr/intake/public/{token}", json={"values": values}).status_code, 400)
        values["answers"]["pan_number"] = "ABCDE1234F"
        r = self.client.post(f"/hr/intake/public/{token}", json={"values": values})
        self.assertEqual(r.status_code, 200, r.text)
        ev = self.db.query(models.HrLifeEvent).filter_by(subject_email=CAND).first()
        self.db.refresh(ev)
        self.assertEqual(ev.status, "review")
        self.assertEqual(ev.intake["answers"]["pan_number"], "ABCDE1234F")


if __name__ == "__main__":
    unittest.main()
