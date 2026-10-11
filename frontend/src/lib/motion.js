// Motion for all of Nexus (Oct 11, 2026): the JS half of the `--dur-*` /
// `--ease-*` tokens in style.css. Durations here are only used for timers
// (how long a surface stays mounted while its exit animation plays); the
// animations themselves are CSS, transform/opacity only.
//
// Rules this encodes (ui-ux-pro-max, Animation):
//   - exits are shorter than enters (~70%), ease-in out, ease-out in;
//   - never depend on animationend for correctness: a timer unmounts, and
//     the final state is set directly;
//   - reduced motion skips everything, including the wait.
//
// Two hooks cover the two ways a surface closes:
//   usePresence(open)  - the PARENT owns `open` (AnchoredMenu, DialogHost).
//                        Keeps the surface mounted for the exit and hands it
//                        `closing` to put an `is-closing` class on.
//   useExit(onClose)   - the parent UNMOUNTS the surface when onClose fires
//                        (every `{open && <Modal onClose={...}/>}` call site).
//                        Returns [closing, requestClose]: requestClose plays
//                        the exit, then calls the parent's onClose once.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const MOTION = {
  xs: 100, sm: 150, md: 220, lg: 320,   // mirror --dur-xs .. --dur-lg
  exit: 150,                            // modal / sheet exit (70% of md)
  exitFast: 100,                        // menu / popover exit (70% of sm)
};

export function prefersReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { return false; }
}

export function useReducedMotion() {
  const [reduce, setReduce] = useState(prefersReducedMotion);
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia?.('(prefers-reduced-motion: reduce)'); } catch { mq = null; }
    if (!mq?.addEventListener) return undefined;
    const on = () => setReduce(!!mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduce;
}

// Vitest renders without a compositor and most tests assert that a closed
// menu is gone on the next query, so under `MODE === 'test'` nothing waits.
// A motion test flips this on explicitly.
let enabled = import.meta.env?.MODE !== 'test';
export function setMotionEnabled(on) { enabled = !!on; }

// How long to keep a closing surface mounted: 0 when motion is off.
export function motionWait(ms) {
  return enabled && !prefersReducedMotion() ? ms : 0;
}

export function usePresence(open, ms = MOTION.exit) {
  const wait = motionWait(ms);
  const [present, setPresent] = useState(!!open);
  // Derived during render, not in an effect: an opening surface must be in
  // the tree on the very render that asked for it (autoFocus, measuring).
  if (open && !present) setPresent(true);
  if (!open && present && wait === 0) setPresent(false);
  useEffect(() => {
    if (open || !present || wait === 0) return undefined;
    const t = setTimeout(() => setPresent(false), wait);
    return () => clearTimeout(t);
  }, [open, present, wait]);
  return { mounted: present, closing: present && !open };
}

export function useExit(onClose, ms = MOTION.exit) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  const cb = useRef(onClose);
  useLayoutEffect(() => { cb.current = onClose; });
  useEffect(() => () => clearTimeout(timer.current), []);
  const requestClose = useCallback((...args) => {
    if (timer.current) return;                 // already on its way out
    const wait = motionWait(ms);
    if (wait === 0) { cb.current?.(...args); return; }
    setClosing(true);
    timer.current = setTimeout(() => { timer.current = null; cb.current?.(...args); }, wait);
  }, [ms]);
  return [closing, requestClose];
}
