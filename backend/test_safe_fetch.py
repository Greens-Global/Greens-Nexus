"""The server only fetches images from where it is allowed to (code review, Oct 2026).

The document export, the QA workbook and the AI auto-photo each downloaded a
URL somebody else chose with a bare httpx.get, so any of them could be pointed
at 169.254.169.254, localhost or a private range. safe_fetch.py is the one
rule now; this file checks it, and checks the three callers actually use it.

No real network: DNS is a table in this file and every request lands on an
httpx.MockTransport that records it.

    python -m unittest test_safe_fetch
"""
import base64
import io
import os
import unittest
from unittest import mock

# Before anything reads it at import (routers/files.py does).
STORAGE = "https://proj.supabase.co"
os.environ["SUPABASE_URL"] = STORAGE
os.environ.pop("SUPABASE_SERVICE_KEY", None)
os.environ["NEXUS_APP_URL"] = "https://nexus.example.com"

import httpx  # noqa: E402

import safe_fetch  # noqa: E402

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGOUrwhgwAaYsIoO"
    "WgkAuYEA9zepg3IAAAAASUVORK5CYII=")

_RealClient = httpx.Client   # the auto-photo test swaps httpx.Client out for its upload stub

DNS = {
    "cdn.example.com": ["93.184.216.34"],
    "shop.example.com": ["93.184.216.35"],
    "v6.example.com": ["2606:4700:4700::1111", "93.184.216.36"],
    "intranet.example.com": ["10.0.0.5"],
    "mixed.example.com": ["93.184.216.34", "192.168.1.10"],   # one private answer among public ones
    "ula.example.com": ["fd12:3456:789a::1"],
    "localhost": ["127.0.0.1"],
}


def _getaddrinfo(host, *_a, **_k):
    import ipaddress
    import socket
    try:
        ipaddress.ip_address(host.strip("[]"))
        answers = [host.strip("[]")]
    except ValueError:
        if host not in DNS:
            raise socket.gaierror(host)
        answers = DNS[host]
    return [(socket.AF_INET6 if ":" in a else socket.AF_INET, 1, 6, "", (a, 0)) for a in answers]


class _Net:
    """Fake DNS + a recording transport, for the length of one test."""

    def __init__(self, handler):
        self.requests = []

        def record(request):
            self.requests.append(request)
            return handler(request)
        self._transport = httpx.MockTransport(record)

    def __enter__(self):
        self._patches = [
            mock.patch.object(safe_fetch.socket, "getaddrinfo", _getaddrinfo),
            mock.patch.object(safe_fetch, "_new_client",
                              lambda timeout: _RealClient(transport=self._transport, timeout=timeout)),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()


def _png(_request=None):
    return httpx.Response(200, content=PNG_BYTES, headers={"content-type": "image/png"})


class RefusedBeforeAnyRequestTests(unittest.TestCase):
    def _refused(self, url):
        with _Net(_png) as net:
            with self.assertRaises(safe_fetch.FetchRefused):
                safe_fetch.fetch(url)
            self.assertEqual(net.requests, [], f"{url} must not be requested at all")

    def test_private_range(self):
        self._refused("http://10.0.0.5/a.png")
        self._refused("http://192.168.1.1/a.png")
        self._refused("http://intranet.example.com/a.png")

    def test_loopback(self):
        self._refused("http://127.0.0.1:8000/health")
        self._refused("http://localhost/a.png")

    def test_cloud_metadata_link_local(self):
        self._refused("http://169.254.169.254/latest/meta-data/")

    def test_ipv6_loopback_and_unique_local(self):
        self._refused("http://[::1]/a.png")
        self._refused("http://[fd00::1]/a.png")
        self._refused("http://ula.example.com/a.png")
        self._refused("http://[::ffff:127.0.0.1]/a.png")   # IPv4 loopback in an IPv6 coat

    def test_one_private_answer_among_public_ones(self):
        self._refused("http://mixed.example.com/a.png")

    def test_a_name_that_does_not_resolve(self):
        self._refused("http://nowhere.invalid/a.png")

    def test_schemes_other_than_http(self):
        for url in ("file:///etc/passwd", "ftp://cdn.example.com/a.png", "gopher://cdn.example.com/",
                    "data:image/png;base64,AAAA", "//cdn.example.com/a.png", "", "not a url"):
            self._refused(url)


class PublicFetchTests(unittest.TestCase):
    def test_a_normal_public_image(self):
        with _Net(_png) as net:
            got = safe_fetch.fetch("https://cdn.example.com/a.png")
            self.assertEqual((got.status_code, got.content_type, got.content), (200, "image/png", PNG_BYTES))
            self.assertEqual(got.url, "https://cdn.example.com/a.png")
            self.assertEqual(safe_fetch.fetch_image("https://cdn.example.com/a.png"), PNG_BYTES)
            self.assertEqual(len(net.requests), 2)

    def test_the_connection_is_pinned_to_the_address_that_was_checked(self):
        # DNS rebinding: the request goes to the checked IP, the name travels
        # in Host and in the TLS SNI / certificate check.
        with _Net(_png) as net:
            safe_fetch.fetch("https://cdn.example.com:8443/a.png")
            req = net.requests[0]
            self.assertEqual(req.url.host, "93.184.216.34")
            self.assertEqual(req.url.port, 8443)
            self.assertEqual(req.headers["host"], "cdn.example.com:8443")
            self.assertEqual(req.extensions.get("sni_hostname"), "cdn.example.com")

    def test_ipv4_is_preferred_when_a_host_has_both(self):
        with _Net(_png) as net:
            safe_fetch.fetch("http://v6.example.com/a.png")
            self.assertEqual(net.requests[0].url.host, "93.184.216.36")

    def test_a_public_url_that_redirects_to_a_private_one(self):
        def handler(request):
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
        with _Net(handler) as net:
            with self.assertRaises(safe_fetch.FetchRefused):
                safe_fetch.fetch("https://cdn.example.com/a.png")
            self.assertEqual(len(net.requests), 1, "the redirect target must not be requested")
            self.assertIsNone(safe_fetch.fetch_image("https://cdn.example.com/a.png"))

    def test_a_redirect_between_public_hosts_is_followed_and_rechecked(self):
        def handler(request):
            if request.headers["host"] == "cdn.example.com":
                return httpx.Response(301, headers={"location": "https://shop.example.com/b.png"})
            return _png()
        with _Net(handler) as net:
            got = safe_fetch.fetch("https://cdn.example.com/a.png")
            self.assertEqual(got.url, "https://shop.example.com/b.png")
            self.assertEqual([r.url.host for r in net.requests], ["93.184.216.34", "93.184.216.35"])

    def test_a_relative_redirect_stays_on_the_host(self):
        def handler(request):
            if request.url.path == "/a.png":
                return httpx.Response(302, headers={"location": "/real/a.png"})
            return _png()
        with _Net(handler):
            self.assertEqual(safe_fetch.fetch("https://cdn.example.com/a.png").url,
                             "https://cdn.example.com/real/a.png")

    def test_a_redirect_loop_gives_up(self):
        def handler(request):
            return httpx.Response(302, headers={"location": "https://cdn.example.com/again"})
        with _Net(handler) as net:
            with self.assertRaises(safe_fetch.FetchRefused):
                safe_fetch.fetch("https://cdn.example.com/a.png")
            self.assertEqual(len(net.requests), safe_fetch.MAX_HOPS + 1)

    def test_an_oversize_body_is_refused_by_its_declared_length(self):
        def handler(request):
            return httpx.Response(200, content=b"x" * 2048, headers={"content-type": "image/png"})
        with _Net(handler):
            with self.assertRaises(safe_fetch.FetchRefused):
                safe_fetch.fetch("https://cdn.example.com/a.png", max_bytes=1024)

    def test_an_oversize_body_is_refused_while_streaming(self):
        # No Content-Length to trust: the cap has to bite on the bytes themselves.
        def body():
            for _ in range(64):
                yield b"x" * 1024
        def handler(request):
            return httpx.Response(200, content=body(), headers={"content-type": "image/png"})
        with _Net(handler):
            with self.assertRaises(safe_fetch.FetchRefused):
                safe_fetch.fetch("https://cdn.example.com/a.png", max_bytes=4096)
            self.assertIsNone(safe_fetch.fetch_image("https://cdn.example.com/a.png", max_bytes=4096))

    def test_fetch_image_wants_an_image(self):
        def handler(request):
            return httpx.Response(200, content=b"<html></html>", headers={"content-type": "text/html"})
        with _Net(handler):
            self.assertIsNone(safe_fetch.fetch_image("https://cdn.example.com/a.png"))
        with _Net(lambda r: httpx.Response(404, content=PNG_BYTES, headers={"content-type": "image/png"})):
            self.assertIsNone(safe_fetch.fetch_image("https://cdn.example.com/a.png"))

    def test_a_network_error_is_not_an_exception_for_fetch_image(self):
        def handler(request):
            raise httpx.ConnectError("down")
        with _Net(handler):
            self.assertIsNone(safe_fetch.fetch_image("https://cdn.example.com/a.png"))

    def test_tls_verification_is_on(self):
        client = safe_fetch._new_client(5)
        try:
            import ssl
            ctx = client._transport._pool._ssl_context
            self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(ctx.check_hostname)
            self.assertFalse(client.follow_redirects)
        finally:
            client.close()


class OwnStorageTests(unittest.TestCase):
    OWN = f"{STORAGE}/storage/v1/object/public/document-images/logo.png"

    def test_an_image_in_the_apps_own_storage(self):
        with _Net(_png) as net:
            self.assertEqual(safe_fetch.own_image(self.OWN), PNG_BYTES)
            self.assertEqual(str(net.requests[0].url), self.OWN)

    def test_anything_else_is_not_requested(self):
        with _Net(_png) as net:
            for url in ("http://169.254.169.254/", "https://cdn.example.com/a.png",
                        "https://proj.supabase.co.evil.example.com/storage/v1/object/public/x/a.png",
                        f"{STORAGE}/auth/v1/admin/users", "file:///etc/passwd", ""):
                self.assertIsNone(safe_fetch.own_image(url), url)
            self.assertEqual(net.requests, [])

    def test_a_redirect_out_of_storage_is_not_followed(self):
        def handler(request):
            return httpx.Response(302, headers={"location": "http://169.254.169.254/"})
        with _Net(handler) as net:
            self.assertIsNone(safe_fetch.own_image(self.OWN))
            self.assertEqual(len(net.requests), 1)

    def test_a_private_bucket_is_read_through_a_signed_url(self):
        from routers import files
        signed = f"{STORAGE}/storage/v1/object/sign/qa-evidence/run/shot.png?token=t"
        with _Net(_png) as net, mock.patch.object(files, "_SERVICE_KEY", "k"), \
                mock.patch.object(files, "_sign", lambda bucket, path: signed):
            got = safe_fetch.own_image(f"{STORAGE}/storage/v1/object/public/qa-evidence/run/shot.png")
            self.assertEqual(got, PNG_BYTES)
            self.assertEqual(str(net.requests[0].url), signed)

    def test_nothing_is_fetched_when_storage_is_not_configured(self):
        with _Net(_png) as net, mock.patch.dict(os.environ, {"SUPABASE_URL": ""}):
            self.assertIsNone(safe_fetch.own_image(self.OWN))
            self.assertEqual(net.requests, [])


def _pdf_image_count(pdf_bytes):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(pdf_bytes))
    return sum(len(list(((p.get("/Resources") or {}).get("/XObject") or {}).keys()))
               for p in reader.pages)


def _doc(src):
    return {"type": "doc", "content": [
        {"type": "paragraph", "content": [{"type": "image", "attrs": {"src": src, "width": 22, "height": 22}},
                                          {"type": "text", "text": "Neil Kadakia"}]},
        {"type": "image", "attrs": {"src": src}},   # block-level, as older documents have it
    ]}


class DocumentExportTests(unittest.TestCase):
    def _export(self, src):
        import zipfile
        from services.doc_export import render_docx, render_pdf, tiptap_to_blocks
        blocks = tiptap_to_blocks(_doc(src), {})
        pdf = render_pdf("T", [], [blocks], [])
        docx = render_docx("T", [], [blocks], [])
        media = [n for n in zipfile.ZipFile(io.BytesIO(docx)).namelist() if n.startswith("word/media/")]
        return pdf, media

    def test_a_metadata_address_exports_with_no_picture_and_no_request(self):
        from pypdf import PdfReader
        with _Net(_png) as net:
            pdf, media = self._export("http://169.254.169.254/")
            self.assertEqual(net.requests, [], "the export must not call the address at all")
        self.assertEqual(_pdf_image_count(pdf), 0)
        self.assertEqual(media, [])
        self.assertIn("Neil Kadakia", PdfReader(io.BytesIO(pdf)).pages[0].extract_text() or "")

    def test_another_site_is_not_fetched_either(self):
        with _Net(_png) as net:
            pdf, media = self._export("https://cdn.example.com/a.png")
            self.assertEqual(net.requests, [])
        self.assertEqual((_pdf_image_count(pdf), media), (0, []))

    def test_a_picture_from_the_apps_own_storage_still_exports(self):
        with _Net(_png) as net:
            pdf, media = self._export(OwnStorageTests.OWN)
            self.assertTrue(net.requests)
            self.assertTrue(all(str(r.url) == OwnStorageTests.OWN for r in net.requests))
        self.assertGreaterEqual(_pdf_image_count(pdf), 1)
        self.assertTrue(media)

    def test_a_letterhead_logo_from_the_frontends_own_assets_still_loads(self):
        from services.doc_export import _fetch_image_bytes
        with _Net(_png) as net:
            self.assertEqual(_fetch_image_bytes("/assets/branding/greens-global-logo.png"), PNG_BYTES)
            self.assertEqual(str(net.requests[0].url),
                             "https://nexus.example.com/assets/branding/greens-global-logo.png")

    def test_a_data_uri_never_touches_the_network(self):
        from services.doc_export import _fetch_image_bytes
        with _Net(_png) as net:
            uri = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode()
            self.assertEqual(_fetch_image_bytes(uri), PNG_BYTES)
            self.assertEqual(net.requests, [])


class QaWorkbookTests(unittest.TestCase):
    def test_evidence_outside_storage_is_not_fetched(self):
        from routers.qa import _ThumbCache
        with _Net(_png) as net:
            cache = _ThumbCache()
            self.assertIsNone(cache._bytes("http://169.254.169.254/latest/meta-data/"))
            self.assertIsNone(cache._bytes("https://cdn.example.com/a.png"))
            self.assertEqual(net.requests, [])

    def test_evidence_in_storage_becomes_a_thumbnail(self):
        from routers.qa import _ThumbCache
        with _Net(_png) as net:
            data = _ThumbCache()._bytes(f"{STORAGE}/storage/v1/object/public/document-images/shot.png")
            self.assertTrue(data and data[:8] == b"\x89PNG\r\n\x1a\n")
            self.assertEqual(len(net.requests), 1)


class AutoPhotoTests(unittest.TestCase):
    """items._fetch_image_to_storage: public hosts only, on the og:image hop too."""

    def _run(self, handler, url):
        from routers import items
        uploads = []

        class _Upload:
            def __init__(self, *a, **k): pass
            def __enter__(self): return self
            def __exit__(self, *exc): return False
            def post(self, target, **k):
                uploads.append(target)
                return httpx.Response(200)
        with _Net(handler) as net, mock.patch.object(items.httpx, "Client", _Upload), \
                mock.patch.object(items, "_SUPABASE_URL", STORAGE):
            return items._fetch_image_to_storage(url, "item1"), net.requests, uploads

    def test_a_private_address_from_the_model_is_not_fetched(self):
        got, requests, uploads = self._run(_png, "http://169.254.169.254/latest/meta-data/")
        self.assertEqual((got, requests, uploads), ("", [], []))

    def test_a_product_page_pointing_its_og_image_at_a_private_address(self):
        def handler(request):
            return httpx.Response(200, headers={"content-type": "text/html"}, content=(
                b'<html><head><meta property="og:image" content="http://10.0.0.5/secret.png">'
                b'<meta name="twitter:image" content="/local.png"></head></html>'))
        got, requests, uploads = self._run(handler, "https://shop.example.com/product/1")
        self.assertEqual(got, "")
        self.assertEqual(uploads, [])
        self.assertTrue(all(r.url.host == "93.184.216.35" for r in requests), "only the public shop is ever called")

    def test_a_public_product_photo_is_stored(self):
        photo = PNG_BYTES + b"\0" * (16 * 1024)   # past the 8 KB "that is a tracking pixel" floor
        def handler(request):
            if request.url.path == "/product/1":
                return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=(
                    b'<html><head><meta property="og:image" content="https://cdn.example.com/p.png"></head></html>'))
            return httpx.Response(200, content=photo, headers={"content-type": "image/png"})
        got, requests, uploads = self._run(handler, "https://shop.example.com/product/1")
        self.assertTrue(got.startswith(f"{STORAGE}/storage/v1/object/public/item-photos/item-photos/ai-item1-"))
        self.assertEqual([r.url.host for r in requests], ["93.184.216.35", "93.184.216.34"])
        self.assertEqual(len(uploads), 1)


class LinkPreviewStillGuardedTests(unittest.TestCase):
    def test_external_links_uses_the_shared_guard(self):
        from routers import external_links
        self.assertIs(external_links._resolves_to_public_ip, safe_fetch.resolves_to_public_ip)
        with _Net(_png):
            self.assertFalse(external_links._resolves_to_public_ip("localhost"))
            self.assertTrue(external_links._resolves_to_public_ip("cdn.example.com"))
            self.assertEqual(external_links._fetch_link_preview("http://169.254.169.254/"), {})


if __name__ == "__main__":
    unittest.main()
