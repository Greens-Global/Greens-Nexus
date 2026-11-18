"""Sharing a login with someone OUTSIDE Nexus (11/13/2026, vault_external.py,
routers/vault_share.py).

  - The email link alone shows the login's name, never a secret; the
    username, link and password come back only after a one-time code.
  - A wrong code is refused; an ended or expired share answers 410.
  - Nexus People are refused (they get a normal share); 7 days at most; a
    Critical login goes outside only with a Super Administrator's code.
  - When the share ends, the owner, backup owner and department head are told
    once to change the password; the login shows Shared Outside until then.

Throwaway sqlite. Run with: python -m pytest test_vault_external.py
"""
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

import levels_testkit as kit

kit.bind_db()

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import vault_external  # noqa: E402

D = "@greensglobal.com"
HEAD, BOSS, BACKUP = "he.head" + D, "bo.boss" + D, "ba.backup" + D
CO = "co-lv"
OUT = "vendor@acme-example.com"


def _iso(sec=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=sec)).isoformat()


class OutsideShareTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        mock.patch("vault_breach.pwned_count", return_value=0).start()
        self.addCleanup(mock.patch.stopall)
        db = database.SessionLocal()
        try:
            kit.reset(db, models.VaultCredential, models.VaultAccessLog, models.VaultOtpChallenge, models.VaultOtpSession,
                      models.HrDepartment, models.VaultCredentialAudience, models.VaultExternalShare, models.VaultAccessGrant)
            for em in (HEAD, BACKUP):
                kit.person(db, em)
                kit.grant(db, em, "credvault:editor")
            kit.person(db, BOSS, role="owner")
            db.add(models.HrDepartment(id="d-ops", company_id=CO, name="Operations", lead_email=HEAD, backup_email=""))
            for em in (HEAD, BOSS):     # each sharer has verified their own code (require_vault_otp)
                db.add(models.VaultOtpSession(id=str(uuid.uuid4()), email=em, purpose="reveal_share", channel="email",
                                              expires_at=_iso(600), created_at=_iso()))
            db.commit()
        finally:
            db.close()
        kit.refresh()
        kit.as_(HEAD)
        r = self.client.post("/credvault/credentials", json={"name": "Vendor Portal", "dept": "Operations", "companyId": CO,
                                                              "secret": "Corr3ct-Horse-Battery!", "username": "ops", "url": "https://portal.example.com",
                                                              "backupOwner": BACKUP})
        self.assertEqual(r.status_code, 200, r.text)
        self.cid = r.json()["id"]

    def _share(self, who=HEAD, **over):
        kit.as_(who)
        body = {"externals": [{"email": OUT}], "durationMs": 4 * 3600000, "durationLabel": "4 Hours", **over}
        return self.client.post(f"/credvault/credentials/{self.cid}/share", json=body)

    def _token(self, r):
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["devLinks"][0]["link"].rsplit("/", 1)[1]

    def _db(self):
        db = database.SessionLocal()
        self.addCleanup(db.close)
        return db

    def test_the_link_shows_nothing_secret_until_the_code(self):
        token = self._token(self._share())
        peek = self.client.get(f"/vault-share/{token}")
        self.assertEqual(peek.status_code, 200)
        self.assertEqual((peek.json()["state"], peek.json()["name"]), ("active", "Vendor Portal"))
        self.assertNotIn("Corr3ct", peek.text)
        sent = self.client.post(f"/vault-share/{token}/code", json={"channel": "email"}).json()
        bad = self.client.post(f"/vault-share/{token}/verify", json={"challengeId": sent["challengeId"], "code": "000000"})
        self.assertEqual(bad.status_code, 400)
        ok = self.client.post(f"/vault-share/{token}/verify", json={"challengeId": sent["challengeId"], "code": sent["devCode"]})
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual((ok.json()["username"], ok.json()["url"], ok.json()["secret"]), ("ops", "https://portal.example.com", "Corr3ct-Horse-Battery!"))
        self.assertEqual(ok.headers["cache-control"], "no-store, max-age=0")       # the answer with the secret is never stored
        actions = [log.action for log in self._db().query(models.VaultAccessLog).all()]
        for a in ("Shared Outside", "Outside Share Opened", "Outside Share Code Sent", "Outside Share Viewed"):
            self.assertIn(a, actions)
        self.assertEqual(self.client.get("/vault-share/not-a-real-token").status_code, 404)

    def test_rules_nexus_people_seven_days_and_critical(self):
        r = self._share(externals=[{"email": BACKUP}])
        self.assertEqual(r.status_code, 400)
        self.assertIn("Nexus People", r.json()["detail"])
        r = self._share(durationMs=8 * 86400000)
        self.assertEqual(r.status_code, 400)
        kit.as_(HEAD)
        self.client.patch(f"/credvault/credentials/{self.cid}", json={"name": "Vendor Portal", "dept": "Operations", "tier": "Critical"})
        r = self._share()                                     # the head is not a Super Administrator
        self.assertEqual((r.status_code, r.json()["detail"]["code"]), (403, "head_code_required"))
        self.assertEqual(r.json()["detail"]["scopes"][0]["dept"], "Critical Logins")
        self.assertEqual(self._share(who=BOSS).status_code, 200)

    def test_when_it_ends_the_owners_change_the_password_once(self):
        token = self._token(self._share())
        kit.as_(HEAD)
        rows = {c["id"]: c for c in self.client.get("/credvault/credentials").json()}
        self.assertTrue(rows[self.cid]["sharedOutside"])
        share_id = self.client.get(f"/credvault/credentials/{self.cid}/access").json()["externals"][0]["id"]
        self.assertEqual(self.client.post(f"/credvault/external-shares/{share_id}/end").status_code, 200)
        self.assertEqual(self.client.get(f"/vault-share/{token}").json()["state"], "ended")
        self.assertEqual(self.client.post(f"/vault-share/{token}/code", json={}).status_code, 410)
        db = self._db()
        self.assertEqual(vault_external.run_expiry_pass(), 1)
        self.assertEqual(vault_external.run_expiry_pass(), 0)                  # once
        bells = db.query(models.NexusNotification).filter(models.NexusNotification.title == "Credentials - Change the Password").all()
        self.assertEqual({b.recipient for b in bells}, {HEAD, BACKUP})        # owner (the head) and backup owner
        self.assertIn(OUT, bells[0].body)
        # A new password clears Shared Outside.
        self.client.patch(f"/credvault/credentials/{self.cid}", json={"name": "Vendor Portal", "dept": "Operations", "secret": "N3w-Rotated-Value!"})
        rows = {c["id"]: c for c in self.client.get("/credvault/credentials").json()}
        self.assertFalse(rows[self.cid]["sharedOutside"])

    def test_an_expired_share_alerts_and_a_changed_password_does_not(self):
        self._token(self._share())
        db = self._db()
        db.query(models.VaultExternalShare).update({"expires_at": _iso(-60)})
        db.commit()
        self.assertEqual(vault_external.run_expiry_pass(), 1)
        self._token(self._share())
        kit.as_(HEAD)
        self.client.patch(f"/credvault/credentials/{self.cid}", json={"name": "Vendor Portal", "dept": "Operations", "secret": "Ch4nged-Already-99!"})
        db.query(models.VaultExternalShare).filter(models.VaultExternalShare.change_alerted_at == "").update({"expires_at": _iso(-60)})
        db.commit()
        self.assertEqual(vault_external.run_expiry_pass(), 0)                  # already changed: nothing to tell


if __name__ == "__main__":
    unittest.main()
