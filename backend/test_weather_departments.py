"""Weather by department (Neil, 10/29/2026): weather_scope.py and every place
weather touches people.

  * The startup default turns Weather Calls on for Construction departments
    only, runs once, and never turns back on a Construction an administrator
    switched off; a NEW department starts on only when it is named like
    construction.
  * A person is in scope by company + department name; a group is watched
    only with a member in scope (and its company on, alerts on, a site).
  * The advisory scan skips a group that is not watched, writes no outlook
    for it, clears the stale one, and counts only the crew's shifts.
  * The Weather Call roster lists only people in a weather department; a
    cancel call leaves everyone else's shift as it was and tells nobody else.
  * The call (and its screen) is refused for a group that is not watched;
    the schedule says so (no chip, no "set a work site" note).

    python -m pytest -q test_weather_departments.py
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
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import weather_call  # noqa: E402
import weather_scope  # noqa: E402
import weather_watch  # noqa: E402

BOSS = "wd.boss@greensglobal.com"     # administrator + the company's manager
CREW = "wd.crew@greensglobal.com"     # Construction - weather applies
CLERK = "wd.clerk@greensglobal.com"   # Accounting - weather never applies
LOOSE = "wd.loose@greensglobal.com"   # no department at all
ENT, OTHER_ENT = "ent-wd", "ent-wd-2"
YARD, OFFICE, SITE = "grp-wd-yard", "grp-wd-office", "site-wd"
# 10:00 AM Pacific on Tue 10/13/2026; the scan looks at Wed 10/14.
NOW = datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc)
SCAN_DAY = "2026-10-14"
CALL_DAY = (datetime.now(timezone.utc).date() + timedelta(days=3)).isoformat()


def forecast(day=SCAN_DAY):
    return {"timezone": "America/Los_Angeles",
            "hours": [{"time": f"{day}T{h:02d}:00", "chance": 90, "inches": 0.2, "code": 61} for h in range(24)]}


class WeatherDepartmentTests(unittest.TestCase):
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
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrWorkSite,
                  models.HrEntity, models.HrDepartment, models.ScheduledShift, models.NexusNotification,
                  models.ScheduleDayNote, models.WeatherOutlook, models.WeatherAdvisory, models.WeatherDecision,
                  models.NexusPersonPref, models.NexusSetting, models.ShiftRequest):
            self.db.query(m).delete()
        for em, first, dept in ((BOSS, "Boss", ""), (CREW, "Cruz", "Construction"), (CLERK, "Cleo", "Accounting"),
                                (LOOSE, "Lou", "")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="X", work_email=em,
                                             phone="(949) 555-0100", status="active", deleted_at="", company=ENT,
                                             department=dept))
        self.db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens Build", manager_email=BOSS, manager_emails=[BOSS]))
        self.db.add(models.HrEntity(id=OTHER_ENT, name="Greens Books"))
        # No weather given: the new-department hook decides by the name.
        self.db.add(models.HrDepartment(id="d-con", company_id=ENT, name="Construction"))
        self.db.add(models.HrDepartment(id="d-acct", company_id=ENT, name="Accounting"))
        self.db.add(models.HrWorkSite(id=SITE, name="Harbor View", latitude="33.12", longitude="-117.32"))
        for gid, name, members in ((YARD, "Yard Crew", (CREW, CLERK)), (OFFICE, "Front Office", (CLERK, LOOSE))):
            self.db.add(models.ShiftGroup(id=gid, name=name, work_site_id=SITE, weather_alerts=1,
                                          weather_decider_emails="[]", created_by=BOSS))
            for em in members:
                self.db.add(models.ShiftGroupMember(id=f"m-{gid}-{em}", group_id=gid, employee_email=em))
                for day in (SCAN_DAY, CALL_DAY):
                    self.db.add(models.ScheduledShift(id=f"s-{gid}-{em}-{day}", employee_email=em, work_date=day,
                                                      start_hhmm="07:00", end_hhmm="15:30", label="Harbor", published=1,
                                                      group_id=gid, created_by=BOSS))
        self.db.commit()
        weather_watch.save_config(self.db, {"companies": {ENT: True}}, BOSS)
        weather_watch._cache.clear()
        patches = [mock.patch.object(weather_watch, "fetch_forecast", return_value=forecast()),
                   mock.patch.object(weather_watch, "fetch_alerts", return_value=[]),
                   mock.patch.object(weather_watch, "_post_teams", return_value="ok"),
                   mock.patch.object(weather_watch, "_send_email", side_effect=lambda to, s, h: len(to)),
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

    def _group(self, gid):
        self.db.expire_all()
        return self.db.query(models.ShiftGroup).filter(models.ShiftGroup.id == gid).first()

    def _dept(self, did):
        self.db.expire_all()
        return self.db.query(models.HrDepartment).filter(models.HrDepartment.id == did).first()

    def _set_weather(self, did, on):
        self._dept(did).weather = 1 if on else 0
        self.db.commit()

    # ── the setting and its default ──────────────────────────────────────
    def test_the_startup_default_turns_on_construction_once(self):
        # As the rows stand right after the column is added: every one off.
        self.db.query(models.HrDepartment).delete()
        for did, name in (("s1", "Construction"), ("s2", "construction & maintenance"), ("s3", "Accounting"),
                          ("s4", "IT")):
            self.db.add(models.HrDepartment(id=did, company_id=ENT, name=name, weather=0))
        self.db.commit()
        self.assertEqual(weather_scope.seed_weather_departments(self.db), 2)
        self.assertEqual([self._dept(d).weather for d in ("s1", "s2", "s3", "s4")], [1, 1, 0, 0])
        # An administrator turns Construction off: a later boot leaves it off.
        self._set_weather("s1", False)
        self.assertIsNone(weather_scope.seed_weather_departments(self.db))
        self.assertEqual(self._dept("s1").weather, 0)
        self.assertEqual(self._dept("s2").weather, 1)

    def test_a_new_department_starts_on_only_when_named_construction(self):
        self.db.add(models.HrDepartment(id="n1", company_id=ENT, name="Construction - East"))
        self.db.add(models.HrDepartment(id="n2", company_id=ENT, name="Payroll"))
        self.db.commit()
        self.assertEqual((self._dept("n1").weather, self._dept("n2").weather), (1, 0))
        self.assertEqual((self._dept("d-con").weather, self._dept("d-acct").weather), (1, 0))
        # Through Settings > Companies > Departments: the same default, and the switch saves.
        r = self.client.post(f"/hr/entities/{ENT}/departments", json={"name": "Construction - West"})
        self.assertEqual(r.status_code, 201, r.text)
        by_name = {d["name"]: d for d in r.json()}
        self.assertTrue(by_name["Construction - West"]["weather"])
        self.assertFalse(by_name["Accounting"]["weather"])
        r = self.client.patch(f"/hr/entities/{ENT}/departments/d-acct", json={"weather": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue({d["id"]: d for d in r.json()}["d-acct"]["weather"])
        r = self.client.patch(f"/hr/entities/{ENT}/departments/d-con", json={"weather": False})
        self.assertFalse({d["id"]: d for d in r.json()}["d-con"]["weather"])
        r = self.client.patch(f"/hr/entities/{ENT}/departments/d-con", json={"name": "Construction Crew"})
        self.assertFalse({d["id"]: d for d in r.json()}["d-con"]["weather"], "a rename keeps the switch")

    # ── the rule ──────────────────────────────────────────────────────────
    def test_a_person_is_in_scope_by_company_and_department(self):
        self.assertTrue(weather_scope.person_in_weather_department(self.db, CREW))
        self.assertTrue(weather_scope.person_in_weather_department(self.db, CREW.upper()))
        self.assertFalse(weather_scope.person_in_weather_department(self.db, CLERK))
        self.assertFalse(weather_scope.person_in_weather_department(self.db, LOOSE), "no department = off")
        self.assertFalse(weather_scope.person_in_weather_department(self.db, "nobody@greensglobal.com"))
        self.assertEqual(weather_scope.weather_people(self.db, [CREW, CLERK, LOOSE]), {CREW})
        # The name is matched loosely, the company exactly.
        e = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == CLERK).first()
        e.department = "  construction "
        self.db.commit()
        self.assertTrue(weather_scope.person_in_weather_department(self.db, CLERK))
        e.company = OTHER_ENT   # a company with no Construction department of its own
        self.db.commit()
        self.assertFalse(weather_scope.person_in_weather_department(self.db, CLERK))

    def test_a_group_is_watched_only_with_a_member_in_a_weather_department(self):
        self.assertTrue(weather_scope.group_watched(self.db, self._group(YARD)))
        self.assertFalse(weather_scope.group_watched(self.db, self._group(OFFICE)))
        self.assertEqual(weather_scope.why_not_watched(self.db, self._group(OFFICE)), weather_scope.OFF_DEPARTMENTS)
        self._set_weather("d-con", False)
        self.assertFalse(weather_scope.group_watched(self.db, self._group(YARD)))
        self._set_weather("d-acct", True)
        self.assertTrue(weather_scope.group_watched(self.db, self._group(OFFICE)))
        # A member who left does not count.
        self._set_weather("d-acct", False)
        self._set_weather("d-con", True)
        crew = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == CREW).first()
        crew.status = "inactive"
        self.db.commit()
        self.assertFalse(weather_scope.group_watched(self.db, self._group(YARD)))

    # ── the advisory ──────────────────────────────────────────────────────
    def test_the_scan_skips_an_unwatched_group_and_clears_its_stale_outlook(self):
        self.db.add(models.WeatherOutlook(id=f"{OFFICE}:{SCAN_DAY}", group_id=OFFICE, work_date=SCAN_DAY, band="major",
                                          chance=90, inches=1.0, hourly_json="[]", shifts=2, people=2))
        self.db.commit()
        rows = weather_watch.outlook_rows(self.db, SCAN_DAY, SCAN_DAY)
        self.assertEqual([r["groupId"] for r in rows], [], "the grid shows no chip for it even before the scan")
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual((s["groups"], s["advisories"]), (1, 1), s)
        self.assertEqual(weather_watch.fetch_forecast.call_count, 1, "no forecast is fetched for the office")
        self.db.expire_all()
        self.assertIsNone(self.db.query(models.WeatherOutlook).filter(models.WeatherOutlook.group_id == OFFICE).first())
        o = self.db.query(models.WeatherOutlook).filter(models.WeatherOutlook.id == f"{YARD}:{SCAN_DAY}").first()
        self.assertEqual((o.band, o.shifts, o.people), ("major", 1, 1), "only the crew's shift counts")
        self.assertEqual([a.group_id for a in self.db.query(models.WeatherAdvisory).all()], [YARD])
        self.assertEqual([r["groupId"] for r in weather_watch.outlook_rows(self.db, SCAN_DAY, SCAN_DAY)], [YARD])
        # Construction turned off: the yard stops being watched and its chip goes.
        self._set_weather("d-con", False)
        self.assertEqual(weather_watch.outlook_rows(self.db, SCAN_DAY, SCAN_DAY), [])
        s = weather_watch.scan_once(self.db, NOW)
        self.assertEqual(s["groups"], 0)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.WeatherOutlook).count(), 0)
        self.assertEqual(self.db.query(models.WeatherAdvisory).count(), 1, "the record of what was sent stays")

    def test_the_schedule_shows_weather_only_for_watched_groups(self):
        weather_watch.scan_once(self.db, NOW)
        r = self.client.get("/timeclock/schedule", params={"start": SCAN_DAY, "end": SCAN_DAY})
        self.assertEqual(r.status_code, 200, r.text)
        groups = {g["id"]: g for g in r.json()["groups"]}
        self.assertTrue(groups[YARD]["weatherAlerts"])
        self.assertFalse(groups[OFFICE]["weatherAlerts"], "no weather setup note for an office team")
        self.assertEqual([w["groupId"] for w in r.json()["weather"]], [YARD])
        # The groups editor keeps the group's own switch as it is.
        r = self.client.get("/timeclock/shift-groups")
        self.assertTrue({g["id"]: g for g in r.json()["groups"]}[OFFICE]["weatherAlerts"])
        # The settings screen counts weather teams only, and names the departments.
        r = self.client.get("/weather-watch/settings")
        co = {c["id"]: c for c in r.json()["companies"]}[ENT]
        self.assertEqual((co["groupsReady"], co["groupsNotReady"], co["weatherDepartments"]), (["Yard Crew"], [], ["Construction"]))

    # ── the call ──────────────────────────────────────────────────────────
    def test_the_roster_is_the_weather_people_and_a_cancel_leaves_the_rest_alone(self):
        r = self.client.get(f"/weather-call/{YARD}/{CALL_DAY}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([p["email"] for p in r.json()["roster"]], [CREW])
        self.assertEqual(r.json()["weatherOff"], "")
        r = self.client.post(f"/weather-call/{YARD}/{CALL_DAY}", json={"kind": "cancel", "emails": [CREW, CLERK], "reason": "Flooded"})
        self.assertEqual(r.status_code, 400, "the clerk is not on the roster")
        self.assertIn(CLERK, r.json()["detail"])
        r = self.client.post(f"/weather-call/{YARD}/{CALL_DAY}", json={"kind": "cancel", "emails": [CREW], "reason": "Flooded"})
        self.assertEqual(r.status_code, 200, r.text)
        self.db.expire_all()
        crew = self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == f"s-{YARD}-{CREW}-{CALL_DAY}").first()
        clerk = self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == f"s-{YARD}-{CLERK}-{CALL_DAY}").first()
        self.assertEqual(crew.weather_status, "cancelled")
        self.assertEqual((clerk.weather_status or "", clerk.weather_decision_id or "", clerk.start_hhmm, clerk.end_hhmm,
                          clerk.label), ("", "", "07:00", "15:30", "Harbor"), "the clerk keeps the shift and the pay")
        d = self.db.query(models.WeatherDecision).first()
        self.assertEqual([p["email"] for p in json.loads(d.people_json)], [CREW])
        # The notices: the crew only, on every channel.
        bells = {n.recipient for n in self.db.query(models.NexusNotification).all() if n.ref_id == f"weather-call:{d.id}"}
        self.assertEqual(bells, {CREW})
        for sender in (weather_call._send_email, weather_call._teams_dm):
            self.assertEqual({c.args[0 if sender is weather_call._send_email else 2] for c in sender.call_args_list}, {CREW})
        self.assertEqual(weather_call._send_sms.call_count, 1)
        # Reminders go to the crew only too.
        self.assertEqual(weather_call.remind_silent(self.db, d), 1)

    def test_an_older_calls_follow_ups_skip_people_outside_weather_departments(self):
        d = models.WeatherDecision(id="old-call", group_id=YARD, work_date=CALL_DAY, company=ENT, kind="cancel", reason="Storm",
                                   sms=1, status="active", decided_by=BOSS, decided_at=datetime.now(timezone.utc).isoformat(),
                                   people_json=json.dumps([{"email": em, "name": em, "selected": True, "outcome": "cancelled",
                                                            "shifts": [], "phone": True, "smsOn": True, "ackAt": ""}
                                                           for em in (CREW, CLERK)]))
        self.db.add(d)
        self.db.commit()
        self.assertEqual(weather_call.remind_silent(self.db, d), 1)
        self.db.expire_all()
        self.assertEqual({n.recipient for n in self.db.query(models.NexusNotification).all()}, {CREW})

    def test_the_call_is_refused_for_a_group_that_is_not_watched(self):
        r = self.client.post(f"/weather-call/{OFFICE}/{CALL_DAY}", json={"kind": "cancel", "emails": [CLERK], "reason": "Rain"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["detail"], "Weather calls are off for this team's departments. "
                                             "Turn them on in Settings > Companies > Departments.")
        self.assertEqual(self.client.get(f"/weather-call/{OFFICE}/{CALL_DAY}").status_code, 403)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.WeatherDecision).count(), 0)
        clerk = self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == f"s-{OFFICE}-{CLERK}-{CALL_DAY}").first()
        self.assertEqual(clerk.weather_status or "", "")
        # A call made before the department was switched off still opens (to
        # read or reinstate) - history is never rewritten - but takes no new call.
        r = self.client.post(f"/weather-call/{YARD}/{CALL_DAY}", json={"kind": "cancel", "emails": [CREW], "reason": "Flooded"})
        self.assertEqual(r.status_code, 200, r.text)
        self._set_weather("d-con", False)
        r = self.client.get(f"/weather-call/{YARD}/{CALL_DAY}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["weatherOff"], weather_scope.OFF_DEPARTMENTS)
        self.assertEqual(r.json()["decision"]["kind"], "cancel")
        r = self.client.post(f"/weather-call/{YARD}/{CALL_DAY}", json={"kind": "proceed", "emails": [], "reason": "Cleared"})
        self.assertEqual(r.status_code, 403)
        self.db.expire_all()
        r = self.client.post(f"/weather-call/{self.db.query(models.WeatherDecision).first().id}/reinstate")
        self.assertEqual(r.status_code, 200, r.text)
        self.db.expire_all()
        crew = self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == f"s-{YARD}-{CREW}-{CALL_DAY}").first()
        self.assertEqual(crew.weather_status or "", "", "reinstated")


if __name__ == "__main__":
    unittest.main()
