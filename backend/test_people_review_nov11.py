"""People module review (11/11/2026) - the fixes, pinned.

- Overview's Employee Code saves (it was dropped by the PATCH model), never
  blank and never one another person holds.
- A work email belongs to one person: create and PATCH refuse a second.
- A PATCH may not name a manager outside the caller's People access.
- The field audit masks the contractor block (it carries the rate).
- Old Ask HR requests are HR's: a People editor grant alone reads none.
- A mailbox export is offboarding only, and every start / download is audited.
- Unassigning a job role someone does not hold leaves their tier alone.
- The Directory's Company Holiday follows the holiday's countries.
- The hover card (/myhr/person) keeps the company wall.
- Records Audit lists employees only - never guests / externals.
- Probation reads a comma list of HR contacts.

    python -m pytest test_people_review_nov11.py
"""
import json
import os
import tempfile
import unittest
from datetime import datetime
from unittest import mock
from zoneinfo import ZoneInfo

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
SUPER, EDITOR, ADA, BEN, CARL, GUEST = (f"super{D}", f"eddie.editor{D}", f"ada{D}", f"ben{D}", f"carl{D}",
                                       "gus@partner.com")
A, B = "co-a", "co-b"
TODAY = datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()


class PeopleReviewTests(unittest.TestCase):
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
                  models.HrEntity, models.HrSelfRequest, models.HrMailboxExport, models.HrCompanyHoliday,
                  models.NexusSetting):
            db.query(m).execution_options(include_deleted=True).delete()
        db.add(models.HrEntity(id=A, name="Co A", country="US", hr_contact_email=f"hr1{D}, {ADA}"))
        db.add(models.HrEntity(id=B, name="Co B", country="US"))
        for eid, em, co, code, ctry in (("e-ada", ADA, A, "GG-001", "US"), ("e-ben", BEN, A, "GG-002", "IN"),
                                        ("e-carl", CARL, B, "GG-003", "US"), ("e-ed", EDITOR, A, "GG-004", "US")):
            db.add(models.NexusEmployee(id=eid, first_name=em.split("@")[0].split(".")[0].title(), last_name="T",
                                        work_email=em, company=co, employee_code=code, status="active",
                                        country=ctry, state="CA" if ctry == "US" else "", deleted_at=""))
        db.add(models.NexusEmployee(id="e-gus", first_name="Gus", last_name="Guest", work_email=GUEST, company=A,
                                    employee_code="GG-005", status="active", identity_type="guest", deleted_at=""))
        db.add(models.NexusRole(email=SUPER, role="owner", display_name="Sue"))
        db.add(models.NexusGroup(id="g-ed", name="People Editors", allowed_modules="hr:editor"))
        db.add(models.NexusGroupMember(group_id="g-ed", email=EDITOR))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        cache.settings_config.invalidate()
        cache.contact_directory.invalidate()
        auth._role_cache.clear()
        self.as_(SUPER)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        os.environ.pop("NEXUS_DEV_EMAIL", None)

    def as_(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _db(self):
        return database.SessionLocal()

    # ── the profile save ─────────────────────────────────────────────────────
    def test_employee_code_saves_and_stays_unique(self):
        r = self.client.patch("/hr/employees/e-ben", json={"employee_code": "QB-77"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["employeeCode"], "QB-77")
        r = self.client.patch("/hr/employees/e-ben", json={"employee_code": "GG-001"})
        self.assertEqual(r.status_code, 409, r.text)
        r = self.client.patch("/hr/employees/e-ben", json={"employee_code": "  "})
        self.assertEqual(r.status_code, 400, r.text)
        r = self.client.patch("/hr/employees/e-ben", json={"employee_code": "QB-77", "job_title": "Lead"})
        self.assertEqual(r.status_code, 200, r.text)        # its own code again is fine

    def test_a_work_email_belongs_to_one_person(self):
        r = self.client.patch("/hr/employees/e-ben", json={"work_email": ADA.upper()})
        self.assertEqual(r.status_code, 409, r.text)
        r = self.client.post("/hr/employees", json={"first_name": "Dup", "work_email": CARL, "company": B})
        self.assertEqual(r.status_code, 409, r.text)
        r = self.client.patch("/hr/employees/e-ben", json={"work_email": BEN})
        self.assertEqual(r.status_code, 200, r.text)        # unchanged is fine

    def test_a_manager_outside_the_callers_people_access_is_refused(self):
        db = self._db()
        db.add(models.NexusSetting(key="company_walls", value="on"))
        db.commit()
        db.close()
        cache.settings_config.invalidate()
        self.as_(EDITOR)                                    # People editor, walled to Co A
        r = self.client.patch("/hr/employees/e-ben", json={"manager_email": CARL})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("outside your People access", r.json()["detail"])
        r = self.client.patch("/hr/employees/e-ben", json={"manager_email": ADA})
        self.assertEqual(r.status_code, 200, r.text)

    def test_the_field_audit_masks_the_contractor_rate(self):
        r = self.client.patch("/hr/employees/e-ben", json={"contractor": {"rate": "85", "rate_type": "hourly"}})
        self.assertEqual(r.status_code, 200, r.text)
        db = self._db()
        row = db.query(models.AuditLog).filter(models.AuditLog.action == "Changed employee fields").first()
        db.close()
        self.assertEqual(json.loads(row.details)["changes"]["contractor"], "(changed)")
        self.assertNotIn("85", row.details)

    # ── Ask HR ───────────────────────────────────────────────────────────────
    def test_old_ask_hr_requests_are_hrs_only(self):
        db = self._db()
        db.add(models.HrSelfRequest(id="rq1", employee_email=BEN, employee_name="Ben", message="private matter",
                                    status="open", created_at="2026-11-01T00:00:00"))
        db.commit()
        db.close()
        self.as_(EDITOR)
        self.assertEqual(self.client.get("/hr/requests").json(), [])
        r = self.client.patch("/hr/requests/rq1", json={"response": "done"})
        self.assertEqual(r.status_code, 404, r.text)
        self.as_(ADA)                                       # Co A's HR contact (second in the comma list)
        db = self._db()
        db.add(models.NexusGroupMember(group_id="g-ed", email=ADA))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        self.assertEqual([x["id"] for x in self.client.get("/hr/requests").json()], ["rq1"])
        self.as_(SUPER)
        self.assertEqual([x["id"] for x in self.client.get("/hr/requests").json()], ["rq1"])

    # ── mailbox export ───────────────────────────────────────────────────────
    def test_a_mailbox_export_is_offboarding_only_and_audited(self):
        db = self._db()
        db.query(models.NexusEmployee).filter_by(id="e-ben").update({"m365_id": "m-ben"})
        db.commit()
        db.close()
        with mock.patch("routers.hr._run_mailbox_export") as run:
            r = self.client.post("/hr/employees/e-ben/mailbox-export")
            self.assertEqual(r.status_code, 409, r.text)
            run.assert_not_called()
            db = self._db()
            db.query(models.NexusEmployee).filter_by(id="e-ben").update({"status": "inactive"})
            db.commit()
            db.close()
            r = self.client.post("/hr/employees/e-ben/mailbox-export")
            self.assertEqual(r.status_code, 200, r.text)
        db = self._db()
        actions = [a for (a,) in db.query(models.AuditLog.action).filter(models.AuditLog.resource_id == "e-ben")]
        db.close()
        self.assertIn("Started a mailbox export", actions)

    # ── job roles ────────────────────────────────────────────────────────────
    def test_unassigning_a_role_they_do_not_hold_keeps_their_tier(self):
        db = self._db()
        db.add(models.NexusGroup(id="jr-site", name="Site Manager", is_job_role=1, tier="manager", company_id=A))
        db.add(models.NexusGroup(id="jr-clerk", name="Clerk", is_job_role=1, tier="employee", company_id=A))
        db.add(models.NexusGroupMember(group_id="jr-site", email=BEN))
        db.add(models.NexusRole(email=BEN, role="manager"))
        db.commit()
        db.close()
        r = self.client.post("/jobroles/jr-clerk/unassign", json={"email": BEN, "reason": "stale screen"})
        self.assertEqual(r.status_code, 409, r.text)
        db = self._db()
        self.assertEqual(db.query(models.NexusRole).filter_by(email=BEN).first().role, "manager")
        db.close()

    # ── Directory holidays ───────────────────────────────────────────────────
    def test_a_us_holiday_is_not_a_day_off_in_india(self):
        db = self._db()
        db.add(models.HrCompanyHoliday(id="h1", company_id=A, date=TODAY, name="Thanksgiving", country_code="US",
                                       source="public"))
        db.commit()
        db.close()
        self.as_(ADA)
        by = {p["email"]: p for p in self.client.get("/directory").json()["people"]}
        self.assertEqual(by[ADA]["availability"]["label"], "Company Holiday")
        self.assertIsNone(by[BEN]["availability"])          # India: Thanksgiving is not theirs

    # ── hover card ───────────────────────────────────────────────────────────
    def test_the_hover_card_keeps_the_company_wall(self):
        db = self._db()
        db.add(models.NexusSetting(key="company_walls", value="on"))
        db.commit()
        db.close()
        cache.settings_config.invalidate()
        self.as_(BEN)
        self.assertEqual(self.client.get("/myhr/person", params={"q": "ada"}).status_code, 200)
        self.assertEqual(self.client.get("/myhr/person", params={"q": CARL}).status_code, 404)

    # ── Records Audit / probation ────────────────────────────────────────────
    def test_records_audit_lists_employees_only(self):
        import hr_record_audit
        db = self._db()
        try:
            ids = {row["id"] for row in hr_record_audit.company_report(db)}
        finally:
            db.close()
        self.assertIn("e-ben", ids)
        self.assertNotIn("e-gus", ids)

    def test_probation_reads_a_comma_list_of_hr_contacts(self):
        import hr_probation
        db = self._db()
        try:
            ben = db.query(models.NexusEmployee).filter_by(id="e-ben").first()
            self.assertEqual(hr_probation.hr_recipients(db, ben), [f"hr1{D}", ADA])
            self.assertTrue(hr_probation.is_hr_plus(db, {"email": ADA, "level": 1}, ben))
            self.assertEqual(hr_probation.hr_contact(db, ben), f"hr1{D}")
        finally:
            db.close()


    # ── Neil, 11/11/2026: "fix what you think" ───────────────────────────────
    def test_only_wide_hr_sets_the_hr_contact_or_signatory(self):
        self.as_(EDITOR)                                    # People editor, not Full People
        r = self.client.patch(f"/hr/entities/{A}", json={"hr_contact_email": EDITOR})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.patch(f"/hr/entities/{A}", json={"signatory_email": EDITOR})
        self.assertEqual(r.status_code, 403, r.text)
        r = self.client.patch(f"/hr/entities/{A}", json={"hr_contact_email": f"{ADA},hr1{D}", "notes": "x"})
        self.assertEqual(r.status_code, 200, r.text)        # the form's own copy back is fine
        self.as_(SUPER)
        r = self.client.patch(f"/hr/entities/{A}", json={"hr_contact_email": "nobody@greensglobal.com"})
        self.assertEqual(r.status_code, 400, r.text)        # an active person in People, never a free email
        r = self.client.patch(f"/hr/entities/{A}", json={"hr_contact_email": BEN})
        self.assertEqual(r.status_code, 200, r.text)

    def _contractor(self):
        db = self._db()
        db.query(models.NexusEmployee).filter_by(id="e-ben").update(
            {"contractor": {"rate": "85", "rate_type": "hourly", "currency": "USD", "invoice_next_number": 7,
                            "scope": "Dev"}})
        db.commit()
        db.close()

    def test_a_contractors_rate_is_pay(self):
        self._contractor()
        self.as_(EDITOR)
        ben = next(p for p in self.client.get("/hr/employees").json() if p["id"] == "e-ben")
        self.assertNotIn("rate", ben["contractor"])
        self.assertEqual(ben["contractor"]["scope"], "Dev")
        r = self.client.patch("/hr/employees/e-ben", json={"contractor": {"scope": "Ops"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertNotIn("rate", r.json()["contractor"])
        r = self.client.patch("/hr/employees/e-ben", json={"contractor": {"rate": "120"}})
        self.assertEqual(r.status_code, 403, r.text)
        db = self._db()
        c = db.query(models.NexusEmployee).filter_by(id="e-ben").first().contractor
        db.close()
        self.assertEqual((c["rate"], c["scope"]), ("85", "Ops"))   # kept, and the edit landed
        self.as_(SUPER)
        ben = next(p for p in self.client.get("/hr/employees").json() if p["id"] == "e-ben")
        self.assertEqual(ben["contractor"]["rate"], "85")

    def test_a_record_block_is_merged_not_replaced(self):
        self._contractor()
        db = self._db()
        db.query(models.NexusEmployee).filter_by(id="e-ben").update(
            {"personal": {"dob": "1990-01-01", "emergency": {"name": "Sam"}}})
        db.commit()
        db.close()
        r = self.client.patch("/hr/employees/e-ben", json={"contractor": {"contract_end": "2027-01-31"},
                                                          "personal": {"gender": "Male"}})
        self.assertEqual(r.status_code, 200, r.text)
        db = self._db()
        e = db.query(models.NexusEmployee).filter_by(id="e-ben").first()
        c, p = e.contractor, e.personal
        db.close()
        self.assertEqual((c["invoice_next_number"], c["contract_end"]), (7, "2027-01-31"))
        self.assertEqual(p, {"dob": "1990-01-01", "emergency": {"name": "Sam"}, "gender": "Male"})

    def test_a_status_set_by_the_profile_save_is_logged_and_fires(self):
        with mock.patch("routers.hr.workflows.emit") as emit:
            r = self.client.patch("/hr/employees/e-ben", json={"status": "inactive"})
        self.assertEqual(r.status_code, 200, r.text)
        db = self._db()
        log = db.query(models.NexusEmployee).filter_by(id="e-ben").first().status_log
        db.close()
        self.assertEqual((log[0]["from"], log[0]["to"], log[0]["by"]), ("active", "inactive", SUPER))
        self.assertIn("employee.status_changed", [c.args[1] for c in emit.call_args_list])

    def test_a_late_declined_recommendation_waits_for_hr(self):
        import hr_probation
        from datetime import timedelta
        past = (datetime.now(ZoneInfo("America/Los_Angeles")).date() - timedelta(days=5)).isoformat()
        db = self._db()
        try:
            ben = db.query(models.NexusEmployee).filter_by(id="e-ben").first()
            ben.probation = {"status": "in_probation", "startDate": "2026-05-01", "endDate": past,
                             "pending": {"decision": "confirm", "by": ADA, "at": "2026-11-01T00:00:00"}, "log": []}
            db.commit()
            hr_probation.decline_pending(db, {"email": SUPER, "level": 5, "role": "owner"}, ben, "not yet")
            db.refresh(ben)
            today = hr_probation._today()
            self.assertFalse(hr_probation._passable(ben, today))     # no automatic pass tomorrow
            rec = dict(ben.probation)
            rec["endDate"] = (datetime.fromisoformat(past) - timedelta(days=1)).date().isoformat()
            ben.probation = rec
            db.commit()
            self.assertTrue(hr_probation._passable(ben, today))      # a new end date lifts the hold
        finally:
            db.close()

    def test_a_mailbox_export_retries_and_lists_what_it_could_not_read(self):
        import httpx
        import zipfile
        from routers import hr as hr_router
        db = self._db()
        db.add(models.HrMailboxExport(id="job1", employee_id="e-ben", requested_by=SUPER, status="pending",
                                      created_at="2026-11-11T00:00:00", updated_at="2026-11-11T00:00:00"))
        db.commit()
        db.close()
        calls = {"list": 0}
        saved = {}

        def get(url, headers=None, timeout=None):
            req = httpx.Request("GET", url)
            if url.endswith("$count"):
                return httpx.Response(200, text="2", request=req)
            if "/messages?" in url:
                calls["list"] += 1
                if calls["list"] == 1:                       # the token ran out mid-export
                    return httpx.Response(401, request=req)
                return httpx.Response(200, json={"value": [{"id": "m1", "subject": "Kept"},
                                                           {"id": "m2", "subject": "Broken"}]}, request=req)
            if "/m1/" in url:
                return httpx.Response(200, content=b"mime-1", request=req)
            return httpx.Response(503, request=req)          # never comes back

        def post(url, headers=None, content=None, timeout=None):
            saved["bytes"] = b"".join(content)
            return httpx.Response(200, request=httpx.Request("POST", url))

        with mock.patch.object(hr_router.httpx, "get", side_effect=get), \
             mock.patch.object(hr_router.httpx, "post", side_effect=post), \
             mock.patch.object(hr_router, "_graph_token", return_value="tok") as tok, \
             mock.patch.object(hr_router, "_storage_headers", return_value={}), \
             mock.patch.object(hr_router, "_SUPABASE_URL", "https://storage.test"), \
             mock.patch.object(hr_router.time, "sleep"):
            hr_router._run_mailbox_export("job1", "m-ben")
        self.assertEqual(tok.call_count, 2)                  # renewed once
        db = self._db()
        job = db.query(models.HrMailboxExport).filter_by(id="job1").first()
        db.close()
        self.assertEqual(job.status, "done", job.message)
        self.assertEqual(job.message, "1 message exported; 1 could not be read (listed in SKIPPED.txt)")
        import io
        names = zipfile.ZipFile(io.BytesIO(saved["bytes"])).namelist()
        self.assertIn("SKIPPED.txt", names)
        self.assertEqual(len(names), 2)


if __name__ == "__main__":
    unittest.main()
