// Keyboard flow through the desk's list (Oct 31 2026): ↑ ↓ move a highlight
// through `ids` (the rows in the order they are on screen), Enter opens the
// highlighted ticket, Escape clears the highlight. The hook owns only the
// highlight; the caller draws it (data-focused on the row) and decides what
// "open" means - the popup, or the side pane.
//
// Keys typed into a field (input, textarea, select, contenteditable) are the
// field's, and keys inside a dialog are the dialog's - a ticket open as a
// popup, the Resolve dialog, a linked task - unless `ownsDialog` says the
// caller's own dialog should still drive the list (the side pane is not a
// dialog, so it never needs this; it exists for a caller that hosts the list
// inside one).
import { useCallback, useEffect, useRef, useState } from 'react';

const FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function inField(target) {
  return !!(target && typeof target.closest === 'function' && target.closest(FIELD));
}
function inDialog(target) {
  return !!(target && typeof target.closest === 'function' && target.closest('[role="dialog"]'));
}

export function useListKeys({ ids, enabled = true, onOpen, openId = null, onMove = null, ownsDialog = false }) {
  const [focusId, setFocusState] = useState(null);
  // The highlight is also kept in a ref, written the moment it moves: two
  // arrow presses in one tick (a key repeat) must step twice, and the state
  // has not re-rendered between them.
  const curRef = useRef(null);
  const setFocusId = useCallback((id) => { curRef.current = id; setFocusState(id); }, []);
  // Read through refs so the one window listener never goes stale and is
  // never re-bound on every render.
  const ref = useRef({ ids, onOpen, openId, onMove });
  ref.current = { ids, onOpen, openId, onMove };

  // A highlight on a row that left the list (filtered away, resolved into
  // another tab) is no highlight at all.
  useEffect(() => {
    if (focusId != null && !(ids || []).includes(focusId)) setFocusId(null);
  }, [ids, focusId, setFocusId]);

  const move = useCallback((step) => {
    const { ids: list, openId: open, onMove: moved } = ref.current;
    const cur = curRef.current;
    if (!list || !list.length) return;
    // From the highlight; else from the open ticket; else from before the
    // start, so the first ↓ lands on the first row.
    const from = cur != null && list.includes(cur) ? list.indexOf(cur)
      : open != null && list.includes(open) ? list.indexOf(open) : -1;
    const next = Math.min(list.length - 1, Math.max(0, from + step));
    const id = list[next];
    if (id === cur) return;
    setFocusId(id);
    moved?.(id);
  }, [setFocusId]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (inField(e.target)) return;
      if (!ownsDialog && inDialog(e.target)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
      if (e.key === 'Enter') {
        const cur = curRef.current;
        const { onOpen: open } = ref.current;
        if (cur != null && open) { e.preventDefault(); open(cur); }
        return;
      }
      if (e.key === 'Escape') {
        if (curRef.current != null) setFocusId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, ownsDialog, move, setFocusId]);

  return { focusId, setFocusId };
}
