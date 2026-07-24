import { useState, useEffect, useRef } from 'react';
import { idbGet, idbSet } from './idb.js';
import { STORAGE_KEY, serverGet, pickBest, markHydrated, isHydrated, setLastKnown, queueWrite, wireBackgroundSync } from './sync.js';
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
  // `loading` is true until the first mount reconcile finishes, so the UI can show a spinner
  // instead of the "no properties yet" empty state during the initial async hydration.
  const [loading, setLoading] = useState(true);
  // Set right before applying a SERVER copy to state, so the push-on-change effect can tell
  // "the server told us this" apart from "the user edited this" — server-sourced changes are
  // mirrored locally but never queued back to the server (that echo used to re-PUT the whole
  // blob on every load/pull, and on a stale client it CLOBBERED newer server data).
  const serverEcho = useRef(false);

  // 1. On mount: hydrate. The server is the source of truth — the workspace lives in a shared
  //    DB that other people edit, so whenever the server answers, its copy wins outright. The
  //    localStorage/IndexedDB copies are only a fallback for an offline/failed load (and even
  //    then they are NOT pushed back to the server — the background pull reconciles once the
  //    server is reachable again). The old behavior ("most logs wins" across local/idb/server,
  //    winner pushed back) meant a stale local copy could both mask newer server data forever
  //    AND overwrite it with a whole-blob PUT on the next visit.
  useEffect(() => {
    let alive = true;
    Promise.all([idbGet(STORAGE_KEY), serverGet()])
      .then(([idbJson, serverState]) => {
        if (!alive) return;
        if (serverState) {
          serverEcho.current = true;
          setLastKnown(serverState._ts || 0, (serverState.logs && serverState.logs.length) || 0);
          setStore(VNORM(serverState));
          return;
        }
        let local = null;
        try { local = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* ignore */ }
        let idb = null;
        try { idb = idbJson ? JSON.parse(idbJson) : null; } catch { /* ignore */ }
        const best = VNORM(pickBest([local, idb]));
        if (best) {
          serverEcho.current = true; // display-only fallback — don't push it at the server
          setLastKnown(0, 0);        // so the first successful pull always wins
          setStore(best);
        }
      })
      .catch(() => {})
      .finally(() => { markHydrated(); if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // 2. On every store change, once hydrated: mirror to localStorage + IndexedDB, and — for
  //    user-made changes only (not server echoes) — queue a debounced push to the server.
  useEffect(() => {
    if (!isHydrated()) return;
    const ts = Date.now();
    let json;
    try { json = JSON.stringify({ ...store, _ts: ts }); } catch (e) { return; }
    try { localStorage.setItem(STORAGE_KEY, json); } catch { /* ignore */ }
    idbSet(STORAGE_KEY, json);
    if (serverEcho.current) { serverEcho.current = false; return; }
    queueWrite(store);
  }, [store]);

  // 3. Once on mount: wire the background poll/flush/visibility/focus/pagehide/online lifecycle.
  //    A newer server copy is normalized and applied directly (bypassing the setState-updater
  //    form since it doesn't depend on prior state).
  useEffect(() => wireBackgroundSync((serverState) => {
    serverEcho.current = true;
    setStore(VNORM(serverState));
  }), []);

  return [store, setStore, loading];
}
