"""
Automation engine tests (task_automation.py, Oct 2026).

Manage > Automation Rules stored rules for months and never ran one. These
drive the REAL request paths - create_task, update_task, bulk_update - and the
hourly scheduled scan, so a rule that stops firing fails here rather than in
front of a manager who trusted the toggle.

Uses a throwaway sqlite file. No network - task_notify's email send is stubbed.

Run with: python -m unittest test_task_automation -v
"""
import os
import tempfile
import unittest
from datetime import date, timedelta

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException  # noqa: E402

import database  # noqa: E402
import models  # noqa: E402
import task_automation  # noqa: E402
import task_notify  # noqa: E402
from routers.task_util import gen_id, now_iso, task_assignees  # noqa: E402
from routers.tasks import create_task, update_task, bulk_update, TaskCreate, TaskUpdate, BulkUpdate  # noqa: E402
from routers.task_config import create_rule, update_rule, RuleBody  # noqa: E402

MANAGER = {"email": "boss@greensglobal.com", "level": 3}
SAM = "sam@greensglobal.com"
PRIYA = "priya@greensglobal.com"
TODAY = date.today()


class AutomationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        # No Graph calls: the engine's add_comment goes through create_comment,
        # which schedules notify_task_event; we only care that it was asked.
        cls._real_notify = task_notify.notify_task_event
        task_notify.notify_task_event = lambda *a, **kw: None

    @classmethod
    def tearDownClass(cls):
        task_notify.notify_task_event = cls._real_notify
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.Task, models.TaskComment, models.TaskActivity, models.TaskProject,
                  models.TaskAutomationRule, models.TaskAutomationRun, models.TaskNotification):
            self.db.query(m).delete()
        self.db.commit()
        self.bg = BackgroundTasks()

    def tearDown(self):
        self.db.close()

    # ── helpers ─────────────────────────────────────────────────────────────
    def _rule(self, name, trigger, actions, conditions=None, enabled=True):
        return create_rule(RuleBody(name=name, trigger=trigger, actions=actions,
                                    conditions=conditions or [], enabled=enabled), db=self.db)

    def _project(self, name="Ops"):
        p = models.TaskProject(id=gen_id(), name=name, access_level="org", owner_email=MANAGER["email"],
                               member_emails=[], created_at=now_iso(), modified_at=now_iso())
        self.db.add(p)
        self.db.commit()
        return p

    def _create(self, **kw):
        body = TaskCreate(title=kw.pop("title", "Fix the gate"), **kw)
        return create_task(body, self.bg, user=MANAGER, db=self.db)

    def _patch(self, tid, **kw):
        return update_task(tid, TaskUpdate(**kw), self.bg, user=MANAGER, db=self.db)

    def _row(self, tid):
        self.db.expire_all()
        return self.db.query(models.Task).filter(models.Task.id == tid).first()

    def _runs(self):
        return self.db.query(models.TaskAutomationRun).order_by(models.TaskAutomationRun.at).all()

    # ── validation ──────────────────────────────────────────────────────────
    def test_a_rule_without_actions_is_refused(self):
        with self.assertRaises(HTTPException) as cm:
            self._rule("Empty", {"type": "created"}, [])
        self.assertEqual(cm.exception.status_code, 422)

    def test_an_unknown_trigger_is_refused(self):
        with self.assertRaises(HTTPException):
            self._rule("Bad", {"type": "when_pigs_fly"}, [{"type": "set_priority", "value": "high"}])

    def test_assign_action_needs_a_person(self):
        with self.assertRaises(HTTPException):
            self._rule("Bad", {"type": "created"}, [{"type": "assign_to", "value": ""}])

    # ── created ─────────────────────────────────────────────────────────────
    def test_created_trigger_sets_priority_and_logs_a_run(self):
        self._rule("Everything new is high", {"type": "created"}, [{"type": "set_priority", "value": "high"}])
        t = self._create()
        self.assertEqual(t["priority"], "high")
        runs = self._runs()
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].event, "created")
        self.assertIn("set priority to High", runs[0].actions)
        acts = self.db.query(models.TaskActivity).filter(models.TaskActivity.entity_id == t["id"],
                                                         models.TaskActivity.type == "automation").all()
        self.assertEqual(len(acts), 1)
        self.assertEqual(acts[0].actor_email, task_automation.AUTOMATION_ACTOR)
        rule = self.db.query(models.TaskAutomationRule).first()
        self.assertEqual(rule.run_count, 1)
        self.assertTrue(rule.last_run_at)

    def test_a_disabled_rule_does_nothing(self):
        self._rule("Off", {"type": "created"}, [{"type": "set_priority", "value": "urgent"}], enabled=False)
        t = self._create()
        self.assertEqual(t["priority"], "medium")
        self.assertEqual(self._runs(), [])

    def test_created_assign_to_notifies_the_new_assignee(self):
        self._rule("Route to Sam", {"type": "created"}, [{"type": "assign_to", "value": SAM}])
        t = self._create()
        self.assertEqual(t["assigneeIds"], [SAM])
        bells = self.db.query(models.TaskNotification).filter(models.TaskNotification.for_email == SAM).all()
        self.assertEqual(len(bells), 1, "the person a rule assigns is told like anyone else")

    # ── conditions ──────────────────────────────────────────────────────────
    def test_project_condition_scopes_the_rule(self):
        ops, other = self._project("Ops"), self._project("Other")
        self._rule("Ops is urgent", {"type": "created"}, [{"type": "set_priority", "value": "urgent"}],
                   conditions=[{"field": "project", "op": "is", "value": ops.id}])
        self.assertEqual(self._create(project_id=ops.id)["priority"], "urgent")
        self.assertEqual(self._create(project_id=other.id)["priority"], "medium")
        self.assertEqual(self._create()["priority"], "medium")

    def test_is_not_condition(self):
        self._rule("Non-urgent gets a tag", {"type": "created"}, [{"type": "add_tag", "value": "triage"}],
                   conditions=[{"field": "priority", "op": "is_not", "value": "urgent"}])
        self.assertIn("triage", self._create()["tags"])
        self.assertNotIn("triage", self._create(priority="urgent")["tags"])

    # ── status / priority / assignee / project triggers ─────────────────────
    def test_status_changed_to_a_value(self):
        self._rule("Started means medium", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "set_priority", "value": "medium"}])
        t = self._create(priority="low")
        self._patch(t["id"], priority="high")                  # not a status change
        self.assertEqual(self._row(t["id"]).priority, "high")
        self._patch(t["id"], status="in_progress")
        self.assertEqual(self._row(t["id"]).priority, "medium")

    def test_status_changed_any(self):
        self._rule("Any move tags it", {"type": "status_changed"}, [{"type": "add_tag", "value": "moved"}])
        t = self._create()
        self._patch(t["id"], title="Renamed")
        self.assertEqual(self._row(t["id"]).tags, [])
        self._patch(t["id"], status="in_progress")
        self.assertEqual(self._row(t["id"]).tags, ["moved"])

    def test_assignee_changed_for_a_specific_person(self):
        self._rule("Sam's tasks are high", {"type": "assignee_changed", "value": SAM},
                   [{"type": "set_priority", "value": "high"}])
        t = self._create()
        self._patch(t["id"], assignee_emails=[PRIYA])
        self.assertEqual(self._row(t["id"]).priority, "medium")
        self._patch(t["id"], assignee_emails=[PRIYA, SAM])
        self.assertEqual(self._row(t["id"]).priority, "high")

    def test_moved_to_project_adds_a_collaborator(self):
        ops = self._project("Ops")
        self._rule("Ops lead follows", {"type": "moved_to_project", "value": ops.id},
                   [{"type": "add_follower", "value": PRIYA}])
        t = self._create()
        self._patch(t["id"], project_id=ops.id)
        self.assertIn(PRIYA, self._row(t["id"]).follower_emails)

    def test_completed_early(self):
        self._rule("Early finish", {"type": "completed_early"}, [{"type": "add_tag", "value": "early"}])
        late = self._create(due_on=(TODAY - timedelta(days=1)).isoformat())
        early = self._create(due_on=(TODAY + timedelta(days=3)).isoformat())
        self._patch(late["id"], completed=True)
        self._patch(early["id"], completed=True)
        self.assertEqual(self._row(late["id"]).tags, [])
        self.assertEqual(self._row(early["id"]).tags, ["early"])

    # ── actions ─────────────────────────────────────────────────────────────
    def test_set_status_completed_marks_the_task_done(self):
        self._rule("Done tag closes", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "set_status", "value": "completed"}])
        t = self._create()
        self._patch(t["id"], status="in_progress")
        row = self._row(t["id"])
        self.assertTrue(row.completed)
        self.assertEqual(row.status, "completed")
        self.assertTrue(row.completed_at)

    def test_set_status_respects_the_dependency_gate(self):
        blocker = self._create(title="Blocker")
        self._rule("Auto-close", {"type": "priority_changed", "value": "urgent"},
                   [{"type": "set_status", "value": "completed"}])
        t = self._create(blocked_by_ids=[blocker["id"]])
        self._patch(t["id"], priority="urgent")       # must not raise, must not complete
        row = self._row(t["id"])
        self.assertFalse(row.completed)
        self.assertEqual(row.priority, "urgent", "the person's own edit still lands")
        run = self._runs()[-1]
        self.assertTrue(any(ln.startswith("skipped setting status") for ln in run.actions), run.actions)

    def test_due_date_actions_and_history(self):
        self._rule("Due in a week", {"type": "created"}, [{"type": "set_due_in_days", "value": 7}])
        t = self._create()
        self.assertEqual(t["dueOn"], (TODAY + timedelta(days=7)).isoformat())
        row = self._row(t["id"])
        self.assertEqual(row.due_history[-1]["source"], "automation")
        self._rule("Urgent pulls in", {"type": "priority_changed", "value": "urgent"},
                   [{"type": "shift_due_days", "value": -3}])
        self._patch(t["id"], priority="urgent")
        self.assertEqual(self._row(t["id"]).due_on, (TODAY + timedelta(days=4)).isoformat())

    def test_add_comment_posts_after_commit_with_placeholders(self):
        self._rule("Welcome", {"type": "created"},
                   [{"type": "add_comment", "value": "Auto: {title} is due {due}"}])
        t = self._create(due_on="2026-12-25")
        comments = self.db.query(models.TaskComment).filter(models.TaskComment.task_id == t["id"]).all()
        self.assertEqual(len(comments), 1)
        self.assertEqual(comments[0].author_email, task_automation.AUTOMATION_ACTOR)
        self.assertIn("Fix the gate is due 12/25/2026", comments[0].body)

    def test_several_actions_run_in_order_and_a_noop_is_not_logged(self):
        self._rule("Combo", {"type": "created"},
                   [{"type": "set_priority", "value": "medium"},   # already medium: no-op
                    {"type": "add_tag", "value": "a"}, {"type": "set_milestone", "value": ""}])
        t = self._create()
        self.assertTrue(t["isMilestone"])
        self.assertEqual(self._runs()[0].actions, ["added tag a", "marked as milestone"])

    # ── no chaining ─────────────────────────────────────────────────────────
    def test_an_automated_status_change_does_not_fire_other_rules(self):
        self._rule("A", {"type": "priority_changed", "value": "urgent"},
                   [{"type": "set_status", "value": "in_progress"}])
        self._rule("B", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "add_tag", "value": "chained"}])
        t = self._create()
        self._patch(t["id"], priority="urgent")
        row = self._row(t["id"])
        self.assertEqual(row.status, "in_progress")
        self.assertEqual(row.tags, [], "rule B must only fire on a person's status change")

    # ── bulk ────────────────────────────────────────────────────────────────
    def test_bulk_status_change_fires_per_row(self):
        self._rule("Started is high", {"type": "status_changed", "value": "in_progress"},
                   [{"type": "set_priority", "value": "high"}])
        a, b = self._create(title="a"), self._create(title="b")
        bulk_update(BulkUpdate(ids=[a["id"], b["id"]], patch={"status": "in_progress"}), user=MANAGER, db=self.db)
        self.assertEqual(self._row(a["id"]).priority, "high")
        self.assertEqual(self._row(b["id"]).priority, "high")
        self.assertEqual(len(self._runs()), 2)

    def test_bulk_can_complete_through_a_rule(self):
        self._rule("Tagging done closes", {"type": "priority_changed", "value": "low"},
                   [{"type": "set_status", "value": "completed"}])
        a = self._create()
        bulk_update(BulkUpdate(ids=[a["id"]], patch={"priority": "low"}), user=MANAGER, db=self.db)
        row = self._row(a["id"])
        self.assertTrue(row.completed)
        self.assertEqual(row.status, "completed")

    # ── scheduled: due date arrives ─────────────────────────────────────────
    def test_due_date_arrives_fires_once_per_task_per_date(self):
        self._rule("Two days out goes urgent", {"type": "due_date_arrives", "value": -2},
                   [{"type": "set_priority", "value": "urgent"}])
        soon = self._create(title="soon", due_on=(TODAY + timedelta(days=2)).isoformat())
        later = self._create(title="later", due_on=(TODAY + timedelta(days=5)).isoformat())
        done = self._create(title="done", due_on=(TODAY + timedelta(days=2)).isoformat())
        self._patch(done["id"], completed=True)
        self.assertEqual(task_automation.run_scheduled(self.db, TODAY.isoformat()), 1)
        self.assertEqual(self._row(soon["id"]).priority, "urgent")
        self.assertEqual(self._row(later["id"]).priority, "medium")
        self.assertEqual(self._row(done["id"]).priority, "medium", "closed tasks are left alone")
        # The hourly scan calls again: nothing new.
        self.assertEqual(task_automation.run_scheduled(self.db, TODAY.isoformat()), 0)
        self.assertEqual(len([r for r in self._runs() if r.event == "scheduled"]), 1)

    def test_due_date_arrives_after_the_due_date(self):
        self._rule("Three days late escalates", {"type": "due_date_arrives", "value": 3},
                   [{"type": "add_assignee", "value": MANAGER["email"]}, {"type": "add_tag", "value": "late"}])
        t = self._create(due_on=(TODAY - timedelta(days=3)).isoformat(), assignee_emails=[SAM])
        task_automation.run_scheduled(self.db, TODAY.isoformat())
        row = self._row(t["id"])
        self.assertEqual(task_assignees(row), [SAM, MANAGER["email"]])
        self.assertIn("late", row.tags)

    # ── editing a rule re-validates ─────────────────────────────────────────
    def test_patch_toggle_does_not_need_the_whole_rule(self):
        r = self._rule("Toggle me", {"type": "created"}, [{"type": "add_tag", "value": "x"}])
        out = update_rule(r["id"], RuleBody(enabled=False), db=self.db)
        self.assertFalse(out["enabled"])
        with self.assertRaises(HTTPException):
            update_rule(r["id"], RuleBody(actions=[]), db=self.db)


if __name__ == "__main__":
    unittest.main()
