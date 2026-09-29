"""Workforce Analytics team views (Sep 29 2026).

A saved view narrows who a manager sees on Coverage / Locations / Activity /
Screenshots. The guarantees under test:

  * a view can never widen access - hand-picking someone outside your scope,
    or a department that has people you can't see, resolves to your scope only;
  * the builder's option lists come from your scope too;
  * views are private - another person can't read, edit or delete yours;
  * team filters intersect (department AND reporting line ...) and names add on;
  * "reports to" covers the whole line, direct and indirect;
  * one default per person;
  * the rows live in dashboard_views as target='workforce' and never show up
    in the dashboard's own view list.

    python -m unittest test_workforce_views -v
"""
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)

BOSS = "wfv.boss@greensglobal.com"          # level 3 manager: sees directs + self
LEAD = "wfv.lead@greensglobal.com"          # reports to BOSS, manages AMY
AMY = "wfv.amy@greensglobal.com"            # reports to LEAD (BOSS's indirect)
BEN = "wfv.ben@greensglobal.com"            # reports to BOSS, Sales
OUT = "wfv.out@greensglobal.com"            # nobody BOSS can see
ADMIN = "wfv.admin@greensglobal.com"        # level 4: whole company
GROUP = "wfv-group"


class WorkforceViewTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            def emp(email, dept, mgr="", loc=""):
                db.add(models.NexusEmployee(id=f"emp-{email}", first_name=email.split(".")[1].split("@")[0].title(),
                                            last_name="X", work_email=email, status="active", deleted_at="",
                                            department=dept, manager_email=mgr, location=loc, company="co-wfv"))
            emp(BOSS, "WFV Ops")
            emp(LEAD, "WFV Ops", BOSS, "WFV Site")
            emp(AMY, "WFV Ops", LEAD, "WFV Site")
            emp(BEN, "WFV Sales", BOSS)
            emp(OUT, "WFV Ops")
            emp(ADMIN, "WFV IT")
            db.add(models.NexusRole(email=BOSS, role="manager", display_name="Boss", assigned_by="test"))
            db.add(models.NexusRole(email=ADMIN, role="administrator", display_name="Admin", assigned_by="test"))
            db.add(models.ShiftGroup(id=GROUP, name="Front Desk"))
            db.add(models.ShiftGroupMember(id="wfv-sgm-1", group_id=GROUP, employee_email=BEN))
            db.add(models.ShiftGroupMember(id="wfv-sgm-2", group_id=GROUP, employee_email=OUT))
            db.commit()
        finally:
            db.close()
        auth.invalidate_role_cache()
        cache.module_grants.invalidate()
        self._as(BOSS)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        auth.invalidate_role_cache()
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("wfv.%")).delete(synchronize_session=False))
            db.query(models.NexusRole).filter(models.NexusRole.email.like("wfv.%")).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.DashboardView).filter(models.DashboardView.owner_email.like("wfv.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _create(self, name="Team", **criteria):
        r = self.client.post("/timeclock/workforce-views", json={"name": name, "criteria": criteria})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    # ── Scope: a view only ever narrows ───────────────────────────────────

    def test_a_hand_picked_person_outside_scope_is_dropped(self):
        v = self._create(people=[BEN, OUT])
        self.assertEqual(v["emails"], [BEN])

    def test_a_department_resolves_inside_scope_only(self):
        # BOSS sees directs (LEAD, BEN) + self; OUT is in Ops but out of scope.
        v = self._create(departments=["WFV Ops"])
        self.assertEqual(set(v["emails"]), {BOSS, LEAD})

    def test_the_same_view_shows_more_to_someone_who_can_see_more(self):
        self._as(ADMIN)
        v = self._create(departments=["WFV Ops"])
        self.assertTrue({BOSS, LEAD, AMY, OUT} <= set(v["emails"]))

    def test_options_come_from_scope(self):
        o = self.client.get("/timeclock/workforce-views/options").json()
        people = {p["email"] for p in o["people"]}
        self.assertNotIn(OUT, people)
        self.assertIn(BEN, people)
        # The shift group shows only its visible member in the count.
        grp = next(g for g in o["shiftGroups"] if g["id"] == GROUP)
        self.assertEqual(grp["count"], 1)

    # ── Matching rules ────────────────────────────────────────────────────

    def test_reports_to_covers_the_whole_line(self):
        self._as(ADMIN)
        v = self._create(managers=[BOSS])
        self.assertEqual(set(v["emails"]), {LEAD, AMY, BEN})

    def test_team_filters_intersect_and_names_add_on(self):
        self._as(ADMIN)
        v = self._create(managers=[BOSS], departments=["WFV Ops"], people=[ADMIN])
        self.assertEqual(set(v["emails"]), {LEAD, AMY, ADMIN})
        v = self._create(name="Desk", shiftGroups=[GROUP], locations=["WFV Site"])
        self.assertEqual(v["emails"], [])       # nobody is in both
        v = self._create(name="Site", locations=["WFV Site"])
        self.assertEqual(set(v["emails"]), {LEAD, AMY})

    def test_preview_matches_what_saving_resolves(self):
        r = self.client.post("/timeclock/workforce-views/preview", json={"criteria": {"departments": ["WFV Sales"]}}).json()
        self.assertEqual(r, {"emails": [BEN], "count": 1})

    # ── Ownership, defaults, housekeeping ─────────────────────────────────

    def test_views_are_private(self):
        v = self._create()
        self._as(ADMIN)
        self.assertEqual(self.client.get("/timeclock/workforce-views").json()["views"], [])
        self.assertEqual(self.client.put(f"/timeclock/workforce-views/{v['id']}", json={"name": "Mine"}).status_code, 404)
        self.assertEqual(self.client.delete(f"/timeclock/workforce-views/{v['id']}").status_code, 404)

    def test_one_default_per_person(self):
        a = self._create(name="A")
        b = self._create(name="B")
        self.client.put(f"/timeclock/workforce-views/{a['id']}", json={"isDefault": True})
        self.client.put(f"/timeclock/workforce-views/{b['id']}", json={"isDefault": True})
        views = {v["name"]: v["isDefault"] for v in self.client.get("/timeclock/workforce-views").json()["views"]}
        self.assertEqual(views, {"A": False, "B": True})

    def test_rename_edit_delete_and_validation(self):
        v = self._create(departments=["WFV Sales"])
        r = self.client.put(f"/timeclock/workforce-views/{v['id']}",
                            json={"name": "Sales Floor", "criteria": {"people": [BOSS]}}).json()
        self.assertEqual((r["name"], r["emails"]), ("Sales Floor", [BOSS]))
        self.assertEqual(self.client.post("/timeclock/workforce-views", json={"name": "  "}).status_code, 400)
        self.assertEqual(self.client.delete(f"/timeclock/workforce-views/{v['id']}").json(), {"ok": True})
        self.assertEqual(self.client.get("/timeclock/workforce-views").json()["views"], [])

    def test_criteria_are_cleaned(self):
        v = self._create(people=[BEN.upper(), BEN, 7, ""], bogus=["x"])
        self.assertEqual(v["criteria"]["people"], [BEN])
        self.assertNotIn("bogus", v["criteria"])

    def test_workforce_rows_never_reach_the_dashboard_picker(self):
        self._create()
        views = self.client.get("/dashboards/views?target=dashboard").json()["views"]
        self.assertFalse([x for x in views if x.get("target") == "workforce"])

    def test_an_employee_cannot_use_views(self):
        self._as(AMY)
        self.assertIn(self.client.get("/timeclock/workforce-views").status_code, (401, 403))


if __name__ == "__main__":
    unittest.main()
