"""Bonus plans per role and the bonus run (Oct 30 2026) - perf_bonus.py on a
throwaway database with the metrics engine stubbed.
  * the payout curve: nothing under the threshold, a straight line to 100,
    stretch over target only when the plan allows it;
  * a run prices every eligible person from their pay rate, averages the
    period's scored months, keeps its inputs, and refuses an unfinished
    period or a second run;
  * a manager adjusts within the bound with a reason, HR beyond it and may
    exclude; approve -> pay writes one TimecardBonus per line and tells the
    person; a manager's review has no money.
Run with: python -m pytest test_perf_bonus.py -q
"""
import os
import tempfile
import unittest
from datetime import date
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import perf_bonus as pb  # noqa: E402
import perf_scorecards as sc  # noqa: E402
import perf_scores as ps  # noqa: E402
from routers import perf_bonus as api  # noqa: E402

CO = "co-pb"
HR, MGR, EMP, PEER, NOROLE = ("hr.pb@greensglobal.com", "mgr.pb@greensglobal.com", "emp.pb@greensglobal.com",
                              "peer.pb@greensglobal.com", "norole.pb@greensglobal.com")
ROLE = "r-pb-analyst"
TODAY = date(2026, 11, 5)


def U(email):
    return {"email": email, "role": "employee", "level": 1}


def nums(**vals):
    return {"period": {}, "metrics": [{"key": k, "value": v, "available": v is not None} for k, v in vals.items()]}


class BonusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        auth._role_cache.clear()
        self.db = database.SessionLocal()
        for m in (models.PerfKpi, models.PerfScorecard, models.PerfScorecardKpi, models.PerfKpiRating, models.PerfBonusPlan,
                  models.PerfBonusRun, models.PerfBonusLine, models.TimecardBonus, models.PayrollRate, models.NexusEmployee,
                  models.HrEntity, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Bonus Co", hr_contact_email=HR))
        self.db.add(models.NexusGroup(id=ROLE, name="Analyst", company_id=CO, department="Accounting", is_job_role=1, allowed_modules=""))
        for email, first, mgr in ((HR, "Hana", ""), (MGR, "Max", ""), (EMP, "Erin", MGR), (PEER, "Pat", MGR), (NOROLE, "Nat", MGR)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="T", company=CO,
                                             department="Accounting", manager_email=mgr, status="active"))
        for em in (EMP, PEER):
            self.db.add(models.NexusGroupMember(group_id=ROLE, email=em))
        self.db.add(models.PayrollRate(employee_email=EMP, pay_type="fixed", monthly_salary=5000, currency="USD"))
        self.db.add(models.PayrollRate(employee_email=PEER, pay_type="hourly", hourly_rate=20, currency="USD"))
        self.db.commit()
        sc.save(self.db, U(HR), CO, ROLE, [{"kpi": "tasks_on_time", "weight": 100, "target": 90, "threshold": 60, "cap": 100}], "", "", date(2026, 10, 1))
        self.plan = pb.save_plan(self.db, U(HR), CO, ROLE, {"targetPct": 10, "period": "monthly", "thresholdScore": 60, "payoutAtThreshold": 50, "maxPayout": 100, "adjustMax": 20})
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_payout_curve(self):
        p = self.plan
        self.assertIsNone(pb.payout_pct(p, None))
        self.assertEqual(pb.payout_pct(p, 59), 0.0)
        self.assertEqual(pb.payout_pct(p, 60), 50.0)
        self.assertEqual(pb.payout_pct(p, 80), 75.0)
        self.assertEqual(pb.payout_pct(p, 100), 100.0)
        self.assertEqual(pb.payout_pct(p, 100, over=100), 100.0)              # no stretch unless the plan allows it
        p.max_payout = 150
        self.assertEqual(pb.payout_pct(p, 100, over=50), 125.0)
        self.assertEqual(pb.payout_pct(p, 80, over=100), 125.0)               # stretch adds on top, capped at maxPayout
        with self.assertRaises(HTTPException):
            pb.save_plan(self.db, U(HR), CO, ROLE, {"targetPct": 120})
        with self.assertRaises(HTTPException):
            pb.save_plan(self.db, U(HR), CO, ROLE, {"targetPct": 10, "period": "yearly"})

    def _scores(self):
        # Erin 80% on time -> attainment 2/3 -> score 66.7; Pat 90 -> 100.
        return {EMP: nums(tasks_on_time=80), PEER: nums(tasks_on_time=90), NOROLE: nums(tasks_on_time=90)}

    def _run(self, period="2026-10"):
        with mock.patch.object(ps.perf_metrics, "scorecard", side_effect=lambda db, em, s, e, t=None: self._scores()[em]):
            return pb.start_run(self.db, U(HR), CO, period, TODAY)

    def test_a_run_prices_eligible_people_and_keeps_its_inputs(self):
        with self.assertRaises(HTTPException) as cm:
            pb.start_run(self.db, U(HR), CO, "2026-11", TODAY)                 # not ended
        self.assertEqual(cm.exception.status_code, 400)
        run = self._run()
        self.db.commit()
        lines = {ln.email: ln for ln in pb.lines_of(self.db, run)}
        self.assertEqual(set(lines), {EMP, PEER})                              # Nat has no role: not on the run
        e, p = lines[EMP], lines[PEER]
        self.assertEqual((e.score, e.payout_pct, e.base_pay, e.computed_amount), (66.7, 58.4, 5000.0, 292.0))   # 5000 x 10% x 58.4%
        self.assertEqual((p.score, p.payout_pct, p.base_pay, p.note), (100.0, 100.0, round(20 * pb.HOURS_PER_MONTH, 2), "hourly_standard_month"))
        self.assertEqual((run.status, run.line_count, run.period_end), ("review", 2, "2026-10-31"))
        with self.assertRaises(HTTPException) as cm:
            self._run()
        self.assertEqual(cm.exception.status_code, 409)                        # one run per period
        # A plan change after the run leaves the run as priced.
        pb.save_plan(self.db, U(HR), CO, ROLE, {"targetPct": 50, "period": "monthly"})
        self.db.commit()
        self.assertEqual(pb.lines_of(self.db, run)[0].target_pct, 10)
        out = pb.run_out(self.db, run, True)
        self.assertEqual(out["total"], round(292.0 + 20 * pb.HOURS_PER_MONTH * 0.1, 2))
        self.assertEqual(out["fairness"]["byManager"][0]["people"], 2)
        self.assertNotIn("finalAmount", pb.line_out(self.db, e, False))        # no money without HR

    def test_one_line_per_person_and_thin_data_is_not_paid(self):
        # People holds Erin twice (an import left a duplicate): one line, never two bonuses.
        self.db.add(models.NexusEmployee(id="id-Erin-dup", work_email=EMP.upper(), first_name="Erin", last_name="Dup", company=CO, manager_email=MGR, status="active"))
        self.db.commit()
        run = self._run()
        self.assertEqual([ln.email for ln in pb.lines_of(self.db, run)].count(EMP), 1)
        pb.cancel(self.db, run)
        self.db.commit()
        # A month with only 30% of the weight measured is thin data: no payout, flagged for HR.
        with mock.patch.object(ps, "score", return_value={"score": 100.0, "overTarget": 0, "measuredWeight": 30}):
            run2 = pb.start_run(self.db, U(HR), CO, "2026-10", TODAY)
        ln = next(ln for ln in pb.lines_of(self.db, run2) if ln.email == EMP)
        self.assertEqual((ln.score, ln.payout_pct, ln.final_amount, ln.note), (None, None, 0.0, "thin_data"))
        self.assertIn("thin data", pb.fairness(self.db, pb.lines_of(self.db, run2))["byManager"][0]["flags"])

    def test_quarter_averages_the_scored_months(self):
        self.assertEqual(pb.period_months("2026-Q4"), ["2026-10", "2026-11", "2026-12"])
        self.assertEqual(pb.period_bounds("2026-Q1"), ("2026-01-01", "2026-03-31"))
        pb.save_plan(self.db, U(HR), CO, ROLE, {"targetPct": 10, "period": "quarterly"})
        self.db.commit()
        with mock.patch.object(ps.perf_metrics, "scorecard", side_effect=lambda db, em, s, e, t=None: nums(tasks_on_time=90 if s.startswith("2026-07") else 75)):
            run = pb.start_run(self.db, U(HR), CO, "2026-Q3", date(2026, 10, 2))
        # The scorecard only started 10/01: no version in force in Q3 -> unscored, nothing to pay.
        ln = pb.lines_of(self.db, run)[0]
        self.assertEqual((ln.score, ln.payout_pct, ln.final_amount, ln.months_scored), (None, None, 0.0, 0))
        self.assertIn("unscored", " ".join(pb.fairness(self.db, pb.lines_of(self.db, run))["byManager"][0]["flags"]))

    def test_adjust_approve_pay(self):
        run = self._run()
        self.db.commit()
        erin = next(ln for ln in pb.lines_of(self.db, run) if ln.email == EMP)
        bad = lambda who, **kw: self.assertRaises(HTTPException, pb.adjust, self.db, U(who), erin, kw.get("pct", 10), kw.get("reason", "ok"), kw.get("excluded"))  # noqa: E731
        bad(PEER)                                        # a peer
        bad(MGR, reason="")                              # reason required
        bad(MGR, pct=25)                                 # over the 20% bound
        bad(MGR, excluded=True)                          # only HR excludes
        pb.adjust(self.db, U(MGR), erin, 10, "Carried the close while a teammate was out.")
        self.assertEqual((erin.adjust_pct, erin.final_amount, erin.adjusted_by), (10.0, 321.2, MGR))
        pb.adjust(self.db, U(HR), erin, 30, "Exceptional quarter - HR override.")
        self.assertEqual(erin.final_amount, 379.6)
        with self.assertRaises(HTTPException):
            pb.pay(self.db, U(HR), run)                  # not approved yet
        pb.approve(self.db, U(HR), run)
        bad(HR)                                          # locked after approval
        told = []
        with mock.patch("routers.timeclock._bonus_told", side_effect=lambda db, u, row, added: told.append((row.employee_email, row.amount, added))):
            n = pb.pay(self.db, U(HR), run, TODAY)
        self.db.commit()
        self.assertEqual((n, run.status), (2, "paid"))
        bonuses = {b.employee_email: b for b in self.db.query(models.TimecardBonus).all()}
        self.assertEqual((bonuses[EMP].amount, bonuses[EMP].date), (379.6, "2026-11-05"))     # dated the day it is paid: the open period, not the one earned in
        self.assertIn("score 66.7, payout 58.4%, adjusted +30%", bonuses[EMP].description)
        self.assertEqual(sorted(t[0] for t in told), sorted([EMP, PEER]))
        self.assertEqual(erin.bonus_id, bonuses[EMP].id)
        with self.assertRaises(HTTPException):
            pb.cancel(self.db, run)                      # paid runs are not cancelled

    def test_exclusion_and_the_manager_review(self):
        run = self._run()
        self.db.commit()
        pat = next(ln for ln in pb.lines_of(self.db, run) if ln.email == PEER)
        pb.adjust(self.db, U(HR), pat, 0, "On a performance plan this period.", excluded=True)
        self.assertEqual((pat.excluded, pat.final_amount), (1, 0.0))
        self.assertEqual(pb.run_out(self.db, run, True)["total"], 292.0)
        review = api.my_review(U(MGR), self.db)
        self.assertEqual(len(review), 1)
        self.assertEqual({ln["email"] for ln in review[0]["lines"]}, {EMP, PEER})
        self.assertNotIn("finalAmount", review[0]["lines"][0])
        self.assertEqual(api.my_review(U(EMP), self.db), [])
        with self.assertRaises(HTTPException) as cm:
            api.get_run(run.id, U(MGR), self.db)         # a manager never opens the money view
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(len(api.list_plans(CO, U(HR), self.db)["roles"]), 1)


if __name__ == "__main__":
    unittest.main()
