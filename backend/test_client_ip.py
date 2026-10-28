"""client_ip.client_ip - the address the rate limiter keys on and the audit
trail records (Sep 30 review: both used to trust a header the caller writes).

Pure header logic; importing audit binds `database`, so it gets a throwaway
SQLite it never writes to. Run with: python -m pytest test_client_ip.py
"""
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

os.environ["DATABASE_URL"] = f"sqlite:///{tempfile.mkdtemp()}/client_ip_test.db"

import audit
import middleware_hardening as mh
from client_ip import client_ip, rate_key, strip_port

CF_EDGE = "172.70.1.2"          # inside Cloudflare's 172.64.0.0/13
VISITOR = "203.0.113.7"
SPOOF = "6.6.6.6"
WORKER = "2a06:98c0:3600::103"  # Cloudflare Workers subrequest address


def _req(headers=None, peer="10.0.0.4"):
    return SimpleNamespace(headers={k.lower(): v for k, v in (headers or {}).items()},
                           client=SimpleNamespace(host=peer) if peer else None)


class ClientIpTests(unittest.TestCase):
    def test_no_proxy_is_the_socket_peer(self):
        self.assertEqual(client_ip(_req(peer="127.0.0.1")), "127.0.0.1")
        self.assertEqual(client_ip(_req(peer=None)), "")

    def test_a_spoofed_first_hop_is_ignored(self):
        # Caller sends "X-Forwarded-For: 6.6.6.6"; Azure appends the real peer.
        r = _req({"X-Forwarded-For": f"{SPOOF}, {VISITOR}:51234"})
        self.assertEqual(client_ip(r), VISITOR)

    def test_through_cloudflare_the_visitor_is_cf_connecting_ip(self):
        r = _req({"X-Forwarded-For": f"{SPOOF}, {VISITOR}, {CF_EDGE}:443",
                  "CF-Connecting-IP": VISITOR})
        self.assertEqual(client_ip(r), VISITOR)

    def test_cf_connecting_ip_is_ignored_when_the_hop_is_not_cloudflare(self):
        # Straight at the Azure origin with a forged Cloudflare header.
        r = _req({"X-Forwarded-For": f"{VISITOR}:40000", "CF-Connecting-IP": SPOOF})
        self.assertEqual(client_ip(r), VISITOR)

    def test_through_cloudflare_without_the_header_the_last_non_cloudflare_hop(self):
        r = _req({"X-Forwarded-For": f"{SPOOF}, {VISITOR}, {CF_EDGE}:443"})
        self.assertEqual(client_ip(r), VISITOR)

    def test_the_bff_pages_proxy(self):
        # The /api Pages Function sets X-Forwarded-For to the visitor; the
        # subrequest may carry Cloudflare's own Worker address as
        # CF-Connecting-IP and reaches Azure from a Cloudflare address.
        r = _req({"X-Forwarded-For": f"{VISITOR}, {WORKER}, {CF_EDGE}:443",
                  "CF-Connecting-IP": WORKER})
        self.assertEqual(client_ip(r), VISITOR)

    def test_every_hop_cloudflare_falls_back_to_the_first(self):
        self.assertEqual(client_ip(_req({"X-Forwarded-For": CF_EDGE})), CF_EDGE)

    def test_ipv6_and_ports(self):
        self.assertEqual(strip_port("[2001:db8::1]:443"), "2001:db8::1")
        self.assertEqual(strip_port("2001:db8::1"), "2001:db8::1")
        self.assertEqual(strip_port("1.2.3.4:5"), "1.2.3.4")
        r = _req({"X-Forwarded-For": "[2606:4700::1]:443", "CF-Connecting-IP": "2001:db8::9"})
        self.assertEqual(client_ip(r), "2001:db8::9")

    def test_the_cloudflare_list_can_be_replaced(self):
        with mock.patch.dict(os.environ, {"NEXUS_CLOUDFLARE_IPS": "198.51.100.0/24"}):
            r = _req({"X-Forwarded-For": "198.51.100.9", "CF-Connecting-IP": VISITOR})
            self.assertEqual(client_ip(r), VISITOR)
            r = _req({"X-Forwarded-For": f"{SPOOF}, {CF_EDGE}", "CF-Connecting-IP": VISITOR})
            self.assertEqual(client_ip(r), CF_EDGE)   # no longer trusted: just a hop

    def test_the_limiter_and_the_audit_trail_use_the_same_helper(self):
        r = _req({"X-Forwarded-For": f"{SPOOF}, {VISITOR}"})
        self.assertEqual(mh._client_ip(r), VISITOR)
        self.assertIs(audit._client_ip, client_ip)



class EdgeSecretTests(unittest.TestCase):
    """NEXUS_EDGE_SECRET (release review, Oct 27 2026): the forwarded headers
    count only on a request from our own Pages Functions."""
    SECRET = "s3cret-edge-value"

    def test_with_the_secret_the_pages_proxy_is_believed(self):
        with mock.patch.dict(os.environ, {"NEXUS_EDGE_SECRET": self.SECRET}):
            r = _req({"X-Forwarded-For": f"{VISITOR}, {WORKER}, {CF_EDGE}:443",
                      "CF-Connecting-IP": WORKER, "X-Nexus-Edge": self.SECRET})
            self.assertEqual(client_ip(r), VISITOR)

    def test_a_foreign_worker_without_the_secret_is_the_direct_peer(self):
        # Somebody else's Worker forging both headers: the last hop (what
        # Azure's front end wrote) is all that is believed.
        with mock.patch.dict(os.environ, {"NEXUS_EDGE_SECRET": self.SECRET}):
            r = _req({"X-Forwarded-For": f"{SPOOF}, {CF_EDGE}:443", "CF-Connecting-IP": SPOOF})
            self.assertEqual(client_ip(r), CF_EDGE)
            r = _req({"X-Forwarded-For": f"{SPOOF}, {CF_EDGE}:443", "CF-Connecting-IP": SPOOF,
                      "X-Nexus-Edge": "wrong"})
            self.assertEqual(client_ip(r), CF_EDGE)

    def test_no_forwarded_header_is_the_socket(self):
        with mock.patch.dict(os.environ, {"NEXUS_EDGE_SECRET": self.SECRET}):
            self.assertEqual(client_ip(_req(peer="127.0.0.1")), "127.0.0.1")

    def test_unset_secret_keeps_the_old_rule(self):
        with mock.patch.dict(os.environ, {"NEXUS_EDGE_SECRET": ""}):
            r = _req({"X-Forwarded-For": f"{SPOOF}, {CF_EDGE}:443", "CF-Connecting-IP": VISITOR})
            self.assertEqual(client_ip(r), VISITOR)


class RateKeyTests(unittest.TestCase):
    def test_ipv6_is_keyed_on_its_64(self):
        a = rate_key("2001:db8:1:2:aaaa::1")
        self.assertEqual(a, "2001:db8:1:2::/64")
        self.assertEqual(rate_key("2001:db8:1:2:ffff:ffff:ffff:ffff"), a)
        self.assertNotEqual(rate_key("2001:db8:1:3::1"), a)

    def test_ipv4_and_junk_are_unchanged(self):
        self.assertEqual(rate_key(VISITOR), VISITOR)
        self.assertEqual(rate_key("::ffff:203.0.113.7"), VISITOR)
        self.assertEqual(rate_key("?"), "?")
        self.assertEqual(rate_key(""), "")

    def test_the_limiter_counts_an_ipv6_line_as_one(self):
        from starlette.applications import Starlette
        from starlette.responses import PlainTextResponse
        from starlette.routing import Route
        from starlette.testclient import TestClient
        app = Starlette(routes=[Route("/x", lambda r: PlainTextResponse("ok"))])
        app.add_middleware(mh.RequestRateLimit)
        c = TestClient(app)
        with mock.patch.object(mh.RequestRateLimit, "ENABLED", True), \
                mock.patch.object(mh.RequestRateLimit, "ANON_PER_MIN", 3), \
                mock.patch.dict(os.environ, {"NEXUS_EDGE_SECRET": ""}):
            codes = [c.get("/x", headers={"X-Forwarded-For": f"2001:db8:1:2::{i + 1:x}"}).status_code
                     for i in range(4)]
            self.assertEqual(codes, [200, 200, 200, 429])
            # Another /64 has its own budget.
            self.assertEqual(c.get("/x", headers={"X-Forwarded-For": "2001:db8:1:3::1"}).status_code, 200)


class CareersBodyCapTests(unittest.TestCase):
    def test_an_oversized_apply_is_refused_before_the_body_is_read(self):
        from starlette.applications import Starlette
        from starlette.responses import PlainTextResponse
        from starlette.routing import Route
        from starlette.testclient import TestClient
        read = []

        async def apply(request):
            read.append(await request.body())
            return PlainTextResponse("ok")
        app = Starlette(routes=[Route("/careers/apply/{op}", apply, methods=["POST"])])
        app.add_middleware(mh.RequestRateLimit)
        c = TestClient(app)
        big = str(12 * 1024 * 1024)
        r = c.post("/careers/apply/o1", content=b"x", headers={"Content-Length": big})
        self.assertEqual(r.status_code, 413)
        self.assertEqual(read, [])
        self.assertEqual(c.post("/careers/apply/o1", content=b"small").status_code, 200)


if __name__ == "__main__":
    unittest.main()
