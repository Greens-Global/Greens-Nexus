"""Shared helpers for the Task Module routers (Jul 2026).

Mirrors the conventions in routers/items.py: ISO-string timestamps, snake→camel
serialisers, a fire-and-forget Supabase realtime ping (task_events, anon-readable
so it carries no sensitive payload), and server-side notifications. The module
has its OWN in-app bell backed by `task_notifications` (parity with the export),
and `task_notify` also mirrors each notification into the shared Nexus bell
(`nexus_notifications`, the same table items.py writes to) so task/ticket
events show up in the global bell in TopHeader, not just inside the module.
"""
import json
import os
import threading
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import TaskNotification, TaskActivity, NexusRole, NexusNotification, TaskProject, TaskTeam, Task

_SUPABASE_URL = os.getenv("SUPABASE_URL", "")
_SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def gen_id() -> str:
    return str(uuid.uuid4())


# ── Realtime ping ───────────────────────────────────────────────────────────
def _post_task_event(task_id: str, kind: str) -> None:
    try:
        httpx.post(
            f"{_SUPABASE_URL}/rest/v1/task_events",
            headers={
                "apikey": _SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {_SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            # affected_email deliberately blank — task_events is anon-readable for
            # realtime pings, so nothing personal is written. Clients refetch via
            # the authenticated API.
            json={"task_id": task_id, "kind": kind, "affected_email": ""},
            timeout=5.0,
        )
    except Exception:
        pass


def fire_task_event(task_id: str = "", kind: str = "") -> None:
    """Notify subscribed clients that task data changed, so they refetch."""
    if not _SUPABASE_URL or not _SUPABASE_SERVICE_KEY:
        return
    threading.Thread(target=_post_task_event, args=(task_id, kind), daemon=True).start()


# ── Notifications (module's own bell → task_notifications) ───────────────────
def task_notify(db: Session, *, kind: str, for_email: str, title: str, body: str = "",
                task_id: str = "", department_id: str = "", request_id: str = "",
                nexus_action: dict | None = None) -> None:
    """Create one in-app notification. `for_email` is a specific address or the
    literal "admins" to fan out to every administrator (resolved client-side).
    Server-side only — employees can't POST notifications directly.

    Also mirrors into the shared Nexus bell (nexus_notifications) so the same
    event surfaces in TopHeader's global bell, not just the module's own one.
    `nexus_action`, if given, is `{"view": ..., "sub": ..., "label": ...}` —
    NotificationBell's default click handler dispatches nexus:navigate to it.
    """
    target = for_email if for_email == "admins" else (for_email or "").lower()
    if not target:
        return
    db.add(TaskNotification(
        id=gen_id(), kind=kind, title=title, body=body, for_email=target,
        request_id=request_id, department_id=department_id, task_id=task_id,
        read=False, created_at=now_iso(),
    ))
    recipients = admin_emails(db) if target == "admins" else [target]
    action_json = json.dumps(nexus_action) if nexus_action else ""
    now = now_iso()
    for recipient in recipients:
        db.add(NexusNotification(
            id=gen_id(), type=f"task_{kind}", recipient=recipient, title=title, body=body,
            ref_id=task_id or request_id, item_name="", requested_by="", action=action_json,
            actioned=False, read_by="", created_at=now,
        ))


# ── Activity feed ────────────────────────────────────────────────────────────
def log_activity(db: Session, *, type: str, actor_email: str, entity_kind: str = "task",
                 entity_id: str = "", entity_code: str = "", entity_title: str = "",
                 detail: str = "") -> str:
    aid = gen_id()
    db.add(TaskActivity(
        id=aid, entity_kind=entity_kind, entity_id=entity_id, entity_code=entity_code,
        entity_title=entity_title, type=type, actor_email=actor_email, at=now_iso(),
        detail=detail,
    ))
    return aid


def admin_emails(db: Session) -> list[str]:
    """Emails of everyone at administrator level or above (for 'admins' fan-out
    when a caller needs the concrete list)."""
    rows = db.query(NexusRole).filter(NexusRole.role.in_(["administrator", "owner"])).all()
    return [r.email for r in rows if r.email]


# ── Visibility (Jul 2026) ─────────────────────────────────────────────────────
def is_manager(user: dict) -> bool:
    """Managers/admins bypass Task-module visibility restrictions entirely —
    same level cutoff as require_manager elsewhere in this app (auth.py)."""
    return (user or {}).get("level", 0) >= 3


def visible_project_ids(db: Session, email: str) -> set[str]:
    """Project ids a non-manager user may see: marked 'org' (Nexus Global),
    owned by them, an explicit project member, containing a team they're a
    member of, or containing a task they're the assignee of. Deliberately
    does NOT look at individual tasks' own access_level here — Task.access_level
    defaults to 'org' (its own pre-existing default, unchanged), so treating
    "has an org task" as "project is visible" would expose almost every
    project to everyone the moment it has any task in it. A task's own
    org-visibility only grants visibility to that one task (see task_is_visible),
    not its whole project."""
    email = (email or "").lower()
    ids: set[str] = set()
    for p in db.query(TaskProject).all():
        if ((p.access_level or "org") == "org" or (p.owner_email or "").lower() == email
                or email in [m.lower() for m in (p.member_emails or [])]):
            ids.add(p.id)
    for t in db.query(TaskTeam).filter(TaskTeam.project_id != "").all():
        if email in [m.lower() for m in (t.member_emails or [])]:
            ids.add(t.project_id)
    for t in db.query(Task).filter(Task.project_id != "").all():
        if (t.assignee_email or "").lower() == email:
            ids.add(t.project_id)
    return ids


def task_is_visible(t: Task, email: str, visible_proj_ids: set[str]) -> bool:
    """A task is visible if it's independently 'org', the viewer is its
    assignee/owner/creator/a follower, or it sits in a project the viewer can
    already see (org-wide, owned, or via team/assignee collaboration)."""
    email = (email or "").lower()
    if (t.access_level or "org") == "org":
        return True
    if email in ((t.assignee_email or "").lower(), (t.owner_email or "").lower(), (t.created_by or "").lower()):
        return True
    if email in [f.lower() for f in (t.follower_emails or [])]:
        return True
    if t.project_id and t.project_id in visible_proj_ids:
        return True
    return False


# ── Project access roles (Share panel, Jul 2026) ─────────────────────────────
# Mirrors Asana's own 4 tiers so the Share UI can be a direct parity build:
# a role only ever implies everything ranked below it.
PROJECT_ROLE_RANK = {"viewer": 1, "commenter": 2, "editor": 3, "owner": 4}


def project_for_task(db: Session, task: Task):
    """The TaskProject a task belongs to — walking up parent_task_id for a
    subtask, which (by convention — see asana_sync.py/asana_import.py) has its
    own project_id blank and reaches its project only via its top-level
    ancestor. None for a standalone task with no project anywhere in its chain."""
    t = task
    seen = set()
    while not t.project_id and t.parent_task_id and t.parent_task_id not in seen:
        seen.add(t.parent_task_id)
        parent = db.query(Task).filter(Task.id == t.parent_task_id).first()
        if not parent:
            break
        t = parent
    return db.query(TaskProject).filter(TaskProject.id == t.project_id).first() if t.project_id else None


def project_role_for(db: Session, email: str, project) -> str | None:
    """The highest Share-panel role `email` holds on `project`: project owner,
    else the best of an explicit member_roles entry or any TaskTeam (scoped to
    this project) they belong to, else "editor" for an org-visible project —
    preserving the pre-Share-panel behavior where anyone could act on an
    org-wide project's tasks. None means no access at all (a restricted
    project this email isn't granted on)."""
    if not project:
        return "editor"   # no project at all (a standalone task) — unrestricted, as before
    email = (email or "").lower()
    if (project.owner_email or "").lower() == email:
        return "owner"
    role = (project.member_roles or {}).get(email)
    best_rank = PROJECT_ROLE_RANK.get(role, 0)
    for t in db.query(TaskTeam).filter(TaskTeam.project_id == project.id).all():
        if email in [m.lower() for m in (t.member_emails or [])]:
            r = PROJECT_ROLE_RANK.get(t.access_role or "editor", 0)
            if r > best_rank:
                best_rank, role = r, (t.access_role or "editor")
    if best_rank:
        return role
    if (project.access_level or "org") == "org":
        return "editor"
    return None


def require_project_role(db: Session, user: dict, project, min_role: str) -> None:
    """Raise 403 unless `user` holds at least `min_role` on `project` (a
    TaskProject or None — see project_for_task). Managers/admins always
    bypass, same cutoff as is_manager elsewhere in this module."""
    if is_manager(user):
        return
    role = project_role_for(db, user["email"], project)
    if PROJECT_ROLE_RANK.get(role, 0) < PROJECT_ROLE_RANK[min_role]:
        name = f'"{project.name}"' if project else "this project"
        raise HTTPException(403, f"You need at least {min_role} access to {name}.")
