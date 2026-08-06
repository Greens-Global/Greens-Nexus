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
import re
import threading
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from models import TaskNotification, TaskActivity, NexusRole, NexusNotification, TaskProject, TaskTeam, Task, TaskComment

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
            # affected_email deliberately blank - task_events is anon-readable for
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
    Server-side only - employees can't POST notifications directly.

    Also mirrors into the shared Nexus bell (nexus_notifications) so the same
    event surfaces in TopHeader's global bell, not just the module's own one.
    `nexus_action`, if given, is `{"view": ..., "sub": ..., "label": ...}` -
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
    """Managers/admins bypass Task-module visibility restrictions entirely -
    same level cutoff as require_manager elsewhere in this app (auth.py)."""
    return (user or {}).get("level", 0) >= 3


def visible_project_ids(db: Session, email: str) -> set[str]:
    """Project ids a non-manager user may see: marked 'org' (Nexus Global),
    owned by them, an explicit project member, containing a team they're a
    member of, or containing a task they're the assignee of. Deliberately
    does NOT look at individual tasks' own access_level here - Task.access_level
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
    for t in db.query(TaskTeam).all():
        if email in [m.lower() for m in (t.member_emails or [])]:
            ids.update(team_project_ids(t))
    for t in db.query(Task).filter(Task.project_id != "").all():
        if (t.assignee_email or "").lower() == email:
            ids.add(t.project_id)
    return ids


def team_project_ids(t: TaskTeam) -> list:
    """A team's projects. A team may belong to MANY (one IT team shared across
    projects, as Asana does it); `project_ids` is the source of truth and
    `project_id` survives only as a write-only legacy mirror. Falling back to it
    keeps a row written before the column existed - or by an older instance
    mid-deploy - resolving to its one project instead of to nothing."""
    ids = [p for p in (t.project_ids or []) if p]
    if not ids and (t.project_id or ""):
        return [t.project_id]
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
    """The TaskProject a task belongs to - walking up parent_task_id for a
    subtask, which (by convention - see asana_sync.py/asana_import.py) has its
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
    this project) they belong to, else "editor" for an org-visible project -
    preserving the pre-Share-panel behavior where anyone could act on an
    org-wide project's tasks. None means no access at all (a restricted
    project this email isn't granted on)."""
    if not project:
        return "editor"   # no project at all (a standalone task) - unrestricted, as before
    email = (email or "").lower()
    if (project.owner_email or "").lower() == email:
        return "owner"
    role = (project.member_roles or {}).get(email)
    best_rank = PROJECT_ROLE_RANK.get(role, 0)
    for t in db.query(TaskTeam).all():
        if project.id in team_project_ids(t) and email in [m.lower() for m in (t.member_emails or [])]:
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
    TaskProject or None - see project_for_task). Managers/admins always
    bypass, same cutoff as is_manager elsewhere in this module."""
    if is_manager(user):
        return
    role = project_role_for(db, user["email"], project)
    if PROJECT_ROLE_RANK.get(role, 0) < PROJECT_ROLE_RANK[min_role]:
        name = f'"{project.name}"' if project else "this project"
        raise HTTPException(403, f"You need at least {min_role} access to {name}.")


def can_comment(db: Session, email: str, project) -> bool:
    """Whether `email` may comment on `project` - the boolean form of
    require_project_role(..., "commenter").

    require_project_role speaks HTTP: it takes a request's `user` dict and
    raises 403. A background worker acting on someone's behalf (the inbound
    email ingester) has an address, not a request, and needs an answer rather
    than an exception - but it must not therefore invent its own idea of who
    may comment. Both forms resolve the role through project_role_for and
    apply the same manager bypass, so there is one definition of the rule: a
    manager who replies to a notification by email must not be refused where
    the same person commenting in the drawer succeeds."""
    email = (email or "").lower()
    if not email:
        return False
    from auth import level_for      # local: auth imports models, not this module
    if level_for(email, db) >= 3:   # is_manager's cutoff
        return True
    return PROJECT_ROLE_RANK.get(project_role_for(db, email, project), 0) >= PROJECT_ROLE_RANK["commenter"]


# ── Comments ─────────────────────────────────────────────────────────────────
_MENTION_RE = re.compile(r'href\s*=\s*["\']mailto:([^"\'>\s]+)["\']', re.I)


def extract_mentions(html: str) -> list:
    """Emails @mentioned in a comment.

    The editor writes a mention as a mailto link (`<a href="mailto:x@y">@Name</a>`)
    rather than a bespoke node type - that reuses the Link mark the editor
    already has, needs no extra TipTap package, and degrades to a working
    mailto: link anywhere the HTML is rendered plainly (including in the
    notification email itself)."""
    seen, out = set(), []
    for m in _MENTION_RE.findall(html or ""):
        e = m.strip().lower()
        if e and "@" in e and e not in seen:
            seen.add(e)
            out.append(e)
    return out


def asana_push_comment(comment_id: str) -> None:
    """Fire-and-forget outbound comment sync. Fully guarded."""
    try:
        from asana_sync import on_comment_added
        on_comment_added(comment_id)
    except Exception:
        pass


def create_comment(db: Session, task, *, actor_email: str, author_email: str = "",
                   body: str = "", notify: bool = True, defer=None) -> TaskComment:
    """Write one comment on `task` and fire every side effect that belongs to it:
    the activity entry, the in-app bells, the realtime ping, the Asana push and
    the notification emails (including the separate @mention mail).

    THE one comment-creation path. `POST /tasks/{id}/comments` is a thin wrapper
    over this and so is anything else that ever posts a comment - a comment that
    arrives from outside has to land in all six places exactly like a typed one.
    The Asana sync learned this the hard way (CLAUDE.md: never add a second
    inbound path); a second copy here would drift the same way, and silently.

    Callers own fetching `task` and checking permission (require_project_role
    for a request, can_comment for a worker) - this function trusts both.

    `actor_email`  who performed the action: drives the activity entry, who is
                   excluded from the notifications, and the "who commented"
                   line in the mail.
    `author_email` who the comment is FROM when that differs from the actor -
                   the Asana importer backfills historical comments under their
                   original authors while acting as the importing user.
                   Defaults to the actor.
    `notify=False` posts silently - that same backfill, which must not ping
                   assignees and followers about years-old comments.
    `defer`        how to run the notification EMAILS, which make blocking
                   Graph calls: a request passes `BackgroundTasks.add_task` so
                   they run after the response is sent; a worker already off
                   the event loop passes nothing and they run inline.

    Commits, and returns the refreshed comment."""
    run_after = defer or (lambda fn, *a, **kw: fn(*a, **kw))
    actor = (actor_email or "").lower()
    author = (author_email or actor_email or "").lower()
    text = body or ""

    cid = gen_id()
    c = TaskComment(id=cid, task_id=task.id, author_email=author, body=text,
                    created_at=now_iso(), edited_at="", pinned=False)
    db.add(c)
    task.comment_ids = list(task.comment_ids or []) + [cid]
    task.modified_at = now_iso()   # so a delta fetch (GET /tasks/delta) picks this task up
    aid = log_activity(db, type="commented", actor_email=actor, entity_id=task.id,
                       entity_code=task.code, entity_title=task.title, detail="added a comment")
    task.activity_ids = list(task.activity_ids or []) + [aid]
    # notify assignee + followers (except author)
    if notify:
        for who in set([(task.assignee_email or "").lower(),
                        *[(e or "").lower() for e in (task.follower_emails or [])]]):
            if who and who != actor:
                task_notify(db, kind="task_activity", for_email=who,
                            title="New comment on a task", body=f"{task.title}", task_id=task.id,
                            nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    db.commit()
    db.refresh(c)
    fire_task_event(task.id, "comment")
    asana_push_comment(cid)
    if notify:
        # Lazy: task_notify.py imports this module, so importing it at module
        # level here would be a cycle.
        from task_notify import notify_task_event
        run_after(notify_task_event, task.id, "commented", actor, comment_body=text)
        # Mentions are their own event so the mail can say "X mentioned you"
        # instead of the generic comment FYI. The author is dropped - mentioning
        # yourself shouldn't email you.
        mentioned = [e for e in extract_mentions(text) if e != actor]
        if mentioned:
            for who in mentioned:
                task_notify(db, kind="task_activity", for_email=who,
                            title="You were mentioned in a comment",
                            body=f"{task.title}", task_id=task.id,
                            nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
            db.commit()
            run_after(notify_task_event, task.id, "mentioned", actor,
                      comment_body=text, mentioned=mentioned)
    return c
