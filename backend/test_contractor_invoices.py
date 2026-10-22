"""Contractor invoices (Pranshu + Neil, Oct 21 2026): a draft invoice when a
contractor's Time Sheet is finalized, numbered from the person's record, HR
approves and sends; amount in words in the Indian system; GSTIN beside the
bank details.

Run with: python -m pytest test_contractor_invoices.py
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
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import contractor_invoices as ci  # noqa: E402
from routers import hr  # noqa: E402
from routers import timeclock as tc  # noqa: E402

ADMIN = "admin.ci@greensglobal.com"
HRC = "hr.ci@greensglobal.com"           # the company's HR contact, no role
CON = "con.ci@greensglobal.com"          # hourly contractor
EMP = "emp.ci@greensglobal.com"          # a full-time employee
CO = "ent-ci"
PS, PE = "2026-10-04", "2026-10-17"
HR_USER = {"email": ADMIN, "role": "administrator", "level": 5}


class ContractorInvoices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
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
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        auth.invalidate_role_cache()
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.HrEntity, models.NexusRole, models.TimePunch, models.PayrollRate,
                  models.TimeApproval, models.ContractorInvoice, models.NexusNotification, models.TimecardBonus):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="GGCon", legal_name="GGCon Private Limited", tax_id="29AAAAA0000A1Z5",
                                    physical_address="1 MG Road, Bengaluru", main_phone="+91 80 0000 0000",
                                    hr_contact_email=HRC))
        self.db.add(models.NexusEmployee(id="id-ci-admin", work_email=ADMIN, first_name="Ad", last_name="Min",
                                         company=CO, status="active"))
        self.db.add(models.NexusEmployee(id="id-ci-hrc", work_email=HRC, first_name="Aitch", last_name="Arr",
                                         company=CO, status="active"))
        self.db.add(models.NexusEmployee(id="id-ci-con", work_email=CON, first_name="Dev", last_name="One", phone="+91 98",
                                         company=CO, status="active", employment_type="contractor",
                                         contractor={"invoice_next_number": 7, "invoice_description": "IT Development"},
                                         compliance={"pan": "ABCDE1234F"}, personal={"currentAddress": "2 Brigade Rd"},
                                         bank=[{"holder": "Dev One", "number": "0012345", "routingOrIfsc": "HDFC0000001",
                                                "type": "Savings", "bankName": "HDFC Bank, Koramangala"}]))
        self.db.add(models.NexusEmployee(id="id-ci-emp", work_email=EMP, first_name="Em", last_name="Ploy",
                                         company=CO, status="active", employment_type="full_time"))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
        for em in (CON, EMP):
            self.db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=500.0,
                                           overtime_rule="ca", currency="INR"))
            for i, (kind, at) in enumerate((("in", "2026-10-05T03:30:00+00:00"), ("out", "2026-10-05T11:30:00+00:00"))):
                self.db.add(models.TimePunch(id=f"p-{em}-{i}", employee_email=em, kind=kind, at=at,
                                             local_date="2026-10-05", tz_offset_min=-330))
        self.db.commit()
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _as(self, email: str):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def _finalize(self, email: str):
        tc.finalize_timecard(tc.FinalizeIn(email=email, start=PS, end=PE, allow_exceptions=True), user=HR_USER, db=self.db)
        self.db.expire_all()
        return self.db.query(models.TimeApproval).filter(models.TimeApproval.employee_email == email,
                                                         models.TimeApproval.kind == "final",
                                                         models.TimeApproval.revoked == 0).first()

    def _invoices(self, email: str = CON):
        self.db.expire_all()
        return self.db.query(models.ContractorInvoice).filter(models.ContractorInvoice.employee_email == email).all()

    # ── words and GSTIN ───────────────────────────────────────────────────

    def test_amount_in_words_indian_system(self):
        self.assertEqual(ci.amount_in_words(0), "Zero Rupees Only")
        self.assertEqual(ci.amount_in_words(5), "Five Rupees Only")
        self.assertEqual(ci.amount_in_words(40000), "Forty Thousand Rupees Only")
        self.assertEqual(ci.amount_in_words(123456.50),
                         "One Lakh Twenty Three Thousand Four Hundred Fifty Six Rupees and Fifty Paise Only")
        self.assertEqual(ci.amount_in_words(10_000_000), "One Crore Rupees Only")
        self.assertEqual(ci.amount_in_words(2_50_00_019.05),
                         "Two Crore Fifty Lakh Nineteen Rupees and Five Paise Only")
        self.assertEqual(ci.amount_in_words(1200.25, "USD"), "One Thousand Two Hundred Dollars and Twenty Five Cents Only")

    def test_gstin_lives_beside_the_bank(self):
        # Pay & Benefits is the hr_comp grant or a Global Admin - same guard as the bank list.
        self.db.query(models.NexusRole).filter(models.NexusRole.email == ADMIN).update({"role": "owner"})
        self.db.commit()
        auth.invalidate_role_cache()
        r = self.client.put("/hr/employees/id-ci-con/compensation", json={"gstin": "bad"})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.put("/hr/employees/id-ci-con/compensation", json={"gstin": " 29abcde1234f1z5 "})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["gstin"], "29ABCDE1234F1Z5")
        # A pay-record save that does not mention it keeps it.
        r = self.client.put("/hr/employees/id-ci-con/compensation", json={"compensation": {"base": "1000"}})
        self.assertEqual(r.json()["gstin"], "29ABCDE1234F1Z5")
        r = self.client.get("/hr/employees/id-ci-con/compensation")
        self.assertEqual(r.json()["gstin"], "29ABCDE1234F1Z5")
        self.assertEqual(r.json()["compensation"]["gstin"], "29ABCDE1234F1Z5")
        r = self.client.put("/hr/employees/id-ci-con/compensation", json={"gstin": ""})
        self.assertEqual(r.json()["gstin"], "")
        self.assertNotIn("gstin", r.json()["compensation"])
        self.assertEqual(hr._norm_gstin("29ABCDE1234F1Z5"), "29ABCDE1234F1Z5")

    def test_pan_on_pay_and_benefits_is_the_compliance_pan(self):
        # Pranshu, Oct 23: PAN is edited beside the GSTIN too - one field, compliance.pan.
        self.db.query(models.NexusRole).filter(models.NexusRole.email == ADMIN).update({"role": "owner"})
        self.db.commit()
        auth.invalidate_role_cache()
        self.assertEqual(self.client.get("/hr/employees/id-ci-con/compensation").json()["pan"], "ABCDE1234F")
        r = self.client.put("/hr/employees/id-ci-con/compensation", json={"pan": "bad"})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.put("/hr/employees/id-ci-con/compensation", json={"pan": " pqrst6789z "})
        self.assertEqual((r.status_code, r.json()["pan"]), (200, "PQRST6789Z"))
        self.db.expire_all()
        self.assertEqual(self.db.get(models.NexusEmployee, "id-ci-con").compliance["pan"], "PQRST6789Z")
        # A save that does not mention it keeps it; the next invoice prints it.
        self.client.put("/hr/employees/id-ci-con/compensation", json={"gstin": ""})
        self.db.expire_all()
        self.assertEqual(self.db.get(models.NexusEmployee, "id-ci-con").compliance["pan"], "PQRST6789Z")
        self._finalize(CON)
        self.assertEqual(self._invoices()[0].snapshot["billedBy"]["pan"], "PQRST6789Z")

    # ── draft at finalize ────────────────────────────────────────────────

    def test_draft_for_a_contractor_only_once_and_void_on_unfinalize(self):
        final = self._finalize(CON)
        invs = self._invoices()
        self.assertEqual(len(invs), 1)
        inv = invs[0]
        self.assertEqual((inv.number, inv.status, inv.currency, inv.final_approval_id), (7, "draft", "INR", final.id))
        self.assertEqual(self.db.get(models.NexusEmployee, "id-ci-con").contractor["invoice_next_number"], 8)
        card = tc._compute_timecard(self.db, CON, PS, PE)["totals"]
        self.assertGreater(inv.amount, 0)
        self.assertEqual(inv.amount, round(card["totalPay"], 2))   # the card's pay, nothing recalculated
        self.assertEqual((inv.hours, inv.rate), (round(final.worked_min / 60, 2), 500.0))
        self.assertEqual(inv.snapshot["billedBy"]["pan"], "ABCDE1234F")
        self.assertEqual(inv.snapshot["billedTo"]["taxId"], "29AAAAA0000A1Z5")
        self.assertEqual(inv.snapshot["bank"]["ifsc"], "HDFC0000001")
        self.assertEqual(inv.snapshot["period"]["text"], "10/04/2026 - 10/17/2026")
        bell = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == HRC).all()
        self.assertEqual(len(bell), 1)
        self.assertEqual(bell[0].title, "Contractor Invoice to Approve - Dev One")
        self.assertIn("Invoice 7, 10/04/2026 - 10/17/2026, INR", bell[0].body)
        self.assertIn("hr-time-invoices", bell[0].action)
        # The same final row again: no second draft, number untouched.
        self.assertIsNone(ci.draft_for(self.db, CON, final))
        self.assertEqual(len(self._invoices()), 1)
        # An employee gets none.
        self._finalize(EMP)
        self.assertEqual(self._invoices(EMP), [])
        # Unfinalize voids the draft; finalizing again drafts number 8.
        tc.unfinalize_timecard(tc.FinalizeIn(email=CON, start=PS, end=PE, reason="Wrong lunch on Monday"), user=HR_USER, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.ContractorInvoice, inv.id).status, "void")
        self._finalize(CON)
        self.assertEqual(sorted((i.number, i.status) for i in self._invoices()), [(7, "void"), (8, "draft")])

    def test_a_bonus_on_the_period_is_billed_on_its_own_line(self):
        # Oct 22: a bonus added before finalizing is in the invoice total and itemized.
        base = tc._compute_timecard(self.db, CON, PS, PE)["totals"]["totalPay"]
        tc.add_timecard_bonus(tc.TimecardBonusIn(email=CON, date=PS, description="Go-live weekend", amount=2500.0),
                              user=HR_USER, _su={}, db=self.db)
        self._finalize(CON)
        inv = self._invoices()[0]
        self.assertEqual(inv.amount, round(base + 2500.0, 2))
        self.assertEqual(inv.snapshot["bonuses"], [{"description": "Go-live weekend", "amount": 2500.0}])
        from pypdf import PdfReader
        import io
        text = " ".join(pg.extract_text() for pg in PdfReader(io.BytesIO(ci.render_pdf(inv.snapshot | {
            "number": inv.number, "currency": inv.currency, "amount": inv.amount}))).pages)
        self.assertIn("Go-live weekend", text)

    def test_card_payloads_carry_contractor_and_invoice(self):
        self._as(CON)
        r = self.client.get("/timeclock/my-payroll", params={"start": PS})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["contractor"], r.json()["invoice"]), (True, None))
        self._finalize(CON)
        r = self.client.get("/timeclock/my-payroll", params={"start": PS})
        self.assertEqual(r.json()["invoice"]["number"], 7)
        self.assertEqual(r.json()["invoice"]["status"], "draft")
        self._as(EMP)
        r = self.client.get("/timeclock/my-payroll", params={"start": PS})
        self.assertEqual((r.json()["contractor"], r.json()["invoice"]), (False, None))

    # ── send ─────────────────────────────────────────────────────────────

    def test_send(self):
        self._finalize(CON)
        inv = self._invoices()[0]
        r = self.client.get("/contractor-invoices", params={"status": "draft"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([i["number"] for i in r.json()["invoices"]], [7])
        self.assertEqual(r.json()["invoices"][0]["recipients"], [])
        r = self.client.post(f"/contractor-invoices/{inv.id}/send")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Contractor Invoice Recipients", r.json()["detail"])
        ent = self.db.get(models.HrEntity, CO)
        ent.invoice_recipients = ["ap@ggcon.in"]
        self.db.commit()
        # A profile change after the draft never reaches the invoice.
        emp = self.db.get(models.NexusEmployee, "id-ci-con")
        emp.first_name = "Renamed"
        self.db.commit()
        r = self.client.post(f"/contractor-invoices/{inv.id}/send")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["sent"], r.json()["emailed"]), (True, False))   # no Graph locally
        self.db.expire_all()
        inv = self.db.get(models.ContractorInvoice, inv.id)
        self.assertEqual((inv.status, inv.sent_to, inv.approved_by), ("sent", ["ap@ggcon.in"], ADMIN))
        self.assertTrue(inv.sent_at and inv.pdf_path.endswith("Invoice 7 - Dev One.pdf"))
        self.assertEqual(inv.snapshot["billedBy"]["name"], "Dev One")
        r = self.client.post(f"/contractor-invoices/{inv.id}/send")
        self.assertEqual(r.status_code, 409)
        r = self.client.get(f"/contractor-invoices/{inv.id}/pdf")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "application/pdf")
        self.assertTrue(r.content.startswith(b"%PDF"))
        r = self.client.get("/contractor-invoices", params={"status": "sent", "company": CO})
        self.assertEqual(r.json()["invoices"][0]["sentTo"], ["ap@ggcon.in"])
        self.assertEqual(r.json()["invoices"][0]["employeeName"], "Dev One")

    def test_the_email_reads_like_a_filing_name(self):
        # Pranshu, Oct 23: subject "<invoice date> - <contractor> (<total>)"; the
        # body names the month for a monthly fee, the dates for a bi-weekly one,
        # and the approver by name with their email.
        inv = models.ContractorInvoice(number=7, invoice_date="2026-10-19", currency="INR", amount=42500.0,
                                       period_start="2026-10-04", period_end="2026-10-17")
        subject, html = ci.invoice_email(inv, "Arjun Mehta", "Hana Test", "hana.hr@greensglobal.com")
        self.assertEqual(subject, "10/19/2026 - Arjun Mehta (INR 42,500.00)")
        self.assertEqual(html, "<p>Please find attached invoice 7 from Arjun Mehta from 10/04/2026 to 10/17/2026: "
                               "INR 42,500.00.</p><p>Approved in Nexus by Hana Test (hana.hr@greensglobal.com).</p>")
        inv.period_start, inv.period_end = "2026-09-01", "2026-09-30"
        _s, html = ci.invoice_email(inv, "Arjun Mehta", "Hana Test", "hana.hr@greensglobal.com")
        self.assertIn("invoice 7 from Arjun Mehta for September 2026: INR 42,500.00.", html)
        inv.period_start, inv.period_end = "2024-02-01", "2024-02-29"      # a leap February is a whole month
        self.assertIn("for February 2024", ci.invoice_email(inv, "A", "", "x@y.com")[1])
        self.assertIn("Approved in Nexus by x@y.com.", ci.invoice_email(inv, "A", "", "x@y.com")[1])
        self.assertIn("&lt;b&gt;", ci.invoice_email(inv, "<b>", "", "x@y.com")[1])   # names are escaped

    def test_pdf_has_the_rupee_sign_font(self):
        self.assertEqual(ci._fonts(), ("DejaVu", "DejaVu-Bold"))
        blob = ci.render_pdf({"number": 10, "invoiceDate": "2026-11-01", "currency": "INR", "amount": 40000,
                              "description": "IT Development", "period": {"text": "10/01/2026 - 10/31/2026"},
                              "billedBy": {"name": "Dev One", "pan": "ABCDE1234F", "gstin": "29ABCDE1234F1Z5"},
                              "billedTo": {"name": "GGCon"}, "bank": {"holder": "Dev One"}})
        self.assertTrue(blob.startswith(b"%PDF"))

    # ── who sees what ────────────────────────────────────────────────────

    def test_mine_and_hr_only(self):
        self._finalize(CON)
        inv = self._invoices()[0]
        self._as(CON)
        r = self.client.get("/contractor-invoices/mine")
        self.assertEqual([i["number"] for i in r.json()["invoices"]], [7])
        self.assertNotIn("recipients", r.json()["invoices"][0])
        self.assertEqual(self.client.get(f"/contractor-invoices/{inv.id}/pdf").status_code, 200)
        self.assertEqual(self.client.get("/contractor-invoices").status_code, 403)
        self.assertEqual(self.client.post(f"/contractor-invoices/{inv.id}/send").status_code, 403)
        self._as(EMP)
        self.assertEqual(self.client.get("/contractor-invoices/mine").json()["invoices"], [])
        self.assertEqual(self.client.get(f"/contractor-invoices/{inv.id}/pdf").status_code, 403)
        # The company's HR contact, with no role at all, is HR for its invoices.
        self._as(HRC)
        r = self.client.get("/contractor-invoices")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([i["number"] for i in r.json()["invoices"]], [7])


if __name__ == "__main__":
    unittest.main()
