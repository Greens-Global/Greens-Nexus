"""Shift group settings (Neil, Oct 28 2026): open shifts are a per-team switch,
off by default, and a group can follow a department - its people are added
automatically and taken off when they leave it; people added by hand stay.

    python -m unittest test_shift_group_settings
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

BOSS = "sgs.boss@greensglobal.com"
CREW1 = "sgs.crew1@greensglobal.com"
CREW2 = "sgs.crew2@greensglobal.com"
OFFICE = "sgs.office@greensglobal.com"
CO, OTHER_CO = "sgs-co", "sgs-other-co"
DAY = (datetime.now(timezone.utc).date() + timedelta(days=10)).isoformat()


def _emp(em, dept, company=CO, status="active"):
    return models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].upper(), last_name="X", work_email=em,
                                status=status, deleted_at="", department=dept, company=company)


class ShiftGroupSettingsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for cid in (CO, OTHER_CO):
                db.add(models.HrEntity(id=cid, name=f"Sgs {cid}"))
            db.add(_emp(BOSS, "Administration"))
            db.add(_emp(CREW1, "Construction"))
            db.add(_emp(OFFICE, "Accounting"))
            db.add(models.NexusRole(email=BOSS, role="administrator", assigned_by="test"))
            db.commit()
        finally:
            db.close()
        os.environ["NEXUS_DEV_EMAIL"] = BOSS
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        self._cleanup()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()

    def _cleanup(self):
        db = database.SessionLocal()
        try:
            gids = [g.id for g in db.query(models.ShiftGroup).filter(models.ShiftGroup.name.like("Sgs %")).all()]
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id.in_(gids)).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.employee_email.like("sgs.%")).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id.in_(gids)).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(models.ScheduledShift.created_by.like("sgs.%")).delete(synchronize_session=False)
            db.query(models.NexusRole).filter(models.NexusRole.email.like("sgs.%")).delete(synchronize_session=False)
            db.query(models.HrEntity).filter(models.HrEntity.id.in_([CO, OTHER_CO])).delete(synchronize_session=False)
            (db.query(models.NexusEmployee).execution_options(include_deleted=True)
               .filter(models.NexusEmployee.work_email.like("sgs.%")).delete(synchronize_session=False))
            db.commit()
        finally:
            db.close()

    def _members(self, gid):
        db = database.SessionLocal()
        try:
            return {m.employee_email: m.source or "" for m in
                    db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == gid).all()}
        finally:
            db.close()

    def _set_emp(self, em, **fields):
        db = database.SessionLocal()
        try:
            e = db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == em).first()
            for k, v in fields.items():
                setattr(e, k, v)
            db.commit()
        finally:
            db.close()

    def _open_shift(self, gid):
        return self.client.post("/timeclock/schedule", json={"employee_email": "", "work_date": DAY, "start_hhmm": "09:00",
                                                             "end_hhmm": "14:00", "open_slots": 1, "group_id": gid})

    def test_open_shifts_are_off_until_the_team_turns_them_on(self):
        gid = self.client.post("/timeclock/shift-groups", json={"name": "Sgs Ops", "members": [], "company_id": CO}).json()["id"]
        listed = next(g for g in self.client.get("/timeclock/shift-groups").json()["groups"] if g["id"] == gid)
        self.assertFalse(listed["openShifts"])
        r = self._open_shift(gid)
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("Open shifts are off for Sgs Ops", r.json()["detail"])
        self.assertEqual(self.client.patch(f"/timeclock/shift-groups/{gid}",
                                           json={"name": "Sgs Ops", "members": [], "open_shifts": True}).status_code, 200)
        self.assertEqual(self._open_shift(gid).status_code, 200)
        # Off again: the open shift already posted is still on the schedule.
        self.client.patch(f"/timeclock/shift-groups/{gid}", json={"name": "Sgs Ops", "members": [], "open_shifts": False})
        sched = self.client.get(f"/timeclock/schedule?start={DAY}&end={DAY}").json()
        self.assertTrue(any(s.get("groupId") == gid for s in sched.get("openShifts", [])), sched.get("openShifts"))
        self.assertFalse(next(g for g in sched["groups"] if g["id"] == gid)["openShifts"])

    def test_a_group_follows_its_department(self):
        gid = self.client.post("/timeclock/shift-groups", json={
            "name": "Sgs Construction", "members": [OFFICE], "company_id": CO, "department": "Construction"}).json()["id"]
        self.assertEqual(self._members(gid), {OFFICE: "", CREW1: "department"})
        listed = next(g for g in self.client.get("/timeclock/shift-groups").json()["groups"] if g["id"] == gid)
        self.assertEqual((listed["department"], listed["autoMembers"]), ("Construction", [CREW1]))

        # A new hire in the department joins; one in another company does not.
        db = database.SessionLocal()
        try:
            db.add(_emp(CREW2, "Construction"))
            db.add(_emp("sgs.elsewhere@greensglobal.com", "Construction", company=OTHER_CO))
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._members(gid), {OFFICE: "", CREW1: "department", CREW2: "department"})

        # Saving the group keeps the department's members marked as such.
        self.client.patch(f"/timeclock/shift-groups/{gid}", json={"name": "Sgs Construction", "members": [OFFICE, CREW1, CREW2]})
        self.assertEqual(self._members(gid)[CREW1], "department")

        # Leaving the department or going inactive takes the automatic row off;
        # someone added by hand stays whatever their department.
        self._set_emp(CREW1, department="Accounting")
        self._set_emp(CREW2, status="inactive")
        self._set_emp(OFFICE, department="Estimating")
        self.assertEqual(self._members(gid), {OFFICE: ""})

        # Back in the department: back on the group.
        self._set_emp(CREW1, department="Construction")
        self.assertEqual(self._members(gid), {OFFICE: "", CREW1: "department"})
        # The group stops following it: the department's people go, the rest stay.
        self.client.patch(f"/timeclock/shift-groups/{gid}", json={"name": "Sgs Construction", "members": [OFFICE, CREW1], "department": ""})
        self.assertEqual(self._members(gid), {OFFICE: ""})
        self._set_emp(CREW1, department="Accounting")
        self._set_emp(CREW1, department="Construction")
        self.assertEqual(self._members(gid), {OFFICE: ""})


if __name__ == "__main__":
    unittest.main()
