"""A person's own Time Sheets waiting on them (Neil, 11/12/2026, timesheet_due.py).

The Daily Briefing, the Weekly Digest, My Briefing / My Day and the bell all
read ONE rule: once a pay period ends - hourly bi-weekly, salaried bi-weekly
or monthly, contractors (India contractors included) on the month - the
person is asked to check and submit it, with a button to that period, and
the row stays until the time sheet is finalized.

Runs against its own throwaway SQLite database:
    python -m pytest test_timesheet_due.py -q
"""
import os
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")
os.environ.setdefault("NEXUS_APP_URL", "https://nexus.example.com")

import cache  # noqa: E402
import daily_briefing  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import reminders  # noqa: E402
import timesheet_due  # noqa: E402
import timesheet_review as tsr  # noqa: E402

EMP = "pat.due@greensglobal.com"
BOSS = "boss.due@greensglobal.com"
ENT = "ent-due"


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
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
        for m in (models.NexusEmployee, models.PayrollRate, models.TimePunch, models.TimesheetReview,
                  models.TimeApproval, models.NexusNotification, models.NexusGroup, models.NexusGroupMember,
                  models.HrEntity, models.PunchRequest, models.HrSignRequest, models.HrSignParty):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENT, name="Due Co"))
        self.db.add(models.NexusEmployee(id="e-boss", work_email=BOSS, first_name="Maria", last_name="Lopez",
                                         company=ENT, status="active"))
        self.db.commit()
        self.today = "2026-11-16"
        p = mock.patch("routers.timeclock._employee_today", lambda db, email: self.today)
        p.start()
        self.addCleanup(p.stop)
        cache.timesheet_due.invalidate()

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    # ── helpers ──
    def person(self, email=EMP, *, pay_type="hourly", manager=BOSS, status="active", **kw):
        self.db.add(models.NexusEmployee(id=f"e-{email}", work_email=email, first_name="Pat", last_name="Due",
                                         company=ENT, status=status, manager_email=manager, **kw))
        self.db.add(models.PayrollRate(employee_email=email, pay_type=pay_type, hourly_rate=20,
                                       monthly_salary=3000, full_day_hours=8, overtime_rule="federal"))
        self.db.commit()

    def shift(self, day, email=EMP, out=True, offset=0):
        n = self.db.query(models.TimePunch).count()
        self.db.add(models.TimePunch(id=f"p{n}", employee_email=email, kind="in", at=f"{day}T16:00:00",
                                     local_date=day, tz_offset_min=offset, created_at=f"{day}T16:00:00"))
        if out:
            self.db.add(models.TimePunch(id=f"p{n}o", employee_email=email, kind="out", at=f"{day}T23:59:00",
                                         local_date=day, tz_offset_min=offset, created_at=f"{day}T23:59:00"))
        self.db.commit()

    def on(self, day):
        self.today = day
        cache.timesheet_due.invalidate()

    def titles(self, email=EMP):
        cache.timesheet_due.invalidate()
        return [r["title"] for r in daily_briefing._timecard_rows(self.db, email)]

    def rows(self, email=EMP):
        cache.timesheet_due.invalidate()
        return daily_briefing._timecard_rows(self.db, email)


class WhenItShowsTests(_Case):
    def test_after_the_period_ends_with_a_button_to_that_period(self):
        self.person()
        self.shift("2026-11-03")
        [row] = self.rows()
        self.assertEqual(row["title"], "Submit Your Time Sheet")
        self.assertEqual(row["module"], "timecard")
        self.assertIn("Pay period 11/01/2026 - 11/14/2026 ended Saturday", row["detail"])
        self.assertIn("worked", row["detail"])
        self.assertIn("send it to Maria Lopez for approval so you are paid on time", row["detail"])
        label, url = row["cta"]
        self.assertEqual(label, "Review and Submit")
        link = urlsplit(url)
        self.assertEqual(link.path, "/timeclock/timesheet")
        self.assertEqual(parse_qs(link.query), {"start": ["2026-11-01"], "type": ["hourly"], "do": ["submit"]})
        self.assertEqual(row["urgency"], "overdue")
        self.assertEqual(row["since"], "2026-11-15T00:00:00")

    def test_on_the_last_day_it_says_closes_today(self):
        self.person()
        self.shift("2026-11-03")
        self.on("2026-11-14")
        [row] = self.rows()
        self.assertEqual(row["title"], "Submit Your Time Sheet - Closes Today")
        self.assertEqual(row["cta"][0], "Review and Submit")
        self.assertEqual(row["urgency"], "today")

    def test_nothing_while_the_period_is_still_running(self):
        self.person()
        self.shift("2026-11-03")
        self.on("2026-11-10")
        self.assertEqual(self.titles(), [])

    def test_a_missing_clock_out_says_fix_it_first(self):
        self.person()
        self.shift("2026-11-03", out=False)
        [row] = self.rows()
        self.assertEqual(row["title"], "Fix Your Time Sheet, Then Submit")
        self.assertIn("no clock-out", row["detail"])
        self.assertEqual(row["cta"][0], "Fix and Submit")

    def test_every_open_period_stays_until_it_is_finalized(self):
        self.person()
        self.shift("2026-10-20")
        self.shift("2026-11-03")
        self.on("2026-11-20")
        rows = self.rows()
        self.assertEqual([r["title"] for r in rows], ["Submit Your Time Sheet"] * 2)
        self.assertIn("10/18/2026 - 10/31/2026 ended 10/31/2026", rows[0]["detail"])   # oldest first
        self.assertIn("11/01/2026 - 11/14/2026", rows[1]["detail"])
        # The October period finalized: only November is left.
        self.db.add(models.TimeApproval(id="fin-1", employee_email=EMP, period_start="2026-10-18",
                                        period_end="2026-10-31", approved_by="hr@x.com", kind="final",
                                        approved_at="2026-11-02T00:00:00", revoked=0))
        self.db.commit()
        self.assertEqual(len(self.rows()), 1)

    def test_nothing_before_time_sheet_review_began(self):
        self.person()
        self.shift("2026-09-10")
        self.on("2026-11-20")
        self.assertEqual(self.titles(), [])


class WhoTests(_Case):
    def test_monthly_salaried_by_the_calendar_month(self):
        self.person(pay_type="fixed")
        self.shift("2026-10-05")
        self.on("2026-11-01")
        [row] = self.rows()
        self.assertEqual(row["title"], "Submit Your Time Sheet")
        self.assertIn("October 2026 (10/01/2026 - 10/31/2026) ended yesterday", row["detail"])
        self.assertIn("type=fixed", row["cta"][1])

    def test_india_contractor_on_their_own_month(self):
        self.person(pay_type="fixed", employment_type="contractor", country="IN")
        self.shift("2026-10-05", offset=-330)
        self.on("2026-11-01")
        [row] = self.rows()
        self.assertIn("October 2026", row["detail"])
        self.assertEqual(row["cta"][0], "Review and Submit")

    def test_salaried_on_bi_weekly_pay_by_the_pay_period(self):
        self.person(pay_type="fixed", compensation={"payBasis": "salary", "frequency": "biweekly"})
        self.shift("2026-11-03")
        [row] = self.rows()
        self.assertIn("Pay period 11/01/2026 - 11/14/2026", row["detail"])

    def test_exempt_inactive_and_no_punches_get_nothing(self):
        self.person()
        self.assertEqual(self.titles(), [])                     # no punch in the period
        self.shift("2026-11-03")
        self.db.add(models.NexusGroup(id="g-ex", name="Leadership", time_tracking_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-ex", email=EMP))
        self.db.commit()
        self.assertEqual(self.titles(), [])                     # exempt
        self.db.query(models.NexusGroupMember).delete()
        self.db.query(models.NexusEmployee).filter_by(work_email=EMP).update({"status": "terminated"})
        self.db.commit()
        self.assertEqual(self.titles(), [])                     # left

    def test_no_manager_set_says_hr_reviews_it(self):
        self.person(manager="")
        self.shift("2026-11-03")
        [row] = self.rows()
        self.assertEqual(row["title"], "Check Your Time Sheet")
        self.assertIn("no manager set", row["detail"])
        self.assertEqual(row["cta"][0], "Review Time Sheet")


class ReviewStateTests(_Case):
    def test_submitted_moves_to_updates_until_finalized(self):
        self.person()
        self.shift("2026-11-03")
        tsr.submit(self.db, EMP, "2026-11-01")
        self.assertEqual(self.titles(), [])
        cache.timesheet_due.invalidate()
        [upd] = daily_briefing._timecard_update_rows(self.db, EMP)
        self.assertEqual(upd["title"], "Time Sheet With Maria Lopez for Review")
        self.assertNotIn("cta", upd)
        sections = daily_briefing.build_sections(self.db, EMP, "2026-11-15T00:00:00", self.today)
        self.assertIn(upd["title"], [r["title"] for r in sections["needs_to_know"]])

    def test_sent_back_asks_to_resubmit_with_the_note(self):
        self.person()
        self.shift("2026-11-03")
        r = tsr.submit(self.db, EMP, "2026-11-01")
        tsr.send_back(self.db, r, BOSS, "Please add your lunch break.")
        [row] = self.rows()
        self.assertEqual(row["title"], "Resubmit Your Time Sheet")
        self.assertIn('Maria Lopez sent 11/01/2026 - 11/14/2026 back: "Please add your lunch break."', row["detail"])
        self.assertEqual(row["cta"][0], "Review and Resubmit")

    def test_approved_it_is_the_signature_row_in_the_time_sheet_table(self):
        self.person()
        self.shift("2026-11-03")
        r = tsr.approve_period(self.db, EMP, "2026-11-01", BOSS)
        self.assertEqual(r.status, "signing")
        self.assertEqual(self.titles(), [])
        cache.timesheet_due.invalidate()
        self.assertEqual(daily_briefing._timecard_update_rows(self.db, EMP), [])
        [sign] = daily_briefing._esign_action_rows(self.db, EMP)
        self.assertEqual(sign["title"], "Sign Your Time Sheet")
        self.assertEqual(sign["module"], "timecard")
        self.assertEqual(sign["cta"][0], "Sign Time Sheet")
        self.assertIn("/workday/sign:", sign["cta"][1])
        self.assertIn("Maria Lopez approved 11/01/2026 - 11/14/2026", sign["detail"])


class BellTests(_Case):
    def _bells(self):
        self.db.expire_all()
        return [(n.ref_id, n.actioned) for n in self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.type == timesheet_due.BELL_TYPE,
                        models.NexusNotification.recipient == EMP).order_by(models.NexusNotification.ref_id).all()]

    def test_last_day_and_the_day_after_then_quiet(self):
        self.person(pay_type="fixed")      # salaried people get the bell too now
        self.shift("2026-10-05")
        self.on("2026-10-31")
        b = timesheet_due.bell_for(self.db, EMP)
        self.assertEqual(b["ref_id"], "2026-10-01")
        self.assertIn("closes today", b["body"])
        self.assertEqual(b["action"]["start"], "2026-10-01")
        self.on("2026-11-01")
        self.assertEqual(timesheet_due.bell_for(self.db, EMP)["ref_id"], "2026-10-01:closed")
        self.on("2026-11-02")
        self.assertIsNone(timesheet_due.bell_for(self.db, EMP))

    def test_the_scan_sends_it_and_submitting_settles_it(self):
        self.person()
        self.shift("2026-11-03")
        self.on("2026-11-14")
        reminders.run_daily_scan()
        self.assertEqual(self._bells(), [("2026-11-01", False)])
        tsr.submit(self.db, EMP, "2026-11-01")
        self.assertEqual(self._bells(), [("2026-11-01", True)])
        self.on("2026-11-15")
        reminders.run_daily_scan()
        self.assertEqual(self._bells(), [("2026-11-01", True)])   # sent - no day-after bell


class RenderTests(_Case):
    def test_the_email_leads_with_the_time_sheet_and_its_button(self):
        self.person()
        self.shift("2026-11-03")
        task = {"title": "Walk the site", "detail": "Due today", "url": "https://nexus.example.com/tasks/mine",
                "module": "tasks"}
        rows = [task] + self.rows()
        _, html = daily_briefing.render_email("Pat", self.today, {"action_required": rows})
        self.assertLess(html.index("Time Sheet <span"), html.index("Tasks <span"))
        self.assertIn(">Review and Submit</a>", html)
        self.assertIn("do=submit", html)

    def test_the_page_row_carries_the_button_and_urgency(self):
        self.person()
        self.shift("2026-11-03")
        cache.timesheet_due.invalidate()
        page = daily_briefing.my_briefing(self.db, EMP)
        [section] = [s for s in page["sections"] if s["key"] == "action_required"]
        [row] = [r for r in section["rows"] if r["module"] == "timecard"]
        self.assertEqual(row["cta"]["label"], "Review and Submit")
        self.assertTrue(row["cta"]["path"].startswith("/timeclock/timesheet?start=2026-11-01"))
        self.assertEqual(row["urgency"], "overdue")

    def test_a_failure_never_costs_the_whole_briefing(self):
        self.person()
        self.shift("2026-11-03")
        with mock.patch("timesheet_due.due", side_effect=RuntimeError("boom")):
            cache.timesheet_due.invalidate()
            self.assertEqual(daily_briefing._timecard_rows(self.db, EMP), [])


if __name__ == "__main__":
    unittest.main()
