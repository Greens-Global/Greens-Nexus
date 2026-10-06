"""Accounting -> Reporting -> MRE, monthly recurring expenses (Oct 6) - as tests.

The arithmetic (which accounts are recurring expenses - never debt service;
the expected amount from the last three posted months; a vendor qualifies
with N months at a stable amount; frequency; which months a line falls due;
paid / short / over / missed / upcoming), the From the Ledger scan (ACTIVE
leaf entities only, a background job with progress, one by=month read per
vendor or twelve by=vendor reads when there are many vendors, set up marked,
an idempotent create), the grid read from the ledger, the Notes column,
editor / full levels and entity scope on every read. The accounting service
is replaced by a recorder.

    python -m pytest test_accounting_mre.py -q
"""
import os
import time
import unittest
import uuid
from datetime import date

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, accounting_loans, accounting_mre, accounting_partners
from routers.accounting_loans import shift_month

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.mre.test@greensglobal.com"      # accounting:editor, no limit
VIEWER = "viewer.mre.test@greensglobal.com"      # accounting:viewer
LIMITED = "limited.mre.test@greensglobal.com"    # accounting:editor, entity 56000 only
FULL = "full.mre.test@greensglobal.com"          # accounting:full
EVERYONE = (EDITOR, VIEWER, LIMITED, FULL)
GROUPS = {"grp-mre-test-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-mre-test-v": ("accounting:viewer", (VIEWER,)), "grp-mre-test-f": ("accounting:full", (FULL,))}

ENTITIES = [
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
    {"code": "12027", "name": "(AM) (G) 910 S. El Camino Real, SC", "parent_code": None},      # a parent
    {"code": "12027-1", "name": "(AM) 910 S El Camino Real, Ste 100", "parent_code": "12027"},
    {"code": "H15500", "name": "Old Books Co", "parent_code": None},                             # historical by number
    {"code": "17000", "name": "Valley Center (H)", "parent_code": None},                         # historical by name
]
LEAVES = ["12027-1", "15000", "56000"]
TITLES = {"62100": ("expense", "Utilities - Electric"), "62500": ("expense", "Insurance - Property"), "68000": ("expense", "Interest Expense"),
          "61000": ("expense", "Repairs & Maintenance"), "65000": ("expense", "Software Subscriptions"), "41101": ("revenue", "Rental Income")}
PNL = {"15000": ["62100", "62500", "68000", "61000", "41101"], "56000": ["65000"], "12027-1": ["62100"], "12027": ["62100"], "H15500": ["62100"], "17000": ["62100"]}
LABELS = {"V-SDGE": "San Diego Gas & Electric", "V-STATE": "State Farm", "V-BANK": "F&M Bank", "V-FIX": "Handyman Joe", "V-MSFT": "Microsoft", "V-EDISON": "SC Edison"}
THIS = date.today().isoformat()[:7]
WINDOW = [shift_month(THIS, b) for b in range(11, -1, -1)]   # oldest first
LAST = WINDOW[-2]   # last month


def _months(n, amount, acct, end=LAST):
    """`n` consecutive months ending at `end`."""
    return {shift_month(end, b): {acct: amount} for b in range(n)}


POSTINGS = {
    "15000": {
        "V-SDGE": {**_months(9, 410.0, "62100"), shift_month(LAST, 9): {"62100": 500.0}},     # stable at 410
        "V-STATE": {shift_month(LAST, b): {"62500": 1200.0} for b in (0, 3, 6, 9)},           # quarterly, stable
        "V-BANK": _months(12, 900.0, "68000"),                                                # interest: Loans' business
        "V-FIX": {shift_month(LAST, 0): {"61000": 120.0}, shift_month(LAST, 2): {"61000": 980.0}, shift_month(LAST, 5): {"61000": 45.0}},   # not stable
    },
    "56000": {"V-MSFT": _months(6, 99.0, "65000")},
    "12027-1": {"V-EDISON": _months(4, 250.0, "62100")},
    "12027": {"V-EDISON": _months(4, 250.0, "62100")},     # the roll-up: never read
    "H15500": {"V-SDGE": _months(12, 50.0, "62100")},      # historical: never read
    "17000": {"V-SDGE": _months(12, 50.0, "62100")},
}
URL = "/accounting/mre/from-ledger/proposals"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _in(m, from_, to):
    return from_[:7] <= m <= to[:7]


class ArithmeticTests(unittest.TestCase):
    def test_historical_entities(self):
        self.assertTrue(accounting_mre.is_historical({"code": "H15500", "name": "x"}))
        self.assertTrue(accounting_mre.is_historical({"code": "17000", "name": "Valley Center (H)"}))
        self.assertFalse(accounting_mre.is_historical({"code": "15000", "name": "Hotel Operations"}))
        leaves, parents = accounting_mre.active_leaves(ENTITIES)
        self.assertEqual((sorted(e["code"] for e in leaves), parents), (LEAVES, 1))

    def test_expense_accounts_leave_debt_service_out(self):
        accts = [{"section": TITLES[c][0], "account_no": c, "title": TITLES[c][1]} for c in TITLES]
        self.assertEqual(sorted(a["account_no"] for a in accounting_mre.expense_accounts(accts)), ["61000", "62100", "62500", "65000"])
        self.assertEqual(accounting_mre.expense_accounts([{"section": "expense", "account_no": "69000", "title": "Depreciation Expense"}]), [])

    def test_typical_amount_and_stability(self):
        self.assertEqual(accounting_mre.typical_amount({"2026-01": 410, "2026-02": 410, "2026-03": 430}), 410.0)
        self.assertEqual(accounting_mre.typical_amount({"2026-01": 1, "2026-02": 2, "2026-03": 3}), 3.0)
        self.assertIsNone(accounting_mre.typical_amount({"2026-01": 0}))
        self.assertEqual(accounting_mre.stable_months({"a": 400, "b": 430, "c": 600}, 410.0), 2)

    def test_frequency(self):
        self.assertEqual(accounting_mre.guess_frequency(["2026-01", "2026-02", "2026-03"]), "monthly")
        self.assertEqual(accounting_mre.guess_frequency(["2026-01", "2026-04", "2026-07"]), "quarterly")
        self.assertEqual(accounting_mre.guess_frequency(["2026-01"]), "annual")

    def test_propose_needs_n_stable_months(self):
        accounts = [{"section": "expense", "account_no": "62100", "title": "Utilities - Electric"}]
        by_vendor = {"V1": {"2026-01": {"62100": 410.0}, "2026-02": {"62100": 410.0}, "2026-03": {"62100": 410.0}}, "V2": {"2026-01": {"62100": 10.0}, "2026-02": {"62100": 900.0}}}
        [p] = accounting_mre.propose({"code": "15000", "name": "E"}, accounts, by_vendor, {"V1": "Power Co"}, 3)
        self.assertEqual((p["vendorId"], p["vendorName"], p["expectedAmount"], p["frequency"], p["category"], p["stableMonths"], p["paid12"]),
                         ("V1", "Power Co", 410.0, "monthly", "utilities", 3, 1230.0))
        self.assertEqual(accounting_mre.propose({"code": "15000"}, accounts, by_vendor, {}, 4), [])

    def test_due_months_and_status(self):
        q = {"frequency": "quarterly", "startDate": "2026-02-15", "endDate": "", "status": "active"}
        self.assertEqual([m for m in range(1, 13) if accounting_mre.due_in_month(q, 2026, m)], [2, 5, 8, 11])
        a = {"frequency": "annual", "startDate": "2025-06-01", "endDate": "2026-12-31", "status": "active"}
        self.assertEqual([m for m in range(1, 13) if accounting_mre.due_in_month(a, 2026, m)], [6])
        ended = {"frequency": "monthly", "startDate": "2026-01-01", "endDate": "2026-03-31", "status": "ended"}
        self.assertEqual([m for m in range(1, 13) if accounting_mre.due_in_month(ended, 2026, m)], [1, 2, 3])
        s = accounting_mre.month_status
        self.assertEqual(s(True, 100, 100.4, "2026-01", "2026-06"), "paid")
        self.assertEqual(s(True, 100, 60, "2026-01", "2026-06"), "short")
        self.assertEqual(s(True, 100, 160, "2026-01", "2026-06"), "over")
        self.assertEqual(s(True, 100, 0, "2026-01", "2026-06"), "missed")
        self.assertEqual(s(True, 100, 0, "2026-06", "2026-06"), "upcoming")
        self.assertEqual(s(True, 100, 0, "2026-09", "2026-06"), "upcoming")
        self.assertEqual(s(False, 0, 0, "2026-01", "2026-06"), "none")
        self.assertEqual(s(False, 0, 50, "2026-01", "2026-06"), "over")

    def test_grid(self):
        line = {"id": "x", "entityCode": "15000", "vendorId": "V1", "expenseAccounts": ["62100"], "frequency": "monthly", "expectedAmount": 100.0,
                "startDate": "2026-01-01", "endDate": "", "status": "active"}
        pay = {("15000", "V1"): {"2026-01": {"62100": 100.0}, "2026-02": {"62100": 40.0, "61000": 999.0}}}
        g = accounting_mre.grid([line], pay, 2026, date(2026, 4, 10))
        [r] = g["rows"]
        self.assertEqual([c["status"] for c in r["months"][:5]], ["paid", "short", "missed", "upcoming", "upcoming"])
        self.assertEqual((r["paidTotal"], r["expectedToDate"], r["paidToDate"], r["balance"], r["monthsMissed"]), (140.0, 300.0, 140.0, 160.0, 1))
        self.assertEqual(g["summary"]["missed"], 1)
        g = accounting_mre.grid([line], {}, 2026, date(2026, 4, 10), unread={("15000", "V1")})
        self.assertEqual(g["rows"][0]["months"][0]["status"], "unknown")


class EndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (mods, members) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=mods))
                for em in members:
                    db.add(models.NexusGroupMember(group_id=gid, email=em))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="56000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting_loans._JOBS.clear()
        accounting._ACCT_CACHE.clear()
        self.calls = []
        self.postings = {k: dict(v) for k, v in POSTINGS.items()}

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            loc = clean.get("location")
            if path.endswith("/reports/pnl"):
                sections = {}
                for c in PNL.get(loc, []):
                    sections.setdefault(TITLES[c][0], []).append({"account_no": c, "title": TITLES[c][1], "amount": 1})
                return {"ok": True, "sections": [{"key": k, "accounts": v} for k, v in sections.items()]}
            if path.endswith("/reports/buckets"):
                rows = []
                for vendor, months in self.postings.get(loc, {}).items():
                    if clean.get("vendor") and vendor != clean["vendor"]:
                        continue
                    for m, cell in months.items():
                        if not _in(m, clean["from"], clean["to"]):
                            continue
                        for acct, v in cell.items():
                            bucket = vendor if clean["by"] == "vendor" else f"{m}-01"
                            rows.append({"bucket": bucket, "section": TITLES[acct][0], "account_no": acct, "title": TITLES[acct][1], "debit": v, "credit": 0})
                return {"ok": True, "rows": rows, "labels": LABELS if clean["by"] == "vendor" else {}}
            return {"ok": True}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"
        self.vendors = []

        async def fake_partners(params):
            return self.vendors
        self._partners, accounting_partners._get = accounting_partners._get, fake_partners

    def tearDown(self):
        accounting._acct_get = self._get
        accounting_partners._get = self._partners
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        accounting_loans._JOBS.clear()
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
            db.query(models.RecurringExpense).filter(models.RecurringExpense.created_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _settled(self, url=URL, timeout=10.0):
        end = time.monotonic() + timeout
        while True:
            r = self.client.get(url)
            if r.status_code != 202 or time.monotonic() > end:
                return r
            time.sleep(0.05)

    def _pnl_calls(self):
        return [c[1]["location"] for c in self.calls if c[0].endswith("/reports/pnl")]

    def _line(self, **kw):
        body = {"entityCode": "15000", "entityName": "Greens Escondido, LLC.", "vendorId": "V-SDGE", "vendorName": "San Diego Gas & Electric",
                "expenseAccounts": ["62100"], "category": "utilities", "frequency": "monthly", "expectedAmount": 410, "startDate": f"{date.today().year}-01-01"}
        body.update(kw)
        return self.client.post("/accounting/mre/lines", json=body)

    def test_scan_reads_active_leaves_only_and_proposes_stable_vendors(self):
        _as(EDITOR)
        first = self.client.get(URL)
        self.assertIn(first.status_code, (200, 202), first.text)
        r = self._settled()
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["entitiesScanned"], d["parentsSkipped"], d["historicalSkipped"], d["minCount"]), (3, 1, 2, 3))
        self.assertEqual(sorted(self._pnl_calls()), LEAVES)     # never the parent, never an (H) entity
        got = {(p["entityCode"], p["vendorId"]): p for p in d["proposals"]}
        # Interest (Loans' business) and the unstable handyman are not proposed.
        self.assertEqual(set(got), {("15000", "V-SDGE"), ("15000", "V-STATE"), ("56000", "V-MSFT"), ("12027-1", "V-EDISON")})
        s = got[("15000", "V-SDGE")]
        self.assertEqual((s["vendorName"], s["expectedAmount"], s["frequency"], s["category"], s["expenseAccounts"], s["postedMonths"], s["stableMonths"], s["status"]),
                         ("San Diego Gas & Electric", 410.0, "monthly", "utilities", ["62100"], 10, 9, "new"))
        q = got[("15000", "V-STATE")]
        self.assertEqual((q["frequency"], q["category"], q["expectedAmount"]), ("quarterly", "insurance", 1200.0))
        self.assertEqual(got[("56000", "V-MSFT")]["category"], "software")
        # A higher bar: five stable months leaves State Farm and Edison (four each) out.
        d5 = self._settled(f"{URL}?min=5").json()
        self.assertEqual({p["vendorId"] for p in d5["proposals"]}, {"V-SDGE", "V-MSFT"})

    def test_scan_for_picked_entities_and_scope(self):
        _as(EDITOR)
        d = self._settled(f"{URL}?entities=56000").json()
        self.assertEqual(([p["vendorId"] for p in d["proposals"]], d["entitiesScanned"]), (["V-MSFT"], 1))
        _as(LIMITED)
        d = self._settled().json()
        self.assertEqual({p["entityCode"] for p in d["proposals"]}, {"56000"})
        self.assertEqual(self.client.get(f"{URL}?entities=15000").status_code, 403)

    def test_many_vendors_read_month_by_month(self):
        _as(EDITOR)
        self.postings["56000"] = {f"V-{i:02d}": _months(4, 10.0 + i, "65000") for i in range(15)}
        d = self._settled(f"{URL}?entities=56000").json()
        self.assertEqual(len(d["proposals"]), 15)
        reads = [c[1] for c in self.calls if c[0].endswith("/reports/buckets") and c[1]["location"] == "56000"]
        self.assertEqual(len([c for c in reads if c["by"] == "vendor"]), 13)     # the window + one per month
        self.assertEqual([c for c in reads if c["by"] == "month"], [])

    def test_create_from_ledger_once(self):
        _as(EDITOR)
        self._settled()
        body = {"items": [{"entityCode": "15000", "vendorId": "V-SDGE"}, {"entityCode": "15000", "vendorId": "V-FIX"}, {"entityCode": "15000", "vendorId": "V-STATE", "category": "other"}]}
        r = self.client.post("/accounting/mre/from-ledger/create", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(sorted(c["vendorId"] for c in r.json()["created"]), ["V-SDGE", "V-STATE"])
        self.assertEqual(r.json()["skipped"][0]["why"], "no recurring postings for this vendor on the ledger")
        r = self.client.post("/accounting/mre/from-ledger/create", json=body)
        self.assertEqual((r.json()["created"], [s["why"] for s in r.json()["skipped"]]), ([], ["already set up", "no recurring postings for this vendor on the ledger", "already set up"]))
        rows = {x["line"]["vendorId"]: x["line"] for x in self.client.get("/accounting/mre/grid").json()["rows"]}
        self.assertEqual((rows["V-SDGE"]["source"], rows["V-SDGE"]["expectedAmount"], rows["V-SDGE"]["startDate"], rows["V-STATE"]["category"]),
                         ("ledger", 410.0, f"{shift_month(LAST, 9)}-01", "other"))
        got = {p["vendorId"]: p["status"] for p in self._settled().json()["proposals"] if p["entityCode"] == "15000"}
        self.assertEqual(got, {"V-SDGE": "set_up", "V-STATE": "set_up"})

    def test_grid_reads_paid_from_the_ledger(self):
        _as(EDITOR)
        self.assertEqual(self._line().status_code, 201)
        year = date.today().year
        d = self.client.get(f"/accounting/mre/grid?year={year}").json()
        [row] = d["rows"]
        cells = {c["month"]: c for c in row["months"]}
        if LAST.startswith(str(year)):
            self.assertEqual((cells[LAST]["paid"], cells[LAST]["status"]), (410.0, "paid"))
        self.assertEqual(cells[THIS]["status"], "upcoming")
        reads = [c[1] for c in self.calls if c[0].endswith("/reports/buckets")]
        self.assertEqual([(c["location"], c["vendor"], c["by"]) for c in reads], [("15000", "V-SDGE", "month")])
        self.assertFalse(row["vendorInactive"])
        # Intacct marks the vendor inactive: the row says so (Customize > Show Inactive Vendors).
        self.vendors = [{"id": "V-SDGE", "name": "San Diego Gas & Electric", "status": "inactive"}]
        self.assertTrue(self.client.get(f"/accounting/mre/grid?year={year}").json()["rows"][0]["vendorInactive"])
        # An entity filter that leaves the line out.
        self.assertEqual(self.client.get("/accounting/mre/grid?entities=56000").json()["rows"], [])

    def test_grid_warns_when_the_ledger_cannot_be_read(self):
        _as(EDITOR)
        self._line()

        async def broken(path, params):
            raise HTTPException(status_code=424, detail="Accounting service: down")
        accounting._acct_get = broken
        d = self.client.get("/accounting/mre/grid").json()
        self.assertIn("could not be read", d["warning"])
        self.assertTrue(d["rows"][0]["unread"])

    def test_levels_notes_end_and_delete(self):
        _as(VIEWER)
        self.assertEqual(self._line().status_code, 403)
        _as(EDITOR)
        r = self._line(frequency="weekly")
        self.assertEqual(r.status_code, 400)
        line = self._line().json()
        r = self.client.put(f"/accounting/mre/lines/{line['id']}/notes", json={"notes": "Autopay on the 5th"})
        self.assertEqual((r.status_code, r.json()["notes"]), (200, "Autopay on the 5th"))
        r = self.client.post(f"/accounting/mre/lines/{line['id']}/end", json={"endDate": "2026-09-30"})
        self.assertEqual((r.json()["status"], r.json()["endDate"]), ("ended", "2026-09-30"))
        self.assertEqual(self.client.delete(f"/accounting/mre/lines/{line['id']}").status_code, 403)    # editors end; Full deletes
        _as(FULL)
        self.assertEqual(self.client.delete(f"/accounting/mre/lines/{line['id']}").status_code, 204)

    def test_limited_people_see_and_edit_their_entities_only(self):
        _as(EDITOR)
        other = self._line().json()
        self._line(entityCode="56000", vendorId="V-MSFT", expenseAccounts=["65000"], category="software", expectedAmount=99)
        _as(LIMITED)
        rows = self.client.get("/accounting/mre/grid").json()["rows"]
        self.assertEqual([r["line"]["entityCode"] for r in rows], ["56000"])
        self.assertEqual(self._line().status_code, 403)
        self.assertEqual(self.client.put(f"/accounting/mre/lines/{other['id']}/notes", json={"notes": "x"}).status_code, 403)
        self.assertEqual(self.client.get("/accounting/mre/grid?entities=15000").status_code, 403)

    def test_vendor_card(self):
        _as(EDITOR)
        self.vendors = [{"id": "V-SDGE", "name": "San Diego Gas & Electric", "phone": "800-411-7343", "email": "billing@sdge.example", "address": {"line1": "8326 Century Park Ct", "city": "San Diego", "state": "CA", "zip": "92123"}, "entity": ""},
                        {"id": "V-X", "name": "Elsewhere", "entity": "99999"}]
        v = self.client.get("/accounting/mre/vendors/V-SDGE").json()
        self.assertEqual((v["available"], v["vendor"]["phone"], v["vendor"]["address"]["city"]), (True, "800-411-7343", "San Diego"))

        async def missing(params):
            raise HTTPException(status_code=501, detail="Not available yet")
        accounting_partners._get = missing
        self.assertEqual(self.client.get("/accounting/mre/vendors/V-SDGE").json(), {"available": False, "vendor": None})


if __name__ == "__main__":
    unittest.main()
