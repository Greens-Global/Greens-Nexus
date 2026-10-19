"""Time Clock: an employee can take back a pending punch-fix request, and
clearing decided ones sticks (Miranda, Oct 18).

A clock-in request filed by mistake stayed pending with no way to cancel it,
and blocked the right one as "You already asked for this fix". Decided
requests cleared from the list came back on every login (the dismissal lived
only in the browser). The employee's approved / rejected notice now says
which punch and day it was about.

Runs against its own temporary database:
    python -m pytest test_punch_request_cancel.py
"""
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

ADMIN = "canceltest.admin@greensglobal.com"
EMP = "canceltest.emp@greensglobal.com"
OTHER = "canceltest.other@greensglobal.com"
GROUP = "grp-canceltest"


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class PunchRequestCancelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)
        cls.client = TestClient(main.app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        db = database.SessionLocal()
        try:
            for m in (models.TimePunch, models.PunchRequest, models.NexusNotification,
                      models.NexusEmployee, models.NexusGroupMember, models.NexusGroup):
                db.query(m).delete()
            for em, fn in ((ADMIN, "Admin"), (EMP, "Miranda"), (OTHER, "Other")):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test",
                                            work_email=em, company="", status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GROUP, name="Cancel Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        self.day = datetime.now(timezone.utc).replace(hour=8, minute=30, second=0, microsecond=0) - timedelta(days=2)
        self._as(EMP)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _ask(self, kind, at):
        resp = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": kind, "at": _iso(at), "reason": "Nexus was down", "tz_offset_min": 0})
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["id"]

    def _mine(self):
        return {r["id"]: r for r in self.client.get("/timeclock/punch-requests/mine").json()}

    def _open_bells(self, ref_id):
        db = database.SessionLocal()
        try:
            return db.query(models.NexusNotification).filter(
                models.NexusNotification.ref_id == ref_id, models.NexusNotification.actioned == False).count()  # noqa: E712
        finally:
            db.close()

    def test_cancel_frees_the_same_fix_to_be_asked_again(self):
        rid = self._ask("in", self.day)
        dup = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "in", "at": _iso(self.day), "reason": "again", "tz_offset_min": 0})
        self.assertEqual(dup.status_code, 409)
        db = database.SessionLocal()   # the approver's notice (no manager in this test db)
        try:
            db.add(models.NexusNotification(id=str(uuid.uuid4()), type="custom_alert", recipient=ADMIN,
                                            title="Time Sheet Fix Requested", body="", ref_id=rid, item_name="",
                                            requested_by=EMP, action="", actioned=False, read_by="",
                                            created_at=_iso(self.day), priority=1))
            db.commit()
        finally:
            db.close()
        self.assertEqual(self._open_bells(rid), 1)

        resp = self.client.post(f"/timeclock/punch-requests/{rid}/cancel")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["status"], "cancelled")
        self.assertEqual(self._open_bells(rid), 0)          # ...and the notice is closed
        # Cancelling twice is harmless.
        self.assertEqual(self.client.post(f"/timeclock/punch-requests/{rid}/cancel").status_code, 200)
        # The fix can now be asked for again.
        self._ask("in", self.day)

    def test_only_my_own_pending_request_can_be_cancelled(self):
        rid = self._ask("in", self.day)
        self._as(OTHER)
        self.assertEqual(self.client.post(f"/timeclock/punch-requests/{rid}/cancel").status_code, 404)
        self._as(ADMIN)
        self.assertEqual(self.client.patch(f"/timeclock/punch-requests/{rid}",
                                           json={"status": "rejected", "note": ""}).status_code, 200)
        self._as(EMP)
        resp = self.client.post(f"/timeclock/punch-requests/{rid}/cancel")
        self.assertEqual(resp.status_code, 409, resp.text)

    def test_dismissal_is_stored_on_the_server(self):
        a = self._ask("in", self.day)
        b = self._ask("out", self.day + timedelta(hours=9))
        c = self._ask("in", self.day + timedelta(days=1))
        # A pending request can't be dismissed - it is cancelled instead.
        self.assertEqual(self.client.post(f"/timeclock/punch-requests/{a}/dismiss").status_code, 409)
        self._as(ADMIN)
        for rid in (a, b):
            self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "rejected", "note": ""})
        self._as(EMP)
        self.assertEqual(self.client.post(f"/timeclock/punch-requests/{a}/dismiss").status_code, 200)
        mine = self._mine()
        self.assertTrue(mine[a]["dismissed"])
        self.assertFalse(mine[b]["dismissed"])
        cleared = self.client.post("/timeclock/punch-requests/dismiss-decided").json()["cleared"]
        self.assertEqual(cleared, 1)
        mine = self._mine()
        self.assertTrue(mine[b]["dismissed"])
        self.assertFalse(mine[c]["dismissed"])               # still pending - stays

    def test_employee_notice_names_the_punch_and_day(self):
        rid = self._ask("in", self.day)
        self._as(ADMIN)
        self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "rejected", "note": ""})
        db = database.SessionLocal()
        try:
            n = db.query(models.NexusNotification).filter(
                models.NexusNotification.ref_id == rid, models.NexusNotification.recipient == EMP).first()
            self.assertIsNotNone(n)
            self.assertIn(f"clock-in punch at 8:30 AM on {self.day.strftime('%m/%d/%Y')}", n.body)
        finally:
            db.close()


if __name__ == "__main__":
    unittest.main()
