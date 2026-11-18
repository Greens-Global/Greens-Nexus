"""Tasks grant levels at the CREATE boundary (11/12/2026,
routers/task_util.require_task_creator): a Viewer reads and works what is
shared with them but starts nothing new; Editor creates tasks, projects and
imports; the Manager tier keeps creating as before; Manage is the tier's and Full's.

    python -m pytest test_levels_tasks.py
"""
import unittest

import levels_testkit as kit

kit.bind_db()

from fastapi.testclient import TestClient  # noqa: E402
import database  # noqa: E402
import main  # noqa: E402
import models  # noqa: E402

models.Base.metadata.create_all(bind=database.engine)

D = "@greensglobal.com"
VIEWER, EDITOR, FULL, MGR = "tk.viewer" + D, "tk.editor" + D, "tk.full" + D, "tk.mgr" + D


class TasksLevelTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        db = database.SessionLocal()
        try:
            kit.reset(db, models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification)
            for em in (VIEWER, EDITOR, FULL):
                kit.person(db, em)
            kit.person(db, MGR, role="manager")
            kit.grant(db, VIEWER, "tasks:viewer")
            kit.grant(db, EDITOR, "tasks:editor")
            kit.grant(db, FULL, "tasks:full")
            kit.grant(db, MGR, "tasks:viewer")
            db.commit()
        finally:
            db.close()
        kit.refresh()

    def test_viewer_reads_but_creates_nothing(self):
        kit.as_(VIEWER)
        self.assertEqual(self.client.get("/tasks").status_code, 200)
        self.assertEqual(self.client.post("/tasks", json={"title": "Fix the gate"}).status_code, 403)
        self.assertEqual(self.client.post("/task-projects", json={"name": "Yard"}).status_code, 403)
        self.assertEqual(self.client.post("/tasks/import", json={"rows": [], "dry_run": True}).status_code, 403)

    def test_editor_creates(self):
        kit.as_(EDITOR)
        self.assertEqual(self.client.post("/tasks", json={"title": "Fix the gate"}).status_code, 201)
        self.assertEqual(self.client.post("/task-projects", json={"name": "Yard"}).status_code, 201)

    def test_manager_with_a_viewer_grant_keeps_creating(self):
        kit.as_(MGR)
        self.assertEqual(self.client.post("/tasks", json={"title": "Fix the gate"}).status_code, 201)

    def test_manage_is_the_tiers_and_fulls(self):
        # Inside the Tasks routers a Full grant acts as a manager
        # (auth.module_owner_acts_as, Owner retired 11/12/2026); Editor does not.
        kit.as_(EDITOR)
        self.assertEqual(self.client.get("/tasks/activity").status_code, 401)
        kit.as_(FULL)
        self.assertEqual(self.client.post("/tasks", json={"title": "Fix the gate"}).status_code, 201)
        self.assertEqual(self.client.get("/tasks/activity").status_code, 200)


if __name__ == "__main__":
    unittest.main()
