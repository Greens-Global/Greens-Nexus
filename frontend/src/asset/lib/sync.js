// Cross-device sync for Nexus state, talking to the dev-server-hosted `/api/state` endpoint.
//
// PROTOTYPE-GRADE WARNING: the backend behind `/api/state` (see `nexusSyncPlugin()` in
// vite.config.js) is a single JSON file on the machine running the dev server (nexus-data.json).
// The desktop running that dev server is the master copy; every device (phone, laptop, etc.)
// reads and writes the SAME file through the tunnel. There is no per-field merge, no operational
// transform, no multi-writer CRDT - conflicts are resolved with a blunt rule, applied on both
// the server (vite.config.js) and the client (`pickBest` below):
//
//     more log entries wins; if log counts are tied, the newer `_ts` (write timestamp) wins.
//
// "Logs" here means the app's activity/audit log array (`store.logs`), used as a cheap proxy for
// "how much has happened in this copy of the data" - more logged activity is assumed to mean a
// more historically-complete snapshot, so it's preferred over a same-or-later-but-thinner one.
// This is a genuinely lossy strategy: if two devices edit different, unrelated fields offline at
// the same time, ONE of those edits silently loses. It is good enough for "one small team, rare
// simultaneous edits, desktop is home base" - it is not a real sync protocol. Do not build on
// this assuming stronger guarantees; see README-HANDOFF.md.
//
// This module owns:
//   - serverGet / serverPut: the raw HTTP calls to /api/state.
//   - a pending-write queue with retry/backoff (__nexusFlush), so a failed POST (e.g. tunnel
//     hiccup) doesn't silently drop an edit - it keeps retrying with exponential backoff.
//   - pickBest: the same "most logs, then newest timestamp" rule, applied client-side when
//     reconciling localStorage / IndexedDB / server copies on load.
//   - wiring helpers for the flush-on-hide / pull-on-visible / retry-on-online lifecycle that
//     the app's root component drives from React effects.

// Usage pattern (matches the original app's three root-level React effects - this module is
// deliberately framework-agnostic, so the calling component owns the useEffect wiring):
//
//   1. On mount, hydrate once: read localStorage + idbGet(KEY) + serverGet() in parallel. The
//      SERVER copy wins whenever the GET succeeds (it's the shared multi-user source of truth,
//      stamped server-side with _ts); pickBest([local, idb]) is only the offline fallback, and
//      the fallback is never pushed back to the server. (The old "most logs wins across all
//      three, push the winner back" rule let a stale device both hide and clobber newer server
//      data - see useNexusStore.js.)
//   2. On every state change (debounced), once isHydrated() is true: queueWrite(state) - this
//      also mirrors the write to localStorage/idbSet at the call site (sync.js only owns the
//      SERVER side of persistence; local persistence is idb.js + localStorage directly).
//   3. Once on mount: wireBackgroundSync(onServerNewer) to start the poll/flush/listener
//      lifecycle; call the returned cleanup function on unmount.
//
// See src/main.jsx (or wherever the root data-store component lands) for the concrete wiring.

// NEXUS INTEGRATION: the prototype talked to the vite dev server's /api/state file store.
// Inside the Nexus platform the whole workspace lives in Supabase behind the authenticated
// FastAPI endpoint GET/PUT /property-assets/workspace - same {properties, ...collections, logs}
// shape - so serverGet/serverPut below delegate to Nexus's api.js (which attaches the MSAL
// Bearer token). Everything else in this file (queue/debounce/backoff/background poll) is
// unchanged.
import { api } from '../../api.js';

/** localStorage / IndexedDB key the app's full state blob is stored under (both tiers use the same key). */
export const STORAGE_KEY = 'nexus_asset_neil_v2';

/** GET the server's current state. Resolves to `null` on any failure or empty workspace - never rejects. */
export function serverGet() {
  return api.getPropertyWorkspace()
    .then((ws) => (ws && Array.isArray(ws.properties) ? ws : null))
    .catch(() => null);
}

/**
 * PUT a JSON-stringified state blob to Nexus. Resolves to { status, ts }: status is an HTTP-like
 * code the queue uses to decide retries (200 = accepted, 0 = request failed → transient, retried
 * with backoff), and ts is the SERVER-stamped epoch-ms freshness marker of the accepted write -
 * the flush path records it as lastTs so the pull loop doesn't re-download our own write.
 */
export function serverPut(json) {
  let ws;
  try { ws = JSON.parse(json); } catch { return Promise.resolve({ status: 200, ts: 0 }); }
  return api.savePropertyWorkspace(ws)
    .then((r) => ({ status: 200, ts: (r && r._ts) || 0 }))
    // Preserve the REAL HTTP status so flush() can tell apart:
    //   - 409 'stale' (someone saved since we pulled): recoverable - flush pulls,
    //     merges by id and retries, so neither side's work is dropped.
    //   - 409 other (e.g. the empty-over-populated wipe guard): definitive-benign
    //     - drop the write, the next pull re-syncs.
    //   - other 4xx (403 no write grant, 413 too big, 422 bad shape): PERMANENT -
    //     retrying can never succeed, so drop it and surface a visible error
    //     instead of silently retrying forever (which lost edits with no warning).
    //   - 0 (network) or 5xx: transient - keep retrying with backoff.
    // The old code collapsed every non-409 to 0, so a permanent 4xx looked like a
    // network blip and was retried in silence until the tab closed and the edit
    // vanished. Never regress this to `status: 0`.
    .catch((e) => {
      const status = (e && typeof e.status === 'number') ? e.status : 0;
      return {
        status,
        ts: 0,
        stale: !!(status === 409 && /stale/i.test(String(e && e.message || ''))),
        message: String((e && e.message) || ''),
      };
    });
}

/**
 * Merge a fresher SERVER workspace with this tab's LOCAL one after a stale-write
 * rejection. Union of rows by id per collection: rows only the server has (a
 * colleague's work since we pulled) survive; rows we both have take the LOCAL
 * version (this tab's active edit is the most intentional copy). Known
 * trade-off: a row deleted here while a colleague was editing elsewhere comes
 * back - resurrection is recoverable, silent loss is not.
 */
const WS_KEYS = ['properties', 'warranties', 'inspections', 'documents', 'ahj', 'utilities',
  'vendors', 'vservice', 'odometer', 'vdocs', 'maintenance', 'logs'];
export function mergeWorkspaces(server, local) {
  if (!local) return server;
  const out = {};
  for (const k of WS_KEYS) {
    const s = Array.isArray(server && server[k]) ? server[k] : [];
    const l = Array.isArray(local && local[k]) ? local[k] : [];
    const byId = new Map();
    for (const row of s) if (row && row.id != null) byId.set(row.id, row);
    for (const row of l) if (row && row.id != null) byId.set(row.id, row);
    out[k] = [...byId.values()];
  }
  return out;
}

/**
 * Given several candidate state blobs (e.g. [localStorage copy, IndexedDB copy, server copy]),
 * pick the one that should win, using the "most logs, then newest _ts" rule described above.
 * Skips any candidate that isn't a well-formed state object (must have a `properties` array).
 * Returns `null` if none qualify.
 */
export function pickBest(candidates) {
  let best = null, bestLogs = -1, bestTs = -1;
  for (const candidate of candidates) {
    if (!candidate || !Array.isArray(candidate.properties)) continue;
    const logs = (candidate.logs && candidate.logs.length) || 0;
    const ts = candidate._ts || 0;
    // Strictly more logs wins outright. Equal logs: newer-or-equal timestamp wins (>=, so the
    // LAST candidate in a same-logs/same-ts tie wins - candidates are conventionally passed
    // [local, idb, server], so server wins such ties).
    if (logs > bestLogs || (logs === bestLogs && ts >= bestTs)) {
      bestLogs = logs;
      bestTs = ts;
      best = candidate;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Pending-write queue: module-level (not per-component) state, matching the original - there is
// only ever one Nexus store in the app, so a singleton queue is fine and lets any code path
// (including page-hide/beacon handlers that can't easily reach into React state) flush it.
// ---------------------------------------------------------------------------------------------

/** Has the initial local/IndexedDB/server reconcile-on-load completed? Gates the push effect so we never push a value BEFORE we've merged in server state (which would clobber it). */
export let hydrated = false;
/** JSON string of the most recent write that still needs to reach the server, or null if nothing is pending. */
let pending = null;
/** Timer handle for the debounced/backoff-scheduled flush. */
let pushTimer = null;
/** Consecutive failed-flush count, drives exponential backoff; reset to 0 on a successful (200) or definitively-rejected (409) PUT. */
let retryCount = 0;
/** Whether the soft "not syncing yet" warning has already been surfaced for the current failing streak - so a stuck server warns once, not every 30s retry. Cleared on any successful/definitive PUT. */
let softNotified = false;
/** Bookkeeping mirrors of the last state we know the server has, used by the pull loop to decide whether a server poll found something newer. */
let lastTs = 0;
let lastLogCount = 0;
/** The SERVER _ts this tab's copy derives from - sent with every PUT so the
 * server can reject a stale whole-blob overwrite instead of losing colleagues'
 * work. Advances on hydrate, every adopted pull, and every accepted PUT. */
let baseTs = 0;
/** The apply-server-state callback from wireBackgroundSync, kept module-level so
 * the stale-merge path can hand the merged workspace back to the app. */
let applyServer = null;

export function markHydrated() { hydrated = true; }
export function isHydrated() { return hydrated; }
export function getLastTs() { return lastTs; }
export function getLastLogCount() { return lastLogCount; }
export function setLastKnown(ts, logCount) { lastTs = ts; lastLogCount = logCount; baseTs = ts; }
export function hasPending() { return !!pending; }
export function getRetryCount() { return retryCount; }

/**
 * Queue `stateObj` (already stamped with `_ts`) to be written to the server, debounced by
 * `debounceMs` (the original app uses 1200ms so rapid successive edits coalesce into one PUT).
 * Also updates the lastTs/lastLogCount bookkeeping immediately (optimistic - we know what WE
 * just wrote, independent of whether the network call has completed yet).
 */
export function queueWrite(stateObj, debounceMs = 1200) {
  const ts = Date.now();
  let json;
  try {
    json = JSON.stringify({ ...stateObj, _ts: ts, baseTs });
  } catch (e) {
    return; // circular/unserializable state - nothing we can do, drop silently like the original
  }
  lastTs = ts;
  lastLogCount = (stateObj.logs && stateObj.logs.length) || 0;
  pending = json;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flush, debounceMs);
}

/**
 * Surface a save failure to the app and, through it, the user. sync.js is
 * framework-agnostic (no React), so it fires a window event the asset UI listens
 * for to show a banner/toast, and mirrors it to the console. `soft` = the write
 * is still being retried (transient/5xx); a hard failure (4xx) means the write
 * was dropped and will NOT be retried, so the user must redo it.
 */
function notifySaveFailed(status, message, soft) {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('nexus:asset-save-failed', {
        detail: { status, message: message || '', soft: !!soft, at: Date.now() },
      }));
    }
  } catch { /* event dispatch is best-effort */ }
  try { console.error('[asset-sync] save failed', { status, message, soft }); } catch { /* noop */ }
}

/**
 * Attempt to send the pending write now (bypassing the debounce timer). Safe to call
 * unconditionally (e.g. from an interval or an online/visibility handler) - it's a no-op if
 * nothing is pending.
 *
 * Retry/backoff behavior:
 *   - 200 (accepted) or 409 (server has a copy that wins by the pickBest rule - our write is
 *     moot, not an error worth retrying): clear the pending write, reset retry count to 0.
 *   - anything else (network failure -> 0, or a 5xx): treat as transient. Bump retryCount (capped
 *     at 6) and reschedule via exponential backoff: 1.5s, 3s, 6s, 12s, 24s, capped at 30s.
 *
 * Note the "is this write still current" guard: if `pending` has been replaced by a newer write
 * while this PUT was in flight, we don't clear it out from under the newer one.
 */
export function flush() {
  if (!pending) return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  const inFlight = pending;
  serverPut(inFlight).then(({ status, ts, stale, message }) => {
    if (status === 200) {
      if (pending === inFlight) pending = null;
      retryCount = 0;
      softNotified = false;
      // Adopt the server's stamp for the write we just landed (even if it's
      // "behind" our client clock - server time is the only one pulls compare).
      if (ts) { lastTs = ts; baseTs = ts; }
    } else if (status === 409 && stale) {
      // Someone else saved since this tab last pulled. Pull their copy, merge
      // it with ours (union by id, this tab wins rows it touched) and retry -
      // the old behavior silently replaced their work with our stale blob.
      serverGet().then((server) => {
        if (!server) {
          retryCount = Math.min((retryCount || 0) + 1, 6);
          pushTimer = setTimeout(flush, Math.min(1500 * Math.pow(2, retryCount - 1), 30000));
          return;
        }
        let local = null;
        try { local = JSON.parse(inFlight); } catch { /* keep null */ }
        const merged = mergeWorkspaces(server, local);
        baseTs = server._ts || 0;
        lastLogCount = (merged.logs && merged.logs.length) || 0;
        const ts2 = Date.now();
        lastTs = ts2;
        const json = JSON.stringify({ ...merged, _ts: ts2, baseTs });
        // Don't clobber a NEWER local write queued while our PUT was in flight -
        // it will hit the same stale gate and merge on its own turn.
        if (pending === inFlight) pending = json;
        // Hand the merged truth back to the app so colleagues' rows appear
        // in this tab too, not only on the server.
        if (applyServer) { try { applyServer({ ...merged, _ts: server._ts || 0 }); } catch { /* view update is best-effort */ } }
        retryCount = 0;
        pushTimer = setTimeout(flush, 400);
      });
    } else if (status === 409) {
      // Definitive-benign rejection (e.g. the empty-over-populated wipe guard):
      // drop the write; the next pull re-syncs this tab.
      if (pending === inFlight) pending = null;
      retryCount = 0;
    } else if (status >= 400 && status < 500) {
      // Permanent client error (403 no write grant, 413 too big, 422 bad shape):
      // retrying can never succeed. Drop the write so it can't loop forever, and
      // surface it so the edit doesn't vanish silently - this is the exact class
      // of failure the old code swallowed as a fake "network blip".
      if (pending === inFlight) pending = null;
      retryCount = 0;
      softNotified = false;
      notifySaveFailed(status, message, false);
    } else {
      // Transient (network -> 0, or 5xx server hiccup): keep retrying with
      // exponential backoff. Once we've backed off to the cap and still can't
      // land the write, surface a soft "not syncing yet" warning so a persistently
      // failing server is never fully silent - but keep retrying so it recovers
      // on its own when the server comes back.
      retryCount = Math.min((retryCount || 0) + 1, 6);
      if (retryCount >= 6 && !softNotified) { softNotified = true; notifySaveFailed(status, message, true); }
      pushTimer = setTimeout(flush, Math.min(1500 * Math.pow(2, retryCount - 1), 30000));
    }
  });
}

/**
 * Best-effort synchronous-ish flush for page unload: `fetch` can be cancelled mid-flight when a
 * tab closes, so use `navigator.sendBeacon` instead, which the browser guarantees to complete.
 * Does not update pending/retry state - the beacon fire-and-forgets, we just want the bytes to
 * arrive; a subsequent page load will reconcile via the normal hydrate path regardless.
 */
export function flushBeacon() {
  if (!pending) return;
  // The original beaconed the raw JSON to the vite dev server's /api/state. Nexus's workspace
  // endpoint is MSAL-authenticated, and navigator.sendBeacon can't attach the Bearer token, so
  // fall back to the normal authenticated flush() - best-effort on pagehide (the periodic poll +
  // visibilitychange flush cover the common cases; a subsequent load reconciles regardless).
  flush();
}

/**
 * Wire up the background sync lifecycle. Call once (e.g. from a root-level `useEffect` with an
 * empty dependency array) and call the returned cleanup function on unmount.
 *
 * Behavior:
 *   - every `pollMs` (7000 in the original): if a write is pending, try to flush it; otherwise,
 *     if the tab is visible, poll the server for something newer (`onServerNewer` callback fires
 *     with the parsed server state when it has more logs, or equal logs with a newer timestamp,
 *     than what we last knew about).
 *   - tab hidden -> flush immediately (don't wait for the poll interval). Tab visible again ->
 *     poll immediately.
 *   - window regains focus -> poll immediately.
 *   - page is being unloaded/backgrounded (`pagehide`) -> beacon-flush any pending write.
 *   - browser comes back online -> flush immediately (in case writes queued up while offline).
 *
 * `onServerNewer(serverState)` should apply the server's state as the new source of truth
 * (typically after running it through VNORM - see dataNormalization.js) and update the
 * lastTs/lastLogCount bookkeeping via setLastKnown().
 */
export function wireBackgroundSync(onServerNewer, pollMs = 7000) {
  let stopped = false;
  applyServer = onServerNewer;

  const pull = () => {
    if (pushTimer || pending) return; // a write is queued/going out; don't race it with an incoming pull
    serverGet().then((serverState) => {
      if (stopped || !serverState || !Array.isArray(serverState.properties)) return;
      const logs = (serverState.logs && serverState.logs.length) || 0;
      const ts = serverState._ts || 0;
      // The server stamps _ts on every accepted write, so ts alone detects ANY
      // newer copy - including value-only edits that don't change the log count,
      // and recovery states where the log count went DOWN. The log-count check
      // stays as a fallback for a server that predates _ts (deploy skew).
      if (ts > lastTs || logs > lastLogCount) {
        lastLogCount = logs;
        lastTs = Math.max(ts, lastTs);
        baseTs = Math.max(ts, baseTs);   // our copy now derives from this server state
        onServerNewer(serverState);
      }
    });
  };

  const intervalId = setInterval(() => {
    if (pending) flush();
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') pull();
  }, pollMs);

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
    else pull();
  };
  const onFocus = () => pull();
  const onPageHide = () => flushBeacon();
  const onOnline = () => flush();

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
  }

  return () => {
    stopped = true;
    applyServer = null;
    clearInterval(intervalId);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('online', onOnline);
    }
  };
}
