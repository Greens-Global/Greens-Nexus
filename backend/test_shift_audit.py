"""Shifts audit fixes (Sep 29 2026) - what the audit against Teams Shifts
found still wrong, and the rule each fix holds to:

  - deleting a preset leaves the shifts placed from it looking as they did
  - a shift is placed only on a real date, for a person on the People list
  - "today or later" is judged in the shift's own time zone, not in UTC
  - what staff see of a teammate (why they are off; a shift's note,
    activities and break) follows the shift settings; a confidential reason
    reaches no teammate
  - the settings and groups are offered only to those who can save them
  - copying a schedule can leave the activities behind
  - the time-off reasons start as the ones the company had in Teams
  - the grid reads everyone's holidays in one go, with the same answer

    python -m pytest test_shift_audit.py
"""
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models
from routers import shift_requests, timeclock

models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text  # noqa: E402
with database.engine.connect() as _c:
    for _sql in ("ALTER TABLE scheduled_shifts ADD COLUMN open_slots INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN published INTEGER DEFAULT 1",
                 "ALTER TABLE scheduled_shifts ADD COLUMN pending_json TEXT DEFAULT ''",
                 "ALTER TABLE scheduled_shifts ADD COLUMN pending_delete INTEGER DEFAULT 0",
                 "ALTER TABLE shifts ADD COLUMN break_min INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN break_min INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN activities_json TEXT DEFAULT ''",
                 "ALTER TABLE scheduled_shifts ADD COLUMN color TEXT DEFAULT ''",
                 "ALTER TABLE shift_groups ADD COLUMN scheduler_emails TEXT DEFAULT ''",
                 "ALTER TABLE time_off_requests ADD COLUMN confidential INTEGER DEFAULT 0"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

BOSS = "saud.boss@greensglobal.com"     # administrator: company-wide
M1 = "saud.m1@greensglobal.com"         # manager of A only
A = "saud.a@greensglobal.com"
B = "saud.b@greensglobal.com"
GROUP, PRESET, COMPANY = "group-saud", "preset-saud", "co-saud"
SETTING_KEYS = ["shift_requests_config", "timeoff_custom_reasons"]
DAY = (datetime.now(timezone.utc).date() + timedelta(days=10)).isoformat()
DAY2 = (datetime.now(timezone.utc).date() + timedelta(days=17)).isoformat()


class ShiftAuditTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (BOSS, M1, A, B):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].upper(), last_name="X",
                                            work_email=em, status="active", deleted_at="",
                                            manager_email=M1 if em == A else "",
                                            company=COMPANY if em in (A, B) else "",
                                            country="US" if em == A else "IN" if em == B else ""))
            db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=M1, role="manager", assigned_by="test"))
            db.add(models.ShiftGroup(id=GROUP, name="Saud Store"))
            for i, em in enumerate((A, B)):
                db.add(models.ShiftGroupMember(id=f"sgm-saud-{i}", group_id=GROUP, employee_email=em))
            db.add(models.Shift(id=PRESET, code="SAU", name="Saud Day", start_hhmm="09:00", end_hhmm="17:00",
                                days="1,2,3,4,5", color="#16a34a", timezone="America/Los_Angeles"))
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
            db.query(models.NexusRole).filter(models.NexusRole.email.like("saud.%")).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("saud.%")).delete(synchronize_session=False))
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("saud.%")) |
                (models.ScheduledShift.created_by.like("saud.%"))).delete(synchronize_session=False)
            db.query(models.ShiftAssignment).filter(models.ShiftAssignment.employee_email.like("saud.%")).delete(synchronize_session=False)
            db.query(models.TimeOffRequest).filter(models.TimeOffRequest.employee_email.like("saud.%")).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("saud.%")).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key.in_(SETTING_KEYS)).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == PRESET).delete(synchronize_session=False)
            db.query(models.HrCompanyHoliday).filter(models.HrCompanyHoliday.company_id == COMPANY).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _place(self, email, day=DAY, **over):
        body = {"employee_email": email, "work_date": day, "shift_id": PRESET, **over}
        r = self.client.post("/timeclock/schedule", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def _publish(self, d0=DAY, d1=DAY):
        self.assertEqual(self.client.post("/timeclock/schedule/publish", json={"start_date": d0, "end_date": d1}).status_code, 200)

    def _settings(self, **cfg):
        r = self.client.put("/timeclock/shift-requests/settings", json=cfg)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _row(self, sid):
        db = database.SessionLocal()
        try:
            return db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first()
        finally:
            db.close()

    # ── Presets ──────────────────────────────────────────────────────────
    def test_deleting_a_preset_keeps_placed_shifts_looking_the_same(self):
        plain = self._place(A)
        own = self._place(B, label="Register", color="#dc2626")
        listed = {s["id"]: s for s in self.client.get("/timeclock/shifts").json()["shifts"]}
        self.assertEqual(listed[PRESET]["placed"], 2)     # what the confirmation tells the manager
        r = self.client.delete(f"/timeclock/shifts/{PRESET}")
        self.assertEqual(r.json(), {"ok": True, "placedKept": 2})
        a, b = self._row(plain), self._row(own)
        self.assertEqual((a.color, a.label), ("#16a34a", "SAU"))          # took the preset's
        self.assertEqual((b.color, b.label), ("#dc2626", "Register"))     # kept its own
        grid = {s["id"]: s for s in self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY}").json()["scheduled"]}
        self.assertEqual(grid[plain]["color"], "#16a34a")

    def test_the_preset_list_counts_usual_hours(self):
        self.assertEqual(self.client.post("/timeclock/shift-assign", json={"shift_id": PRESET, "emails": [A, B]}).status_code, 200)
        body = self.client.get("/timeclock/shifts").json()
        self.assertEqual({s["id"]: s["assigned"] for s in body["shifts"]}[PRESET], 2)
        self.assertEqual(body["defaultTimezone"], "America/Los_Angeles")
        # ...and the grid carries them as usual hours, never as shifts.
        grid = self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY}").json()
        self.assertEqual(grid["usual"], {A: PRESET, B: PRESET})
        self.assertEqual(grid["scheduled"], [])

    # ── Placing a shift ──────────────────────────────────────────────────
    def test_a_shift_needs_a_real_date_and_a_person_on_the_people_list(self):
        bad_day = self.client.post("/timeclock/schedule", json={"employee_email": A, "work_date": "next tuesday", "shift_id": PRESET})
        self.assertEqual(bad_day.status_code, 400)
        self.assertEqual(bad_day.json()["detail"], "Invalid date.")
        stranger = self.client.post("/timeclock/schedule", json={"employee_email": "saud.nobody@greensglobal.com",
                                                                 "work_date": DAY, "shift_id": PRESET})
        self.assertEqual(stranger.status_code, 400)
        self.assertEqual(stranger.json()["detail"], "That person is not in the People list.")
        # An open shift has no person, and a mixed-case address is the same person.
        self.assertEqual(self.client.post("/timeclock/schedule", json={"employee_email": "", "work_date": DAY,
                                                                       "shift_id": PRESET, "open_slots": 2}).status_code, 200)
        self.assertEqual(self.client.post("/timeclock/schedule", json={"employee_email": A.upper(), "work_date": DAY,
                                                                       "shift_id": PRESET}).status_code, 200)

    # ── Today, in the shift's own zone ───────────────────────────────────
    def test_today_is_judged_in_the_shifts_zone(self):
        # 6:30 PM Pacific on 09/29 is already 09/30 in UTC and in India.
        at = datetime(2026, 9, 30, 1, 30, tzinfo=timezone.utc)

        def local(tz):
            from zoneinfo import ZoneInfo
            return at.astimezone(ZoneInfo(tz or "America/Los_Angeles")).replace(tzinfo=None)

        pacific = models.Shift(id="p-la", timezone="America/Los_Angeles")
        india = models.Shift(id="p-in", timezone="Asia/Kolkata")
        presets = {"p-la": pacific, "p-in": india}
        cfg = {"timeZone": "Asia/Kolkata"}
        today_la = models.ScheduledShift(id="x", shift_id="p-la", work_date="2026-09-29")
        today_in = models.ScheduledShift(id="y", shift_id="p-in", work_date="2026-09-29")
        loose = models.ScheduledShift(id="z", shift_id="", work_date="2026-09-29")       # no preset: the team's zone
        with mock.patch.object(shift_requests, "_shift_local_now", side_effect=local):
            self.assertTrue(shift_requests._upcoming(today_la, presets, cfg))     # still today in California
            self.assertFalse(shift_requests._upcoming(today_in, presets, cfg))    # yesterday in India
            self.assertFalse(shift_requests._upcoming(loose, presets, cfg))
            self.assertTrue(shift_requests._upcoming(loose, presets, {"timeZone": "America/Los_Angeles"}))

    # ── Settings ─────────────────────────────────────────────────────────
    def test_new_settings_default_and_save(self):
        cfg = self.client.get("/timeclock/shift-requests/settings").json()
        self.assertEqual((cfg["teamTimeOffReasons"], cfg["teamShiftDetails"], cfg["timeZone"]),
                         (False, True, "America/Los_Angeles"))
        saved = self._settings(teamTimeOffReasons=True, timeZone="Asia/Kolkata")
        self.assertEqual((saved["teamTimeOffReasons"], saved["timeZone"]), (True, "Asia/Kolkata"))
        self.assertTrue(saved["swaps"])                                     # the rest is untouched
        self.assertEqual(self.client.get("/timeclock/shifts").json()["defaultTimezone"], "Asia/Kolkata")
        bad = self.client.put("/timeclock/shift-requests/settings", json={"timeZone": "Mars/Olympus"})
        self.assertEqual(bad.status_code, 400)

    def test_settings_and_groups_are_offered_only_company_wide(self):
        boss = self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY}").json()
        self.assertTrue(boss["canConfigure"])
        self.assertTrue(self.client.get("/timeclock/shift-groups").json()["canManageGroups"])
        self._as(M1)   # a manager of their own reports
        mine = self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY}").json()
        self.assertTrue(mine["canManage"])
        self.assertFalse(mine["canConfigure"])
        self.assertFalse(self.client.get("/timeclock/shift-groups").json()["canManageGroups"])
        refused = self.client.put("/timeclock/shift-requests/settings", json={"swaps": False})
        self.assertEqual(refused.status_code, 403)
        self.assertEqual(refused.json()["detail"], "Changing shift settings needs company-wide team access")

    # ── What staff see of a teammate ─────────────────────────────────────
    def _timeoff(self, email, confidential=0, note="Family trip"):
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id=f"to-saud-{email}-{confidential}", employee_email=email, type="vacation",
                                         start_date=DAY2, end_date=DAY2, note=note, status="approved",
                                         created_at="2026-09-29T00:00:00", confidential=confidential))
            db.commit()
        finally:
            db.close()

    def _teammate(self, viewer, email, start=DAY, end=DAY2):
        self._as(viewer)
        me = self.client.get(f"/timeclock/my-schedule?start={start}&end={end}").json()
        return next(m for t in me["teams"] for m in t["members"] if m["email"] == email)

    def test_why_a_teammate_is_off_follows_the_setting(self):
        self._timeoff(B)
        self.assertEqual(self._teammate(A, B)["timeoff"], [{"startDate": DAY2, "endDate": DAY2}])    # off by default
        self._as(BOSS)
        self._settings(teamTimeOffReasons=True)
        self.assertEqual(self._teammate(A, B)["timeoff"],
                         [{"startDate": DAY2, "endDate": DAY2, "type": "vacation", "note": "Family trip"}])

    def test_a_confidential_reason_reaches_no_teammate(self):
        self._timeoff(B, confidential=1, note="Private")
        self._settings(teamTimeOffReasons=True)
        for viewer in (A, M1, BOSS):
            self.assertEqual(self._teammate(viewer, B)["timeoff"], [{"startDate": DAY2, "endDate": DAY2}], viewer)

    def test_shift_details_follow_the_setting(self):
        sid = self._place(B, note="Bring keys", break_min=30,
                          activities=[{"start": "10:00", "end": "11:00", "label": "Training"}])
        mine = self._place(A, note="Open up")
        self._publish()
        seen = self._teammate(A, B)["scheduled"][0]
        self.assertEqual((seen["id"], seen["note"], seen["breakMin"], len(seen["activities"])), (sid, "Bring keys", 30, 1))
        self._as(BOSS)
        self._settings(teamShiftDetails=False)
        hidden = self._teammate(A, B)["scheduled"][0]
        self.assertEqual((hidden["note"], hidden["breakMin"], hidden["activities"]), ("", 0, []))
        self.assertEqual((hidden["start"], hidden["end"]), ("09:00", "17:00"))     # when they work still shows
        own = self._teammate(A, A)["scheduled"][0]
        self.assertEqual((own["id"], own["note"]), (mine, "Open up"))               # your own is always yours
        self.assertEqual(self._teammate(M1, B)["scheduled"][0]["note"], "Bring keys")   # a manager sees it all

    def test_my_schedule_carries_the_zones(self):
        self._place(A)
        self._publish()
        self._settings(timeZone="Asia/Kolkata")
        self._as(A)
        me = self.client.get(f"/timeclock/my-schedule?start={DAY}&end={DAY}").json()
        self.assertEqual(me["timeZone"], "Asia/Kolkata")
        self.assertEqual(me["scheduled"][0]["timezone"], "America/Los_Angeles")     # the preset's own

    def test_the_team_grid_gets_photos(self):
        db = database.SessionLocal()
        try:
            b = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == B).first()
            b.photo_url = "https://example.supabase.co/storage/v1/object/public/avatars/b.jpg"
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._teammate(A, B)["photoUrl"], "https://example.supabase.co/storage/v1/object/public/avatars/b.jpg")
        self.assertEqual(self._teammate(A, A)["photoUrl"], "")        # none on file: the grid shows initials

    def test_the_inbox_says_who_may_change_the_settings(self):
        self.assertTrue(self.client.get("/timeclock/shift-requests").json()["canConfigure"])      # company-wide
        self._as(M1)
        self.assertFalse(self.client.get("/timeclock/shift-requests").json()["canConfigure"])     # their reports only

    # ── Copy ─────────────────────────────────────────────────────────────
    def test_a_copy_can_leave_the_activities_behind(self):
        self._place(A, activities=[{"start": "10:00", "end": "11:00", "label": "Training"}])
        week = (datetime.strptime(DAY, "%Y-%m-%d").date() + timedelta(days=7)).isoformat()
        fortnight = (datetime.strptime(DAY, "%Y-%m-%d").date() + timedelta(days=14)).isoformat()
        base = {"source_start": DAY, "source_end": DAY, "emails": [A], "skip_timeoff": False}
        self.assertEqual(self.client.post("/timeclock/schedule/copy", json={**base, "target_start": week}).json()["created"], 1)
        self.assertEqual(self.client.post("/timeclock/schedule/copy",
                                          json={**base, "target_start": fortnight, "include_activities": False}).json()["created"], 1)
        grid = {s["date"]: s for s in self.client.get(f"/timeclock/schedule?start={week}&end={fortnight}").json()["scheduled"]}
        self.assertEqual([a["label"] for a in grid[week]["activities"]], ["Training"])
        self.assertEqual(grid[fortnight]["activities"], [])

    # ── Time-off reasons ─────────────────────────────────────────────────
    def test_time_off_reasons_start_as_the_teams_list(self):
        first = self.client.get("/timeclock/timeoff/types").json()
        self.assertEqual(first["custom"], ["Approved Time Off", "Off", "Holiday", "Parental Leave", "Closed",
                                           "Medical Appointment", "Work From Home", "Requested Off"])
        self._as(A)
        ok = self.client.post("/timeclock/timeoff", json={"type": "Medical Appointment", "start_date": DAY2, "end_date": DAY2})
        self.assertEqual(ok.status_code, 200, ok.text)
        # A saved list is the list - an empty one included.
        self._as(BOSS)
        self.assertEqual(self.client.put("/timeclock/timeoff/types", json={"custom": []}).json()["custom"], [])
        self.assertEqual(self.client.get("/timeclock/timeoff/types").json()["custom"], [])

    # ── The reason for a leave ───────────────────────────────────────────
    def _bells(self, recipient):
        db = database.SessionLocal()
        try:
            return [n.body for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.recipient == recipient,
                            models.NexusNotification.title == "Time-off request").all()]
        finally:
            db.close()

    def test_the_approver_is_told_why(self):
        self._as(A)
        ask = self.client.post("/timeclock/timeoff", json={"type": "personal", "start_date": DAY2, "end_date": DAY2,
                                                           "note": "  Moving   house  "})
        self.assertEqual(ask.status_code, 200, ask.text)
        self.assertEqual(ask.json()["note"], "Moving   house")
        bells = self._bells(M1)      # A's manager
        self.assertEqual(len(bells), 1)
        self.assertTrue(bells[0].endswith(" Reason: Moving house"), bells[0])
        # ...and their own My Shifts day carries it.
        mine = self.client.get(f"/timeclock/my-schedule?start={DAY2}&end={DAY2}").json()["timeoff"]
        self.assertEqual([(t["type"], t["note"]) for t in mine], [("personal", "Moving   house")])

    def test_a_confidential_reason_is_never_in_the_bell(self):
        self._as(A)
        self.client.post("/timeclock/timeoff", json={"type": "sick", "start_date": DAY2, "end_date": DAY2,
                                                     "note": "Surgery", "confidential": True})
        bells = self._bells(M1)
        self.assertEqual(len(bells), 1)
        self.assertNotIn("Surgery", bells[0])
        self.assertNotIn("Reason", bells[0])
        # The type still shows (Neil, Sep 30: "time off medical", never the detail).
        self.assertIn("sick", bells[0])

    # ── Holidays ─────────────────────────────────────────────────────────
    def test_holidays_for_the_grid_match_the_per_person_lookup(self):
        db = database.SessionLocal()
        try:
            db.add(models.HrCompanyHoliday(id="hol-saud-1", company_id=COMPANY, date=DAY, name="Founders Day",
                                           type="mandatory", country_code=""))
            db.add(models.HrCompanyHoliday(id="hol-saud-2", company_id=COMPANY, date=DAY2, name="Diwali",
                                           type="optional", country_code="IN"))
            db.commit()
            people = {(e.work_email or "").lower(): e for e in db.query(models.NexusEmployee)
                      .filter(models.NexusEmployee.work_email.like("saud.%")).all()}
            many = timeclock._company_holidays_for_many(db, people, DAY, DAY2)
            for em in (A, B, M1, BOSS):
                self.assertEqual(many.get(em, {}), timeclock._company_holidays_for_employee(db, em, DAY, DAY2), em)
            self.assertEqual(set(many[A]), {DAY})              # US: the company-wide day only
            self.assertEqual(set(many[B]), {DAY, DAY2})        # IN: Diwali too
            self.assertNotIn(M1, many)                         # no company on file
        finally:
            db.close()
        grid = self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY2}").json()
        self.assertEqual(grid["holidays"][B][DAY2]["name"], "Diwali")


if __name__ == "__main__":
    unittest.main()
