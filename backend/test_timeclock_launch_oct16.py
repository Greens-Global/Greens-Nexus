"""Time clock launch pass (Oct 16 2026) - the guards added before go-live.

- a punch-fix request can neither be filed for nor approved into a finalized period
- a punch moved to another day is checked against the DESTINATION day's lock
- the manager may agree only AFTER the period's last day, the employee may
  submit only ON or after it
- HR's Unlock closes the signed review out so a new round can start
- a stale open shift's 409 carries "message" (what api.js shows)

Run with: python -m pytest test_timeclock_launch_oct16.py
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402

EMP, MGR, HR = "emp.l16@greensglobal.com", "mgr.l16@greensglobal.com", "hr.l16@greensglobal.com"
ENTITY = "ent-l16"
PAST = (datetime.now(timezone.utc) - timedelta(days=40)).strftime("%Y-%m-%d")   # a period fully over
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")


class LaunchCase(unittest.TestCase):
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
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        auth.invalidate_role_cache()
        self.db = database.SessionLocal()
        for m in (models.TimesheetReview, models.TimePunch, models.TimeApproval, models.PunchRequest,
                  models.NexusEmployee, models.HrEntity, models.PayrollRate, models.NexusRole):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENTITY, name="Launch Co", hr_contact_email=HR))
        for email, first, mgr in ((EMP, "Erin", MGR), (MGR, "Max", ""), (HR, "Hana", "")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=email, first_name=first,
                                             last_name="Test", company=ENTITY, manager_email=mgr,
                                             status="active"))
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=HR, role="administrator", assigned_by="test"))
        self.start, self.end = timeclock._pay_period(PAST)
        self.db.commit()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _punch(self, day, kind, hhmm, email=EMP, pid=None):
        p = models.TimePunch(id=pid or f"p-{day}-{kind}-{hhmm}", employee_email=email, kind=kind,
                             at=f"{day}T{hhmm}", local_date=day, tz_offset_min=0,
                             created_at=f"{day}T{hhmm}")
        self.db.add(p)
        self.db.commit()
        return p.id

    def _finalize(self, start=None, end=None):
        self.db.add(models.TimeApproval(id=f"fin-{start or self.start}", employee_email=EMP,
                                        period_start=start or self.start, period_end=end or self.end,
                                        worked_min=0, approved_by=HR, approved_at="2026-10-16T00:00:00",
                                        kind="final", note="{}"))
        self.db.commit()

    # ── finalized period ───────────────────────────────────────────────────

    def test_request_cannot_be_filed_for_a_finalized_day(self):
        self._punch(self.start, "in", "16:00:00")
        self._finalize()
        self._as(EMP)
        r = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "out", "at": f"{self.start}T23:00:00",
            "tz_offset_min": 0, "reason": "forgot"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertIn("finalized", r.json()["detail"].lower())

    def test_request_cannot_be_approved_into_a_finalized_day(self):
        self._punch(self.start, "in", "16:00:00")
        self._as(EMP)
        r = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "out", "at": f"{self.start}T23:00:00",
            "tz_offset_min": 0, "reason": "forgot"})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        self._finalize()                       # HR locks the period while the request waits
        self._as(MGR)
        r = self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "approved"})
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(self.db.query(models.TimePunch).filter(models.TimePunch.kind == "out").count(), 0)
        # Rejecting is still allowed - nothing is written.
        r = self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "rejected", "note": "no"})
        self.assertEqual(r.status_code, 200, r.text)

    def test_moving_a_punch_into_a_finalized_day_is_refused(self):
        # Period A (finalized) ends at self.end; period B opens the next day.
        day_b = (datetime.strptime(self.end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        self._punch(day_b, "in", "16:00:00")
        pid = self._punch(day_b, "out", "23:30:00")
        self._finalize()
        self._as(MGR)
        r = self.client.patch(f"/timeclock/punches/{pid}", json={"at": f"{self.end}T23:30:00"})
        self.assertEqual(r.status_code, 403, r.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.TimePunch).get(pid).local_date, day_b)
        # The same move on an open day still works.
        r = self.client.patch(f"/timeclock/punches/{pid}", json={"at": f"{day_b}T22:30:00"})
        self.assertEqual(r.status_code, 200, r.text)

    # ── period gates ───────────────────────────────────────────────────────

    def test_employee_cannot_submit_before_the_last_day(self):
        cur_start, cur_end = timeclock._pay_period(TODAY)
        self._punch(cur_start, "in", "16:00:00")
        self._punch(cur_start, "out", "23:00:00")
        blocker = tsr.submit_blocker(self.db, EMP, cur_start, cur_end)
        if TODAY < cur_end:
            self.assertIn("Submit it on that day", blocker)
            self._as(EMP)
            r = self.client.post("/timesheet-review/submit", json={"start": cur_start, "note": ""})
            self.assertEqual(r.status_code, 409, r.text)
        else:   # today IS the last day - submitting is allowed
            self.assertEqual(blocker, "")
        # A period that is over has no date blocker.
        self._punch(self.start, "in", "16:00:00")
        self._punch(self.start, "out", "23:00:00")
        self.assertEqual(tsr.submit_blocker(self.db, EMP, self.start, self.end), "")

    def test_manager_agrees_only_after_the_last_day(self):
        cur_start, cur_end = timeclock._pay_period(TODAY)
        r = models.TimesheetReview(id="rv-cur", employee_email=EMP, period_start=cur_start, period_end=cur_end,
                                   pay_type="hourly", manager_email=MGR, status="with_manager", rounds=[],
                                   last_snapshot={}, created_at="2026-10-16T00:00:00")
        self.db.add(r)
        self.db.commit()
        # Even on the last day itself the gate stays shut - a shift may still be ahead.
        self.assertIn("after that day", tsr.agree_blocker(self.db, r))
        self._as(MGR)
        resp = self.client.post(f"/timesheet-review/{r.id}/agree", json={"note": ""})
        self.assertEqual(resp.status_code, 409, resp.text)

    # ── unlock reopens the review ──────────────────────────────────────────

    def test_unlock_hands_the_signed_review_to_hr_to_correct(self):
        self._punch(self.start, "in", "16:00:00")
        self._punch(self.start, "out", "23:00:00")
        self.db.add(models.TimesheetReview(id="rv-done", employee_email=EMP, period_start=self.start,
                                           period_end=self.end, pay_type="hourly", manager_email=MGR,
                                           hr_email=HR, status="completed", rounds=[], last_snapshot={},
                                           created_at="2026-10-16T00:00:00"))
        self._finalize()
        self._as(EMP)
        r = self.client.post("/timesheet-review/submit", json={"start": self.start, "note": ""})
        self.assertEqual(r.status_code, 409, r.text)     # finalized + completed: no new round
        self._as(HR)
        r = self.client.post("/timeclock/unfinalize", json={"email": EMP, "start": self.start, "end": self.end})
        self.assertEqual(r.status_code, 422, r.text)          # Oct 22: a reason is required
        r = self.client.post("/timeclock/unfinalize", json={"email": EMP, "start": self.start, "end": self.end,
                                                            "reason": "Wrong lunch on Monday"})
        self.assertEqual(r.status_code, 200, r.text)
        self.db.expire_all()
        self.assertEqual(self.db.query(models.TimesheetReview).get("rv-done").status, "correcting")
        self._as(EMP)
        r = self.client.post("/timesheet-review/submit", json={"start": self.start, "note": "fixed"})
        self.assertEqual(r.status_code, 409, r.text)          # HR corrects it; the employee signs after
        self._as(HR)
        r = self.client.post("/timesheet-review/rv-done/relock")
        self.assertEqual(r.status_code, 200, r.text)
        rows = self.db.query(models.TimesheetReview).filter(models.TimesheetReview.employee_email == EMP).all()
        self.assertEqual([x.status for x in rows], ["completed"])   # one review, locked again

    # ── stale shift message ────────────────────────────────────────────────

    def test_stale_open_shift_409_carries_a_message(self):
        old = (datetime.now(timezone.utc) - timedelta(hours=20)).strftime("%Y-%m-%dT%H:%M:%S")
        self.db.add(models.TimePunch(id="p-stale", employee_email=EMP, kind="in", at=old,
                                     local_date=old[:10], tz_offset_min=0, created_at=old))
        self.db.commit()
        self._as(EMP)
        r = self.client.post("/timeclock/punch", json={"kind": "out", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 409, r.text)
        d = r.json()["detail"]
        self.assertEqual(d["code"], "stale_open_shift")
        self.assertIn("Missed Punch", d["message"])


    # ── Beginning / End-of-day enforced by the server (Neil, Oct 16) ──────

    def _bod(self, kind, day):
        self.db.add(models.TimeBod(id=f"bod-{kind}-{day}", employee_email=EMP, kind=kind, local_date=day,
                                   message="(sent outside Nexus)", created_at=f"{day}T00:00:00"))
        self.db.commit()

    def test_first_clock_in_needs_a_bod_and_clock_out_needs_an_eod(self):
        self._as(EMP)
        r = self.client.post("/timeclock/punch", json={"kind": "in", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"]["code"], "bod_required")
        self._bod("bod", TODAY)
        r = self.client.post("/timeclock/punch", json={"kind": "in", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.client.get("/timeclock/status").json()["eodRequired"])
        # Punch times are second-resolution: the clock-out lands in the next
        # second so it is unambiguously the "last punch".
        import time
        time.sleep(1.1)
        r = self.client.post("/timeclock/punch", json={"kind": "out", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 409, r.text)
        self.assertEqual(r.json()["detail"]["code"], "eod_required")
        self._bod("eod", TODAY)
        self.assertFalse(self.client.get("/timeclock/status").json()["eodRequired"])
        r = self.client.post("/timeclock/punch", json={"kind": "out", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 200, r.text)
        # A second clock-in the same day needs no second message.
        time.sleep(1.1)
        r = self.client.post("/timeclock/punch", json={"kind": "in", "tz_offset_min": 0})
        self.assertEqual(r.status_code, 200, r.text + " " + str(self.client.get("/timeclock/status").json()["lastPunch"]))

    def test_an_exempt_role_punches_straight_through(self):
        self.db.add(models.NexusGroup(id="g-l16", name="Field", allowed_modules="", bod_exempt=1))
        self.db.add(models.NexusGroupMember(group_id="g-l16", email=EMP))
        self.db.commit()
        try:
            self._as(EMP)
            self.assertEqual(self.client.post("/timeclock/punch", json={"kind": "in", "tz_offset_min": 0}).status_code, 200)
            self.assertEqual(self.client.post("/timeclock/punch", json={"kind": "out", "tz_offset_min": 0}).status_code, 200)
        finally:
            self.db.query(models.NexusGroupMember).filter(models.NexusGroupMember.group_id == "g-l16").delete()
            self.db.query(models.NexusGroup).filter(models.NexusGroup.id == "g-l16").delete()
            self.db.commit()

    # ── no manager: the HR contact decides ────────────────────────────────

    def test_hr_contact_decides_for_people_with_no_manager(self):
        # A manager-tier HR contact (no People grant) of a company whose
        # employee has nobody set as manager.
        HR2 = "hr2.l16@greensglobal.com"
        self.db.add(models.NexusEmployee(id="id-Hal", work_email=HR2, first_name="Hal", last_name="Test",
                                         company=ENTITY, manager_email="", status="active"))
        self.db.add(models.NexusRole(email=HR2, role="manager", assigned_by="test"))
        self.db.query(models.HrEntity).filter(models.HrEntity.id == ENTITY).update({"hr_contact_email": HR2})
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == EMP).update({"manager_email": ""})
        self.db.commit()
        HR = HR2  # noqa: N806 - the approver for the rest of this test
        self._punch(self.start, "in", "16:00:00")
        self._as(EMP)
        r = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "out", "at": f"{self.start}T23:00:00",
            "tz_offset_min": 0, "reason": "forgot"})
        self.assertEqual(r.status_code, 200, r.text)
        rid = r.json()["id"]
        self._as(HR)                     # a manager-tier HR contact, no People grant
        self.assertIn(EMP, timeclock._visible_emails(self.db, {"email": HR, "level": 3}))
        r = self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "approved"})
        self.assertEqual(r.status_code, 200, r.text)


if __name__ == "__main__":
    unittest.main()
