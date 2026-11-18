"""People pass (11/16/2026) - the backend fixes, pinned.

- A manager's People list never carries a team member's National ID.
- The field audit hides the National ID and date of birth inside `personal`,
  and the change log (audit_capture) hides them inside an HR table's JSON.
- A mailbox export: never of someone above the caller's tier or of an
  Administrator (below Super Administrator), audited when Change Status
  starts one, and stopped when the person is set back to Active.
- An Administrator below Super Administrator never moves their own or another
  Administrator's company.
- The hover card (/myhr/person) finds a guest / external only by their exact
  address for a caller who may not see externals.
- Add Person: only Pay & Benefits sets a contractor's rate.
- Restore never brings back a second live person with the same work email.
- Effective Date takes MM/DD/YYYY as well as YYYY-MM-DD.

    python -m pytest test_people_fixes_nov16.py
"""
import json
import os
import tempfile
import time
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_RATE_LIMIT", "off")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
SUPER, ADMIN, ADMIN2, EDITOR, MGR, ADA, BEN = (f"super{D}", f"admin{D}", f"admin2{D}", f"eddie.editor{D}",
                                              f"max.mgr{D}", f"ada{D}", f"ben{D}")
GUEST = "gus@gmail.com"
A, B = "co-a", "co-b"


class PeopleFixesTests(unittest.TestCase):
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
        for m in (models.NexusEmployee, models.AuditLog, models.NexusRole, models.NexusGroup, models.NexusGroupMember,
                  models.HrEntity, models.HrMailboxExport, models.NexusSetting):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=A, name="Co A", country="US"))
        db.add(models.HrEntity(id=B, name="Co B", country="US"))
        people = (("e-super", SUPER, ""), ("e-admin", ADMIN, A), ("e-admin2", ADMIN2, A), ("e-ed", EDITOR, A),
                  ("e-mgr", MGR, A), ("e-ada", ADA, A), ("e-ben", BEN, A))
        for i, (eid, em, co) in enumerate(people):
            db.add(models.NexusEmployee(
                id=eid, first_name=em.split("@")[0].split(".")[0].title(), last_name="T", work_email=em, company=co,
                employee_code=f"GG-{i:03d}", status="active", deleted_at="",
                manager_email=MGR if em in (ADA, BEN) else "",
                personal={"nationalId": "123-45-6789", "dob": "1990-01-31", "maritalStatus": "single"}))
        db.add(models.NexusEmployee(id="e-gus", first_name="Gus", last_name="Guest", work_email=GUEST, company=A,
                                    employee_code="GG-099", status="active", identity_type="external", deleted_at=""))
        db.add(models.NexusRole(email=SUPER, role="owner", display_name="Sue"))
        db.add(models.NexusRole(email=ADMIN, role="administrator", display_name="Ann"))
        db.add(models.NexusRole(email=ADMIN2, role="administrator", display_name="Abe"))
        db.add(models.NexusRole(email=MGR, role="manager", display_name="Max"))
        db.add(models.NexusGroup(id="g-ed", name="People Editors", allowed_modules="hr:editor"))
        db.add(models.NexusGroupMember(group_id="g-ed", email=EDITOR))
        db.add(models.NexusGroupMember(group_id="g-ed", email=MGR))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()
        cache.contact_directory.invalidate()
        cache.people_directory.invalidate()
        auth._role_cache.clear()
        self.as_(SUPER)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _db(self):
        return database.SessionLocal()

    def _set(self, eid, **kw):
        db = self._db()
        db.query(models.NexusEmployee).filter_by(id=eid).update(kw)
        db.commit()
        db.close()

    # 1 ── the manager's People list ──────────────────────────────────────────
    def test_a_managers_people_list_never_carries_the_national_id(self):
        self.as_(MGR)
        r = self.client.get("/hr/employees")
        self.assertEqual(r.status_code, 200, r.text)
        team = {p["workEmail"]: p for p in r.json()}
        self.assertIn(ADA, team)
        self.assertNotIn("nationalId", team[ADA].get("personal") or {})
        self.assertNotIn("123-45-6789", r.text)
        self.assertEqual(team[ADA]["personal"]["maritalStatus"], "single")   # the rest of Overview stays
        self.as_(SUPER)                                                       # HR still sees it
        self.assertIn("123-45-6789", self.client.get("/hr/employees").text)

    # 9 ── the emergency contact merges field by field ─────────────────────────
    def test_an_emergency_contact_edit_keeps_what_the_person_changed_meanwhile(self):
        # The person changed their contact's phone in My HR while HR had the
        # record open; HR then fixes the contact's name only.
        self._set("e-ben", personal={"emergency": {"name": "Ann Old", "relationship": "Sister",
                                                   "phone": "555-0199", "email": ""}})
        r = self.client.patch("/hr/employees/e-ben", json={"personal": {"emergency": {"name": "Ann New"}}})
        self.assertEqual(r.status_code, 200, r.text)
        db = self._db()
        em = (db.query(models.NexusEmployee).filter_by(id="e-ben").one().personal or {}).get("emergency")
        db.close()
        self.assertEqual(em, {"name": "Ann New", "relationship": "Sister", "phone": "555-0199", "email": ""})

    # 2 ── the audit logs ─────────────────────────────────────────────────────
    def test_the_field_audit_hides_the_national_id_and_birth_date(self):
        r = self.client.patch("/hr/employees/e-ben", json={"personal": {"maritalStatus": "married"}})
        self.assertEqual(r.status_code, 200, r.text)
        db = self._db()
        rows = db.query(models.AuditLog).filter(models.AuditLog.action == "Changed employee fields",
                                                models.AuditLog.resource_id == "e-ben").all()
        db.close()
        self.assertEqual(len(rows), 1)
        details = rows[0].details
        self.assertIn("married", details)                 # a plain change still reads
        for secret in ("123-45-6789", "1990-01-31"):
            self.assertNotIn(secret, details)

    def test_the_change_log_hides_the_national_id_inside_an_hr_json_column(self):
        import audit_capture
        out = audit_capture._field("nexus_employees", "personal",
                                   {"nationalId": "123-45-6789", "dob": "1990-01-31", "maritalStatus": "single"},
                                   {"nationalId": "123-45-6789", "dob": "1990-01-31", "maritalStatus": "married"},
                                   has_before=True, has_after=True)
        dumped = json.dumps(out)
        self.assertIn("married", dumped)
        for secret in ("123-45-6789", "1990-01-31"):
            self.assertNotIn(secret, dumped)

    # 3 ── mailbox export ─────────────────────────────────────────────────────
    def _offboard_body(self, status="inactive"):
        return {"status": status, "reason": "test", "offboarding": {"exportRequested": True}}

    def test_change_status_export_needs_the_tier_and_is_audited(self):
        for eid in ("e-ben", "e-admin2"):
            self._set(eid, m365_id=f"m-{eid}")
        with mock.patch("routers.hr._graph_token", return_value="tok"), \
             mock.patch("routers.hr._run_mailbox_export") as run:
            # A People editor (Employee tier) may not export an Administrator's mailbox.
            self.as_(EDITOR)
            r = self.client.post("/hr/employees/e-admin2/status", json=self._offboard_body())
            self.assertEqual(r.status_code, 403, r.text)
            # An Administrator may not export another Administrator's either.
            self.as_(ADMIN)
            r = self.client.post("/hr/employees/e-admin2/status", json=self._offboard_body())
            self.assertEqual(r.status_code, 403, r.text)
            # An ordinary colleague's, yes - and the start is audited.
            self.as_(EDITOR)
            r = self.client.post("/hr/employees/e-ben/status", json=self._offboard_body())
            self.assertEqual(r.status_code, 200, r.text)
            for _ in range(50):       # the export's thread starts the (mocked) run
                if run.call_count:
                    break
                time.sleep(0.02)
            self.assertEqual(run.call_count, 1)
        db = self._db()
        actions = [a for (a,) in db.query(models.AuditLog.action).filter(models.AuditLog.resource_id == "e-ben")]
        status = db.query(models.NexusEmployee.status).filter_by(id="e-admin2").scalar()
        db.close()
        self.assertIn("Started a mailbox export", actions)
        self.assertEqual(status, "active")    # a refused export changed nothing

    def test_an_export_stops_when_the_person_is_active_again(self):
        from routers import hr as hr_router
        db = self._db()
        db.add(models.HrMailboxExport(id="job1", employee_id="e-ben", requested_by=SUPER, status="pending",
                                      created_at="2026-11-16T00:00:00", updated_at="2026-11-16T00:00:00"))
        db.commit()
        db.close()
        with mock.patch.object(hr_router, "_graph_token", return_value="tok"), \
             mock.patch.object(hr_router.httpx, "get") as get:
            ok, why = hr_router._export_mailbox("job1", "m-ben")      # Ben is Active
        self.assertFalse(ok)
        get.assert_not_called()                                         # not one message read
        db = self._db()
        job = db.query(models.HrMailboxExport).filter_by(id="job1").first()
        db.close()
        self.assertEqual(job.status, "error")
        self.assertIn("no longer Inactive or Left", job.message)

    # 4 ── an Administrator's company ─────────────────────────────────────────
    def test_an_administrator_never_moves_their_own_or_another_admins_company(self):
        self.as_(ADMIN)
        r = self.client.patch("/hr/employees/e-admin", json={"company": B})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.patch("/hr/employees/e-admin2", json={"company": B})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.patch("/hr/employees/e-admin2", json={"company": A, "job_title": "Ops"})
        self.assertEqual(r.status_code, 200, r.text)                     # unchanged company is fine
        r = self.client.patch("/hr/employees/e-ben", json={"company": B})
        self.assertEqual(r.status_code, 200, r.text)                     # an employee, yes
        self.as_(SUPER)
        r = self.client.patch("/hr/employees/e-admin2", json={"company": B})
        self.assertEqual(r.status_code, 200, r.text)                     # a Super Administrator, yes

    # 5 ── the hover card and externals ───────────────────────────────────────
    def test_the_hover_card_finds_an_external_only_by_exact_address(self):
        self.as_(ADA)                                       # plain employee, no Tasks grant
        self.assertEqual(self.client.get("/myhr/person", params={"q": "gmail.com"}).status_code, 404)
        self.assertEqual(self.client.get("/myhr/person", params={"q": "gus"}).status_code, 404)
        r = self.client.get("/myhr/person", params={"q": GUEST})
        self.assertEqual(r.status_code, 200, r.text)
        self.as_(MGR)                                       # a manager may see externals
        r = self.client.get("/myhr/person", params={"q": "gmail.com"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["workEmail"], GUEST)

    # 6 ── Add Person and a contractor's rate ─────────────────────────────────
    def test_only_pay_and_benefits_sets_a_contractors_rate_on_a_new_person(self):
        self.as_(EDITOR)
        body = {"first_name": "Cora", "work_email": f"cora{D}", "company": A, "employment_type": "contractor",
                "contractor": {"rate": "85", "rate_type": "hourly"}}
        r = self.client.post("/hr/employees", json=body)
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.post("/hr/employees", json={**body, "contractor": {"invoice_prefix": "CORA"}})
        self.assertEqual(r.status_code, 200, r.text)        # without a rate, yes

    # 7 ── restore ────────────────────────────────────────────────────────────
    def test_restore_never_makes_two_live_people_with_one_email(self):
        self._set("e-ben", deleted_at="2026-11-16T00:00:00", deleted_by=SUPER)
        r = self.client.post("/hr/employees", json={"first_name": "Ben", "work_email": BEN.upper(), "company": A})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.post("/hr/employees/e-ben/restore")
        self.assertEqual(r.status_code, 409, r.text)
        db = self._db()
        live = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == BEN).count()
        db.close()
        self.assertEqual(live, 1)

    # 8 ── Effective Date ─────────────────────────────────────────────────────
    def test_effective_date_takes_us_format_and_stores_iso(self):
        for sent, stored in (("11/05/2026", "2026-11-05"), ("2026-11-06", "2026-11-06")):
            r = self.client.put("/hr/employees/e-ben/compensation",
                                json={"compensation": {"base": "50000", "effectiveDate": sent}})
            self.assertEqual(r.status_code, 200, r.text)
            db = self._db()
            comp = db.query(models.NexusEmployee.compensation).filter_by(id="e-ben").scalar()
            db.close()
            self.assertEqual(comp["effectiveDate"], stored)
        r = self.client.put("/hr/employees/e-ben/compensation",
                            json={"compensation": {"base": "50000", "effectiveDate": "next week"}})
        self.assertEqual(r.status_code, 400, r.text)


if __name__ == "__main__":
    unittest.main()
