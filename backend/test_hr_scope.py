"""Company-scoped People admins (Neil, Aug 25) - the boundary as tests.

A person with an hr grant AND nexus_access_scopes rows (module_id='hr',
scope_type='entity') must only see/touch employees, candidates, leave and
companies inside those entity ids. Out-of-scope ids answer 404 (existence must
not leak), the company re-tag escape is blocked, whole-tenant actions
(M365 sync, entity create) refuse with 403, and _visible_emails hands the Time
surfaces the scoped email set. A grant WITHOUT scope rows stays unrestricted.

    python -m unittest test_hr_scope
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers.timeclock import _visible_emails

models.Base.metadata.create_all(bind=database.engine)

# create_all never alters an existing table - apply the hr_candidates.company
# migration line here (main.py's lifespan does it on a real boot; unittest
# never runs the lifespan).
from sqlalchemy import text as _text
with database.engine.connect() as _conn:
    for _stmt in ("ALTER TABLE hr_candidates ADD COLUMN company TEXT DEFAULT ''",
                  "ALTER TABLE nexus_groups ADD COLUMN bod_exempt INTEGER DEFAULT 0",
                  "ALTER TABLE nexus_employees ADD COLUMN geofence_lat TEXT DEFAULT ''",
                  "ALTER TABLE nexus_employees ADD COLUMN geofence_lng TEXT DEFAULT ''",
                  "ALTER TABLE nexus_employees ADD COLUMN geofence_radius_m INTEGER DEFAULT 0",
                  "ALTER TABLE nexus_employees ADD COLUMN geofence_label TEXT DEFAULT ''",
                  "ALTER TABLE nexus_employees ADD COLUMN geofence_source TEXT DEFAULT ''",
                  "ALTER TABLE nexus_employees ADD COLUMN geofence_set_by TEXT DEFAULT ''",
                  "ALTER TABLE nexus_employees ADD COLUMN geofence_set_at TEXT DEFAULT ''"):
        try:
            _conn.execute(_text(_stmt))
            _conn.commit()
        except Exception:
            pass   # already there

SCOPED = "scoped.admin.hrscope@greensglobal.com"       # hr:editor + scope on CO_A
UNRESTRICTED = "open.admin.hrscope@greensglobal.com"   # hr:editor, no scope rows
CO_A = "co-a-test-hrscope"
CO_B = "co-b-test-hrscope"
EMP_A = "emp-a-test-hrscope"
EMP_B = "emp-b-test-hrscope"
EMP_NONE = "emp-none-test-hrscope"                     # company == '' (untagged)
EMP_B_DEL = "emp-bdel-test-hrscope"                    # soft-deleted, out of scope
DOC_B_DEL = "doc-bdel-test-hrscope"
GROUP = "grp-test-hrscope"
CAND_A = "cand-a-test-hrscope"
CAND_B = "cand-b-test-hrscope"
APPR_B = "appr-b-test-hrscope"
IV_B = "iv-b-test-hrscope"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


class HrScopeTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            db.add(models.HrEntity(id=CO_A, name="Scope Test Co A"))
            db.add(models.HrEntity(id=CO_B, name="Scope Test Co B"))
            db.add(models.NexusEmployee(id=EMP_A, first_name="Ava", last_name="Alpha",
                                        work_email="ava.alpha.hrscope@greensglobal.com",
                                        company=CO_A, deleted_at=""))
            db.add(models.NexusEmployee(id=EMP_B, first_name="Ben", last_name="Beta",
                                        work_email="ben.beta.hrscope@greensglobal.com",
                                        company=CO_B, deleted_at=""))
            db.add(models.NexusEmployee(id=EMP_NONE, first_name="Nia", last_name="None",
                                        work_email="nia.none.hrscope@greensglobal.com",
                                        company="", deleted_at=""))
            db.add(models.NexusGroup(id=GROUP, name="HR Scope Test Group",
                                     allowed_modules="hr:editor"))
            for em in (SCOPED, UNRESTRICTED):
                db.add(models.NexusGroupMember(group_id=GROUP, email=em))
            db.add(models.NexusAccessScope(id=str(uuid.uuid4()), email=SCOPED,
                                           module_id="hr", scope_type="entity", scope_id=CO_A))
            db.add(models.HrLeaveRequest(id="leave-a-test-hrscope", employee_id=EMP_A,
                                         leave_type="annual", start_date="2026-09-01",
                                         end_date="2026-09-01", days=1.0, status="pending"))
            db.add(models.HrLeaveRequest(id="leave-b-test-hrscope", employee_id=EMP_B,
                                         leave_type="annual", start_date="2026-09-01",
                                         end_date="2026-09-01", days=1.0, status="pending"))
            db.add(models.HrCandidate(id=CAND_A, first_name="CandA", company=CO_A))
            db.add(models.HrCandidate(id=CAND_B, first_name="CandB", company=CO_B))
            # A SOFT-DELETED out-of-scope employee + one of their documents: the
            # session filter hides the employee row, so _assert_scope must still
            # fail closed (was the None fall-through leak).
            db.add(models.NexusEmployee(id=EMP_B_DEL, first_name="Gone", last_name="Beta",
                                        work_email="gone.beta.hrscope@greensglobal.com",
                                        company=CO_B, deleted_at="2026-08-01T00:00:00"))
            db.add(models.HrDocument(id=DOC_B_DEL, employee_id=EMP_B_DEL, kind="other",
                                     file_name="x.pdf", storage_path="p/x.pdf", size_bytes=1,
                                     uploaded_by="seed", created_at="2026-08-01T00:00:00"))
            # A TimeApproval + interview for out-of-scope people.
            db.add(models.TimeApproval(id=APPR_B, employee_email="ben.beta.hrscope@greensglobal.com",
                                       period_start="2026-08-01", period_end="2026-08-15",
                                       approved_by="seed", approved_at="2026-08-16T00:00:00", revoked=0))
            db.add(models.HrInterview(id=IV_B, candidate_id=CAND_B, status="scored",
                                      total_score=88.0, created_at="2026-08-01T00:00:00",
                                      updated_at="2026-08-01T00:00:00"))
            db.commit()
        finally:
            db.close()
        # Grants are TTL-cached per email - the rows above must be what resolves.
        cache.module_grants.invalidate()

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.HrEntity).filter(models.HrEntity.id.in_((CO_A, CO_B))).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.id.in_((EMP_A, EMP_B, EMP_NONE, EMP_B_DEL))).delete(synchronize_session=False))
            db.query(models.HrDocument).filter(models.HrDocument.id == DOC_B_DEL).delete(synchronize_session=False)
            db.query(models.TimeApproval).filter(models.TimeApproval.id == APPR_B).delete(synchronize_session=False)
            db.query(models.HrInterview).filter(models.HrInterview.id == IV_B).delete(synchronize_session=False)
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusAccessScope).filter(models.NexusAccessScope.email.in_((SCOPED, UNRESTRICTED))).delete(synchronize_session=False)
            db.query(models.HrLeaveRequest).filter(models.HrLeaveRequest.id.in_(("leave-a-test-hrscope", "leave-b-test-hrscope"))).delete(synchronize_session=False)
            db.query(models.HrCandidate).filter(models.HrCandidate.id.in_((CAND_A, CAND_B))).delete(synchronize_session=False)
            db.query(models.HrDepartment).filter(models.HrDepartment.company_id.in_((CO_A, CO_B))).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    # ── directory ────────────────────────────────────────────────────────────
    def test_scoped_list_shows_only_own_company_and_hides_untagged(self):
        _as(SCOPED)
        ids = {e["id"] for e in self.client.get("/hr/employees").json()}
        self.assertIn(EMP_A, ids)
        self.assertNotIn(EMP_B, ids)
        self.assertNotIn(EMP_NONE, ids)

    def test_unrestricted_admin_sees_everyone(self):
        _as(UNRESTRICTED)
        ids = {e["id"] for e in self.client.get("/hr/employees").json()}
        self.assertTrue({EMP_A, EMP_B, EMP_NONE} <= ids)

    # ── {eid} endpoints: 404 out of scope, retag blocked ─────────────────────
    def test_foreign_employee_is_404_not_403(self):
        _as(SCOPED)
        r = self.client.patch(f"/hr/employees/{EMP_B}", json={"job_title": "X"})
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.client.get(f"/hr/employees/{EMP_B}/documents").status_code, 404)
        self.assertEqual(self.client.post(f"/hr/employees/{EMP_B}/status",
                                          json={"status": "inactive"}).status_code, 404)

    def test_in_scope_employee_editable(self):
        _as(SCOPED)
        r = self.client.patch(f"/hr/employees/{EMP_A}", json={"job_title": "Scoped Edit"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["jobTitle"], "Scoped Edit")

    def test_company_retag_escape_blocked(self):
        _as(SCOPED)
        r = self.client.patch(f"/hr/employees/{EMP_A}", json={"company": CO_B})
        self.assertEqual(r.status_code, 403)

    def test_create_requires_own_company(self):
        _as(SCOPED)
        self.assertEqual(self.client.post("/hr/employees",
                                          json={"first_name": "New", "company": CO_B}).status_code, 403)
        self.assertEqual(self.client.post("/hr/employees",
                                          json={"first_name": "New", "company": ""}).status_code, 403)
        r = self.client.post("/hr/employees", json={"first_name": "New", "last_name": "Hire",
                                                    "company": CO_A})
        self.assertEqual(r.status_code, 200)
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == r.json()["id"]).delete()
            db.commit()
        finally:
            db.close()

    # ── whole-tenant actions refuse ──────────────────────────────────────────
    def test_sync_and_entity_create_forbidden_for_scoped(self):
        _as(SCOPED)
        self.assertEqual(self.client.post("/hr/employees/sync-m365").status_code, 403)
        self.assertEqual(self.client.post("/hr/entities", json={"name": "Nope"}).status_code, 403)

    def test_entities_list_filtered(self):
        _as(SCOPED)
        ids = {e["id"] for e in self.client.get("/hr/entities").json()}
        self.assertEqual(ids, {CO_A})

    # ── leave + candidates joins ─────────────────────────────────────────────
    def test_leave_list_filtered_by_employee_company(self):
        _as(SCOPED)
        ids = {r["id"] for r in self.client.get("/hr/leave").json()}
        self.assertIn("leave-a-test-hrscope", ids)
        self.assertNotIn("leave-b-test-hrscope", ids)

    def test_candidates_filtered_and_foreign_404(self):
        _as(SCOPED)
        ids = {c["id"] for c in self.client.get("/hr/candidates").json()}
        self.assertIn(CAND_A, ids)
        self.assertNotIn(CAND_B, ids)
        self.assertEqual(self.client.patch(f"/hr/candidates/{CAND_B}",
                                           json={"notes": "x"}).status_code, 404)
        self.assertEqual(self.client.post("/hr/candidates",
                                          json={"first_name": "C", "company": CO_B}).status_code, 403)

    # ── audit-fix regressions (adversarial workflow, Aug 25) ─────────────────
    def test_soft_deleted_out_of_scope_document_404(self):
        # _assert_scope must fail closed when the employee row is hidden by the
        # soft-delete filter (was a None fall-through leak).
        _as(SCOPED)
        self.assertEqual(self.client.get(f"/hr/employees/{EMP_B_DEL}/documents").status_code, 404)

    def test_entity_domains_change_blocked_for_scoped(self):
        _as(SCOPED)
        r = self.client.patch(f"/hr/entities/{CO_A}", json={"domains": "greensglobal.com"})
        self.assertEqual(r.status_code, 403)
        # a non-domains edit to their own entity still works
        self.assertEqual(self.client.patch(f"/hr/entities/{CO_A}", json={"notes": "ok"}).status_code, 200)

    def test_sync_status_forbidden_for_scoped(self):
        _as(SCOPED)
        self.assertEqual(self.client.get("/hr/employees/sync-m365-two-way/status").status_code, 403)

    def test_revoke_approval_out_of_scope_404(self):
        _as(SCOPED)
        self.assertEqual(self.client.patch(f"/timeclock/approvals/{APPR_B}").status_code, 404)

    def test_shift_assign_skips_out_of_scope(self):
        _as(SCOPED)
        r = self.client.post("/timeclock/shift-assign",
                             json={"shift_id": "", "emails": ["ben.beta.hrscope@greensglobal.com"]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json().get("assigned"), 0)   # out-of-scope email skipped

    def test_shift_group_create_forbidden_for_scoped(self):
        _as(SCOPED)
        self.assertEqual(self.client.post("/timeclock/shift-groups",
                                          json={"name": "X", "members": []}).status_code, 403)

    def test_interview_leaderboard_filtered(self):
        _as(SCOPED)
        r = self.client.get("/hr/interviews/leaderboard")
        self.assertEqual(r.status_code, 200)
        ids = {row["candidateId"] for row in r.json()}
        self.assertNotIn(CAND_B, ids)

    def test_out_of_scope_candidate_interviews_404(self):
        _as(SCOPED)
        self.assertEqual(self.client.get(f"/hr/candidates/{CAND_B}/interviews").status_code, 404)

    # ── per-person geofence (Aug 25) ─────────────────────────────────────────
    def test_geofence_set_get_and_scope(self):
        from routers.timeclock import _geofence
        _as(UNRESTRICTED)
        # set a personal geofence on the in-scope employee
        r = self.client.put(f"/hr/employees/{EMP_A}/geofence",
                            json={"lat": "33.6846", "lng": "-117.8265", "radius_m": 150,
                                  "label": "Irvine warehouse", "source": "address"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["radiusM"], 150)
        got = self.client.get(f"/hr/employees/{EMP_A}/geofence").json()
        self.assertEqual(got["geofence"]["label"], "Irvine warehouse")
        # a punch AT the geofence is in_fence; far away is out_of_fence
        db = database.SessionLocal()
        try:
            near = _geofence(db, "33.6847", "-117.8266", 10, email="ava.alpha.hrscope@greensglobal.com")
            far = _geofence(db, "34.0522", "-118.2437", 10, email="ava.alpha.hrscope@greensglobal.com")
            self.assertEqual(near["geo_status"], "in_fence")
            self.assertEqual(near["work_site_id"], "personal")
            self.assertEqual(far["geo_status"], "out_of_fence")
        finally:
            db.close()
        # clearing it (radius 0) removes the personal geofence
        self.client.put(f"/hr/employees/{EMP_A}/geofence", json={"radius_m": 0})
        self.assertEqual(self.client.get(f"/hr/employees/{EMP_A}/geofence").json()["geofence"]["radiusM"], 0)

    def test_geofence_out_of_scope_404(self):
        _as(SCOPED)
        self.assertEqual(self.client.get(f"/hr/employees/{EMP_B}/geofence").status_code, 404)
        self.assertEqual(self.client.put(f"/hr/employees/{EMP_B}/geofence",
                                         json={"lat": "1", "lng": "1", "radius_m": 100}).status_code, 404)

    # ── the Time-surface root ────────────────────────────────────────────────
    def test_visible_emails_scoped_set(self):
        db = database.SessionLocal()
        try:
            vis = _visible_emails(db, {"email": SCOPED, "level": 1})
            self.assertIsInstance(vis, set)
            self.assertIn("ava.alpha.hrscope@greensglobal.com", vis)
            self.assertNotIn("ben.beta.hrscope@greensglobal.com", vis)
            self.assertIn(SCOPED, vis)   # always includes self
            self.assertIsNone(_visible_emails(db, {"email": UNRESTRICTED, "level": 1}))
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
