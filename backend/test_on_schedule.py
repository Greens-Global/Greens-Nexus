"""On the Schedule (Neil, 11/03/2026, shift_roster.py).

A person switched off never appears in scheduling: no planner row (listed
under offSchedule instead), skipped by Fill Automatically / Copy Week,
nothing expected (never Late), no no-show, no Workforce Scorecard line, not
on the live strip or a teammate's grid, never a trading partner, and an open
shift claim is refused. Switching off turns their shifts from today on into
open slots (past ones stay), undo puts them back, schedulers still pass, an
outsider is refused.

Throwaway sqlite. Run with: python -m pytest test_on_schedule.py
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

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
import shift_attendance as sa   # noqa: E402
import shift_expect       # noqa: E402
import shift_roster       # noqa: E402
import workforce_scorecard   # noqa: E402
from routers import shift_requests   # noqa: E402

ENT, GROUP, PRESET = "ent-ons", "grp-ons", "preset-ons"
OWNER = "ons.owner@greensglobal.com"     # Super Administrator: company-wide
MGR = "ons.mgr@greensglobal.com"         # manager of A and B
HRED = "ons.hred@greensglobal.com"       # People editor grant, no role
OUT = "ons.out@greensglobal.com"         # a plain employee: no reach
A = "ons.a@greensglobal.com"             # on GROUP, on the schedule
B = "ons.b@greensglobal.com"             # on GROUP, taken off
_today = datetime.now(timezone.utc).date()
DAY = (_today + timedelta(days=10)).isoformat()
PAST = (_today - timedelta(days=3)).isoformat()


def _weekday_after(days: int):
    d = _today + timedelta(days=days)
    while d.isoweekday() > 5:
        d += timedelta(days=1)
    return d


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
                  models.Shift, models.ShiftAssignment, models.ScheduledShift, models.NexusNotification,
                  models.NexusSetting, models.ShiftChangeLog, models.ShiftRequest, models.ShiftCalendarEvent,
                  models.NexusGroup, models.NexusGroupMember, models.AuditLog, models.ShiftNoShowAlert,
                  models.TimePunch):
            self.db.query(m).delete()
        for em, first, mgr, role in ((OWNER, "Ola", "", "owner"), (MGR, "Mia", "", "manager"),
                                     (HRED, "Hal", "", ""), (OUT, "Oz", "", ""),
                                     (A, "Amy", MGR, ""), (B, "Bob", MGR, "")):
            self.db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Lee", work_email=em,
                                             manager_email=mgr, status="active", deleted_at="", company=ENT,
                                             country="US", employment_type="full_time", start_date="2025-01-01"))
            if role:
                self.db.add(models.NexusRole(email=em, role=role, assigned_by="test"))
        self.db.add(models.HrEntity(id=ENT, name="Greens"))
        self.db.add(models.ShiftGroup(id=GROUP, name="Crew", company_id=ENT, created_by=MGR, open_shifts=1))
        for em in (A, B):
            self.db.add(models.ShiftGroupMember(id=f"m-{em}", group_id=GROUP, employee_email=em))
        self.db.add(models.Shift(id=PRESET, name="Day", code="D", start_hhmm="07:00", end_hhmm="15:30",
                                 grace_min=5, days="1,2,3,4,5"))
        self.db.add(models.NexusGroup(id="g-hred", name="People Editors", allowed_modules="hr:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-hred", email=HRED))
        self.db.add(models.NexusSetting(key="shift_requests_config",
                                        value=json.dumps({"openShifts": True, "swaps": True, "offers": True})))
        self.db.commit()
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._as(OWNER)

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

    def _shift(self, email, day=DAY, start="09:00", end="17:00", published=1, slots=0, **kw):
        sid = kw.pop("id", "") or f"s-{email or 'open'}-{day}-{start}"
        self.db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=start, end_hhmm=end,
                                          published=published, open_slots=slots, group_id=GROUP, created_by=MGR,
                                          created_at="2026-11-01T00:00:00", **kw))
        self.db.commit()
        return sid

    def _row(self, sid):
        self.db.expire_all()
        return self.db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first()

    def _off(self, who=OWNER, email=B):
        self._as(who)
        return self.client.put("/timeclock/schedule/on-schedule", json={"email": email, "on": False})

    def _flag(self, email=B):
        self.db.expire_all()
        e = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == email).first()
        return shift_roster.is_switched_on(e)


class SwitchTests(_Case):
    def test_off_opens_future_shifts_keeps_past_and_undo_restores(self):
        past = self._shift(B, day=PAST)
        fut = self._shift(B, day=DAY)
        a_fut = self._shift(A, day=DAY)
        r = self._off()
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["email"], body["on"], body["openedShiftIds"], body["openedCount"]), (B, False, [fut], 1))
        self.assertFalse(self._flag())
        self.assertEqual(self._row(past).employee_email, B, "past shifts stay theirs")
        row = self._row(fut)
        self.assertEqual((row.employee_email, row.open_slots, row.group_id), ("", 1, GROUP))
        self.assertEqual(self._row(a_fut).employee_email, A)
        log = self.db.query(models.ShiftChangeLog).filter(models.ShiftChangeLog.shift_id == fut).all()
        self.assertEqual([(x.action, x.reason, x.employee_email) for x in log], [("released", "Taken off the schedule", B)])
        audit = self.db.query(models.AuditLog).filter(models.AuditLog.resource_id == f"emp-{B}").all()
        self.assertEqual(len(audit), 1)
        self.assertEqual(json.loads(audit[0].details)["changes"], {"on_schedule": ["1", "0"]})
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0, "no bells")
        # Membership is kept while off.
        self.assertTrue(self.db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.employee_email == B).first())

        u = self.client.post("/timeclock/schedule/on-schedule/undo", json={"email": B, "shiftIds": [fut, a_fut]})
        self.assertEqual(u.status_code, 200, u.text)
        self.assertEqual((u.json()["restored"], u.json()["skipped"]), (1, 1))
        self.assertTrue(self._flag())
        self.assertEqual(self._row(fut).employee_email, B)
        self.assertEqual(self._row(a_fut).employee_email, A, "a slot no longer open is skipped")

    def test_on_sets_the_flag_only(self):
        self.assertEqual(self._off().status_code, 200)
        r = self.client.put("/timeclock/schedule/on-schedule", json={"email": B, "on": True})
        self.assertEqual(r.json(), {"email": B, "on": True})
        self.assertTrue(self._flag())

    def test_permissions(self):
        self.assertEqual(self._off(who=OUT).status_code, 403, "an outsider is refused")
        self.assertTrue(self._flag())
        self.assertEqual(self._off(who=A).status_code, 403, "a teammate is refused")
        self.assertEqual(self._off(who=MGR).status_code, 200, "their manager schedules them")
        self.client.put("/timeclock/schedule/on-schedule", json={"email": B, "on": True})
        self.assertEqual(self._off(who=HRED).status_code, 200, "a People editor may")
        self._as(OUT)
        self.assertEqual(self.client.post("/timeclock/schedule/on-schedule/undo",
                                          json={"email": B, "shiftIds": []}).status_code, 403)
        self.assertEqual(self._off(email="nobody@greensglobal.com").status_code, 404)

    def test_create_payload_and_default(self):
        self.db.expire_all()
        e = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == A).first()
        e.on_schedule = None   # a row from before the column counts as on
        self.db.commit()
        self.assertTrue(self._flag(A))
        from routers.hr import _serialize
        self.assertTrue(_serialize(e)["onSchedule"])
        r = self.client.post("/hr/employees", json={"first_name": "New", "work_email": "ons.new@greensglobal.com",
                                                    "company": ENT, "on_schedule": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["onSchedule"])
        r = self.client.post("/hr/employees", json={"first_name": "New2", "work_email": "ons.new2@greensglobal.com",
                                                    "company": ENT})
        self.assertTrue(r.json()["onSchedule"])


class ReaderTests(_Case):
    def setUp(self):
        super().setUp()
        self.assertEqual(self._off().status_code, 200)

    def test_planner_rows_and_footer(self):
        r = self.client.get(f"/timeclock/schedule?start={PAST}&end={DAY}")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        emails = [e["email"] for e in body["employees"]]
        self.assertIn(A, emails)
        self.assertNotIn(B, emails)
        self.assertEqual([(o["email"], o["name"]) for o in body["offSchedule"]], [(B, "Bob Lee")])
        grp = next(g for g in body["groups"] if g["id"] == GROUP)
        self.assertEqual(grp["members"], [A])

    def test_bulk_and_copy_skip(self):
        r = self.client.post("/timeclock/schedule/bulk", json={
            "group_id": GROUP, "start_date": (_today + timedelta(days=20)).isoformat(),
            "end_date": (_today + timedelta(days=20)).isoformat(), "start_hhmm": "09:00", "end_hhmm": "17:00",
            "skip_holidays": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["people"], r.json()["created"], r.json()["offScheduleSkipped"]), (1, 1, 1))
        r = self.client.post("/timeclock/schedule/bulk", json={
            "emails": [B], "start_date": DAY, "end_date": DAY, "start_hhmm": "09:00", "end_hhmm": "17:00"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("off the schedule", r.json()["detail"])
        # Copy last week (both people worked) forward: only A's lands.
        self._shift(A, day=PAST)
        self._shift(B, day=PAST)
        src0 = (_today - timedelta(days=6)).isoformat()
        src1 = _today.isoformat()
        r = self.client.post("/timeclock/schedule/copy", json={
            "source_start": src0, "source_end": src1, "target_start": (_today + timedelta(days=28)).isoformat(),
            "skip_holidays": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["created"], r.json()["offScheduleSkipped"]), (1, 1))

    def test_place_and_members_refused_schedulers_pass(self):
        r = self.client.post("/timeclock/schedule", json={"employee_email": B, "work_date": DAY,
                                                           "start_hhmm": "09:00", "end_hhmm": "17:00"})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/timeclock/shift-groups", json={"name": "New Crew", "members": [B]})
        self.assertEqual(r.status_code, 400, "a new member must be on the schedule")
        r = self.client.post("/timeclock/shift-groups", json={"name": "Led Crew", "members": [A], "schedulers": [B]})
        self.assertEqual(r.status_code, 200, r.text)
        # An existing (hidden) member survives an edit of the team.
        r = self.client.patch(f"/timeclock/shift-groups/{GROUP}", json={"name": "Crew", "members": [A, B]})
        self.assertEqual(r.status_code, 200, r.text)

    def test_expected_starts_none_and_no_noshow(self):
        for em in (A, B):
            self.db.add(models.ShiftAssignment(id=f"asg-{em}", employee_email=em, shift_id=PRESET, assigned_at="x"))
        self.db.commit()
        dd = _weekday_after(30)
        exp = shift_expect.expected_starts(self.db, [A, B], dd)
        self.assertIsNotNone(exp[A])
        self.assertIsNone(exp[B])
        self.assertIsNone(shift_expect.expected_start(self.db, B, dd))
        self.assertEqual(shift_expect.expected_shifts(self.db, B, [dd]), {dd: []})
        # A shift placed on B behind the switch's back (an old row): the scan ignores them.
        day = _weekday_after(1)
        self._shift(B, day=day.isoformat(), start="07:00", end="15:30", id="s-b-scan")
        self._shift(A, day=day.isoformat(), start="07:00", end="15:30", id="s-a-scan")
        line = datetime(day.year, day.month, day.day, 18, 0, tzinfo=timezone.utc)   # 10/11 AM in LA
        with mock.patch.object(sa, "_send_email", return_value=True):
            sa.noshow_scan(self.db, line)
        self.db.expire_all()
        told = [json.loads(a.people_json) for a in self.db.query(models.ShiftNoShowAlert).all()]
        people = {p["email"] for t in told for p in t}
        self.assertNotIn(B, people)
        self.assertIn(A, people)
        acts = sa.actuals(self.db, [A, B], day.isoformat(), day.isoformat(), now_utc=line)
        self.assertNotIn(B, json.dumps(acts))

    def test_scorecard_roster(self):
        out = workforce_scorecard.roster(self.db, None, {"payTypes": ["hourly"]}, DAY)
        emails = {e.work_email for e in out}
        self.assertIn(A, emails)
        self.assertNotIn(B, emails)

    def test_live_strip_and_team_grid(self):
        self._as(A)
        r = self.client.get("/timeclock/my-schedule/live")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sum(r.json()["counts"].values()), 1, r.json())
        r = self.client.get(f"/timeclock/my-schedule?start={PAST}&end={DAY}")
        self.assertEqual(r.status_code, 200, r.text)
        team = next(t for t in r.json()["teams"] if t["id"] == GROUP)
        self.assertEqual([m["email"] for m in team["members"]], [A])

    def test_trading_and_claims(self):
        self.assertEqual(shift_requests._teammates(self.db, A), set())
        open_id = self._shift("", slots=1, id="s-open")
        self._as(B)
        r = self.client.post("/timeclock/shift-requests", json={"kind": "open", "shift_id": open_id})
        self.assertEqual(r.status_code, 400)
        self.assertIn("off the schedule", r.json()["detail"])

    def test_approving_a_claim_for_someone_off_is_refused(self):
        self._as(OWNER)
        self.client.put("/timeclock/schedule/on-schedule", json={"email": B, "on": True})
        open_id = self._shift("", slots=1, id="s-open2")
        self._as(B)
        r = self.client.post("/timeclock/shift-requests", json={"kind": "open", "shift_id": open_id})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        self.assertEqual(self._off().status_code, 200)
        self._as(MGR)
        r = self.client.post(f"/timeclock/shift-requests/{rid}/decide", json={"approve": True})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertEqual(self._row(open_id).open_slots, 1)


if __name__ == "__main__":
    unittest.main()
