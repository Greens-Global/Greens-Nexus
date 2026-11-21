import { useLayoutEffect, useRef } from 'react';

// An asset (or one of its tabs) opens at the top of the page. The DOCUMENT is what scrolls
// here (.viewport has no height), and the portfolio list and every asset share one mounted
// tree, so without this a new asset kept the list's or the last asset's scroll and landed
// on Unit Mix / Project Team. `key` is "<id>:<view>" (null = the portfolio, left alone).
// A deep link that brings a fresh `highlight` scrolls to its row itself - never yank it back.
export function useOpenAtTop(key, highlight) {
  const last = useRef({ key: null, highlight: null });
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { key, highlight };
    if (!key || key === prev.key) return;
    if (highlight && highlight !== prev.highlight) return;
    const el = document.scrollingElement || document.documentElement;
    if (el) el.scrollTop = 0;
  }, [key, highlight]);
}
