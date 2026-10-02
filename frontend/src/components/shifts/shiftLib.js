// Pure helpers shared by every Shifts screen (Oct 2026 rebuild): the manager
// grid, My Shifts, the team grid, the request cards and the settings. One
// rule for hours, one for time off, one set of date helpers - the three
// grids used to disagree on all of them (Shifts QA, 10/02).
import { formatHHMM, formatWeekday, formatMonthDay } from '../../lib/datetime';

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
