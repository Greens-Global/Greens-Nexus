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

    def test_checkins_keep_history_and_the_status_is_computed(self):
        g = self.goal(U(EMP), measure="number", start_value=10, target_value=30)["id"]
        api.check_in(g, api.CheckinIn(value=20, status="behind", note="Half way"), U(EMP), self.db)
        out = api.check_in(g, api.CheckinIn(value=30, status="at_risk", note="There"), U(MGR), self.db)
        # The status sent is ignored: the target is met, so it is Done.
        self.assertEqual((out["progress"], out["status"]), (100, "done"))
        self.assertEqual([c["note"] for c in out["checkins"]], ["There", "Half way"])
        with self.assertRaises(HTTPException) as e:
            api.check_in(g, api.CheckinIn(value=1), U(PEER), self.db)
        self.assertEqual(e.exception.status_code, 404)
        done = self.goal(U(EMP), measure="done")["id"]
        self.assertEqual(api.check_in(done, api.CheckinIn(value=1, status="on_track"), U(EMP), self.db)["status"], "done")

    def test_status_from_progress_against_time(self):
        from datetime import date
        g = models.PerfGoal(id="x", level="personal", owner_email=EMP, measure="percent", current_value=0,
                            start_value=0, target_value=100, period_start="2026-01-01", period_end="2026-12-31",
                            metric_key="", archived_at="")
        day = lambda iso: date.fromisoformat(iso).isoformat()   # noqa: E731
        # Half the year gone: 50% expected.
        g.current_value = 55
        self.assertEqual(perf.computed_status(g, day("2026-07-02")), "on_track")
        g.current_value = 40      # 40 >= 0.7 x 50
        self.assertEqual(perf.computed_status(g, day("2026-07-02")), "at_risk")
        g.current_value = 20
        self.assertEqual(perf.computed_status(g, day("2026-07-02")), "behind")
        g.current_value = 100
        self.assertEqual(perf.computed_status(g, day("2026-07-02")), "done")
        g.current_value = 90      # the period is over without the target
        self.assertEqual(perf.computed_status(g, day("2027-01-05")), "behind")

    def test_a_less_is_better_number_and_a_rate(self):
        low = models.PerfGoal(id="l", level="personal", owner_email=EMP, measure="number", metric_key="no_shows",
                              target_value=2, current_value=1, period_start="2026-01-01", period_end="2026-12-31")
        self.assertEqual(perf.computed_status(low, "2026-06-01"), "on_track")
        self.assertEqual(perf.progress(low), 100)
        low.current_value = 3
        self.assertEqual(perf.computed_status(low, "2026-06-01"), "behind")
        low.current_value = 2
        self.assertEqual(perf.computed_status(low, "2027-01-02"), "done")    # within target when it ended
        rate = models.PerfGoal(id="r", level="personal", owner_email=EMP, measure="number", metric_key="on_time",
                               target_value=95, current_value=90, period_start="2026-01-01", period_end="2026-12-31")
        self.assertEqual(perf.computed_status(rate, "2026-03-01"), "at_risk")   # 90 >= 0.9 x 95
        rate.current_value = 96
        self.assertEqual(perf.computed_status(rate, "2026-03-01"), "on_track")  # a rate is Done only at the end
        self.assertEqual(perf.computed_status(rate, "2027-01-02"), "done")
        self.assertEqual(perf.computed_status(rate, "2026-03-01", applies=False), "no_data")

    def test_five_open_goals_at_most(self):
        for i in range(perf.MAX_OPEN_GOALS):
            self.goal(U(MGR), owner_email=EMP, title=f"Goal {i}")
        with self.assertRaises(HTTPException) as e:
            self.goal(U(EMP), title="One too many")
        self.assertEqual(e.exception.status_code, 400)
        self.assertIn("5 open goals", e.exception.detail)
        # Archiving one frees a place; restoring it is refused while full.
        first = self.db.query(models.PerfGoal).filter_by(owner_email=EMP).first()
        api.archive_goal(first.id, False, U(EMP), self.db)
        self.goal(U(EMP), title="Now it fits")
        with self.assertRaises(HTTPException):
            api.archive_goal(first.id, True, U(EMP), self.db)

    def test_an_own_goal_is_proposed_until_the_manager_approves(self):
        g = self.goal(U(EMP), title="Get forklift certified")
        self.assertTrue(g["proposed"])
        self.assertFalse(g["canApprove"])
        bells = [n.title for n in self.db.query(models.NexusNotification).filter_by(recipient=MGR).all()]
        self.assertIn("Goals to Approve", bells)
        with self.assertRaises(HTTPException):
            api.approve_goal(g["id"], U(EMP), self.db)            # never your own
        with self.assertRaises(HTTPException):
            api.approve_goal(g["id"], U(PEER), self.db)           # a peer cannot see it
        out = api.approve_goal(g["id"], U(MGR), self.db)
        self.assertFalse(out["proposed"])
        self.assertEqual(out["approvedBy"], MGR)
        # Changing what was agreed sends it back for approval.
        back = api.update_goal(g["id"], api.GoalPatch(title="Get forklift and lift certified"), U(EMP), self.db)
        self.assertTrue(back["proposed"])
        # The manager's own goal for a report is agreed at once.
        self.assertFalse(self.goal(U(MGR), owner_email=EMP, title="Set by Max")["proposed"])
        # Someone with no manager needs nobody's approval.
        self.assertFalse(self.goal(U(BOSS), title="Bea's own")["proposed"])

    def test_one_goal_for_several_reports(self):
        out = api.create_goal(api.GoalIn(title="95% on time", owner_emails=[EMP, PEER], metric_key="on_time",
                                         target_value=95), U(MGR), self.db)
        self.assertEqual(sorted(x["ownerEmail"] for x in out["created"]), sorted([EMP, PEER]))
        self.assertTrue(all(x["measuredByNexus"] and x["metricLabel"] == "On-Time Arrival" for x in out["created"]))
        with self.assertRaises(HTTPException) as e:   # only your own reports
            api.create_goal(api.GoalIn(title="x", owner_emails=[EMP, OTHER]), U(MGR), self.db)
        self.assertEqual(e.exception.status_code, 403)

    def test_a_nexus_measured_goal_reads_its_number(self):
        import perf_metrics
        g = self.goal(U(MGR), owner_email=EMP, title="Finish tasks on time", metric_key="tasks_on_time", target_value=90)
        self.assertEqual(g["status"], "no_data")            # nothing assigned yet
        with mock.patch.object(perf_metrics, "metric", return_value={"available": True, "value": 92.0}):
            out = api.get_goal(g["id"], U(EMP), self.db)
        self.assertEqual((out["currentValue"], out["status"], out["canCheckIn"]), (92.0, "on_track", False))
        with self.assertRaises(HTTPException):             # no hand check-ins on a measured goal
            api.check_in(g["id"], api.CheckinIn(value=50), U(EMP), self.db)
        with self.assertRaises(HTTPException):
            self.goal(U(EMP), metric_key="made_up", target_value=1)
        self.db.rollback()                                  # what a GET read is never kept
        row = self.db.get(models.PerfGoal, g["id"])
        row.updated_at = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
        self.db.commit()
        with mock.patch.object(perf_metrics, "metric", return_value={"available": True, "value": 70.0}):
            self.assertEqual(perf.refresh_measured_goals(self.db), 1)
            self.assertEqual(perf.refresh_measured_goals(self.db), 0)    # fresh: not read again
        self.db.commit()
        row = self.db.get(models.PerfGoal, g["id"])
        self.assertEqual((row.current_value, row.status), (70.0, "behind"))

    def test_only_a_personal_goal_is_measured_by_nexus(self):
        import perf_metrics
        with self.assertRaises(HTTPException) as e:
            self.goal(U(HR), level="company", company_id=CO, title="On time", metric_key="on_time", target_value=95)
        self.assertEqual(e.exception.status_code, 400)
        d = self.goal(U(MGR), level="department", department="Ops", title="Dept")
        with self.assertRaises(HTTPException):
            api.update_goal(d["id"], api.GoalPatch(metric_key="on_time", target_value=95), U(MGR), self.db)
        # A stray key on an old company row is ignored: its owner's numbers never show.
        row = models.PerfGoal(id="old-co", level="company", company_id=CO, owner_email=HR, title="Legacy", measure="number",
                              metric_key="on_time", target_value=95, current_value=0, start_value=0, archived_at="",
                              created_at=perf.now_iso(), period_start="2026-01-01", period_end="2026-12-31")
        self.db.add(row)
        self.db.commit()
        with mock.patch.object(perf_metrics, "metric") as called:
            out = api.get_goal("old-co", U(OTHER), self.db)
            perf.refresh_measured_goals(self.db, datetime.now(timezone.utc) + timedelta(days=1))
        called.assert_not_called()
        self.assertEqual((out["measuredByNexus"], out["metricKey"]), (False, ""))

    def test_the_manager_s_manager_reads_but_does_not_change(self):
        g = self.goal(U(EMP), title="Proposed by Erin")
        self.assertTrue(self.see(U(BOSS), g["id"]))
        out = api.get_goal(g["id"], U(BOSS), self.db)
        self.assertEqual((out["canEdit"], out["canApprove"]), (False, False))
        for call in (lambda: api.approve_goal(g["id"], U(BOSS), self.db),
                     lambda: api.update_goal(g["id"], api.GoalPatch(title="x"), U(BOSS), self.db),
                     lambda: api.archive_goal(g["id"], False, U(BOSS), self.db),
                     lambda: api.check_in(g["id"], api.CheckinIn(value=5), U(BOSS), self.db)):
            with self.assertRaises(HTTPException) as e:
                call()
            self.assertEqual(e.exception.status_code, 403)
        self.assertTrue(api.get_goal(g["id"], U(MGR), self.db)["canApprove"])      # the direct manager does
        self.assertTrue(api.get_goal(g["id"], U(HR), self.db)["canApprove"])       # and HR

    def test_a_note_only_edit_keeps_it_approved(self):
        g = self.goal(U(EMP), title="Learn the POS")
        api.approve_goal(g["id"], U(MGR), self.db)
        out = api.update_goal(g["id"], api.GoalPatch(description="Started the course"), U(EMP), self.db)
        self.assertFalse(out["proposed"])
        out = api.update_goal(g["id"], api.GoalPatch(title="Learn the POS"), U(EMP), self.db)    # same title
        self.assertFalse(out["proposed"])
        out = api.update_goal(g["id"], api.GoalPatch(title="Learn the new POS"), U(EMP), self.db)
        self.assertTrue(out["proposed"])

    def test_a_custom_numbers_range_is_bounded(self):
        from datetime import date
        today = date.fromisoformat(perf.local_today())
        ok = api.scorecard(EMP, "", (today - timedelta(days=360)).isoformat(), today.isoformat(), U(EMP), self.db)
        self.assertTrue(ok["metrics"])
        for start, end in (((today - timedelta(days=430)).isoformat(), today.isoformat()),        # 14 months
                           ((today - timedelta(days=4 * 366)).isoformat(),
                            (today - timedelta(days=4 * 366 - 30)).isoformat())):                  # four years back
            with self.assertRaises(HTTPException) as e:
                api.scorecard(EMP, "", start, end, U(EMP), self.db)
            self.assertEqual(e.exception.status_code, 400)

    def test_the_team_reads_its_numbers_in_one_pass(self):
        import perf_metrics
        calls = []
        real = perf_metrics.scorecards
        with mock.patch.object(perf_metrics, "scorecards", side_effect=lambda db, ems, *a, **k: calls.append(sorted(ems)) or real(db, ems, *a, **k)):
            api.my_team(U(MGR), self.db)
        self.assertEqual(calls, [sorted([EMP, PEER])])

    def test_the_team_is_direct_reports_with_their_numbers(self):
        self.goal(U(EMP), title="Proposed one")
        team = api.my_team(U(MGR), self.db)
        self.assertEqual(sorted(p["email"] for p in team), sorted([EMP, PEER]))
        erin = next(p for p in team if p["email"] == EMP)
        self.assertEqual(erin["goals"]["proposed"], 1)
        self.assertIn("numbers", erin)
        self.assertEqual(api.my_team(U(BOSS), self.db)[0]["email"] in (MGR, OTHER_MGR, HR), True)

    def test_who_reads_a_scorecard(self):
        for who, ok in ((EMP, True), (MGR, True), (BOSS, True), (HR, True), (PEER, False), (OTHER_MGR, False), (FAR, False)):
            if ok:
                out = api.scorecard(EMP, "quarter", "", "", U(who), self.db)
                self.assertEqual(out["email"], EMP)
                self.assertTrue(all("available" in m for m in out["metrics"]))
            else:
                with self.assertRaises(HTTPException) as e:
                    api.scorecard(EMP, "quarter", "", "", U(who), self.db)
                self.assertEqual(e.exception.status_code, 404)

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

    def test_cancel_this_one_cancels_the_teams_occurrence(self):
        seen = {}

        def fake_create(*a, **k):
            return {"eventId": "series-1", "joinUrl": "https://teams/x"}

        class R:
            status_code = 200

            def json(self):
                return {"value": [{"id": "occ-7", "start": {}}]}

        start = (datetime.now(timezone.utc) + timedelta(days=3)).strftime("%Y-%m-%dT10:00")
        with mock.patch("routers.hr_interviews._graph_create_meeting", side_effect=fake_create):
            s = api.create_one_on_one(api.OneOnOneIn(report_email=EMP, start_local=start, cadence="weekly"), U(MGR), self.db)
        mid = s["meetings"][0]["id"]
        with mock.patch("httpx.get", return_value=R()), mock.patch("routers.hr._graph_token", return_value="t"), \
                mock.patch("routers.hr_interviews._graph_cancel_meeting",
                           side_effect=lambda org, ev: seen.update({"org": org, "ev": ev}) or ""):
            api.update_meeting(mid, api.MeetingPatch(status="canceled"), U(MGR), self.db)
        self.assertEqual(seen, {"org": MGR, "ev": "occ-7"})

    def test_an_ended_1on1_is_read_only(self):
        s = self.make()
        mid = s["meetings"][0]["id"]
        out = api.add_agenda(mid, api.AgendaIn(text="Before the end"), U(EMP), self.db)
        aid = out["meetings"][0]["agenda"][0]["id"]
        api.end_one_on_one(s["id"], U(MGR), self.db)
        for call in (lambda: api.update_agenda(aid, api.AgendaPatch(done=True), U(EMP), self.db),
                     lambda: api.remove_agenda(aid, U(EMP), self.db)):
            with self.assertRaises(HTTPException) as e:
                call()
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
