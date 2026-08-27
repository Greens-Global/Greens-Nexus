"""External passwordless auth (Aug 18) - the security requirements as tests.

Covers: branded-invite issuance (token hashed, single-use, 7-day, bound to the
email), activation lookup/send/verify (SMS via sent.dm with automatic email
degradation, phone_verified_at stamping), returning sign-in (generic
anti-enumeration response, code hashing, single-use, expiry), rate limits
(5 verify attempts -> 15-min lockout, 5 requests/hour per email and per IP,
30s resend throttle), revocation on deactivate/remove (codes AND sessions),
and that the minted cookie session resolves through get_current_user with
apply_external_policy still in charge.

All delivery is stubbed - no test touches sent.dm or Microsoft Graph.
    python -m unittest test_external_auth
"""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import bff_session
import cache
import database
import graph_mail
import main
import models
import sentdm
import routers.external_auth as ext_auth

models.Base.metadata.create_all(bind=database.engine)

# Never any real delivery from tests.
graph_mail._AZURE_TENANT_ID = ""
graph_mail._AZURE_CLIENT_ID = ""
graph_mail._AZURE_CLIENT_SECRET = ""
os.environ.pop("NEXUS_SENTDM_KEY", None)

# The cookie path in auth._email_from_session is gated on bff_session.configured()
# (an Entra client secret) - passwordless sessions ride the same cookie, so the
# session-resolution tests need the gate open. No Entra call ever happens: the
# session rows carry no refresh token and a far-future expiry.
bff_session.CLIENT_SECRET = "test-only-secret"

GUEST = "pat.partner@buildco.example"
ADMIN = "authprobe.extauth@greensglobal.com"


def _iso(dt):
    return dt.isoformat()


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self.sent_sms = []      # (phone, code)
        self.sent_email = []    # (email, code)
        self.sent_invites = []  # (email, token)
        self._patches = [
            mock.patch.object(sentdm, "send_code",
                              side_effect=lambda phone, code: (self.sent_sms.append((phone, code)) or (True, ""))),
            mock.patch.object(ext_auth, "_send_email_code",
                              side_effect=lambda email, code: self.sent_email.append((email, code))),
            mock.patch.object(ext_auth, "_send_invite_email",
                              side_effect=lambda to, name, inviter, company, token: self.sent_invites.append((to, token))),
        ]
        for p in self._patches:
            p.start()
        self._cleanup()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.ExternalLoginCode).filter(
                models.ExternalLoginCode.email == GUEST).delete(synchronize_session=False)
            db.query(models.ServerSession).filter(
                models.ServerSession.user_email.in_((GUEST, ADMIN))).delete(synchronize_session=False)
            db.query(models.NexusEmployee).filter(
                models.NexusEmployee.work_email == GUEST).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(
                models.NexusRole.email.in_((GUEST, ADMIN))).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.email == GUEST).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        auth.invalidate_external_cache()
        cache.module_grants.invalidate()

    def _as_admin(self):
        db = database.SessionLocal()
        try:
            if not db.query(models.NexusRole).filter(models.NexusRole.email == ADMIN).first():
                db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
                db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache(ADMIN)
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN

    def _enroll(self, phone="", send_invite=True):
        """Enroll the guest. send_invite=True = the released flow most tests
        exercise; the NEW default in the API is staged (send_invite=False,
        Neil Aug 25) - covered by TestStagedRelease."""
        self._as_admin()
        r = self.client.post("/external-users", json={
            "email": GUEST, "first_name": "Pat", "last_name": "Partner",
            "company": "BuildCo", "phone": phone, "send_invite": send_invite})
        assert r.status_code == 201, r.text
        return r.json()

    def _token(self):
        return self.sent_invites[-1][1]

    def _age_all(self, minutes=2):
        """Step existing code rows back in time - the 30s resend throttle is
        real and correctly bites right after activation, so tests that then
        request a login code must age past it first."""
        db = database.SessionLocal()
        try:
            db.query(models.ExternalLoginCode).filter(
                models.ExternalLoginCode.email == GUEST).update(
                {"created_at": _iso(datetime.now(timezone.utc) - timedelta(minutes=minutes))},
                synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _code_rows(self, purpose=None):
        db = database.SessionLocal()
        try:
            q = db.query(models.ExternalLoginCode).filter(models.ExternalLoginCode.email == GUEST)
            if purpose:
                q = q.filter(models.ExternalLoginCode.purpose == purpose)
            return q.order_by(models.ExternalLoginCode.created_at).all()
        finally:
            db.close()


class TestInviteIssuance(_Base):
    def test_enroll_sends_branded_email_with_hashed_single_use_token(self):
        out = self._enroll()
        self.assertEqual(out["inviteStatus"], "sent")
        self.assertEqual(len(self.sent_invites), 1)
        to, token = self.sent_invites[0]
        self.assertEqual(to, GUEST)
        self.assertGreaterEqual(len(token), 43)          # 32+ bytes of entropy
        rows = self._code_rows("invite")
        self.assertEqual(len(rows), 1)
        self.assertNotIn(token, rows[0].code_hash)       # hashed at rest
        self.assertEqual(rows[0].code_hash, ext_auth._hash_token(token))
        # ~7-day expiry
        exp = datetime.fromisoformat(rows[0].expires_at)
        self.assertGreater(exp, datetime.now(timezone.utc) + timedelta(days=6))

    def test_resend_kills_prior_token(self):
        self._enroll()
        first = self._token()
        r = self.client.post(f"/external-users/{GUEST}/invite")
        self.assertEqual(r.status_code, 200, r.text)
        # Old link dead, new one live
        self.assertEqual(self.client.post("/external-auth/activate/lookup",
                                          json={"token": first}).status_code, 404)
        self.assertEqual(self.client.post("/external-auth/activate/lookup",
                                          json={"token": self._token()}).status_code, 200)

    def test_email_failure_still_enrolls_as_failed(self):
        self._patches[2].stop()   # real _send_invite_email -> unconfigured Graph raises
        try:
            out = self._enroll()
            self.assertEqual(out["inviteStatus"], "failed")
            self.assertIn("Resend Invite", out["inviteMessage"])
        finally:
            self._patches[2].start()


class TestActivation(_Base):
    def test_lookup_shows_profile_and_rejects_bad_tokens(self):
        self._enroll(phone="+14155551234")
        r = self.client.post("/external-auth/activate/lookup", json={"token": self._token()})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["email"], GUEST)
        self.assertEqual(body["company"], "BuildCo")
        self.assertTrue(body["hasPhone"])
        self.assertEqual(body["phoneMasked"], "***1234")
        self.assertEqual(self.client.post("/external-auth/activate/lookup",
                                          json={"token": "garbage"}).status_code, 404)
        self.assertEqual(self.client.post("/external-auth/activate/lookup",
                                          json={"token": "x" * 64}).status_code, 404)

    def test_sms_activation_verifies_phone_and_mints_session(self):
        self._enroll(phone="+14155551234")
        token = self._token()
        r = self.client.post("/external-auth/activate/send-code", json={"token": token})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["channel"], "sms")
        phone, code = self.sent_sms[-1]
        self.assertEqual(phone, "+14155551234")
        # stored hashed, never plaintext
        row = self._code_rows("activate")[-1]
        self.assertNotIn(code, row.code_hash)
        r = self.client.post("/external-auth/activate/verify", json={"token": token, "code": code})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(bff_session.SESSION_COOKIE, r.cookies)
        db = database.SessionLocal()
        try:
            emp = db.query(models.NexusEmployee).filter(
                models.NexusEmployee.work_email == GUEST).first()
            self.assertTrue(emp.phone_verified_at)
            self.assertEqual(db.query(models.ServerSession).filter(
                models.ServerSession.user_email == GUEST).count(), 1)
        finally:
            db.close()
        # Token single-use: dead after activation
        self.assertEqual(self.client.post("/external-auth/activate/lookup",
                                          json={"token": token}).status_code, 404)

    def test_add_phone_during_activation(self):
        self._enroll()   # no phone on file
        token = self._token()
        r = self.client.post("/external-auth/activate/send-code",
                             json={"token": token, "phone": "+1 (619) 555-0000"})
        self.assertEqual(r.json()["channel"], "sms")
        self.assertEqual(self.sent_sms[-1][0], "+16195550000")   # normalized

    def test_email_fallback_channel(self):
        self._enroll()
        token = self._token()
        r = self.client.post("/external-auth/activate/send-code",
                             json={"token": token, "channel": "email"})
        self.assertEqual(r.json()["channel"], "email")
        email, code = self.sent_email[-1]
        self.assertEqual(email, GUEST)
        r = self.client.post("/external-auth/activate/verify", json={"token": token, "code": code})
        self.assertEqual(r.status_code, 200, r.text)
        # Email-channel code never stamps the phone as verified
        db = database.SessionLocal()
        try:
            emp = db.query(models.NexusEmployee).filter(
                models.NexusEmployee.work_email == GUEST).first()
            self.assertFalse(emp.phone_verified_at)
        finally:
            db.close()

    def test_sms_outage_degrades_to_email(self):
        self._enroll(phone="+14155551234")
        with mock.patch.object(sentdm, "send_code", return_value=(False, "sent.dm returned 500")):
            r = self.client.post("/external-auth/activate/send-code", json={"token": self._token()})
        self.assertEqual(r.json()["channel"], "email")
        self.assertTrue(self.sent_email)


class TestReturningLogin(_Base):
    def _activate(self, phone=""):
        self._enroll(phone=phone)
        token = self._token()
        self.client.post("/external-auth/activate/send-code",
                         json={"token": token, "channel": "" if phone else "email"})
        code = (self.sent_sms[-1][1] if phone else self.sent_email[-1][1])
        self.client.post("/external-auth/activate/verify", json={"token": token, "code": code})

    def test_generic_response_never_enumerates(self):
        for email in ("nobody@nowhere.example", GUEST):   # unknown vs not-enrolled-yet
            r = self.client.post("/external-auth/request-code", json={"email": email})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["message"], ext_auth.GENERIC_MSG)
        self.assertEqual(self._code_rows(), [])           # and nothing was minted

    def test_login_via_verified_phone_then_session_resolves(self):
        self._activate(phone="+14155551234")
        self._age_all()
        self.sent_sms.clear()
        r = self.client.post("/external-auth/request-code", json={"email": GUEST})
        self.assertEqual(r.json()["message"], ext_auth.GENERIC_MSG)
        self.assertEqual(len(self.sent_sms), 1)           # verified phone -> SMS channel
        code = self.sent_sms[-1][1]
        r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": code})
        self.assertEqual(r.status_code, 200, r.text)
        sid = r.cookies.get(bff_session.SESSION_COOKIE)
        self.assertTrue(sid)
        # The cookie session resolves to the guest through the normal machinery,
        # and apply_external_policy still governs authorization.
        auth.SKIP_AUTH = False
        try:
            r = self.client.get("/roles/me", cookies={bff_session.SESSION_COOKIE: sid})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["email"], GUEST)
            self.assertTrue(r.json()["is_external"])
            self.assertEqual(self.client.get(
                "/items", cookies={bff_session.SESSION_COOKIE: sid}).status_code, 403)
        finally:
            auth.SKIP_AUTH = True

    def test_email_instead_fallback(self):
        self._activate(phone="+14155551234")
        self._age_all()
        self.sent_email.clear()
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        self.assertEqual(len(self.sent_email), 1)

    def test_code_single_use_and_new_request_invalidates_prior(self):
        self._activate()
        self._age_all()
        # Two requests a while apart: only the newest code works
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        first = self.sent_email[-1][1]
        db = database.SessionLocal()   # age the first row past the resend throttle
        try:
            db.query(models.ExternalLoginCode).filter(
                models.ExternalLoginCode.email == GUEST,
                models.ExternalLoginCode.consumed_at == "").update(
                {"created_at": _iso(datetime.now(timezone.utc) - timedelta(minutes=2))},
                synchronize_session=False)
            db.commit()
        finally:
            db.close()
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        second = self.sent_email[-1][1]
        r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": first})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": second})
        self.assertEqual(r.status_code, 200, r.text)
        # ...and once consumed it cannot be replayed
        r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": second})
        self.assertEqual(r.status_code, 400)

    def test_expired_code_rejected(self):
        self._activate()
        self._age_all()
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        code = self.sent_email[-1][1]
        db = database.SessionLocal()
        try:
            db.query(models.ExternalLoginCode).filter(
                models.ExternalLoginCode.email == GUEST,
                models.ExternalLoginCode.consumed_at == "").update(
                {"expires_at": _iso(datetime.now(timezone.utc) - timedelta(minutes=1))},
                synchronize_session=False)
            db.commit()
        finally:
            db.close()
        r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": code})
        self.assertEqual(r.status_code, 400)


class TestRateLimits(_Base):
    def _activate_email(self):
        self._enroll()
        token = self._token()
        self.client.post("/external-auth/activate/send-code", json={"token": token, "channel": "email"})
        code = self.sent_email[-1][1]
        self.client.post("/external-auth/activate/verify", json={"token": token, "code": code})

    def _age_codes(self, minutes):
        db = database.SessionLocal()
        try:
            db.query(models.ExternalLoginCode).filter(
                models.ExternalLoginCode.email == GUEST).update(
                {"created_at": _iso(datetime.now(timezone.utc) - timedelta(minutes=minutes))},
                synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_five_wrong_codes_locks_for_15_minutes(self):
        self._activate_email()
        self._age_all()
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        good = self.sent_email[-1][1]
        wrong = "000000" if good != "000000" else "111111"
        for i in range(ext_auth.MAX_ATTEMPTS - 1):
            r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": wrong})
            self.assertEqual(r.status_code, 400, f"attempt {i}")
        r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": wrong})
        self.assertEqual(r.status_code, 429)          # 5th kill -> lockout
        # Even the CORRECT code is dead now, and new requests mint nothing
        r = self.client.post("/external-auth/login-verify", json={"email": GUEST, "code": good})
        self.assertEqual(r.status_code, 429)
        n_before = len(self._code_rows())
        r = self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        self.assertEqual(r.status_code, 200)           # still generic
        self.assertEqual(len(self._code_rows()), n_before)
        # Lockout audit exists, and no audit row ever carries a code
        db = database.SessionLocal()
        try:
            rows = db.query(models.AuditLog).filter(
                models.AuditLog.user_email == GUEST,
                models.AuditLog.action == "external_login_lockout").all()
            self.assertTrue(rows)
            for a in db.query(models.AuditLog).filter(models.AuditLog.user_email == GUEST).all():
                self.assertNotIn(good, a.details or "")
        finally:
            db.close()

    def test_resend_throttle_30s(self):
        self._activate_email()
        self._age_all()
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        n = len(self._code_rows())
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        self.assertEqual(len(self._code_rows()), n)    # throttled, generic 200 regardless

    def test_hourly_cap_per_email(self):
        self._activate_email()
        for _ in range(ext_auth.MAX_REQUESTS_PER_HOUR):
            self._age_codes(2)                          # step past the 30s throttle each time
            self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        n = len(self._code_rows())
        self._age_codes(2)
        # cap counts rows in the last hour - the aging above keeps them in-window
        self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        self.assertEqual(len(self._code_rows()), n)

    def test_inactive_guest_gets_no_code(self):
        self._activate_email()
        self._as_admin()
        self.client.patch(f"/external-users/{GUEST}", json={"status": "inactive"})
        n = len(self._code_rows())
        r = self.client.post("/external-auth/request-code", json={"email": GUEST, "channel": "email"})
        self.assertEqual(r.status_code, 200)           # generic, as ever
        self.assertEqual(len(self._code_rows()), n)


class TestRevocation(_Base):
    def _login(self):
        self._enroll()
        token = self._token()
        self.client.post("/external-auth/activate/send-code", json={"token": token, "channel": "email"})
        code = self.sent_email[-1][1]
        r = self.client.post("/external-auth/activate/verify", json={"token": token, "code": code})
        return r.cookies.get(bff_session.SESSION_COOKIE)

    def test_deactivate_kills_sessions_and_codes(self):
        sid = self._login()
        self.assertTrue(sid)
        self._as_admin()
        self.client.patch(f"/external-users/{GUEST}", json={"status": "inactive"})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.ServerSession).filter(
                models.ServerSession.user_email == GUEST).count(), 0)
            self.assertEqual(db.query(models.ExternalLoginCode).filter(
                models.ExternalLoginCode.email == GUEST,
                models.ExternalLoginCode.consumed_at == "").count(), 0)
        finally:
            db.close()
        auth.SKIP_AUTH = False
        try:
            r = self.client.get("/roles/me", cookies={bff_session.SESSION_COOKIE: sid})
            self.assertEqual(r.status_code, 401)   # session gone -> no identity at all
        finally:
            auth.SKIP_AUTH = True

    def test_remove_kills_everything_too(self):
        sid = self._login()
        self._as_admin()
        self.client.delete(f"/external-users/{GUEST}")
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.ServerSession).filter(
                models.ServerSession.user_email == GUEST).count(), 0)
        finally:
            db.close()
        auth.SKIP_AUTH = False
        try:
            self.assertEqual(self.client.get(
                "/roles/me", cookies={bff_session.SESSION_COOKIE: sid}).status_code, 401)
        finally:
            auth.SKIP_AUTH = True


class TestCsrfGuard(_Base):
    """Regression for the live Aug 18 dev bug: the BFF CSRF middleware
    (main._bff_csrf_guard) rejected the activation page's very first call with
    "CSRF token missing or invalid" whenever the browser already held SOMEONE'S
    session cookie (Visesh was signed in as himself when he opened the guest's
    activation link). This module's tests set bff_session.CLIENT_SECRET, so the
    middleware is ACTIVE here - which is exactly why the original suite, which
    never attached a cookie to these calls, missed it."""

    def _some_session_cookie(self):
        """Any live session cookie - simulates the admin's own login riding
        along on the guest's pre-auth requests."""
        db = database.SessionLocal()
        try:
            sid, _csrf = bff_session.create_passwordless_session(db, ADMIN)
        finally:
            db.close()
        return sid

    def test_full_activation_with_foreign_cookie_never_csrf_rejected(self):
        self._enroll(phone="+14155551234")
        token = self._token()
        cookies = {bff_session.SESSION_COOKIE: self._some_session_cookie()}
        # None of the pre-auth calls may 403 on CSRF, cookie or not
        r = self.client.post("/external-auth/activate/lookup", json={"token": token}, cookies=cookies)
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post("/external-auth/activate/send-code", json={"token": token}, cookies=cookies)
        self.assertEqual(r.status_code, 200, r.text)
        code = self.sent_sms[-1][1]
        r = self.client.post("/external-auth/activate/verify", json={"token": token, "code": code}, cookies=cookies)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(bff_session.SESSION_COOKIE, r.cookies)   # fresh guest session issued
        self.assertIn(bff_session.CSRF_COOKIE, r.cookies)      # ...WITH its CSRF cookie

    def test_partner_login_with_foreign_cookie_never_csrf_rejected(self):
        self._enroll()
        token = self._token()
        self.client.post("/external-auth/activate/send-code", json={"token": token, "channel": "email"})
        self.client.post("/external-auth/activate/verify",
                         json={"token": token, "code": self.sent_email[-1][1]})
        self._age_all()
        cookies = {bff_session.SESSION_COOKIE: self._some_session_cookie()}
        r = self.client.post("/external-auth/request-code",
                             json={"email": GUEST, "channel": "email"}, cookies=cookies)
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post("/external-auth/login-verify",
                             json={"email": GUEST, "code": self.sent_email[-1][1]}, cookies=cookies)
        self.assertEqual(r.status_code, 200, r.text)

    def test_exemption_is_tight_not_blanket(self):
        """An AUTHENTICATED session posting to any NORMAL endpoint is still
        CSRF-checked: cookie without the X-CSRF-Token header -> 403 from the
        guard; with the matching header the guard passes (whatever the endpoint
        itself then says, it is never the CSRF rejection)."""
        db = database.SessionLocal()
        try:
            sid, csrf = bff_session.create_passwordless_session(db, ADMIN)
        finally:
            db.close()
        cookies = {bff_session.SESSION_COOKIE: sid}
        r = self.client.post("/notifications", json={"id": "x", "type": "t", "title": "t", "body": "b"},
                             cookies=cookies)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["detail"], "CSRF token missing or invalid")
        r = self.client.post("/notifications", json={"id": "x", "type": "t", "title": "t", "body": "b"},
                             cookies=cookies, headers={"X-CSRF-Token": csrf})
        self.assertNotEqual(r.json().get("detail"), "CSRF token missing or invalid")


class TestAccountSwitch(_Base):
    """Account-switch confirmation (Aug 18, Visesh: activating a guest silently
    replaced his admin session). The pre-auth endpoints READ the session cookie
    (never require it) and report who this browser is already signed in as, so
    the frontend can confirm before the new session replaces the old."""

    def _admin_session(self):
        db = database.SessionLocal()
        try:
            sid, _ = bff_session.create_passwordless_session(db, ADMIN)
        finally:
            db.close()
        return sid

    def test_lookup_reports_foreign_session_conflict(self):
        self._enroll()
        token = self._token()
        # No cookie: no conflict, nothing reported
        body = self.client.post("/external-auth/activate/lookup", json={"token": token}).json()
        self.assertIsNone(body["signedInAs"])
        self.assertFalse(body["sessionConflict"])
        # A DIFFERENT identity's cookie: conflict, with who it is
        body = self.client.post("/external-auth/activate/lookup", json={"token": token},
                                cookies={bff_session.SESSION_COOKIE: self._admin_session()}).json()
        self.assertTrue(body["sessionConflict"])
        self.assertEqual(body["signedInAs"]["email"], ADMIN)
        self.assertTrue(body["signedInAs"]["name"])          # display name, never blank

    def test_same_email_session_is_not_a_conflict(self):
        self._enroll()
        token = self._token()
        db = database.SessionLocal()
        try:
            sid, _ = bff_session.create_passwordless_session(db, GUEST)
        finally:
            db.close()
        body = self.client.post("/external-auth/activate/lookup", json={"token": token},
                                cookies={bff_session.SESSION_COOKIE: sid}).json()
        self.assertFalse(body["sessionConflict"])            # just re-signing-in
        self.assertEqual(body["signedInAs"]["email"], GUEST)

    def test_request_code_reports_conflict_and_stays_generic(self):
        self._enroll()
        token = self._token()
        self.client.post("/external-auth/activate/send-code", json={"token": token, "channel": "email"})
        self.client.post("/external-auth/activate/verify",
                         json={"token": token, "code": self.sent_email[-1][1]})
        self._age_all()
        body = self.client.post("/external-auth/request-code",
                                json={"email": GUEST, "channel": "email"},
                                cookies={bff_session.SESSION_COOKIE: self._admin_session()}).json()
        self.assertEqual(body["message"], ext_auth.GENERIC_MSG)   # anti-enumeration intact
        self.assertTrue(body["sessionConflict"])
        self.assertEqual(body["signedInAs"]["email"], ADMIN)
        # An UNKNOWN email gets the identical shape - the conflict fields
        # describe only the caller's own cookie, never the target account.
        body = self.client.post("/external-auth/request-code",
                                json={"email": "nobody@nowhere.example"},
                                cookies={bff_session.SESSION_COOKIE: self._admin_session()}).json()
        self.assertEqual(body["message"], ext_auth.GENERIC_MSG)
        self.assertTrue(body["sessionConflict"])

    def test_continue_still_replaces_the_session(self):
        """After the explicit Continue the flow proceeds exactly as before: the
        verify mints a NEW session cookie that replaces the old one."""
        self._enroll()
        token = self._token()
        old_sid = self._admin_session()
        cookies = {bff_session.SESSION_COOKIE: old_sid}
        self.client.post("/external-auth/activate/send-code",
                         json={"token": token, "channel": "email"}, cookies=cookies)
        r = self.client.post("/external-auth/activate/verify",
                             json={"token": token, "code": self.sent_email[-1][1]}, cookies=cookies)
        self.assertEqual(r.status_code, 200, r.text)
        new_sid = r.cookies.get(bff_session.SESSION_COOKIE)
        self.assertTrue(new_sid)
        self.assertNotEqual(new_sid, old_sid)
        db = database.SessionLocal()
        try:
            row = db.query(models.ServerSession).filter(
                models.ServerSession.id == new_sid).first()
            self.assertEqual(row.user_email, GUEST)
        finally:
            db.close()


class TestStagedRelease(_Base):
    """Neil, Aug 25: create staged -> test with an admin code -> release."""

    def _status_of(self):
        db = database.SessionLocal()
        try:
            row = db.query(models.NexusEmployee).filter(
                models.NexusEmployee.work_email == GUEST).first()
            return row.status if row else None
        finally:
            db.close()

    def test_default_enroll_is_staged_and_sends_nothing(self):
        out = self._enroll(send_invite=False)
        self.assertEqual(out["status"], "staged")
        self.assertEqual(out["inviteStatus"], "")
        self.assertEqual(self.sent_invites, [])
        self.assertIn("testing", out["inviteMessage"].lower())

    def test_staged_gets_no_login_codes_and_generic_200(self):
        self._enroll(send_invite=False)
        r = self.client.post("/external-auth/request-code", json={"email": GUEST})
        self.assertEqual(r.status_code, 200)          # generic - no enumeration
        self.assertEqual(self._code_rows("login"), [])
        self.assertEqual(self.sent_email, [])
        self.assertEqual(self.sent_sms, [])

    def test_staged_resend_and_status_patch_refused(self):
        self._enroll(send_invite=False)
        self.assertEqual(self.client.post(f"/external-users/{GUEST}/invite").status_code, 409)
        r = self.client.patch(f"/external-users/{GUEST}", json={"status": "active"})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(self._status_of(), "staged")

    def test_admin_test_code_signs_in_the_staged_account(self):
        self._enroll(send_invite=False)
        r = self.client.post(f"/external-users/{GUEST}/test-code")
        self.assertEqual(r.status_code, 200, r.text)
        code = r.json()["code"]
        self.assertRegex(code, r"^[A-Z0-9]{8}$")
        v = self.client.post("/external-auth/login-verify",
                             json={"email": GUEST, "code": code.lower()})   # case-insensitive
        self.assertEqual(v.status_code, 200, v.text)
        self.assertIn(bff_session.SESSION_COOKIE, v.cookies)

    def test_test_code_is_single_use_and_wrong_codes_count_attempts(self):
        self._enroll(send_invite=False)
        code = self.client.post(f"/external-users/{GUEST}/test-code").json()["code"]
        self.assertEqual(self.client.post("/external-auth/login-verify",
                                          json={"email": GUEST, "code": "WRONGGGG"}).status_code, 400)
        self.assertEqual(self.client.post("/external-auth/login-verify",
                                          json={"email": GUEST, "code": code}).status_code, 200)
        # consumed - the same code never works twice
        self.assertEqual(self.client.post("/external-auth/login-verify",
                                          json={"email": GUEST, "code": code}).status_code, 400)

    def test_release_flips_active_kills_codes_and_sends_the_invite(self):
        self._enroll(send_invite=False)
        code = self.client.post(f"/external-users/{GUEST}/test-code").json()["code"]
        r = self.client.post(f"/external-users/{GUEST}/release")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "active")
        self.assertEqual(r.json()["inviteStatus"], "sent")
        self.assertEqual(len(self.sent_invites), 1)
        # the pre-release test code died with the release
        v = self.client.post("/external-auth/login-verify",
                             json={"email": GUEST, "code": code})
        self.assertEqual(v.status_code, 400)
        # and released accounts can't mint test codes
        self.assertEqual(self.client.post(f"/external-users/{GUEST}/test-code").status_code, 409)
        self.assertEqual(self.client.post(f"/external-users/{GUEST}/release").status_code, 409)


class TestForcedPhoneVerify(_Base):
    """Neil, Aug 25: email AND phone verified by the user before the session."""

    def test_email_code_with_unverified_phone_requires_sms_stage(self):
        self._enroll(send_invite=True)          # released, invite in hand
        token = self._token()
        # user types their own number and asks for the EMAIL code
        r = self.client.post("/external-auth/activate/send-code",
                             json={"token": token, "phone": "+19495551234", "channel": "email"})
        self.assertEqual(r.status_code, 200, r.text)
        email_code = self.sent_email[-1][1]
        v = self.client.post("/external-auth/activate/verify",
                             json={"token": token, "code": email_code})
        self.assertEqual(v.status_code, 200, v.text)
        body = v.json()
        self.assertTrue(body.get("needsPhoneVerify"), body)     # held - no session yet
        self.assertNotIn(bff_session.SESSION_COOKIE, v.cookies)
        sms_code = self.sent_sms[-1][1]
        self._age_all()                                          # past the resend throttle
        v2 = self.client.post("/external-auth/activate/verify-phone",
                              json={"token": token, "code": sms_code})
        self.assertEqual(v2.status_code, 200, v2.text)
        self.assertIn(bff_session.SESSION_COOKIE, v2.cookies)
        db = database.SessionLocal()
        try:
            row = db.query(models.NexusEmployee).filter(
                models.NexusEmployee.work_email == GUEST).first()
            self.assertTrue(row.phone_verified_at)               # both channels proven
            self.assertEqual(row.invite_status, "accepted")
        finally:
            db.close()

    def test_sms_activation_code_needs_no_second_stage(self):
        self._enroll(send_invite=True)
        token = self._token()
        r = self.client.post("/external-auth/activate/send-code",
                             json={"token": token, "phone": "+19495551234"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["channel"], "sms")
        sms_code = self.sent_sms[-1][1]
        v = self.client.post("/external-auth/activate/verify",
                             json={"token": token, "code": sms_code})
        self.assertEqual(v.status_code, 200, v.text)
        self.assertNotIn("needsPhoneVerify", v.json())
        self.assertIn(bff_session.SESSION_COOKIE, v.cookies)

    def test_admin_attested_phone_skips_the_second_stage(self):
        self._enroll(phone="+19495550000", send_invite=True)     # admin-set = attested
        token = self._token()
        r = self.client.post("/external-auth/activate/send-code",
                             json={"token": token, "channel": "email"})
        self.assertEqual(r.status_code, 200, r.text)
        email_code = self.sent_email[-1][1]
        v = self.client.post("/external-auth/activate/verify",
                             json={"token": token, "code": email_code})
        self.assertEqual(v.status_code, 200, v.text)
        self.assertNotIn("needsPhoneVerify", v.json())
        self.assertIn(bff_session.SESSION_COOKIE, v.cookies)


if __name__ == "__main__":
    unittest.main()
