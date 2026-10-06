"""Ticket Module - router.

Split out of `task_config.py` (Jul 2026) so tickets own their own file. Routes,
payloads and behaviour are unchanged - only the file they live in moved.

Covers: tickets CRUD, per-ticket conversation/attachments/activity, saved ticket
views, components, ticket-to-ticket links, escalation, the company/department
lookups used at intake, the approval gate, and the triage routing that notifies
the IT Admin desk when an unassigned ticket arrives.

Ticket conversation/attachments/activity deliberately reuse the task comment and
attachment tables, keyed by ticket id - same storage, separate router.
"""
import json
import re
import html as html_lib
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any

import models
from database import get_db
from auth import get_current_user, require_manager, require_any_module_grant
from routers.task_util import now_iso, gen_id, log_activity, task_notify, extract_mentions
from ticket_code import TICKET_CODE_DIGITS, ticket_no
from ticket_notify import (notify_ticket_event, get_settings as get_notify_settings,
                           save_settings as save_notify_settings, ticket_agents, all_agents,
                           _name_of)
import ticket_taxonomy
import ticket_mail_templates as tmpl
from app_url import app_url

router = APIRouter(tags=["Tickets"], dependencies=[Depends(get_current_user)])

# The service desk - working the queue, editing anyone's ticket, running the
# desk's settings - is grant-driven like every other module (503f052).
#
# It is NOT the whole router, though, and that is the distinction this file has
# to keep. Support is a company-wide self-service surface: raising a ticket,
# reading your own, and filling in the form that submits one. An Access Group
# decides who WORKS the queue, not who may ASK for help - a help desk an
# employee cannot file a ticket with is the one thing it must never be. Put
# behind the whole router, the grant 403'd /task-tickets?mine=true ("You don't
# have access to this screen" on the Support page) and /ticket-departments ("No
# departments to choose from" in the submit form) for every employee without a
# tasks or tickets grant.
#
# So: agent endpoints carry `require_ticket_desk` explicitly, and the
# requester-facing ones stay open to any signed-in user and are SCOPED
# server-side instead - see list_tickets and _require_ticket_participant. Scoped,
# not trusted: `mine=true` decided in the browser would be one query parameter
# away from the whole company's queue.
require_ticket_desk = require_any_module_grant("tasks", "tickets")


# ── SLA policy - the due date is DERIVED from priority, not chosen freely.
# Target hours are admin-configurable (ticket_taxonomy.py, Sep 2026 - was a
# hardcoded dict here, mirrored by a second hardcoded copy in
# frontend/src/tickets/ticketMeta.js that the two had to be kept in step by
# hand). The server is authoritative and there is no override path at all
# (Sep 17 2026 - there used to be one, via the drawer's own DateField editor):
# create_ticket always computes its own value, never trusting body.sla_due_on,
# and update_ticket recomputes it whenever priority changes to a new value,
# full stop. See main.py's startup backfill for tickets that predate this
# column ever being populated. ──

def _sla_due_from_priority(db: Session, created_at_iso: str, priority: str) -> str:
    """created_at + the priority's target hours, as a YYYY-MM-DD date string -
    sla_due_on is stored and compared as a plain date everywhere else (see
    _sla_breached, ticket_to_dict), never a datetime."""
    try:
        start = datetime.fromisoformat((created_at_iso or now_iso()).replace("Z", "+00:00"))
    except ValueError:
        start = datetime.fromisoformat(now_iso())
    hours = ticket_taxonomy.sla_hours(db, priority)
    return (start + timedelta(hours=hours)).date().isoformat()


def _has_desk_grant(user: dict, db: Session) -> bool:
    """Whether this caller may see the desk side. The dependency form raises;
    this is the boolean the scoped endpoints branch on."""
    from auth import _grants_for, _LEVELS, _MODULE_LEVEL_RANK
    # External (B2B guest) users are NEVER desk agents, whatever their grant
    # level says - the unscoped list is the whole company's queue. Their grant
    # opens the module; here they stay participants-only (their own tickets).
    if user.get("external"):
        return False
    if user.get("level", 0) >= _LEVELS["administrator"]:
        return True
    grants = _grants_for(user.get("email") or "", db)
    return any(grants.get(m, 0) >= _MODULE_LEVEL_RANK["viewer"] for m in ("tasks", "tickets"))


def _require_ticket_participant(db: Session, user: dict, t) -> None:
    """A ticket's own requester/watchers/assignee may read and comment on it
    without any module grant - it is their support request. Everyone else needs
    the desk grant."""
    import auth   # company wall: another company's ticket is 404 (before any grant)
    auth.assert_company(getattr(t, "company_id", "") or "", user, db)
    if _has_desk_grant(user, db):
        return
    if (user.get("email") or "").lower() in _ticket_participants(t):
        return
    raise HTTPException(403, "You don't have access to this ticket")


def _nz(v):
    return v if v not in ("", None) else None


# Saved ticket views reuse the task saved-view table (scope='ticket'). The body
# model is defined here rather than imported so this router has no dependency on
# the task module.
class SavedViewBody(BaseModel):
    id: Optional[str] = None
    name: str
    filters: Optional[Any] = None


def saved_view_to_dict(s: models.TaskSavedView) -> dict:
    return {"id": s.id, "name": s.name, "ownerEmail": s.owner_email or "",
            "scope": s.scope or "task", "filters": s.filters or {},
            "createdAt": s.created_at or ""}


# ── Saved TICKET views (same table, scope='ticket'; filters hold the ticket
#    filter set: {scope,status,priority,type,component,serviceArea,sla,search,
#    groupBy,view}) - a free-form JSON blob, so a new filter needs no migration ──
@router.get("/task-ticket-views", dependencies=[Depends(require_ticket_desk)])
def list_ticket_views(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.TaskSavedView)
            .filter(models.TaskSavedView.owner_email == user["email"].lower(),
                    models.TaskSavedView.scope == "ticket").all())
    return [saved_view_to_dict(s) for s in rows]


@router.post("/task-ticket-views", status_code=201, dependencies=[Depends(require_ticket_desk)])
def create_ticket_view(body: SavedViewBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    s = models.TaskSavedView(id=body.id or gen_id(), owner_email=user["email"].lower(), name=body.name,
                             view=body.view or "list", filters=body.filters or {}, sort=body.sort or {},
                             group=body.group or "none", scope="ticket", created_at=now_iso())
    db.add(s)
    db.commit()
    db.refresh(s)
    return saved_view_to_dict(s)


@router.delete("/task-ticket-views/{view_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket_view(view_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    # A saved view is its owner's. This used to delete any row by id - any
    # desk agent could remove a colleague's views, or a TASK saved view (same
    # table) - so it is now confined to the caller's own ticket views. Someone
    # else's view, or one that is not a ticket view, reads as not found.
    v = (db.query(models.TaskSavedView)
         .filter(models.TaskSavedView.id == view_id,
                 models.TaskSavedView.owner_email == (user.get("email") or "").lower(),
                 models.TaskSavedView.scope == "ticket").first())
    if not v:
        raise HTTPException(404, "Saved view not found")
    db.delete(v)
    db.commit()



# ── Tickets ──────────────────────────────────────────────────────────────────
def ticket_to_dict(t: models.TaskTicket) -> dict:
    return {"id": t.id, "code": t.code or "", "subject": t.subject, "description": t.description or "",
            "type": t.type or "request",
            "status": t.status if (t.status and t.status != "new") else "open", "priority": t.priority or "medium",
            "requesterId": _nz(t.requester_email), "assigneeId": _nz(t.assignee_email),
            "createdById": _nz(t.created_by_email),
            "assignedById": _nz(t.assigned_by_email),
            "departmentId": _nz(t.department_id), "companyId": _nz(t.company_id), "hrDepartmentId": _nz(t.hr_department_id),
            "linkedTaskId": _nz(t.linked_task_id),
            "tags": t.tags or [], "images": t.images or [], "watcherIds": t.watcher_emails or [],
            "resolution": _nz(t.resolution),
            "customFieldValues": t.custom_field_values if isinstance(t.custom_field_values, dict) else {},
            "typeFields": t.type_fields if isinstance(t.type_fields, dict) else {},
            "links": t.links if isinstance(t.links, list) else [],
            "taskIds": t.task_ids if isinstance(t.task_ids, list) else [],
            "component": _nz(t.component),
            "application": _nz(t.application), "serviceArea": _nz(t.service_area),
            "csatRating": t.csat_rating or 0, "csatComment": _nz(t.csat_comment),
            "approvalStatus": t.approval_status or "none", "approverId": _nz(t.approver_email),
            "approvalNote": _nz(t.approval_note), "approvalDecidedAt": _nz(t.approval_decided_at),
            "slaDueOn": _nz(t.sla_due_on), "resolvedAt": _nz(t.resolved_at),
            "lastCommentAt": _nz(t.last_comment_at),
            "requesterUpdateAt": _nz(t.requester_update_at), "requesterSeenAt": _nz(t.requester_seen_at),
            "resolutionNote": _nz(t.resolution_note),
            "createdAt": t.created_at or "", "modifiedAt": t.modified_at or ""}


# ── Latest comment (the list's last column - Neil, Oct 1 2026) ───────────────
# The most recent reply on each ticket, so the queue can be read without
# opening every row. ONE query for the whole list, never one per ticket: the
# newest created_at per ticket in a grouped subquery, joined back for the row.
# Joined to task_tickets because the comment table is shared with tasks.
#
# Internal notes never leave the desk. `internal_ok=False` drops them BEFORE
# the "newest" is picked (so a public reply older than an internal note still
# shows, rather than nothing); list_tickets only asks for internal ones for a
# caller who would see them in the drawer too (same rule as
# list_ticket_comments) - a requester always gets the public thread only.
def _latest_comments(db: Session, internal_ok: bool, ticket_id: str | None = None) -> dict:
    C = models.TaskComment

    def _scoped(q):
        if not internal_ok:
            q = q.filter((C.internal.is_(False)) | (C.internal.is_(None)))
        if ticket_id is not None:
            q = q.filter(C.task_id == ticket_id)
        return q

    newest = _scoped(db.query(C.task_id.label("tid"), func.max(C.created_at).label("mx"))
                     .join(models.TaskTicket, models.TaskTicket.id == C.task_id)
                     ).group_by(C.task_id).subquery()
    rows = _scoped(db.query(C.task_id, C.author_email, C.body, C.created_at, C.internal)
                   .join(newest, (C.task_id == newest.c.tid) & (C.created_at == newest.c.mx))).all()
    out: dict = {}
    for tid, author, body, created, internal in rows:
        if tid in out:   # two replies in the same instant - either is "the latest"
            continue
        out[tid] = {"authorId": _nz((author or "").lower()), "preview": _comment_preview(body or "", 160),
                    "createdAt": created or "", "internal": bool(internal)}
    return out


def _sees_internal(db: Session, t: models.TaskTicket, user: dict, desk: bool) -> bool:
    """list_ticket_comments' rule, per ticket: the desk sees internal notes,
    except on a ticket they raised themselves (unless they work it or are a
    manager)."""
    if not desk:
        return False
    email = (user.get("email") or "").lower()
    return (email != (t.requester_email or "").lower()
            or email == (t.assignee_email or "").lower()
            or _ticket_privileged(db, t, user))


def _with_latest_comment(db: Session, t: models.TaskTicket, user: dict, d: dict) -> dict:
    """One ticket's dict with its latestComment - for update_ticket's reply,
    which replaces the row in the list (it would otherwise blank the column)."""
    internal_ok = _sees_internal(db, t, user, _has_desk_grant(user, db))
    d["latestComment"] = _latest_comments(db, internal_ok, ticket_id=t.id).get(t.id)
    return d


# ── Approval workflow rules ──────────────────────────────────────────────────
# Which types are gated is an admin switch per type (Sep 2026) - the
# `requiresApproval` flag in the ticket taxonomy config, read through
# ticket_taxonomy.requires_approval(). It used to be a hardcoded set here; the
# defaults (ticket_taxonomy.DEFAULT_APPROVAL_TYPES) are exactly that old set,
# so nothing changed on deploy. Everything not gated goes straight to the
# fulfillment queue.
#
# The switch is consulted ONLY where the gate is decided - create_ticket, and
# update_ticket when a ticket is re-typed. The decision lands on the ticket as
# approval_status, and everything downstream (request_approval,
# decide_approval, the assignment block, the "To Route" / "To Approve" queues,
# ticket_notify, the daily briefing) keys off that stored status, never off
# the type. So flipping the switch affects new tickets only: one already
# waiting for approval stays pending, one already approved/rejected keeps its
# decision, and one that was never gated stays ungated.

# Legacy: tickets raised before the IT Admin flow captured an approver in a
# per-type intake field. Nothing writes or reads these now - the fields are
# retired (ticketMeta.intakeFields) and an IT Admin names the approver instead.
# Kept only so the historical values on old tickets stay identifiable.
APPROVER_FIELD_BY_TYPE = {
    "service_request": "approver",
    "change_request":  "approver",
    "access_request":  "managerApproval",
}


def _type_label(type_: str) -> str:
    """"access_request" -> "Access Request", for activity-log copy."""
    return (type_ or "").replace("_", " ").title() or "-"


# ── Audit snapshot ───────────────────────────────────────────────────────────
# The "created" activity entry's `detail` holds a JSON snapshot of exactly what
# was submitted, instead of a plain "created this ticket" line - Pranshu, Sept 8
# 2026: once a requester's mistake gets corrected by whoever picks the ticket
# up, there is otherwise no record of what the ORIGINAL submission actually
# said. Kept as raw values, not pre-formatted text - the frontend already owns
# every label lookup this needs (type/priority names, department/company
# names, per-field question labels) and re-derives them the same way the
# Overview tab does, so the two can never drift onto different wording. A row
# logged before this change just has the old plain-text detail; the frontend
# falls back to showing that verbatim when it isn't valid JSON.
def _ticket_snapshot(t: "models.TaskTicket") -> dict:
    return {
        "subject": t.subject or "", "description": t.description or "",
        "type": t.type or "", "priority": t.priority or "",
        "application": t.application or "", "serviceArea": t.service_area or "",
        "hrDepartmentId": t.hr_department_id or "", "companyId": t.company_id or "",
        "typeFields": t.type_fields or {},
    }


def _sla_breached(t: "models.TaskTicket") -> bool:
    """Mirrors slaState() in ticketMeta.js: no due date, or the ticket is
    already resolved/closed, is never "breached" - a due date is only a
    promise while the clock is still running."""
    if not t.sla_due_on or t.status in ("resolved", "closed"):
        return False
    return t.sla_due_on < now_iso()[:10]


def _fmt_audit_value(v: Any) -> str:
    """Stringifies a field-change value for the activity log - lists/dicts
    (multiselect, checklist answers) get a compact readable form rather than
    Python's repr, and everything is capped so one huge free-text answer can't
    dwarf the rest of the feed."""
    if v is None or v == "":
        return "(blank)"
    if isinstance(v, list):
        s = ", ".join(str(x) for x in v) if v else "(blank)"
    elif isinstance(v, dict):
        s = ", ".join(f"{k}: {x}" for k, x in v.items()) if v else "(blank)"
    else:
        s = str(v)
    return s if len(s) <= 140 else s[:137] + "…"


_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _comment_preview(body: str, limit: int = 140) -> str:
    """Plain-text teaser of a rich-text comment body for the activity feed -
    tags stripped, entities unescaped, collapsed to one line, capped the same
    way _fmt_audit_value caps a field-change value. Without this the activity
    row just said "commented" with no way to tell what was said short of
    opening the Conversation tab separately (Pranshu, Sept 8 2026)."""
    text = re.sub(r"\s+", " ", html_lib.unescape(_HTML_TAG_RE.sub(" ", body or ""))).strip()
    if not text:
        return "(no text)"
    return text if len(text) <= limit else text[:limit - 1] + "…"


def service_area_for(db: Session, application: str) -> str:
    """The service area a ticket about `application` belongs to.

    Looked up on the External Links directory (the rebuilt start.greensglobal
    .com), which is where an admin classifies an app - once, on the same screen
    where the app is added. Matched on the link NAME because that is what the
    ticket stores; a name that matches nothing (including the intake form's
    "Other / not listed") is General, never blank, so every ticket is
    reportable and none of them fall out of a service-area breakdown.

    Blank application -> blank area: a ticket that never named an app has no
    area to speak of, and "general" would claim it had been categorised.
    """
    name = (application or "").strip()
    if not name:
        return ""
    # The curated "What do you need help with?" topics (ticket_taxonomy
    # helpTopics) carry their own area - Plumbing is Buildings & Maintenance
    # whether or not anything in External Links is called that.
    topic_area = ticket_taxonomy.topic_area(db, name)
    if topic_area:
        return topic_area
    row = (db.query(models.ExternalLink.service_area)
           .filter(func.lower(models.ExternalLink.name) == name.lower())
           .first())
    return (row[0] or "general") if row else "general"


def _it_admins(db: Session, company_id: str | None = None) -> list:
    """The service desk - who new tickets are announced to.

    Chosen in Ticket -> Manage (ticket_agents). Multi-company desks (Aug 2026):
    pass a ticket's `company_id` to scope to that company's roster (falling
    back to the flat list, then administrators - see ticket_agents). Without
    one, "irrespective of departments" still holds within whichever roster
    applies: one desk per company sees everything that comes in for it,
    decides what needs approval, and hands the work out."""
    return [e for e in (ticket_agents(db, company_id=company_id) or []) if e]


def _on_desk(db: Session, user: dict) -> bool:
    """Is this person actually ON the service desk roster - any company's?

    Membership, nothing else - an administrator who was not picked in Manage is
    not on the desk. This is what decides whether the desk QUEUES are somebody's
    work, and it has to agree with who gets the bells: an off-desk admin who
    stops being notified about new tickets must also stop being shown a queue
    telling them to assign those tickets.

    Deliberately the UNION across every company's roster (all_agents), not one
    company's: this check has no single ticket to scope to, and queues are not
    filtered by company - a Greens India agent still needs the desk queues
    visible to reach the India tickets in them, even though per-ticket EMAIL
    routing (ticket_agents with a company_id) would not page them for a
    Greens US ticket."""
    email = (user.get("email") or "").strip().lower()
    return email in {e.lower() for e in all_agents(db)}


def _is_agent(db: Session, user: dict) -> bool:
    """May this person ACT on the desk - route a ticket for approval?

    On the roster, OR an administrator. Administrators are kept in deliberately:
    they are the people who edit the roster, and a desk configured with a typo
    (or staffed by someone who has since left) must not lock the ticket system
    away from the only people who can fix it.

    Deliberately NOT the same question as _on_desk. Permission is "may you step
    in", membership is "is this your queue" - using one boolean for both put the
    desk queues back in front of every administrator the moment a roster was
    configured, which is the opposite of what configuring one is for."""
    if user.get("level", 1) >= 4:                       # administrator/owner
        return True
    return _on_desk(db, user)


def _notify_triage(db: Session, t: models.TaskTicket, actor: str,
                   title: str = "New ticket to assign") -> None:
    """Tell the IT Admin pool an unassigned ticket is waiting to be handed out.

    Called at creation for tickets needing no approval, and again once an
    approval is granted - without this an unassigned ticket notifies nobody who
    can act on it and simply sits."""
    if t.assignee_email:
        return
    tk_action = {"view": "tickets", "label": "View ticket"}
    for em in dict.fromkeys(e.lower() for e in _it_admins(db, t.company_id)):
        if em == actor:
            continue   # they raised/approved it themselves; they can already see it
        task_notify(db, kind="ticket_needs_assignment", for_email=em,
                    title=title, body=f"{ticket_no(t.code)} · {t.subject}", ticket_id=t.id, nexus_action=tk_action)


class TicketBody(BaseModel):
    id: Optional[str] = None
    code: Optional[str] = None
    subject: str
    description: Optional[str] = ""
    type: Optional[str] = "request"
    status: Optional[str] = "open"
    priority: Optional[str] = "medium"
    requester_email: Optional[str] = ""
    assignee_email: Optional[str] = ""
    department_id: Optional[str] = ""
    company_id: Optional[str] = ""
    hr_department_id: Optional[str] = ""
    linked_task_id: Optional[str] = ""
    tags: Optional[list] = None
    images: Optional[list] = None
    watcher_emails: Optional[list] = None
    resolution: Optional[str] = ""
    custom_field_values: Optional[dict] = None
    type_fields: Optional[dict] = None
    component: Optional[str] = ""
    # What the ticket is about. `service_area` is NOT accepted here - it is
    # derived from this application server-side, so a client cannot file a
    # ticket into a category its application does not belong to.
    application: Optional[str] = ""
    # Accepted for backward compatibility but ignored - see create_ticket,
    # which always derives it from priority server-side now.
    sla_due_on: Optional[str] = ""
    # Convert to Ticket (Neil, 10/05): the task this ticket was raised from.
    # The ticket links back to it and takes its files; the task gets a note
    # pointing at the ticket, and is closed when close_source_task is set.
    from_task_id: Optional[str] = ""
    close_source_task: Optional[bool] = False


class TicketUpdate(BaseModel):
    subject: Optional[str] = None
    description: Optional[str] = None
    type: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    assignee_email: Optional[str] = None
    department_id: Optional[str] = None
    company_id: Optional[str] = None
    hr_department_id: Optional[str] = None
    linked_task_id: Optional[str] = None
    tags: Optional[list] = None
    images: Optional[list] = None
    watcher_emails: Optional[list] = None
    resolution: Optional[str] = None
    custom_field_values: Optional[dict] = None
    type_fields: Optional[dict] = None
    task_ids: Optional[list] = None
    component: Optional[str] = None
    # Re-picking the application on an existing ticket re-derives the service
    # area (see update_ticket); service_area is also settable on its own so the
    # desk can correct a mis-mapped app without changing what the ticket is about.
    application: Optional[str] = None
    service_area: Optional[str] = None
    csat_rating: Optional[int] = None
    csat_comment: Optional[str] = None
    # What was done - required whenever a ticket moves into Resolved/Closed
    # (see update_ticket).
    resolution_note: Optional[str] = None
    sla_due_on: Optional[str] = None
    resolved_at: Optional[str] = None
    # Not a ticket column - used only to build the "Reopened" notification's
    # "Reason" line and its activity-log entry, then discarded.
    reopen_reason: Optional[str] = None
    # A reply written in the drawer alongside the field edits. The drawer holds
    # every change until Done and sends them as ONE save (Pranshu, Oct 1: "till
    # the time I click on Done it should not update the ticket, nor post the
    # mail or message to the requester") - so the requester gets one email and
    # one Teams message for the whole visit, not one per field and a second one
    # for the reply. Not columns: recorded as a comment row, then discarded.
    comment: Optional[str] = None
    comment_internal: Optional[bool] = None


def _next_ticket_code(db: Session) -> str:
    """One past the highest number issued so far.

    Was `count() + 1`, which is only correct while nothing is ever deleted:
    delete any ticket and the next one issued reuses a live number, so two
    tickets share a code and every reference to it becomes ambiguous. Counting
    what exists answers "how many", not "what comes next".

    Legacy "TKT-nnn" codes are read for their digits too, so the sequence
    continues past them rather than restarting into numbers already in use."""
    highest = 0
    # include_deleted: a deleted ticket keeps its number (it can be restored),
    # so the sequence must never hand that number out again.
    for (code,) in db.query(models.TaskTicket.code).execution_options(include_deleted=True).all():
        digits = "".join(ch for ch in (code or "") if ch.isdigit())
        if digits:
            highest = max(highest, int(digits))
    return f"{highest + 1:0{TICKET_CODE_DIGITS}d}"


def _ticket_participants(t: models.TaskTicket) -> set:
    """Everyone who should hear about ticket activity: watchers + assignee +
    requester (all lower-cased, empties dropped)."""
    people = set(e.lower() for e in (t.watcher_emails or []) if e)
    for e in (t.assignee_email, t.requester_email):
        if e:
            people.add(e.lower())
    return people


# What a requester's bell names when a save changes these (update_ticket's
# audit kinds -> plain words).
_REQUESTER_FIELD_LABELS = (
    ("subject_changed", "title"), ("description_changed", "description"),
    ("department_changed", "department"), ("company_changed", "company"),
    ("application_changed", "application"), ("service_area_changed", "service area"),
    ("field_changed", "request details"), ("resolution_changed", "resolution"),
    ("resolution_note", "resolution"),
)


def _and_list(words: list) -> str:
    """["title", "department"] -> "title and department"."""
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def _tell_requester(db: Session, t: models.TaskTicket, actor_email: str, what: str) -> None:
    """One bell to the requester about a change someone else made (Oct 1:
    "any update on their tickets"). Their own changes never bell them."""
    requester = (t.requester_email or "").lower()
    if requester and requester != (actor_email or "").lower():
        task_notify(db, kind="ticket_updated", for_email=requester, title="Your ticket was updated",
                    body=f"{ticket_no(t.code)} · {t.subject} - {what}"[:500], ticket_id=t.id,
                    nexus_action={"view": "tickets", "label": "View ticket"})


def _notify_participants(db: Session, t: models.TaskTicket, actor_email: str, kind: str,
                         title: str, body: str, exclude: set | None = None):
    """Notify a ticket's participants (watchers/assignee/requester) except the actor
    and anyone in `exclude` (e.g. the requester, for internal notes)."""
    action = {"view": "tickets", "label": "View ticket"}
    skip = {(actor_email or "").lower()} | {e.lower() for e in (exclude or set())}
    for email in _ticket_participants(t):
        if email in skip:
            continue
        task_notify(db, kind=kind, for_email=email, title=title, body=body, ticket_id=t.id, nexus_action=action)


def _deliver_teams_dm(row_id: str) -> None:
    """One delivery attempt for a queued ticket DM, run as a background task
    (after the response) on its own session. Failures stay queued for
    ticket_teams_post_loop's sweep."""
    from database import SessionLocal
    db = SessionLocal()
    try:
        row = db.query(models.TicketTeamsMessage).filter(models.TicketTeamsMessage.id == row_id).first()
        if row is not None and not row.sent:
            import teams_post
            teams_post.deliver_ticket_row(db, row)
    except Exception:
        pass   # queued; the sweep owns it now
    finally:
        db.close()


def _queue_requester_teams_dm(db: Session, t: models.TaskTicket, actor_email: str, *,
                              assigned: bool = False, closed: bool = False,
                              comment: str = "") -> "models.TicketTeamsMessage | None":
    """Queue a Teams DM to the ticket's requester - same guaranteed-delivery
    queue TimeBod posts use (teams_post.py), posted AS the agent who made the
    change into a 1:1 chat Graph creates on first contact.

    Only three things are worth a Teams message (Neil, Oct 1 2026, after
    Ankush's requester got one every time he touched her ticket): the ticket
    was ASSIGNED (`assigned` - names the assignee), a public REPLY from
    someone else (`comment` - the text itself, not "your ticket was
    updated"), or it was RESOLVED / CLOSED (`closed` - with the resolution
    note). Status moves, priority, field edits and opening the ticket send
    nothing. A save carrying several of them is ONE message
    (tmpl.requester_teams_dm_html), and nothing to say queues nothing.
    Skipped when the actor IS the requester (their own change needs no DM) or
    there's no requester on file (never happens in practice, but a queued row
    with an empty requester_email would just fail Graph forever).

    Returns the queued row (or None if skipped) so the caller can make the
    same inline delivery attempt the BOD/EOD queue makes in timeclock.py's
    /bod endpoint - without it, a DM only goes out on ticket_teams_post_loop's
    sweep, which skips rows younger than SWEEP_MIN_AGE_SEC and only runs every
    RETRY_EVERY_SEC (3 min) - a 2-5 minute delay on every ticket update
    instead of landing with the update (Pranshu, Sep 17 2026)."""
    requester = (t.requester_email or "").strip().lower()
    actor = (actor_email or "").strip().lower()
    if not requester or requester == actor:
        return None
    html = tmpl.requester_teams_dm_html(
        code=t.code, subject=t.subject, link=tmpl._ticket_url(app_url(), t.id, for_requester=True),
        actor_name=_name_of(db, actor),
        assigned_to=(_name_of(db, t.assignee_email)
                     if assigned and t.assignee_email and t.assignee_email.lower() != requester else ""),
        closed_status=t.status if (closed and t.status in ("resolved", "closed")) else "",
        resolution_note=t.resolution_note or "", comment=comment or "")
    if not html:
        return None
    row = models.TicketTeamsMessage(id=gen_id(), ticket_id=t.id, agent_email=actor,
                                     requester_email=requester, html=html, created_at=now_iso())
    db.add(row)
    return row


@router.get("/task-tickets")
def list_tickets(mine: bool = False, user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """`mine=true` narrows to just the tickets THIS person raised - what the
    Support page's "My Open Tickets" needs. Being cc'd on someone else's
    ticket (mentioned in a comment, added as a watcher) does not make it
    "mine": that list showing a ticket Ankush raised, just because Pranshu
    was watching it, read as a gap in the requester scoping, not a feature
    (Pranshu, Sep 10 2026).

    Without `mine`, an employee who lacks the desk grant still gets scoped
    automatically rather than seeing the whole company's queue - but a little
    more generously, raised OR watching, so they can still reach a ticket
    they're only mentioned on from wherever their own Tickets/Tasks context
    surfaces it.

    Scoped server-side rather than filtered in the browser: the unscoped list is
    the agent queue and carries every ticket in the company, so a client-side
    filter would still ship all of them to an employee's browser. Default is
    unchanged, so the Tickets module is unaffected."""
    rows = db.query(models.TaskTicket).all()
    # Company wall (Aug 2026): once armed, the desk queue is confined to the
    # caller's own companies - a ticket carries the requester's company_id, and a
    # Global Admin (scope None) still sees them all. Off = unchanged.
    import auth
    _cscope = auth.company_scope(user, db)
    if _cscope is not None:
        rows = [t for t in rows if (t.company_id or "") in _cscope]
    me = (user.get("email") or "").lower()
    if mine:
        # Raised by me, or raised by me on someone else's behalf (Oct 1) - the
        # person who filed it still needs to find it. Being cc'd is not enough.
        rows = [t for t in rows if (t.requester_email or "").lower() == me
                or (t.created_by_email or "").lower() == me]
    # Without the desk grant the scope is forced, not requested: the unscoped
    # list IS the agent queue, so honouring `mine` only when asked would leave
    # the whole company's tickets one query parameter away from any employee.
    elif not _has_desk_grant(user, db):
        rows = [t for t in rows
                if (t.requester_email or "").lower() == me
                or me in [(w or "").lower() for w in (t.watcher_emails or [])]]
    # Latest comment per ticket - at most two queries for the whole list (the
    # public thread, plus the full one only when the caller is on the desk).
    desk = _has_desk_grant(user, db)
    public_latest = _latest_comments(db, internal_ok=False)
    any_latest = _latest_comments(db, internal_ok=True) if desk else public_latest
    out = []
    for t in rows:
        d = ticket_to_dict(t)
        d["latestComment"] = (any_latest if _sees_internal(db, t, user, desk) else public_latest).get(t.id)
        out.append(d)
    return out


def _valid_requester(db: Session, user: dict, requested: str | None) -> str:
    """Who a new ticket is for: the caller, unless they named someone else.

    Someone else must be a real person on the Nexus People list - the same
    rule /myhr/directory (the picker the form offers) applies: a work mailbox,
    not offboarded, and inside the caller's companies once the company walls
    are armed. Guest/external identities are offered to nobody by that picker,
    so only the desk may still name one (an agent logging a partner's call).
    A typo or a made-up address is refused rather than silently swapped for
    the caller: the person filing meant somebody, and quietly filing it as
    their own would send every update to the wrong inbox."""
    me = (user.get("email") or "").strip().lower()
    email = (requested or "").strip().lower()
    if not email or email == me:
        return me
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    ok = (emp is not None and (emp.status or "") != "offboarded"
          and not (getattr(emp, "deleted_at", "") or ""))
    if ok and (emp.identity_type or "") in ("guest", "external") and not _has_desk_grant(user, db):
        ok = False
    if ok:
        import auth
        scope = auth.company_scope(user, db)
        if scope is not None and (emp.company or "") not in scope:
            ok = False
    if not ok:
        raise HTTPException(400, "The requester must be someone on the Nexus People list.")
    return email


def _with_creator(watchers: list | None, requester: str | None, creator: str) -> list:
    """The payload's watchers, plus whoever filed the ticket when it is for
    somebody else - so the person who raised it on a colleague's behalf can
    still open it, follow the thread and hear about it (a watcher is a
    participant: _require_ticket_participant, list_tickets)."""
    out = [w for w in (watchers or []) if w]
    me = (creator or "").strip().lower()
    if me and me != (requester or "").strip().lower() and me not in {(w or "").lower() for w in out}:
        out.append(me)
    return out


@router.post("/task-tickets", status_code=201)
def create_ticket(body: TicketBody, background_tasks: BackgroundTasks,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    # Anyone signed in may raise a ticket - that is the whole point of a help
    # desk - and, since Oct 1 2026, on someone else's behalf (Neil: the intake
    # form's Requester field, "who is this for", defaults to you and can be
    # anyone on the People list). The requester is who the ticket is FOR: they
    # are notified, see it as theirs, rate and reopen it. The caller is stamped
    # as created_by_email and kept on as a watcher so they can follow it too.
    # It used to be a desk-only move (the requester was silently forced to the
    # caller for everyone else); now it is open to all, so the address is
    # checked against the curated People list instead - see _valid_requester.
    body.requester_email = _valid_requester(db, user, body.requester_email)
    source = _source_task(db, user, body.from_task_id) if body.from_task_id else None
    if source is not None:
        body.linked_task_id = source.id
    # Company on intake (Sep 19, Pranshu: "End user don't have the ability to
    # choose company but here it is showing the ticket is raised for GGcon
    # company"). A desk-grant caller (raising on someone else's behalf, or an
    # agent correcting it) keeps the existing unrestricted override. A plain
    # requester's own choice is only honoured when an admin has actually
    # turned the company field on AND picked that exact company to offer -
    # same never-trust-the-client-alone posture requester_email just got
    # above - otherwise (the setting is off, or off a stray/manipulated
    # value) it silently falls back to their own People-record company,
    # same as before this setting existed.
    company_id = (body.company_id or "").strip()
    if company_id and not _has_desk_grant(user, db):
        cfg = ticket_taxonomy.company_field(db)
        if not (cfg.get("enabled") and company_id in (cfg.get("companyIds") or [])):
            company_id = ""
    company_id = company_id or company_for(db, (body.requester_email or user["email"]))
    t = models.TaskTicket(
        id=body.id or gen_id(), code=body.code or _next_ticket_code(db), subject=body.subject,
        description=body.description or "", type=body.type or "request",
        status=(body.status if (body.status and body.status != "new") else "open"), priority=body.priority or "medium",
        requester_email=(body.requester_email or user["email"]).strip().lower(),
        created_by_email=(user["email"] or "").strip().lower(),
        assignee_email=(body.assignee_email or "").strip().lower(), department_id=body.department_id or "",
        company_id=company_id,
        hr_department_id=body.hr_department_id or "",
        linked_task_id=body.linked_task_id or "", tags=body.tags or [], images=body.images or [],
        watcher_emails=_with_creator(body.watcher_emails, body.requester_email, user["email"]),
        resolution=body.resolution or "",
        custom_field_values=body.custom_field_values or {}, type_fields=body.type_fields or {}, links=[], task_ids=[],
        component=body.component or "", csat_rating=0, csat_comment="",
        application=(body.application or "").strip(),
        # Derived, never taken from the payload - see TicketBody.application.
        service_area=service_area_for(db, body.application or ""),
        # Always derived from priority, never taken from the payload (see
        # _sla_due_from_priority) - the frontend's own slaDueFromPriority call
        # at submit time is just a same-request UI preview.
        sla_due_on=_sla_due_from_priority(db, now, body.priority or "medium"), resolved_at="", created_at=now, modified_at=now,
    )
    # Approval gate, decided by the TYPE's admin switch (requiresApproval in the
    # ticket taxonomy, read at this moment) and never trusted from the client, so a
    # caller cannot post approval_status="approved" to skip it.
    #
    # No approver is named here. A gated ticket parks as pending with the
    # approver still blank: it goes to the IT Admin pool first, and an admin
    # sends it on to whoever should sign it off (request_approval below). The
    # requester never chooses their own approver, and neither does the server
    # guess - the desk that sees the request decides who it needs.
    t.approver_email = ""
    t.approval_status = "pending" if ticket_taxonomy.requires_approval(db, t.type or "") else "none"
    if t.approval_status == "pending" and t.assignee_email:
        # Same rule update_ticket enforces, applied at the door: a request cannot
        # be born already assigned, or the gate is skippable by whoever files it.
        raise HTTPException(409, "This request needs approval - it can be assigned once approved.")
    if t.assignee_email and t.status == "open":
        t.status = "in_progress"   # born assigned = already being worked (see update_ticket)
    db.add(t)
    log_activity(db, type="created", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail=json.dumps(_ticket_snapshot(t)))
    if source is not None:
        _copy_task_files(db, source, t, user["email"])
    tk_action = {"view": "tickets", "label": "View ticket"}
    if t.assignee_email and t.assignee_email != user["email"].lower():
        task_notify(db, kind="ticket_assigned", for_email=t.assignee_email,
                    title="You were assigned a ticket", body=f"{ticket_no(t.code)} · {t.subject}", ticket_id=t.id, nexus_action=tk_action)
    elif t.approval_status == "pending":
        # Gated: the IT Admins are told it needs sending for approval, not that
        # it needs assigning. Nobody can action it until it has been approved,
        # and a queue that says "assign me" about a ticket that cannot be
        # assigned yet trains people to ignore it.
        _notify_triage(db, t, user["email"].lower(), title="Ticket needs approval routing")
    else:
        _notify_triage(db, t, user["email"].lower())
    # Intake acknowledgment - let the requester know their request landed (e.g. when a
    # manager logs it on their behalf; if they raised it themselves they're the actor).
    if t.requester_email and t.requester_email != user["email"].lower():
        task_notify(db, kind="ticket_received", for_email=t.requester_email,
                    title="We received your ticket", body=f"{ticket_no(t.code)} · {t.subject}", ticket_id=t.id, nexus_action=tk_action)
    db.commit()
    db.refresh(t)
    background_tasks.add_task(notify_ticket_event, t.id, "created", user["email"])
    # No approval email here: a gated ticket has no approver yet, so there is
    # nobody to send one to. request_approval sends it once an IT Admin names one.
    out = ticket_to_dict(t)
    if source is not None:
        out["sourceTaskClosed"] = _finish_source_task(db, source, t, user, bool(body.close_source_task),
                                                      background_tasks)
    return out


# ── Convert to Ticket (Neil, 10/05) ─────────────────────────────────────────
# "There should be a button that says convert to ticket ... it's extracting the
# title, extracting the detail ... you still have to fill in all the different
# missing fields." The ticket form opens pre-filled from the task and the
# person completes what a task does not have; on create, the ticket links
# back to the task (linked_task_id - the drawer's Linked Tasks) and takes its
# files, and the task says where the work went.

def _source_task(db: Session, user: dict, task_id: str):
    """The task being converted - live, and one the caller can at least see."""
    from routers.task_util import require_task_role
    task = (db.query(models.Task).filter(models.Task.id == task_id,
                                         (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)))
            .first())
    if not task:
        raise HTTPException(404, "The task to convert no longer exists.")
    require_task_role(db, user, task, "viewer")
    return task


def _copy_task_files(db: Session, task, t: models.TaskTicket, actor: str) -> None:
    """The task's files, filed on the ticket too - the same stored copies
    (each row points at the existing storage URL, nothing is re-uploaded).
    One activity line for the lot, not one per file."""
    files = (db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == task.id)
             .order_by(models.TaskAttachment.added_at).all())
    for a in files:
        db.add(models.TaskAttachment(id=gen_id(), task_id=t.id, name=a.name, size=a.size or "",
                                     kind=a.kind or "other", url=a.url or "", added_at=now_iso(), added_by=actor))
    if files:
        log_activity(db, type="attached", actor_email=actor, entity_kind="ticket", entity_id=t.id,
                     entity_code=t.code, entity_title=t.subject,
                     detail=f"attached {len(files)} file{'' if len(files) == 1 else 's'} from the task")


def _finish_source_task(db: Session, task, t: models.TaskTicket, user: dict, close: bool,
                        background_tasks: BackgroundTasks) -> bool:
    """A note on the task pointing at the new ticket, then - when asked - the
    task closed, so the work is not tracked twice. Both go through the Tasks
    module's own code (comment and completion side effects included). Closing
    needs edit rights on the task; someone who can only see it still gets the
    note, and the ticket is never undone over it. Returns whether it closed."""
    from routers.task_util import create_comment, require_task_role
    link = f"{app_url()}/tickets?ticket={t.id}"
    note = (f'<p>Converted to <a href="{html_lib.escape(link)}">{html_lib.escape(ticket_no(t.code))}</a>'
            + (" - this task is closed; follow the work on the ticket.</p>" if close else ".</p>"))
    closed = False
    if close:
        try:
            from routers import tasks as tasks_router
            require_task_role(db, user, task, "editor")
            if not task.completed:
                tasks_router.update_task(task.id, tasks_router.TaskUpdate(completed=True), background_tasks,
                                         user=user, db=db)
            closed = True
        except HTTPException:
            db.rollback()
            note = note.replace(" - this task is closed; follow the work on the ticket.", ".")
    try:
        require_task_role(db, user, task, "commenter")
        db.refresh(task)
        create_comment(db, task, actor_email=user["email"], body=note, notify=False,
                       defer=background_tasks.add_task)
    except HTTPException:
        db.rollback()
    return closed


# Fields left open to whoever is just working a ticket (the assignee, or
# anyone else without ownership of it) - enough to triage, reassign and close
# it out, not to rewrite what it is or who it's for. Everyone else (the
# requester, or a manager+) gets the full field set. Mirrors the drawer's field
# gating in TicketsView.jsx - keep the two in step.
_WORKING_FIELDS = {"type", "status", "priority", "assignee_email", "hr_department_id", "resolution"}
# Every field an unrestricted caller may touch, minus reopen_reason (not a
# column - see TicketUpdate).
_ALL_TICKET_FIELDS = set(TicketUpdate.model_fields.keys()) - {"reopen_reason"}
# What the requester may still send once their ticket has left Open: the
# confirm / reopen move and the rating that goes with confirming.
_REQUESTER_AFTER_OPEN_FIELDS = {"status", "csat_rating", "csat_comment"}
# What a requester resolving their own ticket may send (Neil, Oct 1 2026: "a
# colleague helped me" - they can mark it Resolved while it is still Open or
# being worked). The status itself and the note; the optional "What fixed it?"
# rides as the save's `comment`, which only ever needs participation.
_REQUESTER_RESOLVE_FIELDS = {"status", "resolution_note"}


def _is_requester_only(db: Session, t: models.TaskTicket, user: dict) -> bool:
    """The person who raised it - and nothing more: not also its assignee, not
    a manager. This is who the narrower status rules in update_ticket apply to."""
    email = (user.get("email") or "").lower()
    return ((t.requester_email or "").lower() == email
            and email != (t.assignee_email or "").lower()
            and not _ticket_privileged(db, t, user))


def _requester_self_resolve(db: Session, t: models.TaskTicket, user: dict, data: dict) -> bool:
    """Is this save the requester marking their own still-active ticket
    Resolved? Only that move - an already resolved/closed ticket has its own
    Confirm / Reopen flow.

    Whoever raised it and is not working it - a manager or desk agent who
    raised their own ticket included: they are its requester, and the screen
    offers them the requester's Mark Resolved, not the desk's write-up."""
    email = (user.get("email") or "").lower()
    return (data.get("status") == "resolved" and (t.status or "open") not in ("resolved", "closed")
            and (t.requester_email or "").lower() == email
            and email != (t.assignee_email or "").lower())


def _may_patch_ticket(db: Session, t: models.TaskTicket, user: dict) -> bool:
    """The desk (same test require_ticket_desk applies) or the ticket's own
    requester. A plain employee has no tasks/tickets grant, and without this
    they could not edit their open ticket, confirm a resolution or reopen it
    from Support - _ticket_edit_scope still decides WHAT they may change."""
    from auth import _grants_for, _LEVELS, _MODULE_LEVEL_RANK
    if user.get("level", 0) >= _LEVELS["administrator"]:
        return True
    grants = _grants_for(user.get("email") or "", db)
    if any(grants.get(m, 0) >= _MODULE_LEVEL_RANK["viewer"] for m in ("tasks", "tickets")):
        return True
    return (t.requester_email or "").lower() == (user.get("email") or "").lower()


def _ticket_privileged(db: Session, t: models.TaskTicket, user: dict) -> bool:
    """Manager+ - full access regardless of ticket state; they own the queue,
    not just this one ticket.

    The ticket's department lead/backup used to qualify too. Dropped with the
    rest of the department-head routing: a ticket is filed against the
    department it is ABOUT, so that handed silent full edit rights over other
    people's requests to whoever happened to lead the named department - who is
    no longer notified about them and never owned them. The IT Admin desk owns
    tickets, and administrators clear the manager+ bar already."""
    return user.get("level", 1) >= 3


def _ticket_edit_scope(db: Session, t: models.TaskTicket, user: dict) -> set | None:
    """None = unrestricted. A set = the only TicketUpdate keys this caller may
    send (empty set = no edits at all right now).

    Once a ticket is "in_progress" and assigned, it becomes the assignee's to
    work: they get full access EXCEPT company_id - which stays with the
    requester (pre-lock) or a manager, never the working assignee (Jul 28
    policy). Everyone else - including the requester - is locked out entirely
    once locked (Jul 27 policy). Before that point the requester has full
    access; anyone else gets the working-field subset (self-assign, triage).
    Manager+ is unrestricted throughout, including company_id.

    "Full access" here is field-level, not value-level - the requester's
    `status` moves specifically are narrowed further, right after this scope
    check is applied, in update_ticket itself (see the comment there)."""
    email = user["email"].lower()
    if _ticket_privileged(db, t, user):
        return None
    if t.status == "in_progress" and t.assignee_email:
        return (_ALL_TICKET_FIELDS - {"company_id"}) if email == t.assignee_email.lower() else set()
    if (t.requester_email or "").lower() == email:                   # who raised it, pre-in_progress
        # Editable while it is still Open and nobody has picked it up (Neil,
        # Sep 30: "edit should only come up if it's still open"). After that
        # the requester's moves are confirming (with a rating) or reopening -
        # update_ticket narrows the status values further.
        if t.status != "open" and email != (t.assignee_email or "").lower():
            return _REQUESTER_AFTER_OPEN_FIELDS
        return None
    return _WORKING_FIELDS


@router.patch("/task-tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketUpdate, background_tasks: BackgroundTasks,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    import auth   # company wall: another company's ticket is 404
    auth.assert_company(t.company_id or "", user, db)
    if not _may_patch_ticket(db, t, user):
        raise HTTPException(403, "You don't have access to this screen")
    data = body.model_dump(exclude_unset=True)
    reopen_reason = data.pop("reopen_reason", "") or ""   # not a column - see TicketUpdate
    comment_body = data.pop("comment", None) or ""         # nor these - see TicketUpdate
    comment_internal = bool(data.pop("comment_internal", None))
    if _blank_comment(comment_body):
        comment_body = ""
    if comment_body:
        # Replying needs only participation, the same rule as the comments
        # endpoint - never the field-edit scope below.
        _require_ticket_participant(db, user, t)
    scope = _ticket_edit_scope(db, t, user)
    # A requester marking their own ticket Resolved may do so whatever state
    # it is in and whoever holds it - but only that: the status and its note
    # widen the scope, nothing else does (an in-progress ticket still refuses
    # every other field from them).
    self_resolve = _requester_self_resolve(db, t, user, data)
    if self_resolve and scope is not None:
        scope = scope | _REQUESTER_RESOLVE_FIELDS
    if scope is not None:
        blocked = sorted(set(data.keys()) - scope)
        if blocked:
            if not scope:
                raise HTTPException(403, f"This ticket is in progress and assigned to {t.assignee_email or 'someone else'} - only they (or a manager) can edit it right now.")
            if blocked == ["company_id"]:
                raise HTTPException(403, "Only the requester (before the ticket is picked up) or a manager can change the company on a ticket.")
            raise HTTPException(403, f"You can only update {', '.join(sorted(scope))} on a ticket you're not the requester/owner of - not: {', '.join(blocked)}")
    # Same allow-list gate as create_ticket (Sep 19, Pranshu) - a desk-grant
    # caller (a manager correcting it) is unrestricted; a plain requester
    # re-picking company_id in the pre-pickup window _ticket_edit_scope opens
    # to them may only choose a company the admin has actually turned on for
    # self-service, never an arbitrary id.
    if "company_id" in data and not _has_desk_grant(user, db):
        cid = (data["company_id"] or "").strip()
        cfg = ticket_taxonomy.company_field(db)
        if not (cid and cfg.get("enabled") and cid in (cfg.get("companyIds") or [])):
            raise HTTPException(400, "That company isn't offered for self-service ticket intake.")
    # The requester's OWN status transitions are narrower than the field-level
    # scope above can express: pre-in_progress they otherwise have unrestricted
    # access (see _ticket_edit_scope), which let them set status to anything -
    # "In Progress" or "Resolved" with nobody actually working it, skipping the
    # Mark Resolved/Reopen flows that capture a resolution or a reason (Pranshu,
    # Sep 10 2026). Once it IS resolved, their whole workflow is exactly two
    # moves: confirm it (close) or reopen it - never any other jump. Mirrors
    # canEditStatus in TicketsView.jsx, which hides the raw dropdown for them
    # the same way - keep the two in step. Privileged/assignee callers are
    # untouched; this only narrows the pure requester.
    # The one exception (Neil, Oct 1 2026): they may mark their own still-active
    # ticket Resolved (self_resolve, above) - "a colleague helped me".
    is_requester_only = _is_requester_only(db, t, user)
    if is_requester_only and "status" in data and not self_resolve:
        # Reopen is for a RESOLVED ticket only (Pranshu, Oct 1): once the
        # requester has confirmed it - or it auto-closed - it is closed for
        # good, and a problem that comes back is a new ticket. The desk can
        # still reopen a closed one.
        if t.status == "closed" and data["status"] == "reopened":
            raise HTTPException(403, "This ticket is closed. If the problem is back, submit a new ticket.")
        allowed_transitions = {("resolved", "closed"), ("resolved", "reopened")}
        if (t.status, data["status"]) not in allowed_transitions:
            raise HTTPException(403, "You can only resolve, close or reopen your ticket from here - other status changes are the desk's to make.")
        # Confirming a resolution rates the person who handled it, 1-5 stars
        # (Neil, Sep 30: "you need to give them stars... comments are
        # optional") - that rating is how the desk's work gets tracked.
        if (t.status, data["status"]) == ("resolved", "closed"):
            rating = data.get("csat_rating") or t.csat_rating or 0
            if not 1 <= int(rating) <= 5:
                raise HTTPException(400, "Rate how your ticket was handled (1 to 5 stars) to confirm the resolution.")
    if data.get("csat_rating") is not None and not 0 <= int(data["csat_rating"]) <= 5:
        raise HTTPException(400, "Rating must be between 1 and 5 stars.")
    # Resolving or closing a ticket that is still being worked needs a written
    # resolution (Neil, Sep 30: "when you close a ticket, you need to put in
    # what the resolution of the ticket is") - it is the record of what fixed
    # it the next time the same issue comes in. Resolved -> Closed (the
    # requester confirming) is not a new resolution, so it is not asked again.
    # A requester resolving their own ticket is not asked for a write-up (the
    # "What fixed it?" comment is optional); the note records that it was
    # them, and what they said when they said anything.
    if self_resolve and not (data.get("resolution_note") or "").strip():
        said = _comment_preview(comment_body, 1900) if comment_body else ""
        data["resolution_note"] = (f"Resolved by the requester: {said}" if said and said != "(no text)"
                                   else "Resolved by the requester.")
    note = data["resolution_note"] if "resolution_note" in data else t.resolution_note
    if (data.get("status") in ("resolved", "closed") and t.status not in ("resolved", "closed")
            and not (note or "").strip()):
        raise HTTPException(400, "Describe the resolution - what was done to fix it - before resolving this ticket.")
    if "resolution_note" in data:
        data["resolution_note"] = (data["resolution_note"] or "").strip()[:2000]
    # Work does not start before the sign-off. Assigning a ticket that is still
    # awaiting approval hands someone work the approver has not sanctioned, and
    # once it is in an assignee's queue it gets done - the gate is then decoration.
    # "rejected" blocks too: a refused request that gets reopened must not become
    # workable just because it is no longer closed (the reopen path below sends it
    # back for a fresh decision).
    if (data.get("assignee_email") or "") and (t.approval_status or "none") in ("pending", "rejected"):
        raise HTTPException(409, "This request is awaiting approval - it can be assigned once approved.")
    prev_status, prev_assignee, prev_priority = t.status, (t.assignee_email or ""), t.priority
    prev_type, prev_approval = (t.type or ""), (t.approval_status or "none")
    prev_due = t.sla_due_on
    # Captured for the audit trail below (_log_field_changes) - BEFORE the
    # mutation loop, and compared against the field's value after every
    # server-side re-derivation below has also run (service_area from a
    # re-picked application, resolution cleared on a status move, etc.), so a
    # change nobody explicitly asked for in this payload still gets logged if
    # it actually happened.
    prev_subject, prev_description = t.subject, (t.description or "")
    prev_dept, prev_company = t.hr_department_id, t.company_id
    prev_application, prev_service_area = t.application, t.service_area
    prev_resolution, prev_resolution_note = t.resolution, (t.resolution_note or "")
    prev_type_fields = dict(t.type_fields or {})
    # sla_due_on is never applied from the payload directly - it is derived
    # from priority a few lines down, same as create_ticket never trusting
    # body.sla_due_on. Still accepted on the model for backward-compat
    # payloads that include it; just ignored.
    data.pop("sla_due_on", None)
    for k, v in data.items():
        if k in ("assignee_email",) and v is not None:
            # strip() too - a padded address never matches the same person again,
            # so the ticket is assigned to somebody who never sees it.
            v = (v or "").strip().lower()
        setattr(t, k, v)
    # Re-picking the application re-derives the service area, so the two can
    # never disagree - unless the caller set an area explicitly in the same
    # request, which is the desk correcting a mis-mapped app by hand.
    if "application" in data and "service_area" not in data:
        t.application = (t.application or "").strip()
        t.service_area = service_area_for(db, t.application)
    # SLA due date follows priority automatically, full stop - the drawer's
    # manual DateField editor that let a caller override it in the same
    # request is gone (Pranshu, Sep 17 2026: "if priority changes the SLA due
    # date changes"). Mirrors create_ticket, which never trusts body.sla_due_on
    # either - any sla_due_on a caller sends is ignored; it is ALWAYS
    # recomputed from priority.
    if "priority" in data and t.priority != prev_priority:
        t.sla_due_on = _sla_due_from_priority(db, t.created_at, t.priority)
    if data.get("status") in ("resolved", "closed") and not t.resolved_at:
        t.resolved_at = now_iso()
    if data.get("status") not in ("resolved", "closed") and "status" in data:
        t.resolved_at = ""
        t.resolution = ""
        t.resolution_note = ""
    # Assigning an Open (or Reopened) ticket starts the work (Neil, Sep 30:
    # "if I assign it, it should automatically change the status from open to
    # in progress"). Only when the same request did not set a status itself.
    if ("assignee_email" in data and (t.assignee_email or "") and (t.assignee_email or "") != prev_assignee
            and "status" not in data and t.status in ("open", "reopened")):
        t.status = "in_progress"

    # ── Keep the approval gate in step with the ticket ────────────────────────
    # The gate is decided by the TYPE, so re-typing a ticket has to re-decide it.
    # Without this a request raised as a Bug Report (ungated) and then re-typed to
    # an Access Request kept approval_status "none" - it read as an access request
    # everywhere while never having been approved by anyone, which is precisely
    # the thing the gate exists to prevent.
    #
    # Re-typing is a new decision, so it reads the type's CURRENT switch
    # (ticket_taxonomy.requires_approval). A ticket that is not re-typed is
    # never re-evaluated here, which is what keeps a switch flip from
    # touching existing tickets.
    if (t.type or "") != prev_type:
        now_gated = ticket_taxonomy.requires_approval(db, t.type or "")
        if now_gated and prev_approval == "none":
            t.approval_status = "pending"
            t.approver_email = ""
            # Anyone already holding it loses it: they were handed work on a
            # ticket that had not been through approval.
            t.assignee_email = ""
            t.assigned_by_email = ""
            data.pop("assignee_email", None)   # don't log/notify an assignment that just went away
        elif not now_gated and prev_approval == "pending":
            # Re-classified out of the gated types before anyone decided. Clearing
            # it stops a mis-typed ticket sitting "awaiting approval" forever with
            # nothing left to approve. A decision already made is history and stays.
            t.approval_status = "none"
            t.approver_email = ""

    # A refused request that is reopened goes back for a fresh decision rather
    # than resuming as though it had been approved. Reopening is a request to
    # reconsider - it is not itself the reconsideration.
    if data.get("status") == "reopened" and prev_approval == "rejected":
        t.approval_status = "pending"
        t.approver_email = ""
        t.approval_note = ""
        t.approval_decided_at = ""

    # activity trail + notifications for meaningful changes
    changed = []

    def _log(kind, detail):
        log_activity(db, type=kind, actor_email=user["email"], entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=detail)
        changed.append(kind)
    tk_action = {"view": "tickets", "label": "View ticket"}
    status_changed = t.status != prev_status   # includes the assignment's auto In Progress
    assignee_changed = "assignee_email" in data and (t.assignee_email or "") != prev_assignee
    # The requester hears about EVERY change someone else makes to their
    # ticket, in their bell (Oct 1) - one notice per save, built after the
    # audit lines below so it can say what changed.
    requester = (t.requester_email or "").lower()
    tell_requester = bool(requester) and requester != user["email"].lower()
    if status_changed:
        _log("status_changed", f"changed status to {tmpl.status_label(t.status)}")
        if not (t.status in ("resolved", "closed") and tell_requester):
            # keep watchers and the assignee in the loop on any status move
            _notify_participants(db, t, user["email"], kind="ticket_status",
                                 title=f"Ticket moved to {tmpl.status_label(t.status)}", body=f"{ticket_no(t.code)} · {t.subject}",
                                 exclude={requester} if tell_requester else None)
    if assignee_changed:
        # Stamped from the actor, never from the payload: the field records WHO
        # handed the ticket over, and a value the caller could set records
        # nothing. Cleared on unassignment so it never credits someone with an
        # assignment that no longer exists.
        t.assigned_by_email = user["email"].lower() if t.assignee_email else ""
        _log("assigned", f"assigned to {t.assignee_email or 'nobody'}"
                         + (f" by {t.assigned_by_email}" if t.assigned_by_email else ""))
        if t.assignee_email and t.assignee_email != user["email"].lower():
            task_notify(db, kind="ticket_assigned", for_email=t.assignee_email,
                        title="You were assigned a ticket", body=f"{ticket_no(t.code)} · {t.subject}", ticket_id=t.id, nexus_action=tk_action)
    if "priority" in data and t.priority != prev_priority:
        _log("priority_changed", f"set priority to {t.priority}")
    if t.subject != prev_subject:
        _log("subject_changed", f'changed the title to "{t.subject}"')
    if (t.description or "") != prev_description:
        _log("description_changed", "updated the description")
    if t.hr_department_id != prev_dept:
        _log("department_changed", f"changed department to {dept_name(db, t.hr_department_id) or '-'}")
    if t.company_id != prev_company:
        c = db.query(models.HrEntity).filter(models.HrEntity.id == t.company_id).first() if t.company_id else None
        _log("company_changed", f"changed company to {c.name if c else '-'}")
    if t.application != prev_application:
        _log("application_changed", f"changed application to {t.application or '-'}")
    if t.service_area != prev_service_area:
        _log("service_area_changed", f"changed service area to {t.service_area or '-'}")
    if t.sla_due_on != prev_due:
        # Not gated on "in data" like the fields above - sla_due_on is never
        # in the payload now (see the pop() above), it only ever moves as a
        # side effect of a priority change, and that's still worth a line in
        # the audit trail (see this function's "gets logged if it actually
        # happened" comment above the mutation loop).
        _log("sla_changed", f"changed the SLA due date to {t.sla_due_on or '-'}")
    if t.resolution != prev_resolution:
        _log("resolution_changed", f"set resolution to {_type_label(t.resolution) if t.resolution else '-'}")
    if (t.resolution_note or "") != prev_resolution_note and t.resolution_note:
        _log("resolution_note", f"resolution: {_comment_preview(t.resolution_note)}")
    # Per-question diff, not "type fields updated" - a requester's wrong answer
    # getting corrected is exactly the kind of change this audit trail exists
    # to make provable (Pranshu, Sept 8 2026), so which question and what it
    # changed to/from both need to be legible in the feed, not just the fact
    # that SOMETHING under the type-specific section moved.
    new_type_fields = t.type_fields or {}
    for key in set(prev_type_fields) | set(new_type_fields):
        ov, nv = prev_type_fields.get(key), new_type_fields.get(key)
        if ov != nv:
            # The help topic's "Which One?" reads by its on-screen name, not its key.
            label = ("Which One?" if key == "svc_helpSubtopic"
                     else ticket_taxonomy.question_label(db, key) or key)
            _log("field_changed", f'changed "{label}" from {_fmt_audit_value(ov)} to {_fmt_audit_value(nv)}')
    # The gate moving is a fact about the ticket, not a side effect to hide: log
    # it, and put a re-gated ticket back in front of the desk that has to route it.
    if (t.approval_status or "none") != prev_approval:
        if t.approval_status == "pending":
            _log("approval_reset",
                 "sent back for approval - " + ("re-typed as " + _type_label(t.type)
                                                if (t.type or "") != prev_type else "reopened after being rejected"))
            _notify_triage(db, t, user["email"].lower(), title="Ticket needs approval routing")
        elif t.approval_status == "none":
            _log("approval_cleared", f"no longer needs approval - re-typed as {_type_label(t.type)}")

    requester_told = False
    if tell_requester:
        news = []
        if assignee_changed:
            news.append(f"assigned to {_name_of(db, t.assignee_email)}" if t.assignee_email else "unassigned")
        if "priority_changed" in changed:
            news.append(f"priority set to {(t.priority or '').title()}")
        resolving = status_changed and t.status in ("resolved", "closed")
        edited = [label for kind, label in _REQUESTER_FIELD_LABELS
                  if kind in changed and not (resolving and label == "resolution")]
        if (t.type or "") != prev_type:
            edited.append("type")
        if edited:
            news.append("updated the " + _and_list(list(dict.fromkeys(edited))))
        if "approval_reset" in changed:
            news.append("sent back for approval")
        public_reply = comment_body and not (comment_internal and _has_desk_grant(user, db))
        if public_reply and (status_changed or news):
            # One bell for the whole save: the reply rides along here and the
            # comment's own bell skips the requester (below).
            news.append("new reply")
        if status_changed or news:
            label = tmpl.status_label(t.status)
            title = (f"Your ticket was {label}" if resolving
                     else f"Your ticket moved to {label}" if status_changed else "Your ticket was updated")
            what = "; ".join(news)
            body = f"{ticket_no(t.code)} · {t.subject}" + (f" - {what[:1].upper()}{what[1:]}" if what else "")
            task_notify(db, kind="ticket_resolved" if resolving else "ticket_status" if status_changed else "ticket_updated",
                        for_email=requester, title=title, body=body[:500], ticket_id=t.id, nexus_action=tk_action)
            requester_told = True

    t.modified_at = now_iso()
    # Anything someone else changed is news to the requester - the unread dot
    # on their Support list. Their own edits never light it.
    if changed and (user["email"] or "").lower() != (t.requester_email or "").lower():
        t.requester_update_at = t.modified_at
    public_comment = ""
    if comment_body:
        _c, was_internal = _record_ticket_comment(db, t, user, comment_body, comment_internal,
                                                  quiet={requester} if requester_told else None)
        if not was_internal and get_notify_settings(db).get("commentsTrigger", True):
            public_comment = comment_body
    db.commit()
    db.refresh(t)

    # ── Outlook notifications (best-effort, after commit - see ticket_notify.py) ──
    # ONE email per save, whatever it carried: the drawer batches a whole visit
    # (fields + a reply) into this one call, and the reply rides along in the
    # email picked for the fields rather than arriving as a second one.
    # Requester emails and Teams follow one policy (Neil, Oct 1 2026): ASSIGNED,
    # a public REPLY (with its text) and RESOLVED / CLOSED - nothing for status
    # moves, priority or field edits ("we don't need any other Teams spam"; the
    # bell above still carries every update). ticket_notify.notify_ticket_event
    # also drops the requester from any event they caused themselves.
    actor = user["email"]
    extra = {"latest_comment": public_comment} if public_comment else {}
    assigned_now = assignee_changed and bool(t.assignee_email)
    closing = status_changed and t.status in ("resolved", "closed") and prev_status not in ("resolved", "closed")
    if closing:
        # Resolved outranks an assignment made in the same save - the resolved
        # email reaches the requester, the desk and the (new) assignee anyway.
        background_tasks.add_task(notify_ticket_event, t.id, "resolved", actor, **extra)
    elif assigned_now:
        # Reassignment uses the "assigned" flow exclusively - spec lists reassignment
        # under both "assigned" (§2) and generic "update" (§3) triggers, but firing
        # both would double-email the same change; §2's is the richer one.
        background_tasks.add_task(notify_ticket_event, t.id, "assigned", actor, **extra)
    elif status_changed and t.status == "reopened":
        # The desk and assignee hear about a reopen; the requester only when it
        # carried a reply for them (notify_ticket_event decides).
        background_tasks.add_task(notify_ticket_event, t.id, "reopened", actor, reopen_reason=reopen_reason, **extra)
    elif public_comment:
        # A reply (alone, or alongside a status/priority/field change that is
        # not news on its own) - the conversation-thread email.
        background_tasks.add_task(notify_ticket_event, t.id, "updated", actor,
                                   update_kind="New comment added", latest_comment=public_comment)

    # Teams DM - the same three events, in ONE message per save, never one per
    # change (see _queue_requester_teams_dm).
    if assigned_now or closing or public_comment:
        dm_row = _queue_requester_teams_dm(db, t, actor, assigned=assigned_now, closed=closing,
                                           comment=public_comment)
        db.commit()
        # One delivery attempt right away so the common case lands in Teams
        # without waiting for ticket_teams_post_loop's next sweep (up to ~5
        # min later) - but AFTER the response: it is a Graph round trip (two
        # when the chat has to be created) and running it inline held every
        # status change open until Teams answered (Neil, Sep 30: clicking
        # Resolved "is lagging a lot"). Anything that fails stays queued for
        # the sweep to retry.
        if dm_row is not None:
            background_tasks.add_task(_deliver_teams_dm, dm_row.id)

    # With its latest comment: this reply replaces the row in the list, and a
    # reply sent with the save is the newest comment now.
    return _with_latest_comment(db, t, user, ticket_to_dict(t))


@router.delete("/task-tickets/{ticket_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Soft delete (Oct 2026). The ticket is marked, not dropped: it vanishes
    from every list, count and notification scan (the hook in database.py),
    while its conversation, files and activity stay exactly as they were so
    POST /task-tickets/{id}/restore can put it back. This used to hard-delete
    the comments, attachment rows and the whole activity trail with it - the
    one record of who did what to the ticket was the first thing to go.
    Storage objects are left alone for the same reason (restore needs them)."""
    t = _ticket_or_404(db, ticket_id)
    import auth   # company wall: another company's ticket is 404
    auth.assert_company(getattr(t, "company_id", "") or "", user, db)
    if not _may_delete_ticket(db, t, user):
        raise HTTPException(403, "Only the requester or a manager can delete a ticket")
    t.deleted_at = now_iso()
    t.deleted_by = (user.get("email") or "").lower()
    log_activity(db, type="deleted", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail="deleted this ticket")
    db.commit()


def _may_delete_ticket(db: Session, t: models.TaskTicket, user: dict) -> bool:
    """Who may delete - and so restore - a ticket. Independent of the
    in_progress/assignee edit lock above - deleting stays with whoever raised
    it or owns the queue, never just the assignee."""
    is_requester = (t.requester_email or "").lower() == (user.get("email") or "").lower()
    return _ticket_privileged(db, t, user) or is_requester


def _deleted_ticket_or_404(db: Session, ticket_id: str) -> models.TaskTicket:
    t = (db.query(models.TaskTicket).execution_options(include_deleted=True)
         .filter(models.TaskTicket.id == ticket_id).first())
    if not t or not (t.deleted_at or ""):
        raise HTTPException(404, "That ticket isn't deleted")
    return t


@router.get("/task-tickets/deleted", dependencies=[Depends(require_ticket_desk)])
def list_deleted_tickets(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Deleted tickets the caller could restore, newest-deleted first: every
    one in their companies for a manager, otherwise the ones they raised."""
    import auth
    rows = (db.query(models.TaskTicket).execution_options(include_deleted=True)
            .filter(models.TaskTicket.deleted_at != "", models.TaskTicket.deleted_at.isnot(None))
            .order_by(models.TaskTicket.deleted_at.desc()).all())
    cscope = auth.company_scope(user, db)
    if cscope is not None:
        rows = [t for t in rows if (t.company_id or "") in cscope]
    out = []
    for t in rows:
        if not _may_delete_ticket(db, t, user):
            continue
        d = ticket_to_dict(t)
        d["deletedAt"] = t.deleted_at or ""
        d["deletedBy"] = _nz(t.deleted_by)
        out.append(d)
    return out


@router.post("/task-tickets/{ticket_id}/restore", dependencies=[Depends(require_ticket_desk)])
def restore_ticket(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put a deleted ticket back exactly as it was - conversation, files and
    activity never left. Same people who may delete it: the requester or a
    manager, inside the company wall."""
    t = _deleted_ticket_or_404(db, ticket_id)
    import auth   # company wall: another company's ticket is 404
    auth.assert_company(getattr(t, "company_id", "") or "", user, db)
    if not _may_delete_ticket(db, t, user):
        raise HTTPException(403, "Only the requester or a manager can restore a ticket")
    t.deleted_at = ""
    t.deleted_by = ""
    log_activity(db, type="restored", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail="restored this ticket")
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


# ── Ticket conversation / attachments / activity (reuse the task tables, keyed
#    by the ticket id; ids are globally unique so tasks and tickets never collide) ──
def _ticket_or_404(db: Session, ticket_id: str) -> models.TaskTicket:
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    return t


def _tcomment(c) -> dict:
    return {"id": c.id, "ticketId": c.task_id, "authorId": _nz(c.author_email), "body": c.body or "",
            "internal": bool(getattr(c, "internal", False)),
            "createdAt": c.created_at or "", "editedAt": _nz(c.edited_at)}


def _tattachment(a) -> dict:
    return {"id": a.id, "ticketId": a.task_id, "name": a.name, "size": a.size or "",
            "kind": a.kind or "other", "url": _nz(a.url), "dataUrl": _nz(a.url),
            "addedAt": a.added_at or "", "addedBy": _nz(a.added_by)}


class TicketCommentBody(BaseModel):
    body: str
    internal: Optional[bool] = False


class TicketAttachmentBody(BaseModel):
    name: str
    size: Optional[str] = ""
    kind: Optional[str] = "other"
    url: Optional[str] = ""


@router.get("/task-tickets/{ticket_id}/comments")
def list_ticket_comments(ticket_id: str, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    # Their own support request is readable without a desk grant.
    t = _ticket_or_404(db, ticket_id)
    _require_ticket_participant(db, user, t)
    rows = db.query(models.TaskComment).filter(models.TaskComment.task_id == ticket_id).order_by(models.TaskComment.created_at).all()
    # Internal notes are the desk talking among themselves - never shown to
    # the person who raised the ticket, even one who also has a desk grant
    # (unless they are working it themselves, or a manager).
    email = (user.get("email") or "").lower()
    sees_internal = _has_desk_grant(user, db) and (
        email != (t.requester_email or "").lower()
        or email == (t.assignee_email or "").lower()
        or _ticket_privileged(db, t, user))
    return [_tcomment(c) for c in rows if sees_internal or not getattr(c, "internal", False)]


def _blank_comment(text: str) -> bool:
    """True for a reply with no words in it - the rich editor's empty
    document is `<p></p>`, which is not something to post."""
    return not re.sub(r"<[^>]*>|&nbsp;|\s", "", text or "")


def _record_ticket_comment(db: Session, t: models.TaskTicket, user: dict, text: str,
                           internal: bool, quiet: set | None = None) -> tuple:
    """Add one comment to a ticket: the row, the staleness clock, the activity
    line, @mention watchers and the bell notices. Emails and the Teams DM are
    the caller's (the comments endpoint sends its own; update_ticket folds the
    reply into the one email it sends for the whole save). Does not commit.
    Returns (comment, internal) - internal only sticks for a desk-grant author.
    `quiet`: people already told about this save in another bell (update_ticket's
    requester notice), so the reply does not reach them twice."""
    internal = bool(internal) and _has_desk_grant(user, db)
    c = models.TaskComment(id=gen_id(), task_id=t.id, author_email=user["email"], body=text,
                           internal=internal, created_at=now_iso())
    db.add(c)
    # Resets the "needs a comment" staleness clock - internal notes count too,
    # any human touching the ticket is evidence someone's paying attention.
    t.last_comment_at = now_iso()
    if not internal:
        # A reply is an update: it moves the ticket's Last Updated, and one
        # from anyone but the requester lights their unread dot on Support.
        t.modified_at = t.last_comment_at
        if (user["email"] or "").lower() != (t.requester_email or "").lower():
            t.requester_update_at = t.last_comment_at
    # JSON, not a plain string - same "structured detail" trick the "created"
    # snapshot uses (see _ticket_snapshot) - so the activity feed can show what
    # was actually said instead of just the word "commented", while still
    # tagging internal notes the same way the Conversation tab does. A row
    # logged before this change is plain text and the frontend falls back to
    # rendering it as-is.
    log_activity(db, type="commented", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail=json.dumps({"internal": internal, "preview": _comment_preview(text)}))
    # @mentions, read from the mailto links the editor writes - the same
    # convention and the same parser the task comments use, so the two threads
    # can't drift (Sagar, Sept 2 2026: "@ should work here like it does on tasks").
    actor = (user["email"] or "").lower()
    mentioned = [e for e in extract_mentions(text) if e != actor]
    if mentioned:
        # Being mentioned puts you ON the ticket. A participant may read and
        # reply without a desk grant (_require_ticket_participant), so without
        # this the bell would open a 403 for anyone not already involved - and
        # they would hear nothing about the reply they were pulled in for.
        known = {e.lower() for e in (t.watcher_emails or []) if e}
        known |= {(t.requester_email or "").lower(), (t.assignee_email or "").lower()}
        added = [e for e in mentioned if e not in known]
        if added:
            t.watcher_emails = [e for e in (t.watcher_emails or []) if e] + added
    # Internal notes stay with the agents - don't ping the requester. Anyone
    # mentioned is excluded here and told by name below instead, so a mention
    # doesn't arrive as two bells about the same comment.
    _skip = set(mentioned) | set(quiet or ())
    if internal:
        _skip.add((t.requester_email or "").lower())
    _notify_participants(db, t, user["email"], kind="ticket_comment",
                         title="Internal note on a ticket" if internal else "New comment on a ticket",
                         body=f"{ticket_no(t.code)} · {t.subject}",
                         exclude=_skip or None)
    for who in mentioned:
        task_notify(db, kind="ticket_comment", for_email=who,
                    title="You were mentioned in a ticket comment",
                    body=f"{ticket_no(t.code)} · {t.subject}", ticket_id=t.id,
                    nexus_action={"view": "tickets", "label": "View ticket"})
    return c, internal


@router.post("/task-tickets/{ticket_id}/comments", status_code=201)
def add_ticket_comment(ticket_id: str, body: TicketCommentBody, background_tasks: BackgroundTasks,
                       user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    # Replying on your own ticket needs no grant; an internal note does, since
    # those are the desk talking among themselves and are hidden from the
    # requester.
    _require_ticket_participant(db, user, t)
    c, internal = _record_ticket_comment(db, t, user, body.body or "", bool(body.internal))
    db.commit()
    db.refresh(c)
    if not internal and get_notify_settings(db).get("commentsTrigger", True):
        background_tasks.add_task(notify_ticket_event, t.id, "updated", user["email"],
                                   # Full comment text - the email renders it in its own
                                   # quote block, so no truncation (was capped at 280).
                                   update_kind="New comment added", latest_comment=body.body or "")
        # Teams DM too, carrying the reply itself (Neil, Oct 1: "whatever
        # comments got added, that comment should come out"). Without this, a
        # requester who only watches Teams never heard about a reply at all
        # (Pranshu, Sep 17 2026). Same inline-attempt-then-sweep-fallback
        # shape as update_ticket's block. Their own reply sends nothing.
        dm_row = _queue_requester_teams_dm(db, t, user["email"], comment=body.body or "")
        db.commit()
        if dm_row is not None:
            background_tasks.add_task(_deliver_teams_dm, dm_row.id)
    return _tcomment(c)


@router.delete("/task-tickets/comments/{comment_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket_comment(comment_id: str, user: dict = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    """The author, or a manager moderating the thread - the same bar the task
    thread uses (routers/tasks.delete_comment). This used to delete any row in
    the shared comment table by id: another company's ticket, a colleague's
    reply, even a TASK comment, with nothing left to show it had happened.
    The comment must belong to a live ticket the caller can reach, and the
    removal is logged - without the text, so an internal note's words never
    reach the activity feed."""
    c = db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).first()
    if not c:
        raise HTTPException(404, "Comment not found")
    t = _ticket_or_404(db, c.task_id)   # a task's comment is not this endpoint's
    _require_ticket_participant(db, user, t)   # company wall (404) + access
    me = (user.get("email") or "").lower()
    if (c.author_email or "").lower() != me and not _ticket_privileged(db, t, user):
        raise HTTPException(403, "Only the author or a manager can delete a comment")
    internal = bool(getattr(c, "internal", False))
    # JSON detail, like the "commented" row: `internal` keeps the line on the
    # desk side of the internal-note rule, `text` is what the feed shows.
    log_activity(db, type="comment_deleted", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail=json.dumps({"internal": internal,
                                    "text": "deleted an internal note" if internal else "deleted a comment",
                                    "author": (c.author_email or "").lower(),
                                    "createdAt": c.created_at or ""}))
    db.delete(c)
    db.commit()


@router.post("/task-tickets/{ticket_id}/seen")
def mark_ticket_seen(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The requester opened their ticket - clears the unread dot on Support.
    Anyone else opening it is a no-op (the dot is the requester's)."""
    t = _ticket_or_404(db, ticket_id)
    _require_ticket_participant(db, user, t)
    if (user.get("email") or "").lower() == (t.requester_email or "").lower():
        t.requester_seen_at = now_iso()
        db.commit()
    return {"requesterSeenAt": t.requester_seen_at or ""}


@router.get("/task-tickets/{ticket_id}/attachments")
def list_ticket_attachments(ticket_id: str, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    _require_ticket_participant(db, user, _ticket_or_404(db, ticket_id))
    rows = db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == ticket_id).all()
    return [_tattachment(a) for a in rows]


@router.post("/task-tickets/{ticket_id}/attachments", status_code=201)
def add_ticket_attachment(ticket_id: str, body: TicketAttachmentBody, background_tasks: BackgroundTasks,
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    _require_ticket_participant(db, user, t)
    a = models.TaskAttachment(id=gen_id(), task_id=ticket_id, name=body.name, size=body.size or "",
                              kind=body.kind or "other", url=body.url or "", added_at=now_iso(), added_by=user["email"])
    db.add(a)
    log_activity(db, type="attached", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=f'attached "{a.name}"')
    _tell_requester(db, t, user["email"], f'File attached: "{a.name}"')
    db.commit()
    db.refresh(a)
    # No email or Teams message: an attachment is not one of the three things
    # a requester is messaged about (Neil, Oct 1 2026 - assigned, a reply,
    # resolved/closed). The bell above still tells them. This used to send
    # the requester an "updated" email, so the old attachmentsTrigger setting
    # no longer drives anything.
    return _tattachment(a)


@router.delete("/task-tickets/attachments/{attachment_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket_attachment(attachment_id: str, user: dict = Depends(get_current_user),
                             db: Session = Depends(get_db)):
    """Whoever attached it, or a manager. Was unguarded: any desk agent could
    remove any row in the shared attachment table by id (another company's
    ticket, a task's evidence). The row goes; the stored file is left in place
    (purging orphaned files is a separate, deliberate job) and the removal is
    logged on the ticket."""
    a = db.query(models.TaskAttachment).filter(models.TaskAttachment.id == attachment_id).first()
    if not a:
        raise HTTPException(404, "Attachment not found")
    t = _ticket_or_404(db, a.task_id)   # a task's attachment is not this endpoint's
    _require_ticket_participant(db, user, t)   # company wall (404) + access
    me = (user.get("email") or "").lower()
    if (a.added_by or "").lower() != me and not _ticket_privileged(db, t, user):
        raise HTTPException(403, "Only whoever attached it or a manager can remove an attachment")
    log_activity(db, type="attachment_removed", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail=f'removed attachment "{a.name}"')
    db.delete(a)
    db.commit()


@router.get("/task-tickets/{ticket_id}/activity")
def list_ticket_activity(ticket_id: str, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    _require_ticket_participant(db, user, _ticket_or_404(db, ticket_id))
    rows = (db.query(models.TaskActivity)
            # actor_email="system" is the automated notify/auto-close machinery
            # (ticket_notify.py) - notification-delivery bookkeeping, not
            # anything a requester or agent DID to the ticket. Excluded here,
            # at the source, rather than filtered per-caller in the frontend,
            # so every consumer of this endpoint gets the same "useful
            # activity only" feed (Pranshu, Sept 8 2026).
            .filter(models.TaskActivity.entity_kind == "ticket", models.TaskActivity.entity_id == ticket_id,
                    models.TaskActivity.actor_email != "system")
            .order_by(models.TaskActivity.at.desc()).all())
    return [{"id": a.id, "type": a.type or "", "actorId": _nz(a.actor_email), "at": a.at or "", "detail": a.detail or ""} for a in rows]


# ── Org lookups for tickets - company + department from the People module.
#    Read-only id+name lists, available to any authenticated user (the /hr
#    endpoints are permission-gated, which a plain ticket requester may lack). ──
@router.get("/ticket-companies")
def list_ticket_companies(db: Session = Depends(get_db)):
    rows = db.query(models.HrEntity).order_by(models.HrEntity.name).all()
    return [{"id": e.id, "name": e.name} for e in rows]


def company_for(db: Session, email: str) -> str:
    """The HrEntity a person belongs to, from their People record, or "".

    The one answer both the department list and ticket creation use, so the
    departments someone is offered can never belong to a different company than
    the one their ticket is filed under."""
    emp = (db.query(models.NexusEmployee)
           .filter(models.NexusEmployee.work_email == (email or "").lower()).first())
    return (emp.company or "") if emp else ""


# ── Ticket departments = the company's GLOBAL departments (Neil, Oct 1 2026) ──
# "The departments should come from global. It can't be that tasks have
# different departments and tickets have different. We need to be able to set
# the company, then import the departments into each module, and then have the
# option of turning it off. Like, I don't want a construction ticket."
#
# So the LIST - which departments a company has, and what they are called -
# comes only from HrDepartment (Settings -> Company Settings -> the company ->
# Departments), the same rows the Task module reads. Adding, renaming and
# deleting a department happens there and nowhere else. ticket_departments
# survives as the Tickets module's per-department SETTINGS, keyed by the same
# id: `enabled` (offered at intake or not), the escalation lead/backup, and the
# intake order. A department added globally appears here on the next read,
# enabled; a rename shows here on the next read (the global name wins).
#
# Legacy rows - departments created in the ticket desk between the Sept 13
# split and this merge, which never existed globally - are PROMOTED once into
# HrDepartment with the same id (_unify_legacy_departments), so no department
# and no ticket's hr_department_id disappears. Where the company already has a
# global department of that name, the two are merged instead: tickets are
# re-pointed to the global id and the routing lead/backup carried over.
_UNIFIED_KEY = "ticket_departments_unified_v1"


def _dept_key(name: str) -> str:
    return (name or "").strip().lower()


def _unify_legacy_departments(db: Session) -> None:
    """One-time promotion of ticket-only departments into the global list.

    Guarded by a NexusSetting marker so it runs exactly once per database: after
    the merge, a settings row whose department was deleted globally is a
    deletion to respect, not a legacy row to bring back."""
    if db.query(models.NexusSetting).filter(models.NexusSetting.key == _UNIFIED_KEY).first():
        return
    try:
        hr_rows = db.query(models.HrDepartment).all()
        hr_ids = {d.id for d in hr_rows}
        by_name = {(d.company_id, _dept_key(d.name)): d for d in hr_rows}
        next_sort: dict[str, int] = {}
        for d in hr_rows:
            next_sort[d.company_id] = max(next_sort.get(d.company_id, -1), d.sort_order or 0)
        settings = {s.id: s for s in db.query(models.TicketDepartment).all()}
        promoted, merged = [], []
        for s in list(settings.values()):
            if s.id in hr_ids:
                continue
            match = by_name.get((s.company_id, _dept_key(s.name)))
            if match is not None and match.id != s.id:
                # The same department twice (made in both places). Keep the
                # global one; move the tickets and the routing over to it.
                (db.query(models.TaskTicket).filter(models.TaskTicket.hr_department_id == s.id)
                 .update({models.TaskTicket.hr_department_id: match.id}, synchronize_session=False))
                keep = settings.get(match.id)
                if keep is None:
                    keep = models.TicketDepartment(id=match.id, company_id=match.company_id, name=match.name,
                                                   sort_order=s.sort_order, enabled=True,
                                                   created_by=s.created_by or "", created_at=s.created_at or now_iso())
                    db.add(keep)
                    settings[match.id] = keep
                keep.lead_email = keep.lead_email or s.lead_email or ""
                keep.backup_email = keep.backup_email or s.backup_email or ""
                db.delete(s)
                merged.append(s.name)
                continue
            nxt = next_sort.get(s.company_id, -1) + 1
            next_sort[s.company_id] = nxt
            g = models.HrDepartment(id=s.id, company_id=s.company_id, name=s.name, sort_order=nxt,
                                    created_by=s.created_by or "tickets", created_at=s.created_at or now_iso())
            db.add(g)
            by_name[(s.company_id, _dept_key(s.name))] = g
            promoted.append(s.name)
        db.add(models.NexusSetting(key=_UNIFIED_KEY, updated_by="system", updated_at=now_iso(),
                                   value=json.dumps({"promoted": promoted, "merged": merged})))
        db.commit()
    except Exception:
        # Another worker got there first (both insert the marker) - its
        # result stands, nothing to redo.
        db.rollback()


def _sync_ticket_departments(db: Session, company_id: Optional[str] = None) -> None:
    """Give every global department a ticket settings row, and mirror its
    current name/company onto it. Idempotent; commits only when something
    changed."""
    hq = db.query(models.HrDepartment)
    sq = db.query(models.TicketDepartment)
    if company_id is not None:
        hq = hq.filter(models.HrDepartment.company_id == company_id)
        sq = sq.filter(models.TicketDepartment.company_id == company_id)
    settings = {s.id: s for s in sq.all()}
    hr_rows = hq.all()
    # A department moved between companies has its settings row under the old
    # company - look it up by id, not through the company filter.
    missing = [d.id for d in hr_rows if d.id not in settings]
    if missing:
        for s in db.query(models.TicketDepartment).filter(models.TicketDepartment.id.in_(missing)).all():
            settings[s.id] = s
    next_sort: dict[str, int] = {}
    for s in settings.values():
        next_sort[s.company_id] = max(next_sort.get(s.company_id, -1), s.sort_order or 0)
    changed = False
    for d in sorted(hr_rows, key=lambda d: (d.sort_order or 0, d.name or "")):
        s = settings.get(d.id)
        if s is None:
            nxt = next_sort.get(d.company_id, -1) + 1
            next_sort[d.company_id] = nxt
            db.add(models.TicketDepartment(id=d.id, company_id=d.company_id, name=d.name, sort_order=nxt,
                                           enabled=True, created_by="system", created_at=now_iso()))
            changed = True
        elif s.name != d.name or s.company_id != d.company_id:
            s.name, s.company_id = d.name, d.company_id
            changed = True
    if changed:
        try:
            db.commit()
        except Exception:
            db.rollback()   # a concurrent read inserted the same row - fine


def _dept_dict(s: models.TicketDepartment, live: Optional[models.HrDepartment]) -> dict:
    return {"id": s.id, "name": live.name if live else s.name, "companyId": s.company_id,
            "leadEmail": s.lead_email or "", "backupEmail": s.backup_email or "",
            "enabled": s.enabled is not False,
            # Deleted from the company's department list: kept in the full
            # list only so tickets filed against it still show its name.
            "removed": live is None}


def _ticket_depts(db: Session, company_id: Optional[str] = None, *, enabled_only: bool = False,
                  include_removed: bool = False) -> list[dict]:
    _unify_legacy_departments(db)
    _sync_ticket_departments(db, company_id)
    hq = db.query(models.HrDepartment)
    sq = db.query(models.TicketDepartment)
    if company_id is not None:
        hq = hq.filter(models.HrDepartment.company_id == company_id)
        sq = sq.filter(models.TicketDepartment.company_id == company_id)
    live = {d.id: d for d in hq.all()}
    out = []
    for s in sq.order_by(models.TicketDepartment.sort_order, models.TicketDepartment.name).all():
        g = live.get(s.id)
        if g is None and not include_removed:
            continue
        if enabled_only and (g is None or s.enabled is False):
            continue
        out.append(_dept_dict(s, g))
    return out


def dept_name(db: Session, dept_id: str) -> str:
    """A ticket's department name: the global name, else the last name the
    ticket desk knew it by (a department since deleted globally)."""
    if not dept_id:
        return ""
    d = db.query(models.HrDepartment).filter(models.HrDepartment.id == dept_id).first()
    if d:
        return d.name or ""
    s = db.query(models.TicketDepartment).filter(models.TicketDepartment.id == dept_id).first()
    return (s.name or "") if s else ""


@router.get("/ticket-departments")
def list_ticket_departments(mine: bool = False, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    """`mine=true` is what Submit a Ticket offers: the ENABLED departments of
    the requester's own company. Intake no longer asks which company a ticket
    belongs to - a person works for one, and the server knows which.

    The default (every company's, enabled or not, plus departments since
    deleted globally, flagged `removed`) is for the agent queue, Manage and
    every screen that has to name a department an existing ticket was filed
    under."""
    if mine:
        company = company_for(db, user.get("email") or "")
        # No People record -> no company -> no departments to offer. The ticket
        # is still valid without one; triage routes it.
        if not company:
            return []
        return _ticket_depts(db, company, enabled_only=True)
    return _ticket_depts(db, include_removed=True)


def _dept_list(db: Session, company_id: str) -> list[dict]:
    """One company's departments as the settings screen shows them - every
    global department, enabled or not."""
    return _ticket_depts(db, company_id)


_MANAGED_GLOBALLY = ("Departments are managed in Settings > Company Settings - add, rename or "
                     "delete them there. Here you can only turn one on or off for tickets.")


class TicketDepartmentIn(BaseModel):
    company_id: str
    name: str


# Adding, renaming and deleting moved to the global list (see the section
# comment above). The routes stay, answering 410 with where to go instead, so
# an old open tab gets a sentence rather than a 404/405.
@router.post("/ticket-departments", status_code=201, dependencies=[Depends(require_ticket_desk)])
def add_ticket_department(body: TicketDepartmentIn, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    raise HTTPException(410, _MANAGED_GLOBALLY)


class TicketDepartmentUpdate(BaseModel):
    name:         Optional[str] = None
    lead_email:   Optional[str] = None
    backup_email: Optional[str] = None
    enabled:      Optional[bool] = None


@router.patch("/ticket-departments/{dept_id}", dependencies=[Depends(require_ticket_desk)])
def update_ticket_department(dept_id: str, body: TicketDepartmentUpdate,
                             user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """The Tickets module's settings for one global department: who gets the
    escalation email for it (see escalate_ticket) and whether intake offers it.
    The name is the global one and cannot be changed from here."""
    if body.name is not None:
        raise HTTPException(410, _MANAGED_GLOBALLY)
    g = db.query(models.HrDepartment).filter(models.HrDepartment.id == dept_id).first()
    if not g:
        raise HTTPException(404, "Department not found")
    _sync_ticket_departments(db, g.company_id)
    row = db.query(models.TicketDepartment).filter(models.TicketDepartment.id == dept_id).first()
    if not row:
        raise HTTPException(404, "Department not found")
    if body.lead_email is not None:
        row.lead_email = (body.lead_email or "").strip().lower()
    if body.backup_email is not None:
        row.backup_email = (body.backup_email or "").strip().lower()
    if body.enabled is not None:
        row.enabled = bool(body.enabled)
    db.commit()
    return _dept_list(db, g.company_id)


class TicketDepartmentOrder(BaseModel):
    company_id: str
    ids: list[str]


@router.put("/ticket-departments/order", dependencies=[Depends(require_ticket_desk)])
def reorder_ticket_departments(body: TicketDepartmentOrder, user: dict = Depends(require_manager),
                               db: Session = Depends(get_db)):
    """Saves a company's department order, as dragged in Settings - the order
    the Submit a Ticket dropdown lists them in (Neil, Sep 30: IT first, then
    Construction, Admin, Operations). Ids missing from the list (a department
    added in another tab meanwhile) keep their relative order after the rest;
    ids from another company are ignored."""
    _sync_ticket_departments(db, body.company_id)
    rows = (db.query(models.TicketDepartment).filter(models.TicketDepartment.company_id == body.company_id)
            .order_by(models.TicketDepartment.sort_order, models.TicketDepartment.name).all())
    pos = {dept_id: n for n, dept_id in enumerate(body.ids)}
    rows.sort(key=lambda d: (pos.get(d.id, len(pos)), d.sort_order or 0))
    for n, d in enumerate(rows):
        d.sort_order = n
    db.commit()
    return _dept_list(db, body.company_id)


@router.delete("/ticket-departments/{dept_id}", dependencies=[Depends(require_ticket_desk)])
def delete_ticket_department(dept_id: str, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """Gone with the merge - turn the department off for tickets instead, or
    delete it from the company's global list."""
    raise HTTPException(410, _MANAGED_GLOBALLY)



@router.get("/ticket-sites")
def list_ticket_sites(db: Session = Depends(get_db)):
    """Work sites, for the intake form's Facility / Site questions.

    A ticket-scoped mirror of /hr/work-sites, which sits behind an HR module
    grant - the person reporting a camera down at a storage facility is
    exactly the person who does not have one, and a picker they cannot load
    is a required field they cannot answer. Names only: no address, no
    coordinates, no geofence radius, so this exposes nothing beyond the list
    of places the company operates. Same reason /ticket-companies and
    /ticket-departments exist rather than the modules' own endpoints."""
    rows = db.query(models.HrWorkSite).order_by(models.HrWorkSite.name).all()
    return [{"id": s.id, "name": s.name} for s in rows]


# ── Ticket components / categories ───────────────────────────────────────────
class ComponentBody(BaseModel):
    id: Optional[str] = None
    name: str


@router.get("/task-ticket-components")
def list_ticket_components(db: Session = Depends(get_db)):
    return [{"id": c.id, "name": c.name} for c in db.query(models.TaskTicketComponent).order_by(models.TaskTicketComponent.name).all()]


@router.post("/task-ticket-components", status_code=201, dependencies=[Depends(require_ticket_desk)])
def create_ticket_component(body: ComponentBody, db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Component name is required")
    c = models.TaskTicketComponent(id=body.id or gen_id(), name=body.name.strip(), created_at=now_iso())
    db.add(c)
    db.commit()
    db.refresh(c)
    return {"id": c.id, "name": c.name}


@router.delete("/task-ticket-components/{component_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket_component(component_id: str, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    # Components are desk-wide configuration with no owner, so removing one
    # takes a manager (the same manager+ bar as _ticket_privileged) - not any
    # agent with a tickets grant. Tickets filed under it keep the name.
    if (user.get("level") or 0) < 3:
        raise HTTPException(403, "Only a manager can delete a component")
    c = db.query(models.TaskTicketComponent).filter(models.TaskTicketComponent.id == component_id).first()
    if not c:
        raise HTTPException(404, "Component not found")
    db.delete(c)
    db.commit()


# ── Approvals ────────────────────────────────────────────────────────────────
# Service and access requests are parked the moment they are raised: pending,
# with no approver named. They go to the IT Admin pool, an admin sends the
# ticket to whoever should sign it off (request_approval), and only once that
# person approves can the ticket be assigned. Rejecting closes it. Every step
# lands on the ticket and in the activity log.
#
# The requester never names their own approver and the server never guesses one.
class ApprovalRequestBody(BaseModel):
    approver_email: str
    note: Optional[str] = ""


@router.post("/task-tickets/{ticket_id}/request-approval", dependencies=[Depends(require_ticket_desk)])
def request_approval(ticket_id: str, body: ApprovalRequestBody, background_tasks: BackgroundTasks,
                     user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """IT Admin routes a parked request to the person who signs it off."""
    t = _ticket_or_404(db, ticket_id)
    actor = user["email"].lower()
    # Desk only. This is the control itself - if the requester could pick who
    # approves their own request, there is no approval.
    if not _is_agent(db, user):
        raise HTTPException(403, "Only a ticket agent can send a ticket for approval.")
    if (t.approval_status or "none") == "none":
        raise HTTPException(409, "This ticket does not require approval.")
    if t.approval_status != "pending":
        raise HTTPException(409, f"This ticket was already {t.approval_status}.")

    approver = (body.approver_email or "").strip().lower()
    if not approver:
        raise HTTPException(422, "An approver is required.")
    if approver == (t.requester_email or "").lower():
        raise HTTPException(422, "A request cannot be approved by the person who raised it.")

    resent = bool(t.approver_email) and t.approver_email != approver
    t.approver_email = approver
    t.modified_at = now_iso()
    note = (body.note or "").strip()
    log_activity(db, type="approval_requested", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail=("re-routed" if resent else "sent") + f" for approval to {approver}"
                        + (f": {note}" if note else ""))
    tk_action = {"view": "tickets", "label": "View ticket"}
    if approver != actor:
        task_notify(db, kind="ticket_needs_approval", for_email=approver,
                    title="A ticket needs your approval",
                    body=f"{ticket_no(t.code)} · {t.subject}", ticket_id=t.id, nexus_action=tk_action)
    _tell_requester(db, t, user["email"], f"Sent to {_name_of(db, approver)} for approval")
    db.commit()
    db.refresh(t)
    background_tasks.add_task(notify_ticket_event, t.id, "approval_required", user["email"])
    return ticket_to_dict(t)


class ApprovalBody(BaseModel):
    decision: str                      # approve | reject
    note: Optional[str] = ""


@router.post("/task-tickets/{ticket_id}/approval", dependencies=[Depends(require_ticket_desk)])
def decide_approval(ticket_id: str, body: ApprovalBody, background_tasks: BackgroundTasks,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    actor = user["email"].lower()
    decision = (body.decision or "").strip().lower()
    if decision not in ("approve", "reject"):
        raise HTTPException(422, "decision must be 'approve' or 'reject'")
    if (t.approval_status or "none") == "none":
        raise HTTPException(409, "This ticket does not require approval.")
    if t.approval_status != "pending":
        raise HTTPException(409, f"This ticket was already {t.approval_status}.")
    # Only the named approver decides. Administrators can act too, so a departed or
    # unavailable approver can't deadlock a request forever.
    if actor != (t.approver_email or "") and user.get("level", 1) < 4:
        raise HTTPException(403, "Only the named approver can decide this ticket.")

    note = (body.note or "").strip()
    if decision == "reject" and not note:
        raise HTTPException(422, "A reason is required when rejecting.")

    t.approval_status = "approved" if decision == "approve" else "rejected"
    t.approval_note = note
    t.approval_decided_at = now_iso()
    t.modified_at = now_iso()

    tk_action = {"view": "tickets", "label": "View ticket"}
    if decision == "approve":
        log_activity(db, type="approved", actor_email=user["email"], entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail="approved this request" + (f": {note}" if note else ""))
        # Released - now it enters the normal triage queue.
        _notify_triage(db, t, actor)
        if t.requester_email and t.requester_email != actor:
            task_notify(db, kind="ticket_approved", for_email=t.requester_email,
                        title="Your request was approved",
                        body=f"{ticket_no(t.code)} · {t.subject}", ticket_id=t.id, nexus_action=tk_action)
    else:
        # Rejected requests are closed - nothing downstream should act on them.
        t.status = "closed"
        t.resolution = "wont_fix"
        t.resolved_at = now_iso()
        log_activity(db, type="rejected", actor_email=user["email"], entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=f"rejected this request: {note}")
        if t.requester_email and t.requester_email != actor:
            task_notify(db, kind="ticket_rejected", for_email=t.requester_email,
                        title="Your request was rejected",
                        body=f"{ticket_no(t.code)} · {t.subject} - {note}", ticket_id=t.id, nexus_action=tk_action)
    db.commit()
    db.refresh(t)
    # Approved → the dept head now gets the "needs assignment" email that was
    # held back at creation while the ticket sat behind the approval gate.
    if decision == "approve":
        background_tasks.add_task(notify_ticket_event, t.id, "created", actor, only_roles=("it_admin",))
    return ticket_to_dict(t)


# ── Ticket ↔ ticket links (adds the inverse link on the other ticket too) ─────
_LINK_INVERSE = {"relates": "relates", "duplicate": "duplicate", "blocks": "blocked_by", "blocked_by": "blocks"}


class TicketLinkBody(BaseModel):
    ticket_id: str
    type: Optional[str] = "relates"


@router.post("/task-tickets/{ticket_id}/links", status_code=201, dependencies=[Depends(require_ticket_desk)])
def add_ticket_link(ticket_id: str, body: TicketLinkBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    if body.ticket_id == ticket_id:
        raise HTTPException(422, "A ticket cannot be linked to itself")
    other = _ticket_or_404(db, body.ticket_id)
    typ = body.type if body.type in _LINK_INVERSE else "relates"
    t.links = [l for l in (t.links or []) if l.get("ticketId") != other.id] + [{"ticketId": other.id, "type": typ}]
    other.links = [l for l in (other.links or []) if l.get("ticketId") != t.id] + [{"ticketId": t.id, "type": _LINK_INVERSE[typ]}]
    log_activity(db, type="linked", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=f"linked {other.code} ({typ.replace('_', ' ')})")
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


@router.delete("/task-tickets/{ticket_id}/links/{target_id}", dependencies=[Depends(require_ticket_desk)])
def remove_ticket_link(ticket_id: str, target_id: str, db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    t.links = [l for l in (t.links or []) if l.get("ticketId") != target_id]
    other = db.query(models.TaskTicket).filter(models.TaskTicket.id == target_id).first()
    if other:
        other.links = [l for l in (other.links or []) if l.get("ticketId") != ticket_id]
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


# ── Escalate - a distress flare, not a priority bump: alerts the department
#    head that this ticket needs instant care (Pranshu, Sep 8 2026) ───────────
@router.post("/task-tickets/{ticket_id}/escalate")
def escalate_ticket(ticket_id: str, background_tasks: BackgroundTasks,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The assignee or a manager - whoever is actually working the ticket -
    can raise this any time it's open. The requester is different: escalating
    before the SLA is even due would just be "I'm impatient," not "this is
    overdue" - so for them it's gated on the SLA actually being breached
    (Pranshu, Sep 10 2026, reinstating that carve-out). It no longer touches
    priority; it mails the department the ticket is ABOUT
    (TicketDepartment.lead_email/backup_email, set from Manage -> Service Desk ->
    Departments) that the ticket needs urgent attention. A department with no
    head on file falls back to the company's ticket agents via
    notify_ticket_event's own recipient resolution, so it's never emailed to
    nobody."""
    t = _ticket_or_404(db, ticket_id)
    _require_ticket_participant(db, user, t)
    email = (user["email"] or "").lower()
    is_requester = (t.requester_email or "").lower() == email
    is_assignee = (t.assignee_email or "").lower() == email
    privileged = _ticket_privileged(db, t, user)
    # Closed-status check first: a requester hitting this on a closed ticket
    # should hear "already closed," not a confusing SLA-gate 403 - and
    # _sla_breached itself always reads a closed ticket as never breached, so
    # checking access first would never let them reach this message at all.
    if t.status in ("resolved", "closed"):
        raise HTTPException(400, "This ticket is already closed out - nothing to escalate")
    if not (is_assignee or privileged or (is_requester and _sla_breached(t))):
        if is_requester:
            raise HTTPException(403, "You can escalate once the SLA due date has passed - it hasn't yet.")
        raise HTTPException(403, "Only the requester or assignee can escalate this ticket")

    t.modified_at = now_iso()
    log_activity(db, type="escalated", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail="Escalated - flagged for the department head's urgent attention")
    _notify_participants(db, t, user["email"], kind="ticket_escalated",
                         title="Ticket escalated", body=f"{ticket_no(t.code)} · {t.subject} needs urgent attention")
    task_notify(db, kind="ticket_escalated", for_email="admins", title="A ticket was escalated",
                body=f"{ticket_no(t.code)} · {t.subject}",
                ticket_id=t.id, nexus_action={"view": "tickets", "label": "View ticket"})
    db.commit()
    db.refresh(t)
    background_tasks.add_task(notify_ticket_event, t.id, "escalated", user["email"])
    return ticket_to_dict(t)


@router.get("/task-tickets/my-access")
def my_ticket_access(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Is the caller on the service desk? Drives whether the UI offers the desk
    queues and Send for Approval.

    Its own endpoint because the desk list lives in the notification settings,
    and those are manager+ only - an agent who is not a manager could not read
    their own membership from there. Returns booleans rather than the roster:
    knowing whether YOU are on it is not the same as being handed everyone who
    is. The backend re-checks on every action regardless; this only decides what
    to render.

    `onDesk`  - the queues are your work (drives To Route / To Assign).
    `canAct`  - you may step in on a ticket (drives Send for Approval).

    They differ for an administrator who is not on the roster: they can still
    unstick a ticket, but the desk's queues are not their inbox."""
    return {"onDesk": _on_desk(db, user), "canAct": _is_agent(db, user)}


# ── Notification settings + delivery log (admin) ──────────────────────────────
@router.get("/task-tickets/notify/settings", dependencies=[Depends(require_ticket_desk)])
def get_ticket_notify_settings(user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    return get_notify_settings(db)


@router.put("/task-tickets/notify/settings", dependencies=[Depends(require_ticket_desk)])
def put_ticket_notify_settings(patch: dict, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    return save_notify_settings(db, patch, user["email"])


# ── Taxonomy settings (admin): SLA target hours + per-type intake fields ──────
# GET is read-only config every ticket submitter needs (ticketConfig.js's
# useTicketConfig runs for any employee opening the create-ticket form, not
# just managers) - gating it behind require_manager 401'd employees there,
# and api.js treats a 401 as a dead session and force-redirects to login,
# which looked like Nexus randomly logging people out (Sep 17 2026).
@router.get("/task-tickets/taxonomy/settings")
def get_ticket_taxonomy_settings(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return ticket_taxonomy.get_config(db)


@router.put("/task-tickets/taxonomy/settings")
def put_ticket_taxonomy_settings(patch: dict, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    try:
        return ticket_taxonomy.save_config(db, patch, user["email"])
    except ticket_taxonomy.TaxonomyError as e:
        raise HTTPException(400, str(e))


@router.get("/task-tickets/notify/log", dependencies=[Depends(require_ticket_desk)])
def get_ticket_notify_log(ticket_id: str = "", status: str = "", limit: int = 20, offset: int = 0,
                          user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    q = db.query(models.TicketEmailLog)
    if ticket_id:
        q = q.filter(models.TicketEmailLog.ticket_id == ticket_id)
    if status:
        q = q.filter(models.TicketEmailLog.status == status)
    total = q.count()
    rows = q.order_by(models.TicketEmailLog.created_at.desc()).offset(offset).limit(min(limit, 500)).all()
    return {"rows": [{
        "id": r.id, "ticketId": r.ticket_id, "ticketCode": r.ticket_code, "eventType": r.event_type,
        "eventVersion": r.event_version, "recipient": r.recipient, "recipientRole": r.recipient_role,
        "subject": r.subject, "status": r.status, "graphMessageId": r.graph_message_id,
        "conversationId": r.conversation_id, "attempts": r.attempts, "error": r.error,
        "createdAt": r.created_at, "updatedAt": r.updated_at,
    } for r in rows], "total": total}


@router.get("/task-tickets/notify/teams-log", dependencies=[Depends(require_ticket_desk)])
def get_ticket_teams_dm_log(ticket_id: str = "", sent: str = "", limit: int = 200,
                            user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """Same shape as get_ticket_notify_log, for the Teams DM queue
    (_queue_requester_teams_dm / teams_post.py) - lets the desk see whether a
    queued row delivered, and if not, why (send_error), without DB access.
    `sent`: "1" or "0" to filter, blank for both."""
    q = db.query(models.TicketTeamsMessage)
    if ticket_id:
        q = q.filter(models.TicketTeamsMessage.ticket_id == ticket_id)
    if sent in ("0", "1"):
        q = q.filter(models.TicketTeamsMessage.sent == int(sent))
    rows = q.order_by(models.TicketTeamsMessage.created_at.desc()).limit(min(limit, 500)).all()
    return [{
        "id": r.id, "ticketId": r.ticket_id, "agentEmail": r.agent_email, "requesterEmail": r.requester_email,
        "chatId": r.chat_id, "sent": bool(r.sent), "attempts": r.attempts, "lastTryAt": r.last_try_at,
        "sendError": r.send_error, "createdAt": r.created_at,
    } for r in rows]

