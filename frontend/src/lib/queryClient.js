// TanStack Query foundation (Aug 1, 2026).
//
// Why this exists: the app fetched data per-screen with useEffect, so revisiting
// a screen re-requested data it already had, and nothing coordinated refetching
// after a write. TanStack Query is the industry-standard fix - a shared client
// cache keyed by request, with dedup, background refresh, and mutation-driven
// invalidation. This is the scalable foundation every new screen should build on.
//
// It does NOT replace api.js. api.js stays the fetch engine (MSAL auth, retry,
// Act-As header, error shaping); TanStack Query calls INTO it and manages the
// cache around it. One responsibility each.
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // api.js already does exponential-backoff retry on GET (cold starts, 5xx),
      // so a second retry layer here would multiply the wait. Let api.js own it.
      retry: false,
      // Serve cached data instantly on revisit; refetch in the background only
      // once it's older than this. Per-query hooks override for slower data.
      staleTime: 60_000,
      // Keep an unused query's data for 5 min before eviction, so navigating
      // away and back is instant rather than a cold fetch.
      gcTime: 5 * 60_000,
      // The app has its own visibility-aware polling (pollWhileVisible) and
      // Supabase realtime pings; refetch-on-focus on top would double up.
      refetchOnWindowFocus: false,
      // A background tab shouldn't refetch - matches the pollWhileVisible policy.
      refetchIntervalInBackground: false,
    },
  },
});

// ── Central query-key registry ───────────────────────────────────────────────
// One place that names every cached read, so invalidation is never a guessed
// string. Parameterized reads take an argument (e.g. person(q)).
export const qk = {
  peopleDirectory: ['people-directory'],
  rolesDirectory:  ['roles-directory'],
  itemTypes:       ['item-types'],
  itemApprovers:   ['item-approvers'],
  itemAllocators:  ['item-allocators'],
  groups:          ['groups'],
  entities:        ['hr-entities'],
  workSites:       ['hr-work-sites'],
  branding:        ['branding'],
  myRole:          ['my-role'],
};

// After any write, drop the reference caches the same way the old _getCache
// clear did - broad but correct. As screens migrate, tighten to the specific
// keys a given mutation touches (invalidateQueries({ queryKey: qk.itemTypes })).
export function invalidateAll() {
  queryClient.invalidateQueries();
}

// Identity switch (Act As) - every cached read belongs to the previous identity
// and must be dropped, not just invalidated, so nothing stale is ever shown.
export function clearOnIdentitySwitch() {
  queryClient.clear();
}
