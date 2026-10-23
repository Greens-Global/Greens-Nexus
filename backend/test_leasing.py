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

    def test_old_free_text_terms_read_best_effort(self):
        p = leasing.parse_term
        for text in ("Annual", "annual", "12 months", "12 Months.", "1 year", "One Year", "12-month lease"):
            self.assertEqual(p(text), ("annual", 12), text)
        for text in ("Month to month", "Month-to-Month", "MTM", "month to month"):
            self.assertEqual(p(text), ("month_to_month", None), text)
        self.assertEqual(p("18 months"), ("custom", 18))
        self.assertEqual(p("16 mos"), ("custom", 16))
        self.assertEqual(p("2 years"), ("custom", 24))
        for text in ("", "Until the building sells", "0 months", "999 months", "NNN"):
            self.assertIsNone(p(text), text)
        self.assertEqual(leasing.term_label("custom", 18), "Custom - 18 Months")

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
        self.assertEqual(out["summary"], {"leases": 1, "behind": 1, "owed": 3200.0, "balance": 3200.0, "expectedToDate": 11755.0, "receivedToDate": 8555.0})
        self.assertEqual(out["totals"][1], {"month": "2026-02", "expected": 3000.0, "received": 2800.0})

    def test_a_payment_after_the_lease_ended_still_shows(self):
        out = leasing.rent_roll([lease(leaseEnd="2026-02-28")], {}, {("C1", "2026-03"): {"41101": 3000.0}}, 2026, date(2026, 9, 28))
        march, april = out["rows"][0]["months"][2], out["rows"][0]["months"][3]
        # Oct 7: shown, but outside the lease - it counts toward neither the
        # balance nor the month totals, and the row says money came in outside it.
        self.assertEqual((march["inForce"], march["expected"], march["received"], march["status"], march["balance"]), (True, 0, 3000.0, "outside", 0))
        self.assertEqual(april, {"month": "2026-04", "inForce": False})
        self.assertEqual(out["rows"][0]["outsideLease"], {"months": ["2026-03"], "received": 3000.0})
        self.assertEqual(out["totals"][2]["received"], 0.0)

    def test_oct7_lease_typed_in_on_oct_2_paid_since_january(self):
        """Charmi, 10/07: Expected 2,201.61 / Received 22,750.00 / Balance
        (20,548.39) Credit for one 2,275 a month lease paid Jan-Oct. New Lease
        defaulted Lease Start and the first rent to the day it was typed in
        (Oct 2): October expected 30/31 of the rent and every earlier payment
        counted against nothing."""
        paid = {("C1", f"2026-{m:02d}"): {"41101": 2275.0} for m in range(1, 11)}
        typed = lease(leaseStart="2026-10-02", rates=[{"startDate": "2026-10-02", "rent": 2275.0, "cam": 0, "other": 0}])
        row = leasing.rent_roll([typed], {}, paid, 2026, date(2026, 10, 20))["rows"][0]
        counted = [c for c in row["months"] if c.get("inForce") and c["status"] not in ("upcoming", "outside")]
        self.assertEqual(round(sum(c["balance"] for c in counted), 2), -73.39)      # no fake 20.5K credit
        self.assertEqual(row["outsideLease"]["received"], 20475.0)                  # flagged: check the Lease Start
        # With the real start date the year adds up: 10 x 2,275 expected and received.
        right = lease(leaseStart="2026-01-01", rates=[{"startDate": "2026-10-02", "rent": 2275.0, "cam": 0, "other": 0}])
        row = leasing.rent_roll([right], {}, paid, 2026, date(2026, 10, 20))["rows"][0]
        counted = [c for c in row["months"] if c.get("inForce") and c["status"] not in ("upcoming", "outside")]
        self.assertEqual((round(sum(c["expected"] for c in counted), 2), round(sum(c["received"] for c in counted), 2), row["balanceToDate"]), (22750.0, 22750.0, 0.0))

    def test_the_first_rent_applies_from_the_lease_start(self):
        l = lease(leaseStart="2026-01-01", rates=[{"startDate": "2026-03-15", "rent": 3100.0, "cam": 0, "other": 0}])
        self.assertEqual([leasing.expected_for_month(l, 2026, m) for m in (1, 2, 3)], [3100.0, 3100.0, 3100.0])
        # No lease start: nothing is in force before the first rent.
        l = lease(leaseStart="", rates=[{"startDate": "2026-03-01", "rent": 3100.0, "cam": 0, "other": 0}])
        self.assertEqual([leasing.expected_for_month(l, 2026, m) for m in (2, 3)], [None, 3100.0])

    def test_received_by_account_rides_with_each_month(self):
        l = lease(incomeAccounts=["41101", "41102"])
        out = leasing.rent_roll([l], {}, {("C1", "2026-02"): {"41101": 3000.0, "41102": 150.0, "42000": 99.0}}, 2026, date(2026, 9, 28))
        self.assertEqual(out["rows"][0]["months"][1]["byAccount"], {"41101": 3000.0, "41102": 150.0})


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class CustomerLinkTests(unittest.TestCase):
    """Oct 6 (Charmi, 10/04): "when we manually added the customer number,
    the data populated" - received is read by customer code, so a lease
    without one read nothing. Leases are now matched by name."""

    DIRECTORY = {"C00498": {"name": "Greens Fairfield, LLC."}, "C00272": {"name": "Dr. Azadeh Sham"}, "C00100": {"name": "Smith & Sons"}, "C00101": {"name": "Smith and Sons Inc."}}

    def test_names_compare_without_case_punctuation_or_company_suffix(self):
        self.assertEqual(leasing.norm_name("Greens Fairfield, LLC."), "greens fairfield")
        self.assertEqual(leasing.norm_name("GREENS FAIRFIELD llc"), "greens fairfield")
        self.assertEqual(leasing.norm_name("Smith & Sons, Inc."), "smith and sons")

    def test_resolve(self):
        idx = leasing.customer_index(self.DIRECTORY)
        r = leasing.resolve_customer
        self.assertEqual(r("", "Greens Fairfield LLC", idx), "C00498")            # the name alone: linked
        self.assertEqual(r("c00498", "", idx), "C00498")                          # the code in the wrong case: corrected
        self.assertEqual(r("Dr Azadeh Sham", "", idx), "C00272")                  # a name typed in the code box
        self.assertEqual(r("C00498", "Someone Else", idx), "C00498")              # a known code is never second-guessed
        self.assertIsNone(r("C99999", "Greens Fairfield", idx))                   # an unknown code is left alone
        self.assertIsNone(r("", "Smith and Sons", idx))                           # two customers by that name: no guess
        self.assertIsNone(r("", "Nobody", idx))

    def test_balance_is_expected_less_received_and_a_prepayment_is_a_credit(self):
        out = leasing.rent_roll([lease()], {}, {("C1", "2026-01"): {"41101": 6000.0}}, 2026, date(2026, 1, 20))
        row = out["rows"][0]
        self.assertEqual((row["months"][0]["balance"], row["balanceToDate"], row["owed"], out["summary"]["balance"]), (-3000.0, -3000.0, 0, -3000.0))

    def test_expired(self):
        self.assertTrue(leasing.expired(lease(status="ended"), date(2026, 10, 6)))
        self.assertTrue(leasing.expired(lease(leaseEnd="2026-09-30"), date(2026, 10, 6)))
        self.assertFalse(leasing.expired(lease(leaseEnd="2026-10-31"), date(2026, 10, 6)))
        self.assertFalse(leasing.expired(lease(), date(2026, 10, 6)))


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
            if path.endswith("/reports/buckets") and params.get("by") == "month":
                if self.fail_ledger:
                    from fastapi import HTTPException
                    raise HTTPException(status_code=424, detail="Accounting service returned 500")
                return {"ok": True, "rows": [{"bucket": f"{date.today().year}-01", "account_no": "41101", "debit": 0, "credit": 3000.0}]}
            return {"ok": True, "values": [{"code": "C00498", "name": "Greens Fairfield, LLC."}]}

        self._get = accounting._acct_get
        accounting._acct_get = fake_get
        self.partners = []

        async def partners():
            return self.partners
        self._partners, leasing._partner_customers = leasing._partner_customers, partners
        leasing._PARTNERS_DOWN.clear()

    def tearDown(self):
        accounting._acct_get = self._get
        leasing._partner_customers = self._partners
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

    def test_an_income_source_has_a_type(self):
        """Oct 7 (Charmi): MRI is one list of every recurring income source."""
        _as(EDITOR)
        self.assertEqual(self.client.post("/leasing/leases", json=self._body()).json()["incomeType"], "lease")
        made = self.client.post("/leasing/leases", json=self._body(incomeType="interest", propertyName="Note to Oversite Inv2"))
        self.assertEqual((made.status_code, made.json()["incomeType"]), (201, "interest"))
        odd = self.client.post("/leasing/leases", json=self._body(incomeType="bitcoin"))
        self.assertEqual(odd.json()["incomeType"], "lease")
        refused = self.client.post("/leasing/leases", json=self._body(incomeType="loan_payment", tenantName=""))
        self.assertEqual((refused.status_code, refused.json()["detail"]), (400, "Name who pays it."))
        self.assertEqual({l["incomeType"] for l in self._mine()}, {"lease", "interest"})

    def test_cam_is_a_type_of_its_own(self):
        """Oct 14 (Priyanka): "there is no CAM option" - a CAM charge is kept
        like a lease (a tenant, a space, the dates) under its own type."""
        _as(EDITOR)
        made = self.client.post("/leasing/leases", json=self._body(incomeType="cam", propertyName="910 SECR - CAM"))
        self.assertEqual((made.status_code, made.json()["incomeType"]), (201, "cam"))
        refused = self.client.post("/leasing/leases", json=self._body(incomeType="cam", tenantName=""))
        self.assertEqual((refused.status_code, refused.json()["detail"]), (400, "Name the tenant, or mark the space vacant."))

    def test_the_lease_term_is_a_pick(self):
        """Oct 15 (Charmi + Neil): Annual, Month to Month or Custom with a
        whole number of months - never free text."""
        _as(EDITOR)
        made = self.client.post("/leasing/leases", json=self._body(termType="custom", termMonths=18)).json()
        self.assertEqual((made["termType"], made["termMonths"], made["termLabel"]), ("custom", 18, "Custom - 18 Months"))
        annual = self.client.post("/leasing/leases", json=self._body(termType="annual", termMonths=5)).json()
        self.assertEqual((annual["termType"], annual["termMonths"], annual["termLabel"]), ("annual", 12, "Annual"))
        mtm = self.client.put(f"/leasing/leases/{annual['id']}", json=self._body(termType="month_to_month", termMonths=12)).json()
        self.assertEqual((mtm["termType"], mtm["termMonths"], mtm["termLabel"]), ("month_to_month", None, "Month to Month"))
        for over in ({"termType": "yearly"}, {"termType": "custom"}, {"termType": "custom", "termMonths": 0}, {"termType": "custom", "termMonths": -3},
                     {"termType": "custom", "termMonths": 601}, {"termType": "custom", "termMonths": 16.5}):
            r = self.client.post("/leasing/leases", json=self._body(**over))
            self.assertEqual(r.status_code, 400, over)

    def test_an_old_free_text_term_is_read_never_lost(self):
        _as(EDITOR)
        read = self.client.post("/leasing/leases", json=self._body(leaseTerms="Month to month")).json()
        self.assertEqual((read["termType"], read["termMonths"], read["termLabel"], read["termLegacy"]), ("month_to_month", None, "Month to Month", ""))
        odd = self.client.post("/leasing/leases", json=self._body(leaseTerms="Until the building sells")).json()
        self.assertEqual((odd["termType"], odd["termMonths"], odd["termLegacy"], odd["leaseTerms"]), ("", None, "Until the building sells", "Until the building sells"))
        # Picking a term keeps the old text alongside.
        picked = self.client.put(f"/leasing/leases/{odd['id']}", json=self._body(leaseTerms="Until the building sells", termType="annual")).json()
        self.assertEqual((picked["termType"], picked["leaseTerms"], picked["termLegacy"]), ("annual", "Until the building sells", ""))

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

    def test_rent_roll_reads_the_lease_entity_once(self):
        _as(EDITOR)
        self.client.post("/leasing/leases", json=self._body())
        _as(VIEWER)
        out = self.client.get("/leasing/rent-roll").json()
        row = [r for r in out["rows"] if r["lease"]["region"] == TAG][0]
        self.assertEqual((row["months"][0]["expected"], row["months"][0]["received"], row["months"][0]["status"]), (3200.0, 3000.0, "short"))
        calls = [p for (path, p) in self.asked if path.endswith("/reports/buckets") and p.get("customer") == "C00498"]
        self.assertEqual(calls, [{"from": f"{date.today().year}-01-01", "to": f"{date.today().year}-12-31", "by": "month", "location": "15000", "customer": "C00498"}])
        self.assertEqual([p for (path, p) in self.asked if path.endswith("by-customer") and "C00498" in p["customers"]], [])

    def test_a_lease_with_no_entity_reads_the_customer_consolidated(self):
        """No entity, no location to map to: the consolidated by-customer read."""
        _as(EDITOR)
        self.client.post("/leasing/leases", json=self._body(entityCode=""))
        _as(VIEWER)
        row = [r for r in self.client.get("/leasing/rent-roll").json()["rows"] if r["lease"]["region"] == TAG][0]
        self.assertEqual(row["months"][0]["received"], 3000.0)
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

    def _row(self, lid, **params):
        return [r for r in self.client.get("/leasing/rent-roll", params=params).json()["rows"] if r["lease"]["id"] == lid]

    def test_a_lease_with_only_the_tenant_name_is_linked_and_reads_the_ledger(self):
        _as(EDITOR)
        # Saved with the name only: linked on save.
        made = self.client.post("/leasing/leases", json=self._body(customerId="", tenantName="GREENS FAIRFIELD LLC")).json()
        self.assertEqual((made["customerId"], made["linkSource"]), ("C00498", "auto-name"))
        # An old row with no code (before this fix): linked when the rent roll loads, and the payment shows.
        db = database.SessionLocal()
        try:
            db.query(models.Lease).filter(models.Lease.id == made["id"]).update({"customer_id": "", "link_source": ""})
            db.commit()
        finally:
            db.close()
        out = self.client.get("/leasing/rent-roll").json()
        self.assertIn(made["id"], [x["leaseId"] for x in out["linked"]])
        row = [r for r in out["rows"] if r["lease"]["id"] == made["id"]][0]
        self.assertEqual((row["lease"]["customerId"], row["months"][0]["received"]), ("C00498", 3000.0))
        self.assertEqual([l["customerId"] for l in self._mine()], ["C00498"])        # kept
        self.assertEqual(self.client.get("/leasing/rent-roll").json()["linked"], [])  # nothing left to link

    def test_the_customer_record_and_an_inactive_customer(self):
        _as(EDITOR)
        lid = self.client.post("/leasing/leases", json=self._body(phone="760-555-0100", email="")).json()["id"]
        # Before the accounting app serves the full record: the ledger's name, the lease's own details.
        c = self.client.get("/leasing/customers/C00498").json()
        self.assertEqual((c["name"], c["phone"], c["active"], c["source"]), ("Greens Fairfield, LLC.", "760-555-0100", True, "ledger"))
        self.assertEqual([x["id"] for x in c["leases"]], [lid])
        self.assertTrue(self._row(lid)[0]["customerActive"])
        # Intacct's record, inactive.
        self.partners = [{"id": "C00498", "name": "Greens Fairfield, LLC.", "displayName": "Greens Fairfield", "phone": "(951) 555-0199", "email": "ap@fairfield.example",
                          "address": {"line1": "100 Main St", "line2": "", "city": "Fairfield", "state": "CA", "zip": "94533", "country": ""}, "status": "inactive"}]
        c = self.client.get("/leasing/customers/C00498").json()
        self.assertEqual((c["name"], c["phone"], c["email"], c["address"], c["active"], c["source"]),
                         ("Greens Fairfield", "(951) 555-0199", "ap@fairfield.example", "100 Main St, Fairfield, CA 94533", False, "intacct"))
        out = self.client.get("/leasing/rent-roll").json()
        row = [r for r in out["rows"] if r["lease"]["id"] == lid][0]
        self.assertEqual((row["customerActive"], row["customer"]["phone"], out["customerDetails"]), (False, "(951) 555-0199", True))
        self.assertGreaterEqual(out["summary"]["inactive"], 1)
        self.assertEqual(self.client.get("/leasing/customers/C55555").status_code, 404)
        _as(LIMITED)
        self.assertEqual(self.client.get("/leasing/customers/C00272").status_code, 403)

    def test_the_customer_list_is_held_to_the_callers_entities(self):
        async def fake_get(path, params):
            if path.endswith("/reports/locations"):
                return {"ok": True, "entities": [{"code": "15000", "name": "Greens Escondido", "parent_code": None}, {"code": "12000", "name": "Greens Global", "parent_code": None}]}
            return {"ok": True, "values": [{"code": "C00498", "name": "Greens Fairfield, LLC."}, {"code": "C00272", "name": "Dr. Azadeh Sham"},
                                           {"code": "C00900", "name": "Family Trust Tenant"}]}
        accounting._acct_get = fake_get
        _as(MANAGER)
        self.assertEqual(self.client.post("/leasing/leases", json=self._body()).status_code, 201)                                         # 15000
        self.assertEqual(self.client.post("/leasing/leases", json=self._body(entityCode="12000", customerId="C00272", tenantName="Dr. Azadeh Sham")).status_code, 201)
        codes = lambda: {c["code"] for c in self.client.get("/leasing/customers").json()["customers"]}     # noqa: E731
        self.assertEqual(codes() & {"C00498", "C00272", "C00900"}, {"C00498", "C00272", "C00900"})        # not limited: every customer
        _as(LIMITED)                                                                                       # entity 15000 only
        r = self.client.get("/leasing/customers")
        self.assertEqual(r.status_code, 200, r.text)
        mine = {l["customerId"] for l in self.client.get("/leasing/leases").json()}
        self.assertEqual(codes(), mine & {"C00498", "C00272", "C00900"})
        self.assertIn("C00498", codes())
        self.assertNotIn("C00272", codes())      # on a lease of an entity outside the limit
        self.assertNotIn("C00900", codes())      # on no lease the caller may read

    def test_the_customer_list_carries_intacct_contact_details(self):
        """Oct 15 (Charmi): picking the tenant fills the lease form from the
        Intacct customer record - phone, email and address ride on the list."""
        _as(EDITOR)
        self.partners = [{"id": "C00498", "name": "Greens Fairfield, LLC.", "phone": "(951) 555-0199", "email": "ap@fairfield.example",
                          "address": {"line1": "100 Main St", "line2": "", "city": "Fairfield", "state": "CA", "zip": "94534", "country": ""}}]
        c = self.client.get("/leasing/customers").json()["customers"][0]
        self.assertEqual((c["code"], c["phone"], c["email"], c["address"]), ("C00498", "(951) 555-0199", "ap@fairfield.example", "100 Main St, Fairfield, CA 94534"))

        async def down():
            raise RuntimeError("501")
        leasing._partner_customers = down
        c = self.client.get("/leasing/customers").json()["customers"][0]
        self.assertEqual((c["code"], c["phone"], c["email"], c["address"]), ("C00498", "", "", ""))

    def test_the_team_note(self):
        _as(EDITOR)
        lid = self.client.post("/leasing/leases", json=self._body()).json()["id"]
        r = self.client.put(f"/leasing/leases/{lid}/note", json={"note": "Promised to pay by the 15th"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["text"], r.json()["by"]), ("Promised to pay by the 15th", EDITOR))
        note = self._row(lid)[0]["lease"]["teamNote"]
        self.assertEqual((note["text"], note["by"], bool(note["at"])), ("Promised to pay by the 15th", EDITOR, True))
        self.assertEqual(self.client.put(f"/leasing/leases/{lid}/note", json={"note": " "}).json(), {"text": "", "by": "", "byName": "", "at": ""})
        _as(VIEWER)
        self.assertEqual(self.client.put(f"/leasing/leases/{lid}/note", json={"note": "x"}).status_code, 403)

    def test_entities_customers_and_expired(self):
        _as(EDITOR)
        y = date.today().year
        a = self.client.post("/leasing/leases", json=self._body()).json()["id"]
        b = self.client.post("/leasing/leases", json=self._body(entityCode="12000", customerId="C00272", tenantName="Dr. Azadeh Sham", status="ended", leaseEnd=f"{y}-02-28")).json()["id"]

        def ids(**p):
            return {r["lease"]["id"] for r in self.client.get("/leasing/rent-roll", params=p).json()["rows"] if r["lease"]["region"] == TAG}
        self.assertEqual(ids(), {a, b})
        self.assertEqual(ids(entities="12000"), {b})
        self.assertEqual(ids(customers="C00498"), {a})
        self.assertTrue(self._row(b)[0]["expired"])
        self.assertFalse(self._row(a)[0]["expired"])
        _as(LIMITED)
        self.assertEqual(self.client.get("/leasing/rent-roll", params={"entities": "12000"}).status_code, 403)

    def _ledger_by_location(self):
        """The ledger per entity: 15000 posted 3,000 in January, 12000 posted 1,200 -
        and the consolidated by-customer report, which adds them up."""
        yr = date.today().year
        inner = accounting._acct_get

        async def fake_get(path, params):
            if path.endswith("/reports/buckets"):
                self.asked.append((path, {k: v for k, v in params.items() if v is not None}))
                amount = {"15000": 3000.0, "12000": 1200.0}[params["location"]]
                return {"ok": True, "rows": [{"bucket": f"{yr}-01", "account_no": "41101", "debit": 0, "credit": amount}]}
            if path.endswith("/reports/by-customer"):
                self.asked.append((path, {k: v for k, v in params.items() if v is not None}))
                return {"ok": True, "rows": [{"customer": "C00498", "account_no": "41101", "month": f"{yr}-01", "debit": 0, "credit": 4200.0}]}
            return await inner(path, params)
        accounting._acct_get = fake_get

    def test_a_tenant_on_two_entities_is_read_per_entity(self):
        """One Intacct customer, two leases on two entities, the same income
        account: each lease shows ITS entity's rent, not the sum of both."""
        _as(EDITOR)
        a = self.client.post("/leasing/leases", json=self._body()).json()
        b = self.client.post("/leasing/leases", json=self._body(entityCode="12000", propertyName="47385 RCR, Temecula")).json()
        self._ledger_by_location()
        _as(VIEWER)
        rows = {r["lease"]["id"]: r for r in self.client.get("/leasing/rent-roll").json()["rows"] if r["lease"]["region"] == TAG}
        self.assertEqual(rows[a["id"]]["months"][0]["received"], 3000.0)
        self.assertEqual(rows[b["id"]]["months"][0]["received"], 1200.0)
        buckets = [p for (path, p) in self.asked if path.endswith("/reports/buckets")]
        self.assertEqual(sorted(p["location"] for p in buckets), ["12000", "15000"])
        self.assertTrue(all(p["customer"] == "C00498" and p["by"] == "month" for p in buckets))
        self.assertEqual([p for (path, p) in self.asked if path.endswith("/reports/by-customer") and "C00498" in p["customers"]], [])

    def test_oct23_rent_is_pulled_from_the_location_the_lease_maps_to(self):
        """Urmi, MRI item 24: Greens Global, Inc. (C00132) pays internal rent to
        several properties. The 910 S El Camino Real lease (location 62004,
        16,200 a month) read everything C00132 posted - 201,060 received in
        January (screenshot change-24-a). It now reads location 62004 only:
        16,200, paid. Expected is unchanged; the 184,860 difference is GG Inc.'s
        rent at the other locations, which is not this lease's."""
        yr = date.today().year
        ledger = {"62004": [16200.0], "15000": [200.0, 1700.0, 400.0, 4600.0], "12000": [9135.0, 2500.0, 166325.0]}   # 201,060 in all
        inner = accounting._acct_get

        async def fake_get(path, params):
            if path.endswith("/reports/buckets") and params.get("customer") == "C00132":
                self.asked.append((path, {k: v for k, v in params.items() if v is not None}))
                return {"ok": True, "rows": [{"bucket": f"{yr}-01", "account_no": "41101", "debit": 0, "credit": a} for a in ledger[params["location"]]]}
            if path.endswith("/reports/by-customer") and "C00132" in params["customers"]:
                self.asked.append((path, {k: v for k, v in params.items() if v is not None}))
                return {"ok": True, "rows": [{"customer": "C00132", "account_no": "41101", "month": f"{yr}-01", "debit": 0, "credit": a} for v in ledger.values() for a in v]}
            return await inner(path, params)
        _as(EDITOR)
        made = self.client.post("/leasing/leases", json=self._body(entityCode="62004", customerId="C00132", tenantName="Greens Global, Inc.", propertyName="910 S El Camino Real",
                                                                    lateFee=0, rates=[{"startDate": f"{yr}-01-01", "rent": 16200, "cam": 0}])).json()
        other = self.client.post("/leasing/leases", json=self._body()).json()      # C00498 on 15000: not touched
        accounting._acct_get = fake_get
        _as(VIEWER)
        rows = {r["lease"]["id"]: r for r in self.client.get("/leasing/rent-roll").json()["rows"] if r["lease"]["region"] == TAG}
        jan = rows[made["id"]]["months"][0]
        self.assertEqual((jan["expected"], jan["received"], jan["balance"], jan["status"]), (16200.0, 16200.0, 0.0, "paid"))
        self.assertEqual(jan["byAccount"], {"41101": 16200.0})
        self.assertEqual(rows[other["id"]]["months"][0]["received"], 3000.0)
        gg = [p for (path, p) in self.asked if path.endswith("/reports/buckets") and p.get("customer") == "C00132"]
        self.assertEqual([p["location"] for p in gg], ["62004"])
        self.assertEqual([p for (path, p) in self.asked if path.endswith("/reports/by-customer") and "C00132" in p["customers"]], [])
        # The before / after reconciliation (test notes, change 24): read by customer it was 201,060.
        self.assertEqual(round(sum(a for v in ledger.values() for a in v), 2), 201060.0)
        self.assertEqual(round(201060.0 - jan["received"], 2), 184860.0)

    def test_a_limited_person_never_reads_the_consolidated_report(self):
        """Entity-limited: one month read per entity in reach, never the
        consolidated by-customer report (it carries every entity's postings)."""
        _as(EDITOR)
        mine = self.client.post("/leasing/leases", json=self._body()).json()
        self.client.post("/leasing/leases", json=self._body(entityCode="12000", propertyName="47385 RCR, Temecula"))
        self._ledger_by_location()
        _as(LIMITED)
        rows = [r for r in self.client.get("/leasing/rent-roll").json()["rows"] if r["lease"]["region"] == TAG]
        self.assertEqual([(r["lease"]["id"], r["months"][0]["received"]) for r in rows], [(mine["id"], 3000.0)])
        self.assertEqual([p["location"] for (path, p) in self.asked if path.endswith("/reports/buckets")], ["15000"])
        self.assertEqual([p for (path, p) in self.asked if path.endswith("/reports/by-customer")], [])


if __name__ == "__main__":
    unittest.main()
