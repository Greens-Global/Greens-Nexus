"""
Ticket default assignee (Oct 2026, ticket_auto_assign.py) - through the real
routes (TestClient), only the signed-in identity swapped in. Covered:

  - resolution order: help topic's default > department's default > none;
  - the creator's own choice of assignee always wins;
  - an auto-assigned ticket is In Progress, its history says how it was
    assigned, and the assignee gets the bell and the "assigned" email a
    manual assignment sends - while the desk is not asked to assign it;
  - a default who left (or is not on the desk, or works for another
    company) is skipped at apply time, the next level is tried, and a gap
    line goes on the history (hidden from the requester);
  - a ticket awaiting approval is not assigned at creation, but at approval;
  - recategorizing a ticket later does not reassign it;
  - saving a default: the person must be an active desk agent of that
    company, and the company wall holds on department and help-topic
    settings alike.

Throwaway sqlite. No network (Graph and Teams are patched).

Run with: python -m pytest test_ticket_default_assignee.py -q
"""
import os
import tempfile
import unittest
from unittest.mock import patch

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"

from fastapi import FastAPI                     # noqa: E402
from fastapi.testclient import TestClient       # noqa: E402

import auth                                     # noqa: E402
import cache                                    # noqa: E402
import database                                 # noqa: E402
import models                                   # noqa: E402
import ticket_taxonomy                          # noqa: E402
from routers import tickets as T                # noqa: E402
from routers.task_util import gen_id            # noqa: E402

REQ = "req@greensglobal.com"
AGENT = "agent@greensglobal.com"
AGENT2 = "agent2@greensglobal.com"
LEFT = "left@greensglobal.com"
PLAIN = "plain@greensglobal.com"
INDIA = "india.agent@greensglobal.com"
ADMIN = "admin@greensglobal.com"
APPROVER = "approver@greensglobal.com"
GA = "ga@greensglobal.com"

USERS = {REQ: 1, AGENT: 1, AGENT2: 1, LEFT: 1, PLAIN: 1, INDIA: 1, ADMIN: 4, APPROVER: 2, GA: 4}


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        app = FastAPI()
        app.include_router(T.router)
        cls.who = {"email": REQ}
        app.dependency_overrides[auth.get_current_user] = lambda: {
            "email": cls.who["email"], "role": "employee", "level": USERS[cls.who["email"]]}
        cls.c = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        try:
            os.remove(_tmp.name)
        except OSError:
            pass

    def setUp(self):
        self.db = database.SessionLocal()
        self.addCleanup(self.db.close)
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.TaskNotification,
                  models.NexusNotification, models.NexusEmployee, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.NexusSetting, models.HrDepartment, models.HrEntity,
                  models.TicketDepartment, models.TicketEmailLog, models.TicketTeamsMessage):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        self.db.add(models.HrEntity(id="co1", name="Greens"))
        self.db.add(models.HrEntity(id="co2", name="Greens India"))
        for email, co, status in ((REQ, "co1", "active"), (AGENT, "co1", "active"), (AGENT2, "co1", "active"),
                                  (LEFT, "co1", "offboarded"), (PLAIN, "co1", "active"),
                                  (INDIA, "co2", "active"), (ADMIN, "co1", "active"),
                                  (APPROVER, "co1", "active"), (GA, "co1", "active")):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0].split(".")[0].title(),
                                             last_name="Person", company=co, status=status, identity_type="internal"))
        for email in (ADMIN, GA):
            self.db.add(models.NexusRole(email=email, role="administrator"))
        self.db.add(models.NexusGroup(id="desk", name="Service Desk", allowed_modules="tickets:editor"))
        for email in (AGENT, AGENT2, LEFT, INDIA):
            self.db.add(models.NexusGroupMember(group_id="desk", email=email))
        self.db.add(models.NexusGroup(id="ga", name="Global Admins", is_global_admin=1))
        self.db.add(models.NexusGroupMember(group_id="ga", email=GA))
        self.db.add(models.HrDepartment(id="dIT", company_id="co1", name="IT"))
        self.db.add(models.HrDepartment(id="dOps", company_id="co1", name="Operations"))
        self.db.add(models.HrDepartment(id="dIT2", company_id="co2", name="IT"))
        self.db.commit()
        T._sync_ticket_departments(self.db)
        cache.settings_config.invalidate()
        for target in ("graph_mail.send_mail", "teams_post.deliver_ticket_row"):
            p = patch(target, return_value={})
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(cache.settings_config.invalidate)

    # ── helpers ──────────────────────────────────────────────────────────
    def as_(self, email):
        type(self).who["email"] = email
        return self.c

    def walls_on(self):
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        cache.settings_config.invalidate()

    def file(self, who=REQ, **body):
        body.setdefault("subject", "Printer jam")
        body.setdefault("type", "incident")
        body.setdefault("hr_department_id", "dIT")
        body.setdefault("application", "Printer or Scanner")
        r = self.as_(who).post("/task-tickets", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def set_dept_default(self, dept_id, email):
        row = self.db.query(models.TicketDepartment).filter_by(id=dept_id).one()
        row.default_assignee_email = email
        self.db.commit()

    def set_topic_default(self, topic, assignees):
        cfg = ticket_taxonomy.get_config(self.db)
        for g in cfg["helpTopics"]:
            for tp in g["topics"]:
                if tp["name"] == topic:
                    tp["defaultAssignees"] = assignees
        ticket_taxonomy.save_config(self.db, {"helpTopics": cfg["helpTopics"]}, "test")

    def row(self, tid):
        self.db.expire_all()
        return self.db.query(models.TaskTicket).filter_by(id=tid).one()

    def activity(self, tid, kind):
        self.db.expire_all()
        return [a.detail for a in self.db.query(models.TaskActivity).filter_by(entity_id=tid, type=kind).all()]

    def bells(self, email, kind):
        self.db.expire_all()
        return self.db.query(models.TaskNotification).filter_by(for_email=email, kind=kind).count()


class ResolutionOrderTests(_Base):
    def test_no_default_leaves_it_for_the_desk(self):
        t = self.file()
        self.assertIsNone(t["assigneeId"])
        self.assertEqual(self.row(t["id"]).status, "open")
        self.assertGreater(self.bells(ADMIN, "ticket_needs_assignment"), 0)
        self.assertEqual(self.activity(t["id"], "auto_assigned"), [])

    def test_department_default_takes_it(self):
        self.set_dept_default("dIT", AGENT)
        t = self.file()
        r = self.row(t["id"])
        self.assertEqual(r.assignee_email, AGENT)
        self.assertEqual(r.status, "in_progress")
        self.assertEqual(self.activity(t["id"], "auto_assigned"),
                         ["Assigned to Agent Person automatically (department: IT)"])

    def test_help_topic_beats_department(self):
        self.set_dept_default("dIT", AGENT)
        self.set_topic_default("Printer or Scanner", {"co1": AGENT2})
        t = self.file()
        self.assertEqual(self.row(t["id"]).assignee_email, AGENT2)
        self.assertEqual(self.activity(t["id"], "auto_assigned"),
                         ["Assigned to Agent2 Person automatically (help topic: Printer or Scanner)"])

    def test_topic_default_is_per_company(self):
        # Greens India's entry does not assign a Greens ticket.
        self.set_topic_default("Printer or Scanner", {"co2": INDIA})
        self.set_dept_default("dIT", AGENT)
        t = self.file()
        self.assertEqual(self.row(t["id"]).assignee_email, AGENT)

    def test_creators_choice_wins(self):
        self.set_dept_default("dIT", AGENT)
        self.set_topic_default("Printer or Scanner", {"co1": AGENT})
        t = self.file(who=ADMIN, requester_email=REQ, assignee_email=AGENT2)
        self.assertEqual(self.row(t["id"]).assignee_email, AGENT2)
        self.assertEqual(self.activity(t["id"], "auto_assigned"), [])

    def test_assignee_hears_like_a_manual_assignment(self):
        self.set_dept_default("dIT", AGENT)
        t = self.file()
        self.assertEqual(self.bells(AGENT, "ticket_assigned"), 1)
        # Assigned already: the desk (no roster = the administrators) is not asked to assign it.
        self.assertEqual(self.bells(ADMIN, "ticket_needs_assignment"), 0)
        self.db.expire_all()
        mails = {(m.event_type, m.recipient, m.recipient_role)
                 for m in self.db.query(models.TicketEmailLog).filter_by(ticket_id=t["id"]).all()}
        self.assertIn(("assigned", AGENT, "assignee"), mails)
        self.assertIn(("created", REQ, "requester"), mails)
        self.assertNotIn(("created", ADMIN, "it_admin"), mails)
        # And the assignee's Teams message to the requester is queued.
        self.assertEqual(self.db.query(models.TicketTeamsMessage)
                         .filter_by(ticket_id=t["id"], agent_email=AGENT).count(), 1)


class FallbackTests(_Base):
    def test_left_topic_default_falls_back_to_department_and_logs_the_gap(self):
        self.set_topic_default("Printer or Scanner", {"co1": LEFT})
        self.set_dept_default("dIT", AGENT)
        t = self.file()
        self.assertEqual(self.row(t["id"]).assignee_email, AGENT)
        gaps = self.activity(t["id"], "auto_assign_gap")
        self.assertEqual(len(gaps), 1)
        self.assertIn("help topic: Printer or Scanner", gaps[0])
        self.assertIn("no longer an active desk agent", gaps[0])

    def test_nobody_valid_leaves_it_unassigned(self):
        self.set_topic_default("Printer or Scanner", {"co1": LEFT})
        self.set_dept_default("dIT", PLAIN)            # not on the desk
        t = self.file()
        r = self.row(t["id"])
        self.assertEqual(r.assignee_email, "")
        self.assertEqual(r.status, "open")
        self.assertEqual(len(self.activity(t["id"], "auto_assign_gap")), 2)
        self.assertGreater(self.bells(ADMIN, "ticket_needs_assignment"), 0)

    def test_other_company_agent_is_skipped_behind_the_wall(self):
        self.walls_on()
        self.set_dept_default("dIT", INDIA)            # written straight to the row
        t = self.file()
        self.assertEqual(self.row(t["id"]).assignee_email, "")
        self.assertEqual(len(self.activity(t["id"], "auto_assign_gap")), 1)

    def test_gap_lines_are_the_desks_only(self):
        self.set_dept_default("dIT", LEFT)
        t = self.file()
        mine = [a["type"] for a in self.as_(REQ).get(f"/task-tickets/{t['id']}/activity").json()]
        desk = [a["type"] for a in self.as_(AGENT).get(f"/task-tickets/{t['id']}/activity").json()]
        self.assertNotIn("auto_assign_gap", mine)
        self.assertIn("auto_assign_gap", desk)


class ApprovalAndRecategorizeTests(_Base):
    def test_gated_ticket_is_assigned_at_approval_not_creation(self):
        self.set_dept_default("dIT", AGENT)
        t = self.file(type="access_request", subject="Access to Sage")
        r = self.row(t["id"])
        self.assertEqual(r.approval_status, "pending")
        self.assertEqual(r.assignee_email, "")
        self.assertEqual(self.activity(t["id"], "auto_assigned"), [])
        res = self.as_(ADMIN).post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": APPROVER})
        self.assertEqual(res.status_code, 200, res.text)
        res = self.as_(APPROVER).post(f"/task-tickets/{t['id']}/approval", json={"decision": "approve"})
        self.assertEqual(res.status_code, 200, res.text)
        r = self.row(t["id"])
        self.assertEqual(r.assignee_email, AGENT)
        self.assertEqual(r.status, "in_progress")
        self.assertEqual(self.activity(t["id"], "auto_assigned"),
                         ["Assigned to Agent Person automatically (department: IT)"])
        self.assertEqual(self.bells(AGENT, "ticket_assigned"), 1)
        self.db.expire_all()
        self.assertTrue(self.db.query(models.TicketEmailLog)
                        .filter_by(ticket_id=t["id"], event_type="assigned", recipient=AGENT).count())

    def test_rejected_ticket_is_never_auto_assigned(self):
        self.set_dept_default("dIT", AGENT)
        t = self.file(type="access_request", subject="Access to Sage")
        self.as_(ADMIN).post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": APPROVER})
        self.as_(APPROVER).post(f"/task-tickets/{t['id']}/approval", json={"decision": "reject", "note": "No"})
        self.assertEqual(self.row(t["id"]).assignee_email, "")

    def test_recategorizing_does_not_reassign(self):
        self.set_dept_default("dOps", AGENT)
        t = self.file()                                 # IT, no default
        self.assertIsNone(t["assigneeId"])
        res = self.as_(ADMIN).patch(f"/task-tickets/{t['id']}", json={"hr_department_id": "dOps"})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(self.row(t["id"]).assignee_email, "")
        self.assertEqual(self.activity(t["id"], "auto_assigned"), [])


class SettingsTests(_Base):
    def test_department_default_must_be_a_desk_agent(self):
        bad = self.as_(ADMIN).patch("/ticket-departments/dIT", json={"default_assignee_email": PLAIN})
        self.assertEqual(bad.status_code, 400)
        left = self.as_(ADMIN).patch("/ticket-departments/dIT", json={"default_assignee_email": LEFT})
        self.assertEqual(left.status_code, 400)
        ok = self.as_(ADMIN).patch("/ticket-departments/dIT", json={"default_assignee_email": AGENT.upper()})
        self.assertEqual(ok.status_code, 200, ok.text)
        it = next(d for d in ok.json() if d["id"] == "dIT")
        self.assertEqual(it["defaultAssigneeEmail"], AGENT)
        cleared = self.as_(ADMIN).patch("/ticket-departments/dIT", json={"default_assignee_email": ""})
        self.assertEqual(next(d for d in cleared.json() if d["id"] == "dIT")["defaultAssigneeEmail"], "")

    def test_department_default_must_work_for_that_company(self):
        self.walls_on()
        res = self.as_(GA).patch("/ticket-departments/dIT", json={"default_assignee_email": INDIA})
        self.assertEqual(res.status_code, 400)
        res = self.as_(GA).patch("/ticket-departments/dIT2", json={"default_assignee_email": INDIA})
        self.assertEqual(res.status_code, 200, res.text)

    def test_department_settings_respect_the_company_wall(self):
        self.walls_on()
        res = self.as_(ADMIN).patch("/ticket-departments/dIT2", json={"default_assignee_email": INDIA})
        self.assertEqual(res.status_code, 404)
        self.as_(GA).patch("/ticket-departments/dIT2", json={"default_assignee_email": INDIA})
        listed = self.as_(ADMIN).get("/ticket-departments").json()
        self.assertEqual(next(d for d in listed if d["id"] == "dIT2")["defaultAssigneeEmail"], "")

    def _topics_with(self, assignees):
        cfg = self.as_(ADMIN).get("/task-tickets/taxonomy/settings").json()
        for g in cfg["helpTopics"]:
            for tp in g["topics"]:
                if tp["name"] == "Printer or Scanner":
                    if assignees is None:
                        tp.pop("defaultAssignees", None)
                    else:
                        tp["defaultAssignees"] = assignees
        return cfg["helpTopics"]

    def _topic(self):
        for g in ticket_taxonomy.get_config(self.db)["helpTopics"]:
            for tp in g["topics"]:
                if tp["name"] == "Printer or Scanner":
                    return tp

    def test_topic_default_must_be_a_desk_agent(self):
        res = self.as_(ADMIN).put("/task-tickets/taxonomy/settings", json={"helpTopics": self._topics_with({"co1": PLAIN})})
        self.assertEqual(res.status_code, 400)
        res = self.as_(ADMIN).put("/task-tickets/taxonomy/settings", json={"helpTopics": self._topics_with({"co1": AGENT})})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(self._topic()["defaultAssignees"], {"co1": AGENT})

    def test_an_unchanged_default_who_left_does_not_block_other_edits(self):
        self.set_topic_default("Printer or Scanner", {"co1": LEFT})
        res = self.as_(ADMIN).put("/task-tickets/taxonomy/settings", json={"helpTopics": self._topics_with({"co1": LEFT})})
        self.assertEqual(res.status_code, 200, res.text)

    def test_topic_defaults_respect_the_company_wall(self):
        self.set_topic_default("Printer or Scanner", {"co1": AGENT, "co2": INDIA})
        self.walls_on()
        # ADMIN (Greens only) never sees Greens India's choice...
        seen = self.as_(ADMIN).get("/task-tickets/taxonomy/settings").json()
        tp = next(tp for g in seen["helpTopics"] for tp in g["topics"] if tp["name"] == "Printer or Scanner")
        self.assertEqual(tp["defaultAssignees"], {"co1": AGENT})
        # ...so saving what they saw keeps it, and they cannot set it either.
        res = self.as_(ADMIN).put("/task-tickets/taxonomy/settings",
                                  json={"helpTopics": self._topics_with({"co1": AGENT2, "co2": AGENT})})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(self._topic()["defaultAssignees"], {"co1": AGENT2, "co2": INDIA})
        # Clearing their own leaves the other company's alone.
        self.as_(ADMIN).put("/task-tickets/taxonomy/settings", json={"helpTopics": self._topics_with(None)})
        self.assertEqual(self._topic()["defaultAssignees"], {"co2": INDIA})


if __name__ == "__main__":
    unittest.main()
