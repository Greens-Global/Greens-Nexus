"""Salary advances (Neil, Oct 27 2026) - salary_advance.py + routers/salary_advances.py.

  * only the manager tier and up ask for their own; everyone else is refused
  * only HR (timesheet_review.is_hr) approves, declines, pays out and changes
    the schedule - never the manager, never on your own advance
  * paid out, the first installment comes out of the NEXT pay period; a
    finalized period is skipped; HR moves an installment later with a reason
  * the pay card carries a "Salary Advance Repayment" line and netPay on the
    hourly and the monthly card, the CSV and the Intacct entry carry it, the
    Time Sheet PDF prints it; a period never pays out below zero and the
    rest moves forward when it is finalized; unlocking puts it back
  * the advance is in the pay currency

    python -m unittest test_salary_advances
"""
import asyncio
import csv
import io
import unittest
from datetime import date, timedelta

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import models  # noqa: E402
import salary_advance as sa  # noqa: E402
import timesheet_pdf  # noqa: E402
from routers import contractor_invoices, salary_advances as api, timeclock  # noqa: E402

EMPLOYEE = {"email": EMP, "level": 1}
EMP_AS_MANAGER = {"email": EMP, "level": 3}
MANAGER = {"email": MGR, "level": 3}           # Erin's manager - not HR
HR_USER = {"email": HR, "level": 3}            # the company's HR contact


def _day_before(iso: str) -> str:
    return (date.fromisoformat(iso) - timedelta(days=1)).isoformat()


def _day_after(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()


class AdvanceCase(ReviewCase):
    def setUp(self):
        super().setUp()
        for m in (models.SalaryAdvance, models.SalaryAdvanceInstallment, models.NexusNotification, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, hourly_rate=20.0, overtime_rule="ca", pay_type="hourly",
                                       currency="USD"))
        self.db.commit()
        self.db.info.pop("_advance_emails", None)
        auth.invalidate_role_cache()
        # The period after Erin's worked one, and the one after that.
        self.next_start, self.next_end = timeclock._pay_period(_day_after(self.end))
        self.third_start, _e = timeclock._pay_period(_day_after(self.next_end))

    def _request(self, who=EMP_AS_MANAGER, amount=50.0, n=1, currency=""):
        return api.request_advance(api.RequestIn(amount=amount, currency=currency, reason="Car repair", installments=n),
                                   user=who, db=self.db)

    def _grant(self, amount=50.0, n=1, who=HR_USER, currency=""):
        return api.grant(api.GrantIn(email=EMP, amount=amount, currency=currency, reason="Moving costs", installments=n),
                         user=who, db=self.db)

    def _paid(self, aid, paid_on=None, who=HR_USER):
        # Paid out the day before Erin's worked period: it comes out of THAT period.
        return api.mark_paid(aid, api.PaidIn(paid_on=paid_on or _day_before(self.start), payment_method="ach"),
                             user=who, db=self.db)

    def _card(self):
        self.db.expire_all()
        self.db.info.pop("_advance_emails", None)
        return timeclock._compute_timecard(self.db, EMP, self.start, self.end)

    def _status(self, code, fn, *a, **k):
        with self.assertRaises(HTTPException) as e:
            fn(*a, **k)
        self.assertEqual(e.exception.status_code, code, e.exception.detail)
        return e.exception.detail


class WhoTests(AdvanceCase):
    def test_only_the_manager_tier_and_up_ask(self):
        self.assertIn("managers and above", self._status(403, self._request, who=EMPLOYEE))
        out = self._request()
        self.assertEqual((out["status"], out["statusLabel"], out["currency"]), ("requested", "Requested", "USD"))
        # HR hears once, on one notice for the advance.
        bells = self.db.query(models.NexusNotification).filter_by(recipient=HR).all()
        self.assertEqual([b.ref_id for b in bells], [f"salary-advance:{out['id']}"])
        self.assertIn("$50.00", bells[0].body)
        # A second request while one waits is refused.
        self._status(409, self._request)
        # The overview tells the screen who may ask.
        self.assertFalse(api.overview(user=EMPLOYEE, db=self.db)["canRequest"])
        self.assertTrue(api.overview(user=EMP_AS_MANAGER, db=self.db)["canRequest"])

    def test_only_hr_decides(self):
        aid = self._request()["id"]
        self._status(404, api.decide, aid, api.DecideIn(action="approve"), user=MANAGER, db=self.db)
        # The person never decides their own, even at the administrator tier.
        self._status(403, api.decide, aid, api.DecideIn(action="approve"), user={"email": EMP, "level": 4}, db=self.db)
        self._status(400, api.decide, aid, api.DecideIn(action="decline"), user=HR_USER, db=self.db)   # needs a why
        out = api.decide(aid, api.DecideIn(action="approve", installments=2), user=HR_USER, db=self.db)
        self.assertEqual((out["status"], out["installments"]), ("approved", 2))
        self._status(409, api.decide, aid, api.DecideIn(action="approve"), user=HR_USER, db=self.db)
        # Only HR pays it out.
        self._status(404, self._paid, aid, who=MANAGER)

    def test_hr_never_grants_or_approves_their_own(self):
        self._status(403, api.grant, api.GrantIn(email=HR, amount=10, reason="Mine", installments=1),
                     user={"email": HR, "level": 4}, db=self.db)
        own = api.request_advance(api.RequestIn(amount=20.0, reason="Rent help"), user=HR_USER, db=self.db)
        self._status(403, api.decide, own["id"], api.DecideIn(action="approve"), user=HR_USER, db=self.db)

    def test_managers_do_not_see_other_peoples_advances(self):
        self._grant()
        self._status(404, api.for_person, EMP, user=MANAGER, db=self.db)
        self.assertEqual(api.overview(user=MANAGER, db=self.db)["hr"], [])
        self.assertEqual(len(api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"]), 1)
        self.assertEqual(len(api.for_person(EMP, user=HR_USER, db=self.db)["advances"]), 1)
        # The manager tier sees no pay on the card - the repayment lines go too.
        self._paid(self._grant()["id"])
        stripped = timeclock.strip_pay(self._card())
        self.assertNotIn("advanceRepayments", stripped)
        self.assertNotIn("netPay", stripped["totals"])

    def test_currency_is_the_pay_currency(self):
        self.assertEqual(self._grant()["currency"], "USD")
        self.assertIn("Paid in USD", self._status(400, self._grant, currency="INR"))
        rate = self.db.query(models.PayrollRate).filter_by(employee_email=EMP).one()
        rate.currency = "INR"
        self.db.commit()
        self.assertEqual(self._grant()["currency"], "INR")
        self._status(400, self._grant, currency="US")


class ScheduleTests(AdvanceCase):
    def test_first_installment_is_the_next_pay_period(self):
        aid = self._grant(amount=100.0, n=3)["id"]
        out = self._paid(aid)
        self.assertEqual(out["status"], "paid_out")
        sched = out["schedule"]
        self.assertEqual([s["date"] for s in sched], [self.start, self.next_start, self.third_start])
        self.assertEqual([s["amount"] for s in sched], [33.33, 33.33, 33.34])
        self.assertEqual(out["balance"], 100.0)
        self.assertIn("Salary Advance Paid Out", [n.title for n in self.db.query(models.NexusNotification)
                                                  .filter_by(recipient=EMP).all()])

    def test_a_finalized_period_is_skipped(self):
        self.db.add(models.TimeApproval(id="fin-a", employee_email=EMP, period_start=self.start, period_end=self.end,
                                        kind="final", revoked=0))
        self.db.commit()
        out = self._paid(self._grant()["id"])
        self.assertEqual([s["date"] for s in out["schedule"]], [self.next_start])
        self.assertTrue(out["history"][-1]["detail"]["skippedFinalized"])

    def test_hr_defers_an_installment_with_a_reason(self):
        out = self._paid(self._grant()["id"])
        aid, iid = out["id"], out["schedule"][0]["id"]
        self._status(400, api.move, aid, iid, api.MoveIn(date=self.next_start, reason=""), user=HR_USER, db=self.db)
        self._status(404, api.move, aid, iid, api.MoveIn(date=self.next_start, reason="Short month"),
                     user=MANAGER, db=self.db)
        # Never into the payout's own period or before it.
        self._status(409, api.move, aid, iid, api.MoveIn(date=_day_before(self.start), reason="Back"),
                     user=HR_USER, db=self.db)
        # A day inside a later period lands on that period's first day.
        moved = api.move(aid, iid, api.MoveIn(date=_day_after(self.next_start), reason="Short month"),
                         user=HR_USER, db=self.db)
        self.assertEqual(moved["schedule"][0]["date"], self.next_start)
        h = moved["history"][-1]
        self.assertEqual((h["action"], h["note"], h["detail"]["from"], h["detail"]["to"]),
                         ("moved", "Short month", self.start, self.next_start))
        self.assertNotIn("advanceRepayments", self._card())          # nothing taken from the first period now

    def test_moving_into_a_finalized_period_rolls_forward(self):
        out = self._paid(self._grant()["id"])
        self.db.add(models.TimeApproval(id="fin-b", employee_email=EMP, period_start=self.next_start,
                                        period_end=self.next_end, kind="final", revoked=0))
        self.db.commit()
        moved = api.move(out["id"], out["schedule"][0]["id"], api.MoveIn(date=self.next_start, reason="Later"),
                         user=HR_USER, db=self.db)
        self.assertEqual(moved["schedule"][0]["date"], self.third_start)
        self.assertTrue(moved["skippedFinalized"])

    def test_replacing_the_schedule_must_add_up(self):
        out = self._paid(self._grant(amount=90.0)["id"])
        bad = [api.ScheduleItem(date=self.next_start, amount=40.0)]
        self.assertIn("must add up", self._status(400, api.set_schedule, out["id"],
                                                  api.ScheduleIn(installments=bad, reason="Spread it"),
                                                  user=HR_USER, db=self.db))
        good = [api.ScheduleItem(date=self.next_start, amount=40.0), api.ScheduleItem(date=self.third_start, amount=50.0)]
        new = api.set_schedule(out["id"], api.ScheduleIn(installments=good, reason="Spread it"), user=HR_USER, db=self.db)
        self.assertEqual([(s["date"], s["amount"]) for s in new["schedule"]],
                         [(self.next_start, 40.0), (self.third_start, 50.0)])
        self.assertEqual(new["history"][-1]["action"], "rescheduled")
        # The replaced row stays as the record, canceled.
        self.assertEqual(self.db.query(models.SalaryAdvanceInstallment).filter_by(advance_id=out["id"],
                                                                                  status="canceled").count(), 1)


class CardTests(AdvanceCase):
    def test_the_card_shows_the_repayment_and_net_pay(self):
        gross = self._card()["totals"]["totalPay"]
        self.assertEqual(gross, 140.0)                                   # 7 h at $20
        self._paid(self._grant(amount=50.0)["id"])
        card = self._card()
        t = card["totals"]
        self.assertEqual((t["totalPay"], t["advanceRepayment"], t["netPay"]), (140.0, 50.0, 90.0))
        self.assertEqual([x["label"] for x in card["advanceRepayments"]], ["Salary Advance Repayment"])
        rows = timesheet_pdf.hourly_summary(card)
        self.assertIn(("Salary Advance Repayment", "-", "-$50.00"), rows)
        self.assertIn(("NET PAY", "", "$90.00"), rows)
        # Intacct: wages stay gross, the repayment credits the advances account,
        # the clearing account gets the net.
        card.update({"name": "Erin Test", "department": "", "employeeId": "E1", "payType": "hourly", "payCodes": {}})
        lines = timeclock.payroll_intacct_entries([card], start=self.start, end=self.end, journal="PYRJ",
                                                  expense="6000", clearing="2100", location="", advances="1250")[0]["lines"]
        by_acct = {ln["acct_no"]: ln for ln in lines if ln["acct_no"] in ("1250", "2100")}
        self.assertEqual((by_acct["1250"]["credit"], by_acct["1250"]["memo"]), (50.0, "Erin Test - Salary Advance Repayment"))
        self.assertEqual(by_acct["2100"]["credit"], 90.0)
        self.assertEqual(sum(ln["debit"] or 0 for ln in lines), 140.0)

    def test_the_csv_carries_it_at_the_end(self):
        self._paid(self._grant(amount=50.0)["id"])
        self.db.info.pop("_advance_emails", None)
        resp = timeclock.export_csv(start=self.start, end=self.end, mode="summary",
                                    user={"email": HR, "level": 4}, _su={}, db=self.db)
        async def _read():
            return "".join([c if isinstance(c, str) else c.decode() async for c in resp.body_iterator])
        body = asyncio.run(_read())
        rows = list(csv.reader(io.StringIO(body)))
        head = rows[0]
        self.assertEqual(head[-2:], ["Salary Advance Repayment", "Net Pay"])
        total = next(r for r in rows if r[2] == "TOTAL")
        self.assertEqual(total[-2:], ["50.00", "90.00"])
        self.assertEqual(total[head.index("Total Pay")], "140.00")

    def test_never_below_zero_and_the_rest_carries_when_finalized(self):
        self._paid(self._grant(amount=200.0)["id"])
        t = self._card()["totals"]
        self.assertEqual((t["advanceRepayment"], t["netPay"]), (140.0, 0.0))
        self._to_signing()
        self._sign_now()                                                 # finalizes the period
        self.db.expire_all()
        rows = self.db.query(models.SalaryAdvanceInstallment).order_by(models.SalaryAdvanceInstallment.seq).all()
        self.assertEqual([(r.status, r.amount, r.deducted_amount, r.date) for r in rows],
                         [("deducted", 200.0, 140.0, self.start), ("scheduled", 60.0, 0.0, self.next_start)])
        adv = self.db.query(models.SalaryAdvance).one()
        self.assertEqual(sa.figures(adv, sa.installments(self.db, adv.id))["status"], "repaying")
        self.assertEqual(sa.outstanding(self.db, EMP)[0]["balance"], 60.0)
        # The finalized card keeps what it took.
        self.assertEqual(self._card()["totals"]["advanceRepayment"], 140.0)
        # HR unlocks it: the carry is taken back, the installment is whole again.
        timeclock.unfinalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.start, end=self.end,
                                                           reason="Wrong punch"),
                                      user={"email": HR, "level": 4}, db=self.db)
        self.db.expire_all()
        rows = self.db.query(models.SalaryAdvanceInstallment).order_by(models.SalaryAdvanceInstallment.seq).all()
        self.assertEqual([(r.status, r.amount) for r in rows], [("scheduled", 200.0), ("canceled", 60.0)])

    def _sign_now(self):
        r = self._r()
        self._sign(self._parties(r.sign_request_id)["employee"])
        return self._r()

    def test_a_period_with_no_pay_moves_the_installment_on(self):
        out = self._paid(self._grant(amount=50.0)["id"], paid_on=self.start)    # first: the next period
        self.assertEqual(out["schedule"][0]["date"], self.next_start)
        timeclock.finalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.next_start, end=self.next_end),
                                    user={"email": HR, "level": 4}, db=self.db)
        self.db.expire_all()
        rows = self.db.query(models.SalaryAdvanceInstallment).all()
        self.assertEqual([(r.status, r.amount, r.date) for r in rows], [("scheduled", 50.0, self.third_start)])
        adv = self.db.query(models.SalaryAdvance).one()
        self.assertEqual(adv.history[-1]["action"], "carried")

    def test_pending_for_hr(self):
        self._request()
        self.assertEqual(len(sa.pending_for_hr(self.db, HR_USER)), 1)
        self.assertEqual(sa.pending_for_hr(self.db, MANAGER), [])
        self.assertEqual(len(api.pending(user=HR_USER, db=self.db)), 1)

    def test_fully_repaid(self):
        out = self._paid(self._grant(amount=50.0)["id"])
        self._to_signing()
        self.assertEqual(self._sign_now().status, "completed")
        self.db.expire_all()
        got = api.for_person(EMP, user=EMPLOYEE, db=self.db)["advances"][0]
        self.assertEqual((got["id"], got["status"], got["statusLabel"], got["balance"], got["repaid"]),
                         (out["id"], "repaid", "Repaid", 0.0, 50.0))
        self.assertEqual(sa.outstanding(self.db, EMP), [])

    def test_monthly_card(self):
        rate = self.db.query(models.PayrollRate).filter_by(employee_email=EMP).one()
        rate.pay_type, rate.monthly_salary, rate.currency = "fixed", 30000.0, "INR"
        self.db.commit()
        before = timeclock._fixed_card(self.db, EMP, self.start)
        m_start = before["periodStart"]
        adv = self._grant(amount=2500.0)
        self._paid(adv["id"], paid_on=_day_before(m_start))
        self.db.expire_all()
        self.db.info.pop("_advance_emails", None)
        after = timeclock._fixed_card(self.db, EMP, self.start)
        t = after["totals"]
        self.assertEqual(t["totalPay"], before["totals"]["totalPay"])       # wages unchanged
        self.assertEqual(t["advanceRepayment"], min(2500.0, t["totalPay"]))
        self.assertAlmostEqual(t["netPay"], t["totalPay"] - t["advanceRepayment"])
        rows = timesheet_pdf.fixed_summary(after)
        self.assertIn(("NET PAY THIS MONTH", "", timesheet_pdf.money(t["netPay"], "INR")), rows)

    def test_contractor_invoice_is_net_of_the_repayment(self):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
        emp.employment_type = "contractor"
        self.db.commit()
        self._paid(self._grant(amount=50.0)["id"])
        self._to_signing()
        self._sign_now()
        self.db.expire_all()
        inv = self.db.query(models.ContractorInvoice).filter_by(employee_email=EMP).one()
        self.assertEqual(inv.amount, 90.0)
        self.assertEqual(inv.snapshot["deductions"], [{"description": "Salary Advance Repayment", "amount": 50.0}])
        pdf = contractor_invoices.render_pdf({**inv.snapshot, "number": 1, "currency": "USD", "amount": 90.0})
        self.assertTrue(pdf.startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
