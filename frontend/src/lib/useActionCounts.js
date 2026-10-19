// What is waiting on me (Pranshu, Oct 18 2026): the red dot on a sidebar
// module and the count on the tab inside it. ONE fetch for the whole app
// (GET /me/action-counts, routers/action_counts.py) shared by every screen
// that shows a badge: loaded when the first one mounts, every minute while
// the tab is visible, and shortly after any write the app makes (api.js
// fires DATA_WRITTEN) - so approving a request clears its badge right away.
//
//   const counts = useActionCounts();      // {view: {tab: n}}
//   moduleCount(counts, 'myhr')           // the sidebar dot
//   tabCount(counts, 'myhr', 'timesheet') // the tab's number
import { useSyncExternalStore } from 'react';
import { api } from '../api';
import { pollWhileVisible } from './pollWhileVisible';

export const DATA_WRITTEN = 'nexus:data-written';
const EVERY = 60000;

let counts = {};
const subs = new Set();
let stop = null;
let timer = null;
let inflight = false;
let again = false;

function load() {
  if (inflight) { again = true; return; }
  inflight = true;
  Promise.resolve().then(() => api.actionCounts())   // a throw, too, lands in catch
    .then((r) => { counts = r?.counts || {}; subs.forEach((f) => f()); })
    .catch(() => { /* a badge is never worth an error - keep the last counts */ })
    .finally(() => { inflight = false; if (again) { again = false; load(); } });
}

// Writes come in bursts (save, then a reload of the list) - wait for the dust.
function soon() {
  clearTimeout(timer);
  timer = setTimeout(load, 800);
}

function subscribe(fn) {
  subs.add(fn);
  if (subs.size === 1) {
    load();
    const unpoll = pollWhileVisible(load, EVERY);
    window.addEventListener(DATA_WRITTEN, soon);
    stop = () => { unpoll(); window.removeEventListener(DATA_WRITTEN, soon); clearTimeout(timer); };
  }
  return () => {
    subs.delete(fn);
    if (!subs.size) { stop?.(); stop = null; }
  };
}

export function useActionCounts() {
  return useSyncExternalStore(subscribe, () => counts);
}

export const moduleCount = (c, view) => Object.values(c?.[view] || {}).reduce((a, n) => a + n, 0);
export const tabCount = (c, view, tab) => c?.[view]?.[tab] || 0;
// A module's ModuleTabs list with each tab's count as its `badge`.
export const withBadges = (tabs, c, view) => tabs.map((t) => {
  const n = tabCount(c, view, t.key);
  return n ? { ...t, badge: n } : t;
});
