// Operations > Reports: the period a report covers and how a schedule reads,
// as plain functions (tested in reportPeriod.test.js).
//
// A period is { mode: 'current' | 'previous' | 'manual', unit, from, to }.
// Current runs from the start of the unit to today; Previous is the whole unit
// before it; weeks start on Monday. "Today" is the facility's own calendar day
// (the page passes it), and dates are built from local parts, never
// toISOString(), so an evening in Pacific time is not already tomorrow.
import { formatDate } from '../lib/datetime';

export const UNITS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');
export const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function fromIso(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
export const todayIso = (asOf) => (DAY_RE.test(String(asOf || '')) ? asOf : toIso(new Date()));

function bounds(unit, t) {
  const y = t.getFullYear();
  const m = t.getMonth();
  const d = t.getDate();
  if (unit === 'day') return [t, t];
  if (unit === 'week') {
    const start = new Date(y, m, d - ((t.getDay() + 6) % 7));
    return [start, new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)];
  }
  if (unit === 'quarter') {
    const q = Math.floor(m / 3) * 3;
    return [new Date(y, q, 1), new Date(y, q + 3, 0)];
  }
  if (unit === 'year') return [new Date(y, 0, 1), new Date(y, 11, 31)];
  return [new Date(y, m, 1), new Date(y, m + 1, 0)];
}

// -> { from, to } as YYYY-MM-DD.
export function resolvePeriod(period, today) {
  const p = period || {};
  const now = todayIso(today);
  if (p.mode === 'manual') {
    const a = DAY_RE.test(p.from || '') ? p.from : now;
    const b = DAY_RE.test(p.to || '') ? p.to : now;
    return a <= b ? { from: a, to: b } : { from: b, to: a };
  }
  const unit = UNITS.some(([k]) => k === p.unit) ? p.unit : 'month';
  const t = fromIso(now);
  if (p.mode === 'previous') {
    const [start] = bounds(unit, t);
    const before = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
    const [a, b] = bounds(unit, before);
    return { from: toIso(a), to: toIso(b) };
  }
  const [a] = bounds(unit, t);
  return { from: toIso(a), to: now };
}

const unitLabel = (u) => (UNITS.find(([k]) => k === u) || UNITS[2])[1];

// "Current Month", "Previous Week", "Custom Dates"
export function periodName(period) {
  if (!period || period.mode === 'manual') return 'Custom Dates';
  return `${period.mode === 'previous' ? 'Previous' : 'Current'} ${unitLabel(period.unit)}`;
}

// "10/01/2026 - 10/20/2026", or one date when the period is one day.
export function rangeWords({ from, to } = {}) {
  if (!from) return '';
  return from === to || !to ? formatDate(from) : `${formatDate(from)} - ${formatDate(to)}`;
}

// The page's period dropdown as a starting point for a report's period.
export function fromPageRange(range) {
  if (range?.key === 'this-month') return { mode: 'current', unit: 'month' };
  if (range?.key === 'last-month') return { mode: 'previous', unit: 'month' };
  if (range?.key === 'this-year') return { mode: 'current', unit: 'year' };
  if (range?.from && range?.to) return { mode: 'manual', unit: 'month', from: range.from, to: range.to };
  return { mode: 'current', unit: 'month' };
}

// 8 -> "8:00 AM", 0 -> "12:00 AM", 13 -> "1:00 PM"
export function hourLabel(h) {
  const n = ((Number(h) || 0) % 24 + 24) % 24;
  return `${n % 12 || 12}:00 ${n < 12 ? 'AM' : 'PM'}`;
}

export function ordinal(n) {
  const v = Number(n) || 1;
  const s = v % 100 >= 11 && v % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
  return `${v}${s}`;
}

// "Every Monday at 8:00 AM", "Every weekday at 7:00 AM", "Monthly on the 1st at 9:00 AM".
// Weekly `day` is 0 = Monday ... 6 = Sunday; monthly `day` is the day of the month.
export function scheduleWords(s) {
  const at = hourLabel(s?.hour);
  if (s?.frequency === 'weekly') return `Every ${WEEKDAYS[Number(s.day) || 0] || 'Monday'} at ${at}`;
  if (s?.frequency === 'monthly') return `Monthly on the ${ordinal(s.day)} at ${at}`;
  return `${s?.includeWeekends === false ? 'Every weekday' : 'Every day'} at ${at}`;
}
