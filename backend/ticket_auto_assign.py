"""Default assignee for new tickets (Oct 2026).

A new ticket that nobody assigned goes straight to the right person instead
of waiting in the unassigned pool for the IT Admin desk to hand it out.

Where the person comes from, first match wins:
  1. the ticket's help topic (`application`, a curated topic in
     ticket_taxonomy's helpTopics) - its `defaultAssignees[company_id]`;
  2. the ticket's department (TicketDepartment.default_assignee_email);
  3. nobody - today's behavior: the ticket waits unassigned and the desk is
     told (routers/tickets.py _notify_triage).

Only ever applied when the creator did not choose an assignee, and only at
two moments: create_ticket for a ticket that needs no approval, and
decide_approval's approve path for one that did (a ticket awaiting approval
can never be assigned - the gate would be decoration). Recategorizing a
ticket later never reassigns it, and tickets created by maintenance
services / walkthroughs carry their own explicit assignment and never pass
through here.

The person must still be an active desk agent of the ticket's company when
the ticket arrives (validated on save too, but people leave and roles
change): on the People list, staff, able to work the queue
(ticket_roles.can_work_queue) and inside the ticket's company wall. A
default that no longer qualifies is skipped - the next level is tried - and
an `auto_assign_gap` line goes on the ticket's history so the gap is seen
and fixed, rather than tickets silently piling up unassigned.
"""
from sqlalchemy import func
from sqlalchemy.orm import Session

import models
import ticket_sla
import ticket_taxonomy
from routers.task_util import log_activity, now_iso


def desk_agent_for(db: Session, email: str, company_id: str) -> bool:
    """Is `email` an active desk agent who can work a ticket of `company_id`?
    Fails closed - an unknown or broken record is not an agent."""
    import auth
    import ticket_roles
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        return False
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    if emp is None or (emp.status or "") in ("offboarded", "inactive") or (getattr(emp, "deleted_at", "") or ""):
        return False
    if (emp.identity_type or "") in ("guest", "external"):
        return False
    try:
        rec = auth._external_record(email) or {}
        who = {"email": email, "level": auth.level_for(email, db), "external": bool(rec.get("external"))}
        if not ticket_roles.can_work_queue(who, db):
            return False
        return auth.company_ok(company_id or "", auth.company_scope(who, db))
    except Exception:
        return False


def not_agent_reason(db: Session, email: str, company_name: str = "") -> str:
    """The sentence a settings save is refused with."""
    where = f" for {company_name}" if company_name else ""
    return f"{email} is not an active ticket desk agent{where} - pick someone who works this company's tickets."


def _name(db: Session, email: str) -> str:
    from ticket_notify import _name_of
    return _name_of(db, email) or email


def _dept_name(db: Session, dept_id: str) -> str:
    if not dept_id:
        return ""
    d = db.query(models.HrDepartment).filter(models.HrDepartment.id == dept_id).first()
    if d:
        return d.name or ""
    s = db.query(models.TicketDepartment).filter(models.TicketDepartment.id == dept_id).first()
    return (s.name or "") if s else ""


def candidates(db: Session, t: models.TaskTicket) -> list:
    """[(email, source, label)] in resolution order - source is "help topic"
    or "department", label the topic / department name."""
    out = []
    company = t.company_id or ""
    dept_name = _dept_name(db, t.hr_department_id or "")
    topic = ticket_taxonomy.topic_entry(db, t.application or "", dept_name)
    if topic and company:
        email = ((topic.get("defaultAssignees") or {}).get(company) or "").strip().lower()
        if email:
            out.append((email, "help topic", topic.get("name") or t.application or ""))
    if t.hr_department_id:
        row = db.query(models.TicketDepartment).filter(models.TicketDepartment.id == t.hr_department_id).first()
        email = ((getattr(row, "default_assignee_email", "") or "") if row else "").strip().lower()
        if email:
            out.append((email, "department", dept_name))
    return out


def apply(db: Session, t: models.TaskTicket, actor_email: str) -> str:
    """Assign an unassigned, workable ticket to its default assignee, if it
    has one who still qualifies. Writes the assignment, the status move
    (assigned Open = In Progress, through ticket_sla.set_status), the history
    line and any gap lines. Does NOT notify - the caller sends the same
    notices a manual assignment sends (routers/tickets.py
    _announce_auto_assignment). Returns the email assigned, or "". Does not
    commit."""
    if (t.assignee_email or "").strip():
        return ""
    if (t.approval_status or "none") in ("pending", "rejected"):
        return ""
    if (t.status or "") not in ("open", "new", "reopened"):
        return ""
    actor = (actor_email or "").strip().lower()
    for email, source, label in candidates(db, t):
        if desk_agent_for(db, email, t.company_id or ""):
            t.assignee_email = email
            t.assigned_by_email = ""   # nobody handed it over - see the history line
            ticket_sla.set_status(t, "in_progress")
            t.modified_at = now_iso()
            log_activity(db, type="auto_assigned", actor_email=actor, entity_kind="ticket",
                         entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                         detail=f"Assigned to {_name(db, email)} automatically ({source}: {label})")
            return email
        log_activity(db, type="auto_assign_gap", actor_email=actor, entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=(f"Not assigned to {_name(db, email)} automatically ({source}: {label}) - "
                             "they are no longer an active desk agent for this company. "
                             "Update the default assignee in Settings > Ticket Manager."))
    return ""
