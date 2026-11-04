"""Egnyte throttling is "slow down", not "broken" or "no access" (Nov 4 2026).

A walked Filing & Sorting scan of a deep tree hit Egnyte's per-user rate
limit. services/egnyte._raise flattened the 429 to 502, which Cloudflare
replaced with its own Bad Gateway page; an over-QPS 403 would have read as
"you may not see this folder". These pin the mapping and the router's
wait-and-retry. No network, no database.

Run alone: python -m pytest test_egnyte_throttle.py
"""
import unittest
from unittest import mock

import httpx
from fastapi import HTTPException

from services import egnyte as svc


def _resp(status: int, text: str = "") -> httpx.Response:
    return httpx.Response(status, text=text, request=httpx.Request("GET", "https://x.test/"))


class TestRaiseMapping(unittest.TestCase):
    def _status_of(self, resp):
        with self.assertRaises(svc.EgnyteError) as cm:
            svc._raise(resp, "Could not browse Egnyte")
        return cm.exception.status

    def test_429_stays_429(self):
        self.assertEqual(self._status_of(_resp(429, "Too Many Requests")), 429)

    def test_over_qps_403_is_throttling_not_no_access(self):
        self.assertEqual(self._status_of(_resp(403, "<h1>Developer Over Qps</h1>")), 429)
        self.assertEqual(self._status_of(_resp(403, "Developer Over Rate")), 429)

    def test_real_403_and_404_unchanged(self):
        self.assertEqual(self._status_of(_resp(403, "Forbidden")), 403)
        self.assertEqual(self._status_of(_resp(404, "Not found")), 404)

    def test_other_errors_still_502(self):
        self.assertEqual(self._status_of(_resp(500, "boom")), 502)


class TestFilingRetry(unittest.TestCase):
    def test_throttled_call_is_retried_then_succeeds(self):
        from routers import filing
        calls = {"n": 0}

        def fake_call(fn, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] < 3:
                raise HTTPException(429, "busy")
            return {"files": [], "folders": []}

        with mock.patch.object(filing, "_call", fake_call), \
                mock.patch.object(filing, "_pace", lambda token: None), \
                mock.patch("time.sleep") as slept:
            out = filing._egnyte(None, svc.list_folder, "/Shared/x")
        self.assertEqual(out, {"files": [], "folders": []})
        self.assertEqual(calls["n"], 3)
        self.assertEqual(slept.call_count, 2)

    def test_gives_up_with_words_after_the_retries(self):
        from routers import filing

        def always_busy(fn, *args, **kwargs):
            raise HTTPException(429, "busy")

        with mock.patch.object(filing, "_call", always_busy), \
                mock.patch.object(filing, "_pace", lambda token: None), mock.patch("time.sleep"):
            with self.assertRaises(HTTPException) as cm:
                filing._egnyte(None, svc.list_folder, "/Shared/x")
        self.assertEqual(cm.exception.status_code, 429)
        self.assertIn("busy", cm.exception.detail)

    def test_401_is_never_retried(self):
        from routers import filing
        calls = {"n": 0}

        def expired(fn, *args, **kwargs):
            calls["n"] += 1
            raise HTTPException(401, "expired")

        with mock.patch.object(filing, "_call", expired), mock.patch("time.sleep"):
            with self.assertRaises(HTTPException) as cm:
                filing._egnyte("user-token", svc.list_folder, "/Shared/x")
        self.assertEqual(cm.exception.status_code, 401)
        self.assertEqual(calls["n"], 1)
        self.assertIn("Connect", cm.exception.detail)


class TestLanes(unittest.TestCase):
    def test_a_lane_reports_its_own_egnyte_cost(self):
        from routers import filing

        def fake_egnyte(token, fn, root):
            filing._meter_add(calls=1, waited=0.25)
            return {"files": [], "folders": []}

        with mock.patch.object(filing, "_egnyte", fake_egnyte):
            root, outcome, calls, waited, throttled = filing._list_lane("tok", "/Shared/x")
        self.assertEqual((root, calls, waited, throttled), ("/Shared/x", 1, 0.25, 0))
        self.assertEqual(outcome, {"files": [], "folders": []})

    def test_a_failed_lane_is_a_result_not_an_exception(self):
        from routers import filing

        def nope(token, fn, root):
            raise HTTPException(404, "gone")

        with mock.patch.object(filing, "_egnyte", nope):
            _, outcome, *_ = filing._list_lane("tok", "/Shared/x")
        self.assertIsInstance(outcome, HTTPException)
        self.assertEqual(outcome.status_code, 404)

    def test_lanes_keep_the_folders_in_order(self):
        from routers import filing
        roots = [f"/Shared/{i}" for i in range(7)]
        with mock.patch.object(filing, "_egnyte", lambda t, fn, r: {"files": [], "folders": [], "r": r}):
            got = [o["r"] for _, o, *_ in filing._lane_pool.map(lambda r: filing._list_lane("t", r), roots)]
        self.assertEqual(got, roots)


class TestPacing(unittest.TestCase):
    def test_calls_for_one_identity_are_spaced(self):
        from routers import filing
        filing._pace_last.clear()
        waits = []
        with mock.patch("time.sleep", side_effect=waits.append):
            for _ in range(3):
                filing._pace("tok-a")
        # First call goes straight through; the next two wait about _PACE_SEC
        # and twice that (the slots are reserved back to back).
        self.assertEqual(len(waits), 2)
        self.assertGreater(waits[0], filing._PACE_SEC * 0.8)
        self.assertGreater(waits[1], filing._PACE_SEC * 1.8)

    def test_identities_do_not_wait_on_each_other(self):
        from routers import filing
        filing._pace_last.clear()
        waits = []
        with mock.patch("time.sleep", side_effect=waits.append):
            filing._pace("tok-a")
            filing._pace("tok-b")
        self.assertEqual(waits, [])


if __name__ == "__main__":
    unittest.main()
