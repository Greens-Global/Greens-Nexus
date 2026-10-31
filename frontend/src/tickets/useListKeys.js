// Keyboard flow through the desk's list (Oct 31 2026): ↑ ↓ move a highlight
// through `ids` (the rows in the order they are on screen), Enter opens the
// highlighted ticket, Escape clears the highlight. The hook owns only the
// highlight; the caller draws it (data-focused on the row) and decides what
// "open" means - the popup, or the side pane.
//
// The keys belong to the list only when nothing else has a better claim:
// a field (input, textarea, select, contenteditable) keeps what is typed in
// it, a dialog keeps its own keys (a ticket open as a popup, the Resolve
// dialog, a linked task) unless `ownsDialog` says the caller's own dialog
// should still drive the list, and a focused control (a button, a link, a
// tab, a menu, a listbox) keeps Enter and the arrows - Enter must activate
// the button it is on, never open a highlighted row behind it (10/31/2026
// review). Only the page itself (document.body) and the rows (.nx-row-hover)
// hand the keys to the list.
//
// `onMove(id)` may return a promise of a boolean - the caller's dirty guard
// (a ticket open in the pane with unsaved edits asks before it is replaced).
// The highlight moves only once that resolves true, and a second move while
// one is waiting is ignored, so a held arrow key never stacks dialogs.
import { useCallback, useEffect, useRef, useState } from 'react';

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const CONTROL = 'button, a, select, [role="tab"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]';

const closest = (target, sel) => !!(target && typeof target.closest === 'function' && target.closest(sel));
function inField(target) { return closest(target, FIELD); }
function inDialog(target) { return closest(target, '[role="dialog"]'); }
// A control keeps its keys unless it sits inside a list row (the row's own
// inline Status / Priority pickers still let ↑ ↓ walk the list around them).
function onControl(target) {
  if (!target || target === document.body) return false;
  return closest(target, CONTROL) && !closest(target, '.nx-row-hover');
}

export function useListKeys({ ids, enabled = true, onOpen, openId = null, onMove = null, ownsDialog = false }) {
  const [focusState, setFocusState] = useState(null);
  // A highlight on a row that left the list (filtered away, resolved into
  // another tab) is no highlight at all - derived, never stored.
  const focusId = focusState != null && (ids || []).includes(focusState) ? focusState : null;
  // The highlight is also kept in a ref, written the moment it moves: two
  // arrow presses in one tick (a key repeat) must step twice, and the state
  // has not re-rendered between them.
  const curRef = useRef(null);
  const setFocusId = useCallback((id) => { curRef.current = id; setFocusState(id); }, []);
  // Read through a ref (synced after each render) so the one window listener
  // never goes stale and is never re-bound on every render.
  const ref = useRef({ ids, onOpen, openId, onMove });
  useEffect(() => { ref.current = { ids, onOpen, openId, onMove }; });
  // A move whose dirty guard is still asking - further moves wait for it.
  const pendingRef = useRef(false);

  const move = useCallback((step) => {
    if (pendingRef.current) return;
    const { ids: list, openId: open, onMove: moved } = ref.current;
    if (!list || !list.length) return;
    const cur = curRef.current != null && list.includes(curRef.current) ? curRef.current : null;
    // From the highlight; else from the open ticket; else from before the
    // start, so the first ↓ lands on the first row.
    const from = cur != null ? list.indexOf(cur)
      : open != null && list.includes(open) ? list.indexOf(open) : -1;
    const next = Math.min(list.length - 1, Math.max(0, from + step));
    const id = list[next];
    if (id === cur) return;
    if (!moved) { setFocusId(id); return; }
    const answer = moved(id);
    if (!answer || typeof answer.then !== 'function') {
      if (answer !== false) setFocusId(id);
      return;
    }
    pendingRef.current = true;
    answer.then((ok) => { if (ok !== false) setFocusId(id); }, () => {})
      .finally(() => { pendingRef.current = false; });
  }, [setFocusId]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (inField(e.target)) return;
      if (!ownsDialog && inDialog(e.target)) return;
      if (onControl(e.target)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
      // The highlight may point at a row that has since left the list (a tab
      // change) - re-check before opening or clearing.
      const { ids: list, onOpen: open } = ref.current;
      const cur = curRef.current != null && (list || []).includes(curRef.current) ? curRef.current : null;
      if (e.key === 'Enter') {
        if (cur != null && open) { e.preventDefault(); open(cur); }
        return;
      }
      if (e.key === 'Escape') {
        if (cur != null) setFocusId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, ownsDialog, move, setFocusId]);

  return { focusId, setFocusId };
}
