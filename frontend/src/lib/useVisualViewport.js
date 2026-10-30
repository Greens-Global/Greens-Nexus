// The part of the screen the user can actually see.
//
// iOS Safari does not shrink the layout viewport (what `position: fixed;
// inset: 0` and `vh` measure) when the keyboard opens - it slides the
// keyboard OVER it - so anything anchored to the bottom of the layout
// viewport ends up behind the keyboard, with only its top showing (iPhone 14
// / 17 Pro Max, Sept 28 2026). The visual viewport does shrink, so sheets and
// popovers pin themselves to it instead.
//
// Returns { top, left, height, width, clear } in layout-viewport (position: fixed)
// pixels, or null where the API is missing or `enabled` is false - callers
// then fall back to `inset: 0` / window sizes, i.e. exactly what they did
// before. Moved here from tasks/MobileTaskBar.jsx so Modal can share it.
import { useEffect, useState } from 'react';

// The keyboard's ^ v Done strip (Neil, Oct 30 2026: the Notes bar sat
// under it). Newer iOS Safari floats that strip OVER the page inside the
// visual viewport instead of taking it out, so anything pinned to the
// viewport's bottom - the Notes phone bar, a sheet's Save row - was covered.
// While the keyboard is up on an iPhone held upright, `clear` says how much
// room that strip takes: whatever must stay visible (the Notes bar, a sheet's
// panel, a menu placed near the bottom) ends that much higher, while a
// backdrop keeps the full height so the page under it stays dimmed and
// untappable. iPad keeps its bar inside the keyboard, and a landscape phone
// has too little room to give any away, so both get 0. On an older iOS that
// docks the strip with the keyboard this only leaves a small gap above it -
// the safe side to be wrong on.
export const IOS_ACCESSORY_PX = 52;
const isIPhone = () => typeof navigator !== 'undefined' && /iP(hone|od)/.test(navigator.userAgent || '');

/** True while an on-screen keyboard takes the bottom of the screen (not a pinch zoom). */
export function keyboardUp(vv = typeof window !== 'undefined' ? window.visualViewport : null) {
  if (!vv || Math.abs((vv.scale || 1) - 1) > 0.01) return false;
  return window.innerHeight - vv.height > 150;
}

export function readVisualViewport() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return null;
  const clear = keyboardUp(vv) && isIPhone() && vv.width < 600 ? IOS_ACCESSORY_PX : 0;
  return { top: vv.offsetTop || 0, left: vv.offsetLeft || 0, height: vv.height, width: vv.width, clear };
}

/** How far up from the bottom of the page a bar must sit to clear the keyboard
 *  (and iOS's accessory strip); 0 with no keyboard. */
export function useKeyboardInset(active = true) {
  const box = useVisualViewport(active);
  if (!box || typeof window === 'undefined') return 0;
  return Math.max(0, Math.round(window.innerHeight - box.top - box.height + (box.clear || 0)));
}

export function useVisualViewport(enabled = true) {
  const [box, setBox] = useState(() => (enabled ? readVisualViewport() : null));
  useEffect(() => {
    if (!enabled) { setBox(null); return undefined; }
    const vv = window.visualViewport;
    setBox(readVisualViewport());
    if (!vv) return undefined;
    // Same box, same object: callers (the Notes editor) do not re-render on
    // every scroll tick while nothing they use has changed.
    const same = (a, b) => a && b && a.top === b.top && a.left === b.left && a.height === b.height && a.width === b.width && a.clear === b.clear;
    const update = () => { const n = readVisualViewport(); setBox((p) => (same(p, n) ? p : n)); };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, [enabled]);
  return box;
}
