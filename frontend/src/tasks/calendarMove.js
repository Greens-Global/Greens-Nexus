// Task Module - moving tasks between days (Oct 22 2026): the Calendar's drag
// and its Move To Date menu, and the batch bar's Dates action. Pure, so the
// date arithmetic is testable without a pointer.
//
// Calendar days are the viewer's LOCAL days (lib.js localISO / addDays) -
// never toISOString(), which is the UTC day and is already tomorrow on a US
// evening.
import { addDays, fmtDate, roleAtLeast, taskRoleFor } from './lib';

const day = (iso) => String(iso || '').slice(0, 10);

/** Whole local days from `a` to `b` (both YYYY-MM-DD); negative when b is earlier. */
export function daysBetween(a, b) {
  const [ay, am, ad] = day(a).split('-').map(Number);
  const [by, bm, bd] = day(b).split('-').map(Number);
  // Date.UTC on the calendar parts: a daylight-saving change between the two
  // days would make a local-midnight difference 23 or 25 hours.
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/**
 * The patch that drops `task` on day `targetIso`, or null when it is already
 * due that day. The due date takes the new day (anything after the day in it -
 * a time - is kept); a start date moves by the same number of days, so the
 * task keeps its length. Only dates are sent: a recurring occurrence moves
 * alone and its rule is never touched.
 */
export function calendarMovePatch(task, targetIso) {
  const due = task?.dueOn || '';
  const target = day(targetIso);
  if (!due || !target || day(due) === target) return null;
  const delta = daysBetween(due, target);
  const patch = { dueOn: target + String(due).slice(10) };
  if (task.startOn) patch.startOn = addDays(task.startOn, delta) + String(task.startOn).slice(10);
  return patch;
}

/**
 * The patch that gives `task` the due day `targetIso` (Oct 22 2026, the
 * Board's Due Date columns as well as the Calendar): a dated task moves as
 * calendarMovePatch moves it (its start date keeps the task's length); an
 * undated one just takes the day; '' clears the due date. Null when nothing
 * would change.
 */
export function dueMovePatch(task, targetIso) {
  const due = task?.dueOn || '';
  const target = day(targetIso);
  if (!target) return due ? { dueOn: '' } : null;
  if (!due) return { dueOn: target };
  return calendarMovePatch(task, target);
}

/**
 * Moves `task` to day `iso` ('' = no due date) through the store - the ONE
 * path a drag onto a day takes, from the Calendar or a Board's Due Date
 * column. A move is the task's own update (store.updateTask): optimistic,
 * put back and explained by updateTask itself if refused (a repeating
 * task's series rules); a date that needs approval comes back as a request
 * - the store has already said so, with Withdraw as its Undo - and the task
 * keeps its day. Otherwise an Undo toast: the server-side Undo of that
 * due-history entry (no extension counted for the trip back, no second
 * bell), or putting the dates back when there is no entry to name.
 * Resolves to the saved task, or null when nothing was saved.
 */
export async function moveTaskToDay(store, task, iso) {
  const patch = dueMovePatch(task, iso);
  if (!task || !patch || !store?.updateTask) return null;
  const back = previousDates(task, patch);
  let saved;
  try { saved = await store.updateTask(task.id, patch); } catch { return null; }
  if (wasSentForApproval(saved, patch)) return saved;
  const at = undoEntryAt(saved, patch);
  store.offerUndo?.(patch.dueOn ? movedLabel(patch) : 'Due date cleared', () => (at && store.undoDueChange
    ? store.undoDueChange(task.id, at)
    : store.updateTask(task.id, back)).catch(() => {}));
  return saved;
}

/** The dates `patch` would replace on `task` - what Undo puts back. */
export function previousDates(task, patch) {
  const back = {};
  for (const k of Object.keys(patch || {})) back[k] = task?.[k] || '';
  return back;
}

/** True when the server kept the date and turned the move into a request
 *  for approval (backend task_due.needs_approval). */
export function wasSentForApproval(saved, patch) {
  return !!saved && saved.dueAgreement === 'extension_requested'
    && day(saved.dueProposal?.dueOn) === day(patch?.dueOn) && day(saved.dueOn) !== day(patch?.dueOn);
}

/** The due-history entry the move just made (its "at"), for the server-side
 *  Undo - only when it is the latest one and landed on the date asked for. */
export function undoEntryAt(saved, patch) {
  const hist = Array.isArray(saved?.dueHistory) ? saved.dueHistory : [];
  const last = hist[hist.length - 1];
  return last && last.undo && day(last.to) === day(patch?.dueOn) ? last.at || '' : '';
}

/** Whether this person may drag `task` on the calendar: an editor on it (the
 *  server's rule, taskRoleFor - unknown keeps the control, the server stays
 *  the authority), and not a completed task. */
export function canMoveOnCalendar(task, { projects, teams, taskById, email, isManager } = {}) {
  if (!task || !task.dueOn || task.completed) return false;
  const role = taskRoleFor(task, { projects, teams, taskById, email, isManager });
  return role == null || roleAtLeast(role, 'editor');
}

export const movedLabel = (patch) => `Moved to ${fmtDate(day(patch.dueOn))}`;

/** One line for what the batch bar's Dates action did, from the server's counts. */
export function bulkDatesSummary(op, { changed = 0, skipped = 0, sentForApproval = 0, blocked = 0 } = {}, days = 0) {
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  let head;
  if (op === 'shift') {
    const dir = days < 0 ? 'earlier' : 'later';
    head = `Moved ${n(changed, 'task')} ${n(Math.abs(days), 'day')} ${dir}`;
  } else if (op === 'set_due') head = `Set the due date on ${n(changed, 'task')}`;
  else if (op === 'set_start') head = `Set the start date on ${n(changed, 'task')}`;
  else head = `Cleared the due date on ${n(changed, 'task')}`;
  const parts = [head];
  if (skipped) parts.push(`${skipped} without a due date skipped`);
  if (sentForApproval) parts.push(`${sentForApproval} sent for approval`);
  if (blocked) parts.push(`${blocked} not moved`);
  return parts.join(' - ');
}
