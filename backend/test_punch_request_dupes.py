"""Time Clock: duplicate punch-fix requests are one fix (Charmi, Oct 7).

Employees filed the same fix 2-3 times (3x a clock-out at 5:55 PM, 2x a break
end at 4:00 PM). Approving one copy worked and every other copy then failed
with "Approving this 'break_end' would make the following 'break_end' punch
invalid". Now: the same employee + kind + minute is one request - approving or
rejecting it closes the copies quietly, a new copy is refused at submit, a
bulk approve skips copies, and a genuine collision names the punch it hits.

Runs against its own temporary database:
    python -m pytest test_punch_request_dupes.py
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

ADMIN = "dupetest.admin@greensglobal.com"
EMP = "dupetest.emp@greensglobal.com"
GROUP = "grp-dupetest"


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


class PunchRequestDupeTests(unittest.TestCase):
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
        self._as(ADMIN)
        db = database.SessionLocal()
        try:
            for m in (models.TimePunch, models.PunchRequest, models.NexusNotification,
                      models.NexusEmployee, models.NexusGroupMember, models.NexusGroup):
                db.query(m).delete()
            for em, fn in ((ADMIN, "Admin"), (EMP, "Jeremy")):
                db.add(models.NexusEmployee(id=f"emp-{em}", first_name=fn, last_name="Test",
                                            work_email=em, company="", status="active", deleted_at=""))
            db.add(models.NexusGroup(id=GROUP, name="Dupe Test", allowed_modules="hr:editor"))
            db.add(models.NexusGroupMember(group_id=GROUP, email=ADMIN))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        # Three days ago, 9:00 AM UTC (tz offset 0, so local = UTC).
        self.day = datetime.now(timezone.utc).replace(hour=9, minute=0, second=0, microsecond=0) - timedelta(days=3)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip
        if self._email is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._email
        cache.module_grants.invalidate()

    # helpers
    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _punch(self, kind, at):
        db = database.SessionLocal()
        try:
            db.add(models.TimePunch(id=str(uuid.uuid4()), employee_email=EMP, kind=kind, at=_iso(at),
                                    local_date=at.strftime("%Y-%m-%d"), tz_offset_min=0,
                                    geo_status="no_location", voided=0, created_at=_iso(at)))
            db.commit()
        finally:
            db.close()

    def _request(self, kind, at, created=None):
        db = database.SessionLocal()
        try:
            r = models.PunchRequest(id=str(uuid.uuid4()), employee_email=EMP, employee_name="Jeremy Test",
                                    action="add", punch_kind=kind, at=_iso(at), local_date=at.strftime("%Y-%m-%d"),
                                    tz_offset_min=0, reason="Forgot to punch", status="pending",
                                    created_at=_iso(created or at))
            db.add(r); db.commit()
            return r.id
        finally:
            db.close()

    def _req(self, req_id):
        db = database.SessionLocal()
        try:
            r = db.query(models.PunchRequest).filter(models.PunchRequest.id == req_id).first()
            return r.status, r.decision_note
        finally:
            db.close()

    def _kinds(self):
        db = database.SessionLocal()
        try:
            return [(p.kind, p.at[11:16]) for p in db.query(models.TimePunch)
                    .filter(models.TimePunch.employee_email == EMP, models.TimePunch.voided == 0)
                    .order_by(models.TimePunch.at.asc()).all()]
        finally:
            db.close()

    def _bells_for(self, ref_id):
        db = database.SessionLocal()
        try:
            return db.query(models.NexusNotification).filter(models.NexusNotification.ref_id == ref_id).count()
        finally:
            db.close()

    def _decide(self, req_id, status="approved"):
        return self.client.patch(f"/timeclock/punch-requests/{req_id}", json={"status": status, "note": ""})

    # tests
    def test_approving_one_copy_closes_the_others_quietly(self):
        self._punch("in", self.day)
        out_at = self.day + timedelta(hours=8, minutes=55)
        ids = [self._request("out", out_at), self._request("out", out_at + timedelta(seconds=20)),
               self._request("out", out_at)]
        resp = self._decide(ids[1])
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["status"], "approved")
        self.assertEqual(self._kinds(), [("in", "09:00"), ("out", "17:55")])
        for other in (ids[0], ids[2]):
            self.assertEqual(self._req(other), ("rejected", "Duplicate of an approved request"))
            self.assertEqual(self._bells_for(other), 0)
        self.assertEqual(self._bells_for(ids[1]), 1)

    def test_rejecting_one_copy_closes_the_others(self):
        self._punch("in", self.day)
        out_at = self.day + timedelta(hours=8, minutes=55)
        a, b = self._request("out", out_at), self._request("out", out_at)
        self.assertEqual(self._decide(a, "rejected").status_code, 200)
        self.assertEqual(self._req(b), ("rejected", "Duplicate of a rejected request"))
        self.assertEqual(self._bells_for(b), 0)
        self.assertEqual(self._kinds(), [("in", "09:00")])

    def test_copy_of_a_punch_already_on_the_timecard_is_closed_not_refused(self):
        # Older data: one copy was approved before copies were closed automatically.
        self._punch("in", self.day)
        self._punch("break_start", self.day + timedelta(hours=6))
        self._punch("break_end", self.day + timedelta(hours=7))
        left = self._request("break_end", self.day + timedelta(hours=7))
        resp = self._decide(left)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self._req(left)[0], "rejected")
        self.assertTrue(self._req(left)[1].startswith("Duplicate of"))
        self.assertEqual(len(self._kinds()), 3)

    def test_duplicate_submit_is_refused(self):
        self._punch("in", self.day)
        self._as(EMP)
        at = _iso(self.day + timedelta(hours=8, minutes=55))
        body = {"action": "add", "punch_kind": "out", "at": at, "reason": "Forgot", "tz_offset_min": 0}
        first = self.client.post("/timeclock/punch-requests", json=body)
        self.assertEqual(first.status_code, 200, first.text)
        again = self.client.post("/timeclock/punch-requests", json={**body, "at": at[:17] + "40"})
        self.assertEqual(again.status_code, 409, again.text)
        self.assertEqual(again.json()["detail"], "You already asked for this fix.")
        # A different minute is a different fix.
        other = self.client.post("/timeclock/punch-requests",
                                 json={**body, "punch_kind": "in", "at": _iso(self.day + timedelta(hours=9))})
        self.assertEqual(other.status_code, 200, other.text)

    def test_bulk_approve_in_time_order_skips_duplicates(self):
        # Jeremy's day: two copies of the break end, three of the clock-out.
        self._punch("in", self.day)
        self._punch("break_start", self.day + timedelta(hours=6))
        be = self.day + timedelta(hours=7)
        out = self.day + timedelta(hours=8, minutes=55)
        ids = [self._request("break_end", be), self._request("break_end", be),
               self._request("out", out), self._request("out", out), self._request("out", out)]
        # What the screen's "Approve selected" does: one call per id, in time order.
        for rid in ids:
            resp = self._decide(rid)
            self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self._kinds(), [("in", "09:00"), ("break_start", "15:00"),
                                         ("break_end", "16:00"), ("out", "17:55")])
        statuses = [self._req(i)[0] for i in ids]
        self.assertEqual(statuses.count("approved"), 2)
        self.assertEqual(statuses.count("rejected"), 3)

    def test_pair_partner_copies_are_not_chained_twice(self):
        # Approving the clock-out first pulls in the pending clock-in - once,
        # even though the clock-in was filed twice.
        self._punch("in", self.day - timedelta(days=1))
        self._punch("out", self.day - timedelta(days=1) + timedelta(hours=8))
        in1, in2 = self._request("in", self.day), self._request("in", self.day)
        out = self._request("out", self.day + timedelta(hours=8))
        resp = self._decide(out)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual([k for k, _ in self._kinds()], ["in", "out", "in", "out"])
        self.assertEqual(sorted([self._req(in1)[0], self._req(in2)[0]]), ["approved", "rejected"])

    def test_earlier_break_end_goes_in_and_the_late_one_is_cleared(self):
        # Michael, 09/30: break 1:31 PM, a break end only at 6:29 PM (pressed at
        # the end of the day). He asks for break end 2:01 PM. That is a plain fix,
        # never a "conflict": it goes in, and the leftover break end is cleared.
        self._punch("in", self.day)
        self._punch("break_start", self.day + timedelta(hours=6))
        self._punch("break_end", self.day + timedelta(hours=7, minutes=12))
        self._punch("out", self.day + timedelta(hours=9))
        rid = self._request("break_end", self.day + timedelta(hours=7))
        resp = self._decide(rid)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self._req(rid)[0], "approved")
        self.assertEqual(self._kinds(), [("in", "09:00"), ("break_start", "15:00"), ("break_end", "16:00"), ("out", "18:00")])
        self.assertIn("extra break end at 4:12 PM", resp.json()["decisionNote"])

    def test_later_clock_out_replaces_the_earlier_one(self):
        # "I left at 6:00 PM, not 5:00 PM": the employee's time is used and the
        # 5:00 PM clock-out is set aside (kept for audit), not refused.
        self._punch("in", self.day)
        self._punch("out", self.day + timedelta(hours=8))
        rid = self._request("out", self.day + timedelta(hours=9))
        resp = self._decide(rid)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self._kinds(), [("in", "09:00"), ("out", "18:00")])
        self.assertIn("Replaced the clock-out at 5:00 PM", resp.json()["decisionNote"])

    def test_break_pressed_instead_of_clock_out(self):
        # Jeremy, 09/22: "Forgot clock out did break instead" - pressed Break at
        # 2:15 PM, a clock-out was put in at 5:00 PM. He asks for clock-out 2:15 PM.
        self._punch("in", self.day)
        self._punch("break_start", self.day + timedelta(hours=5, minutes=15, seconds=24))
        self._punch("out", self.day + timedelta(hours=8))
        rid = self._request("out", self.day + timedelta(hours=5, minutes=15))
        resp = self._decide(rid)
        self.assertEqual(resp.status_code, 200, resp.text)
        kinds = [k for k, _ in self._kinds()]
        self.assertEqual(kinds[:2], ["in", "out"])
        self.assertNotIn(("out", "17:00"), self._kinds())

    def test_messy_day_with_two_break_starts_still_takes_the_break_end(self):
        # Miranda, 09/22: break start 1:53 PM, then two break starts at 2:23 PM
        # (an earlier wrong edit), break end 2:37 PM. She asks for break end
        # 2:23 PM. The day was already odd - that never blocks a sane fix.
        self._punch("in", self.day)
        self._punch("break_start", self.day + timedelta(hours=4, minutes=53))
        self._punch("break_start", self.day + timedelta(hours=5, minutes=23))
        self._punch("break_start", self.day + timedelta(hours=5, minutes=23))
        self._punch("break_end", self.day + timedelta(hours=5, minutes=37))
        self._punch("out", self.day + timedelta(hours=8))
        rid = self._request("break_end", self.day + timedelta(hours=5, minutes=23))
        resp = self._decide(rid)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self._req(rid)[0], "approved")

    def test_a_fix_that_really_cannot_go_in_says_so_in_plain_words(self):
        # A break start with no break end and nothing to pair with: the day would
        # have a break that never ended. Plain words, the day's punches listed,
        # what to do next - no "break_end"/"in" jargon.
        self._punch("in", self.day)
        self._punch("out", self.day + timedelta(hours=9))
        rid = self._request("break_start", self.day + timedelta(hours=3))
        resp = self._decide(rid)
        self.assertEqual(resp.status_code, 409, resp.text)
        msg = resp.json()["detail"]
        us = self.day.strftime("%m/%d/%Y")
        self.assertIn(f"Jeremy's break start at 12:00 PM on {us} can't be added as it stands", msg)
        self.assertIn("a break that never ended", msg)
        self.assertIn("Clock In 9:00 AM, Break Start 12:00 PM, Clock Out 6:00 PM", msg)
        self.assertIn("Ask Jeremy for the missing time", msg)
        for jargon in ("break_end", "break_start", "'in'", "UTC", "sequence"):
            self.assertNotIn(jargon, msg)
        self.assertEqual(self._req(rid)[0], "pending")


if __name__ == "__main__":
    unittest.main()
