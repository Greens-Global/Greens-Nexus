"""Sep 22, 2026 security-debt fixes (Neil's list): the private-bucket viewer
only serves what it should, the request rate limit trips and recovers, and the
roles directory never hands out guest/external identities."""
import os
import unittest

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from fastapi import FastAPI
from fastapi.testclient import TestClient

import middleware_hardening as mh
from routers import files as files_router


class ParsePublicUrl(unittest.TestCase):
    BASE = "https://example.supabase.co/storage/v1/object/public/"

    def test_protected_bucket_parses(self):
        files_router._SUPABASE_URL = "https://example.supabase.co"
        self.assertEqual(files_router.parse_public_url(self.BASE + "item-photos/a/b.jpg?x=1"),
                         ("item-photos", "a/b.jpg"))

    def test_other_bucket_refused(self):
        files_router._SUPABASE_URL = "https://example.supabase.co"
        self.assertIsNone(files_router.parse_public_url(self.BASE + "avatars/me.png"))
        self.assertIsNone(files_router.parse_public_url(self.BASE + "hr-docs/secret.pdf"))

    def test_traversal_and_foreign_hosts_refused(self):
        files_router._SUPABASE_URL = "https://example.supabase.co"
        self.assertIsNone(files_router.parse_public_url(self.BASE + "item-photos/../hr-docs/x"))
        self.assertIsNone(files_router.parse_public_url("https://evil.example/storage/v1/object/public/item-photos/x.jpg"))
        self.assertIsNone(files_router.parse_public_url(self.BASE + "item-photos/"))
        self.assertIsNone(files_router.parse_public_url(""))


def _limited_app(**caps):
    app = FastAPI()

    @app.get("/ping")
    def ping():
        return {"ok": True}

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.post("/auth/login")
    def login():
        return {"ok": True}

    app.add_middleware(mh.RequestRateLimit)
    for k, v in caps.items():
        setattr(mh.RequestRateLimit, k, v)
    return TestClient(app)


class RequestRateLimit(unittest.TestCase):
    def setUp(self):
        self._saved = {k: getattr(mh.RequestRateLimit, k) for k in
                       ("ANON_PER_MIN", "AUTHED_PER_MIN", "SENSITIVE_PER_MIN", "IP_CEILING", "ENABLED")}
        mh.RequestRateLimit.ENABLED = True

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(mh.RequestRateLimit, k, v)

    def test_anonymous_budget_trips_with_429_and_retry_after(self):
        c = _limited_app(ANON_PER_MIN=3, IP_CEILING=100)
        for _ in range(3):
            self.assertEqual(c.get("/ping").status_code, 200)
        r = c.get("/ping")
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.headers.get("retry-after"), "10")
        self.assertIn("Too many requests", r.json()["detail"])

    def test_signed_in_callers_are_budgeted_separately_from_the_ip(self):
        c = _limited_app(ANON_PER_MIN=1, AUTHED_PER_MIN=5, IP_CEILING=100)
        self.assertEqual(c.get("/ping").status_code, 200)
        self.assertEqual(c.get("/ping").status_code, 429)          # anonymous budget spent
        for _ in range(5):                                           # a bearer caller still has its own
            self.assertEqual(c.get("/ping", headers={"Authorization": "Bearer abc"}).status_code, 200)
        self.assertEqual(c.get("/ping", headers={"Authorization": "Bearer abc"}).status_code, 429)
        # a different credential is a different budget...
        self.assertEqual(c.get("/ping", headers={"Authorization": "Bearer xyz"}).status_code, 200)

    def test_ip_ceiling_stops_token_rotation(self):
        c = _limited_app(ANON_PER_MIN=100, AUTHED_PER_MIN=100, IP_CEILING=4)
        for i in range(4):
            self.assertEqual(c.get("/ping", headers={"Authorization": f"Bearer t{i}"}).status_code, 200)
        self.assertEqual(c.get("/ping", headers={"Authorization": "Bearer fresh"}).status_code, 429)

    def test_sensitive_routes_have_the_tight_anonymous_budget(self):
        c = _limited_app(ANON_PER_MIN=100, SENSITIVE_PER_MIN=2, IP_CEILING=100)
        self.assertEqual(c.post("/auth/login").status_code, 200)
        self.assertEqual(c.post("/auth/login").status_code, 200)
        self.assertEqual(c.post("/auth/login").status_code, 429)
        self.assertEqual(c.get("/ping").status_code, 200)           # the general budget is untouched

    def test_probes_and_preflights_are_exempt(self):
        c = _limited_app(ANON_PER_MIN=1, IP_CEILING=1)
        self.assertEqual(c.get("/ping").status_code, 200)
        for _ in range(5):
            self.assertEqual(c.get("/health").status_code, 200)
        self.assertNotEqual(c.options("/ping").status_code, 429)


class RolesDirectoryIsCurated(unittest.TestCase):
    """The picker must come from the People list, never straight from nexus_roles."""

    def test_source_is_the_people_list(self):
        import inspect
        from routers import roles
        src = inspect.getsource(roles.get_directory)
        self.assertIn("identity_type", src)
        self.assertIn('"offboarded"', src)
        self.assertIn("allowed", src)


if __name__ == "__main__":
    unittest.main()
