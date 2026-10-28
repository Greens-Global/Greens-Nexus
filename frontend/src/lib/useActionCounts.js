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
// A count as a badge shows it: never wider than "99+".
export const countText = (n) => (n > 99 ? '99+' : String(n));
// Where a module's count comes from, in the words of its tabs - for the
// sidebar's tooltip ("2 in Time, 1 in People"). Keys are the server's
// (routers/action_counts.py); a tab not listed here just adds to the total.
const TAB_NAMES = {
  myhr: { timesheet: 'Time Sheet', overview: 'Overview', timeoff: 'Time Off' },
  shifts: { requests: 'Requests' },
  hr: { 'hr-time': 'Time', 'hr-people': 'People' },
  accounting: { partners: 'Partners' },
  support: { kb: 'Knowledge Base', open: 'My Tickets' },
  dashboard: { announcements: 'Announcements' },
  workflows: { overview: 'Needs Attention' },   // Oct 28 2026: paused by the system + approvals waiting on me
};
export function countDetail(c, view) {
  return Object.entries(c?.[view] || {})
    .filter(([tab, n]) => n > 0 && TAB_NAMES[view]?.[tab])
    .map(([tab, n]) => `${n} in ${TAB_NAMES[view][tab]}`)
    .join(', ');
}
export const tabCount = (c, view, tab) => c?.[view]?.[tab] || 0;
// A module's ModuleTabs list with each tab's count as its `badge`.
export const withBadges = (tabs, c, view) => tabs.map((t) => {
  const n = tabCount(c, view, t.key);
  return n ? { ...t, badge: n } : t;
});
