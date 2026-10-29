"""Time sheet periods paid in SwipeClock before Nexus (Charmi, 10/27 call
item 10): HR closes them out through the finalize-with-reason steps, with
"Processed in SwipeClock before Nexus", and they stop asking - the envelope
is voided, the period is final, the review and its notices are done, the
Daily Briefing and the reviewers' list drop it. A period from 10/04/2026 on
is refused, so its signature step stays as it is.

On test_timesheet_review's real-engine fixture (same throwaway database):
    python -m unittest test_timesheet_closeout
"""
import json
import unittest
import uuid

from test_timesheet_review import ReviewCase, EMP, MGR, HR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

from fastapi import HTTPException  # noqa: E402

import closeout_swipeclock_periods as closeout  # noqa: E402
import daily_briefing  # noqa: E402
import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timeclock  # noqa: E402

OLD = ("2026-09-20", "2026-10-03")       # paid in SwipeClock
NEW = ("2026-10-04", "2026-10-17")       # the first Nexus period


class CloseOutTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.NexusNotification).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, HR])).delete(synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        for day in ("2026-09-21", "2026-10-05"):
            self._punch(day, "in", "16:00:00")
            self._punch(day, "out", "23:00:00")
        self.db.commit()

    def _notice(self, to, title, *, ref="", action=None):
        self.db.add(models.NexusNotification(id=str(uuid.uuid4()), type="hr", recipient=to, title=title, body="",
                                             ref_id=ref, action=json.dumps(action or {}), priority=1,
                                             created_at="2026-10-08T00:00:00"))
        self.db.commit()

    def _open_bar(self, to):
        self.db.expire_all()
        return sorted(n.title for n in self.db.query(models.NexusNotification).filter(
            models.NexusNotification.recipient == to, models.NexusNotification.priority == 1,
            models.NexusNotification.actioned == False).all())  # noqa: E712

    def test_an_old_period_out_for_signature_is_closed_out_and_stops_asking(self):
        tsr.approve_period(self.db, EMP, OLD[0], MGR, "ok")
        self.db.commit()
        r = tsr.active_review(self.db, EMP, OLD[0])
        self.assertEqual(r.status, "signing")
        envelope = r.sign_request_id
        # The bar as it looked: the old envelope's Signature Required, the review notice, and one about another period.
        self._notice(MGR, "Signature Required: Timesheet - Erin Test - 09/20/2026 - 10/03/2026", ref=envelope)
        self._notice(MGR, "Review Erin Test's Time Sheet", action={"view": "hr", "sub": "hr-time", "timecard": EMP, "start": OLD[0]})
        self._notice(MGR, "Review Erin Test's Time Sheet (new)", action={"view": "hr", "sub": "hr-time", "timecard": EMP, "start": NEW[0]})
        self.assertEqual([p[:3] for p in closeout.plan(self.db)], [(EMP, OLD[0], OLD[1])])

        out = tsr.close_out_outside_nexus(self.db, EMP, OLD[0], HR)
        self.db.commit()
        self.assertEqual(out.status, "completed")
        self.assertEqual(out.rounds[-1]["action"], "finalized_unsigned")
        self.assertEqual(out.rounds[-1]["note"], "Processed in SwipeClock before Nexus")
        self.assertTrue(timeclock._finalized_row(self.db, EMP, *OLD))
        self.assertEqual(self.db.query(models.HrSignRequest).filter(models.HrSignRequest.id == envelope).first().status, "voided")
        note = self.db.query(models.TimeApproval).filter(models.TimeApproval.employee_email == EMP, models.TimeApproval.kind == "manager",
                                                         models.TimeApproval.revoked == 0, models.TimeApproval.period_start == OLD[0]).first().note
        self.assertIn("Processed in SwipeClock before Nexus", note)
        # Only the other period's notice is left on the bar; no new "Finalized by HR" notice was added.
        self.assertEqual(self._open_bar(MGR), ["Review Erin Test's Time Sheet (new)"])
        # The Daily Briefing and the reviewers' list no longer ask about it.
        briefing = daily_briefing._timesheet_review_rows(self.db, MGR)
        self.assertFalse([b for b in briefing if "09/20/2026" in b.get("detail", "")])
        self.assertFalse([q for q in tsr.not_reviewed(self.db, MGR) if q["periodStart"] == OLD[0]])
        # Nothing left to plan; a second run is a no-op.
        self.assertEqual(closeout.plan(self.db), [])
        self.assertIsNone(tsr.close_out_outside_nexus(self.db, EMP, OLD[0], HR))

    def test_a_nexus_period_keeps_its_signature_step(self):
        with self.assertRaises(HTTPException) as ctx:
            tsr.close_out_outside_nexus(self.db, EMP, NEW[0], HR)
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("ended before 10/04/2026", ctx.exception.detail)
        self.assertFalse(timeclock._finalized_row(self.db, EMP, *NEW))
        # The new period still reviews and goes out for the employee's signature as before.
        tsr.approve_period(self.db, EMP, NEW[0], MGR, "ok")
        self.assertEqual(tsr.active_review(self.db, EMP, NEW[0]).status, "signing")

    def test_only_hr_closes_out(self):
        with self.assertRaises(HTTPException) as ctx:
            tsr.close_out_outside_nexus(self.db, EMP, OLD[0], MGR)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertFalse(timeclock._finalized_row(self.db, EMP, *OLD))

    def _events(self):
        self.db.expire_all()
        return [ev.key for ev in self.db.query(models.WorkflowEvent).filter(models.WorkflowEvent.subject_id != "").all()]

    def test_the_close_out_fires_no_workflow_event_but_a_normal_finalize_does(self):
        # Reviewer, 10/29: HR's close-out of the SwipeClock periods would fire the
        # "time sheet changed" workflows once per old period.
        tsr.approve_period(self.db, EMP, OLD[0], MGR, "ok")
        self.db.commit()
        self.db.query(models.WorkflowEvent).delete()
        self.db.commit()
        out = tsr.close_out_outside_nexus(self.db, EMP, OLD[0], HR)
        self.db.commit()
        self.assertEqual(out.status, "completed")
        self.assertEqual(self._events(), [])
        # The review's own history still has the close-out.
        self.assertEqual(out.rounds[-1]["action"], "finalized_unsigned")
        # The same finalize steps outside the close-out still tell Workflows.
        s, e, pay_type = tsr.period_for(self.db, EMP, NEW[0])
        tsr._finalize_without_signature(self.db, EMP, s, e, pay_type, HR, "Left the company")
        self.db.commit()
        self.assertIn("timesheet.review_changed", self._events())

    def test_hrs_own_finalize_button_is_unchanged(self):
        # finalize_unsigned still refuses a period nobody approved (the manager reviews first).
        with self.assertRaises(HTTPException) as ctx:
            tsr.finalize_unsigned(self.db, EMP, OLD[0], HR, "Left the company")
        self.assertEqual(ctx.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
