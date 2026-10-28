"""
Tickets to Assign (Oct 26 2026, ticket_assign_alerts.py) and the dashboard's
My Open Tickets counts (my_work.ticket_focus_counts). Covered:

  - an open unassigned ticket puts ONE priority notice on each desk member
    of its company (per-company roster first, else the flat roster), never on
    someone who left, never on another company's desk;
  - waiting for approval, resolved / closed, deleted or assigned tickets are
    not on it;
  - a new ticket brings a clicked-off notice back to the top, unread; a
    ticket leaving it is a quiet update; nothing left resolves it (priority 0);
  - one ticket opens straight away (ticketId); several open the Unassigned
    filter;
  - the tile's numbers: assigned to me, past SLA, waiting for me to assign -
    the same rule as the notice.

Throwaway sqlite, no routes.

Run with: python -m pytest test_ticket_assign_alerts.py -q
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import database                                 # noqa: E402
import models                                   # noqa: E402
import ticket_assign_alerts as A                # noqa: E402
import ticket_notify                            # noqa: E402
from routers import my_work                     # noqa: E402
from routers.task_util import gen_id            # noqa: E402

DESK = "desk@greensglobal.com"
DESK2 = "desk2@greensglobal.com"
INDIA = "india.desk@greensglobal.com"
LEFT = "left@greensglobal.com"
WORKER = "worker@greensglobal.com"
NOW = datetime.now(timezone.utc)


class TicketAssignAlertsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.TaskTicket, models.NexusNotification, models.NexusEmployee, models.NexusRole,
                  models.NexusSetting, models.HrEntity):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        for email, co, status in ((DESK, "co1", "active"), (DESK2, "co1", "active"), (INDIA, "co2", "active"),
                                  (LEFT, "co1", "offboarded"), (WORKER, "co1", "active")):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0].title(),
                                             last_name="", company=co, status=status))
        ticket_notify.save_settings(self.db, {"agentEmails": [DESK, DESK2, LEFT],
                                              "agentEmailsByCompany": {"co2": [INDIA]}}, "x")
        self.db.commit()
        self.n = 0

    def ticket(self, **kw):
        self.n += 1
        t = models.TaskTicket(id=gen_id(), code=str(self.n), subject=kw.pop("subject", f"Problem {self.n}"),
                              status=kw.pop("status", "open"), priority=kw.pop("priority", "medium"),
                              company_id=kw.pop("company_id", "co1"), assignee_email=kw.pop("assignee", ""),
                              created_at=(NOW - timedelta(minutes=100 - self.n)).isoformat(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def notices(self, email, open_only=True):
        q = self.db.query(models.NexusNotification).filter_by(recipient=email, ref_id=f"ticket-unassigned:{email}")
        if open_only:
            q = q.filter(models.NexusNotification.actioned == False)   # noqa: E712
        self.db.expire_all()
        return q.all()

    def scan(self):
        out = A.scan(self.db)
        self.db.expire_all()
        return out

    def test_each_desk_member_of_the_company_gets_one_priority_notice(self):
        self.ticket(subject="Printer jammed", priority="high")
        self.ticket(subject="VPN down", priority="urgent")
        self.scan()
        for email in (DESK, DESK2):
            [n] = self.notices(email)
            self.assertEqual((n.priority, n.title), (1, "2 Tickets to Assign"))
            lines = n.body.split("\n")
            self.assertEqual(lines[0], "2 tickets are waiting for you to assign them.")
            self.assertIn("VPN down (Urgent)", lines[1])        # most urgent first
            self.assertIn("Printer jammed (High)", lines[2])
            action = json.loads(n.action)
            self.assertEqual((action["view"], action["ticketFilter"]), ("tickets", "unassigned"))
            self.assertNotIn("ticketId", action)
        self.assertEqual(self.notices(LEFT), [])                 # left the company
        self.assertEqual(self.notices(INDIA), [])                # another company's desk
        self.assertEqual(self.notices(WORKER), [])

    def test_a_company_with_its_own_roster_pages_only_that_desk(self):
        t = self.ticket(company_id="co2")
        self.scan()
        [n] = self.notices(INDIA)
        self.assertEqual(n.title, "1 Ticket to Assign")
        self.assertEqual(n.body.split("\n")[0], "1 ticket is waiting for you to assign it.")
        self.assertEqual(json.loads(n.action)["ticketId"], t.id)   # one ticket opens straight away
        self.assertEqual(self.notices(DESK), [])

    def test_tickets_that_cannot_or_need_not_be_assigned_are_left_out(self):
        self.ticket(approval_status="pending")
        self.ticket(status="resolved")
        self.ticket(status="closed")
        self.ticket(assignee=WORKER)
        self.ticket(deleted_at=NOW.isoformat())
        self.scan()
        self.assertEqual(self.notices(DESK), [])

    def test_new_ticket_brings_it_back_and_assignment_clears_it(self):
        a = self.ticket()
        self.scan()
        [n] = self.notices(DESK)
        n.read_by, n.closed_by = DESK, DESK                  # read and clicked off the bar
        self.db.commit()

        b = self.ticket()                                    # a new ticket joins
        self.scan()
        [n] = self.notices(DESK)
        self.assertEqual((n.read_by, n.closed_by, n.title), ("", "", "2 Tickets to Assign"))

        n.read_by, n.closed_by = DESK, DESK
        self.db.commit()
        a.assignee_email = DESK2                             # one leaves: a quiet update
        self.db.commit()
        self.scan()
        [n] = self.notices(DESK)
        self.assertEqual((n.read_by, n.closed_by, n.title), (DESK, DESK, "1 Ticket to Assign"))
        self.assertEqual(json.loads(n.action)["ticketId"], b.id)

        b.status = "closed"                                  # nothing left: resolved
        self.db.commit()
        self.assertEqual(self.scan()["resolved"], 2)         # both desk members
        self.assertEqual(self.notices(DESK), [])
        [done] = self.notices(DESK, open_only=False)
        self.assertEqual((done.actioned, done.priority, done.title), (True, 0, "Every Ticket Is Assigned"))

    def test_an_unchanged_list_is_left_alone(self):
        self.ticket()
        self.scan()
        self.assertEqual(self.scan(), {"opened": 0, "updated": 0, "resolved": 0})

    def test_the_tile_counts_follow_the_same_rule(self):
        self.ticket()
        self.ticket(company_id="co2")
        self.ticket(assignee=DESK)
        self.ticket(assignee=DESK, sla_due_at=(NOW - timedelta(hours=2)).isoformat())   # past SLA
        self.ticket(assignee=DESK, status="resolved")
        user = {"email": DESK, "level": 1}
        self.assertEqual(my_work.ticket_focus_counts(self.db, user, DESK),
                         {"mine": 2, "breached": 1, "unassigned": 1})
        worker = {"email": WORKER, "level": 1}
        self.assertEqual(my_work.ticket_focus_counts(self.db, worker, WORKER),
                         {"mine": 0, "breached": 0, "unassigned": 0})


if __name__ == "__main__":
    unittest.main()
