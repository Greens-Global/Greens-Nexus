"""Tasks pack (Workflows, Oct 28 2026 - plan Task 10): the task entity, the
events `routers/task_util.log_activity` emits for it (one activity row ->
one outbox row; a completion is `task.completed`, the row the Tasks history
writes for it), the actions a workflow may take on a task and the overdue
list a schedule loops over.

Every action calls the Tasks module's OWN function as the run-as user:
Create Task goes through `routers.tasks._create_task` under
`task_automation._SUPPRESS` (a task a workflow creates runs no Tasks rule,
exactly as a rule's own create does); Add Comment through
`task_util.create_comment`; Assign and Set Field through
`routers.tasks.update_task`, so Tasks automation rules run on the change as
they would on the owner's own edit (spec 6.2) - the activity rows those
rules write come back through the same emit line, tagged with the current
run by `CURRENT_RUN`. `allowed` runs the module's permission check and
answers with its reason.

The routers are imported lazily inside each function: packs are loaded by
`catalog.load_packs()` from inside a request (the first activity row), and
`routers.tasks` must never be pulled in at pack import.
"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func
from sqlalchemy.orm import object_session

import models
from workflows import catalog
from workflows.catalog import F, P, action, entity, event, list_source

PRIORITIES = [("low", "Low"), ("medium", "Medium"), ("high", "High"), ("urgent", "Urgent")]
TASK_TYPES = [("task", "Task"), ("subtask", "Subtask"), ("milestone", "Milestone"), ("approval", "Approval")]
SET_FIELDS = [("status", "Status"), ("priority", "Priority"), ("custom_field", "Custom Field")]
MAX_LIST = 500


# ── helpers ──────────────────────────────────────────────────────────────────
def _emails(vals) -> list[str]:
    out: list[str] = []
    for v in vals or ():
        for e in str(v or "").split(","):
            e = e.strip().lower()
            if e and e not in out:
                out.append(e)
    return out


def _tu():
    from routers import task_util
    return task_util


def _tasks():
    from routers import tasks
    return tasks


def _task_company(row) -> str:
    db = object_session(row)
    if db is None:
        return (getattr(row, "company_id", "") or "").strip()
    return _tu().row_company(db, row)


def _assignees(db, row) -> list[str]:
    return _emails(_tu().task_assignees(row))


def _creator(db, row) -> list[str]:
    return _emails([row.created_by])


def _owner(db, row) -> list[str]:
    return _emails([row.owner_email])


def _self(db, row) -> list[str]:
    """The task's own person: its owner, else whoever created it (the
    Tasks module's own reading of "the owner")."""
    return _emails([row.owner_email or row.created_by])


def _followers(db, row) -> list[str]:
    return _emails(row.follower_emails or [])


def _project_owner(db, row) -> list[str]:
    p = _tu().project_for_task(db, row)
    return _emails([p.owner_email]) if p is not None else []


def _task_visible(db, user, row) -> bool:
    """The Tasks module's own sight rule: inside the person's company wall
    and `task_visible_to` (managers see everything in their wall; others
    the org tasks and what they own, hold, follow or have a project role
    on). Never an outsider, never a restricted task they are not on."""
    if not user or row is None:
        return False
    import auth
    tu = _tu()
    scope = auth.company_scope(user, db)
    if scope is not None and not auth.company_ok(tu.row_company(db, row), scope):
        return False
    return bool(tu.task_visible_to(db, user, row))


def _label(row) -> str:
    return (row.title or "").strip() or (row.code or "") or (row.id or "")


def _nexus_visible(db, row) -> bool:
    """The Nexus system actor never acts on a restricted task (a private
    project or a task narrowed to its own people)."""
    return not _tu()._restricted(row)


# ── entity ───────────────────────────────────────────────────────────────────
TASK_FIELDS = [
    F("title", "Title", "text"),
    F("code", "Code", "text"),
    F("status", "Status", "select", options="task_statuses"),
    F("priority", "Priority", "select", options=PRIORITIES),
    F("type", "Type", "select", options=TASK_TYPES),
    F("project", "Project", "select", options="task_projects", path="project_id"),
    F("assignees", "Assignees", "people", path="assignee_emails"),
    F("owner", "Owner", "person", path="owner_email"),
    F("creator", "Creator", "person", path="created_by"),
    F("due_date", "Due Date", "date", path="due_on"),
    F("start_date", "Start Date", "date", path="start_on"),
    F("tags", "Labels", "text"),
    F("completed", "Completed", "bool"),
]

entity("task", label="Task", model=models.Task, module="tasks",
       company=_task_company,
       link=lambda row: {"view": "tasks", "sub": "mine", "taskId": row.id},
       people={"self": _self, "assignees": _assignees, "owner": _owner, "creator": _creator,
               "followers": _followers, "project_owner": _project_owner},
       fields=TASK_FIELDS,
       dates=["due_date", "start_date"],
       label_of=_label,
       visible_to=_task_visible,
       nexus_visible=_nexus_visible,
       # `self` is the task's owner: the person an approval about the task
       # may not decide unless the step allows it (allowSelf)
       people_labels={"self": "The Person (Task Owner)", "owner": "Task Owner"})

SAMPLE_TASK = {
    "title": "Replace the gate motor at Escondido", "code": "TASK-1042", "status": "in_progress",
    "priority": "high", "type": "task", "project": "", "assignees": ["sam.lee@greensglobal.com"],
    "owner": "max.miller@greensglobal.com", "creator": "max.miller@greensglobal.com",
    "due_date": "2026-11-05", "start_date": "2026-10-28", "tags": ["maintenance"], "completed": False,
}
_ACTOR = "max.miller@greensglobal.com"


def _sample(changes: dict | None = None, extra: dict | None = None, **over) -> dict:
    return {"subject": dict(SAMPLE_TASK, **over), "changes": dict(changes or {}),
            "extra": dict(extra or {}), "actor": _ACTOR}


# ── events (emitted by routers/task_util.log_activity) ──────────────────────
event("task.created", entity="task", label="Task Is Created", module="tasks", group="Tasks",
      sample=_sample(extra={"activity": "created"}, status="not_started"))
event("task.status_changed", entity="task", label="Task Status Changes", module="tasks", group="Tasks",
      changes=("status",),
      sample=_sample({"status": {"from": "not_started", "to": "in_progress"}}, {"activity": "status_changed"}))
event("task.assigned", entity="task", label="Task Is Assigned", module="tasks", group="Tasks",
      changes=("assignees",),
      sample=_sample({"assignees": {"from": [], "to": ["sam.lee@greensglobal.com"]}},
                     {"activity": "assignee_changed"}))
event("task.completed", entity="task", label="Task Is Completed", module="tasks", group="Tasks",
      changes=("completed",),
      sample=_sample({"completed": {"from": False, "to": True}}, {"activity": "completed"},
                     status="completed", completed=True))
event("task.commented", entity="task", label="Task Gets A Comment", module="tasks", group="Tasks",
      volume="high", sample=_sample(extra={"activity": "commented"}))
event("task.due_date_changed", entity="task", label="Task Due Date Changes", module="tasks", group="Tasks",
      changes=("due_date",),
      sample=_sample({"due_date": {"from": "2026-11-05", "to": "2026-11-12"}}, {"activity": "due_changed"},
                     due_date="2026-11-12"))
event("task.field_changed", entity="task", label="Task Detail Changes", module="tasks", group="Tasks",
      changes=("title", "priority", "project", "tags"),
      sample=_sample({"priority": {"from": "medium", "to": "high"}},
                     {"activity": "field_changed", "field": "Priority"}))


# ── action plumbing ──────────────────────────────────────────────────────────
def _wf_name(ctx) -> str:
    return (getattr(ctx.workflow, "name", "") or "").strip() or "a workflow"


def _render(ctx, text) -> str:
    from workflows.context import render
    out, _ = render(str(text or ""), ctx)
    return out.strip()


def _run_as(ctx) -> dict:
    user = ctx.run_as
    if not user or not (user.get("email") or ""):
        raise RuntimeError("This step needs a person's identity to run as.")
    return user


def _later(ctx):
    from task_automation import _Later
    return _Later(getattr(ctx, "defer", None))


def _people(ctx, spec, cap: int = 20) -> list[str]:
    """Recipient specs -> current directory people, in order, WITHOUT the
    subject-sight check `recipients.resolve` applies to messages: whoever a
    task or ticket is handed to need not already see it - the module's own
    people rules (check_people, active_person, _internal_person, the
    company wall) decide at the call, with their own reasons."""
    from task_automation import _person_user
    from workflows.recipients import expand
    items = spec if isinstance(spec, (list, tuple)) else ([spec] if spec else [])
    out: list[str] = []
    for it in items:
        if isinstance(it, str):
            it = {"kind": "person", "value": it}
        for e in expand(ctx, it):
            if e not in out and _person_user(ctx.db, e) is not None:
                out.append(e)
    return out[:max(1, cap)]


def _names(spec) -> str:
    from workflows.recipients import describe
    return describe(spec)


def _detail(e) -> str:
    d = getattr(e, "detail", None)
    return str(d if d is not None else e)


def _refused(action: str, e) -> RuntimeError:
    return RuntimeError(f"Could not {action}: {_detail(e)}")


def _project_of(db, ref):
    pid = str(ref.get("id") if isinstance(ref, dict) else (ref or "")).strip()
    if not pid:
        return None
    p = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
    if p is None:
        raise RuntimeError("That project no longer exists.")
    return p


def _target_task(ctx):
    """The task a step acts on: the run's subject, or the For Each item."""
    if isinstance(ctx.subject, models.Task):
        return ctx.subject
    item = ctx.item if isinstance(ctx.item, dict) else {}
    if item.get("id"):
        row = ctx.db.get(models.Task, str(item["id"]))
        if row is not None:
            return row
    raise RuntimeError("This step needs a task as its record - use it on a task event or inside For Each over tasks.")


def _subject_task(ctx):
    """The task when the context already names one (None in a dry run
    against a sample)."""
    try:
        return _target_task(ctx)
    except RuntimeError:
        return None


def _task_role_reason(ctx, user: dict, t, min_role: str) -> str:
    from fastapi import HTTPException
    try:
        _tu().require_task_role(ctx.db, user, t, min_role)
    except HTTPException as e:
        return _detail(e)
    return ""


def _affected(t) -> list[dict]:
    return [{"entity": "task", "id": t.id, "label": _label(t)}]


def _us_date(iso: str) -> str:
    from workflows.context import us_date
    return us_date(iso)


# ── task.create ──────────────────────────────────────────────────────────────
def _create_bits(ctx, params) -> dict:
    title = _render(ctx, params.get("title"))[:200]
    project = _project_of(ctx.db, params.get("project"))
    assignees = _people(ctx, params.get("assignee"), cap=1) if params.get("assignee") else []
    due = ""
    if params.get("dueInDays") not in (None, ""):
        due = (ctx.today + timedelta(days=int(params["dueInDays"]))).isoformat()
    priority = str(params.get("priority") or "medium")
    if priority not in {k for k, _ in PRIORITIES}:
        priority = "medium"
    return {"title": title, "project": project, "assignees": assignees, "due": due, "priority": priority}


def _create_plan(ctx, params) -> str:
    b = _create_bits(ctx, params)
    line = f'Would create task "{b["title"] or "(no title)"}"'
    if b["project"] is not None:
        line += f" in {b['project'].name}"
    if b["assignees"]:
        line += f", assigned to {b['assignees'][0]}"
    elif params.get("assignee"):
        line += f", assigned to {_names(params.get('assignee'))}"
    if b["due"]:
        line += f", due {_us_date(b['due'])}"
    return line + f" ({b['priority']} priority)"


def _create_allowed(ctx, params) -> str:
    from fastapi import HTTPException
    user = ctx.run_as
    if not user:
        return "Create Task needs a person's identity."
    try:
        project = _project_of(ctx.db, params.get("project"))
    except RuntimeError as e:
        return str(e)
    try:
        _tu().require_project_access(ctx.db, user, project, "editor")
    except HTTPException as e:
        return _detail(e)
    return ""


def _create_run(ctx, params) -> dict:
    import task_automation
    from fastapi import HTTPException
    user = _run_as(ctx)
    b = _create_bits(ctx, params)
    if not b["title"]:
        raise RuntimeError("Could not create the task: the title is blank.")
    desc = _render(ctx, params.get("description"))
    note = f"Created by Workflow: {_wf_name(ctx)}"
    description = f"{desc}\n\n{note}" if desc else note
    body = _tasks().TaskCreate(title=b["title"], description=description,
                               project_id=b["project"].id if b["project"] is not None else "",
                               assignee_emails=b["assignees"], due_on=b["due"], priority=b["priority"])
    token = task_automation._SUPPRESS.set(True)   # a workflow's task runs no Tasks rule (spec 6.2)
    try:
        made = _tasks()._create_task(body, _later(ctx), user, ctx.db, check_people=True)
    except HTTPException as e:
        ctx.db.rollback()
        raise _refused("create the task", e)
    finally:
        task_automation._SUPPRESS.reset(token)
    line = f'Created task "{b["title"]}"'
    if b["project"] is not None:
        line += f" in {b['project'].name}"
    if made.get("assigneeIds"):
        line += f", assigned to {', '.join(made['assigneeIds'])}"
    dropped = made.get("droppedPeople") or []
    if dropped:
        line += " (left off " + ", ".join(str(d.get("email") or d) for d in dropped) + ")"
    return {"line": line, "affected": [{"entity": "task", "id": made["id"], "label": b["title"]}], "sent": []}


action("task.create", label="Create Task", module="tasks",
       params=[P("title", "Title", "template", max=200),
               P("description", "Description", "template", required=False, max=5000),
               P("project", "Project", "entity_ref", required=False, options="task_projects",
                 hint="Leave blank for a task with no project"),
               P("assignee", "Assign To", "recipients", required=False, hint="The first person resolved"),
               P("dueInDays", "Due In Days", "number", required=False, max=3650),
               P("priority", "Priority", "select", required=False, options=PRIORITIES, default="medium")],
       plan=_create_plan, run=_create_run, allowed=_create_allowed)


# ── task.comment ─────────────────────────────────────────────────────────────
def _comment_text(ctx, params) -> str:
    return f"Workflow: {_wf_name(ctx)} - {_render(ctx, params.get('text'))}"[:5000]


def _comment_plan(ctx, params) -> str:
    return f'Would comment on "{ctx.subject_label() or "the task"}": {_comment_text(ctx, params)}'


def _comment_allowed(ctx, params) -> str:
    user = ctx.run_as
    if not user:
        return "Add Comment needs a person's identity."
    t = _subject_task(ctx)
    return _task_role_reason(ctx, user, t, "commenter") if t is not None else ""


def _comment_run(ctx, params) -> dict:
    user = _run_as(ctx)
    t = _target_task(ctx)
    reason = _task_role_reason(ctx, user, t, "commenter")
    if reason:
        raise RuntimeError(f"Could not comment: {reason}")
    text = _comment_text(ctx, params)
    _tu().create_comment(ctx.db, t, actor_email=user["email"], body=text, defer=_later(ctx).add_task)
    return {"line": f'Commented on "{_label(t)}"', "affected": _affected(t), "sent": []}


action("task.comment", label="Add Comment", module="tasks",
       params=[P("text", "Comment", "template", max=5000)],
       plan=_comment_plan, run=_comment_run, allowed=_comment_allowed)


# ── task.assign ──────────────────────────────────────────────────────────────
def _assign_plan(ctx, params) -> str:
    who = _people(ctx, params.get("to"))
    names = ", ".join(who) if who else _names(params.get("to"))
    verb = "Would assign" if str(params.get("mode") or "add") == "replace" else "Would add"
    return f'{verb} {names} to "{ctx.subject_label() or "the task"}"'


def _assign_allowed(ctx, params) -> str:
    user = ctx.run_as
    if not user:
        return "Assign needs a person's identity."
    t = _subject_task(ctx)
    return _task_role_reason(ctx, user, t, "editor") if t is not None else ""


def _assign_run(ctx, params) -> dict:
    from fastapi import HTTPException
    user = _run_as(ctx)
    t = _target_task(ctx)
    who = _people(ctx, params.get("to"))
    if not who:
        raise RuntimeError("Could not assign: nobody on the Nexus People list resolved.")
    current = _tu().task_assignees(t)
    wanted = who if str(params.get("mode") or "add") == "replace" else _emails(current + who)
    if wanted == current:
        return {"line": f'{", ".join(who)} already on "{_label(t)}"', "affected": _affected(t), "sent": []}
    tasks = _tasks()
    try:
        tasks.update_task(t.id, tasks.TaskUpdate(assignee_emails=wanted), _later(ctx), user=user, db=ctx.db)
    except HTTPException as e:
        ctx.db.rollback()
        raise _refused("assign the task", e)
    return {"line": f'Assigned "{_label(t)}" to {", ".join(wanted)}', "affected": _affected(t), "sent": []}


action("task.assign", label="Assign Task", module="tasks",
       params=[P("to", "Assign To", "recipients"),
               P("mode", "Mode", "select", required=False, options=[("add", "Add To The Assignees"),
                                                                     ("replace", "Replace The Assignees")],
                 default="add")],
       plan=_assign_plan, run=_assign_run, allowed=_assign_allowed)


# ── task.set_field ───────────────────────────────────────────────────────────
def _field_update(ctx, params, t):
    """The TaskUpdate for the field, and the words for it."""
    tasks = _tasks()
    field = str(params.get("field") or "")
    value = _render(ctx, params.get("value"))
    if field == "status":
        return tasks.TaskUpdate(status=value), f"status to {value}"
    if field == "priority":
        return tasks.TaskUpdate(priority=value.lower()), f"priority to {value.lower()}"
    if field == "custom_field":
        fid = str(params.get("customFieldId") or "").strip()
        if not fid:
            raise RuntimeError("Pick the custom field to set.")
        f = ctx.db.get(models.TaskCustomField, fid)
        if f is None:
            raise RuntimeError("That custom field no longer exists.")
        values = dict((t.custom_field_values or {}) if t is not None else {})
        values[fid] = value
        return tasks.TaskUpdate(custom_field_values=values), f"{f.name} to {value or '(blank)'}"
    raise RuntimeError(f"{field or '(blank)'} is not a field this step can set.")


def _set_field_plan(ctx, params) -> str:
    try:
        _upd, words = _field_update(ctx, params, _subject_task(ctx))
    except RuntimeError as e:
        return f"Would not set a field: {e}"
    return f'Would set {words} on "{ctx.subject_label() or "the task"}"'


def _set_field_allowed(ctx, params) -> str:
    user = ctx.run_as
    if not user:
        return "Set Field needs a person's identity."
    if str(params.get("field") or "") == "custom_field" and not str(params.get("customFieldId") or "").strip():
        return "Pick the custom field to set."
    t = _subject_task(ctx)
    return _task_role_reason(ctx, user, t, "editor") if t is not None else ""


def _set_field_run(ctx, params) -> dict:
    from fastapi import HTTPException
    user = _run_as(ctx)
    t = _target_task(ctx)
    upd, words = _field_update(ctx, params, t)
    try:
        _tasks().update_task(t.id, upd, _later(ctx), user=user, db=ctx.db)
    except HTTPException as e:
        ctx.db.rollback()
        raise _refused("set the field", e)
    return {"line": f'Set {words} on "{_label(t)}"', "affected": _affected(t), "sent": []}


action("task.set_field", label="Set Task Field", module="tasks",
       params=[P("field", "Field", "select", options=SET_FIELDS),
               P("customFieldId", "Custom Field", "entity_ref", required=False, options="task_custom_fields",
                 hint="Only for Custom Field"),
               P("value", "Value", "template", max=500)],
       plan=_set_field_plan, run=_set_field_run, allowed=_set_field_allowed)


# ── list sources ─────────────────────────────────────────────────────────────
def _overdue(db, ctx, params) -> list:
    """Open tasks whose due date passed at least `days` days ago, inside the
    workflow's company (when it has one) and the run-as person's sight."""
    days = int(params.get("days") or 0) if isinstance(params, dict) else 0
    cutoff = (ctx.today - timedelta(days=max(0, days))).isoformat()
    company = ctx.company()
    q = (db.query(models.Task)
         .filter(models.Task.completed.isnot(True), models.Task.due_on != "", models.Task.due_on < cutoff,
                 func.coalesce(models.Task.type, "task") != "section")
         .order_by(models.Task.due_on, models.Task.id))
    out = []
    ent = catalog.ENTITIES["task"]
    for t in q.limit(MAX_LIST * 4).all():
        if company and _task_company(t) != company:
            continue
        if not ent.can_see(db, ctx.run_as, t):
            continue
        out.append(t)
        if len(out) >= MAX_LIST:
            break
    return out


list_source("tasks.overdue", label="Overdue Tasks", entity="task", module="tasks",
            params=[P("days", "Days Overdue", "number", required=False, default=0,
                      hint="0 = every task past its due date")],
            fn=_overdue)
