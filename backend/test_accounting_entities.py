"""Accounting > Entities (Neil, 11/17/2026).

Pins:
  * the rules: a "-1" code is a location; tax-chart shapes come from the TAX
    classification; look-through multiplies down a chain and adds across
    chains, an unknown percentage stays unknown, a loop stops;
  * reach: an entity outside the caller's accounting access is a 404, and
    the list holds only what they may read;
  * the EIN: saved encrypted (the column never holds the digits), shown
    masked, whole only to the Full level;
  * one home for every legal fact: a linked Nexus company's legal name and
    EIN are the values, the entity's own columns stay blank;
  * Dissolved / Sold take Full; a stale rev is a 409;
  * ownership has one home: a deal's members come from Investor Relations
    and a stored owner row for a deal's entity is refused; owners of other
    entities add up to 100% at most, never make a loop, and an owner who
    leaves is ended, never deleted;
  * the chart climbs through an investor profile that IS one of our
    entities, and without the Investor Relations read gate a deal's members
    are a count, never names;
  * a deal's Legal line carries no figure.

The accounting app is replaced by a recorder - nothing leaves the machine.

Run: python -m pytest test_accounting_entities.py -q
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
import legal_entities as L  # noqa: E402
import models  # noqa: E402
from routers import accounting  # noqa: E402
from routers import accounting_entities as R  # noqa: E402

SUPER = {"email": "neil@greensglobal.com", "level": 5}
SUP2 = {"email": "sup@greensglobal.com", "level": 2}

BOOKS = [
    {"code": "10000", "name": "Greens Global, LLC.", "parent_code": None},
    {"code": "15001", "name": "Greens Global Inv 1, LLC", "parent_code": None},
    {"code": "15001-1", "name": "Greens Global Inv 1 - Ops", "parent_code": "15001"},
    {"code": "67000", "name": "Greens Austin, LLC.", "parent_code": None},
    {"code": "70100", "name": "Greens Ops, Inc.", "parent_code": None},
]
BS = [
    {"account_no": "11101", "title": "Chase Operating", "section": "asset", "debit": 120000, "credit": 20000, "bank_kind": "checking"},
    {"account_no": "21000", "title": "Mortgage", "section": "liability", "debit": 0, "credit": 40000},
]


def run(coro):
    return asyncio.run(coro)


class EntityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.LegalEntity, models.LegalEntityOwner, models.IrFund, models.IrInvestor, models.IrCommitment,
                  models.HrEntity, models.NexusAccessScope, models.AccountingAmaAgreement):
            self.db.query(m).delete()
        self.db.commit()

        async def fake_get(path, params):
            if path == "/api/internal/reports/locations":
                return {"ok": True, "entities": BOOKS}
            if path == "/api/internal/reports/buckets":
                return {"ok": True, "rows": BS}
            raise AssertionError(path)
        self._real = accounting._acct_get
        accounting._acct_get = fake_get

    def tearDown(self):
        accounting._acct_get = self._real
        self.db.close()

    def ctx(self, user=SUPER, allowed=None, **over):
        c = R._ctx({"user": user, "allowed": allowed}, self.db)
        c.update(over)
        return c

    def deal(self, code, name="Austin"):
        f = models.IrFund(id=str(uuid.uuid4()), name=name, status="active", intacct_entity=code, created_at="x")
        self.db.add(f)
        self.db.commit()
        return f

    def investor(self, name, kind="individual", entity=""):
        v = models.IrInvestor(id=str(uuid.uuid4()), display_name=name, entity_type=kind, legal_entity_code=entity, created_at="x")
        self.db.add(v)
        self.db.commit()
        return v

    def commit(self, fund, inv, pct):
        self.db.add(models.IrCommitment(id=str(uuid.uuid4()), fund_id=fund.id, investor_id=inv.id, membership_pct=pct,
                                        status="active", created_at="x"))
        self.db.commit()

    def save(self, code, body, ctx=None):
        return run(R.save_entity(code, R.EntityIn(**body), ctx or self.ctx()))

    # ── rules ────────────────────────────────────────────────────────────────
    def test_rules(self):
        self.assertEqual((L.kind_of("15001-1"), L.kind_of("15001"), L.kind_of("15001-1", "entity")), ("location", "entity", "entity"))
        self.assertEqual([L.shape_of(t) for t in ("llc_single", "llc_multi", "lp", "c_corp", "s_corp", "trust", "")],
                         ["disregarded", "partnership", "partnership", "corporation", "corporation", "trust", "unknown"])
        self.assertEqual(L.shape_of("llc_multi", "s_corp"), "corporation")      # the tax class decides the shape
        self.assertEqual(L.type_line("llc_multi"), "Multi-Member LLC, taxed as a partnership")
        self.assertEqual((L.valid_ein("12-3456789"), L.valid_ein("1234"), L.format_ein("123456789"), L.mask_ein("6789")),
                         (True, False, "12-3456789", "XX-XXX6789"))
        owners = {"A": [("I1", 40), ("X", 60)], "I1": [("N", 100)], "X": [("P", None)]}
        lt = {r["id"]: r for r in L.look_through("A", owners)}
        self.assertEqual((lt["N"]["pct"], lt["N"]["via"]), (40.0, ["I1"]))
        self.assertIsNone(lt["P"]["pct"])                                          # never a guess
        both = {r["id"]: r["pct"] for r in L.look_through("A", {"A": [("B", 50), ("N", 50)], "B": [("N", 50)]})}
        self.assertEqual(both, {"N": 75.0})                                        # adds across chains
        self.assertEqual(L.look_through("A", {"A": [("B", 50)], "B": [("A", 100)]})[0]["id"], "B")   # a loop stops
        self.assertTrue(L.owns_cycle("N", "A", owners))
        self.assertFalse(L.owns_cycle("A", "N", owners))

    # ── reach ────────────────────────────────────────────────────────────────
    def test_reach(self):
        out = run(R.list_entities(self.ctx(allowed={"67000"})))
        self.assertEqual([e["code"] for e in out["entities"]], ["67000"])
        with self.assertRaises(HTTPException) as e:
            run(R.get_entity("10000", self.ctx(allowed={"67000"})))
        self.assertEqual(e.exception.status_code, 404)
        with self.assertRaises(HTTPException) as e:
            run(R.list_entities(self.ctx(allowed=set())))
        self.assertEqual(e.exception.status_code, 403)
        # A parent brings its locations.
        codes = [e["code"] for e in run(R.list_entities(self.ctx(allowed={"15001"})))["entities"]]
        self.assertEqual(codes, ["15001", "15001-1"])
        loc = run(R.list_entities(self.ctx()))["entities"]
        self.assertEqual({e["code"]: e["kind"] for e in loc}["15001-1"], "location")

    # ── the legal record ─────────────────────────────────────────────────────
    def test_ein_is_encrypted_masked_and_full_only(self):
        self.save("67000", {"legalName": "Greens Austin, LLC", "entityType": "llc_multi", "formedState": "tx",
                            "formedOn": "2019-03-14", "ein": "12-3454821"})
        row = self.db.query(models.LegalEntity).filter_by(code="67000").first()
        self.assertNotIn("123454821", row.ein_enc)
        self.assertTrue(row.ein_enc.startswith("enc:"))
        got = run(R.get_entity("67000", self.ctx()))
        self.assertEqual((got["einMasked"], got["formedState"], got["typeLine"]),
                         ("XX-XXX4821", "TX", "Multi-Member LLC, taxed as a partnership"))
        self.assertNotIn("123454821", str(got))
        with self.assertRaises(HTTPException) as e:
            run(R.reveal_ein("67000", self.ctx(full=False)))
        self.assertEqual(e.exception.status_code, 403)
        self.assertEqual(run(R.reveal_ein("67000", self.ctx()))["ein"], "12-3454821")
        with self.assertRaises(HTTPException) as e:
            self.save("67000", {"ein": "1234"})
        self.assertEqual(e.exception.status_code, 422)

    def test_editor_status_rev_and_company(self):
        with self.assertRaises(HTTPException) as e:
            self.save("67000", {"legalName": "X"}, self.ctx(edit=False))
        self.assertEqual(e.exception.status_code, 403)
        r1 = self.save("67000", {"legalName": "Greens Austin, LLC"})
        with self.assertRaises(HTTPException) as e:
            self.save("67000", {"status": "dissolved"}, self.ctx(full=False))
        self.assertEqual(e.exception.status_code, 403)
        self.save("67000", {"status": "sold", "endedOn": "2026-10-01", "rev": r1["rev"]})
        with self.assertRaises(HTTPException) as e:
            self.save("67000", {"dba": "Late", "rev": r1["rev"]})
        self.assertEqual(e.exception.status_code, 409)
        c = models.HrEntity(id="co1", name="Greens Global", legal_name="Greens Global, LLC", tax_id="98-7650001", signatory="Neil Kadakia")
        self.db.add(c)
        self.db.commit()
        self.save("10000", {"legalName": "Typed Twice", "ein": "11-1111111", "companyId": "co1"})
        row = self.db.query(models.LegalEntity).filter_by(code="10000").first()
        self.assertEqual((row.legal_name, row.ein_enc), ("", ""))
        got = run(R.get_entity("10000", self.ctx()))
        self.assertEqual((got["legalName"], got["einMasked"], got["signers"][0]["name"]),
                         ("Greens Global, LLC", "XX-XXX0001", "Neil Kadakia"))
        self.assertEqual(run(R.reveal_ein("10000", self.ctx()))["ein"], "98-7650001")

    # ── ownership ────────────────────────────────────────────────────────────
    def test_owners_have_one_home(self):
        self.deal("67000")
        with self.assertRaises(HTTPException) as e:
            run(R.add_owner("67000", R.OwnerIn(ownerKind="person", ownerName="Someone", pct=10), self.ctx()))
        self.assertEqual(e.exception.status_code, 409)
        add = lambda code, **k: run(R.add_owner(code, R.OwnerIn(**k), self.ctx()))  # noqa: E731
        add("15001", ownerKind="entity", ownerCode="10000", pct=100)
        with self.assertRaises(HTTPException) as e:
            add("15001", ownerKind="person", ownerName="Extra", pct=5)            # past 100%
        self.assertEqual(e.exception.status_code, 422)
        with self.assertRaises(HTTPException) as e:
            add("10000", ownerKind="entity", ownerCode="15001", pct=10)           # a loop
        self.assertEqual(e.exception.status_code, 422)
        p = add("10000", ownerKind="person", ownerName="Neil Kadakia", pct=60, since="2011-01-01")
        run(R.end_owner("10000", p["ownerId"], R.EndIn(until="2020-01-01"), self.ctx()))
        self.assertEqual(self.db.query(models.LegalEntityOwner).filter_by(entity_code="10000").count(), 1)   # kept
        got = run(R.get_entity("10000", self.ctx()))
        self.assertEqual((got["owners"], got["ownerHistory"][0]["label"]), ([], "Neil Kadakia"))

    def test_chart_climbs_through_our_own_entity(self):
        f = self.deal("67000")
        inv1 = self.investor("Greens Global Inv 1, LLC", "llc", entity="15001")
        out1 = self.investor("Jitendra Jain")
        out2 = self.investor("Shah Family Trust", "trust")
        self.commit(f, inv1, 40)
        self.commit(f, out1, 35)
        self.commit(f, out2, 25)
        run(R.add_owner("15001", R.OwnerIn(ownerKind="person", ownerName="Neil Kadakia", pct=100), self.ctx()))
        got = run(R.get_entity("67000", self.ctx()))
        self.assertEqual(got["ownersHome"], "ir")
        self.assertEqual(got["ownersTotal"], 100.0)
        look = {r["label"]: (r["pct"], r["via"]) for r in got["lookThrough"]}
        self.assertEqual(look["Neil Kadakia"], (40.0, ["Greens Global Inv 1, LLC"]))
        self.assertEqual({o["shape"] for o in got["owners"]}, {"unknown", "individual", "trust"})
        owned = run(R.get_entity("15001", self.ctx()))["owned"]
        self.assertEqual([(o["code"], o["pct"]) for o in owned], [("67000", 40.0)])
        # Without the Investor Relations read gate: a count, never a name.
        blind = run(R.get_entity("67000", self.ctx(ir=False)))
        labels = [o["label"] for o in blind["owners"]]
        self.assertIn("2 Members", labels)
        self.assertNotIn("Jitendra Jain", str(blind))
        st = run(R.structure(self.ctx(ir=False)))
        self.assertNotIn("Jitendra Jain", str(st))

    def test_investor_link_and_legal_line(self):
        inv = self.investor("Greens Global Inv 1, LLC", "llc")
        other = self.investor("Inv 1 again", "llc", entity="15001")
        with self.assertRaises(HTTPException) as e:
            R._link_investor(self.db, inv.id, "15001")
        self.assertEqual(e.exception.status_code, 409)
        other.legal_entity_code = ""
        self.db.commit()
        self.assertEqual(R._link_investor(self.db, inv.id, "15001")["legalEntityCode"], "15001")
        f = self.deal("67000")
        self.save("67000", {"legalName": "Greens Austin, LLC", "entityType": "llc_multi", "ein": "12-3454821"})
        line = R.fund_legal(f.id, SUPER, self.db)
        self.assertEqual((line["legalName"], line["einMasked"]), ("Greens Austin, LLC", "XX-XXX4821"))
        for k in ("cash", "assets", "bookEquity", "liabilities"):
            self.assertNotIn(k, line)

    def test_books_and_figures(self):
        b = run(R.entity_books("67000", self.ctx()))
        self.assertEqual((b["cash"], b["liabilities"], b["bookEquity"]), (100000.0, 40000.0, 60000.0))
        f = run(R.figures("67000,10000,99999", self.ctx(allowed={"67000"})))
        self.assertEqual(list(f["figures"]), ["67000"])


if __name__ == "__main__":
    unittest.main()
