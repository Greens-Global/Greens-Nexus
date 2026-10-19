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
// Optional `timeZone` (IANA) reads an INSTANT on that zone's calendar; leave it
// off for a bare date (YYYY-MM-DD), which is already a calendar day.
export function formatDate(v, fallback = '', timeZone) {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}),
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

// h:mm AM/PM on another zone's clock  ->  formatTimeIn(now, 'America/Los_Angeles') = "4:42 PM"
export function formatTimeIn(v, timeZone, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone,
  }).format(d);
}

// The clock on another zone's wall, for comparing against a time kept in that
// zone (a shift's start and end): zoneClock('Asia/Kolkata') = { date:
// '2026-09-30', minutes: 95 } at 1:35 AM there. An unknown zone reads the
// viewer's own clock.
export function zoneClock(timeZone, v = new Date()) {
  const d = toDate(v) || new Date();
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
  } catch {
    return { date: toDateInputValue(d), minutes: d.getHours() * 60 + d.getMinutes() };
  }
}

// Heading greeting, Title Case like every heading (Neil, Sep 28):
// "Good Morning" before noon, "Good Afternoon" before 5 PM, then "Good Evening".
export function greetingFor(v = new Date()) {
  const h = (toDate(v) || new Date()).getHours();
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}

// MM/DD/YYYY, h:mm AM/PM  ->  "08/04/2026, 2:01 PM"
// Optional `timeZone` (IANA) reads it on that zone's clock instead of the viewer's.
export function formatDateTime(v, fallback = '', timeZone) {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true, ...(timeZone ? { timeZone } : {}),
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

// ── Shifts (Oct 2026) - the one set of formatters the Shifts module uses ──
// A shift keeps its times as 'HH:MM' wall-clock strings in its own zone, so
// they are formatted as text, never through a Date (which would move them
// into the viewer's zone).

// 'HH:MM' -> "8:30 AM"; '' / unreadable -> fallback.
export function formatHHMM(hhmm, fallback = '') {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return fallback;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return `${h % 12 || 12}:${String(min).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Weekday name  ->  formatWeekday('2026-09-29') = "Tuesday", ('2026-09-29', 'short') = "Tue"
export function formatWeekday(v, style = 'long', fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  const weekday = style === 'short' ? 'short' : style === 'narrow' ? 'narrow' : 'long';
  return new Intl.DateTimeFormat('en-US', { weekday }).format(d);
}

// Month and year  ->  "September 2026"
export function formatMonthYear(v, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(d);
}

// Month and day - the cue a day header needs across a month boundary  ->  "Sep 29"
export function formatMonthDay(v, fallback = '') {
  const d = toDate(v);
  if (!d) return fallback;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
}

// A compact, readable range for a heading (Shifts toolbar, 10/02): month
// names, the month said once when both ends share it, the year left to a
// caption beside it.
//   ('2026-09-28', '2026-10-04') -> "Sep 28 - Oct 4"
//   ('2026-10-05', '2026-10-11') -> "Oct 5 - 11"
//   ('2026-10-02', '2026-10-02') -> "Oct 2"
//   ('2026-12-28', '2027-01-03') -> "Dec 28, 2026 - Jan 3, 2027" (two years: both said)
export function formatRangeShort(start, end, fallback = '') {
  const a = toDate(start);
  const b = toDate(end) || a;
  if (!a) return fallback;
  const mon = (d) => new Intl.DateTimeFormat('en-US', { month: 'short' }).format(d);
  if (a.getFullYear() !== b.getFullYear()) {
    return `${mon(a)} ${a.getDate()}, ${a.getFullYear()} - ${mon(b)} ${b.getDate()}, ${b.getFullYear()}`;
  }
  if (a.getMonth() === b.getMonth()) {
    return a.getDate() === b.getDate() ? `${mon(a)} ${a.getDate()}` : `${mon(a)} ${a.getDate()} - ${b.getDate()}`;
  }
  return `${mon(a)} ${a.getDate()} - ${mon(b)} ${b.getDate()}`;
}

// ISO-8601 week of the year (weeks start Monday; week 1 holds the first
// Thursday)  ->  weekOfYear('2026-09-28') = 40
export function weekOfYear(v) {
  const d = toDate(v);
  if (!d) return 0;
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));      // the Thursday of this week
  const jan4 = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

// A punch on the EMPLOYEE'S own clock, not the viewer's (Oct 2 - a California
// manager auditing an India night shift saw Pacific times). `iso` is the
// stored naive-UTC punch time; `tzOffsetMin` is the punching device's
// getTimezoneOffset() (UTC - local, as TimePunch.tz_offset_min stores it).
// -> { time: '2:30 AM', date: '2026-10-02', zone: 'GMT+5:30' }, or null.
export function wallClock(iso, tzOffsetMin) {
  const t = Date.parse(`${String(iso || '').slice(0, 19)}Z`);
  if (isNaN(t)) return null;
  const off = Number(tzOffsetMin) || 0;
  const d = new Date(t - off * 60000);   // the wall clock, read as UTC
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(d);
  const east = -off, abs = Math.abs(east);
  const zone = `GMT${east >= 0 ? '+' : '-'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  return { time, date: d.toISOString().slice(0, 10), zone };
}

// Short label for an IANA zone: 'America/Los_Angeles' -> "PT", 'Asia/Kolkata'
// -> "IST"; any other zone gets Intl's short name ("GMT+9"), '' for none.
const ZONE_ABBR = {
  'America/Los_Angeles': 'PT', 'America/Denver': 'MT', 'America/Phoenix': 'MST',
  'America/Chicago': 'CT', 'America/New_York': 'ET',
  'Asia/Kolkata': 'IST', 'Asia/Calcutta': 'IST', UTC: 'UTC',
};
export function zoneAbbr(timeZone, v = new Date()) {
  if (!timeZone) return '';
  if (ZONE_ABBR[timeZone]) return ZONE_ABBR[timeZone];
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(toDate(v) || new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

// A stored UTC instant on the EMPLOYEE's clock, for an approver (Oct 19 -
// Miranda asked for 8:30 AM Pacific and her approver in India read 9:00 PM).
// `timeZone` is the employee's IANA zone (the one their Time Sheet reads in);
// a naive 'YYYY-MM-DDTHH:MM[:SS]' is UTC, as the timeclock stores it.
//   zonedDateTime('2026-10-17T15:30:00', 'America/Los_Angeles', 'Asia/Kolkata')
//     -> { date: '10/17/2026', time: '8:30 AM', zone: 'PT', differs: true, label: '8:30 AM PT' }
// `differs` = the viewer's own clock (`viewerZone`, default the browser's)
// reads another time, so `label` carries the zone only then. No zone, or an
// unknown one, reads the viewer's clock unlabeled. Null for no/bad value.
export function zonedDateTime(v, timeZone, viewerZone) {
  const naive = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v);
  const d = toDate(naive ? `${v}Z` : v);
  if (!d) return null;
  let tz = timeZone || '';
  try { if (tz) new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = ''; }
  let mine = viewerZone || '';
  try { if (mine) new Intl.DateTimeFormat('en-US', { timeZone: mine }); } catch { mine = ''; }
  const date = formatDate(d, '', tz || undefined), time = formatTimeIn(d, tz || undefined);
  const differs = !!tz && (formatDateTime(d, '', tz) !== formatDateTime(d, '', mine || undefined));
  const zone = tz ? zoneAbbr(tz, d) : '';
  return { date, time, zone, differs, label: differs && zone ? `${time} ${zone}` : time };
}

// ── Typing a time on the EMPLOYEE's clock (People > Time, Oct 20) ────────────
// A manager in India adjusting a Pacific employee's punch types the time the
// employee lived ("9:00 AM"), not their own. These convert between a stored
// UTC instant and a datetime-local value ('YYYY-MM-DDTHH:MM') on a zone's
// wall, DST-correct. No zone (or an unknown one) = the viewer's browser zone,
// which is what the inputs did before.
function validZone(timeZone) {
  if (!timeZone) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return timeZone; } catch { return ''; }
}
function utcInstant(v) {
  const naive = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v);
  return toDate(naive ? `${v}Z` : v);
}
// The zone's wall clock at an instant, as the UTC-epoch milliseconds of that wall time.
function wallMs(ms, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
}

// The zone's offset at an instant in JS getTimezoneOffset terms (UTC minus
// local, minutes): Pacific is 420 in summer and 480 in winter, India -330 -
// what the timeclock stores as a punch's tz_offset_min.
export function zoneOffsetMin(timeZone, v = new Date()) {
  const d = utcInstant(v);
  if (!d) return 0;
  const tz = validZone(timeZone);
  if (!tz) return d.getTimezoneOffset();
  const ms = Math.floor(d.getTime() / 60000) * 60000;
  return Math.round((ms - wallMs(ms, tz)) / 60000);
}

// Stored UTC instant -> datetime-local value on the zone's wall.
//   zonedInputValue('2026-10-17T15:30:00', 'America/Los_Angeles') -> '2026-10-17T08:30'
export function zonedInputValue(v, timeZone) {
  const d = utcInstant(v);
  if (!d) return '';
  return new Date(d.getTime() - zoneOffsetMin(timeZone, d) * 60000).toISOString().slice(0, 16);
}

// datetime-local value on the zone's wall -> naive UTC 'YYYY-MM-DDTHH:MM:SS'
// (how the timeclock stores `at`). A wall time that happens twice (the
// fall-back hour) is the first one; one that never happens (the spring-forward
// gap) moves forward an hour, as the clocks did: 2:30 AM on 03/08/2026 Pacific
// is saved as 3:30 AM PDT.
//   zonedInputToUtc('2026-10-17T09:00', 'America/Los_Angeles') -> '2026-10-17T16:00:00'
export function zonedInputToUtc(value, timeZone) {
  const m = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return '';
  const tz = validZone(timeZone);
  if (!tz) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19);
  }
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  if (isNaN(guess)) return '';
  const o1 = zoneOffsetMin(tz, guess);
  let t = guess + o1 * 60000;
  const o2 = zoneOffsetMin(tz, t);
  if (o2 !== o1) {
    const t2 = guess + o2 * 60000;
    if (wallMs(t2, tz) === guess) t = t2;   // else the gap: keep the pre-change offset
  }
  return new Date(t).toISOString().slice(0, 19);
}
