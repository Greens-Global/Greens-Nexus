// Task Module - the arithmetic behind dragging a Timeline bar (Oct 2026).
// Pure, so the snapping and clamping are testable without a pointer.
//
// A bar can be MOVED (both dates shift), or its START or END edge dragged
// (one date changes, the other holds). Days are whole; a bar is at least
// one day long. A task with only a due date moves as a one-day bar; dragging
// its start edge gives it a start date.

export const DAY_W = 26;     // px per day - must match TimelineView's grid
export const HANDLE_W = 7;   // px at each end of a bar that act as a resize handle

const toISO = (d) => d.toISOString().slice(0, 10);
const fromISO = (s) => new Date(s + 'T00:00:00Z');
export const addDays = (iso, n) => { if (!iso) return ''; const d = fromISO(iso); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };

/** Pixels of pointer travel to whole days, snapping to the nearest day. */
export function daysFromPixels(dx, dayW = DAY_W) {
  return Math.round(dx / dayW);
}

/** Which drag a pointer-down at `offsetX` inside a bar of `width` starts. */
export function dragModeAt(offsetX, width, handle = HANDLE_W) {
  if (width <= handle * 3) return 'move';   // a one-day bar is all handle: just move it
  if (offsetX <= handle) return 'start';
  if (offsetX >= width - handle) return 'end';
  return 'move';
}

/**
 * New dates for `task` after `days` of drag in `mode`, or null when nothing
 * would change. Only the fields that exist (or that the drag creates) are
 * returned, as { startOn, dueOn }.
 */
export function dragDates(task, mode, days) {
  const start = task.startOn || '';
  const due = task.dueOn || '';
  if (!days || (!start && !due)) return null;
  if (mode === 'move') {
    return { startOn: start ? addDays(start, days) : '', dueOn: due ? addDays(due, days) : '' };
  }
  if (mode === 'start') {
    const base = start || due;
    let ns = addDays(base, days);
    const limit = due || base;
    if (ns > limit) ns = limit;            // never past the end
    if (ns === start) return null;
    return { startOn: ns, dueOn: due };
  }
  if (mode === 'end') {
    const base = due || start;
    let nd = addDays(base, days);
    const limit = start || base;
    if (nd < limit) nd = limit;            // never before the start
    if (nd === due) return null;
    return { startOn: start, dueOn: nd };
  }
  return null;
}

/** "Moved “Title” to 10/12/2026 – 10/15/2026 · 2 dependent tasks moved · 1 not moved (no access)". */
export function describeMove(title, dates, movedCount, skippedCount, fmt) {
  const span = dates.startOn && dates.dueOn && dates.startOn !== dates.dueOn
    ? `${fmt(dates.startOn)} - ${fmt(dates.dueOn)}`
    : fmt(dates.dueOn || dates.startOn);
  const parts = [`Moved "${title}" to ${span}`];
  if (movedCount) parts.push(`${movedCount} dependent task${movedCount === 1 ? '' : 's'} moved`);
  if (skippedCount) parts.push(`${skippedCount} not moved (no access)`);
  return parts.join(' · ');
}
