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
              models.HrDepartment, models.Task, models.HrDocument, models.HrSignRequest,
              models.HrSignTemplate, models.TaskProject, models.TaskSection):
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
            db.add(models.HrDepartment(id="d-it-a", company_id=CO_A, name="IT", lead_email=IT))   # IT steps' owner
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

    def _dept(self, did, name, lead="", backup="", company=CO_A):
        db = database.SessionLocal()
        try:
            db.add(models.HrDepartment(id=did, company_id=company, name=name, lead_email=lead, backup_email=backup))
            db.commit()
        finally:
            db.close()

    def _set_dept(self, did, **fields):
        db = database.SessionLocal()
        try:
            db.query(models.HrDepartment).filter_by(id=did).update(fields)
            db.commit()
        finally:
            db.close()

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

    # --- Picture ID for everyone (Neil, Oct 22, 27:29 - the Colin case: "This
    # checklist is supposed to be there to confirm that we have everything on
    # everyone").

    def test_an_india_contractor_gets_the_picture_id_step_and_an_id_ticks_it(self):
        eid = self._person("emp-in-c", company=CO_IN, etype="contractor")
        cl = self._start(eid)
        keys = {i["key"] for i in cl["items"]}
        self.assertNotIn("ON-23", keys)                 # I-9 is US employees only
        step = self._row(cl, "ON-34")
        self.assertEqual((step["title"], step["status"]), ("Picture ID On File", "open"))
        db = database.SessionLocal()
        try:
            db.add(models.HrDocument(id="doc-in-id", employee_id=eid, kind="id", file_name="pan.pdf", storage_path="x"))
            db.commit()
        finally:
            db.close()
        cl = self.client.get(f"/hr/checklists/employee/{eid}").json()["checklists"][0]
        step = self._row(cl, "ON-34")
        self.assertEqual((step["status"], step["doneBy"]), ("done", "Nexus"))
        self.assertIn("ID document", step["doneReason"])

    def test_old_templates_get_the_id_evidence_once(self):
        import hr_checklist_seed as seed
        old = [{**r, "signal": ""} if r["key"] in ("ON-23", "ON-24") else dict(r)
               for r in seed.ONBOARDING if r["key"] != "ON-34"]
        db = database.SessionLocal()
        try:
            for tid, ent, role in (("tpl-lib", "", ""), ("tpl-b", CO_B, ""), ("tpl-role", "", "role-x")):
                db.add(models.HrChecklistTemplate(id=tid, kind="onboarding", entity_id=ent, role_id=role,
                                                  name="Onboarding", items=old))
            db.commit()
            self.assertEqual(hc.backfill_id_evidence(db), 2)     # library + company, never the role
            self.assertEqual(hc.backfill_id_evidence(db), 0)     # marked: a no-op
            db.query(models.NexusSetting).filter_by(key=hc.EVIDENCE_MARK).delete()
            db.commit()
            self.assertEqual(hc.backfill_id_evidence(db), 0)     # nothing left to add either
            db.expire_all()
            for tid in ("tpl-lib", "tpl-b"):
                items = db.get(models.HrChecklistTemplate, tid).items
                by = {r["key"]: r for r in items}
                self.assertEqual((by["ON-23"]["signal"], by["ON-24"]["signal"]), ("id_on_file", "work_auth_verified"))
                keys = [r["key"] for r in items]
                self.assertEqual(keys.count("ON-34"), 1)
                self.assertEqual(keys.index("ON-34"), keys.index("ON-11") + 1)   # after the last Offer Accepted step
            role = {r["key"]: r for r in db.get(models.HrChecklistTemplate, "tpl-role").items}
            self.assertEqual(role["ON-23"]["signal"], "")
            self.assertNotIn("ON-34", role)
        finally:
            db.close()

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

    def test_progress_keeps_a_finished_offboarding_for_someone_who_left(self):
        # Charmi, Oct 20 2026: the chip reads "Offboarding Complete" once a
        # Left person's checklist is done - an onboarding that finished does not linger.
        eid = self._person(work_email=NEWBIE)
        x = (date.today() + timedelta(days=14)).isoformat()
        off = self._start(eid, "offboarding", anchor_date=x, exit_type="resignation")
        self.assertEqual(off["exitType"], "resignation")
        p = self.client.get("/hr/checklists/progress").json()["progress"][eid]
        self.assertEqual([(c["kind"], c["status"]) for c in p], [("offboarding", "open")])
        for row in off["items"]:
            self.client.patch(f"/hr/checklists/items/{row['id']}", json={"status": "na", "note": "test"})
        self.assertNotIn(eid, self.client.get("/hr/checklists/progress").json()["progress"])  # still onboarding
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter(models.NexusEmployee.id == eid).update({"status": "offboarded"})
            db.commit()
        finally:
            db.close()
        p = self.client.get("/hr/checklists/progress").json()["progress"][eid]
        self.assertEqual([(c["kind"], c["status"], c["done"] == c["total"]) for c in p], [("offboarding", "done", True)])

    def test_meta_reads_the_new_exit_reasons(self):
        labels = {t["value"]: t["label"] for t in self.client.get("/hr/checklists/meta").json()["exitTypes"]}
        self.assertEqual(labels["resignation"], "Voluntary Resignation")
        self.assertEqual(labels["resignation_no_notice"], "Job Abandonment")

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

    def test_old_roles_read_as_accounting_and_it_and_old_owner_lists_are_retired(self):
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
        # Neil, Oct 22 4:41-5:42: no people list inside checklists - the old one is kept, never read.
        got = self.client.get(f"/hr/checklists/owners?entity_id={CO_B}").json()
        self.assertNotIn("accounting", got["effective"])
        self.assertFalse({"owners", "legacy"} & set(got))
        cl = self._start(self._person("emp-b", company=CO_B))
        self.assertEqual((self._row(cl, "O-1")["ownerRole"], self._row(cl, "O-1")["ownerEmail"]), ("accounting", ""))
        r = self.client.put(f"/hr/checklists/owners?entity_id={CO_B}", json={"owners": {"accounting": HRC}})
        self.assertEqual(r.status_code, 410)
        db = database.SessionLocal()
        try:
            self.assertIsNotNone(db.query(models.NexusSetting).filter_by(key=hc.OWNERS_KEY + CO_B).first())
        finally:
            db.close()
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

    def _cl_task(self, cl_id):
        db = database.SessionLocal()
        try:
            return db.query(models.HrChecklist).filter_by(id=cl_id).one().task_id
        finally:
            db.close()

    def test_one_task_per_checklist_with_a_subtask_per_step(self):
        # Neil, Oct 22: "It should create a task... called Onboarding - <name>...
        # the assignee should be the main HR manager. And then the individual
        # subtasks will get assigned to the correct people."
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        self.assertTrue(rows)
        self.assertEqual(len(subs), len(rows))                 # a subtask per step
        pid = self._cl_task(cl["id"])
        self.assertEqual(parents, {pid})                       # under the checklist's ONE task
        _, it_subs, it_parents = self._tasks_of(cl["id"], IT)
        self.assertEqual(it_parents, {pid})                    # IT's steps too - no task per owner
        parent = self._task(pid)
        self.assertEqual(parent.title, "Onboarding - Jane Doe")
        self.assertEqual(parent.assignee_email, HRC)           # the company's HR (its contact here)
        self.assertTrue(set(subs) | set(it_subs) <= set(parent.subtask_ids))
        self.assertTrue(all(s.assignee_email == MANAGER and s.title and s.owner_email == HRC for s in subs.values()))
        # ticking the steps on the checklist completes their subtasks; the task waits for the rest
        _as(MANAGER)
        for r in rows:
            self.assertEqual(self.client.patch(f"/hr/checklists/items/{r.id}", json={"status": "done"}).status_code, 200)
        self.assertTrue(all(self._task(s).completed for s in subs))
        self.assertFalse(self._task(pid).completed)
        # a step reopened reopens its subtask
        self.client.patch(f"/hr/checklists/items/{rows[0].id}", json={"status": "open"})
        self.assertFalse(self._task(rows[0].task_id).completed)
        _as(HR)
        self.client.post(f"/hr/checklists/{cl['id']}/cancel")
        self.assertTrue(self._task(pid).completed)
        self.assertTrue(self._task(rows[0].task_id).completed)

    def test_an_owner_set_after_the_start_gets_their_task_at_once(self):
        cl = self._start(self._person("emp-late", company=CO_B))      # CO_B has no Accounting owner yet
        blank = [i for i in cl["items"] if i["ownerRole"] == "accounting"]
        self.assertTrue(blank and not any(i["ownerEmail"] for i in blank))
        self._dept("d-acc-b", "Bookkeeping", lead=HRC, company=CO_B)
        r = self.client.put(f"/hr/checklists/owner-departments?entity_id={CO_B}", json={"departments": {"accounting": "d-acc-b"}})
        self.assertEqual(r.status_code, 200, r.text)
        rows, subs, parents = self._tasks_of(cl["id"], HRC)
        self.assertEqual(len(rows), len(blank))
        self.assertEqual(len(subs), len(rows))
        self.assertEqual(parents, {self._cl_task(cl["id"])})
        self.assertTrue(all(s.assignee_email == HRC for s in subs.values()))
        # an owner filled in with no task (the old board refresh did that) gets it when the checklist is opened
        db = database.SessionLocal()
        try:
            for it in db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"], owner_email=HRC).all():
                it.task_id = ""
            db.commit()
        finally:
            db.close()
        self.assertEqual(self.client.get("/hr/checklists/employee/emp-late").status_code, 200)
        rows, subs, parents = self._tasks_of(cl["id"], HRC)
        self.assertEqual(len(subs), len(rows))
        self.assertEqual(len(parents), 1)

    def test_completing_in_tasks_closes_the_steps(self):
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        pid = parents.pop()
        db = database.SessionLocal()
        try:                                   # the manager and HR work in Tasks
            db.add(models.NexusGroup(id="grp-tasks-test", name="Tasks", allowed_modules="tasks:editor"))
            db.add(models.NexusGroupMember(group_id="grp-tasks-test", email=MANAGER))
            db.add(models.NexusGroupMember(group_id="grp-tasks-test", email=HRC))
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
        finally:
            db.close()
        # reopened in Tasks -> the step reopens
        self.client.patch(f"/tasks/{rows[0].task_id}", json={"completed": False})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.HrChecklistItem).filter_by(id=rows[0].id).one().status, "open")
        finally:
            db.close()
        # the manager cannot see the checklist's own task - it is HR's
        self.assertEqual(self.client.patch(f"/tasks/{pid}", json={"completed": True}).status_code, 404)
        # HR completing the whole task -> every step still open is done, the subtasks too
        _as(HRC)
        r = self.client.patch(f"/tasks/{pid}", json={"completed": True})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            steps = db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"]).all()
            self.assertTrue(all(s.status in ("done", "na") for s in steps))
            self.assertTrue(all(t.completed for t in db.query(models.Task).filter(models.Task.id.in_(list(subs))).all()))
            self.assertEqual(db.query(models.HrChecklist).filter_by(id=cl["id"]).one().status, "done")
        finally:
            db.close()

    def _grant_tasks(self, *emails):
        db = database.SessionLocal()
        try:
            if not db.query(models.NexusGroup).filter_by(id="grp-tasks-test").first():
                db.add(models.NexusGroup(id="grp-tasks-test", name="Tasks", allowed_modules="tasks:editor"))
            for em in emails:
                db.add(models.NexusGroupMember(group_id="grp-tasks-test", email=em))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def _step(self, iid):
        db = database.SessionLocal()
        try:
            return db.query(models.HrChecklistItem).filter_by(id=iid).one()
        finally:
            db.close()

    def test_several_owners_share_one_task_and_any_of_them_closes_the_step(self):
        self._set_dept("d-it-a", backup_email=HRC)            # the IT head and their backup
        cl = self._start(self._person())
        it_rows = [i for i in cl["items"] if i["ownerRole"] == "it"]
        self.assertTrue(it_rows)
        self.assertTrue(all(i["ownerEmails"] == [IT, HRC] for i in it_rows))
        subs = [self._task(self._step(i["id"]).task_id) for i in it_rows]
        self.assertTrue(all(sorted(s.assignee_emails) == sorted([IT, HRC]) for s in subs))
        self.assertEqual({s.parent_task_id for s in subs}, {self._cl_task(cl["id"])})   # the checklist's task
        # either owner closing their subtask closes the step
        self._grant_tasks(HRC)
        _as(HRC)
        self.assertEqual(self.client.patch(f"/tasks/{subs[0].id}", json={"completed": True}).status_code, 200)
        self.assertEqual(self._step(it_rows[0]["id"]).status, "done")
        # and both see the step under My Steps
        self.assertIn(it_rows[1]["id"], [x["id"] for x in self.client.get("/hr/checklists/mine").json()["steps"]])
        _as(IT)
        self.assertIn(it_rows[1]["id"], [x["id"] for x in self.client.get("/hr/checklists/mine").json()["steps"]])

    def test_changing_role_owners_moves_open_steps_and_their_tasks(self):
        cl = self._start(self._person())                       # IT steps start with IT (the default owner)
        it_rows = [i for i in cl["items"] if i["ownerRole"] == "it"]
        self.client.patch(f"/hr/checklists/items/{it_rows[0]['id']}", json={"status": "done"})   # one already done
        _as(HR)
        manual = it_rows[1]["id"]                              # one HR handed to the manager by hand
        self.client.patch(f"/hr/checklists/items/{manual}", json={"owner_email": MANAGER})
        r = self.client.patch(f"/hr/entities/{CO_A}/departments/d-it-a", json={"lead_email": HRC})   # a new IT head
        self.assertEqual(r.status_code, 200, r.text)
        moved = [self._step(i["id"]) for i in it_rows[2:]]
        self.assertTrue(moved and all(m.owner_email == HRC for m in moved))
        subs = [self._task(m.task_id) for m in moved]
        self.assertTrue(all(s.assignee_emails == [HRC] for s in subs))       # the subtasks moved with them
        self.assertEqual({s.parent_task_id for s in subs}, {self._cl_task(cl["id"])})
        self.assertEqual(self._step(it_rows[0]["id"]).owner_email, IT)       # done steps keep who did them
        self.assertEqual(self._step(manual).owner_email, MANAGER)            # a hand-set owner stays

    def test_step_comments_and_task_comments_are_one_thread(self):
        eid = self._person()
        cl = self._start(eid)
        row = next(i for i in cl["items"] if i["ownerEmail"] == MANAGER)
        sub_id = self._step(row["id"]).task_id
        r = self.client.post(f"/hr/checklists/items/{row['id']}/comments", json={"body": "Laptop ordered"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual([(c["author"], c["body"]) for c in r.json()["item"]["comments"]], [(HR, "Laptop ordered")])
        db = database.SessionLocal()
        try:                                   # it is a task comment on the step's subtask
            self.assertEqual([c.body for c in db.query(models.TaskComment).filter_by(task_id=sub_id).all()], ["Laptop ordered"])
        finally:
            db.close()
        self._grant_tasks(MANAGER)
        _as(MANAGER)                           # a comment made in Tasks shows on the step
        self.assertEqual(self.client.post(f"/tasks/{sub_id}/comments", json={"body": "Set up on my side"}).status_code, 201)
        _as(HR)
        step = next(i for c in self.client.get(f"/hr/checklists/employee/{eid}").json()["checklists"]
                    for i in c["items"] if i["id"] == row["id"])
        self.assertEqual([c["body"] for c in step["comments"]], ["Laptop ordered", "Set up on my side"])
        self.assertEqual(step["comments"][1]["authorName"], "Staff 2")
        # a step nobody owns yet keeps its comment on the row
        blank = next(i for i in cl["items"] if not i["ownerEmail"])
        r = self.client.post(f"/hr/checklists/items/{blank['id']}/comments", json={"body": "Waiting on the work email"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual([c["body"] for c in r.json()["item"]["comments"]], ["Waiting on the work email"])
        self.assertEqual(self.client.post(f"/hr/checklists/items/{blank['id']}/comments", json={"body": " "}).status_code, 400)

    def test_due_dates_sync_both_ways(self):
        cl = self._start(self._person())
        row = next(i for i in cl["items"] if i["ownerEmail"] == MANAGER)
        sub_id = self._step(row["id"]).task_id
        self._grant_tasks(MANAGER)
        _as(MANAGER)
        # More than a month past the first date waits for HR's approval
        # (task_due.needs_approval): the task keeps its date, so the step
        # does not move either (Oct 22 2026 - it used to move anyway).
        r = self.client.patch(f"/tasks/{sub_id}", json={"due_on": "2027-01-15"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["dueAgreement"], "extension_requested")
        held = self._step(row["id"])
        self.assertEqual(held.due_date, self._task(sub_id).due_on)
        self.assertFalse(held.due_manual)
        # Moved in Tasks -> the step moves, pinned.
        self.assertEqual(self.client.post(f"/tasks/{sub_id}/due/withdraw").status_code, 200)
        r = self.client.patch(f"/tasks/{sub_id}", json={"due_on": "2026-12-01"})
        self.assertEqual(r.status_code, 200, r.text)
        step = self._step(row["id"])
        self.assertEqual((step.due_date, step.due_manual), ("2026-12-01", True))
        _as(HR)                                # moved on the step -> the subtask moves
        self.assertEqual(self.client.patch(f"/hr/checklists/items/{row['id']}", json={"due_date": "2027-02-01"}).status_code, 200)
        self.assertEqual(self._task(sub_id).due_on, "2027-02-01")

    def test_an_approved_or_countered_date_moves_the_step(self):
        # Oct 22 2026: a date set by an answer (an approved extension, a
        # counter) moves the step too - otherwise the step keeps the old date
        # and its next sync moves the task back.
        cl = self._start(self._person())
        row = next(i for i in cl["items"] if i["ownerEmail"] == MANAGER)
        sub_id = self._step(row["id"]).task_id
        self._grant_tasks(MANAGER, HR)
        _as(MANAGER)
        r = self.client.patch(f"/tasks/{sub_id}", json={"due_on": "2027-01-15"})
        self.assertEqual(r.json()["dueAgreement"], "extension_requested")
        _as(HR)                                # approve, then the step follows
        r = self.client.post(f"/tasks/{sub_id}/due/respond", json={"accept": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._step(row["id"]).due_date, "2027-01-15")
        db = database.SessionLocal()           # the assignee proposed another date...
        try:
            t = db.get(models.Task, sub_id)
            t.due_agreement, t.due_proposal = "proposed", {"dueOn": "2027-02-10", "by": MANAGER}
            db.commit()
        finally:
            db.close()
        r = self.client.post(f"/tasks/{sub_id}/due/respond", json={"counter_on": "2027-02-05"})
        self.assertEqual(r.status_code, 200, r.text)   # ...and HR's counter moves the step
        self.assertEqual((self._task(sub_id).due_on, self._step(row["id"]).due_date), ("2027-02-05", "2027-02-05"))
        db = database.SessionLocal()           # an accepted proposal moves it too
        try:
            t = db.get(models.Task, sub_id)
            t.due_agreement, t.due_proposal = "proposed", {"dueOn": "2027-02-20", "by": MANAGER}
            db.commit()
        finally:
            db.close()
        self.assertEqual(self.client.post(f"/tasks/{sub_id}/due/respond", json={"accept": True}).status_code, 200)
        self.assertEqual(self._step(row["id"]).due_date, "2027-02-20")

    def test_a_reassigned_step_moves_its_subtask(self):
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        r = self.client.patch(f"/hr/checklists/items/{rows[0].id}", json={"owner_email": IT})
        self.assertEqual(r.status_code, 200, r.text)
        sub = self._task(rows[0].task_id)
        self.assertEqual(sub.assignee_email, IT)
        self.assertEqual(sub.parent_task_id, parents.pop())       # still under the checklist's task
        self.assertIn(sub.id, self._task(sub.parent_task_id).subtask_ids)

    def test_checklists_open_before_tasks_get_none(self):
        cl = self._start(self._person())
        db = database.SessionLocal()
        try:
            db.query(models.Task).delete()
            db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"]).update({"task_id": ""})
            db.query(models.HrChecklist).filter_by(id=cl["id"]).update({"task_id": ""})
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
    def test_a_hire_emails_each_owner_their_task_once_it_commits(self):
        import threading
        import time
        import task_notify
        sent, lock = [], threading.Lock()
        real = task_notify.notify_task_event

        def record(tid, event, actor, **kw):
            with lock:
                sent.append((tid, event))
        task_notify.notify_task_event = record
        try:
            db = database.SessionLocal()
            try:
                db.add(models.HrCandidate(id="cand-e", first_name="Eve", last_name="Ng", email="eve@example.com",
                                          stage="offer", company=CO_A,
                                          expected_start=(date.today() + timedelta(days=20)).isoformat()))
                db.commit()
            finally:
                db.close()
            r = self.client.patch("/hr/candidates/cand-e", json={"stage": "hired", "stage_note": "Signed on paper"})
            self.assertEqual(r.status_code, 200, r.text)
            db = database.SessionLocal()
            try:
                cand = db.query(models.HrCandidate).filter_by(id="cand-e").one()
                cl = db.query(models.HrChecklist).filter_by(employee_id=cand.employee_id).one()
                subs = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_(
                    [i.task_id for i in db.query(models.HrChecklistItem).filter_by(checklist_id=cl.id).all() if i.task_id]))}
                pid = cl.task_id
            finally:
                db.close()
            self.assertTrue(pid and subs)
            for _ in range(50):                       # the email goes from a thread after the commit
                with lock:
                    if pid in {t for t, _e in sent}:
                        break
                time.sleep(0.1)
            time.sleep(0.3)
            got = [t for t, e in sent if e == "assigned"]
            self.assertIn(pid, got)                   # HR hears about the checklist's task...
            owners = [",".join(sorted(subs[t].assignee_emails)) for t in got if t in subs]
            self.assertEqual(len(owners), len(set(owners)))     # ...each owner once, never once per step
            self.assertLess(len(got), len(subs))
        finally:
            task_notify.notify_task_event = real

    # Move To (Oct 22 2026): the checklist's tasks are the sync's. A step
    # moved out under an org-wide task was shown to everyone, and moving
    # every step under somebody's own task let the next sync rewrite it.
    def _org_task_for_manager(self):
        db = database.SessionLocal()
        try:
            db.merge(models.TaskProject(id="orgproj", name="Org", access_level="org", owner_email=IT,
                                      created_at="2026-10-01", modified_at="2026-10-01"))
            db.commit()
        finally:
            db.close()
        _as(MANAGER)
        r = self.client.post("/tasks", json={"title": "Weekly report", "project_id": "orgproj",
                                             "assignee_emails": [MANAGER], "description": "mine"})
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()["id"]

    def test_a_checklist_step_cannot_be_moved_out(self):
        self._grant_tasks(MANAGER, IT)
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        mine = self._org_task_for_manager()
        step = rows[0].task_id
        r = self.client.patch(f"/tasks/{step}", json={"parent_task_id": mine})
        self.assertEqual(r.status_code, 422, r.text)
        r = self.client.patch(f"/tasks/{step}", json={"parent_task_id": ""})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn(self._task(step).parent_task_id, parents)
        _as(IT)
        self.assertNotIn(step, {t["id"] for t in self.client.get("/tasks").json()})
        # Nor pulled out through the other end of the link.
        _as(MANAGER)
        r = self.client.patch(f"/tasks/{mine}", json={"subtask_ids": [step]})
        self.assertEqual(r.status_code, 422, r.text)
        self.assertIn(self._task(step).parent_task_id, parents)

    def test_nothing_moves_under_a_checklist_task_and_its_parent_stays(self):
        self._grant_tasks(MANAGER, IT, HRC)
        cl = self._start(self._person())
        rows, subs, parents = self._tasks_of(cl["id"], MANAGER)
        parent = parents.pop()
        mine = self._org_task_for_manager()
        _as(HRC)                                  # the checklist's task is HR's to see
        self.assertEqual(self.client.patch(f"/tasks/{mine}", json={"parent_task_id": parent}).status_code, 422)
        self.assertEqual(self.client.patch(f"/tasks/{parent}", json={"parent_task_id": mine}).status_code, 422)
        self.assertEqual(self.client.patch(f"/tasks/{parent}", json={"subtask_ids": []}).status_code, 422)
        # The payload says so, so the list can leave Move To off.
        listed = {t["id"]: t for t in self.client.get("/tasks").json()}
        self.assertTrue(listed[parent]["hrChecklist"])
        self.assertTrue(listed[rows[0].task_id]["hrChecklist"])   # HR sees every subtask of it
        self.assertFalse(listed[mine]["hrChecklist"])
        # The sync keeps writing to the checklist's own task, never to mine.
        _as(MANAGER)
        r = self.client.patch(f"/hr/checklists/items/{rows[1].id}", json={"status": "done"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._task(mine).title, "Weekly report")
        self.assertEqual(self._task(rows[0].task_id).parent_task_id, parent)

    # --- How a step gets marked done is a multi-select (Neil, Oct 22): the
    # owner can always tick it, and any ONE of its automatic conditions ticks
    # it too - including evidence on the record itself (the Colin case).

    def _custom(self, signal=None, signals=None):
        row = {"key": "EV-1", "title": "ID And Right To Work On File", "owner": "hr", "anchor": "S", "offset": 0}
        if signal is not None:
            row["signal"] = signal
        if signals is not None:
            row["signals"] = signals
        r = self.client.put("/hr/checklists/templates/onboarding?entity_id=" + CO_B, json={"items": [row]})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["items"][0]

    def _get(self, eid):
        return self.client.get(f"/hr/checklists/employee/{eid}").json()["checklists"][0]["items"][0]

    def test_several_conditions_are_saved_and_unknown_ones_refused(self):
        row = self._custom(signals=["id_on_file", "work_auth_verified", "id_on_file"])
        self.assertEqual(row["signal"], "id_on_file|work_auth_verified")
        r = self.client.put("/hr/checklists/templates/onboarding?entity_id=" + CO_B,
                            json={"items": [{"title": "X", "signals": ["id_on_file", "made_up"]}]})
        self.assertEqual(r.status_code, 400)

    def test_any_one_condition_ticks_and_says_which(self):
        self._custom(signals=["id_on_file", "work_auth_verified"])
        eid = self._person("emp-ev", company=CO_B)
        cl = self._start(eid)
        step = cl["items"][0]
        self.assertEqual(step["status"], "open")
        self.assertEqual([s["value"] for s in step["signals"]], ["id_on_file", "work_auth_verified"])
        db = database.SessionLocal()
        try:
            db.query(models.NexusEmployee).filter_by(id=eid).update(
                {"compliance": {"workAuth": "citizen", "status": "verified"}})
            db.commit()
        finally:
            db.close()
        step = self._get(eid)
        self.assertEqual((step["status"], step["doneBy"]), ("done", "Nexus"))
        self.assertIn("Work authorization", step["doneReason"])
        # ticked by hand later on someone else's checklist: no Nexus reason
        r = self.client.patch(f"/hr/checklists/items/{step['id']}", json={"status": "open"})
        self.assertEqual(r.json()["item"]["doneReason"], "")

    def test_id_condition_needs_a_live_id_document(self):
        self._custom(signal="id_on_file")
        eid = self._person("emp-id", company=CO_B)
        self._start(eid)
        yesterday = (date.today() - timedelta(days=5)).isoformat()
        db = database.SessionLocal()
        try:      # a resume and an EXPIRED ID prove nothing
            db.add(models.HrDocument(id="doc-cv", employee_id=eid, kind="resume", file_name="cv.pdf", storage_path="x"))
            db.add(models.HrDocument(id="doc-old", employee_id=eid, kind="id", file_name="dl.pdf", storage_path="y",
                                     expires_on=yesterday))
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._get(eid)["status"], "open")
        db = database.SessionLocal()
        try:
            db.add(models.HrDocument(id="doc-id", employee_id=eid, kind="id", file_name="dl2.pdf", storage_path="z"))
            db.commit()
        finally:
            db.close()
        step = self._get(eid)
        self.assertEqual((step["status"], step["doneBy"]), ("done", "Nexus"))
        self.assertIn("ID document", step["doneReason"])

    def test_an_old_single_condition_still_ticks(self):
        self._custom(signal="envelope:offer,contractor_agreement")
        eid = self._person("emp-old", company=CO_B)
        self._start(eid)
        db = database.SessionLocal()
        try:
            db.add(models.HrSignTemplate(id="tpl-offer", name="Offer", kind="offer"))
            db.add(models.HrSignRequest(id="req-offer", title="Offer", template_id="tpl-offer", employee_id=eid,
                                        status="completed"))
            db.commit()
        finally:
            db.close()
        step = self._get(eid)
        self.assertEqual(step["status"], "done")
        self.assertIn("offer letter", step["doneReason"])

    def _manager_step(self, signal):
        r = self.client.put("/hr/checklists/templates/onboarding?entity_id=" + CO_B, json={"items": [
            {"key": "EV-1", "title": "Evidence On File", "owner": "manager", "anchor": "S", "offset": 0,
             "signal": signal}]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_a_signed_packet_ticks_its_step_and_subtask_without_opening_the_profile(self):
        # Oct 23 browser test: Jake signed, but his step and its subtask stayed
        # open on My Tasks until someone opened his profile (Neil, 1:03:43).
        import hr_life_events as hle
        self._manager_step("envelope:nda,handbook_ack")
        eid = self._person("emp-sign", company=CO_B)
        cl = self._start(eid)
        rows, subs, _ = self._tasks_of(cl["id"], MANAGER)
        self.assertEqual((len(rows), len(subs)), (1, 1))
        db = database.SessionLocal()
        try:
            db.add(models.HrCandidate(id="cand-sign", first_name="Jane", last_name="Doe", employee_id=eid,
                                      stage="hired"))
            db.add(models.HrLifeEvent(id="ev-sign", kind="hire", candidate_id="cand-sign", status="sent",
                                      sign_request_id="req-sign", created_by=HR))
            db.add(models.HrSignRequest(id="req-sign", title="Hiring Packet", link_kind="life_event",
                                        link_id="ev-sign", status="completed"))
            db.commit()
            hle.on_completed(db, db.query(models.HrSignRequest).filter_by(id="req-sign").one())
            db.commit()
            step = db.query(models.HrChecklistItem).filter_by(id=rows[0].id).one()
            self.assertEqual((step.status, step.done_by), ("done", "Nexus"))
            self.assertEqual(db.query(models.HrChecklist).filter_by(id=cl["id"]).one().status, "done")
        finally:
            db.close()
        self.assertTrue(self._task(rows[0].task_id).completed)       # off the owner's My Tasks
        self.assertTrue(self._task(self._cl_task(cl["id"])).completed)

    def test_an_id_upload_ticks_its_step_at_once(self):
        from unittest import mock
        self._custom(signal="id_on_file")
        eid = self._person("emp-up", company=CO_B)
        cl = self._start(eid)
        with mock.patch("routers.hr._storage_headers", return_value={}),                 mock.patch("routers.hr.httpx.post", return_value=mock.Mock(is_success=True)):
            r = self.client.post(f"/hr/employees/{eid}/documents", data={"kind": "id"},
                                 files={"file": ("dl.pdf", b"%PDF-1.4", "application/pdf")})
        self.assertEqual(r.status_code, 200, r.text)
        db = database.SessionLocal()
        try:
            step = db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"]).one()
            self.assertEqual((step.status, step.done_by), ("done", "Nexus"))
        finally:
            db.close()

    def test_opening_the_profile_closes_the_task_of_a_step_that_ticked(self):
        # Audit item 8: a tick found on the profile read completes its tasks too.
        self._manager_step("id_on_file")
        eid = self._person("emp-open", company=CO_B)
        cl = self._start(eid)
        db = database.SessionLocal()
        try:
            db.add(models.HrDocument(id="doc-open", employee_id=eid, kind="id", file_name="dl.pdf", storage_path="z"))
            db.commit()
            step = db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"]).one()
        finally:
            db.close()
        self.assertTrue(step.task_id)
        self.assertEqual(self._get(eid)["status"], "done")
        self.assertTrue(self._task(step.task_id).completed)
        self.assertTrue(self._task(self._cl_task(cl["id"])).completed)

    def test_meta_offers_the_evidence_conditions(self):
        values = {s["value"] for s in self.client.get("/hr/checklists/meta").json()["signals"]}
        self.assertTrue({"id_on_file", "work_auth_verified", "envelope:nda,handbook_ack"} <= values)

    # --- Baseline + Copy From (Neil, Oct 22: "this is a baseline and we build
    # off of the baseline... there needs to be a copy from option").

    def test_the_role_editor_shows_the_baseline_it_builds_on(self):
        rid = self._role()                                    # a Greens (CO_A) role
        lib = next(t for t in self.client.get("/hr/checklists/templates").json()["templates"] if t["kind"] == "onboarding")
        d = self.client.get(f"/hr/checklists/role-templates/{rid}").json()
        self.assertEqual(d["companyName"], "Greens")
        on = next(t for t in d["templates"] if t["kind"] == "onboarding")
        self.assertEqual(on["baseline"]["source"], "library")
        self.assertEqual(len(on["baseline"]["items"]), len(lib["items"]))
        self.client.put(f"/hr/checklists/templates/onboarding?entity_id={CO_A}",
                        json={"items": [{"key": "A-1", "title": "Site Induction", "owner": "manager"}]})
        on = next(t for t in self.client.get(f"/hr/checklists/role-templates/{rid}").json()["templates"]
                  if t["kind"] == "onboarding")
        self.assertEqual((on["baseline"]["source"], [i["title"] for i in on["baseline"]["items"]]),
                         ("company", ["Site Induction"]))
        # the role audit's Baseline Only counts: each company's baseline, '' = the library
        bl = self.client.get("/hr/checklists/role-templates").json()["baselines"]
        self.assertEqual((bl[CO_A]["onboarding"], bl[""]["onboarding"], bl[CO_B]["onboarding"]),
                         (1, len(lib["items"]), len(lib["items"])))

    def test_copy_a_roles_steps_into_another_role(self):
        src = self._role()
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroup(id="role-ap", name="AP Clerk", department="Accounting", is_job_role=1, company_id=CO_A))
            db.add(models.NexusGroup(id="role-site", name="Site Lead", department="Operations", is_job_role=1, company_id=CO_A))
            db.commit()
        finally:
            db.close()
        put = lambda rid, rows: self.client.put(f"/hr/checklists/role-templates/{rid}/onboarding", json={"items": rows})  # noqa: E731
        put(src, [{"key": "ACC-1", "phase": "Accounting Associate Steps", "title": "Intacct Training", "owner": "manager"},
                  {"key": "ACC-2", "title": "Bank Portal Access", "owner": "it"}])
        put("role-ap", [{"key": "AP-1", "title": "bank portal access", "owner": "it"}])
        _as(MANAGER)                                         # head of Accounting
        r = self.client.post("/hr/checklists/role-templates/role-ap/copy",
                             json={"from_role_id": src, "kinds": ["onboarding"], "mode": "append"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["copied"], 1)              # the same title is not added twice
        on = next(t for t in r.json()["templates"] if t["kind"] == "onboarding")
        self.assertEqual([i["title"] for i in on["items"]], ["bank portal access", "Intacct Training"])
        self.assertEqual(on["items"][1]["phase"], "AP Clerk Steps")       # the role's own phase name
        self.assertNotIn(on["items"][1]["key"], ("ACC-1", "ACC-2"))     # a new key
        r = self.client.post("/hr/checklists/role-templates/role-ap/copy",
                             json={"from_role_id": src, "kinds": ["onboarding"], "mode": "replace"})
        on = next(t for t in r.json()["templates"] if t["kind"] == "onboarding")
        self.assertEqual([i["title"] for i in on["items"]], ["Intacct Training", "Bank Portal Access"])
        # a role outside their department is neither a source nor a target
        self.assertEqual(self.client.post("/hr/checklists/role-templates/role-ap/copy",
                                          json={"from_role_id": "role-site"}).status_code, 404)
        self.assertEqual(self.client.post("/hr/checklists/role-templates/role-site/copy",
                                          json={"from_role_id": src}).status_code, 404)

    # --- Live templates (Neil, Oct 22: "is it dynamic or is it fixed? ... it
    # needs to fix on task also") - edits reach OPEN checklists and their tasks.

    def _items_of(self, cl_id):
        db = database.SessionLocal()
        try:
            return {i.key: i for i in db.query(models.HrChecklistItem).filter_by(checklist_id=cl_id).all()}
        finally:
            db.close()

    def test_a_template_edit_reaches_open_checklists_and_their_tasks(self):
        url = f"/hr/checklists/templates/onboarding?entity_id={CO_B}"
        self._dept("d-it-b", "IT", lead=IT, company=CO_B)
        row = lambda k, t, **x: {"key": k, "title": t, "owner": "manager", "anchor": "S", "offset": 0, **x}  # noqa: E731
        self.client.put(url, json={"items": [row("A", "Desk Ready"), row("B", "Buddy Named"), row("C", "Parking Pass")]})
        cl = self._start(self._person("emp-live", company=CO_B))
        ids = {i["key"]: i["id"] for i in cl["items"]}
        self.client.patch(f"/hr/checklists/items/{ids['A']}", json={"status": "done"})
        pinned = (date.today() + timedelta(days=60)).isoformat()
        self.client.patch(f"/hr/checklists/items/{ids['B']}", json={"due_date": pinned})
        r = self.client.put(url, json={"items": [row("A", "Desk And Chair Ready"),
                                                 row("B", "Buddy And Mentor Named", hint="Pick someone senior", offset=5, owner="it"),
                                                 row("D", "Team Lunch")]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["openUpdated"], 1)
        items = self._items_of(cl["id"])
        self.assertEqual((items["A"].title, items["A"].status), ("Desk Ready", "done"))      # done = history
        self.assertEqual((items["B"].title, items["B"].offset, items["B"].due_date),
                         ("Buddy And Mentor Named", 5, pinned))                                # a pinned date stays
        self.assertEqual((items["B"].owner_role, items["B"].owner_email), ("it", IT))         # a new owner role
        self.assertEqual(self._task(items["B"].task_id).assignee_email, IT)
        self.assertEqual(self._task(items["B"].task_id).title, "Buddy And Mentor Named - Jane Doe")      # the subtask follows
        self.assertEqual(items["C"].status, "na")
        self.assertTrue(items["C"].note.startswith("Removed from the template on "))
        self.assertTrue(self._task(items["C"].task_id).completed)
        self.assertEqual((items["D"].status, items["D"].owner_email), ("open", MANAGER))
        self.assertTrue(items["D"].task_id)                                                   # a subtask of its own
        self.assertTrue(self._task(items["D"].task_id).parent_task_id)

    def test_the_library_reaches_only_companies_without_their_own_copy(self):
        lib = next(t for t in self.client.get("/hr/checklists/templates").json()["templates"] if t["kind"] == "onboarding")
        self.client.put(f"/hr/checklists/templates/onboarding?entity_id={CO_B}",
                        json={"items": [{"key": "B-1", "title": "Site Induction", "owner": "manager"}]})
        a = self._start(self._person("emp-a"))                       # CO_A follows the library
        b = self._start(self._person("emp-b2", company=CO_B))
        items = lib["items"] + [{"key": "LIB-NEW", "title": "Welcome Video", "owner": "hr", "anchor": "created"}]
        r = self.client.put("/hr/checklists/templates/onboarding", json={"items": items})
        self.assertEqual(r.json()["openUpdated"], 1)
        self.assertIn("LIB-NEW", self._items_of(a["id"]))
        self.assertNotIn("LIB-NEW", self._items_of(b["id"]))

    def test_a_role_change_reaches_that_roles_checklists_and_keys_never_collide(self):
        rid = self._role()
        put = lambda rows: self.client.put(f"/hr/checklists/role-templates/{rid}/onboarding", json={"items": rows})  # noqa: E731
        put([{"key": "ON-01", "title": "Intacct Training", "owner": "manager"}])   # the same key as a library step
        eid = self._person("emp-role", work_email=NEWBIE)
        db = database.SessionLocal()
        try:
            db.add(models.NexusGroupMember(group_id=rid, email=NEWBIE))
            db.commit()
        finally:
            db.close()
        cl = self._start(eid)
        keys = [i["key"] for i in cl["items"]]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertIn("ON-01", keys)
        self.assertIn(f"ON-01~{rid[:8]}", keys)
        db = database.SessionLocal()
        try:                                      # a checklist started before Oct 23 has no role recorded
            db.query(models.HrChecklist).filter_by(id=cl["id"]).update({"role_id": None})
            db.commit()
        finally:
            db.close()
        r = put([{"key": "ON-01", "title": "Intacct Training", "owner": "manager"},
                 {"key": "ACC-2", "title": "Bank Portal Access", "owner": "it"}])
        self.assertEqual(r.json()["openUpdated"], 1)
        items = self._items_of(cl["id"])
        self.assertEqual(items["ACC-2"].status, "open")
        self.assertEqual(items["ON-01"].title, next(i["title"] for i in cl["items"] if i["key"] == "ON-01"))
        r = put([])                               # the role's steps all go: open ones turn N/A, never deleted
        items = self._items_of(cl["id"])
        self.assertEqual((items["ACC-2"].status, items[f"ON-01~{rid[:8]}"].status), ("na", "na"))
        self.assertNotEqual(items["ON-01"].status, "na")                                   # the library step stays

    # --- One task per checklist, in the HR project (Neil, Oct 22: "It should
    # not create a new project for every single employee") and a place that can
    # change later (Pranshu: "what if I want to change the task location?").

    def _hr_project(self):
        db = database.SessionLocal()
        try:
            db.add(models.HrDepartment(id="d-hr-a", company_id=CO_A, name="Human Resources", lead_email=HRC))
            now = "2026-10-01T00:00:00+00:00"
            for pid, name, dept in (("p-hr", "#General - Human Resources", "d-hr-a"), ("p-ops", "Operations", ""),
                                    ("p-hr2", "HR Onboarding", "d-hr-a")):
                db.add(models.TaskProject(id=pid, name=name, access_level="restricted", owner_email=HR,
                                          member_emails=[HR], hr_department_id=dept, company_id=CO_A,
                                          created_at=now, modified_at=now))
            db.add(models.TaskSection(id="s-new", project_id="p-hr2", name="New Hires", position=0, created_at=now))
            db.commit()
        finally:
            db.close()

    def test_the_checklists_task_lands_in_the_companys_hr_project(self):
        self._hr_project()
        place = self.client.get(f"/hr/checklists/task-place?entity_id={CO_A}").json()
        self.assertEqual((place["effective"]["onboarding"]["projectId"], place["effective"]["onboarding"]["source"]),
                         ("p-hr", "auto"))                   # found by itself: #General - Human Resources
        cl = self._start(self._person())
        parent = self._task(self._cl_task(cl["id"]))
        self.assertEqual((parent.project_id, parent.assignee_email), ("p-hr", HRC))
        self.assertEqual(cl["task"]["projectName"], "#General - Human Resources")
        rows, subs, _ = self._tasks_of(cl["id"], IT)
        self.assertTrue(all(not s.project_id for s in subs.values()))      # subtasks inherit the parent's
        self.assertTrue(all(s.title.endswith(" - Jane Doe") for s in subs.values()))   # whose checklist, on My Tasks
        # the IT owner sees their subtask in Tasks; HR (a project member) sees the parent
        self._grant_tasks(IT, HR)
        _as(IT)
        seen = {t["id"] for t in self.client.get("/tasks").json()}
        self.assertTrue(set(subs) <= seen)
        self.assertNotIn(parent.id, seen)
        _as(HR)
        self.assertIn(parent.id, {t["id"] for t in self.client.get("/tasks").json()})
        # a new place for onboarding: the open task moves when asked, subtasks with it
        r = self.client.put(f"/hr/checklists/task-place?entity_id={CO_A}",
                            json={"place": {"onboarding": {"projectId": "p-hr2", "sectionId": "s-new"}}, "move": False})
        self.assertEqual((r.status_code, r.json()["moved"]), (200, 0))
        self.assertEqual(self._task(parent.id).project_id, "p-hr")
        self.assertEqual(r.json()["openTasks"], [{"kind": "onboarding", "projectId": "p-hr", "sectionId": ""}])
        r = self.client.put(f"/hr/checklists/task-place?entity_id={CO_A}",
                            json={"place": {"onboarding": {"projectId": "p-hr2", "sectionId": "s-new"}}, "move": True})
        self.assertEqual(r.json()["moved"], 1)
        moved = self._task(parent.id)
        self.assertEqual((moved.project_id, moved.section_id), ("p-hr2", "s-new"))
        bad = self.client.put(f"/hr/checklists/task-place?entity_id={CO_A}",
                              json={"place": {"default": {"projectId": "p-ops", "sectionId": "s-new"}}})
        self.assertEqual(bad.status_code, 400)                # a section of another project

    def test_a_company_without_its_own_hr_project_uses_the_groups(self):
        self._hr_project()                        # company A's "#General - Human Resources"
        place = self.client.get(f"/hr/checklists/task-place?entity_id={CO_B}").json()
        self.assertEqual((place["effective"]["onboarding"]["projectId"], place["effective"]["onboarding"]["source"]),
                         ("p-hr", "auto"))
        self.assertIn("p-hr", {p["id"] for p in place["projects"]})     # and HR can pick it by hand

    def test_old_per_owner_tasks_fold_into_one_and_the_empty_ones_are_binned(self):
        cl = self._start(self._person())
        db = database.SessionLocal()
        try:                                      # rebuild the Oct 20-22 shape: a parent per owner
            row = db.query(models.HrChecklist).filter_by(id=cl["id"]).one()
            items = db.query(models.HrChecklistItem).filter_by(checklist_id=cl["id"]).all()
            subs = {t.id: t for t in db.query(models.Task).filter(models.Task.id.in_([i.task_id for i in items if i.task_id]))}
            db.query(models.Task).filter_by(id=row.task_id).delete()
            row.task_id = ""
            olds = {}
            for t in subs.values():
                k = ",".join(sorted(t.assignee_emails or []))
                if k not in olds:
                    olds[k] = models.Task(id=f"old-{len(olds)}", title=f"Onboarding: Jane Doe - {k}", hr_checklist=True,
                                          assignee_email=t.assignee_email, assignee_emails=list(t.assignee_emails),
                                          access_level="restricted", subtask_ids=[], created_at="2026-10-21")
                    db.add(olds[k])
                olds[k].subtask_ids = [*olds[k].subtask_ids, t.id]
                t.parent_task_id = olds[k].id
            db.commit()
            old_ids = [o.id for o in olds.values()]
            self.assertGreater(len(old_ids), 1)
            hc.sync_tasks(db, db.query(models.HrChecklist).filter_by(id=cl["id"]).one(), by="nexus")
            db.commit()
            new_id = db.query(models.HrChecklist).filter_by(id=cl["id"]).one().task_id
            self.assertTrue(new_id and new_id not in old_ids)
            self.assertEqual({t.parent_task_id for t in db.query(models.Task).filter(models.Task.id.in_(list(subs)))}, {new_id})
            binned = db.query(models.Task).execution_options(include_deleted=True).filter(models.Task.id.in_(old_ids)).all()
            self.assertTrue(binned and all(t.deleted_at for t in binned))
        finally:
            db.close()

    def test_a_closed_checklist_keeps_its_old_tasks(self):
        cl = self._start(self._person())
        db = database.SessionLocal()
        try:
            row = db.query(models.HrChecklist).filter_by(id=cl["id"]).one()
            old = db.query(models.Task).filter_by(id=row.task_id).one()
            row.task_id, row.status = "", "cancelled"       # closed before Oct 23: no checklist task recorded
            db.commit()
            hc.sync_tasks(db, db.query(models.HrChecklist).filter_by(id=cl["id"]).one(), by="nexus")
            db.commit()
            self.assertEqual(db.query(models.HrChecklist).filter_by(id=cl["id"]).one().task_id, "")
            self.assertFalse(db.query(models.Task).filter_by(id=old.id).one().deleted_at)
        finally:
            db.close()

    # --- Onboarding Audit (Neil, Oct 22: "if the person is an existing
    # employee, we can have an option to do an audit... now you have proof
    # that on this date you had it all").

    def test_an_onboarding_audit_ticks_what_is_on_file_and_tasks_the_rest(self):
        import task_notify
        calls = []
        real = task_notify.queue_bulk_assignments
        task_notify.queue_bulk_assignments = lambda db, by, assigned, send_now_if_instant=False: calls.append(
            {k: [t.id for t in v] for k, v in assigned.items()})
        try:
            done_before = self._person("emp-had", work_email=NEWBIE)
            self._start(done_before)                          # has a record already
            db = database.SessionLocal()
            try:
                for e in db.query(models.NexusEmployee).filter(models.NexusEmployee.id.in_(["staff-2", "staff-3"])):
                    e.start_date, e.employment_type = "2024-03-01", "full_time"
                db.query(models.NexusEmployee).filter_by(id="staff-2").update(
                    {"compliance": {"workAuth": "citizen", "status": "verified"}})
                db.add(models.HrDocument(id="doc-colin", employee_id="staff-2", kind="id", file_name="dl.pdf", storage_path="x"))
                db.commit()
            finally:
                db.close()
            people = {p["id"] for p in self.client.get(f"/hr/checklists/audit/candidates?entity_id={CO_A}").json()["people"]}
            self.assertIn("staff-2", people)
            self.assertNotIn("emp-had", people)               # onboarding status, and a checklist already
            r = self.client.post("/hr/checklists/audit", json={"employee_ids": ["staff-2", "staff-3", done_before]})
            self.assertEqual(r.status_code, 201, r.text)
            self.assertEqual(sorted(x["id"] for x in r.json()["started"]), ["staff-2", "staff-3"])
            self.assertEqual([x["id"] for x in r.json()["skipped"]], [done_before])
            colin = next(x for x in r.json()["started"] if x["id"] == "staff-2")
            self.assertGreaterEqual(colin["onFile"], 2)        # the ID and the verified work authorization
            cl = next(c for c in self.client.get("/hr/checklists/employee/staff-2").json()["checklists"])
            self.assertTrue(cl["audit"])
            self.assertEqual(cl["anchorDate"], hc._today().isoformat())   # counts from the audit
            ids = {i["key"]: i for i in cl["items"]}
            self.assertEqual((ids["ON-23"]["status"], ids["ON-23"]["doneBy"]), ("done", "Nexus"))
            self.assertIn("ID document", ids["ON-23"]["doneReason"])
            self.assertFalse(self._step(ids["ON-23"]["id"]).task_id)      # on file: never a task
            self.assertEqual(ids["ON-34"]["status"], "done")              # the everyone Picture ID step too
            self.assertTrue(self._step(ids["ON-09"]["id"]).task_id)       # missing: a task for its owner
            # one email per person for the lot, not one per checklist
            self.assertEqual(len(calls), 1)
            self.assertIn(MANAGER, calls[0])
            # a second click starts nothing twice
            again = self.client.post("/hr/checklists/audit", json={"employee_ids": ["staff-2", "staff-3"]}).json()
            self.assertEqual((again["started"], len(again["skipped"])), ([], 2))
            # the old start date never moves an audit's dates
            db = database.SessionLocal()
            try:
                db.query(models.NexusEmployee).filter_by(id="staff-2").update({"start_date": "2024-05-01"})
                db.commit()
            finally:
                db.close()
            cl = self.client.get("/hr/checklists/employee/staff-2").json()["checklists"][0]
            self.assertEqual(cl["anchorDate"], hc._today().isoformat())
            # the record: each step, who or what closed it and when, in US dates
            r = self.client.get(f"/hr/checklists/{cl['id']}/record.csv")
            self.assertEqual(r.status_code, 200)
            self.assertIn("Onboarding Audit", r.headers["content-disposition"])
            text = r.text
            self.assertIn("Phase,Step,Owner,Status,Due,Closed By,Closed On,How", text)
            line = next(x for x in text.splitlines() if "Form I-9 Section 2" in x)
            self.assertIn(",Done,", line)
            self.assertIn("Nexus", line)
            self.assertIn(hc.us_date(hc._today().isoformat()), line)
            self.assertIn("An ID document is on file", line)
        finally:
            task_notify.queue_bulk_assignments = real

    def test_an_audit_is_capped_and_needs_someone(self):
        self.assertEqual(self.client.post("/hr/checklists/audit", json={"employee_ids": []}).status_code, 400)
        r = self.client.post("/hr/checklists/audit", json={"employee_ids": [f"x{i}" for i in range(51)]})
        self.assertEqual(r.status_code, 400)
        _as(SCOPED)                               # company B only: company A's people are not found
        r = self.client.post("/hr/checklists/audit", json={"employee_ids": ["staff-2"]})
        self.assertEqual(r.json()["skipped"][0]["reason"], "Not found")


if __name__ == "__main__":
    unittest.main()


class DepartmentOwnerTests(unittest.TestCase):
    """Neil, Oct 22: HR / IT / Accounting steps go to the department's head AND
    backup; a manager step with no manager goes to the department head; and
    nothing is ever left without an owner - the Global Admins are last."""
    setUp = ChecklistTests.setUp
    tearDown = ChecklistTests.tearDown
    _person = ChecklistTests._person
    _start = ChecklistTests._start
    _row = ChecklistTests._row
    _dept = ChecklistTests._dept
    _set_dept = ChecklistTests._set_dept

    def _owners(self, row):
        return sorted(e.strip() for e in (row.get("ownerEmails") or row["ownerEmail"]).split(",") if e.strip()) \
            if isinstance(row.get("ownerEmails"), str) else sorted(row.get("ownerEmails") or [row["ownerEmail"]])

    def test_head_and_backup_own_department_steps(self):
        self._dept("d-hr", "Human Resources", lead=HR, backup=SCOPED)
        self._set_dept("d-it-a", lead_email=MANAGER)
        cl = self._start(self._person())
        self.assertEqual(self._owners(self._row(cl, "ON-20")), sorted([HR, SCOPED]))   # beats the HR contact
        self.assertEqual(self._owners(self._row(cl, "ON-12")), [MANAGER])
        # the packet signer for "HR" is the HR head too, then its backup, then the HR contact
        db = database.SessionLocal()
        try:
            ent = db.query(models.HrEntity).filter_by(id=CO_A).one()
            self.assertEqual(hc.resolve_owner(db, "hr", None, hc.role_owners(db, CO_A), ent), HR)
            db.query(models.NexusEmployee).filter_by(work_email=HR).update({"status": "offboarded"})
            db.commit()
            self.assertEqual(hc.resolve_owner(db, "hr", None, hc.role_owners(db, CO_A), ent), SCOPED)
            db.query(models.NexusEmployee).filter_by(work_email=SCOPED).update({"status": "offboarded"})
            db.commit()
            self.assertEqual(hc.resolve_owner(db, "hr", None, hc.role_owners(db, CO_A), ent), HRC)
        finally:
            db.close()

    def test_nobody_set_goes_to_the_global_admins(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusSetting).delete()
            db.query(models.NexusRole).delete()
            db.add(models.NexusRole(email=HRC, role="owner"))
            db.commit()
        finally:
            db.close()
        try:
            cl = self._start(self._person(company=CO_B))        # no HR contact, no departments, no owners
            self.assertEqual(self._row(cl, "ON-12")["ownerEmail"], HRC)
            self.assertEqual(self._row(cl, "ON-20")["ownerEmail"], HRC)
            self.assertEqual(self._row(cl, "ON-19")["ownerEmail"], "")   # the person's own step waits for them
        finally:
            db = database.SessionLocal()
            db.query(models.NexusRole).delete()
            db.commit()
            db.close()

    def test_no_manager_goes_to_the_department_head_never_to_themselves(self):
        self._dept("d-con", "Construction", lead=MANAGER, backup=IT)
        eid = self._person()
        db = database.SessionLocal()
        try:
            e = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == eid).first()
            e.manager_email, e.department, e.work_email, e.status = "", "Construction", MANAGER + ".x", "onboarding"
            db.commit()
            emp = db.query(models.NexusEmployee).filter(models.NexusEmployee.id == eid).first()
            self.assertEqual(sorted(hc.resolve_owners(db, "manager", emp, {}, None)), sorted([MANAGER, IT]))
            emp.work_email = MANAGER                              # they ARE the head: only the backup
            self.assertEqual(hc.resolve_owners(db, "manager", emp, {}, None), [IT])
        finally:
            db.close()

    def test_a_new_backup_moves_open_steps_and_bad_people_are_refused(self):
        self._dept("d-hr", "Human Resources", lead=HR)
        cl = self._start(self._person())
        self.assertEqual(self._owners(self._row(cl, "ON-20")), [HR])
        r = self.client.patch(f"/hr/entities/{CO_A}/departments/d-hr", json={"backup_email": "nobody@example.com"})
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"/hr/entities/{CO_A}/departments/d-hr", json={"backup_email": HR})
        self.assertEqual(r.status_code, 400)                    # backup is someone else
        r = self.client.patch(f"/hr/entities/{CO_A}/departments/d-hr", json={"backup_email": SCOPED})
        self.assertEqual(r.status_code, 200, r.text)
        again = self.client.get(f"/hr/checklists/employee/{cl['employeeId']}").json()
        rows = [i for c in again["checklists"] for i in c["items"] if i["key"] == "ON-20"]
        self.assertEqual(self._owners(rows[0]), sorted([HR, SCOPED]))

    def test_a_company_picks_which_department_plays_it(self):
        self._dept("d-tech", "Technology", lead=MANAGER)
        r = self.client.put(f"/hr/checklists/owner-departments?entity_id={CO_A}", json={"departments": {"it": "d-tech"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["departments"]["it"]["name"], "Technology")
        self.assertEqual(r.json()["effective"]["it"], [MANAGER])
        cl = self._start(self._person())
        self.assertEqual(self._row(cl, "ON-12")["ownerEmail"], MANAGER)
        r = self.client.put(f"/hr/checklists/owner-departments?entity_id={CO_A}", json={"departments": {"it": "nope"}})
        self.assertEqual(r.status_code, 400)
