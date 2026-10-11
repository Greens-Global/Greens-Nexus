"""
Weather Call, Phase 0 (Oct 10 2026): a shift group's work site, its weather
deciders and its alerts switch - routers/timeclock.py shift-groups.

  - The site must be a work site in the library; '' clears it.
  - A decider must be an active person with Manage access to Shifts
    (manager and above) - the weather call changes shifts.
  - The group list and the schedule say whether the watch can see a group
    (a site with coordinates) so managers can finish the setup.

Uses a throwaway sqlite file. Run with: python -m unittest test_weather_sites -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth        # noqa: E402
import cache       # noqa: E402
import database    # noqa: E402
import main        # noqa: E402
import models      # noqa: E402

BOSS = "wx.boss@greensglobal.com"     # administrator
MGR = "wx.mgr@greensglobal.com"       # manager: may decide
EMP = "wx.emp@greensglobal.com"       # employee: may not
SITE, BARE = "site-wx-harbor", "site-wx-yard"


class WeatherSiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        os.environ["NEXUS_DEV_EMAIL"] = BOSS
        db = database.SessionLocal()
        try:
            for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember,
                      models.HrWorkSite, models.ScheduledShift):
                db.query(m).delete()
            for em, first in ((BOSS, "Boss"), (MGR, "Mia"), (EMP, "Eve")):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="X", work_email=em,
                                            status="active", deleted_at=""))
            db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
            db.add(models.HrWorkSite(id=SITE, name="Harbor View", latitude="33.12", longitude="-117.32"))
            db.add(models.HrWorkSite(id=BARE, name="Yard", latitude="", longitude=""))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()

    def _create(self, **extra):
        r = self.client.post("/timeclock/shift-groups", json={"name": "Crew", "members": [EMP, MGR], **extra})
        return r

    def _groups(self):
        r = self.client.get("/timeclock/shift-groups")
        self.assertEqual(r.status_code, 200, r.text)
        return {g["name"]: g for g in r.json()["groups"]}

    def test_site_deciders_and_switch_round_trip(self):
        r = self._create(work_site_id=SITE, weather_deciders=[MGR], weather_alerts=False)
        self.assertEqual(r.status_code, 200, r.text)
        g = self._groups()["Crew"]
        self.assertEqual(g["workSiteId"], SITE)
        self.assertEqual(g["workSiteName"], "Harbor View")
        self.assertTrue(g["siteLocated"])
        self.assertEqual(g["weatherDeciders"], [MGR])
        self.assertFalse(g["weatherAlerts"])
        # Leave as is: a PATCH without the weather fields keeps them.
        r = self.client.patch(f"/timeclock/shift-groups/{g['id']}", json={"name": "Crew", "members": [EMP]})
        self.assertEqual(r.status_code, 200, r.text)
        g = self._groups()["Crew"]
        self.assertEqual((g["workSiteId"], g["weatherDeciders"], g["weatherAlerts"]), (SITE, [MGR], False))
        # '' clears the site; the switch goes back on.
        r = self.client.patch(f"/timeclock/shift-groups/{g['id']}", json={"name": "Crew", "members": [EMP], "work_site_id": "", "weather_alerts": True})
        self.assertEqual(r.status_code, 200, r.text)
        g = self._groups()["Crew"]
        self.assertEqual((g["workSiteId"], g["workSiteName"], g["siteLocated"], g["weatherAlerts"]), ("", "", False, True))

    def test_a_group_defaults_to_watched_with_no_site(self):
        self.assertEqual(self._create().status_code, 200)
        g = self._groups()["Crew"]
        self.assertEqual((g["workSiteId"], g["weatherDeciders"], g["weatherAlerts"], g["siteLocated"]), ("", [], True, False))

    def test_a_site_without_coordinates_is_not_located(self):
        self.assertEqual(self._create(work_site_id=BARE).status_code, 200)
        g = self._groups()["Crew"]
        self.assertEqual(g["workSiteName"], "Yard")
        self.assertFalse(g["siteLocated"])

    def test_unknown_site_is_refused(self):
        r = self._create(work_site_id="site-nope")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Work site not found", r.text)

    def test_a_decider_needs_manage_access_to_shifts(self):
        r = self._create(weather_deciders=[EMP])
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("cannot make the weather call", r.json()["detail"])
        self.assertIn("Manage access to Shifts", r.json()["detail"])
        r = self._create(weather_deciders=["nobody@greensglobal.com"])
        self.assertEqual(r.status_code, 400)
        self.assertIn("Not in the People list (weather deciders)", r.json()["detail"])
        self.assertEqual(self._create(weather_deciders=[MGR, BOSS]).status_code, 200)
        self.assertEqual(self._groups()["Crew"]["weatherDeciders"], [MGR, BOSS])

    def test_schedule_carries_the_group_site(self):
        self.assertEqual(self._create(work_site_id=SITE).status_code, 200)
        r = self.client.get("/timeclock/schedule", params={"start": "2026-10-12", "end": "2026-10-18"})
        self.assertEqual(r.status_code, 200, r.text)
        g = {x["name"]: x for x in r.json()["groups"]}["Crew"]
        self.assertEqual((g["workSiteId"], g["siteLocated"], g["weatherAlerts"]), (SITE, True, True))


if __name__ == "__main__":
    unittest.main()
