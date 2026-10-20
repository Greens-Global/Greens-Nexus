"""Onboarding / offboarding / leave checklists (HR roadmap Section C).

Covers: due dates (business days skip weekends and company holidays, calendar
dates on a weekend move back, a past date is due the day the list starts),
which rows apply to whom (US / India / contractor, exit type), owners resolved
per person, the hire hook, completion signals, a start date that moves, the
owner-only permissions, company scope, and the daily reminder that is one bell
per checklist per owner, updated in place.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_hr_checklists.py -q
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import hr_checklists as hc  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

HR = "hr.checklist.test@greensglobal.com"            # hr:editor, every company
SCOPED = "scoped.checklist.test@greensglobal.com"    # hr:editor, company B only
MANAGER = "mgr.checklist.test@greensglobal.com"      # no hr grant
IT = "it.checklist.test@greensglobal.com"            # no hr grant
HRC = "contact.checklist.test@greensglobal.com"      # company A's HR contact
NEWBIE = "new.hire.test@greensglobal.com"
CO_A, CO_B, CO_IN = "co-a-checklist", "co-b-checklist", "co-in-checklist"
GROUP = "grp-checklist-test"


def _as(email):
    os.environ["NEXUS_DEV_EMAIL"] = email


def _wipe(db):
    for m in (models.HrChecklistItem, models.HrChecklist, models.HrChecklistTemplate,
              models.NexusNotification, models.HrProvisionRun, models.HrCandidate,
              models.HrCompanyHoliday, models.NexusAccessScope, models.NexusGroupMember,
              models.NexusGroup, models.HrEntity, models.NexusSetting, models.HrStageEvent,
              models.HrDepartment, models.Task):
        db.query(m).delete(synchronize_session=False)
    db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
    db.commit()


class DueDateTests(unittest.TestCase):
    def test_business_days_skip_weekend_and_holidays(self):
        # Thursday 11/05/2026 + 3 business days = Tuesday 11/10/2026.
        self.assertEqual(hc.due_for("2026-11-05", "2026-10-01", "S", 3, True, set()), "2026-11-10")
        # A holiday on Monday 11/09 pushes it to Wednesday.
        self.assertEqual(hc.due_for("2026-11-05", "2026-10-01", "S", 3, True, {"2026-11-09"}), "2026-11-11")

    def test_calendar_date_on_weekend_moves_back(self):
        # Monday 11/09/2026 - 2 days = Saturday -> Friday 11/06.
        self.assertEqual(hc.due_for("2026-11-09", "2026-10-01", "S", -2, False, set()), "2026-11-06")

    def test_past_date_is_due_the_day_the_list_started(self):
        self.assertEqual(hc.due_for("2026-10-05", "2026-10-02", "S", -21, False, set()), "2026-10-02")

    def test_no_anchor_means_no_date(self):
        self.assertEqual(hc.due_for("", "2026-10-02", "S", 3, False, set()), "")
        self.assertEqual(hc.due_for("2026-10-05", "2026-10-02", "none", 0, False, set()), "")


class ChecklistTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        db = database.SessionLocal()
        try:
            _wipe(db)
            db.add(models.HrEntity(id=CO_A, name="Greens", country="US", hr_contact_email=HRC))
            db.add(models.HrEntity(id=CO_B, name="MCD", country="US"))
            db.add(models.HrEntity(id=CO_IN, name="Greens India", country="IN"))
            db.add(models.NexusGroup(id=GROUP, name="Checklist HR", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=HR))
            db.add(models.NexusGroupMember(group_id=GROUP, email=SCOPED))
            db.add(models.NexusAccessScope(id="scope-checklist", email=SCOPED, module_id="hr",
                                           scope_type="entity", scope_id=CO_B))
            for i, em in enumerate((HR, SCOPED, MANAGER, IT, HRC)):
                db.add(models.NexusEmployee(id=f"staff-{i}", first_name="Staff", last_name=str(i),
                                            work_email=em, status="active", company=CO_A, deleted_at=""))
            db.add(models.NexusSetting(key=hc.OWNERS_KEY, value='{"it": "%s"}' % IT))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        _as(HR)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _person(self, eid="emp-new", company=CO_A, etype="full_time", start=None, work_email=""):
        start = start or (date.today() + timedelta(days=30)).isoformat()
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id=eid, first_name="Jane", last_name="Doe", company=company,
                                        employment_type=etype, start_date=start, status="onboarding",
                                        manager_email=MANAGER, work_email=work_email,
                                        personal_email="jane@example.com", deleted_at=""))
            db.commit()
        finally:
            db.close()
        return eid

    def _start(self, eid, kind="onboarding", **extra):
        r = self.client.post(f"/hr/checklists/employee/{eid}", json={"kind": kind, **extra})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def _row(self, cl, key):
        return next(i for i in cl["items"] if i["key"] == key)

    def test_us_employee_rows_and_owners(self):
        cl = self._start(self._person())
        keys = {i["key"] for i in cl["items"]}
        self.assertIn("ON-18", keys)            # I-9 for a US employee
        self.assertNotIn("ON-26", keys)         # PF / ESI is India only
        self.assertNotIn("ON-06", keys)         # W-9 / PAN is contractors only
        self.assertEqual(self._row(cl, "ON-09")["ownerEmail"], MANAGER)
        self.assertEqual(self._row(cl, "ON-20")["ownerEmail"], HRC)    # company HR contact
        self.assertEqual(self._row(cl, "ON-12")["ownerEmail"], IT)     # default role owner
        self.assertEqual(self._row(cl, "ON-19")["ownerEmail"], "")     # employee row: no work email yet

    def test_contractor_and_india_rows(self):
        c = self._start(self._person("emp-c", etype="contractor"))
        ck = {i["key"] for i in c["items"]}
        self.assertIn("ON-06", ck)
        self.assertNotIn("ON-18", ck)
        ind = self._start(self._person("emp-in", company=CO_IN))
        ik = {i["key"] for i in ind["items"]}
        self.assertIn("ON-26", ik)
        self.assertNotIn("ON-18", ik)

    def test_only_one_open_checklist_per_kind(self):
        eid = self._person()
        self._start(eid)
        r = self.client.post(f"/hr/checklists/employee/{eid}", json={"kind": "onboarding"})
        self.assertEqual(r.status_code, 400)

    def test_offboarding_needs_exit_type_and_death_skips_rows(self):
        eid = self._person(work_email=NEWBIE)
        x = (date.today() + timedelta(days=14)).isoformat()
        r = self.client.post(f"/hr/checklists/employee/{eid}", json={"kind": "offboarding", "anchor_date": x})
        self.assertEqual(r.status_code, 400)
        cl = self._start(eid, "offboarding", anchor_date=x, exit_type="death")
        keys = {i["key"] for i in cl["items"]}
        self.assertNotIn("OFF-14", keys)      # no exit acknowledgement
        self.assertNotIn("OFF-09", keys)      # no exit interview
        self.assertIn("OFF-16", keys)

    def test_hire_starts_the_checklist(self):
        db = database.SessionLocal()
        try:
            db.add(models.HrCandidate(id="cand-1", first_name="Sam", last_name="Lee", email="sam@example.com",
                                      stage="offer", company=CO_A,
                                      expected_start=(date.today() + timedelta(days=20)).isoformat()))
            db.commit()
        finally:
            db.close()
        r = self.client.patch("/hr/candidates/cand-1", json={"stage": "hired", "stage_note": "Signed on paper"})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            cand = db.query(models.HrCandidate).filter(models.HrCandidate.id == "cand-1").first()
            cl = db.query(models.HrChecklist).filter(models.HrChecklist.employee_id == cand.employee_id).first()
            self.assertIsNotNone(cl)
            self.assertEqual(cl.kind, "onboarding")
            self.assertEqual(cl.anchor_date, cand.expected_start)
        finally:
            db.close()

    def test_signal_ticks_provisioning(self):
        eid = self._person()
        self._start(eid)
        db = database.SessionLocal()
        try:
            db.add(models.HrProvisionRun(id="run-1", employee_id=eid, status="done"))
            db.commit()
        finally:
            db.close()
        cl = self.client.get(f"/hr/checklists/employee/{eid}").json()["checklists"][0]
        row = self._row(cl, "ON-12")
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["doneBy"], "Nexus")

    def test_start_date_change_moves_open_dates(self):
        eid = self._person(start="2027-03-01")
        cl = self._start(eid)
        before = self._row(cl, "ON-29")["dueDate"]
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == eid).update({"start_date": "2027-03-15"})
            db.commit()
        finally:
            db.close()
        cl = self.client.get(f"/hr/checklists/employee/{eid}").json()["checklists"][0]
        self.assertEqual(cl["anchorDate"], "2027-03-15")
        self.assertNotEqual(self._row(cl, "ON-29")["dueDate"], before)

    def test_owner_can_tick_but_not_reassign(self):
        cl = self._start(self._person())
        row = self._row(cl, "ON-09")          # owned by MANAGER
        _as(MANAGER)
        mine = self.client.get("/hr/checklists/mine").json()["steps"]
        self.assertTrue(any(s["id"] == row["id"] for s in mine))
        r = self.client.patch(f"/hr/checklists/items/{row['id']}", json={"status": "done"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.patch(f"/hr/checklists/items/{row['id']}", json={"owner_email": IT})
        self.assertEqual(r.status_code, 403)
        _as(IT)
        r = self.client.patch(f"/hr/checklists/items/{row['id']}", json={"status": "open"})
        self.assertEqual(r.status_code, 404)

    def test_na_needs_a_reason_and_owner_must_be_in_people(self):
        cl = self._start(self._person())
        row = self._row(cl, "ON-03")
        self.assertEqual(self.client.patch(f"/hr/checklists/items/{row['id']}", json={"status": "na"}).status_code, 400)
        r = self.client.patch(f"/hr/checklists/items/{row['id']}", json={"status": "na", "note": "No check for this role"})
        self.assertEqual(r.status_code, 200)
        r = self.client.patch(f"/hr/checklists/items/{row['id']}", json={"owner_email": "someone@outside.com"})
        self.assertEqual(r.status_code, 400)

    def test_scoped_admin_sees_only_their_company(self):
        eid = self._person()                  # company A
        self._start(eid)
        _as(SCOPED)
        self.assertEqual(self.client.get(f"/hr/checklists/employee/{eid}").status_code, 404)
        self.assertEqual(self.client.get("/hr/checklists/progress").json()["progress"], {})
        r = self.client.put("/hr/checklists/templates/onboarding", json={"items": [{"title": "X"}]})
        self.assertEqual(r.status_code, 403)  # the default needs an unrestricted admin

    def test_closing_the_last_row_closes_the_checklist(self):
        cl = self._start(self._person())
        for row in cl["items"]:
            self.client.patch(f"/hr/checklists/items/{row['id']}", json={"status": "na", "note": "test"})
        cl = self.client.get(f"/hr/checklists/employee/{cl['employeeId']}").json()["checklists"][0]
        self.assertEqual(cl["status"], "done")

    def test_daily_reminder_is_one_bell_per_owner_updated_in_place(self):
        eid = self._person(start=(date.today() + timedelta(days=1)).isoformat())
        self._start(eid)
        hc.run_daily()
        hc.run_daily()
        db = database.SessionLocal()
        try:
            bells = (db.query(models.NexusNotification)
                     .filter(models.NexusNotification.type == "hr_checklist",
                             models.NexusNotification.recipient == MANAGER).all())
            self.assertEqual(len(bells), 1)
            self.assertIn("Jane Doe", bells[0].title)
        finally:
            db.close()

    def test_board_lists_open_checklists_most_urgent_first(self):
        late = self._person("emp-late", start=(date.today() - timedelta(days=2)).isoformat())
        later = self._person("emp-later", start=(date.today() + timedelta(days=40)).isoformat())
        self._start(later)
        db = database.SessionLocal()
        try:
            emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == late).first()
            cl = hc.start(db, emp, "onboarding", by=HR)
            cl.created_at = (date.today() - timedelta(days=20)).isoformat() + "T00:00:00+00:00"
            db.flush()
            for it in db.query(models.HrChecklistItem).filter(models.HrChecklistItem.checklist_id == cl.id).all():
                it.due_date = hc.due_for(emp.start_date, cl.created_at[:10], it.anchor, it.offset, it.business_days, set())
            db.commit()
        finally:
            db.close()
        rows = self.client.get("/hr/checklists/board").json()["rows"]
        self.assertEqual([r["employeeId"] for r in rows], [late, later])
        self.assertGreater(rows[0]["overdue"], 0)
        self.assertTrue(rows[0]["next"]["overdue"])
        self.assertEqual(rows[1]["overdue"], 0)
        self.assertGreater(rows[1]["mine"] + rows[1]["total"], 0)
        _as(SCOPED)   # company B only - neither person is theirs
        self.assertEqual(self.client.get("/hr/checklists/board").json()["rows"], [])

    def test_template_edit_is_validated(self):
        r = self.client.put("/hr/checklists/templates/onboarding?entity_id=" + CO_B,
                            json={"items": [{"title": "Laptop", "owner": "janitor"}]})
        self.assertEqual(r.status_code, 400)
        r = self.client.put("/hr/checklists/templates/onboarding?entity_id=" + CO_B,
                            json={"items": [{"key": "MCD-1", "title": "Site Induction", "owner": "manager",
                                             "anchor": "S", "offset": 0}]})
        self.assertEqual(r.status_code, 200, r.text)
        cl = self._start(self._person("emp-b", company=CO_B))
        self.assertEqual([i["key"] for i in cl["items"]], ["MCD-1"])
        r = self.client.delete("/hr/checklists/templates/onboarding?entity_id=" + CO_B)
        self.assertTrue(r.json()["inherited"])

    # --- Neil, Oct 19 ----------------------------------------------------------

    def _role(self, rid="role-acct", dept="Accounting", company=CO_A, lead=MANAGER):
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id=rid, name="Accounting Associate", department=dept, is_job_role=1,
                                     company_id=company))
            if lead:
                db.add(models.HrDepartment(id=f"d-{rid}", company_id=company, name=dept, lead_email=lead))
            db.commit()
        finally:
            db.close()
        return rid

    def test_promotion_checklist_adds_the_roles_own_steps(self):
        rid = self._role()
        self._role("role-ops", dept="Operations", lead="")
        _as(MANAGER)                      # the department head - no People grant
        roles = self.client.get("/hr/checklists/role-templates").json()["roles"]
        self.assertEqual([r["roleId"] for r in roles], [rid])
        r = self.client.put(f"/hr/checklists/role-templates/{rid}/promotion",
                            json={"items": [{"key": "ACC-1", "title": "Intacct Training", "owner": "manager",
                                             "anchor": "S", "offset": 5}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.client.put("/hr/checklists/role-templates/role-ops/promotion",
                                         json={"items": []}).status_code, 404)     # not their department
        _as(HR)
        eid = self._person(work_email=NEWBIE)
        eff = (date.today() + timedelta(days=10)).isoformat()
        cl = self._start(eid, "promotion", anchor_date=eff, role_id=rid)
        self.assertEqual(cl["kindLabel"], "Promotion")
        keys = [i["key"] for i in cl["items"]]
        self.assertIn("PR-01", keys)
        self.assertEqual(keys[-1], "ACC-1")                     # the role's steps come after the company's
        self.assertEqual(self._row(cl, "ACC-1")["phase"], "Accounting Associate Steps")
        # onboarding follows the role the person holds
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroupMember(group_id=rid, email=NEWBIE))
            db.commit()
        finally:
            db.close()
        r = self.client.put(f"/hr/checklists/role-templates/{rid}/onboarding",
                            json={"items": [{"key": "ACC-ON", "title": "Intacct Login", "owner": "it"}]})
        self.assertEqual(r.status_code, 200, r.text)
        on = self._start(eid)
        self.assertIn("ACC-ON", [i["key"] for i in on["items"]])

    def test_old_owners_read_as_accounting_and_it(self):
        db = database.SessionLocal()
        try:
            db.add(models.HrChecklistTemplate(id="t-old", kind="onboarding", entity_id=CO_B, role_id="", name="Old",
                                              items=[{"key": "O-1", "title": "Tax Forms", "owner": "payroll", "anchor": "S"},
                                                     {"key": "O-2", "title": "Laptop", "owner": "equipment", "anchor": "S"}]))
            db.add(models.NexusSetting(key=hc.OWNERS_KEY + CO_B, value='{"payroll": "%s"}' % HRC))
            db.commit()
        finally:
            db.close()
        tpl = next(t for t in self.client.get(f"/hr/checklists/templates?entity_id={CO_B}").json()["templates"]
                   if t["kind"] == "onboarding")
        self.assertEqual([i["owner"] for i in tpl["items"]], ["accounting", "it"])
        self.assertEqual(self.client.get(f"/hr/checklists/owners?entity_id={CO_B}").json()["effective"]["accounting"], HRC)
        cl = self._start(self._person("emp-b", company=CO_B))
        self.assertEqual((self._row(cl, "O-1")["ownerRole"], self._row(cl, "O-1")["ownerEmail"]), ("accounting", HRC))
        self.assertEqual(self._row(cl, "O-2")["ownerRoleLabel"], "IT")
        meta = self.client.get("/hr/checklists/meta").json()
        self.assertEqual([r["value"] for r in meta["roles"]], ["hr", "manager", "employee", "it", "accounting"])
        self.assertEqual([k["value"] for k in meta["kinds"]], ["onboarding", "promotion", "offboarding", "inactive"])

    def test_copy_one_companys_steps_to_several(self):
        items = [{"key": "A-1", "title": "Site Induction", "owner": "manager", "anchor": "S"}]
        self.assertEqual(self.client.put(f"/hr/checklists/templates/onboarding?entity_id={CO_A}",
                                         json={"items": items}).status_code, 200)
        r = self.client.post("/hr/checklists/templates/copy",
                             json={"kinds": ["onboarding"], "from_entity_id": CO_A, "to_entity_ids": [CO_B, CO_IN]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["copied"], 2)
        for co in (CO_B, CO_IN):
            t = next(t for t in self.client.get(f"/hr/checklists/templates?entity_id={co}").json()["templates"]
                     if t["kind"] == "onboarding")
            self.assertFalse(t["inherited"])
            self.assertEqual([i["key"] for i in t["items"]], ["A-1"])
        # the library onto a company = "use the standard steps, then customize"
        r = self.client.post("/hr/checklists/templates/copy",
                             json={"kinds": [], "from_entity_id": "", "to_entity_ids": [CO_B]})
        self.assertEqual(r.json()["copied"], 4)
        _as(SCOPED)                       # company B only: cannot write company India
        r = self.client.post("/hr/checklists/templates/copy",
                             json={"kinds": ["onboarding"], "from_entity_id": CO_B, "to_entity_ids": [CO_IN]})
        self.assertEqual(r.status_code, 404)

    # Pranshu, Oct 20: a task per owner with a subtask per step, closing both ways.
    def _tasks_of(self, cl_id, owner):
        db = database.SessionLocal()
        try:
            rows = [r for r in db.query(models.HrChecklistItem).filter_by(checklist_id=cl_id).all()
                    if r.owner_email == owner and r.status == "open"]
            subs = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_([r.task_id for r in rows])).all()}
            parents = {s.parent_task_id for s in subs.values()}
            return rows, subs, parents
        finally:
            db.close()

    def _task(self, tid):
        db = database.SessionLocal()
        try:
            return db.query(models.Task).filter_by(id=tid).one()
        finally:
            db.close()

    def test_one_task_per_owner_with_a_subtask_per_step(self):
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        self.assertTrue(rows)
        self.assertEqual(len(subs), len(rows))                 # a subtask per step
        self.assertEqual(len(parents), 1)                      # under ONE task
        parent = self._task(parents.pop())
        self.assertEqual(parent.assignee_email, MANAGER)
        self.assertIn(f"{len(rows)} Step", parent.title)
        self.assertEqual(sorted(parent.subtask_ids), sorted(subs))
        self.assertTrue(all(s.assignee_email == MANAGER and s.title for s in subs.values()))
        # ticking the steps on the checklist completes their subtasks, then the task
        _as(MANAGER)
        for r in rows:
            self.assertEqual(self.client.patch(f"/hr/checklists/items/{r.id}", json={"status": "done"}).status_code, 200)
        self.assertTrue(all(self._task(s).completed for s in subs))
        self.assertTrue(self._task(parent.id).completed)
        # a step reopened reopens its subtask and the task
        self.client.patch(f"/hr/checklists/items/{rows[0].id}", json={"status": "open"})
        self.assertFalse(self._task(rows[0].task_id).completed)
        self.assertFalse(self._task(parent.id).completed)
        _as(HR)
        self.client.post(f"/hr/checklists/{cl['id']}/cancel")
        self.assertTrue(self._task(parent.id).completed)
        self.assertTrue(self._task(rows[0].task_id).completed)

    def test_completing_in_tasks_closes_the_steps(self):
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        pid = parents.pop()
        db = database.SessionLocal()
        try:                                   # the manager works in Tasks
            db.add(models.NexusGroup(id="grp-tasks-test", name="Tasks", allowed_modules="tasks:editor"))
            db.add(models.NexusGroupMember(group_id="grp-tasks-test", email=MANAGER))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        _as(MANAGER)
        # one subtask completed in Tasks -> that step is done, by the person who did it
        r = self.client.patch(f"/tasks/{rows[0].task_id}", json={"completed": True})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            step = db.query(models.HrChecklistItem).filter_by(id=rows[0].id).one()
            self.assertEqual((step.status, step.done_by), ("done", MANAGER))
            self.assertIn(f"{len(rows) - 1} Step", db.query(models.Task).filter_by(id=pid).one().title)
        finally:
            db.close()
        # reopened in Tasks -> the step reopens
        self.client.patch(f"/tasks/{rows[0].task_id}", json={"completed": False})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.HrChecklistItem).filter_by(id=rows[0].id).one().status, "open")
        finally:
            db.close()
        # the whole task completed -> every one of their steps is done, the subtasks too
        r = self.client.patch(f"/tasks/{pid}", json={"completed": True})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            steps = db.query(models.HrChecklistItem).filter(models.HrChecklistItem.id.in_([x.id for x in rows])).all()
            self.assertTrue(all(s.status == "done" for s in steps))
            self.assertTrue(all(t.completed for t in db.query(models.Task).filter(models.Task.id.in_(list(subs))).all()))
            others = [s for s in db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"]).all()
                      if s.owner_email != MANAGER]
            self.assertTrue(any(s.status == "open" for s in others))      # nobody else's steps were touched
        finally:
            db.close()

    def test_a_reassigned_step_moves_its_subtask(self):
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        old_parent = parents.pop()
        r = self.client.patch(f"/hr/checklists/items/{rows[0].id}", json={"owner_email": IT})
        self.assertEqual(r.status_code, 200, r.text)
        sub = self._task(rows[0].task_id)
        self.assertEqual(sub.assignee_email, IT)
        self.assertNotEqual(sub.parent_task_id, old_parent)
        self.assertIn(sub.id, self._task(sub.parent_task_id).subtask_ids)
        self.assertNotIn(sub.id, self._task(old_parent).subtask_ids or [])

    def test_checklists_open_before_tasks_get_none(self):
        cl = self._start(self._person())
        db = database.SessionLocal()
        try:
            db.query(models.Task).delete()
            db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"]).update({"task_id": ""})
            db.commit()
            row = db.query(models.HrChecklist).filter_by(id=cl["id"]).one()
            self.assertEqual(hc.sync_tasks(db, row), [])      # the nightly pass leaves them as they were
            self.assertEqual(db.query(models.Task).count(), 0)
        finally:
            db.close()
    def test_hiring_into_a_role_adds_that_roles_steps(self):
        rid = self._role()
        r = self.client.put(f"/hr/checklists/role-templates/{rid}/onboarding",
                            json={"items": [{"key": "ACC-ON", "title": "Intacct Training", "owner": "manager"}]})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            db.add(models.HrCandidate(id="cand-r", first_name="Ana", last_name="Ruiz", email="ana@example.com",
                                      stage="offer", company=CO_A, role_id=rid, role_title="Accounting Associate",
                                      expected_start=(date.today() + timedelta(days=20)).isoformat()))
            db.commit()
        finally:
            db.close()
        r = self.client.patch("/hr/candidates/cand-r", json={"stage": "hired", "stage_note": "Signed on paper"})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            cand = db.query(models.HrCandidate).filter_by(id="cand-r").one()
            cl = db.query(models.HrChecklist).filter_by(employee_id=cand.employee_id, kind="onboarding").one()
            keys = [i.key for i in db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id)
                    .order_by(models.HrChecklistItem.sort_order).all()]
            self.assertIn("ON-01", keys)               # the company's steps
            self.assertEqual(keys[-1], "ACC-ON")       # then the hired role's own
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
