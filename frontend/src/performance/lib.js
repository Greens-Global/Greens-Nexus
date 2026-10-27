// Performance (Neil, Oct 27 2026): goals and 1:1s. Shared words and colors for
// Workday > Performance and People > Performance. The rules live on the
// server (backend/performance.py); this only draws what it says.
import { NX } from '../tasks/theme';
import { LOCAL_TZ } from '../lib/worldClockZones';

// Soft status labels (components/StatusLabel.jsx) - the color is the signal.
export const GOAL_STATUS = {
  on_track:  { label: 'On Track',  color: NX.green },
  at_risk:   { label: 'At Risk',   color: NX.amber },
  off_track: { label: 'Off Track', color: NX.red },
  done:      { label: 'Done',      color: NX.blue },
};
export const GOAL_STATUS_KEYS = ['on_track', 'at_risk', 'off_track', 'done'];

export const LEVEL_LABEL = { company: 'Company', department: 'Department', personal: 'Personal' };

export const MEASURES = [
  { key: 'percent', label: 'Percent', hint: 'Progress from 0% to 100%.' },
  { key: 'number', label: 'Number', hint: 'A count toward a target - calls made, sales closed.' },
  { key: 'done', label: 'Done / Not Done', hint: 'Either it is done or it is not.' },
];

export const CADENCES = [
  { key: 'once', label: 'Does Not Repeat' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'biweekly', label: 'Every 2 Weeks' },
  { key: 'monthly', label: 'Monthly' },
];

const num = (v) => {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

// "12 of 40 calls", "65%", "Done" / "Not Done".
export function measureText(g) {
  if (!g) return '';
  if (g.measure === 'done') return Number(g.currentValue) >= 1 ? 'Done' : 'Not Done';
  if (g.measure === 'number') return `${num(g.currentValue)} of ${num(g.targetValue)}${g.unit ? ` ${g.unit}` : ''}`;
  return `${num(g.currentValue)}%`;
}

// The viewer's own clock, for a new 1:1 (the series keeps its wall time on it).
export function localTimeZone() {
  return LOCAL_TZ || 'America/Los_Angeles';
}

// Workday sub keys: 'performance', 'performance:team',
// 'performance:goal:<id>', 'performance:1on1:<id>'.
export function parsePerfSub(sub) {
  const m = String(sub || '').match(/^performance(?::(team|goal|1on1)(?::(.+))?)?$/);
  if (!m) return null;
  return { view: m[1] === 'team' ? 'team' : 'me', goal: m[1] === 'goal' ? m[2] || '' : '', oneOnOne: m[1] === '1on1' ? m[2] || '' : '' };
}

export const card = {
  background: 'var(--card)', border: '1px solid var(--wk-line2)', borderRadius: 16,
  padding: '16px 18px', boxShadow: 'var(--wk-shadow)', minWidth: 0,
};
export const cardHead = { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12, flexWrap: 'wrap' };
export const HD = { fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' };
export const LBL = { fontSize: 12, fontWeight: 600, color: 'var(--muted)' };
export const muted = { fontSize: 12.5, color: 'var(--muted)' };
