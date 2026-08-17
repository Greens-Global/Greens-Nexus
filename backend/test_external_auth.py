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
                models.ServerSession.user_email == GUEST).delete(synchronize_session=False)
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

    def _enroll(self, phone=""):
        self._as_admin()
        r = self.client.post("/external-users", json={
            "email": GUEST, "first_name": "Pat", "last_name": "Partner",
            "company": "BuildCo", "phone": phone})
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


if __name__ == "__main__":
    unittest.main()
