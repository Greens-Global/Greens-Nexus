"""The timesheet matrix (test_timesheet_review_matrix - every state x actor x
action) run again for a CA-rule hourly employee (Oct 17 2026, ca_breaks.py).

The only difference for them (Neil, Oct 18): their signature also confirms
the meal and rest break statement printed above it - no separate question,
so the matrix signs exactly as it does for anyone else and each test must
pass unchanged - no state may become a dead end for CA staff. Plus the
Report a Missed Break loop: it sends the time sheet back to the manager
(reopen), who re-approves; repeated, it never leaves a stray envelope and
always reaches "completed".

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
        # The break statement is confirmed by signing for US staff (Pranshu,
        # Oct 20: timesheet_review.needs_break_attestation reads the country,
        # not the CA rule) - a California employee is in the US.
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"country": "US"})
        self.db.commit()



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
        # The signature on the last envelope confirmed the statement.
        r = self._rv()
        self.assertIn("break_attested", [e["action"] for e in r.rounds if e.get("envelope") == r.sign_request_id])
        # One meal premium for the day, however many times it was claimed.
        self.assertEqual(self.db.query(models.TimeBreakPremium).filter_by(employee_email=EMP, status="active").count(), 1)


class CaWhoCanActTests(CaRule, m.WhoCanActTests):
    pass
