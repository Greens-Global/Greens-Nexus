"""Publish / draft workflow for the shift schedule (Teams-Shifts parity, from the
Valinda/Neil call): new and edited shifts are DRAFTS that only schedulers see;
the manager "Publish" action shares them so read-only staff can see them.

    python -m unittest test_shift_publish
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
    for _sql in ("ALTER TABLE scheduled_shifts ADD COLUMN open_slots INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN published INTEGER DEFAULT 1"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

ADMIN = "pub.admin@greensglobal.com"      # hr:editor -> scheduler (sees drafts, can publish)
VIEWER = "pub.viewer@greensglobal.com"    # hr:viewer -> read-only (published shifts only)
A = "pub.a@greensglobal.com"              # a plain employee to schedule
DATE = "2026-09-14"
SHIFT = "shift-pub"
G_ED = "grant-pub-ed"
G_VW = "grant-pub-vw"


class ShiftPublishTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, VIEWER, A):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1], last_name="X",
                                            work_email=em, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=G_ED, name="ed", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=G_ED, email=ADMIN))
            db.add(models.NexusGroup(id=G_VW, name="vw", allowed_modules="hr:viewer"))
            db.add(models.NexusGroupMember(group_id=G_VW, email=VIEWER))
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
               .filter(models.NexusEmployee.work_email.like("pub.%")).delete(synchronize_session=False))
            for gid in (G_ED, G_VW):
                db.query(models.NexusGroup).filter(models.NexusGroup.id == gid).delete(synchronize_session=False)
                db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == gid).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == SHIFT).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(models.ScheduledShift.work_date == DATE).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _sched(self):
        return self.client.get(f"/timeclock/schedule?start={DATE}&end={DATE}").json()

    def test_new_shift_is_draft_hidden_from_staff_until_published(self):
        # Manager creates a shift -> it comes back as a DRAFT (published False).
        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule", json={
            "employee_email": A, "work_date": DATE, "shift_id": SHIFT})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["published"])

        # The scheduler sees it and is flagged as a manager.
        s = self._sched()
        self.assertTrue(s["canManage"])
        self.assertEqual(len([x for x in s["scheduled"] if x["email"] == A]), 1)

        # A read-only viewer does NOT see the draft and is not a manager.
        self._as(VIEWER)
        s = self._sched()
        self.assertFalse(s["canManage"])
        self.assertEqual(len([x for x in s["scheduled"] if x["email"] == A]), 0)

        # Manager publishes the week.
        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["published"], 1)

        # Now the viewer sees it.
        self._as(VIEWER)
        s = self._sched()
        got = [x for x in s["scheduled"] if x["email"] == A]
        self.assertEqual(len(got), 1)
        self.assertTrue(got[0]["published"])

    def test_editing_a_published_shift_reverts_it_to_draft(self):
        self._as(ADMIN)
        sid = self.client.post("/timeclock/schedule", json={
            "employee_email": A, "work_date": DATE, "shift_id": SHIFT}).json()["id"]
        self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE})

        # Viewer can see the published shift.
        self._as(VIEWER)
        self.assertEqual(len([x for x in self._sched()["scheduled"] if x["email"] == A]), 1)

        # Manager edits it (changes the label) -> becomes an unpublished change.
        self._as(ADMIN)
        r = self.client.patch(f"/timeclock/schedule/{sid}", json={
            "employee_email": A, "work_date": DATE, "shift_id": SHIFT, "label": "Front desk"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["published"])

        # Viewer no longer sees it until it's re-published.
        self._as(VIEWER)
        self.assertEqual(len([x for x in self._sched()["scheduled"] if x["email"] == A]), 0)

    def test_publish_is_idempotent(self):
        self._as(ADMIN)
        self.client.post("/timeclock/schedule", json={"employee_email": A, "work_date": DATE, "shift_id": SHIFT})
        first = self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE}).json()
        self.assertEqual(first["published"], 1)
        # Nothing left to publish -> 0.
        second = self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE}).json()
        self.assertEqual(second["published"], 0)


if __name__ == "__main__":
    unittest.main()
