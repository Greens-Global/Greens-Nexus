"""Accounting > Reporting > Profitability (Charmi + Neil, 10/15): the account
classification, the period math, debt service from Loans, the sub-entity
rollup, the prior-year comparison and who may read it.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_accounting_profitability.py -q
"""
import os
import tempfile
import unittest
import uuid

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, accounting_loans  # noqa: E402
from routers.accounting_profitability import (  # noqa: E402
    children_of, classify, debt_service_by_entity, measures, months_in, top_level, totals, year_back,
)

models.Base.metadata.create_all(bind=database.engine)

VIEWER = "viewer.profit.test@greensglobal.com"     # accounting:viewer
LIMITED = "limited.profit.test@greensglobal.com"   # accounting:viewer, entity 15000 only
NOBODY = "nobody.profit.test@greensglobal.com"     # no accounting grant
GROUP = "grp-profit-test-viewer"

ENTITIES = [
    {"code": "15000", "name": "Sunset Plaza", "parent_code": None},
    {"code": "15000-1", "name": "Sunset Plaza Retail", "parent_code": None},
    {"code": "15000-2", "name": "Sunset Plaza Office", "parent_code": None},
    {"code": "56000", "name": "Harbor Apartments", "parent_code": None},
    {"code": "56100", "name": "Harbor Garage", "parent_code": "56000"},
]


def acct(bucket, section, no, title, debit=0, credit=0):
    return {"bucket": bucket, "section": section, "account_no": no, "title": title, "debit": debit, "credit": credit}


CUR = [
    acct("15000", "revenue", "40100", "Rental Income", credit=1000),
    acct("15000", "other_income", "48000", "Late Fees", credit=50),
    acct("15000", "expense", "60100", "Repairs", debit=300),
    acct("15000", "expense", "62000", "Mortgage Interest", debit=100),
    acct("15000", "expense", "68000", "Depreciation Expense", debit=150),
    acct("15000", "asset", "10100", "Operating Cash", debit=999),
    acct("56000", "revenue", "40100", "Rental Income", credit=500),
    acct("56000", "cogs", "50100", "Utilities", debit=200),
    acct("15000-1", "revenue", "40100", "Rental Income", credit=400),
]
PRIOR = [
    acct("15000", "revenue", "40100", "Rental Income", credit=800),
    acct("15000", "expense", "60100", "Repairs", debit=200),
    acct("56000", "revenue", "40100", "Rental Income", credit=500),
]
LOANS = [
    {"id": "l1", "entity_code": "15000-1", "monthly_pi": 10, "is_active": True},
    {"id": "l2", "entity_code": "15000", "monthly_pi": 5, "is_active": True},
    {"id": "l3", "entity_code": "15000", "monthly_pi": 1000, "is_active": False},
    {"id": "l4", "entity_code": "56000", "monthly_pi": 0, "is_active": True},
]


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class MathTests(unittest.TestCase):
    def test_classification(self):
        self.assertEqual(classify("revenue", "Rent"), "revenue")
        self.assertEqual(classify("other_income", "Interest Income"), "revenue")
        self.assertEqual(classify("expense", "Mortgage Interest"), "interest")
        self.assertEqual(classify("other_expense", "Amortization of Loan Costs"), "da")
        self.assertEqual(classify("expense", "Depreciation"), "da")
        self.assertEqual(classify("cogs", "Utilities"), "opex")
        self.assertIsNone(classify("liability", "Mortgage Payable"))

    def test_measures_add_up_to_net_income(self):
        m = measures([a for a in CUR if a["bucket"] == "15000"])
        self.assertEqual((m["revenue"], m["opex"], m["noi"]), (1050.0, 300.0, 750.0))
        self.assertEqual((m["interest"], m["da"], m["netIncome"]), (100.0, 150.0, 500.0))
        self.assertEqual(m["noiMargin"], round(750 / 1050 * 100, 2))
        self.assertEqual([a["account"] for a in m["accounts"]["revenue"]], ["40100", "48000"])
        self.assertIsNone(measures([])["noiMargin"], "no revenue, no margin")

    def test_months_and_year_back(self):
        self.assertEqual(months_in("2026-01-01", "2026-12-31"), 12.0)
        self.assertEqual(months_in("2026-09-01", "2026-09-15"), 0.5)
        self.assertEqual(months_in("2026-01-15", "2026-01-14"), 0.0)
        self.assertEqual(year_back("2028-02-29"), "2027-02-28")
        self.assertEqual(year_back("2026-12-31"), "2025-12-31")

    def test_entity_tree(self):
        self.assertEqual(top_level(ENTITIES), ["15000", "56000"])
        self.assertEqual(children_of(ENTITIES, "15000"), ["15000-1", "15000-2"])
        self.assertEqual(children_of(ENTITIES, "56000"), ["56100"])

    def test_debt_service_is_scheduled_payment_times_months(self):
        ds = debt_service_by_entity(LOANS, ENTITIES, ["15000", "15000-1", "56000"], 12)
        self.assertEqual(ds["15000"], 180.0, "the sub-entity's loan rolls into the parent; inactive loans are left out")
        self.assertEqual(ds["15000-1"], 120.0)
        self.assertIsNone(ds["56000"], "no payment set = blank, not zero")

    def test_totals_skip_sub_entity_rows(self):
        rows = [{"parent": None, "current": {"revenue": 10, "opex": 2, "noi": 8, "interest": 1, "da": 1, "netIncome": 6, "debtService": 3}},
                {"parent": "x", "current": {"revenue": 4, "opex": 0, "noi": 4, "interest": 0, "da": 0, "netIncome": 4, "debtService": None}}]
        t = totals(rows, "current")
        self.assertEqual((t["revenue"], t["netIncome"], t["debtService"], t["cashFlowAfterDebt"]), (10.0, 6.0, 3.0, 5.0))


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Profit Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=VIEWER))
            db.add(models.NexusGroupMember(group_id=GROUP, email=LIMITED))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.calls = []

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/buckets"):
                rows = CUR if clean["from"].startswith("2026") else PRIOR
                want = set(([clean["location"]] if clean.get("location") else []) + (clean.get("locations") or "").split(","))
                want.discard("")
                if want:
                    rows = [r for r in rows if r["bucket"] in want]
                else:
                    rows = [r for r in rows if r["bucket"] in ("15000", "56000")]
                return {"ok": True, "org": "Greens Global", "rows": rows, "labels": {}}
            raise AssertionError(f"unexpected read {path}")

        async def fake_loans(scope, month):
            return LOANS

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._loans, accounting_loans._loan_rows = accounting_loans._loan_rows, fake_loans

    def tearDown(self):
        accounting._acct_get, accounting_loans._loan_rows = self._get, self._loans
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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email == LIMITED).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_no_accounting_grant_is_refused(self):
        _as(NOBODY)
        self.assertEqual(self.client.get("/accounting/profitability?from=2026-01-01&to=2026-12-31").status_code, 403)

    def test_sheet_with_prior_year(self):
        _as(VIEWER)
        r = self.client.get("/accounting/profitability?from=2026-01-01&to=2026-12-31")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual([x["code"] for x in d["rows"]], ["15000", "56000"])
        plaza = d["rows"][0]
        self.assertEqual(plaza["name"], "Sunset Plaza")
        self.assertEqual((plaza["current"]["noi"], plaza["current"]["netIncome"]), (750.0, 500.0))
        self.assertEqual(plaza["current"]["debtService"], 180.0)
        self.assertEqual(plaza["current"]["cashFlowAfterDebt"], 570.0)
        self.assertEqual(plaza["prior"]["netIncome"], 600.0)
        self.assertEqual(plaza["change"]["netIncome"], {"amount": -100.0, "pct": round(-100 / 600 * 100, 2)})
        self.assertNotIn("accounts", plaza["prior"])
        self.assertEqual(d["totals"]["current"]["revenue"], 1550.0)
        self.assertEqual((d["priorFrom"], d["priorTo"]), ("2025-01-01", "2025-12-31"))

    def test_sub_entities_do_not_double_the_totals(self):
        _as(VIEWER)
        d = self.client.get("/accounting/profitability?from=2026-01-01&to=2026-12-31&locations=15000&expand=true").json()
        self.assertEqual([(x["code"], x["parent"]) for x in d["rows"]], [("15000", None), ("15000-1", "15000"), ("15000-2", "15000")])
        self.assertEqual(d["totals"]["current"]["revenue"], 1050.0)
        bucket_reads = [c for p, c in self.calls if p.endswith("/buckets")]
        self.assertEqual(bucket_reads[0]["locations"], "15000,15000-1,15000-2")

    def test_limited_person(self):
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/profitability?from=2026-01-01&to=2026-12-31&locations=56000").status_code, 403)
        d = self.client.get("/accounting/profitability?from=2026-01-01&to=2026-12-31").json()
        self.assertEqual([x["code"] for x in d["rows"]], ["15000"])

    def test_bad_dates(self):
        _as(VIEWER)
        self.assertEqual(self.client.get("/accounting/profitability?from=2026-12-31&to=2026-01-01").status_code, 400)
        self.assertEqual(self.client.get("/accounting/profitability?from=2026-13-01&to=2026-12-31").status_code, 400)


if __name__ == "__main__":
    unittest.main()
