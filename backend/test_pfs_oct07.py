"""PFS - Neil's and Charmi's Oct 7 list, the rules as tests.

A role per borrower on Affiliated Entities; the statement's share of an entity
read from Affiliated Entities (Beneficial % else the sum of the borrowers', a
sub-entity inheriting its parent's row, a typed % winning); the liability
categories (Commercial / Residential Loans, retired ones read on); Investments
with real estate at equity counted once; the institution found through a
parent entity; Cash titles; the password-protected PDF (the password never
kept); and PFS access set from Accounting > Access.

Runs on its own temporary database:

    python -m pytest test_pfs_oct07.py
"""
import base64
import io
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import accounting, pfs, pfs_access  # noqa: E402

OWNER = "owner.oct7.test@greensglobal.com"
EDITOR = "editor.oct7.test@greensglobal.com"
VIEWER = "viewer.oct7.test@greensglobal.com"
PERSON = "archana.oct7.test@greensglobal.com"     # no grant yet
EVERYONE = (OWNER, EDITOR, VIEWER, PERSON)
GROUPS = {"grp-oct7-editor": ("pfs:editor", EDITOR), "grp-oct7-viewer": ("pfs:viewer", VIEWER)}

BOOKS = {
    "67001": [("asset", "11222", "GA - OP - FSB - 1485", 10_000.00), ("asset", "10000", "GA - Cash", 500.00)],
    "67001-1": [("asset", "11300", "Operating 4411", 2_000.00)],
    "67005": [("asset", "11400", "Savings 9001", 4_000.00)],
    "80000": [("asset", "11500", "Reserve 7000", 1_000.00)],
}
ENTITIES = [{"code": "67001", "name": "Greens Austin", "parent_code": None},
            {"code": "67001-1", "name": "Greens Austin - Ops", "parent_code": None},
            {"code": "67005", "name": "Greens Austin Sub", "parent_code": "67001"},
            {"code": "80000", "name": "Elsewhere", "parent_code": None}]


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _pdf() -> bytes:
    from pypdf import PdfWriter
    w = PdfWriter()
    w.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


class Oct07Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._lock = pfs_access.LOCK_ENABLED
        pfs_access.LOCK_ENABLED = False
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (modules, member) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=modules))
                db.add(models.NexusGroupMember(group_id=gid, email=member))
            db.add(models.NexusRole(email=OWNER, role="owner"))
            db.add(models.NexusEmployee(id="emp-oct7-archana", first_name="Archana", last_name="Test", work_email=PERSON, status="active"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth._role_cache.clear()
        self.recon_rows, self.bank_rows = [], []

        async def fake_get(path, params):
            if path.endswith("/dashboard"):
                return {"ok": True, "rows": self.recon_rows} if params.get("op") == "recon-accounts" else {"ok": True, "banks": self.bank_rows}
            if path.endswith("/reports/balance-sheet"):
                rows = BOOKS.get(params.get("location"), [])
                return {"ok": True, "sections": [{"key": k, "accounts": [{"account_no": c, "title": t, "amount": a} for (s, c, t, a) in rows if s == k]}
                                                 for k in ("asset", "liability", "equity")]}
            if path.endswith("/reports/pnl"):
                return {"ok": True, "sections": []}
            return {"ok": True, "entities": ENTITIES}

        self._get = accounting._acct_get
        accounting._acct_get = fake_get

    def tearDown(self):
        accounting._acct_get = self._get
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        pfs_access.LOCK_ENABLED = self._lock
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth._role_cache.clear()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            for t in (models.PfsLine, models.PfsStatement, models.PfsAffiliate, models.PfsProfile, models.NexusGroupMember, models.NexusGroup,
                      models.NexusRole, models.NexusEmployee, models.AuditLog):
                db.query(t).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _file(self, **over):
        _as(EDITOR)
        r = self.client.post("/pfs/profiles", json={"name": "Neil R. Kadakia", "kind": "joint",
                                                     "details": {"coBorrower": {"name": "Archana N. Kadakia"}}, **over})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def _affiliate(self, pid, **body):
        r = self.client.post(f"/pfs/profiles/{pid}/affiliates", json={"name": "Greens Austin", **body})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def _line(self, pid, **body):
        r = self.client.post(f"/pfs/profiles/{pid}/lines", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def _statement(self, pid):
        r = self.client.get(f"/pfs/profiles/{pid}/statement?asof=2026-10-01")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── 6: a role per borrower ──────────────────────────────────────────────
    def test_a_role_per_borrower(self):
        pid = self._file()
        a = self._affiliate(pid, ownership={"primary": 10, "co": 10}, roles={"primary": "managing member", "co": "Silent partner"})
        self.assertEqual(a["roles"], {"primary": "Managing Member", "co": "Silent partner"})
        self.assertEqual(a["role"], "Managing Member")       # the old field still written
        # An older client sending one role: it is the primary borrower's.
        b = self._affiliate(pid, name="Old Way LLC", role="Member")
        self.assertEqual(b["roles"], {"primary": "Member"})
        # A row saved before `roles` existed reads its role as the primary's.
        db = database.SessionLocal()
        try:
            db.add(models.PfsAffiliate(id="aff-oct7-old", profile_id=pid, name="Older LLC", role="Trustee", ownership={}, roles=None))
            db.commit()
        finally:
            db.close()
        rows = {r["name"]: r for r in self.client.get(f"/pfs/profiles/{pid}/affiliates").json()["rows"]}
        self.assertEqual(rows["Older LLC"]["roles"], {"primary": "Trustee"})
        # A borrower who is not on the file gets no role.
        r = self.client.post(f"/pfs/profiles/{pid}/affiliates", json={"name": "X", "roles": {"spouse": "Member"}})
        self.assertEqual(r.status_code, 400)
        solo = self._file(name="Solo Person", kind="individual", details={})
        r = self.client.post(f"/pfs/profiles/{solo}/affiliates", json={"name": "X", "roles": {"co": "Member"}})
        self.assertEqual(r.status_code, 400)
        # Roles travel with the statement for the exports.
        st = self._statement(pid)
        self.assertEqual({r["name"]: r["roles"] for r in st["affiliated"]["rows"]}["Greens Austin"], {"primary": "Managing Member", "co": "Silent partner"})

    # ── 28: the share comes from Affiliated Entities ────────────────────────
    def test_the_share_is_read_from_affiliated_entities(self):
        pid = self._file()
        aff = self._affiliate(pid, ownership={"primary": 10, "co": 10}, ledgerEntity="67001")
        follow = self._line(pid, section="asset", category="bank", label="GA - OP - FSB - 1485", source="ledger", ledgerEntity="67001",
                            ledgerAccounts=["11222"], ownershipPct=100, details={"shareFrom": "affiliated"})
        typed = self._line(pid, section="asset", category="bank", label="GA typed", source="ledger", ledgerEntity="67001",
                           ledgerAccounts=["11222"], ownershipPct=50, details={"shareFrom": "manual"})
        st = self._statement(pid)
        rows = {r["id"]: r for g in st["assets"] for r in g["rows"]}
        self.assertEqual((rows[follow["id"]]["ownershipPct"], rows[follow["id"]]["adjusted"]), (20.0, 2000.0))
        self.assertEqual(rows[follow["id"]]["affiliatedShare"]["text"], "Neil R. Kadakia 10% + Archana N. Kadakia 10%")
        self.assertEqual(rows[follow["id"]]["storedOwnershipPct"], 100.0)
        self.assertEqual(rows[typed["id"]]["ownershipPct"], 50.0)          # a typed % wins
        # A change on Affiliated Entities flows to the statement; Beneficial % wins over the sum.
        self.client.put(f"/pfs/profiles/{pid}/affiliates/{aff['id']}", json={"name": "Greens Austin", "ownership": {"primary": 10, "co": 10},
                                                                            "beneficialPct": 15, "ledgerEntity": "67001"})
        st = self._statement(pid)
        row = next(r for g in st["assets"] for r in g["rows"] if r["id"] == follow["id"])
        self.assertEqual((row["ownershipPct"], row["affiliatedShare"]["basis"]), (15.0, "beneficial"))
        self.assertEqual(st["totals"]["assets"], 1500.0 + 5000.0)
        # GET /profiles reads the same.
        line = next(x for x in self.client.get(f"/pfs/profiles/{pid}").json()["lines"] if x["id"] == follow["id"])
        self.assertEqual((line["ownershipPct"], line["shareFrom"], line["storedOwnershipPct"]), (15.0, "affiliated", 100.0))

    def test_a_sub_entity_inherits_its_parents_row(self):
        pid = self._file()
        self._affiliate(pid, ownership={"primary": 30}, ledgerEntity="67001")
        self._affiliate(pid, name="Elsewhere", ownership={"primary": 5, "co": 5}, ledgerEntity="80000")
        r = self.client.get(f"/pfs/profiles/{pid}/affiliated-shares?entities=67001-1,67005,80000,99999").json()
        self.assertEqual(set(r["shares"]), {"67001", "80000"})
        res = r["resolved"]
        self.assertEqual((res["67001-1"]["pct"], res["67001-1"]["via"], res["67001-1"]["inherited"]), (30.0, "67001", True))
        self.assertEqual((res["67005"]["pct"], res["67005"]["via"]), (30.0, "67001"))       # parent_code
        self.assertEqual((res["80000"]["pct"], res["80000"]["inherited"]), (10.0, False))
        self.assertIsNone(res["99999"])
        # A sub-entity with its own row reads its own.
        self._affiliate(pid, name="Sub", ownership={"primary": 40}, ledgerEntity="67005")
        res = self.client.get(f"/pfs/profiles/{pid}/affiliated-shares?entities=67005").json()["resolved"]
        self.assertEqual((res["67005"]["pct"], res["67005"]["inherited"]), (40.0, False))

    def test_bulk_add_follows_affiliated_entities_by_default(self):
        pid = self._file()
        self._affiliate(pid, ownership={"primary": 10, "co": 10}, ledgerEntity="67001")
        r = self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={"section": "asset", "category": "bank", "entity": "67001-1", "ownershipPct": 100,
                                                                       "accounts": [{"code": "11300", "label": "Operating 4411"}]})
        self.assertEqual(r.status_code, 201, r.text)
        body = r.json()
        self.assertEqual((body["shareFrom"], body["affiliatedShare"]["pct"]), ("affiliated", 20.0))
        self.assertEqual((body["lines"][0]["shareFrom"], body["lines"][0]["ownershipPct"]), ("affiliated", 20.0))
        # No row for the entity: as typed, manual.
        r = self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={"section": "asset", "category": "bank", "entity": "80000", "ownershipPct": 60,
                                                                       "accounts": [{"code": "11500", "label": "Reserve 7000"}]}).json()
        self.assertEqual((r["shareFrom"], r["affiliatedShare"], r["lines"][0]["ownershipPct"]), ("manual", None, 60.0))
        # Asked for manual: as typed.
        r = self.client.post(f"/pfs/profiles/{pid}/lines/bulk", json={"section": "asset", "category": "bank", "entity": "67001", "ownershipPct": 35,
                                                                       "shareFrom": "manual", "accounts": [{"code": "11222", "label": "x"}]}).json()
        self.assertEqual((r["lines"][0]["shareFrom"], r["lines"][0]["ownershipPct"]), ("manual", 35.0))

    def test_lines_with_a_different_share_are_offered_once(self):
        pid = self._file()
        self._affiliate(pid, ownership={"primary": 10, "co": 10}, ledgerEntity="67001")
        # Lines from before Oct 7 (no shareFrom): one differs, one agrees.
        old = self._line(pid, section="asset", category="bank", label="Old", source="ledger", ledgerEntity="67001", ledgerAccounts=["11222"], ownershipPct=100)
        self._line(pid, section="asset", category="bank", label="Agrees", source="ledger", ledgerEntity="67001", ledgerAccounts=["10000"], ownershipPct=20)
        other = self._line(pid, section="asset", category="bank", label="Sub old", source="ledger", ledgerEntity="67005", ledgerAccounts=["11400"], ownershipPct=50)
        m = self.client.get(f"/pfs/profiles/{pid}/share-mismatches").json()
        self.assertEqual({x["id"]: (x["ownershipPct"], x["affiliatedPct"]) for x in m["lines"]}, {old["id"]: (100.0, 20.0), other["id"]: (50.0, 20.0)})
        r = self.client.post(f"/pfs/profiles/{pid}/share-mismatches", json={"ids": [old["id"]], "action": "update"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["lines"][0]["shareFrom"], r.json()["lines"][0]["storedOwnershipPct"]), ("affiliated", 20.0))
        r = self.client.post(f"/pfs/profiles/{pid}/share-mismatches", json={"ids": [other["id"]], "action": "keep"})
        self.assertEqual(r.json()["lines"][0]["shareFrom"], "manual")
        self.assertEqual(self.client.get(f"/pfs/profiles/{pid}/share-mismatches").json()["count"], 0)
        _as(VIEWER)
        self.assertEqual(self.client.post(f"/pfs/profiles/{pid}/share-mismatches", json={"ids": [old["id"]], "action": "keep"}).status_code, 403)

    # ── 29: no EIN / State asked ────────────────────────────────────────────
    def test_ein_and_state_are_not_required(self):
        pid = self._file()
        a = self._affiliate(pid, ownership={"primary": 10})
        self.assertEqual((a["einLast4"], a["state"]), ("", ""))

    # ── 30: liabilities ─────────────────────────────────────────────────────
    def test_liability_categories(self):
        meta = self.client.get("/pfs/meta").json() if self._as_editor() else None
        self.assertEqual([c["key"] for c in meta["liabilityCategories"]],
                         ["business_loan", "residential_loan", "auto", "loc", "credit_card", "other_liability"])
        self.assertEqual(meta["liabilityCategories"][0]["label"], "Commercial Loans")
        self.assertEqual(meta["retiredCategories"], [{"key": "contingent", "label": "Contingent Liabilities"}])
        self.assertEqual(pfs.classify_account("liability", "27000", "HDFC Loan - Pune", ""), ("liability", "business_loan"))
        self.assertEqual(pfs.classify_account("liability", "27100", "Home Loan - Wells Fargo", ""), ("liability", "residential_loan"))
        self.assertEqual(pfs.classify_account("liability", "27200", "HELOC - Chase", ""), ("liability", "residential_loan"))
        self.assertEqual(pfs.classify_account("liability", "27300", "Policy Loan - MassMutual", ""), ("liability", "other_liability"))
        self.assertEqual(pfs.classify_account("liability", "27400", "Line of Credit - Chase", ""), ("liability", "loc"))
        pid = self._file()
        # Old lines in retired categories, saved before Oct 7.
        db = database.SessionLocal()
        try:
            for i, (cat, label, value) in enumerate((("international", "HDFC Loan", 1000), ("insurance_loan", "Policy Loan", 200), ("contingent", "Guarantee", 5000))):
                db.add(models.PfsLine(id=f"pfs-oct7-old-{i}", profile_id=pid, section="liability", category=cat, label=label, ownership_pct=100,
                                      source="manual", manual_value=value, details={}, sort=0, notes="", updated_by=EDITOR, updated_at="2026-10-02"))
            db.commit()
        finally:
            db.close()
        self._line(pid, section="liability", category="residential_loan", label="Home Loan", manualValue=300)
        # Contingent is no longer offered for a new line, nor as a move target ...
        r = self.client.post(f"/pfs/profiles/{pid}/lines", json={"section": "liability", "category": "contingent", "label": "G", "manualValue": 1})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.patch(f"/pfs/profiles/{pid}/lines/pfs-oct7-old-0/move", json={"section": "liability", "category": "contingent"}).status_code, 400)
        # ... but an old contingent line can still be saved as it is.
        r = self.client.put(f"/pfs/profiles/{pid}/lines/pfs-oct7-old-2", json={"section": "liability", "category": "contingent", "label": "Guarantee", "manualValue": 6000})
        self.assertEqual(r.status_code, 200, r.text)
        st = self._statement(pid)
        self.assertEqual({g["key"]: g["total"] for g in st["liabilities"]}, {"business_loan": 1000.0, "residential_loan": 300.0, "other_liability": 200.0})
        self.assertEqual(st["liabilities"][0]["label"], "Commercial Loans")
        self.assertEqual(st["totals"]["liabilities"], 1500.0)       # the guarantee is never added in
        c = st["condition"]
        self.assertEqual({x["key"]: x["amount"] for x in c["liabilities"]}, {"notes_banks": 1300.0, "mortgages": 0.0, "credit_cards": 0.0, "auto": 0.0, "other": 200.0})
        self.assertEqual([(x["label"], x["amount"]) for x in c["contingent"]], [("Guarantee", 6000.0)])
        lines = {x["id"]: x["category"] for x in self.client.get(f"/pfs/profiles/{pid}").json()["lines"]}
        self.assertEqual((lines["pfs-oct7-old-0"], lines["pfs-oct7-old-1"], lines["pfs-oct7-old-2"]), ("business_loan", "other_liability", "contingent"))

    def _as_editor(self):
        _as(EDITOR)
        return True

    # ── 36: Investments ─────────────────────────────────────────────────────
    def test_investments_hold_real_estate_at_equity_once(self):
        pid = self._file()
        self._line(pid, section="asset", category="cash", label="Cash", manualValue=100)
        self._line(pid, section="asset", category="investment", label="Schwab", manualValue=5000)
        self._line(pid, section="asset", category="business", label="Greens LLC", manualValue=20000, ownershipPct=50)
        self._line(pid, section="real_estate", category="domestic_commercial", label="Plaza", manualValue=1_000_000, ownershipPct=50,
                   details={"loan": {"source": "manual", "value": 600_000}})
        st = self._statement(pid)
        inv = st["investments"]
        self.assertEqual([(g["key"], g["total"]) for g in inv["groups"]], [("investment", 5000.0), ("business", 10000.0), ("real_estate_equity", 200_000.0)])
        self.assertEqual(inv["total"], 215_000.0)
        self.assertEqual(inv["assetKeys"], ["investment", "business"])
        self.assertEqual(inv["realEstate"], {"value": 500_000.0, "loans": 300_000.0, "equity": 200_000.0})
        self.assertEqual(inv["groups"][2]["rows"][0]["equity"], 200_000.0)
        # Totals unchanged: the property's value once in assets, its loan once in liabilities.
        self.assertEqual(st["totals"], {"assets": 515_100.0, "liabilities": 300_000.0, "netWorth": 215_100.0})

    # ── 17 + 11: institution and Cash ───────────────────────────────────────
    def test_institution_through_a_parent_entity_and_missing_flag(self):
        pid = self._file()
        a = self._line(pid, section="asset", category="bank", label="Operating 4411", source="ledger", ledgerEntity="67001-1", ledgerAccounts=["11300"])
        b = self._line(pid, section="asset", category="bank", label="Savings 9001", source="ledger", ledgerEntity="67005", ledgerAccounts=["11400"])
        c = self._line(pid, section="asset", category="bank", label="Reserve 7000", source="ledger", ledgerEntity="80000", ledgerAccounts=["11500"])
        # The bank records sit on the parent entity; one is named only by the
        # app's own bank record, whose GL id is the GL code itself.
        self.recon_rows = [{"account_id": "acc-1", "gl_code": "11300", "entity": "67001", "bank_name": "Bank of the West"},
                           {"account_id": "acc-2", "gl_code": "11400 ", "entity": " 67001", "bank_name": None, "intacct_ref": "OP-9001"}]
        self.bank_rows = [{"gl_account_id": "11400", "bank_name": "Frost Bank", "nickname": "Savings"}]
        st = self._statement(pid)
        rows = {r["id"]: r for g in st["assets"] for r in g["rows"]}
        self.assertEqual(rows[a["id"]]["institution"], "Bank of the West")
        self.assertEqual(rows[b["id"]]["institution"], "Frost Bank")
        self.assertEqual((rows[c["id"]]["institution"], rows[c["id"]]["institutionMissing"]), ("", True))
        self.assertFalse(rows[a["id"]]["institutionMissing"])

    def test_cash_titles_from_the_ledger(self):
        for title in ("Cash", "GA - Cash", "Cash - RJK", "RJK & ANK - Cash Account", "Petty Cash"):
            self.assertTrue(pfs.is_cash_title(title), title)
        for title in ("Cash - Chase 6532", "Cash - Chase", "Cash Clearing", "Operating Chkg 7546"):
            self.assertFalse(pfs.is_cash_title(title), title)
        self.assertEqual(pfs.classify_account("asset", "10000", "GA - Cash", ""), ("asset", "cash"))
        pid = self._file()
        db = database.SessionLocal()
        try:
            db.add(models.PfsLine(id="pfs-oct7-cash", profile_id=pid, section="asset", category="bank", label="GA - Cash", ownership_pct=100, source="manual",
                                  manual_value=500, details={}, sort=0, notes="", updated_by=EDITOR, updated_at="2026-10-07T10:00:00+00:00"))
            db.commit()
        finally:
            db.close()
        self._line(pid, section="asset", category="bank", label="Chase Checking - 6532", manualValue=100)
        st = self._statement(pid)
        self.assertEqual([g["key"] for g in st["assets"]], ["cash", "bank"])

    # ── 37: password-protected PDF ──────────────────────────────────────────
    def test_the_pdf_is_encrypted_and_the_password_never_kept(self):
        from pypdf import PdfReader
        pid = self._file()
        _as(VIEWER)
        secret = "123-45-6789"
        r = self.client.post(f"/pfs/profiles/{pid}/pdf/encrypt", json={"pdf": base64.b64encode(_pdf()).decode(), "password": secret, "statementId": "s-1"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["encryption"], "AES-256")
        out = base64.b64decode(r.json()["pdf"])
        reader = PdfReader(io.BytesIO(out))
        self.assertTrue(reader.is_encrypted)
        self.assertEqual(reader.decrypt("wrong").name, "NOT_DECRYPTED")
        self.assertNotEqual(reader.decrypt(secret).name, "NOT_DECRYPTED")
        self.assertEqual(len(reader.pages), 1)
        db = database.SessionLocal()
        try:
            rows = db.query(models.AuditLog).filter(models.AuditLog.action == "pfs_pdf_encrypted").all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(json.loads(rows[0].details), {"statement": "s-1", "encryption": "AES-256"})
            self.assertFalse(any(secret in (x.details or "") for x in db.query(models.AuditLog).all()))
        finally:
            db.close()
        # Bad input is refused without echoing the password.
        for body in ({"pdf": base64.b64encode(_pdf()).decode(), "password": "abc"}, {"pdf": "bm90IGEgcGRm", "password": secret},
                     {"pdf": 5, "password": secret}, {"pdf": base64.b64encode(_pdf()).decode(), "password": 123456}):
            r = self.client.post(f"/pfs/profiles/{pid}/pdf/encrypt", json=body)
            self.assertEqual(r.status_code, 400, r.text)
            self.assertNotIn(secret, r.text)

    # ── 41: PFS access from Accounting > Access ─────────────────────────────
    def test_owners_set_pfs_access(self):
        _as(EDITOR)
        self.assertEqual(self.client.get("/pfs-access/people").status_code, 403)
        self.assertEqual(self.client.put(f"/pfs-access/people/{PERSON}", json={"level": "viewer"}).status_code, 403)
        _as(PERSON)
        self.assertEqual(self.client.get("/pfs/profiles").status_code, 403)
        _as(OWNER)
        people = {p["email"]: p for p in self.client.get("/pfs-access/people").json()["people"]}
        self.assertEqual((people[PERSON]["level"], people[PERSON]["name"]), ("none", "Archana Test"))
        self.assertEqual((people[EDITOR]["level"], people[EDITOR]["managedLevel"], people[EDITOR]["otherGroups"][0]["id"]), ("editor", "none", "grp-oct7-editor"))
        self.assertEqual((people[OWNER]["level"], people[OWNER]["canChange"]), ("owner", False))
        r = self.client.put(f"/pfs-access/people/{PERSON}", json={"level": "viewer"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["level"], r.json()["managedLevel"]), ("viewer", "viewer"))
        _as(PERSON)
        self.assertEqual(self.client.get("/pfs/profiles").status_code, 200)
        self.assertEqual(self.client.post("/pfs/profiles", json={"name": "Nope"}).status_code, 403)
        _as(OWNER)
        self.assertEqual(self.client.put(f"/pfs-access/people/{PERSON}", json={"level": "editor"}).json()["level"], "editor")
        _as(PERSON)
        self.assertEqual(self.client.post("/pfs/profiles", json={"name": "Yes"}).status_code, 201)
        _as(OWNER)
        self.assertEqual(self.client.put(f"/pfs-access/people/{PERSON}", json={"level": "none"}).json()["level"], "none")
        _as(PERSON)
        self.assertEqual(self.client.get("/pfs/profiles").status_code, 403)
        _as(OWNER)
        self.assertEqual(self.client.put(f"/pfs-access/people/{OWNER}", json={"level": "none"}).status_code, 400)
        self.assertEqual(self.client.put(f"/pfs-access/people/{PERSON}", json={"level": "full"}).status_code, 400)
        db = database.SessionLocal()
        try:
            audit = [json.loads(a.details) for a in db.query(models.AuditLog).filter(models.AuditLog.action == "pfs_access_changed").order_by(models.AuditLog.id).all()]
            self.assertEqual([(a["from"], a["to"]) for a in audit], [("none", "viewer"), ("viewer", "editor"), ("editor", "none")])
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
