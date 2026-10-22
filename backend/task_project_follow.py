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
    flush_batches) - it is an FYI, never worth an email of its own. It says
    why it came ("You follow <Project>") and links to the project, where the
    Follow button undoes it.
  - The BELL is the Tasks module's own (task_notifications - never the main
    Nexus bell, which carries only what needs you): ONE notice per person per
    project per day (the person's own day, from their email settings' time
    zone), grown in place with the newest lines on top (ring_bells), never
    one per task.

Who hears it, checked when the event happens AND again when a batched email
goes out (receiving_project, from task_notify._drop_reason):
  - a current person (not inactive / offboarded; an external whose access is
    neither deactivated nor expired) who still follows a live, unarchived
    project the task is in and has not muted that project or the task,
  - who can still see that project (company wall, then managers / the
    project's own visibility - list_projects' rule) and the task itself
    (task_util.task_visible_to - a restricted task never leaks),
  - who is not the actor, and is not already told about this event another
    way (assignee, task collaborator, creator of a completed task, comment
    thread, comment assignee, @mention) - one notice per person per event.

Cost: a person's visible projects (visible_project_ids, a walk over every
project, team and task) are worked out at most ONCE per person per event and
once per person per batch flush (_Person), and only when the cheap grants
read off the rows themselves do not already answer.

Archiving or binning the project silences it; restoring it brings the same
followers back (the list is never cleared).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
import task_notify_prefs as prefs_mod
from routers.task_util import (email_list, extract_mentions, is_manager, project_for_task,
                               row_company, task_assignees, task_is_visible, task_visible_to,
                               visible_project_ids)

FOLLOW_EVENTS = ("created", "completed", "commented")
BELL_KIND = "project_follow"
MAX_FOLLOWERS = 500
_BELL_LINES = 6
_BELL_NS = uuid.UUID("5b1d1f0e-6a43-4c0e-9d2e-1f0a7c3b9e21")   # deterministic bell ids (ring_bells)


def followers(p) -> list[str]:
    """The project's followers: lowercase, de-duplicated, in follow order."""
    return list(dict.fromkeys(email_list(getattr(p, "follower_emails", None) or [])))


# ── Is this person still someone who can be told anything ───────────────────

def _expired(expires_at: str) -> bool:
    exp = (expires_at or "").strip()
    return bool(exp) and exp[:10] < datetime.now(timezone.utc).date().isoformat()


def person_lapsed(emp) -> str:
    """Why this directory row can no longer be told anything, or "": inactive
    or offboarded, or an external / guest whose access was deactivated or has
    expired (the same refusal auth.apply_external_policy gives their own
    sign-in). Used by task_notify._is_sendable for every task email too."""
    if emp is None:
        return ""
    status = (emp.status or "").strip().lower()
    if status in ("inactive", "offboarded"):
        return "has left" if status == "offboarded" else "is inactive"
    if (getattr(emp, "identity_type", "") or "internal") in ("guest", "external"):
        if (status or "active") not in ("active", "staged"):
            return "no longer has access"
        if _expired(getattr(emp, "expires_at", "") or ""):
            return "has external access that has expired"
    return ""


def person_user(db: Session, email: str) -> dict:
    """The identity checks run as for someone who is not the caller: their
    level (a Tasks Owner grant acts as a manager, auth.level_in_module) and
    whether they are an external - externals are capped at employee, as
    auth.apply_external_policy does for their own requests. Their external
    status and expiry ride along so a lapsed external reads as inactive."""
    import auth
    email = (email or "").strip().lower()
    rec = auth._external_record(email) if email else None
    external = bool(rec and rec.get("external"))
    level = 1 if external else auth.level_in_module(email, "tasks", 3, db)
    return {"email": email, "level": level, "external": external,
            "_ext_status": (rec or {}).get("status", "active") if external else "",
            "_ext_expires": (rec or {}).get("expires_at", "") if external else ""}


class _Person:
    """One person's answers for one event (or one batch flush): identity,
    company scope, whether they are current, their email settings and - only
    when needed - their visible projects. Each is worked out once."""
    _UNSET = object()

    def __init__(self, db: Session, email: str, prefs: dict | None = None):
        self.db, self.email = db, email
        self.user = person_user(db, email)
        self._active = None
        self._scope = self._UNSET
        self._visible = None
        self._prefs = prefs

    def active(self) -> bool:
        if self._active is None:
            from sqlalchemy import func
            ok = bool(self.email) and "@" in self.email
            if ok:
                emp = (self.db.query(models.NexusEmployee)
                       .filter(func.lower(models.NexusEmployee.work_email) == self.email).first())
                ok = not person_lapsed(emp)
            u = self.user
            if ok and u.get("external"):
                ok = ((u.get("_ext_status") or "active") in ("active", "staged")
                      and not _expired(u.get("_ext_expires") or ""))
            self._active = ok
        return self._active

    def scope(self):
        if self._scope is self._UNSET:
            import auth
            self._scope = auth.company_scope(self.user, self.db)
        return self._scope

    def visible(self) -> set:
        if self._visible is None:
            self._visible = visible_project_ids(self.db, self.user)
        return self._visible

    def prefs(self) -> dict:
        if self._prefs is None:
            self._prefs = prefs_mod.load(self.db, self.email)
        return self._prefs

    def muted(self, t, p) -> bool:
        """Muted the project they follow it through, or the task itself."""
        pr = self.prefs()
        return p.id in pr["mutedProjectIds"] or getattr(t, "id", "") in pr["mutedTaskIds"]


def _person(db: Session, email: str, cache: dict | None) -> _Person:
    if cache is None:
        return _Person(db, email)
    if email not in cache:
        cache[email] = _Person(db, email)
    return cache[email]


def can_see_project(db: Session, user: dict, p, scope=None, scope_known: bool = False,
                    visible=None) -> bool:
    """Whether `user` sees project `p` in their project list - list_projects'
    rule: the company wall first, then a manager sees everything inside it,
    everyone else what visible_project_ids admits (the cheap grants are read
    straight off the row before that whole-table walk). `visible` is a
    callable returning their visible project ids, when the caller caches it."""
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
    return p.id in (visible() if visible else visible_project_ids(db, user))


def can_receive(db: Session, email: str, t, p, person: _Person | None = None) -> bool:
    """Whether `email`, following `p`, may hear about task `t` right now."""
    import auth
    person = person or _Person(db, (email or "").strip().lower())
    if not person.active():
        return False
    user, scope = person.user, person.scope()
    if not can_see_project(db, user, p, scope=scope, scope_known=True, visible=person.visible):
        return False
    # The task's own side of the wall (a task can sit in another company's
    # project only through bad data, but the wall is never assumed).
    if not auth.company_ok(row_company(db, t), scope):
        return False
    if is_manager(user) or task_is_visible(t, user, set()):
        return True
    return task_visible_to(db, user, t, person.visible())


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


def event_recipients(db: Session, t, event_type: str, actor_email: str, extra: dict | None = None,
                     cache: dict | None = None) -> dict:
    """{email: project} - the project followers to tell about this event, each
    under the first followed project of the task's they can see and have not
    muted. `cache` ({email: _Person}) is filled for ring_bells to reuse."""
    if event_type not in FOLLOW_EVENTS or t is None:
        return {}
    extra = extra or {}
    cache = {} if cache is None else cache
    skip = _already_told(t, event_type, extra) | {(actor_email or "").strip().lower(), ""}
    out: dict = {}
    for p in task_projects(db, t):
        for who in followers(p):
            if who in skip or who in out:
                continue
            person = _person(db, who, cache)
            if person.active() and not person.muted(t, p) and can_receive(db, who, t, p, person):
                out[who] = p
    return out


def import_recipients(db: Session, p, t, actor_email: str, cache: dict | None = None) -> dict:
    """{email: project} - the followers of `p` to tell about a task import
    into it (one grouped notice for the whole import, Oct 22 2026). `t` is
    one of the imported top-level tasks (they share the project and its
    access level): the same checks as any follower event - current, not
    muted, can see the project and the task - and never the importer."""
    if p is None or t is None or p.archived or (p.deleted_at or ""):
        return {}
    cache = {} if cache is None else cache
    actor = (actor_email or "").strip().lower()
    out: dict = {}
    for who in followers(p):
        if who == actor or who in out:
            continue
        person = _person(db, who, cache)
        if person.active() and not person.muted(t, p) and can_receive(db, who, t, p, person):
            out[who] = p
    return out


def import_line(actor_name: str, count: int, project_name: str) -> str:
    n = int(count or 0)
    return f"{actor_name or 'Someone'} imported {n} task{'' if n == 1 else 's'} into {project_name or 'the project'}"


def receiving_project(db: Session, email: str, t, cache: dict | None = None,
                      prefs: dict | None = None):
    """For a batched email about to go out: the live project of `t`'s that
    `email` still follows, has not muted, and can still see along with the
    task - or None. `cache` ({email: _Person}) spans a whole flush."""
    if t is None:
        return None
    email = (email or "").strip().lower()
    person = None
    for p in task_projects(db, t):
        if email in followers(p):
            if person is None:
                person = _person(db, email, cache)
                if prefs is not None and person._prefs is None:
                    person._prefs = prefs
            if not person.muted(t, p) and can_receive(db, email, t, p, person):
                return p
    return None


def still_receives(db: Session, email: str, t, cache: dict | None = None) -> bool:
    return receiving_project(db, email, t, cache) is not None


def project_url(base_url: str, project_id: str) -> str:
    """Opens the project in the Tasks module (views/Tasks.jsx reads ?project=)."""
    base = (base_url or "").rstrip("/")
    return f"{base}/tasks/projects?project={project_id}" if base else "#"


# ── The grouped bell ─────────────────────────────────────────────────────────

def _local_day(person: _Person | None) -> str:
    """The follower's own calendar day (their email settings' time zone,
    America/Los_Angeles by default), so the day's notice turns over at their
    midnight."""
    p = person.prefs() if person is not None else prefs_mod.normalize(None)
    return prefs_mod.local_now(p).date().isoformat()


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


def bell_id(project_id: str, day: str, email: str) -> str:
    """One id per person, project and day - two events landing at once can
    only ever write the same row, never two."""
    return str(uuid.uuid5(_BELL_NS, f"{project_id}|{day}|{email}"))


def ring_bells(db: Session, t, event_type: str, actor_name: str, recipients: dict,
               cache: dict | None = None, line: str | None = None) -> None:
    """One Tasks-bell notice per follower per project per day, grown in place
    (newest line on top, unread again, back to the top of the list).
    Recipients are walked in a fixed (sorted) order so two events locking the
    same notices cannot deadlock; the row id is deterministic, so a first
    notice raced by another event lands as one row (the loser of the insert
    grows the winner's). `line` replaces the per-task line (a task import's
    one "imported N tasks" line). Commits."""
    if not recipients:
        return
    now = datetime.now(timezone.utc).isoformat()
    line = line or bell_line(event_type, actor_name, t.title)
    N = models.TaskNotification
    for who, p in sorted(recipients.items(), key=lambda kv: kv[0]):
        day = _local_day(_person(db, who, cache))
        rid = bell_id(p.id, day, who)
        title = f"Activity in {p.name}"
        row = db.query(N).filter(N.id == rid).with_for_update().populate_existing().first()
        if row is None:
            try:
                with db.begin_nested():
                    db.add(N(id=rid, kind=BELL_KIND, title=title, body=line, for_email=who,
                             request_id=f"project-follow:{p.id}:{day}", department_id="",
                             task_id=t.id, read=False, created_at=now))
                continue
            except IntegrityError:
                row = db.query(N).filter(N.id == rid).with_for_update().populate_existing().first()
                if row is None:
                    raise
        row.title = title
        row.body = _grow(row.body, line)
        row.task_id = t.id
        row.read = False
        row.created_at = now
    db.commit()
