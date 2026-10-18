"""
Approve All Clean (Neil, Oct 17 2026): POST /timesheet-review/approve-bulk
approves every listed time sheet that has nothing to look at, each one through
the same tsr.approve / tsr.approve_period the single Approve buttons call.
On top of test_timesheet_review's real-engine fixture (same throwaway database):

  * only the manager side may call it, and only for people in their scope;
  * a flagged time sheet (a missing punch, a change waiting on a decision, an
    unusually long shift) is skipped with the reason the list shows;
  * one failure is rolled back alone - the others still go;
  * running it again changes nothing (already approved = skipped);
  * the batch is capped.

    python -m unittest test_timesheet_review_bulk
"""
import os
import unittest

from test_timesheet_review import ReviewCase, EMP, MGR, HR, ENTITY, ANCHOR, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import models  # noqa: E402
import timesheet_review as tsr  # noqa: E402
from routers import timesheet_reviews  # noqa: E402

EMP2 = "emp2.ts@greensglobal.com"
OTHER = "other.mgr.ts@greensglobal.com"


class BulkCase(ReviewCase):
    def setUp(self):
        super().setUp()
        self.db.query(models.NexusNotification).delete()
        self.db.query(models.PunchRequest).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, OTHER])).delete(
            synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=OTHER, role="manager", assigned_by="test"))
        self.db.add(models.NexusEmployee(id="id-Ezra", work_email=EMP2, first_name="Ezra", last_name="Test",
                                         company=ENTITY, manager_email=MGR, status="active"))
        self.db.add(models.NexusEmployee(id="id-Olive", work_email=OTHER, first_name="Olive", last_name="Test",
                                         company=ENTITY, manager_email="", status="active"))
        self._punch2(self.start, "in", "15:00:00")
        self._punch2(self.start, "out", "21:00:00")
        self.db.commit()
        self._prev = os.environ.get("NEXUS_DEV_EMAIL")
        self._real_send = tsr._send_envelope

    def tearDown(self):
        tsr._send_envelope = self._real_send
        if self._prev is None:
            os.environ.pop("NEXUS_DEV_EMAIL", None)
        else:
            os.environ["NEXUS_DEV_EMAIL"] = self._prev
        super().tearDown()

    def _as(self, email):
        os.environ["NEXUS_DEV_EMAIL"] = email

    def _punch2(self, day, kind, hhmm):
        self.db.add(models.TimePunch(id=f"p2-{day}-{kind}-{hhmm}", employee_email=EMP2, kind=kind,
                                     at=f"{day}T{hhmm}", local_date=day, tz_offset_min=0,
                                     created_at=f"{day}T{hhmm}"))

    def _items(self):
        """EMP submitted (a review id); EMP2 never submitted (email + start)."""
        r = tsr.submit(self.db, EMP, ANCHOR, "All in")
        return [{"id": r.id}, {"email": EMP2, "start": self.start}]

    def _bulk(self, items, who=MGR):
        self._as(who)
        return self.client.post("/timesheet-review/approve-bulk", json={"items": items})

    def _status(self, email):
        self.db.expire_all()
        r = tsr.active_review(self.db, email, self.start)
        return r.status if r else None


class BulkApproveTests(BulkCase):
    def test_the_manager_approves_every_clean_one(self):
        res = self._bulk(self._items())
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual((body["approved"], body["skipped"], body["failed"]), (2, 0, 0), body)
        self.assertEqual((self._status(EMP), self._status(EMP2)), ("signing", "signing"))
        # The same path as one Approve: an envelope to the employee, the round logged.
        for email in (EMP, EMP2):
            r = tsr.active_review(self.db, email, self.start)
            self.assertTrue(r.sign_request_id)
            self.assertEqual((r.agreed_by, r.rounds[-1]["action"]), (MGR, "agreed"))
            parties = self._parties(r.sign_request_id)
            self.assertEqual(list(parties), ["employee"])
            self.assertEqual(parties["employee"].email, email)

    def test_running_it_again_changes_nothing(self):
        items = self._items()
        self.assertEqual(self._bulk(items).json()["approved"], 2)
        ids = {e: tsr.active_review(self.db, e, self.start).sign_request_id for e in (EMP, EMP2)}
        again = self._bulk(items).json()
        self.assertEqual((again["approved"], again["skipped"], again["failed"]), (0, 2, 0), again)
        self.assertTrue(all("Already approved" in x["reason"] for x in again["results"]))
        self.db.expire_all()
        self.assertEqual({e: tsr.active_review(self.db, e, self.start).sign_request_id for e in (EMP, EMP2)}, ids)
        self.assertEqual(self.db.query(models.HrSignRequest).count(), 2)

    def test_the_same_one_twice_in_a_batch_goes_once(self):
        items = self._items()
        body = self._bulk([items[0], items[0]]).json()
        self.assertEqual([x["status"] for x in body["results"]], ["approved", "skipped"])
        self.assertEqual(self.db.query(models.HrSignRequest).count(), 1)

    def test_employees_may_not_call_it(self):
        items = self._items()
        res = self._bulk(items, who=EMP)
        self.assertIn(res.status_code, (401, 403), res.text)
        self.assertEqual((self._status(EMP), self._status(EMP2)), ("with_manager", None))

    def test_a_manager_outside_the_scope_gets_nothing_approved(self):
        body = self._bulk(self._items(), who=OTHER).json()
        self.assertEqual((body["approved"], body["failed"]), (0, 2), body)
        self.assertEqual((self._status(EMP), self._status(EMP2)), ("with_manager", None))

    def test_the_batch_is_capped(self):
        items = [{"email": EMP2, "start": self.start}] * (timesheet_reviews.BULK_MAX + 1)
        self.assertEqual(self._bulk(items).status_code, 422)
        self.assertEqual(self._bulk([]).status_code, 422)
        self.assertIsNone(self._status(EMP2))


class FlaggedTests(BulkCase):
    def test_a_missing_punch_is_skipped_with_the_reason(self):
        self._punch2(self.end, "in", "16:00:00")          # no clock-out on the last day
        self.db.commit()
        body = self._bulk(self._items()).json()
        res = {x["email"] or x["id"]: x for x in body["results"]}
        self.assertEqual(res[EMP2]["status"], "skipped")
        self.assertIn("no clock-out", res[EMP2]["reason"])
        self.assertEqual((self._status(EMP), self._status(EMP2)), ("signing", None))

    def test_a_change_waiting_on_a_decision_is_skipped(self):
        self.db.add(models.PunchRequest(id="pr-bulk", employee_email=EMP2, employee_name="Ezra Test", action="add",
                                        punch_kind="break_start", at=f"{self.start}T18:00:00",
                                        local_date=self.start, tz_offset_min=0, reason="Lunch", status="pending",
                                        created_at=f"{self.start}T23:30:00"))
        self.db.commit()
        body = self._bulk(self._items()).json()
        skipped = [x for x in body["results"] if x["status"] == "skipped"]
        self.assertEqual([x["email"] for x in skipped], [EMP2])
        self.assertIn("waiting for your decision", skipped[0]["reason"])

    def test_an_exception_that_does_not_block_approve_still_needs_a_look(self):
        # 13 hours: Approve would go through, Approve All Clean leaves it.
        self.db.query(models.TimePunch).filter(models.TimePunch.employee_email == EMP2).delete()
        self._punch2(self.start, "in", "06:00:00")
        self._punch2(self.start, "out", "19:00:00")
        self.db.commit()
        self.assertEqual(tsr.approve_blocker(self.db, EMP2, self.start, self.end), "")
        flag = tsr.review_flag(self.db, EMP2, self.start, self.end)
        self.assertIn("Unusually long shift", flag)
        body = self._bulk(self._items()).json()
        self.assertEqual([x["status"] for x in body["results"]], ["approved", "skipped"])
        self.assertIsNone(self._status(EMP2))

    def test_the_waiting_list_says_why_each_one_is_flagged(self):
        r = tsr.submit(self.db, EMP, ANCHOR, "All in")
        self.assertEqual(tsr.queue_row(self.db, r)["reviewFlag"], "")
        self._punch(self.end, "in", "16:00:00")
        self.db.commit()
        self.assertIn("no clock-out", tsr.queue_row(self.db, r)["reviewFlag"])


class PartialFailureTests(BulkCase):
    def test_one_failure_does_not_roll_back_the_others(self):
        real = self._real_send

        def flaky(db, r, actor, **kw):
            if r.employee_email == EMP2:
                raise RuntimeError("storage is down")
            return real(db, r, actor, **kw)

        tsr._send_envelope = flaky
        items = self._items()
        body = self._bulk(items).json()
        res = {x["email"] or "emp": x for x in body["results"]}
        self.assertEqual((body["approved"], body["failed"]), (1, 1), body)
        self.assertEqual(res[EMP2]["status"], "failed")
        self.assertTrue(res[EMP2]["error"])
        self.assertEqual((self._status(EMP), self._status(EMP2)), ("signing", None))
        # Fixed, the same click finishes the job and leaves the first alone.
        tsr._send_envelope = real
        again = self._bulk(items).json()
        self.assertEqual([x["status"] for x in again["results"]], ["skipped", "approved"])
        self.assertEqual(self.db.query(models.HrSignRequest).count(), 2)


if __name__ == "__main__":
    unittest.main()
