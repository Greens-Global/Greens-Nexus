"""Shifts rebuild, backend half (Oct 2 2026 - Shifts QA against Teams,
Part B): teams on placements, validation, duplicates, publish cancelling
requests, time off vs the schedule, inactive people off the grid, paging.

    python -m unittest test_shift_rebuild
"""
import json
import os
import unittest
from datetime import date, timedelta

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
                 "ALTER TABLE scheduled_shifts ADD COLUMN group_id TEXT DEFAULT ''",
                 "ALTER TABLE scheduled_shifts ADD COLUMN timezone TEXT DEFAULT ''",
                 "ALTER TABLE shift_groups ADD COLUMN scheduler_emails TEXT DEFAULT ''",
                 "ALTER TABLE shift_groups ADD COLUMN archived INTEGER DEFAULT 0",
                 "ALTER TABLE shift_groups ADD COLUMN sort_order INTEGER DEFAULT 0",
                 "ALTER TABLE time_off_requests ADD COLUMN confidential INTEGER DEFAULT 0"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

BOSS = "rb.boss@greensglobal.com"       # administrator: company-wide
M1 = "rb.m1@greensglobal.com"           # a plain manager: A reports to them
A = "rb.a@greensglobal.com"
B = "rb.b@greensglobal.com"
GONE = "rb.gone@greensglobal.com"       # inactive
BIN = "rb.bin@greensglobal.com"         # soft-deleted
GROUP, GROUP2, PRESET = "group-rb", "group-rb-2", "preset-rb"
_today = date.today()
MON = (_today + timedelta(days=(7 - _today.weekday()) % 7 + 7)).isoformat()      # a Monday next week or later
TUE = (date.fromisoformat(MON) + timedelta(days=1)).isoformat()
SUN = (date.fromisoformat(MON) - timedelta(days=1)).isoformat()
SETTING_KEYS = ("shift_requests_config", "shift_last_publish", "timeoff_custom_reasons")


class RebuildTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (BOSS, M1, A, B, GONE, BIN):
                db.add(models.NexusEmployee(
                    id=f"emp-{em}", first_name=em.split(".")[1].upper(), last_name="X", work_email=em,
                    status="inactive" if em == GONE else "active",
                    deleted_at="2026-09-01T00:00:00" if em == BIN else "",
                    manager_email=M1 if em == A else ""))
            db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=M1, role="manager", assigned_by="test"))
            db.add(models.ShiftGroup(id=GROUP, name="Rb Store", sort_order=2))
            db.add(models.ShiftGroup(id=GROUP2, name="Rb Yard", sort_order=1))
            for i, (gid, em) in enumerate(((GROUP, A), (GROUP, B), (GROUP, GONE), (GROUP2, B))):
                db.add(models.ShiftGroupMember(id=f"sgm-rb-{i}", group_id=gid, employee_email=em))
            db.add(models.Shift(id=PRESET, code="RB", name="Rb Day", start_hhmm="09:00", end_hhmm="17:00",
                                days="1,2,3,4,5", color="#16a34a", timezone="Asia/Kolkata", break_min=30))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        self._as(BOSS)

    def tearDown(self):
        self._cleanup()
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            db.query(models.NexusRole).filter(models.NexusRole.email.like("rb.%")).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("rb.%")).delete(synchronize_session=False))
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id.in_([GROUP, GROUP2])).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id.in_([GROUP, GROUP2])).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("rb.%")) |
                (models.ScheduledShift.created_by.like("rb.%"))).delete(synchronize_session=False)
            db.query(models.ShiftRequest).filter(models.ShiftRequest.requester_email.like("rb.%")).delete(synchronize_session=False)
            db.query(models.TimeOffRequest).filter(models.TimeOffRequest.employee_email.like("rb.%")).delete(synchronize_session=False)
            db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.updated_by.like("rb.%")).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("rb.%")).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key.in_(SETTING_KEYS)).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == PRESET).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _place(self, email=A, day=MON, **over):
        body = {"employee_email": email, "work_date": day, "start_hhmm": "09:00", "end_hhmm": "17:00", **over}
        return self.client.post("/timeclock/schedule", json=body)

    def _placed(self, email=A, day=MON, **over):
        r = self._place(email, day, **over)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _publish(self, d0=MON, d1=TUE, **extra):
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": d0, "end_date": d1, **extra})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _grid(self, d0=MON, d1=TUE):
        r = self.client.get(f"/timeclock/schedule?start={d0}&end={d1}")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _row(self, sid):
        db = database.SessionLocal()
        try:
            return db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first()
        finally:
            db.close()

    # ── Section 1: the placement ──────────────────────────────────────────

    def test_a_new_shift_lands_on_the_persons_first_team_and_carries_a_zone(self):
        s = self._placed(B)                                  # B is on Rb Yard (order 1) and Rb Store (order 2)
        self.assertEqual(s["groupId"], GROUP2)
        self.assertEqual(s["timeZone"], "America/Los_Angeles")   # no preset, no zone given: the team's
        p = self._placed(A, shift_id=PRESET, start_hhmm="", end_hhmm="")
        self.assertEqual((p["groupId"], p["timeZone"], p["breakMin"]), (GROUP, "Asia/Kolkata", 30))
        own = self._placed(A, day=TUE, timezone="Europe/London", group_id=GROUP2)
        self.assertEqual((own["groupId"], own["timeZone"]), (GROUP2, "Europe/London"))
        self.assertEqual(self._place(A, day=TUE, start_hhmm="10:00", timezone="Mars/Olympus").status_code, 400)
        self.assertEqual(self._place(A, day=TUE, start_hhmm="11:00", group_id="nope").status_code, 400)

    def test_an_open_shift_needs_a_team(self):
        r = self._place("", open_slots=2)
        self.assertEqual((r.status_code, r.json()["detail"]), (400, "Pick a team for the open shift."))
        s = self._placed("", open_slots=2, group_id=GROUP)
        self.assertEqual(s["groupId"], GROUP)
        grid = self._grid()
        self.assertEqual([o["id"] for o in grid["openShifts"]], [s["id"]])
        self.assertEqual([o["groupId"] for o in grid["openShifts"]], [GROUP])
        # Assigning it hands the team along.
        got = self.client.post(f"/timeclock/schedule/{s['id']}/assign", json={"employee_email": A}).json()
        self.assertEqual(got["groupId"], GROUP)

    def test_unpaid_activities_drive_the_break_and_paid_minutes(self):
        acts = [{"start": "12:00", "end": "12:30", "label": "Lunch", "paid": False},
                {"start": "15:00", "end": "15:15", "label": "Stand-up"}]
        s = self._placed(A, break_min=60, activities=acts)
        self.assertEqual((s["breakMin"], s["paidMin"]), (30, 450))      # 8 h minus the unpaid 30 min
        self.assertEqual([a["paid"] for a in s["activities"]], [False, True])
        plain = self._placed(A, day=TUE, break_min=45, activities=[{"start": "12:00", "end": "13:00", "label": "Training"}])
        self.assertEqual((plain["breakMin"], plain["paidMin"]), (45, 435))   # all paid: the client's break stands
        night = self._placed(B, start_hhmm="22:00", end_hhmm="06:00")
        self.assertEqual(night["paidMin"], 480)

    # ── Section 6: validation ─────────────────────────────────────────────

    def test_times_must_be_hh_mm_everywhere(self):
        for body in ({"start_hhmm": "9:00"}, {"end_hhmm": "5pm"}, {"start_hhmm": "24:00"}):
            r = self._place(A, **body)
            self.assertEqual((r.status_code, r.json()["detail"]), (400, "Use HH:MM, e.g. 09:00"), body)
        sid = self._placed(A)["id"]
        r = self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": A, "work_date": MON, "start_hhmm": "9:30"})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/timeclock/schedule/bulk", json={"emails": [B], "start_date": MON, "end_date": MON,
                                                               "start_hhmm": "8:00", "end_hhmm": "16:00"})
        self.assertEqual(r.status_code, 400)
        r = self.client.post("/timeclock/shifts", json={"name": "Bad", "start_hhmm": "9:00", "end_hhmm": "17:00"})
        self.assertEqual(r.status_code, 400)
        self._as(A)
        r = self.client.post("/timeclock/timeoff", json={"type": "sick", "start_date": MON, "end_date": MON,
                                                         "start_time": "9:00", "end_time": "11:00"})
        self.assertEqual(r.status_code, 400)
        # The spreadsheet import pads instead of refusing.
        self._as(BOSS)
        r = self.client.post("/timeclock/schedule/import", json={"rows": [
            {"row": 2, "email": A, "date": TUE, "start": "9:00", "end": "5:30 PM"},
            {"row": 3, "email": "", "date": TUE, "start": "10:00", "end": "14:00", "group": "Rb Store"},
            {"row": 4, "email": "", "date": TUE, "start": "11:00", "end": "14:00"}]}).json()
        self.assertEqual((r["created"], r["errors"]), (2, ["Row 4: an open shift needs a team (the Group column)."]))
        got = {(s["email"], s["date"]): s for s in self._grid()["scheduled"]}
        self.assertEqual((got[(A, TUE)]["start"], got[(A, TUE)]["end"], got[(A, TUE)]["groupId"]), ("09:00", "17:30", GROUP))
        self.assertEqual(got[("", TUE)]["groupId"], GROUP)

    def test_the_same_shift_twice_is_refused(self):
        self._placed(A)
        again = self._place(A)
        self.assertEqual((again.status_code, again.json()["detail"]), (409, "Already on the schedule for that day"))
        self.assertEqual(self._place(A, start_hhmm="10:00").status_code, 200)   # other times are fine
        other = self._placed(A, day=TUE)
        # An edit onto an existing one, and a move onto one, are refused too.
        r = self.client.patch(f"/timeclock/schedule/{other['id']}", json={"employee_email": A, "work_date": TUE, "start_hhmm": "10:00", "end_hhmm": "17:00"})
        self.assertEqual(r.status_code, 200)
        r = self.client.post(f"/timeclock/schedule/{other['id']}/move", json={"employee_email": A, "work_date": MON})
        self.assertEqual(r.status_code, 409)
        # The same open slot in the same team is one slot.
        self._placed("", open_slots=1, group_id=GROUP, start_hhmm="13:00")
        self.assertEqual(self._place("", open_slots=1, group_id=GROUP, start_hhmm="13:00").status_code, 409)
        self.assertEqual(self._place("", open_slots=1, group_id=GROUP2, start_hhmm="13:00").status_code, 200)

    def test_people_must_be_active_in_people(self):
        self.assertEqual(self._place(GONE).status_code, 400)
        self.assertEqual(self._place(BIN).status_code, 400)
        self.assertEqual(self._place("rb.nobody@greensglobal.com").status_code, 400)
        sid = self._placed(A)["id"]
        self.assertEqual(self.client.post(f"/timeclock/schedule/{sid}/move", json={"employee_email": GONE, "work_date": MON}).status_code, 400)
        o = self._placed("", open_slots=1, group_id=GROUP)["id"]
        self.assertEqual(self.client.post(f"/timeclock/schedule/{o}/assign", json={"employee_email": GONE}).status_code, 400)
        self.assertEqual(self.client.post("/timeclock/schedule/bulk", json={"emails": [GONE], "start_date": MON, "end_date": MON}).status_code, 400)
        self.assertEqual(self.client.post(f"/timeclock/shift-groups/{GROUP}/members", json={"add": [BIN]}).status_code, 400)
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{GROUP}", json={"name": "Rb Store", "members": [A, GONE]}).status_code, 400)
        # Filling a team skips its inactive member rather than failing.
        r = self.client.post("/timeclock/schedule/bulk", json={"group_id": GROUP, "start_date": MON, "end_date": MON, "overwrite": True}).json()
        self.assertEqual(r["people"], 2)

    def test_an_edit_leaves_an_omitted_label_and_note_alone(self):
        s = self._placed(A, label="Front", note="Bring keys")
        r = self.client.patch(f"/timeclock/schedule/{s['id']}", json={"employee_email": A, "work_date": MON, "start_hhmm": "10:00"}).json()
        self.assertEqual((r["start"], r["label"], r["note"]), ("10:00", "Front", "Bring keys"))
        r = self.client.patch(f"/timeclock/schedule/{s['id']}", json={"employee_email": A, "work_date": MON, "label": ""}).json()
        self.assertEqual((r["label"], r["note"]), ("", "Bring keys"))

    # ── Section 3: the grid ───────────────────────────────────────────────

    def test_inactive_and_deleted_people_are_off_the_grid(self):
        db = database.SessionLocal()
        try:
            for em in (GONE, BIN):
                db.add(models.ScheduledShift(id=f"ss-rb-{em}", employee_email=em, work_date=MON, start_hhmm="09:00",
                                             end_hhmm="17:00", published=1, created_by=BOSS, created_at="2026-10-01T00:00:00"))
            db.commit()
        finally:
            db.close()
        grid = self._grid()
        rows = {e["email"] for e in grid["employees"]}
        self.assertIn(A, rows)
        self.assertNotIn(GONE, rows)
        self.assertNotIn(BIN, rows)
        self.assertEqual([s for s in grid["scheduled"] if s["email"] in (GONE, BIN)], [])
        store = next(g for g in grid["groups"] if g["id"] == GROUP)
        self.assertEqual(sorted(store["members"]), [A, B])
        self.assertEqual([g["id"] for g in grid["groups"]], [GROUP2, GROUP])      # by sort_order

    def test_the_grid_sees_an_overnight_shift_from_the_day_before(self):
        self._placed(A, day=SUN, start_hhmm="22:00", end_hhmm="06:00")
        self._placed(A, day=MON, start_hhmm="05:00", end_hhmm="13:00")
        got = [s for s in self._grid()["scheduled"] if s["email"] == A and s["date"] == MON]
        self.assertEqual(len(got), 1)
        self.assertTrue(any("Overlaps another shift" in w for w in got[0]["conflicts"]), got[0]["conflicts"])

    def test_day_notes_follow_their_team_and_go_with_it(self):
        self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "All hands"})
        self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "Store only", "group_id": GROUP})
        self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "Yard only", "group_id": GROUP2})
        self.assertEqual(self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "x", "group_id": "nope"}).status_code, 400)
        self.assertEqual(sorted(n["note"] for n in self._grid()["dayNotes"]), ["All hands", "Store only", "Yard only"])
        s = self._placed(A, group_id=GROUP2)
        self.assertEqual(self.client.delete(f"/timeclock/shift-groups/{GROUP2}").status_code, 200)
        self.assertEqual(sorted(n["note"] for n in self._grid()["dayNotes"]), ["All hands", "Store only"])
        self.assertEqual(self._row(s["id"]).group_id, "")             # still A's, just no team
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.group_id == GROUP2).count(), 0)
        finally:
            db.close()

    def test_time_off_on_the_grid_says_whether_it_is_all_day(self):
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id="to-rb-1", employee_email=A, type="personal", start_date=MON, end_date=MON,
                                         start_time="14:00", end_time="16:00", status="approved", created_at="2026-10-01T00:00:00"))
            db.add(models.TimeOffRequest(id="to-rb-2", employee_email=B, type="vacation", start_date=TUE, end_date=TUE,
                                         status="approved", created_at="2026-10-01T00:00:00"))
            db.commit()
        finally:
            db.close()
        off = {t["email"]: t for t in self._grid()["timeoff"]}
        self.assertEqual((off[A]["startTime"], off[A]["endTime"], off[A]["allDay"]), ("14:00", "16:00", False))
        self.assertTrue(off[B]["allDay"])
        self._as(B)
        me = self.client.get(f"/timeclock/my-schedule?start={MON}&end={TUE}").json()
        team = next(t for t in me["teams"] if t["id"] == GROUP)
        a = next(m for m in team["members"] if m["email"] == A)
        self.assertEqual(a["timeoff"][0]["startTime"], "14:00")
        self.assertFalse(a["timeoff"][0]["allDay"])
        self.assertTrue(me["timeoff"][0]["allDay"])

    # ── Section 2: groups ─────────────────────────────────────────────────

    def test_teams_are_ordered_and_reordered(self):
        self.assertEqual([g["id"] for g in self.client.get("/timeclock/shift-groups").json()["groups"] if g["id"].startswith("group-rb")],
                         [GROUP2, GROUP])
        self.assertEqual(self.client.put("/timeclock/shift-groups/order", json={"ids": [GROUP, GROUP2]}).status_code, 200)
        groups = {g["id"]: g for g in self.client.get("/timeclock/shift-groups").json()["groups"]}
        self.assertEqual((groups[GROUP]["sortOrder"], groups[GROUP2]["sortOrder"]), (0, 1))
        self.client.patch(f"/timeclock/shift-groups/{GROUP}", json={"name": "Rb Store", "members": [A, B], "sort_order": 5})
        groups = {g["id"]: g for g in self.client.get("/timeclock/shift-groups").json()["groups"]}
        self.assertEqual(groups[GROUP]["sortOrder"], 5)

    # ── Section 5: publish ────────────────────────────────────────────────

    def test_publish_counts_cancels_requests_on_changed_shifts_and_records_the_share(self):
        a = self._placed(A)
        b = self._placed(B, day=TUE)
        unshared = self.client.get("/timeclock/schedule/unshared").json()
        self.assertEqual((unshared["count"], unshared["firstDate"], unshared["lastDate"]), (2, MON, TUE))
        grid = self._grid()
        self.assertEqual((grid["unsharedCount"], grid["lastPublishedAt"]), (2, ""))
        first = self._publish()
        self.assertEqual((first["published"], first["added"], first["edited"], first["removed"], first["notified"]), (2, 2, 0, 0, 2))
        self.assertTrue(first["lastPublishedAt"])
        grid = self._grid()
        self.assertEqual(grid["unsharedCount"], 0)
        self.assertEqual(grid["lastPublishedAt"], first["lastPublishedAt"])
        # A pending offer on A's shift; then A's shift is edited and B's removed, and published.
        db = database.SessionLocal()
        try:
            db.add(models.ShiftRequest(id="req-rb-1", kind="offer", status="pending_manager", requester_email=A,
                                       shift_id=a["id"], target_email=B, shift_date=MON, shift_start="09:00", shift_end="17:00",
                                       created_at="2026-10-01T00:00:00"))
            db.add(models.ShiftRequest(id="req-rb-2", kind="open", status="pending_manager", requester_email=B,
                                       shift_id=b["id"], shift_date=TUE, shift_start="09:00", shift_end="17:00",
                                       created_at="2026-10-01T00:00:00"))
            db.commit()
        finally:
            db.close()
        self.client.patch(f"/timeclock/schedule/{a['id']}", json={"employee_email": A, "work_date": MON, "start_hhmm": "10:00"})
        self.client.delete(f"/timeclock/schedule/{b['id']}")
        self.assertEqual(self.client.get(f"/timeclock/schedule/unshared?start={MON}&end={MON}").json()["count"], 1)
        second = self._publish()
        self.assertEqual((second["edited"], second["removed"], second["requestsCancelled"]), (1, 1, 2))
        db = database.SessionLocal()
        try:
            reqs = {r.id: r for r in db.query(models.ShiftRequest).filter(models.ShiftRequest.id.like("req-rb-%")).all()}
            self.assertEqual({r.status for r in reqs.values()}, {"cancelled"})
            self.assertEqual({r.decision_note for r in reqs.values()}, {"Shift changed before a decision"})
            bells = [n for n in db.query(models.NexusNotification).filter(models.NexusNotification.recipient == A).all()]
            self.assertEqual(sorted(n.title for n in bells), ["Shift request cancelled", "Your schedule was updated"])
            # ONE "schedule updated" row per (person, range), updated in place.
            self.assertEqual(len([n for n in bells if n.title == "Your schedule was updated"]), 1)
            last = json.loads(db.query(models.NexusSetting).filter(models.NexusSetting.key == "shift_last_publish").first().value)
            self.assertEqual((last["start"], last["end"], last["by"]), (MON, TUE, BOSS))
        finally:
            db.close()

    def test_publish_is_capped_at_92_days(self):
        far = (date.fromisoformat(MON) + timedelta(days=92)).isoformat()
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": far})
        self.assertEqual(r.status_code, 400)
        ok = (date.fromisoformat(MON) + timedelta(days=91)).isoformat()
        self.assertEqual(self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": ok}).status_code, 200)

    def test_a_teams_publish_shares_its_open_shifts_too(self):
        self._placed(A)
        self._placed("", open_slots=1, group_id=GROUP)
        self._placed("", open_slots=1, group_id=GROUP2, start_hhmm="10:00")
        r = self._publish(group_id=GROUP)
        self.assertEqual(r["published"], 2)
        self.assertEqual(self.client.get("/timeclock/schedule/unshared").json()["count"], 1)

    # ── Move ownership (B2-11) ────────────────────────────────────────────

    def test_a_scoped_manager_cannot_move_another_managers_open_shift(self):
        boss_open = self._placed("", open_slots=1, group_id=GROUP)["id"]
        self._as(M1)
        r = self.client.post(f"/timeclock/schedule/{boss_open}/move", json={"employee_email": "", "work_date": TUE})
        self.assertEqual(r.status_code, 403)
        mine = self._placed("", open_slots=1, group_id=GROUP, start_hhmm="10:00")["id"]
        r = self.client.post(f"/timeclock/schedule/{mine}/move", json={"employee_email": "", "work_date": TUE})
        self.assertEqual(r.status_code, 200, r.text)
        # Nor another team's person's shift.
        self._as(BOSS)
        bs = self._placed(B)["id"]
        self._as(M1)
        self.assertEqual(self.client.post(f"/timeclock/schedule/{bs}/move", json={"employee_email": B, "work_date": TUE}).status_code, 403)

    # ── Section 8: time off ───────────────────────────────────────────────

    def _timeoff(self, email, a, b, status="pending", **extra):
        db = database.SessionLocal()
        try:
            tid = f"to-rb-{email}-{a}-{extra.get('start_time', '')}"
            kind = extra.pop("type", "vacation")
            db.add(models.TimeOffRequest(id=tid, employee_email=email, type=kind, start_date=a, end_date=b,
                                         status=status, created_at="2026-10-01T00:00:00", **extra))
            db.commit()
            return tid
        finally:
            db.close()

    def test_approving_leave_returns_the_shifts_it_lands_on_and_can_remove_them(self):
        s1 = self._placed(A)                                            # MON 9-5
        s2 = self._placed(A, day=TUE, start_hhmm="18:00", end_hhmm="22:00")
        self._placed(A, day=SUN)                                        # outside the leave
        self._publish(SUN, TUE)
        tid = self._timeoff(A, MON, TUE)
        self._as(M1)
        r = self.client.patch(f"/timeclock/timeoff/{tid}", json={"status": "approved"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(sorted(c["id"] for c in r.json()["conflicts"]), sorted([s1["id"], s2["id"]]))
        self.assertEqual(r.json()["shiftsRemoved"], 0)
        self.assertEqual(self._row(s1["id"]).pending_delete, 0)
        # A part-day request only names the shifts those hours overlap.
        tid2 = self._timeoff(B, MON, MON, start_time="14:00", end_time="16:00")
        self._as(BOSS)
        morning = self._placed(B, start_hhmm="06:00", end_hhmm="12:00")
        afternoon = self._placed(B, start_hhmm="13:00", end_hhmm="21:00")
        self._publish()
        r = self.client.patch(f"/timeclock/timeoff/{tid2}", json={"status": "approved", "remove_shifts": True}).json()
        self.assertEqual([c["id"] for c in r["conflicts"]], [afternoon["id"]])
        self.assertEqual(r["shiftsRemoved"], 1)
        self.assertEqual((self._row(afternoon["id"]).pending_delete, self._row(morning["id"]).pending_delete), (1, 0))

    def test_approved_leave_takes_a_follow_up_remove_shifts(self):
        # The inbox approves first, sees the conflicts, then asks to remove
        # them: a second PATCH on the APPROVED row with remove_shifts marks
        # the shifts and changes nothing else; any other repeat is still 409.
        s1 = self._placed(A)
        self._publish()
        tid = self._timeoff(A, MON, MON)
        self._as(M1)
        first = self.client.patch(f"/timeclock/timeoff/{tid}", json={"status": "approved"}).json()
        self.assertEqual([c["id"] for c in first["conflicts"]], [s1["id"]])
        r = self.client.patch(f"/timeclock/timeoff/{tid}", json={"status": "approved", "remove_shifts": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["shiftsRemoved"], 1)
        self.assertEqual(r.json()["status"], "approved")
        self.assertEqual(self._row(s1["id"]).pending_delete, 1)
        self.assertEqual(self.client.patch(f"/timeclock/timeoff/{tid}", json={"status": "approved"}).status_code, 409)
        self.assertEqual(self.client.patch(f"/timeclock/timeoff/{tid}", json={"status": "rejected", "remove_shifts": True}).status_code, 409)

    def test_overlapping_time_off_is_refused(self):
        self._timeoff(A, MON, TUE)
        self._as(A)
        r = self.client.post("/timeclock/timeoff", json={"type": "sick", "start_date": TUE, "end_date": TUE})
        self.assertEqual((r.status_code, r.json()["detail"]), (409, "A request for those days is already pending/approved"))
        self.assertEqual(self.client.post("/timeclock/timeoff", json={"type": "sick", "start_date": SUN, "end_date": SUN}).status_code, 200)
        self._as(BOSS)
        r = self.client.post("/timeclock/timeoff/on-behalf", json={"employee_email": A, "type": "vacation", "start_date": MON, "end_date": MON})
        self.assertEqual(r.status_code, 409)
        # Two part-day requests on one day collide only when their hours do.
        self._timeoff(B, MON, MON, start_time="09:00", end_time="10:00")
        self._as(B)
        self.assertEqual(self.client.post("/timeclock/timeoff", json={"type": "sick", "start_date": MON, "end_date": MON,
                                                                      "start_time": "09:30", "end_time": "11:00"}).status_code, 409)
        self.assertEqual(self.client.post("/timeclock/timeoff", json={"type": "sick", "start_date": MON, "end_date": MON,
                                                                      "start_time": "11:00", "end_time": "12:00"}).status_code, 200)

    def test_half_day_is_built_in_and_types_ignore_case(self):
        self._as(A)
        self.assertIn("1/2 Day", self.client.get("/timeclock/timeoff/types").json()["builtIn"])
        self.assertEqual(self.client.post("/timeclock/timeoff", json={"type": "1/2 day", "start_date": MON, "end_date": MON}).status_code, 200)
        self.assertEqual(self.client.post("/timeclock/timeoff", json={"type": "VACATION", "start_date": TUE, "end_date": TUE}).status_code, 200)
        self.assertEqual(self.client.post("/timeclock/timeoff", json={"type": "Beach Day", "start_date": SUN, "end_date": SUN}).status_code, 400)

    def test_the_time_off_list_pages_by_date_with_no_300_cap(self):
        db = database.SessionLocal()
        try:
            for i in range(320):
                d = (date(2025, 1, 1) + timedelta(days=i * 2)).isoformat()
                db.add(models.TimeOffRequest(id=f"to-rb-page-{i}", employee_email=A, type="vacation", start_date=d, end_date=d,
                                             status="approved", created_at=f"2025-01-01T00:{i % 60:02d}:00"))
            db.commit()
        finally:
            db.close()
        everything = self.client.get("/timeclock/timeoff?from=2024-01-01").json()
        mine = [t for t in everything if t["email"] == A]
        self.assertEqual(len(mine), 320)
        self.assertEqual(mine[0]["startDate"], "2026-10-01")                      # newest first (01/01/2025 + 638 days)
        window = self.client.get("/timeclock/timeoff?from=2025-03-01&to=2025-03-31").json()
        self.assertEqual(len([t for t in window if t["email"] == A]), 15)      # every other day in March
        capped = self.client.get("/timeclock/timeoff?from=2024-01-01&limit=5").json()
        self.assertEqual(len(capped), 5)
        self.assertEqual(self.client.get("/timeclock/timeoff?from=yesterday").status_code, 400)

    def test_copying_a_week_leaves_teams_days_off_behind(self):
        for i, kind in enumerate(("Off", "Holiday", "vacation")):
            self._timeoff(A, MON, MON, status="approved", type=kind, start_time=f"0{i}:00", end_time=f"0{i + 1}:00")
        next_mon = (date.fromisoformat(MON) + timedelta(days=7)).isoformat()
        r = self.client.post("/timeclock/schedule/copy", json={"source_start": MON, "source_end": TUE, "target_start": next_mon,
                                                               "include_timeoff": True}).json()
        self.assertEqual(r["timeoffCopied"], 1)
        db = database.SessionLocal()
        try:
            copied = db.query(models.TimeOffRequest).filter(models.TimeOffRequest.employee_email == A,
                                                            models.TimeOffRequest.start_date == next_mon).all()
            self.assertEqual([t.type for t in copied], ["vacation"])
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
