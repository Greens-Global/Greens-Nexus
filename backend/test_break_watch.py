"""
A break that never ended (Oct 20 2026): break_watch.py.

  - The employee gets one "Still on Break?" bell once the break has been open
    `breakNudgeMin` (60 by default), never before, never twice; it closes in
    place when the break ends.
  - At twice that, the manager and the Backup Manager get one rollup per work
    day listing everyone still out, refreshed in place, resolved when
    everyone is back.
  - 0 turns it off per company; exempt, fixed-pay and inactive people are
    skipped (overtime_watch's rules); someone working (not on break) is never
    nudged.

Clock is passed in. Throwaway sqlite.
Run with: python -m pytest -q test_break_watch.py
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
import break_watch as bw  # noqa: E402

ENT = "ent-bw"
MGR = "bw.mgr@greensglobal.com"
BACKUP = "bw.backup@greensglobal.com"
HR = "bw.hr@greensglobal.com"
AMY = "bw.amy@greensglobal.com"
BOB = "bw.bob@greensglobal.com"
CARA = "bw.cara@greensglobal.com"    # exempt from time tracking
FAY = "bw.fay@greensglobal.com"      # fixed (monthly) pay
DAY = "2026-10-15"
OFFSET = 300                         # CDT: UTC-5 (JS getTimezoneOffset)


def _utc(hhmm: str) -> datetime:
    d = datetime.strptime(f"{DAY} {hhmm}", "%Y-%m-%d %H:%M")
    return (d + timedelta(minutes=OFFSET)).replace(tzinfo=timezone.utc)


class BreakWatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.HrEntity, models.NexusNotification, models.NexusSetting,
                  models.TimePunch, models.PayrollRate, models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        for em, first, mgr in ((MGR, "Mia", ""), (BACKUP, "Ben", ""), (HR, "Hal", ""), (AMY, "Amy", MGR),
                               (BOB, "Bob", MGR), (CARA, "Cara", MGR), (FAY, "Fay", MGR)):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             manager_email=mgr, backup_manager_email=BACKUP if em == AMY else "",
                                             status="active", deleted_at="", company=ENT, country="US"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", hr_contact_email=HR, country="US"))
        self.db.add(models.PayrollRate(employee_email=FAY, hourly_rate=20, overtime_rule="ca", pay_type="fixed"))
        self.db.add(models.NexusGroup(id="g-bw-exempt", name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-bw-exempt", email=CARA))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _punch(self, em, kind, hhmm):
        at = _utc(hhmm).strftime("%Y-%m-%dT%H:%M:%S")
        self.db.add(models.TimePunch(id=f"p-{em}-{kind}-{hhmm}", employee_email=em, kind=kind, at=at,
                                     local_date=DAY, tz_offset_min=OFFSET, created_at=at))
        self.db.commit()

    def _on_break(self, em, since="12:00"):
        self._punch(em, "in", "08:00")
        self._punch(em, "break_start", since)

    def _scan(self, hhmm):
        return bw.break_scan(self.db, _utc(hhmm))

    def _bells(self, to, prefix):
        self.db.expire_all()
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == to,
                        models.NexusNotification.ref_id.like(f"{prefix}%")).all())

    def test_nothing_before_the_threshold(self):
        self._on_break(AMY)
        self.assertEqual(self._scan("12:59")["nudged"], 0)
        self.assertEqual(self._bells(AMY, bw.EMP_PREFIX), [])

    def test_the_employee_hears_once_on_their_own_clock(self):
        self._on_break(AMY)
        self.assertEqual(self._scan("13:00")["nudged"], 1)
        self.assertEqual(self._scan("13:05")["nudged"], 0)
        bells = self._bells(AMY, bw.EMP_PREFIX)
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Still on Break?")
        self.assertIn("12:00 PM", bells[0].body)
        self.assertIn("Punch back in, or fix it on your Time Sheet", bells[0].body)
        # Not yet the manager's business.
        self.assertEqual(self._bells(MGR, bw.MGR_PREFIX), [])

    def test_the_bell_closes_when_the_break_ends(self):
        self._on_break(AMY)
        self._scan("13:00")
        self._punch(AMY, "break_end", "13:10")
        self._scan("13:15")
        (bell,) = self._bells(AMY, bw.EMP_PREFIX)
        self.assertTrue(bell.actioned)
        self.assertEqual(bell.title, "Back From Break")

    def test_the_manager_gets_one_rollup_at_twice_the_threshold(self):
        self._on_break(AMY)
        self._on_break(BOB, "12:30")
        self._scan("13:59")
        self.assertEqual(self._bells(MGR, bw.MGR_PREFIX), [])
        self._scan("14:00")
        (bell,) = self._bells(MGR, bw.MGR_PREFIX)
        self.assertEqual(bell.title, "Long Break - Amy Lee")
        self.assertEqual(bell.body, "Amy Lee - on break since 12:00 PM (2h 0m)")
        self.assertEqual(len(self._bells(BACKUP, bw.MGR_PREFIX)), 1)   # Amy's backup manager
        self.assertEqual(self._bells(AMY, bw.MGR_PREFIX), [])         # never the person
        self._scan("14:30")
        (bell,) = self._bells(MGR, bw.MGR_PREFIX)                      # same notice, grown
        self.assertEqual(bell.title, "Long Breaks - 2 People")
        self.assertEqual(bell.body.split("\n"), ["Amy Lee - on break since 12:00 PM (2h 30m)",
                                                 "Bob Lee - on break since 12:30 PM (2h 0m)"])
        # Everyone back: resolved in place.
        self._punch(AMY, "break_end", "14:31")
        self._punch(BOB, "out", "14:32")
        self._scan("14:35")
        (bell,) = self._bells(MGR, bw.MGR_PREFIX)
        self.assertTrue(bell.actioned)
        self.assertEqual(bell.title, "Back From Break")

    def test_zero_turns_it_off_for_the_company(self):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps({"breakNudgeMin": 0})))
        self.db.commit()
        self._on_break(AMY)
        self.assertEqual(self._scan("16:00"), {"onBreak": 1, "nudged": 0, "escalated": 0, "resolved": 0})

    def test_a_company_threshold(self):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps({"breakNudgeMin": 30})))
        self.db.commit()
        self._on_break(AMY)
        self.assertEqual(self._scan("12:30")["nudged"], 1)
        self.assertEqual(self._scan("13:00")["escalated"], 2)      # the manager and the backup

    def test_exempt_fixed_inactive_and_working_people_are_skipped(self):
        for em in (CARA, FAY, BOB):
            self._on_break(em)
        self.db.query(models.NexusEmployee).filter_by(work_email=BOB).update({"status": "terminated"})
        self._punch(AMY, "in", "08:00")                        # working, not on break
        self.db.commit()
        s = self._scan("15:00")
        self.assertEqual((s["onBreak"], s["nudged"], s["escalated"]), (3, 0, 0))


if __name__ == "__main__":
    unittest.main()
