// Background scroll lock for sheets and modals (phones).
//
// Without it a swipe that runs past the end of a sheet's own scrolling body
// scrolls the page underneath, and on iOS the page keeps scrolling behind the
// dimmed backdrop. `overflow: hidden` on <body> alone is not enough on iOS
// Safari, so the body is pinned with `position: fixed` at minus the current
// scroll offset (the page does not visibly move), and the exact offset is put
// back when the last lock is released.
//
// Ref-counted: a dialog opened from a drawer adds a second lock, and the page
// only unlocks when both are gone. `overflow: hidden` is also what
// components/PullToRefresh.jsx checks to stand down while a sheet is open.
import { useEffect } from 'react';

let count = 0;
let saved = null;

function lock() {
  const b = document.body.style;
  const x = window.scrollX || 0;
  const y = window.scrollY || 0;
  saved = { x, y, position: b.position, top: b.top, left: b.left, right: b.right, width: b.width, overflow: b.overflow };
  b.position = 'fixed';
  b.top = `-${y}px`;
  b.left = '0';
  b.right = '0';
  b.width = '100%';
  b.overflow = 'hidden';
}

function unlock() {
  if (!saved) return;
  const { x, y, ...prev } = saved;
  saved = null;
  Object.assign(document.body.style, prev);
  // 'instant': a global `scroll-behavior: smooth` would otherwise animate the
  // page back from the top instead of simply being where it was.
  try { window.scrollTo({ left: x, top: y, behavior: 'instant' }); } catch { /* not implemented (jsdom) */ }
}

export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined;
    if (count++ === 0) lock();
    return () => { if (--count === 0) unlock(); };
  }, [active]);
}

// For tests: how many locks are held right now.
export const scrollLockCount = () => count;
