"""
Convert to Ticket (Neil, 10/05): a task that should have been a ticket.

The ticket form opens pre-filled from the task; on create (from_task_id) the
server links the ticket back to the task, files the task's attachments on
the ticket, leaves a note on the task pointing at the ticket, and closes the
task when close_source_task is set. Someone who cannot see the task cannot
convert it, and nothing is created.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run.

Run with: python -m unittest test_ticket_convert
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException   # noqa: E402

import database                                       # noqa: E402
import models                                         # noqa: E402
from routers.task_util import gen_id, now_iso         # noqa: E402
from routers import tickets as T                      # noqa: E402

ME = {"email": "amy@greensglobal.com", "role": "employee", "level": 1}
STRANGER = {"email": "bob@greensglobal.com", "role": "employee", "level": 1}


class ConvertTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.Task, models.TaskActivity, models.TaskComment, models.TaskAttachment,
                  models.NexusEmployee, models.NexusNotification, models.TaskNotification, models.TaskProject):
            self.db.query(m).delete()
        for email in (ME["email"], STRANGER["email"]):
            self.db.add(models.NexusEmployee(id=gen_id(), first_name=email.split("@")[0], work_email=email,
                                             status="active", identity_type="internal"))
        self.db.add(models.TaskProject(id="p1", name="Facilities", access_level="restricted", owner_email=ME["email"]))
        now = now_iso()
        self.task = models.Task(id=gen_id(), title="Light out in the front office", description="<p>Since Monday</p>",
                                priority="high", project_id="p1", owner_email=ME["email"], created_by=ME["email"],
                                assignee_email=ME["email"], assignee_emails=[ME["email"]], status="not_started",
                                created_at=now, modified_at=now)
        self.db.add(self.task)
        for name in ("photo.jpg", "floorplan.pdf"):
            self.db.add(models.TaskAttachment(id=gen_id(), task_id=self.task.id, name=name, size="10 KB",
                                              kind="image" if name.endswith("jpg") else "file",
                                              url=f"https://x.supabase.co/storage/v1/object/public/task-files/{name}",
                                              added_at=now, added_by=ME["email"]))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _convert(self, user=ME, close=True):
        body = T.TicketBody(subject=self.task.title, description=self.task.description, priority="high",
                            from_task_id=self.task.id, close_source_task=close)
        return T.create_ticket(body, BackgroundTasks(), user=user, db=self.db)

    def _task(self):
        self.db.expire_all()
        return self.db.get(models.Task, self.task.id)

    def _comments(self):
        self.db.expire_all()
        return [c.body for c in self.db.query(models.TaskComment).filter(models.TaskComment.task_id == self.task.id)]

    def test_the_ticket_links_back_and_takes_the_files(self):
        out = self._convert()
        t = self.db.get(models.TaskTicket, out["id"])
        self.assertEqual(t.linked_task_id, self.task.id)
        files = self.db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == t.id).all()
        self.assertEqual(sorted(a.name for a in files), ["floorplan.pdf", "photo.jpg"])
        self.assertTrue(all("/task-files/" in a.url for a in files))   # the same stored copies

    def test_the_task_is_closed_and_points_at_the_ticket(self):
        out = self._convert()
        self.assertTrue(out["sourceTaskClosed"])
        self.assertTrue(self._task().completed)
        [note] = self._comments()
        self.assertIn(f"/tickets?ticket={out['id']}", note)
        self.assertIn("this task is closed", note)

    def test_left_open_when_asked(self):
        out = self._convert(close=False)
        self.assertFalse(out["sourceTaskClosed"])
        self.assertFalse(self._task().completed)
        [note] = self._comments()
        self.assertIn("Converted to <a", note)
        self.assertNotIn("closed", note)

    def test_someone_who_cannot_see_the_task_cannot_convert_it(self):
        with self.assertRaises(HTTPException) as ctx:
            self._convert(user=STRANGER)
        self.assertIn(ctx.exception.status_code, (403, 404))
        self.assertEqual(self.db.query(models.TaskTicket).count(), 0)

    def test_a_deleted_task_cannot_be_converted(self):
        self.task.deleted_at = now_iso()
        self.db.commit()
        with self.assertRaises(HTTPException) as ctx:
            self._convert()
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(self.db.query(models.TaskTicket).count(), 0)

    def test_a_plain_ticket_is_unchanged(self):
        out = T.create_ticket(T.TicketBody(subject="Printer jam"), BackgroundTasks(), user=ME, db=self.db)
        self.assertNotIn("sourceTaskClosed", out)
        self.assertEqual(self.db.get(models.TaskTicket, out["id"]).linked_task_id, "")


if __name__ == "__main__":
    unittest.main()
