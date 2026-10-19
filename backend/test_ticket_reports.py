"""
Ticket Reports (Oct 2026, ticket_reports.py + routers/ticket_reports.py).
Covered:

  - visibility equals the ticket list's: an agent never sees another
    company's tickets, an off-desk grant holder only their own, and someone
    with no tasks / tickets grant is refused;
  - paused tickets (waiting on the requester, pending approval) are not
    aging, and completed pauses are taken off a ticket's age;
  - SLA met % reads the honest-SLA columns (a pause that moved the deadline
    turns a late-looking resolve into a met one);
  - per-agent medians, Unassigned as its own row;
  - the CSV: per-ticket rows plus the per-agent table, US dates;
  - the weekly email: who gets it, Monday from 7 AM in their own zone,
    nothing when there are no tickets, the desk-wide switch and the
    per-person opt-out, and one send per person per week across scans.

Throwaway sqlite. No network.

Run with: python -m pytest test_ticket_reports.py -q
"""
import csv
import io
import json
import os
import re
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp.name}"
os.environ.setdefault("NEXUS_APP_URL", "https://nexus.test")

from fastapi import FastAPI                     # noqa: E402
from fastapi.testclient import TestClient       # noqa: E402

import auth                                     # noqa: E402
import cache                                    # noqa: E402
import database                                 # noqa: E402
import models                                   # noqa: E402
import ticket_notify                            # noqa: E402
import ticket_reports as R                      # noqa: E402
import ticket_sla as S                          # noqa: E402
from routers import ticket_reports as RR        # noqa: E402
from routers.task_util import gen_id            # noqa: E402

REQ = "req@greensglobal.com"            # a requester, no grant at all
TASKER = "tasker@greensglobal.com"      # a tasks grant only: opens the screen, not the desk (explicit mode)
AGENT = "agent@greensglobal.com"
AGENT2 = "agent2@greensglobal.com"
SUP = "sup@greensglobal.com"
SUP_OPTOUT = "sup.optout@greensglobal.com"
INDIA_AGENT = "india.agent@greensglobal.com"
INDIA_SUP = "india.sup@greensglobal.com"
LEFT_SUP = "left.sup@greensglobal.com"   # offboarded - never mailed
USERS = {REQ: 1, TASKER: 1, AGENT: 1, AGENT2: 1, SUP: 2, SUP_OPTOUT: 2, INDIA_AGENT: 1, INDIA_SUP: 2, LEFT_SUP: 2}

# Monday Oct 19 2026, 9:00 AM in Los Angeles - the reported week is Oct 12-18.
NOW = datetime(2026, 10, 19, 16, 0, tzinfo=timezone.utc)
WEEK = ("2026-10-12", "2026-10-18")


def h(n):
    return timedelta(hours=n)


class TicketReportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        models.Base.metadata.create_all(bind=database.engine)
        app = FastAPI()
        app.include_router(RR.router)
        cls.who = {"email": SUP}
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
        for m in (models.TaskTicket, models.TaskActivity, models.NexusEmployee, models.NexusRole, models.NexusGroup,
                  models.NexusGroupMember, models.NexusSetting, models.HrEntity, models.HrDepartment,
                  models.NexusPersonPref, models.TicketReportEmailLog):
            self.db.query(m).delete()
        self.db.commit()
        self.db.add(models.HrEntity(id="co1", name="Greens"))
        self.db.add(models.HrEntity(id="co2", name="Greens India"))
        self.db.add(models.HrDepartment(id="d1", company_id="co1", name="Facilities"))
        for email, co in ((REQ, "co1"), (TASKER, "co1"), (AGENT, "co1"), (AGENT2, "co1"), (SUP, "co1"),
                          (SUP_OPTOUT, "co1"), (INDIA_AGENT, "co2"), (INDIA_SUP, "co2"), (LEFT_SUP, "co1")):
            self.db.add(models.NexusEmployee(id=gen_id(), work_email=email, first_name=email.split("@")[0].title(),
                                             company=co, identity_type="internal",
                                             status="offboarded" if email == LEFT_SUP else "active"))
        self.db.add(models.NexusSetting(key="ticket_desk_access", value=json.dumps({"mode": "explicit"})))
        self.db.add(models.NexusGroup(id="agents", name="Agents", allowed_modules="tickets:editor"))
        self.db.add(models.NexusGroup(id="sups", name="Supervisors", allowed_modules="tickets:full"))
        self.db.add(models.NexusGroup(id="taskers", name="Taskers", allowed_modules="tasks:editor"))
        for email in (AGENT, AGENT2, INDIA_AGENT):
            self.db.add(models.NexusGroupMember(group_id="agents", email=email))
        for email in (SUP, SUP_OPTOUT, INDIA_SUP, LEFT_SUP):
            self.db.add(models.NexusGroupMember(group_id="sups", email=email))
        self.db.add(models.NexusGroupMember(group_id="taskers", email=TASKER))
        self.db.add(models.NexusSetting(key="company_walls", value="on"))
        self.db.commit()
        for c in (cache.settings_config, cache.module_grants):
            c.invalidate()
        auth.invalidate_role_cache()
        self.addCleanup(cache.settings_config.invalidate)
        self.addCleanup(cache.module_grants.invalidate)

    # ── helpers ───────────────────────────────────────────────────────────────
    def as_(self, email):
        type(self).who["email"] = email
        return self.c

    def ticket(self, created, *, company="co1", priority="medium", assignee=AGENT, requester=REQ, **over):
        t = models.TaskTicket(id=gen_id(), code=str(100 + self.db.query(models.TaskTicket).count()),
                              subject=over.pop("subject", "Printer jam"), status="open", priority=priority,
                              type=over.pop("type", "incident"), requester_email=requester,
                              created_by_email=requester, assignee_email=assignee, company_id=company,
                              hr_department_id="d1", approval_status="none", watcher_emails=[],
                              created_at=created.isoformat(), modified_at=created.isoformat())
        S.start(t, S.targets(self.db, priority), created)
        for k, v in over.items():
            setattr(t, k, v)
        self.db.add(t)
        self.db.commit()
        return t

    def resolve(self, t, at):
        S.set_status(t, "resolved", at)
        t.resolved_at = at.isoformat()
        self.db.commit()

    def report(self, who=SUP, start=WEEK[0], end=WEEK[1], **kw):
        return R.build_report(self.db, who, start=start, end=end, user={"email": who, "level": USERS[who]},
                              now=NOW, **kw)

    # ── visibility ────────────────────────────────────────────────────────────
    def test_an_agent_never_sees_another_companys_tickets(self):
        mon = datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc)
        self.ticket(mon, subject="US printer")
        self.ticket(mon, company="co2", assignee=INDIA_AGENT, subject="India printer")
        us = self.report(AGENT)
        india = self.report(INDIA_AGENT)
        self.assertEqual(us["kpis"]["created"], 1)
        self.assertEqual(india["kpis"]["created"], 1)
        self.assertEqual([b["key"] for b in us["breakdowns"]["company"]], ["co1"])
        self.assertEqual([b["key"] for b in india["breakdowns"]["company"]], ["co2"])
        rows = self.report(INDIA_AGENT, include_tickets=True)["tickets"]
        self.assertEqual([t["subject"] for t in rows], ["India printer"])
        # ...through the route too.
        r = self.as_(INDIA_AGENT).get("/task-tickets/reports", params={"start": WEEK[0], "end": WEEK[1]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["kpis"]["openNow"], 1)

    def test_off_the_desk_only_the_tickets_you_may_open(self):
        mon = datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc)
        self.ticket(mon, requester=TASKER, subject="Mine")
        self.ticket(mon, subject="Someone else's")
        mine = self.report(TASKER, include_tickets=True)
        self.assertEqual([t["subject"] for t in mine["tickets"]], ["Mine"])
        self.assertEqual(self.report(SUP)["kpis"]["created"], 2)

    def test_no_grant_is_refused(self):
        r = self.as_(REQ).get("/task-tickets/reports")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.as_(REQ).get("/task-tickets/reports.csv").status_code, 403)

    def test_bad_range_is_422(self):
        r = self.as_(SUP).get("/task-tickets/reports", params={"start": "2026-10-18", "end": "2026-10-01"})
        self.assertEqual(r.status_code, 422)
        r = self.as_(SUP).get("/task-tickets/reports", params={"start": "10/01/2026"})
        self.assertEqual(r.status_code, 422)

    # ── aging ─────────────────────────────────────────────────────────────────
    def test_paused_tickets_are_not_aging_and_pauses_come_off_the_age(self):
        five_days = NOW - timedelta(days=5)
        self.ticket(five_days, priority="high")                                   # 5 days running: 3-7
        waiting = self.ticket(five_days)
        S.set_status(waiting, "waiting_user", NOW - timedelta(days=1))            # waiting on the requester
        self.db.commit()
        self.ticket(five_days, approval_status="pending")                         # pending approval
        S.sync(self.db.query(models.TaskTicket).filter_by(approval_status="pending").one(), five_days)
        self.db.commit()
        self.ticket(five_days, sla_paused_min=3 * 1440)                           # 2 clock days: 1-3
        rep = self.report()
        buckets = {b["key"]: b for b in rep["aging"]["buckets"]}
        self.assertEqual(buckets["3-7"]["total"], 1)
        self.assertEqual(buckets["3-7"]["byPriority"]["high"], 1)
        self.assertEqual(buckets["1-3"]["total"], 1)
        self.assertEqual(sum(b["total"] for b in rep["aging"]["buckets"]), 2)
        paused = rep["aging"]["paused"]
        self.assertEqual((paused["total"], paused["waitingOnRequester"], paused["pendingApproval"]), (2, 1, 1))
        self.assertEqual(rep["kpis"]["openNow"], 4)

    # ── SLA ───────────────────────────────────────────────────────────────────
    def test_sla_met_reads_the_honest_columns(self):
        start = datetime(2026, 10, 12, 16, 0, tzinfo=timezone.utc)
        # Urgent = 24 h. Waited on the requester for 10 h, resolved at 30 h:
        # the deadline moved to 34 h, so it is MET.
        a = self.ticket(start, priority="urgent")
        S.set_status(a, "waiting_user", start + h(2))
        S.set_status(a, "in_progress", start + h(12))
        self.db.commit()
        self.assertEqual(S.parse(a.sla_due_at), start + h(34))
        self.resolve(a, start + h(30))
        # No pause, resolved at 30 h: MISSED.
        b = self.ticket(start, priority="urgent")
        self.resolve(b, start + h(30))
        # Resolved in time.
        c = self.ticket(start, priority="urgent")
        self.resolve(c, start + h(5))
        k = self.report()["kpis"]
        self.assertEqual((k["resolved"], k["slaMeasured"], k["slaMetPct"]), (3, 3, 67))
        # Resolution time leaves the 10 paused hours out: 20, 30, 5 -> median 20.
        self.assertEqual(k["resolutionMedianHours"], 20.0)

    def test_first_response_met_and_breached_now(self):
        start = datetime(2026, 10, 14, 16, 0, tzinfo=timezone.utc)
        on_time = self.ticket(start, priority="urgent")        # first response due at 4 h
        on_time.first_response_at = S.iso(start + h(1))
        late = self.ticket(start, priority="urgent")
        late.first_response_at = S.iso(start + h(6))
        self.ticket(start, priority="urgent")                  # never answered, long overdue, open
        self.ticket(start, priority="urgent", requester=AGENT)  # filed by its own assignee: no clock
        self.db.commit()
        k = self.report()["kpis"]
        self.assertEqual((k["firstResponseMeasured"], k["firstResponseMetPct"]), (3, 33))
        self.assertEqual(k["firstResponseMedianHours"], 3.5)
        self.assertEqual(k["breachedNow"], 4)                  # all four past the 24 h resolution target
        self.assertEqual(k["breachedNow"],
                         sum(1 for t in self.db.query(models.TaskTicket).all() if S.breached(t, NOW)))

    def test_reopened_counts_each_ticket_once(self):
        start = datetime(2026, 10, 13, 16, 0, tzinfo=timezone.utc)
        t = self.ticket(start)
        for at in (start + h(5), start + h(9)):
            self.db.add(models.TaskActivity(id=gen_id(), entity_kind="ticket", entity_id=t.id, type="status_changed",
                                            actor_email=REQ, at=at.isoformat(), detail="changed status to Reopened"))
        self.db.add(models.TaskActivity(id=gen_id(), entity_kind="ticket", entity_id=t.id, type="status_changed",
                                        actor_email=REQ, at=(start - timedelta(days=9)).isoformat(),
                                        detail="changed status to Reopened"))   # before the range
        self.db.commit()
        self.assertEqual(self.report()["kpis"]["reopened"], 1)

    # ── per agent ─────────────────────────────────────────────────────────────
    def test_per_agent_medians_and_unassigned(self):
        start = datetime(2026, 10, 12, 16, 0, tzinfo=timezone.utc)
        for hours, fr in ((2, 1), (4, 2), (10, 6)):
            t = self.ticket(start, priority="low")
            t.first_response_at = S.iso(start + h(fr))
            self.resolve(t, start + h(hours))
        other = self.ticket(start, assignee=AGENT2, priority="low")
        self.resolve(other, start + h(50))
        self.ticket(start - timedelta(days=20), assignee="")                 # unassigned, open
        self.ticket(start, assignee=REQ)                                     # not on the desk
        rep = self.report()
        by = {a["name"]: a for a in rep["agents"]}
        a = by["Agent"]
        self.assertEqual((a["resolved"], a["resolutionMedianHours"], a["firstResponseMedianHours"], a["slaMetPct"]),
                         (3, 4.0, 2.0, 100))
        self.assertEqual(by["Agent2"]["resolutionMedianHours"], 50.0)
        self.assertEqual(by["Unassigned"]["kind"], "unassigned")
        self.assertEqual(by["Unassigned"]["open"], 1)
        self.assertGreaterEqual(by["Unassigned"]["oldestOpenDays"], 26.9)
        self.assertEqual(by["Not on the Desk"]["kind"], "other")
        self.assertEqual(rep["agents"][-1]["kind"], "unassigned")

    def test_trend_is_daily_up_to_31_days_and_weekly_beyond(self):
        self.ticket(datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc))
        daily = self.report()
        self.assertEqual(daily["range"]["granularity"], "day")
        self.assertEqual(len(daily["trend"]), 7)
        self.assertEqual({d["key"]: d["created"] for d in daily["trend"]}["2026-10-13"], 1)
        self.assertEqual(daily["trend"][0]["label"], "10/12/2026")
        weekly = self.report(start="2026-08-01", end="2026-10-18")
        self.assertEqual(weekly["range"]["granularity"], "week")
        self.assertEqual(weekly["trend"][0]["key"], "2026-07-27")   # the Monday of 08/01
        self.assertEqual(sum(w["created"] for w in weekly["trend"]), 1)

    def test_recurring_subjects(self):
        start = datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc)
        self.ticket(start, subject="VPN down 3")
        self.ticket(start + h(1), subject="vpn  DOWN!")
        self.ticket(start, subject="Printer jam")
        rec = self.report()["recurring"]
        self.assertEqual([e["count"] for e in rec], [2])

    # ── CSV ───────────────────────────────────────────────────────────────────
    def test_csv_has_ticket_rows_agent_table_and_us_dates(self):
        start = datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc)
        t = self.ticket(start, subject="Door lock")
        self.resolve(t, start + h(3))
        r = self.as_(SUP).get("/task-tickets/reports.csv", params={"start": WEEK[0], "end": WEEK[1]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.headers["content-type"].startswith("text/csv"))
        self.assertIn('filename="ticket-report-10-12-2026-to-10-18-2026.csv"', r.headers["content-disposition"])
        lines = list(csv.reader(io.StringIO(r.text)))
        self.assertEqual(lines[0], ["Ticket Report 10/12/2026 - 10/18/2026"])
        header = lines[2]
        self.assertEqual(header[:3], ["Ticket", "Subject", "Company"])
        row = dict(zip(header, lines[3]))
        self.assertEqual(row["Subject"], "Door lock")
        self.assertRegex(row["Created"], r"^10/13/2026 10:00 AM P[DS]T$")
        self.assertEqual(row["Resolution SLA"], "Met")
        self.assertEqual(row["Resolution (Hours)"], "3.0")
        self.assertNotRegex(r.text, r"\d{4}-\d{2}-\d{2}")
        i = [x[:1] for x in lines].index(["Per Agent"])
        self.assertEqual(lines[i + 1][0], "Agent")
        self.assertEqual(lines[i + 2][0], "Agent")   # the agent's own name row
        self.assertNotIn("\u2014", r.text)

    # ── weekly email ──────────────────────────────────────────────────────────
    def test_recipients_are_supervisors_with_tickets_who_did_not_opt_out(self):
        self.ticket(datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc))
        R.set_weekly_opt_in(self.db, SUP_OPTOUT, False)
        due = dict(R.recipients_due(self.db, NOW))
        self.assertIn(SUP, due)
        self.assertEqual(due[SUP].isoformat(), "2026-10-12")
        self.assertIn(INDIA_SUP, due)          # a supervisor; whether they have tickets is decided at send
        for nobody in (AGENT, AGENT2, REQ, TASKER, SUP_OPTOUT, LEFT_SUP):
            self.assertNotIn(nobody, due)
        # Before 7 AM local, or on a Tuesday: not due.
        self.assertEqual(R.recipients_due(self.db, datetime(2026, 10, 19, 13, 0, tzinfo=timezone.utc)), [])
        self.assertEqual(R.recipients_due(self.db, NOW + timedelta(days=1)), [])

    def test_one_send_per_person_per_week_and_nothing_when_empty(self):
        self.ticket(datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc), subject="Gate stuck")
        R.set_weekly_opt_in(self.db, SUP_OPTOUT, False)
        with patch("graph_mail.send_mail") as send:
            self.assertEqual(R.scan_once(NOW), 1)
            self.assertEqual(R.scan_once(NOW + h(1)), 0)
            self.assertEqual(R.scan_once(NOW + h(2)), 0)
        self.assertEqual(send.call_count, 1)
        kw = send.call_args.kwargs
        self.assertEqual(kw["to"], [SUP])
        self.assertEqual(kw["subject"], "Weekly Ticket Report 10/12/2026 - 10/18/2026")
        self.assertIn("https://nexus.test/tickets?view=reports", kw["html"])
        self.assertNotIn("\u2014", kw["html"])
        logs = {(r.recipient, r.status) for r in self.db.query(models.TicketReportEmailLog).all()}
        self.assertEqual(logs, {(SUP, "sent"), (INDIA_SUP, "empty")})   # India sees no co1 ticket

    def test_a_claimed_week_is_never_sent_again(self):
        self.ticket(datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc))
        # A row left "sending" by a worker that died mid-send still holds the week.
        self.db.add(models.TicketReportEmailLog(id=gen_id(), recipient=SUP, week_start="2026-10-12",
                                                status="sending", created_at=S.iso(NOW)))
        self.db.commit()
        with patch("graph_mail.send_mail") as send:
            R.scan_once(NOW)
            self.assertEqual(R.send_weekly(self.db, SUP, datetime(2026, 10, 12).date(), NOW), "")
        self.assertEqual([c.kwargs["to"] for c in send.call_args_list if c.kwargs["to"] == [SUP]], [])

    def test_the_desk_switch_turns_it_off(self):
        self.ticket(datetime(2026, 10, 13, 17, 0, tzinfo=timezone.utc))
        ticket_notify.save_settings(self.db, {"enabledEvents": {"weekly_report": False}}, "test")
        with patch("graph_mail.send_mail") as send:
            self.assertEqual(R.scan_once(NOW), 0)
        send.assert_not_called()
        self.assertTrue(ticket_notify.get_settings(self.db)["enabledEvents"]["weekly_report"] is False)

    def test_weekly_email_pref_route(self):
        r = self.as_(SUP).get("/task-tickets/reports/weekly-email")
        self.assertEqual(r.json(), {"on": True, "eligible": True, "deskEnabled": True})
        r = self.as_(SUP).put("/task-tickets/reports/weekly-email", json={"on": False})
        self.assertEqual(r.json()["on"], False)
        self.assertFalse(R.weekly_opted_in(self.db, SUP))
        self.assertFalse(self.as_(AGENT).get("/task-tickets/reports/weekly-email").json()["eligible"])

    def test_us_dates_only_in_the_report_labels(self):
        rep = self.report()
        self.assertEqual(rep["range"]["label"], "10/12/2026 - 10/18/2026")
        self.assertTrue(all(re.match(r"^\d{2}/\d{2}/\d{4}$", d["label"]) for d in rep["trend"]))


if __name__ == "__main__":
    unittest.main()
