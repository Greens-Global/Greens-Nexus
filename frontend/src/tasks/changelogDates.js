// What's New date helpers (ported from changelogDateFormat.ts / relativeDay.ts).
//
// An update's releasedAt comes in two shapes. One written by hand is LOCAL
// wall time with no zone ("2026-10-12T17:05"); one published from a merge is
// a UTC instant ("2026-10-13T00:45:00+00:00"). They were all read as local
// wall time, so on a US evening - when the UTC date is already tomorrow - an
// automatic update showed tomorrow's date and a UTC clock time, landed under
// the wrong day, and dropped out of the Activity Summary's week as a "future"
// update (Oct 12 2026). A string with a zone is now read as the instant it is.
import { fmtDate } from './lib';
import { formatTime as usFormatTime } from '../lib/datetime';

const HAS_ZONE = /T.*([zZ]|[+-]\d{2}:?\d{2})$/;

export function toLocalDate(iso) {
  if (!iso) return null;
  const s = String(iso);
  if (HAS_ZONE.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  const [datePart, timePart] = s.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!timePart) return new Date(y, (m || 1) - 1, d || 1);
  const [hh, mm] = timePart.split(':').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
}

// The local calendar day an update belongs to, as YYYY-MM-DD.
export function localDayKey(iso) {
  const d = toLocalDate(iso);
  if (!d || isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatFullDate(iso) {
  const d = toLocalDate(iso);
  return d && !isNaN(d) ? fmtDate(d) : '';
}

export function formatTime(iso) {
  if (!iso || !String(iso).includes('T')) return '';
  const d = toLocalDate(iso);
  return d && !isNaN(d) ? usFormatTime(d, '') : '';
}

export function formatDateTime(iso) {
  const t = formatTime(iso);
  return t ? `${formatFullDate(iso)}, ${t}` : formatFullDate(iso);
}

// Whole days from the update's local day to today's (0 = today).
function daysAgo(iso, now) {
  const key = localDayKey(iso);
  if (!key) return null;
  const day = toLocalDate(key);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - day.getTime()) / 86_400_000);
}

export function relativeDayLabel(iso, now = new Date()) {
  const diff = daysAgo(iso, now);
  if (diff === null) return '';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return `${diff} days ago`;
  return formatFullDate(localDayKey(iso));
}

export function isWithinDays(iso, days, now = new Date()) {
  const diff = daysAgo(iso, now);
  return diff !== null && diff >= 0 && diff < days;
}
