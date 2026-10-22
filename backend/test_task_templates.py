"""
Save as Template / Use (Neil, Oct 14 2026: "convert to task template", the
way project templates work). A template saved from a task keeps its subtasks
whole - people, priority, fields, repeat setting, checklists and due dates
relative to the main task - plus the main task's own fields, recurrence and
checklist. Using it builds all of that in one go; older title-only templates
still work.

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
from routers import task_config as C

MANAGER = {"email": "neil@greensglobal.com", "level": 3}
EMPLOYEE = {"email": "sai@greensglobal.com", "level": 1}
YEARLY = {"freq": "yearly", "monthOfYear": 4, "dayOfMonth": 15, "nextOccurrenceId": "x", "count": 3}


class TaskTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskTemplate, models.TaskChecklistItem, models.TaskActivity, models.TaskNotification,
                  models.TaskCustomField):
            self.db.query(m).delete()
        # The Entity field the values below belong to.
        self.db.add(models.TaskCustomField(id="ent", name="Entity", type="text"))
        # The people the template puts on its tasks are in the directory - an
        # assignee or collaborator must be a current person (Oct 21 2026).
        self.db.query(models.NexusEmployee).delete()
        for who in ("viral@greensglobal.com", "urmi@greensglobal.com", "neil@greensglobal.com"):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=who, first_name=who.split("@")[0],
                                             status="active", company=""))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _add(self, **kw):
        kw.setdefault("status", "not_started")
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:5]}", created_at=now_iso(), modified_at=now_iso(),
                        created_by=MANAGER["email"], **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def _item(self, task, title, who=""):
        self.db.add(models.TaskChecklistItem(id=gen_id(), task_id=task.id, title=title, done=True,
                                             assignee_email=who, position=0.0, created_at=now_iso()))
        self.db.commit()

    def _tax_return(self):
        main = self._add(title="Tax Return - RJK", due_on="2026-04-15", status="recurring", recurrence=dict(YEARLY),
                         priority="high", custom_field_values={"ent": "rjk"},
                         assignee_email="viral@greensglobal.com", assignee_emails=["viral@greensglobal.com"],
                         follower_emails=["neil@greensglobal.com"], description="Every April")
        k1 = self._add(title="Collect K-1s", parent_task_id=main.id, position=0.0, due_on="2026-03-01",
                       completed=True, custom_field_values={"ent": "rjk"},
                       assignee_email="urmi@greensglobal.com", assignee_emails=["urmi@greensglobal.com"])
        self._add(title="File extension", parent_task_id=main.id, position=1.0, recurrence={"skip": True})
        self._item(main, "Confirm the entity list")
        self._item(k1, "Ask the bank", "urmi@greensglobal.com")
        return main

    def _save(self, task, **kw):
        return C.save_task_as_template(task.id, C.SaveAsTemplateBody(**kw), user=MANAGER, db=self.db)

    def _use(self, tpl_id, **kw):
        out = C.use_template(tpl_id, C.UseTemplateBody(**kw), BackgroundTasks(), user=MANAGER, db=self.db)
        self.db.expire_all()
        return self.db.get(models.Task, out["id"])

    def test_saving_keeps_the_subtasks_whole(self):
        tpl = self._save(self._tax_return(), name="Yearly Tax Return")
        self.assertEqual(tpl["subtaskTitles"], ["Collect K-1s", "File extension"])
        k1 = tpl["subtasks"][0]
        self.assertEqual((k1["dueOffsetDays"], k1["assigneeIds"]), (-45, ["urmi@greensglobal.com"]))
        self.assertEqual(k1["checklist"], [{"title": "Ask the bank", "assigneeId": "urmi@greensglobal.com"}])
        self.assertEqual(tpl["subtasks"][1]["recurrence"], {"skip": True})
        # The rule without its series markers.
        self.assertEqual(tpl["patch"]["recurrence"], {"freq": "yearly", "monthOfYear": 4, "dayOfMonth": 15})
        self.assertEqual(tpl["checklist"], [{"title": "Confirm the entity list", "assigneeId": ""}])

    def test_parts_left_out_are_not_kept(self):
        tpl = self._save(self._tax_return(), parts=["subtasks"])
        self.assertNotIn("assigneeIds", tpl["patch"])
        self.assertNotIn("recurrence", tpl["patch"])
        self.assertNotIn("checklist", tpl["subtasks"][0])
        self.assertEqual(tpl["checklist"], [])

    def test_using_it_builds_everything_from_a_new_due_date(self):
        tpl = self._save(self._tax_return())
        new = self._use(tpl["id"], title="Tax Return - Greens Austin", due_on="2027-04-15",
                        custom_field_values={"ent": "aus"})
        self.assertEqual((new.title, new.due_on, new.status, new.priority), ("Tax Return - Greens Austin", "2027-04-15", "recurring", "high"))
        self.assertEqual(new.recurrence, {"freq": "yearly", "monthOfYear": 4, "dayOfMonth": 15})
        self.assertEqual(new.custom_field_values, {"ent": "aus"})
        subs = (self.db.query(models.Task).filter(models.Task.parent_task_id == new.id)
                .order_by(models.Task.position).all())
        self.assertEqual([s.title for s in subs], ["Collect K-1s", "File extension"])
        self.assertEqual(new.subtask_ids, [s.id for s in subs])
        k1 = subs[0]
        self.assertEqual((k1.due_on, k1.completed, k1.custom_field_values), ("2027-03-01", False, {"ent": "aus"}))
        self.assertEqual(k1.assignee_emails, ["urmi@greensglobal.com"])
        self.assertEqual(subs[1].recurrence, {"skip": True})
        items = self.db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == k1.id).all()
        self.assertEqual([(i.title, i.done) for i in items], [("Ask the bank", False)])
        self.assertEqual((new.checklist_total, k1.checklist_total), (1, 1))

    def test_an_older_title_only_template_still_works(self):
        self.db.add(models.TaskTemplate(id="old", name="Onboarding", patch={"priority": "low"},
                                        subtask_titles=["Laptop", "Badge"], created_at=now_iso()))
        self.db.commit()
        new = self._use("old")
        self.assertEqual((new.title, new.priority), ("Onboarding", "low"))
        self.assertEqual(sorted(s.title for s in self.db.query(models.Task).filter(models.Task.parent_task_id == new.id)),
                         ["Badge", "Laptop"])

    def test_whoever_saved_it_may_delete_it_and_others_may_not(self):
        tpl = self._save(self._tax_return())
        with self.assertRaises(HTTPException):
            C.delete_template(tpl["id"], user=EMPLOYEE, db=self.db)
        C.delete_template(tpl["id"], user=MANAGER, db=self.db)
        self.db.expire_all()
        self.assertTrue(self.db.query(models.TaskTemplate).execution_options(include_deleted=True)
                        .filter(models.TaskTemplate.id == tpl["id"]).one().deleted_at)


if __name__ == "__main__":
    unittest.main()
