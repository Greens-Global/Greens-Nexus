"""Tiers, security pass A (Neil, 11/02/2026): the ways an Administrator
(level 4) could still step past their company walls, closed one by one.
Every case runs with the `company_walls` switch ON - an Administrator is
walled only once it is armed (11/11/2026; WallsOffTests pins what still
binds them with it off) - and pits a company A Administrator against
company B's people and records; a Super Administrator (level 5) still
reaches everything.

    python -m pytest test_roles_walls_escapes.py
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

models.Base.metadata.create_all(bind=database.engine)

COA, COB = "ent-esc-a", "ent-esc-b"
SUPER = "esc.super@greensglobal.com"      # owner (level 5), company A
ADMIN_A = "esc.admina@greensglobal.com"   # administrator (level 4), company A
ADMIN_B = "esc.adminb@greensglobal.com"   # administrator (level 4), company B
AMGR = "esc.amgr@greensglobal.com"        # manager, company A
AEMP = "esc.aemp@greensglobal.com"        # employee, company A
BEMP = "esc.bemp@greensglobal.com"        # employee, company B
GUEST = "esc.guest@partner.example"       # a guest: no company
PLAIN = "grp-esc-plain"                   # a shared (company '') group
GRP_A = "grp-esc-a"                       # company A's group
GRP_B = "grp-esc-b"                       # company B's group

PEOPLE = {SUPER: (COA, "owner"), ADMIN_A: (COA, "administrator"), ADMIN_B: (COB, "administrator"),
          AMGR: (COA, "manager"), AEMP: (COA, "employee"), BEMP: (COB, "employee"),
          GUEST: ("", "employee")}

TABLES = ("NexusRole", "NexusEmployee", "NexusGroup", "NexusGroupMember", "HrEntity", "NexusSetting",
          "NexusAccessScope", "AuditLog", "AuditChange", "TaskProject", "JobRole", "ActAsSession",
          "TaskNotification", "NexusNotification", "Task", "TaskTeam", "TaskTicket")


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        db = database.SessionLocal()
        try:
            for name in TABLES:
                m = getattr(models, name, None)
                if m is not None:
                    db.query(m).execution_options(include_deleted=True, include_confidential=True).delete(synchronize_session=False)
            db.add(models.HrEntity(id=COA, name="Alpha Co"))
            db.add(models.HrEntity(id=COB, name="Beta Co"))
            for em, (co, role) in PEOPLE.items():
                db.add(models.NexusEmployee(id=f"e-{em}", first_name=em.split(".")[1].split("@")[0].title(),
                                            last_name="Esc", work_email=em, status="active", deleted_at="",
                                            company=co, identity_type="guest" if em == GUEST else "internal",
                                            # A manager acts only within their reporting line (11/12/2026).
                                            manager_email=AMGR if em == AEMP else ""))
                db.add(models.NexusRole(email=em, role=role))
            db.add(models.NexusGroup(id=PLAIN, name="Shared Group", allowed_modules="tasks:viewer", company_id=""))
            db.add(models.NexusGroup(id=GRP_A, name="Alpha Group", allowed_modules="tasks:viewer", company_id=COA))
            db.add(models.NexusGroup(id=GRP_B, name="Beta Group", allowed_modules="tasks:viewer", company_id=COB))
            db.add(models.NexusGroupMember(group_id=GRP_B, email=BEMP))
            db.add(models.NexusSetting(key="company_walls", value="on"))
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
        self._flush()

    def _db(self):
        return database.SessionLocal()

    def _walls_off(self):
        # Historical name: the suite now runs ARMED (see the module docstring).
        db = self._db()
        try:
            self.assertTrue(auth._company_walls_on(db))
        finally:
            db.close()


class AccessScopeTests(_Base):
    """Item 1: scope rows from a walled caller."""

    def _add(self, email, **body):
        return self.client.post(f"/access-scopes/{email}", json={"module_id": "property-asset",
                                                                  "scope_type": "property",
                                                                  "scope_id": "prop-1", **body})

    def _scopes(self, email):
        db = self._db()
        try:
            return [(s.module_id, s.scope_type, s.scope_id)
                    for s in db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email == email)]
        finally:
            db.close()

    def test_entity_rows_are_super_only(self):
        self._walls_off()
        self._as(ADMIN_A)
        # The escape: an Administrator limiting THEMSELF to company B widened their walls.
        r = self._add(ADMIN_A, module_id="company", scope_type="entity", scope_id=COB)
        self.assertIn(r.status_code, (403, 404), r.text)
        r = self._add(AEMP, module_id="hr", scope_type="entity", scope_id=COA)
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self._scopes(ADMIN_A) + self._scopes(AEMP), [])
        db = self._db()
        try:
            self.assertEqual(auth.company_scope({"email": ADMIN_A, "level": 4}, db), {COA})
        finally:
            db.close()
        self._as(SUPER)
        r = self._add(AEMP, module_id="hr", scope_type="entity", scope_id=COA)
        self.assertEqual(r.status_code, 201, r.text)

    def test_target_must_be_inside_the_callers_companies(self):
        self._as(ADMIN_A)
        self.assertEqual(self._add(BEMP).status_code, 404)
        self.assertEqual(self.client.get(f"/access-scopes/{BEMP}").status_code, 404)
        self.assertEqual(self._add(ADMIN_A).status_code, 403, "never the caller themself")
        self.assertEqual(self._add(SUPER).status_code, 403, "never a Super Administrator")
        self.assertEqual(self._add(AEMP).status_code, 201)
        self.assertEqual(self._add(GUEST).status_code, 201, "a guest has no company - shared")
        self.assertEqual(self.client.get(f"/access-scopes/{AEMP}").status_code, 200)
        self._as(SUPER)
        self.assertEqual(self._add(BEMP).status_code, 201)

    def test_scope_id_must_be_inside_the_callers_companies(self):
        self._as(ADMIN_A)
        # A company-B id on the hr module (read by hr_scope as a company) is refused.
        r = self._add(AEMP, module_id="hr", scope_type="property", scope_id=COB)
        self.assertEqual(r.status_code, 404, r.text)
        r = self._add(AEMP, module_id="tasks", scope_type="project", scope_id="proj-b")
        self.assertEqual(r.status_code, 404, r.text)
        db = self._db()
        try:
            db.add(models.TaskProject(id="proj-a", name="A", company_id=COA))
            db.add(models.TaskProject(id="proj-b", name="B", company_id=COB))
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._add(AEMP, module_id="tasks", scope_type="project", scope_id="proj-b").status_code, 404)
        self.assertEqual(self._add(AEMP, module_id="tasks", scope_type="project", scope_id="proj-a").status_code, 201)

    def test_removing_an_entity_row_is_super_only(self):
        db = self._db()
        try:
            db.add(models.NexusAccessScope(id="sc-esc-1", email=AEMP, module_id="hr", scope_type="entity", scope_id=COA))
            db.add(models.NexusAccessScope(id="sc-esc-2", email=BEMP, module_id="property-asset",
                                           scope_type="property", scope_id="p"))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN_A)
        self.assertEqual(self.client.delete(f"/access-scopes/{AEMP}/sc-esc-1").status_code, 403)
        self.assertEqual(self.client.delete(f"/access-scopes/{BEMP}/sc-esc-2").status_code, 404)
        self.assertEqual(len(self._scopes(AEMP)) + len(self._scopes(BEMP)), 2)
        self._as(SUPER)
        self.assertEqual(self.client.delete(f"/access-scopes/{AEMP}/sc-esc-1").status_code, 200)


class GroupTests(_Base):
    """Item 2: groups stay inside the caller's companies; Super-only grants."""

    def _body(self, **extra):
        return {"name": "New Group", "allowed_modules": [], "member_emails": [], **extra}

    def _members(self, gid):
        db = self._db()
        try:
            return {m.email for m in db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == gid)}
        finally:
            db.close()

    def test_create_needs_a_company_of_theirs(self):
        self._walls_off()
        self._as(ADMIN_A)
        self.assertEqual(self.client.post("/groups", json=self._body()).status_code, 403, "shared = Super only")
        self.assertEqual(self.client.post("/groups", json=self._body(company_id=COB)).status_code, 403)
        r = self.client.post("/groups", json=self._body(company_id=COA, member_emails=[BEMP]))
        self.assertEqual(r.status_code, 404, "a company B member is refused")
        r = self.client.post("/groups", json=self._body(company_id=COA, member_emails=[AEMP, GUEST]))
        self.assertEqual(r.status_code, 200, r.text)
        self._as(SUPER)
        time.sleep(0.02)   # group ids are stamped from the clock
        self.assertEqual(self.client.post("/groups", json=self._body(name="Shared")).status_code, 200)

    def test_company_b_and_shared_groups_are_out_of_reach(self):
        self._as(ADMIN_A)
        self.assertEqual(self.client.put(f"/groups/{GRP_B}", json={"name": "Mine"}).status_code, 404)
        self.assertEqual(self.client.post(f"/groups/{GRP_B}/members", json={"emails": [ADMIN_A]}).status_code, 404)
        self.assertEqual(self.client.delete(f"/groups/{GRP_B}/members/{BEMP}").status_code, 404)
        self.assertEqual(self.client.delete(f"/groups/{GRP_B}").status_code, 404)
        # Joining company B's group would have widened their walls to company B.
        self.assertEqual(self._members(GRP_B), {BEMP})
        self.assertEqual(self.client.post(f"/groups/{PLAIN}/members", json={"emails": [AEMP]}).status_code, 403)
        self.assertEqual(self.client.put(f"/groups/{PLAIN}", json={"name": "Mine"}).status_code, 403)
        self.assertEqual(self.client.put(f"/groups/{GRP_A}", json={"company_id": COB}).status_code, 403)
        self.assertEqual(self.client.post(f"/groups/{GRP_A}/members", json={"emails": [BEMP]}).status_code, 404)
        self.assertEqual(self.client.post(f"/groups/{GRP_A}/members", json={"emails": [AEMP]}).status_code, 200)
        db = self._db()
        try:
            self.assertEqual(auth.company_scope({"email": ADMIN_A, "level": 4}, db), {COA})
        finally:
            db.close()
        self._as(SUPER)
        self.assertEqual(self.client.post(f"/groups/{GRP_B}/members", json={"emails": [AEMP]}).status_code, 200)

    def test_list_shows_their_companies_groups_and_members_only(self):
        db = self._db()
        try:
            db.add(models.NexusGroupMember(group_id=PLAIN, email=AEMP))
            db.add(models.NexusGroupMember(group_id=PLAIN, email=BEMP))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN_A)
        rows = {g["id"]: g for g in self.client.get("/groups").json()}
        self.assertNotIn(GRP_B, rows)
        self.assertIn(GRP_A, rows)
        self.assertEqual(set(rows[PLAIN]["members"]), {AEMP})
        self._as(SUPER)
        rows = {g["id"]: g for g in self.client.get("/groups").json()}
        self.assertIn(GRP_B, rows)
        self.assertEqual(set(rows[PLAIN]["members"]), {AEMP, BEMP})

    def test_owner_bypass_grants_are_super_only(self):
        self.assertIn("pfs", auth.OWNER_ONLY_GRANTS)
        self.assertIn("hr_comp", auth.OWNER_ONLY_GRANTS)
        self._as(ADMIN_A)
        r = self.client.post("/groups", json=self._body(company_id=COA, allowed_modules=[{"id": "pfs", "level": "viewer"}]))
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.put(f"/groups/{GRP_A}", json={"allowed_modules": [{"id": "pfs", "level": "viewer"}]})
        self.assertEqual(r.status_code, 403, r.text)
        # Owner grant level retired (11/12/2026): deleting a person is Super by TIER, no grant
        # opens it, so hr is an Administrator's to give; a legacy owner is stored as full.
        self.assertNotIn("hr", auth.OWNER_ONLY_GRANTS)
        self.assertNotIn("workflows", auth.OWNER_ONLY_GRANTS)
        r = self.client.put(f"/groups/{GRP_A}", json={"allowed_modules": [{"id": "hr", "level": "owner"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["allowed_modules"], [{"id": "hr", "level": "full"}])
        r = self.client.put(f"/groups/{GRP_A}", json={"allowed_modules": [{"id": "hr", "level": "full"}]})
        self.assertEqual(r.status_code, 200, r.text)
        # A Super Administrator gives company A's group PFS; the Administrator
        # cannot put anyone (themself included) in it, but can still rename it.
        self._as(SUPER)
        r = self.client.put(f"/groups/{GRP_A}", json={"allowed_modules": [{"id": "pfs", "level": "viewer"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(ADMIN_A)
        self.assertEqual(self.client.post(f"/groups/{GRP_A}/members", json={"emails": [ADMIN_A]}).status_code, 403)
        r = self.client.put(f"/groups/{GRP_A}", json={"name": "Alpha Renamed",
                                                    "allowed_modules": [{"id": "pfs", "level": "viewer"}]})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.put(f"/groups/{GRP_A}", json={"allowed_modules": [{"id": "pfs", "level": "editor"}]})
        self.assertEqual(r.status_code, 403, "raising it is a new grant")
        db = self._db()
        try:
            self.assertEqual(auth._module_level(ADMIN_A, "pfs", db), 0)
        finally:
            db.close()


class JobRoleTests(_Base):
    """Items 2 and 5: job roles - the tier and company guards on edit and
    delete, Super-only grants, assignment inside the wall."""

    def _role(self, rid, company, tier="employee", modules=""):
        db = self._db()
        try:
            db.add(models.NexusGroup(id=rid, name=f"Role {rid}", is_job_role=1, tier=tier,
                                     company_id=company, allowed_modules=modules))
            db.commit()
        finally:
            db.close()

    def test_edit_and_delete_guard_tier_and_company(self):
        self._role("JResc-a", COA)
        self._role("JResc-b", COB)
        self._role("JResc-shared", "")
        self._role("JResc-admin", COA, tier="administrator")
        self._walls_off()
        self._as(ADMIN_A)
        self.assertEqual(self.client.put("/jobroles/JResc-b", json={"description": "x"}).status_code, 404)
        self.assertEqual(self.client.delete("/jobroles/JResc-b").status_code, 404)
        self.assertEqual(self.client.put("/jobroles/JResc-shared", json={"description": "x"}).status_code, 403)
        self.assertEqual(self.client.delete("/jobroles/JResc-shared").status_code, 403)
        # A company A role at the Administrator tier: not theirs to change (its holders' tier).
        self.assertEqual(self.client.put("/jobroles/JResc-admin", json={"tier": "employee"}).status_code, 403)
        self.assertEqual(self.client.delete("/jobroles/JResc-admin").status_code, 403)
        self.assertEqual(self.client.put("/jobroles/JResc-a", json={"description": "x"}).status_code, 200)
        self.assertEqual(self.client.post("/jobroles", json={"name": "Shared New"}).status_code, 403)
        listed = {r["id"] for r in self.client.get("/jobroles").json()}
        self.assertNotIn("JResc-b", listed)
        self.assertTrue({"JResc-a", "JResc-shared"} <= listed)
        self._as(SUPER)
        self.assertEqual(self.client.put("/jobroles/JResc-shared", json={"description": "x"}).status_code, 200)
        self.assertEqual(self.client.delete("/jobroles/JResc-b").status_code, 200)

    def test_owner_bypass_grants_on_job_roles_are_super_only(self):
        self._role("JResc-a", COA)
        self._as(ADMIN_A)
        r = self.client.post("/jobroles", json={"name": "Wealth", "company_id": COA,
                                                "allowed_modules": [{"id": "pfs", "level": "viewer"}]})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.put("/jobroles/JResc-a", json={"allowed_modules": [{"id": "hr_comp", "level": "viewer"}]})
        self.assertEqual(r.status_code, 403, r.text)
        self._as(SUPER)
        r = self.client.put("/jobroles/JResc-a", json={"allowed_modules": [{"id": "pfs", "level": "viewer"}]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_assignment_stays_inside_the_wall(self):
        self._role("JResc-shared", "")
        self._role("JResc-b", COB)
        self._as(ADMIN_A)
        r = self.client.post("/jobroles/JResc-shared/assign", json={"email": BEMP, "reason": "x"})
        self.assertEqual(r.status_code, 404, r.text)
        r = self.client.post("/jobroles/JResc-b/assign", json={"email": AEMP, "reason": "x"})
        self.assertEqual(r.status_code, 404, r.text)
        self.assertEqual(self.client.get(f"/jobroles/effective/{BEMP}").status_code, 404)
        r = self.client.post("/jobroles/JResc-shared/assign", json={"email": AEMP, "reason": "x"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.get(f"/jobroles/effective/{AEMP}").status_code, 200)


class ActAsTests(_Base):
    """Item 3: Act As stays inside the real actor's companies."""

    def test_targets_and_start_are_walled(self):
        self._walls_off()
        self._as(ADMIN_A)
        listed = {r["email"] for r in self.client.get("/act-as/eligible-targets").json()}
        self.assertIn(AEMP, listed)
        self.assertIn(AMGR, listed)
        self.assertIn(GUEST, listed, "a guest has no company - shared")
        self.assertNotIn(BEMP, listed)
        self.assertEqual(self.client.post("/act-as/start", json={"target_email": BEMP}).status_code, 404)
        self._as(SUPER)
        listed = {r["email"] for r in self.client.get("/act-as/eligible-targets").json()}
        self.assertIn(BEMP, listed)
        self.assertEqual(self.client.post("/act-as/start", json={"target_email": BEMP}).status_code, 200)

    def test_the_acting_identity_is_capped_at_the_real_actors_companies(self):
        self._walls_off()
        self._as(ADMIN_A)
        r = self.client.post("/act-as/start", json={"target_email": AMGR})
        self.assertEqual(r.status_code, 200, r.text)
        sid = r.json()["session_id"]
        import act_as
        db = self._db()
        try:
            target = act_as.resolve_target(sid, ADMIN_A, db)
            self.assertEqual((target["email"], target["level"], target["real_level"]), (AMGR, 3, 4))
            # Acting for company A's Administrator they reach only company A.
            self.assertEqual(auth.company_scope(target, db), {COA})
            self.assertFalse(auth.company_ok(COB, auth.company_scope(target, db)))
        finally:
            db.close()
        # Through a real request too: acting as the manager, company B's
        # people stay out of the manager's own (walls-off) lists.
        ppl = self.client.get("/act-as/eligible-targets", headers={"X-Act-As-Session": sid})
        self.assertEqual(ppl.status_code, 200, ppl.text)
        emails = {r["email"] for r in ppl.json()}
        self.assertIn(AEMP, emails)
        self.assertNotIn(BEMP, emails)
        # A Super Administrator acting caps nothing: the manager's own walls.
        self._as(SUPER)
        sid2 = self.client.post("/act-as/start", json={"target_email": AMGR}).json()["session_id"]
        db = self._db()
        try:
            self.assertEqual(auth.company_scope(act_as.resolve_target(sid2, SUPER, db), db), {COA})
        finally:
            db.close()


class LevelFourShortcutTests(_Base):
    """Item 4: the remaining level >= 4 cross-company shortcuts."""

    def test_timeclock_visible_emails(self):
        from routers import timeclock
        db = self._db()
        try:
            seen = timeclock._visible_emails(db, {"email": ADMIN_A, "level": 4, "role": "administrator"})
            self.assertIsNotNone(seen)
            self.assertIn(AEMP, seen)
            self.assertNotIn(BEMP, seen)
            self.assertIsNone(timeclock._visible_emails(db, {"email": SUPER, "level": 5, "role": "owner"}))
        finally:
            db.close()

    def test_timesheet_is_hr(self):
        import timesheet_review
        db = self._db()
        try:
            self.assertTrue(timesheet_review.is_hr(db, ADMIN_A, AEMP))
            self.assertFalse(timesheet_review.is_hr(db, ADMIN_A, BEMP))
            self.assertTrue(timesheet_review.is_hr(db, SUPER, BEMP))
        finally:
            db.close()

    def test_roles_list_and_assign(self):
        self._as(ADMIN_A)
        listed = {r["email"] for r in self.client.get("/roles").json()}
        self.assertIn(AEMP, listed)
        self.assertNotIn(BEMP, listed)
        self.assertNotIn(ADMIN_B, listed)
        r = self.client.put(f"/roles/{BEMP}", json={"role": "manager", "assigned_by": ADMIN_A})
        self.assertEqual(r.status_code, 404, r.text)
        r = self.client.put(f"/roles/{AEMP}", json={"role": "manager", "assigned_by": ADMIN_A})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(SUPER)
        self.assertIn(BEMP, {r["email"] for r in self.client.get("/roles").json()})
        self.assertEqual(self.client.put(f"/roles/{BEMP}", json={"role": "manager", "assigned_by": SUPER}).status_code, 200)

    def test_reimbursements_for_a_company_b_person(self):
        self._as(ADMIN_A)
        self.assertEqual(self.client.get(f"/reimbursements/person/{BEMP}").status_code, 404)
        self.assertEqual(self.client.get(f"/reimbursements/person/{AEMP}").status_code, 200)
        self._as(SUPER)
        self.assertEqual(self.client.get(f"/reimbursements/person/{BEMP}").status_code, 200)

    def test_accounting_entities_are_not_all(self):
        from routers import accounting
        db = self._db()
        try:
            self.assertEqual(accounting.allowed_entities({"email": ADMIN_A, "level": 4}, db), set())
            self.assertIsNone(accounting.allowed_entities({"email": SUPER, "level": 5}, db))
            db.add(models.NexusAccessScope(id="sc-esc-acct", email=ADMIN_A, module_id="accounting",
                                           scope_type="ledger", scope_id="15000"))
            db.commit()
            self.assertEqual(accounting.allowed_entities({"email": ADMIN_A, "level": 4}, db), {"15000"})
        finally:
            db.close()


class JobTitleStampTests(_Base):
    """apply_job_role stamps the role's name as the job title only for a job
    (tiers up to Manager), never for an access role at the Administrator or
    Super Administrator tier."""

    def _title(self, email):
        db = self._db()
        try:
            return db.get(models.NexusEmployee, f"e-{email}").job_title
        finally:
            db.close()

    def test_owner_tier_keeps_the_title_manager_tier_stamps_it(self):
        from routers import jobroles
        db = self._db()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == f"e-{AEMP}").update({"job_title": "Site Lead"})
            db.add(models.NexusGroup(id="JResc-super", name="Super Administrators", is_job_role=1, tier="owner"))
            db.add(models.NexusGroup(id="JResc-admin2", name="Administrators", is_job_role=1, tier="administrator"))
            db.add(models.NexusGroup(id="JResc-mgr", name="Ops Manager", is_job_role=1, tier="manager", company_id=COA))
            db.commit()
            for rid in ("JResc-super", "JResc-admin2"):
                jobroles.apply_job_role(db, db.get(models.NexusGroup, rid), AEMP, SUPER)
                db.commit()
                self.assertEqual(self._title(AEMP), "Site Lead", rid)
            jobroles.apply_job_role(db, db.get(models.NexusGroup, "JResc-mgr"), AEMP, SUPER)
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._title(AEMP), "Ops Manager")


class LevelFourShortcutTestsMore(_Base):
    """Item 4, continued: scorecard, audit feed, policy report, externals,
    the desk supervisor, the "admins" bell fan-out."""

    def test_scorecard_scope_is_their_company(self):
        import workforce_scorecard as sc
        db = self._db()
        try:
            emails, kind = sc.scope_for(db, {"email": ADMIN_A, "level": 4})
            self.assertEqual(kind, "company")
            self.assertIn(AEMP, emails)
            self.assertNotIn(BEMP, emails)
            self.assertEqual(sc.scope_for(db, {"email": SUPER, "level": 5}), (None, "all"))
        finally:
            db.close()

    def test_audit_feed_shows_only_their_companies_people(self):
        db = self._db()
        try:
            for i, who in enumerate((AEMP, BEMP)):
                db.add(models.AuditLog(timestamp=f"2026-11-01T10:00:0{i}", user_email=who, action=f"Updated by {who}",
                                       resource_type="task-tickets", resource_id=f"r-{i}", module="tickets",
                                       request_id=f"rq-esc-{i}"))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN_A)
        text = self.client.get("/audit/events?from=2026-10-01").text
        self.assertIn(f"Updated by {AEMP}", text)
        self.assertNotIn(f"Updated by {BEMP}", text)
        csv_text = self.client.get("/audit/export.csv?from=2026-10-01").text
        self.assertIn(AEMP, csv_text)
        self.assertNotIn(BEMP, csv_text)
        facets = self.client.get("/audit/facets?from=2026-10-01").json()
        self.assertNotIn(BEMP, {a["email"] for a in facets["actors"]})
        self._as(SUPER)
        self.assertIn(f"Updated by {BEMP}", self.client.get("/audit/events?from=2026-10-01").text)

    def test_policy_report_is_their_company(self):
        self._as(ADMIN_A)
        rep = self.client.get("/policy/report").json()
        people = {p["email"] for p in rep["pending"]} | {p["email"] for p in rep["acceptedPeople"]}
        self.assertIn(AEMP, people)
        self.assertNotIn(BEMP, people)
        self.assertNotIn(BEMP, self.client.get("/policy/report.csv").text)
        self._as(SUPER)
        self.assertIn(BEMP, {p["email"] for p in self.client.get("/policy/report").json()["pending"]})

    def test_externals_of_another_company_are_out_of_reach(self):
        db = self._db()
        try:
            db.add(models.NexusEmployee(id="e-ext-b", first_name="Bo", last_name="Ext", work_email="bo@partner.example",
                                        status="active", deleted_at="", company=COB, identity_type="guest"))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN_A)
        listed = {r["email"] for r in self.client.get("/external-users").json()}
        self.assertIn(GUEST, listed, "a guest with no company is shared")
        self.assertNotIn("bo@partner.example", listed)
        r = self.client.post("/external-users/bo@partner.example/invite")
        self.assertEqual(r.status_code, 404, r.text)
        self._as(SUPER)
        self.assertIn("bo@partner.example", {r["email"] for r in self.client.get("/external-users").json()})

    def test_desk_supervisor_in_every_company(self):
        import ticket_roles
        db = self._db()
        try:
            admin = {"email": ADMIN_A, "level": 4}
            self.assertEqual(ticket_roles.ticket_role(admin, db, company=COA), ticket_roles.SUPERVISOR)
            self.assertEqual(ticket_roles.ticket_role(admin, db, company=COB), ticket_roles.SUPERVISOR)  # hotfix 11/04/2026: an Administrator sees every company's tickets
            self.assertTrue(ticket_roles.can_delete(admin, db, company=COB))
            self.assertTrue(ticket_roles.can_delete(admin, db, company=COA))
            self.assertEqual(ticket_roles.ticket_role({"email": SUPER, "level": 5}, db, company=COB),
                             ticket_roles.SUPERVISOR)
        finally:
            db.close()

    def test_admins_fan_out_reaches_only_the_teams_company(self):
        from routers.task_util import task_notify
        db = self._db()
        try:
            db.add(models.TaskTeam(id="team-esc-b", name="Beta Team", company_id=COB, created_by=BEMP))
            db.add(models.TaskTeam(id="team-esc-a", name="Alpha Team", company_id=COA, created_by=AEMP))
            db.commit()
            task_notify(db, kind="member_request", for_email="admins", title="Team Member Request B",
                        department_id="team-esc-b", request_id="mr-b", main_bell=True)
            task_notify(db, kind="member_request", for_email="admins", title="Team Member Request A",
                        department_id="team-esc-a", request_id="mr-a", main_bell=True)
            db.commit()
            bells = {(n.recipient, n.title) for n in db.query(models.NexusNotification).all()}
        finally:
            db.close()
        self.assertIn((ADMIN_B, "Team Member Request B"), bells)
        self.assertIn((SUPER, "Team Member Request B"), bells)
        self.assertNotIn((ADMIN_A, "Team Member Request B"), bells)
        self.assertIn((ADMIN_A, "Team Member Request A"), bells)
        self._as(ADMIN_A)
        titles = {n["title"] for n in self.client.get("/task-notifications").json()}
        self.assertEqual(titles, {"Team Member Request A"})
        self._as(SUPER)
        titles = {n["title"] for n in self.client.get("/task-notifications").json()}
        self.assertEqual(titles, {"Team Member Request A", "Team Member Request B"})


class TierMarkTests(_Base):
    """Item 11: a guest or external never carries a tier mark."""

    def test_guest_with_a_manager_row_has_no_mark(self):
        db = self._db()
        try:
            db.query(models.NexusRole).filter(models.NexusRole.email == GUEST).update({"role": "manager"})
            db.commit()
            auth.invalidate_role_cache()
            self.assertEqual(auth.tier_for(GUEST, db), "")
            self.assertEqual(auth.tier_for(AMGR, db), "manager")
            tiers = auth.tiers_by_email(db)
            self.assertNotIn(GUEST, tiers)
            self.assertEqual((tiers.get(AMGR), tiers.get(ADMIN_A), tiers.get(SUPER)), ("manager", "admin", "super"))
        finally:
            db.close()


class SharedPeopleTests(_Base):
    """Item 7: people with no company stay in an Administrator's People and
    directory reads; another company's never do."""

    def test_people_list_and_directory_admit_people_with_no_company(self):
        db = self._db()
        try:
            db.add(models.NexusEmployee(id="e-esc-untagged", first_name="Una", last_name="Tagged",
                                        work_email="esc.untagged@greensglobal.com", status="active",
                                        deleted_at="", company=""))
            db.commit()
        finally:
            db.close()
        self._as(ADMIN_A)
        people = {e["workEmail"] for e in self.client.get("/hr/employees").json()}
        self.assertIn(AEMP, people)
        self.assertIn("esc.untagged@greensglobal.com", people)
        self.assertNotIn(BEMP, people)
        self.assertEqual(self.client.get("/hr/employees/e-esc-untagged/documents").status_code, 200)
        directory = {p["email"] for p in self.client.get("/myhr/directory?include_external=true").json()}
        self.assertTrue({AEMP, GUEST, "esc.untagged@greensglobal.com"} <= directory)
        self.assertNotIn(BEMP, directory)
        contacts = {p["email"] for p in self.client.get("/directory").json()["people"]}
        self.assertIn("esc.untagged@greensglobal.com", contacts)
        self.assertNotIn(BEMP, contacts)
        db = self._db()
        try:
            self.assertTrue(auth.admits_blank(auth.company_scope({"email": ADMIN_A, "level": 4}, db)))
            self.assertFalse(auth.admits_blank(auth.company_scope({"email": AEMP, "level": 1}, db)))
        finally:
            db.close()


class WallsOffTests(_Base):
    """Walls OFF (11/11/2026): an Administrator sees every company, but the
    Super-only rules on the walls themselves still bind them, so nothing set
    up now widens their reach once the walls are armed."""

    def setUp(self):
        super().setUp()
        db = self._db()
        try:
            db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete()
            db.commit()
        finally:
            db.close()
        self._flush()

    def test_an_administrator_sees_every_company(self):
        db = self._db()
        try:
            self.assertIsNone(auth.company_scope({"email": ADMIN_A, "level": 4}, db))
        finally:
            db.close()
        self._as(ADMIN_A)
        self.assertIn(BEMP, {r["email"] for r in self.client.get("/roles").json()})

    def test_the_walls_themselves_stay_super_only(self):
        self._as(ADMIN_A)
        post = lambda email, **b: self.client.post(f"/access-scopes/{email}", json={  # noqa: E731
            "module_id": "property-asset", "scope_type": "property", "scope_id": "prop-1", **b})
        self.assertEqual(post(ADMIN_A, module_id="company", scope_type="entity", scope_id=COB).status_code, 403)
        self.assertEqual(post(BEMP, module_id="hr", scope_type="entity", scope_id=COB).status_code, 403)
        self.assertEqual(post(ADMIN_A).status_code, 403)          # never their own limits
        self.assertEqual(post(ADMIN_B).status_code, 403)          # never another Administrator's
        self.assertEqual(post(BEMP).status_code, 201)             # a company B person: fine now
        self.assertEqual(self.client.post("/groups", json={"name": "Org Wide", "allowed_modules": [],
                                                           "company_id": ""}).status_code, 403)
        self.assertEqual(self.client.put(f"/groups/{PLAIN}", json={"name": "x"}).status_code, 403)
        self.assertEqual(self.client.put(f"/groups/{GRP_B}", json={"name": "Beta 2"}).status_code, 200)
        self.assertEqual(self.client.post("/jobroles", json={"name": "Shared New"}).status_code, 403)
        self._as(SUPER)
        self.assertEqual(post(BEMP, module_id="hr", scope_type="entity", scope_id=COB).status_code, 201)


if __name__ == "__main__":
    unittest.main()
