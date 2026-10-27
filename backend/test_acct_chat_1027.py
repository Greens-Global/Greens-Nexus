"""Accounting chat, 10/27 triage - items 02 and 11 (backend), 07's PFS date.

02 (Urmi): saving a new Possibly Ended months setting re-checks every line
   right away; the check records when it last ran; MRE reads the ledger with
   the grid's grouped read instead of one read per line.
11 (Charmi): an Annual MRE line is settled by one charge anywhere in the
   year, Semi-Annual anywhere in each half, Quarterly anywhere in each
   quarter; Upcoming until the period is over, Missed only after. MRI's
   periodic sources follow the same rule.
07 (Neil): a PFS line says when it was last saved.

Run on its own: python -m pytest test_acct_chat_1027.py
"""
import _testdb  # noqa: F401 - a throwaway database before `database` is imported

import asyncio
import json
import unittest
import uuid
from datetime import date

import database
import models
import recurring_stale
from routers import accounting_mre, leasing, pfs

models.Base.metadata.create_all(bind=database.engine)
TODAY = date(2026, 10, 27)


def mline(**over):
    base = {"id": "M1", "entityCode": "47000", "entityName": "E", "vendorId": "V04981", "vendorName": "Whitmore Tatala", "expenseAccounts": ["68000"],
            "category": "other", "frequency": "annual", "frequencyMonths": 0, "variancePct": 0, "expectedAmount": 1825.0,
            "startDate": "2025-01-01", "endDate": "", "status": "active", "notes": ""}
    return {**base, **over}


def paid(pairs, year=2026):
    """{(entity, vendor): {'YYYY-MM': {'68000': amount}}} from {month: amount}."""
    return {("47000", "V04981"): {f"{year}-{m:02d}": {"68000": v} for m, v in pairs.items()}}


def row(line, pay, year=2026, today=TODAY):
    return accounting_mre.grid([line], pay, year, today)["rows"][0]


def statuses(r):
    return [c["status"] for c in r["months"]]


class AnnualLine(unittest.TestCase):
    def test_whitmore_paid_in_august_has_no_missed_month(self):
        r = row(mline(), paid({8: 1905.0}))
        self.assertEqual(r["monthsMissed"], 0)
        self.assertEqual(statuses(r)[0], "none")              # January no longer Missed
        self.assertEqual(statuses(r)[7], "over")              # 1,905 against 1,825, no variance
        self.assertEqual([c["expected"] for c in r["months"]], [0, 0, 0, 0, 0, 0, 0, 1825.0, 0, 0, 0, 0])
        self.assertEqual(r["balance"], -80.0)
        self.assertEqual(r["months"][7]["period"], {"from": "2026-01", "to": "2026-12", "expected": 1825.0, "paid": 1905.0})

    def test_within_the_variance_it_reads_paid(self):
        r = row(mline(variancePct=5), paid({8: 1905.0}))
        self.assertEqual(statuses(r)[7], "paid")

    def test_before_any_charge_it_is_upcoming_not_missed(self):
        r = row(mline(), {})
        self.assertEqual(statuses(r)[0], "upcoming")
        self.assertEqual(r["months"][0]["expected"], 1825.0)
        self.assertEqual(r["monthsMissed"], 0)
        self.assertEqual(r["balance"], 0)

    def test_missed_only_once_the_year_is_over(self):
        r = row(mline(), {}, year=2025)
        self.assertEqual(statuses(r)[0], "missed")
        self.assertEqual(r["monthsMissed"], 1)
        self.assertEqual(r["balance"], 1825.0)

    def test_short_once_the_year_is_over_upcoming_until_then(self):
        self.assertEqual(statuses(row(mline(), paid({3: 1000.0})))[2], "upcoming")
        self.assertEqual(statuses(row(mline(), paid({3: 1000.0}, 2025), year=2025))[2], "short")

    def test_two_charges_in_the_year_add_up(self):
        r = row(mline(), paid({3: 900.0, 6: 925.0}))
        self.assertEqual([statuses(r)[2], statuses(r)[5]], ["paid", "paid"])
        self.assertEqual(r["months"][2]["expected"], 1825.0)
        self.assertEqual(r["months"][5]["expected"], 0)
        self.assertEqual(r["balance"], 0)

    def test_a_line_starting_mid_year_runs_from_its_start(self):
        r = row(mline(startDate="2026-08-01"), {})
        self.assertEqual(statuses(r)[:7], ["none"] * 7)
        self.assertEqual(statuses(r)[7], "upcoming")
        r = row(mline(startDate="2026-08-01"), paid({5: 300.0}))    # before the start: shown, not counted
        self.assertEqual(statuses(r)[4], "over")
        self.assertEqual(statuses(r)[7], "upcoming")


class SemiAnnualAndQuarterly(unittest.TestCase):
    def test_semi_annual_each_half(self):
        r = row(mline(frequency="semi_annual", expectedAmount=600.0), paid({4: 600.0}))
        self.assertEqual(statuses(r)[3], "paid")
        self.assertEqual(statuses(r)[0], "none")
        self.assertEqual(statuses(r)[6], "upcoming")          # the second half is still running
        r = row(mline(frequency="semi_annual", expectedAmount=600.0), paid({4: 600.0}, 2025), year=2025)
        self.assertEqual(statuses(r)[6], "missed")
        self.assertEqual(r["monthsMissed"], 1)

    def test_quarterly_each_quarter(self):
        r = row(mline(frequency="quarterly", expectedAmount=300.0, startDate="2025-02-01"), paid({3: 300.0, 9: 300.0}))
        st = statuses(r)
        self.assertEqual(st[2], "paid")                       # Q1, paid in March (due February)
        self.assertEqual(st[1], "none")
        self.assertEqual(st[4], "missed")                     # Q2 over, nothing: its due month (May)
        self.assertEqual(st[8], "paid")                       # Q3, paid in September
        self.assertEqual(st[10], "upcoming")                  # Q4 running
        self.assertEqual(r["monthsMissed"], 1)
        self.assertEqual(r["balance"], 300.0)


class OtherFrequenciesUnchanged(unittest.TestCase):
    def test_monthly(self):
        r = row(mline(frequency="monthly", expectedAmount=100.0), paid({m: 100.0 for m in range(1, 9)}))
        self.assertEqual(statuses(r)[:10], ["paid"] * 8 + ["missed", "upcoming"])

    def test_custom_keeps_its_due_months(self):
        r = row(mline(frequency="custom", frequencyMonths=12, expectedAmount=1825.0), paid({8: 1905.0}))
        self.assertEqual(statuses(r)[0], "missed")
        self.assertNotIn("period", r["months"][7])

    def test_unread_ledger_is_as_before(self):
        g = accounting_mre.grid([mline()], {}, 2026, TODAY, {("47000", "V04981")})["rows"][0]
        self.assertEqual(statuses(g)[0], "unknown")


def lease(**over):
    base = {"id": "L1", "customerId": "C1", "entityCode": "12014", "incomeAccounts": ["41101"], "leaseStart": "2025-01-01", "leaseEnd": "",
            "lateFee": 25.0, "dueDay": 1, "graceDays": 5, "status": "active", "propertyName": "P", "tenantName": "T", "frequency": "annual",
            "frequencyMonths": 0, "rates": [{"startDate": "2025-01-01", "rent": 1200.0, "cam": 0.0, "other": 0.0}]}
    return {**base, **over}


class MriPeriodic(unittest.TestCase):
    def roll(self, l, pay, year=2026):
        rec = {("12014", "C1", f"{year}-{m:02d}"): {"41101": v} for m, v in pay.items()}
        return leasing.rent_roll([l], {}, rec, year, TODAY)["rows"][0]

    def test_annual_due_month_is_upcoming_while_the_year_runs(self):
        r = self.roll(lease(), {})
        self.assertEqual(r["months"][0]["status"], "upcoming")
        self.assertEqual(r["monthsBehind"], 0)
        self.assertEqual(r["months"][0]["lateFee"], 0)

    def test_unpaid_once_the_year_is_over(self):
        r = self.roll(lease(), {}, year=2025)
        self.assertEqual(r["months"][0]["status"], "unpaid")
        self.assertEqual(r["monthsBehind"], 1)

    def test_a_payment_later_in_the_year_covers_the_due_month(self):
        r = self.roll(lease(), {8: 1200.0})
        self.assertEqual(r["months"][0]["status"], "covered")
        self.assertEqual(r["monthsBehind"], 0)

    def test_quarterly_past_quarter_with_nothing_is_unpaid(self):
        r = self.roll(lease(frequency="quarterly"), {1: 1200.0, 7: 1200.0})
        st = [c["status"] for c in r["months"]]
        self.assertEqual(st[3], "unpaid")                      # Q2 over, nothing received
        self.assertEqual(st[9], "upcoming")                    # Q4 (October) running

    def test_monthly_and_custom_unchanged(self):
        r = self.roll(lease(frequency="monthly"), {m: 1200.0 for m in range(1, 9)})
        self.assertEqual(r["months"][8]["status"], "unpaid")
        r = self.roll(lease(frequency="custom", frequencyMonths=12), {})
        self.assertEqual(r["months"][0]["status"], "unpaid")


class RecheckOnSave(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.orig = recurring_stale.check

        async def fake(today=None):
            self.calls.append(recurring_stale.load_settings()["staleMonths"])
            out = {"mre": {"checked": 1, "possiblyEnded": 0}}
            recurring_stale.save_last_check("2026-10-27T00:00:00+00:00", recurring_stale.load_settings()["staleMonths"], out)
            return out
        recurring_stale.check = fake
        accounting_mre._STALE_RUN.clear()

    def tearDown(self):
        recurring_stale.check = self.orig
        accounting_mre._STALE_RUN.clear()

    def put(self, **body):
        async def go():
            out = await accounting_mre.put_settings(accounting_mre.SettingsBody(**body), {"email": "admin@greensglobal.com"})
            task = accounting_mre._STALE_RUN.get("task")
            if task is not None:
                await task
            return out
        return asyncio.run(go())

    def test_a_new_number_of_months_rechecks_right_away(self):
        self.put(staleMonths=3)
        self.calls.clear()
        accounting_mre._STALE_RUN.clear()
        out = self.put(staleMonths=5)
        self.assertEqual(out["staleMonths"], 5)
        self.assertTrue(out["recheck"]["started"])
        self.assertTrue(out["recheck"]["since"])
        self.assertEqual(self.calls, [5])
        last = recurring_stale.load_last_check()
        self.assertEqual(last["months"], 5)
        self.assertTrue(last["at"])

    def test_the_same_number_or_only_the_folder_does_not(self):
        self.put(staleMonths=4)
        self.calls.clear()
        accounting_mre._STALE_RUN.clear()
        out = self.put(staleMonths=4, egnyteRoot="/Shared/Vendors")
        self.assertNotIn("recheck", out)
        self.assertEqual(self.calls, [])

    def test_a_save_during_a_running_check_queues_one_more_pass(self):
        async def go():
            gate = asyncio.Event()

            async def slow(today=None):
                self.calls.append(recurring_stale.load_settings()["staleMonths"])
                if len(self.calls) == 1:
                    await gate.wait()
                return {}
            recurring_stale.check = slow
            first = accounting_mre.start_stale_check()
            await asyncio.sleep(0)
            second = accounting_mre.start_stale_check()
            gate.set()
            await accounting_mre._STALE_RUN["task"]
            return first, second
        first, second = asyncio.run(go())
        self.assertTrue(first["started"])
        self.assertTrue(second["queued"])
        self.assertEqual(len(self.calls), 2)

    def test_settings_say_when_the_check_last_ran(self):
        recurring_stale.save_last_check("2026-10-27T01:00:00+00:00", 5, {"mri": {"possiblyEnded": 2}})
        got = asyncio.run(accounting_mre.get_settings())
        self.assertEqual(got["lastCheck"]["months"], 5)
        self.assertEqual(got["lastCheck"]["result"], {"mri": {"possiblyEnded": 2}})


class GroupedLedgerRead(unittest.TestCase):
    def test_mre_check_reads_once_per_year_not_once_per_line(self):
        db = database.SessionLocal()
        ids = []
        for v in ("VG1", "VG2"):
            ids.append(str(uuid.uuid4()))
            db.add(models.RecurringExpense(id=ids[-1], entity_code="GRP-E", vendor_id=v, vendor_name=v, expense_accounts=["62100"],
                                           expected_amount=50.0, start_date="2025-01-01", status="active", created_by="maker@greensglobal.com"))
        db.commit()
        db.close()
        years, single = [], []

        async def grouped(scope, pairs, year, accounts):
            years.append(year)
            return {p: ({"2026-09": {"62100": 50.0}} if p == ("GRP-E", "VG1") else {}) for p in pairs}, []

        async def one(*a, **k):
            single.append(a)
            return {}
        orig_g, orig_o = accounting_mre._grid_payments, accounting_mre._vendor_months
        accounting_mre._grid_payments, accounting_mre._vendor_months = grouped, one
        try:
            results = asyncio.run(recurring_stale._mre_results(TODAY, 3))
        finally:
            accounting_mre._grid_payments, accounting_mre._vendor_months = orig_g, orig_o
        by = {r["id"]: r for r in results}
        self.assertFalse(by[ids[0]]["stale"])
        self.assertTrue(by[ids[1]]["stale"])
        self.assertEqual(sorted(set(years)), [2025, 2026])
        self.assertEqual(single, [])

    def test_a_pair_the_grouped_read_misses_is_read_on_its_own(self):
        cands = [(mline(entityCode="GRP-X", vendorId="VX"), recurring_stale.window(TODAY, 3))]

        async def grouped(scope, pairs, year, accounts):
            return {}, list(pairs)
        orig = accounting_mre._grid_payments
        accounting_mre._grid_payments = grouped
        try:
            got, slow = asyncio.run(recurring_stale._mre_grouped(cands, TODAY))
        finally:
            accounting_mre._grid_payments = orig
        self.assertEqual(slow, {("GRP-X", "VX")})


class PfsLineDate(unittest.TestCase):
    def test_line_says_when_it_was_saved(self):
        l = models.PfsLine(id="x", profile_id="p", section="asset", category="cash", label="Checking", manual_value=10.0,
                           updated_at="2026-06-01T10:00:00+00:00", details={}, ledger_accounts=[])
        self.assertEqual(pfs._line_out(l)["updatedAt"], "2026-06-01T10:00:00+00:00")
        self.assertEqual(json.loads(json.dumps(pfs._line_out(models.PfsLine(id="y", details={}, ledger_accounts=[]))))["updatedAt"], "")


if __name__ == "__main__":
    unittest.main()
