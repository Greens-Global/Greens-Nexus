// Fast time typing on the Time Sheet (Neil, 11/04/2026): a manager types
// "730p", "7:30", "1930" or "7:30 pm" into a punch and it reads as 7:30 PM -
// no date picker, no seconds. The punch keeps its own day; a time with no
// AM / PM takes the half of the day closest to the punch it replaces, so
// "730" on a 7:02 AM clock-in stays morning and on a 3:30 PM clock-out stays
// afternoon. Works on datetime-local values ("YYYY-MM-DDTHH:mm") on the
// card's clock, the same values lib/longShift.js judges.

const pad = (n) => String(n).padStart(2, '0');

/** "730p" / "7:30 PM" / "1930" / "7p" / "12" -> { h, m, ampm } (h 0-23 when
 *  ampm is given or the hour is 13+, else 1-12 with ampm ''), or null. */
export function parseTypedTime(text) {
  const s = String(text || '').trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  if (!s) return null;
  const m = /^(\d{1,2})(?::?(\d{2}))?(a|am|p|pm)?$/.exec(s) || /^(\d{3,4})(a|am|p|pm)?$/.exec(s);
  if (!m) return null;
  let h, mi, ap;
  if (m.length === 4) { h = +m[1]; mi = m[2] ? +m[2] : 0; ap = m[3] || ''; }
  else { const d = m[1]; h = +d.slice(0, d.length - 2); mi = +d.slice(-2); ap = m[2] || ''; }
  if (Number.isNaN(h) || Number.isNaN(mi) || mi > 59 || h > 23) return null;
  ap = ap ? ap[0] : '';
  if (ap) {
    if (h < 1 || h > 12) return null;
    return { h: (h % 12) + (ap === 'p' ? 12 : 0), m: mi, ampm: ap === 'p' ? 'PM' : 'AM' };
  }
  if (h >= 13 || h === 0) return { h, m: mi, ampm: h >= 12 ? 'PM' : 'AM' };
  return { h, m: mi, ampm: '' };
}

/** The datetime-local value a typed time means for the punch at `base`
 *  ("YYYY-MM-DDTHH:mm"). '' when it cannot be read. */
export function applyTypedTime(base, text) {
  const t = parseTypedTime(text);
  const day = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(base || '');
  if (!t || !day) return '';
  let h = t.h;
  if (!t.ampm) {
    // No AM / PM typed: the reading closest to the time it replaces.
    const was = +day[2] * 60 + +day[3];
    const am = (h % 12) * 60 + t.m, pm = am + 12 * 60;
    h = Math.abs(pm - was) < Math.abs(am - was) ? (h % 12) + 12 : h % 12;
  }
  return `${day[1]}T${pad(h)}:${pad(t.m)}`;
}

/** "YYYY-MM-DDTHH:mm" -> "7:30 PM" (what the box shows while editing). */
export function inputToTyped(v) {
  const m = /T(\d{2}):(\d{2})/.exec(v || '');
  if (!m) return '';
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Move a datetime-local value by whole days (an overnight clock-out). */
export function shiftDays(v, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(v || '');
  if (!m) return v;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${m[4]}`;
}

/** The inline warning for a typed punch, or null: an Out at or before its
 *  In (or an In at or after its Out). `other` is the shift's other end as a
 *  datetime-local value. A clock-out that only makes sense after midnight
 *  gets `nextDay` - the same time on the following day - to offer. */
export function orderIssue(kind, value, other) {
  if (!value || !other) return null;
  if (kind === 'out' || kind === 'break_end') {
    if (value > other) return null;
    const next = shiftDays(value, 1);
    return { message: `Out ${inputToTyped(value)} is before In ${inputToTyped(other)}.`, nextDay: next };
  }
  if (value < other) return null;
  return { message: `In ${inputToTyped(value)} is after Out ${inputToTyped(other)}.`, nextDay: '' };
}
