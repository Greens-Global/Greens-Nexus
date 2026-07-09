"""Task Module — config & misc router: saved views, automation rules, templates,
intake forms, custom fields, tickets, the module's own notification bell, and the
changelog/"What's New" feature. Single router, absolute paths, email-keyed.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import or_
from pydantic import BaseModel
from typing import Optional, Any
import models
from database import get_db
from auth import get_current_user
from routers.task_util import now_iso, gen_id, fire_task_event, log_activity
from routers.tasks import task_to_dict, new_task_row, normalize_patch, notify_followers, _next_code

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


@router.post("/task-automation-rules", status_code=201)
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


@router.patch("/task-automation-rules/{rule_id}")
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


@router.delete("/task-automation-rules/{rule_id}", status_code=204)
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


@router.post("/task-templates", status_code=201)
def create_template(body: TemplateBody, db: Session = Depends(get_db)):
    t = models.TaskTemplate(id=body.id or gen_id(), name=body.name, description=body.description or "",
                            patch=body.patch or {}, subtask_titles=body.subtask_titles or [],
                            created_at=now_iso())
    db.add(t)
    db.commit()
    db.refresh(t)
    return template_to_dict(t)


@router.delete("/task-templates/{template_id}", status_code=204)
def delete_template(template_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskTemplate).filter(models.TaskTemplate.id == template_id).delete()
    db.commit()


class ApplyTemplateBody(BaseModel):
    overrides: Optional[dict] = None


@router.post("/task-templates/{template_id}/apply", status_code=201)
def apply_template(template_id: str, body: ApplyTemplateBody,
                   user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Create a task from a template's Partial<Task> patch (merged with any
    caller overrides), then one child task per entry in subtaskTitles (source
    createActions.applyTemplate)."""
    tpl = db.query(models.TaskTemplate).filter(models.TaskTemplate.id == template_id).first()
    if not tpl:
        raise HTTPException(404, "Template not found")
    patch = tpl.patch if isinstance(tpl.patch, dict) else {}
    overrides = body.overrides or {}
    fields = normalize_patch({**patch, **overrides})
    # Template forces the task title to the template name unless the caller overrides it.
    fields["title"] = overrides.get("title") or tpl.name
    fields["parent_task_id"] = ""
    # Creator + assignee follow by default.
    followers = [user["email"]]
    if fields.get("assignee_email"):
        followers.append(fields["assignee_email"])
    fields["follower_emails"] = followers

    parent = new_task_row(db, user["email"], fields, _next_code(db))
    sub_ids = []
    acts = []
    for i, st in enumerate(tpl.subtask_titles or []):
        sub = new_task_row(db, user["email"], {
            "title": st, "parent_task_id": parent.id,
            "department_id": parent.department_id, "project_id": parent.project_id,
            "follower_emails": list(followers),
        }, f"{parent.code}.{i + 1}")
        sub_ids.append(sub.id)
        sub.activity_ids = [log_activity(db, type="created", actor_email=user["email"],
                                         entity_id=sub.id, entity_code=sub.code,
                                         entity_title=sub.title, detail="created this task")]
    parent.subtask_ids = sub_ids
    parent.activity_ids = [log_activity(db, type="created", actor_email=user["email"],
                                        entity_id=parent.id, entity_code=parent.code,
                                        entity_title=parent.title,
                                        detail=f'created this task from template "{tpl.name}"')]
    db.commit()
    db.refresh(parent)
    fire_task_event(parent.id, "created")
    return task_to_dict(parent)


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


@router.post("/task-intake-forms", status_code=201)
def create_intake_form(body: IntakeFormBody, db: Session = Depends(get_db)):
    f = models.TaskIntakeForm(id=body.id or gen_id(), title=body.title, fields=body.fields or [],
                              target_project_id=body.target_project_id or "", created_at=now_iso())
    db.add(f)
    db.commit()
    db.refresh(f)
    return intake_form_to_dict(f)


@router.delete("/task-intake-forms/{form_id}", status_code=204)
def delete_intake_form(form_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskIntakeForm).filter(models.TaskIntakeForm.id == form_id).delete()
    db.commit()


class SubmitIntakeBody(BaseModel):
    values: Optional[dict] = None


@router.post("/task-intake-forms/{form_id}/submit", status_code=201)
def submit_intake_form(form_id: str, body: SubmitIntakeBody,
                       user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Create a task in the form's target project from submitted values (source
    createActions.submitIntakeForm)."""
    form = db.query(models.TaskIntakeForm).filter(models.TaskIntakeForm.id == form_id).first()
    if not form:
        raise HTTPException(404, "Intake form not found")
    values = body.values or {}
    title = (values.get("title") or values.get("summary") or "").strip()
    if not title:
        raise HTTPException(422, "A title or summary is required")
    # Department is inherited from the target project (source: project.departmentId).
    dept = ""
    if form.target_project_id:
        proj = db.query(models.TaskProject).filter(
            models.TaskProject.id == form.target_project_id).first()
        if proj:
            dept = proj.department_id or ""
    t = new_task_row(db, user["email"], {
        "title": title, "priority": values.get("priority") or "medium",
        "project_id": form.target_project_id or "", "department_id": dept,
        "due_on": values.get("due") or values.get("dueOn") or "",
        "tags": ["Intake"], "follower_emails": [user["email"]],
    }, _next_code(db))
    t.activity_ids = [log_activity(db, type="created", actor_email=user["email"], entity_id=t.id,
                                   entity_code=t.code, entity_title=t.title,
                                   detail="created this task from an intake form")]
    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "created")
    return task_to_dict(t)


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
            "status": t.status or "new", "priority": t.priority or "medium",
            "requesterId": _nz(t.requester_email), "assigneeId": _nz(t.assignee_email),
            "departmentId": _nz(t.department_id), "linkedTaskId": _nz(t.linked_task_id),
            "tags": t.tags or [], "slaDueOn": _nz(t.sla_due_on), "resolvedAt": _nz(t.resolved_at),
            "createdAt": t.created_at or "", "modifiedAt": t.modified_at or ""}


class TicketBody(BaseModel):
    id: Optional[str] = None
    code: Optional[str] = None
    subject: str
    description: Optional[str] = ""
    status: Optional[str] = "new"
    priority: Optional[str] = "medium"
    requester_email: Optional[str] = ""
    assignee_email: Optional[str] = ""
    department_id: Optional[str] = ""
    linked_task_id: Optional[str] = ""
    tags: Optional[list] = None
    sla_due_on: Optional[str] = ""


class TicketUpdate(BaseModel):
    subject: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    assignee_email: Optional[str] = None
    department_id: Optional[str] = None
    linked_task_id: Optional[str] = None
    tags: Optional[list] = None
    sla_due_on: Optional[str] = None
    resolved_at: Optional[str] = None


def _next_ticket_code(db: Session) -> str:
    return f"TKT-{db.query(models.TaskTicket).count() + 1:03d}"


@router.get("/task-tickets")
def list_tickets(db: Session = Depends(get_db)):
    return [ticket_to_dict(t) for t in db.query(models.TaskTicket).all()]


@router.post("/task-tickets", status_code=201)
def create_ticket(body: TicketBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    t = models.TaskTicket(
        id=body.id or gen_id(), code=body.code or _next_ticket_code(db), subject=body.subject,
        description=body.description or "", status=body.status or "new", priority=body.priority or "medium",
        requester_email=(body.requester_email or user["email"]).lower(),
        assignee_email=(body.assignee_email or "").lower(), department_id=body.department_id or "",
        linked_task_id=body.linked_task_id or "", tags=body.tags or [], sla_due_on=body.sla_due_on or "",
        resolved_at="", created_at=now, modified_at=now,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


@router.patch("/task-tickets/{ticket_id}")
def update_ticket(ticket_id: str, body: TicketUpdate, db: Session = Depends(get_db)):
    t = db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).first()
    if not t:
        raise HTTPException(404, "Ticket not found")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        if k in ("assignee_email",) and v is not None:
            v = (v or "").lower()
        setattr(t, k, v)
    if data.get("status") in ("resolved", "closed") and not t.resolved_at:
        t.resolved_at = now_iso()
    t.modified_at = now_iso()
    db.commit()
    db.refresh(t)
    return ticket_to_dict(t)


@router.delete("/task-tickets/{ticket_id}", status_code=204)
def delete_ticket(ticket_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskTicket).filter(models.TaskTicket.id == ticket_id).delete()
    db.commit()


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
