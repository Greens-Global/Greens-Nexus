"""Shift activities, drag-and-drop move/copy and day notes (Sep 29 2026,
Shifts QA gap list item 6).

    python -m unittest test_shift_views
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

ADMIN = "view.admin@greensglobal.com"
A = "view.a@greensglobal.com"
B = "view.b@greensglobal.com"
VIEWER = "view.viewer@greensglobal.com"
G_ED, G_VW, GROUP = "grant-view-ed", "grant-view-vw", "group-view"
MON, TUE = "2026-11-16", "2026-11-17"
ACTS = [{"start": "12:00", "end": "13:00", "label": "Training"}]


class ShiftViewTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, A, B, VIEWER):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1], last_name="X",
                                            work_email=em, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=G_ED, name="ed", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=G_ED, email=ADMIN))
            db.add(models.NexusGroup(id=G_VW, name="vw", allowed_modules="hr:viewer"))
            db.add(models.NexusGroupMember(group_id=G_VW, email=VIEWER))
            db.add(models.ShiftGroup(id=GROUP, name="Store"))
            db.add(models.ShiftGroupMember(id="sgm-view-a", group_id=GROUP, employee_email=A))
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
               .filter(models.NexusEmployee.work_email.like("view.%")).delete(synchronize_session=False))
            for gid in (G_ED, G_VW):
                db.query(models.NexusGroup).filter(models.NexusGroup.id == gid).delete(synchronize_session=False)
                db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == gid).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("view.%")) |
                (models.ScheduledShift.created_by == ADMIN)).delete(synchronize_session=False)
            db.query(models.ScheduleDayNote).filter(models.ScheduleDayNote.work_date.in_([MON, TUE])).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("view.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _place(self, email=A, day=MON, **kw):
        r = self.client.post("/timeclock/schedule", json={"employee_email": email, "work_date": day,
                                                          "start_hhmm": "09:00", "end_hhmm": "17:00", **kw})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _publish(self):
        self.client.post("/timeclock/schedule/publish", json={"start_date": MON, "end_date": TUE})

    def _grid(self, email=A):
        return [s for s in self.client.get(f"/timeclock/schedule?start={MON}&end={TUE}").json()["scheduled"]
                if s["email"] == email]

    # ── Activities ────────────────────────────────────────────────────────

    def test_activities_are_saved_sorted_and_checked(self):
        s = self._place(activities=[{"start": "15:00", "end": "15:15", "label": "Break"}] + ACTS)
        self.assertEqual([a["label"] for a in s["activities"]], ["Training", "Break"])
        bad = self.client.post("/timeclock/schedule", json={"employee_email": A, "work_date": MON,
                                                             "activities": [{"start": "noon", "end": "13:00"}]})
        self.assertEqual(bad.status_code, 400)

    def test_an_activity_change_on_a_published_shift_waits_for_publish(self):
        sid = self._place()["id"]
        self._publish()
        r = self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": A, "work_date": MON,
                                                                   "start_hhmm": "09:00", "end_hhmm": "17:00",
                                                                   "activities": ACTS})
        self.assertTrue(r.json()["hasChanges"])
        self._as(VIEWER)
        self.assertEqual(self._grid()[0]["activities"], [])       # staff: not yet
        self._as(ADMIN)
        self._publish()
        self._as(VIEWER)
        self.assertEqual(self._grid()[0]["activities"], ACTS)

    def test_copy_carries_activities(self):
        self._place(activities=ACTS)
        self.client.post("/timeclock/schedule/copy", json={"source_start": MON, "source_end": MON, "target_start": TUE})
        tue = [s for s in self._grid() if s["date"] == TUE]
        self.assertEqual(tue[0]["activities"], ACTS)

    # ── Drag and drop ─────────────────────────────────────────────────────

    def test_moving_a_draft_moves_it(self):
        sid = self._place(activities=ACTS, label="Front desk")["id"]
        r = self.client.post(f"/timeclock/schedule/{sid}/move", json={"employee_email": B, "work_date": TUE})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._grid(A), [])
        moved = self._grid(B)
        self.assertEqual([(m["date"], m["label"], m["activities"], m["published"]) for m in moved],
                         [(TUE, "Front desk", ACTS, False)])

    def test_moving_a_published_shift_waits_for_publish(self):
        sid = self._place()["id"]
        self._publish()
        r = self.client.post(f"/timeclock/schedule/{sid}/move", json={"employee_email": A, "work_date": TUE}).json()
        self.assertTrue(r["sourcePending"])
        self._as(VIEWER)
        self.assertEqual([s["date"] for s in self._grid()], [MON])      # staff keep Monday for now
        self._as(ADMIN)
        self._publish()
        self._as(VIEWER)
        self.assertEqual([s["date"] for s in self._grid()], [TUE])

    def test_copy_leaves_the_original(self):
        sid = self._place()["id"]
        self.client.post(f"/timeclock/schedule/{sid}/move", json={"employee_email": B, "work_date": MON, "duplicate": True})
        self.assertEqual(len(self._grid(A)), 1)
        self.assertEqual(len(self._grid(B)), 1)

    def test_open_shifts_stay_open_and_removals_cannot_move(self):
        open_id = self._place(email="", open_slots=2)["id"]
        self.assertEqual(self.client.post(f"/timeclock/schedule/{open_id}/move",
                                          json={"employee_email": A, "work_date": MON}).status_code, 400)
        moved = self.client.post(f"/timeclock/schedule/{open_id}/move", json={"employee_email": "", "work_date": TUE}).json()
        self.assertEqual((moved["shift"]["date"], moved["shift"]["openSlots"]), (TUE, 2))
        sid = self._place()["id"]
        self._publish()
        self.client.delete(f"/timeclock/schedule/{sid}")
        self.assertEqual(self.client.post(f"/timeclock/schedule/{sid}/move",
                                          json={"employee_email": A, "work_date": TUE}).status_code, 400)

    def test_staff_cannot_move(self):
        sid = self._place()["id"]
        self._as(VIEWER)
        self.assertIn(self.client.post(f"/timeclock/schedule/{sid}/move",
                                       json={"employee_email": A, "work_date": TUE}).status_code, (401, 403))

    # ── Per-shift color ───────────────────────────────────────────────────

    def test_a_shift_can_have_its_own_color(self):
        s = self._place(color="#DC2626")
        self.assertEqual((s["color"], s["ownColor"]), ("#dc2626", "#dc2626"))
        plain = self._place(day=TUE)
        self.assertEqual(plain["ownColor"], "")
        bad = self.client.post("/timeclock/schedule", json={"employee_email": A, "work_date": MON, "color": "red"})
        self.assertEqual(bad.status_code, 400)

    def test_a_color_change_on_a_published_shift_waits_for_publish(self):
        sid = self._place()["id"]
        self._publish()
        self.client.patch(f"/timeclock/schedule/{sid}", json={"employee_email": A, "work_date": MON,
                                                              "start_hhmm": "09:00", "end_hhmm": "17:00", "color": "#16a34a"})
        self._as(VIEWER)
        self.assertEqual(self._grid()[0]["ownColor"], "")
        self._as(ADMIN)
        self._publish()
        self._as(VIEWER)
        self.assertEqual(self._grid()[0]["color"], "#16a34a")

    def test_copy_and_move_keep_the_color(self):
        sid = self._place(color="#8b5cf6")["id"]
        self.client.post("/timeclock/schedule/copy", json={"source_start": MON, "source_end": MON, "target_start": TUE})
        self.client.post(f"/timeclock/schedule/{sid}/move", json={"employee_email": B, "work_date": MON})
        self.assertEqual({s["ownColor"] for s in self._grid(A) + self._grid(B)}, {"#8b5cf6"})

    # ── Discard all ───────────────────────────────────────────────────────

    def test_discard_all_reverts_edits_and_removals_but_keeps_drafts(self):
        edited, removed = self._place()["id"], self._place(email=B)["id"]
        self._publish()
        self.client.patch(f"/timeclock/schedule/{edited}", json={"employee_email": A, "work_date": MON,
                                                                 "start_hhmm": "10:00", "end_hhmm": "18:00"})
        self.client.delete(f"/timeclock/schedule/{removed}")
        draft = self._place(day=TUE)["id"]
        r = self.client.post("/timeclock/schedule/discard-all", json={"start_date": MON, "end_date": TUE})
        self.assertEqual(r.json(), {"discarded": 2})
        grid = {s["id"]: s for s in self._grid(A) + self._grid(B)}
        self.assertEqual((grid[edited]["start"], grid[edited]["hasChanges"]), ("09:00", False))
        self.assertFalse(grid[removed]["pendingDelete"])
        self.assertIn(draft, grid)                                   # new drafts are left alone
        self._as(VIEWER)
        self.assertIn(self.client.post("/timeclock/schedule/discard-all",
                                       json={"start_date": MON, "end_date": TUE}).status_code, (401, 403))

    # ── Day notes ─────────────────────────────────────────────────────────

    def test_day_notes_show_on_the_grid_and_in_my_shifts(self):
        r = self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "Inventory day"})
        self.assertEqual(r.json()["note"], "Inventory day")
        self.client.put("/timeclock/schedule/day-note", json={"work_date": TUE, "note": "Store A only", "group_id": GROUP})
        grid = self.client.get(f"/timeclock/schedule?start={MON}&end={TUE}").json()["dayNotes"]
        self.assertEqual(sorted(n["note"] for n in grid), ["Inventory day", "Store A only"])
        self._as(A)                                   # in the group: sees both
        mine = self.client.get(f"/timeclock/my-schedule?start={MON}&end={TUE}").json()["dayNotes"]
        self.assertEqual([n["note"] for n in mine], ["Inventory day", "Store A only"])
        self._as(B)                                   # not in the group: only the team-wide one
        mine = self.client.get(f"/timeclock/my-schedule?start={MON}&end={TUE}").json()["dayNotes"]
        self.assertEqual([n["note"] for n in mine], ["Inventory day"])

    def test_an_empty_note_removes_it_and_staff_cannot_write(self):
        self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "Temp"})
        self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "  "})
        self.assertEqual(self.client.get(f"/timeclock/schedule?start={MON}&end={MON}").json()["dayNotes"], [])
        self._as(VIEWER)
        self.assertIn(self.client.put("/timeclock/schedule/day-note", json={"work_date": MON, "note": "x"}).status_code,
                      (401, 403))


if __name__ == "__main__":
    unittest.main()
