"""Personal Financial Statements (Neil, Sep 25) - the rules as tests.

Who may see one: owners and people explicitly granted "pfs". An administrator
is NOT let in by their role - this is the one module where the usual bypass
does not apply. What a statement says: every balance at the guarantor's share,
ledger lines read as of the statement date, real estate as a value and a loan,
total assets - total liabilities = net worth. A full Social Security number
is never kept. The accounting service is replaced by a recorder.

    python -m unittest test_pfs
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, pfs

models.Base.metadata.create_all(bind=database.engine)
# The per-file lock (Oct 6) has its own tests in test_pfs_access.py.
from routers import pfs_access  # noqa: E402
pfs_access.LOCK_ENABLED = False

OWNER = "owner.pfs.test@greensglobal.com"
ADMIN = "admin.pfs.test@greensglobal.com"        # administrator, no pfs grant
EDITOR = "editor.pfs.test@greensglobal.com"      # pfs:editor
VIEWER = "viewer.pfs.test@greensglobal.com"      # pfs:viewer
ACCOUNTANT = "acct.pfs.test@greensglobal.com"    # accounting:full, no pfs grant
EVERYONE = (OWNER, ADMIN, EDITOR, VIEWER, ACCOUNTANT)
GROUPS = {"grp-pfs-test-editor": ("pfs:editor", EDITOR), "grp-pfs-test-viewer": ("pfs:viewer", VIEWER),
          "grp-pfs-test-acct": ("accounting:full", ACCOUNTANT)}

# Balance sheets the stand-in accounting service answers with, per entity -
# debits minus credits like the real route (10/02), so a liability owed is NEGATIVE here.
BOOKS = {
    "60100": [("asset", "10100", "Operating Chkg 7546", 1_000_000.00), ("asset", "10120", "Savings 2017", 250_000.50),
              ("liability", "25000", "Loan Payable - F&M Bank", -400_000.00)],
    "15000": [("asset", "10100", "Escondido Chkg", 80_000.00), ("liability", "25100", "Mortgage - Escondido", -2_000_000.00)],
    # A family entity the way Charmi's screenshot showed it (10/01): bank
    # accounts without "bank" in their name, a 401k, a brokerage, land and a
    # building with their mortgage, a line of credit and a credit card.
    "70000": [("asset", "11301", "NRK & ANK - F&M - 6870", 12_000.00), ("asset", "11352", "ANK Earmarked ETC-7047", 5_000.00),
              ("asset", "11309", "ANK - 401K - Fidelity - 6165", 327.85), ("asset", "11348", "WeBull Brokerage Account", 101.00),
              ("asset", "12000", "Accounts Receivable", 900.00), ("asset", "15100", "Land - Escondido", 400_000.00),
              ("asset", "15200", "Building - Escondido", 1_600_000.00), ("asset", "15900", "Accumulated Depreciation", -200_000.00),
              ("liability", "25100", "Mortgage - Escondido - F&M", -1_200_000.00), ("liability", "24000", "Line of Credit - Chase", -50_000.00),
              ("liability", "23000", "Amex Credit Card", -4_000.00), ("liability", "22000", "Accrued Payroll", -7_000.00)],
}
# The P&L of the Escondido entity for a year, for Schedule E; of the
# business for Schedule C.
PNL = {
    "70000": {"revenue": [("40000", "Rental Income", 120_000.00)], "cogs": [],
              "expense": [("60100", "Property Management Fees", 9_600.00), ("60200", "Repairs", 3_100.00), ("60300", "Property Taxes", 14_000.00),
                          ("60400", "Mortgage Interest", 42_000.00), ("60500", "Gas and Electric", 2_400.00), ("60600", "Depreciation Expense", 30_000.00),
                          ("60700", "HOA Dues", 1_200.00)],
              "other_income": [], "other_expense": []},
    "60100": {"revenue": [("40000", "Service Revenue", 500_000.00)], "cogs": [("50000", "Cost of Services", 150_000.00)],
              "expense": [("61000", "Salaries and Wages", 120_000.00), ("61100", "Office Supplies", 2_000.00), ("61200", "Rent Expense", 36_000.00),
                          ("61300", "Legal Fees", 4_000.00), ("61400", "Meals", 1_000.00), ("61500", "Bank Fees", 300.00)],
              "other_income": [], "other_expense": [("69000", "Interest Expense", 2_500.00)]},
}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class PfsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (modules, member) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=modules))
                db.add(models.NexusGroupMember(group_id=gid, email=member))
            db.add(models.NexusRole(email=OWNER, role="owner"))
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self._invalidate_roles()

        self.asked = []
        # The accounting app's bank account records (Oct 6), as its internal
        # dashboard API sends them: Intacct accounts linked to a GL + entity,
        # and its own bank accounts pointing at a GL account id.
        self.recon_rows = []
        self.bank_rows = []

        async def fake_get(path, params):
            self.asked.append((path, {k: v for k, v in params.items() if v is not None}))
            if path.endswith("/dashboard"):
                return {"ok": True, "rows": self.recon_rows} if params.get("op") == "recon-accounts" else {"ok": True, "banks": self.bank_rows}
            if path.endswith("/reports/balance-sheet"):
                rows = BOOKS.get(params.get("location"), [])
                sections = [{"key": key, "accounts": [{"account_no": c, "title": t, "amount": a} for (k, c, t, a) in rows if k == key]}
                            for key in ("asset", "liability", "equity")]
                return {"ok": True, "sections": sections}
            if path.endswith("/reports/pnl"):
                book = PNL.get(params.get("location"), {})
                return {"ok": True, "sections": [{"key": k, "accounts": [{"account_no": c, "title": t, "amount": a} for (c, t, a) in book.get(k, [])]}
                                                 for k in ("revenue", "cogs", "expense", "other_income", "other_expense")]}
            return {"ok": True, "entities": [{"code": "60100", "name": "Business - ANK", "parent_code": None}]}

        self._get = accounting._acct_get
        accounting._acct_get = fake_get

    def tearDown(self):
        accounting._acct_get = self._get
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        self._invalidate_roles()

    @staticmethod
    def _invalidate_roles():
        getattr(auth, "_role_cache", {}).clear()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            ids = [p.id for p in db.query(models.PfsProfile).filter(models.PfsProfile.created_by.in_(EVERYONE)).all()]
            if ids:
                db.query(models.PfsLine).filter(models.PfsLine.profile_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.PfsStatement).filter(models.PfsStatement.profile_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.PfsProfile).filter(models.PfsProfile.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.resource_type == "pfs", models.AuditLog.user_email.in_(EVERYONE)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(list(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(list(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _profile(self, **over):
        _as(EDITOR)
        r = self.client.post("/pfs/profiles", json={"name": "Test Guarantor", "kind": "individual", **over})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def _line(self, pid, **body):
        r = self.client.post(f"/pfs/profiles/{pid}/lines", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    # ── who may see it ──────────────────────────────────────────────────────
    def test_only_owners_and_explicit_grants(self):
        pid = self._profile()["id"]
        for email, code in ((OWNER, 200), (EDITOR, 200), (VIEWER, 200), (ADMIN, 403), (ACCOUNTANT, 403)):
            _as(email)
            self.assertEqual(self.client.get("/pfs/profiles").status_code, code, email)
            self.assertEqual(self.client.get(f"/pfs/profiles/{pid}").status_code, code, email)
            self.assertEqual(self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").status_code, code, email)

    def test_a_viewer_reads_and_produces_but_does_not_change(self):
        pid = self._profile()["id"]
        _as(VIEWER)
        self.assertEqual(self.client.put(f"/pfs/profiles/{pid}", json={"name": "Changed"}).status_code, 403)
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines", json={"section": "asset", "category": "bank", "label": "x"}).status_code, 403)
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/statements", json={"asof": "2026-09-28"}).status_code, 201)
        _as(EDITOR)
        self.assertEqual(self.client.delete(f"/pfs/profiles/{pid}").status_code, 403)   # deleting takes Full
        _as(OWNER)
        self.assertEqual(self.client.delete(f"/pfs/profiles/{pid}").status_code, 204)

    # ── what is kept ────────────────────────────────────────────────────────
    def test_a_full_social_security_number_is_never_kept(self):
        p = self._profile(details={"ssn_last4": "123-45-6789", "address": "1 Main St", "unknown": "dropped",
                                   "members": [{"name": "A Person", "role": "Spouse"}, {"role": "no name"}]})
        self.assertEqual(p["details"], {"address": "1 Main St", "ssn_last4": "6789", "members": [{"name": "A Person", "role": "Spouse"}]})
        db = database.SessionLocal()
        try:
            self.assertNotIn("12345", str(db.query(models.PfsProfile).filter(models.PfsProfile.id == p["id"]).first().details))
        finally:
            db.close()

    def test_a_new_profile_carries_the_standard_questions(self):
        p = self._profile()
        self.assertEqual([h["question"] for h in p["history"]], pfs.HISTORY_QUESTIONS)

    def test_lines_are_checked(self):
        pid = self._profile()["id"]
        bad = [
            {"section": "asset", "category": "auto", "label": "x"},                                    # a liability category
            {"section": "asset", "category": "bank", "label": "  "},                                    # no name
            {"section": "asset", "category": "bank", "label": "x", "ownershipPct": 140},                # over 100%
            {"section": "asset", "category": "bank", "label": "x", "source": "ledger"},                 # ledger with nothing to read
            {"section": "asset", "category": "bank", "label": "x", "manualAsOf": "09/28/2026"},         # not ISO
            {"section": "real_estate", "category": "residential", "label": "x", "details": {"loan": {"source": "ledger"}}},
        ]
        for body in bad:
            self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines", json=body).status_code, 400, body)

    # ── the figures ─────────────────────────────────────────────────────────
    def test_statement(self):
        pid = self._profile()["id"]
        # 7.5% owner of a company: 7.5% of its two bank accounts.
        self._line(pid, section="asset", category="bank", label="Business - ANK Operating", institution="Farmers & Merchants Bank",
                   source="ledger", ledgerEntity="60100", ledgerAccounts=["10100", "10120"], ownershipPct=7.5)
        self._line(pid, section="asset", category="retirement", label="Roth IRA", institution="Fidelity", manualValue=120000, manualAsOf="2026-08-31")
        self._line(pid, section="asset", category="personal", label="Household", manualValue=50000)
        self._line(pid, section="liability", category="business_loan", label="F&M Bank Loan", source="ledger", ledgerEntity="60100",
                   ledgerAccounts=["25000"], ownershipPct=7.5)
        self._line(pid, section="liability", category="auto", label="Vehicle Loan", manualValue=18000.25)
        # A property owned 50%: worth 3,000,000 by hand, its mortgage read from the ledger.
        self._line(pid, section="real_estate", category="commercial", label="Greens Escondido", manualValue=3_000_000, ownershipPct=50,
                   details={"address": "1 Storage Way", "legal_owner": "Greens Escondido, LLC.", "loan": {"source": "ledger", "entity": "15000", "accounts": ["25100"]}})
        self._line(pid, section="real_estate", category="residential", label="Home", manualValue=900000,
                   details={"loan": {"source": "manual", "value": 860000}})
        s = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()

        bank = s["assets"][0]
        self.assertEqual((bank["key"], bank["rows"][0]["balance"], bank["rows"][0]["adjusted"]), ("bank", 1250000.5, 93750.04))
        self.assertEqual(bank["rows"][0]["asOf"], "2026-09-28")            # a ledger figure is as of the statement date
        self.assertEqual(s["assets"][1]["rows"][0]["asOf"], "2026-08-31")   # a manual one says when it was taken
        self.assertEqual([g["key"] for g in s["assets"]], ["bank", "retirement", "personal"])   # a lender's order, empty ones left out
        self.assertEqual([(g["key"], g["total"]) for g in s["liabilities"]], [("business_loan", 30000.0), ("auto", 18000.25)])

        commercial, residential = s["realEstate"][1], s["realEstate"][0]
        self.assertEqual((commercial["rows"][0]["valueAdjusted"], commercial["rows"][0]["loanAdjusted"], commercial["rows"][0]["equity"]),
                         (1500000.0, 1000000.0, 500000.0))
        self.assertEqual((residential["value"], residential["loan"]), (900000.0, 860000.0))

        self.assertEqual(s["summary"]["assets"][-1], {"label": "Real Estate (fair market value)", "amount": 2400000.0})
        self.assertEqual(s["summary"]["liabilities"][0], {"label": "Real Estate Loans", "amount": 1860000.0})
        self.assertEqual(s["totals"], {"assets": 2663750.04, "liabilities": 1908000.25, "netWorth": 755749.79})
        self.assertEqual(s["warnings"], [])
        # Each entity's balance sheet is read once, as of the date asked for.
        asked = sorted(p["location"] for (path, p) in self.asked if path.endswith("balance-sheet"))
        self.assertEqual(asked, ["15000", "60100"])
        self.assertTrue(all(p["asof"] == "2026-09-28" for (path, p) in self.asked if path.endswith("balance-sheet")))

    def test_an_account_with_no_balance_is_said_out_loud(self):
        pid = self._profile()["id"]
        self._line(pid, section="asset", category="bank", label="Closed Account", source="ledger", ledgerEntity="60100", ledgerAccounts=["19999", "10100"])
        s = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual(s["assets"][0]["rows"][0]["balance"], 1000000.0)
        self.assertEqual(len(s["warnings"]), 1)
        self.assertIn("19999", s["warnings"][0])

    def test_a_produced_statement_is_kept_as_it_was(self):
        pid = self._profile()["id"]
        line = self._line(pid, section="asset", category="personal", label="Household", manualValue=50000)
        _as(VIEWER)
        made = self.client.post(f"/pfs/profiles/{pid}/statements", json={"asof": "2026-09-28"}).json()
        self.assertEqual(made["totals"]["netWorth"], 50000.0)
        _as(EDITOR)
        self.client.put(f"/pfs/profiles/{pid}/lines/{line['id']}", json={"section": "asset", "category": "personal", "label": "Household", "manualValue": 75000})
        self.assertEqual(self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()["totals"]["netWorth"], 75000.0)
        self.assertEqual(self.client.get(f"/pfs/statements/{made['id']}").json()["totals"]["netWorth"], 50000.0)
        listed = self.client.get(f"/pfs/profiles/{pid}/statements").json()
        self.assertEqual([(x["asOf"], x["netWorth"], x["generatedBy"]) for x in listed], [("2026-09-28", 50000.0, VIEWER)])
        db = database.SessionLocal()
        try:
            rows = db.query(models.AuditLog).filter(models.AuditLog.resource_type == "pfs", models.AuditLog.resource_id == pid).all()
            actions = {a.action for a in rows}
            # The audit log says who did what; it never carries a figure.
            self.assertFalse(any("50000" in (a.details or "") or "75000" in (a.details or "") for a in rows))
        finally:
            db.close()
        self.assertTrue({"pfs_profile_created", "pfs_line_added", "pfs_line_changed", "pfs_statement_produced", "pfs_statement_opened"} <= actions)

    def test_bulk_setup_from_the_ledger(self):
        """One entity's accounts become one ledger line each, at the share
        given, never doubled (Neil, call of 09/29)."""
        pid = self._profile()["id"]
        body = {"section": "asset", "category": "bank", "entity": "60100", "entityName": "Business - ANK", "ownershipPct": 50,
                "accounts": [{"code": "10100", "label": "Operating Chkg 7546"}, {"code": "10120", "label": "Savings 2017", "category": "investment", "ownershipPct": 100}]}
        r = self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        made = r.json()
        self.assertEqual(made["added"], 2)
        by = {l["ledgerAccounts"][0]: l for l in made["lines"]}
        # The Institution is a bank, never the entity's name (Charmi, 10/03);
        # this title names none.
        self.assertEqual((by["10100"]["category"], by["10100"]["ownershipPct"], by["10100"]["accountRef"], by["10100"]["institution"], by["10100"]["source"]),
                         ("bank", 50.0, "7546", "", "ledger"))
        self.assertEqual((by["10120"]["category"], by["10120"]["ownershipPct"], by["10120"]["accountRef"]), ("investment", 100.0, "2017"))
        # Asked again: nothing doubles.
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json=body).json()["added"], 0)
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual(st["totals"]["assets"], 500000.0 + 250000.5)
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={**body, "section": "equity"}).status_code, 400)
        _as(VIEWER)
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json=body).status_code, 403)

    def test_spouse_and_the_four_real_estate_kinds(self):
        pid = self._profile(kind="joint", details={"spouse": "Archana Kadakia"})["id"]
        p = self.client.get(f"/pfs/profiles/{pid}").json()
        self.assertEqual(p["displayName"], "Test Guarantor and Archana Kadakia")
        self.assertEqual(self.client.get("/pfs/meta").json()["realEstateKinds"][0]["key"], "domestic_residential")
        # The old three-way split still reads and saves, as the four.
        line = self._line(pid, section="real_estate", category="commercial", label="Storage", manualValue=100, details={"loan": {"source": "manual", "value": 40}})
        self.assertEqual(line["category"], "domestic_commercial")
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual(st["profile"]["displayName"], "Test Guarantor and Archana Kadakia")
        self.assertEqual([g["key"] for g in st["realEstate"]], ["domestic_commercial"])
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines", json={"section": "real_estate", "category": "international_commercial", "label": "Pune office", "manualValue": 1}).status_code, 201)

    def test_accounts_for_the_picker(self):
        _as(EDITOR)
        r = self.client.get("/pfs/ledger/accounts?entity=60100&asof=2026-09-28").json()
        self.assertEqual([(a["code"], a["section"], a["amount"]) for a in r["accounts"]],
                         [("10100", "asset", 1000000.0), ("10120", "asset", 250000.5), ("25000", "liability", 400000.0)])
        self.assertEqual(self.client.get("/pfs/ledger/accounts?entity=60100&asof=yesterday").status_code, 400)

    # ── Oct 2: classification, Move to..., bulk liabilities and real estate,
    #    co-borrower, jewelry, Schedule E and C ─────────────────────────────
    def test_ledger_accounts_are_classified(self):
        """Charmi, 10/01: "these are bank accounts" - a cash-range account
        with no "bank" in its name is a bank account; IRA / 401k titles are
        retirement; a brokerage is investment; loans, lines of credit and
        credit cards are their liability categories; land and buildings are
        real estate; contra and working-capital accounts fall to Other."""
        _as(EDITOR)
        r = self.client.get("/pfs/ledger/accounts?entity=70000&asof=2026-09-28").json()
        got = {a["code"]: (a["suggested"]["section"], a["suggested"]["category"]) for a in r["accounts"]}
        self.assertEqual(got["11301"], ("asset", "bank"))            # "NRK & ANK - F&M - 6870"
        self.assertEqual(got["11352"], ("asset", "bank"))            # "ANK Earmarked ETC-7047"
        self.assertEqual(got["11309"], ("asset", "retirement"))
        self.assertEqual(got["11348"], ("asset", "investment"))
        self.assertEqual(got["12000"], ("asset", "other_holding"))
        self.assertEqual(got["15100"], ("real_estate", "domestic_commercial"))
        self.assertEqual(got["15200"], ("real_estate", "domestic_commercial"))
        self.assertEqual(got["15900"], ("asset", "other_holding"))
        self.assertEqual(got["25100"], ("liability", "business_loan"))
        self.assertEqual(got["24000"], ("liability", "loc"))
        self.assertEqual(got["23000"], ("liability", "credit_card"))
        self.assertEqual(got["22000"], ("liability", "other_liability"))
        # The account's own type, when the accounting app sends one, wins over the title.
        self.assertEqual(pfs.classify_account("asset", "19900", "Misc Holding", "cash_bank"), ("asset", "bank"))
        self.assertEqual(pfs.classify_account("liability", "25000", "Loan Payable", "credit_card"), ("liability", "credit_card"))
        self.assertEqual(pfs.classify_account("asset", "11400", "Roth IRA - Schwab", ""), ("asset", "retirement"))
        self.assertEqual(pfs.classify_account("asset", "11410", "HSA - Optum", ""), ("asset", "retirement"))
        self.assertEqual(pfs.classify_account("asset", "11500", "Vanguard Investments", ""), ("asset", "investment"))
        self.assertEqual(pfs.classify_account("asset", "13000", "Prepaid Insurance", ""), ("asset", "other_holding"))
        self.assertEqual(pfs.classify_account("liability", "26000", "Auto Loan - Toyota", ""), ("liability", "auto"))
        self.assertEqual(pfs.classify_account("liability", "27000", "HDFC Loan - Pune", ""), ("liability", "international"))

    def test_move_a_line_between_categories(self):
        pid = self._profile()["id"]
        line = self._line(pid, section="asset", category="other_holding", label="NRK & ANK - F&M - 6870", source="ledger",
                          ledgerEntity="70000", ledgerAccounts=["11301"])
        r = self.client.patch(f"/pfs/profiles/{pid}/lines/{line['id']}/move", json={"section": "asset", "category": "bank"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["section"], r.json()["category"], r.json()["ledgerAccounts"]), ("asset", "bank", ["11301"]))
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual([g["key"] for g in st["assets"]], ["bank"])
        # Across sections too: into real estate the line gets an empty loan so the schedule can read it.
        r = self.client.patch(f"/pfs/profiles/{pid}/lines/{line['id']}/move", json={"section": "real_estate", "category": "domestic_residential"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["details"]["loan"], {"source": "manual", "value": 0})
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual((st["assets"], [g["key"] for g in st["realEstate"]]), ([], ["domestic_residential"]))
        self.assertEqual(self.client.patch(f"/pfs/profiles/{pid}/lines/{line['id']}/move", json={"section": "asset", "category": "auto"}).status_code, 400)
        _as(VIEWER)
        self.assertEqual(self.client.patch(f"/pfs/profiles/{pid}/lines/{line['id']}/move", json={"section": "asset", "category": "bank"}).status_code, 403)
        db = database.SessionLocal()
        try:
            moved = db.query(models.AuditLog).filter(models.AuditLog.resource_type == "pfs", models.AuditLog.action == "pfs_line_moved").all()
            self.assertEqual(len(moved), 2)
            self.assertNotIn("12000", "".join(a.details for a in moved))   # never a figure
        finally:
            db.close()

    def test_bulk_liabilities_and_real_estate(self):
        """Charmi, 10/01: "The wiring is not done here and also Real Estate" -
        liabilities by category, and a land or building account as a property
        line whose loan is the mortgage account of the same entity."""
        pid = self._profile()["id"]
        r = self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={
            "section": "liability", "category": "other_liability", "entity": "70000", "entityName": "Escondido", "ownershipPct": 50,
            "accounts": [{"code": "24000", "label": "Line of Credit - Chase", "category": "loc"}, {"code": "23000", "label": "Amex Credit Card", "category": "credit_card"}]})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual(sorted((l["category"], l["ownershipPct"]) for l in r.json()["lines"]), [("credit_card", 50.0), ("loc", 50.0)])
        r = self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={
            "section": "real_estate", "category": "domestic_commercial", "entity": "70000", "entityName": "Greens Escondido, LLC", "ownershipPct": 50,
            "accounts": [{"code": "15200", "label": "Building - Escondido", "category": "domestic_commercial", "loanAccount": "25100"},
                         {"code": "15100", "label": "Land - Escondido", "category": "domestic_commercial"}]})
        self.assertEqual(r.status_code, 201, r.text)
        by = {l["ledgerAccounts"][0]: l for l in r.json()["lines"]}
        self.assertEqual(by["15200"]["details"]["loan"], {"source": "ledger", "entity": "70000", "accounts": ["25100"]})
        self.assertEqual(by["15200"]["details"]["legal_owner"], "Greens Escondido, LLC")
        self.assertEqual(by["15100"]["details"]["loan"], {"source": "manual", "value": 0})
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        re_ = st["realEstate"][0]
        rows = {r["label"]: r for r in re_["rows"]}
        self.assertEqual((rows["Building - Escondido"]["valueAdjusted"], rows["Building - Escondido"]["loanAdjusted"], rows["Building - Escondido"]["equity"]), (800000.0, 600000.0, 200000.0))
        self.assertEqual((rows["Land - Escondido"]["valueAdjusted"], rows["Land - Escondido"]["loanAdjusted"]), (200000.0, 0.0))
        self.assertEqual([(g["key"], g["total"]) for g in st["liabilities"]], [("loc", 25000.0), ("credit_card", 2000.0)])
        self.assertEqual(st["totals"], {"assets": 1000000.0, "liabilities": 627000.0, "netWorth": 373000.0})
        # Asked again: nothing doubles.
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={
            "section": "real_estate", "category": "domestic_commercial", "entity": "70000", "accounts": [{"code": "15100"}]}).json()["added"], 0)

    def test_co_borrower_is_kept_without_a_full_social_security_number(self):
        """Charmi, 10/01: spouse / co-borrower details. Last four of the SSN
        only - a longer value is refused, not trimmed."""
        pid = self._profile()["id"]
        co = {"name": "Archana Kadakia", "date_of_birth": "1975-05-04", "ssn_last4": "4321", "phone": "(760) 555-0100", "email": "archana@example.com",
              "address": "1 Main St", "city_state_zip": "Escondido, CA 92025", "employer": "Greens Global", "title": "Director", "marital_status": "Married", "junk": "x"}
        r = self.client.put(f"/pfs/profiles/{pid}", json={"name": "Neil R. Kadakia", "details": {"coBorrower": co}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["details"]["coBorrower"], {k: v for k, v in co.items() if k != "junk"})
        self.assertEqual(r.json()["displayName"], "Neil R. Kadakia and Archana Kadakia")
        r = self.client.put(f"/pfs/profiles/{pid}", json={"name": "Neil R. Kadakia", "details": {"coBorrower": {**co, "ssn_last4": "123-45-6789"}}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("last four", r.json()["detail"])
        db = database.SessionLocal()
        try:
            self.assertNotIn("6789", str(db.query(models.PfsProfile).filter(models.PfsProfile.id == pid).first().details))
        finally:
            db.close()

    def test_jewelry_folds_into_personal_holdings(self):
        """Oct 6 (Charmi): no Jewelry or Personal Property section - their
        lines are Personal Holdings, saved ones included, figures intact."""
        pid = self._profile()["id"]
        keys = [c["key"] for c in self.client.get("/pfs/meta").json()["assetCategories"]]
        self.assertNotIn("jewelry", keys)
        self.assertEqual(keys[:2], ["cash", "bank"])                       # Cash first
        self.assertEqual(keys.index("vehicles") + 1, keys.index("personal"))
        line = self._line(pid, section="asset", category="jewelry", label="Diamond necklace", manualValue=25000, manualAsOf="2026-03-15", details={"appraiser": "GIA"})
        self.assertEqual(line["category"], "personal")
        # A line saved under Jewelry before the change is moved, not lost.
        db = database.SessionLocal()
        try:
            db.add(models.PfsLine(id="pfs-test-old-jewel", profile_id=pid, section="asset", category="jewelry", label="Watch", ownership_pct=100,
                                  source="manual", manual_value=5000, manual_as_of="2026-01-10", details={"appraiser": "Tiffany"},
                                  updated_by=EDITOR, updated_at="2026-10-01T00:00:00+00:00"))
            db.commit()
        finally:
            db.close()
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual([(g["label"], g["total"]) for g in st["assets"]], [("Personal Holdings", 30000.0)])
        self.assertEqual({r["details"].get("appraiser") for r in st["assets"][0]["rows"]}, {"GIA", "Tiffany"})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.PfsLine).filter(models.PfsLine.id == "pfs-test-old-jewel").first().category, "personal")
        finally:
            db.close()

    # ── Oct 6 (Charmi, 10/03-10/04) ─────────────────────────────────────────
    def test_the_institution_is_the_bank(self):
        """"The INSTITUTION column shows Neil & Archana Kadakia - it must show
        the bank name." The bank account record linked to the GL wins; the
        account title is read when there is none."""
        self.assertEqual(pfs.bank_name("Chase Checking - 6532"), "Chase")
        self.assertEqual(pfs.bank_name("Bank of the West - 2721"), "Bank of the West")
        self.assertEqual(pfs.bank_name("CitiBank"), "Citibank")
        self.assertEqual(pfs.bank_name("US Bank Checking"), "U.S. Bank")
        self.assertEqual(pfs.bank_name("NRK & ANK - F&M - 6870"), "Farmers & Merchants Bank")
        self.assertEqual(pfs.bank_name("Pacific Western Bank Checking"), "Pacific Western Bank")
        self.assertEqual(pfs.bank_name("Operating Chkg 7546"), "")
        self.assertEqual(pfs.bank_name("Neil & Archana Kadakia"), "")
        pid = self._profile()["id"]
        # Set up the old way: the entity's name in Institution.
        for code, title in (("10100", "Operating Chkg 7546"), ("10120", "Savings 2017")):
            self._line(pid, section="asset", category="bank", label=title, institution="Neil & Archana Kadakia",
                       source="ledger", ledgerEntity="60100", ledgerAccounts=[code])
        self._line(pid, section="liability", category="business_loan", label="Loan Payable - F&M Bank", institution="Business - ANK",
                   source="ledger", ledgerEntity="60100", ledgerAccounts=["25000"])
        self._line(pid, section="asset", category="retirement", label="Roth IRA", institution="Neil's broker", manualValue=1)
        # 10100 is linked to a Bank of the West account in Intacct; 10120 has
        # a record of the app's own whose GL id is that account's.
        self.recon_rows = [{"account_id": "a-10100", "gl_code": "10100", "entity": "60100", "intacct_ref": "BOTW-7546"},
                           {"account_id": "a-10120", "gl_code": "10120", "entity": "60100", "intacct_ref": None}]
        self.bank_rows = [{"id": "b1", "nickname": "Savings", "bank_name": "Chase", "gl_account_id": "a-10120", "masked_number": "2017"}]
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        inst = {r["label"]: r["institution"] for g in st["assets"] + st["liabilities"] for r in g["rows"]}
        self.assertEqual(inst, {"Operating Chkg 7546": "Bank of the West", "Savings 2017": "Chase",
                                "Loan Payable - F&M Bank": "Farmers & Merchants Bank",   # from the title
                                "Roth IRA": "Neil's broker"})                              # typed by hand: as typed
        # The accounting app unable to answer: the title still decides, never the entity.
        self.recon_rows, self.bank_rows = [], []
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-29").json()
        self.assertEqual(st["assets"][0]["rows"][0]["institution"], "")

    def test_cash_is_its_own_section_first(self):
        self.assertEqual(pfs.classify_account("asset", "10000", "Cash", ""), ("asset", "cash"))
        self.assertEqual(pfs.classify_account("asset", "10010", "Petty Cash", ""), ("asset", "cash"))
        self.assertEqual(pfs.classify_account("asset", "10020", "Cash on Hand", "cash_bank"), ("asset", "bank"))   # the account's type wins
        self.assertEqual(pfs.classify_account("asset", "10030", "Drawer", "petty_cash"), ("asset", "cash"))
        self.assertEqual(pfs.classify_account("asset", "10100", "Cash - Chase 6532", ""), ("asset", "bank"))
        self.assertEqual(pfs.classify_account("asset", "16000", "Vehicle - Tesla Model X", ""), ("asset", "vehicles"))
        self.assertEqual(pfs.classify_account("asset", "13500", "Note Receivable - Greens LLC", ""), ("asset", "notes_receivable"))
        self.assertEqual(pfs.classify_account("liability", "26500", "Policy Loan - MassMutual", ""), ("liability", "insurance_loan"))
        pid = self._profile()["id"]
        self._line(pid, section="asset", category="bank", label="Chase Checking - 6532", manualValue=100)
        # Listed under Bank Accounts before the Cash section existed.
        db = database.SessionLocal()
        try:
            db.add(models.PfsLine(id="pfs-test-old-cash", profile_id=pid, section="asset", category="bank", label="Cash", ownership_pct=100,
                                  source="manual", manual_value=2500, details={}, updated_by=EDITOR, updated_at="2026-10-02T00:00:00+00:00"))
            db.commit()
        finally:
            db.close()
        self._line(pid, section="asset", category="vehicles", label="Tesla Model X", manualValue=60000)
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual([(g["key"], g["total"]) for g in st["assets"]], [("cash", 2500.0), ("bank", 100.0), ("vehicles", 60000.0)])

    def test_lines_keep_the_order_they_are_put_in(self):
        pid = self._profile()["id"]
        a = self._line(pid, section="asset", category="bank", label="Alpha", manualValue=1)
        b = self._line(pid, section="asset", category="bank", label="Bravo", manualValue=2)
        c = self._line(pid, section="asset", category="bank", label="Charlie", manualValue=3)
        r = self.client.put(f"/pfs/profiles/{pid}/line-order", json={"ids": [c["id"], a["id"], b["id"]]})
        self.assertEqual(r.status_code, 200, r.text)
        labels = lambda: [x["label"] for x in self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()["assets"][0]["rows"]]  # noqa: E731
        self.assertEqual(labels(), ["Charlie", "Alpha", "Bravo"])
        self.assertEqual([x["label"] for x in self.client.get(f"/pfs/profiles/{pid}").json()["lines"]], ["Charlie", "Alpha", "Bravo"])
        # A new line goes to the end, not to the top.
        self._line(pid, section="asset", category="bank", label="Aardvark", manualValue=4)
        self.assertEqual(labels(), ["Charlie", "Alpha", "Bravo", "Aardvark"])
        self.assertEqual(self.client.put(f"/pfs/profiles/{pid}/line-order", json={"ids": ["nope"]}).status_code, 404)
        _as(VIEWER)
        self.assertEqual(self.client.put(f"/pfs/profiles/{pid}/line-order", json={"ids": [a["id"]]}).status_code, 403)

    def test_the_first_page(self):
        """"You need to build out the first page of our PFS": every line of a
        bank's Statement of Financial Condition, totals that agree with the
        statement, guarantees listed but not added in, income from the
        schedules."""
        pid = self._profile()["id"]
        self._line(pid, section="asset", category="cash", label="Cash", manualValue=1000)
        self._line(pid, section="asset", category="bank", label="Chase", manualValue=9000, ownershipPct=50)
        self._line(pid, section="asset", category="bank", label="Citi", manualValue=1000, ownershipPct=100)
        self._line(pid, section="asset", category="investment", label="Schwab", manualValue=5000)
        self._line(pid, section="liability", category="credit_card", label="Amex", manualValue=700)
        self._line(pid, section="liability", category="loc", label="Chase LOC", manualValue=300)
        self._line(pid, section="liability", category="contingent", label="Guarantee - Greens Escondido loan", manualValue=1_000_000, ownershipPct=50)
        self._line(pid, section="real_estate", category="domestic_commercial", label="Greens Escondido", manualValue=2_000_000, ownershipPct=50,
                   details={"loan": {"source": "ledger", "entity": "70000", "accounts": ["25100"]}})
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        c = st["condition"]
        self.assertEqual([x["key"] for x in c["assets"]],
                         ["cash", "bank", "securities", "retirement", "real_estate", "business", "notes_receivable", "insurance", "vehicles", "personal", "other"])
        a = {x["key"]: x for x in c["assets"]}
        self.assertEqual((a["cash"]["amount"], a["bank"]["amount"], a["bank"]["ownership"], a["securities"]["amount"], a["real_estate"]["amount"], a["vehicles"]["amount"]),
                         (1000.0, 5500.0, "Various", 5000.0, 1_000_000.0, 0.0))
        liab = {x["key"]: x["amount"] for x in c["liabilities"]}
        self.assertEqual(liab, {"notes_banks": 300.0, "mortgages": 600_000.0, "credit_cards": 700.0, "auto": 0.0, "insurance_loan": 0.0, "other": 0.0})
        # The first page agrees with the statement; a guarantee is listed, not owed.
        self.assertEqual((c["totals"]["assets"], c["totals"]["liabilities"]), (st["totals"]["assets"], st["totals"]["liabilities"]))
        self.assertEqual(st["totals"]["liabilities"], 601_000.0)
        self.assertEqual([(x["label"], x["amount"]) for x in c["contingent"]], [("Guarantee - Greens Escondido loan", 500_000.0)])
        self.assertEqual([g["key"] for g in st["liabilities"]], ["loc", "credit_card"])
        self.assertEqual(c["contingentAnswer"], {"answer": "", "note": ""})
        self.assertEqual(c["income"], {"year": "2026", "lines": [{"key": "rental", "label": "Net Rental Income (Schedule E)", "amount": 8850.0}], "total": 8850.0})

    def test_where_a_statement_went_is_audited(self):
        pid = self._profile()["id"]
        self._line(pid, section="asset", category="personal", label="Household", manualValue=50000)
        r = self.client.post(f"/pfs/profiles/{pid}/statements", json={"asof": "2026-09-28", "format": "excel", "delivery": "email"})
        self.assertEqual(r.status_code, 201, r.text)
        db = database.SessionLocal()
        try:
            a = db.query(models.AuditLog).filter(models.AuditLog.action == "pfs_statement_produced", models.AuditLog.resource_id == pid).first()
            self.assertIn('"format": "xlsx"', a.details)
            self.assertIn('"delivery": "email"', a.details)
            self.assertNotIn("50000", a.details)
        finally:
            db.close()

    def test_schedule_e_and_c_lines(self):
        """Charmi, 10/01: "SCH C and Sch E reporting". A real estate line with
        an entity gets a Schedule E for the statement's calendar year; a
        business interest with an entity gets a Schedule C. Titles land on
        the IRS lines."""
        self.assertEqual(pfs.irs_line("e", "Mortgage Interest"), "mortgage_interest")
        self.assertEqual(pfs.irs_line("e", "Interest Expense"), "other_interest")
        self.assertEqual(pfs.irs_line("e", "Property Management Fees"), "management")
        self.assertEqual(pfs.irs_line("e", "Gas and Electric"), "utilities")
        self.assertEqual(pfs.irs_line("e", "HOA Dues"), "other")
        self.assertEqual(pfs.irs_line("c", "Salaries and Wages"), "wages")
        self.assertEqual(pfs.irs_line("c", "Rent Expense"), "rent_other")
        self.assertEqual(pfs.irs_line("c", "Bank Fees"), "commissions")
        self.assertEqual(pfs.irs_line("c", "Meals"), "meals")
        pid = self._profile()["id"]
        self._line(pid, section="real_estate", category="domestic_commercial", label="Greens Escondido", manualValue=2_000_000, ownershipPct=50,
                   details={"address": "1 Storage Way", "loan": {"source": "ledger", "entity": "70000", "accounts": ["25100"]}})
        self._line(pid, section="asset", category="business", label="Business - ANK", manualValue=1, ownershipPct=7.5, details={"schedule_entity": "60100"})
        self._line(pid, section="asset", category="business", label="No entity", manualValue=1)
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        sch = st["schedules"]
        self.assertEqual(sch["year"], "2026")
        self.assertEqual(len(sch["e"]), 1)
        e = sch["e"][0]
        self.assertEqual((e["label"], e["entity"], e["income"], e["expenses"], e["net"], e["netAtShare"]), ("Greens Escondido", "70000", 120000.0, 102300.0, 17700.0, 8850.0))
        self.assertEqual([(x["key"], x["amount"]) for x in e["lines"]],
                         [("management", 9600.0), ("mortgage_interest", 42000.0), ("repairs", 3100.0), ("taxes", 14000.0), ("utilities", 2400.0), ("depreciation", 30000.0), ("other", 1200.0)])
        self.assertEqual(len(sch["c"]), 1)
        c = sch["c"][0]
        self.assertEqual((c["entity"], c["income"], c["cogs"], c["expenses"], c["net"]), ("60100", 500000.0, 150000.0, 165800.0, 184200.0))
        self.assertEqual([(x["key"], x["amount"]) for x in c["lines"]],
                         [("commissions", 300.0), ("interest_other", 2500.0), ("legal", 4000.0), ("rent_other", 36000.0), ("supplies", 2000.0), ("meals", 1000.0), ("wages", 120000.0)])
        # The P&L was asked for the calendar year of the statement date, per entity.
        asked = sorted((p["location"], p["from"], p["to"]) for (path, p) in self.asked if path.endswith("/reports/pnl"))
        self.assertEqual(asked, [("60100", "2026-01-01", "2026-12-31"), ("70000", "2026-01-01", "2026-12-31")])

    def test_everyone_with_the_grant_sees_every_profile(self):
        """Charmi, 10/01: "This only shows Neil Kadakia" - a profile is not
        the creator's; everyone let in sees them all."""
        pid = self._profile()["id"]
        for email in (OWNER, VIEWER):
            _as(email)
            self.assertIn(pid, [p["id"] for p in self.client.get("/pfs/profiles").json()], email)


if __name__ == "__main__":
    unittest.main()
