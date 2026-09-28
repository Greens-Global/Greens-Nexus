"""Shifts: availability, group schedulers, Excel import, copying time off,
custom time-off reasons and the time-off requests switch (Sep 29 2026,
Shifts QA gap list - the Low items).

    python -m unittest test_shift_extras
"""
import json
import os
import unittest

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text  # noqa: E402
with database.engine.connect() as _c:
    # A local sqlite file older than these columns (CI builds a fresh one).
    for _sql in ("ALTER TABLE scheduled_shifts ADD COLUMN open_slots INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN published INTEGER DEFAULT 1",
                 "ALTER TABLE scheduled_shifts ADD COLUMN pending_json TEXT DEFAULT ''",
                 "ALTER TABLE scheduled_shifts ADD COLUMN pending_delete INTEGER DEFAULT 0",
                 "ALTER TABLE shifts ADD COLUMN break_min INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN break_min INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN activities_json TEXT DEFAULT ''",
                 "ALTER TABLE scheduled_shifts ADD COLUMN color TEXT DEFAULT ''",
                 "ALTER TABLE shift_groups ADD COLUMN scheduler_emails TEXT DEFAULT ''"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

ADMIN = "xtra.admin@greensglobal.com"
A = "xtra.a@greensglobal.com"
B = "xtra.b@greensglobal.com"
LEAD = "xtra.lead@greensglobal.com"       # a plain employee who schedules the group
G_ED, GROUP, OTHER, PRESET = "grant-xtra-ed", "group-xtra", "group-xtra-2", "preset-xtra"
MON, TUE, WED = "2026-11-16", "2026-11-17", "2026-11-18"
NEXT_MON = "2026-11-23"


class _Base(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, A, B, LEAD):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1], last_name="X",
                                            work_email=em, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=G_ED, name="ed", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=G_ED, email=ADMIN))
            db.add(models.ShiftGroup(id=GROUP, name="Xtra Store", scheduler_emails=json.dumps([LEAD])))
            db.add(models.ShiftGroupMember(id="sgm-xtra-a", group_id=GROUP, employee_email=A))
            db.add(models.ShiftGroup(id=OTHER, name="Xtra Other"))
            db.add(models.ShiftGroupMember(id="sgm-xtra-b", group_id=OTHER, employee_email=B))
            db.add(models.Shift(id=PRESET, name="Xtra Early", code="XE", start_hhmm="06:00", end_hhmm="14:00"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self._as(ADMIN)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("xtra.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == G_ED).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == G_ED).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id.in_([GROUP, OTHER])).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id.in_([GROUP, OTHER])).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == PRESET).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("xtra.%")) |
                (models.ScheduledShift.created_by.like("xtra.%"))).delete(synchronize_session=False)
            db.query(models.ShiftAvailability).filter(
                models.ShiftAvailability.employee_email.like("xtra.%")).delete(synchronize_session=False)
            db.query(models.TimeOffRequest).filter(
                models.TimeOffRequest.employee_email.like("xtra.%")).delete(synchronize_session=False)
            db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.work_date.in_([MON, TUE])).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key.in_(
                ["shift_requests_config", "timeoff_custom_reasons"])).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("xtra.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _grid(self, start=MON, end=TUE):
        r = self.client.get(f"/timeclock/schedule?start={start}&end={end}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _place(self, email=A, day=MON, start="09:00", end="17:00", expect=200):
        r = self.client.post("/timeclock/schedule", json={"employee_email": email, "work_date": day,
                                                          "start_hhmm": start, "end_hhmm": end})
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()


class AvailabilityTests(_Base):
    def _save(self, days, expect=200):
        r = self.client.put("/timeclock/availability/mine", json={"days": days})
        self.assertEqual(r.status_code, expect, r.text)
        return r.json()

    def test_staff_set_their_own_week(self):
        self._as(A)
        saved = self._save([{"weekday": 0, "kind": "available", "start": "08:00", "end": "12:00"},
                            {"weekday": 1, "kind": "unavailable", "note": "Class"},
                            {"weekday": 2, "kind": "any"}])
        self.assertEqual([(d["weekday"], d["kind"]) for d in saved["days"]], [(0, "available"), (1, "unavailable")])
        self.assertEqual(self.client.get("/timeclock/availability/mine").json(), saved)
        self._save([{"weekday": 0, "kind": "available", "start": "", "end": ""}], expect=400)
        self._save([{"weekday": 9, "kind": "unavailable"}], expect=400)
        self._save([{"weekday": 0, "kind": "sometimes"}], expect=400)

    def test_the_grid_warns_but_never_blocks(self):
        self._as(A)
        self._save([{"weekday": 0, "kind": "available", "start": "08:00", "end": "12:00"},
                    {"weekday": 1, "kind": "unavailable", "note": "Class"}])
        self._as(ADMIN)
        mon = self._place(day=MON, start="09:00", end="17:00")["id"]
        self._place(day=TUE)
        grid = self._grid()
        by_day = {s["date"]: s["conflicts"] for s in grid["scheduled"] if s["email"] == A}
        self.assertIn("Outside their availability on Mondays (8:00 AM - 12:00 PM).", by_day[MON])
        self.assertIn("Marked unavailable on Tuesdays (Class).", by_day[TUE])
        self.assertEqual(grid["availability"][A][0]["weekday"], 0)
        ok = self.client.get(f"/timeclock/schedule/check?email={A}&date={MON}&start=08:30&end=11:30&exclude_id={mon}").json()
        self.assertEqual(ok["warnings"], [])


class GroupSchedulerTests(_Base):
    def test_a_group_scheduler_builds_only_their_groups_schedule(self):
        self._as(LEAD)
        grid = self._grid()
        self.assertTrue(grid["canManage"])
        self.assertTrue(grid["groupScheduler"])
        self.assertEqual({e["email"] for e in grid["employees"]}, {A, LEAD})
        self.assertEqual([g["id"] for g in grid["groups"]], [GROUP])
        self._place(email=A)
        self._place(email=B, expect=403)
        pub = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": TUE})
        self.assertEqual(pub.status_code, 200, pub.text)

    def test_others_are_still_turned_away(self):
        self._as(B)
        self.assertEqual(self.client.get(f"/timeclock/schedule?start={MON}&end={TUE}").status_code, 401)
        self.assertEqual(self.client.post("/timeclock/schedule", json={"employee_email": B, "work_date": MON}).status_code, 401)

    def test_their_scope_stops_at_the_schedule(self):
        self._as(LEAD)
        # Timesheets and time-off decisions are still manager-only.
        self.assertEqual(self.client.get(f"/timeclock/team?start={MON}&end={TUE}").status_code, 401)
        self.assertEqual(self.client.get("/timeclock/timeoff").status_code, 401)

    def test_their_day_notes_go_to_their_group(self):
        self._as(LEAD)
        r = self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "Stock count"})
        self.assertEqual(r.json()["groupId"], GROUP)

    def test_my_schedule_says_which_groups_i_schedule(self):
        self._as(LEAD)
        me = self.client.get(f"/timeclock/my-schedule?start={MON}&end={TUE}").json()
        self.assertEqual(me["schedulerOf"], [{"id": GROUP, "name": "Xtra Store"}])
        self._as(A)
        self.assertEqual(self.client.get(f"/timeclock/my-schedule?start={MON}&end={TUE}").json()["schedulerOf"], [])

    def test_admins_name_the_schedulers(self):
        groups = {g["id"]: g for g in self.client.get("/timeclock/shift-groups").json()["groups"]}
        self.assertEqual(groups[GROUP]["schedulers"], [LEAD])
        r = self.client.patch(f"/timeclock/shift-groups/{OTHER}", json={"name": "Xtra Other", "members": [B],
                                                                        "schedulers": [LEAD.upper()]})
        self.assertEqual(r.status_code, 200, r.text)
        groups = {g["id"]: g for g in self.client.get("/timeclock/shift-groups").json()["groups"]}
        self.assertEqual(groups[OTHER]["schedulers"], [LEAD])
        bad = self.client.patch(f"/timeclock/shift-groups/{OTHER}", json={"name": "Xtra Other", "members": [B],
                                                                          "schedulers": ["nobody@greensglobal.com"]})
        self.assertEqual(bad.status_code, 400)


class ImportTests(_Base):
    def test_rows_become_drafts_and_bad_rows_are_reported(self):
        rows = [
            {"row": 2, "email": A, "date": MON, "start": "09:00", "end": "17:00", "label": "Front", "break_min": 30},
            {"row": 3, "email": B, "date": TUE, "shift": "xe"},                         # the preset's times
            {"row": 4, "email": "", "date": TUE, "start": "10:00", "end": "14:00", "open_slots": 2},
            {"row": 5, "email": "stranger@greensglobal.com", "date": MON, "start": "09:00", "end": "17:00"},
            {"row": 6, "email": A, "date": "11/16/2026", "start": "09:00", "end": "17:00"},
            {"row": 7, "email": A, "date": TUE, "shift": "Nope"},
            {"row": 8, "email": A, "date": TUE, "start": "09:00", "end": "09:00"},
        ]
        r = self.client.post("/timeclock/schedule/import", json={"rows": rows}).json()
        self.assertEqual((r["created"], r["errorCount"]), (3, 4))
        self.assertEqual(r["errors"], [
            "Row 5: stranger@greensglobal.com is not in the People list.",
            "Row 6: the date is missing or not a date.",
            'Row 7: there is no shift type called "Nope".',
            "Row 8: start and end can't be the same time.",
        ])
        grid = {(s["email"], s["date"]): s for s in self._grid()["scheduled"]}
        self.assertEqual((grid[(A, MON)]["breakMin"], grid[(A, MON)]["published"]), (30, False))
        self.assertEqual((grid[(B, TUE)]["start"], grid[(B, TUE)]["shiftId"]), ("06:00", PRESET))
        self.assertEqual(grid[("", TUE)]["openSlots"], 2)
        again = self.client.post("/timeclock/schedule/import", json={"rows": rows[:1]}).json()
        self.assertEqual((again["created"], again["errors"]), (0, ["Row 2: that shift is already on the schedule."]))

    def test_scope_and_limits(self):
        self._as(LEAD)
        r = self.client.post("/timeclock/schedule/import", json={"rows": [
            {"row": 2, "email": B, "date": MON, "start": "09:00", "end": "17:00"}]}).json()
        self.assertEqual(r["errors"], [f"Row 2: {B} is outside your team."])
        self.assertEqual(self.client.post("/timeclock/schedule/import", json={"rows": []}).status_code, 400)


class CopyTimeOffTests(_Base):
    def _off(self, email, a, b, status="approved"):
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id=f"to-{email}-{a}-{status}", employee_email=email, type="vacation",
                                         start_date=a, end_date=b, status=status, created_at="2026-11-01T00:00:00"))
            db.commit()
        finally:
            db.close()

    def _copy(self, **kw):
        r = self.client.post("/timeclock/schedule/copy", json={"source_start": MON, "source_end": "2026-11-22",
                                                               "target_start": NEXT_MON, **kw})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_off_by_default(self):
        self._off(A, TUE, WED)
        self.assertEqual(self._copy()["timeoffCopied"], 0)

    def test_approved_time_off_lands_as_pending_requests(self):
        self._off(A, TUE, WED)
        self._off(B, MON, MON, status="pending")          # only approved leave is copied
        self._off(B, WED, WED)
        self._off(B, "2026-11-25", "2026-11-25")          # B already has the target day
        self.assertEqual(self._copy(include_timeoff=True)["timeoffCopied"], 1)
        db = database.SessionLocal()
        try:
            new = (db.query(models.TimeOffRequest)
                   .filter(models.TimeOffRequest.employee_email == A, models.TimeOffRequest.start_date == "2026-11-24").one())
            self.assertEqual((new.end_date, new.status, new.requested_by, new.type),
                             ("2026-11-25", "pending", ADMIN, "vacation"))
        finally:
            db.close()


class TimeOffSettingsTests(_Base):
    def test_admins_add_their_own_reasons(self):
        r = self.client.put("/timeclock/timeoff/types", json={"custom": [" Jury  Duty ", "jury duty", "Sick", "Bereavement"]})
        self.assertEqual(r.json()["custom"], ["Jury Duty", "Bereavement"])
        self._as(A)
        self.assertEqual(self.client.get("/timeclock/timeoff/types").json()["custom"], ["Jury Duty", "Bereavement"])
        ok = self.client.post("/timeclock/timeoff", json={"type": "Jury Duty", "start_date": MON, "end_date": MON})
        self.assertEqual(ok.status_code, 200, ok.text)
        bad = self.client.post("/timeclock/timeoff", json={"type": "Beach Day", "start_date": MON, "end_date": MON})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.client.put("/timeclock/timeoff/types", json={"custom": ["X"]}).status_code, 401)

    def test_requests_can_be_switched_off_but_managers_still_file(self):
        self.client.put("/timeclock/shift-requests/settings", json={"timeOffRequests": False})
        self._as(A)
        self.assertFalse(self.client.get("/timeclock/timeoff/types").json()["requestsOn"])
        r = self.client.post("/timeclock/timeoff", json={"type": "vacation", "start_date": MON, "end_date": MON})
        self.assertEqual(r.status_code, 403)
        self._as(ADMIN)
        obo = self.client.post("/timeclock/timeoff/on-behalf", json={"employee_email": A, "type": "vacation",
                                                                     "start_date": MON, "end_date": MON})
        self.assertEqual(obo.status_code, 200, obo.text)

    def test_notifications_use_us_dates(self):
        self.client.post("/timeclock/timeoff/on-behalf", json={"employee_email": A, "type": "vacation",
                                                               "start_date": MON, "end_date": TUE})
        db = database.SessionLocal()
        try:
            bodies = [n.body for n in db.query(models.NexusNotification)
                      .filter(models.NexusNotification.recipient == A).all()]
        finally:
            db.close()
        self.assertTrue(any("11/16/2026 - 11/17/2026" in b for b in bodies), bodies)
        self.assertFalse(any("2026-11-16" in b or "→" in b for b in bodies), bodies)


class GridRowsTests(_Base):
    """Neil, Sep 29: photos, Teams names and locations on the rows; a shift
    can be moved to Open Shifts."""

    def test_rows_carry_photo_name_and_location(self):
        db = database.SessionLocal()
        try:
            e = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == A).one()
            e.photo_url, e.location, e.display_name = "https://x.supabase.co/p.png", " Escondido office ", "Amy Teams Name"
            db.commit()
        finally:
            db.close()
        row = {e["email"]: e for e in self._grid()["employees"]}[A]
        self.assertEqual((row["photoUrl"], row["location"], row["name"]),
                         ("https://x.supabase.co/p.png", "Escondido office", "Amy Teams Name"))

    def test_a_shift_moves_to_open_shifts_but_not_back(self):
        sid = self._place()["id"]
        r = self.client.post(f"/timeclock/schedule/{sid}/move", json={"employee_email": "", "work_date": MON})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["shift"]["email"], r.json()["shift"]["openSlots"]), ("", 1))
        back = self.client.post(f"/timeclock/schedule/{r.json()['shift']['id']}/move", json={"employee_email": A, "work_date": MON})
        self.assertEqual(back.status_code, 400)

    def test_time_off_notes_reach_the_grid(self):
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id="to-xtra-note", employee_email=A, type="vacation", start_date=MON,
                                         end_date=TUE, status="pending", note="Yard sale", created_at="2026-11-01T00:00:00"))
            db.commit()
        finally:
            db.close()
        self.assertEqual([t["note"] for t in self._grid()["timeoff"] if t["email"] == A], ["Yard sale"])


if __name__ == "__main__":
    unittest.main()
