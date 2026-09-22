"""
The Copy button on the verification-code email (Sagar, Sep 22 2026: "want a
copy icon on the right of the 6 digit verification code on the email which
will copy the OTP from the email").

No email client runs JavaScript, so nothing inside the message body can reach
the clipboard. The button is a link to a one-screen page on this API that does
the copying, and the code travels in the URL FRAGMENT - the browser never
sends a fragment, so the code stays out of access logs and the Referer header
the way it always has.

    python -m unittest test_esign_otp_copy_code
"""
import os
import tempfile
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

import services.sign_otp as sign_otp   # noqa: E402
from routers import esign              # noqa: E402


class CopyLinkTests(unittest.TestCase):
    def test_the_code_is_in_the_fragment_not_the_query(self):
        url = sign_otp.copy_code_url("654489")
        self.assertTrue(url.endswith("/esign/public/copy-code#654489"), url)
        self.assertNotIn("?", url)

    def test_the_email_shows_the_code_and_a_copy_button(self):
        html = sign_otp._otp_email_html("654489", "Vendor NDA", "Sagar Shoundik")
        self.assertIn("654489", html)
        self.assertIn(sign_otp.copy_code_url("654489"), html)
        self.assertIn("Copy", html)

    def test_the_email_never_promises_an_in_mail_clipboard(self):
        """It says what the button does, because tapping it leaves the inbox."""
        html = sign_otp._otp_email_html("112233", "Vendor NDA", "")
        self.assertIn("Copy opens a page", html)
        self.assertNotIn("<script", html.lower())


class CopyPageTests(unittest.TestCase):
    def setUp(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.include_router(esign.router)
        self.client = TestClient(app)

    def test_the_page_is_served_and_is_self_contained(self):
        r = self.client.get("/esign/public/copy-code")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/html", r.headers["content-type"])
        self.assertIn("Copy Code", r.text)
        # No bundle, no font, no icon host - it opens from a phone's mail app.
        self.assertNotIn("<img", r.text.lower())
        self.assertNotIn("http://", r.text)
        self.assertNotIn("https://", r.text)

    def test_the_server_is_never_told_the_code(self):
        """Nothing to log: the page reads location.hash, which never leaves
        the browser."""
        r = self.client.get("/esign/public/copy-code")
        self.assertIn("location.hash", r.text)
        self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertEqual(r.headers["referrer-policy"], "no-referrer")
        self.assertIn("noindex", r.headers["x-robots-tag"])

    def test_it_is_not_swallowed_by_the_token_route(self):
        """/public/{token} is declared right below it; if the order ever flips
        this path becomes a token lookup and 404s."""
        r = self.client.get("/esign/public/copy-code")
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
