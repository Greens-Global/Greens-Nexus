"""Accounting: entity-level access, the book selector, column filters,
memorized reports and reporting packages (Neil and Charmi, Sep 25) - as tests.

A person with the Accounting grant and nexus_access_scopes rows (module
'accounting') reads only those entities and what sits under them: asking for
nothing answers with their own set, asking for an entity outside it is 403,
the consolidated dashboard and the accounting app are closed to them. A grant
without rows stays open. The accounting service itself is replaced by a
recorder - these tests never leave the machine.

    python -m unittest test_accounting_access
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import accounting_sso
import auth
import cache
import database
import main
import models
from routers import accounting, accounting_dashboard

models.Base.metadata.create_all(bind=database.engine)

OPEN = "open.acct.test@greensglobal.com"          # accounting:viewer, no limit
LIMITED = "limited.acct.test@greensglobal.com"    # accounting:viewer, entities 15000 + 56000
ONE = "one.acct.test@greensglobal.com"            # accounting:viewer, entity 15000 only
MANAGER = "manager.acct.test@greensglobal.com"    # accounting:full
GROUP_V = "grp-acct-test-viewer"
GROUP_F = "grp-acct-test-full"
EVERYONE = (OPEN, LIMITED, ONE, MANAGER)

ENTITIES = [
    {"code": "12000", "name": "Greens Global, Inc.", "parent_code": None},
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "15000-1", "name": "Escondido Unit 1", "parent_code": None},      # Intacct child-code convention
    {"code": "15900", "name": "Escondido Annex", "parent_code": "15000"},      # parent chain
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
    {"code": "90000", "name": "Family Trust", "parent_code": None},
]
ENTRY = "11111111-2222-3333-4444-555555555555"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class AccountingAccessTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GROUP_V, name="Accounting Test Viewers", allowed_modules="accounting:viewer,accounting-app:viewer"))
            db.add(models.NexusGroup(id=GROUP_F, name="Accounting Test Managers", allowed_modules="accounting:full"))
            for em in (OPEN, LIMITED, ONE):
                db.add(models.NexusGroupMember(group_id=GROUP_V, email=em))
            db.add(models.NexusGroupMember(group_id=GROUP_F, email=MANAGER))
            for em, codes in ((LIMITED, ("15000", "56000")), (ONE, ("15000",))):
                for code in codes:
                    db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=em, module_id="accounting", scope_type="ledger", scope_id=code))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

        # The accounting service, recorded instead of called.
        self.calls = []
        self.entry_lines = [{"location": "15000"}, {"location": "15000-1"}]

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/cash-position"):
                bal = {"15000": 100.25, "56000": 50.5}.get(clean.get("location"), 1000.0)
                return {"ok": True, "location": clean.get("location"), "total": bal,
                        "accounts": [{"gl_code": "10100", "account_name": "Operating", "balance": bal, "last_activity": f"2026-09-{'20' if clean.get('location') == '56000' else '10'}"}]}
            if path.endswith("/entry"):
                return {"ok": True, "entry": {"id": ENTRY}, "lines": self.entry_lines, "intacct": []}
            return {"ok": True, "echo": clean}

        self._get = accounting._acct_get
        accounting._acct_get = fake_get
        self._dash = accounting_dashboard._get

        async def fake_dash(op, params):
            return {"ok": True, "op": op}
        accounting_dashboard._get = fake_dash
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        accounting._acct_get = self._get
        accounting_dashboard._get = self._dash
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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_((GROUP_V, GROUP_F))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_((GROUP_V, GROUP_F))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingReportPackage).filter(models.AccountingReportPackage.owner_email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingSavedReport).filter(models.AccountingSavedReport.owner_email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingUserPref).filter(models.AccountingUserPref.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.action == "accounting_entity_access_set", models.AuditLog.resource_id.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _sent(self, path_end):
        return [p for (path, p) in self.calls if path.endswith(path_end)]

    # ── reports ─────────────────────────────────────────────────────────────
    def test_open_caller_passes_through(self):
        _as(OPEN)
        r = self.client.get("/accounting/reports/pnl?from=2026-09-01&to=2026-09-25&location=90000")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._sent("/reports/pnl")[-1], {"from": "2026-09-01", "to": "2026-09-25", "location": "90000"})
        self.client.get("/accounting/reports/pnl?from=2026-09-01&to=2026-09-25")
        self.assertEqual(self._sent("/reports/pnl")[-1], {"from": "2026-09-01", "to": "2026-09-25"})

    def test_book(self):
        _as(OPEN)
        self.client.get("/accounting/reports/balance-sheet?asof=2026-09-25&book=cash")
        self.assertEqual(self._sent("/reports/balance-sheet")[-1], {"asof": "2026-09-25", "book": "cash"})
        # Accrual is the accounting app's default and is left off.
        self.client.get("/accounting/reports/trial-balance?from=2026-09-01&to=2026-09-25&book=accrual")
        self.assertNotIn("book", self._sent("/reports/trial-balance")[-1])
        self.assertEqual(self.client.get("/accounting/reports/pnl?from=2026-09-01&to=2026-09-25&book=both").status_code, 400)

    def test_limited_caller_asking_for_nothing_gets_their_own_entities(self):
        _as(LIMITED)
        r = self.client.get("/accounting/reports/pnl?from=2026-09-01&to=2026-09-25")
        self.assertEqual(r.status_code, 200, r.text)
        sent = self._sent("/reports/pnl")[-1]
        self.assertEqual(sent.get("locations"), "15000,56000")
        self.assertNotIn("location", sent)

    def test_one_entity_travels_as_location(self):
        # `locations` with a single code is read as "no filter" by the accounting
        # app's fast path - a single entity must always be `location`.
        _as(ONE)
        self.client.get("/accounting/reports/trial-balance?from=2026-09-01&to=2026-09-25")
        sent = self._sent("/reports/trial-balance")[-1]
        self.assertEqual(sent.get("location"), "15000")
        self.assertNotIn("locations", sent)

    def test_limited_caller_cannot_reach_outside(self):
        _as(LIMITED)
        for url in ("/accounting/reports/pnl?from=2026-09-01&to=2026-09-25&location=90000",
                    "/accounting/reports/pnl?from=2026-09-01&to=2026-09-25&locations=15000,12000",
                    "/accounting/reports/balance-sheet?asof=2026-09-25&location=12000",
                    "/accounting/reports/cash-position?location=90000",
                    "/accounting/search?q=amazon&location=12000"):
            r = self.client.get(url)
            self.assertEqual(r.status_code, 403, url)
        self.assertEqual([p for (path, p) in self.calls if not path.endswith("/reports/locations")], [], "nothing may reach the accounting service")

    def test_children_come_with_the_entity(self):
        _as(ONE)
        for child in ("15000-1", "15900"):
            r = self.client.get(f"/accounting/reports/pnl?from=2026-09-01&to=2026-09-25&location={child}")
            self.assertEqual(r.status_code, 200, child)
            self.assertEqual(self._sent("/reports/pnl")[-1].get("location"), child)

    def test_locations_list_is_filtered(self):
        _as(ONE)
        r = self.client.get("/accounting/reports/locations").json()
        self.assertEqual(sorted(e["code"] for e in r["entities"]), ["15000", "15000-1", "15900"])
        self.assertTrue(r["limited"])
        _as(OPEN)
        self.assertEqual(len(self.client.get("/accounting/reports/locations").json()["entities"]), len(ENTITIES))

    def test_cash_position_adds_up_several_entities(self):
        _as(LIMITED)
        r = self.client.get("/accounting/reports/cash-position?asof=2026-09-25").json()
        self.assertEqual(r["total"], 150.75)
        self.assertEqual(r["accounts"], [{"gl_code": "10100", "account_name": "Operating", "balance": 150.75, "last_activity": "2026-09-20"}])
        self.assertEqual(sorted(p["location"] for p in self._sent("/reports/cash-position")), ["15000", "56000"])

    def test_columns_are_held_to_the_same_limit(self):
        # The Columns layouts (By Month, By Entity ...) read through one route.
        _as(OPEN)
        r = self.client.get("/accounting/reports/buckets?from=2026-01-01&to=2026-09-28&by=month&book=cash&vendor=V1")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._sent("/reports/buckets")[-1], {"from": "2026-01-01", "to": "2026-09-28", "by": "month", "book": "cash", "vendor": "V1"})
        # A balance sheet column has no start.
        self.client.get("/accounting/reports/buckets?to=2026-09-28&by=entity")
        self.assertEqual(self._sent("/reports/buckets")[-1], {"to": "2026-09-28", "by": "entity"})
        self.assertEqual(self.client.get("/accounting/reports/buckets?to=2026-09-28&by=weekday").status_code, 400)
        _as(LIMITED)
        self.client.get("/accounting/reports/buckets?to=2026-09-28&by=entity")
        self.assertEqual(self._sent("/reports/buckets")[-1], {"to": "2026-09-28", "by": "entity", "locations": "15000,56000"})
        self.assertEqual(self.client.get("/accounting/reports/buckets?to=2026-09-28&by=entity&location=12000").status_code, 403)
        _as(ONE)
        self.client.get("/accounting/reports/buckets?to=2026-09-28&by=department")
        self.assertEqual(self._sent("/reports/buckets")[-1], {"to": "2026-09-28", "by": "department", "location": "15000"})

    # ── search, entry ───────────────────────────────────────────────────────
    def test_search_limit_and_column_filters(self):
        _as(LIMITED)
        r = self.client.get('/accounting/search', params={"q": "amazon", "cols": '{"description": " %amazon ", "debit": ".55", "nonsense": "x", "date": ""}'})
        self.assertEqual(r.status_code, 200, r.text)
        sent = self._sent("/search")[-1]
        self.assertEqual(sent["locations"], "15000,56000")
        self.assertEqual(sent["cols"], '{"debit": ".55", "description": "%amazon"}')
        self.assertEqual(self.client.get('/accounting/search', params={"q": "amazon", "cols": "not json"}).status_code, 400)
        self.assertEqual(self.client.get('/accounting/search', params={"q": "amazon", "cols": "[1]"}).status_code, 400)

    def test_entry_with_a_line_outside_is_closed(self):
        _as(ONE)
        self.assertEqual(self.client.get(f"/accounting/entry/{ENTRY}").status_code, 200)
        self.entry_lines = [{"location": "15000"}, {"location": "90000"}]
        self.assertEqual(self.client.get(f"/accounting/entry/{ENTRY}").status_code, 403)
        _as(OPEN)
        self.assertEqual(self.client.get(f"/accounting/entry/{ENTRY}").status_code, 200)

    # ── consolidated surfaces ───────────────────────────────────────────────
    def test_dashboard_and_app_are_closed_to_a_limited_caller(self):
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/dashboard/entities").status_code, 403)
        self.assertEqual(self.client.get("/accounting/dashboard/ledger?from=2026-01-01&to=2026-09-30").status_code, 403)
        self.assertEqual(self.client.post("/accounting/launch").status_code, 403)
        _as(OPEN)
        self.assertEqual(self.client.get("/accounting/dashboard/entities").status_code, 200)

    def test_sso_sync_leaves_limited_people_out(self):
        emails = accounting_sso.qualifying_emails()
        self.assertIn(OPEN, emails)
        self.assertNotIn(LIMITED, emails)
        self.assertNotIn(ONE, emails)

    def test_access_me(self):
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/access/me").json(), {"limited": True, "entities": ["15000", "56000"]})
        _as(OPEN)
        self.assertEqual(self.client.get("/accounting/access/me").json(), {"limited": False, "entities": []})

    # ── who sets the limits ─────────────────────────────────────────────────
    def test_setting_limits(self):
        _as(OPEN)
        self.assertEqual(self.client.get("/accounting/access").status_code, 403)
        self.assertEqual(self.client.put(f"/accounting/access/{ONE}", json={"entities": []}).status_code, 403)
        _as(MANAGER)
        people = {p["email"]: p for p in self.client.get("/accounting/access").json()["people"]}
        self.assertEqual(people[LIMITED]["entities"], ["15000", "56000"])
        self.assertEqual(people[OPEN]["entities"], [])
        r = self.client.put(f"/accounting/access/{OPEN}", json={"entities": ["56000", " 12000 ", "56000", ""]})
        self.assertEqual(r.json(), {"email": OPEN, "entities": ["12000", "56000"]})
        _as(OPEN)
        self.assertEqual(self.client.get("/accounting/reports/pnl?from=2026-09-01&to=2026-09-25&location=90000").status_code, 403)
        _as(MANAGER)
        self.client.put(f"/accounting/access/{OPEN}", json={"entities": []})
        _as(OPEN)
        self.assertEqual(self.client.get("/accounting/reports/pnl?from=2026-09-01&to=2026-09-25&location=90000").status_code, 200)
        # Nobody lifts their own limit.
        _as(MANAGER)
        self.assertEqual(self.client.put(f"/accounting/access/{MANAGER}", json={"entities": []}).status_code, 400)
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AuditLog).filter(models.AuditLog.action == "accounting_entity_access_set", models.AuditLog.resource_id == OPEN).count(), 2)
        finally:
            db.close()

    # ── memorized reports and packages ──────────────────────────────────────
    def test_memorized_reports(self):
        cfg = {"report": "pnl", "preset": "ytd", "book": "cash", "entities": ["15000"], "dims": {"vendor": ["V1"]}}
        _as(OPEN)
        a = self.client.post("/accounting/saved-reports", json={"name": " GG Inc Income Statement ", "config": cfg})
        self.assertEqual(a.status_code, 201, a.text)
        self.assertEqual(a.json()["name"], "GG Inc Income Statement")
        # The same name again replaces it.
        b = self.client.post("/accounting/saved-reports", json={"name": "GG Inc Income Statement", "config": {**cfg, "book": "accrual"}})
        self.assertEqual(b.json()["id"], a.json()["id"])
        self.assertEqual(len(self.client.get("/accounting/saved-reports").json()), 1)
        self.assertEqual(self.client.post("/accounting/saved-reports", json={"name": "x", "config": {"report": "nope"}}).status_code, 400)
        self.assertEqual(self.client.post("/accounting/saved-reports", json={"name": "  ", "config": cfg}).status_code, 400)
        rid = a.json()["id"]
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/saved-reports").json(), [])
        self.assertEqual(self.client.delete(f"/accounting/saved-reports/{rid}").status_code, 404)
        _as(OPEN)
        self.client.patch(f"/accounting/saved-reports/{rid}", json={"shared": True})
        _as(LIMITED)
        seen = self.client.get("/accounting/saved-reports").json()
        self.assertEqual([(r["id"], r["mine"]) for r in seen], [(rid, False)])
        self.assertEqual(self.client.delete(f"/accounting/saved-reports/{rid}").status_code, 403)
        _as(OPEN)
        self.assertEqual(self.client.delete(f"/accounting/saved-reports/{rid}").status_code, 204)

    def test_packages(self):
        _as(OPEN)
        r1 = self.client.post("/accounting/saved-reports", json={"name": "Income Statement", "config": {"report": "pnl"}}).json()["id"]
        r2 = self.client.post("/accounting/saved-reports", json={"name": "Balance Sheet", "config": {"report": "balance-sheet"}}).json()["id"]
        p = self.client.post("/accounting/packages", json={"name": "F&M Bank - Valley Center", "items": [{"reportId": r2}, {"reportId": r1, "title": "Income Statement - YTD"}]})
        self.assertEqual(p.status_code, 201, p.text)
        self.assertEqual([(i["reportId"], i["title"], i["missing"]) for i in p.json()["items"]],
                         [(r2, "Balance Sheet", False), (r1, "Income Statement - YTD", False)])
        self.assertEqual(self.client.post("/accounting/packages", json={"name": "x", "items": [{"reportId": "not-a-report"}]}).status_code, 400)
        # A deleted report leaves a visible gap, not a shorter package.
        self.client.delete(f"/accounting/saved-reports/{r1}")
        items = self.client.get("/accounting/packages").json()[0]["items"]
        self.assertEqual([(i["reportId"], i["missing"]) for i in items], [(r2, False), (r1, True)])
        pid = p.json()["id"]
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/packages").json(), [])
        self.assertEqual(self.client.delete(f"/accounting/packages/{pid}").status_code, 404)
        _as(OPEN)
        self.assertEqual(self.client.put(f"/accounting/packages/{pid}", json={"name": "Renamed", "items": [{"reportId": r2}]}).json()["name"], "Renamed")
        self.assertEqual(self.client.delete(f"/accounting/packages/{pid}").status_code, 204)

    def test_layout_is_each_persons_own(self):
        _as(OPEN)
        self.assertEqual(self.client.get("/accounting/prefs").json(), {"prefs": {}})
        layout = {"lines": {"hidden": ["doc"], "widths": {"description": 520}}, "density": "condensed"}
        self.assertEqual(self.client.put("/accounting/prefs", json={"prefs": layout}).json(), {"prefs": layout})
        self.assertEqual(self.client.get("/accounting/prefs").json(), {"prefs": layout})
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/prefs").json(), {"prefs": {}})
        self.assertEqual(self.client.put("/accounting/prefs", json={"prefs": {"x": "y" * 7000}}).status_code, 400)

    def test_upstream_reason_reaches_the_screen(self):
        class R:
            status_code = 500

            def __init__(self, body):
                self._body = body

            def json(self):
                if self._body is None:
                    raise ValueError("not json")
                return self._body
        self.assertIn("too many ledger lines", accounting._upstream_detail(R({"ok": False, "error": "canceling statement due to statement timeout"})))
        self.assertEqual(accounting._upstream_detail(R({"ok": False, "error": "org not found"})), "Accounting service: org not found")
        self.assertEqual(accounting._upstream_detail(R(None)), "Accounting service returned 500")


if __name__ == "__main__":
    unittest.main()
