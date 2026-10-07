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


if __name__ == "__main__":
    unittest.main()
