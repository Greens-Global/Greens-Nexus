// Math behind the Workday (My HR overview) stat tiles and the Time Off tab's
// year-at-a-glance tally, kept pure so it is unit tested (workdayStats.test.js).
//
// Charmi, Sep 30: "Leave this year" read 29d and nobody could say where it came
// from. It counted every CALENDAR day of each approved request (weekends too),
// counted a 2-hour doctor's appointment as a whole day, and credited a request
// that ran across New Year entirely to the year it started in. Leave is now
// counted in WORKING days (Mon-Fri), clipped to the year, with a partial day as
// its fraction of an 8-hour day.

const DAY_MS = 86400000;

// 'YYYY-MM-DD' -> local-midnight Date (null when not a date). Bare ISO dates
// must not go through `new Date(str)` (UTC midnight -> the previous day in US
// timezones).
export function parseIsoDay(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// Mon-Fri days in [a, b], inclusive.
export function weekdaysBetween(a, b) {
  if (!a || !b || b < a) return 0;
  let n = 0;
  const d = new Date(a);
  while (d <= b) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return isNaN(h) ? NaN : h * 60 + (m || 0);
};

// Working days one request takes. A partial-day request (start + end time on a
// single day) counts as its share of an 8-hour day; a full-day request counts
// Mon-Fri days only. `year` (optional) clips the range to that calendar year.
export function leaveRequestDays(r, year) {
  if (!r) return 0;
  const start = r.startDate ?? r.start_date;
  const end = (r.endDate ?? r.end_date) || start;
  let a = parseIsoDay(start), b = parseIsoDay(end);
  if (!a || !b) return 0;
  if (year != null) {
    const y0 = new Date(Number(year), 0, 1), y1 = new Date(Number(year), 11, 31);
    if (a < y0) a = y0;
    if (b > y1) b = y1;
    if (b < a) return 0;
  }
  const st = r.startTime ?? r.start_time, et = r.endTime ?? r.end_time;
  if (st && et) {
    const mins = minutesOf(et) - minutesOf(st);
    if (!(mins > 0)) return 0;
    // A partial day on a weekend is still time the person asked off.
    return Math.min(1, mins / 480);
  }
  return weekdaysBetween(a, b);
}

// Approved working days of leave inside `year`, rounded to 2 decimals.
export function approvedLeaveDays(requests, year) {
  const total = (requests || [])
    .filter(r => r && r.status === 'approved')
    .reduce((s, r) => s + leaveRequestDays(r, year), 0);
  return Math.round(total * 100) / 100;
}

// "1.5" / "3" - a leave total without trailing zeros.
export function fmtDays(n) {
  return String(Math.round((n || 0) * 100) / 100);
}

// Tenure from an HR start date: "12d", "7mo", "10.8y" - or null when the start
// date is missing, unparseable or in the future (a new hire who has not
// started yet has no "time with us").
export function tenureLabel(startDate, now = new Date()) {
  const s = parseIsoDay(startDate);
  if (!s) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (s > today) return null;
  const days = Math.round((today - s) / DAY_MS);
  if (days < 31) return `${days}d`;
  // Whole calendar months, not days / 30.44.
  let months = (today.getFullYear() - s.getFullYear()) * 12 + (today.getMonth() - s.getMonth());
  if (today.getDate() < s.getDate()) months -= 1;
  if (months < 12) return `${Math.max(1, months)}mo`;
  return `${(months / 12).toFixed(1)}y`;
}

// Minutes of a shift that is open RIGHT NOW (last punch is a clock-in or a
// break end), which the server leaves out of workedMin until the clock-out
// lands - so "Hours - this week" read 0h while someone was mid-shift. Any
// open break is not counted; a shift open longer than 16 hours is a missed
// clock-out (the server's pairing guard), not work, and adds nothing.
//
// The server sends punch times as UTC with no zone ('2026-10-02T12:51:59'),
// which a bare new Date() reads as LOCAL time - off by the viewer's whole UTC
// offset (Oct 2: 5h 31m for a shift one minute old in India). A time with no
// zone is taken as UTC; one that carries its own zone is read as written.
const punchMs = (at) => new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(at) ? at : `${at}Z`).getTime();
export function openShiftMinutes(days, now = Date.now()) {
  const punches = Object.values(days || {})
    .flatMap(d => d?.punches || [])
    .filter(p => p && !p.voided && p.at)
    .sort((x, y) => punchMs(x.at) - punchMs(y.at));
  let inAt = null, breakAt = null, brk = 0;
  for (const p of punches) {
    const t = punchMs(p.at);
    if (isNaN(t)) continue;
    if (p.kind === 'in') { inAt = t; breakAt = null; brk = 0; }
    else if (p.kind === 'out') { inAt = null; breakAt = null; brk = 0; }
    else if (p.kind === 'break_start' && inAt != null && breakAt == null) breakAt = t;
    else if (p.kind === 'break_end' && breakAt != null) { brk += t - breakAt; breakAt = null; }
  }
  if (inAt == null) return 0;
  const end = breakAt != null ? breakAt : now;
  const span = end - inAt;
  if (span <= 0 || now - inAt > 16 * 3600000) return 0;
  return Math.max(0, Math.floor((span - brk) / 60000));
}
