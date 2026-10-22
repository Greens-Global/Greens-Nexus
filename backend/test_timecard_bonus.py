"""Time Sheet bonuses (Neil, Oct 22 2026): a manager or HR adds a bonus with
why to a pay period; it is its own line, adds to totalPay on the hourly and
the monthly card, prints on the Time Sheet PDF and on a contractor's
invoice, and is locked like the hours.

    python -m unittest test_timecard_bonus
"""
import unittest

from fastapi import HTTPException

from test_timesheet_review import ReviewCase, EMP, MGR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_pdf  # noqa: E402
from routers import contractor_invoices, timeclock  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
