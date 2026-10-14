"""
Tasks from tickets (Oct 14 2026, Sagar: "do we have a track on the tasks
which are being created by a ticket?"). Create Task from Ticket is one server
call: the task, its source_ticket_id and the ticket's task_ids land together,
with a line in both histories. Linking and unlinking keep the task's way back
in step; completing the last open task tells whoever works the ticket.

Uses a throwaway sqlite file. No network.
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import database
import models
from routers.task_util import now_iso, gen_id
from routers import tickets as T
from routers.tasks import update_task, TaskUpdate

REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
AGENT = {"email": "agent@greensglobal.com", "level": 1}
MANAGER = {"email": "manager@greensglobal.com", "level": 3}


class TicketTaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        import auth
        self._grants = auth._grants_for
        auth._grants_for = lambda email, db: ({"tickets": 99, "tasks": 99} if email in (AGENT["email"], MANAGER["email"]) else {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.Task, models.TaskNotification, models.TaskActivity):
            self.db.query(m).delete()
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    def _ticket(self, **kw):
        kw.setdefault("status", "open")
        t = models.TaskTicket(id="tk1", code="000123", subject="Printer jammed", description="Tray 2",
                              priority="high", requester_email=REQUESTER["email"],
                              watcher_emails=["urmi@greensglobal.com"], sla_due_on="2026-10-20T17:00:00",
                              created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _create(self, user=MANAGER):
        out = T.create_task_from_ticket("tk1", BackgroundTasks(), user=user, db=self.db)
        self.db.expire_all()
        return out

    def _activity(self, entity_id):
        return [(a.type, a.detail) for a in self.db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_id == entity_id).all()]

    def test_create_links_both_sides_in_one_go(self):
        self._ticket(assignee_email=AGENT["email"], status="in_progress")
        out = self._create(user=AGENT)   # the assignee working it
        task = self.db.get(models.Task, out["task"]["id"])
        self.assertEqual(task.source_ticket_id, "tk1")
        self.assertEqual(out["task"]["sourceTicketId"], "tk1")
        self.assertEqual(self.db.get(models.TaskTicket, "tk1").task_ids, [task.id])
        self.assertEqual(out["ticket"]["taskIds"], [task.id])
        # What it carries over: subject, priority, the SLA day, the assignee,
        # and the ticket's collaborators - never the requester.
        self.assertEqual((task.title, task.priority, task.due_on), ("Printer jammed", "high", "2026-10-20"))
        self.assertEqual(task.assignee_emails, [AGENT["email"]])
        self.assertIn("urmi@greensglobal.com", task.follower_emails)
        self.assertNotIn(REQUESTER["email"], task.follower_emails)

    def test_both_histories_say_so(self):
        self._ticket()
        out = self._create()
        self.assertIn("task_created", [k for k, _ in self._activity("tk1")])
        self.assertTrue(any(k == "task_created" and d.startswith("created this task from Ticket #123") for k, d in self._activity(out["task"]["id"])))

    def test_someone_locked_out_cannot_add_tasks(self):
        # Same rule as the ticket's task_ids field: not this agent's ticket.
        self._ticket(status="in_progress", assignee_email="someone@greensglobal.com")
        with self.assertRaises(HTTPException):
            self._create(user=AGENT)
        self.assertEqual(self.db.query(models.Task).count(), 0)

    def _task(self, title="Swap the roller"):
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:4]}", title=title, status="not_started",
                        created_at=now_iso(), modified_at=now_iso(), created_by=AGENT["email"])
        self.db.add(t)
        self.db.commit()
        return t

    def test_linking_and_unlinking_keep_the_task_in_step(self):
        self._ticket()
        task = self._task()
        T.update_ticket("tk1", T.TicketUpdate(task_ids=[task.id]), BackgroundTasks(), user=MANAGER, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, task.id).source_ticket_id, "tk1")
        T.update_ticket("tk1", T.TicketUpdate(task_ids=[]), BackgroundTasks(), user=MANAGER, db=self.db)
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, task.id).source_ticket_id, "")
        kinds = [k for k, _ in self._activity(task.id)]
        self.assertEqual(kinds, ["task_linked", "task_unlinked"])

    def test_the_last_task_done_tells_the_ticket_assignee(self):
        self._ticket(assignee_email=AGENT["email"], status="in_progress")
        a = self._create()["task"]["id"]
        b = self._create()["task"]["id"]
        update_task(a, TaskUpdate(completed=True), BackgroundTasks(), user=MANAGER, db=self.db)

        def bells():
            return (self.db.query(models.TaskNotification)
                    .filter(models.TaskNotification.kind == "ticket_tasks_done").count())
        self.assertEqual(bells(), 0)   # one still open
        update_task(b, TaskUpdate(completed=True), BackgroundTasks(), user=MANAGER, db=self.db)
        self.assertEqual(bells(), 1)
        self.assertEqual(self.db.get(models.TaskTicket, "tk1").status, "in_progress")   # told, not resolved
        self.assertEqual([k for k, _ in self._activity("tk1")].count("task_completed"), 2)


if __name__ == "__main__":
    unittest.main()
