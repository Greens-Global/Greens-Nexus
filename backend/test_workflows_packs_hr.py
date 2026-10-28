"""Workflows (Oct 28 2026) - Task 9: the HR pack (workflows/packs/hr.py).

  * every HR event has a sample that validates against its entity's fields
    (every key is a registered field of the right type) and renders;
  * each emit site writes exactly ONE outbox row when the module's own
    function is driven - People > Add, the pipeline, probation, time off
    (request / manager decision / HR decision / cancel), HR letters, salary
    advances, headcount, a completed life event, Extra Time, custom fields;
  * sync_catalog registers the HR custom fields with their own visibility;
  * each action's plan is a sentence; run performs the module's write under
    a permitted run-as user and leaves "Workflow: <name>" in the record's
    history; a non-HR user is refused with a readable reason;
  * the list sources return the expected people, scoped to the company.

    cd backend && python -m pytest test_workflows_packs_hr.py -q
"""
import json
import os
import re
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import hr_letters  # noqa: E402
import hr_life_events  # noqa: E402
import hr_probation  # noqa: E402
import hr_custom_fields  # noqa: E402
import india_contractor_pay as icp  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from routers import hr as hr_router  # noqa: E402
from workflows import catalog  # noqa: E402
from workflows.context import RunContext, render  # noqa: E402
from workflows.packs import hr as pack  # noqa: E402

EMP = "erin.wfhr@greensglobal.com"      # Erin, reports to Max
MGR = "max.wfhr@greensglobal.com"       # a manager (role row)
HRC = "hana.wfhr@greensglobal.com"      # the company's HR contact (no role row)
GA = "gail.wfhr@greensglobal.com"       # a Global Admin (owner)
CON = "con.wfhr@greensglobal.com"       # an India contractor (Extra Time)
OTHER = "omar.wfhr@greensglobal.com"    # someone in another company
ENTITY, ENTITY_IN, ENTITY_2 = "ent-wfhr", "ent-wfhr-in", "ent-wfhr-2"
TODAY = date.today()
SOON = (TODAY + timedelta(days=10)).isoformat()
SAT = "2026-09-05"                       # a Saturday in the policy's first month
GA_USER = {"email": GA, "role": "owner", "level": 5}
HRC_USER = {"email": HRC, "role": "employee", "level": 1}
MGR_USER = {"email": MGR, "role": "manager", "level": 3}
EMP_USER = {"email": EMP, "role": "employee", "level": 1}
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


class HrPackCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
        models.Base.metadata.create_all(bind=database.engine)
        catalog.load_packs()
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        auth.invalidate_role_cache()
        db = self.db = database.SessionLocal()
        for m in (models.WorkflowEvent, models.NexusEmployee, models.NexusRole, models.HrEntity,
                  models.TimeOffRequest, models.HrCandidate, models.HrStageEvent, models.HrLetterRequest,
                  models.SalaryAdvance, models.SalaryAdvanceInstallment, models.HrHeadcountRequest,
                  models.HrJobOpening, models.ExtraTimeClaim, models.HrLifeEvent, models.HrSignRequest,
                  models.NexusNotification, models.AuditLog, models.EmployeeCustomField, models.HrChecklist,
                  models.HrChecklistItem, models.HrChecklistTemplate, models.Task, models.TimePunch,
                  models.PayrollRate, models.NexusSetting, models.HrRemovedIdentity):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=ENTITY, name="Greens Test", country="US", hr_contact_email=HRC))
        db.add(models.HrEntity(id=ENTITY_IN, name="Greens India", country="IN", hr_contact_email=HRC))
        db.add(models.HrEntity(id=ENTITY_2, name="Greens Other", country="US", hr_contact_email=""))
        people = ((EMP, "Erin", MGR, ENTITY, "full_time", "US"), (MGR, "Max", "", ENTITY, "full_time", "US"),
                  (HRC, "Hana", "", ENTITY, "full_time", "US"), (GA, "Gail", "", ENTITY, "full_time", "US"),
                  (CON, "Priya", HRC, ENTITY_IN, "contractor", "IN"), (OTHER, "Omar", "", ENTITY_2, "full_time", "US"))
        for em, first, mgr, co, kind, country in people:
            db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                        manager_email=mgr, status="active", company=co, employment_type=kind,
                                        country=country, start_date=(TODAY - timedelta(days=5)).isoformat(),
                                        deleted_at=""))
        db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        db.add(models.NexusRole(email=GA, role="owner", assigned_by="test"))
        db.commit()
        auth.invalidate_role_cache()
        self.emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == EMP).first()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()
        self.db.close()

    # ── helpers ──
    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        auth.invalidate_role_cache()

    def _events(self, key: str) -> list:
        self.db.expire_all()
        return (self.db.query(models.WorkflowEvent).filter(models.WorkflowEvent.key == key)
                .order_by(models.WorkflowEvent.at.asc()).all())

    def _one(self, key: str) -> models.WorkflowEvent:
        rows = self._events(key)
        self.assertEqual(len(rows), 1, f"{key}: {len(rows)} outbox rows")
        return rows[0]

    def _clear_events(self):
        self.db.query(models.WorkflowEvent).delete()
        self.db.commit()

    def _ctx(self, user, subject=None, entity="employee", payload=None) -> RunContext:
        return RunContext(db=self.db, workflow=SimpleNamespace(id="wf-1", name="Welcome Aboard"),
                          entity=catalog.ENTITIES[entity], subject=subject, payload=payload or {},
                          run_as=user, today=TODAY)

    # ── the registry ──
    def test_hr_entities_events_actions_and_lists_are_registered(self):
        for key in ("candidate", "time_off_request", "letter_request", "salary_advance", "headcount_request",
                    "extra_time_claim", "life_event"):
            self.assertIn(key, catalog.ENTITIES)
            self.assertEqual(catalog.ENTITIES[key].module, "hr")
        emp = catalog.ENTITIES["employee"]
        for key in ("probation.status", "probation.end", "contract_end", "pay.base"):
            self.assertIsNotNone(emp.field(key), key)
        self.assertEqual(emp.field("pay.base").visibility, "comp")
        self.assertTrue({"probation.end", "contract_end"} <= {d.key for d in emp.dates})
        self.assertEqual({"self", "manager", "hr_contact", "approver"}, set(catalog.ENTITIES["time_off_request"].people))
        expected = {"employee.hired", "employee.custom_field_changed", "probation.started", "probation.decided",
                    "time_off.requested", "time_off.decided", "time_off.cancelled", "letter.requested",
                    "letter.decided", "salary_advance.requested", "salary_advance.decided", "headcount.requested",
                    "headcount.decided", "candidate.stage_changed", "candidate.hired", "life_event.completed",
                    "extra_time.claimed", "extra_time.decided"}
        self.assertTrue(expected <= set(catalog.EVENTS), expected - set(catalog.EVENTS))
        self.assertTrue({"hr.start_checklist", "hr.create_letter_request", "hr.set_custom_field", "hr.add_note"}
                        <= set(catalog.ACTIONS))
        self.assertTrue({"employees.probation_ending", "employees.contract_ending", "employees.started_within",
                         "timeoff.pending_older_than"} <= set(catalog.LIST_SOURCES))
        json.dumps(catalog.snapshot())    # deterministic, no callables

    def test_every_hr_event_sample_validates_against_its_entity(self):
        checked = 0
        for key, ev in catalog.EVENTS.items():
            if ev.module != "hr" or not ev.sample:
                continue
            checked += 1
            ent = catalog.ENTITIES[ev.entity]
            payload = catalog.sample_payload(ev)
            self.assertTrue(payload["subject"], key)
            for fkey, value in payload["subject"].items():
                f = ent.field(fkey)
                self.assertIsNotNone(f, f"{key}: sample key {fkey!r} is not a field of {ev.entity}")
                self._check_value(key, f, value)
            for ckey, change in payload["changes"].items():
                self.assertTrue(ckey.startswith("custom.") or ent.field(ckey) is not None, f"{key}: change {ckey}")
                self.assertEqual(set(change), {"from", "to"}, f"{key}: change {ckey}")
            for c in ev.changes:
                self.assertIsNotNone(ent.field(c), f"{key}: declared change {c!r}")
            ctx = RunContext(db=self.db, entity=ent, subject=None, payload=payload, run_as=GA_USER, today=TODAY)
            text, missing = render("{{ subject.name }} / {{ subject }} / {{ actor.email }}", ctx)
            self.assertEqual(missing, [], f"{key}: {missing}")
            self.assertTrue(text.strip("/ "), key)
        self.assertGreaterEqual(checked, 18)

    def _check_value(self, key, f, value):
        where = f"{key}.{f.key}"
        if value is None or value == "":
            return
        if f.type == "date":
            self.assertRegex(str(value), _ISO_DATE, where)
        elif f.type == "datetime":
            self.assertIn("T", str(value), where)
        elif f.type in ("number", "money"):
            self.assertIsInstance(value, (int, float), where)
            self.assertNotIsInstance(value, bool, where)
        elif f.type == "bool":
            self.assertIsInstance(value, bool, where)
        elif f.type in ("person", "people"):
            vals = value if isinstance(value, list) else [value]
            for v in vals:
                self.assertIn("@", v, where)
        elif f.type == "select" and isinstance(f.options, list):
            allowed = {o[0] if isinstance(o, (list, tuple)) else (o.get("value") if isinstance(o, dict) else o)
                       for o in f.options}
            self.assertIn(value, allowed, where)
        else:
            self.assertIsInstance(value, str, where)

    def test_sync_catalog_registers_custom_fields_with_their_own_visibility(self):
        self.db.add(models.EmployeeCustomField(id="cf-shirt", field_key="shirt_size", label="Shirt Size",
                                               field_type="dropdown", options=["S", "M", "L"], visibility="hr_only"))
        self.db.add(models.EmployeeCustomField(id="cf-nick", field_key="nickname", label="Nickname",
                                               field_type="text", visibility="employee_edit"))
        self.db.add(models.EmployeeCustomField(id="cf-cert", field_key="cert_due", label="Certification Due",
                                               field_type="date", visibility="employee_view"))
        self.db.commit()
        self.assertGreaterEqual(pack.sync_catalog(self.db), 3)
        emp = catalog.ENTITIES["employee"]
        self.assertEqual(emp.field("custom.shirt_size").visibility, "hr")
        self.assertEqual(emp.field("custom.shirt_size").type, "select")
        self.assertEqual(emp.field("custom.nickname").visibility, "all")
        self.assertIn("custom.cert_due", {d.key for d in emp.dates})
        self.assertEqual({o["value"] for o in pack.CUSTOM_FIELD_OPTIONS}, {"shirt_size", "nickname", "cert_due"})
        cat = catalog.serialize(self.db, EMP_USER)
        keys = {f["key"] for f in next(e for e in cat["entities"] if e["key"] == "employee")["fields"]}
        self.assertIn("custom.nickname", keys)
        self.assertNotIn("custom.shirt_size", keys)
        self.assertEqual(pack.sync_catalog(self.db), pack.sync_catalog(self.db))   # idempotent

    # ── emit sites ──
    def test_people_add_emits_hired_and_probation_started(self):
        self._as(GA)
        res = self.client.post("/hr/employees", json={
            "first_name": "Nia", "last_name": "New", "work_email": "nia.wfhr@greensglobal.com", "company": ENTITY,
            "employment_type": "full_time", "start_date": TODAY.isoformat(), "status": "onboarding"})
        self.assertEqual(res.status_code, 200, res.text)
        hired = self._one("employee.hired")
        self.assertEqual(hired.payload["extra"]["how"], "people")
        self.assertEqual(hired.payload["subject"]["work_email"], "nia.wfhr@greensglobal.com")
        self.assertEqual(hired.company_id, ENTITY)
        started = self._one("probation.started")
        self.assertEqual(started.payload["changes"]["probation.status"]["to"], "in_probation")
        self.assertEqual(started.payload["subject"]["probation.status"], "in_probation")
        self.assertTrue(started.payload["extra"]["endDate"])

    def test_probation_decision_emits_decided(self):
        hr_probation.start_tracking(self.db, self.emp, GA)
        self.db.commit()
        self._clear_events()
        out = hr_probation.decide(self.db, GA_USER, self.emp, "end", reason="Not the right fit")
        self.assertTrue(out["applied"])
        row = self._one("probation.decided")
        self.assertEqual(row.payload["changes"]["probation.status"], {"from": "in_probation", "to": "ended"})
        self.assertEqual(row.payload["extra"]["decision"], "end")
        self.assertEqual(row.actor, GA)

    def test_time_off_request_manager_decision_and_cancel_each_emit_once(self):
        self._as(EMP)
        res = self.client.post("/timeclock/timeoff", json={"type": "vacation", "start_date": SOON,
                                                           "end_date": (TODAY + timedelta(days=12)).isoformat(),
                                                           "note": "Family trip"})
        self.assertEqual(res.status_code, 200, res.text)
        rid = res.json()["id"]
        req = self._one("time_off.requested")
        self.assertEqual(req.entity, "time_off_request")
        self.assertEqual(req.subject_id, rid)
        self.assertEqual(req.company_id, ENTITY)
        self.assertEqual(req.payload["subject"]["days"], 3)
        self.assertEqual(req.payload["subject"]["employee"], EMP)
        self.assertIn("Erin Test - Vacation", req.payload["subjectLabel"])
        self._as(MGR)
        res = self.client.patch(f"/timeclock/timeoff/{rid}", json={"status": "approved", "note": "Enjoy"})
        self.assertEqual(res.status_code, 200, res.text)
        dec = self._one("time_off.decided")
        self.assertEqual(dec.payload["changes"]["status"], {"from": "pending", "to": "approved"})
        self.assertEqual(dec.payload["extra"]["level"], "manager")
        self.assertEqual(dec.actor, MGR)
        self._as(EMP)
        res = self.client.post(f"/timeclock/timeoff/{rid}/cancel")
        self.assertEqual(res.status_code, 200, res.text)
        can = self._one("time_off.cancelled")
        self.assertEqual(can.payload["changes"]["status"], {"from": "approved", "to": "cancelled"})
        self.assertTrue(can.payload["extra"]["wasApproved"])
        self.assertEqual(len(self._events("time_off.requested")), 1)

    def test_time_off_hr_level_decision_emits_decided_with_level_hr(self):
        self.db.add(models.TimeOffRequest(id="to-hr", employee_email=EMP, type="vacation", start_date=SOON,
                                          end_date=SOON, status="pending", approval_stage="hr", first_approver=MGR,
                                          created_at=_iso(1)))
        self.db.commit()
        self._as(HRC)
        res = self.client.post("/timeclock/timeoff/to-hr/hr-decision", json={"status": "rejected", "note": "Busy week"})
        self.assertEqual(res.status_code, 200, res.text)
        dec = self._one("time_off.decided")
        self.assertEqual(dec.payload["changes"]["status"], {"from": "pending", "to": "rejected"})
        self.assertEqual(dec.payload["extra"], {"decision": "rejected", "note": "Busy week", "level": "hr"})
        self.assertEqual(dec.actor, HRC)

    def test_letter_request_and_decline_each_emit_once(self):
        req = hr_letters.create(self.db, self.emp, {"letter_type": "employment_verification",
                                                    "purpose": "Apartment lease"})
        self.db.commit()
        row = self._one("letter.requested")
        self.assertEqual(row.subject_id, req.id)
        self.assertEqual(row.payload["subject"]["letter_type"], "employment_verification")
        self.assertEqual(row.payload["subject"]["employee"], EMP)
        self.assertEqual(row.company_id, ENTITY)
        hr_letters.decline(self.db, req, GA_USER, "The lease letter comes from the landlord.")
        self.db.commit()
        dec = self._one("letter.decided")
        self.assertEqual(dec.payload["changes"]["status"], {"from": "requested", "to": "declined"})
        self.assertEqual(dec.payload["extra"]["decision"], "declined")

    def test_salary_advance_request_and_decision_each_emit_once(self):
        self._as(MGR)
        res = self.client.post("/salary-advances", json={"amount": 500, "currency": "USD", "reason": "Moving costs",
                                                         "installments": 2})
        self.assertEqual(res.status_code, 201, res.text)
        aid = res.json()["id"]
        req = self._one("salary_advance.requested")
        self.assertEqual(req.subject_id, aid)
        self.assertEqual(req.payload["subject"]["amount"], 500)
        self.assertEqual(req.payload["subject"]["employee"], MGR)
        self._as(GA)
        res = self.client.post(f"/salary-advances/{aid}/decide", json={"action": "approve", "note": "Approved"})
        self.assertEqual(res.status_code, 200, res.text)
        dec = self._one("salary_advance.decided")
        self.assertEqual(dec.payload["changes"]["status"], {"from": "requested", "to": "approved"})
        self.assertEqual(dec.payload["extra"]["decision"], "approve")
        self.assertEqual(dec.actor, GA)

    def test_headcount_submit_and_decision_each_emit_once(self):
        self._as(GA)
        res = self.client.post("/hiring/headcount", json={
            "company": ENTITY, "department": "Operations", "role_title": "Site Supervisor",
            "employment_type": "full_time", "openings": 1, "justification": "A second shift opens in January.",
            "submit": True})
        self.assertEqual(res.status_code, 200, res.text)
        rid = res.json()["id"]
        req = self._one("headcount.requested")
        self.assertEqual(req.subject_id, rid)
        self.assertEqual(req.payload["changes"]["status"], {"from": "draft", "to": "awaiting_approval"})
        self.assertEqual(req.payload["extra"]["step"], "hr")
        self.assertEqual(req.payload["subject"]["role_title"], "Site Supervisor")
        self._as(HRC)
        res = self.client.post(f"/hiring/headcount/{rid}/decide", json={"decision": "decline", "note": "Not this quarter"})
        self.assertEqual(res.status_code, 200, res.text)
        dec = self._one("headcount.decided")
        self.assertEqual(dec.payload["changes"]["status"], {"from": "awaiting_approval", "to": "declined"})
        self.assertEqual(dec.payload["extra"], {"decision": "decline", "step": "hr", "note": "Not this quarter"})

    def test_candidate_stage_move_emits_stage_changed(self):
        self.db.add(models.HrCandidate(id="cand-1", first_name="Arjun", last_name="Mehta", stage="applied",
                                       company=ENTITY, role_title="Site Supervisor", created_by=HRC,
                                       created_at=_iso(2), updated_at=_iso(2)))
        self.db.commit()
        self._as(GA)
        res = self.client.patch("/hr/candidates/cand-1", json={"stage": "screening", "stage_note": "Good resume"})
        self.assertEqual(res.status_code, 200, res.text)
        row = self._one("candidate.stage_changed")
        self.assertEqual(row.payload["changes"]["stage"], {"from": "applied", "to": "screening"})
        self.assertEqual(row.payload["extra"]["note"], "Good resume")
        self.assertEqual(row.payload["subjectLabel"], "Arjun Mehta")
        self.assertEqual(row.company_id, ENTITY)

    def test_hiring_a_candidate_emits_candidate_hired_and_employee_hired(self):
        cand = models.HrCandidate(id="cand-2", first_name="Bea", last_name="Lund", email="bea@example.com",
                                  stage="offer", company=ENTITY, role_title="Site Supervisor", created_by=HRC,
                                  expected_start=SOON, created_at=_iso(2), updated_at=_iso(2))
        self.db.add(cand)
        self.db.commit()
        emp = hr_router.create_employee_from_candidate(self.db, cand, GA)
        cand.stage = "hired"
        self.db.commit()
        hired = self._one("candidate.hired")
        self.assertEqual(hired.subject_id, "cand-2")
        self.assertEqual(hired.payload["changes"]["stage"], {"from": "offer", "to": "hired"})
        self.assertEqual(hired.payload["extra"]["employeeId"], emp.id)
        person = self._one("employee.hired")
        self.assertEqual(person.subject_id, emp.id)
        self.assertEqual(person.payload["extra"], {"how": "candidate", "candidateId": "cand-2"})
        self.assertEqual(person.payload["subject"]["status"], "onboarding")
        self.assertEqual(len(self._events("probation.started")), 1)

    def test_status_change_emits_status_changed_with_reason(self):
        self._as(GA)
        res = self.client.post(f"/hr/employees/{self.emp.id}/status",
                               json={"status": "inactive", "reason": "Sabbatical", "effectiveDate": SOON})
        self.assertEqual(res.status_code, 200, res.text)
        row = self._one("employee.status_changed")
        self.assertEqual(row.payload["changes"]["status"], {"from": "active", "to": "inactive"})
        self.assertEqual(row.payload["extra"], {"reason": "Sabbatical", "effectiveDate": SOON})
        self.assertEqual(row.actor, GA)
        # The same status again is not a change - nothing more is written.
        res = self.client.post(f"/hr/employees/{self.emp.id}/status", json={"status": "inactive"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(len(self._events("employee.status_changed")), 1)

    def test_completed_life_event_emits_completed(self):
        self.db.add(models.HrLifeEvent(id="le-1", kind="separation", status="sent", entity_id=ENTITY,
                                       employee_id=self.emp.id, subject_name="Erin Test", subject_email=EMP,
                                       sign_request_id="sr-1", effective_date=SOON, created_by=HRC,
                                       created_at=_iso(3), updated_at=_iso(3)))
        self.db.add(models.HrSignRequest(id="sr-1", title="Separation - Erin Test", link_kind="life_event",
                                         link_id="le-1", status="completed", created_by=HRC, created_at=_iso(3)))
        self.db.commit()
        req = self.db.query(models.HrSignRequest).filter(models.HrSignRequest.id == "sr-1").first()
        hr_life_events.on_completed(self.db, req)
        self.db.commit()
        row = self._one("life_event.completed")
        self.assertEqual(row.subject_id, "le-1")
        self.assertEqual(row.payload["changes"]["status"], {"from": "sent", "to": "completed"})
        self.assertEqual(row.payload["extra"], {"kind": "separation", "employeeId": self.emp.id})
        self.assertEqual(row.payload["subjectLabel"], "Erin Test - Separation")
        self.assertEqual(row.company_id, ENTITY)

    def test_extra_time_claim_and_decision_each_emit_once(self):
        self.db.add(models.PayrollRate(employee_email=CON, pay_type="fixed", currency="INR", monthly_salary=58725.0,
                                       full_day_hours=9, overtime_rule="none"))
        self.db.add(models.NexusSetting(key=f"{icp.SETTING_KEY}:{ENTITY_IN}",
                                        value=json.dumps({"mode": "", "startDate": "2026-09-01"})))
        for i, kind, at in ((0, "in", f"{SAT}T04:00:00"), (1, "out", f"{SAT}T09:00:00")):
            self.db.add(models.TimePunch(id=f"p-{i}", employee_email=CON, kind=kind, at=at, local_date=SAT,
                                         tz_offset_min=0, voided=0, created_at=at))
        self.db.commit()
        self._as(CON)
        res = self.client.post("/extra-time/claims", json={"date": SAT, "minutes": 300,
                                                           "note": "Weekend deploy of the billing system"})
        self.assertEqual(res.status_code, 200, res.text)
        cid = res.json()["id"]
        claim = self._one("extra_time.claimed")
        self.assertEqual(claim.subject_id, cid)
        self.assertEqual(claim.payload["subject"]["claimed_min"], 300)
        self.assertEqual(claim.payload["subject"]["employee"], CON)
        self.assertEqual(claim.company_id, ENTITY_IN)
        self._as(GA)
        res = self.client.post(f"/extra-time/claims/{cid}/decide", json={"decision": "approve", "minutes": 240})
        self.assertEqual(res.status_code, 200, res.text)
        dec = self._one("extra_time.decided")
        self.assertEqual(dec.payload["changes"]["status"], {"from": "pending", "to": "approved"})
        self.assertEqual(dec.payload["extra"]["minutes"], 240)
        self.assertEqual(dec.payload["subject"]["approved_min"], 240)

    def test_custom_field_change_emits_one_event_per_field(self):
        self.db.add(models.EmployeeCustomField(id="cf-a", field_key="shirt_size", label="Shirt Size",
                                               field_type="dropdown", options=["S", "M", "L"], visibility="hr_only"))
        self.db.add(models.EmployeeCustomField(id="cf-b", field_key="nickname", label="Nickname",
                                               field_type="text", visibility="employee_edit"))
        self.db.commit()
        diff = hr_custom_fields.apply_changes(self.db, self.emp, {"shirt_size": "L", "nickname": "Ez"}, "hr", GA_USER)
        self.db.commit()
        self.assertEqual(set(diff), {"shirt_size", "nickname"})
        rows = self._events("employee.custom_field_changed")
        self.assertEqual(len(rows), 2)
        by_field = {r.payload["extra"]["field"]: r for r in rows}
        self.assertEqual(by_field["shirt_size"].payload["changes"], {"custom.shirt_size": {"from": None, "to": "L"}})
        self.assertEqual(by_field["shirt_size"].payload["extra"]["label"], "Shirt Size")
        self.assertEqual(by_field["nickname"].actor, GA)
        # A save that changes nothing writes nothing.
        hr_custom_fields.apply_changes(self.db, self.emp, {"nickname": "Ez"}, "hr", GA_USER)
        self.db.commit()
        self.assertEqual(len(self._events("employee.custom_field_changed")), 2)

    # ── actions ──
    def test_add_note_plan_run_and_refusal(self):
        act = catalog.ACTIONS["hr.add_note"]
        params = {"note": "Welcome {{ subject.name }} - starts {{ subject.start_date | us_date }}"}
        self.assertEqual(act.allowed(self._ctx(HRC_USER, self.emp), params), "")
        self.assertTrue(act.plan(self._ctx(HRC_USER, self.emp), params).startswith("Would add a note to Erin Test"))
        out = act.run(self._ctx(HRC_USER, self.emp), params)
        self.db.commit()
        self.db.refresh(self.emp)
        self.assertIn("Workflow: Welcome Aboard: Welcome Erin Test - starts", self.emp.notes)
        self.assertIn(f"{TODAY.month:02d}/{TODAY.day:02d}/{TODAY.year}", self.emp.notes)
        self.assertEqual(out["affected"][0], {"entity": "employee", "id": self.emp.id, "label": "Erin Test"})
        self.assertIn("Added a note", out["line"])
        log = self.db.query(models.AuditLog).filter(models.AuditLog.module == "hr",
                                                    models.AuditLog.resource_id == self.emp.id).all()
        self.assertEqual(len(log), 1)
        self.assertIn("Workflow: Welcome Aboard", log[0].action)
        self.assertEqual(json.loads(log[0].details)["workflow"], "Welcome Aboard")
        # Not HR for them: refused with a reason. The manager tier is not HR either.
        for user in (EMP_USER, MGR_USER):
            why = act.allowed(self._ctx(user, self.emp), params)
            self.assertIn("is not HR for Erin Test", why, user)
        # Nexus (no person) cannot do it.
        self.assertIn("needs a person", act.allowed(self._ctx(None, self.emp), params))
        # An administrator always may.
        self.assertEqual(act.allowed(self._ctx(GA_USER, self.emp), params), "")

    def test_actions_resolve_the_person_from_a_request_subject(self):
        row = models.TimeOffRequest(id="to-x", employee_email=EMP, type="sick", start_date=SOON, end_date=SOON,
                                    status="pending", created_at=_iso(1))
        self.db.add(row)
        self.db.commit()
        act = catalog.ACTIONS["hr.add_note"]
        ctx = self._ctx(HRC_USER, row, entity="time_off_request")
        self.assertEqual(act.allowed(ctx, {"note": "x"}), "")
        act.run(ctx, {"note": "Sick leave noted for {{ subject.start | us_date }}"})
        self.db.commit()
        self.db.refresh(self.emp)
        self.assertIn(f"Sick leave noted for {pack._us_date(SOON)}", self.emp.notes)

    def test_allowed_against_a_sample_needs_an_hr_person(self):
        act = catalog.ACTIONS["hr.add_note"]
        payload = catalog.sample_payload(catalog.EVENTS["employee.hired"])
        ok = act.allowed(self._ctx(HRC_USER, None, payload=payload), {"note": "x"})
        self.assertEqual(ok, "")
        why = act.allowed(self._ctx(EMP_USER, None, payload=payload), {"note": "x"})
        self.assertIn("is not HR", why)

    def test_set_custom_field_runs_through_apply_changes(self):
        self.db.add(models.EmployeeCustomField(id="cf-shirt", field_key="shirt_size", label="Shirt Size",
                                               field_type="dropdown", options=["S", "M", "L"], visibility="hr_only"))
        self.db.commit()
        act = catalog.ACTIONS["hr.set_custom_field"]
        params = {"field": "shirt_size", "value": "L"}
        self.assertEqual(act.allowed(self._ctx(HRC_USER, self.emp), params), "")
        self.assertIn("'nope' is not one of the HR custom fields",
                      act.allowed(self._ctx(HRC_USER, self.emp), {"field": "nope", "value": "x"}))
        self.assertIn("is not HR for Erin Test", act.allowed(self._ctx(EMP_USER, self.emp), params))
        self.assertEqual(act.plan(self._ctx(HRC_USER, self.emp), params), "Would set Shirt Size to L on Erin Test")
        out = act.run(self._ctx(HRC_USER, self.emp), params)
        self.db.commit()
        self.db.refresh(self.emp)
        self.assertEqual(self.emp.custom_fields["shirt_size"], "L")
        self.assertEqual(out["line"], "Set Shirt Size to L on Erin Test")
        self.assertEqual(self._one("employee.custom_field_changed").actor, HRC)
        actions = [a.action for a in self.db.query(models.AuditLog).filter(models.AuditLog.module == "hr").all()]
        self.assertTrue(any("Workflow: Welcome Aboard" in a for a in actions), actions)
        again = act.run(self._ctx(HRC_USER, self.emp), params)
        self.assertIn("nothing changed", again["line"])
        with self.assertRaises(ValueError):
            act.run(self._ctx(HRC_USER, self.emp), {"field": "shirt_size", "value": "XXL"})

    def test_create_letter_request_runs_through_hr_letters(self):
        act = catalog.ACTIONS["hr.create_letter_request"]
        params = {"template": "employment_verification", "note": "Lease for {{ subject.name }}"}
        self.assertEqual(act.allowed(self._ctx(HRC_USER, self.emp), params), "")
        self.assertIn("is not HR for Erin Test", act.allowed(self._ctx(EMP_USER, self.emp), params))
        self.assertEqual(act.plan(self._ctx(HRC_USER, self.emp), params),
                         "Would request a Employment Verification letter for Erin Test")
        out = act.run(self._ctx(HRC_USER, self.emp), params)
        self.db.commit()
        req = self.db.query(models.HrLetterRequest).filter(models.HrLetterRequest.employee_id == self.emp.id).one()
        self.assertEqual((req.letter_type, req.purpose, req.notes, req.status),
                         ("employment_verification", "Lease for Erin Test", "Workflow: Welcome Aboard", "requested"))
        self.assertEqual(out["affected"][1]["entity"], "letter_request")
        self.assertEqual(self._one("letter.requested").actor, EMP)
        again = act.run(self._ctx(HRC_USER, self.emp), params)
        self.assertIn("already has", again["line"])
        self.assertEqual(self.db.query(models.HrLetterRequest).count(), 1)

    def test_start_checklist_runs_through_hr_checklists(self):
        act = catalog.ACTIONS["hr.start_checklist"]
        params = {"template": "onboarding"}
        self.assertEqual(act.allowed(self._ctx(HRC_USER, self.emp), params), "")
        self.assertIn("is not HR for Erin Test", act.allowed(self._ctx(MGR_USER, self.emp), params))
        self.assertEqual(act.plan(self._ctx(HRC_USER, self.emp), params), "Would start the Onboarding checklist for Erin Test")
        out = act.run(self._ctx(HRC_USER, self.emp), params)
        self.db.commit()
        cl = self.db.query(models.HrChecklist).filter(models.HrChecklist.employee_id == self.emp.id).one()
        self.assertEqual((cl.kind, cl.status, cl.created_by), ("onboarding", "open", HRC))
        self.assertGreater(self.db.query(models.HrChecklistItem).filter(models.HrChecklistItem.checklist_id == cl.id).count(), 0)
        self.assertEqual(out["affected"][1], {"entity": "hr_checklist", "id": cl.id, "label": "Onboarding - Erin Test"})
        self.assertTrue(any("Started the Onboarding checklist (Workflow: Welcome Aboard)" in a.action
                            for a in self.db.query(models.AuditLog).filter(models.AuditLog.module == "hr").all()))
        again = act.run(self._ctx(HRC_USER, self.emp), params)
        self.assertIn("already has an open Onboarding checklist", again["line"])
        # The company's own template is a choice too, by id, after a sync.
        pack.sync_catalog(self.db)
        tpl = self.db.query(models.HrChecklistTemplate).filter(models.HrChecklistTemplate.kind == "onboarding").first()
        self.assertIn(tpl.id, {o["value"] for o in pack.CHECKLIST_OPTIONS})
        self.assertEqual(act.plan(self._ctx(HRC_USER, self.emp), {"template": "nope"}), "Pick the checklist to start")

    # ── list sources ──
    def test_list_sources_return_the_expected_people_scoped_to_the_company(self):
        self.emp.probation = {"status": "in_probation", "endDate": (TODAY + timedelta(days=10)).isoformat()}
        mgr = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == MGR).first()
        mgr.probation = {"status": "confirmed", "endDate": (TODAY + timedelta(days=5)).isoformat()}
        other = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == OTHER).first()
        other.probation = {"status": "extended", "endDate": (TODAY + timedelta(days=3)).isoformat()}
        con = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == CON).first()
        con.contractor = {"contract_end": (TODAY + timedelta(days=20)).isoformat()}
        mgr.start_date = (TODAY - timedelta(days=90)).isoformat()
        self.db.add(models.TimeOffRequest(id="to-old", employee_email=EMP, type="vacation", start_date=SOON,
                                          end_date=SOON, status="pending", created_at=_iso(6)))
        self.db.add(models.TimeOffRequest(id="to-new", employee_email=EMP, type="sick", start_date=SOON,
                                          end_date=SOON, status="pending", created_at=_iso(1)))
        self.db.add(models.TimeOffRequest(id="to-other", employee_email=OTHER, type="sick", start_date=SOON,
                                          end_date=SOON, status="pending", created_at=_iso(9)))
        self.db.commit()
        src = catalog.LIST_SOURCES
        every = self._ctx(GA_USER)
        self.assertEqual([e.work_email for e in src["employees.probation_ending"].fn(self.db, every, {"days": 14})],
                         [OTHER, EMP])
        self.assertEqual([e.work_email for e in src["employees.probation_ending"].fn(self.db, every, {"days": 5})],
                         [OTHER])
        self.assertEqual([e.work_email for e in src["employees.contract_ending"].fn(self.db, every, {"days": 30})], [CON])
        self.assertEqual(src["employees.contract_ending"].fn(self.db, every, {"days": 10}), [])
        started = {e.work_email for e in src["employees.started_within"].fn(self.db, every, {"days": 7})}
        self.assertEqual(started, {EMP, HRC, GA, CON, OTHER})
        self.assertEqual([r.id for r in src["timeoff.pending_older_than"].fn(self.db, every, {"days": 3})],
                         ["to-other", "to-old"])
        one = self._ctx(GA_USER)
        one.company_id = ENTITY
        self.assertEqual([e.work_email for e in src["employees.probation_ending"].fn(self.db, one, {"days": 14})], [EMP])
        self.assertEqual([r.id for r in src["timeoff.pending_older_than"].fn(self.db, one, {"days": 3})], ["to-old"])
        self.assertEqual(src["employees.contract_ending"].fn(self.db, one, {"days": 30}), [])
        self.assertEqual({e.work_email for e in src["employees.started_within"].fn(self.db, one, {})},
                         {EMP, HRC, GA})


if __name__ == "__main__":
    unittest.main()
