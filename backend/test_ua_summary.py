"""ua_summary.summarize - the ONE "Windows 10/11 - Chrome" gloss (Neil,
11/02/2026), extracted from routers/esign.py and services/certificate.py so
the sign-in notice, the certificate and the signer's device line all say the
same thing about the same browser.
    python -m pytest test_ua_summary.py
"""
import os
import tempfile
import unittest

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import ua_summary  # noqa: E402

IOS = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
       "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")
MAC = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
       "(KHTML, like Gecko) Version/17.5 Safari/605.1.15")
WIN_EDGE = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0")
WIN_CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/126.0.0.0 Safari/537.36")
ANDROID = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
           "Chrome/126.0.0.0 Mobile Safari/537.36")


class Summarize(unittest.TestCase):
    def test_common_agents(self):
        self.assertEqual(ua_summary.summarize(IOS), "iOS - Safari")          # iPhone before "Mac OS X"
        self.assertEqual(ua_summary.summarize(MAC), "macOS - Safari")
        self.assertEqual(ua_summary.summarize(WIN_EDGE), "Windows 10/11 - Edge")   # Edge before Chrome
        self.assertEqual(ua_summary.summarize(WIN_CHROME), "Windows 10/11 - Chrome")
        self.assertEqual(ua_summary.summarize(ANDROID), "Android - Chrome")  # Android before Linux

    def test_unknown_and_empty(self):
        self.assertEqual(ua_summary.summarize("curl/8.4.0"), "Unrecognized user agent")
        self.assertEqual(ua_summary.summarize(""), "")
        self.assertEqual(ua_summary.summarize(None), "")
        self.assertEqual(ua_summary.summarize("   "), "")

    def test_one_half_known(self):
        self.assertEqual(ua_summary.summarize("Mozilla/5.0 (Windows NT 10.0) SomethingElse/1.0"), "Windows 10/11")
        self.assertEqual(ua_summary.summarize("Firefox/130.0 on a toaster"), "Firefox")

    def test_esign_and_certificate_use_it(self):
        """Both former copies are the same function now - no drift possible."""
        from routers import esign
        from services import certificate
        self.assertIs(esign._ua_summary, ua_summary.summarize)
        self.assertIs(certificate._ua_summary, ua_summary.summarize)
        self.assertFalse(hasattr(esign, "_OS_PATTERNS"))
        self.assertFalse(hasattr(certificate, "_OS_PATTERNS"))


if __name__ == "__main__":
    unittest.main()
