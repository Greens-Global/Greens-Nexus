"""Pay period close alerts (Oct 19 2026, timesheet_alerts.py) and approver
notices that close for everyone once a request is decided.

  - after a period's last day each approver gets ONE priority notice listing
    the Time Sheets waiting on them; it is rewritten in place as sheets clear
    and resolved when none are left;
  - a sheet still unapproved `timesheetEscalateDays` (default 2) after the
    period goes to the approver's own manager; one approved but unsigned for
    UNSIGNED_WAIT_DAYS goes to the company's HR contact;
  - deciding a punch fix, a punch edit or a time-off request closes every
    approver's notice for it, not only the decider's.

Binds its own throwaway SQLite. Run ONE file per process:
    python -m pytest test_period_close_alerts.py -q
"""
import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

import database  # noqa: E402
import main  # noqa: E402,F401 - app import wires the DB
import models  # noqa: E402
import timesheet_alerts as ta  # noqa: E402
from routers import timeclock as tc  # noqa: E402

CO, CO2 = "pc-co", "pc-co-2"
A, B, C = "pc.ann@greensglobal.com", "pc.ben@greensglobal.com", "pc.cleo@greensglobal.com"
MGR, BOSS = "pc.max@greensglobal.com", "pc.boss@greensglobal.com"
HR_EMAIL, OWNER = "pc.charmi@greensglobal.com", "pc.owner@greensglobal.com"
ADMIN = {"email": "pc.admin@greensglobal.com", "level": 5, "role": "administrator"}
PS, PE = "2026-10-04", "2026-10-17"          # a bi-weekly period after REVIEW_LAUNCH
PDT = 420
_SEQ = [0]


def _at(y, mo, d, h=18):
    return datetime(y, mo, d, h, 0, tzinfo=timezone.utc)


def _p(db, em, kind, local):
    _SEQ[0] += 1
    at = (datetime.strptime(local, "%Y-%m-%dT%H:%M") + timedelta(minutes=PDT)).strftime("%Y-%m-%dT%H:%M:%S")
    db.add(models.TimePunch(id=f"pc-{_SEQ[0]:04d}", employee_email=em, kind=kind, at=at, local_date=local[:10],
                            tz_offset_min=PDT, voided=0, created_at=at, source="web", geo_status=""))


class PeriodCloseAlertTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        actual = database.engine.url.database or ""
        assert os.path.abspath(actual) == os.path.abspath(_tmp_db.name), actual
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except (FileNotFoundError, PermissionError):
            pass

    def setUp(self):
        self.db = db = database.SessionLocal()
        for m in (models.TimePunch, models.PayrollRate, models.TimeApproval, models.NexusNotification,
                  models.HrEntity, models.TimesheetReview, models.NexusRole, models.NexusSetting,
                  models.PunchRequest, models.TimeOffRequest):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        db.add(models.HrEntity(id=CO, name="Greens Storage", country="US", hr_contact_email=HR_EMAIL))
        db.add(models.HrEntity(id=CO2, name="No Approver Co", country="US"))
        people = ((A, CO, MGR, "Ann"), (B, CO, MGR, "Ben"), (C, CO2, "", "Cleo"), (MGR, CO, BOSS, "Max"),
                  (BOSS, CO, "", "Bea"), (HR_EMAIL, CO, "", "Charmi"), (OWNER, CO, "", "Olive"))
        for em, co, mgr, first in people:
            db.add(models.NexusEmployee(id=f"emp-{em}", first_name=first, last_name="Test", work_email=em,
                                        company=co, manager_email=mgr, status="active", deleted_at="",
                                        country="US"))
        db.add(models.NexusRole(email=OWNER, role="owner"))
        for em in (A, B, C):
            db.add(models.PayrollRate(employee_email=em, pay_type="hourly", hourly_rate=20.0,
                                      overtime_rule="federal", currency="USD"))
            _p(db, em, "in", "2026-10-05T08:00")
            _p(db, em, "out", "2026-10-05T16:00")
        db.commit()

    def tearDown(self):
        self.db.close()

    # ── helpers ──────────────────────────────────────────────────────────
    def _scan(self, now):
        return ta.scan(self.db, now_utc=now)

    def _bells(self, kind, recipient=None, open_only=True):
        q = self.db.query(models.NexusNotification).filter(models.NexusNotification.ref_id.like(f"{kind}:%"))
        if recipient:
            q = q.filter(models.NexusNotification.recipient == recipient)
        if open_only:
            q = q.filter(models.NexusNotification.actioned == False)  # noqa: E712
        return q.all()

    def _finalize(self, em):
        tc.finalize_timecard(tc.FinalizeIn(email=em, start=PS, end=PE, allow_exceptions=True), user=ADMIN, db=self.db)

    def _review(self, em, status, approved_at):
        r = models.TimesheetReview(id=str(uuid.uuid4()), employee_email=em, period_start=PS, period_end=PE,
                                   pay_type="hourly", status=status, manager_email=MGR, agreed_by=MGR,
                                   agreed_at=approved_at, created_at=approved_at, updated_at=approved_at,
                                   rounds=[{"at": approved_at, "by": MGR, "action": "approved"}],
                                   last_snapshot={})
        self.db.add(r)
        self.db.commit()
        return r

    # ── 1. period close ─────────────────────────────────────────────────
    def test_nothing_before_the_period_ends(self):
        self._scan(_at(2026, 10, 17, 12))
        self.assertEqual(self._bells(ta.CLOSE), [])

    def test_one_notice_per_approver_with_names_and_count(self):
        self._scan(_at(2026, 10, 19))
        mine = self._bells(ta.CLOSE, MGR)
        self.assertEqual(len(mine), 1)
        n = mine[0]
        self.assertEqual(n.ref_id, f"period-close:{MGR}:{PS}:{PE}")
        self.assertEqual(n.priority, 1)
        self.assertEqual(n.title, "Time Sheets to Approve")
        self.assertIn("The pay period 10/04/2026 - 10/17/2026 has closed. 2 time sheets are waiting", n.body)
        self.assertIn("Ann Test, Ben Test", n.body)
        self.assertEqual(json.loads(n.action), {"view": "hr", "sub": "hr-time"})
        self.assertNotIn("Cleo", n.body)
        # Nobody reviews Cleo: the Global Admins do.
        own = self._bells(ta.CLOSE, OWNER)
        self.assertEqual(len(own), 1)
        self.assertIn("1 time sheet is waiting on your approval: Cleo Test.", own[0].body)
        # A second pass changes nothing and writes nothing new.
        self.assertEqual(self._scan(_at(2026, 10, 19, 19)), {"opened": 0, "updated": 0, "resolved": 0})
        self.assertEqual(len(self._bells(ta.CLOSE, MGR, open_only=False)), 1)

    def test_updates_in_place_then_resolves(self):
        self._scan(_at(2026, 10, 19))
        n = self._bells(ta.CLOSE, MGR)[0]
        n.read_by = MGR
        self.db.commit()
        self._finalize(A)
        self._scan(_at(2026, 10, 19, 19))
        self.db.refresh(n)
        self.assertIn("1 time sheet is waiting on your approval: Ben Test.", n.body)
        self.assertEqual(n.read_by, MGR)               # a shrinking list is a quiet update
        self.assertFalse(n.actioned)
        # Ben's sheet approved (out for his signature): nothing left for Max.
        self._review(B, "signing", "2026-10-19T19:30:00+00:00")
        self.assertEqual(self._scan(_at(2026, 10, 19, 20))["resolved"], 1)
        self.db.refresh(n)
        self.assertTrue(n.actioned)
        self.assertEqual(n.priority, 0)
        self.assertEqual(n.title, "Time Sheets Approved")
        self.assertEqual(len(self._bells(ta.CLOSE, MGR, open_only=False)), 1)

    def test_a_new_name_brings_it_back_to_the_top(self):
        self._finalize(B)
        self._scan(_at(2026, 10, 19))
        n = self._bells(ta.CLOSE, MGR)[0]
        self.assertIn("Ann Test.", n.body)
        n.read_by = MGR
        self.db.commit()
        # Ben's period is unlocked by HR: his sheet waits on Max again.
        tc.unfinalize_timecard(tc.FinalizeIn(email=B, start=PS, end=PE), user=ADMIN, db=self.db)
        self._scan(_at(2026, 10, 19, 19))
        self.db.refresh(n)
        self.assertIn("2 time sheets", n.body)
        self.assertEqual(n.read_by, "")

    # ── 2. escalation ───────────────────────────────────────────────────
    def test_approval_stalled_goes_to_the_managers_manager(self):
        self._scan(_at(2026, 10, 19))
        self.assertEqual(self._bells(ta.STALLED), [])   # two days after the end: not yet
        self._scan(_at(2026, 10, 20))
        up = self._bells(ta.STALLED)
        self.assertEqual([b.recipient for b in up], [BOSS])
        self.assertEqual(up[0].title, "Time Sheet Approvals Overdue")
        self.assertIn("2 time sheets for 10/04/2026 - 10/17/2026 are still not approved more than 2 days", up[0].body)
        self.assertIn("Ann Test (waiting on Max Test)", up[0].body)
        self.assertEqual(up[0].priority, 1)
        # Cleo's approvers are the Global Admins - nobody above them.
        self.assertFalse(any("Cleo" in b.body for b in up))
        # Approved: the escalation closes too.
        self._finalize(A)
        self._finalize(B)
        self._scan(_at(2026, 10, 20, 19))
        self.assertEqual(self._bells(ta.STALLED), [])
        self.assertEqual(self._bells(ta.STALLED, open_only=False)[0].title, "Overdue Time Sheets Cleared")

    def test_no_managers_manager_means_hr(self):
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == MGR).update(
            {"manager_email": ""})
        self.db.commit()
        self._scan(_at(2026, 10, 20))
        self.assertEqual([b.recipient for b in self._bells(ta.STALLED)], [HR_EMAIL])

    def test_escalation_days_is_a_company_setting(self):
        self.db.add(models.NexusSetting(key=f"shift_requests_config:{CO}", value=json.dumps({"timesheetEscalateDays": 0})))
        self.db.commit()
        self._scan(_at(2026, 10, 27))
        self.assertEqual(self._bells(ta.STALLED), [])
        self.db.query(models.NexusSetting).update({"value": json.dumps({"timesheetEscalateDays": 5})})
        self.db.commit()
        self._scan(_at(2026, 10, 22))
        self.assertEqual(self._bells(ta.STALLED), [])
        self._scan(_at(2026, 10, 23))
        self.assertEqual(len(self._bells(ta.STALLED)), 1)

    def test_signature_stalled_goes_to_hr(self):
        r = self._review(A, "signing", "2026-10-18T12:00:00+00:00")
        self._scan(_at(2026, 10, 21, 11))                # 2 days 23 hours: not yet
        self.assertEqual(self._bells(ta.UNSIGNED), [])
        self._scan(_at(2026, 10, 21, 13))
        hr = self._bells(ta.UNSIGNED)
        self.assertEqual([b.recipient for b in hr], [HR_EMAIL])
        self.assertEqual(hr[0].title, "Time Sheets Waiting on Signatures")
        self.assertIn("1 time sheet for 10/04/2026 - 10/17/2026 was approved but not signed after 3 days: "
                      "Ann Test.", hr[0].body)
        self.assertIn("Finalize Without Employee Signature", hr[0].body)
        self.assertEqual(json.loads(hr[0].action)["sub"], "hr-time")
        # Ann's sheet is not on Max's approval list - it was approved.
        self.assertNotIn("Ann", self._bells(ta.CLOSE, MGR)[0].body)
        # Signed: closed.
        r.status = "completed"
        self.db.commit()
        self._scan(_at(2026, 10, 21, 14))
        self.assertEqual(self._bells(ta.UNSIGNED), [])

    def test_someone_who_left_is_listed_at_once(self):
        self._review(A, "approved", "2026-10-19T12:00:00+00:00")
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == A).update(
            {"status": "terminated"})
        self.db.commit()
        self._scan(_at(2026, 10, 19, 13))
        hr = self._bells(ta.UNSIGNED)
        self.assertEqual(len(hr), 1)
        self.assertIn("Ann Test (left the company)", hr[0].body)


class ApproverNoticesCloseTests(unittest.TestCase):
    """One approver deciding a request closes the notice for all of them."""

    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = db = database.SessionLocal()
        for m in (models.TimePunch, models.NexusNotification, models.PunchRequest, models.TimeOffRequest):
            db.query(m).delete(synchronize_session=False)
        db.query(models.NexusEmployee).execution_options(include_deleted=True).delete(synchronize_session=False)
        for em, mgr in ((A, MGR), (MGR, BOSS), (BOSS, "")):
            db.add(models.NexusEmployee(id=f"emp-{em}", first_name=em.split(".")[1].title(), last_name="Test",
                                        work_email=em, company="", manager_email=mgr, status="active",
                                        deleted_at=""))
        db.commit()

    def tearDown(self):
        self.db.close()

    def _notice(self, recipient, ref_id):
        self.db.add(models.NexusNotification(id=str(uuid.uuid4()), type="custom_alert", recipient=recipient,
                                             title="Waiting", body="", ref_id=ref_id, item_name="",
                                             requested_by=A, action="", actioned=False, read_by="",
                                             created_at="2026-10-12T10:00:00", priority=1))

    def _open(self, ref_id):
        return sorted(n.recipient for n in self.db.query(models.NexusNotification)
                      .filter(models.NexusNotification.ref_id == ref_id,
                              models.NexusNotification.actioned == False).all())  # noqa: E712

    def test_punch_request_decision(self):
        rid = str(uuid.uuid4())
        self.db.add(models.PunchRequest(id=rid, employee_email=A, action="add", punch_kind="in",
                                        at="2026-10-12T15:00:00", local_date="2026-10-12", reason="forgot",
                                        status="pending", created_at="2026-10-12T16:00:00"))
        for who in (MGR, BOSS, HR_EMAIL):
            self._notice(who, rid)
        self.db.commit()
        tc.decide_punch_request(rid, tc.PunchRequestDecision(status="rejected", note="no"), user=ADMIN, db=self.db)
        self.assertEqual(self._open(rid), [A])          # only the employee's own "rejected" notice

    def test_punch_edit_decision(self):
        pid = "pc-edit-1"
        self.db.add(models.TimePunch(id=pid, employee_email=A, kind="in", at="2026-10-12T15:00:00",
                                     local_date="2026-10-12", tz_offset_min=0, voided=0,
                                     created_at="2026-10-12T15:00:00", source="web", geo_status="",
                                     pending_at="2026-10-12T14:30:00", edit_status="pending"))
        for who in (MGR, BOSS):
            self._notice(who, pid)
        self.db.commit()
        tc.decide_punch_edit(pid, tc.PunchEditDecision(status="rejected", note=""), user=ADMIN, db=self.db)
        self.assertEqual(self._open(pid), [A])

    def test_time_off_decision_and_pending_cancel(self):
        rid, rid2 = str(uuid.uuid4()), str(uuid.uuid4())
        for x in (rid, rid2):
            self.db.add(models.TimeOffRequest(id=x, employee_email=A, type="vacation", start_date="2026-11-02",
                                              end_date="2026-11-02", status="pending",
                                              created_at="2026-10-12T16:00:00"))
            for who in (MGR, BOSS):
                self._notice(who, x)
        self.db.commit()
        tc.decide_timeoff(rid, tc.TimeOffDecision(status="rejected", note=""), user=ADMIN, db=self.db)
        self.assertEqual(self._open(rid), [A])
        tc.cancel_timeoff(rid2, user={"email": A, "level": 1, "role": "employee"}, db=self.db)
        self.assertEqual(self._open(rid2), [])


if __name__ == "__main__":
    unittest.main()
