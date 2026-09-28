"""Company job roles (Sep 2026): a job role may belong to one company (an
HrEntity) or be shared across all of them. Proves the company is validated and
filterable, that a company role never reaches someone from another company -
by assignment or by moving the role - and that shared roles behave as before.

    python -m pytest test_company_job_roles.py
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
                 "ALTER TABLE nexus_groups ADD COLUMN default_manager_email TEXT DEFAULT ''",
                 "ALTER TABLE nexus_roles ADD COLUMN tier_pinned BOOLEAN DEFAULT 0"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

COA, COB = "ent-cjr-a", "ent-cjr-b"
OWNER = "cjr.owner@greensglobal.com"
ADMIN = "cjr.admin@greensglobal.com"       # IT Admin: below owner
AEMP = "cjr.aemp@greensglobal.com"         # company A
AEMP2 = "cjr.aemp2@greensglobal.com"       # company A
BEMP = "cjr.bemp@greensglobal.com"         # company B
NOCO = "cjr.noco@greensglobal.com"         # People record with no company
ROLE_A = "JRcjr-a"                         # company A role
ROLE_B = "JRcjr-b"                         # company B role
SHARED = "JRcjr-shared"                    # shared across companies
SHARED_MIXED = "JRcjr-mixed"               # shared, members in A and B
SHARED_ADMIN = "JRcjr-admin-tier"          # shared, Administrator tier


class CompanyJobRoleTests(unittest.TestCase):
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
            for email, first, company in ((OWNER, "Olive", COA), (ADMIN, "Adam", COA), (AEMP, "Amy", COA),
                                          (AEMP2, "Abe", COA), (BEMP, "Beth", COB), (NOCO, "Nora", "")):
                db.add(models.NexusEmployee(id=f"e-{email}", first_name=first, last_name="Test",
                                            work_email=email, status="active", deleted_at="", company=company))
            db.add(models.NexusRole(email=OWNER, role="owner"))
            db.add(models.NexusRole(email=ADMIN, role="administrator"))
            db.add(models.NexusGroup(id=ROLE_A, name="cjr Alpha Crew", is_job_role=1, tier="employee", company_id=COA))
            db.add(models.NexusGroup(id=ROLE_B, name="cjr Beta Crew", is_job_role=1, tier="employee", company_id=COB))
            db.add(models.NexusGroup(id=SHARED, name="cjr Shared Crew", is_job_role=1, tier="employee", company_id=""))
            db.add(models.NexusGroup(id=SHARED_MIXED, name="cjr Mixed Crew", is_job_role=1, tier="employee", company_id=""))
            db.add(models.NexusGroup(id=SHARED_ADMIN, name="cjr Admin Crew", is_job_role=1, tier="administrator", company_id=""))
            db.add(models.NexusGroupMember(group_id=SHARED, email=AEMP))
            db.add(models.NexusGroupMember(group_id=SHARED, email=NOCO))
            db.add(models.NexusGroupMember(group_id=SHARED_MIXED, email=AEMP2))
            db.add(models.NexusGroupMember(group_id=SHARED_MIXED, email=BEMP))
            db.commit()
        finally:
            db.close()
        self._as(OWNER)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            role_ids = [g.id for g in db.query(models.NexusGroup.id)
                        .filter(models.NexusGroup.name.like("cjr %")).all()]
            if role_ids:
                db.query(models.NexusGroupMember).filter(
                    models.NexusGroupMember.group_id.in_(role_ids)).delete(synchronize_session=False)
                db.query(models.NexusGroup).filter(
                    models.NexusGroup.id.in_(role_ids)).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(
                models.NexusGroupMember.email.like("cjr.%")).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("cjr.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("cjr.%")).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_([COA, COB])).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        for email in (OWNER, ADMIN, AEMP, AEMP2, BEMP, NOCO):
            auth.invalidate_role_cache(email)
        cache.settings_config.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        auth.invalidate_role_cache(email)

    def _members(self, role_id):
        db = database.SessionLocal()
        try:
            return {m.email for m in db.query(models.NexusGroupMember)
                    .filter(models.NexusGroupMember.group_id == role_id).all()}
        finally:
            db.close()

    def _ids(self, path):
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200, r.text)
        return {x["id"] for x in r.json()}

    # ── create / update ──────────────────────────────────────────────────────
    def test_create_with_company(self):
        r = self.client.post("/jobroles", json={"name": "cjr New Alpha Role", "company_id": COA})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["company_id"], COA)

    def test_create_without_company_is_shared(self):
        r = self.client.post("/jobroles", json={"name": "cjr New Shared Role"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["company_id"], "")

    def test_unknown_company_rejected(self):
        r = self.client.post("/jobroles", json={"name": "cjr Ghost Role", "company_id": "ent-does-not-exist"})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.put(f"/jobroles/{SHARED}", json={"company_id": "ent-does-not-exist"})
        self.assertEqual(r.status_code, 400, r.text)

    def test_move_shared_role_into_its_members_company(self):
        # Members: AEMP (company A) and NOCO (no company) - nobody from elsewhere.
        r = self.client.put(f"/jobroles/{SHARED}", json={"company_id": COA})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["company_id"], COA)
        self.assertEqual(self._members(SHARED), {AEMP, NOCO})
        # ...and back to shared.
        r = self.client.put(f"/jobroles/{SHARED}", json={"company_id": ""})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["company_id"], "")

    def test_move_refused_when_a_member_is_from_another_company(self):
        r = self.client.put(f"/jobroles/{SHARED_MIXED}", json={"company_id": COA})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("another company", r.json()["detail"])
        db = database.SessionLocal()
        try:
            self.assertEqual(db.get(models.NexusGroup, SHARED_MIXED).company_id, "")
        finally:
            db.close()

    def test_moving_a_role_needs_the_right_to_grant_its_tier(self):
        # An IT Admin may edit roles, but can't grant the Administrator tier, so
        # they can't carry that role's holders into another company either.
        self._as(ADMIN)
        r = self.client.put(f"/jobroles/{SHARED_ADMIN}", json={"company_id": COA})
        self.assertEqual(r.status_code, 403, r.text)
        # Other edits stay open to them as before.
        r = self.client.put(f"/jobroles/{SHARED_ADMIN}", json={"description": "Runs IT"})
        self.assertEqual(r.status_code, 200, r.text)

    # ── list filter ──────────────────────────────────────────────────────────
    def test_list_filter(self):
        only_a = self._ids(f"/jobroles?company_id={COA}")
        self.assertIn(ROLE_A, only_a)
        self.assertFalse({ROLE_B, SHARED, SHARED_MIXED} & only_a)

        a_and_shared = self._ids(f"/jobroles?company_id={COA}&include_shared=true")
        self.assertTrue({ROLE_A, SHARED, SHARED_MIXED} <= a_and_shared)
        self.assertNotIn(ROLE_B, a_and_shared)

        shared_only = self._ids("/jobroles?company_id=")
        self.assertTrue({SHARED, SHARED_MIXED} <= shared_only)
        self.assertFalse({ROLE_A, ROLE_B} & shared_only)

        everything = self._ids("/jobroles")
        self.assertTrue({ROLE_A, ROLE_B, SHARED, SHARED_MIXED} <= everything)

    # ── assignment ───────────────────────────────────────────────────────────
    def test_cross_company_assignment_rejected(self):
        r = self.client.post(f"/jobroles/{ROLE_A}/assign", json={"email": BEMP})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Beta Co", r.json()["detail"])
        self.assertNotIn(BEMP, self._members(ROLE_A))

    def test_same_company_assignment(self):
        r = self.client.post(f"/jobroles/{ROLE_A}/assign", json={"email": AEMP})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["company_id"], COA)
        self.assertEqual(r.json()["warning"], "")
        self.assertIn(AEMP, self._members(ROLE_A))
        self.assertNotIn(AEMP, self._members(SHARED))   # still one primary role

    def test_no_company_person_assigned_with_warning(self):
        r = self.client.post(f"/jobroles/{ROLE_A}/assign", json={"email": NOCO})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("Alpha Co", r.json()["warning"])
        self.assertIn(NOCO, self._members(ROLE_A))

    def test_shared_role_unchanged(self):
        # A shared role still goes to anyone, from any company, with no warning.
        for email in (BEMP, AEMP, NOCO):
            r = self.client.post(f"/jobroles/{SHARED_MIXED}/assign", json={"email": email})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["company_id"], "")
            self.assertEqual(r.json()["warning"], "")
        eff = self.client.get(f"/jobroles/effective/{BEMP}").json()
        self.assertEqual(eff["job_role"]["id"], SHARED_MIXED)
        self.assertEqual(eff["job_role"]["company_id"], "")

    # The generic groups routes must not get around the job-role checks.
    def test_groups_route_cannot_move_job_role_company(self):
        r = self.client.put(f"/groups/{SHARED_MIXED}", json={"company_id": COA})
        self.assertEqual(r.status_code, 400)
        r = self.client.put(f"/groups/{ROLE_A}", json={"name": "cjr Alpha Crew", "company_id": COA})
        self.assertEqual(r.status_code, 200)   # unchanged company is fine

    def test_groups_route_cannot_add_other_company_member(self):
        r = self.client.post(f"/groups/{ROLE_A}/members", json={"emails": [BEMP]})
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"/groups/{ROLE_A}/members", json={"emails": [AEMP2, NOCO]})
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
