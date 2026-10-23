// Task Module - conditional row colors (Neil, Oct 22 2026).
//
// A project keeps an ordered list of rules that color its task rows by their
// data, Smartsheet / monday style. This file is the whole of the logic, pure
// and UI-free: the vocabulary (fields, operators, palette), the one-line
// summary each rule prints, what makes a rule "needs attention", and the
// evaluator. The server (backend/task_color_rules.py) checks the same
// vocabulary on save - keep the two in step.
//
// Rule shape: { id, name, color, bold, enabled, match: 'all' | 'any',
//               conditions: [{ field, op, value }] }
//
// Evaluation: the FIRST enabled rule that matches wins. A rule with anything
// broken in it (a deleted field, option, status or section) never matches -
// the editor flags it instead of quietly coloring by half a rule. Calendar
// days are the viewer's LOCAL day (lib.js todayISO), never the UTC one.
//
// Speed: rules are COMPILED once per (rules, context, day) into plain
// predicates - date limits worked out, values lowercased, "any of" lists made
// into Sets - and each task's answer is cached on the compiled set, keyed by
// the task OBJECT (a WeakMap). The store replaces a task object whenever the
// task changes, so an edit is re-evaluated and a search keystroke, which only
// changes which of the same objects are on screen, is not.
import { NX, PRIORITY_META } from './theme';
import { addDays, taskAssignees, isBlankValue, todayISO } from './lib';
import { formatDate } from '../lib/datetime';
import { labelKey } from './labels';

export const MAX_RULES = 20;
export const MAX_CONDITIONS = 5;
export const MAX_NAME = 60;
export const MIN_DAYS = 1;
export const MAX_DAYS = 365;

// Lookups by a key that came from stored data go through this, never a bare
// obj[key]: a rule naming "constructor" or "__proto__" must read as unknown.
const own = (obj, key) => (obj && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined);

// The soft label palette - the accents the status labels and project looks
// already use (theme.js NX) plus slate. Stored as the KEY, so a rule never
// carries a hex and the look can be retuned in one place. No blue on
// purpose: a faint blue row is exactly what a SELECTED row looks like
// (rgba(37,99,235,0.10)), and a rule must never pass for a selection.
export const PALETTE = [
  { key: 'red', label: 'Red', hex: NX.red },
  { key: 'amber', label: 'Amber', hex: NX.amber },
  { key: 'green', label: 'Green', hex: NX.green },
  { key: 'purple', label: 'Purple', hex: NX.purple },
  { key: 'teal', label: 'Teal', hex: NX.teal },
  { key: 'pink', label: 'Pink', hex: NX.pink },
  { key: 'gray', label: 'Gray', hex: '#64748b' },
];
const HEX = Object.fromEntries(PALETTE.map((p) => [p.key, p.hex]));
export const colorHex = (key) => own(HEX, key) || HEX.gray;

// What value an operator takes - the same kinds as the server's OP_KIND.
export const OP_KIND = Object.freeze({
  is: 'text', is_not: 'text', is_any_of: 'list',
  is_me: 'none', is_not_me: 'none', is_unassigned: 'none', is_assigned: 'none',
  person_is: 'person', person_is_not: 'person',
  contains: 'text', not_contains: 'text', person_contains: 'person',
  is_empty: 'none', is_not_empty: 'none', is_true: 'none', is_false: 'none',
  overdue: 'none', past: 'none', today: 'none', within: 'days',
  before: 'date', after: 'date', on: 'date',
  eq: 'number', ne: 'number', gt: 'number', gte: 'number', lt: 'number', lte: 'number',
  between: 'range',
});
export const opKind = (op) => own(OP_KIND, op);

// The words each operator reads as, in the picker and in the summary.
const OP_LABEL = {
  is: 'is', is_not: 'is not', is_any_of: 'is any of',
  is_me: 'is me', is_not_me: 'is not me', is_unassigned: 'is unassigned', is_assigned: 'is assigned',
  person_is: 'is', person_is_not: 'is not', person_contains: 'includes',
  contains: 'contains', not_contains: 'does not contain',
  is_empty: 'is empty', is_not_empty: 'is not empty',
  is_true: 'is checked', is_false: 'is not checked',
  overdue: 'is overdue', past: 'is in the past', today: 'is today', within: 'is within the next',
  before: 'is before', after: 'is after', on: 'is on',
  eq: 'equals', ne: 'does not equal', gt: 'is greater than', gte: 'is at least',
  lt: 'is less than', lte: 'is at most', between: 'is between',
};

const DATE_OPS = ['overdue', 'today', 'within', 'before', 'after', 'on', 'is_empty', 'is_not_empty'];
const DATE_WORDS = { is_empty: 'is not set', is_not_empty: 'is set' };

// Built-in fields. `subject` is what the summary sentence starts with when it
// should not be the field's own name; `words` overrides operator wording.
export const BUILTIN_FIELDS = [
  { key: 'status', label: 'Status', kind: 'status', ops: ['is', 'is_not', 'is_any_of'] },
  { key: 'priority', label: 'Priority', kind: 'priority', ops: ['is', 'is_not', 'is_any_of'] },
  { key: 'assignee', label: 'Assignee', kind: 'person', ops: ['is_me', 'is_not_me', 'person_is', 'person_is_not', 'is_unassigned', 'is_assigned'] },
  { key: 'due', label: 'Due Date', kind: 'date', ops: DATE_OPS, words: DATE_WORDS },
  { key: 'start', label: 'Start Date', kind: 'date', ops: ['past', 'today', 'within', 'before', 'after', 'on', 'is_empty', 'is_not_empty'], words: DATE_WORDS },
  { key: 'completed', label: 'Completed', subject: 'Task', kind: 'bool', ops: ['is_false', 'is_true'], words: { is_true: 'is completed', is_false: 'is not completed' } },
  { key: 'tags', label: 'Tags', kind: 'tag', ops: ['contains', 'not_contains', 'is_empty', 'is_not_empty'], words: { contains: 'include', not_contains: 'do not include', is_empty: 'are empty', is_not_empty: 'are not empty' } },
  { key: 'section', label: 'Section', kind: 'section', ops: ['is', 'is_not', 'is_empty'], words: { is_empty: 'is not set' } },
  { key: 'created_by', label: 'Created By', kind: 'person', ops: ['is_me', 'person_is', 'person_is_not'] },
];
const BUILTIN = Object.fromEntries(BUILTIN_FIELDS.map((f) => [f.key, f]));

// Custom field storage type -> operators (models.TaskCustomField.type).
export const CF_OPS = {
  select: ['is', 'is_not', 'is_any_of', 'is_empty', 'is_not_empty'],
  multiselect: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'is_not_empty'],
  checkbox: ['is_true', 'is_false'],
  text: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  date: DATE_OPS,
  people: ['person_contains', 'is_me', 'is_empty', 'is_not_empty'],
};
const CF_WORDS = {
  multiselect: { contains: 'includes', not_contains: 'does not include' },
  date: DATE_WORDS,
  people: { is_me: 'includes me' },
};
export const CF_PREFIX = 'cf:';

/** The field a condition names: a built-in, a custom field (with its def),
 *  or null when it names nothing that exists any more. */
export function fieldInfo(key, fieldsById) {
  const builtin = own(BUILTIN, key);
  if (builtin) return builtin;
  if (!String(key || '').startsWith(CF_PREFIX)) return null;
  const def = fieldsById?.get?.(key.slice(CF_PREFIX.length));
  if (!def) return null;
  const type = String(def.type || 'text').toLowerCase();
  const ops = own(CF_OPS, type);
  if (!ops) return null;
  return { key, label: def.name || 'Custom Field', kind: `cf-${type}`, type, ops, words: own(CF_WORDS, type), def };
}

export const opLabel = (field, op) => own(field?.words, op) || own(OP_LABEL, op) || String(op || '');

/** The fields the editor offers here: the built-ins (Section only where there
 *  are sections to pick) and the custom fields this scope uses. */
export function fieldChoices({ customFields = [], sections = [] } = {}) {
  const out = BUILTIN_FIELDS.filter((f) => f.key !== 'section' || sections.length > 0)
    .map((f) => ({ key: f.key, label: f.label }));
  for (const f of customFields) {
    if (own(CF_OPS, String(f.type || 'text').toLowerCase())) out.push({ key: `${CF_PREFIX}${f.id}`, label: f.name || 'Custom Field' });
  }
  return out;
}

// ── Reading stored rules ─────────────────────────────────────────────────────
/** Rules as read from storage, with anything malformed dropped rather than
 *  thrown on: a hand-edited or half-written document must never take My Tasks
 *  or the editor down. Conditions keep their content (the editor flags what
 *  no longer fits); only their SHAPE is checked here. */
export function sanitizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    if (typeof r.id !== 'string' || !r.id || seen.has(r.id) || typeof r.name !== 'string') continue;
    if (!Array.isArray(r.conditions) || !r.conditions.length) continue;
    const conditions = r.conditions.filter((c) => c && typeof c === 'object' && !Array.isArray(c)
      && typeof c.field === 'string' && typeof c.op === 'string');
    if (conditions.length !== r.conditions.length) continue;
    seen.add(r.id);
    out.push({
      id: r.id, name: r.name, color: typeof r.color === 'string' ? r.color : 'gray',
      bold: r.bold === true, enabled: r.enabled !== false, match: r.match === 'any' ? 'any' : 'all',
      conditions: conditions.slice(0, MAX_CONDITIONS),
    });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

// ── Defaults the editor fills in when a field or operator changes ────────────
export function defaultValue(op, field) {
  const kind = opKind(op);
  if (kind === 'none') return undefined;
  if (kind === 'days') return 7;
  if (kind === 'list') return [];
  if (kind === 'range') return ['', ''];
  if (field?.kind === 'priority') return 'urgent';
  return '';
}
export const blankCondition = () => ({ field: 'due', op: 'overdue' });

let seq = 0;
export const newRuleId = () => {
  seq += 1;
  return `cr-${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
};
export const blankRule = () => ({
  id: newRuleId(), name: '', color: 'red', bold: false, enabled: true, match: 'all', conditions: [blankCondition()],
});

// ── What is wrong with a condition ──────────────────────────────────────────
// ctx: { fieldsById: Map, statusMeta: {id: meta}, sections: [{id,name}] | null }
// Returns '' when the condition can be evaluated.
export function conditionProblem(c, ctx = {}) {
  if (!c || typeof c !== 'object') return 'This condition is not readable.';
  const field = fieldInfo(c.field, ctx.fieldsById);
  if (!field) {
    return String(c.field || '').startsWith(CF_PREFIX) ? 'The field this uses was deleted.' : 'This field is not known.';
  }
  if (!field.ops.includes(c.op)) return 'This comparison no longer fits the field.';
  const kind = opKind(c.op);
  const v = c.value;
  if (kind === 'text' || kind === 'person' || kind === 'date') {
    if (v === undefined || v === null || typeof v === 'object' || String(v).trim() === '') return 'Pick a value.';
  }
  if (kind === 'list' && (!Array.isArray(v) || v.length === 0)) return 'Pick at least one value.';
  if (kind === 'days' && !(v !== '' && v !== null && Number.isInteger(Number(v)) && Number(v) >= MIN_DAYS && Number(v) <= MAX_DAYS)) {
    return `Enter a whole number of days from ${MIN_DAYS} to ${MAX_DAYS}.`;
  }
  if (kind === 'number' && (v === '' || v === null || typeof v === 'object' || !Number.isFinite(Number(v)))) return 'Enter a number.';
  if (kind === 'range' && (!Array.isArray(v) || v.length !== 2 || v.some((x) => x === '' || x === null || !Number.isFinite(Number(x))))) return 'Enter both numbers.';
  const vals = Array.isArray(v) && kind === 'list' ? v : [v];
  if ((field.type === 'select' || field.type === 'multiselect') && kind !== 'none') {
    const ids = new Set((field.def.options || []).map((o) => o?.id ?? o));
    if (vals.some((x) => !ids.has(x))) return 'An option this uses was deleted.';
  }
  if (field.kind === 'status' && ctx.statusMeta && vals.some((x) => !own(ctx.statusMeta, x))) return 'A status this uses was deleted.';
  if (field.kind === 'priority' && vals.some((x) => !own(PRIORITY_META, x))) return 'This priority is not known.';
  if (field.kind === 'section' && kind !== 'none' && Array.isArray(ctx.sections) && !ctx.sections.some((s) => s.id === v)) {
    return 'The section this uses was deleted.';
  }
  return '';
}

/** [{ index, text }] for every condition that needs attention. */
export function ruleProblems(rule, ctx = {}) {
  const out = [];
  (Array.isArray(rule?.conditions) ? rule.conditions : []).forEach((c, index) => {
    const text = conditionProblem(c, ctx);
    if (text) out.push({ index, text });
  });
  return out;
}

/** The first thing that stops the editor saving a draft, as a sentence, or ''. */
export function draftProblem(rule, ctx = {}) {
  if (!String(rule?.name || '').trim()) return 'Give the rule a name.';
  if (String(rule.name).trim().length > MAX_NAME) return `Keep the name to ${MAX_NAME} characters.`;
  if (!rule.conditions?.length) return 'Add at least one condition.';
  if (rule.conditions.length > MAX_CONDITIONS) return `At most ${MAX_CONDITIONS} conditions.`;
  const p = ruleProblems(rule, ctx)[0];
  return p ? `Condition ${p.index + 1}: ${p.text}` : '';
}

// ── Compiling ───────────────────────────────────────────────────────────────
const day = (v) => (v ? String(v).slice(0, 10) : '');
const lowerList = (xs) => (Array.isArray(xs) ? xs : []).map((x) => String(x || '').toLowerCase()).filter(Boolean);
const NEVER = () => false;

/** The section a task is filed under, as the Custom grouping shows it: an id
 *  that is not one of this scope's sections reads as "No Section" ('') - the
 *  same resolution as lib.js groupTasks. */
function sectionResolver(ctx) {
  const known = Array.isArray(ctx.sections) ? new Set(ctx.sections.map((s) => s.id)) : null;
  return (task) => {
    const sid = (ctx.sectionOf ? ctx.sectionOf(task) : task.sectionId) || '';
    return known && !known.has(sid) ? '' : sid;
  };
}

function compileDate(op, value, get, today) {
  switch (op) {
    case 'overdue': return (t) => { const d = get(t); return !!d && d < today && !t.completed; };
    case 'past': return (t) => { const d = get(t); return !!d && d < today; };
    case 'today': return (t) => get(t) === today;
    case 'within': {
      const until = addDays(today, Number(value) || 0);
      return (t) => { const d = get(t); return !!d && d >= today && d <= until; };
    }
    case 'before': { const v = day(value); return (t) => { const d = get(t); return !!d && d < v; }; }
    case 'after': { const v = day(value); return (t) => { const d = get(t); return !!d && d > v; }; }
    case 'on': { const v = day(value); return (t) => { const d = get(t); return !!d && d === v; }; }
    case 'is_empty': return (t) => !get(t);
    case 'is_not_empty': return (t) => !!get(t);
    default: return NEVER;
  }
}

function compilePeople(op, value, get, me) {
  const who = String(value || '').toLowerCase();
  switch (op) {
    case 'is_me': return (t) => !!me && get(t).includes(me);
    case 'is_not_me': return (t) => !me || !get(t).includes(me);
    case 'person_is': case 'person_contains': return (t) => get(t).includes(who);
    case 'person_is_not': return (t) => !get(t).includes(who);
    case 'is_unassigned': case 'is_empty': return (t) => get(t).length === 0;
    case 'is_assigned': case 'is_not_empty': return (t) => get(t).length > 0;
    default: return NEVER;
  }
}

function compileCustom(field, op, value, ctx) {
  const id = field.def.id;
  const raw = (t) => own(t.customFieldValues, id);
  if (op === 'is_empty') return (t) => isBlankValue(raw(t));
  if (op === 'is_not_empty') return (t) => !isBlankValue(raw(t));
  switch (field.type) {
    case 'select': {
      if (op === 'is') return (t) => raw(t) === value;
      if (op === 'is_not') return (t) => raw(t) !== value;
      const set = new Set(Array.isArray(value) ? value : []);
      return (t) => set.has(raw(t));
    }
    case 'multiselect': {
      const has = (t) => { const v = raw(t); return Array.isArray(v) && v.includes(value); };
      return op === 'contains' ? has : (t) => !has(t);
    }
    case 'number': {
      const num = (t) => { const v = raw(t); if (isBlankValue(v)) return NaN; return Number(v); };
      const x = Number(value);
      const [a, b] = Array.isArray(value) ? value.map(Number) : [NaN, NaN];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const cmp = {
        eq: (n) => n === x, ne: (n) => n !== x, gt: (n) => n > x, gte: (n) => n >= x,
        lt: (n) => n < x, lte: (n) => n <= x, between: (n) => n >= lo && n <= hi,
      }[op] || NEVER;
      return (t) => { const n = num(t); return Number.isFinite(n) && cmp(n); };
    }
    case 'checkbox':
      return op === 'is_true' ? (t) => raw(t) === true : (t) => raw(t) !== true;
    case 'text': {
      const needle = String(value ?? '').toLowerCase();
      const has = (t) => String(raw(t) ?? '').toLowerCase().includes(needle);
      return op === 'contains' ? has : (t) => !has(t);
    }
    case 'date': return compileDate(op, value, (t) => day(raw(t)), ctx.today);
    case 'people': return compilePeople(op, value, (t) => lowerList(raw(t)), ctx.me);
    default: return NEVER;
  }
}

/** One (problem-free) condition as a predicate over a task. */
export function compileCondition(c, ctx) {
  const { op, value } = c;
  switch (c.field) {
    case 'status':
    case 'priority': {
      const get = c.field === 'status' ? (t) => t.status : (t) => t.priority;
      if (op === 'is') return (t) => get(t) === value;
      if (op === 'is_not') return (t) => get(t) !== value;
      const set = new Set(Array.isArray(value) ? value : []);
      return (t) => set.has(get(t));
    }
    case 'assignee': return compilePeople(op, value, (t) => lowerList(taskAssignees(t)), ctx.me);
    case 'created_by': return compilePeople(op, value, (t) => lowerList([t.requesterId || t.ownerId]), ctx.me);
    case 'tags': {
      // By label key (labels.js): "Q4  Close" and "q4 close" are one label,
      // as on every other screen and in the automation rules.
      const want = labelKey(value);
      const keys = (t) => (Array.isArray(t.tags) ? t.tags : []).map(labelKey).filter(Boolean);
      if (op === 'is_empty') return (t) => keys(t).length === 0;
      if (op === 'is_not_empty') return (t) => keys(t).length > 0;
      return op === 'contains' ? (t) => keys(t).includes(want) : (t) => !keys(t).includes(want);
    }
    case 'section': {
      const sectionOf = sectionResolver(ctx);
      if (op === 'is_empty') return (t) => !sectionOf(t);
      return op === 'is' ? (t) => sectionOf(t) === value : (t) => sectionOf(t) !== value;
    }
    case 'due': return compileDate(op, value, (t) => day(t.dueOn), ctx.today);
    case 'start': return compileDate(op, value, (t) => day(t.startOn), ctx.today);
    case 'completed': return op === 'is_true' ? (t) => !!t.completed : (t) => !t.completed;
    default: {
      const field = fieldInfo(c.field, ctx.fieldsById);
      return field?.def ? compileCustom(field, op, value, ctx) : NEVER;
    }
  }
}

const fullCtx = (ctx = {}) => ({ ...ctx, today: ctx.today || todayISO(), me: String(ctx.me || '').toLowerCase() });

/** Does one (problem-free) condition hold for `task`? (Tests and one-offs;
 *  lists go through compileRules.) */
export function conditionMatches(c, task, ctx) {
  return compileCondition(c, fullCtx(ctx))(task);
}

/** The rules that can color anything: enabled, and nothing in them broken. */
export function usableRules(rules, ctx = {}) {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => r && typeof r === 'object' && r.enabled !== false && Array.isArray(r.conditions) && r.conditions.length > 0
      && ruleProblems(r, ctx).length === 0);
}

function compileOne(r, ctx) {
  const tests = r.conditions.map((c) => compileCondition(c, ctx));
  const any = r.match === 'any';
  return {
    id: r.id,
    enabled: r.enabled !== false,
    entry: { id: r.id, name: r.name, color: r.color, hex: colorHex(r.color), bold: r.bold === true },
    test: any ? (t) => tests.some((f) => f(t)) : (t) => tests.every((f) => f(t)),
  };
}

/**
 * The usable rules, compiled for this context and day, with a per-task cache.
 * ctx: { today, me, fieldsById, statusMeta, sections, sectionOf }. A new
 * compile (new rules, context or day) starts a new cache.
 */
export function compileRules(rules, ctx = {}) {
  const c = fullCtx(ctx);
  return { rules: usableRules(rules, c).map((r) => compileOne(r, c)), cache: new WeakMap() };
}

/** The color entry for one task under compiled rules, or null. */
export function colorOf(compiled, task) {
  if (!task || typeof task !== 'object' || task.type === 'section') return null;
  const hit = compiled.cache.get(task);
  if (hit !== undefined) return hit;
  let out = null;
  for (const r of compiled.rules) if (r.test(task)) { out = r.entry; break; }
  compiled.cache.set(task, out);
  return out;
}

/** taskId -> { id, name, color, hex, bold } for every task a compiled set colors. */
export function colorMapWith(compiled, tasks) {
  const out = new Map();
  if (!compiled.rules.length) return out;
  for (const t of tasks || []) {
    const e = colorOf(compiled, t);
    if (e) out.set(t.id, e);
  }
  return out;
}

/** The same, compiling on the spot (one-offs and tests). */
export function colorMap(rules, tasks, ctx = {}) {
  return colorMapWith(compileRules(rules, ctx), tasks);
}

/** The rule that colors `task` - the first usable one that matches - or null. */
export function firstMatch(rules, task, ctx) {
  const e = colorOf(compileRules(rules, ctx), task);
  return e ? (rules.find((r) => r.id === e.id) || null) : null;
}

/**
 * For the editor: per rule id, `own` = how many of `tasks` the rule matches
 * on its own (on or off), `first` = how many it actually colors once earlier
 * rules have taken theirs (enabled rules only). A rule with a problem in it
 * has neither.
 */
export function ruleCounts(rules, tasks, ctx = {}) {
  const c = fullCtx(ctx);
  const list = (Array.isArray(rules) ? rules : [])
    .filter((r) => r && Array.isArray(r.conditions) && r.conditions.length && !ruleProblems(r, c).length)
    .map((r) => compileOne(r, c));
  const own_ = Object.fromEntries(list.map((r) => [r.id, 0]));
  const first = Object.fromEntries(list.filter((r) => r.enabled).map((r) => [r.id, 0]));
  for (const t of tasks || []) {
    if (!t || t.type === 'section') continue;
    let taken = false;
    for (const r of list) {
      if (!r.test(t)) continue;
      own_[r.id] += 1;
      if (r.enabled && !taken) { first[r.id] += 1; taken = true; }
    }
  }
  return { own: own_, first };
}

// ── Plain-English summaries ──────────────────────────────────────────────────
// ctx: { fieldsById, statusMeta, sections, nameOf(email) }
function valueText(field, op, v, ctx) {
  const kind = opKind(op);
  if (kind === 'none' || v === undefined) return '';
  const one = (x) => {
    if (field.kind === 'status') return own(ctx.statusMeta, x)?.label || String(x);
    if (field.kind === 'priority') return own(PRIORITY_META, x)?.label || String(x);
    if (field.kind === 'section') return (ctx.sections || []).find((s) => s.id === x)?.name || 'a deleted section';
    if (field.type === 'select' || field.type === 'multiselect') {
      const o = (field.def.options || []).find((o2) => (o2?.id ?? o2) === x);
      return o ? (o.label ?? o) : 'a deleted option';
    }
    if (kind === 'person') return ctx.nameOf?.(x) || String(x);
    if (kind === 'date') return formatDate(x, x);
    return String(x);
  };
  if (kind === 'list') {
    const xs = (Array.isArray(v) ? v : []).map(one);
    if (xs.length <= 1) return xs[0] || '';
    return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
  }
  if (kind === 'days') {
    const n = Number(v) || 0;
    return `${n} day${n === 1 ? '' : 's'}`;
  }
  if (kind === 'range') return `${(v || [])[0]} and ${(v || [])[1]}`;
  if (kind === 'text' && (field.kind === 'tag' || field.type === 'text')) return `"${v}"`;
  return one(v);
}

export function describeCondition(c, ctx = {}) {
  const field = fieldInfo(c?.field, ctx.fieldsById);
  if (!field) return String(c?.field || '').startsWith(CF_PREFIX) ? 'A deleted field' : 'An unknown field';
  const words = opLabel(field, c.op);
  const val = valueText(field, c.op, c.value, ctx);
  return `${field.subject || field.label} ${words}${val ? ` ${val}` : ''}`;
}

/** "Priority is Urgent and Due Date is overdue". */
export function describeRule(rule, ctx = {}) {
  return (Array.isArray(rule?.conditions) ? rule.conditions : []).map((c) => describeCondition(c, ctx))
    .join(rule?.match === 'any' ? ' or ' : ' and ');
}

// ── Suggested starters (added only when someone clicks Add) ─────────────────
/** Three ready-made rules. The third colors a held-up status when the project
 *  has one ("On Hold", "Blocked", "Waiting..."), else unassigned work. The
 *  second is named for what it tests - today through the next seven days -
 *  not "this week", which would end on Saturday. */
export function starterRules({ statusOrder = [], statusMeta = {} } = {}) {
  const held = statusOrder.filter((id) => /hold|block|wait|stuck|paus/i.test(own(statusMeta, id)?.label || ''));
  const third = held.length
    ? { name: held.length === 1 ? (own(statusMeta, held[0])?.label || 'On Hold') : 'On Hold or Blocked', color: 'gray',
      conditions: [held.length === 1 ? { field: 'status', op: 'is', value: held[0] } : { field: 'status', op: 'is_any_of', value: held }] }
    : { name: 'Unassigned', color: 'gray',
      conditions: [{ field: 'assignee', op: 'is_unassigned' }, { field: 'completed', op: 'is_false' }] };
  return [
    { name: 'Overdue', color: 'red', conditions: [{ field: 'due', op: 'overdue' }] },
    { name: 'Due In Next 7 Days', color: 'amber', conditions: [{ field: 'due', op: 'within', value: 7 }, { field: 'completed', op: 'is_false' }] },
    third,
  ].map((r) => ({ id: '', bold: false, enabled: true, match: 'all', ...r }));
}
