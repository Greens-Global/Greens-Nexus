"""Workflows - Set A Person Detail (hr.set_person_field, Neil 11/05/2026).

The action writes through the People screen's own save
(`routers.hr.apply_profile_update`), so:

  * a non-HR owner, and an HR owner whose People access does not reach the
    person, are refused with a readable reason;
  * each value check refuses: a department that is not in Settings, Left
    (offboarding stays in People), yourself as manager, a manager outside
    the owner's wall, a blank on a field that may not be blank;
  * a set writes the field and ONE masked field-level AuditLog row naming
    the workflow, and fires employee.field_changed through the observer;
  * a second run changes nothing; the plan line is a sentence.

    cd backend && python -m pytest test_workflows_pack_hr_person.py -q
"""
import json
import os
import tempfile
import unittest
from datetime import date, timedelta
from types import SimpleNamespace

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402,F401 - wires the record observer and the packs as the app does
import models  # noqa: E402
from workflows import catalog  # noqa: E402
from workflows.context import RunContext  # noqa: E402

EMP = "erin.wfper@greensglobal.com"      # Erin, reports to Max, company A
MGR = "max.wfper@greensglobal.com"       # Max, company A
NEW = "nora.wfper@greensglobal.com"      # Nora, company A - the new manager
HRC = "hana.wfper@greensglobal.com"      # HR contact for A and B, People access limited to A
FAR = "farid.wfper@greensglobal.com"     # Farid, company B (HR contact Hana, outside her People access)
GA = "gail.wfper@greensglobal.com"       # a Super Administrator
LEFT = "lou.wfper@greensglobal.com"      # Lou, company A, offboarded
CO_A, CO_B = "ent-wfper-a", "ent-wfper-b"
TODAY = date.today()
GA_USER = {"email": GA, "role": "owner", "level": 5}
HRC_USER = {"email": HRC, "role": "employee", "level": 1}
EMP_USER = {"email": EMP, "role": "employee", "level": 1}
KEY = "hr.set_person_field"


class SetPersonDetailCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        catalog.load_packs()
        cls.act = catalog.ACTIONS[KEY]

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        auth.invalidate_role_cache()
        db = self.db = database.SessionLocal()
        for m in (models.WorkflowEvent, models.NexusEmployee, models.NexusRole, models.HrEntity,
                  models.HrDepartment, models.NexusAccessScope, models.AuditLog, models.HrChecklist,
                  models.HrChecklistItem, models.NexusSetting):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=CO_A, name="Greens A", country="US", hr_contact_email=HRC))
        db.add(models.HrEntity(id=CO_B, name="Greens B", country="US", hr_contact_email=HRC))
        db.add(models.HrDepartment(id="dep-ops", company_id=CO_A, name="Operations"))
        db.add(models.HrDepartment(id="dep-fin", company_id=CO_A, name="Finance"))
        for em, first, mgr, co, status in ((EMP, "Erin", MGR, CO_A, "active"), (MGR, "Max", "", CO_A, "active"),
                                           (NEW, "Nora", "", CO_A, "active"), (HRC, "Hana", "", CO_A, "active"),
                                           (FAR, "Farid", "", CO_B, "active"), (GA, "Gail", "", CO_A, "active"),
                                           (LEFT, "Lou", "", CO_A, "offboarded")):
            db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                        manager_email=mgr, status=status, company=co, employment_type="full_time",
                                        country="US", department="Operations", job_title="Analyst",
                                        start_date=(TODAY - timedelta(days=40)).isoformat(), deleted_at=""))
        # Hana is HR for both companies, but her People access is company A only.
        db.add(models.NexusAccessScope(id="sc-hana", email=HRC, module_id="hr", scope_type="entity", scope_id=CO_A))
        db.add(models.NexusRole(email=GA, role="owner", assigned_by="test"))
        db.commit()
        auth.invalidate_role_cache()
        self.emp = self._person(EMP)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()
        self.db.close()

    def _person(self, email):
        return self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()

    def _ctx(self, user, subject) -> RunContext:
        return RunContext(db=self.db, workflow=SimpleNamespace(id="wf-p", name="New Hire Setup"),
                          entity=catalog.ENTITIES["employee"], subject=subject, payload={},
                          run_as=user, today=TODAY)

    def _refusal(self, user, subject, field, value) -> str:
        """The reason the action refuses: at save time (allowed) and, for the
        same value, when the step runs (run raises ValueError)."""
        params = {"field": field, "value": value}
        why = self.act.allowed(self._ctx(user, subject), params)
        self.assertTrue(why, f"{field}={value!r} was not refused")
        with self.assertRaises(ValueError) as cm:
            self.act.run(self._ctx(user, subject), params)
        return why + " | " + str(cm.exception)

    def _audits(self):
        return (self.db.query(models.AuditLog)
                .filter(models.AuditLog.action == "Changed employee fields",
                        models.AuditLog.resource_id == self.emp.id).all())

    # ── registry ──
    def test_registered_with_the_allowed_fields_only(self):
        self.assertEqual(self.act.label, "Set A Person Detail")
        self.assertTrue(self.act.needs_person)
        offered = {o["value"] for o in self.act.param("field").options}
        self.assertEqual(offered, {"department", "job_title", "manager_email", "backup_manager_email",
                                   "location", "employment_type", "status"})
        self.assertEqual(self.act.param("value").type, "template")
        self.assertEqual(self.act.param("value").max, 200)

    # ── permission ──
    def test_non_hr_owner_is_refused(self):
        params = {"field": "job_title", "value": "Lead"}
        self.assertIn("Erin Test is not HR for Max Test", self.act.allowed(self._ctx(EMP_USER, self._person(MGR)), params))
        self.assertEqual(self.act.allowed(self._ctx(HRC_USER, self.emp), params), "")

    def test_person_outside_the_owners_people_access_is_refused(self):
        far = self._person(FAR)
        why = self.act.allowed(self._ctx(HRC_USER, far), {"field": "job_title", "value": "Lead"})
        self.assertIn("Farid Test is outside Hana Test's People access", why)
        with self.assertRaises(ValueError) as cm:   # the shared save's own wall holds too
            self.act.run(self._ctx(HRC_USER, far), {"field": "job_title", "value": "Lead"})
        self.assertIn("Employee not found", str(cm.exception))
        self.db.refresh(far)
        self.assertEqual(far.job_title, "Analyst")

    # ── value checks ──
    def test_bad_department_is_refused(self):
        self.assertIn("Marketing is not a department", self._refusal(HRC_USER, self.emp, "department", "Marketing"))

    def test_offboarded_points_to_offboard(self):
        why = self._refusal(HRC_USER, self.emp, "status", "offboarded")
        self.assertIn("use Offboard in People", why)
        self.assertIn("is not a status", self._refusal(HRC_USER, self.emp, "status", "staged"))

    def test_bad_employment_type_is_refused(self):
        self.assertIn("is not an employment type", self._refusal(HRC_USER, self.emp, "employment_type", "seasonal"))

    def test_self_as_manager_is_refused(self):
        self.assertIn("Erin Test cannot be their own manager", self._refusal(HRC_USER, self.emp, "manager_email", EMP))

    def test_manager_outside_the_wall_or_not_active_is_refused(self):
        why = self._refusal(HRC_USER, self.emp, "manager_email", FAR)
        self.assertIn("Farid Test is outside Hana Test's People access", why)
        self.assertIn("is not an active person", self._refusal(HRC_USER, self.emp, "manager_email", LEFT))
        self.assertIn("is not an active person",
                      self._refusal(HRC_USER, self.emp, "backup_manager_email", "nobody@greensglobal.com"))
        # A Super Administrator's reach is every company.
        self.assertEqual(self.act.allowed(self._ctx(GA_USER, self.emp), {"field": "manager_email", "value": FAR}), "")

    def test_blank_clears_only_the_optional_fields(self):
        for field in ("department", "manager_email", "employment_type", "status"):
            self.assertIn("cannot be blank", self._refusal(HRC_USER, self.emp, field, "  "), field)
        out = self.act.run(self._ctx(HRC_USER, self.emp), {"field": "job_title", "value": ""})
        self.assertEqual(out["line"], "Set Job Title to blank on Erin Test")
        self.db.refresh(self.emp)
        self.assertEqual(self.emp.job_title, "")

    # ── the write ──
    def test_set_writes_the_field_and_one_masked_audit_row(self):
        params = {"field": "manager_email", "value": NEW.upper()}
        self.assertEqual(self.act.allowed(self._ctx(HRC_USER, self.emp), params), "")
        out = self.act.run(self._ctx(HRC_USER, self.emp), params)
        self.assertEqual(out["line"], "Set Manager to Nora Test on Erin Test")
        self.assertEqual(out["affected"], [{"entity": "employee", "id": self.emp.id, "label": "Erin Test"}])
        self.db.refresh(self.emp)
        self.assertEqual(self.emp.manager_email, NEW)
        rows = self._audits()
        self.assertEqual(len(rows), 1)
        details = json.loads(rows[0].details)
        self.assertEqual(rows[0].user_email, HRC)
        self.assertEqual(details["source"], "Workflow: New Hire Setup")
        self.assertEqual(details["changes"], {"manager_email": [MGR, NEW]})
        events = (self.db.query(models.WorkflowEvent)
                  .filter(models.WorkflowEvent.key == "employee.field_changed").all())
        self.assertEqual(len(events), 1)

    def test_department_status_and_type_store_their_keys(self):
        for field, value, line in (("department", "finance", "Set Department to Finance on Erin Test"),
                                   ("status", "Inactive", "Set Status to Inactive on Erin Test"),
                                   ("employment_type", "Part Time", "Set Employment Type to Part Time on Erin Test")):
            out = self.act.run(self._ctx(HRC_USER, self.emp), {"field": field, "value": value})
            self.assertEqual(out["line"], line)
        self.db.refresh(self.emp)
        self.assertEqual((self.emp.department, self.emp.status, self.emp.employment_type),
                         ("Finance", "inactive", "part_time"))

    def test_second_run_changes_nothing(self):
        params = {"field": "location", "value": "Austin"}
        self.act.run(self._ctx(HRC_USER, self.emp), params)
        out = self.act.run(self._ctx(HRC_USER, self.emp), params)
        self.assertEqual(out["line"], "Location is already Austin on Erin Test - nothing changed")
        self.assertEqual(out["affected"], [])
        self.assertEqual(len(self._audits()), 1)
        out = self.act.run(self._ctx(HRC_USER, self.emp), {"field": "manager_email", "value": MGR})
        self.assertEqual(out["line"], "Manager is already Max Test on Erin Test - nothing changed")

    def test_value_template_is_filled_in(self):
        out = self.act.run(self._ctx(HRC_USER, self.emp),
                           {"field": "job_title", "value": "Lead {{ subject.department }}"})
        self.assertEqual(out["line"], "Set Job Title to Lead Operations on Erin Test")

    # ── the dry run ──
    def test_plan_line(self):
        ctx = self._ctx(HRC_USER, self.emp)
        self.assertEqual(self.act.plan(ctx, {"field": "department", "value": "Finance"}),
                         "Would set Department to Finance on Erin Test")
        self.assertEqual(self.act.plan(ctx, {"field": "manager_email", "value": NEW}),
                         "Would set Manager to Nora Test on Erin Test")
        self.db.refresh(self.emp)
        self.assertEqual(self.emp.department, "Operations")   # a plan writes nothing


if __name__ == "__main__":
    unittest.main()
