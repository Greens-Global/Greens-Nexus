"""KPI scorecards per role (Oct 30 2026) - perf_scorecards.py and
routers/perf_scorecards.py on a throwaway database.
  * the library is Nexus's metrics plus manual KPIs HR adds (per company or
    for every company), with a unique key;
  * weights total 100, manual KPIs carry at most 30%, targets sit in the
    right order for the KPI's direction, unknown and retired KPIs are refused;
  * a role's scorecard saved for the first time applies this month; a change
    to one in force becomes next month's version and the current one keeps
    its rows to the end of this month; a version not yet started is edited in
    place; retire ends it;
  * shared sets are named, edited in place, and a role copies them (or
    another role) as its own rows - editing the source changes nothing;
  * HR for the company edits, a role's holder reads their own, an outsider
    gets 404; a set for every company needs HR for every company.
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
HR, EMP, OTHER, FAR, ADMIN = ("hr.sc@greensglobal.com", "emp.sc@greensglobal.com", "other.sc@greensglobal.com",
                              "far.sc@greensglobal.com", "admin.sc@greensglobal.com")
ANALYST, SENIOR, CREW, EVERY = "r-analyst", "r-senior", "r-crew", "r-every"


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
        for m in (models.PerfKpi, models.PerfScorecard, models.PerfScorecardKpi, models.NexusEmployee, models.HrEntity,
                  models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Score Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO2, name="Far Co", hr_contact_email=""))
        for gid, name, co, dept in ((ANALYST, "Analyst", CO, "Accounting"), (SENIOR, "Senior Analyst", CO, "Accounting"),
                                    (CREW, "Crew Member", CO, "Construction"), (EVERY, "Project Manager", "", "")):
            self.db.add(models.NexusGroup(id=gid, name=name, company_id=co, department=dept, is_job_role=1, allowed_modules=""))
        for email, first, dept, co in ((HR, "Hana", "HR", CO), (EMP, "Erin", "Accounting", CO), (OTHER, "Omar", "Ops", CO),
                                       (FAR, "Fay", "Accounting", CO2), (ADMIN, "Ada", "IT", CO)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="T", company=co,
                                             department=dept, status="active"))
        self.db.add(models.NexusGroupMember(group_id=ANALYST, email=EMP))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    # ── library ─────────────────────────────────────────────────
    def test_library_is_nexus_metrics_plus_manual_kpis_with_unique_keys(self):
        lib = api.list_kpis(CO, U(HR), self.db)
        self.assertIn("tasks_on_time", [k["key"] for k in lib["kpis"]])
        api.create_kpi(api.KpiIn(company=CO, name="Client Calls Returned", unit="%"), U(HR), self.db)
        api.create_kpi(api.KpiIn(company=CO, name="Client Calls Returned", unit="rating"), U(HR), self.db)
        keys = [k["key"] for k in api.list_kpis(CO, U(HR), self.db)["kpis"] if k["source"] == "manual"]
        self.assertEqual(keys, ["manual:client-calls-returned", "manual:client-calls-returned-2"])
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
        bad([{**ACCT[0], "weight": 60}, ACCT[1], ACCT[2]])
        bad([{"kpi": "nope", "weight": 100, "target": 1, "threshold": 0, "cap": 1}])
        bad([{**ACCT[0], "weight": 100, "threshold": 99}])
        bad([{"kpi": "no_shows", "weight": 100, "target": 0, "threshold": 2, "cap": 3}])
        bad([{**ACCT[0], "weight": 100, "target": 120}])
        bad([{**ACCT[0], "weight": 33.5}, {**ACCT[1], "weight": 66.5}])
        k = sc.create_manual_kpi(self.db, U(HR), CO, "Judgment", "", "rating", "high")
        self.db.flush()
        bad([{"kpi": k.key, "weight": 40, "target": 4, "threshold": 2, "cap": 5}, {**ACCT[0], "weight": 60}])
        ok = sc.clean_items(self.db, CO, [{"kpi": k.key, "weight": 30, "target": 4, "threshold": 2, "cap": 5}, {**ACCT[0], "weight": 70}])
        self.assertEqual([r["weight"] for r in ok], [30, 70])

    # ── versions ────────────────────────────────────────────────
    def test_first_save_applies_this_month_and_a_change_waits_for_next_month(self):
        today = date(2026, 10, 30)
        v1 = sc.save(self.db, U(HR), CO, ANALYST, ACCT, "first", "", today)
        self.db.commit()
        self.assertEqual((v1.version, v1.effective_from, v1.effective_to, v1.name), (1, "2026-10-01", "", "Analyst"))
        self.assertIs(sc.save(self.db, U(HR), CO, ANALYST, ACCT, "first", "", today), v1)          # unchanged: nothing happens
        changed = [{**ACCT[0], "weight": 60}, {**ACCT[1], "weight": 20}, ACCT[2]]
        v2 = sc.save(self.db, U(HR), CO, ANALYST, changed, "more on tasks", "", today)
        self.db.commit()
        self.assertEqual((v2.version, v2.effective_from, v1.effective_to), (2, "2026-11-01", "2026-10-31"))
        self.assertEqual([r["weight"] for r in sc.items_of(self.db, v1)], [50, 30, 20])
        self.assertIs(sc.active_for(self.db, ANALYST, today), v1)
        self.assertIs(sc.active_for(self.db, ANALYST, date(2026, 11, 3)), v2)
        self.assertIs(sc.save(self.db, U(HR), CO, ANALYST, [{**ACCT[0], "weight": 70}, {**ACCT[1], "weight": 10}, ACCT[2]], "", "", today), v2)
        self.assertEqual([r["weight"] for r in sc.items_of(self.db, v2)], [70, 10, 20])
        sc.retire(self.db, v2, today)
        sc.retire(self.db, v1, today)
        self.db.commit()
        self.assertEqual((v1.status, v1.effective_to), ("retired", "2026-10-31"))
        self.assertIsNone(sc.active_for(self.db, ANALYST, date(2026, 11, 3)))
        with self.assertRaises(HTTPException):
            sc.save(self.db, U(HR), CO, "not-a-role", ACCT, "", "", today)

    # ── shared sets and copying ─────────────────────────────────
    def test_a_role_copies_a_shared_set_or_another_role_and_keeps_its_own_rows(self):
        shared = api.save_shared(api.SharedIn(company=CO, name="Office Staff", items=ACCT), U(HR), self.db)
        self.assertEqual((shared["kind"], shared["name"], shared["effectiveFrom"]), ("shared", "Office Staff", ""))
        src = api.copy_source(shared["id"], CO, U(HR), self.db)
        self.assertEqual((src["copiedFrom"], [r["weight"] for r in src["items"]]), ("Shared set: Office Staff", [50, 30, 20]))
        out = api.save_scorecard(api.ScorecardIn(company=CO, roleId=ANALYST, items=src["items"], copiedFrom=src["copiedFrom"]), U(HR), self.db)
        self.assertEqual(out["copiedFrom"], "Shared set: Office Staff")
        # Editing the shared set does not touch the role's copy.
        api.save_shared(api.SharedIn(company=CO, id=shared["id"], name="Office Staff", items=[{**ACCT[0], "weight": 100}]), U(HR), self.db)
        self.assertEqual([r["weight"] for r in api.list_scorecards(CO, U(HR), self.db)["shared"][0]["items"]], [100])
        analyst = next(r for r in api.list_scorecards(CO, U(HR), self.db)["roles"] if r["id"] == ANALYST)
        self.assertEqual([r["weight"] for r in analyst["current"]["items"]], [50, 30, 20])
        # Another role copies from the Analyst role.
        src2 = api.copy_source(ANALYST, CO, U(HR), self.db)
        self.assertEqual(src2["copiedFrom"], "Role: Analyst")
        api.save_scorecard(api.ScorecardIn(company=CO, roleId=SENIOR, items=src2["items"], copiedFrom=src2["copiedFrom"]), U(HR), self.db)
        senior = next(r for r in api.list_scorecards(CO, U(HR), self.db)["roles"] if r["id"] == SENIOR)
        self.assertEqual(senior["current"]["copiedFrom"], "Role: Analyst")
        with self.assertRaises(HTTPException):
            api.copy_source(CREW, CO, U(HR), self.db)                     # Crew has nothing to copy yet
        # A set for every company: HR for every company only; every company may copy it.
        with self.assertRaises(HTTPException):
            api.save_shared(api.SharedIn(company="", name="Everyone", items=ACCT), U(HR), self.db)
        every = api.save_shared(api.SharedIn(company="", name="Everyone", items=ACCT), U(ADMIN, level=5), self.db)
        self.assertIn(every["id"], [s["id"] for s in api.list_scorecards(CO2, U(ADMIN, level=5), self.db)["shared"]])
        # Retire on a shared set deletes it.
        api.retire_scorecard(shared["id"], U(HR), self.db)
        self.assertEqual([s["name"] for s in api.list_scorecards(CO, U(HR), self.db)["shared"]], ["Everyone"])

    # ── who ─────────────────────────────────────────────────────
    def test_hr_edits_a_role_holder_reads_their_own_outsiders_404(self):
        out = api.save_scorecard(api.ScorecardIn(company=CO, roleId=ANALYST, items=ACCT), U(HR), self.db)
        self.assertEqual((out["version"], out["items"][0]["name"]), (1, "Tasks On Time"))
        with self.assertRaises(HTTPException) as cm:
            api.save_scorecard(api.ScorecardIn(company=CO, roleId=ANALYST, items=ACCT), U(EMP), self.db)
        self.assertEqual(cm.exception.status_code, 403)
        listing = api.list_scorecards(CO, U(EMP), self.db)
        self.assertFalse(listing["canEdit"])
        self.assertEqual(sorted(r["name"] for r in listing["roles"]), ["Analyst", "Crew Member", "Project Manager", "Senior Analyst"])
        self.assertEqual(next(r for r in listing["roles"] if r["id"] == ANALYST)["members"], 1)
        mine = api.my_scorecard(U(EMP), self.db)
        self.assertEqual((mine["role"]["name"], mine["scorecard"]["version"]), ("Analyst", 1))
        self.assertIsNone(api.my_scorecard(U(OTHER), self.db)["role"])
        with self.assertRaises(HTTPException) as cm:
            api.list_scorecards(CO, U(FAR), self.db)
        self.assertEqual(cm.exception.status_code, 404)
        self.assertEqual(sum(r["weight"] for r in sc.suggestion_for("", "Crew Member")), 100)
        self.assertEqual(sc.suggestion_for("Construction")[0]["kpi"], "on_time")


if __name__ == "__main__":
    unittest.main()
