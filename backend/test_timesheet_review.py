"""Timesheet review + Nexus Sign (Sep 2026) - timesheet_review.py end to end.

The journey: employee submits (optional) -> manager sends back -> employee
resubmits -> manager reviews and approves (a click, no signature) -> the
employee approves and signs, alone, in Nexus Sign -> the period is finalized
for payroll (Oct 16 2026 - before that the manager and HR signed too). Plus
the ways back (a decline or a void returns it to the manager) and the lock
that lets one side edit at a time. HR's override: test_timesheet_review_oct16.

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
                  models.HrSignOtpChallenge, models.NexusEmployee, models.HrEntity, models.PayrollRate,
                  models.NexusGroupMember, models.NexusGroup):
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
        tsr.approve(self.db, r, MGR, "Looks right")     # Agree: straight to the employee to sign
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
        # No manager, no company manager AND no HR contact (the Oct 16 fallback).
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"manager_email": ""})
        self.db.query(models.HrEntity).update({"hr_contact_email": ""})
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual(e.exception.status_code, 409)

    def test_exempt_from_time_tracking_has_no_timesheet(self):
        # Exempt = no clock and no timesheet (Visesh, 10/02). The flag is set on
        # the person's role in Settings > Access.
        self.db.add(models.NexusGroup(id="g-ts-mp", name="Managing Principal", is_job_role=1,
                                      time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-ts-mp", email=EMP))
        self.db.commit()
        with self.assertRaises(HTTPException) as e:
            tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual(e.exception.status_code, 400)

    def test_legacy_pay_record_flag_no_longer_exempts(self):
        # payroll_rates.time_tracking_exempt is a kept record, never read (Oct 2).
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", currency="USD", hourly_rate=20,
                                       full_day_hours=8, overtime_rule="ca", time_tracking_exempt=1))
        self.db.add(models.NexusGroup(id="g-ts-crew", name="Crew", is_job_role=1, time_tracking_exempt=0))
        self.db.add(models.NexusGroupMember(group_id="g-ts-crew", email=EMP))
        self.db.commit()
        r = tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual(r.status, "with_manager")

    def test_agreeing_without_an_hr_contact_still_sends_the_envelope(self):
        # Oct 16: HR no longer signs, so a company with no HR contact closes too.
        self.db.query(models.HrEntity).update({"hr_contact_email": ""})
        self.db.commit()
        r = tsr.submit(self.db, EMP, ANCHOR)
        tsr.agree(self.db, r, MGR)
        self.db.expire_all()
        r = self._r()
        self.assertEqual((r.status, r.hr_email or ""), ("signing", ""))

    def test_no_manager_falls_back_to_the_hr_contact(self):
        # Nobody set as manager: the company's HR contact is the lead approver
        # (Neil, Oct 16 - HR and Global Admins, never "any manager").
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == EMP).update({"manager_email": ""})
        self.db.commit()
        # Only an HR contact who can act (manager level or an HR editor grant).
        import auth
        auth.invalidate_role_cache()
        self.assertEqual(tsr.manager_of(self.db, EMP), "")
        self.db.add(models.NexusRole(email=HR, role="manager", assigned_by="test"))
        self.db.commit()
        auth.invalidate_role_cache()
        self.assertEqual(tsr.manager_of(self.db, EMP), HR)
        r = tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual((r.status, r.manager_email), ("with_manager", HR))
        self.db.query(models.NexusRole).filter(models.NexusRole.email == HR).delete()
        self.db.commit()
        auth.invalidate_role_cache()

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
        tsr.approve(self.db, r, MGR, "Agreed")
        self.db.expire_all()
        self.assertEqual(tsr.active_review(self.db, EMP, start).status, "signing")

    def test_the_old_one_click_sign_is_retired(self):
        with self.assertRaises(HTTPException) as e:
            timeclock.sign_my_timecard(timeclock.SignTimecardIn(start=ANCHOR), user={"email": EMP}, db=self.db)
        self.assertEqual(e.exception.status_code, 410)


class SigningTests(ReviewCase):
    def test_the_envelope_has_the_employee_as_its_only_signer(self):
        r = self._to_signing()
        self.assertEqual(r.status, "signing")
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        self.assertEqual((req.link_kind, req.link_id, req.status), ("timesheet", r.id, "pending"))
        p = self._parties(r.sign_request_id)
        # Only the employee signs (Oct 16); the approver's Agree is the approval.
        self.assertEqual([(k, p[k].email, p[k].ordinal) for k in p], [("employee", EMP, 1)])
        self.assertEqual(req.current_order, 1)
        self.assertTrue(all(f["role"] == "employee" for f in tsr._sig_fields({"page": 1, "sign": [0, 0, 0, 0], "date": [0, 0, 0, 0]})))

    def test_the_employee_signs_and_the_period_is_finalized(self):
        r = self._to_signing()
        rid = r.sign_request_id
        self._sign(self._parties(rid)["employee"])
        r = self._r()
        self.assertEqual(r.status, "completed")
        self.assertEqual(self.db.get(models.HrSignRequest, rid).status, "completed")
        rows = {a.kind: a for a in self.db.query(models.TimeApproval).filter_by(employee_email=EMP, revoked=0)}
        self.assertEqual(set(rows), {"employee_sign", "manager", "final"})
        # The approver's Agree is the manager approval and the finalization
        # (Oct 16: the approver does not sign).
        self.assertEqual((rows["manager"].approved_by, rows["final"].approved_by), (MGR, MGR))
        self.assertTrue(timeclock._finalized_row(self.db, EMP, self.start, self.end))
        actions = [e["action"] for e in r.rounds]
        self.assertEqual(actions[-2:], ["signed_employee", "completed"])

    def test_employee_declining_sends_it_back_to_the_manager(self):
        r = self._to_signing()
        self._decline(self._parties(r.sign_request_id)["employee"], "Friday is wrong")
        r = self._r()
        self.assertEqual((r.status, r.sign_request_id), ("with_manager", ""))
        self.assertEqual(r.rounds[-1]["note"], "Friday is wrong")

    def test_the_document_names_the_approver_instead_of_a_signature_row(self):
        r = self._to_signing()
        pdf, spot = tsr.build_pdf(self.db, r)
        from pypdf import PdfReader
        import io
        text = " ".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)
        self.assertIn("Approved by manager\nMax Test", text)
        self.assertNotIn("Manager\nSignature", text)
        # The employee's signature and date, and the signing date in the history: all theirs.
        self.assertEqual([(f["role"], f["type"]) for f in tsr._sig_fields(spot)],
                         [("employee", "sign"), ("employee", "date"), ("employee", "date")])

    def test_voiding_the_envelope_returns_it_to_the_manager(self):
        r = self._to_signing()
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        req.status = "voided"
        esign._link_hook("voided", self.db, req, HR)
        self.db.commit()
        self.assertEqual(self._r().status, "with_manager")

    def test_the_card_is_page_one_and_the_signature_page_two(self):
        """Charmi, Oct 20 2026: the card ends on page 1, page 2 is the
        signature - and the fields go where its lines were drawn."""
        r = tsr.submit(self.db, EMP, ANCHOR)
        r.agreed_by, r.agreed_at, r.agreed_fingerprint = MGR, tsr._now(), "abc"
        pdf, spot = tsr.build_pdf(self.db, r)
        self.assertTrue(pdf.startswith(b"%PDF"))
        from pypdf import PdfReader
        import io
        pages = PdfReader(io.BytesIO(pdf)).pages
        self.assertEqual(len(pages), 2)
        self.assertIn("MISSING PUNCHES", pages[0].extract_text())
        fields = tsr._sig_fields(spot)
        self.assertEqual([(f["id"], f["page"]) for f in fields],
                         [("employee_sign", 1), ("employee_date", 1), ("employee_history_date", 1)])
        self.assertTrue(all(0 < f["x"] and f["x"] + f["w"] < 1 and 0 < f["y"] and f["y"] + f["h"] < 1
                            for f in fields))

    def test_the_pdf_logs_who_approved_it_and_when(self):
        """Neil, Oct 16: "manager Sahil approved Jackson's time card on this
        time at this date" - on the signed copy, timestamped."""
        r = tsr.submit(self.db, EMP, ANCHOR)
        tsr.approve(self.db, r, MGR, "Checked")
        r = self._r()
        r.agreed_at = "2026-10-16T21:15:00+00:00"
        r.rounds = [dict(e, at=r.agreed_at) if e["action"] == "agreed" else e for e in r.rounds]
        log = tsr.approval_log(self.db, r, 420)      # PDT
        self.assertEqual(log, ['Approved by Max Test (manager) on 10/16/2026 at 2:15 PM - "Checked"'])
        pdf, spot = tsr.build_pdf(self.db, r)
        from pypdf import PdfReader
        import io
        text = PdfReader(io.BytesIO(pdf)).pages[spot["page"]].extract_text()
        self.assertIn("Approval History", text)
        # In the person's own punch time zone (UTC in this test), with the note.
        self.assertIn("Approved by manager\nMax Test\n10/16/2026 at 9:15 PM\nChecked", text)
        self.assertIn("Submitted by employee", text)
        self.assertNotIn("Manager\n", text)

    def test_the_employee_attests_above_their_signature(self):
        """Charmi, Oct 1: the paper time sheet's statement, boxed just above the
        employee's signature line - and clear of where their signature lands."""
        r = tsr.submit(self.db, EMP, ANCHOR)
        pdf, spot = tsr.build_pdf(self.db, r)
        from pypdf import PdfReader
        import io
        page = PdfReader(io.BytesIO(pdf)).pages[spot["page"]]
        found = []
        # The page height of each run: its text matrix inside the drawing's own (flowing layout) matrix.
        page.extract_text(visitor_text=lambda t, cm, tm, fd, fs: found.append(
            (t.strip(), tm[4] * cm[1] + tm[5] * cm[3] + cm[5])) if t.strip() else None)
        text = " ".join(t for t, _y in found)
        self.assertIn("By execution and signature of this time sheet, I agree I have reviewed this", text)
        self.assertIn("accurate and correct.", text)
        y_of = {t: y for t, y in found}
        height = float(page.mediabox.height)
        sign_top = height - tsr._sig_fields(spot)[0]["y"] * height   # top edge of the employee's signature field
        # The attestation's first line (pypdf misplaces a wrapped paragraph's later lines).
        att_y = min(y for t, y in found if t.startswith("By execution and signature"))
        self.assertGreater(att_y, sign_top)                       # above the field: never under the signature
        self.assertGreater(att_y, y_of["Employee"])               # and above the Employee row
        self.assertNotIn("TOTALS", text)                          # the card is page 1; this is page 2

    def test_the_pdf_is_the_time_sheet_grid_then_the_signature(self):
        """Charmi, Oct 20 2026: the signed copy reads like the Time Sheet screen
        (SwipeClock's layout, pay included), landscape, the signature after it."""
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", currency="USD", hourly_rate=22,
                                       overtime_rule="federal"))
        day2 = (datetime.fromisoformat(self.start) + timedelta(days=1)).strftime("%Y-%m-%d")
        self._punch(day2, "in", "15:00:00")
        self._punch(day2, "break_start", "19:00:00")
        self._punch(day2, "break_end", "19:30:00")
        self._punch(day2, "out", "23:30:00")
        self.db.flush()
        p = self.db.get(models.TimePunch, f"p-{day2}-in-15:00:00")
        p.adjusted_at, p.adjusted_by, p.adjust_note = tsr._now(), HR, "Forgot to clock in"
        self.db.add(models.TimecardNote(id=f"{EMP}|{day2}", employee_email=EMP, date=day2,
                                        note="Supervisor only", employee_note="Car trouble"))
        self.db.commit()
        r = self._to_signing()
        pdf, spot = tsr.build_pdf(self.db, r)
        from pypdf import PdfReader
        import io
        pages = PdfReader(io.BytesIO(pdf)).pages
        first, sig = pages[0], pages[spot["page"]]
        self.assertGreater(float(first.mediabox.width), float(first.mediabox.height))
        text = " ".join(" ".join((pg.extract_text() or "").split()) for pg in pages)
        for s in ("Time Sheet", "Company: Greens Test Co", "Approved by manager Max Test", "Pay Rate", "Wage",
                  "$22.00/hr", "7:30 PM", "Total hours clocked for week of", "Total Regular hours at $22.00/hr",
                  "Note by employee: Car trouble", "Forgot to clock in", "TOTAL EDITED PUNCHES",
                  "4:00 PM", "11:00 PM", "7:00 PM"):
            self.assertIn(s, text)
        self.assertNotIn("Supervisor only", text)        # the manager / HR note never reaches the employee
        self.assertNotIn(EMP, text)                         # no email on it (Charmi, Oct 20)
        self.assertNotIn("Time Sheet Report", text)
        self.assertIn("Approval History", sig.extract_text())
        self.assertNotIn("TOTALS", sig.extract_text())
        if os.environ.get("TIMESHEET_PDF_OUT"):
            with open(os.environ["TIMESHEET_PDF_OUT"], "wb") as f:
                f.write(pdf)

    def test_a_salaried_time_sheet_has_the_monthly_columns(self):
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="fixed", currency="USD", monthly_salary=6000))
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one().country = "US"
        self.db.commit()
        s, e, pt = tsr.period_for(self.db, EMP, ANCHOR)
        r = models.TimesheetReview(id="fixed-r", employee_email=EMP, period_start=s, period_end=e, pay_type=pt,
                                   status="with_manager", manager_email=MGR, rounds=[])
        self.db.add(r)
        self.db.commit()
        pdf, _spot = tsr.build_pdf(self.db, r)
        from pypdf import PdfReader
        import io
        pages = PdfReader(io.BytesIO(pdf)).pages
        text = " ".join(" ".join((pg.extract_text() or "").split()) for pg in pages)
        for s_ in ("Salaried (monthly)", "Monthly Salary: $6,000.00", "Effect on Pay", "Day",
                   "NET PAY THIS MONTH", "Signed by employee - finalizes the time sheet"):
            self.assertIn(s_, text)
        self.assertNotIn("Hrs/Day", text)
        # Country or Region US: the meal and rest statement prints for salaried
        # staff too (Pranshu, Oct 20) - without Report a Missed Break, whose
        # premium pay only an hourly card pays.
        self.assertIn(tsr.BREAK_STATEMENT, text)
        self.assertNotIn("reported instead of signing", text)
        self.assertTrue(tsr.needs_break_attestation(self.db, r))
        self.assertFalse(tsr.can_report_breaks(self.db, r))
        self.assertFalse(tsr.break_attestation_state(self.db, r)["canReport"])

    def test_the_meal_and_rest_statement_follows_country_or_region(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
        from pypdf import PdfReader
        import io

        def text():
            return " ".join(" ".join((p.extract_text() or "").split())
                            for p in PdfReader(io.BytesIO(tsr.build_pdf(self.db, r)[0])).pages)
        emp.country = "IN"
        self.db.commit()
        self.assertFalse(tsr.needs_break_attestation(self.db, r))
        self.assertNotIn(tsr.BREAK_STATEMENT, text())
        self.assertIn("By execution and signature of this time sheet", text())      # the attestation always
        emp.country = ""                         # not set: the company's country decides
        self.db.query(models.HrEntity).filter_by(id=ENTITY).one().country = "US"
        self.db.commit()
        self.assertTrue(tsr.needs_break_attestation(self.db, r))
        self.assertIn(tsr.BREAK_STATEMENT, text())


class StateTests(ReviewCase):
    def test_what_each_viewer_may_do(self):
        self.assertEqual(tsr.state_for(self.db, EMP, self.start, EMP, False)["status"], "not_submitted")
        tsr.submit(self.db, EMP, ANCHOR)
        emp_view = tsr.state_for(self.db, EMP, self.start, EMP, False)
        mgr_view = tsr.state_for(self.db, EMP, self.start, MGR, True)
        self.assertFalse(emp_view["canSubmit"])
        self.assertTrue(mgr_view["canAgree"] and mgr_view["canSendBack"])

    def test_after_agree_only_the_employee_signs_and_both_see_the_log(self):
        tsr.approve(self.db, tsr.submit(self.db, EMP, ANCHOR), MGR)
        emp_view = tsr.state_for(self.db, EMP, self.start, EMP, False)
        mgr_view = tsr.state_for(self.db, EMP, self.start, MGR, True)
        self.assertEqual((emp_view["status"], emp_view["turn"]), ("signing", "employee"))
        self.assertTrue(emp_view["myPartyId"])
        self.assertFalse(mgr_view["myPartyId"] or mgr_view["canApprove"])
        self.assertIn("Approved by Max Test (manager)", mgr_view["approvalLog"][0])

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
        self.assertIn("Fix this on your time sheet before you submit it", state["submitBlocker"])
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

    # ── a break only inside a shift (Oct 16) ────────────────────────────
    def test_a_break_inside_the_shift_passes(self):
        self._guard(kind="break_start", at=f"{self.start}T18:00:00", local_date=self.start)
        self._guard(kind="break_end", at=f"{self.start}T18:30:00", local_date=self.start)

    def test_a_break_outside_any_shift_is_refused(self):
        for kind, hhmm in (("break_start", "10:00:00"), ("break_end", "23:30:00")):
            with self.assertRaises(HTTPException) as e:
                self._guard(kind=kind, at=f"{self.start}T{hhmm}", local_date=self.start)
            self.assertEqual(e.exception.status_code, 400)
            self.assertIn("inside a clock-in / clock-out", e.exception.detail)
        with self.assertRaises(HTTPException):     # a day with no shift at all
            self._guard(kind="break_start", at=f"{self._day(2)}T12:00:00", local_date=self._day(2))

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

    def test_asking_for_a_change_while_signing_sends_it_back_to_the_manager(self):
        """Oct 16 (assumption 1, Sagar): the employee who is unhappy after the
        manager approved asks for the change - it reopens, back to the manager,
        and the envelope out for their signature is pulled back."""
        self._request_fixes()
        self._submit()
        self._approve_all()
        self._agree()
        self._as(EMP)
        r = self.client.post(f"/timesheet-review/{self._r().id}/sign")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["myPartyId"])          # the signing screen opens on it
        rid = self._r().sign_request_id
        r = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "out", "at": f"{self.day_b}T18:00:00", "tz_offset_min": 0,
            "reason": "late"})
        self.assertEqual(r.status_code, 200, r.text)
        rv = self._r()
        self.assertEqual((rv.status, rv.sign_request_id, rv.rounds[-1]["action"]), ("with_manager", "", "reopened"))
        self.assertEqual(self.db.get(models.HrSignRequest, rid).status, "voided")


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
        # The company HR contact is also on the list: with no backup set and no
        # manager above MGR, HR is the employee's Backup Manager (Neil, Oct 13).
        self.assertEqual([r.employee_email for r in tsr.waiting_on(self.db, HR)], [EMP])
        self.assertEqual(tsr.waiting_on(self.db, "someone.else@greensglobal.com"), [])
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
            os.environ["NEXUS_DEV_EMAIL"] = "someone.else@greensglobal.com"
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
        self.assertIn("before you can approve", msg)
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
        self.assertTrue(e.exception.detail["message"].startswith("Fix this on the time sheet before sign-off - 08/05/2026"))
        self.assertIn("Or override to sign off anyway.", e.exception.detail["message"])

    def test_the_bell_takes_the_manager_to_the_card_in_people_time(self):
        """Oct 22: Time Sheets to Review lives only in People > Time - the bell
        opens that employee's card for that period there."""
        tsr.submit(self.db, EMP, ANCHOR)
        import json as _json
        action = _json.loads(self._bells(MGR)[-1].action)
        self.assertEqual((action["view"], action["sub"], action["timecard"]), ("hr", "hr-time", EMP))
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
        self.assertEqual(rows[0]["title"], "Review Erin Test's Time Sheet")
        self.assertIn(f"{tsr.us_date(self.start)} - {tsr.us_date(self.end)} - 7h 00m", rows[0]["detail"])
        self.assertTrue(rows[0]["url"].endswith("/hr/hr-time"))   # People > Time (Oct 22)


class StaleReviewTests(ReviewCase):
    """Oct 22 (Neil): a submitted review nobody can decide any more - its
    period predates the review launch, was finalized on the payroll screen, or
    is no longer one of the person's pay periods - leaves the reviewer's list
    and is retired with the reason, instead of sitting there for good."""

    def setUp(self):
        super().setUp()
        self._launch = tsr.REVIEW_LAUNCH
        tsr.REVIEW_LAUNCH = "2000-01-01"          # the test period counts as after launch

    def tearDown(self):
        tsr.REVIEW_LAUNCH = self._launch
        super().tearDown()

    def _retire(self):
        n = tsr.retire_stale(self.db)
        self.db.commit()
        self.db.expire_all()
        return n

    def _retired(self, rid):
        self.db.expire_all()
        return self.db.query(models.TimesheetReview).filter(models.TimesheetReview.id == rid).first()

    def test_a_live_review_stays(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        self.assertEqual(tsr.stale_reason(self.db, r), "")
        self.assertEqual(self._retire(), 0)
        self.assertEqual(self._r().status, "with_manager")
        self.assertEqual([x.id for x in tsr.waiting_on(self.db, MGR)], [r.id])

    def test_a_period_before_the_review_launch_is_retired(self):
        """Sagar's case: submitted 09/28 for September under the old rules,
        Approve blocked by missing punches - on the list for good."""
        rid = tsr.submit(self.db, EMP, ANCHOR).id
        self._punch(self.end, "in", "16:00:00")                 # a missing clock-out: Approve is blocked
        self.db.commit()
        tsr.REVIEW_LAUNCH = (datetime.fromisoformat(self.end) + timedelta(days=1)).strftime("%Y-%m-%d")
        self.assertEqual(self._retire(), 1)
        r = self._retired(rid)
        self.assertEqual(r.status, tsr.RETIRED)
        self.assertEqual((r.rounds[-1]["action"], r.rounds[-1]["by"]), ("retired", "nexus"))
        self.assertIn("signed off the old way", r.rounds[-1]["note"])
        self.assertEqual(tsr.waiting_on(self.db, MGR), [])
        self.assertIsNone(tsr.review_covering(self.db, EMP, self.start))   # no longer locks the period
        self.assertEqual(self._retire(), 0)                                # once

    def test_a_finalized_period_leaves_the_list(self):
        rid = tsr.submit(self.db, EMP, ANCHOR).id
        self.db.add(models.TimeApproval(id="ta-final", employee_email=EMP, period_start=self.start,
                                        period_end=self.end, approved_by=HR, kind="final"))
        self.db.commit()
        self.assertEqual(tsr.waiting_on(self.db, MGR), [])        # at once, before the sweep
        self.assertEqual(self._retire(), 1)
        self.assertIn("finalized on the payroll screen", self._retired(rid).rounds[-1]["note"])

    def test_a_pay_schedule_change_retires_the_old_period(self):
        r = tsr.submit(self.db, EMP, ANCHOR)
        tsr.send_back(self.db, r, MGR, "Check Monday")             # with the employee: retired too
        rid = r.id
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="fixed", currency="INR",
                                       monthly_salary=30000, full_day_hours=8, overtime_rule="none"))
        self.db.commit()
        self.assertEqual(self._retire(), 1)
        r = self._retired(rid)
        self.assertEqual(r.status, tsr.RETIRED)
        self.assertIn("pay schedule changed", r.rounds[-1]["note"])

    def test_a_person_now_exempt_leaves_the_list(self):
        rid = tsr.submit(self.db, EMP, ANCHOR).id
        self.db.add(models.NexusGroup(id="g-ts-stale", name="Managing Principal", is_job_role=1,
                                      time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-ts-stale", email=EMP))
        self.db.commit()
        self.assertEqual(tsr.waiting_on(self.db, MGR), [])
        self.assertEqual(self._retire(), 1)
        self.assertIn("exempt from time tracking", self._retired(rid).rounds[-1]["note"])


class SentByNexusTests(ReviewCase):
    """Neil, Oct 20: the envelope is created by Nexus, not the approving
    manager - the manager gets no completion bell, sealed copy or decline bell
    from Nexus Sign (the review's own bells tell them); the employee still
    gets their invite and copy. Other envelopes keep their human sender."""

    def setUp(self):
        super().setUp()
        self.invites, self.copies = [], []
        esign._send_sign_email = lambda party, req, sender, custom=None: (
            self.invites.append((party.email, sender)) or (True, ""))
        esign._send_sealed_email = lambda name, to, req, *a, **k: self.copies.append(to) or (True, "")
        self.db.query(models.NexusNotification).delete()
        self.db.commit()

    def _bells(self, title_start):
        self.db.expire_all()
        return [n.recipient for n in self.db.query(models.NexusNotification)
                if n.title.startswith(title_start)]

    def test_nexus_is_the_sender_and_the_approval_stays_recorded(self):
        r = self._to_signing()
        req = self.db.get(models.HrSignRequest, r.sign_request_id)
        self.assertEqual(req.created_by, esign.SYSTEM_SENDER)
        self.assertEqual(r.agreed_by, MGR)
        ((to, sender),) = self.invites
        self.assertEqual((to, sender["name"], sender["email"]), (EMP, "Greens Nexus", esign._SUPPORT_CONTACT))
        self.assertEqual(esign._from_display(sender["name"]), "Greens Nexus via Nexus Sign")
        html = esign._sign_email_html(self._parties(req.id)["employee"], req, sender, "https://x")
        self.assertIn("<strong>Greens Nexus</strong> has asked you to review and sign", html)
        self.assertNotIn("Max Test", html)

    def test_on_completion_only_the_employee_hears_from_nexus_sign(self):
        r = self._to_signing()
        self._sign(self._parties(r.sign_request_id)["employee"])
        self.assertEqual(self._r().status, "completed")
        self.assertEqual(self.copies, [EMP])
        self.assertEqual(self._bells("Fully Executed"), [EMP])

    def test_a_decline_rings_no_nexus_sign_bell(self):
        r = self._to_signing()
        self._decline(self._parties(r.sign_request_id)["employee"], "Friday is wrong")
        self.assertEqual(self._bells("Signature Declined"), [])
        self.assertEqual(self._r().status, "with_manager")

    def test_other_envelopes_keep_their_sender(self):
        import uuid
        r = self._to_signing()
        pdf, spot = tsr.build_pdf(self.db, r)
        path = f"esign/{uuid.uuid4()}/plain.pdf"
        esign._storage_put(esign._DOC_BUCKET, path, pdf, "application/pdf")
        out = esign._create_request(
            self.db, {"email": MGR}, title="Plain Letter", source="pdf", template_id="",
            employee_id="id-Erin", candidate_id="", entity_id=ENTITY, body_snapshot=[],
            pdf_storage_path=path, fields=esign._clean_fields(tsr._sig_fields(spot)), message="",
            expires_on="", parties=[esign.PartyIn(role_key="employee", name="Erin Test", email=EMP,
                                                  kind="internal", ordinal=1, party_role="signer")],
            ip="", user_agent="", routing="sequential", excluded_ack=True, document_class="employment")
        req = self.db.get(models.HrSignRequest, out["id"])
        self.assertEqual(req.created_by, MGR)
        self.assertEqual(self.invites[-1][1]["name"], "Max Test")
        self.copies.clear()
        self._sign(self._parties(req.id)["employee"])
        self.assertEqual(sorted(self.copies), sorted([MGR, EMP]))
        self.assertIn(MGR, self._bells("Fully Executed: Plain Letter"))


if __name__ == "__main__":
    unittest.main()
