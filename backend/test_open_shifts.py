"""Open shifts (Teams-style, Visesh Aug 26): unassigned shift slots a manager
places in the "Open shifts" row and later assigns to people.

    python -m unittest test_open_shifts
"""
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
from sqlalchemy import text as _text
with database.engine.connect() as _c:
    try:
        _c.execute(_text("ALTER TABLE scheduled_shifts ADD COLUMN open_slots INTEGER DEFAULT 0")); _c.commit()
    except Exception:
        pass

ADMIN = "openshift.admin@greensglobal.com"
A = "openshift.a@greensglobal.com"
SHIFT = "shift-openshift"
GRANT = "grant-openshift"


class OpenShiftTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, A):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1], last_name="X",
                                            work_email=em, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GRANT, name="grant", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GRANT, email=ADMIN))
            db.add(models.Shift(id=SHIFT, code="GST", name="Store", start_hhmm="09:00", end_hhmm="17:00", color="#3b82f6"))
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
               .filter(models.NexusEmployee.work_email.like("openshift.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GRANT).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GRANT).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == SHIFT).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(models.ScheduledShift.work_date == "2026-09-01").delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _schedule(self):
        return self.client.get("/timeclock/schedule?start=2026-09-01&end=2026-09-01").json()

    def test_open_shift_create_appears_assign_decrements(self):
        # Create an open shift for 2 people.
        r = self.client.post("/timeclock/schedule", json={
            "employee_email": "", "work_date": "2026-09-01", "shift_id": SHIFT, "open_slots": 2})
        self.assertEqual(r.status_code, 200, r.text)
        oid = r.json()["id"]
        self.assertEqual(r.json()["email"], "")
        self.assertEqual(r.json()["openSlots"], 2)

        # It shows in the schedule as an unassigned (email '') row.
        sched = self._schedule()["scheduled"]
        opens = [s for s in sched if not s["email"]]
        self.assertEqual(len(opens), 1)
        self.assertEqual(opens[0]["openSlots"], 2)

        # Assign one to A -> A gets an assigned shift, open count drops to 1.
        r = self.client.post(f"/timeclock/schedule/{oid}/assign", json={"employee_email": A})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["email"], A)
        sched = self._schedule()["scheduled"]
        self.assertEqual([s for s in sched if s["email"] == A][0]["start"], "09:00")
        self.assertEqual([s for s in sched if not s["email"]][0]["openSlots"], 1)

        # Assign the last slot -> the open row is gone; A now has two shifts.
        r = self.client.post(f"/timeclock/schedule/{oid}/assign", json={"employee_email": A})
        self.assertEqual(r.status_code, 200, r.text)
        sched = self._schedule()["scheduled"]
        self.assertEqual(len([s for s in sched if not s["email"]]), 0)
        self.assertEqual(len([s for s in sched if s["email"] == A]), 2)

    def test_cannot_assign_an_already_assigned_shift(self):
        r = self.client.post("/timeclock/schedule", json={
            "employee_email": A, "work_date": "2026-09-01", "shift_id": SHIFT})
        aid = r.json()["id"]
        r = self.client.post(f"/timeclock/schedule/{aid}/assign", json={"employee_email": ADMIN})
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
