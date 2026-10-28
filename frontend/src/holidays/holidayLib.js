// Holiday policies (Neil, Oct 29 2026, docs/superpowers/specs/2026-10-29-holiday-policies-design.md):
// the words, groups and date arithmetic the policy editor and a company's
// Holiday Calendar share. Dates are 'YYYY-MM-DD' calendar days, read in local
// time (never UTC: 2027-07-04 must stay a Sunday everywhere), and shown only
// through lib/datetime.js.
import { formatDate, formatWeekday } from '../lib/datetime';

// What a policy does with a holiday that falls on a Saturday or Sunday. The
// rule is applied when a holiday is added from a source list; each holiday
// then keeps its own date. Keep The Date is the default (Neil: "let's not
// assume").
export const WEEKEND_RULES = [
  { id: 'keep', label: 'Keep The Date' },
  { id: 'nearest_weekday', label: 'Friday Before Or Monday After (Federal Rule)' },
  { id: 'next_monday', label: 'Always The Monday After' },
  { id: 'prior_friday', label: 'Always The Friday Before' },
  { id: 'not_observed', label: 'No Day Off' },
];
export const weekendRuleLabel = (id) => (WEEKEND_RULES.find(r => r.id === id) || WEEKEND_RULES[0]).label;

// Mandatory (everyone off) | Optional (an employee may choose to take it) |
// Half Day (the shift ends early).
export const HOLIDAY_TYPES = {
  mandatory: { label: 'Mandatory', color: '#64748b' },
  optional: { label: 'Optional', color: '#b45309' },
  half_day: { label: 'Half Day', color: '#2563eb' },
};
export const holidayTypeLabel = (t) => (HOLIDAY_TYPES[t] || HOLIDAY_TYPES.mandatory).label;

// A source list's scopes, in the order they are listed, with their headings.
export const SCOPE_GROUPS = [
  { id: 'federal', label: 'Federal Holidays' },
  { id: 'company_common', label: 'Common Company Holidays' },
  { id: 'state', label: 'Some States Only' },
  { id: 'national', label: 'National Holidays' },
  { id: 'gazetted', label: 'Gazetted Holidays' },
  { id: 'restricted', label: 'Restricted Holidays (Optional)' },
  { id: 'public', label: 'Public Holidays' },
];
export const scopeGroupOf = (scope) => {
  const s = String(scope || 'public');
  if (s.startsWith('state')) return 'state';
  return SCOPE_GROUPS.some(g => g.id === s) ? s : 'public';
};
// "state:CA,CT" -> "CA, CT"
export const stateCodes = (scope) => {
  const s = String(scope || '');
  return s.startsWith('state:') ? s.slice(6).split(',').filter(Boolean).join(', ') : '';
};

// Source rows grouped by scope, in SCOPE_GROUPS order, empty groups left out.
export function groupByScope(rows) {
  const by = {};
  for (const r of rows || []) (by[scopeGroupOf(r.scope)] ||= []).push(r);
  return SCOPE_GROUPS.filter(g => by[g.id]?.length).map(g => ({ ...g, rows: by[g.id] }));
}

// ── Calendar-day arithmetic ─────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
function parseDay(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
const toIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export function addDays(iso, n) {
  const d = parseDay(iso);
  if (!d) return iso;
  d.setDate(d.getDate() + n);
  return toIso(d);
}
// Whole days from `a` to `b` (calendar days, so daylight saving never shows).
export function daysBetween(a, b) {
  const x = parseDay(a), y = parseDay(b);
  return x && y ? Math.round((y - x) / 86400000) : NaN;
}
// 0 = Sunday ... 6 = Saturday; -1 when the value is not a date.
export const dayOfWeek = (iso) => { const d = parseDay(iso); return d ? d.getDay() : -1; };
export const isWeekend = (iso) => { const w = dayOfWeek(iso); return w === 0 || w === 6; };
export const yearOf = (iso) => Number(String(iso || '').slice(0, 4)) || 0;
// "07/04/2027 (Sunday)"
export const dateWithWeekday = (iso) => (iso ? `${formatDate(iso)} (${formatWeekday(iso)})` : '');

// The Friday before / Monday after a weekend day.
export const fridayBefore = (iso) => addDays(iso, dayOfWeek(iso) === 6 ? -1 : -2);
export const mondayAfter = (iso) => addDays(iso, dayOfWeek(iso) === 6 ? 2 : 1);

// The value an Observe On select uses for "no day off".
export const NO_DAY_OFF = 'none';

// The day a weekend rule gives a holiday on `iso` (or NO_DAY_OFF). A weekday
// holiday always keeps its date.
export function observedFor(iso, rule) {
  if (!isWeekend(iso)) return iso;
  const sat = dayOfWeek(iso) === 6;
  switch (rule) {
    case 'nearest_weekday': return sat ? addDays(iso, -1) : addDays(iso, 1);
    case 'next_monday': return mondayAfter(iso);
    case 'prior_friday': return fridayBefore(iso);
    case 'not_observed': return NO_DAY_OFF;
    default: return iso;
  }
}

// The choices for a weekend holiday: the real date, the Friday before, the
// Monday after, or no day off.
export function observeOptions(iso) {
  return [
    { value: iso, label: `The Date Itself - ${dateWithWeekday(iso)}` },
    { value: fridayBefore(iso), label: `Friday Before - ${formatDate(fridayBefore(iso))}` },
    { value: mondayAfter(iso), label: `Monday After - ${formatDate(mondayAfter(iso))}` },
    { value: NO_DAY_OFF, label: 'No Day Off' },
  ];
}

// A holiday's key inside a policy: '<countries>:<slug(name)>:<year of the
// real date>' - holiday_policies.make_key / slug on the server, kept identical.
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'holiday';
export const holidayKey = (country, name, realDate) => `${country || 'ALL'}:${slug(name)}:${yearOf(realDate)}`;

// The real calendar date of a holiday row (its date when not observed elsewhere).
export const realDateOf = (h) => h.actualDate || h.date;

// A policy holiday made from a source row, on the day the person chose.
export function rowFromSource(s, country, day) {
  return {
    key: holidayKey(country, s.name, s.date),
    date: day,
    actualDate: day !== s.date ? s.date : '',
    name: s.name,
    type: s.suggestedType || 'mandatory',
    countries: [country],
    scope: s.scope || 'public',
    tentative: !!s.tentative,
    source: 'public',
  };
}

// Is this source row already in the list of holidays (same key - or the same
// name and real date for the same country)?
export function findSourceRow(rows, s, country) {
  const key = holidayKey(country, s.name, s.date);
  return (rows || []).find(h => h.key === key
    || (h.name === s.name && realDateOf(h) === s.date && (h.countries || []).includes(country)));
}

// "Greens Global (2 added, 1 removed)" - one company of a save preview
// ({id, name, assigned, added, removed, changed, detached, changedSkipped, conflicts}).
const countOf = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
export function previewLine(c) {
  const parts = [];
  if (c.assigned === false) parts.push('no longer applies');
  const added = countOf(c.added), removed = countOf(c.removed), changed = countOf(c.changed);
  const detached = countOf(c.detached), kept = countOf(c.changedSkipped);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  if (changed) parts.push(`${changed} changed`);
  if (detached) parts.push(`${detached} the company changed ${detached === 1 ? 'stays' : 'stay'} as its own`);
  if (kept) parts.push(`${kept} left as the company changed or skipped ${kept === 1 ? 'it' : 'them'}`);
  return `${c.name} (${parts.length ? parts.join(', ') : 'no change'})`;
}
// "Christmas Day 12/25/2026 is also in US Holidays" - one per clash a save would cause.
export function conflictLines(companies) {
  const list = companies || [];
  return list.flatMap(c => (c.conflicts || []).map(x =>
    `${x.name} ${formatDate(x.date)} is also in ${x.with || "Company's Own Holidays"}${list.length > 1 ? ` at ${c.name}` : ''}`));
}
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const syncCount = (sync) => countOf(sync?.companies);

// Years a picker offers: `back` years before this one to five ahead, plus any
// the data already has.
export function yearOptions(extra = [], back = 0) {
  const now = new Date().getFullYear();
  const ys = new Set(Array.from({ length: 6 + back }, (_, i) => now - back + i));
  for (const y of extra) if (Number(y)) ys.add(Number(y));
  return [...ys].sort((a, b) => a - b);
}

// A company's country for the source picker: its own when a list exists for
// it, else the United States.
export const countryOfEntity = (e) => (e?.country && /^[A-Z]{2}$/.test(e.country) ? e.country : 'US');

// Shared inline styles for the holiday screens.
export const HINT = { fontSize: 12, color: 'var(--muted)', margin: 0, lineHeight: 1.5 };
export const SUBHEAD = { fontSize: 13, fontWeight: 700, margin: 0 };

// Where a company calendar row comes from, as its chip says it.
export const sourceLabel = (h) => (h.source === 'policy' ? (h.policyName || 'Policy') : h.source === 'public' ? 'Public' : 'Added By Hand');
