"""Task Module — core tasks router (rewritten Jul 2026).

Replaces the old flat demo endpoints. Covers tasks CRUD + subtasks/dependencies/
completion/approval + bulk edits, and the per-task sub-resources: comments,
attachments, activity, plus board sections and custom statuses. Identity is
email-keyed; the serialisers emit the export's runtime shape (assigneeId etc.,
with email used as the person id) so the ported frontend maps cleanly.
Reference implementation: routers/items.py.
"""
import calendar
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any
import models
from database import get_db
from auth import get_current_user, require_manager
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
        "ownerId":          _nz(t.owner_email),
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
    owner_email:      Optional[str] = ""
    follower_emails:  Optional[list] = None
    liked_by_emails:  Optional[list] = None
    access_level:     Optional[str] = "org"
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
    owner_email:      Optional[str] = None
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
    n = db.query(models.Task).count() + 1
    return f"TASK-{n:03d}"


def _get_task(db: Session, task_id: str) -> models.Task:
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not t:
        raise HTTPException(404, "Task not found")
    return t


# ── Recurrence: occurrence generation ────────────────────────────────────────
# recurrence = {freq, interval, dayOfWeek?, dayOfMonth?, until?, count?}
# dayOfWeek is the frontend index (0=Sunday..6=Saturday); until/count are the
# end condition. `count` on an instance means "occurrences remaining, this one
# inclusive" — it is decremented each time the next occurrence is spawned, so a
# series with count=N produces exactly N tasks.
def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _next_due(base_iso: str, rec: dict) -> str:
    """Next due date (YYYY-MM-DD) after `base_iso`, per the recurrence rule."""
    try:
        base = datetime.strptime((base_iso or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        base = date.today()
    freq = rec.get("freq")
    interval = max(1, int(rec.get("interval") or 1))
    if freq == "weekly":
        dow = rec.get("dayOfWeek")
        if dow is None:
            return (base + timedelta(weeks=interval)).isoformat()
        target = (int(dow) - 1) % 7          # frontend Sun=0 → Python Mon=0
        nxt = base + timedelta(days=1)
        while nxt.weekday() != target:
            nxt += timedelta(days=1)
        return (nxt + timedelta(weeks=interval - 1)).isoformat()
    if freq == "monthly":
        nxt = _add_months(base, interval)
        dom = rec.get("dayOfMonth")
        if dom:
            day = min(int(dom), calendar.monthrange(nxt.year, nxt.month)[1])
            nxt = date(nxt.year, nxt.month, day)
        return nxt.isoformat()
    # daily (and any unknown freq) → advance whole days
    return (base + timedelta(days=interval)).isoformat()


def _spawn_next_occurrence(db: Session, t: models.Task, user: dict) -> Optional[models.Task]:
    """When a recurring task is completed, create its next occurrence (unless the
    end condition — `until` date or `count` — is reached). Returns the new task
    or None if the series has ended. Top-level tasks only; subtasks don't recur."""
    rec = t.recurrence
    if not isinstance(rec, dict) or not rec.get("freq") or t.parent_task_id:
        return None

    count = rec.get("count")
    if count is not None and int(count) <= 1:
        return None  # this was the final occurrence

    base_iso = t.due_on or (t.completed_at or now_iso())[:10]
    next_due = _next_due(base_iso, rec)
    until = rec.get("until")
    if until and next_due > until:
        return None  # past the series end date

    new_rec = dict(rec)
    if count is not None:
        new_rec["count"] = int(count) - 1

    now = now_iso()
    nid = gen_id()
    nxt = models.Task(
        id=nid,
        code=_next_code(db),
        title=t.title,
        description=t.description or "",
        type=t.type or "task",
        status="recurring",
        priority=t.priority or "medium",
        assignee_email=t.assignee_email or "",
        owner_email=t.owner_email or "",
        follower_emails=list(t.follower_emails or []),
        liked_by_emails=[],
        access_level=t.access_level or "org",
        project_id=t.project_id or "",
        section_id=t.section_id or "",
        department_id=t.department_id or "",
        parent_task_id="",
        subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={},
        tags=list(t.tags or []),
        custom_field_values=dict(t.custom_field_values or {}),
        start_on="",
        due_on=next_due,
        estimate_hours=t.estimate_hours,
        actual_hours=None,
        recurrence=new_rec,
        is_milestone=bool(t.is_milestone),
        approval_status="none",
        completed=False,
        completed_at="",
        comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by=user["email"],
    )
    db.add(nxt)
    aid = log_activity(db, type="created", actor_email=user["email"], entity_id=nid,
                       entity_code=nxt.code, entity_title=nxt.title,
                       detail=f"recurring occurrence generated from {t.code}")
    nxt.activity_ids = [aid]
    if nxt.assignee_email and nxt.assignee_email != user["email"].lower():
        task_notify(db, kind="task_assigned", for_email=nxt.assignee_email,
                    title="Recurring task due",
                    body=f"{nxt.code} · {nxt.title} (due {next_due})", task_id=nid,
                    nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    return nxt


@router.get("")
def list_tasks(db: Session = Depends(get_db)):
    return [task_to_dict(t) for t in db.query(models.Task).all()]


@router.post("", status_code=201)
def create_task(body: TaskCreate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    now = now_iso()
    tid = body.id or gen_id()
    t = models.Task(
        id=tid,
        code=body.code or _next_code(db),
        title=body.title,
        description=body.description or "",
        type=body.type or "task",
        status=body.status or "not_started",
        priority=body.priority or "medium",
        assignee_email=(body.assignee_email or "").lower(),
        owner_email=(body.owner_email or "").lower(),
        follower_emails=body.follower_emails or [],
        liked_by_emails=body.liked_by_emails or [],
        access_level=body.access_level or "org",
        project_id=body.project_id or "",
        section_id=body.section_id or "",
        department_id=body.department_id or "",
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
    if t.parent_task_id:
        parent = db.query(models.Task).filter(models.Task.id == t.parent_task_id).first()
        if parent:
            parent.subtask_ids = list(parent.subtask_ids or []) + [tid]
            parent.modified_at = now
    aid = log_activity(db, type="created", actor_email=user["email"], entity_id=tid,
                       entity_code=t.code, entity_title=t.title, detail="created this task")
    t.activity_ids = [aid]
    if t.assignee_email and t.assignee_email != user["email"].lower():
        task_notify(db, kind="task_assigned", for_email=t.assignee_email,
                    title="You were assigned a task",
                    body=f"{t.code} · {t.title}", task_id=tid,
                    nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    db.commit()
    db.refresh(t)
    fire_task_event(tid, "created")
    return task_to_dict(t)


@router.patch("/{task_id}")
def update_task(task_id: str, upd: TaskUpdate, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    data = upd.model_dump(exclude_unset=True)
    prev_assignee = (t.assignee_email or "").lower()
    prev_status = t.status
    prev_completed = bool(t.completed)

    for field, val in data.items():
        if field == "completed":
            continue  # handled below
        if field in ("assignee_email", "owner_email"):
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
            t.completed_at = ""
    if data.get("status") == "completed" and not t.completed:
        t.completed = True
        t.completed_at = now_iso()

    t.modified_at = now_iso()

    # activity + notifications for meaningful changes
    acts = list(t.activity_ids or [])
    if "status" in data and data["status"] != prev_status:
        acts.append(log_activity(db, type="status_changed", actor_email=user["email"],
                                 entity_id=t.id, entity_code=t.code, entity_title=t.title,
                                 detail=f"changed status to {data['status']}"))
    new_assignee = (t.assignee_email or "").lower()
    if "assignee_email" in data and new_assignee != prev_assignee:
        acts.append(log_activity(db, type="assignee_changed", actor_email=user["email"],
                                 entity_id=t.id, entity_code=t.code, entity_title=t.title,
                                 detail="reassigned this task"))
        if new_assignee and new_assignee != user["email"].lower():
            task_notify(db, kind="task_assigned", for_email=new_assignee,
                        title="You were assigned a task",
                        body=f"{t.code} · {t.title}", task_id=t.id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    if t.completed and not prev_completed:
        acts.append(log_activity(db, type="completed", actor_email=user["email"],
                                 entity_id=t.id, entity_code=t.code, entity_title=t.title,
                                 detail="completed this task"))
    t.activity_ids = acts

    # Completing a recurring task rolls the series forward to the next occurrence.
    spawned = _spawn_next_occurrence(db, t, user) if (t.completed and not prev_completed) else None

    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "updated")
    if spawned is not None:
        fire_task_event(spawned.id, "created")
    return task_to_dict(t)


@router.delete("/{task_id}", status_code=204)
def delete_task(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
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
    log_activity(db, type="deleted", actor_email=user["email"], entity_id=task_id,
                 entity_code=t.code, entity_title=t.title, detail="deleted this task")
    db.delete(t)
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
                        title="New comment on a task", body=f"{t.code} · {t.title}", task_id=task_id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
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
    act = log_activity(db, type="attached", actor_email=user["email"], entity_id=task_id,
                       entity_code=t.code, entity_title=t.title,
                       detail=f'attached "{a.name}"')
    t.activity_ids = list(t.activity_ids or []) + [act]
    db.commit()
    db.refresh(a)
    fire_task_event(task_id, "attachment")
    return attachment_to_dict(a)


@router.delete("/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: str, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    a = db.query(models.TaskAttachment).filter(models.TaskAttachment.id == attachment_id).first()
    if not a:
        raise HTTPException(404, "Attachment not found")
    t = db.query(models.Task).filter(models.Task.id == a.task_id).first()
    if t:
        t.attachment_ids = [x for x in (t.attachment_ids or []) if x != attachment_id]
        act = log_activity(db, type="attachment_removed", actor_email=user["email"], entity_id=t.id,
                           entity_code=t.code, entity_title=t.title,
                           detail=f'removed attachment "{a.name}"')
        t.activity_ids = list(t.activity_ids or []) + [act]
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


@router.post("/meta/custom-statuses", status_code=201, dependencies=[Depends(require_manager)])
def create_custom_status(body: CustomStatusBody, db: Session = Depends(get_db)):
    s = models.TaskCustomStatus(id=body.id or gen_id(), label=body.label,
                                color=body.color or "", position=body.position or 0)
    db.add(s)
    db.commit()
    db.refresh(s)
    return custom_status_to_dict(s)


@router.delete("/meta/custom-statuses/{status_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_custom_status(status_id: str, db: Session = Depends(get_db)):
    db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id == status_id).delete()
    db.commit()
