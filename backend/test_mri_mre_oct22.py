"""MRI / MRE feedback of Oct 22 - as tests, data safety first.

The accounting team is entering MRI and MRE data on dev and prod while this
ships (Neil, Oct 22: "make sure any changes do not mess up the data"), so the
first tests prove that EXISTING rows compute exactly as before: the rent roll
of this version against the one on dev before Oct 22 (loaded from git), over
leases shaped like the ones on prod, with and without receipts.

Then: Semi-Annual / Custom frequency on MRI (off by default - '' stays
monthly), a payment covering several months settling the oldest open month
first (47385 RCR, May 7,025), the Possibly Ended check (one task per line,
never repeated, closed when money posts again, only stale_* written), the
MRE grid narrowed to one line (the in-place refresh), the Egnyte folder on a
line and the folder ranking.

    python -m pytest test_mri_mre_oct22.py -q
"""
import _testdb  # noqa: F401 - a throwaway database before `database` is imported

import asyncio
import copy
import importlib.util
import os
import random
import subprocess
import sys
import unittest
import uuid
from datetime import date

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database
import models
import recurring_stale
from routers import accounting_mre, leasing

models.Base.metadata.create_all(bind=database.engine)
HERE = os.path.dirname(os.path.abspath(__file__))


def _old_leasing():
    """routers/leasing.py as it was before this change (the merge base with
    origin/dev), imported under another name. None when git cannot give it."""
    for ref in ("origin/dev", "dev"):
        try:
            src = subprocess.run(["git", "show", f"{ref}:backend/routers/leasing.py"], cwd=HERE, capture_output=True, text=True, check=True, encoding="utf-8").stdout
        except Exception:  # noqa: BLE001
            continue
        if "lease_step" in src:      # the ref already carries this change
            return None
        spec = importlib.util.spec_from_loader("leasing_before_oct22", loader=None)
        mod = importlib.util.module_from_spec(spec)
        exec(compile(src, "leasing_before_oct22.py", "exec"), mod.__dict__)  # noqa: S102 - our own file from git
        sys.modules["leasing_before_oct22"] = mod
        return mod
    return None


OLD = _old_leasing()
TODAY = date(2026, 10, 22)


def lease(**over):
    base = {"id": "L1", "customerId": "C1", "entityCode": "12014", "incomeAccounts": ["41101"], "leaseStart": "2026-01-01", "leaseEnd": "",
            "lateFee": 0.0, "dueDay": 1, "graceDays": 5, "status": "active", "propertyName": "P", "tenantName": "T",
            "rates": [{"startDate": "2026-01-01", "rent": 3000.0, "cam": 0.0, "other": 0.0}]}
    return {**base, **over}


# Leases shaped like prod's on Oct 22 (read-only SELECT): 910 S. El Camino
# Real Ste 100 (in force since 2016), 47385 RCR (since 07/31/2025, 3,500), a
# lease starting 10/02 with a second rate, one ending 10/31, one starting 03/01.
PROD_SHAPED = [
    lease(id="ste100", customerId="C00300", entityCode="12027-1", leaseStart="2016-12-31", leaseEnd="2026-12-31", rates=[{"startDate": "2016-12-31", "rent": 11000.0, "cam": 0.0, "other": 0.0}]),
    lease(id="rcr", customerId="C00497", entityCode="12014", leaseStart="2025-07-31", rates=[{"startDate": "2025-07-31", "rent": 3500.0, "cam": 0.0, "other": 0.0}]),
    lease(id="ste203", customerId="C00465", entityCode="12027-6", leaseStart="2026-10-02", leaseEnd="2026-10-31",
          rates=[{"startDate": "2026-10-02", "rent": 1850.0, "cam": 425.0, "other": 0.0}, {"startDate": "2026-12-31", "rent": 1850.0, "cam": 425.0, "other": 0.0}]),
    lease(id="ste102", customerId="C00662", entityCode="12027-7", leaseStart="2025-11-01", leaseEnd="2026-10-31", lateFee=50.0,
          rates=[{"startDate": "2025-11-01", "rent": 625.0, "cam": 150.0, "other": 0.0}]),
    lease(id="ste101", customerId="C00725", entityCode="12027-2", leaseStart="2026-03-01", leaseEnd="2027-02-28",
          rates=[{"startDate": "2026-03-01", "rent": 1750.0, "cam": 250.0, "other": 0.0}]),
    lease(id="vacant", customerId="", status="vacant", rates=[]),
]


def receipts_for(leases, pay):
    """{(customer, 'YYYY-MM'): {'41101': amount}} from {lease id: {month: amount}}."""
    by = {l["id"]: l for l in leases}
    out = {}
    for lid, months in pay.items():
        for m, v in months.items():
            out[(by[lid]["customerId"], f"2026-{m:02d}")] = {"41101": v}
    return out


def strip_new(roll):
    """The rent roll without the keys this change adds (they only appear on overpaid rows)."""
    r = copy.deepcopy(roll)
    for row in r["rows"]:
        for c in row["months"]:
            for k in ("covered", "coveredBy", "applied", "appliedTo", "prepaid", "offCycle"):
                c.pop(k, None)
    return r


@unittest.skipIf(OLD is None, "git cannot give the version before this change")
class ExistingRowsComputeAsBefore(unittest.TestCase):
    """The data-safety proof: no lease saved before Oct 22 reads differently."""

    def same(self, leases, receipts, months=None):
        months = months or {}
        a = OLD.rent_roll(copy.deepcopy(leases), months, receipts, 2026, TODAY)
        b = leasing.rent_roll(copy.deepcopy(leases), months, receipts, 2026, TODAY)
        self.assertEqual(a, b)

    def test_prod_shaped_leases_paid_on_time(self):
        pay = {"ste100": {m: 11000.0 for m in range(1, 10)}, "rcr": {m: 3500.0 for m in range(1, 10)}, "ste102": {m: 775.0 for m in range(1, 11)},
               "ste101": {m: 2000.0 for m in range(3, 10)}}
        self.same(PROD_SHAPED, receipts_for(PROD_SHAPED, pay))

    def test_prod_shaped_leases_with_short_unpaid_and_nothing_read(self):
        pay = {"rcr": {1: 3500.0, 2: 1000.0, 4: 3500.0}, "ste101": {3: 2000.0, 5: 500.0}}
        self.same(PROD_SHAPED, receipts_for(PROD_SHAPED, pay))
        self.same(PROD_SHAPED, {})

    def test_deductions_and_notes(self):
        months = {"rcr:2026-03": {"adjustment": 500.0, "note": "AC repair"}, "ste100:2026-02": {"adjustment": 0, "note": "Paid by GG Inc"}}
        self.same(PROD_SHAPED, receipts_for(PROD_SHAPED, {"rcr": {3: 3000.0}}), months)

    def test_random_leases_without_an_overpaid_month(self):
        """Hundreds of random existing-shaped leases, receipts never above
        what a month expects: identical, key for key."""
        rnd = random.Random(22)
        for _ in range(300):
            start = f"20{rnd.choice(['24', '25', '26'])}-{rnd.randint(1, 12):02d}-{rnd.choice([1, 1, 15, 28]):02d}"
            end = rnd.choice(["", "", f"2026-{rnd.randint(1, 12):02d}-{rnd.randint(1, 28):02d}", "2027-06-30"])
            if end and end < start:
                end = ""
            rent = float(rnd.choice([625, 1500, 3500, 11000]))
            l = lease(id=str(uuid.uuid4()), leaseStart=start, leaseEnd=end, lateFee=rnd.choice([0.0, 50.0]),
                      rates=[{"startDate": start, "rent": rent, "cam": float(rnd.choice([0, 150])), "other": 0.0}])
            pay = {}
            for m in range(1, 11):
                exp = leasing.expected_for_month(l, 2026, m)
                if exp:
                    pay[(l["customerId"], f"2026-{m:02d}")] = {"41101": round(exp * rnd.choice([0, 0.5, 1, 1]), 2)}
            self.same([l], pay)

    def test_an_overpaid_month_changes_how_months_read_never_the_figures(self):
        rcr = [l for l in PROD_SHAPED if l["id"] == "rcr"]
        pay = receipts_for(rcr, {"rcr": {1: 3500.0, 2: 3500.0, 4: 3500.0, 5: 7025.0, 6: 3500.0, 7: 3500.0, 8: 3500.0, 9: 3500.0}})
        a = OLD.rent_roll(copy.deepcopy(rcr), {}, pay, 2026, TODAY)
        b = leasing.rent_roll(copy.deepcopy(rcr), {}, pay, 2026, TODAY)
        self.assertEqual(a["totals"], b["totals"])
        self.assertEqual(a["summary"]["balance"], b["summary"]["balance"])
        self.assertEqual(a["rows"][0]["balanceToDate"], b["rows"][0]["balanceToDate"])
        for ca, cb in zip(a["rows"][0]["months"], b["rows"][0]["months"]):
            for k in ("expected", "received", "balance", "byAccount"):
                self.assertEqual(ca.get(k), cb.get(k), (ca["month"], k))


class Prepayment(unittest.TestCase):
    """Oct 22 (Charmi): 47385 RCR paid 7,025 in May - "It was paid for 2 months"."""

    def roll(self, pay, **over):
        l = lease(id="rcr", leaseStart="2025-07-31", rates=[{"startDate": "2025-07-31", "rent": 3500.0, "cam": 0.0, "other": 0.0}], **over)
        return leasing.rent_roll([l], {}, receipts_for([l], pay), 2026, TODAY)["rows"][0]

    def test_the_excess_settles_the_oldest_open_month(self):
        row = self.roll({"rcr": {1: 3500.0, 2: 3500.0, 4: 3500.0, 5: 7025.0, 6: 3500.0, 7: 3500.0, 8: 3500.0, 9: 3500.0}})
        mar, may = row["months"][2], row["months"][4]
        self.assertEqual(mar["status"], "covered")
        self.assertEqual(mar["coveredBy"], ["2026-05"])
        self.assertEqual(mar["covered"], 3500.0)
        self.assertEqual(may["appliedTo"], ["2026-03", "2026-10"])   # the 25 left over goes to the next open month
        self.assertEqual(mar["received"], 0)           # what posted is never rewritten
        self.assertEqual(row["monthsBehind"], 1)       # October, past its grace
        self.assertEqual(row["months"][9]["covered"], 25.0)
        self.assertEqual(row["owed"], 3475.0)
        self.assertEqual(row["balanceToDate"], 3500 * 10 - (3500 * 7 + 7025))

    def test_a_part_settled_month_keeps_its_status_and_owes_the_rest(self):
        row = self.roll({"rcr": {1: 5000.0, 3: 3500.0}})       # 1,500 over in Jan, Feb unpaid
        feb = row["months"][1]
        self.assertEqual(feb["status"], "unpaid")
        self.assertEqual(feb["covered"], 1500.0)
        self.assertEqual(feb["balance"], 3500.0)
        owed = sum(c["balance"] - c.get("covered", 0) for c in row["months"] if c["status"] in ("late", "short", "unpaid"))
        self.assertEqual(row["owed"], round(owed, 2))

    def test_credit_left_over_prepays_the_months_ahead(self):
        row = self.roll({"rcr": {m: 3500.0 for m in range(1, 10)} | {10: 7000.0}})
        self.assertTrue(row["months"][10].get("prepaid"))
        self.assertEqual(row["months"][10]["status"], "upcoming")


class Frequency(unittest.TestCase):
    """Oct 22 (Priyanka): Semi-Annual (and Custom) in MRI like MRE."""

    def test_monthly_is_the_default_and_unchanged(self):
        for f in ("", "monthly", None):
            self.assertEqual(leasing.lease_step(lease(frequency=f)), 1)
            self.assertEqual(leasing.expected_for_month(lease(frequency=f), 2026, 3), 3000.0)

    def test_semi_annual_falls_due_every_six_months_from_the_start(self):
        l = lease(frequency="semi_annual", leaseStart="2025-07-15", rates=[{"startDate": "2025-07-15", "rent": 9000.0, "cam": 0.0, "other": 0.0}])
        got = [leasing.expected_for_month(l, 2026, m) for m in range(1, 13)]
        self.assertEqual(got, [9000.0, 0, 0, 0, 0, 0, 9000.0, 0, 0, 0, 0, 0])

    def test_custom_and_its_off_cycle_months(self):
        l = lease(frequency="custom", frequencyMonths=4)
        roll = leasing.rent_roll([l], {}, {("C1", "2026-05"): {"41101": 3000.0}}, 2026, TODAY)["rows"][0]
        self.assertEqual([c["expected"] for c in roll["months"][:6]], [3000.0, 0, 0, 0, 3000.0, 0])
        self.assertTrue(roll["months"][1].get("offCycle"))
        self.assertEqual(roll["months"][1]["status"], "none")
        self.assertEqual(roll["months"][4]["status"], "paid")
        self.assertEqual(roll["months"][0]["status"], "unpaid")

    def test_saved_monthly_is_stored_as_before(self):
        body = leasing.LeaseBody(propertyName="X", tenantName="T", frequency="monthly")
        self.assertEqual(leasing._clean(body)["frequency"], "")
        self.assertNotIn("frequency", leasing._clean(leasing.LeaseBody(propertyName="X", tenantName="T")))   # an older screen keeps what is saved
        self.assertEqual(leasing._clean(leasing.LeaseBody(propertyName="X", tenantName="T", frequency="semi_annual"))["frequency"], "semi_annual")
        with self.assertRaises(Exception):
            leasing._clean(leasing.LeaseBody(propertyName="X", tenantName="T", frequency="custom", frequencyMonths=0))


class StaleRule(unittest.TestCase):
    def test_window_is_at_least_one_cycle(self):
        self.assertEqual(recurring_stale.window(TODAY, 3), ["2026-07", "2026-08", "2026-09"])
        self.assertEqual(len(recurring_stale.window(TODAY, 3, 12)), 12)
        self.assertEqual(recurring_stale.window(date(2026, 2, 5), 3), ["2025-11", "2025-12", "2026-01"])

    def test_judge(self):
        win = ["2026-07", "2026-08", "2026-09"]
        back = recurring_stale.lookback(TODAY, win)
        self.assertEqual(recurring_stale.judge({"2026-05": 100.0}, win, back), (True, "2026-05"))
        self.assertEqual(recurring_stale.judge({"2026-08": 100.0}, win, back), (False, "2026-08"))
        self.assertEqual(recurring_stale.judge({}, win, back), (True, ""))

    def test_a_new_or_ended_line_is_not_a_candidate(self):
        leases = [lease(id="new", leaseStart="2026-09-01"), lease(id="old"), lease(id="ended", status="ended"), lease(id="nocode", customerId="")]
        self.assertEqual([l["id"] for l, _w in recurring_stale.mri_candidates(leases, TODAY, 3)], ["old"])


class StaleWrites(unittest.TestCase):
    """One task per line, never repeated, closed when money posts again; only stale_* written."""

    def setUp(self):
        db = database.SessionLocal()
        try:
            db.query(models.RecurringExpense).filter(models.RecurringExpense.entity_code == "STALE-T").delete()
            db.query(models.AccountingAmaSetting).filter(models.AccountingAmaSetting.entity_code == "STALE-T").delete()
            db.add(models.AccountingAmaSetting(entity_code="STALE-T", accounts=[], accountants=["acct.stale.test@greensglobal.com"]))
            self.id = str(uuid.uuid4())
            db.add(models.RecurringExpense(id=self.id, entity_code="STALE-T", vendor_id="V1", vendor_name="SDG&E", expense_accounts=["62100"],
                                           expected_amount=410.0, start_date="2025-01-01", status="active", created_by="maker@greensglobal.com",
                                           updated_by="maker@greensglobal.com", updated_at="2026-10-01"))
            db.commit()
        finally:
            db.close()

    def row(self):
        db = database.SessionLocal()
        try:
            r = db.query(models.RecurringExpense).filter(models.RecurringExpense.id == self.id).first()
            t = db.query(models.Task).filter(models.Task.id == r.stale_task_id).first() if r.stale_task_id else None
            db.expunge_all()
            return r, t
        finally:
            db.close()

    def result(self, stale):
        return [{"id": self.id, "stale": stale, "lastPaid": "2026-05" if stale else "2026-10", "entity": "STALE-T",
                 "window": ["2026-07", "2026-08", "2026-09"], "label": "SDG&E", "who": "STALE-T"}]

    def test_flag_one_task_never_repeated_closed_on_resume(self):
        before, _ = self.row()
        out = recurring_stale.apply("mre", self.result(True), TODAY, 3)
        self.assertEqual(len(out["opened"]), 1)
        r, t = self.row()
        self.assertEqual(r.stale_since, TODAY.isoformat())
        self.assertEqual(r.stale_last_paid, "2026-05")
        self.assertEqual(t.assignee_emails, ["acct.stale.test@greensglobal.com"])
        self.assertTrue(t.title.startswith("Possibly Ended: SDG&E"))
        # Only the stale_* columns moved.
        for k in ("status", "expected_amount", "end_date", "updated_by", "updated_at", "notes", "frequency"):
            self.assertEqual(getattr(r, k), getattr(before, k), k)
        # Again (tomorrow's run), and again after the task was completed: no second task.
        self.assertEqual(recurring_stale.apply("mre", self.result(True), TODAY, 3)["opened"], [])
        db = database.SessionLocal()
        db.query(models.Task).filter(models.Task.id == t.id).update({"completed": True, "status": "completed"})
        db.commit()
        db.close()
        self.assertEqual(recurring_stale.apply("mre", self.result(True), TODAY, 3)["opened"], [])
        # Money posts again: flag cleared, task closed, the id freed for a later lapse.
        db = database.SessionLocal()
        db.query(models.Task).filter(models.Task.id == t.id).update({"completed": False, "status": "not_started"})
        db.commit()
        db.close()
        recurring_stale.apply("mre", self.result(False), TODAY, 3)
        r2, _ = self.row()
        self.assertEqual((r2.stale_since, r2.stale_task_id), ("", ""))
        db = database.SessionLocal()
        self.assertTrue(db.query(models.Task).filter(models.Task.id == t.id).first().completed)
        db.close()

    def test_marked_ended_clears_the_flag_and_closes_the_task(self):
        recurring_stale.apply("mre", self.result(True), TODAY, 3)
        _, t = self.row()
        db = database.SessionLocal()
        db.query(models.RecurringExpense).filter(models.RecurringExpense.id == self.id).update({"status": "ended", "end_date": "2026-10-01"})
        db.commit()
        db.close()
        recurring_stale.apply("mre", [], TODAY, 3)
        r, _ = self.row()
        self.assertEqual(r.stale_since, "")
        db = database.SessionLocal()
        self.assertTrue(db.query(models.Task).filter(models.Task.id == t.id).first().completed)
        db.close()

    def test_a_read_that_failed_leaves_the_line_as_it_was(self):
        recurring_stale.apply("mre", self.result(True), TODAY, 3)
        recurring_stale.apply("mre", [], TODAY, 3)      # not in the results: the read failed
        r, _ = self.row()
        self.assertEqual(r.stale_since, TODAY.isoformat())

    def test_the_line_carries_the_flag(self):
        recurring_stale.apply("mre", self.result(True), TODAY, 3)
        out = [l for l in accounting_mre._load_all() if l["id"] == self.id][0]
        self.assertEqual(out["possiblyEnded"]["lastPaid"], "2026-05")
        self.assertEqual(out["egnyteFolder"], "")


class StaleCheckEndToEnd(unittest.TestCase):
    def test_check_reads_the_ledger_and_flags(self):
        db = database.SessionLocal()
        lid = str(uuid.uuid4())
        db.add(models.RecurringExpense(id=lid, entity_code="STALE-E2E", vendor_id="V9", vendor_name="Quiet Vendor", expense_accounts=["62100"],
                                       expected_amount=50.0, start_date="2025-01-01", status="active", created_by="maker@greensglobal.com"))
        db.commit()
        db.close()
        calls = []

        async def months(scope, entity, vendor, from_, to, codes=None):
            calls.append((entity, vendor, from_, to))
            return {"2026-04": {"62100": 50.0}} if vendor == "V9" else {"2026-09": {"62100": 1.0}}
        orig = accounting_mre._vendor_months
        accounting_mre._vendor_months = months
        try:
            results = asyncio.run(recurring_stale._mre_results(TODAY, 3))
        finally:
            accounting_mre._vendor_months = orig
        mine = [r for r in results if r["id"] == lid][0]
        self.assertTrue(mine["stale"])
        self.assertEqual(mine["lastPaid"], "2026-04")
        self.assertIn(("STALE-E2E", "V9", "2025-10-01", "2026-09-30"), calls)


class MreGridAndEgnyte(unittest.TestCase):
    def test_folder_ranking(self):
        rank = accounting_mre.rank_folders
        got = rank("San Diego Gas & Electric", [{"name": "SDGE", "path": "/Shared/Vendors/SDGE"},
                                                {"name": "San Diego Gas and Electric Co", "path": "/Shared/Vendors/San Diego Gas and Electric Co"},
                                                {"name": "Gas Station", "path": "/Shared/Vendors/Gas Station"}])
        self.assertEqual(got[0]["path"], "/Shared/Vendors/San Diego Gas and Electric Co")
        self.assertEqual(got[0]["score"], 1.0)
        self.assertEqual(rank("State Farm", [{"name": "State Farm Insurance", "path": "/Shared/V/State Farm Insurance"}])[0]["score"], 0.85)
        self.assertEqual(rank("Microsoft", [{"name": "Adobe", "path": "/Shared/V/Adobe"}]), [])

    def test_the_egnyte_folder_is_kept_only_when_sent(self):
        body = dict(entityCode="E", vendorId="V", expenseAccounts=["1"])
        self.assertNotIn("egnyte_folder", accounting_mre._clean(accounting_mre.LineBody(**body)))
        self.assertEqual(accounting_mre._clean(accounting_mre.LineBody(**body, egnyteFolder="/Shared/Vendors/SDGE/"))["egnyte_folder"], "/Shared/Vendors/SDGE")
        self.assertEqual(accounting_mre._clean(accounting_mre.LineBody(**body, egnyteFolder=""))["egnyte_folder"], "")
        with self.assertRaises(Exception):
            accounting_mre._clean(accounting_mre.LineBody(**body, egnyteFolder="C:/temp"))


if __name__ == "__main__":
    unittest.main()
