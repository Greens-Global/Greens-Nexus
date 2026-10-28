// Small pure helpers the builder's cards share (Oct 2026): the words for a
// recipient, a status chip's color, the kinds of recipient a picker offers,
// and the inline styles every card draws with. The sentence builders
// themselves live in lib/text.js (the shell's); this file never renders.
import { GitBranch, Hourglass, OctagonX, Repeat, ShieldCheck, Zap } from 'lucide-react';

export const STEP_ICONS = { action: Zap, if: GitBranch, approval: ShieldCheck, wait: Hourglass, for_each: Repeat, stop: OctagonX };

export const WORKFLOW_STATUS = {
  draft:           { label: 'Draft',           color: '#64748b' },
  active:          { label: 'Active',          color: '#16a34a' },
  paused:          { label: 'Paused',          color: '#d97706' },
  needs_attention: { label: 'Needs Attention', color: '#dc2626' },
  archived:        { label: 'Archived',        color: '#94a3b8' },
};

export const RUN_STEP_STATUS = {
  planned: { label: 'Planned', color: '#2563eb' },
  skipped: { label: 'Skipped', color: '#94a3b8' },
  done:    { label: 'Done',    color: '#16a34a' },
  failed:  { label: 'Failed',  color: '#dc2626' },
  waiting: { label: 'Waiting', color: '#d97706' },
};

// Recipient kinds that stand for a role on the record or in the company;
// the ones that need a value (a person, a role, a department, a team, a
// company) carry `needsValue`.
export const RECIPIENT_KINDS = [
  { kind: 'self',          label: 'The Person',            group: 'On The Record' },
  { kind: 'manager',       label: 'Their Manager',         group: 'On The Record' },
  { kind: 'hr_contact',    label: 'The HR Contact',        group: 'On The Record' },
  { kind: 'assignees',     label: 'The Assignees',         group: 'On The Record' },
  { kind: 'creator',       label: 'Who Created It',        group: 'On The Record' },
  { kind: 'followers',     label: 'The Followers',         group: 'On The Record' },
  { kind: 'approver',      label: 'The Approver',          group: 'On The Record' },
  { kind: 'owner',         label: 'The Workflow Owner',    group: 'In Nexus' },
  { kind: 'global_admins', label: 'The Global Admins',     group: 'In Nexus' },
  { kind: 'person',        label: 'A Person',              group: 'Pick', needsValue: 'person' },
  { kind: 'role',          label: 'A Role In The Company', group: 'Pick', needsValue: 'text' },
  { kind: 'department',    label: 'A Department',          group: 'Pick', needsValue: 'text' },
  { kind: 'team',          label: 'A Team',                group: 'Pick', needsValue: 'text' },
  { kind: 'company',       label: 'Everyone In The Company', group: 'Pick', needsValue: 'company' },
];

// The record roles an entity actually has (its catalog `people`), else the
// generic list; the Nexus and Pick groups are always offered.
export function recipientKindsFor(entityDef) {
  const onRecord = (entityDef?.people || []).map((p) => ({ kind: p.key, label: p.label, group: 'On The Record' }));
  const generic = RECIPIENT_KINDS.filter((k) => k.group !== 'On The Record');
  const rest = onRecord.length ? onRecord : RECIPIENT_KINDS.filter((k) => k.group === 'On The Record');
  return [...rest, ...generic];
}

export function recipientLabel(r, { people = [], companies = [], entityDef = null } = {}) {
  if (!r || !r.kind) return '';
  const kinds = recipientKindsFor(entityDef);
  const meta = kinds.find((k) => k.kind === r.kind) || RECIPIENT_KINDS.find((k) => k.kind === r.kind);
  if (r.kind === 'person') {
    const p = people.find((x) => x.email === r.value);
    return p?.name || r.value || 'A Person';
  }
  if (r.kind === 'company') {
    const c = companies.find((x) => String(x.id ?? x.value) === String(r.value));
    return c ? `Everyone at ${c.name || c.label}` : 'Everyone In The Company';
  }
  if (r.kind === 'role' || r.kind === 'department' || r.kind === 'team') {
    return r.value ? `${meta?.label.replace(/^A /, '')}: ${r.value}` : (meta?.label || r.kind);
  }
  return meta?.label || r.kind;
}

export function recipientsSentence(list, ctx) {
  const names = (list || []).map((r) => recipientLabel(r, ctx)).filter(Boolean);
  if (!names.length) return 'nobody yet';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const DURATION_UNITS = [
  { key: 'minutes', label: 'Minutes', minutes: 1 },
  { key: 'hours',   label: 'Hours',   minutes: 60 },
  { key: 'days',    label: 'Days',    minutes: 1440 },
];

// Minutes -> the largest whole unit that fits, for the duration control.
export function splitMinutes(total) {
  const n = Number(total) || 0;
  if (n > 0 && n % 1440 === 0) return { amount: n / 1440, unit: 'days' };
  if (n > 0 && n % 60 === 0) return { amount: n / 60, unit: 'hours' };
  return { amount: n, unit: 'minutes' };
}

export function joinMinutes(amount, unit) {
  const u = DURATION_UNITS.find((x) => x.key === unit) || DURATION_UNITS[0];
  return Math.max(0, Math.round(Number(amount) || 0)) * u.minutes;
}

export function durationWords(total) {
  const { amount, unit } = splitMinutes(total);
  const word = unit === 'days' ? 'day' : unit === 'hours' ? 'hour' : 'minute';
  return `${amount} ${word}${amount === 1 ? '' : 's'}`;
}

export const WEEKDAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 7, label: 'Sun' },
];

// A filter the Insert Field menu may append; the catalog's `filters` lead,
// this is the fallback when it carries none.
export const TEMPLATE_FILTERS = [
  { key: 'us_date', label: 'As A Date (MM/DD/YYYY)', suffix: ' | us_date' },
  { key: 'us_datetime', label: 'As A Date And Time', suffix: ' | us_datetime' },
  { key: 'upper', label: 'UPPER CASE', suffix: ' | upper' },
  { key: 'lower', label: 'lower case', suffix: ' | lower' },
  { key: 'default', label: 'Show "-" When Empty', suffix: ' | default:"-"' },
];

export function filterSuffix(key) {
  return TEMPLATE_FILTERS.find((f) => f.key === key)?.suffix || (key ? ` | ${key}` : '');
}

// Inserts `text` into `value` at the caret [start, end]; returns the new
// value and where the caret lands.
export function insertAtCaret(value, start, end, text) {
  const v = String(value || '');
  const s = Math.max(0, Math.min(start ?? v.length, v.length));
  const e = Math.max(s, Math.min(end ?? s, v.length));
  const next = v.slice(0, s) + text + v.slice(e);
  return { value: next, caret: s + text.length };
}

// Groups a list by `key(item)` keeping first-seen order: [[group, items]].
export function groupBy(list, key) {
  const map = new Map();
  (list || []).forEach((it) => {
    const k = key(it) || '';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  });
  return [...map.entries()];
}

export const MODULE_LABELS = {
  core: 'Nexus', hr: 'People', tasks: 'Tasks', tickets: 'Tickets', time: 'Time Clock',
  shifts: 'Shifts', items: 'Items', workflows: 'Workflows',
};
export const moduleLabel = (m) => MODULE_LABELS[m] || (m ? m.charAt(0).toUpperCase() + m.slice(1) : 'Other');

export const titleCase = (s) => String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── Styles the cards share ────────────────────────────────────────────────

export const card = {
  background: 'var(--nx-surface)', border: '1px solid var(--nx-border)', borderRadius: 14,
  padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
};
export const cardTitle = { fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--nx-faint)' };
export const sentence = { fontSize: 14, color: 'var(--nx-ink)', lineHeight: 1.45 };
export const hint = { fontSize: 12, color: 'var(--nx-dim)', lineHeight: 1.4 };
export const fieldLabel = { fontSize: 12, fontWeight: 600, color: 'var(--nx-dim)', marginBottom: 4, display: 'block' };
export const select = {
  padding: '7px 10px', borderRadius: 8, border: '1px solid var(--nx-border)', fontSize: 13,
  color: 'var(--nx-ink)', background: 'var(--nx-surface)', fontFamily: 'inherit', minWidth: 0, maxWidth: '100%',
};
export const textInput = { ...select, width: '100%', boxSizing: 'border-box' };
export const lane = { borderLeft: '2px solid var(--nx-border2)', marginLeft: 10, paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 8 };
export const laneTitle = { fontSize: 12, fontWeight: 700, color: 'var(--nx-dim)' };
export const chip = {
  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 999,
  background: 'var(--nx-surface2)', border: '1px solid var(--nx-border)', fontSize: 12.5, color: 'var(--nx-ink)',
};
export const iconBtn = {
  border: 'none', background: 'transparent', color: 'var(--nx-dim)', cursor: 'pointer', padding: 4,
  borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
};
