"""Word -> PDF on the DEPLOYED API, where LibreOffice cannot be installed.

Sagar, Sep 16: "I want these to be working on dev and prod also."

Azure App Service runs the blessed Python image (see the two
.github/workflows/*_greens-nexus-api*.yml - Oryx build, no Dockerfile), so
`apt-get install libreoffice` has nowhere to live that survives a restart. The
deployed answer is Microsoft Graph: stage the .docx on a drive, GET it back as
?format=pdf, delete the staged copy. That is Office's own renderer, so it meets
the same bar the local LibreOffice path does - "0 alterations means 0".

The Graph calls are stubbed here: a unit test must not write into the tenant.

    python -m unittest test_docx_convert_graph
"""
import unittest
from unittest import mock

import httpx

from services import docx_convert

PDF_BYTES = b"%PDF-1.7\nstub\n%%EOF\n"
DOCX_BYTES = b"PK\x03\x04 pretend docx"


class _Resp:
    """Only the bits of httpx.Response these call sites touch."""

    def __init__(self, status=200, *, json_body=None, content=b"", headers=None):
        self.status_code = status
        self._json = json_body or {}
        self.content = content
        self.headers = headers or {}

    @property
    def is_success(self):
        return 200 <= self.status_code < 300

    def json(self):
        return self._json


class GraphConvertTests(unittest.TestCase):
    """A deployment with Graph configured and no local converter."""

    def setUp(self):
        self.calls = []
        patches = [
            mock.patch.object(docx_convert, "_soffice_bin", lambda: ""),
            mock.patch.object(docx_convert, "_service_url", lambda: ""),
            mock.patch.object(docx_convert.graph_mail, "graph_configured", lambda: True),
            mock.patch.object(docx_convert.graph_mail, "access_token", lambda: "test-token"),
            mock.patch.object(docx_convert, "_drive_cache", ""),
            mock.patch.dict("os.environ", {"NEXUS_GRAPH_CONVERT_DRIVE_ID": "drive-1"}, clear=False),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        import os
        os.environ.pop("NEXUS_GRAPH_CONVERT_USER", None)

    def _wire_graph(self):
        """Answers the three calls the way Graph does, recording each."""
        def fake_put(url, **kw):
            self.calls.append(("PUT", url, kw))
            return _Resp(201, json_body={"id": "item-9"})

        def fake_get(url, **kw):
            self.calls.append(("GET", url, kw))
            if url.endswith("/content"):
                return _Resp(302, headers={"location": "https://download.example/abc"})
            return _Resp(200, content=PDF_BYTES)

        def fake_delete(url, **kw):
            self.calls.append(("DELETE", url, kw))
            return _Resp(204)

        for name, fn in (("put", fake_put), ("get", fake_get), ("delete", fake_delete)):
            p = mock.patch.object(httpx, name, fn)
            p.start()
            self.addCleanup(p.stop)

    # ── what the send wizard is told ─────────────────────────────────────────
    def test_reports_graph_as_the_live_engine(self):
        self.assertEqual(docx_convert.available(), {"ok": True, "engine": "graph"})

    def test_not_available_without_a_staging_drive(self):
        # Credentials alone are not enough - there has to be somewhere to stage.
        with mock.patch.dict("os.environ", {"NEXUS_GRAPH_CONVERT_DRIVE_ID": ""}, clear=False):
            self.assertEqual(docx_convert.available(), {"ok": False, "engine": ""})

    def test_not_available_without_graph_credentials(self):
        with mock.patch.object(docx_convert.graph_mail, "graph_configured", lambda: False):
            self.assertEqual(docx_convert.available(), {"ok": False, "engine": ""})

    # ── the conversion itself ────────────────────────────────────────────────
    def test_converts_and_returns_the_pdf(self):
        self._wire_graph()
        self.assertEqual(docx_convert.convert(DOCX_BYTES, "contract.docx"), PDF_BYTES)
        self.assertEqual([c[0] for c in self.calls], ["PUT", "GET", "GET", "DELETE"])

    def test_asks_for_pdf_format(self):
        self._wire_graph()
        docx_convert.convert(DOCX_BYTES, "contract.docx")
        _, url, kw = self.calls[1]
        self.assertTrue(url.endswith("/drives/drive-1/items/item-9/content"))
        self.assertEqual(kw["params"], {"format": "pdf"})

    def test_does_not_replay_the_token_onto_the_download_host(self):
        # Graph 302s to a pre-authenticated URL on another host, which rejects a
        # replayed Authorization header. Following the redirect by hand is why.
        self._wire_graph()
        docx_convert.convert(DOCX_BYTES, "contract.docx")
        self.assertIs(self.calls[1][2]["follow_redirects"], False)
        _, url, kw = self.calls[2]
        self.assertEqual(url, "https://download.example/abc")
        self.assertNotIn("Authorization", kw.get("headers") or {})

    def test_deletes_the_staged_copy(self):
        self._wire_graph()
        docx_convert.convert(DOCX_BYTES, "contract.docx")
        verb, url, _ = self.calls[-1]
        self.assertEqual(verb, "DELETE")
        self.assertTrue(url.endswith("/drives/drive-1/items/item-9"))

    def test_deletes_the_staged_copy_even_when_conversion_fails(self):
        """A contract must not be left in the tenant because Word choked."""
        deleted = []
        with mock.patch.object(httpx, "put", lambda url, **kw: _Resp(201, json_body={"id": "item-9"})), \
             mock.patch.object(httpx, "get", lambda url, **kw: _Resp(500)), \
             mock.patch.object(httpx, "delete", lambda url, **kw: (deleted.append(url), _Resp(204))[1]):
            with self.assertRaises(RuntimeError):
                docx_convert.convert(DOCX_BYTES, "contract.docx")
        self.assertTrue(deleted and deleted[0].endswith("/items/item-9"))

    def test_never_uploads_under_the_callers_filename(self):
        # The uploaded name becomes a real drive path; the caller's name is
        # whatever a user typed, and has no effect on how Word renders.
        self._wire_graph()
        docx_convert.convert(DOCX_BYTES, "../../etc/pa ssw;rd.docx")
        _, url, _ = self.calls[0]
        self.assertNotIn("pa ssw", url)
        self.assertNotIn("..", url)
        self.assertTrue(url.endswith(".docx:/content"))

    def test_rejects_a_non_pdf_answer(self):
        with mock.patch.object(httpx, "put", lambda url, **kw: _Resp(201, json_body={"id": "item-9"})), \
             mock.patch.object(httpx, "get", lambda url, **kw: _Resp(200, content=b"<html>error</html>")), \
             mock.patch.object(httpx, "delete", lambda url, **kw: _Resp(204)):
            with self.assertRaisesRegex(RuntimeError, "not a PDF"):
                docx_convert.convert(DOCX_BYTES, "contract.docx")

    def test_resolves_a_user_onedrive_once(self):
        gets = []

        def fake_get(url, **kw):
            gets.append(url)
            if url.endswith("/drive"):
                return _Resp(200, json_body={"id": "drive-from-user"})
            if url.endswith("/content"):
                return _Resp(302, headers={"location": "https://download.example/abc"})
            return _Resp(200, content=PDF_BYTES)

        with mock.patch.dict("os.environ",
                             {"NEXUS_GRAPH_CONVERT_DRIVE_ID": "",
                              "NEXUS_GRAPH_CONVERT_USER": "sign@greensglobal.com"}, clear=False), \
             mock.patch.object(httpx, "get", fake_get), \
             mock.patch.object(httpx, "put", lambda url, **kw: _Resp(201, json_body={"id": "i1"})), \
             mock.patch.object(httpx, "delete", lambda url, **kw: _Resp(204)):
            docx_convert.convert(DOCX_BYTES, "a.docx")
            docx_convert.convert(DOCX_BYTES, "b.docx")
        # A drive id never changes; resolving it per conversion would be a
        # wasted round trip in front of every send.
        self.assertEqual(sum(1 for u in gets if u.endswith("/drive")), 1)

    def test_a_laptop_with_libreoffice_does_not_touch_the_tenant(self):
        """Graph credentials in a local .env must not redirect a developer's
        conversions into the company drive - same instinct as is_sync_worker()."""
        called = []
        with mock.patch.object(docx_convert, "_soffice_bin", lambda: "/usr/bin/soffice"), \
             mock.patch.object(docx_convert, "_via_soffice",
                               lambda b, f: (called.append("soffice"), PDF_BYTES)[1]), \
             mock.patch.object(docx_convert, "_via_graph",
                               lambda b, f: (called.append("graph"), PDF_BYTES)[1]):
            docx_convert.convert(DOCX_BYTES, "contract.docx")
            self.assertEqual(called, ["soffice"])
            self.assertEqual(docx_convert.available(), {"ok": True, "engine": "libreoffice"})


if __name__ == "__main__":
    unittest.main()
