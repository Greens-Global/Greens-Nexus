"""Task Module - core tasks router (rewritten Jul 2026).

Replaces the old flat demo endpoints. Covers tasks CRUD + subtasks/dependencies/
completion/approval + bulk edits, and the per-task sub-resources: comments,
attachments, activity, plus board sections and custom statuses. Identity is
email-keyed; the serialisers emit the export's runtime shape (assigneeId etc.,
with email used as the person id) so the ported frontend maps cleanly.
Reference implementation: routers/items.py.
"""
import calendar
import logging
import io
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote, unquote, urlparse

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import String, and_, cast, func, or_
from sqlalchemy.exc import IntegrityError, InvalidRequestError
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, Any
import models
from database import get_db
from auth import get_current_user, require_manager, require_any_module_grant, module_owner_acts_as, require_module_grant
from routers.task_util import (
    now_iso, gen_id, fire_task_event, task_notify, log_activity, email_list,
    is_manager, visible_project_ids, task_is_visible, wall_tasks,
    project_for_task, require_project_role, require_task_role, create_comment,
    task_assignees, set_task_assignees,
    purge_task_permanently, assert_person_on_task, COMMENT_REACTIONS,
    extract_mentions,
    assert_task_wall, require_project_access, wall_rows, wall_teams,
    config_admits, config_company_for_new, assert_config_editable,
    task_visible_to, assert_person_assignable, project_role_for, PROJECT_ROLE_RANK, row_company,
    split_people, note_dropped_people,
)
from task_notify import notify_task_event
import task_due
import task_automation
import task_schedule
import code_sequence
from task_files import data_url_to_storage
# Values are stored in the shape each field declares - see that function.
from routers.task_config import coerce_custom_field_values, missing_required_fields

router = APIRouter(prefix="/tasks", tags=["Tasks"],
                   dependencies=[Depends(get_current_user), Depends(require_any_module_grant("tasks", "tickets")),
                                 Depends(module_owner_acts_as("tasks", 3))])


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
        "position":         t.position if t.position is not None else 0.0,
        # assigneeId stays the PRIMARY assignee so every existing reader keeps
        # working unchanged; assigneeIds is the real answer (see models.Task).
        "assigneeId":       _nz(t.assignee_email),
        "assigneeIds":      task_assignees(t),
        "ownerId":          _nz(t.owner_email),
        "followerIds":      t.follower_emails or [],
        "likedByIds":       t.liked_by_emails or [],
        "reactions":        t.reactions if isinstance(t.reactions, dict) else {},
        "accessLevel":      t.access_level or "org",
        "projectId":        _nz(t.project_id),
        "projectIds":       [p for p in (t.project_ids or []) if p],
        "sectionId":        _nz(t.section_id),
        "teamId":           _nz(t.team_id),
        "parentTaskId":     _nz(t.parent_task_id),
        "subtaskIds":       t.subtask_ids or [],
        "subtaskOrder":     t.subtask_order or "",
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
        "sourceTicketId":   _nz(t.source_ticket_id),
        # Due-date accountability - see task_due.py.
        "dueExtensionCount": int(t.due_extension_count or 0),
        "dueHistory":       t.due_history if isinstance(t.due_history, list) else [],
        "dueAgreement":     t.due_agreement or "",
        "dueProposal":      t.due_proposal if isinstance(t.due_proposal, dict) else None,
        "requesterId":      _nz(task_due.requester_of(t)),
        # Checklist counters - see models.Task / _recount_checklist.
        "checklistTotal":   int(t.checklist_total or 0),
        "checklistDone":    int(t.checklist_done or 0),
        # Time entries - see models.TaskTimeEntry / _recount_time.
        "timeEntryCount":   int(t.time_entry_count or 0),
    }


def time_entry_to_dict(e: models.TaskTimeEntry) -> dict:
    return {"id": e.id, "taskId": e.task_id, "personId": _nz(e.person_email),
            "startedAt": e.started_at or "", "endedAt": _nz(e.ended_at), "running": not e.ended_at,
            "minutes": int(e.minutes or 0), "note": e.note or "", "billable": bool(e.billable),
            "source": e.source or "timer", "createdAt": e.created_at or ""}


def checklist_item_to_dict(i: models.TaskChecklistItem) -> dict:
    return {"id": i.id, "taskId": i.task_id, "title": i.title or "", "done": bool(i.done),
            "doneAt": i.done_at or "", "doneBy": _nz(i.done_by), "assigneeId": _nz(i.assignee_email),
            "position": i.position if i.position is not None else 0.0,
            "createdAt": i.created_at or "", "createdBy": _nz(i.created_by)}


def comment_to_dict(c: models.TaskComment) -> dict:
    return {
        "id": c.id, "taskId": c.task_id, "authorId": _nz(c.author_email),
        "body": c.body or "", "createdAt": c.created_at or "",
        "editedAt": _nz(c.edited_at), "pinned": bool(c.pinned),
        # Threads, reactions, action items (Oct 2026) - see models.TaskComment.
        "parentId": _nz(c.parent_id),
        "reactions": c.reactions if isinstance(c.reactions, dict) else {},
        "assigneeId": _nz(c.assignee_email),
        "resolvedAt": _nz(c.resolved_at), "resolvedBy": _nz(c.resolved_by),
    }


def attachment_to_dict(a: models.TaskAttachment) -> dict:
    return {
        "id": a.id, "taskId": a.task_id, "name": a.name, "size": a.size or "",
        "kind": a.kind or "other", "dataUrl": _nz(a.url), "url": _nz(a.url),
        "addedAt": a.added_at or "", "addedBy": _nz(a.added_by),
        "commentId": _nz(a.comment_id),
        # File versions + Egnyte links (Oct 22 2026) - see models.TaskAttachment.
        "version": a.version or 1, "versionGroup": a.version_group or a.id,
        "egnytePath": _nz(a.egnyte_path), "egnyteKind": _nz(a.egnyte_kind),
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
            "position": s.position or 0, "createdAt": s.created_at or "",
            "custom": bool(getattr(s, "custom", False))}


def custom_status_to_dict(s: models.TaskCustomStatus) -> dict:
    return {"id": s.id, "label": s.label, "color": s.color or "", "position": s.position or 0,
            "projectIds": [p for p in (s.project_ids or []) if p]}


# ── Task CRUD ────────────────────────────────────────────────────────────────
class TaskCreate(BaseModel):
    id:               Optional[str] = None   # client-provided (optimistic) or server-generated
    code:             Optional[str] = None
    title:            str
    description:      Optional[str] = ""
    type:             Optional[str] = "task"
    status:           Optional[str] = "not_started"
    priority:         Optional[str] = "medium"
    position:         Optional[float] = None   # manual drag-order - see models.Task.position
    assignee_email:   Optional[str] = ""     # legacy single; folded into the list
    assignee_emails:  Optional[list] = None
    owner_email:      Optional[str] = ""
    follower_emails:  Optional[list] = None
    liked_by_emails:  Optional[list] = None
    # None (not "org") so create_task can tell "not specified" apart from an
    # explicit choice - an unspecified task inherits its project's visibility
    # instead of always defaulting to org-wide.
    access_level:     Optional[str] = None
    project_id:       Optional[str] = ""
    project_ids:      Optional[list] = None   # EXTRA projects beyond project_id - see models.Task
    section_id:       Optional[str] = ""
    team_id:          Optional[str] = ""
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
    position:         Optional[float] = None   # manual drag-order - see models.Task.position
    assignee_email:   Optional[str] = None   # legacy single; folded into the list
    assignee_emails:  Optional[list] = None
    owner_email:      Optional[str] = None
    follower_emails:  Optional[list] = None
    liked_by_emails:  Optional[list] = None
    access_level:     Optional[str] = None
    project_id:       Optional[str] = None
    project_ids:      Optional[list] = None   # EXTRA projects beyond project_id - see models.Task
    section_id:       Optional[str] = None
    team_id:          Optional[str] = None
    parent_task_id:   Optional[str] = None
    subtask_ids:      Optional[list] = None
    subtask_order:    Optional[str] = None    # "" (due date, then priority) | "manual"
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
    """The next task code, from the never-repeating counter in
    code_sequence.py.

    Was COUNT(*)+1 under pg_advisory_xact_lock. The lock stopped two creates
    racing (Sep 22), but a count is "how many", not "what comes next": with
    a task deleted - or just moved to Trash, which the soft-delete filter
    hides from the count - the next create reused a code still on a live or
    restorable task (Sep 30 review #5). The counter only ever goes up."""
    return code_sequence.next_task_code(db)


def _extra_project_ids(project_ids: Optional[list], project_id: str) -> list:
    """Clean a task's EXTRA project list: strip blanks, drop the primary
    project_id (it's not an "extra"), dedupe while preserving order."""
    seen, out = set(), []
    for p in (project_ids or []):
        p = (p or "").strip()
        if p and p != project_id and p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _follow_as_actor(t, actor: str) -> None:
    """Put `actor` on the task as a collaborator unless they are already on it.

    Whoever puts work on someone else's plate almost always wants the comments
    and the completion (Sagar, Aug 27), and remembering to add yourself is
    exactly the step that gets skipped. Applied when a task is CREATED and
    whenever assignees are newly ADDED - never on an unassign, which is not a
    reason to subscribe anyone to anything.

    No-ops when the actor is an assignee (they are already on it, and a
    duplicate would show their own face twice in the Person cell) or already a
    follower. Deliberately never reached by the Asana sync, which builds rows
    directly in asana_sync.py - the sync worker must not subscribe itself to
    the entire workspace.
    """
    actor = (actor or "").strip().lower()
    if not actor or actor in task_assignees(t):
        return
    followers = list(t.follower_emails or [])
    if actor not in followers:
        t.follower_emails = followers + [actor]


def _assignees_from(data: dict, current: list) -> Optional[list]:
    """What a payload means for assignment, or None if it says nothing.

    Accepts both shapes so nothing has to migrate at once:
      • `assignee_emails` - the real field, wins when present.
      • `assignee_email`  - the legacy single. Treated as "this task is assigned
        to exactly this one person" (or to nobody, when blank), which is what it
        has always meant. It must NOT be merged into the existing list, or
        clearing an assignment the old way would silently leave the others on.
    """
    if "assignee_emails" in data and data.get("assignee_emails") is not None:
        return list(data.get("assignee_emails") or [])
    if "assignee_email" in data and data.get("assignee_email") is not None:
        one = (data.get("assignee_email") or "").strip().lower()
        return [one] if one else []
    return None


def _get_task(db: Session, task_id: str) -> models.Task:
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    if not t:
        raise HTTPException(404, "Task not found")
    return t


def _wall_task(db: Session, user: dict, task_id: str) -> models.Task:
    """Fetch a task by id, enforce the company wall, and require that the caller
    can see the task - 404 (never 403) on either, so a task the caller has no
    business with is indistinguishable from one that is not there. Use in every
    per-task endpoint (sub-resources included).

    The visibility half (Sep 30 review, item 2) is the same rule the task lists
    apply: managers see everything inside their wall, everybody else only what
    task_is_visible admits. Without it a task hidden from somebody's lists still
    gave up its comments, attachments and activity to anyone who had its id. A
    subtask carries no project of its own, so it is also admitted through the
    project its top-level ancestor sits in.
    """
    t = _get_task(db, task_id)
    assert_task_wall(db, user, t)
    if not task_visible_to(db, user, t):   # one rule with require_task_role
        raise HTTPException(404, "Task not found")
    return t


def _trash_retention_days() -> int:
    """Single source of truth for the Trash's grace window - GET /tasks/deleted
    reads it to show a countdown, task_trash.py reads its own copy (same env
    var) to decide when to actually purge."""
    from task_trash import _retention_days
    return _retention_days()


def _iso_plus_days(iso: str, days: int) -> str:
    """`iso` (an ISO timestamp) + N days, for "this gets purged on ___" -
    best-effort: an unparsable timestamp just returns "" rather than 500ing a
    list of otherwise-fine trashed tasks over one bad row."""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (dt + timedelta(days=days)).isoformat()
    except (ValueError, AttributeError):
        return ""


# ── Field validation ─────────────────────────────────────────────────────────
# Everything below rejects input the API used to store verbatim. Found by a QA
# audit (Aug 2026); each case had a real downstream effect rather than being
# merely untidy - see the individual notes.
#
# Only fields PRESENT in the payload are checked, so a task already holding a
# bad value from before this existed can still be patched on other fields
# instead of becoming uneditable.
BUILTIN_STATUSES = {"not_started", "in_progress", "completed", "recurring"}
# A recurring occurrence the system closed because the next one came due before
# it was done (Oct 2). Only the scheduler sets it: it is NOT in BUILTIN_STATUSES,
# so _valid_statuses refuses it on create / update and nobody can pick it by
# hand; the frontend shows its chip but never offers it in a status picker.
MISSED = "missed"
PRIORITIES = {"urgent", "high", "medium", "low"}
# Deliberately permissive - the job is to catch "not-an-address-at-all", not to
# adjudicate RFC 5322.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_MAX_DEPENDENCY_WALK = 10_000   # cycle walks are bounded by `seen`; this is belt-and-braces


def _valid_statuses(db: Session) -> set:
    """Built-ins plus whatever custom statuses the workspace defines. Board and
    list views GROUP by status, so an unknown value silently creates a phantom
    column and misses every statusMeta lookup."""
    custom = {s.id for s in db.query(models.TaskCustomStatus).all()}
    return BUILTIN_STATUSES | custom


def _check_iso_date(value, field: str) -> None:
    """due_on/start_on are plain YYYY-MM-DD strings. A malformed one used to be
    stored happily, and the due-date reminder scan parses with
    date.fromisoformat inside a try/except that CONTINUES on failure - so a
    typo'd date silently disabled reminders for that task forever."""
    if value in ("", None):
        return
    try:
        date.fromisoformat(str(value)[:10])
    except ValueError:
        raise HTTPException(422, f"{field} must be a date in YYYY-MM-DD format (got {value!r}).")


def _walk_reaches(db: Session, start_ids: list, target_id: str, column) -> bool:
    """True if following `column` (a list-of-ids field) from any of start_ids
    reaches target_id. Used for both the parent chain and the dependency graph;
    `seen` makes it terminate even on data that is already cyclic."""
    seen, stack, steps = set(), [i for i in (start_ids or []) if i], 0
    while stack and steps < _MAX_DEPENDENCY_WALK:
        steps += 1
        cur = stack.pop()
        if cur == target_id:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        row = db.query(column).filter(models.Task.id == cur).first()
        nxt = row[0] if row else None
        if isinstance(nxt, list):
            stack.extend(i for i in nxt if i)
        elif nxt:
            stack.append(nxt)
    return False


def validate_task_payload(db: Session, data: dict, task_id: str = "") -> dict:
    """Validate + normalize a create/update/bulk payload in place. Returns the
    same dict so callers can use it directly."""
    if "title" in data and not str(data["title"] or "").strip():
        raise HTTPException(422, "Title is required.")

    if "status" in data and data["status"] is not None:
        allowed = _valid_statuses(db)
        if data["status"] not in allowed:
            raise HTTPException(422, f"Unknown status {data['status']!r}.")

    if "priority" in data and data["priority"] is not None and data["priority"] not in PRIORITIES:
        raise HTTPException(422, f"Unknown priority {data['priority']!r}. "
                                 f"Expected one of: {', '.join(sorted(PRIORITIES))}.")

    for field in ("due_on", "start_on"):
        if field in data:
            _check_iso_date(data[field], field)

    # Negative hours silently REDUCE a person's apparent load in the Workload
    # rollup, which sums estimate/actual per assignee.
    for field in ("estimate_hours", "actual_hours"):
        if field in data and data[field] is not None:
            try:
                if float(data[field]) < 0:
                    raise HTTPException(422, f"{field} cannot be negative.")
            except (TypeError, ValueError):
                raise HTTPException(422, f"{field} must be a number.")

    # Normalize rather than reject: blank/duplicate entries are a UI slip, not
    # something worth failing a save over. Blank tags rendered as empty pills and
    # duplicates appeared twice in the filter list; duplicate collaborators drew
    # the same avatar repeatedly.
    if "tags" in data and isinstance(data["tags"], list):
        seen, out = set(), []
        for tag in data["tags"]:
            v = str(tag or "").strip()
            if v and v.lower() not in seen:
                seen.add(v.lower())
                out.append(v)
        data["tags"] = out

    # assignee_emails rides the same normaliser as the collaborator lists: an
    # assignee is a person too, and a non-address there is worse than a bad
    # follower - it is work nobody can be notified about or find in My Tasks.
    for field in ("assignee_emails", "follower_emails", "liked_by_emails"):
        if field in data and isinstance(data[field], list):
            seen, out = set(), []
            for em in data[field]:
                v = str(em or "").strip().lower()
                if not v or v in seen:
                    continue
                # A collaborator is a person, and every downstream use assumes an
                # address: the notification fan-out mails it and the avatar
                # derives initials from it. A non-address just silently never
                # gets notified.
                if not _EMAIL_RE.match(v):
                    raise HTTPException(422, f"{v!r} is not a valid email address.")
                seen.add(v)
                out.append(v)
            data[field] = out

    # ── structural cycles ────────────────────────────────────────────────
    # A task that is its own parent disappears from the UI entirely: topLevel()
    # drops anything with a parentTaskId, and its "parent" is itself, so it
    # never nests under anything either.
    if task_id and data.get("parent_task_id"):
        parent = data["parent_task_id"]
        if parent == task_id:
            raise HTTPException(422, "A task cannot be its own parent.")
        if _walk_reaches(db, [parent], task_id, models.Task.parent_task_id):
            raise HTTPException(422, "That parent would create a circular subtask chain.")

    # A dependency cycle is worse than untidy: _check_dependency_gate refuses
    # completion while a blocker is open, so two tasks blocking each other can
    # NEVER be completed by anyone.
    if task_id and data.get("blocked_by_ids"):
        ids = [i for i in data["blocked_by_ids"] if i]
        if task_id in ids:
            raise HTTPException(422, "A task cannot block itself.")
        _require_tasks_exist(db, ids)
        if _walk_reaches(db, ids, task_id, models.Task.blocked_by_ids):
            raise HTTPException(422, "That dependency would create a circular chain, "
                                     "leaving both tasks permanently uncompletable.")

    if task_id and data.get("blocking_ids"):
        ids = [i for i in data["blocking_ids"] if i]
        if task_id in ids:
            raise HTTPException(422, "A task cannot block itself.")
        _require_tasks_exist(db, ids)
        if _walk_reaches(db, ids, task_id, models.Task.blocking_ids):
            raise HTTPException(422, "That dependency would create a circular chain.")

    return data


def _require_dependency_targets(db: Session, user: dict, t, data: dict, task_id: str = "") -> None:
    """The other end of every dependency edge this payload changes must be a
    task the caller can see AND edit (Oct 21 2026). Writing blocked_by_ids
    writes the other task's blocking_ids, and writing blocking_ids writes the
    other task's blocked_by_ids - the side the completion gate reads - so it
    could stall (or release) somebody else's work, or probe for tasks by id.

    blocked_by_ids: each ADDED blocker is checked. Removing one only ever
    un-gates your own task, and must stay possible even when the blocker has
    since moved out of your sight - otherwise a task could be left gated
    forever by something nobody on it can open.
    blocking_ids: added AND removed ids are checked - either way it changes
    the other task's own gate.

    require_task_role does the work: company wall (404), role (403), sight
    (404). `t` is None on create, where every id is new. The cycle guard in
    validate_task_payload is unchanged and runs first."""
    for field, check_removed in (("blocked_by_ids", False), ("blocking_ids", True)):
        if field not in data or data[field] is None:
            continue
        before = {i for i in ((getattr(t, field) or []) if t is not None else []) if i}
        after = {i for i in (data[field] or []) if i}
        changed = (after - before) | ((before - after) if check_removed else set())
        changed.discard(task_id or (t.id if t is not None else ""))
        if not changed:
            continue
        for other in db.query(models.Task).filter(models.Task.id.in_(changed)).all():
            require_task_role(db, user, other, "editor")


def _require_people(db: Session, t, emails, actor: str = "", user=None, emp_map: dict | None = None) -> None:
    """For an EDIT (PATCH, bulk): every NEWLY added assignee / collaborator
    must be in the Nexus directory and not offboarded - and, behind the
    company wall only, on the task's side of it (task_util.person_problem);
    422 naming them otherwise. People already on the task are never
    re-checked, so a task still holding somebody who has since left stays
    editable. The caller themselves is not checked - they are signed in, and
    following or taking a task you can already edit must keep working for an
    account the People list does not carry. Create paths drop instead of
    refusing (split_people)."""
    me = (actor or "").strip().lower()
    names = [w for w in (str(x or "").strip().lower() for x in (emails or [])) if w and w != me]
    if not names:
        return
    # No directory-wide map here: person_problem gets it once per request,
    # and only when the company wall applies (task_util.people_wall).
    for w in names:
        assert_person_assignable(db, t, w, user=user, emp_map=emp_map)


def _may_open_up(db: Session, user: dict, t) -> bool:
    """Who may widen a task from restricted to org-wide (Oct 21 2026): a
    manager, the task's owner or creator, or an editor-or-better of its
    project by the project's OWN roles. Not an assignee as such - an
    assignee is handed editor on their one task by require_task_role (being
    given the work is the grant), and that grant is for doing the work, not
    for publishing a restricted task to the whole organization. A task with
    no project has no project roles: owner, creator or manager only."""
    if is_manager(user):
        return True
    me = (user.get("email") or "").lower()
    if me and me in ((t.owner_email or "").lower(), (t.created_by or "").lower()):
        return True
    project = project_for_task(db, t)
    if project is None:
        return False
    return PROJECT_ROLE_RANK.get(project_role_for(db, me, project), 0) >= PROJECT_ROLE_RANK["editor"]


def _require_destination_projects(db: Session, user: dict, ids) -> None:
    """Moving or linking a task INTO a project takes editor on that project
    (Oct 21 2026), the bar for creating a task there - otherwise anyone who
    could edit a task could drop it into a restricted project they have no
    role on. The company wall comes first, managers included. An id that is
    no project is refused rather than stored as a dangling pointer."""
    for pid in dict.fromkeys(i for i in (ids or []) if i):
        project = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
        if project is None:
            raise HTTPException(404, "Project not found")
        require_project_access(db, user, project, "editor")


def _newly_missing_required(db: Session, t, project_before: str, values_before, project_after: str,
                            values_after) -> list:
    """The required custom fields an edit would leave empty (Oct 21 2026).

    Only what the EDIT causes: a value cleared that a required field held. A task
    that was already missing a required value (created before the field was
    required, or by an import) is not refused for an unrelated edit - that
    would make every older task uneditable until somebody filled it in.
    Top-level tasks only, like create_task: a subtask is part of its parent.
    A company's own field binds only that company's tasks."""
    if t.parent_task_id or not project_after:
        return []
    company = row_company(db, t)
    after = missing_required_fields(db, project_after, values_after, task_company=company)
    # Judged in the project the task ends up in: a field the task HAD a value
    # for and no longer does. Moving into a project where a required field is
    # empty is not refused - the drawer can only show that project's fields
    # once the task is in it, so refusing the move left no way to fill them.
    was = {f.id for f in missing_required_fields(db, project_after, values_before, task_company=company)}
    return [f for f in after if f.id not in was]


def _required_message(db: Session, missing: list, project_id: str) -> str:
    """create_task's wording for missing required fields."""
    project = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first() if project_id else None
    names = ", ".join(f.name for f in missing)
    where = f" in {project.name}" if project and project.name else " in this project"
    return f"{names} {'is' if len(missing) == 1 else 'are'} required for tasks{where}."


def _check_update_access(db: Session, user: dict, t, data: dict) -> None:
    """Everything a single PATCH must clear beyond editor on the task itself
    (Oct 21 2026), checked before anything is written: dependency targets,
    destination projects, widening restricted -> org, newly added people,
    and required custom fields the edit itself would leave empty."""
    _require_dependency_targets(db, user, t, data, t.id)
    current_extras = {p for p in (t.project_ids or []) if p}
    dest = []
    if "project_id" in data and (data["project_id"] or "") != (t.project_id or ""):
        dest.append(data["project_id"] or "")
    if data.get("project_ids") is not None:
        dest += [p for p in data["project_ids"] if p and p not in current_extras and p != (t.project_id or "")]
    _require_destination_projects(db, user, dest)
    if (data.get("access_level") == "org" and (t.access_level or "org") != "org"
            and not _may_open_up(db, user, t)):
        raise HTTPException(403, "Only the task's owner, its creator, a project editor or a manager can make "
                                 "this task visible to everyone.")
    prev = set(task_assignees(t))
    wanted = _assignees_from(data, list(prev))
    added = [w for w in (wanted or []) if (w or "").strip().lower() not in prev]
    if data.get("follower_emails") is not None:
        had = set(email_list(t.follower_emails))
        added += [f for f in data["follower_emails"] if (f or "").strip().lower() not in had]
    _require_people(db, t, added, actor=user.get("email") or "", user=user)
    if "custom_field_values" in data or "project_id" in data:
        project_after = (data["project_id"] if "project_id" in data else t.project_id) or ""
        values_after = data["custom_field_values"] if "custom_field_values" in data else (t.custom_field_values or {})
        missing = _newly_missing_required(db, t, t.project_id or "", t.custom_field_values or {},
                                          project_after, values_after)
        if missing:
            raise HTTPException(422, _required_message(db, missing, project_after))


def _require_tasks_exist(db: Session, ids: list) -> None:
    """A dependency on an id that doesn't resolve is invisible: the drawer's
    blockedBy lookup silently drops it and the completion gate ignores it, so
    the task LOOKS blocked in the payload while behaving as if it isn't."""
    found = {r[0] for r in db.query(models.Task.id).filter(models.Task.id.in_(ids)).all()}
    missing = [i for i in ids if i not in found]
    if missing:
        raise HTTPException(422, f"Unknown task id(s): {', '.join(missing[:5])}.")


def _sync_reciprocal_dependencies(db: Session, t: models.Task, data: dict) -> None:
    """Keep the other end of a dependency pointing back.

    blocked_by_ids and blocking_ids are two views of one edge, and only the
    first is authoritative - _check_dependency_gate reads blocked_by_ids, so
    that side alone decides whether a task may start or finish. blocking_ids is
    what the drawer's "Blocking" panel lists.

    The reciprocal used to be written by the browser, as a SECOND request right
    after this one (TaskDetailDrawer's addDep/removeDep). Any other route to the
    same edge - the bulk endpoint, a script, or simply that second call failing
    - left the graph one-sided and the panel under-reporting. Doing it here puts
    both ends in the same transaction, and the client's now-redundant second
    call is idempotent against it.

    Only edges this payload actually changed are touched, so a task that merely
    had its title edited never rewrites its neighbours."""
    for field, mirror in (("blocked_by_ids", "blocking_ids"),
                          ("blocking_ids", "blocked_by_ids")):
        if field not in data:
            continue
        now = {i for i in (getattr(t, field) or []) if i}
        # The pre-patch value is gone from `t` by the time this runs, so the
        # other end is the source of truth for what the edge used to be: every
        # task whose mirror list still names this one.
        was = {row.id for row in db.query(models.Task).all()
               if t.id in (getattr(row, mirror) or [])}
        for other in db.query(models.Task).filter(
                models.Task.id.in_((now | was) - {t.id})).all():
            cur = [i for i in (getattr(other, mirror) or []) if i]
            want = sorted(set(cur) | {t.id}) if other.id in now else [i for i in cur if i != t.id]
            if want != cur:
                setattr(other, mirror, want)
                other.modified_at = now_iso()


def _require_may_move(db: Session, user: dict, task_id: str) -> None:
    """The caller may put this task into (or take it out of) a parent/subtask
    link: same company wall and visibility as opening it (_wall_task - 404 if
    not), and editor on it (require_task_role - 403 if not). Without this a
    subtask_ids PATCH could pull anyone's task, or another company's, under a
    task of the caller's own."""
    other = _wall_task(db, user, task_id)
    require_task_role(db, user, other, "editor")


def _check_hierarchy_patch(db: Session, user: dict, t: models.Task, data: dict) -> None:
    """Refuse a PATCH that would break the subtask tree (Oct 21 2026). The
    parent half of the cycle guard is validate_task_payload's; this adds:
      * a new parent must be a live task - one that is not there leaves the
        task out of every list (a subtask is drawn under its parent only);
      * `subtask_ids` may name only live tasks, never the task itself or one
        of its own ancestors (that would make a loop);
      * the caller must be able to edit the new parent and every task newly
        listed as a subtask (_require_may_move)."""
    if data.get("parent_task_id") and (data["parent_task_id"] or "") != (t.parent_task_id or ""):
        if not db.query(models.Task.id).filter(models.Task.id == data["parent_task_id"]).first():
            raise HTTPException(422, "That parent task does not exist or is in the Recycle Bin.")
        _require_may_move(db, user, data["parent_task_id"])
    if "subtask_ids" in data and isinstance(data["subtask_ids"], list):
        ids = [i for i in data["subtask_ids"] if i]
        if t.id in ids:
            raise HTTPException(422, "A task cannot be its own subtask.")
        current = set(t.subtask_ids or [])
        added = [i for i in ids if i not in current]
        if added:
            _require_tasks_exist(db, added)
            parent = data["parent_task_id"] if "parent_task_id" in data else (t.parent_task_id or "")
            for child in added:
                if parent and _walk_reaches(db, [parent], child, models.Task.parent_task_id):
                    raise HTTPException(422, "That subtask would create a circular subtask chain.")
            for child in added:
                _require_may_move(db, user, child)
        # A task taken off the list is changed too (it becomes top-level).
        listed = set(ids)
        for child in [i for i in current if i and i not in listed]:
            row = db.query(models.Task).filter(models.Task.id == child).first()
            if row is not None and (row.parent_task_id or "") == t.id:
                _require_may_move(db, user, child)


def _sync_hierarchy(db: Session, t: models.Task, data: dict, prev_parent: str, prev_subtasks: list) -> None:
    """Keep both ends of a parent/subtask link in step after a PATCH (Oct 21
    2026). parent_task_id is the authoritative pointer (purge, trash, the
    project walk all read it); subtask_ids is the parent's ordered list.

      * parent_task_id changed: the task leaves its old parent's list and
        joins the end of its new parent's.
      * subtask_ids changed: every task newly listed moves under this one
        (leaving its old parent's list); every task taken off the list that
        still points here becomes a top-level task.
    Only the ends this PATCH moved are touched."""
    now = now_iso()
    if "parent_task_id" in data and (t.parent_task_id or "") != prev_parent:
        if prev_parent:
            old = db.query(models.Task).filter(models.Task.id == prev_parent).first()
            if old is not None and t.id in (old.subtask_ids or []):
                old.subtask_ids = [x for x in old.subtask_ids if x != t.id]
                old.modified_at = now
        if t.parent_task_id:
            new = db.query(models.Task).filter(models.Task.id == t.parent_task_id).first()
            if new is not None and t.id not in (new.subtask_ids or []):
                new.subtask_ids = list(new.subtask_ids or []) + [t.id]
                new.modified_at = now
    if "subtask_ids" in data and isinstance(data["subtask_ids"], list):
        wanted = [i for i in (t.subtask_ids or []) if i]
        before, after = set(prev_subtasks), set(wanted)
        added = [i for i in wanted if i not in before]
        removed = [i for i in prev_subtasks if i not in after]
        for child in (db.query(models.Task).filter(models.Task.id.in_(added)).all() if added else []):
            if (child.parent_task_id or "") == t.id:
                continue
            if child.parent_task_id:
                old = db.query(models.Task).filter(models.Task.id == child.parent_task_id).first()
                if old is not None and child.id in (old.subtask_ids or []):
                    old.subtask_ids = [x for x in old.subtask_ids if x != child.id]
                    old.modified_at = now
            child.parent_task_id, child.modified_at = t.id, now
        for child in (db.query(models.Task).filter(models.Task.id.in_(removed)).all() if removed else []):
            if (child.parent_task_id or "") == t.id:
                child.parent_task_id, child.modified_at = "", now


def _is_starting(prev_status: str, new_status: str) -> bool:
    """Has the task just LEFT Not Started - i.e. did work begin on it?

    One definition, shared by the dependency gate below (FS/SS block a task from
    starting) and the automatic start date in _autostamp_start. They were about
    to be two copies of the same comparison, and a module where "started" means
    one thing to dependencies and another to the timeline is a module where the
    Gantt and the blockers disagree about the same task."""
    return prev_status == "not_started" and new_status != "not_started"


def _autostamp_start(t: models.Task, prev_status: str, new_status: str) -> bool:
    """Stamp today as the start date the first time a task leaves Not Started.

    The Timeline column is a start->due range, but until now the ONLY way to get
    a start date was to open that cell and type one, so in practice nothing had
    one and every Gantt bar was a one-day stub (Sagar, Sept 7). Moving a task off
    Not Started is the moment work began, so that is when the date is recorded.

    Never overwrites: a date somebody set by hand - or one that came in from
    Asana, or one this function stamped on an earlier trip through Not Started -
    is the truth about when the work started, and a re-open must not rewrite it.

    Deliberately NOT clamped to the due date. A task started after it was due
    gets a range that reads backwards, and that is exactly what happened; hiding
    it behind a "sensible" date would be inventing history.

    Runs on every path that writes a status - single PATCH and bulk - because a
    board drag and a checkbox are the same event to the person doing it."""
    if t.start_on or not _is_starting(prev_status, new_status):
        return False
    # UTC, from the same clock as created_at/modified_at and every other stored
    # timestamp - NOT date.today(), which is server-LOCAL. On Azure the two are
    # the same and the choice looks academic; on a laptop east of UTC they are
    # different days for hours at a time, and this stamp has to agree with the
    # one create_task writes (which derives from now_iso()) or a task created
    # In Progress and a task moved to In Progress a second apart get different
    # start dates. Caught exactly that way, at 02:52 IST on 2026-09-08.
    t.start_on = now_iso()[:10]
    return True


def _check_dependency_gate(db: Session, t: models.Task, prev_status: str, prev_completed: bool,
                            new_status: str, new_completed: bool,
                            assume_done: frozenset = frozenset()) -> None:
    """Enforce blockedBy relationship types before a status/completion change lands.
    FS/SS gate the task *starting* (leaving not_started); FF/SF gate it *finishing*
    (completed). 'Started' on the blocker means it has left not_started OR is
    completed. Raises 400 with a message naming the still-blocking task.
    `assume_done`: blockers being completed in the same bulk call that have
    passed their own gate - they count as completed (bulk_update only)."""
    if not t.blocked_by_ids:
        return
    starting_now = _is_starting(prev_status, new_status)
    completing_now = (not prev_completed) and new_completed
    if not (starting_now or completing_now):
        return
    dep_types = t.dependency_types or {}
    blockers = {b.id: b for b in db.query(models.Task).filter(models.Task.id.in_(t.blocked_by_ids)).all()}
    for blocker_id in t.blocked_by_ids:
        blocker = blockers.get(blocker_id)
        if not blocker:
            continue
        dep_type = dep_types.get(blocker_id, "FS")
        blocker_started = blocker.status != "not_started" or blocker.completed or blocker_id in assume_done
        blocker_completed = bool(blocker.completed) or blocker_id in assume_done
        # Title, never the code: task numbers are not shown anywhere in the
        # module, so "Blocked by TASK-1983" would name something the reader
        # has no way to find.
        name = blocker.title or "another task"
        if dep_type == "FS" and (starting_now or completing_now) and not blocker_completed:
            raise HTTPException(400, f"Blocked by {name}: finish it before starting or completing this task (Finish → Start).")
        if dep_type == "SS" and starting_now and not blocker_started:
            raise HTTPException(400, f"Blocked by {name}: start it before starting this task (Start → Start).")
        if dep_type == "FF" and completing_now and not blocker_completed:
            raise HTTPException(400, f"Blocked by {name}: finish it before completing this task (Finish → Finish).")
        if dep_type == "SF" and completing_now and not blocker_started:
            raise HTTPException(400, f"Blocked by {name}: start it before completing this task (Start → Finish).")


# ── Completion: `status` and `completed` are one fact in two columns ─────────
# They must never disagree. A task whose status is "completed" while its
# `completed` flag is False renders with an empty circle and no strikethrough
# while sitting in the Completed group - and, worse, task_notify's due scan
# filters on `completed`, so it keeps sending "this task is overdue" about work
# that is finished.
#
# update_task got this right and was the only one that did. create_task hardcoded
# completed=False next to whatever status it was handed, and bulk_update wrote
# `status` through a plain setattr. Both were reachable from the UI: the
# "+ Add task…" row inside a group inherits that group's status, so adding a task
# under the Completed heading created exactly this state, as did the multi-select
# Status dropdown. One rule, three callers, no room to drift.

def _resolve_completed(data: dict, prev_completed: bool) -> bool:
    """What `completed` should become, given a payload and the current value.

    A status set to anything OTHER than completed, with no explicit `completed`
    in the same payload, means the task is being reopened - otherwise the flag
    stuck True and list/board views kept the task parked in Completed."""
    if "status" in data and data["status"] != "completed" and "completed" not in data:
        return False
    return bool(data.get("completed", prev_completed)) or (data.get("status") == "completed")


def _apply_completion(t: models.Task, new_completed: bool, prev_completed: bool) -> None:
    """Land `completed` on the task and drag `status` and `completed_at` with it."""
    if new_completed == prev_completed:
        return
    t.completed = new_completed
    if new_completed:
        t.completed_at = now_iso()
        if t.status != "completed":
            t.status = "completed"
    else:
        t.completed_at = ""
        if t.status in ("completed", MISSED):
            t.status = "not_started"


# ── The completion path, shared ──────────────────────────────────────────────
# A person ticking a task done (update_task) and an automation rule closing it
# on its due date (task_automation.run_scheduled) are the same event, so they
# run the same three steps: land the flag (+ the HR checklist), log it, then
# roll the series forward and tell the ticket. None of them fires automation
# rules - the engine never chains (task_automation.py).

def _land_completion(db: Session, t: models.Task, new_completed: bool, prev_completed: bool,
                     actor_email: str) -> None:
    """_apply_completion, plus the HR checklist steps that follow the task:
    an HR checklist task closes (or reopens) its checklist steps (Oct 20)."""
    _apply_completion(t, new_completed, prev_completed)
    if bool(new_completed) != bool(prev_completed):
        import hr_checklists
        hr_checklists.task_completed(db, t, bool(new_completed), actor_email)


def _log_completed(db: Session, t: models.Task, actor_email: str) -> str:
    """The "completed this task" activity row. Returns its id for the caller
    to put on t.activity_ids (update_task rebuilds that list itself)."""
    return log_activity(db, type="completed", actor_email=actor_email,
                        entity_id=t.id, entity_code=t.code, entity_title=t.title,
                        detail="completed this task")


def _after_completed(db: Session, t: models.Task, user: dict, prev_completed: bool,
                     spawn_as: Optional[dict] = None, notify: bool = True,
                     carry_open=frozenset(), pending: Optional[dict] = None) -> Optional[models.Task]:
    """What a completion sets off once it has landed: a recurring task rolls
    forward to its next occurrence, and a ticket's task tells its ticket.
    `spawn_as` is who the next occurrence is created by when that is not the
    person who completed it (an automation rule has no person). `notify`
    False leaves the bells to the caller - bulk_update sends the "Recurring
    Task Due" bell once per person and the ticket's "All Tasks ... Done" once
    per ticket for the whole batch. `carry_open`: see _carry_subtasks;
    `pending`: see _task_by_id.
    Returns the new occurrence, if any. Does not commit."""
    if not (t.completed and not prev_completed):
        return None
    spawned = _spawn_next_occurrence(db, t, spawn_as or user, notify=notify, carry_open=carry_open,
                                     pending=pending)
    if t.source_ticket_id:
        _tell_ticket_task_done(db, t, user, notify=notify)
    return spawned


# ── Recurrence: occurrence generation ────────────────────────────────────────
# recurrence = {freq, interval, daysOfWeek?, dayOfMonth?, weekOfMonth?, weekday?,
#               monthOfYear?, unit?, daysAfterCompletion?, until?, count?}
#   freq: daily | weekly | monthly | yearly | periodic | custom
#   daysOfWeek: frontend-index list (0=Sunday..6=Saturday) - weekly, and custom
#               with unit='week'. `dayOfWeek` (singular) is read as a one-item
#               fallback for series created before multi-day weekly existed.
#   unit: day|week|month|year - custom only, borrows the matching freq's cadence.
#   dayOfMonth: 1-31, or -1 for the last day of the month (monthly / custom
#               month). A day past the month's end lands on its last day.
#   weekOfMonth + weekday: "the 4th Friday", "the last Wednesday" (Oct 13 2026,
#               Asana parity) - weekOfMonth 1-5 or -1 for the last one, weekday
#               0=Sunday..6=Saturday. Wins over dayOfMonth when both are set.
#               Monthly / custom month, and yearly / custom year, where
#               monthOfYear (1-12, else the due date's month) says which month:
#               "the 4th Thursday of November".
#   periodic ignores everything above except daysAfterCompletion: the next due
#   date is N days after THIS occurrence's completed_at, not a calendar date -
#   see the base_iso branch in _spawn_next_occurrence below.
# until/count are the end condition. `count` on an instance means "occurrences
# remaining, this one inclusive" - decremented each time the next occurrence is
# spawned, so a series with count=N produces exactly N tasks.
def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _nth_weekday(year: int, month: int, week: int, weekday: int) -> date:
    """The `week`-th `weekday` of a month: week 1-5, or -1 for the last one;
    weekday 0=Sunday..6=Saturday (the frontend's numbering). A 5th that the
    month does not have falls back to its last one, the way Asana does."""
    target = (int(weekday) - 1) % 7                 # Sun=0 -> Python Mon=0
    last = calendar.monthrange(year, month)[1]
    if int(week) < 0:
        d = date(year, month, last)
        return d - timedelta(days=(d.weekday() - target) % 7)
    d = date(year, month, 1)
    d += timedelta(days=(target - d.weekday()) % 7)
    d += timedelta(weeks=max(1, int(week)) - 1)
    return d if d.month == month else d - timedelta(weeks=1)


def _weekday_rule(rec: dict):
    """(weekOfMonth, weekday) when the rule is an nth-weekday one, else None."""
    wk, wd = rec.get("weekOfMonth"), rec.get("weekday")
    if wk in (None, "") or wd in (None, ""):
        return None
    try:
        return int(wk), int(wd)
    except (TypeError, ValueError):
        return None


def _next_monthly_due(base: date, rec: dict, interval: int) -> date:
    rule = _weekday_rule(rec)
    if rule:
        # This month's date first, when it is still ahead: a task due 10/01
        # set to "the 4th Friday" next falls on 10/23, not in November. Then
        # `interval` months on. Always after `base`, so the daily roll-forward
        # (which steps this until it passes today) always moves.
        here = _nth_weekday(base.year, base.month, *rule)
        if here > base:
            return here
        m = _add_months(base.replace(day=1), interval)
        return _nth_weekday(m.year, m.month, *rule)
    nxt = _add_months(base, interval)
    dom = rec.get("dayOfMonth")
    if dom:
        last = calendar.monthrange(nxt.year, nxt.month)[1]
        day = last if int(dom) < 0 else min(int(dom), last)
        nxt = date(nxt.year, nxt.month, day)
    return nxt


def _next_yearly_due(base: date, rec: dict, interval: int) -> date:
    rule = _weekday_rule(rec)
    if rule:
        month = int(rec.get("monthOfYear") or base.month)
        here = _nth_weekday(base.year, month, *rule)
        if here > base:
            return here
        return _nth_weekday(base.year + interval, month, *rule)
    return _add_months(base, 12 * interval)


def _next_weekly_due(base: date, rec: dict, interval: int) -> date:
    """The next selected weekday after `base` for an "every N weeks on these
    days" rule. The rest of `base`'s own week comes first; once its days are
    used up the rule jumps `interval` weeks to the first selected day of that
    week. Weeks run Sunday-Saturday, the order of the S M T W T F S picker.

    It used to take the nearest selected day and THEN add (interval - 1)
    weeks, which is right for one day but drifts with several: "every 2 weeks
    on Mon and Thu" went Mon 10/19 -> Thu 10/29 -> Mon 11/09 instead of
    Mon 10/19 -> Thu 10/22 -> Mon 11/02 (Oct 13 2026)."""
    days = rec.get("daysOfWeek")
    if not days and rec.get("dayOfWeek") is not None:
        days = [rec.get("dayOfWeek")]           # legacy single-day series
    if not days:
        return base + timedelta(weeks=interval)
    picked = sorted({int(d) % 7 for d in days})   # frontend Sun=0..Sat=6
    sun_index = (base.weekday() + 1) % 7          # Python Mon=0 -> Sun=0
    week_start = base - timedelta(days=sun_index)
    later = [d for d in picked if d > sun_index]
    if later:
        return week_start + timedelta(days=later[0])
    return week_start + timedelta(weeks=interval, days=picked[0])


def _next_due(base_iso: str, rec: dict) -> str:
    """Next due date (YYYY-MM-DD) after `base_iso`, per the recurrence rule.
    Never called for freq='periodic' - that one has no calendar cadence to
    compute here (see _spawn_next_occurrence)."""
    try:
        base = datetime.strptime((base_iso or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        base = date.today()
    freq = rec.get("freq")
    interval = max(1, int(rec.get("interval") or 1))
    # Custom borrows day/week/month/year cadence from `unit` instead of `freq`.
    cadence = rec.get("unit") or "day" if freq == "custom" else freq
    if cadence in ("weekly", "week"):
        return _next_weekly_due(base, rec, interval).isoformat()
    if cadence in ("monthly", "month"):
        return _next_monthly_due(base, rec, interval).isoformat()
    if cadence in ("yearly", "year"):
        return _next_yearly_due(base, rec, interval).isoformat()
    # daily/day (and any unknown cadence) → advance whole days
    return (base + timedelta(days=interval)).isoformat()


def _spawn_next_occurrence(db: Session, t: models.Task, user: dict,
                           next_due_override: str = "", skip_locked: bool = False,
                           notify: bool = True, carry_open=frozenset(),
                           pending: Optional[dict] = None) -> Optional[models.Task]:
    """Create the occurrence after `t` (unless the end condition - `until` date
    or `count` - is reached). Returns the new task, or None if the series has
    ended or `t` already rolled forward.

    A subtask recurs only on a schedule of its OWN (`freq` on its rule, Oct 14
    2026); one that simply repeats with its main task is copied by
    _carry_subtasks instead. Its next copy goes under the main task's CURRENT
    occurrence (_current_occurrence), so it is always found with the live one.

    Two callers, one roll-forward each (Sept 2026): completing an occurrence
    (update_task), and the daily schedule (spawn_scheduled_occurrences) - a
    calendar series now produces its next occurrence ON its date even if this
    one is still open. Whichever gets there first stamps `nextOccurrenceId` on
    `t`, and the other then does nothing - so completing Monday's task after
    Tuesday's already appeared cannot create a second Tuesday."""
    rec = t.recurrence
    if not isinstance(rec, dict) or not rec.get("freq"):
        return None
    if rec.get("nextOccurrenceId"):
        return None  # already rolled forward (by the schedule or a completion)

    count = rec.get("count")
    if count is not None and int(count) <= 1:
        return None  # this was the final occurrence

    if rec.get("freq") == "periodic":
        # Completion-relative by definition: the next occurrence is N days
        # after THIS one was finished, not N days after its (possibly much
        # earlier) due date - due_on would defeat the whole point of
        # "Periodically" existing as separate from a calendar-based freq.
        # Any whole number of days (presets to 240 plus "Other" in the UI);
        # capped at ten years so a typo cannot push a date out of range.
        days = min(3650, max(1, int(rec.get("daysAfterCompletion") or 1)))
        base = datetime.strptime((t.completed_at or now_iso())[:10], "%Y-%m-%d").date()
        next_due = (base + timedelta(days=days)).isoformat()
    elif next_due_override:
        next_due = next_due_override
    else:
        base_iso = t.due_on or (t.completed_at or now_iso())[:10]
        next_due = _next_due(base_iso, rec)
    until = rec.get("until")
    if until and next_due > until:
        return None  # past the series end date

    # Two people completing the same occurrence at once (or a completion
    # racing the daily schedule) both get here with a rule that has no
    # marker yet. Re-read the stored rule under a row lock: the second one
    # waits for the first to commit and then sees its `nextOccurrenceId`.
    # A column read, not the entity, so the caller's unflushed edits on `t`
    # are left alone (autoflush is off). Taken only once a copy is really
    # about to be made, so every caller that gets here commits soon after.
    # Every other existing row this roll-forward writes is locked with it, in
    # id order, BEFORE _next_code takes the counter (_lock_task_rows).
    # `skip_locked` is the daily schedule's (spawn_scheduled_occurrences): it
    # never WAITS for a row somebody holds, it leaves the task for the next
    # tick instead. FOR UPDATE (and SKIP LOCKED) is a no-op on SQLite.
    want = [t.id] + _spawn_write_ids(db, t, pending)
    got = _lock_task_rows(db, want, skip_locked=skip_locked)
    if skip_locked and db.bind.dialect.name == "postgresql" and len(got) < len(set(want)):
        return None   # somebody holds one of them right now - next tick
    stored_rec = got.get(t.id)
    if isinstance(stored_rec, dict) and stored_rec.get("nextOccurrenceId"):
        t.recurrence = {**rec, "nextOccurrenceId": stored_rec["nextOccurrenceId"]}
        return None

    new_rec = {k: v for k, v in rec.items() if k not in ("nextOccurrenceId", "closedAsMissed")}
    if count is not None:
        new_rec["count"] = int(count) - 1
    # The series travels with every copy (see _series_key). A series that
    # began before series ids existed is named after the occurrence it rolls
    # forward from; that row itself is left as it was (_series_groups links
    # it to the new copy through nextOccurrenceId).
    new_rec["seriesId"] = rec.get("seriesId") or t.id

    parent = _current_occurrence(db, t.parent_task_id, pending) if t.parent_task_id else None
    now = now_iso()
    nid = gen_id()
    nxt = models.Task(
        id=nid,
        company_id=getattr(t, "company_id", "") or "",   # inherit the parent's company
        code=_next_code(db),
        title=t.title,
        description=t.description or "",
        type=t.type or "task",
        status="recurring",
        priority=t.priority or "medium",
        assignee_email=t.assignee_email or "",
        assignee_emails=list(task_assignees(t)),
        owner_email=t.owner_email or "",
        follower_emails=list(t.follower_emails or []),
        liked_by_emails=[],
        access_level=t.access_level or "org",
        project_id=t.project_id or "",
        # The "also in" projects too - without them the next occurrence
        # silently dropped out of every project but the primary one.
        project_ids=list(t.project_ids or []),
        section_id=t.section_id or "",
        team_id=t.team_id or "",
        parent_task_id=parent.id if parent is not None else "",
        position=(t.position or 0.0) if parent is not None else 0.0,
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
    # The checklist travels with the series, every line unticked: a recurring
    # "monthly close" is the same steps each month.
    _copy_checklist(db, t.id, nxt, user, now)
    nxt.subtask_ids = _carry_subtasks(db, t, nxt, user, carry_open)
    nxt.subtask_order = t.subtask_order or ""
    if parent is not None:
        parent.subtask_ids = list(parent.subtask_ids or []) + [nid]
    # Reassigned (not mutated in place) so SQLAlchemy sees the JSON change.
    t.recurrence = {**rec, "nextOccurrenceId": nid}
    aid = log_activity(db, type="created", actor_email=user["email"], entity_id=nid,
                       entity_code=nxt.code, entity_title=nxt.title,
                       detail=f"recurring occurrence generated from {t.title}")
    nxt.activity_ids = [aid]
    if notify:
        for _who in task_assignees(nxt):
            if _who == user["email"].lower():
                continue
            _recurring_due_bell(db, _who, [nxt])
    return nxt


def _recurring_due_bell(db: Session, who: str, occurrences: list) -> None:
    """The bell that tells an assignee their next occurrence is out: one
    task reads exactly as it always has, several (a bulk completion) are ONE
    bell - one notification per action, never one per task."""
    if len(occurrences) == 1:
        nxt = occurrences[0]
        task_notify(db, kind="task_assigned", for_email=who,
                    title="Recurring Task Due",
                    body=f"{nxt.title} (due {_us(nxt.due_on)})", task_id=nxt.id,
                    nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
        return
    task_notify(db, kind="task_assigned", for_email=who,
                title=f"{len(occurrences)} Recurring Tasks Due",
                body=", ".join(f"{o.title or 'Untitled task'} (due {_us(o.due_on)})" for o in occurrences[:5])
                     + (f" and {len(occurrences) - 5} more" if len(occurrences) > 5 else ""),
                nexus_action={"view": "tasks", "sub": "mine", "label": "View tasks"})


def _tell_ticket_task_done(db: Session, t: models.Task, user: dict, notify: bool = True):
    """A task from a ticket was completed (Oct 14 2026): the ticket's history
    says so, and once the LAST of its open tasks is done, whoever works the
    ticket is told it may be ready to resolve. Told, never resolved for them -
    the task being done is not the same as the requester's problem being
    fixed. `notify` False writes only the history line and returns the
    ticket, for the caller to tell once (_tell_ticket_all_done)."""
    tk = db.query(models.TaskTicket).filter(models.TaskTicket.id == t.source_ticket_id).first()
    # The task a ticket was CONVERTED from is closed because its work moved
    # onto the ticket - that is not work done for it.
    if tk is None or tk.linked_task_id == t.id:
        return None
    actor = user["email"].lower()
    log_activity(db, type="task_completed", actor_email=actor, entity_kind="ticket", entity_id=tk.id,
                 entity_code=tk.code, entity_title=tk.subject, detail=f"completed task {t.code} · {t.title}")
    if notify:
        _tell_ticket_all_done(db, tk, actor, {t.id})
    return tk


def _tell_ticket_all_done(db: Session, tk, actor: str, done_ids: set) -> None:
    """Once every task of `tk` is done (`done_ids` are the ones just
    completed), tell whoever works the ticket it may be ready to resolve -
    one bell per ticket however many of its tasks were completed together."""
    from ticket_code import ticket_no
    if tk.status in ("resolved", "closed"):
        return
    ids = [i for i in (tk.task_ids or []) if i]
    others = (db.query(models.Task).filter(models.Task.id.in_(ids), models.Task.id.notin_(list(done_ids))).all()
              if ids else [])
    if any(not o.completed for o in others):
        return
    who = (tk.assignee_email or "").lower()
    if who and who != actor:
        task_notify(db, kind="ticket_tasks_done", for_email=who,
                    title="All Tasks for a Ticket Are Done",
                    body=f"{ticket_no(tk.code)} · {tk.subject} - it may be ready to resolve", ticket_id=tk.id,
                    nexus_action={"view": "tickets", "label": "View ticket"})


def _copy_checklist(db: Session, src_id: str, dst: models.Task, user: dict, now: str) -> None:
    items = (db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == src_id)
             .order_by(models.TaskChecklistItem.position).all())
    for i, item in enumerate(items):
        db.add(models.TaskChecklistItem(id=gen_id(), task_id=dst.id, title=item.title, done=False,
                                        assignee_email=item.assignee_email or "", position=float(i),
                                        created_at=now, created_by=user["email"]))
    dst.checklist_total, dst.checklist_done = len(items), 0


def _task_by_id(db: Session, task_id: str, pending: Optional[dict] = None) -> Optional[models.Task]:
    """A live task by id. `pending` ({id: task}) holds occurrences made
    earlier in the SAME request and not yet written (autoflush is off, so a
    query cannot see them): a bulk completion rolls a main task forward and
    then its subtask, whose next copy belongs under the main task's brand-new
    occurrence. bulk_update keeps that index as it goes."""
    if pending and task_id in pending:
        return pending[task_id]
    return db.query(models.Task).filter(models.Task.id == task_id).first()


def _lock_task_rows(db: Session, ids, skip_locked: bool = False) -> dict:
    """Row-lock these tasks (FOR UPDATE, in id order) and return {id:
    stored recurrence} for the rows locked. The lock order for task writes
    that also take the task-code counter (Oct 21 2026): the existing task rows
    are locked FIRST, in id order, and the counter (code_sequence) after.
    Creating a subtask (its parent), rolling a series forward (the task, its
    parent occurrence, its subtasks), a bulk completion (those, for every row
    that will roll - none otherwise) and the daily schedule follow it.
    Not covered: an HR
    checklist sync that creates a new task while a completion lands takes the
    counter before the roll-forward's locks. A column read, so unflushed
    edits on the rows in hand are left alone. `skip_locked` returns without
    the rows somebody else holds instead of waiting. A no-op lock on SQLite."""
    ids = sorted({i for i in (ids or []) if i})
    if not ids:
        return {}
    rows = (db.query(models.Task.id, models.Task.recurrence).filter(models.Task.id.in_(ids))
            .order_by(models.Task.id).with_for_update(skip_locked=skip_locked).all())
    return {r[0]: r[1] for r in rows}


def _spawn_write_ids(db: Session, t: models.Task, pending: Optional[dict] = None) -> list:
    """The existing task rows rolling `t` forward writes besides `t`: the
    parent occurrence a subtask's copy is listed under, and `t`'s own live
    subtasks (moved to the new occurrence, or closed with a Missed one).
    Rows only added in this request are not in the database to lock."""
    from sqlalchemy import inspect as sa_inspect
    ids = []
    if t.parent_task_id:
        parent = _current_occurrence(db, t.parent_task_id, pending)
        if parent is not None and sa_inspect(parent).persistent:
            ids.append(parent.id)
    ids += [r[0] for r in db.query(models.Task.id).filter(models.Task.parent_task_id == t.id).all()]
    return ids


def _current_occurrence(db: Session, task_id: str, pending: Optional[dict] = None) -> Optional[models.Task]:
    """The live occurrence of the series `task_id` belongs to: follow the
    nextOccurrenceId links forward (skipping the Recycle Bin). A task that does
    not repeat is its own current occurrence. `pending`: see _task_by_id."""
    cur = _task_by_id(db, task_id, pending)
    seen = set()
    while cur is not None and cur.id not in seen:
        seen.add(cur.id)
        nid = (cur.recurrence or {}).get("nextOccurrenceId") if isinstance(cur.recurrence, dict) else None
        nxt = _task_by_id(db, nid, pending) if nid else None
        if nxt is None or nxt.deleted_at:
            break
        cur = nxt
    return cur


def _carry_subtasks(db: Session, t: models.Task, nxt: models.Task, user: dict, carry_open=frozenset()) -> list:
    """The subtasks of a recurring task come along to its next occurrence
    (Neil, Oct 14 2026: a yearly tax return is the same eleven steps every
    year - they had to be typed in again each time). Each one starts open
    again, keeps its place, people, priority and fields, and its due date
    moves by as much as the main task's did. A subtask switched off on its
    own Recurrence row ({"skip": true}) stays behind. One on a schedule of its
    own (`freq`) is not copied: while open it MOVES to the new occurrence, and
    it makes its own next copies (_spawn_next_occurrence). `carry_open` are
    subtasks completed in the SAME bulk call as the main task: they count as
    open, as they were when it rolled - the result matches completing the
    main task first and the subtask after. Returns the ids now under `nxt`."""
    subs = (db.query(models.Task)
            .filter(models.Task.parent_task_id == t.id,
                    (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)))
            .order_by(models.Task.position).all())
    shift = None
    if t.due_on and nxt.due_on:
        try:
            shift = (datetime.strptime(nxt.due_on[:10], "%Y-%m-%d")
                     - datetime.strptime(t.due_on[:10], "%Y-%m-%d")).days
        except ValueError:
            shift = None
    now = nxt.created_at or now_iso()
    ids = []
    moved = []
    for s in subs:
        if isinstance(s.recurrence, dict) and s.recurrence.get("skip"):
            continue
        if isinstance(s.recurrence, dict) and s.recurrence.get("freq"):
            if not s.completed or s.id in carry_open:
                s.parent_task_id, s.modified_at = nxt.id, now
                moved.append(s.id)
                ids.append(s.id)
            continue
        due = ""
        if s.due_on and shift is not None:
            try:
                due = (datetime.strptime(s.due_on[:10], "%Y-%m-%d") + timedelta(days=shift)).date().isoformat()
            except ValueError:
                due = ""
        sid = gen_id()
        sub = models.Task(
            id=sid, company_id=getattr(nxt, "company_id", "") or "", code=_next_code(db),
            title=s.title, description=s.description or "", type=s.type or "task",
            status="not_started", priority=s.priority or "medium",
            assignee_email=s.assignee_email or "", assignee_emails=list(task_assignees(s)),
            owner_email=s.owner_email or "", follower_emails=list(s.follower_emails or []),
            liked_by_emails=[], access_level=s.access_level or "org",
            project_id=s.project_id or "", project_ids=list(s.project_ids or []),
            section_id=s.section_id or "", team_id=s.team_id or "",
            parent_task_id=nxt.id, position=s.position or 0.0,
            subtask_ids=[], blocked_by_ids=[], blocking_ids=[], dependency_types={},
            tags=list(s.tags or []), custom_field_values=dict(s.custom_field_values or {}),
            start_on="", due_on=due, estimate_hours=s.estimate_hours, actual_hours=None,
            recurrence=dict(s.recurrence) if isinstance(s.recurrence, dict) else None,
            is_milestone=bool(s.is_milestone), approval_status="none",
            completed=False, completed_at="",
            comment_ids=[], attachment_ids=[], activity_ids=[],
            created_at=now, modified_at=now, created_by=user["email"],
        )
        db.add(sub)
        _copy_checklist(db, s.id, sub, user, now)
        ids.append(sid)
    if moved:
        t.subtask_ids = [x for x in (t.subtask_ids or []) if x not in moved]
    return ids


def _close_as_missed(db: Session, t: models.Task, why: str) -> None:
    """Close an occurrence nobody finished: Missed, not Completed. completed is
    set so it leaves every open list and stops the overdue emails; completed_at
    stays EMPTY, so no "completed since ..." count, briefing or dashboard ever
    reports it as done work. Stamped on the rule (closedAsMissed) so a person
    who reopens it to finish it late is not closed again by the next scan."""
    t.completed, t.completed_at, t.status = True, "", MISSED
    t.recurrence = {**(t.recurrence or {}), "closedAsMissed": now_iso()}
    t.modified_at = now_iso()
    log_activity(db, type="closed_missed", actor_email="system", entity_id=t.id, entity_code=t.code,
                 entity_title=t.title, detail=f"Closed as Missed - {why}")
    # Its open subtasks go with it - the next occurrence brought fresh copies
    # (_carry_subtasks), and the old ones would otherwise sit open beside them.
    for s in (db.query(models.Task)
              .filter(models.Task.parent_task_id == t.id, models.Task.completed == False,  # noqa: E712
                      (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None))).all()):
        if isinstance(s.recurrence, dict) and s.recurrence.get("freq"):
            continue  # on a schedule of its own - it closes by its own dates
        s.completed, s.completed_at, s.status, s.modified_at = True, "", MISSED, now_iso()


def _us(iso: str) -> str:
    try:
        return datetime.strptime((iso or "")[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
    except ValueError:
        return iso or ""


# Series whose next date comes from the calendar. `periodic` is excluded on
# purpose: its next date is N days after THIS one is completed, so it cannot
# be scheduled ahead - it keeps rolling forward on completion only.
_SCHEDULED_FREQS = {"daily", "weekly", "monthly", "yearly", "custom"}


def spawn_scheduled_occurrences(db: Session, today_iso: str) -> list[models.Task]:
    """Daily roll-forward for calendar recurrences: every series whose next
    date has arrived gets that occurrence now, whether or not the current one
    was completed. Called from task_notify's hourly scan; idempotent through
    `nextOccurrenceId` (see _spawn_next_occurrence), so re-running the same day
    creates nothing.

    A series that fell behind (the scan was down, or nobody touched it for
    weeks) jumps to its most recent date on or before today rather than
    back-filling one stale task per missed day - the missed dates are not work
    anyone can still do on time.

    ONE occurrence per series per date (Sep 28 fix). `nextOccurrenceId` only
    guards a single row, and a series can hold several unmarked rows: every
    occurrence completed before Sep 18 kept its rule with no marker (the
    marker did not exist yet), so the first scheduled scan spawned a copy from
    EACH of them - all on the same latest date - and every copy then carried
    the series on as a chain of its own ("Take out all Trash" x13 on 09/28).
    So rows are grouped by series (_series_groups), only the series' newest
    occurrence may roll forward, a date the series already has is never
    created again, and every other unmarked row is stamped as rolled forward
    so it can never start a chain. Tasks in the Recycle Bin never spawn."""
    spawned: list[models.Task] = []
    rows = (db.query(models.Task)
            .filter(models.Task.recurrence.isnot(None),
                    (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)))
            .all())
    # Subtasks on a schedule of their own roll forward here too (Oct 14 2026).
    by_id = {t.id: t for t in rows}
    scheduled = [t for t in rows
                 if isinstance(t.recurrence, dict) and t.recurrence.get("freq") in _SCHEDULED_FREQS and t.due_on]
    touched = False
    closed: list[str] = []
    for members in _series_groups(scheduled, by_id):
        dates = {(m.due_on or "")[:10]: m for m in members}
        # The series' newest occurrence carries it forward; among several on
        # that date, an open one first, then the oldest-created (stable).
        latest_due = max((m.due_on or "")[:10] for m in members)
        heads = sorted((m for m in members if (m.due_on or "")[:10] == latest_due),
                       key=lambda m: (bool(m.completed), m.created_at or "", m.id))
        head = heads[0]
        # Everyone else is history - or a duplicate - and must never spawn.
        for m in members:
            if m is not head and not (m.recurrence or {}).get("nextOccurrenceId"):
                m.recurrence = {**m.recurrence, "nextOccurrenceId": head.id}
                touched = True
            # ONE open occurrence per series (Oct 2): an older copy still open -
            # the stacks of overdue duplicates - closes as Missed. Once only: a
            # copy someone reopened to finish late stays open.
            if (m is not head and not m.completed and (m.due_on or "")[:10] < latest_due
                    and not (m.recurrence or {}).get("closedAsMissed")):
                _close_as_missed(db, m, f"a newer occurrence of this task is due {_us(latest_due)}")
                closed.append(m.id)
                touched = True
        rec = head.recurrence
        if rec.get("nextOccurrenceId"):
            continue
        nd = _next_due(head.due_on, rec)
        if nd > today_iso:
            continue
        while True:
            after = _next_due(nd, rec)
            if after > today_iso or after == nd:
                break
            nd = after
        if nd in dates:
            # The series already has this date - link to it instead of copying it.
            head.recurrence = {**rec, "nextOccurrenceId": dates[nd].id}
            touched = True
            continue
        owner = head.owner_email or head.created_by or head.assignee_email or "system"
        # ONE transaction per new occurrence (Oct 21 2026). A spawn locks the
        # rows it writes (the head, its parent occurrence, its subtasks) and
        # then takes the task-code counter - the order every other writer
        # follows (_lock_task_rows). Committing what came before releases
        # every earlier lock first, and committing right after releases these
        # - so the schedule never sits on the counter while asking for another
        # row. Rows somebody holds are skipped, never waited for (skip_locked).
        if touched:
            db.commit()
            touched = False
        nxt = _spawn_next_occurrence(db, head, {"email": owner}, next_due_override=nd, skip_locked=True)
        if nxt is not None:
            spawned.append(nxt)
            # The next date arrived before this one was done: it closes as
            # Missed and the series carries on from the new occurrence (Oct 2:
            # "jump to the next date anyway", one open copy at a time).
            if not head.completed and not (head.recurrence or {}).get("closedAsMissed"):
                _close_as_missed(db, head, f"the next occurrence {nxt.code} is due {_us(nd)}")
                closed.append(head.id)
        db.commit()
    if spawned or touched:
        db.commit()
    for tid in closed:
        fire_task_event(tid, "updated")
    return spawned


def _series_members(db: Session, t: models.Task, cache: Optional[dict] = None) -> list:
    """`t`'s series (itself included), grouped exactly as the daily scan
    groups one (spawn_scheduled_occurrences / _series_groups), or [] for a
    task without a calendar schedule or a due date. Only the series'
    candidates are read: the same series id, or the legacy fingerprint's
    title, project and company. `cache` keeps them for a batch."""
    rec = t.recurrence if isinstance(t.recurrence, dict) else {}
    if rec.get("freq") not in _SCHEDULED_FREQS or not (t.due_on or "")[:10]:
        return []
    sid = str(rec.get("seriesId") or "")
    company = getattr(t, "company_id", "") or ""
    # The title as _legacy_series_key compares it: trimmed, any case.
    title = (t.title or "").strip().lower()
    key = ("series", sid) if sid else ("print", title, t.project_id or "", company)
    cache = {} if cache is None else cache
    if key not in cache:
        same = [and_(func.lower(func.trim(func.coalesce(models.Task.title, ""))) == title,
                     func.coalesce(models.Task.project_id, "") == (t.project_id or ""),
                     func.coalesce(models.Task.company_id, "") == company)]
        if sid:
            same.append(models.Task.recurrence["seriesId"].as_string() == sid)
        rows = (db.query(models.Task)
                .filter(models.Task.recurrence.isnot(None),
                        (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)), or_(*same))
                .all())
        by_id = {r.id: r for r in rows}
        scheduled = [r for r in rows
                     if isinstance(r.recurrence, dict) and r.recurrence.get("freq") in _SCHEDULED_FREQS and r.due_on]
        cache[key] = {m.id: g for g in _series_groups(scheduled, by_id) for m in g}
    return cache[key].get(t.id, [])


SERIES_NEEDS_DUE = "A repeating task needs a due date - stop the repeat first or complete it."


def _clearing_stops_series(t: models.Task) -> bool:
    """Whether clearing `t`'s due date would stop its series (Oct 22 2026):
    the daily scan only carries forward occurrences that HAVE a due date, so
    the live occurrence of a calendar series - open, not yet rolled forward,
    not a reopened Missed copy - must keep one."""
    rec = t.recurrence if isinstance(t.recurrence, dict) else {}
    return (rec.get("freq") in _SCHEDULED_FREQS and bool((t.due_on or "")[:10]) and not t.completed
            and not rec.get("nextOccurrenceId") and not rec.get("closedAsMissed"))


def _series_order_problem(db: Session, t: models.Task, new_due: str, cache: Optional[dict] = None,
                          moving: Optional[dict] = None) -> str:
    """Why an occurrence may not move to `new_due`, or "" (Oct 22 2026).
    The daily scan carries a series forward from its LATEST-due occurrence,
    so a move that changes which one that is stops the series silently:
      - an OPEN occurrence moved on or before the one before it - the older
        one (already rolled forward) becomes the head and this one is closed
        as Missed. A reopened late copy (closedAsMissed) is history, not the
        head, and may move.
      - an earlier occurrence (a completed one, say) moved on or after the
        next one - it becomes the head, has already rolled forward, and the
        live occurrence is closed as Missed.
    Refused here rather than changing the scan. `moving` = {task id: new due}
    for siblings moved in the same batch: each is judged against their NEW
    dates, so shifting a whole series together is fine."""
    new_due = (new_due or "")[:10]
    mine = (t.due_on or "")[:10]
    if not new_due or new_due == mine:
        return ""
    others = [m for m in _series_members(db, t, cache) if m.id != t.id]
    if not others:
        return ""
    moving = moving or {}

    def due_of(m):
        return (moving.get(m.id) or m.due_on or "")[:10]
    later = [due_of(m) for m in others if (m.due_on or "")[:10] > mine]
    if later and new_due >= max(later):
        return (f"An earlier occurrence of a repeating task can't move on or after its next one "
                f"({task_due.us_date(max(later))}).")
    rec = t.recurrence if isinstance(t.recurrence, dict) else {}
    if t.completed or rec.get("closedAsMissed"):
        return ""
    earlier = [due_of(m) for m in others if (m.due_on or "")[:10] <= mine]
    if earlier and new_due <= max(earlier):
        return f"A repeating task can't move on or before its previous occurrence ({task_due.us_date(max(earlier))})."
    return ""


# Server-side keys on a rule that are not part of WHAT the rule says: the
# roll-forward and Missed markers, `count` (it counts down along the series)
# and the series id itself.
_SERIES_MARKERS = ("nextOccurrenceId", "count", "closedAsMissed", "seriesId")


def _with_series_id(rec, task_id: str):
    """A rule as a NEW series starts it: its own task id as the series id
    (Oct 21 2026). Whatever series id the caller sent is replaced - a
    duplicate or a template copy carries the original's rule, and keeping its
    id would make two separate tasks one series again."""
    if isinstance(rec, dict) and rec.get("freq"):
        return {**rec, "seriesId": task_id}
    return rec


def _series_key(t: models.Task, by_id: Optional[dict] = None) -> tuple:
    """What makes two tasks occurrences of the same recurring series.

    Since Oct 21 2026 a series carries its own id: `seriesId` on the rule, set
    when the series starts (create_task, a rule switched on, a template) and
    copied to every occurrence by _spawn_next_occurrence. Before that there
    was no id, and two INDEPENDENT tasks with the same title, project,
    assignees and rule were taken for one series - all but one were closed as
    Missed and stopped repeating.

    Rows from before then (no `seriesId`) keep the old fingerprint, now with
    the company in it - see _legacy_series_key. _series_groups also joins a
    series' last id-less occurrence to its first copy with an id, through
    that row's nextOccurrenceId."""
    sid = t.recurrence.get("seriesId") if isinstance(t.recurrence, dict) else None
    if sid:
        return ("series", str(sid))
    return _legacy_series_key(t, by_id)


def _legacy_series_key(t: models.Task, by_id: Optional[dict] = None) -> tuple:
    """The pre-series-id fingerprint: every occurrence is a copy of the one
    before it (_spawn_next_occurrence) - same company, title, project,
    assignees and rule. The rule is compared without its server-side markers
    (_SERIES_MARKERS)."""
    rec = {k: v for k, v in (t.recurrence or {}).items() if k not in _SERIES_MARKERS}
    key = ((getattr(t, "company_id", "") or ""), (t.title or "").strip().lower(), t.project_id or "",
           tuple(sorted(task_assignees(t))), json.dumps(rec, sort_keys=True, default=str))
    if t.parent_task_id:
        # A subtask on its own schedule: the same step under two different
        # main tasks is two series. Its copies move from occurrence to
        # occurrence of the main task, so the main task's own series - not its
        # id - is what they share; a main task that does not repeat is known
        # by its id. (`by_id` holds only rows with a rule, which every main
        # task that repeats has.) The main task's FINGERPRINT, even once it
        # has a series id: copies of this step already sit under its older,
        # id-less occurrences, and those must keep matching.
        parent = (by_id or {}).get(t.parent_task_id)
        if parent is None or not (parent.recurrence or {}).get("freq"):
            return ("sub", t.parent_task_id) + key
        return ("sub", _legacy_series_key(parent, by_id)) + key
    return key


def _series_groups(rows: list, by_id: Optional[dict] = None) -> list[list[models.Task]]:
    """Split recurring rows into series. Two rows are one series when
      * they carry the same `seriesId`, or
      * one's `nextOccurrenceId` names the other AND that other carries a
        series id - the bridge from a series' last id-less occurrence to the
        first copy made after series ids existed, or
      * NEITHER has a series id and their legacy fingerprints match - exactly
        the grouping the scan has always used for rows from before series ids.
    Connected through any mix of those (union-find). A link between two
    id-less rows is NOT followed: those rows group exactly as they always
    have (by fingerprint), so a legacy chain whose title, assignee or rule
    was edited along the way is not suddenly merged and closed as Missed.
    A series started after Oct 21 2026 is never merged with another by its
    title."""
    ids = [t.id for t in rows]
    root = {i: i for i in ids}
    by_row = {t.id: t for t in rows}

    def find(i):
        while root[i] != i:
            root[i] = root[root[i]]
            i = root[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            root[rb] = ra

    first: dict[tuple, str] = {}
    for t in rows:
        rec = t.recurrence if isinstance(t.recurrence, dict) else {}
        key = _series_key(t, by_id)   # ("series", id), or the legacy fingerprint
        if key in first:
            union(first[key], t.id)
        else:
            first[key] = t.id
        nxt = rec.get("nextOccurrenceId")
        if nxt and nxt in root and isinstance(by_row[nxt].recurrence, dict) \
                and by_row[nxt].recurrence.get("seriesId"):
            union(t.id, nxt)
    groups: dict[str, list[models.Task]] = {}
    for t in rows:
        groups.setdefault(find(t.id), []).append(t)
    return list(groups.values())


@router.get("")
def list_tasks(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = wall_tasks(db, user, db.query(models.Task).all())   # company wall first
    if is_manager(user):
        return [task_to_dict(t) for t in rows]
    # Pass the USER dict, not just the email: the helpers scope external
    # (B2B guest) callers to explicit participation only (Aug 17).
    visible_projects = visible_project_ids(db, user)
    return [task_to_dict(t) for t in rows if task_is_visible(t, user, visible_projects)]


def _csv_set(value: str) -> set:
    """`?status=a,b,c` -> {"a","b","c"}. Blank/absent -> empty set, which every
    filter below reads as "no constraint" rather than "match nothing"."""
    return {v.strip() for v in (value or "").split(",") if v.strip()}


@router.get("/export/excel")
def export_tasks_excel(
    project_id: str = "",
    status: str = "",
    priority: str = "",
    assignee: str = "",
    due_from: str = "",
    due_to: str = "",
    include_completed: bool = True,
    today: str = "",
    user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Tasks as a real .xlsx - one row per task, collaborators collapsed into a
    single cell so the sheet stays one-task-per-line and pivots cleanly.

    project_id/status/priority/assignee each take a COMMA-SEPARATED list and
    match on ANY of the values (an OR within a filter, AND across filters) -
    the same "pick none to include everything" shape the custom-field project
    picker uses. Every person column is paired with an "Enterprise Id" column
    carrying the work email, so the sheet stays joinable against other systems
    even though people are displayed by name (CLAUDE.md).

    The FILENAME describes what is in the sheet rather than being a fixed
    string - "2026-08-21 - Test Project Task Export.xlsx", "2026-08-21 - Sagar
    Shoundik's Tasks.xlsx" - so a folder of these stays readable months later.
    `today` is the CALLER's local date: the server runs UTC, which names an
    evening export in India after the day it was actually taken.

    Visibility is the SAME rule list_tasks applies (task_is_visible against
    visible_project_ids), so an export can never hand someone a task they
    cannot already open - filters narrow that set, they never widen it.
    Reference implementation for the workbook itself: requisitions.py.
    """
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
    except ImportError:
        raise HTTPException(500, "openpyxl not installed - run: pip install openpyxl")

    rows = wall_tasks(db, user, db.query(models.Task).all())   # company wall first
    if not is_manager(user):
        visible = visible_project_ids(db, user)
        rows = [t for t in rows if task_is_visible(t, user, visible)]

    # -- Filters (empty = no constraint; several values = match ANY) ----------
    want_projects = _csv_set(project_id)
    want_statuses = _csv_set(status)
    want_priorities = _csv_set(priority)
    want_assignees = {a.lower() for a in _csv_set(assignee)}

    if want_projects:
        rows = [t for t in rows
                if t.project_id in want_projects
                or want_projects & set(t.project_ids or [])]
    if want_statuses:
        rows = [t for t in rows if (t.status or "not_started") in want_statuses]
    if want_priorities:
        rows = [t for t in rows if (t.priority or "medium") in want_priorities]
    if want_assignees:
        rows = [t for t in rows if want_assignees & set(task_assignees(t))]
    if due_from:
        rows = [t for t in rows if t.due_on and t.due_on >= due_from]
    if due_to:
        rows = [t for t in rows if t.due_on and t.due_on <= due_to]
    if not include_completed:
        rows = [t for t in rows if not t.completed]

    # -- Label lookups -------------------------------------------------------
    # Same precedence the frontend's useNameResolver applies, so a sheet and the
    # screen it was exported from never disagree about someone's name: curated
    # People directory first, the older roles directory as the fallback for
    # people no longer in People, then the email itself. People must always show
    # as first + last name, never a raw email (CLAUDE.md) - the paired
    # Enterprise Id column is where the email belongs.
    people = {}
    for r in db.query(models.NexusRole).all():
        if r.email and (r.display_name or "").strip():
            people[r.email.lower()] = r.display_name.strip()
    for e in db.query(models.NexusEmployee).all():
        full = f"{e.first_name or ''} {e.last_name or ''}".strip()
        if e.work_email and full:
            people[e.work_email.lower()] = full

    def person(email):
        if not email:
            return ""
        hit = people.get(email.lower())
        if hit:
            return hit
        local = email.split("@")[0]
        parts = [p for p in re.split(r"[._-]+", local) if p]
        return " ".join(p[:1].upper() + p[1:] for p in parts) or email

    projects = {p.id: p.name for p in db.query(models.TaskProject).all()}
    status_label = {"not_started": "Not Started", "in_progress": "In Progress",
                    "completed": "Completed", "recurring": "Recurring", MISSED: "Missed"}
    for s in db.query(models.TaskCustomStatus).all():
        status_label[s.id] = s.label
    priority_label = {"low": "Low", "medium": "Medium", "high": "High", "urgent": "Urgent"}
    titles = {t.id: (t.title or "") for t in db.query(models.Task).all()}

    def us_date(iso):
        """MM/DD/YYYY - US format everywhere in user-facing output (CLAUDE.md)."""
        if not iso:
            return ""
        try:
            return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%m/%d/%Y")
        except ValueError:
            return iso

    # Grouped by project, then due date - blank dues last rather than first.
    rows.sort(key=lambda t: (projects.get(t.project_id or "", "zzz").lower(),
                             t.due_on or "9999-99-99", (t.title or "").lower()))

    wb = Workbook()
    ws = wb.active
    ws.title = "Tasks"

    headers = ["Task ID", "Task", "Parent Task", "Project",
               "Assignee", "Assignee Enterprise Id",
               "Collaborators", "Collaborators Enterprise Id",
               "Start Date", "Due Date", "Priority", "Status", "Completed",
               "Created On", "Modified On"]
    header_fill = PatternFill(start_color="1A1A2E", end_color="1A1A2E", fill_type="solid")
    header_font = Font(bold=True, color="FFFFFF")
    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")

    for t in rows:
        extra = [projects.get(p, "") for p in (t.project_ids or []) if p and p != t.project_id]
        project_cell = ", ".join(x for x in [projects.get(t.project_id or "", "")] + extra if x)
        collaborators = [e for e in (t.follower_emails or []) if e]
        ws.append([
            t.code or t.id,
            t.title or "",
            titles.get(t.parent_task_id or "", ""),
            project_cell,
            ", ".join(person(a) or a for a in task_assignees(t)) or "Unassigned",
            ", ".join(task_assignees(t)),
            ", ".join(person(e) for e in collaborators),
            ", ".join(collaborators),
            us_date(t.start_on),
            us_date(t.due_on),
            priority_label.get(t.priority or "medium", t.priority or ""),
            status_label.get(t.status or "not_started", t.status or ""),
            "Yes" if t.completed else "No",
            us_date(t.created_at),
            us_date(t.modified_at),
        ])

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{ws.cell(row=1, column=len(headers)).column_letter}{max(ws.max_row, 1)}"
    for col in ws.columns:
        max_len = max((len(str(cell.value or "")) for cell in col), default=0)
        ws.column_dimensions[col[0].column_letter].width = min(max_len + 4, 45)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    # -- Filename: say what is in the sheet ----------------------------------
    # "08-21-2026 - Task Export"                      (no filters)
    # "08-21-2026 - Test Project Task Export"         (one project)
    # "08-21-2026 - Sagar Shoundik's Tasks"           (one person)
    # "08-21-2026 - Test Project - Sagar Shoundik's Tasks"  (both)
    # Several of either collapse to a count ("3 Projects", "4 People's Tasks")
    # rather than running the name past what a file manager will show.
    # The date is US order (MM-DD-YYYY) like every date a person reads; hyphens
    # because a slash cannot go in a filename.
    iso_day = today if re.fullmatch(r"\d{4}-\d{2}-\d{2}", today or "") else datetime.utcnow().strftime("%Y-%m-%d")
    stamp = f"{iso_day[5:7]}-{iso_day[8:10]}-{iso_day[:4]}"

    picked_projects = [projects[p] for p in sorted(want_projects) if projects.get(p)]
    picked_people = [person(a) for a in sorted(want_assignees)]

    if len(picked_people) == 1:
        who = picked_people[0]
        # "Chris' Tasks", not "Chris's Tasks".
        whose = f"{who}'" if who.endswith("s") else f"{who}'s"
        label = f"{whose} Tasks"
    elif picked_people:
        label = f"{len(picked_people)} People's Tasks"
    else:
        label = "Task Export"

    if len(picked_projects) == 1:
        scope = picked_projects[0]
    elif picked_projects:
        scope = f"{len(picked_projects)} Projects"
    else:
        scope = ""

    if scope and picked_people:
        name = f"{stamp} - {scope} - {label}"
    elif scope:
        name = f"{stamp} - {scope} {label}"
    else:
        name = f"{stamp} - {label}"

    # A project name is free text, so strip what Windows/macOS reject in a
    # filename before it reaches a download folder.
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', " ", name)
    name = re.sub(r"\s+", " ", name).strip()[:120]
    filename = f"{name}.xlsx"

    # Quoted (it has spaces) plus RFC 5987 for names that leave ASCII - an
    # accented person or project name would otherwise arrive mangled.
    ascii_name = filename.encode("ascii", "ignore").decode() or "Task Export.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 f'attachment; filename="{ascii_name}"; '
                 f"filename*=UTF-8''{quote(filename)}"},
    )


def _is_external(e) -> bool:
    """A guest / external identity (their org is external_company, not one of
    our companies) - see models.NexusEmployee.identity_type."""
    return (getattr(e, "identity_type", "") or "") in ("guest", "external")


@router.get("/search")
def search_everything(q: str = "", limit: int = 6,
                      user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """One query, results grouped by what they are - the shape Asana's own
    search offers, and the shape people expect from a magnifier in a header.

    The header's search used to match MODULE NAMES only, so typing the title of
    a task you were looking at returned nothing at all.

    Visibility is the same rule the task list applies (task_is_visible against
    visible_project_ids), so search can never surface a task someone cannot
    already open. People come from the curated Nexus directory, never a
    M365/GAL-derived list (CLAUDE.md).

    Ranking is deliberately dumb and predictable: a prefix match sorts above a
    match anywhere, then alphabetical. Anything cleverer here is a scoring
    system nobody can explain when it puts the wrong row first."""
    term = (q or "").strip().lower()
    if len(term) < 2:
        return {"tasks": [], "projects": [], "portfolios": [], "teams": [], "people": [], "totals": {}}
    limit = max(1, min(limit, 20))

    def rank(text: str) -> tuple:
        t = (text or "").lower()
        return (0 if t.startswith(term) else 1, t)

    def top(rows, text_of):
        return sorted(rows, key=lambda r: rank(text_of(r)))[:limit]

    manager = is_manager(user)
    visible = None if manager else visible_project_ids(db, user)

    tasks = [t for t in wall_tasks(db, user, db.query(models.Task).all())
             if (term in (t.title or "").lower() or term in (t.code or "").lower())
             and not t.completed
             and (manager or task_is_visible(t, user, visible))]
    # The company wall applies to every group, not only tasks (Oct 21 2026):
    # a project, portfolio or team name - and the people list - from another
    # company is as much a leak as a task title. Walled before the per-group
    # cap, so a capped list is never short because the cap ate admitted rows.
    import auth
    scope = auth.company_scope(user, db)
    all_projects = wall_rows(db, user, db.query(models.TaskProject).all(), scope=scope)
    project_names = {p.id: p.name for p in all_projects}
    # Archived projects DO appear here. Archiving hides a project from the
    # active list and from task pickers - it is not deletion, and search is how
    # you get back to finished work. The result carries `archived` so the UI can
    # mark it rather than pass it off as live.
    projects = [p for p in all_projects
                if term in (p.name or "").lower()
                and (manager or p.id in visible)]
    portfolios = [p for p in wall_rows(db, user, db.query(models.TaskPortfolio).all(), scope=scope)
                  if term in (p.name or "").lower()]
    teams = [t for t in wall_teams(db, user, db.query(models.TaskTeam).all(), scope=scope)
             if term in (t.name or "").lower()]

    people = []
    for e in db.query(models.NexusEmployee).all():
        if (e.status or "") in ("inactive", "offboarded"):
            continue
        # An external (guest / external identity) belongs to a partner org -
        # external_company is its free-text name, never one of our companies -
        # so the company wall does not hide them; they are found as before.
        if not _is_external(e) and not auth.company_ok((e.company or "").strip(), scope):
            continue
        name = f"{e.first_name or ''} {e.last_name or ''}".strip()
        if term in name.lower() or term in (e.work_email or "").lower():
            # jobTitle, not "title" - a task's title is also `title`, and one
            # dict key meaning two different things across the same response is
            # how a renderer ends up printing someone's job where their name goes.
            people.append({"email": e.work_email, "name": name or e.work_email,
                           "jobTitle": e.job_title or ""})

    # A subtask carries project_id "" - its project is its parent's. Without
    # the walk, 92 same-titled "Finish all Books for Current Year" subtasks
    # (one per company's Tax Return) rendered as six identical bare lines and
    # read as duplicates of nothing. parentTitle is what tells them apart.
    by_id = {t.id: t for t in db.query(models.Task).all()} if any(t.parent_task_id for t in tasks) else {}

    def shape_task(t):
        parent = by_id.get(t.parent_task_id or "") if t.parent_task_id else None
        proj_id = t.project_id or ""
        cur, depth = t, 0
        while not proj_id and cur is not None and cur.parent_task_id and depth < 20:
            cur = by_id.get(cur.parent_task_id)
            proj_id = (cur.project_id or "") if cur else ""
            depth += 1
        return {"id": t.id, "code": t.code or "", "title": t.title,
                "completed": bool(t.completed), "assigneeId": _nz(t.assignee_email),
                "projectId": _nz(t.project_id),
                "projectName": project_names.get(proj_id, ""),
                "parentTitle": (parent.title if parent else "")}

    return {
        "tasks": [shape_task(t) for t in top(tasks, lambda t: t.title)],
        # Archived projects stay FINDABLE - archiving hides a project from the
        # active list and from task pickers, it does not hide its history. The
        # flag rides along so the result can be marked as archived rather than
        # looking like live work.
        "projects": [{"id": p.id, "name": p.name, "color": p.color or "", "icon": p.icon or "",
                      "archived": bool(p.archived)}
                     for p in top(projects, lambda p: p.name)],
        "portfolios": [{"id": p.id, "name": p.name} for p in top(portfolios, lambda p: p.name)],
        "teams": [{"id": t.id, "name": t.name, "color": t.color or ""}
                  for t in top(teams, lambda t: t.name)],
        "people": top(people, lambda p: p["name"]),
        # How many matched in total, so a capped list can say "and N more"
        # instead of passing itself off as everything there is.
        "totals": {"tasks": len(tasks), "projects": len(projects), "portfolios": len(portfolios),
                   "teams": len(teams), "people": len(people)},
    }


@router.get("/people/{email}")
def person_profile(email: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Everything one person's page shows, in one call: who they are, the work
    they hold, and where they belong.

    Four task buckets, matching how people actually ask about a colleague:
    everything they hold (`assigned`), what YOU gave them (`assignedByYou`),
    what they handed out (`created` - they made it, somebody else holds it),
    and where the two of you overlap (`collaboratingWithYou`). Two of those are
    relative to the VIEWER, which is the point: "what did I give this person"
    is a different question from "what are they doing", and a page that only
    answered the second made you go and work the first out by eye.

    All four go through the same visibility rule as the task list, so this page
    can never become a way to read work you could not otherwise open.

    The person comes from the curated Nexus directory (nexus_employees), never
    a M365/GAL list - CLAUDE.md. An address with no directory row still gets a
    page: Asana guests sync in as collaborators long before HR has a record,
    and their work is real even when their profile is thin."""
    email = (email or "").strip().lower()
    if not email:
        raise HTTPException(404, "Person not found")
    emp = db.query(models.NexusEmployee).filter(
        models.NexusEmployee.work_email == email).first()
    # Somebody in another company is not on this side of the wall (Oct 21
    # 2026): their directory card is as walled as their work. No-op while the
    # walls are off and for a Global Admin.
    import auth
    if (emp is not None and not _is_external(emp)
            and not auth.company_ok((emp.company or "").strip(), auth.company_scope(user, db))):
        raise HTTPException(404, "Person not found")

    manager = is_manager(user)
    visible = None if manager else visible_project_ids(db, user)
    rows = [t for t in wall_tasks(db, user, db.query(models.Task).all())
            if manager or task_is_visible(t, user, visible)]
    walled_projects = wall_rows(db, user, db.query(models.TaskProject).all())
    project_names = {p.id: p.name for p in walled_projects}

    def shape(t):
        return {"id": t.id, "code": t.code or "", "title": t.title,
                "completed": bool(t.completed), "status": t.status,
                "dueOn": _nz(t.due_on), "assigneeId": _nz(t.assignee_email),
                "dueExtensionCount": int(t.due_extension_count or 0),
                "projectId": _nz(t.project_id),
                "projectName": project_names.get(t.project_id or "", "")}

    def newest(items, limit=25):
        # Open work first, then nearest due date - a page that opened on
        # something finished last March would bury what the person is on now.
        return [shape(t) for t in sorted(
            items, key=lambda t: (bool(t.completed), t.due_on or "9999", t.title.lower()))[:limit]]

    me = (user.get("email") or "").strip().lower()

    def on_it(t, who):
        """Everyone a task visibly involves - its assignee and its followers."""
        return who and (who in task_assignees(t)
                        or who in email_list(t.follower_emails))

    assigned = [t for t in rows if email in task_assignees(t)]
    assigned_by_you = [t for t in assigned if (t.created_by or "").lower() == me]
    created = [t for t in rows if (t.created_by or "").lower() == email
               and email not in task_assignees(t)]
    # Both of you on the same task. Empty on your OWN page, where "collaborating
    # with you" would otherwise match every task you touch and mean nothing.
    collaborating = ([] if me == email else
                     [t for t in rows if on_it(t, email) and on_it(t, me)])

    today = date.today().isoformat()
    open_assigned = [t for t in assigned if not t.completed]
    projects = [p for p in walled_projects
                if (manager or p.id in visible) and not p.archived
                and (email in email_list(p.member_emails)
                     or (p.owner_email or "").lower() == email
                     or p.id in {t.project_id for t in assigned if t.project_id})]
    teams = [t for t in wall_teams(db, user, db.query(models.TaskTeam).all())
             if email in email_list(t.member_emails)]

    return {
        "person": {
            "email": email,
            "name": (f"{emp.first_name or ''} {emp.last_name or ''}".strip() or email) if emp else email,
            "displayName": (emp.display_name or "") if emp else "",
            "jobTitle": (emp.job_title or "") if emp else "",
            "department": (emp.department or "") if emp else "",
            "location": (emp.location or "") if emp else "",
            "photoUrl": (emp.photo_url or "") if emp else "",
            "identityType": (emp.identity_type or "internal") if emp else "external",
            "status": (emp.status or "active") if emp else "",
            "inDirectory": bool(emp),
        },
        "stats": {
            "open": len(open_assigned),
            "completed": len([t for t in assigned if t.completed]),
            "overdue": len([t for t in open_assigned if t.due_on and t.due_on[:10] < today]),
        },
        "tasks": {"assigned": newest(assigned), "assignedByYou": newest(assigned_by_you),
                  "created": newest(created), "collaboratingWithYou": newest(collaborating)},
        "projects": [{"id": p.id, "name": p.name, "color": p.color or "", "icon": p.icon or ""}
                     for p in projects],
        "teams": [{"id": t.id, "name": t.name, "color": t.color or ""} for t in teams],
        # How they do against deadlines (task_due.person_record). Only for a
        # manager or the person themselves - a colleague's lateness is not
        # something every peer should be able to read.
        "deadlineRecord": task_due.person_record(assigned, email) if (manager or me == email) else None,
    }


@router.get("/delta")
def list_tasks_delta(since: str = "", user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Incremental fetch for TasksContext's mount load + repeated refresh
    (45s poll, realtime ping) - GET /tasks ships the full ~2,400-task
    workspace every call even when nothing changed. `since=""` (the mount
    case) naturally returns everything with no deletions, so this serves
    both the initial and incremental load through one path.

    `server_time` is captured BEFORE the query runs, not after - same
    reasoning as asana_sync._pull_window's "stamped from when the fetch
    STARTED": a task edited mid-query must fall in the NEXT delta window,
    never be missed because it looked "already covered" by this one.

    `deletedIds` (Oct 21 2026) is every id the caller's copy must DROP, not
    only the trashed ones: a task changed in this window that the caller can
    no longer see - made private, moved to a project they are not in, behind
    the company wall - is in it too, as is one binned in the window without a
    tombstone (a project's tasks go to the bin with it). Only rows changed
    since `since` are looked at, the same rows the query already reads, so
    the call costs what it did. A task that went out of sight WITHOUT being
    touched (the caller was taken off its project) is not caught here; the
    next full load drops it. An id that is in `tasks` is never in
    `deletedIds` (a task binned and restored inside one window is live)."""
    server_time = now_iso()
    q = db.query(models.Task)
    if since:
        # Trashed rows too (their deleted_at is set): they leave the caller's
        # list like any other row they can no longer see.
        q = q.execution_options(include_deleted=True).filter(models.Task.modified_at > since)
    fetched = q.all()
    live = [t for t in fetched if not t.deleted_at]
    rows = wall_tasks(db, user, live)   # company wall first
    if not is_manager(user):
        visible_projects = visible_project_ids(db, user)
        rows = [t for t in rows if task_is_visible(t, user, visible_projects)]
    kept = {t.id for t in rows}
    gone: list[str] = []
    if since:
        logged = (db.query(models.TaskDeleteLog.task_id)
                  .filter(models.TaskDeleteLog.deleted_at > since).all())
        gone = [d.task_id for d in logged] + [t.id for t in fetched if t.id not in kept]
    seen: set = set()
    deleted_ids = []
    for i in gone:
        if i and i not in kept and i not in seen:
            seen.add(i)
            deleted_ids.append(i)
    return {"tasks": [task_to_dict(t) for t in rows],
            "deletedIds": deleted_ids,
            "serverTime": server_time}


@router.post("", status_code=201)
def create_task(body: TaskCreate, background_tasks: BackgroundTasks,
                user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    return _create_task(body, background_tasks, user, db, check_people=True)


def _create_task(body: TaskCreate, background_tasks: BackgroundTasks, user: dict, db: Session,
                 before_commit=None, check_people: bool = False):
    """create_task's body. `before_commit(task)` runs on the new row just
    before the one commit, so a caller's own writes land in the same
    transaction - a ticket's "Create Task from Ticket" links both sides there,
    and a task can never exist without its link (routers/tickets.py).

    `check_people` (the HTTP create and Use Template, Oct 21 2026): every
    assignee and collaborator named in the body must be a current directory
    person on the task's side of the company wall. Off for the in-process
    callers that bring their own people rules (a ticket's desk assignee and
    watchers, a Knowledge Base SOP task)."""
    now = now_iso()
    tid = body.id or gen_id()
    # No explicit access_level -> inherit the project's (so a task in a
    # restricted project doesn't leak org-wide by default); no project either
    # -> falls back to org, same as before.
    project = (db.query(models.TaskProject).filter(models.TaskProject.id == body.project_id).first()
               if body.project_id else None)
    parent = (db.query(models.Task).filter(models.Task.id == body.parent_task_id).first()
              if body.parent_task_id else None)
    if parent is not None:
        # A subtask goes under a task on the caller's side of the company
        # wall only (Oct 21 2026) - 404, as for any task over it - and one
        # the caller can see: a restricted standalone parent has no project
        # role to refuse anybody, so sight is the check.
        assert_task_wall(db, user, parent)
        if not task_visible_to(db, user, parent):
            raise HTTPException(404, "Task not found")
    if not project and parent is not None:
        project = project_for_task(db, parent)
    # The company wall on the project too: a manager clears the role check, so
    # without it a task could be created inside another company's project.
    require_project_access(db, user, project, "editor")
    # Normalizes tags/followers in place too, so the row is written clean rather
    # than needing a later PATCH to tidy it.
    validate_task_payload(db, body.__dict__, task_id=tid)
    # Dependencies and extra projects named at create answer to the same
    # rules as an edit (Oct 21 2026): the other task must be the caller's to
    # see and edit, an extra project theirs to add work to.
    _require_dependency_targets(db, user, None, body.__dict__, tid)
    _require_destination_projects(db, user, _extra_project_ids(body.project_ids, body.project_id or ""))
    if parent is not None:
        # The parent's row is written (its subtask list) - lock it now, before
        # the task-code counter below: task rows are always locked before the
        # counter, never after (see _lock_task_rows).
        _lock_task_rows(db, [parent.id])
    # Company wall: stamp the creator's company so the task is fixed on their side
    # of the wall even if they later change companies (task_util.task_company falls
    # back to deriving it for legacy/sync rows that were never stamped).
    _creator = (db.query(models.NexusEmployee.company)
                .filter(func.lower(models.NexusEmployee.work_email) == user["email"].lower()).first())
    company_id = (_creator.company if _creator else "") or ""
    # A project's required custom fields (Oct 13 2026: "no one can create a
    # task in that project without" them). Checked here, not just in the
    # forms, so the quick-add rows, request forms and anything else that
    # creates a task cannot slip past. Top-level tasks in a project only: a
    # subtask is part of its parent, and a task with no project has no
    # project to require anything.
    if body.project_id and not body.parent_task_id:
        # A field that belongs to one company binds only that company's tasks
        # (Oct 21 2026); a shared field binds every task, as before.
        missing = missing_required_fields(db, body.project_id,
                                          coerce_custom_field_values(db, body.custom_field_values),
                                          task_company=company_id)
        if missing:
            names = ", ".join(f.name for f in missing)
            where = f" in {project.name}" if project and project.name else " in this project"
            raise HTTPException(422, f"{names} {'is' if len(missing) == 1 else 'are'} required for tasks{where}.")
    access_level = body.access_level or (project.access_level if project else None) or "org"
    t = models.Task(
        id=tid,
        company_id=company_id,
        code=_next_code(db),
        title=body.title,
        description=body.description or "",
        type=body.type or "task",
        status=body.status or "not_started",
        priority=body.priority or "medium",
        # Defaults to "now" (epoch seconds) rather than 0 so a freshly created
        # task lands at the END of manual order, after everything dragged
        # before it - not shuffled to the front of every group.
        position=body.position if body.position is not None else time.time(),
        # Set below via set_task_assignees, which writes both columns.
        assignee_email="",
        owner_email=(body.owner_email or "").strip().lower(),
        follower_emails=body.follower_emails or [],
        liked_by_emails=body.liked_by_emails or [],
        access_level=access_level,
        project_id=body.project_id or "",
        project_ids=_extra_project_ids(body.project_ids, body.project_id or ""),
        section_id=body.section_id or "",
        team_id=body.team_id or "",
        parent_task_id=body.parent_task_id or "",
        subtask_ids=body.subtask_ids or [],
        blocked_by_ids=body.blocked_by_ids or [],
        blocking_ids=body.blocking_ids or [],
        dependency_types=body.dependency_types or {},
        tags=body.tags or [],
        custom_field_values=coerce_custom_field_values(db, body.custom_field_values),
        # A task created straight INTO a started column began today, by
        # definition - there is no move off Not Started for _autostamp_start to
        # catch, so the created date IS the start date. Same reasoning as
        # `completed` just below: the group a task is added to states its
        # status, and the fields that follow from that status have to be set
        # here or nothing ever sets them. An explicit start_on still wins.
        start_on=body.start_on or ("" if (body.status or "not_started") == "not_started" else now[:10]),
        due_on=body.due_on or "",
        estimate_hours=body.estimate_hours,
        actual_hours=body.actual_hours,
        # A repeating task starts its own series - see _with_series_id.
        recurrence=_with_series_id(body.recurrence, tid),
        is_milestone=bool(body.is_milestone),
        approval_status=body.approval_status or "none",
        # Not hardcoded False any more: a task created straight INTO the
        # Completed group (the "+ Add task…" row inherits its group's status)
        # arrived with status "completed" and this flag off, so it showed no
        # strikethrough and kept drawing overdue emails. TaskCreate has no
        # `completed` field, so status is the only thing that can say so here.
        completed=(body.status == "completed"),
        completed_at=(now if body.status == "completed" else ""),
        comment_ids=[], attachment_ids=[], activity_ids=[],
        created_at=now, modified_at=now, created_by=user["email"],
    )
    set_task_assignees(t, _assignees_from(body.__dict__, []) or [])
    dropped_people: list = []
    if check_people:
        # People who may not be put on it (not in the directory, offboarded,
        # or - behind the wall - another company) are LEFT OFF, not refused:
        # Add Subtask, Duplicate and Use Template carry people over from a
        # source task, and one departed collaborator must not fail the whole
        # create. The task's history says who was not added and why, and the
        # response lists them (droppedPeople). Oct 21 2026.
        kept_a, gone_a = split_people(db, t, task_assignees(t), user, user["email"])
        kept_f, gone_f = split_people(db, t, t.follower_emails or [], user, user["email"])
        set_task_assignees(t, kept_a)
        t.follower_emails = kept_f
        dropped_people = gone_a + gone_f
    # Whoever raised the task follows it - see _follow_as_actor.
    _follow_as_actor(t, user["email"])
    # A date set for somebody else is a target they still have to confirm.
    task_due.init_due(t, user["email"])
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
    note_dropped_people(db, t, dropped_people, user["email"])
    # Automation rules that fire on creation (task_automation.py) write onto
    # this same row before anyone is told about it, so a rule that assigns or
    # re-dates the task notifies exactly as a person doing it would.
    auto_before = task_automation.snapshot(t)
    auto = task_automation.run_for_change(db, t, event="created", before=auto_before)
    if "status" in auto.changed:
        # Same rule as update_task: a rule that sets Completed closes the task,
        # one that sets anything else on a task created as Completed reopens it.
        _apply_completion(t, _resolve_completed({"status": auto.changed["status"]}, bool(t.completed)), bool(t.completed))
    if "due_on" in auto.changed:
        task_due.record_due_change(db, t, auto_before["due_on"], t.due_on or "",
                                   actor=task_automation.AUTOMATION_ACTOR, source="automation")
    # Everyone assigned gets told, not just the first - the others would
    # otherwise carry work they were never notified about.
    for who in task_assignees(t):
        if who != user["email"].lower():
            task_notify(db, kind="task_assigned", for_email=who,
                        title="You Were Assigned a Task",
                        body=f"{t.title}", task_id=tid,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    if before_commit is not None:
        before_commit(t)
    db.commit()
    db.refresh(t)
    fire_task_event(tid, "created")
    background_tasks.add_task(notify_task_event, tid, "created", user["email"])
    task_automation.run_after_commit(db, auto, background_tasks.add_task)
    out = task_to_dict(t)
    if dropped_people:
        out["droppedPeople"] = [{**d, "taskId": t.id} for d in dropped_people]
    return out


_MODIFIED_FIELD_LABELS = {"title": "Title changed", "description": "Description changed",
                         "due_on": "Due date changed", "start_on": "Start date changed",
                         "priority": "Priority changed"}


@router.patch("/{task_id}")
def update_task(task_id: str, upd: TaskUpdate, background_tasks: BackgroundTasks,
                user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    # Company wall: another company's task is 404 (before the role check).
    assert_task_wall(db, user, t)
    # The assignee counts on their OWN task - see require_task_role.
    require_task_role(db, user, t, "editor")
    data = upd.model_dump(exclude_unset=True)
    validate_task_payload(db, data, task_id=task_id)
    if "subtask_order" in data and data["subtask_order"] not in ("", "manual"):
        data["subtask_order"] = ""
    # A section belongs to one project (the Custom grouping, Oct 13 2026), so a
    # task moved to another project leaves its old section behind - the same
    # rule bulk_update applies to Move To.
    if "project_id" in data and (data["project_id"] or "") != (t.project_id or "") and "section_id" not in data:
        data["section_id"] = ""
    if "custom_field_values" in data:
        data["custom_field_values"] = coerce_custom_field_values(db, data["custom_field_values"])
    if "actual_hours" in data and int(t.time_entry_count or 0) > 0:
        raise HTTPException(409, "This task's time comes from its time entries - add or edit an entry instead.")
    _check_update_access(db, user, t, data)
    prev_assignees = set(task_assignees(t))
    prev_status = t.status
    prev_completed = bool(t.completed)
    prev_followers = set((t.follower_emails or []))
    prev_due = (t.due_on or "")[:10]
    prev_start = t.start_on or ""
    # Where the negotiation stood, for an Undo of this move (due_undo).
    prev_agreement = t.due_agreement or ""
    prev_proposal = dict(t.due_proposal) if isinstance(t.due_proposal, dict) else None
    prev_parent = t.parent_task_id or ""
    prev_subtasks = [i for i in (t.subtask_ids or []) if i]
    _check_hierarchy_patch(db, user, t, data)
    if "due_on" in data and (data.get("due_on") or "")[:10] != prev_due:
        problem = _series_order_problem(db, t, data.get("due_on") or "")
        if problem:
            raise HTTPException(422, problem)
        # Clearing the live occurrence's date stops the series - unless this
        # same edit stops the repeat or completes the task.
        stops_repeat = ("recurrence" in data
                        and (data["recurrence"] or {}).get("freq") not in _SCHEDULED_FREQS)
        if (not (data.get("due_on") or "")[:10] and _clearing_stops_series(t) and not stops_repeat
                and not _resolve_completed(data, prev_completed)):
            raise HTTPException(422, SERIES_NEEDS_DUE)
    auto_before = task_automation.snapshot(t)
    modified_kinds = [label for field, label in _MODIFIED_FIELD_LABELS.items() if field in data]

    new_status = data.get("status", prev_status)
    # See _resolve_completed: `completed` and `status` are two columns for one
    # user-facing concept, and this rule is now shared with create and bulk so
    # the three cannot disagree about what "done" means.
    new_completed = _resolve_completed(data, prev_completed)
    _check_dependency_gate(db, t, prev_status, prev_completed, new_status, new_completed)

    for field, val in data.items():
        if field == "completed":
            continue  # handled below
        if field in ("assignee_email", "assignee_emails"):
            continue  # both are applied together, below
        if field == "owner_email":
            # strip() as well as lower(): a padded address is stored verbatim and
            # then never equals the same person anywhere else, so the task is
            # assigned to somebody who never sees it in My Tasks.
            val = (val or "").strip().lower()
        if field == "recurrence" and isinstance(val, dict):
            # The editor sends the rule back without the server-only
            # `nextOccurrenceId` marker. Dropping it would let the daily
            # schedule spawn this occurrence's successor a second time.
            nxt_id = (t.recurrence or {}).get("nextOccurrenceId") if isinstance(t.recurrence, dict) else None
            if nxt_id and "nextOccurrenceId" not in val:
                val = {**val, "nextOccurrenceId": nxt_id}
            # Same for closedAsMissed: without it a reopened Missed copy would be
            # closed again by the next scan after any edit to its rule.
            missed_at = (t.recurrence or {}).get("closedAsMissed") if isinstance(t.recurrence, dict) else None
            if missed_at and "closedAsMissed" not in val:
                val = {**val, "closedAsMissed": missed_at}
            # The series id is the server's, never the editor's: kept as it
            # was; a rule switched on here starts a series of its own; a
            # series from before series ids stays without one, so it keeps
            # matching its older occurrences (_series_groups).
            old_rule = t.recurrence if isinstance(t.recurrence, dict) else {}
            val = {k: v for k, v in val.items() if k != "seriesId"}
            if old_rule.get("seriesId"):
                val["seriesId"] = old_rule["seriesId"]
            elif val.get("freq") and not old_rule.get("freq"):
                val["seriesId"] = t.id
        setattr(t, field, val)

    # Assignment goes through the setter so the legacy mirror can never drift
    # from the list, whichever field the caller sent.
    wanted = _assignees_from(data, list(prev_assignees))
    if wanted is not None:
        set_task_assignees(t, wanted)

    # Re-clean the extra list whenever either side of the project pair moved -
    # a caller can PATCH project_id alone (e.g. the primary Project picker) or
    # project_ids alone (the "also in" multi-select), and either one can leave
    # the primary duplicated inside the extras or a since-removed blank behind.
    if "project_id" in data or "project_ids" in data:
        t.project_ids = _extra_project_ids(t.project_ids, t.project_id or "")

    # Both ends of a parent/subtask link move together - see _sync_hierarchy.
    _sync_hierarchy(db, t, data, prev_parent, prev_subtasks)

    # Automation rules (task_automation.py) see the row as this edit leaves it
    # and write onto the same row. Whatever they changed is merged into `data`
    # so the completion, activity, due-history and notification logic below
    # treats it as part of this edit: one commit, one realtime ping, and the
    # person a rule assigns is told the same way as one a colleague assigns.
    auto = task_automation.run_for_change(
        db, t, event="updated", before=auto_before, completed=new_completed,
        gate=lambda ps, pc, ns, nc: _check_dependency_gate(db, t, ps, pc, ns, nc))
    auto_moved_due = "due_on" in auto.changed
    if auto.changed:
        data.update(auto.changed)
        if "assignee_emails" in auto.changed:
            wanted = task_assignees(t)
        new_completed = _resolve_completed(data, prev_completed)
        modified_kinds = [label for field, label in _MODIFIED_FIELD_LABELS.items() if field in data]

    # After the field loop, so a start_on sent in this same PATCH wins over the
    # stamp - the caller stating a date is better information than "today".
    _autostamp_start(t, prev_status, t.status or "")

    # Keeps `completed`, its timestamp and `status` in step regardless of which
    # one the caller actually sent.
    _land_completion(db, t, new_completed, prev_completed, user["email"])

    _sync_reciprocal_dependencies(db, t, data)

    t.modified_at = now_iso()

    # activity + notifications for meaningful changes
    acts = list(t.activity_ids or [])
    if "status" in data and data["status"] != prev_status:
        acts.append(log_activity(db, type="status_changed", actor_email=user["email"],
                                 entity_id=t.id, entity_code=t.code, entity_title=t.title,
                                 detail=f"changed status to {data['status']}"))
    now_assignees = set(task_assignees(t))
    if wanted is not None and now_assignees != prev_assignees:
        acts.append(log_activity(db, type="assignee_changed", actor_email=user["email"],
                                 entity_id=t.id, entity_code=t.code, entity_title=t.title,
                                 detail="reassigned this task"))
        # Assigning somebody LATER follows the task for you too, same as
        # creating it did. Only when people were actually added - taking an
        # assignee off is no reason to subscribe anyone. Skipped when this same
        # PATCH states the collaborator list explicitly: that is the caller
        # saying who is on it, including deciding it is not them.
        if (now_assignees - prev_assignees) and "follower_emails" not in data:
            _follow_as_actor(t, user["email"])
        # Only people newly ADDED are notified. Re-notifying everyone whenever a
        # third assignee joins would mail the original two about a task they
        # already hold.
        for who in (now_assignees - prev_assignees):
            if who != user["email"].lower():
                task_notify(db, kind="task_assigned", for_email=who,
                            title="You Were Assigned a Task",
                            body=f"{t.title}", task_id=t.id,
                            nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    if t.completed and not prev_completed:
        acts.append(_log_completed(db, t, user["email"]))
    t.activity_ids = acts

    # After activity_ids is rebuilt above - task_due appends its own entries.
    due_entry = None
    ask = []
    if "due_on" in data and (t.due_on or "")[:10] != prev_due:
        # The 3rd+ extension, or one more than a month out, waits for approval
        # (task_due.needs_approval) - the task keeps its date meanwhile. A move
        # an automation rule made has nobody to ask.
        ask = task_due.needs_approval(db, t, prev_due, t.due_on or "", user["email"],
                                      privileged=is_manager(user) or auto_moved_due)
    if ask:
        wanted_due = (t.due_on or "")[:10]
        t.due_on = prev_due
        # A start date sent in the same edit moves WITH the due date (a
        # Calendar or Timeline drag keeps the task's length, Oct 22 2026), so
        # it waits with it: moving the start alone would stretch or squash
        # the task while the due date is still being asked about.
        held = {"Due date changed"}
        wanted_start = ""
        if "start_on" in data:
            if (t.start_on or "") != prev_start:
                wanted_start = t.start_on or ""
            t.start_on = prev_start
            held.add("Start date changed")
        task_due.request_extension(db, t, user["email"], wanted_due, ask, start_on=wanted_start)
        modified_kinds = [k for k in modified_kinds if k not in held]
    elif "due_on" in data and (t.due_on or "")[:10] != prev_due:
        due_entry = task_due.record_due_change(
            db, t, prev_due, t.due_on or "",
            actor=task_automation.AUTOMATION_ACTOR if auto_moved_due else user["email"],
            source="automation" if auto_moved_due else "app")
        if due_entry is not None and not auto_moved_due:
            # What an Undo of this move puts back (POST /tasks/{id}/due/undo).
            due_entry["undo"] = {"agreement": prev_agreement, "proposal": prev_proposal}
            if (t.start_on or "") != prev_start:
                due_entry["undo"].update(startFrom=prev_start, startTo=t.start_on or "")
        # The generic "Due date changed" becomes the actual story.
        modified_kinds = [k for k in modified_kinds if k != "Due date changed"]
        modified_kinds.insert(0, _due_change_label(t, due_entry))
        req = task_due.requester_of(t)
        if req and req != user["email"].lower():
            task_notify(db, kind="task_due_changed", for_email=req,
                        title="Due Date Extended" if due_entry["extension"] else "Due Date Changed",
                        body=f"{t.title} - {_due_change_label(t, due_entry)}", task_id=t.id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    elif "due_on" in data:
        modified_kinds = [k for k in modified_kinds if k != "Due date changed"]
    elif wanted is not None and set(task_assignees(t)) != prev_assignees and t.due_on:
        # A new holder did not agree to the old holder's date.
        task_due.settle_agreement(t, user["email"])

    # A checklist subtask's new due date moves its step (Oct 20) - after the
    # approval decision above, so a held date moves nothing (Oct 22 2026).
    if (t.due_on or "")[:10] != (auto_before.get("due_on") or ""):
        import hr_checklists
        hr_checklists.task_due_changed(db, t, user["email"])

    # Completing a recurring task rolls the series forward to the next occurrence.
    spawned = _after_completed(db, t, user, prev_completed)

    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "updated")
    if spawned is not None:
        fire_task_event(spawned.id, "created")
    task_automation.run_after_commit(db, auto, background_tasks.add_task)

    if wanted is not None and (set(task_assignees(t)) - prev_assignees):
        background_tasks.add_task(notify_task_event, t.id, "assigned", user["email"])
    if t.completed and not prev_completed:
        background_tasks.add_task(notify_task_event, t.id, "completed", user["email"])
    for f in (set(t.follower_emails or []) - prev_followers):
        background_tasks.add_task(notify_task_event, t.id, "follower_added", user["email"], new_follower=f)
    if modified_kinds:
        # due_changed puts the requester on this email too (task_notify
        # _recipients_for) - Neil: "if a task changes due date it will notify
        # the requester".
        background_tasks.add_task(notify_task_event, t.id, "modified", user["email"],
                                  update_kind=", ".join(modified_kinds),
                                  due_changed=due_entry is not None,
                                  due_entry_at=(due_entry or {}).get("at") or "")
    return task_to_dict(t)


class RescheduleBody(BaseModel):
    start_on: Optional[str] = None
    due_on: Optional[str] = None
    cascade: Optional[bool] = True


@router.post("/{task_id}/reschedule")
def reschedule_task(task_id: str, body: RescheduleBody, background_tasks: BackgroundTasks,
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Move a task's dates and push whatever waits on it (task_schedule.py).
    The Timeline's drag lands here. The task itself goes through update_task,
    so validation, roles, automation rules and the usual notifications all
    apply; the dependents are then shifted only as far as their dependency
    type demands, each with its own due-history line, event and email.
    Answers {task, moved: [tasks], skipped: [{id, title}]} - `skipped` are
    dependents the caller may not edit, left where they were. The task's own
    move is committed by update_task before the cascade runs, so a cascade
    that fails answers 200 with `cascadeError` and nothing moved: the drag DID
    save, and a 500 would have had the UI say it did not."""
    fields = {k: v for k, v in (("start_on", body.start_on), ("due_on", body.due_on)) if v is not None}
    if not fields:
        raise HTTPException(422, "Nothing to move: send start_on and/or due_on")
    before = _get_task(db, task_id).due_history
    entries_before = len(before) if isinstance(before, list) else 0
    primary = update_task(task_id, TaskUpdate(**fields), background_tasks, user=user, db=db)
    t = _get_task(db, task_id)
    # A Timeline move may push other tasks, which the due-date Undo cannot
    # take back - the entry this move added says where it came from (undo_due).
    hist = list(t.due_history) if isinstance(t.due_history, list) else []
    if len(hist) > entries_before and isinstance(hist[-1], dict) and isinstance(hist[-1].get("undo"), dict):
        hist[-1] = {**hist[-1], "undo": {**hist[-1]["undo"], "via": "reschedule"}}
        t.due_history = hist
        db.commit()
        primary["dueHistory"] = hist
    moved, skipped = [], []
    if body.cascade:
        def _can_edit(d: models.Task) -> bool:
            # The company wall first (Oct 12 review): a manager clears every
            # role check, so without it a link to another company's task
            # would let this drag move that task. Reported as skipped.
            # require_task_role applies the wall itself (Oct 21 2026).
            try:
                require_task_role(db, user, d, "editor")
                return True
            except HTTPException:
                return False
        try:
            moved, skipped = task_schedule.push_dependents(db, t, actor=user["email"], can_edit=_can_edit)
            if moved:
                for d in moved:
                    req = task_due.requester_of(d)
                    if req and req != user["email"].lower():
                        task_notify(db, kind="task_due_changed", for_email=req,
                                    title="Due Date Moved", body=f"{d.title} - moved with {t.title}", task_id=d.id,
                                    nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
                db.commit()
        except Exception as e:   # the dependents' rows are uncommitted; the task's own move stands
            db.rollback()
            detail = e.detail if isinstance(e, HTTPException) else "The tasks waiting on it could not be moved."
            if not isinstance(e, HTTPException):
                logging.getLogger(__name__).exception("reschedule cascade failed for task %s", task_id)
            return {"task": primary, "moved": [], "skipped": [], "cascadeError": detail}
        for d in moved:
            db.refresh(d)
            fire_task_event(d.id, "updated")
            background_tasks.add_task(notify_task_event, d.id, "modified", user["email"],
                                      update_kind=f"Rescheduled after \"{t.title}\" moved", due_changed=True)
    return {"task": primary, "moved": [task_to_dict(d) for d in moved],
            "skipped": [{"id": d.id, "title": d.title} for d in skipped]}


def _due_change_label(t: models.Task, entry: dict) -> str:
    frm, to = entry.get("from") or "", entry.get("to") or ""
    if not frm:
        label = f"Due date set to {task_due.us_date(to)}"
    elif not to:
        label = f"Due date removed (was {task_due.us_date(frm)})"
    else:
        label = f"Due date changed from {task_due.us_date(frm)} to {task_due.us_date(to)}"
    n = int(t.due_extension_count or 0)
    if entry.get("extension"):
        label += f" (extended {n} time{'s' if n != 1 else ''})"
    return label


# ── Due-date negotiation (Neil, Sep 24) ─────────────────────────────────────
# "The requester can set a target date. It is up to the assignee to confirm it,
# or push it out if they deny the timeline, and the two can hash it out." The
# state machine lives in task_due.py; these only check who may do what.
class DueProposal(BaseModel):
    due_on: str
    note: Optional[str] = ""


class DueAnswer(BaseModel):
    accept: bool = False
    note: Optional[str] = ""
    counter_on: Optional[str] = ""   # the requester's own suggestion instead


def _require_assignee(t: models.Task, user: dict) -> str:
    me = (user.get("email") or "").strip().lower()
    if me not in task_assignees(t):
        raise HTTPException(403, "Only the person assigned to this task can answer its due date.")
    if not t.due_on:
        raise HTTPException(409, "This task has no due date.")
    return me


def _due_done(db: Session, t: models.Task) -> dict:
    t.modified_at = now_iso()
    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return task_to_dict(t)


@router.post("/{task_id}/due/confirm")
def confirm_due(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _wall_task(db, user, task_id)
    me = _require_assignee(t, user)
    if (t.due_agreement or "") != "pending":
        raise HTTPException(409, "There is no due date waiting for you to confirm.")
    task_due.confirm(db, t, me)
    return _due_done(db, t)


@router.post("/{task_id}/due/propose")
def propose_due(body: DueProposal, task_id: str, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    t = _wall_task(db, user, task_id)
    me = _require_assignee(t, user)
    # Negotiating is for a target you have not agreed to yet. Once it is yours,
    # moving it is an extension - change the date and it is counted.
    if (t.due_agreement or "") not in ("pending", "proposed"):
        raise HTTPException(409, "This due date is already agreed - change it directly instead.")
    _check_iso_date(body.due_on, "due_on")
    if not body.due_on or body.due_on[:10] == (t.due_on or "")[:10]:
        raise HTTPException(422, "Pick a date different from the current one.")
    task_due.propose(db, t, me, body.due_on[:10], (body.note or "").strip())
    return _due_done(db, t)


@router.post("/{task_id}/due/respond")
def respond_due(body: DueAnswer, task_id: str, user: dict = Depends(get_current_user),
                db: Session = Depends(get_db)):
    t = _wall_task(db, user, task_id)
    me = (user.get("email") or "").strip().lower()
    if (t.due_agreement or "") == task_due.REQUESTED and isinstance(t.due_proposal, dict):
        # An extension waiting for approval (Oct 13 2026): the requester, an
        # assignee's manager, or a manager can say yes or no - no third date.
        allowed = set((t.due_proposal or {}).get("approvers") or []) | set(task_due.approvers_of(db, t))
        if me not in allowed and not is_manager(user):
            raise HTTPException(403, "Only whoever requested this task, or a manager, can approve this extension.")
        if me in task_assignees(t) and not is_manager(user):
            raise HTTPException(403, "You cannot approve an extension on your own task.")
        _respond_and_sync(db, t, me, body.accept, (body.note or "").strip())
        return _due_done(db, t)
    if (t.due_agreement or "") != "proposed" or not isinstance(t.due_proposal, dict):
        raise HTTPException(409, "There is no proposed date to answer.")
    if me != task_due.requester_of(t) and not is_manager(user):
        raise HTTPException(403, "Only whoever requested this task, or a manager, can answer the proposal.")
    counter = (body.counter_on or "")[:10]
    if counter:
        _check_iso_date(counter, "counter_on")
        if counter in ((t.due_on or "")[:10], ((t.due_proposal or {}).get("dueOn") or "")[:10]):
            raise HTTPException(422, "Suggest a date different from both the current and the proposed one.")
    _respond_and_sync(db, t, me, body.accept, (body.note or "").strip(), counter_on=counter)
    return _due_done(db, t)


def _respond_and_sync(db: Session, t: models.Task, me: str, accept: bool, note: str, counter_on: str = "") -> None:
    """task_due.respond, and a date it moved (an approved extension, an
    accepted proposal, a counter) moves a checklist subtask's step too -
    otherwise the step keeps the old date and its next sync moves the task
    back (Oct 22 2026)."""
    before = (t.due_on or "")[:10]
    task_due.respond(db, t, me, accept, note, counter_on=counter_on)
    if (t.due_on or "")[:10] != before:
        import hr_checklists
        hr_checklists.task_due_changed(db, t, me)


class DueUndo(BaseModel):
    at: str     # the due_history entry being undone (its "at")


UNDO_WINDOW_MIN = 10


@router.post("/{task_id}/due/undo")
def undo_due(task_id: str, body: DueUndo, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Undo the caller's own due-date move (Oct 22 2026 - the Calendar drag's
    Undo). A second PATCH back would count the return trip as a move of its
    own (an extension, when the first one moved the date earlier) and bell
    the requester again; this takes the move OUT instead: the dates and the
    negotiation go back to how they were, its history entry and any extension
    it counted are removed, and the bells it raised and its still-queued
    email are withdrawn. Nothing new is sent. Only the latest move, made by
    the caller in the app within UNDO_WINDOW_MIN minutes, with the date
    unchanged since - otherwise 409. A move held for approval is a request;
    Withdraw (/due/withdraw) takes that back."""
    t = _get_task(db, task_id)
    assert_task_wall(db, user, t)
    require_task_role(db, user, t, "editor")
    # Read the history under the row lock: two Undos (or an Undo racing a
    # new move) must not both take the same entry out.
    _lock_task_rows(db, [t.id])
    db.refresh(t)
    me = (user.get("email") or "").strip().lower()
    hist = list(t.due_history) if isinstance(t.due_history, list) else []
    last = hist[-1] if hist and isinstance(hist[-1], dict) else {}
    undo = last.get("undo") if isinstance(last.get("undo"), dict) else None
    try:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(last.get("at") or "")
    except ValueError:
        age = None
    if (not undo or last.get("at") != body.at or (last.get("by") or "").lower() != me
            or age is None or age > timedelta(minutes=UNDO_WINDOW_MIN)
            or (t.due_on or "")[:10] != (last.get("to") or "")[:10]
            or (t.due_agreement or "") == task_due.REQUESTED):
        raise HTTPException(409, "That change can no longer be undone - set the date again instead.")
    if undo.get("via") == "reschedule":
        # A Timeline move may have pushed the tasks waiting on it; taking
        # back only this one would leave them where it pushed them.
        raise HTTPException(409, "A move made on the Timeline can't be undone here - drag it back instead.")
    at = last["at"]
    t.due_on = (last.get("from") or "")[:10]
    if "startTo" in undo and (t.start_on or "") == undo.get("startTo"):
        t.start_on = undo.get("startFrom") or ""
    t.due_agreement = undo.get("agreement") or ""
    t.due_proposal = undo.get("proposal")
    t.due_history = hist[:-1]
    if last.get("extension"):
        t.due_extension_count = max(0, int(t.due_extension_count or 0) - 1)
    task_due._log(db, t, "due_changed", me, f"undid the due date change (back to {task_due.us_date(t.due_on)})"
                  if t.due_on else "undid the due date change (no due date again)")
    # Withdraw what the move told people: the requester's bell, a manager's
    # extension alert, and the "updated" email still waiting in the batch.
    kinds = ("task_due_changed", "task_due_extended")
    db.query(models.TaskNotification).filter(
        models.TaskNotification.task_id == t.id, models.TaskNotification.kind.in_(kinds),
        models.TaskNotification.created_at >= at).delete(synchronize_session=False)
    db.query(models.NexusNotification).filter(
        models.NexusNotification.ref_id == t.id, models.NexusNotification.type.in_([f"task_{k}" for k in kinds]),
        models.NexusNotification.created_at >= at).delete(synchronize_session=False)
    # Only the email that reports THIS move (it carries the entry's "at") -
    # another change the same person made meanwhile keeps its own.
    for q in (db.query(models.TaskEmailQueue)
              .filter(models.TaskEmailQueue.task_id == t.id, models.TaskEmailQueue.event_type == "modified",
                      models.TaskEmailQueue.actor_email == me, models.TaskEmailQueue.status == "pending").all()):
        if isinstance(q.payload, dict) and q.payload.get("due_entry_at") == at:
            q.status, q.drop_reason, q.updated_at = "dropped", "undone", now_iso()
    import hr_checklists
    hr_checklists.task_due_changed(db, t, me)
    return _due_done(db, t)


@router.post("/{task_id}/due/withdraw")
def withdraw_due(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Take back an extension request - whoever asked, or an assignee."""
    t = _wall_task(db, user, task_id)
    me = (user.get("email") or "").strip().lower()
    if (t.due_agreement or "") != task_due.REQUESTED:
        raise HTTPException(409, "There is no extension request to withdraw.")
    if me != ((t.due_proposal or {}).get("by") or "").lower() and me not in task_assignees(t):
        raise HTTPException(403, "Only whoever asked for this extension can withdraw it.")
    task_due.withdraw_extension(db, t, me)
    return _due_done(db, t)


def _live_descendants(db: Session, root_ids: list) -> list[models.Task]:
    """Every LIVE task under `root_ids` - subtasks, their subtasks, and so on -
    walking parent_task_id down a level at a time. The roots themselves are
    not included. Cycle-safe: a task is visited once however the data loops.
    Trashed rows are invisible to the query, so a branch already in the bin
    is not walked into."""
    seen = set(i for i in root_ids if i)
    frontier = list(seen)
    out: list[models.Task] = []
    while frontier:
        kids = db.query(models.Task).filter(models.Task.parent_task_id.in_(frontier)).all()
        frontier = []
        for k in kids:
            if k.id in seen:
                continue
            seen.add(k.id)
            out.append(k)
            frontier.append(k.id)
    return out


def restore_task_tree(db: Session, t: models.Task, now: str) -> list[models.Task]:
    """Take a trashed task out of the Recycle Bin with exactly what was binned
    WITH it (Oct 21 2026) - shared by POST /tasks/{id}/restore and the
    Recycle Bin's restore (routers/task_projects.py), so the two cannot drift.

    "With it" is deleted_with == this task (delete_task stamps its whole
    subtree). A direct subtask binned before that stamp existed counts when it
    went in the very same delete - its deleted_at is the identical stamp.
    A subtask somebody deleted separately earlier stays in the bin.

    The task goes back into its parent's subtask list if that parent is live
    (delete_task cut it out), and each restored subtask is back on its own
    parent's list. Returns the restored rows other than `t`. Does not commit.

    A subtask whose parent is itself still in the Recycle Bin is refused
    (409): brought back alone it would be live under a parent nobody can see,
    so it would show up nowhere. One whose parent is gone for good (purged)
    comes back as a top-level task for the same reason."""
    parent_gone = False
    if t.parent_task_id:
        parent_row = (db.query(models.Task).execution_options(include_deleted=True)
                      .filter(models.Task.id == t.parent_task_id).first())
        if parent_row is not None and parent_row.deleted_at:
            raise HTTPException(409, "Restore its parent task first - it is in the Recycle Bin.")
        parent_gone = parent_row is None
    stamp = t.deleted_at or ""
    q = db.query(models.Task).execution_options(include_deleted=True)
    rows = q.filter(models.Task.deleted_with == t.id, models.Task.deleted_at != "").all()
    if stamp:
        rows += q.filter(models.Task.parent_task_id == t.id, models.Task.deleted_at == stamp,
                         (models.Task.deleted_with == "") | (models.Task.deleted_with.is_(None))).all()
    back = {r.id: r for r in rows if r.id != t.id}
    for row in [t, *back.values()]:
        row.deleted_at = ""
        row.deleted_by = ""
        row.deleted_with = ""
        row.modified_at = now
    if parent_gone:
        t.parent_task_id = ""
    # Re-link each one into its parent's list. A parent restored in this same
    # call is still binned in the database (nothing is flushed yet), so the
    # rows in hand are looked at first.
    in_hand = {t.id: t, **back}
    for row in [t, *back.values()]:
        if not row.parent_task_id:
            continue
        parent = in_hand.get(row.parent_task_id) or (
            db.query(models.Task).filter(models.Task.id == row.parent_task_id).first())
        if parent is not None and row.id not in (parent.subtask_ids or []):
            parent.subtask_ids = list(parent.subtask_ids or []) + [row.id]
            parent.modified_at = now
    return list(back.values())


@router.delete("/{task_id}", status_code=204)
def delete_task(task_id: str, background_tasks: BackgroundTasks,
                user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Move to Trash - REVERSIBLE (Aug 27). Marks the task instead of dropping
    the row, so POST /tasks/{id}/restore can bring it back exactly as it was
    for NEXUS_TASK_TRASH_RETENTION_DAYS (default 90) - see GET /tasks/deleted
    and task_util.purge_task_permanently for what happens after that window.

    Parent/dependency links still detach immediately, same as before soft
    delete existed: a trashed task is invisible to every query (the
    do_orm_execute hook in database.py), so a dangling blockedByIds/
    subtaskIds entry left pointing at it would read as a broken reference on
    the tasks LEFT BEHIND, not as "this one's in the trash". Restore brings
    the task back into its parent's subtask list (restore_task_tree), not the
    severed dependency links."""
    t = _get_task(db, task_id)
    # company wall: another company's task is 404
    assert_task_wall(db, user, t)
    # The assignee counts on their own task here too. Note this cascade takes
    # the task's SUBTASKS with it (below), which may be assigned to other
    # people - deleting your own task can therefore remove someone else's.
    require_task_role(db, user, t, "editor")
    # Captured before the row is hidden - notify_task_event("deleted") runs in
    # the background AFTER this response, by which point the global
    # soft-delete filter already hides it, so there'd be nothing left to
    # look up.
    deleted_snapshot = {
        "code": t.code, "title": t.title, "status": t.status, "priority": t.priority,
        "assignee_email": t.assignee_email or "", "assignee_emails": task_assignees(t),
        "follower_emails": list(t.follower_emails or []),
        "created_by": t.created_by or "", "project_id": t.project_id or "", "due_on": t.due_on or "",
    }
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
    # Trash the WHOLE subtree with it (Oct 21 2026 - only the direct subtasks
    # went before, leaving grandchildren live under a binned parent, where no
    # list can show them). Each one is stamped deleted_with = this task, the
    # way a project bins its tasks: restore brings back exactly that set, and
    # the Recycle Bin lists only this task, not every step under it. A
    # subtask trashed on its own earlier is already gone from the live tree,
    # so it is not swept in and keeps its own bin entry. trash_purge_loop
    # still purges each row independently.
    subs = _live_descendants(db, [task_id])
    gone_ids = [task_id] + [sub.id for sub in subs]
    # Tombstone every id going to trash, in this same transaction - a delta
    # fetch (GET /tasks/delta) otherwise can't tell "gone" apart from
    # "unchanged, just not modified in this window".
    deleted_stamp = now_iso()
    for gid in gone_ids:
        db.add(models.TaskDeleteLog(id=gen_id(), task_id=gid, deleted_at=deleted_stamp))
    for row in [t, *subs]:
        row.deleted_at = deleted_stamp
        row.deleted_by = user["email"]
        row.modified_at = deleted_stamp
        row.deleted_with = task_id if row is not t else ""   # the task itself is its own bin entry
    # A timer still running on a trashed task would otherwise sit there
    # unstoppable and block that person's next Start; close it with the trash.
    for e in (db.query(models.TaskTimeEntry)
                .filter(models.TaskTimeEntry.task_id.in_(gone_ids), models.TaskTimeEntry.ended_at == "").all()):
        _stop_entry(db, e)
    log_activity(db, type="deleted", actor_email=user["email"], entity_id=task_id,
                 entity_code=t.code, entity_title=t.title, detail="moved this task to Trash")
    db.commit()
    fire_task_event(task_id, "deleted")
    background_tasks.add_task(notify_task_event, task_id, "deleted", user["email"], snapshot=deleted_snapshot)


# Manager = role level 3+, the same bar auth.require_manager enforces as a
# dependency. Needed as a plain predicate here because these endpoints admit
# TWO kinds of caller and so cannot gate at the signature.
def _is_manager_user(user: dict) -> bool:
    return (user.get("level") or 0) >= 3


def _may_untrash(user: dict, t: models.Task) -> bool:
    """Who can restore or permanently delete THIS trashed task.

    A manager, workspace-wide - or the person who deleted it. That second case
    is the point (Neil, Sept 8): the undo toast is gone within seconds, and a
    mistake you made yourself should not need somebody else's permission to fix.

    The direct ASSIGNEE counts too (Neil, Sept 9): somebody else deleting a task
    off your plate is precisely when you need it back, and having to find a
    manager for that is the friction this exists to remove. Followers and
    project members do not - "on my list" is the line, not "can see it".
    """
    me = (user.get("email") or "").lower()
    return (_is_manager_user(user)
            or (t.deleted_by or "").lower() == me
            or me in task_assignees(t))


@router.get("/deleted")
def list_deleted_tasks(scope: str = "", user: dict = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    """The Recycle Bin.

    `scope=mine` is the surface OUTSIDE Manage: what YOU deleted, plus anything
    you were the direct assignee of. Deliberately NOT widened for managers
    (Neil, Sept 9) - a Global Admin opening their own bin was handed the whole
    company's deletions, which is the Manage view wearing the wrong name. Role
    decides what Manage shows; it does not decide what "mine" means.

    No scope = the Manage view: the whole workspace, manager-only.

    Assignee as well as deleter, because the person whose work it was is the one
    who notices it has gone - somebody else deleting a task off your plate is
    exactly the case where you need to get it back. Direct assignee only: a
    follower or a project member is not "their" task in the sense that matters
    here. Newest-deleted first."""
    days = _trash_retention_days()
    q = (db.query(models.Task).execution_options(include_deleted=True)
         .filter(models.Task.deleted_at != ""))
    mine = (scope or "").lower() == "mine"
    if not mine and not _is_manager_user(user):
        raise HTTPException(403, "Only a manager can see the whole workspace's Recycle Bin.")
    rows = q.order_by(models.Task.deleted_at.desc()).all()
    if mine:
        me = (user.get("email") or "").lower()
        rows = [t for t in rows
                if (t.deleted_by or "").lower() == me or me in task_assignees(t)]
    rows = wall_tasks(db, user, rows)   # company wall first
    out = []
    for t in rows:
        d = task_to_dict(t)
        d["deletedAt"] = t.deleted_at or ""
        d["deletedBy"] = t.deleted_by or ""
        purge_at = _iso_plus_days(t.deleted_at, days) if t.deleted_at else ""
        d["purgeAt"] = purge_at
        out.append(d)
    return out


@router.post("/{task_id}/restore")
def restore_task(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Put a trashed task - and the subtasks trashed alongside it - back,
    exactly as they were (restore_task_tree). The task rejoins its parent's
    subtask list when that parent is live; dependency links severed at delete
    time are NOT re-attached (delete_task's docstring explains why they were
    cut) - reconnect them by hand if the task needs them again."""
    t = (db.query(models.Task).execution_options(include_deleted=True)
           .filter(models.Task.id == task_id).first())
    if not t:
        raise HTTPException(404, "Task not found")
    # company wall: another company's trashed task is 404
    assert_task_wall(db, user, t)
    if not _may_untrash(user, t):
        raise HTTPException(403, "Only a manager, or whoever deleted it, can restore this task.")
    if not t.deleted_at:
        return task_to_dict(t)
    restore_task_tree(db, t, now_iso())
    log_activity(db, type="restored", actor_email=user["email"], entity_id=task_id,
                 entity_code=t.code, entity_title=t.title, detail="restored this task from Trash")
    db.commit()
    db.refresh(t)
    # A restore reappears in the next delta fetch the same way any other
    # update does (modified_at just moved past `since`) - no special-cased
    # "undelete" event for clients to handle.
    fire_task_event(task_id, "restored")
    return task_to_dict(t)


@router.delete("/{task_id}/permanent", status_code=204)
def delete_task_permanent(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Empty one item from Trash early, instead of waiting out the retention
    window. Irreversible - unlike DELETE /tasks/{id}, there is no undo."""
    t = (db.query(models.Task).execution_options(include_deleted=True)
           .filter(models.Task.id == task_id).first())
    if t:
        # company wall: another company's trashed task is 404
        assert_task_wall(db, user, t)
        if not _may_untrash(user, t):
            raise HTTPException(403, "Only a manager, or whoever deleted it, can permanently delete this task.")
    if not purge_task_permanently(db, task_id, actor_email=user["email"]):
        raise HTTPException(404, "That task isn't in the trash")
    db.commit()


class BulkDates(BaseModel):
    """A date change worked out PER TASK on the server (Oct 22 2026, the
    batch bar's Dates action): each task moves from its own stored date, read
    under the row lock, never from what the browser last saw.
      shift      `days` whole days (+/-) on both start and due; with
                 `skip_weekends` they are business days and land on a weekday.
                 A task without a due date is skipped.
      set_due    due date = `on`        set_start  start date = `on`
      clear_due  no due date"""
    op: str
    days: int = 0
    skip_weekends: bool = False
    on: str = ""


class BulkUpdate(BaseModel):
    ids: list[str]
    patch: dict[str, Any] = {}
    # Sent instead of `patch`. The answer is then {tasks, changed, skipped,
    # sentForApproval} - `tasks` is the list every other bulk call answers with.
    dates: Optional[BulkDates] = None


_BULK_DATE_OPS = ("shift", "set_due", "set_start", "clear_due")
_MAX_SHIFT_DAYS = 3650


def _shift_day(iso: str, days: int, skip_weekends: bool) -> str:
    """`iso` moved `days` days. With `skip_weekends`, `days` counts weekdays
    only, so the result is always a Monday-Friday (a Saturday +1 is Monday)."""
    d = date.fromisoformat(iso[:10])
    if not skip_weekends:
        return (d + timedelta(days=days)).isoformat()
    step = 1 if days > 0 else -1
    left = abs(days)
    while left:
        d += timedelta(days=step)
        if d.weekday() < 5:
            left -= 1
    return d.isoformat()


def _check_bulk_dates(dates: BulkDates) -> None:
    if dates.op not in _BULK_DATE_OPS:
        raise HTTPException(422, f"Unknown date change {dates.op!r}.")
    if dates.op == "shift" and not (0 < abs(dates.days) <= _MAX_SHIFT_DAYS):
        raise HTTPException(422, f"Shift by 1 to {_MAX_SHIFT_DAYS} days, earlier or later.")
    if dates.op in ("set_due", "set_start"):
        if not dates.on:
            raise HTTPException(422, "Pick a date.")
        _check_iso_date(dates.on, "on")


def _bulk_date_changes(db: Session, dates: BulkDates, rows: list) -> tuple[dict, int, list]:
    """{task id: {field: new value}} for the rows the change moves, how many a
    shift skipped for having no due date, and the rows left alone for a
    reason ([{id, title, code, reason}]): a repeating task that would land on
    or before its previous occurrence (_series_order_problem), or a stored due
    date that cannot be read. A start date that cannot be read is treated as
    no start - the due date still moves."""
    out, skipped, blocked = {}, 0, []
    series: dict = {}   # the recurring rows, loaded once for the batch

    def _shift(iso: str) -> str:
        try:
            return _shift_day(iso, dates.days, dates.skip_weekends)
        except OverflowError:
            raise HTTPException(422, f"{t.title}: that shift goes past the end of the calendar.")

    for t in rows:
        due, start = (t.due_on or "")[:10], (t.start_on or "")[:10]
        if dates.op == "shift":
            if not due:
                skipped += 1
                continue
            try:
                ch = {"due_on": _shift(due)}
            except ValueError:
                blocked.append({"id": t.id, "title": t.title or "", "code": "unreadable",
                                "reason": "Its due date could not be read."})
                continue
            if start:
                try:
                    ch["start_on"] = _shift(start)
                except ValueError:
                    pass        # an unreadable start: treated as no start
        elif dates.op == "set_due":
            ch = {"due_on": dates.on[:10]} if due != dates.on[:10] else {}
        elif dates.op == "set_start":
            ch = {"start_on": dates.on[:10]} if start != dates.on[:10] else {}
        else:   # clear_due
            if due and _clearing_stops_series(t):
                blocked.append({"id": t.id, "title": t.title or "", "code": "series", "reason": SERIES_NEEDS_DUE})
                continue
            ch = {"due_on": ""} if due else {}
        if ch:
            out[t.id] = ch
    # A repeating task must keep its place in its series - judged against
    # the NEW dates of its siblings in this batch. Leaving one out changes
    # what the others are judged against, so it runs until nothing new is
    # left out (each round leaves at least one out, or stops).
    by_id = {t.id: t for t in rows}
    while True:
        moving = {i: ch["due_on"] for i, ch in out.items() if ch.get("due_on")}
        stuck = []
        for i, nd in moving.items():
            problem = _series_order_problem(db, by_id[i], nd, series, moving)
            if problem:
                stuck.append({"id": i, "title": by_id[i].title or "", "code": "series", "reason": problem})
        if not stuck:
            break
        for b in stuck:
            out.pop(b["id"], None)
        blocked += stuck
    return out, skipped, blocked


_BULK_ALLOWED = {"status", "priority", "assignee_email", "assignee_emails", "team_id", "project_id",
                 "completed", "tags", "due_on", "start_on", "is_milestone", "custom_field_values",
                 # A project's own sections (Custom grouping, Oct 13 2026): the
                 # batch bar's Move to Section.
                 "section_id"}


def _merge_custom_field_values(db: Session, current, change) -> dict:
    """A task's custom-field values after a bulk edit (Oct 13 2026: Property
    and the other custom columns could not be set on several tasks at once).

    `change` is {field_id: value} for just the fields being set - it is MERGED
    into each task's own values, never written over them, so setting Property
    on twenty tasks keeps whatever else each one carries. An empty value ("",
    None, []) clears that field. The rest goes through the same coercion a
    single edit does, so a bulk value lands in the same shape."""
    merged = dict(current or {}) if isinstance(current, dict) else {}
    if not isinstance(change, dict):
        return merged
    clears = [fid for fid, v in change.items() if v in ("", None) or v == []]
    for fid in clears:
        merged.pop(fid, None)
    merged.update(coerce_custom_field_values(db, {k: v for k, v in change.items() if k not in clears}))
    return merged


def _blockers_first(rows: list, completing) -> list:
    """`rows` with every task after the in-batch tasks that block it
    (Kahn's algorithm over blocked_by_ids edges whose blocker is in the batch
    and being completed - `completing(row)` says which), otherwise in their
    given order. Tasks caught in a loop among themselves come last: none of
    them can be assumed done first, so the gate refuses them. Linear in the
    batch and its edges."""
    by_id = {t.id: t for t in rows}
    done_ids = {t.id for t in rows if completing(t)}
    waits: dict = {t.id: 0 for t in rows}
    unblocks: dict = {t.id: [] for t in rows}
    for t in rows:
        for b in dict.fromkeys(i for i in (t.blocked_by_ids or []) if i):
            if b in done_ids and b != t.id:
                waits[t.id] += 1
                unblocks[b].append(t.id)
    ready = [t.id for t in rows if waits[t.id] == 0]
    order, i = [], 0
    while i < len(ready):
        tid = ready[i]
        i += 1
        order.append(tid)
        for d in unblocks[tid]:
            waits[d] -= 1
            if waits[d] == 0:
                ready.append(d)
    placed = set(order)
    order += [t.id for t in rows if t.id not in placed]
    return [by_id[x] for x in order]


@router.post("/bulk")
def bulk_update(body: BulkUpdate, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    patch = {k: v for k, v in (body.patch or {}).items() if k in _BULK_ALLOWED}
    # Same validation update_task applies. Without it bulk was a way around it:
    # an arbitrary status set here still created a phantom board column.
    validate_task_payload(db, patch)
    dates = body.dates
    locked: set = set()
    if dates is not None:
        if patch:
            raise HTTPException(422, "Change dates on their own, not together with other fields.")
        _check_bulk_dates(dates)
    rows = db.query(models.Task).filter(models.Task.id.in_(body.ids)).all()
    # The company wall, all-or-nothing like the editor check below (Oct 21
    # 2026). A manager clears every role check, so without this one batch
    # could reassign or close another company's tasks by id. 404, as for one
    # task: the caller learns nothing about which ids exist over the wall.
    import auth
    scope = auth.company_scope(user, db)   # once for the batch
    if len(wall_tasks(db, user, rows, scope=scope)) != len(rows):
        raise HTTPException(404, "Task not found")
    # Same editor requirement update_task enforces per task. Without this, bulk
    # was a straight bypass of it: _BULK_ALLOWED covers assignee, project,
    # completed and due date, so anyone who could merely VIEW a task could
    # reassign or close it by routing through here instead of PATCH.
    # All-or-nothing on purpose - a partial apply would leave the caller with no
    # way to tell which ids were silently skipped.
    seen: dict = {}   # an external's visible projects, worked out once for the batch
    for t in rows:
        require_task_role(db, user, t, "editor", scope=scope, visible_cache=seen)
    # The rest of what a single PATCH checks (Oct 21 2026), all before any row
    # is written so the batch stays all-or-nothing: editor on the project the
    # tasks are moved into, newly added assignees are directory people on each
    # task's side of the wall, and no required custom field is left empty by
    # this edit (see _newly_missing_required for what is NOT refused).
    dest = (patch.get("project_id") or "") if "project_id" in patch else ""
    if dest and any((t.project_id or "") != dest for t in rows):
        _require_destination_projects(db, user, [dest])
    for t in rows:
        current = task_assignees(t)
        wanted = _assignees_from(patch, list(current))
        _require_people(db, t, [w for w in (wanted or []) if w not in current], actor=user["email"],
                        user=user)
        if "custom_field_values" in patch or "project_id" in patch:
            project_after = (patch["project_id"] if "project_id" in patch else t.project_id) or ""
            values_after = (_merge_custom_field_values(db, t.custom_field_values, patch["custom_field_values"])
                            if "custom_field_values" in patch else (t.custom_field_values or {}))
            missing = _newly_missing_required(db, t, t.project_id or "", t.custom_field_values or {},
                                              project_after, values_after)
            if missing:
                raise HTTPException(422, f"{t.title}: {_required_message(db, missing, project_after)}")
    if dates is not None:
        # Each task moves from ITS OWN date, so once the walls and roles have
        # passed the rows are locked (id order, the module's lock order -
        # _lock_task_rows; nothing is locked or written before it) and read
        # again under the lock: two shifts at once queue up instead of both
        # starting from the same old date. A date change takes no code counter.
        locked.update(_lock_task_rows(db, body.ids))
        rows = db.query(models.Task).filter(models.Task.id.in_(body.ids)).populate_existing().all()
    if "status" in patch or "completed" in patch:
        # Same-batch dependencies (Oct 21 2026): when A blocks B and both are
        # completed in this one call, A counts as done for B's gate once A has
        # passed its OWN gate. The batch is put in blocker-first order over
        # its in-batch edges (_blockers_first) and gated in one pass; a task
        # whose in-batch blocker has not passed - a loop among them included -
        # refuses the whole batch with the usual 400. A single PATCH is
        # unchanged.
        done_in_batch: set = set()
        for t in _blockers_first(rows, lambda r: _resolve_completed(patch, bool(r.completed)) and not r.completed):
            prev_status, prev_completed = t.status, bool(t.completed)
            new_status = patch.get("status", prev_status)
            new_completed = bool(patch.get("completed", prev_completed)) or (patch.get("status") == "completed")
            _check_dependency_gate(db, t, prev_status, prev_completed, new_status, new_completed,
                                   assume_done=frozenset(done_in_batch))
            if new_completed and not prev_completed:
                done_in_batch.add(t.id)
    # Lock order (Oct 21 2026, see _lock_task_rows). Only when this call will
    # roll a series forward: the rows that will roll and the rows each one
    # writes besides itself (its parent occurrence, its subtasks) are locked
    # HERE, in id order, before the HR checklist landing below writes rows and
    # before any next occurrence takes the task-code counter. A patch that
    # completes nothing recurring takes no locks up front, as before.
    def _will_roll(r, completing: bool) -> bool:
        rec = r.recurrence if isinstance(r.recurrence, dict) else {}
        return bool(completing and rec.get("freq") and not rec.get("nextOccurrenceId"))

    def _lock_rolling(heads) -> None:
        ids = set()
        for h in heads:
            ids |= {h.id, *_spawn_write_ids(db, h)}
        if ids - locked:
            _lock_task_rows(db, ids - locked)
            locked.update(ids)
    _lock_rolling([t for t in rows if _will_roll(t, _resolve_completed(patch, bool(t.completed)) and not t.completed)])
    # Captured before the patch lands so the activity entries below can say what
    # actually changed rather than restating the new value for every row.
    before = {t.id: (t.status, bool(t.completed), tuple(task_assignees(t))) for t in rows}
    before_due = {t.id: (t.due_on or "")[:10] for t in rows}
    before_start = {t.id: t.start_on or "" for t in rows}
    # The Dates action's per-task values (only the moved rows have an entry).
    # A recurring occurrence moves alone: its rule is never touched.
    row_dates, skipped, blocked = _bulk_date_changes(db, dates, rows) if dates is not None else ({}, 0, [])
    held_count = 0
    auto_before = {t.id: task_automation.snapshot(t) for t in rows}
    auto_results: list = []
    auto_changed: dict[str, dict] = {}   # task id -> fields the rules wrote on that row
    for t in rows:
        prev_status, prev_completed, _ = before[t.id]
        # Decided BEFORE the loop writes anything, from the payload and the
        # previous value - the same call update_task makes. `status` used to
        # fall through to the setattr below, so bulk-setting it to "completed"
        # left the flag off (no strikethrough, still emailed as overdue), and
        # bulk-setting it to anything else left a completed task stuck in the
        # Completed bucket. Which of the two won even depended on dict order.
        new_completed = _resolve_completed(patch, prev_completed)
        for k, v in patch.items():
            if k == "completed":
                continue    # handled by _apply_completion below
            if k in ("assignee_email", "assignee_emails"):
                continue    # applied together, below
            if k == "custom_field_values":
                # Merged into this task's own values - see
                # _merge_custom_field_values. A new dict, so the JSON column
                # registers the change.
                t.custom_field_values = _merge_custom_field_values(db, t.custom_field_values, v)
                continue
            setattr(t, k, v)
        for k, v in row_dates.get(t.id, {}).items():
            setattr(t, k, v)
        # Same rule as the single PATCH: dragging 20 cards out of Not Started on
        # the board is 20 tasks starting today, and they must not need a second
        # pass through the Timeline cell to say so.
        _autostamp_start(t, prev_status, t.status or "")
        bulk_assignees = _assignees_from(patch, list(before[t.id][2]))
        if bulk_assignees is not None:
            set_task_assignees(t, bulk_assignees)
        # A section and a team both belong to ONE project, so carrying either
        # across a move leaves the task pointing at a section the destination
        # does not have - it then renders under a phantom group that no board
        # can show or clear. Done here rather than in the client so no caller
        # can skip it (the drawer's single-task picker clears team_id by hand;
        # bulk moves 31 rows at a time and must not depend on remembering).
        # An explicit team_id in the same patch still wins.
        if "project_id" in patch:
            t.section_id = ""
            if "team_id" not in patch:
                t.team_id = ""
            # Same re-clean update_task does: the primary must never also sit
            # in the "also in" extras list.
            t.project_ids = _extra_project_ids(t.project_ids, t.project_id or "")
        # Same engine pass update_task makes, per row - a rule on "status
        # changes to X" fires whether twenty cards were dragged or one.
        auto = task_automation.run_for_change(
            db, t, event="bulk", before=auto_before[t.id], completed=new_completed,
            gate=lambda ps, pc, ns, nc, _t=t: _check_dependency_gate(db, _t, ps, pc, ns, nc))
        if auto.changed:
            auto_changed[t.id] = auto.changed
            new_completed = _resolve_completed({**patch, **auto.changed}, prev_completed)
        if auto.after_commit:
            auto_results.append(auto)
        # The shared completion path (flag + HR checklist), as update_task.
        _land_completion(db, t, new_completed, prev_completed, user["email"])
        t.modified_at = now_iso()

    # The FINAL state, after the automation rules (Oct 21 2026). A rule may
    # have reopened a task the gate above counted as done for its dependent,
    # or completed one nobody asked for: every row whose status or completion
    # moved is gated again against what the batch now really holds (rows in
    # the batch read back as they stand in this request). Still all or
    # nothing - the raise drops the whole uncommitted batch.
    for t in rows:
        prev_status, prev_completed, _ = before[t.id]
        if t.status != prev_status or bool(t.completed) != prev_completed:
            _check_dependency_gate(db, t, prev_status, prev_completed, t.status or "", bool(t.completed))
    # ...and a recurring row a rule completed is locked (with its extra rows)
    # now, before any next occurrence below takes the task-code counter.
    _lock_rolling([t for t in rows if _will_roll(t, bool(t.completed) and not before[t.id][1])])

    # Activity + notifications. Bulk previously did NEITHER: reassigning fifty
    # tasks told nobody and left no audit trail, while the same edit made one at
    # a time through PATCH did both.
    #
    # Activity is per task (it's an audit trail - one row per thing that
    # changed), but the bell notification is AGGREGATED per person: fifty
    # separate "you were assigned a task" pings for one action is the failure
    # mode CLAUDE.md warns about ("one notification per workflow, never one per
    # item"). Email goes through the batch queue only - see the end of this function.
    actor = (user["email"] or "").lower()
    newly_assigned: dict[str, list] = {}
    ext_asks: dict[str, list] = {}
    due_moved_for: dict[str, list] = {}   # requester -> tasks whose due date moved
    for t in rows:
        prev_status, prev_completed, prev_assignees = before[t.id]
        acts = list(t.activity_ids or [])
        if ("status" in patch or "status" in auto_changed.get(t.id, {})) and t.status != prev_status:
            acts.append(log_activity(db, type="status_changed", actor_email=user["email"],
                                     entity_id=t.id, entity_code=t.code, entity_title=t.title,
                                     detail=f"changed status to {t.status}"))
        now_assignees = set(task_assignees(t))
        if now_assignees != set(prev_assignees):
            acts.append(log_activity(db, type="assignee_changed", actor_email=user["email"],
                                     entity_id=t.id, entity_code=t.code, entity_title=t.title,
                                     detail="reassigned this task"))
            # Only the people newly added, and still aggregated per person, so a
            # fifty-task reassignment is one ping each rather than fifty.
            for who in (now_assignees - set(prev_assignees)):
                if who != actor:
                    newly_assigned.setdefault(who, []).append(t)
            # Bulk-assigning is assigning: the person who did it follows each
            # task they put on someone else's plate, exactly as PATCH does.
            if (now_assignees - set(prev_assignees)) and "follower_emails" not in patch:
                _follow_as_actor(t, actor)
        if t.completed and not prev_completed:
            acts.append(_log_completed(db, t, user["email"]))
        t.activity_ids = acts
        # After activity_ids is rebuilt - task_due appends its own entries.
        # Logged and counted like a single edit, but no per-row email (see above).
        auto_due = "due_on" in auto_changed.get(t.id, {})
        sent = {**patch, **row_dates.get(t.id, {})}
        ask = (task_due.needs_approval(db, t, before_due[t.id], t.due_on or "", actor, privileged=is_manager(user))
               if "due_on" in sent and not auto_due else [])
        if auto_due:
            task_due.record_due_change(db, t, before_due[t.id], t.due_on or "",
                                       actor=task_automation.AUTOMATION_ACTOR, source="automation")
        elif ask:
            # Held for approval like a single edit; the approvers get one bell
            # for the whole batch, below. A start date moved with it waits
            # too, and moves on approval (see update_task).
            wanted_due = (t.due_on or "")[:10]
            t.due_on = before_due[t.id]
            wanted_start = ""
            if "start_on" in sent:
                if (t.start_on or "") != before_start[t.id]:
                    wanted_start = t.start_on or ""
                t.start_on = before_start[t.id]
            task_due.request_extension(db, t, actor, wanted_due, ask, notify=False, start_on=wanted_start)
            held_count += 1
            for who in ask:
                ext_asks.setdefault(who, []).append(t)
        elif "due_on" in sent:
            entry = task_due.record_due_change(db, t, before_due[t.id], t.due_on or "", actor=actor,
                                               source="bulk")
            req = task_due.requester_of(t)
            if entry is not None and req and req != actor:
                due_moved_for.setdefault(req, []).append((t, entry))
        elif now_assignees != set(prev_assignees) and t.due_on:
            task_due.settle_agreement(t, actor)
        # A checklist subtask's step follows its due date - after the approval
        # decision, so a held date moves nothing (Oct 22 2026).
        if (t.due_on or "")[:10] != (auto_before[t.id].get("due_on") or ""):
            import hr_checklists
            hr_checklists.task_due_changed(db, t, user["email"])

    # Completing in bulk is completing (Oct 21 2026): each recurring task rolls
    # forward and each ticket's task tells its ticket, through the same
    # _after_completed a single completion runs - before, a periodic task
    # completed here simply ended its series. Every check above already
    # passed, so nothing here can refuse part of the batch. The rows were
    # locked above, before any write.
    #
    # Main tasks before their subtasks: a subtask's next copy belongs under
    # the main task's NEW occurrence, and one completed alongside it moves
    # there as an open subtask would - the same result as completing the main
    # task first and the subtask after (carry_open).
    #
    # Bells once for the batch: "Recurring Task Due" one per person, a
    # ticket's "All Tasks ... Done" one per ticket.
    completing = [t for t in rows if t.completed and not before[t.id][1]]
    batch_ids = {t.id for t in completing}
    by_id_batch = {t.id: t for t in completing}

    def _depth(t):
        d, seen, cur = 0, {t.id}, t
        while cur.parent_task_id in by_id_batch and cur.parent_task_id not in seen:
            seen.add(cur.parent_task_id)
            cur = by_id_batch[cur.parent_task_id]
            d += 1
        return d
    completing.sort(key=lambda t: (_depth(t), t.id))
    next_due_for: dict[str, list] = {}
    made: dict = {}   # occurrences made in this call, for the subtasks after them (_task_by_id)
    for t in completing:
        nxt = _after_completed(db, t, user, before[t.id][1], notify=False, carry_open=frozenset(batch_ids),
                               pending=made)
        if nxt is not None:
            made[nxt.id] = nxt
            for who in task_assignees(nxt):
                if who != actor:
                    next_due_for.setdefault(who, []).append(nxt)
    for who, occurrences in next_due_for.items():
        _recurring_due_bell(db, who, occurrences)
    tickets = {t.source_ticket_id for t in completing if t.source_ticket_id}
    for tk in (db.query(models.TaskTicket).filter(models.TaskTicket.id.in_(tickets)).all() if tickets else []):
        if any(t.source_ticket_id == tk.id and tk.linked_task_id != t.id for t in completing):
            _tell_ticket_all_done(db, tk, actor, batch_ids)

    for email, assigned in newly_assigned.items():
        # One task through bulk is the same action as one through PATCH, so it
        # reads identically; more than one collapses into a single ping.
        if len(assigned) == 1:
            one = assigned[0]
            task_notify(db, kind="task_assigned", for_email=email,
                        title="You Were Assigned a Task",
                        body=f"{one.title}", task_id=one.id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
        else:
            task_notify(db, kind="task_assigned", for_email=email,
                        title=f"You Were Assigned {len(assigned)} Tasks",
                        body=", ".join(t.title or "Untitled task" for t in assigned[:5])
                             + (f" and {len(assigned) - 5} more" if len(assigned) > 5 else ""),
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View tasks"})
    for email, asked in ext_asks.items():
        if email == actor:
            continue
        one = asked[0] if len(asked) == 1 else None
        task_notify(db, kind="task_due_extension_requested", for_email=email,
                    title="Extension Needs Your Approval" if one else f"{len(asked)} Extensions Need Your Approval",
                    body=(f"{one.title} - {task_due.us_date(one.due_on)} → "
                          f"{task_due.us_date((one.due_proposal or {}).get('dueOn') or '')}") if one
                         else ", ".join(t.title or "Untitled task" for t in asked[:5])
                              + (f" and {len(asked) - 5} more" if len(asked) > 5 else ""),
                    task_id=one.id if one else "",
                    nexus_action={"view": "tasks", "sub": "mine", "label": "Review"})
    # The requester hears about a moved due date as on a single edit - once
    # per person for the whole batch (Oct 22 2026).
    for email, moved in due_moved_for.items():
        extended = all(e.get("extension") for _, e in moved)
        if len(moved) == 1:
            one, entry = moved[0]
            title = "Due Date Extended" if entry.get("extension") else "Due Date Changed"
            text = f"{one.title} - {_due_change_label(one, entry)}"
        else:
            one = None
            title = f"{len(moved)} Due Dates {'Extended' if extended else 'Changed'}"
            text = (", ".join(t.title or "Untitled task" for t, _ in moved[:5])
                    + (f" and {len(moved) - 5} more" if len(moved) > 5 else ""))
        task_notify(db, kind="task_due_changed", for_email=email, title=title, body=text,
                    task_id=one.id if one else "",
                    nexus_action={"view": "tasks", "sub": "mine", "label": "View task" if one else "View tasks"})

    db.commit()
    # With batching on (task_notify.flush_batches), each newly assigned person
    # now gets ONE email for the whole bulk assignment instead of none at all.
    if newly_assigned:
        import task_notify as task_mail
        task_mail.queue_bulk_assignments(db, actor, newly_assigned)
    # Comments the rules asked for. No BackgroundTasks on this endpoint; it is a
    # sync def, so the inline emails run on a threadpool thread, not the loop.
    for auto in auto_results:
        task_automation.run_after_commit(db, auto)
    fire_task_event("", "bulk")
    out = [task_to_dict(t) for t in rows]
    if dates is None:
        return out
    changed = sum(1 for t in rows if (t.due_on or "")[:10] != before_due[t.id]
                  or (t.start_on or "") != before_start[t.id])
    return {"tasks": out, "changed": changed, "skipped": skipped, "sentForApproval": held_count,
            "blocked": len(blocked), "blockedTasks": blocked}


# ── Comments ─────────────────────────────────────────────────────────────────
class CommentCreate(BaseModel):
    body: str
    parent_id: Optional[str] = ""        # reply in this comment's thread (Oct 2026)
    assignee_email: Optional[str] = ""   # make the comment an action item for this person
    # No author_email. create_comment() accepts one so the Asana importer and the
    # inbound-email ingester can attribute a backfilled comment to whoever
    # actually wrote it - but both call that function in-process. Exposing it on
    # the HTTP body let any signed-in caller post a comment signed as a colleague,
    # in a thread that is used as a record of who said what. Nothing ever sent it.


class CommentUpdate(BaseModel):
    body: Optional[str] = None
    pinned: Optional[bool] = None
    resolved: Optional[bool] = None          # close / reopen an action item (Oct 2026)
    assignee_email: Optional[str] = None     # hand the comment to someone ("" = nobody)


class ReactionBody(BaseModel):
    emoji: str


@router.get("/{task_id}/comments")
def list_comments(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    # 404 rather than an empty list for a task that isn't there: "no comments"
    # and "no such task" are different answers, and returning the first for the
    # second made a drawer left open on a deleted task look merely empty. POST
    # and PATCH on the same id already 404.
    _wall_task(db, user, task_id)   # company wall
    # Oldest first, like a chat log - the drawer renders them in the order they
    # arrive here. Without an ORDER BY this was whatever the database handed
    # back: on Postgres that is heap order, so editing or pinning a comment
    # rewrote the row and moved it to the END of the thread, and an Asana-pulled
    # comment landed wherever its row happened to sit. created_at is an ISO-8601
    # UTC string, so it sorts chronologically as text; id breaks ties for two
    # comments written inside the same tick.
    rows = (db.query(models.TaskComment)
              .filter(models.TaskComment.task_id == task_id)
              .order_by(models.TaskComment.created_at.asc(), models.TaskComment.id.asc())
              .all())
    return [comment_to_dict(c) for c in rows]


@router.post("/{task_id}/comments", status_code=201)
def add_comment(task_id: str, body: CommentCreate, background_tasks: BackgroundTasks, notify: bool = True,
                user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    # `notify=false` (query param) posts silently - used by the Asana importer to
    # backfill historical comments without pinging assignees/followers. Defaults
    # to true, so normal in-app commenting is unchanged.
    t = _get_task(db, task_id)
    require_task_role(db, user, t, "commenter")
    # The comment itself and all six of its side effects live in create_comment
    # (routers/task_util.py) - see that docstring for why this endpoint is only
    # a wrapper. `defer` keeps the notification emails off the response path.
    # author_email is deliberately NOT passed through from the request - it
    # defaults to the actor. See CommentCreate.
    c = create_comment(db, t, actor_email=user["email"],
                       body=body.body or "", notify=notify, defer=background_tasks.add_task,
                       parent_id=body.parent_id or "",
                       assignee_email=assert_person_on_task(db, t, body.assignee_email or ""))
    # A comment on a candidate's screening task is a screening note (Oct 15);
    # on their "Decide on" task it is a vote and maybe the final call (Oct 19).
    import hiring_screening
    import hiring_decision
    if (hiring_screening.note_from_comment(db, t.id, user["email"], c.body or "")
            or hiring_decision.vote_from_comment(db, t.id, user["email"], c.body or "")):
        db.commit()
    return comment_to_dict(c)


@router.patch("/comments/{comment_id}")
def edit_comment(comment_id: str, upd: CommentUpdate, background_tasks: BackgroundTasks,
                 user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Editing the TEXT is author-only; pinning is a curation action any project
    editor may take. Before this, neither was checked at all (the handler took no
    `user`), so any signed-in person could rewrite anyone's comment on any task,
    including in a project they can't otherwise see. Every branch sits behind
    the company wall and the task's viewer role first."""
    c = db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).first()
    if not c:
        raise HTTPException(404, "Comment not found")
    t = _wall_task(db, user, c.task_id)
    require_task_role(db, user, t, "viewer")
    project = project_for_task(db, t)
    if upd.body is not None:
        # Managers bypass every other project-role check in this module, but
        # rewriting someone else's words is different in kind from access - so
        # the author check is absolute.
        if (c.author_email or "").lower() != (user["email"] or "").lower():
            raise HTTPException(403, "Only the author can edit a comment.")
        c.body = upd.body
        c.edited_at = now_iso()
    if upd.pinned is not None:
        require_project_role(db, user, project, "editor")
        c.pinned = bool(upd.pinned)
    me = (user["email"] or "").lower()
    if upd.assignee_email is not None:
        # The author hands their own comment on; an editor can route anyone's.
        if (c.author_email or "").lower() != me:
            require_project_role(db, user, project, "editor")
        who = assert_person_on_task(db, t, upd.assignee_email or "")
        if who != (c.assignee_email or ""):
            # A hand-off reopens the item: the new person has not acted on it
            # yet, and a cleared one is no longer anybody's to resolve.
            c.resolved_at, c.resolved_by = "", ""
            if who and who != me:
                task_notify(db, kind="task_activity", for_email=who, main_bell=True,
                            title="A Comment Was Assigned to You", body=f"{t.title}", task_id=t.id,
                            nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
                # Same email the person gets when the comment is posted to them.
                background_tasks.add_task(notify_task_event, t.id, "comment_assigned", me,
                                          comment_body=c.body or "", comment_assignee=who)
            t.activity_ids = list(t.activity_ids or []) + [log_activity(
                db, type="comment_assigned", actor_email=me, entity_id=t.id, entity_code=t.code,
                entity_title=t.title, detail=f"assigned a comment to {who}" if who else "cleared a comment's assignee")]
        c.assignee_email = who
    if upd.resolved is not None:
        # The author, the person it was assigned to, or a project editor.
        if me not in ((c.author_email or "").lower(), (c.assignee_email or "").lower()):
            require_project_role(db, user, project, "editor")
        if bool(upd.resolved) != bool(c.resolved_at):
            c.resolved_at = now_iso() if upd.resolved else ""
            c.resolved_by = me if upd.resolved else ""
            if t is not None:
                t.activity_ids = list(t.activity_ids or []) + [log_activity(
                    db, type="comment_resolved" if upd.resolved else "comment_reopened", actor_email=me,
                    entity_id=t.id, entity_code=t.code, entity_title=t.title,
                    detail="resolved a comment" if upd.resolved else "reopened a comment")]
                author = (c.author_email or "").lower()
                if upd.resolved and author and author != me:
                    task_notify(db, kind="task_activity", for_email=author,
                                title="Your Comment Was Resolved", body=f"{t.title}", task_id=t.id,
                                nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    if t:
        t.modified_at = now_iso()   # so a delta fetch (GET /tasks/delta) picks this task up
    db.commit()
    db.refresh(c)
    fire_task_event(c.task_id, "comment")
    return comment_to_dict(c)


@router.post("/comments/{comment_id}/reactions")
def react_to_comment(comment_id: str, body: ReactionBody, user: dict = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    """Toggle one of COMMENT_REACTIONS for the caller. Anyone who can see the
    task may react - a reaction is the lightest possible acknowledgment, which
    is the point of it. The author gets a bell when a reaction goes on; a
    toggle off is silent. The row is locked for the toggle: two people
    reacting at the same moment must not read the same dict and have the
    later write drop the earlier reaction (no-op on SQLite)."""
    emoji = (body.emoji or "").strip()
    if emoji not in COMMENT_REACTIONS:
        raise HTTPException(422, "That reaction is not offered here")
    c = db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).with_for_update().first()
    if not c:
        raise HTTPException(404, "Comment not found")
    t = _wall_task(db, user, c.task_id)
    require_task_role(db, user, t, "viewer")
    me = (user["email"] or "").lower()
    reactions = {k: list(v) for k, v in (c.reactions or {}).items() if isinstance(v, list)}
    people = reactions.get(emoji, [])
    if me in people:
        people = [p for p in people if p != me]
    else:
        people = people + [me]
        author = (c.author_email or "").lower()
        if author and author != me:
            task_notify(db, kind="task_activity", for_email=author,
                        title=f"{emoji} on Your Comment", body=f"{t.title}", task_id=t.id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    if people:
        reactions[emoji] = people
    else:
        reactions.pop(emoji, None)
    c.reactions = reactions   # reassigned, not mutated, so SQLAlchemy sees the JSON change
    t.modified_at = now_iso()
    db.commit()
    db.refresh(c)
    fire_task_event(c.task_id, "comment")
    return comment_to_dict(c)


@router.delete("/comments/{comment_id}", status_code=204)
def delete_comment(comment_id: str, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """The author, or a manager moderating the thread. Previously unguarded
    entirely - see edit_comment.

    "Project editor" was too weak a bar. On a task with no project, or one in an
    org-level project, every signed-in employee is an editor - so anyone could
    delete a colleague's comment out of a thread that is used as the record of
    who said what, leaving nothing behind to show it happened. edit_comment
    already treats rewriting someone's words as different in kind from access
    and makes the author check absolute; deleting them is not a smaller act.
    Moderation stays possible, but it takes manager+."""
    c = db.query(models.TaskComment).filter(models.TaskComment.id == comment_id).first()
    if not c:
        raise HTTPException(404, "Comment not found")
    t = db.query(models.Task).filter(models.Task.id == c.task_id).first()
    if t is not None:
        assert_task_wall(db, user, t)   # company wall first (Oct 21 2026)
    if (c.author_email or "").lower() != (user["email"] or "").lower():
        require_project_role(db, user, project_for_task(db, t) if t else None, "editor")
        if user.get("level", 1) < 3:
            raise HTTPException(403, "Only the author or a manager can delete a comment.")
    if t is not None and not task_visible_to(db, user, t):
        # ...and sight of the task, the author included (as edit_comment):
        # "no project" reads as editor for everybody, so on a restricted
        # standalone task the role check above admitted anyone. After the
        # role checks so their 403s stand.
        raise HTTPException(404, "Task not found")
    # A thread's root holds other people's replies. Its author cannot take
    # those down with it; a manager moderating the thread removes the lot.
    replies = db.query(models.TaskComment).filter(models.TaskComment.parent_id == comment_id).all()
    if replies and user.get("level", 1) < 3:
        raise HTTPException(409, "This comment has replies. Delete the replies first, or ask a manager.")
    gone = [comment_id] + [r.id for r in replies]
    if t:
        t.comment_ids = [x for x in (t.comment_ids or []) if x not in gone]
        t.modified_at = now_iso()   # so a delta fetch (GET /tasks/delta) picks this task up
    for r in replies:
        db.delete(r)
    # Files attached while composing these comments stay on the task as plain
    # attachments instead of pointing at a comment that is gone.
    (db.query(models.TaskAttachment).filter(models.TaskAttachment.comment_id.in_(gone))
       .update({"comment_id": ""}, synchronize_session=False))
    db.delete(c)
    db.commit()
    fire_task_event(c.task_id, "comment")


# ── Attachments (bytes live in Supabase storage; `url` points there) ─────────
class AttachmentCreate(BaseModel):
    name: str
    size: Optional[str] = ""
    kind: Optional[str] = "other"
    url: Optional[str] = ""
    comment_id: Optional[str] = ""   # set only when attached while composing a comment


# ── Time entries (Oct 2026) ───────────────────────────────────────────────────
# A timer per person (one running at a time, on any task) and typed-in
# minutes. Entries roll up into the task's actual_hours. Not Time Clock:
# punches are attendance and payroll; this is effort against a task.
class TimeEntryCreate(BaseModel):
    minutes: int
    note: Optional[str] = ""
    billable: Optional[bool] = False
    on: Optional[str] = ""        # YYYY-MM-DD the time was for; default today


class TimeEntryUpdate(BaseModel):
    minutes: Optional[int] = None
    note: Optional[str] = None
    billable: Optional[bool] = None


class TimerStop(BaseModel):
    note: Optional[str] = ""
    billable: Optional[bool] = None


MAX_ENTRY_MINUTES = 24 * 60


def _recount_time(db: Session, t: models.Task) -> None:
    """actual_hours and time_entry_count from the CLOSED entries. autoflush is
    off, so pending rows are flushed first."""
    db.flush()
    rows = (db.query(models.TaskTimeEntry.minutes)
            .filter(models.TaskTimeEntry.task_id == t.id, models.TaskTimeEntry.ended_at != "").all())
    had_entries = (t.time_entry_count or 0) > 0
    t.time_entry_count = len(rows)
    if rows:
        t.actual_hours = round(sum(int(m or 0) for (m,) in rows) / 60.0, 2)
    elif had_entries:
        # The last entry went: the rollup goes with it rather than surviving
        # as a typed-in number nobody typed.
        t.actual_hours = None
    t.modified_at = now_iso()


def _running_for(db: Session, email: str) -> Optional[models.TaskTimeEntry]:
    return (db.query(models.TaskTimeEntry)
            .filter(models.TaskTimeEntry.person_email == email, models.TaskTimeEntry.ended_at == "")
            .order_by(models.TaskTimeEntry.started_at.desc()).first())


def _stop_entry(db: Session, e: models.TaskTimeEntry, *, note: str = "", billable: Optional[bool] = None) -> models.Task:
    """Close a running entry at now, rounding UP to the minute (a 20-second
    timer is a minute, not nothing)."""
    from datetime import datetime, timezone
    start = datetime.fromisoformat(e.started_at)
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    secs = max(0, (datetime.now(timezone.utc) - start).total_seconds())
    e.minutes = max(1, int(-(-secs // 60)))
    e.ended_at = now_iso()
    if note:
        e.note = (note or "")[:1000]
    if billable is not None:
        e.billable = bool(billable)
    # Through the soft-delete filter: a timer left running on a task that was
    # then trashed must still stop (and must not block the person's next
    # Start). A task purged underneath it leaves nothing to roll into.
    t = (db.query(models.Task).execution_options(include_deleted=True)
           .filter(models.Task.id == e.task_id).first())
    if t is None:
        return None
    _recount_time(db, t)
    t.activity_ids = list(t.activity_ids or []) + [log_activity(
        db, type="time_logged", actor_email=e.person_email, entity_id=t.id, entity_code=t.code,
        entity_title=t.title, detail=f"tracked {_fmt_minutes(e.minutes)}")]
    return t


def _fmt_minutes(m: int) -> str:
    h, mm = divmod(int(m or 0), 60)
    return (f"{h}h " if h else "") + (f"{mm}m" if mm or not h else "").strip() or "0m"


@router.get("/time/running")
def my_running_timer(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's running timer, with the task it is on, or null."""
    e = _running_for(db, user["email"].lower())
    if not e:
        return None
    t = db.query(models.Task).filter(models.Task.id == e.task_id).first()
    return {"entry": time_entry_to_dict(e), "task": task_to_dict(t) if t else None}


@router.get("/time/mine")
def my_time_entries(from_: str = Query("", alias="from"), to: str = "",
                    user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The caller's closed entries between two days (inclusive) - the weekly
    sheet. Defaults to the last 7 days."""
    from datetime import date, timedelta
    try:
        end = date.fromisoformat(to) if to else date.today()
        start = date.fromisoformat(from_) if from_ else end - timedelta(days=6)
    except ValueError:
        raise HTTPException(422, "from/to must be YYYY-MM-DD")
    rows = (db.query(models.TaskTimeEntry)
            .filter(models.TaskTimeEntry.person_email == user["email"].lower(),
                    models.TaskTimeEntry.ended_at != "",
                    models.TaskTimeEntry.started_at >= start.isoformat(),
                    models.TaskTimeEntry.started_at < (end + timedelta(days=1)).isoformat())
            .order_by(models.TaskTimeEntry.started_at.desc()).all())
    ids = {r.task_id for r in rows}
    titles = {t.id: t.title for t in db.query(models.Task).filter(models.Task.id.in_(list(ids))).all()} if ids else {}
    return [{**time_entry_to_dict(r), "taskTitle": titles.get(r.task_id, "")} for r in rows]


@router.post("/time/stop")
def stop_my_timer(body: TimerStop, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Stop whatever the caller has running. Answers {entry, task} or null."""
    e = _running_for(db, user["email"].lower())
    if not e:
        return None
    t = _stop_entry(db, e, note=body.note or "", billable=body.billable)
    db.commit()
    db.refresh(e)
    if t is not None:
        db.refresh(t)
        fire_task_event(t.id, "updated")
    return {"entry": time_entry_to_dict(e), "task": task_to_dict(t) if t is not None else None}


@router.get("/{task_id}/time")
def list_time_entries(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _wall_task(db, user, task_id)
    require_task_role(db, user, t, "viewer")
    rows = (db.query(models.TaskTimeEntry).filter(models.TaskTimeEntry.task_id == task_id)
            .order_by(models.TaskTimeEntry.started_at.desc()).all())
    return [time_entry_to_dict(e) for e in rows]


@router.post("/{task_id}/time", status_code=201)
def add_time_entry(task_id: str, body: TimeEntryCreate, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Typed-in time. Anyone who can comment on the task may log time on it -
    logging effort is not editing the task."""
    t = _wall_task(db, user, task_id)
    require_task_role(db, user, t, "commenter")
    if not (1 <= int(body.minutes) <= MAX_ENTRY_MINUTES):
        raise HTTPException(422, "Minutes must be between 1 and 1440")
    on = (body.on or "")[:10] or now_iso()[:10]
    _check_iso_date(on, "on")
    if on > (task_automation.business_today() + timedelta(days=1)).isoformat():
        raise HTTPException(422, "That day has not happened yet")
    me = user["email"].lower()
    e = models.TaskTimeEntry(id=gen_id(), task_id=task_id, person_email=me, started_at=f"{on}T12:00:00+00:00",
                             ended_at=now_iso(), minutes=int(body.minutes), note=(body.note or "")[:1000],
                             billable=bool(body.billable), source="manual", created_at=now_iso())
    db.add(e)
    _recount_time(db, t)
    t.activity_ids = list(t.activity_ids or []) + [log_activity(
        db, type="time_logged", actor_email=me, entity_id=t.id, entity_code=t.code,
        entity_title=t.title, detail=f"logged {_fmt_minutes(e.minutes)}")]
    db.commit()
    db.refresh(e)
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return {"entry": time_entry_to_dict(e), "task": task_to_dict(t)}


@router.post("/{task_id}/time/start")
def start_timer(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Start the caller's timer on this task. A timer already running on
    another task is stopped first and comes back as `stopped`."""
    t = _wall_task(db, user, task_id)
    require_task_role(db, user, t, "commenter")
    me = user["email"].lower()
    stopped = None
    prev = _running_for(db, me)
    if prev is not None:
        if prev.task_id == task_id:
            return {"entry": time_entry_to_dict(prev), "task": task_to_dict(t), "stopped": None}
        pt = _stop_entry(db, prev)
        stopped = {"entry": time_entry_to_dict(prev), "task": task_to_dict(pt) if pt is not None else None}
    e = models.TaskTimeEntry(id=gen_id(), task_id=task_id, person_email=me, started_at=now_iso(), ended_at="",
                             minutes=0, note="", billable=False, source="timer", created_at=now_iso())
    db.add(e)
    try:
        db.commit()
    except IntegrityError:
        # ux_task_time_running: a double-click or a second tab started one at
        # the same moment. One running entry per person is the rule.
        db.rollback()
        raise HTTPException(409, "Your timer is already running. Stop it first.")
    db.refresh(e)
    if stopped and stopped["task"]:
        fire_task_event(stopped["task"]["id"], "updated")
    return {"entry": time_entry_to_dict(e), "task": task_to_dict(t), "stopped": stopped}


@router.patch("/time/{entry_id}")
def update_time_entry(entry_id: str, upd: TimeEntryUpdate, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """Your own entry, or any entry as a manager."""
    e = db.query(models.TaskTimeEntry).filter(models.TaskTimeEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Time entry not found")
    # The wall before the owner check (Oct 12 review): another company's entry
    # is 404, never a 403 that confirms it exists.
    t = _wall_task(db, user, e.task_id)
    me = user["email"].lower()
    if e.person_email != me and not _is_manager_user(user):
        raise HTTPException(403, "Only the person who logged this time, or a manager, can change it.")
    if not e.ended_at:
        raise HTTPException(409, "Stop the timer before editing this entry.")
    data = upd.model_dump(exclude_unset=True)
    if "minutes" in data:
        if not (1 <= int(data["minutes"]) <= MAX_ENTRY_MINUTES):
            raise HTTPException(422, "Minutes must be between 1 and 1440")
        e.minutes = int(data["minutes"])
    if "note" in data:
        e.note = (data["note"] or "")[:1000]
    if "billable" in data:
        e.billable = bool(data["billable"])
    _recount_time(db, t)
    db.commit()
    db.refresh(e)
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return {"entry": time_entry_to_dict(e), "task": task_to_dict(t)}


@router.delete("/time/{entry_id}")
def delete_time_entry(entry_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    e = db.query(models.TaskTimeEntry).filter(models.TaskTimeEntry.id == entry_id).first()
    if not e:
        raise HTTPException(404, "Time entry not found")
    # The wall before the owner check (Oct 12 review): another company's entry
    # is 404, never a 403 that confirms it exists.
    t = _wall_task(db, user, e.task_id)
    me = user["email"].lower()
    if e.person_email != me and not _is_manager_user(user):
        raise HTTPException(403, "Only the person who logged this time, or a manager, can remove it.")
    db.delete(e)
    _recount_time(db, t)
    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return {"task": task_to_dict(t)}


# ── Checklist (Oct 2026) ──────────────────────────────────────────────────────
# The small steps inside a task. Editors add, rename, reorder and remove
# lines; ticking a line is open to any editor AND to the person the line
# names, so someone handed one step of a task they can otherwise only read
# can still say it is done. Counters on the task row keep lists and boards
# free of a query per task.
class ChecklistItemCreate(BaseModel):
    title: str
    assignee_email: Optional[str] = ""
    # Several lines at once (pasting a list into the add box) - ONE request,
    # one recount, one realtime ping.
    titles: Optional[list] = None


class ChecklistItemUpdate(BaseModel):
    title: Optional[str] = None
    done: Optional[bool] = None
    assignee_email: Optional[str] = None
    position: Optional[float] = None


class ChecklistOrder(BaseModel):
    ids: list[str]


def _recount_checklist(db: Session, t: models.Task) -> None:
    """Task.checklist_total / checklist_done from the rows. autoflush is off,
    so the caller's pending adds/deletes are flushed first or the count would
    be one step behind the change that caused it."""
    db.flush()
    rows = db.query(models.TaskChecklistItem.done).filter(models.TaskChecklistItem.task_id == t.id).all()
    t.checklist_total = len(rows)
    t.checklist_done = sum(1 for (d,) in rows if d)
    t.modified_at = now_iso()   # so a delta fetch picks the counters up


def _checklist_item(db: Session, item_id: str) -> tuple:
    i = db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.id == item_id).first()
    if not i:
        raise HTTPException(404, "Checklist item not found")
    t = _get_task(db, i.task_id)
    return i, t


@router.get("/{task_id}/checklist")
def list_checklist(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    t = _wall_task(db, user, task_id)
    require_task_role(db, user, t, "viewer")
    rows = (db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == task_id)
            .order_by(models.TaskChecklistItem.position, models.TaskChecklistItem.created_at).all())
    return [checklist_item_to_dict(i) for i in rows]


@router.post("/{task_id}/checklist", status_code=201)
def add_checklist_items(task_id: str, body: ChecklistItemCreate, user: dict = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    """Returns {items: [the new lines], task: the task with fresh counters}."""
    t = _wall_task(db, user, task_id)
    require_task_role(db, user, t, "editor")
    titles = [str(x).strip() for x in (body.titles if body.titles is not None else [body.title]) if str(x or "").strip()]
    if not titles:
        raise HTTPException(422, "A checklist item needs a title")
    if len(titles) > 100:
        raise HTTPException(422, "At most 100 items at a time")
    last = (db.query(func.max(models.TaskChecklistItem.position))
            .filter(models.TaskChecklistItem.task_id == task_id).scalar()) or 0.0
    who = assert_person_on_task(db, t, body.assignee_email or "")
    now = now_iso()
    made = []
    for n, title in enumerate(titles, start=1):
        i = models.TaskChecklistItem(id=gen_id(), task_id=task_id, title=title[:500], done=False,
                                     assignee_email=who, position=float(last) + n,
                                     created_at=now, created_by=user["email"])
        db.add(i)
        made.append(i)
    _recount_checklist(db, t)
    if who and who != user["email"].lower():
        task_notify(db, kind="task_activity", for_email=who, main_bell=True,
                    title="You Were Given a Checklist Item",
                    body=f"{titles[0]} - {t.title}" if len(titles) == 1 else f"{len(titles)} items - {t.title}",
                    task_id=t.id, nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    db.commit()
    for i in made:
        db.refresh(i)
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return {"items": [checklist_item_to_dict(i) for i in made], "task": task_to_dict(t)}


@router.patch("/checklist/{item_id}")
def update_checklist_item(item_id: str, upd: ChecklistItemUpdate, user: dict = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    i, t = _checklist_item(db, item_id)
    assert_task_wall(db, user, t)
    data = upd.model_dump(exclude_unset=True)
    me = (user["email"] or "").lower()
    only_ticking = set(data) <= {"done"}
    if only_ticking and (i.assignee_email or "").lower() == me:
        require_task_role(db, user, t, "viewer")   # the line names them: ticking it is theirs to do
    else:
        require_task_role(db, user, t, "editor")
    if "title" in data:
        title = (data["title"] or "").strip()
        if not title:
            raise HTTPException(422, "A checklist item needs a title")
        i.title = title[:500]
    if "assignee_email" in data:
        who = assert_person_on_task(db, t, data["assignee_email"] or "")
        if who and who != (i.assignee_email or "") and who != me:
            task_notify(db, kind="task_activity", for_email=who, main_bell=True,
                        title="You Were Given a Checklist Item", body=f"{i.title} - {t.title}",
                        task_id=t.id, nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
        i.assignee_email = who
    if "position" in data and data["position"] is not None:
        i.position = float(data["position"])
    if "done" in data and bool(data["done"]) != bool(i.done):
        i.done = bool(data["done"])
        i.done_at = now_iso() if i.done else ""
        i.done_by = me if i.done else ""
        if i.done:
            t.activity_ids = list(t.activity_ids or []) + [log_activity(
                db, type="checklist_done", actor_email=me, entity_id=t.id, entity_code=t.code,
                entity_title=t.title, detail=f"checked off \"{i.title}\"")]
    _recount_checklist(db, t)
    db.commit()
    db.refresh(i)
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return {"item": checklist_item_to_dict(i), "task": task_to_dict(t)}


@router.delete("/checklist/{item_id}")
def delete_checklist_item(item_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    i, t = _checklist_item(db, item_id)
    assert_task_wall(db, user, t)
    require_task_role(db, user, t, "editor")
    db.delete(i)
    _recount_checklist(db, t)
    db.commit()
    db.refresh(t)
    fire_task_event(t.id, "updated")
    return {"task": task_to_dict(t)}


@router.put("/{task_id}/checklist/order")
def reorder_checklist(task_id: str, body: ChecklistOrder, user: dict = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """The whole order at once, as dragged. Ids not in the list keep their
    place after the listed ones; ids of other tasks are ignored."""
    t = _wall_task(db, user, task_id)
    require_task_role(db, user, t, "editor")
    rows = {i.id: i for i in db.query(models.TaskChecklistItem).filter(models.TaskChecklistItem.task_id == task_id).all()}
    n = 0
    for n, iid in enumerate([x for x in body.ids if x in rows], start=1):
        rows[iid].position = float(n)
    rest = sorted((i for i in rows.values() if i.id not in set(body.ids)), key=lambda i: (i.position or 0, i.created_at or ""))
    for k, i in enumerate(rest, start=n + 1):
        i.position = float(k)
    t.modified_at = now_iso()
    db.commit()
    fire_task_event(t.id, "updated")
    return [checklist_item_to_dict(i) for i in sorted(rows.values(), key=lambda i: i.position or 0)]


def _version_key(a: models.TaskAttachment) -> tuple:
    return (a.version or 1, a.added_at or "", a.id)


def current_versions(rows) -> list[tuple]:
    """[(current row, version count, first row)] - one per version group, the highest
    version standing for the file (Oct 22 2026). Groups keep the place their
    FIRST version had (oldest first), so a file does not jump around the list
    when someone uploads a new version of it. Rows older than versions are
    each their own group of one, exactly as before."""
    groups: dict[str, list] = {}
    for r in rows:
        groups.setdefault(r.version_group or r.id, []).append(r)
    out = []
    for rs in groups.values():
        rs.sort(key=_version_key)
        out.append((rs[0].added_at or "", rs[0].id, rs[-1], len(rs), rs[0]))
    out.sort(key=lambda x: (x[0], x[1]))
    return [(cur, n, first) for _, _, cur, n, first in out]


@router.get("/{task_id}/attachments")
def list_attachments(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The task's files - the CURRENT version of each (Oct 22 2026). Older
    versions are GET /tasks/attachments/{id}/versions; `versionCount` says
    whether there are any."""
    _wall_task(db, user, task_id)   # company wall
    rows = db.query(models.TaskAttachment).filter(models.TaskAttachment.task_id == task_id).all()
    # groupAddedBy: who uploaded the file's FIRST version - with an editor,
    # the only one who may upload a new version (add_attachment_version).
    return [{**attachment_to_dict(a), "versionCount": n, "groupAddedBy": _nz(first.added_by)}
            for a, n, first in current_versions(rows)]


_URL_SCHEME_RE = re.compile(r"^https?://", re.I)


def _check_attachment_url(url) -> None:
    """What an attachment may point at (Oct 21 2026). The Tasks screens only
    ever send a file they just stored - its canonical Supabase storage URL -
    or, with no storage configured, the file inline as a data: URL (stored
    below, or kept inline). There is no "add a link" attachment, so anything
    else is refused: a javascript: / vbscript: / file: URL would run or open
    from the Attachments list, and an outside https URL is not our evidence.
    Non-data URLs go through the app's own _validate_photo_url (Supabase
    storage only, 400) after an http(s) scheme check that holds even where
    storage is not configured (local dev, where that check is a no-op).
    Blank stays allowed (a failed upload still records the file's name)."""
    u = (url or "").strip()
    if not u or u.lower().startswith("data:"):
        return
    if not _URL_SCHEME_RE.match(u):
        raise HTTPException(400, "Attachment must be a file uploaded to Nexus.")
    from routers.items import _validate_photo_url
    _validate_photo_url(u, "Attachment")


def _check_attachment_kind(kind) -> None:
    """An uploaded file never claims to be an Egnyte link (Oct 22 2026): kind
    "egnyte" rows render as "Open In Egnyte" links and are made ONLY by
    POST /{task_id}/egnyte-links, which checks the link is on the company's
    Egnyte domain."""
    if (kind or "").strip().lower() == "egnyte":
        raise HTTPException(422, "Add an Egnyte link with Add From Egnyte, not as a file.")


@router.post("/{task_id}/attachments", status_code=201)
def add_attachment(task_id: str, body: AttachmentCreate, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    # "commenter", not "editor", and deliberately: a commenter may attach a file
    # while composing a comment (see AttachmentCreate.comment_id), so requiring
    # editor here would 403 exactly the people that flow exists for. Matches
    # add_comment's own threshold.
    require_task_role(db, user, t, "commenter")
    _check_attachment_kind(body.kind)
    _check_attachment_url(body.url)
    # An attachment tagged with a comment from a DIFFERENT task is incoherent:
    # the comment view groups by comment id within one task, so the file would
    # simply never render, while the row claims an association that isn't real.
    if body.comment_id:
        parent = db.query(models.TaskComment).filter(
            models.TaskComment.id == body.comment_id).first()
        if not parent or parent.task_id != task_id:
            raise HTTPException(422, "comment_id must be a comment on this task.")
    aid = gen_id()
    # Small files arrive from the composer as base64 data: URLs. Store the bytes
    # in Supabase Storage and keep only the link - inline bytes in this column
    # once grew the prod DB to 5.9 GB (see task_files.py). Falls back to the
    # inline URL if storage is unreachable, which is never worse than before.
    url = body.url or ""
    if url.startswith("data:"):
        url = data_url_to_storage(body.name, url) or url
    a = models.TaskAttachment(id=aid, task_id=task_id, name=body.name, size=body.size or "",
                              kind=body.kind or "other", url=url,
                              added_at=now_iso(), added_by=user["email"],
                              comment_id=body.comment_id or "")
    db.add(a)
    t.attachment_ids = list(t.attachment_ids or []) + [aid]
    act = log_activity(db, type="attached", actor_email=user["email"], entity_id=task_id,
                       entity_code=t.code, entity_title=t.title,
                       detail=f'attached "{a.name}"')
    t.activity_ids = list(t.activity_ids or []) + [act]
    t.modified_at = now_iso()   # so a delta fetch (GET /tasks/delta) picks this task up
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
    # The task even when it is in the Trash (Oct 22 2026): the default query
    # hides a trashed task, and the checks below were skipped for it. No task
    # at all means the file is not a task's - a ticket's goes through the
    # ticket routes and their rules (delete_ticket_attachment), never here.
    t = (db.query(models.Task).execution_options(include_deleted=True)
         .filter(models.Task.id == a.task_id).first())
    if t is None:
        raise HTTPException(404, "Attachment not found")
    assert_task_wall(db, user, t)   # company wall first (Oct 21 2026)
    # Whoever uploaded it can remove it; otherwise it takes an editor. Removing
    # someone else's evidence from a task shouldn't be open to every viewer.
    if (a.added_by or "").lower() != (user["email"] or "").lower():
        require_project_role(db, user, project_for_task(db, t), "editor")
    if not task_visible_to(db, user, t):
        # Sight of the task too, the uploader included (Oct 21 2026): a file
        # on a task you can no longer open is not yours to reach by id, and
        # the editor check above reads "no project" as editor for everybody.
        # After the role check so its 403 stands.
        raise HTTPException(404, "Task not found")
    if t.deleted_at:
        raise HTTPException(409, "This task is in the Trash. Restore it to change its files.")
    # A file with versions (Oct 22 2026): removing the CURRENT one hands the
    # file back to the version before it, which takes its place in the task's
    # list; removing an older one changes nothing on show.
    _lock_task_files(db, t)
    rows = _version_rows(db, a, lock=True)
    if a.id not in {r.id for r in rows}:
        raise HTTPException(404, "Attachment not found")   # removed while we waited
    siblings = [r for r in rows if r.id != a.id]
    old_ids = list(t.attachment_ids or [])
    ids = [x for x in old_ids if x != attachment_id]
    if siblings and _version_key(a) > _version_key(siblings[-1]):
        prev = siblings[-1]
        at = old_ids.index(attachment_id) if attachment_id in old_ids else len(ids)
        ids = [x for x in ids if x != prev.id]
        ids.insert(min(at, len(ids)), prev.id)
    t.attachment_ids = ids
    detail = (f'removed version {a.version or 1} of "{a.name}"' if siblings
              else f'removed attachment "{a.name}"')
    act = log_activity(db, type="attachment_removed", actor_email=user["email"], entity_id=t.id,
                       entity_code=t.code, entity_title=t.title, detail=detail)
    t.activity_ids = list(t.activity_ids or []) + [act]
    t.modified_at = now_iso()   # so a delta fetch (GET /tasks/delta) picks this task up
    db.delete(a)
    db.commit()
    fire_task_event(a.task_id, "attachment")


# ── File versions (Neil, Oct 22 2026) ────────────────────────────────────────
# "Upload New Version" on a task file: the new file becomes the current one
# and every earlier version is kept (see models.TaskAttachment.version_group).
# Adding a version takes the attachment right (commenter, add_attachment)
# AND, because it replaces the file everyone sees, the right to remove that
# file: the uploader of its first version, else an editor (delete_attachment's
# rule). Removing a version is removing a file. Comment files and Egnyte
# links are not versioned. Nothing here notifies: a new file does not today.

def _version_rows(db: Session, a: models.TaskAttachment, lock: bool = False) -> list:
    """Every version of `a`'s file on its task, oldest first. With `lock` the
    rows are locked (FOR UPDATE, id order) on Postgres."""
    g = a.version_group or a.id
    q = db.query(models.TaskAttachment).filter(
        models.TaskAttachment.task_id == a.task_id,
        or_(models.TaskAttachment.id == g, models.TaskAttachment.version_group == g))
    if lock:
        q = q.order_by(models.TaskAttachment.id).with_for_update()
    return sorted(q.all(), key=_version_key)


def _lock_task_files(db: Session, t: models.Task) -> None:
    """Before a write that rebuilds the task's attachment_ids / activity_ids.

    On Postgres this waits on the task row (FOR UPDATE, _lock_task_rows), so
    two such writes to one task go one at a time; SQLite has no row locks
    and relies on its database-wide write lock instead. The lock alone does
    NOT make the waiting request's copy of the task current - _lock_task_rows
    reads two columns only - so the row is re-read here, after the lock, and
    the lists are rebuilt from what the other request committed rather than
    from the copy read before waiting. Called after the access checks; the
    file's version rows are locked after this (task first, then versions),
    the same order everywhere, so these writes cannot deadlock each other.
    Used by delete_attachment, the version routes and add_egnyte_link;
    add_attachment still appends without it, as it always has."""
    _lock_task_rows(db, [t.id])
    try:
        db.refresh(t)
    except InvalidRequestError:        # purged while we waited
        raise HTTPException(404, "Task not found")
    # Trashed while we waited: refresh reads the row whatever its deleted_at
    # (the soft-delete filter is not applied to it), so check it here.
    if t.deleted_at:
        raise HTTPException(409, "This task is in the Trash. Restore it to change its files.")


def _attachment_and_task(db: Session, attachment_id: str):
    """The attachment and the TASK it is on - 404 when either is missing (a
    ticket's or another module's file is not a task file, and a task in the
    Trash takes no file changes)."""
    a = db.query(models.TaskAttachment).filter(models.TaskAttachment.id == attachment_id).first()
    if not a:
        raise HTTPException(404, "Attachment not found")
    t = db.query(models.Task).filter(models.Task.id == a.task_id).first()
    if t is None:
        raise HTTPException(404, "Attachment not found")
    return a, t


def _may_replace(db: Session, user: dict, t: models.Task, rows: list) -> None:
    """A new version replaces the file everyone sees, so it takes the right
    to remove that file: the uploader of its FIRST version, else an editor
    (the same check delete_attachment makes). 403 otherwise."""
    me = (user.get("email") or "").lower()
    if not rows or not me or (rows[0].added_by or "").lower() != me:
        require_project_role(db, user, project_for_task(db, t), "editor")


class AttachmentVersionCreate(BaseModel):
    name: str
    size: Optional[str] = ""
    kind: Optional[str] = "other"
    url: Optional[str] = ""


@router.get("/attachments/{attachment_id}/versions")
def list_attachment_versions(attachment_id: str, user: dict = Depends(get_current_user),
                             db: Session = Depends(get_db)):
    """Every version of a file, newest first. Reading them is reading the
    task's files (list_attachments): the wall and sight of the task."""
    a, t = _attachment_and_task(db, attachment_id)
    _wall_task(db, user, t.id)
    rows = _version_rows(db, a)
    first = rows[0].added_by if rows else ""
    return [{**attachment_to_dict(r), "versionCount": len(rows), "groupAddedBy": _nz(first)}
            for r in reversed(rows)]


@router.post("/attachments/{attachment_id}/versions", status_code=201)
def add_attachment_version(attachment_id: str, body: AttachmentVersionCreate,
                           user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    a, t = _attachment_and_task(db, attachment_id)
    require_task_role(db, user, t, "commenter")    # = add_attachment
    if (a.kind or "") == "egnyte":
        raise HTTPException(422, "An Egnyte link has no versions here - Egnyte keeps its own.")
    if a.comment_id:
        raise HTTPException(422, "A file attached to a comment cannot take new versions. Attach the new file to the task instead.")
    _may_replace(db, user, t, _version_rows(db, a))
    if not (body.name or "").strip():
        raise HTTPException(422, "The new version needs a file name.")
    _check_attachment_kind(body.kind)
    # The same check as a new attachment, and never blank: a new version
    # with no file behind it would hide the good one before it.
    if not (body.url or "").strip():
        raise HTTPException(400, "The new version must be a file uploaded to Nexus.")
    _check_attachment_url(body.url)
    _lock_task_files(db, t)
    rows = _version_rows(db, a, lock=True)     # as they are now, after the wait
    if not rows:
        raise HTTPException(404, "Attachment not found")
    _may_replace(db, user, t, rows)            # the first version may have changed
    cur = rows[-1]
    n = max((r.version or 1) for r in rows) + 1
    url = body.url or ""
    if url.startswith("data:"):
        url = data_url_to_storage(body.name, url) or url
    new = models.TaskAttachment(id=gen_id(), task_id=t.id, name=body.name, size=body.size or "",
                                kind=body.kind or "other", url=url, added_at=now_iso(),
                                added_by=user["email"], comment_id="",
                                version_group=a.version_group or a.id, version=n)
    db.add(new)
    # The task lists its CURRENT files: the new version takes the place of
    # the one it replaces (the badge counts files, not uploads).
    ids = list(t.attachment_ids or [])
    t.attachment_ids = [new.id if x == cur.id else x for x in ids] if cur.id in ids else ids + [new.id]
    act = log_activity(db, type="attached", actor_email=user["email"], entity_id=t.id,
                       entity_code=t.code, entity_title=t.title,
                       detail=f'uploaded version {n} of "{cur.name}"')
    t.activity_ids = list(t.activity_ids or []) + [act]
    t.modified_at = now_iso()
    first = rows[0].added_by
    db.commit()
    db.refresh(new)
    fire_task_event(t.id, "attachment")
    return {**attachment_to_dict(new), "versionCount": len(rows) + 1, "groupAddedBy": _nz(first)}


@router.delete("/attachments/{attachment_id}/versions", status_code=204)
def delete_attachment_versions(attachment_id: str, user: dict = Depends(get_current_user),
                               db: Session = Depends(get_db)):
    """Delete All Versions: the whole file. The rule for removing one file,
    applied to every version: all of them yours, or an editor."""
    a, t = _attachment_and_task(db, attachment_id)
    assert_task_wall(db, user, t)
    me = (user["email"] or "").lower()

    def check(rows):
        if any((r.added_by or "").lower() != me for r in rows):
            require_project_role(db, user, project_for_task(db, t), "editor")

    check(_version_rows(db, a))
    if not task_visible_to(db, user, t):
        raise HTTPException(404, "Task not found")
    _lock_task_files(db, t)
    rows = _version_rows(db, a, lock=True)     # as they are now, after the wait
    if not rows:
        raise HTTPException(404, "Attachment not found")
    check(rows)
    gone = {r.id for r in rows}
    t.attachment_ids = [x for x in (t.attachment_ids or []) if x not in gone]
    name = rows[-1].name
    detail = (f'removed "{name}" and all {len(rows)} versions' if len(rows) > 1
              else f'removed attachment "{name}"')
    act = log_activity(db, type="attachment_removed", actor_email=user["email"], entity_id=t.id,
                       entity_code=t.code, entity_title=t.title, detail=detail)
    t.activity_ids = list(t.activity_ids or []) + [act]
    t.modified_at = now_iso()
    for r in rows:
        db.delete(r)
    db.commit()
    fire_task_event(t.id, "attachment")


# ── Egnyte links (Neil, Oct 22 2026) ─────────────────────────────────────────
# A file or folder in the company Egnyte, attached as a LINK: no bytes come
# to Nexus or Supabase, and opening it goes to Egnyte, which applies each
# viewer's own permissions - Nexus never fetches the file for anyone. The
# picker browses with the existing /egnyte routes (the caller's own Egnyte
# connection); this route only records what was picked, so it makes no
# Egnyte call at all. Adding one is adding a file (commenter); removing one
# is DELETE /attachments/{id} like any file. Not versioned. One item is
# linked once per task (409 on a repeat).

_EGNYTE_ROOTS = {"shared": "Shared", "private": "Private"}


def egnyte_link_host() -> str:
    """The company Egnyte's host (EGNYTE_DOMAIN, derived exactly as
    egnyte_oauth._domain_base does), or "" when Egnyte is not set up."""
    import egnyte_oauth
    return (urlparse(egnyte_oauth._domain_base()).hostname or "").lower()


def _check_egnyte_url(url) -> str:
    """The link must be https on the company's own Egnyte host - exactly that
    host as typed, ASCII only (so egnyte.com.evil.com, greens.egnyte.com.evil.com,
    a trailing dot, full-width dots, IDN look-alikes and user@host tricks
    are refused), on the
    default port. javascript:, data: and every other scheme fail the https
    check. Returns the link, trimmed. frontend/src/tasks/egnyteLinks.js
    (egnyteLinkProblem) applies the same rule before sending."""
    u = (url or "").strip()
    host = egnyte_link_host()
    if not host:
        raise HTTPException(400, "Egnyte is not connected to Nexus, so Egnyte links cannot be added yet.")
    if not u or len(u) > 2000 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in u):
        raise HTTPException(400, "Paste the Egnyte link exactly as Egnyte shows it.")
    try:
        p = urlparse(u)
        port = p.port
    except ValueError:
        raise HTTPException(400, "That is not a valid link.")
    if (p.scheme.lower() != "https" or (p.hostname or "").lower() != host
            or p.username is not None or p.password is not None or port not in (None, 443)
            or "\\" in p.netloc or not p.netloc.isascii()):
        raise HTTPException(400, f"Only links to the company Egnyte ({host}) can be added.")
    return u


def _egnyte_path_from(url: str, path: str) -> str:
    """The /Shared/... path shown as a breadcrumb: the picker's, else the one
    in an Egnyte address-bar link (...#storage/files/1/Shared/...). A plain
    display string: duplicate slashes and "." collapse, control characters
    go, and a path with ".." in it is refused (400) - an Egnyte path never
    has one. "" when nothing says (a share link) or it is not an Egnyte
    path - it is only a label."""
    p = (path or "").strip()
    if not p:
        m = re.search(r"#storage/files/1(/[^?]*)", url or "")
        p = unquote(m.group(1)) if m else ""
    p = "".join(c for c in p.replace("\\", "/") if ord(c) >= 32 and ord(c) != 127)
    parts = [s.strip() for s in p.split("/")]
    parts = [s for s in parts if s and s != "."]
    if any(s == ".." for s in parts):
        raise HTTPException(400, "That Egnyte path is not valid.")
    if not parts or parts[0].lower() not in _EGNYTE_ROOTS:
        return ""
    parts[0] = _EGNYTE_ROOTS[parts[0].lower()]
    return ("/" + "/".join(parts))[:1000]


class EgnyteLinkCreate(BaseModel):
    url: str
    path: Optional[str] = ""
    name: Optional[str] = ""
    is_folder: Optional[bool] = None


@router.post("/{task_id}/egnyte-links", status_code=201)
def add_egnyte_link(task_id: str, body: EgnyteLinkCreate, user: dict = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    t = _get_task(db, task_id)
    require_task_role(db, user, t, "commenter")    # = add_attachment
    url = _check_egnyte_url(body.url)
    path = _egnyte_path_from(url, body.path or "")
    is_folder = body.is_folder
    if is_folder is None:
        is_folder = "/navigate/folder/" in url or "#storage/files/" in url
    # One Egnyte item is linked once per task: the same link, or the same
    # path picked again (a file's link and its path can differ in form).
    _lock_task_files(db, t)
    for r in (db.query(models.TaskAttachment)
              .filter(models.TaskAttachment.task_id == t.id, models.TaskAttachment.kind == "egnyte").all()):
        if r.url == url or (path and (r.egnyte_path or "").lower() == path.lower()):
            raise HTTPException(409, f'"{r.name}" is already linked to this task.')
    name = ((body.name or "").strip() or (path.rsplit("/", 1)[-1] if path else "")
            or ("Egnyte Folder" if is_folder else "Egnyte File"))[:250]
    a = models.TaskAttachment(id=gen_id(), task_id=t.id, name=name, size="", kind="egnyte", url=url,
                              added_at=now_iso(), added_by=user["email"], comment_id="",
                              egnyte_path=path, egnyte_kind="folder" if is_folder else "file")
    db.add(a)
    t.attachment_ids = list(t.attachment_ids or []) + [a.id]
    act = log_activity(db, type="attached", actor_email=user["email"], entity_id=t.id,
                       entity_code=t.code, entity_title=t.title,
                       detail=f'linked Egnyte {"folder" if is_folder else "file"} "{name}"')
    t.activity_ids = list(t.activity_ids or []) + [act]
    t.modified_at = now_iso()
    db.commit()
    db.refresh(a)
    fire_task_event(t.id, "attachment")
    return {**attachment_to_dict(a), "versionCount": 1}


# ── Activity ─────────────────────────────────────────────────────────────────
def global_activity(limit: int = 500, db: Session = Depends(get_db)):
    # Tasks and projects only. Ticket rows are not this feed's business, and
    # carried every ticket's subject - and previews of internal desk notes -
    # to anyone holding a tasks grant; a ticket's own activity is
    # GET /task-tickets/{id}/activity, which applies the ticket's access rules.
    rows = (db.query(models.TaskActivity)
            .filter(or_(models.TaskActivity.entity_kind.is_(None),
                        models.TaskActivity.entity_kind != "ticket"))
            .order_by(models.TaskActivity.at.desc()).limit(min(limit, 2000)).all())
    return [activity_to_dict(a) for a in rows]


@router.get("/activity", dependencies=[Depends(require_module_grant("tasks")), Depends(require_manager)])
def global_activity_feed(limit: int = 500, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    """The workspace Activity Log (Manage > Activity Log, a manager-only tab).
    It is every task's titles, status changes and assignments, so it takes the
    Tasks grant and manager level (Sep 30 review: the route took no user at
    all), and a manager behind a company wall sees only the task rows on their
    side of it. global_activity above builds the rows."""
    import auth
    if auth.company_scope(user, db) is None:
        return global_activity(limit=limit, db=db)   # walls off, or a Global Admin
    # Behind a wall (Oct 21 2026): project rows are walled as well as task
    # rows (a project's name is as much a leak as a task's title), anything
    # whose task or project cannot be placed is left out, and the wall is
    # applied BEFORE the limit - filtering the newest `limit` rows afterwards
    # handed a walled manager a short, arbitrarily truncated page. Scans in
    # pages, newest first, up to a bounded depth.
    want = max(1, min(limit, 2000))
    page, scanned, out = 2000, 0, []
    while len(out) < want and scanned < 50_000:
        chunk = (db.query(models.TaskActivity)
                 .filter(or_(models.TaskActivity.entity_kind.is_(None),
                             models.TaskActivity.entity_kind != "ticket"))
                 .order_by(models.TaskActivity.at.desc(), models.TaskActivity.id)
                 .offset(scanned).limit(page).all())
        if not chunk:
            break
        scanned += len(chunk)
        task_ids = {a.entity_id for a in chunk if (a.entity_kind or "task") == "task" and a.entity_id}
        proj_ids = {a.entity_id for a in chunk if a.entity_kind == "project" and a.entity_id}
        tasks = (db.query(models.Task).execution_options(include_deleted=True)
                 .filter(models.Task.id.in_(task_ids)).all()) if task_ids else []
        projs = (db.query(models.TaskProject).execution_options(include_deleted=True)
                 .filter(models.TaskProject.id.in_(proj_ids)).all()) if proj_ids else []
        admitted = {("task", t.id) for t in wall_tasks(db, user, tasks)} \
            | {("project", p.id) for p in wall_rows(db, user, projs)}
        for a in chunk:
            if ((a.entity_kind or "task"), a.entity_id) in admitted:
                out.append(activity_to_dict(a))
                if len(out) >= want:
                    break
    return out


@router.get("/{task_id}/activity")
def task_activity(task_id: str, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    _wall_task(db, user, task_id)   # company wall
    # "Created from Asana" / "Updated from Asana" are the sync's own bookkeeping,
    # logged once per inbound apply. On a task's own timeline they say nothing a
    # reader wants: the very next row is the real story ("changed the due date to
    # Aug 22", by the person who did it), so the marker just doubles the length
    # of the list with a robot's name against every entry. Still written, and
    # still shown in the workspace-wide feed (GET /tasks/activity), where "where
    # did this change come from" is the actual question being asked.
    rows = (db.query(models.TaskActivity)
            .filter(models.TaskActivity.entity_id == task_id,
                    models.TaskActivity.type != "synced_from_asana")
            .order_by(models.TaskActivity.at.desc()).all())
    return [activity_to_dict(a) for a in rows]


# ── The Updates card (Tasks Home) ────────────────────────────────────────────
# Which events are worth telling someone about a task they are ON. The
# activity table also carries the machinery: email receipts ("Recurring email
# sent to priyanka@..." - someone else's address, in my feed), the scheduler's
# "occurrence created", the closed-as-missed of a recurring cycle, logged
# time, files taken off. Those stay on the task's own History; this card is
# for what a person did that changes what I should do (Neil, Oct 15 2026: "a
# bit spammy - it should think about what is relevant").
_UPDATE_TYPES = {
    "commented", "completed", "task_completed", "status_changed", "due_changed",
    "assignee_changed", "created", "attached", "checklist_done",
    "comment_assigned", "comment_resolved", "restored",
    # Date asks (Oct 21 2026): an extension that needs approval, a new date
    # proposed to whoever asked for the work.
    "due_extension_requested", "due_proposed",
}
# On a task I only FOLLOW, the headline changes - not every file and tick.
_FOLLOWING_TYPES = {"commented", "completed", "task_completed", "status_changed", "due_changed", "restored"}
# One person's run of edits on one task inside this window is ONE update:
# "attached 2 files and changed the status to In Progress", not three rows.
_UPDATE_BURST = timedelta(minutes=60)
# Rows to scan for the card. Bounded so the query stays a slice of the
# activity table rather than a walk over all of it.
_UPDATE_SCAN = 3000
_BLOCK_END_RE = re.compile(r"<(?:br|/p|/div|/li|/h\d|/blockquote)[^>]*>", re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def _when(at: str):
    """An activity/comment timestamp as an aware datetime (None if unreadable)."""
    try:
        d = datetime.fromisoformat((at or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _plain(body: str, limit: int = 180) -> str:
    """A comment's rich text as one plain line for a preview."""
    import html as html_lib
    # Paragraph and line breaks become spaces; inline tags (a mention's link,
    # bold) vanish without one, so "@Neil?" does not read "@Neil ?".
    text = _TAG_RE.sub("", _BLOCK_END_RE.sub(" ", body or ""))
    text = re.sub(r"\s+", " ", html_lib.unescape(text)).strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def _is_person(actor: str) -> bool:
    """A real colleague, not the scheduler, the mailer, the Asana sync or a
    rule ("system", "asana-sync", automation@nexus)."""
    a = (actor or "").lower()
    return "@" in a and a != task_automation.AUTOMATION_ACTOR


@router.get("/activity/mine")
def my_task_activity(limit: int = 30, days: int = 14, user: dict = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    """The Updates card on the Tasks Home (Neil, Oct 14 2026; reworked Oct 15
    and Oct 21): what OTHER PEOPLE did lately that changes what I do next,
    newest first, as UPDATES rather than raw activity rows.

    - Whose tasks: assigned to me (everything worth telling), mine as OWNER
      but handed to somebody else, or followed as a collaborator (those two:
      headline changes only - completion, status, due date, comments).
    - Asks aimed at me reach me on any task: an @mention, a comment written
      or handed to me, an extension waiting on my approval, a new date
      proposed to me (relation "mentioned" when I am not otherwise on the task).
      Each ask says whether it is still open (`ask`: "open") or how it was
      answered ("Replied", "Resolved", "Answered", "Started", "Completed").
    - "You're unblocked": a task blocking one of my open tasks was completed
      (kind "unblocked", with how many blockers are left).
    - Only people: my own actions, the Asana sync, the scheduler, the mailer
      and automation rules stay out (see _UPDATE_TYPES / _is_person).
    - Grouped: one person's edits to one task within an hour are one update,
      its `parts` saying everything that happened ({kind, count, detail}).
      An update that is only files and checklist ticks is progress, not
      news, and drops.

    Each update also keeps the newest event's own fields (id, type, detail,
    actorId, at, entity*) so an older tab still renders a sentence.

    Declared as /activity/mine, which the /{task_id}/activity route cannot
    capture (its second segment is the literal "activity")."""
    me = (user.get("email") or "").lower()
    if not me:
        return []
    limit = max(1, min(int(limit or 30), 100))
    days = max(1, min(int(days or 14), 90))
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    rows = (db.query(models.TaskActivity)
            .filter(models.TaskActivity.entity_kind == "task",
                    models.TaskActivity.at >= since,
                    models.TaskActivity.type.in_(_UPDATE_TYPES),
                    func.lower(func.coalesce(models.TaskActivity.actor_email, "")) != me)
            .order_by(models.TaskActivity.at.desc()).limit(_UPDATE_SCAN).all())
    rows = [a for a in rows if a.entity_id and _is_person(a.actor_email)]
    ids = list({a.entity_id for a in rows})
    if not ids:
        return []
    # Which of those tasks I am on, read only for the tasks the slice names, in
    # chunks that stay under SQLite's bound-parameter limit. The default
    # soft-delete filter drops a task in the Trash.
    mine, state = {}, {}
    for i in range(0, len(ids), 500):
        for t in db.query(models.Task.id, models.Task.assignee_email, models.Task.assignee_emails,
                          models.Task.follower_emails, models.Task.owner_email, models.Task.created_by,
                          models.Task.completed, models.Task.due_agreement,
                          models.Task.due_proposal).filter(models.Task.id.in_(ids[i:i + 500])).all():
            state[t.id] = t
            if me in task_assignees(t):
                mine[t.id] = "assignee"
            elif (t.owner_email or "").strip().lower() == me:
                # I handed it to somebody: its outcome is my news (Neil, Oct 21).
                mine[t.id] = "owner"
            elif me in email_list(t.follower_emails):
                mine[t.id] = "collaborator"

    # The bells sent to ME about these tasks: "assigned you" (the activity row
    # only says "reassigned this task") and the date asks put to me.
    asked = {}
    for i in range(0, len(ids), 500):
        for n in (db.query(models.TaskNotification.task_id, models.TaskNotification.kind,
                           models.TaskNotification.created_at)
                  .filter(models.TaskNotification.kind.in_(_ASK_BELLS),
                          models.TaskNotification.for_email == me,
                          models.TaskNotification.created_at >= since,
                          models.TaskNotification.task_id.in_(ids[i:i + 500])).all()):
            w = _when(n.created_at)
            if w:
                asked.setdefault((n.task_id, n.kind), []).append(w)

    # Date asks I answered (approved / declined / countered): once answered
    # the proposal is gone, and with it the list of who could approve - my
    # own answer still says it was put to me.
    i_answered = {}
    for i in range(0, len(ids), 500):
        for m in (db.query(models.TaskActivity.entity_id, models.TaskActivity.at)
                  .filter(models.TaskActivity.entity_kind == "task",
                          models.TaskActivity.type == "due_answered",
                          models.TaskActivity.entity_id.in_(ids[i:i + 500]),
                          models.TaskActivity.at >= since,
                          func.lower(func.coalesce(models.TaskActivity.actor_email, "")) == me).all()):
            w = _when(m.at)
            if w:
                i_answered.setdefault(m.entity_id, []).append(w)

    def bell_near(task_id, kind, at):
        return at is not None and any(abs((w - at).total_seconds()) <= 120 for w in asked.get((task_id, kind), []))

    def proposal_of(task_id, at):
        """The task's pending date ask, when it is the one this row raised."""
        t = state.get(task_id)
        p = (t.due_proposal if t is not None else None) or {}
        w = _when(p.get("at") or "")
        if not p or at is None or w is None or abs((w - at).total_seconds()) > 120:
            return None
        return p

    def date_ask_for_me(a, at):
        """An extension waiting on my approval, or a date proposed to me."""
        if a.type in ("due_extension_requested", "due_proposed") and at is not None \
                and any(w >= at for w in i_answered.get(a.entity_id, [])):
            return True
        if a.type == "due_extension_requested":
            p = proposal_of(a.entity_id, at)
            return bell_near(a.entity_id, "task_due_extension_requested", at) \
                or bool(p and me in [x.lower() for x in (p.get("approvers") or [])])
        if a.type == "due_proposed":
            t = state.get(a.entity_id)
            return bell_near(a.entity_id, "task_due_proposed", at) \
                or bool(t is not None and proposal_of(a.entity_id, at)
                        and task_due.requester_of(t) == me)
        return False

    # A comment AIMED at me reaches me even on a task I only follow or am not
    # on at all (Neil, Oct 18 2026): one that @mentions me, one written to me,
    # or one handed to me later - that event only, not the task's other
    # events. So does a date ask put to me (Oct 21). Such a task's relation is
    # "mentioned".
    handed_to_me = f"assigned a comment to {me}"
    # "commented" rows on tasks I am not on, by (task, author), so each comment
    # finds its row without a walk over the whole slice.
    by_author = {}
    for a in rows:
        if a.type == "commented" and a.entity_id not in mine:
            by_author.setdefault((a.entity_id, (a.actor_email or "").lower()), []).append(a)
    direct_rows = set()
    for a in rows:
        if mine.get(a.entity_id) == "assignee":
            continue
        if (a.type == "comment_assigned" and (a.detail or "").strip().lower() == handed_to_me) \
                or date_ask_for_me(a, _when(a.at)):
            direct_rows.add(a.id)
            mine.setdefault(a.entity_id, "mentioned")
    others = list({k[0] for k in by_author})
    for i in range(0, len(others), 500):
        # SQL keeps only comments that could be aimed at me; extract_mentions
        # then confirms a mention (the LIKE is a coarse prefilter).
        for c in (db.query(models.TaskComment.task_id, models.TaskComment.author_email,
                           models.TaskComment.created_at, models.TaskComment.body,
                           models.TaskComment.assignee_email)
                  .filter(models.TaskComment.task_id.in_(others[i:i + 500]),
                          models.TaskComment.created_at >= since,
                          or_(func.lower(func.coalesce(models.TaskComment.assignee_email, "")) == me,
                              models.TaskComment.body.ilike(f"%{me}%"))).all()):
            if (c.assignee_email or "").lower() != me and me not in extract_mentions(c.body or ""):
                continue
            w = _when(c.created_at)
            for a in by_author.get((c.task_id, (c.author_email or "").lower()), []):
                at = _when(a.at)
                if w is not None and at is not None and abs((w - at).total_seconds()) <= 120:
                    direct_rows.add(a.id)
                    mine.setdefault(a.entity_id, "mentioned")
    completions = {}   # task id -> its newest completion row, for "unblocked"
    for a in rows:
        if a.type in ("completed", "task_completed"):
            completions.setdefault(a.entity_id, a)
    rows = [a for a in rows if a.id in direct_rows
            or mine.get(a.entity_id) == "assignee"
            or (mine.get(a.entity_id) in ("owner", "collaborator") and a.type in _FOLLOWING_TYPES)]
    my_ids = list({a.entity_id for a in rows})

    # The comments behind "commented" and hand-off rows, for the preview, for
    # whether the comment mentions me or was assigned to me, and whether it
    # has been resolved since. What I did on these tasks since, for whether
    # an ask has been answered.
    comments, comments_on = {}, {}
    my_moves = {}
    for i in range(0, len(my_ids), 500):
        chunk = my_ids[i:i + 500]
        if any(a.type in ("commented", "comment_assigned") for a in rows):
            for c in (db.query(models.TaskComment)
                      .filter(models.TaskComment.task_id.in_(chunk),
                              models.TaskComment.created_at >= since).all()):
                comments.setdefault((c.task_id, (c.author_email or "").lower()), []).append(c)
                comments_on.setdefault(c.task_id, []).append(c)
        for m in (db.query(models.TaskActivity.entity_id, models.TaskActivity.type, models.TaskActivity.at)
                  .filter(models.TaskActivity.entity_kind == "task",
                          models.TaskActivity.entity_id.in_(chunk),
                          models.TaskActivity.at >= since,
                          func.lower(func.coalesce(models.TaskActivity.actor_email, "")) == me).all()):
            w = _when(m.at)
            if w:
                my_moves.setdefault(m.entity_id, []).append((m.type, w))

    def assigned_me(a, at):
        return mine.get(a.entity_id) == "assignee" and bell_near(a.entity_id, "task_assigned", at)

    def comment_for(a, at):
        best, gap = None, 121.0
        for c in comments.get((a.entity_id, (a.actor_email or "").lower()), []):
            w = _when(c.created_at)
            if w is not None and at is not None and abs((w - at).total_seconds()) < gap:
                best, gap = c, abs((w - at).total_seconds())
        return best

    def handed_comment(a, at):
        """The comment a "handed you a comment" row is about: the newest one
        on the task assigned to me, written no later than the hand-off."""
        best = None
        for c in comments_on.get(a.entity_id, []):
            w = _when(c.created_at)
            if (c.assignee_email or "").lower() == me and w is not None and at is not None \
                    and w <= at + timedelta(seconds=120) and (best is None or w > _when(best.created_at)):
                best = c
        return best

    def i_did_since(task_id, at, types=None):
        return at is not None and any(w > at and (types is None or t in types)
                                      for t, w in my_moves.get(task_id, []))

    def done(task_id):
        t = state.get(task_id)
        return bool(t is not None and t.completed)

    def comment_ask(task_id, c, at):
        if c is not None and c.resolved_at:
            return "Resolved"
        if i_did_since(task_id, at, ("commented",)):
            return "Replied"
        return "Completed" if done(task_id) else "open"

    updates, open_groups = [], {}
    for a in rows:   # newest first
        at = _when(a.at)
        key = (a.entity_id, (a.actor_email or "").lower())
        g = open_groups.get(key)
        if g is None or at is None or g["_oldest"] is None or g["_oldest"] - at > _UPDATE_BURST:
            g = {**activity_to_dict(a), "taskId": a.entity_id, "relation": mine[a.entity_id],
                 "forYou": False, "ask": "", "preview": "", "_events": [], "_oldest": at}
            open_groups[key] = g
            updates.append(g)
        g["_oldest"] = at
        g["_events"].append((a, at))

    for g in updates:
        parts, asks = {}, []

        def add(kind, detail=""):
            p = parts.setdefault(kind, {"kind": kind, "count": 0, "detail": ""})
            p["count"] += 1
            if not p["detail"] and detail:
                p["detail"] = detail   # events are newest first: the latest wins
        aimed_at, said = None, None   # the comment the row is about (an ask's first)
        for a, at in g.pop("_events"):
            t = a.type
            if t in ("created", "assignee_changed"):
                if assigned_me(a, at):
                    add("assigned_you")
                    asks.append("Completed" if done(a.entity_id)
                                else "Started" if i_did_since(a.entity_id, at) else "open")
                elif t == "assignee_changed":
                    add("assignees")
            elif t in ("completed", "task_completed"):
                add("completed")
            elif t == "status_changed":
                add("status", a.detail or "")
            elif t == "due_changed":
                add("due", a.detail or "")
            elif t in ("due_extension_requested", "due_proposed"):
                if date_ask_for_me(a, at):
                    add("extension_ask" if t == "due_extension_requested" else "date_ask", a.detail or "")
                    asks.append("open" if proposal_of(a.entity_id, at) else "Answered")
                else:
                    add("date_request", a.detail or "")
            elif t == "commented":
                c = comment_for(a, at)
                if c is not None:
                    aimed = False
                    if me in extract_mentions(c.body or ""):
                        add("mentioned_you")
                        aimed = True
                    if (c.assignee_email or "").lower() == me:
                        add("comment_for_you")
                        aimed = True
                    if aimed:
                        asks.append(comment_ask(a.entity_id, c, at))
                        aimed_at = aimed_at or c
                    said = said or c
                    if not g["preview"]:
                        g["preview"] = _plain(c.body or "")
                add("commented")
            elif t == "comment_assigned":
                if (a.detail or "").strip().lower() == handed_to_me:
                    add("comment_for_you")
                    hc = handed_comment(a, at)
                    asks.append(comment_ask(a.entity_id, hc, at))
                    aimed_at = aimed_at or hc
                    if hc is not None and not g["preview"]:
                        g["preview"] = _plain(hc.body or "")
            elif t == "comment_resolved":
                add("resolved")
            elif t == "attached":
                add("attached")
            elif t == "checklist_done":
                add("checklist", a.detail or "")
            elif t == "restored":
                add("restored")
        # Completing a task also logs its status change; "completed" says it.
        if "completed" in parts:
            parts.pop("status", None)
        g.pop("_oldest", None)
        g["parts"] = [parts[k] for k in _PART_ORDER if k in parts]
        g["forYou"] = bool(asks)
        # Still waiting on me if any of its asks is; else how it was answered.
        g["ask"] = "open" if "open" in asks else (asks[0] if asks else "")
        # What the row's buttons act on (Oct 21 2026): open the task at this
        # comment, reply in its thread, a thumbs up, resolve one handed to me.
        c = aimed_at or said
        g["comment"] = None if c is None else {
            "id": c.id, "threadId": c.parent_id or c.id,
            "liked": me in [e.lower() for e in ((c.reactions or {}).get("👍") or [])],
            "canResolve": not c.parent_id and (c.assignee_email or "").lower() == me and not c.resolved_at,
        }

    updates += _unblocked_updates(db, me, completions)
    updates.sort(key=lambda u: _when(u.get("at")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    # Nothing to tell (an assignment of somebody else), or only files and
    # checklist ticks: dropped before the limit, so it never takes the place
    # of a real update.
    return [g for g in updates
            if g["parts"] and not all(p["kind"] in _PROGRESS_ONLY for p in g["parts"])][:limit]


def _unblocked_updates(db: Session, me: str, completions: dict) -> list:
    """"You're unblocked" (Neil, Oct 21 2026): for each of my OPEN tasks, a
    blocker somebody else completed inside the window. The blocker need not
    be a task I am on. Says how many of my task's blockers are still open."""
    if not completions:
        return []
    needle = f'%"{me}"%'
    mine = [t for t in (db.query(models.Task.id, models.Task.code, models.Task.title, models.Task.assignee_email,
                                 models.Task.assignee_emails, models.Task.blocked_by_ids)
                        .filter(models.Task.completed == False,  # noqa: E712
                                or_(func.lower(models.Task.assignee_email) == me,
                                    func.lower(cast(models.Task.assignee_emails, String)).like(needle))).all())
            if me in task_assignees(t) and any(b in completions for b in (t.blocked_by_ids or []))]
    if not mine:
        return []
    blocker_ids = list({b for t in mine for b in (t.blocked_by_ids or [])})
    blockers = {}
    for i in range(0, len(blocker_ids), 500):
        for b in (db.query(models.Task.id, models.Task.title, models.Task.completed)
                  .filter(models.Task.id.in_(blocker_ids[i:i + 500])).all()):
            blockers[b.id] = b
    # Started since (anything I did on my task after the unblock): answered.
    moves = {}
    my_task_ids = [t.id for t in mine]
    for i in range(0, len(my_task_ids), 500):
        for m in (db.query(models.TaskActivity.entity_id, models.TaskActivity.at)
                  .filter(models.TaskActivity.entity_kind == "task",
                          models.TaskActivity.entity_id.in_(my_task_ids[i:i + 500]),
                          func.lower(func.coalesce(models.TaskActivity.actor_email, "")) == me).all()):
            w = _when(m.at)
            if w:
                moves.setdefault(m.entity_id, []).append(w)
    out = []
    for t in mine:
        ids = [b for b in (t.blocked_by_ids or []) if b in blockers]
        left = sum(1 for b in ids if not blockers[b].completed)
        for b in ids:
            a = completions.get(b)
            if a is None or not blockers[b].completed:
                continue
            out.append({**activity_to_dict(a), "id": f"unblocked:{a.id}:{t.id}", "type": "unblocked",
                        "detail": "", "entityId": t.id, "entityCode": t.code or "",
                        "entityTitle": t.title or "", "taskId": t.id, "relation": "assignee",
                        "forYou": True, "preview": "", "comment": None,
                        "ask": "Started" if any(w > (_when(a.at) or w) for w in moves.get(t.id, [])) else "",
                        "parts": [{"kind": "unblocked", "count": 1, "detail": blockers[b].title or "",
                                   "left": left}]})
    return out


@router.post("/activity/mine/seen")
def mark_updates_seen(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """The Updates card was looked at: stamp now, and hand back the stamp it
    replaces so the card can mark what arrived since (Neil, Oct 21 2026).
    Kept on the server so a phone and a desktop agree."""
    me = (user.get("email") or "").lower()
    if not me:
        return {"seenAt": ""}
    now = now_iso()
    for _ in range(2):
        row = db.query(models.NexusPersonPref).filter(models.NexusPersonPref.email == me).first()
        before = (row.updates_seen_at or "") if row is not None else ""
        if row is None:
            row = models.NexusPersonPref(email=me)
            db.add(row)
        row.updates_seen_at = now
        row.updated_at = now
        try:
            db.commit()
            return {"seenAt": before}
        except IntegrityError:   # another tab made the row first
            db.rollback()
    return {"seenAt": ""}


# What an update says first: what is asked of me, then what happened.
_PART_ORDER = ["unblocked", "assigned_you", "extension_ask", "date_ask", "mentioned_you", "comment_for_you",
               "completed", "restored", "status", "due", "date_request", "assignees", "commented",
               "resolved", "attached", "checklist"]
# The bells that say something was put to ME (assigned, a date ask).
_ASK_BELLS = ("task_assigned", "task_due_extension_requested", "task_due_proposed")
# Progress, not news: an update made only of these drops.
_PROGRESS_ONLY = {"attached", "checklist"}


# ── Sections & custom statuses (board columns) ───────────────────────────────
class SectionBody(BaseModel):
    id: Optional[str] = None
    project_id: Optional[str] = ""
    custom: Optional[bool] = None   # made for the Custom grouping - models.TaskSection.custom
    # Optional so a PATCH can send only what it changes - a drag-to-reorder
    # carries a position and no name, and a required `name` here rejected it
    # with "name Field required" for a field it was not touching. Create still
    # demands one (guarded in create_section), so a nameless section is
    # impossible either way. Same shape RuleBody already uses.
    name: Optional[str] = None
    position: Optional[int] = 0


@router.get("/meta/sections")
def list_sections(db: Session = Depends(get_db)):
    return [section_to_dict(s) for s in db.query(models.TaskSection).all()]


def _require_section_editor(db: Session, user: dict, project_id: str) -> None:
    """Sections are a project's board columns, so editing them is an editor
    action on that project. A section with no project (project_id "") is
    workspace-level and stays unrestricted, matching how project_role_for
    already treats a task with no project.

    All three section endpoints previously took no `user` at all - anyone
    signed in could rename or delete another project's board columns."""
    if not project_id:
        return
    project = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    require_project_access(db, user, project, "editor")   # company wall, then the role


@router.post("/meta/sections", status_code=201)
def create_section(body: SectionBody, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    _require_section_editor(db, user, body.project_id or "")
    if not (body.name or "").strip():
        raise HTTPException(422, "A section needs a name.")
    s = models.TaskSection(id=body.id or gen_id(), project_id=body.project_id or "",
                           name=body.name.strip(), position=body.position or 0, created_at=now_iso(),
                           custom=bool(body.custom))
    db.add(s)
    db.commit()
    db.refresh(s)
    return section_to_dict(s)


@router.patch("/meta/sections/{section_id}")
def update_section(section_id: str, body: SectionBody, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    s = db.query(models.TaskSection).filter(models.TaskSection.id == section_id).first()
    if not s:
        raise HTTPException(404, "Section not found")
    _require_section_editor(db, user, s.project_id or "")
    if body.name:
        s.name = body.name
    if body.position is not None:
        s.position = body.position
    db.commit()
    db.refresh(s)
    return section_to_dict(s)


@router.delete("/meta/sections/{section_id}", status_code=204)
def delete_section(section_id: str, user: dict = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    s = db.query(models.TaskSection).filter(models.TaskSection.id == section_id).first()
    if not s:
        return
    _require_section_editor(db, user, s.project_id or "")
    # Release the tasks that were filed here. Deleting the row alone left them
    # pointing at a section that no longer resolves, so they vanished from any
    # view that groups by a known section - present in the data, invisible in
    # the UI. modified_at is bumped so GET /tasks/delta carries the change.
    orphaned = db.query(models.Task).filter(models.Task.section_id == section_id).all()
    for t in orphaned:
        t.section_id = ""
        t.modified_at = now_iso()
    db.delete(s)
    db.commit()
    for t in orphaned:
        fire_task_event(t.id, "updated")


class CustomStatusBody(BaseModel):
    id: Optional[str] = None
    label: Optional[str] = None
    color: Optional[str] = ""
    position: Optional[int] = 0
    project_ids: Optional[list] = None


@router.post("/meta/custom-statuses/dedupe", dependencies=[Depends(require_manager)])
def dedupe_custom_statuses(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Collapse same-named statuses onto one row scoped to every project that
    used them.

    Repairs databases seeded before the Asana sync matched on label: Asana's
    "Task Progress" is usually a PER-PROJECT custom field, so each project's
    "Waiting" carried its own option gid and minted its own row.

    Safe to run repeatedly - a no-op once there is nothing to merge. It remaps
    Task.status off every row it deletes, so no task is left pointing at a
    status that no longer exists.

    Behind a company wall (Oct 21 2026) a manager merges only their own
    companies' statuses; the shared ones are a Global Admin's.
    """
    import auth
    import task_status_dedupe
    scope = auth.company_scope(user, db) if isinstance(user, dict) else None
    result = task_status_dedupe.dedupe_custom_statuses(db, companies=scope)
    db.commit()
    return result


@router.get("/meta/custom-statuses")
def list_custom_statuses(project_id: str = "", user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    """`project_id` narrows to the statuses that project actually uses (its own
    plus any global one). Omitted returns every status, which is what Manage
    needs - the board passes it so a stage invented for one project stops
    appearing as a column on every other.

    Behind a company wall (Oct 21 2026) a company's own statuses are its own;
    shared ('') ones are everybody's, as every status was before."""
    import auth
    scope = auth.company_scope(user, db)
    rows = [s for s in db.query(models.TaskCustomStatus).all()
            if config_admits(getattr(s, "company_id", "") or "", scope)]
    if project_id:
        rows = [s for s in rows
                if not [p for p in (s.project_ids or []) if p]
                or project_id in (s.project_ids or [])]
    return [custom_status_to_dict(s) for s in rows]


@router.post("/meta/custom-statuses", status_code=201, dependencies=[Depends(require_manager)])
def create_custom_status(body: CustomStatusBody, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    s = models.TaskCustomStatus(id=body.id or gen_id(), label=body.label or "",
                                color=body.color or "", position=body.position or 0,
                                project_ids=[p for p in (body.project_ids or []) if p],
                                company_id=config_company_for_new(db, user, body.project_ids or []))
    db.add(s)
    db.commit()
    db.refresh(s)
    return custom_status_to_dict(s)


@router.patch("/meta/custom-statuses/{status_id}", dependencies=[Depends(require_manager)])
def update_custom_status(status_id: str, body: CustomStatusBody, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    s = db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id == status_id).first()
    if not s:
        raise HTTPException(404, "Custom status not found")
    assert_config_editable(db, user, getattr(s, "company_id", "") or "")
    data = body.model_dump(exclude_unset=True, exclude={"id"})
    if "project_ids" in data:
        data["project_ids"] = [p for p in (data["project_ids"] or []) if p]
    for k, v in data.items():
        setattr(s, k, v)
    db.commit()
    db.refresh(s)
    return custom_status_to_dict(s)


@router.delete("/meta/custom-statuses/{status_id}", status_code=204, dependencies=[Depends(require_manager)])
def delete_custom_status(status_id: str, user: dict = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    """Delete a status and move every task still in it back to Not Started -
    in the same transaction (Oct 21 2026).

    Deleting the row alone left those tasks holding an id nothing resolves:
    a phantom board column, every statusMeta lookup missing, and a PATCH of
    any other field refused by _valid_statuses only if it resent the status.
    The board's own Delete Column already promised "Tasks in it move back to
    Not Started", but did it from the browser for the tasks it could see,
    racing this call - so tasks in other projects, hidden by a filter, or in
    the Trash were left behind. Moving them here rather than refusing the
    delete keeps that promise for all of them; refusing would have broken the
    board's flow, which fires the delete without waiting for its moves."""
    s = db.query(models.TaskCustomStatus).filter(models.TaskCustomStatus.id == status_id).first()
    if not s:
        return
    assert_config_editable(db, user, getattr(s, "company_id", "") or "")
    now = now_iso()
    # Locked: a concurrent edit of one of these tasks must not write the
    # deleted status back after this moves it (no-op on SQLite).
    moved = (db.query(models.Task).execution_options(include_deleted=True)
             .filter(models.Task.status == status_id).with_for_update().all())
    # One history line per moved task, Trash included - a restored task should
    # still say why its status changed.
    for t in moved:
        t.status = "not_started"
        t.modified_at = now
        t.activity_ids = list(t.activity_ids or []) + [
            log_activity(db, type="status_changed", actor_email=user["email"], entity_id=t.id,
                         entity_code=t.code, entity_title=t.title,
                         detail=f'changed status to not_started ("{s.label}" was deleted)')]
    db.delete(s)
    db.commit()
    if moved:
        # ONE ping for the batch, as bulk_update sends - a ping per task is a
        # thread and an HTTP call each.
        fire_task_event("", "bulk")


# ── Task email notification settings (admin) ─────────────────────────────────
from task_notify import get_settings as _get_task_notify_settings, save_settings as _save_task_notify_settings


@router.get("/notify/settings")
def get_task_notify_settings(user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    return _get_task_notify_settings(db)


@router.put("/notify/settings")
def put_task_notify_settings(patch: dict, user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    return _save_task_notify_settings(db, patch, user["email"])


# ── My own task email preferences (every user) ──────────────────────────────
def _my_notify_payload(db: Session, email: str, prefs: dict) -> dict:
    import task_notify_prefs as tnp
    cfg = _get_task_notify_settings(db)
    muted_tasks = (db.query(models.Task).filter(models.Task.id.in_(prefs["mutedTaskIds"])).all()
                   if prefs["mutedTaskIds"] else [])
    muted_projects = (db.query(models.TaskProject).filter(models.TaskProject.id.in_(prefs["mutedProjectIds"])).all()
                      if prefs["mutedProjectIds"] else [])
    return {
        "prefs": prefs,
        "company": {"dueSoonDays": int(cfg.get("dueSoonDays") or 0),
                    "overdueRepeatDays": int(cfg.get("overdueRepeatDays") or 0),
                    "allowUserOverdueOff": bool(cfg.get("allowUserOverdueOff")),
                    "enabledEvents": cfg.get("enabledEvents") or {}},
        "lockedEvents": list(tnp.LOCKED_EVENTS),
        "optionalEvents": list(tnp.OPTIONAL_EVENTS),
        "mutedTasks": [{"id": t.id, "title": t.title} for t in muted_tasks],
        "mutedProjects": [{"id": p.id, "name": p.name} for p in muted_projects],
    }


@router.get("/notify/me")
def get_my_task_notify_prefs(user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    import task_notify_prefs as tnp
    return _my_notify_payload(db, user["email"], tnp.load(db, user["email"]))


@router.put("/notify/me")
def put_my_task_notify_prefs(body: dict, user: dict = Depends(get_current_user), db: Session = Depends(get_db)):
    """Replaces the caller's own preferences - only ever their own row, keyed on
    the authenticated email, never an address from the body."""
    import task_notify_prefs as tnp
    return _my_notify_payload(db, user["email"], tnp.save(db, user["email"], body or {}))


@router.get("/notify/log")
def get_task_notify_log(task_id: str = "", status: str = "", limit: int = 20, offset: int = 0,
                        user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    q = db.query(models.TaskEmailLog)
    if task_id:
        q = q.filter(models.TaskEmailLog.task_id == task_id)
    if status:
        q = q.filter(models.TaskEmailLog.status == status)
    total = q.count()
    rows = q.order_by(models.TaskEmailLog.created_at.desc()).offset(offset).limit(min(limit, 500)).all()
    return {"rows": [{
        "id": r.id, "taskId": r.task_id, "taskCode": r.task_code, "eventType": r.event_type,
        "eventVersion": r.event_version, "recipient": r.recipient, "recipientRole": r.recipient_role,
        "subject": r.subject, "status": r.status, "graphMessageId": r.graph_message_id,
        "conversationId": r.conversation_id, "attempts": r.attempts, "error": r.error,
        "createdAt": r.created_at, "updatedAt": r.updated_at,
    } for r in rows], "total": total}


# ── Inbound email (replies -> comments) ──────────────────────────────────────
@router.get("/inbound/log")
def get_task_inbound_log(task_id: str = "", status: str = "", limit: int = 20, offset: int = 0,
                         user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """What the task mailbox has handed us and what became of it. The answer to
    "I replied and nothing happened" - `reason` says which check refused it."""
    q = db.query(models.TaskInboundEmail)
    if task_id:
        q = q.filter(models.TaskInboundEmail.task_id == task_id)
    if status:
        q = q.filter(models.TaskInboundEmail.status == status)
    total = q.count()
    rows = q.order_by(models.TaskInboundEmail.processed_at.desc()).offset(offset).limit(min(limit, 500)).all()
    return {"rows": [{
        "id": r.id, "taskId": r.task_id, "commentId": r.comment_id, "from": r.from_email,
        "subject": r.subject, "status": r.status, "reason": r.reason, "matchedBy": r.matched_by,
        "attachmentCount": r.attachment_count, "receivedAt": r.received_at,
        "processedAt": r.processed_at,
    } for r in rows], "total": total}


@router.post("/inbound/drain")
def drain_task_inbox(user: dict = Depends(require_manager), db: Session = Depends(get_db)):
    """Run one pass now instead of waiting for the 60s loop - the manual
    counterpart to Asana's Pull, and the only way to exercise this on an
    instance that isn't the sync worker. A plain `def` endpoint, so FastAPI
    runs its blocking Graph calls in a threadpool rather than on the event
    loop."""
    from task_inbound import drain_once
    import leader
    # Only the deployed API reads the mailbox: a laptop pointed at the shared
    # database must never mark the live mailbox's mail read.
    if not leader.is_deployed_worker():
        raise HTTPException(409, "Only the deployed Nexus API reads the task mailbox.")
    try:
        return drain_once(db)
    except Exception as e:
        # Surfaced, not swallowed: the first thing this hits on a new mailbox is
        # a missing Mail.ReadWrite grant, and "500" would not say so.
        raise HTTPException(502, f"Could not read the task mailbox: {e}")
