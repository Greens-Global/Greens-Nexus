"""Inactive people leave the payroll list (Neil, Oct 22 2026): someone who
went inactive / offboarded before a period is not on that period's roster;
one who left during or after it stays for their last pay.

    python -m unittest test_payroll_inactive_roster
"""
import unittest
from types import SimpleNamespace as NS

from test_timesheet_review import _tmp_db  # noqa: F401  (sets DATABASE_URL first)

from routers.timeclock import _left_before  # noqa: E402


def emp(status, log=()):
    return NS(status=status, status_log=list(log))


class LeftBefore(unittest.TestCase):
    def test_active_and_onboarding_stay(self):
        self.assertFalse(_left_before(emp("active"), "2026-10-11"))
        self.assertFalse(_left_before(emp("onboarding"), "2026-10-11"))

    def test_left_before_the_period_is_off(self):
        e = emp("inactive", [{"to": "inactive", "effectiveDate": "2026-09-30", "at": "2026-10-02T00:00:00"}])
        self.assertTrue(_left_before(e, "2026-10-11"))

    def test_left_during_or_after_the_period_stays(self):
        e = emp("offboarded", [{"to": "offboarded", "effectiveDate": "2026-10-15"},
                               {"to": "inactive", "effectiveDate": "2026-01-01"}])
        self.assertFalse(_left_before(e, "2026-10-11"))
        self.assertTrue(_left_before(e, "2026-10-25"))

    def test_no_effective_date_uses_when_it_was_recorded(self):
        e = emp("inactive", [{"to": "inactive", "effectiveDate": "", "at": "2026-10-20T10:00:00+00:00"}])
        self.assertFalse(_left_before(e, "2026-10-11"))
        self.assertTrue(_left_before(e, "2026-10-25"))

    def test_no_record_of_leaving_is_off(self):
        self.assertTrue(_left_before(emp("inactive"), "2026-10-11"))


if __name__ == "__main__":
    unittest.main()
