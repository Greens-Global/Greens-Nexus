// Sheets stacked on sheets (Neil, 11/01/2026): a popup that opens over
// another popup slides in on top, and the one beneath recedes a little
// (style.css `.nx-sheet-right[data-nx-under]`) so the eye reads depth, then
// comes back when the top one goes. One module-level stack, in mount order:
// the newest sheet is upright, every other carries data-nx-under.
//
//   useSheetStack(panelRef, isSheet, closing)
//
// `active` false (a centered card, a phone sheet) never joins. `closing`
// (lib/motion.js useExit's flag) releases the slot the moment the exit starts,
// so the sheet beneath comes back while the top one is still sliding out
// instead of a beat after it has gone. Attributes are written straight to the
// nodes - no React state, nothing re-renders.
import { useLayoutEffect } from 'react';

const stack = [];

function apply() {
  const top = stack.length - 1;
  stack.forEach((el, i) => {
    if (i < top) el.setAttribute('data-nx-under', '');
    else el.removeAttribute('data-nx-under');
  });
}

function release(el) {
  const i = stack.indexOf(el);
  if (i < 0) return;
  stack.splice(i, 1);
  el.removeAttribute('data-nx-under');
  apply();
}

export function useSheetStack(ref, active = true, closing = false) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    stack.push(el);
    apply();
    return () => release(el);
  }, [ref, active]);
  useLayoutEffect(() => {
    if (closing && ref.current) release(ref.current);
  }, [ref, closing]);
}

/** How many sheets are open right now - for tests and for a debugger. */
export function sheetStackSize() { return stack.length; }
