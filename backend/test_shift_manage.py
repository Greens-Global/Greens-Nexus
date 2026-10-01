"""Who may change shifts (Neil, Sep 29 2026): managers and above only.
Employees - including an HR-grant holder or a group's named scheduler below
manager - never change a shift; nobody decides their own shift request; a
scoped manager touches only the open shifts they posted; and a manager's
own-and-team view includes the teams they run.

    python -m unittest test_shift_manage
"""
import os
import unittest
from datetime import datetime, timedelta, timezone

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

BOSS = "smgr.boss@greensglobal.com"     # administrator: company-wide
M1 = "smgr.m1@greensglobal.com"         # manager of A, member of the Store group
M2 = "smgr.m2@greensglobal.com"         # manager of B, NOT in the group
A = "smgr.a@greensglobal.com"
B = "smgr.b@greensglobal.com"
HR = "smgr.hr@greensglobal.com"         # employee with an hr:editor grant
GROUP, GRANT = "group-smgr", "grant-smgr"
DAY = (datetime.now(timezone.utc).date() + timedelta(days=10)).isoformat()


class ShiftManageTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            mgr = {A: M1, B: M2}
            for em in (BOSS, M1, M2, A, B, HR):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].upper(), last_name="X",
                                            work_email=em, status="active", deleted_at="", manager_email=mgr.get(em, "")))
            db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
            db.add(models.NexusRole(email=M1, role="manager", assigned_by="test"))
            db.add(models.NexusRole(email=M2, role="manager", assigned_by="test"))
            db.add(models.NexusGroup(id=GRANT, name="ed", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GRANT, email=HR))
            db.add(models.ShiftGroup(id=GROUP, name="Store"))
            for i, em in enumerate((A, B, M1)):
                db.add(models.ShiftGroupMember(id=f"sgm-smgr-{i}", group_id=GROUP, employee_email=em))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

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
            db.query(models.NexusRole).filter(models.NexusRole.email.like("smgr.%")).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("smgr.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GRANT).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GRANT).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("smgr.%")) |
                (models.ScheduledShift.created_by.like("smgr.%"))).delete(synchronize_session=False)
            db.query(models.ShiftRequest).filter(models.ShiftRequest.requester_email.like("smgr.%")).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("smgr.%")).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key == "shift_requests_config").delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.name.like("Smgr%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _published(self, email):
        db = database.SessionLocal()
        try:
            sid = f"ss-smgr-{email}"
            db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=DAY, start_hhmm="09:00",
                                         end_hhmm="17:00", published=1, created_by=BOSS,
                                         created_at="2026-09-29T00:00:00"))
            db.commit()
            return sid
        finally:
            db.close()

    def _open(self, who, start="10:00"):
        self._as(who)
        r = self.client.post("/timeclock/schedule", json={"employee_email": "", "work_date": DAY,
                                                          "start_hhmm": start, "end_hhmm": "14:00", "open_slots": 1, "group_id": GROUP})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def test_employees_change_nothing(self):
        sid = self._published(A)
        for who in (A, HR):   # a plain employee, and an HR editor below manager
            self._as(who)
            calls = [
                self.client.post("/timeclock/schedule", json={"employee_email": A, "work_date": DAY,
                                                              "start_hhmm": "09:00", "end_hhmm": "12:00"}),
                self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": A, "work_date": DAY,
                                                                      "start_hhmm": "08:00", "end_hhmm": "12:00"}),
                self.client.delete(f"/timeclock/schedule/{sid}"),
                self.client.post("/timeclock/schedule/publish", json={"start_date": DAY, "end_date": DAY}),
                self.client.put("/timeclock/schedule/day-note", json={"work_date": DAY, "note": "x"}),
                self.client.post("/timeclock/shifts", json={"name": "Smgr Preset", "start_hhmm": "09:00", "end_hhmm": "17:00"}),
                self.client.post("/timeclock/shift-groups", json={"name": "Smgr Group", "members": [A]}),
                self.client.post("/timeclock/shift-assign", json={"shift_id": "", "emails": [A]}),
                self.client.put("/timeclock/shift-requests/settings", json={"swaps": False}),
            ]
            self.assertEqual([c.status_code for c in calls], [403] * len(calls), who)
            self.assertEqual(calls[0].json()["detail"], "Only managers and above can change shifts.")
        self._as(A)
        me = self.client.get(f"/timeclock/my-schedule?start={DAY}&end={DAY}").json()
        self.assertFalse(me["canManage"])
        self.assertEqual(me["scheduled"][0]["id"], sid)        # still sees their own shift
        team = me["teams"][0]
        self.assertTrue(team["isMember"])
        self.assertTrue(team["members"][0]["isMe"])             # themself first

    def test_nobody_decides_their_own_request(self):
        mine = self._published(M1)
        self._as(M1)
        ask = self.client.post("/timeclock/shift-requests", json={"kind": "offer", "shift_id": mine, "target_email": A})
        self.assertEqual(ask.status_code, 200, ask.text)
        rid = ask.json()["id"]
        self._as(A)
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{rid}/respond", json={"accept": True}).status_code, 200)
        # The requester manager neither sees it waiting on them nor can decide it.
        self._as(M1)
        self.assertNotIn(rid, [r["id"] for r in self.client.get("/timeclock/shift-requests").json()["pending"]])
        own = self.client.post(f"/timeclock/shift-requests/{rid}/decide", json={"approve": True})
        self.assertEqual(own.status_code, 403)
        # Another manager above them decides it.
        self._as(BOSS)
        self.assertIn(rid, [r["id"] for r in self.client.get("/timeclock/shift-requests").json()["pending"]])
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{rid}/decide", json={"approve": True}).status_code, 200)

    def test_open_shifts_belong_to_the_manager_who_posted_them(self):
        boss_open = self._open(BOSS)
        m1_open = self._open(M1, "12:00")
        self._as(M1)
        grid = self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY}").json()
        can = {s["id"]: s.get("canEdit") for s in grid["scheduled"] if not s["email"]}
        self.assertEqual(can, {boss_open: False, m1_open: True})
        body = {"employee_email": "", "work_date": DAY, "start_hhmm": "11:00", "end_hhmm": "15:00", "open_slots": 1, "group_id": GROUP}
        self.assertEqual(self.client.patch(f"/timeclock/schedule/{boss_open}", json=body).status_code, 403)
        self.assertEqual(self.client.delete(f"/timeclock/schedule/{boss_open}").status_code, 403)
        self.assertEqual(self.client.post(f"/timeclock/schedule/{boss_open}/assign", json={"employee_email": A}).status_code, 403)
        self.assertEqual(self.client.post(f"/timeclock/schedule/{m1_open}/assign", json={"employee_email": A}).status_code, 200)
        # Publishing shares M1's own work, never the administrator's slot.
        self.client.post("/timeclock/schedule/publish", json={"start_date": DAY, "end_date": DAY})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.ScheduledShift).filter(models.ScheduledShift.id == boss_open).first().published, 0)
        finally:
            db.close()
        # An unscoped administrator may change anyone's open shift.
        self._as(BOSS)
        self.assertEqual(self.client.patch(f"/timeclock/schedule/{boss_open}", json=body).status_code, 200)

    def test_a_manager_sees_the_teams_they_run(self):
        self._as(BOSS)
        self.assertEqual(self.client.put("/timeclock/shift-requests/settings", json={"teamSchedules": False}).status_code, 200)
        # Staff: team schedules are hidden by the setting.
        self._as(A)
        self.assertEqual(self.client.get(f"/timeclock/my-schedule?start={DAY}&end={DAY}").json()["teams"], [])
        # M2 is not in the group, but their report B is - they run it.
        self._as(M2)
        me = self.client.get(f"/timeclock/my-schedule?start={DAY}&end={DAY}").json()
        self.assertTrue(me["canManage"])
        self.assertEqual([(t["id"], t["isMember"]) for t in me["teams"]], [(GROUP, False)])
        self.assertEqual({m["email"] for m in me["teams"][0]["members"]}, {A, B, M1})


if __name__ == "__main__":
    unittest.main()
