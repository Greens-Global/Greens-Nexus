"""The authorization boundary as a test suite (SECURITY-TODO item 3).

Three layers:
1. A route sweep: every registered route must either carry an auth dependency
   (get_current_user / require_*) or be on the explicit KNOWN_PUBLIC allowlist.
   Adding a new unauthenticated endpoint fails this test until it is either
   authed or deliberately allowlisted - UI hiding alone is never the boundary.
2. Missing-token behavior: with auth enforcement on, protected endpoints must
   401 without a Bearer token.
3. Grant enforcement: an employee with no role and no Access Group grant gets
   403 from a grant-gated module; an administrator passes.

Runs against the local SQLite DB like the other test_*.py files:
    python -m unittest test_auth_access
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

# Routes that are unauthenticated ON PURPOSE. Each carries its own defense:
# token-as-credential (+ guessing throttle), HMAC signature, device token via
# an inline dependency the sweep already recognizes, or is public read-only
# config/health. Anything new lands here only via deliberate review.
KNOWN_PUBLIC = {
    "/",                                   # API banner
    "/health", "/version",                 # infra probes
    "/branding/config",                    # login screen needs it pre-auth
    "/stepup/config",                      # same posture
    "/asana-sync/webhook",                 # X-Hook-Signature HMAC verified
    "/asana-oauth/callback",               # OAuth redirect from Asana; CSRF-guarded by the state token (consume_state)
    "/qa/ci-results", "/qa/e2e-specs",     # X-QA-CI-Token header checked inline
    "/esign/local-file/{bucket}/{path:path}",  # local-dev only; 404s when storage configured
    "/esign/public/{token}",               # 43-char token is the credential
    "/esign/public/{token}/sign",          # + access-code lockout
    "/esign/public/{token}/decline",       # + per-IP guessing throttle
    "/esign/public/{token}/download",
    "/esign/public/verify/{verify_token}",
    "/timeclock/agent/checkin",            # agent device token (get_agent_device)
    "/timeclock/agent/screenshot",
    "/timeclock/agent/activity",
    "/timeclock/track/consent",            # same device-token model
    "/timeclock/track/config",
    "/timeclock/track/start",
    "/timeclock/track/ping",
    "/timeclock/track/stop",
    "/timeclock/track/clock",
}

_AUTH_DEP_NAMES = ("get_current_user", "_check", "get_agent_device")


def _route_dep_names(route):
    names = set()
    stack = [route.dependant]
    while stack:
        d = stack.pop()
        if d.call is not None:
            names.add(getattr(d.call, "__name__", repr(d.call)))
        stack.extend(d.dependencies)
    return names


class TestRouteSweep(unittest.TestCase):
    def test_every_route_authed_or_allowlisted(self):
        offenders = []
        for r in main.app.routes:
            if not isinstance(r, APIRoute):
                continue
            names = _route_dep_names(r)
            authed = any(n in _AUTH_DEP_NAMES or n.startswith("require") for n in names)
            if not authed and r.path not in KNOWN_PUBLIC:
                offenders.append(f"{sorted(r.methods)} {r.path}")
        self.assertEqual(offenders, [],
                         "Unauthenticated routes not on the allowlist:\n  " + "\n  ".join(offenders))

    def test_allowlist_has_no_dead_entries(self):
        live = {r.path for r in main.app.routes if isinstance(r, APIRoute)}
        stale = KNOWN_PUBLIC - live
        self.assertEqual(stale, set(), f"Allowlist entries no longer registered: {stale}")


class TestMissingToken(unittest.TestCase):
    """With enforcement on, no Bearer token means 401 - before any DB work."""

    def setUp(self):
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = False
        self.client = TestClient(main.app)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip

    def test_protected_endpoints_401_without_token(self):
        for path in ("/myhr/directory", "/hr/employees", "/items", "/roles/directory"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 401, f"{path} -> {r.status_code}")

    def test_garbage_token_401(self):
        r = self.client.get("/myhr/directory", headers={"Authorization": "Bearer not-a-jwt"})
        self.assertEqual(r.status_code, 401)


class TestGrantEnforcement(unittest.TestCase):
    """require_module_grant: role alone never opens a module below the bypass
    level; an explicit grant or admin role does. /hr/employees is the probe
    (require_hr_read = require_module_grant('hr', 'viewer'))."""

    PROBE = "authprobe@greensglobal.com"

    def setUp(self):
        self.client = TestClient(main.app)
        # Force the dev-identity path regardless of which test module imported
        # auth first (import order flips SKIP_AUTH under full discovery).
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = self.PROBE
        self._cleanup()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusRole).filter(models.NexusRole.email == self.PROBE).delete()
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.email == self.PROBE).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        cache.module_grants.invalidate()

    def test_employee_without_grant_403(self):
        r = self.client.get("/hr/employees")
        self.assertEqual(r.status_code, 403, r.text)

    def test_administrator_bypasses_grant(self):
        db = database.SessionLocal()
        try:
            db.add(models.NexusRole(email=self.PROBE, role="administrator", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(self.PROBE)
        r = self.client.get("/hr/employees")
        self.assertEqual(r.status_code, 200, r.text)

    def test_group_grant_opens_module_for_employee(self):
        db = database.SessionLocal()
        try:
            grp = models.NexusGroup(id="GRPAUTHTEST01", name="Auth Test Grant",
                                    allowed_modules="hr:viewer", created_by="test",
                                    created_at="2026-08-01T00:00:00Z")
            db.merge(grp)
            db.add(models.NexusGroupMember(group_id="GRPAUTHTEST01", email=self.PROBE,
                                           added_by="test", added_at="2026-08-01T00:00:00Z"))
            db.commit()
            r = self.client.get("/hr/employees")
            self.assertEqual(r.status_code, 200, r.text)
        finally:
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.group_id == "GRPAUTHTEST01").delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(
                models.NexusGroup.id == "GRPAUTHTEST01").delete(synchronize_session=False)
            db.commit()
            db.close()


if __name__ == "__main__":
    unittest.main()
