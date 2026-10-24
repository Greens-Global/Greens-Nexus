"""
Automation gaps vs Monday recipes (task_automation.py, Neil, Oct 22 2026).

New triggers (custom field changes, due date changes), the custom field
condition, and the actions create_task / move_to_project / send_email /
set_custom_field - driven through the REAL request paths (create_task,
update_task, bulk_update) and the scheduled scan, with the loop guards, the
company wall, restricted tasks and the batched email queue.

Throwaway SQLite, no network: graph_mail.send_mail is replaced by a recorder,
so a test can see that a held email was NOT sent and that one that goes out
went through notify_task_event's send log.

Run with: python -m pytest test_task_automation_gaps.py -q
"""
import os
import tempfile
import unittest
from datetime import timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import cache  # noqa: E402
import database  # noqa: E402
import graph_mail  # noqa: E402
import models  # noqa: E402
import task_automation  # noqa: E402
import task_mail_templates as tmpl  # noqa: E402
import task_notify  # noqa: E402
import task_notify_prefs  # noqa: E402
from routers.task_util import gen_id, now_iso, task_assignees  # noqa: E402
from routers.tasks import create_task, update_task, bulk_update, TaskCreate, TaskUpdate, BulkUpdate  # noqa: E402
from routers.task_config import create_rule, update_rule, RuleBody  # noqa: E402


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

COA, COB = "co-a", "co-b"
BOSS = {"email": "boss@greensglobal.com", "level": 3}
SAM = "sam@greensglobal.com"
PRIYA = "priya@greensglobal.com"
BEN = "ben@greensglobal.com"            # company B
TODAY = task_automation.business_today()

_CLEAR = (models.Task, models.TaskComment, models.TaskActivity, models.TaskProject, models.TaskSection,
          models.TaskAutomationRule, models.TaskAutomationRun, models.TaskNotification, models.NexusEmployee,
          models.TaskCustomField, models.TaskEmailQueue, models.TaskEmailLog, models.TaskNotifyPref,
          models.NexusSetting, models.NexusNotification)


class GapsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        cls._real_send = graph_mail.send_mail

        def _no_direct_mail(**kw):
            cls.mailed.append(kw)
            return {"messageId": "m"}
        graph_mail.send_mail = _no_direct_mail

    @classmethod
    def tearDownClass(cls):
        graph_mail.send_mail = cls._real_send
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        type(self).mailed = []
        self.db = database.SessionLocal()
        for m in _CLEAR:
            self.db.query(m).execution_options(include_deleted=True).delete()
        for who, co in ((BOSS["email"], COA), (SAM, COA), (PRIYA, COA), (BEN, COB)):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=who, first_name=who.split("@")[0],
                                             last_name="", status="active", company=co))
        self.db.commit()
        cache.settings_config.invalidate()
        self.bg = BackgroundTasks()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    # ── helpers ─────────────────────────────────────────────────────────────
    def arm(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def _rule(self, name, trigger, actions, conditions=None, company="", user=None):
        out = create_rule(RuleBody(name=name, trigger=trigger, actions=actions, conditions=conditions or []),
                          **({"user": user} if user else {}), db=self.db)
        if company:
            r = self.db.get(models.TaskAutomationRule, out["id"])
            r.company_id = company
            self.db.commit()
        return out

    def _project(self, name="Ops", company=COA, **kw):
        kw.setdefault("access_level", "org")
        p = models.TaskProject(id=gen_id(), name=name, owner_email=BOSS["email"], member_emails=[],
                               company_id=company, created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def _field(self, fid, kind="select", options=None, **kw):
        f = models.TaskCustomField(id=fid, name=kw.pop("name", fid.title()), type=kind,
                                   options=options or [], applies_to='["task"]', **kw)
        self.db.add(f)
        self.db.commit()
        return f

    def _create(self, user=BOSS, **kw):
        return create_task(TaskCreate(title=kw.pop("title", "Fix the gate"), **kw), self.bg, user=user, db=self.db)

    def _patch(self, tid, user=BOSS, **kw):
        return update_task(tid, TaskUpdate(**kw), self.bg, user=user, db=self.db)

    def _row(self, tid):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == tid).first()

    def _runs(self):
        """The firings (the Runs panel), not the spawned-task markers."""
        self.db.expire_all()
        return (self.db.query(models.TaskAutomationRun)
                .filter(models.TaskAutomationRun.event != task_automation.SPAWNED_EVENT)
                .order_by(models.TaskAutomationRun.at).all())

    def _held_setup(self):
        """Sam (an employee whose manager is Boss) holds a task due in 5 days;
        moving it 60 days out is over a month, so it needs Boss's approval."""
        e = self.db.query(models.NexusEmployee).filter(models.NexusEmployee.work_email == SAM).first()
        e.manager_email = BOSS["email"]
        self.db.commit()
        sam = {"email": SAM, "role": "employee", "level": 1}
        d0 = (TODAY + timedelta(days=5)).isoformat()
        t = self._create(user=sam, title="Mine", assignee_emails=[SAM], due_on=d0)
        return sam, t, d0

    def _tasks(self):
        self.db.expire_all()
        return self.db.query(models.Task).order_by(models.Task.created_at).all()

    def _run_automation_mail(self):
        """Run only the automation emails the request queued (the other
        background tasks are the ordinary created/assigned emails)."""
        for t in self.bg.tasks:
            if len(t.args) > 1 and t.args[1] == "automation":
                t.func(*t.args, **t.kwargs)

    def _422(self, call):
        with self.assertRaises(HTTPException) as cm:
            call()
        self.assertEqual(cm.exception.status_code, 422)
        return cm.exception.detail

    # ── validation ──────────────────────────────────────────────────────────
    def test_validation_refuses_incomplete_new_triggers_and_actions(self):
        p = self._project()
        self._422(lambda: self._rule("x", {"type": "custom_field_changed", "value": {}},
                                     [{"type": "set_priority", "value": "high"}]))
        self._422(lambda: self._rule("x", {"type": "custom_field_changed", "value": {"fieldId": "nope"}},
                                     [{"type": "set_priority", "value": "high"}]))
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "create_task", "value": {"title": " "}}]))
        self._422(lambda: self._rule("x", {"type": "created"},
                                     [{"type": "create_task", "value": {"title": "a", "projectId": "gone"}}]))
        self._422(lambda: self._rule("x", {"type": "created"},
                                     [{"type": "create_task", "value": {"title": "a", "dueInDays": "soon"}}]))
        self._422(lambda: self._rule("x", {"type": "created"},
                                     [{"type": "create_task", "value": {"title": "a", "assignee": "x@gmail.com"}}]))
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "move_to_project", "value": {}}]))
        other = self._project("Other")
        sec = models.TaskSection(id=gen_id(), project_id=other.id, name="Later", created_at=now_iso())
        self.db.add(sec)
        self.db.commit()
        self._422(lambda: self._rule("x", {"type": "created"},
                                     [{"type": "move_to_project", "value": {"projectId": p.id, "sectionId": sec.id}}]))
        # Only Nexus directory people - never an outside address.
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "send_email", "value": {
            "to": "someone@gmail.com", "subject": "Hi", "body": "There"}}]))
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "send_email", "value": {
            "to": "assignees", "subject": "", "body": "There"}}]))
        self._422(lambda: self._rule("x", {"type": "created"},
                                     [{"type": "set_custom_field", "value": {"fieldId": "nope", "value": "a"}}]))
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "set_priority", "value": "high"}],
                                     conditions=[{"field": "custom_field", "fieldId": "nope", "op": "is", "value": "a"}]))
        self.assertEqual(self.db.query(models.TaskAutomationRule).count(), 0)

    def test_a_company_rule_cannot_name_another_companys_project_field_or_person(self):
        pb = self._project("B Ops", company=COB)
        self._field("fb", company_id=COB)
        self.arm()
        amgr = {"email": BOSS["email"], "level": 3}
        detail = self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "move_to_project",
                                                                           "value": {"projectId": pb.id}}], user=amgr))
        self.assertIn("another company", detail)
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "create_task",
                                                                  "value": {"title": "a", "projectId": pb.id}}], user=amgr))
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "set_custom_field",
                                                                  "value": {"fieldId": "fb", "value": "x"}}], user=amgr))
        self._422(lambda: self._rule("x", {"type": "created"}, [{"type": "send_email", "value": {
            "to": BEN, "subject": "Hi", "body": "x"}}], user=amgr))
        # Its own company's project is fine.
        pa = self._project("A Ops", company=COA)
        made = self._rule("ok", {"type": "created"}, [{"type": "move_to_project", "value": {"projectId": pa.id}}],
                          user=amgr)
        self.assertEqual(self.db.get(models.TaskAutomationRule, made["id"]).company_id, COA)
        # ...and an edit is checked against the rule's company too.
        self._422(lambda: update_rule(made["id"], RuleBody(actions=[{"type": "move_to_project",
                                                                     "value": {"projectId": pb.id}}]),
                                      user=amgr, db=self.db))

    # ── triggers ────────────────────────────────────────────────────────────
    def test_custom_field_changed_to_a_select_option(self):
        self._field("budget", options=[{"id": "ok", "label": "OK"}, {"id": "over", "label": "Over"}])
        self._rule("Over budget", {"type": "custom_field_changed", "value": {"fieldId": "budget", "to": "over"}},
                   [{"type": "set_priority", "value": "urgent"}])
        t = self._create()
        self.assertEqual(self._patch(t["id"], custom_field_values={"budget": "ok"})["priority"], "medium")
        self.assertEqual(self._patch(t["id"], custom_field_values={"budget": "Over"})["priority"], "urgent")
        self.assertEqual(len(self._runs()), 1)
        # An edit that leaves the field alone does not fire it again.
        self._patch(t["id"], priority="low")
        self._patch(t["id"], title="Renamed")
        self.assertEqual(len(self._runs()), 1)

    def test_custom_field_changed_any_change_multiselect_and_checkbox(self):
        self._field("tags2", kind="multiselect", options=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}])
        self._field("signed", kind="checkbox")
        self._rule("Any", {"type": "custom_field_changed", "value": {"fieldId": "tags2"}},
                   [{"type": "add_tag", "value": "any"}])
        self._rule("Gets B", {"type": "custom_field_changed", "value": {"fieldId": "tags2", "to": "b"}},
                   [{"type": "add_tag", "value": "has-b"}])
        self._rule("Signed", {"type": "custom_field_changed", "value": {"fieldId": "signed", "to": "checked"}},
                   [{"type": "add_tag", "value": "signed"}])
        self._rule("Unsigned", {"type": "custom_field_changed", "value": {"fieldId": "signed", "to": "unchecked"}},
                   [{"type": "add_tag", "value": "unsigned"}])
        t = self._create()
        out = self._patch(t["id"], custom_field_values={"tags2": ["a"]})
        self.assertEqual(out["tags"], ["any"])
        out = self._patch(t["id"], custom_field_values={"tags2": ["a", "b"]})
        self.assertEqual(sorted(out["tags"]), ["any", "has-b"])
        out = self._patch(t["id"], custom_field_values={"tags2": ["a", "b"], "signed": True})
        self.assertIn("signed", out["tags"])
        self.assertNotIn("unsigned", out["tags"])
        out = self._patch(t["id"], custom_field_values={"tags2": ["a", "b"], "signed": False})
        self.assertIn("unsigned", out["tags"])

    def test_custom_field_changed_fires_from_a_bulk_edit(self):
        self._field("site", kind="text")
        self._rule("Site set", {"type": "custom_field_changed", "value": {"fieldId": "site", "to": "Austin"}},
                   [{"type": "set_priority", "value": "high"}])
        a, b = self._create(title="A"), self._create(title="B")
        out = bulk_update(BulkUpdate(ids=[a["id"], b["id"]], patch={"custom_field_values": {"site": "austin"}}),
                          user=BOSS, db=self.db)
        self.assertEqual({r["priority"] for r in out}, {"high"})
        self.assertEqual({r.event for r in self._runs()}, {"bulk"})

    def test_due_date_changed(self):
        self._rule("Re-dated", {"type": "due_date_changed"}, [{"type": "add_tag", "value": "re-dated"}])
        t = self._create(due_on=(TODAY + timedelta(days=5)).isoformat())
        self.assertEqual(t["tags"], [])          # a new task has no "before"
        self.assertEqual(self._patch(t["id"], title="x")["tags"], [])
        out = self._patch(t["id"], due_on=(TODAY + timedelta(days=6)).isoformat())
        self.assertEqual(out["tags"], ["re-dated"])

    def test_custom_field_condition(self):
        self._field("region", options=[{"id": "west", "label": "West"}, {"id": "east", "label": "East"}])
        self._rule("West only", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "add_tag", "value": "west"}],
                   conditions=[{"field": "custom_field", "fieldId": "region", "op": "is", "value": "west"}])
        self._rule("Not west", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "add_tag", "value": "elsewhere"}],
                   conditions=[{"field": "custom_field", "fieldId": "region", "op": "is_not", "value": "west"}])
        w = self._create(title="W", custom_field_values={"region": "west"})
        e = self._create(title="E", custom_field_values={"region": "east"})
        self.assertEqual(self._patch(w["id"], status="in_progress")["tags"], ["west"])
        self.assertEqual(self._patch(e["id"], status="in_progress")["tags"], ["elsewhere"])

    # ── create_task ─────────────────────────────────────────────────────────
    def test_create_task_through_the_create_path(self):
        p = self._project()
        self._rule("Follow up", {"type": "status_changed", "value": "completed"}, [{"type": "create_task", "value": {
            "title": "Follow up: {title}", "assignee": "{assignee}", "dueInDays": 3, "priority": "high"}}])
        t = self._create(title="Gate", project_id=p.id, assignee_emails=[SAM])
        self._patch(t["id"], status="completed")
        made = [x for x in self._tasks() if x.id != t["id"]]
        self.assertEqual(len(made), 1)
        n = made[0]
        self.assertEqual(n.title, "Follow up: Gate")
        self.assertEqual(n.project_id, p.id)                       # default: the same project
        self.assertEqual(task_assignees(n), [SAM])
        self.assertEqual(n.due_on, (TODAY + timedelta(days=3)).isoformat())
        self.assertEqual(n.priority, "high")
        self.assertEqual(n.created_by, BOSS["email"])              # as the person who made the change
        self.assertTrue(n.code)
        self.assertEqual(n.company_id, COA)
        run = self._runs()[-1]
        self.assertEqual(run.status, "applied")
        self.assertIn('created task "Follow up: Gate" in Ops', run.actions)
        acts = self.db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == n.id,
                                                         models.TaskActivity.type == "automation").all()
        self.assertEqual(len(acts), 1)

    def test_create_task_as_a_subtask(self):
        self._rule("Checklist", {"type": "created"}, [{"type": "create_task", "value": {
            "title": "Photos for {title}", "asSubtask": True}}])
        t = self._create(title="Unit 4")
        kids = [x for x in self._tasks() if x.parent_task_id == t["id"]]
        self.assertEqual([k.title for k in kids], ["Photos for Unit 4"])
        self.assertIn(kids[0].id, self._row(t["id"]).subtask_ids)

    def test_created_tasks_run_no_rules_and_cannot_loop(self):
        # A "created" rule that creates a task would recurse forever without
        # the guard; a second rule shows the new task runs no rules at all.
        self._rule("Spawn", {"type": "created"}, [{"type": "create_task", "value": {"title": "Child of {title}"}}])
        self._rule("Tag new", {"type": "created"}, [{"type": "add_tag", "value": "new"}])
        t = self._create(title="Root")
        rows = self._tasks()
        self.assertEqual(len(rows), 2)
        child = next(x for x in rows if x.id != t["id"])
        self.assertEqual(child.title, "Child of Root")
        self.assertEqual(child.tags or [], [])
        self.assertEqual(self._row(t["id"]).tags, ["new"])

    def test_one_change_creates_at_most_three_tasks(self):
        self._rule("Lots", {"type": "created"},
                   [{"type": "create_task", "value": {"title": f"T{i}"}} for i in range(6)])
        self._create(title="Root")
        self.assertEqual(len(self._tasks()), 1 + task_automation.MAX_CREATES_PER_TASK)
        run = self._runs()[-1]
        self.assertEqual(run.status, "partial")
        self.assertTrue(any("at most 3" in ln for ln in run.actions))

    def test_a_bulk_edit_shares_one_create_budget(self):
        self._rule("Each", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "create_task", "value": {"title": "Next for {title}"}}])
        ids = [self._create(title=f"T{i}")["id"] for i in range(4)]
        old = task_automation.MAX_CREATES_PER_REQUEST
        task_automation.MAX_CREATES_PER_REQUEST = 2
        try:
            bulk_update(BulkUpdate(ids=ids, patch={"status": "in_progress"}), user=BOSS, db=self.db)
        finally:
            task_automation.MAX_CREATES_PER_REQUEST = old
        self.assertEqual(len(self._tasks()), 4 + 2)

    def test_required_field_failure_is_logged_not_raised(self):
        target = self._project("Finance")
        self._field("budget", kind="text", required=True, project_ids=[target.id])
        self._rule("Hand off", {"type": "status_changed", "value": "completed"}, [{"type": "create_task", "value": {
            "title": "Invoice {title}", "projectId": target.id}}])
        t = self._create(title="Job 7")
        out = self._patch(t["id"], status="completed")       # the person's edit still lands
        self.assertTrue(out["completed"])
        self.assertEqual(len(self._tasks()), 1)
        run = self._runs()[-1]
        self.assertEqual(run.status, "error")
        self.assertIn("could not create a task", run.detail)
        self.assertIn("required", run.detail)

    def test_create_task_needs_the_actors_rights_on_the_target_project(self):
        locked = self._project("Board", access_level="restricted")
        self._rule("Escalate", {"type": "priority_changed", "value": "urgent"}, [{"type": "create_task", "value": {
            "title": "Look at {title}", "projectId": locked.id}}])
        t = self._create(title="Leak")
        sam = {"email": SAM, "level": 1}
        self._patch(t["id"], user=sam, priority="urgent")
        self.assertEqual(len(self._tasks()), 1)
        self.assertIn("editor access", self._runs()[-1].detail)

    def test_a_restricted_task_is_not_copied_into_another_project(self):
        other = self._project("Everyone")
        self._rule("Copy", {"type": "status_changed", "value": "in_progress"}, [{"type": "create_task", "value": {
            "title": "Copy of {title}", "projectId": other.id}}])
        t = self._create(title="Secret", access_level="restricted")
        self._patch(t["id"], status="in_progress")
        self.assertEqual(len(self._tasks()), 1)
        self.assertIn("restricted", self._runs()[-1].detail)

    # ── move_to_project ─────────────────────────────────────────────────────
    def test_move_to_project_moves_the_subtree_and_does_not_chain(self):
        src, dst = self._project("Intake"), self._project("Build")
        sec = models.TaskSection(id=gen_id(), project_id=dst.id, name="Ready", created_at=now_iso())
        self.db.add(sec)
        self.db.commit()
        self._rule("Route", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "move_to_project", "value": {"projectId": dst.id, "sectionId": sec.id}}])
        self._rule("Landed", {"type": "moved_to_project", "value": dst.id}, [{"type": "add_tag", "value": "landed"}])
        t = self._create(title="Job", project_id=src.id)
        sub = self._create(title="Step", project_id=src.id, parent_task_id=t["id"])
        out = self._patch(t["id"], status="in_progress")
        self.assertEqual(out["projectId"], dst.id)
        self.assertEqual(self._row(t["id"]).section_id, sec.id)
        self.assertEqual(self._row(sub["id"]).project_id, dst.id)
        self.assertEqual(out["tags"], [])              # the automation's move fires no moved_to_project rule
        self.assertIn("moved to Build (Ready)", self._runs()[-1].actions)

    def test_move_to_project_never_carries_a_restricted_subtask(self):
        # A manual project move needs someone who may open every restricted
        # row up (tasks._require_open_up_for_move); a rule has no such
        # person, so the whole move is skipped with a run note.
        src, dst = self._project("Intake"), self._project("Build")
        self._rule("Route", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "move_to_project", "value": {"projectId": dst.id}}])
        t = self._create(title="Job", project_id=src.id)
        sub = self._create(title="Private step", project_id=src.id, parent_task_id=t["id"])
        row = self._row(sub["id"])
        row.access_level = "restricted"
        self.db.commit()
        self._patch(t["id"], status="in_progress")
        self.assertEqual((self._row(t["id"]).project_id, self._row(sub["id"]).project_id), (src.id, src.id))
        self.assertIn("a subtask is restricted", self._runs()[-1].detail)

    def test_move_across_the_company_wall_is_refused_at_run_time(self):
        pb = self._project("B Ops", company=COB)
        self._rule("Shared route", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "move_to_project", "value": {"projectId": pb.id}}])
        pa = self._project("A Ops", company=COA)
        t = self._create(title="A job", project_id=pa.id)
        self.arm()
        self._patch(t["id"], status="in_progress")
        self.assertEqual(self._row(t["id"]).project_id, pa.id)
        run = self._runs()[-1]
        self.assertEqual(run.status, "error")
        self.assertIn("another company", run.detail)

    # ── send_email ──────────────────────────────────────────────────────────
    def test_send_email_goes_through_the_batched_queue(self):
        self._rule("Tell them", {"type": "status_changed", "value": "in_progress"}, [{"type": "send_email", "value": {
            "to": "assignees", "subject": "{title} started", "body": "Status is {status}."}}])
        t = self._create(title="Roof", assignee_emails=[SAM, PRIYA])
        self._patch(t["id"], status="in_progress")
        self._run_automation_mail()
        rows = self.db.query(models.TaskEmailQueue).filter(models.TaskEmailQueue.event_type == "automation").all()
        self.assertEqual(sorted(r.recipient for r in rows), [PRIYA, SAM])
        self.assertEqual(rows[0].payload["auto_subject"], "Roof started")
        self.assertEqual(rows[0].payload["auto_body"], "Status is In Progress.")
        self.assertEqual(type(self).mailed, [])            # nothing mailed directly
        self.assertTrue(any(ln.startswith("queued an email to") for ln in self._runs()[-1].actions))

    def test_send_email_never_reaches_someone_who_cannot_see_the_task(self):
        self._rule("Tell Priya", {"type": "status_changed", "value": "in_progress"}, [{"type": "send_email", "value": {
            "to": PRIYA, "subject": "Update", "body": "{title}"}}])
        t = self._create(title="Private matter", access_level="restricted", assignee_emails=[SAM])
        self._patch(t["id"], status="in_progress")
        self._run_automation_mail()
        self.assertEqual(self.db.query(models.TaskEmailQueue).count(), 0)
        run = self._runs()[-1]
        self.assertEqual(run.status, "error")
        self.assertIn("who can see this task", run.detail)

    def test_send_email_respects_mutes(self):
        self._rule("Tell them", {"type": "status_changed", "value": "in_progress"}, [{"type": "send_email", "value": {
            "to": "assignees", "subject": "Hi", "body": "x"}}])
        t = self._create(title="Roof", assignee_emails=[SAM, PRIYA])
        task_notify_prefs.save(self.db, SAM, {"mutedTaskIds": [t["id"]]})
        self._patch(t["id"], status="in_progress")
        self._run_automation_mail()
        rows = self.db.query(models.TaskEmailQueue).filter(models.TaskEmailQueue.event_type == "automation").all()
        self.assertEqual([r.recipient for r in rows], [PRIYA])

    def test_a_held_email_is_dropped_if_the_recipient_loses_sight(self):
        self._rule("Tell them", {"type": "status_changed", "value": "in_progress"}, [{"type": "send_email", "value": {
            "to": PRIYA, "subject": "Hi", "body": "x"}}])
        t = self._create(title="Roof")
        self._patch(t["id"], status="in_progress")
        self._run_automation_mail()
        q = self.db.query(models.TaskEmailQueue).one()
        row = self._row(t["id"])
        row.access_level = "restricted"
        self.db.commit()
        reason = task_notify._drop_reason(self.db, q, row, task_notify_prefs.load(self.db, PRIYA))
        self.assertEqual(reason, "cannot see the task")

    def test_the_email_escapes_task_text(self):
        ctx = {"id": "t1", "title": "<b>x</b>", "status": "in_progress", "priority": "high"}
        subject, html = tmpl.automation_email(t=ctx, base_url="https://x", logo_url="",
                                              subject="Re: <b>x</b>", body="<script>alert(1)</script>\nline 2")
        self.assertNotIn("<script>", html)
        self.assertNotIn("<b>x</b>", html)
        self.assertIn("&lt;b&gt;x&lt;/b&gt;", html)
        self.assertTrue(subject.startswith("[Greens Global] - Re: "))

    # ── set_custom_field ────────────────────────────────────────────────────
    def test_set_custom_field_and_never_clear_a_required_one(self):
        p = self._project()
        self._field("stage", options=[{"id": "new", "label": "New"}, {"id": "done", "label": "Done"}],
                    required=True, project_ids=[p.id])
        self._rule("Stage done", {"type": "status_changed", "value": "completed"},
                   [{"type": "set_custom_field", "value": {"fieldId": "stage", "value": "Done"}}])
        self._rule("Clear stage", {"type": "priority_changed", "value": "low"},
                   [{"type": "set_custom_field", "value": {"fieldId": "stage", "value": ""}}])
        t = self._create(project_id=p.id, custom_field_values={"stage": "new"})
        out = self._patch(t["id"], status="completed")
        self.assertEqual(out["customFieldValues"]["stage"], "done")
        self.assertIn("set Stage to Done", self._runs()[-1].actions)
        out = self._patch(t["id"], priority="low")
        self.assertEqual(out["customFieldValues"]["stage"], "done")
        self.assertIn("could not clear Stage", self._runs()[-1].detail)

    # ── scheduled ───────────────────────────────────────────────────────────
    def test_scheduled_rule_can_create_and_email(self):
        self._rule("Due today", {"type": "due_date_arrives", "value": 0}, [
            {"type": "create_task", "value": {"title": "Chase {title}"}},
            {"type": "send_email", "value": {"to": "assignees", "subject": "{title} is due", "body": "Due {due}."}},
        ])
        t = self._create(title="Permit", assignee_emails=[SAM], due_on=TODAY.isoformat())
        self.assertEqual(task_automation.run_scheduled(self.db, TODAY.isoformat()), 1)
        made = [x for x in self._tasks() if x.id != t["id"]]
        self.assertEqual([m.title for m in made], ["Chase Permit"])
        self.assertEqual(made[0].created_by, BOSS["email"])       # the task's owner / creator
        # Due today is time-critical, so notify_task_event sends it now rather
        # than holding it for the batch - through its own send log, as every
        # task email.
        self.db.expire_all()
        logs = self.db.query(models.TaskEmailLog).filter(models.TaskEmailLog.event_type == "automation").all()
        self.assertEqual([r.recipient for r in logs], [SAM])
        self.assertEqual(logs[0].subject, "[Greens Global] - Permit is due")
        self.assertEqual([m["to"] for m in type(self).mailed], [[SAM]])
        # Still once per rule per task per date.
        self.assertEqual(task_automation.run_scheduled(self.db, TODAY.isoformat()), 0)
        self.assertEqual(len(self._tasks()), 2)


    # ── review fixes (Oct 22 2026) ─────────────────────────────────────────
    # H1: the clock never feeds on its own output.
    def test_scheduled_create_never_feeds_itself(self):
        self._rule("Due today", {"type": "due_date_arrives", "value": 0}, [
            {"type": "create_task", "value": {"title": "Chase {title}", "dueInDays": 0}},
            {"type": "create_task", "value": {"title": "Call {title}", "dueInDays": 0}},
            {"type": "create_task", "value": {"title": "Mail {title}", "dueInDays": 0}},
        ])
        self._create(title="Permit", due_on=TODAY.isoformat())
        counts = []
        for _ in range(4):   # four hourly scans
            task_automation.run_scheduled(self.db, TODAY.isoformat())
            counts.append(len(self._tasks()))
        self.assertEqual(counts, [4, 4, 4, 4])
        marks = self.db.query(models.TaskAutomationRun).filter(
            models.TaskAutomationRun.event == task_automation.SPAWNED_EVENT).count()
        self.assertEqual(marks, 3)

    def test_scheduled_rules_do_not_cross_chain(self):
        # Rule A makes a task due today; rule B (same scan, later) must not act
        # on it. Rule C acts one day before the due date; A's other task, due
        # tomorrow, must not feed it either.
        self._rule("A", {"type": "due_date_arrives", "value": 0}, [
            {"type": "create_task", "value": {"title": "A today {title}", "dueInDays": 0}},
            {"type": "create_task", "value": {"title": "A tomorrow {title}", "dueInDays": 1}}])
        self._rule("B", {"type": "due_date_arrives", "value": 0}, [
            {"type": "create_task", "value": {"title": "B {title}", "dueInDays": 0}}])
        self._rule("C", {"type": "due_date_arrives", "value": -1}, [
            {"type": "create_task", "value": {"title": "C {title}", "dueInDays": 1}}])
        self._create(title="Permit", due_on=TODAY.isoformat())
        for _ in range(3):
            task_automation.run_scheduled(self.db, TODAY.isoformat())
        self.assertEqual(sorted(t.title for t in self._tasks()),
                         ["A today Permit", "A tomorrow Permit", "B Permit", "Permit"])
        # ...and an event rule's task is never picked up by the clock either.
        self._rule("On start", {"type": "status_changed", "value": "in_progress"}, [
            {"type": "create_task", "value": {"title": "Kickoff {title}", "dueInDays": 0}}])
        t = self._create(title="Roof")
        self._patch(t["id"], status="in_progress")
        before = len(self._tasks())
        task_automation.run_scheduled(self.db, TODAY.isoformat())
        self.assertEqual(len(self._tasks()), before)

    def test_one_scan_has_one_create_budget_per_company(self):
        self._rule("Prep", {"type": "due_date_arrives", "value": 0},
                   [{"type": "create_task", "value": {"title": "Prep {title}", "dueInDays": 3}}])
        for i in range(3):
            self._create(title=f"T{i}", due_on=TODAY.isoformat())
        old = task_automation.MAX_CREATES_PER_SCAN
        task_automation.MAX_CREATES_PER_SCAN = 2
        try:
            with self.assertLogs("task_automation", level="WARNING"):
                task_automation.run_scheduled(self.db, TODAY.isoformat())
            self.assertEqual(len([t for t in self._tasks() if t.title.startswith("Prep")]), 2)
            hit = [r for r in self._runs() if r.status == "error"]
            self.assertEqual(len(hit), 1)
            self.assertIn("one hourly scan for a company can create at most 2", hit[0].detail)
            self.assertEqual(hit[0].dedupe_key, "")
            # The deferred task is finished on the next scan, once.
            task_automation.run_scheduled(self.db, TODAY.isoformat())
            task_automation.run_scheduled(self.db, TODAY.isoformat())
        finally:
            task_automation.MAX_CREATES_PER_SCAN = old
        self.assertEqual(len([t for t in self._tasks() if t.title.startswith("Prep")]), 3)

    def test_sixty_due_tasks_take_two_scans(self):
        self._rule("Prep", {"type": "due_date_arrives", "value": 0},
                   [{"type": "create_task", "value": {"title": "Prep {title}", "dueInDays": 3}}])
        for i in range(60):
            self._create(title=f"T{i}", due_on=TODAY.isoformat())
        prep = lambda: len([t for t in self._tasks() if t.title.startswith("Prep")])  # noqa: E731
        with self.assertLogs("task_automation", level="WARNING"):
            task_automation.run_scheduled(self.db, TODAY.isoformat())
        self.assertEqual(prep(), 50)
        task_automation.run_scheduled(self.db, TODAY.isoformat())
        self.assertEqual(prep(), 60)
        task_automation.run_scheduled(self.db, TODAY.isoformat())
        self.assertEqual(prep(), 60)          # the per-day dedupe still holds

    def test_a_rule_made_task_still_gets_escalated_by_the_clock(self):
        # Rule-made tasks are never fed to create_task, but a rule that only
        # changes the task (escalation) still reaches them.
        self._rule("Follow up", {"type": "due_date_arrives", "value": 0},
                   [{"type": "create_task", "value": {"title": "Follow {title}", "dueInDays": 0}}])
        self._rule("Escalate", {"type": "due_date_arrives", "value": 0},
                   [{"type": "set_priority", "value": "urgent"}])
        self._create(title="Permit", due_on=TODAY.isoformat())
        for _ in range(3):
            task_automation.run_scheduled(self.db, TODAY.isoformat())
        rows = self._tasks()
        self.assertEqual(sorted(t.title for t in rows), ["Follow Permit", "Permit"])
        self.assertEqual({t.priority for t in rows}, {"urgent"})
        # A rule mixing both on a rule-made task: only the create is skipped.
        self._rule("Both", {"type": "due_date_arrives", "value": 0}, [
            {"type": "create_task", "value": {"title": "Again {title}", "dueInDays": 0}},
            {"type": "add_tag", "value": "seen"}])
        task_automation.run_scheduled(self.db, TODAY.isoformat())
        follow = next(t for t in self._tasks() if t.title == "Follow Permit")
        self.assertEqual(follow.tags, ["seen"])
        self.assertEqual(sorted(t.title for t in self._tasks()), ["Again Permit", "Follow Permit", "Permit"])

    def test_the_per_task_cap_counts_every_rule_in_a_scan(self):
        for name in ("One", "Two"):
            self._rule(name, {"type": "due_date_arrives", "value": 0}, [
                {"type": "create_task", "value": {"title": f"{name} a", "dueInDays": 5}},
                {"type": "create_task", "value": {"title": f"{name} b", "dueInDays": 5}}])
        self._create(title="Root", due_on=TODAY.isoformat())
        task_automation.run_scheduled(self.db, TODAY.isoformat())
        self.assertEqual(len(self._tasks()), 1 + task_automation.MAX_CREATES_PER_TASK)

    def test_spawned_markers_stay_out_of_the_runs_panel(self):
        from routers.task_config import list_rule_runs
        self._rule("Spawn", {"type": "created"}, [{"type": "create_task", "value": {"title": "Child"}}])
        self._create(title="Root")
        rows = list_rule_runs(user=BOSS, db=self.db)
        self.assertEqual(len(rows), 1)
        self.assertNotEqual(rows[0]["event"], task_automation.SPAWNED_EVENT)

    # H2 / M1: approval is decided before the rules run.
    def test_a_held_due_change_does_not_fire_due_date_changed(self):
        self._rule("Re-dated", {"type": "due_date_changed"}, [{"type": "add_tag", "value": "re-dated"}])
        sam, t, d0 = self._held_setup()
        wanted = (TODAY + timedelta(days=60)).isoformat()
        self._patch(t["id"], user=sam, due_on=wanted)
        row = self._row(t["id"])
        self.assertEqual(row.due_on[:10], d0)                       # held
        self.assertEqual((row.due_proposal or {}).get("dueOn"), wanted)
        self.assertEqual(row.tags or [], [])
        self.assertEqual(self._runs(), [])

    def test_a_rule_cannot_launder_an_unapproved_date(self):
        self._rule("Pad", {"type": "due_date_changed"}, [{"type": "shift_due_days", "value": 1}])
        sam, t, d0 = self._held_setup()
        self._patch(t["id"], user=sam, due_on=(TODAY + timedelta(days=60)).isoformat())
        self.assertEqual(self._row(t["id"]).due_on[:10], d0)

    def test_a_held_change_in_bulk_does_not_fire_or_bypass(self):
        self._rule("Pad", {"type": "due_date_changed"}, [{"type": "shift_due_days", "value": 1}])
        sam, t, d0 = self._held_setup()
        wanted = (TODAY + timedelta(days=60)).isoformat()
        bulk_update(BulkUpdate(ids=[t["id"]], patch={"due_on": wanted}), user=sam, db=self.db)
        row = self._row(t["id"])
        self.assertEqual(row.due_on[:10], d0)
        self.assertEqual((row.due_proposal or {}).get("dueOn"), wanted)
        self.assertEqual(self._runs(), [])

    def test_a_held_calendar_shift_does_not_fire_or_bypass(self):
        # The batch bar's Dates action (the calendar's shift path): a shift
        # that needs approval is held before the rules, start date with it.
        from routers.tasks import BulkDates
        self._rule("Pad", {"type": "due_date_changed"}, [{"type": "shift_due_days", "value": 1}])
        sam, t, d0 = self._held_setup()
        start0 = (TODAY + timedelta(days=2)).isoformat()
        row = self._row(t["id"])
        row.start_on = start0
        self.db.commit()
        bulk_update(BulkUpdate(ids=[t["id"]], dates=BulkDates(op="shift", days=60)), user=sam, db=self.db)
        row = self._row(t["id"])
        self.assertEqual(row.due_on[:10], d0)
        self.assertEqual(row.start_on, start0)
        self.assertEqual((row.due_proposal or {}).get("dueOn"), (TODAY + timedelta(days=65)).isoformat())
        self.assertEqual((row.due_proposal or {}).get("startOn"), (TODAY + timedelta(days=62)).isoformat())
        self.assertEqual(self._runs(), [])
        # A shift nobody needs to approve fires the rule, which pads it.
        t2 = self._create(user=sam, title="Small", assignee_emails=[SAM], due_on=d0)
        bulk_update(BulkUpdate(ids=[t2["id"]], dates=BulkDates(op="shift", days=1)), user=sam, db=self.db)
        self.assertEqual(self._row(t2["id"]).due_on[:10], (TODAY + timedelta(days=7)).isoformat())

    def test_an_approved_or_privileged_change_fires_the_rule(self):
        self._rule("Re-dated", {"type": "due_date_changed"}, [{"type": "add_tag", "value": "re-dated"}])
        sam, t, d0 = self._held_setup()
        wanted = (TODAY + timedelta(days=60)).isoformat()
        self._patch(t["id"], user=BOSS, due_on=wanted)              # a manager needs no approval
        row = self._row(t["id"])
        self.assertEqual(row.due_on[:10], wanted)
        self.assertEqual(row.tags, ["re-dated"])
        # A small move by Sam needs no approval either, and fires the rule.
        t2 = self._create(user=sam, title="Small", assignee_emails=[SAM], due_on=d0)
        out = self._patch(t2["id"], user=sam, due_on=(TODAY + timedelta(days=6)).isoformat())
        self.assertEqual(out["tags"], ["re-dated"])

    def test_a_rules_own_move_off_the_real_date_is_privileged(self):
        self._rule("Push", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "shift_due_days", "value": 1}])
        sam, t, d0 = self._held_setup()
        wanted = (TODAY + timedelta(days=60)).isoformat()
        # Sam asks for +60 days (held) and starts the task in the same edit:
        # the rule moves the REAL date by one day; the request still stands.
        self._patch(t["id"], user=sam, due_on=wanted, status="in_progress")
        row = self._row(t["id"])
        self.assertEqual(row.due_on[:10], (TODAY + timedelta(days=6)).isoformat())
        self.assertEqual((row.due_proposal or {}).get("dueOn"), wanted)
        self.assertEqual(row.due_history[-1]["source"], "automation")

    # M2: a restricted task's title never reaches someone who cannot see it.
    def test_create_task_leaves_off_people_who_cannot_see_a_restricted_source(self):
        p = self._project()
        for mode in ({}, {"asSubtask": True}):
            self.db.query(models.TaskAutomationRule).delete()
            self.db.commit()
            self._rule("Ask", {"type": "status_changed", "value": "in_progress"},
                       [{"type": "create_task", "value": {"title": "Check {title}", "assignee": PRIYA, **mode}}])
            t = self._create(title="Secret merger", access_level="restricted", project_id=p.id,
                             assignee_emails=[SAM])
            p.access_level = "restricted"     # nobody sees it through the project either
            self.db.commit()
            self._patch(t["id"], status="in_progress")
            made = [x for x in self._tasks() if x.title == "Check Secret merger"]
            self.assertTrue(made)
            self.assertNotIn(PRIYA, task_assignees(made[-1]))
            self.assertNotEqual(made[-1].access_level or "org", "org")
            self.assertIn(f"left off {PRIYA}", " ".join(self._runs()[-1].actions))
            p.access_level = "org"
            self.db.commit()

    # M3: no borrowing the owner's access.
    def test_a_change_by_someone_outside_the_directory_cannot_create(self):
        locked = self._project("Board", access_level="restricted")
        self._rule("Escalate", {"type": "priority_changed", "value": "urgent"}, [{"type": "create_task", "value": {
            "title": "Look at {title}", "projectId": locked.id}}])
        t = self._create(title="Leak")    # owner / creator: Boss, who could create there
        ghost = {"email": "ghost@greensglobal.com", "level": 1}
        self._patch(t["id"], user=ghost, priority="urgent")
        self.assertEqual(len(self._tasks()), 1)
        run = self._runs()[-1]
        self.assertEqual(run.status, "error")
        self.assertIn("ghost@greensglobal.com made the change and is not in the Nexus directory", run.detail)

    # L1: a rule never moves a restricted task to another project.
    def test_a_restricted_task_is_not_moved_to_another_project(self):
        src, dst = self._project("Intake"), self._project("Everyone")
        self._rule("Route", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "move_to_project", "value": {"projectId": dst.id}}])
        t = self._create(title="Secret", project_id=src.id, access_level="restricted")
        self._patch(t["id"], status="in_progress")
        self.assertEqual(self._row(t["id"]).project_id, src.id)
        self.assertIn("restricted", self._runs()[-1].detail)

    # L4: the switches, and nobody is emailed about their own change.
    def test_automation_emails_can_be_switched_off_and_skip_the_actor(self):
        self.assertTrue(task_notify.get_settings(self.db)["enabledEvents"]["automation"])
        self.assertIn("automation", task_notify_prefs.OPTIONAL_EVENTS)
        self._rule("Tell them", {"type": "status_changed", "value": "in_progress"}, [{"type": "send_email", "value": {
            "to": "assignees", "subject": "Hi", "body": "x"}}])
        # The person who made the change is not emailed about it.
        t = self._create(title="Roof", assignee_emails=[BOSS["email"], SAM])
        self._patch(t["id"], status="in_progress")
        self._run_automation_mail()
        q = self.db.query(models.TaskEmailQueue).filter(models.TaskEmailQueue.event_type == "automation")
        self.assertEqual([r.recipient for r in q.all()], [SAM])
        # A person can turn rule emails off...
        self.db.query(models.TaskEmailQueue).delete()
        self.db.commit()
        task_notify_prefs.save(self.db, SAM, {"events": {"automation": False}})
        self.bg = BackgroundTasks()
        self._patch(t["id"], status="not_started")
        self._patch(t["id"], status="in_progress")
        self._run_automation_mail()
        self.assertEqual(self.db.query(models.TaskEmailQueue).count(), 0)
        # ...and so can the company.
        task_notify_prefs.save(self.db, SAM, {})
        task_notify.save_settings(self.db, {"enabledEvents": {"automation": False}}, BOSS["email"])
        self.bg = BackgroundTasks()
        self._patch(t["id"], status="not_started")
        self._patch(t["id"], status="in_progress")
        self._run_automation_mail()
        self.assertEqual(self.db.query(models.TaskEmailQueue).count(), 0)


    # Formula fields (another branch): calculated, never stored, read_only=False.
    def test_a_formula_field_cannot_be_watched_tested_or_set(self):
        self._field("total", kind="formula", name="Total Cost")
        for trigger, actions, conditions in (
                ({"type": "custom_field_changed", "value": {"fieldId": "total"}},
                 [{"type": "add_tag", "value": "x"}], []),
                ({"type": "created"}, [{"type": "add_tag", "value": "x"}],
                 [{"field": "custom_field", "fieldId": "total", "op": "is", "value": "5"}]),
                ({"type": "created"}, [{"type": "set_custom_field", "value": {"fieldId": "total", "value": "5"}}], [])):
            detail = self._422(lambda: self._rule("F", trigger, actions, conditions=conditions))
            self.assertIn("formula", detail)
        self.assertEqual(self.db.query(models.TaskAutomationRule).count(), 0)
        # Rules that got past the validator (saved before the field became a
        # formula) are skipped at run time.
        for i, (trigger, actions, conditions) in enumerate((
                ({"type": "custom_field_changed", "value": {"fieldId": "total"}},
                 [{"type": "add_tag", "value": "watched"}], []),
                ({"type": "created"}, [{"type": "add_tag", "value": "tested"}],
                 [{"field": "custom_field", "fieldId": "total", "op": "is_not", "value": "5"}]),
                ({"type": "created"}, [{"type": "set_custom_field", "value": {"fieldId": "total", "value": "5"}}], []),
                ({"type": "due_date_arrives", "value": 0}, [{"type": "add_tag", "value": "clock"}],
                 [{"field": "custom_field", "fieldId": "total", "op": "is_not", "value": "5"}]))):
            self.db.add(models.TaskAutomationRule(id=f"f{i}", name=f"F{i}", trigger=trigger, actions=actions,
                                                  conditions=conditions, enabled=True, created_at=now_iso()))
        self.db.commit()
        t = self._create(title="Bid", due_on=TODAY.isoformat(), custom_field_values={"total": "5"})
        self.assertEqual(t["tags"], [])
        run = self._runs()[-1]
        self.assertIn("could not set Total Cost: it is a formula field", run.detail)
        # Whatever a (stale) client wrote under the formula's id, a change to
        # it never fires the watching rule, and the clock skips the condition.
        self._patch(t["id"], custom_field_values={"total": "6"})
        task_automation.run_scheduled(self.db, TODAY.isoformat())
        self.assertEqual(self._row(t["id"]).tags or [], [])
        self.assertEqual(len(self._runs()), 1)


if __name__ == "__main__":
    unittest.main()
