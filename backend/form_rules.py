"""The rules a form's answers obey (Forms & Checklists, Neil 11/02/2026).

The browser checks these as the person types; the server checks them again
at submit, because a direct API call must not file a half-filled inspection.

    visible_tokens(defs, answers) -> the tokens shown, after every showIf
    clean(defs, answers)          -> only known, visible tokens (stale hidden
                                     values dropped), repeat groups as lists
    validate(defs, answers)       -> [{token, message}] - required, formats,
                                     repeat groups (Review Focus 1 and 2)
    compute(defs, answers)        -> answers with every formula worked out

Answers are {token: value}. A repeat group is `answers[group]`: a list of
answer maps, one per row, each holding that group's tokens. A field with
`repeat: {group, max}` belongs to the group and is checked per row; the
group is required when any of its fields is (at least one row).

Formulas are the Tasks formula language (task_formula.parse gives the tree;
`_eval` here works it out the way frontend/src/tasks/formula.js does -
numbers, text, true / false, ISO dates, blanks). `{Name}` names a field by
its label or its token, within the same repeat row first, then the form.
"""
from __future__ import annotations

import math
import re
from datetime import date, datetime, timedelta

import task_formula
from task_formula import FormulaError

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")
_NON_NUMERIC_RE = re.compile(r"[^0-9.\-]")
_TIME_RE = re.compile(r"^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$")
_URL_FIELDS = ("photo", "signature", "image", "file")
MAX_TEXT = 10_000
MAX_DATE_SHIFT_DAYS = 36_500     # a date moves at most ~100 years in a formula
MAX_PHOTOS = 20
DEFAULT_REPEAT_MAX = 10


# ── Values ────────────────────────────────────────────────────────────────

def is_blank(v) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip() == ""
    if isinstance(v, (list, dict)):
        return len(v) == 0
    return False


def _label(d: dict) -> str:
    return str(d.get("label") or d.get("token") or "")


def _as_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _yes(v):
    """A yesno answer as a bool, or None when it is not one."""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    if isinstance(v, str):
        s = v.strip().lower()
        if s in ("true", "yes", "y", "1"):
            return True
        if s in ("false", "no", "n", "0"):
            return False
    return None


def _number(v):
    """A number from an answer ("$1,200", 12, "12.5"), or None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v if math.isfinite(v) else None
    if isinstance(v, str):
        cleaned = _NON_NUMERIC_RE.sub("", v.replace(",", ""))
        try:
            return float(cleaned) if cleaned not in ("", "-", ".", "-.") else None
        except ValueError:
            return None
    return None


# ── Groups and visibility ─────────────────────────────────────────────────

def group_of(d: dict) -> str:
    rep = d.get("repeat") if isinstance(d.get("repeat"), dict) else None
    return str(rep.get("group") or "") if rep else ""


def groups(defs: list) -> dict:
    """{group -> [defs in order]} for every repeat group."""
    out: dict = {}
    for d in defs or []:
        g = group_of(d)
        if g:
            out.setdefault(g, []).append(d)
    return out


def _repeat_max(members: list) -> int:
    mx = DEFAULT_REPEAT_MAX
    for d in members:
        try:
            mx = int((d.get("repeat") or {}).get("max") or mx)
        except (TypeError, ValueError):
            pass
    return max(1, mx)


def show_if_holds(cond: dict, answers: dict) -> bool:
    """Does `answers` satisfy one {token, op, value}?"""
    if not isinstance(cond, dict):
        return True
    have = answers.get(cond.get("token"))
    op = cond.get("op") or "eq"
    if op == "empty":
        return is_blank(have)
    if op == "notEmpty":
        return not is_blank(have)
    want = cond.get("value")
    # yes / no answers compare as booleans whatever spelling arrived.
    hv, wv = _yes(have), _yes(want)
    if hv is not None and wv is not None:
        have, want = hv, wv
    if op == "any":
        wants = want if isinstance(want, list) else [want]
        return any(_as_text(have).strip().lower() == _as_text(w).strip().lower() for w in wants)
    same = _as_text(have).strip().lower() == _as_text(want).strip().lower()
    return same if op == "eq" else not same


def visible_tokens(defs: list, answers: dict) -> set:
    """Tokens shown given these answers. A field whose showIf points at a
    hidden field of the same scope is hidden too (walked in order, so a
    chain resolves)."""
    answers = answers if isinstance(answers, dict) else {}
    here = {d.get("token") for d in defs or [] if d.get("token")}
    shown: set = set()
    for d in defs or []:
        token = d.get("token")
        if not token:
            continue
        cond = d.get("showIf")
        if not cond:
            shown.add(token)
            continue
        parent = cond.get("token")
        if parent in here and parent not in shown:
            continue
        if show_if_holds(cond, answers):
            shown.add(token)
    return shown


# ── Clean ─────────────────────────────────────────────────────────────────

def clean(defs: list, answers: dict) -> dict:
    """Only the tokens the form defines and shows, repeat groups as lists of
    rows holding only the group's visible tokens. Stale values behind a
    hidden showIf are dropped here (Review Focus 1)."""
    answers = answers if isinstance(answers, dict) else {}
    by_group = groups(defs)
    out: dict = {}
    shown = visible_tokens(defs, answers)
    for d in defs or []:
        token = d.get("token")
        if not token or group_of(d) or token not in shown or token not in answers:
            continue
        out[token] = _coerce(d, answers.get(token))
    for g, members in by_group.items():
        rows = answers.get(g)
        if not isinstance(rows, list):
            continue
        cleaned = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_shown = visible_tokens(members, {**answers, **row})
            cleaned.append({d["token"]: _coerce(d, row.get(d["token"]))
                            for d in members if d.get("token") in row_shown and d.get("token") in row})
        out[g] = cleaned
    return out


def _coerce(d: dict, v):
    """A stored value in its canonical shape; a wrong shape is left as is for
    validate() to name."""
    ftype = d.get("type")
    if v is None:
        return None
    if ftype == "yesno":
        y = _yes(v)
        return v if y is None else y
    if ftype in ("number", "currency", "rating"):
        n = _number(v)
        if n is None:
            return v
        return int(n) if float(n).is_integer() else n
    if ftype == "photo":
        if isinstance(v, str):
            v = [v] if v.strip() else []
        return [str(u).strip() for u in v if str(u).strip()][:MAX_PHOTOS] if isinstance(v, list) else v
    if ftype == "checkbox":
        y = _yes(v)
        return v if y is None else y
    if ftype == "gps":
        if isinstance(v, dict):
            out = {}
            for k in ("lat", "lng", "accuracyM"):
                n = _number(v.get(k))
                if n is not None:
                    out[k] = n
            if v.get("siteName"):
                out["siteName"] = str(v["siteName"])[:200]
            if v.get("siteId"):
                out["siteId"] = str(v["siteId"])[:80]
            at = _iso_moment(v.get("at"))
            if at:
                out["at"] = at
            return out
        return v
    if isinstance(v, str):
        return v[:MAX_TEXT]
    return v


def _iso_moment(v) -> str:
    """When a location was taken, as the ISO text the browser sent, or ''
    when it is not an ISO moment."""
    if not isinstance(v, str) or not v.strip() or len(v) > 40:
        return ""
    text = v.strip()
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    return text


# ── Validate ──────────────────────────────────────────────────────────────

def _bound(v):
    """A stored validation limit as a number, or None - a limit saved before
    the template check (text, a list) is no limit, never a 500."""
    if v in (None, "") or isinstance(v, bool):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _check_value(d: dict, v) -> str:
    """Why a non-blank value is wrong for its field, or ''."""
    ftype = d.get("type")
    label = _label(d)
    validation = d.get("validation") if isinstance(d.get("validation"), dict) else {}
    if ftype in ("number", "currency"):
        n = _number(v)
        if n is None:
            return f'"{label}" needs to be a number'
        lo, hi = _bound(validation.get("min")), _bound(validation.get("max"))
        if lo is not None and n < lo:
            return f'"{label}" must be at least {validation["min"]}'
        if hi is not None and n > hi:
            return f'"{label}" must be at most {validation["max"]}'
    elif ftype == "rating":
        n = _number(v)
        if n is None or not float(n).is_integer() or not 1 <= int(n) <= 5:
            return f'"{label}" needs a rating from 1 to 5'
    elif ftype == "yesno" or ftype == "checkbox":
        if _yes(v) is None:
            return f'"{label}" needs Yes or No'
    elif ftype == "email":
        if not isinstance(v, str) or not _EMAIL_RE.match(v.strip()):
            return f'"{label}" needs a valid email address'
    elif ftype == "date":
        try:
            date.fromisoformat(str(v).strip()[:10])
        except ValueError:
            return f'"{label}" needs a valid date'
    elif ftype == "time":
        if not isinstance(v, str) or not _TIME_RE.match(v.strip()):
            return f'"{label}" needs a valid time'
    elif ftype in ("dropdown", "radio"):
        options = [str(o) for o in (d.get("options") or [])]
        if options and str(v) not in options:
            return f'"{label}" must be one of its choices'
    elif ftype == "photo":
        if not isinstance(v, list) or not all(isinstance(u, str) for u in v):
            return f'"{label}" needs a list of photo URLs'
        if len(v) > MAX_PHOTOS:
            return f'"{label}" can hold at most {MAX_PHOTOS} photos'
    elif ftype in ("signature", "image", "file", "scan"):
        if not isinstance(v, str):
            return f'"{label}" needs text'
    elif ftype == "gps":
        if not isinstance(v, dict) or _number(v.get("lat")) is None or _number(v.get("lng")) is None:
            return f'"{label}" needs a location (lat and lng)'
        if not (-90 <= float(v["lat"]) <= 90 and -180 <= float(v["lng"]) <= 180):
            return f'"{label}" location is out of range'
    elif ftype in ("text", "multiline", "address", "person"):
        if not isinstance(v, str):
            return f'"{label}" needs text'
        max_len = _bound(validation.get("maxLength"))
        if max_len is not None and len(v) > int(max_len):
            return f'"{label}" must be {validation["maxLength"]} characters or fewer'
        regex = validation.get("regex")
        if regex:
            try:
                if not re.fullmatch(str(regex), v):
                    return f'"{label}" is not in the expected format'
            except re.error:
                pass
    return ""


def _validate_scope(defs: list, answers: dict, token_prefix: str = "") -> list:
    """Required + format complaints for the non-repeating fields in `defs`
    against `answers` (a form's, or one repeat row's)."""
    out = []
    shown = visible_tokens(defs, answers)
    for d in defs:
        token = d.get("token")
        if not token or token not in shown or d.get("formula"):
            continue
        v = answers.get(token)
        if is_blank(v):
            if d.get("required"):
                out.append({"token": token_prefix + token, "message": f'"{_label(d)}" is required'})
            continue
        msg = _check_value(d, v)
        if msg:
            out.append({"token": token_prefix + token, "message": msg})
    return out


def validate(defs: list, answers: dict) -> list:
    """Every complaint about `answers` (already cleaned), or []."""
    answers = answers if isinstance(answers, dict) else {}
    by_group = groups(defs)
    singles = [d for d in defs or [] if not group_of(d)]
    out = _validate_scope(singles, answers)
    for g, members in by_group.items():
        rows = answers.get(g)
        if rows is None:
            rows = []
        if not isinstance(rows, list):
            out.append({"token": g, "message": f'"{g}" needs a list of rows'})
            continue
        if not rows and any(d.get("required") for d in members):
            label = members[0].get("section") or g.replace("_", " ").title()
            out.append({"token": g, "message": f'"{label}" needs at least one row'})
            continue
        if len(rows) > _repeat_max(members):
            out.append({"token": g, "message": f'"{g}" can have at most {_repeat_max(members)} rows'})
            continue
        for i, row in enumerate(rows):
            if not isinstance(row, dict):
                out.append({"token": f"{g}[{i}]", "message": f'"{g}" row {i + 1} is not a set of answers'})
                continue
            out.extend(_validate_scope(members, {**answers, **row}, f"{g}[{i}]."))
    return out


# ── Formulas ──────────────────────────────────────────────────────────────

class _Env:
    """`{Name}` lookups for one evaluation: the row's answers first, then the
    form's; a name matches a field's label or token."""

    def __init__(self, defs: list, answers: dict, row: dict | None = None, today: date | None = None):
        self.by_key = {}
        for d in defs:
            for name in (d.get("label"), d.get("token")):
                if name:
                    self.by_key.setdefault(task_formula.field_key(str(name)), d)
        self.answers = answers
        self.row = row or {}
        self.today = today or date.today()

    def field(self, name: str):
        d = self.by_key.get(task_formula.field_key(name))
        if d is None:
            raise FormulaError(f"No field named {{{name}}}.")
        token = d["token"]
        v = self.row.get(token) if token in self.row else self.answers.get(token)
        if is_blank(v):
            return None
        if d.get("type") == "date" and isinstance(v, str):
            try:
                return date.fromisoformat(v.strip()[:10])
            except ValueError:
                return v
        if d.get("type") in ("number", "currency", "rating"):
            n = _number(v)
            return v if n is None else n
        if d.get("type") in ("yesno", "checkbox"):
            y = _yes(v)
            return v if y is None else y
        if isinstance(v, (list, dict)):
            return _as_text(len(v))
        return v


def _to_num(v) -> float:
    if is_blank(v):
        return 0
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, date):
        raise FormulaError("Expected a number but got a date.")
    n = _number(v)
    if n is None:
        raise FormulaError(f'Expected a number but got text "{str(v)[:24]}".')
    return n


def _to_day(v):
    if is_blank(v):
        return None
    if isinstance(v, date):
        return v
    if isinstance(v, str):
        try:
            return date.fromisoformat(v.strip()[:10])
        except ValueError:
            pass
    raise FormulaError("Expected a date.")


def _to_text(v) -> str:
    if is_blank(v):
        return ""
    if isinstance(v, bool):
        return "True" if v else "False"
    if isinstance(v, (int, float)):
        return _as_text(float(f"{v:.12g}"))
    if isinstance(v, date):
        return v.strftime("%m/%d/%Y")
    s = str(v)
    if len(s) > MAX_TEXT:
        raise FormulaError("Text is too long (over 10,000 characters).")
    return s


def _truthy(v) -> bool:
    if is_blank(v):
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    return True


def _looks_numeric(v) -> bool:
    return isinstance(v, (int, float, bool)) or (isinstance(v, str) and _number(v) is not None)


def _round(x: float, places) -> float:
    p = max(-10, min(10, int(places)))
    q = round(abs(x), p)
    return -q if x < 0 else q


def _shift_days(v) -> int:
    """Days to move a date by: a number within MAX_DATE_SHIFT_DAYS."""
    n = _to_num(v)
    if not math.isfinite(n) or abs(n) > MAX_DATE_SHIFT_DAYS:
        raise FormulaError("A date can move at most 36,500 days.")
    return int(n)


def _arith(op, a, b):
    da, db_ = isinstance(a, date), isinstance(b, date)
    if op in ("+", "-"):
        if da or db_:
            if is_blank(a) or is_blank(b):
                return None
            if da and db_:
                if op == "-":
                    return (a - b).days
                raise FormulaError("Two dates cannot be added - subtract them to get days.")
            if da:
                return a + timedelta(days=_shift_days(b) * (1 if op == "+" else -1))
            if op == "+":
                return b + timedelta(days=_shift_days(a))
            raise FormulaError("A date cannot be subtracted from a number.")
        if is_blank(a) and is_blank(b):
            return None
        return _to_num(a) + _to_num(b) if op == "+" else _to_num(a) - _to_num(b)
    if da or db_:
        raise FormulaError(f"Dates cannot be used with {op}.")
    if is_blank(a) and is_blank(b):
        return None
    x, y = _to_num(a), _to_num(b)
    if op in ("/", "%") and y == 0:
        raise FormulaError("Division by zero.")
    if op == "*":
        return x * y
    if op == "/":
        return x / y
    return math.fmod(x, y)


def _compare(op, a, b):
    x, y = a, b
    ba, bb = is_blank(a), is_blank(b)
    if ba and bb:
        x = y = 0
    elif ba or bb:
        other = b if ba else a
        if isinstance(other, date):
            return op == "!="
        blank_as = 0 if _looks_numeric(other) else ""
        if ba:
            x = blank_as
        else:
            y = blank_as
    if isinstance(x, date) or isinstance(y, date):
        c = (_to_day(x) - _to_day(y)).days
    elif _looks_numeric(x) and _looks_numeric(y):
        c = _to_num(x) - _to_num(y)
    elif isinstance(x, str) and isinstance(y, str):
        p, q = x.lower(), y.lower()
        c = -1 if p < q else (1 if p > q else 0)
    elif op in ("=", "!="):
        c = 1
    else:
        raise FormulaError("These values cannot be compared.")
    return {"=": c == 0, "!=": c != 0, "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0}[op]


def _workdays_inclusive(a: date, b: date) -> int:
    """Monday-Friday days from a to b, both counted - worked out, not walked,
    so a range of thousands of years costs nothing."""
    if b < a:
        return 0
    total = (b - a).days + 1
    weeks, rest = divmod(total, 7)
    start = a.weekday()
    return weeks * 5 + sum(1 for i in range(rest) if (start + i) % 7 < 5)


def _numbers_of(values) -> list:
    out = []
    for v in values:
        if is_blank(v):
            continue
        if isinstance(v, date):
            raise FormulaError("Expected a number but got a date.")
        out.append(_to_num(v))
    return out


def _eval(node, env: _Env):
    kind = node[0]
    if kind in ("num", "str", "bool"):
        return node[1]
    if kind == "field":
        return env.field(node[1])
    if kind == "un":
        v = _eval(node[2], env)
        if is_blank(v):
            return None
        if isinstance(v, date):
            raise FormulaError("A date cannot be made negative.")
        return -_to_num(v) if node[1] == "-" else _to_num(v)
    if kind == "bin":
        op, a, b = node[1], _eval(node[2], env), _eval(node[3], env)
        if op == "&":
            return _to_text(_to_text(a) + _to_text(b))
        if op in task_formula._COMPARE:
            return _compare(op, a, b)
        return _arith(op, a, b)
    if kind == "call":
        return _call(node[1], node[2], env)
    raise FormulaError("This formula could not be read.")


def _call(fn: str, args: list, env: _Env):
    ev = lambda i: _eval(args[i], env)  # noqa: E731
    if fn == "SUM":
        return sum(_numbers_of([_eval(a, env) for a in args]))
    if fn == "AVG":
        xs = _numbers_of([_eval(a, env) for a in args])
        return sum(xs) / len(xs) if xs else None
    if fn in ("MIN", "MAX"):
        vals = [v for v in (_eval(a, env) for a in args) if not is_blank(v)]
        if not vals:
            return None
        pick = min if fn == "MIN" else max
        if all(isinstance(v, date) for v in vals):
            return pick(vals)
        return pick(_numbers_of(vals))
    if fn == "ROUND":
        x = ev(0)
        if is_blank(x):
            return None
        return _round(_to_num(x), _to_num(ev(1)) if len(args) > 1 else 0)
    if fn == "ABS":
        x = ev(0)
        return None if is_blank(x) else abs(_to_num(x))
    if fn == "IF":
        return ev(1) if _truthy(ev(0)) else (ev(2) if len(args) > 2 else None)
    if fn == "AND":
        return all(_truthy(ev(i)) for i in range(len(args)))
    if fn == "OR":
        return any(_truthy(ev(i)) for i in range(len(args)))
    if fn == "NOT":
        return not _truthy(ev(0))
    if fn == "ISBLANK":
        return is_blank(ev(0))
    if fn == "DAYS":
        end, start = _to_day(ev(0)), _to_day(ev(1))
        return None if end is None or start is None else (end - start).days
    if fn == "TODAY":
        return env.today
    if fn == "WORKDAYS":
        a, b = _to_day(ev(0)), _to_day(ev(1))
        if a is None or b is None:
            return None
        return _workdays_inclusive(a, b) if a <= b else -_workdays_inclusive(b, a)
    if fn == "CONCAT":
        return _to_text("".join(_to_text(_eval(a, env)) for a in args))
    if fn == "UPPER":
        return _to_text(ev(0)).upper()
    if fn == "LOWER":
        return _to_text(ev(0)).lower()
    raise FormulaError(f"Unknown function {fn}.")


def run_formula(src: str, env: _Env):
    """The value of one expression, or None when it cannot be worked out
    (the browser shows the reason; the server stores a blank)."""
    try:
        v = _eval(task_formula.parse(src), env)
    except (FormulaError, OverflowError, ValueError, ZeroDivisionError, RecursionError):
        # a value no formula can hold (a date past year 9999, a huge power)
        # is a blank answer, never a 500
        return None
    if isinstance(v, float):
        if not math.isfinite(v):
            return None
        return int(v) if v.is_integer() else v
    if isinstance(v, date):
        return v.isoformat()
    return v


def compute(defs: list, answers: dict, *, today: date | None = None) -> dict:
    """`answers` with every formula field filled in (a copy): the form's
    single fields, then each repeat row's. A formula field hidden by its
    showIf (on the form, or in that row) is not worked out and holds no
    value - the same visibility clean() applies."""
    answers = dict(answers or {})
    by_group = groups(defs)
    singles = [d for d in defs or [] if not group_of(d)]
    shown = visible_tokens(defs, answers)
    env = _Env(defs, answers, today=today)
    for d in singles:
        if d.get("formula"):
            if d["token"] in shown:
                answers[d["token"]] = run_formula(d["formula"], env)
            else:
                answers.pop(d["token"], None)
    for g, members in by_group.items():
        rows = answers.get(g)
        if not isinstance(rows, list):
            continue
        new_rows = []
        for row in rows:
            row = dict(row) if isinstance(row, dict) else {}
            row_shown = visible_tokens(members, {**answers, **row})
            env = _Env(defs, answers, row=row, today=today)
            for d in members:
                if d.get("formula"):
                    if d["token"] in row_shown:
                        row[d["token"]] = run_formula(d["formula"], env)
                    else:
                        row.pop(d["token"], None)
            new_rows.append(row)
        answers[g] = new_rows
    return answers


def sections(defs: list) -> list:
    """The section headings in the order they first appear."""
    out = []
    for d in defs or []:
        s = d.get("section")
        if s and s not in out:
            out.append(s)
    return out
