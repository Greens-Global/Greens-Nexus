"""The signature-request email's From line and its dates.

Two things a recipient reads before they trust the mail at all:

  * the From name - "<sender> via Nexus Sign", the whole reason a stranger
    opens it (Neil, Sep 16), and
  * any date in the body, which has to be the app-wide MM/DD/YYYY and not the
    raw ISO string the template used to interpolate (Sagar, Sep 22).

No DB and no network: the builders only read attributes off the party/request,
so plain stand-ins are enough to pin the rendered HTML.

Run with: python -m unittest test_esign_request_email
"""
import os
import unittest
from types import SimpleNamespace

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import base64
import email

from routers import esign as esign_mod
from routers.esign import _from_display, _sign_email_html, _graph_send_mail

SENDER = {"name": "Sagar Shoundik", "email": "sagar.shoundik@greensglobal.com",
          "title": "Software Engineer", "phone": "", "entity": "Greens Global"}


def _party():
    return SimpleNamespace(name="Jane Roe", email="jane@example.com",
                           token="tok-1", kind="external")


def _req(**over):
    base = dict(id="env-1", title="Mutual NDA", message="", expires_on="2026-10-15",
                created_at="2026-09-22T10:00:00+00:00", status="pending")
    base.update(over)
    return SimpleNamespace(**base)


class RequestEmailTests(unittest.TestCase):
    def test_the_from_name_is_the_sender_via_nexus_sign(self):
        self.assertEqual(_from_display("Sagar Shoundik"), "Sagar Shoundik via Nexus Sign")

    def test_an_unnamed_sender_still_reads_as_a_person_not_a_blank(self):
        self.assertEqual(_from_display(""), "A colleague via Nexus Sign")

    def test_the_expiry_date_is_us_format_never_iso(self):
        html = _sign_email_html(_party(), _req(), SENDER, "https://nexus.example/sign/tok-1")
        self.assertIn("expires on 10/15/2026", html)
        self.assertNotIn("2026-10-15", html)

    def test_the_contact_us_mailto_dates_the_request_the_same_way(self):
        html = _sign_email_html(_party(), _req(), SENDER, "https://nexus.example/sign/tok-1")
        # urlencoded into the mailto body as "Date sent: 09/22/2026" - quote()
        # leaves the slashes alone, so they survive verbatim.
        self.assertIn("Date%20sent%3A%2009/22/2026", html)

    def test_no_expiry_prints_no_expiry_line(self):
        html = _sign_email_html(_party(), _req(expires_on=""), SENDER, "https://nexus.example/x")
        self.assertNotIn("expires on", html)

    def test_the_senders_name_is_in_the_body_and_the_sent_by_block(self):
        html = _sign_email_html(_party(), _req(), SENDER, "https://nexus.example/x")
        self.assertGreaterEqual(html.count("Sagar Shoundik"), 2)


class _Resp:
    def __init__(self, code=202, text=""):
        self.status_code, self.text = code, text

    @property
    def is_success(self):
        return 200 <= self.status_code < 300


class _FakeHttpx:
    """Records the posts and answers them from a scripted list of responses."""

    def __init__(self, *responses):
        self.calls, self._responses = [], list(responses)

    def post(self, url, **kw):
        self.calls.append((url, kw))
        return self._responses.pop(0) if self._responses else _Resp()


class GraphSendTests(unittest.TestCase):
    """The From display name only survives on the MIME path - Exchange
    overwrites the JSON message object's name with the mailbox's own."""

    def setUp(self):
        self._real_httpx, self._real_token = esign_mod.httpx, esign_mod._graph_token
        esign_mod._graph_token = lambda: "tok"

    def tearDown(self):
        esign_mod.httpx, esign_mod._graph_token = self._real_httpx, self._real_token

    def _send(self, *responses, **over):
        esign_mod.httpx = fake = _FakeHttpx(*responses)
        kw = dict(from_addr="nexus@greensglobal.com",
                  display_name="Sagar Kumar Shoundik via Nexus Sign",
                  to_email="jane@example.com", subject="Action needed: Please sign Invoice Template",
                  html="<p>Hi <strong>Jane</strong></p>", reply_to=SENDER["email"])
        kw.update(over)
        return fake, _graph_send_mail(**kw)

    def _posted_mime(self, fake):
        return email.message_from_bytes(base64.b64decode(fake.calls[0][1]["content"]))

    def test_the_mime_from_header_carries_the_sender_name(self):
        fake, (ok, detail) = self._send()
        self.assertTrue(ok)
        self.assertEqual(detail, "")
        msg = self._posted_mime(fake)
        # parseaddr rather than the raw header: formataddr only quotes a
        # display name that needs it, and the quoting is not the point.
        name, addr = email.utils.parseaddr(msg["From"])
        self.assertEqual(name, "Sagar Kumar Shoundik via Nexus Sign")
        self.assertEqual(addr, "nexus@greensglobal.com")
        self.assertEqual(msg["Reply-To"], SENDER["email"])
        self.assertEqual(msg["To"], "jane@example.com")

    def test_mime_is_posted_as_base64_text_not_the_json_envelope(self):
        fake, _ = self._send()
        url, kw = fake.calls[0]
        self.assertEqual(kw["headers"]["Content-Type"], "text/plain")
        self.assertNotIn("json", kw)
        self.assertIn("/sendMail", url)

    def test_both_a_text_and_an_html_part_are_sent(self):
        fake, _ = self._send()
        types = [p.get_content_type() for p in self._posted_mime(fake).walk()]
        self.assertIn("text/plain", types)
        self.assertIn("text/html", types)

    def test_a_pdf_rides_along_when_one_is_given(self):
        fake, (ok, _) = self._send(pdf=("Invoice Template (signed).pdf", b"%PDF-1.7 fake"))
        self.assertTrue(ok)
        names = [p.get_filename() for p in self._posted_mime(fake).walk() if p.get_filename()]
        self.assertEqual(names, ["Invoice Template (signed).pdf"])

    def test_a_refused_mime_send_falls_back_to_json_rather_than_dropping_the_mail(self):
        fake, (ok, detail) = self._send(_Resp(400, "MIME not accepted"))
        self.assertTrue(ok)                       # the mail still went
        self.assertIn("json fallback", detail)    # and the log says how
        self.assertEqual(len(fake.calls), 2)
        self.assertIn("json", fake.calls[1][1])

    def test_both_paths_failing_is_reported_as_a_failure(self):
        fake, (ok, detail) = self._send(_Resp(400, "nope"), _Resp(500, "also nope"))
        self.assertFalse(ok)
        self.assertIn("json also failed", detail)


if __name__ == "__main__":
    unittest.main()
