"""Schedule conflict warnings and unpaid breaks (Sep 28 2026, Shifts QA gap
list item 3).

  - A shift is flagged - never blocked - when it overlaps another of the
    person's shifts (overnight shifts included), lands on approved or pending
    time off (a partial day only when the hours overlap), or on a company
    holiday. The grid carries the warnings; GET /schedule/check gives the
    Add/Edit Shift dialog the same warnings live.
  - A shift preset's unpaid break is copied onto each placement, can be
    changed per shift, and on a PUBLISHED shift waits for Publish like any
    other edit.

    python -m unittest test_shift_conflicts
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
from routers.timeclock import _shift_conflicts

models.Base.metadata.create_all(bind=database.engine)
from sqlalchemy import text as _text  # noqa: E402
with database.engine.connect() as _c:
    # A local sqlite file older than these columns (CI builds a fresh one).
    for _sql in ("ALTER TABLE scheduled_shifts ADD COLUMN open_slots INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN published INTEGER DEFAULT 1",
                 "ALTER TABLE scheduled_shifts ADD COLUMN pending_json TEXT DEFAULT ''",
                 "ALTER TABLE scheduled_shifts ADD COLUMN pending_delete INTEGER DEFAULT 0",
                 "ALTER TABLE shifts ADD COLUMN break_min INTEGER DEFAULT 0",
                 "ALTER TABLE scheduled_shifts ADD COLUMN break_min INTEGER DEFAULT 0"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass


def _s(date, start, end, id_="x", **kw):
    return {"id": id_, "date": date, "start": start, "end": end, **kw}


class ConflictRuleTests(unittest.TestCase):
    """_shift_conflicts on its own - no database."""

    def test_overlapping_shifts_same_day(self):
        w = _shift_conflicts(_s("2026-09-28", "09:00", "17:00"), [_s("2026-09-28", "16:00", "20:00", "o")], [], {})
        self.assertEqual(w, ["Overlaps another shift (4:00 PM - 8:00 PM on 09/28/2026)."])

    def test_back_to_back_shifts_do_not_overlap(self):
        self.assertEqual(_shift_conflicts(_s("2026-09-28", "09:00", "13:00"),
                                          [_s("2026-09-28", "13:00", "17:00", "o")], [], {}), [])

    def test_an_overnight_shift_overlaps_the_next_morning(self):
        w = _shift_conflicts(_s("2026-09-29", "06:00", "14:00"), [_s("2026-09-28", "22:00", "07:00", "o")], [], {})
        self.assertEqual(len(w), 1)

    def test_itself_and_shifts_being_removed_do_not_count(self):
        self.assertEqual(_shift_conflicts(_s("2026-09-28", "09:00", "17:00", "me"),
                                          [_s("2026-09-28", "09:00", "17:00", "me"),
                                           _s("2026-09-28", "10:00", "12:00", "gone", pendingDelete=True)], [], {}), [])

    def test_time_off_full_day_approved_and_pending(self):
        me = _s("2026-09-28", "09:00", "17:00")
        off = [{"startDate": "2026-09-27", "endDate": "2026-09-29", "status": "approved", "type": "vacation"}]
        self.assertEqual(_shift_conflicts(me, [], off, {}), ["On approved time off that day (vacation)."])
        off[0]["status"] = "pending"
        self.assertEqual(_shift_conflicts(me, [], off, {}), ["Time off requested that day (vacation)."])

    def test_partial_day_time_off_only_when_the_hours_overlap(self):
        me = _s("2026-09-28", "09:00", "13:00")
        off = [{"startDate": "2026-09-28", "endDate": "2026-09-28", "status": "approved", "type": "personal",
                "startTime": "14:00", "endTime": "16:00"}]
        self.assertEqual(_shift_conflicts(me, [], off, {}), [])
        off[0]["startTime"] = "12:00"
        self.assertEqual(_shift_conflicts(me, [], off, {}),
                         ["Overlaps approved time off (personal, 12:00 PM - 4:00 PM)."])

    def test_company_holiday(self):
        w = _shift_conflicts(_s("2026-09-28", "09:00", "17:00"), [], [],
                             {"2026-09-28": {"name": "Founders Day", "type": "mandatory"}})
        self.assertEqual(w, ["Company holiday: Founders Day."])


ADMIN = "conf.admin@greensglobal.com"
A = "conf.a@greensglobal.com"
DATE = "2026-09-15"
SHIFT = "shift-conf"
G_ED = "grant-conf-ed"


class ConflictAndBreakApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, A):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1], last_name="X",
                                            work_email=em, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=G_ED, name="ed", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=G_ED, email=ADMIN))
            db.add(models.Shift(id=SHIFT, code="GST", name="Store", start_hhmm="09:00", end_hhmm="17:00",
                                color="#3b82f6", break_min=30))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN

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
               .filter(models.NexusEmployee.work_email.like("conf.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == G_ED).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == G_ED).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == SHIFT).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(models.ScheduledShift.employee_email.like("conf.%")).delete(synchronize_session=False)
            db.query(models.TimeOffRequest).filter(models.TimeOffRequest.employee_email.like("conf.%")).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("conf.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _place(self, **kw):
        body = {"employee_email": A, "work_date": DATE, "shift_id": SHIFT, **kw}
        r = self.client.post("/timeclock/schedule", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def _grid(self):
        return [s for s in self.client.get(f"/timeclock/schedule?start={DATE}&end={DATE}").json()["scheduled"]
                if s["email"] == A]

    def test_a_placement_takes_the_presets_break_and_can_change_it(self):
        self.assertEqual(self._place()["breakMin"], 30)
        self.assertEqual(self._place(break_min=45)["breakMin"], 45)
        self.assertEqual(self._place(break_min=9999)["breakMin"], 480)   # clamped

    def test_a_break_change_on_a_published_shift_waits_for_publish(self):
        sid = self._place()["id"]
        self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE})
        r = self.client.patch(f"/timeclock/schedule/{sid}", json={
            "employee_email": A, "work_date": DATE, "shift_id": SHIFT, "break_min": 60})
        self.assertTrue(r.json()["hasChanges"])
        self.assertEqual(r.json()["breakMin"], 60)
        self.client.post("/timeclock/schedule/publish", json={"start_date": DATE, "end_date": DATE})
        db = database.SessionLocal()
        try:
            self.assertEqual(db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first().break_min, 60)
        finally:
            db.close()

    def test_the_grid_flags_overlapping_shifts_and_time_off(self):
        self._place()
        self._place(start_hhmm="16:00", end_hhmm="20:00")
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id="to-conf", employee_email=A, start_date=DATE, end_date=DATE,
                                         status="approved", type="sick"))
            db.commit()
        finally:
            db.close()
        grid = self._grid()
        self.assertEqual(len(grid), 2)
        for s in grid:
            self.assertTrue(any(w.startswith("Overlaps another shift") for w in s["conflicts"]), s)
            self.assertIn("On approved time off that day (sick).", s["conflicts"])

    def test_check_warns_live_and_leaves_out_the_shift_being_edited(self):
        sid = self._place()["id"]
        q = f"/timeclock/schedule/check?email={A}&date={DATE}&start=12:00&end=18:00"
        self.assertEqual(len(self.client.get(q).json()["warnings"]), 1)
        self.assertEqual(self.client.get(q + f"&exclude_id={sid}").json()["warnings"], [])

    def test_saving_is_never_blocked_by_a_warning(self):
        self._place()
        self.assertEqual(self._place()["email"], A)   # a second, overlapping shift still saves


if __name__ == "__main__":
    unittest.main()
