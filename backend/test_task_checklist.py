"""
Checklist tests (Oct 2026): the lines inside a task, their counters on the
task row, who may tick what, and the copies a recurrence and a project
template make.

Uses a throwaway sqlite file. No network.

Run with: python -m unittest test_task_checklist -v
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import task_notify  # noqa: E402
from routers.task_util import gen_id, now_iso, purge_task_permanently  # noqa: E402
from routers.tasks import (  # noqa: E402
    create_task, update_task, TaskCreate, TaskUpdate,
    list_checklist, add_checklist_items, update_checklist_item, delete_checklist_item, reorder_checklist,
    ChecklistItemCreate, ChecklistItemUpdate, ChecklistOrder, delete_task,
)

MANAGER = {"email": "boss@greensglobal.com", "level": 3}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
READER = {"email": "reader@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}


class ChecklistTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls._real_notify = task_notify.notify_task_event
        task_notify.notify_task_event = lambda *a, **kw: None

    @classmethod
    def tearDownClass(cls):
        task_notify.notify_task_event = cls._real_notify
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskChecklistItem, models.TaskActivity, models.TaskProject,
                  models.TaskNotification, models.TaskDeleteLog):
            self.db.query(m).delete()
        self.db.commit()
        self.bg = BackgroundTasks()
        # A restricted project: the manager owns it, EDITOR edits, READER views.
        self.project = models.TaskProject(
            id=gen_id(), name="Restricted", access_level="restricted", owner_email=MANAGER["email"],
            member_emails=[EDITOR["email"], READER["email"]],
            member_roles={EDITOR["email"]: "editor", READER["email"]: "viewer"},
            created_at=now_iso(), modified_at=now_iso())
        self.db.add(self.project)
        self.db.commit()
        self.task = create_task(TaskCreate(title="Monthly close", project_id=self.project.id,
                                           assignee_emails=[EDITOR["email"]]),
                                self.bg, user=MANAGER, db=self.db)

    def tearDown(self):
        self.db.close()

    def _add(self, user=MANAGER, **kw):
        return add_checklist_items(self.task["id"], ChecklistItemCreate(**kw), user=user, db=self.db)

    def _row(self):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == self.task["id"]).first()

    # ── adding and counters ─────────────────────────────────────────────────
    def test_add_one_and_several_keep_the_counters(self):
        out = self._add(title="Reconcile bank")
        self.assertEqual(out["task"]["checklistTotal"], 1)
        self.assertEqual(out["task"]["checklistDone"], 0)
        out = self._add(title="", titles=["Post journals", "  ", "Send report"])
        self.assertEqual([i["title"] for i in out["items"]], ["Post journals", "Send report"])
        self.assertEqual(out["task"]["checklistTotal"], 3)
        rows = list_checklist(self.task["id"], user=MANAGER, db=self.db)
        self.assertEqual([r["title"] for r in rows], ["Reconcile bank", "Post journals", "Send report"])

    def test_blank_title_is_refused(self):
        with self.assertRaises(HTTPException):
            self._add(title="   ")

    def test_tick_untick_and_activity(self):
        item = self._add(title="Reconcile bank")["items"][0]
        out = update_checklist_item(item["id"], ChecklistItemUpdate(done=True), user=EDITOR, db=self.db)
        self.assertTrue(out["item"]["done"])
        self.assertEqual(out["item"]["doneBy"], EDITOR["email"])
        self.assertEqual(out["task"]["checklistDone"], 1)
        acts = self.db.query(models.TaskActivity).filter(models.TaskActivity.type == "checklist_done").all()
        self.assertEqual(len(acts), 1)
        self.assertIn("Reconcile bank", acts[0].detail)
        out = update_checklist_item(item["id"], ChecklistItemUpdate(done=False), user=EDITOR, db=self.db)
        self.assertEqual(out["task"]["checklistDone"], 0)
        self.assertFalse(out["item"]["doneBy"])

    def test_delete_recounts(self):
        a = self._add(title="a")["items"][0]
        self._add(title="b")
        update_checklist_item(a["id"], ChecklistItemUpdate(done=True), user=MANAGER, db=self.db)
        out = delete_checklist_item(a["id"], user=MANAGER, db=self.db)
        self.assertEqual((out["task"]["checklistTotal"], out["task"]["checklistDone"]), (1, 0))

    def test_reorder(self):
        ids = [i["id"] for i in self._add(title="", titles=["a", "b", "c"])["items"]]
        rows = reorder_checklist(self.task["id"], ChecklistOrder(ids=[ids[2], ids[0]]), user=MANAGER, db=self.db)
        self.assertEqual([r["title"] for r in rows], ["c", "a", "b"], "unlisted ids keep their place after the listed ones")

    # ── who may do what ─────────────────────────────────────────────────────
    def test_a_viewer_cannot_add_but_can_read(self):
        with self.assertRaises(HTTPException) as cm:
            self._add(user=READER, title="x")
        self.assertEqual(cm.exception.status_code, 403)
        self._add(title="x")
        self.assertEqual(len(list_checklist(self.task["id"], user=READER, db=self.db)), 1)

    def test_an_outsider_sees_nothing(self):
        self._add(title="x")
        with self.assertRaises(HTTPException):
            list_checklist(self.task["id"], user=OUTSIDER, db=self.db)

    def test_the_person_a_line_names_can_tick_it_as_a_viewer(self):
        item = self._add(title="Reader's step", assignee_email=READER["email"])["items"][0]
        bells = self.db.query(models.TaskNotification).filter(models.TaskNotification.for_email == READER["email"]).all()
        self.assertEqual(len(bells), 1, "being given a line is a bell")
        out = update_checklist_item(item["id"], ChecklistItemUpdate(done=True), user=READER, db=self.db)
        self.assertTrue(out["item"]["done"])
        with self.assertRaises(HTTPException):
            update_checklist_item(item["id"], ChecklistItemUpdate(title="renamed"), user=READER, db=self.db)
        other = self._add(title="Not theirs")["items"][0]
        with self.assertRaises(HTTPException):
            update_checklist_item(other["id"], ChecklistItemUpdate(done=True), user=READER, db=self.db)

    # ── copies ──────────────────────────────────────────────────────────────
    def test_a_recurring_occurrence_carries_the_checklist_unticked(self):
        self._add(title="", titles=["Reconcile bank", "Post journals"])
        update_task(self.task["id"], TaskUpdate(recurrence={"freq": "monthly", "dayOfMonth": 1}, due_on="2026-10-01"),
                    self.bg, user=MANAGER, db=self.db)
        items = self.db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == self.task["id"]).all()
        update_checklist_item(items[0].id, ChecklistItemUpdate(done=True), user=MANAGER, db=self.db)
        update_task(self.task["id"], TaskUpdate(completed=True), self.bg, user=MANAGER, db=self.db)
        nxt = (self.db.query(models.Task).filter(models.Task.id != self.task["id"],
                                                  models.Task.title == "Monthly close").first())
        self.assertIsNotNone(nxt)
        copied = (self.db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == nxt.id)
                  .order_by(models.TaskChecklistItem.position).all())
        self.assertEqual([c.title for c in copied], ["Reconcile bank", "Post journals"])
        self.assertFalse(any(c.done for c in copied))
        self.assertEqual((nxt.checklist_total, nxt.checklist_done), (2, 0))

    def test_a_project_template_carries_and_rebuilds_the_checklist(self):
        from routers.task_projects import (create_project_template, use_project_template,
                                           ProjectTemplateBody, UseTemplateBody)
        self._add(title="", titles=["Reconcile bank", "Post journals"])
        tpl = create_project_template(ProjectTemplateBody(project_id=self.project.id, name="Close blueprint"),
                                      user=MANAGER, db=self.db)
        specs = tpl["payload"]["tasks"] if "payload" in tpl else None
        if specs is None:
            row = self.db.query(models.TaskProjectTemplate).filter(models.TaskProjectTemplate.id == tpl["id"]).first()
            specs = row.payload["tasks"]
        self.assertEqual(specs[0]["checklist"], ["Reconcile bank", "Post journals"])
        built = use_project_template(tpl["id"], UseTemplateBody(name="October close"), user=MANAGER, db=self.db)
        new_pid = built["id"] if "id" in built else built["project"]["id"]
        new_task = self.db.query(models.Task).filter(models.Task.project_id == new_pid).first()
        lines = (self.db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == new_task.id)
                 .order_by(models.TaskChecklistItem.position).all())
        self.assertEqual([x.title for x in lines], ["Reconcile bank", "Post journals"])
        self.assertEqual((new_task.checklist_total, new_task.checklist_done), (2, 0))

    def test_purge_removes_the_lines(self):
        self._add(title="x")
        delete_task(self.task["id"], self.bg, user=MANAGER, db=self.db)
        self.assertTrue(purge_task_permanently(self.db, self.task["id"], MANAGER["email"]))
        self.db.commit()
        self.assertEqual(self.db.query(models.TaskChecklistItem).count(), 0)


if __name__ == "__main__":
    unittest.main()
