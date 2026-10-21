"""Contractor invoice data (Pranshu, Oct 21 2026): the pieces an auto-built
contractor invoice needs and Nexus did not hold.

- A company keeps `invoice_recipients` (payer emails: lowercased, trimmed,
  must carry an @, no repeats).
- A person's Compliance carries `pan` (uppercased, printed form only); their
  contractor settings carry `invoice_next_number` (a whole number from 1,
  anything else dropped) and `invoice_description`.
- The hiring packet's Details Form maps a (sensitive) PAN answer into
  Compliance.
- MyHR's own-record view never echoes the PAN; a manager's team view has no
  Compliance at all.

Run with: python -m pytest test_contractor_invoice_data.py
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
import hr_life_events as hle  # noqa: E402
from routers import hr  # noqa: E402

ADMIN = "admin.inv@greensglobal.com"
EMP = "dev.inv@greensglobal.com"
CO = "ent-inv"


class ContractorInvoiceData(unittest.TestCase):
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
        for m in (models.NexusEmployee, models.HrEntity, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="GGCon Pvt Ltd"))
        self.db.add(models.NexusEmployee(id="id-inv-admin", work_email=ADMIN, first_name="Ad", last_name="Min",
                                         company=CO, status="active"))
        self.db.add(models.NexusEmployee(id="id-inv-emp", work_email=EMP, first_name="Dev", last_name="One",
                                         company=CO, status="active", employment_type="contractor"))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
        self.db.commit()
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        self.db.close()

    # ── company payer recipients ───────────────────────────────────────────

    def test_entity_recipients_are_normalized(self):
        r = self.client.patch(f"/hr/entities/{CO}", json={"invoice_recipients": [
            " Accounts@Client.com ", "accounts@client.com", "not-an-email", "", "ap@client.com"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["invoiceRecipients"], ["accounts@client.com", "ap@client.com"])
        self.db.expire_all()
        self.assertEqual(self.db.get(models.HrEntity, CO).invoice_recipients, ["accounts@client.com", "ap@client.com"])
        # The list page carries it too; an untouched company reads an empty list.
        r = self.client.post("/hr/entities", json={"name": "Other Co"})
        self.assertEqual(r.json()["invoiceRecipients"], [])

    # ── the person's PAN and invoice settings ─────────────────────────────

    def test_employee_pan_and_invoice_number(self):
        r = self.client.patch("/hr/employees/id-inv-emp", json={
            "compliance": {"pan": " abcde1234f ", "workAuth": "citizen"},
            "contractor": {"invoice_next_number": "7", "invoice_description": "IT Development", "rate": "85"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["compliance"]["pan"], "ABCDE1234F")
        self.assertEqual(r.json()["contractor"]["invoice_next_number"], 7)
        self.assertEqual(r.json()["contractor"]["invoice_description"], "IT Development")
        for bad in ("0", "abc", "", None):
            r = self.client.patch("/hr/employees/id-inv-emp", json={"contractor": {"invoice_next_number": bad, "rate": "85"}})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertNotIn("invoice_next_number", r.json()["contractor"], bad)
        r = self.client.patch("/hr/employees/id-inv-emp", json={"compliance": {"pan": "ABC123"}})
        self.assertEqual(r.status_code, 400)
        r = self.client.patch("/hr/employees/id-inv-emp", json={"compliance": {"pan": ""}})
        self.assertNotIn("pan", r.json()["compliance"])

    def test_pan_never_reaches_myhr_or_a_manager(self):
        self.client.patch("/hr/employees/id-inv-emp", json={"compliance": {"pan": "ABCDE1234F"}})
        os.environ["NEXUS_DEV_EMAIL"] = EMP
        auth.invalidate_role_cache()
        r = self.client.get("/myhr/profile")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("pan", r.text.lower().replace("company", ""))
        self.assertNotIn("ABCDE1234F", r.text)
        # A manager's team view strips Compliance whole.
        self.assertEqual(hr._team_view({"compliance": {"pan": "ABCDE1234F"}, "contractor": {"rate": "1"}})["compliance"], {})

    # ── hiring packet ─────────────────────────────────────────────────────

    def test_packet_pan_answer_lands_in_compliance(self):
        fields = [{"key": "pan_number", "sensitive": True}, {"key": "q2", "label": "PAN Card Number", "sensitive": True}]
        personal, bank, compliance = {}, [], {"workAuth": "citizen"}
        hle._profile_from_answers(fields, {"pan_number": "abcde 1234f"}, personal, bank, "Jane", compliance)
        self.assertEqual(compliance, {"workAuth": "citizen", "pan": "ABCDE1234F"})
        self.assertEqual(personal, {})                                  # never onto Personal Details
        compliance = {}
        hle._profile_from_answers(fields, {"q2": "ZZZZZ9999Z"}, personal, bank, "Jane", compliance)
        self.assertEqual(compliance.get("pan"), "ZZZZZ9999Z")         # matched by label too
        compliance = {}
        hle._profile_from_answers(fields, {"pan_number": "not a pan"}, personal, bank, "Jane", compliance)
        self.assertEqual(compliance, {})                                # an invalid one is ignored
        hle._profile_from_answers(fields, {"pan_number": "ABCDE1234F"}, personal, bank, "Jane")   # old callers
        self.assertEqual(personal, {})


if __name__ == "__main__":
    unittest.main()
