"""Accounting > Allocations (Neil, 10/01): the monthly payroll allocation
entry - the share math, the mapping, the run kept, and the Intacct GL
import file in the accounting app's bank-import layout.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_allocations.py -q
"""
import csv
import io
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
import intacct_gl  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers.accounting_allocations import _month_range, _split, build_preview  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

FULL = "full.alloc.test@greensglobal.com"       # accounting:full
VIEWER = "viewer.alloc.test@greensglobal.com"   # accounting:viewer - not enough
GROUP_F, GROUP_V = "grp-alloc-test-full", "grp-alloc-test-viewer"

MAPPING = {"journal": "GJ",
           "sites": {"s1": {"entity": "15000", "account": "60100"}, "s2": {"entity": "16000", "account": "60100"}},
           "companies": {"c1": {"entity": "12000", "account": "21500", "wageAccount": "60100"}},
           "offsite": {"entity": "", "account": ""}}
PEOPLE = [
    {"email": "pat@x.com", "name": "Pat Test", "payType": "hourly", "company": "c1", "companyName": "Greens Global", "department": "Maintenance", "employeeId": "GG-001", "currency": "USD"},
    {"email": "sal@x.com", "name": "Sal Fixed", "payType": "fixed", "company": "c1", "companyName": "Greens Global", "department": "Office", "employeeId": "GG-002", "currency": "USD"},
    {"email": "nobody@x.com", "name": "No Hours", "payType": "hourly", "company": "c1", "companyName": "Greens Global", "department": "", "employeeId": "", "currency": "USD"},
]
CARDS = {
    # 3 sites, 100.00 over 7 minutes: 1/7, 2/7, 4/7 - the last share takes the rounding.
    "pat@x.com": {"totals": {"totalPay": 100.0}, "byLocation": [{"workSiteId": "s1", "workSite": "Rental A", "workedMin": 1}, {"workSiteId": "s2", "workSite": "Rental B", "workedMin": 2}, {"workSiteId": "s1", "workSite": "Rental A", "workedMin": 4}]},
    "sal@x.com": {"totals": {"totalPay": 3000.0}, "byLocation": [], "currency": "USD"},
    "nobody@x.com": {"totals": {"totalPay": 0}, "byLocation": []},
}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class MathTests(unittest.TestCase):
    def test_month_range(self):
        self.assertEqual(_month_range("2026-09"), ("2026-09-01", "2026-09-30"))
        self.assertEqual(_month_range("2026-12"), ("2026-12-01", "2026-12-31"))
        self.assertEqual(_month_range("2028-02"), ("2028-02-01", "2028-02-29"))

    def test_split_adds_up_to_the_cent(self):
        self.assertEqual(_split(100.0, [1, 2, 4]), [14.29, 28.57, 57.14])
        self.assertEqual(sum(_split(100.0, [1, 2, 4])), 100.0)
        self.assertEqual(_split(10.0, [0, 0]), [0.0, 0.0])
        self.assertEqual(_split(0.0, []), [])

    def test_preview_allocates_by_hours_and_balances(self):
        pv = build_preview(None, "2026-09", MAPPING, CARDS, PEOPLE)
        self.assertEqual((pv["start"], pv["end"]), ("2026-09-01", "2026-09-30"))
        names = [p["name"] for p in pv["people"]]
        self.assertEqual(names, ["Pat Test", "Sal Fixed"], "a person with no wages and no hours is left out")
        pat = pv["people"][0]
        self.assertEqual([(s["workSite"], s["workedMin"], s["amount"], s["entity"]) for s in pat["sites"]],
                         [("Rental A", 1, 14.29, "15000"), ("Rental B", 2, 28.57, "16000"), ("Rental A", 4, 57.14, "15000")])
        self.assertEqual(sum(s["amount"] for s in pat["sites"]), 100.0)
        sal = pv["people"][1]
        self.assertEqual(sal["sites"][0]["workSite"], "Not allocated (no site hours)")
        self.assertEqual((sal["sites"][0]["amount"], sal["sites"][0]["entity"], sal["sites"][0]["account"]), (3000.0, "12000", "60100"))
        self.assertEqual(len(pv["entries"]), 1, "one entry per paying company")
        e = pv["entries"][0]
        self.assertEqual(e["description"], "Payroll allocation 09/2026 - Greens Global")
        self.assertEqual(e["date"], "2026-09-30")
        self.assertEqual([line["line_no"] for line in e["lines"]], [1, 2, 3, 4, 5, 6])
        credits = [line for line in e["lines"] if line["type"] == "credit"]
        self.assertEqual([(c["acct_no"], c["location_id"], c["credit"], c["dept_id"], c["employee_id"]) for c in credits],
                         [("21500", "12000", 100.0, "Maintenance", "GG-001"), ("21500", "12000", 3000.0, "Office", "GG-002")])
        self.assertEqual(pv["totals"], {"wages": 3100.0, "debits": 3100.0, "credits": 3100.0, "people": 2, "unmappedLines": 0})
        self.assertEqual(pv["unmapped"], {"sites": [], "companies": []})
        self.assertTrue(intacct_gl.balanced(pv["entries"]))
        self.assertIn("Pat Test - Rental B - 0.03 h of 0.12 h (28.6%)", [line["memo"] for line in e["lines"]])

    def test_preview_flags_what_is_unmapped(self):
        mapping = {"journal": "GJ", "sites": {"s1": {"entity": "15000", "account": "60100"}}, "companies": {}, "offsite": {}}
        pv = build_preview(None, "2026-09", mapping, CARDS, PEOPLE)
        self.assertEqual([s["name"] for s in pv["unmapped"]["sites"]], ["Rental B"])
        self.assertEqual([c["name"] for c in pv["unmapped"]["companies"]], ["Greens Global"])
        self.assertGreater(pv["totals"]["unmappedLines"], 0)
        self.assertFalse(all(line["mapped"] for line in pv["entries"][0]["lines"]))


class CsvLayoutTests(unittest.TestCase):
    def test_header_and_fields_match_the_accounting_app(self):
        # The exact 28 columns of src/lib/finance/intacct-gl-export.ts, in order.
        self.assertEqual(intacct_gl.INTACCT_GL_COLUMNS, (
            "DONOTIMPORT", "JOURNAL", "DATE", "REVERSEDATE", "DESCRIPTION", "REFERENCE_NO", "LINE_NO", "ACCT_NO", "LOCATION_ID", "DEPT_ID", "DOCUMENT", "MEMO",
            "DEBIT", "CREDIT", "SOURCEENTITY", "CURRENCY", "EXCH_RATE_DATE", "EXCH_RATE_TYPE_ID", "EXCHANGE_RATE", "STATE", "ALLOCATION_ID", "BILLABLE",
            "RPESENTRY", "GLENTRY_CUSTOMERID", "GLENTRY_VENDORID", "GLENTRY_ITEMID", "GLENTRY_CLASSID", "GLENTRY_EMPLOYEEID"))
        pv = build_preview(None, "2026-09", MAPPING, CARDS, PEOPLE)
        text = intacct_gl.to_csv(pv["entries"])
        self.assertTrue(text.endswith("\r\n"))
        rows = list(csv.reader(io.StringIO(text)))
        self.assertEqual(rows[0], list(intacct_gl.INTACCT_GL_COLUMNS))
        self.assertEqual(len(rows), 1 + 6)
        first, second = rows[1], rows[2]
        # Header fields on the entry's first line only; the date is MM-DD-YYYY.
        self.assertEqual(first[1:3], ["GJ", "09-30-2026"])
        self.assertEqual(first[4], "Payroll allocation 09/2026 - Greens Global")
        self.assertEqual(second[1:6], ["", "", "", "", ""])
        # Per-line fields: LINE_NO, ACCT_NO, LOCATION_ID, DEPT_ID, MEMO, DEBIT, CREDIT, SOURCEENTITY.
        self.assertEqual(first[6:10], ["1", "60100", "15000", "Maintenance"])
        self.assertEqual(first[11], "Pat Test - Rental A - 0.02 h of 0.12 h (14.3%)")
        self.assertEqual(first[12:15], ["14.29", "", "12000"])
        self.assertEqual(first[27], "GG-001")
        credit = rows[4]
        self.assertEqual(credit[7:10], ["21500", "12000", "Maintenance"])
        self.assertEqual(credit[12:14], ["", "100.00"])
        self.assertEqual(intacct_gl.intacct_date("2026-01-05"), "01-05-2026")
        self.assertEqual(intacct_gl.to_rows([]), [list(intacct_gl.INTACCT_GL_COLUMNS)])

    def test_cells_with_commas_and_quotes_are_quoted(self):
        text = intacct_gl.to_csv([{"journal": "GJ", "date": "2026-09-30", "description": 'Say "hi", twice', "lines": [{"acct_no": "1", "memo": "a, b", "debit": 1, "credit": None}]}])
        rows = list(csv.reader(io.StringIO(text)))
        self.assertEqual(rows[1][4], 'Say "hi", twice')
        self.assertEqual(rows[1][11], "a, b")


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_F, name="Alloc Test Full", allowed_modules="accounting:full"))
            db.add(models.NexusGroup(id=GROUP_V, name="Alloc Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroupMember(group_id=GROUP_F, email=FULL))
            db.add(models.NexusGroupMember(group_id=GROUP_V, email=VIEWER))
            db.add(models.HrWorkSite(id="s1", name="Rental A", latitude="33.6", longitude="-117.8", radius_m=150))
            db.add(models.HrEntity(id="c1", name="Greens Global"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def tearDown(self):
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
            db.query(models.HrWorkSite).filter(models.HrWorkSite.id == "s1").delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id == "c1").delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key == "accounting_allocations_map").delete(synchronize_session=False)
            db.query(models.AccountingAllocationRun).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_full_level_only(self):
        _as(VIEWER)
        self.assertEqual(self.client.get("/accounting/allocations/map").status_code, 403)
        self.assertEqual(self.client.get("/accounting/allocations/preview?month=2026-09").status_code, 403)

    def test_mapping_round_trip(self):
        _as(FULL)
        r = self.client.get("/accounting/allocations/map")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["map"], {"journal": "GJ", "sites": {}, "companies": {}, "offsite": {"entity": "", "account": ""}})
        self.assertEqual([s["name"] for s in r.json()["sites"]], ["Rental A"])
        self.assertEqual([c["name"] for c in r.json()["companies"]], ["Greens Global"])
        r = self.client.put("/accounting/allocations/map", json={"journal": " GJCA ", "sites": {"s1": {"entity": "15000", "account": "60100", "junk": 1}}, "companies": {"c1": {"entity": "12000", "account": "21500"}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["map"]["journal"], "GJCA")
        self.assertEqual(r.json()["map"]["sites"]["s1"], {"entity": "15000", "account": "60100", "wageAccount": ""})
        self.assertEqual(self.client.get("/accounting/allocations/map").json()["map"]["companies"]["c1"]["account"], "21500")

    def test_preview_on_an_empty_month_and_bad_month(self):
        _as(FULL)
        r = self.client.get("/accounting/allocations/preview?month=2026-09")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["people"], [])
        self.assertEqual(r.json()["entries"], [])
        self.assertEqual(self.client.get("/accounting/allocations/preview?month=Sept").status_code, 400)

    def test_run_is_kept_and_exported_in_the_shared_layout(self):
        _as(FULL)
        pv = build_preview(None, "2026-09", MAPPING, CARDS, PEOPLE)
        r = self.client.post("/accounting/allocations/runs", json={"month": "2026-09", "entity": "", "preview": pv})
        self.assertEqual(r.status_code, 201, r.text)
        rid = r.json()["id"]
        self.assertEqual(r.json()["totals"]["debits"], 3100.0)
        runs = self.client.get("/accounting/allocations/runs").json()["runs"]
        self.assertEqual([x["id"] for x in runs], [rid])
        self.assertEqual(runs[0]["by"], FULL)
        csv_r = self.client.get(f"/accounting/allocations/runs/{rid}/export.csv")
        self.assertEqual(csv_r.status_code, 200)
        self.assertIn("Intacct GL Import - Payroll Allocation - 2026-09.csv", csv_r.headers["content-disposition"])
        self.assertEqual(csv_r.text, intacct_gl.to_csv(pv["entries"]))
        xl = self.client.get(f"/accounting/allocations/runs/{rid}/export.xlsx")
        self.assertEqual(xl.status_code, 200)
        self.assertTrue(xl.content.startswith(b"PK"))
        # Unmapped or unbalanced previews are refused.
        bad = build_preview(None, "2026-09", {"journal": "GJ", "sites": {}, "companies": {}, "offsite": {}}, CARDS, PEOPLE)
        self.assertEqual(self.client.post("/accounting/allocations/runs", json={"month": "2026-09", "preview": bad}).status_code, 400)
        broken = dict(pv, entries=[dict(pv["entries"][0], lines=pv["entries"][0]["lines"][:-1])])
        self.assertEqual(self.client.post("/accounting/allocations/runs", json={"month": "2026-09", "preview": broken}).status_code, 400)
        self.assertEqual(self.client.delete(f"/accounting/allocations/runs/{rid}").status_code, 204)
        self.assertEqual(self.client.get("/accounting/allocations/runs").json()["runs"], [])


if __name__ == "__main__":
    unittest.main()
