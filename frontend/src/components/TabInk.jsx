import { useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../lib/motion';

// The sliding highlight behind a tab strip's active tab (Oct 11, 2026).
//
// The strip renders this as its first child and keeps `.active` on the real
// button for color, aria-current and the tests; the ink only DRAWS the pill
// (header strip) or the underline (phone strip) and glides it to wherever
// `.active` is now. It measures its PARENT element (a child's layout effect
// runs before the parent's ref is attached, so a ref prop would be null on
// first paint) from the active button's offset box, so it scrolls with the
// strip and follows a resize (ResizeObserver). The first measurement after
// mount jumps into place - a strip that just appeared has nothing to glide
// from - and the caller keys the ink on the tab set so a new module's strip
// starts fresh instead of sliding over from the old one. Width is the one
// non-transform property in the transition: a single small element, and
// scaleX would warp the pill's corners.
export default function TabInk({ active, variant = 'pill' }) {
  const reduce = useReducedMotion();
  const self = useRef(null);
  const [box, setBox] = useState(null);
  const settled = useRef(false);

  useLayoutEffect(() => {
    const strip = self.current?.parentElement;
    if (!strip) return undefined;
    const measure = () => {
      const el = strip.querySelector(':scope > .active');
      // No active tab, or a strip with no layout (the phone strip is
      // display:none on desktop): nothing to draw, and nothing to glide FROM
      // once it does show - it jumps into place then.
      if (!el || (!el.offsetWidth && !el.offsetHeight)) { settled.current = false; setBox(null); return; }
      setBox({ x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, glide: settled.current });
      settled.current = true;
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    // The tabs too: a badge or label changing width inside a long strip that
    // scrolls (max-width + overflow) moves the active tab without resizing
    // the strip itself.
    for (const c of strip.children) if (c !== self.current) ro.observe(c);
    return () => ro.disconnect();
  }, [active]);

  return (
    <span
      ref={self}
      aria-hidden="true"
      hidden={!box}
      className={`tab-ink tab-ink--${variant}${box?.glide && !reduce ? ' tab-ink--glide' : ''}`}
      style={box ? { transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h } : undefined}
    />
  );
}
