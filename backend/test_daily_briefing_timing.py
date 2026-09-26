"""
Daily Briefing timing (Sep 27): editable before-shift lead, and a default
send time for people with no shift today.

  - A no-shift person gets exactly one briefing at the default time when
    `includeNoShift` is on, and none when it is off.
  - The default time is read in the person's own zone (their Shift preset's
    timezone), else `defaultTimeZone`.
  - A person with a shift today is handled only by the shift path: no second
    send, and no early no-shift send on a day they work.
  - `leadMinutes` moves the shift trigger.
  - The per-day dedupe still holds, and test mode still only mails the test
    recipients.
  - PUT /daily-briefing/config validates the new keys.

The clock is frozen at Monday 09/28/2026 14:10 UTC (7:10 AM Pacific, 7:40 PM
India). Uses a throwaway sqlite file; graph_mail.send_mail is mocked.

Run with: python -m unittest test_daily_briefing_timing -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock
from zoneinfo import ZoneInfo

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "admin@greensglobal.com"

from fastapi import FastAPI                              # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import daily_briefing                                    # noqa: E402
import database                                          # noqa: E402
import models                                            # noqa: E402
from routers import daily_briefing as briefing_router    # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

FIXED = datetime(2026, 9, 28, 14, 10, tzinfo=timezone.utc)   # a Monday
TODAY_LA = "2026-09-28"


class _FrozenDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED.astimezone(tz) if tz else FIXED.replace(tzinfo=None)


def _frozen_local_now(tz):
    return FIXED.astimezone(ZoneInfo(tz or "America/Los_Angeles")).replace(tzinfo=None)


_SECTIONS = {"action_required": [{"title": "Approve: Fence repair", "detail": "Waiting on you",
                                  "url": "https://nexus.example/tasks", "module": "tasks"}]}


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusDailyBriefingLog, models.NexusSetting, models.NexusEmployee,
                  models.Shift, models.ShiftAssignment, models.ScheduledShift):
            self.db.query(m).delete()
        self.db.commit()
        self.sent = []
        patches = [
            mock.patch.object(daily_briefing, "datetime", _FrozenDT),
            mock.patch.object(daily_briefing, "_shift_local_now", _frozen_local_now),
            mock.patch.object(daily_briefing, "build_sections", lambda *a, **k: dict(_SECTIONS)),
            mock.patch.object(daily_briefing, "_logo_url", lambda db: ""),
            mock.patch.object(daily_briefing.graph_mail, "send_mail",
                              lambda **kw: self.sent.append(kw)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    # helpers
    def _emp(self, email, **kw):
        self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0].title(),
                                         work_email=email, **kw))
        self.db.commit()

    def _preset(self, email, start="09:00", days="1,2,3,4,5", tz="America/Los_Angeles"):
        sid = gen_id()
        self.db.add(models.Shift(id=sid, name="Preset", start_hhmm=start, days=days, timezone=tz))
        self.db.add(models.ShiftAssignment(id=gen_id(), employee_email=email, shift_id=sid))
        self.db.commit()

    def _config(self, **kw):
        cfg = {"mode": "live", "test_recipients": []}
        cfg.update(kw)
        daily_briefing.save_settings(self.db, cfg, "admin@greensglobal.com")

    def _scan(self):
        return daily_briefing._scan_once()

    def _recipients(self):
        return [tuple(s["to"]) for s in self.sent]

    def _logs(self, email):
        self.db.expire_all()
        return (self.db.query(models.NexusDailyBriefingLog)
                .filter(models.NexusDailyBriefingLog.employee_email == email).all())


class DefaultsTests(_Case):
    def test_defaults_keep_todays_behavior(self):
        cfg = daily_briefing.get_settings(self.db)
        self.assertEqual(cfg["leadMinutes"], 150)
        self.assertIs(cfg["includeNoShift"], False)
        self.assertEqual(cfg["defaultSendTime"], "07:00")
        self.assertEqual(cfg["defaultTimeZone"], "America/Los_Angeles")

    def test_an_old_saved_config_without_the_new_keys_gets_the_defaults(self):
        self.db.add(models.NexusSetting(key="daily_briefing_config", value='{"mode": "test"}'))
        self.db.commit()
        cfg = daily_briefing.get_settings(self.db)
        self.assertEqual(cfg["mode"], "test")
        self.assertIs(cfg["includeNoShift"], False)
        self.assertEqual(daily_briefing.lead_minutes(cfg), 150)


class NoShiftTests(_Case):
    def test_no_shift_person_gets_one_briefing_at_the_default_time(self):
        self._emp("amy@greensglobal.com")
        self._config(includeNoShift=True, defaultSendTime="07:00")
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._recipients(), [("amy@greensglobal.com",)])
        logs = self._logs("amy@greensglobal.com")
        self.assertEqual([r.briefing_date for r in logs], [TODAY_LA])
        self.assertTrue(logs[0].sent_at)
        # Greeting follows the person's clock (7:10 AM Pacific).
        self.assertIn("Good morning", self.sent[0]["html"])

    def test_no_briefing_when_the_switch_is_off(self):
        self._emp("amy@greensglobal.com")
        self._config(includeNoShift=False, defaultSendTime="07:00")
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(self._logs("amy@greensglobal.com"), [])

    def test_not_before_the_default_time(self):
        self._emp("amy@greensglobal.com")
        self._config(includeNoShift=True, defaultSendTime="07:30")
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self.sent, [])

    def test_not_after_the_catch_up_window(self):
        # 7:10 AM Pacific is more than 4 hours after a 2:00 AM default time.
        self._emp("amy@greensglobal.com")
        self._config(includeNoShift=True, defaultSendTime="02:00")
        self.assertEqual(self._scan(), 0)

    def test_day_off_on_a_preset_counts_as_no_shift(self):
        # Weekend-only preset, and today is a Monday.
        self._emp("wes@greensglobal.com")
        self._preset("wes@greensglobal.com", days="6,7")
        self._config(includeNoShift=True, defaultSendTime="07:00")
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._recipients(), [("wes@greensglobal.com",)])

    def test_inactive_and_external_people_are_skipped(self):
        self._emp("gone@greensglobal.com", status="offboarded")
        self._emp("deleted@greensglobal.com", deleted_at="2026-09-01T00:00:00")
        self._emp("vendor@example.com", identity_type="external")
        self._config(includeNoShift=True, defaultSendTime="07:00")
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self.sent, [])


class TimeZoneTests(_Case):
    def test_own_preset_zone_wins_over_the_default_zone(self):
        # India preset, weekend-only, so Monday is a day off. It is 7:40 PM IST.
        self._emp("ravi@greensglobal.com")
        self._preset("ravi@greensglobal.com", days="6,7", tz="Asia/Kolkata")
        self._emp("amy@greensglobal.com")   # no preset -> default zone (Pacific, 7:10 AM)
        self._config(includeNoShift=True, defaultSendTime="19:30", defaultTimeZone="America/Los_Angeles")
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._recipients(), [("ravi@greensglobal.com",)])
        self.assertIn("Good evening", self.sent[0]["html"])

    def test_default_zone_applies_to_people_without_a_zone(self):
        self._emp("amy@greensglobal.com")
        self._config(includeNoShift=True, defaultSendTime="19:30", defaultTimeZone="Asia/Kolkata")
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._logs("amy@greensglobal.com")[0].briefing_date, "2026-09-28")

    def test_briefing_date_is_the_persons_local_date(self):
        # 14:10 UTC is already 3:10 AM Tuesday in Auckland.
        self._emp("kiri@greensglobal.com")
        self._config(includeNoShift=True, defaultSendTime="03:00", defaultTimeZone="Pacific/Auckland")
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._logs("kiri@greensglobal.com")[0].briefing_date, "2026-09-29")


class ShiftPathTests(_Case):
    def test_shift_person_is_sent_once_not_twice(self):
        # Mon-Fri 9:00 AM Pacific; trigger 6:30 AM; it is 7:10 AM. The no-shift
        # default (7:00 AM) is also "due" by the clock - it must not add a send.
        self._emp("sam@greensglobal.com")
        self._preset("sam@greensglobal.com", start="09:00")
        self._config(includeNoShift=True, defaultSendTime="07:00")
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self._recipients(), [("sam@greensglobal.com",)])
        self.assertEqual(len(self._logs("sam@greensglobal.com")), 1)

    def test_shift_later_today_is_not_sent_early_at_the_default_time(self):
        # 5:00 PM shift: trigger 2:30 PM. At 7:10 AM nothing goes out, even with
        # the no-shift default due - they have a shift today.
        self._emp("eve@greensglobal.com")
        self._preset("eve@greensglobal.com", start="17:00")
        self._config(includeNoShift=True, defaultSendTime="07:00")
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self.sent, [])

    def test_published_scheduled_shift_counts_as_a_shift(self):
        self._emp("pat@greensglobal.com")
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email="pat@greensglobal.com",
                                          work_date=TODAY_LA, start_hhmm="18:00", published=1))
        self.db.commit()
        self._config(includeNoShift=True, defaultSendTime="07:00")
        self.assertEqual(self._scan(), 0)

    def test_lead_minutes_is_respected(self):
        # 9:30 AM shift. Lead 150 -> trigger 7:00 AM (due at 7:10).
        self._emp("sam@greensglobal.com")
        self._preset("sam@greensglobal.com", start="09:30")
        self._config(leadMinutes=60)            # trigger 8:30 AM - not yet
        self.assertEqual(self._scan(), 0)
        self._config(leadMinutes=150)
        self.assertEqual(self._scan(), 1)

    def test_default_lead_is_150_minutes(self):
        self._emp("sam@greensglobal.com")
        self._preset("sam@greensglobal.com", start="09:45")   # trigger 7:15 AM
        self._config()
        self.assertEqual(self._scan(), 0)


class DedupeAndModeTests(_Case):
    def test_second_scan_same_day_sends_nothing(self):
        self._emp("amy@greensglobal.com")
        self._config(includeNoShift=True)
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._scan(), 0)
        self.assertEqual(len(self.sent), 1)

    def test_a_row_logged_in_off_mode_still_blocks_the_day(self):
        # Known gotcha kept as-is: a same-day log row blocks a resend even after
        # the mode flips.
        self._emp("amy@greensglobal.com")
        self._config(mode="off", includeNoShift=True)
        self.assertEqual(self._scan(), 1)      # scanned + logged, not sent
        self.assertEqual(self.sent, [])
        self._config(mode="live")
        self.assertEqual(self._scan(), 0)
        self.assertEqual(self.sent, [])

    def test_test_mode_only_mails_the_test_recipients(self):
        self._emp("amy@greensglobal.com")
        self._config(mode="test", test_recipients=["qa@greensglobal.com"], includeNoShift=True)
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self._recipients(), [("qa@greensglobal.com",)])
        self.assertTrue(self.sent[0]["subject"].startswith("[TEST -> amy@greensglobal.com]"))


class ValidationTests(_Case):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(briefing_router.router)
        from auth import require_administrator
        app.dependency_overrides[require_administrator] = lambda: {
            "email": "admin@greensglobal.com", "role": "administrator", "level": 4}
        self.client = TestClient(app)

    def test_valid_timing_saves(self):
        r = self.client.put("/daily-briefing/config", json={
            "leadMinutes": 90, "includeNoShift": True, "defaultSendTime": "06:30",
            "defaultTimeZone": "Asia/Kolkata"})
        self.assertEqual(r.status_code, 200, r.text)
        body = self.client.get("/daily-briefing/config").json()
        self.assertEqual((body["leadMinutes"], body["includeNoShift"], body["defaultSendTime"],
                          body["defaultTimeZone"]), (90, True, "06:30", "Asia/Kolkata"))

    def test_bad_values_are_refused_and_nothing_is_saved(self):
        for bad in ({"leadMinutes": 29}, {"leadMinutes": 361}, {"defaultSendTime": "7:00"},
                    {"defaultSendTime": "24:00"}, {"defaultSendTime": "07:00 AM"},
                    {"defaultTimeZone": "Mars/Base"}, {"defaultTimeZone": ""}):
            r = self.client.put("/daily-briefing/config", json=bad)
            self.assertIn(r.status_code, (400, 422), (bad, r.text))
        cfg = daily_briefing.get_settings(self.db)
        self.assertEqual((cfg["leadMinutes"], cfg["defaultSendTime"], cfg["defaultTimeZone"]),
                         (150, "07:00", "America/Los_Angeles"))

    def test_validate_timing_directly(self):
        self.assertEqual(daily_briefing.validate_timing({"defaultSendTime": " 23:59 "})["defaultSendTime"], "23:59")
        for bad in ({"leadMinutes": True}, {"leadMinutes": 45.5}, {"includeNoShift": "yes"}):
            with self.assertRaises(ValueError):
                daily_briefing.validate_timing(bad)

    def test_a_corrupt_saved_lead_falls_back_to_150(self):
        self.assertEqual(daily_briefing.lead_minutes({"leadMinutes": "abc"}), 150)
        self.assertEqual(daily_briefing.lead_minutes({"leadMinutes": 5000}), 150)


if __name__ == "__main__":
    unittest.main()
