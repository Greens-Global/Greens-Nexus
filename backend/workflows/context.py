"""The run context and templating (spec 5.6). `RunContext` is what every
condition, recipient spec, action plan and action run reads: the subject
(re-read from the database, or the event's payload in a dry run), the
event's from / to, the actor, the run-as user and the day. `resolve(path)`
answers `subject.<field>`, `change.<field>.from|to`, `actor.name|email`,
`today`, `subject.link`, `item.<field>`, `event.<key>` and `vars.<k>`;
anything else, and any `hr` / `comp` field the run-as user may not see, is
`MISSING` - a template renders it blank and reports the path, never the
figure (Review Focus 3).

`render("{{ subject.start_date | us_date }}", ctx)` fills `{{ path |
filter:arg }}` with the filters us_date, us_datetime, upper, lower and
default:"-". Dates are MM/DD/YYYY and times 12-hour everywhere a person
reads them (`us_date` here; several modules carry their own, none is
imported across).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from workflows import catalog
from workflows.emit import field_value


class _Missing:
    def __repr__(self):
        return "MISSING"

    def __bool__(self):
        return False


MISSING = _Missing()

_TAG = re.compile(r"\{\{\s*(.*?)\s*\}\}", re.S)
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


# ── US formats ───────────────────────────────────────────────────────────────
def us_date(iso) -> str:
    """'2026-11-12' (or an ISO datetime) -> '11/12/2026'; anything else as is."""
    if isinstance(iso, (datetime, date)):
        return f"{iso.month:02d}/{iso.day:02d}/{iso.year}"
    s = str(iso or "").strip()
    m = _DATE.match(s)
    if not m:
        return s
    y, mo, d = m.groups()
    return f"{mo}/{d}/{y}"


def us_datetime(iso, zone: str = "") -> str:
    """ISO datetime -> '11/12/2026 8:00 AM' in `zone` (IANA) when the value
    carries an offset; a bare date stays a date."""
    s = str(iso or "").strip()
    if not s:
        return ""
    if isinstance(iso, date) and not isinstance(iso, datetime):
        return us_date(iso)
    if _DATE.match(s) and len(s) == 10:
        return us_date(s)                 # a bare date has no time to show
    try:
        dt = iso if isinstance(iso, datetime) else datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return us_date(s)
    if dt.tzinfo is not None and zone:
        try:
            from zoneinfo import ZoneInfo
            dt = dt.astimezone(ZoneInfo(zone))
        except Exception:   # noqa: BLE001 - an unknown zone shows the time as given
            pass
    hour = dt.hour % 12 or 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt.month:02d}/{dt.day:02d}/{dt.year} {hour}:{dt.minute:02d} {ampm}"


def person_name(db, email: str) -> str:
    """A directory person's display name, else the email itself."""
    who = (email or "").strip().lower()
    if not who or db is None:
        return who
    try:
        import models
        from sqlalchemy import func
        emp = (db.query(models.NexusEmployee)
               .filter(func.lower(models.NexusEmployee.work_email) == who).first())
    except Exception:   # noqa: BLE001
        emp = None
    if emp is None:
        return who
    name = (getattr(emp, "display_name", "") or "").strip()
    if not name:
        name = f"{emp.first_name or ''} {emp.last_name or ''}".strip()
    return name or who


def link_url(link: dict) -> str:
    """A navigate detail {"view", "sub", ...} -> the app URL App.jsx parses
    (/<view>/<sub>?extra=...). A ready "url" wins."""
    if not isinstance(link, dict) or not link:
        return ""
    if link.get("url"):
        return str(link["url"])
    from app_url import app_url
    base = app_url().rstrip("/")
    view = str(link.get("view") or "").strip("/")
    sub = str(link.get("sub") or "").strip("/")
    path = "/".join(p for p in (view, sub) if p)
    extra = {k: v for k, v in link.items() if k not in ("view", "sub", "url") and v not in (None, "")}
    query = "&".join(f"{k}={v}" for k, v in extra.items())
    url = f"{base}/{path}" if path else base
    return f"{url}?{query}" if query else url


# ── the context ──────────────────────────────────────────────────────────────
@dataclass
class RunContext:
    db: Any
    workflow: Any = None
    definition: dict = field(default_factory=dict)
    run: Any = None
    entity: Optional[catalog.EntityDef] = None
    subject: Any = None                       # the ORM row, or None in a sample / dry run
    payload: dict = field(default_factory=dict)
    event: Any = None                         # WorkflowEvent row or None
    actor: str = ""
    run_as: Optional[dict] = None             # the user dict actions run as; None = the Nexus system actor
    today: date = field(default_factory=date.today)
    zone: str = ""
    item: Optional[dict] = None               # the current For Each item (its fields)
    vars: dict = field(default_factory=dict)
    company_id: str = ""

    # ── derived ──
    def company(self) -> str:
        if self.company_id:
            return self.company_id
        if self.event is not None and getattr(self.event, "company_id", ""):
            return str(self.event.company_id)
        if self.entity is not None and self.subject is not None:
            return self.entity.company_of(self.subject)
        sub = (self.payload or {}).get("subject") or {}
        return str(sub.get("company") or "") if isinstance(sub, dict) else ""

    def subject_label(self) -> str:
        if self.entity is not None and self.subject is not None:
            return self.entity.label_for(self.subject)
        lbl = (self.payload or {}).get("subjectLabel")
        if lbl:
            return str(lbl)
        sub = (self.payload or {}).get("subject") or {}
        return str(sub.get("name") or sub.get("title") or sub.get("id") or "") if isinstance(sub, dict) else ""

    def subject_link(self) -> dict:
        if self.entity is not None and self.subject is not None:
            return self.entity.link_for(self.subject)
        return {}

    def subject_id(self) -> str:
        if self.subject is not None:
            return str(getattr(self.subject, "id", "") or "")
        if self.event is not None:
            return str(getattr(self.event, "subject_id", "") or "")
        sub = (self.payload or {}).get("subject") or {}
        return str(sub.get("id") or "") if isinstance(sub, dict) else ""

    def can_see(self, f: catalog.Field) -> bool:
        return catalog.can_see_field(self.db, self.run_as, f.visibility)

    def field_value(self, f: catalog.Field) -> Any:
        """The subject's value for a registered field, from the row when
        there is one, else from the payload; MISSING when hidden."""
        if not self.can_see(f):
            return MISSING
        if self.subject is not None and self.entity is not None:
            try:
                return field_value(self.entity, self.subject, f)
            except Exception:   # noqa: BLE001
                return None
        sub = (self.payload or {}).get("subject") or {}
        # a registered field the sample / payload left out is blank, not unknown
        return sub.get(f.key) if isinstance(sub, dict) else None

    # ── paths ──
    def resolve(self, path: str) -> Any:
        p = str(path or "").strip()
        if not p:
            return MISSING
        root, _, rest = p.partition(".")
        if root == "subject":
            return self._resolve_subject(rest)
        if root == "change":
            fld, _, part = rest.rpartition(".")
            if part not in ("from", "to") or not fld:
                return MISSING
            ch = (self.payload or {}).get("changes") or {}
            if fld not in ch or not isinstance(ch[fld], dict):
                return MISSING
            if self.entity is not None:
                f = self.entity.field(fld)
                if f is not None and not self.can_see(f):
                    return MISSING
            return ch[fld].get(part)
        if root == "actor":
            email = (self.actor or (self.payload or {}).get("actor") or "").lower()
            if rest in ("", "email"):
                return email
            if rest == "name":
                return person_name(self.db, email)
            return MISSING
        if root == "today" and not rest:
            return self.today.isoformat()
        if root == "now" and not rest:
            return datetime.now().astimezone().isoformat()
        if root == "item":
            if not isinstance(self.item, dict):
                return MISSING
            if not rest:
                return self.item.get("label") or self.item.get("name") or MISSING
            return self.item.get(rest, MISSING)
        if root == "event":
            if self.event is not None and rest in ("key", "at", "actor", "id"):
                return getattr(self.event, rest, MISSING)
            extra = (self.payload or {}).get("extra") or {}
            return extra.get(rest, MISSING) if isinstance(extra, dict) else MISSING
        if root == "vars":
            return self.vars.get(rest, MISSING)
        if root == "workflow":
            if rest == "name":
                return getattr(self.workflow, "name", "") or ""
            return MISSING
        return MISSING

    def _resolve_subject(self, rest: str) -> Any:
        if rest in ("", "label"):
            return self.subject_label()
        if rest == "link":
            return link_url(self.subject_link())
        if rest == "id":
            return self.subject_id()
        if self.entity is None:
            sub = (self.payload or {}).get("subject") or {}
            return sub.get(rest, MISSING) if isinstance(sub, dict) else MISSING
        f = self.entity.field(rest)
        if f is None:
            return MISSING
        return self.field_value(f)


# ── templating ───────────────────────────────────────────────────────────────
def _split_filters(inner: str) -> list[str]:
    parts, cur, quote = [], [], ""
    for ch in inner:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = ""
        elif ch in ("'", '"'):
            quote = ch
            cur.append(ch)
        elif ch == "|":
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur).strip())
    return [p for p in parts if p]


def _unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


def _as_text(v: Any) -> str:
    if v is MISSING or v is None:
        return ""
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, dict):
        return link_url(v) if ("view" in v or "url" in v) else ", ".join(f"{k}: {x}" for k, x in v.items())
    if isinstance(v, (list, tuple)):
        return ", ".join(_as_text(x) for x in v)
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def apply_filter(name: str, arg: Optional[str], value: Any, ctx: RunContext) -> Any:
    if name == "us_date":
        return us_date(value) if value not in (None, MISSING) else value
    if name == "us_datetime":
        return us_datetime(value, ctx.zone) if value not in (None, MISSING) else value
    if name == "upper":
        return _as_text(value).upper()
    if name == "lower":
        return _as_text(value).lower()
    if name == "default":
        return (arg if arg is not None else "-") if value in (None, MISSING, "", [], {}) else value
    raise KeyError(name)


def render(template: str, ctx: RunContext) -> tuple[str, list[str]]:
    """Fill `{{ path | filter:arg }}` tags. Returns the text and the list
    of paths that resolved to nothing (a `default` filter covers one)."""
    missing: list[str] = []

    def _one(m) -> str:
        parts = _split_filters(m.group(1))
        if not parts:
            return ""
        path = parts[0]
        value = ctx.resolve(path)
        filters = []
        for raw in parts[1:]:
            name, _, arg = raw.partition(":")
            filters.append((name.strip(), _unquote(arg) if arg else None))
        has_default = any(n == "default" for n, _ in filters)
        if value is MISSING and not has_default:
            missing.append(path)
        for name, arg in filters:
            try:
                value = apply_filter(name, arg, value, ctx)
            except KeyError:
                missing.append(f"{path} | {name}")
        return _as_text(value)

    return _TAG.sub(_one, str(template or "")), missing


def template_paths(template: str) -> list[str]:
    """Every `{{ path }}` in a template (filters stripped) - for validation."""
    out = []
    for m in _TAG.finditer(str(template or "")):
        parts = _split_filters(m.group(1))
        if parts:
            out.append(parts[0])
    return out


def template_filters(template: str) -> list[str]:
    out = []
    for m in _TAG.finditer(str(template or "")):
        for raw in _split_filters(m.group(1))[1:]:
            out.append(raw.partition(":")[0].strip())
    return out
