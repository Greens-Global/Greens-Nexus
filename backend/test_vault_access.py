"""Credentials - audiences, department heads, scoped activity (Oct 29 2026,
vault_access.py + routers/credvault.py).

- a credential with no audience rows keeps the old rule: its own department
  opens it, Critical closes that;
- audiences: a company row opens it to the whole company, a group row to the
  Access Group, a person row to one person, and a view-only row shows the
  username but never the password;
- the department's head and backup head manage the department's credentials
  (edit, share, decide) without owning them;
- the activity log shows an employee their own actions and the credentials
  they manage - not who opened the bank portal;
- a password change tells everyone who can open the credential;
- the Personal Vault password is 10 characters or more.

    cd backend && python -m pytest test_vault_access.py -q
"""
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

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
OWNER = "olive.owner" + D       # IT, owns the credentials
HEAD = "hank.head" + D          # IT department head, owns nothing
PEER = "pia.peer" + D           # IT employee
ACCT = "aaron.acct" + D         # Accounting employee
OPS = "omar.ops" + D            # Operations employee, in the "Night Crew" group
ADMIN = "ada.admin" + D
CO = "co-a"
GROUP = "g-night"

TABLES = (models.VaultCredential, models.VaultCredentialAudience, models.VaultShareRequest, models.VaultAccessGrant,
          models.VaultAccessLog, models.VaultOtpSession, models.VaultPersonalAuth, models.VaultPersonalUnlockSession,
          models.NexusNotification, models.NexusEmployee, models.NexusGroup, models.NexusGroupMember, models.NexusRole,
          models.HrEntity, models.HrDepartment, models.NexusSetting)


def _iso(sec=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=sec)).isoformat()


class VaultAccessTests(unittest.TestCase):
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
        db.add(models.HrEntity(id=CO, name="Greens"))
        db.add(models.HrDepartment(id="d-it", company_id=CO, name="IT", lead_email=HEAD, backup_email=""))
        people = ((OWNER, "IT"), (HEAD, "IT"), (PEER, "IT"), (ACCT, "Accounting"), (OPS, "Operations"), (ADMIN, "IT"))
        for i, (em, dept) in enumerate(people):
            db.add(models.NexusEmployee(id=f"e{i}", first_name=em.split(".")[0].title(), last_name="T", work_email=em,
                                        company=CO, department=dept, status="active", deleted_at=""))
        db.add(models.NexusRole(email=ADMIN, role="administrator", display_name="Ada Admin"))
        db.add(models.NexusGroup(id="g-vault", name="Vault Users", allowed_modules="credvault:editor"))
        db.add(models.NexusGroup(id=GROUP, name="Night Crew", allowed_modules=""))
        for em in (OWNER, HEAD, PEER, ACCT, OPS):
            db.add(models.NexusGroupMember(group_id="g-vault", email=em))
        db.add(models.NexusGroupMember(group_id=GROUP, email=OPS))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()
        auth._role_cache.clear()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client

    def _otp(self, who):
        db = database.SessionLocal()
        db.add(models.VaultOtpSession(id=str(uuid.uuid4()), email=who, purpose="reveal_share", channel="email",
                                      expires_at=_iso(600), created_at=_iso()))
        db.commit()
        db.close()

    def _create(self, who=OWNER, **over):
        body = {"name": "Wi-Fi", "dept": "IT", "type": "Password", "username": "staff", "secret": "Corr3ct-Horse-Battery!",
                "tier": "Standard"}
        body.update(over)
        r = self._as(who).post("/credvault/credentials", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def _row(self, who, cid):
        rows = self._as(who).get("/credvault/credentials").json()
        return next(c for c in rows if c["id"] == cid)

    def _reveal(self, who, cid):
        self._otp(who)
        return self._as(who).post(f"/credvault/credentials/{cid}/reveal").status_code

    def _bells(self, who, title=""):
        db = database.SessionLocal()
        try:
            q = db.query(models.NexusNotification).filter(models.NexusNotification.recipient == who)
            return [n for n in q.all() if title in n.title]
        finally:
            db.close()

    # ── the old rule survives ────────────────────────────────────
    def test_no_audience_rows_means_the_own_department_opens_it(self):
        cid = self._create()
        self.assertEqual(self._row(PEER, cid)["access"], "department")
        self.assertEqual(self._row(ACCT, cid)["access"], "request")
        self.assertEqual(self._reveal(PEER, cid), 200)
        self.assertEqual(self._reveal(ACCT, cid), 403)
        # Created with the form: the department row is written out for it.
        self.assertEqual([a["kind"] for a in self._row(OWNER, cid)["audiences"]], ["department"])

    def test_critical_opens_only_to_named_people(self):
        cid = self._create(tier="Critical")                        # default department row
        self.assertEqual(self._row(PEER, cid)["access"], "request")
        cid2 = self._create(tier="Critical", audiences=[{"kind": "company", "value": CO}, {"kind": "person", "value": ACCT}])
        self.assertEqual(self._row(PEER, cid2)["access"], "request")   # a broad audience never opens Critical
        self.assertEqual(self._row(ACCT, cid2)["access"], "person")

    # ── audiences ─────────────────────────────────────────────────
    def test_company_audience_opens_it_to_everyone_in_the_company(self):
        cid = self._create(audiences=[{"kind": "company", "value": CO}])
        for who in (PEER, ACCT, OPS):
            self.assertEqual(self._row(who, cid)["access"], "company", who)
            self.assertEqual(self._reveal(who, cid), 200, who)
        self.assertEqual(self._row(OWNER, cid)["audiences"][0]["label"], "Everyone at Greens")

    def test_group_and_person_audiences(self):
        cid = self._create(audiences=[{"kind": "group", "value": GROUP}, {"kind": "person", "value": ACCT}])
        self.assertEqual(self._row(OPS, cid)["access"], "group")
        self.assertEqual(self._row(ACCT, cid)["access"], "person")
        self.assertEqual(self._row(PEER, cid)["access"], "request")     # own department no longer implied
        self.assertEqual(self._reveal(PEER, cid), 403)

    def test_view_only_shows_the_username_but_never_the_password(self):
        cid = self._create(audiences=[{"kind": "department", "value": "Accounting", "level": "view"}])
        row = self._row(ACCT, cid)
        self.assertEqual(row["access"], "view")
        self.assertEqual(row["username"], "staff")
        self.assertFalse(row["canReveal"])
        self.assertEqual(self._reveal(ACCT, cid), 403)
        # They can still ask for timed access.
        r = self._as(ACCT).post(f"/credvault/credentials/{cid}/request", json={"durationMs": 3600000, "durationLabel": "1 Hour"})
        self.assertEqual(r.status_code, 200, r.text)

    def test_owner_changes_the_audience_and_it_is_logged(self):
        cid = self._create()
        body = {"name": "Wi-Fi", "dept": "IT", "type": "Password", "username": "staff", "tier": "Standard",
                "audiences": [{"kind": "company", "value": ""}]}
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        self.assertEqual(self._row(ACCT, cid)["access"], "company")
        logs = self._as(OWNER).get("/credvault/logs").json()
        edit = next(e for e in logs if e["action"] == "Edited")
        self.assertEqual(edit["detail"][0]["field"], "Who can open")
        self.assertIn("Everyone in IT", edit["detail"][0]["from"])
        self.assertIn("Everyone, every company", edit["detail"][0]["to"])

    def test_bad_audience_rows_are_dropped(self):
        cid = self._create(audiences=[{"kind": "planet", "value": "Mars"}, {"kind": "department", "value": ""},
                                      {"kind": "person", "value": "ACCT@X.COM"}, {"kind": "person", "value": "acct@x.com"}])
        auds = self._row(OWNER, cid)["audiences"]
        self.assertEqual([(a["kind"], a["value"]) for a in auds], [("person", "acct@x.com")])

    # ── department heads ─────────────────────────────────────────
    def test_the_department_head_manages_the_departments_credentials(self):
        cid = self._create()
        row = self._row(HEAD, cid)
        self.assertEqual(row["access"], "head")
        self.assertTrue(row["canEdit"])
        self.assertEqual(self._reveal(HEAD, cid), 200)
        body = {"name": "Wi-Fi (Staff)", "dept": "IT", "type": "Password", "username": "staff", "tier": "Standard"}
        self.assertEqual(self._as(HEAD).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        # Shares and decides like a backup owner.
        r = self._as(HEAD).post(f"/credvault/credentials/{cid}/share", json={"recipientEmail": ACCT, "durationMs": 3600000, "durationLabel": "1 Hour"})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(OPS).post(f"/credvault/credentials/{cid}/request", json={"durationMs": 3600000, "durationLabel": "1 Hour"})
        reqs = self._as(HEAD).get("/credvault/requests").json()
        self.assertEqual([x["requestedByEmail"] for x in reqs], [OPS])
        self.assertEqual(self._as(HEAD).post(f"/credvault/requests/{reqs[0]['id']}/approve").status_code, 200)
        # Not the head of Accounting, though.
        other = self._create(who=ACCT, name="Intacct", dept="Accounting")
        self.assertEqual(self._row(HEAD, other)["access"], "request")
        self.assertEqual(self._as(HEAD).patch(f"/credvault/credentials/{other}", json={**body, "dept": "Accounting"}).status_code, 403)

    def test_access_endpoint_names_the_heads(self):
        cid = self._create()
        acc = self._as(OWNER).get(f"/credvault/credentials/{cid}/access").json()
        self.assertEqual(acc["heads"], [HEAD])
        self.assertEqual(acc["audiences"][0]["label"], "Everyone in IT")

    # ── activity is scoped ───────────────────────────────────────
    def test_an_employee_sees_only_their_own_actions_and_what_they_manage(self):
        wifi = self._create()
        bank = self._create(who=ACCT, name="Chase", dept="Accounting", tier="Critical", audiences=[])
        self._reveal(ACCT, bank)
        self._reveal(PEER, wifi)
        # Peer: their own reveal, not Accounting's.
        mine = self._as(PEER).get("/credvault/logs").json()
        self.assertEqual({(e["cred"], e["action"]) for e in mine}, {("Wi-Fi", "Revealed")})
        # The owner of Wi-Fi sees Peer's reveal of it, nothing about Chase.
        owner = self._as(OWNER).get("/credvault/logs").json()
        self.assertTrue(any(e["cred"] == "Wi-Fi" and e["actorEmail"] == PEER for e in owner))
        self.assertFalse(any(e["cred"] == "Chase" for e in owner))
        # The head of IT sees everything on IT's credentials; admins see all.
        self.assertTrue(any(e["cred"] == "Wi-Fi" and e["actorEmail"] == PEER for e in self._as(HEAD).get("/credvault/logs").json()))
        self.assertTrue(any(e["cred"] == "Chase" for e in self._as(ADMIN).get("/credvault/logs").json()))

    # ── a password change is announced ───────────────────────────
    def test_a_password_change_tells_everyone_who_can_open_it(self):
        cid = self._create(audiences=[{"kind": "department", "value": "IT"}, {"kind": "person", "value": ACCT},
                                      {"kind": "department", "value": "Operations", "level": "view"}])
        body = {"name": "Wi-Fi", "dept": "IT", "type": "Password", "username": "staff", "tier": "Standard", "secret": "An0ther-Good-One!"}
        self.assertEqual(self._as(OWNER).patch(f"/credvault/credentials/{cid}", json=body).status_code, 200)
        for who in (PEER, HEAD, ACCT):
            bells = self._bells(who, "Password Changed")
            self.assertEqual(len(bells), 1, who)
            self.assertNotIn("An0ther", bells[0].body)
        self.assertEqual(self._bells(OPS, "Password Changed"), [])       # view-only: never had the password
        self.assertEqual(self._bells(OWNER, "Password Changed"), [])     # not the person who changed it
        self.assertEqual(self._bells(OWNER, "Password Changed"), [])

    # ── personal vault lock ──────────────────────────────────────
    def test_personal_vault_password_is_ten_characters_or_more(self):
        self.assertEqual(self._as(PEER).post("/credvault/personal/lock/setup", json={"password": "short12"}).status_code, 400)
        self.assertEqual(self._as(PEER).post("/credvault/personal/lock/setup", json={"password": "long-enough-1"}).status_code, 200)

    def test_import_skips_what_the_vault_holds_and_sets_backup_and_audience(self):
        self._create(name="Zoom Admin", username="it@x.com")
        r = self._as(OWNER).post("/credvault/import", json={"rows": [
            {"name": "Zoom Admin", "username": "it@x.com", "secret": "Dup!2026xx", "department": "IT"},           # already there
            {"name": "Procore", "username": "field", "secret": "Build!2026xx", "department": "Construction", "backupOwner": PEER,
             "audiences": [{"kind": "company", "value": CO}], "url": "https://app.procore.com"},
            {"name": "Wi-Fi Guest", "secret": "Guest!2026xx", "department": "IT"},                               # default: its department
        ]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["imported"], r.json()["skipped"], r.json()["skippedNames"]), (2, 1, ["Zoom Admin"]))
        rows = {c["name"]: c for c in self._as(OWNER).get("/credvault/credentials").json()}
        self.assertEqual(rows["Procore"]["backupOwner"], PEER)
        self.assertEqual(rows["Procore"]["audiences"][0]["kind"], "company")
        self.assertEqual(self._row(ACCT, rows["Procore"]["id"])["access"], "company")
        self.assertEqual(rows["Wi-Fi Guest"]["audiences"][0]["label"], "Everyone in IT")
        self.assertEqual(len([c for c in rows.values() if c["name"] == "Zoom Admin"]), 1)

    def test_offboarding_removes_a_leavers_person_audience(self):
        from routers.credvault import handover_person
        cid = self._create(audiences=[{"kind": "person", "value": OPS}])
        db = database.SessionLocal()
        try:
            handover_person(db, OPS, OWNER, actor=ADMIN)
            db.commit()
            self.assertEqual(db.query(models.VaultCredentialAudience).filter_by(cred_id=cid).count(), 0)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
