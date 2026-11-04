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
                mock.patch("time.sleep") as slept:
            out = filing._egnyte(None, svc.list_folder, "/Shared/x")
        self.assertEqual(out, {"files": [], "folders": []})
        self.assertEqual(calls["n"], 3)
        self.assertEqual(slept.call_count, 2)

    def test_gives_up_with_words_after_the_retries(self):
        from routers import filing

        def always_busy(fn, *args, **kwargs):
            raise HTTPException(429, "busy")

        with mock.patch.object(filing, "_call", always_busy), mock.patch("time.sleep"):
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


if __name__ == "__main__":
    unittest.main()
