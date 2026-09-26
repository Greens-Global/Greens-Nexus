"""Settings > Global > Security (Sep 2026) - security_config.py + the
/security-settings routes + every consumer reading the effective value.

Covers: precedence (saved > env > default), the env floor on the step-up
switches, hard bounds on write and on read, owner-only PUT (administrator can
only read), the explicit confirm to weaken a switch, the audit row with old and
new values, Reset to Default, and that each consumer (step-up, Act As, the BFF
idle check, the vault unlock windows, guest sign-in) uses the saved value.

Runs against the local SQLite DB like the other test_*.py files:
    python -m pytest test_security_settings.py
"""
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException
from fastapi.testclient import TestClient

import auth
import bff_session
import cache
import database
import main
import models
import security_config as sec
import routers.credvault as credvault
import routers.external_auth as ext_auth
import routers.stepup as stepup

models.Base.metadata.create_all(bind=database.engine)

OWNER = "secprobe.owner@greensglobal.com"
ADMIN = "secprobe.admin@greensglobal.com"
EMPLOYEE = "secprobe.employee@greensglobal.com"
GUEST = "secprobe.guest@buildco.example"
ENV_VARS = [d["env"] for d in sec.SETTINGS.values() if d.get("env")]


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._dev_email = os.environ.get("NEXUS_DEV_EMAIL")
        self._env = {k: os.environ.pop(k) for k in ENV_VARS if k in os.environ}
        db = database.SessionLocal()
        try:
            row = db.query(models.NexusSetting).filter(models.NexusSetting.key == sec.SETTINGS_KEY).first()
            self._saved_row = (row.value, row.updated_by, row.updated_at) if row else None
            if row:
                db.delete(row)
            db.query(models.NexusRole).filter(
                models.NexusRole.email.in_([OWNER, ADMIN, EMPLOYEE])).delete(synchronize_session=False)
            db.add(models.NexusRole(email=OWNER, role="owner", assigned_by="test"))
            db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=EMPLOYEE, role="employee", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()

    def tearDown(self):
        for k in ENV_VARS:
            os.environ.pop(k, None)
        os.environ.update(self._env)
        if self._dev_email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._dev_email
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == sec.SETTINGS_KEY).delete()
            if self._saved_row:
                v, by, at = self._saved_row
                db.add(models.NexusSetting(key=sec.SETTINGS_KEY, value=v, updated_by=by, updated_at=at))
            db.query(models.NexusRole).filter(
                models.NexusRole.email.in_([OWNER, ADMIN, EMPLOYEE])).delete(synchronize_session=False)
            db.query(models.AuditLog).filter(
                models.AuditLog.resource_type == "security_settings",
                models.AuditLog.user_email.in_([OWNER, ADMIN])).delete(synchronize_session=False)
            db.query(models.ActAsSession).filter(models.ActAsSession.real_email == OWNER).delete()
            db.query(models.StepUpSession).filter(models.StepUpSession.email.in_([OWNER, ADMIN])).delete()
            db.query(models.ExternalLoginCode).filter(models.ExternalLoginCode.email == GUEST).delete()
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        cache.settings_config.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _save_raw(self, values: dict):
        """Write the blob directly (bypassing the PUT's validation)."""
        db = database.SessionLocal()
        try:
            row = db.query(models.NexusSetting).filter(models.NexusSetting.key == sec.SETTINGS_KEY).first()
            if not row:
                row = models.NexusSetting(key=sec.SETTINGS_KEY)
                db.add(row)
            row.value = json.dumps(values)
            db.commit()
        finally:
            db.close()
        cache.settings_config.invalidate()

    def _put(self, values, confirm=False):
        self._as(OWNER)
        return self.client.put("/security-settings", json={"values": values, "confirmWeaken": confirm})


class TestPrecedence(_Base):
    def test_defaults_when_nothing_saved_or_set(self):
        eff = sec.effective()
        self.assertEqual(eff["stepupTtlSec"], 300)
        self.assertEqual(eff["stepupMaxAgeSec"], 120)
        self.assertFalse(eff["stepupEnforce"])
        self.assertFalse(eff["stepupRequireMfa"])
        self.assertEqual(eff["webSessionIdleDays"], 30)
        self.assertEqual(eff["actAsMinutes"], 240)
        self.assertEqual(eff["vaultOtpUnlockSec"], 300)
        self.assertEqual(eff["vaultPersonalUnlockSec"], 600)
        self.assertEqual((eff["guestCodeTtlMin"], eff["guestMaxAttempts"], eff["guestLockoutMin"],
                          eff["guestInviteTtlDays"], eff["guestRequestsPerHour"]), (10, 5, 15, 7, 5))
        db = database.SessionLocal()
        try:
            self.assertTrue(all(v["source"] == "default" for v in sec.describe(db).values()))
        finally:
            db.close()

    def test_env_beats_default_and_saved_beats_env(self):
        os.environ["NEXUS_STEPUP_TTL_SEC"] = "600"
        self.assertEqual(sec.resolve("stepupTtlSec", {}), (600, "env"))
        self._save_raw({"stepupTtlSec": 900})
        self.assertEqual(sec.get("stepupTtlSec"), 900)
        self.assertEqual(sec.resolve("stepupTtlSec", sec.saved()), (900, "saved"))

    def test_out_of_range_env_still_applies_but_is_flagged(self):
        # "Nothing changes on deploy" - whatever the server runs today stays.
        os.environ["NEXUS_STEPUP_TTL_SEC"] = "3600"
        db = database.SessionLocal()
        try:
            d = sec.describe(db)["stepupTtlSec"]
        finally:
            db.close()
        self.assertEqual((d["value"], d["source"], d["outOfRange"]), (3600, "env", True))

    def test_out_of_bounds_saved_value_is_ignored_on_read(self):
        self._save_raw({"actAsMinutes": 100000, "guestMaxAttempts": "5", "webSessionIdleDays": True})
        eff = sec.effective()
        self.assertEqual(eff["actAsMinutes"], 240)
        self.assertEqual(eff["guestMaxAttempts"], 5)
        self.assertEqual(eff["webSessionIdleDays"], 30)

    def test_env_on_is_a_floor_for_the_safety_switches(self):
        os.environ["NEXUS_STEPUP_ENFORCE"] = "true"
        self._save_raw({"stepupEnforce": False})
        self.assertTrue(sec.get("stepupEnforce"))
        self.assertTrue(sec.env_locked("stepupEnforce"))
        r = self._put({"stepupEnforce": False}, confirm=True)
        self.assertEqual(r.status_code, 400)

    def test_env_off_does_not_lock(self):
        os.environ["NEXUS_STEPUP_REQUIRE_MFA"] = "false"
        self.assertFalse(sec.env_locked("stepupRequireMfa"))
        self.assertEqual(sec.resolve("stepupRequireMfa", {}), (False, "env"))
        self._save_raw({"stepupRequireMfa": True})
        self.assertTrue(sec.get("stepupRequireMfa"))


class TestRoutes(_Base):
    def test_get_admin_ok_employee_denied(self):
        self._as(ADMIN)
        r = self.client.get("/security-settings")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body["canEdit"])
        s = body["settings"]["actAsMinutes"]
        self.assertEqual((s["value"], s["source"], s["min"], s["max"], s["locked"]), (240, "default", 15, 480, False))
        self._as(EMPLOYEE)
        self.assertIn(self.client.get("/security-settings").status_code, (401, 403))

    def test_put_is_owner_only(self):
        self._as(ADMIN)
        r = self.client.put("/security-settings", json={"values": {"actAsMinutes": 60}})
        self.assertIn(r.status_code, (401, 403))
        self.assertEqual(sec.get("actAsMinutes"), 240)
        r = self._put({"actAsMinutes": 60})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["canEdit"])
        self.assertEqual(r.json()["settings"]["actAsMinutes"]["source"], "saved")
        self.assertEqual(sec.get("actAsMinutes"), 60)

    def test_bounds_rejected(self):
        bad = [
            {"actAsMinutes": 14}, {"actAsMinutes": 481},
            {"webSessionIdleDays": 0}, {"webSessionIdleDays": 31},
            {"stepupTtlSec": 59}, {"stepupMaxAgeSec": 1801},
            {"guestCodeTtlMin": 4}, {"guestCodeTtlMin": 31},
            {"guestMaxAttempts": 2}, {"guestMaxAttempts": 11},
            {"guestLockoutMin": 4}, {"guestLockoutMin": 61},
            {"guestInviteTtlDays": 0}, {"guestInviteTtlDays": 15},
            {"guestRequestsPerHour": 2}, {"guestRequestsPerHour": 11},
            {"vaultOtpUnlockSec": 59}, {"vaultPersonalUnlockSec": 1801},
            {"actAsMinutes": "60"}, {"actAsMinutes": 60.5}, {"actAsMinutes": True},
            {"stepupEnforce": "yes"}, {"noSuchSetting": 1},
        ]
        for values in bad:
            with self.subTest(values=values):
                self.assertEqual(self._put(values).status_code, 400)
        self.assertEqual(sec.saved(), {})

    def test_edges_accepted(self):
        r = self._put({"actAsMinutes": 15, "webSessionIdleDays": 30, "guestInviteTtlDays": 14,
                       "stepupTtlSec": 1800, "vaultPersonalUnlockSec": 60.0})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sec.get("vaultPersonalUnlockSec"), 60)

    def test_turning_a_switch_off_needs_confirm(self):
        self.assertEqual(self._put({"stepupEnforce": True}).status_code, 200)
        r = self._put({"stepupEnforce": False})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["detail"]["code"], "confirm_required")
        self.assertTrue(sec.get("stepupEnforce"))
        self.assertEqual(self._put({"stepupEnforce": False}, confirm=True).status_code, 200)
        self.assertFalse(sec.get("stepupEnforce"))

    def test_audit_row_has_old_and_new(self):
        self._put({"actAsMinutes": 60, "guestLockoutMin": 30})
        db = database.SessionLocal()
        try:
            row = (db.query(models.AuditLog)
                   .filter(models.AuditLog.resource_type == "security_settings",
                           models.AuditLog.action == "security_settings_updated")
                   .order_by(models.AuditLog.id.desc()).first())
        finally:
            db.close()
        self.assertIsNotNone(row)
        self.assertEqual(row.user_email, OWNER)
        d = json.loads(row.details)
        self.assertEqual(d["changes"]["actAsMinutes"], {"old": 240, "new": 60})
        self.assertEqual(d["changes"]["guestLockoutMin"], {"old": 15, "new": 30})

    def test_reset_to_default_clears_the_saved_value(self):
        os.environ["NEXUS_VAULT_OTP_TTL_SEC"] = "420"
        self._put({"vaultOtpUnlockSec": 120, "actAsMinutes": 60})
        self.assertEqual(sec.get("vaultOtpUnlockSec"), 120)
        r = self._put({"vaultOtpUnlockSec": None, "actAsMinutes": None})
        self.assertEqual(r.status_code, 200)
        s = r.json()["settings"]
        self.assertEqual((s["vaultOtpUnlockSec"]["value"], s["vaultOtpUnlockSec"]["source"]), (420, "env"))
        self.assertEqual((s["actAsMinutes"]["value"], s["actAsMinutes"]["source"]), (240, "default"))


class TestConsumers(_Base):
    def test_act_as_expiry_uses_saved_minutes(self):
        self._put({"actAsMinutes": 30})
        self._as(OWNER)
        before = datetime.now(timezone.utc)
        r = self.client.post("/act-as/start", json={"target_email": EMPLOYEE})
        self.assertEqual(r.status_code, 200, r.text)
        exp = datetime.strptime(r.json()["expires_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        self.assertAlmostEqual((exp - before).total_seconds(), 30 * 60, delta=5)

    def test_stepup_ttl_and_config_use_saved_values(self):
        self._put({"stepupTtlSec": 90, "stepupEnforce": True, "stepupRequireMfa": True})
        cfg = self.client.get("/stepup/config").json()
        self.assertEqual((cfg["enforced"], cfg["ttlSec"], cfg["requireMfa"]), (True, 90, True))
        self._as(ADMIN)
        r = self.client.post("/stepup/verify", json={})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["secondsRemaining"], 90)

    def test_require_stepup_follows_the_saved_switch(self):
        db = database.SessionLocal()
        user = {"email": "secprobe.nobody@greensglobal.com", "role": "employee", "level": 1}
        try:
            with mock.patch.object(stepup, "SKIP_AUTH", False):
                self.assertEqual(stepup.require_stepup(user, db), user)       # default: off
                self._save_raw({"stepupEnforce": True})
                with self.assertRaises(HTTPException) as cm:
                    stepup.require_stepup(user, db)
                self.assertEqual(cm.exception.status_code, 403)
        finally:
            db.close()

    def test_stepup_max_age_and_mfa_use_saved_values(self):
        import time
        claims = {"preferred_username": ADMIN, "auth_time": int(time.time()) - 200, "amr": ["pwd"]}
        with mock.patch.object(stepup, "_get_public_key", return_value="k"), \
             mock.patch.object(stepup.pyjwt, "decode", return_value=claims):
            # default max age 120s -> a 200s-old sign-in is too old
            with self.assertRaises(HTTPException):
                stepup._validate_reauth_token("t", ADMIN)
            self._save_raw({"stepupMaxAgeSec": 300})
            self.assertEqual(stepup._validate_reauth_token("t", ADMIN)["auth_time"], claims["auth_time"])
            self._save_raw({"stepupMaxAgeSec": 300, "stepupRequireMfa": True})
            with self.assertRaises(HTTPException) as cm:
                stepup._validate_reauth_token("t", ADMIN)
            self.assertEqual(cm.exception.detail["code"], "mfa_required")

    def test_bff_idle_uses_saved_days(self):
        seen = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
        row = SimpleNamespace(last_seen=seen)
        self.assertFalse(bff_session._idle_expired(row))        # default 30 days
        self._save_raw({"webSessionIdleDays": 2})
        self.assertTrue(bff_session._idle_expired(row))

    def test_vault_unlock_windows_use_saved_seconds(self):
        self._save_raw({"vaultOtpUnlockSec": 120, "vaultPersonalUnlockSec": 240})
        db = database.SessionLocal()
        try:
            self.assertEqual(credvault._otp_ttl(db), 120)
            ttl = credvault._open_personal_unlock(db, "secprobe.vault@greensglobal.com")
            self.assertEqual(ttl, 240)
            db.rollback()
        finally:
            db.close()

    def test_guest_code_ttl_lockout_and_hourly_cap_use_saved_values(self):
        self._save_raw({"guestCodeTtlMin": 20, "guestMaxAttempts": 3, "guestLockoutMin": 45,
                        "guestRequestsPerHour": 3, "guestInviteTtlDays": 2})
        db = database.SessionLocal()
        try:
            ext_auth._issue_code(db, GUEST, "login", "email", "")
            row = (db.query(models.ExternalLoginCode)
                   .filter(models.ExternalLoginCode.email == GUEST, models.ExternalLoginCode.purpose == "login")
                   .first())
            exp = datetime.fromisoformat(row.expires_at)
            self.assertAlmostEqual((exp - datetime.now(timezone.utc)).total_seconds(), 20 * 60, delta=10)
            # A code killed at 3 attempts 30 minutes ago still locks (45-minute window).
            row.attempts = 3
            row.consumed_at = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
            db.commit()
            self.assertTrue(ext_auth._locked_out(db, GUEST))
            self._save_raw({"guestLockoutMin": 15})
            self.assertFalse(ext_auth._locked_out(db, GUEST))
            # Hourly cap: 3 saved -> 3 codes in the hour is the limit.
            self._save_raw({"guestRequestsPerHour": 3})
            for _ in range(2):
                db.add(models.ExternalLoginCode(
                    id=os.urandom(8).hex(), email=GUEST, code_hash="x", purpose="login", channel="email",
                    expires_at=ext_auth._iso(), attempts=0, created_ip="", consumed_at="",
                    created_at=(datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()))
            db.commit()
            self.assertTrue(ext_auth._rate_limited(db, GUEST, ""))
        finally:
            db.close()

    def test_guest_email_copy_uses_saved_values(self):
        self._save_raw({"guestCodeTtlMin": 20, "guestInviteTtlDays": 1})
        sent = []
        with mock.patch.object(ext_auth.graph_mail, "send_mail", side_effect=lambda **kw: sent.append(kw["html"])), \
             mock.patch.object(ext_auth, "_from_email", return_value="noreply@example.com"):
            ext_auth._send_email_code(GUEST, "123456")
            ext_auth._send_invite_email(GUEST, "Pat Partner", "Admin", "", "tok")
        self.assertIn("expires in 20 minutes", sent[0])
        self.assertIn("expires in 1 day.", sent[1])


if __name__ == "__main__":
    unittest.main()
