// Shared between the "new version" popup and the signed-in app (Oct 12 2026).
//
// UpdateBanner sits OUTSIDE the sign-in gate (a tab on superseded code is told
// so whether or not anyone is signed in), so it cannot call the API safely.
// It only says "this build is stale" here; FeatureBanner, inside the signed-in
// app, answers with what the waiting version brings, by category, and the
// popup turns that into "Includes 2 new features and 3 bug fixes" and a See
// What's New button.
import { useSyncExternalStore } from 'react';

let state = { stale: false, release: null };   // release: { counts, total }
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());

// The running build's time (vite.config.js), so "what the waiting version
// brings" is exactly what came after it. A tab on a build with no stamp falls
// back to when it loaded.
export const RUNNING_SINCE = import.meta.env.VITE_BUILD_TIME || new Date().toISOString();

export function setBuildStale(stale) {
  if (state.stale === !!stale) return;
  state = { ...state, stale: !!stale };
  emit();
}

export function setReleaseSummary(release) {
  const next = release && release.total > 0 ? { counts: release.counts || {}, total: release.total } : null;
  if (JSON.stringify(next) === JSON.stringify(state.release)) return;
  state = { ...state, release: next };
  emit();
}

export function useUpdateSignal() {
  return useSyncExternalStore(
    (fn) => { subs.add(fn); return () => subs.delete(fn); },
    () => state,
    () => state,
  );
}

// Test seam.
export function __resetUpdateSignal() {
  state = { stale: false, release: null };
  emit();
}
