"""Shift self-service requests (Sep 29 2026, Shifts QA gap list item 5):
open-shift requests, swaps and offers, the manager inbox and its switches.

    python -m unittest test_shift_requests
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

ADMIN = "sreq.admin@greensglobal.com"
A = "sreq.a@greensglobal.com"
B = "sreq.b@greensglobal.com"
C = "sreq.c@greensglobal.com"          # not on A's team
GROUP, GRANT = "group-sreq", "grant-sreq"
_today = datetime.now(timezone.utc).date()
DAY = (_today + timedelta(days=10)).isoformat()
DAY2 = (_today + timedelta(days=11)).isoformat()
PAST = (_today - timedelta(days=2)).isoformat()


class ShiftRequestTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em in (ADMIN, A, B, C):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].upper(), last_name="X",
                                            work_email=em, status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GRANT, name="ed", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GRANT, email=ADMIN))
            db.add(models.ShiftGroup(id=GROUP, name="Store"))
            db.add(models.ShiftGroupMember(id="sgm-sreq-a", group_id=GROUP, employee_email=A))
            db.add(models.ShiftGroupMember(id="sgm-sreq-b", group_id=GROUP, employee_email=B))
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
               .filter(models.NexusEmployee.work_email.like("sreq.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GRANT).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GRANT).delete(synchronize_session=False)
            db.query(models.ShiftGroup).filter(models.ShiftGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.ShiftGroupMember).filter(models.ShiftGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.ScheduledShift).filter(
                (models.ScheduledShift.employee_email.like("sreq.%")) | (models.ScheduledShift.created_by == "sreq-test") |
                (models.ScheduledShift.created_by == ADMIN)).delete(synchronize_session=False)
            db.query(models.ShiftRequest).filter(models.ShiftRequest.requester_email.like("sreq.%")).delete(synchronize_session=False)
            db.query(models.NexusNotification).filter(models.NexusNotification.recipient.like("sreq.%")).delete(synchronize_session=False)
            db.query(models.NexusSetting).filter(models.NexusSetting.key == "shift_requests_config").delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _shift(self, email, day=DAY, published=1, slots=0, start="09:00"):
        db = database.SessionLocal()
        try:
            sid = f"ss-{email or 'open'}-{day}-{start}-{published}"
            db.add(models.ScheduledShift(id=sid, employee_email=email, work_date=day, start_hhmm=start,
                                         end_hhmm="17:00", published=published, open_slots=slots,
                                         created_by="sreq-test", created_at="2026-09-29T00:00:00"))
            db.commit()
            return sid
        finally:
            db.close()

    def _row(self, sid):
        db = database.SessionLocal()
        try:
            return db.query(models.ScheduledShift).filter(models.ScheduledShift.id == sid).first()
        finally:
            db.close()

    def _ask(self, who, **body):
        self._as(who)
        return self.client.post("/timeclock/shift-requests", json=body)

    def _decide(self, rid, approve=True, note=""):
        self._as(ADMIN)
        return self.client.post(f"/timeclock/shift-requests/{rid}/decide", json={"approve": approve, "note": note})

    def _bells(self, email):
        db = database.SessionLocal()
        try:
            return [n.title for n in db.query(models.NexusNotification)
                    .filter(models.NexusNotification.recipient == email).all()]
        finally:
            db.close()

    # ── Open shifts ───────────────────────────────────────────────────────

    def test_requesting_an_open_shift_and_approving_it(self):
        open_id = self._shift("", slots=1)
        mine = self._as(A) or self.client.get(f"/timeclock/shift-requests/mine?start={DAY}&end={DAY}").json()
        self.assertEqual([s["id"] for s in mine["openShifts"]], [open_id])
        r = self._ask(A, kind="open", shift_id=open_id, note="I can cover")
        self.assertEqual((r.status_code, r.json()["status"]), (200, "pending_manager"), r.text)
        # Asking twice is refused.
        self.assertEqual(self._ask(A, kind="open", shift_id=open_id).status_code, 409)
        self._as(ADMIN)
        self.assertEqual([p["id"] for p in self.client.get("/timeclock/shift-requests").json()["pending"]], [r.json()["id"]])
        d = self._decide(r.json()["id"])
        self.assertEqual(d.json()["status"], "approved")
        self.assertIsNone(self._row(open_id))                       # last slot filled
        db = database.SessionLocal()
        try:
            got = db.query(models.ScheduledShift).filter(models.ScheduledShift.employee_email == A).all()
        finally:
            db.close()
        self.assertEqual([(g.work_date, g.published) for g in got], [(DAY, 1)])
        self.assertIn("Shift request approved", self._bells(A))

    def test_a_multi_slot_open_shift_keeps_other_requests(self):
        open_id = self._shift("", slots=2)
        ra = self._ask(A, kind="open", shift_id=open_id).json()
        rb = self._ask(B, kind="open", shift_id=open_id).json()
        self._decide(ra["id"])
        self.assertEqual(self._row(open_id).open_slots, 1)
        self.assertEqual(self._decide(rb["id"]).json()["status"], "approved")   # still possible
        self.assertIsNone(self._row(open_id))

    def test_drafts_past_shifts_and_disabled_kinds_cannot_be_requested(self):
        self.assertEqual(self._ask(A, kind="open", shift_id=self._shift("", slots=1, published=0)).status_code, 409)
        self.assertEqual(self._ask(A, kind="open", shift_id=self._shift("", day=PAST, slots=1)).status_code, 409)
        self._as(ADMIN)
        self.client.put("/timeclock/shift-requests/settings", json={"openShifts": False})
        self.assertEqual(self._ask(A, kind="open", shift_id=self._shift("", slots=1, start="10:00")).status_code, 403)

    # ── Swaps and offers ──────────────────────────────────────────────────

    def test_a_swap_needs_the_teammate_then_the_manager(self):
        x, y = self._shift(A), self._shift(B, day=DAY2)
        r = self._ask(A, kind="swap", shift_id=x, target_email=B, target_shift_id=y).json()
        self.assertEqual(r["status"], "pending_peer")
        self.assertIn("Shift swap request", self._bells(B))
        # A manager cannot approve before the teammate accepts.
        self.assertEqual(self._decide(r["id"]).status_code, 409)
        self._as(B)
        mine = self.client.get("/timeclock/shift-requests/mine").json()
        self.assertEqual([i["id"] for i in mine["incoming"]], [r["id"]])
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{r['id']}/respond", json={"accept": True}).json()["status"],
                         "pending_manager")
        self.assertEqual(self._decide(r["id"]).json()["status"], "approved")
        self.assertEqual((self._row(x).employee_email, self._row(y).employee_email), (B, A))

    def test_an_offer_can_be_declined_by_the_teammate(self):
        x = self._shift(A)
        r = self._ask(A, kind="offer", shift_id=x, target_email=B).json()
        self._as(B)
        d = self.client.post(f"/timeclock/shift-requests/{r['id']}/respond", json={"accept": False, "note": "Busy"}).json()
        self.assertEqual(d["status"], "declined")
        self.assertIn("Shift request declined", self._bells(A))
        self.assertEqual(self._row(x).employee_email, A)

    def test_only_own_shifts_and_only_teammates(self):
        x, cx = self._shift(A), self._shift(C)
        self.assertEqual(self._ask(A, kind="offer", shift_id=x, target_email=C).status_code, 403)
        self.assertEqual(self._ask(A, kind="offer", shift_id=cx, target_email=B).status_code, 403)
        self.assertEqual(self._ask(A, kind="offer", shift_id=x, target_email=A).status_code, 400)

    def test_approval_refuses_when_the_schedule_moved_on(self):
        x = self._shift(A)
        r = self._ask(A, kind="offer", shift_id=x, target_email=B).json()
        self._as(B)
        self.client.post(f"/timeclock/shift-requests/{r['id']}/respond", json={"accept": True})
        db = database.SessionLocal()
        try:
            db.query(models.ScheduledShift).filter(models.ScheduledShift.id == x).update({"employee_email": C})
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._decide(r["id"]).status_code, 409)
        self._as(ADMIN)
        self.assertEqual(self.client.get("/timeclock/shift-requests").json()["pending"][0]["status"], "pending_manager")

    def test_approving_cancels_other_requests_on_the_same_shift(self):
        x, y = self._shift(A), self._shift(B, day=DAY2)
        offer = self._ask(A, kind="offer", shift_id=x, target_email=B).json()
        swap = self._ask(B, kind="swap", shift_id=y, target_email=A, target_shift_id=x).json()
        self._as(B)
        self.client.post(f"/timeclock/shift-requests/{offer['id']}/respond", json={"accept": True})
        self._decide(offer["id"])
        self._as(B)
        mine = {m["id"]: m for m in self.client.get("/timeclock/shift-requests/mine").json()["mine"]}
        self.assertEqual(mine[swap["id"]]["status"], "cancelled")

    def test_the_requester_can_cancel_and_nobody_else_can(self):
        r = self._ask(A, kind="offer", shift_id=self._shift(A), target_email=B).json()
        self._as(B)
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{r['id']}/cancel").status_code, 403)
        self._as(A)
        self.assertEqual(self.client.post(f"/timeclock/shift-requests/{r['id']}/cancel").json()["status"], "cancelled")

    def test_staff_cannot_open_the_inbox_or_decide(self):
        r = self._ask(A, kind="open", shift_id=self._shift("", slots=1)).json()
        self._as(B)
        self.assertIn(self.client.get("/timeclock/shift-requests").status_code, (401, 403))
        self.assertIn(self.client.post(f"/timeclock/shift-requests/{r['id']}/decide", json={"approve": True}).status_code,
                      (401, 403))


if __name__ == "__main__":
    unittest.main()
