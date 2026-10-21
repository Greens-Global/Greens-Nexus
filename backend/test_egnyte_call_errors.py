"""Egnyte reads that fail on the wire (Oct 22, Charmi: Change Loan > Browse a
folder said "Can't reach Nexus right now") - as tests.

A slow or unreachable Egnyte raised httpx's own exceptions, which the routes'
`_call` did not map: the request ended as an unhandled 500, or - with the
listing allowed 20 seconds against the browser's 18 - as no answer at all,
which the app words as Nexus being down. Now a timeout is a 504 and any other
network failure a 502, each saying it was Egnyte and what to do instead, and
a folder listing gives up before the browser does. Egnyte itself is never
called: the service function is replaced.

    python -m pytest test_egnyte_call_errors.py -q
"""
import unittest

import httpx
from fastapi import HTTPException

from routers import egnyte as egnyte_router
from services import egnyte as svc


class CallErrorTests(unittest.TestCase):
    def setUp(self):
        self._configured, svc.configured = svc.configured, lambda: True

    def tearDown(self):
        svc.configured = self._configured

    def _status(self, exc):
        def boom(*_a, **_k):
            raise exc
        with self.assertRaises(HTTPException) as ctx:
            egnyte_router._call(boom, "/Shared/Loans")
        return ctx.exception

    def test_a_timeout_is_504_and_says_egnyte(self):
        e = self._status(httpx.ConnectTimeout("timed out"))
        self.assertEqual(e.status_code, 504)
        self.assertIn("Egnyte did not answer in time", e.detail)
        self.assertEqual(self._status(httpx.ReadTimeout("slow")).status_code, 504)

    def test_a_network_failure_is_502_and_says_egnyte(self):
        e = self._status(httpx.ConnectError("refused"))
        self.assertEqual(e.status_code, 502)
        self.assertIn("Could not reach Egnyte", e.detail)

    def test_egnyte_answers_keep_their_status(self):
        self.assertEqual(self._status(svc.EgnyteError("Could not browse Egnyte: not found", 404)).status_code, 404)

    def test_not_configured_is_still_503(self):
        svc.configured = lambda: False
        self.assertEqual(self._status(httpx.ConnectError("x")).status_code, 503)

    def test_a_listing_gives_up_before_the_browser(self):
        # api.js aborts a request at 18 seconds (FETCH_TIMEOUT_MS).
        self.assertLess(svc.TIMEOUT_LIST, 18)


if __name__ == "__main__":
    unittest.main()
