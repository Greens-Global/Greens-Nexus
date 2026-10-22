"""Tasks - conditional row colors (Neil, Oct 22 2026).

A project keeps an ordered list of rules that color its task rows by their
data, Smartsheet / monday style: "Priority is Urgent and Due Date is overdue"
paints the row red. Stored whole on `task_projects.color_rules` and written
only through PUT /task-projects/{id}/color-rules (routers/task_projects.py),
under the project row lock.

The rules are EVALUATED in the browser (frontend/src/tasks/colorRules.js) -
the server never colors anything. What the server owns is the shape: every
rule that reaches a screen has a known field, a known operator for that
field, a value of the right kind and a color from the palette, so a bad rule
can never crash a list for everyone on the project.

The field / operator vocabulary below must match colorRules.js. A condition
that names something which was later deleted (a custom field, a select
option) is KEPT - the editor shows it as "needs attention" and it never
matches - so the references are checked only for conditions that are new or
changed in a save. That way deleting a field never makes a project's other
rules unsaveable.
"""
import hashlib
import json
import re
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import func

MAX_RULES = 20
MAX_CONDITIONS = 5
MAX_NAME = 60
MAX_TEXT = 120
MAX_LIST = 50
MAX_DAYS = 365
MAX_BYTES = 32 * 1024

# The soft label palette (tasks/theme.js NX accents + slate). Stored as the
# KEY, never a hex, so the look can be retuned without touching any row. No
# blue: a faint blue row is what a selected row looks like (colorRules.js).
PALETTE = ("red", "amber", "green", "teal", "purple", "pink", "gray")

PRIORITIES = ("low", "medium", "high", "urgent")
# The statuses every project has (tasks/theme.js STATUS_META); custom ones are
# TaskCustomStatus ids.
BUILTIN_STATUSES = frozenset({"not_started", "in_progress", "recurring", "completed", "missed"})

# Value kinds an operator takes.
#   none    - no value ("is me", "is overdue")
#   text    - a short string (a status id, an option id, a tag, text to find)
#   person  - a work email
#   list    - a non-empty list of short strings ("is any of")
#   days    - a whole number of days, 0..MAX_DAYS
#   date    - YYYY-MM-DD
#   number  - a finite number
#   range   - [low, high] numbers
OP_KIND = {
    "is": "text", "is_not": "text", "is_any_of": "list",
    "is_me": "none", "is_not_me": "none", "is_unassigned": "none", "is_assigned": "none",
    "person_is": "person", "person_is_not": "person",
    "contains": "text", "not_contains": "text",
    "person_contains": "person",
    "is_empty": "none", "is_not_empty": "none",
    "is_true": "none", "is_false": "none",
    "overdue": "none", "past": "none", "today": "none", "within": "days",
    "before": "date", "after": "date", "on": "date",
    "eq": "number", "ne": "number", "gt": "number", "gte": "number", "lt": "number", "lte": "number",
    "between": "range",
}

_DATE_OPS = ("overdue", "today", "within", "before", "after", "on", "is_empty", "is_not_empty")

# Built-in fields -> the operators each offers.
BUILTIN_OPS = {
    "status": ("is", "is_not", "is_any_of"),
    "priority": ("is", "is_not", "is_any_of"),
    "assignee": ("is_me", "is_not_me", "person_is", "person_is_not", "is_unassigned", "is_assigned"),
    "tags": ("contains", "not_contains", "is_empty", "is_not_empty"),
    "section": ("is", "is_not", "is_empty"),
    "due": _DATE_OPS,
    "start": ("past", "today", "within", "before", "after", "on", "is_empty", "is_not_empty"),
    "completed": ("is_true", "is_false"),
    "created_by": ("is_me", "person_is", "person_is_not"),
}

# Custom field storage kind -> operators (models.TaskCustomField.type).
CF_OPS = {
    "select": ("is", "is_not", "is_any_of", "is_empty", "is_not_empty"),
    "multiselect": ("contains", "not_contains", "is_empty", "is_not_empty"),
    "number": ("eq", "ne", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"),
    "checkbox": ("is_true", "is_false"),
    "text": ("contains", "not_contains", "is_empty", "is_not_empty"),
    "date": _DATE_OPS,
    "people": ("person_contains", "is_me", "is_empty", "is_not_empty"),
}
_CF_ANY_OPS = {op for ops in CF_OPS.values() for op in ops}

CF_PREFIX = "cf:"
_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def rules_rev(rules) -> str:
    """A short fingerprint of a stored rule list. The editor sends back the
    one it read; a different one now means someone else saved in between."""
    raw = json.dumps(rules if isinstance(rules, list) else [], sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _bad(msg: str):
    raise HTTPException(422, msg)


def _text(v, what: str, limit: int = MAX_TEXT) -> str:
    if not isinstance(v, (str, int, float)) or isinstance(v, bool):
        _bad(f"{what} needs a value")
    s = str(v).strip()
    if not s:
        _bad(f"{what} needs a value")
    if len(s) > limit:
        _bad(f"{what} is too long")
    return s


def _value(kind: str, raw, what: str):
    """The value in its stored shape, or a 422."""
    if kind == "none":
        return None
    if kind == "text":
        return _text(raw, what)
    if kind == "person":
        s = _text(raw, what, 254).lower()
        if "@" not in s or " " in s:
            _bad(f"{what} needs a person")
        return s
    if kind == "list":
        if not isinstance(raw, list) or not raw:
            _bad(f"{what} needs at least one value")
        if len(raw) > MAX_LIST:
            _bad(f"{what} has too many values")
        out = []
        for x in raw:
            s = _text(x, what)
            if s not in out:
                out.append(s)
        return out
    if kind == "days":
        try:
            n = float(raw)
        except (TypeError, ValueError):
            _bad(f"{what} needs a number of days")
        if isinstance(raw, bool) or not n.is_integer() or not 1 <= n <= MAX_DAYS:
            _bad(f"{what} needs a whole number of days from 1 to {MAX_DAYS}")
        return int(n)
    if kind == "date":
        s = str(raw or "").strip()[:10]
        if not _DAY.match(s):
            _bad(f"{what} needs a date")
        return s
    if kind == "number":
        return _number(raw, what)
    if kind == "range":
        if not isinstance(raw, list) or len(raw) != 2:
            _bad(f"{what} needs two numbers")
        lo, hi = _number(raw[0], what), _number(raw[1], what)
        return [min(lo, hi), max(lo, hi)]
    _bad(f"{what} is not supported")


def _number(raw, what: str):
    if isinstance(raw, bool):
        _bad(f"{what} needs a number")
    try:
        n = float(raw)
    except (TypeError, ValueError):
        _bad(f"{what} needs a number")
    if n != n or n in (float("inf"), float("-inf")) or abs(n) > 1e15:
        _bad(f"{what} needs a number")
    return int(n) if n.is_integer() else n


def _ckey(c: dict) -> str:
    return json.dumps(c, sort_keys=True, separators=(",", ":"))


def _known(rules) -> frozenset:
    """Every condition already stored, as a comparable key."""
    return frozenset(_ckey(c) for r in (rules if isinstance(rules, list) else []) if isinstance(r, dict)
                     for c in (r.get("conditions") or []) if isinstance(c, dict))


def clean_condition(c, *, field_types: dict, where: str, known: frozenset = frozenset()) -> dict:
    """One condition in its stored shape. `field_types` maps a custom field id
    to its storage kind for the fields that exist.

    A condition that is ALREADY STORED, exactly as it was stored, is kept as it
    is: its field may since have been deleted or changed type (a select turned
    into text), which the editor shows as "needs attention" - refusing it here
    would make every other rule in the list unsaveable until someone noticed."""
    if isinstance(c, dict) and _ckey(c) in known:
        return dict(c)
    if not isinstance(c, dict):
        _bad(f"{where}: each condition must be an object")
    field = str(c.get("field") or "").strip()
    op = str(c.get("op") or "").strip()
    if field in BUILTIN_OPS:
        if op not in BUILTIN_OPS[field]:
            _bad(f"{where}: that comparison does not apply to this field")
    elif field.startswith(CF_PREFIX) and _ID.match(field[len(CF_PREFIX):]):
        kind = field_types.get(field[len(CF_PREFIX):])
        if kind is None:
            _bad(f"{where}: that custom field does not exist")
        if op not in CF_OPS.get(kind, ()):
            _bad(f"{where}: that comparison does not apply to this field")
    else:
        _bad(f"{where}: unknown field")
    if field == "priority":
        vals = c.get("value") if op == "is_any_of" else [c.get("value")]
        if not isinstance(vals, list) or any(v not in PRIORITIES for v in vals):
            _bad(f"{where}: unknown priority")
    value = _value(OP_KIND[op], c.get("value"), where)
    out = {"field": field, "op": op}
    if value is not None:
        out["value"] = value
    return out


def _flag(r: dict, key: str, default: bool, where: str) -> bool:
    """A true / false switch - and only that. "false" or "no" is a 422, never
    quietly read as true."""
    v = r.get(key, default)
    if not isinstance(v, bool):
        _bad(f"{where}: {key} must be true or false")
    return v


def clean_rule(r, *, field_types: dict, index: int, known: frozenset = frozenset()) -> dict:
    where = f"Rule {index + 1}"
    if not isinstance(r, dict):
        _bad(f"{where} must be an object")
    rid = str(r.get("id") or "").strip()
    if not _ID.match(rid):
        _bad(f"{where} needs an id")
    name = str(r.get("name") or "").strip()
    if not name:
        _bad(f"{where} needs a name")
    if len(name) > MAX_NAME:
        _bad(f"{where}: the name is too long (at most {MAX_NAME} characters)")
    color = str(r.get("color") or "").strip().lower()
    if color not in PALETTE:
        _bad(f"{where}: pick a color from the palette")
    match = str(r.get("match") or "all").strip().lower()
    if match not in ("all", "any"):
        _bad(f"{where}: match must be all or any")
    conds = r.get("conditions")
    if not isinstance(conds, list) or not conds:
        _bad(f"{where} needs at least one condition")
    if len(conds) > MAX_CONDITIONS:
        _bad(f"{where}: at most {MAX_CONDITIONS} conditions")
    return {
        "id": rid, "name": name, "color": color,
        "bold": _flag(r, "bold", False, where), "enabled": _flag(r, "enabled", True, where),
        "match": match,
        "conditions": [clean_condition(c, field_types=field_types, where=where, known=known) for c in conds],
    }


def _person_anchor(db, user, project):
    """What a person condition is checked against for the company wall: the
    project, or - for someone's own rules - a stand-in carrying their company."""
    if project is not None:
        return project
    import auth
    return SimpleNamespace(company_id=auth.company_of(user, db) or "", owner_email="", created_by="")


def clean_rules(db, user: dict, project, rules, *, existing=None) -> list:
    """The whole list a save sends, in its stored shape, or a 422.

    `project` is the project the rules color; None = the person's own rules
    (My Tasks), which may use only custom fields that apply everywhere.
    `existing` is what is stored now (defaults to the project's own list).

    Shape is checked for every rule. References (the custom field exists, is
    visible on this side of the company wall and applies here; the select
    option exists; the person is in the Nexus directory) are checked only for
    conditions this save adds or changes - see the module docstring."""
    import models
    from routers.task_config import normalize_field_options, field_applies_to
    from routers.task_util import config_admits, person_problem
    import auth

    if not isinstance(rules, list):
        _bad("rules must be a list")
    if len(rules) > MAX_RULES:
        _bad(f"At most {MAX_RULES} color rules")
    if existing is None and project is not None:
        existing = project.color_rules
    known = _known(existing)
    fields = {f.id: f for f in db.query(models.TaskCustomField).all()}
    field_types = {fid: (f.type or "text").lower() for fid, f in fields.items()}
    out, seen = [], set()
    for i, r in enumerate(rules):
        clean = clean_rule(r, field_types=field_types, index=i, known=known)
        if clean["id"] in seen:
            _bad(f"Rule {i + 1} repeats the id of another rule")
        seen.add(clean["id"])
        out.append(clean)
    # Every project row read carries the list, so it stays small.
    if len(json.dumps(out).encode("utf-8")) > MAX_BYTES:
        _bad("These color rules are too large to save; shorten some lists of values")

    scope = auth.company_scope(user, db)
    statuses = None   # loaded the first time a new status condition needs it
    for i, r in enumerate(out):
        where = f"Rule {i + 1}"
        for c in r["conditions"]:
            if _ckey(c) in known:
                continue
            field, op, value = c["field"], c["op"], c.get("value")
            if field == "status":
                if statuses is None:
                    statuses = BUILTIN_STATUSES | {s.id for s in db.query(models.TaskCustomStatus).all()
                                                   if config_admits(getattr(s, "company_id", "") or "", scope)}
                if any(v not in statuses for v in (value if isinstance(value, list) else [value])):
                    _bad(f"{where}: that status does not exist")
            if field.startswith(CF_PREFIX):
                f = fields.get(field[len(CF_PREFIX):])
                if (f is None or not config_admits(getattr(f, "company_id", "") or "", scope)
                        or not field_applies_to(f, project.id if project is not None else "")):
                    _bad(f"{where}: that custom field is not one " + ("this project uses" if project is not None
                                                                       else "every project uses"))
                if (f.type or "text").lower() in ("select", "multiselect") and op not in ("is_empty", "is_not_empty"):
                    ids = {o["id"] for o in normalize_field_options(f.options or [])}
                    vals = value if isinstance(value, list) else [value]
                    if any(v not in ids for v in vals):
                        _bad(f"{where}: that option is not on the field any more")
            if OP_KIND[op] == "person":
                emp = (db.query(models.NexusEmployee)
                       .filter(func.lower(models.NexusEmployee.work_email) == value).first())
                if emp is None:
                    _bad(f"{where}: pick someone from the Nexus directory")
                # Someone who has left still has work to color ("assigned to
                # a leaver"); another company's people do not, behind a wall.
                problem = person_problem(db, _person_anchor(db, user, project), value, user)
                if problem and problem != "has left":
                    _bad(f"{where}: that person {problem}")
    return out


# The person's own row-color settings document (task_prefs "rowColors" ->
# data). Only these keys are kept; `mine` goes through the same validator as
# a project's rules, so a hand-made PUT cannot store something My Tasks or the
# editor would choke on.
def clean_personal_settings(db, user: dict, data, previous=None) -> dict:
    if not isinstance(data, dict):
        _bad("Row color settings must be an object")
    out = {}
    for key in ("hidden", "legendClosed"):
        if key in data:
            if not isinstance(data[key], bool):
                _bad(f"{key} must be true or false")
            out[key] = data[key]
    if "mine" in data:
        prev = previous.get("mine") if isinstance(previous, dict) else None
        out["mine"] = clean_rules(db, user, None, data["mine"], existing=prev if isinstance(prev, list) else [])
    return out
