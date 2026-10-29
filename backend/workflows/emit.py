"""The outbox write (spec 5.2, 6.2). A module calls

    workflows.emit(db, "hr.time_off.decided", subject=row, actor=user["email"],
                   changes={"status": (old, new)}, extra={"note": body.note})

at its choke point. The row goes on `session.connection()` INSIDE the
caller's transaction (a SAVEPOINT on Postgres, the audit_capture pattern),
so it commits with the change or not at all - never from after_commit,
which also fires on SAVEPOINT release. It never raises into the caller: a
bad key, a missing row or a failed insert is one `[workflows] emit skipped`
line.

Volume: a normal event is always written (Test With A Recent Event has
real rows from day one); a `volume="high"` event is written only while an
active workflow subscribes to its key (`subscribed`, a process cache of the
`workflows.subscribed` setting the runner refreshes every minute).

`CURRENT_RUN` holds `(run_id, depth)` while a run's step executes; an event
emitted under it carries `caused_by_run` and `depth + 1`, and anything that
would pass depth 2 is not written at all (spec: a chain never exceeds
depth 2).

`quiet()` writes nothing - no emit and no record-observer row - for work
that is housekeeping rather than something happening (Charmi 10/28: HR's
close-out of the periods paid in SwipeClock would otherwise fire every
"time sheet changed" workflow once per old period). The module's own
history and audit rows are written as usual.
"""
from __future__ import annotations

import contextlib
import contextvars
import json
import threading
import time
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from workflows import catalog

CURRENT_RUN: contextvars.ContextVar = contextvars.ContextVar("workflow_run", default=None)
QUIET: contextvars.ContextVar = contextvars.ContextVar("workflow_quiet", default=False)


@contextlib.contextmanager
def quiet():
    """No workflow event inside the block (emit and the record observer).
    Flush inside it: the observer writes at flush time."""
    token = QUIET.set(True)
    try:
        yield
    finally:
        QUIET.reset(token)

SUBSCRIBED_KEY = "workflows.subscribed"     # NexusSetting: JSON list of event keys active workflows use
MAX_DEPTH = 2
_SUB_TTL = 60.0
_sub_lock = threading.Lock()
_sub_cache: dict = {"keys": frozenset(), "at": 0.0}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _log(msg: str) -> None:
    print(f"[workflows] emit skipped ({msg})")


# ── the subscribed-key cache ─────────────────────────────────────────────────
def _read_subscribed(db) -> frozenset:
    import models
    from sqlalchemy import select
    conn = db.connection() if db is not None else None
    if conn is None:
        return frozenset()
    t = models.NexusSetting.__table__
    raw = conn.execute(select(t.c.value).where(t.c.key == SUBSCRIBED_KEY)).scalar()
    try:
        keys = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        keys = []
    return frozenset(str(k) for k in keys if isinstance(k, str))


def subscribed(key: str, db=None) -> bool:
    """Whether any active workflow subscribes to `key` - read from a
    process cache refreshed at most every 60 s from the setting the runner
    writes. Without a session to refresh from, the cache answers as it is."""
    now = time.monotonic()
    with _sub_lock:
        stale = now - _sub_cache["at"] > _SUB_TTL
    if stale and db is not None:
        try:
            keys = _read_subscribed(db)
        except Exception as e:   # noqa: BLE001 - the cache is a hint, never a failure
            print(f"[workflows] subscribed keys not read: {type(e).__name__}: {str(e)[:120]}")
            keys = None
        with _sub_lock:
            if keys is not None:
                _sub_cache["keys"] = keys
            _sub_cache["at"] = now
    with _sub_lock:
        return key in _sub_cache["keys"]


def refresh_subscribed(keys) -> None:
    """The runner (and tests) set the cache directly after writing the setting."""
    with _sub_lock:
        _sub_cache["keys"] = frozenset(keys or ())
        _sub_cache["at"] = time.monotonic()


# ── payloads ─────────────────────────────────────────────────────────────────
def _jsonable(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set, frozenset)):
        return [_jsonable(x) for x in v]
    return str(v)


def read_path(row, path: str) -> Any:
    """`a.b.c` over attributes and dict keys; missing -> None."""
    cur = row
    for part in path.split("."):
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
    return cur


def field_value(entity_def: catalog.EntityDef, row, f: catalog.Field) -> Any:
    """One field's value off the row: by `path` (dotted; `__label__` is the
    entity's label), else the attribute of the same key. Dates become
    strings, people lowercase."""
    if row is None:
        return None
    if f.path == "__label__":
        v = entity_def.label_for(row)
    else:
        v = read_path(row, f.path or f.key)
    v = _jsonable(v)
    if f.type in ("date", "datetime") and v is not None and not isinstance(v, str):
        v = str(v)
    if f.type == "person" and isinstance(v, str):
        v = v.strip().lower()
    if f.type == "people":
        if isinstance(v, str):
            v = [e.strip().lower() for e in v.split(",") if e.strip()]
        elif isinstance(v, list):
            v = [str(e).strip().lower() for e in v if str(e or "").strip()]
    return v


def payload_for(entity_def: catalog.EntityDef, row, *, ceiling: str = "all") -> dict:
    """The subject's registered fields as a JSON-safe dict (the payload's
    "subject"), up to the visibility `ceiling` - "all" (the default) keeps
    only what everyone may see, so an outbox row, a For Each item list or a
    run's payload never carries pay or an HR-only field: the engine re-reads
    the row for conditions and templates through `RunContext.field_value`,
    which checks the run-as user's own sight. A field that cannot be read is
    left blank, never raised."""
    top = catalog.VISIBILITY_RANK.get(ceiling, 0)
    out = {}
    for f in entity_def.fields:
        if catalog.VISIBILITY_RANK.get(f.visibility, 0) > top:
            continue
        try:
            out[f.key] = field_value(entity_def, row, f)
        except Exception:   # noqa: BLE001 - one odd field never loses the event
            out[f.key] = None
    return out


def _changes_out(changes: Optional[dict]) -> dict:
    out = {}
    for k, v in (changes or {}).items():
        if isinstance(v, dict) and ("from" in v or "to" in v):
            out[str(k)] = {"from": _jsonable(v.get("from")), "to": _jsonable(v.get("to"))}
        elif isinstance(v, (list, tuple)) and len(v) == 2:
            out[str(k)] = {"from": _jsonable(v[0]), "to": _jsonable(v[1])}
        else:
            out[str(k)] = {"from": None, "to": _jsonable(v)}
    return out


# ── the write ────────────────────────────────────────────────────────────────
def _insert(db, row: dict) -> None:
    import models
    table = models.WorkflowEvent.__table__
    conn = db.connection()
    if conn.dialect.name == "postgresql":
        with conn.begin_nested():
            conn.execute(table.insert(), [row])
    else:
        conn.execute(table.insert(), [row])


def emit(db, key: str, *, subject, actor: str = "", changes: Optional[dict] = None,
         extra: Optional[dict] = None, company_id: Optional[str] = None) -> None:
    """Write one outbox row for event `key` about `subject` (the ORM row or
    its id) inside the caller's transaction. Never raises."""
    if QUIET.get():
        return
    try:
        catalog.load_packs()     # a request worker's first emit may come before any flush loaded them
        ev = catalog.EVENTS.get(key)
        if ev is None:
            _log(f"unknown event {key!r}")
            return
        ent = catalog.ENTITIES.get(ev.entity)
        if ent is None:
            _log(f"event {key!r} names an unregistered entity {ev.entity!r}")
            return
        run = CURRENT_RUN.get()
        caused_by, depth = "", 0
        if run:
            caused_by, depth = str(run[0] or ""), int(run[1] or 0) + 1
            if depth > MAX_DEPTH:
                return   # a chain never exceeds depth 2 - quietly, by design
        if ev.volume == "high" and not subscribed(key, db):
            return
        row = subject
        if row is not None and not (ent.model is not None and isinstance(row, ent.model)):
            row = ent.load_row(db, str(subject)) if isinstance(subject, (str, int)) else subject
        if row is None:
            _log(f"{key}: subject {subject!r} not found")
            return
        subject_id = str(getattr(row, "id", "") or "")
        company = ent.company_of(row) if company_id is None else str(company_id or "")
        payload = {
            "subject": payload_for(ent, row),
            "subjectLabel": ent.label_for(row),
            "changes": _changes_out(changes),
            "extra": _jsonable(dict(extra or {})),
            "actor": (actor or "").strip().lower(),
        }
        _insert(db, {
            "id": str(uuid.uuid4()), "key": key, "entity": ent.key, "subject_id": subject_id,
            "company_id": company, "actor": payload["actor"], "payload": payload,
            "caused_by_run": caused_by, "depth": depth, "at": _now(), "processed_at": "",
            "attempts": 0, "error": "", "wanted": 1 if subscribed(key, db) else 0,
        })
    except Exception as e:   # noqa: BLE001 - an outbox write must never fail the caller's request
        _log(f"{key}: {type(e).__name__}: {str(e)[:200]}")
