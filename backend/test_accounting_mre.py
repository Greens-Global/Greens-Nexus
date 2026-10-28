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
import asyncio
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
from routers import accounting, accounting_loans, accounting_mre, accounting_partners, acct_scan
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


def _cover(code):
    """`code` and every entity under it, like the accounting app's entity filter."""
    out = {code}
    for e in ENTITIES:
        if e["parent_code"] in out or e["code"].startswith(f"{code}-"):
            out.add(e["code"])
    return out


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

    def test_semi_annual_custom_and_variance(self):
        # Oct 14 (Neil): Semi-Annual, and Custom every N months from the start month.
        due = lambda line: [m for m in range(1, 13) if accounting_mre.due_in_month(line, 2026, m)]  # noqa: E731
        self.assertEqual(due({"frequency": "semi_annual", "startDate": "2025-03-01", "endDate": "", "status": "active"}), [3, 9])
        self.assertEqual(due({"frequency": "custom", "frequencyMonths": 2, "startDate": "2026-01-10", "endDate": "", "status": "active"}), [1, 3, 5, 7, 9, 11])
        self.assertEqual(due({"frequency": "custom", "frequencyMonths": 4, "startDate": "2025-11-01", "endDate": "", "status": "active"}), [3, 7, 11])
        self.assertEqual(due({"frequency": "custom", "frequencyMonths": 0, "startDate": "2026-01-01", "endDate": "", "status": "active"}), list(range(1, 13)))
        # Variance %: paid within it of expected is Paid.
        s = accounting_mre.month_status
        self.assertEqual(s(True, 100, 92, "2026-01", "2026-06"), "short")
        self.assertEqual(s(True, 100, 92, "2026-01", "2026-06", 10), "paid")
        self.assertEqual(s(True, 100, 108, "2026-01", "2026-06", 10), "paid")
        self.assertEqual(s(True, 100, 112, "2026-01", "2026-06", 10), "over")

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
        self.fail_codes: set = set()     # Oct 7: entities whose reads fail
        self.slow_codes: set = set()     # entities whose reads hang
        self.aggregate = False           # whether the accounting app answers the aggregate op ("broken": it errors)
        self.aggregate_reads = 0
        self.aggregate_asked = []
        acct_scan._AGG_DOWN.clear()
        self._ceilings = (acct_scan.READ_CEILING, acct_scan.SCAN_CEILING)

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/party-months"):
                if not self.aggregate:
                    return {"ok": True}          # an older accounting app: no rows, so not there
                if self.aggregate == "broken":
                    raise HTTPException(status_code=424, detail="Accounting service: busy")
                self.aggregate_reads += 1
                rows = []
                secs = clean["sections"].split(",") if clean.get("sections") else list(acct_scan.SECTIONS)
                parties = set(clean["parties"].split(",")) if clean.get("parties") else None
                accts = set(clean["accounts"].split(",")) if clean.get("accounts") else None
                asked = [clean["location"]] if clean.get("location") else clean["locations"].split(",") if clean.get("locations") else None
                ents = sorted(self.postings) if asked is None else sorted({c for a in asked for c in _cover(a)})   # an entity brings its children
                self.aggregate_asked.append(asked)
                for ent in ents:
                    for vendor, months in self.postings.get(ent, {}).items():
                        if parties is not None and vendor not in parties:
                            continue
                        for m, cell in months.items():
                            for acct, v in cell.items():
                                if _in(m, clean["from"], clean["to"]) and TITLES[acct][0] in secs and (accts is None or acct in accts):
                                    rows.append({"location": ent, "gl_code": acct, "title": TITLES[acct][1], "section": TITLES[acct][0], "party": vendor,
                                                 "month": m, "debit": v, "credit": 0, "lines": 1})
                return {"ok": True, "kind": clean["kind"], "rows": rows}
            loc = clean.get("location")
            if loc in self.fail_codes:
                raise HTTPException(status_code=424, detail="That covers too many ledger lines to finish in time.")
            if loc in self.slow_codes:
                await asyncio.sleep(5)
            if path.endswith("/reports/pnl"):
                sections = {}
                for c in PNL.get(loc, []):
                    sections.setdefault(TITLES[c][0], []).append({"account_no": c, "title": TITLES[c][1], "amount": 1})
                return {"ok": True, "sections": [{"key": k, "accounts": v} for k, v in sections.items()]}
            if path.endswith("/reports/buckets"):
                rows = []
                for vendor, months in [vm for c in _cover(loc) for vm in self.postings.get(c, {}).items()]:
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
        acct_scan.READ_CEILING, acct_scan.SCAN_CEILING = self._ceilings
        acct_scan._AGG_DOWN.clear()
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

    def _paid(self, year):
        d = self.client.get(f"/accounting/mre/grid?year={year}").json()
        return {(r["line"]["entityCode"], r["line"]["vendorId"]): {c["month"]: c.get("paid") for c in r["months"]} for r in d["rows"]}, d

    def test_grid_reads_every_line_in_one_grouped_read(self):
        # Oct 22 (Urmi, Vinod, Neil): one ledger read per line took MRE past the
        # browser's wait ("Can't reach Nexus"). The grouped read must give the
        # same paid amounts as the one-line reads, a parent with its children.
        _as(EDITOR)
        self.postings["12027"] = {}      # lines carry their own entity; the parent has none of its own
        self._line()
        self._line(vendorId="V-STATE", expenseAccounts=["62500"], category="insurance", frequency="quarterly", expectedAmount=1200)
        self._line(entityCode="56000", vendorId="V-MSFT", expenseAccounts=["65000"], category="software", expectedAmount=99)
        self._line(entityCode="12027", vendorId="V-EDISON", expenseAccounts=["62100"], expectedAmount=250)
        year = int(LAST[:4])
        slow, _ = self._paid(year)                       # the accounting app without the grouped op
        self.assertEqual(len([c for c in self.calls if c[0].endswith("/reports/buckets")]), 4)
        self.calls.clear()
        acct_scan._AGG_DOWN.clear()
        self.aggregate = True
        fast, d = self._paid(year)
        self.assertEqual(fast, slow)
        self.assertNotIn("warning", d)
        self.assertEqual((self.aggregate_reads, [c for c in self.calls if c[0].endswith("/reports/buckets")]), (1, []))
        # No entity filter (prod: any entity filter ran past the accounting app's
        # statement limit); only the lines' own expense accounts.
        [read] = [c[1] for c in self.calls if c[0].endswith("/reports/party-months")]
        self.assertEqual((self.aggregate_asked, read.get("location"), read.get("locations"), read["accounts"]), ([None], None, None, "62100,62500,65000"))
        # Another entity's postings for the same vendor never land on our lines.
        self.assertEqual(fast[("15000", "V-SDGE")][LAST], 410.0)
        self.assertEqual(fast[("12027", "V-EDISON")][LAST], 250.0)      # the child's line counts on the parent
        self.assertEqual(fast[("15000", "V-SDGE")][LAST], 410.0)

    def test_grid_falls_back_to_one_read_per_line(self):
        _as(EDITOR)
        self._line()
        self.aggregate = "broken"
        year = int(LAST[:4])
        paid, d = self._paid(year)
        self.assertEqual(paid[("15000", "V-SDGE")][LAST], 410.0)
        self.assertNotIn("warning", d)
        reads = [c[1] for c in self.calls if c[0].endswith("/reports/buckets")]
        self.assertEqual([(c["location"], c["vendor"]) for c in reads], [("15000", "V-SDGE")])

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

    # ── Oct 7 (Charmi: "stuck at 133 of 142 entities" for 5+ minutes) ──
    def test_an_entity_that_hangs_is_reported_and_the_rest_shown(self):
        _as(EDITOR)
        acct_scan.READ_CEILING = 0.4
        self.slow_codes = {"15000"}
        started = time.monotonic()
        d = self._settled().json()
        self.assertLess(time.monotonic() - started, 4.0)
        self.assertEqual((d["entitiesScanned"], d["entitiesRead"]), (3, 2))
        self.assertEqual([(f["code"], f["reason"]) for f in d["failed"]], [("15000", "took too long to read")])
        self.assertEqual(d["status"], "Read 2 of 3 entities - 1 could not be read.")
        self.assertEqual({p["vendorId"] for p in d["proposals"]}, {"V-MSFT", "V-EDISON"})
        # Retry: just the one, once it answers; a create from it needs no new scan.
        self.slow_codes = set()
        d2 = self._settled(f"{URL}?entities=15000").json()
        self.assertEqual((d2["entitiesScanned"], d2["failed"]), (1, []))
        reads = len(self.calls)
        made = self.client.post("/accounting/mre/from-ledger/create", json={"items": [{"entityCode": "15000", "vendorId": "V-SDGE"}, {"entityCode": "56000", "vendorId": "V-MSFT"}]})
        self.assertEqual((made.status_code, len(made.json()["created"])), (201, 2), made.text)
        self.assertEqual(len([c for c in self.calls[reads:] if c[0].endswith("/reports/buckets")]), 0)

    def test_a_failing_entity_is_reported(self):
        _as(EDITOR)
        self.fail_codes = {"56000"}
        d = self._settled().json()
        self.assertEqual([f["code"] for f in d["failed"]], ["56000"])
        self.assertIn("too many ledger lines", d["failed"][0]["reason"])
        self.assertEqual(d["source"], "scan")

    def test_the_aggregate_op_replaces_the_scan(self):
        _as(EDITOR)
        self.aggregate = True
        d = self._settled().json()
        self.assertEqual((d["source"], d["failed"]), ("aggregate", []))
        got = {(p["entityCode"], p["vendorId"]): p for p in d["proposals"]}
        self.assertEqual(set(got), {("15000", "V-SDGE"), ("15000", "V-STATE"), ("56000", "V-MSFT"), ("12027-1", "V-EDISON")})
        self.assertEqual((got[("15000", "V-SDGE")]["expectedAmount"], got[("15000", "V-STATE")]["frequency"]), (410.0, "quarterly"))
        self.assertEqual(self._pnl_calls(), [])       # no line reads at all
        agg = [c[1] for c in self.calls if c[0].endswith("/reports/party-months")]
        self.assertEqual((len(agg), agg[0]["kind"], agg[0]["sections"]), (1, "vendor", "cogs,expense,other_expense"))


    def test_new_fields_round_trip_and_are_validated(self):
        # Oct 14 (Charmi, Urmi, Neil): the new categories and frequencies, Variance %,
        # the account number / details and the contact with the vendor.
        _as(EDITOR)
        r = self._line(category="property_tax", frequency="custom", frequencyMonths=2, variancePct=15, accountNumber="ACCT-0042",
                       accountDetails="Meter 7, autopay", contactInfo="Jane Doe, 800-555-0100, jane@vendor.example")
        self.assertEqual(r.status_code, 201, r.text)
        line = r.json()
        self.assertEqual((line["category"], line["frequency"], line["frequencyMonths"], line["variancePct"]), ("property_tax", "custom", 2, 15))
        self.assertEqual((line["accountNumber"], line["accountDetails"], line["contactInfo"]), ("ACCT-0042", "Meter 7, autopay", "Jane Doe, 800-555-0100, jane@vendor.example"))
        for cat in ("mortgage", "dues_subscriptions", "advertising", "auto_registration", "state_tax"):
            self.assertEqual(self._line(category=cat, frequency="semi_annual").status_code, 201)
        self.assertEqual(self._line(frequency="custom").status_code, 400)               # a custom frequency needs its period
        self.assertEqual(self._line(variancePct=7).status_code, 400)                    # steps of 5
        self.assertEqual(self._line(variancePct=55).status_code, 400)
        row = next(r for r in self.client.get("/accounting/mre/grid").json()["rows"] if r["line"]["id"] == line["id"])
        self.assertEqual(row["line"]["variancePct"], 15)


class PossiblyEndedRule1028(unittest.TestCase):
    """Charmi, 10/27 call, item 06: monthly - 3 missed months in a row; annual -
    nothing by the 13th month after the last payment; quarterly / semi-annual -
    one cycle and a month. A flag that can no longer be judged clears."""
    TODAY = date(2026, 10, 28)
    ENTITY = "STALE-1028"

    def _line(self, frequency="monthly", start="2025-01-01", **kw):
        return {"id": kw.pop("id", str(uuid.uuid4())), "entityCode": self.ENTITY, "entityName": "Stale Test", "vendorId": kw.pop("vendorId", "V00037"),
                "vendorName": "AAA Insurance", "expenseAccounts": ["62501"], "frequency": frequency, "frequencyMonths": kw.pop("frequencyMonths", 0),
                "startDate": start, "endDate": "", "status": "active", **kw}

    def _stale(self, line, posted, months=3):
        import recurring_stale
        win = recurring_stale.mre_window(self.TODAY, months, accounting_mre.step_months(line))
        back = recurring_stale.lookback(self.TODAY, win)
        return recurring_stale.judge(posted, win, back)[0]

    def test_windows(self):
        import recurring_stale
        def w(freq, n=0):
            return recurring_stale.mre_window(self.TODAY, 3, accounting_mre.step_months({"frequency": freq, "frequencyMonths": n}))
        self.assertEqual(w("monthly"), ["2026-07", "2026-08", "2026-09"])
        self.assertEqual((len(w("quarterly")), len(w("semi_annual")), len(w("annual")), len(w("custom", 2))), (4, 7, 13, 3))
        self.assertEqual(w("annual")[0], "2025-09")
        # The setting still sets a monthly line's months (Urmi set 5 on 10/27).
        self.assertEqual(len(recurring_stale.mre_window(self.TODAY, 5, 1)), 5)

    def test_monthly_paid_in_any_of_the_last_three_months_is_never_flagged(self):
        line = self._line()
        for m in ("2026-07", "2026-08", "2026-09"):
            self.assertFalse(self._stale(line, {m: 120.0}), m)
        # Three missed in a row: Possibly Ended.
        self.assertTrue(self._stale(line, {"2026-06": 120.0}))
        # This month's payment does not count yet - only complete months - but nothing else changes.
        self.assertTrue(self._stale(line, {"2026-06": 120.0, "2026-10": 120.0}))

    def test_annual_flags_only_after_the_13th_month(self):
        line = self._line("annual")
        self.assertFalse(self._stale(line, {"2025-09": 8257.0}))     # 12 months since: due, not late yet
        self.assertTrue(self._stale(line, {"2025-08": 8257.0}))      # 13 months with nothing: Possibly Ended
        self.assertFalse(self._stale(line, {"2026-04": 688.08}))

    def test_quarterly_and_semi_annual_one_cycle_and_a_month(self):
        self.assertFalse(self._stale(self._line("quarterly"), {"2026-06": 300.0}))
        self.assertTrue(self._stale(self._line("quarterly"), {"2026-05": 300.0}))
        self.assertFalse(self._stale(self._line("semi_annual"), {"2026-03": 300.0}))
        self.assertTrue(self._stale(self._line("semi_annual"), {"2026-02": 300.0}))

    def test_aaa_insurance_is_not_a_candidate_and_its_old_flag_clears(self):
        """AAA Insurance V00037 / 14001 as it is on prod: Annual from 04/01/2026,
        paid every month Jan - Jul, flagged 10/21 with last paid 12/2025."""
        import recurring_stale
        aaa = self._line("annual", start="2026-04-01", id="aaa-1028")
        monthly = self._line(id="monthly-1028", vendorId="V00004")
        cands = recurring_stale.mre_candidates([aaa, monthly], self.TODAY, 3)
        self.assertEqual([l["id"] for l, _w in cands], ["monthly-1028"])
        self.assertEqual([(r["id"], r["stale"]) for r in recurring_stale.mre_unjudged([aaa, monthly], cands, self.TODAY)], [("aaa-1028", False)])
        # An ended line is the "marked ended" path, not this one.
        self.assertEqual(recurring_stale.mre_unjudged([{**aaa, "status": "ended"}], [], self.TODAY), [])

    def test_the_check_clears_a_flag_left_from_before_an_edit(self):
        import recurring_stale
        db = database.SessionLocal()
        try:
            db.query(models.RecurringExpense).filter(models.RecurringExpense.entity_code == self.ENTITY).delete()
            rid = str(uuid.uuid4())
            db.add(models.RecurringExpense(id=rid, entity_code=self.ENTITY, entity_name="Stale Test", vendor_id="V00037", vendor_name="AAA Insurance",
                                           expense_accounts=["62501"], frequency="annual", expected_amount=8257.0, start_date="2026-04-01", status="active",
                                           stale_since="2026-10-21", stale_last_paid="2025-12", stale_task_id="", created_by=EDITOR))
            db.commit()
        finally:
            db.close()

        async def grouped(scope, pairs, year, accounts):
            return {p: {} for p in pairs}, []
        orig = accounting_mre._grid_payments
        accounting_mre._grid_payments = grouped
        try:
            results = asyncio.run(recurring_stale._mre_results(self.TODAY, 3))
        finally:
            accounting_mre._grid_payments = orig
        mine = [r for r in results if r["id"] == rid]
        self.assertEqual([r["stale"] for r in mine], [False])
        recurring_stale.apply("mre", mine, self.TODAY, 3)
        db = database.SessionLocal()
        try:
            row = db.query(models.RecurringExpense).filter(models.RecurringExpense.id == rid).first()
            self.assertEqual((row.stale_since, row.stale_last_paid, row.status, row.frequency), ("", "", "active", "annual"))
            db.query(models.RecurringExpense).filter(models.RecurringExpense.entity_code == self.ENTITY).delete()
            db.commit()
        finally:
            db.close()


class SpotCheck1028(unittest.TestCase):
    """Charmi, 10/27 call, item 06 spot-check (mre-spotcheck.md in the call
    folder): California Fair Plan V05293 / 10003 is set up Monthly 1,035.00 but
    Intacct has one annual premium, 1,035.00 on 07/30/2026 ("2026-2027") - so
    Jan - Jun and Aug - Sep read Missed. Set up Annual from 07/2026 (the edit
    proposed to Charmi) the same posting reads Paid and nothing is Missed."""
    TODAY = date(2026, 10, 28)

    def _line(self, **kw):
        return {"id": "fair-plan", "entityCode": "10003", "entityName": "(G) 26382 Palisades Drive, DP", "vendorId": "V05293",
                "vendorName": "California Fair Plan", "expenseAccounts": ["62507"], "category": "insurance", "frequencyMonths": 0,
                "variancePct": 25, "expectedAmount": 1035.0, "endDate": "", "status": "active", **kw}

    def test_fair_plan_monthly_against_one_annual_charge(self):
        posted = {("10003", "V05293"): {"2026-07": {"62507": 1035.0}}}
        as_is = accounting_mre.grid([self._line(frequency="monthly", startDate="2026-01-01")], posted, 2026, self.TODAY)["rows"][0]
        self.assertEqual(as_is["monthsMissed"], 8)
        self.assertEqual(as_is["months"][6]["status"], "paid")
        fixed = accounting_mre.grid([self._line(frequency="annual", startDate="2026-07-01")], posted, 2026, self.TODAY)["rows"][0]
        self.assertEqual(fixed["monthsMissed"], 0)
        self.assertEqual([c["status"] for c in fixed["months"]][6], "paid")
        self.assertEqual(fixed["balance"], 0)


if __name__ == "__main__":
    unittest.main()
