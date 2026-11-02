"""
The weather follows the jobsite (Neil, call of 10/30/2026; Pranshu's
decisions of 11/02/2026): jobsites.py + the place in weather_watch.py and
weather_call.py.

  - A shift names where it is worked: '' = the team's site, a construction
    project or a company site. A project with no map point uses the team's
    site (decision 1).
  - Weather Watch bands, advises and dedupes each team-day PER PLACE, so a
    crew 560 miles from the yard hears about its own rain; a place nobody
    works at any more loses its band.
  - Weather Call is one place at a time (decision 2): the roster, the call
    and its record are the place's, so a call for the rainy jobsite never
    touches anyone working somewhere dry.
  - The shift popup saves the jobsite and "+ New Jobsite" makes a project
    from a name and an address (decision 3); the evening jobsite notice also
    reaches the people scheduled there.

Throwaway sqlite. Run with: python -m unittest test_weather_jobsite -v
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth                   # noqa: E402
import cache                  # noqa: E402
import construction_weather   # noqa: E402
import database               # noqa: E402
import jobsites               # noqa: E402
import main                   # noqa: E402
import models                 # noqa: E402
import weather_call           # noqa: E402
import weather_watch          # noqa: E402

BOSS = "wj.boss@greensglobal.com"   # administrator + company manager
MGR = "wj.mgr@greensglobal.com"     # the team's weather decider
ANN = "wj.ann@greensglobal.com"     # at Redding
BOB = "wj.bob@greensglobal.com"     # at Redding
CAL = "wj.cal@greensglobal.com"     # at the yard
ENT, GROUP, SITE = "ent-wj", "grp-wj", "site-wj"
RED, BAR = "project-red", "project-bar"
DAY = "2026-10-14"
NOON = datetime(2026, 10, 13, 19, 0, tzinfo=timezone.utc)   # 12 PM Pacific on 10/13: not quiet hours
REDDING_LAT = 40.58


def forecast(chance, inches_per_hour, day=DAY):
    return {"timezone": "America/Los_Angeles",
            "hours": [{"time": f"{day}T{h:02d}:00", "chance": chance, "inches": inches_per_hour, "code": 61} for h in range(24)]}


def by_point(lat, lon):
    """Rain at Redding, dry at the yard."""
    return forecast(85, 0.1) if round(float(lat), 2) == REDDING_LAT else forecast(5, 0)


class JobsiteTests(unittest.TestCase):
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
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrWorkSite,
                  models.HrEntity, models.ScheduledShift, models.NexusNotification, models.ScheduleDayNote,
                  models.WeatherOutlook, models.WeatherAdvisory, models.WeatherDecision, models.NexusPersonPref,
                  models.NexusSetting, models.HrDepartment, models.ConstructionProject, models.ConstructionActivity):
            self.db.query(m).delete()
        for em, first in ((BOSS, "Boss"), (MGR, "Mia"), (ANN, "Ann"), (BOB, "Bob"), (CAL, "Cal")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="X", work_email=em,
                                             phone="(949) 555-0101", status="active", deleted_at="", company=ENT,
                                             department="Construction" if em in (ANN, BOB, CAL) else ""))
        self.db.add(models.HrDepartment(id="d-wj-con", company_id=ENT, name="Construction"))
        self.db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", manager_email=BOSS, manager_emails=[BOSS]))
        self.db.add(models.HrWorkSite(id=SITE, name="Irvine Yard", latitude="33.68", longitude="-117.83"))
        self.db.add(models.ShiftGroup(id=GROUP, name="Yard Crew", work_site_id=SITE, weather_alerts=1,
                                      weather_decider_emails=json.dumps([MGR]), teams_chat_id="chat-1", created_by=BOSS))
        self.db.add(models.ConstructionProject(id="red", name="Redding Solar Farm", address="1 Solar Way, Redding, CA",
                                               latitude=REDDING_LAT, longitude=-122.39, status="active", deleted_at="",
                                               manager_emails=[MGR], worker_emails=[], executive_emails=[]))
        self.db.add(models.ConstructionProject(id="bar", name="Barstow Lot", address="", latitude=0.0, longitude=0.0,
                                               status="active", deleted_at="", manager_emails=[MGR], worker_emails=[],
                                               executive_emails=[]))
        for i, (em, js) in enumerate(((ANN, RED), (BOB, RED), (CAL, ""))):
            self.db.add(models.ShiftGroupMember(id=f"m{i}", group_id=GROUP, employee_email=em))
            self.db.add(models.ScheduledShift(id=f"s-{em}", employee_email=em, work_date=DAY, start_hhmm="07:00",
                                              end_hhmm="15:30", published=1, group_id=GROUP, jobsite=js, created_by=BOSS))
        self.db.commit()
        weather_watch.save_config(self.db, {"companies": {ENT: True}}, BOSS)
        weather_watch._cache.clear()
        patches = [mock.patch.object(weather_watch, "_post_teams", return_value="ok"),
                   mock.patch.object(weather_watch, "_send_email", side_effect=lambda to, s, h: len(to)),
                   mock.patch.object(weather_watch, "fetch_alerts", return_value=[]),
                   mock.patch.object(weather_watch, "fetch_forecast", side_effect=by_point),
                   mock.patch.object(weather_call, "_send_sms", return_value=(True, "")),
                   mock.patch.object(weather_call, "_send_email", return_value="ok"),
                   mock.patch.object(weather_call, "_teams_dm", return_value="ok"),
                   mock.patch.object(weather_call, "_teams_group", return_value="ok")]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _outlooks(self):
        self.db.expire_all()
        return {r.id: r for r in self.db.query(models.WeatherOutlook).all()}

    def _shift(self, sid):
        self.db.expire_all()
        return self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first()

    def _scan(self):
        return weather_watch.scan_once(self.db, now_utc=NOON)

    # ── where a shift is ──────────────────────────────────────────────────
    def test_the_place_of_a_shift(self):
        cat = jobsites.Catalog(self.db)
        self.assertEqual(cat.place_of(RED, SITE), RED)
        self.assertEqual(cat.place_of(BAR, SITE), "", "no map point: the team's site (decision 1)")
        self.assertEqual(cat.place_of("site-" + SITE, SITE), "", "the team's own site is the team's site")
        self.assertEqual(cat.place_of("", SITE), "")
        self.assertEqual(cat.place_of("project-gone", SITE), "")
        opts = {o["id"]: o for o in cat.options()}
        self.assertEqual((opts[RED]["located"], opts[BAR]["located"], opts[BAR]["hint"]), (True, False, jobsites.NO_POINT))
        self.assertEqual(opts["site-" + SITE]["kind"], "site")
        self.assertEqual([o["kind"] for o in cat.options()], ["project", "project", "site"], "projects first")
        with self.assertRaises(ValueError):
            jobsites.normalize(self.db, "project-gone")
        self.assertEqual(jobsites.normalize(self.db, " "), "")

    # ── Weather Watch per place ───────────────────────────────────────────
    def test_each_place_is_its_own_band_and_advisory(self):
        s = self._scan()
        self.assertEqual(s["advisories"], 1)
        rows = self._outlooks()
        home, red = rows[f"{GROUP}:{DAY}"], rows[f"{GROUP}:{DAY}:{RED}"]
        self.assertEqual((home.band, home.people, home.place), ("quiet", 1, ""))
        self.assertEqual((red.band, red.people, red.place), ("major", 2, RED))
        bells = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == MGR).all()
        self.assertEqual([b.title for b in bells], ["Rain Expected for Yard Crew at Redding Solar Farm on Wed 10/14"])
        self.assertEqual(json.loads(bells[0].action)["sub"], f"schedule:{DAY}:{GROUP}:{RED}")
        adv = self.db.query(models.WeatherAdvisory).all()
        self.assertEqual([(a.place, a.band) for a in adv], [(RED, "major")])
        note = self.db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.group_id == GROUP).first()
        self.assertTrue(note.note.startswith("Weather: Redding Solar Farm: Major rain"), note.note)
        self.assertIn("Yard Crew at Redding Solar Farm", weather_watch._send_email.call_args[0][1])
        grid = weather_watch.outlook_rows(self.db, DAY, DAY, [GROUP])
        self.assertEqual([(w["place"], w["placeName"], w["band"]) for w in grid], [(RED, "Redding Solar Farm", "major")])
        # The next pass says nothing new.
        self.assertEqual(self._scan()["advisories"], 0)
        # The schedule: a shift at the jobsite carries its name and its own sky;
        # the yard's shift carries neither (the day's chip covers the team's site).
        self._as(BOSS)
        sched = {x["id"]: x for x in self.client.get("/timeclock/schedule", params={"start": DAY, "end": DAY}).json()["scheduled"]}
        ann, cal = sched[f"s-{ANN}"], sched[f"s-{CAL}"]
        self.assertEqual((ann["jobsiteName"], ann["jobsiteLocated"], ann["weatherBand"], ann["weatherChance"]), ("Redding Solar Farm", True, "major", 85))
        self.assertNotIn("weatherBand", cal)

    def test_a_jobsite_with_no_address_uses_the_team_site(self):
        self._shift(f"s-{ANN}").jobsite = BAR
        self.db.commit()
        self._scan()
        rows = self._outlooks()
        self.assertEqual(rows[f"{GROUP}:{DAY}"].people, 2, "Ann at Barstow counts with the yard")
        self.assertEqual(rows[f"{GROUP}:{DAY}:{RED}"].people, 1)

    def test_a_place_nobody_works_at_any_more_loses_its_band(self):
        self._scan()
        (self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id.in_([f"s-{ANN}", f"s-{BOB}"]))
         .update({"jobsite": ""}, synchronize_session=False))
        self.db.commit()
        self._scan()
        self.assertEqual(sorted(self._outlooks()), [f"{GROUP}:{DAY}"])

    # ── Weather Call one place at a time ──────────────────────────────────
    def test_the_call_is_one_place_at_a_time(self):
        self._scan()
        self._as(MGR)
        j = self.client.get(f"/weather-call/{GROUP}/{DAY}", params={"place": RED}).json()
        self.assertEqual([(p["key"], p["name"], p["people"], p["band"]) for p in j["places"]],
                         [(RED, "Redding Solar Farm", 2, "major"), ("", "Irvine Yard", 1, "quiet")], "the rain leads")
        self.assertEqual((j["place"], j["group"]["workSiteName"], j["outlook"]["band"]), (RED, "Redding Solar Farm", "major"))
        self.assertEqual([p["name"] for p in j["roster"]], ["Ann X", "Bob X"], "the yard is not on Redding's roster")
        # Cal works at the yard: never on Redding's call.
        r = self.client.post(f"/weather-call/{GROUP}/{DAY}", params={"place": RED},
                             json={"kind": "cancel", "emails": [ANN, CAL], "reason": "Storm"})
        self.assertEqual(r.status_code, 400)
        self.assertIn(CAL, r.json()["detail"])
        r = self.client.post(f"/weather-call/{GROUP}/{DAY}", params={"place": RED},
                             json={"kind": "cancel", "emails": [ANN, BOB], "reason": "Storm"})
        self.assertEqual(r.status_code, 200, r.text)
        red_call = r.json()
        self.assertEqual((red_call["place"], red_call["placeName"]), (RED, "Redding Solar Farm"))
        self.assertEqual([self._shift(f"s-{em}").weather_status for em in (ANN, BOB, CAL)], ["cancelled", "cancelled", ""])
        self.assertIn("at Redding Solar Farm", weather_call._send_sms.call_args[0][1])
        # The yard's own tab: Cal alone, no call yet; its call leaves Redding's standing.
        j = self.client.get(f"/weather-call/{GROUP}/{DAY}").json()
        self.assertEqual(([p["name"] for p in j["roster"]], j["decision"]), (["Cal X"], None))
        r = self.client.post(f"/weather-call/{GROUP}/{DAY}", json={"kind": "proceed", "emails": [], "reason": "Dry here"})
        self.assertEqual(r.status_code, 200, r.text)
        self.db.expire_all()
        red = self.db.query(models.WeatherDecision).filter(models.WeatherDecision.id == red_call["id"]).first()
        self.assertEqual(red.status, "active")
        self.assertEqual(self._shift(f"s-{ANN}").weather_status, "cancelled")
        # My Shifts names the place (it lists calls from yesterday on).
        red.work_date = datetime.now(timezone.utc).date().isoformat()
        self.db.commit()
        self._as(ANN)
        mine = self.client.get("/weather-call/mine").json()["calls"]
        self.assertEqual(mine[0]["groupName"], "Yard Crew at Redding Solar Farm")

    # ── the shift popup ───────────────────────────────────────────────────
    def test_a_shift_saves_its_jobsite_and_a_new_jobsite_is_a_project(self):
        self._as(BOSS)
        day = "2026-10-16"
        base = {"employee_email": CAL, "work_date": day, "start_hhmm": "07:00", "end_hhmm": "15:30", "group_id": GROUP}
        r = self.client.post("/timeclock/schedule", json={**base, "jobsite": "project-gone"})
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "Pick a jobsite from the list."))
        r = self.client.post("/timeclock/schedule", json={**base, "jobsite": RED})
        self.assertEqual(r.status_code, 200, r.text)
        sid = r.json()["id"]
        self.assertEqual(r.json()["jobsite"], RED)
        r = self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": CAL, "work_date": day, "jobsite": ""})
        self.assertEqual((r.status_code, r.json()["jobsite"]), (200, ""))
        r = self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": CAL, "work_date": day})
        self.assertEqual(r.json()["jobsite"], "", "an edit that leaves it out keeps it")

        def found(p):
            p.latitude, p.longitude = 36.74, -119.79
            return True
        with mock.patch.object(construction_weather, "geocode", side_effect=found):
            r = self.client.post("/timeclock/jobsites", json={"name": "Fresno Warehouse", "address": "1450 Oak St, Fresno, CA"})
        self.assertEqual(r.status_code, 201, r.text)
        new = r.json()
        self.assertEqual((new["name"], new["kind"], new["located"]), ("Fresno Warehouse", "project", True))
        p = self.db.query(models.ConstructionProject).filter(models.ConstructionProject.name == "Fresno Warehouse").first()
        self.assertEqual((p.manager_emails, p.status), ([BOSS], "active"))
        # The same address again is the same jobsite, never a second project.
        r = self.client.post("/timeclock/jobsites", json={"name": "Fresno WH", "address": " 1450 oak st, fresno, ca"})
        self.assertEqual(r.json()["id"], new["id"])
        r = self.client.post("/timeclock/jobsites", json={"name": "No Address", "address": ""})
        self.assertEqual(r.status_code, 400)
        sched = self.client.get("/timeclock/schedule", params={"start": DAY, "end": DAY}).json()
        self.assertIn(new["id"], [o["id"] for o in sched["jobsites"]])
        self.assertEqual({s["id"]: s["jobsite"] for s in sched["scheduled"]}[f"s-{ANN}"], RED)

    def test_the_evening_jobsite_notice_reaches_the_people_scheduled_there(self):
        red = self.db.query(models.ConstructionProject).filter(models.ConstructionProject.id == "red").first()
        self.assertEqual(construction_weather._scheduled(self.db, red, DAY), {ANN, BOB})
        self._shift(f"s-{BOB}").weather_status = "cancelled"
        self.db.commit()
        self.assertEqual(construction_weather._scheduled(self.db, red, DAY), {ANN}, "a canceled day is not work there")


if __name__ == "__main__":
    unittest.main()
