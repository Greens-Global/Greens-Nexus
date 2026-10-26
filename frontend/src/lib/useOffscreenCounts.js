import { useCallback, useEffect, useState } from 'react';

// "3 waiting below" (Neil, Oct 25 2026): a module with something waiting on
// me that is scrolled out of a navigation list - the desktop rail shows about
// half its modules on a laptop, the phone menu about two thirds - gets a pill
// at that edge that brings it into view, the way Slack points at unread
// channels. Rows mark themselves with data-count; a row under the pill
// counts as out of view.
const EDGE = 38;   // the pill's height and margin

export function useOffscreenCounts(ref, deps) {
  const [offscreen, setOffscreen] = useState({ above: 0, below: 0 });
  useEffect(() => {
    const box = ref.current;
    if (!box) return undefined;
    const check = () => {
      const b = box.getBoundingClientRect();
      // Only an edge the list can still scroll toward hides anything: at the
      // very top nothing is "above", fully scrolled nothing is "below".
      const canUp = box.scrollTop > 1;
      const canDown = box.scrollTop + box.clientHeight < box.scrollHeight - 1;
      let above = 0, below = 0;
      box.querySelectorAll('[data-count]').forEach((el) => {
        const r = el.getBoundingClientRect();
        const n = Number(el.dataset.count) || 0;
        if (canUp && r.top < b.top + EDGE) above += n;
        else if (canDown && r.bottom > b.bottom - EDGE) below += n;
      });
      setOffscreen((o) => (o.above === above && o.below === below ? o : { above, below }));
    };
    check();
    box.addEventListener('scroll', check, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(box);
    // Rows come and go (grants load late, Act As changes what is visible).
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(check) : null;
    mo?.observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-count'] });
    return () => { box.removeEventListener('scroll', check); ro?.disconnect(); mo?.disconnect(); };
  }, deps);   // eslint-disable-line react-hooks/exhaustive-deps

  // Center the nearest such row in the list (clear of the pill), scrolling
  // only the list itself.
  const reveal = useCallback((dir) => {
    const box = ref.current;
    if (!box) return;
    const b = box.getBoundingClientRect();
    const rows = [...box.querySelectorAll('[data-count]')];
    const el = dir === 'below'
      ? rows.find((x) => x.getBoundingClientRect().bottom > b.bottom - EDGE)
      : rows.reverse().find((x) => x.getBoundingClientRect().top < b.top + EDGE);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    box.scrollTo?.({ top: Math.max(0, box.scrollTop + (r.top - b.top) - (b.height - r.height) / 2), behavior: calm ? 'auto' : 'smooth' });
  }, [ref]);

  return [offscreen, reveal];
}
