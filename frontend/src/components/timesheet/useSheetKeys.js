// Keys on the team Time Sheet (Neil, 11/04/2026, like the Tickets desk):
// ↑ ↓ step through the people in the list, ← → through the pay periods.
// The keys belong to the sheet only when nothing else has a better claim -
// the same rules as tickets/useListKeys.js: a field keeps what is typed in
// it, a dialog or menu keeps its own keys, a focused control keeps its
// arrows (except a person in the team list, which hands them back), and
// the grid (focusable, its own scroll box) keeps every arrow for scrolling.
// The card turns the keys off while one of its popups is open.
import { useEffect, useRef } from 'react';

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const CONTROL = 'button, a, select, [role="tab"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="radiogroup"]';
const closest = (t, sel) => !!(t && typeof t.closest === 'function' && t.closest(sel));

export default function useSheetKeys({ enabled = true, onPerson, onPeriod }) {
  const ref = useRef({ onPerson, onPeriod });
  ref.current = { onPerson, onPeriod };
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const k = e.key;
      if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
      const t = e.target;
      if (closest(t, FIELD) || closest(t, '[role="dialog"], .modal-overlay')) return;
      if (document.querySelector('.modal-overlay, [role="dialog"][aria-modal="true"]')) return;
      if (t && t !== document.body && closest(t, CONTROL) && !closest(t, '.pr-sidebar')) return;
      if (closest(t, '.ts-grid-wrap')) return;   // the grid scrolls with every arrow
      e.preventDefault();
      if (k === 'ArrowUp' || k === 'ArrowDown') ref.current.onPerson?.(k === 'ArrowDown' ? 1 : -1);
      else ref.current.onPeriod?.(k === 'ArrowRight' ? 1 : -1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
