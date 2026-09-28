"""Leasing and monthly recurring income (Neil and Charmi, Sep 25) - as tests.

What a lease expects each month (the rent in force, pro-rated by the day, less
an agreed deduction), what was received (what posted to the rental income
account for that customer that month), and what that makes of the month: paid,
short, unpaid, late, still due. A tenant who moves out is ended, never
overwritten. A person limited to certain entities sees only their leases. The
accounting service is replaced by a recorder.

    python -m unittest test_leasing
"""
import os
import unittest
import uuid
from datetime import date

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import accounting, leasing

models.Base.metadata.create_all(bind=database.engine)

EDITOR = "editor.lease.test@greensglobal.com"     # accounting:editor
VIEWER = "viewer.lease.test@greensglobal.com"     # accounting:viewer
LIMITED = "limited.lease.test@greensglobal.com"   # accounting:editor, entity 15000 only
MANAGER = "manager.lease.test@greensglobal.com"   # accounting:full
EVERYONE = (EDITOR, VIEWER, LIMITED, MANAGER)
GROUPS = {"grp-lease-test-e": ("accounting:editor", (EDITOR, LIMITED)), "grp-lease-test-v": ("accounting:viewer", (VIEWER,)),
          "grp-lease-test-f": ("accounting:full", (MANAGER,))}
TAG = "LEASE-TEST"


def lease(**over):
    base = {"id": "L1", "customerId": "C1", "incomeAccounts": ["41101"], "leaseStart": "2026-01-01", "leaseEnd": "", "lateFee": 100.0,
            "dueDay": 1, "graceDays": 5, "status": "active", "rates": [{"startDate": "2026-01-01", "rent": 3000.0, "cam": 0.0, "other": 0.0}]}
    return {**base, **over}


class ArithmeticTests(unittest.TestCase):
    """The rules, with no database and no ledger."""

    def test_a_whole_month(self):
        self.assertEqual(leasing.expected_for_month(lease(), 2026, 3), 3000.0)

    def test_rent_plus_cam(self):
        l = lease(rates=[{"startDate": "2026-01-01", "rent": 2125.0, "cam": 200.0, "other": 0.0}])
        self.assertEqual(leasing.expected_for_month(l, 2026, 3), 2325.0)

    def test_a_rent_that_goes_up_at_renewal(self):
        l = lease(rates=[{"startDate": "2025-01-01", "rent": 4300.0, "cam": 0, "other": 0}, {"startDate": "2026-04-01", "rent": 4500.0, "cam": 0, "other": 0}])
        self.assertEqual([leasing.expected_for_month(l, 2026, m) for m in (3, 4, 5)], [4300.0, 4500.0, 4500.0])

    def test_a_rent_that_changes_mid_month_is_split_by_the_day(self):
        l = lease(rates=[{"startDate": "2026-01-01", "rent": 3000.0, "cam": 0, "other": 0}, {"startDate": "2026-04-16", "rent": 6000.0, "cam": 0, "other": 0}])
        self.assertEqual(leasing.expected_for_month(l, 2026, 4), 4500.0)     # 15 days at 3,000 + 15 days at 6,000

    def test_a_lease_that_starts_or_ends_mid_month(self):
        self.assertEqual(leasing.expected_for_month(lease(leaseStart="2026-04-16"), 2026, 4), 1500.0)
        self.assertEqual(leasing.expected_for_month(lease(leaseEnd="2026-04-15"), 2026, 4), 1500.0)

    def test_outside_the_lease_there_is_nothing_to_expect(self):
        self.assertIsNone(leasing.expected_for_month(lease(leaseStart="2026-06-01"), 2026, 4))
        self.assertIsNone(leasing.expected_for_month(lease(leaseEnd="2026-02-28"), 2026, 4))
        self.assertIsNone(leasing.expected_for_month(lease(rates=[]), 2026, 4))

    def test_what_a_month_is_called(self):
        today = date(2026, 9, 28)
        s = lambda exp, rec, y, m, **over: leasing.month_status(exp, rec, lease(**over), y, m, today)  # noqa: E731
        self.assertEqual(s(3000, 3000, 2026, 8), "paid")
        self.assertEqual(s(3000, 2999.75, 2026, 8), "paid")            # within fifty cents
        self.assertEqual(s(3000, 3500, 2026, 8), "paid")               # paid ahead
        self.assertEqual(s(3000, 2800, 2026, 8), "short")
        self.assertEqual(s(3000, 0, 2026, 8), "unpaid")
        self.assertEqual(s(3000, 0, 2026, 9), "late")                  # this month, past the grace days
        self.assertEqual(s(3000, 1000, 2026, 9), "short")
        self.assertEqual(s(3000, 0, 2026, 9, dueDay=25, graceDays=5), "due")   # not late yet
        self.assertEqual(s(3000, 0, 2026, 10), "upcoming")
        self.assertEqual(s(0, 0, 2026, 8), "none")

    def test_the_year(self):
        receipts = {("C1", "2026-01"): {"41101": 3000.0}, ("C1", "2026-02"): {"41101": 2800.0, "49999": 500.0},   # another account does not count
                    ("C1", "2026-03"): {"41101": 2755.0}}
        months = {"L1:2026-03": {"adjustment": 245.0, "note": "AC repair taken off the rent"}}
        out = leasing.rent_roll([lease()], months, receipts, 2026, date(2026, 4, 20))
        cells = out["rows"][0]["months"]
        self.assertEqual([(c["expected"], c["received"], c["status"]) for c in cells[:5]],
                         [(3000.0, 3000.0, "paid"), (3000.0, 2800.0, "short"), (2755.0, 2755.0, "paid"), (3000.0, 0.0, "late"), (3000.0, 0.0, "upcoming")])
        self.assertEqual(cells[2]["note"], "AC repair taken off the rent")
        row = out["rows"][0]
        self.assertEqual((row["monthsBehind"], row["owed"], row["lateFees"], row["balanceToDate"]), (2, 3200.0, 200.0, 3200.0))
        self.assertEqual(out["summary"], {"leases": 1, "behind": 1, "owed": 3200.0, "expectedToDate": 11755.0, "receivedToDate": 8555.0})
        self.assertEqual(out["totals"][1], {"month": "2026-02", "expected": 3000.0, "received": 2800.0})

    def test_a_payment_after_the_lease_ended_still_shows(self):
        out = leasing.rent_roll([lease(leaseEnd="2026-02-28")], {}, {("C1", "2026-03"): {"41101": 3000.0}}, 2026, date(2026, 9, 28))
        march, april = out["rows"][0]["months"][2], out["rows"][0]["months"][3]
        self.assertEqual((march["inForce"], march["expected"], march["received"], march["status"]), (True, 0.0, 3000.0, "paid"))
        self.assertEqual(april, {"month": "2026-04", "inForce": False})


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class LeasingApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for gid, (modules, members) in GROUPS.items():
                db.add(models.NexusGroup(id=gid, name=gid, allowed_modules=modules))
                for m in members:
                    db.add(models.NexusGroupMember(group_id=gid, email=m))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=LIMITED, module_id="accounting", scope_type="ledger", scope_id="15000"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.asked = []
        self.fail_ledger = False

        async def fake_get(path, params):
            self.asked.append((path, {k: v for k, v in params.items() if v is not None}))
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": [{"code": "15000", "name": "Greens Escondido", "parent_code": None}, {"code": "12000", "name": "Greens Global", "parent_code": None}]}
            if path.endswith("/reports/by-customer"):
                if self.fail_ledger:
                    from fastapi import HTTPException
                    raise HTTPException(status_code=424, detail="Accounting service returned 500")
                return {"ok": True, "rows": [{"customer": "C00498", "account_no": "41101", "month": f"{date.today().year}-01", "debit": 0, "credit": 3000.0}]}
            return {"ok": True, "values": [{"code": "C00498", "name": "Greens Fairfield, LLC."}]}

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

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            ids = [l.id for l in db.query(models.Lease).filter(models.Lease.region == TAG).all()]
            if ids:
                db.query(models.LeaseRate).filter(models.LeaseRate.lease_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.LeaseMonth).filter(models.LeaseMonth.lease_id.in_(ids)).delete(synchronize_session=False)
                db.query(models.Lease).filter(models.Lease.id.in_(ids)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_(list(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_(list(GROUPS))).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_(EVERYONE)).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _body(self, **over):
        return {"propertyName": "910 SECR - Ste 100, San Clemente", "region": TAG, "entityCode": "15000", "customerId": "C00498", "tenantName": "Greens Fairfield, LLC.",
                "leaseStart": f"{date.today().year}-01-01", "lateFee": 100, "rates": [{"startDate": f"{date.today().year}-01-01", "rent": 3000, "cam": 200}], **over}

    def _mine(self):
        return [l for l in self.client.get("/leasing/leases").json() if l["region"] == TAG]

    def test_a_lease_and_its_rent_over_time(self):
        _as(EDITOR)
        made = self.client.post("/leasing/leases", json=self._body())
        self.assertEqual(made.status_code, 201, made.text)
        lid = made.json()["id"]
        self.assertEqual(made.json()["incomeAccounts"], ["41101"])       # the rental income account unless told otherwise
        y = date.today().year
        changed = self.client.put(f"/leasing/leases/{lid}", json=self._body(rates=[{"startDate": f"{y}-07-01", "rent": 3300}, {"startDate": f"{y}-01-01", "rent": 3000, "cam": 200}]))
        self.assertEqual([(r["startDate"], r["rent"]) for r in changed.json()["rates"]], [(f"{y}-01-01", 3000.0), (f"{y}-07-01", 3300.0)])
        # Saving the lease without its rents leaves the rents alone.
        body = self._body()
        del body["rates"]
        self.assertEqual(len(self.client.put(f"/leasing/leases/{lid}", json=body).json()["rates"]), 2)

    def test_what_is_refused(self):
        _as(EDITOR)
        y = date.today().year
        for over in ({"propertyName": " "}, {"tenantName": ""}, {"leaseStart": "01/01/2026"}, {"leaseEnd": f"{y - 1}-12-31"}, {"dueDay": 31},
                     {"rates": [{"startDate": f"{y}-01-01", "rent": 1}, {"startDate": f"{y}-01-01", "rent": 2}]}, {"rates": [{"startDate": f"{y}-01-01", "rent": -5}]}):
            self.assertEqual(self.client.post("/leasing/leases", json=self._body(**over)).status_code, 400, over)
        # A vacant space has no tenant, and that is fine.
        self.assertEqual(self.client.post("/leasing/leases", json=self._body(tenantName="", customerId="", status="vacant")).status_code, 201)
        _as(VIEWER)
        self.assertEqual(self.client.post("/leasing/leases", json=self._body()).status_code, 403)

    def test_rent_roll_reads_the_ledger_once(self):
        _as(EDITOR)
        self.client.post("/leasing/leases", json=self._body())
        _as(VIEWER)
        out = self.client.get("/leasing/rent-roll").json()
        row = [r for r in out["rows"] if r["lease"]["region"] == TAG][0]
        self.assertEqual((row["months"][0]["expected"], row["months"][0]["received"], row["months"][0]["status"]), (3200.0, 3000.0, "short"))
        calls = [p for (path, p) in self.asked if path.endswith("by-customer")]
        self.assertEqual(len(calls), 1)
        self.assertIn("C00498", calls[0]["customers"])
        self.assertIn("41101", calls[0]["accounts"])

    def test_the_screen_survives_the_ledger_being_down(self):
        _as(EDITOR)
        self.client.post("/leasing/leases", json=self._body())
        self.fail_ledger = True
        r = self.client.get("/leasing/rent-roll")
        self.assertEqual(r.status_code, 200)
        out = r.json()
        self.assertIn("could not be read", out["warning"])
        row = [x for x in out["rows"] if x["lease"]["region"] == TAG][0]
        self.assertEqual((row["months"][0]["expected"], row["months"][0]["status"], row["owed"]), (3200.0, "unknown", 0))

    def test_a_new_tenant_does_not_overwrite_the_old_one(self):
        _as(EDITOR)
        y = date.today().year
        old = self.client.post("/leasing/leases", json=self._body()).json()
        new = self.client.post(f"/leasing/leases/{old['id']}/replace", json=self._body(tenantName="Dr. Azadeh Sham", customerId="C00272", leaseStart=f"{y}-07-01",
                                                                                     movedOut=f"{y}-06-30", rates=[{"startDate": f"{y}-07-01", "rent": 3500}]))
        self.assertEqual(new.status_code, 201, new.text)
        self.assertEqual(new.json()["replacesId"], old["id"])
        both = {l["id"]: l for l in self._mine()}
        self.assertEqual((both[old["id"]]["status"], both[old["id"]]["leaseEnd"], both[old["id"]]["tenantName"]), ("ended", f"{y}-06-30", "Greens Fairfield, LLC."))
        self.assertEqual((both[new.json()["id"]]["status"], both[new.json()["id"]]["tenantName"]), ("active", "Dr. Azadeh Sham"))

    def test_a_deduction_and_its_note(self):
        _as(EDITOR)
        lid = self.client.post("/leasing/leases", json=self._body()).json()["id"]
        y = date.today().year
        self.assertEqual(self.client.put(f"/leasing/leases/{lid}/months/{y}-01", json={"adjustment": 200, "note": "Tenant repaired the AC"}).status_code, 200)
        row = [r for r in self.client.get("/leasing/rent-roll").json()["rows"] if r["lease"]["id"] == lid][0]
        self.assertEqual((row["months"][0]["expected"], row["months"][0]["status"], row["months"][0]["note"]), (3000.0, "paid", "Tenant repaired the AC"))
        self.assertEqual(self.client.put(f"/leasing/leases/{lid}/months/January", json={"note": "x"}).status_code, 400)
        self.assertEqual(self.client.put(f"/leasing/leases/{lid}/months/{y}-01", json={"adjustment": -5}).status_code, 400)
        # Clearing both removes the row.
        self.client.put(f"/leasing/leases/{lid}/months/{y}-01", json={"adjustment": 0, "note": ""})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.LeaseMonth).filter(models.LeaseMonth.lease_id == lid).count(), 0)
        finally:
            db.close()

    def test_a_limited_person_sees_only_their_entities_leases(self):
        _as(EDITOR)
        mine = self.client.post("/leasing/leases", json=self._body()).json()
        other = self.client.post("/leasing/leases", json=self._body(entityCode="12000", propertyName="47385 RCR, Temecula")).json()
        _as(LIMITED)
        self.assertEqual([l["id"] for l in self._mine()], [mine["id"]])
        self.assertEqual([r["lease"]["id"] for r in self.client.get("/leasing/rent-roll").json()["rows"] if r["lease"]["region"] == TAG], [mine["id"]])
        self.assertEqual(self.client.put(f"/leasing/leases/{other['id']}", json=self._body(entityCode="12000")).status_code, 403)
        self.assertEqual(self.client.put(f"/leasing/leases/{mine['id']}", json=self._body(entityCode="12000")).status_code, 403)   # cannot move it out of reach
        self.assertEqual(self.client.post("/leasing/leases", json=self._body(entityCode="12000")).status_code, 403)
        self.assertEqual(self.client.put(f"/leasing/leases/{mine['id']}", json=self._body(notes="ok")).status_code, 200)

    def test_deleting_takes_the_full_level(self):
        _as(EDITOR)
        lid = self.client.post("/leasing/leases", json=self._body()).json()["id"]
        self.assertEqual(self.client.delete(f"/leasing/leases/{lid}").status_code, 403)
        _as(MANAGER)
        self.assertEqual(self.client.delete(f"/leasing/leases/{lid}").status_code, 204)
        self.assertEqual(self._mine(), [])


if __name__ == "__main__":
    unittest.main()
