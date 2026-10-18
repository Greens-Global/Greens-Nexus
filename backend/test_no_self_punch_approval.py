"""
Nobody decides their own punch fix or punch edit (Oct 18 2026). A manager's
team scope includes themself, so PATCH /timeclock/punch-requests/{id} and
/punch-edits/{id} let a manager approve their own. Now refused (403
"Someone else must approve your own punch fix."), like a time sheet's
self-review - and the request still reaches the people who decide it
(_notify_approvers: their manager, HR contact, the Global Admins).

    python -m pytest -q test_no_self_punch_approval.py
"""
import os
import unittest
from datetime import datetime, timedelta, timezone

from test_timesheet_review import ReviewCase, MGR, HR, ENTITY, _tmp_db  # noqa: F401  (sets DATABASE_URL first)

import auth  # noqa: E402
import models  # noqa: E402

BOSS = "boss.np@greensglobal.com"     # Max's own manager
ADMIN = "admin.np@greensglobal.com"   # an administrator (whole-company scope)


class SelfDecisionCase(ReviewCase):
    def setUp(self):
        super().setUp()
        for m in (models.NexusNotification, models.PunchRequest):
            self.db.query(m).delete()
        self.db.query(models.NexusRole).filter(models.NexusRole.email.in_([MGR, BOSS, ADMIN])).delete(
            synchronize_session=False)
        self.db.add(models.NexusRole(email=MGR, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=BOSS, role="manager", assigned_by="test"))
        self.db.add(models.NexusRole(email=ADMIN, role="administrator", assigned_by="test"))
        self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == MGR).update(
            {"manager_email": BOSS})
        for em, first in ((BOSS, "Bo"), (ADMIN, "Ada")):
            self.db.add(models.NexusEmployee(id=f"id-{first}", work_email=em, first_name=first, last_name="Test",
                                             company=ENTITY, manager_email="", status="active"))
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

    def _fix(self, who):
        at = (datetime.now(timezone.utc) - timedelta(days=1)).replace(hour=15, minute=0, second=0, microsecond=0)
        self._as(who)
        res = self.client.post("/timeclock/punch-requests", json={
            "action": "add", "punch_kind": "in", "at": at.strftime("%Y-%m-%dT%H:%M:%S"),
            "reason": "Forgot to clock in", "tz_offset_min": 0})
        self.assertEqual(res.status_code, 200, res.text)
        return res.json()["id"]

    def _edit(self, who):
        day = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
        pid = f"np-{who}"
        self.db.add(models.TimePunch(id=pid, employee_email=who, kind="in", at=f"{day}T15:00:00",
                                     local_date=day, tz_offset_min=0, created_at=f"{day}T15:00:00"))
        self.db.commit()
        self._as(who)
        res = self.client.post("/timeclock/punch-edits", json={"punch_id": pid, "at": f"{day}T14:30:00",
                                                                "reason": "Came in early"})
        self.assertEqual(res.status_code, 200, res.text)
        return pid


class SelfDecisionTests(SelfDecisionCase):
    def test_a_manager_cannot_decide_their_own_punch_fix(self):
        rid = self._fix(MGR)
        for status in ("approved", "rejected"):
            res = self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": status})
            self.assertEqual(res.status_code, 403, res.text)
            self.assertEqual(res.json()["detail"], "Someone else must approve your own punch fix.")
        self.db.expire_all()
        self.assertEqual(self.db.query(models.PunchRequest).filter(models.PunchRequest.id == rid).one().status,
                         "pending")

    def test_it_still_reaches_their_manager_who_decides_it(self):
        rid = self._fix(MGR)
        to = {n.recipient for n in self.db.query(models.NexusNotification)
              .filter(models.NexusNotification.title == "Time Sheet Fix Requested").all()}
        self.assertIn(BOSS, to)
        self.assertNotIn(MGR, to)
        self._as(BOSS)
        # (Rejected: approving a lone clock-in would fail the punch-order check.)
        res = self.client.patch(f"/timeclock/punch-requests/{rid}", json={"status": "rejected", "note": "Ask HR"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((res.json()["status"], res.json().get("decidedBy")), ("rejected", BOSS))

    def test_an_administrator_cannot_decide_their_own_either(self):
        rid = self._fix(ADMIN)
        self.assertEqual(self.client.patch(f"/timeclock/punch-requests/{rid}",
                                           json={"status": "approved"}).status_code, 403)
        # With no manager and no HR contact... it still reaches someone else.
        self.db.query(models.HrEntity).filter(models.HrEntity.id == ENTITY).update({"hr_contact_email": HR})
        self.db.commit()
        to = {n.recipient for n in self.db.query(models.NexusNotification)
              .filter(models.NexusNotification.title == "Time Sheet Fix Requested").all()}
        self.assertTrue(to - {ADMIN}, to)

    def test_a_manager_cannot_decide_their_own_punch_edit(self):
        pid = self._edit(MGR)
        res = self.client.patch(f"/timeclock/punch-edits/{pid}", json={"status": "approved"})
        self.assertEqual(res.status_code, 403, res.text)
        self.assertEqual(res.json()["detail"], "Someone else must approve your own punch fix.")
        self._as(BOSS)
        res = self.client.patch(f"/timeclock/punch-edits/{pid}", json={"status": "approved"})
        self.assertEqual(res.status_code, 200, res.text)


if __name__ == "__main__":
    unittest.main()
