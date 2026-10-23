// Task Module - moving tasks between days (Oct 22 2026): the Calendar's drag
// and its Move To Date menu, and the batch bar's Dates action. Pure, so the
// date arithmetic is testable without a pointer.
//
// Calendar days are the viewer's LOCAL days (lib.js localISO / addDays) -
// never toISOString(), which is the UTC day and is already tomorrow on a US
// evening.
//
// The Unscheduled pane (Oct 22 2026, Planner parity) runs through the same
// path: a task with no due date dropped on a day is scheduled there
// (schedulePatch), and a dated one dropped on the pane loses its due date
// (calendarDatePatch with an empty day). The approval hold, the held start
// date and the Undo are the same for all three.
import { addDays, fmtDate } from './lib';

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
 * The patch that schedules `task` (no due date yet) on day `targetIso`. A
 * start date after that day comes back to it: the server would take a start
 * after the due date silently, but no drag in the module ever makes one - the
 * Calendar keeps a task's length and the Timeline never lets the end pass the
 * start - so neither does this one. An earlier start stays where it is.
 */
export function schedulePatch(task, targetIso) {
  const target = day(targetIso);
  if (!task || !target || day(task.dueOn)) return null;
  const patch = { dueOn: target };
  if (task.startOn && day(task.startOn) > target) patch.startOn = target + String(task.startOn).slice(10);
  return patch;
}

/** The patch that clears `task`'s due date, or null when it has none. The
 *  start date stays: it still says when the work begins. */
export function clearDuePatch(task) {
  return task && day(task.dueOn) ? { dueOn: '' } : null;
}

/**
 * The one entry point the Calendar uses for a date change: an empty
 * `targetIso` clears the due date (dropped on the Unscheduled pane), a task
 * with no due date is scheduled, and a dated one moves. null = nothing to do.
 */
export function calendarDatePatch(task, targetIso) {
  if (!task) return null;
  if (!day(targetIso)) return clearDuePatch(task);
  return day(task.dueOn) ? calendarMovePatch(task, targetIso) : schedulePatch(task, targetIso);
}

// The server's words for it (routers/tasks.py SERIES_NEEDS_DUE), so the
// refusal reads the same wherever it comes from.
export const SERIES_NEEDS_DUE = 'A repeating task needs a due date - stop the repeat first or complete it.';
const SCHEDULED_FREQS = new Set(['daily', 'weekly', 'monthly', 'yearly', 'custom']);

/** Whether clearing the due date would stop a repeating series - the
 *  server's _clearing_stops_series: the live occurrence of a calendar series
 *  (open, not rolled forward yet, not a reopened Missed copy) keeps its date.
 *  The server refuses it either way; this only saves the round trip. */
export function clearingStopsSeries(task) {
  const rec = task?.recurrence && typeof task.recurrence === 'object' ? task.recurrence : {};
  return SCHEDULED_FREQS.has(rec.freq) && !!day(task?.dueOn) && !task?.completed
    && !rec.nextOccurrenceId && !rec.closedAsMissed;
}

/** The dates `patch` would replace on `task` - what Undo puts back. */
export function previousDates(task, patch) {
  const back = {};
  for (const k of Object.keys(patch || {})) back[k] = task?.[k] || '';
  return back;
}

/**
 * Moves `task` to day `iso` ('' = no due date) through the store - the ONE
 * date path for a drag onto a day: the Calendar (a day, the Unscheduled pane)
 * and a Board's Due Date columns (Oct 22 2026). The patch is
 * calendarDatePatch's. The live occurrence of a repeating series keeps its
 * date (said here without the round trip). A move is the task's own update
 * (store.updateTask): optimistic, put back and explained by updateTask
 * itself if refused; a date that needs approval comes back as a request -
 * the store has already said so, with Withdraw as its Undo. Otherwise an
 * Undo toast: the server-side Undo of that due-history entry (no extension
 * counted for the trip back, no second bell), or putting the dates back
 * when there is no entry to name. Resolves to the saved task, or null.
 */
export async function moveTaskToDay(store, task, iso) {
  const patch = calendarDatePatch(task, iso);
  if (!task || !patch || !store?.updateTask) return null;
  if (!patch.dueOn && clearingStopsSeries(task)) {
    if (store.notify) store.notify(SERIES_NEEDS_DUE); else alert(SERIES_NEEDS_DUE);
    return null;
  }
  const back = previousDates(task, patch);
  let saved;
  try { saved = await store.updateTask(task.id, patch); } catch { return null; }
  if (wasSentForApproval(saved, patch)) return saved;
  const at = undoEntryAt(saved, patch);
  store.offerUndo?.(datesLabel(task, patch), () => (at && store.undoDueChange
    ? store.undoDueChange(task.id, at)
    : store.updateTask(task.id, back)).catch(() => {}));
  return saved;
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

/** A task whose FIRST due date is waiting for approval (Oct 22 2026): it has
 *  no date yet, and the one asked for sits in dueProposal until the
 *  requester or a manager decides (task_due.request_extension - a date set
 *  after clearing one can need approval, see task_due.last_cleared). The
 *  Unscheduled pane says so and offers no second request meanwhile. */
export function awaitingFirstDate(task) {
  return !!task && !day(task.dueOn) && task.dueAgreement === 'extension_requested' && !!day(task.dueProposal?.dueOn);
}

/** Whether a filter on the calendar's list hides every task with no due date
 *  (Overdue / Today / This Week, or a date range) - the Unscheduled pane is
 *  then empty for a reason other than "everything is scheduled". */
export function dueFilterHidesUndated(filter) {
  const due = filter?.due || 'any';
  return (due !== 'any' && due !== 'none') || !!filter?.dueFrom || !!filter?.dueTo;
}

export const movedLabel = (patch) => `Moved to ${fmtDate(day(patch.dueOn))}`;

/** The Undo toast's words for any calendar date change: a move, a newly
 *  scheduled task, or a due date taken off. */
export function datesLabel(task, patch) {
  if (!day(patch?.dueOn)) return 'Due date removed';
  return day(task?.dueOn) ? movedLabel(patch) : `Scheduled for ${fmtDate(day(patch.dueOn))}`;
}

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };

/**
 * The Unscheduled pane's rows: the open tasks in `tasks` - exactly the set
 * the calendar was handed, so its filters, project scope and subtask rule
 * apply unchanged - with no due date, Urgent first, then the newest.
 * `search` narrows by title. Returns { all, rows }: `all` is the count the
 * header shows, `rows` what the search leaves.
 */
export function unscheduledTasks(tasks, search = '') {
  const all = (tasks || []).filter((t) => t && !t.completed && !day(t.dueOn));
  all.sort((a, b) => ((PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4))
    || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    || String(a.title || '').localeCompare(String(b.title || '')));
  const q = String(search || '').trim().toLowerCase();
  return { all, rows: q ? all.filter((t) => String(t.title || '').toLowerCase().includes(q)) : all };
}

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

// The Unscheduled pane open or collapsed, remembered per person on this
// browser. Storage can be missing or throw (a private window, blocked site
// data): the pane is then simply open, as it is the first time.
const paneKey = (email) => `nexus.calendarUnscheduled.${String(email || '').toLowerCase() || 'me'}`;
export function readPaneOpen(email) {
  try { return localStorage.getItem(paneKey(email)) !== '0'; } catch { return true; }
}
export function writePaneOpen(email, open) {
  try { localStorage.setItem(paneKey(email), open ? '1' : '0'); } catch { /* not remembered - harmless */ }
}
