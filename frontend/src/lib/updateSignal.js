// Shared between the "new version" popup and the signed-in app (Oct 12 2026).
//
// UpdateBanner sits OUTSIDE the sign-in gate and the role context (a tab on
// superseded code is told so whether or not anyone is signed in), so it can
// neither call the API safely nor know who may open What's New. It only says
// "this build is stale" here; FeatureBanner, inside the signed-in app, answers
// "and the new version has a New Feature" when the person can see What's New.
// The popup then offers See What's New.
import { useSyncExternalStore } from 'react';

let state = { stale: false, newFeature: false };
const subs = new Set();
const emit = () => subs.forEach((fn) => fn());

// When this tab loaded, less a margin: a feature can be published a little
// before the deploy that carries it reaches this tab.
export const LOADED_AT = new Date(Date.now() - 30 * 60 * 1000).toISOString();

export function setBuildStale(stale) {
  if (state.stale === !!stale) return;
  state = { ...state, stale: !!stale };
  emit();
}

export function setNewFeature(found) {
  if (state.newFeature === !!found) return;
  state = { ...state, newFeature: !!found };
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
  state = { stale: false, newFeature: false };
  emit();
}
