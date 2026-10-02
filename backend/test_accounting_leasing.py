"""MRI -> Leasing -> Set Up From the Ledger (Neil and Charmi, 10/02) - as tests.

Which income accounts are rent, the rent guessed from the last three posted
months, one proposal per (entity, customer) with rent postings - LEAF
entities only (a parent rolls its children up and proposed every tenant
twice on the 10/02 live run), the reads cut to one buckets by=customer per
entity and by=month only for the customers who posted rent (none when the
payload carries the date and the customer posted in one month), the scan as
a background job (202 with the progress, then the result, kept until a
create; a failed job answers 424 once and starts over), customers already on
an active lease marked as set up, an idempotent create through the same
validation and save New Lease uses, and entity scope on every read. The
accounting service is replaced by a recorder.

    python -m pytest test_accounting_leasing.py -q
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
from routers import accounting, accounting_leasing, accounting_loans

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.ledgerlease.test@greensglobal.com"     # accounting:editor, no limit
VIEWER = "viewer.ledgerlease.test@greensglobal.com"     # accounting:viewer
LIMITED = "limited.ledgerlease.test@greensglobal.com"   # accounting:editor, entity 56000 only
EVERYONE = (EDITOR, VIEWER, LIMITED)
GROUPS = {"grp-ledgerlease-test-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-ledgerlease-test-v": ("accounting:viewer", (VIEWER,))}

ENTITIES = [
    {"code": "15000", "name": "Greens Escondido, LLC.", "parent_code": None},
    {"code": "56000", "name": "MCD Services, Inc.", "parent_code": None},
    {"code": "12027", "name": "(AM) (G) 910 S. El Camino Real, SC", "parent_code": None},      # a parent: rolls 12027-1 up
    {"code": "12027-1", "name": "(AM) 910 S El Camino Real, Ste 100, SC", "parent_code": "12027"},
]
LEAVES = ["12027-1", "15000", "56000"]
TITLES = {"41101": ("revenue", "Rental Income"), "41102": ("revenue", "Tenant CAM Reimbursements"), "42000": ("revenue", "Storage Income"), "61000": ("expense", "Repairs"), "44000": ("revenue", "Service Revenue"), "60000": ("expense", "Wages")}
# The P&L account list per entity (the light read made first; a by=customer read follows only where a rent account is).
PNL = {"15000": ["41101", "41102", "42000", "61000"], "56000": ["44000", "60000"], "12027-1": ["41101"], "12027": ["41101"], "77000": ["60000"]}
LABELS = {"C00498": "Overstie Management", "C00497": "Santos Blancas Jr.", "C00001": "Walk-in", "C00300": "Rajesh J. Kadakia MD, Inc."}
# What each customer posted to which accounts, month by month, per entity.
POSTINGS = {
    "15000": {
        "C00498": {f"2026-{m:02d}": {"41101": 3000.0, "41102": 200.0} for m in range(1, 10)},
        "C00497": {**{m: {"41101": 2100.0} for m in ("2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07")}, "2026-08": {"41101": 2200.0}, "2026-09": {"41101": 2200.0}},
        "C00001": {"2026-03": {"42000": 500.0}},     # storage, not rent
    },
    "56000": {"C00001": {"2026-03": {"44000": 900.0}}},
    "12027-1": {"C00300": {m: {"41101": 11000.0} for m in ("2026-07", "2026-08", "2026-09")}},
    "12027": {"C00300": {m: {"41101": 11000.0} for m in ("2026-07", "2026-08", "2026-09")}},    # the roll-up: never read
}
URL = "/accounting/leasing/from-ledger/proposals"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _rows_by_customer(location):
    out = []
    for cust, months in POSTINGS.get(location, {}).items():
        per_account = {}
        for cell in months.values():
            for acct, v in cell.items():
                per_account[acct] = per_account.get(acct, 0) + v
        for acct, v in per_account.items():
            section, title = TITLES[acct]
            out.append({"bucket": cust, "section": section, "type": section, "account_no": acct, "title": title, "debit": 0, "credit": v})
    return out


def _rows_by_month(location, cust):
    return [{"bucket": f"{m}-01", "section": TITLES[acct][0], "account_no": acct, "title": TITLES[acct][1], "debit": 0, "credit": v}
            for m, cell in POSTINGS.get(location, {}).get(cust, {}).items() for acct, v in cell.items()]


class ArithmeticTests(unittest.TestCase):
    def test_rent_accounts(self):
        accts = [{"section": TITLES[c][0], "account_no": c, "title": TITLES[c][1]} for c in ("41101", "41102", "42000", "61000")]
        self.assertEqual([a["account_no"] for a in accounting_leasing.rent_accounts(accts)], ["41101", "41102"])
        self.assertEqual(accounting_leasing.rent_accounts([{"section": "expense", "account_no": "62000", "title": "Rent Expense"}]), [])

    def test_row_month(self):
        self.assertIsNone(accounting_leasing.row_month({"bucket": "C1", "credit": 5}))      # the live payload: no date
        self.assertEqual(accounting_leasing.row_month({"bucket": "C1", "date": "2026-09-14"}), "2026-09")
        self.assertEqual(accounting_leasing.row_month({"bucket": "C1", "month": "2026-08"}), "2026-08")

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
    @classmethod
    def setUpClass(cls):
        # The scan is a background task on the request's loop: one client
        # context = one loop for every request of the class.
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
        self.gate = threading.Event()      # the by=customer reads wait for this (a slow ledger)
        self.gate.set()
        self.fail_locations = False
        self.dated: dict[str, list[dict]] = {}     # location -> by=customer rows that carry a date

        async def fake_get(path, params):
            clean = {k: v for k, v in params.items() if v is not None}
            self.calls.append((path, clean))
            if path.endswith("/reports/locations"):
                if self.fail_locations:
                    raise HTTPException(status_code=424, detail="Accounting service error: the ledger is closed for maintenance")
                return {"ok": True, "entities": ENTITIES}
            if path.endswith("/reports/pnl"):
                while not self.gate.is_set():
                    await asyncio.sleep(0.01)
                loc = clean.get("location")
                sections = {}
                for c in PNL.get(loc, []) + (["41101"] if loc in self.dated else []):
                    sections.setdefault(TITLES[c][0], []).append({"account_no": c, "title": TITLES[c][1], "amount": 1})
                return {"ok": True, "sections": [{"key": k, "accounts": v} for k, v in sections.items()]}
            if path.endswith("/reports/buckets"):
                loc = clean.get("location")
                if clean.get("by") == "customer":
                    if loc in self.dated:
                        return {"ok": True, "rows": self.dated[loc], "labels": LABELS}
                    return {"ok": True, "rows": _rows_by_customer(loc), "labels": LABELS}
                if clean.get("by") == "month":
                    return {"ok": True, "rows": _rows_by_month(loc, clean.get("customer")), "labels": {}}
            return {"ok": True, "echo": clean}

        self._get, accounting._acct_get = accounting._acct_get, fake_get
        self._base, self._key = accounting._ACCT_BASE, accounting._ACCT_KEY
        accounting._ACCT_BASE, accounting._ACCT_KEY = "http://accounting.invalid", "test-key"

    def tearDown(self):
        self.gate.set()
        accounting._acct_get = self._get
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

    def _settled(self, timeout=10.0):
        """GET until the scan job answers something other than 202."""
        end = time.monotonic() + timeout
        while True:
            r = self.client.get(URL)
            if r.status_code != 202 or time.monotonic() > end:
                return r
            time.sleep(0.05)

    def _bucket_calls(self, by):
        return [c[1] for c in self.calls if c[0].endswith("/reports/buckets") and c[1]["by"] == by]

    def _pnl_calls(self):
        return [c[1]["location"] for c in self.calls if c[0].endswith("/reports/pnl")]

    def test_the_scan_is_a_background_job_polled_until_the_result(self):
        _as(EDITOR)
        self.gate.clear()
        r = self.client.get(URL)
        self.assertEqual(r.status_code, 202, r.text)
        self.assertEqual((r.json()["scanning"], r.json()["done"]), (True, 0))
        self.assertIn("startedAt", r.json())
        end = time.monotonic() + 5
        while time.monotonic() < end:
            j = self.client.get(URL).json()
            if j.get("total") == len(LEAVES):
                break
            time.sleep(0.02)
        self.assertEqual((j["scanning"], j["done"], j["total"]), (True, 0, len(LEAVES)))
        self.gate.set()
        r = self._settled()
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["entitiesScanned"], d["parentsSkipped"]), (len(LEAVES), 1))
        self.assertEqual(sorted(self._pnl_calls()), LEAVES)      # one P&L read per leaf; 12027 never
        # Again: the finished job answers, nothing is read twice.
        self.assertEqual(self.client.get(URL).status_code, 200)
        self.assertEqual(len(self._pnl_calls()), len(LEAVES))
        # A create clears it: the next GET starts over.
        self.assertEqual(self.client.post("/accounting/leasing/from-ledger/create", json={"items": [{"entityCode": "12027-1", "customerId": "C00300"}]}).status_code, 201)
        self.assertEqual(self.client.get(URL).status_code, 202)
        self.assertEqual(self._settled().status_code, 200)
        self.assertEqual(len(self._pnl_calls()), 2 * len(LEAVES))

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

    def test_proposals_from_rent_postings(self):
        _as(EDITOR)
        r = self._settled()
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        self.assertEqual((d["entitiesScanned"], d["parentsSkipped"], d["entitiesWithRentAccounts"]), (3, 1, 2))
        self.assertEqual(sorted((a["entityCode"], a["code"], a["title"]) for a in d["rentAccounts"]),
                         [("12027-1", "41101", "Rental Income"), ("15000", "41101", "Rental Income"), ("15000", "41102", "Tenant CAM Reimbursements")])
        got = {(p["entityCode"], p["customerId"]): p for p in d["proposals"]}
        # The storage customer is not a tenant; the parent 12027 is not scanned, so Rajesh J. Kadakia MD comes once.
        self.assertEqual(set(got), {("15000", "C00498"), ("15000", "C00497"), ("12027-1", "C00300")})
        o = got[("15000", "C00498")]
        self.assertEqual((o["tenantName"], o["entityCode"], o["incomeAccounts"], o["monthlyRent"], o["firstMonth"], o["lastMonth"], o["postedMonths"], o["received12"], o["status"]),
                         ("Overstie Management", "15000", ["41101", "41102"], 3200.0, "2026-01", "2026-09", 9, 28800.0, "new"))
        s = got[("15000", "C00497")]
        self.assertEqual((s["monthlyRent"], s["firstMonth"], s["postedMonths"]), (2200.0, "2025-11", 11))     # 2,100 x 9 then 2,200 x 2: the last three say 2,200
        self.assertEqual((got[("12027-1", "C00300")]["tenantName"], got[("12027-1", "C00300")]["monthlyRent"]), ("Rajesh J. Kadakia MD, Inc.", 11000.0))
        self.assertEqual(d["lookedFor"], ["Rent", "Rental", "Lease / Leasing", "Tenant"])
        # The reads: a P&L per leaf entity; one by=customer only where a rent account is; a month split only for the customers who posted rent.
        self.assertEqual(sorted(self._pnl_calls()), LEAVES)
        self.assertEqual(sorted(c["location"] for c in self._bucket_calls("customer")), ["12027-1", "15000"])
        self.assertEqual(sorted((c["location"], c["customer"]) for c in self._bucket_calls("month")), [("12027-1", "C00300"), ("15000", "C00497"), ("15000", "C00498")])

    def test_no_month_read_when_the_payload_carries_the_date_and_the_customer_posted_once(self):
        _as(EDITOR)
        self.dated["56000"] = [
            {"bucket": "C00001", "section": "revenue", "account_no": "41101", "title": "Rental Income", "debit": 0, "credit": 1500.0, "date": "2026-09-05"},
            {"bucket": "C00497", "section": "revenue", "account_no": "41101", "title": "Rental Income", "debit": 0, "credit": 2200.0, "date": "2026-08-03"},
            {"bucket": "C00497", "section": "revenue", "account_no": "41101", "title": "Rental Income", "debit": 0, "credit": 2200.0, "date": "2026-09-03"},
        ]
        d = self._settled().json()
        got = {(p["entityCode"], p["customerId"]): p for p in d["proposals"]}
        self.assertEqual((got[("56000", "C00001")]["monthlyRent"], got[("56000", "C00001")]["firstMonth"], got[("56000", "C00001")]["postedMonths"]), (1500.0, "2026-09", 1))
        # One month for Walk-in: read from the rows. Two for Santos: the month read.
        self.assertEqual(sorted((c["location"], c["customer"]) for c in self._bucket_calls("month") if c["location"] == "56000"), [("56000", "C00497")])

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
        got = {p["customerId"]: (p["status"], p["leaseId"]) for p in self._settled().json()["proposals"] if p["entityCode"] == "15000"}
        self.assertEqual(got["C00498"], ("set_up", lease["id"]))
        self.assertEqual(got["C00497"][0], "new")

    def test_an_ended_lease_does_not_count_as_set_up(self):
        _as(EDITOR)
        r = self.client.post("/leasing/leases", json={"propertyName": "Old", "entityCode": "15000", "customerId": "C00498", "tenantName": "Overstie Management", "status": "ended", "leaseStart": "2024-01-01", "leaseEnd": "2025-06-30", "rates": [{"startDate": "2024-01-01", "rent": 2500}]})
        self.assertEqual(r.status_code, 201, r.text)
        got = {p["customerId"]: p["status"] for p in self._settled().json()["proposals"]}
        self.assertEqual(got["C00498"], "new")

    def test_viewers_cannot_create(self):
        _as(VIEWER)
        self.assertEqual(self.client.post("/accounting/leasing/from-ledger/create", json={"items": [{"entityCode": "15000", "customerId": "C00498"}]}).status_code, 403)
        self.assertEqual(self._settled().status_code, 200)
        self.assertEqual(self.client.post("/accounting/leasing/from-ledger/create", json={"items": []}).status_code, 403)

    def test_a_limited_person_sees_only_their_entities(self):
        _as(LIMITED)
        d = self._settled().json()
        self.assertEqual((d["entitiesScanned"], d["parentsSkipped"], d["proposals"]), (1, 0, []))
        self.assertEqual((self._pnl_calls(), self._bucket_calls("customer")), (["56000"], []))     # no rent account: no buckets read
        self.assertEqual(self.client.post("/accounting/leasing/from-ledger/create", json={"items": [{"entityCode": "15000", "customerId": "C00498"}]}).status_code, 403)
        self.assertEqual(self.client.get("/leasing/leases").json(), [])

    def test_not_configured_is_503(self):
        _as(EDITOR)
        accounting._acct_get = self._get
        accounting._ACCT_BASE = ""
        self.assertEqual(self._settled().status_code, 503)


if __name__ == "__main__":
    unittest.main()
