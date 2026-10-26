"""
Time integrity (Oct 19 2026 audit).

1. Nobody approves or directly changes their own time. A manager's or
   administrator's team scope includes themself, so the older per-day
   Approve (POST /timeclock/approvals - counted as approved by the IIF
   export, past review and the employee's signature), Finalize, and the
   manager edit routes (POST/PATCH /timeclock/punches, Add Time and its
   undo) let them approve or edit their own card. Now 403; their own fixes
   go through a punch fix request like anyone's. One Global Admin may still
   approve another.

2. POST /timeclock/punch/manual took any punch up to 7 days back with no
   approval. It is now only the offline punch queue's replay: flagged
   offline_queue with its queued_at, at most 24 hours old, never in the
   future. Recorded as source=offline, and the manager hears about it in ONE
   notice per person per day that grows. Anything else is told to send a
   punch fix request.

    python -m pytest -q test_time_self_approval.py
"""
import unittest
from datetime import datetime, timedelta, timezone

from test_no_self_punch_approval import SelfDecisionCase, ADMIN, BOSS  # noqa: F401  (sets DATABASE_URL first)
from test_timesheet_review import EMP, MGR, ENTITY

import auth  # noqa: E402
import models  # noqa: E402

OWNER1 = "owner1.sa@greensglobal.com"
OWNER2 = "owner2.sa@greensglobal.com"
OWN_APPROVAL = "You can't approve your own time sheet - your manager or HR approves it."
OWN_EDIT = ("You can't change your own time sheet directly. Send a punch fix request from your "
            "Time Sheet and your manager or HR approves it.")


def _iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S")


class SelfTimeCase(SelfDecisionCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([OWNER1, OWNER2])).delete(
            synchronize_session=False)
        for em, first in ((OWNER1, "Oona"), (OWNER2, "Otto")):
            self.db.add(models.NexusRole(email=em, role="owner", assigned_by="test"))
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             company=ENTITY, manager_email="", status="active"))
        # A finished shift two days ago for each person who acts below.
        self.day = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
        for em in (MGR, ADMIN, OWNER2):
            self._own_punch(em, "in", "15:00:00")
            self._own_punch(em, "out", "20:00:00")
        self.db.commit()
        auth._role_cache.clear()

    def _own_punch(self, em, kind, hhmm):
        self.db.add(models.TimePunch(id=f"sa-{em}-{kind}", employee_email=em, kind=kind,
                                     at=f"{self.day}T{hhmm}", local_date=self.day, tz_offset_min=0,
                                     created_at=f"{self.day}T{hhmm}"))

    def _approvals(self, em):
        self.db.expire_all()
        return self.db.query(models.TimeApproval).filter(models.TimeApproval.employee_email == em).count()


class NoSelfApprovalTests(SelfTimeCase):
    def test_a_manager_cannot_approve_their_own_days(self):
        self._as(MGR)
        res = self.client.post("/timeclock/approvals", json={"email": MGR, "days": [self.day]})
        self.assertEqual(res.status_code, 403, res.text)
        self.assertEqual(res.json()["detail"], OWN_APPROVAL)
        res = self.client.post("/timeclock/approvals", json={"email": MGR.upper(), "start": self.day,
                                                             "end": self.day})
        self.assertEqual(res.status_code, 403, res.text)
        self.assertEqual(self._approvals(MGR), 0)

    def test_their_manager_still_approves_them(self):
        self._as(BOSS)
        res = self.client.post("/timeclock/approvals", json={"email": MGR, "days": [self.day]})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(self._approvals(MGR), 1)

    def test_a_manager_still_approves_their_report(self):
        self._as(MGR)
        res = self.client.post("/timeclock/approvals", json={"email": EMP, "days": [self.start]})
        self.assertEqual(res.status_code, 200, res.text)

    def test_an_administrator_cannot_approve_or_finalize_their_own(self):
        self._as(ADMIN)
        res = self.client.post("/timeclock/approvals", json={"email": ADMIN, "days": [self.day]})
        self.assertEqual(res.status_code, 403, res.text)
        res = self.client.post("/timeclock/finalize", json={"email": ADMIN, "start": self.day, "end": self.day})
        self.assertEqual(res.status_code, 403, res.text)
        self.assertEqual(self._approvals(ADMIN), 0)

    def test_one_global_admin_approves_another(self):
        # Nobody above them: another Global Admin decides, so nobody is stuck.
        self._as(OWNER1)
        res = self.client.post("/timeclock/approvals", json={"email": OWNER2, "days": [self.day]})
        self.assertEqual(res.status_code, 200, res.text)
        self._as(OWNER2)
        self.assertEqual(self.client.post("/timeclock/approvals",
                                          json={"email": OWNER2, "days": [self.day]}).status_code, 403)


class NoSelfEditTests(SelfTimeCase):
    def test_a_manager_cannot_add_a_punch_to_their_own_card(self):
        self._as(MGR)
        at = f"{self.day}T21:00:00"
        res = self.client.post("/timeclock/punches", json={"employee_email": MGR, "kind": "in", "at": at})
        self.assertEqual(res.status_code, 403, res.text)
        self.assertEqual(res.json()["detail"], OWN_EDIT)
        res = self.client.post("/timeclock/punches", json={"employee_email": EMP, "kind": "in",
                                                           "at": f"{self.day}T14:00:00", "note": "Forgot"})
        self.assertEqual(res.status_code, 200, res.text)

    def test_a_manager_cannot_add_a_punch_in_the_future(self):
        # A 5 PM clock-out added at 10 AM jammed the person's clock until 5 (Oct 26).
        self._as(MGR)
        later = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S")
        res = self.client.post("/timeclock/punches", json={"employee_email": EMP, "kind": "out", "at": later})
        self.assertEqual(res.status_code, 400, res.text)
        self.assertIn("future", res.json()["detail"])

    def test_a_manager_cannot_move_or_void_their_own_punch(self):
        self._as(MGR)
        for body in ({"at": f"{self.day}T14:00:00"}, {"void": True}, {"category": "Sick Day"}):
            res = self.client.patch(f"/timeclock/punches/sa-{MGR}-in", json=body)
            self.assertEqual(res.status_code, 403, res.text)
        self.db.expire_all()
        p = self.db.query(models.TimePunch).filter(models.TimePunch.id == f"sa-{MGR}-in").one()
        self.assertEqual((p.at, p.voided), (f"{self.day}T15:00:00", 0))
        # ...and their manager can.
        self._as(BOSS)
        res = self.client.patch(f"/timeclock/punches/sa-{MGR}-in", json={"at": f"{self.day}T14:30:00",
                                                                        "adjust_note": "Badge log"})
        self.assertEqual(res.status_code, 200, res.text)

    def test_a_manager_cannot_add_time_or_undo_it_on_their_own_card(self):
        self._as(MGR)
        d = (datetime.now(timezone.utc) - timedelta(days=4)).strftime("%Y-%m-%d")
        body = {"employee_email": MGR, "reason": "Worked offsite",
                "days": [{"date": d, "in_at": f"{d}T15:00:00", "out_at": f"{d}T20:00:00"}]}
        for dry in (True, False):
            res = self.client.post("/timeclock/add-time", json={**body, "dry_run": dry})
            self.assertEqual(res.status_code, 403, res.text)
        self.db.add(models.TimePunch(id="sa-batch", employee_email=MGR, kind="in", at=f"{d}T15:00:00",
                                     local_date=d, tz_offset_min=0, created_at=f"{d}T15:00:00",
                                     batch_id="b-self", source="manual"))
        self.db.commit()
        self.assertEqual(self.client.post("/timeclock/add-time/b-self/undo").status_code, 403)

    def test_hr_on_their_own_card_is_just_the_employee(self):
        self._as(ADMIN)
        res = self.client.patch(f"/timeclock/punches/sa-{ADMIN}-out", json={"at": f"{self.day}T21:00:00"})
        self.assertEqual(res.status_code, 403, res.text)
        # Their own fix goes the normal way: a punch fix request.
        res = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "break_start", "at": f"{self.day}T17:00:00",
            "reason": "Took lunch", "tz_offset_min": 0})
        self.assertEqual(res.status_code, 200, res.text)


class OfflinePunchTests(SelfTimeCase):
    def _offline(self, kind, at, queued=None, **extra):
        self._as(EMP)
        body = {"kind": kind, "at": _iso(at), "tz_offset_min": 0, "note": "Recorded offline",
                "offline_queue": True, "queued_at": _iso(queued or at + timedelta(seconds=5))}
        body.update(extra)
        return self.client.post("/timeclock/punch/manual", json=body)

    def _emp_punches(self):
        self.db.expire_all()
        return (self.db.query(models.TimePunch)
                .filter(models.TimePunch.employee_email == EMP, models.TimePunch.local_date > self.end).all())

    def test_a_queued_punch_from_today_lands_flagged_offline_and_tells_the_manager_once(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        res = self._offline("in", now - timedelta(hours=3))
        self.assertEqual(res.status_code, 200, res.text)
        res = self._offline("out", now - timedelta(hours=2))
        self.assertEqual(res.status_code, 200, res.text)
        rows = self._emp_punches()
        self.assertEqual(sorted(p.kind for p in rows), ["in", "out"])
        self.assertTrue(all(p.source == "offline" and p.geo_status == "no_location" for p in rows))
        notes = (self.db.query(models.NexusNotification)
                 .filter(models.NexusNotification.recipient == MGR,
                         models.NexusNotification.title == "Offline Punch Recorded - Erin Test").all())
        if len({p.local_date for p in rows}) == 1:
            self.assertEqual(len(notes), 1)            # one notice, grown in place
            self.assertIn("clock-out", notes[0].body)
            self.assertIn("clock-in", notes[0].body)
        else:                                         # the two punches straddle UTC midnight
            self.assertEqual(len(notes), 2)
        self.assertFalse(self.db.query(models.NexusNotification).filter(
            models.NexusNotification.recipient == EMP,
            models.NexusNotification.title.like("Offline Punch%")).count())

    def test_without_the_queue_flag_it_is_a_punch_fix_request(self):
        at = datetime.now(timezone.utc) - timedelta(hours=1)
        res = self._offline("in", at, offline_queue=False)
        self.assertEqual(res.status_code, 400, res.text)
        self.assertEqual(res.json()["detail"]["code"], "use_punch_request")
        self.assertIn("punch fix request", res.json()["detail"]["message"])
        self.assertEqual(self._emp_punches(), [])

    def test_older_than_a_day_is_a_punch_fix_request(self):
        at = datetime.now(timezone.utc) - timedelta(hours=25)
        res = self._offline("in", at)
        self.assertEqual(res.status_code, 400, res.text)
        self.assertEqual(res.json()["detail"]["code"], "use_punch_request")
        self.assertIn("24 hours", res.json()["detail"]["message"])
        self.assertEqual(self._emp_punches(), [])

    def test_never_in_the_future(self):
        at = datetime.now(timezone.utc) + timedelta(minutes=10)
        res = self._offline("in", at, queued=at)
        self.assertEqual(res.status_code, 400, res.text)
        self.assertEqual(self._emp_punches(), [])

    def test_a_punch_the_queue_did_not_park_at_the_time_is_refused(self):
        now = datetime.now(timezone.utc)
        at = now - timedelta(hours=5)
        for queued in (now, at - timedelta(minutes=10)):    # parked hours later, or before it was made
            res = self._offline("in", at, queued=queued)
            self.assertEqual(res.status_code, 400, res.text)
            self.assertEqual(res.json()["detail"]["code"], "use_punch_request")
        res = self._offline("in", at, queued_at="")
        self.assertEqual(res.status_code, 400, res.text)
        self.assertEqual(self._emp_punches(), [])


OWN_PAY = "You can't change your own pay - another administrator or HR sets it."


class NoSelfPayTests(SelfTimeCase):
    """Oct 20: nobody sets their own pay rate - PUT /timeclock/payroll/rate,
    Pay & Benefits (PUT /hr/employees/{eid}/compensation) - unless nobody
    else could ever set it (the sole-owner dead end)."""

    def _rate(self, em):
        self.db.expire_all()
        r = self.db.query(models.PayrollRate).filter(models.PayrollRate.employee_email == em).first()
        return float(r.hourly_rate or 0) if r else None

    def _comp(self, eid, base, bank=None):
        body = {"compensation": {"base": str(base), "payBasis": "hourly", "frequency": "biweekly",
                                 "currency": "USD", "effectiveDate": ""}}
        if bank is not None:
            body["bank"] = bank
        return self.client.put(f"/hr/employees/{eid}/compensation", json=body)

    def test_an_administrator_cannot_set_their_own_rate(self):
        self._as(ADMIN)
        res = self.client.put("/timeclock/payroll/rate", json={"email": ADMIN.upper(), "hourly_rate": 99})
        self.assertEqual(res.status_code, 403, res.text)
        self.assertEqual(res.json()["detail"], OWN_PAY)
        self.assertIsNone(self._rate(ADMIN))
        res = self.client.put("/timeclock/payroll/rate", json={"email": EMP, "hourly_rate": 25})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(self._rate(EMP), 25.0)

    def test_one_global_admin_sets_another_but_not_their_own(self):
        self._as(OWNER1)
        self.assertEqual(self.client.put("/timeclock/payroll/rate",
                                         json={"email": OWNER2, "hourly_rate": 40}).status_code, 200)
        self.assertEqual(self._rate(OWNER2), 40.0)
        self._as(OWNER2)
        self.assertEqual(self.client.put("/timeclock/payroll/rate",
                                         json={"email": OWNER2, "hourly_rate": 400}).status_code, 403)
        self.assertEqual(self._rate(OWNER2), 40.0)

    def test_pay_and_benefits_refuses_your_own_pay_but_not_your_bank(self):
        self._as(OWNER1)
        res = self._comp("id-Oona", 50)
        self.assertEqual(res.status_code, 403, res.text)
        self.assertEqual(res.json()["detail"], OWN_PAY)
        got = self.client.get("/hr/employees/id-Oona/compensation").json()
        self.assertTrue(got["ownPayLocked"])
        # Saving the record unchanged with a new bank account goes through.
        same = dict(got["compensation"])
        bank = [{"holder": "Oona Test", "bankName": "First", "number": "123", "routingOrIfsc": "9", "type": "checking"}]
        res = self.client.put("/hr/employees/id-Oona/compensation", json={"compensation": same, "bank": bank})
        self.assertEqual(res.status_code, 200, res.text)
        # ...and another owner's pay is theirs to set.
        self.assertEqual(self._comp("id-Otto", 45).status_code, 200)
        self.assertFalse(self.client.get("/hr/employees/id-Otto/compensation").json()["ownPayLocked"])
        self.assertEqual(self._rate(OWNER2), 45.0)

    def test_the_only_person_who_can_set_pay_is_not_stuck(self):
        # Nobody else is an administrator, an owner or holds a pay grant: the
        # owner's own rate would otherwise never be settable.
        self.db.query(models.NexusRole).filter(models.NexusRole.email != OWNER1,
                                               models.NexusRole.role.in_(["administrator", "owner"])).delete(
            synchronize_session=False)
        self.db.query(models.NexusGroupMember).filter(models.NexusGroupMember.email != OWNER1).delete(
            synchronize_session=False)
        self.db.commit()
        auth._role_cache.clear()
        self._as(OWNER1)
        self.assertEqual(self.client.put("/timeclock/payroll/rate",
                                         json={"email": OWNER1, "hourly_rate": 60}).status_code, 200)
        self.assertEqual(self._rate(OWNER1), 60.0)
        self.assertFalse(self.client.get("/hr/employees/id-Oona/compensation").json()["ownPayLocked"])
        self.assertEqual(self._comp("id-Oona", 61).status_code, 200)

    def test_someone_who_left_does_not_count_as_another_setter(self):
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([ADMIN])).delete(
            synchronize_session=False)
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == OWNER2).update(
            {"status": "offboarded"})
        self.db.query(models.NexusGroupMember).filter(models.NexusGroupMember.email != OWNER1).delete(
            synchronize_session=False)
        self.db.commit()
        auth._role_cache.clear()
        self._as(OWNER1)
        self.assertEqual(self._comp("id-Oona", 70).status_code, 200)


if __name__ == "__main__":
    unittest.main()
