"""
Live overtime alert (Oct 17 2026): overtime_watch.py.

  - project(): CA daily, CA weekly-before-daily, federal weekly only, 'none'
    never, already in overtime (incl. the CA 7th day) is not "soon".
  - The scan: worked minutes are the time sheet's (breaks taken off, a leave
    punch never counts), the bell fires inside the lead and not before, on
    the employee's own clock, 12-hour; it goes to the manager and the
    Backup Manager, never the person; ONE per person per threshold per
    period, however many ticks (or restarts) follow and whatever the
    manager did with it; the company switch is off by default; exempt,
    fixed-pay, on-break and inactive people are skipped.

Clock is passed in. Throwaway sqlite.
Run with: python -m pytest -q test_overtime_watch.py
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import database           # noqa: E402
import main               # noqa: E402,F401 - registers every model
import models             # noqa: E402
import overtime_watch as ow   # noqa: E402
from routers import shift_requests  # noqa: E402

ENT = "ent-ow"
MGR = "ow.mgr@greensglobal.com"
BACKUP = "ow.backup@greensglobal.com"
HR = "ow.hr@greensglobal.com"
AMY = "ow.amy@greensglobal.com"      # CA rule
BOB = "ow.bob@greensglobal.com"      # federal rule
CARA = "ow.cara@greensglobal.com"    # exempt from time tracking
FAY = "ow.fay@greensglobal.com"      # fixed (monthly) pay
DAY = "2026-10-15"                   # Thursday; the payroll week starts Sunday 10/11
WEEK = "2026-10-11"
OFFSET = 300                         # CDT: UTC-5 (JS getTimezoneOffset)


def _utc(local_day: str, hhmm: str) -> datetime:
    """A wall-clock time in CDT as UTC."""
    d = datetime.strptime(f"{local_day} {hhmm}", "%Y-%m-%d %H:%M")
    return (d + timedelta(minutes=OFFSET)).replace(tzinfo=timezone.utc)


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class ProjectTests(unittest.TestCase):
    def test_ca_daily(self):
        self.assertEqual(ow.project("ca", 7 * 60 + 30, 0, 20 * 60), ("daily", 30))

    def test_ca_weekly_comes_first_only_when_sooner(self):
        # 38h30m straight this week, 1h today: weekly in 90, daily in 420.
        self.assertEqual(ow.project("ca", 60, 0, 38 * 60 + 30), ("weekly", 90))
        # Weekly no sooner than daily: past 8h today nothing counts toward the 40.
        self.assertEqual(ow.project("ca", 7 * 60, 0, 39 * 60), ("daily", 60))

    def test_federal_is_weekly_only(self):
        self.assertEqual(ow.project("federal", 11 * 60, 0, 38 * 60), ("weekly", 120))
        self.assertEqual(ow.project("federal", 9 * 60, 0, 20 * 60), ("weekly", 20 * 60))

    def test_none_and_already_over(self):
        self.assertIsNone(ow.project("none", 7 * 60 + 50, 0, 39 * 60))
        self.assertIsNone(ow.project("ca", 8 * 60 + 10, 10, 30 * 60))
        self.assertIsNone(ow.project("ca", 60, 60, 30 * 60), "the CA 7th day: overtime from the first minute")
        self.assertIsNone(ow.project("federal", 5 * 60, 30, 40 * 60))
        self.assertIsNone(ow.project("ca", 8 * 60, 0, 30 * 60), "exactly at the line is not soon")

    def test_minutes_text(self):
        self.assertEqual(ow._hm(455), "7h 35m")
        self.assertEqual(ow._hm(0), "0h 0m")


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        ow._OVER_TODAY.clear()
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.HrEntity, models.NexusNotification, models.NexusSetting,
                  models.TimePunch, models.PayrollRate, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        for em, first, last, mgr in ((MGR, "Mia", "X", ""), (BACKUP, "Ben", "X", ""), (HR, "Hal", "X", ""),
                                     (AMY, "Amy", "Lee", MGR), (BOB, "Bob", "Diaz", MGR),
                                     (CARA, "Cara", "X", MGR), (FAY, "Fay", "X", MGR)):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name=last, work_email=em,
                                             manager_email=mgr, backup_manager_email=BACKUP if em == AMY else "",
                                             status="active", deleted_at="", company=ENT, country="US"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", hr_contact_email=HR, country="US"))
        for em, rule, pay in ((AMY, "ca", "hourly"), (BOB, "federal", "hourly"), (CARA, "ca", "hourly"),
                              (FAY, "ca", "fixed")):
            self.db.add(models.PayrollRate(employee_email=em, hourly_rate=20, overtime_rule=rule, pay_type=pay))
        self.db.add(models.NexusGroup(id="g-exempt", name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-exempt", email=CARA))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _on(self, **extra):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps({"otAlertOn": True, **extra})))
        self.db.commit()

    def _punch(self, email, kind, local_day, hhmm, category=""):
        at = _utc(local_day, hhmm)
        self.db.add(models.TimePunch(id=f"p-{email}-{kind}-{_stamp(at)}", employee_email=email, kind=kind,
                                     at=_stamp(at), local_date=local_day, tz_offset_min=OFFSET,
                                     created_at=_stamp(at), category=category))
        self.db.commit()

    def _shift(self, email, day, start, end, brk=None):
        self._punch(email, "in", day, start)
        if brk:
            self._punch(email, "break_start", day, brk[0])
            self._punch(email, "break_end", day, brk[1])
        if end:
            self._punch(email, "out", day, end)

    def _bells(self, em=None, ref=None):
        self.db.expire_all()
        q = self.db.query(models.NexusNotification)
        if em:
            q = q.filter(models.NexusNotification.recipient == em)
        if ref:
            q = q.filter(models.NexusNotification.ref_id == ref)
        return q.all()


class DailyTests(_Case):
    def test_fires_inside_the_lead_once_to_manager_and_backup(self):
        self._on()
        # 7:00 AM in, a 30-minute break: 6h 35m worked at 2:05 PM.
        self._shift(AMY, DAY, "07:00", None, brk=("11:00", "11:30"))
        s = ow.overtime_scan(self.db, _utc(DAY, "14:05"))
        self.assertEqual(s["alerts"], 0, s)
        self.assertEqual(self._bells(), [])
        # 3:00 PM: 7h 30m worked (the break is not), daily overtime at 3:30 PM.
        s = ow.overtime_scan(self.db, _utc(DAY, "15:00"))
        self.assertEqual(s["alerts"], 2, s)
        ref = f"ot_soon:daily:{AMY}:{DAY}"
        for em in (MGR, BACKUP):
            bells = self._bells(em, ref)
            self.assertEqual(len(bells), 1, em)
            b = bells[0]
            self.assertEqual((b.type, b.priority, b.company, b.actioned), ("custom_alert", 0, ENT, False))
            self.assertEqual(b.title, "Overtime Soon - Amy Lee")
            self.assertEqual(b.body, "Amy Lee has worked 7h 30m today and reaches daily overtime at 3:30 PM.")
            action = json.loads(b.action)
            self.assertEqual((action["view"], action["timecard"], action["kind"]), ("hr", AMY, "overtime_soon"))
        self.assertEqual(self._bells(AMY), [], "never the person")
        self.assertEqual(self._bells(HR), [], "HR only when there is nobody else")
        # Later ticks - and a restart, which is just another tick - write nothing more,
        # even after the manager read and closed it.
        b = self._bells(MGR, ref)[0]
        b.read_by, b.actioned = MGR, True
        self.db.commit()
        for hhmm in ("15:05", "15:20", "15:29"):
            self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, hhmm))["alerts"], 0, hhmm)
        self.assertEqual(len(self._bells(ref=ref)), 2)
        self.assertTrue(self._bells(MGR, ref)[0].actioned, "a closed bell stays closed")
        self.assertEqual(self.db.query(models.TimePunch).count(), 3, "the projected clock-out is never stored")

    def test_off_by_default(self):
        self.assertFalse(shift_requests._DEFAULTS["otAlertOn"])
        self._shift(AMY, DAY, "07:00", None)
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:45"))["alerts"], 0)
        self.assertEqual(self._bells(), [])

    def test_lead_setting_and_zero_turns_a_threshold_off(self):
        self._on(otAlertDailyLeadMin=60)
        self._shift(AMY, DAY, "07:00", None)
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "13:55"))["alerts"], 0)   # 65 min out
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:00"))["alerts"], 2)   # 60 min out
        self.assertIn("at 3:00 PM.", self._bells(MGR)[0].body)

    def test_zero_daily_lead(self):
        self._on(otAlertDailyLeadMin=0)
        self._shift(AMY, DAY, "07:00", None)
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:45"))["alerts"], 0)

    def test_already_over_is_not_soon(self):
        self._on()
        self._shift(AMY, DAY, "06:00", None)
        s = ow.overtime_scan(self.db, _utc(DAY, "14:30"))
        self.assertEqual((s["checked"], s["alerts"]), (1, 0), s)
        # Overtime only grows within the day: her timecard is not run again.
        s = ow.overtime_scan(self.db, _utc(DAY, "14:35"))
        self.assertEqual((s["checked"], s["alerts"]), (0, 0), s)

    def test_on_break_is_skipped_until_back(self):
        self._on()
        self._punch(AMY, "in", DAY, "07:00")
        self._punch(AMY, "break_start", DAY, "14:30")
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:40"))["alerts"], 0)
        self._punch(AMY, "break_end", DAY, "14:50")
        # 7h 30m before the break + 5m after it: daily overtime in 25 minutes.
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:55"))["alerts"], 2)
        self.assertIn("worked 7h 35m today and reaches daily overtime at 3:20 PM.", self._bells(MGR)[0].body)

    def test_clocked_out_is_not_watched(self):
        self._on()
        self._shift(AMY, DAY, "07:00", "14:45")
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:50"))["open"], 0)

    def test_leave_punch_never_counts(self):
        self._on()
        self._punch(AMY, "in", DAY, "07:00", category="Sick Day")
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:45"))["alerts"], 0)

    def test_exempt_fixed_pay_and_inactive_are_skipped(self):
        self._on()
        for em in (CARA, FAY, BOB):
            self._shift(em, DAY, "07:00", None)
        bob = self.db.query(models.NexusEmployee).filter_by(work_email=BOB).first()
        bob.status = "inactive"
        self.db.commit()
        # Bob is federal anyway: no daily alert for him either way.
        s = ow.overtime_scan(self.db, _utc(DAY, "14:45"))
        self.assertEqual((s["open"], s["alerts"]), (3, 0), s)
        self.assertEqual(self._bells(), [])

    def test_crossing_after_midnight_carries_the_date(self):
        self._on()
        self._shift(AMY, DAY, "16:00", None)
        s = ow.overtime_scan(self.db, _utc("2026-10-16", "00:00") - timedelta(minutes=10))   # 11:50 PM
        self.assertEqual(s["alerts"], 2, s)
        self.assertIn("reaches daily overtime at 12:00 AM on 10/16/2026.", self._bells(MGR)[0].body)


class WeeklyTests(_Case):
    def test_federal_weekly_on_the_payroll_week(self):
        self._on()
        # A Saturday shift of the PREVIOUS payroll week never counts.
        self._shift(BOB, "2026-10-10", "06:00", "18:00")
        for d in ("2026-10-12", "2026-10-13", "2026-10-14"):   # Mon - Wed, 10h each
            self._shift(BOB, d, "07:00", "17:00")
        self._shift(BOB, DAY, "07:00", None)
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "14:55"))["alerts"], 0)   # 125 min out
        s = ow.overtime_scan(self.db, _utc(DAY, "15:00"))                                # 38h: 120 min out
        self.assertEqual(s["alerts"], 1, s)                       # Bob has no backup manager
        ref = f"ot_soon:weekly:{BOB}:{WEEK}"
        b = self._bells(MGR, ref)[0]
        self.assertEqual(b.title, "Overtime Soon - Bob Diaz")
        self.assertEqual(b.body, "Bob Diaz has worked 38h 0m this week and reaches weekly overtime at 5:00 PM.")
        self.assertEqual(ow.overtime_scan(self.db, _utc(DAY, "15:30"))["alerts"], 0)
        self.assertEqual(len(self._bells(ref=ref)), 1)

    def test_ca_weekly_counts_straight_time_only(self):
        self._on()
        # Sun - Thu 9h each: 8h straight + 1h daily overtime a day = 40h straight
        # would be Friday's... 5 x 8 = 40 straight already: Friday is weekly
        # overtime from the first minute, never "soon".
        for d in ("2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"):
            self._shift(AMY, d, "07:00", "16:00")
        self._shift(AMY, "2026-10-16", "07:00", None)
        self.assertEqual(ow.overtime_scan(self.db, _utc("2026-10-16", "08:00"))["alerts"], 0)
        # Sun - Thu 7h 30m each = 37h 30m straight: Friday 1h in -> 30 min to weekly.
        self.db.query(models.TimePunch).delete()
        self.db.commit()
        ow._OVER_TODAY.clear()   # the memo of who is already over today (per process)
        for d in ("2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"):
            self._shift(AMY, d, "07:00", "14:30")
        self._shift(AMY, "2026-10-16", "07:00", None)
        s = ow.overtime_scan(self.db, _utc("2026-10-16", "08:00"))
        self.assertEqual(s["alerts"], 2, s)
        ref = f"ot_soon:weekly:{AMY}:{WEEK}"
        self.assertEqual(self._bells(MGR, ref)[0].body,
                         "Amy Lee has worked 38h 30m this week and reaches weekly overtime at 9:30 AM.")

    def test_ca_weekly_body_shows_regular_time_when_it_differs(self):
        self._on()
        # Sun 10h (8 straight + 2 OT), Mon - Thu 7h 30m: 38h straight, 40h worked by Fri 8:00.
        self._shift(AMY, "2026-10-11", "07:00", "17:00")
        for d in ("2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"):
            self._shift(AMY, d, "07:00", "14:30")
        self._shift(AMY, "2026-10-16", "07:00", None)
        s = ow.overtime_scan(self.db, _utc("2026-10-16", "08:00"))
        self.assertEqual(s["alerts"], 2, s)
        self.assertEqual(self._bells(MGR, f"ot_soon:weekly:{AMY}:{WEEK}")[0].body,
                         "Amy Lee has worked 41h 0m this week (39h 0m regular) and reaches weekly overtime at 9:00 AM.")


class SettingsTests(unittest.TestCase):
    def test_keys_are_clamped(self):
        self.assertEqual(shift_requests._clean_value("otAlertDailyLeadMin", 999), 240)
        self.assertEqual(shift_requests._clean_value("otAlertWeeklyLeadMin", -5), 0)
        self.assertTrue(shift_requests._clean_value("otAlertOn", True))
        self.assertEqual((shift_requests._DEFAULTS["otAlertDailyLeadMin"],
                          shift_requests._DEFAULTS["otAlertWeeklyLeadMin"]), (30, 120))


if __name__ == "__main__":
    unittest.main()
