"""Formula columns for tasks (Neil, Oct 22 2026) - the server half.

A formula field is a TaskCustomField of type "formula": its expression is
stored on the field definition (`formula`) and its value is COMPUTED, never
stored per task. The browser evaluates it (frontend/src/tasks/formula.js);
this module only checks an expression before it is saved, so a formula that
cannot run, names a field that does not exist or loops through another
formula never reaches anyone's list.

The grammar is the same as the browser's, written out twice on purpose - the
two are pinned together by the shared cases file
(frontend/src/tasks/formula.cases.json), which both test suites read.

    expr       := comparison
    comparison := concat ( ("=" | "!=" | "<>" | "<" | "<=" | ">" | ">=") concat )*
    concat     := additive ( "&" additive )*
    additive   := term ( ("+" | "-") term )*
    term       := unary ( ("*" | "/" | "%") unary )*
    unary      := ("-" | "+") unary | primary
    primary    := NUMBER | STRING | FIELD | TRUE | FALSE
                | NAME "(" [ expr ( "," expr )* ] ")" | "(" expr ")"

    NUMBER  12  3.5  .5      STRING  "text" with \\" and \\\\ escapes
    FIELD   {Field Name}     NAME    a function name (case-insensitive)

Nothing here ever evaluates anything - no eval, no exec, no attribute access.
A name is either one of the fixed FUNCTIONS below or an error.
"""
from __future__ import annotations

MAX_LENGTH = 2000        # characters in one expression
MAX_TOKENS = 600
MAX_DEPTH = 40           # nesting of parentheses / calls / unary signs
MAX_NAME = 120           # characters inside {...}
MAX_STRING = 500         # characters in one "string"

# The task's own fields a formula can name, in braces like a custom field.
# Only what the task model really carries (routers/tasks.py task_to_dict):
# {Completed} is the day it was completed (blank while open); {Progress} is
# the share of its subtasks that are done, 0 to 1.
BUILTIN_FIELDS = (
    "Estimate Hours", "Time Tracked Hours", "Due Date", "Start Date", "Created",
    "Completed", "Subtask Count", "Completed Subtasks", "Progress",
)
_BUILTIN_KEYS = {n.lower() for n in BUILTIN_FIELDS}

# name -> (min args, max args or None for "any number")
FUNCTIONS = {
    "SUM": (1, None), "MIN": (1, None), "MAX": (1, None), "AVG": (1, None),
    "ROUND": (1, 2), "ABS": (1, 1), "IF": (2, 3), "AND": (1, None), "OR": (1, None),
    "NOT": (1, 1), "ISBLANK": (1, 1), "DAYS": (2, 2), "TODAY": (0, 0),
    "WORKDAYS": (2, 2), "CONCAT": (1, None), "UPPER": (1, 1), "LOWER": (1, 1),
}

RESULT_FORMATS = ("number", "currency", "percent", "date", "text")
MAX_DECIMALS = 6

_COMPARE = ("=", "!=", "<>", "<", "<=", ">", ">=")
# ASCII only: str.isdigit() also takes other scripts' digits, which the
# browser's grammar does not.
_DIGITS = "0123456789"


class FormulaError(ValueError):
    """An expression that cannot be saved. `str(e)` is the sentence shown."""

    def __init__(self, message: str, pos: int | None = None):
        super().__init__(message)
        self.pos = pos


def field_key(name) -> str:
    """How field names compare: trimmed, case-insensitive, inner runs of
    spaces collapsed - {Budget}, { budget } and {BUDGET} are one field."""
    return " ".join(str(name or "").split()).lower()


def is_builtin(name) -> bool:
    return field_key(name) in _BUILTIN_KEYS


# ── Tokenizer ──────────────────────────────────────────────────────────────
def tokenize(src: str) -> list:
    """[(kind, value, start, end)] - kind is num/str/field/name/op/eof."""
    if src is None:
        src = ""
    if not isinstance(src, str):
        raise FormulaError("A formula must be text.")
    if len(src) > MAX_LENGTH:
        raise FormulaError(f"A formula can be at most {MAX_LENGTH} characters.")
    out = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in " \t\r\n":
            i += 1
            continue
        start = i
        if c in _DIGITS or (c == "." and i + 1 < n and src[i + 1] in _DIGITS):
            seen_dot = False
            while i < n and (src[i] in _DIGITS or (src[i] == "." and not seen_dot)):
                if src[i] == ".":
                    seen_dot = True
                i += 1
            text = src[start:i]
            if i < n and (src[i].isalpha() or src[i] == "_"):
                raise FormulaError(f"Unexpected \"{src[i]}\" after a number.", i)
            out.append(("num", float(text), start, i))
            continue
        if c == '"':
            i += 1
            buf = []
            while True:
                if i >= n:
                    raise FormulaError("A text value is missing its closing quote.", start)
                ch = src[i]
                if ch == "\\" and i + 1 < n and src[i + 1] in ('"', "\\"):
                    buf.append(src[i + 1])
                    i += 2
                    continue
                if ch == '"':
                    i += 1
                    break
                buf.append(ch)
                i += 1
            if len(buf) > MAX_STRING:
                raise FormulaError(f"A text value can be at most {MAX_STRING} characters.", start)
            out.append(("str", "".join(buf), start, i))
            continue
        if c == "{":
            close = src.find("}", i + 1)
            if close == -1:
                raise FormulaError("A field name is missing its closing }.", start)
            inner = src[i + 1:close]
            if "{" in inner:
                raise FormulaError("Field names cannot contain {.", start)
            name = " ".join(inner.split())
            if not name:
                raise FormulaError("Empty field name {}.", start)
            if len(name) > MAX_NAME:
                raise FormulaError(f"A field name can be at most {MAX_NAME} characters.", start)
            i = close + 1
            out.append(("field", name, start, i))
            continue
        if c.isalpha() or c == "_":
            while i < n and (src[i].isalnum() or src[i] == "_"):
                i += 1
            out.append(("name", src[start:i], start, i))
            continue
        two = src[i:i + 2]
        if two in ("<=", ">=", "!=", "<>"):
            out.append(("op", two, start, i + 2))
            i += 2
            continue
        if c in "+-*/%&=<>(),":
            out.append(("op", c, start, i + 1))
            i += 1
            continue
        if c == "}":
            raise FormulaError("Unexpected } - field names go inside {braces}.", i)
        raise FormulaError(f"Unexpected \"{c}\".", i)
    if len(out) > MAX_TOKENS:
        raise FormulaError("This formula is too long.")
    out.append(("eof", None, n, n))
    return out


# ── Parser ─────────────────────────────────────────────────────────────────
class _Parser:
    def __init__(self, tokens):
        self.toks = tokens
        self.i = 0
        self.depth = 0

    def peek(self):
        return self.toks[self.i]

    def take(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def is_op(self, *ops):
        t = self.peek()
        return t[0] == "op" and t[1] in ops

    def expect(self, op):
        t = self.peek()
        if t[0] != "op" or t[1] != op:
            raise FormulaError(f"Expected \"{op}\" {_where(t)}.", t[2])
        return self.take()

    def nest(self):
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise FormulaError("This formula is nested too deeply.", self.peek()[2])

    def unnest(self):
        self.depth -= 1

    def expr(self):
        self.nest()
        try:
            return self.comparison()
        finally:
            self.unnest()

    def comparison(self):
        node = self.concat()
        while self.is_op(*_COMPARE):
            op = self.take()[1]
            node = ("bin", "!=" if op == "<>" else op, node, self.concat())
        return node

    def concat(self):
        node = self.additive()
        while self.is_op("&"):
            self.take()
            node = ("bin", "&", node, self.additive())
        return node

    def additive(self):
        node = self.term()
        while self.is_op("+", "-"):
            op = self.take()[1]
            node = ("bin", op, node, self.term())
        return node

    def term(self):
        node = self.unary()
        while self.is_op("*", "/", "%"):
            op = self.take()[1]
            node = ("bin", op, node, self.unary())
        return node

    def unary(self):
        if self.is_op("-", "+"):
            op = self.take()[1]
            self.nest()
            try:
                return ("un", op, self.unary())
            finally:
                self.unnest()
        return self.primary()

    def primary(self):
        t = self.peek()
        kind, val = t[0], t[1]
        if kind == "num":
            self.take()
            return ("num", val)
        if kind == "str":
            self.take()
            return ("str", val)
        if kind == "field":
            self.take()
            return ("field", val)
        if kind == "name":
            self.take()
            upper = val.upper()
            if upper in ("TRUE", "FALSE") and not self.is_op("("):
                return ("bool", upper == "TRUE")
            if upper not in FUNCTIONS:
                raise FormulaError(f"Unknown function {val}.", t[2])
            if not self.is_op("("):
                raise FormulaError(f"{upper} needs parentheses, like {upper}(...).", t[3])
            self.take()
            args = []
            if not self.is_op(")"):
                args.append(self.expr())
                while self.is_op(","):
                    self.take()
                    args.append(self.expr())
            self.expect(")")
            lo, hi = FUNCTIONS[upper]
            if len(args) < lo or (hi is not None and len(args) > hi):
                raise FormulaError(f"{upper} takes {_arity(lo, hi)}.", t[2])
            return ("call", upper, args)
        if kind == "op" and val == "(":
            self.take()
            node = self.expr()
            self.expect(")")
            return node
        if kind == "eof":
            raise FormulaError("The formula ends too soon.", t[2])
        raise FormulaError(f"Unexpected \"{val}\".", t[2])


def _arity(lo, hi) -> str:
    if hi is None:
        return f"at least {lo} value{'s' if lo != 1 else ''}"
    if lo == hi:
        return "no values" if lo == 0 else f"{lo} value{'s' if lo != 1 else ''}"
    return f"{lo} or {hi} values"


def _where(tok) -> str:
    return "at the end" if tok[0] == "eof" else f"before \"{tok[1]}\""


def parse(src: str):
    """The expression as a tuple tree. Raises FormulaError."""
    toks = tokenize(src)
    if toks[0][0] == "eof":
        raise FormulaError("Enter a formula.")
    p = _Parser(toks)
    node = p.expr()
    end = p.peek()
    if end[0] != "eof":
        raise FormulaError(f"Unexpected \"{end[1]}\".", end[2])
    return node


def field_refs(src: str) -> list:
    """Every {Field} the expression names, as written (deduplicated by key).
    Tokenizing is enough - a field token is a field wherever it sits."""
    seen, out = set(), []
    for kind, val, _s, _e in tokenize(src):
        if kind == "field" and field_key(val) not in seen:
            seen.add(field_key(val))
            out.append(val)
    return out


def rename_refs(src: str, old: str, new: str) -> str:
    """`src` with every {old} reference renamed to {new} - only field tokens,
    never the same text inside a "string". Unparseable input is returned as
    it was (it cannot have been saved, so there is nothing to keep in step)."""
    try:
        toks = tokenize(src)
    except FormulaError:
        return src
    key = field_key(old)
    out, last = [], 0
    for kind, val, s, e in toks:
        if kind == "field" and field_key(val) == key:
            out.append(src[last:s])
            out.append("{" + new + "}")
            last = e
    out.append(src[last:])
    return "".join(out)


def normalize_format(raw) -> dict:
    """{format, decimals} with anything unknown put back to the default.
    A number or currency defaults to 2 decimals, everything else to 0. For a
    number the decimals are the most shown; a currency or percent always
    shows exactly that many (tasks/formula.js formatFormulaValue)."""
    raw = raw if isinstance(raw, dict) else {}
    fmt = str(raw.get("format") or "number").lower()
    if fmt not in RESULT_FORMATS:
        fmt = "number"
    try:
        dec = int(raw.get("decimals"))
    except (TypeError, ValueError):
        dec = 2 if fmt in ("number", "currency") else 0
    return {"format": fmt, "decimals": max(0, min(MAX_DECIMALS, dec))}


def validate(src: str, *, self_name: str, field_names, formula_fields) -> list:
    """Check `src` before it is saved on the formula field named `self_name`.

    `field_names` - the names of every custom field the formula may refer to.
    `formula_fields` - {name: expression} of the OTHER formula fields among
    them, for the circular-reference check.

    Returns the field names the formula refers to. Raises FormulaError with
    the sentence to show. A built-in field name always resolves to the
    built-in (BUILTIN_FIELDS), whatever custom field shares it."""
    parse(src)
    known = {field_key(n) for n in (field_names or []) if n}
    refs = field_refs(src)
    me = field_key(self_name)
    for name in refs:
        if is_builtin(name):
            continue
        if field_key(name) == me:
            raise FormulaError(f"A formula cannot refer to itself ({{{name}}}).")
        if field_key(name) not in known:
            raise FormulaError(f"Unknown field {{{name}}}.")
    # Circular references: walk formula -> the formulas it names. Two fields
    # can share a name (different projects), so a name stands for all of
    # them - the conservative reading, which can only refuse more.
    graph: dict = {}
    for name, expr in (formula_fields or {}).items():
        try:
            names = {field_key(r) for r in field_refs(expr or "") if not is_builtin(r)}
        except FormulaError:
            names = set()
        graph.setdefault(field_key(name), set()).update(names)
    graph[me] = {field_key(r) for r in refs if not is_builtin(r)}

    path: list = []
    state: dict = {}

    def visit(node):
        if state.get(node) == 1:
            loop = path[path.index(node):] + [node]
            raise FormulaError("Circular reference: " + " -> ".join(f"{{{_display(n, refs, formula_fields, self_name)}}}"
                                                                     for n in loop) + ".")
        if state.get(node) == 2:
            return
        state[node] = 1
        path.append(node)
        for nxt in sorted(graph.get(node, ())):
            if nxt in graph:
                visit(nxt)
        path.pop()
        state[node] = 2

    visit(me)
    return refs


def _display(key, refs, formula_fields, self_name) -> str:
    """The name as someone typed it, for the circular-reference message."""
    for n in [self_name, *refs, *(formula_fields or {}).keys()]:
        if field_key(n) == key:
            return " ".join(str(n).split())
    return key
