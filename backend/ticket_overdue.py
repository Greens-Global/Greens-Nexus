"""Overdue ticket reminders (Oct 15 2026).

A ticket's assignee hears about it when it reaches its due date
(`sla_due_on`) still open, so it does not rest on an email they may never
have opened:

- The first reminder goes out on the due date, in the morning of the
  assignee's own time zone (daily_briefing._person_zone: their Shift preset's
  zone, else the briefing default). A due date on a weekend is reminded on
  the next business day.
- While it stays open, another one every other business day. Monday to
  Friday; holidays are not skipped.
- ONE message per person per day, listing every ticket of theirs that is due
  today or past due - never one per ticket.
- After two overdue reminders went unanswered, each later one also goes to
  the department head (HrDepartment.lead_email, else the desk's backup_email, of the
  department the ticket is about - the same lookup as Escalate).
- Not reminded: resolved and closed tickets, tickets waiting for the
  requester (the delay is not the assignee's), tickets still awaiting
  approval, and unassigned tickets.

Delivery: a Teams chat message sent from the assignee's MANAGER's account
(timesheet_review.manager_of; the delegated token comes from their Nexus
session, same queue as the requester DMs - teams_post.deliver_ticket_row), so
it lands in the manager <-> assignee 1:1 chat. The lead's copy comes from the
same manager. Every reminder also goes to the Nexus bell. NO email (Sagar,
Oct 15 2026): the daily and weekly briefings already mail people. A Teams
message that fails now stays queued for teams_post's retry sweep; with no
manager, or the manager being the recipient, the bell is the reminder.

State per ticket is TaskTicket.overdue_reminder (see models.py). The
reminder is marked BEFORE it is sent: a crash mid-send loses one reminder
rather than sending it twice. Runs inside ticket_notify's leader-gated loop,
in a worker thread.

Off until switched on: enabledEvents.overdue_reminder in the ticket
notification settings (Manage > Email Notifications), so a deploy never starts
messaging people from their managers' accounts on its own.
"""
from datetime import date, datetime, timedelta, timezone, time as dtime

from sqlalchemy.orm import Session

import models

SEND_FROM = dtime(9, 0)         # assignee's local time
SEND_UNTIL = dtime(17, 0)       # nothing after the workday; the next one tries again
SKIP_STATUSES = ("resolved", "closed", "waiting_user", "waiting")   # "waiting" = legacy waiting-for-user
EVERY_BUSINESS_DAYS = 2
LEAD_AFTER_IGNORED = 2          # overdue reminders the assignee gets alone before the lead is added


def business_days(a: date, b: date) -> int:
    """Monday-Friday days after `a`, up to and including `b` (0 when b <= a)."""
    n, d = 0, a
    while d < b:
        d += timedelta(days=1)
        n += d.weekday() < 5
    return n


def first_business_day(d: date) -> date:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def _state(t: models.TaskTicket) -> dict:
    due = (t.sla_due_on or "")[:10]
    s = dict(t.overdue_reminder or {})
    if s.get("due") != due:   # a new due date starts the counts over
        return {"due": due, "sent": 0, "overdue": 0, "on": ""}
    return {"due": due, "sent": int(s.get("sent") or 0), "overdue": int(s.get("overdue") or 0), "on": s.get("on") or ""}


def due_for_reminder(states: list, today: date) -> bool:
    """Does this person get a reminder today? `states` are the _state()s of
    their tickets due on or before today. Today's reminder already out = no.
    A ticket reaching its (business-day) due date today = yes. Otherwise yes
    when something is past due and the last reminder is two business days
    old, or there has never been one."""
    today_iso = today.isoformat()
    if not states or any(s["on"] == today_iso for s in states):
        return False
    due = [date.fromisoformat(s["due"]) for s in states]
    if any(first_business_day(d) == today and s["sent"] == 0 for d, s in zip(due, states)):
        return True
    if not any(d < today for d in due):
        return False
    last = max((s["on"] for s in states), default="")
    return not last or business_days(date.fromisoformat(last), today) >= EVERY_BUSINESS_DAYS


def _send_teams(db: Session, sender: str, to: str, html: str, ticket_id: str) -> str:
    """One Teams message from `sender` to `to`, attempted now; a failure stays
    queued for ticket_teams_post_loop to retry."""
    import teams_post
    from routers.task_util import gen_id, now_iso
    if not sender or sender == to:
        return "bell only (no manager to send from)"
    row = models.TicketTeamsMessage(id=gen_id(), ticket_id=ticket_id, agent_email=sender,
                                    requester_email=to, html=html, created_at=now_iso())
    db.add(row)
    db.commit()
    if teams_post.deliver_ticket_row(db, row):
        return "Teams"
    return "Teams queued for retry"


def _deliver(db: Session, *, sender: str, to: str, rows: list, audience: str,
             dept_name: str = "") -> str:
    """Teams and the bell. Returns how it went out, for the ticket history."""
    import ticket_mail_templates as tmpl
    from app_url import app_url
    from routers.task_util import task_notify
    from ticket_code import ticket_no
    from ticket_notify import _name_of

    first = (_name_of(db, to) or "").split(" ")[0]
    if "@" in first:
        first = ""
    heading, _ = tmpl._overdue_heading(rows, audience, dept_name)
    html = tmpl.overdue_teams_html(rows=rows, audience=audience, base_url=app_url(),
                                   first_name=first, dept_name=dept_name)
    task_notify(db, kind="ticket_overdue", for_email=to, title=heading,
                body=", ".join(f"{ticket_no(r['code'])} {r['subject']}" for r in rows)[:300],
                ticket_id=rows[0]["id"] if len(rows) == 1 else "",
                nexus_action={"view": "tickets", "label": "View Tickets"},
                main_bell=True)   # it needs them (task_util.MAIN_BELL_KINDS)
    db.commit()
    return _send_teams(db, sender, to, html, rows[0]["id"])


def _lead_of(db: Session, t: models.TaskTicket):
    """The department's head - HrDepartment.lead_email, the one head every
    module reads since Oct 15 2026 (ticket_notify._recipients_for does the
    same) - else the desk's backup. TicketDepartment.lead_email is history."""
    if not t.hr_department_id:
        return "", ""
    live = db.query(models.HrDepartment).filter(models.HrDepartment.id == t.hr_department_id).first()
    dept = db.query(models.TicketDepartment).filter(models.TicketDepartment.id == t.hr_department_id).first()
    lead = ((live.lead_email if live else "") or (dept.backup_email if dept else "") or "").strip().lower()
    return lead, ((live.name if live else "") or (dept.name if dept else ""))


def run(db: Session, local_now=None) -> int:
    """One pass: remind everyone whose reminder is due right now. Returns how
    many people were reminded (assignees and leads). `local_now(email)` gives
    a person's naive local time - tests pass their own clock."""
    import daily_briefing
    import ticket_notify
    from routers.task_util import log_activity
    from routers.timeclock import _shift_local_now
    from timesheet_review import manager_of

    cfg = ticket_notify.get_settings(db)
    if not cfg["enabledEvents"].get("overdue_reminder"):
        return 0
    horizon = (datetime.now(timezone.utc) + timedelta(days=2)).date().isoformat()   # nobody's local date is past UTC + 1
    tickets = (db.query(models.TaskTicket)
               .filter(models.TaskTicket.assignee_email != "", models.TaskTicket.sla_due_on != "",
                       models.TaskTicket.sla_due_on < horizon,
                       ~models.TaskTicket.status.in_(SKIP_STATUSES))
               .all())
    by_person: dict = {}
    for t in tickets:
        if (t.approval_status or "none") == "pending":
            continue
        by_person.setdefault((t.assignee_email or "").strip().lower(), []).append(t)

    briefing_cfg = daily_briefing.get_settings(db)
    leads: dict = {}   # (lead, sender) -> {"rows": [...], "dept": name}
    reminded = 0
    for email, mine in by_person.items():
        if not ticket_notify._is_sendable(db, email):
            continue
        local = (local_now(email) if local_now
                 else _shift_local_now(daily_briefing._person_zone(db, email, briefing_cfg)))
        if local.weekday() >= 5 or not (SEND_FROM <= local.time() < SEND_UNTIL):
            continue
        today = local.date()
        due_now = [(t, _state(t)) for t in mine if t.sla_due_on[:10] <= today.isoformat()]
        if not due_for_reminder([s for _, s in due_now], today):
            continue

        sender = manager_of(db, email)
        rows, escalate = [], []
        for t, s in sorted(due_now, key=lambda p: p[0].sla_due_on):
            due = date.fromisoformat(s["due"])
            s["sent"] += 1
            if due < today:
                s["overdue"] += 1
            s["on"] = today.isoformat()
            t.overdue_reminder = dict(s)
            row = {"id": t.id, "code": t.code, "subject": t.subject, "status": t.status,
                   "due": due.strftime("%m/%d/%Y"), "late": business_days(due, today),
                   "assignee": ticket_notify._name_of(db, email)}
            rows.append(row)
            if s["overdue"] > LEAD_AFTER_IGNORED:
                escalate.append((t, row))
        db.commit()   # marked before sending: at most once

        how = _deliver(db, sender=sender, to=email, rows=rows, audience="assignee")
        reminded += 1
        for t in (t for t, _ in due_now):
            log_activity(db, type="overdue_reminder", actor_email="system", entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail=f"Overdue reminder sent to {email} ({how})")
        for t, row in escalate:
            lead, dept_name = _lead_of(db, t)
            if not lead:
                log_activity(db, type="notify_gap", actor_email="system", entity_kind="ticket",
                             entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                             detail="Overdue with no department lead set - the lead reminder was not sent")
            elif lead != email:
                g = leads.setdefault((lead, sender), {"rows": [], "dept": dept_name})
                g["rows"].append(row)
        db.commit()

    for (lead, sender), g in leads.items():
        if not ticket_notify._is_sendable(db, lead):
            continue
        how = _deliver(db, sender=sender, to=lead, rows=g["rows"], audience="lead", dept_name=g["dept"])
        reminded += 1
        for row in g["rows"]:
            log_activity(db, type="overdue_reminder", actor_email="system", entity_kind="ticket",
                         entity_id=row["id"], entity_code=row["code"], entity_title=row["subject"],
                         detail=f"Overdue reminder sent to the department lead {lead} ({how})")
        db.commit()
    return reminded
