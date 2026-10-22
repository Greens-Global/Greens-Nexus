"""Time Sheet bonuses (Neil, Oct 22 2026): a manager or HR adds a bonus with
why to a pay period; it is its own line, adds to totalPay on the hourly and
the monthly card, prints on the Time Sheet PDF and on a contractor's
invoice, and is locked like the hours.

    python -m unittest test_timecard_bonus
"""
import io
import unittest

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, ANCHOR, EMP, MGR, HR as HR_EMAIL, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_pdf  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import contractor_invoices, esign, timeclock  # noqa: E402

HR = {"email": MGR, "level": 4}


class BonusTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.TimecardBonus).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, hourly_rate=20.0, overtime_rule="ca", pay_type="hourly"))
        self.db.commit()

    def _add(self, amount=150.0, desc="Referral bonus", who=HR, day=None):
        return timeclock.add_timecard_bonus(
            timeclock.TimecardBonusIn(email=EMP, date=day or self.start, description=desc, amount=amount),
            user=who, _su={}, db=self.db)

    def _card(self):
        self.db.expire_all()
        return timeclock._compute_timecard(self.db, EMP, self.start, self.end)

    def test_bonus_adds_to_pay_and_prints(self):
        before = self._card()["totals"]["totalPay"]
        self._add()
        card = self._card()
        self.assertEqual(card["totals"]["bonusPay"], 150.0)
        self.assertAlmostEqual(card["totals"]["totalPay"], before + 150.0)
        self.assertEqual([b["description"] for b in card["bonuses"]], ["Referral bonus"])
        self.assertIn(("Bonus: Referral bonus", "-", "+$150.00"), timesheet_pdf.hourly_summary(card))
        # The manager tier sees no pay: the amount goes, the line's reason stays.
        stripped = timeclock.strip_pay(card)
        self.assertNotIn("amount", stripped["bonuses"][0])
        self.assertNotIn("bonusPay", stripped["totals"])

    def test_a_bonus_changes_what_the_employee_signs(self):
        import timesheet_review as tsr
        before = tsr.fingerprint(self.db, EMP, self.start, self.end)
        bid = self._add()["id"]
        self.assertNotEqual(tsr.fingerprint(self.db, EMP, self.start, self.end), before)
        timeclock.remove_timecard_bonus(bid, user=HR, _su={}, db=self.db)
        self.assertEqual(tsr.fingerprint(self.db, EMP, self.start, self.end), before)

    def test_remove_takes_it_back_out(self):
        before = self._card()["totals"]["totalPay"]
        bid = self._add()["id"]
        timeclock.remove_timecard_bonus(bid, user=HR, _su={}, db=self.db)
        card = self._card()
        self.assertNotIn("bonuses", card)
        self.assertAlmostEqual(card["totals"]["totalPay"], before)
        self.assertEqual(self.db.query(models.TimecardBonus).filter_by(id=bid).one().removed_by, MGR)   # kept as the record

    def test_refusals(self):
        for amount, desc in ((0, "x"), (-5, "x"), (10, "  ")):
            with self.assertRaises(HTTPException) as e:
                self._add(amount=amount, desc=desc)
            self.assertEqual(e.exception.status_code, 400)
        with self.assertRaises(HTTPException) as e:
            self._add(who={"email": EMP, "level": 4})
        self.assertEqual(e.exception.status_code, 403)
        self.db.add(models.TimeApproval(id="fin-1", employee_email=EMP, period_start=self.start,
                                        period_end=self.end, kind="final", revoked=0))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            self._add()
        self.assertEqual(e.exception.status_code, 403)

    def test_monthly_card_counts_it_once(self):
        rate = self.db.query(models.PayrollRate).filter_by(employee_email=EMP).one()
        rate.pay_type, rate.monthly_salary, rate.currency = "fixed", 30000.0, "INR"
        self.db.commit()
        before = timeclock._fixed_card(self.db, EMP, self.start)
        self._add(amount=2500.0, day=before["periodStart"])
        self.db.expire_all()
        after = timeclock._fixed_card(self.db, EMP, self.start)
        self.assertEqual(after["totals"]["bonusPay"], 2500.0)
        self.assertAlmostEqual(after["totals"]["totalPay"], before["totals"]["totalPay"] + 2500.0)
        self.assertIn(("Bonus: Referral bonus", "", "+INR 2,500.00"), timesheet_pdf.fixed_summary(after))

    def test_invoice_lists_each_bonus(self):
        pdf = contractor_invoices.render_pdf({"number": 1, "currency": "INR", "amount": 32500.0, "description": "Services",
                                              "bonuses": [{"description": "Referral bonus", "amount": 2500.0}]})
        self.assertTrue(pdf.startswith(b"%PDF"))


MANAGER = {"email": MGR, "level": 3}     # Erin's manager - not HR
HR_USER = {"email": HR_EMAIL, "level": 4}


class BonusWorkflowTests(ReviewCase):
    """Where a bonus goes in the review (Oct 22): the employee always signs a
    Time Sheet that shows it, whoever added it and whenever."""

    def setUp(self):
        super().setUp()
        for m in (models.TimecardBonus, models.NexusNotification):
            self.db.query(m).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, hourly_rate=20.0, overtime_rule="ca", pay_type="hourly"))
        self.db.commit()
        # Keep each envelope's PDF so the test reads what the employee is sent.
        self.pdfs = []
        real = esign._storage_put
        self._patched.append((esign, "_storage_put", real))
        esign._storage_put = lambda b, p, data, *a, **k: (self.pdfs.append(data), real(b, p, data, *a, **k))[1]

    def _add(self, who, desc="Holiday cover", amount=150.0):
        return timeclock.add_timecard_bonus(
            timeclock.TimecardBonusIn(email=EMP, date=self.start, description=desc, amount=amount),
            user=who, _su={}, db=self.db)

    def _text(self, pdf):
        from pypdf import PdfReader
        return " ".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)

    def _bells(self, to):
        self.db.expire_all()
        return [n.title for n in self.db.query(models.NexusNotification).filter_by(recipient=to).all()]

    def _bell(self, to, title):
        self.db.expire_all()
        got = [n.body for n in self.db.query(models.NexusNotification).filter_by(recipient=to, title=title).all()]
        self.assertEqual(len(got), 1, (title, self._bells(to)))
        return got[0]

    def _sign_now(self):
        r = self._r()
        self._sign(self._parties(r.sign_request_id)["employee"])
        return self._r()

    def test_added_before_approval_it_is_on_the_time_sheet_the_employee_signs(self):
        out = self._add(MANAGER)
        self.assertEqual((out["reopened"], out["signAgain"]), (False, False))
        # The employee hears at once, with the amount - not only when they sign.
        body = self._bell(EMP, "Bonus Added to Your Time Sheet")
        self.assertIn("Max Test added a bonus to your time sheet for", body)
        self.assertIn("Holiday cover - $150.00", body)
        self.assertIn("on the copy you sign", body)
        # Their own Time Sheet carries it (Workday > Time Sheet reads /my-payroll).
        mine = timeclock.my_payroll(start=self.start, user={"email": EMP, "level": 1}, db=self.db)
        self.assertEqual([(b["description"], b["amount"]) for b in mine["bonuses"]], [("Holiday cover", 150.0)])
        r = tsr.submit(self.db, EMP, ANCHOR, "All in")
        tsr.approve(self.db, r, MGR, "")
        r = self._r()
        self.assertEqual(r.status, "signing")
        self.assertEqual(r.agreed_fingerprint, tsr.fingerprint(self.db, EMP, self.start, self.end))
        text = self._text(self.pdfs[-1])
        self.assertIn("Bonus: Holiday cover", text)
        self.assertIn("150.00", text)
        r = self._sign_now()
        self.assertEqual(r.status, "completed")
        card = timeclock._compute_timecard(self.db, EMP, self.start, self.end)
        self.assertEqual(card["totals"]["bonusPay"], 150.0)

    def test_a_manager_adding_one_while_it_is_out_to_sign_sends_it_back_to_the_manager(self):
        r = self._to_signing()
        first = r.sign_request_id
        out = self._add(MANAGER)
        self.assertTrue(out["reopened"])
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id), ("with_manager", ""))
        self.assertEqual(self.db.get(models.HrSignRequest, first).status, "voided")
        # Says it was a bonus, not "changed the hours".
        back = self._bell(EMP, "Time Sheet Back for Review")
        self.assertIn("added a bonus: Holiday cover", back)
        self.assertNotIn("changed the hours", back)
        self.assertIn("back to your manager to approve, then to you to sign again",
                      self._bell(EMP, "Bonus Added to Your Time Sheet"))
        # The manager approves again: a new envelope, with the bonus on it.
        tsr.approve(self.db, r, MGR, "")
        self.assertIn("Bonus: Holiday cover", self._text(self.pdfs[-1]))
        self.assertEqual(self._sign_now().status, "completed")

    def test_hr_adding_one_while_it_is_out_to_sign_asks_the_employee_to_sign_again(self):
        r = self._to_signing()
        first = r.sign_request_id
        self.assertTrue(self._add(HR_USER)["signAgain"])
        r = self._r()
        self.assertEqual(r.status, "approved")      # HR needs no new approval
        self.assertEqual(self.db.get(models.HrSignRequest, first).status, "voided")
        self.assertIn("Time Sheet Updated by HR", self._bells(EMP))
        self.assertIn("sign it again", self._bell(EMP, "Bonus Added to Your Time Sheet"))
        tsr.employee_approve(self.db, r, EMP)
        r = self._r()
        self.assertEqual(r.status, "signing")
        text = self._text(self.pdfs[-1])
        self.assertIn("Bonus: Holiday cover", text)
        # The approval history on the copy they sign names the bonus.
        self.assertTrue(any(x.startswith("Changed by Hana Test (HR)") and "added a bonus: Holiday cover" in x
                            for x in tsr.approval_log(self.db, r)), tsr.approval_log(self.db, r))
        self.assertEqual(self._sign_now().status, "completed")

    def test_removing_one_after_approval_reopens_it_too(self):
        bid = self._add(MANAGER)["id"]
        self._to_signing()
        timeclock.remove_timecard_bonus(bid, user=MANAGER, _su={}, db=self.db)
        r = self._r()
        self.assertEqual(r.status, "with_manager")
        self.assertIn('removed the bonus "Holiday cover" ($150.00)', self._bell(EMP, "Bonus Removed from Your Time Sheet"))
        tsr.approve(self.db, r, MGR, "")
        self.assertNotIn("Bonus:", self._text(self.pdfs[-1]))

    def test_back_with_the_employee_only_hr_can_add_one(self):
        r = tsr.submit(self.db, EMP, ANCHOR, "All in")
        tsr.send_back(self.db, r, MGR, "Check Monday")
        with self.assertRaises(HTTPException) as e:
            self._add(MANAGER)
        self.assertEqual(e.exception.status_code, 403)
        self._add(HR_USER)
        self.assertEqual(self._r().status, "with_employee")

    def test_once_signed_and_final_nobody_adds_one(self):
        self._to_signing()
        self._sign_now()
        for who in (MANAGER, HR_USER):
            with self.assertRaises(HTTPException) as e:
                self._add(who)
            self.assertEqual(e.exception.status_code, 403)
            self.assertIn("Add the bonus on the current pay period, or ask HR to unlock", e.exception.detail)
        self.assertNotIn("Bonus Added to Your Time Sheet", self._bells(EMP))


if __name__ == "__main__":
    unittest.main()
