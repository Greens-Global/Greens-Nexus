"""Second Approval By HR on time off (Neil, Oct 27 2026) - routers/timeclock.py.

With the company's switch on, a manager's approval moves a request to HR
(still pending - balances and the schedule do not count it); HR (the
company's HR contact, an administrator or a Full HR grant) gives the final
word. Nobody approves their own request, the first approver does not approve
the second level, and the employee's bell is one notice updated in place.

Also: the legacy HR Leave writes answer 410, its reads keep working.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_timeoff_second_approval.py -q
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import leave_balances as lb  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

EMP = "sa.emp@greensglobal.com"      # reports to MGR, company CO
MGR = "sa.mgr@greensglobal.com"      # manager (level 3), reports to ADM
HRC = "sa.hrc@greensglobal.com"      # CO's HR contact (no People grant: HR by the contact alone)
ADM = "sa.adm@greensglobal.com"      # administrator
OTHER = "sa.other@greensglobal.com"  # a plain employee elsewhere
EMP2 = "sa.emp2@greensglobal.com"    # company CO2 - the switch is CO's only
CO, CO2, GRANT = "co-sa", "co-sa-2", "grp-sa-hr"
DAY = "2026-11-16"


class SecondApprovalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
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
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        db = database.SessionLocal()
        for m in (models.TimeOffRequest, models.NexusNotification, models.NexusSetting, models.NexusRole,
                  models.HrEntity, models.NexusGroup, models.NexusGroupMember, models.HrLeaveRequest,
                  models.LeaveLedgerEntry, models.PayrollRate):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        db.add(models.HrEntity(id=CO, name="SA Co", hr_contact_email=HRC))
        db.add(models.HrEntity(id=CO2, name="SA Co 2", hr_contact_email=""))
        for em, mgr, co in ((EMP, MGR, CO), (MGR, ADM, CO), (HRC, ADM, CO), (ADM, "", CO),
                            (OTHER, ADM, CO2), (EMP2, MGR, CO2)):
            db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].split("@")[0].title(),
                                        last_name="Test", work_email=em, manager_email=mgr, company=co,
                                        status="active", deleted_at="", start_date="2024-01-01",
                                        employment_type="full_time", country="US"))
        db.add(models.NexusRole(email=MGR, role="manager"))
        db.add(models.NexusRole(email=ADM, role="owner"))
        db.add(models.NexusGroup(id=GRANT, name="sa-hr", allowed_modules="hr:editor"))
        db.commit()
        db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    # ── helpers ──
    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _switch(self, on=True, company=CO):
        self._as(ADM)
        r = self.client.put(f"/timeclock/timeoff/approval-settings?company={company}", json={"secondHr": on})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["secondHr"], on)

    def _request(self, who=EMP, type_="vacation", confidential=False, note="Family trip"):
        self._as(who)
        r = self.client.post("/timeclock/timeoff", json={"type": type_, "start_date": DAY, "end_date": DAY,
                                                          "note": note, "confidential": confidential})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _decide(self, who, rid, status="approved"):
        self._as(who)
        return self.client.patch(f"/timeclock/timeoff/{rid}", json={"status": status, "note": ""})

    def _hr_decide(self, who, rid, status="approved"):
        self._as(who)
        return self.client.post(f"/timeclock/timeoff/{rid}/hr-decision", json={"status": status, "note": ""})

    def _row(self, rid):
        db = database.SessionLocal()
        try:
            return db.get(models.TimeOffRequest, rid)
        finally:
            db.close()

    def _bells(self, who, rid):
        db = database.SessionLocal()
        try:
            return (db.query(models.NexusNotification)
                    .filter(models.NexusNotification.recipient == who, models.NexusNotification.ref_id == rid).all())
        finally:
            db.close()

    # ── the switch ──
    def test_off_by_default_one_approval_is_final(self):
        req = self._request()
        r = self._decide(MGR, req["id"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "approved")
        self.assertFalse(r.json()["awaitingHr"])

    def test_switch_is_per_company_and_admin_or_full_hr_only(self):
        self._as(HRC)     # an HR contact is not Full HR
        r = self.client.put(f"/timeclock/timeoff/approval-settings?company={CO}", json={"secondHr": True})
        self.assertEqual(r.status_code, 403, r.text)
        self._switch(True, CO)
        self._as(ADM)
        self.assertTrue(self.client.get(f"/timeclock/timeoff/approval-settings?company={CO}").json()["secondHr"])
        self.assertFalse(self.client.get(f"/timeclock/timeoff/approval-settings?company={CO2}").json()["secondHr"])
        # A CO2 request is still one approval.
        req = self._request(EMP2)
        self.assertEqual(self._decide(MGR, req["id"]).json()["status"], "approved")

    # ── the flow ──
    def test_manager_then_hr(self):
        self._switch(True)
        req = self._request()
        r = self._decide(MGR, req["id"])
        self.assertEqual(r.status_code, 200, r.text)
        out = r.json()
        self.assertEqual((out["status"], out["stage"], out["awaitingHr"]), ("pending", "hr", True))
        self.assertEqual(out["statusLabel"], "Awaiting HR Approval")
        self.assertEqual(out["firstApprover"], MGR)
        # The employee sees it waiting for HR; one bell for the workflow.
        self._as(EMP)
        mine = next(x for x in self.client.get("/timeclock/timeoff/mine").json() if x["id"] == req["id"])
        self.assertEqual(mine["statusLabel"], "Awaiting HR Approval")
        emp_bells = self._bells(EMP, req["id"])
        self.assertEqual([b.title for b in emp_bells], ["Time Off Awaiting HR Approval"])
        # HR hears it; HR's queue lists it.
        self.assertTrue(any(b.title == "Time-Off Request Awaiting HR Approval" for b in self._bells(HRC, req["id"])))
        self._as(HRC)
        self.assertEqual([x["id"] for x in self.client.get("/timeclock/timeoff/awaiting-hr").json()], [req["id"]])
        # HR approves: final.
        r = self._hr_decide(HRC, req["id"])
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["status"], r.json()["approver"]), ("approved", HRC))
        # Same single employee bell, updated in place.
        emp_bells = self._bells(EMP, req["id"])
        self.assertEqual(len(emp_bells), 1)
        self.assertEqual(emp_bells[0].title, "Time Off Approved")
        self.assertIn("by HR", emp_bells[0].body)
        # The manager hears HR's word; HR's own ask is closed.
        self.assertTrue(any(b.title == "Time Off Approved by HR" for b in self._bells(MGR, req["id"])))
        self.assertTrue(all(b.actioned for b in self._bells(HRC, req["id"])))
        self._as(HRC)
        self.assertEqual(self.client.get("/timeclock/timeoff/awaiting-hr").json(), [])

    def test_hr_rejects(self):
        self._switch(True)
        req = self._request()
        self._decide(MGR, req["id"])
        r = self._hr_decide(ADM, req["id"], "rejected")     # an administrator is HR too
        self.assertEqual(r.json()["status"], "rejected")
        self.assertEqual([b.title for b in self._bells(EMP, req["id"])], ["Time Off Rejected"])

    def test_manager_rejecting_is_final(self):
        self._switch(True)
        req = self._request()
        self.assertEqual(self._decide(MGR, req["id"], "rejected").json()["status"], "rejected")

    def test_a_manager_who_is_hr_approves_both_levels(self):
        self._switch(True)
        self._as(ADM)
        # MGR asks; their manager is ADM, an administrator - HR for MGR.
        req = self._request(MGR)
        r = self._decide(ADM, req["id"])
        self.assertEqual((r.json()["status"], r.json()["awaitingHr"]), ("approved", False))

    # ── who may decide ──
    def test_only_hr_decides_the_second_level(self):
        self._switch(True)
        req = self._request()
        self._decide(MGR, req["id"])
        # The manager approved the first level: not again, on either door.
        self.assertEqual(self._decide(MGR, req["id"]).status_code, 403)
        self.assertEqual(self._hr_decide(MGR, req["id"]).status_code, 403)
        # Not a plain employee.
        self.assertEqual(self._hr_decide(OTHER, req["id"]).status_code, 403)
        self.assertEqual(self._row(req["id"]).status, "pending")
        # HR through the manager's PATCH door works too (an administrator).
        self.assertEqual(self._decide(ADM, req["id"]).json()["status"], "approved")

    def test_nobody_approves_their_own(self):
        self._switch(True)
        # The HR contact's own request: their manager approves the first
        # level (ADM is HR, so it is final) - HRC never decides it.
        req = self._request(HRC)
        self.assertEqual(self._hr_decide(HRC, req["id"]).status_code, 409)   # not waiting for HR yet
        self.assertIn(self._decide(HRC, req["id"]).status_code, (401, 403))
        # Their manager (an administrator, HR for them) approves: final.
        self.assertEqual(self._decide(ADM, req["id"]).json()["status"], "approved")

    def test_hr_door_needs_the_hr_stage(self):
        req = self._request()
        self.assertEqual(self._hr_decide(HRC, req["id"]).status_code, 409)

    def test_confidential_reason_reaches_hr_at_its_turn(self):
        self._switch(True)
        req = self._request(type_="sick", confidential=True, note="Private detail")
        self._decide(MGR, req["id"])
        self._as(HRC)
        row = next(x for x in self.client.get("/timeclock/timeoff/awaiting-hr").json() if x["id"] == req["id"])
        self.assertEqual(row["note"], "Private detail")
        self.assertFalse(row["redacted"])

    # ── what counts ──
    def test_balance_counts_it_only_once_fully_approved(self):
        db = database.SessionLocal()
        lb.set_cutover(db, "2026-01-01", ADM)
        db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", hourly_rate=20.0,
                                  overtime_rule="ca", currency="USD"))
        db.commit()
        db.close()
        self._switch(True)
        req = self._request()
        self._decide(MGR, req["id"])
        db = database.SessionLocal()
        from datetime import date
        b = lb.balances(db, EMP, today=date(2026, 11, 1))
        self.assertEqual((b["vacation"]["upcoming"], b["vacation"]["pending"]), (0, 8))
        db.close()
        self._hr_decide(HRC, req["id"])
        db = database.SessionLocal()
        b = lb.balances(db, EMP, today=date(2026, 11, 1))
        self.assertEqual((b["vacation"]["upcoming"], b["vacation"]["pending"]), (8, 0))
        db.close()

    def test_cancel_while_waiting_for_hr(self):
        self._switch(True)
        req = self._request()
        self._decide(MGR, req["id"])
        self._as(EMP)
        r = self.client.post(f"/timeclock/timeoff/{req['id']}/cancel")
        self.assertEqual(r.json()["status"], "cancelled")
        self.assertTrue(all(b.actioned for b in self._bells(HRC, req["id"])))
        self.assertTrue(all(b.actioned for b in self._bells(EMP, req["id"])))

    # ── team leave calendar ──
    def test_calendar_scopes(self):
        self._switch(True)
        a = self._request(EMP, type_="sick", confidential=True)
        self._decide(MGR, a["id"])                   # waiting for HR
        b = self._request(EMP2)
        self._decide(MGR, b["id"])                   # CO2: approved
        # The manager sees both of their reports in full - the confidential
        # one with its kind of leave too: the manager is its approver.
        self._as(MGR)
        cal = self.client.get("/timeclock/timeoff/calendar?month=2026-11").json()
        by = {e["id"]: e for e in cal["entries"]}
        self.assertEqual(by[a["id"]]["label"], "Sick")
        self.assertTrue(by[a["id"]]["awaitingHr"])
        self.assertEqual(by[b["id"]]["status"], "approved")
        # A teammate (EMP2 shares EMP's manager) sees approved leave only, as "Out".
        self._as(EMP2)
        cal = self.client.get("/timeclock/timeoff/calendar?month=2026-11").json()
        by = {e["id"]: e for e in cal["entries"]}
        self.assertNotIn(a["id"], by)                # pending: not theirs to see
        self.assertEqual(by[b["id"]]["label"], "Vacation")   # their own
        self._hr_decide(HRC, a["id"])
        self._as(EMP2)
        cal = self.client.get("/timeclock/timeoff/calendar?month=2026-11").json()
        by = {e["id"]: e for e in cal["entries"]}
        self.assertEqual(by[a["id"]]["label"], "Out")
        # Someone outside the team sees nothing of EMP's.
        self._as(OTHER)
        cal = self.client.get("/timeclock/timeoff/calendar?month=2026-11").json()
        self.assertNotIn(a["id"], {e["id"] for e in cal["entries"]})

    def test_calendar_confidential_is_out_for_hr_after_the_fact_and_holidays(self):
        db = database.SessionLocal()
        db.add(models.HrCompanyHoliday(id="h-sa", company_id=CO, date="2026-11-26", name="Thanksgiving",
                                       type="mandatory", country_code=""))
        db.commit()
        db.close()
        a = self._request(EMP, type_="sick", confidential=True)
        self._decide(MGR, a["id"])                   # switch off: approved by the manager
        self._as(HRC)                                # HR contact: the whole company, but not the reason
        cal = self.client.get("/timeclock/timeoff/calendar?month=2026-11").json()
        self.assertEqual(cal["scope"], "company")
        by = {e["id"]: e for e in cal["entries"]}
        self.assertEqual(by[a["id"]]["label"], "Out")
        self.assertIn({"date": "2026-11-26", "name": "Thanksgiving", "type": "mandatory"}, cal["holidays"])
        self.assertEqual(self.client.get("/timeclock/timeoff/calendar?month=bad").status_code, 400)

    # ── the legacy HR Leave tracker ──
    def test_legacy_leave_writes_are_gone_reads_stay(self):
        db = database.SessionLocal()
        db.add(models.HrLeaveRequest(id="old-1", employee_id=f"emp-{EMP}", leave_type="annual",
                                     start_date="2026-03-02", end_date="2026-03-03", days=2, status="approved"))
        db.commit()
        db.close()
        self._as(ADM)
        r = self.client.post("/hr/leave", json={"employee_id": f"emp-{EMP}", "leave_type": "annual",
                                                "start_date": "2026-12-01", "days": 1})
        self.assertEqual(r.status_code, 410, r.text)
        self.assertIn("Time Off", r.json()["detail"])
        self.assertEqual(self.client.patch("/hr/leave/old-1", json={"action": "approve"}).status_code, 410)
        self.assertEqual(self.client.put("/hr/leave/balances", json={"employee_id": f"emp-{EMP}", "year": 2026,
                                                                     "leave_type": "annual", "allocated": 5}).status_code, 410)
        rows = self.client.get("/hr/leave").json()
        self.assertEqual([x["id"] for x in rows], ["old-1"])
        self.assertEqual(self.client.get(f"/hr/leave/balances/emp-{EMP}?year=2026").status_code, 200)
        db = database.SessionLocal()
        self.assertEqual(db.query(models.HrLeaveRequest).count(), 1)
        db.close()


if __name__ == "__main__":
    unittest.main()
