"""The briefing emails' layout (Nov 15 2026 pass - Neil approved the plan with
before / after screenshots, https://claude.ai/artifact/C6UwnwUwSXoZPd3X9AydHT).

Pins what the pass fixed: every section open (the collapse ran only in Apple
Mail, so an iPhone opened the Daily Briefing with nothing showing), tiles at
most three to a row (six in one row pushed the Weekly Digest wider than a
phone), each card row its own table (shared columns pushed the email past
680px), a subject and inbox preview line that say what is waiting, Mark Done /
Reopen, the "Approve:" word dropped beside Approve / Reject, tags for Due
Today and Days Overdue, and the digest's day headings and Coming Up.

Rendering only - no database rows.
"""
import re
import unittest
from datetime import date

import daily_briefing as daily
import weekly_digest as wk

ME = "amy@greensglobal.com"


def _task(tid, title, **kw):
    return {"title": title, "detail": kw.pop("detail", "Updated"), "url": f"https://n/tasks/mine?task={tid}",
            "module": "tasks", "task_id": tid, "action_email": ME, **kw}


def _sections():
    return {
        "action_required": [
            {"title": "Submit Your Time Sheet", "detail": "Pay period ended", "url": "https://n/ts",
             "module": "timecard", "cta": ("Review and Submit", "https://n/ts?do=submit")},
            _task("a1", "Approve: Fence repair", detail="Waiting on your decision",
                  action_kind="task_approval", action_id="a1"),
            {"title": "Approve Checkout: Drill", "detail": "Requested by Bo", "url": "https://n/items",
             "module": "items", "action_kind": "checkout", "action_id": "c1", "action_email": ME},
            _task("t1", "Walk the site", detail="Due today - Facilities", task_open=True, due_today=True,
                  short_detail="Facilities", due_on="2026-11-16"),
            {"ref": "#1042", "title": "Laptop will not start", "detail": "Assigned to you - Open",
             "url": "https://n/tickets", "module": "tickets"},
            {"title": "Approve: Bo's Time Off (Vacation)", "detail": "2 pending requests", "url": "https://n/tc",
             "module": "time_off", "sub_actions": [
                 {"detail": "11/23/2026 - 11/25/2026", "action_kind": "timeoff_approval", "action_id": "r1",
                  "action_email": ME},
                 {"detail": "12/21/2026 - 12/31/2026", "action_kind": "timeoff_approval", "action_id": "r2",
                  "action_email": ME}]},
        ],
        "needs_to_know": [_task("t2", "Door repair", task_open=True)],
        "completed": [_task("t3", "Order locks", detail="Completed", task_done=True)],
    }


class DailyLayoutTests(unittest.TestCase):
    def setUp(self):
        self.subject, self.html = daily.render_email("Amy", "2026-11-16", _sections(), "Good morning")

    def test_subject_and_opening_say_what_is_waiting(self):
        self.assertEqual(self.subject, "Daily Briefing - 6 Need Your Action - Monday, 11/16/2026")
        # The greeting, then ONE line of counts - words, not tiles (11/17/2026).
        self.assertIn("Good morning, Amy.</div>", self.html)
        self.assertRegex(self.html, r">6</span> need your action")
        one = {"action_required": _sections()["action_required"][:1]}
        self.assertEqual(daily.render_email("Amy", "2026-11-16", one)[0],
                         "Daily Briefing - 1 Needs Your Action - Monday, 11/16/2026")
        self.assertEqual(daily.render_email("Amy", "2026-11-16", {"completed": _sections()["completed"]})[0],
                         "Daily Briefing - All Caught Up - Monday, 11/16/2026")

    def test_the_inbox_preview_line_is_hidden_and_counts_by_kind(self):
        self.assertEqual(daily.daily_preheader(_sections()),
                         "Submit your Time Sheet, 3 decisions waiting, 1 task due today, 1 more to do.")
        self.assertRegex(self.html, r"<div style='display:none;[^']*mso-hide:all[^']*'>Submit your Time Sheet")
        self.assertEqual(daily.daily_preheader({}), "Nothing new since your last briefing.")

    def test_every_section_is_open_with_no_collapse(self):
        for gone in ('type="checkbox"', "nx-acc", "&#9656;", ":checked", "</th>"):
            self.assertNotIn(gone, self.html)
        for heading in ("Action Required", "Updates for You", "Completed Since Your Last Briefing"):
            self.assertIn(heading, self.html)

    def test_no_rectangles(self):
        # Neil, 11/17/2026: no stat tiles, no colored side bars, no box per
        # section, no tag boxes - CLAUDE.md "No Claude rectangle design".
        for gone in ("nx-kpi", "border-top:3px", "border-radius:3px", "width='4' bgcolor", "class='nx-card'",
                     "border-radius:8px;border-collapse:separate"):
            self.assertNotIn(gone, self.html)

    def test_rows_are_their_own_tables(self):
        # A card's rows never share columns - the widest actions of one row and
        # the widest title area of another pushed the email past 680px.
        items = self.html.count("class='nx-td nx-item'")
        self.assertEqual(items, 8)
        self.assertEqual(len(re.findall(r"<tr><td style='[^']*padding:0'><table role='presentation' width='100%'",
                                        self.html)), items)

    def test_decision_rows_drop_the_approve_word_others_keep_their_title(self):
        self.assertIn(">Fence repair</div>", self.html)
        self.assertIn(">Checkout: Drill</div>", self.html)
        self.assertIn(">Bo&#x27;s Time Off (Vacation)</div>", self.html)
        self.assertNotIn("Approve: ", self.html)
        self.assertIn(">Submit Your Time Sheet</div>", self.html)

    def test_mark_done_reopen_and_tags(self):
        self.assertEqual(self.html.count(">Mark Done<"), 2)
        self.assertEqual(self.html.count(">Reopen<"), 1)
        self.assertNotIn("Toggle Completion", self.html)
        self.assertIn(">Due today</span>", self.html)          # plain colored words, no tag box
        self.assertIn("Facilities&nbsp; ", self.html)          # the date is in the state, not repeated
        self.assertIn("#1042 - Assigned to you - Open</div>", self.html)

    def test_bundle_all_buttons_sit_under_the_requests(self):
        m = re.search(r"All 2 Requests</td>.*?</tr>", self.html, re.S)
        self.assertIsNotNone(m)
        self.assertIn(">Approve All<", m.group(0))
        self.assertIn(">Reject All<", m.group(0))
        self.assertEqual(self.html.count("briefing-actions/page"), 2 + 2 + 4 + 2)

    def test_reject_is_an_outline_approve_is_solid(self):
        self.assertRegex(self.html, r"bgcolor='#1f7a40'[^>]*><a [^>]*color:#ffffff[^>]*>Approve</a>")
        self.assertRegex(self.html, r"bgcolor='#ffffff' style='background:#ffffff;border:1px solid #e8b4b4[^>]*>"
                                    r"<a [^>]*color:#b91c1c[^>]*>Reject</a>")


class WeeklyLayoutTests(unittest.TestCase):
    def _sections(self):
        return {
            wk.PENDING_SECTION: [_task("a1", "Approve: Budget", action_kind="task_approval", action_id="a1")],
            wk.SECTION: [_task("o1", "Renew license", detail="Due 10/30/2026 - 17 days overdue - Compliance",
                               short_detail="Due 10/30/2026 - Compliance", overdue_days=17,
                               task_open=True, task_extend=True)],
            wk.DUE_SECTION: [_task("d1", "Walk", short_detail="Facilities", due_on="2026-11-16", task_open=True),
                             _task("d2", "Report", short_detail="", due_on="2026-11-18", task_open=True)],
            wk.TEAM_SECTION: [{"title": "Sam Rivera has 6 overdue tasks", "detail": "a; b; c; and 3 more",
                               "name": "Sam Rivera", "lines": ["a", "b", "c", "and 3 more"],
                               "url": "https://n/x", "module": "team", "overdue_count": 6}],
            wk.TIME_OFF_SECTION: [{"title": "Bo (Vacation)", "detail": "Off 11/23/2026 - 11/25/2026",
                                   "url": "", "module": "team"}],
            wk.HOLIDAY_SECTION: [{"title": "Thanksgiving Day", "detail": "Thursday, 11/26/2026 - Day Off - Next Week",
                                  "url": "", "module": "holidays"}],
        }

    def setUp(self):
        self.subject, self.html = wk.render("Amy", date(2026, 11, 16), self._sections(), "Good morning", "",
                                            {"sendDay": 1})

    def test_subject_opening_and_preview(self):
        self.assertEqual(self.subject, "Weekly Briefing - 1 Needs Your Attention, 1 Overdue - Week of 11/16/2026")
        self.assertRegex(self.html, r">1</span> needs your attention")
        self.assertEqual(wk._preheader(self._sections()),
                         "1 needs your attention, 1 task is overdue and 2 are due this week. "
                         "Thanksgiving Day is Thursday next week.")

    def test_counts_are_one_line_of_words(self):
        self.assertNotIn("nx-kpi", self.html)
        self.assertRegex(self.html, r">1</span> overdue")
        self.assertRegex(self.html, r">2</span> due this week")

    def test_due_this_week_puts_the_day_in_each_line(self):
        # One line per task, its day first - a heading per day made it long (11/17/2026).
        self.assertIn("Mon 11/16/2026 - Facilities", self.html)
        self.assertIn(">Wed 11/18/2026</div>", self.html)
        self.assertNotIn("Due Mon", self.html)

    def test_time_off_and_holidays_are_coming_up(self):
        self.assertIn("Coming Up", self.html)
        for gone in ("Upcoming Time Off", "Upcoming Holidays"):
            self.assertNotIn(gone, self.html)
        self.assertLess(self.html.index(">Time Off<"), self.html.index(">Holidays<"))
        # build_sections' own keys are untouched - the log and the card read them.
        email = wk._for_email(self._sections())
        self.assertNotIn(wk.TIME_OFF_SECTION, email)
        self.assertEqual(len(email[wk.COMING_SECTION]), 2)

    def test_overdue_tag_and_team_list(self):
        self.assertIn(">17 days overdue</span>", self.html)
        self.assertIn("Due 10/30/2026 - Compliance&nbsp; ", self.html)
        self.assertIn(">Sam Rivera</div>", self.html)
        self.assertIn(">6 overdue</span>", self.html)
        self.assertIn("a - b - c - and 3 more", self.html)
        self.assertIn(">Extend<", self.html)


if __name__ == "__main__":
    unittest.main()
