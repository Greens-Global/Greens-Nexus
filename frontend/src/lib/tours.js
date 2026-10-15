// The guided tours, in one place (Neil, Oct 14 2026: "the Tour ... was
// supposed to get added into the help section ... I don't see that").
//
// A screen that has a tour registers it while it is on the page, so the
// Help panel's "Take the Tour" always matches the screen in front of you
// (Tasks, Tickets, Support, Documents, the Timecard, Roles & Access - and
// any tour added later, with no list to keep in step). On a screen with no
// tour the card lists every tour the person can reach; picking one goes
// there and the tour starts as soon as that screen registers it.
import { useSyncExternalStore } from 'react';

// Every tour, for the list. `view` / `sub` is where it lives; `need` is the
// access it takes: the Help doc id whose access opens that screen, or
// 'administrator'.
export const TOURS = [
  { key: 'tasks', label: 'Tasks', view: 'tasks', need: 'tasks' },
  { key: 'tickets', label: 'Tickets', view: 'tickets', need: 'tickets' },
  { key: 'documents', label: 'Documents', view: 'documents', need: 'documents' },
  { key: 'timecard', label: 'Timecard', view: 'hr', sub: 'hr-time', need: 'people' },
  { key: 'roles', label: 'Roles & Access', view: 'admin-console', sub: 'access', need: 'administrator' },
  { key: 'support', label: 'Support', view: 'support', need: '' },
];

const live = new Map();          // key -> { label, open }
const listeners = new Set();
let snapshot = [];
let pending = '';
let pendingAt = 0;
// A tour waits for its screen a few seconds at most: a move that was
// cancelled (unsaved work, Cancel) must not start it on some later visit.
const PENDING_MS = 8000;
const fresh = (at) => Date.now() - at < PENDING_MS;
const emit = () => { snapshot = [...live.entries()].map(([key, v]) => ({ key, ...v })); listeners.forEach((l) => l()); };

/** A screen's tour, while it is on the page. Returns the unregister. If the
 *  Help panel sent the person here for this tour, it starts now. */
export function registerTour(key, label, open) {
  live.set(key, { label, open });
  emit();
  if (pending === key && fresh(pendingAt)) {
    pending = '';
    setTimeout(open, 0);   // after the screen's first paint, so its targets exist
  }
  return () => { if (live.get(key)?.open === open) { live.delete(key); emit(); } };
}

/** The tours on the page right now (newest last). */
export function useLiveTours() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => snapshot, () => snapshot);
}

/** Start a tour: on this screen, at once; elsewhere, go there first. */
export function startTour(t) {
  const here = live.get(t.key);
  if (here) { here.open(); return; }
  pending = t.key;
  pendingAt = Date.now();
  window.dispatchEvent(new CustomEvent('nexus:navigate', { detail: { view: t.view, sub: t.sub || null } }));
}

/** Starts this screen's built-for-the-page tour (HelpMenu hosts it). */
export const AUTO_TOUR_EVENT = 'nexus:auto-tour';

// A built-for-the-page tour (lib/autoTour.js) waiting for its screen.
let pendingAuto = '';
let pendingAutoAt = 0;
export function setPendingAutoTour(view) { pendingAuto = view || ''; pendingAutoAt = Date.now(); }
/** True once, for the screen the Help panel sent the person to. */
export function takePendingAutoTour(view) {
  if (!pendingAuto || pendingAuto !== view) return false;
  pendingAuto = '';
  return fresh(pendingAutoAt);
}

/** Tests only. */
export function __resetTours() { live.clear(); pending = ''; pendingAuto = ''; emit(); }
