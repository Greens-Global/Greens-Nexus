// Task Module - formula columns (Neil, Oct 22 2026).
//
// A formula field is a custom field of type "formula": its expression lives on
// the field definition (field.formula, field.formulaFormat) and its value is
// worked out HERE, per task, every time it is shown - never stored on a task.
// One module so the list, the drawer, sorting, filtering, totals and the
// exports all read the same value.
//
// The grammar is the server's (backend/task_formula.py), written twice on
// purpose and pinned together by formula.cases.json, which both test suites
// read. The server checks an expression before it is saved; this side still
// treats every expression as untrusted text - it is tokenized and walked, never
// handed to eval/Function, and a name is either one of FUNCTIONS or an error.
// Field values are looked up by walking the field list, never by indexing an
// object with a user-typed name ({__proto__} is just an unknown field).
//
// A formula that cannot be worked out for a row (division by zero, text where a
// number belongs) gives { error } for that row only - the cell shows a muted
// "#Error" with the reason, and nothing else on the list is affected.
import { formatDate } from '../lib/datetime';
import { emailToName } from '../lib/utils';
import { localISO, todayISO, fieldsForTask } from './lib';

export const MAX_LENGTH = 2000;
const MAX_TOKENS = 600;
const MAX_DEPTH = 40;
const MAX_NAME = 120;     // code points, as Python counts them
const MAX_STRING = 500;
// The longest text a formula may build (Oct 22 2026 review): a chain of
// formulas each joining the last one many times over would otherwise grow
// without bound and freeze the list.
export const MAX_TEXT = 10000;
const codePoints = (s) => Array.from(s).length;

// The task's own fields, named in braces like a custom field. Only what the
// task really carries; a built-in name wins over a custom field that shares it.
export const BUILTIN_FIELDS = [
  { name: 'Estimate Hours', help: 'The time estimate, in hours' },
  { name: 'Time Tracked Hours', help: 'Hours tracked against the task' },
  { name: 'Due Date', help: 'The due date' },
  { name: 'Start Date', help: 'The start date' },
  { name: 'Created', help: 'The day the task was created' },
  { name: 'Completed', help: 'The day it was completed (blank while open)' },
  { name: 'Subtask Count', help: 'How many subtasks it has' },
  { name: 'Completed Subtasks', help: 'How many of them are done' },
  { name: 'Progress', help: 'Share of subtasks done, 0 to 1 (a task with none is 1 once completed)' },
];

// name -> [min args, max args (null = any)]. A Map, so a typed name can never
// reach an Object.prototype member.
const FUNCTIONS = new Map([
  ['SUM', [1, null]], ['MIN', [1, null]], ['MAX', [1, null]], ['AVG', [1, null]],
  ['ROUND', [1, 2]], ['ABS', [1, 1]], ['IF', [2, 3]], ['AND', [1, null]], ['OR', [1, null]],
  ['NOT', [1, 1]], ['ISBLANK', [1, 1]], ['DAYS', [2, 2]], ['TODAY', [0, 0]],
  ['WORKDAYS', [2, 2]], ['CONCAT', [1, null]], ['UPPER', [1, 1]], ['LOWER', [1, 1]],
]);

// For the editor's syntax help.
export const FORMULA_FUNCTIONS = [
  { sig: 'SUM(a, b, …)', help: 'Adds numbers; blanks are skipped' },
  { sig: 'AVG(a, b, …)', help: 'Average of the numbers given' },
  { sig: 'MIN(a, b, …) / MAX(a, b, …)', help: 'Smallest / largest number or date' },
  { sig: 'ROUND(x, places)', help: 'Rounds to that many decimals (0 if left out)' },
  { sig: 'ABS(x)', help: 'The number without its sign' },
  { sig: 'IF(test, then, else)', help: 'Picks a value; only the chosen side is worked out' },
  { sig: 'AND(…) / OR(…) / NOT(x)', help: 'True/false logic' },
  { sig: 'ISBLANK(x)', help: 'True when x is empty' },
  { sig: 'DAYS(end, start)', help: 'Days from start to end' },
  { sig: 'WORKDAYS(start, end)', help: 'Monday to Friday days from start to end, both counted' },
  { sig: 'TODAY()', help: "Today's date" },
  { sig: 'CONCAT(a, b, …)', help: 'Joins values as text (same as &)' },
  { sig: 'UPPER(x) / LOWER(x)', help: 'Changes the case of text' },
];

export const FORMULA_OPERATORS = [
  { sig: '+  -  *  /  %', help: 'Math (% is the remainder); date - date = days, date + number = date' },
  { sig: '=  !=  <  <=  >  >=', help: 'Comparisons, giving true or false' },
  { sig: '&', help: 'Joins text: {First} & " " & {Last}' },
  { sig: '{Field Name}', help: 'A field, by its name in braces' },
  { sig: '"text"', help: 'Text in double quotes' },
];

export const RESULT_FORMATS = [
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'date', label: 'Date' },
  { value: 'text', label: 'Text' },
];
const FORMAT_KEYS = RESULT_FORMATS.map((f) => f.value);
const MAX_DECIMALS = 6;

/** {format, decimals} with anything unknown put back to the default - the
 *  server's normalize_format. */
export function normalizeFormat(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const format = FORMAT_KEYS.includes(String(r.format || '').toLowerCase()) ? String(r.format).toLowerCase() : 'number';
  let decimals = parseInt(r.decimals, 10);
  if (!Number.isFinite(decimals)) decimals = format === 'number' || format === 'currency' ? 2 : 0;
  return { format, decimals: Math.max(0, Math.min(MAX_DECIMALS, decimals)) };
}

export class FormulaError extends Error {}

/** How field names compare: trimmed, case-insensitive, runs of spaces as one. */
export const fieldKey = (name) => String(name ?? '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();
const BUILTIN_KEYS = new Set(BUILTIN_FIELDS.map((b) => fieldKey(b.name)));
export const isBuiltinField = (name) => BUILTIN_KEYS.has(fieldKey(name));

/** Why `name` cannot be a custom field's name, or '' - the server's
 *  field_name_problem: braces would end a {reference} early. A built-in
 *  field's name is fine on an ordinary field (formulas read the built-in). */
export function fieldNameProblem(name) {
  const n = String(name ?? '');
  if (n.includes('{') || n.includes('}')) return 'A field name cannot contain { or }.';
  return '';
}

/** The same for a FORMULA column (the server's formula_name_problem): not a
 *  built-in field's name either, or other formulas could never read it. */
export function formulaNameProblem(name) {
  const problem = fieldNameProblem(name);
  if (problem) return problem;
  if (isBuiltinField(name)) return `"${String(name).split(/\s+/).filter(Boolean).join(' ')}" is a built-in field name - pick another for a formula column.`;
  return '';
}

/** A hint (never a refusal) for an ordinary field named like a built-in. */
export const builtinNameHint = (name) => (isBuiltinField(name)
  ? `Formulas read {${String(name).split(/\s+/).filter(Boolean).join(' ')}} as the built-in field, not this one.` : '');

// ── Tokenizer ────────────────────────────────────────────────────────────────
const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => /^[\p{L}_]$/u.test(c);
const isAlnum = (c) => /^[\p{L}\p{N}_]$/u.test(c);
const WS = ' \t\r\n';
const SINGLE_OPS = '+-*/%&=<>(),';

function tokenize(src) {
  if (src == null) src = '';
  if (typeof src !== 'string') throw new FormulaError('A formula must be text.');
  if (src.length > MAX_LENGTH && Array.from(src).length > MAX_LENGTH) {
    throw new FormulaError(`A formula can be at most ${MAX_LENGTH} characters.`);
  }
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (WS.includes(c)) { i += 1; continue; }
    const start = i;
    if (isDigit(c) || (c === '.' && i + 1 < n && isDigit(src[i + 1]))) {
      let dot = false;
      while (i < n && (isDigit(src[i]) || (src[i] === '.' && !dot))) { if (src[i] === '.') dot = true; i += 1; }
      if (i < n && isAlpha(src[i])) throw new FormulaError(`Unexpected "${src[i]}" after a number.`);
      out.push({ k: 'num', v: Number(src.slice(start, i)) });
      continue;
    }
    if (c === '"') {
      i += 1;
      let buf = '';
      for (;;) {
        if (i >= n) throw new FormulaError('A text value is missing its closing quote.');
        const ch = src[i];
        if (ch === '\\' && i + 1 < n && (src[i + 1] === '"' || src[i + 1] === '\\')) { buf += src[i + 1]; i += 2; continue; }
        if (ch === '"') { i += 1; break; }
        buf += ch; i += 1;
      }
      if (codePoints(buf) > MAX_STRING) throw new FormulaError(`A text value can be at most ${MAX_STRING} characters.`);
      out.push({ k: 'str', v: buf });
      continue;
    }
    if (c === '{') {
      const close = src.indexOf('}', i + 1);
      if (close === -1) throw new FormulaError('A field name is missing its closing }.');
      const inner = src.slice(i + 1, close);
      if (inner.includes('{')) throw new FormulaError('Field names cannot contain {.');
      const name = inner.split(/\s+/).filter(Boolean).join(' ');
      if (!name) throw new FormulaError('Empty field name {}.');
      if (codePoints(name) > MAX_NAME) throw new FormulaError(`A field name can be at most ${MAX_NAME} characters.`);
      i = close + 1;
      out.push({ k: 'field', v: name });
      continue;
    }
    if (isAlpha(c)) {
      while (i < n && isAlnum(src[i])) i += 1;
      out.push({ k: 'name', v: src.slice(start, i) });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>') { out.push({ k: 'op', v: two }); i += 2; continue; }
    if (SINGLE_OPS.includes(c)) { out.push({ k: 'op', v: c }); i += 1; continue; }
    if (c === '}') throw new FormulaError('Unexpected } - field names go inside {braces}.');
    throw new FormulaError(`Unexpected "${c}".`);
  }
  if (out.length > MAX_TOKENS) throw new FormulaError('This formula is too long.');
  out.push({ k: 'eof', v: null });
  return out;
}

// ── Parser ───────────────────────────────────────────────────────────────────
const COMPARE = new Set(['=', '!=', '<>', '<', '<=', '>', '>=']);
const fmtNumTok = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));   // mirrors Python's float repr
const tokText = (t) => (t.k === 'num' ? fmtNumTok(t.v) : t.v);

function arity(lo, hi) {
  if (hi === null) return `at least ${lo} value${lo !== 1 ? 's' : ''}`;
  if (lo === hi) return lo === 0 ? 'no values' : `${lo} value${lo !== 1 ? 's' : ''}`;
  return `${lo} or ${hi} values`;
}

function parseTokens(toks) {
  let i = 0;
  let depth = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const isOp = (...ops) => peek().k === 'op' && ops.includes(peek().v);
  const nest = () => { depth += 1; if (depth > MAX_DEPTH) throw new FormulaError('This formula is nested too deeply.'); };
  const expect = (op) => {
    const t = peek();
    if (t.k !== 'op' || t.v !== op) throw new FormulaError(`Expected "${op}" ${t.k === 'eof' ? 'at the end' : `before "${tokText(t)}"`}.`);
    return take();
  };
  function expr() { nest(); try { return comparison(); } finally { depth -= 1; } }
  function comparison() {
    let node = concat();
    while (peek().k === 'op' && COMPARE.has(peek().v)) {
      const op = take().v;
      node = { t: 'bin', op: op === '<>' ? '!=' : op, a: node, b: concat() };
    }
    return node;
  }
  function concat() {
    let node = additive();
    while (isOp('&')) { take(); node = { t: 'bin', op: '&', a: node, b: additive() }; }
    return node;
  }
  function additive() {
    let node = term();
    while (isOp('+', '-')) { const op = take().v; node = { t: 'bin', op, a: node, b: term() }; }
    return node;
  }
  function term() {
    let node = unary();
    while (isOp('*', '/', '%')) { const op = take().v; node = { t: 'bin', op, a: node, b: unary() }; }
    return node;
  }
  function unary() {
    if (isOp('-', '+')) {
      const op = take().v;
      nest();
      try { return { t: 'un', op, a: unary() }; } finally { depth -= 1; }
    }
    return primary();
  }
  function primary() {
    const tok = peek();
    if (tok.k === 'num') { take(); return { t: 'num', v: tok.v }; }
    if (tok.k === 'str') { take(); return { t: 'str', v: tok.v }; }
    if (tok.k === 'field') { take(); return { t: 'field', name: tok.v }; }
    if (tok.k === 'name') {
      take();
      const upper = tok.v.toUpperCase();
      if ((upper === 'TRUE' || upper === 'FALSE') && !isOp('(')) return { t: 'bool', v: upper === 'TRUE' };
      if (!FUNCTIONS.has(upper)) throw new FormulaError(`Unknown function ${tok.v}.`);
      if (!isOp('(')) throw new FormulaError(`${upper} needs parentheses, like ${upper}(...).`);
      take();
      const args = [];
      if (!isOp(')')) {
        args.push(expr());
        while (isOp(',')) { take(); args.push(expr()); }
      }
      expect(')');
      const [lo, hi] = FUNCTIONS.get(upper);
      if (args.length < lo || (hi !== null && args.length > hi)) throw new FormulaError(`${upper} takes ${arity(lo, hi)}.`);
      return { t: 'call', fn: upper, args };
    }
    if (tok.k === 'op' && tok.v === '(') { take(); const node = expr(); expect(')'); return node; }
    if (tok.k === 'eof') throw new FormulaError('The formula ends too soon.');
    throw new FormulaError(`Unexpected "${tokText(tok)}".`);
  }
  if (toks[0].k === 'eof') throw new FormulaError('Enter a formula.');
  const node = expr();
  if (peek().k !== 'eof') throw new FormulaError(`Unexpected "${tokText(peek())}".`);
  return node;
}

/** The expression as a tree. Throws FormulaError. */
export function parseFormula(src) {
  return parseTokens(tokenize(src));
}

// Parsed once per distinct expression - every row of a column shares one tree.
const parseCache = new Map();
function parsedOnce(src) {
  const key = String(src ?? '');
  let hit = parseCache.get(key);
  if (!hit) {
    try { hit = { ast: parseFormula(key) }; } catch (e) { hit = { error: e instanceof FormulaError ? e.message : 'This formula could not be read.' }; }
    if (parseCache.size > 500) parseCache.clear();
    parseCache.set(key, hit);
  }
  if (hit.error) throw new FormulaError(hit.error);
  return hit.ast;
}

/** Every {Field} named, as written, deduplicated by name. */
export function formulaFieldRefs(src) {
  const seen = new Set();
  const out = [];
  for (const t of tokenize(src)) {
    if (t.k === 'field' && !seen.has(fieldKey(t.v))) { seen.add(fieldKey(t.v)); out.push(t.v); }
  }
  return out;
}

/** The editor's check - the server's validate(): parses, every field exists,
 *  no field names itself, no loop through other formulas. Returns '' when
 *  it is fine, else the sentence to show. */
// formulaFields: {name: expression}, or [name, expression] pairs - pairs keep
// two same-named formula columns apart, so a loop through either is caught.
export function checkFormula(src, { selfName = '', fieldNames = [], formulaFields = {} } = {}) {
  try {
    parseFormula(src);
    const refs = formulaFieldRefs(src);
    const known = new Set(fieldNames.map(fieldKey));
    const me = fieldKey(selfName);
    for (const r of refs) {
      if (isBuiltinField(r)) continue;
      if (me && fieldKey(r) === me) return `A formula cannot refer to itself ({${r}}).`;
      if (!known.has(fieldKey(r))) return `Unknown field {${r}}.`;
    }
    const graph = new Map();
    for (const [name, expr] of (Array.isArray(formulaFields) ? formulaFields : Object.entries(formulaFields || {}))) {
      let names = [];
      try { names = formulaFieldRefs(expr || '').filter((x) => !isBuiltinField(x)).map(fieldKey); } catch { names = []; }
      graph.set(fieldKey(name), new Set([...(graph.get(fieldKey(name)) || []), ...names]));
    }
    graph.set(me, new Set([...(graph.get(me) || []), ...refs.filter((x) => !isBuiltinField(x)).map(fieldKey)]));
    const state = new Map();
    const loop = (node) => {
      if (state.get(node) === 1) return true;
      if (state.get(node) === 2) return false;
      state.set(node, 1);
      for (const nxt of graph.get(node) || []) if (graph.has(nxt) && loop(nxt)) return true;
      state.set(node, 2);
      return false;
    };
    if (loop(me)) return 'Circular reference: this formula leads back to itself through another formula.';
    return '';
  } catch (e) {
    return e instanceof FormulaError ? e.message : 'This formula could not be read.';
  }
}

// ── Values ───────────────────────────────────────────────────────────────────
// Blank = null. Text, numbers and true/false are themselves. A date is an
// FDate holding its day number on the plain calendar (days since 1970-01-01),
// so date math never meets a time zone or a DST jump.
export class FDate {
  constructor(n) { this.n = n; }
  get iso() { return dayToIso(this.n); }
}
const DAY_MS = 86400000;
function isoToDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(ms / DAY_MS);
}
function dayToIso(n) {
  const d = new Date(n * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export const dateValue = (iso) => { const n = isoToDay(iso); return n === null ? null : new FDate(n); };
// 01/01/0001 .. 12/31/9999 as day numbers. Date math past either end is an
// error, not a nonsense date (or an Invalid Date when it is shown).
const MIN_DAY = -719162;
const MAX_DAY = 2932896;
function makeDate(n) {
  if (!Number.isFinite(n) || n < MIN_DAY || n > MAX_DAY) throw new FormulaError('The date is out of range.');
  return new FDate(n);
}
// A timestamp (createdAt, completedAt) is read on the viewer's own calendar.
const localDayOf = (stamp) => {
  if (!stamp) return null;
  const d = new Date(stamp);
  return Number.isNaN(d.getTime()) ? null : dateValue(localISO(d));
};

const isBlank = (v) => v === null || v === undefined || v === '';
const kindOf = (v) => (v instanceof FDate ? 'a date' : typeof v === 'boolean' ? 'true/false' : typeof v === 'string' ? 'text' : 'a number');
const short = (s) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

function toNum(v) {
  if (isBlank(v)) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof FDate) throw new FormulaError('Expected a number but got a date.');
  const s = String(v).trim();
  if (s !== '' && Number.isFinite(Number(s.replace(/,/g, '')))) return Number(s.replace(/,/g, ''));
  throw new FormulaError(`Expected a number but got text "${short(s)}".`);
}
function toDay(v) {
  if (isBlank(v)) return null;
  if (v instanceof FDate) return v.n;
  if (typeof v === 'string') { const n = isoToDay(v.trim()); if (n !== null) return n; }
  throw new FormulaError(`Expected a date but got ${kindOf(v)}.`);
}
const plainNumber = (n) => String(Number(n.toPrecision(12)));
function capText(s) {
  if (s.length > MAX_TEXT) throw new FormulaError(`Text is too long (over 10,000 characters).`);
  return s;
}
export function toText(v) {
  if (isBlank(v)) return '';
  if (typeof v === 'number') return plainNumber(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof FDate) return formatDate(v.iso);
  return capText(String(v));
}
const truthy = (v) => {
  if (isBlank(v)) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return true;
};
const looksNumeric = (v) => typeof v === 'number' || typeof v === 'boolean'
  || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.trim().replace(/,/g, ''))));

function arith(op, a, b) {
  const da = a instanceof FDate; const db = b instanceof FDate;
  if (op === '+' || op === '-') {
    if (da || db) {
      if (isBlank(a) || isBlank(b)) return null;
      if (da && db) {
        if (op === '-') return a.n - b.n;
        throw new FormulaError('Two dates cannot be added - subtract them to get days.');
      }
      if (da) return makeDate(op === '+' ? a.n + Math.trunc(toNum(b)) : a.n - Math.trunc(toNum(b)));
      if (op === '+') return makeDate(b.n + Math.trunc(toNum(a)));
      // number - date: a date-looking string on the left is still a date.
      if (typeof a === 'string' && isoToDay(a.trim()) !== null) return isoToDay(a.trim()) - b.n;
      throw new FormulaError('A date cannot be subtracted from a number.');
    }
    if (isBlank(a) && isBlank(b)) return null;
    return op === '+' ? toNum(a) + toNum(b) : toNum(a) - toNum(b);
  }
  if (da || db) throw new FormulaError(`Dates cannot be used with ${op}.`);
  if (isBlank(a) && isBlank(b)) return null;
  const x = toNum(a); const y = toNum(b);
  if ((op === '/' || op === '%') && y === 0) throw new FormulaError('Division by zero.');
  if (op === '*') return x * y;
  if (op === '/') return x / y;
  return x % y;
}

function compare(op, a, b) {
  let x = a; let y = b;
  const ba = isBlank(a); const bb = isBlank(b);
  if (ba && bb) { x = 0; y = 0; }
  else if (ba || bb) {
    const other = ba ? b : a;
    if (other instanceof FDate) {
      if (op === '=') return false;
      if (op === '!=') return true;
      return false;
    }
    const blankAs = looksNumeric(other) ? 0 : '';
    if (ba) x = blankAs; else y = blankAs;
  }
  let c;
  if (x instanceof FDate || y instanceof FDate) {
    c = toDay(x) - toDay(y);
  } else if (looksNumeric(x) && looksNumeric(y)) {
    c = toNum(x) - toNum(y);
  } else if (typeof x === 'string' && typeof y === 'string') {
    const p = x.toLowerCase(); const q = y.toLowerCase();
    c = p < q ? -1 : p > q ? 1 : 0;
  } else if (op === '=' || op === '!=') {
    c = 1;   // a number and a word are never equal
  } else {
    throw new FormulaError(`Cannot compare ${kindOf(x)} with ${kindOf(y)}.`);
  }
  switch (op) {
    case '=': return c === 0;
    case '!=': return c !== 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    default: return c >= 0;
  }
}

const weekday = (n) => (((n + 4) % 7) + 7) % 7;   // 1970-01-01 was a Thursday; 0 = Sunday
function workdaysInclusive(a, b) {
  const days = b - a + 1;
  const weeks = Math.floor(days / 7);
  let count = weeks * 5;
  for (let d = a + weeks * 7; d <= b; d += 1) { const w = weekday(d); if (w !== 0 && w !== 6) count += 1; }
  return count;
}
function roundTo(x, places) {
  const p = Math.max(-10, Math.min(10, Math.trunc(places)));
  const abs = Math.abs(x);
  let r = Number(`${Math.round(Number(`${abs}e${p}`))}e${-p}`);
  if (!Number.isFinite(r)) r = Math.round(abs * 10 ** p) / 10 ** p;
  return x < 0 ? -r : r;
}
function numbersOf(values) {
  return values.filter((v) => !isBlank(v)).map((v) => {
    if (v instanceof FDate) throw new FormulaError('Expected a number but got a date.');
    return toNum(v);
  });
}

function evaluate(node, env) {
  switch (node.t) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'bool': return node.v;
    case 'field': return env.field(node.name);
    case 'un': {
      const v = evaluate(node.a, env);
      if (isBlank(v)) return null;
      if (v instanceof FDate) throw new FormulaError('A date cannot be made negative.');
      return node.op === '-' ? -toNum(v) : toNum(v);
    }
    case 'bin': {
      const a = evaluate(node.a, env);
      const b = evaluate(node.b, env);
      if (node.op === '&') return capText(toText(a) + toText(b));
      if (COMPARE.has(node.op)) return compare(node.op, a, b);
      return arith(node.op, a, b);
    }
    case 'call': return call(node, env);
    default: throw new FormulaError('This formula could not be read.');
  }
}

function call(node, env) {
  const ev = (i) => evaluate(node.args[i], env);
  const all = () => node.args.map((a) => evaluate(a, env));
  switch (node.fn) {
    case 'SUM': return numbersOf(all()).reduce((s, x) => s + x, 0);
    case 'AVG': { const xs = numbersOf(all()); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; }
    case 'MIN':
    case 'MAX': {
      const vals = all().filter((v) => !isBlank(v));
      if (!vals.length) return null;
      const pick = node.fn === 'MIN' ? Math.min : Math.max;
      if (vals.every((v) => v instanceof FDate)) return makeDate(pick(...vals.map((v) => v.n)));
      return pick(...numbersOf(vals));
    }
    case 'ROUND': {
      const x = ev(0);
      if (isBlank(x)) return null;
      return roundTo(toNum(x), node.args.length > 1 ? toNum(ev(1)) : 0);
    }
    case 'ABS': { const x = ev(0); return isBlank(x) ? null : Math.abs(toNum(x)); }
    case 'IF': return truthy(ev(0)) ? ev(1) : (node.args.length > 2 ? ev(2) : null);
    case 'AND': { for (let i = 0; i < node.args.length; i += 1) if (!truthy(ev(i))) return false; return true; }
    case 'OR': { for (let i = 0; i < node.args.length; i += 1) if (truthy(ev(i))) return true; return false; }
    case 'NOT': return !truthy(ev(0));
    case 'ISBLANK': return isBlank(ev(0));
    case 'DAYS': {
      const end = toDay(ev(0)); const start = toDay(ev(1));
      return end === null || start === null ? null : end - start;
    }
    case 'TODAY': return dateValue(env.today);
    case 'WORKDAYS': {
      const a = toDay(ev(0)); const b = toDay(ev(1));
      if (a === null || b === null) return null;
      return a <= b ? workdaysInclusive(a, b) : -workdaysInclusive(b, a);
    }
    case 'CONCAT': {
      let out = '';
      for (const v of all()) out = capText(out + toText(v));
      return out;
    }
    case 'UPPER': return capText(toText(ev(0)).toUpperCase());
    case 'LOWER': return capText(toText(ev(0)).toLowerCase());
    default: throw new FormulaError(`Unknown function ${node.fn}.`);
  }
}

/** Run an expression against `field(name)` lookups. Returns { value, error }. */
export function runFormula(src, { field = () => { throw new FormulaError('No fields here.'); }, today = todayISO() } = {}) {
  try {
    const value = evaluate(parsedOnce(src), { field, today });
    if (typeof value === 'number' && !Number.isFinite(value)) return { value: null, error: 'The result is not a number.' };
    if (typeof value === 'string') capText(value);   // a long text field passed straight through
    return { value, error: '' };
  } catch (e) {
    return { value: null, error: e instanceof FormulaError ? e.message : 'This formula could not be worked out.' };
  }
}

// ── Per-task engine ──────────────────────────────────────────────────────────
const BLANK = Object.freeze({ value: null, error: '' });

function optionLabel(field, id) {
  const o = (field.options || []).find((x) => (x?.id ?? x) === id || (x?.label ?? x) === id);
  return o ? String(o.label ?? o) : String(id);
}

/** One engine per data snapshot: results are memoized per task object and
 *  field, so a column of 500 rows parses its formula once and each cell once.
 *  A task edit replaces the task object, which drops its memo by itself. */
export function createFormulaEngine({ customFields = [], taskById = null, nameOf = null, today = todayISO() } = {}) {
  const memo = new WeakMap();
  const running = new Set();
  const byKey = new Map();
  for (const f of customFields || []) {
    const k = fieldKey(f.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }
  const personName = (em) => (nameOf ? nameOf(em) : '') || emailToName(em);

  function builtin(task, key) {
    const subIds = task.subtaskIds || [];
    const subs = taskById ? subIds.map((id) => taskById[id]).filter(Boolean) : null;
    const count = subs ? subs.length : subIds.length;
    const done = subs ? subs.filter((s) => s.completed).length : 0;
    switch (key) {
      case 'estimate hours': return task.estimateHours == null || task.estimateHours === '' ? null : Number(task.estimateHours);
      case 'time tracked hours': return task.actualHours == null || task.actualHours === '' ? null : Number(task.actualHours);
      case 'due date': return dateValue(task.dueOn);
      case 'start date': return dateValue(task.startOn);
      case 'created': return localDayOf(task.createdAt);
      case 'completed': return task.completed ? localDayOf(task.completedAt) : null;
      case 'subtask count': return count;
      case 'completed subtasks': return done;
      case 'progress': return count ? done / count : (task.completed ? 1 : 0);
      default: return null;
    }
  }

  function fieldValue(task, self, name) {
    const key = fieldKey(name);
    if (BUILTIN_KEYS.has(key)) return builtin(task, key);
    const named = (byKey.get(key) || []).filter((f) => f.id !== self.id);
    if (!named.length) throw new FormulaError(`Unknown field {${name}}.`);
    // Two fields can share a name (one per project): the one this task uses.
    const own = fieldsForTask(named, task);
    const f = own[0] || named[0];
    if (f.type === 'formula') {
      const r = result(task, f);
      if (r.error) throw new FormulaError(`{${f.name}} has an error: ${r.error}`);
      return r.value;
    }
    const raw = (task.customFieldValues || {})[f.id];
    switch (f.type) {
      case 'checkbox': return raw === true || raw === 'true';
      case 'number': {
        if (isBlank(raw)) return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      case 'date': return isBlank(raw) ? null : dateValue(raw);
      case 'select': return isBlank(raw) ? null : optionLabel(f, raw);
      case 'multiselect': {
        const list = Array.isArray(raw) ? raw : isBlank(raw) ? [] : [raw];
        return list.length ? list.map((x) => optionLabel(f, x)).join(', ') : null;
      }
      case 'people': {
        const list = Array.isArray(raw) ? raw : isBlank(raw) ? [] : [raw];
        return list.length ? list.map(personName).join(', ') : null;
      }
      default: return isBlank(raw) ? null : String(raw);
    }
  }

  function result(task, field) {
    if (!task || !field || field.type !== 'formula') return BLANK;
    let m = memo.get(task);
    if (!m) { m = new Map(); memo.set(task, m); }
    if (m.has(field.id)) return m.get(field.id);
    const key = `${task.id}\u0000${field.id}`;
    if (running.has(key)) return { value: null, error: 'Circular reference.' };
    running.add(key);
    let out;
    try {
      out = runFormula(field.formula || '', { field: (name) => fieldValue(task, field, name), today });
    } finally {
      running.delete(key);
    }
    m.set(field.id, out);
    return out;
  }

  return { result, today };
}

// Shared engines, keyed on the data they read - every screen showing the
// same snapshot shares one memo instead of each computing its own.
const engines = new WeakMap();
const NO_TASKS = {};
const NO_FIELDS = [];
/** The engine for a TasksContext-shaped store ({customFields, taskById, nameOf}). */
export function formulaEngineFor(store) {
  const fields = store?.customFields || NO_FIELDS;
  const tasks = store?.taskById || NO_TASKS;
  let byTasks = engines.get(fields);
  if (!byTasks) { byTasks = new WeakMap(); engines.set(fields, byTasks); }
  const today = todayISO();
  const hit = byTasks.get(tasks);
  if (hit && hit.today === today && hit.nameOf === (store?.nameOf || null)) return hit.engine;
  const engine = createFormulaEngine({ customFields: fields, taskById: store?.taskById || null, nameOf: store?.nameOf || null, today });
  byTasks.set(tasks, { engine, today, nameOf: store?.nameOf || null });
  return engine;
}

// ── Showing a result ─────────────────────────────────────────────────────────
/** Is this formula's result a number to total (number/currency/percent)? */
export const formulaIsNumeric = (field) => field?.type === 'formula'
  && ['number', 'currency', 'percent'].includes(normalizeFormat(field.formulaFormat).format);

/** A number in a formula column's format - also what the totals row uses. */
export function formatNumberAs(n, fmt) {
  const { format, decimals } = normalizeFormat(fmt);
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  if (format === 'currency') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
  }
  if (format === 'percent') {
    return new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
  }
  if (format === 'text') return plainNumber(n);
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: format === 'date' ? 0 : decimals }).format(n);
}

/** The text a result shows as ('' for blank). Dates are always dates and
 *  true/false always True/False, whatever the format says. */
export function formatFormulaValue(value, fmt) {
  if (isBlank(value)) return '';
  if (value instanceof FDate) return formatDate(value.iso);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return formatNumberAs(value, fmt);
  return String(value);
}

/** A result as it sorts: numbers and dates by size, text by letters; blanks
 *  and errors are null (the sorter puts them last). */
export function formulaSortValue(r) {
  if (!r || r.error || isBlank(r.value)) return null;
  if (r.value instanceof FDate) return r.value.n;
  if (typeof r.value === 'boolean') return r.value ? 0 : 1;
  if (typeof r.value === 'number') return r.value;
  return String(r.value).toLowerCase();
}

/** The value an export writes: numbers stay numbers (an Excel column can be
 *  summed), the rest as shown; an error is "#Error". */
export function formulaExportValue(r, fmt) {
  if (!r) return '';
  if (r.error) return '#Error';
  if (typeof r.value === 'number' && Number.isFinite(r.value)) {
    const { format, decimals } = normalizeFormat(fmt);
    return format === 'text' ? plainNumber(r.value) : roundTo(r.value, format === 'percent' ? decimals + 2 : decimals);
  }
  return formatFormulaValue(r.value, fmt);
}

// Filter keys a formula column offers (the Filter panel stores these in
// filters.customFields like a select's option ids).
export const FORMULA_FILTERS = [
  { id: '__filled', label: 'Has a Value' },
  { id: '__blank', label: 'Blank' },
  { id: '__error', label: 'Error' },
];
/** Does result `r` match any of the wanted FORMULA_FILTERS keys? */
export function formulaMatches(r, wanted) {
  if (!wanted?.length) return true;
  const state = r?.error ? '__error' : isBlank(r?.value) ? '__blank' : '__filled';
  return wanted.includes(state);
}

// ── The editor's helpers ─────────────────────────────────────────────────────
/** The field list after PATCH /task-custom-fields/{id} answered `res`: the
 *  field itself, and every formula column the rename rewrote
 *  (`rewrittenFormulas`) - so those read right at once, not #Error until
 *  the next load. */
export function applyFieldUpdate(list, id, res) {
  const { rewrittenFormulas = [], ...field } = res || {};
  const byId = new Map([[id, field], ...(rewrittenFormulas || []).map((g) => [g.id, g])]);
  return (list || []).map((x) => byId.get(x.id) || x);
}

/** The formula columns whose {name} means `field` - they name it and no
 *  other field carries that name (the server's _formulas_naming, without
 *  the company check the browser cannot make). For the delete question. */
export function formulasUsing(customFields, field) {
  const key = fieldKey(field?.name);
  if (!key || isBuiltinField(key)) return [];   // {Progress} reads the built-in
  if ((customFields || []).some((o) => o.id !== field.id && fieldKey(o.name) === key)) return [];
  return (customFields || []).filter((g) => {
    if (g.type !== 'formula' || g.id === field.id || !g.formula) return false;
    try { return formulaFieldRefs(g.formula).some((r) => fieldKey(r) === key); } catch { return false; }
  });
}

/** Names and expressions the editor checks against: every task field the
 *  workspace has except this one. */
export function formulaContext(customFields, selfId) {
  const others = (customFields || []).filter((f) => f.id !== selfId && (f.appliesTo || ['task']).includes('task'));
  return {
    fieldNames: others.map((f) => f.name).filter(Boolean),
    formulaFields: others.filter((f) => f.type === 'formula').map((f) => [f.name, f.formula || '']),
  };
}

/** The first few tasks to preview a draft formula on: the list's own rows
 *  when there are some, else tasks in the field's projects. */
export function previewRows({ draft, store, tasks, projectIds = [], limit = 5 }) {
  let pool = (tasks || []).filter((t) => t && t.type !== 'section');
  if (!pool.length) {
    const ids = (projectIds || []).filter(Boolean);
    pool = (store?.tasks || []).filter((t) => t && !t.parentTaskId && t.type !== 'section'
      && (!ids.length || [t.projectId, ...(t.projectIds || [])].some((p) => p && ids.includes(p))));
  }
  const fields = [...(store?.customFields || []).filter((f) => f.id !== draft.id), draft];
  const engine = createFormulaEngine({ customFields: fields, taskById: store?.taskById || null, nameOf: store?.nameOf || null });
  return pool.slice(0, limit).map((t) => ({ id: t.id, title: t.title || 'Untitled', result: engine.result(t, draft) }));
}

// ── Wiring for the list screens ──────────────────────────────────────────────
const helperCache = new WeakMap();
/** What a list hands to sortTasks (ctx.formulaSortValue) and matchesFilter
 *  (formulaMatch) so formula columns sort and filter by their computed value.
 *  One object per engine, so it is stable across renders of one snapshot. */
export function formulaHelpers(store) {
  const engine = formulaEngineFor(store);
  let h = helperCache.get(engine);
  if (!h) {
    const byId = new Map((store?.customFields || []).filter((f) => f.type === 'formula').map((f) => [f.id, f]));
    h = {
      engine,
      formulaSortValue: (task, field) => formulaSortValue(engine.result(task, field)),
      formulaMatch: (task, fieldId, wanted) => {
        const f = byId.get(fieldId);
        return f ? formulaMatches(engine.result(task, f), wanted) : undefined;
      },
    };
    helperCache.set(engine, h);
  }
  return h;
}

/** Export columns for custom fields (rows are { task }): what each cell
 *  shows, formulas as their computed values. Numbers stay numbers so an
 *  Excel column sums; `display` is the PDF's text for the same cell. */
export function customFieldExportColumns(fields, store) {
  const engine = formulaEngineFor(store);
  const nameOf = store?.nameOf || emailToName;
  return (fields || []).map((f) => {
    if (f.type === 'formula') {
      return {
        header: f.name, width: 14, optional: true, z: excelFormat(f.formulaFormat),
        get: (r) => formulaExportValue(engine.result(r.task, f), f.formulaFormat),
        display: (r) => { const res = engine.result(r.task, f); return res.error ? '#Error' : formatFormulaValue(res.value, f.formulaFormat); },
      };
    }
    const get = (r) => {
      const v = (r.task.customFieldValues || {})[f.id];
      if (isBlank(v) || (Array.isArray(v) && !v.length)) return f.type === 'checkbox' ? 'No' : '';
      switch (f.type) {
        case 'number': { const n = Number(v); return Number.isFinite(n) ? n : String(v); }
        case 'date': return formatDate(String(v).slice(0, 10));
        case 'checkbox': return v === true || v === 'true' ? 'Yes' : 'No';
        case 'select': return optionLabel(f, v);
        case 'multiselect': return (Array.isArray(v) ? v : [v]).map((x) => optionLabel(f, x)).join(', ');
        case 'people': return (Array.isArray(v) ? v : [v]).map((em) => nameOf(em) || emailToName(em)).join(', ');
        default: return String(v);
      }
    };
    return { header: f.name, width: 14, optional: true, get };
  });
}

/** Excel's number format code for a formula column, or undefined. */
export function excelFormat(fmt) {
  const { format, decimals } = normalizeFormat(fmt);
  const frac = decimals ? `.${'0'.repeat(decimals)}` : '';
  if (format === 'percent') return `0${frac}%`;
  if (format === 'currency') return `"$"#,##0${frac}`;
  return undefined;
}
