"""Field-level change capture for the unified Audit Log (Oct 20 2026).

The request-level audit row (audit.py) says WHO called WHAT URL. This module
adds WHAT CHANGED: for every row the ORM inserts, updates or deletes, one
`audit_changes` row with the table, primary key and {field: before/after}.

How it works
  - AuditMiddleware opens an AuditContext per request (request id, path,
    method, IP) in a ContextVar; auth.get_current_user fills in the real
    signed-in person and, during Act As, who they were acting as. The context
    rides into sync endpoints' worker threads (Starlette copies contextvars).
  - An `after_flush` listener on SessionLocal reads each touched object's
    attribute history - what the ORM ALREADY holds, no extra SELECT. An
    attribute that was never loaded before it was overwritten has no "before"
    in memory: the after value is recorded and the field marked before-unknown
    rather than paying a query for it.
  - The rows are inserted on the SAME connection, inside the same transaction
    (rolled-back writes leave no phantom history), through a SAVEPOINT on
    Postgres so a failed audit insert can never abort the user's transaction.
    Every step is wrapped: auditing failing logs and is swallowed, the write
    goes through.
  - Outside a request (background loops) the actor is "system" and the job is
    the outermost backend function on the stack.

Why a separate table rather than a JSON column on audit_logs: the changes are
captured inside the transaction, before the request row exists; one request
touches many records (a task + its comment + its activity row), background
jobs have no request row at all, and the per-record history ("every change to
task X") needs its own (table_name, record_id) index. audit_changes.request_id
joins back to audit_logs.request_id.

Redaction is decided here, at write time, so the database never holds the
secret in the first place (see _redact_reason).
"""
from __future__ import annotations

import base64
import contextvars
import datetime as _dt
import decimal
import json
import os
import re
import sys
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

from audit_modules import module_for_path, module_for_table

# ── the request / job context ────────────────────────────────────────────────


@dataclass
class AuditContext:
    request_id: str
    path: str = ""
    method: str = ""
    ip: str = ""
    actor: str = ""         # the real signed-in person (never the Act As target)
    acting_as: str = ""     # the Act As target, '' when not acting
    actor_hint: str = ""    # cheap bearer decode from the middleware, used when auth never ran
    job: str = ""           # background job name ('' in a request)
    captured: int = 0       # change rows written for this context
    tables: list = field(default_factory=list)   # [(table, op, record_id, label)] - first few, for titles


_ctx: contextvars.ContextVar[Optional[AuditContext]] = contextvars.ContextVar("nexus_audit_ctx", default=None)


def new_request_id() -> str:
    return uuid.uuid4().hex


def begin_request(path: str, method: str, ip: str = "", actor_hint: str = "") -> tuple[AuditContext, Any]:
    ctx = AuditContext(request_id=new_request_id(), path=path or "", method=method or "",
                       ip=ip or "", actor_hint=(actor_hint or "").lower())
    return ctx, _ctx.set(ctx)


def end_request(token) -> None:
    try:
        _ctx.reset(token)
    except Exception:   # noqa: BLE001 - a context from another task; harmless
        pass


def current() -> Optional[AuditContext]:
    return _ctx.get()


def current_request_id() -> str:
    """Column default for audit_logs.request_id: a row written by hand inside a
    request (hr.py's "Changed employee fields") joins its request too."""
    c = _ctx.get()
    return c.request_id if c else ""


def note_identity(real_email: str, acting_as: str = "") -> None:
    """Called by auth.get_current_user once it knows who is calling."""
    c = _ctx.get()
    if c is None:
        return
    if real_email:
        c.actor = (real_email or "").lower()
    if acting_as and acting_as.lower() != c.actor:
        c.acting_as = acting_as.lower()


class system_job:
    """`with audit_capture.system_job("weather_watch"):` names the job for
    changes made outside a request. Optional - without it the job is taken
    from the stack."""

    def __init__(self, name: str):
        self.name = name
        self._token = None

    def __enter__(self):
        self._token = _ctx.set(AuditContext(request_id=f"job-{new_request_id()}", job=self.name))
        return self

    def __exit__(self, *exc):
        end_request(self._token)
        return False


# ── what is never captured ───────────────────────────────────────────────────
# Caches, sync mirrors, telemetry, sessions, read markers, queues and logs that
# exist to be churned. Capturing them would bury the real changes exactly the
# way the agent telemetry buried audit_logs. Exact table names; NOISE_PREFIXES
# below for whole families. Keep the reason next to each group.
NOISE_TABLES: frozenset[str] = frozenset({
    # the audit trail itself
    "audit_logs", "audit_changes",
    # sessions, one-time codes, OAuth state and stored tokens (secrets + churn)
    "server_sessions", "stepup_sessions", "external_login_codes", "vault_otp_challenges",
    "vault_otp_sessions", "vault_personal_unlock_sessions", "vault_personal_auth",
    "pfs_access_challenges", "hr_sign_otp_challenges", "asana_oauth_states",
    "egnyte_oauth_states", "egnyte_user_tokens", "asana_user_tokens",
    "marketing_integration_tokens",
    # private to one person - never shown to admins (Personal Vault, AI chats)
    "vault_personal_credentials", "ai_conversations", "ai_messages",
    # read markers, UI state and per-person view prefs
    "nexus_notifications", "task_notifications", "nexus_announcement_reads", "changelog_seen",
    "changelog_entry_views", "user_tour_state", "task_table_prefs", "kb_runs",
    # desktop agent / phone tracking telemetry
    "agent_activity", "time_screenshots", "agent_devices", "track_pings", "track_sessions",
    "live_view_sessions", "agent_pairings",
    # outbound mail / message queues and send logs (the event that caused them is captured)
    "task_email_queue", "task_email_log", "ticket_email_log", "ticket_teams_message",
    "nexus_daily_briefing_log", "nexus_weekly_digest_log", "nexus_workforce_scorecard_log",
    "ticket_report_email_log", "task_inbound_email", "ticket_inbound_email",
    "shift_calendar_events", "shift_noshow_alerts", "task_automation_runs",
    # tombstones and sequences
    "task_delete_log", "nexus_counters",
    # caches and data synced in from outside systems (the source system is the record)
    "ops_report_cache", "ticket_ai_summaries", "accounting_trx", "ramp_transactions",
    "m365_sync_runs", "ops_competitor_rates", "ops_competitors", "construction_ai_jobs",
    "cubby_daily_snapshots", "weather_outlook", "weather_advisories",
    "marketing_gbp_daily", "marketing_gbp_keywords", "marketing_gbp_locations",
    "marketing_ads_daily", "marketing_ads_keywords", "marketing_ads_campaigns",
    "marketing_ads_accounts", "marketing_reviews",
    # the Workflows event outbox and per-step run log (Oct 28 2026): one row
    # per observed change and per step - the run itself is the record
    "workflow_events", "workflow_run_steps",
})
NOISE_PREFIXES: tuple[str, ...] = ("cubby_", "asana_", "third_party_fetch")

# Written by background jobs as their own bookkeeping (nexus_settings holds
# job cursors and "last ran" stamps). Captured when a PERSON changes them in a
# request, skipped when a job does.
SYSTEM_SKIP_TABLES: frozenset[str] = frozenset({"nexus_settings", "property_workspace_meta"})

# The capture is on unless NEXUS_AUDIT_CHANGES=off (an emergency switch).
def enabled() -> bool:
    return os.getenv("NEXUS_AUDIT_CHANGES", "on").lower() not in ("off", "0", "false", "no")


def skip_table(table: str, system: bool) -> bool:
    if table in NOISE_TABLES or table.startswith(NOISE_PREFIXES):
        return True
    return system and table in SYSTEM_SKIP_TABLES


# ── redaction ────────────────────────────────────────────────────────────────
# A column (or a JSON key inside a value) whose name has one of these words is
# recorded as "changed", never with its value.
_SECRET_WORDS = {"password", "passwd", "secret", "token", "tokens", "ssn", "tin", "pin", "otp",
                 "cookie", "cookies", "refresh", "hash", "salt", "cvv", "iban", "routing",
                 "card", "apikey", "credential", "credentials", "enc", "passcode", "mfa"}
_SECRET_PHRASES = ("api_key", "private_key", "secret_key", "access_key", "client_key", "signing_key",
                   "account_number", "account_no", "acct_number", "card_number", "bank_account",
                   "tax_id", "taxid", "social_security", "signature_image", "signature_data",
                   "signature_png", "drawn_signature", "sig_image")
# HR / pay identity values (mirrors hr.py's field audit mask, Sep 22).
_HR_MASK = ("ssn", "salary", "pay", "rate", "bank", "tax", "passport", "id_number", "compensation",
            "account", "dob", "birth")
_HR_TABLES = {"nexus_employees", "hr_candidates", "hr_life_events", "hr_self_requests"}
# Every value of these tables is a pay figure or a personal financial figure.
_VALUE_MASKED_TABLES = {"payroll_rates", "payroll_rate_history"}
_PFS_FIGURE_TABLES_PREFIX = "pfs_"
_PFS_READABLE = {"pfs_access_log"}       # names things (statement id, a format) - never a figure

MAX_TEXT = 2000           # characters kept of any one value
MAX_ROW_JSON = 16000      # characters kept of one change row's JSON
MAX_ROWS_PER_FLUSH = 200  # beyond this a flush is summarized in one row

# Columns that only record that something was looked at / touched. An update
# that moves nothing else is not a change anyone audits (and some GETs do it
# on every call).
_TOUCH_RE = re.compile(r"^(last_[a-z_]*|[a-z_]*_seen(_at)?|seen_at|viewed_at|opened_at|accessed_at|"
                       r"modified_at|updated_at|heartbeat[a-z_]*|ping_at|checked_at)$")

_B64_RE = re.compile(r"^(data:[^;,]{1,80};base64,)?[A-Za-z0-9+/=\r\n]{400,}$")
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")


def _words(name: str) -> list[str]:
    s = re.sub(r"([a-z])([A-Z])", r"\1_\2", name or "").lower()
    return [w for w in re.split(r"[^a-z0-9]+", s) if w]


def is_secret_field(name: str) -> bool:
    n = (name or "").lower()
    if any(p in n.replace("-", "_") for p in _SECRET_PHRASES):
        return True
    return any(w in _SECRET_WORDS for w in _words(name))


def _redact_reason(table: str, col: str) -> str:
    """'' = keep the value, else why it is hidden."""
    if is_secret_field(col):
        return "secret"
    if table.startswith(_PFS_FIGURE_TABLES_PREFIX) and table not in _PFS_READABLE:
        return "pfs"
    if table in _VALUE_MASKED_TABLES:
        return "pay"
    if table in _HR_TABLES and any(m in col.lower() for m in _HR_MASK):
        return "sensitive"
    return ""


def _looks_html(s: str) -> bool:
    return "<" in s and ">" in s and bool(re.search(r"</?(p|div|br|span|b|i|strong|em|ul|ol|li|a|h\d|table)\b", s, re.I))


def html_to_text(s: str) -> str:
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", s)
    s = _TAG_RE.sub("", s)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'")):
        s = s.replace(a, b)
    s = _WS_RE.sub(" ", s)
    return re.sub(r"\n\s*\n+", "\n", s).strip()


def _redact_json(v, depth: int = 0):
    """Hide secret keys anywhere inside a dict/list value."""
    if depth > 6:
        return "[nested]"
    if isinstance(v, dict):
        return {k: ("[redacted]" if is_secret_field(str(k)) else _redact_json(x, depth + 1)) for k, x in v.items()}
    if isinstance(v, list):
        return [_redact_json(x, depth + 1) for x in v[:200]]
    return v


def clean_value(v) -> tuple[Any, str]:
    """(JSON-safe value, kind hint). Truncates, strips HTML to its text, and
    replaces base64 blobs with a size marker."""
    if v is None or isinstance(v, (bool, int)):
        return v, ""
    if isinstance(v, float):
        return v, ""
    if isinstance(v, decimal.Decimal):
        return float(v), ""
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat(), ""
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"[binary data, {len(bytes(v)) // 1024} KB]", ""
    if isinstance(v, (dict, list)):
        red = _redact_json(v)
        try:
            dumped = json.dumps(red, default=str)
        except Exception:   # noqa: BLE001
            return str(v)[:MAX_TEXT], ""
        if len(dumped) > MAX_TEXT:
            return dumped[:MAX_TEXT] + f"... [truncated, {len(dumped)} chars]", "json"
        return red, "json"
    s = str(v)
    st = s.lstrip()
    if st[:1] in "{[" and len(st) > 1:
        try:
            parsed = json.loads(st)
            if isinstance(parsed, (dict, list)):
                return clean_value(parsed)
        except ValueError:
            pass
    if len(s) >= 400 and _B64_RE.match(s[:4000]):
        return f"[binary data, {len(s) * 3 // 4 // 1024} KB]", ""
    kind = ""
    if _looks_html(s):
        s, kind = html_to_text(s), "html"
    if len(s) > MAX_TEXT:
        s = s[:MAX_TEXT] + f"... [truncated, {len(s)} chars]"
    return s, kind


def _empty(v) -> bool:
    return v is None or v == "" or v == [] or v == {} or v is False


# ── collecting from a flush ───────────────────────────────────────────────────
_LABEL_COLS = ("title", "subject", "name", "display_name", "label", "code", "cred_name",
               "item_name", "entity_title", "filename", "file_name", "email", "work_email",
               "employee_email", "target_email", "recipient")


def _label_from(table: str, values: dict) -> str:
    fn, ln = values.get("first_name"), values.get("last_name")
    if isinstance(fn, str) and fn:
        return f"{fn} {ln or ''}".strip()[:200]
    for c in _LABEL_COLS:
        v = values.get(c)
        if isinstance(v, str) and v.strip():
            return html_to_text(v)[:200] if _looks_html(v) else v.strip()[:200]
    return ""


def _pk(state, mapper) -> str:
    vals = []
    for col in mapper.primary_key:
        try:
            prop = mapper.get_property_by_column(col)
            vals.append(state.dict.get(prop.key))
        except Exception:   # noqa: BLE001
            vals.append(None)
    if all(v is None for v in vals) and state.key is not None:
        vals = list(state.key[1])
    return ":".join("" if v is None else str(v) for v in vals)[:200]


def _col_props(mapper):
    """(attribute key, column name) for every plain column attribute. Cached on
    the mapper - this runs per object per flush."""
    cached = mapper.__dict__.get("_nexus_audit_cols")
    if cached is None:
        cached = []
        for prop in mapper.column_attrs:
            try:
                cached.append((prop.key, prop.columns[0].name))
            except Exception:   # noqa: BLE001
                continue
        try:
            setattr(mapper, "_nexus_audit_cols", cached)
        except Exception:   # noqa: BLE001
            pass
    return cached


def _field(table: str, col: str, before, after, *, has_before: bool, has_after: bool) -> Optional[dict]:
    reason = _redact_reason(table, col)
    if reason:
        out = {"r": reason}
        if not has_before:
            out["bu"] = True
        return out
    out: dict = {}
    kind = ""
    if has_before:
        out["b"], k1 = clean_value(before)
        kind = kind or k1
    else:
        out["bu"] = True
    if has_after:
        out["a"], k2 = clean_value(after)
        kind = kind or k2
    if kind:
        out["t"] = kind
    return out


def _collect_object(obj, op: str, system: bool) -> Optional[dict]:
    from sqlalchemy import inspect as sa_inspect
    state = sa_inspect(obj)
    mapper = state.mapper
    table = getattr(mapper.local_table, "name", "") or ""
    if not table or skip_table(table, system):
        return None
    cols = _col_props(mapper)
    changes: dict = {}
    values_for_label: dict = {}
    d = state.dict
    if op == "insert":
        for key, col in cols:
            v = d.get(key)
            if isinstance(v, str) and col in _LABEL_COLS + ("first_name", "last_name"):
                values_for_label[col] = v
            if _empty(v):
                continue
            f = _field(table, col, None, v, has_before=False, has_after=True)
            f.pop("bu", None)
            changes[col] = f
    elif op == "delete":
        for key, col in cols:
            if key not in d:
                continue
            v = d.get(key)
            if isinstance(v, str) and col in _LABEL_COLS + ("first_name", "last_name"):
                values_for_label[col] = v
            if _empty(v):
                continue
            changes[col] = _field(table, col, v, None, has_before=True, has_after=False)
    else:  # update: only attributes the ORM saw being set
        committed = state.committed_state
        if not committed:
            return None
        colmap = dict(cols)
        for key in list(committed.keys()):
            col = colmap.get(key)
            if col is None:
                continue
            hist = state.attrs[key].history
            if not hist.added and not hist.deleted:
                continue
            after = hist.added[0] if hist.added else None
            if hist.deleted:
                before, has_before = hist.deleted[0], True
            else:
                before, has_before = None, False
            if has_before and before == after:
                continue
            changes[col] = _field(table, col, before, after, has_before=has_before, has_after=True)
        if not changes or all(_TOUCH_RE.search(c) for c in changes):
            return None     # nothing, or only "last seen" style stamps moved
        for key, col in cols:
            if col in _LABEL_COLS + ("first_name", "last_name") and isinstance(d.get(key), str):
                values_for_label[col] = d.get(key)
    return {"table_name": table, "record_id": _pk(state, mapper), "op": op, "changes": changes,
            "summary": _label_from(table, values_for_label)}


def _job_from_stack() -> str:
    """Outermost backend function on this thread's stack ("task_notify.flush_batches")."""
    here = os.path.dirname(os.path.abspath(__file__))
    best = ""
    try:
        f = sys._getframe(2)
    except ValueError:
        return ""
    depth = 0
    while f is not None and depth < 200:
        fn = f.f_code.co_filename or ""
        if fn.startswith(here) and not fn.endswith(("audit_capture.py", "database.py")) \
                and "site-packages" not in fn:
            mod = os.path.splitext(os.path.relpath(fn, here))[0].replace(os.sep, ".")
            best = f"{mod}.{f.f_code.co_name}"
        f = f.f_back
        depth += 1
    return best[:120]


def _stamp() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _rows_for(items: list[dict], ctx: Optional[AuditContext]) -> list[dict]:
    at = _stamp()
    if ctx is not None and not ctx.job:
        actor = ctx.actor or ctx.actor_hint or ""
        acting_as = ctx.acting_as
        request_id = ctx.request_id
        source = f"{ctx.method} {ctx.path}"[:300]
        path_module = module_for_path(ctx.path)
    else:
        actor = "system"
        acting_as = ""
        request_id = ctx.request_id if ctx is not None else f"job-{new_request_id()}"
        source = (ctx.job if ctx is not None and ctx.job else _job_from_stack()) or "background job"
        path_module = ""
    rows = []
    for it in items[:MAX_ROWS_PER_FLUSH]:
        mod = module_for_table(it["table_name"])
        if mod == "other" and path_module:
            mod = path_module
        try:
            ch = json.dumps(it["changes"], default=str)
        except Exception:   # noqa: BLE001
            ch = "{}"
        if len(ch) > MAX_ROW_JSON:
            ch = json.dumps({"_truncated": {"r": "too_large", "a": f"{len(ch)} characters of changes"}})
        rows.append({"request_id": request_id, "at": at, "actor": actor[:200], "acting_as": acting_as[:200],
                     "module": mod, "table_name": it["table_name"][:100], "record_id": it["record_id"],
                     "op": it["op"], "changes": ch, "summary": (it.get("summary") or "")[:300],
                     "source": source})
    if len(items) > MAX_ROWS_PER_FLUSH:
        extra = items[MAX_ROWS_PER_FLUSH:]
        tables = sorted({i["table_name"] for i in extra})
        rows.append({**rows[-1], "table_name": tables[0][:100] if len(tables) == 1 else "multiple",
                     "record_id": "", "op": "bulk",
                     "changes": json.dumps({"records": {"a": len(extra)}, "tables": {"a": ", ".join(tables)[:500]}}),
                     "summary": f"{len(extra)} more records"})
    return rows


def _write(session, rows: list[dict]) -> None:
    """Insert on the session's own connection (same transaction). Postgres
    gets a SAVEPOINT so a failure cannot poison the caller's transaction;
    SQLite leaves the transaction usable after a failed statement anyway."""
    import models
    table = models.AuditChange.__table__
    conn = session.connection()
    if conn.dialect.name == "postgresql":
        with conn.begin_nested():
            conn.execute(table.insert(), rows)
    else:
        conn.execute(table.insert(), rows)


def _note(ctx: Optional[AuditContext], rows: list[dict]) -> None:
    if ctx is None:
        return
    ctx.captured += len(rows)
    for r in rows:
        if len(ctx.tables) >= 12:
            break
        ctx.tables.append((r["table_name"], r["op"], r["record_id"], r["summary"]))


def _log_failure(where: str, e: Exception) -> None:
    print(f"[audit] change capture skipped ({where}): {type(e).__name__}: {str(e)[:200]}")


def wire(session_factory) -> None:
    """Attach the listeners to SessionLocal (called once from database.py)."""
    from sqlalchemy import event

    @event.listens_for(session_factory, "after_flush")
    def _capture(session, _flush_ctx):
        if not enabled():
            return
        try:
            ctx = _ctx.get()
            system = ctx is None or bool(ctx.job)
            items = []
            for objs, op in ((session.new, "insert"), (session.dirty, "update"), (session.deleted, "delete")):
                for obj in objs:
                    if len(items) >= MAX_ROWS_PER_FLUSH:
                        # Past the cap only the table is needed (for the
                        # "N more records" row) - skip the per-field work.
                        try:
                            t = getattr(type(obj).__table__, "name", "")
                        except AttributeError:
                            continue
                        if t and not skip_table(t, system) and (op != "update" or session.is_modified(obj)):
                            items.append({"table_name": t})
                        continue
                    try:
                        it = _collect_object(obj, op, system)
                    except Exception as e:   # noqa: BLE001 - one odd object never stops the rest
                        _log_failure("collect", e)
                        continue
                    if it is not None:
                        items.append(it)
            if not items:
                return
            rows = _rows_for(items, ctx)
            _write(session, rows)
            _note(ctx, rows)
        except Exception as e:   # noqa: BLE001 - auditing must never fail the write
            _log_failure("flush", e)

    def _bulk(op):
        def _handler(update_context):
            if not enabled():
                return
            try:
                mapper = update_context.mapper
                if mapper is None:
                    return
                table = getattr(mapper.local_table, "name", "") or ""
                ctx = _ctx.get()
                if not table or skip_table(table, ctx is None or bool(ctx.job)):
                    return
                changes = {}
                values = getattr(update_context, "values", None) or {}
                if isinstance(values, dict):
                    for k, v in list(values.items())[:60]:
                        col = getattr(k, "key", None) or getattr(k, "name", None) or str(k)
                        f = _field(table, col, None, v if not hasattr(v, "compile") else str(v),
                                   has_before=False, has_after=True)
                        changes[col] = f
                res = getattr(update_context, "result", None)
                count = getattr(res, "rowcount", None) if res is not None else None
                if isinstance(count, int) and count >= 0:
                    changes["_rows"] = {"a": count}
                rows = _rows_for([{"table_name": table, "record_id": "", "op": op,
                                   "changes": changes, "summary": ""}], ctx)
                _write(update_context.session, rows)
                _note(ctx, rows)
            except Exception as e:   # noqa: BLE001
                _log_failure(op, e)
        return _handler

    event.listen(session_factory, "after_bulk_update", _bulk("bulk_update"))
    event.listen(session_factory, "after_bulk_delete", _bulk("bulk_delete"))


def decode_bearer_email(auth_header: str) -> str:
    """Email in an (unverified) bearer token - a hint for who to name when no
    auth dependency ran. Pure string work, safe on the event loop."""
    if not (auth_header or "").startswith("Bearer "):
        return ""
    try:
        parts = auth_header[7:].split(".")
        if len(parts) < 2:
            return ""
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        return (payload.get("preferred_username") or payload.get("email") or payload.get("upn") or "").lower()
    except Exception:   # noqa: BLE001
        return ""
