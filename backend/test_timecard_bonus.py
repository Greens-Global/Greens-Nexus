"""Time Sheet bonuses (Neil, Oct 22 2026): a manager or HR adds a bonus with
why to a pay period; it is its own line, adds to totalPay on the hourly and
the monthly card, prints on the Time Sheet PDF and on a contractor's
invoice. Neil, Oct 23: it needs no new
approval or signature, and HR adds one even after the period is finalized.

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

    def test_a_bonus_never_makes_an_approval_or_signature_stale(self):
        import timesheet_review as tsr
        before = tsr.fingerprint(self.db, EMP, self.start, self.end)
        bid = self._add()["id"]
        self.assertEqual(tsr.fingerprint(self.db, EMP, self.start, self.end), before)
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
    """Neil, Oct 23: "a bonus should not require anyone to reapprove. It can be
    added at the very end by HR also. No employee will need to validate the
    bonus as it was not guaranteed base pay to begin with." """

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

    def _bonus_pay(self):
        self.db.expire_all()
        return timeclock._compute_timecard(self.db, EMP, self.start, self.end)["totals"].get("bonusPay")

    def test_added_before_approval_it_is_on_the_time_sheet_the_employee_signs(self):
        self._add(MANAGER)
        # The employee hears at once, with the amount, and has nothing to do.
        body = self._bell(EMP, "Bonus Added to Your Time Sheet")
        self.assertIn("Max Test added a bonus to your time sheet for", body)
        self.assertIn("Holiday cover - $150.00", body)
        self.assertIn("needs no approval or signature", body)
        mine = timeclock.my_payroll(start=self.start, user={"email": EMP, "level": 1}, db=self.db)
        self.assertEqual([(b["description"], b["amount"]) for b in mine["bonuses"]], [("Holiday cover", 150.0)])
        r = tsr.submit(self.db, EMP, ANCHOR, "All in")
        tsr.approve(self.db, r, MGR, "")
        self.assertEqual(self._r().status, "signing")
        self.assertIn("Bonus: Holiday cover", self._text(self.pdfs[-1]))
        self.assertEqual(self._sign_now().status, "completed")

    def test_a_manager_adding_one_while_it_is_out_to_sign_reopens_nothing(self):
        r = self._to_signing()
        envelope = r.sign_request_id
        self._add(MANAGER)
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id), ("signing", envelope))
        self.assertNotEqual(self.db.get(models.HrSignRequest, envelope).status, "voided")
        self.assertNotIn("Time Sheet Back for Review", self._bells(EMP))
        self.assertEqual(self._sign_now().status, "completed")      # the same signature still finalizes it
        self.assertEqual(self._bonus_pay(), 150.0)

    def test_hr_adding_one_while_it_is_out_to_sign_asks_for_no_new_signature(self):
        r = self._to_signing()
        envelope = r.sign_request_id
        self._add(HR_USER)
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id), ("signing", envelope))
        self.assertNotIn("Time Sheet Updated by HR", self._bells(EMP))
        self.assertEqual(self._sign_now().status, "completed")

    def test_removing_one_after_approval_changes_no_review_step(self):
        bid = self._add(MANAGER)["id"]
        self._to_signing()
        timeclock.remove_timecard_bonus(bid, user=MANAGER, _su={}, db=self.db)
        self.assertEqual(self._r().status, "signing")
        self.assertIn('removed the bonus "Holiday cover" ($150.00)', self._bell(EMP, "Bonus Removed from Your Time Sheet"))
        self.assertIsNone(self._bonus_pay())

    def test_back_with_the_employee_a_manager_can_still_add_one(self):
        r = tsr.submit(self.db, EMP, ANCHOR, "All in")
        tsr.send_back(self.db, r, MGR, "Check Monday")
        self._add(MANAGER)
        self.assertEqual(self._r().status, "with_employee")

    def test_after_it_is_final_only_hr_adds_one_at_the_very_end(self):
        self._to_signing()
        self._sign_now()
        with self.assertRaises(HTTPException) as e:
            self._add(MANAGER)
        self.assertEqual(e.exception.status_code, 403)
        self.assertIn("only HR can add or remove a bonus", e.exception.detail)
        self._add(HR_USER)
        self.assertEqual(self._r().status, "completed")              # still final, nobody signs again
        self.assertEqual(self._bonus_pay(), 150.0)                   # the exports read it from the card
        self.assertIn("Bonus Added to Your Time Sheet", self._bells(EMP))


if __name__ == "__main__":
    unittest.main()
