"""Performance: goals and 1:1s (Neil, Oct 27 2026) - performance.py and
routers/performance.py end to end on a throwaway database.

  * goals: who may create which (self, a direct report, HR for company goals),
    who sees them (owner, manager chain, HR for the company, the company for a
    company goal - never a peer or a manager of another team), check-ins keep
    history, alignment refuses a loop, archive instead of delete;
  * 1:1s: only a manager with a direct report sets one up; Graph failing still
    makes it (and says why); the report never receives the private notes, an
    outsider gets 404; agenda from either side; an action item becomes a
    restricted Task through the task module's own create;
  * meeting math: weekly keeps its wall time across daylight saving, monthly
    skips a month without the day, the next meeting appears when one is done;
  * reminders: a 1:1 tomorrow with an empty agenda tells both once; a goal
    overdue a check-in tells its owner once per period.

Run with: python -m pytest test_performance.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import models  # noqa: E402
import performance as perf  # noqa: E402
from routers import performance as api  # noqa: E402

CO, CO2 = "co-perf", "co-perf-2"
BOSS, MGR, EMP, PEER, OTHER_MGR, OTHER, HR, FAR = (
    "boss.pf@greensglobal.com", "mgr.pf@greensglobal.com", "emp.pf@greensglobal.com",
    "peer.pf@greensglobal.com", "omgr.pf@greensglobal.com", "other.pf@greensglobal.com",
    "hr.pf@greensglobal.com", "far.pf@greensglobal.com")


def U(email, level=1):
    return {"email": email, "role": "employee", "level": level}


class PerfCase(unittest.TestCase):
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
        auth._role_cache.clear()
        self.db = database.SessionLocal()
        for m in (models.PerfGoal, models.PerfGoalCheckin, models.PerfOneOnOne, models.PerfMeeting,
                  models.PerfAgendaItem, models.PerfActionItem, models.NexusEmployee, models.HrEntity,
                  models.NexusNotification, models.Task, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=CO, name="Perf Co", hr_contact_email=HR))
        self.db.add(models.HrEntity(id=CO2, name="Other Co", hr_contact_email=""))
        # BOSS -> MGR -> EMP, PEER; OTHER_MGR -> OTHER; FAR in another company.
        for email, first, mgr, dept, co in (
                (BOSS, "Bea", "", "Ops", CO), (MGR, "Max", BOSS, "Ops", CO), (EMP, "Erin", MGR, "Ops", CO),
                (PEER, "Pat", MGR, "Ops", CO), (OTHER_MGR, "Olga", BOSS, "Sales", CO),
                (OTHER, "Oscar", OTHER_MGR, "Sales", CO), (HR, "Hana", BOSS, "HR", CO),
                (FAR, "Fay", "", "Ops", CO2)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first, last_name="Test",
                                             company=co, manager_email=mgr, department=dept, status="active"))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def goal(self, user, **kw):
        body = api.GoalIn(**{"title": "Ship it", "level": "personal", **kw})
        return api.create_goal(body, user, self.db)

    def see(self, user, gid):
        try:
            api.get_goal(gid, user, self.db)
            return True
        except HTTPException as e:
            self.assertEqual(e.status_code, 404)
            return False


class GoalTests(PerfCase):
    def test_who_creates_what(self):
        mine = self.goal(U(EMP))
        self.assertEqual(mine["ownerEmail"], EMP)
        # A manager for a direct report.
        g = self.goal(U(MGR), owner_email=EMP, title="Close 40 tickets", measure="number", target_value=40)
        self.assertEqual((g["ownerEmail"], g["targetValue"], g["progress"]), (EMP, 40, 0))
        # Not for someone else's report, even as a skip-level manager or a peer.
        for who, target in ((PEER, EMP), (OTHER_MGR, EMP), (BOSS, EMP)):
            with self.assertRaises(HTTPException) as e:
                self.goal(U(who), owner_email=target)
            self.assertEqual(e.exception.status_code, 403)
        # Company goals are HR's (the company's HR contact here).
        with self.assertRaises(HTTPException) as e:
            self.goal(U(MGR), level="company", company_id=CO)
        self.assertEqual(e.exception.status_code, 403)
        c = self.goal(U(HR), level="company", company_id=CO, title="Grow 10%")
        self.assertEqual((c["level"], c["companyId"]), ("company", CO))
        with self.assertRaises(HTTPException):   # HR for CO only
            self.goal(U(HR), level="company", company_id=CO2)
        # A manager sets their own department's goal.
        d = self.goal(U(MGR), level="department", department="Ops")
        self.assertEqual((d["level"], d["department"]), ("department", "Ops"))
        with self.assertRaises(HTTPException):
            self.goal(U(EMP), level="department", department="Ops")   # no reports

    def test_hr_is_the_one_hr_rule(self):
        """HR here is timesheet_review.is_hr's rule (Oct 27 2026): an
        administrator, a FULL hr grant, or the company's HR contact - an
        Editor grant is not HR. A Full grant obeys its People scope."""
        db = self.db
        self.assertIsNone(perf.hr_reach(db, U(FAR, level=4)))            # administrator: every company
        self.assertEqual(perf.hr_reach(db, U(HR)), {CO})                  # the HR contact: their company
        self.assertIs(perf.hr_reach(db, U(EMP)), False)
        grants = {}
        with mock.patch.object(auth, "_module_level", lambda email, module, _db: grants.get((email, module), 0)):
            grants[(OTHER, "hr")] = auth._MODULE_LEVEL_RANK["editor"]
            db.info.clear()
            self.assertIs(perf.hr_reach(db, U(OTHER)), False)             # Editor is not HR any more
            with self.assertRaises(HTTPException):
                self.goal(U(OTHER), level="company", company_id=CO)
            grants[(OTHER, "hr")] = auth._MODULE_LEVEL_RANK["full"]
            db.info.clear()
            self.assertIsNone(perf.hr_reach(db, U(OTHER)))                # Full, no scope rows: every company
            self.assertEqual(self.goal(U(OTHER), level="company", company_id=CO2)["companyId"], CO2)
            db.info.clear()
            with mock.patch.object(auth, "hr_scope", lambda user, _db: {CO}):
                self.assertEqual(perf.hr_reach(db, U(OTHER)), {CO})       # Full, scoped to CO
                self.assertFalse(perf.hr_for(db, U(OTHER), CO2))
        db.info.clear()

    def test_who_sees_a_personal_goal(self):
        g = self.goal(U(MGR), owner_email=EMP)["id"]
        self.assertTrue(self.see(U(EMP), g))
        self.assertTrue(self.see(U(MGR), g))
        self.assertTrue(self.see(U(BOSS), g))            # the manager chain
        self.assertTrue(self.see(U(HR), g))              # HR for the company
        self.assertFalse(self.see(U(PEER), g))           # never a peer
        self.assertFalse(self.see(U(OTHER_MGR), g))      # a manager of another team (Oct 6 rule)
        self.assertFalse(self.see(U(OTHER_MGR, level=3), g))
        self.assertFalse(self.see(U(FAR), g))
        self.assertTrue(self.see(U(FAR, level=4), g))    # an administrator, walls off
        team = api.list_goals("team", "", "", False, U(MGR), self.db)
        self.assertEqual([x["id"] for x in team], [g])
        self.assertEqual(api.list_goals("team", "", "", False, U(OTHER_MGR), self.db), [])
        with self.assertRaises(HTTPException):
            api.list_goals("person", EMP, "", False, U(PEER), self.db)

    def test_company_and_department_goals_reach_the_company(self):
        c = self.goal(U(HR), level="company", company_id=CO)["id"]
        d = self.goal(U(MGR), level="department", department="Ops")["id"]
        mine = {x["id"] for x in api.list_goals("mine", "", "", False, U(EMP), self.db)}
        self.assertEqual(mine, {c, d})
        self.assertTrue(self.see(U(OTHER), c))
        self.assertFalse(self.see(U(OTHER), d))          # Sales, not Ops
        self.assertFalse(self.see(U(FAR), c))            # another company
        with self.assertRaises(HTTPException) as e:
            api.list_goals("company", "", "", False, U(EMP), self.db)
        self.assertEqual(e.exception.status_code, 403)
        self.assertEqual({x["id"] for x in api.list_goals("company", "", "", False, U(HR), self.db)}, {c, d})

    def test_checkins_keep_history_and_status(self):
        g = self.goal(U(EMP), measure="number", start_value=10, target_value=30)["id"]
        api.check_in(g, api.CheckinIn(value=20, status="at_risk", note="Half way"), U(EMP), self.db)
        out = api.check_in(g, api.CheckinIn(value=30, status="on_track", note="There"), U(MGR), self.db)
        self.assertEqual((out["progress"], out["status"]), (100, "on_track"))
        self.assertEqual([c["note"] for c in out["checkins"]], ["There", "Half way"])
        with self.assertRaises(HTTPException) as e:
            api.check_in(g, api.CheckinIn(value=1), U(PEER), self.db)
        self.assertEqual(e.exception.status_code, 404)
        done = self.goal(U(EMP), measure="done")["id"]
        self.assertEqual(api.check_in(done, api.CheckinIn(value=1), U(EMP), self.db)["status"], "done")
        # Ticking Done is Done even when the form still says On Track.
        done2 = self.goal(U(EMP), measure="done")["id"]
        self.assertEqual(api.check_in(done2, api.CheckinIn(value=1, status="on_track"), U(EMP), self.db)["status"], "done")

    def test_a_supported_goal_is_named_only_to_who_may_see_it(self):
        mine = self.goal(U(MGR), title="Max private aim")["id"]
        g = self.goal(U(MGR), owner_email=EMP, parent_id=mine)["id"]
        self.assertEqual(api.get_goal(g, U(MGR), self.db)["parentTitle"], "Max private aim")
        self.assertEqual(api.get_goal(g, U(EMP), self.db)["parentTitle"], "")
        self.assertEqual(api.list_goals("mine", "", "", False, U(EMP), self.db)[0]["parentTitle"], "")

    def test_hr_department_goal_lands_in_the_picked_company(self):
        d = self.goal(U(HR), level="department", department="Ops", company_id=CO)
        self.assertEqual((d["companyId"], d["department"]), (CO, "Ops"))

    def test_alignment_refuses_a_loop_and_archive_keeps_the_row(self):
        a = self.goal(U(EMP), title="A")["id"]
        b = self.goal(U(EMP), title="B", parent_id=a)["id"]
        with self.assertRaises(HTTPException):
            api.update_goal(a, api.GoalPatch(parent_id=b), U(EMP), self.db)
        api.archive_goal(b, False, U(EMP), self.db)
        self.assertIsNotNone(self.db.get(models.PerfGoal, b))
        self.assertNotIn(b, {x["id"] for x in api.list_goals("mine", "", "", False, U(EMP), self.db)})
        self.assertIn(b, {x["id"] for x in api.list_goals("mine", "", "", True, U(EMP), self.db)})

    def test_externals_are_refused(self):
        with self.assertRaises(HTTPException) as e:
            api.my_context({**U(EMP), "external": True}, self.db)
        self.assertEqual(e.exception.status_code, 403)


def _graph_off(*a, **k):
    raise HTTPException(502, "Microsoft Graph denied creating the meeting - grant the app 'Calendars.ReadWrite'.")


class OneOnOneTests(PerfCase):
    def make(self, cadence="weekly", start=None):
        start = start or (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%dT10:00")
        with mock.patch("routers.hr_interviews._graph_create_meeting", side_effect=_graph_off):
            return api.create_one_on_one(api.OneOnOneIn(report_email=EMP, start_local=start, time_zone="America/Los_Angeles",
                                                        cadence=cadence), U(MGR), self.db)

    def test_only_a_manager_with_a_direct_report(self):
        for who in (EMP, BOSS, PEER, OTHER_MGR):
            with self.assertRaises(HTTPException) as e:
                with mock.patch("routers.hr_interviews._graph_create_meeting", side_effect=_graph_off):
                    api.create_one_on_one(api.OneOnOneIn(report_email=EMP if who != EMP else PEER,
                                                         start_local="2026-11-02T10:00"), U(who), self.db)
            self.assertEqual(e.exception.status_code, 403)

    def test_graph_failure_still_makes_it_and_tells_the_report(self):
        s = self.make()
        self.assertFalse(s["teamsMeeting"])
        self.assertIn("Calendars.ReadWrite", s["graphError"])
        self.assertEqual(len(s["meetings"]), 1)
        bell = self.db.query(models.NexusNotification).filter_by(recipient=EMP).all()
        self.assertEqual([n.title for n in bell], ["1:1 Scheduled"])

    def test_graph_gets_the_series(self):
        seen = {}

        def fake(*a, **k):
            seen.update(k)
            seen["start"] = a[5]
            return {"eventId": "ev-1", "joinUrl": "https://teams/x"}
        with mock.patch("routers.hr_interviews._graph_create_meeting", side_effect=fake):
            s = api.create_one_on_one(api.OneOnOneIn(report_email=EMP, start_local="2026-11-02T10:00",
                                                     time_zone="America/Los_Angeles", cadence="biweekly"), U(MGR), self.db)
        self.assertEqual((s["joinUrl"], s["teamsMeeting"]), ("https://teams/x", True))
        self.assertEqual(seen["time_zone"], "America/Los_Angeles")
        self.assertEqual(seen["start"], "2026-11-02T10:00:00")
        self.assertEqual(seen["recurrence"]["pattern"], {"type": "weekly", "interval": 2, "daysOfWeek": ["monday"],
                                                         "firstDayOfWeek": "sunday"})

    def test_privacy(self):
        s = self.make()
        mid = s["meetings"][0]["id"]
        api.update_meeting(mid, api.MeetingPatch(private_notes="Watch the deadlines", shared_notes="Talked roadmap"),
                           U(MGR), self.db)
        theirs = api.get_one_on_one(s["id"], U(EMP), self.db)
        self.assertEqual(theirs["side"], "report")
        self.assertNotIn("privateNotes", theirs["meetings"][0])
        self.assertNotIn("Watch the deadlines", repr(theirs))
        self.assertEqual(theirs["meetings"][0]["sharedNotes"], "Talked roadmap")
        self.assertEqual(api.get_one_on_one(s["id"], U(MGR), self.db)["meetings"][0]["privateNotes"], "Watch the deadlines")
        with self.assertRaises(HTTPException) as e:
            api.update_meeting(mid, api.MeetingPatch(private_notes="x"), U(EMP), self.db)
        self.assertEqual(e.exception.status_code, 403)
        for outsider in (BOSS, HR, PEER):   # nobody else - not the skip-level manager, not HR
            with self.assertRaises(HTTPException) as e:
                api.get_one_on_one(s["id"], U(outsider, level=4 if outsider == HR else 1), self.db)
            self.assertEqual(e.exception.status_code, 404)
        self.assertEqual(api.list_one_on_ones(U(PEER), self.db), [])

    def test_agenda_and_action_items(self):
        s = self.make()
        mid = s["meetings"][0]["id"]
        api.add_agenda(mid, api.AgendaIn(text="Promotion path"), U(EMP), self.db)
        out = api.add_agenda(mid, api.AgendaIn(text="Q4 plan"), U(MGR), self.db)
        self.assertEqual([a["text"] for a in out["meetings"][0]["agenda"]], ["Promotion path", "Q4 plan"])
        aid = out["meetings"][0]["agenda"][0]["id"]
        with self.assertRaises(HTTPException):
            api.remove_agenda(aid, U(MGR), self.db)        # not theirs to remove
        out = api.add_action(mid, api.ActionIn(text="Draft the Q4 plan", owner_email=EMP, due_on="2026-11-20"),
                             BackgroundTasks(), U(MGR), self.db)
        act = out["meetings"][0]["actions"][0]
        self.assertTrue(act["taskId"])
        t = self.db.get(models.Task, act["taskId"])
        self.assertEqual((t.access_level, t.title, t.due_on), ("restricted", "Draft the Q4 plan", "2026-11-20"))
        self.assertIn(EMP, t.assignee_emails or [t.assignee_email])
        with self.assertRaises(HTTPException):
            api.add_action(mid, api.ActionIn(text="x", owner_email=PEER), BackgroundTasks(), U(MGR), self.db)

    def test_a_moved_report_makes_the_1on1_history(self):
        s = self.make()
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=EMP).one()
        emp.manager_email = OTHER_MGR
        self.db.commit()
        self.db.info.clear()
        out = api.get_one_on_one(s["id"], U(MGR), self.db)      # still readable
        self.assertFalse(out["current"])
        with self.assertRaises(HTTPException) as e:
            api.add_agenda(out["meetings"][0]["id"], api.AgendaIn(text="x"), U(MGR), self.db)
        self.assertEqual(e.exception.status_code, 409)
        row = self.db.get(models.PerfOneOnOne, s["id"])
        self.assertIsNone(perf.ensure_upcoming(self.db, row, datetime.now(timezone.utc) + timedelta(days=30)))

    def test_two_people_saving_notes_never_overwrite(self):
        s = self.make()
        m = s["meetings"][0]
        api.update_meeting(m["id"], api.MeetingPatch(shared_notes="Mine", notes_at=m["notesAt"]), U(EMP), self.db)
        with self.assertRaises(HTTPException) as e:
            api.update_meeting(m["id"], api.MeetingPatch(shared_notes="Theirs", notes_at=m["notesAt"]), U(MGR), self.db)
        self.assertEqual(e.exception.status_code, 409)

    def test_monthly_starts_on_a_day_every_month_has(self):
        with self.assertRaises(HTTPException) as e:
            self.make(cadence="monthly", start="2027-01-30T10:00")
        self.assertEqual(e.exception.status_code, 400)

    def test_next_meeting_after_done_and_end(self):
        s = self.make(start=(datetime.now(timezone.utc) + timedelta(hours=2)).strftime("%Y-%m-%dT%H:00"))
        first = s["meetings"][0]
        out = api.update_meeting(first["id"], api.MeetingPatch(status="done"), U(EMP), self.db)
        self.assertEqual(len(out["meetings"]), 2)
        self.assertEqual(out["next"]["id"], out["meetings"][0]["id"])
        with self.assertRaises(HTTPException):
            api.end_one_on_one(s["id"], U(EMP), self.db)
        ended = api.end_one_on_one(s["id"], U(MGR), self.db)    # no Teams series here: nothing to end
        self.assertEqual(ended["status"], "ended")
        self.assertEqual({m["status"] for m in ended["meetings"]}, {"done", "canceled"})


class MeetingMathTests(unittest.TestCase):
    def series(self, cadence, first, tz="America/Los_Angeles"):
        return models.PerfOneOnOne(id="s", cadence=cadence, first_local=first, time_zone=tz, duration_min=30,
                                   status="active")

    def test_weekly_keeps_wall_time_across_dst(self):
        s = self.series("weekly", "2026-10-26T10:00")       # PDT; DST ends Nov 1 2026
        a, b = perf.occurrence(s, 0), perf.occurrence(s, 1)
        self.assertEqual(perf.utc_str(a), "2026-10-26T17:00:00Z")
        self.assertEqual(perf.utc_str(b), "2026-11-02T18:00:00Z")   # still 10:00 AM, now PST
        self.assertEqual(perf.local_label(perf.utc_str(b), s.time_zone), "11/02/2026 at 10:00 AM PST")

    def test_monthly_skips_a_month_without_the_day(self):
        s = self.series("monthly", "2027-01-31T09:00")
        self.assertIsNone(perf.occurrence(s, 1))            # no Feb 31
        nxt = perf.next_occurrence_after(s, perf.occurrence(s, 0))
        self.assertEqual(nxt.astimezone(perf.zone(s.time_zone)).strftime("%m/%d"), "03/31")
        self.assertEqual(perf.graph_recurrence(s)["pattern"], {"type": "absoluteMonthly", "interval": 1, "dayOfMonth": 31})
        self.assertIsNone(perf.graph_recurrence(self.series("once", "2027-01-31T09:00")))


class ReminderTests(PerfCase):
    def test_agenda_reminder_once_per_person(self):
        z = perf.zone("America/Los_Angeles")
        tomorrow = (datetime.now(timezone.utc).astimezone(z) + timedelta(days=1)).strftime("%Y-%m-%dT15:00")
        with mock.patch("routers.hr_interviews._graph_create_meeting", side_effect=_graph_off):
            api.create_one_on_one(api.OneOnOneIn(report_email=EMP, start_local=tomorrow, cadence="weekly"), U(MGR), self.db)
        self.db.query(models.NexusNotification).delete()
        self.db.commit()
        now = datetime.now(timezone.utc)
        perf.reminders_pass(now)
        perf.reminders_pass(now)
        self.db.expire_all()
        rows = self.db.query(models.NexusNotification).filter(models.NexusNotification.title == "Add to Your 1:1 Agenda").all()
        self.assertEqual(sorted(n.recipient for n in rows), sorted([MGR, EMP]))

    def test_no_reminder_when_the_agenda_has_something(self):
        z = perf.zone("America/Los_Angeles")
        tomorrow = (datetime.now(timezone.utc).astimezone(z) + timedelta(days=1)).strftime("%Y-%m-%dT15:00")
        with mock.patch("routers.hr_interviews._graph_create_meeting", side_effect=_graph_off):
            s = api.create_one_on_one(api.OneOnOneIn(report_email=EMP, start_local=tomorrow), U(MGR), self.db)
        api.add_agenda(s["meetings"][0]["id"], api.AgendaIn(text="Goals"), U(EMP), self.db)
        perf.reminders_pass()
        self.db.expire_all()
        self.assertEqual(self.db.query(models.NexusNotification)
                         .filter(models.NexusNotification.title == "Add to Your 1:1 Agenda").count(), 0)

    def test_checkin_overdue_once_per_period(self):
        g = self.goal(U(EMP), title="Learn SQL")["id"]
        old = (datetime.now(timezone.utc) - timedelta(days=20)).isoformat()
        row = self.db.get(models.PerfGoal, g)
        row.created_at = old
        self.db.commit()
        perf.reminders_pass()
        perf.reminders_pass()
        self.db.expire_all()
        rows = self.db.query(models.NexusNotification).filter(models.NexusNotification.title == "Goal Check-In Due").all()
        self.assertEqual([(n.recipient, "Learn SQL" in n.body) for n in rows], [(EMP, True)])
        # Off for the company: no reminder.
        self.db.query(models.NexusNotification).delete()
        row = self.db.get(models.PerfGoal, g)
        row.checkin_nudged_at = ""
        self.db.commit()
        api.save_settings(api.SettingsIn(company=CO, settings={"checkinEveryDays": 0}), U(HR), self.db)
        perf.reminders_pass()
        self.db.expire_all()
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)

    def test_settings_scope(self):
        with self.assertRaises(HTTPException):     # the default is HR-for-everyone's
            api.save_settings(api.SettingsIn(company="", settings={"checkinEveryDays": 7}), U(HR), self.db)
        with self.assertRaises(HTTPException):
            api.get_settings("", U(EMP), self.db)
        out = api.save_settings(api.SettingsIn(company=CO, settings={"checkinEveryDays": 500}), U(HR), self.db)
        self.assertEqual((out["settings"]["checkinEveryDays"], out["override"]), (perf.CHECKIN_DAYS_MAX, True))
        out = api.save_settings(api.SettingsIn(company="", settings={"checkinEveryDays": 7}), U(BOSS, level=4), self.db)
        self.assertEqual(out["settings"]["checkinEveryDays"], 7)


if __name__ == "__main__":
    unittest.main()
