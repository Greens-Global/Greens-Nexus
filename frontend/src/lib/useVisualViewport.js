// The part of the screen the user can actually see.
//
// iOS Safari does not shrink the layout viewport (what `position: fixed;
// inset: 0` and `vh` measure) when the keyboard opens - it slides the
// keyboard OVER it - so anything anchored to the bottom of the layout
// viewport ends up behind the keyboard, with only its top showing (iPhone 14
// / 17 Pro Max, Sept 28 2026). The visual viewport does shrink, so sheets and
// popovers pin themselves to it instead.
//
// Returns { top, left, height, width } in layout-viewport (position: fixed)
// pixels, or null where the API is missing or `enabled` is false - callers
// then fall back to `inset: 0` / window sizes, i.e. exactly what they did
// before. Moved here from tasks/MobileTaskBar.jsx so Modal can share it.
import { useEffect, useState } from 'react';

export function readVisualViewport() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  return vv ? { top: vv.offsetTop || 0, left: vv.offsetLeft || 0, height: vv.height, width: vv.width } : null;
}

export function useVisualViewport(enabled = true) {
  const [box, setBox] = useState(() => (enabled ? readVisualViewport() : null));
  useEffect(() => {
    if (!enabled) { setBox(null); return undefined; }
    const vv = window.visualViewport;
    setBox(readVisualViewport());
    if (!vv) return undefined;
    const update = () => setBox(readVisualViewport());
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, [enabled]);
  return box;
}
