// Pure helpers shared by every Shifts screen (Oct 2026 rebuild): the manager
// grid, My Shifts, the team grid, the request cards and the settings. One
// rule for hours, one for time off, one set of date helpers - the three
// grids used to disagree on all of them (Shifts QA, 10/02).
import { formatHHMM, formatWeekday, formatMonthDay, formatMonthYear, formatRangeShort, formatDate, weekOfYear } from '../../lib/datetime';

// ── Dates ────────────────────────────────────────────────────────────────
// The LOCAL calendar date as YYYY-MM-DD. toISOString() is UTC, so east of UTC
// a local-midnight Monday came out as Sunday (Sep 29).
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function parseIso(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function addDaysIso(iso, n) {
  const d = parseIso(iso);
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}
export const todayIso = () => isoDate(new Date());
export const isPastDay = (iso) => iso < todayIso();

// The first day of the week `d` is in: Monday by default, Sunday when the
// company's shift settings say so (CONTRACT.md 9, `weekStart`).
export function weekStartOf(d, weekStart = 'monday') {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const back = weekStart === 'sunday' ? x.getDay() : (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - back);
  return x;
}

// The dates a view covers: one day, the week (or two) from the week start,
// or every day of the month.
export function viewDays(view, cursor, weekStart = 'monday') {
  const c = new Date(cursor); c.setHours(0, 0, 0, 0);
  if (view === 'day') return [c];
  if (view === 'month') {
    const n = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
    return Array.from({ length: n }, (_, i) => new Date(c.getFullYear(), c.getMonth(), i + 1));
  }
  const first = weekStartOf(c, weekStart);
  const len = view === 'twoweeks' ? 14 : 7;
  return Array.from({ length: len }, (_, i) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
}

// "Mon Sep 29" - a day header always says its month (Teams parity; a week
// across a month boundary used to read "29 30 1 2 3").
export const dayHeading = (d, style = 'short') => `${formatWeekday(d, style)} ${formatMonthDay(d)}`;
// "Mon 28" - the calm day header (Oct 2026); the month is said apart, once,
// where the view crosses into it.
export const dayShort = (d) => `${formatWeekday(d, 'short')} ${d.getDate()}`;

// ── Times and hours ──────────────────────────────────────────────────────
export const toMin = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
// An end before the start runs past midnight; an end EQUAL to the start is
// zero, not 24 h (a typo the server refuses).
export const durMin = (start, end) => { let d = toMin(end) - toMin(start); if (d < 0) d += 1440; return d; };
export const sameTime = (a, b) => !!a && !!b && String(a).slice(0, 5) === String(b).slice(0, 5);
export const timeText = (start, end) => `${formatHHMM(start)} - ${formatHHMM(end)}`;
export const shiftTimeText = (s) => timeText(s.start, s.end);
// "8:30a - 5:30p" - the one line a block carries (Oct 2026, "less clutter"):
// the same 12-hour time with the meridiem down to a letter so it never has
// to be cut. Screen readers, tooltips and the panel keep the full "8:30 AM".
export const shortTime = (hhmm) => formatHHMM(hhmm).replace(/ (AM|PM)$/, (m, ap) => ap[0].toLowerCase());
export const shortTimeText = (start, end) => `${shortTime(start)} - ${shortTime(end)}`;
export const shiftShortText = (s) => shortTimeText(s.start, s.end);

// Unpaid minutes inside a shift: the unpaid activities when there are any
// (CONTRACT.md 1 - `paid: false`), else the plain break the shift carries.
export function unpaidActivities(s) {
  return (s?.activities || []).filter((a) => a && a.paid === false && a.start && a.end);
}
export function unpaidMinutes(s) {
  const acts = unpaidActivities(s);
  if (acts.length) return acts.reduce((n, a) => n + durMin(a.start, a.end), 0);
  return Math.max(0, Number(s?.breakMin) || 0);
}
// Scheduled hours are PAID hours: the server's `paidMin` when it sends one,
// else the span minus the unpaid minutes (overnight aware).
export function paidMinutes(s) {
  if (Number.isFinite(Number(s?.paidMin)) && s.paidMin !== null && s.paidMin !== undefined && s.paidMin !== '') return Math.max(0, Number(s.paidMin));
  return Math.max(0, durMin(s?.start, s?.end) - unpaidMinutes(s));
}
// Hours a shift puts on the plan: an open shift needs every spot filled, so
// it counts once per spot; a person's shift counts once.
export const planMinutes = (s) => paidMinutes(s) * (s.email ? 1 : Math.max(1, Number(s.openSlots) || 1));
// A pending removal is on its way out and never counts.
export const counts = (s) => !s?.pendingDelete;

// "Lunch 30m" - what the block says under the time (Teams parity). Several
// unpaid activities read "Lunch 30m +1"; a plain break reads "Break 30m".
export function unpaidLabel(s) {
  const acts = unpaidActivities(s);
  if (acts.length) {
    const first = acts[0];
    return `${(first.label || 'Break').trim()} ${minutesText(durMin(first.start, first.end))}${acts.length > 1 ? ` +${acts.length - 1}` : ''}`;
  }
  const brk = Number(s?.breakMin) || 0;
  return brk ? `Break ${minutesText(brk)}` : '';
}
export function minutesText(min) {
  if (min >= 60 && min % 60 === 0) return `${min / 60}h`;
  if (min > 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min}m`;
}

// Hours, two decimals, "Hrs" everywhere: 7 h 45 is "7.75 Hrs", never "7.8".
export function hrsNumber(min) { return Math.round((min / 60) * 100) / 100; }
export function fmtHrs(min) { return `${hrsNumber(min)} Hrs`; }

// ── Shift state ──────────────────────────────────────────────────────────
// A PUBLISHED shift's unshared changes (Sep 28, QA D1/D2): an edit or a
// removal waits for Share while the team keeps seeing the published version.
export function shiftState(s) {
  if (s?.pendingDelete) return { tag: 'Removing', title: 'Removal not shared yet - the team still sees this shift until you share.', text: 'Removal not shared' };
  if (s?.hasChanges) return { tag: 'Edited', title: 'Edited - the team sees the previous version until you share.', text: 'Edited, not shared' };
  if (s?.published === false) return { tag: 'Draft', title: 'Draft - not shared with the team yet.', text: 'Draft' };
  return { tag: '', title: undefined, text: 'Shared' };
}
export const isUnshared = (s) => s?.published === false || !!s?.hasChanges || !!s?.pendingDelete;

// Same palette as a shift type's, for a shift's own color.
export const SHIFT_COLORS = ['#2563eb', '#16a34a', '#8b5cf6', '#f59e0b', '#ec4899', '#0891b2', '#dc2626', '#64748b'];
export const DEFAULT_SHIFT_COLOR = '#64748b';
export const OPEN_SHIFT_COLOR = '#16a34a';

// '#rrggbb' + alpha -> 'rgba(...)': a tint that reads in both themes, since
// the text on it stays the theme's ink.
export function alpha(hex, a) {
  const m = String(hex || '').match(/^#([0-9a-f]{6})$/i);
  if (!m) return `rgba(100,116,139,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── Zones ────────────────────────────────────────────────────────────────
// A shift kept in another zone than the team's. Both sides are IANA ids
// ("America/Los_Angeles"); the grid used to compare the id with the team's
// LABEL, so every block wore a "PDT" chip (Visesh, 10/02).
export const zoneDiffers = (zone, teamZone) => !!zone && !!teamZone && String(zone) !== String(teamZone);

// ── Time off ─────────────────────────────────────────────────────────────
// Every entry a person has on a day. The grid payload carries startTime /
// endTime / allDay (CONTRACT.md 3-4); an older row with dates only is a
// whole day.
export function timeOffOn(list, email, ds) {
  const e = (email || '').toLowerCase();
  return (list || []).filter((t) => (t.email || '').toLowerCase() === e && t.startDate <= ds && ds <= t.endDate);
}
export const isAllDayOff = (t) => !!t && (t.allDay === true || !(t.startTime && t.endTime));
// "All Day" or "2:00 PM - 4:00 PM" - a partial day shows its hours, so a
// two-hour appointment never reads as a day off.
export const timeOffWhen = (t) => (isAllDayOff(t) ? 'All Day' : timeText(t.startTime, t.endTime));
export const timeOffShort = (t) => (isAllDayOff(t) ? '' : shortTimeText(t.startTime, t.endTime));
export const isApprovedOff = (t) => t?.status === 'approved';
// A whole approved day off - the one case a person is not expected at all.
export const dayFullyOff = (entries) => (entries || []).some((t) => isApprovedOff(t) && isAllDayOff(t));

// ── Groups ───────────────────────────────────────────────────────────────
// The groups to draw on the grid, in the saved order (sortOrder, then name).
export function orderGroups(groups) {
  return [...(groups || [])].sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || String(a.name || '').localeCompare(String(b.name || '')));
}

// Names: the directory name first, then what the row carries, never the
// raw email (nameOf comes from useNameResolver).
export const displayName = (nameOf, email, stored) => (nameOf ? nameOf(email, stored) : (stored || email || ''));

// The key a grid section (a group, a location, "Everyone Else") is folded
// under - the group id, else its name. Remembered per user (WeekGrid).
export const sectionKey = (g) => (g?.id ? String(g.id) : `name:${g?.name || ''}`);

// ── Toolbar date (10/02) ─────────────────────────────────────────────────
// What the decorated date block says: a big compact title, a small caption,
// and the exact MM/DD/YYYY range for its tooltip.
//   week   -> "Sep 28 - Oct 4" / "2026 · Week 40 · This Week"
//   day    -> "Oct 2" / "Friday · Today"
//   month  -> "October 2026" / "This Month"
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
function relative(n, unit) {
  if (n === 0) return `This ${unit}`;
  if (n === -1) return `Last ${unit}`;
  if (n === 1) return `Next ${unit}`;
  return n > 0 ? `In ${plural(n, unit)}` : `${plural(-n, unit)} Ago`;
}
export function rangeCaption(view, first, last, weekStart = 'monday', now = new Date()) {
  const a = parseIso(first), b = parseIso(last || first);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const exact = first === (last || first) ? formatDate(first) : `${formatDate(first)} - ${formatDate(last)}`;
  if (view === 'day') {
    const diff = Math.round((a - today) / 86400000);
    const when = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : String(a.getFullYear());
    return { title: formatRangeShort(first, first), caption: `${formatWeekday(a)} · ${when}`, exact, isNow: diff === 0 };
  }
  if (view === 'month') {
    const diff = (a.getFullYear() - today.getFullYear()) * 12 + a.getMonth() - today.getMonth();
    return { title: formatMonthYear(a), caption: relative(diff, 'Month'), exact, isNow: diff === 0 };
  }
  const weeks = Math.round((weekStartOf(a, weekStart) - weekStartOf(today, weekStart)) / (7 * 86400000));
  const contains = today >= a && today <= b;
  const years = a.getFullYear() === b.getFullYear() ? String(a.getFullYear()) : `${a.getFullYear()} - ${b.getFullYear()}`;
  // The ISO week of the range's first week (its Thursday decides it).
  const wkA = weekOfYear(addDaysIso(first, weekStart === 'sunday' ? 1 : 0));
  const span = Math.round((b - a) / 86400000) + 1 > 7;
  const wk = span ? `Weeks ${wkA} - ${weekOfYear(addDaysIso(first, (weekStart === 'sunday' ? 1 : 0) + 7))}` : `Week ${wkA}`;
  const rel = contains ? 'This Week' : relative(weeks, 'Week');
  return { title: formatRangeShort(first, last), caption: `${years} · ${wk} · ${rel}`, exact, isNow: contains };
}

// ── Team colors (10/02) ──────────────────────────────────────────────────
// A group has no color of its own; the switcher's dot is its place in the
// saved order on a palette of eight distinct hues (no red - red reads as an
// error), so eight teams never share a dot. Without a place, a stable pick
// by id.
export const TEAM_COLORS = ['#2563eb', '#16a34a', '#8b5cf6', '#f59e0b', '#ec4899', '#0891b2', '#ea580c', '#64748b'];
export function teamColor(id, index = -1) {
  if (index >= 0) return TEAM_COLORS[index % TEAM_COLORS.length];
  if (!id) return DEFAULT_SHIFT_COLOR;
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TEAM_COLORS[h % TEAM_COLORS.length];
}

// ── Conflicts (10/02) ────────────────────────────────────────────────────
// Why a placed shift may be a mistake, one short line each:
//   "Duplicate of another shift"          same person, day and times
//   "Overlaps 6:30p - 2:30a draft"        another of their shifts (overnight counts)
//   "On approved Vacation"                approved time off, a partial day if it overlaps
//   "Outside availability: Sat unavailable" / "Outside availability: Sat 8:00a - 12:00p"
// The grid API sends its own sentences per shift (`conflicts`); they win for
// anything the client does not see (a holiday, a request still pending, a
// shift outside the loaded days), and the client's short line replaces the
// API's for the same kind of conflict.
const DAY3 = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayIndex = (iso) => Math.round(parseIso(iso).getTime() / 86400000);
// [start, end) in minutes from a fixed day; an end at or before the start runs
// past midnight. A zero-length span is null (it overlaps nothing).
function spanOf(date, start, end) {
  if (!date || !start || !end) return null;
  const a = toMin(start), b = toMin(end);
  if (a === b) return null;
  const base = dayIndex(date) * 1440;
  return [base + a, base + (b > a ? b : b + 1440)];
}
const hits = (x, y) => !!x && !!y && x[0] < y[1] && y[0] < x[1];
const offType = (t) => (t?.confidential || !t?.type ? 'Time Off' : String(t.type).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
const apiKind = (msg) => {
  const m = String(msg || '');
  if (/^Overlaps another shift/.test(m)) return 'overlap';
  if (/time off/i.test(m)) return /requested/i.test(m) ? 'requested' : 'timeoff';
  if (/^(Marked unavailable|Outside their availability)/.test(m)) return 'availability';
  if (/holiday/i.test(m)) return 'holiday';
  return 'other';
};

// { [shiftId]: ['reason', ...] } for every person's shift in `scheduled`.
export function conflictMap(scheduled = [], timeoff = [], availability = {}) {
  const out = {};
  const byPerson = {};
  (scheduled || []).forEach((s) => { if (s?.email && !s.pendingDelete) (byPerson[s.email] ||= []).push(s); });
  Object.entries(byPerson).forEach(([email, list]) => {
    const offs = (timeoff || []).filter((t) => (t.email || '').toLowerCase() === email.toLowerCase() && isApprovedOff(t));
    const avail = availability?.[email] || [];
    list.forEach((s) => {
      const mine = spanOf(s.date, s.start, s.end);
      const found = [];   // [kind, text]
      if (mine) {
        let dup = false;
        list.forEach((o) => {
          if (o === s || o.id === s.id) return;
          if (o.date === s.date && sameTime(o.start, s.start) && sameTime(o.end, s.end)) { dup = true; return; }
          if (hits(mine, spanOf(o.date, o.start, o.end))) found.push(['overlap', `Overlaps ${shiftShortText(o)}${o.published === false ? ' draft' : ''}`]);
        });
        if (dup) found.unshift(['duplicate', 'Duplicate of another shift']);
        // Time off on the shift's day, or the next one for an overnight shift.
        const days = mine[1] > (dayIndex(s.date) + 1) * 1440 ? [s.date, addDaysIso(s.date, 1)] : [s.date];
        const seen = new Set();
        days.forEach((ds) => offs.forEach((t) => {
          if (!(t.startDate <= ds && ds <= t.endDate) || seen.has(t)) return;
          const off = isAllDayOff(t) ? [dayIndex(ds) * 1440, dayIndex(ds) * 1440 + 1440] : spanOf(ds, t.startTime, t.endTime);
          if (hits(mine, off)) { seen.add(t); found.push(['timeoff', `On approved ${offType(t)}`]); }
        }));
        const wd = (parseIso(s.date).getDay() + 6) % 7;
        avail.filter((a) => a.weekday === wd).forEach((a) => {
          if (a.kind === 'unavailable') found.push(['availability', `Outside availability: ${DAY3[wd]} unavailable`]);
          else if (a.start && a.end) {
            const win = spanOf(s.date, a.start, a.end);
            if (win && !(win[0] <= mine[0] && mine[1] <= win[1])) found.push(['availability', `Outside availability: ${DAY3[wd]} ${shortTimeText(a.start, a.end)}`]);
          }
        });
      }
      const kinds = new Set(found.map(([k]) => (k === 'duplicate' ? 'overlap' : k)));
      const api = (s.conflicts || []).filter((m) => !kinds.has(apiKind(m)));
      const lines = [...new Set([...found.map(([, t]) => t), ...api])];
      if (lines.length) out[s.id] = lines;
    });
  });
  return out;
}

// ── Coverage (10/02) ─────────────────────────────────────────────────────
// Per day: who is expected (their usual shift type works that weekday and
// they are not on a whole approved day off) and who is on (any placed shift,
// draft or shared, not being removed). A person counts once.
//   members: [{ email, name }]; usualOf(email) -> preset with `days` ("1,2,3", Mon=1)
export function coverageFor(members, dayIsos, { byCell = {}, offOn = () => [], usualOf = () => null } = {}) {
  return dayIsos.map((ds) => {
    const wd = (parseIso(ds).getDay() + 6) % 7;
    const expected = [], on = [], off = [];
    members.forEach((m) => {
      const working = (byCell[`${m.email}|${ds}`] || []).some((x) => !x.pendingDelete);
      if (working) on.push(m);
      const p = usualOf(m.email);
      const days = String(p?.days || '').split(',').map(Number).filter((n) => n >= 1 && n <= 7).map((n) => n - 1);
      if (!p || !(days.length ? days : [0, 1, 2, 3, 4]).includes(wd)) return;
      if (dayFullyOff(offOn(m.email, ds))) { off.push(m); return; }
      expected.push(m);
    });
    const onSet = new Set(on.map((m) => m.email));
    const missing = expected.filter((m) => !onSet.has(m.email));
    const short = Math.max(0, expected.length - expected.filter((m) => onSet.has(m.email)).length);
    const tone = !expected.length && !on.length ? 'none' : short === 0 ? 'met' : short === 1 ? 'short1' : 'short2';
    return { date: ds, expected: expected.length, on: on.length, missing, off, short, tone };
  });
}
