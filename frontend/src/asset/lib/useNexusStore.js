import { useState, useEffect, useRef } from 'react';
import { idbGet, idbSet } from './idb.js';
import { storageKey, serverGet, pickBest, markHydrated, isHydrated, setLastKnown, queueOps, wireBackgroundSync, setRevHandler, hasPending, pullWhenIdle } from './sync.js';
import { diffStore, ROW_COLLECTIONS } from './diff.js';
import { VNORM } from './dataNormalization.js';

/** Empty store shape. The original app booted from a large hardcoded seed array of starter
 *  assets; this reconstruction skips that (it has no value once real data exists - see
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
 * Returns [store, setStore] - setStore accepts either a value or an updater function, same as
 * useState, and every other component in the app should treat this exactly like useState.
 */
export function useNexusStore() {
  const [store, setStore] = useState(EMPTY_STORE);
  // `loading` is true until the first mount reconcile finishes, so the UI can show a spinner
  // instead of the "no properties yet" empty state during the initial async hydration.
  const [loading, setLoading] = useState(true);
  // `serverOk` is false until a SERVER copy has been applied (hydrate or background pull).
  // While false, an empty store means "couldn't load", NOT "portfolio is empty" - the UI must
  // show a reconnecting state instead of the add-your-first-asset empty state.
  const [serverOk, setServerOk] = useState(false);
  // Set right before applying a SERVER copy to state, so the push-on-change effect can tell
  // "the server told us this" apart from "the user edited this" - server-sourced changes are
  // mirrored locally but never queued back to the server (that echo used to re-PUT the whole
  // blob on every load/pull, and on a stale client it CLOBBERED newer server data).
  const serverEcho = useRef(false);
  // The store as last seen (server copy or after the last queued change): the next change is diffed against it.
  const prevStore = useRef(EMPTY_STORE);

  // 1. On mount: hydrate. The server is the source of truth - the workspace lives in a shared
  //    DB that other people edit, so whenever the server answers, its copy wins outright. The
  //    localStorage/IndexedDB copies are only a fallback for an offline/failed load (and even
  //    then they are NOT pushed back to the server - the background pull reconciles once the
  //    server is reachable again). The old behavior ("most logs wins" across local/idb/server,
  //    winner pushed back) meant a stale local copy could both mask newer server data forever
  //    AND overwrite it with a whole-blob PUT on the next visit.
  useEffect(() => {
    let alive = true;
    // Instant first paint (stale-while-revalidate): the server round-trip for the
    // whole workspace blob takes seconds on far-from-region connections, and a
    // spinner for that long reads as "the app is slow". Show the cached local
    // copy IMMEDIATELY as a provisional view - display-only (serverEcho guards
    // the push path, and lastTs/lastLogCount stay at 0 so the server response
    // below, or the first background pull, always replaces it).
    try {
      const cached = VNORM(JSON.parse(localStorage.getItem(storageKey()) || 'null'));
      if (cached && Array.isArray(cached.properties) && cached.properties.length) {
        serverEcho.current = true;
        prevStore.current = cached;
        setStore(cached);
        setLoading(false);
      }
    } catch { /* ignore */ }
    Promise.all([idbGet(storageKey()), serverGet()])
      .then(([idbJson, serverState]) => {
        if (!alive) return;
        if (serverState) {
          setLastKnown(serverState._ts || 0, (serverState.logs && serverState.logs.length) || 0);
          setServerOk(true);
          // An edit made on the cached copy while the server answered is queued
          // already; replacing the store now would show the pre-edit server copy.
          // Keep the local copy and pull once the save has landed.
          if (hasPending()) { pullWhenIdle(); return; }
          serverEcho.current = true;
          const normalized = VNORM(serverState);
          prevStore.current = normalized;
          setStore(normalized);
          return;
        }
        let local = null;
        try { local = JSON.parse(localStorage.getItem(storageKey()) || 'null'); } catch { /* ignore */ }
        let idb = null;
        try { idb = idbJson ? JSON.parse(idbJson) : null; } catch { /* ignore */ }
        const best = VNORM(pickBest([local, idb]));
        if (best) {
          serverEcho.current = true; // display-only fallback - never pushed as a whole
          setLastKnown(0, 0);        // so the first successful pull always wins
          prevStore.current = best;
          setStore(best);
        }
      })
      .catch(() => {})
      .finally(() => { markHydrated(); if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 2. On every store change, once hydrated: mirror to localStorage + IndexedDB, and - for
  //    user-made changes only (not server echoes) - diff against the last snapshot and
  //    queue the rows that changed (lib/diff.js -> sync.js queueOps). The server copy that
  //    arrives through serverEcho becomes the new baseline and queues nothing.
  useEffect(() => {
    if (!isHydrated()) return;
    const prev = prevStore.current;
    prevStore.current = store;
    const ts = Date.now();
    let json;
    try { json = JSON.stringify({ ...store, _ts: ts }); } catch (e) { return; }
    try { localStorage.setItem(storageKey(), json); } catch { /* ignore */ }
    idbSet(storageKey(), json);
    if (serverEcho.current) { serverEcho.current = false; return; }
    const ops = diffStore(prev, store);
    if (ops) queueOps(ops);
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3. Once on mount: wire the background poll/flush/visibility/focus/pagehide/online lifecycle.
  //    A newer server copy is normalized and applied directly (bypassing the setState-updater
  //    form since it doesn't depend on prior state).
  useEffect(() => {
    // A save's response carries each written row's new `_rev`; patch it in
    // without queuing anything (only `_rev` changes, which no diff sends alone).
    setRevHandler((revs) => {
      // A rev-only change is not an edit (lib/diff.js strips _rev), so no echo flag.
      setStore((s) => {
        const next = { ...s };
        for (const coll of ROW_COLLECTIONS) {
          next[coll] = (s[coll] || []).map((r) => (r && revs[r.id] ? { ...r, _rev: revs[r.id] } : r));
        }
        prevStore.current = next;
        return next;
      });
    });
    const stop = wireBackgroundSync((serverState) => {
      serverEcho.current = true;
      const normalized = VNORM(serverState);
      prevStore.current = normalized;
      setStore(normalized);
      setServerOk(true);
    });
    return () => { setRevHandler(null); stop(); };
  }, []);

  return [store, setStore, loading, serverOk];
}
