"""
Who gets the ticket emails: the IT Admin desk (Aug 2026).

The email channel used to route triage to the ticket's department lead, with the
backup pulled in when the lead was not punched in, and a single configured
"Ticket Administrator" as a patch for departments with no lead at all. That is
not how a service desk works - a ticket is filed against the department it is
ABOUT, which is rarely the one that resolves it, so requests landed with people
who could neither action them nor knew to pass them on.

Triage is now the administrator/owner pool, irrespective of department, matching
the in-app bell in routers/tickets.py. The two channels agreeing is the point:
before this, the bell told IT to assign a ticket while the email told a
department lead the same thing, and neither knew about the other.

Throwaway sqlite. No network - _recipients_for is pure resolution, the sending
happens elsewhere.

Run with: python -m unittest test_ticket_notify_routing -v
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

import database
import models
import ticket_notify

models.Base.metadata.create_all(bind=database.engine)


@atexit.register
def _drop():
    database.engine.dispose()
    try:
        os.remove(_tmp.name)
    except OSError:
        pass


REQUESTER = "sagar.shoundik@greensglobal.com"
ADMIN = "itadmin@greensglobal.com"
OWNER = "neil@greensglobal.com"
ASSIGNEE = "agent@greensglobal.com"
LEAD = "lead@greensglobal.com"
FALLBACK = "ticketdesk@greensglobal.com"


class RecipientTests(unittest.TestCase):
    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.NexusEmployee, models.HrDepartment, models.TaskTicket,
                  models.NexusRole, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()
        # A department that still has a lead configured - nothing should route
        # to them any more.
        self.dept = models.HrDepartment(id=str(uuid.uuid4()), company_id="co", name="IT",
                                        lead_email=LEAD, backup_email="")
        self.db.add(self.dept)
        self.db.add(models.NexusRole(email=ADMIN, role="administrator"))
        self.db.add(models.NexusRole(email=OWNER, role="owner"))
        self.db.commit()
        self.cfg = {"ticketAdminEmail": FALLBACK}

    def _ticket(self, **kw):
        kw.setdefault("type", "bug")
        kw.setdefault("requester_email", REQUESTER)
        kw.setdefault("approval_status", "none")
        t = models.TaskTicket(
            id=str(uuid.uuid4()), code="TKT-1", subject="S", hr_department_id=self.dept.id,
            status="new", created_at="", modified_at="", **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _to(self, t, event, cfg=None):
        return dict(ticket_notify._recipients_for(self.db, t, event, cfg or self.cfg))

    # ── the desk owns triage ─────────────────────────────────────────────
    def test_a_new_ticket_emails_every_it_admin(self):
        got = self._to(self._ticket(), "created")
        self.assertEqual(got.get(ADMIN), "it_admin")
        self.assertEqual(got.get(OWNER), "it_admin")

    def test_owners_count_as_it_admins(self):
        self.assertIn(OWNER, self._to(self._ticket(), "created"))

    def test_the_department_lead_is_never_emailed(self):
        for event in ("created", "assigned", "resolved", "reopened"):
            self.assertNotIn(LEAD, self._to(self._ticket(assignee_email=ASSIGNEE), event), event)

    def test_the_requester_still_gets_their_receipt(self):
        self.assertEqual(self._to(self._ticket(), "created").get(REQUESTER), "requester")

    def test_the_assignee_still_gets_their_copy(self):
        got = self._to(self._ticket(assignee_email=ASSIGNEE), "assigned")
        self.assertEqual(got.get(ASSIGNEE), "assignee")

    def test_updates_still_go_to_the_end_user_only(self):
        """Unchanged by this - an update email is the requester's status report,
        not a queue notification."""
        self.assertEqual(list(self._to(self._ticket(), "updated")), [REQUESTER])

    # ── the approval gate ────────────────────────────────────────────────
    def test_a_parked_request_does_not_ask_anyone_to_assign_it(self):
        t = self._ticket(type="access_request", approval_status="pending")
        self.assertEqual(list(self._to(t, "created")), [REQUESTER])

    def test_once_approved_the_admins_are_asked(self):
        t = self._ticket(type="access_request", approval_status="approved")
        self.assertIn(ADMIN, self._to(t, "created"))

    def test_approval_required_goes_only_to_the_named_approver(self):
        t = self._ticket(type="access_request", approval_status="pending",
                         approver_email=OWNER)
        self.assertEqual(self._to(t, "approval_required"), {OWNER: "approver"})

    # ── nobody home ──────────────────────────────────────────────────────
    def test_with_no_admins_it_falls_back_to_the_configured_desk(self):
        self.db.query(models.NexusRole).delete()
        self.db.commit()
        self.assertEqual(self._to(self._ticket(), "created").get(FALLBACK), "it_admin")

    def test_the_gap_is_logged_either_way(self):
        self.db.query(models.NexusRole).delete()
        self.db.commit()
        self._to(self._ticket(), "created", cfg={"ticketAdminEmail": ""})
        self.db.commit()   # sessions are autoflush=False - the log row is not visible until then
        kinds = [a.type for a in self.db.query(models.TaskActivity).all()]
        self.assertIn("notify_gap", kinds)

    def test_an_offboarded_admin_is_not_emailed(self):
        self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name="X", work_email=ADMIN,
                                         company="co", status="offboarded"))
        self.db.commit()
        got = self._to(self._ticket(), "created")
        self.assertNotIn(ADMIN, got)
        self.assertIn(OWNER, got)   # the rest of the desk still hears about it

    def test_an_admin_who_raised_the_ticket_is_labelled_requester_not_twice(self):
        """First role wins - they must never receive two copies of one event."""
        got = self._to(self._ticket(requester_email=ADMIN), "created")
        self.assertEqual(got[ADMIN], "requester")


if __name__ == "__main__":
    unittest.main()
