"""
Weather watch (Weather Call, Phase 1 - Oct 10 2026): weather_watch.py.

  - Banding from the scheduled hours only: Major needs a high chance AND
    real rain, or a lot of rain at any chance, or a thunderstorm; Heads-up
    is lighter; an NWS warning is its own band.
  - The advisory goes once per group, day and band: a priority bell to the
    deciders and the company's managers, email to the deciders, a Teams
    post, the weather line as the day note. It waits through quiet hours
    (a warning does not), never repeats, says when a day eases, and leaves
    a person's own day note alone.
  - A heads-up is one quiet Teams line, no bell. A company that is not
    switched on is not watched at all.

Providers and senders are stood in; the clock is passed in. Throwaway
sqlite. Run with: python -m unittest test_weather_watch -v
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth           # noqa: E402
import cache          # noqa: E402
import database       # noqa: E402
import main           # noqa: E402
import models         # noqa: E402
import weather_watch  # noqa: E402

BOSS = "ww.boss@greensglobal.com"    # administrator + company manager
MGR = "ww.mgr@greensglobal.com"      # the group's weather decider
EMP = "ww.emp@greensglobal.com"      # on the crew
ENT, GROUP, SITE = "ent-ww", "grp-ww", "site-ww"
# 10:00 AM Pacific on Tue 10/13/2026; the crew works Wed 10/14 7:00 AM - 3:30 PM.
NOW = datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc)
NIGHT = datetime(2026, 10, 14, 6, 0, tzinfo=timezone.utc)   # 11:00 PM Pacific on 10/13
DAY = "2026-10-14"


def forecast(chance=85, inches_per_hour=0.1, code=61, day=DAY):
    hours = [{"time": f"{day}T{h:02d}:00", "chance": chance, "inches": inches_per_hour, "code": code} for h in range(24)]
    # Hours outside the shift are soaked on purpose: they must not count.
    for h in hours:
        if h["time"][11:13] in ("02", "22"):
            h["chance"], h["inches"] = 100, 2.0
    return {"timezone": "America/Los_Angeles", "hours": hours}


class WatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrWorkSite,
                  models.HrEntity, models.ScheduledShift, models.NexusNotification, models.ScheduleDayNote,
                  models.WeatherOutlook, models.WeatherAdvisory, models.NexusSetting, models.HrDepartment):
            self.db.query(m).delete()
        for em, first in ((BOSS, "Boss"), (MGR, "Mia"), (EMP, "Eve")):
            # The crew is in Construction: the watch covers weather departments only (10/29/2026).
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="X", work_email=em,
                                             status="active", deleted_at="", company=ENT,
                                             department="Construction" if em == EMP else ""))
        self.db.add(models.HrDepartment(id="d-ww-con", company_id=ENT, name="Construction"))   # starts on
        self.db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", manager_email=BOSS, manager_emails=[BOSS]))
        self.db.add(models.HrWorkSite(id=SITE, name="Harbor View", latitude="33.12", longitude="-117.32"))
        self.db.add(models.ShiftGroup(id=GROUP, name="Yard Crew", work_site_id=SITE, weather_alerts=1,
                                      weather_decider_emails=json.dumps([MGR]), teams_chat_id="chat-1", created_by=BOSS))
        self.db.add(models.ShiftGroupMember(id="m1", group_id=GROUP, employee_email=EMP))
        self.db.add(models.ScheduledShift(id="s1", employee_email=EMP, work_date=DAY, start_hhmm="07:00", end_hhmm="15:30",
                                          published=1, group_id=GROUP, created_by=BOSS))
        self.db.commit()
        weather_watch.save_config(self.db, {"companies": {ENT: True}}, BOSS)
        weather_watch._cache.clear()
        self.teams = mock.patch.object(weather_watch, "_post_teams", return_value="ok")
        self.mail = mock.patch.object(weather_watch, "_send_email", side_effect=lambda to, s, h: len(to))
        self.alerts = mock.patch.object(weather_watch, "fetch_alerts", return_value=[])
        self.fc = mock.patch.object(weather_watch, "fetch_forecast", return_value=forecast())
        for p in (self.teams, self.mail, self.alerts, self.fc):
            p.start()
            self.addCleanup(p.stop)
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _bells(self, em):
        self.db.expire_all()
        return self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == em).all()

    def _note(self):
        self.db.expire_all()
        r = self.db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.work_date == DAY,
                                                          models.ScheduleDayNote.group_id == GROUP).first()
        return r.note if r else ""

    def _outlook(self):
        self.db.expire_all()
        return self.db.query(models.WeatherOutlook).filter(models.WeatherOutlook.id == f"{GROUP}:{DAY}").first()

    # ── banding ─────────────────────────────────────────────────────────
    def test_bands_from_the_scheduled_hours(self):
        cfg = weather_watch.get_config(self.db)
        hrs = weather_watch.hours_in_window(forecast(), DAY, 7 * 60, 15 * 60 + 30)
        self.assertEqual([h["time"][11:13] for h in hrs], [f"{h:02d}" for h in range(7, 16)])   # 7 AM through the 3 PM hour
        o = weather_watch.band_for(hrs, cfg)
        self.assertEqual((o["band"], o["chance"], o["inches"]), ("major", 85, 0.9))
        # A high chance with a drizzle is a heads-up, not major...
        o = weather_watch.band_for(weather_watch.hours_in_window(forecast(85, 0.02), DAY, 420, 930), cfg)
        self.assertEqual(o["band"], "heads_up")
        # ...a downpour at a low chance is major anyway...
        o = weather_watch.band_for(weather_watch.hours_in_window(forecast(30, 0.2), DAY, 420, 930), cfg)
        self.assertEqual((o["band"], o["inches"]), ("major", 1.8))
        # ...a thunderstorm hour at the storm chance is major...
        o = weather_watch.band_for(weather_watch.hours_in_window(forecast(55, 0.01, code=95), DAY, 420, 930), cfg)
        self.assertEqual((o["band"], o["storm"]), ("major", True))
        # ...a dry day is quiet, and a warning is its own band.
        o = weather_watch.band_for(weather_watch.hours_in_window(forecast(10, 0), DAY, 420, 930), cfg)
        self.assertEqual(o["band"], "quiet")
        o = weather_watch.band_for([], cfg, [{"event": "Flash Flood Warning", "onset": f"{DAY}T01:00", "ends": ""}], DAY)
        self.assertEqual((o["band"], o["alerts"]), ("warning", ["Flash Flood Warning"]))
        o = weather_watch.band_for([], cfg, [{"event": "Flood Watch", "onset": "", "ends": ""},
                                             {"event": "High Wind Warning", "onset": "", "ends": "2026-10-13T20:00"}], DAY)
        self.assertEqual(o["band"], "quiet", "a watch is not a warning; an expired warning does not count")

    def test_an_overnight_shift_stretches_the_window_to_midnight(self):
        row = self.db.query(models.ScheduledShift).first()
        row.start_hhmm, row.end_hhmm = "20:00", "04:00"
        self.db.commit()
        self.assertEqual(weather_watch.scheduled_window([row]), (20 * 60, 24 * 60))

    # ── the advisory ────────────────────────────────────────────────────
    def test_major_rain_advises_once_then_eases(self):
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual((s["groups"], s["days"], s["advisories"]), (1, 1, 1), s)
        for em in (MGR, BOSS):   # the decider and the company's manager
            bells = self._bells(em)
            self.assertEqual(len(bells), 1, em)
            self.assertEqual(bells[0].priority, 1)
            self.assertEqual(bells[0].ref_id, f"weather:{GROUP}:{DAY}")
            self.assertIn("Rain Expected for Yard Crew on Wed 10/14", bells[0].title)
            self.assertIn("85% chance, 0.90 in expected during 7:00 AM - 3:30 PM", bells[0].body)
            self.assertEqual(json.loads(bells[0].action), {"view": "shifts", "sub": f"schedule:{DAY}:{GROUP}"})
            self.assertEqual(bells[0].company, ENT)
        self.assertEqual(self._bells(EMP), [], "the crew is not told by an advisory - a forecast is not a decision")
        self.assertTrue(self._note().startswith("Weather: Major rain: 85% chance"))
        self.assertIn("Weather call pending", self._note())
        o = self._outlook()
        self.assertEqual((o.band, o.chance, o.inches, o.shifts, o.people, o.window_start, o.window_end),
                         ("major", 85, 0.9, 1, 1, "7:00 AM", "3:30 PM"))
        adv = self.db.query(models.WeatherAdvisory).all()
        self.assertEqual(len(adv), 1)
        self.assertEqual(json.loads(adv[0].channels_json), {"bell": 2, "dayNote": True, "teams": "ok", "email": 1})
        self.assertEqual(json.loads(adv[0].recipients_json), [MGR, BOSS])
        weather_watch._send_email.assert_called_once()
        self.assertEqual(weather_watch._send_email.call_args[0][0], [MGR])   # email to the deciders only
        # The same forecast half an hour later: nothing new.
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual(s["advisories"], 0)
        self.assertEqual(len(self._bells(MGR)), 1)
        self.assertEqual(self.db.query(models.WeatherAdvisory).count(), 1)
        # It eases: not announced until the advisory is an hour old (a
        # forecast hovering at the line must not page people every tick)...
        weather_watch.fetch_forecast.return_value = forecast(20, 0.0)
        s = weather_watch.scan_once(self.db, NOW + timedelta(minutes=30))
        self.assertEqual((s["eased"], s["held"]), (0, 1))
        self.assertEqual(self._outlook().band, "quiet", "the grid follows at once")
        # ...then one quiet bell, and the note says so.
        s = weather_watch.scan_once(self.db, NOW + timedelta(minutes=61))
        self.assertEqual(s["eased"], 1)
        eased = [b for b in self._bells(MGR) if b.ref_id.startswith("weather-eased:")]
        self.assertEqual(len(eased), 1)
        self.assertEqual(eased[0].priority, 0)
        self.assertTrue(self._note().startswith("Weather: forecast eased."))
        # Back to major within three hours of easing: held, not re-sent...
        weather_watch.fetch_forecast.return_value = forecast()
        s = weather_watch.scan_once(self.db, NOW + timedelta(minutes=90))
        self.assertEqual((s["advisories"], s["held"]), (0, 1))
        # ...after that, told again.
        s = weather_watch.scan_once(self.db, NOW + timedelta(minutes=61 + 181))
        self.assertEqual(s["advisories"], 1)

    def test_advisories_wait_through_quiet_hours_but_warnings_do_not(self):
        s = weather_watch.scan_once(self.db, NIGHT)
        self.assertEqual((s["held"], s["advisories"]), (1, 0))
        self.assertEqual(self._bells(MGR), [])
        self.assertEqual(self._outlook().band, "major", "the grid still shows it")
        weather_watch.fetch_alerts.return_value = [{"event": "Severe Thunderstorm Warning", "onset": f"{DAY}T02:00", "ends": ""}]
        s = weather_watch.scan_once(self.db, NIGHT)
        self.assertEqual(s["advisories"], 1)
        self.assertIn("Weather Warning for Yard Crew", self._bells(MGR)[0].title)
        self.assertIn("Severe Thunderstorm Warning in force", self._bells(MGR)[0].body)
        # Morning comes: the warning was already sent, nothing doubles.
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual(s["advisories"], 0)
        # The warning lapses while the rain stays: still Major, not news again.
        weather_watch.fetch_alerts.return_value = []
        s = weather_watch.scan_once(self.db, NOW + timedelta(hours=2))
        self.assertEqual((s["advisories"], self._outlook().band), (0, "major"))
        self.assertEqual(len([b for b in self._bells(MGR) if b.ref_id.startswith("weather:")]), 1)

    def test_a_heads_up_is_one_quiet_teams_line(self):
        weather_watch.fetch_forecast.return_value = forecast(50, 0.02)
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual((s["headsUp"], s["advisories"]), (1, 0))
        self.assertEqual(self._bells(MGR), [])
        self.assertEqual(self._note(), "", "no day note for a heads-up")
        weather_watch._post_teams.assert_called_once()
        self.assertIn("Heads-up for Yard Crew", weather_watch._post_teams.call_args[0][2])
        self.assertEqual(self._outlook().band, "heads_up")
        weather_watch.scan_once(self.db, NOW)
        self.assertEqual(weather_watch._post_teams.call_count, 1, "once per group-day")
        # With the setting off there is no line at all, just the icon.
        self.db.query(models.WeatherAdvisory).delete()
        self.db.commit()
        weather_watch.save_config(self.db, {"headsUpTeams": False}, BOSS)
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual((s["headsUp"], weather_watch._post_teams.call_count), (0, 1))

    def test_a_persons_own_day_note_is_left_alone(self):
        self.db.add(models.ScheduleDayNote(id="n1", work_date=DAY, group_id=GROUP, note="Inventory day - all hands"))
        self.db.commit()
        weather_watch.scan_once(self.db, NOW)
        self.assertEqual(self._note(), "Inventory day - all hands")
        self.assertEqual(json.loads(self.db.query(models.WeatherAdvisory).first().channels_json)["dayNote"], False)
        self.assertEqual(len(self._bells(MGR)), 1, "the bell still goes")

    def test_only_switched_on_companies_are_watched(self):
        weather_watch.save_config(self.db, {"companies": {ENT: False}}, BOSS)
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual(s["groups"], 0)
        self.assertEqual(self._bells(MGR), [])
        weather_watch.fetch_forecast.assert_not_called()

    def test_a_group_without_a_located_site_or_with_alerts_off_is_skipped(self):
        g = self.db.query(models.ShiftGroup).first()
        g.weather_alerts = 0
        self.db.commit()
        self.assertEqual(weather_watch.scan_once(self.db, NOW)["groups"], 0)
        g.weather_alerts, g.work_site_id = 1, ""
        self.db.commit()
        self.assertEqual(weather_watch.scan_once(self.db, NOW)["groups"], 0)

    def test_no_deciders_means_schedulers_then_company_managers(self):
        g = self.db.query(models.ShiftGroup).first()
        g.weather_decider_emails, g.scheduler_emails = "", json.dumps([MGR])
        self.db.commit()
        weather_watch.scan_once(self.db, NOW)
        self.assertEqual(len(self._bells(MGR)), 1)
        self.assertEqual(len(self._bells(BOSS)), 1)

    def test_a_decider_who_lost_manage_access_is_skipped(self):
        # MGR is the named decider; demoted, the advisory goes to the
        # schedulers then the company's managers instead (Oct 12).
        self.db.query(models.NexusRole).filter(models.NexusRole.email == MGR).delete()
        self.db.commit()
        auth.invalidate_role_cache()
        g = self.db.query(models.ShiftGroup).first()
        deciders, told = weather_watch.deciders_for(self.db, g, ENT)
        self.assertEqual((deciders, told), ([], [BOSS]))
        weather_watch.scan_once(self.db, NOW)
        self.assertEqual(self._bells(MGR), [])
        self.assertEqual(len(self._bells(BOSS)), 1)

    def test_the_record_is_written_before_anything_is_sent(self):
        # The dedupe is atomic (Oct 12): the advisory row is committed, under
        # the group-day lock, BEFORE the Teams post and the email - so a
        # concurrent scan reads it and sends nothing.
        seen = []

        def teams(db, g, html, as_emails):
            other = database.SessionLocal()   # another connection: what a second scan would read
            try:
                seen.append([a.band for a in other.query(models.WeatherAdvisory).all()])
            finally:
                other.close()
            return "ok"
        with mock.patch.object(weather_watch, "_post_teams", side_effect=teams):
            weather_watch.scan_once(self.db, NOW)
        self.assertEqual(seen, [["major"]])
        # A second pass (Check Now right after) sends nothing more.
        s = weather_watch.scan_once(self.db, NOW + timedelta(minutes=1))
        self.assertEqual(s["advisories"], 0)
        self.assertEqual(weather_watch._send_email.call_count, 1)
        adv = self.db.query(models.WeatherAdvisory).all()
        self.assertEqual(len(adv), 1)
        self.assertEqual(json.loads(adv[0].channels_json)["teams"], "ok")

    def test_a_provider_outage_is_quiet(self):
        weather_watch.fetch_forecast.return_value = None
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual((s["providerDown"], s["advisories"]), (1, 0))

    # ── the API ─────────────────────────────────────────────────────────
    def test_settings_and_the_schedule_payload(self):
        client = TestClient(main.app)
        skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        os.environ["NEXUS_DEV_EMAIL"] = BOSS
        try:
            r = client.get("/weather-watch/settings")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["config"]["majorChance"], 70)
            co = {c["id"]: c for c in r.json()["companies"]}[ENT]
            self.assertEqual((co["enabled"], co["groupsReady"]), (True, ["Yard Crew"]))
            r = client.put("/weather-watch/settings", json={"headsUpChance": 80})
            self.assertEqual(r.status_code, 400)
            self.assertIn("heads-up chance", r.json()["detail"])
            r = client.put("/weather-watch/settings", json={"majorChance": 60, "quietStart": "22:00", "companies": {ENT: False}})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual((r.json()["config"]["majorChance"], r.json()["config"]["quietStart"]), (60, "22:00"))
            self.assertFalse({c["id"]: c for c in r.json()["companies"]}[ENT]["enabled"])
            r = client.put("/weather-watch/settings", json={"quietEnd": "5 AM"})
            self.assertEqual(r.status_code, 400)
            # Check Now runs the scan on the real clock: the shift moves to
            # tomorrow (site time) and quiet hours are switched off for it.
            from zoneinfo import ZoneInfo
            from datetime import timedelta
            tomorrow = (datetime.now(ZoneInfo("America/Los_Angeles")).date() + timedelta(days=1)).isoformat()
            row = self.db.query(models.ScheduledShift).first()
            row.work_date = tomorrow
            self.db.commit()
            weather_watch.fetch_forecast.return_value = forecast(day=tomorrow)
            client.put("/weather-watch/settings", json={"companies": {ENT: True}, "quietStart": "00:00", "quietEnd": "00:00"})
            r = client.post("/weather-watch/scan")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["advisories"], 1, r.text)
            r = client.get("/timeclock/schedule", params={"start": tomorrow, "end": tomorrow})
            self.assertEqual(r.status_code, 200, r.text)
            w = r.json()["weather"]
            self.assertEqual(len(w), 1)
            self.assertEqual((w[0]["groupId"], w[0]["date"], w[0]["band"], w[0]["chance"], w[0]["windowStart"]),
                             (GROUP, tomorrow, "major", 85, "7:00 AM"))
            r = client.get("/weather-watch/advisories")
            self.assertEqual(r.json()["advisories"][0]["groupName"], "Yard Crew")
            self.assertEqual(r.json()["advisories"][0]["channels"]["teams"], "ok")
        finally:
            auth.SKIP_AUTH = skip
            auth.invalidate_role_cache()


if __name__ == "__main__":
    unittest.main()
