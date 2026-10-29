// Performance, made simple (Neil, Oct 29 2026: "this really needs to be easy
// and it needs to provide some real metrics from Nexus"). Shared words and
// colors for Workday > Performance and People > Performance. The rules live
// on the server (backend/performance.py, perf_reviews.py, perf_metrics.py);
// this only draws what it says.
import { NX } from '../tasks/theme';
import { LOCAL_TZ } from '../lib/worldClockZones';

// Goal status is computed on the server - soft labels, the color is the signal.
export const GOAL_STATUS = {
  on_track: { label: 'On Track',    color: NX.green },
  at_risk:  { label: 'At Risk',     color: NX.amber },
  behind:   { label: 'Behind',      color: NX.red },
  off_track: { label: 'Behind',     color: NX.red },
  done:     { label: 'Done',        color: NX.blue },
  no_data:  { label: 'No Data Yet', color: '#64748b' },
};
export const GOAL_STATUS_KEYS = ['behind', 'at_risk', 'on_track', 'done', 'no_data'];

export const LEVEL_LABEL = { company: 'Company', department: 'Department', personal: 'Personal' };

// "I'll update it" goals - how the number is kept.
export const MEASURES = [
  { key: 'percent', label: 'Percent Done' },
  { key: 'number', label: 'A Number' },
  { key: 'done', label: 'Done or Not' },
];

export const CADENCES = [
  { key: 'once', label: 'Does Not Repeat' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'biweekly', label: 'Every 2 Weeks' },
  { key: 'monthly', label: 'Monthly' },
];

// My Numbers periods.
export const PERIODS = [
  { key: 'month', label: 'This Month' },
  { key: 'quarter', label: 'This Quarter' },
  { key: 'review', label: 'This Review' },
];

const num = (v) => {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

// "92% of 95%", "12 of 40 calls", "65%", "Done" / "Not Done", "1 (target 2 or fewer)".
export function measureText(g) {
  if (!g) return '';
  if (g.measuredByNexus) {
    if (g.status === 'no_data') return `Target ${num(g.targetValue)}${g.unit}`;
    const low = g.metricGood === 'low';
    return `${num(g.currentValue)}${g.unit} ${low ? `- target ${num(g.targetValue)} or fewer` : `of ${num(g.targetValue)}${g.unit}`}`;
  }
  if (g.measure === 'done') return Number(g.currentValue) >= 1 ? 'Done' : 'Not Done';
  if (g.measure === 'number') return `${num(g.currentValue)} of ${num(g.targetValue)}${g.unit ? ` ${g.unit}` : ''}`;
  return `${num(g.currentValue)}%`;
}

// The viewer's own clock, for a new 1:1 (the series keeps its wall time on it).
export function localTimeZone() {
  return LOCAL_TZ || 'America/Los_Angeles';
}

// Workday sub keys: 'performance', 'performance:team',
// 'performance:goal:<id>', 'performance:1on1:<id>', 'performance:review:<id>',
// 'performance:feedback:<id>', 'performance:kudos:<id>', 'performance:plan:<id>'.
export function parsePerfSub(sub) {
  const m = String(sub || '').match(/^performance(?::(team|goal|1on1|review|feedback|kudos|plan)(?::(.+))?)?$/);
  if (!m) return null;
  const id = (k) => (m[1] === k ? m[2] || '' : '');
  return { view: m[1] === 'team' ? 'team' : 'me', goal: id('goal'), oneOnOne: id('1on1'), review: id('review'),
    feedback: id('feedback'), kudos: id('kudos'), plan: id('plan') };
}

export const card = {
  background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16,
  padding: '16px 18px', boxShadow: 'var(--wk-shadow)', minWidth: 0,
};
export const cardHead = { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12, flexWrap: 'wrap' };
export const HD = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' };
export const LBL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)' };
export const muted = { fontSize: 12.5, color: 'var(--muted)' };
// A finger-sized button (phones).
export const TAP = { minHeight: 44 };

// Review stages (backend/perf_reviews.py STAGES) - soft labels.
export const REVIEW_STAGE = {
  self_review:    { label: 'Self Review',    color: NX.amber },
  manager_review: { label: 'Manager Review', color: NX.purple },
  ready:          { label: 'Ready to Share', color: NX.blue },
  hr_review:      { label: 'Ready to Share', color: NX.blue },
  shared:         { label: 'Shared',         color: NX.teal },
  complete:       { label: 'Acknowledged',   color: NX.green },
  removed:        { label: 'Removed',        color: '#64748b' },
};
export const REVIEW_STAGE_KEYS = ['self_review', 'manager_review', 'ready', 'shared', 'complete'];

// One Overall Rating in four words; a score per goal.
export const RATINGS = [
  { key: 'exceeds', label: 'Exceeds' },
  { key: 'meets', label: 'Meets' },
  { key: 'partly', label: 'Partly Meets' },
  { key: 'below', label: 'Below' },
];
export const GOAL_SCORES = [
  { key: 'met', label: 'Met' },
  { key: 'partly', label: 'Partly Met' },
  { key: 'not', label: 'Not Met' },
];
export const QUESTIONS = [
  { id: 'well', text: 'What went well?' },
  { id: 'better', text: 'What could be better?' },
  { id: 'next', text: 'What should the focus be next?' },
];
