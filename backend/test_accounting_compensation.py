"""Accounting > Reporting > Employee Compensation (Neil, 10/15): adding the
payroll cards up per person, the totals per company / department /
currency, the ledger's payroll classification, and the gate (Full level on
Accounting, no entity limit).

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_compensation.py -q
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, accounting_allocations  # noqa: E402
from routers.accounting_compensation import ledger_rows, month_end, month_list, payroll_class, summarize  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

FULL = "full.comp.test@greensglobal.com"        # accounting:full
VIEWER = "viewer.comp.test@greensglobal.com"    # accounting:viewer - not enough
LIMITED = "limited.comp.test@greensglobal.com"  # accounting:full but limited to one entity
NOBODY = "nobody.comp.test@greensglobal.com"
GROUP_F, GROUP_V = "grp-comp-test-full", "grp-comp-test-viewer"

PEOPLE = [
    {"email": "pat@x.com", "name": "Pat Hourly", "payType": "hourly", "company": "c1", "companyName": "Greens Global", "department": "Maintenance", "employeeId": "GG-001", "currency": "USD"},
    {"email": "sal@x.com", "name": "Sal Fixed", "payType": "fixed", "company": "c2", "companyName": "Greens India", "department": "Accounts", "employeeId": "GI-001", "currency": "INR"},
    {"email": "none@x.com", "name": "No Hours", "payType": "hourly", "company": "c1", "companyName": "Greens Global", "department": "", "employeeId": "", "currency": "USD"},
]


def cards(month):
    sep = month == "2026-09"
    return {
        "pat@x.com": {"rate": 25.0 if sep else 26.0, "totals": {"regMin": 4800, "otMin": 120, "dtMin": 30, "sickMin": 480, "vacationMin": 0, "personalMin": 0, "totalPay": 2500.0}},
        "sal@x.com": {"currency": "INR", "monthlySalary": 90000, "totals": {"regMin": 9000, "otMin": 60, "dtMin": 0, "sickMin": 0, "vacationMin": 540, "personalMin": 0, "totalPay": 88000.0}},
        "none@x.com": {"rate": 20, "totals": {"totalPay": 0}},
    }


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class MathTests(unittest.TestCase):
    def test_months(self):
        self.assertEqual(month_list("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"])
        self.assertEqual(month_end("2028-02"), "2028-02-29")
        with self.assertRaises(HTTPException):
            month_list("2025-01", "2026-02")   # 14 months
        with self.assertRaises(HTTPException):
            month_list("2026-03", "2026-02")
        with self.assertRaises(HTTPException):
            month_list("2026-13", "2026-12")

    def test_summarize_adds_months_and_keeps_currencies_apart(self):
        out = summarize([(m, PEOPLE, cards(m)) for m in ("2026-09", "2026-10")], {"pat@x.com": "Technician"})
        names = [p["name"] for p in out["people"]]
        self.assertEqual(names, ["Pat Hourly", "Sal Fixed"], "nobody with no wages and no hours")
        pat, sal = out["people"]
        self.assertEqual((pat["title"], pat["payType"], pat["rate"], pat["rateChanged"]), ("Technician", "hourly", 26.0, True))
        self.assertEqual((pat["regMin"], pat["otMin"], pat["dtMin"], pat["overtimeMin"], pat["sickMin"], pat["wages"]), (9600, 240, 60, 300, 960, 5000.0))
        self.assertEqual((sal["payType"], sal["rate"], sal["currency"]), ("salary", 90000.0, "INR"))
        self.assertEqual((sal["regMin"], sal["otMin"]), (18120, 0), "a salaried person's worked time is all regular")
        self.assertEqual([(g["label"], g["currency"], g["wages"]) for g in out["totals"]], [("Total", "INR", 176000.0), ("Total", "USD", 5000.0)])
        self.assertEqual([g["label"] for g in out["byCompany"]], ["Greens Global", "Greens India"])
        self.assertEqual([g["label"] for g in out["byDepartment"]], ["Accounts", "Maintenance"])

    def test_payroll_classification(self):
        self.assertEqual(payroll_class("expense", "Payroll Taxes"), "taxes")
        self.assertEqual(payroll_class("expense", "FICA - Employer"), "taxes")
        self.assertEqual(payroll_class("expense", "Employee Health Insurance"), "benefits")
        self.assertEqual(payroll_class("expense", "401(k) Match"), "benefits")
        self.assertEqual(payroll_class("cogs", "Salaries & Wages"), "wages")
        self.assertEqual(payroll_class("expense", "Bonus"), "wages")
        self.assertIsNone(payroll_class("expense", "Contract Labor"))
        self.assertIsNone(payroll_class("expense", "Property Insurance"))
        self.assertIsNone(payroll_class("liability", "Accrued Payroll"))

    def test_ledger_rows(self):
        rows = [
            {"bucket": "9100", "section": "expense", "account_no": "60000", "title": "Salaries", "debit": 1000, "credit": 0},
            {"bucket": "9100", "section": "expense", "account_no": "60500", "title": "Payroll Taxes", "debit": 80, "credit": 0},
            {"bucket": "9100", "section": "expense", "account_no": "61000", "title": "Rent", "debit": 500, "credit": 0},
            {"bucket": "", "section": "expense", "account_no": "60700", "title": "Health Benefits", "debit": 200, "credit": 20},
        ]
        out = ledger_rows(rows, {"9100": "Maintenance"})
        self.assertEqual([(g["label"], g["wages"], g["taxes"], g["benefits"], g["total"]) for g in out["rows"]],
                         [("Maintenance", 1000.0, 80.0, 0.0, 1080.0), ("Unassigned", 0.0, 0.0, 180.0, 180.0)])
        self.assertEqual(out["totals"]["total"], 1260.0)


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_F, name="Comp Test Full", allowed_modules="accounting:full"))
            db.add(models.NexusGroup(id=GROUP_V, name="Comp Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroupMember(group_id=GROUP_F, email=FULL))
            db.add(models.NexusGroupMember(group_id=GROUP_F, email=LIMITED))
            db.add(models.NexusGroupMember(group_id=GROUP_V, email=VIEWER))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

        def fake_people(db, month):
            return PEOPLE, cards(month)

        async def fake_get(path, params):
            self.assertTrue(path.endswith("/reports/buckets"))
            return {"ok": True, "rows": [{"bucket": "9100", "section": "expense", "account_no": "60000", "title": "Salaries", "debit": 1000, "credit": 0}],
                    "labels": {"9100": "Maintenance"}}

        self._people, accounting_allocations._people_and_cards = accounting_allocations._people_and_cards, fake_people
        self._get, accounting._acct_get = accounting._acct_get, fake_get

    def tearDown(self):
        accounting_allocations._people_and_cards, accounting._acct_get = self._people, self._get
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_F, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_F, GROUP_V))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email == LIMITED).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_viewer_and_nobody_are_refused(self):
        for who in (VIEWER, NOBODY):
            _as(who)
            self.assertEqual(self.client.get("/accounting/compensation/people?from=2026-09&to=2026-10").status_code, 403, who)
            self.assertEqual(self.client.get("/accounting/compensation/ledger?from=2026-09&to=2026-10").status_code, 403, who)

    def test_limited_full_person_is_refused(self):
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/compensation/people?from=2026-09&to=2026-10").status_code, 403)

    def test_full_level_reads_people_and_ledger(self):
        _as(FULL)
        r = self.client.get("/accounting/compensation/people?from=2026-09&to=2026-10")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["from"], d["to"], d["months"]), ("2026-09-01", "2026-10-31", ["2026-09", "2026-10"]))
        self.assertEqual(len(d["people"]), 2)
        r = self.client.get("/accounting/compensation/ledger?from=2026-09&to=2026-10&by=department")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["rows"][0]["label"], "Maintenance")
        self.assertEqual(self.client.get("/accounting/compensation/ledger?from=2026-09&to=2026-10&by=vendor").status_code, 400)


if __name__ == "__main__":
    unittest.main()
