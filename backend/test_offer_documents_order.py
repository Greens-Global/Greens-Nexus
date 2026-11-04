"""A role's documents go WITH the offer letter, in the role's order (Pranshu,
11/04/2026): "if we put NDA at 1st order then in offer letter candidate will
see offer letter, NDA then Job description". One document to sign.

    python -m pytest test_offer_documents_order.py
"""
import base64
import io
import unittest

from pypdf import PdfReader

import database
import hr_packet_docs as hpd
import models
from test_hr_offer import CO, HR, OfferCase, _tpl
from test_hr_packet_review import _doc, _p, _sig


class OfferOrderTests(OfferCase):
    def _role(self, order):
        db = database.SessionLocal()
        _tpl(db, "t-role-nda", "Confidentiality Agreement", _doc(_p("NDA TERMS FOR ", "{{full_name}}"), _sig("employee")), category="hr")
        db.add(models.NexusGroup(id="jr-ord", name="Analyst", is_job_role=1, company_id=CO, department="Accounting",
                                 job_description="Reconciles accounts.", offer_docs=order))
        db.commit()
        db.close()

    def _preview_text(self):
        r = self.client.post("/hr/candidates/cand-1/offer/preview", json={
            "inputs": {"worker_type": "employee", "employment_type": "full_time", "job_title": "Analyst", "role_id": "jr-ord",
                       "start_date": "2030-11-02", "offer_expires": "2030-10-28", "work_location": "Irvine, CA",
                       "merge": {"probation_period": "90 days"}, "jd_template_id": "t-jd"},
            "pay": {"base": 85000, "payBasis": "salary", "frequency": "annual", "currency": "USD"}})
        self.assertEqual(r.status_code, 200, r.text)
        return "".join(pg.extract_text() or "" for pg in PdfReader(io.BytesIO(base64.b64decode(r.json()["pdf"]))).pages)

    def test_nda_first_then_the_job_description(self):
        self._role([{"kind": "doc", "templateId": "t-role-nda"}, {"kind": "jd"}])
        text = self._preview_text()
        at = [text.find(x) for x in ("we offer you", "NDA TERMS", "Reconciles accounts", "Job Description Acknowledgment")]
        self.assertTrue(all(i >= 0 for i in at), at)
        self.assertEqual(at, sorted(at))                         # letter, NDA, job description, read-it page

    def test_the_job_description_first_when_placed_first(self):
        self._role([{"kind": "jd"}, {"kind": "doc", "templateId": "t-role-nda"}])
        text = self._preview_text()
        self.assertLess(text.find("Job Description Acknowledgment"), text.find("NDA TERMS"))

    def test_the_role_saves_its_order_and_says_it_back(self):
        import auth
        self._role([])
        db = database.SessionLocal()
        db.add(models.NexusRole(email=HR, role="owner"))         # roles are an administrator's to change
        db.commit()
        db.close()
        auth._role_cache.clear()
        r = self.client.put("/jobroles/jr-ord", json={"offer_docs": [{"kind": "doc", "templateId": "t-role-nda"}, {"kind": "jd"},
                                                                       {"kind": "jd"}, {"kind": "doc", "templateId": "t-role-nda"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["offer_docs"], [{"kind": "doc", "templateId": "t-role-nda", "name": "Confidentiality Agreement"},
                                                  {"kind": "jd"}])     # each once
        self.assertEqual(self.client.put("/jobroles/jr-ord", json={"offer_docs": [{"kind": "doc", "templateId": "gone"}]}).status_code, 400)

    def test_offer_order_puts_the_job_description_first_by_default(self):
        self.assertEqual(hpd.offer_order({"role_offer_docs": [{"kind": "doc", "templateId": "a"}]}), ["jd", "a"])
        self.assertEqual(hpd.offer_order({}), ["jd"])


if __name__ == "__main__":
    unittest.main()
