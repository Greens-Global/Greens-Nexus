// "3 New Updates" over a live list (Neil, 11/07/2026 - effects rebuilt from
// interior.dev). While the reader is scrolled into a list, rows that arrive
// are held back instead of pushing what they are reading down the page; a
// pill floats at the top of the list with the count, and a click (or
// scrolling back to the top) lets them in and goes to the top. A reader
// already at the top sees new rows at once, no pill. Changes to rows already
// shown, and removals, always apply right away - only NEW keys wait.
//
//   const { shown, held, release } = useHeldItems(items, getKey, scrollRef);
//   <div ref={scrollRef} style={{ overflowY: 'auto' }}>
//     <NewItemsPill count={held} noun="Update" onClick={release} />
//     {shown.map(...)}
//   </div>
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { MOTION, prefersReducedMotion, usePresence } from '../lib/motion';

const AT_TOP = 24;   // px of scroll that still counts as "at the top"

export function useHeldItems(items, getKey, scrollRef) {
  const [admitted, setAdmitted] = useState(null);   // Set of keys let in
  const keys = items ? items.map(getKey) : null;
  if (admitted === null && keys) setAdmitted(new Set(keys));   // the first read is all in
  const heldKeys = admitted && keys ? keys.filter((k) => !admitted.has(k)) : [];
  const sig = heldKeys.join('\u0001');
  const latest = useRef(keys);
  useLayoutEffect(() => { latest.current = keys; });

  const admitAll = useCallback(() => setAdmitted(new Set(latest.current || [])), []);
  const atTop = () => { const el = scrollRef?.current; return !el || el.scrollTop <= AT_TOP; };

  const shownCount = keys && admitted ? keys.length - heldKeys.length : 0;
  // Before paint: a reader at the top takes new rows straight in, and rows
  // are never held once nothing else is showing (no list, no pill to click).
  useLayoutEffect(() => {
    if (sig && (atTop() || shownCount === 0)) admitAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, shownCount, admitAll]);
  // Scrolling back up to the top lets the held rows in. Re-bound every
  // render: the list's box can unmount and come back (empty, then not).
  useEffect(() => {
    const el = scrollRef?.current;
    if (!el || !sig) return undefined;
    const on = () => { if (el.scrollTop <= AT_TOP) admitAll(); };
    el.addEventListener('scroll', on, { passive: true });
    return () => el.removeEventListener('scroll', on);
  });

  const release = useCallback(() => {
    admitAll();
    scrollRef?.current?.scrollTo?.({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [admitAll, scrollRef]);

  const shown = items && admitted ? items.filter((it) => admitted.has(getKey(it))) : items;
  return { shown, held: heldKeys.length, release };
}

export default function NewItemsPill({ count, onClick, noun = 'Item' }) {
  const { mounted, closing } = usePresence(count > 0, MOTION.exitFast);
  const [last, setLast] = useState(count);
  if (count > 0 && count !== last) setLast(count);   // keep the words while it fades out
  const n = count > 0 ? count : last;
  return (
    <div className="nx-newpill-wrap" aria-live="polite">
      {mounted && (
        <button type="button" className={`nx-newpill${closing ? ' is-closing' : ''}`} onClick={onClick}>
          <ArrowUp size={13} aria-hidden="true" /> {n} New {n === 1 ? noun : `${noun}s`}
        </button>
      )}
    </div>
  );
}
