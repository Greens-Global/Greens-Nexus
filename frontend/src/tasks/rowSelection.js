// Spreadsheet-style multi-select for the task list, kept out of the component
// so the fiddly part - which rows a modified click actually means - can be
// reasoned about and tested on its own.
//
// The gestures follow Excel, because that is what people arrive already
// knowing:
//
//   click            toggle that row, and plant the anchor there
//   ctrl/cmd+click   same, but never disturbs the rest of the selection
//   shift+click      select everything between the anchor and this row,
//                    REPLACING what was selected
//   ctrl+shift+click the same range, ADDED to what was selected
//   shift+arrow      walk the far end of the range up or down
//
// Two positions matter and they are not the same one:
//
//   anchorId - where the range is measured FROM. It stays put across
//              successive shift-clicks and shift-arrows, which is what lets
//              you overshoot and come back without losing the start.
//   focusId  - the far end, the row that last moved. Shift+arrow steps this.
//
// Every function here is pure: it takes the current positions and returns the
// next ones, never mutating the Set it is handed.

/** Ids from `a` to `b` inclusive, in list order, whichever way round they are.
 *  Empty if either is missing from `orderedIds` - a row that has been filtered
 *  out of the list can no longer anchor a range. */
export function rangeBetween(orderedIds, a, b) {
  const i = orderedIds.indexOf(a);
  const j = orderedIds.indexOf(b);
  if (i === -1 || j === -1) return [];
  return orderedIds.slice(Math.min(i, j), Math.max(i, j) + 1);
}

const toggled = (selected, id) => {
  const next = new Set(selected);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
};

/** Selection after a click on `id`.
 *
 *  `shift` without a usable anchor degrades to a plain toggle rather than
 *  doing nothing - the first click in a fresh list is how you plant an anchor,
 *  and holding shift for it should not cost you the click. */
export function selectionAfterClick({ selected, orderedIds, id, anchorId, focusId, shift = false, ctrl = false }) {
  const range = shift ? rangeBetween(orderedIds, anchorId, id) : [];
  if (range.length) {
    // The anchor deliberately survives: shift-clicking three rows further down
    // and then two rows back up should re-measure from the same start, not
    // treat the last click as a new beginning.
    const next = ctrl ? new Set([...selected, ...range]) : new Set(range);
    return { selected: next, anchorId, focusId: id };
  }
  return { selected: toggled(selected, id), anchorId: id, focusId: id };
}

/** Selection after shift+ArrowUp / shift+ArrowDown. `dir` is -1 or 1.
 *
 *  Returns `movedTo: null` when nothing changed - no anchor yet, the anchor is
 *  gone from the list, or the range is already against the top or bottom - so
 *  the caller can leave the keystroke to the browser instead of swallowing a
 *  scroll that did nothing. */
export function selectionAfterArrow({ selected, orderedIds, anchorId, focusId, dir }) {
  const unchanged = { selected, anchorId, focusId, movedTo: null };
  // No anchor means no selection to extend. Rather than guess a starting row,
  // this does nothing until a click has said where to measure from.
  if (!anchorId || orderedIds.indexOf(anchorId) === -1) return unchanged;
  const from = focusId && orderedIds.includes(focusId) ? focusId : anchorId;
  const nextIdx = orderedIds.indexOf(from) + dir;
  if (nextIdx < 0 || nextIdx >= orderedIds.length) return unchanged;
  const movedTo = orderedIds[nextIdx];
  return {
    selected: new Set(rangeBetween(orderedIds, anchorId, movedTo)),
    anchorId,
    focusId: movedTo,
    movedTo,
  };
}
