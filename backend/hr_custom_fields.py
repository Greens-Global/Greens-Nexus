"""Custom fields on employee records (Neil, Oct 27 2026).

HR defines extra fields in Settings > People & Access (EmployeeCustomField):
a label, a type (Text, Number, Date, Dropdown, Checkbox), dropdown options,
the company it applies to ('' = every company), whether it is required, its
place in the list, who sees it and whether it is archived. Each person's
values live in NexusEmployee.custom_fields as {field_key: value}; the key
never changes once a field exists, so a renamed field keeps its values and
{{custom.<field_key>}} keeps merging in Documents.

Who sees what (the server decides, never the screen):
  hr    - People with the HR grant, within their company scope: every field.
  team  - the manager tier in People (their own team): every field except
          HR Only.
  self  - the person themselves (My HR, or an HR person on their own
          record): Employee Can See and Employee Can Edit fields only, and
          edits only the Employee Can Edit ones.
Values of fields a caller may not see never leave the server: every value
that goes out goes through `values_for` with the caller's audience.

Archiving hides a field everywhere (profile, list, filters, merge library);
its values stay in custom_fields and come back when it is restored. Nothing
here ever removes a stored value except the person's own edit clearing it.
"""
import json
import re
import uuid
from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from models import AuditLog, EmployeeCustomField, NexusEmployee

FIELD_TYPES = ("text", "number", "date", "dropdown", "checkbox")
VISIBILITIES = ("hr_only", "employee_view", "employee_edit")
EMPLOYEE_SEES = ("employee_view", "employee_edit")
AUDIENCES = ("hr", "team", "self")

MAX_FIELDS = 200
MAX_OPTIONS = 100
MAX_TEXT = 2000
MAX_LABEL = 80
_KEY_RE = re.compile(r"[a-z0-9_]+")


class FieldError(ValueError):
    """A value or definition the caller has to fix (answered as a 400)."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify_key(label: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", (label or "").strip().lower()).strip("_")
    return (s or "field")[:40].strip("_") or "field"


def unique_key(db: Session, base: str) -> str:
    """A field_key no other field - archived ones included - holds."""
    base = slugify_key(base)
    taken = {k for (k,) in db.query(EmployeeCustomField.field_key).all()}
    key, n = base, 2
    while key in taken:
        key = f"{base}_{n}"
        n += 1
    return key


def clean_options(raw) -> list:
    out, seen = [], set()
    for o in raw or []:
        v = str(o or "").strip()[:120]
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    if len(out) > MAX_OPTIONS:
        raise FieldError(f"A dropdown can have at most {MAX_OPTIONS} options")
    return out


def serialize_field(f: EmployeeCustomField) -> dict:
    return {
        "id": f.id,
        "fieldKey": f.field_key,
        "label": f.label,
        "fieldType": f.field_type or "text",
        "options": f.options if isinstance(f.options, list) else [],
        "companyId": f.company_id or "",
        "required": bool(f.required),
        "sortOrder": f.sort_order or 0,
        "visibility": f.visibility or "hr_only",
        "archived": bool(f.archived),
        "token": f"custom.{f.field_key}",
        "updatedAt": f.updated_at or f.created_at or "",
    }


def all_fields(db: Session, include_archived: bool = False) -> list:
    q = db.query(EmployeeCustomField)
    if not include_archived:
        q = q.filter((EmployeeCustomField.archived == 0) | (EmployeeCustomField.archived.is_(None)))
    return q.order_by(EmployeeCustomField.sort_order, EmployeeCustomField.label).all()


def applies_to(f: EmployeeCustomField, company: str) -> bool:
    return (f.company_id or "") in ("", (company or ""))


def visible_to(f: EmployeeCustomField, audience: str) -> bool:
    vis = f.visibility or "hr_only"
    if audience == "hr":
        return True
    if audience == "team":
        return vis != "hr_only"
    return vis in EMPLOYEE_SEES


def editable_by(f: EmployeeCustomField, audience: str) -> bool:
    """HR edits every field; the person edits Employee Can Edit ones; the
    manager tier reads only."""
    if audience == "hr":
        return True
    if audience == "self":
        return (f.visibility or "hr_only") == "employee_edit"
    return False


def fields_for(fields: list, company: str, audience: str) -> list:
    """The live fields that apply to a person of `company` and that this
    audience may see, in their order."""
    return [f for f in fields if not f.archived and applies_to(f, company) and visible_to(f, audience)]


def _has_value(v) -> bool:
    return v is not None and v != "" and v != []


def values_for(emp: NexusEmployee, fields: list) -> dict:
    """{field_key: value} of `fields` only - the one way a value leaves."""
    stored = emp.custom_fields if isinstance(emp.custom_fields, dict) else {}
    out = {}
    for f in fields:
        v = stored.get(f.field_key)
        if _has_value(v):
            out[f.field_key] = v
    return out


def audience_for(user: dict, emp: NexusEmployee) -> str:
    """hr / team / self for a People (/hr) caller looking at `emp`. Callers of
    the /hr routes already passed the HR grant and the company scope check.
    An HR person on their OWN record is the employee there (as on a time
    sheet: HR is never HR on their own card) unless they are an
    administrator, who sees and edits everything."""
    from auth import _LEVELS, hr_team_limited
    if hr_team_limited(user):
        return "team"
    me = (user.get("email") or "").strip().lower()
    if me and me == (emp.work_email or "").strip().lower() and user.get("level", 0) < _LEVELS["administrator"]:
        return "self"
    return "hr"


# ── Values ───────────────────────────────────────────────────────────────────

def clean_value(f: EmployeeCustomField, raw):
    """The stored form of `raw` for field `f`, None for "no value", or a
    FieldError naming the field."""
    ftype = f.field_type or "text"
    label = f.label or f.field_key
    if ftype == "checkbox":
        if raw is None or raw == "":
            return None
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str) and raw.strip().lower() in ("true", "yes", "1", "false", "no", "0"):
            return raw.strip().lower() in ("true", "yes", "1")
        raise FieldError(f"{label} must be checked or unchecked")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    if isinstance(raw, (dict, list)):
        raise FieldError(f"{label} must be a single value")
    if ftype == "number":
        if isinstance(raw, bool):
            raise FieldError(f"{label} must be a number")
        try:
            n = float(str(raw).strip().replace(",", ""))
        except ValueError:
            raise FieldError(f"{label} must be a number") from None
        if n != n or n in (float("inf"), float("-inf")):
            raise FieldError(f"{label} must be a number")
        return int(n) if n.is_integer() and abs(n) < 1e15 else n
    if ftype == "date":
        s = str(raw).strip()[:10]
        try:
            return date.fromisoformat(s).isoformat()
        except ValueError:
            raise FieldError(f"{label} must be a date") from None
    if ftype == "dropdown":
        s = str(raw).strip()
        opts = f.options if isinstance(f.options, list) else []
        match = next((o for o in opts if str(o).lower() == s.lower()), None)
        if match is None:
            raise FieldError(f"{label} must be one of its options")
        return str(match)
    s = str(raw).strip()
    if len(s) > MAX_TEXT:
        raise FieldError(f"{label} can be at most {MAX_TEXT} characters")
    return s


def apply_changes(db: Session, emp: NexusEmployee, changes: dict, audience: str, actor: dict) -> dict:
    """Validate and save `changes` ({field_key: raw value}) on `emp` for a
    caller of `audience`. Only the keys sent are touched (a value this caller
    cannot see or edit is never read back from the screen). A key the caller
    may not edit answers PermissionError; a bad value FieldError. Records old
    -> new in the HR record audit trail. Returns {key: [before, after]}.
    The caller commits."""
    if not isinstance(changes, dict):
        raise FieldError("Send the changed fields as an object")
    defs = {f.field_key: f for f in all_fields(db)}
    company = emp.company or ""
    stored = dict(emp.custom_fields) if isinstance(emp.custom_fields, dict) else {}
    diff: dict = {}
    for key, raw in changes.items():
        f = defs.get(str(key))
        if f is None or not applies_to(f, company) or not visible_to(f, audience):
            # An archived, unknown or hidden field answers the same way, so
            # the reply never says whether a hidden field exists.
            raise FieldError("One of these fields is not on this record any more - reload and try again")
        if not editable_by(f, audience):
            raise PermissionError(f"You can't change {f.label}")
        value = clean_value(f, raw)
        before = stored.get(f.field_key)
        if not _has_value(value):
            if f.required:
                raise FieldError(f"{f.label} is required")
            if f.field_key in stored:
                stored.pop(f.field_key)
                diff[f.field_key] = [before, None]
            continue
        if before != value:
            stored[f.field_key] = value
            diff[f.field_key] = [before, value]
    # Required fields this caller edits must all be filled once they save.
    missing = [f.label for f in fields_for(list(defs.values()), company, audience)
               if f.required and editable_by(f, audience) and not _has_value(stored.get(f.field_key))]
    if missing:
        raise FieldError(f"Fill in {', '.join(missing)} - {'it is' if len(missing) == 1 else 'they are'} required")
    if diff:
        emp.custom_fields = stored          # a new dict, so the JSON column is seen as changed
        emp.updated_at = _now()
        shown = {f"custom.{k}": [None if b is None else str(b)[:120], None if a is None else str(a)[:120]]
                 for k, (b, a) in diff.items()}
        db.add(AuditLog(timestamp=_now(), user_email=actor.get("email") or "",
                        user_role=str(actor.get("role") or ""), action="Changed employee fields",
                        resource_type="employee", resource_id=emp.id, module="hr", kind="update",
                        details=json.dumps({"employee": emp.work_email, "section": "More Details",
                                            "labels": {f"custom.{k}": defs[k].label for k in diff},
                                            "changes": shown})[:4000]))
    return diff


def record_view(db: Session, emp: NexusEmployee, audience: str, can_write: bool = True) -> dict:
    """What a profile's More Details shows: the fields, the values, and which
    of them this caller may change (`can_write` False: none - an HR viewer)."""
    shown = fields_for(all_fields(db), emp.company or "", audience)
    edit = {f.field_key: can_write and editable_by(f, audience) for f in shown}
    return {
        "fields": [{**serialize_field(f), "editable": edit[f.field_key]} for f in shown],
        "values": values_for(emp, shown),
        "canEdit": any(edit.values()),
        "audience": audience,
    }


# ── The People list ──────────────────────────────────────────────────────────

def attach_list_values(db: Session, user: dict, rows: list, out: list) -> None:
    """customFields on each serialized People row (hr.list_employees): the
    live fields that apply to that person, filtered by what this caller may
    see of them. `rows` and `out` are the same people in the same order."""
    fields = all_fields(db)
    for e, o in zip(rows, out):
        o["customFields"] = (values_for(e, fields_for(fields, e.company or "", audience_for(user, e)))
                             if fields else {})


# ── Documents ────────────────────────────────────────────────────────────────

def display_value(f: EmployeeCustomField, v) -> str:
    """A value as a letter prints it: US dates, Yes / No."""
    if not _has_value(v):
        return ""
    ftype = f.field_type or "text"
    if ftype == "checkbox":
        return "Yes" if v is True or str(v).lower() in ("true", "yes", "1") else "No"
    if ftype == "date":
        try:
            return date.fromisoformat(str(v)[:10]).strftime("%m/%d/%Y")
        except ValueError:
            return str(v)
    if ftype == "number" and isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def caller_is_hr_for(user: dict, db: Session, emp: NexusEmployee) -> bool:
    """Whether `user` is HR for `emp` outside the /hr routes (a Documents
    export): the People grant, not the manager tier, the person inside their
    company scope, and not their own record (unless an administrator)."""
    if not user or emp is None:
        return False
    from auth import _LEVELS, _module_level, hr_scope, hr_team_limited
    if hr_team_limited(user):
        return False
    if user.get("level", 0) < _LEVELS["administrator"] and _module_level(user.get("email") or "", "hr", db) < 1:
        return False
    scope = hr_scope(user, db)
    if scope is not None and (emp.company or "") not in scope:
        return False
    return audience_for(user, emp) == "hr"


def merge_values(db: Session, emp: NexusEmployee, include_hr_only: bool = True) -> dict:
    """{custom.<key>: printed value} for the Documents merge resolver - every
    live field that applies to the person's company. HR Only fields only when
    whoever the document is printed for is HR for the person (an HR packet
    always is; a Documents export says so through `include_hr_only`)."""
    fields = [f for f in all_fields(db) if applies_to(f, emp.company or "")
              and (include_hr_only or visible_to(f, "team"))]
    stored = emp.custom_fields if isinstance(emp.custom_fields, dict) else {}
    out = {}
    for f in fields:
        if not _KEY_RE.fullmatch(f.field_key or ""):
            continue
        text = display_value(f, stored.get(f.field_key))
        if text:
            out[f"custom.{f.field_key}"] = text
    return out


def new_field_id() -> str:
    return str(uuid.uuid4())
