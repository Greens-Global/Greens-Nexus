"""Ticket Module — router.

Split out of `task_config.py` (Jul 2026) so tickets own their own file. Routes,
payloads and behaviour are unchanged — only the file they live in moved.

Covers: tickets CRUD, per-ticket conversation/attachments/activity, saved ticket
views, components, ticket-to-ticket links, escalation, the company/department
lookups used at intake, and the department triage routing that notifies a
department's lead when an unassigned ticket arrives.

Ticket conversation/attachments/activity deliberately reuse the task comment and
attachment tables, keyed by ticket id — same storage, separate router.
"""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any

import models
from database import get_db
from auth import get_current_user, require_manager
from routers.task_util import now_iso, gen_id, log_activity, task_notify
from ticket_notify import notify_ticket_event, get_settings as get_notify_settings, save_settings as save_notify_settings

router = APIRouter(tags=["Tickets"], dependencies=[Depends(get_current_user)])


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
@router.get("/task-ticket-views")
def list_ticket_views(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.TaskSavedView)
            .filter(models.TaskSavedView.owner_email == user["email"].lower(),
                    models.TaskSavedView.scope == "ticket").all())
    return [saved_view_to_dict(s) for s in rows]


@router.post("/task-ticket-views", status_code=201)
def create_ticket_view(body: SavedViewBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    s = models.TaskSavedView(id=body.id or gen_id(), owner_email=user["email"].lower(), name=body.name,
                             view=body.view or "list", filters=body.filters or {}, sort=body.sort or {},
                             group=body.group or "none", scope="ticket", created_at=now_iso())
    db.add(s)
    db.commit()
    db.refresh(s)
    return saved_view_to_dict(s)


@router.delete("/task-ticket-views/{view_id}", status_code=204)
def delete_ticket_view(view_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskSavedView).filter(models.TaskSavedView.id == view_id).delete()
    db.commit()



# ── Tickets ──────────────────────────────────────────────────────────────────
def ticket_to_dict(t: models.TaskTicket) -> dict:
    return {"id": t.id, "code": t.code or "", "subject": t.subject, "description": t.description or "",
            "type": t.type or "request",
            "status": t.status or "new", "priority": t.priority or "medium",
            "requesterId": _nz(t.requester_email), "assigneeId": _nz(t.assignee_email),
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


# Which intake field names the approver, per ticket type. A ticket of one of these
# types whose approver field is filled must be approved before it reaches triage.
# Mirrors TYPE_FIELDS in frontend/src/tickets/ticketMeta.js — keep the two in step.
APPROVER_FIELD_BY_TYPE = {
    "service_request": "approver",
    "change_request":  "approver",
    "access_request":  "managerApproval",
}


def _notify_triage(db: Session, t: models.TaskTicket, actor: str) -> None:
    """Tell a department's lead (and backup) that an unassigned ticket is waiting
    to be handed to an employee. Called at creation for tickets needing no
    approval, and after an approval is granted for those that do — without this an
    unassigned ticket notifies nobody who can act on it and simply sits."""
    if t.assignee_email or not t.hr_department_id:
        return
    dept = (db.query(models.HrDepartment)
            .filter(models.HrDepartment.id == t.hr_department_id).first())
    if not dept:
        return
    tk_action = {"view": "tasks", "sub": "tickets", "label": "View ticket"}
    # dict.fromkeys: dedupe (lead may also be the backup) while keeping lead first.
    for em in dict.fromkeys(e for e in [(dept.lead_email or "").lower(),
                                        (dept.backup_email or "").lower()] if e):
        if em == actor:
            continue   # they raised/approved it themselves; they can already see it
        task_notify(db, kind="ticket_needs_assignment", for_email=em,
                    title="New ticket to assign",
                    body=f"{t.code} · {t.subject} ({dept.name})", nexus_action=tk_action)


def _approver_for(t: models.TaskTicket) -> str:
    """The approver named at intake, or "" when this type/ticket needs no approval."""
    key = APPROVER_FIELD_BY_TYPE.get(t.type or "")
    if not key:
        return ""
    tf = t.type_fields if isinstance(t.type_fields, dict) else {}
    return str(tf.get(key) or "").strip().lower()


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
    # Not a ticket column — used only to build the "Reopened" notification's
    # "Reason" line and its activity-log entry, then discarded.
    reopen_reason: Optional[str] = None


def _next_ticket_code(db: Session) -> str:
    return f"TKT-{db.query(models.TaskTicket).count() + 1:03d}"


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
    action = {"view": "tasks", "sub": "tickets", "label": "View ticket"}
    skip = {(actor_email or "").lower()} | {e.lower() for e in (exclude or set())}
    for email in _ticket_participants(t):
        if email in skip:
            continue
        task_notify(db, kind=kind, for_email=email, title=title, body=body, nexus_action=action)


@router.get("/task-tickets")
def list_tickets(db: Session = Depends(get_db)):
    return [ticket_to_dict(t) for t in db.query(models.TaskTicket).all()]


@router.post("/task-tickets", status_code=201)
def create_ticket(body: TicketBody, background_tasks: BackgroundTasks,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    t = models.TaskTicket(
        id=body.id or gen_id(), code=body.code or _next_ticket_code(db), subject=body.subject,
        description=body.description or "", type=body.type or "request",
        status=body.status or "new", priority=body.priority or "medium",
        requester_email=(body.requester_email or user["email"]).lower(),
        assignee_email=(body.assignee_email or "").lower(), department_id=body.department_id or "",
        company_id=body.company_id or "", hr_department_id=body.hr_department_id or "",
        linked_task_id=body.linked_task_id or "", tags=body.tags or [], images=body.images or [],
        watcher_emails=body.watcher_emails or [], resolution=body.resolution or "",
        custom_field_values=body.custom_field_values or {}, type_fields=body.type_fields or {}, links=[], task_ids=[],
        component=body.component or "", csat_rating=0, csat_comment="",
        sla_due_on=body.sla_due_on or "", resolved_at="", created_at=now, modified_at=now,
    )
    # Approval gate — derived from the intake fields, never trusted from the client,
    # so a caller can't post approval_status="approved" to skip the gate.
    approver = _approver_for(t)
    t.approver_email = approver
    t.approval_status = "pending" if approver else "none"
    db.add(t)
    log_activity(db, type="created", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail="created this ticket")
    tk_action = {"view": "tasks", "sub": "tickets", "label": "View ticket"}
    if t.assignee_email and t.assignee_email != user["email"].lower():
        task_notify(db, kind="ticket_assigned", for_email=t.assignee_email,
                    title="You were assigned a ticket", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    # Approval gate first: a ticket awaiting approval must NOT reach the department
    # lead yet — triage is notified only once it's approved (see decide_approval).
    elif t.approval_status == "pending" and t.approver_email:
        if t.approver_email != user["email"].lower():
            task_notify(db, kind="ticket_needs_approval", for_email=t.approver_email,
                        title="A ticket needs your approval",
                        body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    else:
        _notify_triage(db, t, user["email"].lower())
    # Intake acknowledgment — let the requester know their request landed (e.g. when a
    # manager logs it on their behalf; if they raised it themselves they're the actor).
    if t.requester_email and t.requester_email != user["email"].lower():
        task_notify(db, kind="ticket_received", for_email=t.requester_email,
                    title="We received your ticket", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    db.commit()
    db.refresh(t)
    background_tasks.add_task(notify_ticket_event, t.id, "created", user["email"])
    return ticket_to_dict(t)


# Fields left open to whoever is just working a ticket (the assignee, or
# anyone else without ownership of it) — enough to triage, reassign and close
# it out, not to rewrite what it is or who it's for. Everyone else (the
# requester, the ticket's department lead/backup, or a manager+) gets the
# full field set. Mirrors the drawer's field gating in TicketsView.jsx —
# keep the two in step.
_WORKING_FIELDS = {"type", "status", "priority", "assignee_email", "hr_department_id", "resolution"}


def _ticket_edit_scope(db: Session, t: models.TaskTicket, user: dict) -> set | None:
    """None = unrestricted. A set = the only TicketUpdate keys this caller may send."""
    email = user["email"].lower()
    if user.get("level", 1) >= 3:                                    # manager+
        return None
    if (t.requester_email or "").lower() == email:                   # who raised it
        return None
    if t.hr_department_id:
        dept = db.query(models.HrDepartment).filter(models.HrDepartment.id == t.hr_department_id).first()
        if dept and email in {(dept.lead_email or "").lower(), (dept.backup_email or "").lower()}:
            return None                                              # routes/owns this queue
    return _WORKING_FIELDS


@router.patch("/task-tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketUpdate, background_tasks: BackgroundTasks,
                  user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    data = body.model_dump(exclude_unset=True)
    reopen_reason = data.pop("reopen_reason", "") or ""   # not a column — see TicketUpdate
    scope = _ticket_edit_scope(db, t, user)
    if scope is not None:
        blocked = sorted(set(data.keys()) - scope)
        if blocked:
            raise HTTPException(403, f"You can only update {', '.join(sorted(scope))} on a ticket you're not the requester/owner of — not: {', '.join(blocked)}")
    prev_status, prev_assignee, prev_priority = t.status, (t.assignee_email or ""), t.priority
    prev_due = t.sla_due_on
    for k, v in data.items():
        if k in ("assignee_email",) and v is not None:
            v = (v or "").lower()
        setattr(t, k, v)
    if data.get("status") in ("resolved", "closed") and not t.resolved_at:
        t.resolved_at = now_iso()
    if data.get("status") not in ("resolved", "closed") and "status" in data:
        t.resolved_at = ""
        t.resolution = ""

    # activity trail + notifications for meaningful changes
    def _log(kind, detail):
        log_activity(db, type=kind, actor_email=user["email"], entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=detail)
    tk_action = {"view": "tasks", "sub": "tickets", "label": "View ticket"}
    status_changed = "status" in data and t.status != prev_status
    assignee_changed = "assignee_email" in data and (t.assignee_email or "") != prev_assignee
    if status_changed:
        _log("status_changed", f"changed status to {t.status}")
        if t.status in ("resolved", "closed") and t.requester_email and t.requester_email != user["email"].lower():
            task_notify(db, kind="ticket_resolved", for_email=t.requester_email,
                        title=f"Your ticket was {t.status}", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
        else:
            # keep watchers (and requester/assignee) in the loop on any status move
            _notify_participants(db, t, user["email"], kind="ticket_status",
                                 title=f"Ticket moved to {t.status}", body=f"{t.code} · {t.subject}")
    if assignee_changed:
        _log("assigned", f"assigned to {t.assignee_email or 'nobody'}")
        if t.assignee_email and t.assignee_email != user["email"].lower():
            task_notify(db, kind="ticket_assigned", for_email=t.assignee_email,
                        title="You were assigned a ticket", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    if "priority" in data and t.priority != prev_priority:
        _log("priority_changed", f"set priority to {t.priority}")

    t.modified_at = now_iso()
    db.commit()
    db.refresh(t)

    # ── Outlook notifications (best-effort, after commit — see ticket_notify.py) ──
    actor = user["email"]
    if assignee_changed and t.assignee_email:
        # Reassignment uses the "assigned" flow exclusively — spec lists reassignment
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


@router.delete("/task-tickets/{ticket_id}", status_code=204)
def delete_ticket(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    if _ticket_edit_scope(db, t, user) is not None:
        raise HTTPException(403, "Only the requester, the ticket's department lead, or a manager can delete a ticket")
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
def list_ticket_comments(ticket_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskComment).filter(models.TaskComment.task_id == ticket_id).order_by(models.TaskComment.created_at).all()
    return [_tcomment(c) for c in rows]


@router.post("/task-tickets/{ticket_id}/comments", status_code=201)
def add_ticket_comment(ticket_id: str, body: TicketCommentBody, background_tasks: BackgroundTasks,
                       user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    internal = bool(body.internal)
    c = models.TaskComment(id=gen_id(), task_id=ticket_id, author_email=user["email"], body=body.body or "",
                           internal=internal, created_at=now_iso())
    db.add(c)
    log_activity(db, type="commented", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                 detail="added an internal note" if internal else "commented")
    # Internal notes stay with the agents — don't ping the requester.
    _notify_participants(db, t, user["email"], kind="ticket_comment",
                         title="Internal note on a ticket" if internal else "New comment on a ticket",
                         body=f"{t.code} · {t.subject}",
                         exclude={(t.requester_email or "").lower()} if internal else None)
    db.commit()
    db.refresh(c)
    if not internal and get_notify_settings(db).get("commentsTrigger", True):
        background_tasks.add_task(notify_ticket_event, t.id, "updated", user["email"],
                                   update_kind="New comment added", latest_comment=(body.body or "")[:280])
    return _tcomment(c)


@router.delete("/task-tickets/comments/{comment_id}", status_code=204)
def delete_ticket_comment(comment_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).delete()
    db.commit()


@router.get("/task-tickets/{ticket_id}/attachments")
def list_ticket_attachments(ticket_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == ticket_id).all()
    return [_tattachment(a) for a in rows]


@router.post("/task-tickets/{ticket_id}/attachments", status_code=201)
def add_ticket_attachment(ticket_id: str, body: TicketAttachmentBody, background_tasks: BackgroundTasks,
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
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


@router.delete("/task-tickets/attachments/{attachment_id}", status_code=204)
def delete_ticket_attachment(attachment_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskAttachment).filter(models.TaskAttachment.id == attachment_id).delete()
    db.commit()


@router.get("/task-tickets/{ticket_id}/activity")
def list_ticket_activity(ticket_id: str, db: Session = Depends(get_db)):
    rows = (db.query(models.TaskActivity)
            .filter(models.TaskActivity.entity_kind == "ticket", models.TaskActivity.entity_id == ticket_id)
            .order_by(models.TaskActivity.at.desc()).all())
    return [{"id": a.id, "type": a.type or "", "actorId": _nz(a.actor_email), "at": a.at or "", "detail": a.detail or ""} for a in rows]


# ── Org lookups for tickets — company + department from the People module.
#    Read-only id+name lists, available to any authenticated user (the /hr
#    endpoints are permission-gated, which a plain ticket requester may lack). ──
@router.get("/ticket-companies")
def list_ticket_companies(db: Session = Depends(get_db)):
    rows = db.query(models.HrEntity).order_by(models.HrEntity.name).all()
    return [{"id": e.id, "name": e.name} for e in rows]


@router.get("/ticket-departments")
def list_ticket_departments(db: Session = Depends(get_db)):
    rows = (db.query(models.HrDepartment)
            .order_by(models.HrDepartment.sort_order, models.HrDepartment.name).all())
    return [{"id": d.id, "name": d.name, "companyId": d.company_id,
             "leadEmail": d.lead_email or "", "backupEmail": d.backup_email or ""} for d in rows]



# ── Ticket components / categories ───────────────────────────────────────────
class ComponentBody(BaseModel):
    id: Optional[str] = None
    name: str


@router.get("/task-ticket-components")
def list_ticket_components(db: Session = Depends(get_db)):
    return [{"id": c.id, "name": c.name} for c in db.query(models.TaskTicketComponent).order_by(models.TaskTicketComponent.name).all()]


@router.post("/task-ticket-components", status_code=201)
def create_ticket_component(body: ComponentBody, db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Component name is required")
    c = models.TaskTicketComponent(id=body.id or gen_id(), name=body.name.strip(), created_at=now_iso())
    db.add(c)
    db.commit()
    db.refresh(c)
    return {"id": c.id, "name": c.name}


@router.delete("/task-ticket-components/{component_id}", status_code=204)
def delete_ticket_component(component_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskTicketComponent).filter(models.TaskTicketComponent.id == component_id).delete()
    db.commit()


# ── Approvals ────────────────────────────────────────────────────────────────
# Service/change/access requests name an approver at intake. Until that person
# decides, the ticket is parked: the department lead is NOT notified and it does
# not appear in the triage queue. Approving releases it to triage; rejecting
# closes it. The decision is recorded on the ticket and in the activity log.
class ApprovalBody(BaseModel):
    decision: str                      # approve | reject
    note: Optional[str] = ""


@router.post("/task-tickets/{ticket_id}/approval")
def decide_approval(ticket_id: str, body: ApprovalBody,
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

    tk_action = {"view": "tasks", "sub": "tickets", "label": "View ticket"}
    if decision == "approve":
        log_activity(db, type="approved", actor_email=user["email"], entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail="approved this request" + (f": {note}" if note else ""))
        # Released — now it enters the normal triage queue.
        _notify_triage(db, t, actor)
        if t.requester_email and t.requester_email != actor:
            task_notify(db, kind="ticket_approved", for_email=t.requester_email,
                        title="Your request was approved",
                        body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    else:
        # Rejected requests are closed — nothing downstream should act on them.
        t.status = "closed"
        t.resolution = "wont_fix"
        t.resolved_at = now_iso()
        log_activity(db, type="rejected", actor_email=user["email"], entity_kind="ticket",
                     entity_id=t.id, entity_code=t.code, entity_title=t.subject,
                     detail=f"rejected this request: {note}")
        if t.requester_email and t.requester_email != actor:
            task_notify(db, kind="ticket_rejected", for_email=t.requester_email,
                        title="Your request was rejected",
                        body=f"{t.code} · {t.subject} — {note}", nexus_action=tk_action)
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


# ── Ticket ↔ ticket links (adds the inverse link on the other ticket too) ─────
_LINK_INVERSE = {"relates": "relates", "duplicate": "duplicate", "blocks": "blocked_by", "blocked_by": "blocks"}


class TicketLinkBody(BaseModel):
    ticket_id: str
    type: Optional[str] = "relates"


@router.post("/task-tickets/{ticket_id}/links", status_code=201)
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


@router.delete("/task-tickets/{ticket_id}/links/{target_id}")
def remove_ticket_link(ticket_id: str, target_id: str, db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    t.links = [l for l in (t.links or []) if l.get("ticketId") != target_id]
    other = db.query(models.TaskTicket).filter(models.TaskTicket.id == target_id).first()
    if other:
        other.links = [l for l in (other.links or []) if l.get("ticketId") != ticket_id]
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


# ── Escalate — bump priority one rung and alert assignee/watchers + managers ──
_PRIORITY_LADDER = ["low", "medium", "high", "urgent"]


@router.post("/task-tickets/{ticket_id}/escalate")
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
                         title=f"Ticket escalated to {new_p}", body=f"{t.code} · {t.subject}")
    task_notify(db, kind="ticket_escalated", for_email="admins", title="A ticket was escalated",
                body=f"{t.code} · {t.subject} → {new_p}",
                nexus_action={"view": "tasks", "sub": "tickets", "label": "View ticket"})
    db.commit()
    db.refresh(t)
    background_tasks.add_task(notify_ticket_event, t.id, "updated", user["email"],
                               update_kind=f"Escalated to {new_p} priority")
    return ticket_to_dict(t)


# ── Notification settings + delivery log (admin) ──────────────────────────────
@router.get("/task-tickets/notify/settings")
def get_ticket_notify_settings(user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    return get_notify_settings(db)


@router.put("/task-tickets/notify/settings")
def put_ticket_notify_settings(patch: dict, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    return save_notify_settings(db, patch, user["email"])


@router.get("/task-tickets/notify/log")
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

