"""
Workforce Scorecard (Neil, Oct 10 2026) - workforce_scorecard.py.

  - Expected hours: published shift > shift preset > country standard
    (US 8h, IN 9h, Mon-Fri) for full-time staff; part-time with no shift is
    "No Schedule". Holidays and approved time off excuse the day (half days
    halve it, partial-day requests subtract, Work From Home does not excuse).
  - Actuals: the payroll pairing; Sick / PTO punches are leave, not work;
    late against the shift start + grace; overnight shifts land on their
    start day; only days before the person's local today are scored.
  - Scope: a viewer grant is the manager's DIRECT reports (Neil: "only ...
    their direct reports by default"), Editor the whole reporting line,
    Full / admin everyone; exempt, offboarded, not-yet-started and (by
    default) salaried staff are left out.
  - The weekly email: off logs only, test goes to the test recipients, live
    mails each grant holder once per week at the send time in their zone.

The clock is frozen at Monday 10/12/2026 15:10 UTC (8:10 AM Pacific, 8:40 PM
India); the scored week is 10/05 - 10/11. Throwaway sqlite; send_mail mocked.

Run with: python -m unittest test_workforce_scorecard -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone, timedelta, date
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
import workforce_scorecard as sc                         # noqa: E402
import database                                          # noqa: E402
import models                                            # noqa: E402
from routers import workforce_scorecard as sc_router     # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

FIXED = datetime(2026, 10, 12, 15, 10, tzinfo=timezone.utc)   # Monday 8:10 AM Pacific
WS = date(2026, 10, 5)                                        # the scored week
MIA, AMY, RAJ, SAM, LEE, ZOE = (f"{n}@greensglobal.com" for n in ("mia", "amy", "raj", "sam", "lee", "zoe"))
US_OFF, IN_OFF = 420, -330      # JS getTimezoneOffset(): PDT, IST


class _FrozenDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED.astimezone(tz) if tz else FIXED.replace(tzinfo=None)


def _frozen_local_now(tz):
    return FIXED.astimezone(ZoneInfo(tz or "America/Los_Angeles")).replace(tzinfo=None)


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusWorkforceScorecardLog, models.NexusSetting, models.NexusEmployee, models.NexusRole,
                  models.NexusGroup, models.NexusGroupMember, models.HrEntity, models.HrCompanyHoliday,
                  models.Shift, models.ShiftAssignment, models.ScheduledShift, models.TimeOffRequest,
                  models.TimePunch, models.PayrollRate, models.AgentActivity):
            self.db.query(m).delete()
        self.db.commit()
        self.sent = []
        for p in (mock.patch.object(sc, "datetime", _FrozenDT),
                  mock.patch.object(daily_briefing, "datetime", _FrozenDT),
                  mock.patch.object(daily_briefing, "_shift_local_now", _frozen_local_now),
                  mock.patch.object(daily_briefing, "_logo_url", lambda db: ""),
                  mock.patch.object(sc.graph_mail, "send_mail", lambda **kw: self.sent.append(kw))):
            p.start()
            self.addCleanup(p.stop)
        import cache
        cache.module_grants.invalidate()
        self.db.add_all([models.HrEntity(id="gg-us", name="Greens US", country="US"),
                         models.HrEntity(id="gg-in", name="Greens India", country="IN")])
        self.db.commit()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    # ── fixtures ─────────────────────────────────────────────────────────
    def _emp(self, email, manager=MIA, company="gg-us", country="US", **kw):
        kw.setdefault("start_date", "2025-01-01")
        self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0].title(), last_name="",
                                         work_email=email, manager_email=manager, company=company,
                                         country=country, **kw))
        self.db.commit()

    def _team(self):
        """Mia (manager, viewer grant) with Amy (US), Raj (IN, country from the
        company), Sam (part-time, no shift) and Lee (salaried); Zoe reports elsewhere."""
        self._emp(MIA, manager="")
        self._emp(AMY)
        self._emp(RAJ, company="gg-in", country="")
        self._emp(SAM, employment_type="part_time")
        self._emp(LEE)
        self._emp(ZOE, manager="boss@greensglobal.com")
        self.db.add(models.PayrollRate(employee_email=LEE, pay_type="fixed", overtime_rule="ca"))
        self.db.add(models.PayrollRate(employee_email=RAJ, pay_type="hourly", overtime_rule="none"))
        self._grant(MIA, "viewer")
        self.db.add(models.NexusRole(email=MIA, role="manager"))
        self.db.commit()

    def _grant(self, email, level="viewer", gid=None):
        gid = gid or gen_id()
        self.db.add(models.NexusGroup(id=gid, name=f"grant-{level}", allowed_modules=f"tasks:viewer,{sc.MODULE_ID}:{level}"))
        self.db.add(models.NexusGroupMember(group_id=gid, email=email))
        self.db.commit()

    def _punch(self, email, kind, local, off, category=""):
        at = datetime.strptime(local, "%Y-%m-%d %H:%M") + timedelta(minutes=off)
        self.db.add(models.TimePunch(id=gen_id(), employee_email=email, kind=kind, at=at.strftime("%Y-%m-%dT%H:%M:%S"),
                                     local_date=local[:10], tz_offset_min=off, category=category, source="web"))
        self.db.commit()

    def _work(self, email, day, start, end, off=US_OFF, category=""):
        self._punch(email, "in", f"{day} {start}", off, category)
        self._punch(email, "out", f"{day} {end}", off)

    def _week_us(self, email, start="09:00", end="17:00", days=range(5)):
        for i in days:
            self._work(email, (WS + timedelta(days=i)).isoformat(), start, end)

    def _preset(self, email, start="09:00", end="18:00", days="1,2,3,4,5", tz="America/Los_Angeles", break_min=60, grace=10):
        sid = gen_id()
        self.db.add(models.Shift(id=sid, name="P", start_hhmm=start, end_hhmm=end, days=days, timezone=tz,
                                 break_min=break_min, grace_min=grace))
        self.db.add(models.ShiftAssignment(id=gen_id(), employee_email=email, shift_id=sid))
        self.db.commit()
        return sid

    def _off(self, email, start, end, type="vacation", status="approved", **kw):
        self.db.add(models.TimeOffRequest(id=gen_id(), employee_email=email, type=type, start_date=start,
                                          end_date=end, status=status, **kw))
        self.db.commit()

    def _config(self, **kw):
        cfg = {"mode": "live"}
        cfg.update(kw)
        sc.save_settings(self.db, cfg, "admin@greensglobal.com")

    def _report(self, scope=None, ws=WS, **cfg):
        c = sc.get_settings(self.db)
        c.update(cfg)
        return sc.build_report(self.db, scope, c, ws)

    def _row(self, email, **kw):
        rows = [r for r in self._report(**kw)["people"] if r["email"] == email]
        self.assertEqual(len(rows), 1, f"{email} should be on the scorecard once")
        return rows[0]

    def _day(self, row, i):
        return row["days"][i]

    def _logs(self, email=MIA):
        self.db.expire_all()
        return (self.db.query(models.NexusWorkforceScorecardLog)
                .filter(models.NexusWorkforceScorecardLog.manager_email == email).all())


class DefaultsTests(_Case):
    def test_defaults(self):
        cfg = sc.get_settings(self.db)
        self.assertEqual(cfg["mode"], "off")
        self.assertEqual((cfg["sendDay"], cfg["sendTime"], cfg["weekStart"]), (1, "08:00", "monday"))
        self.assertEqual(cfg["standards"]["US"]["hours"], 8)
        self.assertEqual(cfg["standards"]["IN"]["hours"], 9)
        self.assertEqual(cfg["payTypes"], ["hourly"])

    def test_weeks(self):
        cfg = sc.get_settings(self.db)
        self.assertEqual(sc.week_start_for(date(2026, 10, 7), cfg), date(2026, 10, 5))
        self.assertEqual(sc.last_complete_week(date(2026, 10, 12), cfg), WS)
        self.assertEqual(sc.last_complete_week(date(2026, 10, 14), cfg), WS)
        self.assertEqual(sc.week_start_for(date(2026, 10, 7), {"weekStart": "sunday"}), date(2026, 10, 4))

    def test_validate(self):
        self.assertEqual(sc.validate({"belowPct": 60, "onTrackPct": 90}), {"belowPct": 60, "onTrackPct": 90})
        for bad in ({"mode": "loud"}, {"sendDay": 8}, {"sendTime": "8am"}, {"weekStart": "friday"},
                    {"payTypes": ["daily"]}, {"payTypes": []}, {"belowPct": 95, "onTrackPct": 90},
                    {"standards": {"US": {"hours": 8, "days": [1]}}},            # no default row
                    {"standards": {"default": {"hours": 30, "days": [1]}}},
                    {"standards": {"default": {"hours": 8, "days": [0]}}},
                    {"defaultTimeZone": "Mars/Base"}):
            with self.assertRaises(ValueError, msg=bad):
                sc.validate(bad)
        out = sc.validate({"standards": {"default": {"hours": 8, "days": [5, 1]}, "in": {"hours": 9.5, "days": [1, 2, 3, 4, 5, 6]}}})
        self.assertEqual(out["standards"]["IN"], {"hours": 9.5, "days": [1, 2, 3, 4, 5, 6]})
        self.assertEqual(out["standards"]["default"]["days"], [1, 5])


class ExpectationTests(_Case):
    def setUp(self):
        super().setUp()
        self._team()

    def test_country_standard_8h_us_9h_india_weekdays_only(self):
        amy, raj = self._row(AMY), self._row(RAJ)
        self.assertEqual([d["expectedMin"] for d in amy["days"]], [480] * 5 + [0, 0])
        self.assertEqual([d["expectedMin"] for d in raj["days"]], [540] * 5 + [0, 0])
        self.assertEqual(self._day(amy, 5)["reasonLabel"], "Not scheduled")
        self.assertEqual(amy["days"][0]["source"], "standard")
        self.assertEqual(amy["expectedMin"], 2400)
        self.assertEqual(raj["country"], "")          # the company's country filled the gap

    def test_part_time_without_a_shift_is_no_schedule_not_absent(self):
        sam = self._row(SAM)
        self.assertEqual(sam["band"], "no_schedule")
        self.assertEqual(sam["expectedMin"], 0)
        self.assertTrue(all(d["reason"] == "no_schedule" for d in sam["days"]))

    def test_part_time_with_a_preset_is_scored(self):
        self._preset(SAM, "09:00", "13:00", days="1,3,5", break_min=0)
        sam = self._row(SAM)
        self.assertEqual([d["expectedMin"] for d in sam["days"]], [240, 0, 240, 0, 240, 0, 0])
        self.assertEqual(sam["band"], "absent")

    def test_preset_beats_the_standard(self):
        self._preset(AMY, "10:00", "19:00", days="1,2,3,4,5,6", break_min=60)
        amy = self._row(AMY)
        self.assertEqual([d["expectedMin"] for d in amy["days"]], [480] * 6 + [0])
        self.assertEqual((amy["days"][0]["source"], amy["days"][0]["shiftStart"]), ("preset", "10:00"))

    def test_published_shift_beats_the_preset_and_drafts_do_not(self):
        sid = self._preset(AMY)
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email=AMY, work_date="2026-10-06", shift_id=sid,
                                          start_hhmm="08:00", end_hhmm="12:30", break_min=30, published=1))
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email=AMY, work_date="2026-10-06",
                                          start_hhmm="14:00", end_hhmm="16:00", published=1))
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email=AMY, work_date="2026-10-07",
                                          start_hhmm="00:00", end_hhmm="23:00", published=0))
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email=AMY, work_date="2026-10-08",
                                          start_hhmm="00:00", end_hhmm="23:00", published=1, pending_delete=1))
        self.db.commit()
        amy = self._row(AMY)
        tue, wed, thu = amy["days"][1], amy["days"][2], amy["days"][3]
        self.assertEqual((tue["expectedMin"], tue["source"], tue["shiftStart"]), (240 + 120, "scheduled", "08:00"))
        self.assertEqual((wed["expectedMin"], wed["source"]), (480, "preset"))
        self.assertEqual((thu["expectedMin"], thu["source"]), (480, "preset"))

    def test_holidays_by_company_and_country(self):
        self.db.add(models.HrCompanyHoliday(id=gen_id(), company_id="gg-in", date="2026-10-06", name="Dussehra",
                                            source="public", country_code="IN", type="mandatory"))
        self.db.add(models.HrCompanyHoliday(id=gen_id(), company_id="gg-us", date="2026-10-07", name="Half",
                                            source="manual", country_code="", type="half_day"))
        self.db.add(models.HrCompanyHoliday(id=gen_id(), company_id="gg-us", date="2026-10-08", name="Optional",
                                            source="manual", country_code="", type="optional"))
        self.db.commit()
        amy, raj = self._row(AMY), self._row(RAJ)
        self.assertEqual((raj["days"][1]["expectedMin"], raj["days"][1]["reasonLabel"]), (0, "Holiday"))
        self.assertEqual(amy["days"][1]["expectedMin"], 480)        # the Indian holiday is not Amy's
        self.assertEqual((amy["days"][2]["expectedMin"], amy["days"][2]["reason"]), (240, "holiday_half"))
        self.assertEqual((amy["days"][3]["expectedMin"], amy["days"][3]["reason"]), (0, "holiday"))

    def test_time_off_rules(self):
        self._off(AMY, "2026-10-05", "2026-10-06")                                     # Mon-Tue off
        self._off(AMY, "2026-10-07", "2026-10-07", type="Work From Home")                # still expected
        self._off(AMY, "2026-10-08", "2026-10-08", type="personal", start_time="13:00", end_time="15:00")
        self._off(AMY, "2026-10-09", "2026-10-09", type="1/2 Day")
        self._off(RAJ, "2026-10-05", "2026-10-09", status="pending")                  # pending excuses nothing
        amy, raj = self._row(AMY), self._row(RAJ)
        self.assertEqual([d["expectedMin"] for d in amy["days"][:5]], [0, 0, 480, 360, 240])
        self.assertEqual([d["reason"] for d in amy["days"][:5]], ["time_off", "time_off", "", "time_off_partial", "time_off_half"])
        self.assertEqual(raj["expectedMin"], 2700)
        self.assertEqual(amy["band"], "absent")            # 1080 expected, nothing punched

    def test_not_started_yet(self):
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == AMY).update({"start_date": "2026-10-08"})
        self.db.commit()
        amy = self._row(AMY)
        self.assertEqual([d["expectedMin"] for d in amy["days"][:5]], [0, 0, 0, 480, 480])
        self.assertEqual(amy["days"][0]["reasonLabel"], "Not started yet")
        # Starting after the week ends = not on the scorecard at all.
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == AMY).update({"start_date": "2026-10-12"})
        self.db.commit()
        self.assertNotIn(AMY, [r["email"] for r in self._report()["people"]])


class ScoringTests(_Case):
    def setUp(self):
        super().setUp()
        self._team()

    def test_full_week_is_on_track(self):
        self._week_us(AMY)
        amy = self._row(AMY)
        self.assertEqual((amy["workedMin"], amy["expectedMin"], amy["score"], amy["band"]), (2400, 2400, 100, "on_track"))
        self.assertEqual((amy["daysFull"], amy["daysShort"], amy["daysAbsent"], amy["daysLate"]), (5, 0, 0, 0))
        self.assertEqual(amy["days"][0]["status"], "full")

    def test_short_days_respect_the_tolerance(self):
        self._week_us(AMY, end="16:50", days=[0])          # 10 min under: full
        self._week_us(AMY, end="16:00", days=[1])          # an hour under: short
        amy = self._row(AMY)
        self.assertEqual([d["status"] for d in amy["days"][:3]], ["full", "short", "absent"])
        self.assertEqual((amy["daysFull"], amy["daysShort"], amy["daysAbsent"]), (1, 1, 3))

    def test_absent_and_well_below_and_below(self):
        self.assertEqual(self._row(AMY)["band"], "absent")
        self._week_us(AMY, days=[0, 1])                    # 16 of 40h = 40%
        self.assertEqual((self._row(AMY)["score"], self._row(AMY)["band"]), (40, "well_below"))
        self._week_us(AMY, days=[2, 3])                    # 32 of 40h = 80%
        self.assertEqual((self._row(AMY)["score"], self._row(AMY)["band"]), (80, "below"))
        self.assertEqual(self._row(AMY, onTrackPct=80)["band"], "on_track")

    def test_sick_punches_are_leave_that_covers_the_day(self):
        self._week_us(AMY, days=[0, 1, 2, 3])
        self._work(AMY, "2026-10-09", "09:00", "17:00", category="Sick Day")
        amy = self._row(AMY)
        self.assertEqual((amy["workedMin"], amy["leaveMin"], amy["coveredMin"]), (1920, 480, 2400))
        self.assertEqual((amy["score"], amy["band"], amy["days"][4]["status"]), (100, "on_track", "full"))
        self.assertEqual((amy["days"][4]["workedMin"], amy["days"][4]["leaveMin"]), (0, 480))

    def test_late_against_the_shift_start_and_grace(self):
        self._preset(AMY, "09:00", "18:00", grace=10)
        self._work(AMY, "2026-10-05", "09:08", "18:00")    # inside grace
        self._work(AMY, "2026-10-06", "09:25", "18:00")    # late
        self._work(AMY, "2026-10-07", "09:25", "18:00", off=IN_OFF)  # 9:25 IST is not late on a Pacific shift
        amy = self._row(AMY)
        self.assertEqual([d["late"] for d in amy["days"][:3]], [False, True, False])
        self.assertEqual(amy["daysLate"], 1)
        # No shift time (country standard) = never late.
        self._work(RAJ, "2026-10-05", "13:00", "22:00", off=IN_OFF)
        self.assertFalse(self._row(RAJ)["days"][0]["late"])

    def test_overnight_india_shift_lands_on_its_start_day(self):
        self._punch(RAJ, "in", "2026-10-09 18:30", IN_OFF)
        self._punch(RAJ, "out", "2026-10-10 03:30", IN_OFF)
        raj = self._row(RAJ)
        self.assertEqual((raj["days"][4]["workedMin"], raj["days"][5]["workedMin"]), (540, 0))
        self.assertEqual(raj["days"][4]["status"], "full")
        self.assertEqual(raj["days"][5]["status"], "off")
        # A shift that started the day before the week is not this week's.
        self._punch(AMY, "in", "2026-10-04 22:00", US_OFF)
        self._punch(AMY, "out", "2026-10-05 06:00", US_OFF)
        self.assertEqual(self._row(AMY)["days"][0]["workedMin"], 0)

    def test_working_on_a_day_off_is_extra_not_penalized(self):
        self._work(AMY, "2026-10-10", "09:00", "13:00")     # Saturday
        amy = self._row(AMY)
        self.assertEqual((amy["days"][5]["status"], amy["daysExtra"], amy["workedMin"]), ("extra", 1, 240))
        # Hours on a day off count toward the WEEK (someone who swaps Friday for
        # Saturday is not absent), while the absent-day count keeps the story.
        self.assertEqual((amy["band"], amy["score"], amy["daysAbsent"]), ("well_below", 10, 5))

    def test_only_days_before_the_persons_local_today_are_scored(self):
        self._work(AMY, "2026-10-12", "07:00", "08:00")      # today, Pacific
        amy = self._row(AMY, ws=date(2026, 10, 12))
        self.assertEqual([d["status"] for d in amy["days"]], ["today"] + ["upcoming"] * 6)
        self.assertEqual((amy["expectedMin"], amy["score"], amy["band"]), (0, None, "not_expected"))
        # Raj in India is already on 10/13 (8:40 PM IST on the 12th... still the 12th) - a punch dates him.
        self._punch(RAJ, "in", "2026-10-12 09:00", IN_OFF)
        raj = self._row(RAJ, ws=date(2026, 10, 12))
        self.assertEqual(raj["days"][0]["status"], "today")

    def test_missing_clock_out_is_flagged_and_not_counted(self):
        self._punch(AMY, "in", "2026-10-05 09:00", US_OFF)
        self._work(AMY, "2026-10-06", "09:00", "17:00")
        amy = self._row(AMY)
        self.assertIn("missing_out", amy["days"][0]["flags"])
        self.assertEqual((amy["days"][0]["workedMin"], amy["missingPunches"]), (0, 1))

    def test_activity_percent_from_agent_samples(self):
        for day, pct in (("2026-10-05", 80), ("2026-10-06", 40)):
            self.db.add(models.AgentActivity(id=gen_id(), employee_email=AMY, local_date=day, at=f"{day}T17:00:00",
                                             app="Excel", seconds=3600, active_pct=pct))
        self.db.commit()
        self.assertEqual(self._row(AMY)["activePct"], 60)
        self.assertIsNone(self._row(RAJ)["activePct"])

    def test_report_orders_worst_first_and_counts(self):
        self._week_us(AMY)
        self._work(RAJ, "2026-10-05", "10:00", "19:00", off=IN_OFF)
        rep = self._report({AMY, RAJ, SAM, LEE})
        self.assertEqual([r["email"] for r in rep["people"]], [RAJ, AMY, SAM])   # well below, on track, no schedule
        self.assertEqual((rep["summary"]["people"], rep["summary"]["scored"], rep["summary"]["on_track"],
                          rep["summary"]["well_below"], rep["summary"]["no_schedule"]), (3, 2, 1, 1, 1))
        self.assertEqual(rep["people"][1]["managerName"], "Mia")


class ScopeTests(_Case):
    def setUp(self):
        super().setUp()
        self._team()

    def test_viewer_is_direct_reports_editor_the_line_full_or_admin_everyone(self):
        self._emp("kid@greensglobal.com", manager=AMY)       # Amy's report: in Mia's line, not a direct
        mia = {"email": MIA, "level": 3}
        self.assertEqual(sc.scope_for(self.db, mia), ({AMY, RAJ, SAM, LEE}, "direct"))
        self.assertEqual(sc.scope_for(self.db, {"email": "admin@greensglobal.com", "level": 4}), (None, "all"))
        self._grant(ZOE, "full")
        self.assertEqual(sc.scope_for(self.db, {"email": ZOE, "level": 1}), (None, "all"))
        self.assertEqual(sc.scope_for(self.db, {"email": "nobody@greensglobal.com", "level": 2}), (set(), "direct"))
        # Editor opens the whole line (the manager tier alone does not).
        self._grant(MIA, "editor")
        import cache
        cache.module_grants.invalidate(MIA)
        self.assertEqual(sc.scope_for(self.db, mia), ({AMY, RAJ, SAM, LEE, "kid@greensglobal.com"}, "line"))

    def test_roster_exclusions(self):
        emails = lambda scope=None, **cfg: [r["email"] for r in self._report(scope, **cfg)["people"]]  # noqa: E731
        self.assertEqual(emails({AMY, RAJ, SAM, LEE, ZOE}), [AMY, RAJ, ZOE, SAM])     # Lee is salaried; absent before no-schedule
        self.assertEqual(emails({AMY, RAJ, SAM, LEE}, payTypes=["hourly", "fixed"]), [AMY, LEE, RAJ, SAM])
        self.assertEqual(emails(set()), [])
        # Exempt role, offboarded, guest identity.
        gid = gen_id()
        self.db.add(models.NexusGroup(id=gid, name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id=gid, email=RAJ))
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == SAM).update({"status": "offboarded"})
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == ZOE).update({"identity_type": "guest"})
        self.db.commit()
        self.assertEqual(emails(), [AMY, MIA])

    def test_recipients_follow_grants_tier_and_company_list(self):
        self._grant(ZOE, "full")
        self._emp("ceo@greensglobal.com", manager="")
        self._config(companyRecipients=["ceo@greensglobal.com"])
        self._emp("kid@greensglobal.com", manager=AMY)
        got = {emp.work_email: (scope, kind) for emp, scope, kind in sc.recipients(self.db, sc.get_settings(self.db))}
        self.assertEqual(got[MIA], ({AMY, RAJ, SAM, LEE}, "direct"))     # not kid: direct reports by default
        self.assertEqual(got[ZOE], (None, "all"))
        self.assertEqual(got["ceo@greensglobal.com"], (None, "all"))
        self.assertNotIn(AMY, got)
        # An administrator with only a viewer grant still gets the company; an
        # Editor grant opens the manager's whole line.
        self.db.add(models.NexusRole(email=AMY, role="administrator"))
        self._grant(AMY, "viewer")
        self._grant(MIA, "editor")
        got = {e.work_email: (s, k) for e, s, k in sc.recipients(self.db, sc.get_settings(self.db))}
        self.assertEqual(got[AMY], (None, "all"))
        self.assertEqual(got[MIA], ({AMY, RAJ, SAM, LEE, "kid@greensglobal.com"}, "line"))
        # Offboarded holders are skipped.
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == ZOE).update({"status": "offboarded"})
        self.db.commit()
        self.assertNotIn(ZOE, [e.work_email for e, _, _ in sc.recipients(self.db, sc.get_settings(self.db))])


class ScanTests(_Case):
    def setUp(self):
        super().setUp()
        self._team()
        self._week_us(AMY)

    def test_off_mode_logs_but_never_mails(self):
        self._config(mode="off")
        self.assertEqual(sc._scan_once(), 1)
        self.assertEqual(self.sent, [])
        log = self._logs()[0]
        self.assertEqual((log.week_start, log.sent_at, log.mode, log.people_count, log.absent_count), ("2026-10-05", "", "off", 3, 1))

    def test_live_mails_each_manager_once_a_week(self):
        self._config()
        self.assertEqual(sc._scan_once(), 1)
        self.assertEqual(sc._scan_once(), 0)
        self.assertEqual(len(self.sent), 1)
        m = self.sent[0]
        self.assertEqual(m["to"], [MIA])
        self.assertEqual(m["subject"], "Workforce Scorecard - Week of 10/05/2026")
        self.assertIn("Raj", m["html"])
        self.assertIn("Absent", m["html"])
        self.assertIn("/employee-tracking/scorecard?week=2026-10-05", m["html"])
        self.assertIn("your direct reports", m["html"])
        self.assertIn("Sam", m["html"])                    # listed under Not Scored
        self.assertIn("No schedule", m["html"])
        self.assertEqual(len(self._logs()), 1)

    def test_test_mode_goes_to_the_test_recipients(self):
        self._config(mode="test", test_recipients=["qa@greensglobal.com"])
        sc._scan_once()
        self.assertEqual(self.sent[0]["to"], ["qa@greensglobal.com"])
        self.assertTrue(self.sent[0]["subject"].startswith(f"[TEST -> {MIA}]"))
        self.assertEqual(self._logs()[0].mode, "test")

    def test_company_recipients_get_everyone(self):
        self._emp("ceo@greensglobal.com", manager="")
        self._config(companyRecipients=["ceo@greensglobal.com"])
        sc._scan_once()
        ceo = next(m for m in self.sent if m["to"] == ["ceo@greensglobal.com"])
        self.assertIn("the whole company", ceo["html"])
        self.assertIn("Zoe", ceo["html"])
        self.assertNotIn("Zoe", next(m for m in self.sent if m["to"] == [MIA])["html"])

    def test_not_due_before_send_time_or_on_another_day(self):
        self._config(sendTime="09:00")
        self.assertEqual(sc._scan_once(), 0)
        self._config(sendTime="08:00", sendDay=2)
        self.assertEqual(sc._scan_once(), 0)
        self._config(sendDay=1)
        self.assertEqual(sc._scan_once(), 1)

    def test_send_time_is_the_managers_own_zone(self):
        # 8:30 PM: already past in India (8:40 PM), still hours away in Pacific (8:10 AM).
        self._config(sendTime="20:30")
        self.assertEqual(sc._scan_once(), 0)
        self._preset(MIA, tz="Asia/Kolkata")
        self.assertEqual(sc._scan_once(), 1)

    def test_email_waits_until_the_week_is_over_in_the_latest_zone_and_scores_it_complete(self):
        # Mia on an India preset at 8:40 PM Monday IST: California is still
        # Monday 8:10 AM, so the week is over everywhere - due.
        self._preset(MIA, tz="Asia/Kolkata")
        self._config(sendTime="08:00")
        # ...but with a default zone where it is still Sunday evening, not yet.
        with mock.patch.object(daily_briefing, "_shift_local_now",
                               lambda tz: datetime(2026, 10, 11, 19, 30) if tz == "Pacific/Pago_Pago" else _frozen_local_now(tz)):
            self._config(defaultTimeZone="Pacific/Pago_Pago")
            self.assertEqual(sc._scan_once(), 0)
        self._config(defaultTimeZone="America/Los_Angeles")
        self.assertEqual(sc._scan_once(), 1)
        # The email scores every day of the week, whatever an employee's own
        # clock says: Amy's Sunday is a scored (off) day, not "today".
        self.assertNotIn("today", self.sent[0]["html"].lower().split("not scored")[0][-2000:])
        report = sc.build_report(self.db, {AMY}, sc.get_settings(self.db), date(2026, 10, 12), complete=True)
        self.assertTrue(all(d["scored"] for d in report["people"][0]["days"]))
        self.assertEqual(report["people"][0]["band"], "absent")

    def test_late_in_the_day_still_sends_that_day(self):
        # No catch-up cut-off: an API that was down at 08:00 still sends at 8:10 AM
        # (or 3 PM) the same day, never skips the week.
        self._config(sendTime="06:00")
        self.assertEqual(sc._scan_once(), 1)

    def test_manager_with_nobody_in_scope_gets_no_email(self):
        self._emp("solo@greensglobal.com", manager="")
        self._grant("solo@greensglobal.com")
        self._config()
        sc._scan_once()
        self.assertEqual([m["to"] for m in self.sent], [[MIA]])
        solo = self._logs("solo@greensglobal.com")[0]
        self.assertEqual((solo.sent_at, solo.people_count), ("", 0))

    def test_send_failure_is_logged_without_sent_at(self):
        self._config()
        with mock.patch.object(sc.graph_mail, "send_mail", side_effect=sc.graph_mail.GraphMailError("down")):
            sc._scan_once()
        self.assertEqual(self._logs()[0].sent_at, "")
        self.assertEqual(sc._scan_once(), 0)   # still once a week - an admin force-resends from the log


class ApiTests(_Case):
    def setUp(self):
        super().setUp()
        self._team()
        self._week_us(AMY)
        self.app = FastAPI()
        self.app.include_router(sc_router.router)
        from auth import require_administrator
        self.app.dependency_overrides[require_administrator] = lambda: {
            "email": "admin@greensglobal.com", "role": "administrator", "level": 4}
        self.client = TestClient(self.app)

    def _as(self, email, level):
        self.app.dependency_overrides[sc_router._read] = lambda: {"email": email, "role": "x", "level": level}

    def test_report_for_a_manager_is_their_team_and_all_is_downgraded(self):
        self._as(MIA, 3)
        r = self.client.get("/workforce-scorecard/report")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["weekStart"], body["weekEnd"], body["scope"], body["canSeeCompany"]), ("2026-10-05", "2026-10-11", "direct", False))
        self.assertEqual([p["email"] for p in body["people"]], [RAJ, AMY, SAM])
        r = self.client.get("/workforce-scorecard/report", params={"scope": "all", "week_start": "2026-10-07"})
        self.assertEqual((r.json()["scope"], r.json()["weekStart"]), ("direct", "2026-10-05"))

    def test_admin_can_ask_for_everyone_but_defaults_to_their_direct_reports(self):
        self._as("admin@greensglobal.com", 4)
        r = self.client.get("/workforce-scorecard/report", params={"scope": "all"})
        self.assertEqual((r.json()["scope"], r.json()["canSeeCompany"]), ("all", True))
        self.assertIn(ZOE, [p["email"] for p in r.json()["people"]])
        r = self.client.get("/workforce-scorecard/report")
        self.assertEqual((r.json()["scope"], r.json()["people"]), ("direct", []))

    def test_bad_week_is_400(self):
        self._as(MIA, 3)
        self.assertEqual(self.client.get("/workforce-scorecard/report", params={"week_start": "next week"}).status_code, 400)

    def test_email_me(self):
        self._as(MIA, 3)
        r = self.client.post("/workforce-scorecard/email-me", json={"week_start": "2026-10-05"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["sent"], r.json()["to"]), (True, MIA))
        self.assertEqual(self.sent[0]["to"], [MIA])
        self.assertEqual(self.sent[0]["subject"], "Workforce Scorecard - Week of 10/05/2026")   # not a test send
        self.assertEqual(self._logs(), [])

    def test_config_round_trip_and_validation(self):
        r = self.client.put("/workforce-scorecard/config", json={"mode": "test", "test_recipients": [" QA@greensglobal.com "],
                                                                 "standards": {"default": {"hours": 8, "days": [1, 2, 3, 4, 5]},
                                                                               "IN": {"hours": 9, "days": [1, 2, 3, 4, 5, 6]}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["test_recipients"], ["qa@greensglobal.com"])
        self.assertEqual(r.json()["standards"]["IN"]["days"], [1, 2, 3, 4, 5, 6])
        self.assertEqual(r.json()["standards"]["US"]["hours"], 8)      # untouched rows survive
        self.assertEqual(self.client.put("/workforce-scorecard/config", json={"belowPct": 99}).status_code, 400)
        self.assertEqual(self.client.get("/workforce-scorecard/config").json()["mode"], "test")

    def test_recipients_preview(self):
        r = self.client.get("/workforce-scorecard/recipients")
        self.assertEqual(r.json()["rows"], [{"email": MIA, "name": "Mia", "scope": "direct", "peopleInScope": 4}])

    def test_test_send_and_force_resend(self):
        r = self.client.post("/workforce-scorecard/test-send", json={"manager_email": AMY})
        self.assertEqual(r.status_code, 404)
        r = self.client.post("/workforce-scorecard/test-send", json={"manager_email": MIA})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["recipients"], r.json()["peopleCount"], r.json()["weekStart"]), (["admin@greensglobal.com"], 3, "2026-10-05"))
        self.assertEqual(self._logs(), [])
        self.db.add(models.NexusWorkforceScorecardLog(id="log1", manager_email=MIA, week_start="2026-09-28",
                                                      mode="live", created_at="2026-10-05T00:00:00"))
        self.db.commit()
        sc.save_settings(self.db, {"mode": "live"}, "admin@greensglobal.com")
        r = self.client.delete("/workforce-scorecard/log/log1")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["sentNow"])
        self.assertEqual(self.sent[-1]["to"], [MIA])
        self.assertIn("Week of 09/28/2026", self.sent[-1]["subject"])
        self.assertEqual([l.week_start for l in self._logs()], ["2026-09-28"])
        r = self.client.get("/workforce-scorecard/log")
        self.assertEqual(r.json()["total"], 1)


if __name__ == "__main__":
    unittest.main()
