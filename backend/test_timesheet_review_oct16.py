"""
Oct 16 2026 (Neil, Charmi, Pranshu, Sagar - call): only the employee signs a
timesheet. On top of test_timesheet_review's real-engine fixture (same
throwaway database):

  * the manager's Review & Approve - a click, no submission needed first; the
    reviewer's list carries closed periods nobody submitted;
  * nothing open on the card when it is approved (pending fixes decide first);
  * any change after approval reopens it (back to the manager), except HR's:
    HR edits at any point, the review stays approved, an envelope out for
    signature is pulled back so the employee signs the edited version;
  * HR unlocking a signed period sends it back for the employee's signature;
  * an edit request pops up for the whole reporting line above the manager;
  * the QuickBooks IIF batch: one company, finalized time cards only;
  * the Payroll list's rows carry company and department for its filters.

    python -m unittest test_timesheet_review_oct16
"""
import os
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, ANCHOR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

from fastapi import HTTPException  # noqa: E402

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402

TOP = "top.ts@greensglobal.com"


class Oct16Case(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.NexusNotification).delete()
        self.db.query(models.PunchRequest).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, HR, TOP])).delete(
            synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.commit()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        super().tearDown()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _bells(self, to):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == to).all()

    def _agreed(self):
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "Looks right")
        return self._r()


class ManagerFirstTests(Oct16Case):
    def test_the_manager_approves_without_a_submission(self):
        r = self._agreed()
        # Neil's flow: the approval sends the envelope straight to the employee.
        self.assertEqual((r.status, r.agreed_by, r.manager_email), ("signing", MGR, MGR))
        self.assertTrue(r.sign_request_id)
        self.assertEqual([e["action"] for e in r.rounds], ["agreed"])
        with self.assertRaises(HTTPException):              # not twice
            tsr.approve_period(self.db, EMP, ANCHOR, MGR)

    def test_approve_route_is_the_managers_not_the_employees(self):
        self._as(EMP)
        r = self.client.post("/timesheet-review/approve", json={"email": EMP, "start": ANCHOR})
        self.assertEqual(r.status_code, 401, r.text)      # "Insufficient permissions" - the level gate
        self._as(MGR)
        r = self.client.post("/timesheet-review/approve", json={"email": EMP, "start": ANCHOR, "note": "ok"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["status"], "signing")
        self.assertFalse(r.json()["canApprove"])

    def test_the_panel_offers_approve_before_any_submission(self):
        view = tsr.state_for(self.db, EMP, self.start, MGR, True)
        self.assertEqual((view["status"], view["canApprove"], view["agreeBlocker"]), ("not_submitted", True, ""))
        self.assertFalse(tsr.state_for(self.db, EMP, self.start, EMP, False)["canApprove"])

    def test_the_reviewer_list_has_closed_periods_nobody_submitted(self):
        ls, le, _pt = tsr.last_closed_period(self.db, EMP)
        self.db.add(models.TimePunch(id="p-last-in", employee_email=EMP, kind="in", at=f"{ls}T16:00:00",
                                     local_date=ls, tz_offset_min=0, created_at=f"{ls}T16:00:00"))
        self.db.add(models.TimePunch(id="p-last-out", employee_email=EMP, kind="out", at=f"{ls}T20:00:00",
                                     local_date=ls, tz_offset_min=0, created_at=f"{ls}T20:00:00"))
        self.db.commit()
        rows = tsr.not_reviewed(self.db, MGR)
        self.assertEqual([(x["employeeEmail"], x["periodStart"], x["notSubmitted"], x["workedMin"]) for x in rows],
                         [(EMP, ls, True, 240)])
        self._as(MGR)
        listed = self.client.get("/timesheet-review/waiting").json()["reviews"]
        self.assertEqual([x["periodStart"] for x in listed if x["notSubmitted"]], [ls])
        tsr.approve_period(self.db, EMP, ls, MGR)
        self.assertEqual(tsr.not_reviewed(self.db, MGR), [])
        self.assertEqual(tsr.not_reviewed(self.db, "someone.else@greensglobal.com"), [])

    def test_a_pending_change_must_be_decided_before_approving(self):
        self.db.add(models.PunchRequest(id="pr-open", employee_email=EMP, employee_name="Erin Test", action="add",
                                        punch_kind="break_start", at=f"{self.start}T19:00:00",
                                        local_date=self.start, tz_offset_min=0, reason="Lunch", status="pending",
                                        created_at=f"{self.start}T23:30:00"))
        self.db.commit()
        msg = tsr.approve_blocker(self.db, EMP, self.start, self.end)
        self.assertIn("1 change waiting for your decision", msg)
        with self.assertRaises(HTTPException) as e:
            tsr.approve_period(self.db, EMP, ANCHOR, MGR)
        self.assertEqual(e.exception.status_code, 409)

    def test_out_for_signature_the_employee_declines_rather_than_resubmits(self):
        self._agreed()
        with self.assertRaises(HTTPException) as e:
            tsr.submit(self.db, EMP, ANCHOR, "Tuesday is short")
        self.assertIn("decline it", e.exception.detail)


class ReopenTests(Oct16Case):
    def test_a_manager_edit_after_agreeing_reopens_it_and_pulls_the_envelope(self):
        rid = self._agreed().sign_request_id
        tsr.guard_edit(self.db, EMP, self.start, MGR)
        self.db.commit()
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id, r.rounds[-1]["action"]), ("with_manager", "", "reopened"))
        self.assertEqual(self.db.get(models.HrSignRequest, rid).status, "voided")
        self.assertEqual(self._bells(EMP)[-1].title, "Time Sheet Back for Review")

    def test_a_dry_run_changes_nothing(self):
        self._agreed()
        tsr.guard_edit(self.db, EMP, self.start, MGR, dry_run=True)
        self.db.commit()
        self.assertEqual(self._r().status, "signing")


class HrOverrideTests(Oct16Case):
    def test_hr_is_the_hr_contact_an_administrator_or_a_full_hr_grant(self):
        self.assertTrue(tsr.is_hr(self.db, HR, EMP))
        self.assertFalse(tsr.is_hr(self.db, MGR, EMP))
        self.assertFalse(tsr.is_hr(self.db, HR, HR))        # never on their own card
        self.db.add(models.NexusRole(email=TOP, role="administrator", assigned_by="test"))
        self.db.commit()
        self.assertTrue(tsr.is_hr(self.db, TOP, EMP))

    def test_hr_editing_while_out_for_signature_asks_the_employee_to_sign_again(self):
        rid = self._agreed().sign_request_id
        tsr.guard_edit(self.db, EMP, self.start, HR)
        tsr.guard_edit(self.db, EMP, self.start, HR)         # a second punch: still one line
        self.db.commit()
        r = self._r()
        # No re-approval: it waits for the employee's signature on HR's version.
        self.assertEqual((r.status, r.sign_request_id), ("approved", ""))
        self.assertEqual([e["action"] for e in r.rounds], ["agreed", "hr_edited"])
        self.assertEqual(self.db.get(models.HrSignRequest, rid).status, "voided")
        self.assertEqual([b.title for b in self._bells(EMP)].count("Time Sheet Updated by HR"), 1)
        view = tsr.state_for(self.db, EMP, self.start, EMP, False)
        self.assertTrue(view["canEmployeeApprove"])
        tsr.employee_approve(self.db, r, EMP)                # a fresh envelope of the edited card
        r = self._r()
        self.assertEqual(r.status, "signing")
        self.assertNotEqual(r.sign_request_id, rid)
        self.assertTrue(any("Hours changed by Hana Test (HR)" in x for x in tsr.approval_log(self.db, r)))

    def test_only_an_hr_edited_timesheet_is_signed_this_way(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        with self.assertRaises(HTTPException) as e:
            tsr.employee_approve(self.db, r, EMP)
        self.assertEqual(e.exception.status_code, 409)

    def test_hr_may_edit_while_it_is_back_with_the_employee(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        tsr.send_back(self.db, r, MGR, "Monday")
        tsr.guard_edit(self.db, EMP, self.start, HR)          # no refusal
        with self.assertRaises(HTTPException):
            tsr.guard_edit(self.db, EMP, self.start, MGR)    # the manager still waits
        self.assertEqual(self._r().status, "with_employee")

    def test_an_unlocked_period_is_reviewable_again(self):
        """Neil's Unlock closes the signed review out as "unlocked"; the
        manager's list offers the period again and a new round signs it."""
        r = self._agreed()
        self._sign(self._parties(r.sign_request_id)["employee"])
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.start, self.end))
        timeclock.unfinalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.start, end=self.end),
                                      user={"email": HR, "level": 4}, db=self.db)
        self.db.expire_all()
        old = self.db.get(models.TimesheetReview, r.id)
        self.assertEqual(old.status, "unlocked")
        tsr.approve_period(self.db, EMP, ANCHOR, MGR, "Corrected")
        self.assertEqual(self._r().status, "signing")


class PopUpTests(Oct16Case):
    def test_an_edit_request_reaches_the_whole_line_above_the_manager(self):
        self.db.query(models.NexusEmployee).filter_by(work_email=MGR).update({"manager_email": TOP})
        self.db.add(models.NexusEmployee(id="id-Top", work_email=TOP, first_name="Tia", last_name="Test",
                                         company=ENTITY, status="active"))
        self.db.add(models.NexusEmployee(id="id-Other", work_email="other.mgr@greensglobal.com",
                                         first_name="Oz", last_name="Test", company=ENTITY, status="active"))
        self.db.commit()
        timeclock._notify_approvers(self.db, employee_email=EMP, title="Time Sheet Fix Requested", body="x")
        self.db.commit()
        to = {n.recipient for n in self.db.query(models.NexusNotification).all()}
        self.assertTrue({MGR, HR, TOP} <= to, to)
        self.assertNotIn(EMP, to)
        self.assertNotIn("other.mgr@greensglobal.com", to)    # never an unrelated manager
        self.assertTrue(all(n.priority == 1 for n in self.db.query(models.NexusNotification).all()))


class EgnyteFilingTests(Oct16Case):
    """The signed PDF is filed in the EMPLOYEE's Egnyte person folder, in
    Timesheets & Attendance (Oct 20) - never the approving manager's work folder (Neil, Oct 16)."""

    def setUp(self):
        super().setUp()
        import egnyte_wiring
        from services import egnyte as svc
        self.made = []
        self._real = [(svc, "configured", svc.configured),
                      (egnyte_wiring, "provision_person_folder", egnyte_wiring.provision_person_folder),
                      (egnyte_wiring, "resolve_person_folder", egnyte_wiring.resolve_person_folder),
                      (egnyte_wiring, "_list_children", egnyte_wiring._list_children)]
        svc.configured = lambda: True
        egnyte_wiring._list_children = lambda parent: []
        egnyte_wiring.provision_person_folder = (
            lambda emp, db: self.made.append(emp.work_email) or f"/Shared/HR/{emp.first_name} {emp.last_name}")
        egnyte_wiring.resolve_person_folder = (
            lambda slot, emp, db: {"folder": f"/Shared/Work/{emp.first_name}", "source": "template"})

    def tearDown(self):
        for obj, name, real in self._real:
            setattr(obj, name, real)
        super().tearDown()

    def _signing_request(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        tsr.approve(self.db, r, MGR)
        return self.db.get(models.HrSignRequest, self._r().sign_request_id)

    def test_it_files_in_the_employees_timesheets_folder(self):
        from routers import esign
        req = self._signing_request()
        self.assertEqual(req.created_by, esign.SYSTEM_SENDER)  # sent by Nexus (Oct 20)...
        self.assertEqual(esign._signed_folder(self.db, req), "/Shared/HR/Erin Test/Timesheets & Attendance")
        self.assertEqual(self.made, [EMP])                     # ...filed under the employee

    def test_no_folder_means_not_filed_never_someone_elses(self):
        import egnyte_wiring
        from routers import esign

        def no_folder(emp, db):
            raise ValueError("no parent folder")
        egnyte_wiring.provision_person_folder = no_folder
        self.assertEqual(esign._signed_folder(self.db, self._signing_request()), "")

    def test_egnyte_off_files_nothing(self):
        from routers import esign
        from services import egnyte as svc
        svc.configured = lambda: False
        self.assertEqual(esign._signed_folder(self.db, self._signing_request()), "")


class PayrollExportTests(Oct16Case):
    def _iif(self, **kw):
        out = timeclock.export_iif(start=self.start, end=self.end, user={"email": HR, "level": 5}, _su={},
                                   db=self.db, **kw)
        return out.body.decode()

    def test_the_iif_batch_takes_finalized_time_cards_of_one_company(self):
        self.assertIn("Erin Test", self._iif(company=ENTITY, finalized_only=False))
        self.assertNotIn("Erin Test", self._iif(company=ENTITY, finalized_only=True))
        timeclock.finalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.start, end=self.end),
                                    user={"email": HR, "level": 4}, db=self.db)
        self.assertIn("Erin Test", self._iif(company=ENTITY, finalized_only=True))
        self.assertNotIn("Erin Test", self._iif(company="another-company", finalized_only=True))

    def test_team_rows_carry_company_and_department(self):
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"department": "Field Ops"})
        self.db.commit()
        out = timeclock.team_timesheet(start=self.start, end=self.end, user={"email": HR, "level": 5}, db=self.db)
        row = next(r for r in out["rows"] if r["email"] == EMP)
        # Pranshu's filter fields (the company's name, the department) plus the
        # company id the per-company IIF asks for.
        self.assertEqual((row["company"], row["department"], row["companyId"]), ("Greens Test Co", "Field Ops", ENTITY))


if __name__ == "__main__":
    unittest.main()
