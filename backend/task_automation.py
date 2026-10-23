"""Task automation engine (Oct 2026).

Manage > Automation Rules has let managers write "when X happens, do Y" rules
since the module shipped - and until now nothing ever ran them. The rows were
created, toggled and listed, and that was the whole feature. This module is
the missing half: every rule is a trigger, an optional list of conditions and
an ordered list of actions, evaluated here against a task that just changed.

Where it runs
  * create_task / update_task / bulk_update (routers/tasks.py) call
    `run_for_change` INSIDE the request, after the caller's own edits are on
    the row and before anything is committed. Actions mutate the same ORM row,
    so the caller's existing activity, bell and email logic sees the automated
    change exactly as if the person had made it - one commit, one realtime
    ping, no second code path. The caller merges `Result.changed` into its own
    payload so "the due date moved" is true whoever moved it.
  * `run_scheduled` runs from task_notify's hourly scan for the one trigger
    that is a clock, not an edit: "due date arrives" (N days before, on, or
    after the due date). Once per rule per task per date, through the run log.

What it never does
  * Chain. An action that changes status does NOT fire other rules' "status
    changes" triggers. Rules are evaluated once against the person's change;
    two rules that both match that change both run, in creation order. This is
    deliberate: a chain is how one bad rule reassigns every task in the
    workspace at 3 AM, and nobody here has asked for it.
  * Complete a blocked task. `set_status` to Completed goes through the same
    dependency gate update_task enforces (passed in by the caller as `gate`);
    if the gate refuses, the action is skipped and the run log says why.
  * Post a comment mid-transaction. `add_comment` goes through
    task_util.create_comment, which commits; the engine hands it back as an
    `after_commit` callable so the caller runs it once its own commit landed.

The Monday-recipe actions (Neil, Oct 22 2026)
  * create_task runs AFTER the caller's commit, through routers.tasks
    ._create_task - the POST /tasks path, with its codes, activity, company
    wall, people checks and required fields - as the person whose change
    fired the rule (on the clock: the task's owner), so a rule can never make
    a task that person could not. A refusal (no editor role on the target
    project, a required custom field, another company) lands in the Runs
    panel as "could not create a task: ...", never as an error to the person
    who made the edit. A task an automation creates runs NO rules at all
    (_SUPPRESS) - depth 0, so two rules can never ping-pong - and one change
    creates at most MAX_CREATES_PER_TASK tasks (MAX_CREATES_PER_REQUEST
    across a bulk edit). The clock is guarded too: every task a rule creates
    carries a SPAWNED_EVENT run row, run_scheduled acts on no such task, and
    one scan creates at most MAX_CREATES_PER_SCAN per company. A change made
    by someone outside the directory fails rather than borrowing the owner.
    A restricted task's new task leaves off anyone who cannot see the source.
  * move_to_project is a field change on the same row, like set_status, and
    keeps the move rules update_task applies (section and team left behind,
    the required-field check of _newly_missing_required); the subtasks that
    carry the old project go with it. It never re-fires moved_to_project.
  * send_email never sends mail: it hands notify_task_event an "automation"
    event, which goes through the person's mutes and the batched queue like
    every task email. Only Nexus directory people who can SEE the task get
    it (recipient_can_see), checked again when the batch goes out.
  * A restricted task is never copied (create_task) or moved
    (move_to_project) into another project by a rule: its title would reach
    people who cannot see it.

Every rule that fires writes a TaskAutomationRun row (the Runs panel in
Manage) and one activity entry on the task attributed to AUTOMATION_ACTOR, so
"why did this task's priority change?" has an answer in the task itself.
"""
from __future__ import annotations

import contextvars
import functools
import html
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Callable, Optional
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
from routers.task_util import (
    gen_id, now_iso, log_activity, task_assignees, set_task_assignees, email_list,
    create_comment, fire_task_event, task_notify, row_company,
)
import task_due
import task_history
from task_labels import label_key as _label_key

# The "person" automated changes are attributed to - activity rows and the
# author of an `add_comment`. Not a mailbox: the frontend's name resolver
# falls back to the local part, so it reads as "Automation" everywhere a
# person's name would.
AUTOMATION_ACTOR = "automation@nexus"

TRIGGER_TYPES = (
    "created",            # a task is created
    "status_changed",     # value: status id, or "" for any change
    "priority_changed",   # value: priority, or "" for any change
    "assignee_changed",   # value: email that must be among the people ADDED, or "" for any change
    "moved_to_project",   # value: project id the task landed in, or "" for any move
    "completed_early",    # completed before its due date
    "due_date_arrives",   # SCHEDULED. value: days relative to the due date (-2 = two days before, 0 = on, 3 = three days after)
    "custom_field_changed",  # value: {fieldId, to?} - to: option id (select), an option it now includes (multiselect), "checked" / "unchecked" (checkbox), else the value; blank = any change
    "due_date_changed",   # the due date moved (set, cleared or changed)
)
ACTION_TYPES = (
    "set_status", "set_priority", "add_tag", "set_milestone",
    "assign_to",        # value: email - replaces the assignees
    "add_assignee",     # value: email - added alongside the current assignees
    "add_follower",     # value: email
    "set_due_in_days",  # value: N - due date becomes today + N
    "shift_due_days",   # value: N - due date moves by N days from where it is (from today when it has none)
    "add_comment",      # value: text; {title} {assignee} {due} {priority} {status} are filled in
    "create_task",      # value: {title, projectId?, asSubtask?, assignee? (email | "{assignee}"), dueInDays?, priority?}
    "move_to_project",  # value: {projectId, sectionId?}
    "send_email",       # value: {to: assignees | creator | followers | project_owner | a directory email, subject, body}
    "set_custom_field",  # value: {fieldId, value} - a blank value clears the field
)
CONDITION_FIELDS = ("project", "status", "priority", "tag", "assignee", "team",
                    "custom_field")   # custom_field: {field, fieldId, op, value} - value read like a trigger's "to"
EMAIL_TO = ("assignees", "creator", "followers", "project_owner")
# A computed custom field type (another branch, Oct 2026): calculated on read,
# never stored, and saved with read_only=False - only its serialization says
# readOnly. A rule can neither watch, test nor set one; checked by type.
FORMULA_TYPE = "formula"
CONDITION_OPS = ("is", "is_not")
PRIORITIES = ("low", "medium", "high", "urgent")

MAX_CONDITIONS = 10
MAX_ACTIONS = 6
MAX_CREATES_PER_TASK = 3       # tasks one change to one task can create, every rule together
MAX_CREATES_PER_REQUEST = 25   # ...and one bulk edit, across all its rows
MAX_CREATES_PER_SCAN = 50      # ...and one hourly run_scheduled call, per company
# The TaskAutomationRun row that marks a task a rule created (event, plus
# task_id = the new task). run_scheduled acts on no task carrying it, so a
# "due date arrives -> create a task due today" rule cannot feed itself (or
# another such rule) every hour. Kept out of the Runs panel.
SPAWNED_EVENT = "spawned"
MAX_TITLE = 200
MAX_SUBJECT = 200
MAX_BODY = 5000
MAX_DUE_DAYS = 3650

# Set while an automation is creating a task: that task's own create runs no
# rules (see the module docstring). A ContextVar, not a flag on the session,
# so a request on another thread is never affected.
_SUPPRESS: contextvars.ContextVar = contextvars.ContextVar("task_automation_suppress", default=False)


# ── Validation (shared by the CRUD endpoints) ────────────────────────────────
def _spec(value) -> dict:
    """An object-valued trigger / action's value, or {} for anything else."""
    return value if isinstance(value, dict) else {}


def _check_field(db: Optional[Session], field_id, company_id: str):
    """The custom field a rule names must exist and, for a company's rule, be
    shared or that company's own. None without a db (a bare shape check)."""
    if not (isinstance(field_id, str) and field_id.strip()):
        raise HTTPException(422, "Pick a custom field")
    if db is None:
        return None
    f = db.query(models.TaskCustomField).filter(models.TaskCustomField.id == field_id).first()
    if f is None:
        raise HTTPException(422, "That custom field no longer exists")
    if (f.type or "") == FORMULA_TYPE:
        raise HTTPException(422, f"{f.name} is a formula field - it is calculated, never stored, "
                                 "so a rule cannot watch, test or set it")
    fc = (getattr(f, "company_id", "") or "").strip()
    if company_id and fc and fc != company_id:
        raise HTTPException(422, "That custom field belongs to another company")
    return f


def _check_project(db: Optional[Session], project_id, company_id: str):
    """A project a rule creates tasks in or moves tasks to: it must exist (a
    binned one is invisible to the query) and, for a company's rule, be that
    company's - so a rule can never reach across the wall."""
    if not (isinstance(project_id, str) and project_id.strip()):
        raise HTTPException(422, "Pick a project")
    if db is None:
        return None
    p = db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
    if p is None:
        raise HTTPException(422, "That project no longer exists")
    if company_id and row_company(db, p) != company_id:
        raise HTTPException(422, "That project belongs to another company")
    return p


def _check_person(db: Optional[Session], email, company_id: str) -> None:
    """A person a rule names by address: a current Nexus directory person
    (the People list, never an outside address), on the rule's company's side."""
    if not (isinstance(email, str) and "@" in email):
        raise HTTPException(422, "Pick a person")
    if db is None:
        return
    emp = _employee(db, email)
    who = email.strip().lower()
    if emp is None or (emp.status or "") in ("inactive", "offboarded"):
        raise HTTPException(422, f"{who} is not in the Nexus directory")
    if company_id and (emp.company or "") and emp.company != company_id:
        raise HTTPException(422, f"{who} is in another company")


def _check_text(value, what: str, limit: int) -> None:
    if not (isinstance(value, str) and value.strip()):
        raise HTTPException(422, f"The {what} is required")
    if len(value) > limit:
        raise HTTPException(422, f"The {what} can be at most {limit} characters")


def _check_action(db: Optional[Session], kind: str, value, company_id: str) -> None:
    """The newer, object-valued actions (Oct 22 2026)."""
    spec = _spec(value)
    if kind == "create_task":
        _check_text(spec.get("title"), "new task's title", MAX_TITLE)
        if spec.get("projectId") and not spec.get("asSubtask"):
            _check_project(db, spec.get("projectId"), company_id)
        who = spec.get("assignee") or ""
        if who and who != "{assignee}":
            _check_person(db, who, company_id)
        days = spec.get("dueInDays")
        if days not in (None, ""):
            try:
                n = int(days)
            except (TypeError, ValueError):
                raise HTTPException(422, "Days must be a whole number")
            if abs(n) > MAX_DUE_DAYS:
                raise HTTPException(422, f"Days can be at most {MAX_DUE_DAYS}")
        if spec.get("priority") and spec.get("priority") not in PRIORITIES:
            raise HTTPException(422, "Pick a priority")
    elif kind == "move_to_project":
        _check_project(db, spec.get("projectId"), company_id)
        sid = spec.get("sectionId") or ""
        if sid and db is not None:
            sec = db.query(models.TaskSection).filter(models.TaskSection.id == sid).first()
            if sec is None or (sec.project_id or "") != spec.get("projectId"):
                raise HTTPException(422, "That section is not in the project")
    elif kind == "send_email":
        if spec.get("to") not in EMAIL_TO:
            _check_person(db, spec.get("to"), company_id)
        _check_text(spec.get("subject"), "email subject", MAX_SUBJECT)
        _check_text(spec.get("body"), "email message", MAX_BODY)
    elif kind == "set_custom_field":
        f = _check_field(db, spec.get("fieldId"), company_id)
        if f is not None and f.read_only:
            raise HTTPException(422, "That custom field is read-only")
        v = spec.get("value")
        if not isinstance(v, (str, bool, int, float, list, type(None))):
            raise HTTPException(422, "The custom field value is not valid")


def validate_rule(trigger: dict | None, conditions: list | None, actions: list | None,
                  db: Optional[Session] = None, company_id: str = "") -> None:
    """422 for a rule the engine could not run. Kept loose on VALUES on
    purpose - a status that is deleted later must not make the rule unsaveable,
    it just stops matching. The objects the newer triggers and actions name
    (a custom field, a project, a section, a person) are checked against the
    database when the endpoint passes `db`, and against the rule's company
    (`company_id`, '' = shared) so a company's rule never names another
    company's project, field or person."""
    company_id = (company_id or "").strip()
    trigger = trigger or {}
    if trigger.get("type") not in TRIGGER_TYPES:
        raise HTTPException(422, "Choose a trigger")
    if trigger.get("type") == "due_date_arrives":
        try:
            int(trigger.get("value") or 0)
        except (TypeError, ValueError):
            raise HTTPException(422, "Days before or after the due date must be a whole number")
    if trigger.get("type") == "custom_field_changed":
        spec = _spec(trigger.get("value"))
        _check_field(db, spec.get("fieldId"), company_id)
        if spec.get("to") not in (None, "") and not isinstance(spec.get("to"), (str, bool, int, float)):
            raise HTTPException(422, "Pick the value the field changes to")
    conds = conditions or []
    if len(conds) > MAX_CONDITIONS:
        raise HTTPException(422, f"At most {MAX_CONDITIONS} conditions")
    for c in conds:
        if not isinstance(c, dict) or c.get("field") not in CONDITION_FIELDS or c.get("op", "is") not in CONDITION_OPS:
            raise HTTPException(422, "A condition is incomplete")
        if c.get("field") == "custom_field":
            _check_field(db, c.get("fieldId"), company_id)
            if c.get("value") in (None, "") or not isinstance(c.get("value"), (str, bool, int, float)):
                raise HTTPException(422, "A custom field condition needs a value")
    acts = actions or []
    if not acts:
        raise HTTPException(422, "Add at least one action")
    if len(acts) > MAX_ACTIONS:
        raise HTTPException(422, f"At most {MAX_ACTIONS} actions")
    for a in acts:
        if not isinstance(a, dict) or a.get("type") not in ACTION_TYPES:
            raise HTTPException(422, "An action is incomplete")
        kind, value = a.get("type"), a.get("value")
        if kind in ("set_due_in_days", "shift_due_days"):
            try:
                int(value)
            except (TypeError, ValueError):
                raise HTTPException(422, "Days must be a whole number")
        elif kind in ("assign_to", "add_assignee", "add_follower"):
            if not (isinstance(value, str) and "@" in value):
                raise HTTPException(422, "Pick a person for the assign action")
        elif kind == "set_priority" and value not in PRIORITIES:
            raise HTTPException(422, "Pick a priority")
        elif kind in ("set_status", "add_tag", "add_comment") and not (isinstance(value, str) and value.strip()):
            raise HTTPException(422, "The action needs a value")
        elif kind in ("create_task", "move_to_project", "send_email", "set_custom_field"):
            _check_action(db, kind, value, company_id)


# ── Snapshots and matching ───────────────────────────────────────────────────
def snapshot(t: models.Task) -> dict:
    """The fields triggers and conditions read, frozen. Taken BEFORE the
    caller's edits (the "before") and again as the engine starts (the
    "after"), so every rule is matched against the change the PERSON made -
    never against what an earlier rule in the same pass just wrote."""
    return {
        "status": t.status or "",
        "priority": t.priority or "",
        "assignees": tuple(task_assignees(t)),
        "project_id": t.project_id or "",
        "project_ids": tuple(t.project_ids or []),
        "team_id": t.team_id or "",
        # By label key (task_labels.label_key): spacing and case variants of
        # one label are one label, here as on every screen.
        "tags": tuple(_label_key(x) for x in (t.tags or [])),
        "due_on": (t.due_on or "")[:10],
        "completed": bool(t.completed),
        # Copied, lists included: the JSON column's dict can be edited in
        # place later in the request, and the "before" must not move with it.
        "custom": {k: (list(v) if isinstance(v, list) else v)
                   for k, v in (t.custom_field_values or {}).items()}
                  if isinstance(t.custom_field_values, dict) else {},
    }


def _cf_empty(v) -> bool:
    """An unset custom field: absent, blank, an empty list, or an unticked
    checkbox (coerce stores False, a task never edited has nothing)."""
    return v is None or v is False or v == "" or v == []


def _cf_hit(current, wanted) -> bool:
    """Whether a custom field's stored value `current` is `wanted` - the rule
    a trigger's "to" and a condition's value share. Option ids for select and
    multiselect (a list "is" a value it includes), "checked" / "unchecked" for
    a checkbox, an email a people field includes, the number for a number,
    else the text, ignoring case."""
    if isinstance(wanted, bool):
        wanted = "checked" if wanted else "unchecked"
    w = str(wanted if wanted is not None else "").strip().lower()
    if w in ("checked", "unchecked") and (isinstance(current, bool) or current is None):
        return bool(current) == (w == "checked")
    if isinstance(current, list):
        return any(str(x).strip().lower() == w for x in current)
    if _cf_empty(current):
        return False
    if isinstance(current, (int, float)) and not isinstance(current, bool):
        try:
            return float(w) == float(current)
        except ValueError:
            return False
    return str(current).strip().lower() == w


BUSINESS_TZ = "America/Los_Angeles"


def business_today() -> date:
    """Today where the company works, not where the server runs (Azure is UTC,
    so after 5 PM Pacific `date.today()` is already tomorrow). The scheduled
    scan (task_notify._business_today) reads the same clock."""
    return datetime.now(ZoneInfo(BUSINESS_TZ)).date()


def _matches_trigger(trigger: dict, event: str, before: dict, after: dict, *,
                     completing: bool, today: date) -> bool:
    kind = trigger.get("type")
    value = trigger.get("value")
    value = (value or "") if isinstance(value, str) else value
    if kind == "created":
        return event == "created"
    if event == "created":
        # A brand-new task has no "before" - only the created trigger reads it.
        return False
    if kind == "status_changed":
        return after["status"] != before["status"] and (not value or after["status"] == value)
    if kind == "priority_changed":
        return after["priority"] != before["priority"] and (not value or after["priority"] == value)
    if kind == "assignee_changed":
        now, was = set(after["assignees"]), set(before["assignees"])
        if now == was:
            return False
        return (not value) or (str(value).lower() in (now - was))
    if kind == "moved_to_project":
        return (after["project_id"] != before["project_id"] and bool(after["project_id"])
                and (not value or after["project_id"] == value))
    if kind == "completed_early":
        # `completing` comes from the caller: the engine runs before
        # _apply_completion lands the flag, so the row itself cannot say yet.
        if not completing:
            return False
        return bool(after["due_on"]) and today.isoformat() < after["due_on"]
    if kind == "due_date_changed":
        return after["due_on"] != before["due_on"]
    if kind == "custom_field_changed":
        spec = _spec(trigger.get("value"))
        fid = spec.get("fieldId") or ""
        was, now = before.get("custom", {}).get(fid), after.get("custom", {}).get(fid)
        if (_cf_empty(was) and _cf_empty(now)) or was == now:
            return False
        to = spec.get("to")
        if to in (None, ""):
            return True
        if isinstance(now, list):
            # Multiselect / people: the change ADDED that option (or person) -
            # ticking a second option on a task that already had it is not
            # "changed to" it.
            return _cf_hit(now, to) and not _cf_hit(was if isinstance(was, list) else [], to)
        return _cf_hit(now, to)
    return False   # due_date_arrives only fires from run_scheduled


def _watched_fields(rule: models.TaskAutomationRule) -> set:
    """The custom fields a rule's trigger and conditions read."""
    trigger = rule.trigger if isinstance(rule.trigger, dict) else {}
    out = set()
    if trigger.get("type") == "custom_field_changed":
        out.add(_spec(trigger.get("value")).get("fieldId") or "")
    for c in (rule.conditions if isinstance(rule.conditions, list) else []):
        if isinstance(c, dict) and c.get("field") == "custom_field":
            out.add(c.get("fieldId") or "")
    return out - {""}


def _reads_a_formula(db: Session, rule: models.TaskAutomationRule, cache: dict) -> bool:
    """A rule saved before its field became a formula (or written around the
    validator) never runs: a formula has no stored value to watch or test.
    The formula ids are read once per pass, and only for a rule that reads a
    custom field at all."""
    fields = _watched_fields(rule)
    if not fields:
        return False
    if "formula" not in cache:
        cache["formula"] = {i for (i,) in db.query(models.TaskCustomField.id)
                            .filter(models.TaskCustomField.type == FORMULA_TYPE).all()}
    return bool(fields & cache["formula"])


def conditions_ok(conditions: list | None, snap: dict) -> bool:
    """`snap` is a snapshot() - the task as the person left it."""
    for c in conditions or []:
        f, op, v = c.get("field"), c.get("op", "is"), c.get("value")
        v = (v or "").strip().lower() if isinstance(v, str) else v
        if f == "custom_field":
            # The raw value, not `v`: _cf_hit has its own matching rules.
            hit = _cf_hit(snap.get("custom", {}).get(c.get("fieldId") or ""), c.get("value"))
        elif f == "project":
            hit = bool(v) and (snap["project_id"] == v or v in snap["project_ids"])
        elif f == "status":
            hit = snap["status"] == v
        elif f == "priority":
            hit = snap["priority"] == v
        elif f == "tag":
            hit = _label_key(c.get("value")) in snap["tags"]
        elif f == "assignee":
            hit = v in snap["assignees"]
        elif f == "team":
            hit = snap["team_id"] == v
        else:
            hit = False
        if op == "is" and not hit:
            return False
        if op == "is_not" and hit:
            return False
    return True


# ── Actions ──────────────────────────────────────────────────────────────────
@dataclass
class Result:
    changed: dict = field(default_factory=dict)     # task fields the automation wrote, for the caller to merge into its payload
    applied: list = field(default_factory=list)     # human lines, one per action
    after_commit: list = field(default_factory=list)  # callables(db, defer) to run once the caller has committed
    rule_ids: list = field(default_factory=list)
    creates: int = 0                                 # tasks create_task actions asked for in this pass
    # Field history (Oct 22 2026): the task as the rules found it, as they
    # left it, and the fields they moved - task_history.record_edit credits
    # the person with the rest. None / empty when no rule changed a recorded
    # field.
    history_mid: Optional[dict] = None
    history_post: Optional[dict] = None
    history_keys: set = field(default_factory=set)


@dataclass
class _RunCtx:
    """What an action needs beyond the task: the rule (its name and company),
    who made the change (the person a created task is created AS), the run
    row once it is written (`ref["id"]`, for the after-commit actions to
    report back to), and the create budget shared across one request."""
    rule: models.TaskAutomationRule
    actor: str = ""
    ref: dict = field(default_factory=dict)
    budget: dict = field(default_factory=dict)   # {"creates": n, "limit": N, "scope": words for the run log}
    # Who a created task is created as when NOBODY made the change (the
    # scheduled scan): the task's owner, then its creator. Never used when
    # there is an actor - a change by someone outside the directory fails
    # rather than borrowing the owner's access.
    fallbacks: tuple = ()


def _employee(db: Session, email: str):
    from sqlalchemy import func
    who = (email or "").strip().lower()
    if not who:
        return None
    return (db.query(models.NexusEmployee)
            .filter(func.lower(models.NexusEmployee.work_email) == who).first())


def _person_user(db: Session, email: str) -> Optional[dict]:
    """The user dict get_current_user would build for a CURRENT directory
    person (as ticket_inbound._user_for does), or None - the identity the
    permission checks take when the engine acts as someone or asks what
    they can see. An external (guest) is never elevated, as at sign-in."""
    import auth
    who = (email or "").strip().lower()
    if not who or "@" not in who or who == AUTOMATION_ACTOR:
        return None
    emp = _employee(db, who)
    if emp is None or (emp.status or "") in ("inactive", "offboarded"):
        return None
    if (getattr(emp, "identity_type", "") or "internal") in ("guest", "external"):
        return {"email": who, "role": "employee", "level": 1, "external": True}
    role, level = auth._role_for(who, db)
    return {"email": who, "role": role, "level": level}


def recipient_can_see(db: Session, email: str, t: models.Task) -> bool:
    """Whether `email` may be sent an automation email about `t`: a current
    directory person (person_problem: not offboarded, on the task's side of
    the company wall when the walls are on), inside their own company scope,
    and able to see the task by the same rule the lists apply
    (task_visible_to) - so a restricted task never reaches anyone it is
    hidden from. task_notify re-asks this when a held batch goes out."""
    import auth
    from routers.task_util import person_problem, task_visible_to
    u = _person_user(db, email)
    if u is None or person_problem(db, t, u["email"]):
        return False
    scope = auth.company_scope(u, db)
    if scope is not None and not auth.company_ok(row_company(db, t), scope):
        return False
    return task_visible_to(db, u, t)


def _amend_run(db: Session, ref: dict, old_line: str, new_line: str, *, failed: bool = False) -> None:
    """Rewrite one line of a run row once an after-commit action knows how it
    went ("creating task X" -> "created task X" / "could not create a task:
    ..."). A run whose every line failed reads as an error in the Runs panel;
    one with some lines through reads as partial. Commits."""
    run_id = (ref or {}).get("id")
    if not run_id:
        return
    run = db.query(models.TaskAutomationRun).filter(models.TaskAutomationRun.id == run_id).first()
    if run is None:
        return
    lines = list(run.actions or [])
    if old_line in lines:
        lines[lines.index(old_line)] = new_line
    else:
        lines.append(new_line)
    run.actions = lines
    failures = [ln for ln in lines if ln.startswith("could not ")]
    if failures:
        run.status = "error" if len(failures) == len(lines) else "partial"
        run.detail = "; ".join(failures)[:500]
    db.commit()


class _Later:
    """BackgroundTasks' add_task for code that may have none: hands the call
    to the request's queue when there is one, else runs it now (a bulk edit
    and the scheduled scan already run on a worker thread)."""
    def __init__(self, defer=None):
        self._defer = defer

    def add_task(self, fn, *args, **kwargs):
        if self._defer is not None:
            self._defer(fn, *args, **kwargs)
        else:
            fn(*args, **kwargs)


def _label_status(db: Session, status_id: str) -> str:
    builtin = {"not_started": "Not Started", "in_progress": "In Progress", "completed": "Completed",
               "recurring": "Recurring"}
    if status_id in builtin:
        return builtin[status_id]
    row = db.query(models.TaskCustomStatus.label).filter(models.TaskCustomStatus.id == status_id).first()
    return row.label if row else status_id


def _us(iso: str) -> str:
    try:
        y, m, d = iso[:10].split("-")
        return f"{int(m):02d}/{int(d):02d}/{y}"
    except Exception:
        return iso


def _fill(template: str, db: Session, t: models.Task) -> str:
    """{title} {assignee} {due} {priority} {status} {project} in an add_comment,
    a created task's title or an email's subject and message. Plain text out:
    every caller escapes it where it becomes HTML (the comment body here, the
    email template in task_mail_templates). One pass, so a task titled
    "{due}" stays "{due}" rather than being filled in again."""
    import re
    from routers.task_util import project_for_task
    names = []
    for e in task_assignees(t):
        emp = (db.query(models.NexusEmployee.first_name, models.NexusEmployee.last_name)
               .filter(models.NexusEmployee.work_email == e).first())
        names.append(f"{emp.first_name} {emp.last_name}".strip() if emp else e)
    project = project_for_task(db, t)
    values = {
        "title": t.title or "",
        "assignee": ", ".join(names) or "nobody",
        "due": _us(t.due_on) if t.due_on else "no due date",
        "priority": (t.priority or "").capitalize(),
        "status": _label_status(db, t.status or ""),
        "project": project.name if project else "no project",
    }
    return re.sub(r"\{(title|assignee|due|priority|status|project)\}", lambda m: values[m.group(1)], template)


def _apply_action(db: Session, t: models.Task, action: dict, res: Result, *, today: date,
                  gate: Optional[Callable], prev_status: str, prev_completed: bool,
                  run: Optional[_RunCtx] = None, company_cache: Optional[dict] = None) -> str:
    """Apply one action to `t`. Returns the human line for the run log, or ""
    when the action was a no-op (already in that state)."""
    kind = action.get("type")
    value = action.get("value")
    if kind in ("create_task", "send_email", "move_to_project", "set_custom_field"):
        if run is None:
            return ""
        cache = company_cache if company_cache is not None else {}
        if kind == "create_task":
            return _queue_create_task(db, t, _spec(value), res, run, today)
        if kind == "send_email":
            return _queue_email(t, _spec(value), res, run)
        if kind == "move_to_project":
            return _move_to_project(db, t, _spec(value), res, run, cache)
        return _set_custom_field(db, t, _spec(value), res, cache)
    if kind == "set_status":
        if (t.status or "") == value:
            return ""
        if value not in _valid_status_ids(db):
            # A custom status deleted after the rule was written. Writing the
            # dangling id would put the task in a phantom board column.
            return "skipped setting status: that status no longer exists"
        completing = value == "completed"
        if gate is not None:
            try:
                gate(prev_status, prev_completed, value, completing or prev_completed)
            except HTTPException as e:
                return f"skipped setting status: {e.detail}"
        t.status = value
        res.changed["status"] = value
        return f"set status to {_label_status(db, value)}"
    if kind == "set_priority":
        if (t.priority or "") == value:
            return ""
        t.priority = value
        res.changed["priority"] = value
        return f"set priority to {str(value).capitalize()}"
    if kind == "add_tag":
        tag = " ".join(str(value or "").split())
        tags = list(t.tags or [])
        if not tag or _label_key(tag) in [_label_key(x) for x in tags]:
            return ""
        t.tags = tags + [tag]
        res.changed["tags"] = t.tags
        return f"added tag {tag}"
    if kind == "set_milestone":
        if t.is_milestone:
            return ""
        t.is_milestone = True
        res.changed["is_milestone"] = True
        return "marked as milestone"
    if kind in ("assign_to", "add_assignee"):
        who = str(value or "").strip().lower()
        current = task_assignees(t)
        if (kind == "assign_to" and current == [who]) or (kind == "add_assignee" and who in current):
            return ""
        set_task_assignees(t, [who] if kind == "assign_to" else current + [who])
        res.changed["assignee_emails"] = task_assignees(t)
        return f"assigned to {who}" if kind == "assign_to" else f"added {who} as an assignee"
    if kind == "add_follower":
        who = str(value or "").strip().lower()
        followers = email_list(t.follower_emails)
        if who in followers:
            return ""
        t.follower_emails = followers + [who]
        res.changed["follower_emails"] = t.follower_emails
        return f"added {who} as a collaborator"
    if kind in ("set_due_in_days", "shift_due_days"):
        n = int(value)
        if kind == "set_due_in_days" or not t.due_on:
            base = today
        else:
            base = date.fromisoformat(t.due_on[:10])
        new = (base + timedelta(days=n)).isoformat()
        if (t.due_on or "")[:10] == new:
            return ""
        t.due_on = new
        res.changed["due_on"] = new
        return f"set due date to {_us(new)}"
    if kind == "add_comment":
        text = _fill(str(value or ""), db, t)
        body = "<p>" + html.escape(text).replace("\n", "<br>") + "</p>"

        def _post(db2: Session, defer=None, notify: bool = True, assigned=None, _tid=t.id, _body=body):
            # Inside a grouped run (`assigned`, the task import) a comment is
            # posted silently: the import is the one announcement, not a
            # comment bell per imported task.
            task = db2.query(models.Task).filter(models.Task.id == _tid).first()
            if task is not None:
                create_comment(db2, task, actor_email=AUTOMATION_ACTOR, body=_body, defer=defer,
                               notify=notify and assigned is None)
        res.after_commit.append(_post)
        return "added a comment"
    return ""


def _task_company(db: Session, t: models.Task, cache: dict) -> str:
    if "company" not in cache:
        cache["company"] = row_company(db, t)
    return cache["company"]


def _cf_label(f: models.TaskCustomField, v) -> str:
    """A custom field value as the run log and the Activity tab print it."""
    from routers.task_config import normalize_field_options
    if isinstance(v, bool):
        return "checked" if v else "unchecked"
    opts = {o["id"]: o["label"] for o in normalize_field_options(f.options or [])}
    if isinstance(v, list):
        return ", ".join(opts.get(str(x), str(x)) for x in v)
    if (f.type or "") == "date":
        return _us(str(v))
    return opts.get(str(v), str(v))


# ── create_task ──────────────────────────────────────────────────────────────
def _queue_create_task(db: Session, t: models.Task, spec: dict, res: Result, run: _RunCtx,
                       today: date) -> str:
    """Counts the task against the per-change and per-request caps and hands
    the create to after-commit (_create_after_commit) - _create_task commits,
    and the caller's own edit is not committed yet."""
    total = int(run.budget.get("creates", 0) or 0)
    limit = int(run.budget.get("limit") or MAX_CREATES_PER_REQUEST)
    if res.creates >= MAX_CREATES_PER_TASK:
        return f"could not create a task: one change can create at most {MAX_CREATES_PER_TASK} tasks"
    if total >= limit:
        if not run.budget.get("logged"):
            run.budget["logged"] = True
            logging.getLogger(__name__).warning(
                "task automation: create_task budget hit (%s, %d tasks) - rule %s", run.budget.get("scope")
                or "one bulk edit", limit, run.rule.id)
        return f"could not create a task: {run.budget.get('scope') or 'one bulk edit'} can create at most {limit} tasks"
    res.creates += 1
    run.budget["creates"] = total + 1
    title = " ".join(_fill(str(spec.get("title") or ""), db, t).split())[:MAX_TITLE] or "Untitled task"
    line = f'creating task "{title}"'
    res.after_commit.append(functools.partial(
        _create_after_commit, task_id=t.id, spec=dict(spec), title=title, actor=run.actor,
        fallbacks=tuple(run.fallbacks), ref=run.ref, line=line, rule_id=run.rule.id,
        rule_name=run.rule.name or "",
        rule_company=(getattr(run.rule, "company_id", "") or "").strip(), today=today))
    return line


def _create_after_commit(db: Session, defer=None, *, task_id: str, spec: dict, title: str, actor: str,
                         ref: dict, line: str, rule_id: str, rule_name: str, rule_company: str, today: date,
                         fallbacks: tuple = (), notify: bool = True, assigned: dict | None = None) -> None:
    """Create the task through routers.tasks._create_task (the POST /tasks
    path) as the person whose change fired the rule. Only when nobody made
    the change (the scheduled scan) is it the task's owner, else its creator
    (`fallbacks`). Any refusal is written onto the run; nothing is raised.

    `notify=False` (a silent task import) creates it quietly: no bell, no
    email, no project-follower notice. `assigned` ({email: [task id]}, a
    grouped run - the task import) creates it quietly too and adds the people
    it was assigned to, so the caller tells each of them ONCE for the lot."""
    from routers.tasks import _create_task, TaskCreate
    from routers.task_util import project_for_task

    def fail(why: str) -> None:
        _amend_run(db, ref, line, f"could not create a task: {why}", failed=True)

    token = _SUPPRESS.set(True)   # the new task runs no rules (see the module docstring)
    try:
        src = db.query(models.Task).filter(models.Task.id == task_id).first()
        if src is None:
            return fail("the task that fired the rule is gone")
        as_sub = bool(spec.get("asSubtask"))
        home = project_for_task(db, src)
        home_id = home.id if home else ""
        if as_sub:
            project_id, parent_id = (src.project_id or ""), src.id
        else:
            project_id, parent_id = ((spec.get("projectId") or "").strip() or home_id), ""
        restricted = (src.access_level or "org") != "org"
        if restricted and not as_sub and project_id != home_id:
            return fail("the task is restricted, so a rule does not copy it into another project")
        project = (db.query(models.TaskProject).filter(models.TaskProject.id == project_id).first()
                   if project_id else None)
        if project_id and project is None:
            return fail("that project no longer exists")
        if project is not None and rule_company and not as_sub and row_company(db, project) != rule_company:
            return fail("that project is in another company")
        who = (spec.get("assignee") or "").strip().lower()
        assignees = task_assignees(src) if who == "{assignee}" else ([who] if who else [])
        left_off = []
        if restricted:
            # The new task carries the restricted task's title (through
            # {title}) and is restricted itself, so being put on it would
            # show a person what they cannot see on the source. Whoever
            # cannot see the source is left off, in every mode.
            left_off = [a for a in assignees if not recipient_can_see(db, a, src)]
            assignees = [a for a in assignees if a not in left_off]
        due = ""
        if spec.get("dueInDays") not in (None, ""):
            due = (today + timedelta(days=int(spec["dueInDays"]))).isoformat()
        if actor:
            user = _person_user(db, actor)
            if user is None:
                return fail(f"{actor} made the change and is not in the Nexus directory")
        else:
            user = next((u for u in (_person_user(db, e) for e in fallbacks) if u), None)
            if user is None:
                return fail("nobody to create it as - the task's owner and creator are not in the Nexus directory")
        body = TaskCreate(
            title=title, project_id=project_id, parent_task_id=parent_id, assignee_emails=assignees,
            due_on=due, priority=spec.get("priority") if spec.get("priority") in PRIORITIES else "medium",
            # A subtask of a restricted task, or a copy in its own project,
            # stays restricted - never wider than the task it came from.
            access_level=(src.access_level if restricted else None))

        def _note(new: models.Task) -> None:
            new.activity_ids = list(new.activity_ids or []) + [log_activity(
                db, type="automation", actor_email=AUTOMATION_ACTOR, entity_id=new.id,
                entity_code=new.code, entity_title=new.title,
                detail=f"{rule_name}: created this task from {src.title or 'a task'}")]
            # The marker (SPAWNED_EVENT), in the same commit as the task: the
            # scheduled scan never acts on a task a rule made.
            db.add(models.TaskAutomationRun(
                id=gen_id(), rule_id=rule_id, rule_name=rule_name, task_id=new.id, task_code=new.code or "",
                task_title=new.title or "", trigger_type="", event=SPAWNED_EVENT,
                actions=[f"created from task {src.code or src.id}"], status="applied",
                dedupe_key=f"{SPAWNED_EVENT}:{new.id}", at=now_iso()))
        quiet = not notify or assigned is not None
        made = _create_task(body, _Later(defer), user, db, before_commit=_note, check_people=True, quiet=quiet)
        if notify and assigned is not None:
            me = (user.get("email") or "").strip().lower()
            for who in made.get("assigneeIds") or []:
                if who and who != me:
                    assigned.setdefault(who, []).append(made["id"])
        where = " as a subtask" if as_sub else (f" in {project.name}" if project is not None else "")
        note = (f" (left off {', '.join(left_off)}: cannot see the task it came from)" if left_off else "")
        _amend_run(db, ref, line, f'created task "{title}"{where}{note}')
    except HTTPException as e:
        db.rollback()
        fail(str(e.detail))
    except Exception as e:   # never let one rule's task break the rest of the after-commit work
        db.rollback()
        fail(str(e)[:200])
    finally:
        _SUPPRESS.reset(token)


# ── send_email ───────────────────────────────────────────────────────────────
_EMAIL_TO_WORDS = {"assignees": "the assignees", "creator": "the creator",
                   "followers": "the collaborators", "project_owner": "the project owner"}


def email_recipients(db: Session, t: models.Task, to, actor: str = "") -> tuple[list, int]:
    """([(email, role)], how many were left out) for a send_email action:
    who `to` names on this task, kept only when recipient_can_see. `actor`,
    the person whose change fired the rule, is never emailed about it - as
    with every other task email (task_notify._recipients_for)."""
    from routers.task_util import project_for_task
    key = str(to or "").strip().lower()
    if key == "assignees":
        cands = [(e, "assignee") for e in task_assignees(t)]
    elif key == "creator":
        cands = [(t.created_by or "", "creator")]
    elif key == "followers":
        cands = [(e, "follower") for e in email_list(t.follower_emails)]
    elif key == "project_owner":
        p = project_for_task(db, t)
        cands = [(p.owner_email or "", "owner")] if p is not None else []
    elif "@" in key:
        cands = [(key, "recipient")]
    else:
        cands = []
    out, seen, left_out = [], {(actor or "").strip().lower()}, 0
    for e, role in cands:
        e = (e or "").strip().lower()
        if not e or e in seen:
            continue
        seen.add(e)
        if recipient_can_see(db, e, t):
            out.append((e, role))
        else:
            left_out += 1
    return out, left_out


def _queue_email(t: models.Task, spec: dict, res: Result, run: _RunCtx) -> str:
    to = str(spec.get("to") or "")
    line = f"emailing {_EMAIL_TO_WORDS.get(to, to)}"
    res.after_commit.append(functools.partial(_email_after_commit, task_id=t.id, spec=dict(spec),
                                              ref=run.ref, line=line, actor=run.actor))
    return line


def _email_after_commit(db: Session, defer=None, *, task_id: str, spec: dict, ref: dict, line: str,
                        actor: str = "", notify: bool = True, assigned=None) -> None:
    """Resolve the recipients against the committed task and hand the email
    to notify_task_event as an "automation" event - mutes, batching and the
    retry log all apply. Never sends mail itself. `notify=False` (a silent
    task import) sends nothing and says so on the run."""
    if not notify:
        _amend_run(db, ref, line, f"{line} - skipped: the import was set not to notify anyone")
        return
    t = db.query(models.Task).filter(models.Task.id == task_id).first()
    if t is None:
        _amend_run(db, ref, line, "could not send the email: the task is gone", failed=True)
        return
    recipients, left_out = email_recipients(db, t, spec.get("to"), actor=actor)
    if not recipients:
        _amend_run(db, ref, line, "could not send the email: nobody to send it to who can see this task "
                                  "(the person who made the change is never emailed about it)", failed=True)
        return
    subject = " ".join(_fill(str(spec.get("subject") or ""), db, t).split())[:MAX_SUBJECT]
    body = _fill(str(spec.get("body") or ""), db, t)[:MAX_BODY]
    import task_notify as _mail   # lazy: task_notify imports this module
    _Later(defer).add_task(_mail.notify_task_event, t.id, "automation", AUTOMATION_ACTOR,
                           automation_to=recipients, auto_subject=subject, auto_body=body)
    note = f" ({left_out} left out - cannot see this task)" if left_out else ""
    _amend_run(db, ref, line, "queued an email to " + ", ".join(e for e, _ in recipients) + note)


# ── move_to_project / set_custom_field (field changes on the same row) ───────
def _move_to_project(db: Session, t: models.Task, spec: dict, res: Result, run: _RunCtx, cache: dict) -> str:
    """The move update_task makes for a new project: the old section and team
    are left behind, the extras list is re-cleaned, and a required custom
    field the move would leave empty refuses it (_newly_missing_required).
    Subtasks that carry the old project as their own go with it; those with
    none already follow their main task."""
    import auth
    from routers.tasks import _extra_project_ids, _newly_missing_required, _required_message, _live_descendants
    pid = (spec.get("projectId") or "").strip()
    sid = (spec.get("sectionId") or "").strip()
    if not pid:
        return ""
    if t.parent_task_id:
        return "could not move: a subtask moves with its main task"
    project = db.query(models.TaskProject).filter(models.TaskProject.id == pid).first()
    if project is None:
        return "could not move: that project no longer exists"
    sec = db.query(models.TaskSection).filter(models.TaskSection.id == sid).first() if sid else None
    if sec is None or (sec.project_id or "") != pid:
        sec, sid = None, ""
    old = t.project_id or ""
    if old == pid and (not sid or (t.section_id or "") == sid):
        return ""
    pc = row_company(db, project)
    rc = (getattr(run.rule, "company_id", "") or "").strip()
    if (rc and pc != rc) or (auth._company_walls_on(db) and _task_company(db, t, cache) != pc):
        return f"could not move to {project.name}: it is in another company"
    if old != pid and (t.access_level or "org") != "org":
        # Same reason create_task refuses a copy: the other project's people
        # would see a task that was hidden from them. A person can move it.
        return f"could not move to {project.name}: the task is restricted, so a rule does not move it to another project"
    if old != pid and any((d.access_level or "org") != "org" for d in _live_descendants(db, [t.id])):
        # A restricted SUBTASK goes too (its own project, or through this
        # one): the same widening, refused the same way - a manual move takes
        # someone who may open each restricted row up (tasks.
        # _require_open_up_for_move); a rule has no such person.
        return f"could not move to {project.name}: a subtask is restricted, so a rule does not move it to another project"
    if old != pid:
        values = t.custom_field_values or {}
        missing = _newly_missing_required(db, t, old, values, pid, values)
        if missing:
            return f"could not move to {project.name}: {_required_message(db, missing, pid)}"
    t.project_id = pid
    t.section_id = sid
    res.changed["project_id"] = pid
    res.changed["section_id"] = sid
    if old != pid:
        t.team_id = ""
        t.project_ids = _extra_project_ids(t.project_ids, pid)
        res.changed["team_id"] = ""
        if old:
            now = now_iso()
            for d in _live_descendants(db, [t.id]):
                if (d.project_id or "") == old:
                    # The task's own move is recorded by the engine pass; each
                    # subtask's goes on its own history (Oct 22 2026).
                    d_before = task_history.snapshot(d)
                    d.project_id, d.section_id, d.team_id = pid, "", ""
                    d.project_ids = _extra_project_ids(d.project_ids, pid)
                    d.modified_at = now
                    task_history.record(db, d, d_before, AUTOMATION_ACTOR, only={"projectId", "sectionId"})
    return f"moved to {project.name}" + (f" ({sec.name})" if sec is not None else "")


def _set_custom_field(db: Session, t: models.Task, spec: dict, res: Result, cache: dict) -> str:
    """Writes one custom field the way a bulk edit does (merged into the
    task's own values, coerced to the field's shape; a blank value clears
    it). A company's field is only written on that company's tasks, and a
    required field is never cleared."""
    from routers.tasks import _merge_custom_field_values, _newly_missing_required, _required_message
    fid = (spec.get("fieldId") or "").strip()
    f = db.query(models.TaskCustomField).filter(models.TaskCustomField.id == fid).first() if fid else None
    if f is None:
        return "could not set a custom field: that field no longer exists"
    if (f.type or "") == FORMULA_TYPE:
        return f"could not set {f.name}: it is a formula field, calculated rather than stored"
    if f.read_only:
        return f"could not set {f.name}: it is read-only"
    fc = (getattr(f, "company_id", "") or "").strip()
    if fc and _task_company(db, t, cache) != fc:
        return f"could not set {f.name}: it belongs to another company"
    current = dict(t.custom_field_values) if isinstance(t.custom_field_values, dict) else {}
    raw = spec.get("value")
    if (f.type or "") == "checkbox" and isinstance(raw, str) and raw.strip().lower() in ("checked", "unchecked"):
        raw = raw.strip().lower() == "checked"   # the rule builder's words for a checkbox
    merged = _merge_custom_field_values(db, current, {fid: raw})
    clearing = raw in ("", None) or raw == []
    if not clearing and fid not in merged:
        return f"could not set {f.name}: that value does not fit the field"
    if merged.get(fid) == current.get(fid) or (_cf_empty(merged.get(fid)) and _cf_empty(current.get(fid))):
        return ""   # already so (an unticked checkbox and an unset one are the same)
    if clearing:
        missing = _newly_missing_required(db, t, t.project_id or "", current, t.project_id or "", merged)
        if missing:
            return f"could not clear {f.name}: {_required_message(db, missing, t.project_id or '')}"
    t.custom_field_values = merged
    res.changed["custom_field_values"] = merged
    return f"cleared {f.name}" if clearing else f"set {f.name} to {_cf_label(f, merged[fid])}"


def _valid_status_ids(db: Session) -> set:
    from routers.tasks import _valid_statuses   # lazy: routers.tasks imports this module
    return _valid_statuses(db)


def _enabled_rules(db: Session) -> list[models.TaskAutomationRule]:
    return (db.query(models.TaskAutomationRule)
            .filter(models.TaskAutomationRule.enabled.is_(True))
            .order_by(models.TaskAutomationRule.created_at, models.TaskAutomationRule.id)
            .all())


def _rule_reaches(db: Session, rule: models.TaskAutomationRule, t: models.Task, cache: dict) -> bool:
    """Whether `rule` may act on `t` across the company wall (Oct 21 2026).

    A rule with no company (every rule made before the walls, and any made
    while they are off or by a Global Admin) is shared and reaches every task,
    exactly as before. A rule a company made fires only on that company's
    tasks - read the way the task lists read a task's company
    (task_util.row_company: stamped, else its owner's / creator's). `cache`
    holds the task's company for the rest of this pass."""
    rc = (getattr(rule, "company_id", "") or "").strip()
    if not rc:
        return True
    if "company" not in cache:
        cache["company"] = row_company(db, t)
    return cache["company"] == rc


def _record(db: Session, rule: models.TaskAutomationRule, t: models.Task, *, event: str,
            lines: list[str], dedupe_key: str = "") -> str:
    """Writes the run row and the task's activity line; returns the run id
    (the after-commit actions report back onto it - _amend_run)."""
    failures = [ln for ln in lines if ln.startswith("could not ")]
    run_id = gen_id()
    db.add(models.TaskAutomationRun(
        id=run_id, rule_id=rule.id, rule_name=rule.name or "", task_id=t.id,
        task_code=t.code or "", task_title=t.title or "",
        trigger_type=(rule.trigger or {}).get("type", ""), event=event, actions=lines,
        # applied | partial (some actions could not run) | error (none could)
        status=("error" if len(failures) == len(lines) else "partial") if failures else "applied",
        detail="; ".join(failures)[:500], dedupe_key=dedupe_key, at=now_iso(),
    ))
    rule.run_count = int(rule.run_count or 0) + 1
    rule.last_run_at = now_iso()
    aid = log_activity(db, type="automation", actor_email=AUTOMATION_ACTOR, entity_id=t.id,
                       entity_code=t.code, entity_title=t.title,
                       detail=f"{rule.name}: " + "; ".join(lines))
    t.activity_ids = list(t.activity_ids or []) + [aid]
    return run_id


def run_for_change(db: Session, t: models.Task, *, event: str, before: dict,
                   completed: Optional[bool] = None,
                   gate: Optional[Callable] = None, today: Optional[date] = None,
                   actor: str = "", budget: Optional[dict] = None,
                   rules: Optional[list] = None) -> Result:
    """Evaluate every enabled rule against one task that `event` ("created" |
    "updated" | "bulk") just changed from `before` (see snapshot). Mutates `t`
    in place; the caller commits. `completed` is what the task's completed
    flag becomes once the caller lands it (routers.tasks applies it AFTER this
    pass, dragging status along - see _apply_completion). Never raises for a
    rule's own problems - a broken rule is logged on the run and skipped, the
    person's edit still lands. `actor` is the person who made the change (a
    created task is created as them); `budget` is shared by every row of one
    bulk edit so the request as a whole stays under MAX_CREATES_PER_REQUEST.
    `rules`: the enabled rules when the caller already loaded them
    (_enabled_rules) - the task import runs this for up to 2,000 new tasks
    against one load. A task an automation is creating runs nothing
    (_SUPPRESS)."""
    res = Result()
    if _SUPPRESS.get():
        return res
    budget = budget if budget is not None else {}
    actor = (actor or "").strip().lower()
    # Only an in-process caller with no person (none today) falls back to
    # the owner / creator - see _RunCtx.fallbacks.
    fallbacks = () if actor else tuple(e for e in ((t.owner_email or ""), (t.created_by or "")) if e)
    today = today or business_today()
    if rules is None:
        rules = _enabled_rules(db)
    if not rules:
        return res
    after = snapshot(t)
    # Ticking the checkbox sends {completed: true} and no status; the status
    # only becomes "completed" when the caller applies the flag, after this
    # pass. Overlay what that will do, so "status changes to Completed" fires
    # for the checkbox the same as for the status picker, and a reopen reads
    # as the move back to Not Started that it is.
    if completed is not None and completed != bool(before["completed"]):
        after["completed"] = completed
        if completed:
            after["status"] = "completed"
        elif after["status"] in ("completed", "missed"):
            after["status"] = "not_started"
    completing = bool(after["completed"]) and not before["completed"]
    # Field history: what the rules change is theirs, recorded below as
    # AUTOMATION_ACTOR. A brand-new task has no history - "created" says it.
    hist_before = task_history.snapshot(t) if event != "created" else None
    company_cache: dict = {}
    for rule in rules:
        trigger = rule.trigger if isinstance(rule.trigger, dict) else {}
        if trigger.get("type") == "due_date_arrives":
            continue
        if not _rule_reaches(db, rule, t, company_cache):
            continue
        if _reads_a_formula(db, rule, company_cache):
            continue
        queued = len(res.after_commit)
        try:
            if not _matches_trigger(trigger, event, before, after, completing=completing, today=today):
                continue
            if not conditions_ok(rule.conditions if isinstance(rule.conditions, list) else [], after):
                continue
            run = _RunCtx(rule=rule, actor=actor, ref={}, budget=budget, fallbacks=fallbacks)
            lines = []
            for action in (rule.actions or []):
                line = _apply_action(db, t, action, res, today=today, gate=gate,
                                     prev_status=before["status"], prev_completed=before["completed"],
                                     run=run, company_cache=company_cache)
                if line:
                    lines.append(line)
            if not lines:
                continue
            run.ref["id"] = _record(db, rule, t, event=event, lines=lines)
            res.applied.extend(f"{rule.name}: {ln}" for ln in lines)
            res.rule_ids.append(rule.id)
        except Exception as e:   # a rule must never break the edit that triggered it
            # ...nor leave half of itself to run after the commit.
            del res.after_commit[queued:]
            db.add(models.TaskAutomationRun(
                id=gen_id(), rule_id=rule.id, rule_name=rule.name or "", task_id=t.id,
                task_code=t.code or "", task_title=t.title or "",
                trigger_type=trigger.get("type", ""), event=event, actions=[],
                status="error", detail=str(e)[:500], at=now_iso(),
            ))
    if hist_before is not None and res.applied:
        hist_after = task_history.snapshot(t)
        changes = task_history.diff(db, hist_before, hist_after)
        if changes:
            task_history.write(db, t, changes, AUTOMATION_ACTOR, since=hist_before["_at"])
            res.history_mid, res.history_post = hist_before, hist_after
            res.history_keys = {task_history.key_of(c) for c in changes}
    return res


def run_after_commit(db: Session, res: Result, defer=None, notify: bool = True,
                     assigned: dict | None = None) -> None:
    """Run the after-commit work an engine pass handed back (comments, rule
    emails, rule-created tasks). `defer` is the request's
    BackgroundTasks.add_task when there is one (the emails are Graph calls); a
    worker thread passes nothing and they run inline.

    `notify=False` (a silent task import) tells nobody anything: comments
    posted silently, rule emails skipped, created tasks made quietly.
    `assigned` (a dict the caller owns - the task import) groups the run:
    comments are silent, created tasks quiet with their assignees collected
    into it ({email: [task id]}) for the caller's one notice per person, and
    rule emails go out as `notify` says."""
    kw: dict = {}
    if not notify:
        kw["notify"] = False
    if assigned is not None:
        kw["assigned"] = assigned
    for fn in res.after_commit:
        try:
            fn(db, defer, **kw)
        except Exception:
            db.rollback()


# ── Scheduled: "due date arrives" ────────────────────────────────────────────
def run_scheduled(db: Session, today_iso: str) -> int:
    """Fire every `due_date_arrives` rule for the open tasks whose due date sits
    at the rule's offset from today. Idempotent through the run log's
    dedupe_key (rule:task:date) - the hourly scan can call this all day and a
    task is only acted on once per rule per date. Returns how many fired."""
    rules = [r for r in _enabled_rules(db) if (r.trigger or {}).get("type") == "due_date_arrives"]
    if not rules:
        return 0
    today = date.fromisoformat(today_iso[:10])
    # lazy: routers.tasks imports this module
    from routers.tasks import (_check_dependency_gate, _resolve_completed, _land_completion,
                               _log_completed, _after_completed)
    fired = 0
    scan_budget: dict = {}   # company -> create_task budget for this whole call (MAX_CREATES_PER_SCAN)
    per_task: dict = {}      # task id -> tasks created from it this call, every rule (MAX_CREATES_PER_TASK)
    formula_cache: dict = {}
    for rule in rules:
        if _reads_a_formula(db, rule, formula_cache):
            continue
        try:
            offset = int((rule.trigger or {}).get("value") or 0)
        except (TypeError, ValueError):
            offset = 0
        # offset -2 = "two days before the due date": a task due the day after
        # tomorrow is the one to act on today.
        target = (today - timedelta(days=offset)).isoformat()
        rows = (db.query(models.Task)
                # Prefix, not equality: due_on is validated on its first ten
                # characters only, so a stored value can carry a time suffix.
                .filter(models.Task.due_on.like(f"{target}%"),
                        models.Task.completed.is_(False),
                        (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)))
                .all())
        if not rows:
            continue
        done = {k for (k,) in db.query(models.TaskAutomationRun.dedupe_key)
                .filter(models.TaskAutomationRun.rule_id == rule.id,
                        models.TaskAutomationRun.dedupe_key.like(f"{rule.id}:%:{target}")).all()}
        # A task a rule created never feeds create_task on the clock
        # (SPAWNED_EVENT): this rule or another would otherwise create from
        # its own output on every scan. Its OTHER actions still run, so "due
        # date arrives -> set priority" escalates a follow-up task like any
        # other. Read per rule, so one made earlier in this scan counts.
        rule_made = {i for (i,) in db.query(models.TaskAutomationRun.task_id)
                     .filter(models.TaskAutomationRun.event == SPAWNED_EVENT,
                             models.TaskAutomationRun.task_id.in_([r.id for r in rows])).all()}
        all_actions = [a for a in (rule.actions or []) if isinstance(a, dict)]
        n_creates = sum(1 for a in all_actions if a.get("type") == "create_task")
        deferred: list = []   # tasks left for the next scan (the company's create budget is spent)
        for t in rows:
            key = f"{rule.id}:{t.id}:{target}"
            if key in done:
                continue
            made_by_rule = t.id in rule_made
            actions = [a for a in all_actions if not (made_by_rule and a.get("type") == "create_task")]
            if not actions:
                continue
            if not _rule_reaches(db, rule, t, {}):
                continue   # another company's task (company wall)
            before = snapshot(t)
            if not conditions_ok(rule.conditions if isinstance(rule.conditions, list) else [], before):
                continue
            hist_before = task_history.snapshot(t)
            res = Result()
            # The per-task cap counts every rule this scan, not each rule alone.
            res.creates = per_task.get(t.id, 0)
            lines = []
            company_cache: dict = {}
            # One create budget per company for the whole scan (looked up only
            # for a rule that creates tasks - row_company is a query).
            wants = 0 if made_by_rule else min(n_creates, max(0, MAX_CREATES_PER_TASK - res.creates))
            budget = (scan_budget.setdefault(_task_company(db, t, company_cache), {
                "creates": 0, "limit": MAX_CREATES_PER_SCAN, "scope": "one hourly scan for a company"})
                if wants else {})
            if wants and int(budget["creates"]) + wants > int(budget["limit"]):
                # The budget is spent: the WHOLE rule waits for the next scan
                # for this task - nothing applied, no dedupe key - so it is
                # finished then rather than lost for the day, and no other
                # action (a comment, an email) runs twice.
                if not budget.get("logged"):
                    budget["logged"] = True
                    logging.getLogger(__name__).warning(
                        "task automation: create_task budget hit (%s, %d tasks) - the rest wait for the next scan",
                        budget["scope"], budget["limit"])
                deferred.append(t)
                continue
            # Nobody made this change: a task the rule creates is created as
            # the task's owner, else its creator (as the next occurrence below is).
            run = _RunCtx(rule=rule, actor="", ref={}, budget=budget,
                          fallbacks=tuple(e for e in ((t.owner_email or ""), (t.created_by or "")) if e))
            try:
                # The dependency gate applies here as it does to a person: the
                # clock does not get to start or close a task its blocker holds.
                for action in actions:
                    line = _apply_action(db, t, action, res, today=today,
                                         gate=functools.partial(_check_dependency_gate, db, t),
                                         prev_status=before["status"], prev_completed=before["completed"],
                                         run=run, company_cache=company_cache)
                    if line:
                        lines.append(line)
                per_task[t.id] = res.creates
                # Keep status and the completed flag in step - through the same
                # completion path a person's tick goes through (Oct 21 2026):
                # the HR checklist steps follow here, and the activity and the
                # series roll-forward below. Before, the flag was flipped by
                # hand and a recurring task closed by a rule never repeated.
                prev_completed = bool(before["completed"])
                if "status" in res.changed:
                    _land_completion(db, t, _resolve_completed({"status": res.changed["status"]}, prev_completed),
                                     prev_completed, AUTOMATION_ACTOR)
                completed_now = bool(t.completed) and not prev_completed
                if completed_now:
                    t.activity_ids = list(t.activity_ids or []) + [_log_completed(db, t, AUTOMATION_ACTOR)]
                if lines:
                    # Only a real change marks the row modified; a no-op pass
                    # must not make every client's delta fetch re-pull the task.
                    t.modified_at = now_iso()
                # The clock is told about like a person (Oct 12 review): a moved
                # due date gets its history line and the requester's bell, and
                # anyone the rule added as an assignee gets the bell and the
                # "assigned" email, as update_task does for an edit.
                if "due_on" in res.changed:
                    entry = task_due.record_due_change(db, t, before["due_on"], t.due_on or "",
                                                       actor=AUTOMATION_ACTOR, source="automation")
                    req = task_due.requester_of(t)
                    if entry and req:
                        task_notify(db, kind="task_due_changed", for_email=req,
                                    title="Due Date Extended" if entry.get("extension") else "Due Date Changed",
                                    body=f"{t.title} - due {_us(t.due_on or '')}", task_id=t.id,
                                    nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
                # Field history, as the rule (the completion lands on the
                # "completed" row above rather than a second line).
                task_history.record(db, t, hist_before, AUTOMATION_ACTOR)
                added = [w for w in task_assignees(t) if w not in set(before["assignees"])]
                for who in added:
                    task_notify(db, kind="task_assigned", for_email=who, title="You Were Assigned a Task",
                                body=f"{t.title}", task_id=t.id,
                                nexus_action={"view": "tasks", "sub": "mine", "label": "View task"})
                # A recurring task rolls forward and a ticket's task tells its
                # ticket, as when a person completes it. The next occurrence is
                # created as its owner (as the daily schedule does): the
                # creator is who the due-date notices treat as the requester,
                # and that must be a person, not the rule. Spawning a task runs
                # no rules - the engine still never chains.
                spawned = None
                if completed_now:
                    owner = t.owner_email or t.created_by or t.assignee_email or "system"
                    spawned = _after_completed(db, t, {"email": AUTOMATION_ACTOR}, prev_completed,
                                               spawn_as={"email": owner})
                # Logged even when nothing changed, so the dedupe holds and the
                # Runs panel shows the rule looked.
                run.ref["id"] = _record(db, rule, t, event="scheduled", lines=lines or ["nothing to change"],
                                        dedupe_key=key)
                db.commit()
                run_after_commit(db, res)
                if lines:
                    fire_task_event(t.id, "updated")
                    fired += 1
                if spawned is not None:
                    fire_task_event(spawned.id, "created")
                if completed_now:
                    # The "completed" email, as update_task sends for a person
                    # (inline: this already runs on a worker thread).
                    import task_notify as _mail
                    _mail.notify_task_event(t.id, "completed", AUTOMATION_ACTOR)
                if added:
                    # Already on a worker thread (task_notify's scan runs in
                    # asyncio.to_thread), so the email goes inline. Lazy:
                    # task_notify imports this module.
                    import task_notify as _mail
                    _mail.notify_task_event(t.id, "assigned", AUTOMATION_ACTOR)
            except Exception as e:
                db.rollback()
                db.add(models.TaskAutomationRun(
                    id=gen_id(), rule_id=rule.id, rule_name=rule.name or "", task_id=t.id,
                    task_code=t.code or "", task_title=t.title or "", trigger_type="due_date_arrives",
                    event="scheduled", actions=[], status="error", detail=str(e)[:500],
                    dedupe_key=key, at=now_iso(),
                ))
                db.commit()
        if deferred:
            # One line in the Runs panel per rule and scan - not one per task
            # (there can be hundreds) - and no dedupe key: the next scan picks
            # every deferred task up again.
            first, limit = deferred[0], MAX_CREATES_PER_SCAN
            db.add(models.TaskAutomationRun(
                id=gen_id(), rule_id=rule.id, rule_name=rule.name or "", task_id=first.id,
                task_code=first.code or "", task_title=first.title or "", trigger_type="due_date_arrives",
                event="scheduled", actions=[], status="error",
                detail=(f"could not create tasks for {len(deferred)} task{'s' if len(deferred) != 1 else ''} yet: "
                        f"one hourly scan for a company can create at most {limit} tasks - "
                        f"they run on the next scan"),
                dedupe_key="", at=now_iso()))
            db.commit()
    return fired
