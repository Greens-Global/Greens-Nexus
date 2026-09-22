"""
The batch of signing-experience fixes from Sagar, Sep 22 2026:

  * "Download a copy to read or print" saved a BLANK .htm. The server put a
    relative URL in copyUrl when NEXUS_API_URL was unset, the browser resolved
    it against the SPA origin, and Cloudflare answered with index.html.
  * "Download" must hand back the document WITHOUT the Certificate of
    Completion; "Download Signed Copy" keeps the whole sealed record.
  * The completion email must not offer "Open in Nexus" to an external signer -
    they have no account, so it can only reach a sign-in screen.
  * The sender block needs an icon before the address and the phone, and the
    phone needs its country code to be dialable by a stranger.

    python -m unittest test_esign_copy_and_contacts
"""
import io
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from routers import esign  # noqa: E402

SENDER = {"name": "Sagar Kumar Shoundik", "email": "sagar.shoundik@greensglobal.com",
          "title": "Global Admin", "phone": "+91 9431556836", "entity": "Greens Global"}


def _party(kind: str, name: str = "Test Sagar"):
    return SimpleNamespace(kind=kind, name=name, email="test@partner.example",
                           id="party-1", token="tok", role_key="a")


def _pdf(pages: int) -> bytes:
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for i in range(pages):
        c.drawString(100, 700, f"page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


class ApiBaseTests(unittest.TestCase):
    def test_it_never_returns_an_empty_base_on_a_deployed_api(self):
        """An empty base makes copyUrl relative, and a relative copyUrl is how
        the signer ended up downloading the SPA's index.html."""
        with patch.dict(os.environ, {"NEXUS_API_URL": "", "WEBSITE_HOSTNAME": "api.example.net"}):
            self.assertEqual(esign._api_base(), "https://api.example.net")

    def test_an_explicit_override_still_wins(self):
        with patch.dict(os.environ, {"NEXUS_API_URL": "https://api.nexus.test/",
                                     "WEBSITE_HOSTNAME": "api.example.net"}):
            self.assertEqual(esign._api_base(), "https://api.nexus.test")


class DocumentWithoutCertificateTests(unittest.TestCase):
    def setUp(self):
        self.sealed = _pdf(5)          # 3 pages of document + 2 of certificate
        self.req = SimpleNamespace(id="env-1", title="Joining Letter", content_pages=3,
                                   final_pdf_path="esign/env-1/final.pdf",
                                   certificate_snapshot={})

    def _split(self):
        result = esign._StorageResult(True, content=self.sealed)
        with patch.object(esign, "_storage_fetch", return_value=result):
            return esign._document_without_certificate(self.req)

    def test_the_certificate_pages_are_left_behind(self):
        from pypdf import PdfReader
        out = self._split()
        self.assertTrue(out)
        self.assertEqual(len(PdfReader(io.BytesIO(out)).pages), 3)

    def test_an_envelope_with_no_recorded_split_falls_back_to_the_whole_file(self):
        """Better the whole sealed record than no reading copy at all."""
        self.req.content_pages = 0
        self.assertEqual(self._split(), b"")

    def test_a_nonsense_page_count_is_refused_rather_than_trusted(self):
        self.req.content_pages = 99
        self.assertEqual(self._split(), b"")

    def test_a_storage_failure_is_not_an_exception(self):
        with patch.object(esign, "_storage_fetch",
                          return_value=esign._StorageResult(False, text="gone")):
            self.assertEqual(esign._document_without_certificate(self.req), b"")


class SealedEmailTests(unittest.TestCase):
    def _html(self, party):
        sent = {}

        def _capture(**kw):
            sent.update(kw)
            return True, ""

        with patch.object(esign, "_graph_send_mail", side_effect=_capture), \
             patch.dict(os.environ, {"NEXUS_FROM_EMAIL": "nexus@greensglobal.com"}):
            esign._send_sealed_email(
                "Test Sagar", "test@partner.example",
                SimpleNamespace(id="env-1", title="Joining Letter", final_sha256="8b9d90dd" * 8,
                                created_at="2026-09-22T10:00:00+00:00", message="", expires_on=""),
                b"%PDF-1.4 tiny", "https://nexus.example/documents",
                view_link="https://nexus.example/sign/tok", sender=SENDER, party=party)
        return sent.get("html", "")

    def test_an_external_signer_is_not_sent_to_a_login_they_do_not_have(self):
        html = self._html(_party("external"))
        self.assertNotIn("Open in Nexus", html)
        self.assertIn(">View<", html)
        self.assertIn(">Download<", html)

    def test_an_internal_recipient_still_gets_it(self):
        html = self._html(_party("internal", "Charmi"))
        self.assertIn("Open in Nexus", html)

    def test_the_sender_copy_still_gets_it(self):
        self.assertIn("Open in Nexus", self._html(None))


class SenderContactTests(unittest.TestCase):
    def test_the_request_email_puts_an_icon_before_each_contact(self):
        html = esign._sign_email_html(
            SimpleNamespace(name="Test Sagar", email="test@partner.example",
                            token="tok", kind="external"),
            SimpleNamespace(id="env-1", title="Joining Letter", message="",
                            expires_on="", created_at="2026-09-22T10:00:00+00:00"),
            SENDER, "https://nexus.example/sign/tok")
        self.assertIn("&#9993;", html)                    # envelope, before the address
        self.assertIn("&#9742;", html)                    # handset, before the number
        self.assertIn("+91 9431556836", html)
        self.assertIn('href="tel:+919431556836"', html)

    def test_a_number_that_already_carries_its_country_code_is_only_respaced(self):
        self.assertEqual(esign._display_phone("+91 94315 56836"), "+91 9431556836")

    def test_a_bare_number_borrows_the_deployments_country(self):
        with patch.dict(os.environ, {"NEXUS_SMS_DEFAULT_COUNTRY": "91"}):
            self.assertEqual(esign._display_phone("9431556836"), "+91 9431556836")

    def test_something_unparseable_is_left_exactly_as_the_directory_has_it(self):
        self.assertEqual(esign._display_phone("ext. 4410"), "ext. 4410")
        self.assertEqual(esign._display_phone(""), "")


if __name__ == "__main__":
    unittest.main()
