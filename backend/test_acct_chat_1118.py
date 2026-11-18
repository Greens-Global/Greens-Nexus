"""Accounting chat, 11/18 (Charmi's MRI and MRE review).

MRI
- An overpayment settles the oldest open month first, on every line (the
  four patterns from her screenshots, with the amounts Intacct holds).
- A periodic (annual) source paid in another month of its period expects
  its amount in the month it was paid: no phantom February.
- Rent posted at the lease's entity with no customer on it still reaches the
  one lease in force there that month.
MRE
- Amount changes with a date, and Paid by Tenant months: never expected,
  never Missed; the amount before the first change is the Expected Amount.

Run on its own: python -m pytest test_acct_chat_1118.py
"""
import _testdb  # noqa: F401 - a throwaway database before `database` is imported

import unittest
from datetime import date

import database
import models
import recurring_stale
from routers import accounting_mre, leasing

models.Base.metadata.create_all(bind=database.engine)
TODAY = date(2026, 11, 3)


def lease(**over):
    base = {"id": "L1", "customerId": "C1", "entityCode": "15001-1", "incomeAccounts": ["41101"], "leaseStart": "2023-10-01", "leaseEnd": "",
            "lateFee": 0.0, "dueDay": 1, "graceDays": 5, "status": "active", "propertyName": "P", "tenantName": "T", "frequency": "",
            "frequencyMonths": 0, "rates": [{"startDate": "2023-10-01", "rent": 100000.0, "cam": 0.0, "other": 0.0}]}
    return {**base, **over}


def roll(l, pay, extra=None, leases=None):
    rec = {(l["entityCode"], l["customerId"], f"2026-{m:02d}"): {"41101": v} for m, v in pay.items()}
    rec.update(extra or {})
    return leasing.rent_roll(leases or [l], {}, rec, 2026, TODAY)["rows"][0]


def st(row):
    return [c.get("status") for c in row["months"]]


class Covered(unittest.TestCase):
    def test_25260_n_centre_city(self):
        # Intacct: Jan, Feb 100k; Mar nothing; Apr 173k; May 147k; Jun nothing;
        # Jul 65k; Aug 70k; Sep 132k; Oct nothing.
        r = roll(lease(), {1: 100000, 2: 100000, 4: 173000, 5: 147000, 7: 65000, 8: 70000, 9: 132000})
        m = r["months"]
        self.assertEqual(m[2]["status"], "covered")               # March: April's and May's extra, oldest first
        self.assertEqual(m[2]["coveredBy"], ["2026-04", "2026-05"])
        self.assertEqual(m[5]["covered"], 52000)                  # June: the rest of May's 47k and 32k of September's
        self.assertEqual(m[5]["status"], "unpaid")                # still 48k open - the year really is short
        self.assertEqual(r["owed"], 48000 + 35000 + 30000 + 100000)

    def test_lizard_rocks_double_payment_covers_the_missed_month(self):
        l = lease(entityCode="65001-1", rates=[{"startDate": "2016-11-01", "rent": 39350.0, "cam": 0.0, "other": 0.0}])
        r = roll(l, {1: 39350, 2: 39350, 3: 39350, 5: 78700, 7: 78700, 8: 39350, 9: 39350, 10: 39350})
        self.assertEqual(st(r)[3], "covered")                     # April, by May's double
        self.assertEqual(st(r)[5], "covered")                     # June, by July's double
        self.assertEqual(r["monthsBehind"], 0)

    def test_april_and_may_paid_together_in_may(self):
        l = lease(entityCode="69002-3", rates=[{"startDate": "2021-12-28", "rent": 1100.0, "cam": 275.0, "other": 0.0}])
        r = roll(l, {1: 1375, 2: 1375, 3: 1375, 5: 2750, 6: 1375, 7: 1375, 8: 1375, 9: 1375, 10: 1375})
        self.assertEqual(st(r)[3], "covered")
        self.assertEqual(r["months"][3]["coveredBy"], ["2026-05"])
        self.assertEqual(r["monthsBehind"], 0)

    def test_one_payment_for_five_months(self):
        l = lease(entityCode="E9", rates=[{"startDate": "2025-01-01", "rent": 3000.0, "cam": 0.0, "other": 0.0}])
        r = roll(l, {5: 15000})
        self.assertEqual(st(r)[:5], ["covered", "covered", "covered", "covered", "paid"])
        self.assertEqual(st(r)[5:10], ["unpaid"] * 5)

    def test_extra_ahead_of_an_open_month_settles_it(self):
        # Overpaid in April, nothing in June: June is covered (prepaid forward).
        r = roll(lease(), {m: 100000 for m in range(1, 11) if m != 6} | {4: 200000})
        self.assertEqual(st(r)[5], "covered")


class AnnualPaidInJune(unittest.TestCase):
    def test_cell_tower_no_phantom_february(self):
        l = lease(entityCode="69002-5", leaseStart="2009-02-02", frequency="annual",
                  rates=[{"startDate": "2009-02-02", "rent": 28464.0, "cam": 0.0, "other": 0.0}])
        r = roll(l, {6: 29317.99})
        feb, jun = r["months"][1], r["months"][5]
        self.assertTrue(feb.get("offCycle"))
        self.assertEqual(feb["expected"], 0)
        self.assertEqual(jun["expected"], 28464.0)
        self.assertEqual(jun["status"], "paid")
        self.assertNotIn("covered", feb)

    def test_nothing_paid_keeps_the_counted_due_month(self):
        l = lease(entityCode="69002-5", leaseStart="2009-02-02", frequency="annual",
                  rates=[{"startDate": "2009-02-02", "rent": 28464.0, "cam": 0.0, "other": 0.0}])
        r = leasing.rent_roll([l], {}, {}, 2025, TODAY)["rows"][0]
        self.assertEqual(r["months"][1]["expected"], 28464.0)
        self.assertEqual(r["months"][1]["status"], "unpaid")


class UntaggedRent(unittest.TestCase):
    def unit1(self, **over):
        return lease(entityCode="69002-1", customerId="C00730", leaseStart="2026-04-01",
                     rates=[{"startDate": "2026-04-01", "rent": 4200.0, "cam": 0.0, "other": 0.0}], **over)

    def test_rent_with_no_customer_reaches_the_only_lease(self):
        l = self.unit1()
        extra = {("69002-1", "", f"2026-{m:02d}"): {"41101": 4200.0} for m in (9, 10)}
        extra[("69002-1", "*payers")] = {"C00730"}
        r = roll(l, {4: 3200, 5: 6500, 6: 4200, 7: 4200, 8: 4200}, extra)
        self.assertEqual(r["months"][8]["status"], "paid")
        self.assertEqual(r["months"][8]["untagged"], 4200.0)
        self.assertEqual(r["months"][9]["status"], "paid")

    def test_another_customer_on_the_account_means_no_untagged_rent(self):
        # Audit guard (11/19/2026): a customer with no lease at the entity was
        # tagged on the same income account - the remainder may be theirs.
        l = self.unit1()
        extra = {("69002-1", "", "2026-09"): {"41101": 4200.0}, ("69002-1", "*payers"): {"C00730", "C09999"}}
        r = roll(l, {8: 4200}, extra)
        self.assertNotIn("untagged", r["months"][8])
        self.assertEqual(r["months"][8]["received"], 0)

    def test_unknown_payers_means_no_untagged_rent(self):
        l = self.unit1()
        r = roll(l, {8: 4200}, {("69002-1", "", "2026-09"): {"41101": 4200.0}})
        self.assertNotIn("untagged", r["months"][8])

    def test_customer_tagged_part_is_not_counted_twice(self):
        l = self.unit1()
        extra = {("69002-1", "", "2026-08"): {"41101": 4200.0}}     # the entity total = the tagged 4,200
        r = roll(l, {8: 4200}, extra)
        self.assertNotIn("untagged", r["months"][7])
        self.assertEqual(r["months"][7]["received"], 4200)

    def test_two_leases_in_force_share_nothing(self):
        a = self.unit1()
        b = {**self.unit1(), "id": "L2", "customerId": "C2"}
        extra = {("69002-1", "", "2026-09"): {"41101": 4200.0}}
        out = leasing.rent_roll([a, b], {}, extra, 2026, TODAY)["rows"]
        self.assertTrue(all("untagged" not in r["months"][8] for r in out))


def mline(**over):
    base = {"id": "M1", "entityCode": "61004", "entityName": "E", "vendorId": "V00994", "vendorName": "County Of Orange", "expenseAccounts": ["68000"],
            "category": "property_tax", "frequency": "monthly", "frequencyMonths": 0, "variancePct": 0, "expectedAmount": 500.0,
            "startDate": "2025-01-01", "endDate": "", "status": "active", "notes": "", "amountChanges": []}
    return {**base, **over}


def paid(pairs):
    return {("61004", "V00994"): {f"2026-{m:02d}": {"68000": v} for m, v in pairs.items()}}


class MreAmountChanges(unittest.TestCase):
    def test_clean_sorts_dedupes_and_drops_bad_rows(self):
        out = accounting_mre.clean_changes([{"from": "2026-07-01", "amount": 600}, {"from": "2026-03-01", "tenantPays": True},
                                            {"from": "bad", "amount": 1}, {"from": "2026-07-01", "amount": 650}, {"from": "2026-08-01", "amount": -5}])
        self.assertEqual(out, [{"from": "2026-03-01", "tenantPays": True}, {"from": "2026-07-01", "amount": 650.0}])

    def test_amount_change_applies_from_its_month(self):
        l = mline(amountChanges=[{"from": "2026-07-15", "amount": 650.0}])
        self.assertEqual(accounting_mre.amount_in(l, 2026, 6), (500.0, False))
        self.assertEqual(accounting_mre.amount_in(l, 2026, 7), (650.0, False))
        g = accounting_mre.grid([l], paid({m: 500.0 for m in range(1, 7)} | {m: 650.0 for m in range(7, 11)}), 2026, TODAY)["rows"][0]
        self.assertEqual([c["status"] for c in g["months"][:10]], ["paid"] * 10)
        self.assertEqual(g["months"][6]["expected"], 650.0)

    def test_paid_by_tenant_is_never_missed(self):
        l = mline(amountChanges=[{"from": "2026-03-01", "tenantPays": True}])
        g = accounting_mre.grid([l], paid({1: 500.0, 2: 500.0}), 2026, TODAY)["rows"][0]
        m = g["months"]
        self.assertEqual(m[1]["status"], "paid")
        self.assertTrue(m[5]["tenantPays"])
        self.assertEqual(m[5]["expected"], 0)
        self.assertNotIn("missed", [c["status"] for c in m])
        self.assertEqual(g["monthsMissed"], 0)

    def test_tenant_moves_out_brings_the_bill_back(self):
        l = mline(amountChanges=[{"from": "2026-03-01", "tenantPays": True}, {"from": "2026-09-01", "amount": 520.0}])
        g = accounting_mre.grid([l], paid({1: 500.0, 2: 500.0}), 2026, TODAY)["rows"][0]
        self.assertTrue(g["months"][6].get("tenantPays"))
        self.assertEqual(g["months"][8]["expected"], 520.0)
        self.assertEqual(g["months"][8]["status"], "missed")

    def test_annual_line_uses_the_amount_of_its_month(self):
        l = mline(frequency="annual", expectedAmount=1200.0, amountChanges=[{"from": "2026-01-01", "amount": 1300.0}])
        g = accounting_mre.grid([l], paid({6: 1300.0}), 2026, TODAY)["rows"][0]
        self.assertEqual(g["months"][5]["expected"], 1300.0)
        self.assertEqual(g["months"][5]["status"], "paid")

    def test_tenant_paid_line_is_not_judged_possibly_ended(self):
        l = mline(startDate="2024-01-01", amountChanges=[{"from": "2025-01-01", "tenantPays": True}])
        self.assertEqual(recurring_stale.mre_candidates([l], TODAY, 3), [])


if __name__ == "__main__":
    unittest.main()
