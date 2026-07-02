import { useState, useEffect, useRef } from 'react';
import { idbGet, idbSet } from './idb.js';
import { STORAGE_KEY, serverGet, serverPut, pickBest, markHydrated, isHydrated, setLastKnown, queueWrite, wireBackgroundSync } from './sync.js';
import { VNORM } from './dataNormalization.js';

/** Empty store shape. The original app booted from a large hardcoded seed array of starter
 *  assets; this reconstruction skips that (it has no value once real data exists — see
 *  nexus-data.json) and instead boots empty, relying on the same local/IndexedDB/server
 *  reconcile-on-load this hook implements below to pull in whatever data is actually there. */
const EMPTY_STORE = {
  properties: [], warranties: [], inspections: [], documents: [], ahj: [], utilities: [],
  vendors: [], logs: [], vservice: [], odometer: [], vdocs: [], maintenance: [],
};

/**
 * Owns the Nexus store's entire lifecycle: local-first boot, three-way reconcile against
 * IndexedDB + the server on mount, debounced push-on-change, and background pull/flush via
 * sync.js's wireBackgroundSync. Mirrors the original app's three root-level useEffects
 * (see main.js's Pt()) but delegates the actual HTTP/queue/backoff mechanics to sync.js.
 *
 * Returns [store, setStore] — setStore accepts either a value or an updater function, same as
 * useState, and every other component in the app should treat this exactly like useState.
 */
export function useNexusStore() {
  const [store, setStore] = useState(EMPTY_STORE);
  const storeRef = useRef(store);
  storeRef.current = store;

  // 1. On mount: reconcile localStorage + IndexedDB + server, apply whichever wins, and push
  //    the winner back to the server if the server wasn't already it.
  useEffect(() => {
    let alive = true;
    Promise.all([idbGet(STORAGE_KEY), serverGet()])
      .then(([idbJson, serverState]) => {
        if (!alive) return;
        let local = null;
        try { local = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) {}
        let idb = null;
        try { idb = idbJson ? JSON.parse(idbJson) : null; } catch (e) {}

        const best = VNORM(pickBest([local, idb, serverState]));
        if (best) {
          setLastKnown(best._ts || 0, (best.logs && best.logs.length) || 0);
          if (best !== local) setStore(best);
          if (best !== serverState && Array.isArray(best.properties)) serverPut(JSON.stringify(best));
        }
      })
      .catch(() => {})
      .finally(() => { markHydrated(); });
    return () => { alive = false; };
  }, []);

  // 2. On every store change, once hydrated: mirror to localStorage + IndexedDB, and queue a
  //    debounced push to the server.
  useEffect(() => {
    if (!isHydrated()) return;
    const ts = Date.now();
    let json;
    try { json = JSON.stringify({ ...store, _ts: ts }); } catch (e) { return; }
    try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
    idbSet(STORAGE_KEY, json);
    queueWrite(store);
  }, [store]);

  // 3. Once on mount: wire the background poll/flush/visibility/focus/pagehide/online lifecycle.
  //    A newer server copy is normalized and applied directly (bypassing the setState-updater
  //    form since it doesn't depend on prior state).
  useEffect(() => wireBackgroundSync((serverState) => setStore(VNORM(serverState))), []);

  return [store, setStore];
}
