// Asset Management sync: a queue of ROW saves and a background pull.
//
// Until Oct 2026 every edit re-sent the whole portfolio (PUT /workspace) and a
// stale tab's "merge" overwrote colleagues' rows. Now useNexusStore diffs the
// store before and after each change (lib/diff.js) and queues only the rows
// that changed; flush() POSTs them to /property-assets/changes, where each row
// is written on its own and a row the server changed since this tab read it
// comes back in `conflicts` (the tab re-pulls and says so). An edit that has
// not reached the server yet makes the browser ask before the tab closes.
//
//   - serverGet / serverTs: the pull side (unchanged).
//   - queueOps(ops) / flush(): the save side.
//   - wireBackgroundSync(onServerNewer): poll, flush on hide/online, unload warning.
import { api } from '../../api.js';

/** localStorage / IndexedDB key the app's full state blob is stored under (both tiers use the same key). */
export const STORAGE_KEY = 'nexus_asset_neil_v2';

/** GET the server's current state. Resolves to `null` on any failure or empty workspace - never rejects. */
export function serverGet() {
  return api.getPropertyWorkspace()
    .then((ws) => (ws && Array.isArray(ws.properties) ? ws : null))
    .catch(() => null);
}

/** GET just the server's `_ts` freshness marker (a few bytes, one meta row).
 * Resolves to a number, or `null` on failure / a backend without the endpoint -
 * in which case the caller falls back to a full serverGet (old behavior). */
export function serverTs() {
  return api.getPropertyWorkspaceTs()
    .then((r) => (r && typeof r._ts === 'number' ? r._ts : null))
    .catch(() => null);
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
// Pending-save queue (module-level: one store per app, and the page-hide handler needs it).
// ---------------------------------------------------------------------------------------------
import { mergeOps, opsEmpty, ROW_COLLECTIONS } from './diff.js';

export let hydrated = false;
/** Row ops that still have to reach the server (lib/diff.js shape), or null. */
let pending = null;
let pushTimer = null;
let inFlight = false;
let retryCount = 0;
let softNotified = false;
/** The server _ts this tab last saw / wrote - the pull loop compares against it. */
let lastTs = 0;
let lastLogCount = 0;
let applyServer = null;
/** A full pull wanted as soon as nothing is pending (a hydrate skipped over an in-flight edit). */
let pullAfterFlush = false;
export function pullWhenIdle() { pullAfterFlush = true; }
/** Hands the store the `_rev` every written row now carries (useNexusStore). */
let applyRevs = null;
export function setRevHandler(fn) { applyRevs = fn; }

export function markHydrated() { hydrated = true; }
export function isHydrated() { return hydrated; }
export function getLastTs() { return lastTs; }
export function getLastLogCount() { return lastLogCount; }
export function setLastKnown(ts, logCount) { lastTs = ts; lastLogCount = logCount; }
export function hasPending() { return !opsEmpty(pending) || inFlight; }
export function getRetryCount() { return retryCount; }
/** Test seam. */
export function _resetQueue() { pending = null; inFlight = false; retryCount = 0; softNotified = false; clearTimeout(pushTimer); pushTimer = null; }

/** Queue row ops (lib/diff.js shape); coalesced for `debounceMs` so a burst of edits is one request. */
export function queueOps(ops, debounceMs = 800) {
  if (opsEmpty(ops)) return;
  pending = mergeOps(pending, ops);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(flush, debounceMs);
}

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

function notifyConflicts(ids) {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nexus:asset-save-conflict', { detail: { ids, at: Date.now() } }));
  } catch { /* best-effort */ }
}

/**
 * Send the pending ops now. 200: done (rows the server reports as conflicts are
 * dropped, the workspace re-pulled and the app told). 4xx: the batch can never
 * land - drop it and tell the user. Network / 5xx: keep it, retry with backoff;
 * edits made meanwhile fold into the same batch.
 */
export function flush() {
  if (inFlight || opsEmpty(pending)) return;
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  const batch = pending;
  pending = null;
  inFlight = true;
  api.saveAssetChanges(batch)
    .then((r) => {
      inFlight = false;
      retryCount = 0;
      softNotified = false;
      if (r && r._ts) lastTs = r._ts;
      // Without this the tab's next edit of the same row would carry the rev it
      // was READ with, and the server would call the tab's own row stale.
      if (r && r.revs && Object.keys(r.revs).length) {
        if (applyRevs) { try { applyRevs(r.revs); } catch { /* best-effort */ } }
        // An edit queued while this save was in flight still holds the rev the row
        // was read with; it takes the new one or the server would call it stale.
        if (pending) {
          for (const coll of ROW_COLLECTIONS) {
            if (pending[coll]) pending[coll].upsert = pending[coll].upsert.map((row) => (r.revs[row.id] ? { ...row, _rev: r.revs[row.id] } : row));
          }
        }
      }
      if (r && r.conflicts && r.conflicts.length) {
        notifyConflicts(r.conflicts);
        serverGet().then((server) => {
          if (!server) return;
          lastTs = server._ts || lastTs;
          lastLogCount = (server.logs && server.logs.length) || 0;
          if (applyServer) { try { applyServer(server); } catch { /* best-effort */ } }
        });
      }
      if (!opsEmpty(pending)) pushTimer = setTimeout(flush, 200);
      else if (pullAfterFlush) {
        pullAfterFlush = false;
        serverGet().then((server) => {
          if (!server) return;
          lastTs = Math.max(lastTs, server._ts || 0);
          lastLogCount = (server.logs && server.logs.length) || 0;
          if (applyServer) { try { applyServer(server); } catch { /* best-effort */ } }
        });
      }
    })
    .catch((e) => {
      inFlight = false;
      const status = (e && typeof e.status === 'number') ? e.status : 0;
      const message = String((e && e.message) || '');
      if (status >= 400 && status < 500) {
        // Permanent (403 no write grant / outside access, 400 a file not in storage, 422 shape):
        // retrying can never succeed. Drop the batch and say so - never a silent loss.
        retryCount = 0;
        softNotified = false;
        notifySaveFailed(status, message, false);
        if (!opsEmpty(pending)) pushTimer = setTimeout(flush, 200);
        return;
      }
      // Transient: the batch goes back under whatever was queued meanwhile.
      pending = mergeOps(batch, pending);
      retryCount = Math.min((retryCount || 0) + 1, 6);
      if (retryCount >= 6 && !softNotified) { softNotified = true; notifySaveFailed(status, message, true); }
      pushTimer = setTimeout(flush, Math.min(1500 * Math.pow(2, retryCount - 1), 30000));
    });
}

/** Page-hide: the authenticated flush (a beacon cannot carry the bearer token). */
export function flushBeacon() { flush(); }

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

  const fullPull = () => {
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
        onServerNewer(serverState);
      }
    });
  };

  const pull = () => {
    if (pushTimer || inFlight || !opsEmpty(pending)) return; // a save is queued/going out; don't race it with a pull
    // Cheap freshness check first: the ~few-byte _ts marker tells us whether the
    // heavy full-workspace pull is even worth doing. Re-pulling the whole portfolio
    // blob every 7s just to read _ts was a top pooler-egress driver. If the ts
    // endpoint is unavailable (older backend), fall back to the full pull.
    serverTs().then((ts) => {
      if (stopped) return;
      if (ts === null || ts > lastTs) fullPull();
      // else: server has nothing newer than what we last saw - skip the pull.
    });
  };

  const intervalId = setInterval(() => {
    if (!opsEmpty(pending)) flush();
    if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') pull();
  }, pollMs);

  const onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
    else pull();
  };
  const onFocus = () => pull();
  const onPageHide = () => flushBeacon();
  const onOnline = () => flush();
  // An edit that has not reached the server: the browser asks before the tab goes.
  const onBeforeUnload = (e) => { if (hasPending()) { flush(); e.preventDefault(); e.returnValue = ''; } };

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('beforeunload', onBeforeUnload);
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
      window.removeEventListener('beforeunload', onBeforeUnload);
    }
  };
}
