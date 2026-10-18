"""The timesheet matrix (test_timesheet_review_matrix - every state x actor x
action) run again for a CA-rule hourly employee (Oct 17 2026, ca_breaks.py).

The only difference for them: before Nexus Sign takes their signature they
answer the meal and rest break question. Here every signature answers Yes
first (attest_breaks), so each matrix test must still pass unchanged - no
state may become a dead end for CA staff. Plus the No loop: No sends it back
to the manager (reopen), who re-approves; repeated, it never leaves a stray
envelope and always reaches "completed".

    python -m pytest test_timesheet_review_matrix_ca.py -q
"""
import test_timesheet_review_matrix as m  # noqa: F401  (sets DATABASE_URL first)
from test_timesheet_review import EMP, MGR

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402


class CaRule:
    def setUp(self):
        super().setUp()
        self.db.query(models.TimeBreakPremium).delete()
        self.db.query(models.PayrollRate).filter_by(employee_email=EMP).delete()
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="hourly", currency="USD", hourly_rate=20,
                                       full_day_hours=8, overtime_rule="ca"))
        self.db.commit()

    def _sign(self, party):
        """Answer Yes, then sign exactly as the matrix does."""
        self.db.expire_all()
        req = self.db.query(models.HrSignRequest).filter_by(id=party.request_id).first()
        r = self.db.query(models.TimesheetReview).filter_by(id=req.link_id).first() if req else None
        if r is not None and party.role_key == "employee" and r.status == "signing" and not tsr.break_attested(r):
            tsr.attest_breaks(self.db, r, EMP)
        super()._sign(party)


class CaNoDeadEndTests(CaRule, m.NoDeadEndTests):
    pass


class CaEveryActionAnswersTests(CaRule, m.EveryActionAnswersTests):
    pass


class CaLoopTests(CaRule, m.LoopTests):
    def test_no_answer_loops_back_to_the_manager(self):
        self._to("signing")
        envelopes = set()
        for i in range(3):
            r = self._rv()
            envelopes.add(r.sign_request_id)
            tsr.claim_breaks(self.db, r, EMP, [{"date": self.ps, "kind": "meal"}], f"round {i}")
            self.assertEqual(self._status(), "with_manager")
            pending = self.db.query(models.HrSignRequest).filter(
                models.HrSignRequest.link_kind == "timesheet", models.HrSignRequest.status == "pending").count()
            self.assertEqual(pending, 0)
            tsr.approve(self.db, self._rv(), MGR, f"premium {i}")
            self.assertEqual(self._status(), "signing")
        self.assertEqual(len(envelopes), 3)
        self._sign_now()
        self.assertEqual(self._status(), "completed")
        # One meal premium for the day, however many times it was claimed.
        self.assertEqual(self.db.query(models.TimeBreakPremium).filter_by(employee_email=EMP, status="active").count(), 1)


class CaWhoCanActTests(CaRule, m.WhoCanActTests):
    pass
