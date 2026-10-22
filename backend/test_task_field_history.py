"""Task field history (Neil, Oct 22 2026) - task_history.py + GET /tasks/{id}/history.

- Every write path records who changed which field from what to what: the
  single PATCH, bulk edits, automation rules (as automation@nexus, in the
  request and on the clock), the due-date approvals, the Missed close, a
  deleted status or section, the offboarding handover.
- A status / assignee / due move lands on the row that already tells it
  (status_changed, assignee_changed, due_changed, completed) - never twice.
- A write that changes nothing records nothing.
- Custom fields: all seven stored kinds; read-only (formula) fields never.
- The history endpoint is the task's own: restricted or other-company tasks
  are a 404, and a private project's name is not handed out.

Throwaway SQLite, no network.  python -m pytest test_task_field_history.py
"""
import os
import tempfile
import unittest

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException

import cache
import database
import models
import task_automation
import task_due
import task_history
from routers import task_projects as P
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

COA, COB = "co-a", "co-b"
OWNER = {"email": "owner@greensglobal.com", "level": 1}
ASSIGNEE = {"email": "assignee@greensglobal.com", "level": 1}
OTHER = {"email": "other@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
MANAGER = {"email": "manager@greensglobal.com", "level": 3}
BMGR = {"email": "bmgr@greensglobal.com", "level": 3}      # company B manager
DIRECTORY = [(OWNER, COA), (ASSIGNEE, COA), (OTHER, COA), (OUTSIDER, COA), (MANAGER, COA), (BMGR, COB)]
AUTO = task_automation.AUTOMATION_ACTOR

_CLEAR = (models.Task, models.TaskProject, models.TaskSection, models.TaskActivity, models.TaskNotification,
          models.NexusNotification, models.NexusEmployee, models.TaskCustomField, models.TaskCustomStatus,
          models.TaskAutomationRule, models.TaskAutomationRun, models.NexusSetting, models.TaskChecklistItem,
          models.TaskTeam, models.HrChecklist, models.HrChecklistItem)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp_db.name)
        except FileNotFoundError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        for m in _CLEAR:
            self.db.query(m).execution_options(include_deleted=True).delete()
        for u, co in DIRECTORY:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=u["email"], company=co,
                                             first_name=u["email"].split("@")[0], status="active"))
        self.db.commit()
        cache.settings_config.invalidate()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    # -- helpers ---------------------------------------------------------------
    def task(self, **kw):
        kw.setdefault("title", "Roof")
        kw.setdefault("status", "not_started")
        kw.setdefault("priority", "medium")
        kw.setdefault("owner_email", OWNER["email"])
        kw.setdefault("created_by", OWNER["email"])
        kw.setdefault("company_id", COA)
        t = models.Task(id=gen_id(), code=f"T-{gen_id()[:6]}", created_at=now_iso(), modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def field(self, kind, **kw):
        f = models.TaskCustomField(id=kw.pop("id", f"cf-{kind}"), name=kw.pop("name", kind.title()), type=kind,
                                   options=kw.pop("options", []), **kw)
        self.db.add(f)
        self.db.commit()
        return f

    def rule(self, trigger, actions, **kw):
        r = models.TaskAutomationRule(id=gen_id(), name=kw.pop("name", "Rule"), trigger=trigger, actions=actions,
                                      conditions=[], enabled=True, created_at=now_iso(), **kw)
        self.db.add(r)
        self.db.commit()
        return r

    def patch(self, t, user=OWNER, **fields):
        return T.update_task(t.id, T.TaskUpdate(**fields), BackgroundTasks(), user=user, db=self.db)

    def history(self, t, user=OWNER, field=""):
        return T.task_field_history(t.id, field=field, user=user, db=self.db)["items"]

    def changes(self, t):
        """(field, from, to, actor, type) for every recorded change, oldest first."""
        rows = (self.db.query(models.TaskActivity)
                .filter(models.TaskActivity.entity_id == t.id).order_by(models.TaskActivity.at).all())
        out = []
        for a in rows:
            ch = a.field_change
            if isinstance(ch, dict):
                key = ch["fieldId"] if ch["field"] == "customField" else ch["field"]
                out.append((key, ch["from"], ch["to"], a.actor_email, a.type))
        return out

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def arm_walls(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()


class PatchTests(Base):
    def test_core_fields_record_from_and_to(self):
        t = self.task()
        self.patch(t, title="Roof repair", priority="high", start_on="2026-10-20", tags=["leak"],
                   estimate_hours=4, is_milestone=True)
        got = {c[0]: (c[1], c[2], c[3], c[4]) for c in self.changes(t)}
        self.assertEqual(got["title"], ("Roof", "Roof repair", OWNER["email"], "field_changed"))
        self.assertEqual(got["priority"], ("medium", "high", OWNER["email"], "field_changed"))
        self.assertEqual(got["startOn"], (None, "2026-10-20", OWNER["email"], "field_changed"))
        self.assertEqual(got["tags"], (None, ["leak"], OWNER["email"], "field_changed"))
        self.assertEqual(got["estimateHours"], (None, 4.0, OWNER["email"], "field_changed"))
        self.assertEqual(got["isMilestone"], (False, True, OWNER["email"], "field_changed"))
        # One tidy line each for any feed that prints the detail.
        row = self.db.query(models.TaskActivity).filter_by(entity_id=t.id, type="field_changed").first()
        self.assertTrue(row.detail.startswith("changed "))

    def test_status_and_assignees_carry_from_to_on_their_own_rows(self):
        t = self.task()
        self.patch(t, status="in_progress", assignee_emails=[ASSIGNEE["email"]])
        got = self.changes(t)
        self.assertIn(("status", "not_started", "in_progress", OWNER["email"], "status_changed"), got)
        self.assertIn(("assigneeIds", None, [ASSIGNEE["email"]], OWNER["email"], "assignee_changed"), got)
        # Never twice: one status_changed, one assignee_changed.
        types = [a.type for a in self.db.query(models.TaskActivity).filter_by(entity_id=t.id)]
        self.assertEqual(types.count("status_changed"), 1)
        self.assertEqual(types.count("assignee_changed"), 1)
        # The wording every reader of status_changed parses is unchanged.
        row = self.db.query(models.TaskActivity).filter_by(entity_id=t.id, type="status_changed").one()
        self.assertEqual(row.detail, "changed status to in_progress")

    def test_completing_records_the_status_on_the_completed_row(self):
        t = self.task(status="in_progress")
        self.patch(t, completed=True)
        rows = self.db.query(models.TaskActivity).filter_by(entity_id=t.id).all()
        self.assertEqual([r.type for r in rows], ["completed"])
        self.assertEqual(rows[0].field_change["from"], "in_progress")
        self.assertEqual(rows[0].field_change["to"], "completed")

    def test_due_date_change_is_the_due_changed_row(self):
        t = self.task(due_on="2026-11-01")
        self.patch(t, due_on="2026-11-03")
        self.assertEqual(self.changes(t), [("dueOn", "2026-11-01", "2026-11-03", OWNER["email"], "due_changed")])

    def test_project_and_section_keep_their_names(self):
        p1 = models.TaskProject(id="p1", name="Ops", access_level="org", created_at=now_iso())
        p2 = models.TaskProject(id="p2", name="Build", access_level="org", created_at=now_iso())
        self.db.add_all([p1, p2, models.TaskSection(id="s1", project_id="p1", name="Backlog")])
        self.db.commit()
        t = self.task(project_id="p1", section_id="s1")
        self.patch(t, project_id="p2")
        got = {c[0]: c for c in self.changes(t)}
        self.assertEqual(got["projectId"][1:3], ("p1", "p2"))
        self.assertEqual(got["sectionId"][1:3], ("s1", None))     # a move leaves the old section
        entry = next(e for e in self.history(t) if e["field"] == "projectId")
        self.assertEqual(entry["labels"], {"p1": {"label": "Ops"}, "p2": {"label": "Build"}})
        sec = next(e for e in self.history(t) if e["field"] == "sectionId")
        self.assertEqual(sec["labels"], {"s1": {"label": "Backlog", "projectId": "p1"}})

    def test_a_no_op_write_records_nothing(self):
        t = self.task(priority="high", tags=["a"], assignee_email=ASSIGNEE["email"],
                      assignee_emails=[ASSIGNEE["email"]], custom_field_values={"cf-text": "x"})
        self.field("text")
        self.patch(t, priority="high", title="Roof", tags=["a"], assignee_emails=[ASSIGNEE["email"]],
                   custom_field_values={"cf-text": "x"})
        self.assertEqual(self.changes(t), [])
        self.assertEqual(self.db.query(models.TaskActivity).filter_by(entity_id=t.id).count(), 0)

    def test_every_custom_field_kind_records_and_formula_fields_never(self):
        self.field("text")
        self.field("number")
        self.field("date")
        self.field("checkbox")
        self.field("select", options=[{"id": "o1", "label": "Austin", "color": "#f00"},
                                      {"id": "o2", "label": "Dallas", "color": "#0f0"}])
        self.field("multiselect", options=[{"id": "m1", "label": "Red"}, {"id": "m2", "label": "Blue"}])
        self.field("people")
        self.field("text", id="cf-formula", name="Calculated", read_only=True)
        # A real formula field is NOT stored read_only - its type says it is
        # computed. A value left on a task from before (it was a text field
        # once) is never history, whatever the save does to it.
        self.field("formula", id="cf-fx", name="Calc", formula="1+1")
        t = self.task(custom_field_values={"cf-select": "o1", "cf-formula": "1",
                                           "cf-fx": "stale value from when it was text"})
        self.patch(t, custom_field_values={
            "cf-text": "hello", "cf-number": "3", "cf-date": "2026-10-30", "cf-checkbox": True,
            "cf-select": "o2", "cf-multiselect": ["m2", "m1"], "cf-people": [ASSIGNEE["email"]],
            "cf-formula": "2"})
        got = {c[0]: (c[1], c[2]) for c in self.changes(t)}
        self.assertEqual(got["cf-text"], (None, "hello"))
        self.assertEqual(got["cf-number"], (None, 3))
        self.assertEqual(got["cf-date"], (None, "2026-10-30"))
        self.assertEqual(got["cf-checkbox"], (None, True))
        self.assertEqual(got["cf-select"], ("o1", "o2"))
        self.assertEqual(got["cf-multiselect"], (None, ["m1", "m2"]))
        self.assertEqual(got["cf-people"], (None, [ASSIGNEE["email"]]))
        self.assertNotIn("cf-formula", got)
        self.assertNotIn("cf-fx", got)
        self.assertEqual(self.history(t, field="cf-fx"), [])
        sel = self.history(t, field="cf-select")
        self.assertEqual(len(sel), 1)
        self.assertEqual(sel[0]["labels"]["o1"], {"label": "Austin", "color": "#f00"})
        self.assertEqual(sel[0]["kind"], "select")
        # Clearing a value is a change to Empty.
        self.patch(t, custom_field_values={"cf-select": "o2"})
        got = [c for c in self.changes(t) if c[0] == "cf-text"]
        self.assertEqual(got[-1][1:3], ("hello", None))


class BulkTests(Base):
    def test_bulk_records_per_task_with_from_and_to(self):
        a, b = self.task(priority="low"), self.task(priority="high")
        T.bulk_update(T.BulkUpdate(ids=[a.id, b.id], patch={"priority": "urgent", "status": "in_progress"}),
                      user=MANAGER, db=self.db)
        self.assertIn(("priority", "low", "urgent", MANAGER["email"], "field_changed"), self.changes(a))
        self.assertIn(("priority", "high", "urgent", MANAGER["email"], "field_changed"), self.changes(b))
        self.assertIn(("status", "not_started", "in_progress", MANAGER["email"], "status_changed"), self.changes(a))
        self.assertEqual(self.db.query(models.TaskActivity).filter_by(type="status_changed").count(), 2)

    def test_bulk_custom_field_and_no_op(self):
        self.field("text")
        a = self.task(custom_field_values={"cf-text": "same"})
        T.bulk_update(T.BulkUpdate(ids=[a.id], patch={"custom_field_values": {"cf-text": "same"}}),
                      user=MANAGER, db=self.db)
        self.assertEqual(self.changes(a), [])
        T.bulk_update(T.BulkUpdate(ids=[a.id], patch={"custom_field_values": {"cf-text": "new"}}),
                      user=MANAGER, db=self.db)
        self.assertEqual(self.changes(a), [("cf-text", "same", "new", MANAGER["email"], "field_changed")])


class AutomationTests(Base):
    def test_a_rules_change_is_the_rules_and_the_persons_is_theirs(self):
        self.rule({"type": "status_changed", "value": "in_progress"}, [{"type": "set_priority", "value": "urgent"}])
        t = self.task()
        self.patch(t, status="in_progress")
        got = self.changes(t)
        self.assertIn(("status", "not_started", "in_progress", OWNER["email"], "status_changed"), got)
        self.assertIn(("priority", "medium", "urgent", AUTO, "field_changed"), got)
        self.assertFalse([c for c in got if c[0] == "priority" and c[3] == OWNER["email"]])

    def test_a_field_the_person_and_the_rule_both_moved(self):
        # The person sets High; the rule (on the status move) then sets Urgent.
        self.rule({"type": "status_changed", "value": "in_progress"}, [{"type": "set_priority", "value": "urgent"}])
        t = self.task()
        self.patch(t, status="in_progress", priority="high")
        got = [c for c in self.changes(t) if c[0] == "priority"]
        self.assertEqual(sorted(got, key=lambda c: c[3]), [
            ("priority", "high", "urgent", AUTO, "field_changed"),
            ("priority", "medium", "high", OWNER["email"], "field_changed"),
        ])

    def test_a_rule_that_changes_status_is_not_put_on_the_person(self):
        self.rule({"type": "priority_changed", "value": "urgent"}, [{"type": "set_status", "value": "in_progress"}])
        t = self.task()
        self.patch(t, priority="urgent")
        status_rows = self.db.query(models.TaskActivity).filter_by(entity_id=t.id, type="status_changed").all()
        self.assertEqual([(r.actor_email, r.field_change["to"]) for r in status_rows], [(AUTO, "in_progress")])

    def test_scheduled_rule_completes_on_the_completed_row(self):
        today = task_automation.business_today()
        self.rule({"type": "due_date_arrives", "value": 0}, [{"type": "set_status", "value": "completed"},
                                                            {"type": "set_priority", "value": "low"}])
        t = self.task(due_on=today.isoformat())
        task_automation.run_scheduled(self.db, today.isoformat())
        got = self.changes(t)
        self.assertIn(("status", "not_started", "completed", AUTO, "completed"), got)
        self.assertIn(("priority", "medium", "low", AUTO, "field_changed"), got)
        self.assertEqual(self.db.query(models.TaskActivity).filter_by(entity_id=t.id, type="status_changed").count(), 0)


class OtherPathTests(Base):
    def test_due_approval_paths_carry_from_and_to(self):
        t = self.task(due_on="2026-11-01", assignee_email=ASSIGNEE["email"], assignee_emails=[ASSIGNEE["email"]])
        task_due.propose(self.db, t, ASSIGNEE["email"], "2026-11-10")
        task_due.respond(self.db, t, OWNER["email"], accept=True)
        self.db.commit()
        self.assertIn(("dueOn", "2026-11-01", "2026-11-10", OWNER["email"], "due_changed"), self.changes(t))

    def test_close_as_missed_lands_on_the_closed_missed_row(self):
        t = self.task(status="recurring", recurrence={"freq": "daily"})
        T._close_as_missed(self.db, t, "next one is due")
        self.db.commit()
        self.assertEqual(self.changes(t), [("status", "recurring", "missed", "system", "closed_missed")])

    def test_deleting_a_status_keeps_its_name_on_the_change(self):
        self.db.add(models.TaskCustomStatus(id="waiting", label="Waiting", color="#abc"))
        self.db.commit()
        t = self.task(status="waiting")
        T.delete_custom_status("waiting", user=MANAGER, db=self.db)
        [e] = self.history(t, user=MANAGER)
        self.assertEqual((e["from"], e["to"]), ("waiting", "not_started"))
        self.assertEqual(e["labels"]["waiting"]["label"], "Waiting")

    def test_deleting_a_section_records_the_release(self):
        p = models.TaskProject(id="p1", name="Ops", access_level="org", owner_email=MANAGER["email"],
                               created_at=now_iso())
        self.db.add_all([p, models.TaskSection(id="s1", project_id="p1", name="Backlog")])
        self.db.commit()
        t = self.task(project_id="p1", section_id="s1")
        T.delete_section("s1", user=MANAGER, db=self.db)
        self.assertEqual(self.changes(t), [("sectionId", "s1", None, MANAGER["email"], "field_changed")])
        self.assertEqual(self.history(t, user=MANAGER)[0]["labels"], {"s1": {"label": "Backlog", "projectId": "p1"}})

    def test_offboarding_handover_records_the_new_assignee(self):
        t = self.task(assignee_email=ASSIGNEE["email"], assignee_emails=[ASSIGNEE["email"]])
        P.handover_person(self.db, ASSIGNEE["email"], OTHER["email"], actor=MANAGER["email"])
        self.db.commit()
        got = {c[0]: c for c in self.changes(t)}
        self.assertEqual(got["assigneeIds"][1:4], ([ASSIGNEE["email"]], [OTHER["email"]], MANAGER["email"]))
        self.assertEqual(got["projectId"][1], None)   # a homeless task moved into the handover project
        # Quiet (review L2): field rows, which the Updates card and the briefing
        # skip - one assignee line per handed-over task would flood both. The
        # task's own history still shows it.
        self.assertEqual(got["assigneeIds"][4], "field_changed")
        self.assertEqual(self.db.query(models.TaskActivity).filter_by(type="assignee_changed").count(), 0)
        [e] = self.history(t, user=MANAGER, field="assigneeIds")
        self.assertEqual(e["to"], [OTHER["email"]])


class EndpointTests(Base):
    def test_newest_first_filtered_and_paged(self):
        t = self.task()
        for p in ("high", "low", "urgent"):
            self.patch(t, priority=p)
        self.patch(t, title="Other")
        items = self.history(t, field="priority")
        self.assertEqual([(e["from"], e["to"]) for e in items], [("low", "urgent"), ("high", "low"), ("medium", "high")])
        self.assertTrue(all(e["actorId"] == OWNER["email"] and e["at"] for e in items))
        page = T.task_field_history(t.id, field="priority", limit=2, offset=0, user=OWNER, db=self.db)
        self.assertEqual(len(page["items"]), 2)
        self.assertTrue(page["more"])
        page2 = T.task_field_history(t.id, field="priority", limit=2, offset=2, user=OWNER, db=self.db)
        self.assertEqual(len(page2["items"]), 1)
        self.assertFalse(page2["more"])
        self.assertEqual(len(self.history(t)), 4)

    def test_a_restricted_task_is_a_404_to_an_outsider(self):
        t = self.task(access_level="restricted", assignee_email=ASSIGNEE["email"],
                      assignee_emails=[ASSIGNEE["email"]])
        self.patch(t, priority="high")
        self.assertEqual(self.code(lambda: self.history(t, user=OUTSIDER)), 404)
        self.assertEqual(len(self.history(t, user=ASSIGNEE)), 1)    # someone on it can read it

    def test_another_companys_task_is_a_404_with_walls_on(self):
        t = self.task()
        self.patch(t, priority="high")
        self.arm_walls()
        self.assertEqual(self.code(lambda: self.history(t, user=BMGR)), 404)
        self.assertEqual(len(self.history(t, user=MANAGER)), 1)

    def test_a_private_projects_name_is_not_handed_out(self):
        self.db.add_all([
            models.TaskProject(id="open", name="Open Board", access_level="org", created_at=now_iso()),
            models.TaskProject(id="secret", name="Secret Board", access_level="restricted",
                               owner_email=MANAGER["email"], created_at=now_iso()),
        ])
        self.db.commit()
        t = self.task(project_id="open")
        self.patch(t, user=MANAGER, project_ids=["secret"])
        [e] = self.history(t, user=OTHER, field="projectIds")
        self.assertEqual(e["to"], ["secret"])
        self.assertEqual(e["labels"], {})
        [e] = self.history(t, user=MANAGER, field="projectIds")
        self.assertEqual(e["labels"], {"secret": {"label": "Secret Board"}})
        # The activity feed's copy of the change is held to the same rule.
        acts = T.task_activity(t.id, user=OTHER, db=self.db)
        self.assertEqual([a["change"]["labels"] for a in acts if a["change"]], [{}])

    def test_activity_rows_carry_the_change(self):
        t = self.task()
        self.patch(t, priority="high")
        [a] = T.task_activity(t.id, user=OWNER, db=self.db)
        self.assertEqual(a["type"], "field_changed")
        self.assertEqual(a["change"]["field"], "priority")


class ReviewFixTests(Base):
    """The Oct 22 review of this feature (M1-M3, L1, L4)."""

    # -- M1: a restricted project's sections and fields stay private --------
    def _secret_and_open(self):
        self.db.add_all([
            models.TaskProject(id="open", name="Open Board", access_level="org", created_at=now_iso()),
            models.TaskProject(id="secret", name="Secret Board", access_level="restricted",
                               owner_email=MANAGER["email"], created_at=now_iso()),
            models.TaskSection(id="s-secret", project_id="secret", name="Secret Column"),
        ])
        self.db.commit()

    def test_a_restricted_projects_section_name_is_not_handed_out(self):
        self._secret_and_open()
        t = self.task(project_id="secret", section_id="s-secret")
        self.patch(t, user=MANAGER, project_id="open")          # the move leaves the section behind
        [e] = self.history(t, user=OTHER, field="sectionId")
        self.assertEqual((e["from"], e["labels"]), ("s-secret", {}))
        [p] = self.history(t, user=OTHER, field="projectId")
        self.assertEqual(p["labels"], {"open": {"label": "Open Board"}})
        acts = [a["change"] for a in T.task_activity(t.id, user=OTHER, db=self.db) if a["change"]]
        self.assertEqual([c["labels"] for c in acts if c["field"] == "sectionId"], [{}])
        # A manager reads them all.
        [e] = self.history(t, user=MANAGER, field="sectionId")
        self.assertEqual(e["labels"]["s-secret"]["label"], "Secret Column")

    def test_an_older_section_label_without_its_project_is_looked_up(self):
        self._secret_and_open()
        t = self.task(project_id="open")
        self.db.add(models.TaskActivity(
            id=gen_id(), entity_kind="task", entity_id=t.id, type="field_changed", actor_email=MANAGER["email"],
            at=now_iso(), detail="changed Section",
            field_change={"field": "sectionId", "fieldId": "", "label": "Section", "from": "s-secret", "to": None,
                          "labels": {"s-secret": {"label": "Secret Column"}}}))
        self.db.commit()
        [e] = self.history(t, user=OTHER, field="sectionId")
        self.assertEqual(e["labels"], {})

    def test_a_field_only_a_restricted_project_uses_is_hidden(self):
        self._secret_and_open()
        self.field("select", id="cf-secret", name="Secret Budget", project_ids=["secret"],
                   options=[{"id": "o1", "label": "Over", "color": "#f00"}])
        t = self.task(project_id="open")
        self.patch(t, user=MANAGER, custom_field_values={"cf-secret": "o1"}, priority="high")
        self.assertEqual(self.history(t, user=OTHER, field="cf-secret"), [])
        self.assertEqual([e["field"] for e in self.history(t, user=OTHER)], ["priority"])
        acts = T.task_activity(t.id, user=OTHER, db=self.db)
        hidden = [a for a in acts if a["type"] == "field_changed" and a["change"] is None]
        self.assertEqual([a["detail"] for a in hidden], ["changed a field"])
        self.assertNotIn("Secret Budget", " ".join(a["detail"] for a in acts))
        self.assertTrue(all("scope" not in a["change"] for a in acts if a["change"]))
        [e] = self.history(t, user=MANAGER, field="cf-secret")
        self.assertEqual(e["labels"]["o1"]["label"], "Over")

    # -- M2: a rule and the same edit both move the status ------------------
    def test_a_rules_status_move_then_the_persons_completion(self):
        self.rule({"type": "priority_changed", "value": "urgent"}, [{"type": "set_status", "value": "in_progress"}])
        t = self.task()
        self.patch(t, priority="urgent", completed=True)
        self.db.expire_all()
        self.assertTrue(self.db.get(models.Task, t.id).completed)
        status = [c for c in self.changes(t) if c[0] == "status"]
        self.assertEqual(status, [
            ("status", "not_started", "in_progress", AUTO, "status_changed"),
            ("status", "in_progress", "completed", OWNER["email"], "completed"),
        ])
        newest_first = [(e["actorId"], e["to"]) for e in self.history(t, field="status")]
        self.assertEqual(newest_first, [(OWNER["email"], "completed"), (AUTO, "in_progress")])

    def test_the_persons_part_reads_before_the_rules(self):
        self.rule({"type": "status_changed", "value": "in_progress"}, [{"type": "set_priority", "value": "urgent"}])
        t = self.task()
        self.patch(t, status="in_progress", priority="high")
        newest_first = [(e["actorId"], e["from"], e["to"]) for e in self.history(t, field="priority")]
        self.assertEqual(newest_first, [(AUTO, "high", "urgent"), (OWNER["email"], "medium", "high")])

    # -- M3: the HR checklist sync never tells a change twice ---------------
    def _checklist(self):
        import hr_checklists as hc
        emp = models.NexusEmployee(id="emp-jo", first_name="Jo", last_name="New", status="onboarding",
                                   work_email="", company=COA)
        cl = models.HrChecklist(id="cl-1", employee_id="emp-jo", kind="onboarding", status="open", company=COA)
        self.db.add_all([emp, cl])
        for i, title in enumerate(("Laptop", "Badge")):
            self.db.add(models.HrChecklistItem(id=f"it-{i}", checklist_id="cl-1", title=title, status="open",
                                               owner_email=ASSIGNEE["email"], owner_emails=ASSIGNEE["email"],
                                               sort_order=i, due_date="2026-11-0%d" % (i + 1)))
        self.db.commit()
        [pid] = hc.sync_tasks(self.db, cl, emp, by=MANAGER["email"], first=True)
        self.db.commit()
        self.db.query(models.TaskActivity).delete()
        self.db.commit()
        parent = self.db.get(models.Task, pid)
        return parent, [self.db.get(models.Task, s) for s in parent.subtask_ids]

    def _rows(self, t):
        return [(a.type, (a.field_change or {}).get("field"), a.actor_email)
                for a in self.db.query(models.TaskActivity).filter_by(entity_id=t.id).order_by(models.TaskActivity.at)
                if a.field_change]

    def test_completing_a_checklist_task_records_each_change_once(self):
        parent, subs = self._checklist()
        self.patch(parent, user=MANAGER, completed=True)
        # The parent: its completion and the title the sync rewrote, once each,
        # credited to the person (record_edit), not again by the sync.
        got = self._rows(parent)
        self.assertEqual(sorted(got), sorted([("completed", "status", MANAGER["email"]),
                                              ("field_changed", "title", MANAGER["email"])]))
        # Its subtasks closed with it - recorded from before the close.
        for s in subs:
            self.assertEqual(self._rows(s), [("status_changed", "status", MANAGER["email"])])

    def test_completing_a_step_in_tasks_records_it_once(self):
        parent, subs = self._checklist()
        self.patch(subs[0], user=MANAGER, completed=True)
        self.assertEqual(self._rows(subs[0]), [("completed", "status", MANAGER["email"])])
        # The sync rewrites the parent (one step left, its date) - once each.
        self.assertEqual(sorted(self._rows(parent)), [("due_changed", "dueOn", MANAGER["email"]),
                                                      ("field_changed", "title", MANAGER["email"])])

    def test_bulk_completing_steps_records_each_once(self):
        parent, subs = self._checklist()
        T.bulk_update(T.BulkUpdate(ids=[s.id for s in subs], patch={"completed": True}), user=MANAGER, db=self.db)
        for s in subs:
            self.assertEqual(self._rows(s), [("completed", "status", MANAGER["email"])])
        # The parent was not in the batch: the sync records it closing, once.
        self.assertEqual([r[1] for r in self._rows(parent)].count("status"), 1)

    # -- The Updates card carries no field change ----------------------------
    def test_the_updates_card_hands_out_no_field_change(self):
        # A status move on my task by someone else is an update for me - but
        # its field-history change (names a restricted project's sections and
        # fields could ride on) is the task history's business, not the card's.
        t = self.task(assignee_email=ASSIGNEE["email"], assignee_emails=[ASSIGNEE["email"]])
        self.patch(t, user=MANAGER, status="in_progress")
        rows = T.my_task_activity(limit=30, days=14, user=ASSIGNEE, db=self.db)
        self.assertEqual([r["type"] for r in rows], ["status_changed"])
        self.assertNotIn("change", rows[0])
        self.assertTrue(all("change" not in e for r in rows for e in (r.get("events") or [])
                            if isinstance(e, dict)))

    # -- L1: a rule is not a person in the briefing --------------------------
    def test_the_briefing_does_not_count_a_rule_as_a_person(self):
        import daily_briefing
        rule_row = models.TaskActivity(type="field_changed", actor_email=AUTO)
        person_row = models.TaskActivity(type="field_changed", actor_email=OWNER["email"])
        self.assertFalse(daily_briefing._is_person_update(rule_row))
        self.assertTrue(daily_briefing._is_person_update(person_row))

    # -- L4: the field filter is in SQL and every page is reachable ----------
    def test_types_for_narrows_the_query(self):
        self.assertEqual(set(task_history.types_for("status")), {"status_changed", "completed", "closed_missed"})
        self.assertEqual(set(task_history.types_for("dueOn")), {"due_changed"})
        self.assertEqual(set(task_history.types_for("priority,cf-x")), {"field_changed"})
        self.assertEqual(set(task_history.types_for("")), set(task_history.HISTORY_TYPES))

    def test_old_history_is_reachable_past_any_scan_window(self):
        t = self.task()
        base = "2026-01-01T00:00:00.%06d+00:00"
        for i in range(1300):
            field = "priority" if i % 2 == 0 else "title"
            self.db.add(models.TaskActivity(
                id=f"h-{i:05d}", entity_kind="task", entity_id=t.id, type="field_changed", actor_email=OWNER["email"],
                at=base % i, detail="x",
                field_change={"field": field, "fieldId": "", "label": field, "from": str(i), "to": str(i + 1)}))
        self.db.commit()
        page = T.task_field_history(t.id, field="priority", limit=10, offset=640, user=OWNER, db=self.db)
        self.assertEqual([e["from"] for e in page["items"]], [str(1298 - 2 * (640 + k)) for k in range(10)])
        self.assertFalse(page["more"])
        last = T.task_field_history(t.id, field="", limit=5, offset=1295, user=OWNER, db=self.db)
        self.assertEqual([e["from"] for e in last["items"]], ["4", "3", "2", "1", "0"])
        self.assertFalse(last["more"])


class DiffUnitTests(Base):
    def test_assignee_order_and_blank_shapes_are_not_changes(self):
        t = self.task(assignee_email="a@x.com", assignee_emails=["a@x.com", "b@x.com"], tags=[])
        before = task_history.snapshot(t)
        t.assignee_emails = ["b@x.com", "a@x.com"]
        t.tags = None
        t.custom_field_values = {"cf-x": ""}
        self.assertEqual(task_history.diff(self.db, before, task_history.snapshot(t)), [])


class MovedSubtreeTests(Base):
    """Oct 22 2026 integration review: a move into another project takes the
    whole subtree with it, and each moved row's history says so."""

    def _projects(self):
        a = models.TaskProject(id=gen_id(), name="Alpha", created_at=now_iso())
        b = models.TaskProject(id=gen_id(), name="Beta", created_at=now_iso())
        self.db.add_all([a, b])
        self.db.commit()
        return a, b

    def _tree(self, a):
        sec = models.TaskSection(id=gen_id(), project_id=a.id, name="Doing", created_at=now_iso())
        self.db.add(sec)
        self.db.commit()
        p = self.task(title="P", project_id=a.id, section_id=sec.id)
        s = self.task(title="S", project_id=a.id, parent_task_id=p.id)
        ss = self.task(title="SS", project_id=a.id, parent_task_id=s.id, section_id=sec.id)
        p.subtask_ids = [s.id]
        s.subtask_ids = [ss.id]
        self.db.commit()
        return sec, p, s, ss

    def test_a_moved_subtree_records_each_rows_project_and_section(self):
        a, b = self._projects()
        sec, p, s, ss = self._tree(a)
        self.patch(s, user=MANAGER, parent_task_id="", project_id=b.id)
        got = [c for c in self.changes(ss) if c[0] in ("projectId", "sectionId")]
        self.assertEqual(got, [("projectId", a.id, b.id, MANAGER["email"], "field_changed"),
                               ("sectionId", sec.id, None, MANAGER["email"], "field_changed")])
        mine = [c for c in self.changes(s) if c[0] == "projectId"]
        self.assertEqual(mine, [("projectId", a.id, b.id, MANAGER["email"], "field_changed")])
        # Read back through the endpoint with the project names kept.
        rows = self.history(ss, user=MANAGER, field="projectId")
        self.assertEqual(rows[0]["labels"][b.id]["label"], "Beta")

    def test_a_child_moved_by_its_new_parents_edit_records_its_project(self):
        a, b = self._projects()
        sec, p, s, ss = self._tree(a)
        x = self.task(title="X", project_id=b.id)
        self.patch(x, user=MANAGER, subtask_ids=[s.id])
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, s.id).project_id, b.id)
        self.assertIn(("projectId", a.id, b.id, MANAGER["email"], "field_changed"), self.changes(s))
        self.assertIn(("projectId", a.id, b.id, MANAGER["email"], "field_changed"), self.changes(ss))

    def test_a_rules_move_records_the_subtasks_as_the_automation(self):
        a, b = self._projects()
        sec, p, s, ss = self._tree(a)
        self.rule({"type": "status_changed", "value": "in_progress"},
                  [{"type": "move_to_project", "value": {"projectId": b.id}}])
        self.patch(p, user=MANAGER, status="in_progress")
        self.db.expire_all()
        self.assertEqual(self.db.get(models.Task, ss.id).project_id, b.id)
        self.assertIn(("projectId", a.id, b.id, AUTO, "field_changed"), self.changes(s))
        self.assertIn(("projectId", a.id, b.id, AUTO, "field_changed"), self.changes(ss))
        self.assertIn(("sectionId", sec.id, None, AUTO, "field_changed"), self.changes(ss))


if __name__ == "__main__":
    unittest.main()
