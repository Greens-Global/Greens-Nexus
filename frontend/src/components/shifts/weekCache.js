// Weeks already seen, kept in memory for this page (Neil, 11/04/2026: "make
// updating the shift schedule and the shifts system very snappy and fast").
// The planner shows a cached week AT ONCE on Next / Previous / back to a
// team's week and refreshes it quietly behind; the weeks either side are
// fetched ahead while the person reads the one on screen. Keyed by the
// signed-in person (Act As included), never written to storage, dropped on a
// reload - so a cached copy is only ever shown to the person who read it.
const MAX = 12;
const FRESH_MS = 60_000;   // a prefetch skips a week read this recently
const store = new Map();   // key -> { data, at }
const inFlight = new Map();

export const weekKey = (who, start, end) => `${(who || '').toLowerCase()}|${start}|${end}`;

export function getWeek(key) {
  return store.get(key)?.data || null;
}

export function putWeek(key, data) {
  if (!data) return;
  store.delete(key);
  store.set(key, { data, at: Date.now() });
  while (store.size > MAX) store.delete(store.keys().next().value);
}

// Fetch a week ahead unless it is fresh already or on its way.
export function prefetchWeek(key, fetcher) {
  const hit = store.get(key);
  if ((hit && Date.now() - hit.at < FRESH_MS) || inFlight.has(key)) return;
  const p = Promise.resolve().then(fetcher).then((r) => { if (r && typeof r === 'object') putWeek(key, r); })
    .catch(() => { /* a prefetch that fails is simply not there */ })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
}

export function clearWeeks() { store.clear(); inFlight.clear(); }
