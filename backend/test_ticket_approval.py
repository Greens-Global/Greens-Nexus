"""
Ticket approval workflow: the IT Admin desk routes it (Aug 2026).

Intake used to ask the requester to name their own approver ("Approver",
"Manager Approval"). That is not a control - it lets someone route their own
access request to whoever will say yes, and it is the first thing an auditor
pulls on. The server then tried to *derive* one from the org chart, which only
moved the guess: a ticket filed against the wrong department resolved to
somebody with no idea what it was.

The flow now, end to end:

    submit  →  parked pending, no approver, visible to every IT Admin
            →  an IT Admin sends it to whoever should sign it off
            →  that person approves (or rejects, which closes it)
            →  an IT Admin assigns it to anyone
            →  the regular ticket lifecycle

"IT Admin" is the administrator/owner pool - deliberately irrespective of
department, so one desk sees everything that comes in. Two things are enforced
rather than assumed: only an IT Admin may route a ticket for approval, and
nothing may be assigned while it is still awaiting one.

Throwaway sqlite. No network.

Run with: python -m unittest test_ticket_approval -v
"""
import os
import tempfile
import unittest
import uuid

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

import atexit

from fastapi import BackgroundTasks, HTTPException

import database
import models
from routers import tickets

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
OTHER_ADMIN = "itadmin2@greensglobal.com"
APPROVER = "neil@greensglobal.com"
AGENT = "agent@greensglobal.com"
LEAD = "lead@greensglobal.com"


class _Case(unittest.TestCase):
    """Shared fixture. Holds no tests of its own - a subclass that inherited
    them would silently re-run the whole suite under a different name."""

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.NexusEmployee, models.HrDepartment, models.TaskTicket,
                  models.NexusRole, models.TaskNotification, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()
        self.dept = models.HrDepartment(id=str(uuid.uuid4()), company_id="co", name="IT",
                                        lead_email=LEAD, backup_email="")
        self.db.add(self.dept)
        for email in (ADMIN, OTHER_ADMIN):
            self.db.add(models.NexusRole(email=email, role="administrator"))
        self.db.add(models.NexusEmployee(id=str(uuid.uuid4()), first_name="Sagar",
                                         work_email=REQUESTER, manager_email=APPROVER,
                                         company="co", status="active"))
        self.db.commit()

    # ── helpers ──────────────────────────────────────────────────────────
    def _user(self, email, level=1):
        return {"email": email, "level": level}

    def _create(self, type_="access_request", actor=REQUESTER, **kw):
        body = tickets.TicketBody(subject="S", type=type_, hr_department_id=self.dept.id, **kw)
        return tickets.create_ticket(body, BackgroundTasks(), user=self._user(actor), db=self.db)

    def _row(self, ticket_id):
        return self.db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()

    def _bells(self, email):
        return [n for n in self.db.query(models.TaskNotification).all()
                if (n.for_email or "").lower() == email]


class IntakeGateTests(_Case):
    """What happens the moment a ticket is filed."""

    def test_spending_access_and_change_are_gated(self):
        self.assertEqual(tickets.APPROVAL_REQUIRED_TYPES,
                         {"service_request", "change_request", "access_request"})

    def test_a_gated_ticket_parks_with_nobody_named(self):
        """Blank, not a guess. The desk that reads the request picks who it
        needs to go to; the server has no way to know."""
        t = self._create("access_request")
        self.assertEqual(t["approvalStatus"], "pending")
        self.assertIsNone(t["approverId"])   # _nz: empty is serialised as null

    def test_a_bug_report_needs_no_approval(self):
        """Reporting a bug commits nothing - gating it would only put a step
        between a user and help."""
        self.assertEqual(self._create("bug")["approvalStatus"], "none")

    def test_the_client_cannot_pre_approve_its_own_ticket(self):
        t = self._create("service_request")
        self.assertEqual(t["approvalStatus"], "pending")

    def test_a_gated_ticket_cannot_be_born_assigned(self):
        with self.assertRaises(HTTPException) as e:
            self._create("access_request", assignee_email=AGENT)
        self.assertEqual(e.exception.status_code, 409)

    def test_an_ungated_ticket_may_still_be_raised_pre_assigned(self):
        self.assertEqual(self._create("bug", assignee_email=AGENT)["assigneeId"], AGENT)


class RoutingTests(_Case):
    """Where a new ticket lands: the IT Admin pool, irrespective of department."""

    def test_every_it_admin_hears_about_a_new_ticket(self):
        self._create("bug")
        for admin in (ADMIN, OTHER_ADMIN):
            self.assertTrue(self._bells(admin), f"{admin} was not notified")

    def test_the_department_lead_is_no_longer_the_route(self):
        """A ticket filed against the wrong department used to sit with a lead
        who could not act on it and did not know to pass it on."""
        self._create("bug")
        self.assertEqual(self._bells(LEAD), [])

    def test_a_gated_ticket_asks_for_routing_not_assignment(self):
        """Telling the queue to "assign" something nobody may touch yet trains
        people to ignore the queue."""
        self._create("access_request")
        self.assertEqual([n.title for n in self._bells(ADMIN)], ["Ticket needs approval routing"])

    def test_an_admin_raising_their_own_ticket_is_not_told_about_it(self):
        self._create("bug", actor=ADMIN)
        self.assertEqual(self._bells(ADMIN), [])
        self.assertTrue(self._bells(OTHER_ADMIN))

    def test_a_pre_assigned_ticket_goes_to_the_assignee_instead(self):
        self._create("bug", assignee_email=AGENT)
        self.assertTrue(self._bells(AGENT))
        self.assertEqual(self._bells(ADMIN), [])


class RequestApprovalTests(_Case):
    """The IT Admin sends a parked request to whoever signs it off."""

    def _send(self, ticket_id, actor=ADMIN, approver=APPROVER, level=4, note=""):
        body = tickets.ApprovalRequestBody(approver_email=approver, note=note)
        return tickets.request_approval(ticket_id, body, BackgroundTasks(),
                                        user=self._user(actor, level), db=self.db)

    def test_an_admin_names_the_approver(self):
        t = self._create("access_request")
        self.assertEqual(self._send(t["id"])["approverId"], APPROVER)

    def test_the_approver_is_told(self):
        t = self._create("access_request")
        self._send(t["id"])
        self.assertEqual([n.title for n in self._bells(APPROVER)], ["A ticket needs your approval"])

    def test_the_requester_cannot_route_their_own_request(self):
        """The whole point of the control. Anyone who can pick their own
        approver can pick one who says yes."""
        t = self._create("access_request")
        with self.assertRaises(HTTPException) as e:
            self._send(t["id"], actor=REQUESTER, level=1)
        self.assertEqual(e.exception.status_code, 403)

    def test_a_manager_who_is_not_an_it_admin_cannot_route_it_either(self):
        """Level is not the test - membership of the IT Admin pool is."""
        t = self._create("access_request")
        with self.assertRaises(HTTPException) as e:
            self._send(t["id"], actor=LEAD, level=3)
        self.assertEqual(e.exception.status_code, 403)

    def test_it_cannot_be_sent_to_the_person_who_raised_it(self):
        t = self._create("access_request")
        with self.assertRaises(HTTPException) as e:
            self._send(t["id"], approver=REQUESTER)
        self.assertEqual(e.exception.status_code, 422)

    def test_an_approver_is_required(self):
        t = self._create("access_request")
        with self.assertRaises(HTTPException) as e:
            self._send(t["id"], approver="  ")
        self.assertEqual(e.exception.status_code, 422)

    def test_an_ungated_ticket_has_nothing_to_route(self):
        t = self._create("bug")
        with self.assertRaises(HTTPException) as e:
            self._send(t["id"])
        self.assertEqual(e.exception.status_code, 409)

    def test_it_can_be_re_routed_while_still_pending(self):
        """An approver on leave must not deadlock the request."""
        t = self._create("access_request")
        self._send(t["id"])
        self.assertEqual(self._send(t["id"], approver=OTHER_ADMIN)["approverId"], OTHER_ADMIN)

    def test_a_decided_ticket_cannot_be_re_routed(self):
        t = self._create("access_request")
        self._send(t["id"])
        self._decide(t["id"], "approve")
        with self.assertRaises(HTTPException) as e:
            self._send(t["id"], approver=OTHER_ADMIN)
        self.assertEqual(e.exception.status_code, 409)

    def _decide(self, ticket_id, decision, actor=APPROVER, note="ok", level=1):
        body = tickets.ApprovalBody(decision=decision, note=note)
        return tickets.decide_approval(ticket_id, body, BackgroundTasks(),
                                       user=self._user(actor, level), db=self.db)


class DecisionTests(_Case):
    """Approve releases the ticket for assignment; reject closes it."""

    def _route(self, ticket_id, approver=APPROVER):
        tickets.request_approval(ticket_id, tickets.ApprovalRequestBody(approver_email=approver),
                                 BackgroundTasks(), user=self._user(ADMIN, 4), db=self.db)

    def _decide(self, ticket_id, decision, actor=APPROVER, note="ok", level=1):
        body = tickets.ApprovalBody(decision=decision, note=note)
        return tickets.decide_approval(ticket_id, body, BackgroundTasks(),
                                       user=self._user(actor, level), db=self.db)

    def _assign(self, ticket_id, actor=ADMIN, level=4, to=AGENT):
        body = tickets.TicketUpdate(assignee_email=to)
        return tickets.update_ticket(ticket_id, body, BackgroundTasks(),
                                     user=self._user(actor, level), db=self.db)

    def test_nothing_is_assignable_while_it_waits(self):
        t = self._create("access_request")
        self._route(t["id"])
        with self.assertRaises(HTTPException) as e:
            self._assign(t["id"])
        self.assertEqual(e.exception.status_code, 409)

    def test_approval_releases_it_for_assignment(self):
        t = self._create("access_request")
        self._route(t["id"])
        self._decide(t["id"], "approve")
        self.assertEqual(self._assign(t["id"])["assigneeId"], AGENT)

    def test_the_admins_are_told_it_is_ready_to_assign(self):
        t = self._create("access_request")
        self._route(t["id"])
        self.db.query(models.TaskNotification).delete()
        self.db.commit()
        self._decide(t["id"], "approve")
        self.assertEqual([n.title for n in self._bells(ADMIN)], ["New ticket to assign"])

    def test_only_the_named_approver_decides(self):
        t = self._create("access_request")
        self._route(t["id"])
        with self.assertRaises(HTTPException) as e:
            self._decide(t["id"], "approve", actor=AGENT)
        self.assertEqual(e.exception.status_code, 403)

    def test_an_admin_can_decide_so_an_absent_approver_cannot_deadlock_it(self):
        t = self._create("access_request")
        self._route(t["id"])
        self.assertEqual(self._decide(t["id"], "approve", actor=ADMIN, level=4)["approvalStatus"],
                         "approved")

    def test_rejection_closes_the_ticket(self):
        t = self._create("access_request")
        self._route(t["id"])
        out = self._decide(t["id"], "reject", note="not needed")
        self.assertEqual((out["approvalStatus"], out["status"]), ("rejected", "closed"))

    def test_a_rejected_ticket_stays_unassignable(self):
        t = self._create("access_request")
        self._route(t["id"])
        self._decide(t["id"], "reject", note="no")
        # Not the approval gate any more - it is closed, and _ticket_edit_scope
        # governs. What matters is that nobody is handed work that was refused.
        self.assertEqual(self._row(t["id"]).assignee_email or "", "")


class GateBypassTests(_Case):
    """Ways round the approval gate, found by QA (Aug 2026).

    The gate is decided by the ticket's TYPE at intake, and both holes came from
    the same oversight: nothing re-decided it when the ticket changed underneath.
    """

    def _patch(self, ticket_id, actor=ADMIN, level=4, **kw):
        return tickets.update_ticket(ticket_id, tickets.TicketUpdate(**kw), BackgroundTasks(),
                                     user=self._user(actor, level), db=self.db)

    def _route_and_reject(self, ticket_id):
        tickets.request_approval(ticket_id, tickets.ApprovalRequestBody(approver_email=APPROVER),
                                 BackgroundTasks(), user=self._user(ADMIN, 4), db=self.db)
        tickets.decide_approval(ticket_id, tickets.ApprovalBody(decision="reject", note="no"),
                                BackgroundTasks(), user=self._user(APPROVER), db=self.db)

    # ── re-typing ────────────────────────────────────────────────────────
    def test_re_typing_into_a_gated_type_engages_the_gate(self):
        """Raise it as a Bug Report, switch it to an Access Request. It used to
        keep approval_status "none" - reading as an access request everywhere
        while never having been approved by anybody."""
        t = self._create("bug")
        self.assertEqual(t["approvalStatus"], "none")
        self.assertEqual(self._patch(t["id"], type="access_request")["approvalStatus"], "pending")

    def test_re_typing_takes_the_ticket_off_whoever_was_holding_it(self):
        """They were handed work on a ticket that had not been through approval."""
        t = self._create("bug")
        self._patch(t["id"], assignee_email=AGENT)
        out = self._patch(t["id"], type="service_request")
        self.assertEqual(out["approvalStatus"], "pending")
        self.assertIsNone(out["assigneeId"])
        self.assertIsNone(out["assignedById"])

    def test_re_typing_out_of_a_gated_type_lifts_an_undecided_gate(self):
        """Otherwise a mis-typed ticket sits "awaiting approval" forever with
        nothing left to approve."""
        t = self._create("access_request")
        self.assertEqual(self._patch(t["id"], type="bug")["approvalStatus"], "none")

    def test_a_decision_already_made_survives_re_typing(self):
        """The decision is history - re-typing must not erase that it happened."""
        t = self._create("access_request")
        tickets.request_approval(t["id"], tickets.ApprovalRequestBody(approver_email=APPROVER),
                                 BackgroundTasks(), user=self._user(ADMIN, 4), db=self.db)
        tickets.decide_approval(t["id"], tickets.ApprovalBody(decision="approve", note=""),
                                BackgroundTasks(), user=self._user(APPROVER), db=self.db)
        self.assertEqual(self._patch(t["id"], type="bug")["approvalStatus"], "approved")

    def test_the_admins_are_told_when_a_ticket_is_re_gated(self):
        t = self._create("bug")
        self.db.query(models.TaskNotification).delete()
        self.db.commit()
        self._patch(t["id"], type="access_request")
        self.assertEqual([n.title for n in self._bells(OTHER_ADMIN)], ["Ticket needs approval routing"])

    # ── reopening a refusal ──────────────────────────────────────────────
    def test_reopening_a_rejected_request_sends_it_back_for_approval(self):
        """Reopening is a request to reconsider - it is not the reconsideration.
        It used to resume as though it had been approved."""
        t = self._create("access_request")
        self._route_and_reject(t["id"])
        out = self._patch(t["id"], status="reopened")
        self.assertEqual(out["approvalStatus"], "pending")
        self.assertIsNone(out["approverId"])

    def test_a_rejected_request_cannot_be_assigned_once_reopened(self):
        t = self._create("access_request")
        self._route_and_reject(t["id"])
        self._patch(t["id"], status="reopened")
        with self.assertRaises(HTTPException) as e:
            self._patch(t["id"], assignee_email=AGENT)
        self.assertEqual(e.exception.status_code, 409)

    def test_a_rejected_request_cannot_be_assigned_while_still_closed(self):
        t = self._create("access_request")
        self._route_and_reject(t["id"])
        with self.assertRaises(HTTPException) as e:
            self._patch(t["id"], assignee_email=AGENT)
        self.assertEqual(e.exception.status_code, 409)

    def test_reopening_an_ordinary_resolved_ticket_is_untouched(self):
        """The reset is scoped to refusals - a normal reopen must not suddenly
        demand an approval the ticket never needed."""
        t = self._create("bug")
        self._patch(t["id"], assignee_email=AGENT)
        self._patch(t["id"], status="resolved")
        self.assertEqual(self._patch(t["id"], status="reopened")["approvalStatus"], "none")


class AssignedByTests(_Case):
    """Who handed the ticket over - stamped by the server, never sent."""

    def _assign(self, ticket_id, actor=ADMIN, to=AGENT):
        body = tickets.TicketUpdate(assignee_email=to)
        return tickets.update_ticket(ticket_id, body, BackgroundTasks(),
                                     user=self._user(actor, 4), db=self.db)

    def test_it_records_the_admin_who_assigned_it(self):
        t = self._create("bug")
        self.assertEqual(self._assign(t["id"])["assignedById"], ADMIN)

    def test_it_is_blank_until_somebody_assigns_it(self):
        self.assertIsNone(self._create("bug")["assignedById"])

    def test_reassignment_re_stamps_it(self):
        t = self._create("bug")
        self._assign(t["id"])
        self.assertEqual(self._assign(t["id"], actor=OTHER_ADMIN, to=LEAD)["assignedById"],
                         OTHER_ADMIN)

    def test_unassigning_clears_it(self):
        """Otherwise it credits someone with an assignment that no longer exists."""
        t = self._create("bug")
        self._assign(t["id"])
        self.assertIsNone(self._assign(t["id"], to="")["assignedById"])

    def test_the_activity_log_says_who(self):
        t = self._create("bug")
        self._assign(t["id"])
        details = [a.detail for a in self.db.query(models.TaskActivity).all()
                   if a.type == "assigned"]
        self.assertEqual(details, [f"assigned to {AGENT} by {ADMIN}"])


if __name__ == "__main__":
    unittest.main()
