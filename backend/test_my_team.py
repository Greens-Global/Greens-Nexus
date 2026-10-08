"""My Team dashboard tile (Essentials, Oct 7) - routers/my_team.py.

  - Who counts as "my team": a supervisor sees direct reports only, a manager
    and up the whole reporting tree below them; the caller is never listed.
  - /me/team/today buckets: one person in exactly one of in / late / onLeave /
    out, in beats late beats onLeave beats out; late needs a shift start plus
    the 15-minute grace to have passed with no clock-in today; a person on
    leave or a holiday is never late; scheduleAvailable follows the schedule.
  - /me/team/overdue: overdue open tasks and SLA-breached tickets per person,
    worst first, the single worst item named, capped.
  - An employee (level 1) is refused.

The clock is frozen at Thursday 10/08/2026 16:00 UTC (9:00 AM Pacific).
Uses a throwaway sqlite file.

Run with: python -m pytest test_my_team.py   (one file per process - CLAUDE.md)
"""
import os
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sup@greensglobal.com"

from fastapi import FastAPI                              # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import database                                          # noqa: E402
import models                                            # noqa: E402
from auth import get_current_user                        # noqa: E402
from routers import my_team                              # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

NOW = datetime(2026, 10, 8, 16, 0, tzinfo=timezone.utc)   # Thu 9:00 AM Pacific
TODAY = "2026-10-08"
SUP = "sup@greensglobal.com"
AMY = "amy@greensglobal.com"       # reports to SUP
BOB = "bob@greensglobal.com"       # reports to SUP
CARA = "cara@greensglobal.com"     # reports to AMY (second level)
ZED = "zed@greensglobal.com"       # someone else's report

SUPERVISOR = {"email": SUP, "role": "supervisor", "level": 2}
MANAGER = {"email": SUP, "role": "manager", "level": 3}
EMPLOYEE = {"email": SUP, "role": "employee", "level": 1}


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.TimePunch, models.TimeOffRequest, models.HrCompanyHoliday,
                  models.Shift, models.ShiftAssignment, models.ScheduledShift, models.Task,
                  models.TaskTicket, models.NexusSetting):
            self.db.query(m).delete()
        self.db.commit()
        p = mock.patch.object(my_team, "_utcnow", lambda: NOW)
        p.start()
        self.addCleanup(p.stop)
        self.user = dict(SUPERVISOR)
        app = FastAPI()
        app.include_router(my_team.router)
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self._emp(SUP, "Sam Super", manager="")
        self._emp(AMY, "Amy Adams", manager=SUP)
        self._emp(BOB, "Bob Brown", manager=SUP)
        self._emp(CARA, "Cara Cole", manager=AMY)
        self._emp(ZED, "Zed Zane", manager="other@greensglobal.com")

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    # ── fixtures ────────────────────────────────────────────────────────────
    def _emp(self, email, name, manager="", **kw):
        first, _, last = name.partition(" ")
        self.db.add(models.NexusEmployee(id=gen_id(), first_name=first, last_name=last, work_email=email,
                                         manager_email=manager, company=kw.pop("company", "gg"),
                                         country=kw.pop("country", "US"), **kw))
        self.db.commit()

    def _punch(self, email, kind, at: datetime, local_date=TODAY):
        self.db.add(models.TimePunch(id=gen_id(), employee_email=email, kind=kind, at=_stamp(at),
                                     local_date=local_date, created_at=_stamp(at)))
        self.db.commit()

    def _leave(self, email, start=TODAY, end=TODAY, status="approved", type_="vacation", confidential=0):
        self.db.add(models.TimeOffRequest(id=gen_id(), employee_email=email, type=type_, start_date=start,
                                          end_date=end, status=status, confidential=confidential))
        self.db.commit()

    def _holiday(self, company="gg", date=TODAY, name="Founders Day", country=""):
        self.db.add(models.HrCompanyHoliday(id=gen_id(), company_id=company, date=date, name=name,
                                            source="public" if country else "manual", country_code=country))
        self.db.commit()

    def _preset(self, start="09:00", days="1,2,3,4,5", tz="UTC"):
        sid = gen_id()
        self.db.add(models.Shift(id=sid, name="Day", start_hhmm=start, end_hhmm="17:00", days=days, timezone=tz))
        self.db.commit()
        return sid

    def _assign(self, email, sid):
        self.db.add(models.ShiftAssignment(id=gen_id(), employee_email=email, shift_id=sid))
        self.db.commit()

    def _placed(self, email, start, date=TODAY, published=1, tz="UTC"):
        self.db.add(models.ScheduledShift(id=gen_id(), employee_email=email, work_date=date, start_hhmm=start,
                                          end_hhmm="18:00", published=published, timezone=tz))
        self.db.commit()

    def _task(self, assignee, due, title="Task", completed=False, **kw):
        tid = gen_id()
        self.db.add(models.Task(id=tid, title=title, due_on=due, assignee_email=assignee,
                                assignee_emails=[assignee], completed=completed, code=kw.pop("code", "T-1"), **kw))
        self.db.commit()
        return tid

    def _ticket(self, assignee, sla, subject="Ticket", status="open", **kw):
        tid = gen_id()
        self.db.add(models.TaskTicket(id=tid, subject=subject, assignee_email=assignee, sla_due_on=sla,
                                      status=status, code=kw.pop("code", "TK-1"), **kw))
        self.db.commit()
        return tid

    def _today(self, **params):
        r = self.client.get("/me/team/today", params={"tz_offset_min": 0, **params})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _overdue(self):
        r = self.client.get("/me/team/overdue", params={"tz_offset_min": 0})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    @staticmethod
    def _emails(bucket):
        return [p["email"] for p in bucket]


class GateTests(_Case):
    def test_employee_is_refused(self):
        self.user = dict(EMPLOYEE)
        for path in ("/me/team/today", "/me/team/overdue"):
            r = self.client.get(path)
            # auth.require_level answers 401 "Insufficient permissions" app-wide.
            self.assertIn(r.status_code, (401, 403), r.text)

    def test_supervisor_and_manager_are_admitted(self):
        self.assertEqual(self.client.get("/me/team/today").status_code, 200)
        self.user = dict(MANAGER)
        self.assertEqual(self.client.get("/me/team/overdue").status_code, 200)


class TeamRuleTests(_Case):
    def test_supervisor_sees_direct_reports_only(self):
        d = self._today()
        everyone = sorted(self._emails(d["in"] + d["out"] + d["onLeave"] + d["late"]))
        self.assertEqual(everyone, [AMY, BOB])
        self.assertEqual(d["counts"], {"in": 0, "out": 2, "onLeave": 0, "late": 0})

    def test_manager_sees_the_whole_tree_never_themself(self):
        self.user = dict(MANAGER)
        d = self._today()
        everyone = sorted(self._emails(d["in"] + d["out"] + d["onLeave"] + d["late"]))
        self.assertEqual(everyone, [AMY, BOB, CARA])
        self.assertNotIn(SUP, everyone)
        self.assertNotIn(ZED, everyone)

    def test_offboarded_and_deleted_people_are_left_out(self):
        self._emp("gone@greensglobal.com", "Gone Guy", manager=SUP, status="offboarded")
        self._emp("del@greensglobal.com", "Del Dee", manager=SUP, deleted_at="2026-09-01T00:00:00")
        d = self._today()
        self.assertEqual(sorted(self._emails(d["out"])), [AMY, BOB])

    def test_no_team_is_an_empty_payload_not_an_error(self):
        self.user = {"email": "lonely@greensglobal.com", "role": "supervisor", "level": 2}
        d = self._today()
        self.assertEqual(d["counts"], {"in": 0, "out": 0, "onLeave": 0, "late": 0})
        self.assertEqual(self._overdue()["people"], [])


class TodayBucketTests(_Case):
    def test_open_shift_is_in_with_its_clock_in_time(self):
        self._punch(AMY, "in", NOW - timedelta(hours=2))
        self._punch(BOB, "in", NOW - timedelta(hours=3))
        self._punch(BOB, "out", NOW - timedelta(hours=1))
        d = self._today()
        self.assertEqual(self._emails(d["in"]), [AMY])
        self.assertEqual(d["in"][0]["since"], _stamp(NOW - timedelta(hours=2)) + "Z")
        self.assertEqual(d["in"][0]["name"], "Amy Adams")
        self.assertEqual(self._emails(d["out"]), [BOB])
        self.assertEqual(d["out"][0]["detail"], "Clocked out")
        self.assertEqual(d["counts"], {"in": 1, "out": 1, "onLeave": 0, "late": 0})

    def test_on_break_is_still_in_and_since_is_the_clock_in(self):
        self._punch(AMY, "in", NOW - timedelta(hours=2))
        self._punch(AMY, "break_start", NOW - timedelta(minutes=10))
        d = self._today()
        self.assertEqual(self._emails(d["in"]), [AMY])
        self.assertTrue(d["in"][0]["onBreak"])
        self.assertEqual(d["in"][0]["since"], _stamp(NOW - timedelta(hours=2)) + "Z")

    def test_stale_open_punch_is_not_in(self):
        self._punch(AMY, "in", NOW - timedelta(hours=20), local_date="2026-10-07")
        d = self._today()
        self.assertEqual(d["in"], [])
        self.assertEqual(self._emails(d["out"]), [AMY, BOB])

    def test_voided_punch_does_not_count(self):
        self._punch(AMY, "in", NOW - timedelta(hours=1))
        p = self.db.query(models.TimePunch).first()
        p.voided = 1
        self.db.commit()
        self.assertEqual(self._today()["in"], [])

    def test_approved_leave_and_holiday_are_on_leave(self):
        self._leave(AMY, start="2026-10-07", end="2026-10-09")
        self._emp("ind@greensglobal.com", "Ind Ira", manager=SUP, country="IN")
        self._holiday(country="IN", name="Dussehra")
        d = self._today()
        by = {p["email"]: p for p in d["onLeave"]}
        self.assertEqual(sorted(by), [AMY, "ind@greensglobal.com"])
        self.assertEqual(by[AMY]["detail"], "Vacation")
        self.assertEqual(by[AMY]["since"], "2026-10-07")
        self.assertEqual(by[AMY]["until"], "2026-10-09")
        self.assertEqual(by["ind@greensglobal.com"]["detail"], "Dussehra")
        self.assertEqual(self._emails(d["out"]), [BOB])   # a US employee does not get the India holiday

    def test_pending_or_rejected_leave_is_not_leave(self):
        self._leave(AMY, status="pending")
        self._leave(BOB, status="rejected")
        self.assertEqual(self._today()["onLeave"], [])

    def test_confidential_leave_hides_its_kind(self):
        self._leave(AMY, type_="sick", confidential=1)
        self.assertEqual(self._today()["onLeave"][0]["detail"], "Time off")

    def test_late_after_shift_start_plus_grace_with_no_clock_in(self):
        self._placed(AMY, "08:30")                 # 90 min ago, no punch -> late
        self._placed(BOB, "15:50")                 # 10 min ago: inside the 15-minute grace -> out
        d = self._today()
        self.assertTrue(d["scheduleAvailable"])
        self.assertEqual(self._emails(d["late"]), [AMY])
        self.assertEqual(d["late"][0]["since"], "2026-10-08T08:30:00Z")
        self.assertEqual(self._emails(d["out"]), [BOB])
        self.assertEqual(d["out"][0]["detail"], "Shift later today")

    def test_default_preset_counts_on_its_days_only(self):
        weekdays = self._preset("09:00", days="1,2,3,4,5")   # Thursday is a 4
        weekend = self._preset("09:00", days="6,7")
        self._assign(AMY, weekdays)
        self._assign(BOB, weekend)
        d = self._today()
        self.assertTrue(d["scheduleAvailable"])
        self.assertEqual(self._emails(d["late"]), [AMY])
        self.assertEqual(self._emails(d["out"]), [BOB])

    def test_shift_start_is_read_in_the_shifts_own_zone(self):
        # 9:00 AM Pacific is exactly now: not late until 9:15.
        self._placed(AMY, "09:00", tz="America/Los_Angeles")
        self._placed(BOB, "08:40", tz="America/Los_Angeles")   # 20 min ago Pacific -> late
        d = self._today()
        self.assertEqual(self._emails(d["late"]), [BOB])
        self.assertEqual(self._emails(d["out"]), [AMY])

    def test_unpublished_shift_does_not_count(self):
        self._placed(AMY, "08:00", published=0)
        d = self._today()
        self.assertEqual(d["late"], [])
        self.assertFalse(d["scheduleAvailable"])

    def test_in_beats_late_and_a_finished_shift_is_not_late(self):
        self._placed(AMY, "08:00")
        self._punch(AMY, "in", NOW - timedelta(hours=1))
        self._placed(BOB, "06:00")
        self._punch(BOB, "in", NOW - timedelta(hours=9))
        self._punch(BOB, "out", NOW - timedelta(hours=1))
        d = self._today()
        self.assertEqual(self._emails(d["in"]), [AMY])
        self.assertEqual(d["late"], [])
        self.assertEqual(self._emails(d["out"]), [BOB])

    def test_in_beats_leave_and_leave_beats_late(self):
        self._leave(AMY)
        self._punch(AMY, "in", NOW - timedelta(hours=1))     # came in anyway -> in
        self._leave(BOB)
        self._placed(BOB, "08:00")                           # on leave with a shift -> on leave, not late
        d = self._today()
        self.assertEqual(self._emails(d["in"]), [AMY])
        self.assertEqual(self._emails(d["onLeave"]), [BOB])
        self.assertEqual(d["late"], [])
        self.assertEqual(d["counts"], {"in": 1, "out": 0, "onLeave": 1, "late": 0})

    def test_each_person_is_in_exactly_one_bucket(self):
        self._leave(AMY)
        self._placed(AMY, "08:00")
        self._punch(AMY, "in", NOW - timedelta(hours=1))
        self._placed(BOB, "08:00")
        self._leave(BOB)
        d = self._today()
        seen = self._emails(d["in"] + d["out"] + d["onLeave"] + d["late"])
        self.assertEqual(sorted(seen), [AMY, BOB])
        self.assertEqual(len(seen), len(set(seen)))

    def test_without_an_offset_today_is_the_team_zones_date(self):
        # 16:00 UTC is still 10/08 in Los Angeles, the default team zone.
        d = self.client.get("/me/team/today").json()
        self.assertEqual(d["date"], TODAY)


class OverdueTests(_Case):
    def test_counts_worst_item_and_sort(self):
        self._task(AMY, "2026-10-01", title="Budget", code="T-10")
        self._task(AMY, "2026-09-20", title="Audit", code="T-11")
        self._task(AMY, "2026-10-08", title="Due today, not overdue")
        self._task(AMY, "2026-09-01", title="Done", completed=True)
        self._task(AMY, "", title="Undated")
        self._task(AMY, "2026-09-01", title="Section", type="section")
        self._task(AMY, "2026-09-01", title="Binned", deleted_at="2026-10-01T00:00:00")
        self._ticket(BOB, "2026-10-05", subject="Printer", code="TK-7")
        self._ticket(BOB, "2026-10-05", subject="Closed", status="closed")
        self._ticket(BOB, "", subject="No SLA")
        self._ticket(ZED, "2026-09-01", subject="Not my team")
        d = self._overdue()
        self.assertEqual([p["email"] for p in d["people"]], [AMY, BOB])   # 2 items before 1
        amy, bob = d["people"]
        self.assertEqual((amy["overdueTasks"], amy["breachedTickets"]), (2, 0))
        self.assertEqual(amy["worst"], {"kind": "task", "id": mock.ANY, "code": "T-11", "title": "Audit",
                                        "dueOn": "2026-09-20"})
        self.assertEqual((bob["overdueTasks"], bob["breachedTickets"]), (0, 1))
        self.assertEqual(bob["worst"]["kind"], "ticket")
        self.assertEqual(bob["worst"]["code"], "TK-7")
        self.assertEqual(bob["worst"]["dueOn"], "2026-10-05")
        self.assertEqual(d["total"], 2)

    def test_ties_break_on_the_longest_overdue(self):
        self._task(AMY, "2026-10-06")
        self._task(BOB, "2026-09-01")
        d = self._overdue()
        self.assertEqual([p["email"] for p in d["people"]], [BOB, AMY])

    def test_multi_assignee_task_counts_for_each_report(self):
        tid = gen_id()
        self.db.add(models.Task(id=tid, title="Shared", due_on="2026-10-01", assignee_email=ZED,
                                assignee_emails=[ZED, AMY, BOB]))
        self.db.commit()
        d = self._overdue()
        self.assertEqual(sorted(p["email"] for p in d["people"]), [AMY, BOB])

    def test_manager_tree_and_cap(self):
        self.user = dict(MANAGER)
        self._task(CARA, "2026-10-01")
        for i in range(25):
            em = f"r{i}@greensglobal.com"
            self._emp(em, f"Rep {i:02d}", manager=SUP)
            self._task(em, "2026-10-01")
        d = self._overdue()
        self.assertEqual(len(d["people"]), my_team.OVERDUE_CAP)
        self.assertEqual(d["total"], 26)
        self.assertIn(CARA, {p["email"] for p in d["people"]} | {f"r{i}@greensglobal.com" for i in range(25)})

    def test_supervisor_does_not_see_second_level(self):
        self._task(CARA, "2026-10-01")
        self.assertEqual(self._overdue()["people"], [])

    def test_nothing_overdue_is_empty(self):
        self._task(AMY, "2026-12-01")
        self.assertEqual(self._overdue()["people"], [])


if __name__ == "__main__":
    unittest.main()
