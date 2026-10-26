// A click outside a popup no longer closes it (Sagar, Oct 27 2026 - a stray
// click threw away a half-filled reimbursement). It nudges instead: the popup
// pulses and its close button lights up, so the way out is obvious. Close,
// Cancel and Escape still close it.
//
//   const { nudge, popupClass, closeClass } = usePopupNudge();
//   <div className="overlay" onClick={nudge}>
//     <div role="dialog" className={popupClass}> ... <button className={closeClass} onClick={close}>
//
// Each nudge swaps between two identical animations (style.css .nx-nudge-a /
// -b), so a second click while the first is still playing replays it.
import { useCallback, useState } from 'react';

export function usePopupNudge() {
  const [count, setCount] = useState(0);
  const nudge = useCallback(() => setCount((n) => n + 1), []);
  // For a popup whose open state lives in a parent that stays mounted: call
  // on close, or the next open would replay the last nudge.
  const reset = useCallback(() => setCount(0), []);
  const side = count === 0 ? '' : count % 2 ? 'a' : 'b';
  return {
    nudge,
    reset,
    nudged: count > 0,
    popupClass: side ? `nx-nudge-${side}` : '',
    closeClass: side ? `nx-close-nudge-${side}` : '',
  };
}
