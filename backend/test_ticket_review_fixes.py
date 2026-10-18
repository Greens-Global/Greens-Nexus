"""
Ticket module review fixes (Oct 18 2026) - through the REAL routes.

The review found tests calling handlers directly hid a route-level bug (the
approval route carried a desk guard the named approver never passes), so
everything here goes through TestClient against the ticket router, with only
the signed-in identity swapped in. Covered:

  - a client-supplied ticket id is ignored, and the conversation endpoints
    refuse an id that is also a task's;
  - the named approver can open, and decide, the ticket they were sent;
  - a requester cannot file a ticket closed, assigned, of an unknown type or
    priority, or with an outside image;
  - a requester cannot link a task they cannot see;
  - the company wall on department settings, the delivery logs and
    request-approval (and approvers must be staff on the People list);
  - escalate has a cooldown and bells only the ticket's company admins;
  - SLA hours are validated (422) instead of 500ing every create;
  - whoever filed a ticket for a colleague can still open it;
  - email retries resend what was first rendered, with the real actor, and
    a "retrying" row left by a crash is picked up again;
  - two quick events of the same type do not share a version (no dropped email);
  - email times are in the reader's zone, US 12-hour, never UTC / raw ISO.

Throwaway sqlite. No network (Graph and Teams are patched).

Run with: python -m pytest test_ticket_review_fixes.py -q
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
# Storage-prefix checks (items._validate_photo_url) only bite with a project URL.
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

from fastapi import FastAPI                     # noqa: E402
from fastapi.testclient import TestClient       # noqa: E402

import auth                                     # noqa: E402
import cache                                    # noqa: E402
import database                                 # noqa: E402
import graph_mail                               # noqa: E402
import models                                   # noqa: E402
import ticket_notify                            # noqa: E402
from routers import tickets as T                # noqa: E402
from routers.task_util import gen_id, now_iso   # noqa: E402

SUPA = os.environ["SUPABASE_URL"].rstrip("/")
REQ = "req@greensglobal.com"
COLLEAGUE = "colleague@greensglobal.com"
APPROVER = "approver@greensglobal.com"
AGENT = "agent@greensglobal.com"
GA = "ga@greensglobal.com"
ADMIN1 = "admin1@greensglobal.com"
ADMIN2 = "admin2@greensglobal.com"
GUEST = "guest@partner.com"

USERS = {
    REQ: 1, COLLEAGUE: 1, APPROVER: 2, AGENT: 1, GA: 4, ADMIN1: 4, ADMIN2: 4, GUEST: 1,
}


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
        for m in (models.TaskTicket, models.Task, models.TaskProject, models.TaskComment,
                  models.TaskAttachment, models.TaskActivity, models.TaskNotification,
                  models.NexusNotification, models.NexusEmployee, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.NexusSetting, models.HrDepartment,
                  models.TicketDepartment, models.TicketEmailLog, models.TicketTeamsMessage):
            self.db.query(m).execution_options(include_deleted=True).delete()
        self.db.commit()
        for email, co, kind in ((REQ, "co1", "internal"), (COLLEAGUE, "co1", "internal"),
                                (APPROVER, "co1", "internal"), (AGENT, "co1", "internal"),
                                (GA, "co1", "internal"), (ADMIN1, "co1", "internal"),
                                (ADMIN2, "co2", "internal"), (GUEST, "co1", "guest")):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0].title(),
                                             company=co, status="active", identity_type=kind))
        for email in (GA, ADMIN1, ADMIN2):
            self.db.add(models.NexusRole(email=email, role="administrator"))
        # The desk: a tickets grant. And a populated Global Admins group, so
        # once the walls are on an administrator is confined to their company.
        self.db.add(models.NexusGroup(id="desk", name="Service Desk", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroupMember(group_id="desk", email=AGENT))
        self.db.add(models.NexusGroup(id="ga", name="Global Admins", is_global_admin=1))
        self.db.add(models.NexusGroupMember(group_id="ga", email=GA))
        self.db.commit()
        cache.settings_config.invalidate()
        mail = patch("graph_mail.send_mail", return_value={})
        mail.start()
        self.addCleanup(mail.stop)
        teams = patch("teams_post.deliver_ticket_row", return_value=True)
        teams.start()
        self.addCleanup(teams.stop)
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
        r = self.as_(who).post("/task-tickets", json=body)
        self.assertEqual(r.status_code, 201, r.text)
        return r.json()

    def ticket_row(self, **kw):
        t = models.TaskTicket(id=kw.pop("id", gen_id()), code=kw.pop("code", "000099"), subject="S",
                              status=kw.pop("status", "open"), priority="medium",
                              requester_email=kw.pop("requester_email", REQ), company_id=kw.pop("company_id", "co1"),
                              watcher_emails=kw.pop("watcher_emails", []), created_at=now_iso(),
                              modified_at=now_iso(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def row(self, ticket_id):
        self.db.expire_all()
        return self.db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()


class IdsAndConversationTests(_Base):
    def test_a_client_supplied_ticket_id_is_ignored(self):
        task = models.Task(id=gen_id(), code="TASK-1", title="Payroll secrets")
        self.db.add(task)
        self.db.commit()
        out = self.file(id=task.id)
        self.assertNotEqual(out["id"], task.id)
        self.assertIsNotNone(self.row(out["id"]))

    def test_the_comments_endpoint_refuses_a_task_id(self):
        task = models.Task(id=gen_id(), code="TASK-1", title="Payroll secrets")
        self.db.add(task)
        self.db.add(models.TaskComment(id=gen_id(), task_id=task.id, author_email=ADMIN1,
                                       body="<p>salary list</p>", created_at=now_iso()))
        self.db.commit()
        c = self.as_(REQ)
        self.assertEqual(c.get(f"/task-tickets/{task.id}/comments").status_code, 404)
        # A ticket that already carries a task's id (filed before ids were the
        # server's) is refused too - its thread IS the task's.
        self.ticket_row(id=task.id)
        self.assertEqual(c.get(f"/task-tickets/{task.id}/comments").status_code, 404)
        self.assertEqual(c.get(f"/task-tickets/{task.id}/attachments").status_code, 404)
        self.assertEqual(c.post(f"/task-tickets/{task.id}/comments", json={"body": "hi"}).status_code, 404)

    def test_saved_views_and_components_get_server_ids(self):
        r = self.as_(ADMIN1).post("/task-ticket-views", json={"id": "mine-1", "name": "Open"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertNotEqual(r.json()["id"], "mine-1")
        r = self.as_(ADMIN1).post("/task-ticket-components", json={"id": "comp-1", "name": "Network"})
        self.assertEqual(r.status_code, 201, r.text)
        self.assertNotEqual(r.json()["id"], "comp-1")

    def test_an_attachment_must_be_our_storage(self):
        t = self.file()
        c = self.as_(REQ)
        bad = c.post(f"/task-tickets/{t['id']}/attachments", json={"name": "x.png", "url": "https://evil.example/x.png"})
        self.assertEqual(bad.status_code, 400)
        ok = c.post(f"/task-tickets/{t['id']}/attachments",
                    json={"name": "x.png", "url": f"{SUPA}/storage/v1/object/public/ticket-evidence/x.png"})
        self.assertEqual(ok.status_code, 201, ok.text)
        # A failed upload still records the file by name (the drawer does this).
        self.assertEqual(c.post(f"/task-tickets/{t['id']}/attachments", json={"name": "y.mov", "url": ""}).status_code, 201)


class IntakeTests(_Base):
    def test_a_requester_cannot_file_it_closed(self):
        out = self.file(status="closed")
        self.assertEqual(out["status"], "open")

    def test_a_requester_cannot_assign_at_intake(self):
        r = self.as_(REQ).post("/task-tickets", json={"subject": "S", "type": "incident", "assignee_email": AGENT})
        self.assertEqual(r.status_code, 403)

    def test_unknown_type_and_priority_are_refused(self):
        c = self.as_(REQ)
        self.assertEqual(c.post("/task-tickets", json={"subject": "S", "type": "vip_lane"}).status_code, 422)
        self.assertEqual(c.post("/task-tickets", json={"subject": "S", "priority": "critical"}).status_code, 422)

    def test_images_must_be_our_storage(self):
        r = self.as_(REQ).post("/task-tickets", json={"subject": "S", "images": ["https://evil.example/a.png"]})
        self.assertEqual(r.status_code, 400)

    def test_the_desk_may_file_it_assigned_and_in_progress(self):
        out = self.file(who=AGENT, status="in_progress", assignee_email=COLLEAGUE)
        self.assertEqual((out["status"], out["assigneeId"]), ("in_progress", COLLEAGUE))

    def test_the_desk_cannot_assign_someone_off_the_people_list(self):
        r = self.as_(AGENT).post("/task-tickets", json={"subject": "S", "assignee_email": "nobody@nowhere.com"})
        self.assertEqual(r.status_code, 400)

    def test_the_desk_cannot_file_a_made_up_status(self):
        self.assertEqual(self.as_(AGENT).post("/task-tickets", json={"subject": "S", "status": "done"}).status_code, 422)


class ApproverTests(_Base):
    def _routed(self):
        t = self.file(type="access_request")
        r = self.as_(ADMIN1).post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": APPROVER})
        self.assertEqual(r.status_code, 200, r.text)
        return t

    def test_the_named_approver_can_open_and_decide_through_the_route(self):
        t = self._routed()
        c = self.as_(APPROVER)                     # not on the desk
        self.assertIn(t["id"], [x["id"] for x in c.get("/task-tickets").json()])
        self.assertEqual(c.get(f"/task-tickets/{t['id']}/comments").status_code, 200)
        r = c.post(f"/task-tickets/{t['id']}/approval", json={"decision": "approve", "note": "ok"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["approvalStatus"], "approved")
        # Decided: it is no longer theirs to read.
        self.assertNotIn(t["id"], [x["id"] for x in c.get("/task-tickets").json()])

    def test_someone_else_still_cannot_decide(self):
        t = self._routed()
        r = self.as_(COLLEAGUE).post(f"/task-tickets/{t['id']}/approval", json={"decision": "approve"})
        self.assertEqual(r.status_code, 403)

    def test_the_approver_must_be_staff_on_the_people_list(self):
        t = self.file(type="access_request")
        c = self.as_(ADMIN1)
        for who in ("stranger@gmail.com", GUEST):
            r = c.post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": who})
            self.assertEqual(r.status_code, 422, who)

    def test_request_approval_obeys_the_company_wall(self):
        t = self.file(type="access_request")
        self.walls_on()
        r = self.as_(ADMIN2).post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": APPROVER})
        self.assertEqual(r.status_code, 404)
        # An approver from another company could never open or decide it.
        r = self.as_(ADMIN1).post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": ADMIN2})
        self.assertEqual(r.status_code, 422)
        r = self.as_(ADMIN1).post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": APPROVER})
        self.assertEqual(r.status_code, 200, r.text)


class OnBehalfTests(_Base):
    def test_the_creator_can_open_a_ticket_filed_for_a_colleague(self):
        t = self.file(requester_email=COLLEAGUE)
        # The desk takes them off the collaborators; they filed it, so it still opens.
        r = self.as_(AGENT).patch(f"/task-tickets/{t['id']}", json={"watcher_emails": []})
        self.assertEqual(r.status_code, 200, r.text)
        c = self.as_(REQ)
        self.assertIn(t["id"], [x["id"] for x in c.get("/task-tickets").json()])
        self.assertIn(t["id"], [x["id"] for x in c.get("/task-tickets?mine=true").json()])
        self.assertEqual(c.get(f"/task-tickets/{t['id']}/comments").status_code, 200)

    def test_a_stranger_still_sees_nothing(self):
        t = self.file(requester_email=COLLEAGUE)
        c = self.as_(GUEST)
        self.assertNotIn(t["id"], [x["id"] for x in c.get("/task-tickets").json()])
        self.assertEqual(c.get(f"/task-tickets/{t['id']}/comments").status_code, 403)


class TaskLinkTests(_Base):
    def test_a_requester_cannot_link_a_task_they_cannot_see(self):
        proj = models.TaskProject(id=gen_id(), name="Board", owner_email=ADMIN1, access_level="restricted")
        hidden = models.Task(id=gen_id(), code="TASK-9", title="Hidden", project_id=proj.id)
        self.db.add_all([proj, hidden])
        self.db.commit()
        t = self.file()
        r = self.as_(REQ).patch(f"/task-tickets/{t['id']}", json={"task_ids": [hidden.id]})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.row(t["id"]).task_ids or [], [])

    def test_a_visible_task_links(self):
        open_task = models.Task(id=gen_id(), code="TASK-8", title="Open")
        self.db.add(open_task)
        self.db.commit()
        t = self.file()
        r = self.as_(REQ).patch(f"/task-tickets/{t['id']}", json={"task_ids": [open_task.id]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["taskIds"], [open_task.id])


class CompanyWallTests(_Base):
    def setUp(self):
        super().setUp()
        for did, co, lead in (("d1", "co1", "head1@greensglobal.com"), ("d2", "co2", "head2@greensglobal.com")):
            self.db.add(models.HrDepartment(id=did, company_id=co, name=f"IT {co}", lead_email=lead))
        self.db.commit()
        self.walls_on()

    def test_department_settings_stay_inside_the_company(self):
        c = self.as_(ADMIN2)
        self.assertEqual(c.patch("/ticket-departments/d1", json={"enabled": False}).status_code, 404)
        self.assertEqual(c.put("/ticket-departments/order", json={"company_id": "co1", "ids": ["d1"]}).status_code, 404)
        self.assertEqual(c.patch("/ticket-departments/d2", json={"enabled": False}).status_code, 200)

    def test_another_companys_department_heads_are_not_listed(self):
        rows = {d["id"]: d for d in self.as_(ADMIN2).get("/ticket-departments").json()}
        self.assertEqual(rows["d1"]["leadEmail"], "")
        self.assertEqual(rows["d2"]["leadEmail"], "head2@greensglobal.com")
        self.assertEqual(self.as_(GA).get("/ticket-departments").json()[0]["leadEmail"] != "", True)

    def test_delivery_logs_are_confined_to_the_company(self):
        t1 = self.ticket_row(company_id="co1", code="000001")
        t2 = self.ticket_row(company_id="co2", code="000002")
        for t in (t1, t2):
            self.db.add(models.TicketEmailLog(id=gen_id(), ticket_id=t.id, ticket_code=t.code, event_type="created",
                                              event_version=1, idempotency_key=f"{t.id}:x", recipient=REQ,
                                              status="sent", created_at=now_iso()))
            self.db.add(models.TicketTeamsMessage(id=gen_id(), ticket_id=t.id, agent_email=AGENT,
                                                  requester_email=REQ, created_at=now_iso()))
        self.db.commit()
        c = self.as_(ADMIN2)
        log = c.get("/task-tickets/notify/log").json()
        self.assertEqual([r["ticketId"] for r in log["rows"]], [t2.id])
        self.assertEqual(log["total"], 1)
        self.assertEqual([r["ticketId"] for r in c.get("/task-tickets/notify/teams-log").json()], [t2.id])
        self.assertEqual(len(self.as_(GA).get("/task-tickets/notify/log").json()["rows"]), 2)


class EscalateTests(_Base):
    def test_cooldown_and_company_scoped_admins(self):
        self.walls_on()
        t = self.file(who=AGENT, assignee_email=AGENT, status="in_progress")
        c = self.as_(AGENT)
        self.assertEqual(c.post(f"/task-tickets/{t['id']}/escalate").status_code, 200)
        again = c.post(f"/task-tickets/{t['id']}/escalate")
        self.assertEqual(again.status_code, 429)
        self.assertIn("30 minutes", again.json()["detail"])
        told = {n.for_email for n in self.db.query(models.TaskNotification)
                .filter(models.TaskNotification.title == "A Ticket Was Escalated").all()}
        self.assertEqual(told, {GA, ADMIN1})      # ADMIN2 runs another company
        self.assertNotIn("admins", told)

    def test_the_cooldown_ends(self):
        t = self.file(who=AGENT, assignee_email=AGENT, status="in_progress")
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="ticket", entity_id=t["id"], type="escalated",
                                        actor_email=AGENT,
                                        at=(datetime.now(timezone.utc) - timedelta(minutes=31)).isoformat()))
        self.db.commit()
        self.assertEqual(self.as_(AGENT).post(f"/task-tickets/{t['id']}/escalate").status_code, 200)


class SlaSettingsTests(_Base):
    def test_sla_hours_must_be_positive_numbers(self):
        c = self.as_(ADMIN1)
        for bad in ({"high": -1}, {"high": 0}, {"high": "soon"}, {"high": True}, {"high": 10 ** 9}):
            r = c.put("/task-tickets/taxonomy/settings", json={"slaTargetHours": bad})
            self.assertEqual(r.status_code, 422, bad)
        r = c.put("/task-tickets/taxonomy/settings", json={"slaTargetHours": {"high": 12}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["slaTargetHours"]["high"], 12)
        self.file(priority="high")                # and a create still works

    def test_a_bad_value_already_stored_does_not_500_a_create(self):
        import json
        self.db.add(models.NexusSetting(key="ticket_taxonomy_config", value=json.dumps({"slaTargetHours": {"medium": "x"}})))
        self.db.commit()
        self.assertTrue(self.file()["slaDueOn"])


class EmailTests(_Base):
    def _ticket(self):
        t = self.ticket_row(code="000042", status="in_progress", assignee_email=AGENT)
        return t

    def test_a_retry_resends_the_first_render_with_the_real_actor(self):
        t = self._ticket()
        with patch("graph_mail.send_mail", side_effect=graph_mail.GraphMailError("Graph down")):
            ticket_notify.notify_ticket_event(t.id, "escalated", ADMIN1)
        self.db.expire_all()
        rows = self.db.query(models.TicketEmailLog).filter(models.TicketEmailLog.ticket_id == t.id).all()
        self.assertTrue(rows)
        first = {r.recipient: r.html for r in rows}
        self.assertTrue(all(r.status == "failed" and r.html and r.actor_email == ADMIN1 for r in rows))
        sent = []
        with patch("graph_mail.send_mail", side_effect=lambda **kw: sent.append(kw) or {}):
            ticket_notify._retry_failed_once(self.db)
        self.assertEqual({kw["to"][0]: kw["html"] for kw in sent}, first)
        self.assertTrue(all("Admin1" in kw["html"] for kw in sent))   # escalated BY the admin

    def test_a_legacy_row_rebuilds_with_the_actor_not_the_recipient(self):
        t = self._ticket()
        self.db.add(models.TicketEmailLog(id=gen_id(), ticket_id=t.id, ticket_code=t.code, event_type="escalated",
                                          event_version=1, idempotency_key=f"{t.id}:escalated:1:{REQ}",
                                          recipient=REQ, recipient_role="it_admin", subject="URGENT", status="failed",
                                          attempts=1, actor_email=ADMIN1, html="", created_at=now_iso(),
                                          updated_at=now_iso()))
        self.db.add(models.TicketEmailLog(id=gen_id(), ticket_id=t.id, ticket_code=t.code,
                                          event_type="approval_required", event_version=1,
                                          idempotency_key=f"{t.id}:approval_required:1:{APPROVER}",
                                          recipient=APPROVER, recipient_role="approver", subject="Approve",
                                          status="failed", attempts=1, actor_email=ADMIN1, html="",
                                          created_at=now_iso(), updated_at=now_iso()))
        self.db.commit()
        sent = []
        with patch("graph_mail.send_mail", side_effect=lambda **kw: sent.append(kw) or {}):
            ticket_notify._retry_failed_once(self.db)
        by_to = {kw["to"][0]: kw["html"] for kw in sent}
        self.assertIn("Admin1", by_to[REQ])
        self.assertIn("This Ticket Has Been Escalated", by_to[REQ])
        self.assertIn("This Ticket Is Waiting for Your Approval", by_to[APPROVER])

    def test_a_row_stuck_retrying_after_a_crash_is_picked_up(self):
        t = self._ticket()
        stale = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        self.db.add(models.TicketEmailLog(id=gen_id(), ticket_id=t.id, ticket_code=t.code, event_type="created",
                                          event_version=1, idempotency_key=f"{t.id}:created:1:{REQ}",
                                          recipient=REQ, recipient_role="requester", subject="S", status="retrying",
                                          attempts=2, html="<p>hello</p>", created_at=stale, updated_at=stale))
        self.db.commit()
        sent = []
        with patch("graph_mail.send_mail", side_effect=lambda **kw: sent.append(kw) or {}):
            ticket_notify._retry_failed_once(self.db)
        self.assertEqual([kw["html"] for kw in sent], ["<p>hello</p>"])

    def test_two_quick_events_do_not_share_a_version(self):
        t = self._ticket()
        # Another worker already took version 1 for this recipient.
        self.db.add(models.TicketEmailLog(id=gen_id(), ticket_id=t.id, ticket_code=t.code, event_type="updated",
                                          event_version=1, idempotency_key=f"{t.id}:updated:1:{REQ}",
                                          recipient=REQ, status="sent", created_at=now_iso()))
        self.db.commit()
        real = ticket_notify._next_event_version
        calls = []

        def stale_first(db, ticket_id, event_type):
            calls.append(1)
            return 1 if len(calls) == 1 else real(db, ticket_id, event_type)
        sent = []
        with patch.object(ticket_notify, "_next_event_version", side_effect=stale_first), \
                patch("graph_mail.send_mail", side_effect=lambda **kw: sent.append(kw) or {}):
            ticket_notify.notify_ticket_event(t.id, "updated", AGENT, update_kind="New comment added",
                                              latest_comment="<p>On my way</p>")
        self.assertEqual([kw["to"][0] for kw in sent], [REQ])
        versions = sorted(r.event_version for r in self.db.query(models.TicketEmailLog)
                          .filter(models.TicketEmailLog.event_type == "updated").all())
        self.assertEqual(versions, [1, 2])

    def test_times_read_in_the_readers_zone(self):
        self.assertEqual(ticket_notify._fmt("2026-10-18T19:30:00+00:00", "America/Los_Angeles"),
                         "10/18/2026 12:30 PM PDT")
        self.assertEqual(ticket_notify._fmt("2026-10-18T19:30:00+00:00", "Asia/Kolkata"), "10/19/2026 1:00 AM IST")
        self.assertEqual(ticket_notify._fmt("2026-10-18"), "10/18/2026")
        self.assertEqual(ticket_notify._fmt("not a date"), "")
        self.assertNotIn("UTC", ticket_notify._fmt("2026-10-18T19:30:00Z"))


class FollowUpReviewTests(_Base):
    """The second review pass on PR #643."""

    def _log(self, t, **kw):
        row = models.TicketEmailLog(id=gen_id(), ticket_id=t.id, ticket_code=t.code, event_type="created",
                                    event_version=1, idempotency_key=f"{t.id}:created:1:{gen_id()}",
                                    recipient=REQ, recipient_role="requester", subject="S",
                                    created_at=now_iso(), **kw)
        self.db.add(row)
        self.db.commit()
        return row

    # ── 1. one row, one send ────────────────────────────────────────────────
    def test_a_row_is_claimed_by_exactly_one_worker(self):
        t = self.ticket_row(code="000050")
        row = self._log(t, status="pending", attempts=0, html="<p>x</p>", updated_at=now_iso())
        other = database.SessionLocal()
        self.addCleanup(other.close)
        twin = other.get(models.TicketEmailLog, row.id)
        self.assertTrue(ticket_notify._claim_send(self.db, row, "pending"))
        self.assertFalse(ticket_notify._claim_send(other, twin, "pending"))   # the second worker loses
        self.assertEqual((row.status, row.attempts), ("sending", 1))

    def test_a_slow_batch_is_not_double_sent_by_the_sweep(self):
        """The request's background task claims each row as it reaches it; a
        row whose claim is fresh is left alone by the sweep, and a row the
        sweep took is skipped by the task."""
        t = self.ticket_row(code="000051")
        fresh = self._log(t, status="sending", attempts=1, html="<p>a</p>", updated_at=now_iso())
        old = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        waiting = self._log(t, status="pending", attempts=0, html="<p>b</p>", updated_at=old)
        sent = []
        with patch("graph_mail.send_mail", side_effect=lambda **kw: sent.append(kw["html"]) or {}):
            ticket_notify._retry_failed_once(self.db)            # sweep: takes only the stale one
            ticket_notify._deliver_row(self.db, waiting, t, ticket_notify.get_settings(self.db))  # task arrives late
        self.assertEqual(sent, ["<p>b</p>"])
        self.db.expire_all()
        self.assertEqual(self.db.get(models.TicketEmailLog, fresh.id).status, "sending")

    # ── 6. bodies are not kept forever ──────────────────────────────────────
    def test_the_body_is_cleared_when_attempts_run_out(self):
        t = self.ticket_row(code="000052")
        last = self._log(t, status="failed", attempts=ticket_notify.MAX_ATTEMPTS - 1, html="<p>c</p>",
                         updated_at=now_iso())
        old = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()
        stuck = self._log(t, status="retrying", attempts=ticket_notify.MAX_ATTEMPTS, html="<p>d</p>", updated_at=old)
        with patch("graph_mail.send_mail", side_effect=graph_mail.GraphMailError("down")):
            ticket_notify._retry_failed_once(self.db)
        self.db.expire_all()
        for rid in (last.id, stuck.id):
            r = self.db.get(models.TicketEmailLog, rid)
            self.assertEqual((r.status, r.html), ("failed", ""), rid)

    # ── 3. the approver finds it in Support ─────────────────────────────────
    def test_a_pending_approver_finds_it_in_support_and_is_sent_there(self):
        t = self.file(type="access_request")
        sent = []
        with patch("graph_mail.send_mail", side_effect=lambda **kw: sent.append(kw) or {}):
            r = self.as_(ADMIN1).post(f"/task-tickets/{t['id']}/request-approval", json={"approver_email": APPROVER})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn(t["id"], [x["id"] for x in self.as_(APPROVER).get("/task-tickets?mine=true").json()])
        import json
        bell = next(n for n in self.db.query(models.NexusNotification).all()
                    if n.recipient == APPROVER and n.type == "task_ticket_needs_approval")
        self.assertEqual(json.loads(bell.action)["view"], "support")
        mail = next(kw for kw in sent if kw["to"] == [APPROVER])
        self.assertIn(f"/support?ticket={t['id']}", mail["html"])

    def test_a_desk_approver_keeps_the_tickets_link(self):
        t = self.file(type="access_request")
        self.db.add(models.NexusEmployee(id=gen_id(), work_email="deskappr@greensglobal.com", first_name="D",
                                         company="co1", status="active", identity_type="internal"))
        self.db.add(models.NexusGroupMember(group_id="desk", email="deskappr@greensglobal.com"))
        self.db.commit()
        self.as_(ADMIN1).post(f"/task-tickets/{t['id']}/request-approval",
                              json={"approver_email": "deskappr@greensglobal.com"})
        import json
        bell = next(n for n in self.db.query(models.NexusNotification).all()
                    if n.recipient == "deskappr@greensglobal.com" and n.type == "task_ticket_needs_approval")
        self.assertEqual(json.loads(bell.action)["view"], "tickets")

    # ── 2. unlink ───────────────────────────────────────────────────────────
    def test_unlink_through_the_route(self):
        a = self.file(who=AGENT)
        b = self.file(who=AGENT, subject="Second")
        c = self.as_(AGENT)
        self.assertEqual(c.post(f"/task-tickets/{a['id']}/links", json={"ticket_id": b["id"]}).status_code, 201)
        r = c.delete(f"/task-tickets/{b['id']}/links/{a['id']}")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((self.row(a["id"]).links, self.row(b["id"]).links), ([], []))

    # ── 4. a clashed id's thread is never read as the ticket's ──────────────
    def test_comment_readers_skip_a_ticket_sharing_a_tasks_id(self):
        task = models.Task(id=gen_id(), code="TASK-1", title="Payroll")
        self.db.add(task)
        self.db.add(models.TaskComment(id=gen_id(), task_id=task.id, author_email=ADMIN1, body="<p>salaries</p>",
                                       created_at=now_iso(), internal=False))
        self.db.commit()
        self.ticket_row(id=task.id, code="000053")
        self.assertEqual(ticket_notify._comment_thread(self.db, task.id), [])
        self.assertNotIn(task.id, T._latest_comments(self.db, internal_ok=True))
        self.assertNotIn(task.id, T._latest_comments(self.db, internal_ok=True, ticket_ids=[task.id]))
        from routers import property_tickets as P
        self.assertEqual(P._latest_public(self.db, [task.id]), {})

    # ── 5. one bad old SLA value cannot block every save ────────────────────
    def test_a_bad_stored_sla_value_does_not_block_saves(self):
        import json
        self.db.add(models.NexusSetting(key="ticket_taxonomy_config",
                                        value=json.dumps({"slaTargetHours": {"medium": "x", "vip": 3}})))
        self.db.commit()
        c = self.as_(ADMIN1)
        # Another section saved: fine, and the bad value is gone.
        r = c.put("/task-tickets/taxonomy/settings", json={"companyField": {"enabled": False}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["slaTargetHours"]["medium"], 72)
        self.assertNotIn("vip", r.json()["slaTargetHours"])

    def test_the_bad_value_sent_back_unchanged_is_dropped_but_a_new_bad_one_is_422(self):
        import json
        self.db.add(models.NexusSetting(key="ticket_taxonomy_config",
                                        value=json.dumps({"slaTargetHours": {"medium": "x"}})))
        self.db.commit()
        c = self.as_(ADMIN1)
        r = c.put("/task-tickets/taxonomy/settings",
                  json={"slaTargetHours": {"urgent": 4, "high": 48, "medium": "x", "low": 168}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["slaTargetHours"]["urgent"], r.json()["slaTargetHours"]["medium"]), (4, 72))
        self.assertEqual(c.put("/task-tickets/taxonomy/settings",
                               json={"slaTargetHours": {"high": "soon"}}).status_code, 422)


class TitleCaseTests(_Base):
    def test_triage_bell_and_button(self):
        self.file()
        bells = self.db.query(models.TaskNotification).filter(models.TaskNotification.for_email == ADMIN1).all()
        self.assertIn("New Ticket to Assign", [n.title for n in bells])
        import json
        actions = [json.loads(n.action) for n in self.db.query(models.NexusNotification).all() if n.action]
        self.assertTrue(actions)
        self.assertTrue(all(a.get("label") != "View ticket" for a in actions))


if __name__ == "__main__":
    unittest.main()
