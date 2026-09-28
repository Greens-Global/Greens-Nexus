"""Copy schedule and Clear schedule (Sep 28 2026, Shifts QA gap list item 4).

    python -m unittest test_shift_copy_clear
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
                 "ALTER TABLE scheduled_shifts ADD COLUMN break_min INTEGER DEFAULT 0"):
        try:
            _c.execute(_text(_sql)); _c.commit()
        except Exception:
            pass

ADMIN = "copy.admin@greensglobal.com"
A = "copy.a@greensglobal.com"
B = "copy.b@greensglobal.com"
VIEWER = "copy.viewer@greensglobal.com"
SHIFT = "shift-copy"
G_ED, G_VW, GROUP = "grant-copy-ed", "grant-copy-vw", "group-copy"
MON, WED, SUN = "2026-11-02", "2026-11-04", "2026-11-08"      # source week
NEXT_MON, NEXT_WED = "2026-11-09", "2026-11-11"


class CopyClearTests(unittest.TestCase):
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
            db.add(models.ShiftGroup(id=GROUP, name="Store A"))
            db.add(models.ShiftGroupMember(id="sgm-copy", group_id=GROUP, employee_email=A))
            db.add(models.Shift(id=SHIFT, code="GST", name="Store", start_hhmm="09:00", end_hhmm="17:00",
                                color="#3b82f6", break_min=30))
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
               .filter(models.NexusEmployee.work_email.like("copy.%")).delete(synchronize_session=False))
            for gid in (G_ED, G_VW):
                db.query(models.NexusGroup).filter(models.NexusGroup.id == gid).delete(synchronize_session=False)
                db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == gid).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.Shift).filter(models.Shift.id == SHIFT).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("copy.%")) |
                (models.ScheduledShift.created_by == ADMIN)).delete(synchronize_session=False)
            db.query(models.TimeOffRequest).filter(models.TimeOffRequest.employee_email.like("copy.%")).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("copy.%")).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _place(self, email, day, **kw):
        r = self.client.post("/timeclock/schedule", json={"employee_email": email, "work_date": day,
                                                          "shift_id": SHIFT, **kw})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["id"]

    def _publish(self, d0, d1):
        self.client.post("/timeclock/schedule/publish", json={"start_date": d0, "end_date": d1})

    def _copy(self, **kw):
        body = {"source_start": MON, "source_end": SUN, "target_start": NEXT_MON, **kw}
        return self.client.post("/timeclock/schedule/copy", json=body)

    def _rows(self, **filters):
        db = database.SessionLocal()
        try:
            q = db.query(models.ScheduledShift)
            for k, v in filters.items():
                q = q.filter(getattr(models.ScheduledShift, k) == v)
            return q.order_by(models.ScheduledShift.work_date).all()
        finally:
            db.close()

    # ── Copy ──────────────────────────────────────────────────────────────

    def test_copies_the_week_as_drafts_with_times_label_break_and_note(self):
        self._place(A, MON, label="Front desk", note="Bring keys")
        self._place(A, WED, start_hhmm="12:00", end_hhmm="20:00")
        r = self._copy()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["created"], 2)
        got = self._rows(employee_email=A, work_date=NEXT_MON) + self._rows(employee_email=A, work_date=NEXT_WED)
        self.assertEqual([(g.start_hhmm, g.end_hhmm, g.label, g.note, g.break_min, g.published) for g in got],
                         [("09:00", "17:00", "Front desk", "Bring keys", 30, 0), ("12:00", "20:00", "", "", 30, 0)])

    def test_repeats_back_to_back_and_can_leave_notes_out(self):
        self._place(A, MON, note="Bring keys")
        r = self._copy(weeks=3, include_notes=False)
        self.assertEqual((r.json()["created"], r.json()["targetEnd"]), (3, "2026-11-29"))
        copies = [x for x in self._rows(employee_email=A) if x.work_date > SUN]
        self.assertEqual([x.work_date for x in copies], ["2026-11-09", "2026-11-16", "2026-11-23"])
        self.assertEqual({x.note for x in copies}, {""})

    def test_skips_time_off_and_keeps_existing_shifts_unless_replacing(self):
        self._place(A, MON)
        self._place(B, MON)
        self._place(B, NEXT_MON, start_hhmm="06:00", end_hhmm="10:00")
        self._publish(NEXT_MON, NEXT_MON)
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id="to-copy", employee_email=A, start_date=NEXT_MON, end_date=NEXT_MON,
                                         status="approved", type="vacation"))
            db.commit()
        finally:
            db.close()
        r = self._copy().json()
        self.assertEqual((r["created"], r["timeoffSkipped"], r["skipped"]), (0, 1, 1))
        r = self._copy(overwrite=True).json()
        self.assertEqual((r["created"], r["replaced"]), (1, 1))
        b = {x.start_hhmm: x for x in self._rows(employee_email=B, work_date=NEXT_MON)}
        self.assertEqual(b["06:00"].pending_delete, 1)     # published: staff keep it until the copy is published
        self.assertEqual(b["09:00"].published, 0)

    def test_open_shifts_copy_when_included_and_are_never_doubled(self):
        self._place("", MON, open_slots=2)
        self.assertEqual(self._copy(include_open=False).json()["created"], 0)
        self.assertEqual(self._copy().json()["created"], 1)
        self.assertEqual(self._copy().json()["skipped"], 1)
        opened = self._rows(employee_email="", work_date=NEXT_MON)
        self.assertEqual([o.open_slots for o in opened], [2])

    def test_a_group_copy_takes_only_its_members(self):
        self._place(A, MON)
        self._place(B, MON)
        self._place("", MON)
        self.assertEqual(self._copy(group_id=GROUP).json()["created"], 1)
        self.assertEqual(len(self._rows(employee_email=A, work_date=NEXT_MON)), 1)
        self.assertEqual(self._rows(employee_email=B, work_date=NEXT_MON), [])

    def test_copies_what_the_scheduler_sees(self):
        keep = self._place(A, MON)
        gone = self._place(A, WED)
        self._publish(MON, SUN)
        self.client.patch(f"/timeclock/schedule/{keep}", json={"employee_email": A, "work_date": MON,
                                                               "shift_id": SHIFT, "start_hhmm": "10:00"})
        self.client.delete(f"/timeclock/schedule/{gone}")
        self.assertEqual(self._copy().json()["created"], 1)
        self.assertEqual([x.start_hhmm for x in self._rows(employee_email=A, work_date=NEXT_MON)], ["10:00"])
        self.assertEqual(self._rows(employee_email=A, work_date=NEXT_WED), [])

    def test_refuses_to_copy_onto_its_own_dates(self):
        r = self._copy(target_start=WED)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self._copy(weeks=9).status_code, 400)
        self.assertEqual(self._copy(source_end="2026-12-15").status_code, 400)

    def test_staff_cannot_copy(self):
        self._as(VIEWER)
        # require_team_write answers "Insufficient permissions" with a 401 app-wide.
        self.assertIn(self._copy().status_code, (401, 403))
        self.assertIn(self.client.post("/timeclock/schedule/clear", json={"start_date": MON, "end_date": SUN}).status_code,
                      (401, 403))

    # ── Clear ─────────────────────────────────────────────────────────────

    def test_clear_deletes_drafts_and_marks_published_shifts(self):
        self._place(A, MON)
        self._publish(MON, MON)
        self._place(A, WED)                 # a draft
        self._place("", WED)                # an open draft
        r = self.client.post("/timeclock/schedule/clear", json={"start_date": MON, "end_date": SUN,
                                                                "include_open": False})
        self.assertEqual(r.json(), {"removed": 1, "pending": 1})
        self.assertEqual(self._rows(employee_email=A, work_date=MON)[0].pending_delete, 1)
        self.assertEqual(self._rows(employee_email=A, work_date=WED), [])
        self.assertEqual(len(self._rows(employee_email="", work_date=WED)), 1)   # open shifts left out
        # Staff still see the published one until the removal is published.
        self._as(VIEWER)
        grid = self.client.get(f"/timeclock/schedule?start={MON}&end={SUN}").json()["scheduled"]
        self.assertEqual([s["date"] for s in grid if s["email"] == A], [MON])

    def test_clear_limits_its_range(self):
        r = self.client.post("/timeclock/schedule/clear", json={"start_date": "2026-01-01", "end_date": "2026-12-31"})
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main()
