"""Task Module - config & misc router: saved views, automation rules, templates,
intake forms, custom fields, tickets, the module's own notification bell, and the
changelog/"What's New" feature. Single router, absolute paths, email-keyed.
"""
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from sqlalchemy import or_, func
from sqlalchemy.exc import IntegrityError
from collections import Counter
from pydantic import BaseModel
from typing import Optional, Any
import os
import json
import uuid
import httpx
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import models
from database import get_db
from notify_company import notification_company
from auth import get_current_user, require_level, require_manager, require_any_module_grant, module_owner_acts_as
from routers.task_util import (now_iso, gen_id, is_manager, require_project_access, assert_row_wall,
                               config_admits, config_company_for_new, assert_config_editable)
from changelog_prs import known_developer
import task_automation

router = APIRouter(tags=["Tasks"],
                   dependencies=[Depends(get_current_user), Depends(require_any_module_grant("tasks", "tickets")),
                                 Depends(module_owner_acts_as("tasks", 3))])

# Reading What's New is every Nexus user's default (Neil, Oct 12 2026): the
# changelog, its comments, the unseen dot, the weekly bar and the update
# popup's question live here, behind sign-in only. Adding, editing, reviewing,
# publishing and commenting stay on `router` above, behind the task family's
# grant. Externals reach these too (auth._EXTERNAL_BASE_PREFIXES).
view_router = APIRouter(tags=["Tasks"], dependencies=[Depends(get_current_user)])


def _nz(v):
    return v if v not in ("", None) else None


# ── Saved views (per user) ───────────────────────────────────────────────────
def saved_view_to_dict(s: models.TaskSavedView) -> dict:
    return {"id": s.id, "ownerId": _nz(s.owner_email), "name": s.name, "view": s.view or "list",
            "filters": s.filters if isinstance(s.filters, dict) else {},
            "sort": s.sort if isinstance(s.sort, dict) else {}, "group": s.group or "none",
            "scope": s.scope or "task"}


class SavedViewBody(BaseModel):
    id: Optional[str] = None
    name: str
    view: Optional[str] = "list"
    filters: Optional[dict] = None
    sort: Optional[dict] = None
    group: Optional[str] = "none"


@router.get("/task-saved-views")
def list_saved_views(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(models.TaskSavedView)
            .filter(models.TaskSavedView.owner_email == user["email"].lower(),
                    models.TaskSavedView.scope != "ticket").all())
    return [saved_view_to_dict(s) for s in rows]


@router.post("/task-saved-views", status_code=201)
def create_saved_view(body: SavedViewBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    s = models.TaskSavedView(id=body.id or gen_id(), owner_email=user["email"].lower(), name=body.name,
                             view=body.view or "list", filters=body.filters or {}, sort=body.sort or {},
                             group=body.group or "none", scope="task", created_at=now_iso())
    db.add(s)
    db.commit()
    db.refresh(s)
    return saved_view_to_dict(s)


@router.delete("/task-saved-views/{view_id}", status_code=204)
def delete_saved_view(view_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    # A saved view belongs to one person. Filtered to the caller's own task
    # views - the same rows list_saved_views returns - so nobody can delete
    # somebody else's by id, or a ticket view through this route (Sep 30 review).
    db.query(models.TaskSavedView).filter(
        models.TaskSavedView.id == view_id,
        models.TaskSavedView.owner_email == user["email"].lower(),
        models.TaskSavedView.scope != "ticket",
    ).delete(synchronize_session=False)
    db.commit()



# ── Automation rules ─────────────────────────────────────────────────────────
def rule_to_dict(r: models.TaskAutomationRule) -> dict:
    return {"id": r.id, "name": r.name,
            "trigger": r.trigger if isinstance(r.trigger, dict) else {},
            "conditions": r.conditions if isinstance(r.conditions, list) else [],
            "actions": r.actions if isinstance(r.actions, list) else [], "enabled": bool(r.enabled),
            "runCount": int(r.run_count or 0), "lastRunAt": r.last_run_at or ""}


class RuleBody(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None   # optional so PATCH (e.g. enabled toggle) can send partial bodies; required on create (guarded below)
    trigger: Optional[dict] = None
    conditions: Optional[list] = None
    actions: Optional[list] = None
    enabled: Optional[bool] = None


def _scope(user, db: Session):
    """The caller's company scope, or None (walls off / Global Admin). A
    direct in-process call with no user dict reads as walls-off."""
    import auth
    return auth.company_scope(user, db) if isinstance(user, dict) else None


def _rule_projects(conditions) -> list:
    """The projects a rule is confined to ("project is X" conditions) - a
    project-scoped rule is stamped with that project's company."""
    return [str(c.get("value") or "").strip() for c in (conditions or [])
            if isinstance(c, dict) and c.get("field") == "project" and c.get("op", "is") == "is" and c.get("value")]


@router.get("/task-automation-rules")
def list_rules(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Behind a company wall (Oct 21 2026): the caller's companies' rules and
    the shared ('') ones - every rule made before the walls is shared."""
    scope = _scope(user, db)
    return [rule_to_dict(r) for r in db.query(models.TaskAutomationRule).all()
            if config_admits(getattr(r, "company_id", "") or "", scope)]


@router.post("/task-automation-rules", status_code=201, dependencies=[Depends(require_manager)])
def create_rule(body: RuleBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Rule name is required")
    # The engine (task_automation.py) runs whatever is stored, so a rule it
    # cannot run is refused here rather than silently never firing.
    task_automation.validate_rule(body.trigger, body.conditions, body.actions)
    r = models.TaskAutomationRule(id=body.id or gen_id(), name=body.name, trigger=body.trigger or {},
                                  conditions=body.conditions or [], actions=body.actions or [],
                                  enabled=True if body.enabled is None else bool(body.enabled),
                                  created_at=now_iso(),
                                  # '' (shared) while the walls are off / for a Global
                                  # Admin; else the creator's company, and the engine
                                  # then fires it only on that company's tasks.
                                  company_id=(config_company_for_new(db, user, _rule_projects(body.conditions))
                                              if isinstance(user, dict) else ""))
    db.add(r)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.patch("/task-automation-rules/{rule_id}", dependencies=[Depends(require_manager)])
def update_rule(rule_id: str, body: RuleBody, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    r = db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).first()
    if not r:
        raise HTTPException(404, "Rule not found")
    if isinstance(user, dict):
        assert_config_editable(db, user, getattr(r, "company_id", "") or "")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    if any(k in data for k in ("trigger", "conditions", "actions")):
        task_automation.validate_rule(data.get("trigger", r.trigger), data.get("conditions", r.conditions),
                                      data.get("actions", r.actions))
    for k, v in data.items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return rule_to_dict(r)


@router.delete("/task-automation-rules/{rule_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_rule(rule_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    r = db.query(models.TaskAutomationRule).filter(models.TaskAutomationRule.id == rule_id).first()
    if r is None:
        return
    if isinstance(user, dict):
        assert_config_editable(db, user, getattr(r, "company_id", "") or "")
    db.delete(r)
    db.commit()


@router.get("/task-automation-runs", dependencies=[Depends(require_manager)])
def list_rule_runs(rule_id: str = "", limit: int = 50, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """The Runs panel: what each rule actually did, newest first. Rows outlive
    their rule (rule_name is captured on the row) so a deleted rule's history
    still reads. Behind the company wall: a run row carries the task's title,
    so a manager only sees runs on tasks their scope admits."""
    import auth
    from routers.task_util import wall_tasks
    q = db.query(models.TaskAutomationRun)
    if rule_id:
        q = q.filter(models.TaskAutomationRun.rule_id == rule_id)
    limit = max(1, min(int(limit or 50), 200))
    rows = q.order_by(models.TaskAutomationRun.at.desc()).limit(limit * 4 if auth.company_scope(user, db) is not None else limit).all()
    if auth.company_scope(user, db) is not None:
        ids = {x.task_id for x in rows if x.task_id}
        tasks = (db.query(models.Task).execution_options(include_deleted=True)
                 .filter(models.Task.id.in_(ids)).all()) if ids else []
        allowed = {t.id for t in wall_tasks(db, user, tasks)}
        rows = [x for x in rows if x.task_id in allowed][:limit]
    return [{"id": x.id, "ruleId": x.rule_id, "ruleName": x.rule_name, "taskId": x.task_id,
             "taskCode": x.task_code, "taskTitle": x.task_title, "trigger": x.trigger_type,
             "event": x.event, "actions": x.actions if isinstance(x.actions, list) else [],
             "status": x.status, "detail": x.detail or "", "at": x.at} for x in rows]


# ── Templates ────────────────────────────────────────────────────────────────
def template_to_dict(t: models.TaskTemplate) -> dict:
    subs = t.subtasks if isinstance(t.subtasks, list) else []
    return {"id": t.id, "name": t.name, "description": t.description or "",
            "patch": t.patch if isinstance(t.patch, dict) else {},
            # Whole subtasks when saved from a task; the titles are kept in
            # step so every older reader still lists them.
            "subtaskTitles": [s.get("title", "") for s in subs] if subs else (t.subtask_titles or []),
            "subtasks": subs,
            "checklist": t.checklist if isinstance(t.checklist, list) else [],
            "sourceTaskId": t.source_task_id or "", "createdBy": t.created_by or "",
            "createdAt": t.created_at or ""}


class TemplateBody(BaseModel):
    id: Optional[str] = None
    name: str
    description: Optional[str] = ""
    patch: Optional[dict] = None
    subtask_titles: Optional[list] = None


@router.get("/task-templates")
def list_templates(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    scope = _scope(user, db)   # company wall: theirs + the shared ones
    return [template_to_dict(t) for t in db.query(models.TaskTemplate).all()
            if config_admits(getattr(t, "company_id", "") or "", scope)]


@router.post("/task-templates", status_code=201, dependencies=[Depends(require_manager)])
def create_template(body: TemplateBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = models.TaskTemplate(id=body.id or gen_id(), name=body.name, description=body.description or "",
                            patch=body.patch or {}, subtask_titles=body.subtask_titles or [],
                            created_at=now_iso(),
                            company_id=(config_company_for_new(db, user, [(body.patch or {}).get("projectId") or ""])
                                        if isinstance(user, dict) else ""))
    db.add(t)
    db.commit()
    db.refresh(t)
    return template_to_dict(t)


@router.delete("/task-templates/{template_id}", status_code=204)
def delete_template(template_id: str, user: dict = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    # Soft delete -> Recycle Bin, like every other deletable thing in the
    # module. The row stays, hidden by database.py's _hide_soft_deleted hook.
    # A manager, or whoever saved it from their task (Oct 14 2026).
    t = (db.query(models.TaskTemplate).execution_options(include_deleted=True)
         .filter(models.TaskTemplate.id == template_id).first())
    if t and (t.created_by or "").lower() != user["email"].lower():
        # Another company's template is a 404 and a shared one is a Global
        # Admin's - except for whoever saved it (Oct 21 2026).
        assert_config_editable(db, user, getattr(t, "company_id", "") or "")
    if t and not is_manager(user) and (t.created_by or "").lower() != user["email"].lower():
        raise HTTPException(403, "Only a manager or whoever saved this template can delete it.")
    if t:
        t.deleted_at = now_iso()
        t.deleted_by = user["email"]
    db.commit()


# ── Save as Template / Use (Neil, Oct 14 2026) ──────────────────────────────
# "Convert to task template", the way project templates work: the yearly tax
# return with its eleven subtasks, saved once, started again for each entity.
# Saving reads the task server-side (what it is, never its comments, files or
# history); using builds the task, its subtasks and checklists in ONE commit.
_RULE_MARKERS = ("nextOccurrenceId", "closedAsMissed", "count")
TEMPLATE_PARTS = ("subtasks", "assignees", "followers", "fields", "recurrence", "description", "checklist")


def _days_between(a: str, b: str):
    try:
        return (datetime.strptime(b[:10], "%Y-%m-%d") - datetime.strptime(a[:10], "%Y-%m-%d")).days
    except (TypeError, ValueError):
        return None


def _clean_rule(rec):
    if not isinstance(rec, dict):
        return None
    out = {k: v for k, v in rec.items() if k not in _RULE_MARKERS}
    return out or None


def _checklist_of(db: Session, task_id: str) -> list:
    rows = (db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == task_id)
            .order_by(models.TaskChecklistItem.position).all())
    return [{"title": r.title, "assigneeId": r.assignee_email or ""} for r in rows]


class SaveAsTemplateBody(BaseModel):
    name: Optional[str] = ""
    description: Optional[str] = ""
    # What to keep - TEMPLATE_PARTS; absent means all of them.
    parts: Optional[list] = None


@router.post("/tasks/{task_id}/as-template", status_code=201)
def save_task_as_template(task_id: str, body: SaveAsTemplateBody, user: dict = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    from routers.task_util import require_task_role, task_assignees
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not t:
        raise HTTPException(404, "Task not found")
    # Reading the task and everything under it into a shared blueprint takes
    # the same tier as saving a project as one: editor. require_task_role
    # applies the company wall first (404), the same rule the task lists use.
    require_task_role(db, user, t, "editor")
    keep = set(body.parts) & set(TEMPLATE_PARTS) if body.parts is not None else set(TEMPLATE_PARTS)
    name = (body.name or t.title or "").strip()
    if not name:
        raise HTTPException(422, "Template name is required")

    patch = {"priority": t.priority or "medium", "type": t.type or "task",
             "projectId": t.project_id or "", "teamId": t.team_id or "", "tags": list(t.tags or [])}
    if t.estimate_hours is not None:
        patch["estimateHours"] = t.estimate_hours
    if "description" in keep and t.description:
        patch["description"] = t.description
    if "assignees" in keep:
        patch["assigneeIds"] = task_assignees(t)
    if "followers" in keep:
        patch["followerIds"] = list(t.follower_emails or [])
    if "fields" in keep:
        patch["customFieldValues"] = dict(t.custom_field_values or {})
    rule = _clean_rule(t.recurrence) if "recurrence" in keep else None
    if rule and rule.get("freq"):
        patch["recurrence"] = rule

    subtasks = []
    if "subtasks" in keep:
        kids = (db.query(models.Task)
                .filter(models.Task.parent_task_id == t.id,
                        (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)))
                .order_by(models.Task.position).all())
        for s in kids:
            sub = {"title": s.title, "priority": s.priority or "medium", "type": s.type or "task",
                   "dueOffsetDays": _days_between(t.due_on, s.due_on) if (t.due_on and s.due_on) else None,
                   "estimateHours": s.estimate_hours}
            if "description" in keep and s.description:
                sub["description"] = s.description
            if "assignees" in keep:
                sub["assigneeIds"] = task_assignees(s)
            if "followers" in keep:
                sub["followerIds"] = list(s.follower_emails or [])
            if "fields" in keep:
                sub["customFieldValues"] = dict(s.custom_field_values or {})
            if "recurrence" in keep and isinstance(s.recurrence, dict) and (s.recurrence.get("freq") or s.recurrence.get("skip")):
                sub["recurrence"] = _clean_rule(s.recurrence)
            if "checklist" in keep:
                sub["checklist"] = _checklist_of(db, s.id)
            subtasks.append(sub)

    tpl = models.TaskTemplate(
        id=gen_id(), name=name, description=(body.description or "").strip(), patch=patch,
        subtask_titles=[s["title"] for s in subtasks], subtasks=subtasks,
        checklist=_checklist_of(db, t.id) if "checklist" in keep else [],
        source_task_id=t.id, created_by=user["email"].lower(), created_at=now_iso(),
        company_id=config_company_for_new(db, user, [t.project_id or ""]))
    db.add(tpl)
    db.commit()
    db.refresh(tpl)
    return template_to_dict(tpl)


class UseTemplateBody(BaseModel):
    title: Optional[str] = ""
    due_on: Optional[str] = ""
    # "" = the project the template was saved in (if any).
    project_id: Optional[str] = None
    # Field values for the new task - changed ones also go onto its subtasks.
    custom_field_values: Optional[dict] = None


@router.post("/task-templates/{template_id}/use", status_code=201)
def use_template(template_id: str, body: UseTemplateBody, background_tasks: BackgroundTasks,
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Start a task from a template: the main task through create_task (its
    permission, required-field and notification rules), and its subtasks and
    checklists in the same commit. Subtask due dates land as far from the new
    due date as they were from the original's."""
    from routers import tasks as tasks_router
    from routers.task_util import set_task_assignees, task_notify
    tpl = db.query(models.TaskTemplate).filter(models.TaskTemplate.id == template_id).first()
    if not tpl or not config_admits(getattr(tpl, "company_id", "") or "", _scope(user, db)):
        raise HTTPException(404, "Template not found")
    p = tpl.patch if isinstance(tpl.patch, dict) else {}
    due = (body.due_on or "")[:10]
    values = dict(p.get("customFieldValues") or {})
    changed = {}
    for k, v in (body.custom_field_values or {}).items():
        if values.get(k) != v:
            changed[k] = v
        values[k] = v
    # What the subtasks take on: only values the field definitions accept,
    # the same check create_task gives the main task's.
    changed = coerce_custom_field_values(db, changed)
    rule = p.get("recurrence") if isinstance(p.get("recurrence"), dict) and p["recurrence"].get("freq") else None
    project_id = body.project_id if body.project_id is not None else (p.get("projectId") or "")
    if project_id and not db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first():
        project_id = ""   # the template's project has since gone
    status = p.get("status") if p.get("status") and not rule else ("recurring" if rule else "not_started")
    main = tasks_router.TaskCreate(
        title=(body.title or tpl.name or "").strip() or tpl.name, description=p.get("description") or "",
        type=p.get("type") or "task", status=status, priority=p.get("priority") or "medium",
        assignee_emails=list(p.get("assigneeIds") or []), follower_emails=list(p.get("followerIds") or []),
        project_id=project_id, team_id=(p.get("teamId") or "") if project_id == (p.get("projectId") or "") else "",
        tags=list(p.get("tags") or []), custom_field_values=values, due_on=due,
        estimate_hours=p.get("estimateHours"), recurrence=rule,
    )
    subs = tpl.subtasks if isinstance(tpl.subtasks, list) and tpl.subtasks else [
        {"title": x} for x in (tpl.subtask_titles or []) if x]
    actor = user["email"].lower()

    dropped_people: list = []

    def add_children(parent: models.Task) -> None:
        # Every subtask assignee and collaborator has to be somebody who may
        # hold the work (Oct 21 2026): in the Nexus directory, not offboarded,
        # and - behind the company wall only - not in another company. A
        # template keeps whoever was on the task it was saved from, who may
        # have left since. Such a person is LEFT OFF, not refused: one departed
        # collaborator must not fail the whole template. The subtask's history
        # says who was not added and why, and the response lists them
        # (droppedPeople). See task_util.split_people.
        from routers.task_util import split_people, note_dropped_people
        now = parent.created_at or now_iso()
        ids = []
        for i, s in enumerate(subs):
            off = s.get("dueOffsetDays")
            sdue = ""
            if due and isinstance(off, int):
                sdue = (datetime.strptime(due, "%Y-%m-%d") + timedelta(days=off)).date().isoformat()
            srec = s.get("recurrence") if isinstance(s.get("recurrence"), dict) else None
            row = models.Task(
                id=gen_id(), company_id=parent.company_id or "", code=tasks_router._next_code(db),
                title=s.get("title") or "Subtask", description=s.get("description") or "",
                type=s.get("type") or "task", status="recurring" if (srec or {}).get("freq") else "not_started",
                priority=s.get("priority") or "medium", owner_email="",
                follower_emails=[], liked_by_emails=[],
                access_level=parent.access_level or "org", project_id=parent.project_id or "",
                section_id="", team_id=parent.team_id or "", parent_task_id=parent.id, position=float(i),
                subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={}, tags=[],
                custom_field_values={**dict(s.get("customFieldValues") or {}), **changed},
                start_on="", due_on=sdue, estimate_hours=s.get("estimateHours"), actual_hours=None,
                recurrence=srec, is_milestone=False, approval_status="none", completed=False, completed_at="",
                comment_ids=[], attachment_ids=[], activity_ids=[],
                created_at=now, modified_at=now, created_by=actor)
            kept_a, gone_a = split_people(db, row, s.get("assigneeIds") or [], user, actor)
            kept_f, gone_f = split_people(db, row, s.get("followerIds") or [], user, actor)
            set_task_assignees(row, kept_a)
            row.follower_emails = kept_f
            note_dropped_people(db, row, gone_a + gone_f, actor)
            dropped_people.extend({**d, "taskId": row.id} for d in gone_a + gone_f)
            db.add(row)
            _add_checklist(db, row, s.get("checklist"), actor, now)
            ids.append(row.id)
            for who in row.assignee_emails or []:
                if who != actor:
                    task_notify(db, kind="task_assigned", for_email=who, title="You Were Assigned a Task",
                                body=row.title, task_id=row.id,
                                nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
        parent.subtask_ids = ids
        _add_checklist(db, parent, tpl.checklist, actor, now)

    out = tasks_router._create_task(main, background_tasks, user, db, before_commit=add_children,
                                    check_people=True)   # its own people too
    if dropped_people:
        out["droppedPeople"] = [*(out.get("droppedPeople") or []), *dropped_people]
    return out


def _add_checklist(db: Session, task: models.Task, items, actor: str, now: str) -> None:
    items = [x for x in (items if isinstance(items, list) else []) if isinstance(x, dict) and x.get("title")]
    for i, x in enumerate(items):
        db.add(models.TaskChecklistItem(id=gen_id(), task_id=task.id, title=x["title"], done=False,
                                        assignee_email=(x.get("assigneeId") or "").lower(), position=float(i),
                                        created_at=now, created_by=actor))
    task.checklist_total, task.checklist_done = len(items), 0


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
def list_intake_forms(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    scope = _scope(user, db)   # company wall: theirs + the shared ones
    return [intake_form_to_dict(f) for f in db.query(models.TaskIntakeForm).all()
            if config_admits(getattr(f, "company_id", "") or "", scope)]


@router.post("/task-intake-forms", status_code=201, dependencies=[Depends(require_manager)])
def create_intake_form(body: IntakeFormBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    f = models.TaskIntakeForm(id=body.id or gen_id(), title=body.title, fields=body.fields or [],
                              target_project_id=body.target_project_id or "", created_at=now_iso(),
                              company_id=(config_company_for_new(db, user, [body.target_project_id or ""])
                                          if isinstance(user, dict) else ""))
    db.add(f)
    db.commit()
    db.refresh(f)
    return intake_form_to_dict(f)


@router.delete("/task-intake-forms/{form_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_intake_form(form_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    f = db.query(models.TaskIntakeForm).filter(models.TaskIntakeForm.id == form_id).first()
    if f is None:
        return
    if isinstance(user, dict):
        assert_config_editable(db, user, getattr(f, "company_id", "") or "")
    db.delete(f)
    db.commit()


# ── Custom fields ────────────────────────────────────────────────────────────
_FIELD_PALETTE = ["#2563eb", "#0d9488", "#16a34a", "#7c3aed", "#d97706",
                  "#dc2626", "#db2777", "#0891b2", "#4f46e5", "#475569"]


def normalize_field_options(options, ) -> list:
    """Select options as [{id,label,color}].

    Rows written before options carried colors hold plain strings, and the task
    editors still send plain strings today, so both shapes have to read back the
    same or every existing select field would render blank. A missing color is
    assigned from the palette by position rather than left empty, so a field
    always has usable chips."""
    out = []
    for i, o in enumerate(options or []):
        if o is None:
            continue   # str(None) is "None", which would become a real option
        if isinstance(o, dict):
            label = str(o.get("label") or o.get("id") or "").strip()
            if not label:
                continue
            out.append({"id": str(o.get("id") or label), "label": label,
                        "color": o.get("color") or _FIELD_PALETTE[i % len(_FIELD_PALETTE)]})
        else:
            label = str(o).strip()
            if label:
                out.append({"id": label, "label": label, "color": _FIELD_PALETTE[i % len(_FIELD_PALETTE)]})
    return out


def _as_list(raw) -> list:
    """The list-typed kinds (multiselect, people) accept a bare scalar too - a
    field converted from select/text still holds one, and the Asana importer
    seeds a single value the same way."""
    if isinstance(raw, (list, tuple, set)):
        return list(raw)
    return [raw] if raw not in ("", None) else []


def _select_option_id(f: models.TaskCustomField, raw) -> str:
    """One select/multiselect value as its option id, or "" if it matches no
    option. Accepts either the id or the label - the task editors have
    historically sent plain labels, and Asana always sends the label."""
    allowed = {o["id"]: o for o in normalize_field_options(f.options or [])}
    by_label = {o["label"]: o["id"] for o in allowed.values()}
    key = str(raw)
    if key in allowed:
        return key
    if key in by_label:
        return by_label[key]
    # Case-insensitive last resort: Asana's option names and a hand-typed Nexus
    # option routinely differ only by case, and dropping the value over that
    # left the cell blank with no indication anything had arrived.
    lower = {lbl.strip().lower(): oid for lbl, oid in by_label.items()}
    return lower.get(key.strip().lower(), "")


def coerce_custom_field_values(db: Session, values) -> dict:
    """Store custom-field values in the shape their field declares.

    The column is a free JSON dict, so before this every value arrived as
    whatever the widget produced - numbers as strings, dates in whatever the
    input emitted, and selects holding labels that were no longer options after
    the field was edited. Nothing downstream could group, sort, or roll them up
    on that. Coercing here keeps the mess out of every reader.

    Unknown field ids are dropped (the field was deleted); a value that can't be
    coerced is dropped rather than stored wrong. Never raises - inbound Asana
    tasks come through the same create path and must not be rejected."""
    if not isinstance(values, dict) or not values:
        return {}
    defs = {f.id: f for f in db.query(models.TaskCustomField).all()}
    out = {}
    for fid, raw in values.items():
        f = defs.get(fid)
        if f is None or raw in ("", None):
            continue
        kind = (f.type or "text").lower()
        try:
            if kind == "number":
                n = float(raw)
                out[fid] = int(n) if n.is_integer() else n
            elif kind == "checkbox":
                out[fid] = raw if isinstance(raw, bool) else str(raw).strip().lower() in ("1", "true", "yes", "on")
            elif kind == "date":
                out[fid] = str(raw)[:10]
            elif kind == "select":
                out[fid] = _select_option_id(f, raw)
                if not out[fid]:
                    out.pop(fid)
            elif kind == "multiselect":
                # A list of option ids. Order is normalized to the field's own
                # option order so two equal sets can never digest differently
                # and make an unchanged task look changed on every Asana pull.
                order = [o["id"] for o in normalize_field_options(f.options or [])]
                ids = {oid for oid in (_select_option_id(f, v) for v in _as_list(raw)) if oid}
                out[fid] = [oid for oid in order if oid in ids]
                if not out[fid]:
                    out.pop(fid)
            elif kind == "people":
                # A list of Nexus work emails, lowercased and deduped. Sorted for
                # the same digest-stability reason as multiselect above.
                emails = sorted({str(v).strip().lower() for v in _as_list(raw)
                                 if str(v or "").strip() and "@" in str(v)})
                out[fid] = emails
                if not out[fid]:
                    out.pop(fid)
            else:
                out[fid] = str(raw)
        except (TypeError, ValueError):
            continue
    return out


def field_applies_to(f: models.TaskCustomField, project_id: str) -> bool:
    """Empty project_ids = a global field (every project), which is what every
    field was before scoping existed."""
    ids = [p for p in (f.project_ids or []) if p]
    return not ids or (project_id or "") in ids


def field_required_in(f: models.TaskCustomField, project_id: str) -> bool:
    """Must a new task in `project_id` carry a value for this field?

    Yes when the field is a task field that applies to the project and is
    required either everywhere (`required`) or in this project specifically
    (`required_project_ids`, Oct 13 2026). A read-only field never is - it
    can't be filled in."""
    if f.read_only or "task" not in _parse_applies_to(f.applies_to):
        return False
    if not field_applies_to(f, project_id):
        return False
    if f.required:
        return True
    return bool(project_id) and project_id in [p for p in (f.required_project_ids or []) if p]


def missing_required_fields(db: Session, project_id: str, values, task_company: str | None = None) -> list:
    """The fields a new task in `project_id` still needs, given its (already
    coerced) custom-field values. Empty = it can be created.

    `task_company`: a field that belongs to one company (company_id, Oct 21
    2026) binds only that company's tasks; a shared ('') field binds every
    task, as all of them did before. None = do not filter (every field)."""
    have = values if isinstance(values, dict) else {}
    out = []
    for f in db.query(models.TaskCustomField).all():
        if not field_required_in(f, project_id):
            continue
        fc = (getattr(f, "company_id", "") or "").strip()
        if task_company is not None and fc and fc != (task_company or ""):
            continue
        v = have.get(f.id)
        if v is None or v == "" or v == []:
            out.append(f)
    return out


_APPLIES_TO_KINDS = ("task", "project")


def _parse_applies_to(raw) -> list:
    """applies_to is stored as a JSON-encoded array string (e.g. '["task",
    "project"]') so a field can live on both entities at once. Rows written
    before multi-select existed (or seeded directly via SQL, like the
    built-in Location field) hold a bare 'task'/'project' string instead -
    both shapes read back the same rather than needing a backfill."""
    if not raw:
        return ["task"]
    if isinstance(raw, list):
        kinds = raw
    else:
        try:
            parsed = json.loads(raw)
            kinds = parsed if isinstance(parsed, list) else [parsed]
        except (TypeError, ValueError):
            kinds = [raw]   # legacy plain 'task' / 'project' string
    out = [k for k in _APPLIES_TO_KINDS if k in kinds]
    return out or ["task"]


def _dump_applies_to(kinds) -> str:
    out = [k for k in _APPLIES_TO_KINDS if k in (kinds or [])]
    return json.dumps(out or ["task"])


def custom_field_to_dict(f: models.TaskCustomField) -> dict:
    return {"id": f.id, "name": f.name, "description": _nz(f.description), "type": f.type or "text",
            "options": normalize_field_options(f.options if isinstance(f.options, list) else []),
            "projectIds": [p for p in (f.project_ids or []) if p],
            "required": bool(f.required), "readOnly": bool(f.read_only),
            "requiredProjectIds": [p for p in (f.required_project_ids or []) if p],
            "appliesTo": _parse_applies_to(f.applies_to)}


class CustomFieldBody(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None   # optional so PATCH (e.g. adding a project) can send partial bodies; required on create (guarded below)
    description: Optional[str] = ""
    type: Optional[str] = "text"
    options: Optional[list] = None
    project_ids: Optional[list] = None
    required: Optional[bool] = None
    required_project_ids: Optional[list] = None
    read_only: Optional[bool] = None
    applies_to: Optional[list] = None


# Who may change a custom field (Oct 13 2026 review). These three routes took
# no user at all: anyone with a tasks or tickets grant could rename, retype or
# delete a field under every project that uses it. A field's DEFINITION (name,
# type, options, required, read-only, what it applies to) is shared by every
# project it is on, so it is a manager's, like the automation rules above. What
# stays open is the list view's "+ Column" menu (richlist.jsx AddFieldMenu):
# an editor of a project may make a field for that project, and put an existing
# field on it or take it off - the project list is all they can send.
def _require_field_projects(db: Session, user: dict, project_ids) -> None:
    """403 unless `user` is at least editor on every project in `project_ids`.
    An id that is not a project is refused too: require_project_role reads "no
    project" as unrestricted, which is right for a standalone task and wrong
    here."""
    for pid in project_ids:
        project = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
        if not project:
            raise HTTPException(403, "You can only add a field to a project you can edit.")
        require_project_access(db, user, project, "editor")   # company wall, then the role


@router.get("/task-custom-fields")
def list_custom_fields(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    scope = _scope(user, db)   # company wall: theirs + the shared ones (Oct 21 2026)
    return [custom_field_to_dict(f) for f in db.query(models.TaskCustomField).all()
            if config_admits(getattr(f, "company_id", "") or "", scope)]


@router.post("/task-custom-fields", status_code=201)
def create_custom_field(body: CustomFieldBody, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    if not (body.name or "").strip():
        raise HTTPException(422, "Field name is required")
    project_ids = [p for p in (body.project_ids or []) if p]
    required_project_ids = [p for p in (body.required_project_ids or []) if p]
    if not is_manager(user):
        # No project scope = a column on every project's list.
        if not project_ids:
            raise HTTPException(403, "Only a manager can add a field to every project.")
        if (body.required or body.read_only or required_project_ids
                or _parse_applies_to(body.applies_to) != ["task"]):
            raise HTTPException(403, "Only a manager can set that on a custom field.")
        _require_field_projects(db, user, project_ids)
    f = models.TaskCustomField(id=body.id or gen_id(), name=body.name, description=body.description or "",
                               type=body.type or "text",
                               options=normalize_field_options(body.options or []),
                               project_ids=project_ids,
                               required=bool(body.required), read_only=bool(body.read_only),
                               required_project_ids=required_project_ids,
                               applies_to=_dump_applies_to(body.applies_to),
                               company_id=config_company_for_new(db, user, project_ids))
    db.add(f)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


@router.patch("/task-custom-fields/{field_id}")
def update_custom_field(field_id: str, body: CustomFieldBody, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    f = db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).first()
    if not f:
        raise HTTPException(404, "Custom field not found")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    # Company wall (Oct 21 2026): another company's field is a 404. A shared
    # field's DEFINITION reaches every company, so behind a wall only a Global
    # Admin changes it - but putting it on / taking it off a project of your
    # own is about that project, which the project check below covers.
    scope = _scope(user, db)
    if not config_admits(getattr(f, "company_id", "") or "", scope):
        raise HTTPException(404, "Custom field not found")
    shared_walled = scope is not None and not (getattr(f, "company_id", "") or "")
    if set(data) - {"project_ids", "required_project_ids"} or not shared_walled:
        if set(data) - {"project_ids"}:
            assert_config_editable(db, user, getattr(f, "company_id", "") or "")
    else:
        # A walled manager on a SHARED field may move it on or off, and make
        # it required or optional in, their OWN projects - never another
        # company's, and never to or from "every project", which would change
        # every other company's boards. The same limits an editor has,
        # without the role check.
        def _own(pid):
            proj = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
            if proj is None:
                raise HTTPException(403, "You can only change a field on a project you can edit.")
            assert_row_wall(db, user, proj, scope=scope)
        if "project_ids" in data:
            old = {x for x in (f.project_ids or []) if x}
            new = {x for x in (data["project_ids"] or []) if x}
            if not old or not new:
                raise HTTPException(403, "This field is shared by every company - only a Global Admin can change that.")
            for pid in old ^ new:
                _own(pid)
        if "required_project_ids" in data:
            old = [x for x in (f.required_project_ids or []) if x]
            new = [x for x in (data["required_project_ids"] or []) if x]
            for pid in set(old) ^ set(new):
                _own(pid)
    if "name" in data and not (data["name"] or "").strip():
        raise HTTPException(422, "Field name is required")
    if "options" in data:
        data["options"] = normalize_field_options(data["options"] or [])
    if "project_ids" in data:
        data["project_ids"] = [p for p in (data["project_ids"] or []) if p]
    if "required_project_ids" in data:
        data["required_project_ids"] = [p for p in (data["required_project_ids"] or []) if p]
    if "applies_to" in data:
        data["applies_to"] = _dump_applies_to(data["applies_to"])
    if not is_manager(user):
        if set(data) - {"project_ids"}:
            raise HTTPException(403, "Only a manager can change a custom field. You can add it to "
                                     "or remove it from a project you can edit.")
        old = {p for p in (f.project_ids or []) if p}
        new = set(data.get("project_ids", old))
        # Empty on either side is "every project": scoping a company-wide field
        # down, or emptying a scoped one, changes projects this person may not
        # be on at all.
        if not old or not new:
            raise HTTPException(403, "Only a manager can change a field that is on every project.")
        _require_field_projects(db, user, sorted(old ^ new))
    for k, v in data.items():
        setattr(f, k, v)
    db.commit()
    db.refresh(f)
    return custom_field_to_dict(f)


# Manager-only: it takes the field, and with it every value captured in it,
# off every project at once.
@router.delete("/task-custom-fields/{field_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_custom_field(field_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    f = db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).first()
    if f is None:
        return
    if isinstance(user, dict):
        assert_config_editable(db, user, getattr(f, "company_id", "") or "")
    db.delete(f)
    db.commit()



# ── Asana, after the integration (removed Sep 2026) ─────────────────────────
@router.get("/asana-legacy/audit", dependencies=[Depends(require_manager)])
def asana_legacy_audit(limit: int = 200, db: Session = Depends(get_db)):
    """Read-only: every Nexus row still pointing at Asana-hosted content (dead
    now the workspace is gone), and the row counts of the archived asana_*
    tables. See asana_legacy.py."""
    import asana_legacy
    return asana_legacy.audit(db, limit=max(1, min(limit, 1000)))


# ── OCR (mobile "scan text" - quick-add ABC scanner) ─────────────────────────
# Extracts text from an uploaded photo via Tesseract. The engine (pytesseract +
# the `tesseract` binary) must be present on the host; if it isn't we return 501
# so the client can degrade gracefully instead of 500-ing.
# ── AI rephrase (task description editor) ────────────────────────────────────
_REPHRASE_MODEL = "claude-opus-5"
_REPHRASE_MAX_CHARS = 8000


class RephraseBody(BaseModel):
    text: str
    tone: Optional[str] = "clear"   # clear | concise | formal | friendly


_REPHRASE_TONES = {
    "clear": "Rewrite it to be clearer and better organized.",
    "concise": "Rewrite it to be as short as possible while keeping every fact.",
    "formal": "Rewrite it in a professional, formal register.",
    "friendly": "Rewrite it in a warm, approachable register.",
}


@router.post("/task-ai/rephrase")
def task_ai_rephrase(body: RephraseBody):
    """Rephrase a task description. Returns the suggestion only - the editor shows
    it beside the original and the user accepts or rejects it, so nothing is
    overwritten server-side.

    Plain text in, plain text out: the client sends the editor's text content and
    re-inserts the result as a paragraph, which keeps the model away from the
    document's HTML structure entirely. Same httpx-to-api.anthropic.com shape as
    routers/help.py and routers/hr_interviews.py rather than a new SDK dependency.
    """
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "Nothing to rephrase.")
    if len(text) > _REPHRASE_MAX_CHARS:
        raise HTTPException(400, f"That's too long to rephrase (limit {_REPHRASE_MAX_CHARS} characters).")
    if not _ANTHROPIC_API_KEY:
        raise HTTPException(503, "AI rephrasing isn't configured on this server (no ANTHROPIC_API_KEY).")

    instruction = _REPHRASE_TONES.get((body.tone or "clear"), _REPHRASE_TONES["clear"])
    prompt = (
        "The following is the description of a task in an internal company work-tracking "
        "tool. " + instruction + "\n\n"
        "Rules:\n"
        "- Keep every fact, name, date, number, and link exactly as given. Do not invent details.\n"
        "- Keep it in American English.\n"
        "- Preserve the paragraph and list structure of the original.\n"
        "- Output ONLY the rewritten description. No preamble, no quotes, no code fences, "
        "no commentary about what you changed.\n\n"
        "DESCRIPTION:\n" + text
    )
    try:
        with httpx.Client(timeout=90) as client:
            r = client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": _ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": _REPHRASE_MODEL,
                    "max_tokens": 4000,
                    "messages": [{"role": "user", "content": prompt}],
                },
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:   # noqa: BLE001
        print(f"[task-ai] rephrase failed: {e}")
        raise HTTPException(502, "The rephrase service didn't respond. Try again.")

    # A safety decline comes back as a normal 200 with stop_reason "refusal" and
    # empty content - check it before reading blocks, or this returns "" as if it
    # had succeeded.
    if data.get("stop_reason") == "refusal":
        raise HTTPException(422, "The model declined to rewrite that text.")
    out = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text").strip()
    if not out:
        raise HTTPException(502, "The rephrase service returned nothing. Try again.")
    return {"text": out, "model": _REPHRASE_MODEL}


@router.post("/task-ocr")
def task_ocr(image: UploadFile = File(...)):
    # Plain `def` on purpose: Tesseract is seconds of CPU per image, and
    # FastAPI runs a `def` endpoint in its threadpool, off the event loop.
    raw = image.file.read()
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
def mark_notification_read(notif_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    n = db.query(models.TaskNotification).filter(models.TaskNotification.id == notif_id).first()
    # Only the person it was sent to (or an administrator, for one addressed to
    # "admins") - the same targets mark_all_read uses. Somebody else's reads as
    # not found (Sep 30 review).
    targets = [user["email"].lower()] + (["admins"] if user["level"] >= 4 else [])
    if not n or (n.for_email or "").lower() not in targets:
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
    out = {**payload, "id": e.id, "createdAt": e.created_at or "", "updatedAt": e.updated_at or ""}
    # Stored entries keep the developer as GitHub named them; they are read
    # out as the Nexus person (name + work email for the photo).
    if isinstance(payload.get("developers"), list):
        out["developers"] = [known_developer(d) for d in payload["developers"]]
    return out


def changelog_comment_to_dict(c: models.TaskChangelogComment) -> dict:
    return {"id": c.id, "entryId": c.entry_id, "authorId": _nz(c.author_email),
            "body": c.body or "", "createdAt": c.created_at or "",
            "parentId": c.parent_id or None, "mentions": c.mentions if isinstance(c.mentions, list) else []}


class ChangelogEntryBody(BaseModel):
    id: Optional[str] = None
    payload: dict[str, Any]


class ChangelogCommentBody(BaseModel):
    id: Optional[str] = None
    body: str
    parentId: Optional[str] = None          # a reply to this comment
    mentions: Optional[list[str]] = None    # work emails @mentioned


# Reactions on an update (Pranshu, Oct 16 2026) - the same words, in the same
# order, as frontend tasks/ChangelogView.jsx REACTIONS.
CHANGELOG_REACTIONS = ("like", "celebrate", "love", "helpful", "confused")
# Read out of the server, never stored in an entry's payload: the screen sends
# the whole entry back on every save.
_CHANGELOG_COMPUTED = ("reactions", "myReactions", "commentCount")


def _stored_payload(payload: dict) -> dict:
    return {k: v for k, v in (payload or {}).items() if k not in _CHANGELOG_COMPUTED}


def _reaction_summary(db: Session, email: str, entry_ids=None) -> dict:
    """{entry_id: {"reactions": {kind: n}, "myReactions": [kind]}}."""
    q = db.query(models.ChangelogReaction)
    if entry_ids is not None:
        q = q.filter(models.ChangelogReaction.entry_id.in_(list(entry_ids)))
    out: dict = {}
    for r in q.all():
        s = out.setdefault(r.entry_id, {"reactions": {}, "myReactions": []})
        s["reactions"][r.reaction] = s["reactions"].get(r.reaction, 0) + 1
        if r.email == email:
            s["myReactions"].append(r.reaction)
    return out


@view_router.get("/task-changelog")
def list_changelog(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Everything this person may see (changelog_reach.visible): admins get
    every update; everyone else what is Released, not hidden and aimed at
    them, plus their own submissions."""
    import changelog_reach
    changelog_reach.promote_scheduled(db)
    ctx = changelog_reach.viewer(db, user)
    rows = [e for e in db.query(models.TaskChangelogEntry).order_by(models.TaskChangelogEntry.created_at.desc()).all()
            if changelog_reach.visible(changelog_reach.payload_of(e), ctx)]
    reactions = _reaction_summary(db, (user["email"] or "").lower())
    comments = dict(db.query(models.TaskChangelogComment.entry_id, func.count(models.TaskChangelogComment.id))
                    .group_by(models.TaskChangelogComment.entry_id).all())
    out = []
    for e in rows:
        d = changelog_entry_to_dict(e)
        d.update(reactions.get(e.id, {"reactions": {}, "myReactions": []}))
        d["commentCount"] = comments.get(e.id, 0)
        out.append(d)
    return out


def _seen_row(db: Session, email: str) -> models.ChangelogSeen:
    """This person's ChangelogSeen row, created when missing. Several requests
    can ask at once - on a first visit to What's New the header's /seen and the
    New Feature bar's dismissal fire together - so an insert that loses the race
    reads the winner's row instead of failing with a 500 (Oct 12 2026)."""
    row = db.query(models.ChangelogSeen).filter(models.ChangelogSeen.email == email).first()
    if row:
        return row
    try:
        with db.begin_nested():
            row = models.ChangelogSeen(email=email, last_seen_at="", banner_seen_at="")
            db.add(row)
    except IntegrityError:
        row = db.query(models.ChangelogSeen).filter(models.ChangelogSeen.email == email).first()
    return row


def _mark_changelog_seen(db: Session, email: str) -> None:
    """Whoever just published an entry has obviously seen it - stamp their own
    row so their own publish does not raise the New in Nexus bar for them."""
    email = (email or "").lower().strip()
    if not email:
        return
    row = _seen_row(db, email)
    now = now_iso()
    # A new visit (30+ minutes after the last one) keeps the old one as
    # prev_seen_at - "new since your last visit" reads it.
    last = _changelog_instant(row.last_seen_at)
    if last and datetime.now(timezone.utc) - last > timedelta(minutes=30):
        row.prev_seen_at = row.last_seen_at
    row.last_seen_at = now


@router.post("/task-changelog", status_code=201)
def create_changelog(body: ChangelogEntryBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    from routers.changelog_lifecycle import clean_payload
    now = now_iso()
    e = models.TaskChangelogEntry(id=body.id or gen_id(), payload=clean_payload(_stored_payload(body.payload), None),
                                  created_at=now, updated_at=now)
    db.add(e)
    if (body.payload or {}).get("status") == "Released":
        _mark_changelog_seen(db, user["email"])
    import changelog_reach
    changelog_reach.record_history(db, e.id, user["email"], "created", {})
    db.commit()
    db.refresh(e)
    if (body.payload or {}).get("status") == "Released":
        changelog_reach.on_released(db, [e])
    return changelog_entry_to_dict(e)


@router.patch("/task-changelog/{entry_id}")
def update_changelog(entry_id: str, body: ChangelogEntryBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Changelog entry not found")
    import changelog_reach
    from routers.changelog_lifecycle import clean_payload
    before = dict(e.payload) if isinstance(e.payload, dict) else {}
    # issue / prodAt / mergeSha are the server's (changelog_lifecycle).
    e.payload = clean_payload(_stored_payload(body.payload), before)
    e.updated_at = now_iso()
    changelog_reach.record_history(db, e.id, user["email"], "edit", changelog_reach.diff(before, e.payload))
    if (body.payload or {}).get("status") == "Released":
        _mark_changelog_seen(db, user["email"])
    db.commit()
    db.refresh(e)
    if (e.payload or {}).get("status") == "Released" and changelog_reach.status_of(before) != "Released":
        changelog_reach.on_released(db, [e])
    return changelog_entry_to_dict(e)


@view_router.get("/task-changelog/unseen")
def get_changelog_unseen(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """True when a published (Released) entry exists that is newer than this
    user's last visit to What's New. It powered the header's red-dot eye icon,
    removed Oct 14 2026 (the announcement bar and the bell say it); kept for
    tabs still running the old build until they reload."""
    rows = db.query(models.TaskChangelogEntry).all()
    latest = ""
    for e in rows:
        payload = e.payload if isinstance(e.payload, dict) else {}
        if payload.get("status") != "Released":
            continue
        key = payload.get("releasedAt") or e.created_at or ""
        if key > latest:
            latest = key
    if not latest:
        return {"unseen": False}
    seen = db.query(models.ChangelogSeen).filter(
        models.ChangelogSeen.email == user["email"].lower()).first()
    return {"unseen": not seen or (seen.last_seen_at or "") < latest}


@view_router.post("/task-changelog/seen")
def mark_changelog_seen(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _mark_changelog_seen(db, user["email"])
    # What's New is open: its bell entry has been read.
    email = (user["email"] or "").lower()
    for n in (db.query(models.NexusNotification)
              .filter(models.NexusNotification.recipient == email,
                      models.NexusNotification.ref_id == WHATS_NEW_NOTICE_REF).all()):
        readers = [x for x in (n.read_by or "").split(",") if x]
        if email not in readers:
            n.read_by = ",".join(readers + [email])
    db.commit()
    return {"ok": True}


# ── Update announcements (Neil, Oct 12 2026) ───────────────────────────────
# A weekly full-width bar (frontend components/FeatureBanner.jsx), raised by a
# New Feature, and the new-version popup's See What's New. Both speak in
# categories only - "2 new features and 3 bug fixes" - and leave the details to
# What's New itself.
FEATURE_BANNER_DAYS = 7
# A hand-written update used to carry the author's browser wall time with no
# zone; the company's home zone is the best reading of those. New ones are
# saved as instants (ChangelogView's AddUpdateModal), and merges always were.
_CHANGELOG_LOCAL_TZ = ZoneInfo("America/Los_Angeles")


def _changelog_instant(value):
    """An update's time as an aware UTC datetime, or None."""
    s = str(value or "").strip()
    if not s:
        return None
    try:
        at = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=_CHANGELOG_LOCAL_TZ)
    return at.astimezone(timezone.utc)


# Parsed released updates, kept until the table changes. Every page load asks
# for the bar and every stale tab asks what its new version brings, and the
# payloads carry screenshot data URLs - so they are decoded once per change,
# not per request. The change check is one cheap aggregate query.
_released_cache: dict = {"key": None, "rows": []}


def _released_updates(db: Session) -> list:
    """Released updates, newest first, as {id, type, at, merged} - `at` the
    release time, `merged` when the change merged (merges only)."""
    E = models.TaskChangelogEntry
    count, latest_edit, latest_new = db.query(func.count(E.id), func.max(E.updated_at), func.max(E.created_at)).one()
    key = (count, latest_edit or "", latest_new or "")
    if _released_cache["key"] == key:
        return _released_cache["rows"]
    rows = []
    for e in db.query(E).all():
        p = e.payload if isinstance(e.payload, dict) else {}
        if p.get("status") != "Released":
            continue
        at = _changelog_instant(p.get("releasedAt") or e.created_at)
        if at:
            rows.append({"id": e.id, "type": p.get("type") or "Update", "at": at,
                         "merged": _changelog_instant(p.get("mergedAt")),
                         # what changelog_reach.visible() reads
                         "p": {"status": "Released", "hidden": p.get("hidden"), "audience": p.get("audience"),
                               "authorId": p.get("authorId")}})
    rows.sort(key=lambda r: r["at"], reverse=True)
    _released_cache.update(key=key, rows=rows)
    return rows


def _category_counts(rows: list) -> dict:
    return {"counts": dict(Counter(r["type"] for r in rows)), "total": len(rows)}


# Category names are Title Case even mid-sentence (Neil, Oct 12 2026) - the
# same words, in the same order, as frontend lib/changelogCategories.js.
_CATEGORY_WORDS = [
    ("New Feature", "New Feature", "New Features"), ("Improvement", "Improvement", "Improvements"),
    ("Performance", "Performance Improvement", "Performance Improvements"),
    ("Security Update", "Security Update", "Security Updates"), ("Bug Fix", "Bug Fix", "Bug Fixes"),
    ("Hotfix", "Hotfix", "Hotfixes"), ("Maintenance", "Maintenance Update", "Maintenance Updates"),
]


def _summarize_categories(counts: dict) -> str:
    known = {t for t, _, _ in _CATEGORY_WORDS}
    parts = [f"{counts[t]} {one if counts[t] == 1 else many}" for t, one, many in _CATEGORY_WORDS if counts.get(t)]
    other = sum(c for t, c in counts.items() if t not in known)
    if other:
        parts.append(f"{other} Other Update{'' if other == 1 else 's'}")
    return parts[0] if len(parts) < 2 else f"{', '.join(parts[:-1])} and {parts[-1]}"


# The week's news also lives in the notification bell (Neil, Oct 12 2026), so a
# person who dismissed the bar can still find it. One row per person, updated
# in place (CLAUDE.md: never one per release). While the bar is announcing it,
# the bell copy is written already read - no toast or badge on top of the bar;
# while the bar is away for the week, new releases come back unread so the bell
# does the telling. Opening What's New marks it read (mark_changelog_seen).
WHATS_NEW_NOTICE_REF = "whats-new"


def _whats_new_notice(db: Session, email: str, counts: dict, announced: bool) -> None:
    body = f"Updates this week, including {_summarize_categories(counts)}."
    read_by = email if announced else ""
    row = (db.query(models.NexusNotification)
           .filter(models.NexusNotification.recipient == email,
                   models.NexusNotification.ref_id == WHATS_NEW_NOTICE_REF)
           .order_by(models.NexusNotification.created_at.desc()).first())
    if row is not None and row.body == body:
        return
    if row is not None:
        # New releases since: fresh text, back to the top, and out of Closed if
        # the person had cleared last week's copy.
        row.title, row.body, row.created_at, row.read_by, row.actioned = "New in Nexus", body, now_iso(), read_by, False
        row.closed_by = ""
        return
    db.add(models.NexusNotification(
        id=str(uuid.uuid4()), type="whats_new", recipient=email, title="New in Nexus", body=body,
        ref_id=WHATS_NEW_NOTICE_REF, item_name="", requested_by="",
        action=json.dumps({"view": "whats-new"}), actioned=False, read_by=read_by,
        company=notification_company(db, email), created_at=now_iso()))


@view_router.get("/task-changelog/feature-banner")
def get_feature_banner(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Whether to show this person the weekly bar, and what it counts.

    Raised only by a New Feature released in the last 7 days that they have
    not seen (opened What's New since), and never within 7 days of their last
    dismissal - once a week at most, on every device. When it shows it counts
    every category released since they last looked, bug fixes included."""
    email = user["email"].lower()
    week_ago = datetime.now(timezone.utc) - timedelta(days=FEATURE_BANNER_DAYS)
    row = db.query(models.ChangelogSeen).filter(models.ChangelogSeen.email == email).first()
    seen_at = _changelog_instant(row.last_seen_at) if row else None
    floor = max(week_ago, seen_at) if seen_at else week_ago
    import changelog_reach
    ctx = changelog_reach.viewer(db, user)
    fresh = [r for r in _released_updates(db) if r["at"] > floor and changelog_reach.visible(r["p"], ctx)]
    if not any(r["type"] == "New Feature" for r in fresh):
        return {"show": False}
    counts = _category_counts(fresh)
    banner_at = _changelog_instant(row.banner_seen_at) if row else None
    away_this_week = bool(banner_at and banner_at > week_ago)
    # The bell copy, whether or not the bar shows (see _whats_new_notice).
    _whats_new_notice(db, email, counts["counts"], announced=not away_this_week)
    db.commit()
    if away_this_week:
        return {"show": False}
    return {"show": True, **counts}


@view_router.post("/task-changelog/feature-banner/dismiss")
def dismiss_feature_banner(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Dismissed, or What's New opened: no bar for 7 days."""
    _seen_row(db, user["email"].lower()).banner_seen_at = now_iso()
    db.commit()
    return {"ok": True}


@view_router.get("/task-changelog/released-since")
def get_released_since(since: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """What the version waiting for a stale tab brings, by category: Released
    updates whose change came after `since` - the running build's time. A
    merge is placed by when it merged, not when its update was published:
    publishing trails the merge by minutes, and a build cut in between already
    contains it. A hand-written update is placed by its release time."""
    import changelog_reach
    since_at = _changelog_instant(since) or (datetime.now(timezone.utc) - timedelta(days=1))
    ctx = changelog_reach.viewer(db, user)
    return _category_counts([r for r in _released_updates(db)
                             if (r["merged"] or r["at"]) > since_at and changelog_reach.visible(r["p"], ctx)])


@router.delete("/task-changelog/{entry_id}", status_code=204)
def delete_changelog(entry_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).delete()
    db.query(models.TaskChangelogComment).filter(models.TaskChangelogComment.entry_id == entry_id).delete()
    db.query(models.ChangelogReaction).filter(models.ChangelogReaction.entry_id == entry_id).delete()
    db.query(models.ChangelogEntryView).filter(models.ChangelogEntryView.entry_id == entry_id).delete()
    db.query(models.ChangelogEntryHistory).filter(models.ChangelogEntryHistory.entry_id == entry_id).delete()
    db.query(models.ChangelogFeedback).filter(models.ChangelogFeedback.entry_id == entry_id).delete()
    # A request it shipped keeps its status, no longer pointing at it.
    db.query(models.ChangelogFeedback).filter(models.ChangelogFeedback.shipped_entry_id == entry_id).update(
        {models.ChangelogFeedback.shipped_entry_id: ""}, synchronize_session=False)
    db.commit()


@view_router.get("/task-changelog/{entry_id}/comments")
def list_changelog_comments(entry_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskChangelogComment).filter(
        models.TaskChangelogComment.entry_id == entry_id).all()
    return [changelog_comment_to_dict(c) for c in rows]


@router.post("/task-changelog/{entry_id}/comments", status_code=201)
def add_changelog_comment(entry_id: str, body: ChangelogCommentBody,
                          user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import changelog_reach
    entry = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Changelog entry not found")
    text = (body.body or "").strip()
    if not text:
        raise HTTPException(400, "A comment needs some text")
    parent = ""
    if body.parentId:
        top = db.query(models.TaskChangelogComment).filter(models.TaskChangelogComment.id == body.parentId,
                                                         models.TaskChangelogComment.entry_id == entry_id).first()
        if not top:
            raise HTTPException(400, "That comment is not on this update")
        parent = top.parent_id or top.id      # one level of replies: a reply to a reply joins the thread
    mentions = sorted({m.strip().lower() for m in (body.mentions or []) if m and "@" in m})[:20]
    c = models.TaskChangelogComment(id=body.id or gen_id(), entry_id=entry_id,
                                    author_email=user["email"].lower(), body=text[:4000],
                                    created_at=now_iso(), parent_id=parent, mentions=mentions)
    db.add(c)
    db.commit()
    db.refresh(c)
    changelog_reach.on_comment(db, entry, c, user["email"])
    return changelog_comment_to_dict(c)


# ── Publishing, reactions and analytics (Pranshu, Oct 16 2026) ──────────────
# Merged work still publishes on its own; these publish a teammate's
# submission waiting in Pending Review, and re-publish an edited update.
# Either stamps the release time to now, so the update leads the feed and
# counts as fresh for the weekly bar and the bell.
class ChangelogPublishBody(BaseModel):
    ids: Optional[list[str]] = None     # these drafts (default: every Pending Review one)


def _publish(e: models.TaskChangelogEntry, email: str, db: Session = None) -> None:
    p = dict(e.payload) if isinstance(e.payload, dict) else {}
    now = now_iso()
    if db is not None:
        import changelog_reach
        changelog_reach.record_history(db, e.id, email, "republished" if p.get("status") == "Released" else "published", {})
    if p.get("status") == "Released":
        p["republishedAt"] = now
        p["republishCount"] = int(p.get("republishCount") or 0) + 1
    p["status"] = "Released"
    p["releasedAt"] = now
    p["publishedAt"] = now
    p["publishedBy"] = email
    # A merged change's version is the day it went out (_release_label).
    if p.get("origin") == "pr":
        p["version"] = _release_label()
    e.payload = p
    e.updated_at = now


@router.post("/task-changelog/publish-pending")
def publish_pending_changelog(body: ChangelogPublishBody, user: dict = Depends(require_level(3)),
                              db: Session = Depends(get_db)):
    """Publish every update waiting in Pending Review (or just the listed ones)."""
    wanted = set(body.ids or [])
    done = []
    for e in db.query(models.TaskChangelogEntry).all():
        p = e.payload if isinstance(e.payload, dict) else {}
        status = p.get("status") or ("Pending Review" if p.get("origin") == "pr" else "Released")
        if status != "Pending Review" or (wanted and e.id not in wanted):
            continue
        _publish(e, user["email"].lower(), db)
        done.append(e)
    if done:
        _mark_changelog_seen(db, user["email"])
    db.commit()
    import changelog_reach
    changelog_reach.on_released(db, done)
    return {"published": len(done), "entries": [changelog_entry_to_dict(e) for e in done]}


@router.post("/task-changelog/{entry_id}/publish")
def publish_changelog(entry_id: str, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Publish a draft, or re-publish an update that is already out."""
    e = db.query(models.TaskChangelogEntry).filter(models.TaskChangelogEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Changelog entry not found")
    _publish(e, user["email"].lower(), db)
    _mark_changelog_seen(db, user["email"])
    db.commit()
    db.refresh(e)
    import changelog_reach
    changelog_reach.on_released(db, [e])
    return changelog_entry_to_dict(e)


class ChangelogReactionBody(BaseModel):
    reaction: str


@view_router.post("/task-changelog/{entry_id}/reactions")
def toggle_changelog_reaction(entry_id: str, body: ChangelogReactionBody,
                              user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """One reaction per person per update: set it, switch it to another
    kind, or take it back by pressing the same one again. Everyone who reads
    What's New can react."""
    kind = (body.reaction or "").strip().lower()
    if kind not in CHANGELOG_REACTIONS:
        raise HTTPException(400, "Unknown reaction")
    if not db.query(models.TaskChangelogEntry.id).filter(models.TaskChangelogEntry.id == entry_id).first():
        raise HTTPException(404, "Changelog entry not found")
    email = (user["email"] or "").lower()
    R = models.ChangelogReaction
    mine = db.query(R).filter(R.entry_id == entry_id, R.email == email).first()
    if mine and mine.reaction == kind:
        db.delete(mine)
    elif mine:
        mine.reaction, mine.created_at = kind, now_iso()
    else:
        try:
            with db.begin_nested():     # a double click that loses the race is already counted
                db.add(R(id=gen_id(), entry_id=entry_id, email=email, reaction=kind, created_at=now_iso()))
        except IntegrityError:
            pass
    db.commit()
    return _reaction_summary(db, email, [entry_id]).get(entry_id, {"reactions": {}, "myReactions": []})


CHANGELOG_VIEW_GAP_MINUTES = 30   # a view counts again only after this long


class ChangelogViewsBody(BaseModel):
    ids: list[str]


@view_router.post("/task-changelog/views")
def record_changelog_views(body: ChangelogViewsBody, user: dict = Depends(get_current_user),
                           db: Session = Depends(get_db)):
    """These updates were just shown to this person (the What's New tab, or
    opened in full) - for the analytics in Manage."""
    email = (user["email"] or "").lower()
    ids = list(dict.fromkeys(i for i in (body.ids or []) if i))[:100]
    if not email or not ids:
        return {"ok": True}
    E, V = models.TaskChangelogEntry, models.ChangelogEntryView
    known = {i for (i,) in db.query(E.id).filter(E.id.in_(ids)).all()}
    now = now_iso()
    repeat_after = (datetime.now(timezone.utc) - timedelta(minutes=CHANGELOG_VIEW_GAP_MINUTES)).isoformat()
    rows = {v.entry_id: v for v in db.query(V).filter(V.email == email, V.entry_id.in_(list(known))).all()}
    for entry_id in (i for i in ids if i in known):
        if entry_id in rows:
            # A reload or a second look within the half hour is the same
            # visit - it would only inflate Views.
            if (rows[entry_id].last_at or "") < repeat_after:
                rows[entry_id].views = (rows[entry_id].views or 0) + 1
                rows[entry_id].last_at = now
            continue
        try:
            with db.begin_nested():     # two tabs at once: the loser's view is in the winner's row
                db.add(V(id=gen_id(), entry_id=entry_id, email=email, views=1, first_at=now, last_at=now))
        except IntegrityError:
            pass
    db.commit()
    return {"ok": True}


@router.get("/task-changelog/analytics")
def changelog_analytics(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Reach and response per update, and in total, for Manage."""
    per: dict = {}

    def one(entry_id):
        return per.setdefault(entry_id, {"viewers": 0, "views": 0, "reactions": {}, "reactionTotal": 0, "comments": 0})

    people, reactors = set(), set()
    for v in db.query(models.ChangelogEntryView).all():
        s = one(v.entry_id)
        s["viewers"] += 1
        s["views"] += v.views or 0
        people.add(v.email)
    for r in db.query(models.ChangelogReaction).all():
        s = one(r.entry_id)
        s["reactions"][r.reaction] = s["reactions"].get(r.reaction, 0) + 1
        s["reactionTotal"] += 1
        reactors.add(r.email)
    for entry_id, n in (db.query(models.TaskChangelogComment.entry_id, func.count(models.TaskChangelogComment.id))
                        .group_by(models.TaskChangelogComment.entry_id).all()):
        one(entry_id)["comments"] = n
    totals = {
        "peopleReached": len(people),
        "views": sum(s["views"] for s in per.values()),
        "reactions": sum(s["reactionTotal"] for s in per.values()),
        "reactors": len(reactors),
        "comments": sum(s["comments"] for s in per.values()),
    }
    return {"totals": totals, "entries": per}


@router.get("/task-changelog/{entry_id}/analytics")
def changelog_entry_analytics(entry_id: str, user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Who saw one update and how they reacted, latest first."""
    V, R = models.ChangelogEntryView, models.ChangelogReaction
    views = db.query(V).filter(V.entry_id == entry_id).order_by(V.last_at.desc()).all()
    reactions = db.query(R).filter(R.entry_id == entry_id).order_by(R.created_at.desc()).all()
    return {
        "viewers": [{"email": v.email, "views": v.views or 0, "firstAt": v.first_at, "lastAt": v.last_at} for v in views],
        "reactions": [{"email": r.email, "reaction": r.reaction, "at": r.created_at} for r in reactions],
    }


# ── What's New from merged pull requests ─────────────────────────────────────
# Every feature PR that reaches the branch this deployment tracks becomes one
# PUBLISHED "What's New" entry - no review queue, no AI required (Oct 2026;
# changelog_prs.py has the why). Claude only rewrites the wording when the
# Anthropic key works. It used to cluster raw commits into Pending Review
# drafts, which stopped entirely when the account ran out of credit, and
# waited on an admin to publish when it didn't.
_ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")


def deployment_branch() -> str:
    """Which branch THIS deployment IS - "dev", "main", or "" off Azure.

    Derived from WEBSITE_SITE_NAME the same way app_url.py splits dev from prod
    ("dev" anywhere in the name), so neither App Service needs configuring;
    NEXUS_CHANGELOG_BRANCH overrides it if the naming ever stops matching. Read
    fresh on every call rather than cached at import, for app_url.py's
    documented reason: during warm-up the value can arrive slot-suffixed, and
    prod deploys through a staging slot.

    "" means no deployment identity (a laptop) - callers decide what that
    means for them, which is why tracked_branch() below is separate.
    """
    override = os.getenv("NEXUS_CHANGELOG_BRANCH", "").strip()
    if override:
        return override
    site = os.getenv("WEBSITE_SITE_NAME", "").strip().lower()
    if not site:
        return ""
    return "dev" if "dev" in site else "main"


def tracked_branch() -> str:
    """The branch this deployment summarises: which commits it reads, and the
    only merges its changelog reacts to. Off Azure there is no deployment to
    speak of, so it reads dev - the repo's default branch, and what a laptop
    would have gotten anyway."""
    return deployment_branch() or "dev"


def _known_changes(db: Session) -> set[str]:
    """Keys (pr:480, merge:<sha8>, commit:<sha8>) that already have an entry."""
    seen: set[str] = set()
    for e in db.query(models.TaskChangelogEntry).all():
        payload = e.payload if isinstance(e.payload, dict) else {}
        if payload.get("sourceKey"):
            seen.add(str(payload["sourceKey"]))
        if isinstance(payload.get("prNumber"), int):
            seen.add(f"pr:{payload['prNumber']}")
    return seen


def _release_label() -> str:
    """Version for the Version History tab: the day it went out, in Pacific
    time (MM/DD/YYYY, the app-wide date format)."""
    try:
        today = datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:  # noqa: BLE001 - no tz database: UTC is close enough
        today = datetime.now(timezone.utc)
    return today.strftime("%m/%d/%Y")


def generate_changelog_from_commits(db: Session, author_email: str = "") -> dict:
    """Publish one What's New entry per change that landed since the last run
    (a merged PR, a branch merged locally and pushed, or a direct commit).
    Shared by the Check for Updates button and the automatic sweep
    (changelog_auto.py, which the GitHub webhook brings forward). Returns an
    {"error": ...} dict instead of raising - the sweep has no HTTP response to
    attach an exception to. Only an unreadable GitHub history is an error; a
    failed Claude polish publishes the plain wording and says why in
    "polishNote"."""
    import changelog_auto
    import changelog_prs

    state = changelog_auto._read_state(db)
    skipped_before = [str(k) for k in (state.get("skipped_keys") or [])]
    cursor = state.get("pr_cursor", "")
    # When the skip rules change, look at the last few days once more with the
    # new rules: forget the old skips and the cursor. Nothing is published
    # twice - every published entry is known by its sourceKey.
    if state.get("skip_rules") != changelog_prs.SKIP_RULES_VERSION:
        skipped_before, cursor = [], ""
    try:
        prs, head = changelog_prs.fetch_merged_prs(
            tracked_branch(), cursor, _known_changes(db) | set(skipped_before))
    except changelog_prs.GitHubError as e:
        print(f"[changelog] could not read merged PRs: {e}")
        return {"error": f"Could not read merged pull requests: {e}"}

    candidates, skipped = [], []
    for pr in prs:
        (skipped if changelog_prs.skip_reason(pr) else candidates).append(pr)
    drafts = [changelog_prs.draft(pr) for pr in candidates]
    polish_note = ""
    if candidates:
        try:
            for d, p in zip(drafts, changelog_prs.polish(candidates, drafts)):
                d["userFacing"] = p["userFacing"]
                for k in ("title", "description", "type", "module", "businessImpact", "whatsChanged"):
                    if p[k]:
                        d[k] = p[k]
        except changelog_prs.PolishError as e:
            polish_note = str(e)
            print(f"[changelog] publishing without AI wording: {e}")

    now, version = now_iso(), _release_label()
    environment = "Production" if tracked_branch() == "main" else "Staging"
    created = []
    for pr, d in zip(candidates, drafts):
        if d.pop("userFacing", True) is False:
            skipped.append(pr)
            continue
        payload = {
            **d,
            "version": version,
            "environment": environment,
            "releasedAt": now,
            # Developer(s) from GitHub only, never whoever ran this - stamping
            # the clicker put Neil on every update. author_email stays in the
            # signature for the callers.
            "authorId": "",
            "developers": pr.get("developers") or [],
            "sourceKey": pr["key"],
            # The merge commit: changelog_lifecycle.sync_production checks it
            # against main for Live in Production.
            "mergeSha": pr.get("sha", ""),
            # One run publishes several entries at the same releasedAt; this
            # orders them latest merge first.
            "mergedAt": pr.get("mergedAt", ""),
            # A PR keeps its number; a local merge or a direct commit links its commit.
            **({"prNumber": pr["number"], "prRef": f"#{pr['number']}", "prUrl": pr.get("url", "")}
               if pr.get("number") else {"commitShas": [x[:8] for x in pr.get("shas") or [pr.get("sha", "")]], "commitUrl": pr.get("url", "")}),
            "origin": "pr",
            "status": "Released",
        }
        e = models.TaskChangelogEntry(id=gen_id(), payload=payload, created_at=now, updated_at=now)
        db.add(e)
        created.append(e)
    db.commit()
    for e in created:
        db.refresh(e)
    if created:
        import changelog_reach
        changelog_reach.on_released(db, created)
    changelog_auto._write_state(db, {
        "pr_cursor": head,
        "skipped_keys": (skipped_before + [pr["key"] for pr in skipped])[-300:],
        "skip_rules": changelog_prs.SKIP_RULES_VERSION,
        "last_polish_error": polish_note,
    })
    out = {"created": len(created), "scanned": len(prs), "skipped": len(skipped),
           "source": "github", "polishNote": polish_note,
           "entries": [changelog_entry_to_dict(e) for e in created]}
    if not prs:
        out["message"] = "No new changes since the last update."
    elif not created:
        out["message"] = f"Nothing user-facing in the {len(prs)} new change{'' if len(prs) == 1 else 's'}."
    return out


@router.post("/task-changelog/generate")
def generate_changelog(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    import changelog_auto
    lock = changelog_auto.try_lock(db)
    if not lock:
        raise HTTPException(409, "An update check is already running - try again in a minute.")
    try:
        result = generate_changelog_from_commits(db, user["email"])
    finally:
        changelog_auto.unlock(lock)
    try:
        changelog_auto.record_manual(db, result)
    except Exception as e:  # noqa: BLE001 - the status line must never fail the click
        db.rollback()
        print(f"[changelog] could not record the manual run: {e}")
    if "error" in result:
        raise HTTPException(503, result["error"])
    return result


@router.get("/task-changelog/auto-status")
def changelog_auto_status(user: dict = Depends(require_level(3)), db: Session = Depends(get_db)):
    """Automatic drafting's last run, last error and next run (changelog_auto)."""
    import changelog_auto
    return changelog_auto.status(db)
