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

OWNER = "owner.pfs.test@greensglobal.com"
ADMIN = "admin.pfs.test@greensglobal.com"        # administrator, no pfs grant
EDITOR = "editor.pfs.test@greensglobal.com"      # pfs:editor
VIEWER = "viewer.pfs.test@greensglobal.com"      # pfs:viewer
ACCOUNTANT = "acct.pfs.test@greensglobal.com"    # accounting:full, no pfs grant
EVERYONE = (OWNER, ADMIN, EDITOR, VIEWER, ACCOUNTANT)
GROUPS = {"grp-pfs-test-editor": ("pfs:editor", EDITOR), "grp-pfs-test-viewer": ("pfs:viewer", VIEWER),
          "grp-pfs-test-acct": ("accounting:full", ACCOUNTANT)}

# Balance sheets the stand-in accounting service answers with, per entity.
BOOKS = {
    "60100": [("asset", "10100", "Operating Chkg 7546", 1_000_000.00), ("asset", "10120", "Savings 2017", 250_000.50),
              ("liability", "25000", "Loan Payable - F&M Bank", 400_000.00)],
    "15000": [("asset", "10100", "Escondido Chkg", 80_000.00), ("liability", "25100", "Mortgage - Escondido", 2_000_000.00)],
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

        async def fake_get(path, params):
            self.asked.append((path, {k: v for k, v in params.items() if v is not None}))
            if path.endswith("/reports/balance-sheet"):
                rows = BOOKS.get(params.get("location"), [])
                sections = [{"key": key, "accounts": [{"account_no": c, "title": t, "amount": a} for (k, c, t, a) in rows if k == key]}
                            for key in ("asset", "liability", "equity")]
                return {"ok": True, "sections": sections}
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
        self.assertEqual((by["10100"]["category"], by["10100"]["ownershipPct"], by["10100"]["accountRef"], by["10100"]["institution"], by["10100"]["source"]),
                         ("bank", 50.0, "7546", "Business - ANK", "ledger"))
        self.assertEqual((by["10120"]["category"], by["10120"]["ownershipPct"], by["10120"]["accountRef"]), ("investment", 100.0, "2017"))
        # Asked again: nothing doubles.
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json=body).json()["added"], 0)
        st = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-09-28").json()
        self.assertEqual(st["totals"]["assets"], 500000.0 + 250000.5)
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={**body, "section": "real_estate"}).status_code, 400)
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


if __name__ == "__main__":
    unittest.main()
