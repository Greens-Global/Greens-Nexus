// readThrough for the app shell (field offline, Neil 11/03/2026): the same
// rule as store.readThrough, with the store loaded only when it is needed -
// on a phone with no signal, or after a read that got no answer - so the
// shell's first paint carries none of it. Online, the answer is saved in the
// background for next time.
const store = () => import('./store');

export async function offlineRead(name, fetcher) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    try { const hit = await (await store()).getCached(name); if (hit) return hit.data; } catch { /* nothing kept */ }
  }
  let data;
  try {
    data = await fetcher();
  } catch (e) {
    if (!e?.status) {
      try { const hit = await (await store()).getCached(name); if (hit) return hit.data; } catch { /* nothing kept */ }
    }
    throw e;
  }
  store().then((m) => m.putCached(name, data)).catch(() => {});
  return data;
}
