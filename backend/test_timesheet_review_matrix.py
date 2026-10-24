"""
Timesheet approval flow - every state, every actor, every action (Oct 17).

Nobody may get stuck: from each state there is a way to "completed", the
person who has to act sees it in their own list, every action answers with a
decided status (never a 500), and the back-and-forth loops (send back /
resubmit, decline / re-approve, reopen on a change, HR's edit / re-sign) can
repeat without leaving a stray envelope behind. Real Nexus Sign engine, on
test_timesheet_review's throwaway database, on the employee's most recent
CLOSED pay period (what the reviewer's "not submitted" list looks at).

    python -m unittest test_timesheet_review_matrix
"""
import os
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402

MGR2 = "mgr2.ts@greensglobal.com"
ADMIN = "admin.ts@greensglobal.com"
OTHER = "other.ts@greensglobal.com"
STATES = ("not_submitted", "with_manager", "with_employee", "signing", "approved", "completed", "correcting")


class MatrixCase(ReviewCase):
    def setUp(self):
        super().setUp()
        for m in (models.NexusNotification, models.PunchRequest):
            self.db.query(m).delete()
        self.db.query(models.NexusRole).filter(
            models.NexusRole.email.in_([MGR, MGR2, ADMIN, OTHER, HR])).delete(synchronize_session=False)
        for em, role in ((MGR, "manager"), (MGR2, "manager"), (OTHER, "manager"), (ADMIN, "owner")):
            self.db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
        for em, first in ((MGR2, "Mia"), (ADMIN, "Ada"), (OTHER, "Oz")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             company=ENTITY, status="active"))
        # The employee's most recent closed period, worked on its first day.
        self.ps, self.pe, _pt = tsr.last_closed_period(self.db, EMP)
        self.db.query(models.TimePunch).delete()
        self._punch(self.ps, "in", "16:00:00")
        self._punch(self.ps, "out", "23:00:00")
        self.db.commit()
        auth.invalidate_role_cache()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.invalidate_role_cache()
        super().tearDown()

    # ── helpers ──────────────────────────────────────────────────────────
    def _fresh(self):
        self.tearDown()
        self.setUp()

    def _decide_pending_fixes(self):
        """The manager decides what the employee asked for (rejects it here)."""
        self.db.expire_all()
        pend = self.db.query(models.PunchRequest).filter_by(employee_email=EMP, status="pending").all()
        if pend:
            self._as(MGR)
            for q in pend:
                r = self.client.patch(f"/timeclock/punch-requests/{q.id}", json={"status": "rejected", "note": "no"})
                assert r.status_code == 200, r.text
    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _rv(self):
        self.db.expire_all()
        return (self.db.query(models.TimesheetReview)
                .filter(models.TimesheetReview.employee_email == EMP, models.TimesheetReview.period_start == self.ps)
                .order_by(models.TimesheetReview.created_at.desc()).first())

    def _status(self):
        r = self._rv()
        return r.status if r else "not_submitted"

    def _sign_now(self):
        r = self._rv()
        self._sign(self._parties(r.sign_request_id)["employee"])

    def _to(self, state):
        """Drive the period into `state` the way people would."""
        if state == "not_submitted":
            return
        tsr.submit(self.db, EMP, self.ps, "All in")
        if state == "with_manager":
            return
        if state == "with_employee":
            tsr.send_back(self.db, self._rv(), MGR, "Check Monday")
            return
        tsr.approve(self.db, self._rv(), MGR, "Good")
        if state == "signing":
            return
        if state == "approved":
            tsr.guard_edit(self.db, EMP, self.ps, HR)
            self.db.commit()
            return
        self._sign_now()
        if state == "completed":
            return
        timeclock.unfinalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.ps, end=self.pe, reason="Wrong lunch on Monday"),
                                      user={"email": HR, "level": 4}, db=self.db)
        assert state == "correcting"

    def _finish(self, state):
        """Who moves it on from `state`, until it is signed and finalized."""
        for _ in range(6):
            st = self._status()
            if st == "completed":
                return
            self._decide_pending_fixes()
            if st == "not_submitted":
                tsr.approve_period(self.db, EMP, self.ps, MGR)
            elif st == "correcting":
                # Oct 22: HR finishes a correction - re-lock if nothing changed, else send it to sign.
                rv = self._rv()
                if tsr.correction_changed(self.db, rv):
                    tsr.send_correction(self.db, rv, HR)
                else:
                    tsr.relock(self.db, rv, HR)
                self.db.commit()
            elif st == "with_manager":
                tsr.approve(self.db, self._rv(), MGR)
            elif st == "with_employee":
                tsr.submit(self.db, EMP, self.ps, "Fixed")
            elif st == "approved":
                tsr.employee_approve(self.db, self._rv(), EMP)
            elif st == "signing":
                self._sign_now()
        self.fail(f"{state} never reached completed (stuck at {self._status()})")


class NoDeadEndTests(MatrixCase):
    def test_every_state_reaches_completed(self):
        for state in STATES:
            with self.subTest(state=state):
                self._fresh()
                self._to(state)
                self.assertEqual(self._status(), state)
                self._finish(state)
                self.assertEqual(self._status(), "completed")
                self.assertTrue(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))

    def test_whoever_must_act_has_it_in_their_own_list(self):
        def mgr_list():
            return {(x["employeeEmail"], x["periodStart"]) for x in
                    [tsr.queue_row(self.db, r) for r in tsr.waiting_on(self.db, MGR)] + tsr.not_reviewed(self.db, MGR)}

        def emp_sign_list():
            return [x for x in tsr.to_sign(self.db, EMP) if x["periodStart"] == self.ps]

        for state, who in (("not_submitted", "mgr"), ("with_manager", "mgr"), ("signing", "emp"),
                           ("approved", "emp")):
            with self.subTest(state=state):
                self._fresh()
                self._to(state)
                if who == "mgr":
                    self.assertIn((EMP, self.ps), mgr_list())
                else:
                    rows = emp_sign_list()
                    self.assertEqual(len(rows), 1, rows)
                    self.assertEqual(bool(rows[0].get("needsResign")), state == "approved")

    def test_back_with_the_employee_they_are_told_and_can_resubmit(self):
        self._to("with_employee")
        bell = [n for n in self.db.query(models.NexusNotification).filter_by(recipient=EMP).all()
                if n.title == "Time Sheet Sent Back"]
        self.assertTrue(bell)
        self.assertTrue(tsr.state_for(self.db, EMP, self.ps, EMP, False)["canSubmit"])


class EveryActionAnswersTests(MatrixCase):
    """Every action, by every actor, in every state: a decided answer (2xx or
    a 4xx with a message) - never a 500, and never a state left half-moved."""

    def test_the_matrix(self):
        actors = (EMP, MGR, MGR2, HR, ADMIN, OTHER)
        for state in STATES:
            for actor in actors:
                for action in ("submit", "send_back", "agree", "approve", "approve_period", "sign", "punch_fix"):
                    with self.subTest(state=state, actor=actor, action=action):
                        self._fresh()
                        self._to(state)
                        r = self._rv()
                        rid = r.id if r else "missing"
                        self._as(actor)
                        c = self.client
                        if action == "submit":
                            resp = c.post("/timesheet-review/submit", json={"start": self.ps, "note": "x"})
                        elif action == "send_back":
                            resp = c.post(f"/timesheet-review/{rid}/send-back", json={"note": "x"})
                        elif action == "agree":
                            resp = c.post(f"/timesheet-review/{rid}/agree", json={"note": ""})
                        elif action == "approve":
                            resp = c.post(f"/timesheet-review/{rid}/approve", json={"note": ""})
                        elif action == "approve_period":
                            resp = c.post("/timesheet-review/approve", json={"email": EMP, "start": self.ps})
                        elif action == "sign":
                            resp = c.post(f"/timesheet-review/{rid}/sign")
                        else:
                            resp = c.post("/timeclock/punch-requests", json={
                                "action": "add", "punch_kind": "break_start", "at": f"{self.ps}T19:00:00",
                                "tz_offset_min": 0, "reason": "lunch"})
                        self.assertLess(resp.status_code, 500, resp.text)
                        if resp.status_code >= 400:
                            self.assertTrue(resp.json().get("detail"), resp.text)
                        # Whatever happened, it can still be finished.
                        self._finish(state)


class LoopTests(MatrixCase):
    """The back-and-forth situations, repeated - each round leaves exactly one
    live envelope (or none) and ends signed."""

    def _live_envelopes(self):
        self.db.expire_all()
        return (self.db.query(models.HrSignRequest)
                .filter(models.HrSignRequest.link_kind == "timesheet", models.HrSignRequest.status == "pending").count())

    def test_send_back_and_resubmit_three_times(self):
        tsr.submit(self.db, EMP, self.ps)
        for i in range(3):
            tsr.send_back(self.db, self._rv(), MGR, f"round {i}")
            tsr.submit(self.db, EMP, self.ps, f"fixed {i}")
        self.assertEqual(self._status(), "with_manager")
        self._finish("with_manager")

    def test_decline_and_reapprove_three_times(self):
        self._to("signing")
        for i in range(3):
            self._decline(self._parties(self._rv().sign_request_id)["employee"], f"wrong {i}")
            self.assertEqual((self._status(), self._live_envelopes()), ("with_manager", 0))
            tsr.approve(self.db, self._rv(), MGR)
            self.assertEqual((self._status(), self._live_envelopes()), ("signing", 1))
        self._sign_now()
        self.assertEqual(self._status(), "completed")

    def test_a_fix_request_while_signing_reopens_and_the_fix_can_be_decided(self):
        self._to("signing")
        self._as(EMP)
        r = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "break_start", "at": f"{self.ps}T19:00:00", "tz_offset_min": 0,
            "reason": "lunch"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self._status(), self._live_envelopes()), ("with_manager", 0))
        self.assertIn("waiting for your decision", tsr.agree_blocker(self.db, self._rv()))
        self._as(MGR)
        req = self.db.query(models.PunchRequest).filter_by(status="pending").first()
        r = self.client.patch(f"/timeclock/punch-requests/{req.id}", json={"status": "rejected", "note": "no"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(tsr.agree_blocker(self.db, self._rv()), "")
        self._finish("with_manager")

    def test_hr_edits_twice_while_signing_then_the_employee_signs(self):
        self._to("signing")
        tsr.guard_edit(self.db, EMP, self.ps, HR)
        self.db.commit()
        tsr.employee_approve(self.db, self._rv(), EMP)
        tsr.guard_edit(self.db, EMP, self.ps, HR)          # again, on the fresh envelope
        self.db.commit()
        self.assertEqual((self._status(), self._live_envelopes()), ("approved", 0))
        tsr.employee_approve(self.db, self._rv(), EMP)
        self.assertEqual(self._live_envelopes(), 1)
        self._sign_now()
        self.assertEqual(self._status(), "completed")

    def test_after_an_hr_edit_the_employee_may_send_it_to_the_manager_instead(self):
        self._to("approved")
        tsr.submit(self.db, EMP, self.ps, "Not what I worked")
        self.assertEqual(self._status(), "with_manager")
        self._finish("with_manager")

    def test_unlock_correct_and_sign_again_twice(self):
        """Oct 22: HR unlocks, changes the hours, sends the corrected card; the
        employee signs it - twice over, never via the manager."""
        self._to("signing")
        self._sign_now()
        for i in range(2):
            timeclock.unfinalize_timecard(timeclock.FinalizeIn(email=EMP, start=self.ps, end=self.pe, reason="Wrong lunch on Monday"),
                                          user={"email": HR, "level": 4}, db=self.db)
            self.assertEqual(self._status(), "correcting")
            self._punch(self.pe, "in", f"1{i}:00:00")      # HR's correction: a shift on the last day
            self._punch(self.pe, "out", f"1{i}:30:00")
            tsr.guard_edit(self.db, EMP, self.pe, HR)
            self.db.commit()
            tsr.send_correction(self.db, self._rv(), HR)
            self.db.commit()
            self.assertEqual(self._status(), "signing")
            self._sign_now()
            self.assertEqual(self._status(), "completed")
            self.assertTrue(timeclock._finalized_row(self.db, EMP, self.ps, self.pe))


class WhoCanActTests(MatrixCase):
    def test_a_new_manager_sees_and_decides_a_review_sent_to_the_old_one(self):
        self._to("with_manager")
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"manager_email": MGR2})
        self.db.commit()
        self.assertIn(EMP, [r.employee_email for r in tsr.waiting_on(self.db, MGR2)])
        self._as(MGR2)
        r = self.client.post(f"/timesheet-review/{self._rv().id}/approve", json={"note": ""})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._status(), "signing")

    def test_nobody_to_review_lands_with_the_global_admins(self):
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"manager_email": ""})
        self.db.query(models.HrEntity).update({"hr_contact_email": "", "manager_emails": []})
        self.db.commit()
        self.assertEqual(tsr.manager_of(self.db, EMP), "")
        self.assertIn(EMP, [x["employeeEmail"] for x in tsr.not_reviewed(self.db, ADMIN)])
        self.assertNotIn(EMP, [x["employeeEmail"] for x in tsr.not_reviewed(self.db, OTHER)])
        self._as(ADMIN)
        r = self.client.post("/timesheet-review/approve", json={"email": EMP, "start": self.ps})
        self.assertEqual(r.status_code, 200, r.text)
        self._sign_now()
        self.assertEqual(self._status(), "completed")

    def test_a_missed_period_stays_on_the_list_when_the_next_closes(self):
        real, tsr.REVIEW_LAUNCH = tsr.REVIEW_LAUNCH, "2000-01-01"   # not limited by the launch date here
        self.addCleanup(setattr, tsr, "REVIEW_LAUNCH", real)
        older = tsr.closed_periods(self.db, EMP, 2)[1]
        self._punch(older[0], "in", "16:00:00")
        self._punch(older[0], "out", "20:00:00")
        self.db.commit()
        starts = {x["periodStart"] for x in tsr.not_reviewed(self.db, MGR) if x["employeeEmail"] == EMP}
        self.assertEqual(starts, {self.ps, older[0]})

    def test_nobody_reviews_or_signs_for_someone_else(self):
        self._to("with_manager")
        rid = self._rv().id
        self._as(OTHER)                                          # an unrelated manager
        self.assertGreaterEqual(self.client.post(f"/timesheet-review/{rid}/approve", json={}).status_code, 400)
        self._as(EMP)                                            # the employee on their own card
        self.assertGreaterEqual(self.client.post(f"/timesheet-review/{rid}/approve", json={}).status_code, 400)
        tsr.approve(self.db, self._rv(), MGR)
        self._as(MGR)                                            # the manager cannot sign for them
        self.assertGreaterEqual(self.client.post(f"/timesheet-review/{rid}/sign").status_code, 400)
        self.assertEqual(self._status(), "signing")

    def test_a_second_approval_is_refused_not_doubled(self):
        self._to("with_manager")
        tsr.approve(self.db, self._rv(), MGR)
        self._as(HR)                                             # the backup, a moment later
        self.db.add(models.NexusRole(email=HR, role="manager", assigned_by="test"))
        self.db.commit()
        auth.invalidate_role_cache()
        r = self.client.post(f"/timesheet-review/{self._rv().id}/approve", json={})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(self.db.query(models.HrSignRequest).filter_by(link_kind="timesheet").count(), 1)


if __name__ == "__main__":
    unittest.main()
