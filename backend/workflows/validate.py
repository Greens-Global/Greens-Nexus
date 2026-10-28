"""Definition validation (spec 8.1, plan Task 5): everything Publish checks
before a workflow may run, as a list of `Problem(path, message)` the
builder shows beside the card it names. The frontend mirrors the main
checks for instant feedback (`lib/definition.js`); this is the one that
counts.

Checked: the shape (`v == 1`), the trigger (its event or entity exists
and the owner may use it), filters and conditions (fields of the entity,
an operator for the type, a value of the right shape), every step (a
unique id, a known kind, required and typed params within `max`,
templates that render against the event's sample with no missing path,
valid recipient specs, an approval with approvers, at least two options
and a branch per option, a For Each over a known list source), the size
guards (25 steps, 10 levels), the run-as rules (Nexus may only message;
admin-only actions need a Global Admin; the owner may perform every action
against the sample context), the settings caps and the owner's grant.

`definition_hash` is the sha256 of the canonical JSON - "tested since the
last edit" compares it.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from typing import Any, Optional

from workflows import catalog
from workflows.context import MISSING, RunContext, template_filters, template_paths

MAX_STEPS = 25
MAX_DEPTH = 10
MAX_RUNS_PER_HOUR = 500
MAX_RECIPIENTS = 200
STEP_KINDS = ("action", "if", "approval", "wait", "for_each", "stop")
TRIGGER_KINDS = ("event", "schedule", "date", "manual")
NEXUS_STEP_KINDS = ("wait", "stop", "if", "for_each")      # plus actions with needs_person=False
WAIT_MODES = ("duration", "until", "business_morning")
APPROVAL_MODES = ("any", "all", "sequence")
ON_ERROR = ("stop", "continue")
DEFAULT_SETTINGS = {
    "oncePerSubject": False, "cooldownHours": 0, "suppress": {"people": [], "companies": []},
    "logSkips": False, "allowDownstream": False, "maxRunsPerHour": 100, "maxRecipients": 50,
    "onError": "stop", "faultSteps": [],
}


@dataclass(frozen=True)
class Problem:
    path: str
    message: str

    def to_dict(self) -> dict:
        return {"path": self.path, "message": self.message}


def definition_hash(definition: dict) -> str:
    raw = json.dumps(definition or {}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ── small checks ─────────────────────────────────────────────────────────────
def _is_time(v: Any) -> bool:
    s = str(v or "")
    if len(s) != 5 or s[2] != ":":
        return False
    try:
        h, m = int(s[:2]), int(s[3:])
    except ValueError:
        return False
    return 0 <= h <= 23 and 0 <= m <= 59


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _empty(v: Any) -> bool:
    return v is None or v == "" or v == [] or v == {}


def _steps_of(step: dict) -> list[tuple[str, list]]:
    """The nested step lists a step owns, with their path segment."""
    out: list[tuple[str, list]] = []
    kind = step.get("kind")
    if kind == "if":
        out.append(("then", step.get("then") or []))
        out.append(("else", step.get("else") or []))
    elif kind == "approval":
        for name, steps in (step.get("branches") or {}).items():
            out.append((f"branches.{name}", steps or []))
    elif kind == "for_each":
        out.append(("steps", step.get("steps") or []))
    return out


def _walk(steps: list, path: str, depth: int, seen_ids: dict, problems: list, counter: list) -> None:
    if not isinstance(steps, list):
        problems.append(Problem(path, "Steps must be a list"))
        return
    if depth > MAX_DEPTH:
        problems.append(Problem(path, f"Steps nest more than {MAX_DEPTH} levels deep"))
        return
    for i, step in enumerate(steps):
        p = f"{path}[{i}]"
        if not isinstance(step, dict):
            problems.append(Problem(p, "A step must be an object"))
            continue
        counter[0] += 1
        sid = str(step.get("id") or "")
        if not sid:
            problems.append(Problem(f"{p}.id", "Every step needs an id"))
        elif sid in seen_ids:
            problems.append(Problem(f"{p}.id", f"Step id {sid!r} is used twice"))
        else:
            seen_ids[sid] = p
        for name, nested in _steps_of(step):
            _walk(nested, f"{p}.{name}", depth + 1, seen_ids, problems, counter)


# ── the context the templates and `allowed` rules are checked against ───────
def _sample_context(db, definition: dict, owner: dict, run_as: str, company_id: str) -> Optional[RunContext]:
    trig = definition.get("trigger") or {}
    kind = trig.get("kind")
    ent = None
    payload: dict = {"subject": {}, "changes": {}, "extra": {}, "actor": ""}
    if kind == "event":
        ev = catalog.EVENTS.get(str(trig.get("event") or ""))
        if ev is None:
            return None
        ent = catalog.ENTITIES.get(ev.entity)
        payload = catalog.sample_payload(ev)
    elif kind in ("date", "manual"):
        ent = catalog.ENTITIES.get(str(trig.get("entity") or ""))
        sample_ev = next((e for e in catalog.EVENTS.values() if ent and e.entity == ent.key and e.sample), None)
        if sample_ev is not None:
            payload = catalog.sample_payload(sample_ev)
    elif kind == "schedule":
        ent = catalog.ENTITIES.get("company")
        payload = {"subject": {"name": "Greens Global"}, "changes": {}, "extra": {}, "actor": ""}
    if ent is None:
        return None
    user = None if run_as == "nexus" else owner
    return RunContext(db=db, definition=definition, entity=ent, subject=None, payload=payload,
                      actor=str(payload.get("actor") or ""), run_as=user, today=date.today(),
                      company_id=company_id or "")


# ── field / condition rows ───────────────────────────────────────────────────
def _check_rows(rows, path: str, ent: Optional[catalog.EntityDef], owner: dict, db, problems: list,
                *, changes_only=None) -> None:
    if rows in (None, []) or ent is None:
        return   # no entity = the trigger problem already says it all
    if not isinstance(rows, list):
        problems.append(Problem(path, "Conditions must be a list"))
        return
    for i, row in enumerate(rows):
        p = f"{path}[{i}]"
        if not isinstance(row, dict):
            problems.append(Problem(p, "A condition must be an object"))
            continue
        fld = str(row.get("field") or "")
        op = str(row.get("op") or "")
        value = row.get("value")
        f = ent.field(fld)
        if f is None:
            problems.append(Problem(f"{p}.field", f"{fld or '(blank)'} is not a field of {ent.label}"))
            continue
        if not catalog.can_see_field(db, owner, f.visibility):
            problems.append(Problem(f"{p}.field", f"You may not use {f.label}"))
            continue
        ops = catalog.OPERATORS.get(f.type, ())
        if op not in ops:
            problems.append(Problem(f"{p}.op", f"{op or '(blank)'} is not an operator for {f.label}"))
            continue
        if op.startswith("changed") and changes_only is not None and fld not in changes_only:
            problems.append(Problem(f"{p}.op", f"This event does not carry a change of {f.label}"))
            continue
        needs_value = op not in ("is_empty", "is_not_empty", "changed")
        if needs_value and _empty(value):
            problems.append(Problem(f"{p}.value", "A value is required"))
            continue
        if op == "is_any_of" and not isinstance(value, (list, str)):
            problems.append(Problem(f"{p}.value", "Pick one or more values"))
        elif op in ("within_next_days", "within_last_days") and not (_is_int(value) or str(value).isdigit()):
            problems.append(Problem(f"{p}.value", "A number of days is required"))
        elif f.type in ("number", "money") and needs_value and not _is_number(value):
            try:
                float(str(value).replace(",", ""))
            except ValueError:
                problems.append(Problem(f"{p}.value", "A number is required"))
        elif f.type in ("date", "datetime") and op in ("is", "before", "after"):
            try:
                date.fromisoformat(str(value)[:10])
            except ValueError:
                problems.append(Problem(f"{p}.value", "A date is required"))


def _check_groups(groups, path: str, ent: Optional[catalog.EntityDef], owner: dict, db, problems: list,
                  *, changes_only=None) -> None:
    """Conditions are groups (OR) of rows (AND): [[row, ...], ...]. A flat
    list of rows is read as one group."""
    if groups in (None, []):
        return
    if not isinstance(groups, list):
        problems.append(Problem(path, "Conditions must be a list of groups"))
        return
    if all(isinstance(g, dict) for g in groups):
        _check_rows(groups, path, ent, owner, db, problems, changes_only=changes_only)
        return
    for gi, rows in enumerate(groups):
        if not isinstance(rows, list):
            problems.append(Problem(f"{path}[{gi}]", "A group must be a list of conditions"))
            continue
        _check_rows(rows, f"{path}[{gi}]", ent, owner, db, problems, changes_only=changes_only)


def _check_recipients(spec, path: str, ent: Optional[catalog.EntityDef], problems: list) -> None:
    from workflows.recipients import KINDS, ROLES
    items = spec if isinstance(spec, list) else ([spec] if spec else [])
    if not items:
        problems.append(Problem(path, "Pick at least one recipient"))
        return
    for i, it in enumerate(items):
        p = f"{path}[{i}]"
        if isinstance(it, str):
            if "@" not in it:
                problems.append(Problem(p, f"{it!r} is not an email address"))
            continue
        if not isinstance(it, dict):
            problems.append(Problem(p, "A recipient must be an object"))
            continue
        kind = str(it.get("kind") or "")
        value = it.get("value")
        if kind == "person":
            if not value or "@" not in str(value):
                problems.append(Problem(p, "Pick a person"))
        elif kind == "role":
            if value not in ROLES:
                problems.append(Problem(p, f"{value!r} is not a role"))
        elif kind in ("department", "team"):
            if _empty(value):
                problems.append(Problem(p, f"Pick a {kind}"))
        elif kind in ("company", "global_admins", "owner", "hr_contact"):
            pass
        elif kind in KINDS or (ent is not None and kind in ent.people):
            if ent is not None and kind not in ent.people:   # no entity = the trigger problem covers it
                problems.append(Problem(p, f"{ent.label} has no {kind.replace('_', ' ')}"))
        else:
            problems.append(Problem(p, f"{kind or '(blank)'} is not a recipient kind"))


def _check_template(text: Any, path: str, ctx: Optional[RunContext], problems: list, max_len=None) -> None:
    s = "" if text is None else str(text)
    if max_len and len(s) > max_len:
        problems.append(Problem(path, f"At most {max_len} characters"))
    known_filters = {k for k, _ in catalog.FILTERS}
    for flt in template_filters(s):
        if flt not in known_filters:
            problems.append(Problem(path, f"{flt} is not a filter"))
    if ctx is None:
        return
    for tpath in template_paths(s):
        if ctx.resolve(tpath) is MISSING:
            problems.append(Problem(path, f"{{{{ {tpath} }}}} is not a field here"))


def _check_param(action: catalog.ActionDef, prm: catalog.Param, value: Any, path: str,
                 ent: Optional[catalog.EntityDef], ctx: Optional[RunContext], problems: list) -> None:
    t = prm.type
    if _empty(value):
        if prm.required and prm.default is None:
            problems.append(Problem(path, f"{prm.label} is required"))
        return
    if t in ("text", "template"):
        if not isinstance(value, str):
            problems.append(Problem(path, f"{prm.label} must be text"))
            return
        if t == "template":
            _check_template(value, path, ctx, problems, prm.max)
        elif prm.max and len(value) > prm.max:
            problems.append(Problem(path, f"At most {prm.max} characters"))
    elif t in ("number", "duration"):
        if not _is_number(value):
            problems.append(Problem(path, f"{prm.label} must be a number"))
        elif prm.max is not None and value > prm.max:
            problems.append(Problem(path, f"{prm.label} is at most {prm.max}"))
    elif t == "bool":
        if not isinstance(value, bool):
            problems.append(Problem(path, f"{prm.label} must be on or off"))
    elif t == "select":
        allowed = [o.get("value") if isinstance(o, dict) else (o[0] if isinstance(o, (list, tuple)) else o)
                   for o in (prm.options or [])] if not isinstance(prm.options, str) else None
        if allowed is not None and value not in allowed:
            problems.append(Problem(path, f"{value!r} is not a choice for {prm.label}"))
    elif t in ("recipients", "approvers"):
        _check_recipients(value, path, ent, problems)
    elif t == "person":
        if not isinstance(value, str) or "@" not in value:
            problems.append(Problem(path, f"Pick a person for {prm.label}"))
    elif t == "options":
        if not isinstance(value, list) or len(value) < 2 or not all(isinstance(o, str) and o for o in value):
            problems.append(Problem(path, f"{prm.label} needs at least two labels"))
    elif t == "list_source":
        key = value.get("key") if isinstance(value, dict) else value
        if key not in catalog.LIST_SOURCES:
            problems.append(Problem(path, f"{key!r} is not a list"))
    elif t == "date_offset":
        if not isinstance(value, dict) or ent is None or not any(d.key == value.get("field") for d in ent.dates):
            problems.append(Problem(path, f"Pick a date of {ent.label if ent else 'the record'}"))
    elif t == "entity_ref":
        if not isinstance(value, (str, dict)) or _empty(value):
            problems.append(Problem(path, f"Pick a {prm.label}"))


# ── steps ────────────────────────────────────────────────────────────────────
def _check_steps(steps: list, path: str, ent: Optional[catalog.EntityDef], ctx: Optional[RunContext],
                 owner: dict, run_as: str, db, problems: list, *, changes_only=None) -> None:
    if not isinstance(steps, list):
        return
    level = int(owner.get("level", 0) or 0)
    for i, step in enumerate(steps):
        p = f"{path}[{i}]"
        if not isinstance(step, dict):
            continue
        kind = str(step.get("kind") or "")
        if kind not in STEP_KINDS:
            problems.append(Problem(f"{p}.kind", f"{kind or '(blank)'} is not a step kind"))
            continue
        if step.get("enabled", True) is False:
            continue   # a skipped step is not checked - it does not run
        params = step.get("params") or {}
        if kind == "action":
            key = str(step.get("action") or "")
            action = catalog.ACTIONS.get(key)
            if action is None:
                problems.append(Problem(f"{p}.action", f"{key or '(blank)'} is not an action"))
                continue
            if run_as == "nexus" and action.needs_person:
                problems.append(Problem(f"{p}.action", f"{action.label} needs a person's identity; Nexus can only send messages"))
            if action.admin_only and level < 5:
                problems.append(Problem(f"{p}.action", f"{action.label} is for Global Admins only"))
            if not isinstance(params, dict):
                problems.append(Problem(f"{p}.params", "Params must be an object"))
                continue
            for prm in action.params:
                _check_param(action, prm, params.get(prm.key), f"{p}.params.{prm.key}", ent, ctx, problems)
            for k in params:
                if action.param(k) is None:
                    problems.append(Problem(f"{p}.params.{k}", f"{action.label} has no setting {k!r}"))
            if action.allowed is not None and ctx is not None and not (run_as == "nexus" and action.needs_person):
                try:
                    reason = action.allowed(ctx, params) or ""
                except Exception as e:   # noqa: BLE001 - a rule that cannot run refuses, with the reason
                    reason = f"could not be checked ({type(e).__name__})"
                if reason:
                    problems.append(Problem(f"{p}.action", str(reason)))
        elif kind == "if":
            _check_groups(step.get("conditions"), f"{p}.conditions", ent, owner, db, problems, changes_only=changes_only)
            for name, nested in _steps_of(step):
                _check_steps(nested, f"{p}.{name}", ent, ctx, owner, run_as, db, problems, changes_only=changes_only)
        elif kind == "approval":
            if run_as == "nexus":
                problems.append(Problem(f"{p}.kind", "Ask For Approval needs a person's identity"))
            if not isinstance(params, dict):
                problems.append(Problem(f"{p}.params", "Params must be an object"))
                continue
            _check_recipients(params.get("approvers"), f"{p}.params.approvers", ent, problems)
            mode = params.get("mode", "any")
            if mode not in APPROVAL_MODES:
                problems.append(Problem(f"{p}.params.mode", f"{mode!r} is not an approval mode"))
            _check_template(params.get("question") or "", f"{p}.params.question", ctx, problems, 1000)
            if _empty(params.get("question")):
                problems.append(Problem(f"{p}.params.question", "A question is required"))
            options = params.get("options") or ["Approve", "Decline"]
            if not isinstance(options, list) or len(options) < 2 or len(set(options)) != len(options):
                problems.append(Problem(f"{p}.params.options", "At least two different options are needed"))
                options = []
            branches = step.get("branches") or {}
            if not isinstance(branches, dict):
                problems.append(Problem(f"{p}.branches", "Branches must be an object keyed by option"))
                branches = {}
            for o in options:
                if o not in branches:
                    problems.append(Problem(f"{p}.branches.{o}", f"Add the steps for {o!r} (an empty list is fine)"))
            for o in branches:
                if o not in options and o != "expired":
                    problems.append(Problem(f"{p}.branches.{o}", f"{o!r} is not one of the options"))
            for k in ("remindDays", "expireDays"):
                if k in params and not _empty(params[k]) and not (_is_int(params[k]) and params[k] >= 0):
                    problems.append(Problem(f"{p}.params.{k}", "A whole number of days"))
            for name, nested in _steps_of(step):
                _check_steps(nested, f"{p}.{name}", ent, ctx, owner, run_as, db, problems, changes_only=changes_only)
        elif kind == "wait":
            if not isinstance(params, dict):
                problems.append(Problem(f"{p}.params", "Params must be an object"))
                continue
            mode = params.get("mode") or "duration"
            if mode not in WAIT_MODES:
                problems.append(Problem(f"{p}.params.mode", f"{mode!r} is not a wait mode"))
            elif mode == "duration":
                mins = params.get("minutes")
                if not _is_number(mins) or mins <= 0:
                    problems.append(Problem(f"{p}.params.minutes", "How long to wait, in minutes"))
            elif mode == "until":
                fld = params.get("field")
                if ent is None or not any(d.key == fld for d in ent.dates):
                    problems.append(Problem(f"{p}.params.field", "Pick a date of the record to wait for"))
                off = params.get("offsetDays", 0)
                if not _is_int(off):
                    problems.append(Problem(f"{p}.params.offsetDays", "A whole number of days"))
        elif kind == "for_each":
            src = step.get("source") or {}
            key = src.get("key") if isinstance(src, dict) else src
            ls = catalog.LIST_SOURCES.get(str(key or ""))
            if ls is None:
                problems.append(Problem(f"{p}.source", f"{key or '(blank)'} is not a list"))
            else:
                sp = (src.get("params") or {}) if isinstance(src, dict) else {}
                for prm in ls.params:
                    _check_param(None, prm, sp.get(prm.key), f"{p}.source.params.{prm.key}", ent, ctx, problems)
                # Inside a For Each the item IS the subject (the engine swaps
                # the entity, the subject and the people roles to the list
                # source's entity for the nested steps), so the nested steps
                # are checked against that entity and its sample; the item
                # carries no change, so `changed*` operators are refused.
                inner = catalog.ENTITIES.get(ls.entity)
                inner_ctx = None
                if ctx is not None and inner is not None:
                    sample_ev = next((e for e in catalog.EVENTS.values() if e.entity == inner.key and e.sample), None)
                    item = catalog.sample_payload(sample_ev)["subject"] if sample_ev else {}
                    inner_ctx = RunContext(db=db, definition=ctx.definition, entity=inner, subject=None,
                                           payload={"subject": dict(item), "changes": {}, "extra": {}, "actor": ctx.actor},
                                           actor=ctx.actor, run_as=ctx.run_as, today=ctx.today, item=item,
                                           company_id=ctx.company_id)
                _check_steps(step.get("steps") or [], f"{p}.steps", inner or ent, inner_ctx or ctx, owner, run_as, db,
                             problems, changes_only=set())
        elif kind == "stop":
            pass


# ── trigger ──────────────────────────────────────────────────────────────────
def _check_trigger(trig: Any, owner: dict, db, problems: list):
    """Returns (entity, changes_only)."""
    if not isinstance(trig, dict):
        problems.append(Problem("trigger", "Pick a trigger"))
        return None, None
    kind = str(trig.get("kind") or "")
    if kind not in TRIGGER_KINDS:
        problems.append(Problem("trigger.kind", f"{kind or '(blank)'} is not a trigger kind"))
        return None, None
    if kind == "event":
        key = str(trig.get("event") or "")
        ev = catalog.EVENTS.get(key)
        if ev is None:
            problems.append(Problem("trigger.event", f"{key or '(blank)'} is not an event"))
            return None, None
        if not catalog.may_use_event(db, owner, ev):
            problems.append(Problem("trigger.event", f"You may not build on {ev.label}"))
        ent = catalog.ENTITIES.get(ev.entity)
        _check_rows(trig.get("filters"), "trigger.filters", ent, owner, db, problems, changes_only=set(ev.changes))
        return ent, set(ev.changes)
    if kind == "schedule":
        if trig.get("every") not in ("day", "week", "month"):
            problems.append(Problem("trigger.every", "Every day, week or month"))
        days = trig.get("days") or []
        if not isinstance(days, list) or not all(_is_int(d) for d in days):
            problems.append(Problem("trigger.days", "Days must be numbers"))
        elif trig.get("every") == "week" and (not days or any(d < 1 or d > 7 for d in days)):
            problems.append(Problem("trigger.days", "Pick the days of the week (1-7)"))
        elif trig.get("every") == "month" and (not days or any(d < 1 or d > 31 for d in days)):
            problems.append(Problem("trigger.days", "Pick the days of the month (1-31)"))
        if not _is_time(trig.get("time")):
            problems.append(Problem("trigger.time", "A time as HH:MM"))
        return catalog.ENTITIES.get("company"), set()
    ent = catalog.ENTITIES.get(str(trig.get("entity") or ""))
    if ent is None:
        problems.append(Problem("trigger.entity", f"{trig.get('entity') or '(blank)'} is not a record kind"))
        return None, set()
    if kind == "date":
        fld = trig.get("field")
        if not any(d.key == fld for d in ent.dates):
            problems.append(Problem("trigger.field", f"{fld or '(blank)'} is not a date of {ent.label}"))
        if not _is_int(trig.get("offsetDays", 0)):
            problems.append(Problem("trigger.offsetDays", "A whole number of days (before is negative)"))
        if not _is_time(trig.get("time", "08:00")):
            problems.append(Problem("trigger.time", "A time as HH:MM"))
    return ent, set()


# ── settings ─────────────────────────────────────────────────────────────────
def _check_settings(settings: Any, problems: list) -> None:
    if settings in (None, {}):
        return
    if not isinstance(settings, dict):
        problems.append(Problem("settings", "Settings must be an object"))
        return
    for k in ("oncePerSubject", "logSkips", "allowDownstream"):
        if k in settings and not isinstance(settings[k], bool):
            problems.append(Problem(f"settings.{k}", "On or off"))
    for k, cap in (("maxRunsPerHour", MAX_RUNS_PER_HOUR), ("maxRecipients", MAX_RECIPIENTS)):
        v = settings.get(k)
        if v is None:
            continue
        if not _is_int(v) or v < 1:
            problems.append(Problem(f"settings.{k}", "A whole number, at least 1"))
        elif v > cap:
            problems.append(Problem(f"settings.{k}", f"At most {cap}"))
    ch = settings.get("cooldownHours")
    if ch is not None and (not _is_number(ch) or ch < 0):
        problems.append(Problem("settings.cooldownHours", "A number of hours, 0 for none"))
    if settings.get("onError", "stop") not in ON_ERROR:
        problems.append(Problem("settings.onError", "Stop or continue"))
    sup = settings.get("suppress")
    if sup is not None and (not isinstance(sup, dict)
                            or not isinstance(sup.get("people", []), list)
                            or not isinstance(sup.get("companies", []), list)):
        problems.append(Problem("settings.suppress", "People and companies lists"))
    for k in settings:
        if k not in DEFAULT_SETTINGS:
            problems.append(Problem(f"settings.{k}", f"{k!r} is not a setting"))


def _owner_may_build(db, owner: dict) -> str:
    import auth
    level = int(owner.get("level", 0) or 0)
    email = (owner.get("email") or "").lower()
    if not email:
        return "The workflow needs an owner"
    if owner.get("external"):
        return "An external user cannot own a workflow"
    if level >= auth._LEVELS["administrator"]:
        return ""
    if auth._module_level(email, "workflows", db) >= auth._MODULE_LEVEL_RANK["editor"]:
        return ""
    return "The owner needs the Workflows grant (editor or above)"


# ── the whole definition ─────────────────────────────────────────────────────
def validate(db, definition: dict, *, owner: dict, run_as: str, company_id: str) -> list[Problem]:
    """Every problem in `definition` for this owner / run-as / scope; an
    empty list means Publish may go ahead."""
    catalog.load_packs()
    problems: list[Problem] = []
    if not isinstance(definition, dict):
        return [Problem("", "The definition must be an object")]
    if definition.get("v") != 1:
        problems.append(Problem("v", "This definition is not version 1"))
    owner = owner or {}
    level = int(owner.get("level", 0) or 0)
    reason = _owner_may_build(db, owner)
    if reason:
        problems.append(Problem("owner", reason))
    if run_as not in ("owner", "nexus"):
        problems.append(Problem("runAs", f"{run_as!r} is not a run-as"))
    elif run_as == "nexus" and level < 5:
        problems.append(Problem("runAs", "Only a Global Admin may run a workflow as Nexus"))
    if (company_id or "") == "" and level < 5:
        problems.append(Problem("companyId", "Only a Global Admin may run a workflow for every company"))
    ent, changes_only = _check_trigger(definition.get("trigger"), owner, db, problems)
    _check_groups(definition.get("conditions"), "conditions", ent, owner, db, problems, changes_only=changes_only)
    steps = definition.get("steps")
    if not isinstance(steps, list):
        problems.append(Problem("steps", "Steps must be a list"))
        steps = []
    elif not steps:
        problems.append(Problem("steps", "Add at least one step"))
    settings = definition.get("settings") or {}
    _check_settings(settings, problems)
    fault = settings.get("faultSteps") if isinstance(settings, dict) else None
    if fault is not None and not isinstance(fault, list):
        problems.append(Problem("settings.faultSteps", "Fault steps must be a list"))
        fault = []
    seen: dict = {}
    counter = [0]
    _walk(steps, "steps", 1, seen, problems, counter)
    _walk(fault or [], "settings.faultSteps", 1, seen, problems, counter)
    if counter[0] > MAX_STEPS:
        problems.append(Problem("steps", f"A workflow has at most {MAX_STEPS} steps (this one has {counter[0]})"))
    ctx = _sample_context(db, definition, owner, run_as, company_id) if ent is not None else None
    _check_steps(steps, "steps", ent, ctx, owner, run_as, db, problems, changes_only=changes_only)
    _check_steps(fault or [], "settings.faultSteps", ent, ctx, owner, run_as, db, problems, changes_only=changes_only)
    # the same problem reported twice (a nested walk and the step check) reads once
    out: list[Problem] = []
    for pr in problems:
        if pr not in out:
            out.append(pr)
    return out
