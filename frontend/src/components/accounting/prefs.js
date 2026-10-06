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
  loading = api.getAccountingPrefs()
    .then((d) => {
      const server = d?.prefs && typeof d.prefs === 'object' ? d.prefs : {};
      // The server wins where it has something; a layout made before this
      // existed (local only) is kept and goes up on the next change.
      if (Object.keys(server).length) { current = { ...current, ...server }; write(current); emit(); }
    })
    .catch(() => { /* the local copy stands */ })
    .finally(() => { loaded = true; loading = null; });
}

function setPrefs(patch) {
  current = { ...(current || read()), ...patch };
  write(current);
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { api.saveAccountingPrefs(current).catch(() => { /* kept locally; retried on the next change */ }); }, 800);
}

/** [prefs, setPrefs(patch)] - patch is merged at the top level. */
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
}
