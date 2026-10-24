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
      // The server wins where it has something; a layout made before this
      // existed (local only) is kept and goes up on the next change.
      if (Object.keys(server).length) { current = { ...current, ...server }; write(current); emit(); }
    })
    .catch(() => { /* the local copy stands */ })
    .finally(() => { loaded = true; loading = null; });
}

// `patch` may be a function of the current prefs (Oct 24, saved table views:
// several tables update `tableViews` and must not undo each other).
function setPrefs(patch) {
  const base = current || read();
  current = { ...base, ...(typeof patch === 'function' ? patch(base) : patch) };
  if (current.tableViews !== base.tableViews) viewsWaiting = true;
  write(current);
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const sent = current;
    const views = viewsWaiting;
    // Over the server's limit it would only be refused: say so without sending it.
    const tooLarge = (() => { try { return JSON.stringify(sent).length > PREFS_MAX; } catch { return false; } })();
    (tooLarge ? Promise.reject(Object.assign(new Error('too large'), { tooLarge: true })) : Promise.resolve().then(() => api.saveAccountingPrefs(sent)))
      .then(() => { if (current === sent) viewsWaiting = false; setSaveFailure(null); })
      // Kept locally and retried on the next change; a saved view that did
      // not reach the account says so (round 3: it used to fail silently).
      .catch((e) => { if (views) setSaveFailure(failureOf(e)); });
  }, 800);
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
  'too-large': "Couldn't save your view to your account. It's kept on this computer only. Try removing some saved views.",
  offline: "Couldn't save your view to your account - the server could not be reached. It's kept on this computer only and is saved again with your next change.",
  refused: "Couldn't save your view to your account. It's kept on this computer only.",
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
  viewsWaiting = false;
  saveFailure = null;
}
