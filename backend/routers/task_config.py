"""Task Module — config & misc router: saved views, automation rules, templates,
intake forms, custom fields, tickets, the module's own notification bell, and the
changelog/"What's New" feature. Single router, absolute paths, email-keyed.
"""
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import or_
from pydantic import BaseModel
from typing import Optional, Any
import os
import json
import subprocess
import httpx
import models
from database import get_db
from auth import get_current_user, require_level, require_manager
from routers.task_util import now_iso, gen_id, log_activity, task_notify

router = APIRouter(tags=["Tasks"], dependencies=[Depends(get_current_user)])


def _nz(v):
    return v if v not in ("", None) else None


# ── Saved views (per user) ───────────────────────────────────────────────────
def saved_view_to_dict(s: models.TaskSavedView) -> dict:
    return {"id": s.id, "ownerId": _nz(s.owner_email), "name": s.name, "view": s.view or "list",
            "filters": s.filters if isinstance(s.filters, dict) else {},
            "sort": s.sort if isinstance(s.sort, dict) else {}, "group": s.group or "none"}


class SavedViewBody(BaseModel):
    id: Optional[str] = None
    name: str
    view: Optional[str] = "list"
    filters: Optional[dict] = None
    sort: Optional[dict] = None
    group: Optional[str] = "none"


@router.get("/task-saved-views")
def list_saved_views(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.TaskSavedView).filter(models.TaskSavedView.owner_email == user["email"].lower()).all()
    return [saved_view_to_dict(s) for s in rows]


@router.post("/task-saved-views", status_code=201)
def create_saved_view(body: SavedViewBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    s = models.TaskSavedView(id=body.id or gen_id(), owner_email=user["email"].lower(), name=body.name,
                             view=body.view or "list", filters=body.filters or {}, sort=body.sort or {},
                             group=body.group or "none", created_at=now_iso())
    db.add(s)
    db.commit()
    db.refresh(s)
    return saved_view_to_dict(s)


@router.delete("/task-saved-views/{view_id}", status_code=204)
def delete_saved_view(view_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskSavedView).filter(models.TaskSavedView.id == view_id).delete()
    db.commit()


# ── Automation rules ─────────────────────────────────────────────────────────
def rule_to_dict(r: models.TaskAutomationRule) -> dict:
    return {"id": r.id, "name": r.name,
            "trigger": r.trigger if isinstance(r.trigger, dict) else {},
            "actions": r.actions if isinstance(r.actions, list) else [], "enabled": bool(r.enabled)}


class RuleBody(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None   # optional so PATCH (e.g. enabled toggle) can send partial bodies; required on create (guarded below)
    trigger: Optional[dict] = None
    actions: Optional[list] = None
    enabled: Optional[bool] = None


@router.get("/task-automation-rules")
def list_rules(db: Session = Depends(get_db)):
    return [rule_to_dict(r) for r in db.query(models.TaskAutomationRule).all()]


@router.post("/task-automation-rules", status_code=201, dependencies=[Depends(require_manager)])
def create_rule(body: RuleBody, db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Rule name is required")
    r = models.TaskAutomationRule(id=body.id or gen_id(), name=body.name, trigger=body.trigger or {},
                                  actions=body.actions or [],
                                  enabled=True if body.enabled is None else bool(body.enabled),
                                  created_at=now_iso())
    db.add(r)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.patch("/task-automation-rules/{rule_id}", dependencies=[Depends(require_manager)])
def update_rule(rule_id: str, body: RuleBody, db: Session = Depends(get_db)):
    r = db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.delete("/task-automation-rules/{rule_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_rule(rule_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).delete()
    db.commit()


# ── Templates ────────────────────────────────────────────────────────────────
def template_to_dict(t: models.TaskTemplate) -> dict:
    return {"id": t.id, "name": t.name, "description": t.description or "",
            "patch": t.patch if isinstance(t.patch, dict) else {},
            "subtaskTitles": t.subtask_titles or []}


class TemplateBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    patch: Optional[dict] = None
    subtask_titles: Optional[list] = None


@router.get("/task-templates")
def list_templates(db: Session = Depends(get_db)):
    return [template_to_dict(t) for t in db.query(models.TaskTemplate).all()]


@router.post("/task-templates", status_code=201, dependencies=[Depends(require_manager)])
def create_template(body: TemplateBody, db: Session = Depends(get_db)):
    t = models.TaskTemplate(id=body.id or gen_id(), name=body.name, description=body.description or "",
                            patch=body.patch or {}, subtask_titles=body.subtask_titles or [],
                            created_at=now_iso())
    db.add(t)
    db.commit()
    db.refresh(t)
    return template_to_dict(t)


@router.delete("/task-templates/{template_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_template(template_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskTemplate).filter(models.TaskTemplate.id == template_id).delete()
    db.commit()


# ── Intake forms ─────────────────────────────────────────────────────────────
def intake_form_to_dict(f: models.TaskIntakeForm) -> dict:
    return {"id": f.id, "title": f.title, "fields": f.fields if isinstance(f.fields, list) else [],
            "targetProjectId": _nz(f.target_project_id)}


class IntakeFormBody(BaseModel):
    id: Optional[str] = None
    title: str
    fields: Optional[list] = None
    target_project_id: Optional[str] = ""


@router.get("/task-intake-forms")
def list_intake_forms(db: Session = Depends(get_db)):
    return [intake_form_to_dict(f) for f in db.query(models.TaskIntakeForm).all()]


@router.post("/task-intake-forms", status_code=201, dependencies=[Depends(require_manager)])
def create_intake_form(body: IntakeFormBody, db: Session = Depends(get_db)):
    f = models.TaskIntakeForm(id=body.id or gen_id(), title=body.title, fields=body.fields or [],
                              target_project_id=body.target_project_id or "", created_at=now_iso())
    db.add(f)
    db.commit()
    db.refresh(f)
    return intake_form_to_dict(f)


@router.delete("/task-intake-forms/{form_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_intake_form(form_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskIntakeForm).filter(models.TaskIntakeForm.id == form_id).delete()
    db.commit()


# ── Custom fields ────────────────────────────────────────────────────────────
def custom_field_to_dict(f: models.TaskCustomField) -> dict:
    return {"id": f.id, "name": f.name, "description": _nz(f.description), "type": f.type or "text",
            "options": f.options if isinstance(f.options, list) else []}


class CustomFieldBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    type: Optional[str] = "text"
    options: Optional[list] = None


@router.get("/task-custom-fields")
def list_custom_fields(db: Session = Depends(get_db)):
    return [custom_field_to_dict(f) for f in db.query(models.TaskCustomField).all()]


@router.post("/task-custom-fields", status_code=201)
def create_custom_field(body: CustomFieldBody, db: Session = Depends(get_db)):
    f = models.TaskCustomField(id=body.id or gen_id(), name=body.name, description=body.description or "",
                               type=body.type or "text", options=body.options or [])
    db.add(f)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


@router.patch("/task-custom-fields/{field_id}")
def update_custom_field(field_id: str, body: CustomFieldBody, db: Session = Depends(get_db)):
    f = db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).first()
    if not f:
        raise HTTPException(404, "Custom field not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    for k, v in data.items():
        setattr(f, k, v)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


@router.delete("/task-custom-fields/{field_id}", status_code=204)
def delete_custom_field(field_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).delete()
    db.commit()


# ── Tickets ──────────────────────────────────────────────────────────────────
def ticket_to_dict(t: models.TaskTicket) -> dict:
    return {"id": t.id, "code": t.code or "", "subject": t.subject, "description": t.description or "",
            "type": t.type or "request",
            "status": t.status or "new", "priority": t.priority or "medium",
            "requesterId": _nz(t.requester_email), "assigneeId": _nz(t.assignee_email),
            "departmentId": _nz(t.department_id), "linkedTaskId": _nz(t.linked_task_id),
            "tags": t.tags or [], "images": t.images or [], "watcherIds": t.watcher_emails or [],
            "resolution": _nz(t.resolution),
            "customFieldValues": t.custom_field_values if isinstance(t.custom_field_values, dict) else {},
            "links": t.links if isinstance(t.links, list) else [],
            "taskIds": t.task_ids if isinstance(t.task_ids, list) else [],
            "component": _nz(t.component),
            "csatRating": t.csat_rating or 0, "csatComment": _nz(t.csat_comment),
            "slaDueOn": _nz(t.sla_due_on), "resolvedAt": _nz(t.resolved_at),
            "createdAt": t.created_at or "", "modifiedAt": t.modified_at or ""}


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
    linked_task_id: Optional[str] = ""
    tags: Optional[list] = None
    images: Optional[list] = None
    watcher_emails: Optional[list] = None
    resolution: Optional[str] = ""
    custom_field_values: Optional[dict] = None
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
    linked_task_id: Optional[str] = None
    tags: Optional[list] = None
    images: Optional[list] = None
    watcher_emails: Optional[list] = None
    resolution: Optional[str] = None
    custom_field_values: Optional[dict] = None
    task_ids: Optional[list] = None
    component: Optional[str] = None
    csat_rating: Optional[int] = None
    csat_comment: Optional[str] = None
    sla_due_on: Optional[str] = None
    resolved_at: Optional[str] = None


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
                         title: str, body: str):
    """Notify a ticket's participants (watchers/assignee/requester) except the actor."""
    action = {"view": "tasks", "sub": "tickets", "label": "View ticket"}
    for email in _ticket_participants(t):
        if email == (actor_email or "").lower():
            continue
        task_notify(db, kind=kind, for_email=email, title=title, body=body, nexus_action=action)


@router.get("/task-tickets")
def list_tickets(db: Session = Depends(get_db)):
    return [ticket_to_dict(t) for t in db.query(models.TaskTicket).all()]


@router.post("/task-tickets", status_code=201)
def create_ticket(body: TicketBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    t = models.TaskTicket(
        id=body.id or gen_id(), code=body.code or _next_ticket_code(db), subject=body.subject,
        description=body.description or "", type=body.type or "request",
        status=body.status or "new", priority=body.priority or "medium",
        requester_email=(body.requester_email or user["email"]).lower(),
        assignee_email=(body.assignee_email or "").lower(), department_id=body.department_id or "",
        linked_task_id=body.linked_task_id or "", tags=body.tags or [], images=body.images or [],
        watcher_emails=body.watcher_emails or [], resolution=body.resolution or "",
        custom_field_values=body.custom_field_values or {}, links=[], task_ids=[],
        component=body.component or "", csat_rating=0, csat_comment="",
        sla_due_on=body.sla_due_on or "", resolved_at="", created_at=now, modified_at=now,
    )
    db.add(t)
    log_activity(db, type="created", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail="created this ticket")
    tk_action = {"view": "tasks", "sub": "tickets", "label": "View ticket"}
    if t.assignee_email and t.assignee_email != user["email"].lower():
        task_notify(db, kind="ticket_assigned", for_email=t.assignee_email,
                    title="You were assigned a ticket", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    # Intake acknowledgment — let the requester know their request landed (e.g. when a
    # manager logs it on their behalf; if they raised it themselves they're the actor).
    if t.requester_email and t.requester_email != user["email"].lower():
        task_notify(db, kind="ticket_received", for_email=t.requester_email,
                    title="We received your ticket", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


@router.patch("/task-tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketUpdate, user: dict = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    data = body.model_dump(exclude_unset=True)
    prev_status, prev_assignee, prev_priority = t.status, (t.assignee_email or ""), t.priority
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
    if "status" in data and t.status != prev_status:
        _log("status_changed", f"changed status to {t.status}")
        if t.status in ("resolved", "closed") and t.requester_email and t.requester_email != user["email"].lower():
            task_notify(db, kind="ticket_resolved", for_email=t.requester_email,
                        title=f"Your ticket was {t.status}", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
        else:
            # keep watchers (and requester/assignee) in the loop on any status move
            _notify_participants(db, t, user["email"], kind="ticket_status",
                                 title=f"Ticket moved to {t.status}", body=f"{t.code} · {t.subject}")
    if "assignee_email" in data and (t.assignee_email or "") != prev_assignee:
        _log("assigned", f"assigned to {t.assignee_email or 'nobody'}")
        if t.assignee_email and t.assignee_email != user["email"].lower():
            task_notify(db, kind="ticket_assigned", for_email=t.assignee_email,
                        title="You were assigned a ticket", body=f"{t.code} · {t.subject}", nexus_action=tk_action)
    if "priority" in data and t.priority != prev_priority:
        _log("priority_changed", f"set priority to {t.priority}")

    t.modified_at = now_iso()
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


@router.delete("/task-tickets/{ticket_id}", status_code=204)
def delete_ticket(ticket_id: str, db: Session = Depends(get_db)):
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
            "createdAt": c.created_at or "", "editedAt": _nz(c.edited_at)}


def _tattachment(a) -> dict:
    return {"id": a.id, "ticketId": a.task_id, "name": a.name, "size": a.size or "",
            "kind": a.kind or "other", "url": _nz(a.url), "dataUrl": _nz(a.url),
            "addedAt": a.added_at or "", "addedBy": _nz(a.added_by)}


class TicketCommentBody(BaseModel):
    body: str


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
def add_ticket_comment(ticket_id: str, body: TicketCommentBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    c = models.TaskComment(id=gen_id(), task_id=ticket_id, author_email=user["email"], body=body.body or "", created_at=now_iso())
    db.add(c)
    log_activity(db, type="commented", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail="commented")
    _notify_participants(db, t, user["email"], kind="ticket_comment",
                         title="New comment on a ticket", body=f"{t.code} · {t.subject}")
    db.commit()
    db.refresh(c)
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
def add_ticket_attachment(ticket_id: str, body: TicketAttachmentBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _ticket_or_404(db, ticket_id)
    a = models.TaskAttachment(id=gen_id(), task_id=ticket_id, name=body.name, size=body.size or "",
                              kind=body.kind or "other", url=body.url or "", added_at=now_iso(), added_by=user["email"])
    db.add(a)
    log_activity(db, type="attached", actor_email=user["email"], entity_kind="ticket",
                 entity_id=t.id, entity_code=t.code, entity_title=t.subject, detail=f'attached "{a.name}"')
    db.commit()
    db.refresh(a)
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
def escalate_ticket(ticket_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
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
    return ticket_to_dict(t)


# ── OCR (mobile "scan text" — quick-add ABC scanner) ─────────────────────────
# Extracts text from an uploaded photo via Tesseract. The engine (pytesseract +
# the `tesseract` binary) must be present on the host; if it isn't we return 501
# so the client can degrade gracefully instead of 500-ing.
@router.post("/task-ocr")
async def task_ocr(image: UploadFile = File(...)):
    raw = await image.read()
    if not raw:
        raise HTTPException(400, "Empty image")
    try:
        import io
        from PIL import Image
        import pytesseract
    except Exception:
        raise HTTPException(501, "OCR engine is not installed on the server")
    try:
        img = Image.open(io.BytesIO(raw))
        text = pytesseract.image_to_string(img)
    except pytesseract.TesseractNotFoundError:
        raise HTTPException(501, "Tesseract binary is not available on the server")
    except Exception as exc:
        raise HTTPException(500, f"Could not read the image: {exc}")
    return {"text": (text or "").strip()}


# ── Notifications (module's own bell) ────────────────────────────────────────
def notification_to_dict(n: models.TaskNotification) -> dict:
    return {"id": n.id, "kind": n.kind or "", "title": n.title or "", "body": n.body or "",
            "forUserId": n.for_email or "", "requestId": _nz(n.request_id),
            "departmentId": _nz(n.department_id), "taskId": _nz(n.task_id),
            "read": bool(n.read), "createdAt": n.created_at or ""}


@router.get("/task-notifications")
def list_notifications(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    q = db.query(models.TaskNotification)
    if user["level"] >= 4:  # admins also see the "admins" fan-out
        q = q.filter(or_(models.TaskNotification.for_email == email,
                         models.TaskNotification.for_email == "admins"))
    else:
        q = q.filter(models.TaskNotification.for_email == email)
    rows = q.order_by(models.TaskNotification.created_at.desc()).limit(500).all()
    return [notification_to_dict(n) for n in rows]


@router.post("/task-notifications/{notif_id}/read")
def mark_notification_read(notif_id: str, db: Session = Depends(get_db)):
    n = db.query(models.TaskNotification).filter(models.TaskNotification.id == notif_id).first()
    if not n:
        raise HTTPException(404, "Notification not found")
    n.read = True
    db.commit()
    return {"ok": True}


@router.post("/task-notifications/read-all")
def mark_all_read(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    email = user["email"].lower()
    targets = [email] + (["admins"] if user["level"] >= 4 else [])
    db.query(models.TaskNotification).filter(
        models.TaskNotification.for_email.in_(targets),
        models.TaskNotification.read == False,  # noqa: E712
    ).update({models.TaskNotification.read: True}, synchronize_session=False)
    db.commit()
    return {"ok": True}


# ── Changelog / What's New ───────────────────────────────────────────────────
def changelog_entry_to_dict(e: models.TaskChangelogEntry) -> dict:
    payload = e.payload if isinstance(e.payload, dict) else {}
    return {**payload, "id": e.id, "createdAt": e.created_at or "", "updatedAt": e.updated_at or ""}


def changelog_comment_to_dict(c: models.TaskChangelogComment) -> dict:
    return {"id": c.id, "entryId": c.entry_id, "authorId": _nz(c.author_email),
            "body": c.body or "", "createdAt": c.created_at or ""}


class ChangelogEntryBody(BaseModel):
    id: Optional[str] = None
    payload: dict[str, Any]


class ChangelogCommentBody(BaseModel):
    id: Optional[str] = None
    body: str


@router.get("/task-changelog")
def list_changelog(db: Session = Depends(get_db)):
    rows = db.query(models.TaskChangelogEntry).order_by(models.TaskChangelogEntry.created_at.desc()).all()
    return [changelog_entry_to_dict(e) for e in rows]


@router.post("/task-changelog", status_code=201)
def create_changelog(body: ChangelogEntryBody, db: Session = Depends(get_db)):
    now = now_iso()
    e = models.TaskChangelogEntry(id=body.id or gen_id(), payload=body.payload or {},
                                  created_at=now, updated_at=now)
    db.add(e)
    db.commit()
    db.refresh(e)
    return changelog_entry_to_dict(e)


@router.patch("/task-changelog/{entry_id}")
def update_changelog(entry_id: str, body: ChangelogEntryBody, db: Session = Depends(get_db)):
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Changelog entry not found")
    e.payload = body.payload or {}
    e.updated_at = now_iso()
    db.commit()
    db.refresh(e)
    return changelog_entry_to_dict(e)


@router.delete("/task-changelog/{entry_id}", status_code=204)
def delete_changelog(entry_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).delete()
    db.query(models.TaskChangelogComment).filter(models.TaskChangelogComment.entry_id == entry_id).delete()
    db.commit()


@router.get("/task-changelog/{entry_id}/comments")
def list_changelog_comments(entry_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskChangelogComment).filter(
        models.TaskChangelogComment.entry_id == entry_id).all()
    return [changelog_comment_to_dict(c) for c in rows]


@router.post("/task-changelog/{entry_id}/comments", status_code=201)
def add_changelog_comment(entry_id: str, body: ChangelogCommentBody,
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    c = models.TaskChangelogComment(id=body.id or gen_id(), entry_id=entry_id,
                                    author_email=user["email"].lower(), body=body.body or "",
                                    created_at=now_iso())
    db.add(c)
    db.commit()
    db.refresh(c)
    return changelog_comment_to_dict(c)


# ── Generate changelog drafts from git commits ───────────────────────────────
# Admin clicks "Generate from git" in Manage → we pull recent commits (GitHub API
# in prod, local `git log` in dev), ask Claude to cluster them into a few
# user-facing, plain-English "What's New" entries, and file them as origin='pr'
# / status='Pending Review'. They then flow through the normal review → publish.
_AI_MODEL = "claude-opus-4-8"
_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
_GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
_GITHUB_REPO = os.getenv("GITHUB_REPO", "Greens-Global/Greens-Nexus")
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_CHANGE_TYPES = ["Bug Fix", "Performance", "New Feature", "Security Update",
                 "Hotfix", "Maintenance", "Improvement"]


def _is_noise(subject: str) -> bool:
    s = (subject or "").strip().lower()
    return not s or s.startswith("merge ")


def _recent_commits(limit: int = 80) -> tuple[list[dict], str]:
    """Return ([{sha, author, date, subject, body}], source). Prefers the GitHub
    API (works on the deployed backend, which has no working tree); falls back to
    a local `git log` when a repo is present (dev)."""
    if _GITHUB_TOKEN:
        try:
            with httpx.Client(timeout=30) as client:
                r = client.get(
                    f"https://api.github.com/repos/{_GITHUB_REPO}/commits",
                    params={"per_page": min(limit, 100)},
                    headers={"Authorization": f"Bearer {_GITHUB_TOKEN}",
                             "Accept": "application/vnd.github+json"},
                )
                r.raise_for_status()
            out = []
            for row in r.json():
                commit = row.get("commit", {}) or {}
                subject, _, cbody = (commit.get("message", "") or "").partition("\n")
                out.append({"sha": row.get("sha", ""),
                            "author": (commit.get("author") or {}).get("name", ""),
                            "date": (commit.get("author") or {}).get("date", ""),
                            "subject": subject.strip(), "body": cbody.strip()})
            return out, "github"
        except Exception as e:  # noqa: BLE001
            print(f"[changelog] GitHub fetch failed, trying local git: {e}")
    try:
        sep, rec = "\x1f", "\x1e"
        fmt = sep.join(["%H", "%an", "%aI", "%s", "%b"]) + rec
        raw = subprocess.check_output(
            ["git", "-C", _REPO_ROOT, "log", f"-n{limit}", "--no-merges", f"--pretty=format:{fmt}"],
            text=True, encoding="utf-8", errors="replace",
        )
        out = []
        for chunk in raw.split(rec):
            chunk = chunk.strip("\n")
            if not chunk.strip():
                continue
            parts = chunk.split(sep)
            if len(parts) < 4:
                continue
            out.append({"sha": parts[0], "author": parts[1], "date": parts[2],
                        "subject": parts[3], "body": parts[4] if len(parts) > 4 else ""})
        return out, "git"
    except Exception as e:  # noqa: BLE001
        print(f"[changelog] local git log failed: {e}")
        return [], "none"


def _known_shas(db: Session) -> set[str]:
    """8-char prefixes of every commit already summarised into an entry."""
    seen: set[str] = set()
    for e in db.query(models.TaskChangelogEntry).all():
        payload = e.payload if isinstance(e.payload, dict) else {}
        for s in (payload.get("commitShas") or []):
            if s:
                seen.add(s[:8])
    return seen


def _cluster_commits(commits: list[dict]) -> list[dict]:
    """Ask Claude to fold the commits into a few plain-English feature entries."""
    if not _ANTHROPIC_API_KEY or not commits:
        return []
    lines = []
    for c in commits:
        line = f"- [{c['sha'][:8]}] {c['subject']}"
        if c.get("body"):
            line += f" — {c['body'][:240].replace(chr(10), ' ')}"
        lines.append(line)
    commit_block = "\n".join(lines)
    prompt = (
        "You turn a list of git commits from Greens Global's internal staff portal "
        "(\"Nexus\") into a short changelog for NON-TECHNICAL business users.\n\n"
        "Group related commits into a small number of user-facing updates (usually 1-6). "
        "SKIP commits that are pure chores, refactors, tests, docs, build/CI, dependency "
        "bumps, or internal plumbing with no visible effect — if nothing is user-facing, "
        "return an empty array. Never use commit hashes, branch names, ticket IDs, code "
        "identifiers, or engineering jargon in the text. Be concrete about the user-visible effect.\n\n"
        f"Allowed \"type\" values: {', '.join(_CHANGE_TYPES)}.\n\n"
        "Return ONLY a JSON array (no prose, no code fences). Each element:\n"
        '{ "title": string (short, plain English, no jargon),\n'
        '  "description": string (1-3 sentences a non-technical user understands),\n'
        '  "type": one of the allowed values,\n'
        '  "module": string (product area, e.g. HR, Dashboard, Tasks, Item Management),\n'
        '  "businessImpact": string (one sentence: the plain-English payoff),\n'
        '  "whatsChanged": string[] (2-5 short plain-English bullets),\n'
        '  "commitShas": string[] (the 8-char hashes from the list you grouped into this entry) }\n\n'
        f"COMMITS:\n{commit_block}"
    )
    try:
        with httpx.Client(timeout=120) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": _ANTHROPIC_API_KEY,
                         "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": _AI_MODEL, "max_tokens": 6000,
                      "messages": [{"role": "user", "content": prompt}]},
            )
            r.raise_for_status()
            data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
        if text.startswith("```"):
            text = text.split("```", 2)[1].lstrip("json").strip() if "```" in text[3:] else text.strip("`")
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end == -1:
            return []
        parsed = json.loads(text[start:end + 1])
        return parsed if isinstance(parsed, list) else []
    except Exception as e:  # noqa: BLE001
        print(f"[changelog] cluster failed: {e}")
        return []


@router.post("/task-changelog/generate")
def generate_changelog(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    if not _ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI is not configured (ANTHROPIC_API_KEY missing).")
    commits, source = _recent_commits()
    if source == "none":
        raise HTTPException(503, "Could not read commit history (no GitHub token and no local repo).")
    known = _known_shas(db)
    fresh = [c for c in commits if not _is_noise(c["subject"]) and c["sha"][:8] not in known]
    if not fresh:
        return {"created": 0, "scanned": len(commits), "source": source,
                "message": "No new commits to summarise since the last update."}

    drafts = _cluster_commits(fresh[:40])
    created = []
    now = now_iso()
    for d in drafts:
        if not isinstance(d, dict) or not (d.get("title") and d.get("description")):
            continue
        ctype = d.get("type") if d.get("type") in _CHANGE_TYPES else "Improvement"
        shas = [s[:8] for s in (d.get("commitShas") or []) if isinstance(s, str)]
        payload = {
            "title": str(d["title"]).strip(),
            "description": str(d["description"]).strip(),
            "type": ctype,
            "module": str(d.get("module") or "").strip(),
            "version": "unreleased",
            "environment": "Production",
            "releasedAt": now[:16],
            "authorId": user["email"].lower(),
            "businessImpact": str(d.get("businessImpact") or "").strip() or None,
            "whatsChanged": [str(x).strip() for x in (d.get("whatsChanged") or []) if str(x).strip()][:5],
            "commitShas": shas,
            "origin": "pr",
            "status": "Pending Review",
        }
        e = models.TaskChangelogEntry(id=gen_id(), payload=payload, created_at=now, updated_at=now)
        db.add(e)
        created.append(e)
    db.commit()
    for e in created:
        db.refresh(e)
    return {"created": len(created), "scanned": len(fresh), "source": source,
            "entries": [changelog_entry_to_dict(e) for e in created]}
