"""Multi-company walls (Aug 2026): the tenant-isolation matrix. Proves the
company wall is OFF by default (nothing changes for the single-org setup), and
once armed, a caller in company A sees only company-A people in the directory
every picker uses - while a Global Admin still sees across all companies.

    python -m unittest test_company_walls
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text
with database.engine.connect() as _c:
    for _sql in ("ALTER TABLE nexus_groups ADD COLUMN company_id TEXT DEFAULT ''",
                 "ALTER TABLE nexus_groups ADD COLUMN is_global_admin INTEGER DEFAULT 0",
                 "ALTER TABLE tasks ADD COLUMN company_id TEXT DEFAULT ''"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

COA, COB = "ent-walls-a", "ent-walls-b"
GLOBAL = "walls.global@greensglobal.com"   # Global Admin (level 4 bootstrap)
AEMP = "walls.aemp@greensglobal.com"       # company A employee
AMGR = "walls.amgr@greensglobal.com"       # company A, via a company-scoped role group
BEMP = "walls.bemp@greensglobal.com"       # company B employee
GA_GROUP = "grp-walls-globaladmins"
AROLE = "grp-walls-a-manager"
TGRANT = "grp-walls-tasks"


class CompanyWallsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=COA, name="Alpha Co"))
            db.add(models.HrEntity(id=COB, name="Beta Co"))
            db.add(models.NexusEmployee(id=f"e-{GLOBAL}", first_name="Gwen", last_name="Global",
                                        work_email=GLOBAL, status="active", deleted_at="", company=COA))
            db.add(models.NexusEmployee(id=f"e-{AEMP}", first_name="Amy", last_name="Alpha",
                                        work_email=AEMP, status="active", deleted_at="", company=COA))
            db.add(models.NexusEmployee(id=f"e-{AMGR}", first_name="Arthur", last_name="Alpha",
                                        work_email=AMGR, status="active", deleted_at="", company=""))
            db.add(models.NexusEmployee(id=f"e-{BEMP}", first_name="Beth", last_name="Beta",
                                        work_email=BEMP, status="active", deleted_at="", company=COB))
            # GLOBAL is an administrator (level 4) - the bootstrap global admin
            db.add(models.NexusRole(email=GLOBAL, role="administrator"))
            db.add(models.NexusRole(email=AEMP, role="employee"))
            db.add(models.NexusRole(email=AMGR, role="employee"))
            db.add(models.NexusRole(email=BEMP, role="employee"))
            # A company-scoped role: membership puts AMGR in company A even though
            # his employee row has no company set.
            db.add(models.NexusGroup(id=AROLE, name="Alpha - Manager", company_id=COA))
            db.add(models.NexusGroupMember(group_id=AROLE, email=AMGR))
            # Give the two employees a Tasks/Tickets grant so they can hit those
            # endpoints (the company wall applies AFTER the grant check).
            db.add(models.NexusGroup(id=TGRANT, name="Desk", allowed_modules="tasks:editor,tickets:editor"))
            db.add(models.NexusGroupMember(group_id=TGRANT, email=AEMP))
            db.add(models.NexusGroupMember(group_id=TGRANT, email=BEMP))
            db.commit()
        finally:
            db.close()
        self._flush()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        self._flush()

    def _flush(self):
        cache.settings_config.invalidate()
        cache.people_directory.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("walls.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("walls.%")).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_([COA, COB])).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id.in_([GA_GROUP, AROLE, TGRANT])).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id.in_([GA_GROUP, AROLE, TGRANT])).delete(synchronize_session=False)
            db.query(models.Task).filter(models.Task.id.like("task-walls%")).delete(synchronize_session=False)
            db.query(models.TaskTicket).filter(models.TaskTicket.id.like("tkt-walls%")).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key == "company_walls").delete(synchronize_session=False)
            db.query(models.AuditLog).filter(models.AuditLog.action.like("company_walls_%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _arm(self, on=True):
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

    def _dir_emails(self, as_email):
        os.environ["NEXUS_DEV_EMAIL"] = as_email
        cache.people_directory.invalidate()
        r = self.client.get("/myhr/directory")
        self.assertEqual(r.status_code, 200, r.text)
        return {p["email"] for p in r.json()}

    # ── the matrix ────────────────────────────────────────────────────────────
    def test_walls_off_everyone_sees_everyone(self):
        # Default (unarmed): the directory is the old org-wide list for all callers.
        self.assertIn(BEMP, self._dir_emails(AEMP))
        self.assertIn(AEMP, self._dir_emails(BEMP))

    def test_armed_directory_is_company_scoped(self):
        self._arm(True)
        a = self._dir_emails(AEMP)
        self.assertIn(AEMP, a); self.assertIn(GLOBAL, a)     # same company (A)
        self.assertNotIn(BEMP, a)                            # company B is walled off
        b = self._dir_emails(BEMP)
        self.assertIn(BEMP, b)
        self.assertNotIn(AEMP, b); self.assertNotIn(GLOBAL, b)

    def test_global_admin_sees_across_companies(self):
        self._arm(True)
        seen = self._dir_emails(GLOBAL)
        self.assertTrue({AEMP, BEMP, AMGR} <= seen)          # every company

    def test_company_scoped_role_places_person_in_that_company(self):
        # AMGR has no home company, but his "Alpha - Manager" group carries company A.
        self._arm(True)
        a = self._dir_emails(AMGR)
        self.assertIn(AEMP, a)                               # sees company A
        self.assertNotIn(BEMP, a)                            # not company B

    def test_scope_helper_values(self):
        self._arm(True)
        db = database.SessionLocal()
        try:
            self.assertIsNone(auth.company_scope({"email": GLOBAL, "level": 4}, db))
            self.assertEqual(auth.company_scope({"email": AEMP, "level": 1}, db), {COA})
            self.assertEqual(auth.company_scope({"email": AMGR, "level": 1}, db), {COA})
            self.assertEqual(auth.company_scope({"email": BEMP, "level": 1}, db), {COB})
        finally:
            db.close()

    def _mk_task(self, tid, company, creator):
        db = database.SessionLocal()
        try:
            db.add(models.Task(id=tid, code=tid, title=f"Task {tid}", company_id=company,
                               created_by=creator, owner_email=creator, access_level="org"))
            db.commit()
        finally:
            db.close()

    def _mk_ticket(self, tid, company, requester):
        db = database.SessionLocal()
        try:
            db.add(models.TaskTicket(id=tid, code=tid, subject=f"Ticket {tid}", company_id=company,
                                     requester_email=requester, status="new"))
            db.commit()
        finally:
            db.close()

    def _get_ids(self, path, as_email):
        os.environ["NEXUS_DEV_EMAIL"] = as_email
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200, r.text)
        data = r.json()
        rows = data.get("tasks", data) if isinstance(data, dict) else data
        return {x.get("id") for x in rows}

    def test_armed_tasks_are_company_walled(self):
        self._mk_task("task-walls-a", COA, AEMP)
        self._mk_task("task-walls-b", COB, BEMP)
        self._arm(True)
        a = self._get_ids("/tasks", AEMP)
        self.assertIn("task-walls-a", a); self.assertNotIn("task-walls-b", a)
        b = self._get_ids("/tasks", BEMP)
        self.assertIn("task-walls-b", b); self.assertNotIn("task-walls-a", b)
        g = self._get_ids("/tasks", GLOBAL)          # Global Admin sees both
        self.assertTrue({"task-walls-a", "task-walls-b"} <= g)

    def test_armed_tickets_are_company_walled(self):
        self._mk_ticket("tkt-walls-a", COA, AEMP)
        self._mk_ticket("tkt-walls-b", COB, BEMP)
        self._arm(True)
        a = self._get_ids("/task-tickets", AEMP)
        self.assertIn("tkt-walls-a", a); self.assertNotIn("tkt-walls-b", a)
        g = self._get_ids("/task-tickets", GLOBAL)
        self.assertTrue({"tkt-walls-a", "tkt-walls-b"} <= g)

    def test_arm_switch_endpoint_arms_and_audits(self):
        os.environ["NEXUS_DEV_EMAIL"] = GLOBAL   # administrator = bootstrap global admin
        r = self.client.put("/access-scopes/config/walls", json={"on": True})
        self.assertEqual(r.status_code, 200, r.text)
        self._flush()
        g = self.client.get("/access-scopes/config/walls")
        self.assertTrue(g.json()["on"])
        # Armed: a scoped user is now confined in the directory.
        self.assertNotIn(BEMP, self._dir_emails(AEMP))
        # An audit row was written.
        db = database.SessionLocal()
        try:
            self.assertTrue(db.query(models.AuditLog)
                            .filter(models.AuditLog.action == "company_walls_armed").first())
        finally:
            db.close()

    def test_global_admins_group_supersedes_level(self):
        # Before any Global Admins group: level 4 is the bootstrap global admin.
        db = database.SessionLocal()
        try:
            self.assertTrue(auth.is_global_admin({"email": GLOBAL, "level": 4}, db))
        finally:
            db.close()
        # Create + populate a Global Admins group with someone else -> the level-4
        # user who is NOT a member is no longer global (rule: rank != reach).
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=GA_GROUP, name="Global Admins", is_global_admin=1))
            db.add(models.NexusGroupMember(group_id=GA_GROUP, email=AEMP))
            db.commit()
        finally:
            db.close()
        db = database.SessionLocal()
        try:
            self.assertFalse(auth.is_global_admin({"email": GLOBAL, "level": 4}, db))
            self.assertTrue(auth.is_global_admin({"email": AEMP, "level": 1}, db))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
