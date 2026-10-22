"""Import tasks from CSV / Excel (Neil, Oct 22 2026) - POST /tasks/import.

Dry run vs real run, the project role (viewer refused), company walls,
required custom fields, people left off, Parent rows (subtasks after their
parents, in file order), the 2,000-row limit, one transaction (a failure
part-way leaves nothing), no email storm, statuses / options, automation,
and the date rules (03/04/2026 is March 4 - never April 3).

Throwaway SQLite, no network.  python -m pytest test_task_import.py
"""
import os
import tempfile
import unittest
from unittest import mock

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_db.name}"

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import event

import cache
import database
import models
import task_import
from routers import tasks as T
from routers.task_util import gen_id, now_iso


def _assert_isolated():
    actual = database.engine.url.database or ""
    if os.path.normcase(os.path.abspath(actual)) != os.path.normcase(os.path.abspath(_tmp_db.name)):
        raise RuntimeError(f"{__name__} deletes rows and is pointed at {actual!r}, not its own temp "
                           f"database. Run it on its own: python -m pytest {__name__}.py")


_assert_isolated()

OWNER = {"email": "owner@greensglobal.com", "level": 1}
EDITOR = {"email": "editor@greensglobal.com", "level": 1}
VIEWER = {"email": "viewer@greensglobal.com", "level": 1}
OUTSIDER = {"email": "outsider@greensglobal.com", "level": 1}
MANAGER = {"email": "manager@greensglobal.com", "level": 3}
ANA = "ana@greensglobal.com"
BEN = "ben@greensglobal.com"

_CLEAR = (models.Task, models.TaskProject, models.TaskActivity, models.TaskNotification, models.NexusNotification,
          models.NexusEmployee, models.TaskCustomField, models.TaskCustomStatus, models.TaskSection,
          models.TaskAutomationRule, models.TaskAutomationRun, models.TaskComment, models.NexusSetting,
          models.TaskEmailQueue)


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
        people = [(OWNER["email"], "Olive", "Owner"), (EDITOR["email"], "Ed", "Editor"),
                  (VIEWER["email"], "Vi", "Viewer"), (OUTSIDER["email"], "Otto", "Side"),
                  (MANAGER["email"], "Mona", "Manager"), (ANA, "Ana", "Lopez"), (BEN, "Ben", "Stone")]
        for email, first, last in people:
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=first, last_name=last,
                                             status="active", company="co-a"))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email="leaver@greensglobal.com", first_name="Lee",
                                         last_name="Leaver", status="offboarded", company="co-a"))
        # Two people with the same name: a name alone cannot say which.
        for email in ("sam1@greensglobal.com", "sam2@greensglobal.com"):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name="Sam", last_name="Lee",
                                             status="active", company="co-a"))
        self.db.add(models.NexusEmployee(id=gen_id(), work_email="bee@greensglobal.com", first_name="Bea",
                                         last_name="Bee", status="active", company="co-b"))
        self.db.commit()
        cache.settings_config.invalidate()
        self.p = self.project()

    def tearDown(self):
        self.db.close()
        cache.settings_config.invalidate()

    def project(self, **kw):
        kw.setdefault("access_level", "restricted")
        kw.setdefault("owner_email", OWNER["email"])
        kw.setdefault("member_roles", {EDITOR["email"]: "editor", VIEWER["email"]: "viewer"})
        p = models.TaskProject(id=gen_id(), name=kw.pop("name", "Launch Plan"), created_at=now_iso(), **kw)
        self.db.add(p)
        self.db.commit()
        return p

    def run_import(self, rows, user=EDITOR, dry=False, project=None, bg=None, **kw):
        body = T.TaskImportBody(project_id=(project or self.p).id, dry_run=dry, file_name="plan.xlsx",
                                rows=rows, **kw)
        return T.import_tasks(body, bg or BackgroundTasks(), user=user, db=self.db)

    def code(self, call):
        with self.assertRaises(HTTPException) as e:
            call()
        self.db.rollback()
        return e.exception.status_code

    def tasks(self):
        self.db.expire_all()
        return self.db.query(models.Task).all()

    def by_title(self):
        return {t.title: t for t in self.tasks()}


class DryRunTests(Base):
    def test_dry_run_reports_and_writes_nothing(self):
        r = self.run_import([{"row": 2, "title": "Order steel", "due": "03/04/2026", "priority": "high"},
                             {"row": 3, "title": "", "due": "x"}], dry=True)
        self.assertTrue(r["dryRun"])
        self.assertEqual((r["total"], r["valid"], r["skipped"]), (2, 1, 1))
        self.assertEqual(r["rows"][0]["dueOn"], "2026-03-04")
        self.assertEqual(r["rows"][0]["priority"], "high")
        self.assertIn("Title is required.", r["rows"][1]["errors"])
        self.assertTrue(any("is not a date" in e for e in r["rows"][1]["errors"]))
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.db.query(models.TaskActivity).count(), 0)

    def test_real_run_creates_what_the_dry_run_promised(self):
        rows = [{"row": 2, "title": "Order steel", "due": "03/04/2026", "start": "2026-02-01",
                 "priority": "Urgent", "status": "in progress", "tags": "steel, Steel; site",
                 "assignees": "ana@greensglobal.com", "description": "Line one\nLine <b>two</b>"},
                {"row": 3, "title": "Pour slab", "due": 46115}]
        dry = self.run_import(rows, dry=True)
        r = self.run_import(rows)
        self.assertEqual((r["created"], r["skipped"]), (2, 0))
        self.assertEqual(dry["valid"], r["created"])
        t = self.by_title()
        steel = t["Order steel"]
        self.assertEqual(steel.due_on, "2026-03-04")
        self.assertEqual(steel.start_on, "2026-02-01")
        self.assertEqual((steel.priority, steel.status), ("urgent", "in_progress"))
        self.assertEqual(steel.tags, ["steel", "site"])
        self.assertEqual(steel.assignee_emails, [ANA])
        self.assertEqual(steel.project_id, self.p.id)
        self.assertEqual(steel.access_level, "restricted")   # the project's own
        self.assertIn(EDITOR["email"], steel.follower_emails)   # whoever raised it follows it
        self.assertEqual(steel.description, "<p>Line one<br>Line &lt;b&gt;two&lt;/b&gt;</p>")
        self.assertTrue(steel.code.startswith("TASK-"))
        self.assertNotEqual(steel.code, t["Pour slab"].code)
        self.assertEqual(t["Pour slab"].due_on, "2026-04-03")   # Excel serial 46115
        # File order is the manual order.
        self.assertLess(steel.position, t["Pour slab"].position)
        # One "created" row per task, and one project-level entry.
        acts = self.db.query(models.TaskActivity).all()
        self.assertEqual(sum(1 for a in acts if a.type == "created" and a.entity_kind == "task"), 2)
        proj = [a for a in acts if a.entity_kind == "project"]
        self.assertEqual(len(proj), 1)
        self.assertEqual(proj[0].detail, "imported 2 tasks from plan.xlsx")

    def test_codes_continue_the_counter_and_never_repeat(self):
        T.create_task(T.TaskCreate(title="Typed", project_id=self.p.id), BackgroundTasks(), user=EDITOR, db=self.db)
        self.run_import([{"row": i + 2, "title": f"Row {i}"} for i in range(5)])
        codes = [t.code for t in self.tasks()]
        self.assertEqual(len(codes), len(set(codes)))
        nxt = T.create_task(T.TaskCreate(title="After", project_id=self.p.id), BackgroundTasks(),
                            user=EDITOR, db=self.db)
        self.assertNotIn(nxt["code"], codes)
        nums = sorted(int(c.split("-")[1]) for c in codes + [nxt["code"]])
        self.assertEqual(nums, list(range(nums[0], nums[0] + 7)))


class AccessTests(Base):
    def test_viewer_and_outsider_are_refused(self):
        self.assertEqual(self.code(lambda: self.run_import([{"title": "x"}], user=VIEWER, dry=True)), 403)
        self.assertEqual(self.code(lambda: self.run_import([{"title": "x"}], user=OUTSIDER)), 403)
        self.assertEqual(self.tasks(), [])

    def test_owner_editor_and_manager_may(self):
        for who in (OWNER, EDITOR, MANAGER):
            self.assertEqual(self.run_import([{"title": f"by {who['email']}"}], user=who)["created"], 1)

    def test_unknown_project_is_404(self):
        body = T.TaskImportBody(project_id="nope", rows=[{"title": "x"}])
        self.assertEqual(self.code(lambda: T.import_tasks(body, BackgroundTasks(), user=MANAGER, db=self.db)), 404)

    def test_add_missing_options_needs_a_manager(self):
        self.assertEqual(self.code(lambda: self.run_import([{"title": "x"}], add_missing_options=True)), 403)

    def test_external_cannot_import_into_an_org_project_they_cannot_see(self):
        org = self.project(name="Everyone", access_level="org", member_roles={})
        ext = {"email": "guest@gmail.com", "level": 1, "external": True}
        self.assertEqual(self.code(lambda: self.run_import([{"title": "x"}], user=ext, project=org)), 404)


class WallTests(Base):
    def arm(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def test_another_companys_project_is_a_404_even_for_a_manager(self):
        self.arm()
        b = self.project(name="B plan", access_level="org", company_id="co-b", owner_email="bee@greensglobal.com")
        self.assertEqual(self.code(lambda: self.run_import([{"title": "x"}], user=MANAGER, project=b)), 404)
        self.assertEqual(self.tasks(), [])

    def test_people_over_the_wall_are_left_off(self):
        self.arm()
        r = self.run_import([{"row": 2, "title": "x", "assignees": "bee@greensglobal.com, ana@greensglobal.com"}])
        t = self.tasks()[0]
        self.assertEqual(t.assignee_emails, [ANA])
        self.assertEqual(t.company_id, "co-a")
        self.assertEqual(r["droppedPeople"], [{"email": "bee@greensglobal.com", "reason": "is in another company",
                                               "row": 2}])

    def test_a_name_never_finds_someone_over_the_wall(self):
        self.arm()
        r = self.run_import([{"row": 2, "title": "x", "assignees": "Bea Bee"}], dry=True)
        self.assertEqual(r["droppedPeople"], [{"email": "Bea Bee", "reason": "is not in the Nexus directory",
                                               "row": 2}])

    def test_walls_off_nothing_changes(self):
        self.run_import([{"title": "x", "assignees": "bee@greensglobal.com"}])
        self.assertEqual(self.tasks()[0].assignee_emails, ["bee@greensglobal.com"])


class PeopleTests(Base):
    def test_unknown_departed_and_ambiguous_people_are_dropped_with_a_warning(self):
        r = self.run_import([{"row": 2, "title": "x",
                              "assignees": "Ana Lopez; stranger@else.com, leaver@greensglobal.com, Sam Lee, "
                                           "Ben Stone <ben@greensglobal.com>"}])
        t = self.tasks()[0]
        self.assertEqual(sorted(t.assignee_emails), [ANA, BEN])
        reasons = {d["email"]: d["reason"] for d in r["droppedPeople"]}
        self.assertEqual(reasons["stranger@else.com"], "is not in the Nexus directory")
        self.assertEqual(reasons["leaver@greensglobal.com"], "has left")
        self.assertIn("more than one person", reasons["Sam Lee"])
        # The task's history says who was not added and why, like a create.
        self.assertTrue(self.db.query(models.TaskActivity).filter(
            models.TaskActivity.type == "people_not_added", models.TaskActivity.entity_id == t.id).count())

    def test_people_fields_resolve_through_the_directory(self):
        f = models.TaskCustomField(id=gen_id(), name="Reviewer", type="people", project_ids=[self.p.id])
        self.db.add(f)
        self.db.commit()
        r = self.run_import([{"title": "x", "custom": {f.id: "Ben Stone, nobody@x.com"}}])
        self.assertEqual(self.tasks()[0].custom_field_values, {f.id: [BEN]})
        self.assertEqual(r["created"], 1)


class RequiredFieldTests(Base):
    def setUp(self):
        super().setUp()
        self.f = models.TaskCustomField(id=gen_id(), name="Budget Code", type="text",
                                        project_ids=[self.p.id], required_project_ids=[self.p.id])
        self.db.add(self.f)
        self.db.commit()

    def test_a_top_level_row_missing_a_required_field_is_an_error(self):
        r = self.run_import([{"row": 2, "title": "Has it", "custom": {self.f.id: "B-1"}},
                             {"row": 3, "title": "Lacks it"},
                             {"row": 4, "title": "Sub of 3", "parent": "3"},
                             {"row": 5, "title": "Sub of 2", "parent": "Has it"}])
        self.assertEqual((r["created"], r["skipped"]), (2, 2))
        errs = {e["row"]: e["errors"] for e in r["errors"]}
        self.assertEqual(errs[3], ["Budget Code is required in this project."])
        self.assertEqual(errs[4], ["Parent row 3 is not being imported."])
        # A subtask is part of its parent - it needs no value of its own.
        self.assertEqual(sorted(self.by_title()), ["Has it", "Sub of 2"])


class ParentTests(Base):
    def test_subtasks_come_after_their_parents_in_file_order(self):
        rows = [{"row": 2, "title": "Child A", "parent": "Phase 1"},
                {"row": 3, "title": "Phase 1"},
                {"row": 4, "title": "Child B", "parent": "row 3"},
                {"row": 5, "title": "Grandchild", "parent": "#4"},
                {"row": 6, "title": "Child C", "parent": "phase 1"}]
        dry = self.run_import(rows, dry=True)
        self.assertEqual([x["parentRow"] for x in dry["rows"]], [3, None, 3, 4, 3])
        r = self.run_import(rows)
        self.assertEqual(r["created"], 5)
        t = self.by_title()
        phase = t["Phase 1"]
        self.assertEqual(phase.subtask_ids, [t["Child A"].id, t["Child B"].id, t["Child C"].id])
        self.assertEqual(t["Child B"].subtask_ids, [t["Grandchild"].id])
        self.assertEqual(t["Grandchild"].parent_task_id, t["Child B"].id)
        self.assertEqual(r["topLevelIds"], [phase.id])

    def test_bad_parents_are_errors(self):
        r = self.run_import([{"row": 2, "title": "A", "parent": "B"},
                             {"row": 3, "title": "B", "parent": "A"},
                             {"row": 4, "title": "Dup"}, {"row": 5, "title": "Dup"},
                             {"row": 6, "title": "C", "parent": "Dup"},
                             {"row": 7, "title": "D", "parent": "Nowhere"},
                             {"row": 8, "title": "E", "parent": "8"}], dry=True)
        errs = {x["row"]: " ".join(x["errors"]) for x in r["rows"]}
        self.assertIn("loop", errs[2])
        self.assertIn("loop", errs[3])
        self.assertIn("more than one row", errs[6])
        self.assertIn("not a row in this file", errs[7])
        self.assertIn("own parent", errs[8])
        self.assertEqual(errs[4], "")


class LimitAndTransactionTests(Base):
    def test_more_than_2000_rows_is_refused(self):
        self.assertEqual(self.code(lambda: self.run_import([{"title": "x"}] * 2001, dry=True)), 422)
        self.assertEqual(self.code(lambda: self.run_import([], dry=True)), 422)

    def test_2000_rows_import_in_one_go_with_a_bounded_number_of_queries(self):
        statements = []

        def count(*_a, **_k):
            statements.append(1)
        event.listen(database.engine, "before_cursor_execute", count)
        try:
            r = self.run_import([{"row": i + 2, "title": f"Task {i}", "assignees": ANA if i % 2 else BEN,
                                  "due": "10/30/2026"} for i in range(2000)])
        finally:
            event.remove(database.engine, "before_cursor_execute", count)
        self.assertEqual(r["created"], 2000)
        self.assertEqual(len(self.tasks()), 2000)
        # Linear, not per-row lookups of the directory/fields/rules/counter.
        # A few dozen in all today (the inserts are batched): the directory,
        # fields, statuses, rules and the counter are each read once, never
        # per row - one per-row lookup would add 2,000.
        self.assertLess(len(statements), 200)

    def test_a_failure_part_way_leaves_nothing_behind(self):
        real = T._new_task_row
        calls = {"n": 0}

        def flaky(*a, **kw):
            calls["n"] += 1
            if calls["n"] == 3:
                raise RuntimeError("database went away")
            return real(*a, **kw)
        with mock.patch.object(T, "_new_task_row", side_effect=flaky):
            self.assertEqual(self.code(lambda: self.run_import(
                [{"title": f"T{i}", "section": "New Phase"} for i in range(5)], create_sections=True)), 500)
        self.assertEqual(self.tasks(), [])
        self.assertEqual(self.db.query(models.TaskSection).count(), 0)
        self.assertEqual(self.db.query(models.TaskActivity).count(), 0)

    def test_every_row_bad_imports_nothing(self):
        self.assertEqual(self.code(lambda: self.run_import([{"title": ""}])), 422)


class NotifyTests(Base):
    def test_off_by_default_no_bells_no_mail(self):
        bg = BackgroundTasks()
        with mock.patch("task_notify.notify_task_event") as per_task:
            self.run_import([{"title": f"T{i}", "assignees": ANA} for i in range(30)], bg=bg)
        per_task.assert_not_called()
        self.assertEqual(bg.tasks, [])
        self.assertEqual(self.db.query(models.TaskNotification).count(), 0)
        self.assertEqual(self.db.query(models.NexusNotification).count(), 0)

    def test_on_one_bell_and_one_batched_mail_per_person(self):
        bg = BackgroundTasks()
        with mock.patch("task_notify.notify_task_event") as per_task:
            self.run_import([{"title": f"T{i}", "assignees": ANA if i < 30 else BEN} for i in range(31)],
                            bg=bg, notify_assignees=True)
        per_task.assert_not_called()
        bells = self.db.query(models.TaskNotification).all()
        self.assertEqual(sorted(b.for_email for b in bells), [ANA, BEN])
        ana = next(b for b in bells if b.for_email == ANA)
        self.assertEqual(ana.title, "You Were Assigned 30 Tasks")
        self.assertEqual(len(bg.tasks), 1)
        with mock.patch("task_notify.queue_bulk_assignments") as queue:
            bg.tasks[0].func(*bg.tasks[0].args, **bg.tasks[0].kwargs)
        queue.assert_called_once()
        assigned = queue.call_args[0][2]
        self.assertEqual(len(assigned[ANA]), 30)
        self.assertEqual(len(assigned[BEN]), 1)

    def test_the_batched_mail_queues_one_row_per_task_for_one_email(self):
        bg = BackgroundTasks()
        self.run_import([{"title": f"T{i}", "assignees": ANA, "due": "12/30/2026"} for i in range(3)],
                        bg=bg, notify_assignees=True)
        bg.tasks[0].func(*bg.tasks[0].args, **bg.tasks[0].kwargs)
        rows = self.db.query(models.TaskEmailQueue).all()
        self.assertEqual({r.recipient for r in rows}, {ANA})
        self.assertEqual(len(rows), 3)   # flush_batches sends them as ONE email


class ValueTests(Base):
    def test_statuses_and_priorities(self):
        s = models.TaskCustomStatus(id="waiting", label="Waiting on Client", project_ids=[self.p.id])
        other = models.TaskCustomStatus(id="elsewhere", label="Elsewhere Only", project_ids=["other"])
        self.db.add_all([s, other])
        self.db.commit()
        r = self.run_import([{"row": 2, "title": "a", "status": "waiting on client"},
                             {"row": 3, "title": "b", "status": "Done"},
                             {"row": 4, "title": "c", "status": "Elsewhere Only", "priority": "Sky High"}])
        t = self.by_title()
        self.assertEqual(t["a"].status, "waiting")
        self.assertEqual((t["b"].status, t["b"].completed), ("completed", True))
        self.assertEqual((t["c"].status, t["c"].priority), ("not_started", "medium"))
        warn = " ".join(x for e in r.get("errors", []) for x in e["errors"])
        self.assertEqual(warn, "")

    def test_select_options_unknown_left_empty_unless_a_manager_adds_them(self):
        f = models.TaskCustomField(id=gen_id(), name="Phase", type="select", project_ids=[self.p.id],
                                   options=[{"id": "o1", "label": "Design"}])
        self.db.add(f)
        self.db.commit()
        rows = [{"row": 2, "title": "a", "custom": {f.id: "design"}},
                {"row": 3, "title": "b", "custom": {f.id: "Build"}}]
        dry = self.run_import(rows, dry=True)
        self.assertTrue(any("is not an option" in w for w in dry["rows"][1]["warnings"]))
        self.run_import(rows)
        t = self.by_title()
        self.assertEqual(t["a"].custom_field_values, {f.id: "o1"})
        self.assertEqual(t["b"].custom_field_values, {})
        r = self.run_import([{"title": "c", "custom": {f.id: "Build"}}], user=MANAGER, add_missing_options=True)
        self.assertEqual(r["newOptions"], [{"fieldId": f.id, "field": "Phase", "label": "Build"}])
        self.db.expire_all()
        labels = [o["label"] for o in self.db.get(models.TaskCustomField, f.id).options]
        self.assertEqual(labels, ["Design", "Build"])
        self.assertEqual(self.by_title()["c"].custom_field_values, {f.id: "Build"})

    def test_sections_default_and_created(self):
        sec = models.TaskSection(id=gen_id(), project_id=self.p.id, name="Phase 1", position=1, custom=True)
        self.db.add(sec)
        self.db.commit()
        rows = [{"title": "a", "section": "phase 1"}, {"title": "b", "section": "Phase 2"}, {"title": "c"}]
        r = self.run_import(rows, dry=True, section_id=sec.id)
        self.assertTrue(any("not in this project" in w for w in r["rows"][1]["warnings"]))
        r = self.run_import(rows, create_sections=True, section_id=sec.id)
        self.assertEqual(r["newSections"], ["Phase 2"])
        made = self.db.query(models.TaskSection).filter(models.TaskSection.name == "Phase 2").one()
        self.assertTrue(made.custom)
        t = self.by_title()
        self.assertEqual((t["a"].section_id, t["b"].section_id, t["c"].section_id), (sec.id, made.id, sec.id))

    def test_created_rules_run_per_task_and_their_comments_are_silent(self):
        self.db.add(models.TaskAutomationRule(
            id=gen_id(), name="Flag", enabled=True, trigger={"type": "created"}, conditions=[],
            actions=[{"type": "add_tag", "value": "imported"}, {"type": "add_comment", "value": "Hello {title}"}],
            created_at=now_iso()))
        self.db.commit()
        self.run_import([{"title": f"T{i}", "assignees": ANA} for i in range(3)], notify_assignees=True)
        for t in self.tasks():
            self.assertEqual(t.tags, ["imported"])
        self.assertEqual(self.db.query(models.TaskComment).count(), 3)
        # The import's one bell for Ana - no comment bells on top of it.
        self.assertEqual([b.title for b in self.db.query(models.TaskNotification).all()],
                         ["You Were Assigned 3 Tasks"])


class DateTests(unittest.TestCase):
    def test_parsing(self):
        p = task_import.parse_import_date
        self.assertEqual(p("03/04/2026"), ("2026-03-04", True))     # March 4, never April 3
        self.assertEqual(p("3/4/26"), ("2026-03-04", True))
        self.assertEqual(p("03-04-2026"), ("2026-03-04", True))
        self.assertEqual(p("2026-03-04"), ("2026-03-04", True))
        self.assertEqual(p("2026-03-04T00:00:00Z"), ("2026-03-04", True))
        self.assertEqual(p("Oct 22, 2026"), ("2026-10-22", True))
        self.assertEqual(p(46115), ("2026-04-03", True))             # Excel serial
        self.assertEqual(p("46115"), ("2026-04-03", True))
        self.assertEqual(p(46115.75), ("2026-04-03", True))          # serial with a time
        self.assertEqual(p(""), ("", True))
        self.assertEqual(p(None), ("", True))
        for bad in ("25/03/2026", "13/01/2026", "02/30/2026", "20261022", "5", "soon", "03/04", True):
            self.assertEqual(p(bad), ("", False), bad)


if __name__ == "__main__":
    unittest.main()
