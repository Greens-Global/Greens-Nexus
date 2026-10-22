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
import { NX, PRIORITY_META } from './theme';
import { addDays, taskAssignees, isBlankValue } from './lib';
import { formatDate } from '../lib/datetime';

export const MAX_RULES = 20;
export const MAX_CONDITIONS = 5;
export const MAX_NAME = 60;
export const MAX_DAYS = 365;

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
export const colorHex = (key) => HEX[key] || HEX.gray;

// What value an operator takes - the same kinds as the server's OP_KIND.
export const OP_KIND = {
  is: 'text', is_not: 'text', is_any_of: 'list',
  is_me: 'none', is_not_me: 'none', is_unassigned: 'none', is_assigned: 'none',
  person_is: 'person', person_is_not: 'person',
  contains: 'text', not_contains: 'text', person_contains: 'person',
  is_empty: 'none', is_not_empty: 'none', is_true: 'none', is_false: 'none',
  overdue: 'none', past: 'none', today: 'none', within: 'days',
  before: 'date', after: 'date', on: 'date',
  eq: 'number', ne: 'number', gt: 'number', gte: 'number', lt: 'number', lte: 'number',
  between: 'range',
};

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
  if (BUILTIN[key]) return BUILTIN[key];
  if (!String(key || '').startsWith(CF_PREFIX)) return null;
  const def = fieldsById?.get?.(key.slice(CF_PREFIX.length));
  if (!def) return null;
  const type = (def.type || 'text').toLowerCase();
  const ops = CF_OPS[type];
  if (!ops) return null;
  return { key, label: def.name || 'Custom Field', kind: `cf-${type}`, type, ops, words: CF_WORDS[type], def };
}

export const opLabel = (field, op) => field?.words?.[op] || OP_LABEL[op] || op;

/** The fields the editor offers here: the built-ins (Section only where there
 *  are sections to pick) and the custom fields this scope uses. */
export function fieldChoices({ customFields = [], sections = [] } = {}) {
  const out = BUILTIN_FIELDS.filter((f) => f.key !== 'section' || sections.length > 0)
    .map((f) => ({ key: f.key, label: f.label }));
  for (const f of customFields) {
    if (CF_OPS[(f.type || 'text').toLowerCase()]) out.push({ key: `${CF_PREFIX}${f.id}`, label: f.name || 'Custom Field' });
  }
  return out;
}

// ── Defaults the editor fills in when a field or operator changes ────────────
export function defaultValue(op, field) {
  const kind = OP_KIND[op];
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
  const kind = OP_KIND[c.op];
  const v = c.value;
  if (kind === 'text' || kind === 'person' || kind === 'date') {
    if (v === undefined || v === null || String(v).trim() === '') return 'Pick a value.';
  }
  if (kind === 'list' && (!Array.isArray(v) || v.length === 0)) return 'Pick at least one value.';
  if (kind === 'days' && !(Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= MAX_DAYS)) return `Enter a whole number of days from 0 to ${MAX_DAYS}.`;
  if (kind === 'number' && (v === '' || v === null || !Number.isFinite(Number(v)))) return 'Enter a number.';
  if (kind === 'range' && (!Array.isArray(v) || v.length !== 2 || v.some((x) => x === '' || x === null || !Number.isFinite(Number(x))))) return 'Enter both numbers.';
  const vals = Array.isArray(v) && kind === 'list' ? v : [v];
  if ((field.type === 'select' || field.type === 'multiselect') && kind !== 'none') {
    const ids = new Set((field.def.options || []).map((o) => o?.id ?? o));
    if (vals.some((x) => !ids.has(x))) return 'An option this uses was deleted.';
  }
  if (field.kind === 'status' && ctx.statusMeta && vals.some((x) => !ctx.statusMeta[x])) return 'A status this uses was deleted.';
  if (field.kind === 'priority' && vals.some((x) => !PRIORITY_META[x])) return 'This priority is not known.';
  if (field.kind === 'section' && kind !== 'none' && Array.isArray(ctx.sections) && !ctx.sections.some((s) => s.id === v)) {
    return 'The section this uses was deleted.';
  }
  return '';
}

/** [{ index, text }] for every condition that needs attention. */
export function ruleProblems(rule, ctx = {}) {
  const out = [];
  (rule?.conditions || []).forEach((c, index) => {
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

// ── Evaluation ──────────────────────────────────────────────────────────────
const day = (v) => (v ? String(v).slice(0, 10) : '');

function dateMatches(op, d, value, task, today) {
  switch (op) {
    case 'overdue': return !!d && d < today && !task.completed;
    case 'past': return !!d && d < today;
    case 'today': return d === today;
    case 'within': return !!d && d >= today && d <= addDays(today, Number(value) || 0);
    case 'before': return !!d && d < day(value);
    case 'after': return !!d && d > day(value);
    case 'on': return !!d && d === day(value);
    case 'is_empty': return !d;
    case 'is_not_empty': return !!d;
    default: return false;
  }
}

const lowerList = (xs) => (Array.isArray(xs) ? xs : []).map((x) => String(x || '').toLowerCase()).filter(Boolean);

function personMatches(op, people, value, me) {
  switch (op) {
    case 'is_me': return !!me && people.includes(me);
    case 'is_not_me': return !me || !people.includes(me);
    case 'person_is': case 'person_contains': return people.includes(String(value || '').toLowerCase());
    case 'person_is_not': return !people.includes(String(value || '').toLowerCase());
    case 'is_unassigned': case 'is_empty': return people.length === 0;
    case 'is_assigned': case 'is_not_empty': return people.length > 0;
    default: return false;
  }
}

function customMatches(field, op, raw, value, task, ctx) {
  const blank = isBlankValue(raw);
  if (op === 'is_empty') return blank;
  if (op === 'is_not_empty') return !blank;
  switch (field.type) {
    case 'select':
      if (op === 'is') return raw === value;
      if (op === 'is_not') return raw !== value;
      if (op === 'is_any_of') return Array.isArray(value) && value.includes(raw);
      return false;
    case 'multiselect': {
      const have = Array.isArray(raw) ? raw : [];
      if (op === 'contains') return have.includes(value);
      if (op === 'not_contains') return !have.includes(value);
      return false;
    }
    case 'number': {
      if (blank) return false;
      const n = Number(raw);
      if (!Number.isFinite(n)) return false;
      const x = Number(value);
      switch (op) {
        case 'eq': return n === x;
        case 'ne': return n !== x;
        case 'gt': return n > x;
        case 'gte': return n >= x;
        case 'lt': return n < x;
        case 'lte': return n <= x;
        case 'between': {
          const [a, b] = (value || []).map(Number);
          return n >= Math.min(a, b) && n <= Math.max(a, b);
        }
        default: return false;
      }
    }
    case 'checkbox':
      return op === 'is_true' ? raw === true : raw !== true;
    case 'text': {
      const hay = String(raw ?? '').toLowerCase();
      const needle = String(value ?? '').toLowerCase();
      return op === 'contains' ? hay.includes(needle) : !hay.includes(needle);
    }
    case 'date':
      return dateMatches(op, day(raw), value, task, ctx.today);
    case 'people':
      return personMatches(op, lowerList(raw), value, ctx.me);
    default:
      return false;
  }
}

/** Does one (problem-free) condition hold for `task`?
 *  ctx: { today, me, fieldsById, sectionOf } */
export function conditionMatches(c, task, ctx) {
  const { op, value } = c;
  switch (c.field) {
    case 'status':
      if (op === 'is') return task.status === value;
      if (op === 'is_not') return task.status !== value;
      return Array.isArray(value) && value.includes(task.status);
    case 'priority':
      if (op === 'is') return task.priority === value;
      if (op === 'is_not') return task.priority !== value;
      return Array.isArray(value) && value.includes(task.priority);
    case 'assignee':
      return personMatches(op, lowerList(taskAssignees(task)), value, ctx.me);
    case 'created_by':
      return personMatches(op, lowerList([task.requesterId || task.ownerId]), value, ctx.me);
    case 'tags': {
      const tags = lowerList(task.tags);
      if (op === 'is_empty') return tags.length === 0;
      if (op === 'is_not_empty') return tags.length > 0;
      const want = String(value || '').trim().toLowerCase();
      return op === 'contains' ? tags.includes(want) : !tags.includes(want);
    }
    case 'section': {
      const sid = (ctx.sectionOf ? ctx.sectionOf(task) : task.sectionId) || '';
      if (op === 'is_empty') return !sid;
      return op === 'is' ? sid === value : sid !== value;
    }
    case 'due': return dateMatches(op, day(task.dueOn), value, task, ctx.today);
    case 'start': return dateMatches(op, day(task.startOn), value, task, ctx.today);
    case 'completed': return op === 'is_true' ? !!task.completed : !task.completed;
    default: {
      const field = fieldInfo(c.field, ctx.fieldsById);
      if (!field?.def) return false;
      return customMatches(field, op, (task.customFieldValues || {})[field.def.id], value, task, ctx);
    }
  }
}

/** The rules that can color anything: enabled, and nothing in them broken. */
export function usableRules(rules, ctx = {}) {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => r && r.enabled !== false && Array.isArray(r.conditions) && r.conditions.length > 0
      && ruleProblems(r, ctx).length === 0);
}

export function ruleMatches(rule, task, ctx) {
  const test = (c) => conditionMatches(c, task, ctx);
  return rule.match === 'any' ? rule.conditions.some(test) : rule.conditions.every(test);
}

/** The rule that colors `task` - the first usable one that matches - or null.
 *  `usable` is usableRules(...) worked out once for the whole list. */
export function firstMatch(usable, task, ctx) {
  if (!task || task.type === 'section') return null;
  for (const r of usable) if (ruleMatches(r, task, ctx)) return r;
  return null;
}

/** taskId -> { id, name, color, hex, bold } for every task a rule colors.
 *  ctx needs `today` (todayISO()) and `me` (lowercased email). */
export function colorMap(rules, tasks, ctx = {}) {
  const out = new Map();
  const usable = usableRules(rules, ctx);
  if (!usable.length) return out;
  const c = { ...ctx, me: String(ctx.me || '').toLowerCase() };
  for (const t of tasks || []) {
    const r = firstMatch(usable, t, c);
    if (r) out.set(t.id, { id: r.id, name: r.name, color: r.color, hex: colorHex(r.color), bold: !!r.bold });
  }
  return out;
}

// ── Plain-English summaries ──────────────────────────────────────────────────
// ctx: { fieldsById, statusMeta, sections, nameOf(email) }
function valueText(field, op, v, ctx) {
  const kind = OP_KIND[op];
  if (kind === 'none' || v === undefined) return '';
  const one = (x) => {
    if (field.kind === 'status') return ctx.statusMeta?.[x]?.label || String(x);
    if (field.kind === 'priority') return PRIORITY_META[x]?.label || String(x);
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
  return (rule?.conditions || []).map((c) => describeCondition(c, ctx))
    .join(rule?.match === 'any' ? ' or ' : ' and ');
}

// ── Suggested starters (added only when someone clicks Add) ─────────────────
/** Three ready-made rules. The third colors a held-up status when the project
 *  has one ("On Hold", "Blocked", "Waiting..."), else unassigned work. */
export function starterRules({ statusOrder = [], statusMeta = {} } = {}) {
  const held = statusOrder.filter((id) => /hold|block|wait|stuck|paus/i.test(statusMeta[id]?.label || ''));
  const third = held.length
    ? { name: held.length === 1 ? (statusMeta[held[0]]?.label || 'On Hold') : 'On Hold or Blocked', color: 'gray',
      conditions: [held.length === 1 ? { field: 'status', op: 'is', value: held[0] } : { field: 'status', op: 'is_any_of', value: held }] }
    : { name: 'Unassigned', color: 'gray',
      conditions: [{ field: 'assignee', op: 'is_unassigned' }, { field: 'completed', op: 'is_false' }] };
  return [
    { name: 'Overdue', color: 'red', conditions: [{ field: 'due', op: 'overdue' }] },
    { name: 'Due This Week', color: 'amber', conditions: [{ field: 'due', op: 'within', value: 7 }, { field: 'completed', op: 'is_false' }] },
    third,
  ].map((r) => ({ id: '', bold: false, enabled: true, match: 'all', ...r }));
}
