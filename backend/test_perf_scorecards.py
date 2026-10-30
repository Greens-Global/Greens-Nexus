"""KPI scorecards per department (Oct 30 2026) - perf_scorecards.py and
routers/perf_scorecards.py on a throwaway database.
  * the library is Nexus's metrics plus manual KPIs HR adds (per company or
    for every company), with a unique key;
  * weights total 100, manual KPIs carry at most 30%, targets sit in the
    right order for the KPI's direction, unknown and retired KPIs are refused;
  * a scorecard saved for the first time applies this month; a change to one
    in force becomes next month's version and the current one keeps its rows
    to the end of this month; a version not yet started is edited in place;
  * HR for the company edits, a department head reads, an employee of the
    department reads their own, an outsider gets 404; retire ends it.
Run with: python -m pytest test_perf_scorecards.py -q
"""
import os
import tempfile
import unittest
from datetime import date

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import HTTPException  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import perf_scorecards as sc  # noqa: E402
from routers import perf_scorecards as api  # noqa: E402

CO, CO2 = "co-sc", "co-sc-2"
HR, HEAD, EMP, OTHER, FAR, ADMIN = ("hr.sc@greensglobal.com", "head.sc@greensglobal.com", "emp.sc@greensglobal.com",
                                     "other.sc@greensglobal.com", "far.sc@greensglobal.com", "admin.sc@greensglobal.com")


def U(email, level=1):
    return {"email": email, "role": "employee", "level": level}


ACCT = [{"kpi": "tasks_on_time", "weight": 50, "target": 95, "threshold": 70, "cap": 100},
        {"kpi": "ticket_sla", "weight": 30, "target": 90, "threshold": 60, "cap": 100},
        {"kpi": "training", "weight": 20, "target": 100, "threshold": 80, "cap": 100}]


class ScorecardTests(unittest.TestCase):
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
        for m in (models.PerfKpi, models.PerfScorecard, models.PerfScorecardKpi, models.NexusEmployee, models.HrEntity, models.HrDepartment):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Score Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO2, name="Far Co", hr_contact_email=""))
        self.db.add(models.HrDepartment(id="d-acct", company_id=CO, name="Accounting", lead_email=HEAD))
        for email, first, dept, co in ((HR, "Hana", "HR", CO), (HEAD, "Hank", "Accounting", CO), (EMP, "Erin", "Accounting", CO),
                                       (OTHER, "Omar", "Ops", CO), (FAR, "Fay", "Accounting", CO2), (ADMIN, "Ada", "IT", CO)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="T", company=co,
                                             department=dept, status="active"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    # ── library ─────────────────────────────────────────────────
    def test_library_is_nexus_metrics_plus_manual_kpis_with_unique_keys(self):
        lib = api.list_kpis(CO, U(HR), self.db)
        keys = [k["key"] for k in lib["kpis"]]
        self.assertIn("tasks_on_time", keys)
        self.assertTrue(all(k["source"] == "nexus" for k in lib["kpis"]))
        api.create_kpi(api.KpiIn(company=CO, name="Client Calls Returned", unit="%", direction="high"), U(HR), self.db)
        api.create_kpi(api.KpiIn(company=CO, name="Client Calls Returned", unit="rating"), U(HR), self.db)   # same name twice
        keys = [k["key"] for k in api.list_kpis(CO, U(HR), self.db)["kpis"] if k["source"] == "manual"]
        self.assertEqual(keys, ["manual:client-calls-returned", "manual:client-calls-returned-2"])
        # Only HR for the company adds; a KPI for every company needs HR for every company.
        with self.assertRaises(HTTPException) as cm:
            api.create_kpi(api.KpiIn(company=CO, name="X"), U(EMP), self.db)
        self.assertEqual(cm.exception.status_code, 403)
        with self.assertRaises(HTTPException):
            api.create_kpi(api.KpiIn(company="", name="Everywhere"), U(HR), self.db)
        api.create_kpi(api.KpiIn(company="", name="Everywhere"), U(ADMIN, level=5), self.db)
        self.assertIn("manual:everywhere", [k["key"] for k in api.list_kpis(CO2, U(ADMIN, level=5), self.db)["kpis"]])

    # ── validation ──────────────────────────────────────────────
    def test_weights_total_100_manual_capped_and_targets_ordered(self):
        bad = lambda items: self.assertRaises(HTTPException, sc.clean_items, self.db, CO, items)  # noqa: E731
        bad([{**ACCT[0], "weight": 60}, ACCT[1], ACCT[2]])                                   # 110
        bad([{"kpi": "nope", "weight": 100, "target": 1, "threshold": 0, "cap": 1}])          # unknown
        bad([{**ACCT[0], "weight": 100, "threshold": 99}])                                    # threshold above target (high)
        bad([{"kpi": "no_shows", "weight": 100, "target": 0, "threshold": 2, "cap": 3}])      # cap must be best (low)
        bad([{**ACCT[0], "weight": 100, "target": 120}])                                      # % over 100
        bad([{**ACCT[0], "weight": 33.5}, {**ACCT[1], "weight": 66.5}])                        # whole numbers
        k = sc.create_manual_kpi(self.db, U(HR), CO, "Judgment", "", "rating", "high")
        self.db.flush()
        bad([{"kpi": k.key, "weight": 40, "target": 4, "threshold": 2, "cap": 5}, {**ACCT[0], "weight": 60}])   # manual 40 > 30
        ok = sc.clean_items(self.db, CO, [{"kpi": k.key, "weight": 30, "target": 4, "threshold": 2, "cap": 5}, {**ACCT[0], "weight": 70}])
        self.assertEqual([r["weight"] for r in ok], [30, 70])
        self.assertEqual(sc.clean_items(self.db, CO, [{"kpi": "no_shows", "weight": 100, "target": 0, "threshold": 2, "cap": 0}])[0]["kpi"], "no_shows")

    # ── versions ────────────────────────────────────────────────
    def test_first_save_applies_this_month_and_a_change_waits_for_next_month(self):
        today = date(2026, 10, 30)
        v1 = sc.save(self.db, U(HR), CO, "Accounting", ACCT, "first", today)
        self.db.commit()
        self.assertEqual((v1.version, v1.effective_from, v1.effective_to), (1, "2026-10-01", ""))
        self.assertIs(sc.active_for(self.db, CO, "Accounting", today), v1)
        # The same rows again: nothing happens.
        self.assertIs(sc.save(self.db, U(HR), CO, "Accounting", ACCT, "first", today), v1)
        # A change: version 2 from November; version 1 runs to Oct 31 and keeps its rows.
        changed = [{**ACCT[0], "weight": 60}, {**ACCT[1], "weight": 20}, ACCT[2]]
        v2 = sc.save(self.db, U(HR), CO, "Accounting", changed, "more weight on tasks", today)
        self.db.commit()
        self.assertEqual((v2.version, v2.effective_from), (2, "2026-11-01"))
        self.assertEqual(v1.effective_to, "2026-10-31")
        self.assertEqual([r["weight"] for r in sc.items_of(self.db, v1)], [50, 30, 20])
        self.assertIs(sc.active_for(self.db, CO, "Accounting", today), v1)
        self.assertIs(sc.active_for(self.db, CO, "Accounting", date(2026, 11, 3)), v2)
        self.assertIs(sc.upcoming_for(self.db, CO, "Accounting", today), v2)
        # Another change before November starts edits version 2 in place.
        v2b = sc.save(self.db, U(HR), CO, "Accounting", [{**ACCT[0], "weight": 70}, {**ACCT[1], "weight": 10}, ACCT[2]], "", today)
        self.assertIs(v2b, v2)
        self.assertEqual([r["weight"] for r in sc.items_of(self.db, v2)], [70, 10, 20])
        self.assertEqual(len(sc.versions(self.db, CO, "Accounting")), 2)
        # Retire the one in force: it ends this month; the future one is dropped.
        sc.retire(self.db, v2, today)
        sc.retire(self.db, v1, today)
        self.db.commit()
        self.assertEqual((v1.status, v1.effective_to), ("retired", "2026-10-31"))
        self.assertIsNone(sc.active_for(self.db, CO, "Accounting", date(2026, 11, 3)))

    # ── who ─────────────────────────────────────────────────────
    def test_hr_edits_heads_and_the_department_read_outsiders_404(self):
        out = api.save_scorecard(api.ScorecardIn(company=CO, department="Accounting", items=ACCT), U(HR), self.db)
        self.assertEqual(out["version"], 1)
        self.assertEqual(out["items"][0]["name"], "Tasks On Time")
        with self.assertRaises(HTTPException) as cm:
            api.save_scorecard(api.ScorecardIn(company=CO, department="Accounting", items=ACCT), U(HEAD), self.db)
        self.assertEqual(cm.exception.status_code, 403)
        listing = api.list_scorecards(CO, U(HEAD), self.db)
        acct = next(d for d in listing["departments"] if d["name"] == "Accounting")
        self.assertEqual(acct["current"]["version"], 1)
        self.assertFalse(listing["canEdit"])
        self.assertTrue(api.list_scorecards(CO, U(HR), self.db)["canEdit"])
        self.assertEqual(api.my_scorecard(U(EMP), self.db)["scorecard"]["version"], 1)
        self.assertIsNone(api.my_scorecard(U(OTHER), self.db)["scorecard"])          # Ops has none yet
        with self.assertRaises(HTTPException) as cm:
            api.list_scorecards(CO, U(FAR), self.db)
        self.assertEqual(cm.exception.status_code, 404)
        # Departments people are in but Settings does not list still get a card, with a suggestion.
        names = [d["name"] for d in listing["departments"]]
        self.assertIn("Ops", names)
        self.assertTrue(next(d for d in listing["departments"] if d["name"] == "Ops").get("unlisted"))
        self.assertEqual(sum(r["weight"] for r in sc.suggestion_for("Construction")), 100)


if __name__ == "__main__":
    unittest.main()
