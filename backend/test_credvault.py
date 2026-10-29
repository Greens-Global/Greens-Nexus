"""Credential Vault - the Oct 14 2026 hardening pass (routers/credvault.py).

What the vault promises and this file holds it to:
- the reuse hash is keyed with the vault key (not a bare SHA-256), and the
  one-time rehash moves legacy rows over exactly once;
- a Personal Vault reveal is logged, but the row is shown to its actor only -
  not to other grant holders, not to admins;
- the owner, backup owner OR an admin edit, remove, recover and transfer a
  credential; anyone else is refused (recover used to be open to all);
- the owner of a Critical credential reads it; anyone else gets a request that
  goes to the OWNER, who decides - or an admin does (Neil: "either");
- tier can change after creation;
- offboarding hands the leaver's credentials on, clears their backup role,
  ends their shared access and closes their requests - personal vault untouched;
- with the company walls armed, a credential is only visible on its owner's
  side of the wall (list, by id, logs).

    cd backend && .venv/bin/python -m pytest test_credvault.py -q
"""
import hashlib
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import credvault as CV  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
OWNER = "olive.owner" + D       # grant holder, owns the credentials
BACKUP = "bea.backup" + D       # grant holder, backup owner
OTHER = "omar.other" + D        # grant holder, nothing else
ADMIN = "ada.admin" + D         # administrator tier
FAR = "fay.far" + D             # grant holder in the other company
NOGRANT = "nina.none" + D       # signed in, no vault grant
PEER = "pia.peer" + D           # grant holder in the OWNER's department (Accounting)
CO_A, CO_B = "co-a", "co-b"

VAULT_TABLES = (models.VaultCredential, models.VaultPersonalCredential, models.VaultShareRequest,
                models.VaultAccessGrant, models.VaultAccessLog, models.VaultOtpSession,
                models.VaultOtpChallenge, models.VaultPersonalAuth, models.VaultPersonalUnlockSession)


def _iso(delta_sec=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_sec)).isoformat()


class VaultHardeningTests(unittest.TestCase):
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
        for m in VAULT_TABLES + (models.NexusNotification, models.NexusEmployee, models.NexusGroup,
                                 models.NexusGroupMember, models.NexusRole, models.HrEntity, models.NexusSetting):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=CO_A, name="Company A"))
        db.add(models.HrEntity(id=CO_B, name="Company B"))
        people = ((OWNER, CO_A, "Accounting"), (BACKUP, CO_A, "Accounting"), (OTHER, CO_A, "Operations"),
                  (ADMIN, CO_A, "IT"), (FAR, CO_B, "Accounting"), (NOGRANT, CO_A, "Accounting"), (PEER, CO_A, "Accounting"))
        for i, (em, co, dept) in enumerate(people):
            db.add(models.NexusEmployee(id=f"e{i}", first_name=em.split(".")[0].title(), last_name="T",
                                        work_email=em, company=co, department=dept, status="active", deleted_at=""))
        db.add(models.NexusRole(email=ADMIN, role="administrator", display_name="Ada Admin"))
        db.add(models.NexusGroup(id="g-vault", name="Vault Users", allowed_modules="credvault:editor"))
        for em in (OWNER, BACKUP, OTHER, FAR, PEER):
            db.add(models.NexusGroupMember(group_id="g-vault", email=em))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()
        auth._role_cache.clear()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    # ── helpers ────────────────────────────────────────────────────────────
    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client

    def _otp(self, who):
        """A verified SMS/Email code - what require_vault_otp looks for."""
        db = database.SessionLocal()
        db.add(models.VaultOtpSession(id=str(uuid.uuid4()), email=who, purpose="reveal_share",
                                      channel="email", expires_at=_iso(600), created_at=_iso()))
        db.commit()
        db.close()

    def _create(self, who=OWNER, **over):
        body = {"name": "Stripe", "dept": "Accounting", "type": "Password", "username": "pay@x.com",
                "secret": "Corr3ct-Horse-Battery!", "tier": "Standard", "backupOwner": BACKUP}
        body.update(over)
        r = self._as(who).post("/credvault/credentials", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def _cred(self, cid):
        db = database.SessionLocal()
        try:
            c = db.get(models.VaultCredential, cid)
            db.refresh(c)
            return c
        finally:
            db.close()

    def _logs(self, who):
        r = self._as(who).get("/credvault/logs")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _arm_walls(self):
        db = database.SessionLocal()
        db.add(models.NexusSetting(key="company_walls", value="on"))
        db.commit()
        db.close()
        cache.settings_config.invalidate()

    # ── keyed reuse hash ───────────────────────────────────────────────────
    def test_reuse_hash_is_keyed_not_a_bare_sha256(self):
        self.assertNotEqual(CV._hash("hunter2"), hashlib.sha256(b"hunter2").hexdigest())
        self.assertEqual(CV._hash("hunter2"), CV._hash("hunter2"))       # still deterministic: reuse detection works

    def test_rehash_converts_legacy_rows_once(self):
        cid = self._create()
        db = database.SessionLocal()
        c = db.get(models.VaultCredential, cid)
        c.secret_hash = hashlib.sha256(b"Corr3ct-Horse-Battery!").hexdigest()   # what the old code stored
        db.commit()
        self.assertEqual(CV.rehash_secret_hashes(db), 1)
        self.assertEqual(db.get(models.VaultCredential, cid).secret_hash, CV._hash("Corr3ct-Horse-Battery!"))
        self.assertEqual(CV.rehash_secret_hashes(db), 0)                 # marked: a no-op from now on
        self.assertIsNotNone(db.get(models.NexusSetting, CV.REHASH_MARK))
        db.close()

    def test_reused_flag_survives_the_keyed_hash(self):
        self._create(name="A", secret="Same-Secret-123!")
        self._create(name="B", secret="Same-Secret-123!")
        rows = self._as(OWNER).get("/credvault/credentials").json()
        self.assertEqual({r["name"]: r["reused"] for r in rows}, {"A": True, "B": True})

    # ── personal vault rows in the log ─────────────────────────────────────
    def test_personal_reveal_is_logged_for_its_owner_only(self):
        db = database.SessionLocal()
        db.add(models.VaultPersonalCredential(id="p1", owner_email=OTHER, name="Home WiFi", username="-",
                                              secret_enc=CV._enc("wifi-pass"), created_at=_iso()))
        db.add(models.VaultPersonalUnlockSession(id="u1", email=OTHER, expires_at=_iso(600), created_at=_iso()))
        db.commit()
        db.close()
        r = self._as(OTHER).post("/credvault/personal/p1/reveal")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["secret"], "wifi-pass")
        self.assertEqual([e["cred"] for e in self._logs(OTHER)], ["Home WiFi"])
        self.assertEqual(self._logs(OWNER), [])
        self.assertEqual(self._logs(ADMIN), [])                        # not even an admin

    # ── who may modify ─────────────────────────────────────────────────────
    def test_recover_from_trash_needs_owner_backup_or_admin(self):
        cid = self._create()
        self.assertEqual(self._as(OWNER).delete(f"/credvault/credentials/{cid}").status_code, 200)
        self.assertEqual(self._as(OTHER).post(f"/credvault/credentials/{cid}/restore").status_code, 403)
        self.assertEqual(self._as(BACKUP).post(f"/credvault/credentials/{cid}/restore").status_code, 200)
        self.assertEqual(self._as(OWNER).delete(f"/credvault/credentials/{cid}").status_code, 200)
        self.assertEqual(self._as(ADMIN).post(f"/credvault/credentials/{cid}/restore").status_code, 200)
        self.assertEqual(self._cred(cid).deleted_at, "")

    def test_admin_edits_and_removes_what_they_do_not_own(self):
        cid = self._create()
        body = {"name": "Stripe Live", "dept": "Accounting", "type": "Password", "username": "pay@x.com",
                "secret": "", "tier": "Standard", "backupOwner": BACKUP}
        self.assertEqual(self._as(OTHER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 403)
        self.assertEqual(self._as(ADMIN).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        self.assertEqual(self._cred(cid).name, "Stripe Live")
        self.assertEqual(self._as(OTHER).delete(f"/credvault/credentials/{cid}").status_code, 403)
        self.assertEqual(self._as(ADMIN).delete(f"/credvault/credentials/{cid}").status_code, 200)

    def test_tier_can_change_after_creation(self):
        cid = self._create()
        body = {"name": "Stripe", "dept": "Accounting", "type": "Password", "username": "pay@x.com",
                "secret": "", "tier": "Critical", "backupOwner": BACKUP}
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        self.assertEqual(self._cred(cid).tier, "Critical")
        edit = [e for e in self._logs(OWNER) if e["action"] == "Edited"][0]
        self.assertIn({"field": "Tier", "from": "Standard", "to": "Critical"}, edit["detail"])

    # ── Critical tier ──────────────────────────────────────────────────────
    def test_owner_and_backup_read_their_own_critical_entry(self):
        cid = self._create(tier="Critical")
        for who in (OWNER, BACKUP, ADMIN):
            self._otp(who)
            r = self._as(who).post(f"/credvault/credentials/{cid}/reveal")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json().get("secret"), "Corr3ct-Horse-Battery!", who)

    def test_critical_request_goes_to_the_owner_and_either_owner_or_admin_decides(self):
        cid = self._create(tier="Critical")
        self._otp(OTHER)
        r = self._as(OTHER).post(f"/credvault/credentials/{cid}/reveal")
        self.assertEqual(r.status_code, 403)                            # reveal never hands it over
        self.assertEqual(r.json()["detail"]["code"], "vault_access_required")
        r = self._as(OTHER).post(f"/credvault/credentials/{cid}/request", json={"durationMs": 3600000, "durationLabel": "1 Hour"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"requested": True})
        # Asking again while it waits does not pile up requests or bells.
        self.assertEqual(self._as(OTHER).post(f"/credvault/credentials/{cid}/request", json={}).json(),
                         {"requested": True, "pending": True})
        # The owner (and backup) were told; nothing was broadcast to every manager.
        db = database.SessionLocal()
        bells = db.query(models.NexusNotification).filter(models.NexusNotification.type == "vault_access").all()
        self.assertEqual({b.recipient for b in bells}, {OWNER, BACKUP})
        db.close()
        # The owner, the backup owner and an admin see the request; a bystander does not.
        for who in (OWNER, ADMIN):
            reqs = self._as(who).get("/credvault/requests").json()
            self.assertEqual([q["requestedByEmail"] for q in reqs], [OTHER], who)
        self.assertEqual(self._as(PEER).get("/credvault/requests").json(), [])
        rid = self._as(OWNER).get("/credvault/requests").json()[0]["id"]
        self.assertEqual(self._as(PEER).post(f"/credvault/requests/{rid}/approve").status_code, 403)
        self.assertEqual(self._as(OWNER).post(f"/credvault/requests/{rid}/approve").status_code, 200)
        # The requester now reads it through the grant - and through the credential itself.
        grants = self._as(OTHER).get("/credvault/grants").json()
        self.assertEqual(len(grants), 1)
        self._otp(OTHER)
        self.assertEqual(self._as(OTHER).post(f"/credvault/grants/{grants[0]['id']}/reveal").json()["secret"],
                         "Corr3ct-Horse-Battery!")
        self.assertEqual(self._as(OTHER).post(f"/credvault/credentials/{cid}/reveal").json()["secret"],
                         "Corr3ct-Horse-Battery!")

    def test_admin_decides_a_request_addressed_to_the_owner(self):
        cid = self._create(tier="Critical")
        self._as(OTHER).post(f"/credvault/credentials/{cid}/request", json={})
        rid = self._as(ADMIN).get("/credvault/requests").json()[0]["id"]
        self.assertEqual(self._as(ADMIN).post(f"/credvault/requests/{rid}/deny").status_code, 200)
        self.assertEqual(self._as(OWNER).get("/credvault/requests").json(), [])
        db = database.SessionLocal()
        told = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == OTHER).all()
        self.assertTrue(any("Declined" in (b.title or "") for b in told))        # the requester hears back
        db.close()

    def test_backup_owner_shares_directly(self):
        cid = self._create()
        self._otp(BACKUP)
        r = self._as(BACKUP).post(f"/credvault/credentials/{cid}/share",
                                  json={"recipientEmail": OTHER, "durationMs": 3600000, "durationLabel": "1 Hour"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"granted": True})

    # ── ownership ──────────────────────────────────────────────────────────
    def test_transfer_by_owner_backup_or_admin_to_someone_in_people(self):
        cid = self._create()
        self.assertEqual(self._as(OTHER).post(f"/credvault/credentials/{cid}/transfer",
                                              json={"ownerEmail": OTHER}).status_code, 403)
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/transfer",
                                              json={"ownerEmail": "stranger@elsewhere.com"}).status_code, 400)
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{cid}/transfer",
                                              json={"ownerEmail": OWNER}).status_code, 400)
        # Handing it to the backup owner clears the backup slot.
        r = self._as(OWNER).post(f"/credvault/credentials/{cid}/transfer", json={"ownerEmail": BACKUP})
        self.assertEqual(r.status_code, 200, r.text)
        c = self._cred(cid)
        self.assertEqual((c.owner_email, c.backup_owner_email), (BACKUP, ""))
        moved = [e for e in self._logs(BACKUP) if e["action"] == "Transferred"]
        self.assertEqual(moved[0]["detail"][0], {"field": "Owner", "from": OWNER, "to": BACKUP})
        # An admin can re-own it again; the new owner is told by bell.
        self.assertEqual(self._as(ADMIN).post(f"/credvault/credentials/{cid}/transfer",
                                              json={"ownerEmail": OTHER}).status_code, 200)
        self.assertEqual(self._cred(cid).owner_email, OTHER)
        db = database.SessionLocal()
        told = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == OTHER).all()
        self.assertTrue(any("Now the Owner" in (b.title or "") for b in told))
        db.close()

    def test_offboarding_hands_credentials_on_and_ends_the_leavers_access(self):
        mine = self._create(name="Owned by Olive")
        theirs = self._create(name="Owned by Bea", who=BACKUP, backupOwner=OWNER)
        db = database.SessionLocal()
        db.add(models.VaultAccessGrant(id="g1", cred_id=theirs, granted_to=OWNER, granted_by=BACKUP,
                                       granted_at=_iso(), expires_at=_iso(3600)))
        db.add(models.VaultShareRequest(id="r1", cred_id=theirs, requested_by_email=OWNER, shared_to_email=OWNER,
                                        owner_email=BACKUP, status="pending", created_at=_iso()))
        db.add(models.VaultPersonalCredential(id="p9", owner_email=OWNER, name="Olive's bank", username="-",
                                              secret_enc=CV._enc("x"), created_at=_iso()))
        db.commit()
        out = CV.handover_person(db, OWNER, OTHER, actor=ADMIN)
        db.commit()
        self.assertEqual({k: out[k] for k in ("credentials", "backups", "grants", "requests")},
                         {"credentials": 1, "backups": 1, "grants": 1, "requests": 1})
        self.assertEqual(db.get(models.VaultCredential, mine).owner_email, OTHER)
        self.assertEqual(db.get(models.VaultCredential, theirs).backup_owner_email, "")
        self.assertLessEqual(db.get(models.VaultAccessGrant, "g1").expires_at, _iso())
        self.assertEqual(db.get(models.VaultShareRequest, "r1").status, "denied")
        self.assertIsNotNone(db.get(models.VaultPersonalCredential, "p9"))     # personal vault untouched
        db.close()

    def test_offboarding_with_nobody_to_inherit_still_ends_access(self):
        cid = self._create()
        db = database.SessionLocal()
        out = CV.handover_person(db, OWNER, "", actor=ADMIN)
        db.commit()
        self.assertEqual(out["credentials"], 0)
        self.assertEqual(db.get(models.VaultCredential, cid).owner_email, OWNER)   # admins can transfer it later
        db.close()

    # ── department scope (Neil, Oct 14 2026) ────────────────────────────────
    def test_department_decides_who_can_open_a_standard_credential(self):
        cid = self._create()                                            # Accounting, owned by Olive
        rows = {r["name"]: r for r in self._as(PEER).get("/credvault/credentials").json()}
        self.assertEqual(rows["Stripe"]["access"], "department")
        self.assertTrue(rows["Stripe"]["canReveal"])
        self.assertEqual(rows["Stripe"]["username"], "pay@x.com")
        rows = {r["name"]: r for r in self._as(OTHER).get("/credvault/credentials").json()}
        self.assertEqual(rows["Stripe"]["access"], "request")           # Operations: sees it exists, no more
        self.assertFalse(rows["Stripe"]["canReveal"])
        self.assertEqual(rows["Stripe"]["username"], "")
        self.assertEqual(rows["Stripe"]["owner"], OWNER)
        self._otp(PEER)
        self.assertEqual(self._as(PEER).post(f"/credvault/credentials/{cid}/reveal").json()["secret"], "Corr3ct-Horse-Battery!")
        self._otp(OTHER)
        self.assertEqual(self._as(OTHER).post(f"/credvault/credentials/{cid}/reveal").status_code, 403)
        # Someone who can already open it has nothing to request.
        self.assertEqual(self._as(PEER).post(f"/credvault/credentials/{cid}/request", json={}).status_code, 400)

    def test_critical_closes_the_department_shortcut(self):
        cid = self._create(tier="Critical")
        rows = {r["name"]: r for r in self._as(PEER).get("/credvault/credentials").json()}
        self.assertEqual(rows["Stripe"]["access"], "request")
        self._otp(PEER)
        self.assertEqual(self._as(PEER).post(f"/credvault/credentials/{cid}/reveal").status_code, 403)

    def test_a_grant_opens_it_and_shows_until_when(self):
        cid = self._create()
        self._otp(OWNER)
        self._as(OWNER).post(f"/credvault/credentials/{cid}/share",
                             json={"recipientEmail": OTHER, "durationMs": 3600000, "durationLabel": "1 Hour"})
        row = [r for r in self._as(OTHER).get("/credvault/credentials").json() if r["id"] == cid][0]
        self.assertEqual(row["access"], "shared")
        self.assertTrue(row["canReveal"] and row["grantUntil"])
        # The owner sees who has it, and can end it early.
        acc = self._as(OWNER).get(f"/credvault/credentials/{cid}/access").json()
        self.assertEqual([g["email"] for g in acc["grants"]], [OTHER])
        self.assertEqual(self._as(OTHER).get(f"/credvault/credentials/{cid}/access").json()["grants"], [])
        self.assertEqual(self._as(OTHER).delete(f"/credvault/grants/{acc['grants'][0]['id']}").status_code, 403)
        self.assertEqual(self._as(OWNER).delete(f"/credvault/grants/{acc['grants'][0]['id']}").status_code, 200)
        row = [r for r in self._as(OTHER).get("/credvault/credentials").json() if r["id"] == cid][0]
        self.assertEqual(row["access"], "request")

    def test_only_owners_share(self):
        cid = self._create()
        self._otp(PEER)
        r = self._as(PEER).post(f"/credvault/credentials/{cid}/share",
                                json={"recipientEmail": OTHER, "durationMs": 3600000, "durationLabel": "1 Hour"})
        self.assertEqual(r.status_code, 403)

    def test_trash_is_shown_only_to_people_who_can_recover(self):
        cid = self._create()
        self._as(OWNER).delete(f"/credvault/credentials/{cid}")
        self.assertEqual([r["id"] for r in self._as(PEER).get("/credvault/credentials").json()], [])
        self.assertEqual([r["id"] for r in self._as(BACKUP).get("/credvault/credentials").json()], [cid])

    # ── notes, expiry, previous password ───────────────────────────────────
    def test_notes_expiry_and_previous_password(self):
        cid = self._create(note="Ask Olive before changing", expiresAt="2027-03-01")
        row = [r for r in self._as(PEER).get("/credvault/credentials").json() if r["id"] == cid][0]
        self.assertEqual((row["note"], row["expiresAt"]), ("Ask Olive before changing", "2027-03-01"))
        self.assertEqual([r for r in self._as(OTHER).get("/credvault/credentials").json() if r["id"] == cid][0]["note"], "")
        self.assertEqual(self._as(OWNER).post("/credvault/credentials", json={"name": "Bad", "secret": "x", "expiresAt": "03/01/2027"}).status_code, 400)
        body = {"name": "Stripe", "dept": "Accounting", "type": "Password", "username": "pay@x.com",
                "secret": "N3w-Secret-Value!", "tier": "Standard", "backupOwner": BACKUP, "note": "", "expiresAt": ""}
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        self._otp(OWNER)
        r = self._as(OWNER).post(f"/credvault/credentials/{cid}/reveal").json()
        self.assertEqual((r["secret"], r["previousSecret"]), ("N3w-Secret-Value!", "Corr3ct-Horse-Battery!"))
        self._otp(PEER)
        self.assertNotIn("previousSecret", self._as(PEER).post(f"/credvault/credentials/{cid}/reveal").json())
        row = [r for r in self._as(OWNER).get("/credvault/credentials").json() if r["id"] == cid][0]
        self.assertTrue(row["hasPrevious"])

    def test_import_takes_url_and_notes(self):
        r = self._as(OWNER).post("/credvault/import", json={"rows": [
            {"name": "Jira", "department": "IT", "type": "Password", "username": "u", "secret": "s3cret-Long-1!", "tier": "High",
             "url": "https://jira.example.com", "note": "Shared team login"}]})
        self.assertEqual(r.json(), {"imported": 1})
        row = [c for c in self._as(OWNER).get("/credvault/credentials").json() if c["name"] == "Jira"][0]
        self.assertEqual((row["url"], row["note"], row["tier"]), ("https://jira.example.com", "Shared team login", "High"))

    # ── identity check window ──────────────────────────────────────────────
    def test_otp_status_says_until_when(self):
        self.assertEqual(self._as(OWNER).get("/credvault/otp/status").json()["verified"], False)
        self._otp(OWNER)
        st = self._as(OWNER).get("/credvault/otp/status").json()
        self.assertTrue(st["verified"] and st["until"] and st["windowSec"] == 900)

    # ── personal vault edit ────────────────────────────────────────────────
    def test_personal_credential_can_be_edited_by_its_owner_only(self):
        db = database.SessionLocal()
        db.add(models.VaultPersonalCredential(id="p2", owner_email=OTHER, name="Bank", username="me",
                                              secret_enc=CV._enc("old"), created_at=_iso()))
        db.add(models.VaultPersonalUnlockSession(id="u2", email=OTHER, expires_at=_iso(600), created_at=_iso()))
        db.commit()
        db.close()
        body = {"name": "Bank (joint)", "username": "me", "secret": "", "type": "Password", "note": "with Sam"}
        self.assertEqual(self._as(OWNER).patch("/credvault/personal/p2", json=body).status_code, 404)
        self.assertEqual(self._as(OTHER).patch("/credvault/personal/p2", json=body).status_code, 200)
        self.assertEqual(self._as(OTHER).post("/credvault/personal/p2/reveal").json()["secret"], "old")   # blank keeps it
        rows = self._as(OTHER).get("/credvault/personal").json()
        self.assertEqual((rows[0]["name"], rows[0]["note"]), ("Bank (joint)", "with Sam"))

    # ── daily reminders ────────────────────────────────────────────────────
    def test_rotation_reminders_once_a_day_to_owner_and_backup(self):
        cid = self._create()
        db = database.SessionLocal()
        c = db.get(models.VaultCredential, cid)
        c.rotated_at = (datetime.now(timezone.utc) - timedelta(days=85)).isoformat()    # due in 5 days
        db.commit()
        self.assertEqual(CV.rotation_reminders(db), 2)
        self.assertEqual(CV.rotation_reminders(db), 0)                                 # same day: no repeat
        bells = db.query(models.NexusNotification).filter(models.NexusNotification.type == "vault_rotation").all()
        self.assertEqual({b.recipient for b in bells}, {OWNER, BACKUP})
        self.assertIn("due in 5 days", bells[0].body)
        self.assertEqual(json.loads(bells[0].action), {"view": "credvault", "sub": f"cred-{cid}"})
        db.close()

    def test_bells_carry_where_to_open(self):
        cid = self._create(tier="Critical")
        self._as(OTHER).post(f"/credvault/credentials/{cid}/request", json={})
        db = database.SessionLocal()
        ask = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == OWNER).first()
        self.assertEqual(json.loads(ask.action), {"view": "credvault", "sub": "approvals"})
        db.close()

    # ── review fixes (Oct 14 2026) ─────────────────────────────────────────
    def test_links_must_be_http(self):
        r = self._as(OWNER).post("/credvault/credentials", json={"name": "Evil", "dept": "IT", "secret": "x-Long-Secret-1!", "url": "javascript:alert(1)"})
        self.assertEqual(r.status_code, 400)
        cid = self._create(url="https://ok.example.com")
        body = {"name": "Stripe", "dept": "Accounting", "type": "Password", "username": "pay@x.com", "secret": "", "tier": "Standard",
                "backupOwner": BACKUP, "url": "data:text/html,hi"}
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 400)
        self._as(OWNER).post("/credvault/import", json={"rows": [{"name": "Imp", "department": "IT", "secret": "s3cret-Long-1!", "url": "javascript:void(0)"}]})
        row = [c for c in self._as(OWNER).get("/credvault/credentials").json() if c["name"] == "Imp"][0]
        self.assertEqual(row["url"], "")

    def test_rows_you_cannot_open_carry_no_health_facts(self):
        cid = self._create(secret="weak")
        row = [c for c in self._as(OTHER).get("/credvault/credentials").json() if c["id"] == cid][0]
        self.assertEqual((row["strength"], row["reused"], row["rotatedAt"], row["rotatedDays"], row["expiresInDays"], row["hasPrevious"]),
                         ("", False, "", 0, None, False))
        row = [c for c in self._as(PEER).get("/credvault/credentials").json() if c["id"] == cid][0]
        self.assertEqual(row["strength"], "weak")

    def test_backup_owner_decides_requests_too(self):
        cid = self._create(tier="Critical")
        self._as(OTHER).post(f"/credvault/credentials/{cid}/request", json={})
        reqs = self._as(BACKUP).get("/credvault/requests").json()
        self.assertEqual(len(reqs), 1)
        self.assertEqual(self._as(PEER).post(f"/credvault/requests/{reqs[0]['id']}/approve").status_code, 403)
        self.assertEqual(self._as(BACKUP).post(f"/credvault/requests/{reqs[0]['id']}/approve").status_code, 200)

    def test_share_only_with_people_in_nexus(self):
        cid = self._create()
        self._otp(OWNER)
        r = self._as(OWNER).post(f"/credvault/credentials/{cid}/share",
                                 json={"recipientEmail": "olivia@greensglobal.com", "durationMs": 3600000, "durationLabel": "1 Hour"})
        self.assertEqual(r.status_code, 400)

    def test_a_department_named_personal_is_not_mistaken_for_the_personal_vault(self):
        self._create(name="Shared Thing", dept="Personal")
        # Oct 29 2026: the log is scoped (own actions + what you manage), so an
        # admin is the seat that sees every company row - the point here is only
        # that a department called Personal is not treated as the Personal Vault.
        self.assertIn("Shared Thing", [e["cred"] for e in self._logs(ADMIN)])

    def test_an_admin_behind_a_company_wall_cannot_decide_another_companys_request(self):
        far = self._create(name="Far", who=FAR, backupOwner="", tier="Critical")
        db = database.SessionLocal()
        db.add(models.NexusEmployee(id="e-zed", first_name="Zed", last_name="B", work_email="zed.b" + D, company=CO_B,
                                    department="Operations", status="active", deleted_at=""))
        db.add(models.NexusGroupMember(group_id="g-vault", email="zed.b" + D))
        # A populated Global Admins group: level alone no longer sees across the wall.
        db.add(models.NexusGroup(id="g-ga", name="Global Admins", allowed_modules="", is_global_admin=1))
        db.add(models.NexusGroupMember(group_id="g-ga", email=FAR))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        self.assertEqual(self._as("zed.b" + D).post(f"/credvault/credentials/{far}/request", json={}).status_code, 200)
        self._arm_walls()
        self.assertEqual(self._as(ADMIN).get("/credvault/requests").json(), [])
        rid = self._as(FAR).get("/credvault/requests").json()[0]["id"]
        self.assertEqual(self._as(ADMIN).post(f"/credvault/requests/{rid}/approve").status_code, 404)
        self.assertEqual(self._as(ADMIN).post(f"/credvault/requests/{rid}/deny").status_code, 404)
        self.assertEqual(self._as(FAR).post(f"/credvault/requests/{rid}/approve").status_code, 200)

    # ── company walls ──────────────────────────────────────────────────────
    def test_company_walls_keep_a_credential_on_its_owners_side(self):
        near = self._create(name="Near")
        far = self._create(name="Far", who=FAR, backupOwner="")
        self._arm_walls()
        self.assertEqual([c["name"] for c in self._as(OWNER).get("/credvault/credentials").json()], ["Near"])
        self.assertEqual([c["name"] for c in self._as(FAR).get("/credvault/credentials").json()], ["Far"])
        self.assertEqual({c["name"] for c in self._as(ADMIN).get("/credvault/credentials").json()}, {"Near", "Far"})
        self._otp(OWNER)
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{far}/reveal").status_code, 404)
        self.assertEqual(self._as(OWNER).post(f"/credvault/credentials/{near}/reveal").status_code, 200)
        # The log follows the credential: Fay's "Created" row is not Olive's to see.
        self.assertNotIn("Far", [e["cred"] for e in self._logs(OWNER)])
        self.assertIn("Far", [e["cred"] for e in self._logs(FAR)])
        self.assertIn("Far", [e["cred"] for e in self._logs(ADMIN)])

    def test_no_grant_no_vault(self):
        self.assertEqual(self._as(NOGRANT).get("/credvault/credentials").status_code, 403)


if __name__ == "__main__":
    unittest.main()
