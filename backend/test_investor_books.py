"""Investor Relations live from the books (Neil, 11/11/2026).

Pins:
  * an investor is their own partner equity accounts - 300xx E&C, 310xx
    Contribution, 320xx Distribution - told apart by the NAME (the numbers do
    not line up); Opening Balance Equity and every non-equity account are not
    investors; "Greens Global Inv 1" and "Greens Global Inv 1, LLC" are one;
  * a member's capital on an entity = credit - debit of their accounts;
    distributions read positive; a member whose accounts are all zero is
    left out; linked accounts add up under the profile;
  * membership %: kept on the member's commitment (one made with no amount
    when the member came from the books, which never trips the Nexus gap
    warning), 0-100 only, shown on the deal's members;
  * the portal: an investor reads ONLY their own accounts, only on deals
    they are scoped to and committed in, without the Accounting grant;
  * Remove Sample Data: the seed's deals, posts and investors go; a person's
    own investor, an Intacct-linked one and a linked deal stay;
  * property figures: book equity = assets - liabilities, cash = bank
    accounts, net income over revenue / cogs / expense / other expense only;
  * who sees figures: the IR read gate AND the Accounting grant AND the
    entity in reach - no grant, or an Administrator with no entity rows, gets
    {allowed: false} and not one figure;
  * linking: one entity is one deal, one account is one profile (409), an
    account that is not an investor's equity account is refused (422);
  * Import: creates the deal and a linked profile per member, links an
    existing unlinked profile with the same name instead of duplicating, and
    a second run creates nothing; no commitment is invented.

The accounting app is replaced by a recorder - nothing leaves the machine.

Run: python -m pytest test_investor_books.py -q
"""
import asyncio
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.pop("ANTHROPIC_API_KEY", None)

from fastapi import HTTPException  # noqa: E402

import database  # noqa: E402
import investor_books as ib  # noqa: E402
import models  # noqa: E402
from routers import accounting  # noqa: E402
from routers import investor_books as R  # noqa: E402

SUPER = {"email": "neil@greensglobal.com", "level": 5}
ADMIN4 = {"email": "adm4@greensglobal.com", "level": 4}       # no accounting entity rows = fails closed
NO_GRANT = {"email": "sup@greensglobal.com", "level": 2}

CHART = [
    {"account_no": "30016", "title": "Neil Kadakia - (E&C)", "section": "equity"},
    {"account_no": "31010", "title": "Neil Kadakia - (Contribution)", "section": "equity"},
    {"account_no": "32013", "title": "Neil Kadakia - (Distribution)", "section": "equity"},
    {"account_no": "30031", "title": "Jitendra Jain - (E&C)", "section": "equity"},
    {"account_no": "31019", "title": "Jitendra Jain - (Contribution)", "section": "equity"},
    {"account_no": "30005", "title": "Greens Global Inv 1 - (E&C)", "section": "equity"},
    {"account_no": "31004", "title": "Greens Global Inv 1, LLC - (Contribution)", "section": "equity"},
    {"account_no": "30091", "title": "Opening Balance Equity", "section": "equity"},
    {"account_no": "31032", "title": "Greens Sachse - (Contribution)", "section": "asset"},
    {"account_no": "11101", "title": "Chase Operating", "section": "asset", "bank_kind": "checking"},
]
# /reports/buckets?by=total&location=67000 from the start of the books.
BS = [
    {"account_no": "11101", "title": "Chase Operating", "section": "asset", "debit": 120000, "credit": 20000, "bank_kind": "checking"},
    {"account_no": "15000", "title": "Building", "section": "asset", "debit": 900000, "credit": 0},
    {"account_no": "21000", "title": "Mortgage", "section": "liability", "debit": 50000, "credit": 400000},
    {"account_no": "30016", "title": "Neil Kadakia - (E&C)", "section": "equity", "debit": 40207, "credit": 0},
    {"account_no": "31010", "title": "Neil Kadakia - (Contribution)", "section": "equity", "debit": 0, "credit": 138231},
    {"account_no": "32013", "title": "Neil Kadakia - (Distribution)", "section": "equity", "debit": 30000, "credit": 0},
    {"account_no": "30031", "title": "Jitendra Jain - (E&C)", "section": "equity", "debit": 0, "credit": 51477},
    {"account_no": "31019", "title": "Jitendra Jain - (Contribution)", "section": "equity", "debit": 0, "credit": 594876},
    {"account_no": "30005", "title": "Greens Global Inv 1 - (E&C)", "section": "equity", "debit": 100, "credit": 100},
    {"account_no": "30091", "title": "Opening Balance Equity", "section": "equity", "debit": 0, "credit": 5000},
    {"account_no": "40001", "title": "Storage Rent", "section": "revenue", "debit": 0, "credit": 300000},
]
PL = [
    {"account_no": "40001", "title": "Storage Rent", "section": "revenue", "debit": 1000, "credit": 81000},
    {"account_no": "61101", "title": "Repairs", "section": "expense", "debit": 30000, "credit": 0},
    {"account_no": "ALOSD", "title": "Occupied Units", "section": "other", "debit": 0, "credit": 999},
]
ENTITIES = [{"code": "67000", "name": "Greens Austin, LLC.", "parent_code": None},
            {"code": "66000", "name": "Greens Georgetown, LLC.", "parent_code": None}]


def run(coro):
    return asyncio.run(coro)


class BooksTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.IrFund, models.IrInvestor, models.IrCommitment, models.IrCapitalCall,
                  models.IrCapitalCallAllocation, models.IrDistribution, models.IrDistributionAllocation,
                  models.IrDocument, models.IrUpdate, models.NexusAccessScope):
            self.db.query(m).delete()
        self.db.commit()
        self.calls = []

        async def fake_get(path, params):
            self.calls.append((path, dict(params)))
            if path == "/api/internal/reports/locations":
                return {"ok": True, "entities": ENTITIES}
            if path == "/api/internal/accounts":
                return {"ok": True, "accounts": CHART}
            if path == "/api/internal/reports/buckets":
                if params.get("by") == "entity":
                    return {"ok": True, "rows": [{**r, "bucket": "67000"} for r in BS], "labels": {"67000": "Greens Austin, LLC."}}
                return {"ok": True, "rows": PL if params.get("from") else BS}
            raise AssertionError(path)
        self._real = accounting._acct_get
        accounting._acct_get = fake_get

    def tearDown(self):
        accounting._acct_get = self._real
        self.db.close()

    def ctx(self, user=SUPER):
        return R._ctx(user, self.db)

    def fund(self, entity="", name="Austin"):
        f = models.IrFund(id=str(uuid.uuid4()), name=name, status="active", intacct_entity=entity, created_at="x")
        self.db.add(f)
        self.db.commit()
        return f

    # ── rules ────────────────────────────────────────────────────────────────
    def test_partners_from_chart(self):
        ps = {p["name"]: p for p in ib.partners_from_chart(CHART)}
        self.assertEqual(set(ps), {"Neil Kadakia", "Jitendra Jain", "Greens Global Inv 1"})
        self.assertEqual([a["accountNo"] for a in ps["Neil Kadakia"]["accounts"]], ["30016", "31010", "32013"])
        self.assertEqual([a["kind"] for a in ps["Neil Kadakia"]["accounts"]], ["ec", "contributed", "distributed"])
        self.assertEqual(len(ps["Greens Global Inv 1"]["accounts"]), 2)

    def test_real_chart_spellings_group_by_name(self):
        real = [("30001", "Rajesh Kadakia - (E&C)"), ("32032", "Rajesh Kadakia - (Undistributed Cash)"),
                ("30081", "Malay & Avani Shah Trust (E&C)"), ("31047", "Malay &Avani Shah Trust - (Contribution)"),
                ("30057", "India - MPPL -(E&C)"), ("32026", "Ryan Javaheri (Distribution)"), ("30042", "Ryan Javaheri - (E&C)"),
                ("30019", "RAJK FLP (Jinukinu, LLC) - (E&C)"), ("32009", "RAJK FLP (Jinukinu, LLC) - (Distribution)")]
        ps = {p["name"]: [a["accountNo"] for a in p["accounts"]]
              for p in ib.partners_from_chart([{"account_no": n, "title": t, "section": "equity"} for n, t in real])}
        self.assertEqual(ps, {"Rajesh Kadakia": ["30001", "32032"], "Malay & Avani Shah Trust": ["30081", "31047"],
                              "India - MPPL": ["30057"], "Ryan Javaheri": ["30042", "32026"],
                              "RAJK FLP (Jinukinu, LLC)": ["30019", "32009"]})
        self.assertEqual([ib.entity_type_of(n) for n in ("PBK Roth IRA", "Gurudev FLP", "Sanjna Jain Family Trust", "Prime Storage LLC", "Tom Williams")],
                         ["ira", "partnership", "trust", "llc", "individual"])

    def test_members_and_property(self):
        titles = {r["account_no"]: r["title"] for r in BS}
        rows = ib.members(ib.balances(BS), titles, {})
        self.assertEqual([r["name"] for r in rows], ["Jitendra Jain", "Neil Kadakia"])   # zero member left out
        neil = rows[1]
        self.assertEqual((neil["ec"], neil["contributed"], neil["distributed"], neil["balance"]),
                         (-40207.0, 138231.0, 30000.0, 68024.0))
        self.assertNotIn("share", neil)       # the percentage is the operating agreement's, never worked out
        p = ib.property_figures(BS, PL)
        self.assertEqual((p["assets"], p["liabilities"], p["bookEquity"], p["cash"]), (1000000.0, 350000.0, 650000.0, 100000.0))
        self.assertEqual((p["revenueYtd"], p["netIncomeYtd"]), (80000.0, 50000.0))
        self.assertEqual(p["cashAccounts"], ["11101"])

    def test_linked_accounts_add_up_under_the_profile(self):
        titles = {r["account_no"]: r["title"] for r in BS}
        rows = ib.members(ib.balances(BS), titles, {"30016": ("inv1", "Neil K."), "31010": ("inv1", "Neil K."), "32013": ("inv1", "Neil K.")})
        neil = [r for r in rows if r["investorId"] == "inv1"][0]
        self.assertEqual((neil["name"], neil["balance"], neil["accounts"]), ("Neil K.", 68024.0, ["30016", "31010", "32013"]))

    # ── who sees figures ─────────────────────────────────────────────────────
    def test_no_grant_and_no_entity_rows_see_nothing(self):
        f = self.fund("67000")
        for user in (NO_GRANT, ADMIN4):
            out = run(R.deal_books(R._deal_ctx(f.id, self.ctx(user))))
            self.assertFalse(out["allowed"], user)
            self.assertNotIn("members", out)
        self.assertFalse(run(R.deals_books(R._deals_ctx(self.ctx(NO_GRANT))))["allowed"])
        with self.assertRaises(HTTPException) as e:
            R._edit_ctx(NO_GRANT, self.db)
        self.assertEqual(e.exception.status_code, 403)

    def test_deal_books_live(self):
        f = self.fund("67000")
        out = run(R.deal_books(R._deal_ctx(f.id, self.ctx())))
        self.assertTrue(out["allowed"] and out["linked"])
        self.assertEqual(out["entityName"], "Greens Austin, LLC.")
        self.assertEqual(out["partnerCapital"], 714377.0)
        self.assertEqual(out["property"]["bookEquity"], 650000.0)
        bucket_reads = [p for path, p in self.calls if path.endswith("/buckets")]
        self.assertTrue(all(p["location"] == "67000" for p in bucket_reads))
        self.assertEqual(sorted(p.get("from") or "" for p in bucket_reads), ["", f"{out['asOf'][:4]}-01-01"])

    # ── linking ──────────────────────────────────────────────────────────────
    def test_link_rules(self):
        a, b = self.fund(), self.fund(name="Other")
        run(R.link_fund(a.id, R.EntityIn(entity="67000"), {**self.ctx(), "was": ""}))
        with self.assertRaises(HTTPException) as e:
            run(R.link_fund(b.id, R.EntityIn(entity="67000"), {**self.ctx(), "was": ""}))
        self.assertEqual(e.exception.status_code, 409)
        with self.assertRaises(HTTPException) as e:
            run(R.link_fund(b.id, R.EntityIn(entity="99999"), {**self.ctx(), "was": ""}))
        self.assertEqual(e.exception.status_code, 422)

        v1 = models.IrInvestor(id="v1", display_name="Neil", created_at="x")
        v2 = models.IrInvestor(id="v2", display_name="Other", created_at="x")
        self.db.add_all([v1, v2])
        self.db.commit()
        run(R.link_investor("v1", R.AccountsIn(accounts=["30016", "31010"]), R._investor_ctx("v1", self.ctx())))
        with self.assertRaises(HTTPException) as e:
            run(R.link_investor("v2", R.AccountsIn(accounts=["31010"]), R._investor_ctx("v2", self.ctx())))
        self.assertEqual(e.exception.status_code, 409)
        for bad in (["30091"], ["11101"], ["31032"]):
            with self.assertRaises(HTTPException) as e:
                run(R.link_investor("v2", R.AccountsIn(accounts=bad), R._investor_ctx("v2", self.ctx())))
            self.assertEqual(e.exception.status_code, 422, bad)

    def test_a_linked_account_that_left_the_chart_may_stay(self):
        self.db.add(models.IrInvestor(id="v3", display_name="Gone", intacct_accounts="39999", created_at="x"))
        self.db.commit()
        out = run(R.link_investor("v3", R.AccountsIn(accounts=["39999", "30031"]), R._investor_ctx("v3", self.ctx())))
        self.assertEqual(out["intacctAccounts"], ["30031", "39999"])

    def test_one_entity_one_deal_even_at_once(self):
        self.fund("67000")
        self.db.add(models.IrFund(id="dup", name="Dup", intacct_entity="67000", created_at="x"))
        with self.assertRaises(Exception):
            self.db.commit()          # the unique index, not only the app check
        self.db.rollback()
        self.fund("")
        self.fund("")                 # unlinked deals share '' freely

    # ── import ───────────────────────────────────────────────────────────────
    def test_import_gives_a_partly_linked_partner_to_their_profile(self):
        self.db.add(models.IrInvestor(id="neil", display_name="Neil K.", intacct_accounts="30016,31010", created_at="x"))
        self.db.commit()
        out = run(R.import_entity(R.ImportIn(entity="67000"), R._import_ctx(self.ctx())))
        self.assertEqual((out["created"], out["linked"]), (1, 1))       # Jain new; 32013 joins Neil, no second Neil
        self.db.expire_all()
        self.assertEqual(self.db.get(models.IrInvestor, "neil").intacct_accounts, "30016,31010,32013")
        self.assertEqual(self.db.query(models.IrInvestor).count(), 2)

    def test_import_creates_links_and_is_idempotent(self):
        self.db.add(models.IrInvestor(id="pre", display_name="neil kadakia", created_at="x"))
        self.db.commit()
        out = run(R.import_entity(R.ImportIn(entity="67000"), R._import_ctx(self.ctx())))
        self.assertEqual((out["fundCreated"], out["created"], out["linked"], out["kept"]), (True, 1, 1, 0))
        self.db.expire_all()
        pre = self.db.get(models.IrInvestor, "pre")
        self.assertEqual(pre.intacct_accounts, "30016,31010,32013")     # the whole family, from the chart
        jain = self.db.query(models.IrInvestor).filter(models.IrInvestor.display_name == "Jitendra Jain").one()
        self.assertEqual(jain.intacct_accounts, "30031,31019")
        self.assertEqual(self.db.query(models.IrFund).filter(models.IrFund.intacct_entity == "67000").count(), 1)
        self.assertEqual(self.db.query(models.IrCommitment).count(), 0)

        again = run(R.import_entity(R.ImportIn(entity="67000"), R._import_ctx(self.ctx())))
        self.assertEqual((again["fundCreated"], again["created"], again["linked"], again["kept"]), (False, 0, 0, 2))
        self.assertEqual(self.db.query(models.IrInvestor).count(), 2)

        pos = run(R.investor_books(R._positions_ctx("pre", self.ctx())))
        self.assertEqual(pos["total"], 68024.0)
        self.assertEqual(pos["positions"][0]["fundId"], out["fundId"])


    # ── membership, portal, sample data ───────────────────────────────────────
    def test_membership_on_the_commitment(self):
        out = run(R.import_entity(R.ImportIn(entity="67000"), R._import_ctx(self.ctx())))
        jain = self.db.query(models.IrInvestor).filter(models.IrInvestor.display_name == "Jitendra Jain").one()
        R._save_membership(self.db, SUPER, out["fundId"], jain.id, 90.5)
        R._save_membership(self.db, SUPER, out["fundId"], jain.id, 90)          # updates, never a second row
        c = self.db.query(models.IrCommitment).one()
        self.assertEqual((c.membership_pct, c.commitment_amount, c.status), (90.0, 0, "active"))
        with self.assertRaises(HTTPException) as e:
            R._save_membership(self.db, SUPER, out["fundId"], jain.id, 101)
        self.assertEqual(e.exception.status_code, 422)
        books = run(R.deal_books(R._deal_ctx(out["fundId"], self.ctx())))
        by = {m["name"]: m for m in books["members"]}
        self.assertEqual(by["Jitendra Jain"]["membershipPct"], 90.0)
        self.assertNotIn("nexus", by["Jitendra Jain"])        # a percentage-only commitment is not a gap
        self.assertIsNone(by["Neil Kadakia"]["membershipPct"])
        R._save_membership(self.db, SUPER, out["fundId"], jain.id, None)
        self.db.expire_all()
        self.assertIsNone(self.db.query(models.IrCommitment).one().membership_pct)

    def test_portal_reads_only_my_own_accounts(self):
        out = run(R.import_entity(R.ImportIn(entity="67000"), R._import_ctx(self.ctx())))
        other = self.fund("66000", name="Georgetown")
        neil = self.db.query(models.IrInvestor).filter(models.IrInvestor.display_name == "Neil Kadakia").one()
        neil.email = "lp@example.com"
        R._save_membership(self.db, SUPER, out["fundId"], neil.id, 9.5)
        R._save_membership(self.db, SUPER, other.id, neil.id, 5)             # committed but NOT scoped
        self.db.add(models.NexusAccessScope(id="s1", email="lp@example.com", module_id="investor-relations",
                                            scope_type="fund", scope_id=out["fundId"], created_at="x"))
        self.db.commit()
        lp = {"email": "lp@example.com", "level": 1}
        res = run(R.portal_books(R._portal_ctx(lp, self.db)))
        self.assertEqual(list(res["deals"]), [out["fundId"]])
        mine = res["deals"][out["fundId"]]
        self.assertEqual((mine["live"], mine["capitalAccount"], mine["contributed"], mine["membershipPct"]),
                         (True, 68024.0, 138231.0, 9.5))
        self.assertNotIn(646353.0, [v for v in mine.values()])               # never Jain's figures
        stranger = {"email": "nobody@example.com", "level": 1}
        self.assertEqual(run(R.portal_books(R._portal_ctx(stranger, self.db)))["deals"], {})

    def test_remove_sample_data_keeps_real_rows(self):
        from routers import investor_relations as ir
        ir.seed_demo_data(SUPER, self.db)
        real_deal = self.fund("67000", name="Greens Austin")
        mine = models.IrInvestor(id="real", display_name="Real Person", email="real@greensglobal.com", created_at="x")
        linked = self.db.query(models.IrInvestor).filter(models.IrInvestor.email == "tgrady@example.com").one()
        linked.intacct_accounts = "30099"
        self.db.add(mine)
        self.db.add(models.IrCommitment(id="rc", fund_id=real_deal.id, investor_id="real", commitment_amount=5, created_at="x"))
        self.db.commit()
        out = ir.remove_sample_data(SUPER, self.db)["removed"]
        self.assertEqual((out["ir_funds"], out["ir_investors"]), (3, 13))
        self.db.expire_all()
        self.assertEqual([f.name for f in self.db.query(models.IrFund).all()], ["Greens Austin"])
        self.assertEqual(sorted(v.display_name for v in self.db.query(models.IrInvestor).all()), ["Real Person", "Thomas Grady"])
        self.assertEqual([c.id for c in self.db.query(models.IrCommitment).all()], ["rc"])
        for m in (models.IrCapitalCall, models.IrCapitalCallAllocation, models.IrDistribution,
                  models.IrDistributionAllocation, models.IrDocument, models.IrUpdate):
            self.assertEqual(self.db.query(m).count(), 0, m.__tablename__)
        self.assertEqual(ir.remove_sample_data(SUPER, self.db)["removed"]["ir_investors"], 0)


if __name__ == "__main__":
    unittest.main()
