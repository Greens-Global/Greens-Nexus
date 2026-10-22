"""Follow a project (Neil, Oct 22 2026).

People could follow single tasks (Task.follower_emails) but not a whole
project. A project follower (TaskProject.follower_emails) hears about three
things in it: a new task, a task completed, a new comment. Nothing else - the
day-to-day edits stay with the people on the task.

How it travels - no second notification system:
  - EMAIL goes through task_notify.notify_task_event like every task email:
    _recipients_for adds the project followers this module returns (role
    "project_follower"), the person's own email settings apply (events turned
    off, muted projects / tasks, the "Projects I Follow" switch), and the mail
    always waits for the person's batch (task_notify._enqueue /
    flush_batches) - it is an FYI, never worth an email of its own.
  - The BELL is the Tasks module's own (task_notifications - never the main
    Nexus bell, which carries only what needs you): ONE notice per person per
    project per day, grown in place with the newest lines on top
    (ring_bells), never one per task.

Who hears it, checked when the event happens AND again when a batched email
goes out (still_receives, from task_notify._drop_reason):
  - a current person (not inactive / offboarded; an external whose access is
    still live) who still follows a live, unarchived project the task is in,
  - who can still see that project (company wall, then managers / the
    project's own visibility - list_projects' rule) and the task itself
    (task_util.task_visible_to - a restricted task never leaks),
  - who is not the actor, and is not already told about this event another
    way (assignee, task collaborator, creator of a completed task, comment
    thread, comment assignee, @mention) - one notice per person per event.

Archiving or binning the project silences it; restoring it brings the same
followers back (the list is never cleared).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.orm import Session

import models
from routers.task_util import (email_list, extract_mentions, is_manager, project_for_task,
                               row_company, task_assignees, task_visible_to, visible_project_ids)

FOLLOW_EVENTS = ("created", "completed", "commented")
BELL_KIND = "project_follow"
MAX_FOLLOWERS = 500
_BELL_LINES = 6
_BUSINESS_TZ = "America/Los_Angeles"   # same business day as task_notify._business_today


def followers(p) -> list[str]:
    """The project's followers: lowercase, de-duplicated, in follow order."""
    return list(dict.fromkeys(email_list(getattr(p, "follower_emails", None) or [])))


def person_user(db: Session, email: str) -> dict:
    """The identity checks run as for someone who is not the caller: their
    level (a Tasks Owner grant acts as a manager, auth.level_in_module) and
    whether they are an external - externals are capped at employee, as
    auth.apply_external_policy does for their own requests."""
    import auth
    email = (email or "").strip().lower()
    rec = auth._external_record(email) if email else None
    external = bool(rec and rec.get("external"))
    level = 1 if external else auth.level_in_module(email, "tasks", 3, db)
    return {"email": email, "level": level, "external": external,
            "_ext_status": (rec or {}).get("status", "active") if external else ""}


def can_see_project(db: Session, user: dict, p, scope=None, scope_known: bool = False) -> bool:
    """Whether `user` sees project `p` in their project list - list_projects'
    rule: the company wall first, then a manager sees everything inside it,
    everyone else what visible_project_ids admits (the cheap grants are read
    straight off the row before that whole-table walk)."""
    import auth
    if p is None or (getattr(p, "deleted_at", "") or ""):
        return False
    if not scope_known:
        scope = auth.company_scope(user, db)
    if not auth.company_ok(row_company(db, p), scope):
        return False
    if is_manager(user):
        return True
    email = (user.get("email") or "").lower()
    external = bool(user.get("external"))
    if (((p.access_level or "org") == "org" and not external)
            or (p.owner_email or "").lower() == email
            or email in email_list(p.member_emails)):
        return True
    return p.id in visible_project_ids(db, user)


def _active_person(db: Session, email: str, user: dict) -> bool:
    from sqlalchemy import func
    if not email or "@" not in email:
        return False
    emp = (db.query(models.NexusEmployee)
           .filter(func.lower(models.NexusEmployee.work_email) == email).first())
    if emp is not None and (emp.status or "") in ("inactive", "offboarded"):
        return False
    if user.get("external") and (user.get("_ext_status") or "active") not in ("active", "staged"):
        return False
    return True


def can_receive(db: Session, email: str, t, p, user: dict | None = None) -> bool:
    """Whether `email`, following `p`, may hear about task `t` right now."""
    import auth
    email = (email or "").strip().lower()
    user = user or person_user(db, email)
    if not _active_person(db, email, user):
        return False
    scope = auth.company_scope(user, db)
    if not can_see_project(db, user, p, scope=scope, scope_known=True):
        return False
    # The task's own side of the wall (a task can sit in another company's
    # project only through bad data, but the wall is never assumed).
    if not auth.company_ok(row_company(db, t), scope):
        return False
    return task_visible_to(db, user, t)


def task_projects(db: Session, t) -> list:
    """The live, unarchived projects `t` is in: its own (a subtask's is its
    top-level ancestor's) and any extra projects it is multi-homed in. A
    binned project is invisible to every query (database._hide_soft_deleted)."""
    out = []
    seen = set()
    primary = project_for_task(db, t)
    if primary is not None:
        out.append(primary)
        seen.add(primary.id)
    extra = [pid for pid in (getattr(t, "project_ids", None) or []) if pid and pid not in seen]
    if extra:
        out += db.query(models.TaskProject).filter(models.TaskProject.id.in_(extra)).all()
    return [p for p in out if not p.archived and not (p.deleted_at or "")]


def _already_told(t, event_type: str, extra: dict) -> set:
    """Everyone this event reaches another way - they get it as that role."""
    told = set(task_assignees(t)) | set(email_list(t.follower_emails))
    if event_type == "completed":
        told.add((t.created_by or "").strip().lower())
    if event_type == "commented":
        told |= {(e or "").lower() for e in (extra.get("thread_participants") or [])}
        told.add((extra.get("comment_assignee") or "").strip().lower())
        told |= set(extract_mentions(extra.get("comment_body") or ""))
    return told


def event_recipients(db: Session, t, event_type: str, actor_email: str, extra: dict | None = None) -> dict:
    """{email: project} - the project followers to tell about this event, each
    under the first followed project of the task's they can see."""
    if event_type not in FOLLOW_EVENTS or t is None:
        return {}
    extra = extra or {}
    skip = _already_told(t, event_type, extra) | {(actor_email or "").strip().lower(), ""}
    out: dict = {}
    users: dict = {}
    for p in task_projects(db, t):
        for who in followers(p):
            if who in skip or who in out:
                continue
            if who not in users:
                users[who] = person_user(db, who)
            if can_receive(db, who, t, p, users[who]):
                out[who] = p
    return out


def still_receives(db: Session, email: str, t) -> bool:
    """For a batched email about to go out: does `email` still follow a live
    project of `t`'s and still see it and the task?"""
    if t is None:
        return False
    email = (email or "").strip().lower()
    user = None
    for p in task_projects(db, t):
        if email in followers(p):
            user = user or person_user(db, email)
            if can_receive(db, email, t, p, user):
                return True
    return False


# ── The grouped bell ─────────────────────────────────────────────────────────

def _business_day() -> str:
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo(_BUSINESS_TZ)).date().isoformat()


def bell_line(event_type: str, actor_name: str, title: str) -> str:
    title = (title or "Untitled task").strip()
    if len(title) > 80:
        title = title[:79] + "…"
    who = actor_name or "Someone"
    if event_type == "created":
        return f'{who} added "{title}"'
    if event_type == "completed":
        return f'{who} completed "{title}"'
    return f'{who} commented on "{title}"'


def _grow(body: str, line: str) -> str:
    lines = [x for x in (body or "").split("\n") if x and not x.startswith("+ ")]
    more = 0
    for x in (body or "").split("\n"):
        if x.startswith("+ "):
            try:
                more = int(x.split()[1])
            except (IndexError, ValueError):
                more = 0
    lines = [line] + lines
    if len(lines) > _BELL_LINES:
        more += len(lines) - _BELL_LINES
        lines = lines[:_BELL_LINES]
    return "\n".join(lines + ([f"+ {more} earlier"] if more else []))


def ring_bells(db: Session, t, event_type: str, actor_name: str, recipients: dict) -> None:
    """One Tasks-bell notice per follower per project per day, grown in place
    (newest line on top, unread again, back to the top of the list). The
    lookup takes a row lock so two events landing at once both make it in.
    Commits."""
    if not recipients:
        return
    day = _business_day()
    now = datetime.now(timezone.utc).isoformat()
    line = bell_line(event_type, actor_name, t.title)
    N = models.TaskNotification
    for who, p in recipients.items():
        key = f"project-follow:{p.id}:{day}"
        row = next((o for o in db.new if isinstance(o, N) and o.for_email == who and o.request_id == key), None)
        if row is None:
            row = (db.query(N).filter(N.for_email == who, N.kind == BELL_KIND, N.request_id == key)
                   .with_for_update().first())
        if row is None:
            db.add(N(id=str(uuid.uuid4()), kind=BELL_KIND, title=f"Activity in {p.name}", body=line,
                     for_email=who, request_id=key, department_id="", task_id=t.id,
                     read=False, created_at=now))
        else:
            row.title = f"Activity in {p.name}"
            row.body = _grow(row.body, line)
            row.task_id = t.id
            row.read = False
            row.created_at = now
    db.commit()
