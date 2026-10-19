"""
Honest SLA (Oct 2026, ticket_sla.py): datetime deadlines honest to the
minute, a first-response target, the clock paused while waiting on the
requester (and while resolved / closed), breach alerts once per deadline to
the assignee (or the desk) and the department lead, and a backfill that marks
old breaches so a deploy fires no flood of bells.

Throwaway sqlite, no network.

Run with: python -m pytest -q test_ticket_sla_honest.py
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_APP_URL", "https://nexus.test")

from fastapi import BackgroundTasks

import database
import models
import ticket_notify
import ticket_overdue
import ticket_sla as S
import ticket_taxonomy
from routers import tickets as T
from routers.task_util import gen_id

REQUESTER = {"email": "requester@greensglobal.com", "level": 1}
REPORTER = {"email": "reporter@greensglobal.com", "level": 1}
AGENT = {"email": "agent@greensglobal.com", "level": 4}
DESK = "desk@greensglobal.com"
LEAD = "lead@greensglobal.com"
T0 = datetime(2026, 10, 19, 16, 0, tzinfo=timezone.utc)   # 9:00 AM in Los Angeles


def h(n):
    return timedelta(hours=n)


class HonestSlaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)

    @classmethod
    def tearDownClass(cls):
        database.engine.dispose()
        os.remove(_tmp.name)

    def setUp(self):
        self.db = database.SessionLocal()
        for m in (models.TaskTicket, models.TaskComment, models.TaskActivity, models.TaskNotification,
                  models.NexusNotification, models.NexusSetting, models.HrDepartment,
                  models.TicketDepartment, models.NexusEmployee, models.TicketTeamsMessage):
            self.db.query(m).delete()
        self.db.add(models.HrDepartment(id="d1", company_id="c1", name="Facilities", lead_email=LEAD))
        self.db.add(models.HrDepartment(id="d2", company_id="c1", name="Leaderless", lead_email=""))
        self.db.commit()
        ticket_notify.save_settings(self.db, {"agentEmails": [DESK]}, "test")

    def tearDown(self):
        self.db.close()

    # ── helpers ───────────────────────────────────────────────────────────────
    def ticket(self, created=T0, priority="urgent", status="open", assignee=AGENT["email"], dept="d1", **over):
        t = models.TaskTicket(id=gen_id(), code=str(100000 + self.db.query(models.TaskTicket).count()),
                              subject=over.pop("subject", "Printer jam"), status=status, priority=priority,
                              requester_email=REQUESTER["email"], created_by_email=over.pop("created_by", REQUESTER["email"]),
                              assignee_email=assignee, hr_department_id=dept, company_id="c1",
                              approval_status=over.pop("approval_status", "none"),
                              created_at=created.isoformat(), modified_at=created.isoformat())
        S.start(t, S.targets(self.db, priority), created)
        for k, v in over.items():
            setattr(t, k, v)
        self.db.add(t)
        self.db.commit()
        return t

    def bells(self, who=None):
        q = self.db.query(models.NexusNotification).filter(models.NexusNotification.type == "task_ticket_sla_breach")
        if who:
            q = q.filter(models.NexusNotification.recipient == who)
        return q.all()

    # ── deadlines ─────────────────────────────────────────────────────────────
    def test_deadlines_are_datetimes_from_created_at(self):
        t = self.ticket(priority="urgent")
        self.assertEqual(t.sla_due_at, "2026-10-20T16:00:00+00:00")             # 24 h
        self.assertEqual(t.first_response_due_at, "2026-10-19T20:00:00+00:00")  # 4 h
        self.assertEqual(t.sla_due_on, "2026-10-20")                            # back-compat date
        self.assertEqual((t.first_response_at, t.sla_paused_at, t.sla_paused_min), ("", "", 0))
        low = self.ticket(priority="low")
        self.assertEqual(S.parse(low.sla_due_at) - T0, h(168))
        self.assertEqual(S.parse(low.first_response_due_at) - T0, h(48))

    def test_first_response_targets_are_configurable_and_validated(self):
        cfg = ticket_taxonomy.get_config(self.db)
        self.assertEqual(cfg["firstResponseHours"], {"urgent": 4, "high": 8, "medium": 24, "low": 48})
        ticket_taxonomy.save_config(self.db, {"firstResponseHours": {"urgent": 2, "bogus": 5}}, "test")
        self.assertEqual(ticket_taxonomy.get_config(self.db)["firstResponseHours"]["urgent"], 2)
        self.assertNotIn("bogus", ticket_taxonomy.get_config(self.db)["firstResponseHours"])
        self.assertEqual(S.targets(self.db, "urgent"), (24, 2))
        with self.assertRaises(ticket_taxonomy.SlaHoursError) as e:
            ticket_taxonomy.save_config(self.db, {"firstResponseHours": {"high": 0}}, "test")
        self.assertIn("first response target", str(e.exception))

    def test_breach_is_honest_to_the_minute(self):
        t = self.ticket(priority="urgent")   # filed 9 AM, due 9 AM the next day
        self.assertFalse(S.breached(t, T0 + h(24) - timedelta(minutes=1)))
        self.assertTrue(S.breached(t, T0 + h(24) + timedelta(minutes=1)))
        self.assertFalse(S.response_breached(t, T0 + h(3)))
        self.assertTrue(S.response_breached(t, T0 + h(4) + timedelta(minutes=1)))

    def test_create_ticket_fills_the_clock_and_the_dict(self):
        out = T.create_ticket(T.TicketBody(subject="s", priority="high"), BackgroundTasks(),
                              user=REQUESTER, db=self.db)
        created = S.parse(out["createdAt"])
        self.assertEqual(S.parse(out["slaDueAt"]), created.replace(microsecond=0) + h(48))
        self.assertEqual(S.parse(out["firstResponseDueAt"]), created.replace(microsecond=0) + h(8))
        self.assertIsNone(out["firstResponseAt"])
        self.assertFalse(out["slaPaused"])
        self.assertEqual(out["slaDueOn"], out["slaDueAt"][:10])

    # ── pause / resume ────────────────────────────────────────────────────────
    def test_waiting_on_the_requester_pauses_and_resuming_extends_both(self):
        t = self.ticket(priority="urgent")
        S.set_status(t, "waiting_user", T0 + h(1))
        self.assertEqual(t.sla_paused_at, S.iso(T0 + h(1)))
        self.assertFalse(S.breached(t, T0 + h(30)))          # paused: never breached
        self.assertFalse(S.response_breached(t, T0 + h(30)))
        S.set_status(t, "in_progress", T0 + h(4))           # three hours waiting
        self.assertEqual(t.sla_paused_at, "")
        self.assertEqual(t.sla_paused_min, 180)
        self.assertEqual(S.parse(t.sla_due_at), T0 + h(27))
        self.assertEqual(S.parse(t.first_response_due_at), T0 + h(7))

    def test_legacy_waiting_pauses_too_and_on_hold_does_not(self):
        t = self.ticket()
        S.set_status(t, "waiting", T0 + h(1))
        self.assertTrue(t.sla_paused_at)
        S.set_status(t, "on_hold", T0 + h(2))
        self.assertEqual(t.sla_paused_min, 60)
        self.assertFalse(t.sla_paused_at)

    def test_first_response_deadline_is_not_moved_once_responded(self):
        t = self.ticket()
        t.first_response_at = S.iso(T0 + h(1))
        before = t.first_response_due_at
        S.set_status(t, "waiting_user", T0 + h(2))
        S.set_status(t, "in_progress", T0 + h(5))
        self.assertEqual(t.first_response_due_at, before)
        self.assertEqual(S.parse(t.sla_due_at), T0 + h(27))

    def test_resolve_then_reopen_continues_the_time_left(self):
        t = self.ticket(priority="urgent")
        S.set_status(t, "resolved", T0 + h(10))   # 14 hours were left
        self.assertFalse(S.breached(t, T0 + h(100)))
        S.set_status(t, "reopened", T0 + h(50))
        self.assertEqual(S.parse(t.sla_due_at) - (T0 + h(50)), h(14))
        self.assertEqual(t.first_response_at, "")   # never responded - stays empty

    def test_priority_change_while_paused_recomputes_and_stays_paused(self):
        t = self.ticket(priority="medium")
        S.set_status(t, "waiting_user", T0 + h(1))
        S.set_status(t, "in_progress", T0 + h(2))   # 60 min paused
        S.set_status(t, "waiting_user", T0 + h(3))
        t.priority = "urgent"
        S.recompute(t, S.targets(self.db, "urgent"), T0 + h(4))
        self.assertEqual(S.parse(t.sla_due_at), T0 + h(25))           # 24 h + the 1 h pause
        self.assertEqual(S.parse(t.first_response_due_at), T0 + h(5))  # 4 h + the 1 h pause
        self.assertEqual(t.sla_paused_at, S.iso(T0 + h(3)))            # still paused
        S.set_status(t, "in_progress", T0 + h(6))
        self.assertEqual(S.parse(t.sla_due_at), T0 + h(28))

    def test_update_ticket_routes_status_and_priority_through_the_clock(self):
        t = self.ticket(created=datetime.now(timezone.utc) - h(2), priority="urgent")
        T.update_ticket(t.id, T.TicketUpdate(status="waiting_user"), BackgroundTasks(), user=AGENT, db=self.db)
        self.db.refresh(t)
        self.assertTrue(t.sla_paused_at)
        due = S.parse(t.sla_due_at)
        t.sla_paused_at = S.iso(datetime.now(timezone.utc) - h(2))   # it waited two hours
        self.db.commit()
        out = T.update_ticket(t.id, T.TicketUpdate(status="in_progress"), BackgroundTasks(), user=AGENT, db=self.db)
        self.assertFalse(out["slaPaused"])
        self.assertAlmostEqual((S.parse(out["slaDueAt"]) - due).total_seconds(), 7200, delta=120)
        out = T.update_ticket(t.id, T.TicketUpdate(priority="low"), BackgroundTasks(), user=AGENT, db=self.db)
        created = S.parse(out["createdAt"]).replace(microsecond=0)
        self.assertEqual(S.parse(out["slaDueAt"]), created + h(168) + timedelta(minutes=out["slaPausedMin"]))

    def test_rejecting_a_request_stops_the_clock(self):
        t = self.ticket(approval_status="pending", approver_email=AGENT["email"], assignee="")
        T.decide_approval(t.id, T.ApprovalBody(decision="reject", note="No budget"), BackgroundTasks(),
                          user=AGENT, db=self.db)
        self.db.refresh(t)
        self.assertEqual(t.status, "closed")
        self.assertTrue(t.sla_paused_at)

    def test_auto_close_goes_through_the_helper(self):
        t = self.ticket(created=datetime.now(timezone.utc) - h(400), status="open")
        S.set_status(t, "resolved")
        t.resolved_at = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        self.db.commit()
        ticket_notify._auto_close_once(self.db)
        self.db.refresh(t)
        self.assertEqual(t.status, "closed")
        self.assertTrue(t.sla_paused_at)

    # ── first response ────────────────────────────────────────────────────────
    def _comment(self, t, user, internal=False):
        T.add_ticket_comment(t.id, T.TicketCommentBody(body="<p>hi</p>", internal=internal), BackgroundTasks(),
                             user=user, db=self.db)
        self.db.refresh(t)

    def test_first_response_is_the_first_public_reply_from_someone_else(self):
        t = self.ticket(created=datetime.now(timezone.utc), created_by=REPORTER["email"],
                        watcher_emails=[REPORTER["email"]])
        self._comment(t, REQUESTER)                 # the requester talking
        self.assertEqual(t.first_response_at, "")
        self._comment(t, REPORTER)                  # whoever filed it for them
        self.assertEqual(t.first_response_at, "")
        self._comment(t, AGENT, internal=True)      # an internal note
        self.assertEqual(t.first_response_at, "")
        self._comment(t, AGENT)                     # a real reply
        first = t.first_response_at
        self.assertTrue(first)
        self._comment(t, AGENT)                     # later replies do not move it
        self.assertEqual(t.first_response_at, first)
        self.assertFalse(S.response_breached(t, datetime.now(timezone.utc) + h(100)))

    def test_a_ticket_born_assigned_still_needs_a_reply(self):
        self.db.add(models.NexusEmployee(id="e-agent", work_email=AGENT["email"], first_name="Ana",
                                         last_name="Gent", status="active"))
        self.db.commit()
        out = T.create_ticket(T.TicketBody(subject="s", priority="urgent", assignee_email=AGENT["email"]),
                              BackgroundTasks(), user=AGENT, db=self.db)
        self.assertEqual(out["status"], "in_progress")
        self.assertIsNone(out["firstResponseAt"])

    def test_resolving_without_a_reply_leaves_it_empty_and_stops_the_clock(self):
        t = self.ticket()
        S.set_status(t, "resolved", T0 + h(1))
        self.assertEqual(t.first_response_at, "")
        self.assertFalse(S.response_breached(t, T0 + h(50)))

    # ── breach alerts ─────────────────────────────────────────────────────────
    def test_alert_once_per_deadline_to_assignee_and_lead(self):
        t = self.ticket()
        self.assertEqual(S.scan_breaches(self.db, T0 + h(3)), 0)
        self.assertEqual(S.scan_breaches(self.db, T0 + h(5)), 2)   # first response missed
        self.assertEqual(len(self.bells(AGENT["email"])), 1)
        self.assertEqual(len(self.bells(LEAD)), 1)
        self.assertEqual(S.scan_breaches(self.db, T0 + h(6)), 0)   # never twice
        self.db.refresh(t)
        self.assertEqual((t.sla_fr_alerted_at, t.sla_res_alerted_at), (t.first_response_due_at, ""))
        S.scan_breaches(self.db, T0 + h(25))                         # now resolution too
        self.assertEqual(len(self.bells(AGENT["email"])), 2)
        logged = (self.db.query(models.TaskActivity)
                  .filter(models.TaskActivity.entity_id == t.id, models.TaskActivity.type == "sla_breach_alert").count())
        self.assertEqual(logged, 2)

    def test_moved_into_the_future_then_passed_again_alerts_again(self):
        t = self.ticket(first_response_at=S.iso(T0 + h(1)))   # answered: only the resolution clock
        S.scan_breaches(self.db, T0 + h(25))
        self.assertEqual(len(self.bells(AGENT["email"])), 1)
        S.set_status(t, "waiting_user", T0 + h(25))
        self.db.commit()
        self.assertEqual(S.scan_breaches(self.db, T0 + h(26)), 0)   # paused: none
        t.priority = "low"                                           # deadline moves out a week
        S.recompute(t, S.targets(self.db, "low"), T0 + h(26))
        self.assertEqual(t.sla_res_alerted_at, "")                   # back in the future: re-armed
        S.set_status(t, "in_progress", T0 + h(27))
        self.db.commit()
        self.assertEqual(S.scan_breaches(self.db, T0 + h(30)), 0)   # not past the new one
        S.scan_breaches(self.db, T0 + h(200))
        self.assertEqual(len(self.bells(AGENT["email"])), 2)         # the new deadline alerts once
        self.assertEqual(S.scan_breaches(self.db, T0 + h(201)), 0)

    def test_moved_but_still_past_does_not_alert_again(self):
        t = self.ticket()
        S.scan_breaches(self.db, T0 + h(25))                         # both kinds, one bell
        self.assertEqual(len(self.bells(AGENT["email"])), 1)
        S.set_status(t, "waiting_user", T0 + h(25))
        S.set_status(t, "in_progress", T0 + h(27))                  # deadlines +2 h, still past
        self.db.commit()
        self.assertTrue(t.sla_res_alerted_at and t.sla_fr_alerted_at)
        self.assertEqual(S.scan_breaches(self.db, T0 + h(28)), 0)
        self.assertEqual(len(self.bells(AGENT["email"])), 1)

    def test_a_pause_that_pushes_the_deadline_past_now_rearms(self):
        t = self.ticket(first_response_at=S.iso(T0 + h(1)))
        S.scan_breaches(self.db, T0 + h(25))                         # 1 h late
        S.set_status(t, "waiting_user", T0 + h(25))
        S.set_status(t, "in_progress", T0 + h(30))                  # +5 h: due T0+29h, still past
        self.assertTrue(t.sla_res_alerted_at)
        S.set_status(t, "waiting_user", T0 + h(30))
        S.set_status(t, "in_progress", T0 + h(40))                  # +10 h: due T0+39h, still past
        self.assertTrue(t.sla_res_alerted_at)
        t2 = self.ticket(first_response_at=S.iso(T0 + h(1)))
        S.set_status(t2, "waiting_user", T0 + h(20))                # 4 h left when paused
        S.set_status(t2, "in_progress", T0 + h(30))                 # due T0+34h, in the future
        self.db.commit()
        self.assertEqual(S.scan_breaches(self.db, T0 + h(33)), 0)
        S.scan_breaches(self.db, T0 + h(35))
        self.assertEqual(len(self.bells(AGENT["email"])), 2)

    def test_none_while_paused_or_awaiting_approval(self):
        self.ticket(status="waiting_user")
        self.ticket(approval_status="pending", assignee="")
        self.ticket(status="resolved")
        self.assertEqual(S.scan_breaches(self.db, T0 + h(200)), 0)
        self.assertEqual(self.bells(), [])

    def test_grouped_one_bell_per_person(self):
        self.ticket(subject="One")
        self.ticket(subject="Two")
        self.ticket(subject="Three")
        S.scan_breaches(self.db, T0 + h(5))
        mine = self.bells(AGENT["email"])
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0].title, "SLA Breached on 3 Tickets")
        for word in ("One", "Two", "Three", "Response Overdue"):
            self.assertIn(word, mine[0].body)
        self.assertEqual(len(self.bells(LEAD)), 1)

    def test_unassigned_goes_to_the_desk_and_no_lead_logs_a_gap(self):
        t = self.ticket(assignee="", dept="d2")
        S.scan_breaches(self.db, T0 + h(5))
        self.assertEqual(len(self.bells(DESK)), 1)
        self.assertEqual(self.bells(LEAD), [])
        gap = (self.db.query(models.TaskActivity)
               .filter(models.TaskActivity.entity_id == t.id, models.TaskActivity.type == "notify_gap").count())
        self.assertEqual(gap, 1)

    def test_switched_off_sends_nothing(self):
        self.assertTrue(ticket_notify.get_settings(self.db)["enabledEvents"]["sla_breach"])   # on by default
        ticket_notify.save_settings(self.db, {"enabledEvents": {"sla_breach": False}}, "test")
        self.ticket()
        self.assertEqual(S.scan_breaches(self.db, T0 + h(30)), 0)
        self.assertEqual(self.bells(), [])

    def test_the_loop_runs_the_scan(self):
        with patch("ticket_sla.scan_breaches") as scan, patch("ticket_overdue.run"):
            ticket_notify._ticket_scan_once()
        scan.assert_called_once()

    # ── backfill ──────────────────────────────────────────────────────────────
    def _legacy(self, created, status="open", **kw):
        t = models.TaskTicket(id=gen_id(), code=gen_id()[:6], subject="Old", status=status, priority="urgent",
                              requester_email=REQUESTER["email"], created_by_email=REPORTER["email"],
                              assignee_email=AGENT["email"], hr_department_id="d1", approval_status="none",
                              created_at=created.isoformat(), modified_at=created.isoformat(),
                              sla_due_on=(created + h(24)).date().isoformat(), **kw)
        self.db.add(t)
        self.db.commit()
        return t

    def test_backfill_marks_past_deadlines_so_the_deploy_does_not_flood(self):
        now = datetime.now(timezone.utc)
        old = self._legacy(now - timedelta(days=10))
        waiting = self._legacy(now - timedelta(days=10), status="waiting_user")
        fresh = self._legacy(now - h(1))
        answered = self._legacy(now - timedelta(days=3))
        for author, internal, at in ((REQUESTER["email"], False, 1), (REPORTER["email"], False, 2),
                                     (AGENT["email"], True, 3), (AGENT["email"], False, 4)):
            self.db.add(models.TaskComment(id=gen_id(), task_id=answered.id, author_email=author, body="x",
                                           internal=internal, created_at=(now - timedelta(days=3) + h(at)).isoformat()))
        self.db.commit()
        self.assertEqual(S.backfill(self.db, now), 4)
        for t in (old, waiting, fresh, answered):
            self.db.refresh(t)
        self.assertEqual(S.parse(old.sla_due_at), S.parse(old.created_at).replace(microsecond=0) + h(24))
        self.assertEqual((old.sla_fr_alerted_at, old.sla_res_alerted_at), (old.first_response_due_at, old.sla_due_at))
        self.assertEqual(waiting.sla_paused_at, S.iso(now))
        self.assertEqual((fresh.sla_fr_alerted_at, fresh.sla_res_alerted_at), ("", ""))
        self.assertEqual(S.parse(answered.first_response_at), S.parse(answered.created_at) + h(4))
        self.assertEqual(answered.sla_fr_alerted_at, "")
        self.assertEqual(S.scan_breaches(self.db, now + timedelta(minutes=5)), 0)   # no flood
        self.assertEqual(self.bells(), [])
        self.assertEqual(S.backfill(self.db, now), 0)                                 # idempotent
        S.scan_breaches(self.db, now + h(5))                                         # a NEW breach still alerts
        self.assertEqual(len(self.bells(AGENT["email"])), 1)

    # ── readers ───────────────────────────────────────────────────────────────
    def test_sql_breach_filter_agrees_with_python(self):
        now = datetime.now(timezone.utc)
        rows = [self.ticket(created=now - h(30)),                               # breached
                self.ticket(created=now - h(2)),                                # not yet
                self.ticket(created=now - h(30), status="waiting_user"),        # paused
                self.ticket(created=now - h(30), status="closed"),              # done
                self._legacy(now - timedelta(days=5))]                          # no datetime: old date compare
        hits = {t.id for t in self.db.query(models.TaskTicket).filter(S.breached_filter(S.iso(now))).all()}
        self.assertEqual(hits, {t.id for t in rows if S.breached(t, now)})
        self.assertEqual(hits, {rows[0].id, rows[4].id})
        self.assertTrue(T._sla_breached(rows[0]))

    def test_overdue_reminders_use_the_assignees_local_date(self):
        t = self.ticket()
        t.sla_due_at = "2026-10-20T03:00:00+00:00"   # 8 PM on 10/19 in Los Angeles
        self.assertEqual(ticket_overdue.due_day(t, "America/Los_Angeles"), "2026-10-19")
        self.assertEqual(ticket_overdue.due_day(t, "Asia/Kolkata"), "2026-10-20")
        legacy = self._legacy(T0)
        self.assertEqual(ticket_overdue.due_day(legacy, "America/Los_Angeles"), legacy.sla_due_on)

    def test_my_work_due_day_is_the_callers_local_day(self):
        from routers import my_work
        self.assertEqual(my_work._local_day("2026-10-20T03:00:00+00:00", 420), "2026-10-19")   # PDT
        self.assertEqual(my_work._local_day("2026-10-20T03:00:00+00:00", -330), "2026-10-20")  # IST

    def test_due_display_shows_date_and_time(self):
        t = self.ticket()
        ctx = ticket_notify._time_fields(t, "America/Los_Angeles")
        self.assertEqual(ctx["dueDateDisplay"], "10/20/2026 9:00 AM PDT")


if __name__ == "__main__":
    unittest.main()
