// The sentence builder (Oct 28 2026): every card in the builder, every row in
// the list and every line of a run reads as prose built from the definition
// and the catalog GET /workflows/catalog returned. Pure - no React, no API -
// so the builder, the list and the tests all say the same thing.
//
//   describeTrigger(trigger, catalog)        -> "When time off is decided, only when Status changed to Approved"
//   describeCondition(row, entityDef)        -> "Department is Sales"
//   describeStep(step, catalog)              -> "Send Email to their manager and the HR contact: 'Probation ends in 14 days'"
//   describeWorkflow(definition, catalog)    -> one line per card, nested steps indented
//
// Action names keep the catalog's Title Case label; everything around them is
// sentence case. Dates go through formatDate (MM/DD/YYYY), times through
// formatHHMM (12-hour). Plain hyphens only.
import { formatDate, formatHHMM } from '../../lib/datetime';

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const OP_WORDS = {
  is: 'is', is_not: 'is not', is_any_of: 'is any of', contains: 'contains', includes: 'includes',
  is_empty: 'is empty', is_not_empty: 'is not empty',
  gt: 'is greater than', lt: 'is less than', before: 'is before', after: 'is after',
  within_next_days: 'is within the next', within_last_days: 'was within the last',
  changed: 'changed', changed_to: 'changed to', changed_from: 'changed from',
};

const RECIPIENT_WORDS = {
  self: 'the person', manager: 'their manager', hr_contact: 'the HR contact', assignees: 'the assignees',
  creator: 'the creator', followers: 'the followers', approver: 'the approver', owner: 'the owner',
  global_admins: 'the Global Admins',
};

// ---- catalog lookups (every one tolerates a missing catalog) ----

const list = (catalog, key) => (Array.isArray(catalog?.[key]) ? catalog[key] : []);
export const findEntity = (catalog, key) => list(catalog, 'entities').find((e) => e.key === key) || null;
export const findEvent = (catalog, key) => list(catalog, 'events').find((e) => e.key === key) || null;
export const findAction = (catalog, key) => list(catalog, 'actions').find((a) => a.key === key) || null;
export const findListSource = (catalog, key) => list(catalog, 'listSources').find((s) => s.key === key) || null;

/** The entity a trigger is about: the event's entity, or the trigger's own. */
export function triggerEntity(trigger, catalog) {
  if (!trigger) return null;
  if (trigger.kind === 'event') return findEntity(catalog, findEvent(catalog, trigger.event)?.entity);
  return findEntity(catalog, trigger.entity);
}

function fieldOf(entityDef, key) {
  if (!key) return null;
  const k = String(key);
  const fields = Array.isArray(entityDef?.fields) ? entityDef.fields : [];
  const dates = Array.isArray(entityDef?.dates) ? entityDef.dates : [];
  const people = Array.isArray(entityDef?.people) ? entityDef.people : [];
  return fields.find((f) => f.key === k) || dates.find((f) => f.key === k) || people.find((f) => f.key === k)
    // "subject.status" and "status" name the same field.
    || fields.find((f) => `subject.${f.key}` === k) || null;
}

const humanKey = (key) => {
  const last = String(key || '').split('.').pop();
  return last.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
};

export const fieldLabel = (entityDef, key) => fieldOf(entityDef, key)?.label || humanKey(key);

// ---- values ----

const titleCase = (s) => String(s || '').replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const article = (noun) => `${/^[aeiou]/i.test(String(noun || '')) ? 'an' : 'a'} ${noun}`;

function optionLabel(field, v) {
  const opts = field?.options;
  if (!opts) return titleCase(v);
  if (Array.isArray(opts)) {
    const hit = opts.find((o) => (typeof o === 'string' ? o === v : o?.key === v || o?.value === v));
    if (hit == null) return titleCase(v);
    return typeof hit === 'string' ? hit : (hit.label || titleCase(hit.key ?? hit.value));
  }
  if (typeof opts === 'object') return opts[v] ?? titleCase(v);
  return titleCase(v);
}

const quote = (s) => `'${String(s)}'`;

export function joinWords(items, word = 'and') {
  const xs = (items || []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`;
}

/** A condition / filter value in words, by the field's type. */
export function describeValue(value, field) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return joinWords(value.map((v) => describeValue(v, field)), 'or');
  const type = field?.type || (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : 'text');
  if (type === 'select' || field?.options) return optionLabel(field, value);
  if (type === 'bool') return value === true || value === 'true' || value === 1 ? 'Yes' : 'No';
  if (type === 'date' || type === 'datetime') return formatDate(value, String(value));
  if (type === 'money') {
    const n = Number(value);
    return Number.isFinite(n) ? `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : String(value);
  }
  if (type === 'number') return String(value);
  return quote(value);
}

const plural = (n, one, many = `${one}s`) => `${n} ${Math.abs(Number(n)) === 1 ? one : many}`;

/** "45 minutes", "2 hours", "3 days", "1 hour and 30 minutes". */
export function durationWords(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m === 0) return 'no time';
  if (m % 1440 === 0) return plural(m / 1440, 'day');
  if (m % 60 === 0) return plural(m / 60, 'hour');
  if (m > 60) return `${plural(Math.floor(m / 60), 'hour')} and ${plural(m % 60, 'minute')}`;
  return plural(m, 'minute');
}

const ordinal = (n) => {
  const x = Number(n);
  const s = ['th', 'st', 'nd', 'rd'][(x % 100 > 10 && x % 100 < 14) ? 0 : Math.min(x % 10, 4) % 4] || 'th';
  return `${x}${s}`;
};

/** "14 days before", "on", "3 days after". */
function offsetWords(offsetDays) {
  const n = Number(offsetDays) || 0;
  if (n === 0) return 'on';
  return `${plural(Math.abs(n), 'day')} ${n < 0 ? 'before' : 'after'}`;
}

const atTime = (t) => (t ? ` at ${formatHHMM(t, t)}` : '');

// ---- recipients ----

/** A recipient spec (one, or a list) in words. */
export function describeRecipients(spec) {
  const items = spec == null ? [] : Array.isArray(spec) ? spec : [spec];
  const words = items.map((r) => {
    if (r == null || r === '') return '';
    if (typeof r === 'string') return RECIPIENT_WORDS[r] || r;
    const kind = r.kind || r.type || '';
    const value = r.value ?? r.email ?? r.name ?? '';
    if (RECIPIENT_WORDS[kind]) return RECIPIENT_WORDS[kind];
    if (kind === 'person') return r.name || value || 'a person';
    if (kind === 'role') return value ? `everyone with the role ${titleCase(value)}` : 'a role';
    if (kind === 'department') return value ? `the ${value} department` : 'a department';
    if (kind === 'team') return value ? `the ${value} team` : 'a team';
    if (kind === 'company') return value ? `everyone at ${value}` : 'a company';
    return value ? String(value) : (kind ? titleCase(kind) : '');
  }).filter(Boolean);
  return joinWords(words) || 'nobody yet';
}

// ---- conditions ----

/** One condition row: "<Field> <op> <value>". */
export function describeCondition(row, entityDef) {
  if (!row || !row.field) return 'a condition (not set yet)';
  const field = fieldOf(entityDef, row.field);
  const label = fieldLabel(entityDef, row.field);
  const op = String(row.op || 'is');
  const words = OP_WORDS[op] || op.replace(/_/g, ' ');
  if (op === 'is_empty' || op === 'is_not_empty' || op === 'changed') return `${label} ${words}`;
  if (op === 'within_next_days' || op === 'within_last_days') return `${label} ${words} ${plural(Number(row.value) || 0, 'day')}`;
  const v = describeValue(row.value, field);
  return v ? `${label} ${words} ${v}` : `${label} ${words} (not set yet)`;
}

/** Groups are OR, rows are AND: "A and B, or C". */
export function describeConditions(groups, entityDef) {
  const gs = (Array.isArray(groups) ? groups : []).map((g) => (Array.isArray(g) ? g : []).filter(Boolean)).filter((g) => g.length);
  if (!gs.length) return '';
  const parts = gs.map((g) => g.map((r) => describeCondition(r, entityDef)).join(' and '));
  return parts.length === 1 ? parts[0] : parts.join(', or ');
}

// ---- trigger ----

export function describeTrigger(trigger, catalog) {
  if (!trigger || !trigger.kind) return 'When something happens (not chosen yet)';
  const entity = triggerEntity(trigger, catalog);
  if (trigger.kind === 'event') {
    const ev = findEvent(catalog, trigger.event);
    const what = ev?.label ? ev.label.replace(/^\w/, (c) => c.toLowerCase()) : (trigger.event || 'an event happens (not chosen yet)');
    const filters = (trigger.filters || []).filter((f) => f && f.field);
    const only = filters.length ? `, only when ${filters.map((f) => describeCondition(f, entity)).join(' and ')}` : '';
    return `When ${what}${only}`;
  }
  if (trigger.kind === 'schedule') {
    const every = trigger.every || 'day';
    const days = (Array.isArray(trigger.days) ? trigger.days : []).map(Number).filter((d) => d > 0);
    const when = atTime(trigger.time);
    if (every === 'week') {
      const names = days.map((d) => WEEKDAYS[d]).filter(Boolean);
      return `Every week${names.length ? ` on ${joinWords(names)}` : ''}${when}`;
    }
    if (every === 'month') {
      return `Every month${days.length ? ` on the ${joinWords(days.map(ordinal))}` : ''}${when}`;
    }
    return `Every day${when}`;
  }
  if (trigger.kind === 'date') {
    const label = fieldLabel(entity, trigger.field);
    const subject = entity?.label ? ` of ${entity.label.toLowerCase()}` : '';
    const off = offsetWords(trigger.offsetDays);
    return `${off === 'on' ? 'On' : off.replace(/^\w/, (c) => c.toUpperCase())} ${label}${subject}${atTime(trigger.time)}`;
  }
  if (trigger.kind === 'manual') {
    return `Started by hand on ${entity?.label ? article(entity.label.toLowerCase()) : 'a record'}`;
  }
  return `When ${titleCase(trigger.kind).toLowerCase()}`;
}

// ---- steps ----

const TEMPLATE_MAX = 80;
const short = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > TEMPLATE_MAX ? `${t.slice(0, TEMPLATE_MAX - 3).trimEnd()}...` : t;
};

/** The pieces that make an action read as a sentence: who it goes to and the
 *  first template or text it carries. */
function actionDetail(action, params) {
  const p = params || {};
  const defs = Array.isArray(action?.params) ? action.params : [];
  const typed = (type) => defs.find((d) => d.type === type && p[d.key] != null && p[d.key] !== '');
  const bits = [];
  const rec = typed('recipients') || (p.to != null ? { key: 'to' } : p.recipients != null ? { key: 'recipients' } : null);
  if (rec) bits.push(` to ${describeRecipients(p[rec.key])}`);
  const person = typed('person');
  if (person) bits.push(` for ${describeRecipients(p[person.key])}`);
  const ref = typed('entity_ref') || typed('select');
  if (ref) bits.push(` (${ref.label}: ${describeValue(p[ref.key], ref)})`);
  const text = defs.find((d) => (d.type === 'template' || d.type === 'text') && p[d.key])
    || (p.subject ? { key: 'subject' } : p.title ? { key: 'title' } : p.message ? { key: 'message' } : p.text ? { key: 'text' } : null);
  const tail = text ? `: ${quote(short(p[text.key]))}` : '';
  return `${bits.join('')}${tail}`;
}

export function describeStep(step, catalog) {
  if (!step || !step.kind) return 'A step (not set yet)';
  const off = step.enabled === false ? 'Skipped: ' : '';
  const p = step.params || {};
  switch (step.kind) {
    case 'action': {
      const action = findAction(catalog, step.action);
      const name = action?.label || (step.action ? titleCase(step.action) : 'Do something (not chosen yet)');
      return `${off}${name}${actionDetail(action, p)}`;
    }
    case 'if': {
      // describeWorkflow passes the trigger's entity as step.entityDef so
      // fields read by label; a bare step reads them by key.
      const c = describeConditions(step.conditions, step.entityDef);
      return `${off}If ${c || '(no condition yet)'}`;
    }
    case 'approval': {
      const opts = Array.isArray(p.options) && p.options.length ? ` (${p.options.join(' / ')})` : '';
      const q = p.question ? `: ${quote(short(p.question))}` : '';
      const mode = p.mode === 'all' ? ', everyone must answer' : p.mode === 'sequence' ? ', one at a time' : '';
      return `${off}Ask ${describeRecipients(p.approvers)} for approval${q}${opts}${mode}`;
    }
    case 'wait': {
      if (p.mode === 'business_morning') return `${off}Wait until the next business morning`;
      if (p.mode === 'until') {
        const o = offsetWords(p.offsetDays);
        return `${off}Wait until ${o === 'on' ? '' : `${o} `}${fieldLabel(step.entityDef, p.field)}`;
      }
      return `${off}Wait ${durationWords(p.minutes)}`;
    }
    case 'for_each': {
      const src = findListSource(catalog, step.source?.key);
      const name = src?.label || (step.source?.key ? titleCase(step.source.key) : 'a list (not chosen yet)');
      return `${off}For each of ${name}${step.as && step.as !== 'item' ? ` as ${step.as}` : ''}`;
    }
    case 'stop':
      return `${off}Stop`;
    default:
      return `${off}${titleCase(step.kind)}`;
  }
}

// ---- the whole workflow ----

const INDENT = '  ';

function stepLines(steps, catalog, entityDef, depth, out) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step) continue;
    const pad = INDENT.repeat(depth);
    const withEntity = step.kind === 'if' || step.kind === 'wait' ? { ...step, entityDef } : step;
    out.push(`${pad}${describeStep(withEntity, catalog)}`);
    if (step.kind === 'if') {
      out.push(`${pad}${INDENT}Then`);
      stepLines(step.then, catalog, entityDef, depth + 2, out);
      if (Array.isArray(step.else) && step.else.length) {
        out.push(`${pad}${INDENT}Else`);
        stepLines(step.else, catalog, entityDef, depth + 2, out);
      }
    } else if (step.kind === 'approval') {
      const branches = step.branches || {};
      for (const key of Object.keys(branches)) {
        if (!Array.isArray(branches[key]) || !branches[key].length) continue;
        out.push(`${pad}${INDENT}${key === 'expired' ? 'If nobody answers' : `If ${key}`}`);
        stepLines(branches[key], catalog, entityDef, depth + 2, out);
      }
    } else if (step.kind === 'for_each') {
      stepLines(step.steps, catalog, entityDef, depth + 1, out);
    }
  }
}

/** One line per card, top to bottom, nested steps indented by two spaces. */
export function describeWorkflow(definition, catalog) {
  const d = definition || {};
  const entity = triggerEntity(d.trigger, catalog);
  const out = [describeTrigger(d.trigger, catalog)];
  const only = describeConditions(d.conditions, entity);
  if (only) out.push(`Only if ${only}`);
  if (!Array.isArray(d.steps) || !d.steps.length) out.push('Do nothing yet');
  else stepLines(d.steps, catalog, entity, 0, out);
  const fault = d.settings?.faultSteps;
  if (Array.isArray(fault) && fault.length) {
    out.push('If a step fails');
    stepLines(fault, catalog, entity, 1, out);
  }
  return out;
}
