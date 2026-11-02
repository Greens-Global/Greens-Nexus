"""Credentials - the Oct 29 2026 security pass (vault_totp.py, vault_breach.py,
routers/credvault.py).

- authenticator codes: RFC 6238 test vector, key normalization from pasted
  text and otpauth links, the code on reveal and the refresh endpoint, only
  for people who may open the credential;
- breach check: the flag is set from Have I Been Pwned on save (HIBP mocked),
  fails open when HIBP is unreachable, and the daily scan tells the owner
  once when a password turns breached;
- key rotation: a second key in NEXUS_VAULT_KEYS reads old rows and the
  rotate pass rewrites them under the newest key;
- every reveal is logged with where it came from (IP, browser);
- a Critical credential can require a fresh Microsoft sign-in (step-up).

    cd backend && python -m pytest test_vault_security.py -q
"""
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

from cryptography.fernet import Fernet

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
OLD_KEY = Fernet.generate_key().decode()
NEW_KEY = Fernet.generate_key().decode()
os.environ["NEXUS_VAULT_KEY"] = OLD_KEY        # the key rows were written under

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import vault_breach  # noqa: E402
import vault_totp  # noqa: E402
from routers import credvault as CV  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
OWNER, PEER, OTHER, ADMIN = "olive.owner" + D, "pia.peer" + D, "omar.other" + D, "ada.admin" + D
TABLES = (models.VaultCredential, models.VaultCredentialAudience, models.VaultAccessLog, models.VaultOtpSession, models.StepUpSession,
          models.NexusNotification, models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusRole, models.HrEntity, models.NexusSetting)
RFC_KEY_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"       # "12345678901234567890" - RFC 6238 appendix B


def _iso(sec=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=sec)).isoformat()


class VaultSecurityTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = database.SessionLocal()
        for m in TABLES:
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id="co", name="Greens"))
        for i, (em, dept) in enumerate(((OWNER, "IT"), (PEER, "IT"), (OTHER, "Ops"), (ADMIN, "IT"))):
            db.add(models.NexusEmployee(id=f"e{i}", first_name="T", last_name="T", work_email=em, company="co", department=dept, status="active", deleted_at=""))
        db.add(models.NexusRole(email=ADMIN, role="administrator", display_name="Ada Admin"))
        db.add(models.NexusGroup(id="g-vault", name="Vault Users", allowed_modules="credvault:editor"))
        for em in (OWNER, PEER, OTHER):
            db.add(models.NexusGroupMember(group_id="g-vault", email=em))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()
        auth._role_cache.clear()
        # HIBP is never called for real in tests.
        self._hibp = mock.patch.object(vault_breach, "pwned_count", return_value=0)
        self.hibp = self._hibp.start()

    def tearDown(self):
        self._hibp.stop()
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client

    def _otp(self, who):
        db = database.SessionLocal()
        db.add(models.VaultOtpSession(id=str(uuid.uuid4()), email=who, purpose="reveal_share", channel="email", expires_at=_iso(600), created_at=_iso()))
        db.commit()
        db.close()

    def _create(self, who=OWNER, **over):
        body = {"name": "Bank Portal", "dept": "IT", "type": "Password", "username": "treasury", "secret": "Corr3ct-Horse-Battery!", "tier": "Standard"}
        body.update(over)
        r = self._as(who).post("/credvault/credentials", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def _row(self, who, cid):
        return next(c for c in self._as(who).get("/credvault/credentials").json() if c["id"] == cid)

    # ── authenticator codes ─────────────────────────────────────
    def test_totp_matches_the_rfc_vector_and_keys_normalize(self):
        self.assertEqual(vault_totp.code_at(RFC_KEY_B32, 59)[0], "287082")           # RFC 6238, T=59, SHA1, 6 digits of 94287082
        self.assertEqual(vault_totp.code_at(RFC_KEY_B32, 1111111109)[0], "081804")
        self.assertEqual(vault_totp.normalize("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"), RFC_KEY_B32)
        self.assertEqual(vault_totp.normalize(f"otpauth://totp/Greens:treasury?secret={RFC_KEY_B32}&issuer=Greens"), RFC_KEY_B32)
        self.assertEqual(vault_totp.normalize("not a key 189!"), "")

    def test_code_comes_with_the_reveal_and_from_the_refresh_endpoint_for_openers_only(self):
        cid = self._create(totpSecret=f"otpauth://totp/x?secret={RFC_KEY_B32}")
        self.assertTrue(self._row(OWNER, cid)["hasTotp"])
        self._otp(OWNER)
        r = self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal").json()
        self.assertEqual(r["totp"]["code"], vault_totp.code_at(RFC_KEY_B32)[0])
        self.assertTrue(0 < r["totp"]["left"] <= 30)
        self.assertEqual(self._as(OWNER).get(f"/credvault/credentials/{cid}/totp").json()["code"], r["totp"]["code"])
        self._otp(OTHER)
        self.assertEqual(self._as(OTHER).get(f"/credvault/credentials/{cid}/totp").status_code, 403)   # Ops cannot open it
        # Clearing it, and a bad key is refused.
        body = {"name": "Bank Portal", "dept": "IT", "type": "Password", "username": "treasury", "tier": "Standard", "clearTotp": True}
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        self.assertFalse(self._row(OWNER, cid)["hasTotp"])
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json={**body, "clearTotp": False, "totpSecret": "???"}).status_code, 400)

    # ── breach check ────────────────────────────────────────────
    def test_breached_flag_is_set_on_save_and_fails_open(self):
        self.hibp.return_value = 12345
        cid = self._create()
        self.assertTrue(self._row(OWNER, cid)["breached"])
        self.hibp.return_value = None                                              # HIBP down: the flag is left alone
        body = {"name": "Bank Portal", "dept": "IT", "type": "Password", "username": "treasury", "tier": "Standard", "secret": "An0ther-Good-One!"}
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        self.assertTrue(self._row(OWNER, cid)["breached"])
        self.hibp.return_value = 0
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json={**body, "secret": "Third-Clean-One!9"}).status_code, 200)
        self.assertFalse(self._row(OWNER, cid)["breached"])

    def test_daily_scan_flags_and_tells_the_owner_once(self):
        cid = self._create(backupOwner=PEER)
        self.hibp.return_value = 7
        db = database.SessionLocal()
        try:
            out = CV.breach_scan(db)
            self.assertEqual((out["checked"], out["newly"]), (1, 1))
            bells = db.query(models.NexusNotification).filter(models.NexusNotification.type == "vault_breach").all()
            self.assertEqual(sorted(b.recipient for b in bells), sorted([OWNER, PEER]))
            self.assertNotIn("Corr3ct", bells[0].body)
            out2 = CV.breach_scan(db)                                              # already flagged: no second bell
            self.assertEqual(out2["newly"], 0)
            self.assertEqual(db.query(models.NexusNotification).filter(models.NexusNotification.type == "vault_breach").count(), 2)
            self.assertTrue(db.get(models.VaultCredential, cid).breached)
        finally:
            db.close()

    # ── key rotation ────────────────────────────────────────────
    def test_a_new_primary_key_reads_old_rows_and_the_rotate_pass_rewrites_them(self):
        cid = self._create()
        old_token = CV._get_cred(cid, database.SessionLocal()).secret_enc
        with mock.patch.dict(os.environ, {"NEXUS_VAULT_KEYS": f"{NEW_KEY},{OLD_KEY}"}):
            CV.load_keys()
            try:
                self._otp(OWNER)
                self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal").json()["secret"], "Corr3ct-Horse-Battery!")
                db = database.SessionLocal()
                try:
                    n = CV.rotate_vault_keys(db)
                    self.assertGreaterEqual(n, 1)
                    row = db.get(models.VaultCredential, cid)
                    db.refresh(row)
                    self.assertNotEqual(row.secret_enc, old_token)
                    self.assertEqual(Fernet(NEW_KEY.encode()).decrypt(row.secret_enc.encode()).decode(), "Corr3ct-Horse-Battery!")
                finally:
                    db.close()
                self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal").json()["secret"], "Corr3ct-Horse-Battery!")
            finally:
                os.environ.pop("NEXUS_VAULT_KEYS", None)
                CV.load_keys()
        # Back on the old key alone the rotated row cannot be read - the key
        # list must keep the old key until the pass has run everywhere.
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal").status_code, 500)

    # ── where from ──────────────────────────────────────────────
    def test_reveals_are_logged_with_ip_and_browser(self):
        cid = self._create()
        self._otp(OWNER)
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal", headers={"User-Agent": "TestBrowser/1.0"}).status_code, 200)
        logs = self._as(OWNER).get("/credvault/logs").json()
        rev = next(e for e in logs if e["action"] == "Revealed")
        self.assertTrue(rev["ip"])
        self.assertEqual(rev["userAgent"], "TestBrowser/1.0")

    # ── step-up for Critical ────────────────────────────────────
    def test_critical_can_require_a_fresh_microsoft_sign_in(self):
        cid = self._create(tier="Critical")
        self._otp(OWNER)
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal").status_code, 200)   # off by default
        db = database.SessionLocal()
        db.add(models.NexusSetting(key="security_config", value=json.dumps({"vaultCriticalStepUp": True}), updated_by="t", updated_at=_iso()))
        db.commit()
        db.close()
        cache.settings_config.invalidate()
        r = self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal")
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (403, "stepup_required"))
        db = database.SessionLocal()
        db.add(models.StepUpSession(id=str(uuid.uuid4()), email=OWNER, method="reauth", granted_at=_iso(), expires_at=_iso(300)))
        db.commit()
        db.close()
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal").status_code, 200)
        # Standard credentials never ask for it.
        std = self._create(name="Wi-Fi")
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{std}/reveal").status_code, 200)


if __name__ == "__main__":
    unittest.main()
