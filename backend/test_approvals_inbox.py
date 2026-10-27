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
  * reimbursements follow decide()'s gates; hiring votes drop off once voted.

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
                  models.Task, models.TimesheetReview, models.HrEntity):
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


if __name__ == "__main__":
    unittest.main()
