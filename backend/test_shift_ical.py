"""
Shifts Phase 3a - the personal calendar subscribe feed (routers/shift_ical.py).

Run with: python -m unittest test_shift_ical -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth           # noqa: E402
import database       # noqa: E402
import main           # noqa: E402
import models         # noqa: E402
from routers import shift_ical   # noqa: E402

AMY, BOB = "ical.amy@greensglobal.com", "ical.bob@greensglobal.com"
TODAY = datetime.now(timezone.utc).date()
SOON = (TODAY + timedelta(days=3)).isoformat()
OLD = (TODAY - timedelta(days=10)).isoformat()
TOO_OLD = (TODAY - timedelta(days=40)).isoformat()
TOO_FAR = (TODAY + timedelta(days=130)).isoformat()


def _utc(day: str, h: int, m: int) -> str:
    """A Pacific wall-clock time as the feed's UTC stamp (DST-aware)."""
    from zoneinfo import ZoneInfo
    local = datetime.strptime(day, "%Y-%m-%d").replace(hour=h, minute=m, tzinfo=ZoneInfo("America/Los_Angeles"))
    return local.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class IcalTests(unittest.TestCase):
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
        for m in (models.NexusEmployee, models.NexusPersonPref, models.ScheduledShift, models.Shift, models.ShiftGroup,
                  models.HrWorkSite, models.NexusSetting):
            self.db.query(m).delete()
        for em, first in ((AMY, "Amy"), (BOB, "Bob")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             status="active", deleted_at=""))
        self.db.add(models.Shift(id="gsv", code="GSV", name="Store", timezone="America/Los_Angeles"))
        self.db.add(models.HrWorkSite(id="site-1", name="Harbor View"))
        self.db.add(models.ShiftGroup(id="grp-1", name="Yard Crew", work_site_id="site-1"))
        rows = [
            ("mine-soon", AMY, SOON, "07:00", "15:30", "", 1, ""),
            ("mine-old", AMY, OLD, "22:00", "04:00", "Night", 1, ""),
            ("mine-cancelled", AMY, SOON, "16:00", "20:00", "Evening", 1, "cancelled"),
            ("mine-draft", AMY, SOON, "08:00", "12:00", "Draft", 0, ""),
            ("mine-too-old", AMY, TOO_OLD, "07:00", "15:30", "", 1, ""),
            ("mine-too-far", AMY, TOO_FAR, "07:00", "15:30", "", 1, ""),
            ("bobs", BOB, SOON, "07:00", "15:30", "Bob's", 1, ""),
        ]
        for sid, em, day, s, e, label, pub, ws in rows:
            self.db.add(models.ScheduledShift(id=sid, employee_email=em, work_date=day, shift_id="gsv", start_hhmm=s,
                                              end_hhmm=e, label=label, published=pub, group_id="grp-1",
                                              weather_status=ws, note="pay $20/h - never shown"))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if "NEXUS_DEV_EMAIL" in os.environ:
            del os.environ["NEXUS_DEV_EMAIL"]

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _link(self):
        r = self.client.get("/timeclock/my-schedule/ical-link")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_the_link_is_signed_stable_and_names_the_calendar(self):
        self._as(AMY)
        link = self._link()
        self.assertTrue(link["url"].endswith(".ics"))
        self.assertIn("/timeclock/ical/", link["url"])
        self.assertTrue(link["webcal"].startswith("webcal://"))
        self.assertEqual(link["name"], "Nexus Shifts")
        self.assertEqual(self._link()["url"], link["url"])      # the same link until rotated
        token = link["url"].rsplit("/", 1)[1][:-4]
        data = shift_ical.parse_token(token)
        self.assertEqual(data["email"], AMY)
        self.assertIsNone(shift_ical.parse_token(token[:-2] + "zz"))   # a tampered signature
        self.assertIsNone(shift_ical.parse_token("nope"))

    def test_the_feed_needs_no_login_and_carries_only_my_shared_shifts(self):
        self._as(AMY)
        url = self._link()["url"]
        path = url[url.index("/timeclock/"):]
        auth.SKIP_AUTH = False          # nobody is signed in now
        del os.environ["NEXUS_DEV_EMAIL"]
        r = self.client.get(path)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.headers["content-type"].startswith("text/calendar"))
        body = r.text
        self.assertIn("X-WR-CALNAME:Nexus Shifts", body)
        self.assertIn("BEGIN:VCALENDAR", body)
        self.assertIn("UID:mine-soon", body)
        self.assertIn("UID:mine-old", body)
        self.assertIn("UID:mine-cancelled", body)
        for absent in ("mine-draft", "mine-too-old", "mine-too-far", "bobs", "Bob's", "pay", "$20"):
            self.assertNotIn(absent, body)
        self.assertEqual(body.count("BEGIN:VEVENT"), 3)
        self.assertIn("SUMMARY:Shift · 7:00 AM - 3:30 PM · GSV", body)
        self.assertIn("DESCRIPTION:Team: Yard Crew\\nSite: Harbor View", body)
        # Weather-cancelled shifts stay on the calendar as CANCELLED.
        cancelled = body[body.index("UID:mine-cancelled"):]
        cancelled = cancelled[:cancelled.index("END:VEVENT")]
        self.assertIn("STATUS:CANCELLED", cancelled)
        self.assertIn("Cancelled by a weather call", cancelled)
        # Free by default -> transparent; UTC stamps, no VTIMEZONE.
        self.assertIn("TRANSP:TRANSPARENT", body)
        self.assertNotIn("VTIMEZONE", body)
        self.assertIn(f"DTSTART:{_utc(SOON, 7, 0)}", body)   # 7:00 AM Pacific, in UTC
        # An overnight shift ends the next day.
        nxt = (datetime.strptime(OLD, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        night = body[body.index("UID:mine-old"):]
        self.assertIn(f"DTEND:{_utc(nxt, 4, 0)}", night)
        self.assertTrue(body.endswith("END:VCALENDAR\r\n"))

    def test_rotate_invalidates_the_old_link(self):
        self._as(AMY)
        old = self._link()["url"]
        new = self.client.post("/timeclock/my-schedule/ical-link/rotate").json()["url"]
        self.assertNotEqual(old, new)
        self.assertEqual(self._link()["url"], new)
        old_path, new_path = old[old.index("/timeclock/"):], new[new.index("/timeclock/"):]
        auth.SKIP_AUTH = False
        self.assertEqual(self.client.get(old_path).status_code, 404)
        self.assertEqual(self.client.get(new_path).status_code, 200)

    def test_a_forged_or_unknown_token_is_a_plain_404(self):
        auth.SKIP_AUTH = False
        self.assertEqual(self.client.get("/timeclock/ical/not-a-token.ics").status_code, 404)
        # A well-signed token for someone who never asked for a link.
        token = shift_ical.make_token(BOB, "salt-they-never-had")
        self.assertEqual(self.client.get(f"/timeclock/ical/{token}.ics").status_code, 404)

    def test_busy_setting_makes_events_opaque(self):
        import json
        self.db.add(models.NexusSetting(key="shift_requests_config", value=json.dumps({"outlookShowAs": "busy"})))
        self.db.commit()
        body = shift_ical.build_feed(self.db, AMY)
        self.assertIn("TRANSP:OPAQUE", body)
        self.assertNotIn("TRANSP:TRANSPARENT", body)

    def test_long_lines_are_folded(self):
        self.db.add(models.ScheduledShift(id="longlabel", employee_email=AMY, work_date=SOON, start_hhmm="07:00",
                                          end_hhmm="15:30", label="A" * 120, published=1))
        self.db.commit()
        body = shift_ical.build_feed(self.db, AMY)
        for line in body.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75, line)
        unfolded = body.replace("\r\n ", "")
        self.assertIn("A" * 120, unfolded)


if __name__ == "__main__":
    unittest.main()
