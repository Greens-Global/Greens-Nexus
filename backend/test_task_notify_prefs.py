"""
Per-person task email preferences (Sept 2026) - task_notify_prefs + where the
senders apply them (task_notify), the settings API and the email "Mute" link.

Uses a throwaway sqlite file and NEXUS_SKIP_AUTH. _send_one is replaced with a
recorder, so nothing is emailed.

Run with: python -m unittest test_task_notify_prefs -v
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar@greensglobal.com"

from fastapi import FastAPI                      # noqa: E402
from fastapi.testclient import TestClient        # noqa: E402

import database                                  # noqa: E402
import models                                    # noqa: E402
import task_mail_actions as tma                  # noqa: E402
import task_notify                               # noqa: E402
import task_notify_prefs as tnp                  # noqa: E402
from routers import mail_actions                 # noqa: E402
from routers import tasks as tasks_router        # noqa: E402
from routers.task_util import gen_id, now_iso    # noqa: E402

ME = "sagar@greensglobal.com"
TODAY = date(2026, 9, 21)                                    # a Monday
NOON_PT = datetime(2026, 9, 21, 19, 0, tzinfo=timezone.utc)  # 12:00 PDT
SIX_AM_PT = datetime(2026, 9, 21, 13, 0, tzinfo=timezone.utc)


class NormalizeTests(unittest.TestCase):
    def test_defaults_mean_company_behavior(self):
        p = tnp.normalize(None)
        self.assertEqual(p["dueSoonDays"], "company")
        self.assertEqual(p["overdueFrequency"], "company")
        self.assertEqual(p["reminderDelivery"], "each")
        self.assertEqual(p["updateThrottleMinutes"], 0)
        self.assertTrue(all(p["events"].values()))

    def test_bad_values_fall_back_and_unknown_keys_drop(self):
        p = tnp.normalize({"reminderHour": 99, "timezone": "Mars/Base", "dueSoonDays": 40,
                           "overdueFrequency": "hourly", "reminderDelivery": "fax",
                           "updateThrottleMinutes": 7, "mutedTaskIds": ["a", "a", "", "b"],
                           "evil": True})
        self.assertEqual(p["reminderHour"], tnp.DEFAULT_HOUR)
        self.assertEqual(p["timezone"], tnp.DEFAULT_TZ)
        self.assertEqual(p["dueSoonDays"], "company")
        self.assertEqual(p["overdueFrequency"], "company")
        self.assertEqual(p["reminderDelivery"], "each")
        self.assertEqual(p["updateThrottleMinutes"], 0)
        self.assertEqual(p["mutedTaskIds"], ["a", "b"])
        self.assertNotIn("evil", p)

    def test_assigned_and_mentioned_cannot_be_switched_off(self):
        p = tnp.normalize({"events": {"assigned": False, "mentioned": False, "commented": False}})
        t = models.Task(id="t", project_id="")
        self.assertTrue(tnp.wants_event(p, "assigned", t))
        self.assertTrue(tnp.wants_event(p, "mentioned", t))
        self.assertFalse(tnp.wants_event(p, "commented", t))

    def test_mute_silences_everything_but_a_mention(self):
        p = tnp.normalize({"mutedProjectIds": ["proj"]})
        t = models.Task(id="t", project_id="proj")
        self.assertFalse(tnp.wants_event(p, "assigned", t))
        self.assertTrue(tnp.wants_event(p, "mentioned", t))

    def test_overdue_off_needs_the_company_to_allow_it(self):
        p = tnp.normalize({"overdueFrequency": "off"})
        self.assertEqual(tnp.overdue_repeat(p, {"allowUserOverdueOff": False}), 7)
        self.assertIsNone(tnp.overdue_repeat(p, {"allowUserOverdueOff": True}))
        self.assertEqual(tnp.overdue_repeat(tnp.normalize({}), {"overdueRepeatDays": 3}), 3)
        self.assertEqual(tnp.overdue_repeat(tnp.normalize({"overdueFrequency": "once"}), {}), 0)

    def test_reminder_hour_time_zone_and_weekends(self):
        p = tnp.normalize({"reminderHour": 9, "timezone": "America/New_York"})
        self.assertFalse(tnp.reminders_due_now(p, datetime(2026, 9, 21, 12, 59, tzinfo=timezone.utc)))  # 8:59 ET
        self.assertTrue(tnp.reminders_due_now(p, datetime(2026, 9, 21, 13, 0, tzinfo=timezone.utc)))    # 9:00 ET
        sat = tnp.normalize({"skipWeekends": True})
        self.assertFalse(tnp.reminders_due_now(sat, datetime(2026, 9, 19, 20, 0, tzinfo=timezone.utc)))
        self.assertTrue(tnp.reminders_due_now(sat, NOON_PT))


class _DB(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskEmailLog, models.NexusSetting, models.TaskActivity,
                  models.TaskNotifyPref, models.TaskComment):
            self.db.query(m).delete()
        self.db.commit()
        self.sent = []
        self._real_send = task_notify._send_one
        task_notify._send_one = lambda db, **kw: self.sent.append(kw)

    def tearDown(self):
        task_notify._send_one = self._real_send
        self.db.rollback()
        self.db.close()

    def _task(self, *, due_offset=None, title="Late", project_id="", **kw):
        t = models.Task(id=gen_id(), title=title, code="T", assignee_email=ME, assignee_emails=[ME],
                        project_id=project_id, completed=False, created_at=now_iso(), modified_at=now_iso(),
                        due_on=(TODAY + timedelta(days=due_offset)).isoformat() if due_offset is not None else "",
                        **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _prefs(self, **kw):
        tnp.save(self.db, ME, kw)


class ReminderScanTests(_DB):
    def test_nothing_before_the_persons_reminder_hour(self):
        self._task(due_offset=-1)
        task_notify._due_reminders_once(self.db, now_utc=SIX_AM_PT)   # default hour is 8 AM PT
        self.assertEqual(self.sent, [])
        task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
        self.assertEqual([s["event_type"] for s in self.sent], ["overdue"])

    def test_digest_sends_one_summary_for_several_tasks(self):
        self._prefs(reminderDelivery="digest")
        a = self._task(due_offset=-1, title="Invoice")
        b = self._task(due_offset=1, title="Report")
        task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
        self.assertEqual(len(self.sent), 1)
        mail = self.sent[0]
        self.assertEqual(mail["event_type"], "digest")
        self.assertEqual(mail["idem_suffix"], "2026-09-21")
        self.assertIn("1 Overdue, 1 Due Soon", mail["subject"])
        for t in (a, b):
            self.assertIn(t.title, mail["html"])
        self.assertIn("Email Settings", mail["html"])
        self.assertNotIn(tma.FOOTER_SLOT, mail["html"])

    def test_digest_with_a_single_task_is_just_that_tasks_email(self):
        self._prefs(reminderDelivery="digest")
        self._task(due_offset=-1)
        task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
        self.assertEqual([s["event_type"] for s in self.sent], ["overdue"])

    def test_each_mode_sends_one_per_task(self):
        self._task(due_offset=-1)
        self._task(due_offset=1)
        task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
        self.assertEqual(sorted(s["event_type"] for s in self.sent), ["due_soon", "overdue"])

    def test_due_soon_window_and_off(self):
        self._task(due_offset=4)
        self._prefs(dueSoonDays=5)
        task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
        self.assertEqual(len(self.sent), 1)
        self.sent.clear()
        self._prefs(dueSoonDays="off")
        task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
        self.assertEqual(self.sent, [])

    def test_weekly_overdue_frequency(self):
        self._prefs(overdueFrequency="weekly")
        for days, expect in ((1, 1), (3, 0), (8, 1), (9, 0)):
            with self.subTest(overdue_days=days):
                self.db.query(models.Task).delete()
                self.db.commit()
                self.sent.clear()
                self._task(due_offset=-days)
                task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
                self.assertEqual(len(self.sent), expect)

    def test_muted_task_gets_no_reminder(self):
        t = self._task(due_offset=-1)
        tnp.mute_task(self.db, ME, t.id)
        task_notify._due_reminders_once(self.db, now_utc=NOON_PT)
        self.assertEqual(self.sent, [])


class InstantEmailTests(_DB):
    def test_event_switched_off_is_not_sent(self):
        t = self._task()
        self._prefs(events={"modified": False})
        task_notify.notify_task_event(t.id, "modified", "neil@greensglobal.com", update_kind="Title changed")
        self.assertEqual(self.sent, [])

    def test_updates_throttle(self):
        t = self._task()
        self._prefs(updateThrottleMinutes=15)
        self.db.add(models.TaskEmailLog(id=gen_id(), task_id=t.id, event_type="modified", recipient=ME,
                                        status="sent", idempotency_key="k1",
                                        created_at=datetime.now(timezone.utc).isoformat()))
        self.db.commit()
        task_notify.notify_task_event(t.id, "modified", "neil@greensglobal.com", update_kind="Title changed")
        self.assertEqual(self.sent, [])

    def test_mention_still_arrives_on_a_muted_task(self):
        t = self._task()
        tnp.mute_task(self.db, ME, t.id)
        task_notify.notify_task_event(t.id, "mentioned", "neil@greensglobal.com",
                                      comment_body="<p>hi</p>", mentioned=[ME])
        self.assertEqual([(s["event_type"], s["recipient"]) for s in self.sent], [("mentioned", ME)],
                         "a mention must never be dropped by the mute")


class ApiAndMuteLinkTests(_DB):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(tasks_router.router)
        app.include_router(mail_actions.router)
        # The /tasks router requires a Tasks/Tickets grant (or admin level) -
        # sign the test caller in as an admin so this tests the settings, not
        # the module gate.
        import auth
        app.dependency_overrides[auth.get_current_user] = lambda: {"email": ME, "role": "administrator", "level": 4}
        self.client = TestClient(app)

    def test_get_and_put_my_settings(self):
        r = self.client.get("/tasks/notify/me")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["lockedEvents"], ["assigned", "mentioned"])
        r = self.client.put("/tasks/notify/me", json={"reminderHour": 7, "reminderDelivery": "digest",
                                                      "email": "someone-else@greensglobal.com"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["prefs"]["reminderHour"], 7)
        self.assertEqual(tnp.load(self.db, ME)["reminderDelivery"], "digest")
        self.assertIsNone(self.db.query(models.TaskNotifyPref)
                          .filter(models.TaskNotifyPref.email == "someone-else@greensglobal.com").first())

    def test_mute_link_page_then_submit(self):
        t = self._task(due_offset=-1, title="Noisy")
        tok = tma.sign_token(t.id, ME)
        r = self.client.get(f"/mail-actions/page?token={tok}&do=mute")
        self.assertIn("Stop all emails about this task?", r.text)
        self.assertEqual(tnp.load(self.db, ME)["mutedTaskIds"], [])    # GET changes nothing
        r = self.client.post("/mail-actions/page", data={"token": tok, "action": "mute"})
        self.assertIn("Emails muted for this task", r.text)
        self.db.expire_all()
        self.assertEqual(tnp.load(self.db, ME)["mutedTaskIds"], [t.id])
        r = self.client.get("/tasks/notify/me")
        self.assertEqual(r.json()["mutedTasks"], [{"id": t.id, "title": "Noisy"}])


if __name__ == "__main__":
    unittest.main()
