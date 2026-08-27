"""Bulk shift assignment (Visesh, Aug 26) - apply a preset to a whole group
across a date range in one call, skipping time off and existing shifts.

    python -m unittest test_shift_bulk
"""
import os
import unittest
import uuid

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "shiftbulk.admin@greensglobal.com"
A = "shiftbulk.a@greensglobal.com"
B = "shiftbulk.b@greensglobal.com"
C = "shiftbulk.c@greensglobal.com"     # NOT in the group
GROUP = "grp-shiftbulk"
GRANT = "grant-shiftbulk"
SHIFT = "shift-shiftbulk"


class ShiftBulkTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, A, B, C):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1], last_name="X",
                                            work_email=em, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GRANT, name="ShiftBulk grant", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GRANT, email=ADMIN))
            # a shift GROUP (scheduling group) with A and B
            db.add(models.ShiftGroup(id=GROUP, name="Bulk Team", created_at="2026-08-26T00:00:00"))
            db.add(models.ShiftGroupMember(id=str(uuid.uuid4()), group_id=GROUP, employee_email=A))
            db.add(models.ShiftGroupMember(id=str(uuid.uuid4()), group_id=GROUP, employee_email=B))
            # a preset
            db.add(models.Shift(id=SHIFT, code="001", name="Day", start_hhmm="09:00", end_hhmm="17:00", color="#64748b"))
            # B already has a shift on Mon 2026-08-24, and time off Tue 2026-08-25
            db.add(models.ScheduledShift(id="pre-b-mon", employee_email=B, work_date="2026-08-24",
                                         shift_id=SHIFT, start_hhmm="12:00", end_hhmm="20:00", label="pre"))
            db.add(models.TimeOffRequest(id="off-b-tue", employee_email=B, type="pto",
                                         start_date="2026-08-25", end_date="2026-08-25", status="approved"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

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
               .filter(models.NexusEmployee.work_email.like("shiftbulk.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GRANT).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GRANT).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == SHIFT).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(models.ScheduledShift.employee_email.like("shiftbulk.%")).delete(synchronize_session=False)
            db.query(models.TimeOffRequest).filter(models.TimeOffRequest.employee_email.like("shiftbulk.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _sched(self, email):
        db = database.SessionLocal()
        try:
            return {r.work_date: r for r in db.query(models.ScheduledShift)
                    .filter(models.ScheduledShift.employee_email == email).all()}
        finally:
            db.close()

    def test_bulk_group_weekdays_skips_timeoff_and_existing(self):
        # Fill Mon-Fri of the week 08/24-08/30 for the Bulk Team group.
        r = self.client.post("/timeclock/schedule/bulk", json={
            "group_id": GROUP, "shift_id": SHIFT,
            "start_date": "2026-08-24", "end_date": "2026-08-30",
            "weekdays": [0, 1, 2, 3, 4], "skip_timeoff": True, "overwrite": False})
        self.assertEqual(r.status_code, 200, r.text)
        d = r.json()
        # A: all 5 weekdays created. B: Mon kept (existing), Tue skipped (time off),
        # Wed/Thu/Fri created = 3. Total created 8, kept 1, timeoff 1.
        self.assertEqual(d["people"], 2)
        self.assertEqual(d["created"], 8)
        self.assertEqual(d["skipped"], 1)          # B's Monday pre-existing shift
        self.assertEqual(d["timeoffSkipped"], 1)   # B's Tuesday off
        a = self._sched(A)
        self.assertEqual(set(a.keys()), {"2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"})
        self.assertEqual(a["2026-08-24"].start_hhmm, "09:00")   # from the preset
        b = self._sched(B)
        self.assertEqual(b["2026-08-24"].start_hhmm, "12:00")   # kept, not overwritten
        self.assertNotIn("2026-08-25", b)                        # time off, skipped
        self.assertIn("2026-08-26", b)

    def test_overwrite_replaces_existing(self):
        r = self.client.post("/timeclock/schedule/bulk", json={
            "group_id": GROUP, "shift_id": SHIFT,
            "start_date": "2026-08-24", "end_date": "2026-08-24",
            "weekdays": [0], "skip_timeoff": False, "overwrite": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["replaced"], 1)               # B's Monday replaced
        self.assertEqual(self._sched(B)["2026-08-24"].start_hhmm, "09:00")

    def test_group_only_never_touches_non_member(self):
        self.client.post("/timeclock/schedule/bulk", json={
            "group_id": GROUP, "shift_id": SHIFT,
            "start_date": "2026-08-24", "end_date": "2026-08-28", "weekdays": [0, 1, 2, 3, 4]})
        self.assertEqual(self._sched(C), {})   # C is not in the group


if __name__ == "__main__":
    unittest.main()
