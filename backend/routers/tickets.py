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
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any

import models
from database import get_db
from auth import get_current_user, require_manager, require_any_module_grant
from routers.task_util import now_iso, gen_id, log_activity, task_notify
from ticket_code import TICKET_CODE_DIGITS, ticket_no
from ticket_notify import (notify_ticket_event, get_settings as get_notify_settings,
                           save_settings as save_notify_settings, ticket_agents)

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


def _has_desk_grant(user: dict, db: Session) -> bool:
    """Whether this caller may see the desk side. The dependency form raises;
    this is the boolean the scoped endpoints branch on."""
    from auth import _grants_for, _LEVELS, _MODULE_LEVEL_RANK
    if user.get("level", 0) >= _LEVELS["administrator"]:
        return True
    grants = _grants_for(user.get("email") or "", db)
    return any(grants.get(m, 0) >= _MODULE_LEVEL_RANK["viewer"] for m in ("tasks", "tickets"))


def _require_ticket_participant(db: Session, user: dict, t) -> None:
    """A ticket's own requester/watchers/assignee may read and comment on it
    without any module grant - it is their support request. Everyone else needs
    the desk grant."""
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
#    filter set: {scope,status,priority,type,component,sla,search,groupBy,view}) ──
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
def delete_ticket_view(view_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskSavedView).filter(models.TaskSavedView.id == view_id).delete()
    db.commit()



# ── Tickets ──────────────────────────────────────────────────────────────────
def ticket_to_dict(t: models.TaskTicket) -> dict:
    return {"id": t.id, "code": t.code or "", "subject": t.subject, "description": t.description or "",
            "type": t.type or "request",
            "status": t.status or "new", "priority": t.priority or "medium",
            "requesterId": _nz(t.requester_email), "assigneeId": _nz(t.assignee_email),
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
            "csatRating": t.csat_rating or 0, "csatComment": _nz(t.csat_comment),
            "approvalStatus": t.approval_status or "none", "approverId": _nz(t.approver_email),
            "approvalNote": _nz(t.approval_note), "approvalDecidedAt": _nz(t.approval_decided_at),
            "slaDueOn": _nz(t.sla_due_on), "resolvedAt": _nz(t.resolved_at),
            "createdAt": t.created_at or "", "modifiedAt": t.modified_at or ""}


# ── Approval workflow rules ──────────────────────────────────────────────────
# Which types are gated. Everything else goes straight to the fulfilment queue.
#
# These three commit somebody else's money, access or production config, so a
# second person signs off. A bug report or a question commits nothing, and
# gating those would only add a step between a user and help.
APPROVAL_REQUIRED_TYPES = {"service_request", "change_request", "access_request"}

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


def _it_admins(db: Session) -> list:
    """The service desk - who new tickets are announced to.

    Chosen in Ticket -> Manage (ticket_agents). Deliberately "irrespective of
    departments": one desk sees everything that comes in, decides what needs
    approval, and hands the work out."""
    return [e for e in (ticket_agents(db) or []) if e]


def _on_desk(db: Session, user: dict) -> bool:
    """Is this person actually ON the service desk roster?

    Membership, nothing else - an administrator who was not picked in Manage is
    not on the desk. This is what decides whether the desk QUEUES are somebody's
    work, and it has to agree with who gets the bells: an off-desk admin who
    stops being notified about new tickets must also stop being shown a queue
    telling them to assign those tickets."""
    email = (user.get("email") or "").strip().lower()
    return email in {e.lower() for e in _it_admins(db)}


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
    for em in dict.fromkeys(e.lower() for e in _it_admins(db)):
        if em == actor:
            continue   # they raised/approved it themselves; they can already see it
        task_notify(db, kind="ticket_needs_assignment", for_email=em,
                    title=title, body=f"{ticket_no(t.code)} · {t.subject}", nexus_action=tk_action)


class TicketBody(BaseModel):
    id: Optional[str] = None
    code: Optional[str] = None
    subject: str
    description: Optional[str] = ""
    type: Optional[str] = "request"
    status: Optional[str] = "new"
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
    sla_due_on: Optional[str] = ""


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
    csat_rating: Optional[int] = None
    csat_comment: Optional[str] = None
    sla_due_on: Optional[str] = None
    resolved_at: Optional[str] = None
    # Not a ticket column - used only to build the "Reopened" notification's
    # "Reason" line and its activity-log entry, then discarded.
    reopen_reason: Optional[str] = None


def _next_ticket_code(db: Session) -> str:
    """One past the highest number issued so far.

    Was `count() + 1`, which is only correct while nothing is ever deleted:
    delete any ticket and the next one issued reuses a live number, so two
    tickets share a code and every reference to it becomes ambiguous. Counting
    what exists answers "how many", not "what comes next".

    Legacy "TKT-nnn" codes are read for their digits too, so the sequence
    continues past them rather than restarting into numbers already in use."""
    highest = 0
    for (code,) in db.query(models.TaskTicket.code).all():
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


def _notify_participants(db: Session, t: models.TaskTicket, actor_email: str, kind: str,
                         title: str, body: str, exclude: set | None = None):
    """Notify a ticket's participants (watchers/assignee/requester) except the actor
    and anyone in `exclude` (e.g. the requester, for internal notes)."""
    action = {"view": "tickets", "label": "View ticket"}
    skip = {(actor_email or "").lower()} | {e.lower() for e in (exclude or set())}
    for email in _ticket_participants(t):
        if email in skip:
            continue
        task_notify(db, kind=kind, for_email=email, title=title, body=body, nexus_action=action)


@router.get("/task-tickets")
def list_tickets(mine: bool = False, user: dict = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    """`mine=true` narrows to the tickets this person raised or is watching -
    what the Support page's end-user view needs.

    Scoped server-side rather than filtered in the browser: the unscoped list is
    the agent queue and carries every ticket in the company, so a client-side
    filter would still ship all of them to an employee's browser. Default is
    unchanged, so the Tickets module is unaffected."""
    rows = db.query(models.TaskTicket).all()
    # Without the desk grant the scope is forced, not requested: the unscoped
    # list IS the agent queue, so honouring `mine` only when asked would leave
    # the whole company's tickets one query parameter away from any employee.
    if mine or not _has_desk_grant(user, db):
        me = (user.get("email") or "").lower()
        rows = [t for t in rows
                if (t.requester_email or "").lower() == me
                or me in [(w or "").lower() for w in (t.watcher_emails or [])]]
    return [ticket_to_dict(t) for t in rows]


@router.post("/task-tickets", status_code=201)
def create_ticket(body: TicketBody, background_tasks: BackgroundTasks,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    # Anyone signed in may raise a ticket - that is the whole point of a help
    # desk. Raising one ON SOMEONE ELSE'S BEHALF is a desk action, though, so
    # without the grant the requester is forced to the caller rather than taken
    # from the payload.
    if body.requester_email and not _has_desk_grant(user, db):
        body.requester_email = user["email"]
    t = models.TaskTicket(
        id=body.id or gen_id(), code=body.code or _next_ticket_code(db), subject=body.subject,
        description=body.description or "", type=body.type or "request",
        status=body.status or "new", priority=body.priority or "medium",
        requester_email=(body.requester_email or user["email"]).strip().lower(),
        assignee_email=(body.assignee_email or "").strip().lower(), department_id=body.department_id or "",
        # Resolved from the requester's People record when intake did not send
        # one - the form no longer asks. Still honours an explicit value so an
        # agent raising a ticket on someone else's behalf can override it.
        company_id=(body.company_id or company_for(db, (body.requester_email or user["email"]))),
        hr_department_id=body.hr_department_id or "",
        linked_task_id=body.linked_task_id or "", tags=body.tags or [], images=body.images or [],
        watcher_emails=body.watcher_emails or [], resolution=body.resolution or "",
        custom_field_values=body.custom_field_values or {}, type_fields=body.type_fields or {}, links=[], task_ids=[],
        component=body.component or "", csat_rating=0, csat_comment="",
        sla_due_on=body.sla_due_on or "", resolved_at="", created_at=now, modified_at=now,
    )
    # Approval gate, decided by the TYPE and never trusted from the client, so a
    # caller cannot post approval_status="approved" to skip it.
    #
    # No approver is named here. A gated ticket parks as pending with the
    # approver still blank: it goes to the IT Admin pool first, and an admin
    # sends it on to whoever should sign it off (request_approval below). The
    # requester never chooses their own approver, and neither does the server
    # guess - the desk that sees the request decides who it needs.
    t.approver_email = ""
    t.approval_status = "pending" if (t.type or "") in APPROVAL_REQUIRED_TYPES else "none"
    if t.approval_status == "pending" and t.assignee_email:
        # Same rule update_ticket enforces, applied at the door: a request cannot
        # be born already assigned, or the gate is skippable by whoever files it.
        raise HTTPException(409, "This request needs approval - it can be assigned once approved.")
    db.add(t)
    log_activity(db, type="created", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail="created this ticket")
    tk_action = {"view": "tickets", "label": "View ticket"}
    if t.assignee_email and t.assignee_email != user["email"].lower():
        task_notify(db, kind="ticket_assigned", for_email=t.assignee_email,
                    title="You were assigned a ticket", body=f"{ticket_no(t.code)} · {t.subject}", nexus_action=tk_action)
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
                    title="We received your ticket", body=f"{ticket_no(t.code)} · {t.subject}", nexus_action=tk_action)
    db.commit()
    db.refresh(t)
    background_tasks.add_task(notify_ticket_event, t.id, "created", user["email"])
    # No approval email here: a gated ticket has no approver yet, so there is
    # nobody to send one to. request_approval sends it once an IT Admin names one.
    return ticket_to_dict(t)


# Fields left open to whoever is just working a ticket (the assignee, or
# anyone else without ownership of it) - enough to triage, reassign and close
# it out, not to rewrite what it is or who it's for. Everyone else (the
# requester, or a manager+) gets the full field set. Mirrors the drawer's field
# gating in TicketsView.jsx - keep the two in step.
_WORKING_FIELDS = {"type", "status", "priority", "assignee_email", "hr_department_id", "resolution"}
# Every field an unrestricted caller may touch, minus reopen_reason (not a
# column - see TicketUpdate).
_ALL_TICKET_FIELDS = set(TicketUpdate.model_fields.keys()) - {"reopen_reason"}


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
    Manager+ is unrestricted throughout, including company_id."""
    email = user["email"].lower()
    if _ticket_privileged(db, t, user):
        return None
    if t.status == "in_progress" and t.assignee_email:
        return (_ALL_TICKET_FIELDS - {"company_id"}) if email == t.assignee_email.lower() else set()
    if (t.requester_email or "").lower() == email:                   # who raised it, pre-in_progress
        return None
    return _WORKING_FIELDS


@router.patch("/task-tickets/{ticket_id}", dependencies=[Depends(require_ticket_desk)])
def update_ticket(ticket_id: str, body: TicketUpdate, background_tasks: BackgroundTasks,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    data = body.model_dump(exclude_unset=True)
    reopen_reason = data.pop("reopen_reason", "") or ""   # not a column - see TicketUpdate
    scope = _ticket_edit_scope(db, t, user)
    if scope is not None:
        blocked = sorted(set(data.keys()) - scope)
        if blocked:
            if not scope:
                raise HTTPException(403, f"This ticket is in progress and assigned to {t.assignee_email or 'someone else'} - only they (or a manager) can edit it right now.")
            if blocked == ["company_id"]:
                raise HTTPException(403, "Only the requester (before the ticket is picked up) or a manager can change the company on a ticket.")
            raise HTTPException(403, f"You can only update {', '.join(sorted(scope))} on a ticket you're not the requester/owner of - not: {', '.join(blocked)}")
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
    for k, v in data.items():
        if k in ("assignee_email",) and v is not None:
            # strip() too - a padded address never matches the same person again,
            # so the ticket is assigned to somebody who never sees it.
            v = (v or "").strip().lower()
        setattr(t, k, v)
    if data.get("status") in ("resolved", "closed") and not t.resolved_at:
        t.resolved_at = now_iso()
    if data.get("status") not in ("resolved", "closed") and "status" in data:
        t.resolved_at = ""
        t.resolution = ""

    # ── Keep the approval gate in step with the ticket ────────────────────────
    # The gate is decided by the TYPE, so re-typing a ticket has to re-decide it.
    # Without this a request raised as a Bug Report (ungated) and then re-typed to
    # an Access Request kept approval_status "none" - it read as an access request
    # everywhere while never having been approved by anyone, which is precisely
    # the thing the gate exists to prevent.
    if (t.type or "") != prev_type:
        now_gated = (t.type or "") in APPROVAL_REQUIRED_TYPES
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
    def _log(kind, detail):
        log_activity(db, type=kind, actor_email=user["email"], entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=detail)
    tk_action = {"view": "tickets", "label": "View ticket"}
    status_changed = "status" in data and t.status != prev_status
    assignee_changed = "assignee_email" in data and (t.assignee_email or "") != prev_assignee
    if status_changed:
        _log("status_changed", f"changed status to {t.status}")
        if t.status in ("resolved", "closed") and t.requester_email and t.requester_email != user["email"].lower():
            task_notify(db, kind="ticket_resolved", for_email=t.requester_email,
                        title=f"Your ticket was {t.status}", body=f"{ticket_no(t.code)} · {t.subject}", nexus_action=tk_action)
        else:
            # keep watchers (and requester/assignee) in the loop on any status move
            _notify_participants(db, t, user["email"], kind="ticket_status",
                                 title=f"Ticket moved to {t.status}", body=f"{ticket_no(t.code)} · {t.subject}")
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
                        title="You were assigned a ticket", body=f"{ticket_no(t.code)} · {t.subject}", nexus_action=tk_action)
    if "priority" in data and t.priority != prev_priority:
        _log("priority_changed", f"set priority to {t.priority}")
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

    t.modified_at = now_iso()
    db.commit()
    db.refresh(t)

    # ── Outlook notifications (best-effort, after commit - see ticket_notify.py) ──
    actor = user["email"]
    if assignee_changed and t.assignee_email:
        # Reassignment uses the "assigned" flow exclusively - spec lists reassignment
        # under both "assigned" (§2) and generic "update" (§3) triggers, but firing
        # both would double-email the same change; §2's is the richer one.
        background_tasks.add_task(notify_ticket_event, t.id, "assigned", actor)
    elif status_changed and t.status == "reopened":
        background_tasks.add_task(notify_ticket_event, t.id, "reopened", actor, reopen_reason=reopen_reason)
    elif status_changed and t.status in ("resolved", "closed") and prev_status not in ("resolved", "closed"):
        background_tasks.add_task(notify_ticket_event, t.id, "resolved", actor)
    elif status_changed:
        background_tasks.add_task(notify_ticket_event, t.id, "updated", actor,
                                   prev_status=prev_status, update_kind=f"Status changed to {t.status}")
    elif "priority" in data and t.priority != prev_priority:
        background_tasks.add_task(notify_ticket_event, t.id, "updated", actor,
                                   update_kind=f"Priority changed to {t.priority}")
    elif "sla_due_on" in data and t.sla_due_on != prev_due:
        background_tasks.add_task(notify_ticket_event, t.id, "updated", actor, update_kind="Due date changed")
    elif "resolution" in data or "description" in data or "type" in data or "hr_department_id" in data:
        background_tasks.add_task(notify_ticket_event, t.id, "updated", actor, update_kind="Ticket details updated")

    return ticket_to_dict(t)


@router.delete("/task-tickets/{ticket_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    # Independent of the in_progress/assignee edit lock above - deleting stays
    # with whoever raised it or owns the queue, never just the assignee.
    is_requester = (t.requester_email or "").lower() == user["email"].lower()
    if not (_ticket_privileged(db, t, user) or is_requester):
        raise HTTPException(403, "Only the requester or a manager can delete a ticket")
    # clean up the ticket's conversation / attachments / activity too
    db.query(models.TaskComment).filter(models.TaskComment.task_id == ticket_id).delete()
    db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == ticket_id).delete()
    db.query(models.TaskActivity).filter(models.TaskActivity.entity_kind == "ticket",
                                         models.TaskActivity.entity_id == ticket_id).delete()
    db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).delete()
    db.commit()


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
    _require_ticket_participant(db, user, _ticket_or_404(db, ticket_id))
    rows = db.query(models.TaskComment).filter(models.TaskComment.task_id == ticket_id).order_by(models.TaskComment.created_at).all()
    return [_tcomment(c) for c in rows]


@router.post("/task-tickets/{ticket_id}/comments", status_code=201)
def add_ticket_comment(ticket_id: str, body: TicketCommentBody, background_tasks: BackgroundTasks,
                       user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    # Replying on your own ticket needs no grant; an internal note does, since
    # those are the desk talking among themselves and are hidden from the
    # requester.
    _require_ticket_participant(db, user, t)
    internal = bool(body.internal) and _has_desk_grant(user, db)
    c = models.TaskComment(id=gen_id(), task_id=ticket_id, author_email=user["email"], body=body.body or "",
                           internal=internal, created_at=now_iso())
    db.add(c)
    log_activity(db, type="commented", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail="added an internal note" if internal else "commented")
    # Internal notes stay with the agents - don't ping the requester.
    _notify_participants(db, t, user["email"], kind="ticket_comment",
                         title="Internal note on a ticket" if internal else "New comment on a ticket",
                         body=f"{ticket_no(t.code)} · {t.subject}",
                         exclude={(t.requester_email or "").lower()} if internal else None)
    db.commit()
    db.refresh(c)
    if not internal and get_notify_settings(db).get("commentsTrigger", True):
        background_tasks.add_task(notify_ticket_event, t.id, "updated", user["email"],
                                   # Full comment text - the email renders it in its own
                                   # quote block, so no truncation (was capped at 280).
                                   update_kind="New comment added", latest_comment=body.body or "")
    return _tcomment(c)


@router.delete("/task-tickets/comments/{comment_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket_comment(comment_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).delete()
    db.commit()


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
    db.commit()
    db.refresh(a)
    if get_notify_settings(db).get("attachmentsTrigger", True):
        background_tasks.add_task(notify_ticket_event, t.id, "updated", user["email"],
                                   update_kind=f'Attachment added: "{a.name}"')
    return _tattachment(a)


@router.delete("/task-tickets/attachments/{attachment_id}", status_code=204, dependencies=[Depends(require_ticket_desk)])
def delete_ticket_attachment(attachment_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskAttachment).filter(models.TaskAttachment.id == attachment_id).delete()
    db.commit()


@router.get("/task-tickets/{ticket_id}/activity")
def list_ticket_activity(ticket_id: str, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    _require_ticket_participant(db, user, _ticket_or_404(db, ticket_id))
    rows = (db.query(models.TaskActivity)
            .filter(models.TaskActivity.entity_kind == "ticket", models.TaskActivity.entity_id == ticket_id)
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


@router.get("/ticket-departments")
def list_ticket_departments(mine: bool = False, user: dict = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    """`mine=true` returns only the departments of the requester's own company.

    Intake no longer asks which company a ticket belongs to - a person works for
    one, the server knows which, and picking it was a question with exactly one
    right answer that a requester could still get wrong. Default is unchanged so
    the agent queue and Manage keep seeing every department."""
    q = db.query(models.HrDepartment)
    if mine:
        company = company_for(db, user.get("email") or "")
        # No People record -> no company -> no departments to offer. The ticket
        # is still valid without one; triage routes it.
        q = q.filter(models.HrDepartment.company_id == (company or "\x00"))
    rows = q.order_by(models.HrDepartment.sort_order, models.HrDepartment.name).all()
    return [{"id": d.id, "name": d.name, "companyId": d.company_id,
             "leadEmail": d.lead_email or "", "backupEmail": d.backup_email or ""} for d in rows]



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
def delete_ticket_component(component_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskTicketComponent).filter(models.TaskTicketComponent.id == component_id).delete()
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
                    body=f"{ticket_no(t.code)} · {t.subject}", nexus_action=tk_action)
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
                        body=f"{ticket_no(t.code)} · {t.subject}", nexus_action=tk_action)
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
                        body=f"{ticket_no(t.code)} · {t.subject} - {note}", nexus_action=tk_action)
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


# ── Escalate - bump priority one rung and alert assignee/watchers + managers ──
_PRIORITY_LADDER = ["low", "medium", "high", "urgent"]


@router.post("/task-tickets/{ticket_id}/escalate", dependencies=[Depends(require_ticket_desk)])
def escalate_ticket(ticket_id: str, background_tasks: BackgroundTasks,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    idx = _PRIORITY_LADDER.index(t.priority) if t.priority in _PRIORITY_LADDER else 1
    new_p = _PRIORITY_LADDER[min(idx + 1, len(_PRIORITY_LADDER) - 1)]
    t.priority = new_p
    t.modified_at = now_iso()
    log_activity(db, type="escalated", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=f"escalated to {new_p} priority")
    _notify_participants(db, t, user["email"], kind="ticket_escalated",
                         title=f"Ticket escalated to {new_p}", body=f"{ticket_no(t.code)} · {t.subject}")
    task_notify(db, kind="ticket_escalated", for_email="admins", title="A ticket was escalated",
                body=f"{ticket_no(t.code)} · {t.subject} → {new_p}",
                nexus_action={"view": "tickets", "label": "View ticket"})
    db.commit()
    db.refresh(t)
    background_tasks.add_task(notify_ticket_event, t.id, "updated", user["email"],
                               update_kind=f"Escalated to {new_p} priority")
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


@router.get("/task-tickets/notify/log", dependencies=[Depends(require_ticket_desk)])
def get_ticket_notify_log(ticket_id: str = "", status: str = "", limit: int = 200,
                          user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    q = db.query(models.TicketEmailLog)
    if ticket_id:
        q = q.filter(models.TicketEmailLog.ticket_id == ticket_id)
    if status:
        q = q.filter(models.TicketEmailLog.status == status)
    rows = q.order_by(models.TicketEmailLog.created_at.desc()).limit(min(limit, 500)).all()
    return [{
        "id": r.id, "ticketId": r.ticket_id, "ticketCode": r.ticket_code, "eventType": r.event_type,
        "eventVersion": r.event_version, "recipient": r.recipient, "recipientRole": r.recipient_role,
        "subject": r.subject, "status": r.status, "graphMessageId": r.graph_message_id,
        "conversationId": r.conversation_id, "attempts": r.attempts, "error": r.error,
        "createdAt": r.created_at, "updatedAt": r.updated_at,
    } for r in rows]

