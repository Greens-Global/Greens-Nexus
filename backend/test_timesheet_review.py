"""Timesheet review + Nexus Sign (Sep 2026) - timesheet_review.py end to end.

The journey Sagar set out: employee submits -> manager sends back -> employee
resubmits -> manager agrees -> Nexus Sign: employee signs, manager signs, the
company's HR contact signs -> the period is finalized for payroll. Plus the
ways back (a decline returns it to whoever declined, HR's to the manager, a
void to the manager) and the lock that lets one side edit at a time.

Runs the REAL Nexus Sign engine (consent, one-time code, sealing) against its
own temporary database.

Run with: python -m unittest test_timesheet_review -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import esign, timeclock  # noqa: E402

EMP, MGR, HR = "emp.ts@greensglobal.com", "mgr.ts@greensglobal.com", "hr.ts@greensglobal.com"
ENTITY = "ent-ts-review"
# A pay period that is fully over, so the manager may agree to it.
ANCHOR = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")


class ReviewCase(unittest.TestCase):
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
        self.db = database.SessionLocal()
        for m in (models.TimesheetReview, models.TimePunch, models.TimeApproval, models.HrSignParty,
                  models.HrSignRequest, models.HrSignConsent, models.HrSignDocument, models.HrSignSeal,
                  models.HrSignOtpChallenge, models.NexusEmployee, models.HrEntity, models.PayrollRate):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENTITY, name="Greens Test Co", hr_contact_email=HR))
        for email, first, mgr in ((EMP, "Erin", MGR), (MGR, "Max", ""), (HR, "Hana", "")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first,
                                             last_name="Test", company=ENTITY, manager_email=mgr,
                                             status="active"))
        self.start, self.end = timeclock._pay_period(ANCHOR)
        self._punch(self.start, "in", "16:00:00")
        self._punch(self.start, "out", "23:00:00")
        self.db.commit()
        esign._ensure_document_classes(self.db)
        # Mail and archiving are side effects; capture the one-time codes.
        self.codes = {}
        self._patched = [(esign.sign_otp, "_send_email", esign.sign_otp._send_email),
                         (esign, "_send_sign_email", esign._send_sign_email),
                         (esign, "_send_sealed_email", esign._send_sealed_email),
                         (esign, "_egnyte_push", esign._egnyte_push)]
        esign.sign_otp._send_email = lambda to, code, title, sender: self.codes.__setitem__(to, code) or ""
        esign._send_sign_email = lambda *a, **k: (True, "")
        esign._send_sealed_email = lambda *a, **k: (True, "")
        esign._egnyte_push = lambda *a, **k: (False, "")

    def tearDown(self):
        for obj, name, real in self._patched:
            setattr(obj, name, real)
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _punch(self, day, kind, hhmm):
        self.db.add(models.TimePunch(id=f"p-{day}-{kind}-{hhmm}", employee_email=EMP, kind=kind,
                                     at=f"{day}T{hhmm}", local_date=day, tz_offset_min=0,
                                     created_at=f"{day}T{hhmm}"))

    def _r(self):
        self.db.expire_all()
        return tsr.active_review(self.db, EMP, self.start)

    def _parties(self, rid):
        self.db.expire_all()
        return {p.role_key: p for p in self.db.query(models.HrSignParty)
                .filter(models.HrSignParty.request_id == rid).all()}

    def _sign(self, party):
        c = self.client
        self.assertEqual(c.post(f"/esign/public/{party.token}/consent", json={"agreed": True}).status_code, 200)
        self.assertEqual(c.post(f"/esign/public/{party.token}/otp/request", json={"channel": "email"}).status_code, 200)
        r = c.post(f"/esign/public/{party.token}/otp/verify", json={"code": self.codes[party.email]})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post(f"/esign/public/{party.token}/sign", json={
            "consent": True, "signature_kind": "typed", "signature_data": party.name,
            "format_demonstrated": "pdf_rendered_in_session", "pages_viewed": 2, "pages_total": 2})
        self.assertEqual(r.status_code, 200, r.text)

    def _decline(self, party, reason):
        c = self.client
        c.post(f"/esign/public/{party.token}/consent", json={"agreed": True})
        r = c.post(f"/esign/public/{party.token}/decline", json={"reason": reason})
        self.assertEqual(r.status_code, 200, r.text)

    def _to_signing(self):
        r = tsr.submit(self.db, EMP, ANCHOR, "All in")
        tsr.agree(self.db, r, MGR, "Looks right")
        return self._r()


class ReviewLoopTests(ReviewCase):
    def test_submit_send_back_resubmit(self):
        r = tsr.submit(self.db, EMP, ANCHOR, "First pass")
        self.assertEqual((r.status, r.manager_email), ("with_manager", MGR))
        tsr.send_back(self.db, r, MGR, "Tuesday is missing a lunch")
        self.assertEqual(self._r().status, "with_employee")
        # The employee fixes it (a new punch) and resubmits - the round shows what moved.
        self._punch(self.start, "out", "23:30:00")
        self.db.query(models.TimePunch).filter_by(id=f"p-{self.start}-out-23:00:00").delete()
        self.db.commit()
        r = tsr.submit(self.db, EMP, ANCHOR, "Fixed")
        self.assertEqual(r.status, "with_manager")
        actions = [e["action"] for e in r.rounds]
        self.assertEqual(actions, ["submitted", "sent_back", "resubmitted"])
        self.assertEqual(r.rounds[-1]["changes"], [{"date": self.start, "before": 420, "after": 450}])

    def test_sending_back_needs_a_note(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        with self.assertRaises(HTTPException) as e:
            tsr.send_back(self.db, r, MGR, "  ")
        self.assertEqual(e.exception.status_code, 422)

    def test_one_side_edits_at_a_time(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        with self.assertRaises(HTTPException):
            tsr.guard_edit(self.db, EMP, self.start, EMP)      # with the manager: employee locked
        tsr.guard_edit(self.db, EMP, self.start, MGR)          # manager may edit
        tsr.send_back(self.db, r, MGR, "Please check Monday")
        tsr.guard_edit(self.db, EMP, self.start, EMP)          # back with the employee
        with self.assertRaises(HTTPException):
            tsr.guard_edit(self.db, EMP, self.start, MGR)

    def test_no_manager_means_nobody_to_submit_to(self):
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"manager_email": ""})
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual(e.exception.status_code, 409)

    def test_agreeing_needs_an_hr_contact(self):
        self.db.query(models.HrEntity).update({"hr_contact_email": ""})
        self.db.commit()
        r = tsr.submit(self.db, EMP, ANCHOR)
        with self.assertRaises(HTTPException) as e:
            tsr.agree(self.db, r, MGR)
        self.assertIn("HR contact", e.exception.detail)

    def test_fixed_salary_month_goes_through_the_same_review(self):
        # A salaried (monthly) employee reviews the calendar month, not the
        # bi-weekly period - same submit / agree chain (Charmi, Sep 30 - A6).
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="fixed", currency="INR",
                                       monthly_salary=30000, full_day_hours=8, overtime_rule="none"))
        self.db.commit()
        start, end, pay_type = tsr.period_for(self.db, EMP, ANCHOR)
        self.assertEqual(pay_type, "fixed")
        self.assertEqual((start[-2:], start[:7]), ("01", ANCHOR[:7]))
        self.assertEqual(end[:7], ANCHOR[:7])
        self._punch(start, "in", "16:00:00")
        self._punch(start, "out", "23:00:00")
        self.db.commit()
        card = tsr.card_for(self.db, EMP, start, end, pay_type)
        self.assertEqual(card["payType"], "fixed")
        self.assertTrue(card.get("fixedDays"))
        self.assertEqual(tsr.day_minutes(card, pay_type)[start], 420)
        r = tsr.submit(self.db, EMP, ANCHOR, "September")
        self.assertEqual((r.status, r.period_start, r.period_end, r.pay_type), ("with_manager", start, end, "fixed"))
        tsr.agree(self.db, r, MGR, "Agreed")
        self.db.expire_all()
        self.assertEqual(tsr.active_review(self.db, EMP, start).status, "signing")

    def test_the_old_one_click_sign_is_retired(self):
        with self.assertRaises(HTTPException) as e:
            timeclock.sign_my_timecard(timeclock.SignTimecardIn(start=ANCHOR), user={"email": EMP}, db=self.db)
        self.assertEqual(e.exception.status_code, 410)


class SigningTests(ReviewCase):
    def test_agree_sends_the_envelope_employee_first(self):
        r = self._to_signing()
        self.assertEqual(r.status, "signing")
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        self.assertEqual((req.link_kind, req.link_id, req.status), ("timesheet", r.id, "pending"))
        p = self._parties(r.sign_request_id)
        self.assertEqual([(k, p[k].email, p[k].ordinal) for k in ("employee", "manager", "hr")],
                         [("employee", EMP, 1), ("manager", MGR, 2), ("hr", HR, 3)])
        self.assertEqual(req.current_order, 1)
        with self.assertRaises(HTTPException):     # locked for everyone while signing
            tsr.guard_edit(self.db, EMP, self.start, MGR)

    def test_everyone_signs_and_the_period_is_finalized(self):
        r = self._to_signing()
        rid = r.sign_request_id
        for role in ("employee", "manager", "hr"):
            self._sign(self._parties(rid)[role])
        r = self._r()
        self.assertEqual(r.status, "completed")
        self.assertEqual(self.db.get(models.HrSignRequest, rid).status, "completed")
        kinds = {a.kind for a in self.db.query(models.TimeApproval).filter_by(employee_email=EMP, revoked=0)}
        self.assertEqual(kinds, {"employee_sign", "manager", "final"})
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.start, self.end))
        actions = [e["action"] for e in r.rounds]
        self.assertEqual(actions[-4:], ["signed_employee", "signed_manager", "signed_hr", "completed"])

    def test_employee_declining_hands_it_back_to_them(self):
        r = self._to_signing()
        self._decline(self._parties(r.sign_request_id)["employee"], "Friday is wrong")
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id), ("with_employee", ""))
        self.assertEqual(r.rounds[-1]["note"], "Friday is wrong")

    def test_hr_returning_it_goes_to_the_manager(self):
        r = self._to_signing()
        p = self._parties(r.sign_request_id)
        self._sign(p["employee"])
        self._sign(self._parties(r.sign_request_id)["manager"])
        self._decline(self._parties(r.sign_request_id)["hr"], "OT looks off")
        r = self._r()
        self.assertEqual((r.status, r.rounds[-1]["action"]), ("with_manager", "returned"))
        self.assertFalse(timeclock._finalized_row(self.db, EMP, self.start, self.end))

    def test_voiding_the_envelope_returns_it_to_the_manager(self):
        r = self._to_signing()
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        req.status = "voided"
        esign._link_hook("voided", self.db, req, HR)
        self.db.commit()
        self.assertEqual(self._r().status, "with_manager")

    def test_the_pdf_has_the_signature_page(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        r.agreed_by, r.agreed_at, r.agreed_fingerprint = MGR, tsr._now(), "abc"
        pdf, last = tsr.build_pdf(self.db, r)
        self.assertTrue(pdf.startswith(b"%PDF"))
        from pypdf import PdfReader
        import io
        self.assertEqual(len(PdfReader(io.BytesIO(pdf)).pages), last + 1)
        self.assertTrue(all(f["page"] == last for f in tsr._sig_fields(last)))


class StateTests(ReviewCase):
    def test_what_each_viewer_may_do(self):
        self.assertEqual(tsr.state_for(self.db, EMP, self.start, EMP, False)["status"], "not_submitted")
        tsr.submit(self.db, EMP, ANCHOR)
        emp_view = tsr.state_for(self.db, EMP, self.start, EMP, False)
        mgr_view = tsr.state_for(self.db, EMP, self.start, MGR, True)
        self.assertFalse(emp_view["canSubmit"])
        self.assertTrue(mgr_view["canAgree"] and mgr_view["canSendBack"])

    def test_the_signer_whose_turn_it_is_gets_their_party(self):
        self._to_signing()
        emp_view = tsr.state_for(self.db, EMP, self.start, EMP, False)
        mgr_view = tsr.state_for(self.db, EMP, self.start, MGR, True)
        self.assertEqual(emp_view["turn"], "employee")
        self.assertTrue(emp_view["myPartyId"])
        self.assertIsNone(mgr_view["myPartyId"])


class SubmitBlockTests(ReviewCase):
    """Oct 1: the employee fixes a missing clock-out, a clock-out with no
    clock-in or an unended break BEFORE the timesheet reaches the manager - and
    a clock-out can never be set before its clock-in."""

    def _day(self, n):
        return (datetime.strptime(self.start, "%Y-%m-%d") + timedelta(days=n)).strftime("%Y-%m-%d")

    def test_submit_is_refused_while_a_clock_out_is_missing(self):
        self._punch(self._day(1), "in", "16:00:00")
        self.db.commit()
        state = tsr.state_for(self.db, EMP, self.start, EMP, False)
        self.assertIn("Fix this on your timesheet before you submit it", state["submitBlocker"])
        self.assertIn("no clock-out", state["submitBlocker"])
        with self.assertRaises(HTTPException) as e:
            tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual((e.exception.status_code, e.exception.detail), (409, state["submitBlocker"]))
        self.assertIsNone(self._r())

    def test_a_clean_timesheet_submits_and_shows_no_blocker(self):
        self.assertEqual(tsr.state_for(self.db, EMP, self.start, EMP, False)["submitBlocker"], "")
        tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual(self._r().status, "with_manager")

    def test_resubmit_is_refused_until_fixed(self):
        tsr.submit(self.db, EMP, ANCHOR)
        tsr.send_back(self.db, self._r(), MGR, "Add Tuesday")
        self._punch(self._day(2), "out", "18:00:00")      # a clock-out with no clock-in
        self.db.commit()
        state = tsr.state_for(self.db, EMP, self.start, EMP, False)
        self.assertIn("a clock-out with no clock-in", state["submitBlocker"])
        with self.assertRaises(HTTPException):
            tsr.submit(self.db, EMP, ANCHOR)
        self._punch(self._day(2), "in", "10:00:00")
        self.db.commit()
        tsr.submit(self.db, EMP, ANCHOR, "Added Tuesday")
        self.assertEqual(self._r().status, "with_manager")

    # ── a clock-out never before its clock-in ───────────────────────────
    def _guard(self, **kw):
        return timeclock._guard_punch_order(self.db, EMP, **kw)

    def test_moving_the_clock_out_before_the_clock_in_is_refused(self):
        with self.assertRaises(HTTPException) as e:
            self._guard(kind="out", at=f"{self.start}T15:00:00", local_date=self.start,
                        punch_id=f"p-{self.start}-out-23:00:00")
        self.assertEqual(e.exception.status_code, 400)
        self.assertIn("can't be before the clock-in", e.exception.detail)

    def test_moving_the_clock_in_after_the_clock_out_is_refused(self):
        with self.assertRaises(HTTPException):
            self._guard(kind="in", at=f"{self.start}T23:30:00", local_date=self.start,
                        punch_id=f"p-{self.start}-in-16:00:00")

    def test_adding_a_clock_out_before_the_open_clock_in_is_refused(self):
        self._punch(self._day(1), "in", "16:00:00")
        self.db.commit()
        with self.assertRaises(HTTPException):
            self._guard(kind="out", at=f"{self._day(1)}T09:00:00", local_date=self._day(1))
        self._guard(kind="out", at=f"{self._day(1)}T22:00:00", local_date=self._day(1))   # after it: fine

    def test_valid_moves_and_a_lone_clock_out_pass(self):
        self._guard(kind="out", at=f"{self.start}T23:45:00", local_date=self.start,
                    punch_id=f"p-{self.start}-out-23:00:00")
        self._guard(kind="out", at=f"{self._day(3)}T17:00:00", local_date=self._day(3))   # missing in, not inverted

    def test_a_day_already_wrong_never_blocks_an_unrelated_fix(self):
        self._punch(self._day(4), "out", "10:00:00")
        self._punch(self._day(4), "in", "11:00:00")
        self.db.commit()
        self._guard(kind="out", at=f"{self._day(4)}T19:00:00", local_date=self._day(4))

    def test_a_pending_clock_in_request_counts_for_the_requested_clock_out(self):
        from types import SimpleNamespace
        pending = [SimpleNamespace(id="req-in", kind="in", at=f"{self._day(5)}T09:00:00", local_date=self._day(5))]
        self._guard(kind="out", at=f"{self._day(5)}T17:00:00", local_date=self._day(5), extra=pending)
        with self.assertRaises(HTTPException):
            self._guard(kind="out", at=f"{self._day(5)}T08:00:00", local_date=self._day(5), extra=pending)


class WaitingOnReviewerTests(ReviewCase):
    """Sep 29: the reviewer's list, the up-front Agree blocker, where the bell
    goes, and the Daily Briefing line."""

    def _bells(self, to):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == to).all()

    def test_the_reviewer_sees_what_is_waiting_on_them(self):
        self.assertEqual(tsr.waiting_on(self.db, MGR), [])
        tsr.submit(self.db, EMP, ANCHOR, "All in")
        rows = [tsr.queue_row(self.db, r) for r in tsr.waiting_on(self.db, MGR)]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["employeeEmail"], row["name"], row["periodStart"], row["workedMin"], row["note"]),
                         (EMP, "Erin Test", self.start, 420, "All in"))
        self.assertEqual(row["agreeBlocker"], "")          # the period is over and clean
        self.assertEqual(tsr.waiting_on(self.db, HR), [])  # only the person it waits on
        tsr.send_back(self.db, self._r(), MGR, "Check Monday")
        self.assertEqual(tsr.waiting_on(self.db, MGR), [])  # decided: off the list

    def test_the_waiting_endpoint_is_the_callers_own_list(self):
        tsr.submit(self.db, EMP, ANCHOR)
        prev = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = MGR
        try:
            r = self.client.get("/timesheet-review/waiting")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual([x["employeeEmail"] for x in r.json()["reviews"]], [EMP])
            os.environ["NEXUS_DEV_EMAIL"] = HR
            self.assertEqual(self.client.get("/timesheet-review/waiting").json()["reviews"], [])
        finally:
            if prev is None:
                os.environ.pop("NEXUS_DEV_EMAIL", None)
            else:
                os.environ["NEXUS_DEV_EMAIL"] = prev

    def test_agree_says_why_it_cannot_go_through_yet(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        real = timeclock._employee_today
        timeclock._employee_today = lambda db, email: self.start      # the period is still running
        try:
            msg = tsr.agree_blocker(self.db, r)
            self.assertIn(f"This period runs to {tsr.us_date(self.end)}", msg)
            self.assertEqual(tsr.state_for(self.db, EMP, self.start, MGR, True)["agreeBlocker"], msg)
            self.assertEqual(tsr.state_for(self.db, EMP, self.start, EMP, False)["agreeBlocker"], "")
        finally:
            timeclock._employee_today = real
        self._punch(self.end, "in", "16:00:00")                        # an open shift: no clock-out
        self.db.commit()
        msg = tsr.agree_blocker(self.db, self._r())
        self.assertIn(f"{tsr.us_date(self.end)}: no clock-out - add the out time", msg)
        self.assertIn("Or send it back to the employee to fix.", msg)
        with self.assertRaises(HTTPException) as e:                      # agree says the same, no "override"
            tsr.agree(self.db, self._r(), MGR)
        self.assertIn("no clock-out - add the out time", e.exception.detail["message"])
        self.assertNotIn("override", e.exception.detail["message"])

    def test_a_break_that_never_ended_is_called_that(self):
        from routers import timeclock as tcm
        exc = [{"date": "2026-08-05", "type": "missing_break_end", "label": "", "blocking": True}]
        self.assertEqual(tcm._exception_summary(exc),
                         "08/05/2026: a break that never ended - click its Break time to set when it ended")
        with self.assertRaises(HTTPException) as e:
            tcm._exceptions_409(exc)
        self.assertTrue(e.exception.detail["message"].startswith("Fix this on the timesheet before sign-off - 08/05/2026"))
        self.assertIn("Or override to sign off anyway.", e.exception.detail["message"])

    def test_the_bell_takes_the_manager_to_timesheets_to_review(self):
        """Oct 1: Workday > Time Sheet, where the Timesheets to Review list is -
        People > Time needs the HR grant, which a reviewing manager may lack."""
        tsr.submit(self.db, EMP, ANCHOR)
        import json as _json
        action = _json.loads(self._bells(MGR)[-1].action)
        self.assertEqual(action, {"view": "timeclock", "sub": "timesheet"})
        tsr.send_back(self.db, self._r(), MGR, "Check Monday")
        self.assertEqual(_json.loads(self._bells(EMP)[-1].action)["view"], "timeclock")   # the employee's own card

    def test_the_daily_briefing_asks_the_manager_to_review_it(self):
        import daily_briefing
        tsr.submit(self.db, EMP, ANCHOR)
        # The review row only - the manager's own "Confirm your time card"
        # reminder is a timecard row too, near a pay period's close.
        rows = [r for r in daily_briefing._red_rows(self.db, MGR, {})
                if r["module"] == "timecard" and r["title"].startswith("Review ")]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "Review Erin Test's timesheet")
        self.assertIn(f"{tsr.us_date(self.start)} - {tsr.us_date(self.end)} - 7h 00m", rows[0]["detail"])
        self.assertTrue(rows[0]["url"].endswith("/timeclock/timesheet"))


if __name__ == "__main__":
    unittest.main()
