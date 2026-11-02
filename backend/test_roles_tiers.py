"""Tiers (Neil, 11/02/2026, docs/superpowers/plans/2026-11-02-roles-tiers.md,
Task 2): an Administrator (level 4) is company-walled whether or not the
`company_walls` switch is on; only a Super Administrator (level 5, or a
member of a group flagged is_global_admin) sees past the walls; a level-4
caller cannot flag a group, touch a flagged group's members, arm the walls
or grant the administrator / owner tier; the five Super Administrators are
set ONCE by super_admins_seed.apply_once; /roles/me carries level and title.

    python -m pytest test_roles_tiers.py
"""
import os
import tempfile
import time
import unittest

# A throwaway sqlite of its own (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import super_admins_seed  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

COA, COB = "ent-tiers-a", "ent-tiers-b"
SUPER = "tiers.super@greensglobal.com"     # owner (level 5), company A
ADMIN_A = "tiers.admina@greensglobal.com"  # administrator (level 4), company A
ADMIN_NOCO = "tiers.noco@greensglobal.com"  # administrator with no company anywhere
AEMP = "tiers.aemp@greensglobal.com"       # employee, company A
BEMP = "tiers.bemp@greensglobal.com"       # employee, company B
GA_GROUP = "grp-tiers-ga"
PLAIN = "grp-tiers-plain"
SETTINGS = "/timeclock/shift-requests/settings"

TABLES = (models.NexusRole, models.NexusEmployee, models.NexusGroup, models.NexusGroupMember,
          models.HrEntity, models.TaskTicket, models.Announcement, models.NexusSetting,
          models.NexusAccessScope, models.AuditLog)


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        db = database.SessionLocal()
        try:
            for m in TABLES:
                db.query(m).execution_options(include_deleted=True, include_confidential=True).delete(synchronize_session=False)
            db.add(models.HrEntity(id=COA, name="Alpha Co"))
            db.add(models.HrEntity(id=COB, name="Beta Co"))
            company = {SUPER: COA, ADMIN_A: COA, ADMIN_NOCO: "", AEMP: COA, BEMP: COB}
            for em, co in company.items():
                db.add(models.NexusEmployee(id=f"e-{em}", first_name=em.split(".")[1].split("@")[0].title(),
                                            last_name="Tiers", work_email=em, status="active", deleted_at="",
                                            company=co, job_title="IT Lead" if em == ADMIN_A else ""))
            db.add(models.NexusRole(email=SUPER, role="owner"))
            db.add(models.NexusRole(email=ADMIN_A, role="administrator"))
            db.add(models.NexusRole(email=ADMIN_NOCO, role="administrator"))
            db.add(models.NexusRole(email=AEMP, role="employee"))
            db.add(models.NexusRole(email=BEMP, role="employee"))
            # Company A's own group: an Administrator works only on their
            # companies' groups (a shared one is a Super Administrator's).
            db.add(models.NexusGroup(id=PLAIN, name="Plain Group", allowed_modules="tasks:viewer", company_id=COA))
            db.add(models.NexusGroup(id=GA_GROUP, name="Global Admins", is_global_admin=1))
            db.add(models.NexusGroupMember(group_id=GA_GROUP, email=SUPER))
            db.commit()
        finally:
            db.close()
        self._flush()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        self._flush()

    def _flush(self):
        cache.settings_config.invalidate()
        cache.module_grants.invalidate()
        cache.people_directory.invalidate()
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _walls(self, on):
        db = database.SessionLocal()
        try:
            row = db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").first()
            if not row:
                row = models.NexusSetting(key="company_walls"); db.add(row)
            row.value = "on" if on else ""
            db.commit()
        finally:
            db.close()
        self._flush()

    def _db(self):
        return database.SessionLocal()


class WallRuleTests(_Base):
    """Review Focus 1: the wall for level 4 holds with the switch OFF."""

    def test_company_scope_by_level_with_walls_off(self):
        db = self._db()
        try:
            self.assertFalse(auth._company_walls_on(db))
            # Levels 1-3 keep the switch's meaning: off = unrestricted.
            self.assertIsNone(auth.company_scope({"email": AEMP, "level": 1}, db))
            self.assertIsNone(auth.company_scope({"email": AEMP, "level": 3}, db))
            # Level 4 is walled regardless; no company anywhere = nothing (fail closed).
            self.assertEqual(auth.company_scope({"email": ADMIN_A, "level": 4}, db), {COA})
            self.assertEqual(auth.company_scope({"email": ADMIN_NOCO, "level": 4}, db), set())
            # Level 5 is never walled.
            self.assertIsNone(auth.company_scope({"email": SUPER, "level": 5}, db))
            # hr_scope follows: an Administrator's People reach is their company.
            self.assertEqual(auth.hr_scope({"email": ADMIN_A, "level": 4}, db), {COA})
            self.assertIsNone(auth.hr_scope({"email": SUPER, "level": 5}, db))
        finally:
            db.close()

    def test_company_scope_with_walls_on_unchanged_for_lower_tiers(self):
        self._walls(True)
        db = self._db()
        try:
            self.assertEqual(auth.company_scope({"email": AEMP, "level": 1}, db), {COA})
            self.assertEqual(auth.company_scope({"email": BEMP, "level": 1}, db), {COB})
            self.assertEqual(auth.company_scope({"email": ADMIN_A, "level": 4}, db), {COA})
            self.assertIsNone(auth.company_scope({"email": SUPER, "level": 5}, db))
        finally:
            db.close()

    def test_is_global_admin_is_level_5_or_flagged_group_only(self):
        db = self._db()
        try:
            self.assertTrue(auth.is_global_admin({"email": SUPER, "level": 5}, db))
            self.assertFalse(auth.is_global_admin({"email": ADMIN_A, "level": 4}, db))
            self.assertFalse(auth.is_global_admin({"email": ADMIN_NOCO, "level": 4}, db))
            # A flagged group's member passes whatever their level.
            db.add(models.NexusGroupMember(group_id=GA_GROUP, email=AEMP)); db.commit()
            self.assertTrue(auth.is_global_admin({"email": AEMP, "level": 1}, db))
            # No flagged group at all: level 4 is still NOT global (no bootstrap fallback).
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GA_GROUP).delete()
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GA_GROUP).delete()
            db.commit()
            self.assertFalse(auth.is_global_admin({"email": ADMIN_A, "level": 4}, db))
            self.assertTrue(auth.is_global_admin({"email": SUPER, "level": 5}, db))
        finally:
            db.close()

    def test_level_4_gets_404_on_company_b_person_walls_off(self):
        self._as(ADMIN_A)
        self.assertEqual(self.client.get(f"/hr/employees/e-{BEMP}/documents").status_code, 404)
        self.assertEqual(self.client.get(f"/hr/employees/e-{AEMP}/documents").status_code, 200)
        self._as(SUPER)
        self.assertEqual(self.client.get(f"/hr/employees/e-{BEMP}/documents").status_code, 200)

    def test_level_4_gets_404_on_company_b_ticket_walls_off(self):
        db = self._db()
        try:
            db.add(models.TaskTicket(id="tkt-tiers-a", code="tkt-tiers-a", subject="A", company_id=COA,
                                     requester_email=AEMP, status="new"))
            db.add(models.TaskTicket(id="tkt-tiers-b", code="tkt-tiers-b", subject="B", company_id=COB,
                                     requester_email=BEMP, status="new"))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN_A)
        self.assertEqual(self.client.get("/task-tickets/tkt-tiers-b/comments").status_code, 404)
        self.assertEqual(self.client.get("/task-tickets/tkt-tiers-a/comments").status_code, 200)
        self._as(SUPER)
        self.assertEqual(self.client.get("/task-tickets/tkt-tiers-b/comments").status_code, 200)

    def test_level_4_gets_404_on_company_b_announcement_walls_off(self):
        db = self._db()
        try:
            db.add(models.Announcement(id="ann-tiers-a", title="A", body="a", author_email=AEMP,
                                       created_at="2026-11-01T00:00:00+00:00"))
            db.add(models.Announcement(id="ann-tiers-b", title="B", body="b", author_email=BEMP,
                                       created_at="2026-11-01T00:00:00+00:00"))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN_A)
        self.assertEqual(self.client.get("/announcements/ann-tiers-b/reads").status_code, 404)
        self.assertEqual(self.client.get("/announcements/ann-tiers-a/reads").status_code, 200)
        self._as(SUPER)
        self.assertEqual(self.client.get("/announcements/ann-tiers-b/reads").status_code, 200)

    def test_level_4_gets_404_on_company_b_setting_walls_off(self):
        self._as(ADMIN_A)
        self.assertEqual(self.client.get(f"{SETTINGS}?company={COB}").status_code, 404)
        self.assertEqual(self.client.get(f"{SETTINGS}?company={COA}").status_code, 200)
        self._as(SUPER)
        self.assertEqual(self.client.get(f"{SETTINGS}?company={COB}").status_code, 200)


class PrivilegeTests(_Base):
    """Review Focus 2: what a level-4 caller may not do, and a level-5 may."""

    def _group_body(self, **extra):
        return {"name": "New Group", "allowed_modules": [], "member_emails": [], **extra}

    def test_level_4_cannot_create_a_flagged_group(self):
        self._as(ADMIN_A)
        r = self.client.post("/groups", json=self._group_body(is_global_admin=True))
        self.assertIn(r.status_code, (401, 403), r.text)
        ok = self.client.post("/groups", json=self._group_body(company_id=COA))
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertFalse(ok.json()["is_global_admin"])
        self._as(SUPER)
        time.sleep(0.02)   # group ids are stamped from the clock (GRP<timestamp>)
        r = self.client.post("/groups", json=self._group_body(name="Supers", is_global_admin=True))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["is_global_admin"])

    def test_level_4_cannot_edit_or_flag_a_group(self):
        self._as(ADMIN_A)
        # Flagging a plain group is refused, and the group stays plain.
        r = self.client.put(f"/groups/{PLAIN}", json={"is_global_admin": True})
        self.assertIn(r.status_code, (401, 403), r.text)
        db = self._db()
        try:
            self.assertFalse(db.get(models.NexusGroup, PLAIN).is_global_admin)
        finally:
            db.close()
        # Editing a flagged group at all is refused (its name, its members).
        r = self.client.put(f"/groups/{GA_GROUP}", json={"name": "Renamed"})
        self.assertIn(r.status_code, (401, 403), r.text)
        r = self.client.post(f"/groups/{GA_GROUP}/members", json={"emails": [ADMIN_A]})
        self.assertIn(r.status_code, (401, 403), r.text)
        r = self.client.delete(f"/groups/{GA_GROUP}/members/{SUPER}")
        self.assertIn(r.status_code, (401, 403), r.text)
        r = self.client.delete(f"/groups/{GA_GROUP}")
        self.assertIn(r.status_code, (401, 403), r.text)
        db = self._db()
        try:
            members = {m.email for m in db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GA_GROUP)}
            self.assertEqual(members, {SUPER})
            self.assertEqual(db.get(models.NexusGroup, GA_GROUP).name, "Global Admins")
        finally:
            db.close()
        # A plain group is still theirs to edit, with is_global_admin=false in the body as the UI sends it.
        r = self.client.put(f"/groups/{PLAIN}", json={"name": "Plain Renamed", "is_global_admin": False})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post(f"/groups/{PLAIN}/members", json={"emails": [AEMP]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(AEMP, r.json()["members"])
        # Level 5 may do all of it.
        self._as(SUPER)
        r = self.client.post(f"/groups/{GA_GROUP}/members", json={"emails": [ADMIN_A]})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.put(f"/groups/{GA_GROUP}", json={"name": "Super Administrators"})
        self.assertEqual(r.status_code, 200, r.text)

    def test_level_4_cannot_change_the_walls_switch(self):
        self._as(ADMIN_A)
        r = self.client.put("/access-scopes/config/walls", json={"on": True})
        self.assertIn(r.status_code, (401, 403), r.text)
        db = self._db()
        try:
            self.assertFalse(auth._company_walls_on(db))
        finally:
            db.close()
        self._as(SUPER)
        r = self.client.put("/access-scopes/config/walls", json={"on": True})
        self.assertEqual(r.status_code, 200, r.text)
        self._flush()
        db = self._db()
        try:
            self.assertTrue(auth._company_walls_on(db))
        finally:
            db.close()

    def test_level_4_cannot_grant_administrator_or_owner(self):
        self._as(ADMIN_A)
        for tier in ("administrator", "owner"):
            r = self.client.put(f"/roles/{AEMP}", json={"role": tier, "assigned_by": ADMIN_A})
            self.assertEqual(r.status_code, 403, (tier, r.text))
        ok = self.client.put(f"/roles/{AEMP}", json={"role": "manager", "assigned_by": ADMIN_A})
        self.assertEqual(ok.status_code, 200, ok.text)
        # ...nor touch an existing administrator.
        r = self.client.put(f"/roles/{ADMIN_NOCO}", json={"role": "employee", "assigned_by": ADMIN_A})
        self.assertEqual(r.status_code, 403, r.text)
        # Bulk through a group, same rule.
        r = self.client.post(f"/groups/{PLAIN}/assign-role", json={"role": "administrator", "assigned_by": ADMIN_A})
        self.assertEqual(r.status_code, 403, r.text)
        self._as(SUPER)
        r = self.client.put(f"/roles/{AEMP}", json={"role": "administrator", "assigned_by": SUPER})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.put(f"/roles/{ADMIN_NOCO}", json={"role": "owner", "assigned_by": SUPER})
        self.assertEqual(r.status_code, 200, r.text)

    def test_level_4_cannot_create_or_assign_an_administrator_job_role(self):
        self._as(ADMIN_A)
        for tier in ("administrator", "owner"):
            r = self.client.post("/jobroles", json={"name": f"Top {tier}", "tier": tier})
            self.assertEqual(r.status_code, 403, (tier, r.text))
        self._as(SUPER)
        made = self.client.post("/jobroles", json={"name": "Company Administrator", "tier": "administrator"})
        self.assertEqual(made.status_code, 200, made.text)
        jr_id = made.json()["id"]
        self._as(ADMIN_A)
        r = self.client.post(f"/jobroles/{jr_id}/assign", json={"email": AEMP, "reason": "x"})
        self.assertEqual(r.status_code, 403, r.text)
        self._as(SUPER)
        r = self.client.post(f"/jobroles/{jr_id}/assign", json={"email": AEMP, "reason": "x"})
        self.assertEqual(r.status_code, 200, r.text)
        db = self._db()
        try:
            self.assertEqual(db.get(models.NexusRole, AEMP).role, "administrator")
        finally:
            db.close()


class SeedTests(_Base):
    """Review Focus 3: the Super Administrator set pass runs once."""

    def _roles(self):
        db = self._db()
        try:
            return {r.email: (r.role, bool(r.tier_pinned)) for r in db.query(models.NexusRole).all()}
        finally:
            db.close()

    def test_seed_sets_the_five_and_demotes_other_owners_once(self):
        db = self._db()
        try:
            db.query(models.NexusRole).delete()
            db.add(models.NexusRole(email="neil@greensglobal.com", role="administrator"))
            db.add(models.NexusRole(email="charmi@greensglobal.com", role="manager"))
            db.add(models.NexusRole(email="sagar.shoundik@greensglobal.com", role="owner"))
            db.add(models.NexusRole(email="viral@greensglobal.com", role="owner"))     # another owner -> administrator
            db.add(models.NexusRole(email=AEMP, role="employee"))
            # No role row: the seed makes one only for someone with a People record.
            for em in ("visesh.lodha@greensglobal.com", "pranshu.pandey@greensglobal.com"):
                db.add(models.NexusEmployee(id=f"e-{em}", first_name="Seed", work_email=em, status="active"))
            db.commit()
        finally:
            db.close()
        db = self._db()
        try:
            first = super_admins_seed.apply_once(db)
            self.assertTrue(first)
            self.assertIsNotNone(db.get(models.NexusSetting, super_admins_seed.MARK))
        finally:
            db.close()
        roles = self._roles()
        for em in super_admins_seed.SUPER_ADMINS:
            self.assertEqual(roles.get(em), ("owner", True), em)
        self.assertEqual(len(super_admins_seed.SUPER_ADMINS), 5)
        self.assertEqual(roles["viral@greensglobal.com"][0], "administrator")
        self.assertEqual(roles[AEMP][0], "employee")
        # A Super Administrator later demoted by a Super Administrator stays demoted.
        db = self._db()
        try:
            row = db.get(models.NexusRole, "neil@greensglobal.com")
            row.role = "manager"
            db.add(models.NexusRole(email="late@greensglobal.com", role="owner"))
            db.commit()
        finally:
            db.close()
        db = self._db()
        try:
            self.assertFalse(super_admins_seed.apply_once(db))
        finally:
            db.close()
        roles = self._roles()
        self.assertEqual(roles["neil@greensglobal.com"][0], "manager")
        self.assertEqual(roles["late@greensglobal.com"][0], "owner")

    def test_seed_invalidates_the_role_cache(self):
        db = self._db()
        try:
            self.assertEqual(auth._role_for("sagar.shoundik@greensglobal.com", db), ("employee", 1))
            db.add(models.NexusEmployee(id="e-sagar", first_name="Sagar", work_email="sagar.shoundik@greensglobal.com",
                                        status="active"))
            db.commit()
            super_admins_seed.apply_once(db)
            self.assertEqual(auth._role_for("sagar.shoundik@greensglobal.com", db), ("owner", 5))
        finally:
            db.close()


class RolesMeTests(_Base):
    def test_me_carries_level_and_title(self):
        self._as(ADMIN_A)
        me = self.client.get("/roles/me").json()
        self.assertEqual((me["role"], me["level"], me["title"]), ("administrator", 4, "IT Lead"))
        self._as(AEMP)
        me = self.client.get("/roles/me").json()
        self.assertEqual((me["role"], me["level"], me["title"]), ("employee", 1, ""))
        self._as(SUPER)
        me = self.client.get("/roles/me").json()
        self.assertEqual(me["level"], 5)


if __name__ == "__main__":
    unittest.main()
