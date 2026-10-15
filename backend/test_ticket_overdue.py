"""
Overdue ticket reminders (Oct 15 2026, ticket_overdue.py): due date first,
then every other business day, one message per person, the department lead
added after two ignored overdue reminders, Teams from the manager plus the
bell - never email.

Throwaway sqlite, no network - Teams delivery and Graph mail are mocked.

Run with: python -m unittest test_ticket_overdue -v
"""
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta
from unittest.mock import patch

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_APP_URL", "https://nexus.test")

import database
import models
import ticket_notify
import ticket_overdue as O
from routers.task_util import gen_id

ASSIGNEE = "urmi@greensglobal.com"
MANAGER = "boss@greensglobal.com"
LEAD = "lead@greensglobal.com"
MON = date(2026, 9, 14)   # a Monday


def at(d: date, hour: int = 10):
    """A clock reading this local time for everyone."""
    return lambda _email: datetime(d.year, d.month, d.day, hour, 0)


def biz(d: date, n: int) -> date:
    while n:
        d += timedelta(days=1)
        n -= d.weekday() < 5
    return d


class OverdueReminderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TicketTeamsMessage, models.TaskNotification,
                  models.NexusNotification, models.TaskActivity, models.NexusEmployee,
                  models.TicketDepartment, models.NexusSetting):
            self.db.query(m).delete()
        self.db.add(models.NexusEmployee(id="e1", work_email=ASSIGNEE, first_name="Urmi", last_name="S",
                                         manager_email=MANAGER, status="active"))
        self.db.add(models.NexusEmployee(id="e2", work_email=MANAGER, first_name="Bo", last_name="Ss", status="active"))
        self.db.add(models.TicketDepartment(id="d1", company_id="c1", name="Facilities", lead_email=LEAD))
        self.db.commit()
        ticket_notify.save_settings(self.db, {"enabledEvents": {"overdue_reminder": True}}, "test")
        self.teams = []   # (sender, to, html)
        self.mails = []   # (to, subject)
        self.teams_ok = True

        def deliver(db, row):
            self.teams.append((row.agent_email, row.requester_email, row.html))
            return self.teams_ok

        def send_mail(**kw):
            self.mails.append((kw["to"][0], kw["subject"]))
            return {}

        p1 = patch("teams_post.deliver_ticket_row", side_effect=deliver)
        p2 = patch("graph_mail.send_mail", side_effect=send_mail)
        p1.start()
        p2.start()
        self.addCleanup(p1.stop)
        self.addCleanup(p2.stop)

    def tearDown(self):
        self.db.close()

    def _ticket(self, due: date, subject="Leaky faucet", status="open", **over):
        t = models.TaskTicket(id=gen_id(), code=str(len(subject) + len(self.teams) + 100), subject=subject,
                              status=status, assignee_email=ASSIGNEE, sla_due_on=due.isoformat(),
                              hr_department_id="d1", approval_status="none", overdue_reminder={})
        for k, v in over.items():
            setattr(t, k, v)
        self.db.add(t)
        self.db.commit()
        return t

    def _run(self, d: date, hour: int = 10) -> int:
        return O.run(self.db, local_now=at(d, hour))

    # ── calendar helpers ─────────────────────────────────────────────────────
    def test_business_days_skip_the_weekend(self):
        fri = MON + timedelta(days=4)
        self.assertEqual(O.business_days(fri, fri + timedelta(days=3)), 1)   # Fri -> Mon
        self.assertEqual(O.first_business_day(fri + timedelta(days=1)), fri + timedelta(days=3))

    # ── when ─────────────────────────────────────────────────────────────────
    def test_off_until_switched_on(self):
        ticket_notify.save_settings(self.db, {"enabledEvents": {"overdue_reminder": False}}, "test")
        self._ticket(MON)
        self.assertEqual(self._run(MON), 0)
        self.assertEqual(self.teams, [])

    def test_due_date_morning_from_the_manager(self):
        self._ticket(MON)
        self.assertEqual(self._run(MON, hour=8), 0)       # before 9 AM local
        self.assertEqual(self._run(MON), 1)
        sender, to, html = self.teams[0]
        self.assertEqual((sender, to), (MANAGER, ASSIGNEE))
        self.assertIn("due today", html)
        self.assertEqual(self._run(MON, hour=14), 0)      # once a day
        bell = self.db.query(models.NexusNotification).filter_by(recipient=ASSIGNEE).all()
        self.assertEqual([n.type for n in bell], ["task_ticket_overdue"])

    def test_not_before_the_due_date(self):
        self._ticket(MON + timedelta(days=1))
        self.assertEqual(self._run(MON), 0)

    def test_then_every_other_business_day(self):
        self._ticket(MON)
        sent_on = []
        d = MON
        for _ in range(10):
            if self._run(d):
                sent_on.append(d)
            d = biz(d, 1)
        self.assertEqual(sent_on, [MON, biz(MON, 2), biz(MON, 4), biz(MON, 6), biz(MON, 8)])

    def test_weekend_due_date_is_reminded_on_monday(self):
        self._ticket(MON - timedelta(days=1))   # Sunday
        self.assertEqual(self._run(MON - timedelta(days=1)), 0)
        self.assertEqual(self._run(MON), 1)

    def test_a_new_due_date_starts_over(self):
        t = self._ticket(MON)
        self._run(MON)
        t.sla_due_on = biz(MON, 3).isoformat()
        self.db.commit()
        self.assertEqual(self._run(biz(MON, 2)), 0)       # not due any more
        self.assertEqual(self._run(biz(MON, 3)), 1)       # its new due date

    # ── what ─────────────────────────────────────────────────────────────────
    def test_one_message_for_all_of_a_persons_tickets(self):
        self._ticket(MON - timedelta(days=3), subject="Broken door")
        self._ticket(MON, subject="Leaky faucet")
        self.assertEqual(self._run(MON), 1)
        self.assertEqual(len(self.teams), 1)
        self.assertIn("Broken door", self.teams[0][2])
        self.assertIn("Leaky faucet", self.teams[0][2])

    def test_skipped_tickets(self):
        self._ticket(MON, status="resolved")
        self._ticket(MON, status="closed")
        self._ticket(MON, status="waiting_user")
        self._ticket(MON, approval_status="pending")
        self._ticket(MON, assignee_email="")
        self.assertEqual(self._run(MON), 0)

    # ── escalation ───────────────────────────────────────────────────────────
    def test_lead_joins_after_two_ignored_overdue_reminders(self):
        self._ticket(MON)
        days = [MON, biz(MON, 2), biz(MON, 4), biz(MON, 6)]   # due, overdue 1, 2, 3
        for d in days:
            self._run(d)
        to_lead = [t for t in self.teams if t[1] == LEAD]
        self.assertEqual(len(to_lead), 1)                     # only on the third overdue one
        self.assertEqual(to_lead[0][0], MANAGER)
        self.assertIn("Facilities", to_lead[0][2])
        self.assertIn("Urmi", to_lead[0][2])

    # ── no email, ever (the briefings already mail people) ─────────────────
    def test_a_failed_teams_message_stays_queued_and_nothing_is_emailed(self):
        import teams_post
        self.teams_ok = False
        self._ticket(MON)
        self._run(MON)
        self.assertEqual(self.mails, [])
        row = self.db.query(models.TicketTeamsMessage).one()
        self.assertEqual(row.sent, 0)
        self.assertLess(row.attempts or 0, teams_post.MAX_ATTEMPTS)   # the retry sweep still owns it

    def test_no_manager_means_the_bell_only(self):
        emp = self.db.query(models.NexusEmployee).filter_by(work_email=ASSIGNEE).one()
        emp.manager_email = ""
        self.db.commit()
        self._ticket(MON)
        self._run(MON)
        self.assertEqual((self.teams, self.mails), ([], []))
        self.assertEqual(self.db.query(models.NexusNotification).filter_by(recipient=ASSIGNEE).count(), 1)

if __name__ == "__main__":
    unittest.main()
