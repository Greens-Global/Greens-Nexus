"""A manager cancels approved time off from the Shift Planner (11/11/2026).

  - whoever could decide the request cancels it, never their own; only
    approved, not already over; another team's manager is refused;
  - not started = canceled whole; started = the days before the employee's
    today stay, the rest goes (end_date = yesterday, still approved);
  - the employee gets a priority notice (the yellow bar) and one email with a
    Teams chat link to the manager; the reason is optional;
  - the response lists the usual shift's free working days in the canceled
    span (no shift already there, not past) for the planner's second popup.

    python -m pytest test_timeoff_manager_cancel.py
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

# A throwaway sqlite of its own (CLAUDE.md: one file per process).
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"

from fastapi.testclient import TestClient  # noqa: E402
import auth  # noqa: E402
import cache  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402
import timeoff_cancel_mail  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

EMP = "tc.emp@greensglobal.com"      # reports to MGR
MGR = "tc.mgr@greensglobal.com"      # manager (level 3)
OTHER = "tc.other@greensglobal.com"  # a manager of another team
CO = "co-tc"
TODAY = datetime.now(timezone.utc).date()   # EMP never punched: their today is UTC's


def iso(d: date) -> str:
    return d.isoformat()


class ManagerCancelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self._skip, auth.SKIP_AUTH = auth.SKIP_AUTH, True
        db = database.SessionLocal()
        try:
            for m in (models.NexusEmployee, models.NexusRole, models.HrEntity, models.TimeOffRequest,
                      models.NexusNotification, models.Shift, models.ShiftAssignment, models.ScheduledShift):
                db.query(m).execution_options(include_deleted=True).delete(synchronize_session=False)
            db.add(models.HrEntity(id=CO, name="TC Co"))
            for em, mgr, first in ((EMP, MGR, "Sagar"), (MGR, "", "Maya"), (OTHER, "", "Omar")):
                db.add(models.NexusEmployee(id=f"e-{em}", first_name=first, last_name="Test", work_email=em,
                                            manager_email=mgr, company=CO, status="active", deleted_at=""))
            db.add(models.NexusRole(email=MGR, role="manager"))
            db.add(models.NexusRole(email=OTHER, role="manager"))
            db.add(models.Shift(id="sh-usual", name="Evening", start_hhmm="18:30", end_hhmm="02:30", days="1,2,3,4,5"))
            db.add(models.ShiftAssignment(id="sa-1", employee_email=EMP, shift_id="sh-usual"))
            db.commit()
        finally:
            db.close()
        cache.module_grants.invalidate()
        auth.invalidate_role_cache()
        self.sent = []
        p = mock.patch.object(timeoff_cancel_mail, "send", lambda batch: self.sent.extend(batch))
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        auth.SKIP_AUTH = self._skip

    def _leave(self, start: date, end: date, status="approved", rid="to-1"):
        db = database.SessionLocal()
        try:
            db.add(models.TimeOffRequest(id=rid, employee_email=EMP, type="personal", start_date=iso(start),
                                         end_date=iso(end), status=status, approver=MGR, created_at="x"))
            db.commit()
        finally:
            db.close()
        return rid

    def _cancel(self, who, rid="to-1", reason=""):
        os.environ["NEXUS_DEV_EMAIL"] = who
        return self.client.post(f"/timeclock/timeoff/{rid}/manager-cancel", json={"reason": reason})

    def _row(self, rid="to-1"):
        db = database.SessionLocal()
        try:
            return db.get(models.TimeOffRequest, rid)
        finally:
            db.close()

    def _bells(self, to):
        db = database.SessionLocal()
        try:
            return db.query(models.NexusNotification).filter(models.NexusNotification.recipient == to).all()
        finally:
            db.close()

    def test_a_future_leave_is_canceled_whole_and_the_employee_is_told(self):
        start = TODAY + timedelta(days=10)
        self._leave(start, start + timedelta(days=6))
        r = self._cancel(MGR, reason="Client visit moved up")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self._row().status, "cancelled")
        bell = [b for b in self._bells(EMP) if b.title == "Your Manager Canceled Your Time Off"]
        self.assertEqual(len(bell), 1)
        self.assertEqual(bell[0].priority, 1)                     # the yellow bar
        self.assertIn("Reason: Client visit moved up", bell[0].body)
        self.assertEqual(len(self.sent), 1)
        to, subject, html = self.sent[0]
        self.assertEqual(to, EMP)
        self.assertIn("Was Canceled", subject)
        self.assertIn("https://teams.microsoft.com/l/chat/0/0?users=tc.mgr%40greensglobal.com", html)
        self.assertIn("Client visit moved up", html)

    def test_the_reason_is_optional(self):
        start = TODAY + timedelta(days=3)
        self._leave(start, start)
        self.assertEqual(self._cancel(MGR).status_code, 200)
        self.assertNotIn("Reason:", self._bells(EMP)[0].body)

    def test_a_started_leave_keeps_the_days_already_taken(self):
        self._leave(TODAY - timedelta(days=2), TODAY + timedelta(days=2))
        r = self._cancel(MGR)
        self.assertEqual(r.status_code, 200, r.text)
        row = self._row()
        self.assertEqual((row.status, row.end_date), ("approved", iso(TODAY - timedelta(days=1))))
        self.assertIn("stay as time off", self.sent[0][2])

    def test_a_managers_reports_hear_only_the_canceled_days(self):
        db = database.SessionLocal()
        try:
            db.add(models.NexusEmployee(id="e-rep", first_name="Rae", last_name="Test", work_email="tc.rep@greensglobal.com",
                                        manager_email=EMP, company=CO, status="active", deleted_at=""))
            db.commit()
        finally:
            db.close()
        self._leave(TODAY - timedelta(days=2), TODAY + timedelta(days=2))
        self.assertEqual(self._cancel(MGR).status_code, 200)
        body = self._bells("tc.rep@greensglobal.com")[0].body
        self.assertIn(TODAY.strftime("%m/%d/%Y"), body)                       # from today on
        self.assertNotIn((TODAY - timedelta(days=2)).strftime("%m/%d/%Y"), body)  # never the days taken

    def test_the_usual_shift_days_skip_weekends_and_days_with_a_shift(self):
        start = TODAY + timedelta(days=14)
        end = start + timedelta(days=6)                           # one full week
        self._leave(start, end)
        weekdays = [iso(start + timedelta(days=i)) for i in range(7) if (start + timedelta(days=i)).isoweekday() <= 5]
        db = database.SessionLocal()
        try:
            db.add(models.ScheduledShift(id="ss-1", employee_email=EMP, work_date=weekdays[0],
                                         start_hhmm="18:30", end_hhmm="02:30"))
            db.commit()
        finally:
            db.close()
        usual = self._cancel(MGR).json()["usual"]
        self.assertEqual((usual["shiftId"], usual["start"], usual["end"]), ("sh-usual", "18:30", "02:30"))
        self.assertEqual(usual["dates"], weekdays[1:])

    def test_who_may_cancel_and_what(self):
        start = TODAY + timedelta(days=5)
        self._leave(start, start)
        self.assertIn(self._cancel(EMP).status_code, (401, 403))   # not an approver; their own is My Time Off
        self.assertEqual(self._cancel(OTHER).status_code, 403)     # another team's manager
        self._leave(start, start, status="pending", rid="to-2")
        self.assertEqual(self._cancel(MGR, rid="to-2").status_code, 409)
        self._leave(TODAY - timedelta(days=5), TODAY - timedelta(days=3), rid="to-3")
        self.assertEqual(self._cancel(MGR, rid="to-3").status_code, 409)   # already over
        self.assertEqual(self._cancel(MGR).status_code, 200)
        self.assertEqual(self._cancel(MGR).status_code, 409)       # twice: already canceled
        self.assertEqual(len(self.sent), 1)


if __name__ == "__main__":
    unittest.main()
