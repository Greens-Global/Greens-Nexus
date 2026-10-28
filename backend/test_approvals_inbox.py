"""Approvals (Oct 27 2026) - approvals_inbox.py and GET /approvals/inbox.

  * the registry merges every source into one list, oldest waiting first,
    with per-source and per-chip counts - and the sidebar counts
    (/me/action-counts) read the same numbers;
  * one failing source is reported quietly and never blanks the others; a
    source the caller has no access to is not an error;
  * a live approver delegation brings the delegator's people's items to the
    stand-in, marked "For <delegator>";
  * a person never sees another approver's items (time off, reimbursements,
    purchase requests), nor their own;
  * reimbursements follow decide()'s gates; hiring votes drop off once voted;
  * HR's sources (Oct 27 2026): time off awaiting HR's second approval (once,
    never the manager's again), salary advances to decide or pay out,
    probation recommendations and overdue decisions, HR letter requests and
    each headcount step - and the nav tabs that carry them.

    python -m pytest -q test_approvals_inbox.py
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ.setdefault("NEXUS_SKIP_AUTH", "true")

from fastapi.testclient import TestClient  # noqa: E402

import approvals_inbox  # noqa: E402
import auth  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

EMP, MGR, MATE = "erin.ai@greensglobal.com", "max.ai@greensglobal.com", "mia.ai@greensglobal.com"
MGR2, EMP2 = "nora.ai@greensglobal.com", "ned.ai@greensglobal.com"   # another manager and their report
DEE = "dee.ai@greensglobal.com"                                      # a stand-in manager of nobody
HRC = "hana.ai@greensglobal.com"                                     # the company's HR contact
ENTITY = "ent-ai"
SOON = (date.today() + timedelta(days=3)).isoformat()
TODAY = date.today().isoformat()


class InboxCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert os.path.abspath(database.engine.url.database or "") == os.path.abspath(_tmp_db.name)
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
        self.db = database.SessionLocal()
        for m in (models.NexusEmployee, models.NexusRole, models.TimeOffRequest, models.ShiftRequest,
                  models.ExpenseReimbursement, models.Requisition, models.NexusNotification, models.PunchRequest,
                  models.ApprovalDelegation, models.HrCandidate, models.HrStageEvent, models.HrInterview,
                  models.Task, models.TimesheetReview, models.HrEntity,
                  models.SalaryAdvance, models.HrLetterRequest, models.HrHeadcountRequest, models.ExtraTimeClaim):
            self.db.query(m).delete()
        self.db.add(models.HrEntity(id=ENTITY, name="Greens Test", hr_contact_email=HRC))
        for em, first, mgr in ((EMP, "Erin", MGR), (MGR, "Max", ""), (MATE, "Mia", MGR),
                               (MGR2, "Nora", ""), (EMP2, "Ned", MGR2), (DEE, "Dee", ""), (HRC, "Hana", "")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             manager_email=mgr, status="active", company=ENTITY))
        for em in (MGR, MGR2, DEE):
            self.db.add(models.NexusRole(email=em, role="manager", assigned_by="test"))
        self.db.commit()
        auth._role_cache.clear()

    def tearDown(self):
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        auth._role_cache.clear()
        auth.SKIP_AUTH = self._skip
        self.db.close()

    def _as(self, who):
        os.environ["NEXUS_DEV_EMAIL"] = who
        auth._role_cache.clear()

    def _inbox(self, who):
        self._as(who)
        res = self.client.get("/approvals/inbox")
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()

    def _counts(self, who):
        self._as(who)
        res = self.client.get("/me/action-counts")
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["counts"]

    def _time_off(self, rid, who, created="2026-10-10T08:00:00+00:00"):
        self.db.add(models.TimeOffRequest(id=rid, employee_email=who, type="vacation", start_date=SOON,
                                          end_date=(date.today() + timedelta(days=5)).isoformat(),
                                          status="pending", created_at=created))

    def _claim(self, rid, who, approver, status="submitted", receipts=None, created="2026-10-12T08:00:00+00:00"):
        self.db.add(models.ExpenseReimbursement(
            id=rid, employee_email=who, employee_name=who.split(".")[0].title(), company=ENTITY, item="Monitor",
            amount=142.5, currency="USD", approver_email=approver, status=status, receipts=receipts or [],
            history=[{"at": created, "by": who, "action": "submitted", "note": ""}], created_at=created,
            approved_by=approver if status == "approver_approved" else "",
            approved_at="2026-10-13T08:00:00+00:00" if status == "approver_approved" else ""))

    # ── The registry ────────────────────────────────────────────────────────

    def test_sources_merge_oldest_first_and_counts_agree_with_the_nav(self):
        self._time_off("t1", EMP, created="2026-10-10T08:00:00+00:00")
        self._claim("r1", MATE, MGR, created="2026-10-08T08:00:00+00:00")
        self.db.add(models.PunchRequest(id="p1", employee_email=EMP, employee_name="Erin Test", action="add",
                                        punch_kind="out", at="2026-10-24T01:15:00", local_date="2026-10-23",
                                        reason="Forgot", status="pending", created_at="2026-10-24T09:00:00"))
        # ...and the same fix asked twice: one decision, one row.
        self.db.add(models.PunchRequest(id="p2", employee_email=EMP, employee_name="Erin Test", action="add",
                                        punch_kind="out", at="2026-10-24T01:15:30", local_date="2026-10-23",
                                        reason="Forgot again", status="pending", created_at="2026-10-24T09:05:00"))
        self.db.commit()
        out = self._inbox(MGR)
        self.assertEqual(out["errors"], [])
        kinds = [r["kind"] for r in out["rows"]]
        self.assertEqual(kinds, ["reimbursement", "time_off", "punch_fix"])     # oldest waiting first
        self.assertEqual(out["counts"]["time_off"], 1)
        self.assertEqual(out["counts"]["punch_fix"], 1)
        self.assertEqual(out["groups"], {"money": 1, "timeoff": 1, "timesheets": 1})
        self.assertEqual(out["total"], 3)
        to = next(r for r in out["rows"] if r["kind"] == "time_off")
        self.assertEqual(to["person"]["name"], "Erin Test")
        self.assertTrue(to["title"].startswith("Time Off - "))
        self.assertIn(" to ", to["title"])
        self.assertIn("(3 days)", to["title"])
        self.assertEqual([a["key"] for a in to["actions"]], ["approve", "reject"])
        claim = next(r for r in out["rows"] if r["kind"] == "reimbursement")
        self.assertEqual(claim["title"], "Reimbursement - $142.50")
        self.assertEqual([a["note"] for a in claim["actions"]], ["none", "required"])   # Send Back needs a reason
        # The nav reads the same registry: Team > Requests and People > Time
        # carry the time off, People > Time the punch fix; Approvals the total.
        nav = self._counts(MGR)
        self.assertEqual(nav["shifts"]["requests"], 1)
        self.assertEqual(nav["hr"]["hr-time"], 2)
        self.assertEqual(nav["approvals"]["inbox"], 3)

    def test_a_failing_source_is_isolated(self):
        self._time_off("t1", EMP)
        self.db.commit()
        real = {s.key: s.fn for s in approvals_inbox.SOURCES}

        def boom(db, user, ctx):
            raise RuntimeError("the reimbursements table is gone")

        def no_access(db, user, ctx):
            from fastapi import HTTPException
            raise HTTPException(403, "no")

        try:
            for s in approvals_inbox.SOURCES:
                if s.key == "reimbursement":
                    s.fn = boom
                if s.key == "purchase_request":
                    s.fn = no_access
            out = self._inbox(MGR)
            self.assertEqual(out["errors"], [{"source": "reimbursement", "label": "Reimbursements"}])
            self.assertEqual([r["kind"] for r in out["rows"]], ["time_off"])   # the rest still show
            self.assertEqual(self._counts(MGR)["shifts"]["requests"], 1)       # and the nav still counts
        finally:
            for s in approvals_inbox.SOURCES:
                s.fn = real[s.key]

    def test_an_unknown_group_is_refused(self):
        with self.assertRaises(ValueError):
            approvals_inbox.source("x", "X", "nowhere")

    # ── Who sees what ───────────────────────────────────────────────────────

    def test_nobody_sees_another_approvers_items_or_their_own(self):
        self._time_off("t1", EMP)          # waits on Max
        self._time_off("t2", EMP2)         # waits on Nora
        self._time_off("t3", MGR)          # Max's own: never Max's to decide
        self._claim("r1", EMP, MGR)        # Max is the approver
        self._claim("r2", EMP2, MGR2)      # Nora is
        # Purchase requests: one sent to Max, one to Nora, one broadcast.
        for rid, to in (("q1", MGR), ("q2", MGR2), ("q3", "")):
            self.db.add(models.Requisition(id=rid, employee_name="Erin", employee_email=EMP, employee_dept="Ops",
                                           item="Chair", status="pending_manager", company_id=ENTITY,
                                           created_at="2026-10-11T08:00:00", updated_at="2026-10-11T08:00:00"))
            self.db.add(models.NexusNotification(id=f"n-{rid}", type="req_pending", recipient=to, title="New",
                                                 body="", ref_id=rid, actioned=False, read_by="",
                                                 created_at="2026-10-11T08:00:00"))
        self.db.commit()
        mine = {r["key"] for r in self._inbox(MGR)["rows"]}
        self.assertEqual(mine, {"time_off:t1", "reimbursement:r1", "purchase_request:q1", "purchase_request:q3"})
        nora = {r["key"] for r in self._inbox(MGR2)["rows"]}
        self.assertEqual(nora, {"time_off:t2", "reimbursement:r2", "purchase_request:q2", "purchase_request:q3"})
        # An employee approves nothing here, and the requester never sees
        # their own request (even the broadcast one).
        out = self._inbox(EMP)
        self.assertEqual(out["rows"], [])
        self.assertEqual(out["errors"], [])
        self.assertEqual(out["total"], 0)

    def test_a_delegation_brings_the_delegators_people_to_the_stand_in(self):
        self._time_off("t1", EMP)            # Max's report
        self._time_off("t2", EMP2)           # Nora's - not delegated
        self.db.add(models.ApprovalDelegation(id="d1", delegator_email=MGR, delegate_email=DEE,
                                              start_date=(date.today() - timedelta(days=1)).isoformat(),
                                              end_date=(date.today() + timedelta(days=5)).isoformat(),
                                              created_by=MGR, created_at=TODAY, revoked_at=""))
        self.db.commit()
        rows = self._inbox(DEE)["rows"]
        self.assertEqual([r["key"] for r in rows], ["time_off:t1"])
        self.assertEqual(rows[0]["forName"], "Max Test")
        # Max keeps his own approvals.
        self.assertIn("time_off:t1", {r["key"] for r in self._inbox(MGR)["rows"]})
        # Revoked: the stand-in has nothing.
        self.db.query(models.ApprovalDelegation).update({"revoked_at": TODAY})
        self.db.commit()
        self.assertEqual(self._inbox(DEE)["rows"], [])

    # ── Module rules ────────────────────────────────────────────────────────

    def test_reimbursements_follow_the_decide_gates(self):
        self._claim("r1", EMP, MGR, status="approver_approved")                         # no receipt yet
        self._claim("r2", MATE, MGR, status="approver_approved", receipts=[{"path": "x", "name": "r.pdf"}])
        self._claim("r3", EMP, MGR, status="sent_back")                                 # with the employee
        self.db.commit()
        # HR (the company's HR contact) decides the one with its receipt; the
        # approver, whose step is done, has nothing.
        self.assertEqual([r["key"] for r in self._inbox(HRC)["rows"]], ["reimbursement:r2"])
        self.assertEqual(self._inbox(MGR)["rows"], [])
        row = self._inbox(HRC)["rows"][0]
        self.assertEqual(row["title"], "Reimbursement - $142.50 (1 receipt)")
        self.assertIn("with HR", row["detail"])

    def test_time_sheet_reviews_are_one_row_per_period(self):
        import timesheet_review as tsr
        start, end, pay = tsr.period_for(self.db, EMP, "2026-10-12")
        for rid, who in (("v1", EMP), ("v2", MATE)):
            self.db.add(models.TimesheetReview(id=rid, employee_email=who, period_start=start, pay_type=pay,
                                               period_end=end, status="with_manager", manager_email=MGR,
                                               updated_at="2026-10-26T08:00:00+00:00"))
        self.db.add(models.PunchRequest(id="p1", employee_email=EMP, employee_name="Erin Test", action="add",
                                        punch_kind="out", at="2026-10-24T01:15:00", local_date="2026-10-23",
                                        reason="Forgot", status="pending", created_at="2026-10-24T09:00:00"))
        self.db.commit()
        out = self._inbox(MGR)
        rev = next(r for r in out["rows"] if r["kind"] == "timesheet_review")
        self.assertEqual(rev["count"], 2)
        self.assertEqual(rev["title"], f"Time Sheet Review - {tsr.us_date(start)} to {tsr.us_date(end)} (2 people)")
        self.assertEqual([a["key"] for a in rev["actions"]], ["open"])
        self.assertEqual(rev["link"], {"view": "hr", "sub": "hr-time"})
        fix = next(r for r in out["rows"] if r["kind"] == "punch_fix")
        self.assertTrue(fix["title"].startswith("Punch Fix - 10/23/2026 Clock-Out "), fix["title"])
        self.assertEqual(fix["link"]["punchRequestId"], "p1")
        self.assertEqual(out["counts"]["timesheet_review"], 2)
        self.assertEqual(out["groups"]["timesheets"], 3)
        self.assertEqual(self._counts(MGR)["hr"]["hr-time"], 3)   # 2 reviews + the punch fix
        self.assertEqual(self._counts(MGR)["approvals"]["inbox"], 3)

    def test_a_shift_swap_waits_on_the_teammate(self):
        self.db.add(models.ShiftRequest(id="s1", kind="swap", requester_email=MATE, target_email=EMP,
                                        status="pending_peer", shift_date=SOON, shift_start="09:00", shift_end="17:00",
                                        target_date=SOON, target_start="12:00", target_end="20:00",
                                        created_at="2026-10-20T08:00:00+00:00"))
        self.db.add(models.ShiftRequest(id="s2", kind="swap", requester_email=MATE, target_email=EMP,
                                        status="pending_peer", shift_date="2020-01-01"))   # past: nothing to do
        self.db.commit()
        rows = self._inbox(EMP)["rows"]
        self.assertEqual([r["key"] for r in rows], ["shift_peer:s1"])
        self.assertEqual([a["key"] for a in rows[0]["actions"]], ["accept", "decline"])
        self.assertIn("for your", rows[0]["title"])
        self.assertEqual(self._counts(EMP)["myhr"]["timeoff"], 1)
        self.assertEqual(self._inbox(MATE)["rows"], [])

    def test_a_hiring_vote_waits_until_the_person_votes(self):
        self.db.add(models.HrCandidate(id="c1", first_name="Jordan", last_name="Lee", role_title="Sr. Tech",
                                       stage="decision", company=ENTITY, decision="", decision_task_id="task-1",
                                       created_at="2026-10-01T08:00:00+00:00"))
        self.db.add(models.HrStageEvent(id="e0", candidate_id="c1", from_stage="interview", to_stage="decision",
                                        note="Interview over", by_email=HRC, created_at="2026-10-20T08:00:00+00:00"))
        self.db.add(models.Task(id="task-1", code="T-1", title="Decide on Jordan Lee - Sr. Tech", type="task",
                                status="not_started", assignee_email=MGR, assignee_emails=[MGR, MATE],
                                completed=False, created_at="2026-10-20T08:00:00+00:00",
                                modified_at="2026-10-20T08:00:00+00:00"))
        self.db.commit()
        rows = self._inbox(MGR)["rows"]
        self.assertEqual([r["kind"] for r in rows], ["hiring_vote"])
        self.assertEqual(rows[0]["title"], "Hiring Vote - Jordan Lee")
        self.assertEqual([(a["key"], a["note"]) for a in rows[0]["actions"]], [("yes", "required"), ("no", "required")])
        self.assertEqual(rows[0]["link"], {"view": "tasks", "sub": "mine", "taskId": "task-1"})
        # Max says yes: his row is gone, Mia (still to answer) keeps hers.
        self.db.add(models.HrStageEvent(id="e1", candidate_id="c1", from_stage="decision", to_stage="decision",
                                        note="Yes - strong", by_email=MGR, kind="vote",
                                        created_at="2026-10-21T08:00:00+00:00"))
        self.db.commit()
        self.assertEqual(self._inbox(MGR)["rows"], [])
        self.assertEqual([r["kind"] for r in self._inbox(MATE)["rows"]], ["hiring_vote"])
        # Someone not on the task never sees it.
        self.assertEqual(self._inbox(EMP)["rows"], [])

    # ── HR's sources (Oct 27 2026) ──────────────────────────────────────────

    def test_time_off_awaiting_hr_is_hrs_once(self):
        # Max approved Erin's first level; it waits for the HR contact now.
        self._time_off("t1", EMP)
        self.db.flush()                     # the session does not autoflush
        self.db.query(models.TimeOffRequest).filter_by(id="t1").update(
            {"approval_stage": "hr", "first_approver": MGR, "first_decided_at": "2026-10-20T08:00:00+00:00"})
        self.db.commit()
        hr = self._inbox(HRC)
        self.assertEqual([r["key"] for r in hr["rows"]], ["time_off_hr:t1"])
        row = hr["rows"][0]
        self.assertEqual([a["key"] for a in row["actions"]], ["approve", "reject"])
        self.assertIn("approved by Max Test, waiting for HR", row["detail"])
        self.assertEqual(row["link"], {"view": "hr", "sub": "hr-time-off"})
        self.assertEqual(row["createdAt"][:10], "2026-10-20")   # HR's wait starts at the manager's yes
        self.assertEqual(self._counts(HRC)["hr"]["hr-time"], 1)
        # The manager's level is done: nothing on Max's list, and no double count.
        self.assertEqual(self._inbox(MGR)["rows"], [])
        self.assertNotIn("shifts", self._counts(MGR))

    def test_salary_advances_wait_on_hr(self):
        for aid, status in (("a1", "requested"), ("a2", "approved"), ("a3", "paid_out")):
            self.db.add(models.SalaryAdvance(
                id=aid, employee_email=MGR, employee_name="Max Test", company=ENTITY, amount=1200.0,
                currency="USD", reason="Car repair", installments=3, status=status, requested_by=MGR,
                requested_at="2026-10-21T08:00:00+00:00", decided_by=HRC if status != "requested" else "",
                decided_at="2026-10-22T08:00:00+00:00" if status != "requested" else "",
                created_at="2026-10-21T08:00:00+00:00"))
        self.db.commit()
        # An advance is pay (release review, Oct 27 2026): the HR contact
        # without the pay grant has nothing to decide - no row, no amount.
        import cache
        cache.module_grants.invalidate()
        self.assertEqual([r["key"] for r in self._inbox(HRC)["rows"] if r["key"].startswith("salary")], [])
        self.db.query(models.NexusGroupMember).filter_by(group_id="g-ai-pay").delete()
        self.db.query(models.NexusGroup).filter_by(id="g-ai-pay").delete()
        self.db.add(models.NexusGroup(id="g-ai-pay", name="Payroll", allowed_modules="hr_comp:editor"))
        self.db.add(models.NexusGroupMember(group_id="g-ai-pay", email=HRC))
        self.db.commit()
        cache.module_grants.invalidate()

        def _drop_grant():
            db = database.SessionLocal()
            db.query(models.NexusGroupMember).filter_by(group_id="g-ai-pay").delete()
            db.query(models.NexusGroup).filter_by(id="g-ai-pay").delete()
            db.commit()
            db.close()
            cache.module_grants.invalidate()
        self.addCleanup(_drop_grant)
        out = self._inbox(HRC)
        rows = {r["key"]: r for r in out["rows"]}
        self.assertEqual(set(rows), {"salary_advance:a1", "salary_advance_payout:a2"})
        self.assertEqual(rows["salary_advance:a1"]["title"], "Salary Advance - $1,200.00 (3 pay periods)")
        self.assertEqual([(a["key"], a["note"]) for a in rows["salary_advance:a1"]["actions"]],
                         [("approve", "none"), ("decline", "required")])
        self.assertEqual([a["key"] for a in rows["salary_advance_payout:a2"]["actions"]], ["open"])
        self.assertEqual(out["groups"], {"money": 2})
        self.assertEqual(self._counts(HRC)["myhr"]["overview"], 2)
        # Not HR, and never their own.
        self.assertEqual(self._inbox(MGR)["rows"], [])
        self.assertEqual(self._inbox(EMP)["rows"], [])

    def test_probation_recommendations_and_overdue_decisions_wait_on_hr(self):
        past = (date.today() - timedelta(days=2)).isoformat()
        later = (date.today() + timedelta(days=20)).isoformat()
        recs = {
            "id-Erin": {"status": "in_probation", "startDate": "2026-05-01", "endDate": later,
                        "pending": {"decision": "confirm", "newEndDate": "", "reason": "Strong start", "by": MGR,
                                    "at": "2026-10-25T08:00:00+00:00"}},
            "id-Mia": {"status": "in_probation", "startDate": "2026-04-01", "endDate": past},
            "id-Ned": {"status": "extended", "startDate": "2026-04-01", "endDate": later,
                       "pending": {"decision": "end", "reason": "Missed targets", "by": MGR2, "at": "2026-10-24T08:00:00+00:00"}},
            "id-Dee": {"status": "confirmed", "startDate": "2026-01-01", "endDate": past},   # decided: nothing
        }
        for eid, rec in recs.items():
            self.db.query(models.NexusEmployee).filter_by(id=eid).update({"probation": rec})
        self.db.commit()
        out = self._inbox(HRC)
        rows = {r["key"]: r for r in out["rows"]}
        self.assertEqual(set(rows), {"probation:id-Erin", "probation_due:id-Mia", "probation:id-Ned"})
        self.assertEqual(rows["probation:id-Erin"]["title"], "Probation - Confirm")
        self.assertEqual([a["key"] for a in rows["probation:id-Erin"]["actions"]], ["approve", "decline"])
        self.assertEqual([a["key"] for a in rows["probation:id-Ned"]["actions"]], ["open"])   # End: the Offboard flow
        self.assertEqual(rows["probation_due:id-Mia"]["link"], {"view": "hr", "sub": "hr-probation-id-Mia"})
        self.assertEqual(out["groups"], {"people": 3})
        self.assertEqual(self._counts(HRC)["hr"]["hr-people"], 3)
        # A manager recommends; only HR finalizes.
        self.assertEqual(self._inbox(MGR)["rows"], [])

    def test_hr_letter_requests_wait_on_hr(self):
        for rid, status in (("l1", "requested"), ("l2", "in_review"), ("l3", "awaiting_signature")):
            self.db.add(models.HrLetterRequest(id=rid, employee_id="id-Erin", employee_email=EMP,
                                               employee_name="Erin Test", company_id=ENTITY,
                                               letter_type="employment_verification", status=status,
                                               needed_by=SOON, purpose="Apartment lease",
                                               created_at=f"2026-10-2{rid[-1]}T08:00:00+00:00"))
        self.db.commit()
        out = self._inbox(HRC)
        self.assertEqual([r["key"] for r in out["rows"]], ["hr_letter:l1", "hr_letter:l2"])   # signing is not HR's
        row = out["rows"][0]
        self.assertEqual(row["title"], "HR Letter - Employment Verification")
        self.assertEqual([(a["key"], a["note"]) for a in row["actions"]], [("open", "none"), ("decline", "required")])
        self.assertEqual(self._counts(HRC)["myhr"]["overview"], 2)
        self.assertEqual(self._inbox(MGR)["rows"], [])
        self.assertEqual(self._inbox(EMP)["rows"], [])

    def test_headcount_requests_wait_on_each_step(self):
        self.db.add(models.HrHeadcountRequest(id="h1", code="HC-1", company=ENTITY, department="Ops",
                                              role_title="Site Manager", openings=2, status="awaiting_approval",
                                              step="department", dept_approvers=[MGR], requested_by=MATE,
                                              submitted_at="2026-10-23T08:00:00+00:00",
                                              created_at="2026-10-23T08:00:00+00:00"))
        self.db.commit()
        rows = self._inbox(MGR)["rows"]
        self.assertEqual([r["key"] for r in rows], ["headcount:h1"])
        self.assertEqual(rows[0]["title"], "Headcount Request - Site Manager (2)")
        self.assertEqual([(a["key"], a["note"]) for a in rows[0]["actions"]], [("approve", "none"), ("decline", "required")])
        self.assertEqual(self._counts(MGR)["shifts"]["headcount"], 1)
        self.assertEqual(self._inbox(HRC)["rows"], [])          # the department decides first
        self.db.query(models.HrHeadcountRequest).update({"step": "hr", "dept_decided_by": MGR})
        self.db.commit()
        self.assertEqual([r["key"] for r in self._inbox(HRC)["rows"]], ["headcount:h1"])
        self.assertEqual(self._inbox(MGR)["rows"], [])
        self.assertEqual(self._inbox(MATE)["rows"], [])         # never the requester's own

    def test_extra_time_claims_wait_on_the_named_approver(self):
        for cid, status in (("x1", "pending"), ("x2", "approved")):
            self.db.add(models.ExtraTimeClaim(id=cid, employee_email=EMP, company_id=ENTITY, local_date="2026-10-03",
                                              period_start="2026-10-01", period_end="2026-10-31", claimed_min=300,
                                              approved_min=300 if status == "approved" else 0,
                                              note="Weekend deploy", status=status, history=[],
                                              created_at=f"2026-10-0{cid[-1]}T08:00:00+00:00", updated_at=""))
        self.db.commit()
        rows = self._inbox(HRC)["rows"]                          # Erin's company's HR contact
        self.assertEqual([r["key"] for r in rows], ["extra_time:x1"])
        self.assertEqual(rows[0]["title"], "Extra Time - 10/03/2026 (5h 00m)")
        self.assertEqual([(a["key"], a["note"]) for a in rows[0]["actions"]],
                         [("approve", "none"), ("decline", "required"), ("open", "none")])
        self.assertEqual(rows[0]["link"], {"view": "hr", "sub": "hr-time-extra"})
        self.assertEqual(self._counts(HRC)["hr"]["hr-time"], 1)
        self.assertEqual(self._inbox(MGR)["rows"], [])           # the manager is not the approver
        self.assertEqual(self._inbox(EMP)["rows"], [])           # never their own


if __name__ == "__main__":
    unittest.main()
