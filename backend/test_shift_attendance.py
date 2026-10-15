"""
Shifts Phase 1 - the schedule meets the clock (Oct 14 2026): shift_attendance.py.

  - The no-show scan fires at start + grace + noShowAlertMin on the shift's
    own zone clock and not a minute before; a clock-in before then prevents
    it; approved time off, a company holiday, a weather-cancelled day, a
    removal waiting to be published and a time-tracking exemption never
    alert; the company switch (0) turns it off.
  - Recipients are the manager and the group's schedulers, never the
    person; the company's HR contact only when there is nobody else.
  - One bell per recipient per team-day, refreshed in place as a second
    person misses their start; one email per recipient per team-day; the
    bell closes ("All In") when they clock in, "Missed Shift" when the
    window passes with someone still out.
  - Actuals: every status, the totals, and the route's scope and range rules.

Clock is passed in; email is stood in. Throwaway sqlite.
Run with: python -m unittest test_shift_attendance -v
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
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient   # noqa: E402

import auth               # noqa: E402
import cache              # noqa: E402
import database           # noqa: E402
import main               # noqa: E402
import models             # noqa: E402
import shift_attendance as sa   # noqa: E402
from routers import shift_requests  # noqa: E402

ENT, GROUP, PRESET = "ent-sa", "grp-sa", "preset-sa"
MGR = "sa.mgr@greensglobal.com"      # Amy's and Bob's manager
SCHED = "sa.sched@greensglobal.com"  # the group's scheduler
HR = "sa.hr@greensglobal.com"        # the company's HR contact
AMY = "sa.amy@greensglobal.com"
BOB = "sa.bob@greensglobal.com"
CARA = "sa.cara@greensglobal.com"    # exempt from time tracking
STAFF = "sa.staff@greensglobal.com"  # a group scheduler without a manager role
TZ = "America/Chicago"               # CDT in October: UTC-5
DAY = "2026-10-15"                   # Thursday
# Amy's 7:00 AM shift, preset grace 5, noShowAlertMin 10: the alert line is 7:15 AM CDT.
LINE = datetime(2026, 10, 15, 12, 15, tzinfo=timezone.utc)
REF = f"noshow:{GROUP}:{DAY}"


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusRole, models.NexusEmployee, models.ShiftGroup, models.ShiftGroupMember, models.HrEntity,
                  models.Shift, models.ShiftAssignment, models.ScheduledShift, models.NexusNotification,
                  models.NexusSetting, models.TimePunch, models.TimeOffRequest, models.HrCompanyHoliday,
                  models.NexusGroup, models.NexusGroupMember, models.ShiftNoShowAlert):
            self.db.query(m).delete()
        for em, first, mgr in ((MGR, "Mia", ""), (SCHED, "Sol", ""), (HR, "Hal", ""), (AMY, "Amy", MGR),
                               (BOB, "Bob", MGR), (CARA, "Cara", MGR), (STAFF, "Stu", "")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee" if em == AMY else "X",
                                             work_email=em, manager_email=mgr, status="active", deleted_at="",
                                             company=ENT, country="US"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens", hr_contact_email=HR))
        self.db.add(models.ShiftGroup(id=GROUP, name="Austin Crew", scheduler_emails=json.dumps([SCHED]),
                                      company_id=ENT, created_by=MGR))
        for em in (AMY, BOB, CARA):
            self.db.add(models.ShiftGroupMember(id=f"m-{em}", group_id=GROUP, employee_email=em))
        self.db.add(models.Shift(id=PRESET, name="Day", code="D", start_hhmm="07:00", end_hhmm="15:30",
                                 grace_min=5, timezone=TZ, days="1,2,3,4,5"))
        self.db.add(models.NexusGroup(id="g-exempt", name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-exempt", email=CARA))
        self.db.commit()
        self.mail = mock.patch.object(sa, "_send_email", return_value=True)
        self.mail.start()
        self.addCleanup(self.mail.stop)
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    # ── fixtures ────────────────────────────────────────────────────────
    def _shift(self, email, start="07:00", end="15:30", day=DAY, group=GROUP, **kw):
        sid = kw.pop("id", f"s-{email}-{day}-{start}")
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=start,
                                          end_hhmm=end, published=kw.pop("published", 1), group_id=group,
                                          shift_id=kw.pop("shift_id", PRESET), timezone=kw.pop("tz", TZ),
                                          created_by=MGR, **kw))
        self.db.commit()
        return sid

    def _punch(self, email, kind, at: datetime, local_date=None):
        self.db.add(models.TimePunch(id=f"p-{email}-{kind}-{_stamp(at)}", employee_email=email, kind=kind,
                                     at=_stamp(at), local_date=local_date or at.astimezone(sa.shift_expect.zone(TZ)).strftime("%Y-%m-%d"),
                                     created_at=_stamp(at)))
        self.db.commit()

    def _company_setting(self, **cfg):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps(cfg)))
        self.db.commit()

    def _bells(self, em, ref=REF):
        self.db.expire_all()
        return (self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == em, models.NexusNotification.ref_id == ref).all())

    def _alerts(self):
        self.db.expire_all()
        return self.db.query(models.ShiftNoShowAlert).order_by(models.ShiftNoShowAlert.recipient).all()

    def _emailed(self):
        return sorted(c.args[0] for c in sa._send_email.call_args_list)


class NoShowScanTests(_Case):
    def test_fires_at_the_line_in_the_shifts_zone_and_not_a_minute_before(self):
        self._shift(AMY)
        s = sa.noshow_scan(self.db, LINE - timedelta(minutes=1))
        self.assertEqual((s["candidates"], s["noShows"], s["alerts"]), (1, 0, 0), s)
        self.assertEqual(self._bells(MGR), [])
        s = sa.noshow_scan(self.db, LINE)
        self.assertEqual((s["noShows"], s["alerts"], s["emails"]), (1, 2, 2), s)
        for em in (MGR, SCHED):
            bells = self._bells(em)
            self.assertEqual(len(bells), 1, em)
            b = bells[0]
            self.assertEqual((b.type, b.priority, b.company, b.actioned), ("custom_alert", 1, ENT, False))
            self.assertEqual(b.title, "Not In Yet: 1 On Austin Crew")
            self.assertEqual(b.body, "Amy Lee - scheduled 7:00 AM, 15 min late")
            self.assertEqual(json.loads(b.action), {"view": "shifts", "sub": f"schedule:{DAY}:{GROUP}"})
        self.assertEqual(self._bells(AMY), [], "never the person")
        self.assertEqual(self._emailed(), [MGR, SCHED])
        self.assertEqual(sa._send_email.call_args_list[0].args[1], f"Not in yet: 1 On Austin Crew ({_us(DAY)})")
        rows = self._alerts()
        self.assertEqual([(r.recipient, r.group_id, r.work_date) for r in rows],
                         [(MGR, GROUP, DAY), (SCHED, GROUP, DAY)])
        self.assertTrue(all(r.emailed_at and not r.resolved_at for r in rows))
        self.assertEqual(json.loads(rows[0].people_json)[0]["email"], AMY)
        # A minute later: the same bell, refreshed; no second email.
        s = sa.noshow_scan(self.db, LINE + timedelta(minutes=1))
        self.assertEqual((s["alerts"], s["updated"], s["emails"]), (0, 2, 0), s)
        self.assertEqual(len(self._bells(MGR)), 1)
        self.assertEqual(self._bells(MGR)[0].body, "Amy Lee - scheduled 7:00 AM, 16 min late")
        self.assertEqual(sa._send_email.call_count, 2)

    def test_a_clock_in_before_the_line_prevents_it(self):
        self._shift(AMY)
        self._punch(AMY, "in", LINE - timedelta(minutes=5))
        s = sa.noshow_scan(self.db, LINE)
        self.assertEqual((s["noShows"], s["alerts"]), (0, 0), s)
        self.assertEqual(self._bells(MGR), [])

    def test_excused_people_never_alert(self):
        self._shift(AMY)                                      # approved time off
        self.db.add(models.TimeOffRequest(id="to-1", employee_email=AMY, type="vacation", start_date=DAY,
                                          end_date=DAY, status="approved"))
        self._shift(BOB, weather_status="cancelled")          # the day was called off
        self._shift(CARA)                                     # exempt from time tracking
        self._shift(STAFF, pending_delete=1)                  # a removal waiting to be published
        self._shift(MGR, published=0)                         # a draft nobody has seen
        self.db.commit()
        s = sa.noshow_scan(self.db, LINE + timedelta(hours=1))
        self.assertEqual((s["noShows"], s["alerts"]), (0, 0), s)
        # A company holiday for the person's country.
        self.db.query(models.TimeOffRequest).delete()
        self.db.add(models.HrCompanyHoliday(id="h-1", company_id=ENT, date=DAY, name="Founders Day",
                                            source="public", country_code="US"))
        self.db.commit()
        s = sa.noshow_scan(self.db, LINE + timedelta(hours=1))
        self.assertEqual(s["noShows"], 0, s)
        # A pending (not approved) request does not excuse.
        self.db.query(models.HrCompanyHoliday).delete()
        self.db.add(models.TimeOffRequest(id="to-2", employee_email=AMY, type="vacation", start_date=DAY,
                                          end_date=DAY, status="pending"))
        self.db.commit()
        self.assertEqual(sa.noshow_scan(self.db, LINE + timedelta(hours=1))["noShows"], 1)

    def test_the_six_hour_window_closes_the_watch(self):
        self._shift(AMY)
        start = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(sa.noshow_scan(self.db, start + timedelta(hours=5, minutes=59))["noShows"], 1)
        self.assertEqual(sa.noshow_scan(self.db, start + timedelta(hours=6))["noShows"], 0)
        b = self._bells(MGR)[0]
        self.assertTrue(b.actioned)
        self.assertEqual(b.title, "Missed Shift: 1 On Austin Crew")
        self.assertEqual(b.body, "Amy Lee did not clock in")
        self.assertTrue(self._alerts()[0].resolved_at)

    def test_recipients_are_the_manager_and_schedulers_else_the_hr_contact(self):
        self._shift(AMY)
        sa.noshow_scan(self.db, LINE)
        self.assertEqual(sorted(r.recipient for r in self._alerts()), [MGR, SCHED])
        self.assertEqual(self._bells(HR), [], "HR is not told while someone else is")
        # Nobody on the group, no manager: the company's HR contact.
        for m in (models.NexusNotification, models.ShiftNoShowAlert):
            self.db.query(m).delete()
        g = self.db.query(models.ShiftGroup).first()
        g.scheduler_emails = ""
        amy = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == AMY).first()
        amy.manager_email = ""
        self.db.commit()
        sa.noshow_scan(self.db, LINE)
        self.assertEqual([r.recipient for r in self._alerts()], [HR])
        self.assertEqual(len(self._bells(HR)), 1)
        # A manager who is no longer an active person is skipped (then HR).
        for m in (models.NexusNotification, models.ShiftNoShowAlert):
            self.db.query(m).delete()
        amy.manager_email = MGR
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == MGR).first().status = "offboarded"
        self.db.commit()
        sa.noshow_scan(self.db, LINE)
        self.assertEqual([r.recipient for r in self._alerts()], [HR])

    def test_the_person_is_never_a_recipient_even_as_their_own_scheduler(self):
        g = self.db.query(models.ShiftGroup).first()
        g.scheduler_emails = json.dumps([AMY])
        self.db.commit()
        self._shift(AMY)
        sa.noshow_scan(self.db, LINE)
        self.assertEqual([r.recipient for r in self._alerts()], [MGR])
        self.assertEqual(self._bells(AMY), [])

    def test_a_second_missing_person_updates_the_same_bell(self):
        self._shift(AMY)
        self._shift(BOB, start="07:30")      # Bob's line is 7:45 AM
        sa.noshow_scan(self.db, LINE)
        self.assertEqual(self._bells(MGR)[0].title, "Not In Yet: 1 On Austin Crew")
        s = sa.noshow_scan(self.db, LINE + timedelta(minutes=30))
        self.assertEqual((s["noShows"], s["alerts"], s["updated"], s["emails"]), (2, 0, 2, 0), s)
        bells = self._bells(MGR)
        self.assertEqual(len(bells), 1, "one bell, two names")
        self.assertEqual(bells[0].title, "Not In Yet: 2 On Austin Crew")
        self.assertEqual(bells[0].body, "Amy Lee - scheduled 7:00 AM, 45 min late\nBob X - scheduled 7:30 AM, 15 min late")
        self.assertEqual(sa._send_email.call_count, 2, "one email per recipient per team-day")
        self.assertEqual(len(self._alerts()), 2)
        self.assertEqual([p["email"] for p in json.loads(self._alerts()[0].people_json)], [AMY, BOB])

    def test_the_bell_resolves_when_they_clock_in(self):
        self._shift(AMY)
        self._shift(BOB, start="07:30")
        sa.noshow_scan(self.db, LINE + timedelta(minutes=30))
        self._punch(AMY, "in", datetime(2026, 10, 15, 12, 50, tzinfo=timezone.utc))   # 7:50 AM, 50 min late
        s = sa.noshow_scan(self.db, LINE + timedelta(minutes=36))
        self.assertEqual((s["noShows"], s["resolved"]), (1, 0), "Bob is still out - the bell stays open")
        self.assertEqual(self._bells(MGR)[0].body, "Bob X - scheduled 7:30 AM, 21 min late")
        self._punch(BOB, "in", datetime(2026, 10, 15, 12, 52, tzinfo=timezone.utc))
        s = sa.noshow_scan(self.db, LINE + timedelta(minutes=38))
        self.assertEqual((s["noShows"], s["resolved"]), (0, 2), s)
        for em in (MGR, SCHED):
            bells = self._bells(em)
            self.assertEqual(len(bells), 1, em)
            self.assertTrue(bells[0].actioned)
            self.assertEqual(bells[0].priority, 0)
            self.assertEqual(bells[0].title, "All In: Austin Crew")
            self.assertEqual(bells[0].body, "Amy Lee came in at 7:50 AM, 50 min late\nBob X came in at 7:52 AM, 22 min late")
        self.assertTrue(all(r.resolved_at for r in self._alerts()))
        # The next tick is quiet: nothing reopens, nothing is re-sent.
        s = sa.noshow_scan(self.db, LINE + timedelta(minutes=40))
        self.assertEqual((s["alerts"], s["resolved"], s["emails"]), (0, 0, 0))
        self.assertEqual(len(self._bells(MGR)), 1)
        self.assertEqual(sa._send_email.call_count, 2)

    def test_a_shift_with_no_group_is_its_own_bell(self):
        self._shift(AMY, group="")
        sa.noshow_scan(self.db, LINE)
        bells = self._bells(MGR, f"noshow:-:{DAY}")
        self.assertEqual(len(bells), 1)
        self.assertEqual(bells[0].title, "Not In Yet: Amy Lee")
        self.assertEqual(json.loads(bells[0].action), {"view": "shifts", "sub": f"schedule:{DAY}:"})
        self.assertEqual(self._bells(SCHED, f"noshow:-:{DAY}"), [], "no group, no schedulers")

    def test_the_company_switch_turns_it_off(self):
        self._shift(AMY)
        self._company_setting(noShowAlertMin=0)
        s = sa.noshow_scan(self.db, LINE + timedelta(hours=1))
        self.assertEqual((s["candidates"], s["noShows"], s["alerts"]), (1, 0, 0), s)
        self.assertEqual(self._bells(MGR), [])
        # A longer setting moves the line.
        self.db.query(models.NexusSetting).delete()
        self.db.commit()
        self._company_setting(noShowAlertMin=30)
        self.assertEqual(sa.noshow_scan(self.db, LINE + timedelta(minutes=19))["noShows"], 0)
        self.assertEqual(sa.noshow_scan(self.db, LINE + timedelta(minutes=20))["noShows"], 1)

    def test_two_shifts_in_a_day_are_judged_once_on_the_earliest_start(self):
        # Amy: 7:00 on Austin Crew and 1:00 PM on a second group, both missed.
        self.db.add(models.ShiftGroup(id="grp-2", name="Night Crew", scheduler_emails="[]", company_id=ENT, created_by=MGR))
        self.db.commit()
        self._shift(AMY)
        self._shift(AMY, start="13:00", end="17:00", group="grp-2")
        s = sa.noshow_scan(self.db, LINE)
        self.assertEqual((s["noShows"], s["alerts"]), (1, 2), s)
        self.assertEqual(len(self._bells(MGR)), 1)
        self.assertEqual(self._bells(MGR, f"noshow:grp-2:{DAY}"), [], "one judgment per person and day: the earliest start, its group")
        # 1:15 PM, still never in: the morning's watch has passed its window
        # and the afternoon shift is not a second alert - one person, one day.
        s = sa.noshow_scan(self.db, datetime(2026, 10, 15, 18, 15, tzinfo=timezone.utc))
        self.assertEqual((s["noShows"], s["alerts"], s["resolved"]), (0, 0, 2), s)
        self.assertEqual(self._bells(MGR)[0].title, "Missed Shift: 1 On Austin Crew")
        self.assertEqual(self._bells(MGR, f"noshow:grp-2:{DAY}"), [])
        self.assertEqual(len(self._alerts()), 2)

    def test_a_group_day_that_fills_again_reopens_its_record_and_is_not_emailed_twice(self):
        self._shift(AMY)                          # 7:00
        self._shift(BOB, start="13:00", end="17:00")   # 1:00 PM, same crew
        sa.noshow_scan(self.db, LINE)
        self._punch(AMY, "in", datetime(2026, 10, 15, 12, 20, tzinfo=timezone.utc))
        s = sa.noshow_scan(self.db, LINE + timedelta(minutes=6))
        self.assertEqual(s["resolved"], 2, s)
        self.assertTrue(self._bells(MGR)[0].actioned)
        self.assertEqual(self._bells(MGR)[0].title, "All In: Austin Crew")
        # 1:15 PM: Bob is out. The same row reopens, a new bell is raised, no second email.
        s = sa.noshow_scan(self.db, datetime(2026, 10, 15, 18, 15, tzinfo=timezone.utc))
        self.assertEqual((s["noShows"], s["alerts"], s["reopened"], s["emails"]), (1, 0, 2, 0), s)
        rows = self._alerts()
        self.assertEqual(len(rows), 2, "one record per recipient per group-day, reopened")
        self.assertTrue(all(not r.resolved_at and r.emailed_at for r in rows))
        self.assertEqual([p["email"] for p in json.loads(rows[0].people_json)], [AMY, BOB], "the day's whole story")
        bells = self._bells(MGR)
        self.assertEqual(len(bells), 2)
        live = [b for b in bells if not b.actioned]
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0].title, "Not In Yet: 1 On Austin Crew")
        self.assertEqual(live[0].body, "Bob X - scheduled 1:00 PM, 15 min late")
        self.assertEqual(sa._send_email.call_count, 2)
        # Bob comes in: closed again, with both names in the story.
        self._punch(BOB, "in", datetime(2026, 10, 15, 18, 20, tzinfo=timezone.utc))
        s = sa.noshow_scan(self.db, datetime(2026, 10, 15, 18, 21, tzinfo=timezone.utc))
        self.assertEqual(s["resolved"], 2, s)
        live = [b for b in self._bells(MGR) if not b.actioned]
        self.assertEqual(live, [])
        self.assertTrue(all(r.resolved_at for r in self._alerts()))
        self.assertEqual(sa._send_email.call_count, 2)

    def test_the_bell_stays_read_while_only_the_minutes_move(self):
        self._shift(AMY)
        self._shift(BOB, start="07:30")
        sa.noshow_scan(self.db, LINE)
        b = self._bells(MGR)[0]
        b.read_by, b.closed_by = MGR, MGR
        self.db.commit()
        sa.noshow_scan(self.db, LINE + timedelta(minutes=1))
        b = self._bells(MGR)[0]
        self.assertEqual((b.read_by, b.closed_by), (MGR, MGR), "a minute more late is not news")
        self.assertEqual(b.body, "Amy Lee - scheduled 7:00 AM, 16 min late")
        sa.noshow_scan(self.db, LINE + timedelta(minutes=30))   # Bob joins
        b = self._bells(MGR)[0]
        self.assertEqual((b.read_by, b.closed_by), ("", ""), "a new name is")
        self.assertEqual(b.title, "Not In Yet: 2 On Austin Crew")

    def test_every_load_is_bound_to_the_days_people(self):
        self._shift(AMY)
        self.db.add(models.NexusEmployee(id="emp-stranger", first_name="Sam", last_name="Far", work_email="sa.far@greensglobal.com",
                                         manager_email="", status="active", deleted_at="", company="ent-other", country="US"))
        self.db.commit()
        with mock.patch.object(sa, "_people", wraps=sa._people) as people:
            sa.noshow_scan(self.db, LINE)
        self.assertTrue(people.call_count >= 1)
        for c in people.call_args_list:
            self.assertIsNotNone(c.args[1] if len(c.args) > 1 else c.kwargs.get("emails"), "never the whole People table")
        loaded = set()
        for c in people.call_args_list:
            loaded |= set(c.args[1] if len(c.args) > 1 else c.kwargs.get("emails"))
        self.assertIn(AMY, loaded)
        self.assertIn(MGR, loaded, "the recipients are loaded, bounded")
        self.assertNotIn("sa.far@greensglobal.com", loaded)
        # An idle tick (nothing scheduled, nothing open) reads no people at all.
        self.db.query(models.ScheduledShift).delete()
        self.db.query(models.ShiftNoShowAlert).delete()
        self.db.commit()
        with mock.patch.object(sa, "_people", wraps=sa._people) as people:
            self.assertEqual(sa.noshow_scan(self.db, LINE)["candidates"], 0)
        self.assertEqual(people.call_count, 0)

    def test_the_settings_keys_are_clamped_and_saved(self):
        self.assertEqual((shift_requests._DEFAULTS["noShowAlertMin"], shift_requests._DEFAULTS["leftEarlyMin"]), (10, 15))
        self.assertEqual(shift_requests._clean_value("noShowAlertMin", 999), 240)
        self.assertEqual(shift_requests._clean_value("leftEarlyMin", -4), 0)
        self.assertEqual(shift_requests._clean_value("noShowAlertMin", "x"), None)
        self._company_setting(noShowAlertMin=20, leftEarlyMin=5)
        cfg = shift_requests.get_settings(self.db, ENT)
        self.assertEqual((cfg["noShowAlertMin"], cfg["leftEarlyMin"]), (20, 5))
        self.assertEqual(shift_requests.get_settings(self.db)["noShowAlertMin"], 10, "the tenant row is untouched")

    def test_an_email_failure_never_stops_the_scan(self):
        sa._send_email.side_effect = RuntimeError("graph down")
        self._shift(AMY)
        with mock.patch("graph_mail.send_mail", side_effect=RuntimeError("graph down")), \
                mock.patch("graph_mail.graph_configured", return_value=True):
            self.mail.stop()
            try:
                s = sa.noshow_scan(self.db, LINE)
            finally:
                self.mail.start()
        self.assertEqual((s["alerts"], s["emails"]), (2, 0), s)
        self.assertEqual(len(self._bells(MGR)), 1, "the bell is there whatever the mail did")
        self.assertTrue(self._alerts()[0].emailed_at, "not retried - one attempt per recipient per team-day")


def _us(iso: str) -> str:
    return datetime.strptime(iso, "%Y-%m-%d").strftime("%m/%d/%Y")


# Actuals: a week around Thursday 10/15/2026, the clock at 1:00 PM CDT that day.
NOW = datetime(2026, 10, 15, 18, 0, tzinfo=timezone.utc)
MON, TUE, WED, THU, FRI = "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"


def _utc(day: str, hh: int, mm: int = 0) -> datetime:
    return datetime.fromisoformat(day).replace(hour=hh, minute=mm, tzinfo=timezone.utc)


class ActualsTests(_Case):
    def _week(self):
        # Shifts are 7:00 AM - 3:30 PM CDT = 12:00 - 20:30 UTC, 510 paid minutes.
        self._shift(AMY, day=MON)                                           # holiday -> excused
        self.db.add(models.HrCompanyHoliday(id="h-mon", company_id=ENT, date=MON, name="Founders Day",
                                            source="manual", country_code=""))
        self._shift(AMY, day=TUE)                                           # on time
        self._punch(AMY, "in", _utc(TUE, 11, 58))
        self._punch(AMY, "out", _utc(TUE, 20, 35))
        self._shift(BOB, day=TUE)                                           # late (grace 5)
        self._punch(BOB, "in", _utc(TUE, 12, 20))
        self._punch(BOB, "out", _utc(TUE, 20, 30))
        self._shift(CARA, day=TUE)                                          # exempt
        self._shift(AMY, day=WED)                                           # left early (90 min)
        self._punch(AMY, "in", _utc(WED, 12, 0))
        self._punch(AMY, "out", _utc(WED, 19, 0))
        self._shift(BOB, day=WED)                                           # no show
        self._shift(AMY, day=THU)                                           # in progress (open punch)
        self._punch(AMY, "in", _utc(THU, 12, 0))
        self._shift(BOB, day=THU)                                           # approved time off
        self.db.add(models.TimeOffRequest(id="to-thu", employee_email=BOB, type="sick", start_date=THU,
                                          end_date=THU, status="approved"))
        self._shift(AMY, day=FRI)                                           # upcoming
        self._shift(BOB, day=FRI, weather_status="cancelled")               # called off
        self._shift(BOB, day=MON, pending_delete=1)                         # not on the schedule
        self._shift(BOB, day=MON, start="13:00", published=0)               # a draft
        self.db.commit()

    def test_every_status_and_the_totals(self):
        self._week()
        out = sa.actuals(self.db, [AMY, BOB, CARA], MON, FRI, NOW)
        cells = out["cells"]
        got = {k: (c["status"], c["excuse"], c["lateMin"], c["earlyMin"], c["workedMin"]) for k, c in cells.items()}
        self.assertEqual(got, {
            f"{AMY}|{MON}": ("excused", "holiday", 0, 0, 0),
            f"{AMY}|{TUE}": ("on_time", "", 0, 0, 517),
            f"{BOB}|{TUE}": ("late", "", 20, 0, 490),
            f"{CARA}|{TUE}": ("exempt", "", 0, 0, 0),
            f"{AMY}|{WED}": ("left_early", "", 0, 90, 420),
            f"{BOB}|{WED}": ("no_show", "", 0, 0, 0),
            f"{AMY}|{THU}": ("in_progress", "", 0, 0, 0),
            f"{BOB}|{THU}": ("excused", "time_off", 0, 0, 0),
            f"{AMY}|{FRI}": ("upcoming", "", 0, 0, 0),
            f"{BOB}|{FRI}": ("excused", "weather", 0, 0, 0),
        })
        self.assertNotIn(f"{BOB}|{MON}", cells, "a pending removal and a draft are not on the schedule")
        c = cells[f"{AMY}|{TUE}"]
        self.assertEqual((c["shiftId"], c["shifts"], c["scheduledMin"], c["firstIn"], c["lastOut"]),
                         (f"s-{AMY}-{TUE}-07:00", 1, 510, "2026-10-13T11:58:00", "2026-10-13T20:35:00"))
        self.assertEqual(cells[f"{BOB}|{FRI}"]["scheduledMin"], 0, "a cancelled day has no paid minutes")
        self.assertEqual(cells[f"{AMY}|{THU}"]["firstIn"], "2026-10-15T12:00:00")
        # Totals: past and in-progress days only.
        self.assertEqual(out["totals"], {"scheduledMin": 2550, "workedMin": 1427, "late": 1, "noShow": 1,
                                         "leftEarly": 1, "onTime": 1, "judged": 4})
        self.assertEqual(out["people"][AMY], {"scheduledMin": 1530, "workedMin": 937, "late": 0, "noShow": 0,
                                              "leftEarly": 1, "onTime": 1, "judged": 2})
        self.assertEqual(out["people"][BOB], {"scheduledMin": 1020, "workedMin": 490, "late": 1, "noShow": 1,
                                              "leftEarly": 0, "onTime": 0, "judged": 2})
        self.assertEqual(out["people"][CARA], sa._empty_totals())
        self.assertNotIn("pay", json.dumps(out).lower())

    def test_today_before_the_line_is_upcoming_then_in_progress_then_no_show(self):
        self._shift(AMY, day=THU)
        key = f"{AMY}|{THU}"
        self.assertEqual(sa.actuals(self.db, [AMY], THU, THU, _utc(THU, 11, 0))["cells"][key]["status"], "upcoming")
        self.assertEqual(sa.actuals(self.db, [AMY], THU, THU, _utc(THU, 12, 5))["cells"][key]["status"], "in_progress")
        self.assertEqual(sa.actuals(self.db, [AMY], THU, THU, _utc(THU, 12, 15))["cells"][key]["status"], "no_show")
        # A clock-in inside the grace is on time once the shift ends; late reads late while it runs.
        self._punch(AMY, "in", _utc(THU, 12, 4))
        out = sa.actuals(self.db, [AMY], THU, THU, _utc(THU, 13, 0))
        self.assertEqual((out["cells"][key]["status"], out["cells"][key]["lateMin"]), ("in_progress", 0))
        self._punch(AMY, "out", _utc(THU, 20, 31))
        out = sa.actuals(self.db, [AMY], THU, THU, _utc(THU, 21, 0))
        self.assertEqual((out["cells"][key]["status"], out["cells"][key]["workedMin"]), ("on_time", 507))
        self.assertEqual(out["totals"]["onTime"], 1)

    def test_left_early_uses_the_companys_setting(self):
        self._shift(AMY, day=TUE)
        self._punch(AMY, "in", _utc(TUE, 12, 0))
        self._punch(AMY, "out", _utc(TUE, 20, 20))      # 10 minutes early
        self.assertEqual(sa.actuals(self.db, [AMY], TUE, TUE, NOW)["cells"][f"{AMY}|{TUE}"]["status"], "on_time")
        self._company_setting(leftEarlyMin=5)
        c = sa.actuals(self.db, [AMY], TUE, TUE, NOW)["cells"][f"{AMY}|{TUE}"]
        self.assertEqual((c["status"], c["earlyMin"]), ("left_early", 10))

    def test_two_shifts_in_a_day_are_one_cell(self):
        self._shift(AMY, day=TUE, start="13:00", end="17:00")
        self._shift(AMY, day=TUE, start="07:00", end="11:00")
        self._punch(AMY, "in", _utc(TUE, 12, 30))   # 30 min after the earlier start
        self._punch(AMY, "out", _utc(TUE, 22, 0))
        c = sa.actuals(self.db, [AMY], TUE, TUE, NOW)["cells"][f"{AMY}|{TUE}"]
        self.assertEqual((c["shifts"], c["shiftId"], c["scheduledMin"], c["status"], c["lateMin"], c["earlyMin"]),
                         (2, f"s-{AMY}-{TUE}-07:00", 480, "late", 30, 0))

    def test_each_cell_carries_the_shifts_zone(self):
        self._shift(AMY, day=TUE)                                    # the placement's own zone
        self._shift(BOB, day=TUE, tz="", shift_id="")                # no zone, no preset: the company's
        self._shift(CARA, day=TUE, tz="", shift_id=PRESET)           # the preset's
        self._company_setting(timeZone="Asia/Kolkata")
        cells = sa.actuals(self.db, [AMY, BOB, CARA], TUE, TUE, NOW)["cells"]
        self.assertEqual(cells[f"{AMY}|{TUE}"]["tz"], TZ)
        self.assertEqual(cells[f"{BOB}|{TUE}"]["tz"], "Asia/Kolkata")
        self.assertEqual(cells[f"{CARA}|{TUE}"]["tz"], TZ, "an exempt cell still says its zone")

    def test_a_shift_across_midnight_is_judged_by_its_own_end(self):
        # 10:00 PM Tuesday - 6:00 AM Wednesday CDT = 03:00 - 11:00 UTC Wednesday.
        self._shift(AMY, day=TUE, start="22:00", end="06:00")
        key = f"{AMY}|{TUE}"
        self._punch(AMY, "in", _utc(WED, 3, 2))
        # 3:00 AM Wednesday: the calendar date turned, the shift has not ended.
        c = sa.actuals(self.db, [AMY], TUE, TUE, _utc(WED, 8, 0))["cells"][key]
        self.assertEqual(c["status"], "in_progress")
        # Out at 5:30 AM, read at 7:00 AM: left 30 minutes early, not on time.
        self._punch(AMY, "out", _utc(WED, 10, 30))
        c = sa.actuals(self.db, [AMY], TUE, TUE, _utc(WED, 12, 0))["cells"][key]
        self.assertEqual((c["status"], c["earlyMin"], c["workedMin"]), ("left_early", 30, 448))
        # Amy's Wednesday day shift is its own day: last night's clock-out at
        # 5:30 AM is not a Wednesday clock-in, nor a Wednesday clock-out.
        self._shift(AMY, day=WED)
        c = sa.actuals(self.db, [AMY], WED, WED, _utc(WED, 12, 20))["cells"][f"{AMY}|{WED}"]
        self.assertEqual((c["status"], c["firstIn"], c["lastOut"], c["earlyMin"]), ("no_show", "", "", 0))
        # Nobody in by a few minutes past midnight for an 11:50 PM start: still
        # before the line, so in progress - never a no-show because the date turned.
        self._shift(BOB, day=TUE, start="23:50", end="04:00")
        c = sa.actuals(self.db, [BOB], TUE, TUE, _utc(WED, 5, 0))["cells"][f"{BOB}|{TUE}"]   # 12:00 AM CDT Wednesday
        self.assertEqual(c["status"], "in_progress")
        c = sa.actuals(self.db, [BOB], TUE, TUE, _utc(WED, 5, 6))["cells"][f"{BOB}|{TUE}"]   # 12:06 AM: grace 5 + alert 10 passed? no - 15 min line is 12:05
        self.assertEqual(c["status"], "no_show")

    def test_a_split_shifts_second_half_still_reads_running(self):
        self._shift(AMY, day=THU, start="07:00", end="11:00")
        self._shift(AMY, day=THU, start="13:00", end="17:00")
        self._punch(AMY, "in", _utc(THU, 12, 0))
        self._punch(AMY, "out", _utc(THU, 16, 0))
        self._punch(AMY, "in", _utc(THU, 18, 5))
        c = sa.actuals(self.db, [AMY], THU, THU, _utc(THU, 19, 0))["cells"][f"{AMY}|{THU}"]
        self.assertEqual(c["status"], "in_progress")
        # Yesterday's forgotten clock-out does not keep yesterday running once today is open.
        self._shift(BOB, day=WED)
        self._shift(BOB, day=THU)
        self._punch(BOB, "in", _utc(WED, 12, 0))
        self._punch(BOB, "in", _utc(THU, 12, 0))
        out = sa.actuals(self.db, [BOB], WED, THU, _utc(THU, 13, 0))["cells"]
        self.assertEqual(out[f"{BOB}|{WED}"]["status"], "on_time")
        self.assertEqual(out[f"{BOB}|{THU}"]["status"], "in_progress")

    def test_the_route_scopes_and_limits(self):
        self._week()
        self._shift(STAFF, day=TUE)
        g = self.db.query(models.ShiftGroup).first()
        g.scheduler_emails = json.dumps([SCHED, STAFF])
        self.db.commit()
        client = TestClient(main.app)
        skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        try:
            os.environ["NEXUS_DEV_EMAIL"] = MGR
            auth.invalidate_role_cache()
            r = client.get("/timeclock/schedule/actuals", params={"start": MON, "end": FRI})
            self.assertEqual(r.status_code, 200, r.text)
            emails = {k.split("|")[0] for k in r.json()["cells"]}
            self.assertEqual(emails, {AMY, BOB, CARA}, "a manager: their direct reports")
            self.assertEqual(set(r.json()) , {"cells", "people", "totals"})
            r = client.get("/timeclock/schedule/actuals", params={"start": MON, "end": "2027-01-12"})
            self.assertEqual(r.status_code, 400)
            self.assertIn("92 days", r.json()["detail"])
            r = client.get("/timeclock/schedule/actuals", params={"start": MON, "end": "2027-01-11"})
            self.assertEqual(r.status_code, 200, r.text)
            r = client.get("/timeclock/schedule/actuals", params={"start": FRI, "end": MON})
            self.assertEqual(r.status_code, 400)
            r = client.get("/timeclock/schedule/actuals", params={"start": "10/12/2026", "end": FRI})
            self.assertEqual(r.status_code, 400)
            # A group scheduler below manager gets their group's cells (what the
            # schedule read shows them) plus their own.
            os.environ["NEXUS_DEV_EMAIL"] = STAFF
            auth.invalidate_role_cache()
            r = client.get("/timeclock/schedule/actuals", params={"start": MON, "end": FRI})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual({k.split("|")[0] for k in r.json()["cells"]}, {AMY, BOB, CARA, STAFF})
            # An employee with no schedule access at all gets their own cells (My Shifts).
            os.environ["NEXUS_DEV_EMAIL"] = AMY
            auth.invalidate_role_cache()
            r = client.get("/timeclock/schedule/actuals", params={"start": MON, "end": FRI})
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual({k.split("|")[0] for k in r.json()["cells"]}, {AMY})
            self.assertEqual(r.json()["cells"][f"{AMY}|{TUE}"]["tz"], TZ, "the shift's zone rides on the cell")
        finally:
            auth.SKIP_AUTH = skip
            os.environ.pop("NEXUS_DEV_EMAIL", None)
            auth.invalidate_role_cache()


if __name__ == "__main__":
    unittest.main()
