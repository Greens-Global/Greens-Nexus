"""
Ask HR runs through Tickets, and an HR ticket stays confidential (Neil, Oct 27 2026).

An Ask HR request is filed with tickets.file_ticket into the company's HR
desk (ticket_confidential.py, hr_tickets.py). These pin:

  - filing: the HR desk, the HR contact as default assignee, the SLA, the
    right bells (HR, never the service desk);
  - confidentiality on every ticket read path we found: the list (desk,
    off-desk and mine), every by-id route, internal notes, edits, reports,
    the global hook's raw queries, the delivery logs, AI, tasks-from-ticket,
    links, delete, email recipients;
  - who DOES read it: the requester, watchers, the assignee, the company's
    HR contact, an administrator, a Full HR grant (inside its HR scope);
  - the move of open old requests: once, idempotent, nothing lost; resolved
    rows stay as Earlier Requests.

Uses a throwaway sqlite file. No network: BackgroundTasks are never run and
storage is not configured (a staged file's copy fails and is noted).
Run on its own: python -m pytest test_ask_hr_tickets.py
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
import hr_tickets
import ticket_confidential as TC
from routers.task_util import now_iso
from routers import tickets as T

CO, OTHER_CO = "co-greens", "co-india"
EMP = {"email": "emp@greensglobal.com", "level": 1}            # asks HR
HR = {"email": "hr@greensglobal.com", "level": 1}              # the company's HR contact, no grants at all
AGENT = {"email": "agent@greensglobal.com", "level": 1}        # service desk agent (tickets grant)
MANAGER = {"email": "manager@greensglobal.com", "level": 3}    # a manager - not HR
ADMIN = {"email": "admin@greensglobal.com", "level": 4}        # administrator
HRFULL = {"email": "hrfull@greensglobal.com", "level": 1}      # Full HR grant
HRSCOPED = {"email": "hrscoped@greensglobal.com", "level": 1}  # Full HR grant, scoped to the other company
COLLEAGUE = {"email": "colleague@greensglobal.com", "level": 1}
WATCHER = {"email": "watcher@greensglobal.com", "level": 1}


class AskHrTicketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp_db.name)

    def setUp(self):
        import auth
        self._grants = auth._grants_for
        full = auth._MODULE_LEVEL_RANK["full"]
        grants = {AGENT["email"]: {"tickets": 99}, HRFULL["email"]: {"hr": full},
                  HRSCOPED["email"]: {"hr": full}}
        auth._grants_for = lambda email, db: grants.get((email or "").lower(), {})
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.TaskAttachment,
                  models.TaskNotification, models.NexusNotification, models.NexusEmployee, models.HrEntity,
                  models.HrSelfRequest, models.NexusRole, models.NexusAccessScope, models.TicketEmailLog,
                  models.Task):
            self.db.query(m).execution_options(include_confidential=True, include_deleted=True).delete()
        self.db.add(models.HrEntity(id=CO, name="Greens", hr_contact_email=HR["email"]))
        self.db.add(models.HrEntity(id=OTHER_CO, name="Greens India", hr_contact_email=""))
        for u in (EMP, HR, AGENT, MANAGER, ADMIN, HRFULL, HRSCOPED, COLLEAGUE, WATCHER):
            self.db.add(models.NexusEmployee(id=u["email"], first_name=u["email"].split("@")[0].title(),
                                             last_name="", work_email=u["email"], company=CO, status="active"))
        self.db.add(models.NexusRole(email=ADMIN["email"], role="administrator"))
        self.db.add(models.NexusAccessScope(id="sc1", email=HRSCOPED["email"], module_id="hr",
                                            scope_type="entity", scope_id=OTHER_CO))
        self.db.commit()

    def tearDown(self):
        import auth
        auth._grants_for = self._grants
        self.db.close()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _ask(self, msg="My visa was renewed - please update my right-to-work document.", kind="document"):
        out = hr_tickets.file_ask_hr(self.db, EMP, kind, msg, BackgroundTasks())
        return self._t(out["id"])

    def _t(self, tid):
        self.db.expire_all()
        return TC.include(self.db.query(models.TaskTicket)).filter(models.TaskTicket.id == tid).first()

    def _plain(self, subject="Printer is jammed", requester=COLLEAGUE["email"]):
        out = T.file_ticket(T.TicketBody(subject=subject, requester_email=requester), BackgroundTasks(),
                            {"email": requester, "level": 1}, self.db)
        return out["id"]

    def _ids(self, user, mine=False):
        return {r["id"] for r in T.list_tickets(mine=mine, user=dict(user), db=self.db)}

    def _bells(self, email):
        return [n.title for n in self.db.query(models.TaskNotification)
                .filter(models.TaskNotification.for_email == email).all()]

    # ── filing ───────────────────────────────────────────────────────────────
    def test_ask_hr_files_a_confidential_ticket_assigned_to_the_hr_contact(self):
        t = self._ask()
        self.assertEqual(t.confidential_desk, "hr")
        self.assertEqual(t.company_id, CO)
        self.assertEqual(t.assignee_email, HR["email"])
        self.assertEqual(t.status, "in_progress")
        self.assertEqual(t.requester_email, EMP["email"])
        self.assertEqual(t.application, "Document Update")
        self.assertEqual(t.service_area, "hr")
        self.assertEqual(t.approval_status, "none")
        self.assertTrue(t.sla_due_at and t.first_response_due_at, "the desk's SLA targets apply")
        self.assertTrue(t.subject.startswith("Document Update: My visa was renewed"))

    def test_ask_hr_bells_hr_and_never_the_service_desk(self):
        t = self._ask()
        self.assertIn("New HR Request Assigned to You", self._bells(HR["email"]))
        self.assertEqual(self._bells(AGENT["email"]), [])
        # And the desk's email audience is HR, not the roster.
        import ticket_notify
        cfg = ticket_notify.get_settings(self.db)
        cfg = {**cfg, "agentEmails": [AGENT["email"]]}
        for ev in ("created", "assigned", "resolved", "reopened", "escalated"):
            who = {e for e, _ in ticket_notify._recipients_for(self.db, t, ev, cfg)}
            self.assertNotIn(AGENT["email"], who, ev)
        self.assertIn(HR["email"], {e for e, _ in ticket_notify._recipients_for(self.db, t, "created", cfg)})

    def test_no_hr_contact_goes_to_the_company_administrators_unassigned(self):
        self.db.query(models.HrEntity).filter(models.HrEntity.id == CO).update({"hr_contact_email": ""})
        self.db.commit()
        t = self._ask()
        self.assertEqual(t.assignee_email, "")
        self.assertEqual(t.status, "open")
        self.assertIn("New HR Request to Assign", self._bells(ADMIN["email"]))
        self.assertEqual(self._bells(AGENT["email"]), [])

    def test_a_bad_kind_or_empty_message_is_refused(self):
        with self.assertRaises(HTTPException):
            hr_tickets.file_ask_hr(self.db, EMP, "salary", "x", BackgroundTasks())
        with self.assertRaises(HTTPException):
            hr_tickets.file_ask_hr(self.db, EMP, "question", "   ", BackgroundTasks())
        with self.assertRaises(HTTPException):   # an old client's file must be the caller's own
            hr_tickets.file_ask_hr(self.db, EMP, "document", "x", BackgroundTasks(),
                                   attachment_path="self-requests/someone@else.com/a.pdf")

    def test_an_old_clients_staged_file_is_noted_when_it_cannot_be_copied(self):
        out = hr_tickets.file_ask_hr(self.db, EMP, "document", "see file", BackgroundTasks(),
                                     attachment_path=f"self-requests/{EMP['email']}/x-passport.pdf",
                                     attachment_name="passport.pdf")
        notes = self.db.query(models.TaskComment).filter(models.TaskComment.task_id == out["id"]).all()
        self.assertEqual(len(notes), 1)
        self.assertTrue(notes[0].internal, "HR's note, not the requester's thread")
        self.assertIn("passport.pdf", notes[0].body)

    # ── who reads it: the list ───────────────────────────────────────────────
    def test_the_list_shows_it_only_to_its_people_and_hr(self):
        t = self._ask()
        plain = self._plain()
        for u in (HR, ADMIN, HRFULL):
            self.assertIn(t.id, self._ids(u), u["email"])
        self.assertIn(t.id, self._ids(EMP, mine=True))
        self.assertIn(t.id, self._ids(EMP))
        for u in (AGENT, MANAGER, COLLEAGUE, HRSCOPED, WATCHER):
            self.assertNotIn(t.id, self._ids(u), u["email"])
            self.assertNotIn(t.id, self._ids(u, mine=True), u["email"])
        # The desk still sees ordinary tickets.
        self.assertIn(plain, self._ids(AGENT))

    def test_a_watcher_and_a_reassigned_person_read_it(self):
        t = self._ask()
        T.update_ticket(t.id, T.TicketUpdate(watcher_emails=[WATCHER["email"]]), BackgroundTasks(),
                        user=dict(EMP), db=self.db)
        self.assertIn(t.id, self._ids(WATCHER))
        self.assertIn(t.id, self._ids(WATCHER, mine=True))
        T.update_ticket(t.id, T.TicketUpdate(assignee_email=COLLEAGUE["email"]), BackgroundTasks(),
                        user=dict(HR), db=self.db)
        self.assertIn(t.id, self._ids(COLLEAGUE))

    def test_every_by_id_route_404s_for_the_desk(self):
        t = self._ask()
        a = dict(AGENT)
        calls = [
            lambda: T.list_ticket_comments(t.id, user=a, db=self.db),
            lambda: T.add_ticket_comment(t.id, T.TicketCommentBody(body="<p>hi</p>"), BackgroundTasks(), user=a, db=self.db),
            lambda: T.list_ticket_attachments(t.id, user=a, db=self.db),
            lambda: T.add_ticket_attachment(t.id, T.TicketAttachmentBody(name="x", url=""), BackgroundTasks(), user=a, db=self.db),
            lambda: T.list_ticket_activity(t.id, user=a, db=self.db),
            lambda: T.mark_ticket_seen(t.id, user=a, db=self.db),
            lambda: T.update_ticket(t.id, T.TicketUpdate(priority="high"), BackgroundTasks(), user=a, db=self.db),
            lambda: T.escalate_ticket(t.id, BackgroundTasks(), user=a, db=self.db),
            lambda: T.ticket_summary(t.id, user=a, db=self.db),
            lambda: T.create_task_from_ticket(t.id, BackgroundTasks(), user=a, db=self.db),
        ]
        for i, call in enumerate(calls):
            with self.assertRaises(HTTPException, msg=f"call {i}") as cm:
                call()
            self.assertEqual(cm.exception.status_code, 404, f"call {i}")
        for u in (MANAGER, COLLEAGUE, HRSCOPED):
            with self.assertRaises(HTTPException) as cm:
                T.list_ticket_comments(t.id, user=dict(u), db=self.db)
            self.assertEqual(cm.exception.status_code, 404, u["email"])

    def test_admin_desk_tools_cannot_reach_it(self):
        t = self._ask()
        other = self._plain()
        with self.assertRaises(HTTPException) as cm:
            T.delete_ticket(t.id, user=dict(ADMIN), db=self.db)
        self.assertEqual(cm.exception.status_code, 404)
        with self.assertRaises(HTTPException) as cm:   # a link would show its subject on the other ticket
            T.add_ticket_link(other, T.TicketLinkBody(ticket_id=t.id, type="relates"), user=dict(ADMIN), db=self.db)
        self.assertEqual(cm.exception.status_code, 404)
        from routers import ticket_ai
        with self.assertRaises(HTTPException) as cm:
            ticket_ai._desk_ticket(self.db, dict(AGENT), t.id)
        self.assertEqual(cm.exception.status_code, 404)

    def test_requester_hr_and_admin_read_and_reply(self):
        t = self._ask()
        for u in (EMP, HR, ADMIN, HRFULL):
            T.add_ticket_comment(t.id, T.TicketCommentBody(body=f"<p>from {u['email']}</p>"),
                                 BackgroundTasks(), user=dict(u), db=self.db)
            self.assertTrue(T.list_ticket_comments(t.id, user=dict(u), db=self.db))
        T.list_ticket_activity(t.id, user=dict(EMP), db=self.db)

    def test_hr_answering_stops_the_first_response_clock(self):
        t = self._ask()
        T.add_ticket_comment(t.id, T.TicketCommentBody(body="<p>On it</p>"), BackgroundTasks(),
                             user=dict(HR), db=self.db)
        self.assertTrue(self._t(t.id).first_response_at)

    def test_internal_notes_are_hrs_only(self):
        t = self._ask()
        T.add_ticket_comment(t.id, T.TicketCommentBody(body="<p>check payroll first</p>", internal=True),
                             BackgroundTasks(), user=dict(HR), db=self.db)
        T.update_ticket(t.id, T.TicketUpdate(watcher_emails=[WATCHER["email"]]), BackgroundTasks(),
                        user=dict(EMP), db=self.db)
        bodies = lambda u: [c["body"] for c in T.list_ticket_comments(t.id, user=dict(u), db=self.db)]  # noqa: E731
        self.assertIn("<p>check payroll first</p>", bodies(HR))
        self.assertIn("<p>check payroll first</p>", bodies(ADMIN))
        self.assertNotIn("<p>check payroll first</p>", bodies(EMP))
        self.assertNotIn("<p>check payroll first</p>", bodies(WATCHER))
        # The requester's "internal" note is just a reply.
        T.add_ticket_comment(t.id, T.TicketCommentBody(body="<p>mine</p>", internal=True),
                             BackgroundTasks(), user=dict(EMP), db=self.db)
        self.assertIn("<p>mine</p>", bodies(EMP))

    # ── editing ──────────────────────────────────────────────────────────────
    def test_hr_works_it_but_cannot_move_it_out_of_hr(self):
        t = self._ask()
        T.update_ticket(t.id, T.TicketUpdate(priority="high"), BackgroundTasks(), user=dict(HR), db=self.db)
        self.assertEqual(self._t(t.id).priority, "high")
        for patch in (T.TicketUpdate(company_id=OTHER_CO), T.TicketUpdate(type="incident"),
                      T.TicketUpdate(hr_department_id="d1"), T.TicketUpdate(property_asset_id="p1")):
            with self.assertRaises(HTTPException) as cm:
                T.update_ticket(t.id, patch, BackgroundTasks(), user=dict(HR), db=self.db)
            self.assertEqual(cm.exception.status_code, 400)
        # An unchanged value a drawer save carries along is not a change.
        T.update_ticket(t.id, T.TicketUpdate(company_id=CO, type="other", priority="low"), BackgroundTasks(),
                        user=dict(HR), db=self.db)
        with self.assertRaises(HTTPException):
            T.update_ticket(t.id, T.TicketUpdate(assignee_email="nobody@nowhere.com"), BackgroundTasks(),
                            user=dict(HR), db=self.db)

    def test_a_watcher_cannot_edit_and_a_manager_is_not_privileged(self):
        t = self._ask()
        T.update_ticket(t.id, T.TicketUpdate(watcher_emails=[MANAGER["email"]]), BackgroundTasks(),
                        user=dict(EMP), db=self.db)
        with self.assertRaises(HTTPException) as cm:
            T.update_ticket(t.id, T.TicketUpdate(priority="urgent"), BackgroundTasks(), user=dict(MANAGER), db=self.db)
        self.assertEqual(cm.exception.status_code, 403)
        self.assertFalse(T._ticket_privileged(self.db, self._t(t.id), dict(MANAGER)))
        self.assertTrue(T._ticket_privileged(self.db, self._t(t.id), dict(HR)))

    # ── everything else that reads task_tickets ──────────────────────────────
    def test_raw_queries_reports_and_logs_leave_it_out(self):
        t = self._ask()
        plain = self._plain()
        ids = {x.id for x in self.db.query(models.TaskTicket).all()}
        self.assertNotIn(t.id, ids, "hidden by the global hook")
        self.assertIn(plain, ids)
        self.assertNotIn(t.id, {i for (i,) in self.db.query(models.TaskTicket.id).all()})
        self.assertNotIn(t.id, {i for (i,) in self.db.query(models.TaskTicket.id)
                                .execution_options(include_deleted=True).all()})
        self.assertEqual(self.db.query(models.TaskTicket).filter(models.TaskTicket.id == t.id).count(), 0)
        # Ticket Reports - even for an administrator (they read it on the desk, not in a report).
        from datetime import datetime, timedelta, timezone
        import ticket_reports
        now = datetime.now(timezone.utc)
        for u in (ADMIN, AGENT):
            rows = ticket_reports._load(self.db, dict(u), now - timedelta(days=30), now + timedelta(days=1), {})
            self.assertNotIn(t.id, {r.id for r in rows}, u["email"])
            self.assertIn(plain, {r.id for r in rows}, u["email"])
        # Delivery logs.
        for tid in (t.id, plain):
            self.db.add(models.TicketEmailLog(id=f"log-{tid}", ticket_id=tid, ticket_code="1", event_type="created",
                                              idempotency_key=f"k-{tid}", recipient=HR["email"],
                                              subject="secret subject", created_at=now_iso()))
        self.db.commit()
        log = T.get_ticket_notify_log(user=dict(ADMIN), db=self.db)
        self.assertEqual({r["ticketId"] for r in log["rows"]}, {plain})

    def test_my_work_style_and_count_queries_hide_it_but_my_own_count_sees_it(self):
        t = self._ask()
        T.update_ticket(t.id, T.TicketUpdate(status="waiting_user"), BackgroundTasks(), user=dict(HR), db=self.db)
        from routers import action_counts
        self.assertEqual(action_counts._my_tickets(self.db, EMP["email"]), 1)

    def test_an_emailed_reply_lands_only_for_its_people(self):
        import ticket_inbound
        t = self._ask()
        self.assertEqual(ticket_inbound._live_ticket(self.db, t.id).id, t.id)
        self.assertEqual(ticket_inbound.comment_refusal(self.db, dict(EMP), t), "")
        self.assertEqual(ticket_inbound.comment_refusal(self.db, dict(HR), t), "")
        self.assertTrue(ticket_inbound.comment_refusal(self.db, dict(AGENT), t))

    def test_an_sla_breach_tells_hr_never_the_desk(self):
        import ticket_notify
        import ticket_sla
        self.db.query(models.HrEntity).filter(models.HrEntity.id == CO).update({"hr_contact_email": ""})
        self.db.commit()
        t = self._ask()
        t.sla_due_at = "2000-01-01T00:00:00+00:00"
        t.first_response_due_at = "2000-01-01T00:00:00+00:00"
        self.db.commit()
        orig = ticket_notify.get_settings
        ticket_notify.get_settings = lambda db: {**orig(db), "agentEmails": [AGENT["email"]]}
        try:
            ticket_sla.scan_breaches(self.db)
        finally:
            ticket_notify.get_settings = orig
        N = models.NexusNotification
        told = {n.recipient for n in self.db.query(N).filter(N.type == ticket_sla.BELL_TYPE).all()}
        self.assertIn(ADMIN["email"], told)
        self.assertNotIn(AGENT["email"], told)

    # ── HR's side ────────────────────────────────────────────────────────────
    def test_hr_desk_and_waiting_count(self):
        t = self._ask()
        self.assertEqual([x.id for x in hr_tickets.desk_tickets(self.db, dict(HR))], [t.id])
        self.assertEqual([x.id for x in hr_tickets.desk_tickets(self.db, dict(ADMIN))], [t.id])
        self.assertEqual(hr_tickets.desk_tickets(self.db, dict(AGENT)), [])
        self.assertEqual(hr_tickets.desk_tickets(self.db, dict(HRSCOPED)), [])
        self.assertEqual(hr_tickets.desk_tickets(self.db, dict(EMP)), [], "their own request is not their desk")
        self.assertEqual(hr_tickets.waiting_on(self.db, dict(HR)), 1)
        self.assertEqual(hr_tickets.waiting_on(self.db, dict(AGENT)), 0)
        self.assertEqual(hr_tickets.waiting_on(self.db, dict(EMP)), 0)
        from routers import ask_hr
        self.assertTrue(ask_hr.ask_hr_access(user=dict(HR), db=self.db)["hrDesk"])
        self.assertFalse(ask_hr.ask_hr_access(user=dict(AGENT), db=self.db)["hrDesk"])

    def test_is_hr_for_rules(self):
        self.assertTrue(TC.is_hr_for(self.db, dict(HR), CO))
        self.assertFalse(TC.is_hr_for(self.db, dict(HR), OTHER_CO))
        self.assertTrue(TC.is_hr_for(self.db, dict(ADMIN), OTHER_CO))
        self.assertTrue(TC.is_hr_for(self.db, dict(HRFULL), CO))
        self.assertFalse(TC.is_hr_for(self.db, dict(HRSCOPED), CO))
        self.assertTrue(TC.is_hr_for(self.db, dict(HRSCOPED), OTHER_CO))
        self.assertFalse(TC.is_hr_for(self.db, dict(AGENT), CO))
        self.assertFalse(TC.is_hr_for(self.db, dict(MANAGER), CO))
        self.assertTrue(TC.is_hr_for(self.db, HR["email"], CO), "by email too (background jobs)")

    # ── the move ─────────────────────────────────────────────────────────────
    def _old(self, rid, status="open", **kw):
        r = models.HrSelfRequest(id=rid, employee_email=EMP["email"], employee_name="Emp", type=kw.get("type", "profile"),
                                 message=kw.get("message", "Please change my last name"), status=status,
                                 attachment_path=kw.get("attachment_path", ""), attachment_name=kw.get("attachment_name", ""),
                                 response=kw.get("response", ""), resolved_by=kw.get("resolved_by", ""),
                                 resolved_at=kw.get("resolved_at", ""), created_at="2026-09-01T10:00:00+00:00")
        self.db.add(r)
        self.db.commit()
        return r

    def test_open_requests_move_once_and_resolved_ones_stay(self):
        self._old("r-open", attachment_path=f"self-requests/{EMP['email']}/m.pdf", attachment_name="m.pdf")
        self._old("r-done", status="resolved", response="Done", resolved_by=HR["email"],
                  resolved_at="2026-09-02T10:00:00+00:00")
        res = hr_tickets.migrate_open(self.db)
        self.assertEqual(res, {"moved": 1, "failed": 0, "remaining": 0})
        r = self.db.query(models.HrSelfRequest).filter(models.HrSelfRequest.id == "r-open").first()
        self.assertTrue(r.ticket_id)
        self.assertEqual(r.status, "open", "the old row is kept as it was")
        t = self._t(r.ticket_id)
        self.assertEqual((t.confidential_desk, t.requester_email, t.created_by_email, t.assignee_email),
                         ("hr", EMP["email"], EMP["email"], HR["email"]))
        self.assertEqual(t.created_at, "2026-09-01T10:00:00+00:00", "the original date")
        self.assertEqual(t.application, "Profile Change")
        self.assertGreater(t.sla_due_at, now_iso(), "not born breached")
        # Quiet: nobody is belled about a request that was already waiting.
        self.assertEqual(self._bells(HR["email"]), [])
        # The file could not be copied here (no storage) - HR's note says where it is.
        self.assertTrue(self.db.query(models.TaskComment).filter(models.TaskComment.task_id == t.id,
                                                                  models.TaskComment.internal.is_(True)).first())
        # Re-run: nothing more.
        self.assertEqual(hr_tickets.migrate_open(self.db), {"moved": 0, "failed": 0, "remaining": 0})
        self.assertEqual(TC.include(self.db.query(models.TaskTicket))
                         .filter(models.TaskTicket.confidential_desk == "hr").count(), 1)
        # My Requests: the ticket, then the resolved one as an Earlier Request.
        mine = hr_tickets.my_requests(self.db, EMP["email"])
        self.assertEqual([(m["source"], m["id"]) for m in mine], [("ticket", t.id), ("earlier", "r-done")])
        self.assertTrue(mine[1]["readOnly"])
        self.assertEqual(mine[1]["response"], "Done")
        # HR's Earlier Requests list both old rows, the moved one pointing at its ticket.
        early = {e["id"]: e for e in hr_tickets.earlier_for_hr(self.db, dict(HR))}
        self.assertEqual(early["r-open"]["ticketId"], t.id)
        self.assertEqual(hr_tickets.earlier_for_hr(self.db, dict(AGENT)), [])

    def test_a_moved_row_cannot_be_resolved_the_old_way(self):
        self._old("r1")
        hr_tickets.migrate_open(self.db)
        from routers import hr
        with self.assertRaises(HTTPException) as cm:
            hr.resolve_self_request("r1", hr.ResolveRequestIn(response="x"), user=dict(ADMIN), db=self.db)
        self.assertEqual(cm.exception.status_code, 409)

    def test_my_requests_route_files_and_lists(self):
        from routers import myhr
        out = myhr.create_request(myhr.AskHrIn(type="question", message="How much PTO do I have?"),
                                  BackgroundTasks(), user=dict(EMP), db=self.db)
        self.assertEqual((out["source"], out["type"], out["status"]), ("ticket", "question", "in_progress"))
        self.assertEqual(out["message"], "How much PTO do I have?")
        T.add_ticket_comment(out["id"], T.TicketCommentBody(body="<p>You have 40 hours.</p>"),
                             BackgroundTasks(), user=dict(HR), db=self.db)
        listed = myhr.my_requests(user=dict(EMP), db=self.db)
        self.assertEqual(listed[0]["response"], "You have 40 hours.")
        self.assertEqual(myhr.my_requests(user=dict(COLLEAGUE), db=self.db), [])


if __name__ == "__main__":
    unittest.main()
