"""
California meal reminder at 4.5 hours (Charmi + Neil, Oct 20 2026): meal_watch.py.

  - One "Meal Break Reminder" bell once the day's work reaches
    `mealReminderMin` (270 by default), never before, never twice, with the
    5-hour deadline on the person's own clock, 12-hour.
  - Nothing while on a break or clocked out, after a 30+ minute meal, or
    once 5 hours have passed; a short break does not count as the meal.
  - California only (work state), hourly AND salaried (fixed pay); exempt
    from time tracking, India and inactive people are skipped.
  - 0 turns it off per company; a company threshold is respected.

Clock is passed in. Throwaway sqlite.
Run with: python -m pytest -q test_meal_watch.py
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
import meal_watch as mw   # noqa: E402

ENT = "ent-mw"
ENT_IN = "ent-mw-in"
AMY = "mw.amy@greensglobal.com"      # hourly, California
SAL = "mw.sal@greensglobal.com"      # salaried (fixed pay), California
CARA = "mw.cara@greensglobal.com"    # exempt from time tracking
TEX = "mw.tex@greensglobal.com"      # hourly, works in Texas
RAJ = "mw.raj@greensglobal.com"      # India
DAY = "2026-10-15"
OFFSET = 420                         # PDT: UTC-7 (JS getTimezoneOffset)


def _utc(hhmm: str) -> datetime:
    d = datetime.strptime(f"{DAY} {hhmm}", "%Y-%m-%d %H:%M")
    return (d + timedelta(minutes=OFFSET)).replace(tzinfo=timezone.utc)


class MealWatchTests(unittest.TestCase):
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
        people = ((AMY, ENT, "US", "Temecula, CA 92590"), (SAL, ENT, "US", "Temecula, CA 92590"),
                  (CARA, ENT, "US", "Temecula, CA 92590"), (TEX, ENT, "US", "Austin, TX 78701"),
                  (RAJ, ENT_IN, "IN", ""))
        for em, cid, country, loc in people:
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em[3:6].title(), last_name="Lee",
                                             work_email=em, status="active", deleted_at="", company=cid,
                                             country=country, location=loc))
            fixed = em in (SAL, RAJ)
            self.db.add(models.PayrollRate(employee_email=em, hourly_rate=25, overtime_rule="none" if em == RAJ else "ca",
                                           pay_type="fixed" if fixed else "hourly",
                                           currency="INR" if em == RAJ else "USD"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", country="US"))
        self.db.add(models.HrEntity(id=ENT_IN, name="Greens India", country="IN"))
        self.db.add(models.NexusGroup(id="g-mw-exempt", name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-mw-exempt", email=CARA))
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _punch(self, em, kind, hhmm):
        at = _utc(hhmm).strftime("%Y-%m-%dT%H:%M:%S")
        self.db.add(models.TimePunch(id=f"p-{em}-{kind}-{hhmm}", employee_email=em, kind=kind, at=at,
                                     local_date=DAY, tz_offset_min=OFFSET, created_at=at))
        self.db.commit()

    def _scan(self, hhmm):
        return mw.meal_scan(self.db, _utc(hhmm))

    def _bells(self, to):
        self.db.expire_all()
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == to,
                        models.NexusNotification.ref_id.like(f"{mw.PREFIX}%")).all())

    def _setting(self, n):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps({"mealReminderMin": n})))
        self.db.commit()

    def test_nothing_before_four_and_a_half_hours(self):
        self._punch(AMY, "in", "08:00")
        self.assertEqual(self._scan("12:29")["reminded"], 0)
        self.assertEqual(self._bells(AMY), [])

    def test_fires_once_at_four_and_a_half_hours_on_their_own_clock(self):
        self._punch(AMY, "in", "08:48")
        self.assertEqual(self._scan("13:18")["reminded"], 1)
        self.assertEqual(self._scan("13:19")["reminded"], 0)
        (bell,) = self._bells(AMY)
        self.assertEqual(bell.title, "Meal Break Reminder")
        self.assertEqual(bell.body, "You have worked 4 hr 30 min. Take your 30-minute meal break "
                                    "before 5 hours (by 1:48 PM).")
        self.assertEqual(bell.ref_id, f"{mw.PREFIX}{DAY}")

    def test_short_breaks_are_not_the_meal_and_push_the_deadline(self):
        self._punch(AMY, "in", "08:00")
        self._punch(AMY, "break_start", "10:00")
        self._punch(AMY, "break_end", "10:10")       # a 10-minute rest break
        self.assertEqual(self._scan("12:39")["reminded"], 0)   # 4 h 29 min of work
        self.assertEqual(self._scan("12:40")["reminded"], 1)
        (bell,) = self._bells(AMY)
        self.assertIn("by 1:10 PM", bell.body)

    def test_not_while_on_break_or_clocked_out(self):
        self._punch(AMY, "in", "08:00")
        self._punch(AMY, "break_start", "12:20")
        self.assertEqual(self._scan("12:35")["reminded"], 0)
        self._punch(SAL, "in", "08:00")
        self._punch(SAL, "out", "12:25")
        self.assertEqual(self._scan("12:40")["reminded"], 0)
        self.assertEqual(self._bells(AMY) + self._bells(SAL), [])

    def test_not_after_a_meal_already_taken(self):
        self._punch(AMY, "in", "08:00")
        self._punch(AMY, "break_start", "11:00")
        self._punch(AMY, "break_end", "11:30")
        self.assertEqual(self._scan("13:30")["reminded"], 0)    # 5 h worked, the meal was on time
        # A clock-out and back in of 30+ minutes counts too.
        self._punch(SAL, "in", "07:00")
        self._punch(SAL, "out", "10:00")
        self._punch(SAL, "in", "10:45")
        self.assertEqual(self._scan("12:30")["reminded"], 0)

    def test_not_once_five_hours_have_passed(self):
        self._punch(AMY, "in", "08:00")
        self.assertEqual(self._scan("13:00")["reminded"], 0)

    def test_california_only_salaried_included_exempt_excluded(self):
        for em in (AMY, SAL, CARA, TEX, RAJ):
            self._punch(em, "in", "08:00")
        s = self._scan("12:30")
        self.assertEqual((s["working"], s["reminded"]), (5, 2))
        self.assertEqual(len(self._bells(AMY)), 1)
        self.assertEqual(len(self._bells(SAL)), 1)     # salaried with time tracking
        for em in (CARA, TEX, RAJ):
            self.assertEqual(self._bells(em), [])

    def test_inactive_people_are_skipped(self):
        self.db.query(models.NexusEmployee).filter_by(work_email=AMY).update({"status": "terminated"})
        self.db.commit()
        self._punch(AMY, "in", "08:00")
        self.assertEqual(self._scan("12:30")["reminded"], 0)

    def test_zero_turns_it_off_for_the_company(self):
        self._setting(0)
        self._punch(AMY, "in", "08:00")
        self.assertEqual(self._scan("12:45")["reminded"], 0)

    def test_a_company_threshold(self):
        self._setting(240)
        self._punch(AMY, "in", "08:00")
        self.assertEqual(self._scan("11:59")["reminded"], 0)
        self.assertEqual(self._scan("12:00")["reminded"], 1)
        self.assertIn("You have worked 4 hr.", self._bells(AMY)[0].body)

    def test_settings_default_and_clamp(self):
        from routers.shift_requests import get_settings
        self.assertEqual(get_settings(self.db)["mealReminderMin"], 270)
        self.assertEqual(mw.remind_min({"mealReminderMin": 900}), 295)
        self.assertEqual(mw.remind_min({}), 270)


if __name__ == "__main__":
    unittest.main()
