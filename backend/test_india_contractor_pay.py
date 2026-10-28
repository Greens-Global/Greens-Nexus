"""India Contractor Work Hours and Extra Time Policy (Neil, Oct 27 2026) -
golden tests with exact rupee amounts (docs/India-Contractor-Pay.md).

Daily rate Rs 2,700 throughout (monthly Rs 58,725 x 12 / 261 working days in
2026), so the hourly equivalent is Rs 300 and Extra Time pays Rs 405 an hour.
September 2026 has 22 weekdays; the test company's Policy Starts is set to
09/01/2026 so September is priced by the policy (the default, 11/01/2026,
keeps it on the old rules - tested too).

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_india_contractor_pay.py -q
"""
import json
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import india_contractor_pay as icp  # noqa: E402
import leave_balances  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import esign  # noqa: E402
from routers import extra_time as xt  # noqa: E402
from routers import timeclock as tc  # noqa: E402

CO, CO_US = "ent-icp-in", "ent-icp-us"
CON = "con.icp@greensglobal.com"        # in-scope India contractor
HRC = "hr.icp@greensglobal.com"         # CO's HR contact (no role)
OWNER = "owner.icp@greensglobal.com"    # a Global Admin
EMP_IN = "emp.icp@greensglobal.com"     # India, fixed pay, full time - out of scope
CON_US = "conus.icp@greensglobal.com"   # a US contractor on fixed pay - out of scope
SALARY = 58725.0                        # daily 2,700.00 exactly
DAILY = 2700.0
MS, ME = "2026-09-01", "2026-09-30"
SAT, SUN = "2026-09-05", "2026-09-06"
WEEKDAYS = [d for d in (f"2026-09-{i:02d}" for i in range(1, 31))
            if __import__("datetime").date.fromisoformat(d).weekday() < 5]
ABSENT, SHORT, LONG = "2026-09-03", "2026-09-17", "2026-09-08"
HR_USER = {"email": OWNER, "role": "owner", "level": 5}


def _punch(db, em, day, hours, start_h=4, i=0, category=""):
    """One in/out pair on `day` (UTC, tz offset 0, so the local date is `day`)."""
    db.add(models.TimePunch(id=f"{em}-{day}-{i}-in", employee_email=em, kind="in", at=f"{day}T{start_h:02d}:00:00",
                            local_date=day, tz_offset_min=0, voided=0, category=category,
                            created_at=f"{day}T{start_h:02d}:00:00"))
    end_min = int(round((start_h + hours) * 60))
    db.add(models.TimePunch(id=f"{em}-{day}-{i}-out", employee_email=em, kind="out",
                            at=f"{day}T{end_min // 60:02d}:{end_min % 60:02d}:00", local_date=day, tz_offset_min=0,
                            voided=0, created_at=f"{day}T{end_min // 60:02d}:{end_min % 60:02d}:00"))


def _worked_example(db, em):
    """The month Neil reviewed: 19 days at 9h, one at 10.5h, one absent, one
    at 3h; Saturday 5h; Sunday 3h."""
    for d in WEEKDAYS:
        if d == ABSENT:
            continue
        _punch(db, em, d, 10.5 if d == LONG else 3 if d == SHORT else 9)
    _punch(db, em, SAT, 5)
    _punch(db, em, SUN, 3)


def _claim(db, em, day, minutes, status="approved", approved=None):
    c = models.ExtraTimeClaim(id=f"xt-{em}-{day}", employee_email=em, company_id=CO, local_date=day,
                              period_start=MS, period_end=ME, claimed_min=minutes,
                              approved_min=minutes if approved is None else approved, note="Server migration",
                              status=status, history=[], created_at="2026-09-07T00:00:00", updated_at="")
    db.add(c)
    return c


def _days(days):
    """reconcile() input from (date, kind, state, workedMin[, approvedExtra[, covered]])."""
    out = []
    for t in days:
        d = {"date": t[0], "kind": t[1], "state": t[2], "workedMin": t[3], "dailyRate": DAILY}
        if len(t) > 4:
            d["approvedExtraMin"] = t[4]
        if len(t) > 5:
            d["coveredHalves"] = t[5]
        out.append(d)
    return out


# ── The arithmetic ───────────────────────────────────────────────────────────

class ReconcileTests(unittest.TestCase):
    def _example(self, sat_extra=300):
        rows = []
        for d in WEEKDAYS:
            w = 0 if d == ABSENT else 630 if d == LONG else 180 if d == SHORT else 540
            rows.append((d, "scheduled", "past", w))
        rows += [(SAT, "weekend", "past", 300, sat_extra), (SUN, "weekend", "past", 180)]
        return icp.reconcile(_days(sorted(rows)))

    def test_neils_worked_example(self):
        t = self._example()["totals"]
        self.assertEqual(t["scheduledDays"], 22)
        self.assertEqual(t["poolMin"], 450)                  # 1.5 + 0 + 3 + 3 = 7.5 h
        self.assertEqual(t["missingHalves"], 4)              # M = 2 days
        self.assertEqual(t["poolHalvesAvailable"], 1)        # floor(7.5 / 4.5)
        self.assertEqual(t["remainderMin"], 180)             # r = 3.0 h >= 1.5 h
        self.assertTrue(t["roundedUp"])
        self.assertEqual(t["recoveredHalves"], 2)            # 1.0 day recovered
        self.assertEqual(t["unpaidHalves"], 2)               # 1 unpaid day
        self.assertEqual(t["paidDays"], 21.0)
        self.assertEqual(t["deduction"], 2700.0)
        self.assertEqual(t["extraTimeMin"], 300)
        self.assertEqual(t["extraTimePay"], 2025.0)          # 5 x 300 x 1.35

    def test_recovery_goes_to_the_earliest_missing_day(self):
        days = {d["date"]: d for d in self._example()["days"]}
        self.assertEqual((days[ABSENT]["recoveredHalves"], days[ABSENT]["unpaidHalves"], days[ABSENT]["deduct"]),
                         (2, 0, 0.0))
        self.assertEqual((days[SHORT]["recoveredHalves"], days[SHORT]["unpaidHalves"], days[SHORT]["deduct"]),
                         (0, 2, 2700.0))
        self.assertEqual(days[SHORT]["poolMin"], 180)        # no credit: every hour to the pool
        self.assertEqual(days[LONG]["poolMin"], 90)          # full: only past 9 h
        self.assertEqual(days[SAT]["poolMin"], 0)            # approved Extra Time never counted twice

    def test_remainder_rounds_up_from_one_and_a_half_hours(self):
        def recovered(pool_min):
            rows = [("2026-09-01", "scheduled", "past", 0), ("2026-09-02", "scheduled", "past", 0),
                    ("2026-09-05", "weekend", "past", pool_min)]
            return icp.reconcile(_days(rows))["totals"]
        t = recovered(270 + 84)                              # 4.5 h + 1.4 h
        self.assertEqual((t["recoveredHalves"], t["roundedUp"], t["deduction"]), (1, False, 4050.0))
        t = recovered(270 + 90)                              # 4.5 h + 1.5 h
        self.assertEqual((t["recoveredHalves"], t["roundedUp"], t["deduction"]), (2, True, 2700.0))
        t = recovered(89)                                    # under 1.5 h: nothing
        self.assertEqual((t["recoveredHalves"], t["roundedUp"]), (0, False))
        t = recovered(90)                                    # exactly 1.5 h: one half day
        self.assertEqual((t["recoveredHalves"], t["roundedUp"]), (1, True))

    def test_a_pool_bigger_than_needed_stops_at_full_credit(self):
        rows = [("2026-09-01", "scheduled", "past", 0), ("2026-09-02", "scheduled", "past", 540),
                ("2026-09-05", "weekend", "past", 3000)]
        t = icp.reconcile(_days(rows))["totals"]
        self.assertEqual((t["recoveredHalves"], t["unpaidHalves"], t["deduction"]), (2, 0, 0.0))
        self.assertEqual(t["paidDays"], 2.0)                 # never more than the scheduled days
        self.assertEqual(t["poolUnusedMin"], 3000 - 540)     # the rest earns nothing
        self.assertFalse(t["roundedUp"])

    def test_daily_credit_bands(self):
        self.assertEqual([icp.work_halves(m) for m in (0, 239, 240, 479, 480, 540, 700)], [0, 0, 1, 1, 2, 2, 2])
        rows = [("2026-09-01", "scheduled", "past", 300), ("2026-09-02", "scheduled", "past", 470)]
        d = icp.reconcile(_days(rows))["days"]
        self.assertEqual([(x["credit"], x["poolMin"]) for x in d], [("half", 60), ("half", 230)])

    def test_claimable_hours(self):
        self.assertEqual(icp.claimable_min("scheduled", "past", 630), 90)     # only past 9 h on a weekday
        self.assertEqual(icp.claimable_min("scheduled", "past", 540), 0)
        self.assertEqual(icp.claimable_min("weekend", "past", 300), 300)      # every hour on a weekend
        self.assertEqual(icp.claimable_min("holiday", "past", 200), 200)
        self.assertEqual(icp.claimable_min("half_holiday", "past", 360), 90)  # past 4.5 h on a half holiday
        self.assertEqual(icp.claimable_min("weekend", "future", 300), 0)

    def test_approved_hours_beyond_the_day_are_never_paid(self):
        rows = [("2026-09-01", "scheduled", "past", 630, 300)]   # 5 h approved, only 1.5 h past 9 h
        t = icp.reconcile(_days(rows))["totals"]
        self.assertEqual((t["extraTimeMin"], t["extraTimePay"], t["poolMin"]), (90, 607.5, 0))

    def test_half_day_holiday(self):
        rows = [("2026-09-01", "half_holiday", "past", 360), ("2026-09-02", "half_holiday", "past", 0)]
        d = icp.reconcile(_days(rows))["days"]
        self.assertEqual((d[0]["credit"], d[0]["poolMin"], d[0]["missingHalves"]), ("full", 90, 0))
        self.assertEqual((d[1]["credit"], d[1]["missingHalves"]), ("half", 1))

    def test_today_and_later_never_deduct(self):
        rows = [("2026-09-01", "scheduled", "today", 120), ("2026-09-02", "scheduled", "future", 0)]
        t = icp.reconcile(_days(rows))["totals"]
        self.assertEqual((t["missingHalves"], t["upcomingDays"], t["deduction"], t["poolMin"]), (0, 2, 0.0, 0))

    def test_paid_leave_fills_the_missing_halves(self):
        rows = [("2026-09-01", "scheduled", "past", 0, 0, 2), ("2026-09-02", "scheduled", "past", 300, 0, 1),
                ("2026-09-03", "scheduled", "past", 0, 0, 1)]
        d = icp.reconcile(_days(rows))["days"]
        self.assertEqual([(x["credit"], x["leaveHalves"], x["missingHalves"]) for x in d],
                         [("full", 2, 0), ("full", 1, 0), ("half", 1, 1)])


    def test_pool_reads_the_final_credit(self):
        # 3 h + 2 leave halves: full, pool 0; 300 min + 1 leave half: full,
        # pool 0; 180 min + 1 half: half, pool 0; 300 min, no leave: half, 60.
        rows = [("2026-09-01", "scheduled", "past", 180, 0, 2), ("2026-09-02", "scheduled", "past", 300, 0, 1),
                ("2026-09-03", "scheduled", "past", 180, 0, 1), ("2026-09-04", "scheduled", "past", 300)]
        d = icp.reconcile(_days(rows))["days"]
        self.assertEqual([(x["credit"], x["poolMin"]) for x in d],
                         [("full", 0), ("full", 0), ("half", 0), ("half", 60)])

# ── The card ──────────────────────────────────────────────────────────────────

class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        auth.invalidate_role_cache()
        db = self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.HrEntity, models.NexusRole, models.TimePunch, models.PayrollRate,
                  models.PayrollRateHistory, models.TimeApproval, models.ExtraTimeClaim, models.NexusNotification,
                  models.HrCompanyHoliday, models.NexusSetting, models.LeaveLedgerEntry, models.TimesheetReview,
                  models.ContractorInvoice, models.HrSignParty, models.HrSignRequest, models.HrSignConsent,
                  models.HrSignDocument, models.HrSignSeal, models.HrSignOtpChallenge, models.TimecardBonus,
                  models.SalaryAdvance, models.SalaryAdvanceInstallment):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=CO, name="Greens India", legal_name="Greens India Private Limited", country="IN",
                               hr_contact_email=HRC, invoice_recipients=["ap@greensglobal.com"]))
        db.add(models.HrEntity(id=CO_US, name="Greens US", country="US"))
        people = ((CON, "Priya", CO, "IN", "contractor"), (HRC, "Hema", CO, "IN", "full_time"),
                  (OWNER, "Ojas", CO, "IN", "full_time"), (EMP_IN, "Ira", CO, "IN", "full_time"),
                  (CON_US, "Sam", CO_US, "US", "contractor"))
        for em, first, co, country, kind in people:
            db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                        company=co, country=country, status="active", employment_type=kind,
                                        manager_email="" if em != CON else HRC, deleted_at=""))
        db.add(models.NexusRole(email=OWNER, role="owner", assigned_by="test"))
        for em, cur in ((CON, "INR"), (EMP_IN, "INR"), (CON_US, "USD")):
            db.add(models.PayrollRate(employee_email=em, pay_type="fixed", currency=cur, monthly_salary=SALARY,
                                      full_day_hours=9, overtime_rule="none"))
        # Policy Starts 09/01/2026 for the India company, so September is in scope.
        db.add(models.NexusSetting(key=f"{icp.SETTING_KEY}:{CO}", value=json.dumps({"mode": "", "startDate": MS})))
        db.commit()
        os.environ["NEXUS_DEV_EMAIL"] = OWNER

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()
        self.db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache()

    def card(self, em=CON):
        self.db.expire_all()
        return tc._fixed_card(self.db, em, MS)

    def day(self, card, ds):
        return next(d for d in card["fixedDays"] if d["date"] == ds)


class CardTests(Base):
    def test_neils_month_in_rupees(self):
        _worked_example(self.db, CON)
        _claim(self.db, CON, SAT, 300)
        self.db.commit()
        c = self.card()
        t, ip = c["totals"], c["indiaPolicy"]
        self.assertEqual(c["dailyRate"], DAILY)
        self.assertEqual(ip["extraTime"], {"multiplier": 1.35, "hoursPerDay": 9, "hourlyEquivalent": 300.0,
                                           "rate": 405.0})
        self.assertEqual(ip["version"], icp.POLICY_VERSION)
        self.assertEqual((t["salaryForPeriod"], t["deduction"], t["extraTimePay"], t["weekendBonus"], t["totalPay"]),
                         (58725.0, 2700.0, 2025.0, 0.0, 58050.0))
        r = ip["reconciliation"]
        self.assertEqual((r["scheduledDays"], r["poolMin"], r["missingHalves"], r["recoveredHalves"],
                          r["unpaidHalves"], r["roundedUp"]), (22, 450, 4, 2, 2, True))
        self.assertEqual((t["missedFullDays"], t["missedHalfDays"]), (1, 0))
        self.assertEqual([(m["reason"], m["full"]) for m in t["missedReasons"]], [("absent", 1)])
        a, s, sat = self.day(c, ABSENT), self.day(c, SHORT), self.day(c, SAT)
        self.assertEqual((a["status"], a["credit"], a["recoveredHalves"], a["deduct"]), ("absent", "none", 2, 0.0))
        self.assertEqual((s["status"], s["poolMin"], s["unpaidHalves"], s["deduct"]), ("absent", 180, 2, 2700.0))
        self.assertEqual((sat["bonus"], sat["extraMin"], sat["extraPay"], sat["poolMin"]), (0.0, 300, 2025.0, 0))
        self.assertEqual(sat["claim"]["status"], "approved")
        self.assertEqual(self.day(c, LONG)["claimableMin"], 90)

    def test_reconciliation_extra_time_and_an_advance_repayment_together(self):
        # The release combines the policy (#821) with salary advances (#812):
        # the month is priced by the reconciliation and Extra Time first, then
        # the advance's installment comes off what is paid - on the card, in
        # the finalize snapshot and on the contractor invoice.
        _worked_example(self.db, CON)
        _claim(self.db, CON, SAT, 300)
        self.db.add(models.SalaryAdvance(id="adv-1", employee_email=CON, employee_name="Priya Test", company=CO,
                                         amount=10000.0, currency="INR", installments=2, status="paid_out",
                                         paid_on="2026-08-20", created_at="2026-08-18T00:00:00"))
        for seq, day in ((1, MS), (2, "2026-10-01")):
            self.db.add(models.SalaryAdvanceInstallment(id=f"inst-{seq}", advance_id="adv-1", employee_email=CON,
                                                        seq=seq, amount=5000.0, currency="INR", date=day,
                                                        status="scheduled", created_at="2026-08-20T00:00:00"))
        self.db.commit()
        self.db.info.pop("_advance_emails", None)
        t = self.card()["totals"]
        self.assertEqual((t["deduction"], t["extraTimePay"], t["totalPay"]), (2700.0, 2025.0, 58050.0))
        self.assertEqual((t["advanceRepayment"], t["netPay"]), (5000.0, 53050.0))
        tc.finalize_timecard(tc.FinalizeIn(email=CON, start=MS, end=ME, allow_exceptions=True), user=HR_USER,
                             db=self.db)
        self.db.expire_all()
        snap = json.loads(self.db.query(models.TimeApproval).filter_by(employee_email=CON, kind="final").one().note)
        self.assertEqual(snap["totalPay"], 58050.0)
        self.assertEqual(snap["indiaPolicy"]["reconciliation"]["unpaidHalves"], 2)
        self.assertEqual(self.db.get(models.SalaryAdvanceInstallment, "inst-1").status, "deducted")
        self.assertEqual(self.db.get(models.SalaryAdvanceInstallment, "inst-2").status, "scheduled")
        inv = self.db.query(models.ContractorInvoice).filter_by(employee_email=CON).one()
        self.assertEqual(inv.amount, 53050.0)                    # the month less the repayment
        self.assertEqual([(ln["description"].split(":")[0], ln["amount"]) for ln in inv.snapshot["lines"]],
                         [("Monthly fee for September 2026", 58725.0), ("Less 1 unpaid day", -2700.0),
                          ("Extra Time", 2025.0)])
        self.assertEqual(inv.snapshot["deductions"], [{"description": "Salary Advance Repayment", "amount": 5000.0}])
        from routers import contractor_invoices as ci
        from pypdf import PdfReader
        import io
        text = " ".join(pg.extract_text() for pg in PdfReader(io.BytesIO(ci.render_pdf(inv.snapshot))).pages)
        for words in ("Less 1 unpaid day", "Extra Time", "Salary Advance Repayment"):
            self.assertIn(words, text)

    def test_allow_exceptions_never_finalizes_over_a_pending_claim(self):
        # Release review, Oct 27 2026: Allow Exceptions overrides punch
        # exceptions only - a pending Extra Time claim still blocks finalize.
        _worked_example(self.db, CON)
        _claim(self.db, CON, SAT, 300, status="pending", approved=0)
        self.db.commit()
        for allow in (False, True):
            with self.assertRaises(HTTPException) as e:
                tc.finalize_timecard(tc.FinalizeIn(email=CON, start=MS, end=ME, allow_exceptions=allow),
                                     user=HR_USER, db=self.db)
            self.assertEqual(e.exception.status_code, 409)
            self.assertIn("Extra Time claim", e.exception.detail)
        self.assertIsNone(self.db.query(models.TimeApproval).filter_by(employee_email=CON, kind="final").first())

    def test_declined_or_unclaimed_hours_go_to_the_pool(self):
        _worked_example(self.db, CON)
        _claim(self.db, CON, SAT, 300, status="declined", approved=0)
        self.db.commit()
        c = self.card()
        r = c["indiaPolicy"]["reconciliation"]
        # 7.5 h + 5 h = 12.5 h: two whole blocks, 3.5 h left rounds up -> 3 of 4 halves back.
        self.assertEqual((r["poolMin"], r["recoveredHalves"], r["unpaidHalves"], r["extraTimePay"]),
                         (750, 3, 1, 0.0))
        self.assertEqual((c["totals"]["deduction"], c["totals"]["totalPay"]), (1350.0, 57375.0))

    def test_full_holiday_is_credited_without_hours_and_its_hours_pool(self):
        for d in WEEKDAYS:
            if d not in ("2026-09-15", ABSENT):
                _punch(self.db, CON, d, 9)
        self.db.add(models.HrCompanyHoliday(id="h1", company_id=CO, date="2026-09-15", name="Founders Day",
                                            source="manual", type="mandatory"))
        self.db.commit()
        c = self.card()
        r = c["indiaPolicy"]["reconciliation"]
        self.assertEqual((r["scheduledDays"], r["missingHalves"], r["poolMin"]), (21, 2, 0))
        self.assertEqual(self.day(c, "2026-09-15")["status"], "holiday")
        self.assertEqual(c["totals"]["deduction"], 2700.0)
        # 4 h worked on the holiday: pool, under one block but past 1.5 h -> a half day back.
        _punch(self.db, CON, "2026-09-15", 4)
        self.db.commit()
        c = self.card()
        self.assertEqual(self.day(c, "2026-09-15")["status"], "holiday_worked")
        self.assertEqual(self.day(c, "2026-09-15")["claimableMin"], 240)
        self.assertEqual((c["indiaPolicy"]["reconciliation"]["recoveredHalves"], c["totals"]["deduction"]),
                         (1, 1350.0))

    def test_half_day_holiday_pool_threshold(self):
        for d in WEEKDAYS:
            if d not in ("2026-09-15", ABSENT):
                _punch(self.db, CON, d, 9)
        self.db.add(models.HrCompanyHoliday(id="h2", company_id=CO, date="2026-09-15", name="Half Day",
                                            source="manual", type="half_day"))
        _punch(self.db, CON, "2026-09-15", 6)                 # 1.5 h past 4.5 h
        self.db.commit()
        c = self.card()
        hd = self.day(c, "2026-09-15")
        self.assertEqual((hd["credit"], hd["poolMin"], hd["claimableMin"]), ("full", 90, 90))
        self.assertEqual((c["indiaPolicy"]["reconciliation"]["recoveredHalves"], c["totals"]["deduction"]),
                         (1, 1350.0))
        self.db.query(models.TimePunch).filter(models.TimePunch.local_date == "2026-09-15").delete()
        _punch(self.db, CON, "2026-09-15", 4)                 # under 4.5 h: nothing to the pool
        self.db.commit()
        c = self.card()
        self.assertEqual((self.day(c, "2026-09-15")["poolMin"], c["totals"]["deduction"]), (0, 2700.0))

    def test_paid_leave_with_and_without_balance(self):
        for d in WEEKDAYS:
            if d not in ("2026-09-09", "2026-09-10", "2026-09-11"):
                _punch(self.db, CON, d, 9)
        _punch(self.db, CON, "2026-09-09", 8, category="Vacation")   # covered by the one day of balance
        _punch(self.db, CON, "2026-09-10", 8, category="Vacation")   # balance used up: a missing day
        _punch(self.db, CON, "2026-09-11", 8, category="Personal")   # Personal is unpaid: a missing day
        leave_balances.set_cutover(self.db, "2026-08-01", "test", CO)
        self.db.commit()
        leave_balances.set_opening(self.db, CON, 8.0, 0.0, "test")  # one India day (8 h) of vacation
        self.db.commit()
        c = self.card()
        v1, v2, p = self.day(c, "2026-09-09"), self.day(c, "2026-09-10"), self.day(c, "2026-09-11")
        self.assertEqual((v1["leaveCovered"], v1["credit"], v1["deduct"], v1["leaveUsedMin"]), (True, "full", 0.0, 480))
        self.assertEqual((v2["leaveCovered"], v2["credit"], v2["deduct"]), (False, "none", 2700.0))
        self.assertEqual((p["leaveCovered"], p["credit"], p["deduct"]), (False, "none", 2700.0))
        self.assertEqual(c["totals"]["deduction"], 5400.0)
        # Finalize: only the covered day uses balance (8 h), never the uncovered or Personal days.
        tc.finalize_timecard(tc.FinalizeIn(email=CON, start=MS, end=ME, allow_exceptions=True), user=HR_USER,
                             db=self.db)
        used = [(e.bucket, round(e.hours, 2)) for e in self.db.query(models.LeaveLedgerEntry)
                .filter(models.LeaveLedgerEntry.employee_email == CON, models.LeaveLedgerEntry.kind == "used").all()]
        self.assertEqual(used, [("vacation", -8.0)])
        # Finalized: the balance is now 0, but the month keeps the covered day.
        c = self.card()
        self.assertEqual((self.day(c, "2026-09-09")["deduct"], c["totals"]["deduction"]), (0.0, 5400.0))

    def _request(self, rid, kind, start, end=None, start_time="", end_time=""):
        self.db.add(models.TimeOffRequest(id=rid, employee_email=CON, type=kind, start_date=start,
                                          end_date=end or start, start_time=start_time, end_time=end_time,
                                          status="approved", created_at="2026-09-01T00:00:00"))

    def test_approved_requests_are_paid_leave_from_their_own_bucket(self):
        # Neil, Oct 27 2026: an approved Vacation / Sick request is paid leave
        # with no leave punch - Vacation from the vacation balance, Sick from
        # the sick balance, never borrowing. India: 8 h a day, 4 h a half.
        self.db.query(models.TimeOffRequest).delete()
        special = ("2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16")
        for d in WEEKDAYS:
            if d not in special:
                _punch(self.db, CON, d, 9)
        self._request("r-vac", "vacation", "2026-09-09")               # covered from vacation
        self._request("r-sick", "sick", "2026-09-10")                  # covered from sick
        self._request("r-sick2", "sick", "2026-09-11")                 # sick used up: stays missing
        _punch(self.db, CON, "2026-09-14", 4)                          # 4 h worked ...
        self._request("r-part", "vacation", "2026-09-14", start_time="13:00", end_time="17:00")   # ... + 4 h off
        _punch(self.db, CON, "2026-09-15", 8, category="Vacation")     # a punch AND a request: counted once
        self._request("r-both", "vacation", "2026-09-15")
        self._request("r-pers", "personal", "2026-09-16")              # Personal is unpaid
        leave_balances.set_cutover(self.db, "2026-08-01", "test", CO)
        self.db.commit()
        leave_balances.set_opening(self.db, CON, 16.0, 8.0, "test")   # 2 days vacation, 1 day sick
        self.db.commit()
        c = self.card()
        v, s, s2 = self.day(c, "2026-09-09"), self.day(c, "2026-09-10"), self.day(c, "2026-09-11")
        part, both, pers = self.day(c, "2026-09-14"), self.day(c, "2026-09-15"), self.day(c, "2026-09-16")
        self.assertEqual((v["credit"], v["deduct"], v["leaveBucket"], v["leaveUsedMin"], v["leaveFromRequest"]),
                         ("full", 0.0, "vacation", 480, True))
        self.assertEqual((s["credit"], s["deduct"], s["leaveBucket"], s["leaveUsedMin"]), ("full", 0.0, "sick", 480))
        # Sick has nothing left; the vacation still there is never borrowed.
        self.assertEqual((s2["credit"], s2["deduct"], s2.get("leaveUsedMin", 0)), ("none", 2700.0, 0))
        # 4 h worked + a 4 h request = a full day, half of it from vacation.
        self.assertEqual((part["credit"], part["deduct"], part["leaveUsedMin"]), ("full", 0.0, 240))
        # The punched day uses what vacation has left (one half), and the
        # request on the same day adds nothing.
        self.assertEqual((both["leaveUsedMin"], both["deduct"], both["leaveFromRequest"]), (240, 1350.0, False))
        self.assertEqual((pers["credit"], pers["deduct"]), ("none", 2700.0))
        self.assertEqual(c["totals"]["deduction"], 2700.0 + 1350.0 + 2700.0)
        # Finalize records what each bucket actually paid: vacation 8 + 4 + 4 h, sick 8 h.
        tc.finalize_timecard(tc.FinalizeIn(email=CON, start=MS, end=ME, allow_exceptions=True), user=HR_USER,
                             db=self.db)
        used = sorted((e.bucket, round(e.hours, 2)) for e in self.db.query(models.LeaveLedgerEntry)
                      .filter(models.LeaveLedgerEntry.employee_email == CON, models.LeaveLedgerEntry.kind == "used").all())
        self.assertEqual(used, [("sick", -8.0), ("vacation", -16.0)])

    def test_a_day_paid_by_leave_never_also_feeds_the_pool(self):
        # Release review, Oct 27 2026: the pool reads the day's FINAL credit
        # (hours + paid leave), so hours the leave covered are not pooled too.
        self.db.query(models.TimeOffRequest).delete()
        special = ("2026-09-09", "2026-09-10", "2026-09-11")
        for d in WEEKDAYS:
            if d not in special:
                _punch(self.db, CON, d, 9)
        _punch(self.db, CON, "2026-09-09", 3)                          # 3 h + a full-day vacation
        self._request("r-full", "vacation", "2026-09-09")
        _punch(self.db, CON, "2026-09-10", 7)                          # 7 h + a 2 h part-day request
        self._request("r-part", "vacation", "2026-09-10", start_time="15:00", end_time="17:00")
        _punch(self.db, CON, "2026-09-11", 7)                          # 7 h + a 1 h Sick punch
        _punch(self.db, CON, "2026-09-11", 1, start_h=12, i=1, category="Sick")
        leave_balances.set_cutover(self.db, "2026-08-01", "test", CO)
        self.db.commit()
        leave_balances.set_opening(self.db, CON, 40.0, 40.0, "test")
        self.db.commit()
        c = self.card()
        for ds in special:
            d = self.day(c, ds)
            self.assertEqual((ds, d["credit"], d["poolMin"], d["deduct"]), (ds, "full", 0, 0.0))
        self.assertEqual(c["indiaPolicy"]["reconciliation"]["poolMin"], 0)

    def test_request_types_map_to_their_balance_bucket(self):
        self.assertEqual([icp.request_class(t) for t in ("PTO", "Annual Leave", "Vacation", "Sick Day", "sick",
                                                          "Medical", "Personal", "unpaid", "other")],
                         ["vacation", "vacation", "vacation", "sick", "sick", "sick", "", "", ""])
        self.db.query(models.TimeOffRequest).delete()
        for d in WEEKDAYS:
            if d != "2026-09-09":
                _punch(self.db, CON, d, 9)
        self._request("r-pto", "PTO", "2026-09-09")
        leave_balances.set_cutover(self.db, "2026-08-01", "test", CO)
        self.db.commit()
        leave_balances.set_opening(self.db, CON, 8.0, 0.0, "test")
        self.db.commit()
        d = self.day(self.card(), "2026-09-09")
        self.assertEqual((d["credit"], d["deduct"], d["leaveBucket"]), ("full", 0.0, "vacation"))

    def test_requests_change_nothing_outside_the_policy(self):
        # Out of scope (a full-time India employee): requests are not paid leave here.
        self.db.query(models.TimeOffRequest).delete()
        self.db.add(models.TimeOffRequest(id="r-out", employee_email=EMP_IN, type="vacation", start_date="2026-09-09",
                                          end_date="2026-09-09", status="approved", created_at="2026-09-01T00:00:00"))
        self.db.commit()
        c = self.card(EMP_IN)
        self.assertNotIn("indiaPolicy", c)
        self.assertGreater(c["totals"]["deduction"], 0)

    def test_mid_month_raise_prices_each_unpaid_day_at_its_own_rate(self):
        _worked_example(self.db, CON)
        _claim(self.db, CON, SAT, 300)
        self.db.add(models.PayrollRateHistory(id="rh1", employee_email=CON, effective_date="", pay_type="fixed",
                                              monthly_salary=SALARY, currency="INR"))
        self.db.add(models.PayrollRateHistory(id="rh2", employee_email=CON, effective_date="2026-09-16",
                                              pay_type="fixed", monthly_salary=SALARY * 2, currency="INR"))
        self.db.commit()
        c = self.card()
        t = c["totals"]
        # Sep 3 (Rs 2,700 a day) is recovered first; Sep 17 stays unpaid at the raised Rs 5,400.
        self.assertEqual(self.day(c, SHORT)["deduct"], 5400.0)
        self.assertEqual(self.day(c, ABSENT)["deduct"], 0.0)
        self.assertEqual((t["salaryForPeriod"], t["deduction"], t["extraTimePay"]), (88087.5, 5400.0, 2025.0))
        self.assertEqual(t["totalPay"], round(88087.5 - 5400 + 2025, 2))

    def test_before_policy_starts_keeps_the_old_rules(self):
        self.db.query(models.NexusSetting).delete()            # the default: 11/01/2026
        _worked_example(self.db, CON)
        self.db.commit()
        c = self.card()
        self.assertNotIn("indiaPolicy", c)
        self.assertNotIn("extraTimePay", c["totals"])
        t = c["totals"]
        # Old rules: two absent days at 2,700; weekend pay 1.35 x 2,700 x h / 9 (5 h and 3 h).
        self.assertEqual((t["deduction"], t["weekendBonus"], t["totalPay"]), (5400.0, 3240.0, 56565.0))
        self.assertEqual(icp.config(self.db, CO)["startDate"], "2026-11-01")

    def test_out_of_scope_cards_are_unchanged(self):
        for em in (EMP_IN, CON_US):
            _worked_example(self.db, em)
        self.db.commit()
        for em in (EMP_IN, CON_US):
            c = self.card(em)
            self.assertNotIn("indiaPolicy", c, em)
            self.assertEqual((c["totals"]["deduction"], c["totals"]["weekendBonus"], c["totals"]["totalPay"]),
                             (5400.0, 3240.0, 56565.0), em)
            self.assertNotIn("credit", self.day(c, ABSENT))
        # The switch off for the India company: old rules for its contractor too.
        self.db.query(models.NexusSetting).delete()
        self.db.add(models.NexusSetting(key=f"{icp.SETTING_KEY}:{CO}", value=json.dumps({"mode": "off", "startDate": MS})))
        _worked_example(self.db, CON)
        self.db.commit()
        c = self.card()
        self.assertNotIn("indiaPolicy", c)
        self.assertEqual(c["totals"]["totalPay"], 56565.0)

    def test_finalized_month_never_reprices(self):
        _worked_example(self.db, CON)
        _claim(self.db, CON, SAT, 300)
        self.db.commit()
        tc.finalize_timecard(tc.FinalizeIn(email=CON, start=MS, end=ME, allow_exceptions=True), user=HR_USER,
                             db=self.db)
        snap = json.loads(self.db.query(models.TimeApproval).filter_by(employee_email=CON, kind="final").one().note)
        self.assertEqual(snap["indiaPolicy"]["version"], icp.POLICY_VERSION)
        self.assertEqual(snap["indiaPolicy"]["reconciliation"]["recoveredHalves"], 2)
        self.assertEqual(snap["indiaPolicy"]["days"][SHORT]["deduct"], 2700.0)
        self.assertEqual(snap["totalPay"], 58050.0)
        # The rule switched off, Policy Starts moved, the fee raised, the claim cut: nothing moves.
        self.db.query(models.NexusSetting).delete()
        self.db.add(models.NexusSetting(key=f"{icp.SETTING_KEY}:{CO}", value=json.dumps({"mode": "off", "startDate": "2027-01-01"})))
        self.db.query(models.PayrollRate).filter_by(employee_email=CON).update({"monthly_salary": SALARY * 3})
        self.db.query(models.ExtraTimeClaim).update({"approved_min": 60})
        self.db.commit()
        c = self.card()
        self.assertTrue(c["indiaPolicy"]["frozen"])
        self.assertEqual((c["totals"]["totalPay"], c["totals"]["deduction"], c["totals"]["extraTimePay"]),
                         (58050.0, 2700.0, 2025.0))
        self.assertEqual(self.day(c, SHORT)["deduct"], 2700.0)

    def test_a_month_finalized_under_the_old_rules_stays_old(self):
        self.db.query(models.NexusSetting).delete()            # finalized while the default kept Sep out
        _worked_example(self.db, CON)
        self.db.commit()
        tc.finalize_timecard(tc.FinalizeIn(email=CON, start=MS, end=ME, allow_exceptions=True), user=HR_USER,
                             db=self.db)
        self.db.add(models.NexusSetting(key=f"{icp.SETTING_KEY}:{CO}", value=json.dumps({"mode": "on", "startDate": MS})))
        self.db.commit()
        c = self.card()
        self.assertNotIn("indiaPolicy", c)
        self.assertEqual(c["totals"]["totalPay"], 56565.0)

    def test_settings_route(self):
        r = self.client.get("/timeclock/payroll/india-contractor-policy", params={"company": CO_US})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["mode"], r.json()["startDate"], r.json()["enabled"]), ("", "2026-11-01", False))
        r = self.client.get("/timeclock/payroll/india-contractor-policy", params={"company": CO})
        self.assertEqual((r.json()["startDate"], r.json()["enabled"], r.json()["hasOverride"]), (MS, True, True))
        r = self.client.put("/timeclock/payroll/india-contractor-policy", params={"company": CO_US},
                            json={"mode": "on", "startDate": "2026-12-01"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["enabled"], r.json()["startDate"]), (True, "2026-12-01"))
        self.assertEqual(self.client.put("/timeclock/payroll/india-contractor-policy", json={"mode": "maybe"}).status_code, 400)

    def test_manager_tier_never_sees_extra_time_pay(self):
        stripped = tc.strip_pay({"fixedDays": [{"extraPay": 1.0, "extraMin": 60}],
                                 "indiaPolicy": {"extraTime": {"hourlyEquivalent": 300.0, "rate": 405.0},
                                                 "reconciliation": {"extraTimePay": 2025.0, "poolMin": 10}}})
        self.assertEqual(stripped, {"fixedDays": [{"extraMin": 60}],
                                    "indiaPolicy": {"extraTime": {}, "reconciliation": {"poolMin": 10}}})


# ── Extra Time claims ─────────────────────────────────────────────────────────

class ClaimTests(Base):
    def setUp(self):
        super().setUp()
        _worked_example(self.db, CON)
        self.db.commit()
        esign._ensure_document_classes(self.db)
        self.codes = {}
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_egnyte_push", esign._egnyte_push)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._egnyte_push = lambda *a, **k: (False, "")

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        super().tearDown()

    def file(self, day, minutes, note="Weekend deploy of the billing system"):
        self._as(CON)
        return self.client.post("/extra-time/claims", json={"date": day, "minutes": minutes, "note": note})

    def decide(self, cid, who, decision, minutes=0, reason=""):
        self._as(who)
        return self.client.post(f"/extra-time/claims/{cid}/decide",
                                json={"decision": decision, "minutes": minutes, "reason": reason})

    def notices(self, who, prefix):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == who,
                                                              models.NexusNotification.ref_id.like(f"{prefix}%")).all()

    def test_weekday_claim_is_limited_to_the_hours_past_nine(self):
        r = self.file(LONG, 120)
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn("past 9", r.json()["detail"])
        self.assertEqual(self.file("2026-09-01", 30).status_code, 422)   # a 9 h day has nothing to claim
        r = self.file(LONG, 90)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["claimedMin"]), ("pending", 90))

    def test_weekend_claim_takes_every_hour_and_needs_a_note(self):
        self.assertEqual(self.file(SAT, 301).status_code, 422)
        self.assertEqual(self.file(SAT, 300, note="  ").status_code, 422)
        self.assertEqual(self.file(SAT, 300).status_code, 200)
        self.assertEqual(self.file(SAT, 60).status_code, 409)              # one claim a day
        self.assertEqual(self.file("2026-10-31", 60).status_code, 400)     # October: before this test's data

    def test_nobody_decides_their_own_claim(self):
        cid = self.file(SAT, 300).json()["id"]
        r = self.decide(cid, CON, "approve", 300)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("your own", r.json()["detail"])
        self.assertEqual(self.decide(cid, EMP_IN, "approve", 300).status_code, 403)   # not HR, not an approver
        self.assertFalse(xt.can_decide(self.db, CON, CON))
        # An HR contact who files their own claim goes to the Global Admins.
        self.assertEqual(xt.approvers(self.db, HRC), [OWNER])
        self.assertEqual(xt.approvers(self.db, CON), [HRC])
        self.db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": ""})
        self.db.commit()
        self.assertEqual(xt.approvers(self.db, CON), [OWNER])

    def test_hr_decides_only_inside_their_company(self):
        # Oct 27 2026: the one HR rule, within the person's company - an
        # administrator or a Full HR grant whose People scope does not cover
        # Greens India cannot decide its contractor's claim.
        from unittest import mock
        ADMIN, FULL = "admin.icp@greensglobal.com", "full.icp@greensglobal.com"
        for em, first in ((ADMIN, "Adi"), (FULL, "Fay")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             company=CO_US, country="US", status="active", employment_type="full_time",
                                             deleted_at=""))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
        self.db.query(models.NexusAccessScope).delete()
        for em in (ADMIN, FULL):
            self.db.add(models.NexusAccessScope(id=f"sc-{em}", email=em, module_id="hr", scope_type="entity",
                                                scope_id=CO_US))
        self.db.commit()
        auth.invalidate_role_cache()
        cid = self.file(SAT, 300).json()["id"]
        grants = {FULL: auth._MODULE_LEVEL_RANK["full"]}
        with mock.patch.object(auth, "_module_level", lambda email, module, _db: grants.get(email, 0) if module == "hr" else 0):
            # A Full grant scoped to Greens US does not decide a Greens India claim.
            self.assertFalse(xt.can_decide(self.db, FULL, CON))
            self.assertEqual(self.decide(cid, FULL, "approve", 300).status_code, 403)
            # An administrator is confined by the company walls, as in People:
            # walls on (Ojas the Global Admin), Adi reaches only Greens US.
            import cache
            self.db.add(models.NexusSetting(key="company_walls", value="on"))
            self.db.add(models.NexusGroup(id="g-ga", name="Global Admins", is_global_admin=1))
            self.db.add(models.NexusGroupMember(group_id="g-ga", email=OWNER))
            self.db.commit()
            cache.settings_config.invalidate()
            self.assertFalse(xt.can_decide(self.db, ADMIN, CON))
            self.db.query(models.NexusSetting).filter_by(key="company_walls").delete()
            self.db.query(models.NexusGroupMember).filter_by(group_id="g-ga").delete()
            self.db.query(models.NexusGroup).filter_by(id="g-ga").delete()
            self.db.commit()
            cache.settings_config.invalidate()
            # An Editor grant is never HR, scoped or not.
            grants[FULL] = auth._MODULE_LEVEL_RANK["editor"]
            self.db.query(models.NexusAccessScope).delete()
            self.db.commit()
            self.assertFalse(xt.can_decide(self.db, FULL, CON))
            # Unscoped: the administrator and the Full grant reach every company.
            grants[FULL] = auth._MODULE_LEVEL_RANK["full"]
            self.assertTrue(xt.can_decide(self.db, ADMIN, CON))
            self.assertTrue(xt.can_decide(self.db, FULL, CON))
            # Scoped to Greens India: yes; and never their own claim.
            self.db.add(models.NexusAccessScope(id="sc-in", email=FULL, module_id="hr", scope_type="entity", scope_id=CO))
            self.db.commit()
            self.assertTrue(xt.can_decide(self.db, FULL, CON))
            self.assertEqual(self.decide(cid, FULL, "approve", 300).status_code, 200)
            self.assertFalse(xt.can_decide(self.db, FULL, FULL))
        # The named approver (the HR contact) and the Global Admin fallback still decide.
        self.assertTrue(xt.can_decide(self.db, HRC, CON))
        self.assertTrue(xt.can_decide(self.db, OWNER, HRC))

    def test_approve_fewer_hours_and_the_rest_stays_in_the_pool(self):
        cid = self.file(SAT, 300).json()["id"]
        self.assertEqual([n.priority for n in self.notices(HRC, "extra-time:")], [1])
        self.assertEqual([c["id"] for c in xt.waiting_on(self.db, HRC)], [cid])
        self.assertEqual(xt.waiting_on(self.db, CON), [])
        r = self.decide(cid, HRC, "approve", 240)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["approvedMin"]), ("approved", 240))
        c = self.card()
        self.assertEqual(c["totals"]["extraTimePay"], 1620.0)              # 4 x 300 x 1.35
        self.assertEqual(self.day(c, SAT)["poolMin"], 60)                  # the hour not approved
        self.assertEqual(c["indiaPolicy"]["reconciliation"]["poolMin"], 510)
        # The approver's notice is resolved in place; the contractor hears the decision.
        self.assertEqual([n.actioned for n in self.notices(HRC, "extra-time:")], [True])
        told = self.notices(CON, "extra-time-decided:")
        self.assertEqual(len(told), 1)
        self.assertIn("Approved 4h 00m of 5h 00m claimed", told[0].body)

    def test_a_changed_approver_never_keeps_a_stale_notice(self):
        cid = self.file(SAT, 300).json()["id"]
        self.db.query(models.HrEntity).filter_by(id=CO).update({"hr_contact_email": ""})
        self.db.commit()
        self._as(CON)
        self.assertEqual(self.client.put(f"/extra-time/claims/{cid}", json={"minutes": 240, "note": "Data load"}).status_code, 200)
        self.assertEqual([n.actioned for n in self.notices(HRC, "extra-time:")], [True])
        self.assertEqual([(n.actioned, n.priority) for n in self.notices(OWNER, "extra-time:")], [(False, 1)])
        self.assertEqual([c["id"] for c in xt.waiting_on(self.db, OWNER)], [cid])

    def test_decline_needs_a_reason_and_returns_the_hours(self):
        cid = self.file(SAT, 300).json()["id"]
        self.assertEqual(self.decide(cid, HRC, "decline").status_code, 422)
        r = self.decide(cid, HRC, "decline", reason="Not pre-agreed work")
        self.assertEqual(r.status_code, 200, r.text)
        c = self.card()
        self.assertEqual((c["totals"]["extraTimePay"], self.day(c, SAT)["poolMin"], c["totals"]["totalPay"]),
                         (0.0, 300, 57375.0))

    def test_edit_and_withdraw_while_pending(self):
        cid = self.file(SAT, 300).json()["id"]
        r = self.client.put(f"/extra-time/claims/{cid}", json={"minutes": 240, "note": "Data load"})
        self.assertEqual((r.status_code, r.json()["claimedMin"]), (200, 240))
        r = self.client.post(f"/extra-time/claims/{cid}/withdraw")
        self.assertEqual((r.status_code, r.json()["status"]), (200, "withdrawn"))
        self.assertEqual(self.client.put(f"/extra-time/claims/{cid}", json={"minutes": 60, "note": "x"}).status_code, 409)
        self.assertEqual([n.actioned for n in self.notices(HRC, "extra-time:")], [True])
        self.assertEqual(self.file(SAT, 300).status_code, 200)             # a new claim after a withdrawal

    def test_review_and_approve_waits_for_every_claim(self):
        cid = self.file(SAT, 300).json()["id"]
        self.assertIn("Extra Time claim pending", tsr.approve_blocker(self.db, CON, MS, ME))
        with self.assertRaises(HTTPException) as ex:
            tsr.approve_period(self.db, CON, MS, HRC)
        self.assertEqual(ex.exception.status_code, 409)
        self.assertIn("Extra Time", str(ex.exception.detail))
        self.db.rollback()
        self.assertEqual(self.decide(cid, HRC, "approve", 300).status_code, 200)
        self.db.expire_all()
        self.assertEqual(tsr.approve_blocker(self.db, CON, MS, ME), "")
        r = tsr.approve_period(self.db, CON, MS, HRC)
        self.assertEqual(r.status, "signing")
        # Filing closed once it went to Review & Approve.
        r = self.file(SUN, 180)
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("closed", r.json()["detail"])
        # A decision changed after approval: HR's override - back for a fresh signature.
        self.assertEqual(self.decide(cid, HRC, "approve", 120).status_code, 200)
        self.db.expire_all()
        self.assertEqual(tsr.active_review(self.db, CON, MS).status, "approved")

    def test_signed_and_finalized_month_and_its_invoice(self):
        cid = self.file(SAT, 300).json()["id"]
        self.decide(cid, HRC, "approve", 300)
        self.db.expire_all()
        r = tsr.approve_period(self.db, CON, MS, HRC)
        party = next(p for p in self.db.query(models.HrSignParty).filter_by(request_id=r.sign_request_id).all())
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]}).status_code, 200)
        res = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 3, "pages_total": 3})
        self.assertEqual(res.status_code, 200, res.text)
        self.db.expire_all()
        self.assertEqual(tsr.active_review(self.db, CON, MS).status, "completed")
        inv = self.db.query(models.ContractorInvoice).filter_by(employee_email=CON).one()
        self.assertEqual(inv.amount, 58050.0)
        self.assertEqual([(ln["description"].split(":")[0], ln["amount"]) for ln in inv.snapshot["lines"]],
                         [("Monthly fee for September 2026", 58725.0), ("Less 1 unpaid day", -2700.0),
                          ("Extra Time", 2025.0)])
        from routers import contractor_invoices as ci
        from pypdf import PdfReader
        import io
        text = " ".join(pg.extract_text() for pg in PdfReader(io.BytesIO(ci.render_pdf(inv.snapshot))).pages)
        self.assertIn("Less 1 unpaid day", text)
        self.assertIn("Extra Time", text)
        # The PDF time sheet carries the reconciliation and the Extra Time lines with notes.
        rv = tsr.active_review(self.db, CON, MS)
        pdf, _spot = tsr.build_pdf(self.db, rv)
        text = " ".join(pg.extract_text() for pg in PdfReader(io.BytesIO(pdf)).pages)
        for words in ("Month-End Reconciliation", "Half days recovered", "Weekend deploy of the billing system",
                      "Extra Time"):
            self.assertIn(words, text)

    def test_card_payloads(self):
        self._as(CON)
        r = self.client.get("/timeclock/my-payroll", params={"start": MS})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["extraTimeFiling"], {"open": True, "reason": ""})
        # Nothing claimed yet: Sat 5 h + Sun 3 h are all pool - 12.5 h buys back 3 of the 4 halves.
        self.assertEqual(body["totals"]["totalPay"], 58725.0 - 1350.0)
        sat = next(d for d in body["fixedDays"] if d["date"] == SAT)
        self.assertEqual((sat["claimableMin"], sat["claim"], sat["dayKind"]), (300, None, "weekend"))
        self._as(OWNER)
        r = self.client.get("/timeclock/payroll", params={"email": CON, "start": MS, "end": ME})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["extraTimeCanDecide"])
        self.assertEqual(r.json()["indiaPolicy"]["reconciliation"]["poolMin"], 450 + 300)
        # The legacy Finalize refuses while a claim is pending.
        cid = self.file(SAT, 300).json()["id"]
        self._as(OWNER)
        r = self.client.post("/timeclock/finalize", json={"email": CON, "start": MS, "end": ME})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertIn("Extra Time", r.json()["detail"])
        q = self.client.get("/extra-time/queue").json()
        self.assertEqual([c["id"] for c in q["pending"]], [cid])
        self.assertTrue(q["pending"][0]["canDecide"])

    def test_month_end_reminder_once(self):
        from datetime import datetime, timezone
        last_day = datetime(2026, 9, 30, 12, tzinfo=timezone.utc)
        self.assertEqual(xt.remind_unclaimed(self.db, last_day), 1)
        self.db.commit()
        n = self.notices(CON, "extra-time-reminder:")
        self.assertEqual(len(n), 1)
        self.assertIn("09/05/2026 (5h 00m)", n[0].body)
        self.assertIn("09/06/2026 (3h 00m)", n[0].body)
        self.assertEqual(xt.remind_unclaimed(self.db, last_day), 0)        # once a month
        self.assertEqual(xt.remind_unclaimed(self.db, datetime(2026, 9, 29, 12, tzinfo=timezone.utc)), 0)


if __name__ == "__main__":
    unittest.main()
