"""External Links logo cache (Aug 31).

The tiles used to fetch every logo LIVE from icon.horse, so 50+ links meant 50+
simultaneous requests to a free service per employee per page view, all from one
office egress IP - which rate-limits per IP. Most tiles came back HTTP 429 and
dropped to the generic glyph, differently on every load (Charmi/Neil: "are each
of these supposed to have an image?"). These tests pin the two behaviors that
fix depends on: one fetch per domain ever, and a GENERATED stand-in never being
stored as if it were the brand's real mark.

    python -m unittest test_link_icons
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import database
import main
import models
from routers import external_links as el

models.Base.metadata.create_all(bind=database.engine)

PNG = b"\x89PNG\r\n\x1a\n" + b"realbytes"
REAL_CC = "public, max-age=604800, s-maxage=2592000"
PLACEHOLDER_CC = "public, max-age=604800, s-maxage=300"    # icon.horse's letter avatar


class _Resp:
    def __init__(self, status=200, content=PNG, ctype="image/png", cc=REAL_CC):
        self.status_code, self.content = status, content
        self.headers = {"content-type": ctype, "cache-control": cc}


class _FakeClient:
    """Stands in for httpx.Client. `routes` maps a URL substring to a _Resp."""
    calls = []
    routes = {}

    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False

    def get(self, url):
        _FakeClient.calls.append(url)
        for frag, resp in _FakeClient.routes.items():
            if frag in url:
                return resp
        return _Resp(status=404, content=b"")


class LinkIconTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.db.query(models.LinkIcon).delete()
        self.db.query(models.ExternalLink).delete()
        self.db.add(models.ExternalLink(name="Ring", url="https://ring.com/users/sign_in", category=""))
        self.db.add(models.ExternalLink(name="Paystub", url="https://accounts.intuit.com/", category=""))
        self.db.commit()
        self._real_client = el.httpx.Client
        el.httpx.Client = _FakeClient
        _FakeClient.calls, _FakeClient.routes = [], {}
        self.c = TestClient(main.app)

    def tearDown(self):
        el.httpx.Client = self._real_client
        self.db.close()

    def get(self, domain):
        return self.c.get("/external-links/icon", params={"d": domain})

    def test_fetches_once_then_serves_from_the_cache(self):
        """The whole point: 50 tiles must not become 50 outbound requests."""
        _FakeClient.routes = {"icon.horse/icon/ring.com": _Resp()}
        first = self.get("ring.com")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.content, PNG)
        outbound_after_first = len(_FakeClient.calls)
        for _ in range(5):
            self.assertEqual(self.get("ring.com").status_code, 200)
        self.assertEqual(len(_FakeClient.calls), outbound_after_first,
                         "a cached logo must never go back out to the resolver")

    def test_generated_placeholder_is_not_stored_as_a_logo(self):
        """icon.horse answers an unknown domain with 200 + a letter avatar, not a
        404. Storing that is what made unrecognized links look 'missing'."""
        _FakeClient.routes = {"icon.horse/icon/ring.com": _Resp(cc=PLACEHOLDER_CC)}
        self.assertEqual(self.get("ring.com").status_code, 404)
        row = self.db.query(models.LinkIcon).filter_by(domain="ring.com").first()
        self.assertEqual(row.source, "none")
        self.assertIsNone(row.data)

    def test_a_real_logo_is_kept_even_with_a_short_smaxage_absent(self):
        """Conservative on purpose - no parsable s-maxage means treat it as real,
        so a header rename can't strip logos off every tile at once."""
        _FakeClient.routes = {"icon.horse/icon/ring.com": _Resp(cc="public, max-age=600")}
        self.assertEqual(self.get("ring.com").status_code, 200)

    def test_falls_back_to_the_parent_domain(self):
        """accounts.intuit.com publishes no favicon; intuit.com is the brand."""
        _FakeClient.routes = {"icon.horse/icon/intuit.com": _Resp()}
        r = self.get("accounts.intuit.com")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, PNG)

    def test_a_dead_lookup_is_cached_so_it_is_not_retried_every_render(self):
        self.assertEqual(self.get("ring.com").status_code, 404)
        outbound = len(_FakeClient.calls)
        self.assertEqual(self.get("ring.com").status_code, 404)
        self.assertEqual(len(_FakeClient.calls), outbound)

    def test_only_domains_on_a_real_link_are_served(self):
        """Not a general-purpose favicon proxy for anyone who finds the URL."""
        _FakeClient.routes = {"icon.horse": _Resp()}
        self.assertEqual(self.get("evil.example.com").status_code, 404)
        self.assertEqual(_FakeClient.calls, [], "must not go out for an unknown domain")

    def test_rejects_a_malformed_domain(self):
        for bad in ("not a domain", "../etc/passwd", "http://ring.com", ""):
            self.assertIn(self.get(bad).status_code, (400, 404, 422), bad)

    def test_rejects_a_non_image_body(self):
        _FakeClient.routes = {"icon.horse/icon/ring.com": _Resp(ctype="text/html", content=b"<html>")}
        self.assertEqual(self.get("ring.com").status_code, 404)

    def test_a_failed_refresh_keeps_the_logo_we_already_had(self):
        """A resolver having a bad afternoon must not blank a working tile."""
        _FakeClient.routes = {"icon.horse/icon/ring.com": _Resp()}
        self.assertEqual(self.get("ring.com").status_code, 200)
        row = self.db.query(models.LinkIcon).filter_by(domain="ring.com").first()
        row.fetched_at = "2020-01-01T00:00:00"          # force it stale
        self.db.commit()
        _FakeClient.routes = {}                          # every resolver now fails
        r = self.get("ring.com")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, PNG)


if __name__ == "__main__":
    unittest.main()
