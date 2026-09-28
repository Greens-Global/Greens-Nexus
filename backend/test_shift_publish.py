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
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("pub.%")).delete(synchronize_session=False)
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

    # ── Unshared changes to a PUBLISHED shift (QA D1/D2, Sep 28) ──────────
    # Editing or removing a shift staff can already see used to make it vanish
    # from their schedule at once. Now the published version stays live and
    # the change waits for Publish, like Teams' "unshared changes".

    def _published_shift(self, **extra):
        self._as(ADMIN)
        sid = self.client.post("/timeclock/schedule", json={
            "employee_email": A, "work_date": DATE, "shift_id": SHIFT, **extra}).json()["id"]
        self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE})
        return sid

    def _mine(self, as_email):
        self._as(as_email)
        return [x for x in self._sched()["scheduled"] if x["email"] == A]

    def _edit(self, sid, **fields):
        self._as(ADMIN)
        return self.client.patch(f"/timeclock/schedule/{sid}", json={
            "employee_email": A, "work_date": DATE, "shift_id": SHIFT, **fields})

    def test_editing_a_published_shift_keeps_it_visible_until_published(self):
        sid = self._published_shift()
        r = self._edit(sid, start_hhmm="10:00", end_hhmm="18:00", label="Front desk")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["published"])
        self.assertTrue(r.json()["hasChanges"])

        # Staff still see the shift, with the times they were given.
        got = self._mine(VIEWER)
        self.assertEqual([(x["start"], x["end"], x["label"]) for x in got], [("09:00", "17:00", "")])

        # The scheduler sees the change, marked as not yet shared.
        got = self._mine(ADMIN)
        self.assertEqual([(x["start"], x["label"], x["hasChanges"]) for x in got], [("10:00", "Front desk", True)])

        # Publishing applies it.
        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE}).json()
        self.assertEqual((r["published"], r["updated"]), (1, 1))
        got = self._mine(VIEWER)
        self.assertEqual([(x["start"], x["end"], x["label"]) for x in got], [("10:00", "18:00", "Front desk")])

    def test_the_employee_keeps_seeing_their_published_shift_during_an_edit(self):
        sid = self._published_shift()
        self._edit(sid, start_hhmm="11:00")
        self._as(A)
        mine = self.client.get(f"/timeclock/my-schedule?start={DATE}&end={DATE}").json()["scheduled"]
        self.assertEqual([x["start"] for x in mine], ["09:00"])

    def test_removing_a_published_shift_waits_for_publish(self):
        sid = self._published_shift()
        self._as(ADMIN)
        r = self.client.delete(f"/timeclock/schedule/{sid}")
        self.assertEqual(r.json(), {"ok": True, "pending": True})

        self.assertEqual(len(self._mine(VIEWER)), 1)          # still on their schedule
        got = self._mine(ADMIN)
        self.assertTrue(got[0]["pendingDelete"])
        self.assertFalse(got[0]["published"])

        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE}).json()
        self.assertEqual((r["published"], r["removed"]), (1, 1))
        self.assertEqual(self._mine(VIEWER), [])
        self.assertEqual(self._mine(ADMIN), [])

    def test_discard_drops_an_unshared_edit_and_removal(self):
        sid = self._published_shift()
        self._edit(sid, label="Changed")
        self._as(ADMIN)
        self.client.delete(f"/timeclock/schedule/{sid}")
        r = self.client.post(f"/timeclock/schedule/{sid}/discard")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["published"])
        self.assertEqual((r.json()["label"], r.json()["pendingDelete"]), ("", False))
        nothing = self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE}).json()
        self.assertEqual(nothing["published"], 0)

    def test_editing_a_shift_marked_for_removal_keeps_it(self):
        sid = self._published_shift()
        self._as(ADMIN)
        self.client.delete(f"/timeclock/schedule/{sid}")
        r = self._edit(sid, label="Keep, but moved")
        self.assertFalse(r.json()["pendingDelete"])
        self.assertTrue(r.json()["hasChanges"])

    def test_an_edit_back_to_the_published_values_leaves_nothing_to_publish(self):
        sid = self._published_shift()
        self._edit(sid, label="Temp")
        r = self._edit(sid, start_hhmm="09:00", end_hhmm="17:00", label="")
        self.assertTrue(r.json()["published"])
        self.assertFalse(r.json()["hasChanges"])

    def test_fill_schedule_overwrite_replaces_a_published_shift_only_on_publish(self):
        self._published_shift()
        self._as(ADMIN)
        r = self.client.post("/timeclock/schedule/bulk", json={
            "emails": [A], "start_date": DATE, "end_date": DATE, "start_hhmm": "12:00", "end_hhmm": "20:00",
            "overwrite": True})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["replaced"], 1)
        # Staff still have the old shift until the replacement is published.
        self.assertEqual([x["start"] for x in self._mine(VIEWER)], ["09:00"])
        self._as(ADMIN)
        self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE})
        self.assertEqual([x["start"] for x in self._mine(VIEWER)], ["12:00"])

    def test_a_draft_is_still_edited_and_removed_in_place(self):
        self._as(ADMIN)
        sid = self.client.post("/timeclock/schedule", json={
            "employee_email": A, "work_date": DATE, "shift_id": SHIFT}).json()["id"]
        r = self._edit(sid, label="Draft edit")
        self.assertEqual((r.json()["label"], r.json()["hasChanges"]), ("Draft edit", False))
        self._as(ADMIN)
        self.assertEqual(self.client.delete(f"/timeclock/schedule/{sid}").json(), {"ok": True, "pending": False})
        self.assertEqual(self._mine(ADMIN), [])
        self.assertEqual(self.client.post(f"/timeclock/schedule/{sid}/discard").status_code, 404)

    def test_publishing_notifies_the_employee_not_the_publisher(self):
        self._published_shift()
        db = database.SessionLocal()
        try:
            bells = {n.recipient: n for n in db.query(models.NexusNotification)
                     .filter(models.NexusNotification.recipient.like("pub.%")).all()}
        finally:
            db.close()
        self.assertEqual(set(bells), {A})
        self.assertEqual(bells[A].title, "Your schedule was updated")

    def _bells(self):
        db = database.SessionLocal()
        try:
            return {(n.recipient, n.title) for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.recipient.like("pub.%")).all()}
        finally:
            db.close()

    def test_notify_the_whole_team_on_publish(self):
        self._published_shift()                      # A already has a published shift this day
        db = database.SessionLocal()
        try:
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("pub.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        self._as(ADMIN)
        self.client.post("/timeclock/schedule", json={"employee_email": VIEWER, "work_date": DATE, "shift_id": SHIFT})
        r = self.client.post("/timeclock/schedule/publish",
                             json={"start_date": DATE, "end_date": DATE, "notify": "team"}).json()
        self.assertEqual(r["notified"], 2)
        # The person whose shift changed gets the detailed note; A (unchanged
        # but on the schedule) gets the short one; the publisher gets nothing.
        self.assertEqual(self._bells(), {(VIEWER, "Your schedule was updated"), (A, "Schedule published")})

    def test_the_default_still_tells_only_changed_people(self):
        self._published_shift()
        db = database.SessionLocal()
        try:
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("pub.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()
        self._as(ADMIN)
        self.client.post("/timeclock/schedule", json={"employee_email": VIEWER, "work_date": DATE, "shift_id": SHIFT})
        self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE})
        self.assertEqual(self._bells(), {(VIEWER, "Your schedule was updated")})

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
