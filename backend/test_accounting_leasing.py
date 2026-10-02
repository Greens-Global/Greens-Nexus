"""MRI -> Leasing -> Set Up From the Ledger (Neil and Charmi, 10/02) - as tests.

Which income accounts are rent, the rent guessed from the last three posted
months, one proposal per (entity, customer) with rent postings, customers
already on an active lease marked as set up, an idempotent create through
the same validation and save New Lease uses, and entity scope on every read.
The accounting service is replaced by a recorder.

    python -m pytest test_accounting_leasing.py -q
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
from routers import accounting, accounting_leasing

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.ledgerlease.test@greensglobal.com"     # accounting:editor, no limit
VIEWER = "viewer.ledgerlease.test@greensglobal.com"     # accounting:viewer
LIMITED = "limited.ledgerlease.test@greensglobal.com"   # accounting:editor, entity 56000 only
EVERYONE = (EDITOR, VIEWER, LIMITED)
GROUPS = {"grp-ledgerlease-test-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-ledgerlease-test-v": ("accounting:viewer", (VIEWER,))}

ENTITIES = [
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
]
PNL = {
    "15000": [("revenue", "41101", "Rental Income"), ("revenue", "41102", "Tenant CAM Reimbursements"), ("revenue", "42000", "Storage Income"), ("expense", "61000", "Repairs")],
    "56000": [("revenue", "44000", "Service Revenue"), ("expense", "60000", "Wages")],
}
LABELS = {"C00498": "Overstie Management", "C00497": "Santos Blancas Jr.", "C00001": "Walk-in"}
# What each customer posted to the rent accounts of 15000, month by month.
POSTINGS = {
    "C00498": {f"2026-{m:02d}": {"41101": 3000.0, "41102": 200.0} for m in range(1, 10)},
    "C00497": {**{m: {"41101": 2100.0} for m in ("2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07")}, "2026-08": {"41101": 2200.0}, "2026-09": {"41101": 2200.0}},
    "C00001": {"2026-03": {"42000": 500.0}},     # storage, not rent
}


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _rows_by_customer():
    out = []
    for cust, months in POSTINGS.items():
        per_account = {}
        for cell in months.values():
            for acct, v in cell.items():
                per_account[acct] = per_account.get(acct, 0) + v
        for acct, v in per_account.items():
            out.append({"bucket": cust, "section": "revenue", "account_no": acct, "title": "", "debit": 0, "credit": v})
    return out


def _rows_by_month(cust):
    return [{"bucket": f"{m}-01", "section": "revenue", "account_no": acct, "title": "", "debit": 0, "credit": v}
            for m, cell in POSTINGS.get(cust, {}).items() for acct, v in cell.items()]


class ArithmeticTests(unittest.TestCase):
    def test_rent_accounts(self):
        accts = [{"section": s, "account_no": c, "title": t} for s, c, t in PNL["15000"]]
        self.assertEqual([a["account_no"] for a in accounting_leasing.rent_accounts(accts)], ["41101", "41102"])
        self.assertEqual(accounting_leasing.rent_accounts([{"section": "expense", "account_no": "62000", "title": "Rent Expense"}]), [])

    def test_monthly_rent_is_the_most_common_of_the_last_three_posted_months(self):
        self.assertEqual(accounting_leasing.monthly_rent({"2026-01": 3000, "2026-02": 3000, "2026-03": 3000}), 3000.0)
        self.assertEqual(accounting_leasing.monthly_rent({"2026-01": 2100, "2026-07": 2100, "2026-08": 2200, "2026-09": 2200}), 2200.0)
        self.assertEqual(accounting_leasing.monthly_rent({"2026-07": 2100, "2026-08": 2200, "2026-09": 2300}), 2300.0)    # all different: the latest
        self.assertEqual(accounting_leasing.monthly_rent({"2026-07": 2100, "2026-08": 0, "2026-09": 2100}), 2100.0)       # a month that did not post is skipped
        self.assertIsNone(accounting_leasing.monthly_rent({"2026-07": 0}))

    def test_propose(self):
        accounts = [{"section": "revenue", "account_no": "41101", "title": "Rental Income"}]
        by_customer = {"C1": {"2026-01": 3000.0, "2026-02": 3000.0, "2026-03": 3200.0}, "C2": {"2026-02": 0.0}}
        [p] = accounting_leasing.propose({"code": "15000", "name": "Greens Escondido, LLC."}, accounts, by_customer, {"C1": "Tenant One"})
        self.assertEqual((p["customerId"], p["tenantName"], p["monthlyRent"], p["firstMonth"], p["lastMonth"], p["postedMonths"], p["received12"]), ("C1", "Tenant One", 3000.0, "2026-01", "2026-03", 3, 9200.0))   # 3,000 twice beats 3,200 once
        self.assertEqual(p["incomeAccounts"], ["41101"])


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
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="56000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        accounting_leasing._CACHE.clear()
        self.calls = []

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/pnl"):
                sections = {}
                for s, c, t in PNL.get(clean.get("location"), []):
                    sections.setdefault(s, []).append({"account_no": c, "title": t, "amount": 1})
                return {"ok": True, "sections": [{"key": k, "accounts": v} for k, v in sections.items()]}
            if path.endswith("/reports/buckets"):
                if clean.get("location") != "15000":
                    return {"ok": True, "rows": [], "labels": {}}
                if clean.get("by") == "customer":
                    return {"ok": True, "rows": _rows_by_customer(), "labels": LABELS}
                if clean.get("by") == "month":
                    return {"ok": True, "rows": _rows_by_month(clean.get("customer")), "labels": {}}
            return {"ok": True, "echo": clean}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        accounting._acct_get = self._get
        accounting._ACCT_BASE, accounting._ACCT_KEY = self._base, self._key
        accounting_leasing._CACHE.clear()
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
            ids = [l.id for l in db.query(models.Lease).filter(models.Lease.created_by.in_(EVERYONE)).all()]
            if ids:
                db.query(models.LeaseRate).filter(models.LeaseRate.lease_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.LeaseMonth).filter(models.LeaseMonth.lease_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.Lease).filter(models.Lease.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(tuple(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_proposals_from_rent_postings(self):
        _as(EDITOR)
        r = self.client.get("/accounting/leasing/from-ledger/proposals")
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["entitiesScanned"], d["entitiesWithRentAccounts"]), (2, 1))
        self.assertEqual([(a["code"], a["title"]) for a in d["rentAccounts"]], [("41101", "Rental Income"), ("41102", "Tenant CAM Reimbursements")])
        got = {p["customerId"]: p for p in d["proposals"]}
        self.assertEqual(set(got), {"C00498", "C00497"})       # the storage customer is not a tenant
        o = got["C00498"]
        self.assertEqual((o["tenantName"], o["entityCode"], o["incomeAccounts"], o["monthlyRent"], o["firstMonth"], o["lastMonth"], o["postedMonths"], o["received12"], o["status"]),
                         ("Overstie Management", "15000", ["41101", "41102"], 3200.0, "2026-01", "2026-09", 9, 28800.0, "new"))
        s = got["C00497"]
        self.assertEqual((s["monthlyRent"], s["firstMonth"], s["postedMonths"]), (2200.0, "2025-11", 11))     # 2,100 x 9 then 2,200 x 2: the last three say 2,200
        self.assertEqual(d["lookedFor"], ["Rent", "Rental", "Lease / Leasing", "Tenant"])
        # The reads: a P&L per entity, the customers of the entity with rent accounts, then a month split per customer.
        self.assertEqual(sorted(c[1].get("location") for c in self.calls if c[0].endswith("/reports/pnl")), ["15000", "56000"])
        self.assertEqual([c[1] for c in self.calls if c[0].endswith("/reports/buckets") and c[1]["by"] == "customer"][0]["location"], "15000")
        self.assertEqual(sorted(c[1]["customer"] for c in self.calls if c[0].endswith("/reports/buckets") and c[1]["by"] == "month"), ["C00497", "C00498"])

    def test_create_writes_leases_the_way_new_lease_does_and_only_once(self):
        _as(EDITOR)
        body = {"items": [{"entityCode": "15000", "customerId": "C00498"}, {"entityCode": "15000", "customerId": "C00001"}]}
        r = self.client.post("/accounting/leasing/from-ledger/create", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        d = r.json()
        self.assertEqual([c["customerId"] for c in d["created"]], ["C00498"])
        self.assertEqual([(s["customerId"], s["why"]) for s in d["skipped"]], [("C00001", "no rent postings for this customer on the ledger")])
        [lease] = [l for l in self.client.get("/leasing/leases").json() if l["customerId"] == "C00498"]
        self.assertEqual((lease["propertyName"], lease["entityCode"], lease["tenantName"], lease["incomeAccounts"], lease["leaseStart"], lease["status"], lease["tenancy"]),
                         ("Greens Escondido, LLC.", "15000", "Overstie Management", ["41101", "41102"], "2026-01-01", "active", "external"))
        self.assertEqual([(x["startDate"], x["rent"]) for x in lease["rates"]], [("2026-01-01", 3200.0)])
        # Again: nothing is duplicated, and the proposal now reads set up.
        r = self.client.post("/accounting/leasing/from-ledger/create", json=body)
        self.assertEqual((r.status_code, r.json()["created"], r.json()["skipped"][0]["why"]), (201, [], "already set up"))
        self.assertEqual(len([l for l in self.client.get("/leasing/leases").json() if l["customerId"] == "C00498"]), 1)
        got = {p["customerId"]: (p["status"], p["leaseId"]) for p in self.client.get("/accounting/leasing/from-ledger/proposals").json()["proposals"]}
        self.assertEqual(got["C00498"], ("set_up", lease["id"]))
        self.assertEqual(got["C00497"][0], "new")

    def test_an_ended_lease_does_not_count_as_set_up(self):
        _as(EDITOR)
        r = self.client.post("/leasing/leases", json={"propertyName": "Old", "entityCode": "15000", "customerId": "C00498", "tenantName": "Overstie Management", "status": "ended", "leaseStart": "2024-01-01", "leaseEnd": "2025-06-30", "rates": [{"startDate": "2024-01-01", "rent": 2500}]})
        self.assertEqual(r.status_code, 201, r.text)
        got = {p["customerId"]: p["status"] for p in self.client.get("/accounting/leasing/from-ledger/proposals").json()["proposals"]}
        self.assertEqual(got["C00498"], "new")

    def test_viewers_cannot_create(self):
        _as(VIEWER)
        self.assertEqual(self.client.post("/accounting/leasing/from-ledger/create", json={"items": [{"entityCode": "15000", "customerId": "C00498"}]}).status_code, 403)
        self.assertEqual(self.client.get("/accounting/leasing/from-ledger/proposals").status_code, 200)
        self.assertEqual(self.client.post("/accounting/leasing/from-ledger/create", json={"items": []}).status_code, 403)

    def test_a_limited_person_sees_only_their_entities(self):
        _as(LIMITED)
        d = self.client.get("/accounting/leasing/from-ledger/proposals").json()
        self.assertEqual((d["entitiesScanned"], d["proposals"]), (1, []))
        self.assertEqual({c[1].get("location") for c in self.calls if c[0].endswith("/reports/pnl")}, {"56000"})
        self.assertEqual(self.client.post("/accounting/leasing/from-ledger/create", json={"items": [{"entityCode": "15000", "customerId": "C00498"}]}).status_code, 403)
        self.assertEqual(self.client.get("/leasing/leases").json(), [])

    def test_not_configured_is_503(self):
        _as(EDITOR)
        accounting._acct_get = self._get
        accounting._ACCT_BASE = ""
        self.assertEqual(self.client.get("/accounting/leasing/from-ledger/proposals").status_code, 503)


if __name__ == "__main__":
    unittest.main()
