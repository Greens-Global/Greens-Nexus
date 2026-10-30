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


class DailyUpdateTests(unittest.TestCase):
    """The evening notice for tomorrow, the morning notice only on a change,
    one bell and one email per person across their jobsites, by each site's
    own clock, never twice (the sent marks)."""

    @classmethod
    def setUpClass(cls):
        Base.metadata.create_all(bind=engine)

    def setUp(self):
        db = SessionLocal()
        for t in (models.ConstructionProject, models.NexusNotification, models.NexusSetting):
            db.query(t).delete()
        db.commit()
        db.close()
        weather._cache.clear()
        self.sent = []
        self.mail = mock.patch.object(cw, "_send_email", side_effect=lambda to, subject, html: self.sent.append((to[0], subject, html)) or 1)
        self.mail.start()

    def tearDown(self):
        self.mail.stop()

    def _project(self, pid, name, people, lat=33.49, lon=-117.15):
        db = SessionLocal()
        db.add(models.ConstructionProject(id=pid, name=name, address="x", latitude=lat, longitude=lon, status="active",
                                          manager_emails=people[:1], worker_emails=people[1:], executive_emails=[]))
        db.commit()
        db.close()

    def _bells(self):
        db = SessionLocal()
        rows = [(n.recipient, n.title, n.body, n.priority) for n in db.query(models.NexusNotification).all()]
        db.close()
        return rows

    def _tick(self, iso_utc, fc_for=None):
        from datetime import datetime
        fc_for = fc_for or (lambda lat, lon, units="imperial": FC)
        db = SessionLocal()
        with mock.patch.object(weather, "forecast_for", side_effect=fc_for):
            out = cw.tick(db, now=datetime.fromisoformat(iso_utc))
        db.close()
        return out

    def test_evening_notice_for_tomorrow_once_per_person_across_their_sites(self):
        self._project("tem", "GS Temecula", ["boss@greensglobal.com", "crew1@greensglobal.com"])
        self._project("fair", "Fairfield Yard", ["boss@greensglobal.com", "crew2@greensglobal.com"], lat=38.25, lon=-122.03)
        # 4:30 PM in Los Angeles (UTC-7 on 10/30): nothing yet.
        self.assertEqual(self._tick("2026-10-30T23:30:00+00:00")["notices"], 0)
        # 5:05 PM: tomorrow's notice. The fixture's day 2 (10/31) has rain
        # from 7 AM at both sites (same forecast fixture), so the bell leads
        # with the rain and the email is one per person.
        fc = {**FC, "daily": [{**FC["daily"][0], "date": "2026-10-30"}, {**FC["daily"][0], "date": "2026-10-31"}] + FC["daily"][2:]}
        out = self._tick("2026-10-31T00:05:00+00:00", lambda *a, **k: fc)
        self.assertEqual(out, {"notices": 3, "people": 3})
        bells = {r[0]: r for r in self._bells()}
        self.assertEqual(sorted(bells), ["boss@greensglobal.com", "crew1@greensglobal.com", "crew2@greensglobal.com"])
        boss = bells["boss@greensglobal.com"]
        self.assertEqual(boss[1], "Weather At Your Jobsites Tomorrow")
        self.assertIn("GS Temecula: Light Rain, 50-66°, rain from 7 AM (80%)", boss[2])
        self.assertIn("Fairfield Yard", boss[2])
        self.assertEqual(boss[3], 1)                                      # a flagged day is a priority bell
        self.assertEqual(len(self.sent), 3)
        subject = next(s for to, s, h in self.sent if to == "boss@greensglobal.com")
        self.assertEqual(subject, "Jobsite Weather For Tomorrow - Sat 10/31/2026")
        html = next(h for to, s, h in self.sent if to == "boss@greensglobal.com")
        self.assertIn("2 of your 2 jobsites may lose work", html)
        # Same evening, a later tick: nothing goes twice.
        self.assertEqual(self._tick("2026-10-31T01:00:00+00:00", lambda *a, **k: fc)["notices"], 0)
        self.assertEqual(len(self.sent), 3)

    def test_morning_notice_only_when_the_forecast_changed(self):
        self._project("tem", "GS Temecula", ["crew1@greensglobal.com"])
        tomorrow = {**FC, "daily": [{**FC["daily"][0], "date": "2026-10-30"}, {**FC["daily"][0], "date": "2026-10-31"}] + FC["daily"][2:]}
        self._tick("2026-10-31T00:05:00+00:00", lambda *a, **k: tomorrow)         # 5:05 PM: the evening notice
        self.assertEqual(len(self.sent), 1)
        # 6 AM next day, same forecast: quiet.
        self.assertEqual(self._tick("2026-10-31T13:00:00+00:00", lambda *a, **k: tomorrow)["notices"], 0)
        # 7 AM, the rain is gone: the change goes out, once.
        dry = {**DRY, "daily": [{**DRY["daily"][0], "date": "2026-10-30"}, {**DRY["daily"][0], "date": "2026-10-31"}] + DRY["daily"][2:]}
        self.assertEqual(self._tick("2026-10-31T14:00:00+00:00", lambda *a, **k: dry)["notices"], 1)
        self.assertEqual(self._tick("2026-10-31T14:30:00+00:00", lambda *a, **k: dry)["notices"], 0)
        self.assertEqual(self.sent[-1][1], "Jobsite Weather Changed For Today - Sat 10/31/2026")
        bell = [r for r in self._bells() if r[0] == "crew1@greensglobal.com"]
        self.assertEqual(len(bell), 1)                                    # rewritten in place, not a second bell
        self.assertEqual(bell[0][1], "Jobsite Weather Changed For Today")
        self.assertIn("no rain expected", bell[0][2])
        self.assertEqual(bell[0][3], 0)
        # 10 AM is past the morning window: nothing, whatever changed.
        self.assertEqual(self._tick("2026-10-31T17:00:00+00:00", lambda *a, **k: tomorrow)["notices"], 0)

    def test_a_site_with_no_people_or_no_point_and_one_outage_are_skipped(self):
        self._project("tem", "GS Temecula", [])
        self._project("nop", "No Point", ["crew1@greensglobal.com"], lat=0.0, lon=0.0)
        self._project("fail", "Flaky", ["crew1@greensglobal.com"], lat=30.27, lon=-97.74)
        self._project("ok", "Fine", ["crew1@greensglobal.com"], lat=38.25, lon=-122.03)
        from fastapi import HTTPException

        def fc_for(lat, lon, units="imperial"):
            if lat == 30.27:
                raise HTTPException(502, weather.UNAVAILABLE)
            return {**DRY, "daily": [{**DRY["daily"][0], "date": "2026-10-30"}, {**DRY["daily"][0], "date": "2026-10-31"}] + DRY["daily"][2:]}
        out = self._tick("2026-10-31T00:05:00+00:00", fc_for)
        self.assertEqual(out, {"notices": 1, "people": 1})
        self.assertIn("Fine: Mostly Sunny, 50-66°, no rain expected", self._bells()[0][2])
        self.assertNotIn("Flaky", self._bells()[0][2])

    def test_outlook_words_and_flags(self):
        cfg = cw_defaults()
        o = cw.day_outlook(FC, "2026-10-31", cfg)
        self.assertEqual((o["flag"], o["rainFrom"], o["chance"]), ("rain", "2026-10-31T07:00", 80))
        self.assertEqual(cw.site_line("GS Temecula", o), "GS Temecula: Light Rain, 50-66°, rain from 7 AM (80%)")
        windy = cw.day_outlook({**DRY, "daily": [{**DRY["daily"][0], "windMax": 31}]}, "2026-10-31", cfg)
        self.assertEqual(windy["flag"], "wind")
        self.assertIn("wind to 31 mph", cw.site_line("Austin", windy))
        hot = cw.day_outlook({**DRY, "daily": [{**DRY["daily"][0], "high": 101}]}, "2026-10-31", cfg)
        self.assertEqual((hot["flag"], cw.site_line("Austin", hot)), ("heat", "Austin: Mostly Sunny, 50-101°, no rain expected, high heat"))
        self.assertIsNone(cw.day_outlook(FC, "2027-01-01", cfg))
        self.assertNotEqual(cw.fingerprint(o), cw.fingerprint(windy))


def cw_defaults():
    from weather_watch import DEFAULTS
    return DEFAULTS


if __name__ == "__main__":
    unittest.main()
