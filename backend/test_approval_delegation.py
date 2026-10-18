"""
Approver delegation (Neil, Oct 17 2026): "Delegate My Approvals".

A manager names a stand-in for a date range. While it is live, the approvals
that route to the manager ALSO route to the stand-in - Time Sheet review,
punch fixes, punch edits, time off - for the manager's own people only.
On top of test_timesheet_review's real-engine fixture (same throwaway db):

  * the stand-in sees and can approve the delegator's items inside the range,
    and not outside it (future range, revoked);
  * they never see anyone else's (another manager's people, the delegator's
    own time sheet);
  * the logs say "by X for Y" (review round, approval log, decision notes,
    audit_logs);
  * no chains - the stand-in's own delegation does not pass the items on;
  * the stand-in gets the new item's notice; the timecard / payroll routes
    are NOT widened; validation refuses self, non-People, non-approvers,
    bad and overlapping ranges.

    python -m pytest -q test_approval_delegation.py
"""
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, ANCHOR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402

DEE = "dee.stand-in@greensglobal.com"      # the stand-in: a manager of nobody here
THIRD = "third.mgr@greensglobal.com"        # Dee's own stand-in (chain check)
DIRECT_D = "dee.report@greensglobal.com"    # Dee's own direct report
OTHER = "other.mgr.dg@greensglobal.com"     # an unrelated manager...
OTHER_EMP = "other.emp.dg@greensglobal.com"  # ...and their report
PLAIN = "plain.emp.dg@greensglobal.com"      # an employee-tier person


def _day(offset=0):
    return (datetime.now(timezone.utc).date() + timedelta(days=offset)).isoformat()


class DelegationCase(ReviewCase):
    def setUp(self):
        super().setUp()
        for m in (models.ApprovalDelegation, models.NexusNotification, models.PunchRequest,
                  models.TimeOffRequest, models.AuditLog):
            self.db.query(m).delete()
        people = [DEE, THIRD, DIRECT_D, OTHER, OTHER_EMP, PLAIN, MGR]
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_(people)).delete(synchronize_session=False)
        for em in (MGR, DEE, THIRD, OTHER):
            self.db.add(models.NexusRole(email=em, role="manager", assigned_by="test"))
        for em, first, mgr in ((DEE, "Dee", ""), (THIRD, "Thea", ""), (DIRECT_D, "Dario", DEE),
                               (OTHER, "Olive", ""), (OTHER_EMP, "Oscar", OTHER), (PLAIN, "Pia", MGR)):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first,
                                             last_name="Test", company=ENTITY, manager_email=mgr,
                                             status="active"))
        self.db.commit()
        auth._role_cache.clear()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth._role_cache.clear()
        super().tearDown()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _delegate(self, frm=MGR, to=DEE, start=None, end=None, status=200):
        self._as(frm)
        res = self.client.post("/approval-delegations/mine", json={
            "delegate_email": to, "start_date": start or _day(-1), "end_date": end or _day(5),
            "note": "On vacation"})
        self.assertEqual(res.status_code, status, res.text)
        return res.json()

    def _waiting(self, who=DEE):
        self._as(who)
        res = self.client.get("/timesheet-review/waiting")
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["reviews"]

    def _submit(self, email=EMP):
        return tsr.submit(self.db, email, ANCHOR, "All in")

    def _approve(self, rid, who=DEE):
        self._as(who)
        return self.client.post(f"/timesheet-review/{rid}/approve", json={"note": ""})


class ValidationTests(DelegationCase):
    def test_refused_inputs(self):
        self._delegate(to=MGR, status=422)                       # self
        self._delegate(to="nobody@greensglobal.com", status=422)  # not in Nexus People
        self._delegate(to=PLAIN, status=422)                     # cannot approve anything
        self._delegate(start=_day(3), end=_day(1), status=422)   # end before start
        self._delegate(start=_day(-9), end=_day(-2), status=422)  # already over
        self.assertEqual(self.db.query(models.ApprovalDelegation).count(), 0)

    def test_an_overlapping_range_is_refused_not_replaced(self):
        first = self._delegate()
        self._delegate(to=THIRD, start=_day(2), end=_day(9), status=409)
        self._delegate(to=THIRD, start=_day(6), end=_day(9))     # after the first one: fine
        self.db.expire_all()
        live = self.db.query(models.ApprovalDelegation).filter(models.ApprovalDelegation.id == first["id"]).one()
        self.assertEqual(live.revoked_at, "")

    def test_the_stand_in_is_told(self):
        self._delegate()
        n = self.db.query(models.NexusNotification).filter(models.NexusNotification.recipient == DEE).all()
        self.assertEqual([x.title for x in n], ["You Are Covering Approvals"])

    def test_mine_lists_both_sides(self):
        self._delegate()
        self._as(MGR)
        mine = self.client.get("/approval-delegations/mine").json()
        self.assertTrue(mine["canDelegate"])
        self.assertEqual([d["delegateEmail"] for d in mine["delegations"]], [DEE])
        self.assertEqual(mine["delegations"][0]["state"], "active")
        self._as(DEE)
        self.assertEqual([d["delegatorEmail"] for d in self.client.get("/approval-delegations/mine").json()["covering"]],
                         [MGR])

    def test_only_hr_sets_one_for_someone_else(self):
        self._as(DEE)
        res = self.client.post("/approval-delegations", json={
            "delegator_email": MGR, "delegate_email": THIRD, "start_date": _day(0), "end_date": _day(2)})
        self.assertEqual(res.status_code, 403)
        res = self.client.post("/approval-delegations/mine", json={
            "delegator_email": MGR, "delegate_email": THIRD, "start_date": _day(0), "end_date": _day(2)})
        self.assertEqual(res.status_code, 403)
        self.db.add(models.NexusRole(email=HR, role="administrator", assigned_by="test"))
        self.db.commit()
        auth._role_cache.clear()
        self._as(HR)
        res = self.client.post("/approval-delegations", json={
            "delegator_email": MGR, "delegate_email": DEE, "start_date": _day(0), "end_date": _day(2)})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["createdBy"], HR)
        self.assertEqual([d["id"] for d in self.client.get("/approval-delegations").json()], [res.json()["id"]])


class TimesheetRoutingTests(DelegationCase):
    def test_the_stand_in_sees_and_approves_within_the_range(self):
        r = self._submit()
        self.assertEqual(self._waiting(), [])                    # nothing before the delegation
        self._delegate()
        rows = self._waiting()
        self.assertEqual([x["employeeEmail"] for x in rows], [EMP])
        self.assertEqual((rows[0]["forEmail"], rows[0]["forName"]), (MGR, "Max Test"))
        res = self._approve(r.id)
        self.assertEqual(res.status_code, 200, res.text)
        r = self._r()
        self.assertEqual((r.status, r.agreed_by), ("signing", DEE))
        last = [e for e in r.rounds if e["action"] == "agreed"][-1]
        self.assertEqual((last["by"], last["for"]), (DEE, MGR))
        log = tsr.approval_log(self.db, r)
        self.assertTrue(log[0].startswith("Approved by Dee Test for Max Test (manager)"), log)
        audit = self.db.query(models.AuditLog).filter(models.AuditLog.user_email == DEE).all()
        self.assertTrue(any('"acting_for": "%s"' % MGR in (a.details or "") for a in audit), [a.details for a in audit])
        # The delegator keeps their own view.
        self.assertEqual(self.state_for_mgr(), "signing")

    def state_for_mgr(self):
        self._as(MGR)
        st = tsr.state_for(self.db, EMP, self.start, MGR, True)
        return st["status"]

    def test_send_back_is_logged_for_the_delegator_too(self):
        r = self._submit()
        self._delegate()
        self._as(DEE)
        res = self.client.post(f"/timesheet-review/{r.id}/send-back", json={"note": "Fix Monday"})
        self.assertEqual(res.status_code, 200, res.text)
        last = self._r().rounds[-1]
        self.assertEqual((last["action"], last["by"], last.get("for")), ("sent_back", DEE, MGR))

    def test_the_delegators_manager_reviewing_is_not_marked_for(self):
        r = self._submit()
        self.assertEqual(self._approve(r.id, who=MGR).status_code, 200)
        self.assertNotIn("for", [e for e in self._r().rounds if e["action"] == "agreed"][-1])

    def test_not_before_the_range(self):
        r = self._submit()
        self._delegate(start=_day(2), end=_day(6))
        self.assertEqual(self._waiting(), [])
        self.assertEqual(self._approve(r.id).status_code, 404)
        self.assertEqual(self._r().status, "with_manager")

    def test_revoke_stops_it(self):
        r = self._submit()
        d = self._delegate()
        self.assertEqual(len(self._waiting()), 1)
        self._as(DEE)
        self.assertEqual(self.client.post(f"/approval-delegations/{d['id']}/revoke").status_code, 404)  # not theirs
        self._as(MGR)
        res = self.client.post(f"/approval-delegations/{d['id']}/revoke")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["state"], "revoked")
        self.assertEqual(self._waiting(), [])
        self.assertEqual(self._approve(r.id).status_code, 404)

    def test_never_anyone_elses(self):
        self.db.add(models.TimePunch(id="po-in", employee_email=OTHER_EMP, kind="in", at=f"{self.start}T16:00:00",
                                     local_date=self.start, tz_offset_min=0, created_at=f"{self.start}T16:00:00"))
        self.db.add(models.TimePunch(id="po-out", employee_email=OTHER_EMP, kind="out", at=f"{self.start}T20:00:00",
                                     local_date=self.start, tz_offset_min=0, created_at=f"{self.start}T20:00:00"))
        self.db.commit()
        other = self._submit(OTHER_EMP)
        self._submit()
        self._delegate()
        self.assertEqual([x["employeeEmail"] for x in self._waiting()], [EMP])
        self.assertEqual(self._approve(other.id).status_code, 404)
        # ...and the delegator's own time sheet is not handed over either.
        self._as(DEE)
        res = self.client.post("/timesheet-review/approve", json={"email": MGR, "start": self.start})
        self.assertEqual(res.status_code, 404, res.text)

    def test_no_chain(self):
        r = self._submit()
        self._delegate()                                 # Max -> Dee
        self._delegate(frm=DEE, to=THIRD)                # Dee -> Thea
        self.assertEqual(self._waiting(who=THIRD), [])   # Thea does not get Max's people
        self.assertEqual(self._approve(r.id, who=THIRD).status_code, 404)
        import approval_delegation
        self.assertEqual(approval_delegation.delegated_people(self.db, THIRD), {DIRECT_D: DEE})

    def test_a_stand_in_who_can_no_longer_approve_gets_nothing(self):
        r = self._submit()
        self._delegate()
        self.db.query(models.NexusRole).filter(models.NexusRole.email == DEE).delete()
        self.db.commit()
        auth._role_cache.clear()
        self.assertEqual(self._waiting(), [])
        self.assertIn(self._approve(r.id).status_code, (401, 403))

    def test_a_delegator_who_can_no_longer_approve_hands_on_nothing(self):
        r = self._submit()
        self._delegate()
        self.db.query(models.NexusRole).filter(models.NexusRole.email == MGR).delete()
        self.db.commit()
        auth._role_cache.clear()
        self.assertEqual(self._waiting(), [])
        self.assertEqual(self._approve(r.id).status_code, 404)

    def test_a_backup_below_the_manager_tier_cannot_delegate(self):
        # Pia (employee tier) is set as Backup Manager for Erin: she has a
        # person, but no approve rights - so nothing to hand on.
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == EMP).update(
            {"backup_manager_email": PLAIN})
        self.db.commit()
        self._delegate(frm=PLAIN, to=DEE, status=409)

    def test_the_stand_in_hears_of_a_new_submission(self):
        self._delegate()
        self.db.query(models.NexusNotification).delete()
        self.db.commit()
        self._submit()
        n = {x.recipient: x for x in self.db.query(models.NexusNotification).all()}
        self.assertIn(MGR, n)
        self.assertIn(DEE, n)
        self.assertTrue(n[DEE].body.startswith("For Max Test:"), n[DEE].body)
        self.assertNotIn(OTHER, n)

    def test_payroll_and_timecards_are_not_widened(self):
        self._delegate()
        self._as(DEE)
        res = self.client.get(f"/timeclock/payroll?email={EMP}&start={self.start}&end={self.end}")
        self.assertIn(res.status_code, (401, 403, 404), res.text)
        res = self.client.get(f"/timeclock/team?start={self.start}&end={self.end}")
        if res.status_code == 200:
            emails = {row.get("email") for row in (res.json().get("rows") or [])}
            self.assertNotIn(EMP, emails)


class PunchAndTimeOffTests(DelegationCase):
    def _punch_request(self):
        at = (datetime.now(timezone.utc) - timedelta(days=1)).replace(hour=15, minute=0, second=0, microsecond=0)
        self._as(EMP)
        res = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "in", "at": at.strftime("%Y-%m-%dT%H:%M:%S"),
            "reason": "Forgot to clock in", "tz_offset_min": 0})
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["id"]

    def test_punch_fix_routes_to_the_stand_in_in_range_only(self):
        self._delegate()
        rid = self._punch_request()
        self.assertTrue(self.db.query(models.NexusNotification)
                        .filter(models.NexusNotification.recipient == DEE).filter(
                            models.NexusNotification.title == "Time Sheet Fix Requested").first())
        self._as(DEE)
        rows = self.client.get("/timeclock/punch-requests?status=pending").json()
        self.assertEqual([(x["id"], x.get("forEmail")) for x in rows], [(rid, MGR)])
        # An unrelated manager neither sees nor decides it.
        self._as(OTHER)
        self.assertEqual(self.client.get("/timeclock/punch-requests?status=pending").json(), [])
        self.assertEqual(self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "rejected"}).status_code, 403)
        self._as(DEE)
        res = self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "rejected", "note": "Not that day"})
        self.assertEqual(res.status_code, 200, res.text)
        self.db.expire_all()
        pr = self.db.query(models.PunchRequest).filter(models.PunchRequest.id == rid).one()
        self.assertEqual(pr.decided_by, DEE)
        self.assertIn("Decided by Dee Test for Max Test", pr.decision_note)

    def test_punch_fix_outside_the_range_is_refused(self):
        rid = self._punch_request()
        self._delegate(start=_day(3), end=_day(6))
        self._as(DEE)
        self.assertEqual(self.client.get("/timeclock/punch-requests?status=pending").json(), [])
        self.assertEqual(self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "rejected"}).status_code, 403)

    def _timeoff(self, confidential=False):
        self._as(EMP)
        res = self.client.post("/timeclock/timeoff", json={
            "type": "vacation", "start_date": _day(20), "end_date": _day(21), "note": "Trip",
            "confidential": confidential})
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["id"]

    def test_time_off_routes_to_the_stand_in(self):
        self._delegate()
        tid = self._timeoff(confidential=True)
        self.assertTrue(self.db.query(models.NexusNotification)
                        .filter(models.NexusNotification.recipient == DEE,
                                models.NexusNotification.title == "Time-Off Request").first())
        self._as(DEE)
        rows = [x for x in self.client.get("/timeclock/timeoff?status=pending").json() if x["id"] == tid]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["forEmail"], rows[0]["canDecide"], rows[0]["redacted"]), (MGR, True, False))
        res = self.client.patch(f"/timeclock/timeoff/{tid}", json={"status": "approved"})
        self.assertEqual(res.status_code, 200, res.text)
        self.db.expire_all()
        t = self.db.query(models.TimeOffRequest).filter(models.TimeOffRequest.id == tid).one()
        self.assertEqual((t.status, t.approver), ("approved", DEE))
        self.assertIn("Decided by Dee Test for Max Test", t.decide_note)

    def test_time_off_after_revoke_is_refused(self):
        d = self._delegate()
        tid = self._timeoff()
        self._as(MGR)
        self.client.post(f"/approval-delegations/{d['id']}/revoke")
        self._as(DEE)
        self.assertEqual(self.client.patch(f"/timeclock/timeoff/{tid}", json={"status": "approved"}).status_code, 403)

    def test_the_stand_in_sees_pending_not_the_whole_history(self):
        old = models.TimeOffRequest(id=str(uuid.uuid4()), employee_email=EMP, type="sick", start_date=_day(-30),
                                    end_date=_day(-30), status="approved", approver=MGR, created_at=_day(-31))
        self.db.add(old)
        self.db.commit()
        self._delegate()
        tid = self._timeoff()
        self._as(DEE)
        ids = {x["id"] for x in self.client.get("/timeclock/timeoff").json()}
        self.assertIn(tid, ids)
        self.assertNotIn(old.id, ids)


if __name__ == "__main__":
    unittest.main()
