"""Accounting -> Loans & Financing (Neil and Charmi, 10/02) - as tests.

Which liability accounts are loans (the classifier), the review arithmetic
(principal from the balance decrease, interest from the P&L, NOI without
interest / depreciation / amortization, DSCR against the covenant), the
proposals with the ones already in fin_loans marked, an idempotent create
through the dashboard's row-save, and entity scope on every read. The
accounting service is replaced by a recorder - nothing leaves the machine.

    python -m pytest test_accounting_loans.py -q
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

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
    {"code": "15900", "name": "Escondido Annex", "parent_code": "15000"},
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
]
NAMES = {e["code"]: e["name"] for e in ENTITIES}

# Balance sheets per entity: (code, title, section, {asof: amount} or amount).
SHEETS = {
    "15000": [
        ("20100", "Accounts Payable", "liability", 5000), ("21000", "Security Deposits", "liability", 9000),
        ("22000", "Chase Credit Card", "liability", 3000), ("27500", "Due to Greens Global", "liability", 20000),
        ("27100", "F&M Loan #6870", "liability", {"2026-09-30": 1250000, "2026-08-31": 1254200, "2025-09-30": 1300000}),
        ("27600", "Loan from Greens Global, Inc.", "liability", 80000), ("10100", "Operating Bank", "asset", 50000),
    ],
    "12000": [("27300", "SBA EIDL Loan", "liability", 150000), ("24000", "Accrued Payroll", "liability", 1000)],
    "56000": [("20100", "Accounts Payable", "liability", 700)],
    "15900": [],
}
PNL = {
    ("15000", "2026-09-01", "2026-09-30"): [("revenue", "41101", "Rental Income", 25000), ("expense", "61000", "Repairs", 3000), ("expense", "65000", "Mortgage Interest", 6250), ("expense", "68000", "Depreciation", 4000)],
    ("15000", "2025-10-01", "2026-09-30"): [("revenue", "41101", "Rental Income", 300000), ("expense", "61000", "Repairs", 36000), ("expense", "62000", "Property Tax", 62400), ("expense", "65000", "Mortgage Interest", 76000), ("expense", "68000", "Depreciation", 48000)],
    ("12000", "2026-09-01", "2026-09-30"): [("revenue", "40000", "Sales", 9000), ("expense", "60000", "Wages", 8000)],
    ("12000", "2025-10-01", "2026-09-30"): [("revenue", "40000", "Sales", 100000), ("expense", "60000", "Wages", 90000)],
}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _sheet(location, asof):
    sections = {}
    for code, title, section, amount in SHEETS.get(location, []):
        v = amount.get(asof, 0) if isinstance(amount, dict) else amount
        sections.setdefault(section, []).append({"account_no": code, "title": title, "amount": v})
    return {"ok": True, "sections": [{"key": k, "accounts": v} for k, v in sections.items()]}


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
        # Unless the title says loan.
        self.assertEqual(self._c("Payroll Protection Loan")["kind"], "external")

    def test_intercompany(self):
        self.assertIsNone(self._c("Due to Greens Global"))                       # no loan word: a balance, not a loan
        self.assertEqual(self._c("Loan from Greens Global, Inc."), {"kind": "intercompany", "lender": "Greens Global, Inc."})
        self.assertEqual(self._c("Intercompany Loan - MCD"), {"kind": "intercompany", "lender": "MCD"})   # no entity named in full: what is left of the title
        self.assertEqual(self._c("Due to Member - Loan")["kind"], "intercompany")
        self.assertIsNone(self._c("Loan to Greens Escondido, LLC.", section="asset"))     # a loan given is an asset; not this screen

    def test_only_liabilities(self):
        self.assertIsNone(self._c("Loan Receivable", section="asset"))
        self.assertIsNone(self._c("Member Loan", section="equity"))


class ArithmeticTests(unittest.TestCase):
    def test_noi_leaves_out_interest_depreciation_amortization(self):
        pnl = [{"section": s, "account_no": c, "title": t, "amount": a} for s, c, t, a in PNL[("15000", "2025-10-01", "2026-09-30")]]
        self.assertEqual(accounting_loans.noi(pnl), {"income": 300000.0, "operatingExpenses": 98400.0, "noi": 201600.0})
        self.assertEqual(accounting_loans.interest_expense(pnl), 76000.0)

    def test_dscr(self):
        self.assertEqual(accounting_loans.dscr(201600, 126000), 1.6)
        self.assertIsNone(accounting_loans.dscr(201600, 0))

    def test_months(self):
        self.assertEqual(accounting_loans.month_bounds("2026-02"), ("2026-02-01", "2026-02-28"))
        self.assertEqual(accounting_loans.shift_month("2026-01", 1), "2025-12")
        self.assertEqual(accounting_loans.shift_month("2026-09", 12), "2025-09")
        self.assertEqual(accounting_loans.shift_month("2026-09", -24), "2028-09")

    def test_review_rows(self):
        loans = [{"id": "FL1", "loan_no": "6870", "lender": "F&M Bank", "kind": "external", "entity_code": "15000", "gl_account": "27100", "balance_source": "ledger", "balance": 0, "rate_pct": 6.1, "rate_type": "fixed", "maturity": "2027-06-30", "monthly_pi": 10450, "covenant_min": None, "is_active": True}]
        acct = lambda v: {"amount": v}  # noqa: E731
        sheets = {("15000", "now"): {"27100": acct(1250000)}, ("15000", "m1"): {"27100": acct(1254200)}, ("15000", "m12"): {"27100": acct(1300000)}}
        pnls = {("15000", "month"): [{"section": s, "account_no": c, "title": t, "amount": a} for s, c, t, a in PNL[("15000", "2026-09-01", "2026-09-30")]],
                ("15000", "t12"): [{"section": s, "account_no": c, "title": t, "amount": a} for s, c, t, a in PNL[("15000", "2025-10-01", "2026-09-30")]]}
        [r] = accounting_loans.review_rows(loans, sheets, pnls, "2026-09", NAMES)
        self.assertEqual((r["balance"], r["balanceMonthAgo"], r["balanceYearAgo"]), (1250000.0, 1254200.0, 1300000.0))
        self.assertEqual((r["principalPaid"], r["interestPaid"], r["debtService"]), (4200.0, 6250.0, 10450.0))
        self.assertEqual((r["principalPaidT12"], r["interestPaidT12"], r["debtServiceT12"]), (50000.0, 76000.0, 126000.0))
        self.assertEqual((r["noiT12"], r["dscr"], r["covenantMin"], r["covenantTyped"], r["belowCovenant"]), (201600.0, 1.6, 1.35, False, False))
        # A typed covenant above the coverage flags it.
        loans[0]["covenant_min"] = 1.75
        [r] = accounting_loans.review_rows(loans, sheets, pnls, "2026-09", NAMES)
        self.assertEqual((r["covenantMin"], r["covenantTyped"], r["belowCovenant"]), (1.75, True, True))

    def test_two_loans_on_one_entity_share_the_interest_and_the_dscr(self):
        loans = [{"id": "A", "lender": "F&M Bank", "entity_code": "15000", "gl_account": "27100", "balance_source": "ledger", "is_active": True},
                 {"id": "B", "lender": "Greens Global, Inc.", "kind": "intercompany", "entity_code": "15000", "gl_account": "27600", "balance_source": "ledger", "is_active": True}]
        acct = lambda v: {"amount": v}  # noqa: E731
        sheets = {("15000", "now"): {"27100": acct(750000), "27600": acct(250000)}, ("15000", "m1"): {"27100": acct(751000), "27600": acct(250000)}, ("15000", "m12"): {"27100": acct(762000), "27600": acct(250000)}}
        pnls = {("15000", "month"): [{"section": "expense", "account_no": "65000", "title": "Interest Expense", "amount": 4000}],
                ("15000", "t12"): [{"section": "revenue", "account_no": "41101", "title": "Rent", "amount": 120000}, {"section": "expense", "account_no": "65000", "title": "Interest Expense", "amount": 48000}]}
        rows = {r["id"]: r for r in accounting_loans.review_rows(loans, sheets, pnls, "2026-09", NAMES)}
        self.assertEqual((rows["A"]["interestPaid"], rows["B"]["interestPaid"]), (3000.0, 1000.0))      # 75% / 25% by balance
        self.assertEqual((rows["A"]["debtServiceT12"], rows["B"]["debtServiceT12"]), (48000.0, 12000.0))  # 12,000 principal + 36,000 interest; 0 + 12,000
        self.assertEqual(rows["A"]["entityDebtServiceT12"], 60000.0)
        self.assertEqual((rows["A"]["dscr"], rows["B"]["dscr"], rows["A"]["sharedWith"]), (2.0, 2.0, 1))     # 120,000 NOI / 60,000

    def test_maturities_strip(self):
        rows = [{"id": "A", "lender": "Chase", "loanNo": "1", "entityName": "X", "balance": 100, "maturity": "2026-12-31"},
                {"id": "B", "lender": "F&M Bank", "loanNo": "2", "entityName": "Y", "balance": 200, "maturity": "2029-01-01"},   # past 24 months
                {"id": "C", "lender": "SBA", "loanNo": "3", "entityName": "Z", "balance": 300, "maturity": None}]
        out = accounting_loans.maturities(rows, "2026-09")
        self.assertEqual([(m["month"], m["balance"], [l["id"] for l in m["loans"]]) for m in out], [("2026-12", 100.0, ["A"])])


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
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
        accounting_dashboard._CACHE.clear()

        self.calls, self.saves = [], []
        self.loans = [{"id": "FL1", "loan_no": "6870", "kind": "external", "lender": "F&M Bank", "entity_code": "15000", "gl_account": "27100", "balance_source": "ledger", "balance": 0, "rate_pct": 6.1, "rate_type": "fixed", "maturity": "2027-06-30", "monthly_pi": 10450, "dscr": None, "covenant_min": None, "is_active": True, "notes": "", "ledger_balance": 1250000, "ledger_asof": "2026-09-30"}]

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/balance-sheet"):
                return _sheet(clean.get("location"), clean.get("asof"))
            if path.endswith("/reports/pnl"):
                rows = PNL.get((clean.get("location"), clean.get("from"), clean.get("to")), [])
                sections = {}
                for s, c, t, a in rows:
                    sections.setdefault(s, []).append({"account_no": c, "title": t, "amount": a})
                return {"ok": True, "sections": [{"key": k, "accounts": v} for k, v in sections.items()]}
            return {"ok": True, "echo": clean}

        async def fake_dash(op, params):
            self.calls.append(("dash", {"op": op, **params}))
            return {"ok": True, "loans": list(self.loans)}

        def fake_post(body):
            self.saves.append(body)
            row = dict(body["row"])
            row.setdefault("id", f"FL{len(self.loans) + 1}")
            self.loans.append(row)
            return {"ok": True, "row": row}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._dash, accounting_dashboard._get = accounting_dashboard._get, fake_dash
        self._post, accounting_dashboard._post_sync = accounting_dashboard._post_sync, fake_post
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        self._dbase, self._dkey = accounting_dashboard._BASE, accounting_dashboard._KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"
        accounting_dashboard._BASE, accounting_dashboard._KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        accounting._acct_get, accounting_dashboard._get, accounting_dashboard._post_sync = self._get, self._dash, self._post
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        accounting_dashboard._BASE, accounting_dashboard._KEY = self._dbase, self._dkey
        accounting_loans._SCAN.clear()
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
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_proposals_mark_what_is_set_up_and_skip_what_is_not_a_loan(self):
        _as(EDITOR)
        r = self.client.get("/accounting/loans/proposals?month=2026-09")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual(d["asOf"], "2026-09-30")
        self.assertEqual(d["entitiesScanned"], 4)
        got = {(p["entityCode"], p["glAccount"]): p for p in d["proposals"]}
        self.assertEqual(set(got), {("15000", "27100"), ("15000", "27600"), ("12000", "27300")})
        self.assertEqual((got[("15000", "27100")]["status"], got[("15000", "27100")]["loanId"], got[("15000", "27100")]["balance"]), ("set_up", "FL1", 1250000))
        self.assertEqual((got[("15000", "27600")]["status"], got[("15000", "27600")]["kind"], got[("15000", "27600")]["lender"]), ("new", "intercompany", "Greens Global, Inc."))
        self.assertEqual((got[("12000", "27300")]["status"], got[("12000", "27300")]["lender"]), ("new", "SBA"))
        self.assertEqual((d["setUp"], d["missing"]), (1, 2))
        self.assertTrue(any("Loan" in w for w in d["lookedFor"]))
        # Every balance sheet read was for one entity at the month end.
        self.assertTrue(all(c[1].get("asof") == "2026-09-30" and c[1].get("location") for c in self.calls if c[0].endswith("/reports/balance-sheet")))

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
        # Idempotent: the same request again creates nothing; the proposals now show it set up.
        r = self.client.post("/accounting/loans/create", json=body)
        self.assertEqual(r.status_code, 201)
        self.assertEqual((len(r.json()["created"]), len(self.saves)), (0, 1))
        got = {(p["entityCode"], p["glAccount"]): p["status"] for p in self.client.get("/accounting/loans/proposals?month=2026-09").json()["proposals"]}
        self.assertEqual(got[("12000", "27300")], "set_up")

    def test_viewers_cannot_create(self):
        _as(VIEWER)
        self.assertEqual(self.client.post("/accounting/loans/create", json={"month": "2026-09", "items": [{"entityCode": "12000", "glAccount": "27300"}]}).status_code, 403)
        self.assertEqual(self.client.get("/accounting/loans/proposals?month=2026-09").status_code, 200)

    def test_review_figures(self):
        _as(EDITOR)
        r = self.client.get("/accounting/loans/review?month=2026-09")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["asOf"], d["monthAgo"], d["yearAgo"], d["trailingFrom"]), ("2026-09-30", "2026-08-31", "2025-09-30", "2025-10-01"))
        [row] = d["loans"]
        self.assertEqual((row["lender"], row["entityName"], row["balance"], row["balanceMonthAgo"], row["balanceYearAgo"]), ("F&M Bank", "Greens Escondido, LLC.", 1250000.0, 1254200.0, 1300000.0))
        self.assertEqual((row["principalPaid"], row["interestPaid"], row["debtService"]), (4200.0, 6250.0, 10450.0))
        self.assertEqual((row["noiT12"], row["debtServiceT12"], row["dscr"], row["covenantMin"], row["belowCovenant"]), (201600.0, 126000.0, 1.6, 1.35, False))
        self.assertEqual((row["ratePct"], row["rateType"], row["maturity"], row["monthlyPi"]), (6.1, "fixed", "2027-06-30", 10450.0))
        self.assertEqual(d["byLender"][0]["label"], "F&M Bank")
        self.assertEqual((d["byEntity"][0]["label"], d["byEntity"][0]["dscr"]), ("Greens Escondido, LLC.", 1.6))
        self.assertEqual([(m["month"], m["balance"]) for m in d["maturities"]], [("2027-06", 1250000.0)])
        self.assertEqual(d["summary"], {"loans": 1, "balance": 1250000.0, "debtServiceT12": 126000.0, "belowCovenant": 0, "entities": 1})

    def test_review_sorts_by_dscr_and_flags_below_covenant(self):
        _as(EDITOR)
        self.loans.append({"id": "FL2", "loan_no": "9001", "kind": "external", "lender": "SBA", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "balance": 0, "rate_pct": 3.75, "rate_type": "fixed", "maturity": None, "monthly_pi": 0, "dscr": None, "covenant_min": 1.5, "is_active": True, "notes": ""})
        self.loans[0]["covenant_min"] = 1.75
        d = self.client.get("/accounting/loans/review?month=2026-09").json()
        # The SBA loan has no payments (constant balance, no interest): no coverage, listed last; F&M is under its typed 1.75.
        self.assertEqual([(r["lender"], r["dscr"], r["belowCovenant"]) for r in d["loans"]], [("F&M Bank", 1.6, True), ("SBA", None, False)])
        self.assertEqual(d["summary"]["belowCovenant"], 1)

    def test_edit_saves_the_typed_fields_to_the_same_row(self):
        _as(EDITOR)
        r = self.client.put("/accounting/loans/FL1?month=2026-09", json={"ratePct": 6.25, "rateType": "variable", "maturity": "2028-01-31", "monthlyPi": 11000, "covenantMin": 1.5, "lender": "F&M Bank"})
        self.assertEqual(r.status_code, 200, r.text)
        [save] = self.saves
        self.assertEqual(save["table"], "fin_loans")
        self.assertEqual({k: save["row"][k] for k in ("id", "rate_pct", "rate_type", "maturity", "monthly_pi", "covenant_min", "lender", "gl_account", "balance_source")},
                         {"id": "FL1", "rate_pct": 6.25, "rate_type": "variable", "maturity": "2028-01-31", "monthly_pi": 11000, "covenant_min": 1.5, "lender": "F&M Bank", "gl_account": "27100", "balance_source": "ledger"})
        self.assertNotIn("ledger_balance", save["row"])
        self.assertEqual(self.client.put("/accounting/loans/FL1?month=2026-09", json={"rateType": "floating"}).status_code, 400)
        self.assertEqual(self.client.put("/accounting/loans/NOPE?month=2026-09", json={"ratePct": 1}).status_code, 404)
        _as(VIEWER)
        self.assertEqual(self.client.put("/accounting/loans/FL1?month=2026-09", json={"ratePct": 1}).status_code, 403)

    def test_a_limited_person_sees_only_their_entities(self):
        _as(LIMITED)
        d = self.client.get("/accounting/loans/proposals?month=2026-09").json()
        self.assertEqual({p["entityCode"] for p in d["proposals"]}, {"15000"})
        self.assertEqual(d["entitiesScanned"], 2)       # 15000 and its child 15900
        self.assertEqual({c[1]["location"] for c in self.calls if c[0].endswith("/reports/balance-sheet")}, {"15000", "15900"})
        # Creating for an entity outside the limit is refused outright.
        self.assertEqual(self.client.post("/accounting/loans/create", json={"month": "2026-09", "items": [{"entityCode": "12000", "glAccount": "27300"}]}).status_code, 403)
        self.assertEqual(self.saves, [])
        self.loans.append({"id": "FL2", "loan_no": "9001", "kind": "external", "lender": "SBA", "entity_code": "12000", "gl_account": "27300", "balance_source": "ledger", "balance": 0, "is_active": True})
        r = self.client.get("/accounting/loans/review?month=2026-09").json()
        self.assertEqual([x["entityCode"] for x in r["loans"]], ["15000"])
        self.assertEqual(self.client.put("/accounting/loans/FL2?month=2026-09", json={"ratePct": 1}).status_code, 404)

    def test_bad_month(self):
        _as(EDITOR)
        self.assertEqual(self.client.get("/accounting/loans/review?month=2026-13").status_code, 400)
        self.assertEqual(self.client.get("/accounting/loans/proposals?month=Sept").status_code, 400)

    def test_not_configured_is_503(self):
        _as(EDITOR)
        accounting._acct_get = self._get
        accounting._ACCT_BASE = ""
        r = self.client.get("/accounting/loans/review?month=2026-09")
        self.assertEqual(r.status_code, 503)
        self.assertIn("not configured", r.json()["detail"])


if __name__ == "__main__":
    unittest.main()
