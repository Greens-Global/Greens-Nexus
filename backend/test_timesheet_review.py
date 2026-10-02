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

    def test_exempt_from_time_tracking_has_no_timesheet(self):
        # Exempt = no clock and no timesheet (Visesh, 10/02).
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="fixed", currency="USD", monthly_salary=1,
                                       full_day_hours=8, overtime_rule="none", time_tracking_exempt=1))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual(e.exception.status_code, 400)

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

    def test_the_employee_attests_above_their_signature(self):
        """Charmi, Oct 1: the paper time sheet's statement, boxed just above the
        employee's signature line - and clear of where their signature lands."""
        r = tsr.submit(self.db, EMP, ANCHOR)
        pdf, last = tsr.build_pdf(self.db, r)
        from pypdf import PdfReader
        import io
        page = PdfReader(io.BytesIO(pdf)).pages[last]
        found = []
        page.extract_text(visitor_text=lambda t, cm, tm, fd, fs: found.append((t.strip(), tm[5])) if t.strip() else None)
        text = " ".join(t for t, _y in found)
        self.assertIn("By execution and signature of this time sheet, I agree I have reviewed this", text)
        self.assertIn("accurate and correct.", text)
        y_of = {t: y for t, y in found}
        height = float(page.mediabox.height)
        sign_top = height - tsr._SIG_TOP * height                 # top edge of the employee's signature field
        att_y = min(y for t, y in found if "accurate and correct" in t)
        self.assertGreater(att_y, sign_top)                       # above the field: never under the signature
        self.assertGreater(att_y, y_of["Employee"])               # and above the Employee row


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


class FixAndResubmitFlowTests(ReviewCase):
    """Oct 1, end to end through the API as each person: the employee's fixes
    are REQUESTS, so (a) they may submit once their pending fixes would clear
    the errors, (b) the manager approves those fixes - even while the timesheet
    is back with the employee, which used to 403 and deadlock both sides - and
    (c) Agree unlocks once the real punches are clean."""

    def setUp(self):
        super().setUp()
        self.db.query(models.NexusRole).filter(models.NexusRole.email == MGR).delete()
        self.db.query(models.PunchRequest).delete()
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.commit()
        # Errors near the period end (requests may reach 45 days back):
        # day A - two clock-ins before one clock-out (the first never closes);
        # day B - a clock-out with no clock-in.
        e = datetime.strptime(self.end, "%Y-%m-%d")
        self.day_a = (e - timedelta(days=2)).strftime("%Y-%m-%d")
        self.day_b = (e - timedelta(days=1)).strftime("%Y-%m-%d")
        self._punch(self.day_a, "in", "09:00:00")
        self._punch(self.day_a, "in", "09:23:00")
        self._punch(self.day_a, "out", "17:00:00")
        self._punch(self.day_b, "out", "14:00:00")
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

    def _request_fixes(self):
        self._as(EMP)
        c = self.client
        r = c.post("/timeclock/punch-requests", json={
            "action": "remove", "target_punch_id": f"p-{self.day_a}-in-09:00:00", "reason": "double clock-in"})
        self.assertEqual(r.status_code, 200, r.text)
        r = c.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "in", "at": f"{self.day_b}T10:00:00", "tz_offset_min": 0,
            "reason": "forgot in"})
        self.assertEqual(r.status_code, 200, r.text)

    def _approve_all(self):
        self._as(MGR)
        self.db.expire_all()
        for req in self.db.query(models.PunchRequest).filter(models.PunchRequest.status == "pending").all():
            r = self.client.patch(f"/timeclock/punch-requests/{req.id}", json={"status": "approved"})
            self.assertEqual(r.status_code, 200, r.text)

    def _submit(self, expect=200):
        self._as(EMP)
        r = self.client.post("/timesheet-review/submit", json={"start": ANCHOR, "note": "fixed"})
        self.assertEqual(r.status_code, expect, r.text)
        return r

    def _agree(self, expect=200):
        self._as(MGR)
        r = self.client.post(f"/timesheet-review/{self._r().id}/agree", json={"note": ""})
        self.assertEqual(r.status_code, expect, r.text)
        return r

    def test_errors_block_submit_until_the_fixes_are_requested(self):
        r = self._submit(expect=409)
        self.assertIn("no clock-out", r.json()["detail"])
        self.assertIn("a clock-out with no clock-in", r.json()["detail"])

    def test_first_submission_fix_approve_agree(self):
        self._request_fixes()
        self._submit()                                        # pending fixes clear the errors
        self.assertEqual(self._r().status, "with_manager")
        r = self._agree(expect=409)                          # real punches still wrong...
        self.assertIn("waiting for your approval", r.json()["detail"]["message"])   # ...and it says why
        self._approve_all()
        self._agree()
        self.assertEqual(self._r().status, "signing")

    def test_back_with_the_employee_the_manager_can_still_approve_their_fix(self):
        """The screenshot: sent back, the employee requests the clock-in, the
        manager's Approve was refused ("back with ... for changes")."""
        # Reach "with_employee" the way it happened: a clean submission, then
        # the errors surface, then it is sent back.
        self.db.query(models.TimePunch).filter(models.TimePunch.local_date.in_([self.day_a, self.day_b]))             .update({"voided": 1}, synchronize_session=False)
        self.db.commit()
        self._submit()
        self.db.query(models.TimePunch).filter(models.TimePunch.local_date.in_([self.day_a, self.day_b]))             .update({"voided": 0}, synchronize_session=False)
        self.db.commit()
        self._as(MGR)
        r = self.client.post(f"/timesheet-review/{self._r().id}/send-back", json={"note": "correct it"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._r().status, "with_employee")
        self._request_fixes()
        self._approve_all()                                   # used to be 403 here
        self.assertEqual(self._r().status, "with_employee")   # approving does not take it back
        self._submit()
        self._agree()
        self.assertEqual(self._r().status, "signing")

    def test_the_employee_may_resubmit_before_the_manager_approves(self):
        self.db.query(models.TimePunch).filter(models.TimePunch.local_date.in_([self.day_a, self.day_b]))             .update({"voided": 1}, synchronize_session=False)
        self.db.commit()
        self._submit()
        self.db.query(models.TimePunch).filter(models.TimePunch.local_date.in_([self.day_a, self.day_b]))             .update({"voided": 0}, synchronize_session=False)
        self.db.commit()
        self._as(MGR)
        self.client.post(f"/timesheet-review/{self._r().id}/send-back", json={"note": "correct it"})
        self._submit(expect=409)                              # nothing requested yet
        self._request_fixes()
        self._submit()                                        # requested: may resubmit
        self._approve_all()                                   # with the manager now
        self._agree()

    def test_a_signing_timesheet_still_refuses_any_change(self):
        self._request_fixes()
        self._submit()
        self._approve_all()
        self._agree()
        self._as(EMP)
        r = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "out", "at": f"{self.day_b}T18:00:00", "tz_offset_min": 0,
            "reason": "late"})
        self.assertEqual(r.status_code, 403, r.text)


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
