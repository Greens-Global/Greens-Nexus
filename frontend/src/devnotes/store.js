// Build Mode's one store (Oct 24 2026): a tiny external store read through
// useSyncExternalStore. It is imported by the header (menu row + chip) and
// by the shell, so it must stay small and import nothing heavy - the real
// module (BuildModeApp.jsx) is lazy and arrives only when the mode is on.
//
// Mode state lives in sessionStorage (`nexus:build-mode`) so a reload keeps
// it; drafts live in localStorage (`nexus:build-mode:drafts`) until saved.
import { useSyncExternalStore } from 'react';
import { api } from '../api';

export const MODE_KEY = 'nexus:build-mode';
export const DRAFTS_KEY = 'nexus:build-mode:drafts';
export const PENDING_PIN_KEY = 'nexus:build-mode:open-pin';

export const DEFAULT_SETTINGS = { sendInstantly: false, dispatchTarget: 'local', pinsOnLoad: true, teamsChatId: '', teamsChatName: '' };

const read = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
const write = (storage, key, value) => {
  try { if (value == null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* storage blocked */ }
};

// /dev-notes?pin=<id> is read when this module LOADS, not when anything
// mounts: the app's boot rewrites the address bar (parsePath sends
// /dev-notes to the dashboard) before any effect runs, and the query would
// go with it. Kept in sessionStorage so a reload mid-way still opens it.
function pendingPinFromUrl() {
  if (typeof window === 'undefined') return '';
  try {
    if (window.location.pathname.replace(/\/+$/, '') !== '/dev-notes') return '';
    const id = new URLSearchParams(window.location.search).get('pin') || '';
    if (id) write(sessionStorage, PENDING_PIN_KEY, id);
    return id;
  } catch { return ''; }
}

let state = {
  enabled: null,                 // null = not asked yet; the server decides
  settings: DEFAULT_SETTINGS,
  on: typeof window !== 'undefined' && read(sessionStorage, MODE_KEY) === '1',
  pendingPin: pendingPinFromUrl() || (typeof window !== 'undefined' ? (read(sessionStorage, PENDING_PIN_KEY) || '') : ''),
  blockedRoutes: [],             // views where nothing is captured (the server names them: pfs, credvault)
  tool: 'pin',
  color: '#ef4444',
  pick: null,                    // { target, rect, mode } - the composer's anchor
  editPick: null,                // Edit In Place target { el, target, rect }
  markup: [],                    // items drawn for the next pin
  pins: [],                      // /pins for the current route
  extraPin: null,                // a deep-linked pin that /pins does not list (done / dismissed)
  openPinId: '',
  panelOpen: false,
  panelTab: 'queue',
  showPins: true,
  capture: 'idle',               // idle | live | off | unsupported - the tab-capture stream
  recording: null,               // { startedAt, transcript } while a recording runs
  toast: null,                   // { text, at }
  version: 0,                    // bump = refetch pins and the queue
};

const listeners = new Set();
export const store = {
  get: () => state,
  set: (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next) return;
    state = { ...state, ...next };
    listeners.forEach((l) => { try { l(); } catch { /* a listener must not break the store */ } });
  },
  subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
};

// Selectors must return something stable (a primitive or a stored object),
// never a fresh object - useSyncExternalStore would loop on it.
export function useBuildStore(selector = (s) => s) {
  return useSyncExternalStore(store.subscribe, () => selector(state), () => selector(state));
}

// ── Mode ──────────────────────────────────────────────────────────────────
export function turnOn() {
  if (!state.enabled) return;
  write(sessionStorage, MODE_KEY, '1');
  store.set({ on: true });
}
export function turnOff() {
  write(sessionStorage, MODE_KEY, '0');
  store.set({ on: false, pick: null, editPick: null, openPinId: '', panelOpen: false, recording: null });
}
export function toggleMode() { if (state.on) turnOff(); else turnOn(); }

// ── Access (asked once per page load; the server is the source of truth) ──
let enabledPromise = null;
export function ensureEnabled() {
  if (enabledPromise) return enabledPromise;
  enabledPromise = api.devNotesEnabled()
    .then((r) => {
      const enabled = !!r?.enabled;
      store.set({ enabled, settings: { ...DEFAULT_SETTINGS, ...(r?.settings || {}) }, blockedRoutes: Array.isArray(r?.blockedRoutes) ? r.blockedRoutes : [] });
      // Someone whose grant went away while the mode was on: off, quietly.
      if (!enabled && state.on) turnOff();
      return enabled;
    })
    .catch(() => { store.set({ enabled: false }); return false; });
  return enabledPromise;
}

export async function saveSettings(patch) {
  const next = await api.devNotesSaveSettings(patch);
  store.set({ settings: { ...DEFAULT_SETTINGS, ...(next || {}), ...patch } });
  return state.settings;
}

// ── Deep link: a pin to open once the module is up ────────────────────────
export function requestOpenPin(id) {
  if (!id) return;
  write(sessionStorage, PENDING_PIN_KEY, id);
  store.set({ pendingPin: id });
  if (state.enabled) turnOn();
}
export function takePendingPin() {
  const id = state.pendingPin;
  if (!id) return '';
  write(sessionStorage, PENDING_PIN_KEY, null);
  store.set({ pendingPin: '' });
  return id;
}

// A Build Mode bell carries action { view: 'dev-notes', sub: 'pin:<id>' } -
// the bell's generic branch dispatches it as a navigate event. App.jsx
// ignores the view; this opens the pin. Registered once, at module load.
if (typeof window !== 'undefined') {
  window.addEventListener('nexus:navigate', (e) => {
    const d = e?.detail || {};
    if (d.view !== 'dev-notes') return;
    const sub = String(d.sub || '');
    const pin = sub.match(/^pin:(.+)$/);
    const session = sub.match(/^session:(.+)$/);
    if (pin) { requestOpenPin(pin[1]); return; }
    if (session || sub === 'sessions') {
      // A "PR #n Open For Build Session" bell: the Panel's Sessions tab.
      store.set({ panelOpen: true, panelTab: 'sessions' });
      if (state.enabled) turnOn();
      return;
    }
    const id = d.pin || d.pinId || '';
    if (id) requestOpenPin(id);
  });
}

// ── Toasts (one line, bottom center, three seconds) ───────────────────────
let toastTimer = null;
export function toast(text, ms = 3200) {
  store.set({ toast: text ? { text, at: Date.now() } : null });
  clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => store.set({ toast: null }), ms);
}

// ── Drafts (localStorage until the pin is saved) ──────────────────────────
export function loadDrafts() {
  try {
    const raw = read(localStorage, DRAFTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export function saveDraft(draft) {
  if (!draft?.id) return;
  const rest = loadDrafts().filter((d) => d.id !== draft.id);
  // Blobs never go to storage; URLs, text and the target do.
  const { blobs: _blobs, ...plain } = draft;
  write(localStorage, DRAFTS_KEY, JSON.stringify([{ ...plain, savedAt: new Date().toISOString() }, ...rest].slice(0, 20)));
}
export function removeDraft(id) {
  const rest = loadDrafts().filter((d) => d.id !== id);
  write(localStorage, DRAFTS_KEY, rest.length ? JSON.stringify(rest) : null);
}

export const newId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }));
