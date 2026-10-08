"""
Neil, 10/08 - Workforce Analytics fixes:
  * Monitoring Alerts never lists someone exempt from monitoring, and a quiet
    desktop agent is not an alert while the in-browser share is capturing.
  * The Locations map shows everyone who punches with a location, not only
    people whose HR status is "active" (an external staffer still onboarding
    had clocked in and was missing).
  * The out-of-fence email links to the punch in Nexus, not Google Maps.

Uses a throwaway sqlite file.

    python -m unittest test_oct8_monitoring_locations
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import models  # noqa: E402
from routers import timeclock  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

ADMIN = {"email": "admin@greensglobal.com", "level": 4}
ARNAV, VALINDA, VICKI, SOPHIA = ("arnav@greensglobal.com", "valinda@greensstorage.com",
                                 "vicki@greensstorage.com", "sophia@gmail.com")


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class Oct8Tests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TimePunch, models.TimeScreenshot, models.AgentDevice, models.NexusEmployee,
                  models.NexusGroup, models.NexusGroupMember, models.MonitoringPolicy):
            self.db.query(m).delete()
        self.now = datetime.now(timezone.utc)
        for i, (em, first, status) in enumerate([(ARNAV, "Arnav", "active"), (VALINDA, "Valinda", "active"),
                                                 (VICKI, "Vicki", "active"), (SOPHIA, "Sophia", "onboarding")]):
            self.db.add(models.NexusEmployee(id=f"e{i}", first_name=first, last_name="T", work_email=em,
                                             status=status, identity_type="external" if em == SOPHIA else "internal"))
        self.db.add(models.NexusGroup(id="lead", name="Leadership", monitoring_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="lead", email=VALINDA))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _in(self, em, minutes_ago, lat="", lng=""):
        at = _iso(self.now - timedelta(minutes=minutes_ago))
        self.db.add(models.TimePunch(id=f"p-{em}-{minutes_ago}", employee_email=em, kind="in", at=at,
                                     local_date=at[:10], tz_offset_min=0, created_at=at, lat=lat, lng=lng))

    def test_exempt_people_never_alert_and_a_web_share_covers_a_quiet_agent(self):
        for em in (ARNAV, VALINDA, VICKI):
            self._in(em, 120)
        # Arnav: an enrolled agent that went quiet a day ago, but frames are
        # arriving from the browser share right now.
        self.db.add(models.AgentDevice(id="d1", employee_email=ARNAV, revoked=0,
                                       last_seen_at=_iso(self.now - timedelta(minutes=1637))))
        self.db.add(models.TimeScreenshot(id="s1", employee_email=ARNAV, at=_iso(self.now - timedelta(minutes=2)),
                                          active_view="/tasks"))
        self.db.commit()
        out = timeclock.monitoring_alerts(user=ADMIN, db=self.db)
        by = {a["email"]: a for a in out["alerts"]}
        self.assertNotIn(VALINDA, by)                       # exempt: never "not captured"
        self.assertNotIn(ARNAV, by)                         # covered by the browser share
        self.assertEqual(by[VICKI]["reason"], "No agent reporting")
        # Take the frames away and Arnav IS a gap - said in hours, not 1637 minutes.
        self.db.query(models.TimeScreenshot).delete()
        self.db.commit()
        by = {a["email"]: a for a in timeclock.monitoring_alerts(user=ADMIN, db=self.db)["alerts"]}
        self.assertEqual(by[ARNAV]["reason"], "Agent stopped reporting")
        self.assertIn("1 day 3 hr ago", by[ARNAV]["detail"])

    def test_ago_words(self):
        self.assertEqual(timeclock._ago_words(5 * 60), "5 min ago")
        self.assertEqual(timeclock._ago_words(90 * 60), "1 hr 30 min ago")
        self.assertEqual(timeclock._ago_words(2 * 3600), "2 hr ago")
        self.assertEqual(timeclock._ago_words(49 * 3600), "2 days 1 hr ago")

    def test_locations_show_everyone_who_punched_with_a_location(self):
        self._in(SOPHIA, 30, lat="33.72", lng="-117.98")     # external, still "onboarding" in People
        self._in(VICKI, 30, lat="33.70", lng="-117.90")
        self._in(ARNAV, 30)                                 # no coordinates: nothing to pin
        self.db.commit()
        people = {p["email"]: p for p in timeclock.team_locations(user=ADMIN, db=self.db)["people"]}
        self.assertEqual(set(people), {SOPHIA, VICKI})
        self.assertEqual((people[SOPHIA]["name"], people[SOPHIA]["clockedIn"]), ("Sophia T", True))
        # Someone who has left stays off the map even with an old located punch.
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == VICKI).update({"status": "offboarded"})
        self.db.commit()
        self.assertEqual([p["email"] for p in timeclock.team_locations(user=ADMIN, db=self.db)["people"]], [SOPHIA])

    def test_out_of_fence_email_links_to_the_punch_in_nexus(self):
        url = timeclock._timecard_url(self.db, VALINDA, "2026-10-07")
        self.assertRegex(url, r"^https?://")                # app_url(): localhost here, the real site on Azure
        self.assertIn("/hr/hr-time?timecard=valinda%40greensstorage.com&start=", url)
        self.assertNotIn("google", url)


if __name__ == "__main__":
    unittest.main()
