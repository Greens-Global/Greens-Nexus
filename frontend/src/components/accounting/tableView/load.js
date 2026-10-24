import { lazy } from 'react';

// The standard table view's panels and menus (./panels) are fetched the first
// time one opens - or a moment before, when the pointer reaches a control - so
// the Accounting screens do not carry them (10/23 meeting, item 01; the
// Accounting chunk is at its 1,000 KB budget).
export const Panels = lazy(() => import('./panels'));
let preloaded = false;
/** Fetch the panels ahead of the first click (hover / focus on a control). */
export const preloadPanels = () => {
  if (preloaded) return;
  preloaded = true;
  import('./panels').catch(() => { preloaded = false; });
};
