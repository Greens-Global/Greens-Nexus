"""Conditions (spec 4, 8.1): "Only if" rows of field / operator / value on
the event's subject. Groups are OR, rows inside a group AND. `evaluate`
returns the verdict and a trace row per condition - the dry run shows every
row with the value it saw, so a miss is never a mystery.

Operators per field type are the ones `catalog.OPERATORS` pins; `changed`,
`changed_to` and `changed_from` read the event's from / to; dates compare
as dates against `ctx.today`. An unknown field or operator is simply
false, never an error.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from workflows import catalog
from workflows.context import MISSING, RunContext


# ── value helpers ────────────────────────────────────────────────────────────
def _text(v: Any) -> str:
    if v is None or v is MISSING:
        return ""
    if isinstance(v, (list, tuple)):
        return ", ".join(_text(x) for x in v)
    return str(v).strip()


def _lower(v: Any) -> str:
    return _text(v).lower()


def _empty(v: Any) -> bool:
    return v is None or v is MISSING or v == "" or v == [] or v == {}


def _number(v: Any):
    if v is None or v is MISSING or v == "":
        return None
    try:
        return float(str(v).replace(",", "").replace("$", "").strip())
    except (TypeError, ValueError):
        return None


def _date(v: Any):
    if v is None or v is MISSING:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    if len(s) < 10:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _int(v: Any, default: int = 0) -> int:
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def _list(v: Any) -> list[str]:
    if v is None or v is MISSING:
        return []
    if isinstance(v, (list, tuple, set)):
        return [_lower(x) for x in v if _text(x)]
    return [p.strip().lower() for p in str(v).split(",") if p.strip()]


def _bool(v: Any):
    if v is None or v is MISSING:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    s = str(v).strip().lower()
    if s in ("true", "yes", "1", "on", "y"):
        return True
    if s in ("false", "no", "0", "off", "n", ""):
        return False
    return None


# ── one row ──────────────────────────────────────────────────────────────────
def compare(ftype: str, op: str, actual: Any, value: Any, today: date) -> bool:
    """The operator table, one type at a time."""
    if op == "is_empty":
        return _empty(actual)
    if op == "is_not_empty":
        return not _empty(actual)
    if ftype == "text":
        a, v = _lower(actual), _lower(value)
        if op == "is":
            return a == v
        if op == "is_not":
            return a != v
        if op == "contains":
            return bool(v) and v in a
        return False
    if ftype == "select":
        a = _lower(actual)
        if op == "is":
            return a == _lower(value)
        if op == "is_not":
            return a != _lower(value)
        if op == "is_any_of":
            return a in _list(value)
        return False
    if ftype in ("number", "money"):
        a, v = _number(actual), _number(value)
        if a is None or v is None:
            return False
        if op == "is":
            return a == v
        if op == "is_not":
            return a != v
        if op == "gt":
            return a > v
        if op == "lt":
            return a < v
        return False
    if ftype in ("date", "datetime"):
        a = _date(actual)
        if a is None:
            return False
        if op == "within_next_days":
            return today <= a <= today + timedelta(days=_int(value))
        if op == "within_last_days":
            return today - timedelta(days=_int(value)) <= a <= today
        v = _date(value)
        if v is None:
            return False
        if op == "is":
            return a == v
        if op == "before":
            return a < v
        if op == "after":
            return a > v
        return False
    if ftype == "person":
        a, v = _lower(actual), _lower(value)
        if op == "is":
            return bool(a) and a == v
        if op == "is_not":
            return a != v
        if op == "includes":
            return bool(v) and v in _list(actual)
        return False
    if ftype == "people":
        a, v = _list(actual), _list(value)
        if op == "is":
            return set(a) == set(v)
        if op == "is_not":
            return set(a) != set(v)
        if op == "includes":
            return bool(v) and all(x in a for x in v)
        return False
    if ftype == "bool":
        a, v = _bool(actual), _bool(value)
        if op == "is":
            return a is not None and v is not None and a == v
        return False
    return False


def check_row(row: dict, ctx: RunContext) -> tuple[bool, Any]:
    """(ok, actual) for one condition row against the subject."""
    fld = str((row or {}).get("field") or "").strip()
    op = str((row or {}).get("op") or "").strip()
    value = (row or {}).get("value")
    if ctx.entity is None or not fld:
        return False, MISSING
    f = ctx.entity.field(fld)
    if f is None or op not in catalog.OPERATORS.get(f.type, ()):
        return False, MISSING
    if op in ("changed", "changed_to", "changed_from"):
        changes = (ctx.payload or {}).get("changes") or {}
        ch = changes.get(fld)
        if not isinstance(ch, dict):
            return False, MISSING
        if not ctx.can_see(f):
            return False, MISSING
        if op == "changed":
            return True, ch
        target = ch.get("to") if op == "changed_to" else ch.get("from")
        if f.type in ("person",):
            return _lower(target) == _lower(value), target
        if f.type in ("number", "money"):
            return _number(target) is not None and _number(target) == _number(value), target
        if f.type in ("date", "datetime"):
            return _date(target) is not None and _date(target) == _date(value), target
        if f.type == "bool":
            return _bool(target) is not None and _bool(target) == _bool(value), target
        return _lower(target) == _lower(value), target
    actual = ctx.field_value(f)
    if actual is MISSING:
        return False, MISSING
    return compare(f.type, op, actual, value, ctx.today), actual


# ── groups ───────────────────────────────────────────────────────────────────
def normalize(groups) -> list[list[dict]]:
    """[[row, ...], ...]; a flat list of rows is one group; nothing is no
    condition at all."""
    if not groups:
        return []
    if isinstance(groups, dict):
        return [[groups]]
    if all(isinstance(g, dict) for g in groups):
        return [list(groups)]
    out = []
    for g in groups:
        if isinstance(g, dict):
            out.append([g])
        elif isinstance(g, (list, tuple)):
            out.append([r for r in g if isinstance(r, dict)])
    return out


def evaluate(groups, ctx: RunContext) -> tuple[bool, list[dict]]:
    """Groups OR, rows AND. Returns (passed, trace); every row is evaluated
    so the trace is complete. No groups = passes."""
    gs = normalize(groups)
    if not gs:
        return True, []
    trace: list[dict] = []
    passed = False
    for gi, rows in enumerate(gs):
        group_ok = True
        if not rows:
            group_ok = True
        for r in rows:
            try:
                ok, actual = check_row(r, ctx)
            except Exception as e:   # noqa: BLE001 - a condition that cannot be read is false, with the reason in the trace
                ok, actual = False, f"error: {type(e).__name__}"
            trace.append({"group": gi, "field": r.get("field"), "op": r.get("op"), "value": r.get("value"),
                          "actual": None if actual is MISSING else actual, "ok": bool(ok)})
            group_ok = group_ok and ok
        passed = passed or group_ok
    return passed, trace
