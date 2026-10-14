// The time clock's live view-model, shared between the one engine
// (components/TimeclockWidget.jsx - status poll, punches, screen capture,
// replay, end-of-day) and whichever surface draws it: the sidebar chip on a
// desktop, the floating capsule on a phone. The engine publishes after every
// render; surfaces subscribe. Module scope, like lib/peoplePhotos.js, so the
// Sidebar and the widget need no shared ancestor.
//
// A surface that takes over the desktop drawing claims it (the sidebar chip
// while it is on screen); the capsule then renders only its modals. The claim
// is a counter so two sidebars during a boundary reset never leave it stuck.
import { useSyncExternalStore } from 'react';

let vm = null;
let vmKey = '';
let claims = 0;
// Two subscriber sets on purpose: the engine publishes the view-model and
// listens for claims, the surfaces do the reverse. One shared set made the
// engine re-render on its own publish, publish again, and so on forever.
const vmSubs = new Set();
const claimSubs = new Set();

// Publishes only when something a surface draws has changed - the engine
// renders every second for its own timer, and its action closures are new
// objects each time; neither is a reason to redraw every surface.
export function publishTimeclock(next) {
  const key = JSON.stringify(next, (k, v) => (typeof v === 'function' ? undefined : v));
  if (key === vmKey) { vm = next; return; }
  vm = next; vmKey = key;
  vmSubs.forEach((f) => f(next));
}

const subscribeVm = (cb) => { vmSubs.add(cb); return () => vmSubs.delete(cb); };
const subscribeClaims = (cb) => { claimSubs.add(cb); return () => claimSubs.delete(cb); };

export function useTimeclock() {
  return useSyncExternalStore(subscribeVm, () => vm, () => vm);
}

// Call from a surface that draws the clock in the page chrome. Returns the
// release; the capsule hides while any claim is live.
export function claimTimeclockSurface() {
  claims += 1;
  claimSubs.forEach((f) => f(claims));
  return () => { claims = Math.max(0, claims - 1); claimSubs.forEach((f) => f(claims)); };
}
export function timeclockSurfaceClaimed() { return claims > 0; }

// Hook form of the claim count, for the capsule.
export function useTimeclockClaimed() {
  return useSyncExternalStore(subscribeClaims, () => claims > 0, () => false);
}

// Minutes as H:MM - no seconds (Neil, Oct 14 2026: "very distracting").
export const fmtHM = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
