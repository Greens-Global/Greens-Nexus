"""
Who may use the Support desk, and who may only ask it for help.

503f052 made Tasks + Tickets grant-driven and put
require_any_module_grant("tasks","tickets") on the WHOLE tickets router. That
also covered the requester-facing endpoints, so every employee without one of
those grants got 403s on the company-wide Support page:

    GET /task-tickets?mine=true   -> "You don't have access to this screen"
    GET /ticket-departments       -> "No departments to choose from"

An Access Group decides who WORKS the queue, not who may ASK for help. These
tests pin both halves of that line - the self-service endpoints stay open, and
the desk endpoints stay shut.

Uses a throwaway sqlite file. No network.
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import HTTPException, BackgroundTasks

import database
import models
from routers.task_util import gen_id, now_iso
from routers import tickets as T

EMPLOYEE = {"email": "employee@greensglobal.com", "level": 1}   # no grant at all
AGENT    = {"email": "agent@greensglobal.com", "level": 1}      # granted via a group
ADMIN    = {"email": "admin@greensglobal.com", "level": 4}


class TicketAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity,
                  models.NexusGroup, models.NexusGroupMember):
            self.db.query(m).delete()
        # A group granting `tickets` is what puts somebody on the desk.
        g = models.NexusGroup(id="g1", name="Service Desk", allowed_modules="tickets:editor")
        self.db.add(g)
        self.db.add(models.NexusGroupMember(group_id="g1", email=AGENT["email"]))
        self.mine = self._ticket("my broken laptop", requester=EMPLOYEE["email"])
        self.theirs = self._ticket("somebody else's problem", requester="other@greensglobal.com")
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _ticket(self, subject, requester="", watchers=None):
        t = models.TaskTicket(id=gen_id(), code=f"TIC-{subject[:3]}", subject=subject,
                              status="new", priority="medium", requester_email=requester,
                              watcher_emails=watchers or [], created_at=now_iso(),
                              modified_at=now_iso())
        self.db.add(t)
        self.db.commit()
        return t

    # ── the self-service half: must work with NO grant ───────────────────────
    def test_an_employee_can_read_their_own_tickets(self):
        rows = T.list_tickets(mine=True, user=EMPLOYEE, db=self.db)

        self.assertEqual([r["subject"] for r in rows], ["my broken laptop"])

    def test_an_employee_can_see_the_departments_the_form_needs(self):
        """The submit form is unusable without this - "No departments to choose
        from" was the visible symptom."""
        self.assertIsInstance(T.list_ticket_departments(user=EMPLOYEE, db=self.db), list)

    def test_an_employee_can_see_the_companies_the_form_needs(self):
        self.assertIsInstance(T.list_ticket_companies(db=self.db), list)

    def test_an_employee_can_read_the_conversation_on_their_own_ticket(self):
        out = T.list_ticket_comments(self.mine.id, user=EMPLOYEE, db=self.db)

        self.assertEqual(out, [])

    def test_a_watcher_counts_as_a_participant(self):
        watched = self._ticket("cc'd on this", requester="other@greensglobal.com",
                               watchers=[EMPLOYEE["email"]])

        T.list_ticket_comments(watched.id, user=EMPLOYEE, db=self.db)   # must not raise

    # ── the scoping: self-service must not become the queue ──────────────────
    def test_the_unscoped_list_is_forced_to_their_own_without_a_grant(self):
        """`mine` decided in the browser would put the whole company's queue one
        query parameter away."""
        rows = T.list_tickets(mine=False, user=EMPLOYEE, db=self.db)

        self.assertEqual([r["subject"] for r in rows], ["my broken laptop"])

    def test_an_agent_gets_the_whole_queue(self):
        rows = T.list_tickets(mine=False, user=AGENT, db=self.db)

        self.assertEqual(len(rows), 2)

    def test_an_employee_cannot_read_somebody_elses_ticket(self):
        with self.assertRaises(HTTPException) as ctx:
            T.list_ticket_comments(self.theirs.id, user=EMPLOYEE, db=self.db)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_an_employee_cannot_raise_a_ticket_as_somebody_else(self):
        body = T.TicketBody(subject="not mine to file", requester_email="ceo@greensglobal.com")

        out = T.create_ticket(body, BackgroundTasks(), user=EMPLOYEE, db=self.db)

        self.assertEqual(out["requesterId"], EMPLOYEE["email"])

    def test_an_agent_may_raise_one_on_behalf_of_somebody(self):
        body = T.TicketBody(subject="phoned in", requester_email="caller@greensglobal.com")

        out = T.create_ticket(body, BackgroundTasks(), user=AGENT, db=self.db)

        self.assertEqual(out["requesterId"], "caller@greensglobal.com")

    def test_an_employees_note_can_never_be_internal(self):
        """Internal notes are the desk talking among themselves, and are hidden
        from the requester - so the requester must not be able to write one."""
        body = T.TicketCommentBody(body="please hurry", internal=True)

        T.add_ticket_comment(self.mine.id, body, BackgroundTasks(), user=EMPLOYEE, db=self.db)

        c = self.db.query(models.TaskComment).filter_by(task_id=self.mine.id).one()
        self.assertFalse(c.internal)

    # ── the desk half: still shut without a grant ────────────────────────────
    def test_the_desk_dependency_refuses_an_employee(self):
        with self.assertRaises(HTTPException) as ctx:
            T.require_ticket_desk(user=EMPLOYEE, db=self.db)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_the_desk_dependency_admits_a_granted_agent(self):
        self.assertEqual(T.require_ticket_desk(user=AGENT, db=self.db), AGENT)

    def test_the_desk_dependency_admits_an_administrator(self):
        self.assertEqual(T.require_ticket_desk(user=ADMIN, db=self.db), ADMIN)

    def test_every_mutating_desk_route_still_carries_the_guard(self):
        """The whole point of the split - if a future edit drops the dependency
        from one of these, the queue opens to everybody."""
        from fastapi.routing import APIRoute
        must_be_guarded = {
            ("PATCH", "/task-tickets/{ticket_id}"),
            ("DELETE", "/task-tickets/{ticket_id}"),
            ("POST", "/task-tickets/{ticket_id}/escalate"),
            ("POST", "/task-tickets/{ticket_id}/approval"),
            ("POST", "/task-ticket-components"),
            ("PUT", "/task-tickets/notify/settings"),
        }
        seen = set()
        for r in T.router.routes:
            if not isinstance(r, APIRoute):
                continue
            guarded = any(getattr(getattr(d, "dependency", None), "__qualname__", "")
                          .startswith("require_any_module_grant") for d in r.dependencies)
            for method in r.methods:
                if (method, r.path) in must_be_guarded and guarded:
                    seen.add((method, r.path))
        self.assertEqual(seen, must_be_guarded)


if __name__ == "__main__":
    unittest.main()
