"""The shared connection pool to the accounting app (11/11/2026, speed pass):
reads go through one kept-open client, a connection the far end closed while
idle is retried once, and the timing line never carries a parameter."""
import contextlib
import io
import unittest

import httpx

from routers import accounting as acct


class FakeClient:
    def __init__(self, fail_first):
        self.calls = []
        self.fail_first = fail_first

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(url)
        if self.fail_first and len(self.calls) == 1:
            raise self.fail_first("connection gone")
        return httpx.Response(200, json={"ok": True}, request=httpx.Request("GET", url))


class SharedPoolTests(unittest.TestCase):
    def setUp(self):
        self.saved = (acct._acct_http, acct._ACCT_BASE)
        acct._ACCT_BASE = "https://acct.invalid"

    def tearDown(self):
        acct._acct_http, acct._ACCT_BASE = self.saved

    def _run(self, fail_first):
        client = FakeClient(fail_first)
        acct._acct_http = lambda: client
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            r = acct.acct_get("https://acct.invalid/api/internal/reports/gl", params={"q": "Sunbelt Rentals", "op": "lines"})
        return client, r, out.getvalue()

    def test_a_dropped_idle_connection_is_tried_once_more(self):
        for err in (httpx.RemoteProtocolError, httpx.WriteError):
            client, r, _ = self._run(fail_first=err)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(len(client.calls), 2)

    def test_a_read_the_server_was_working_on_is_not_sent_again(self):
        for err in (httpx.ReadError, httpx.ReadTimeout):
            with self.assertRaises(err):
                self._run(fail_first=err)

    def test_the_timing_line_names_the_call_but_never_its_parameters(self):
        client, _, log = self._run(fail_first=None)
        self.assertEqual(len(client.calls), 1)
        self.assertIn("[acct-timing] upstream", log)
        self.assertIn("path=/api/internal/reports/gl#lines", log)
        self.assertNotIn("Sunbelt", log)

    def test_one_client_is_shared(self):
        acct._acct_http = self.saved[0]
        self.assertIs(acct._acct_http(), acct._acct_http())


if __name__ == "__main__":
    unittest.main()
