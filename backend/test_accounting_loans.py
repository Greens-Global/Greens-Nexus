"""Accounting -> Loans & Financing (Neil and Charmi, 10/02; Oct 6 feedback) - as tests.

Which liability accounts are loans (the classifier, with the real titles of
the 10/02 live run: credit cards named after their bank are not loans below
GL 25000; Oct 6: "Due to <entity>" and other intercompany payables ARE),
the ledger's sign (a liability owed arrives negative; owed = -amount), leaf
and ACTIVE entities only (a parent rolls its children up; a historical (H)
entity is not scanned), the review read from a small fake ledger (principal
paid = the debits to the loan's account, interest = its own interest account
matched by title or wired by hand, original principal = the first credit,
closed loans flagged), the proposals as a background job (202 with the
progress, then the result, kept until a create; a failed job answers 424
once and starts over), an idempotent create through the dashboard's row-save,
a manual loan, the payment history, the Egnyte folder links, and entity
scope on every read. The accounting service is replaced by a fake ledger -
nothing leaves the machine.

    python -m pytest test_accounting_loans.py -q
"""
import asyncio
import os
import threading
import time
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, accounting_dashboard, accounting_loans

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.loans.test@greensglobal.com"     # accounting:editor, no limit
VIEWER = "viewer.loans.test@greensglobal.com"     # accounting:viewer, no limit
LIMITED = "limited.loans.test@greensglobal.com"   # accounting:editor, entity 15000 only
EVERYONE = (EDITOR, VIEWER, LIMITED)
GROUPS = {"grp-loans-test-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-loans-test-v": ("accounting:viewer", (VIEWER,))}

ENTITIES = [
    {"code": "12000", "name": "Greens Global, Inc.", "parent_code": None},
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
    {"code": "12027", "name": "(AM) (G) 910 S. El Camino Real", "parent_code": None},       # a parent: rolls the two below up
    {"code": "12027-1", "name": "910 S. El Camino Real - Suite 1", "parent_code": "12027"},
    {"code": "12027-2", "name": "910 S. El Camino Real - Suite 2", "parent_code": "12027"},
    {"code": "H13000", "name": "(H) Old Holdings LLC", "parent_code": None},                # historical: not scanned by default
]
LEAVES = ["12000", "12027-1", "12027-2", "15000", "56000"]
NAMES = {e["code"]: e["name"] for e in ENTITIES}

SECTIONS = {"1": "asset", "2": "liability", "3": "equity", "4": "revenue", "6": "expense", "7": "expense"}


def _ledger():
    """Posted lines per entity: (date, gl, title, debit, credit, entry). The
    section follows the first digit of the GL number."""
    L = {e["code"]: [] for e in ENTITIES}

    def post(entity, day, gl, title, debit=0.0, credit=0.0, entry=None):
        L[entity].append((day, gl, title, float(debit), float(credit), entry or f"E-{entity}-{day}-{gl}"))

    # Greens Escondido: the F&M mortgage, funded 2020, a paydown in 2025, and
    # twelve monthly payments of 4,000 principal + 6,000 interest.
    post("15000", "2020-01-15", "27100", "F&M Loan #6870", credit=1400000, entry="E-FUND")
    post("15000", "2025-06-01", "27100", "F&M Loan #6870", debit=100000, entry="E-PAYDOWN")
    for i in range(12):
        y, m = (2025, 10 + i) if i < 3 else (2026, i - 2)
        day = f"{y}-{m:02d}-01"
        post("15000", day, "27100", "F&M Loan #6870", debit=4000, entry=f"E-PMT-{day}")
        post("15000", day, "71100", "Interest - F&M 6870", debit=6000, entry=f"E-PMT-{day}")
        post("15000", day, "10100", "Operating Bank", credit=10000, entry=f"E-PMT-{day}")
        post("15000", day, "41101", "Rental Income", credit=25000, entry=f"E-RENT-{day}")
        post("15000", day, "61000", "Repairs", debit=3000, entry=f"E-REP-{day}")
    # A second loan with its own interest account.
    post("15000", "2024-01-01", "27200", "Bank of the West Loan 7788", credit=250000)
    post("15000", "2026-09-05", "27200", "Bank of the West Loan 7788", debit=1000)
    post("15000", "2026-09-05", "71200", "Interest Expense - Bank of the West 7788", debit=500)
    # Intercompany, working capital, and a loan paid off long ago.
    post("15000", "2026-01-01", "27500", "Due to Greens Global", credit=20000)
    post("15000", "2025-03-01", "27600", "Loan from Greens Global, Inc.", credit=80000)
    post("15000", "2015-01-01", "27900", "Old Wells Fargo Loan", credit=500000)
    post("15000", "2019-01-01", "27900", "Old Wells Fargo Loan", debit=500000)
    post("15000", "2026-09-10", "20100", "Accounts Payable", credit=5000)
    post("15000", "2026-09-10", "21000", "Security Deposits", credit=9000)
    post("15000", "2026-09-10", "22000", "Chase Credit Card", credit=3000)
    post("15000", "2020-01-15", "10100", "Operating Bank", debit=50000)
    post("12000", "2020-06-01", "27300", "SBA EIDL Loan", credit=150000, entry="E-EIDL")
    post("12000", "2026-09-01", "24000", "Accrued Payroll", credit=1000)
    post("56000", "2026-09-01", "20100", "Accounts Payable", credit=700)
    post("12027-1", "2021-01-01", "26008", "RJK - F&M - 6870 - (Mortgage)", credit=149679.96)
    post("12027-1", "2026-09-01", "22603", "OSM - Capital One - 5431", credit=3200)
    post("12027-2", "2021-01-01", "26023", "GE - Golden 1 Credit Union - 5860 - (Mortgage)", debit=14500000)     # a debit balance
    post("H13000", "2012-01-01", "27000", "Old Loan", credit=10000)
    return L


LEDGER = _ledger()


def _lines_of(location):
    if location == "12027":       # the parent rolls its children up
        return LEDGER["12027-1"] + LEDGER["12027-2"]
    return LEDGER.get(location, [])


def _tb(location, from_, to):
    rows = {}
    for day, gl, title, dr, cr, _ in _lines_of(location):
        if day > to:
            continue
        r = rows.setdefault(gl, {"account_no": gl, "title": title, "section": SECTIONS[gl[0]], "opening": 0.0, "debit": 0.0, "credit": 0.0})
        if day < from_:
            r["opening"] += dr - cr
        else:
            r["debit"] += dr
            r["credit"] += cr
    for r in rows.values():
        r["closing"] = round(r["opening"] + r["debit"] - r["credit"], 2)
    return {"ok": True, "rows": sorted(rows.values(), key=lambda r: r["account_no"])}


def _sheet(location, asof):
    sums = {}
    for day, gl, title, dr, cr, _ in _lines_of(location):
        if day <= asof:
            s = sums.setdefault(gl, [title, 0.0])
            s[1] += dr - cr
    sections = {}
    for gl, (title, amount) in sorted(sums.items()):
        sec = SECTIONS[gl[0]]
        if sec in ("asset", "liability", "equity"):
            sections.setdefault(sec, []).append({"account_no": gl, "title": title, "amount": round(amount, 2)})
    return {"ok": True, "sections": [{"key": k, "accounts": v} for k, v in sections.items()]}


def _search(p):
    rows = [x for x in _lines_of(p.get("location")) if x[1] == p.get("account") and (not p.get("from") or x[0] >= p["from"]) and (not p.get("to") or x[0] <= p["to"])]
    rows.sort(key=lambda x: x[0], reverse=True)
    off, lim = int(p.get("offset") or 0), int(p.get("limit") or 100)
    page = rows[off:off + lim]
    return {"ok": True, "total": len(rows), "debit": sum(x[3] for x in rows), "credit": sum(x[4] for x in rows),
            "rows": [{"entry_id": f"00000000-0000-0000-0000-{abs(hash(x[5])) % 10**12:012d}", "entry_no": x[5], "entry_date": x[0], "description": x[2], "gl_code": x[1], "account_name": x[2], "debit": x[3], "credit": x[4]} for x in page]}


URL = "/accounting/loans/proposals?month=2026-09"
REVIEW = "/accounting/loans/review?from=2026-09-01&to=2026-09-30"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class ClassifierTests(unittest.TestCase):
    """Which balance sheet accounts are proposed as loans."""

    def _c(self, title, section="liability", code="27000"):
        return accounting_loans.classify_loan_account(section, code, title, NAMES, "15000")

    def test_loan_words_and_lenders(self):
        self.assertEqual(self._c("F&M Loan #6870"), {"kind": "external", "lender": "F&M Bank"})
        self.assertEqual(self._c("Mortgage Payable - Wells Fargo"), {"kind": "external", "lender": "Wells Fargo"})
        self.assertEqual(self._c("Note Payable - Citibank"), {"kind": "external", "lender": "Citi"})
        self.assertEqual(self._c("SBA EIDL Loan"), {"kind": "external", "lender": "SBA"})
        self.assertEqual(self._c("Line of Credit"), {"kind": "external", "lender": ""})
        self.assertEqual(self._c("HELOC - Chase")["lender"], "Chase")
        self.assertEqual(self._c("Equipment Financing - Deere")["lender"], "Deere")

    def test_working_capital_and_cards_are_not_loans(self):
        for t in ("Accounts Payable", "Chase Credit Card", "Amex", "Accrued Payroll", "Payroll Liabilities", "Deferred Revenue", "Security Deposits", "Sales Tax Payable", "Clearing"):
            self.assertIsNone(self._c(t), t)
        self.assertEqual(self._c("Payroll Protection Loan")["kind"], "external")
        self.assertIsNone(self._c("HELOC Interest Payable", code="25011"))
        self.assertIsNone(self._c("Accrued Interest - Mortgage", code="25012"))
        self.assertIsNone(self._c("Accrued Interest - Related Party", code="25013"))

    def test_a_lenders_name_alone_counts_only_from_gl_25000(self):
        for code, title in (("22603", "OSM - Capital One - 5431"), ("22002", "RJK & DRK - Citi - 4110"), ("22301", "GC - Chase - 2305"), ("22114", "US Bank - Amazon - 4863")):
            self.assertIsNone(self._c(title, code=code), title)
        self.assertEqual(self._c("GE - Five Star Bank - 4953 - (Mortgage)", code="26013")["kind"], "external")
        toyota = self._c("Pentagon Credit Union - Toyota", code="27006")
        self.assertEqual(toyota["kind"], "external")
        self.assertIn("Pentagon Credit Union", toyota["lender"])
        loc = self._c("City National Bank - Gr. FLP LOC", code="27038")
        self.assertTrue(loc["lender"].startswith("City National Bank"), loc)
        self.assertEqual(self._c("Chase - Equipment Loan", code="22900")["lender"], "Chase")
        self.assertIsNone(self._c("GC - Chase - 2305", code="X-1"))

    def test_intercompany_is_included_with_or_without_a_loan_word(self):
        # Oct 6 (Charmi: "intercompany loans are missing").
        self.assertEqual(self._c("Due to Greens Global"), {"kind": "intercompany", "lender": "Greens Global, Inc."})
        self.assertEqual(self._c("Loan from Greens Global, Inc."), {"kind": "intercompany", "lender": "Greens Global, Inc."})
        self.assertEqual(self._c("Intercompany Loan - MCD"), {"kind": "intercompany", "lender": "MCD"})
        self.assertEqual(self._c("Note Payable - Related Party")["kind"], "intercompany")
        self.assertEqual(self._c("Due to Member")["kind"], "intercompany")
        self.assertEqual(self._c("Due to Officer - Rajesh")["kind"], "intercompany")
        self.assertIsNone(self._c("Due to Payroll Company"))                    # working capital stays out
        self.assertIsNone(self._c("Loan to Greens Escondido, LLC.", section="asset"))

    def test_only_liabilities(self):
        self.assertIsNone(self._c("Loan Receivable", section="asset"))
        self.assertIsNone(self._c("Member Loan", section="equity"))


class ArithmeticTests(unittest.TestCase):
    def test_owed_is_minus_the_ledger_amount_for_a_liability(self):
        self.assertEqual(accounting_loans.owed("liability", -11245000), 11245000.0)
        self.assertEqual(accounting_loans.owed("liability", 14500000), -14500000.0)
        self.assertEqual(accounting_loans.owed("asset", 50000), 50000.0)

    def test_leaf_and_active_entities(self):
        leaves, parents = accounting_loans.leaf_entities(ENTITIES)
        self.assertEqual(parents, 1)
        live, hist = accounting_loans.active_entities(ENTITIES)
        self.assertEqual(hist, 1)
        self.assertNotIn("H13000", [e["code"] for e in live])
        self.assertTrue(accounting_loans.is_historical({"code": "13001", "name": "Old Co (H)"}))
        self.assertTrue(accounting_loans.is_historical({"code": "H12001", "name": "Old Co"}))
        self.assertFalse(accounting_loans.is_historical({"code": "12001", "name": "Holdings LLC"}))
        self.assertEqual(len(accounting_loans.active_entities(ENTITIES, historical=True)[0]), len(ENTITIES))

    def test_interest_account_matching(self):
        cands = {"71100": "Interest - F&M 6870", "71200": "Interest Expense - Bank of the West 7788", "71300": "Interest Expense"}
        self.assertEqual(accounting_loans.match_interest("F&M Loan #6870", "F&M Bank", "6870", cands), "71100")
        self.assertEqual(accounting_loans.match_interest("Bank of the West Loan 7788", "Bank of the West", "", cands), "71200")
        self.assertIsNone(accounting_loans.match_interest("SBA EIDL Loan", "SBA", "", cands))
        # A tie is no match.
        self.assertIsNone(accounting_loans.match_interest("RJK Mortgage", "RJK", "", {"1": "RJK Interest A", "2": "RJK Interest B"}))
        tb = {"71100": {"title": "Interest - F&M 6870", "section": "expense"}, "42000": {"title": "Interest Income", "section": "other_income"},
              "71400": {"title": "Interest Income - Bank", "section": "expense"}, "61000": {"title": "Repairs", "section": "expense"}}
        self.assertEqual(accounting_loans.interest_candidates(tb), {"71100": "Interest - F&M 6870"})

    def test_noi_and_dscr(self):
        pnl = [{"section": "revenue", "account_no": "41101", "title": "Rental Income", "amount": 300000}, {"section": "expense", "account_no": "61000", "title": "Repairs", "amount": 36000},
               {"section": "expense", "account_no": "65000", "title": "Mortgage Interest", "amount": 76000}, {"section": "expense", "account_no": "68000", "title": "Depreciation", "amount": 48000}]
        self.assertEqual(accounting_loans.noi(pnl), {"income": 300000.0, "operatingExpenses": 36000.0, "noi": 264000.0})
        self.assertEqual(accounting_loans.dscr(201600, 126000), 1.6)
        self.assertIsNone(accounting_loans.dscr(201600, 0))

    def test_dates(self):
        self.assertEqual(accounting_loans.month_bounds("2026-02"), ("2026-02-01", "2026-02-28"))
        self.assertEqual(accounting_loans.shift_month("2026-09", 12), "2025-09")
        self.assertEqual(accounting_loans.trailing_from("2026-09-30"), "2025-10-01")
        self.assertEqual(accounting_loans.trailing_from("2028-02-29"), "2027-03-01")
        self.assertEqual(accounting_loans.period("2026-09-01", "2026-09-30"), ("2026-09-01", "2026-09-30"))
        self.assertEqual(accounting_loans.period(None, "2026-09-15"), ("2026-09-01", "2026-09-15"))
        self.assertEqual(accounting_loans.period(None, None, "2026-08"), ("2026-08-01", "2026-08-31"))
        with self.assertRaises(HTTPException):
            accounting_loans.period("2026-10-01", "2026-09-30")

    def test_review_rows_from_the_trial_balance(self):
        loans = [{"id": "A", "lender": "F&M Bank", "loan_no": "6870", "entity_code": "15000", "gl_account": "27100", "balance_source": "ledger", "is_active": True},
                 {"id": "B", "lender": "Old Wells", "entity_code": "15000", "gl_account": "27900", "balance_source": "ledger", "is_active": True},
                 {"id": "C", "lender": "Hand Kept", "entity_code": "15000", "gl_account": "", "balance_source": "manual", "balance": 1000, "is_active": True},
                 {"id": "D", "lender": "Typo", "entity_code": "15000", "gl_account": "29999", "balance_source": "ledger", "is_active": True}]
        tbs = {("15000", "period"): {k["account_no"]: k for k in _tb("15000", "2026-09-01", "2026-09-30")["rows"]},
               ("15000", "t12"): {k["account_no"]: k for k in _tb("15000", "2025-10-01", "2026-09-30")["rows"]}}
        rows = {r["id"]: r for r in accounting_loans.review_rows(loans, {}, tbs, NAMES)}
        a = rows["A"]
        self.assertEqual((a["balance"], a["principalPaid"], a["interestPaid"], a["interestAccount"], a["interestSource"]), (1252000.0, 4000.0, 6000.0, "71100", "matched"))
        self.assertEqual((a["principalPaidT12"], a["interestPaidT12"], a["debtServiceT12"], a["noiT12"], a["dscr"]), (48000.0, 72000.0, 120000.0, 264000.0, 2.2))
        self.assertEqual((rows["B"]["closed"], rows["B"]["balance"]), (True, 0.0))        # paid off: closed
        self.assertEqual((rows["C"]["wiring"], rows["C"]["balance"], rows["C"]["principalPaid"], rows["C"]["closed"]), ("manual", 1000.0, None, False))
        self.assertEqual((rows["D"]["wiring"], rows["D"]["closed"]), ("missing", False))  # never hidden: "check the wiring"
        # A wired interest account wins over the match.
        rows = {r["id"]: r for r in accounting_loans.review_rows(loans, {"A": {"interest_account": "71200"}}, tbs, NAMES)}
        self.assertEqual((rows["A"]["interestAccount"], rows["A"]["interestSource"], rows["A"]["interestPaid"]), ("71200", "wired", 500.0))


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
        self._egnyte = os.environ.get("EGNYTE_DOMAIN")
        os.environ["EGNYTE_DOMAIN"] = "greensglobal"
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (mods, members) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=mods))
                for em in members:
                    db.add(models.NexusGroupMember(group_id=gid, email=em))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting_loans._SCAN.clear()
        accounting_loans._JOBS.clear()
        accounting_loans._FIRST.clear()
        accounting_dashboard._CACHE.clear()
        accounting._ACCT_CACHE.clear()

        self.calls, self.saves = [], []
        self.gate = threading.Event()      # the balance sheet reads wait for this (a slow ledger)
        self.gate.set()
        self.fail_locations = False
        self.loans = [{"id": "FL1", "loan_no": "6870", "kind": "external", "lender": "F&M Bank", "entity_code": "15000", "gl_account": "27100", "balance_source": "ledger", "balance": 0, "rate_pct": 6.1, "rate_type": "fixed", "maturity": "2027-06-30", "monthly_pi": 10000, "dscr": None, "covenant_min": None, "is_active": True, "notes": "", "ledger_balance": 1252000, "ledger_asof": "2026-09-30"}]

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                if self.fail_locations:
                    raise HTTPException(status_code=424, detail="Accounting service error: the ledger is closed for maintenance")
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/balance-sheet"):
                while not self.gate.is_set():
                    await asyncio.sleep(0.01)
                return _sheet(clean.get("location"), clean.get("asof"))
            if path.endswith("/reports/trial-balance"):
                return _tb(clean.get("location"), clean["from"], clean["to"])
            if path.endswith("/search"):
                return _search(clean)
            return {"ok": True, "echo": clean}

        async def fake_dash(op, params):
            self.calls.append(("dash", {"op": op, **params}))
            return {"ok": True, "loans": [dict(l) for l in self.loans]}

        def fake_post(body):
            self.saves.append(body)
            if body.get("op") == "row-delete":
                self.loans = [l for l in self.loans if l["id"] != body["match"]["id"]]
                return {"ok": True}
            row = dict(body["row"])
            row.setdefault("id", f"FL{len(self.loans) + 1}")
            self.loans = [l for l in self.loans if l["id"] != row["id"]] + [row]
            return {"ok": True}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._dash, accounting_dashboard._get = accounting_dashboard._get, fake_dash
        self._post, accounting_dashboard._post_sync = accounting_dashboard._post_sync, fake_post
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        self._dbase, self._dkey = accounting_dashboard._BASE, accounting_dashboard._KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"
        accounting_dashboard._BASE, accounting_dashboard._KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        self.gate.set()
        accounting._acct_get, accounting_dashboard._get, accounting_dashboard._post_sync = self._get, self._dash, self._post
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        accounting_dashboard._BASE, accounting_dashboard._KEY = self._dbase, self._dkey
        accounting_loans._SCAN.clear()
        accounting_loans._JOBS.clear()
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        for k, v in (("NEXUS_DEV_EMAIL", self._email), ("EGNYTE_DOMAIN", self._egnyte)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.updated_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AccountingLoanSetting).filter(models.AccountingLoanSetting.loan_id.in_(("FL1", "FLM"))).delete(synchronize_session=False)
            db.query(models.AccountingLoanSchedule).filter(models.AccountingLoanSchedule.loan_id.in_(("FL1", "FLM"))).delete(synchronize_session=False)
            db.query(models.AccountingLoanStressScenario).filter(models.AccountingLoanStressScenario.loan_id.in_(("FL1", "FLM"))).delete(synchronize_session=False)
            db.query(models.AccountingLoanDismissed).filter(models.AccountingLoanDismissed.dismissed_by.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.user_email.in_(EVERYONE)).delete(synchronize_session=False)
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

    def _progress_until(self, cond, url=URL, timeout=5.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            r = self.client.get(url)
            self.assertEqual(r.status_code, 202, r.text)
            j = r.json()
            if cond(j):
                return j
            time.sleep(0.02)
        self.fail("the scan never reached the expected progress")

    def _sheet_reads(self):
        return [c[1]["location"] for c in self.calls if c[0].endswith("/reports/balance-sheet")]

    def _review(self, url=REVIEW):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── The scan ────────────────────────────────────────────────────────────
    def test_the_scan_is_a_background_job_polled_until_the_result(self):
        _as(EDITOR)
        self.gate.clear()
        r = self.client.get(URL)
        self.assertEqual(r.status_code, 202, r.text)
        self.assertTrue(r.json()["scanning"])
        j = self._progress_until(lambda j: j["total"] == len(LEAVES))
        self.assertEqual((j["done"], j["scanning"]), (0, True))
        self.gate.set()
        r = self._settled()
        self.assertEqual(r.status_code, 200, r.text)
        reads = self._sheet_reads()
        self.assertEqual((sorted(reads), len(reads)), (LEAVES, len(LEAVES)))     # leaves only; neither the parent nor the (H) entity
        self.assertEqual(self.client.get(URL).status_code, 200)
        self.assertEqual(len(self._sheet_reads()), len(LEAVES))
        r = self.client.post("/accounting/loans/create", json={"month": "2026-09", "items": [{"entityCode": "12000", "glAccount": "27300"}]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(self.client.get(URL).status_code, 202)
        self.assertEqual(self._settled().status_code, 200)
        self.assertEqual(len(self._sheet_reads()), 2 * len(LEAVES))

    def test_a_failed_scan_answers_424_once_and_starts_over(self):
        _as(EDITOR)
        self.fail_locations = True
        self.assertEqual(self.client.get(URL).status_code, 202)
        r = self._settled()
        self.assertEqual(r.status_code, 424, r.text)
        self.assertIn("closed for maintenance", r.json()["detail"])
        self.fail_locations = False
        self.assertEqual(self.client.get(URL).status_code, 202)
        self.assertEqual(self._settled().status_code, 200)

    def test_proposals_active_entities_open_loans_and_intercompany(self):
        _as(EDITOR)
        d = self._settled().json()
        self.assertEqual(d["asOf"], "2026-09-30")
        self.assertEqual((d["entitiesScanned"], d["parentsSkipped"], d["historicalSkipped"], d["paidOff"]), (5, 1, 1, 1))
        got = {(p["entityCode"], p["glAccount"]): p for p in d["proposals"]}
        self.assertEqual(set(got), {("15000", "27100"), ("15000", "27200"), ("15000", "27500"), ("15000", "27600"), ("12000", "27300"), ("12027-1", "26008"), ("12027-2", "26023")})
        self.assertEqual((got[("15000", "27100")]["status"], got[("15000", "27100")]["loanId"], got[("15000", "27100")]["balance"]), ("set_up", "FL1", 1252000.0))
        due = got[("15000", "27500")]
        self.assertEqual((due["kind"], due["internal"], due["lender"], due["status"]), ("intercompany", True, "Greens Global, Inc.", "new"))
        # The debit balance is shown as a positive figure with the flag for the hover note.
        self.assertEqual((got[("12027-2", "26023")]["balance"], got[("12027-2", "26023")]["debitBalance"]), (14500000.0, True))
        # The old Wells Fargo loan (paid off in 2019) is not proposed.
        self.assertNotIn(("15000", "27900"), got)

    def test_historical_and_picked_entities(self):
        _as(EDITOR)
        d = self._settled(URL + "&historical=true").json()
        self.assertIn(("H13000", "27000"), {(p["entityCode"], p["glAccount"]) for p in d["proposals"]})
        self.calls.clear()
        d = self._settled(URL + "&entities=12027").json()
        self.assertEqual(sorted(self._sheet_reads()), ["12027-1", "12027-2"])      # the picked entity's children only
        self.assertEqual({p["entityCode"] for p in d["proposals"]}, {"12027-1", "12027-2"})

    def test_create_writes_rows_once(self):
        _as(EDITOR)
        body = {"month": "2026-09", "items": [{"entityCode": "12000", "glAccount": "27300"}, {"entityCode": "15000", "glAccount": "27100"}, {"entityCode": "56000", "glAccount": "20100"}]}
        r = self.client.post("/accounting/loans/create", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        d = r.json()
        self.assertEqual([(c["entityCode"], c["glAccount"], c["loanNo"]) for c in d["created"]], [("12000", "27300", "27300")])
        self.assertEqual([(s["glAccount"], s["why"]) for s in d["skipped"]], [("27100", "already set up"), ("20100", "not a loan account on the ledger")])
        [save] = self.saves
        self.assertEqual((save["op"], save["table"], save["by"]), ("row-save", "fin_loans", "Editor Loans Test"))
        self.assertEqual({k: save["row"][k] for k in ("loan_no", "kind", "lender", "entity_code", "gl_account", "balance_source", "balance", "is_active")},
                         {"loan_no": "27300", "kind": "external", "lender": "SBA", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "balance": 150000.0, "is_active": True})
        self.assertRegex(save["row"]["id"], r"^[0-9a-f-]{36}$")
        r = self.client.post("/accounting/loans/create", json=body)
        self.assertEqual((len(r.json()["created"]), len(self.saves)), (0, 1))

    def test_viewers_cannot_create(self):
        _as(VIEWER)
        self.assertEqual(self.client.post("/accounting/loans/create", json={"month": "2026-09", "items": [{"entityCode": "12000", "glAccount": "27300"}]}).status_code, 403)
        self.assertEqual(self.client.post("/accounting/loans/manual", json={"lender": "X", "entityCode": "12000"}).status_code, 403)
        self.assertEqual(self._settled().status_code, 200)

    # ── The review ──────────────────────────────────────────────────────────
    def test_review_reads_principal_and_interest_from_the_ledger(self):
        _as(EDITOR)
        d = self._review()
        self.assertEqual((d["from"], d["to"], d["trailingFrom"]), ("2026-09-01", "2026-09-30", "2025-10-01"))
        [row] = d["loans"]
        self.assertEqual((row["lender"], row["entityName"], row["balance"], row["debitBalance"], row["closed"]), ("F&M Bank", "Greens Escondido, LLC.", 1252000.0, False, False))
        self.assertEqual((row["principalPaid"], row["interestPaid"], row["debtService"]), (4000.0, 6000.0, 10000.0))
        self.assertEqual((row["interestAccount"], row["interestSource"], row["interestAccounts"][0]["title"]), ("71100", "matched", "Interest - F&M 6870"))
        self.assertEqual((row["noiT12"], row["debtServiceT12"], row["dscr"], row["covenantMin"], row["belowCovenant"]), (264000.0, 120000.0, 2.2, 1.35, False))
        self.assertEqual((row["originalPrincipal"], row["originalPrincipalDate"], row["originalPrincipalEdited"]), (1400000.0, "2020-01-15", False))
        self.assertEqual((row["ratePct"], row["maturity"], row["monthlyPayment"], row["internal"]), (6.1, "2027-06-30", 10000.0, False))
        self.assertEqual(d["summary"], {"loans": 1, "closed": 0, "balance": 1252000.0, "debtServiceT12": 120000.0, "belowCovenant": 0, "entities": 1})
        # Every ledger read went through one entity, never the whole ledger.
        self.assertTrue(all(c[1].get("location") for c in self.calls if c[0].endswith(("/trial-balance", "/search"))))

    def test_a_loan_added_elsewhere_shows_at_once(self):
        # Oct 6 (Charmi, 10/03: "I added a few of the loans and they do not
        # show up"): the review was cached per person for five minutes, so a
        # loan added under Data > Loans (or on another worker) stayed hidden.
        _as(EDITOR)
        self.assertEqual(len(self._review()["loans"]), 1)
        self.loans.append({"id": "FL9", "loan_no": "", "kind": "external", "lender": "SBA", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "is_active": True})
        accounting_dashboard._CACHE.clear()   # the dashboard's own 10-second cache, cleared by its row-save
        d = self._review()
        self.assertEqual([r["lender"] for r in d["loans"]], ["F&M Bank", "SBA"])
        sba = d["loans"][1]
        self.assertEqual((sba["balance"], sba["closed"], sba["originalPrincipal"]), (150000.0, False, 150000.0))
        # A loan wired to an account its entity never used is shown, flagged - not hidden.
        self.loans.append({"id": "FL10", "lender": "Typo Bank", "entity_code": "12000", "gl_account": "29999", "balance_source": "ledger", "is_active": True})
        d = self._review()
        typo = next(r for r in d["loans"] if r["id"] == "FL10")
        self.assertEqual((typo["wiring"], typo["closed"]), ("missing", False))

    def test_closed_loans_are_flagged_and_left_out_of_the_totals(self):
        _as(EDITOR)
        self.loans.append({"id": "FL2", "lender": "Wells Fargo", "entity_code": "15000", "gl_account": "27900", "balance_source": "ledger", "is_active": True})
        self.loans.append({"id": "FL3", "lender": "Retired", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "is_active": False})
        d = self._review()
        rows = {r["id"]: r for r in d["loans"]}
        self.assertEqual((rows["FL2"]["closed"], rows["FL3"]["closed"], rows["FL1"]["closed"]), (True, True, False))
        self.assertEqual((d["summary"]["loans"], d["summary"]["closed"], d["summary"]["balance"]), (1, 2, 1252000.0))
        self.assertEqual([g["label"] for g in d["byLender"]], ["F&M Bank"])

    def test_entities_filter(self):
        _as(EDITOR)
        self.loans.append({"id": "FL2", "lender": "SBA", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "is_active": True})
        d = self._review(REVIEW + "&entities=12000")
        self.assertEqual([r["id"] for r in d["loans"]], ["FL2"])
        _as(LIMITED)
        self.assertEqual(self.client.get(REVIEW + "&entities=12000").status_code, 403)

    def test_edit_saves_the_typed_fields_and_the_wiring(self):
        _as(EDITOR)
        r = self.client.put("/accounting/loans/FL1", json={"ratePct": 6.25, "rateType": "variable", "maturity": "2028-01-31", "monthlyPayment": 11000, "covenantMin": 1.5,
                                                         "lender": "F&M Bank - Escondido", "loanNo": "6870-A", "interestAccount": "71200", "originalPrincipal": 1500000,
                                                         "internal": True, "docsPath": "/Shared/Loans/F&M 6870/Documents",
                                                         "statementsPath": "https://greensglobal.egnyte.com/app/index.do#storage/files/1/Shared/Loans/F%26M%206870/Statements"})
        self.assertEqual(r.status_code, 200, r.text)
        [save] = self.saves
        self.assertEqual({k: save["row"][k] for k in ("id", "rate_pct", "rate_type", "maturity", "monthly_pi", "covenant_min", "lender", "loan_no", "gl_account", "balance_source")},
                         {"id": "FL1", "rate_pct": 6.25, "rate_type": "variable", "maturity": "2028-01-31", "monthly_pi": 11000, "covenant_min": 1.5, "lender": "F&M Bank - Escondido", "loan_no": "6870-A", "gl_account": "27100", "balance_source": "ledger"})
        self.assertNotIn("ledger_balance", save["row"])
        [row] = self._review()["loans"]
        self.assertEqual((row["lender"], row["loanNo"], row["glAccount"]), ("F&M Bank - Escondido", "6870-A", "27100"))      # the GL wiring is kept
        self.assertEqual((row["interestAccount"], row["interestSource"], row["interestPaid"]), ("71200", "wired", 500.0))
        self.assertEqual((row["originalPrincipal"], row["originalPrincipalEdited"], row["originalPrincipalLedger"], row["internal"]), (1500000.0, True, None, True))
        self.assertEqual((row["docsPath"], row["statementsPath"]), ("/Shared/Loans/F&M 6870/Documents", "/Shared/Loans/F&M 6870/Statements"))
        self.assertEqual(row["docsUrl"], "https://greensglobal.egnyte.com/app/index.do#storage/files/1/Shared/Loans/F&M 6870/Documents")
        # Back to automatic: null clears the interest account and the original principal.
        self.client.put("/accounting/loans/FL1", json={"interestAccount": None, "originalPrincipal": None, "internal": None})
        [row] = self._review()["loans"]
        self.assertEqual((row["interestSource"], row["originalPrincipal"], row["originalPrincipalEdited"], row["internal"]), ("matched", 1400000.0, False, False))
        # Re-wiring the principal account.
        self.client.put("/accounting/loans/FL1", json={"glAccount": "27200"})
        [row] = self._review()["loans"]
        self.assertEqual((row["glAccount"], row["balance"], row["principalPaid"]), ("27200", 249000.0, 1000.0))

    def test_edit_validation(self):
        _as(EDITOR)
        bad = [{"rateType": "floating"}, {"maturity": "06/30/2027"}, {"lender": " "}, {"glAccount": "27 100"}, {"monthlyPayment": -1},
               {"docsPath": "C:/Loans"}, {"docsPath": "https://evil.example.com/app/index.do#storage/files/1/Shared/X"}, {"docsPath": "https://greensglobal.egnyte.com/navigate/file/abc"}]
        for b in bad:
            self.assertEqual(self.client.put("/accounting/loans/FL1", json=b).status_code, 400, b)
        self.assertEqual(self.saves, [])
        self.assertEqual(self.client.put("/accounting/loans/NOPE", json={"ratePct": 1}).status_code, 404)
        _as(VIEWER)
        self.assertEqual(self.client.put("/accounting/loans/FL1", json={"ratePct": 1}).status_code, 403)

    def test_manual_loan(self):
        _as(EDITOR)
        r = self.client.post("/accounting/loans/manual", json={"lender": "Rajesh Family Trust", "entityCode": "12000", "loanNo": "RFT-1", "originalPrincipal": 300000, "balance": 250000,
                                                              "ratePct": 5, "rateType": "fixed", "maturity": "2030-12-31", "monthlyPayment": 3200, "internal": True})
        self.assertEqual(r.status_code, 201, r.text)
        lid = r.json()["loanId"]
        [save] = self.saves
        self.assertEqual({k: save["row"][k] for k in ("lender", "entity_code", "loan_no", "gl_account", "balance_source", "balance", "monthly_pi", "kind")},
                         {"lender": "Rajesh Family Trust", "entity_code": "12000", "loan_no": "RFT-1", "gl_account": "", "balance_source": "manual", "balance": 250000.0, "monthly_pi": 3200, "kind": "intercompany"})
        row = next(x for x in self._review()["loans"] if x["id"] == lid)
        self.assertEqual((row["wiring"], row["balance"], row["originalPrincipal"], row["originalPrincipalEdited"], row["internal"], row["principalPaid"]), ("manual", 250000.0, 300000.0, True, True, None))
        for b in ({"lender": "", "entityCode": "12000"}, {"lender": "X", "entityCode": ""}, {"lender": "X", "entityCode": "99999"}, {"lender": "X", "entityCode": "12000", "balance": -5}):
            self.assertEqual(self.client.post("/accounting/loans/manual", json=b).status_code, 400, b)
        _as(LIMITED)
        self.assertEqual(self.client.post("/accounting/loans/manual", json={"lender": "X", "entityCode": "12000"}).status_code, 403)

    def test_payment_history_and_accounts(self):
        _as(EDITOR)
        r = self.client.get("/accounting/loans/FL1/history?to=2026-09-30&interest=71100")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        p = d["principal"]
        self.assertEqual((p["account"], p["total"], p["debit"], p["credit"]), ("27100", 14, 148000.0, 1400000.0))
        self.assertEqual(p["lines"][0]["date"], "2026-09-01")         # newest first
        self.assertTrue(p["lines"][0]["entryId"])
        [i] = d["interest"]
        self.assertEqual((i["account"], i["total"], i["debit"]), ("71100", 12, 72000.0))
        # The period only.
        d = self.client.get("/accounting/loans/FL1/history?from=2026-09-01&to=2026-09-30&interest=71100").json()
        self.assertEqual((d["principal"]["total"], d["principal"]["debit"], d["interest"][0]["debit"]), (1, 4000.0, 6000.0))
        self.assertEqual(self.client.get("/accounting/loans/NOPE/history").status_code, 404)
        a = self.client.get("/accounting/loans/accounts?entity=15000&to=2026-09-30").json()
        self.assertEqual(a["interest"][0]["code"], "71100")
        self.assertTrue(a["interest"][0]["interest"])
        self.assertIn("27100", [x["code"] for x in a["principal"]])
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/loans/accounts?entity=12000").status_code, 403)

    def test_a_limited_person_sees_only_their_entities(self):
        _as(LIMITED)
        d = self._settled().json()
        self.assertEqual({p["entityCode"] for p in d["proposals"]}, {"15000"})
        self.assertEqual(set(self._sheet_reads()), {"15000"})
        self.assertEqual(self.client.post("/accounting/loans/create", json={"month": "2026-09", "items": [{"entityCode": "12000", "glAccount": "27300"}]}).status_code, 403)
        self.assertEqual(self.saves, [])
        self.loans.append({"id": "FL2", "loan_no": "9001", "kind": "external", "lender": "SBA", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "balance": 0, "is_active": True})
        r = self._review()
        self.assertEqual([x["entityCode"] for x in r["loans"]], ["15000"])
        self.assertEqual(self.client.put("/accounting/loans/FL2", json={"ratePct": 1}).status_code, 404)
        self.assertEqual(self.client.get("/accounting/loans/FL2/history").status_code, 404)

    # ── Oct 7: delete, loan type, by entity, NOI ────────────────────────────
    def test_delete_removes_the_loan_and_what_nexus_keeps_and_remembers_a_ledger_loan(self):
        db = database.SessionLocal()
        try:
            db.add(models.AccountingLoanSchedule(id=str(uuid.uuid4()), loan_id="FL1", entity_code="15000", rows=[]))
            db.add(models.AccountingLoanStressScenario(id=str(uuid.uuid4()), loan_id="FL1", entity_code="15000", name="x", params={}))
            db.add(models.AccountingLoanSetting(loan_id="FL1", entity_code="15000", docs_path="/Shared/Loans", interest_account="", statements_path=""))
            db.commit()
        finally:
            db.close()
        _as(VIEWER)
        self.assertEqual(self.client.delete("/accounting/loans/FL1").status_code, 403)
        _as(EDITOR)
        self.assertEqual(self.client.delete("/accounting/loans/NOPE").status_code, 404)
        r = self.client.delete("/accounting/loans/FL1")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["dismissed"])
        self.assertEqual({k: self.saves[-1][k] for k in ("op", "table", "match")}, {"op": "row-delete", "table": "fin_loans", "match": {"id": "FL1"}})
        self.assertEqual(self._review()["loans"], [])
        db = database.SessionLocal()
        try:
            for m in (models.AccountingLoanSchedule, models.AccountingLoanStressScenario, models.AccountingLoanSetting):
                self.assertEqual(db.query(m).filter(m.loan_id == "FL1").count(), 0, m.__name__)
            [gone] = db.query(models.AccountingLoanDismissed).filter(models.AccountingLoanDismissed.entity_code == "15000").all()
            self.assertEqual((gone.gl_account, gone.loan_id, gone.dismissed_by), ("27100", "FL1", EDITOR))
            [audit] = db.query(models.AuditLog).filter(models.AuditLog.action == "accounting_loan_removed").all()
            self.assertEqual((audit.user_email, audit.resource_id), (EDITOR, "FL1"))
        finally:
            db.close()
        # The ledger setup does not offer it again; ticking it (Show Removed) sets it up and forgets the removal.
        d = self._settled().json()
        fm = next(p for p in d["proposals"] if p["glAccount"] == "27100")
        self.assertEqual((fm["status"], d["removed"]), ("dismissed", 1))
        r = self.client.post("/accounting/loans/create", json={"month": "2026-09", "items": [{"entityCode": "15000", "glAccount": "27100", "docsPath": "/Shared/Loans/F&M", "loanType": "term"}]})
        self.assertEqual([c["glAccount"] for c in r.json()["created"]], ["27100"])
        d = self._settled().json()
        self.assertEqual(next(p for p in d["proposals"] if p["glAccount"] == "27100")["status"], "set_up")
        row = next(x for x in self._review()["loans"] if x["glAccount"] == "27100")
        self.assertEqual((row["docsPath"], row["loanType"], row["loanTypeGuessed"]), ("/Shared/Loans/F&M", "term", False))
        # A loan kept by hand is simply removed.
        self.loans.append({"id": "FLM", "loan_no": "M1", "kind": "external", "lender": "Hand", "entity_code": "15000", "gl_account": "", "balance_source": "manual", "balance": 5, "is_active": True})
        self.assertFalse(self.client.delete("/accounting/loans/FLM").json()["dismissed"])
        # A limited person cannot remove a loan outside their entities.
        self.loans.append({"id": "FL9", "loan_no": "9", "kind": "external", "lender": "SBA", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "balance": 0, "is_active": True})
        _as(LIMITED)
        self.assertEqual(self.client.delete("/accounting/loans/FL9").status_code, 404)

    def test_line_of_credit_is_typed_or_guessed_from_the_title(self):
        self.assertEqual(accounting_loans.guess_loan_type("City National Bank - Gr. FLP LOC"), "line_of_credit")
        self.assertEqual(accounting_loans.guess_loan_type("HELOC - Chase"), "line_of_credit")
        self.assertEqual(accounting_loans.guess_loan_type("Line of Credit"), "line_of_credit")
        self.assertEqual(accounting_loans.guess_loan_type("F&M Loan #6870", "F&M Bank"), "term")
        self.assertEqual(accounting_loans.loan_type_of({"loan_type": "line_of_credit"}, "F&M Loan"), ("line_of_credit", False))
        _as(EDITOR)
        row = self._review()["loans"][0]
        self.assertEqual((row["loanType"], row["lineOfCredit"], row["loanTypeGuessed"]), ("term", False, True))
        self.assertEqual(self.client.put("/accounting/loans/FL1", json={"loanType": "balloon"}).status_code, 400)
        self.assertEqual(self.client.put("/accounting/loans/FL1", json={"loanType": "line_of_credit"}).status_code, 200)
        row = self._review()["loans"][0]
        self.assertEqual((row["loanType"], row["lineOfCredit"], row["loanTypeGuessed"]), ("line_of_credit", True, False))
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.AuditLog).filter(models.AuditLog.action == "accounting_loan_changed", models.AuditLog.resource_id == "FL1").count(), 1)
        finally:
            db.close()

    def test_interest_share_matches_the_row(self):
        loans = [{"id": "A", "lender": "Alpha", "entity_code": "15000", "gl_account": "27100", "balance_source": "ledger", "is_active": True},
                 {"id": "B", "lender": "Beta", "entity_code": "15000", "gl_account": "27200", "balance_source": "ledger", "is_active": True}]
        tb = {"27100": {"title": "Loan A", "section": "liability", "opening": -300000, "debit": 0, "credit": 0, "closing": -300000},
              "27200": {"title": "Loan B", "section": "liability", "opening": -100000, "debit": 0, "credit": 0, "closing": -100000},
              "71900": {"title": "Interest Expense", "section": "expense", "opening": 0, "debit": 4000, "credit": 0, "closing": 4000}}
        rows = {r["id"]: r for r in accounting_loans.review_rows(loans, {}, {("15000", "period"): tb, ("15000", "t12"): tb}, NAMES)}
        self.assertEqual((rows["A"]["interestSource"], rows["A"]["interestShare"], rows["A"]["interestPaid"]), ("shared", 0.75, 3000.0))
        self.assertEqual((rows["B"]["interestShare"], rows["B"]["interestPaid"]), (0.25, 1000.0))

    def test_loans_by_entity_for_asset_management(self):
        _as(EDITOR)
        r = self.client.get("/accounting/loans/by-entity/15000?to=2026-09-30")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        [loan] = d["loans"]
        self.assertEqual({k: loan[k] for k in ("lender", "loanNo", "balance", "ratePct", "maturity", "monthlyPayment", "dscr", "debtServiceT12", "docsPath")},
                         {"lender": "F&M Bank", "loanNo": "6870", "balance": 1252000.0, "ratePct": 6.1, "maturity": "2027-06-30", "monthlyPayment": 10000.0, "dscr": 2.2, "debtServiceT12": 120000.0, "docsPath": ""})
        self.assertEqual(d["totals"], {"loans": 1, "balance": 1252000.0, "monthlyPayment": 10000.0, "debtServiceT12": 120000.0})
        self.assertEqual(self.client.get("/accounting/loans/by-entity/56000").json()["loans"], [])
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/loans/by-entity/12000").status_code, 403)
        self.assertEqual(self.client.get("/accounting/loans/by-entity/15000?to=2026-09-30").status_code, 200)

    def test_noi_per_entity_annualized(self):
        _as(EDITOR)
        d = self.client.get("/accounting/loans/noi?entities=15000&from=2026-01-01&to=2026-06-30").json()
        e = d["entities"]["15000"]
        # Jan-Jun 2026: 6 x (25,000 rent - 3,000 repairs); interest left out.
        self.assertEqual((e["noi"], d["days"]), (132000.0, 181))
        self.assertEqual(e["annualized"], round(132000 * 365 / 181, 2))
        _as(LIMITED)
        self.assertEqual(self.client.get("/accounting/loans/noi?entities=12000").status_code, 403)

    def test_scans_are_per_caller(self):
        _as(EDITOR)
        self.assertEqual(self._settled().status_code, 200)
        _as(LIMITED)
        self.assertEqual(self.client.get(URL).status_code, 202)

    def test_bad_dates(self):
        _as(EDITOR)
        self.assertEqual(self.client.get("/accounting/loans/review?month=2026-13").status_code, 400)
        self.assertEqual(self.client.get("/accounting/loans/review?from=2026-09-31&to=2026-09-30").status_code, 400)
        self.assertEqual(self.client.get("/accounting/loans/proposals?month=Sept").status_code, 400)

    def test_not_configured_is_503(self):
        _as(EDITOR)
        accounting._acct_get = self._get
        accounting._ACCT_BASE = ""
        r = self.client.get(REVIEW)
        self.assertEqual(r.status_code, 503)
        self.assertIn("not configured", r.json()["detail"])


if __name__ == "__main__":
    unittest.main()
