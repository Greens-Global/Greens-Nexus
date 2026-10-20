"""The unified Audit Log API (Oct 20 2026, Visesh: "ONE audit log ... filter
based on modules ... see the prior state").

One feed, many sources, merged newest first:
  - "request"  audit_logs - one row per request that changed something (the
               middleware), joined by request_id to its field-level
               audit_changes rows (audit_capture.py) for before/after.
  - "system"   audit_changes written by background jobs (actor "system") -
               they have no request row. Hidden unless include_system.
  - "history:<table>" read-only adapters over the older per-module history
               tables (task_activity, shift_change_log, ...). They are shown
               only for rows OLDER than the first captured change: from the
               day capture went live the same events arrive through the
               request source with full before/after, and showing both would
               list every action twice.

Pagination is keyset per source (never OFFSET over millions of rows): the
cursor carries each source's last (at, id), every source fetches limit+1
after its own position, the pages are merged by time and each source's
position advances only by what was actually returned.

Access: administrators (same guard as GET /audit-logs). PFS entries
(module "pfs") are shown only to people who could open PFS itself - an
owner or an explicit `pfs` grant (routers/pfs.py) - and are left out for
everyone else.
"""
from __future__ import annotations

import base64
import csv
import io
import json
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, func, not_, or_, select
from sqlalchemy.orm import Session

import models
from audit_modules import (DENIED_ACTIONS, HISTORY_TABLES, KINDS, LEGACY_TELEMETRY_ACTIONS,
                           LEGACY_TELEMETRY_PATH_PREFIXES, LOGIN_RESOURCES, MODULE_KEYS, MODULE_LABELS,
                           MODULES, COMMENT_TABLES, field_label, kind_for, link_for, module_for_resource,
                           module_for_table, noun_for_table, record_table, record_type_for_table)
from auth import _MODULE_LEVEL_RANK, _module_level, require_administrator
from database import get_db

router = APIRouter(prefix="/audit", tags=["Audit"])

AL = models.AuditLog
AC = models.AuditChange

MAX_LIMIT = 200
EXPORT_CAP = 50000
PREVIEW_FIELDS = 3
PREVIEW_CHARS = 200

# Bookkeeping columns: kept in the detail view (marked internal) but never
# used for a title, a summary or the inline preview.
INTERNAL_FIELDS = frozenset({
    "modified_at", "updated_at", "activity_ids", "comment_ids", "attachment_ids", "subtask_ids",
    "synced_with_asana", "etag", "version", "row_version", "last_seen_at", "search_text",
})


# ── helpers ──────────────────────────────────────────────────────────────────

def _norm_at(raw: str) -> str:
    """Any stored timestamp -> ISO UTC with a trailing Z (naive = UTC)."""
    s = (raw or "").strip()
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00").replace(" ", "T", 1))
    except ValueError:
        return s
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _us_datetime(iso_z: str) -> tuple[str, str]:
    """('MM/DD/YYYY', 'h:mm:ss AM') in UTC for the CSV."""
    try:
        dt = datetime.fromisoformat(iso_z.replace("Z", "+00:00"))
    except ValueError:
        return iso_z, ""
    return dt.strftime("%m/%d/%Y"), dt.strftime("%I:%M:%S %p").lstrip("0")


def _parse_day(s: Optional[str], name: str) -> Optional[date]:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        raise HTTPException(400, f"{name} must be YYYY-MM-DD")


def _can_see_pfs(user: dict, db: Session) -> bool:
    """Same rule as routers/pfs.py: owners, or an explicit pfs grant."""
    if (user or {}).get("level", 0) >= 5:
        return True
    try:
        return _module_level(user["email"], "pfs", db) >= _MODULE_LEVEL_RANK["viewer"]
    except Exception:   # noqa: BLE001
        return False


def _enc_cursor(pos: dict) -> Optional[str]:
    if not pos:
        return None
    return base64.urlsafe_b64encode(json.dumps(pos, separators=(",", ":")).encode()).decode().rstrip("=")


def _dec_cursor(c: Optional[str]) -> dict:
    if not c:
        return {}
    try:
        raw = base64.urlsafe_b64decode(c + "=" * (-len(c) % 4))
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except Exception:   # noqa: BLE001
        raise HTTPException(400, "Bad cursor")


def _loads(s, default=None):
    if isinstance(s, (dict, list)):
        return s
    try:
        return json.loads(s or "")
    except (TypeError, ValueError):
        return default


def _short(v, n=PREVIEW_CHARS):
    if isinstance(v, str) and len(v) > n:
        return v[:n] + "..."
    if isinstance(v, (dict, list)):
        s = json.dumps(v, default=str)
        return s[:n] + "..." if len(s) > n else v
    return v


def _value_kind(v, hint: str = "") -> str:
    if hint in ("html", "json"):
        return hint
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, (dict, list)):
        return "json"
    if isinstance(v, str) and len(v) >= 10 and v[4:5] == "-" and v[7:8] == "-" and v[:4].isdigit():
        return "date"
    return "text"


def _field_entries(table: str, changes: dict) -> list[dict]:
    """audit_changes.changes JSON -> [{field, label, before, after, kind, ...}]."""
    out = []
    for col, f in (changes or {}).items():
        if not isinstance(f, dict):
            continue
        if col.startswith("_"):
            label = {"_rows": "Rows Affected", "_truncated": "Changes"}.get(col, field_label(col.strip("_")))
        else:
            label = field_label(col)
        e = {"field": col, "label": label}
        if f.get("r"):
            e.update(before=None, after=None, kind="redacted", redacted=f["r"])
        else:
            b, a = f.get("b"), f.get("a")
            e.update(before=b, after=a, kind=_value_kind(a if a is not None else b, f.get("t", "")))
        if f.get("bu"):
            e["beforeUnknown"] = True
        if col in INTERNAL_FIELDS:
            e["internal"] = True
        out.append(e)
    return out


def _fmt_val(v) -> str:
    if v is None or v == "":
        return "(empty)"
    if isinstance(v, bool):
        return "Yes" if v else "No"
    s = v if isinstance(v, str) else json.dumps(v, default=str)
    return s if len(s) <= 60 else s[:57] + "..."


# ── people names (batch, no N+1) ─────────────────────────────────────────────
_NAME_CACHE: dict[str, tuple[str, float]] = {}
_NAME_TTL = 300.0


def _names(db: Session, emails) -> dict[str, str]:
    now = time.time()
    want = {e.lower() for e in emails if e and "@" in e}
    out = {}
    missing = []
    for e in want:
        hit = _NAME_CACHE.get(e)
        if hit and now - hit[1] < _NAME_TTL:
            out[e] = hit[0]
        else:
            missing.append(e)
    if missing:
        found: dict[str, str] = {}
        try:
            rows = (db.query(models.NexusEmployee.work_email, models.NexusEmployee.first_name,
                             models.NexusEmployee.last_name)
                    .execution_options(include_deleted=True)
                    .filter(func.lower(models.NexusEmployee.work_email).in_(missing)).all())
            for em, fn, ln in rows:
                n = f"{fn or ''} {ln or ''}".strip()
                if em and n:
                    found[em.lower()] = n
            left = [e for e in missing if e not in found]
            if left:
                for em, dn in (db.query(models.NexusRole.email, models.NexusRole.display_name)
                               .filter(func.lower(models.NexusRole.email).in_(left)).all()):
                    if em and (dn or "").strip():
                        found[em.lower()] = dn.strip()
        except Exception:   # noqa: BLE001 - names are a nicety
            pass
        for e in missing:
            n = found.get(e) or " ".join(p.capitalize() for p in e.split("@")[0].replace("_", ".").split(".") if p)
            _NAME_CACHE[e] = (n, now)
            out[e] = n
    return out


def _person(email: str, names: dict) -> Optional[dict]:
    if not email:
        return None
    e = email.lower()
    if e == "system":
        return {"email": "system", "name": "System"}
    if "@" not in e:
        return {"email": email, "name": email}
    return {"email": e, "name": names.get(e) or e}


# ── record labels (batch) ────────────────────────────────────────────────────
_LABEL_LOOKUPS = {
    "tasks": lambda: (models.Task, models.Task.id, [models.Task.title]),
    "task_tickets": lambda: (models.TaskTicket, models.TaskTicket.id,
                             [models.TaskTicket.subject]),
    "nexus_employees": lambda: (models.NexusEmployee, models.NexusEmployee.id,
                                [models.NexusEmployee.first_name, models.NexusEmployee.last_name]),
    "items": lambda: (models.Item, models.Item.id, [models.Item.name]),
}


def _lookup_labels(db: Session, wanted: dict[str, set]) -> dict[tuple, str]:
    out = {}
    for table, ids in wanted.items():
        ids = {i for i in ids if i}
        if not ids or table not in _LABEL_LOOKUPS:
            continue
        try:
            model, idcol, cols = _LABEL_LOOKUPS[table]()
            rows = (db.query(idcol, *cols).execution_options(include_deleted=True)
                    .filter(idcol.in_(list(ids)[:500])).all())
        except Exception:   # noqa: BLE001
            continue
        for r in rows:
            parts = [str(p) for p in r[1:] if p]
            if table == "nexus_employees":
                label = " ".join(parts)
            elif len(parts) == 2:
                label = f"{parts[0]} {parts[1]}"
            else:
                label = parts[0] if parts else ""
            out[(table, str(r[0]))] = label
    return out


# ── filters ──────────────────────────────────────────────────────────────────

@dataclass
class Filters:
    module: str = ""
    actor: str = ""
    acting_as: str = ""
    record_table: str = ""
    record_id: str = ""
    kind: str = ""
    q: str = ""
    start: str = ""      # inclusive 'YYYY-MM-DD'
    end: str = ""        # exclusive 'YYYY-MM-DD'
    include_system: bool = False
    pfs_ok: bool = False

    def only_module_and_dates(self) -> bool:
        return not (self.actor or self.acting_as or self.record_table or self.record_id or self.kind or self.q)


def _filters(module, actor, acting_as, record_type, record_id, action, q, from_, to, include_system,
             pfs_ok) -> Filters:
    module = (module or "").strip().lower()
    if module and module not in MODULE_LABELS:
        raise HTTPException(400, f"Unknown module '{module}'")
    if module == "pfs" and not pfs_ok:
        raise HTTPException(403, "Personal Financial Statement entries need PFS access")
    kind = (action or "").strip().lower()
    if kind and kind not in KINDS:
        raise HTTPException(400, f"action must be one of {', '.join(KINDS)}")
    d0, d1 = _parse_day(from_, "from"), _parse_day(to, "to")
    return Filters(module=module, actor=(actor or "").strip().lower(), acting_as=(acting_as or "").strip().lower(),
                   record_table=record_table(record_type) if record_type else "", record_id=(record_id or "").strip(),
                   kind=kind, q=(q or "").strip(), start=d0.isoformat() if d0 else "",
                   end=(d1 + timedelta(days=1)).isoformat() if d1 else "",
                   include_system=bool(include_system), pfs_ok=pfs_ok)


# Distinct resource_type spellings in audit_logs -> module (cached; there are
# a few hundred at most, and the IN list lets legacy rows - which have no
# module column value - filter exactly like new ones).
_RTYPES: dict = {"at": 0.0, "map": {}}


def _rtype_map(db: Session) -> dict[str, str]:
    if time.time() - _RTYPES["at"] < 600 and _RTYPES["map"]:
        return _RTYPES["map"]
    try:
        rows = db.query(AL.resource_type).distinct().all()
        _RTYPES["map"] = {(r[0] or ""): module_for_resource(r[0] or "") for r in rows}
        _RTYPES["at"] = time.time()
    except Exception:   # noqa: BLE001
        pass
    return _RTYPES["map"]


def _legacy_module_pred(db: Session, module: str):
    """Rows written before module was stored: resource_type -> module."""
    types = [t for t, m in _rtype_map(db).items() if m == module]
    if module == "security":
        return or_(AL.action.in_(DENIED_ACTIONS), AL.resource_type.in_(types or ["\x00"]))
    return and_(AL.action.notin_(DENIED_ACTIONS), AL.resource_type.in_(types or ["\x00"]))


def _module_pred(db: Session, module: str):
    return or_(AL.module == module, and_(func.coalesce(AL.module, "") == "", _legacy_module_pred(db, module)))


_KIND_LEGACY = {
    "denied": lambda: AL.action.in_(DENIED_ACTIONS),
    "login": lambda: AL.resource_type.in_(list(LOGIN_RESOURCES)),
    "comment": lambda: or_(AL.action.ilike("%comment%"), AL.action.ilike("Replied%")),
    "create": lambda: or_(*[AL.action.ilike(p) for p in ("Created%", "Added%", "Uploaded%", "Sent%",
                                                          "Requested%", "Posted%", "Imported%",
                                                          "Checked out%", "Enrolled%", "Punched%")]),
    "delete": lambda: or_(*[AL.action.ilike(p) for p in ("Deleted%", "Removed%", "Revoked%", "Voided%")]),
    "update": lambda: or_(*[AL.action.ilike(p) for p in ("Updated%", "Changed%", "Edited%", "Assigned%",
                                                          "Reassigned%", "Approved%", "Rejected%", "Marked%",
                                                          "Set %", "Adjusted%", "Decided%", "Restored%",
                                                          "Resolved%", "Fixed%", "Synced%", "Saved%",
                                                          "Allocated%", "Confirmed%", "Initiated%")]),
    "view": lambda: AL.id < 0,
}


def _kind_pred(kind: str):
    if kind == "other":
        legacy = not_(or_(*[f() for k, f in _KIND_LEGACY.items() if k != "view"]))
    else:
        legacy = _KIND_LEGACY[kind]()
    return or_(AL.kind == kind, and_(func.coalesce(AL.kind, "") == "", legacy))


def _not_noise_pred():
    """Hide machine telemetry rows written before the middleware stopped
    writing them (new rows never are) and background-job rows."""
    legacy = or_(*[func.coalesce(AL.details, "").like(f'%"path": "{p}%') for p in LEGACY_TELEMETRY_PATH_PREFIXES],
                 AL.action.in_(LEGACY_TELEMETRY_ACTIONS))
    return and_(AL.user_email != "system", or_(func.coalesce(AL.module, "") != "", not_(legacy)))


# ── sources ──────────────────────────────────────────────────────────────────

class RequestSource:
    key = "r"

    def query(self, db: Session, f: Filters, pos, limit: int):
        q = db.query(AL)
        q = self.apply(db, q, f)
        if pos:
            at, rid = pos
            q = q.filter(or_(AL.timestamp < at, and_(AL.timestamp == at, AL.id < int(rid))))
        return q.order_by(AL.timestamp.desc(), AL.id.desc()).limit(limit + 1).all()

    def apply(self, db, q, f: Filters):
        if f.module:
            q = q.filter(_module_pred(db, f.module))
        if not f.pfs_ok:
            q = q.filter(not_(_module_pred(db, "pfs")))
        if not f.include_system:
            q = q.filter(_not_noise_pred())
        if f.actor:
            q = q.filter(func.lower(AL.user_email).like(f"%{f.actor}%"))
        if f.acting_as:
            if f.acting_as == "any":
                q = q.filter(or_(func.coalesce(AL.acting_as, "") != "",
                                 func.coalesce(AL.details, "").like('%"acting_as": "%')))
            else:
                q = q.filter(or_(func.lower(func.coalesce(AL.acting_as, "")).like(f"%{f.acting_as}%"),
                                 func.lower(func.coalesce(AL.details, "")).like(f'%"acting_as": "%{f.acting_as}%')))
        if f.record_id:
            sub = select(AC.request_id).where(AC.record_id == f.record_id)
            if f.record_table:
                sub = sub.where(AC.table_name == f.record_table)
            q = q.filter(or_(AL.request_id.in_(sub), AL.resource_id == f.record_id))
        if f.kind:
            q = q.filter(_kind_pred(f.kind))
        if f.start:
            q = q.filter(AL.timestamp >= f.start)
        if f.end:
            q = q.filter(AL.timestamp < f.end)
        if f.q:
            like = f"%{f.q.lower()}%"
            sub = select(AC.request_id).where(or_(func.lower(AC.changes).like(like), func.lower(AC.summary).like(like)))
            if f.start:
                sub = sub.where(AC.at >= f.start)
            q = q.filter(or_(func.lower(AL.action).like(like), func.lower(AL.user_email).like(like),
                             func.lower(AL.resource_id).like(like), func.lower(func.coalesce(AL.details, "")).like(like),
                             AL.request_id.in_(sub)))
        return q

    @staticmethod
    def pos_of(row):
        return [row.timestamp, row.id]

    @staticmethod
    def at_of(row):
        return _norm_at(row.timestamp)


class SystemSource:
    """Background-job changes (no request row). One event per change row."""
    key = "c"

    def query(self, db: Session, f: Filters, pos, limit: int):
        if not f.include_system or f.acting_as or f.kind in ("comment", "login", "denied", "view"):
            return []
        if f.actor and f.actor not in "system":
            return []
        q = db.query(AC).filter(AC.actor == "system")
        if f.module:
            q = q.filter(AC.module == f.module)
        if not f.pfs_ok:
            q = q.filter(AC.module != "pfs")
        if f.record_id:
            q = q.filter(AC.record_id == f.record_id)
            if f.record_table:
                q = q.filter(AC.table_name == f.record_table)
        if f.kind:
            ops = {"create": ["insert"], "update": ["update", "bulk_update"], "delete": ["delete", "bulk_delete"],
                   "other": ["bulk"]}.get(f.kind, [])
            q = q.filter(AC.op.in_(ops or ["\x00"]))
        if f.start:
            q = q.filter(AC.at >= f.start)
        if f.end:
            q = q.filter(AC.at < f.end)
        if f.q:
            like = f"%{f.q.lower()}%"
            q = q.filter(or_(func.lower(AC.changes).like(like), func.lower(AC.summary).like(like),
                             func.lower(AC.source).like(like), func.lower(AC.table_name).like(like)))
        if pos:
            at, rid = pos
            q = q.filter(or_(AC.at < at, and_(AC.at == at, AC.id < int(rid))))
        return q.order_by(AC.at.desc(), AC.id.desc()).limit(limit + 1).all()

    @staticmethod
    def pos_of(row):
        return [row.at, row.id]

    @staticmethod
    def at_of(row):
        return _norm_at(row.at)


# The first captured change - history rows from before it fill the past.
_CUTOFF: dict = {"at": 0.0, "value": None}


def _capture_cutoff(db: Session) -> Optional[str]:
    if time.time() - _CUTOFF["at"] < 300:
        return _CUTOFF["value"]
    try:
        v = db.query(func.min(AC.at)).scalar()
    except Exception:   # noqa: BLE001
        v = None
    _CUTOFF.update(at=time.time(), value=v or None)
    return _CUTOFF["value"]


@dataclass
class HistorySpec:
    table: str
    model: Any
    at: str
    actor: str
    module: str
    record_table: str
    record_col: str
    text_cols: tuple
    kind_of: Any            # row -> kind
    kind_pred: Any = None   # kind -> SQL predicate (None = filter in Python is skipped -> no rows)
    module_pred: Any = None  # module -> SQL predicate / True / False


def _kind_from_action(a: str) -> str:
    a = (a or "").lower()
    if a.startswith(("creat", "add", "import", "publish")):
        return "create"
    if a.startswith(("delet", "remov", "purg")):
        return "delete"
    if a.startswith(("denied", "deny", "lock")):
        return "denied"
    if a.startswith(("reveal", "copied", "copy", "view", "open", "download", "export")):
        return "view"
    if a.startswith(("unlock", "verif", "login", "sign")):
        return "login"
    if a.startswith(("comment",)):
        return "comment"
    return "update"


def _ta_kind(row) -> str:
    t = (row.type or "").lower()
    if t in ("commented",):
        return "comment"
    if t in ("created",):
        return "create"
    if t in ("deleted", "purged", "comment_deleted", "attachment_removed"):
        return "delete"
    if t.startswith("notify") or t in ("overdue_reminder", "sla_breach_alert", "automation", "auto_closed",
                                       "auto_assigned", "auto_assign_gap", "recurrence_scheduled"):
        return "other"
    return "update"


def _history_specs() -> list[HistorySpec]:
    M = models
    return [
        HistorySpec("task_activity", M.TaskActivity, "at", "actor_email", "tasks", "tasks", "entity_id",
                    ("entity_title", "entity_code", "detail", "type"), _ta_kind,
                    module_pred=lambda m: (M.TaskActivity.entity_kind != "ticket") if m == "tasks"
                    else (M.TaskActivity.entity_kind == "ticket") if m == "tickets" else False),
        HistorySpec("shift_change_log", M.ShiftChangeLog, "at", "actor", "time", "scheduled_shifts", "shift_id",
                    ("action", "employee_email", "reason"), lambda r: _kind_from_action(r.action)),
        HistorySpec("approval_history", M.ApprovalHistory, "created_at", "action_by", "inventory", "requisitions",
                    "requisition_id", ("action", "comment", "requisition_id"), lambda r: "update"),
        HistorySpec("payroll_rate_history", M.PayrollRateHistory, "created_at", "created_by", "time",
                    "payroll_rates", "employee_email", ("employee_email",), lambda r: "update"),
        HistorySpec("vault_access_logs", M.VaultAccessLog, "created_at", "actor_email", "vault",
                    "vault_credentials", "cred_id", ("action", "cred_name"), lambda r: _kind_from_action(r.action)),
        HistorySpec("pfs_access_log", M.PfsAccessLog, "at", "email", "pfs", "pfs_profiles", "profile_id",
                    ("action",), lambda r: _kind_from_action(r.action)),
        HistorySpec("ops_revenue_audit", M.OpsRevenueAudit, "created_at", "actor", "operations",
                    "ops_revenue_batches", "batch_id", ("action",), lambda r: _kind_from_action(r.action)),
        HistorySpec("changelog_entry_history", M.ChangelogEntryHistory, "at", "by_email", "settings",
                    "task_changelog_entries", "entry_id", ("action",), lambda r: _kind_from_action(r.action)),
    ]


class HistorySource:
    def __init__(self, spec: HistorySpec):
        self.spec = spec
        self.key = f"h:{spec.table}"

    def query(self, db: Session, f: Filters, pos, limit: int, cutoff: Optional[str] = None):
        s = self.spec
        if f.acting_as:
            return []
        if s.module == "pfs" and not f.pfs_ok:
            return []
        m = s.model
        q = db.query(m)
        if f.module:
            if s.module_pred is not None:
                p = s.module_pred(f.module)
                if p is False:
                    return []
                q = q.filter(p)
            elif f.module != s.module:
                return []
        if f.record_id:
            if f.record_table and f.record_table != s.record_table:
                return []
            q = q.filter(getattr(m, s.record_col) == f.record_id)
        at_col = getattr(m, s.at)
        actor_col = getattr(m, s.actor)
        if f.actor:
            q = q.filter(func.lower(actor_col).like(f"%{f.actor}%"))
        if f.start:
            q = q.filter(at_col >= f.start)
        if f.end:
            q = q.filter(at_col < f.end)
        if cutoff:
            q = q.filter(at_col < cutoff)
        if f.q:
            like = f"%{f.q.lower()}%"
            q = q.filter(or_(*[func.lower(func.coalesce(getattr(m, c), "")).like(like) for c in s.text_cols],
                             func.lower(func.coalesce(actor_col, "")).like(like)))
        if pos:
            at, rid = pos
            q = q.filter(or_(at_col < at, and_(at_col == at, m.id < rid)))
        fetch = limit + 1
        if f.kind:
            fetch = (limit + 1) * 4   # kind is decided in Python for history rows
        rows = q.filter(at_col != "").order_by(at_col.desc(), m.id.desc()).limit(fetch).all()
        if f.kind:
            rows = [r for r in rows if s.kind_of(r) == f.kind][: limit + 1]
        return rows

    def pos_of(self, row):
        return [getattr(row, self.spec.at), row.id]

    def at_of(self, row):
        return _norm_at(getattr(row, self.spec.at))


_HISTORY = None


def _history_sources() -> list[HistorySource]:
    global _HISTORY
    if _HISTORY is None:
        _HISTORY = [HistorySource(s) for s in _history_specs()]
    return _HISTORY


def _sources():
    return [RequestSource(), SystemSource(), *_history_sources()]


# ── building events ──────────────────────────────────────────────────────────

def _changes_by_request(db: Session, request_ids: list[str]) -> dict[str, list]:
    out: dict[str, list] = {}
    ids = [r for r in set(request_ids) if r]
    for i in range(0, len(ids), 400):
        for c in db.query(AC).filter(AC.request_id.in_(ids[i:i + 400])).order_by(AC.id).all():
            out.setdefault(c.request_id, []).append(c)
    return out


def _primary(changes: list, module: str = ""):
    """The change an event is "about": not a history row, the table that
    matches the module first, inserts/deletes before bookkeeping updates."""
    main = [c for c in changes if c.table_name not in HISTORY_TABLES]
    if not main:
        return None
    if module:
        same = [c for c in main if module_for_table(c.table_name) == module]
        if same:
            main = same
    for c in main:
        if c.table_name in COMMENT_TABLES and c.op == "insert":
            return c
    for c in main:
        fields = _loads(c.changes, {}) or {}
        if c.op != "update" or any(k not in INTERNAL_FIELDS for k in fields):
            return c
    return main[0]


def _visible_fields(c) -> list[dict]:
    return [e for e in _field_entries(c.table_name, _loads(c.changes, {}) or {}) if not e.get("internal")]


def _update_summary(fields: list[dict]) -> str:
    if not fields:
        return ""
    if len(fields) <= 2:
        parts = []
        for e in fields:
            if e["kind"] == "redacted":
                parts.append(f"{e['label']} changed")
            elif e.get("beforeUnknown"):
                parts.append(f"{e['label']}: {_fmt_val(e['after'])}")
            else:
                parts.append(f"{e['label']}: {_fmt_val(e['before'])} → {_fmt_val(e['after'])}")
        return "; ".join(parts)
    names = ", ".join(e["label"] for e in fields[:3])
    more = len(fields) - 3
    return f"Changed {names}" + (f" +{more} more" if more > 0 else "")


def _verb(op: str) -> str:
    return {"insert": "Created", "update": "Updated", "delete": "Deleted", "bulk_update": "Updated",
            "bulk_delete": "Deleted", "bulk": "Changed"}.get(op, "Changed")


def _preview(changes: list) -> list[dict]:
    out = []
    for c in changes:
        if c.table_name in HISTORY_TABLES:
            continue
        for e in _visible_fields(c):
            out.append({k: (_short(v) if k in ("before", "after") else v) for k, v in e.items()})
            if len(out) >= PREVIEW_FIELDS:
                return out
    return out


def _count_fields(changes: list) -> int:
    n = 0
    for c in changes:
        d = _loads(c.changes, {}) or {}
        n += len(d) if isinstance(d, dict) else 0
    return n


def _target_from_change(c, labels: dict) -> dict:
    label = (c.summary or "") or labels.get((c.table_name, c.record_id), "")
    return {"type": record_type_for_table(c.table_name), "table": c.table_name, "id": c.record_id,
            "label": label or c.record_id, "link": link_for(c.table_name, c.record_id)}


def _comment_parent(c) -> tuple[str, str]:
    d = _loads(c.changes, {}) or {}
    tid = (d.get("task_id") or {}).get("a") if isinstance(d.get("task_id"), dict) else ""
    return "tasks", str(tid or "")


def _request_events(db: Session, rows: list, names: dict, full: bool = False) -> list[dict]:
    by_req = _changes_by_request(db, [r.request_id for r in rows if getattr(r, "request_id", "")])
    # labels we still need: primary changes without a summary + comment parents
    wanted: dict[str, set] = {}
    prim = {}
    for r in rows:
        ch = by_req.get(r.request_id or "", []) if r.request_id else []
        mod = r.module or module_for_resource(r.resource_type, r.action)
        p = _primary(ch, mod)
        prim[r.id] = (ch, p, mod)
        if p is not None:
            if not p.summary:
                wanted.setdefault(p.table_name, set()).add(p.record_id)
            if p.table_name == "task_comments":
                t, tid = _comment_parent(p)
                wanted.setdefault("tasks", set()).add(tid)
                wanted.setdefault("task_tickets", set()).add(tid)
    labels = _lookup_labels(db, wanted)
    out = []
    for r in rows:
        ch, p, mod = prim[r.id]
        details = _loads(r.details, {}) or {}
        acting = r.acting_as or details.get("acting_as") or ""
        kind = r.kind or kind_for(details.get("method", ""), r.resource_type, r.action,
                                  [(c.table_name, c.op) for c in ch])
        if not r.kind and not ch:
            kind = _legacy_kind(r)
        target = None
        title = r.action
        summary = ""
        if p is not None:
            target = _target_from_change(p, labels)
            if p.table_name in COMMENT_TABLES and p.op in ("insert", "update", "delete"):
                ptable, pid = _comment_parent(p)
                plabel = labels.get(("tasks", pid)) or labels.get(("task_tickets", pid)) or ""
                is_ticket = ("task_tickets", pid) in labels and ("tasks", pid) not in labels
                noun = "ticket" if is_ticket else "task"
                verb = {"insert": "Commented on", "update": "Edited a comment on",
                        "delete": "Deleted a comment on"}[p.op]
                title = f'{verb} {noun} "{plabel}"' if plabel else f"{verb} a {noun}"
                body = (_loads(p.changes, {}) or {}).get("body") or {}
                txt = body.get("a") if p.op != "delete" else body.get("b")
                summary = _short(txt or "", 280) if isinstance(txt, str) else ""
                if pid:
                    ttable = "task_tickets" if is_ticket else "tasks"
                    target = {"type": record_type_for_table(ttable), "table": ttable, "id": pid,
                              "label": plabel or pid, "link": link_for(ttable, pid)}
            else:
                noun = noun_for_table(p.table_name)
                lab = target["label"] if target["label"] != p.record_id else ""
                title = f'{_verb(p.op)} {noun} "{lab}"' if lab else f"{_verb(p.op)} {noun}"
                if p.op == "update" or p.op.startswith("bulk"):
                    summary = _update_summary(_visible_fields(p))
            others = len([c for c in ch if c is not p and c.table_name not in HISTORY_TABLES])
            if others:
                summary = (summary + " · " if summary else "") + f"{others} other record{'s' if others > 1 else ''} changed"
        else:
            if r.resource_id:
                target = {"type": r.resource_type, "table": "", "id": r.resource_id, "label": r.resource_id,
                          "link": None}
            extra = {k: v for k, v in details.items() if k not in ("path", "status", "method", "acting_as")}
            if extra:
                summary = "; ".join(f"{field_label(k)}: {_fmt_val(v)}" for k, v in list(extra.items())[:4])
        ev = {
            "id": f"r{r.id}", "at": _norm_at(r.timestamp), "module": mod, "moduleLabel": MODULE_LABELS.get(mod, mod),
            "action": kind, "title": title, "summary": summary,
            "actor": _person(r.user_email, names), "actingAs": _person(acting, names) if acting else None,
            "target": target, "changesCount": _count_fields(ch), "preview": _preview(ch),
            "ip": r.ip_address or "", "source": "request", "undone": bool(r.undone_at),
        }
        if full:
            ev["_changes"] = ch
            ev["_details"] = details
        out.append(ev)
    return out


def _legacy_kind(r) -> str:
    a = r.action or ""
    if a in DENIED_ACTIONS:
        return "denied"
    if (r.resource_type or "") in LOGIN_RESOURCES:
        return "login"
    al = a.lower()
    if "comment" in al or al.startswith("replied"):
        return "comment"
    for k in ("create", "delete", "update"):
        pats = {"create": ("created", "added", "uploaded", "sent", "requested", "posted", "imported",
                           "checked out", "enrolled", "punched"),
                "delete": ("deleted", "removed", "revoked", "voided"),
                "update": ("updated", "changed", "edited", "assigned", "reassigned", "approved", "rejected",
                           "marked", "set ", "adjusted", "decided", "restored", "resolved", "fixed", "synced",
                           "saved", "allocated", "confirmed", "initiated")}[k]
        if al.startswith(pats):
            return k
    return "other"


def _system_events(db: Session, rows: list, names: dict) -> list[dict]:
    wanted: dict[str, set] = {}
    for c in rows:
        if not c.summary:
            wanted.setdefault(c.table_name, set()).add(c.record_id)
    labels = _lookup_labels(db, wanted)
    out = []
    for c in rows:
        target = _target_from_change(c, labels) if c.record_id else None
        noun = noun_for_table(c.table_name)
        lab = target["label"] if target and target["label"] != c.record_id else ""
        fields = _visible_fields(c)
        out.append({
            "id": f"c{c.id}", "at": _norm_at(c.at), "module": c.module,
            "moduleLabel": MODULE_LABELS.get(c.module, c.module),
            "action": {"insert": "create", "update": "update", "delete": "delete", "bulk_update": "update",
                       "bulk_delete": "delete"}.get(c.op, "other"),
            "title": f'{_verb(c.op)} {noun} "{lab}"' if lab else f"{_verb(c.op)} {noun}",
            "summary": (_update_summary(fields) if c.op != "insert" else "") +
                       (f" ({c.source})" if c.source else ""),
            "actor": {"email": "system", "name": "System"}, "actingAs": None, "target": target,
            "changesCount": _count_fields([c]), "preview": _preview([c]), "ip": "", "source": "system",
            "undone": False,
        })
    return out


def _json_diff(before: dict, after: dict) -> list[dict]:
    keys = list(dict.fromkeys([*(before or {}).keys(), *(after or {}).keys()]))
    out = []
    for k in keys:
        b, a = (before or {}).get(k), (after or {}).get(k)
        if b == a:
            continue
        out.append({"field": k, "label": field_label(k), "before": b, "after": a,
                    "kind": _value_kind(a if a is not None else b)})
    return out


def _history_event(spec: HistorySpec, row, names: dict) -> dict:
    t = spec.table
    actor = getattr(row, spec.actor) or ""
    changes: list[dict] = []
    target_id = str(getattr(row, spec.record_col) or "")
    target_label = target_id
    summary = ""
    if t == "task_activity":
        noun = "ticket" if row.entity_kind == "ticket" else ("project" if row.entity_kind == "project" else "task")
        label = row.entity_title or row.entity_code or ""
        verb = (row.type or "").replace("_", " ")
        title = f'{verb[:1].upper() + verb[1:]} - {noun} "{label}"' if label else verb.capitalize()
        if row.type == "commented":
            title = f'Commented on {noun} "{label}"' if label else f"Commented on a {noun}"
        summary = row.detail or ""
        target_label = label or target_id
        ttable = "task_tickets" if row.entity_kind == "ticket" else ("tasks" if noun == "task" else "task_projects")
        target = {"type": record_type_for_table(ttable), "table": ttable, "id": target_id, "label": target_label,
                  "link": link_for(ttable, target_id)}
        module = "tickets" if row.entity_kind == "ticket" else "tasks"
    else:
        module = spec.module
        target = {"type": record_type_for_table(spec.record_table), "table": spec.record_table, "id": target_id,
                  "label": target_label, "link": link_for(spec.record_table, target_id)}
        if t == "shift_change_log":
            changes = _json_diff(_loads(row.before_json, {}) or {}, _loads(row.after_json, {}) or {})
            day = row.work_date or ""
            try:
                day = date.fromisoformat(day).strftime("%m/%d/%Y")
            except ValueError:
                pass
            who = names.get((row.employee_email or "").lower()) or row.employee_email or "an open slot"
            title = f"{(row.action or 'changed').replace('_', ' ').capitalize()} shift - {who}, {day}"
            summary = row.reason or ""
            target["label"] = f"{who}, {day}"
        elif t == "approval_history":
            title = f"{row.action} requisition {row.requisition_id}"
            summary = row.comment or ""
        elif t == "payroll_rate_history":
            who = names.get((row.employee_email or "").lower()) or row.employee_email
            title = f"Set pay rate for {who}"
            changes = [{"field": "rate", "label": "Pay Rate", "before": None, "after": None, "kind": "redacted",
                        "redacted": "pay"}]
            target = {"type": "person", "table": "nexus_employees", "id": row.employee_email, "label": who,
                      "link": None}
        elif t == "vault_access_logs":
            title = f'{row.action} credential "{row.cred_name}"' if row.cred_name else f"{row.action} a credential"
            target["label"] = row.cred_name or target_id
            det = row.detail if isinstance(row.detail, list) else []
            for d in det:
                if isinstance(d, dict) and d.get("field"):
                    from audit_capture import is_secret_field
                    secret = is_secret_field(str(d.get("field")))
                    changes.append({"field": d["field"], "label": field_label(str(d["field"])),
                                    "before": None if secret else d.get("from"),
                                    "after": None if secret else d.get("to"),
                                    "kind": "redacted" if secret else "text"})
        elif t == "pfs_access_log":
            title = f"PFS: {(row.action or '').replace('_', ' ')}"
            summary = ", ".join(f"{field_label(k)}: {_fmt_val(v)}" for k, v in (row.details or {}).items()) \
                if isinstance(row.details, dict) else ""
        elif t == "ops_revenue_audit":
            title = f"Rent change batch {(row.action or '').replace('_', ' ')}"
            det = row.detail if isinstance(row.detail, dict) else {}
            changes = [{"field": k, "label": field_label(k), "before": None, "after": _short(v), "kind": _value_kind(v)}
                       for k, v in det.items()]
        elif t == "changelog_entry_history":
            title = f"{(row.action or 'edit').capitalize()} a What's New update"
            ch = row.changes if isinstance(row.changes, dict) else {}
            for k, v in ch.items():
                if isinstance(v, dict) and ("from" in v or "to" in v):
                    changes.append({"field": k, "label": field_label(k), "before": _short(v.get("from")),
                                    "after": _short(v.get("to")), "kind": _value_kind(v.get("to"))})
                else:
                    changes.append({"field": k, "label": field_label(k), "before": None, "after": _short(v),
                                    "kind": _value_kind(v)})
        else:
            title = t
    return {
        "id": f"h:{t}:{row.id}", "at": _norm_at(getattr(row, spec.at)), "module": module,
        "moduleLabel": MODULE_LABELS.get(module, module), "action": spec.kind_of(row), "title": title,
        "summary": summary, "actor": _person(actor, names) if actor else None, "actingAs": None,
        "target": target, "changesCount": len(changes), "preview": changes[:PREVIEW_FIELDS],
        "ip": getattr(row, "ip", "") or "", "source": f"history:{t}", "undone": False, "_changes_list": changes,
    }


def _emails_of(source_key: str, rows: list) -> set:
    out = set()
    for r in rows:
        if source_key == "r":
            out.add(r.user_email or "")
            out.add(r.acting_as or "")
            d = _loads(r.details, {}) or {}
            out.add(d.get("acting_as", "") if isinstance(d, dict) else "")
        elif source_key.startswith("h:"):
            for attr in ("actor_email", "actor", "email", "by_email", "created_by", "employee_email"):
                v = getattr(r, attr, None)
                if isinstance(v, str):
                    out.add(v)
    return {e.lower() for e in out if e and "@" in e}


def _page(db: Session, f: Filters, cursor: dict, limit: int):
    """Merged keyset page across every source -> (events, next cursor)."""
    cutoff = _capture_cutoff(db)
    lists = []     # per source: [(at_norm, row), ...] in the source's own order
    srcs = _sources()
    new_cursor = {k: v for k, v in cursor.items()}
    for s in srcs:
        pos = cursor.get(s.key)
        if pos == "done":
            continue
        if isinstance(s, HistorySource):
            rows = s.query(db, f, pos, limit, cutoff)
        else:
            rows = s.query(db, f, pos, limit)
        if not rows:
            new_cursor[s.key] = "done"     # nothing left in this source
            continue
        lists.append((s, [(s.at_of(r), r) for r in rows]))
    # k-way merge that keeps every source's own order, so what is taken from
    # a source is always a prefix of what it returned - its keyset position
    # then advances exactly past the rows shown, never skipping one.
    heads = [0] * len(lists)
    taken = []
    while len(taken) < limit:
        best = -1
        for i, (s, items) in enumerate(lists):
            if heads[i] < len(items) and (best < 0 or items[heads[i]][0] > lists[best][1][heads[best]][0]):
                best = i
        if best < 0:
            break
        s, items = lists[best]
        taken.append((items[heads[best]][0], s, items[heads[best]][1]))
        heads[best] += 1
    more = any(heads[i] < len(items) for i, (_s, items) in enumerate(lists))
    for _at, s, r in taken:
        new_cursor[s.key] = s.pos_of(r)
    # group per source to build
    names_needed = set()
    by_src: dict[str, list] = {}
    for _at, s, r in taken:
        by_src.setdefault(s.key, []).append(r)
    for k, rows in by_src.items():
        names_needed |= _emails_of(k, rows)
    names = _names(db, names_needed)
    built: dict[tuple, dict] = {}
    if "r" in by_src:
        for r, ev in zip(by_src["r"], _request_events(db, by_src["r"], names)):
            built[("r", r.id)] = ev
    if "c" in by_src:
        for r, ev in zip(by_src["c"], _system_events(db, by_src["c"], names)):
            built[("c", r.id)] = ev
    for s in srcs:
        if isinstance(s, HistorySource) and s.key in by_src:
            for r in by_src[s.key]:
                ev = _history_event(s.spec, r, names)
                ev.pop("_changes_list", None)
                built[(s.key, r.id)] = ev
    events = [built[(s.key, r.id)] for _at, s, r in taken]
    return events, (_enc_cursor(new_cursor) if more else None)


# ── endpoints ────────────────────────────────────────────────────────────────

def _common(module: Optional[str] = None, actor: Optional[str] = None, acting_as: Optional[str] = None,
            record_type: Optional[str] = None, record_id: Optional[str] = None, action: Optional[str] = None,
            q: Optional[str] = None, from_: Optional[str] = Query(None, alias="from"),
            to: Optional[str] = None, include_system: bool = False):
    return dict(module=module, actor=actor, acting_as=acting_as, record_type=record_type, record_id=record_id,
                action=action, q=q, from_=from_, to=to, include_system=include_system)


@router.get("/events")
def list_events(params: dict = Depends(_common), cursor: Optional[str] = None,
                limit: int = Query(50, ge=1, le=MAX_LIMIT),
                user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    f = _filters(pfs_ok=_can_see_pfs(user, db), **params)
    events, nxt = _page(db, f, _dec_cursor(cursor), limit)
    out = {"events": events, "nextCursor": nxt}
    # total only when it is free: the facets cache already counted this
    # module and date range.
    if f.only_module_and_dates():
        hit = _FACETS.get(_facet_key(f))
        if hit and time.time() - hit[0] < FACETS_TTL:
            fc = hit[1]
            out["total"] = (next((m["count"] for m in fc["modules"] if m["key"] == f.module), 0)
                            if f.module else fc["totalEvents"])
    return out


def _find_event(db: Session, event_id: str, user: dict):
    pfs_ok = _can_see_pfs(user, db)
    if event_id.startswith("r") and event_id[1:].isdigit():
        r = db.get(AL, int(event_id[1:]))
        if r is None:
            raise HTTPException(404, "Event not found")
        names = _names(db, _emails_of("r", [r]))
        ev = _request_events(db, [r], names, full=True)[0]
        if ev["module"] == "pfs" and not pfs_ok:
            raise HTTPException(404, "Event not found")
        return ev, r.request_id or "", "r", r
    if event_id.startswith("c") and event_id[1:].isdigit():
        c = db.get(AC, int(event_id[1:]))
        if c is None or (c.module == "pfs" and not pfs_ok):
            raise HTTPException(404, "Event not found")
        names = _names(db, [])
        ev = _system_events(db, [c], names)[0]
        ev["_changes"] = [c]
        ev["_details"] = {"source": c.source}
        return ev, c.request_id or "", "c", c
    if event_id.startswith("h:"):
        _h, table, rid = (event_id.split(":", 2) + ["", ""])[:3]
        src = next((s for s in _history_sources() if s.spec.table == table), None)
        if src is None:
            raise HTTPException(404, "Event not found")
        if src.spec.module == "pfs" and not pfs_ok:
            raise HTTPException(404, "Event not found")
        m = src.spec.model
        try:
            is_int = m.id.type.python_type is int
        except NotImplementedError:
            is_int = False
        row = db.get(m, int(rid) if is_int and rid.isdigit() else rid)
        if row is None:
            raise HTTPException(404, "Event not found")
        names = _names(db, _emails_of(src.key, [row]))
        ev = _history_event(src.spec, row, names)
        return ev, "", "h", row
    raise HTTPException(404, "Event not found")


def _records_of(changes: list, labels: dict) -> list[dict]:
    out = []
    for c in changes:
        fields = _field_entries(c.table_name, _loads(c.changes, {}) or {})
        out.append({"table": c.table_name, "type": record_type_for_table(c.table_name), "id": c.record_id,
                    "label": c.summary or labels.get((c.table_name, c.record_id), "") or c.record_id,
                    "op": c.op, "module": c.module, "link": link_for(c.table_name, c.record_id),
                    "history": c.table_name in HISTORY_TABLES, "changes": fields})
    return out


@router.get("/events/{event_id}")
def get_event(event_id: str, user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    ev, request_id, kind, row = _find_event(db, event_id, user)
    pfs_ok = _can_see_pfs(user, db)
    changes = ev.pop("_changes", None)
    details = ev.pop("_details", None) or {}
    hist_changes = ev.pop("_changes_list", None)
    if changes is not None:
        wanted: dict[str, set] = {}
        for c in changes:
            if not c.summary:
                wanted.setdefault(c.table_name, set()).add(c.record_id)
        labels = _lookup_labels(db, wanted)
        records = _records_of([c for c in changes if pfs_ok or c.module != "pfs"], labels)
        flat = []
        for rec in records:
            for e in rec["changes"]:
                flat.append({**e, "record": {"table": rec["table"], "type": rec["type"], "id": rec["id"],
                                             "label": rec["label"], "op": rec["op"]}})
        ev["records"] = records
        ev["changes"] = flat
    else:
        ev["records"] = []
        ev["changes"] = hist_changes or []
    if kind == "r":
        ev["request"] = {"path": details.get("path", ""), "method": details.get("method", ""),
                         "status": details.get("status"), "requestId": request_id}
        ev["details"] = {k: v for k, v in details.items() if k not in ("path", "method", "status")}
    elif kind == "c":
        ev["request"] = {"path": "", "method": "", "status": None, "requestId": request_id,
                         "job": details.get("source", "")}
    else:
        ev["request"] = None
    related = []
    if request_id:
        others = (db.query(AL).filter(AL.request_id == request_id).filter(AL.id != (row.id if kind == "r" else -1))
                  .order_by(AL.id).limit(20).all())
        if others:
            names = _names(db, _emails_of("r", others))
            related = [e for e in _request_events(db, others, names) if pfs_ok or e["module"] != "pfs"]
    ev["related"] = related
    return ev


@router.get("/records/{record_type}/{record_id}/history")
def record_history(record_type: str, record_id: str, limit: int = Query(500, ge=1, le=2000),
                   user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Every change to one record, oldest first - its prior states. Each
    entry is one captured change row (with the request's people and title),
    plus the older request rows and history-table rows from before capture."""
    table = record_table(record_type)
    pfs_ok = _can_see_pfs(user, db)
    if table.startswith("pfs_") and not pfs_ok:
        raise HTTPException(403, "Personal Financial Statement history needs PFS access")
    own = (db.query(AC).filter(AC.table_name == table, AC.record_id == record_id)
           .order_by(AC.at, AC.id).limit(limit).all())
    req_ids = list({c.request_id for c in own if c.request_id})
    req_rows = {}
    for i in range(0, len(req_ids), 400):
        for r in db.query(AL).filter(AL.request_id.in_(req_ids[i:i + 400])).all():
            req_rows.setdefault(r.request_id, r)
    # sibling rows of the same requests (the comment posted with the task update)
    siblings: dict[str, list] = {}
    for rid, ch in _changes_by_request(db, req_ids).items():
        siblings[rid] = [c for c in ch if not (c.table_name == table and c.record_id == record_id)
                         and (pfs_ok or c.module != "pfs")]
    emails = {c.actor for c in own} | {c.acting_as for c in own}
    for r in req_rows.values():
        emails |= _emails_of("r", [r])
    # pre-capture: request rows that named this record, and history-table rows
    cutoff = _capture_cutoff(db)
    legacy_q = db.query(AL).filter(AL.resource_id == record_id, func.coalesce(AL.request_id, "") == "")
    legacy = legacy_q.order_by(AL.timestamp).limit(limit).all()
    hist = []
    for s in _history_sources():
        if s.spec.record_table != table or (s.spec.module == "pfs" and not pfs_ok):
            continue
        q = db.query(s.spec.model).filter(getattr(s.spec.model, s.spec.record_col) == record_id)
        if cutoff:
            q = q.filter(getattr(s.spec.model, s.spec.at) < cutoff)
        hist.extend((s, r) for r in q.limit(limit).all())
    for s, r in hist:
        emails |= _emails_of(s.key, [r])
    for r in legacy:
        emails |= _emails_of("r", [r])
    names = _names(db, {e for e in emails if e})

    entries = []
    wanted = {table: {record_id}}
    labels = _lookup_labels(db, wanted)
    label = next((c.summary for c in reversed(own) if c.summary), "") or labels.get((table, record_id), "")
    for c in own:
        r = req_rows.get(c.request_id)
        fields = _field_entries(c.table_name, _loads(c.changes, {}) or {})
        entries.append({
            "id": f"r{r.id}" if r is not None else f"c{c.id}", "changeId": c.id, "at": _norm_at(c.at),
            "op": c.op, "title": r.action if r is not None else f"{_verb(c.op)} {noun_for_table(table)}",
            "actor": _person(c.actor or (r.user_email if r is not None else ""), names),
            "actingAs": _person(c.acting_as, names) if c.acting_as else None,
            "changes": fields, "source": "request" if r is not None else "system",
            "related": _records_of(siblings.get(c.request_id, []), {}),
        })
    if legacy:
        for ev in _request_events(db, legacy, names):
            entries.append({**ev, "op": ev["action"], "changes": [], "related": []})
    for s, r in hist:
        ev = _history_event(s.spec, r, names)
        ev["changes"] = ev.pop("_changes_list", [])
        ev["op"] = ev["action"]
        ev["related"] = []
        entries.append(ev)
    entries.sort(key=lambda e: e["at"])
    return {"record": {"type": record_type_for_table(table), "table": table, "id": record_id,
                       "label": label or record_id, "link": link_for(table, record_id),
                       "module": module_for_table(table), "moduleLabel": MODULE_LABELS.get(module_for_table(table))},
            "entries": entries[:limit]}


# ── facets ───────────────────────────────────────────────────────────────────
FACETS_TTL = 60.0
_FACETS: dict[tuple, tuple[float, dict]] = {}


def _facet_key(f: Filters) -> tuple:
    return (f.start, f.end, f.include_system, f.pfs_ok)


@router.get("/facets")
def facets(from_: Optional[str] = Query(None, alias="from"), to: Optional[str] = None,
           include_system: bool = False,
           user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    """Counts for the filter dropdowns: per module, per action kind, top
    actors and per day. Days are UTC dates. Defaults to the last 30 days.
    Cached 60 s per (range, system switch, PFS access)."""
    pfs_ok = _can_see_pfs(user, db)
    if not from_ and not to:
        today = datetime.now(timezone.utc).date()
        from_, to = (today - timedelta(days=29)).isoformat(), today.isoformat()
    f = _filters(None, None, None, None, None, None, None, from_, to, include_system, pfs_ok)
    key = _facet_key(f)
    hit = _FACETS.get(key)
    if hit and time.time() - hit[0] < FACETS_TTL:
        return hit[1]

    mods = {k: 0 for k in MODULE_KEYS}
    kinds = {k: 0 for k in KINDS}
    days: dict[str, int] = {}
    actors: dict[str, int] = {}
    day_expr = func.substr(AL.timestamp, 1, 10)
    q = db.query(func.coalesce(AL.module, ""), AL.resource_type, func.coalesce(AL.kind, ""), AL.action,
                 day_expr, func.count(AL.id))
    if f.start:
        q = q.filter(AL.timestamp >= f.start)
    if f.end:
        q = q.filter(AL.timestamp < f.end)
    if not f.include_system:
        q = q.filter(_not_noise_pred())
    for mod, rtype, kind, action, day, n in q.group_by(func.coalesce(AL.module, ""), AL.resource_type,
                                                       func.coalesce(AL.kind, ""), AL.action, day_expr).all():
        m = mod or module_for_resource(rtype or "", action or "")
        if m == "pfs" and not pfs_ok:
            continue
        mods[m] = mods.get(m, 0) + n
        k = kind or _legacy_kind(type("R", (), {"action": action, "resource_type": rtype})())
        kinds[k] = kinds.get(k, 0) + n
        days[day] = days.get(day, 0) + n
    aq = db.query(AL.user_email, func.count(AL.id))
    if f.start:
        aq = aq.filter(AL.timestamp >= f.start)
    if f.end:
        aq = aq.filter(AL.timestamp < f.end)
    if not f.include_system:
        aq = aq.filter(_not_noise_pred())
    if not pfs_ok:
        aq = aq.filter(not_(_module_pred(db, "pfs")))
    for em, n in aq.group_by(AL.user_email).order_by(func.count(AL.id).desc()).limit(25).all():
        actors[(em or "").lower()] = actors.get((em or "").lower(), 0) + n
    # background-job changes
    if f.include_system:
        sq = db.query(AC.module, func.substr(AC.at, 1, 10), func.count(AC.id)).filter(AC.actor == "system")
        if f.start:
            sq = sq.filter(AC.at >= f.start)
        if f.end:
            sq = sq.filter(AC.at < f.end)
        for m, day, n in sq.group_by(AC.module, func.substr(AC.at, 1, 10)).all():
            if m == "pfs" and not pfs_ok:
                continue
            mods[m or "other"] = mods.get(m or "other", 0) + n
            days[day] = days.get(day, 0) + n
            actors["system"] = actors.get("system", 0) + n
    # history tables from before capture
    cutoff = _capture_cutoff(db)
    for s in _history_sources():
        sp = s.spec
        if sp.module == "pfs" and not pfs_ok:
            continue
        at_col = getattr(sp.model, sp.at)
        hq = db.query(func.substr(at_col, 1, 10), func.count(sp.model.id)).filter(at_col != "")
        if f.start:
            hq = hq.filter(at_col >= f.start)
        if f.end:
            hq = hq.filter(at_col < f.end)
        if cutoff:
            hq = hq.filter(at_col < cutoff)
        try:
            for day, n in hq.group_by(func.substr(at_col, 1, 10)).all():
                mods[sp.module] = mods.get(sp.module, 0) + n
                days[day] = days.get(day, 0) + n
        except Exception:   # noqa: BLE001
            continue
    names = _names(db, actors.keys())
    top = sorted(actors.items(), key=lambda kv: -kv[1])[:20]
    # every day of the range, zero-filled
    day_list = []
    try:
        d0, d1 = date.fromisoformat(f.start), date.fromisoformat(f.end)
        d = d0
        while d < d1 and len(day_list) < 400:
            day_list.append({"date": d.isoformat(), "count": days.get(d.isoformat(), 0)})
            d += timedelta(days=1)
    except ValueError:
        day_list = [{"date": k, "count": v} for k, v in sorted(days.items())]
    out = {
        "from": f.start, "to": (date.fromisoformat(f.end) - timedelta(days=1)).isoformat() if f.end else "",
        "modules": [{"key": k, "label": lbl, "count": mods.get(k, 0)} for k, lbl in MODULES
                    if pfs_ok or k != "pfs"],
        "actions": [{"key": k, "label": k.capitalize(), "count": kinds.get(k, 0)} for k in KINDS],
        "actors": [{"email": e, "name": names.get(e) or ("System" if e == "system" else e), "count": n}
                   for e, n in top],
        "days": day_list,          # UTC dates
        "totalEvents": sum(mods.values()),
    }
    _FACETS[key] = (time.time(), out)
    return out


# ── CSV export ───────────────────────────────────────────────────────────────

@router.get("/export.csv")
def export_csv(params: dict = Depends(_common), max_rows: int = Query(EXPORT_CAP, ge=1, le=EXPORT_CAP),
               user: dict = Depends(require_administrator), db: Session = Depends(get_db)):
    f = _filters(pfs_ok=_can_see_pfs(user, db), **params)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date (UTC)", "Time (UTC)", "Module", "Action", "Title", "Summary", "Actor", "Actor Email",
                "Acting As", "Record Type", "Record", "Changes", "IP Address", "Source", "Event ID"])
    cursor: dict = {}
    n = 0
    while n < max_rows:
        events, nxt = _page(db, f, cursor, min(500, max_rows - n))
        for e in events:
            d, t = _us_datetime(e["at"])
            tgt = e.get("target") or {}
            pv = "; ".join(
                f"{c['label']}: {'(hidden)' if c['kind'] == 'redacted' else _fmt_val(c.get('before'))} -> "
                f"{'(hidden)' if c['kind'] == 'redacted' else _fmt_val(c.get('after'))}"
                for c in e.get("preview") or [])
            w.writerow([d, t, e["moduleLabel"], e["action"].capitalize(), e["title"], e["summary"],
                        (e.get("actor") or {}).get("name", ""), (e.get("actor") or {}).get("email", ""),
                        (e.get("actingAs") or {}).get("email", ""), tgt.get("type", ""),
                        tgt.get("label", ""), pv, e.get("ip", ""), e["source"], e["id"]])
            n += 1
        if not nxt or not events:
            break
        cursor = _dec_cursor(nxt)
    stamp = datetime.now(timezone.utc).strftime("%m-%d-%Y")
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="nexus-audit-log-{stamp}.csv"'})
