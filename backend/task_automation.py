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

Every rule that fires writes a TaskAutomationRun row (the Runs panel in
Manage) and one activity entry on the task attributed to AUTOMATION_ACTOR, so
"why did this task's priority change?" has an answer in the task itself.
"""
from __future__ import annotations

import html
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

import models
from routers.task_util import (
    gen_id, now_iso, log_activity, task_assignees, set_task_assignees, email_list,
    create_comment, fire_task_event,
)

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
)
ACTION_TYPES = (
    "set_status", "set_priority", "add_tag", "set_milestone",
    "assign_to",        # value: email - replaces the assignees
    "add_assignee",     # value: email - added alongside the current assignees
    "add_follower",     # value: email
    "set_due_in_days",  # value: N - due date becomes today + N
    "shift_due_days",   # value: N - due date moves by N days from where it is (from today when it has none)
    "add_comment",      # value: text; {title} {assignee} {due} {priority} {status} are filled in
)
CONDITION_FIELDS = ("project", "status", "priority", "tag", "assignee", "team")
CONDITION_OPS = ("is", "is_not")
PRIORITIES = ("low", "medium", "high", "urgent")

MAX_CONDITIONS = 10
MAX_ACTIONS = 6


# ── Validation (shared by the CRUD endpoints) ────────────────────────────────
def validate_rule(trigger: dict | None, conditions: list | None, actions: list | None) -> None:
    """422 for a rule the engine could not run. Kept loose on VALUES on
    purpose - a status that is deleted later must not make the rule unsaveable,
    it just stops matching."""
    trigger = trigger or {}
    if trigger.get("type") not in TRIGGER_TYPES:
        raise HTTPException(422, "Choose a trigger")
    if trigger.get("type") == "due_date_arrives":
        try:
            int(trigger.get("value") or 0)
        except (TypeError, ValueError):
            raise HTTPException(422, "Days before or after the due date must be a whole number")
    conds = conditions or []
    if len(conds) > MAX_CONDITIONS:
        raise HTTPException(422, f"At most {MAX_CONDITIONS} conditions")
    for c in conds:
        if not isinstance(c, dict) or c.get("field") not in CONDITION_FIELDS or c.get("op", "is") not in CONDITION_OPS:
            raise HTTPException(422, "A condition is incomplete")
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
        "tags": tuple(str(x).strip().lower() for x in (t.tags or [])),
        "due_on": (t.due_on or "")[:10],
        "completed": bool(t.completed),
    }


def _matches_trigger(trigger: dict, event: str, before: dict, after: dict, *, completing: bool) -> bool:
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
        return bool(after["due_on"]) and date.today().isoformat() < after["due_on"]
    return False   # due_date_arrives only fires from run_scheduled


def conditions_ok(conditions: list | None, snap: dict) -> bool:
    """`snap` is a snapshot() - the task as the person left it."""
    for c in conditions or []:
        f, op, v = c.get("field"), c.get("op", "is"), c.get("value")
        v = (v or "").strip().lower() if isinstance(v, str) else v
        if f == "project":
            hit = bool(v) and (snap["project_id"] == v or v in snap["project_ids"])
        elif f == "status":
            hit = snap["status"] == v
        elif f == "priority":
            hit = snap["priority"] == v
        elif f == "tag":
            hit = v in snap["tags"]
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
    """{title} {assignee} {due} {priority} {status} {project} in an add_comment."""
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
    out = template
    for k, v in values.items():
        out = out.replace("{" + k + "}", v)
    return out


def _apply_action(db: Session, t: models.Task, action: dict, res: Result, *, today: date,
                  gate: Optional[Callable], prev_status: str, prev_completed: bool) -> str:
    """Apply one action to `t`. Returns the human line for the run log, or ""
    when the action was a no-op (already in that state)."""
    kind = action.get("type")
    value = action.get("value")
    if kind == "set_status":
        if (t.status or "") == value:
            return ""
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
        tag = str(value or "").strip()
        tags = list(t.tags or [])
        if not tag or tag.lower() in [str(x).lower() for x in tags]:
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

        def _post(db2: Session, defer=None, _tid=t.id, _body=body):
            task = db2.query(models.Task).filter(models.Task.id == _tid).first()
            if task is not None:
                create_comment(db2, task, actor_email=AUTOMATION_ACTOR, body=_body, defer=defer)
        res.after_commit.append(_post)
        return "added a comment"
    return ""


def _enabled_rules(db: Session) -> list[models.TaskAutomationRule]:
    return (db.query(models.TaskAutomationRule)
            .filter(models.TaskAutomationRule.enabled.is_(True))
            .order_by(models.TaskAutomationRule.created_at, models.TaskAutomationRule.id)
            .all())


def _record(db: Session, rule: models.TaskAutomationRule, t: models.Task, *, event: str,
            lines: list[str], dedupe_key: str = "") -> None:
    db.add(models.TaskAutomationRun(
        id=gen_id(), rule_id=rule.id, rule_name=rule.name or "", task_id=t.id,
        task_code=t.code or "", task_title=t.title or "",
        trigger_type=(rule.trigger or {}).get("type", ""), event=event,
        actions=lines, status="applied", dedupe_key=dedupe_key, at=now_iso(),
    ))
    rule.run_count = int(rule.run_count or 0) + 1
    rule.last_run_at = now_iso()
    aid = log_activity(db, type="automation", actor_email=AUTOMATION_ACTOR, entity_id=t.id,
                       entity_code=t.code, entity_title=t.title,
                       detail=f"{rule.name}: " + "; ".join(lines))
    t.activity_ids = list(t.activity_ids or []) + [aid]


def run_for_change(db: Session, t: models.Task, *, event: str, before: dict,
                   completing: Optional[bool] = None,
                   gate: Optional[Callable] = None, today: Optional[date] = None) -> Result:
    """Evaluate every enabled rule against one task that `event` ("created" |
    "updated" | "bulk") just changed from `before` (see snapshot). Mutates `t`
    in place; the caller commits. `completing` is whether this edit is closing
    the task (the caller knows before the flag is written). Never raises for a
    rule's own problems - a broken rule is logged on the run and skipped, the
    person's edit still lands."""
    res = Result()
    today = today or date.today()
    rules = _enabled_rules(db)
    if not rules:
        return res
    after = snapshot(t)
    if completing is None:
        completing = after["completed"] and not before["completed"]
    for rule in rules:
        trigger = rule.trigger if isinstance(rule.trigger, dict) else {}
        if trigger.get("type") == "due_date_arrives":
            continue
        try:
            if not _matches_trigger(trigger, event, before, after, completing=completing):
                continue
            if not conditions_ok(rule.conditions if isinstance(rule.conditions, list) else [], after):
                continue
            lines = []
            for action in (rule.actions or []):
                line = _apply_action(db, t, action, res, today=today, gate=gate,
                                     prev_status=before["status"], prev_completed=before["completed"])
                if line:
                    lines.append(line)
            if not lines:
                continue
            _record(db, rule, t, event=event, lines=lines)
            res.applied.extend(f"{rule.name}: {ln}" for ln in lines)
            res.rule_ids.append(rule.id)
        except Exception as e:   # a rule must never break the edit that triggered it
            db.add(models.TaskAutomationRun(
                id=gen_id(), rule_id=rule.id, rule_name=rule.name or "", task_id=t.id,
                task_code=t.code or "", task_title=t.title or "",
                trigger_type=trigger.get("type", ""), event=event, actions=[],
                status="error", detail=str(e)[:500], at=now_iso(),
            ))
    return res


def run_after_commit(db: Session, res: Result, defer=None) -> None:
    """Run the comment posts an engine pass handed back. `defer` is the
    request's BackgroundTasks.add_task when there is one (the emails are Graph
    calls); a worker thread passes nothing and they run inline."""
    for fn in res.after_commit:
        try:
            fn(db, defer)
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
    fired = 0
    for rule in rules:
        try:
            offset = int((rule.trigger or {}).get("value") or 0)
        except (TypeError, ValueError):
            offset = 0
        # offset -2 = "two days before the due date": a task due the day after
        # tomorrow is the one to act on today.
        target = (today - timedelta(days=offset)).isoformat()
        rows = (db.query(models.Task)
                .filter(models.Task.due_on == target,
                        models.Task.completed.is_(False),
                        (models.Task.deleted_at == "") | (models.Task.deleted_at.is_(None)))
                .all())
        if not rows:
            continue
        done = {k for (k,) in db.query(models.TaskAutomationRun.dedupe_key)
                .filter(models.TaskAutomationRun.rule_id == rule.id,
                        models.TaskAutomationRun.dedupe_key.like(f"{rule.id}:%:{target}")).all()}
        for t in rows:
            key = f"{rule.id}:{t.id}:{target}"
            if key in done:
                continue
            before = snapshot(t)
            if not conditions_ok(rule.conditions if isinstance(rule.conditions, list) else [], before):
                continue
            res = Result()
            lines = []
            try:
                for action in (rule.actions or []):
                    line = _apply_action(db, t, action, res, today=today, gate=None,
                                         prev_status=before["status"], prev_completed=before["completed"])
                    if line:
                        lines.append(line)
                # Keep status and the completed flag in step, as update_task does.
                if res.changed.get("status") == "completed" and not t.completed:
                    t.completed, t.completed_at = True, now_iso()
                elif "status" in res.changed and t.completed:
                    t.completed, t.completed_at = False, ""
                t.modified_at = now_iso()
                # Logged even when nothing changed, so the dedupe holds and the
                # Runs panel shows the rule looked.
                _record(db, rule, t, event="scheduled", lines=lines or ["nothing to change"], dedupe_key=key)
                db.commit()
                run_after_commit(db, res)
                if lines:
                    fire_task_event(t.id, "updated")
                    fired += 1
            except Exception as e:
                db.rollback()
                db.add(models.TaskAutomationRun(
                    id=gen_id(), rule_id=rule.id, rule_name=rule.name or "", task_id=t.id,
                    task_code=t.code or "", task_title=t.title or "", trigger_type="due_date_arrives",
                    event="scheduled", actions=[], status="error", detail=str(e)[:500],
                    dedupe_key=key, at=now_iso(),
                ))
                db.commit()
    return fired
