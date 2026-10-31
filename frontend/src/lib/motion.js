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
  // Reactive, not motionWait(): a reduced-motion toggle mid-exit re-renders
  // here, and the derived branch below then drops the surface at once.
  const reduce = useReducedMotion();
  const wait = enabled && !reduce ? ms : 0;
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
  const alive = useRef(true);
  useLayoutEffect(() => { cb.current = onClose; });
  // Set inside the effect, not at declaration: StrictMode runs mount ->
  // cleanup -> mount in development, and a ref that is only ever cleared
  // would stay false after the re-run and swallow every close.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, []);
  const requestClose = useCallback((...args) => {
    // A close that lands after the surface is gone (an awaited confirm whose
    // Modal unmounted meanwhile) has nothing to exit and no parent to tell.
    if (!alive.current || timer.current) return;
    const wait = motionWait(ms);
    if (wait === 0) { cb.current?.(...args); return; }
    setClosing(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      cb.current?.(...args);
      // A parent that keeps the surface after all (a busy no-op onClose, a
      // close that only shuts something nested) gets it back visible. Batched
      // with the parent's own update, so a real unmount never flashes.
      if (alive.current) setClosing(false);
    }, wait);
  }, [ms]);
  return [closing, requestClose];
}

// FLIP for lists. Children of `ref` that carry `data-flip="<key>"` glide to
// their new place when they reorder, change group or close a gap, and a key
// seen for the first time fades in. Removal is instant: the neighbors closing
// the gap are the motion. Web Animations API, so an item's own inline
// transform / transition is never touched and jsdom (no animate()) is inert.
//
// The "before" positions are a cache of the last known layout, kept relative
// to the container so window scroll cannot skew it, refreshed after paint
// when a commit changes nothing in the list and whenever something inside
// the container scrolls. A commit that changes the set or order of keys does
// the forced layout read and animates right there.
const FLIP_EASE_MOVE = 'cubic-bezier(.2,.8,.2,1)';   // mirrors --ease-standard
const FLIP_EASE_ENTER = 'cubic-bezier(.16,1,.3,1)';  // mirrors --ease-out
const FLIP_ID = 'nx-flip';  // tags our animations apart from CSS ones
const FLIP_BULK = 12;  // more new items than this in one commit = a load, not an add

export function useFlip(ref) {
  const cache = useRef(new Map());   // key -> { x, y } relative to the container
  const bound = useRef(null);
  const raf = useRef(0);
  const refresh = useRef(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !enabled || prefersReducedMotion() || typeof root.animate !== 'function') return;

    const items = () => {
      const out = new Map(); const dup = new Set();
      for (const el of root.querySelectorAll('[data-flip]')) {
        const k = el.getAttribute('data-flip');
        if (out.has(k)) dup.add(k); else out.set(k, el);
      }
      for (const k of dup) out.delete(k);   // ambiguous key: nobody moves
      return out;
    };
    const place = (el, c) => { const r = el.getBoundingClientRect(); return { x: r.left - c.left, y: r.top - c.top }; };
    // Only this hook's own glides: getAnimations() also returns CSS
    // transitions (a row's hover background), which must not be cancelled
    // nor make a resting row look mid-glide (review, Oct 12).
    const running = (el) => (el.getAnimations?.() || []).filter((a) => a.id === FLIP_ID);

    if (bound.current !== root) {
      // New container (or first run): nothing to animate from yet.
      refresh.current?.off?.();
      const fn = () => {
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(() => {
          if (!root.isConnected) return;
          const c = root.getBoundingClientRect();
          const next = new Map();
          for (const [k, el] of items()) {
            // Mid-glide the rect is the visual, not the layout, position; keep
            // the layout target we already know for that one.
            next.set(k, running(el).length && cache.current.has(k) ? cache.current.get(k) : place(el, c));
          }
          cache.current = next;
        });
      };
      root.addEventListener('scroll', fn, { capture: true, passive: true });
      fn.off = () => root.removeEventListener('scroll', fn, true);
      refresh.current = fn;
      bound.current = root;
      cache.current = new Map();
    }

    const els = items();
    const prevKeys = [...cache.current.keys()].join('\u0001');
    const nextKeys = [...els.keys()].join('\u0001');
    if (prevKeys === nextKeys) { refresh.current(); return; }

    const c = root.getBoundingClientRect();
    const prev = new Map(cache.current);
    // An item still gliding from the last change starts this one from where
    // it visually is, not from where it was heading.
    for (const [k, el] of els) {
      const anims = running(el);
      if (!anims.length) continue;
      prev.set(k, place(el, c));
      anims.forEach((a) => a.cancel());
    }
    const next = new Map();
    for (const [k, el] of els) next.set(k, place(el, c));
    cache.current = next;

    let fresh = 0;
    for (const k of next.keys()) if (!prev.has(k)) fresh++;
    const bulk = prev.size === 0 || fresh > FLIP_BULK;
    for (const [k, el] of els) {
      const p = prev.get(k);
      if (!p) {
        if (!bulk) el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { id: FLIP_ID, duration: MOTION.sm, easing: FLIP_EASE_ENTER });
        continue;
      }
      const n = next.get(k);
      const dx = p.x - n.x; const dy = p.y - n.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { id: FLIP_ID, duration: MOTION.md, easing: FLIP_EASE_MOVE });
    }
  });

  useEffect(() => () => { cancelAnimationFrame(raf.current); refresh.current?.off?.(); }, []);
}

// A value that just changed (a row's status, a card's column) gets one brief
// glow. Returns 0 while idle and a fresh positive number for each change, so
// a `key={n}` on the glow element restarts its animation even when two
// changes land inside one glow. Silent when motion is off, and silent on
// mount unless `isFresh()` says this item changed a moment ago: a card that
// moves to another board column (or a row to another status group) is a new
// element, so its change arrives as a mount (tasks/recentChanges.js).
export function useChangeFlash(value, ms = 900, isFresh = null) {
  const [tick, setTick] = useState(0);
  const prev = useRef(value);
  const count = useRef(0);
  const freshRef = useRef(isFresh);
  useEffect(() => {
    if (!freshRef.current?.()) return undefined;
    const wait = motionWait(ms);
    if (wait === 0) return undefined;
    setTick(++count.current);
    const t = setTimeout(() => setTick(0), wait);
    return () => clearTimeout(t);
    // Mount only: a later change is the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (Object.is(prev.current, value)) return undefined;
    prev.current = value;
    const wait = motionWait(ms);
    if (wait === 0) return undefined;
    setTick(++count.current);
    const t = setTimeout(() => setTick(0), wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return tick;
}

// The two curves every surface moves on, for Web Animations API callers
// (CSS reads the same values as --ease-out and the Blueprint canvas spring):
// one place, so a copy cannot drift (Oct 30 2026).
export const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
export const SPRING = 'cubic-bezier(.34,1.4,.64,1)';
