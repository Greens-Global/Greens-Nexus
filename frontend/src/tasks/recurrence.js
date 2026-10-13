// Task recurrence rules - the shapes, labels and date math the Create Task form
// and the task drawer share (Oct 13 2026, Asana parity: "the 4th Friday of the
// month", "the last day of the month", Periodically out to 240 days and any
// number past that). The server computes the real dates (routers/tasks.py
// _next_due); nextDue below mirrors it so the editors can show what a rule
// will actually do before it is saved.
//
// A rule: { freq, interval?, daysOfWeek?, dayOfMonth?, weekOfMonth?, weekday?,
//           monthOfYear?, unit?, daysAfterCompletion?, until?, count? }
//   dayOfMonth   1-31, or -1 = the last day of the month
//   weekOfMonth  1-5, or -1 = the last one ("the last Friday")
//   weekday      0=Sunday..6=Saturday - goes with weekOfMonth
//   monthOfYear  1-12, for a yearly weekday rule ("of November")
import { fmtDate } from './lib';

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const WEEKS_OF_MONTH = [
  { value: 1, label: 'First' }, { value: 2, label: 'Second' }, { value: 3, label: 'Third' },
  { value: 4, label: 'Fourth' }, { value: 5, label: 'Fifth' }, { value: -1, label: 'Last' },
];
// Periodically: the common counts as one-click presets; "Other" takes any
// whole number up to MAX_PERIODIC_DAYS (the server's cap).
export const PERIODIC_PRESETS = [1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30, 45, 60, 90, 120, 150, 180, 210, 240];
export const MAX_PERIODIC_DAYS = 3650;

export const clampDays = (n) => Math.min(MAX_PERIODIC_DAYS, Math.max(1, Math.round(Number(n) || 1)));
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
const hasWeekdayRule = (r) => r && r.weekOfMonth != null && r.weekOfMonth !== '' && r.weekday != null && r.weekday !== '';

/** "on the 4th Friday", "on the last day", "on day 5" - or '' when the rule
 *  names no day. */
export function monthDayLabel(r) {
  if (hasWeekdayRule(r)) {
    const which = Number(r.weekOfMonth) === -1 ? 'last' : ORD[r.weekOfMonth] || `${r.weekOfMonth}th`;
    return `on the ${which} ${DAYS[r.weekday] || ''}`.trim();
  }
  if (r?.dayOfMonth != null && r.dayOfMonth !== '') return Number(r.dayOfMonth) === -1 ? 'on the last day' : `on day ${r.dayOfMonth}`;
  return '';
}

function yearDayLabel(r) {
  if (!hasWeekdayRule(r)) return '';
  const month = r.monthOfYear ? ` of ${MONTHS[r.monthOfYear - 1]}` : '';
  return `${monthDayLabel(r)}${month}`;
}

/** One line for a rule, as the drawer and exports show it. */
export function recurrenceLabel(r) {
  if (!r || !r.freq) return 'Does not repeat';
  let base;
  if (r.freq === 'daily') base = 'Every day';
  else if (r.freq === 'weekly') {
    // daysOfWeek is the real field; dayOfWeek (singular) is a one-item
    // fallback for a series created before multi-day weekly existed.
    const days = r.daysOfWeek ?? (r.dayOfWeek != null ? [r.dayOfWeek] : [1]);
    base = `Every week on ${days.map((d) => DAY_ABBR[d]).join(', ')}`;
  } else if (r.freq === 'monthly') base = `Every month ${monthDayLabel(r) || `on day ${r.dayOfMonth ?? 1}`}`;
  else if (r.freq === 'yearly') base = `Every year${yearDayLabel(r) ? ` ${yearDayLabel(r)}` : ''}`;
  else if (r.freq === 'periodic') {
    const n = r.daysAfterCompletion ?? 1;
    base = `${n} day${n === 1 ? '' : 's'} after completion`;
  } else if (r.freq === 'custom') {
    const n = r.interval ?? 1;
    const unit = { day: 'day', week: 'week', month: 'month', year: 'year' }[r.unit] || 'week';
    base = `Every ${n === 1 ? '' : `${n} `}${unit}${n === 1 ? '' : 's'}`;
    if (r.unit === 'week' && r.daysOfWeek?.length) base += ` on ${r.daysOfWeek.map((d) => DAY_ABBR[d]).join(', ')}`;
    if (r.unit === 'month' && monthDayLabel(r)) base += ` ${monthDayLabel(r)}`;
    if (r.unit === 'year' && yearDayLabel(r)) base += ` ${yearDayLabel(r)}`;
  } else return 'Does not repeat';
  if (r.until) base += ` until ${fmtDate(r.until)}`;
  else if (r.count) base += ` × ${r.count}`;
  return base;
}

// ── Date math (mirrors routers/tasks.py) ────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const daysIn = (y, m0) => new Date(y, m0 + 1, 0).getDate();
const addMonths = (d, n) => {
  const m = d.getMonth() + n;
  const y = d.getFullYear() + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return new Date(y, mm, Math.min(d.getDate(), daysIn(y, mm)));
};

/** The `week`-th `weekday` of a month (month0 is 0-11). A 5th the month does
 *  not have falls back to its last one. */
export function nthWeekday(year, month0, week, weekday) {
  if (Number(week) < 0) {
    const d = new Date(year, month0, daysIn(year, month0));
    d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7));
    return d;
  }
  const d = new Date(year, month0, 1);
  d.setDate(1 + ((weekday - d.getDay() + 7) % 7) + 7 * (Math.max(1, week) - 1));
  if (d.getMonth() !== month0) d.setDate(d.getDate() - 7);
  return d;
}

/** The date after `iso` per a calendar rule (not Periodically, which counts
 *  from the day it is completed). '' when there is no rule. */
export function nextDue(iso, r) {
  if (!r?.freq || r.freq === 'periodic' || !iso) return '';
  const base = fromIso(iso);
  const interval = Math.max(1, Number(r.interval) || 1);
  const cadence = r.freq === 'custom' ? (r.unit || 'day') : r.freq;
  if (cadence === 'weekly' || cadence === 'week') {
    const days = r.daysOfWeek ?? (r.dayOfWeek != null ? [r.dayOfWeek] : null);
    if (!days?.length) { const d = new Date(base); d.setDate(d.getDate() + 7 * interval); return toIso(d); }
    const d = new Date(base);
    do { d.setDate(d.getDate() + 1); } while (!days.map(Number).includes(d.getDay()));
    d.setDate(d.getDate() + 7 * (interval - 1));
    return toIso(d);
  }
  if (cadence === 'monthly' || cadence === 'month') {
    if (hasWeekdayRule(r)) {
      const here = nthWeekday(base.getFullYear(), base.getMonth(), Number(r.weekOfMonth), Number(r.weekday));
      if (here > base) return toIso(here);
      const m = addMonths(new Date(base.getFullYear(), base.getMonth(), 1), interval);
      return toIso(nthWeekday(m.getFullYear(), m.getMonth(), Number(r.weekOfMonth), Number(r.weekday)));
    }
    const nxt = addMonths(base, interval);
    if (r.dayOfMonth) {
      const last = daysIn(nxt.getFullYear(), nxt.getMonth());
      nxt.setDate(Number(r.dayOfMonth) < 0 ? last : Math.min(Number(r.dayOfMonth), last));
    }
    return toIso(nxt);
  }
  if (cadence === 'yearly' || cadence === 'year') {
    if (hasWeekdayRule(r)) {
      const m0 = (Number(r.monthOfYear) || base.getMonth() + 1) - 1;
      const here = nthWeekday(base.getFullYear(), m0, Number(r.weekOfMonth), Number(r.weekday));
      if (here > base) return toIso(here);
      return toIso(nthWeekday(base.getFullYear() + interval, m0, Number(r.weekOfMonth), Number(r.weekday)));
    }
    return toIso(addMonths(base, 12 * interval));
  }
  const d = new Date(base);
  d.setDate(d.getDate() + interval);
  return toIso(d);
}

/** The next `n` dates after `iso`, honoring until / count. */
export function upcomingDates(r, iso, n = 3) {
  const out = [];
  let cur = iso;
  const left = r?.count ? Math.max(0, Number(r.count) - 1) : Infinity;
  while (out.length < Math.min(n, left)) {
    const nx = nextDue(cur, r);
    if (!nx || nx <= cur || (r.until && nx > r.until)) break;
    out.push(nx);
    cur = nx;
  }
  return out;
}

/** The first date on or after `iso` that a rule lands on - what a new task's
 *  Due Date should be when it was left empty and the rule names a day. ''
 *  for a rule that names none (Daily, Periodically, a plain Yearly). */
export function firstDueOnOrAfter(r, iso) {
  if (!r?.freq || !iso) return '';
  const names = hasWeekdayRule(r) || r.dayOfMonth || (r.daysOfWeek?.length && (r.freq === 'weekly' || r.unit === 'week'));
  if (!names) return '';
  const day = fromIso(iso);
  if (r.dayOfMonth && !hasWeekdayRule(r)) {
    const pick = (y, m0) => new Date(y, m0, Number(r.dayOfMonth) < 0 ? daysIn(y, m0) : Math.min(Number(r.dayOfMonth), daysIn(y, m0)));
    const here = pick(day.getFullYear(), day.getMonth());
    return toIso(here >= day ? here : pick(day.getFullYear(), day.getMonth() + 1));
  }
  // The weekday and weekly rules land on the first match strictly after
  // their base, so start from the day before.
  const before = new Date(day); before.setDate(before.getDate() - 1);
  return nextDue(toIso(before), { ...r, interval: 1 });
}

/** The day-naming fields a due date reads as - "10/23/2026" is the 4th
 *  Friday, day 23, of October - to seed a rule from the date already set. */
export function ruleFromDate(iso) {
  if (!iso) return { dayOfMonth: 1, weekOfMonth: 1, weekday: 1, monthOfYear: 1 };
  const d = fromIso(iso);
  const nth = Math.ceil(d.getDate() / 7);
  return {
    dayOfMonth: d.getDate(),
    // A 5th weekday reads as "the last" - a 5th only exists some months.
    weekOfMonth: nth >= 5 ? -1 : nth,
    weekday: d.getDay(),
    monthOfYear: d.getMonth() + 1,
  };
}

/** The day-naming part of a monthly (or custom month) rule, as the editors
 *  hold it: { dayOfMonth } or { weekOfMonth, weekday }. */
export function monthRuleOf(r) {
  if (hasWeekdayRule(r)) return { weekOfMonth: Number(r.weekOfMonth), weekday: Number(r.weekday) };
  return { dayOfMonth: r?.dayOfMonth ?? 1 };
}

/** The yearly part: {} = the same date each year, or
 *  { weekOfMonth, weekday, monthOfYear }. */
export function yearRuleOf(r) {
  if (!hasWeekdayRule(r) || !(r.freq === 'yearly' || r.unit === 'year')) return {};
  return { weekOfMonth: Number(r.weekOfMonth), weekday: Number(r.weekday), monthOfYear: Number(r.monthOfYear) || 1 };
}
