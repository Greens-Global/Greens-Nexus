"""The workflow rows (spec 6.7): create, draft, publish (a version per
publish), pause / resume / archive, re-own, duplicate, restore, the
English diff between two versions, the serialized shapes the API returns
and who may see or edit what. Publish, pause, resume, re-own and restore
write an AuditLog row (module `workflows`) so Settings > Logs shows who
changed what.

The published definition lives in the row's trigger / conditions / steps /
settings; unpublished edits in `draft` (the whole definition). Publish
validates (`validate.validate`), refuses a draft that was not tested since
its last edit (`tested_hash`), writes a WorkflowVersion, bumps `version`,
clears the draft and makes the workflow active.
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import models
from workflows import catalog, validate

STATUSES = ("draft", "active", "paused", "needs_attention", "archived")
RUN_STATUSES = ("running", "waiting", "succeeded", "failed", "skipped", "cancelled", "test")


class ValidationError(ValueError):
    def __init__(self, problems):
        self.problems = list(problems)
        super().__init__("; ".join(f"{p.path}: {p.message}" for p in self.problems) or "Invalid definition")


class NotTested(ValueError):
    def __init__(self):
        super().__init__("Test this workflow before publishing")


class Archived(ValueError):
    def __init__(self):
        super().__init__("An archived workflow cannot be published - switch it back on first")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_definition() -> dict:
    return {"v": 1, "trigger": {}, "conditions": [], "steps": [], "settings": dict(validate.DEFAULT_SETTINGS)}


def normalize_definition(definition) -> dict:
    """The pinned shape, as a DEEP copy - an edit to what this returns
    never reaches the row's own JSON (the published definition keeps
    running while the draft is edited)."""
    d = definition if isinstance(definition, dict) else {}
    out = {
        "v": 1,
        "trigger": copy.deepcopy(d.get("trigger") or {}),
        "conditions": copy.deepcopy(d.get("conditions") or []),
        "steps": copy.deepcopy(d.get("steps") or []),
        "settings": {**copy.deepcopy(validate.DEFAULT_SETTINGS), **copy.deepcopy(d.get("settings") or {})},
    }
    return out


def definition_of(wf: models.Workflow) -> dict:
    """The published definition (empty shape when never published)."""
    return normalize_definition({"trigger": wf.trigger, "conditions": wf.conditions, "steps": wf.steps,
                                 "settings": wf.settings})


def draft_of(wf: models.Workflow) -> dict:
    """What the builder edits: the draft when there is one, else the
    published definition."""
    return normalize_definition(wf.draft) if isinstance(wf.draft, dict) else definition_of(wf)


def owner_user(db, wf: models.Workflow) -> Optional[dict]:
    """The owner as a user dict (None when they are no longer a current
    directory person)."""
    from task_automation import _person_user
    return _person_user(db, wf.owner_email or "")


def run_as_user(db, wf: models.Workflow) -> Optional[dict]:
    """The identity actions run as: None for the Nexus system actor."""
    if (wf.run_as or "owner") == "nexus":
        return None
    return owner_user(db, wf)


def audit(db, actor: str, action: str, wf: models.Workflow, details: Optional[dict] = None) -> None:
    db.add(models.AuditLog(timestamp=now_iso(), user_email=(actor or "").lower(), user_role="",
                           action=action, resource_type="workflows", resource_id=wf.id,
                           details=json.dumps({"name": wf.name, **(details or {})}, default=str),
                           module="workflows", kind="update"))


# ── CRUD ─────────────────────────────────────────────────────────────────────
def create(db, *, name: str, owner: str, company_id: str, definition=None, by: str, run_as: str = "owner",
           description: str = "") -> models.Workflow:
    stamp = now_iso()
    wf = models.Workflow(id=str(uuid.uuid4()), name=(name or "").strip() or "Untitled Workflow",
                         description=description or "", owner_email=(owner or "").lower(),
                         run_as=run_as if run_as in ("owner", "nexus") else "owner",
                         company_id=company_id or "", status="draft", version=0,
                         trigger={}, conditions=[], steps=[], settings=dict(validate.DEFAULT_SETTINGS),
                         draft=normalize_definition(definition) if definition else empty_definition(),
                         created_by=(by or "").lower(), created_at=stamp, updated_by=(by or "").lower(),
                         updated_at=stamp)
    db.add(wf)
    return wf


def save_draft(db, wf: models.Workflow, definition, by: str) -> None:
    wf.draft = normalize_definition(definition)
    wf.updated_by = (by or "").lower()
    wf.updated_at = now_iso()


def problems_for(db, wf: models.Workflow, definition=None) -> list:
    """The validation problems of the draft (or `definition`) against the
    workflow's owner, run-as and scope."""
    owner = owner_user(db, wf) or {"email": wf.owner_email or "", "role": "employee", "level": 0}
    d = normalize_definition(definition) if definition is not None else draft_of(wf)
    return validate.validate(db, d, owner=owner, run_as=wf.run_as or "owner", company_id=wf.company_id or "")


def tested_current(wf: models.Workflow) -> bool:
    return bool(wf.tested_hash) and wf.tested_hash == validate.definition_hash(draft_of(wf))


def publisher_problems(db, wf: models.Workflow, by: str, definition=None) -> list:
    """The problems the definition has for the person PUBLISHING it when
    that is not the owner: a full-level user's edits still run with the
    owner's authority, so the publisher must be allowed every step too
    (never a way to run a workflow as someone with more access)."""
    me = (by or "").lower()
    if not me or me == (wf.owner_email or "").lower():
        return []
    from task_automation import _person_user
    who = _person_user(db, me) or {"email": me, "role": "employee", "level": 0}
    d = normalize_definition(definition) if definition is not None else draft_of(wf)
    return validate.validate(db, d, owner=who, run_as=wf.run_as or "owner", company_id=wf.company_id or "")


def publish(db, wf: models.Workflow, by: str, note: str = "") -> models.WorkflowVersion:
    """Validate the draft against the owner AND the publisher, refuse it
    untested or archived, write the version, make it the published
    definition and the workflow active."""
    if wf.status == "archived":
        raise Archived()
    definition = draft_of(wf)
    problems = problems_for(db, wf, definition)
    for p in publisher_problems(db, wf, by, definition):
        if p not in problems:
            problems.append(p)
    if problems:
        raise ValidationError(problems)
    if not tested_current(wf):
        raise NotTested()
    stamp = now_iso()
    wf.version = int(wf.version or 0) + 1
    ver = models.WorkflowVersion(id=str(uuid.uuid4()), workflow_id=wf.id, version=wf.version,
                                 definition=definition, published_by=(by or "").lower(), published_at=stamp,
                                 note=(note or "")[:500])
    db.add(ver)
    wf.trigger, wf.conditions, wf.steps, wf.settings = (definition["trigger"], definition["conditions"],
                                                        definition["steps"], definition["settings"])
    wf.draft = None
    wf.status = "active"
    wf.paused_reason, wf.paused_by, wf.paused_at = "", "", ""
    wf.updated_by, wf.updated_at = (by or "").lower(), stamp
    audit(db, by, "workflow.publish", wf, {"version": wf.version, "note": note or ""})
    return ver


def set_status(db, wf: models.Workflow, status: str, by: str, reason: str = "") -> None:
    if status not in ("active", "paused", "archived", "needs_attention"):
        raise ValueError(f"{status!r} is not a status a workflow can be set to")
    if status == "active" and int(wf.version or 0) < 1:
        raise ValueError("Publish the workflow before switching it on")
    stamp = now_iso()
    if status in ("paused", "needs_attention"):
        wf.paused_reason, wf.paused_by, wf.paused_at = (reason or "")[:300], (by or "").lower(), stamp
    else:
        wf.paused_reason, wf.paused_by, wf.paused_at = "", "", ""
    if status == "archived":
        wf.archived_at = stamp
    elif wf.archived_at:
        wf.archived_at = ""
    wf.status = status
    wf.updated_by, wf.updated_at = (by or "").lower(), stamp
    audit(db, by, f"workflow.{status}", wf, {"reason": reason or ""})


def reown(db, wf: models.Workflow, new_owner: str, by: str) -> list:
    """Hand the workflow to someone else; returns the problems the draft
    has for them (an active workflow with problems goes needs_attention)."""
    old = wf.owner_email
    wf.owner_email = (new_owner or "").lower()
    wf.updated_by, wf.updated_at = (by or "").lower(), now_iso()
    problems = problems_for(db, wf)
    if problems and wf.status == "active":
        set_status(db, wf, "needs_attention", by, "Paused: the new owner cannot run every step")
    audit(db, by, "workflow.reown", wf, {"from": old, "to": wf.owner_email, "problems": len(problems)})
    return problems


def duplicate(db, wf: models.Workflow, by: str, *, company_id=None, name=None) -> models.Workflow:
    copy = create(db, name=name or f"{wf.name} (Copy)", owner=by, company_id=wf.company_id if company_id is None
                  else company_id, definition=draft_of(wf), by=by, run_as="owner", description=wf.description or "")
    return copy


def versions(db, wf: models.Workflow) -> list:
    return (db.query(models.WorkflowVersion).filter(models.WorkflowVersion.workflow_id == wf.id)
            .order_by(models.WorkflowVersion.version.desc()).all())


def version(db, wf: models.Workflow, v: int) -> Optional[models.WorkflowVersion]:
    return (db.query(models.WorkflowVersion)
            .filter(models.WorkflowVersion.workflow_id == wf.id, models.WorkflowVersion.version == int(v)).first())


def restore(db, wf: models.Workflow, v: int, by: str) -> models.WorkflowVersion:
    """Publish an old version's definition as a new version."""
    old = version(db, wf, v)
    if old is None:
        raise ValueError(f"Version {v} does not exist")
    wf.draft = normalize_definition(old.definition)
    wf.tested_hash = validate.definition_hash(wf.draft)    # a published definition was tested when it shipped
    ver = publish(db, wf, by, note=f"Restored version {v}")
    audit(db, by, "workflow.restore", wf, {"from": int(v), "version": wf.version})
    return ver


# ── English ──────────────────────────────────────────────────────────────────
def _event_label(key: str) -> str:
    ev = catalog.EVENTS.get(key)
    return ev.label if ev else (key or "an event")


def _entity_label(key: str) -> str:
    ent = catalog.ENTITIES.get(key)
    return ent.label if ent else (key or "a record")


def _time12(hhmm: str) -> str:
    try:
        h, m = int(str(hhmm)[:2]), int(str(hhmm)[3:5])
    except (TypeError, ValueError):
        return str(hhmm or "")
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


_DAYS = {1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday"}


def trigger_text(trigger) -> str:
    t = trigger if isinstance(trigger, dict) else {}
    kind = t.get("kind")
    if kind == "event":
        return f"When {_event_label(str(t.get('event') or ''))}"
    if kind == "schedule":
        every, days, at = t.get("every"), t.get("days") or [], _time12(t.get("time") or "08:00")
        if every == "day":
            return f"Every day at {at}"
        if every == "week":
            names = ", ".join(_DAYS.get(int(d), str(d)) for d in days if str(d).isdigit() or isinstance(d, int))
            return f"Every {names or 'week'} at {at}"
        if every == "month":
            return f"Monthly on day {', '.join(str(d) for d in days)} at {at}"
        return "On a schedule"
    if kind == "date":
        ent = catalog.ENTITIES.get(str(t.get("entity") or ""))
        fld = str(t.get("field") or "")
        label = next((d.label for d in (ent.dates if ent else []) if d.key == fld), fld or "a date")
        off = int(t.get("offsetDays") or 0)
        when = (f"{abs(off)} days before" if off < 0 else f"{off} days after" if off > 0 else "On")
        return f"{when} {label} ({_entity_label(str(t.get('entity') or ''))})"
    if kind == "manual":
        return f"Run by hand on {_entity_label(str(t.get('entity') or ''))}"
    return "No trigger yet"


def _step_label(step: dict) -> str:
    kind = step.get("kind")
    if kind == "action":
        a = catalog.ACTIONS.get(str(step.get("action") or ""))
        return a.label if a else str(step.get("action") or "Action")
    return {"if": "If / Else", "approval": "Ask For Approval", "wait": "Wait", "for_each": "For Each",
            "stop": "Stop"}.get(kind, str(kind or "Step"))


def _flatten(steps, prefix="") -> list[tuple[str, dict]]:
    out = []
    for i, s in enumerate(steps or []):
        if not isinstance(s, dict):
            continue
        out.append((f"{prefix}{i + 1}", s))
        if s.get("kind") == "if":
            out += _flatten(s.get("then"), f"{prefix}{i + 1}.then.")
            out += _flatten(s.get("else"), f"{prefix}{i + 1}.else.")
        elif s.get("kind") == "approval":
            for name, nested in (s.get("branches") or {}).items():
                out += _flatten(nested, f"{prefix}{i + 1}.{name}.")
        elif s.get("kind") == "for_each":
            out += _flatten(s.get("steps"), f"{prefix}{i + 1}.each.")
    return out


def _value_text(v) -> str:
    from workflows.recipients import describe
    if isinstance(v, list) and v and all(isinstance(x, (dict, str)) for x in v) and any(
            isinstance(x, dict) and "kind" in x for x in v):
        return describe(v)
    if isinstance(v, (dict, list)):
        return json.dumps(v, sort_keys=True, default=str)
    if v is None or v == "":
        return "(blank)"
    return str(v)


def diff(a: dict, b: dict) -> list[str]:
    """English lines for what changed from definition `a` to `b`."""
    a, b = normalize_definition(a), normalize_definition(b)
    lines: list[str] = []
    if a["trigger"] != b["trigger"]:
        lines.append(f"Trigger changed from \"{trigger_text(a['trigger'])}\" to \"{trigger_text(b['trigger'])}\"")
    if a["conditions"] != b["conditions"]:
        lines.append("Conditions changed")
    sa = {s.get("id"): (n, s) for n, s in _flatten(a["steps"]) if s.get("id")}
    sb = {s.get("id"): (n, s) for n, s in _flatten(b["steps"]) if s.get("id")}
    for sid, (n, s) in sb.items():
        if sid not in sa:
            lines.append(f"Step {n} added: {_step_label(s)}")
            continue
        n0, s0 = sa[sid]
        if s0 == s:
            continue
        label = _step_label(s)
        if s0.get("kind") != s.get("kind") or s0.get("action") != s.get("action"):
            lines.append(f"Step {n} changed from {_step_label(s0)} to {label}")
            continue
        if bool(s0.get("enabled", True)) != bool(s.get("enabled", True)):
            lines.append(f"Step {n} ({label}): {'switched on' if s.get('enabled', True) else 'skipped'}")
        p0, p1 = s0.get("params") or {}, s.get("params") or {}
        for k in sorted(set(p0) | set(p1)):
            if p0.get(k) != p1.get(k):
                lines.append(f"Step {n} ({label}): {k} changed from {_value_text(p0.get(k))} to {_value_text(p1.get(k))}")
        for k in ("conditions", "source", "branches"):
            if s0.get(k) != s.get(k) and not (k == "branches" and _same_branch_ids(s0, s)):
                lines.append(f"Step {n} ({label}): {k} changed")
        if n0 != n and not lines[-1:] == [f"Step {n} moved"]:
            lines.append(f"Step {n} ({label}) moved from position {n0}")
    for sid, (n, s) in sa.items():
        if sid not in sb:
            lines.append(f"Step {n} removed: {_step_label(s)}")
    if a["settings"] != b["settings"]:
        for k in sorted(set(a["settings"]) | set(b["settings"])):
            if a["settings"].get(k) != b["settings"].get(k):
                lines.append(f"Setting {k} changed from {_value_text(a['settings'].get(k))} to "
                             f"{_value_text(b['settings'].get(k))}")
    return lines or ["No changes"]


def _same_branch_ids(s0: dict, s1: dict) -> bool:
    def ids(s):
        return {name: [x.get("id") for x in (steps or []) if isinstance(x, dict)]
                for name, steps in (s.get("branches") or {}).items()}
    return ids(s0) == ids(s1)


# ── who sees / edits what ────────────────────────────────────────────────────
def grant_rank(db, user: dict) -> int:
    """0 none, 1 viewer, 2 editor, 3 full, 4 owner. An administrator
    bypasses as 4 (require_module_grant's bypass)."""
    import auth
    if not user:
        return 0
    if int(user.get("level", 0) or 0) >= auth._LEVELS["administrator"]:
        return 4
    return auth._module_level((user.get("email") or "").lower(), "workflows", db)


def is_global_admin(user: dict) -> bool:
    return int((user or {}).get("level", 0) or 0) >= 5


def companies_of(db, user: dict):
    """None = every company; else the set the caller may see."""
    import auth
    return auth.company_scope(user, db)


def can_see(db, user: dict, wf: models.Workflow, scope=None) -> bool:
    if grant_rank(db, user) < 1:
        return False
    scope = companies_of(db, user) if scope is None else scope
    if scope is None or not wf.company_id:
        return True
    return wf.company_id in scope


def can_edit(db, user: dict, wf: models.Workflow) -> bool:
    """The owner (editor and up) or a full-level user in scope. An
    every-company workflow (blank company) is a Global Admin's alone: a
    one-company full user sees it but never edits, publishes or runs it."""
    rank = grant_rank(db, user)
    if rank < 2 or not can_see(db, user, wf):
        return False
    if not wf.company_id and not is_global_admin(user):
        return False
    me = (user.get("email") or "").lower()
    return rank >= 3 or me == (wf.owner_email or "").lower()


def visible_workflows(db, user: dict):
    """A Query over the workflows the caller may see (grant + scope)."""
    q = db.query(models.Workflow)
    if grant_rank(db, user) < 1:
        return q.filter(models.Workflow.id == "")
    scope = companies_of(db, user)
    if scope is not None:
        q = q.filter((models.Workflow.company_id == "") | models.Workflow.company_id.in_(sorted(scope)))
    return q


# ── serialization ────────────────────────────────────────────────────────────
def _name(db, email: str) -> str:
    from workflows.context import person_name
    return person_name(db, email) if email else ""


def _company_name(db, company_id: str) -> str:
    if not company_id:
        return "Every Company"
    row = db.get(models.HrEntity, company_id)
    return (row.name if row else "") or company_id


def runs_7d(db, wf: models.Workflow) -> int:
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    return (db.query(models.WorkflowRun)
            .filter(models.WorkflowRun.workflow_id == wf.id, models.WorkflowRun.started_at >= since,
                    models.WorkflowRun.status != "test").count())


def _company_enabled(db, company_id: str) -> bool:
    """Settings > Workflows for the workflow's company (True for every company)."""
    if not company_id:
        return True
    from workflows import settings as wf_settings
    try:
        return bool(wf_settings.get(db, company_id).get("enabled", True))
    except Exception:   # noqa: BLE001 - a settings read never hides the list
        return True


def serialize(db, wf: models.Workflow, *, full: bool = False) -> dict:
    out = {
        "id": wf.id, "name": wf.name or "", "description": wf.description or "",
        "ownerEmail": wf.owner_email or "", "ownerName": _name(db, wf.owner_email or ""),
        "runAs": wf.run_as or "owner", "companyId": wf.company_id or "",
        "companyName": _company_name(db, wf.company_id or ""),
        "status": wf.status or "draft", "version": int(wf.version or 0),
        "trigger": dict(wf.trigger or {}) if not wf.draft else dict((wf.draft or {}).get("trigger") or {}),
        "triggerText": trigger_text((wf.draft or {}).get("trigger") if wf.draft else wf.trigger),
        "runs7d": runs_7d(db, wf), "runCount": int(wf.run_count or 0), "failCount": int(wf.fail_count or 0),
        "lastRunAt": wf.last_run_at or "", "pausedReason": wf.paused_reason or "", "pausedBy": wf.paused_by or "",
        "pausedAt": wf.paused_at or "", "updatedAt": wf.updated_at or "", "updatedBy": wf.updated_by or "",
        "createdAt": wf.created_at or "", "createdBy": wf.created_by or "",
        "hasDraft": isinstance(wf.draft, dict),
        "companyEnabled": _company_enabled(db, wf.company_id or ""),
    }
    if full:
        out["definition"] = definition_of(wf)
        out["draft"] = draft_of(wf)
        out["lastTestedAt"] = wf.last_tested_at or ""
        out["testedCurrent"] = tested_current(wf)
        out["problems"] = [p.to_dict() for p in problems_for(db, wf)]
        out["versions"] = (db.query(models.WorkflowVersion)
                           .filter(models.WorkflowVersion.workflow_id == wf.id).count())
    return out


def serialize_version(db, v: models.WorkflowVersion, *, definition: bool = False) -> dict:
    out = {"version": int(v.version or 0), "publishedBy": v.published_by or "",
           "publishedByName": _name(db, v.published_by or ""), "publishedAt": v.published_at or "",
           "note": v.note or ""}
    if definition:
        out["definition"] = normalize_definition(v.definition)
    return out


def _step_out(s: models.WorkflowRunStep) -> dict:
    return {"id": s.id, "stepId": s.step_id, "kind": s.kind, "action": s.action or "", "label": s.label or "",
            "status": s.status, "startedAt": s.started_at or "", "finishedAt": s.finished_at or "",
            "input": s.input if isinstance(s.input, dict) else {},
            "output": s.output if isinstance(s.output, dict) else {},
            "detail": s.detail or "", "affected": s.affected if isinstance(s.affected, list) else [],
            "attempt": int(s.attempt or 0)}


def run_steps(db, run: models.WorkflowRun) -> list:
    return (db.query(models.WorkflowRunStep).filter(models.WorkflowRunStep.run_id == run.id)
            .order_by(models.WorkflowRunStep.started_at, models.WorkflowRunStep.id).all())


def _viewer_payload(db, viewer, ent, payload: dict) -> dict:
    """The event payload as `viewer` may see it: a registered field hidden
    from them (hr / comp) is dropped from "subject" and "changes" - the
    outbox keeps only public fields already (emit.payload_for), this is the
    second guard on the way out. No viewer = the public fields only."""
    out = dict(payload or {})
    for part in ("subject", "changes"):
        src = out.get(part)
        if not isinstance(src, dict):
            continue
        kept = {}
        for k, v in src.items():
            f = ent.field(k) if ent is not None else None
            if f is not None and catalog.can_see_field(db, viewer, f.visibility):
                kept[k] = v
            elif f is None and ent is None:
                kept[k] = v   # no entity to ask: nothing is registered as hidden
        out[part] = kept
    return out


def _viewer_trace(db, viewer, ent, trace: list) -> list:
    out = []
    for r in trace or []:
        if isinstance(r, dict) and ent is not None:
            f = ent.field(str(r.get("field") or ""))
            if f is not None and not catalog.can_see_field(db, viewer, f.visibility):
                r = {**r, "actual": None}
        out.append(r)
    return out


def serialize_run(db, run: models.WorkflowRun, *, steps: bool = False, viewer: Optional[dict] = None) -> dict:
    ent = catalog.ENTITIES.get(run.entity or "")
    link = {}
    if ent is not None and run.subject_id:
        try:
            row = ent.load_row(db, run.subject_id)
            link = ent.link_for(row, db) if row is not None else {}
        except Exception:   # noqa: BLE001 - a link that cannot be built is no link
            link = {}
    out = {
        "id": run.id, "workflowId": run.workflow_id, "workflowName": run.workflow_name or "",
        "version": int(run.version or 0), "eventId": run.event_id or "", "triggerKind": run.trigger_kind or "",
        "entity": run.entity or "", "subjectId": run.subject_id or "", "subjectLabel": run.subject_label or "",
        "subjectLink": link, "companyId": run.company_id or "", "status": run.status,
        "startedAt": run.started_at or "", "finishedAt": run.finished_at or "", "summary": run.summary or "",
        "error": run.error or "", "replayOf": run.replay_of or "", "startedBy": run.started_by or "",
        "depth": int(run.depth or 0),
    }
    if steps:
        rows = run_steps(db, run)
        cond = next((r for r in rows if r.kind == "conditions"), None)
        out["trace"] = _viewer_trace(db, viewer, ent, (cond.output or {}).get("trace", []) if cond is not None else [])
        out["conditionsPassed"] = (cond.output or {}).get("passed", True) if cond is not None else True
        out["steps"] = [_step_out(r) for r in rows if r.kind != "conditions"]
        ev = db.get(models.WorkflowEvent, run.event_id) if run.event_id else None
        out["event"] = ({"id": ev.id, "key": ev.key, "at": ev.at, "actor": ev.actor,
                         "payload": _viewer_payload(db, viewer, ent, ev.payload if isinstance(ev.payload, dict) else {})}
                        if ev else None)
    return out
