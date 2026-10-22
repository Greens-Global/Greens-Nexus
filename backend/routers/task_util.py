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

from models import (TaskNotification, TaskActivity, NexusRole, NexusNotification, TaskProject,
                    TaskTeam, Task, TaskComment, TaskAttachment, TaskChecklistItem,
                    TaskTimeEntry)

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
# What also rings the shared Nexus bell (Neil, Oct 14 2026): assignments,
# @mentions (call sites pass main_bell=True) and approvals - something that
# needs YOU. Comments, status moves, due-date changes and the rest stay in
# the Tasks / Tickets module's own bell, so the main bell is not a second
# copy of every task event.
MAIN_BELL_KINDS = frozenset({
    # assigned to you / put on it
    "task_assigned", "ticket_assigned", "ticket_collaborator",
    # a decision or answer is needed, or one was made on your request
    "ticket_needs_approval", "ticket_approved", "ticket_rejected", "ticket_needs_assignment",
    "ticket_escalated",
    "task_due_extension_requested", "task_due_proposed", "task_due_answered",
    "member_request", "request_approved", "request_rejected",
    "team_approval_requested", "team_approval_decided",
    # a property manager: a ticket or a service due at their property
    "ticket_property",
})


def task_notify(db: Session, *, kind: str, for_email: str, title: str, body: str = "",
                task_id: str = "", ticket_id: str = "", department_id: str = "",
                request_id: str = "", nexus_action: dict | None = None,
                main_bell: bool | None = None) -> None:
    """Create one in-app notification. `for_email` is a specific address or the
    literal "admins" to fan out to every administrator (resolved client-side).
    Server-side only - employees can't POST notifications directly.

    Also mirrors into the shared Nexus bell (nexus_notifications) so the same
    event surfaces in TopHeader's global bell, not just the module's own one.
    `nexus_action`, if given, is `{"view": ..., "sub": ..., "label": ...}` -
    NotificationBell's default click handler dispatches nexus:navigate to it.

    When the notification is ABOUT a task, `taskId` is added to that action
    here rather than at each call site: every one of them wrote the same
    {"view": "tasks", "sub": "mine"}, which landed you on My Tasks and left you
    to find the task the card just named. Tasks.jsx opens the drawer for a
    navigate event carrying a taskId, so this is what makes "View task" open
    the task. Central so new call sites get it without remembering.

    `ticket_id` is the same deal for the Ticket module, and for the same
    reason - every ticket call site wrote a bare {"view": "tickets"}, so "View
    ticket" reached the list and left you to find the ticket the card had just
    named by its number. TicketsView.jsx opens its drawer on a ticketId.
    """
    target = for_email if for_email == "admins" else (for_email or "").lower()
    if not target:
        return
    db.add(TaskNotification(
        id=gen_id(), kind=kind, title=title, body=body, for_email=target,
        request_id=request_id or ticket_id, department_id=department_id, task_id=task_id,
        read=False, created_at=now_iso(),
    ))
    if main_bell is None:
        main_bell = kind in MAIN_BELL_KINDS
        # The person who RAISED a ticket hears every update on it in the main
        # bell (Charmi, Oct 1: requesters are often employees with no Tickets
        # screen, so the module's own bell would leave them hearing nothing).
        if not main_bell and ticket_id and kind.startswith("ticket") and target != "admins":
            from models import TaskTicket
            # A ticket made in this same request is not flushed yet (autoflush is off).
            t = next((o for o in db.new if isinstance(o, TaskTicket) and o.id == ticket_id), None) \
                or db.get(TaskTicket, ticket_id)
            main_bell = bool(t and (t.requester_email or "").strip().lower() == target)
    if not main_bell:
        return
    recipients = admin_emails(db) if target == "admins" else [target]
    action = dict(nexus_action) if nexus_action else None
    if action and task_id and not action.get("taskId"):
        action["taskId"] = task_id
    if action and ticket_id and not action.get("ticketId"):
        action["ticketId"] = ticket_id
    action_json = json.dumps(action) if action else ""
    now = now_iso()
    for recipient in recipients:
        db.add(NexusNotification(
            id=gen_id(), type=f"task_{kind}", recipient=recipient, title=title, body=body,
            ref_id=task_id or ticket_id or request_id, item_name="", requested_by="", action=action_json,
            actioned=False, read_by="", created_at=now,
        ))


# ── Activity feed ────────────────────────────────────────────────────────────
def log_activity(db: Session, *, type: str, actor_email: str, entity_kind: str = "task",
                 entity_id: str = "", entity_code: str = "", entity_title: str = "",
                 detail: str = "", change: dict | None = None) -> str:
    """One activity row. `change` is a field-history entry (task_history.py)
    for a row that records a field moving from one value to another."""
    aid = gen_id()
    row = TaskActivity(
        id=aid, entity_kind=entity_kind, entity_id=entity_id, entity_code=entity_code,
        entity_title=entity_title, type=type, actor_email=actor_email, at=now_iso(),
        detail=detail,
    )
    if change is not None:
        row.field_change = change
    db.add(row)
    if entity_kind == "task" and entity_id:
        # This request's task rows, so task_history can put a field change on
        # the row that already tells the story ("completed this task") instead
        # of writing a second one. Sessions are per request / per scan.
        # Kept as plain values: reading an expired row after a commit would
        # cost a SELECT each.
        seen = db.info.setdefault("task_activity_rows", [])
        seen.append((entity_id, type, row.at, row))
        if len(seen) > 500:
            del seen[:-200]
    return aid


def admin_emails(db: Session) -> list[str]:
    """Emails of everyone at administrator level or above (for 'admins' fan-out
    when a caller needs the concrete list)."""
    rows = db.query(NexusRole).filter(NexusRole.role.in_(["administrator", "owner"])).all()
    return [r.email for r in rows if r.email]


# ── Visibility (Jul 2026) ─────────────────────────────────────────────────────
def is_manager(user: dict) -> bool:
    """Managers/admins bypass Task-module visibility restrictions entirely -
    same level cutoff as require_manager elsewhere in this app (auth.py).
    A Tasks Owner grant reaches level 3 here too (auth.module_owner_acts_as
    on the Task routers)."""
    return (user or {}).get("level", 0) >= 3


def email_list(raw) -> list[str]:
    """Lowercased emails from a JSON list column, skipping anything that is not
    a string.

    member_emails / follower_emails are user- and sync-supplied JSON, so they
    cannot be assumed clean. A single null in ONE project's member list used to
    raise AttributeError ('NoneType' has no attribute 'lower') deep inside a
    visibility check, which surfaced as a blanket 500 on /task-projects and
    /tasks/delta for every NON-manager - managers skip these helpers, so the
    workspace looked fine to admins and completely broken to everyone else.
    One bad row took out the whole module rather than just itself.
    """
    return [x.lower() for x in (raw or []) if isinstance(x, str)]


def task_assignees(t) -> list[str]:
    """Everyone assigned to `t`, lowercased.

    Reads `assignee_emails` and falls back to the legacy single column, so a row
    written before multi-assignee (or by any code path still setting only the
    mirror - the Asana sync does) answers correctly without a migration having
    to have run first. This is the ONLY correct way to ask "is this person on
    this task"; a bare `t.assignee_email` check silently ignores everyone after
    the first."""
    ids = email_list(getattr(t, "assignee_emails", None))
    if ids:
        return ids
    one = (getattr(t, "assignee_email", "") or "").strip().lower()
    return [one] if one else []


def set_task_assignees(t, emails) -> list[str]:
    """Assign `t` to `emails` (order-preserving, de-duplicated, lowercased) and
    keep the legacy single column pointing at the first of them.

    Both columns are written here and nowhere else, so the mirror cannot drift
    from the list - the failure TaskTeam._set_team_projects exists to prevent
    for its own legacy mirror."""
    seen, clean = set(), []
    for e in (emails or []):
        if not isinstance(e, str):
            continue
        e = e.strip().lower()
        if e and e not in seen:
            seen.add(e)
            clean.append(e)
    t.assignee_emails = clean
    t.assignee_email = clean[0] if clean else ""
    return clean


def _email_and_external(user_or_email) -> tuple[str, bool]:
    """Both visibility helpers accept either the plain email (legacy call
    sites) or the full user dict from get_current_user. Passing the dict is
    what lets them recognize an EXTERNAL (B2B guest) caller - externals never
    get the org-wide defaults, only explicit participation (Aug 17)."""
    if isinstance(user_or_email, dict):
        return (user_or_email.get("email") or "").lower(), bool(user_or_email.get("external"))
    return (user_or_email or "").lower(), False


def visible_project_ids(db: Session, user_or_email) -> set[str]:
    """Project ids a non-manager user may see: marked 'org' (Nexus Global),
    owned by them, an explicit project member, containing a team they're a
    member of, or containing a task they're the assignee of. Deliberately
    does NOT look at individual tasks' own access_level here - Task.access_level
    defaults to 'org' (its own pre-existing default, unchanged), so treating
    "has an org task" as "project is visible" would expose almost every
    project to everyone the moment it has any task in it. A task's own
    org-visibility only grants visibility to that one task (see task_is_visible),
    not its whole project."""
    email, external = _email_and_external(user_or_email)
    ids: set[str] = set()
    for p in db.query(TaskProject).all():
        # Externals never inherit 'org' (Nexus Global) visibility - they see a
        # project only through explicit ownership/membership/team/assignment.
        if (((p.access_level or "org") == "org" and not external)
                or (p.owner_email or "").lower() == email
                or email in email_list(p.member_emails)):
            ids.add(p.id)
    for t in db.query(TaskTeam).all():
        # Only an APPROVED team confers access AS A TEAM. An unapproved one is
        # its creator's private grouping: it hands its members individual
        # project grants instead (_sync_personal_team_grants), which are picked
        # up by the member_emails branch above. Counting it here as well would
        # let anyone widen their own access simply by creating a team and
        # naming a project - the thing approval exists to gate.
        if not team_is_approved(t):
            continue
        if email in email_list(t.member_emails):
            ids.update(team_project_ids(t))
    for t in db.query(Task).filter(Task.project_id != "").all():
        # Every assignee, not just the first - being given the work is what
        # grants the sight of the project it lives in.
        if email in task_assignees(t):
            ids.add(t.project_id)
            ids.update(p for p in (t.project_ids or []) if p)
    return ids


def team_is_approved(t) -> bool:
    """Whether this team is a real, workspace-wide team.

    Blank counts as approved: every team that existed before personal teams
    were added is a department somebody set up from Manage, and defaulting
    those to unapproved would have silently cut off access across the
    workspace on deploy.
    """
    return (getattr(t, "approval_status", "") or "approved") == "approved"


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


def task_is_visible(t: Task, user_or_email, visible_proj_ids: set[str]) -> bool:
    """A task is visible if it's independently 'org', the viewer is its
    assignee/owner/creator/a follower, or it sits in a project the viewer can
    already see (org-wide, owned, or via team/assignee collaboration).
    EXTERNAL callers (pass the user dict) never get the 'org' default - only
    explicit participation or a project they explicitly belong to (Aug 17)."""
    email, external = _email_and_external(user_or_email)
    if (t.access_level or "org") == "org" and not external:
        return True
    if email in task_assignees(t):
        return True
    if email in ((t.owner_email or "").lower(), (t.created_by or "").lower()):
        return True
    if email in email_list(t.follower_emails):
        return True
    if t.project_id and t.project_id in visible_proj_ids:
        return True
    # EXTRA projects (ids beyond the primary - see models.Task.project_ids)
    # grant the same visibility a task's primary project would.
    if any(p in visible_proj_ids for p in (t.project_ids or [])):
        return True
    return False


# ── Company wall (Aug 2026) ───────────────────────────────────────────────────
# A hard tenant boundary layered ON TOP of the visibility rules above: even a
# manager's org-wide bypass and an 'org'-access task are still confined to the
# caller's own companies once the walls are armed. Off (or a Global Admin) → a
# no-op, so the Task module is unchanged for the single-org setup.
def _emp_company_map(db: Session) -> dict:
    from models import NexusEmployee
    return {(e.work_email or "").lower(): (e.company or "")
            for e in db.query(NexusEmployee.work_email, NexusEmployee.company).all()
            if e.work_email}


def task_company(t, emp_company: dict) -> str:
    """The HrEntity company a task belongs to: its stamped company_id, else
    derived from the owner/creator's company - so tasks created before stamping
    (and Asana-sync tasks) still land on the right side of the wall rather than
    slipping through untagged."""
    c = (getattr(t, "company_id", "") or "").strip()
    if c:
        return c
    for who in ((getattr(t, "owner_email", "") or ""), (getattr(t, "created_by", "") or "")):
        c2 = emp_company.get(who.lower())
        if c2:
            return c2
    return ""


_UNSET = object()


def _scope_for(db: Session, user, scope=_UNSET):
    """auth.company_scope, unless the caller already worked it out for this
    request (a bulk edit checks many rows against one scope)."""
    if scope is not _UNSET:
        return scope
    import auth
    return auth.company_scope(user, db)


def wall_tasks(db: Session, user, rows, scope=_UNSET):
    """Keep only the tasks the caller's company scope admits. No-op when the walls
    are off or the caller is a Global Admin (auth.company_scope → None). Untagged
    tasks (no company, no owner/creator company) stay Global-Admin-only."""
    scope = _scope_for(db, user, scope)
    if scope is None:
        return list(rows)
    emp = _emp_company_map(db)
    return [t for t in rows if task_company(t, emp) in scope]


# ── Company wall for the module's other records (Oct 21 2026) ────────────────
# Projects, portfolios and teams are tenant data, like tasks: a stamped
# company_id wins, else the company of the owner / creator (task_company works
# on any row carrying those columns), and an untagged one is Global-Admin-only
# once the walls are armed. A team with no creator company falls back to its
# projects' company.
#
# The module's CONFIGURATION rows (automation rules, task templates, custom
# fields, custom statuses, intake forms) use the opposite convention for a
# blank company: '' = shared by every company, which is what every such row
# was before the walls existed. A company on one of those rows confines it to
# that company (config_admits / config_company_for_new below).
def row_company(db: Session, row, emp: dict | None = None) -> str:
    """The company a project / portfolio / task row belongs to - task_company,
    with the owner / creator lookup done per row unless `emp` (the full
    employee -> company map) is passed for a list."""
    if emp is not None:
        return task_company(row, emp)
    c = (getattr(row, "company_id", "") or "").strip()
    if c:
        return c
    import auth
    for who in ((getattr(row, "owner_email", "") or ""), (getattr(row, "created_by", "") or "")):
        if who.strip():
            c2 = auth.company_of(who, db)
            if c2:
                return c2
    return ""


def team_company(db: Session, team, emp: dict | None = None, proj_company: dict | None = None) -> str:
    """A team's company: stamped, else its creator's, else the first of its
    projects that has one (teams set up from Manage before creators were
    recorded have no creator)."""
    c = row_company(db, team, emp)
    if c:
        return c
    for pid in team_project_ids(team):
        if proj_company is not None:
            c2 = proj_company.get(pid, "")
        else:
            p = db.query(TaskProject).filter(TaskProject.id == pid).first()
            c2 = row_company(db, p) if p is not None else ""
        if c2:
            return c2
    return ""


def wall_rows(db: Session, user, rows, company_of_row=None, scope=_UNSET):
    """wall_tasks for any tenant row (projects, portfolios, teams): the rows
    the caller's company scope admits. No-op when the walls are off or the
    caller is a Global Admin. `company_of_row(row, emp)` overrides how a row's
    company is read."""
    import auth
    scope = _scope_for(db, user, scope)
    if scope is None:
        return list(rows)
    emp = _emp_company_map(db)
    read = company_of_row or (lambda r, e: task_company(r, e))
    return [r for r in rows if auth.company_ok(read(r, emp), scope)]


def _team_project_companies(db: Session, teams, emp: dict) -> dict:
    """{project_id: company} for just the projects these teams serve - one
    query, not one per team."""
    pids = {pid for t in teams for pid in team_project_ids(t)}
    if not pids:
        return {}
    return {p.id: task_company(p, emp)
            for p in db.query(TaskProject).execution_options(include_deleted=True)
            .filter(TaskProject.id.in_(pids)).all()}


def wall_teams(db: Session, user, rows, scope=_UNSET):
    """The teams a caller may SEE behind the wall: those whose own company
    (team_company) is in scope, and those serving any project of a company in
    scope - a legacy team spanning two companies' projects is visible on both
    sides. Changing a team takes its OWN company (assert_team_wall)."""
    import auth
    rows = list(rows)
    scope = _scope_for(db, user, scope)
    if scope is None:
        return rows
    emp = _emp_company_map(db)
    proj_company = _team_project_companies(db, rows, emp)
    out = []
    for t in rows:
        if (auth.company_ok(team_company(db, t, emp, proj_company), scope)
                or any(auth.company_ok(proj_company.get(pid, ""), scope) for pid in team_project_ids(t))):
            out.append(t)
    return out


def teams_editable(db: Session, user, rows, scope=_UNSET) -> list:
    """The teams whose OWN company is in the caller's scope - the ones they
    may change or attach to a project. Everything with the walls off."""
    import auth
    rows = list(rows)
    scope = _scope_for(db, user, scope)
    if scope is None:
        return rows
    emp = _emp_company_map(db)
    proj_company = _team_project_companies(db, rows, emp)
    return [t for t in rows if auth.company_ok(team_company(db, t, emp, proj_company), scope)]


def assert_row_wall(db: Session, user: dict, row, company: str | None = None, scope=_UNSET) -> None:
    """404 unless the caller's company scope admits `row` (a task, project or
    portfolio; pass `company` when it was worked out another way, e.g. a
    team). Same answer as the lists: wall_tasks / wall_rows."""
    import auth
    scope = _scope_for(db, user, scope)
    if scope is None or row is None:
        return
    if not auth.company_ok(row_company(db, row) if company is None else company, scope):
        raise HTTPException(404, "Not found")


def assert_task_wall(db: Session, user: dict, task, scope=_UNSET) -> None:
    """The company wall for ONE task - the per-record form of wall_tasks, so a
    task a list hides is also a 404 when fetched by id."""
    assert_row_wall(db, user, task, scope=scope)


def assert_team_wall(db: Session, user: dict, team, scope=_UNSET) -> None:
    """Changing a team (or deciding on it): its OWN company must be in scope.
    Seeing one is wider - see wall_teams."""
    if team is None:
        return
    scope = _scope_for(db, user, scope)
    if scope is None:
        return
    assert_row_wall(db, user, team, company=team_company(db, team), scope=scope)


def require_project_access(db: Session, user: dict, project, min_role: str) -> None:
    """require_project_role for an endpoint that acts ON a project (its
    settings, its sharing, moving work into it): the company wall first - a
    manager clears every role check, so without it a manager could edit or
    fill another company's project - then the role."""
    if project is not None:
        assert_row_wall(db, user, project)
    require_project_role(db, user, project, min_role)


def tenant_company_for_new(db: Session, user: dict, owner_email: str = "") -> str:
    """The company to STAMP on a new project / portfolio / team (Oct 21 2026).

    '' while the walls are off - the row then derives its company from its
    owner / creator exactly as every row did before (row_company), so a
    stamp can never pile up on rows made while nothing reads it. Behind the
    walls: the named owner's company (when it is one the caller may act in),
    else the caller's own company; a Global Admin who names no owner leaves
    it blank (derived)."""
    import auth
    if not auth._company_walls_on(db):
        return ""
    scope = auth.company_scope(user, db)
    me = (user.get("email") or "").strip().lower()
    owner = (owner_email or "").strip().lower()
    if owner and owner != me:
        oc = auth.company_of(owner, db)
        if oc and (scope is None or oc in scope):
            return oc
    if scope is None:
        return ""
    home = auth.company_of(user, db)
    if home and home in scope:
        return home
    if len(scope) == 1:
        return next(iter(scope))
    return ""


def config_admits(company_id: str, scope) -> bool:
    """Whether a configuration row (rule, template, custom field, custom
    status, intake form) is visible to a caller with `scope`: shared ('') rows
    always, a company's rows only inside that company."""
    c = (company_id or "").strip()
    return scope is None or not c or c in scope


def config_company_for_new(db: Session, user: dict, project_ids=None) -> str:
    """The company to stamp on a NEW configuration row. '' (shared, as every
    row was before) while the walls are off and for a Global Admin. Behind a
    wall: a row scoped to projects takes THEIR company (each must be inside
    the caller's scope - 404 otherwise); one tied to no project, the
    creator's own company, or the one company in their scope - so a
    company's manager can never make a row that reaches another company."""
    import auth
    scope = auth.company_scope(user, db)
    if scope is None:
        return ""
    pids = [i for i in dict.fromkeys(project_ids or []) if i]
    if pids:
        companies = set()
        for proj in db.query(TaskProject).filter(TaskProject.id.in_(pids)).all():
            c = row_company(db, proj)
            if not auth.company_ok(c, scope):
                raise HTTPException(404, "Project not found")
            companies.add(c)
        if len(companies) == 1:
            return next(iter(companies))
    home = auth.company_of(user, db)
    if home and home in scope:
        return home
    if len(scope) == 1:
        return next(iter(scope))
    raise HTTPException(403, "Your account is not placed in one company, so this cannot be "
                             "created for a company. Ask a Global Admin.")


def assert_config_editable(db: Session, user: dict, company_id: str) -> None:
    """Edits and deletes of a configuration row: another company's row is a
    404 (as if absent); a shared ('') row reaches every company, so behind a
    wall only a Global Admin may change it. No-op with the walls off."""
    import auth
    scope = auth.company_scope(user, db)
    if scope is None:
        return
    c = (company_id or "").strip()
    if c and c not in scope:
        raise HTTPException(404, "Not found")
    if not c:
        raise HTTPException(403, "This is shared by every company - only a Global Admin can change it.")


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
    else the best of an explicit member_roles entry, a bare member_emails entry
    (editor - see below), or any TaskTeam scoped to this project, else "editor"
    for an org-visible project - preserving the pre-Share-panel behavior where
    anyone could act on an org-wide project's tasks. None means no access at all
    (a restricted project this email isn't granted on)."""
    if not project:
        return "editor"   # no project at all (a standalone task) - unrestricted, as before
    email = (email or "").lower()
    if (project.owner_email or "").lower() == email:
        return "owner"
    role = (project.member_roles or {}).get(email)
    best_rank = PROJECT_ROLE_RANK.get(role, 0)
    # Listed on the Share panel with no explicit role means EDITOR - which is
    # exactly what that panel has always shown for such a person (its role
    # picker renders `memberRoles[email] || 'editor'`). Only member_roles and
    # teams used to count here, so anyone holding a bare member_emails entry
    # read as "Editor" on screen and resolved to no role at all in the API:
    # they could open the project and were refused on their first edit with
    # "You need at least editor access", while the panel plainly said they had
    # it. A bare entry arrives that way from the Asana sync and from any grant
    # predating the role map, so this is most of a synced project's roster.
    #
    # Not a widening of who has access - member_emails is only ever written by
    # an explicit Share-panel grant or by Asana's own membership list, both
    # deliberate. It settles what a grant already there MEANS, in favour of the
    # answer the UI has been giving. An explicit viewer/commenter still wins,
    # because it is read above and this never lowers a rank.
    if not role and email in email_list(project.member_emails):
        role, best_rank = "editor", PROJECT_ROLE_RANK["editor"]
    for t in db.query(TaskTeam).all():
        if not team_is_approved(t):
            continue        # see visible_project_ids
        if project.id in team_project_ids(t) and email in email_list(t.member_emails):
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


def people_wall(db: Session, user=None) -> tuple:
    """(walled, emp_map) for the people checks below, worked out ONCE per
    request (Oct 21 2026): `walled` is whether the company comparison applies
    (`user`'s scope; with no user, whether the walls are armed) and `emp_map`
    the employee -> company map, built only when it does - with the walls off
    nothing loads the whole directory. Kept on the request's session
    (`db.info`), keyed by the caller and the walls switch, so a create that
    checks people on a task and each of its subtasks pays for it once."""
    import auth
    on = auth._company_walls_on(db)
    who = (user.get("email") or "").lower() if isinstance(user, dict) else ""
    key = ("people_wall", who, isinstance(user, dict), on)
    hit = db.info.get(key)
    if hit is None:
        walled = (auth.company_scope(user, db) is not None) if isinstance(user, dict) else on
        hit = (walled, _emp_company_map(db) if walled else None)
        db.info[key] = hit
    return hit


def person_problem(db: Session, task, email: str, user=None, emp_map: dict | None = None) -> str:
    """Why `email` may not be put ON `task` as an assignee or collaborator, or
    "" when they may (Oct 21 2026). Being put there is itself what lets them
    see it (task_is_visible), so unlike assert_person_on_task this does not
    ask that they can see it already. The rule matches the People picker
    (/myhr/directory): a directory row that is not offboarded. The company
    comparison only applies behind the company wall (`user`'s scope; with no
    user, whether the walls are armed) - with them off, a US manager assigns
    a Greens India colleague exactly as before. `emp_map` is the employee ->
    company map when the caller already has it (else people_wall's, built
    once per request and only behind the wall)."""
    from sqlalchemy import func
    from models import NexusEmployee
    who = (email or "").strip().lower()
    if not who:
        return ""
    emp = db.query(NexusEmployee).filter(func.lower(NexusEmployee.work_email) == who).first()
    if emp is None:
        return "is not in the Nexus directory"
    if (emp.status or "") == "offboarded":
        return "has left"
    walled, wall_map = people_wall(db, user)
    if walled:
        task_co = task_company(task, emp_map if emp_map is not None else wall_map)
        if task_co and (emp.company or "") and emp.company != task_co:
            return "is in another company"
    return ""


def assert_person_assignable(db: Session, task, email: str, user=None, emp_map: dict | None = None) -> str:
    """`email` lowercased once person_problem has nothing against it - else
    422 naming the person and the reason ("x has left and can't be re-added"
    reads right on an Undo that puts a departed assignee back)."""
    who = (email or "").strip().lower()
    problem = person_problem(db, task, who, user, emp_map)
    if problem == "has left":
        raise HTTPException(422, f"{who} has left and can't be re-added.")
    if problem:
        raise HTTPException(422, f"{who} {problem}.")
    return who


def split_people(db: Session, task, emails, user=None, actor: str = "") -> tuple[list, list]:
    """For CREATE paths (a new task, a subtask, a duplicate, a template use):
    (kept, dropped) - the people who pass person_problem, in order and
    de-duplicated, and [{email, reason}] for those who do not. Create flows
    carry people over from a source task, and one departed collaborator must
    not fail the whole action; they are left off and the task says so
    (note_dropped_people). The caller adding themselves always passes."""
    me = (actor or "").strip().lower()
    kept, dropped, seen = [], [], set()
    for raw in emails or []:
        who = str(raw or "").strip().lower()
        if not who or who in seen:
            continue
        seen.add(who)
        problem = "" if who == me else person_problem(db, task, who, user)
        if problem:
            dropped.append({"email": who, "reason": problem})
        else:
            kept.append(who)
    return kept, dropped


def note_dropped_people(db: Session, task, dropped: list, actor: str) -> None:
    """One activity row on `task` naming who was not added and why."""
    if not dropped:
        return
    detail = "did not add " + ", ".join(f"{d['email']} ({d['reason']})" for d in dropped)
    task.activity_ids = list(task.activity_ids or []) + [
        log_activity(db, type="people_not_added", actor_email=actor, entity_id=task.id,
                     entity_code=task.code or "", entity_title=task.title or "", detail=detail)]


def assert_person_on_task(db: Session, task, email: str) -> str:
    """`email` lowercased, once it is a current person who can already open
    `task` - else 422. For hand-offs that name someone on a thing INSIDE a
    task (a checklist line, a comment): being named there grants no
    visibility, so the person must be able to see the task already, must be a
    real, active employee (not any string that reaches a bell and, for a
    comment, an outside mailbox), and must be on the task's side of the
    company wall. Blank stays blank: that is "nobody"."""
    import auth
    from models import NexusEmployee
    who = (email or "").strip().lower()
    if not who:
        return ""
    emp = db.query(NexusEmployee).filter(NexusEmployee.work_email == who).first()
    if not emp or (emp.status or "") in ("inactive", "offboarded"):
        raise HTTPException(422, "That person is not in the Nexus directory.")
    task_co = task_company(task, _emp_company_map(db))
    if task_co and (emp.company or "") and emp.company != task_co:
        raise HTTPException(422, "That person is in another company.")
    if auth.level_in_module(who, "tasks", 3, db) >= 3:   # managers (and Tasks Owners) open every task
        return who
    if not task_is_visible(task, who, visible_project_ids(db, who)):
        raise HTTPException(422, "That person cannot see this task. Add them to the task or its project first.")
    return who


def require_task_role(db: Session, user: dict, task, min_role: str, scope=_UNSET,
                      visible_cache: dict | None = None) -> None:
    """require_project_role for a check about ONE task, where anyone the task
    is assigned to always counts.

    A task can carry several assignees (see models.Task). Each of them holds
    this grant independently, which is what makes "whoever gets to it first
    closes it" work: there is one row and one completed flag, so the first to
    tick it finishes it for all of them.

    visible_project_ids already lets an assignee SEE a project through the work
    they hold in it, but project_role_for gave them no role - so somebody handed
    a task in a project they are not a member of could open it, watch it sit in
    My Tasks, and be refused when they tried to tick it complete. Being given
    the work is the grant.

    Scoped to that one task, never to the project: `min_role` is capped at
    editor here, so this cannot stand in for owner-level project settings, and
    every other task in the project still answers to project_role_for.

    Deleting counts too (decided Aug 2026). One consequence to keep in mind if
    this is ever revisited: delete_task cascades to SUBTASKS, so an assignee
    removing their own task also removes children that may belong to other
    people - the only place this grant reaches beyond the one task it is
    scoped to.

    The company wall comes first (Oct 21 2026): the manager bypass below
    clears every role check, so without it a manager behind a wall could act
    on another company's task through any caller that relies on this alone
    (bulk edits, ticket links, Outlook actions). 404, like every other wall.
    No-op while the walls are off and for a Global Admin."""
    if task is not None:
        assert_task_wall(db, user, task, scope=scope)
    if is_manager(user):
        return
    email = (user.get("email") or "").lower()
    if (task is not None and email
            and email in task_assignees(task)
            and PROJECT_ROLE_RANK[min_role] <= PROJECT_ROLE_RANK["editor"]):
        return
    project = project_for_task(db, task) if task is not None else None
    require_project_role(db, user, project, min_role)
    # A role is not sight (Oct 21 2026). project_role_for reads "no project"
    # as editor for everyone, so a RESTRICTED standalone task - visible only
    # to its owner, creator, assignees and collaborators - could be edited,
    # deleted, commented on or saved as a template by anyone holding its id.
    # Likewise it hands an EXTERNAL caller editor on any org-wide project,
    # which externals never see. In those two cases the task must also be one
    # the caller can see, by the same rule the lists and _wall_task apply;
    # 404 like them. Checked after the role so a refusal the role already
    # gave keeps its 403. A role an internal caller holds on the task's
    # project already means they can see that project (visible_project_ids
    # counts the same owner / member / team / org grants), so the common case
    # pays for no extra scan.
    if task is not None and (project is None or user.get("external")):
        visible = None
        if visible_cache is not None and user.get("external"):
            # A batch (bulk edit) checks many tasks for one external: their
            # visible projects are worked out once, not per row.
            if "v" not in visible_cache:
                visible_cache["v"] = visible_project_ids(db, user)
            visible = visible_cache["v"]
        if not task_visible_to(db, user, task, visible):
            raise HTTPException(404, "Task not found")


def task_visible_to(db: Session, user: dict, task, visible: set | None = None) -> bool:
    """Whether `user` can see `task`: THE per-task visibility rule, shared by
    require_task_role and routers/tasks._wall_task. Managers see everything
    inside their company wall (the wall is checked separately); everybody
    else what task_is_visible admits, with a subtask (no project of its own)
    also admitted through its top-level ancestor's project. `visible` is the
    caller's visible_project_ids when already worked out; it is only built
    when the cheap checks (org task, owner / creator / assignee / follower)
    have not already answered."""
    if is_manager(user):
        return True
    if task_is_visible(task, user, set()):
        return True
    extras = [p for p in (task.project_ids or []) if p]
    proj = project_for_task(db, task) if (not task.project_id and task.parent_task_id) else None
    if not (task.project_id or extras or proj):
        return False   # no project anywhere: nothing but the checks above can admit it
    if visible is None:
        visible = visible_project_ids(db, user)
    if task_is_visible(task, user, visible):
        return True
    return bool(proj and proj.id in visible)


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
    from auth import level_in_module   # local: auth imports models, not this module
    if level_in_module(email, "tasks", 3, db) >= 3:   # is_manager's cutoff, Tasks Owners included
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


# Reactions a comment can carry - the same six the in-mail buttons offer
# (task_mail_actions.REACTIONS) plus "seen" and "done".
COMMENT_REACTIONS = ("👍", "❤️", "🎉", "👏", "😂", "🔥", "👀", "✅")


def thread_root(db: Session, task_id: str, parent_id: str) -> TaskComment | None:
    """The root comment a reply joins: `parent_id` itself when it is a root,
    its root when it is already a reply. None when it is not on this task."""
    if not parent_id:
        return None
    p = db.query(TaskComment).filter(TaskComment.id == parent_id, TaskComment.task_id == task_id).first()
    if p is None:
        return None
    if p.parent_id:
        root = db.query(TaskComment).filter(TaskComment.id == p.parent_id, TaskComment.task_id == task_id).first()
        return root or p
    return p


def thread_participants(db: Session, root: TaskComment) -> set[str]:
    """Everyone who has written in a thread - the root's author and every
    replier - lowercased."""
    out = {(root.author_email or "").lower()}
    for (a,) in db.query(TaskComment.author_email).filter(TaskComment.parent_id == root.id).all():
        out.add((a or "").lower())
    out.discard("")
    return out


def create_comment(db: Session, task, *, actor_email: str, author_email: str = "",
                   body: str = "", notify: bool = True, defer=None,
                   parent_id: str = "", assignee_email: str = "") -> TaskComment:
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
    `parent_id`    makes this a REPLY in that comment's thread (Oct 2026). A
                   reply to a reply joins the same thread. The thread's
                   participants are told, on top of the task's usual people.
    `assignee_email` makes the comment an action item for that person: a
                   bell and an email of its own, closed by resolving it.

    Commits, and returns the refreshed comment."""
    run_after = defer or (lambda fn, *a, **kw: fn(*a, **kw))
    actor = (actor_email or "").lower()
    author = (author_email or actor_email or "").lower()
    text = body or ""
    root = thread_root(db, task.id, parent_id) if parent_id else None
    if parent_id and root is None:
        from fastapi import HTTPException
        raise HTTPException(404, "The comment you are replying to is not on this task.")
    assignee = (assignee_email or "").strip().lower()

    cid = gen_id()
    c = TaskComment(id=cid, task_id=task.id, author_email=author, body=text,
                    created_at=now_iso(), edited_at="", pinned=False,
                    parent_id=root.id if root is not None else "", reactions={},
                    assignee_email=assignee, resolved_at="", resolved_by="")
    db.add(c)
    task.comment_ids = list(task.comment_ids or []) + [cid]
    task.modified_at = now_iso()   # so a delta fetch (GET /tasks/delta) picks this task up
    aid = log_activity(db, type="commented", actor_email=actor, entity_id=task.id,
                       entity_code=task.code, entity_title=task.title, detail="added a comment")
    task.activity_ids = list(task.activity_ids or []) + [aid]
    # notify every assignee + followers (except author). All the assignees, not
    # just the primary: the comment EMAIL already goes to each of them
    # (task_notify._recipients_for), so pinging only the first here made the
    # bell and the inbox disagree about who is on the task.
    # A reply also reaches everyone already in the thread - they asked the
    # question, or answered it, and are not necessarily on the task.
    in_thread = (thread_participants(db, root) - {actor}) if (notify and root is not None) else set()
    if notify:
        told = set()
        for who in set([*task_assignees(task),
                        *email_list(task.follower_emails)]):
            if who and who != actor and who != assignee:
                told.add(who)
                task_notify(db, kind="task_activity", for_email=who,
                            title="New Reply on a Task" if root is not None else "New Comment on a Task",
                            body=f"{task.title}", task_id=task.id,
                            nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
        for who in in_thread - told - {assignee}:
            task_notify(db, kind="task_activity", for_email=who,
                        title="New Reply in Your Thread", body=f"{task.title}", task_id=task.id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
        if assignee and assignee != actor:
            task_notify(db, kind="task_activity", for_email=assignee, main_bell=True,
                        title="A Comment Was Assigned to You", body=f"{task.title}", task_id=task.id,
                        nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
    db.commit()
    db.refresh(c)
    fire_task_event(task.id, "comment")
    if notify:
        # Lazy: task_notify.py imports this module, so importing it at module
        # level here would be a cycle.
        from task_notify import notify_task_event
        run_after(notify_task_event, task.id, "commented", actor, comment_body=text,
                  thread_participants=sorted(in_thread - {assignee}), reply=root is not None,
                  comment_assignee=assignee)
        if assignee and assignee != actor:
            run_after(notify_task_event, task.id, "comment_assigned", actor, comment_body=text,
                      comment_assignee=assignee)
        # Mentions are their own event so the mail can say "X mentioned you"
        # instead of the generic comment FYI. The author is dropped - mentioning
        # yourself shouldn't email you.
        mentioned = [e for e in extract_mentions(text) if e != actor and e != assignee]
        if mentioned:
            for who in mentioned:
                task_notify(db, kind="task_activity", for_email=who, main_bell=True,
                            title="You Were Mentioned in a Comment",
                            body=f"{task.title}", task_id=task.id,
                            nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
            db.commit()
            run_after(notify_task_event, task.id, "mentioned", actor,
                      comment_body=text, mentioned=mentioned)
    return c


# ── Trash (Aug 27) ────────────────────────────────────────────────────────────
# Moved here from routers/tasks.py's old hard-delete cascade so
# purge_task_permanently (below) and any future caller share one copy.
def _binned_subtree_ids(db: Session, task_id: str) -> list:
    """`task_id` plus every BINNED task under it, however deep (Oct 21 2026 -
    only the direct subtasks went before, and deeper ones were left behind),
    plus anything stamped deleted_with = it. Cycle-safe.

    A LIVE task found under it is not purged: it is made top-level instead,
    so it stays visible rather than vanishing with a parent it no longer
    belonged to (only older data has one - a delete bins the whole subtree
    and a subtask cannot be restored under a binned parent)."""
    q = db.query(Task).execution_options(include_deleted=True)
    ids, seen, frontier = [task_id], {task_id}, [task_id]
    while frontier:
        kids = q.filter(Task.parent_task_id.in_(frontier)).all()
        frontier = []
        for k in kids:
            if k.id in seen:
                continue
            seen.add(k.id)
            if k.deleted_at:
                ids.append(k.id)
                frontier.append(k.id)
            else:
                k.parent_task_id = ""
                k.modified_at = now_iso()
    for k in q.filter(Task.deleted_with == task_id).all():
        if k.id not in seen and k.deleted_at:
            seen.add(k.id)
            ids.append(k.id)
    return ids


def purge_task_permanently(db: Session, task_id: str, actor_email: str = "") -> bool:
    """Permanently remove an already-TRASHED task and everything under it - the
    full cascade delete_task ran immediately before soft delete existed:
    subtasks at every depth (_binned_subtree_ids), comments, attachments.
    Returns False if the id doesn't exist or
    was never trashed (live tasks are never purged from here).

    Its Asana link rows (AsanaTaskLink) are deliberately LEFT: every asana_*
    row is the permanent record of where a task came from and is never deleted
    (CLAUDE.md, "Asana - removed").

    Shared by POST /tasks/{id}/permanent-delete (a manager emptying trash
    early) and task_trash.trash_purge_loop (the automatic 90-day sweep), so
    the cascade can never drift between the two paths.

    The task's own soft-delete tombstone (TaskDeleteLog, written when it was
    first trashed) already told delta clients it was gone - nothing to add.

    Does NOT commit - the caller does, so a sweep purging several tasks can
    commit once per row without this function needing to know about that."""
    t = (db.query(Task).execution_options(include_deleted=True)
           .filter(Task.id == task_id).first())
    if not t or not t.deleted_at:
        return False
    gone_ids = _binned_subtree_ids(db, task_id)
    log_activity(db, type="purged", actor_email=actor_email or t.deleted_by or "",
                entity_id=task_id, entity_code=t.code, entity_title=t.title,
                detail="permanently deleted this task")
    db.query(TaskComment).filter(TaskComment.task_id.in_(gone_ids)).delete(synchronize_session=False)
    db.query(TaskAttachment).filter(TaskAttachment.task_id.in_(gone_ids)).delete(synchronize_session=False)
    db.query(TaskChecklistItem).filter(TaskChecklistItem.task_id.in_(gone_ids)).delete(synchronize_session=False)
    db.query(TaskTimeEntry).filter(TaskTimeEntry.task_id.in_(gone_ids)).delete(synchronize_session=False)
    db.query(Task).execution_options(include_deleted=True).filter(Task.id.in_(gone_ids)).delete(synchronize_session=False)
    return True
