"""
Shifts Phase 2 - rules before publish (Oct 14 2026): shift_rules.py, shift_log.py
and the publish review in routers/timeclock.py.

  - evaluate(): rest between shifts (an overnight shift included), days in a
    row, daily overtime ('ca' only), weekly overtime ('ca' and 'federal'),
    the week cap (everyone), the week boundary by weekStart, a cancelled day
    counting no hours and breaking a streak, every rule off at 0.
  - rule_warnings() reads a pending edit; the grid shows a rule warning in
    `conflicts`; the Add/Edit check warns on the hypothetical shift.
  - The publish review lists changes and warnings with reasonRequired - the
    warnings the publish puts on a person's unchanged shifts included, the
    ones the published schedule already had left out; whose company decides
    the reason; a publish over warnings is refused without a reason and
    logs 'shared' rows with it; the history route lists created -> edited
    -> shared, refuses a shift outside the caller's scope, and shows staff
    nothing that is still waiting to be shared.

Throwaway sqlite. Run with: python -m unittest test_shift_rules -v
"""
import json
from datetime import datetime, timezone
import os
import tempfile
import unittest

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
import shift_log          # noqa: E402
import shift_rules        # noqa: E402

ENT, GROUP = "ent-rules", "grp-rules"
ADMIN = "rules.admin@greensglobal.com"    # administrator: company-wide
MGR = "rules.mgr@greensglobal.com"        # Amy's and Bob's manager
OTHER = "rules.other@greensglobal.com"    # a manager with nobody under them
AMY = "rules.amy@greensglobal.com"        # overtime rule 'ca' (no payroll row)
BOB = "rules.bob@greensglobal.com"        # overtime rule 'federal'
MON, TUE, WED, THU, FRI, SAT, SUN = ("2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15",
                                     "2026-10-16", "2026-10-17", "2026-10-18")
CFG = {"ruleMinRestHours": 10, "ruleMaxDaysInRow": 6, "ruleDailyOtHours": 8, "ruleWeeklyOtHours": 40,
       "ruleMaxWeekHours": 0}
WK = {**CFG, "ruleDailyOtHours": 0}   # 9-hour days without the daily rule in the way


def _s(sid, date, start, end, paid=None, cancelled=False):
    if paid is None:
        s0, e0 = int(start[:2]) * 60 + int(start[3:]), int(end[:2]) * 60 + int(end[3:])
        paid = e0 - s0 if e0 > s0 else e0 + 1440 - s0
    return {"id": sid, "date": date, "start": start, "end": end, "paidMin": paid, "cancelled": cancelled}


class EvaluateTests(unittest.TestCase):
    def test_rest_between_consecutive_shifts(self):
        out = shift_rules.evaluate([_s("a", MON, "14:00", "22:00"), _s("b", TUE, "06:00", "14:00")], CFG)
        self.assertEqual(out, {"b": ["Only 8h 00m rest before this shift (10h minimum)."]})
        # Enough rest: nothing.
        out = shift_rules.evaluate([_s("a", MON, "09:00", "17:00"), _s("b", TUE, "09:00", "17:00")], CFG)
        self.assertEqual(out, {})
        # An overlap is a conflict, not a rest problem.
        out = shift_rules.evaluate([_s("a", MON, "09:00", "13:00"), _s("b", MON, "12:00", "16:00")], CFG)
        self.assertEqual(out, {})

    def test_a_split_shift_is_one_workday_not_a_rest_break(self):
        # 7-11a and 4-8p the same day: the 5 hours between are not "rest".
        out = shift_rules.evaluate([_s("a", MON, "07:00", "11:00"), _s("b", MON, "16:00", "20:00")], CFG)
        self.assertEqual(out, {})
        # Rest is measured from the day's LAST part to the next workday.
        out = shift_rules.evaluate([_s("a", MON, "07:00", "11:00"), _s("b", MON, "16:00", "20:00"),
                                    _s("c", TUE, "05:00", "09:00")], CFG)
        self.assertEqual(out, {"c": ["Only 9h 00m rest before this shift (10h minimum)."]})
        out = shift_rules.evaluate([_s("a", MON, "07:00", "11:00"), _s("b", MON, "16:00", "20:00"),
                                    _s("c", TUE, "07:00", "11:00")], CFG)
        self.assertEqual(out, {})

    def test_a_shift_crossing_midnight(self):
        out = shift_rules.evaluate([_s("n", MON, "22:00", "06:00"), _s("d", TUE, "08:00", "16:00")], CFG)
        self.assertEqual(out, {"d": ["Only 2h 00m rest before this shift (10h minimum)."]})
        # Its 8 hours count on the day it starts - no daily overtime either day.
        out = shift_rules.evaluate([_s("n", MON, "22:00", "06:00"), _s("d", TUE, "18:00", "23:00")], CFG)
        self.assertEqual(out, {})

    def test_days_in_a_row(self):
        days = [MON, TUE, WED, THU, FRI, SAT, SUN]
        out = shift_rules.evaluate([_s(f"s{i}", d, "09:00", "13:00") for i, d in enumerate(days)], CFG)
        self.assertEqual(out, {"s6": ["7th day in a row (6 is the most)."]})
        # ...and every day after the line.
        out = shift_rules.evaluate([_s(f"s{i}", d, "09:00", "13:00") for i, d in enumerate(days + ["2026-10-19"])], CFG)
        self.assertEqual(out["s7"], ["8th day in a row (6 is the most)."])
        self.assertNotIn("s5", out)

    def test_daily_overtime_is_california_only(self):
        shifts = [_s("a", MON, "07:00", "17:00")]
        self.assertEqual(shift_rules.evaluate(shifts, CFG, "ca"), {"a": ["10h 00m scheduled this day (over 8h is overtime)."]})
        self.assertEqual(shift_rules.evaluate(shifts, CFG, "federal"), {})
        self.assertEqual(shift_rules.evaluate(shifts, CFG, "none"), {})
        # Two shifts on one day add up; both carry the warning (and a same-day
        # split is one workday, so no rest warning between its parts).
        out = shift_rules.evaluate([_s("a", MON, "06:00", "11:00", 300), _s("b", MON, "14:00", "18:30", 270)], CFG)
        self.assertEqual(out, {"a": ["9h 30m scheduled this day (over 8h is overtime)."],
                               "b": ["9h 30m scheduled this day (over 8h is overtime)."]})

    def test_weekly_overtime_lands_on_the_shifts_past_the_line(self):
        shifts = [_s(d, d, "08:00", "17:00", 540) for d in (MON, TUE, WED, THU, FRI)]   # 45h
        out = shift_rules.evaluate(shifts, WK, "ca")
        self.assertEqual(out, {FRI: ["45h 00m scheduled this week (over 40h is overtime)."]})
        self.assertEqual(shift_rules.evaluate(shifts, WK, "federal"), out)
        # 'none' skips both overtime rules but keeps rest and days in a row.
        self.assertEqual(shift_rules.evaluate(shifts, CFG, "none"), {})
        seven = [_s(d, d, "08:00", "12:00") for d in (MON, TUE, WED, THU, FRI, SAT, SUN)]
        self.assertEqual(shift_rules.evaluate(seven, CFG, "none"), {SUN: ["7th day in a row (6 is the most)."]})
        rest = [_s("a", MON, "14:00", "22:00"), _s("b", TUE, "06:00", "14:00")]
        self.assertEqual(shift_rules.evaluate(rest, CFG, "none"), {"b": ["Only 8h 00m rest before this shift (10h minimum)."]})

    def test_overtime_follows_the_payroll_week_and_the_cap_the_display_week(self):
        # Hardening (Oct 15): overtime is paid on payroll's Sunday-Saturday
        # week (timeclock._week_start_str), whatever the grid shows.
        shifts = [_s("sun", "2026-10-11", "08:00", "17:00", 540)] + \
                 [_s(d, d, "08:00", "17:00", 540) for d in (MON, TUE, WED, THU)]   # Sun + Mon-Thu = 45h
        over = {THU: ["45h 00m scheduled this week (over 40h is overtime)."]}
        self.assertEqual(shift_rules.evaluate(shifts, WK, "ca", "monday"), over, "a Monday grid still pays Sunday-Saturday")
        self.assertEqual(shift_rules.evaluate(shifts, WK, "ca", "sunday"), over)
        # The hard cap is the display week's: Monday grid -> Sunday is last week.
        cap = {**WK, "ruleWeeklyOtHours": 0, "ruleMaxWeekHours": 40}
        self.assertEqual(shift_rules.evaluate(shifts, cap, "ca", "monday"), {})
        self.assertEqual(shift_rules.evaluate(shifts, cap, "ca", "sunday"), {THU: ["45h 00m scheduled this week (40h is the most)."]})

    def test_rest_is_measured_in_real_hours_across_a_dst_change(self):
        la = "America/Los_Angeles"
        cfg = {**CFG, "ruleMinRestHours": 10, "ruleMaxDaysInRow": 0, "ruleDailyOtHours": 0, "ruleWeeklyOtHours": 0}
        # Spring forward (03/08/2026): 10 PM - 6 AM is 7 real hours; the next
        # 2 PM start is 8 hours after 6 AM on the wall clock and in real time.
        night = {**_s("n", "2026-03-07", "22:00", "06:00"), "tz": la}
        after = {**_s("a", "2026-03-08", "14:00", "22:00"), "tz": la}
        self.assertEqual(shift_rules.evaluate([night, after], cfg, "none"), {"a": ["Only 8h 00m rest before this shift (10h minimum)."]})
        # A shift that ends at 4 PM wall time: 10 hours of rest on the wall
        # clock - 10 real hours too (both ends are past the change).
        after2 = {**_s("b", "2026-03-08", "16:00", "22:00"), "tz": la}
        self.assertEqual(shift_rules.evaluate([night, after2], cfg, "none"), {})
        # Fall back (11/01/2026): 10 PM - 6 AM is 9 real hours; a 3:30 PM start
        # is 9h 30m after 6 AM - under the 10-hour minimum, and the sentence
        # says the real gap. Without a zone the same shifts read in UTC.
        night2 = {**_s("n2", "2026-10-31", "22:00", "06:00"), "tz": la}
        after3 = {**_s("c", "2026-11-01", "15:30", "22:00"), "tz": la}
        self.assertEqual(shift_rules.evaluate([night2, after3], cfg, "none"), {"c": ["Only 9h 30m rest before this shift (10h minimum)."]})
        self.assertEqual(shift_rules.evaluate([{**night2, "tz": ""}, {**after3, "tz": ""}], cfg, "none"), {"c": ["Only 9h 30m rest before this shift (10h minimum)."]})
        # The overnight start is judged before the day's start in real time -
        # across the change a 1:30 AM shift still sorts after 10 PM.
        early = {**_s("e", "2026-11-01", "01:30", "03:00"), "tz": la}
        self.assertEqual(list(shift_rules.evaluate([after3, night2, early], cfg, "none")), ["c"])

    def test_overtime_rule_for(self):
        f = shift_rules.overtime_rule_for
        self.assertEqual(f("federal", "IN", "US", False), "federal")   # the rate row wins
        self.assertEqual(f("", "US", "", False), "ca")
        self.assertEqual(f("", "", "US", False), "ca")                  # the company's country
        self.assertEqual(f("", "IN", "US", False), "none")             # the person's own first
        self.assertEqual(f("", "", "IN", False), "none")
        self.assertEqual(f("", "", "", False), "none")                 # unknown country: no overtime rules
        self.assertEqual(f("ca", "US", "US", True), "none")            # exempt: no overtime rules at all

    def test_max_week_hours_applies_to_everyone(self):
        cfg = {**WK, "ruleWeeklyOtHours": 0, "ruleMaxWeekHours": 40}
        shifts = [_s(d, d, "08:00", "17:00", 540) for d in (MON, TUE, WED, THU, FRI)]
        self.assertEqual(shift_rules.evaluate(shifts, cfg, "none"), {FRI: ["45h 00m scheduled this week (40h is the most)."]})

    def test_a_cancelled_day_counts_no_hours_and_breaks_a_streak(self):
        days = [MON, TUE, WED, THU, FRI, SAT, SUN]
        shifts = [_s(f"s{i}", d, "08:00", "17:00", 540, cancelled=(d == WED)) for i, d in enumerate(days)]
        out = shift_rules.evaluate(shifts, WK, "ca")
        self.assertNotIn("s2", out, "a cancelled shift gets no warning")
        # 5 x 9h = 45h in the Sunday-Saturday payroll week without Wednesday -
        # over the line on Saturday; Sunday the 18th opens the next one.
        self.assertNotIn("s4", out, "Friday closes at 36h")
        self.assertEqual(out["s5"], ["45h 00m scheduled this week (over 40h is overtime)."])
        self.assertNotIn("s6", out, "a 7th calendar day, but the streak restarted after the cancelled day, and a new payroll week")
        # With Wednesday worked it would be the 7th day in a row.
        shifts[2]["cancelled"] = False
        self.assertIn("7th day in a row (6 is the most).", shift_rules.evaluate(shifts, WK, "ca")["s6"])

    def test_a_rule_at_zero_is_off(self):
        off = {k: 0 for k in CFG}
        shifts = [_s(d, d, "06:00", "18:00") for d in (MON, TUE, WED, THU, FRI, SAT, SUN)] + \
                 [_s("n", "2026-10-19", "00:30", "12:00")]
        self.assertEqual(shift_rules.evaluate(shifts, off, "ca"), {})
        self.assertEqual(shift_rules.evaluate(shifts, {}, "ca"), {})


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
                  models.Shift, models.ScheduledShift, models.NexusNotification, models.NexusSetting,
                  models.TimeOffRequest, models.PayrollRate, models.ShiftChangeLog, models.ShiftRequest,
                  models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        for em, first, mgr, role in ((ADMIN, "Ada", "", "administrator"), (MGR, "Mia", "", "manager"),
                                     (OTHER, "Oli", "", "manager"), (AMY, "Amy", MGR, ""), (BOB, "Bob", MGR, "")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             manager_email=mgr, status="active", deleted_at="", company=ENT, country="US"))
            if role:
                self.db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens"))
        self.db.add(models.ShiftGroup(open_shifts=1, id=GROUP, name="Crew", company_id=ENT, created_by=MGR))
        for em in (AMY, BOB):
            self.db.add(models.ShiftGroupMember(id=f"m-{em}", group_id=GROUP, employee_email=em))
        self.db.add(models.PayrollRate(employee_email=BOB, hourly_rate=20, overtime_rule="federal"))
        self.db.commit()
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._as(MGR)

    def tearDown(self):
        self.db.rollback()
        self.db.close()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _shift(self, email, day, start="09:00", end="17:00", published=1, **kw):
        sid = kw.pop("id", "") or f"s-{email.split('.')[1].split('@')[0]}-{day}-{start}"
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=start,
                                          end_hhmm=end, published=published, group_id=GROUP, created_by=MGR, **kw))
        self.db.commit()
        return sid

    def _company_setting(self, **cfg):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{ENT}", value=json.dumps(cfg)))
        self.db.commit()

    def _log(self, sid):
        self.db.expire_all()
        return (self.db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.shift_id == sid)
                .order_by(models.ShiftChangeLog.at, models.ShiftChangeLog.id).all())


class RuleWarningsTests(_Case):
    def test_reads_the_pending_edit_not_the_published_times(self):
        sid = self._shift(AMY, MON, pending_json=json.dumps({"shiftId": "", "start": "06:00", "end": "18:00",
                                                             "label": "", "note": "", "openSlots": 0, "breakMin": 0}))
        out = shift_rules.rule_warnings(self.db, [AMY], MON, MON)
        self.assertEqual(out, {sid: ["12h 00m scheduled this day (over 8h is overtime)."]})
        # A pending removal and an open slot are not on the schedule.
        self._shift(AMY, TUE, "06:00", "18:00", pending_delete=1)
        self._shift("", TUE, "06:00", "18:00", id="open-1", open_slots=2)
        self.assertNotIn("s-amy-2026-10-13-06:00", shift_rules.rule_warnings(self.db, [AMY], MON, TUE))

    def test_each_person_gets_their_company_settings_and_overtime_rule(self):
        self._shift(AMY, MON, "07:00", "17:00")   # 10h, 'ca' (no rate row, country US)
        self._shift(BOB, MON, "07:00", "17:00")   # 10h, 'federal': no daily rule
        out = shift_rules.rule_warnings(self.db, [AMY, BOB], MON, MON)
        self.assertEqual(list(out), ["s-amy-2026-10-12-07:00"])
        # No rate row: the rule follows the country - India has no daily or
        # weekly overtime rule here; rest and days in a row still apply.
        amy = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == AMY).first()
        amy.country = "IN"
        self.db.commit()
        self.assertEqual(shift_rules.rule_warnings(self.db, [AMY, BOB], MON, MON), {})
        self.assertEqual(shift_rules.config_for(self.db, [AMY, BOB])[AMY][1], "none")
        amy.country = ""
        self.db.query(models.HrEntity).filter(models.HrEntity.id == ENT).first().country = "US"
        self.db.commit()
        self.assertEqual(shift_rules.config_for(self.db, [AMY])[AMY][1], "ca", "the company's country when the person has none")
        # Exempt from time tracking: no overtime rules.
        self.db.add(models.NexusGroup(id="g-exempt", name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-exempt", email=AMY))
        self.db.commit()
        self.assertEqual(shift_rules.config_for(self.db, [AMY])[AMY][1], "none")
        self.db.query(models.NexusGroupMember).delete()
        self.db.commit()
        self._company_setting(ruleDailyOtHours=0)
        self.assertEqual(shift_rules.rule_warnings(self.db, [AMY, BOB], MON, MON), {})

    def test_the_grid_shows_a_rule_warning_in_conflicts(self):
        self._shift(AMY, MON, "14:00", "22:00")
        sid = self._shift(AMY, TUE, "06:00", "14:00")
        r = self.client.get("/timeclock/schedule", params={"start": MON, "end": FRI})
        self.assertEqual(r.status_code, 200, r.text)
        row = next(s for s in r.json()["scheduled"] if s["id"] == sid)
        self.assertEqual(row["ruleWarnings"], ["Only 8h 00m rest before this shift (10h minimum)."])
        self.assertEqual(row["conflicts"], ["Only 8h 00m rest before this shift (10h minimum)."])
        # A conflict comes first, the rule after it.
        self.db.add(models.TimeOffRequest(id="to-1", employee_email=AMY, type="vacation", start_date=TUE,
                                          end_date=TUE, status="approved"))
        self.db.commit()
        r = self.client.get("/timeclock/schedule", params={"start": MON, "end": FRI})
        row = next(s for s in r.json()["scheduled"] if s["id"] == sid)
        self.assertEqual(row["conflicts"], ["On approved time off that day (vacation).",
                                            "Only 8h 00m rest before this shift (10h minimum)."])

    def test_the_check_warns_on_the_hypothetical_shift(self):
        self._shift(AMY, MON, "14:00", "22:00")
        r = self.client.get("/timeclock/schedule/check", params={"email": AMY, "date": TUE, "start": "06:00", "end": "16:00"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["ruleWarnings"], ["Only 8h 00m rest before this shift (10h minimum).",
                                                    "10h 00m scheduled this day (over 8h is overtime)."])
        self.assertEqual(r.json()["warnings"], r.json()["ruleWarnings"])
        # Editing the Monday shift itself: it is not counted twice.
        r = self.client.get("/timeclock/schedule/check", params={"email": AMY, "date": MON, "start": "14:00", "end": "22:00",
                                                                 "exclude_id": "s-amy-2026-10-12-14:00"})
        self.assertEqual(r.json()["warnings"], [])
        # An unpaid break comes off the hours.
        r = self.client.get("/timeclock/schedule/check", params={"email": AMY, "date": WED, "start": "08:00", "end": "17:00",
                                                                 "break_min": 60})
        self.assertEqual(r.json()["warnings"], [])

    def test_the_check_judges_the_edited_shift_with_its_new_times(self):
        # Review fix: the hypothetical reuses the edited shift's id, and the
        # exclusion used to drop it with the original - an edit never warned.
        sid = self._shift(AMY, MON)
        r = self.client.get("/timeclock/schedule/check", params={"email": AMY, "date": MON, "start": "06:00", "end": "18:00",
                                                                 "exclude_id": sid})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["ruleWarnings"], ["12h 00m scheduled this day (over 8h is overtime)."])
        # The original is not counted alongside it: 9h in the day, not 9h + 8h.
        self.assertEqual(self.client.get("/timeclock/schedule/check", params={
            "email": AMY, "date": MON, "start": "08:00", "end": "17:00", "exclude_id": sid}).json()["ruleWarnings"],
            ["9h 00m scheduled this day (over 8h is overtime)."])


class PublishReviewTests(_Case):
    def test_review_lists_changes_and_warnings(self):
        self._shift(AMY, MON, "14:00", "22:00", published=0)
        self._shift(AMY, TUE, "06:00", "14:00", published=0)
        self._shift(BOB, WED, pending_json=json.dumps({"shiftId": "", "start": "10:00", "end": "18:00", "label": "Late",
                                                       "note": "", "openSlots": 0, "breakMin": 0}))
        self._shift(BOB, THU, pending_delete=1)
        self._shift(AMY, FRI)   # published and untouched: not in the review
        r = self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": FRI})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual([(c["email"], c["kind"], c["date"], c["start"], c["end"], c["label"], c["was"])
                          for c in sorted(body["changes"], key=lambda c: c["date"])],
                         [(AMY, "added", MON, "14:00", "22:00", "", None),
                          (AMY, "added", TUE, "06:00", "14:00", "", None),
                          (BOB, "changed", WED, "10:00", "18:00", "Late", {"start": "09:00", "end": "17:00", "label": ""}),
                          (BOB, "removed", THU, "09:00", "17:00", "", None)])
        self.assertEqual(body["changes"][0]["name"], "Amy Lee")
        self.assertEqual(body["people"], 2)
        self.assertEqual(body["warnings"], [{"email": AMY, "name": "Amy Lee", "date": TUE, "shiftId": "s-amy-2026-10-13-06:00",
                                             "text": "Only 8h 00m rest before this shift (10h minimum).", "kind": "rule", "soft": False}])
        self.assertTrue(body["reasonRequired"])
        # The company can switch the reason off.
        self._company_setting(publishReasonRequired=False)
        self.assertFalse(self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": FRI}).json()["reasonRequired"])
        # Narrowed to Bob: no warnings, no reason.
        self.db.query(models.NexusSetting).delete()
        self.db.commit()
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": FRI, "emails": BOB}).json()
        self.assertEqual([c["email"] for c in body["changes"]], [BOB, BOB])
        self.assertEqual((body["warnings"], body["reasonRequired"]), ([], False))

    def test_review_sees_a_warning_the_publish_puts_on_an_unchanged_shift(self):
        # Mon-Wed and Fri-Sun are shared; a Thursday draft makes Sunday the 7th
        # day in a row. The warning lands on Sunday's shift, which the publish
        # does not touch - the review still shows it.
        for d in (MON, TUE, WED, FRI, SAT, SUN):
            self._shift(AMY, d, "09:00", "13:00")
        thu = self._shift(AMY, THU, "09:00", "13:00", published=0)
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": THU, "end": THU}).json()
        self.assertEqual([c["shiftId"] for c in body["changes"]], [thu])
        self.assertEqual([(w["shiftId"], w["date"], w["text"], w["kind"]) for w in body["warnings"]],
                         [("s-amy-2026-10-18-09:00", SUN, "7th day in a row (6 is the most).", "rule")])
        self.assertTrue(body["reasonRequired"])
        # A warning the published schedule already carries is not this
        # publish's doing: Mon 2-10pm then Tue 6am is shared as it is.
        self.db.query(models.ScheduledShift).delete()
        self.db.commit()
        self._shift(AMY, MON, "14:00", "22:00")
        self._shift(AMY, TUE, "06:00", "14:00")
        self._shift(AMY, FRI, "09:00", "13:00", published=0)
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": FRI}).json()
        self.assertEqual((len(body["changes"]), body["warnings"], body["reasonRequired"]), (1, [], False))

    def test_the_reason_follows_the_warned_persons_company_not_the_publishers(self):
        # Bob's company does not ask for a reason; the manager's (Amy's) does.
        self.db.add(models.HrEntity(id="ent-two", name="Two"))
        self.db.add(models.NexusSetting(key="shift_requests_config:ent-two", value=json.dumps({"publishReasonRequired": False})))
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == BOB).update({"company": "ent-two"})
        self.db.commit()
        self._shift(BOB, MON, "14:00", "22:00")
        self._shift(BOB, TUE, "06:00", "14:00", published=0)   # 8h rest: a warning on Bob
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": FRI}).json()
        self.assertEqual([w["email"] for w in body["warnings"]], [BOB])
        self.assertFalse(body["reasonRequired"])
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": FRI})
        self.assertEqual((r.status_code, r.json()["published"]), (200, 1), r.text)
        # A warning on someone whose company asks: a reason it is.
        self._shift(AMY, MON, "14:00", "22:00")
        self._shift(AMY, TUE, "06:00", "14:00", published=0)
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": FRI}).json()
        self.assertEqual([w["email"] for w in body["warnings"]], [AMY])
        self.assertTrue(body["reasonRequired"])
        self.assertEqual(self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": FRI}).status_code, 400)

    def test_a_conflict_is_a_warning_too(self):
        sid = self._shift(AMY, MON, published=0)
        self.db.add(models.TimeOffRequest(id="to-1", employee_email=AMY, type="vacation", start_date=MON,
                                          end_date=MON, status="approved"))
        self.db.commit()
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": MON}).json()
        self.assertEqual([(w["shiftId"], w["kind"], w["text"]) for w in body["warnings"]],
                         [(sid, "conflict", "On approved time off that day (vacation).")])
        self.assertTrue(body["reasonRequired"])

    def test_publish_over_warnings_needs_a_reason_and_logs_it(self):
        a = self._shift(AMY, MON, "14:00", "22:00", published=0)
        b = self._shift(AMY, TUE, "06:00", "14:00", published=0)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": FRI})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(r.json()["detail"], "A reason is needed to share a schedule with warnings.")
        self.db.expire_all()
        self.assertEqual(self.db.query(models.ScheduledShift).filter(models.ScheduledShift.published == 1).count(), 0)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": FRI,
                                                                  "reason": "Short-staffed this week"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["published"], r.json()["warnings"]), (2, 1))
        pid = r.json()["publishId"]
        self.assertTrue(pid)
        # The reason lands on the warned shift's row only (Tuesday, the rest
        # warning); Monday's row carries the publish id and no reason.
        for sid in (a, b):
            rows = [e for e in self._log(sid) if e.action == "shared"]
            self.assertEqual(len(rows), 1)
            self.assertEqual((rows[0].actor, rows[0].reason, rows[0].publish_id),
                             (MGR, "Short-staffed this week" if sid == b else "", pid))
            self.assertEqual(json.loads(rows[0].after_json)["email"], AMY)
        self.assertEqual(json.loads([e for e in self._log(b) if e.action == "shared"][0].after_json)["warnings"],
                         ["Only 8h 00m rest before this shift (10h minimum)."])
        self.assertNotIn("warnings", json.loads([e for e in self._log(a) if e.action == "shared"][0].after_json))
        # Staff never see the reason or the warnings on a shared row.
        r = self.client.get(f"/timeclock/schedule/{b}/history")
        self.assertEqual(r.json()["entries"][0]["reason"], "Short-staffed this week")
        self.db.add(models.NexusGroup(id="g-view", name="view", allowed_modules="hr:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-view", email=AMY))
        self.db.commit()
        self._as(AMY)
        r = self.client.get(f"/timeclock/schedule/{b}/history")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(e["action"], e["reason"], "warnings" in (e["after"] or {})) for e in r.json()["entries"]],
                         [("shared", "", False)])
        self._as(MGR)
        last = json.loads(self.db.query(models.NexusSetting).filter(models.NexusSetting.key == "shift_last_publish").one().value)
        self.assertEqual((last["reason"], last["publishId"], last["by"]), ("Short-staffed this week", pid, MGR))
        # Nothing to warn about: no reason needed.
        self._shift(BOB, WED, published=0)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": FRI})
        self.assertEqual((r.status_code, r.json()["published"]), (200, 1), r.text)
        self.assertEqual(self._log("s-bob-2026-10-14-09:00")[-1].reason, "")


    def test_soft_conflicts_are_shown_but_never_demand_a_reason(self):
        # A pending request, availability and an overlap with another shift
        # are tagged `soft`; approved time off and a holiday are not.
        self._company_setting(ruleDailyOtHours=0)   # the overlap alone, not the hours
        sid = self._shift(AMY, MON, published=0)
        self.db.add(models.TimeOffRequest(id="to-p", employee_email=AMY, type="vacation", start_date=MON,
                                          end_date=MON, status="pending"))
        self.db.add(models.ShiftAvailability(id="av-1", employee_email=AMY, weekday=0, kind="unavailable"))
        self._shift(AMY, MON, "16:00", "20:00", published=0)    # overlaps 9-5
        self.db.commit()
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": MON, "end": MON}).json()
        mine = [(w["text"], w["kind"], w["soft"]) for w in body["warnings"] if w["shiftId"] == sid]
        self.assertEqual(mine, [("Overlaps another shift (4:00 PM - 8:00 PM on 10/12/2026).", "conflict", True),
                                ("Time off requested that day (vacation).", "conflict", True),
                                ("Marked unavailable on Mondays.", "conflict", True)])
        self.assertFalse(body["reasonRequired"], "heads-ups do not ask for a reason")
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": MON})
        self.assertEqual((r.status_code, r.json()["published"]), (200, 2), r.text)
        self.assertEqual(self._log(sid)[-1].reason, "")
        # Approved time off is a real conflict: a reason again.
        self.db.query(models.TimeOffRequest).filter(models.TimeOffRequest.id == "to-p").first().status = "approved"
        self._shift(AMY, TUE, published=0)
        self.db.add(models.TimeOffRequest(id="to-a", employee_email=AMY, type="sick", start_date=TUE,
                                          end_date=TUE, status="approved"))
        self.db.commit()
        body = self.client.get("/timeclock/schedule/publish/review", params={"start": TUE, "end": TUE}).json()
        self.assertEqual([(w["text"], w["soft"]) for w in body["warnings"]], [("On approved time off that day (sick).", False)])
        self.assertTrue(body["reasonRequired"])
        self.assertEqual(self.client.post("/timeclock/schedule/publish", json={"start_date": TUE, "end_date": TUE}).status_code, 400)

    def test_recent_shares_lists_the_ones_with_warnings(self):
        self._shift(AMY, MON, "14:00", "22:00", published=0)
        self._shift(AMY, TUE, "06:00", "14:00", published=0)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": FRI, "reason": "Approved by Neil"})
        self.assertEqual(r.status_code, 200, r.text)
        pid = r.json()["publishId"]
        self._shift(BOB, WED, published=0)
        self.assertEqual(self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": FRI}).status_code, 200)
        r = self.client.get("/timeclock/schedule/shares")
        self.assertEqual(r.status_code, 200, r.text)
        shares = r.json()["shares"]
        self.assertEqual([(x["publishId"], x["by"], x["byName"], x["people"], x["shifts"], x["warnings"], x["reason"], x["start"], x["end"]) for x in shares],
                         [(pid, MGR, "Mia Lee", 1, 2, 1, "Approved by Neil", MON, TUE)], "the clean share is not listed")
        self.assertTrue(shares[0]["at"].endswith("Z"))
        # Out of the window: nothing. A manager with nobody under them: nothing.
        self.assertEqual(self.client.get("/timeclock/schedule/shares", params={"start": "2020-01-01", "end": "2020-02-01"}).json()["shares"], [])
        self._as(OTHER)
        self.assertEqual(self.client.get("/timeclock/schedule/shares").json()["shares"], [])
        self._as(MGR)
        self.assertEqual(self.client.get("/timeclock/schedule/shares", params={"start": FRI, "end": MON}).status_code, 400)

    def test_an_empty_cell_still_has_the_history_of_a_removed_shift(self):
        sid = self.client.post("/timeclock/schedule", json={"employee_email": AMY, "work_date": MON}).json()["id"]
        self.assertEqual(self.client.get("/timeclock/schedule/history", params={"email": AMY, "date": MON}).json()["entries"], [],
                         "the shift is still there: its own history, not the cell's")
        self.assertEqual(self.client.delete(f"/timeclock/schedule/{sid}").status_code, 200)
        r = self.client.get("/timeclock/schedule/history", params={"email": AMY, "date": MON})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(e["action"], e["actor"]) for e in r.json()["entries"]], [("removed", MGR), ("created", MGR)])
        self.assertEqual((r.json()["email"], r.json()["date"]), (AMY, MON))
        # Another day, another person: nothing. Out of scope: refused.
        self.assertEqual(self.client.get("/timeclock/schedule/history", params={"email": AMY, "date": TUE}).json()["entries"], [])
        self._as(OTHER)
        self.assertEqual(self.client.get("/timeclock/schedule/history", params={"email": AMY, "date": MON}).status_code, 403)
        # Staff: only what was shared - a draft that came and went is nothing.
        self.db.add(models.NexusGroup(id="g-view", name="view", allowed_modules="hr:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-view", email=AMY))
        self.db.commit()
        self._as(AMY)
        r = self.client.get("/timeclock/schedule/history", params={"email": AMY, "date": MON})
        self.assertEqual((r.status_code, r.json()["entries"]), (200, []), r.text)

    def test_offboarding_takes_future_shifts_off_the_schedule(self):
        import shift_offboard
        from datetime import date as _date
        today = _date(2026, 10, 13)
        past = self._shift(AMY, MON)                       # yesterday: stays
        now_ = self._shift(AMY, TUE)                       # today: stays
        pub = self._shift(AMY, WED)                        # published, future: marked for removal
        draft = self._shift(AMY, THU, published=0)         # draft, future: gone
        gone = self._shift(AMY, FRI, pending_delete=1)     # already going: untouched
        out = shift_offboard.remove_future_shifts(self.db, AMY, "hr.bot", today=today)
        self.db.commit()
        self.assertEqual(out, {"pendingDelete": 1, "deleted": 1})
        rows = {r.id: r for r in self.db.query(models.ScheduledShift).all()}
        self.assertEqual((rows[past].pending_delete, rows[now_].pending_delete, rows[pub].pending_delete, rows[gone].pending_delete), (0, 0, 1, 1))
        self.assertNotIn(draft, rows)
        self.assertEqual([(e.action, e.reason, e.actor) for e in self._log(pub)], [("removed", "offboarded", "hr.bot")])
        self.assertEqual([(e.action, e.reason) for e in self._log(draft)], [("removed", "offboarded")])
        self.assertEqual(self._log(past), [])
        # The schedule shows the removal; the empty Thursday cell keeps the story.
        r = self.client.get("/timeclock/schedule/history", params={"email": AMY, "date": THU})
        self.assertEqual([e["action"] for e in r.json()["entries"]], ["removed"])
        # Through People: the status change calls it in the same session.
        amy = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == AMY).first()
        self._shift(AMY, "2026-12-01")
        self._as(ADMIN)
        r = self.client.post(f"/hr/employees/{amy.id}/status", json={"status": "offboarded", "reason": "left"})
        self.assertEqual(r.status_code, 200, r.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == "s-amy-2026-12-01-09:00").first().pending_delete, 1)


class HistoryTests(_Case):
    def test_created_edited_shared_with_actors(self):
        r = self.client.post("/timeclock/schedule", json={"employee_email": AMY, "work_date": MON,
                                                          "start_hhmm": "09:00", "end_hhmm": "17:00", "label": "Front"})
        self.assertEqual(r.status_code, 200, r.text)
        sid = r.json()["id"]
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": MON})
        self.assertEqual(r.status_code, 200, r.text)
        self._as(ADMIN)
        r = self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": AMY, "work_date": MON,
                                                                  "start_hhmm": "10:00", "end_hhmm": "18:00"})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.client.get(f"/timeclock/schedule/{sid}/history")
        self.assertEqual(r.status_code, 200, r.text)
        entries = r.json()["entries"]
        self.assertEqual([(e["action"], e["actor"], e["actorName"]) for e in entries],
                         [("edited", ADMIN, "Ada Lee"), ("shared", MGR, "Mia Lee"), ("created", MGR, "Mia Lee")])
        self.assertEqual(entries[0]["before"]["start"], "09:00")
        after = entries[0]["after"]
        self.assertEqual({k: v for k, v in after.items() if k in ("start", "end", "label", "shiftId", "date", "email", "openSlots")},
                         {"start": "10:00", "end": "18:00", "label": "Front", "shiftId": "", "date": MON, "email": AMY, "openSlots": 0})
        # The snapshot also carries the lunch, the team, the zone and a note
        # fingerprint (never the note) - Oct 15.
        self.assertEqual((after["breakMin"], after.get("groupId", ""), after["noteHash"]), (0, "", ""))
        self.assertNotIn("note", after)
        self.assertEqual(entries[2]["before"], None)
        self.assertEqual(entries[2]["after"]["label"], "Front")
        self.assertTrue(all(e["at"] for e in entries))
        # The stamp is UTC and SAYS so: a bare "2026-10-15T07:15:00" is read
        # as local time by a browser (a 12:15 AM share showed as 7:15 AM).
        self.assertTrue(all(e["at"].endswith("Z") for e in entries), entries[0]["at"])
        self.assertEqual(datetime.strptime(entries[0]["at"][:19], "%Y-%m-%dT%H:%M:%S").date(),
                         datetime.now(timezone.utc).date())
        # Shared again after the edit, with a reason this time.
        self._as(MGR)
        self._shift(AMY, MON, "19:00", "23:00", published=0)   # overlap-free, but only 1h rest -> warning
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": MON, "reason": "Coverage"})
        self.assertEqual(r.status_code, 200, r.text)
        top = self.client.get(f"/timeclock/schedule/{sid}/history").json()["entries"][0]
        self.assertEqual((top["action"], top["reason"], top["before"]["start"], top["after"]["start"]),
                         ("shared", "Coverage", "09:00", "10:00"))

    def test_out_of_scope_is_refused_and_own_shift_is_not(self):
        sid = self._shift(AMY, MON)
        self._as(OTHER)
        r = self.client.get(f"/timeclock/schedule/{sid}/history")
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.client.get("/timeclock/schedule/nope/history").status_code, 404)
        own = self._shift(OTHER, MON)
        self.assertEqual(self.client.get(f"/timeclock/schedule/{own}/history").status_code, 200)

    def test_staff_see_nothing_that_is_still_waiting_to_be_shared(self):
        sid = self.client.post("/timeclock/schedule", json={"employee_email": AMY, "work_date": MON}).json()["id"]
        self.assertEqual(self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": MON}).status_code, 200)
        self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": AMY, "work_date": MON, "start_hhmm": "10:00"})
        self.assertEqual([e["action"] for e in self.client.get(f"/timeclock/schedule/{sid}/history").json()["entries"]],
                         ["edited", "shared", "created"])
        # Amy reads the schedule as a People viewer (a plain employee has no
        # schedule route at all): her own shift, but the edit is the
        # manager's until it is shared.
        self.db.add(models.NexusGroup(id="g-view", name="view", allowed_modules="hr:viewer"))
        self.db.add(models.NexusGroupMember(group_id="g-view", email=AMY))
        self.db.commit()
        self._as(AMY)
        r = self.client.get(f"/timeclock/schedule/{sid}/history")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([e["action"] for e in r.json()["entries"]], ["shared", "created"])
        self._as(MGR)
        self.assertEqual(self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": MON}).status_code, 200)
        self._as(AMY)
        self.assertEqual([e["action"] for e in self.client.get(f"/timeclock/schedule/{sid}/history").json()["entries"]],
                         ["shared", "edited", "shared", "created"])
        # A draft is not hers to see at all.
        draft = self._shift(AMY, TUE, published=0)
        self.assertEqual(self.client.get(f"/timeclock/schedule/{draft}/history").status_code, 404)
        # shared_only on its own: a weather call after the last share stays.
        rows = [{"action": "weather"}, {"action": "removed"}, {"action": "shared"}, {"action": "edited"}, {"action": "created"}]
        self.assertEqual([e["action"] for e in shift_log.shared_only(rows)], ["weather", "shared", "edited", "created"])
        self.assertEqual(shift_log.shared_only([{"action": "created"}]), [])

    def test_every_write_path_leaves_a_row(self):
        # create -> move -> delete (draft: gone, the log stays)
        sid = self.client.post("/timeclock/schedule", json={"employee_email": AMY, "work_date": MON}).json()["id"]
        r = self.client.post(f"/timeclock/schedule/{sid}/move", json={"employee_email": AMY, "work_date": TUE})
        self.assertEqual(r.status_code, 200, r.text)
        moved = r.json()["shift"]["id"]
        self.assertEqual([e.action for e in self._log(sid)], ["created", "moved"])
        self.assertEqual([e.action for e in self._log(moved)], ["moved"])
        self.assertEqual(json.loads(self._log(moved)[0].before_json)["date"], MON)
        self.assertEqual(self.client.delete(f"/timeclock/schedule/{moved}").status_code, 200)
        self.assertEqual([e.action for e in self._log(moved)], ["moved", "removed"])
        # open slot -> assigned
        r = self.client.post("/timeclock/schedule", json={"employee_email": "", "work_date": WED, "open_slots": 2,
                                                          "group_id": GROUP})
        self.assertEqual(r.status_code, 200, r.text)
        oid = r.json()["id"]
        r = self.client.post(f"/timeclock/schedule/{oid}/assign", json={"employee_email": BOB})
        self.assertEqual(r.status_code, 200, r.text)
        rows = self._log(r.json()["id"])
        self.assertEqual([(e.action, json.loads(e.before_json)["openSlots"], json.loads(e.after_json)["email"]) for e in rows],
                         [("assigned", 2, BOB)])
        self.assertEqual([e.action for e in self._log(oid)], ["created", "assigned"])
        # published: edit -> discard; delete -> discard-all; clear; copy; bulk
        pub = self._shift(AMY, THU)
        self.client.patch(f"/timeclock/schedule/{pub}", json={"employee_email": AMY, "work_date": THU, "start_hhmm": "10:00"})
        self.client.post(f"/timeclock/schedule/{pub}/discard")
        self.client.delete(f"/timeclock/schedule/{pub}")
        self.client.post("/timeclock/schedule/discard-all", json={"start_date": THU, "end_date": THU})
        self.assertEqual([e.action for e in self._log(pub)], ["edited", "discarded", "removed", "discarded"])
        r = self.client.post("/timeclock/schedule/copy", json={"source_start": THU, "source_end": THU,
                                                               "target_start": "2026-10-22", "emails": [AMY]})
        self.assertEqual((r.status_code, r.json()["created"]), (200, 1), r.text)
        copied = self.db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.action == "copied").all()
        self.assertEqual([(json.loads(e.before_json)["date"], e.work_date) for e in copied], [(THU, "2026-10-22")])
        r = self.client.post("/timeclock/schedule/clear", json={"start_date": "2026-10-22", "end_date": "2026-10-22"})
        self.assertEqual((r.status_code, r.json()["removed"]), (200, 1), r.text)
        self.assertEqual([e.action for e in self._log(copied[0].shift_id)], ["copied", "cleared"])
        r = self.client.post("/timeclock/schedule/bulk", json={"emails": [BOB], "start_date": FRI, "end_date": FRI,
                                                               "start_hhmm": "08:00", "end_hhmm": "12:00"})
        self.assertEqual((r.status_code, r.json()["created"]), (200, 1), r.text)
        self.assertEqual(self.db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.action == "created",
                                                                     models.ShiftChangeLog.reason == "Bulk fill").count(), 1)
        self.assertEqual(self.db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.at == "").count(), 0)

    def test_snapshot_shapes(self):
        row = models.ScheduledShift(id="x", employee_email="A@b.c", work_date=MON, start_hhmm="09:00", end_hhmm="17:00",
                                    label="L", shift_id="p", open_slots=0, weather_status="cancelled")
        self.assertEqual(shift_log.snapshot(row), {"start": "09:00", "end": "17:00", "label": "L", "shiftId": "p",
                                                   "date": MON, "email": "a@b.c", "openSlots": 0, "weatherStatus": "cancelled"})
        self.assertEqual(shift_log.snapshot({"start": "09:00", "end": "17:00", "date": MON, "email": ""}),
                         {"start": "09:00", "end": "17:00", "date": MON, "email": ""})
        self.assertEqual(shift_log.snapshot(None, weather="kept"), {"weather": "kept"})


if __name__ == "__main__":
    unittest.main()
