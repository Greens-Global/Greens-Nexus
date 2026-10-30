"""Project-based weather for Construction (Neil, call of 10/30/2026).

    python -m unittest test_construction_weather

A project's address becomes its map point on create and when the address
changes (never over a typed point); /construction/weather lists each active
site's sky with the first wet hour and a rain / wind / heat flag that follows
the Weather Watch thresholds; a site with no point says why; a provider
outage for one site leaves the others standing.
"""
import os
import unittest
from unittest import mock

os.environ["DATABASE_URL"] = "sqlite:///./test_construction_weather.db"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ["NEXUS_DEV_EMAIL"] = "manager@greensglobal.com"

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import construction_weather as cw  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
from database import Base, SessionLocal, engine  # noqa: E402
from routers import weather  # noqa: E402

FC = {
    "timezone": "America/Los_Angeles", "units": {"temp": "°F", "wind": "mph", "precip": "in"},
    "current": {"temp": 61, "code": 3, "isDay": True, "wind": 4, "humidity": 70},
    "today": {"high": 66, "low": 50, "precipChance": 80, "sunrise": "2026-10-31T07:10", "sunset": "2026-10-31T18:00"},
    "hourly": [{"time": "2026-10-31T06:00", "temp": 52, "code": 3, "isDay": False, "precipChance": 10, "precip": 0.0, "wind": 3},
               {"time": "2026-10-31T07:00", "temp": 53, "code": 61, "isDay": True, "precipChance": 75, "precip": 0.2, "wind": 5},
               {"time": "2026-10-31T08:00", "temp": 54, "code": 63, "isDay": True, "precipChance": 80, "precip": 0.4, "wind": 6}],
    "daily": [{"date": "2026-10-31", "high": 66, "low": 50, "code": 61, "precipChance": 80, "precipSum": 0.6, "windMax": 9},
              {"date": "2026-11-01", "high": 70, "low": 51, "code": 2, "precipChance": 5, "precipSum": 0.0, "windMax": 12}]
              + [{"date": f"2026-11-0{i}", "high": 70, "low": 50, "code": 1, "precipChance": 0, "precipSum": 0.0, "windMax": 8} for i in range(2, 9)],
    "fetchedAt": "2026-10-31T13:00:00Z",
}
DRY = {**FC, "today": {**FC["today"], "precipChance": 0},
       "hourly": [{**h, "code": 1, "precipChance": 0, "precip": 0.0} for h in FC["hourly"]],
       "daily": [{**d, "code": 1, "precipChance": 0, "precipSum": 0.0} for d in FC["daily"]]}


class ConstructionWeatherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Base.metadata.create_all(bind=engine)

    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        db = SessionLocal()
        for t in (models.ConstructionProject, models.ConstructionActivity, models.NexusRole):
            db.query(t).delete()
        db.add(models.NexusRole(email="manager@greensglobal.com", role="manager"))
        db.commit()
        db.close()
        auth.invalidate_role_cache()
        weather._cache.clear()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip

    def test_the_address_becomes_the_map_point_on_create_and_when_it_changes(self):
        with mock.patch("asset_geocode.paced_search", return_value=(33.4936, -117.1484)) as geo:
            r = self.client.post("/construction/projects", json={"name": "GS Temecula", "address": "41000 Main St, Temecula, CA"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertEqual((r.json()["latitude"], r.json()["longitude"]), (33.4936, -117.1484))
        geo.assert_called_once_with("41000 Main St, Temecula, CA")
        pid = r.json()["id"]
        # A new address moves the point...
        with mock.patch("asset_geocode.paced_search", return_value=(32.7157, -117.1611)):
            r = self.client.patch(f"/construction/projects/{pid}", json={"address": "1 Harbor Dr, San Diego, CA"})
        self.assertEqual((r.json()["latitude"], r.json()["longitude"]), (32.7157, -117.1611))
        # ...a change to anything else, or a typed point, does not look anything up.
        with mock.patch("asset_geocode.paced_search") as geo:
            self.client.patch(f"/construction/projects/{pid}", json={"phase": "Framing"})
            r = self.client.patch(f"/construction/projects/{pid}", json={"address": "Somewhere", "latitude": 30.0, "longitude": -97.0})
        geo.assert_not_called()
        self.assertEqual((r.json()["latitude"], r.json()["longitude"]), (30.0, -97.0))

    def test_a_lookup_that_fails_or_finds_nothing_still_saves_the_project(self):
        with mock.patch("asset_geocode.paced_search", side_effect=RuntimeError("nominatim 503")):
            r = self.client.post("/construction/projects", json={"name": "Fairfield", "address": "Nowhere Rd"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["latitude"], 0.0)
        with mock.patch("asset_geocode.paced_search", return_value=None):
            r = self.client.post("/construction/projects", json={"name": "Texas", "address": "???"})
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.json()["latitude"], 0.0)

    def _project(self, name, lat, lon, address="x", status="active"):
        db = SessionLocal()
        p = models.ConstructionProject(id=name.lower(), name=name, address=address, latitude=lat, longitude=lon,
                                       status=status, manager_emails=[], worker_emails=[], executive_emails=[])
        db.add(p)
        db.commit()
        db.close()

    def test_site_weather_lists_every_active_site_with_its_flag_and_first_wet_hour(self):
        self._project("Temecula", 33.49, -117.15)
        self._project("Austin", 30.27, -97.74)
        self._project("No Point", 0.0, 0.0, address="")
        self._project("Done", 31.0, -100.0, status="complete")

        def fake(lat, lon, units="imperial"):
            return FC if lat == 33.49 else DRY
        with mock.patch.object(weather, "forecast_for", side_effect=fake):
            r = self.client.get("/construction/weather")
        self.assertEqual(r.status_code, 200, r.text)
        sites = {s["name"]: s for s in r.json()["sites"]}
        self.assertEqual(sorted(sites), ["Austin", "No Point", "Temecula"])      # the complete one is left out
        t = sites["Temecula"]["weather"]
        self.assertEqual(t["flag"], "rain")
        self.assertEqual(t["rainFrom"], "2026-10-31T07:00")                      # the first heads-up hour, not the dry 6 AM
        self.assertEqual(t["rainChance"], 75)
        self.assertEqual(len(t["daily"]), 5)
        a = sites["Austin"]["weather"]
        self.assertEqual((a["flag"], a["rainFrom"]), ("", ""))
        self.assertIsNone(sites["No Point"]["weather"])
        self.assertIn("address", sites["No Point"]["reason"])

    def test_wind_and_heat_flags_and_one_outage_leaves_the_others_standing(self):
        windy = {**DRY, "daily": [{**DRY["daily"][0], "windMax": 31}] + DRY["daily"][1:]}
        hot = {**DRY, "daily": [DRY["daily"][0], {**DRY["daily"][1], "high": 101}] + DRY["daily"][2:]}
        self.assertEqual(cw._flag(windy, cw_defaults())[0], "wind")
        self.assertEqual(cw._flag(hot, cw_defaults())[0], "heat")
        self.assertEqual(cw._flag(FC, cw_defaults())[0], "rain")                 # rain beats wind and heat
        storm = {**FC, "hourly": [{**FC["hourly"][1], "code": 95, "precipChance": 60}]}
        self.assertEqual(cw._flag(storm, cw_defaults())[0], "storm")

        self._project("Temecula", 33.49, -117.15)
        self._project("Austin", 30.27, -97.74)
        from fastapi import HTTPException

        def flaky(lat, lon, units="imperial"):
            if lat == 30.27:
                raise HTTPException(502, weather.UNAVAILABLE)
            return DRY
        with mock.patch.object(weather, "forecast_for", side_effect=flaky):
            r = self.client.get("/construction/weather?units=metric")
        sites = {s["name"]: s for s in r.json()["sites"]}
        self.assertIsNotNone(sites["Temecula"]["weather"])
        self.assertIsNone(sites["Austin"]["weather"])
        self.assertEqual(sites["Austin"]["reason"], weather.UNAVAILABLE)
        self.assertEqual(r.json()["units"], "metric")

    def test_backfill_places_only_the_projects_with_an_address_and_no_point(self):
        self._project("Has Point", 33.0, -117.0)
        self._project("Needs Point", 0.0, 0.0, address="100 Site Rd, Fairfield, CA")
        self._project("No Address", 0.0, 0.0, address="")
        db = SessionLocal()
        with mock.patch("asset_geocode.paced_search", return_value=(38.25, -122.04)) as geo:
            n = cw.backfill(db)
        self.assertEqual(n, 1)
        geo.assert_called_once_with("100 Site Rd, Fairfield, CA")
        rows = {p.name: (p.latitude, p.longitude) for p in db.query(models.ConstructionProject).all()}
        db.close()
        self.assertEqual(rows["Needs Point"], (38.25, -122.04))
        self.assertEqual(rows["Has Point"], (33.0, -117.0))
        self.assertEqual(rows["No Address"], (0.0, 0.0))


def cw_defaults():
    from weather_watch import DEFAULTS
    return DEFAULTS


if __name__ == "__main__":
    unittest.main()
