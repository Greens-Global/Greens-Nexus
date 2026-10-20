"""The CA meal check's flag is HR's, never the employee's (Charmi, Oct 20:
"I want this flagged for Charmi. This I don't want the employee to ever see").

  * /my-payroll (My Time Sheet) carries no day["meal"] - not even in the JSON;
  * the manager / HR card for the same person still carries it;
  * the hours and pay are the same on both.

Runs on test_timesheet_review's throwaway database, one file per process:
    python -m pytest test_my_payroll_meal_hidden.py -q
"""
import unittest

from test_ca_breaks import CaCase, EMP, HR  # noqa: F401  (sets DATABASE_URL first)

from routers import timeclock  # noqa: E402


class MealFlagHidden(CaCase):
    def test_employee_card_has_no_meal_flag_but_hr_card_does(self):
        self._rate("ca")
        self.db.expire_all()
        mine = timeclock.my_payroll(start=self.start, user={"email": EMP}, db=self.db)
        self.assertTrue(mine["days"])
        self.assertFalse(any("meal" in d for d in mine["days"]))
        self.db.expire_all()
        theirs = timeclock.payroll_timecard(email=EMP, start=self.start, end=self.end,
                                            user={"email": HR}, _su={}, db=self.db)
        days = {d["date"]: d for d in theirs["days"]}
        self.assertEqual(days[self.d1]["meal"]["chip"], "Meal Missed")
        # Display only: the same hours either way.
        self.assertEqual(mine["totals"]["workedMin"], theirs["totals"]["workedMin"])


if __name__ == "__main__":
    unittest.main()
