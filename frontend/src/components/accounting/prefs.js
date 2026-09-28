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

// For tests: forget the shared copy.
export function resetAccountingPrefs() {
  current = null;
  loaded = false;
  loading = null;
  clearTimeout(saveTimer);
}
