"""Task Module — core tasks router (rewritten Jul 2026).

Replaces the old flat demo endpoints. Covers tasks CRUD + subtasks/dependencies/
completion/approval + bulk edits, and the per-task sub-resources: comments,
attachments, activity, plus board sections and custom statuses. Identity is
email-keyed; the serialisers emit the export's runtime shape (assigneeId etc.,
with email used as the person id) so the ported frontend maps cleanly.
Reference implementation: routers/items.py.
"""
import re
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any
import models
from database import get_db
from auth import get_current_user
from routers.task_util import (
    now_iso, gen_id, fire_task_event, task_notify, log_activity,
)

router = APIRouter(prefix="/tasks", tags=["Tasks"], dependencies=[Depends(get_current_user)])


# ── Serialisers (snake → export runtime camelCase; email used as person id) ──
def _nz(v):
    """Empty string → None, so the frontend's `x === null` checks match the export."""
    return v if v not in ("", None) else None


def task_to_dict(t: models.Task) -> dict:
    return {
        "id":               t.id,
        "code":             t.code or "",
        "title":            t.title,
        "description":      t.description or "",
        "type":             t.type or "task",
        "status":           t.status or "not_started",
        "priority":         t.priority or "medium",
        "assigneeId":       _nz(t.assignee_email),
        "followerIds":      t.follower_emails or [],
        "likedByIds":       t.liked_by_emails or [],
        "accessLevel":      t.access_level or "org",
        "projectId":        _nz(t.project_id),
        "sectionId":        _nz(t.section_id),
        "departmentId":     _nz(t.department_id),
        "parentTaskId":     _nz(t.parent_task_id),
        "subtaskIds":       t.subtask_ids or [],
        "blockedByIds":     t.blocked_by_ids or [],
        "blockingIds":      t.blocking_ids or [],
        "dependencyTypes":  t.dependency_types if isinstance(t.dependency_types, dict) else {},
        "tags":             t.tags or [],
        "customFieldValues": t.custom_field_values if isinstance(t.custom_field_values, dict) else {},
        "startOn":          _nz(t.start_on),
        "dueOn":            _nz(t.due_on),
        "estimateHours":    t.estimate_hours,
        "actualHours":      t.actual_hours,
        "recurrence":       t.recurrence,
        "isMilestone":      bool(t.is_milestone),
        "approvalStatus":   t.approval_status or "none",
        "completed":        bool(t.completed),
        "completedAt":      _nz(t.completed_at),
        "commentIds":       t.comment_ids or [],
        "attachmentIds":    t.attachment_ids or [],
        "activityIds":      t.activity_ids or [],
        "createdAt":        t.created_at or "",
        "modifiedAt":       t.modified_at or "",
        "syncedWithAsana":  bool(t.synced_with_asana),
    }


def comment_to_dict(c: models.TaskComment) -> dict:
    return {
        "id": c.id, "taskId": c.task_id, "authorId": _nz(c.author_email),
        "body": c.body or "", "createdAt": c.created_at or "",
        "editedAt": _nz(c.edited_at), "pinned": bool(c.pinned),
    }


def attachment_to_dict(a: models.TaskAttachment) -> dict:
    return {
        "id": a.id, "taskId": a.task_id, "name": a.name, "size": a.size or "",
        "kind": a.kind or "other", "dataUrl": _nz(a.url), "url": _nz(a.url),
        "addedAt": a.added_at or "", "addedBy": _nz(a.added_by),
    }


def activity_to_dict(a: models.TaskActivity) -> dict:
    return {
        "id": a.id, "type": a.type or "", "actorId": _nz(a.actor_email),
        "at": a.at or "", "detail": a.detail or "",
        "entityKind": a.entity_kind or "task", "entityId": _nz(a.entity_id),
        "entityCode": _nz(a.entity_code), "entityTitle": _nz(a.entity_title),
    }


def section_to_dict(s: models.TaskSection) -> dict:
    return {"id": s.id, "projectId": _nz(s.project_id), "name": s.name,
            "position": s.position or 0, "createdAt": s.created_at or ""}


def custom_status_to_dict(s: models.TaskCustomStatus) -> dict:
    return {"id": s.id, "label": s.label, "color": s.color or "", "position": s.position or 0}


# ── Task CRUD ────────────────────────────────────────────────────────────────
class TaskCreate(BaseModel):
    id:               Optional[str] = None   # client-provided (optimistic) or server-generated
    code:             Optional[str] = None
    title:            str
    description:      Optional[str] = ""
    type:             Optional[str] = "task"
    status:           Optional[str] = "not_started"
    priority:         Optional[str] = "medium"
    assignee_email:   Optional[str] = ""
    follower_emails:  Optional[list] = None
    liked_by_emails:  Optional[list] = None
    access_level:     Optional[str] = None   # blankTask default is "restricted" (see create_task)
    project_id:       Optional[str] = ""
    section_id:       Optional[str] = ""
    department_id:    Optional[str] = ""
    parent_task_id:   Optional[str] = ""
    subtask_ids:      Optional[list] = None
    blocked_by_ids:   Optional[list] = None
    blocking_ids:     Optional[list] = None
    dependency_types: Optional[dict] = None
    tags:             Optional[list] = None
    custom_field_values: Optional[dict] = None
    start_on:         Optional[str] = ""
    due_on:           Optional[str] = ""
    estimate_hours:   Optional[float] = None
    actual_hours:     Optional[float] = None
    recurrence:       Optional[dict] = None
    is_milestone:     Optional[bool] = False
    approval_status:  Optional[str] = "none"


class TaskUpdate(BaseModel):
    code:             Optional[str] = None
    title:            Optional[str] = None
    description:      Optional[str] = None
    type:             Optional[str] = None
    status:           Optional[str] = None
    priority:         Optional[str] = None
    assignee_email:   Optional[str] = None
    follower_emails:  Optional[list] = None
    liked_by_emails:  Optional[list] = None
    access_level:     Optional[str] = None
    project_id:       Optional[str] = None
    section_id:       Optional[str] = None
    department_id:    Optional[str] = None
    parent_task_id:   Optional[str] = None
    subtask_ids:      Optional[list] = None
    blocked_by_ids:   Optional[list] = None
    blocking_ids:     Optional[list] = None
    dependency_types: Optional[dict] = None
    tags:             Optional[list] = None
    custom_field_values: Optional[dict] = None
    start_on:         Optional[str] = None
    due_on:           Optional[str] = None
    estimate_hours:   Optional[float] = None
    actual_hours:     Optional[float] = None
    recurrence:       Optional[dict] = None
    is_milestone:     Optional[bool] = None
    approval_status:  Optional[str] = None
    completed:        Optional[bool] = None


def _next_code(db: Session) -> str:
    """Next sequential TASK-### code (source: taskFactory.nextTaskCode).

    Parses the numeric part out of every existing code and returns max+1 (min 1),
    so codes are NOT reused after deletes (the old COUNT(*)+1 collided).
    """
    max_n = 0
    for (code,) in db.query(models.Task.code).all():
        digits = re.sub(r"[^0-9]", "", code or "")
        if digits:
            try:
                max_n = max(max_n, int(digits))
            except ValueError:
                pass
    return f"TASK-{max_n + 1:03d}"


def _get_task(db: Session, task_id: str) -> models.Task:
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not t:
        raise HTTPException(404, "Task not found")
    return t


# ── Engine helpers (recurrence date math, follower fan-out, automation rules) ──
def _add_days(iso: str, days: int) -> str:
    """Shift an ISO yyyy-mm-dd date forward by `days` (source lib/date.addDays)."""
    if not iso:
        return iso
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return iso
    return (d + timedelta(days=days)).isoformat()


def _days_until(iso: str) -> Optional[int]:
    """Whole days from today until `iso` (yyyy-mm-dd); None if unparseable."""
    if not iso:
        return None
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None
    return (d - date.today()).days


def _dedupe_lower(*groups) -> list:
    """Flatten the given iterables of emails into one lowercased, de-duped list
    (preserves first-seen order)."""
    out: list = []
    for group in groups:
        for e in (group or []):
            e2 = (e or "").lower()
            if e2 and e2 not in out:
                out.append(e2)
    return out


def notify_followers(db: Session, t: models.Task, actor_email: str, title: str, body: str) -> None:
    """Fan an activity notification out to every follower + the assignee, except
    the actor (source mutations.logActivity)."""
    actor = (actor_email or "").lower()
    recips = set(_dedupe_lower(t.follower_emails, [t.assignee_email]))
    recips.discard(actor)
    for who in recips:
        task_notify(db, kind="task_activity", for_email=who, title=title, body=body, task_id=t.id)


def _activity(db: Session, t: models.Task, actor_email: str, type: str, detail: str, acts: list) -> None:
    """Log an activity story AND notify followers, mirroring the export where
    every logActivity call fans out to task members."""
    acts.append(log_activity(db, type=type, actor_email=actor_email, entity_id=t.id,
                             entity_code=t.code, entity_title=t.title, detail=detail))
    notify_followers(db, t, actor_email, t.title, detail)


_RECUR_STEP = {"daily": 1, "weekly": 7, "monthly": 30, "yearly": 365}


def _spawn_recurrence(db: Session, t: models.Task) -> None:
    """When a recurring task is completed, spawn the next occurrence with dates
    shifted forward by one interval (source createActions.toggleComplete)."""
    rec = t.recurrence if isinstance(t.recurrence, dict) else None
    if not rec:
        return
    step = _RECUR_STEP.get(rec.get("freq"), 365)
    shift = step * (rec.get("interval") or 1)
    now = now_iso()
    nt = models.Task(
        id=gen_id(), code=_next_code(db), title=t.title, description=t.description or "",
        type=t.type or "task", status="not_started", priority=t.priority or "medium",
        assignee_email=(t.assignee_email or "").lower(),
        follower_emails=list(t.follower_emails or []), liked_by_emails=[],
        access_level=t.access_level or "restricted", project_id=t.project_id or "",
        section_id=t.section_id or "", department_id=t.department_id or "",
        parent_task_id="", subtask_ids=[], blocked_by_ids=[], blocking_ids=[],
        dependency_types={}, tags=list(t.tags or []),
        custom_field_values=dict(t.custom_field_values or {}),
        start_on=_add_days(t.start_on, shift) if t.start_on else "",
        due_on=_add_days(t.due_on, shift) if t.due_on else "",
        estimate_hours=t.estimate_hours, actual_hours=None,
        recurrence=rec, is_milestone=False, approval_status="none",
        completed=False, completed_at="",
        comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by=t.created_by or "",
    )
    db.add(nt)
    fire_task_event(nt.id, "created")


def _run_rules(db: Session, t: models.Task, actor_email: str, trigger: str, trigger_value: str = "") -> None:
    """Apply every enabled automation rule matching `trigger` (source
    mutations.runRules). Actions mutate the task in place; each fires one
    "automation" activity. Rule-applied changes do NOT re-trigger rules (the
    source applies actions directly, never recursing), so there's no loop.
    """
    rules = db.query(models.TaskAutomationRule).filter(
        models.TaskAutomationRule.enabled == True).all()  # noqa: E712
    acts = list(t.activity_ids or [])
    for rule in rules:
        trig = rule.trigger if isinstance(rule.trigger, dict) else {}
        if trig.get("type") != trigger:
            continue
        val = trig.get("value")
        if val and val != trigger_value:
            continue
        for action in (rule.actions if isinstance(rule.actions, list) else []):
            atype = action.get("type")
            aval = action.get("value")
            if atype == "set_priority":
                t.priority = aval
            elif atype == "set_status":
                t.status = aval
            elif atype == "set_assignee":
                t.assignee_email = (aval or "").lower()
            elif atype == "add_tag":
                if aval and aval not in (t.tags or []):
                    t.tags = list(t.tags or []) + [aval]
            elif atype == "add_follower":
                fe = (aval or "").lower()
                if fe and fe not in (t.follower_emails or []):
                    t.follower_emails = list(t.follower_emails or []) + [fe]
            elif atype == "set_milestone":
                t.is_milestone = True
            _activity(db, t, actor_email, "automation", f'rule "{rule.name}" ran', acts)
    t.activity_ids = acts


# ── Task builder (shared by create_task, templates, intake forms) ─────────────
_PATCH_KEY_MAP = {
    "title": "title", "description": "description", "type": "type", "status": "status",
    "priority": "priority", "assigneeId": "assignee_email", "followerIds": "follower_emails",
    "likedByIds": "liked_by_emails", "accessLevel": "access_level", "projectId": "project_id",
    "sectionId": "section_id", "departmentId": "department_id", "parentTaskId": "parent_task_id",
    "tags": "tags", "customFieldValues": "custom_field_values", "startOn": "start_on",
    "dueOn": "due_on", "estimateHours": "estimate_hours", "actualHours": "actual_hours",
    "recurrence": "recurrence", "isMilestone": "is_milestone", "approvalStatus": "approval_status",
}


def normalize_patch(patch: dict) -> dict:
    """Translate an export-runtime camelCase Partial<Task> (as stored in template
    patches / intake payloads) into snake-cased task columns."""
    out: dict = {}
    for k, v in (patch or {}).items():
        col = _PATCH_KEY_MAP.get(k)
        if col:
            out[col] = v
    return out


def new_task_row(db: Session, creator_email: str, fields: dict, code: str) -> models.Task:
    """Build a fully-defaulted Task from snake-cased `fields` (source
    taskFactory.blankTask). Adds it to the session; caller commits."""
    now = now_iso()
    t = models.Task(
        id=fields.get("id") or gen_id(), code=code,
        title=fields.get("title") or "Untitled task",
        description=fields.get("description") or "",
        type=fields.get("type") or "task",
        status=fields.get("status") or "not_started",
        priority=fields.get("priority") or "medium",
        assignee_email=(fields.get("assignee_email") or "").lower(),
        follower_emails=_dedupe_lower(fields.get("follower_emails")),
        liked_by_emails=fields.get("liked_by_emails") or [],
        access_level=fields.get("access_level") or "restricted",
        project_id=fields.get("project_id") or "",
        section_id=fields.get("section_id") or "",
        department_id=fields.get("department_id") or "",
        parent_task_id=fields.get("parent_task_id") or "",
        subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={},
        tags=fields.get("tags") or [],
        custom_field_values=fields.get("custom_field_values") or {},
        start_on=fields.get("start_on") or "", due_on=fields.get("due_on") or "",
        estimate_hours=fields.get("estimate_hours"), actual_hours=fields.get("actual_hours"),
        recurrence=fields.get("recurrence"),
        is_milestone=bool(fields.get("is_milestone")),
        approval_status=fields.get("approval_status") or "none",
        completed=False, completed_at="",
        comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by=creator_email,
    )
    db.add(t)
    return t


@router.get("")
def list_tasks(db: Session = Depends(get_db)):
    return [task_to_dict(t) for t in db.query(models.Task).all()]


@router.post("", status_code=201)
def create_task(body: TaskCreate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    tid = body.id or gen_id()
    actor = user["email"].lower()

    # Resolve parent for subtask code + field inheritance.
    parent = None
    if body.parent_task_id:
        parent = db.query(models.Task).filter(models.Task.id == body.parent_task_id).first()

    if body.code:
        code = body.code
    elif parent:
        # Subtask code = {PARENT}.{N}; N = existing subtask count + 1. autoflush=False
        # means the row we're about to add isn't counted, which is what we want.
        n = db.query(models.Task).filter(models.Task.parent_task_id == parent.id).count() + 1
        code = f"{parent.code}.{n}"
    else:
        code = _next_code(db)

    # Inherit parent's project/department when the body leaves them blank.
    project_id = body.project_id or (parent.project_id if parent else "")
    department_id = body.department_id or (parent.department_id if parent else "")

    # Creator + assignee are followers by default (deduped, lowercased).
    followers = _dedupe_lower(body.follower_emails, [user["email"], body.assignee_email])

    t = models.Task(
        id=tid,
        code=code,
        title=body.title,
        description=body.description or "",
        type=body.type or "task",
        status=body.status or "not_started",
        priority=body.priority or "medium",
        assignee_email=(body.assignee_email or "").lower(),
        follower_emails=followers,
        liked_by_emails=body.liked_by_emails or [],
        access_level=body.access_level or "restricted",
        project_id=project_id,
        section_id=body.section_id or "",
        department_id=department_id,
        parent_task_id=body.parent_task_id or "",
        subtask_ids=body.subtask_ids or [],
        blocked_by_ids=body.blocked_by_ids or [],
        blocking_ids=body.blocking_ids or [],
        dependency_types=body.dependency_types or {},
        tags=body.tags or [],
        custom_field_values=body.custom_field_values or {},
        start_on=body.start_on or "",
        due_on=body.due_on or "",
        estimate_hours=body.estimate_hours,
        actual_hours=body.actual_hours,
        recurrence=body.recurrence,
        is_milestone=bool(body.is_milestone),
        approval_status=body.approval_status or "none",
        completed=False,
        completed_at="",
        comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by=user["email"],
    )
    db.add(t)
    # link into parent
    if parent:
        parent.subtask_ids = list(parent.subtask_ids or []) + [tid]
        parent.modified_at = now
    aid = log_activity(db, type="created", actor_email=user["email"], entity_id=tid,
                       entity_code=t.code, entity_title=t.title, detail="created this task")
    t.activity_ids = [aid]
    if t.assignee_email and t.assignee_email != actor:
        task_notify(db, kind="task_assigned", for_email=t.assignee_email,
                    title="You were assigned a task",
                    body=f"{t.code} · {t.title}", task_id=tid)
    # Automation rules fire on creation (source createTask → runRules "created").
    _run_rules(db, t, user["email"], "created")
    db.commit()
    db.refresh(t)
    fire_task_event(tid, "created")
    return task_to_dict(t)


@router.patch("/{task_id}")
def update_task(task_id: str, upd: TaskUpdate, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    data = upd.model_dump(exclude_unset=True)
    actor = user["email"].lower()
    prev_assignee = (t.assignee_email or "").lower()
    prev_status = t.status
    prev_priority = t.priority
    prev_due = t.due_on or ""
    prev_milestone = bool(t.is_milestone)
    prev_tags = list(t.tags or [])
    prev_completed = bool(t.completed)

    for field, val in data.items():
        if field == "completed":
            continue  # handled below
        if field == "assignee_email":
            val = (val or "").lower()
        setattr(t, field, val)

    # completion handling
    if "completed" in data:
        t.completed = bool(data["completed"])
        if t.completed and not prev_completed:
            t.completed_at = now_iso()
            if t.status != "completed":
                t.status = "completed"
        elif not t.completed and prev_completed:
            # Reopen: clear completion AND drop back to in_progress (source toggleComplete).
            t.completed_at = ""
            t.status = "in_progress"
    if data.get("status") == "completed" and not t.completed:
        t.completed = True
        t.completed_at = now_iso()

    new_assignee = (t.assignee_email or "").lower()
    # A newly assigned person auto-follows (source setAssignee).
    if "assignee_email" in data and new_assignee != prev_assignee and new_assignee:
        if new_assignee not in [(e or "").lower() for e in (t.follower_emails or [])]:
            t.follower_emails = list(t.follower_emails or []) + [new_assignee]

    t.modified_at = now_iso()

    # Activity + follower fan-out for meaningful changes (source logActivity notifies
    # every follower≠actor). Each _activity call logs a story and notifies followers.
    acts = list(t.activity_ids or [])
    if "status" in data and data["status"] != prev_status:
        _activity(db, t, user["email"], "status_changed", f"changed status to {data['status']}", acts)
    if "priority" in data and data["priority"] != prev_priority:
        _activity(db, t, user["email"], "priority_changed", f"changed priority to {data['priority']}", acts)
    if "due_on" in data and (data["due_on"] or "") != prev_due:
        _activity(db, t, user["email"], "due_changed", "changed the due date", acts)
    if "is_milestone" in data and bool(data["is_milestone"]) != prev_milestone:
        _activity(db, t, user["email"], "updated",
                  "marked as milestone" if t.is_milestone else "removed the milestone flag", acts)
    if "tags" in data and (data["tags"] or []) != prev_tags:
        _activity(db, t, user["email"], "updated", "updated tags", acts)
    if "assignee_email" in data and new_assignee != prev_assignee:
        _activity(db, t, user["email"], "assignee_changed", "reassigned this task", acts)
        if new_assignee and new_assignee != actor:
            task_notify(db, kind="task_assigned", for_email=new_assignee,
                        title="You were assigned a task",
                        body=f"{t.code} · {t.title}", task_id=t.id)
    if t.completed and not prev_completed:
        _activity(db, t, user["email"], "completed", "completed this task", acts)
    t.activity_ids = acts

    # Automation rules — fire the matching triggers (source runRules within each setter).
    if "status" in data and data["status"] != prev_status:
        _run_rules(db, t, user["email"], "status_changed", data["status"])
    if "priority" in data and data["priority"] != prev_priority:
        _run_rules(db, t, user["email"], "priority_changed", data["priority"])
    if "assignee_email" in data and new_assignee != prev_assignee:
        _run_rules(db, t, user["email"], "assignee_changed", new_assignee)
    if t.completed and not prev_completed:
        days_early = _days_until(t.due_on)
        if days_early is not None and days_early >= 2:
            _run_rules(db, t, user["email"], "completed_early")
        # Recurring task completed → spawn the next occurrence.
        _spawn_recurrence(db, t)

    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return task_to_dict(t)


def _delete_task_core(db: Session, t: models.Task, actor_email: str) -> None:
    """Detach a task from its parent, clear reciprocal dependencies, delete its
    subtasks/comments/attachments, and log the deletion. Shared by delete_task
    and bulk_delete. Caller commits."""
    task_id = t.id
    # detach from parent
    if t.parent_task_id:
        parent = db.query(models.Task).filter(models.Task.id == t.parent_task_id).first()
        if parent:
            parent.subtask_ids = [x for x in (parent.subtask_ids or []) if x != task_id]
    # clear reciprocal dependencies
    for other in db.query(models.Task).filter(
            (models.Task.blocked_by_ids.isnot(None))).all():
        changed = False
        if task_id in (other.blocked_by_ids or []):
            other.blocked_by_ids = [x for x in other.blocked_by_ids if x != task_id]; changed = True
        if task_id in (other.blocking_ids or []):
            other.blocking_ids = [x for x in other.blocking_ids if x != task_id]; changed = True
        if changed:
            other.modified_at = now_iso()
    # delete subtasks
    for sub in db.query(models.Task).filter(models.Task.parent_task_id == task_id).all():
        db.delete(sub)
    db.query(models.TaskComment).filter(models.TaskComment.task_id == task_id).delete()
    db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == task_id).delete()
    log_activity(db, type="deleted", actor_email=actor_email, entity_id=task_id,
                 entity_code=t.code, entity_title=t.title, detail="deleted this task")
    db.delete(t)


@router.delete("/{task_id}", status_code=204)
def delete_task(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    _delete_task_core(db, t, user["email"])
    db.commit()
    fire_task_event(task_id, "deleted")


class BulkUpdate(BaseModel):
    ids: list[str]
    patch: dict[str, Any]


_BULK_ALLOWED = {"status", "priority", "assignee_email", "department_id", "project_id",
                 "completed", "tags", "due_on", "start_on", "is_milestone"}


@router.post("/bulk")
def bulk_update(body: BulkUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    patch = {k: v for k, v in (body.patch or {}).items() if k in _BULK_ALLOWED}
    rows = db.query(models.Task).filter(models.Task.id.in_(body.ids)).all()
    for t in rows:
        for k, v in patch.items():
            if k == "assignee_email":
                v = (v or "").lower()
            if k == "completed":
                t.completed = bool(v)
                t.completed_at = now_iso() if v else ""
                if v:
                    t.status = "completed"
                continue
            setattr(t, k, v)
        t.modified_at = now_iso()
    db.commit()
    fire_task_event("", "bulk")
    return [task_to_dict(t) for t in rows]


# ── Duplicate / log time / bulk delete ───────────────────────────────────────
@router.post("/{task_id}/duplicate", status_code=201)
def duplicate_task(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    src = _get_task(db, task_id)
    # Creator + assignee follow the copy by default (source duplicateTask).
    followers = _dedupe_lower([user["email"], src.assignee_email])
    fields = {
        "title": f"{src.title} (copy)", "description": src.description, "type": src.type,
        "status": src.status, "priority": src.priority, "assignee_email": src.assignee_email,
        "follower_emails": followers, "access_level": src.access_level, "project_id": src.project_id,
        "section_id": src.section_id, "department_id": src.department_id,
        "parent_task_id": src.parent_task_id, "tags": list(src.tags or []),
        "custom_field_values": dict(src.custom_field_values or {}), "start_on": src.start_on,
        "due_on": src.due_on, "estimate_hours": src.estimate_hours, "recurrence": src.recurrence,
        "is_milestone": src.is_milestone, "approval_status": src.approval_status,
    }
    t = new_task_row(db, user["email"], fields, _next_code(db))
    # Link the copy alongside the original under a shared parent (source keeps parentTaskId).
    if t.parent_task_id:
        parent = db.query(models.Task).filter(models.Task.id == t.parent_task_id).first()
        if parent:
            parent.subtask_ids = list(parent.subtask_ids or []) + [t.id]
            parent.modified_at = now_iso()
    aid = log_activity(db, type="created", actor_email=user["email"], entity_id=t.id,
                       entity_code=t.code, entity_title=t.title, detail=f"duplicated from {src.code}")
    t.activity_ids = [aid]
    notify_followers(db, t, user["email"], t.title, f"duplicated from {src.code}")
    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "created")
    return task_to_dict(t)


class LogTimeBody(BaseModel):
    hours: float


@router.post("/{task_id}/log-time")
def log_time(task_id: str, body: LogTimeBody, user: dict = Depends(get_current_user),
             db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    t.actual_hours = (t.actual_hours or 0) + body.hours
    t.modified_at = now_iso()
    acts = list(t.activity_ids or [])
    _activity(db, t, user["email"], "time", f"logged {body.hours}h", acts)
    t.activity_ids = acts
    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return task_to_dict(t)


class BulkDeleteBody(BaseModel):
    ids: list[str]


@router.post("/bulk-delete")
def bulk_delete(body: BulkDeleteBody, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.query(models.Task).filter(models.Task.id.in_(body.ids or [])).all()
    n = 0
    for t in rows:
        _delete_task_core(db, t, user["email"])
        n += 1
    db.commit()
    fire_task_event("", "bulk")
    return {"deleted": n}


# ── Comments ─────────────────────────────────────────────────────────────────
class CommentCreate(BaseModel):
    body: str
    author_email: Optional[str] = None


class CommentUpdate(BaseModel):
    body: Optional[str] = None
    pinned: Optional[bool] = None


@router.get("/{task_id}/comments")
def list_comments(task_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskComment).filter(models.TaskComment.task_id == task_id).all()
    return [comment_to_dict(c) for c in rows]


@router.post("/{task_id}/comments", status_code=201)
def add_comment(task_id: str, body: CommentCreate, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    cid = gen_id()
    c = models.TaskComment(id=cid, task_id=task_id,
                           author_email=(body.author_email or user["email"]).lower(),
                           body=body.body or "", created_at=now_iso(), edited_at="", pinned=False)
    db.add(c)
    t.comment_ids = list(t.comment_ids or []) + [cid]
    aid = log_activity(db, type="commented", actor_email=user["email"], entity_id=task_id,
                       entity_code=t.code, entity_title=t.title, detail="added a comment")
    t.activity_ids = list(t.activity_ids or []) + [aid]
    # notify assignee + followers (except author)
    author = user["email"].lower()
    for who in set([(t.assignee_email or "").lower(), *[(e or "").lower() for e in (t.follower_emails or [])]]):
        if who and who != author:
            task_notify(db, kind="task_activity", for_email=who,
                        title="New comment on a task", body=f"{t.code} · {t.title}", task_id=task_id)
    db.commit()
    db.refresh(c)
    fire_task_event(task_id, "comment")
    return comment_to_dict(c)


@router.patch("/comments/{comment_id}")
def edit_comment(comment_id: str, upd: CommentUpdate, db: Session = Depends(get_db)):
    c = db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).first()
    if not c:
        raise HTTPException(404, "Comment not found")
    if upd.body is not None:
        c.body = upd.body
        c.edited_at = now_iso()
    if upd.pinned is not None:
        c.pinned = bool(upd.pinned)
    db.commit()
    db.refresh(c)
    fire_task_event(c.task_id, "comment")
    return comment_to_dict(c)


@router.delete("/comments/{comment_id}", status_code=204)
def delete_comment(comment_id: str, db: Session = Depends(get_db)):
    c = db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).first()
    if not c:
        raise HTTPException(404, "Comment not found")
    t = db.query(models.Task).filter(models.Task.id == c.task_id).first()
    if t:
        t.comment_ids = [x for x in (t.comment_ids or []) if x != comment_id]
    db.delete(c)
    db.commit()
    fire_task_event(c.task_id, "comment")


# ── Attachments (bytes live in Supabase storage; `url` points there) ─────────
class AttachmentCreate(BaseModel):
    name: str
    size: Optional[str] = ""
    kind: Optional[str] = "other"
    url: Optional[str] = ""


@router.get("/{task_id}/attachments")
def list_attachments(task_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == task_id).all()
    return [attachment_to_dict(a) for a in rows]


@router.post("/{task_id}/attachments", status_code=201)
def add_attachment(task_id: str, body: AttachmentCreate, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    aid = gen_id()
    a = models.TaskAttachment(id=aid, task_id=task_id, name=body.name, size=body.size or "",
                              kind=body.kind or "other", url=body.url or "",
                              added_at=now_iso(), added_by=user["email"])
    db.add(a)
    t.attachment_ids = list(t.attachment_ids or []) + [aid]
    db.commit()
    db.refresh(a)
    fire_task_event(task_id, "attachment")
    return attachment_to_dict(a)


@router.delete("/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: str, db: Session = Depends(get_db)):
    a = db.query(models.TaskAttachment).filter(models.TaskAttachment.id == attachment_id).first()
    if not a:
        raise HTTPException(404, "Attachment not found")
    t = db.query(models.Task).filter(models.Task.id == a.task_id).first()
    if t:
        t.attachment_ids = [x for x in (t.attachment_ids or []) if x != attachment_id]
    db.delete(a)
    db.commit()
    fire_task_event(a.task_id, "attachment")


# ── Activity ─────────────────────────────────────────────────────────────────
@router.get("/activity")
def global_activity(limit: int = 500, db: Session = Depends(get_db)):
    rows = (db.query(models.TaskActivity)
            .order_by(models.TaskActivity.at.desc()).limit(min(limit, 2000)).all())
    return [activity_to_dict(a) for a in rows]


@router.get("/{task_id}/activity")
def task_activity(task_id: str, db: Session = Depends(get_db)):
    rows = (db.query(models.TaskActivity)
            .filter(models.TaskActivity.entity_id == task_id)
            .order_by(models.TaskActivity.at.desc()).all())
    return [activity_to_dict(a) for a in rows]


# ── Sections & custom statuses (board columns) ───────────────────────────────
class SectionBody(BaseModel):
    id: Optional[str] = None
    project_id: Optional[str] = ""
    name: str
    position: Optional[int] = 0


@router.get("/meta/sections")
def list_sections(db: Session = Depends(get_db)):
    return [section_to_dict(s) for s in db.query(models.TaskSection).all()]


@router.post("/meta/sections", status_code=201)
def create_section(body: SectionBody, db: Session = Depends(get_db)):
    s = models.TaskSection(id=body.id or gen_id(), project_id=body.project_id or "",
                           name=body.name, position=body.position or 0, created_at=now_iso())
    db.add(s)
    db.commit()
    db.refresh(s)
    return section_to_dict(s)


@router.patch("/meta/sections/{section_id}")
def update_section(section_id: str, body: SectionBody, db: Session = Depends(get_db)):
    s = db.query(models.TaskSection).filter(models.TaskSection.id == section_id).first()
    if not s:
        raise HTTPException(404, "Section not found")
    if body.name:
        s.name = body.name
    if body.position is not None:
        s.position = body.position
    db.commit()
    db.refresh(s)
    return section_to_dict(s)


@router.delete("/meta/sections/{section_id}", status_code=204)
def delete_section(section_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskSection).filter(models.TaskSection.id == section_id).delete()
    db.commit()


class CustomStatusBody(BaseModel):
    id: Optional[str] = None
    label: str
    color: Optional[str] = ""
    position: Optional[int] = 0


@router.get("/meta/custom-statuses")
def list_custom_statuses(db: Session = Depends(get_db)):
    return [custom_status_to_dict(s) for s in db.query(models.TaskCustomStatus).all()]


@router.post("/meta/custom-statuses", status_code=201)
def create_custom_status(body: CustomStatusBody, db: Session = Depends(get_db)):
    s = models.TaskCustomStatus(id=body.id or gen_id(), label=body.label,
                                color=body.color or "", position=body.position or 0)
    db.add(s)
    db.commit()
    db.refresh(s)
    return custom_status_to_dict(s)


@router.delete("/meta/custom-statuses/{status_id}", status_code=204)
def delete_custom_status(status_id: str, db: Session = Depends(get_db)):
    # Reassign any task parked in this custom column back to the default before
    # deleting the column, so no task is left with a dangling status (source
    # deleteCustomStatus).
    for t in db.query(models.Task).filter(models.Task.status == status_id).all():
        t.status = "not_started"
        t.modified_at = now_iso()
    db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id == status_id).delete()
    db.commit()
