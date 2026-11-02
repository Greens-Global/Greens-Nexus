"""Early punch alert (Neil, 11/02/2026, a Homebase lift): a clock-in more than
`earlyPunchAlertMin` minutes before the person's expected start tells their
manager (one rollup bell per team and day, refreshed as a second person
punches early). The punch is ALWAYS recorded - nothing here can refuse it.

  - 0 (the default) = off: no bell.
  - Inside the window, no expected start (no shift, no preset), a leave
    punch and anything but a clock-in: no bell.
  - The first early clock-in bells the manager ("Early Punch Today"); the
    second person joins the same bell ("Early Punches Today"), never a
    second one.
  - The /punch route calls the check after the row is added; a check that
    blows up never blocks the punch.

Run with: python -m pytest test_early_punch.py -q
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

# A throwaway sqlite of its own (CLAUDE.md: one test file per process).
_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth               # noqa: E402
import cache              # noqa: E402
import database           # noqa: E402
import main               # noqa: E402
import models             # noqa: E402
import early_punch        # noqa: E402
from routers import shift_requests, timeclock  # noqa: E402

ENT, GROUP, PRESET = "ent-ep", "grp-ep", "preset-ep"
MGR = "ep.mgr@greensglobal.com"
SCHED = "ep.sched@greensglobal.com"
AMY = "ep.amy@greensglobal.com"
BOB = "ep.bob@greensglobal.com"
LONER = "ep.loner@greensglobal.com"   # no shift, no preset
TZ = "America/Chicago"                # CDT in October: UTC-5
DAY = "2026-10-15"                    # Thursday
START = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)   # 7:00 AM CDT
REF = f"earlyin:{GROUP}:{DAY}"


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class EarlyPunchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrEntity,
                  models.Shift, models.ShiftAssignment, models.ScheduledShift, models.NexusNotification,
                  models.NexusSetting, models.TimePunch, models.TimeBod):
            self.db.query(m).delete()
        for em, first, last, mgr in ((MGR, "Mia", "X", ""), (SCHED, "Sol", "X", ""), (AMY, "Amy", "Lee", MGR),
                                     (BOB, "Bob", "X", MGR), (LONER, "Lou", "X", MGR)):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name=last, work_email=em,
                                             manager_email=mgr, status="active", deleted_at="", company=ENT, country="US"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens"))
        self.db.add(models.ShiftGroup(id=GROUP, name="Austin Crew", scheduler_emails=json.dumps([SCHED]),
                                      company_id=ENT, created_by=MGR))
        for em in (AMY, BOB):
            self.db.add(models.ShiftGroupMember(id=f"m-{em}", group_id=GROUP, employee_email=em))
        self.db.add(models.Shift(id=PRESET, name="Day", code="D", start_hhmm="07:00", end_hhmm="15:30",
                                 grace_min=5, timezone=TZ, days="1,2,3,4,5"))
        for em in (AMY, BOB):
            self.db.add(models.ScheduledShift(id=f"s-{em}", employee_email=em, work_date=DAY, start_hhmm="07:00",
                                              end_hhmm="15:30", published=1, group_id=GROUP, shift_id=PRESET,
                                              timezone=TZ, created_by=MGR))
        self.db.commit()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev

    # ── fixtures ────────────────────────────────────────────────────────
    def _setting(self, **cfg):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps(cfg)))
        self.db.commit()

    def _punch(self, email, kind, at: datetime, category=""):
        """A punch row added and flushed the way the routes do before the check."""
        row = models.TimePunch(id=f"p-{email}-{kind}-{_stamp(at)}", employee_email=email, kind=kind,
                               at=_stamp(at), local_date=DAY, tz_offset_min=300, created_at=_stamp(at),
                               created_by=email, category=category)
        self.db.add(row)
        self.db.flush()
        return row

    def _emp(self, email):
        return self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()

    def _check(self, email, kind="in", early_min=25, category=""):
        row = self._punch(email, kind, START - timedelta(minutes=early_min), category=category)
        out = early_punch.check(self.db, row, self._emp(email))
        self.db.commit()
        return out

    def _bells(self, em, ref=REF):
        self.db.expire_all()
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == em, models.NexusNotification.ref_id == ref).all())

    # ── the check ───────────────────────────────────────────────────────
    def test_off_by_default_no_bell(self):
        self.assertEqual(shift_requests.get_settings(self.db, ENT)["earlyPunchAlertMin"], 0)
        self.assertIsNone(self._check(AMY, early_min=45))
        self.assertEqual(self._bells(MGR), [])
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)

    def test_early_in_bells_manager_once_and_groups_second_person(self):
        self._setting(earlyPunchAlertMin=15)
        out = self._check(AMY, early_min=25)
        self.assertEqual(out, {"minutesEarly": 25, "expectedStart": "07:00"})
        for em in (MGR, SCHED):
            bells = self._bells(em)
            self.assertEqual(len(bells), 1, em)
            b = bells[0]
            self.assertEqual(b.title, "Early Punch Today")
            self.assertEqual(b.body, "Amy Lee punched in 25 min before their 7:00 AM shift.")
            self.assertEqual((b.type, b.company, b.actioned), ("custom_alert", ENT, False))
            self.assertEqual(json.loads(b.action), {"view": "shifts", "sub": f"schedule:{DAY}:{GROUP}", "kind": "early_punch"})
        self.assertEqual(self._bells(AMY), [], "never the person")
        # Bob punches 20 minutes early: the SAME bell, now about two people.
        out = self._check(BOB, early_min=20)
        self.assertEqual(out["minutesEarly"], 20)
        bells = self._bells(MGR)
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Early Punches Today")
        self.assertEqual(bells[0].body, "2 people punched in early: Amy Lee (25 min), Bob X (20 min).")
        self.assertEqual(self.db.query(models.NexusNotification).count(), 2, "one per recipient, never per punch")

    def test_within_window_no_bell(self):
        self._setting(earlyPunchAlertMin=15)
        self.assertIsNone(self._check(AMY, early_min=10))
        self.assertIsNone(self._check(BOB, early_min=15), "exactly the window is not more than it")
        self.assertEqual(self._bells(MGR), [])

    def test_no_expected_start_no_bell(self):
        """Review Focus 1: no shift and no preset = no expected start = nothing."""
        self._setting(earlyPunchAlertMin=15)
        self.assertIsNone(self._check(LONER, early_min=120))
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)

    def test_out_punch_ignored(self):
        self._setting(earlyPunchAlertMin=15)
        self.assertIsNone(self._check(AMY, kind="out", early_min=60))
        self.assertIsNone(self._check(BOB, kind="break_start", early_min=60))
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)

    def test_a_leave_punch_is_not_an_early_clock_in(self):
        self._setting(earlyPunchAlertMin=15)
        self.assertIsNone(self._check(AMY, early_min=60, category="Sick Day"))
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)

    # ── the route ───────────────────────────────────────────────────────
    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def test_punch_route_records_the_punch_and_bells_the_manager(self):
        self._setting(earlyPunchAlertMin=15)
        self.db.add(models.TimeBod(id="bod-amy", employee_email=AMY, kind="bod", local_date=DAY, message="ok"))
        self.db.commit()
        self._as(AMY)
        with mock.patch.object(timeclock, "_now_iso", return_value=_stamp(START - timedelta(minutes=25))):
            r = self.client.post("/timeclock/punch", json={"kind": "in", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["punch"]["kind"], "in")
        self.assertEqual(len(self._bells(MGR)), 1)
        self.assertEqual(self._bells(MGR)[0].body, "Amy Lee punched in 25 min before their 7:00 AM shift.")

    def test_a_failing_check_never_blocks_the_punch(self):
        self._setting(earlyPunchAlertMin=15)
        self.db.add(models.TimeBod(id="bod-bob", employee_email=BOB, kind="bod", local_date=DAY, message="ok"))
        self.db.commit()
        self._as(BOB)
        with mock.patch.object(timeclock, "_now_iso", return_value=_stamp(START - timedelta(minutes=25))), \
                mock.patch.object(early_punch, "check", side_effect=RuntimeError("boom")):
            r = self.client.post("/timeclock/punch", json={"kind": "in", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 200, r.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == BOB).count(), 1)
        self.assertEqual(self._bells(MGR), [])


if __name__ == "__main__":
    unittest.main()
