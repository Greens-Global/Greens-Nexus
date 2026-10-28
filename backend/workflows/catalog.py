"""The Workflows catalog (Neil, Oct 28 2026, spec section 5): the contract
between the backend and the builder. Every module registers the records a
workflow can be about (entities), what happens to them (events), what a
workflow may do (actions) and what a schedule can loop over (list sources)
in its pack under workflows/packs/. The frontend renders only what
`GET /workflows/catalog` returns (`serialize`), so a new field, event or
action shows up in the builder on the next deploy with no frontend work.

Registration is eager: `@entity(...)` / `@event(...)` / `@action(...)` /
`@list_source(...)` register when the decorator factory runs and return an
identity decorator, so a pack is a list of decorated stubs that read as a
table. A key registered twice, or an event for an entity nobody registered,
raises at import - the catalog is kept honest by failing loudly, not by
silently taking the last writer.

`snapshot()` is the deterministic, db-free picture of the whole catalog;
`write_lock` / `lock_matches` keep workflows/catalog.lock.json in step with
it so a PR that changes the catalog shows the diff.

Nothing here imports `models` at module level: database.py wires the
observer at import time, before `Base` exists, so the packs (which do
import models) are loaded lazily by `load_packs()`.
"""
from __future__ import annotations

import importlib
import inspect
import json
import os
import threading
from dataclasses import dataclass, field as dc_field
from datetime import datetime, timezone
from typing import Any, Callable, Optional

FIELD_TYPES = ("text", "number", "date", "datetime", "select", "person", "people", "bool", "money")
PARAM_TYPES = ("text", "template", "number", "bool", "select", "recipients", "person", "entity_ref",
               "duration", "date_offset", "list_source", "options", "approvers")
VISIBILITIES = ("all", "hr", "comp")
VOLUMES = ("normal", "high")

# Operators per field type and the English the builder shows (sentence case).
OPERATOR_LABELS = {
    "is": "is", "is_not": "is not", "is_any_of": "is any of", "contains": "contains",
    "is_empty": "is empty", "is_not_empty": "is not empty",
    "changed": "changed", "changed_to": "changed to", "changed_from": "changed from",
    "gt": "is greater than", "lt": "is less than",
    "before": "is before", "after": "is after",
    "within_next_days": "within the next N days", "within_last_days": "within the last N days",
    "includes": "includes",
}
OPERATORS = {
    "text": ("is", "is_not", "contains", "is_empty", "is_not_empty", "changed", "changed_to", "changed_from"),
    "number": ("is", "is_not", "gt", "lt", "is_empty", "changed"),
    "money": ("is", "is_not", "gt", "lt", "is_empty", "changed"),
    "date": ("is", "before", "after", "within_next_days", "within_last_days", "is_empty", "changed"),
    "datetime": ("is", "before", "after", "within_next_days", "within_last_days", "is_empty", "changed"),
    "select": ("is", "is_not", "is_any_of", "changed", "changed_to", "changed_from"),
    "person": ("is", "is_not", "includes", "is_empty", "changed"),
    "people": ("is", "is_not", "includes", "is_empty", "changed"),
    "bool": ("is", "changed"),
}
# Template filters: `{{ subject.start_date | us_date }}`.
FILTERS = (
    ("us_date", "US date (MM/DD/YYYY)"),
    ("us_datetime", "US date and time"),
    ("upper", "UPPER CASE"),
    ("lower", "lower case"),
    ("default", "Default when empty"),
)
# Labels for the people roles an entity may declare (`people={"manager": fn}`).
PEOPLE_LABELS = {
    "self": "The Person", "manager": "Manager", "hr_contact": "HR Contact", "assignees": "Assignees",
    "assignee": "Assignee", "creator": "Creator", "followers": "Followers", "approver": "Approver",
    "owner": "Owner", "requester": "Requester", "participants": "Participants",
    "project_owner": "Project Owner", "global_admins": "Global Admins", "borrower": "Borrower",
}
# Modules every employee may read without a grant: their events are offered
# to every owner. Any other module needs the grant of the same id (or an
# administrator) - a pack whose grant id differs sets `may_use` itself.
OPEN_MODULES = frozenset({"core", "tasks", "tickets"})


# ── definitions ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Field:
    key: str
    label: str
    type: str
    options: Any = None          # None | [values or {value,label}] | "an options source name"
    visibility: str = "all"      # all | hr | comp
    yearly: bool = False
    path: Optional[str] = None   # attribute path on the row when it differs from key ("personal.dob")


def F(key: str, label: str, type: str, *, options=None, visibility: str = "all", yearly: bool = False,
      path: Optional[str] = None) -> Field:
    if type not in FIELD_TYPES:
        raise ValueError(f"field {key}: unknown type {type!r}")
    if visibility not in VISIBILITIES:
        raise ValueError(f"field {key}: unknown visibility {visibility!r}")
    return Field(key, label, type, options, visibility, yearly, path)


@dataclass(frozen=True)
class DateField:
    key: str
    label: str
    yearly: bool = False


def D(key: str, label: Optional[str] = None, yearly: bool = False) -> DateField:
    return DateField(key, label or key, yearly)


@dataclass(frozen=True)
class Param:
    key: str
    label: str
    type: str
    required: bool = True
    max: Optional[int] = None
    options: Any = None
    default: Any = None
    hint: str = ""


def P(key: str, label: str, type: str, *, required: bool = True, max: Optional[int] = None, options=None,
      default=None, hint: str = "") -> Param:
    if type not in PARAM_TYPES:
        raise ValueError(f"param {key}: unknown type {type!r}")
    return Param(key, label, type, required, max, options, default, hint)


@dataclass
class EntityDef:
    key: str
    label: str
    model: Any
    module: str
    company: Optional[Callable]              # (row) -> company id
    link: Optional[Callable]                 # (row) -> {"view", "sub"} or a navigate detail
    people: dict                             # role -> (db, row) -> [emails]
    fields: list
    dates: list                              # [DateField]
    observe: bool = False
    observe_fields: tuple = ()
    load: Optional[Callable] = None          # (db, id) -> row
    label_of: Optional[Callable] = None      # (row) -> str
    visible_to: Optional[Callable] = None    # (db, user, row) -> bool
    people_labels: dict = dc_field(default_factory=dict)

    def field(self, key: str) -> Optional[Field]:
        for f in self.fields:
            if f.key == key:
                return f
        return None

    def company_of(self, row) -> str:
        if row is None or self.company is None:
            return ""
        try:
            return str(self.company(row) or "")
        except Exception:   # noqa: BLE001 - a missing company reads as blank, never breaks an emit
            return ""

    def load_row(self, db, row_id: str):
        if self.load is not None:
            return self.load(db, row_id)
        if self.model is None or not row_id:
            return None
        return db.get(self.model, row_id)

    def label_for(self, row) -> str:
        if row is None:
            return ""
        if self.label_of is not None:
            try:
                return str(self.label_of(row) or "")
            except Exception:   # noqa: BLE001
                return ""
        return str(getattr(row, "name", None) or getattr(row, "id", "") or "")

    def link_for(self, row, db=None) -> dict:
        """The navigate detail for `row`; a link callable declared as
        `(row, db)` also gets the session (a period lookup, say)."""
        if row is None or self.link is None:
            return {}
        try:
            if _takes_db(self.link):
                return dict(self.link(row, db) or {})
            return dict(self.link(row) or {})
        except Exception:   # noqa: BLE001
            return {}

    def can_see(self, db, user, row) -> bool:
        if self.visible_to is None:
            return True
        return bool(self.visible_to(db, user, row))

    def people_label(self, role: str) -> str:
        return self.people_labels.get(role) or PEOPLE_LABELS.get(role) or role.replace("_", " ").title()


@dataclass
class EventDef:
    key: str
    entity: str
    label: str
    module: str
    group: str
    changes: tuple
    sample: dict
    volume: str = "normal"
    may_use: Optional[Callable] = None       # (db, user) -> bool


@dataclass
class ActionDef:
    key: str
    label: str
    module: str
    params: list
    plan: Callable                           # (ctx, params) -> str
    run: Callable                            # (ctx, params) -> {"line", "affected", "sent"}
    allowed: Optional[Callable] = None       # (ctx, params) -> '' or the reason
    needs_person: bool = True
    admin_only: bool = False

    def param(self, key: str) -> Optional[Param]:
        for p in self.params:
            if p.key == key:
                return p
        return None


@dataclass
class ListSourceDef:
    key: str
    label: str
    entity: str
    module: str
    params: list
    fn: Callable                             # (db, ctx, params) -> [rows]


ENTITIES: dict[str, EntityDef] = {}
EVENTS: dict[str, EventDef] = {}
ACTIONS: dict[str, ActionDef] = {}
LIST_SOURCES: dict[str, ListSourceDef] = {}
# Option sources (Task 6): a field or param whose `options` is a string names
# one of these; `serialize` serves the list it returns (`fn(db) -> [{value,
# label}]`), `snapshot` keeps the name. A name nobody registered ("task_projects")
# is passed through for the builder to load itself.
OPTION_SOURCES: dict[str, Callable] = {}


def _identity(obj):
    return obj


def _takes_db(fn) -> bool:
    try:
        return len(inspect.signature(fn).parameters) >= 2
    except (TypeError, ValueError):
        return False


def _fresh(registry: dict, key: str, what: str) -> None:
    if not key or not isinstance(key, str):
        raise ValueError(f"{what}: a key is required")
    if key in registry:
        raise ValueError(f"{what} {key!r} is already registered")


# ── registration ─────────────────────────────────────────────────────────────
def entity(key: str, *, label: str, model, company=None, link=None, people=None, fields=(), dates=(),
           observe: bool = False, observe_fields=(), load=None, label_of=None, visible_to=None,
           module: str = "core", people_labels=None):
    """Register a kind of record. `fields` are F(...); `dates` are field keys
    (label and yearly from the field) or D(key, label, yearly) for a second
    reading of a field ("Work Anniversary" on start_date). `people` maps a
    role to (db, row) -> [emails]. `observe=True` with `observe_fields` makes
    the record observer emit `<key>.created` / `<key>.field_changed`."""
    _fresh(ENTITIES, key, "entity")
    flds = list(fields)
    seen = set()
    for f in flds:
        if not isinstance(f, Field):
            raise ValueError(f"entity {key}: fields must be F(...), got {f!r}")
        if f.key in seen:
            raise ValueError(f"entity {key}: field {f.key!r} listed twice")
        seen.add(f.key)
    dts: list = []
    for d in dates:
        if isinstance(d, DateField):
            dts.append(d)
            continue
        f = next((x for x in flds if x.key == d), None)
        if f is None or f.type not in ("date", "datetime"):
            raise ValueError(f"entity {key}: date {d!r} is not a date field")
        dts.append(DateField(f.key, f.label, f.yearly))
    for of in observe_fields:
        if of not in seen:
            raise ValueError(f"entity {key}: observe field {of!r} is not a field")
    ENTITIES[key] = EntityDef(key=key, label=label, model=model, module=module, company=company, link=link,
                              people=dict(people or {}), fields=flds, dates=dts, observe=bool(observe),
                              observe_fields=tuple(observe_fields), load=load, label_of=label_of,
                              visible_to=visible_to, people_labels=dict(people_labels or {}))
    return _identity


def event(key: str, *, entity: str, label: str, module: str, group: str, changes=(), sample=None,
          volume: str = "normal", may_use=None):
    """Register something that happens to an entity. `changes` names the
    fields whose from / to the event carries; `sample` is a realistic
    payload (the subject's fields, or a whole {"subject","changes","extra",
    "actor"} payload) the dry-run and the tests use; `volume="high"` rows
    are written only while a workflow subscribes."""
    _fresh(EVENTS, key, "event")
    if entity not in ENTITIES:
        raise ValueError(f"event {key}: entity {entity!r} is not registered")
    if volume not in VOLUMES:
        raise ValueError(f"event {key}: unknown volume {volume!r}")
    ent = ENTITIES[entity]
    for c in changes:
        if ent.field(c) is None:
            raise ValueError(f"event {key}: change {c!r} is not a field of {entity}")
    EVENTS[key] = EventDef(key=key, entity=entity, label=label, module=module, group=group,
                           changes=tuple(changes), sample=dict(sample or {}), volume=volume, may_use=may_use)
    return _identity


def action(key: str, *, label: str, module: str, params=(), plan, run, allowed=None,
           needs_person: bool = True, admin_only: bool = False):
    """Register something a workflow may do. `plan(ctx, params) -> str` is
    the dry-run line; `run(ctx, params) -> dict` does it (idempotent on the
    run step); `allowed(ctx, params) -> ''` or a readable reason.
    `needs_person=False` only for actions the Nexus system actor may run
    (messages); every module action needs a directory person's identity."""
    _fresh(ACTIONS, key, "action")
    ps = list(params)
    seen = set()
    for p in ps:
        if not isinstance(p, Param):
            raise ValueError(f"action {key}: params must be P(...), got {p!r}")
        if p.key in seen:
            raise ValueError(f"action {key}: param {p.key!r} listed twice")
        seen.add(p.key)
    if not callable(plan) or not callable(run):
        raise ValueError(f"action {key}: plan and run must be callables")
    ACTIONS[key] = ActionDef(key=key, label=label, module=module, params=ps, plan=plan, run=run,
                             allowed=allowed, needs_person=bool(needs_person), admin_only=bool(admin_only))
    return _identity


def list_source(key: str, *, label: str, entity: str, module: str, params=(), fn):
    """Register a list a For Each step may loop over (the rows are `entity`
    rows); `fn(db, ctx, params) -> [rows]`."""
    _fresh(LIST_SOURCES, key, "list source")
    if entity not in ENTITIES:
        raise ValueError(f"list source {key}: entity {entity!r} is not registered")
    if not callable(fn):
        raise ValueError(f"list source {key}: fn must be a callable")
    LIST_SOURCES[key] = ListSourceDef(key=key, label=label, entity=entity, module=module,
                                      params=list(params), fn=fn)
    return _identity


def option_source(key: str, fn: Callable) -> None:
    """Register `fn(db) -> [{"value", "label"}]` as the list behind
    `options="<key>"` on a field or param (served by `serialize`)."""
    _fresh(OPTION_SOURCES, key, "option source")
    if not callable(fn):
        raise ValueError(f"option source {key}: fn must be a callable")
    OPTION_SOURCES[key] = fn


def options_for(db, name: str) -> Any:
    """The served form of a string options name: the registered source's
    list (an empty list when it fails), else the name itself."""
    fn = OPTION_SOURCES.get(name)
    if fn is None or db is None:
        return name
    try:
        return _options_out(fn(db))
    except Exception as e:   # noqa: BLE001 - one broken list never hides the catalog
        print(f"[workflows] option source {name} failed: {type(e).__name__}: {str(e)[:120]}")
        return []


# ── packs ────────────────────────────────────────────────────────────────────
_packs_lock = threading.Lock()
_packs_loaded = False


def load_packs() -> None:
    """Import every workflows/packs/*.py once (sorted, so registration order
    is stable). Idempotent; a pack that fails to import raises - a broken
    catalog must not boot quietly."""
    global _packs_loaded
    if _packs_loaded:
        return
    with _packs_lock:
        if _packs_loaded:
            return
        folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "packs")
        names = sorted(n[:-3] for n in os.listdir(folder)
                       if n.endswith(".py") and not n.startswith("_"))
        for name in names:
            importlib.import_module(f"workflows.packs.{name}")
        _packs_loaded = True


# ── visibility ───────────────────────────────────────────────────────────────
def can_see_field(db, user: Optional[dict], visibility: str) -> bool:
    """Whether `user` may see a field of this visibility: `hr` needs the HR
    grant (viewer) or an administrator; `comp` needs the hr_comp grant or
    an owner (as routers/hr.py's pay reads). No user (the Nexus system
    actor) sees `all` only."""
    if visibility == "all":
        return True
    if not user:
        return False
    import auth
    level = int(user.get("level", 0) or 0)
    email = (user.get("email") or "").lower()
    if visibility == "hr":
        return level >= auth._LEVELS["administrator"] or auth._module_level(email, "hr", db) >= 1
    if visibility == "comp":
        return level >= auth._LEVELS["owner"] or auth._module_level(email, "hr_comp", db) >= 1
    return False


def may_use_event(db, user: Optional[dict], ev: EventDef) -> bool:
    """Whether `user` may build on this event: the event's own `may_use`,
    else the entity's module must be open or granted (or an administrator)."""
    if ev.may_use is not None:
        try:
            return bool(ev.may_use(db, user))
        except Exception:   # noqa: BLE001 - a broken rule hides the event, never 500s the catalog
            return False
    if not user:
        return False
    ent = ENTITIES.get(ev.entity)
    module = ent.module if ent else ev.module
    if module in OPEN_MODULES:
        return True
    import auth
    level = int(user.get("level", 0) or 0)
    email = (user.get("email") or "").lower()
    return level >= auth._LEVELS["administrator"] or auth._module_level(email, module, db) >= 1


# ── serialization ────────────────────────────────────────────────────────────
def _options_out(options):
    if options is None:
        return None
    if isinstance(options, str):
        return options
    out = []
    for o in options:
        if isinstance(o, dict):
            out.append({"value": o.get("value", ""), "label": o.get("label", o.get("value", ""))})
        elif isinstance(o, (list, tuple)) and len(o) == 2:
            out.append({"value": o[0], "label": o[1]})
        else:
            out.append({"value": o, "label": str(o)})
    return out


def _field_out(f: Field, db=None) -> dict:
    out = {"key": f.key, "label": f.label, "type": f.type, "visibility": f.visibility}
    if f.options is not None:
        out["options"] = options_for(db, f.options) if isinstance(f.options, str) else _options_out(f.options)
    return out


def _param_out(p: Param, db=None) -> dict:
    options = options_for(db, p.options) if isinstance(p.options, str) else _options_out(p.options)
    return {"key": p.key, "label": p.label, "type": p.type, "required": bool(p.required), "max": p.max,
            "options": options, "default": p.default, "hint": p.hint or ""}


def _entity_out(ent: EntityDef, fields: list, db=None) -> dict:
    return {
        "key": ent.key, "label": ent.label, "module": ent.module,
        "fields": [_field_out(f, db) for f in fields],
        "dates": [{"key": d.key, "label": d.label, "yearly": bool(d.yearly)} for d in ent.dates],
        "people": [{"key": r, "label": ent.people_label(r)} for r in ent.people],
    }


def _event_out(ev: EventDef) -> dict:
    return {"key": ev.key, "entity": ev.entity, "label": ev.label, "module": ev.module, "group": ev.group,
            "changes": list(ev.changes), "volume": ev.volume}


def _action_out(a: ActionDef, db=None) -> dict:
    return {"key": a.key, "label": a.label, "module": a.module, "params": [_param_out(p, db) for p in a.params],
            "needsPerson": bool(a.needs_person), "adminOnly": bool(a.admin_only)}


def _list_source_out(s: ListSourceDef, db=None) -> dict:
    return {"key": s.key, "label": s.label, "entity": s.entity, "module": s.module,
            "params": [_param_out(p, db) for p in s.params]}


def _operators_out() -> dict:
    return {t: [{"key": k, "label": OPERATOR_LABELS[k]} for k in ops] for t, ops in OPERATORS.items()}


def _filters_out() -> list:
    return [{"key": k, "label": lbl} for k, lbl in FILTERS]


def serialize(db, user: dict) -> dict:
    """The catalog as `user` may use it: fields they may not see are left
    out, events they may not build on are left out, admin-only actions need
    an owner. Shape (pinned, the builder renders it):
      entities / events / actions / listSources / operators / filters / generatedAt."""
    import auth
    load_packs()
    level = int((user or {}).get("level", 0) or 0)
    entities = []
    for key in sorted(ENTITIES):
        ent = ENTITIES[key]
        fields = [f for f in ent.fields if can_see_field(db, user, f.visibility)]
        entities.append(_entity_out(ent, fields, db))
    events = [_event_out(EVENTS[k]) for k in sorted(EVENTS) if may_use_event(db, user, EVENTS[k])]
    actions = [_action_out(ACTIONS[k], db) for k in sorted(ACTIONS)
               if not ACTIONS[k].admin_only or level >= auth._LEVELS["owner"]]
    sources = [_list_source_out(LIST_SOURCES[k], db) for k in sorted(LIST_SOURCES)]
    return {
        "entities": entities, "events": events, "actions": actions, "listSources": sources,
        "operators": _operators_out(), "filters": _filters_out(),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def snapshot() -> dict:
    """Everything registered, for everyone, with no db and nothing that
    varies between runs - the lock file's content."""
    load_packs()
    return {
        "entities": [_entity_out(ENTITIES[k], ENTITIES[k].fields) for k in sorted(ENTITIES)],
        "events": [_event_out(EVENTS[k]) for k in sorted(EVENTS)],
        "actions": [_action_out(ACTIONS[k]) for k in sorted(ACTIONS)],
        "listSources": [_list_source_out(LIST_SOURCES[k]) for k in sorted(LIST_SOURCES)],
        "operators": _operators_out(),
        "filters": _filters_out(),
    }


def _canonical(data: dict) -> str:
    return json.dumps(data, sort_keys=True, indent=2, default=str) + "\n"


def write_lock(path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(_canonical(snapshot()))


def lock_matches(path: str) -> bool:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read() == _canonical(snapshot())
    except OSError:
        return False


def sample_payload(ev: EventDef) -> dict:
    """The event's sample as a full outbox payload: a sample that is only the
    subject's fields is wrapped; one that already has "subject" is used as
    is (with the other keys defaulted)."""
    s = dict(ev.sample or {})
    if "subject" in s and isinstance(s["subject"], dict):
        return {"subject": dict(s["subject"]), "changes": dict(s.get("changes") or {}),
                "extra": dict(s.get("extra") or {}), "actor": str(s.get("actor") or "")}
    return {"subject": s, "changes": {}, "extra": {}, "actor": ""}
