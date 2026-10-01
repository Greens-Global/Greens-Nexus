"""
Shift notifications (Sep 28 2026) - shift_notify.py.

  - Publishing tells each affected person once (bell + email): grouped per
    person, never the publisher, never an open (unassigned) slot, and the
    email lists that person's own new / changed / removed shifts.
  - A placed, published shift gets one bell reminder 60 minutes before it
    starts, in the shift's own time zone - not earlier, not after it starts,
    not for drafts, and not when the person is clocked in, on approved time
    off or on a holiday.

The clock is frozen at Monday 09/28/2026 15:10 UTC (8:10 AM Pacific, 8:40 PM
India). Uses a throwaway sqlite file; no email is actually sent.

Run with: python -m unittest test_shift_notify -v
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

from fastapi import BackgroundTasks                     # noqa: E402

import database                                          # noqa: E402
import models                                            # noqa: E402
import shift_notify                                      # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

FIXED = datetime(2026, 9, 28, 15, 10, tzinfo=timezone.utc)
DAY = "2026-09-28"
AMY, BOB, BOSS = "amy@greensglobal.com", "bob@greensglobal.com", "boss@greensglobal.com"


class _FrozenDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED.astimezone(tz) if tz else FIXED.replace(tzinfo=None)


def _local(tz):
    return FIXED.astimezone(ZoneInfo(tz)).replace(tzinfo=None)


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusNotification, models.ScheduledShift, models.Shift, models.NexusEmployee,
                  models.TimeOffRequest, models.TimePunch, models.NexusSetting):
            self.db.query(m).delete()
        for em, first in ((AMY, "Amy"), (BOB, "Bob"), (BOSS, "Pat")):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=first, last_name="Lee", work_email=em))
        self.db.commit()
        for p in (mock.patch.object(shift_notify, "datetime", _FrozenDT),
                  mock.patch.object(shift_notify, "_local_now", _local),
                  mock.patch("routers.timeclock._company_holidays_for_many", lambda *a, **k: {})):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _bells(self, em=None):
        self.db.expire_all()
        q = self.db.query(models.NexusNotification)
        return q.filter(models.NexusNotification.recipient == em).all() if em else q.all()


class PublishTests(_Case):
    def _row(self, email, date=DAY):
        return models.ScheduledShift(id=gen_id(), employee_email=email, work_date=date)

    def test_one_bell_per_affected_person_never_the_publisher_or_an_open_slot(self):
        changes = [
            shift_notify.change("added", self._row(AMY), start="09:00", end="17:00", label="Front desk"),
            shift_notify.change("changed", self._row(AMY, "2026-09-29"), start="10:00", end="18:00", label="",
                                was=("09:00", "17:00", "")),
            shift_notify.change("removed", self._row(BOB), start="09:00", end="17:00", label=""),
            shift_notify.change("added", self._row(BOSS), start="09:00", end="17:00", label=""),
            shift_notify.change("added", self._row(""), start="09:00", end="17:00", label=""),
        ]
        n = shift_notify.notify_published(self.db, changes, BOSS, DAY, "2026-10-04")
        self.assertEqual(n, 2)
        amy = self._bells(AMY)
        self.assertEqual(len(amy), 1)
        self.assertEqual(amy[0].title, "Your schedule was updated")
        self.assertEqual(amy[0].body, "1 new, 1 changed (09/28/2026 - 09/29/2026).")
        self.assertIn('"view": "shifts", "sub": "mine"', amy[0].action)
        self.assertEqual(self._bells(BOB)[0].body, "1 removed (09/28/2026).")
        self.assertEqual(self._bells(BOSS), [])
        self.assertEqual(len(self._bells()), 2)

    def test_the_email_lists_the_persons_own_changes(self):
        changes = [
            shift_notify.change("changed", self._row(AMY), start="10:00", end="18:00", label="",
                                was=("09:00", "17:00", "Front desk")),
            shift_notify.change("removed", self._row(AMY, "2026-09-30"), start="13:00", end="21:00", label=""),
        ]
        bt = BackgroundTasks()
        with mock.patch("graph_mail.graph_configured", lambda: True):
            shift_notify.notify_published(self.db, changes, BOSS, DAY, "2026-10-04", bt)
        self.assertEqual(len(bt.tasks), 1)
        (to, subject, html), = bt.tasks[0].args[0]
        self.assertEqual(to, AMY)
        self.assertEqual(subject, "Your schedule was updated - 2 changes")
        for text in ("Hi Amy,", "Pat Lee published 2 changes", "Mon, 09/28/2026", "10:00 AM - 6:00 PM",
                     "was 9:00 AM - 5:00 PM &middot; Front desk", "Removed", "Open My Shifts", "/shifts/mine"):
            self.assertIn(text, html)

    def test_no_mail_is_queued_when_email_is_not_configured(self):
        bt = BackgroundTasks()
        with mock.patch("graph_mail.graph_configured", lambda: False):
            shift_notify.notify_published(
                self.db, [shift_notify.change("added", self._row(AMY), start="09:00", end="17:00", label="")],
                BOSS, DAY, DAY, bt)
        self.assertEqual(bt.tasks, [])
        self.assertEqual(len(self._bells(AMY)), 1)   # the bell still goes


class ReminderTests(_Case):
    def _placed(self, start, *, email=AMY, published=1, tz="America/Los_Angeles", label="Front desk"):
        sid = gen_id()
        self.db.add(models.Shift(id=sid, name="Store", start_hhmm=start, end_hhmm="17:00", timezone=tz))
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email=email, work_date=DAY, shift_id=sid,
                                          start_hhmm=start, end_hhmm="17:00", label=label, published=published))
        self.db.commit()

    def _scan(self):
        return shift_notify.reminder_scan_once(self.db)

    def test_one_reminder_within_the_hour_before_the_shift(self):
        self._placed("09:00")                # 8:10 AM now -> within 60 minutes
        self.assertEqual(self._scan(), 1)
        bell = self._bells(AMY)[0]
        self.assertEqual(bell.title, "Your shift starts at 9:00 AM")
        self.assertEqual(bell.body, "Today, 09/28/2026 · 9:00 AM - 5:00 PM · Front desk.")
        self.assertEqual(self._scan(), 0)    # once per shift

    def _settings(self, **cfg):
        import json
        self.db.add(models.NexusSetting(key="shift_requests_config", value=json.dumps(cfg)))
        self.db.commit()

    def test_reminders_can_be_turned_off(self):
        self._placed("09:00")
        self._settings(reminders=False)
        self.assertEqual(self._scan(), 0)

    def test_the_lead_time_is_a_setting(self):
        self._placed("09:30")                # 80 minutes away: too early at 60...
        self.assertEqual(self._scan(), 0)
        self._settings(reminderLeadMinutes=90)
        self.assertEqual(self._scan(), 1)    # ...on time at 90

    def test_not_too_early_and_not_after_the_start(self):
        self._placed("09:30")                # 80 minutes away
        self._placed("08:00", email=BOB)     # already started
        self.assertEqual(self._scan(), 0)

    def test_the_shifts_own_time_zone_is_used(self):
        self._placed("21:00", tz="Asia/Kolkata")   # 8:40 PM IST now
        self.assertEqual(self._scan(), 1)

    def test_drafts_get_no_reminder(self):
        self._placed("09:00", published=0)
        self.assertEqual(self._scan(), 0)

    def test_skipped_when_clocked_in_or_on_time_off_or_a_holiday(self):
        self._placed("09:00")
        self._placed("09:00", email=BOB)
        self.db.add(models.TimePunch(id=gen_id(), employee_email=AMY, kind="in", at="2026-09-28T15:00:00Z"))
        self.db.add(models.TimeOffRequest(id=gen_id(), employee_email=BOB, start_date=DAY, end_date=DAY,
                                          status="approved"))
        self.db.commit()
        self.assertEqual(self._scan(), 0)
        self.db.query(models.TimePunch).delete()
        self.db.query(models.TimeOffRequest).delete()
        self.db.commit()
        with mock.patch("routers.timeclock._company_holidays_for_many",
                        lambda db, people, s, e: {em: {DAY: {"name": "Holiday", "type": "mandatory"}} for em in people}):
            self.assertEqual(self._scan(), 0)
        self.assertEqual(self._scan(), 2)    # none of those left: both are reminded

    # ── Oct 2 rebuild ─────────────────────────────────────────────────────

    def test_a_shift_being_removed_gets_no_reminder(self):
        self._placed("09:00")
        self.db.query(models.ScheduledShift).update({"pending_delete": 1})
        self.db.commit()
        self.assertEqual(self._scan(), 0)

    def test_a_moved_start_is_reminded_again(self):
        """The dedupe key carries the start: after a publish moves the shift
        the person hears about the new time too."""
        self._placed("09:00")
        self.assertEqual(self._scan(), 1)
        self.db.query(models.ScheduledShift).update({"start_hhmm": "09:05"})
        self.db.commit()
        self.assertEqual(self._scan(), 1)
        self.assertEqual([b.title for b in self._bells(AMY)],
                         ["Your shift starts at 9:00 AM", "Your shift starts at 9:05 AM"])

    def test_the_placements_own_zone_wins_over_the_presets(self):
        self._placed("21:00", tz="America/Los_Angeles")      # the preset says Pacific: 12 hours away
        self.db.query(models.ScheduledShift).update({"timezone": "Asia/Kolkata"})   # the placement says India
        self.db.commit()
        self.assertEqual(self._scan(), 1)


class PublishDedupeTests(_Case):
    def _row(self, email, date=DAY):
        return models.ScheduledShift(id=gen_id(), employee_email=email, work_date=date)

    def test_the_publish_bell_is_one_row_per_person_and_range(self):
        first = [shift_notify.change("added", self._row(AMY), start="09:00", end="17:00", label="")]
        shift_notify.notify_published(self.db, first, BOSS, DAY, "2026-10-04")
        again = [shift_notify.change("added", self._row(AMY), start="09:00", end="17:00", label=""),
                 shift_notify.change("removed", self._row(AMY, "2026-09-30"), start="09:00", end="17:00", label="")]
        shift_notify.notify_published(self.db, again, BOSS, DAY, "2026-10-04")
        amy = self._bells(AMY)
        self.assertEqual(len(amy), 1)                              # updated in place, not a second bell
        self.assertEqual(amy[0].body, "1 new, 1 removed (09/28/2026 - 09/30/2026).")
        # Once she has dealt with it, the next publish is a new bell.
        amy[0].actioned = True
        self.db.commit()
        shift_notify.notify_published(self.db, first, BOSS, DAY, "2026-10-04")
        self.assertEqual(len(self._bells(AMY)), 2)
        # A different range is its own row.
        shift_notify.notify_published(self.db, first, BOSS, DAY, DAY)
        self.assertEqual(len(self._bells(AMY)), 3)


if __name__ == "__main__":
    unittest.main()
