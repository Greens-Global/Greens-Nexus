// One shared read of /timeclock/status.
//
// The floating timer, the Workday screen, the dashboard's time tiles and the
// Home greeting each fetched it on their own timers - several calls a minute
// on one screen for the same answer. They now watch ONE TanStack query: one
// request per poll, however many of them are on screen, and every one of them
// repaints from the same answer at the same moment.
//
//   const { status, reload } = useTimeStatus({ pollMs: 25000 });
//
// status   the last answer, or null until the first one lands (a failed
//          refresh keeps the last good answer on screen).
// loaded   the server has answered at least once.
// failed   it has never answered and the last try failed.
// error / errorAt   the last failure and when - errorAt moves on every failed
//          try, so a screen that tells the person can key an effect on it.
// reload   ask again now. Joins a request already on its way out.
//
// Freshness after a punch: api.js invalidates every query after any successful
// write (and supersedes a read that was already in flight), and the
// `nexus:timeclock-changed` event asks again here, so the people who dispatch
// that event do not also have to call reload.
//
// Polling: each caller names the pace it needs; one visibility-aware timer
// (lib/pollWhileVisible) runs at the fastest pace asked for by whatever is
// mounted. TanStack's own refetchInterval is deliberately not used - it runs
// one timer PER observer, so two screens would again be two requests.
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { queryClient } from './queryClient';
import { pollWhileVisible } from './pollWhileVisible';

export const TIME_STATUS_KEY = ['time-status'];

// cancelRefetch: false = join the request already in flight instead of
// starting a second one (three listeners to one event used to be three calls).
export function reloadTimeStatus() {
  return queryClient.invalidateQueries({ queryKey: TIME_STATUS_KEY }, { cancelRefetch: false });
}

// Optimistic touch-up of the shared answer (the next read replaces it).
export function patchTimeStatus(updater) {
  queryClient.setQueryData(TIME_STATUS_KEY, updater);
}

// What the clock accepts after each punch - the server's state machine.
const NEXT_ALLOWED = { in: ['out', 'break_start'], break_start: ['break_end', 'out'], break_end: ['out', 'break_start'], out: ['in'] };

/** The answer with a punch the server just accepted folded in: the last
 *  punch, the next allowed ones, and the punch on its day so the live hours
 *  derive from it. A chip flips the moment the punch lands instead of after
 *  the re-read that follows (Neil, Oct 14 2026: the lag after Play / Pause). */
export function withPunch(status, punch) {
  if (!status || !punch?.kind || !punch.at) return status;
  const key = punch.localDate || '';
  const day = status.days?.[key] || { workedMin: 0, flags: [], punches: [] };
  const days = key ? { ...(status.days || {}), [key]: { ...day, punches: [...(day.punches || []), punch] } } : status.days;
  return {
    ...status, lastPunch: punch, allowed: NEXT_ALLOWED[punch.kind] || status.allowed, staleOpenShift: false, days,
    bodRequired: punch.kind === 'in' ? false : status.bodRequired,
  };
}
export function applyPunch(punch) { patchTimeStatus((s) => withPunch(s, punch)); }

if (typeof window !== 'undefined') {
  window.addEventListener('nexus:timeclock-changed', reloadTimeStatus);
}

// ── The one poll ─────────────────────────────────────────────────────────────
const _paces = new Set();   // one { ms } per mounted caller that asked to poll
let _stopPoll = null;
let _pollMs = 0;
function _syncPoll() {
  let fastest = 0;
  for (const p of _paces) if (!fastest || p.ms < fastest) fastest = p.ms;
  if (fastest === _pollMs) return;
  _stopPoll?.();
  _stopPoll = null;
  _pollMs = fastest;
  if (fastest) _stopPoll = pollWhileVisible(reloadTimeStatus, fastest);
}

export function useTimeStatus({ pollMs = 0 } = {}) {
  // The client is passed explicitly (it is the same one main.jsx provides) so
  // a component using this renders in a test without a QueryClientProvider.
  const q = useQuery({
    queryKey: TIME_STATUS_KEY,
    queryFn: () => api.timeStatus().then(s => s ?? null),
    // Every screen that mounts asks for a fresh answer, as each did before;
    // screens mounting together share the one request.
    staleTime: 0,
    // api.js owns failure handling (retry, the reconnecting banner). Paused
    // "offline" queries would leave these screens waiting with no error.
    networkMode: 'always',
  }, queryClient);

  useEffect(() => {
    if (!pollMs) return undefined;
    const pace = { ms: pollMs };
    _paces.add(pace);
    _syncPoll();
    return () => { _paces.delete(pace); _syncPoll(); };
  }, [pollMs]);

  return {
    status: q.data ?? null,
    loaded: q.data !== undefined,
    // errorUpdateCount survives the retry that follows a failure, so `failed`
    // holds until an answer actually lands (no flicker back to "loading").
    failed: q.data === undefined && q.errorUpdateCount > 0,
    error: q.error,
    errorAt: q.errorUpdatedAt,
    reload: reloadTimeStatus,
  };
}
