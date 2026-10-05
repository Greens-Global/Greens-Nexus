"""
Daily Briefing and Weekly Digest changes from the 10/01 call with Neil.

  1-2. Updates for You lists only what a PERSON did - the system's reminder
       emails, scheduled copies and Missed closings are not updates - and
       says who did what.
  3.   Row actions are one line: Comment, React, Toggle Completion, Open (no
       Change Status, no "Open in Nexus"); Toggle Completion completes an open
       task and reopens a finished one, and never flips back on a repeat.
  4.   No "Collapse sections ..." hint under the button.
  7.   Needs Your Attention also carries shift requests and timesheet fixes;
       the digest's opening line counts actions across modules.
  9.   The team table opens with a one-line total and links nowhere misleading.
  10.  Time off: the digest's Upcoming Time Off (a manager's reports, and the
       person's own manager), the daily "your manager is out", and a bell to
       the reports when a manager's time off is approved or cancelled.

The clock is frozen at Monday 09/28/2026 14:10 UTC. Uses a throwaway sqlite
file; nothing is mailed.

Run with: python -m unittest test_briefing_oct1 -v
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone, date
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "admin@greensglobal.com"

from fastapi import BackgroundTasks   # noqa: E402

import daily_briefing                 # noqa: E402
import weekly_digest                  # noqa: E402
import database                       # noqa: E402
import models                         # noqa: E402
from routers import mail_actions      # noqa: E402
from routers import timeclock         # noqa: E402
from routers.task_util import gen_id  # noqa: E402

FIXED = datetime(2026, 9, 28, 14, 10, tzinfo=timezone.utc)
TODAY = date(2026, 9, 28)
SINCE = "2026-09-27T00:00:00"
AMY = "amy@greensglobal.com"
BOSS = "boss@greensglobal.com"
BOB = "bob@greensglobal.com"


class _FrozenDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return FIXED.astimezone(tz) if tz else FIXED.replace(tzinfo=None)


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.Task, models.TaskActivity, models.TaskComment, models.TimeOffRequest,
                  models.PunchRequest, models.TimePunch, models.ShiftRequest, models.NexusNotification,
                  models.NexusSetting, models.TaskProject):
            self.db.query(m).delete()
        self.db.commit()
        for p in (mock.patch.object(weekly_digest, "datetime", _FrozenDT),
                  mock.patch.object(daily_briefing, "datetime", _FrozenDT),
                  mock.patch.object(daily_briefing, "_logo_url", lambda db: "")):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _emp(self, email, **kw):
        self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0].title(),
                                         last_name="", work_email=email, **kw))
        self.db.commit()

    def _task(self, title, due="", assignee=AMY, **kw):
        tid = gen_id()
        self.db.add(models.Task(id=tid, title=title, due_on=due, assignee_email=assignee,
                                assignee_emails=[assignee], **kw))
        self.db.commit()
        return tid

    def _act(self, tid, type_, actor, detail, at="2026-09-28T01:00:00"):
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="task", entity_id=tid, entity_title="",
                                        type=type_, actor_email=actor, at=at, detail=detail))
        self.db.commit()

    def _off(self, who, start, end, status="approved", type_="vacation"):
        rid = gen_id()
        self.db.add(models.TimeOffRequest(id=rid, employee_email=who, type=type_, start_date=start,
                                          end_date=end, status=status))
        self.db.commit()
        return rid


class UpdatesForYouTests(_Case):
    def setUp(self):
        super().setUp()
        self._emp(AMY)
        self._emp(BOSS)
        self.tid = self._task("Payroll Import", owner_email=BOSS, assignee=BOB)
        self.db.query(models.Task).filter(models.Task.id == self.tid).update({"follower_emails": [AMY]})
        self.db.commit()

    def _updates(self):
        return [r for r in daily_briefing.build_sections(self.db, AMY, SINCE, "2026-09-28").get("needs_to_know", [])
                if r.get("task_id") == self.tid]

    def test_system_entries_are_not_updates(self):
        # Neil, 10/01: "Recurring email sent to Valinda Cranfill" made 41-56
        # tasks nobody had touched show up as updates.
        self._act(self.tid, "notify_sent", "system", "Recurring email sent to Valinda Cranfill")
        self._act(self.tid, "recurrence_scheduled", "system", "scheduled the next occurrence")
        self._act(self.tid, "closed_missed", "system", "Closed as Missed")
        self._act(self.tid, "due_changed", "asana", "changed the due date")
        self.assertEqual(self._updates(), [])

    def test_a_person_update_says_who_did_what(self):
        self._act(self.tid, "notify_sent", "system", "Overdue email sent to Bob", at="2026-09-28T03:00:00")
        self._act(self.tid, "status_changed", BOSS, "changed status to in_progress", at="2026-09-28T02:00:00")
        self._act(self.tid, "commented", BOB, "added a comment", at="2026-09-28T01:00:00")
        [row] = self._updates()
        self.assertEqual(row["detail"], "Boss changed status to In Progress; Bob added a comment")

    def test_my_own_changes_are_not_news_to_me(self):
        self._act(self.tid, "commented", AMY, "added a comment")
        self.assertEqual(self._updates(), [])


class ActionLineTests(_Case):
    def _html(self, row):
        return daily_briefing.render_email("Amy", "2026-09-28", {"needs_to_know": [row]})[1]

    def test_one_line_comment_react_toggle_open(self):
        html = self._html({"title": "X", "detail": "Updated", "url": "https://n/tasks/mine?task=t1",
                           "module": "tasks", "task_id": "t1", "action_email": AMY, "task_open": True})
        for label in ("Comment", "React", "Toggle Completion", ">Open<"):
            self.assertIn(label, html)
        self.assertIn("do=toggle", html)
        for gone in ("Change Status", "Mark Complete", "Open in Nexus", "do=status", "Collapse sections"):
            self.assertNotIn(gone, html)
        # Links, not a row of buttons: the only button is the closing one.
        self.assertEqual(html.count("class='nx-btn'"), 1)

    def test_actions_sit_on_the_rows_line_at_the_right(self):
        # Neil, 10/05: "in line, the four actions are to the right" - one
        # right-hand cell per row, links and Approve / Reject in ONE table row.
        import re
        html = self._html({"title": "Approve: Budget", "detail": "Waiting", "url": "https://n/x", "module": "tasks",
                           "task_id": "t1", "action_email": AMY, "action_kind": "task_approval", "action_id": "t1"})
        [cell] = re.findall(r"<td class='nx-td nx-act'.*?</table></td>", html, re.S)
        self.assertEqual(cell.count("<tr>"), 1)
        for label in ("Comment", "React", ">Open<", ">Approve<", ">Reject<"):
            self.assertIn(label, cell)
        self.assertIn(">Actions</th>", html)
        self.assertNotIn(">Update</th>", html)

    def test_every_listed_row_carries_its_actions(self):
        # Oct 6: rows past the third used to shrink to a title and Open only.
        rows = [{"title": f"Task {i}", "detail": "Overdue", "url": f"https://n/x{i}", "module": "tasks",
                 "task_id": f"t{i}", "action_email": AMY, "task_open": True} for i in range(20)]
        html = daily_briefing.render_email("Amy", "2026-09-28", {"needs_to_know": rows})[1]
        self.assertEqual(html.count(">Toggle Completion<"), daily_briefing._MODULE_ROW_CAP)
        self.assertIn("2 more not listed.", html)
        self.assertIn("View All 20 in Nexus", html)
        self.assertIn("&nbsp;&nbsp;<span", html)   # the dots keep their spaces without padding

    def test_the_email_uses_the_app_green(self):
        html = self._html({"title": "X", "detail": "", "url": "u", "module": "tasks"})
        self.assertIn('bgcolor="#248f4b"', html)
        self.assertNotIn("#0f3d2e", html)

    def test_a_finished_task_can_be_reopened_but_an_approval_is_never_toggled(self):
        done = self._html({"title": "X", "detail": "Completed", "url": "u", "module": "tasks",
                           "task_id": "t1", "action_email": AMY, "task_done": True})
        self.assertIn("Toggle Completion", done)
        approval = self._html({"title": "Approve: X", "detail": "Waiting", "url": "u", "module": "tasks",
                               "task_id": "t1", "action_email": AMY, "action_kind": "task_approval",
                               "action_id": "t1"})
        self.assertNotIn("Toggle Completion", approval)
        self.assertIn("Approve", approval)

    def test_completed_rows_offer_the_toggle(self):
        self._emp(AMY)
        tid = self._task("Done today", completed=True, completed_at="2026-09-28T02:00:00")
        [row] = daily_briefing.build_sections(self.db, AMY, SINCE, "2026-09-28")["completed"]
        self.assertEqual(row["task_id"], tid)
        self.assertTrue(row["task_done"])


class ToggleCompletionTests(_Case):
    def setUp(self):
        super().setUp()
        self._emp(AMY)
        self.user = {"email": AMY, "role": "employee", "level": 1}
        self.tid = self._task("Fix the gate", owner_email=AMY)

    def _toggle(self, text=""):
        return mail_actions._perform(None, self.db, user=self.user, task_id=self.tid, action="toggle",
                                     text=text, bt=BackgroundTasks())

    def _done(self):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == self.tid).one().completed

    def test_completes_then_reopens(self):
        self.assertEqual(self._toggle("done"), "Marked complete")
        self.assertTrue(self._done())
        self.assertEqual(self._toggle("open"), "Reopened")
        self.assertFalse(self._done())

    def test_a_repeat_click_never_flips_it_back(self):
        self._toggle("done")
        self.assertEqual(self._toggle("done"), "Already complete")
        self.assertTrue(self._done())

    def test_the_comment_page_shows_the_recent_comments(self):
        import task_mail_actions
        tok = task_mail_actions.sign_token(self.tid, AMY)
        page = mail_actions.action_page(token=tok, do="comment").body.decode()
        self.assertIn("No comments yet", page)
        for i, (body, internal) in enumerate((("Gate code is 4471", False), ("HR only", True), ("Done on site", False))):
            self.db.add(models.TaskComment(id=gen_id(), task_id=self.tid, author_email=AMY, body=f"<p>{body}</p>",
                                           internal=internal, created_at=f"2026-09-2{i}T10:00:00"))
        self.db.commit()
        page = mail_actions.action_page(token=tok, do="comment").body.decode()
        self.assertIn("Recent Comments", page)
        self.assertLess(page.index("Gate code is 4471"), page.index("Done on site"))   # oldest first
        self.assertIn("09/20/2026", page)
        self.assertNotIn("HR only", page)
        self.assertLess(page.index("Recent Comments"), page.index("<textarea"))

    def test_the_page_offers_the_right_way_round(self):
        import task_mail_actions
        tok = task_mail_actions.sign_token(self.tid, AMY)
        page = mail_actions.action_page(token=tok, do="toggle").body.decode()
        self.assertIn("Mark this task as complete?", page)
        self.assertIn("value='done'", page)
        self._toggle("done")
        page = mail_actions.action_page(token=tok, do="toggle").body.decode()
        self.assertIn("Reopen Task", page)
        self.assertIn("value='open'", page)


class ShiftsAndTimesheetFixesTests(_Case):
    def setUp(self):
        super().setUp()
        self._emp(BOSS)
        self._emp(BOB, manager_email=BOSS)
        self._emp(AMY, manager_email=BOSS)

    def _pending(self, email):
        return weekly_digest.build_sections(self.db, email, TODAY).get("pending", [])

    def test_a_reports_punch_fixes_are_one_row_for_the_manager(self):
        self.db.add(models.PunchRequest(id=gen_id(), employee_email=BOB, action="add", punch_kind="out",
                                        local_date="2026-09-25", reason="Forgot", status="pending"))
        self.db.add(models.TimePunch(id=gen_id(), employee_email=BOB, kind="in", at="2026-09-26T16:00:00",
                                     local_date="2026-09-26", pending_at="2026-09-26T15:30:00",
                                     edit_status="pending"))
        self.db.add(models.PunchRequest(id=gen_id(), employee_email=BOB, action="remove", local_date="2026-09-20",
                                        status="approved"))
        self.db.commit()
        [row] = [r for r in self._pending(BOSS) if r["module"] == "timecard"]
        self.assertEqual(row["title"], "Approve: Bob's timesheet fixes (2)")
        self.assertEqual(row["detail"], "add a clock-out on 09/25/2026; a new clock-in time on 09/26/2026")
        self.assertTrue(row["url"].endswith("/hr/hr-time-requests"))
        self.assertEqual([r for r in self._pending(AMY) if r["module"] == "timecard"], [])   # not Amy's to decide

    def test_shift_requests_reach_the_manager_and_the_teammate(self):
        common = dict(shift_id=gen_id(), shift_date="2026-10-01", shift_start="09:00", shift_end="17:00",
                      created_at="2026-09-27T00:00:00")
        self.db.add(models.ShiftRequest(id=gen_id(), kind="open", status="pending_manager", requester_email=BOB, **common))
        self.db.add(models.ShiftRequest(id=gen_id(), kind="offer", status="pending_peer", requester_email=BOB,
                                        target_email=AMY, **common))
        self.db.add(models.ShiftRequest(id=gen_id(), kind="open", status="pending_manager", requester_email=BOB,
                                        **{**common, "shift_date": "2026-09-20"}))   # day already passed
        self.db.commit()
        boss = [r for r in self._pending(BOSS) if r["module"] == "shifts"]
        self.assertEqual([r["title"] for r in boss], ["Approve: open shift request"])
        self.assertIn("Bob asked for the open shift 10/01/2026", boss[0]["detail"])
        amy = [r for r in self._pending(AMY) if r["module"] == "shifts"]
        self.assertEqual([r["title"] for r in amy], ["Respond: shift offer from Bob"])
        self.assertTrue(amy[0]["url"].endswith("/shifts/mine"))

    def test_the_opening_line_counts_actions_across_modules(self):
        self._off(BOB, "2026-10-05", "2026-10-06", status="pending")
        self.db.add(models.PunchRequest(id=gen_id(), employee_email=BOB, action="add", punch_kind="in",
                                        local_date="2026-09-25", status="pending"))
        self._task("Old one", "2026-09-01", assignee=BOSS)
        self.db.commit()
        sections = weekly_digest.build_sections(self.db, BOSS, TODAY)
        self.assertEqual(list(sections)[0], "pending")   # actions first
        intro = weekly_digest._intro(sections)
        self.assertEqual(intro, "Here is everything waiting on you in Nexus this week: 2 items needing your "
                                "action (Time Off, Time Card) and 1 overdue task.")


class TeamSummaryTests(_Case):
    def test_the_team_table_opens_with_the_total_and_has_no_misleading_view_all(self):
        self._emp(BOSS)
        reports = [f"r{i}@greensglobal.com" for i in range(20)]
        for r in reports:
            self._emp(r, manager_email=BOSS)
            for d in ("2026-09-01", "2026-09-02"):
                self._task(f"{r} task {d}", d, assignee=r)
        sections = weekly_digest.build_sections(self.db, BOSS, TODAY)
        self.assertEqual(weekly_digest._team_note(sections),
                         "20 team members have 40 overdue tasks between them, furthest behind first.")
        _, html = weekly_digest.render("Boss", TODAY, sections, "Good morning", "", weekly_digest.get_settings(self.db))
        self.assertIn("20 team members have 40 overdue tasks between them", html)
        self.assertNotIn("View All 20", html)
        self.assertIn("2 more not listed.", html)   # 3 full rows + 15 compact, the rest counted


class TimeOffTests(_Case):
    def setUp(self):
        super().setUp()
        self._emp(BOSS)
        self._emp(BOB, manager_email=BOSS)

    def test_the_digest_lists_reports_off_and_my_managers_dates_only(self):
        self._off(BOB, "2026-10-02", "2026-10-03", type_="sick")
        self._off(BOB, "2026-11-20", "2026-11-21")   # past the two weeks
        self._off(BOSS, "2026-09-25", "2026-09-29", type_="Medical Appointment")
        boss = weekly_digest.build_sections(self.db, BOSS, TODAY)["time_off_ahead"]
        self.assertEqual([(r["title"], r["detail"]) for r in boss],
                         [("Bob (sick)", "Off 10/02/2026 - 10/03/2026")])
        bob = weekly_digest.build_sections(self.db, BOB, TODAY)["time_off_ahead"]
        self.assertEqual([(r["title"], r["detail"]) for r in bob],
                         [("Your manager Boss", "Out now, back after 09/29/2026")])
        self.assertNotIn("Medical", str(bob))

    def test_the_daily_tells_a_report_their_manager_is_out(self):
        self._off(BOSS, "2026-09-28", "2026-09-30")
        rows = daily_briefing.build_sections(self.db, BOB, SINCE, "2026-09-28")["needs_to_know"]
        self.assertIn(("Your manager Boss is out today", "Back after 09/30/2026"),
                      [(r["title"], r["detail"]) for r in rows])
        self.db.query(models.TimeOffRequest).delete()
        self._off(BOSS, "2026-09-29", "2026-09-29")
        rows = daily_briefing.build_sections(self.db, BOB, SINCE, "2026-09-28")["needs_to_know"]
        self.assertIn(("Your manager Boss is out from tomorrow", "Off 09/29/2026"),
                      [(r["title"], r["detail"]) for r in rows])

    def _bells(self, who):
        self.db.expire_all()
        return [(n.title, n.body) for n in self.db.query(models.NexusNotification)
                .filter(models.NexusNotification.recipient == who).all()]

    def test_reports_get_a_bell_when_their_managers_time_off_is_approved(self):
        rid = self._off(BOSS, "2026-10-12", "2026-10-14", status="pending", type_="Medical Appointment")
        hr = {"email": "hr@greensglobal.com", "role": "owner", "level": 5}
        timeclock.decide_timeoff(rid, timeclock.TimeOffDecision(status="approved"), user=hr, db=self.db)
        self.assertEqual(self._bells(BOB), [("Your manager is off", "Your manager Boss is off 10/12/2026 - 10/14/2026.")])

    def test_and_when_it_is_cancelled(self):
        rid = self._off(BOSS, "2026-10-12", "2026-10-12")
        timeclock.cancel_timeoff(rid, user={"email": BOSS, "role": "manager", "level": 3}, db=self.db)
        self.assertIn(("Your manager's time off is cancelled", "Your manager Boss is no longer off 10/12/2026."),
                      self._bells(BOB))

    def test_a_report_with_no_reports_bells_nobody(self):
        rid = self._off(BOB, "2026-10-12", "2026-10-12", status="pending")
        hr = {"email": "hr@greensglobal.com", "role": "owner", "level": 5}
        timeclock.decide_timeoff(rid, timeclock.TimeOffDecision(status="approved"), user=hr, db=self.db)
        self.assertEqual([b for b in self._bells(BOSS) if b[0].startswith("Your manager")], [])


if __name__ == "__main__":
    unittest.main()
