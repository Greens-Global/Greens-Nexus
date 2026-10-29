import { useEffect, useState } from 'react';
import { api } from '../../api';

// A person's own layout of the accounting screens (Neil, Sep 25: "do you want
// to see doc number? The answer is no. But don't take it out"): which columns
// of the ledger lines show, how wide each is, the row density, the width of
// the Account column on a statement.
//
// The layout belongs to the person, not the browser: it is kept on the server
// (accounting_user_prefs) and mirrored in localStorage so the screen draws
// the right way at once, before the server has answered, and still works if
// saving fails. One copy is shared by every component that uses the hook.

const LS = 'nexus-accounting-prefs';
const read = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { return {}; } };
const write = (v) => { try { localStorage.setItem(LS, JSON.stringify(v)); } catch { /* private mode */ } };
// A change kept here that has not reached the server yet (UI test 10/28: an
// MRE month dragged wider at 1440 went back after a reload - the reload came
// before the delayed save, and the server's older copy then overwrote it).
// Review 10/29: it carries WHEN it was made, the server time this computer
// last knew (`base`) and WHICH keys changed ('density', 'tableViews.<table>'),
// so on the next load only those keys are replayed, and only when no other
// computer saved since - a newer layout or saved view made elsewhere is kept.
const UNSENT = 'nexus-accounting-prefs-unsent';
const SERVER_AT = 'nexus-accounting-prefs-at';   // updatedAt of the server copy this computer last saw
const readUnsent = () => { try { const v = JSON.parse(localStorage.getItem(UNSENT) || 'null'); return v && typeof v === 'object' && Array.isArray(v.keys) ? v : null; } catch { return null; } };
const writeUnsent = (v) => { try { if (v) localStorage.setItem(UNSENT, JSON.stringify(v)); else localStorage.removeItem(UNSENT); } catch { /* private mode */ } };
const knownServerAt = () => { try { return localStorage.getItem(SERVER_AT) || ''; } catch { return ''; } };
const setKnownServerAt = (at) => { try { if (at) localStorage.setItem(SERVER_AT, at); } catch { /* private mode */ } };
function markUnsent(keys) {
  if (!keys.length) return;
  const rec = readUnsent() || { base: knownServerAt(), keys: [] };
  writeUnsent({ ...rec, at: Date.now(), keys: [...new Set([...rec.keys, ...keys])] });
}

// The keys a change touched: top-level keys, and one per table inside the
// saved views (`tableViews` holds every table's views in one key).
function changedKeys(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (before?.[k] === after?.[k]) continue;
    if (k !== 'tableViews') { out.push(k); continue; }
    const a = before?.tableViews || {}, b = after?.tableViews || {};
    for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[t] !== b[t]) out.push(`tableViews.${t}`);
  }
  return out;
}

// `onto` with the given keys taken from `from` (a key `from` lacks is removed).
function replay(onto, from, keys) {
  const out = { ...onto };
  for (const key of keys) {
    if (key.startsWith('tableViews.')) {
      const t = key.slice('tableViews.'.length);
      const views = { ...(out.tableViews || {}) };
      if (from?.tableViews && t in from.tableViews) views[t] = from.tableViews[t]; else delete views[t];
      out.tableViews = views;
    } else if (from && key in from) out[key] = from[key];
    else delete out[key];
  }
  return out;
}

let current = null;          // the shared copy
let loaded = false;          // the server has answered once
let loading = null;
let saveTimer = null;
const listeners = new Set();

const emit = () => listeners.forEach((fn) => fn(current));

function ensureLoaded() {
  if (current === null) current = read();
  if (loaded || loading) return;
  // Through a promise: a read that throws at once (no network layer yet) is
  // a failed read, never a crash of the screen that asked.
  loading = Promise.resolve().then(() => api.getAccountingPrefs())
    .then((d) => {
      const server = d?.prefs && typeof d.prefs === 'object' ? d.prefs : {};
      const serverAt = typeof d?.updatedAt === 'string' ? d.updatedAt : '';
      const rec = readUnsent();
      const merged = { ...current, ...server };   // a layout kept only here (made before this existed) stays
      if (rec) {
        // A change the server never got (a reload inside the save delay, a
        // failed save) goes up only if it is newer than the server's copy:
        // nobody saved since this computer last looked, or it was made later.
        const newer = !serverAt || serverAt === rec.base || rec.at > Date.parse(serverAt);
        if (newer) { current = replay(merged, current, rec.keys); writeUnsent({ ...rec, base: serverAt }); }
        else { current = replay(merged, server, rec.keys); writeUnsent(null); }
        write(current); setKnownServerAt(serverAt); emit();
        if (newer) scheduleSave();
      } else {
        setKnownServerAt(serverAt);
        if (Object.keys(server).length) { current = merged; write(current); emit(); }
      }
    })
    .catch(() => { /* the local copy stands; an unsent change goes with the next save */ })
    .finally(() => { loaded = true; loading = null; });
}

// `patch` may be a function of the current prefs (Oct 24, saved table views:
// several tables update `tableViews` and must not undo each other).
function setPrefs(patch) {
  const base = current || read();
  current = { ...base, ...(typeof patch === 'function' ? patch(base) : patch) };
  if (current.tableViews !== base.tableViews) viewsWaiting = true;
  write(current);
  markUnsent(changedKeys(base, current));
  emit();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  if (leaving) sendNow(); else saveTimer = setTimeout(sendNow, 800);
}

// Browsers send a keepalive request (one that outlives the closing page) only
// up to 64 KB; a bigger layout goes as a normal request, and if the page is
// gone first the unsent change goes up on the next load.
const KEEPALIVE_MAX = 60000;
const bytes = (text) => { try { return new TextEncoder().encode(text).length; } catch { return text.length * 3; } };
// A save the server will never take (refused, too large) is not retried: it
// is dropped from the unsent change so the server's copy is used on the next
// load. A signed-out, timed-out or throttled save (401 / 408 / 429) is retried.
const dropped = (e) => {
  const status = Number(e?.status) || 0;
  return !!e?.tooLarge || (status >= 400 && status < 500 && ![401, 408, 429].includes(status));
};

function sendNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // The first read is still on its way: it decides whether this computer's
  // change is newer, then sends it (never the whole local copy blind).
  if (loading) return;
  const sent = current;
  const views = viewsWaiting;
  let body = '';
  try { body = JSON.stringify(sent) || ''; } catch { /* sent as is */ }
  // Over the server's limit it would only be refused: say so without sending it.
  const tooLarge = body.length > PREFS_MAX;
  const keepalive = leaving && bytes(body) < KEEPALIVE_MAX;
  (tooLarge ? Promise.reject(Object.assign(new Error('too large'), { tooLarge: true }))
    : Promise.resolve().then(() => (keepalive ? api.saveAccountingPrefs(sent, { keepalive: true }) : api.saveAccountingPrefs(sent))))
    .then((d) => {
      const at = typeof d?.updatedAt === 'string' ? d.updatedAt : '';
      setKnownServerAt(at);
      if (current === sent) { viewsWaiting = false; writeUnsent(null); }
      else { const rec = readUnsent(); if (rec && at) writeUnsent({ ...rec, base: at }); }   // changed while saving: still newer than this save
      setSaveFailure(null);
    })
    // Kept locally and retried on the next change; a saved view that did
    // not reach the account says so (round 3: it used to fail silently).
    .catch((e) => {
      if (dropped(e)) { writeUnsent(null); if (!views) console.warn('Accounting layout not saved:', e?.tooLarge ? 'too large' : e?.status); }
      if (views) setSaveFailure(failureOf(e));
    });
}

// Leaving or reloading the page sends a save still waiting on its delay, and
// any change made on the way out (a table's own pending write) goes at once.
let leaving = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { leaving = true; if (saveTimer) sendNow(); });
  window.addEventListener('pageshow', () => { leaving = false; });
}

// ── A saved view that did not reach the person's account (round 3, fix 6) ──
// The server keeps one person's layout up to 120,000 characters of JSON
// (_PREFS_MAX in routers/accounting_saved.py); it refuses anything longer.
export const PREFS_MAX = 120000;
let viewsWaiting = false;    // a change to the saved views is not on the server yet
let saveFailure = null;      // { reason: 'too-large' | 'offline' | 'refused' } | null
const failureListeners = new Set();
function setSaveFailure(f) {
  if (!f && !saveFailure) return;
  saveFailure = f;
  failureListeners.forEach((fn) => fn(saveFailure));
}
function failureOf(e) {
  const status = Number(e?.status) || 0;
  if (e?.tooLarge || status === 413 || (status === 400 && /too large/i.test(String(e?.message || '')))) return { reason: 'too-large' };
  if (!status || status >= 500) return { reason: 'offline' };
  return { reason: 'refused' };
}
const FAILURE_TEXT = {
  'too-large': "Couldn't save your view to your account. It may be lost when you reload the page. Remove some saved views, then try again.",
  offline: "Couldn't save your view to your account - the server could not be reached. It is saved again with your next change.",
  refused: "Couldn't save your view to your account. It may be lost when you reload the page.",
};
export const saveFailureText = (f) => (f ? FAILURE_TEXT[f.reason] || FAILURE_TEXT.refused : '');

/** [failure | null, dismiss()] - the last save of a saved view that failed. */
export function usePrefsSaveFailure() {
  const [f, set] = useState(saveFailure);
  useEffect(() => {
    failureListeners.add(set);
    set(saveFailure);
    return () => { failureListeners.delete(set); };
  }, []);
  return [f, () => setSaveFailure(null)];
}

/** [prefs, setPrefs(patch | (prefs) => patch)] - patch is merged at the top level. */
export function useAccountingPrefs() {
  const [prefs, set] = useState(() => { ensureLoaded(); return current; });
  useEffect(() => {
    listeners.add(set);
    set(current);
    return () => { listeners.delete(set); };
  }, []);
  return [prefs || {}, setPrefs];
}

// Oct 6 (Charmi, 10/04: "add in the feature to customise it to compact,
// condensed and comfortable and make sure it saves to the user profile"):
// how tightly the Dashboard tabs draw - card padding, the gaps between
// widgets and the rows of the widget tables. Kept here with the rest of the
// person's layout (`dashDensity`), so it follows them to any computer; the
// Reports density is the separate `density` key, saved the same way.
export const DASH_DENSITIES = [
  { key: 'compact', label: 'Compact', hint: 'Tighter cards and rows' },
  { key: 'condensed', label: 'Condensed', hint: 'As much on screen as possible' },
  { key: 'comfortable', label: 'Comfortable', hint: 'Roomy cards and rows' },
];
export const dashDensityOf = (prefs) => (DASH_DENSITIES.some((d) => d.key === prefs?.dashDensity) ? prefs.dashDensity : 'comfortable');

// For tests: forget the shared copy.
export function resetAccountingPrefs() {
  current = null;
  loaded = false;
  loading = null;
  clearTimeout(saveTimer);
  saveTimer = null;
  leaving = false;
  viewsWaiting = false;
  saveFailure = null;
  writeUnsent(null);
  try { localStorage.removeItem(SERVER_AT); } catch { /* private mode */ }
}
