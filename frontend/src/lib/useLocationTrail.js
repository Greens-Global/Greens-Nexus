// Location Trail While Clocked In (Neil's checklist, Oct 20 2026).
//
// While the person is clocked in, and only when their company turned the
// trail on (Global Settings > Shifts > Attendance, `locationTrail` on
// /timeclock/status), the web app sends one location ping about every 5
// minutes to /timeclock/location-trail/ping (backend/routers/location_trail.py,
// which re-checks every rule). It:
//   - pauses on a break and stops at clock-out (the status says which);
//   - sends nothing unless the browser ALREADY allows location - it never
//     asks, so nobody gets a permission prompt from it, let alone repeatedly;
//   - runs from ONE place (the app-wide floating timer, TimeclockWidget), and
//     with several tabs open only one of them pings: the tabs share the last
//     ping time and a short lock in localStorage (all of it in try/catch; with
//     no storage each tab keeps its own clock and the server's 2-minute floor
//     drops the doubles).
// Browsers stop running a page when the phone screen locks or the tab is
// closed, so the trail has gaps then - the Time Clock note says so.
import { useEffect, useRef } from 'react';
import { api } from '../api';
import { getPosition } from './geoPosition';
import { locationPermission } from './punchLocation';

export const PING_EVERY_MS = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;
const LOCK_MS = 60 * 1000;
const FIX_MS = 20 * 1000;       // how long one ping waits on the browser for a fix
const SLACK_MS = 15 * 1000;    // a tick that lands a little early still counts
export const LAST_KEY = 'nexus.locationTrail.lastPing';
export const LOCK_KEY = 'nexus.locationTrail.lock';

/** off | not_clocked_in | on_break | active - from /timeclock/status. */
export function trailState(status) {
  if (!status?.locationTrail || status.timeTrackingExempt) return 'off';
  if (status.staleOpenShift) return 'not_clocked_in';
  const k = status.lastPunch?.kind;
  if (k === 'break_start') return 'on_break';
  if (k === 'in' || k === 'break_end') return 'active';
  return 'not_clocked_in';
}

/** 'granted' | 'denied' | 'prompt' | '' (unknown) - never prompts. */
export const locationPermissionState = () => locationPermission();

function _storage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

let _localLast = 0;   // used only when localStorage is unavailable

/** Is it this tab's turn to ping? Claims a short lock when it is. */
export function claimTurn(now, tabId, storage = _storage()) {
  try {
    if (!storage) throw new Error('no storage');
    const last = Number(storage.getItem(LAST_KEY) || 0);
    if (now - last < PING_EVERY_MS - SLACK_MS) return false;
    const lock = JSON.parse(storage.getItem(LOCK_KEY) || 'null');
    if (lock && lock.id !== tabId && lock.until > now) return false;
    storage.setItem(LOCK_KEY, JSON.stringify({ id: tabId, until: now + LOCK_MS }));
    const mine = JSON.parse(storage.getItem(LOCK_KEY) || 'null');
    return mine?.id === tabId;
  } catch {
    return now - _localLast >= PING_EVERY_MS - SLACK_MS;
  }
}

export function markSent(now, storage = _storage()) {
  _localLast = now;
  try { storage?.setItem(LAST_KEY, String(now)); } catch { /* private window */ }
}

/** One tick: pings when every rule allows it. Returns what it did. */
export async function pingOnce({ status, tabId, now = Date.now(), storage = _storage(),
  send = api.locationTrailPing } = {}) {
  const state = trailState(status);
  if (state !== 'active') return state;
  if (await locationPermission() !== 'granted') return 'no_permission';
  if (!claimTurn(now, tabId, storage)) return 'not_my_turn';
  markSent(now, storage);   // a failed fix or send waits for the next round, never a retry storm
  const pos = await getPosition(FIX_MS);
  if (!pos) return 'no_fix';
  try {
    await send({ ...pos, tz_offset_min: new Date().getTimezoneOffset() });
    return 'sent';
  } catch {
    return 'failed';
  }
}

/** Mount once, app-wide (TimeclockWidget). */
export function useLocationTrail(status) {
  const state = trailState(status);
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => {
    if (state !== 'active') return undefined;
    const tabId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Every tick re-reads the latest status, and any change of state (a break,
    // clock-out, the switch going off) tears this down.
    const tick = () => { pingOnce({ status: statusRef.current, tabId }).catch(() => {}); };
    tick();
    const id = setInterval(tick, TICK_MS);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [state]);
  return state;
}
