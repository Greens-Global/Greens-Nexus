// Item Management - Checkout due dates (Items redesign, Neil 11/02/2026).
//
// The server is the one clock (backend/item_due.py): every checkout payload
// carries dueAt (the instant) and dueDate (YYYY-MM-DD in the BORROWER's zone)
// once the item has changed hands, and requestedDueDate (the return date the
// borrower picked) from the moment it is asked for. The screens read those -
// they never count days from allocatedAt themselves (that started the clock
// at the receipt, not the handover, and in UTC).
import { formatDate } from '../../lib/datetime';

const pad2 = (n) => String(n).padStart(2, '0');
/** Today as YYYY-MM-DD on the viewer's own calendar. */
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}
/** YYYY-MM-DD + n days (calendar arithmetic, no time zone drift). */
export function addDaysISO(iso, n) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + n);
  return todayISO(dt);
}
/** Whole days from `a` to `b` (both YYYY-MM-DD). */
export function daysBetween(a, b) {
  const [y1, m1, d1] = String(a).split('-').map(Number);
  const [y2, m2, d2] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

const handedOver = (co) => !!(co?.handedOverAt || co?.allocatedAt);

/** The due day (YYYY-MM-DD) to show: the server's dueDate once handed over,
 *  else the return date the borrower picked, else ''. */
export function dueDayOf(co) {
  if (!co) return '';
  if (co.dueDate) return co.dueDate;
  if (!handedOver(co)) return co.requestedDueDate || '';
  // A row the server has not dated yet (an optimistic one): start + days.
  const start = co.handedOverAt || co.allocatedAt;
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return co.requestedDueDate || '';
  d.setDate(d.getDate() + (Number(co.days) || 1));
  return todayISO(d);
}

/** { dueDay, daysLeft, overdue, dueToday } for a checkout, counted against
 *  the BORROWER's today: the server sends borrowerToday, overdue and dueToday
 *  (backend item_due.due_fields) - the viewer's own clock is only the
 *  fallback for a row the server has not dated yet (an optimistic one). */
export function checkoutDueInfo(co, now = new Date()) {
  const dueDay = dueDayOf(co);
  if (!dueDay) return { dueDay: '', daysLeft: null, overdue: false, dueToday: false, due: null };
  const today = co.borrowerToday || todayISO(now);
  const daysLeft = daysBetween(today, dueDay);
  const live = co.status === 'allocated';
  const [y, m, d] = dueDay.split('-').map(Number);
  const overdue = typeof co.overdue === 'boolean' ? co.overdue : (live && daysLeft < 0);
  const dueToday = typeof co.dueToday === 'boolean' ? co.dueToday : (live && daysLeft === 0);
  return { dueDay, daysLeft, overdue, dueToday, due: new Date(y, m - 1, d) };
}

/** MM/DD/YYYY of the due day ('' when none). */
export function fmtDueDate(co) {
  const d = dueDayOf(co);
  return d ? formatDate(d) : '';
}

/** How far through the loan we are, 0..1 (handover -> due), for the In Use
 *  ProgressTrack; null before the handover. */
export function loanProgress(co, now = new Date()) {
  const startIso = co?.handedOverAt || co?.allocatedAt;
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const due = co.dueAt ? new Date(co.dueAt).getTime() : start + (Number(co.days) || 1) * 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(due) || due <= start) return 1;
  return Math.min(Math.max((now.getTime() - start) / (due - start), 0), 1);
}

/** "3 days left" / "Due today" / "2 days overdue" for a checkout in use. */
export function dueWords(co, now = new Date()) {
  const { daysLeft } = checkoutDueInfo(co, now);
  if (daysLeft == null) return '';
  if (daysLeft === 0) return 'Due today';
  if (daysLeft > 0) return `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
  const n = -daysLeft;
  return `${n} day${n === 1 ? '' : 's'} overdue`;
}
