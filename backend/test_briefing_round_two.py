"""Briefing emails, round two (Neil, 11/17/2026 - mockups at
https://claude.ai/artifact/XLrj1ztpBpSSBYrQtircbr).

  - A company holiday (a Day Off) sends no briefing to anyone; a full day of
    approved time off sends none to the person - unless they manage someone.
  - The "since" window starts at the last briefing SENT, so a day with no email
    rolls into the next one, and that one says how far back it reaches.
  - A day with only completed items sends nothing.
  - Monday is ONE email: the first Daily Briefing of the week on or after the
    send day is the Weekly Briefing (the day plus the week's sections) and the
    separate Weekly Briefing skips that week.
  - Waiting N Days on decisions, the Today line, Last Week, and the Gmail size
    limit (the worst case stays under 95 KB).

The clock is frozen at Monday 09/28/2026 14:10 UTC (7:10 AM Pacific).
Run with: python -m pytest test_briefing_round_two.py
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone, date
from unittest import mock
from zoneinfo import ZoneInfo

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

import daily_briefing                                    # noqa: E402
import weekly_digest                                     # noqa: E402
import database                                          # noqa: E402
import models                                            # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

FIXED = datetime(2026, 9, 28, 14, 10, tzinfo=timezone.utc)   # Monday 7:10 AM Pacific
TODAY = date(2026, 9, 28)
AMY, BOSS = "amy@greensglobal.com", "boss@greensglobal.com"


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

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusWeeklyDigestLog, models.NexusDailyBriefingLog, models.NexusSetting,
                  models.NexusEmployee, models.Task, models.TaskProject, models.Shift, models.ShiftAssignment,
                  models.ScheduledShift, models.TaskTicket, models.TimeOffRequest, models.HrCompanyHoliday,
                  models.HrEntity, models.TimePunch):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id="co-us", name="Greens US", country="US"))
        self.db.commit()
        self.sent = []
        for p in (mock.patch.object(weekly_digest, "datetime", _FrozenDT),
                  mock.patch.object(daily_briefing, "datetime", _FrozenDT),
                  mock.patch.object(daily_briefing, "_shift_local_now", _frozen_local_now),
                  mock.patch.object(daily_briefing, "_logo_url", lambda db: ""),
                  mock.patch.object(daily_briefing.graph_mail, "send_mail", lambda **kw: self.sent.append(kw)),
                  mock.patch("routers.timeclock._employee_today", lambda db, email: TODAY.isoformat())):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _emp(self, email, **kw):
        kw.setdefault("company", "co-us")
        kw.setdefault("country", "US")
        e = models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0].title(), last_name="",
                                 work_email=email, **kw)
        self.db.add(e)
        self.db.commit()
        return e

    def _task(self, title, due, assignee=AMY, **kw):
        tid = gen_id()
        self.db.add(models.Task(id=tid, title=title, due_on=due, assignee_email=assignee,
                                assignee_emails=[assignee], **kw))
        self.db.commit()
        return tid

    def _shift(self, email, start="09:00", end="17:30"):
        sid = gen_id()
        self.db.add(models.Shift(id=sid, name="Preset", start_hhmm=start, end_hhmm=end, days="1,2,3,4,5",
                                 timezone="America/Los_Angeles"))
        self.db.add(models.ShiftAssignment(id=gen_id(), employee_email=email, shift_id=sid))
        self.db.commit()

    def _live(self, daily=True, weekly=True):
        if daily:
            daily_briefing.save_settings(self.db, {"mode": "live"}, "admin@greensglobal.com")
        if weekly:
            weekly_digest.save_settings(self.db, {"mode": "live", "test_recipients": []}, "admin@greensglobal.com")

    def _off(self, email, start, end, **kw):
        self.db.add(models.TimeOffRequest(id=gen_id(), employee_email=email, type="vacation",
                                          start_date=start, end_date=end, status="approved", **kw))
        self.db.commit()


class DaysOffTests(_Case):
    def test_a_company_holiday_skips_everyone_a_half_day_does_not(self):
        amy = self._emp(AMY)
        self.db.add(models.HrCompanyHoliday(id=gen_id(), company_id="co-us", date=TODAY.isoformat(),
                                            name="Founders Day", type="mandatory", country_code=""))
        self.db.commit()
        self.assertEqual(daily_briefing.skip_reason(self.db, amy, TODAY.isoformat()), "holiday")
        self.db.query(models.HrCompanyHoliday).update({"type": "half_day"})
        self.db.commit()
        self.assertEqual(daily_briefing.skip_reason(self.db, amy, TODAY.isoformat()), "")

    def test_time_off_skips_the_person_but_not_a_manager(self):
        amy = self._emp(AMY)
        boss = self._emp(BOSS)
        self._emp("ray@greensglobal.com", manager_email=BOSS)
        self._off(AMY, "2026-09-28", "2026-09-30")
        self._off(BOSS, "2026-09-28", "2026-09-28")
        self.assertEqual(daily_briefing.skip_reason(self.db, amy, TODAY.isoformat()), "time_off")
        self.assertEqual(daily_briefing.skip_reason(self.db, boss, TODAY.isoformat()), "")   # Neil: managers keep it

    def test_part_of_a_day_off_still_sends_and_a_blank_end_date_is_one_day(self):
        amy = self._emp(AMY)
        self._off(AMY, "2026-09-28", "2026-09-28", start_time="13:00", end_time="17:00")
        self.assertEqual(daily_briefing.skip_reason(self.db, amy, TODAY.isoformat()), "")
        self.db.query(models.TimeOffRequest).delete()
        self._off(AMY, "2026-09-28", "")
        self.assertEqual(daily_briefing.skip_reason(self.db, amy, TODAY.isoformat()), "time_off")

    def test_the_scan_sends_nothing_on_a_holiday_and_logs_the_day(self):
        self._emp(AMY)
        self._shift(AMY)
        self._live()
        self._task("Overdue thing", "2026-09-20")
        self.db.add(models.HrCompanyHoliday(id=gen_id(), company_id="co-us", date=TODAY.isoformat(),
                                            name="Founders Day", type="mandatory", country_code=""))
        self.db.commit()
        daily_briefing._scan_once()
        weekly_digest._scan_once()
        self.assertEqual(self.sent, [])
        self.db.expire_all()
        [row] = self.db.query(models.NexusDailyBriefingLog).all()
        self.assertEqual((row.briefing_date, row.sent_at), (TODAY.isoformat(), ""))
        # The week was not logged: it goes out on the next working day.
        self.assertEqual(self.db.query(models.NexusWeeklyDigestLog).count(), 0)


class WindowTests(_Case):
    def test_the_window_starts_at_the_last_briefing_sent(self):
        self._emp(AMY)
        for briefing, sent, created in (("2026-09-24", "2026-09-24T13:00:00", "2026-09-24T13:00:00"),
                                        ("2026-09-25", "", "2026-09-25T13:00:00")):
            self.db.add(models.NexusDailyBriefingLog(id=gen_id(), employee_email=AMY, briefing_date=briefing,
                                                     sent_at=sent, mode="live", created_at=created))
        self.db.commit()
        self.assertEqual(daily_briefing._last_log(self.db, AMY).sent_at, "2026-09-24T13:00:00")

    def test_the_first_email_back_says_how_far_back_it_reaches(self):
        local = _frozen_local_now("America/Los_Angeles")
        self.assertEqual(daily_briefing.since_label_for("2026-09-24T13:00:00", "2026-09-28", local),
                         "Thursday, 09/24/2026")
        self.assertEqual(daily_briefing.since_label_for("2026-09-27T13:00:00", "2026-09-28", local), "")
        _, html = daily_briefing.render_email("Amy", "2026-09-28", {"needs_to_know": [
            {"title": "X", "detail": "Updated", "url": "u", "module": "tasks"}]}, since_label="Thursday, 09/24/2026")
        self.assertIn("Here is what changed since Thursday, 09/24/2026.", html)


class QuietDayTests(_Case):
    def test_only_completed_items_send_nothing(self):
        emp = self._emp(AMY)
        self._live(weekly=False)
        self._task("Done thing", "2026-09-25", completed=True, completed_at="2026-09-28T01:00:00")
        daily_briefing._send_one(self.db, emp, daily_briefing.get_settings(self.db), "2026-09-29",
                                 _frozen_local_now("America/Los_Angeles"))
        self.assertEqual(self.sent, [])
        self.db.expire_all()
        self.assertEqual(self.db.query(models.NexusDailyBriefingLog).one().sent_at, "")


class OneMondayEmailTests(_Case):
    def test_monday_is_one_weekly_briefing_and_the_separate_one_skips_the_week(self):
        self._emp(AMY)
        self._shift(AMY)
        self._live()
        self._task("Renew business license", "2026-09-20")
        self._task("Walk the site", "2026-09-30")
        daily_briefing._scan_once()
        weekly_digest._scan_once()
        self.assertEqual(len(self.sent), 1, [m["subject"] for m in self.sent])
        mail = self.sent[0]
        self.assertTrue(mail["subject"].startswith("Weekly Briefing - "), mail["subject"])
        self.assertIn("1 Overdue", mail["subject"])
        for heading in ("Overdue Tasks", "Due This Week", "Renew business license", "Walk the site",
                        "On Mondays it is the Weekly Briefing"):
            self.assertIn(heading, mail["html"])
        self.assertNotIn("Weekly Digest", mail["html"])
        self.db.expire_all()
        [week] = self.db.query(models.NexusWeeklyDigestLog).all()
        self.assertTrue(week.sent_at)

    def test_no_daily_means_the_separate_weekly_briefing_still_goes(self):
        self._emp(AMY)
        self._shift(AMY)
        self._live(daily=False)
        self._task("Renew business license", "2026-09-20")
        weekly_digest._scan_once()
        [mail] = self.sent
        self.assertTrue(mail["subject"].startswith("Weekly Briefing - "), mail["subject"])

    def test_a_week_not_yet_sent_rides_with_tuesdays_briefing(self):
        amy = self._emp(AMY)
        self._live()
        self._task("Renew business license", "2026-09-20")
        tuesday = date(2026, 9, 29)
        self.assertIsNotNone(weekly_digest.combine_into_daily(self.db, amy, tuesday, "live"))
        self.assertIsNone(weekly_digest.combine_into_daily(self.db, amy, tuesday, "test"))   # modes differ
        self.db.add(models.NexusWeeklyDigestLog(id=gen_id(), employee_email=AMY, week_start="2026-09-28",
                                                sent_at="2026-09-28T13:00:00", mode="live", created_at="x"))
        self.db.commit()
        self.assertIsNone(weekly_digest.combine_into_daily(self.db, amy, tuesday, "live"))   # already went


class ContentTests(_Case):
    def test_waiting_days_tag_and_longest_first(self):
        rows = [{"title": "New", "detail": "", "url": "u", "module": "tasks", "since": "2026-09-27T10:00:00"},
                {"title": "Old", "detail": "", "url": "u", "module": "tasks", "since": "2026-09-18T10:00:00"},
                {"title": "Fresh", "detail": "", "url": "u", "module": "tasks", "since": "2026-09-28T01:00:00"}]
        daily_briefing.stamp_waiting(rows, "2026-09-28")
        self.assertEqual([r.get("waiting_days") for r in rows], [1, 10, None])
        _, html = daily_briefing.render_email("Amy", "2026-09-28", {"action_required": rows})
        self.assertLess(html.index(">Old<"), html.index(">New<"))
        self.assertIn(">Waiting 10 days</span>", html)
        self.assertIn(">Waiting 1 day</span>", html)

    def test_the_today_line_names_the_shift_and_its_place(self):
        self._emp(AMY)
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email=AMY, work_date=TODAY.isoformat(),
                                          start_hhmm="08:00", end_hhmm="16:30", label="Round Rock", published=1))
        self.db.commit()
        self.assertEqual(daily_briefing.today_line_for(self.db, AMY, TODAY.isoformat()),
                         "Your shift 8:00 AM - 4:30 PM, Round Rock")
        self.assertEqual(daily_briefing.today_line_for(self.db, "nobody@greensglobal.com", TODAY.isoformat()), "")

    def test_last_week_counts_your_work_and_the_teams(self):
        self._emp(BOSS)
        self._emp(AMY, manager_email=BOSS)
        for title in ("A", "B"):
            self._task(title, "2026-09-22", assignee=BOSS, completed=True, completed_at="2026-09-23T10:00:00")
        self._task("C", "2026-09-22", completed=True, completed_at="2026-09-24T10:00:00")       # Amy's, last week
        self._task("Late", "2026-09-10")                                                        # Amy's, overdue
        lines = weekly_digest.last_week_lines(self.db, BOSS, TODAY)
        self.assertEqual(lines[0], "You finished 2 tasks.")
        self.assertEqual(lines[1], "Your team finished 1 task. 1 is overdue, the same as the week before.")
        self.assertEqual(weekly_digest.last_week_lines(self.db, "nobody@greensglobal.com", TODAY), [])

    def test_last_week_counts_the_hours_on_your_punches(self):
        self._emp(AMY)
        # Tue 09/22 and Wed 09/23: 8h and 7h 30m (UTC times, Pacific days).
        for day, start, end in (("2026-09-22", "2026-09-22T16:00:00+00:00", "2026-09-23T00:00:00+00:00"),
                                ("2026-09-23", "2026-09-23T16:00:00+00:00", "2026-09-23T23:30:00+00:00"),
                                ("2026-09-28", "2026-09-28T16:00:00+00:00", "2026-09-28T20:00:00+00:00")):   # this week
            for kind, at in (("in", start), ("out", end)):
                self.db.add(models.TimePunch(id=gen_id(), employee_email=AMY, kind=kind, at=at, local_date=day,
                                             tz_offset_min=420, voided=0))
        self.db.commit()
        self.assertEqual(weekly_digest.last_week_lines(self.db, AMY, TODAY), ["You worked 15h 30m."])

    def test_a_busy_managers_email_stays_under_gmails_limit(self):
        def task(i, **kw):
            return {"title": f"Task {i} with a fairly normal length name", "detail": "Sam Rivera commented",
                    "url": f"https://n/tasks/mine?task={i}", "module": "tasks", "task_id": f"t{i}",
                    "action_email": AMY, **kw}
        comments = [{"author": "Sam Rivera", "body": "Parts arrive Wednesday. I will close the unit off until then."}] * 2
        heavy = {"action_required": [task(f"a{i}", action_kind="task_approval", action_id=f"a{i}") for i in range(18)],
                 "needs_to_know": [task(f"u{i}", task_open=True, comments=comments) for i in range(18)],
                 "completed": [task(f"c{i}", task_done=True) for i in range(18)]}
        _, html = daily_briefing.render_email("Amy", "2026-09-28", heavy)
        self.assertLess(len(html.encode()), 95_000)
        self.assertEqual(html.count("Approve</a>"), 18)            # Action Required is never cut
        self.assertIn("more not listed.", html)                    # the FYI sections point to View All

    def test_section_headings_are_headings(self):
        _, html = daily_briefing.render_email("Amy", "2026-09-28", {"needs_to_know": [
            {"title": "X", "detail": "", "url": "u", "module": "tasks"}]})
        self.assertIn('role="heading" aria-level="1"', html)
        self.assertIn('role="heading" aria-level="2"', html)


class ReviewFixTests(_Case):
    """The fixes from the review of 11/17/2026, one each."""

    def test_the_weekly_never_catches_up_on_a_weekend(self):
        emp = self._emp(AMY)
        self._live(daily=False)
        cfg = weekly_digest.get_settings(self.db)
        saturday = datetime(2026, 10, 3, 8, 30)                       # 8:30 AM, after the 8:00 send time
        with mock.patch.object(daily_briefing, "_shift_local_now", lambda tz: saturday):
            self.assertFalse(weekly_digest._no_shift_due(self.db, emp.work_email, cfg)[0])
        tuesday = datetime(2026, 9, 29, 8, 30)
        with mock.patch.object(daily_briefing, "_shift_local_now", lambda tz: tuesday):
            self.assertTrue(weekly_digest._no_shift_due(self.db, emp.work_email, cfg)[0])

    def test_a_monday_with_only_finished_items_sends_nothing(self):
        done = {"title": "X", "detail": "Completed", "url": "u", "module": "tasks"}
        secs, _ = weekly_digest.combined({"completed": [done]}, {"sections": {}, "recap": [], "cfg": {}},
                                         "2026-09-28", {})
        self.assertEqual(secs, {})

    def test_an_after_midnight_shift_is_not_a_two_day_gap(self):
        local = _frozen_local_now("America/Los_Angeles")               # Mon 7:10 AM
        # Briefed Sun 10:30 PM for Monday's 1:00 AM shift; now briefing Tuesday's.
        self.assertEqual(daily_briefing.since_label_for("2026-09-28T05:30:00", "2026-09-29", local), "")

    def test_the_monday_preview_says_which_week_the_holiday_is(self):
        week = {"sections": {weekly_digest.HOLIDAY_SECTION: [
            {"title": "Thanksgiving Day", "detail": "Thursday, 11/26/2026 - Day Off - Next Week", "url": "",
             "module": "holidays"}]}, "recap": [], "cfg": {}}
        row = {"title": "Approve: X", "detail": "", "url": "u", "module": "tasks", "task_id": "t1",
               "action_kind": "task_approval", "action_id": "t1", "action_email": AMY}
        _, extra = weekly_digest.combined({"action_required": [row]}, week, "2026-11-16", {})
        self.assertIn("Thanksgiving Day is Thursday next week", extra["preheader"])

    def test_an_overdue_approval_is_listed_once(self):
        row = {"title": "Approve: Budget", "detail": "", "url": "u", "module": "tasks", "task_id": "t1",
               "action_kind": "task_approval", "action_id": "t1", "action_email": AMY}
        week = {"sections": {weekly_digest.SECTION: [dict(row, overdue_days=3)]}, "recap": [], "cfg": {}}
        secs, extra = weekly_digest.combined({"action_required": [row]}, week, "2026-09-28", {})
        self.assertNotIn(weekly_digest.SECTION, secs)
        self.assertNotIn("Overdue", extra["subject"])

    def test_the_window_never_reaches_back_more_than_two_weeks(self):
        emp = self._emp(AMY)
        self._live(weekly=False)
        self.db.add(models.NexusDailyBriefingLog(id=gen_id(), employee_email=AMY, briefing_date="2026-08-20",
                                                 sent_at="2026-08-20T13:00:00", mode="live",
                                                 created_at="2026-08-20T13:00:00"))
        self.db.commit()
        seen = {}
        real = daily_briefing.build_sections

        def spy(db, email, since_iso, briefing_date):
            seen["since"] = since_iso
            return real(db, email, since_iso, briefing_date)
        with mock.patch.object(daily_briefing, "build_sections", spy):
            daily_briefing._send_one(self.db, emp, daily_briefing.get_settings(self.db), "2026-09-28",
                                     _frozen_local_now("America/Los_Angeles"))
        self.assertEqual(seen["since"][:10], "2026-09-14")

    def test_last_week_never_says_zero_and_always_has_a_subject(self):
        self._emp(BOSS)
        self._emp(AMY, manager_email=BOSS)
        # Overdue a week ago, finished since: nothing overdue now.
        self._task("Old", "2026-09-10", completed=True, completed_at="2026-09-25T10:00:00")
        self.assertIn("Nothing is overdue, down from 1 the week before.",
                      " ".join(weekly_digest.last_week_lines(self.db, BOSS, TODAY)))
        self.db.query(models.Task).delete()
        self.db.commit()
        self._task("Late", "2026-09-10")                                # overdue then and now, nothing done
        self.assertEqual(weekly_digest.last_week_lines(self.db, BOSS, TODAY),
                         ["Your team has 1 overdue task, the same as the week before."])

    def test_a_test_copy_of_monday_carries_no_links_that_act_as_the_person(self):
        self._emp(AMY)
        self._shift(AMY)
        daily_briefing.save_settings(self.db, {"mode": "test", "test_recipients": ["qa@greensglobal.com"]}, "a@x.com")
        weekly_digest.save_settings(self.db, {"mode": "test", "test_recipients": ["qa@greensglobal.com"]}, "a@x.com")
        self._task("Renew business license", "2026-09-20")
        daily_briefing._scan_once()
        [mail] = self.sent
        self.assertIn("Renew business license", mail["html"])
        self.assertNotIn("do=extend", mail["html"])
        self.assertNotIn("mail-actions/page", mail["html"])

    def test_monday_is_one_email_whichever_scan_runs_first(self):
        self._emp(AMY)
        self._shift(AMY)
        self._live()
        self._task("Renew business license", "2026-09-20")
        weekly_digest._scan_once()                     # the weekly steps aside: the daily carries the week
        self.assertEqual(self.sent, [])
        daily_briefing._scan_once()
        weekly_digest._scan_once()
        self.assertEqual([m["subject"][:16] for m in self.sent], ["Weekly Briefing "])

    def test_a_week_of_only_coming_up_still_has_a_counts_line(self):
        _, html = daily_briefing.render_email("Amy", "2026-09-28", {"coming_up": [
            {"title": "Holiday", "detail": "Friday", "url": "", "module": "holidays", "group": "Holidays"}]},
            order=["coming_up"])
        self.assertRegex(html, r">1</span> coming up")
        self.assertNotIn("color:#6b7280'>Nothing new since your last briefing.</div>", html)   # the counts line


if __name__ == "__main__":
    unittest.main()
