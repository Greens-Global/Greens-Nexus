"""Time Clock: approving the later half of a punch-fix pair first.

Employees raise fixes in pairs (clock-in + clock-out, break start + break end)
and the approver usually clicks the later one first. Until Sep 9 2026 that was
refused with "would place a 'out' after a 'out'" because the earlier partner
was still pending (Charmi could not approve anything). Approval now pulls the
pending partner(s) in, validates the whole run as one chain, and applies it.

    python -m unittest test_punch_request_pairs
"""
import os
import unittest
import uuid
from datetime import datetime, timezone, timedelta

os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient

import auth
import cache
import database
import main
import models

models.Base.metadata.create_all(bind=database.engine)

ADMIN = "pairtest.admin@greensglobal.com"
EMP = "pairtest.emp@greensglobal.com"
GROUP = "grp-pairtest"


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class PunchPairTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip = auth.SKIP_AUTH
        auth.SKIP_AUTH = True
        self._email = os.environ.get("NEXUS_DEV_EMAIL")
        os.environ["NEXUS_DEV_EMAIL"] = ADMIN
        self._cleanup()
        db = database.SessionLocal()
        try:
            for em, fn in ((ADMIN, "Admin"), (EMP, "Beth")):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test",
                                            work_email=em, company="", status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GROUP, name="Pair Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            # A complete shift two days ago, then nothing: the employee forgot to
            # clock in and out yesterday and raised both halves as requests.
            base = datetime.now(timezone.utc).replace(hour=9, minute=0, second=0, microsecond=0) - timedelta(days=2)
            self.base = base
            self._punch("in", base)
            self._punch("out", base + timedelta(hours=8))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()

    def _punch(self, kind, at):
        db = database.SessionLocal()
        try:
            db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=EMP, kind=kind, at=_iso(at),
                                    local_date=at.strftime("%Y-%m-%d"), tz_offset_min=0,
                                    geo_status="no_location", voided=0, created_at=_iso(at)))
            db.commit()
        finally:
            db.close()

    def _request(self, kind, at):
        db = database.SessionLocal()
        try:
            r = models.PunchRequest(id=str(uuid.uuid4()), employee_email=EMP, employee_name="Beth Test",
                                    action="add", punch_kind=kind, at=_iso(at), local_date=at.strftime("%Y-%m-%d"),
                                    tz_offset_min=0, reason="Forgot to punch", status="pending",
                                    created_at=_iso(at))
            db.add(r); db.commit()
            return r.id
        finally:
            db.close()

    def _status(self, req_id):
        db = database.SessionLocal()
        try:
            return db.query(models.PunchRequest).filter(models.PunchRequest.id == req_id).first().status
        finally:
            db.close()

    def _kinds(self):
        db = database.SessionLocal()
        try:
            return [p.kind for p in db.query(models.TimePunch)
                    .filter(models.TimePunch.employee_email == EMP, models.TimePunch.voided == 0)
                    .order_by(models.TimePunch.at.asc()).all()]
        finally:
            db.close()

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
               .filter(models.NexusEmployee.work_email.like("pairtest.%")).delete(synchronize_session=False))
            db.query(models.NexusGroup).filter(models.NexusGroup.id == GROUP).delete(synchronize_session=False)
            db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == GROUP).delete(synchronize_session=False)
            db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP).delete(synchronize_session=False)
            db.query(models.PunchRequest).filter(models.PunchRequest.employee_email == EMP).delete(synchronize_session=False)
            db.commit()
        finally:
            db.close()

    def test_approving_clock_out_first_pulls_in_the_pending_clock_in(self):
        day = self.base + timedelta(days=1)
        r_in = self._request("in", day)
        r_out = self._request("out", day + timedelta(hours=8))
        resp = self.client.patch(f"/timeclock/punch-requests/{r_out}", json={"status": "approved", "note": ""})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn("Also applied the pending clock-in", resp.json()["decisionNote"])
        self.assertEqual(self._status(r_in), "approved")
        self.assertEqual(self._status(r_out), "approved")
        self.assertEqual(self._kinds(), ["in", "out", "in", "out"])

    def test_break_pair_at_the_same_minute_approved_from_the_end(self):
        day = self.base + timedelta(days=1)
        self._punch("in", day)
        self._punch("out", day + timedelta(hours=8))
        t = day + timedelta(hours=3)
        r_start = self._request("break_start", t)
        r_end = self._request("break_end", t)
        resp = self.client.patch(f"/timeclock/punch-requests/{r_end}", json={"status": "approved", "note": ""})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self._status(r_start), "approved")
        self.assertEqual(self._kinds(), ["in", "out", "in", "break_start", "break_end", "out"])

    def test_lone_clock_out_with_no_partner_is_still_refused(self):
        day = self.base + timedelta(days=1)
        r_out = self._request("out", day + timedelta(hours=8))
        resp = self.client.patch(f"/timeclock/punch-requests/{r_out}", json={"status": "approved", "note": ""})
        self.assertEqual(resp.status_code, 409, resp.text)
        self.assertIn("isn't a valid punch sequence", resp.json()["detail"])
        self.assertEqual(self._status(r_out), "pending")
        self.assertEqual(self._kinds(), ["in", "out"])

    def test_invalid_partner_leaves_everything_pending(self):
        # Partner is a second clock-OUT, so the chain out,out is still illegal.
        day = self.base + timedelta(days=1)
        r_a = self._request("out", day + timedelta(hours=1))
        r_b = self._request("out", day + timedelta(hours=8))
        resp = self.client.patch(f"/timeclock/punch-requests/{r_b}", json={"status": "approved", "note": ""})
        self.assertEqual(resp.status_code, 409, resp.text)
        self.assertEqual(self._status(r_a), "pending")
        self.assertEqual(self._status(r_b), "pending")
        self.assertEqual(self._kinds(), ["in", "out"])


if __name__ == "__main__":
    unittest.main()
