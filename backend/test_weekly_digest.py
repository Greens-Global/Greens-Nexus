"""
Weekly Digest (Neil, Sep 28 2026) - weekly_digest.py.

  - Default schedule: every Monday, 2 hours before the person's shift, in the
    shift's own zone; someone with no shift that Monday gets it at the
    fallback time. Once per week. Off until an admin turns it on.
  - Content: only the person's overdue tasks (open, assigned to them, past
    due), oldest first, with their due dates; a manager also gets one line
    per direct report with overdue work. Nothing overdue = no email.
  - Each task carries Extend Due Date, which follows the app's rule: an
    agreed date is changed and counted as an extension, a date not agreed
    yet is proposed to the requester.
  - The shared renderer still produces the daily email unchanged.
  - PUT /weekly-digest/config validates its keys.

The clock is frozen at Monday 09/28/2026 14:10 UTC (7:10 AM Pacific, 7:40 PM
India). Uses a throwaway sqlite file; graph_mail.send_mail is mocked.

Run with: python -m unittest test_weekly_digest -v
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
os.environ["NEXUS_DEV_EMAIL"] = "admin@greensglobal.com"

from fastapi import BackgroundTasks, FastAPI, HTTPException   # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import daily_briefing                                    # noqa: E402
import weekly_digest                                     # noqa: E402
import database                                          # noqa: E402
import models                                            # noqa: E402
import task_mail_actions                                 # noqa: E402
from routers import mail_actions                         # noqa: E402
from routers import weekly_digest as digest_router       # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

FIXED = datetime(2026, 9, 28, 14, 10, tzinfo=timezone.utc)   # Monday 7:10 AM Pacific
TODAY = date(2026, 9, 28)
AMY = "amy@greensglobal.com"


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
        for m in (models.NexusWeeklyDigestLog, models.NexusSetting, models.NexusEmployee, models.Task,
                  models.TaskProject, models.Shift, models.ShiftAssignment, models.ScheduledShift,
                  models.TaskTicket, models.TimeOffRequest):
            self.db.query(m).delete()
        self.db.commit()
        self.sent = []
        patches = [
            mock.patch.object(weekly_digest, "datetime", _FrozenDT),
            mock.patch.object(daily_briefing, "datetime", _FrozenDT),
            mock.patch.object(daily_briefing, "_shift_local_now", _frozen_local_now),
            mock.patch.object(daily_briefing, "_logo_url", lambda db: ""),
            mock.patch.object(weekly_digest.graph_mail, "send_mail", lambda **kw: self.sent.append(kw)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _emp(self, email, **kw):
        self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0].title(),
                                         last_name="", work_email=email, **kw))
        self.db.commit()

    def _task(self, title, due, assignee=AMY, **kw):
        tid = gen_id()
        self.db.add(models.Task(id=tid, title=title, due_on=due, assignee_email=assignee,
                                assignee_emails=[assignee], **kw))
        self.db.commit()
        return tid

    def _shift(self, email, start, tz="America/Los_Angeles", days="1,2,3,4,5"):
        sid = gen_id()
        self.db.add(models.Shift(id=sid, name="Preset", start_hhmm=start, days=days, timezone=tz))
        self.db.add(models.ShiftAssignment(id=gen_id(), employee_email=email, shift_id=sid))
        self.db.commit()

    def _config(self, **kw):
        cfg = {"mode": "live", "test_recipients": []}
        cfg.update(kw)
        weekly_digest.save_settings(self.db, cfg, "admin@greensglobal.com")

    def _scan(self):
        return weekly_digest._scan_once()

    def _logs(self, email=AMY):
        self.db.expire_all()
        return (self.db.query(models.NexusWeeklyDigestLog)
                .filter(models.NexusWeeklyDigestLog.employee_email == email).all())


class DefaultsTests(_Case):
    def test_defaults_are_monday_two_hours_before_shift_and_off(self):
        cfg = weekly_digest.get_settings(self.db)
        self.assertEqual(cfg["mode"], "off")
        self.assertEqual(cfg["sendDay"], 1)
        self.assertEqual(cfg["leadMinutes"], 120)
        self.assertIs(cfg["includeNoShift"], True)

    def test_off_mode_logs_but_never_mails(self):
        self._emp(AMY)
        self._shift(AMY, "09:00")
        self._task("Old task", "2026-09-20")
        self.assertEqual(self._scan(), 1)
        self.assertEqual(self.sent, [])
        logs = self._logs()
        self.assertEqual((logs[0].sent_at, logs[0].overdue_count), ("", 1))


class ScheduleTests(_Case):
    def setUp(self):
        super().setUp()
        self._emp(AMY)
        self._task("Old task", "2026-09-20")

    def test_monday_two_hours_before_the_shift(self):
        self._shift(AMY, "09:00")          # window opens 7:00 AM; it is 7:10
        self._config()
        self.assertEqual(self._scan(), 1)
        self.assertEqual([s["to"] for s in self.sent], [[AMY]])
        self.assertEqual(self._logs()[0].week_start, "2026-09-28")

    def test_not_earlier_than_two_hours_before(self):
        self._shift(AMY, "09:30")          # window opens 7:30 AM
        self._config()
        self.assertEqual(self._scan(), 0)

    def test_not_once_the_shift_has_started(self):
        self._shift(AMY, "07:00")
        self._config(includeNoShift=False)
        self.assertEqual(self._scan(), 0)

    def test_uses_the_shifts_own_zone(self):
        self._shift(AMY, "21:00", tz="Asia/Kolkata")   # 7:40 PM IST, window from 7:00 PM
        self._config()
        self.assertEqual(self._scan(), 1)
        self.assertIn("Good evening", self.sent[0]["html"])

    def test_lead_minutes_moves_the_window(self):
        self._shift(AMY, "10:00")
        self._config(leadMinutes=180)      # 3 hours before 10:00 = 7:00
        self.assertEqual(self._scan(), 1)

    def test_only_on_the_send_day(self):
        self._shift(AMY, "09:00")
        self._config(sendDay=2)
        self.assertEqual(self._scan(), 0)

    def test_once_a_week(self):
        self._shift(AMY, "09:00")
        self._config()
        self._scan()
        self.assertEqual(self._scan(), 0)
        self.assertEqual(len(self.sent), 1)

    def test_no_shift_that_monday_gets_the_fallback_time(self):
        self._shift(AMY, "09:00", days="6,7")   # weekend-only preset
        self._config(defaultSendTime="07:00")
        self.assertEqual(self._scan(), 1)

    def test_no_shift_fallback_can_be_turned_off(self):
        self._config(defaultSendTime="07:00", includeNoShift=False)
        self.assertEqual(self._scan(), 0)

    def test_no_shift_not_before_the_fallback_time(self):
        self._config(defaultSendTime="08:00")
        self.assertEqual(self._scan(), 0)

    def test_test_mode_goes_to_test_recipients_only(self):
        self._shift(AMY, "09:00")
        self._config(mode="test", test_recipients=["qa@greensglobal.com"])
        self._scan()
        self.assertEqual(self.sent[0]["to"], ["qa@greensglobal.com"])
        self.assertTrue(self.sent[0]["subject"].startswith(f"[TEST -> {AMY}]"))
        # Links that act as Amy are not in a copy someone else reads.
        self.assertNotIn("Extend Due Date", self.sent[0]["html"])
        self.assertNotIn("mail-actions", self.sent[0]["html"])
        self.assertIn(">Open</a>", self.sent[0]["html"])

    def test_inactive_and_external_people_are_skipped(self):
        for who, kw in (("gone@greensglobal.com", {"status": "offboarded"}),
                        ("vendor@example.com", {"identity_type": "external"})):
            self._emp(who, **kw)
            self._task("Theirs", "2026-09-01", assignee=who)
        self._config(defaultSendTime="07:00")
        self._scan()
        self.assertEqual([s["to"] for s in self.sent], [[AMY]])

    def test_nothing_overdue_sends_nothing(self):
        self.db.query(models.Task).delete()
        self._task("Future", "2026-10-15")
        self._config(defaultSendTime="07:00")
        self._scan()
        self.assertEqual(self.sent, [])
        self.assertEqual(self._logs()[0].sent_at, "")


class DueThisWeekTests(_Case):
    """Oct 2: what is coming due, beside Overdue - today through six days on.
    A recurring series keeps one open occurrence now, so its next date shows
    here instead of as a pile of copies."""

    def test_due_this_week_lists_today_through_six_days_on_soonest_first(self):
        self._emp(AMY)
        self._task("Overdue one", "2026-09-27")
        self._task("Thursday", "2026-10-01")
        self._task("Today", "2026-09-28")
        self._task("Sunday", "2026-10-04")
        self._task("Next Monday", "2026-10-05")
        self._task("Done", "2026-09-30", completed=True)
        self._task("Bob's", "2026-09-29", assignee="bob@greensglobal.com")
        s = weekly_digest.build_sections(self.db, AMY, TODAY)
        self.assertEqual([r["title"] for r in s["due_week"]], ["Today", "Thursday", "Sunday"])
        self.assertEqual(s["due_week"][1]["detail"], "Due Thu 10/01/2026")
        self.assertEqual([r["title"] for r in s["overdue"]], ["Overdue one"])   # not repeated

    def test_a_recurring_task_says_so(self):
        self._emp(AMY)
        self._task("Payroll Import", "2026-09-30", recurrence={"freq": "monthly", "interval": 1}, status="recurring")
        [row] = weekly_digest.build_sections(self.db, AMY, TODAY)["due_week"]
        self.assertEqual(row["detail"], "Due Wed 09/30/2026 - recurring")

    def test_the_email_has_the_section_and_only_due_work_is_enough_to_send(self):
        self._emp(AMY)
        self.db.query(models.Task).delete()
        self._task("Thursday", "2026-10-01")
        self._config(defaultSendTime="07:00")
        self._scan()
        html = self.sent[0]["html"]
        self.assertIn("Due This Week", html)
        self.assertIn("Due Thu 10/01/2026", html)

    def test_the_daily_briefing_puts_tasks_due_today_under_action_required_once(self):
        import daily_briefing
        self._emp(AMY)
        today = self._task("Payroll Import", "2026-09-28", owner_email="boss@greensglobal.com")
        self._task("Tomorrow", "2026-09-29")
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=today, entity_title="Payroll Import",
                                        type="commented", actor_email="boss@greensglobal.com",
                                        at="2026-09-28T01:00:00", detail="commented"))
        self.db.commit()
        s = daily_briefing.build_sections(self.db, AMY, "2026-09-27T00:00:00", "2026-09-28")
        due = [r for r in s["action_required"] if r.get("task_id") == today]
        self.assertEqual([(r["title"], r["detail"]) for r in due], [("Payroll Import", "Due today")])
        self.assertNotIn(today, [r.get("task_id") for r in s.get("needs_to_know", [])])   # not twice
        self.assertNotIn("Tomorrow", [r["title"] for r in s["action_required"]])


class ContentTests(_Case):
    def test_overdue_is_open_assigned_past_due_oldest_first(self):
        self._emp(AMY)
        self.db.add(models.TaskProject(id="p1", name="Office Move"))
        self._task("Newer overdue", "2026-09-25", project_id="p1", code="T-2")
        self._task("Oldest overdue", "2026-09-01")
        for title, kw in (("Done", {"completed": True}), ("Deleted", {"deleted_at": "2026-09-02T00:00:00"}),
                          ("A section", {"type": "section"})):
            self._task(title, "2026-09-01", **kw)
        self._task("Due today", "2026-09-28")
        self._task("No date", "")
        self._task("Someone else's", "2026-09-01", assignee="bob@greensglobal.com")
        rows, team = weekly_digest.overdue_rows(self.db, AMY, TODAY, {})
        self.assertEqual(team, [])
        self.assertEqual([r["title"] for r in rows], ["Oldest overdue", "Newer overdue"])
        self.assertEqual(rows[0]["detail"], "Due 09/01/2026 - 27 days overdue")
        self.assertEqual(rows[1]["detail"], "Due 09/25/2026 - 3 days overdue - Office Move")
        self.assertNotIn("ref", rows[1])   # no task ID in the digest (Oct 1)
        self.assertTrue(rows[0]["task_extend"])

    def test_manager_gets_one_line_per_report(self):
        self._emp("boss@greensglobal.com")
        self._emp("bob@greensglobal.com", manager_email="boss@greensglobal.com")
        for i in range(5):
            self._task(f"Bob {i}", f"2026-09-0{i + 1}", assignee="bob@greensglobal.com")
        sections = weekly_digest.build_sections(self.db, "boss@greensglobal.com", TODAY)
        self.assertNotIn("overdue", sections)   # the boss has nothing overdue themselves
        rows = sections["team_overdue"]
        self.assertEqual([r["title"] for r in rows], ["Bob has 5 overdue tasks"])
        self.assertEqual(rows[0]["detail"], "Bob 0 (due 09/01/2026); Bob 1 (due 09/02/2026); "
                                            "Bob 2 (due 09/03/2026); and 2 more")

    def test_email_is_the_weekly_digest(self):
        self._emp(AMY)
        self._task("Old task", "2026-09-20")
        self._config(defaultSendTime="07:00")
        self._scan()
        mail = self.sent[0]
        self.assertEqual(mail["subject"], "Your Weekly Digest - Week of 09/28/2026")
        html = mail["html"]
        # The opening line counts what is waiting, not "the tasks you have
        # overdue" (Neil, 10/01).
        self.assertIn("Here is everything waiting on you in Nexus this week: 1 overdue task.", html)
        self.assertNotIn("These are the tasks you have overdue", html)
        self.assertIn("Due 09/20/2026 - 8 days overdue", html)
        self.assertIn("Extend Due Date", html)
        self.assertIn("do=extend", html)
        self.assertIn('class="nx-acc" checked', html)   # its one section starts open
        self.assertNotIn(">ID</th>", html)              # no task ID column (Oct 1)
        self.assertNotIn("Daily Briefing", html)
        self.assertIn("Open My Briefing", html)
        self.assertIn("/briefing", html)
        self.assertNotIn("Open My Tasks", html)

    def test_outlook_desktop_gets_no_checkbox_or_arrow_and_real_buttons(self):
        """Oct 1: Outlook Classic (the Word engine) drew the open section's
        collapse checkbox as "[X]", showed the arrow, and turned each button
        into an outline with color only behind the words - unlike Outlook web."""
        import re
        self._emp(AMY)
        self._task("Old task", "2026-09-20")
        self._config(defaultSendTime="07:00")
        self._scan()
        html = self.sent[0]["html"]
        # Every checkbox and arrow sits inside a block Outlook desktop skips.
        hidden = "".join(re.findall(r"<!--\[if !mso\]><!-->(.*?)<!--<!\[endif\]-->", html, re.S))
        self.assertEqual(html.count('type="checkbox"'), hidden.count('type="checkbox"'))
        self.assertEqual(html.count("&#9656;"), hidden.count("&#9656;"))
        self.assertGreater(hidden.count('type="checkbox"'), 0)
        # Buttons are colored cells (bgcolor + mso-padding-alt), not a bare link.
        self.assertRegex(html, r"<td class='nx-btn' bgcolor='#[0-9a-f]{6}'[^>]*mso-padding-alt[^>]*><a [^>]*>Open My Briefing</a></td>")
        # A row's own actions are one line of links (Neil, 10/01), Extend included.
        self.assertRegex(html, r"<a href='[^']*do=extend'[^>]*>Extend Due Date</a>")


class StillToDoTests(_Case):
    """Sep 29 (Sagar): the Daily Briefing's "Action Required" items ride along
    as "Needs Your Attention" - approvals, tickets, time off to decide."""

    def test_pending_work_joins_the_digest_without_repeating_overdue_tasks(self):
        self._emp(AMY)
        overdue_approval = self._task("Old approval", "2026-09-01", type="approval", approval_status="pending")
        self._task("Fresh approval", "2026-10-15", type="approval", approval_status="pending")
        self.db.add(models.TaskTicket(id=gen_id(), code="TKT-7", subject="New laptop", approval_status="pending",
                                      approver_email=AMY, status="new"))
        self.db.commit()
        sections = weekly_digest.build_sections(self.db, AMY, TODAY)
        self.assertEqual([r["title"] for r in sections["overdue"]], ["Old approval"])
        pending = [r["title"] for r in sections["pending"]]
        self.assertIn("Approve: Fresh approval", pending)
        self.assertIn("Approve: New laptop", pending)
        self.assertNotIn("Approve: Old approval", pending)     # already listed as overdue
        self.assertTrue(all(r.get("task_id") != overdue_approval for r in sections["pending"]))

    def test_a_manager_is_told_about_time_off_to_decide(self):
        self._emp("boss@greensglobal.com")
        self._emp("bob@greensglobal.com", manager_email="boss@greensglobal.com")
        self.db.add(models.TimeOffRequest(id=gen_id(), employee_email="bob@greensglobal.com", type="vacation",
                                          start_date="2026-10-05", end_date="2026-10-06", status="pending"))
        self.db.commit()
        rows = weekly_digest.build_sections(self.db, "boss@greensglobal.com", TODAY)["pending"]
        self.assertEqual(rows[0]["title"], "Approve: Bob's time off (vacation)")

    def test_nothing_overdue_but_work_waiting_still_sends(self):
        self._emp(AMY)
        self._task("Fresh approval", "2026-10-15", type="approval", approval_status="pending")
        self._config(defaultSendTime="07:00")
        self._scan()
        self.assertEqual(len(self.sent), 1)
        html = self.sent[0]["html"]
        self.assertIn("Needs Your Attention", html)
        self.assertIn("1 item needing your action (Tasks).", html)
        self.assertNotIn("Overdue Tasks", html)

    def test_a_test_copy_carries_no_one_click_decisions(self):
        self._emp("boss@greensglobal.com")
        self._emp("bob@greensglobal.com", manager_email="boss@greensglobal.com")
        for d in ("2026-10-05", "2026-10-12"):
            self.db.add(models.TimeOffRequest(id=gen_id(), employee_email="bob@greensglobal.com", type="vacation",
                                              start_date=d, end_date=d, status="pending"))
        self.db.commit()
        emp = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == "boss@greensglobal.com").one()
        cfg = weekly_digest.get_settings(self.db)
        sections, _, html = weekly_digest.compose(self.db, emp, cfg, TODAY, FIXED.replace(tzinfo=None), actions=False)
        self.assertIn("10/05/2026", html)                    # the bundled requests are still listed
        self.assertNotIn("briefing-actions", html)          # but nothing acts as the boss
        self.assertNotIn("action_id", str(sections))
        _, _, own = weekly_digest.compose(self.db, emp, cfg, TODAY, FIXED.replace(tzinfo=None), actions=True)
        self.assertEqual(own.count("briefing-actions"), 4)  # the boss's own copy: Approve + Reject per request


class DailyUnchangedTests(_Case):
    def test_daily_render_keeps_its_own_wording_and_actions(self):
        sections = {"needs_to_know": [{"title": "X", "detail": "Updated", "url": "https://n/x", "module": "tasks",
                                       "task_id": "t1", "action_email": AMY, "task_open": True}]}
        subject, html = daily_briefing.render_email("Amy", "2026-09-28", sections, greeting="Good morning")
        self.assertEqual(subject, "Your Daily Briefing - Monday, 09/28/2026")
        self.assertIn("Here is what changed since your last briefing.", html)
        self.assertIn("You receive one briefing a day", html)
        self.assertIn(">Open</a>", html)
        self.assertIn("Toggle Completion", html)
        for gone in ("Open in Nexus", "Change Status", "Mark Complete", "Collapse sections"):
            self.assertNotIn(gone, html)
        self.assertIn("Open My Briefing", html)
        self.assertIn("/briefing", html)
        self.assertNotIn("Extend Due Date", html)
        self.assertNotIn(" checked", html)


class ExtendTests(_Case):
    """Extend Due Date from the email - routers/mail_actions.py do=extend."""

    def setUp(self):
        super().setUp()
        self._emp(AMY)
        self.user = {"email": AMY, "role": "employee", "level": 1}

    def _extend(self, tid, new_due):
        return mail_actions._perform(None, self.db, user=self.user, task_id=tid, action="extend",
                                     text=new_due, bt=BackgroundTasks())

    def _reload(self, tid):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == tid).first()

    def test_agreed_date_is_moved_and_counted_as_an_extension(self):
        tid = self._task("Mine", "2026-09-20", created_by=AMY, due_agreement="accepted")
        msg = self._extend(tid, "2030-10-05")
        t = self._reload(tid)
        self.assertEqual(t.due_on, "2030-10-05")
        self.assertEqual(t.due_extension_count, 1)
        self.assertEqual(msg, "Due date moved to 10/05/2030")

    def test_unagreed_target_is_proposed_not_moved(self):
        tid = self._task("Theirs", "2026-09-20", created_by="boss@greensglobal.com", due_agreement="pending")
        msg = self._extend(tid, "2030-10-05")
        t = self._reload(tid)
        self.assertEqual(t.due_on, "2026-09-20")
        self.assertEqual(t.due_agreement, "proposed")
        self.assertEqual(t.due_proposal["dueOn"], "2030-10-05")
        self.assertTrue(msg.startswith("Asked "))

    def test_rejects_a_past_or_unchanged_or_missing_date(self):
        tid = self._task("Mine", "2030-09-20", created_by=AMY, due_agreement="accepted")
        for bad in ("2020-01-01", "2030-09-20", "", "soon"):
            with self.assertRaises(HTTPException):
                self._extend(tid, bad)

    def test_the_page_offers_a_date_picker_and_says_what_will_happen(self):
        tid = self._task("Theirs", "2026-09-20", created_by="boss@greensglobal.com", due_agreement="pending")
        tok = task_mail_actions.sign_token(tid, AMY)
        html = mail_actions.action_page(token=tok, do="extend").body.decode()
        self.assertIn("Extend Due Date", html)
        self.assertIn("type='date'", html)
        self.assertIn("09/20/2026", html)
        self.assertIn("sent to them to accept", html)


class ApiTests(_Case):
    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(digest_router.router)
        from auth import require_administrator
        app.dependency_overrides[require_administrator] = lambda: {
            "email": "admin@greensglobal.com", "role": "administrator", "level": 4}
        self.client = TestClient(app)

    def test_saves_valid_settings(self):
        r = self.client.put("/weekly-digest/config",
                            json={"mode": "test", "sendDay": 1, "leadMinutes": 90,
                                  "test_recipients": [" qa@greensglobal.com "]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["leadMinutes"], 90)
        self.assertEqual(r.json()["test_recipients"], ["qa@greensglobal.com"])

    def test_rejects_bad_values(self):
        for body in ({"sendDay": 0}, {"sendDay": 8}, {"leadMinutes": 5}, {"defaultSendTime": "7am"},
                     {"mode": "loud"}, {"defaultTimeZone": "Mars/Base"}):
            r = self.client.put("/weekly-digest/config", json=body)
            self.assertEqual(r.status_code, 400, body)

    def test_force_resend_sends_now_for_one_person(self):
        self._emp(AMY)
        self._task("Old task", "2026-09-20")
        self._config(sendDay=5)   # not today - force resend ignores the schedule
        self.db.add(models.NexusWeeklyDigestLog(id="log1", employee_email=AMY, week_start="2026-09-28",
                                                mode="live", created_at="2026-09-28T00:00:00"))
        self.db.commit()
        r = self.client.delete("/weekly-digest/log/log1")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["sentNow"])
        self.assertEqual([s["to"] for s in self.sent], [[AMY]])


class SendTestTests(_Case):
    """Send Test Digest - POST /weekly-digest/test-send."""

    def setUp(self):
        super().setUp()
        app = FastAPI()
        app.include_router(digest_router.router)
        from auth import require_administrator
        app.dependency_overrides[require_administrator] = lambda: {
            "email": "admin@greensglobal.com", "role": "administrator", "level": 4}
        self.client = TestClient(app)
        self._emp(AMY)
        self._task("Old task", "2026-09-20")

    def _send(self, **body):
        return self.client.post("/weekly-digest/test-send", json={"employee_email": AMY, **body})

    def test_sends_now_to_the_test_recipients_in_off_mode_and_logs_nothing(self):
        weekly_digest.save_settings(self.db, {"test_recipients": ["qa@greensglobal.com"], "sendDay": 5}, "a@x.com")
        r = self._send()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["overdueCount"], 1)
        self.assertEqual([s["to"] for s in self.sent], [["qa@greensglobal.com"]])
        self.assertEqual(self.sent[0]["subject"], f"[TEST -> {AMY}] Your Weekly Digest - Week of 09/28/2026")
        self.assertNotIn("Extend Due Date", self.sent[0]["html"])
        self.assertEqual(self._logs(), [])   # the real weekly send is unaffected

    def test_defaults_to_the_admin_when_there_are_no_test_recipients(self):
        r = self._send()
        self.assertEqual(r.json()["recipients"], ["admin@greensglobal.com"])

    def test_your_own_digest_keeps_the_extend_button(self):
        r = self._send(to=[AMY.upper()])
        self.assertTrue(r.json()["sent"])
        self.assertIn("Extend Due Date", self.sent[0]["html"])

    def test_nothing_overdue_sends_nothing(self):
        self._emp("bob@greensglobal.com")
        r = self.client.post("/weekly-digest/test-send", json={"employee_email": "Bob@greensglobal.com"})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["sent"])
        self.assertEqual(self.sent, [])

    def test_unknown_employee_is_a_404(self):
        r = self.client.post("/weekly-digest/test-send", json={"employee_email": "nobody@greensglobal.com"})
        self.assertEqual(r.status_code, 404)


if __name__ == "__main__":
    unittest.main()
