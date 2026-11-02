// Sheets stacked on sheets (Neil, 11/01/2026): a popup that opens over
// another popup slides in on top, and the one beneath recedes a little
// (style.css `.nx-sheet-right[data-nx-under]`) so the eye reads depth, then
// comes back when the top one goes. One module-level stack of `{ el, z }`
// entries:
//
//   useSheetStack(panelRef, isSheet, closing, z)
//
//   - The top of the stack is whatever PAINTS on top: the highest z-index
//     (`z`, the sheet's own: the tasks Modal 4000, the task drawer 3500, the
//     marketing Modal 50), and at equal z the one later in the document.
//     Only that one is upright, so a sheet recedes only the sheets whose z
//     is at or below its own - a drawer opened UNDER a Modal (lower z) never
//     pushes the Modal back. Document order, not mount order: sheets that
//     mount in one commit run their layout effects child first, and two
//     portals nested in one commit land in <body> child first too, so the
//     parent's overlay is the one later in the DOM and painting on top.
//   - a receded sheet also gets `inert`, so Tab and a stray click cannot
//     reach a form that is half hidden; both attributes go on release.
//
// `active` false (a centered card, a phone sheet) never joins. `closing`
// (lib/motion.js useExit's flag) releases the slot the moment the exit starts,
// so the sheet beneath comes back while the top one is still sliding out
// instead of a beat after it has gone; a close that is cancelled (closing
// back to false, the sheet still open) joins again in its old place.
// Attributes are written straight to the nodes - no React state, nothing
// re-renders.
import { useEffect, useLayoutEffect, useState } from 'react';

// Every sheet's shadow and edge, cast to the left where it meets the page.
// style.css "Sheets" sets the same two on every .nx-sheet-right and on the
// class-styled shells; inline-styled sheets use these so the values agree.
export const SHEET_SHADOW = '-8px 0 40px rgba(0,0,0,.18)';
export const SHEET_EDGE = '1px solid var(--line)';

const stack = [];

function setUnder(el, under) {
  if (under) {
    el.setAttribute('data-nx-under', '');
    el.setAttribute('inert', '');
  } else {
    el.removeAttribute('data-nx-under');
    el.removeAttribute('inert');
  }
}

// Negative when `a` comes first in the document (an ancestor comes before
// the nodes inside it).
function docOrder(a, b) {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function apply() {
  const order = [...stack].sort((a, b) => (a.z - b.z) || docOrder(a.el, b.el));
  const top = order[order.length - 1];
  // A sheet whose DOM holds the top one (an un-portaled nested sheet) is never
  // receded: its transform and inert would carry the top sheet with it.
  for (const s of order) setUnder(s.el, s !== top && !s.el.contains(top.el));
}

function release(entry) {
  const i = stack.indexOf(entry);
  if (i < 0) return;
  stack.splice(i, 1);
  setUnder(entry.el, false);
  if (stack.length) apply();
}

export function useSheetStack(ref, active = true, closing = false, z = 0) {
  useLayoutEffect(() => {
    if (!active || closing) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const entry = { el, z: Number(z) || 0 };
    stack.push(entry);
    apply();
    return () => release(entry);
  }, [ref, active, closing, z]);
}

// The body cascade (style.css `.nx-sheet-right.is-entering .nx-cascade`)
// plays only while the sheet arrives: `entering` is true from the render
// that makes the shell a sheet until `ms` later. Without the gate, a row
// that mounts later (data arriving, a tab switch) would slide in by itself.
// The flag is set during render (a shell that BECOMES a sheet, a window
// widened past the phone breakpoint, enters again) and the effect only
// clears it, from a timer.
export const SHEET_ENTER_MS = 500;
export function useSheetEntering(isSheet, ms = SHEET_ENTER_MS) {
  const [prev, setPrev] = useState(isSheet);
  const [entering, setEntering] = useState(!!isSheet);
  if (prev !== isSheet) {
    setPrev(isSheet);
    setEntering(!!isSheet);
  }
  useEffect(() => {
    if (!entering) return undefined;
    const t = setTimeout(() => setEntering(false), ms);
    return () => clearTimeout(t);
  }, [entering, ms]);
  return entering && !!isSheet;
}

/** How many sheets are open right now - for tests and for a debugger. */
export function sheetStackSize() { return stack.length; }
