"""GET /timesheet-review/waiting must stay cheap (11/04/2026).

On prod a Super Administrator's review list built every reviewable time sheet
(people x 3 closed periods, hundreds of queries each at ~25 ms) and held the
pooler's connections for up to a minute - every other save (Add Break, punch
in) timed out behind it. Workday also called it just for the "to sign" count.
These pin: only=sign never builds the list, repeat loads within the minute
reuse one build, fresh=1 rebuilds. No database.

Run alone: python -m pytest test_timesheet_waiting_load.py
"""
import unittest
from unittest import mock

import cache
from routers import timesheet_reviews as route


class WaitingLoadTests(unittest.TestCase):
    def setUp(self):
        cache.timesheet_waiting.invalidate()
        self.db = mock.MagicMock()
        self.user = {"email": "Boss@greensglobal.com"}
        self.builds = 0

        def build(db, me):
            self.builds += 1
            return {"reviews": [{"employeeEmail": "a@x.com"}], "toSign": []}
        self.patch = mock.patch.object(route, "_waiting", side_effect=build)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        cache.timesheet_waiting.invalidate()

    def test_only_sign_never_builds_the_review_list(self):
        with mock.patch.object(route.tsr, "to_sign", return_value=[{"id": "r1"}]) as ts:
            out = route.waiting(only="sign", fresh=False, user=self.user, db=self.db)
        self.assertEqual(out, {"reviews": [], "toSign": [{"id": "r1"}]})
        self.assertEqual(self.builds, 0)
        ts.assert_called_once_with(self.db, "boss@greensglobal.com")

    def test_repeat_loads_reuse_one_build(self):
        for _ in range(5):
            out = route.waiting(only="", fresh=False, user=self.user, db=self.db)
        self.assertEqual(self.builds, 1)
        self.assertEqual(out["reviews"][0]["employeeEmail"], "a@x.com")

    def test_fresh_rebuilds(self):
        route.waiting(only="", fresh=False, user=self.user, db=self.db)
        route.waiting(only="", fresh=True, user=self.user, db=self.db)
        self.assertEqual(self.builds, 2)

    def test_people_do_not_share_a_list(self):
        route.waiting(only="", fresh=False, user=self.user, db=self.db)
        route.waiting(only="", fresh=False, user={"email": "other@greensglobal.com"}, db=self.db)
        self.assertEqual(self.builds, 2)

    def test_a_review_commit_drops_the_cached_list(self):
        self.assertIn(cache.timesheet_waiting, cache._WATCHED["TimesheetReview"])
        self.assertIn(cache.timesheet_waiting, cache._WATCHED["TimePunch"])
        self.assertIn(cache.timesheet_waiting, cache._WATCHED["ApprovalDelegation"])


if __name__ == "__main__":
    unittest.main()
