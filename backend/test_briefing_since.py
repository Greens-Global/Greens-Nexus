"""
Briefing rows carry `since` - when the item started waiting on the person -
and the My Briefing page passes it on as `createdAt` (Oct 2026). The My Day
widget shows "3d" / "5h" from it and sorts oldest first.

  - task approval, time off (card + each bundled request), ticket and e-sign
    rows each carry a parseable ISO `since` from the most honest stamp the
    source row has;
  - GET /daily-briefing/me rows carry it as `createdAt` (sub-decisions too);
  - a row whose source recorded no timestamp has no `since` / `createdAt` -
    nothing is invented;
  - the email never shows the stamp, and the ticket detail's status label is
    Title Case ("In Progress").

Uses a throwaway sqlite file and NEXUS_SKIP_AUTH. No network, no mail.

Run with: python -m pytest test_briefing_since.py
"""
import os
import tempfile
import unittest
from datetime import datetime

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"
os.environ["NEXUS_SKIP_AUTH"] = "true"
os.environ["NEXUS_DEV_EMAIL"] = "sagar@greensglobal.com"

from fastapi import FastAPI                              # noqa: E402
from fastapi.testclient import TestClient               # noqa: E402

import daily_briefing                                    # noqa: E402
import database                                          # noqa: E402
import models                                            # noqa: E402
from routers import daily_briefing as briefing_router    # noqa: E402
from routers.task_util import gen_id                     # noqa: E402

ME = "sagar@greensglobal.com"
AMY = "amy@greensglobal.com"
T1 = "2026-09-28T08:15:00"
T2 = "2026-09-30T17:40:00"


def _parses(value: str) -> bool:
    try:
        datetime.fromisoformat(value)
        return True
    except (TypeError, ValueError):
        return False


class _Case(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskActivity, models.TaskComment, models.NexusDailyBriefingLog,
                  models.NexusSetting, models.NexusEmployee, models.TimeOffRequest, models.TaskTicket,
                  models.HrSignRequest, models.HrSignParty, models.ItemCheckout):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Sagar", last_name="Kumar", work_email=ME))
        self.db.add(models.NexusEmployee(id=gen_id(), first_name="Amy", last_name="Lee", work_email=AMY,
                                         manager_email=ME))
        self.db.commit()
        app = FastAPI()
        app.include_router(briefing_router.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def _reports(self):
        return {(e.work_email or "").lower(): e for e in
                self.db.query(models.NexusEmployee).filter(models.NexusEmployee.manager_email == ME).all()}

    def _approval(self, created_at=T1, title="Budget"):
        t = models.Task(id=gen_id(), title=title, status="not_started", type="approval", approval_status="pending",
                        assignee_email=ME, assignee_emails=[ME], owner_email=ME,
                        created_at=created_at, modified_at=created_at, created_by=ME)
        self.db.add(t)
        self.db.commit()
        return t

    def _off(self, start, end, created_at):
        r = models.TimeOffRequest(id=gen_id(), employee_email=AMY, type="vacation", start_date=start,
                                  end_date=end, status="pending", created_at=created_at)
        self.db.add(r)
        self.db.commit()
        return r

    def _ticket(self, **kw):
        t = models.TaskTicket(id=gen_id(), code="000027", subject="VPN access", requester_email=AMY, **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _red(self, reports=None):
        return daily_briefing._red_rows(self.db, ME, reports if reports is not None else {})


class SinceOnRowsTests(_Case):
    def test_task_approval_waits_since_the_task_was_created(self):
        t = self._approval(created_at=T1)
        row = next(r for r in self._red() if r.get("task_id") == t.id)
        self.assertEqual(row["since"], T1)
        self.assertTrue(_parses(row["since"]))

    def test_single_time_off_request_waits_since_it_was_filed(self):
        r = self._off("2026-10-12", "2026-10-13", T2)
        row = next(x for x in self._red(self._reports()) if x.get("action_id") == r.id)
        self.assertEqual(row["since"], T2)

    def test_bundled_time_off_card_is_as_old_as_its_oldest_request_and_each_sub_action_has_its_own(self):
        a = self._off("2026-10-12", "2026-10-13", T2)
        b = self._off("2026-11-02", "2026-11-02", T1)
        row = next(x for x in self._red(self._reports()) if x.get("sub_actions"))
        self.assertEqual(row["since"], T1)
        by_id = {s["action_id"]: s for s in row["sub_actions"]}
        self.assertEqual(by_id[a.id]["since"], T2)
        self.assertEqual(by_id[b.id]["since"], T1)
        for s in row["sub_actions"]:
            self.assertTrue(_parses(s["since"]))

    def test_ticket_rows_carry_since_and_a_title_case_status(self):
        approval = self._ticket(status="new", approval_status="pending", approver_email=ME, created_at=T1)
        assigned = self._ticket(status="in_progress", assignee_email=ME, created_at=T2)
        rows = self._red()
        a = next(r for r in rows if r.get("action_id") == approval.id)
        self.assertEqual(a["since"], T1)
        b = next(r for r in rows if r.get("ref") == "#27" and r["title"] == "VPN access"
                 and r.get("action_id") is None and assigned.id in r["url"])
        self.assertEqual(b["since"], T2)
        self.assertTrue(_parses(b["since"]))
        # Status labels are Title Case (CLAUDE.md) - never "In progress".
        self.assertEqual(b["detail"], "Assigned to you - In Progress")

    def test_esign_row_waits_since_the_envelope_was_sent(self):
        req_id = gen_id()
        self.db.add(models.HrSignRequest(id=req_id, title="Vendor NDA", status="pending", routing="sequential",
                                         current_order=1, created_by=AMY, created_at=T1))
        self.db.add(models.HrSignParty(id=gen_id(), request_id=req_id, name="Sagar Kumar", email=ME,
                                       kind="internal", party_role="signer", ordinal=1, status="notified"))
        self.db.commit()
        row = next(r for r in self._red() if r["title"] == "Sign: Vendor NDA")
        self.assertEqual(row["since"], T1)
        self.assertTrue(_parses(row["since"]))

    def test_a_row_with_no_source_timestamp_has_no_since(self):
        t = self._approval(created_at="")
        row = next(r for r in self._red() if r.get("task_id") == t.id)
        self.assertNotIn("since", row)
        self.assertNotIn("createdAt", daily_briefing._page_row(self.db, row, {}))
        # An extension ask stamps no time of its own, so its row has none either.
        self.db.add(models.ItemCheckout(id=gen_id(), item_id="i1", item_name="Drill", requested_by="Amy Lee",
                                        requested_by_email=AMY, raised_by="Amy Lee", status="allocated",
                                        created_at=T1, extension_status="pending", extension_days=2))
        self.db.commit()
        ext = next(r for r in self._red(self._reports()) if r["title"] == "Approve extension: Drill")
        self.assertNotIn("since", ext)

    def test_email_never_shows_the_stamp(self):
        self._approval(created_at=T1)
        self._off("2026-10-12", "2026-10-13", T2)
        self._off("2026-11-02", "2026-11-02", T1)
        rows = self._red(self._reports())
        self.assertTrue(all(r.get("since") for r in rows), rows)
        html = daily_briefing.render_email("Sagar", "2026-10-08", {"action_required": rows})[1]
        self.assertNotIn(T1, html)
        self.assertNotIn(T2, html)
        self.assertIn("Approve: Budget", html)


class MyBriefingPageTests(_Case):
    def test_page_rows_carry_created_at_including_sub_decisions(self):
        t = self._approval(created_at=T1)
        a = self._off("2026-10-12", "2026-10-13", T2)
        b = self._off("2026-11-02", "2026-11-02", T1)
        r = self.client.get("/daily-briefing/me")
        self.assertEqual(r.status_code, 200, r.text)
        action = next(s for s in r.json()["sections"] if s["key"] == "action_required")
        task = next(x for x in action["rows"] if x.get("taskId") == t.id)
        self.assertEqual(task["createdAt"], T1)
        self.assertTrue(_parses(task["createdAt"]))
        card = next(x for x in action["rows"] if x.get("subDecisions"))
        self.assertEqual(card["createdAt"], T1)
        subs = {d["id"]: d for d in card["subDecisions"]}
        self.assertEqual(subs[a.id]["createdAt"], T2)
        self.assertEqual(subs[b.id]["createdAt"], T1)
        # The raw key stays server-side; the page speaks createdAt.
        self.assertFalse(any("since" in x for x in action["rows"]), action["rows"])

    def test_page_row_without_a_stamp_has_no_created_at(self):
        t = self._approval(created_at="")
        r = self.client.get("/daily-briefing/me")
        action = next(s for s in r.json()["sections"] if s["key"] == "action_required")
        task = next(x for x in action["rows"] if x.get("taskId") == t.id)
        self.assertNotIn("createdAt", task)


if __name__ == "__main__":
    unittest.main()
