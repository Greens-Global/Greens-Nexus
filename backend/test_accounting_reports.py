"""Accounting > Reports proxy, Oct 7 batch (Charmi / Neil) - as tests.

- item 31: the ledger search passes the report's dimension filters on
  (departments, vendor, customer, employee, project, item), so a General
  Ledger with a vendor picked lists that vendor's lines only.
- item 35: a user-defined Intacct book (fmv, kje ...) travels as `book`;
  GET /accounting/books lists the books, {available: false} on a 404.
- items 23 / 26c: every report key on the screen is accepted by memorized
  reports - Flux Analysis and the Statement of Cash Flows included.

    python -m pytest test_accounting_reports.py -q      (one file per process)
"""
import os
import pathlib
import re
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, accounting_saved

models.Base.metadata.create_all(bind=database.engine)

VIEWER = "viewer.reports.test@greensglobal.com"   # accounting:viewer, no entity limit
GROUP = "grp-reports-test-viewer"


class ReportsProxyTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP, name="Reports Test Viewers", allowed_modules="accounting:viewer"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=VIEWER))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.calls = []
        self._get = accounting._acct_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

        async def fake_get(path, params):
            self.calls.append((path, dict(params)))
            if path == "/api/internal/books" and getattr(self, "books_missing", False):
                raise accounting.UpstreamError(404, "Accounting service returned 404")
            if path == "/api/internal/books":
                return {"ok": True, "books": [
                    {"id": "accrual", "code": "ACCRUAL", "title": "Accrual", "kind": "standard", "journals": []},
                    {"id": "cash", "code": "CASH", "title": "Cash", "kind": "standard", "journals": []},
                    {"id": "fmv", "code": "FMV", "title": "Fair Market Journal", "kind": "user", "journals": ["fmvca"]},
                    {"id": "bad key!", "title": "Refused"},
                ]}
            if path == "/api/internal/reports/budget" and getattr(self, "budget_missing", False):
                raise accounting.UpstreamError(404, "Accounting service returned 404")
            if path == "/api/internal/accounts" and getattr(self, "accounts_missing", False):
                raise accounting.UpstreamError(404, "Accounting service returned 404")
            if path == "/api/internal/accounts":
                return {"ok": True, "accounts": [{"account_no": "61000", "title": "Advertising", "section": "expense", "active": True, "secret": "x"},
                                                 {"account_no": "11000", "title": "Chase", "section": "asset", "active": False}]}
            if path == "/api/internal/reports/buckets" and getattr(self, "accounts_missing", False):
                return {"ok": True, "rows": [{"account_no": "61000", "title": "Advertising", "section": "expense", "debit": 1, "credit": 0},
                                             {"account_no": "61000", "title": "Advertising", "section": "expense", "debit": 2, "credit": 0}]}
            if path == "/api/internal/reports/budget":
                return {"ok": True, "budget_id": "STD", "budgets": [], "rows": [{"account_no": "41000", "section": "revenue", "month": "2026-01-01", "amount": 10}], "total": 10}
            return {"ok": True, "rows": [], "total": 0}
        accounting._acct_get = fake_get

    def tearDown(self):
        accounting._acct_get = self._get
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
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
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email == VIEWER).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    # CR-12: Records > General Ledger Accounts.
    def test_accounts_list_the_chart_and_fall_back_to_the_ledger(self):
        r = self.client.get("/accounting/accounts")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["source"], "chart")
        self.assertEqual([a["account_no"] for a in r.json()["accounts"]], ["11000", "61000"])
        self.assertNotIn("secret", r.json()["accounts"][0])
        self.assertEqual(self.calls[-1], ("/api/internal/accounts", {"status": "all"}))
        accounting._ACCT_CACHE.clear()
        self.accounts_missing = True
        r = self.client.get("/accounting/accounts")
        self.assertEqual((r.json()["source"], [a["account_no"] for a in r.json()["accounts"]]), ("ledger", ["61000"]))

    def test_search_passes_the_dimension_filters(self):
        r = self.client.get("/accounting/search", params={"account": "12000", "from": "2026-01-01", "to": "2026-10-06", "vendor": "V05022", "departments": "9100,9200", "journals": "apj"})
        self.assertEqual(r.status_code, 200, r.text)
        path, params = self.calls[-1]
        self.assertEqual(path, "/api/internal/search")
        self.assertEqual(params["vendor"], "V05022")
        self.assertEqual(params["departments"], "9100,9200")
        self.assertEqual(params["journals"], "APJ")
        self.assertNotIn("customer", params)
        self.assertIsNone(params.get("locations"))

    def test_search_without_filters_sends_none(self):
        self.client.get("/accounting/search", params={"account": "12000"})
        _path, params = self.calls[-1]
        for k in ("departments", "vendor", "customer", "employee", "project", "item"):
            self.assertNotIn(k, params)

    def test_search_passes_the_amount_operators(self):
        r = self.client.get("/accounting/search", params={"account": "12000", "debit_op": "gt", "debit_v": "100", "credit_op": "between", "credit_v": "5", "credit_v2": "50"})
        self.assertEqual(r.status_code, 200, r.text)
        _path, params = self.calls[-1]
        self.assertEqual((params["debit_op"], params["debit_v"]), ("gt", 100.0))
        self.assertNotIn("debit_v2", params)
        self.assertEqual((params["credit_op"], params["credit_v"], params["credit_v2"]), ("between", 5.0, 50.0))
        self.assertEqual(self.client.get("/accounting/search", params={"account": "12000", "debit_op": "like", "debit_v": "1"}).status_code, 400)
        self.assertEqual(self.client.get("/accounting/search", params={"account": "12000", "debit_op": "between", "debit_v": "1"}).status_code, 400)

    def test_user_books_travel_and_bad_books_are_refused(self):
        r = self.client.get("/accounting/reports/trial-balance", params={"from": "2026-01-01", "to": "2026-09-30", "book": "FMV"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.calls[-1][1]["book"], "fmv")
        # accrual stays out of the query, as before (the dashboard's cache key).
        self.client.get("/accounting/reports/pnl", params={"from": "2026-01-01", "to": "2026-09-30", "book": "accrual"})
        self.assertIsNone(self.calls[-1][1].get("book"))
        r = self.client.get("/accounting/reports/pnl", params={"from": "2026-01-01", "to": "2026-09-30", "book": "fmv;drop"})
        self.assertEqual(r.status_code, 400)
        r = self.client.get("/accounting/search", params={"account": "12000", "book": "all"})
        self.assertEqual(r.status_code, 200)
        r = self.client.get("/accounting/search", params={"account": "12000", "book": "x" * 40})
        self.assertEqual(r.status_code, 400)

    def test_both_books_stay_refused_on_a_single_read(self):
        """10/15 (Charmi, Urmi: books on every report): "Accrual and Cash" is
        two reads side by side, never one - every single read refuses it, the
        ledger search included; the user books still travel everywhere."""
        rng = {"from": "2026-01-01", "to": "2026-09-30"}
        for path, params in (("/accounting/reports/pnl", rng), ("/accounting/reports/trial-balance", rng),
                             ("/accounting/reports/balance-sheet", {"asof": "2026-09-30"}),
                             ("/accounting/reports/buckets", {**rng, "by": "month"}),
                             ("/accounting/search", {"account": "12000"})):
            r = self.client.get(path, params={**params, "book": "both"})
            self.assertEqual(r.status_code, 400, path)
            r = self.client.get(path, params={**params, "book": "KJE"})
            self.assertEqual(r.status_code, 200, f"{path}: {r.text}")
            self.assertEqual(self.calls[-1][1]["book"], "kje", path)

    def test_books_list(self):
        r = self.client.get("/accounting/books")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertTrue(d["available"])
        self.assertEqual([b["key"] for b in d["books"]], ["accrual", "cash", "fmv"])
        self.assertEqual(d["books"][2], {"key": "fmv", "label": "Fair Market Journal", "kind": "user", "journals": ["FMVCA"]})

    def test_budget_for_actual_vs_budget(self):
        r = self.client.get("/accounting/reports/budget", params={"from": "2026-01-01", "to": "2026-09-30", "location": "13000"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["available"])
        self.assertEqual(r.json()["budget_id"], "STD")
        self.assertEqual(self.calls[-1][1]["location"], "13000")
        self.assertEqual(self.client.get("/accounting/reports/budget", params={"from": "2026-01-01", "to": "2026-09-30", "budget_id": "x;y"}).status_code, 400)
        self.budget_missing = True
        r = self.client.get("/accounting/reports/budget", params={"from": "2026-01-01", "to": "2026-09-30"})
        self.assertEqual(r.json(), {"available": False, "rows": [], "budgets": []})

    def test_books_not_built_yet(self):
        self.books_missing = True
        r = self.client.get("/accounting/books")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"available": False, "books": []})


class SavedReportKeysTests(unittest.TestCase):
    def test_every_report_on_the_screen_can_be_memorized(self):
        src = pathlib.Path(__file__).resolve().parent.parent / "frontend" / "src" / "components" / "accounting" / "reportModel.js"
        text = src.read_text(encoding="utf-8")
        block = text[text.index("export const REPORTS = ["):]
        block = block[:block.index("];")]
        keys = re.findall(r"key:\s*'([a-z-]+)'", block)
        self.assertIn("flux", keys)
        self.assertIn("cash-flow", keys)
        self.assertEqual(sorted(keys), sorted(accounting_saved._REPORTS))
        for k in keys:
            self.assertEqual(accounting_saved._config({"report": k})["report"], k)

    # Oct 23 (items 05 / 11): a Report Builder definition is memorized as a
    # versioned config; the statements' configs are checked as before.
    def test_report_builder_configs_are_versioned(self):
        from fastapi import HTTPException
        good = {"kind": "builder", "version": 1, "accounts": ["60100"], "groups": [{"name": "Line 8 Advertising", "accounts": ["61000", "61010"]}]}
        self.assertEqual(accounting_saved._config(good), good)
        self.assertEqual(accounting_saved._config({"kind": "builder", "version": 1})["kind"], "builder")
        for bad in (
            {**good, "version": 2},
            {"kind": "builder"},
            {**good, "accounts": "60100"},
            {**good, "accounts": [60100]},
            {**good, "groups": [{"name": "Line 8", "accounts": "61000"}]},
            {**good, "groups": ["Line 8"]},
            {**good, "accounts": [f"{n:05d}" for n in range(5000)]},
        ):
            with self.assertRaises(HTTPException):
                accounting_saved._config(bad)
        # Not a builder config: still needs a known report.
        with self.assertRaises(HTTPException):
            accounting_saved._config({"kind": "other", "version": 1})

    # CR-05 (Neil, 23 Oct): comparison columns; publishing is not sharing.
    def test_builder_comparisons_and_published_flag(self):
        from fastapi import HTTPException
        good = {"kind": "builder", "version": 1, "compare": ["prior_period", "prior_year"], "published": True}
        self.assertEqual(accounting_saved._config(good), good)
        for bad in ({**good, "compare": ["next_year"]}, {**good, "compare": "prior_year"}, {**good, "published": "yes"}):
            with self.assertRaises(HTTPException):
                accounting_saved._config(bad)
        draft = {"kind": "builder", "version": 1}
        self.assertEqual(accounting_saved._shared_builder(draft, False), draft)
        self.assertTrue(accounting_saved._shared_builder(draft, True)["published"])
        statement = {"report": "pnl"}
        self.assertEqual(accounting_saved._shared_builder(statement, True), statement)


OTHER = "other.reports.test@greensglobal.com"


class BuilderPublishTests(ReportsProxyTests):
    """A viewer saves and publishes; a published report stays the author's
    until Share With Everyone (the memorized report's `shared` flag)."""

    def setUp(self):
        super().setUp()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroupMember(group_id=GROUP, email=OTHER))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def _cleanup(self):
        super()._cleanup()
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.email == OTHER).delete(synchronize_session=False)
            db.query(models.AccountingSavedReport).filter(models.AccountingSavedReport.owner_email.in_((VIEWER, OTHER))).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_viewer_publishes_and_shares_separately(self):
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        cfg = {"kind": "builder", "version": 1, "accounts": ["61000"], "compare": ["prior_year"], "published": True}
        r = self.client.post("/accounting/saved-reports", json={"name": "Schedule C draft", "config": cfg, "shared": False})
        self.assertEqual(r.status_code, 201, r.text)
        rid = r.json()["id"]
        self.assertEqual((r.json()["shared"], r.json()["config"]["published"]), (False, True))
        os.environ["NEXUS_DEV_EMAIL"] = OTHER
        self.assertEqual([x for x in self.client.get("/accounting/saved-reports").json() if x["id"] == rid], [])
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        self.assertEqual(self.client.patch(f"/accounting/saved-reports/{rid}", json={"shared": True}).status_code, 200)
        os.environ["NEXUS_DEV_EMAIL"] = OTHER
        seen = [x for x in self.client.get("/accounting/saved-reports").json() if x["id"] == rid]
        self.assertEqual((len(seen), seen[0]["shared"], seen[0]["mine"]), (1, True, False))
        # A draft shared straight away is published by the share.
        os.environ["NEXUS_DEV_EMAIL"] = VIEWER
        r = self.client.post("/accounting/saved-reports", json={"name": "Shared draft", "config": {"kind": "builder", "version": 1}, "shared": True})
        self.assertTrue(r.json()["config"]["published"])


if __name__ == "__main__":
    unittest.main()
