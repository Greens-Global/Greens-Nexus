// Canonical US date/time formatting for all of Nexus.
//
// Per CLAUDE.md: dates are MM/DD/YYYY, times are 12-hour with AM/PM - everywhere,
// in UI, copy, and exports. Use these helpers instead of ad-hoc
// toLocale*/Intl.DateTimeFormat calls so formatting stays consistent app-wide.
//
// Every helper accepts a Date, an ISO/date string, or a millisecond timestamp,
// and returns `fallback` ('' by default) for null/empty/invalid input - so a
// missing value never renders "Invalid Date".

// Parse loosely into a Date (or null). A bare date string (YYYY-MM-DD) is parsed
// in LOCAL time, not UTC: `new Date('1980-05-19')` is UTC midnight, which in a US
// (behind-UTC) timezone would display as 1980-05-18 and roll a birthday back a
// day. Datetime strings (with a time/zone) are left to the native parser.
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// MM/DD/YYYY  ->  "08/04/2026"
export function formatDate(v, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// h:mm AM/PM  ->  "2:01 PM"
export function formatTime(v, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

// MM/DD/YYYY, h:mm AM/PM  ->  "08/04/2026, 2:01 PM"
export function formatDateTime(v, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

// Readable, still US order  ->  "Aug 4, 2026" (use where a numeric date reads cold)
export function formatDateLong(v, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(d);
}

// <input type="date"> needs a YYYY-MM-DD value, NOT a US-formatted one. Use this
// to feed date inputs from a stored value without the UTC roll-back.
export function toDateInputValue(v) {
  const d = toDate(v);
  if (!d) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
