"""The monthly score (Oct 30 2026) - perf_scores.py on a throwaway database,
with the metrics engine stubbed so the numbers are fixed.
  * attainment runs threshold -> target, over target runs target -> cap, and
    lower-is-better reads the other way;
  * a KPI without a value is left out and the weights scale up;
  * manual KPIs take a rating with a reason from the chain or HR, once per
    person / KPI / month; the person and the chain read the score, a peer
    does not; a team pass scores every direct report.
Run with: python -m pytest test_perf_scores.py -q
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
import perf_scorecards as sc  # noqa: E402
import perf_scores as ps  # noqa: E402
from routers import perf_scorecards as api  # noqa: E402

CO = "co-ps"
HR, MGR, EMP, PEER, EMP2 = ("hr.ps@greensglobal.com", "mgr.ps@greensglobal.com", "emp.ps@greensglobal.com",
                            "peer.ps@greensglobal.com", "emp2.ps@greensglobal.com")
ROLE = "r-ps-analyst"
TODAY = date(2026, 10, 30)


def U(email, level=1):
    return {"email": email, "role": "employee", "level": level}


def nums(**vals):
    """A fake perf_metrics scorecard: {key: value} (None = not available)."""
    return {"period": {}, "metrics": [{"key": k, "value": v, "available": v is not None} for k, v in vals.items()]}


class ScoreTests(unittest.TestCase):
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
        for m in (models.PerfKpi, models.PerfScorecard, models.PerfScorecardKpi, models.PerfKpiRating, models.NexusEmployee,
                  models.HrEntity, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Score Co", hr_contact_email=HR))
        self.db.add(models.NexusGroup(id=ROLE, name="Analyst", company_id=CO, department="Accounting", is_job_role=1, allowed_modules=""))
        for email, first, mgr in ((HR, "Hana", ""), (MGR, "Max", ""), (EMP, "Erin", MGR), (PEER, "Pat", MGR), (EMP2, "Eli", MGR)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="T", company=CO,
                                             department="Accounting", manager_email=mgr, status="active"))
        for em in (EMP, PEER, EMP2):
            self.db.add(models.NexusGroupMember(group_id=ROLE, email=em))
        self.db.commit()
        self.judgment = sc.create_manual_kpi(self.db, U(HR), CO, "Judgment", "", "rating", "high")
        self.db.flush()
        sc.save(self.db, U(HR), CO, ROLE, [
            {"kpi": "tasks_on_time", "weight": 50, "target": 90, "threshold": 60, "cap": 100},
            {"kpi": "no_shows", "weight": 20, "target": 0, "threshold": 3, "cap": 0},
            {"kpi": self.judgment.key, "weight": 30, "target": 4, "threshold": 2, "cap": 5},
        ], "", "", TODAY)
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def test_attainment_math(self):
        self.assertEqual(ps.attainment("high", 75, 90, 60, 100), (0.5, 0.0))        # halfway threshold -> target
        self.assertEqual(ps.attainment("high", 95, 90, 60, 100), (1.0, 0.5))        # over target, halfway to the cap
        self.assertEqual(ps.attainment("high", 50, 90, 60, 100), (0.0, 0.0))
        self.assertEqual(ps.attainment("low", 0, 0, 3, 0), (1.0, 0.0))              # no no-shows: full marks
        self.assertEqual(ps.attainment("low", 1.5, 0, 3, 0), (0.5, 0.0))
        self.assertEqual(ps.attainment("low", 4, 0, 3, 0), (0.0, 0.0))
        self.assertEqual(ps.attainment("low", 2, 4, 8, 0), (1.0, 0.5))

    def test_a_month_s_score_from_nexus_numbers_and_a_rating(self):
        with mock.patch.object(ps.perf_metrics, "scorecard", return_value=nums(tasks_on_time=75, no_shows=0)):
            s = ps.score(self.db, EMP, "2026-10", TODAY)
        # Judgment unrated: left out; 50 + 20 = 70 measured. tasks 50% of 50 = 25, no-shows 100% of 20 = 20 -> 45/70.
        self.assertEqual((s["status"], s["measuredWeight"], s["score"]), ("scored", 70, 64.3))
        by = {i["kpi"]: i for i in s["items"]}
        self.assertEqual((by["tasks_on_time"]["status"], by["tasks_on_time"]["attainment"], by["tasks_on_time"]["display"]), ("partly", 50.0, "75%"))
        self.assertEqual((by["no_shows"]["status"], by["no_shows"]["contribution"]), ("met", 28.6))
        self.assertEqual((by[self.judgment.key]["status"], by[self.judgment.key]["measured"]), ("unmeasured", False))
        # The manager rates Judgment 5 with a reason: now every weight is measured.
        ps.rate(self.db, U(MGR), EMP, self.judgment.key, "2026-10", 5, "Caught the duplicate invoice before it was paid.", TODAY)
        self.db.commit()
        with mock.patch.object(ps.perf_metrics, "scorecard", return_value=nums(tasks_on_time=75, no_shows=0)):
            s2 = ps.score(self.db, EMP, "2026-10", TODAY)
        self.assertEqual((s2["measuredWeight"], s2["score"]), (100, 75.0))        # 25 + 20 + 30
        j = next(i for i in s2["items"] if i["kpi"] == self.judgment.key)
        self.assertEqual((j["display"], j["rating"]["byName"], j["overTarget"]), ("5 / 5", "Max T", 100.0))

    def test_rating_rules(self):
        bad = lambda who, **kw: self.assertRaises(HTTPException, ps.rate, self.db, U(who), EMP, kw.get("kpi", self.judgment.key), "2026-10",  # noqa: E731
                                                  kw.get("value", 4), kw.get("reason", "ok"), TODAY)
        bad(PEER)                                                     # a peer is not above EMP
        bad(MGR, reason="")                                           # a reason is required
        bad(MGR, value=7)                                             # 1..5
        bad(MGR, kpi="tasks_on_time")                                 # Nexus measures that one
        ps.rate(self.db, U(MGR), EMP, self.judgment.key, "2026-10", 3, "Steady month.", TODAY)
        ps.rate(self.db, U(HR), EMP, self.judgment.key, "2026-10", 4, "Revised after the close.", TODAY)   # HR may; rating again replaces
        self.db.commit()
        self.assertEqual(self.db.query(models.PerfKpiRating).count(), 1)
        self.assertEqual(self.db.query(models.PerfKpiRating).first().value, 4)

    def test_who_reads_and_the_team_pass(self):
        with mock.patch.object(ps.perf_metrics, "scorecard", return_value=nums(tasks_on_time=90, no_shows=0)):
            self.assertEqual(api.my_score(EMP, "2026-10", U(EMP), self.db)["score"], 100.0)
            self.assertEqual(api.my_score(EMP, "2026-10", U(MGR), self.db)["score"], 100.0)
            self.assertEqual(api.my_score(EMP, "2026-10", U(HR), self.db)["score"], 100.0)
            with self.assertRaises(HTTPException) as cm:
                api.my_score(EMP, "2026-10", U(PEER), self.db)
            self.assertEqual(cm.exception.status_code, 404)
        with mock.patch.object(ps.perf_metrics, "scorecards", return_value={EMP: nums(tasks_on_time=90, no_shows=0), PEER: nums(tasks_on_time=60, no_shows=2), EMP2: nums(tasks_on_time=None, no_shows=None)}):
            team = api.team_scores("2026-10", U(MGR), self.db)
        by = {t["email"]: t for t in team}
        self.assertEqual(set(by), {EMP, PEER, EMP2})
        self.assertEqual(by[EMP]["score"], 100.0)
        self.assertEqual(by[PEER]["score"], 9.5)                                       # tasks 0 of 50, no-shows 1/3 of 20 -> 6.67/70
        self.assertEqual((by[EMP2]["status"], by[EMP2]["score"]), ("unmeasured", None))
        self.assertEqual(api.team_scores("2026-10", U(EMP), self.db), [])

    def test_no_role_or_no_scorecard_says_so(self):
        self.assertEqual(ps.score(self.db, HR, "2026-10", TODAY)["status"], "no_role")
        self.db.add(models.NexusGroup(id="r-none", name="Clerk", company_id=CO, is_job_role=1, allowed_modules=""))
        self.db.add(models.NexusGroupMember(group_id="r-none", email=HR))
        self.db.commit()
        self.assertEqual(ps.score(self.db, HR, "2026-10", TODAY)["status"], "no_scorecard")
        with self.assertRaises(HTTPException):
            ps.month_bounds("Oct-2026")


if __name__ == "__main__":
    unittest.main()
