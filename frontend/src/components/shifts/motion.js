// Motion for the Shifts screens (10/02): the JS half of the tokens in
// style.css ("Shifts motion"). Durations here mirror the CSS variables and
// are only used for timers (how long a class stays on). Every animation is
// transform/opacity only, and reduced motion turns all of it off: the CSS
// does it with a media query, and the components skip the classes outright
// through useReducedMotion(), so nothing even starts.
import { createElement, useEffect, useRef, useState } from 'react';
// The reduced-motion pair now lives with the app-wide motion hooks
// (lib/motion.js, Oct 11); re-exported so the Shifts imports stay as they are.
import { prefersReducedMotion, useReducedMotion } from '../../lib/motion';
export { prefersReducedMotion, useReducedMotion };

export const MOTION = { fast: 120, base: 150, pop: 160, slide: 180, panel: 200, glow: 1500, stagger: 15, staggerCap: 200, undoMs: 5000 };

// A number that rolls up or down when it changes (the Share count).
export function RollingNumber({ value }) {
  const reduce = useReducedMotion();
  const prev = useRef(value);
  const [dir, setDir] = useState('');
  useEffect(() => {
    if (prev.current !== value) { setDir(value > prev.current ? 'up' : 'down'); prev.current = value; }
  }, [value]);
  const cls = !reduce && dir ? `m-roll m-roll-${dir}` : 'm-roll';
  return createElement('span', { className: cls, 'data-motion': !reduce && dir ? dir : undefined }, createElement('span', { key: value }, value));
}
