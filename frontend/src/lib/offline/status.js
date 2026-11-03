// The small, always-loaded half of field offline (Neil, 11/03/2026; guide
// docs/Offline.md): whether the phone has signal, how many changes wait in
// the outbox, whether the sign-in ran out - and nothing heavy. The app shell
// (App.jsx's offline bar) reads this; the IndexedDB store and the outbox
// load lazily at idle (bootOffline), so first paint does not grow.
const state = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  ready: false,           // the outbox has read what is waiting
  entries: [],
  waiting: 0,
  conflicts: 0,
  failed: 0,
  sending: 0,
  signedOut: false,
  others: [],             // the same email's changes from another session
};
let snap = { ...state };
const listeners = new Set();

function emit() {
  snap = { ...state };
  listeners.forEach((fn) => { try { fn(snap); } catch { /* a listener that unmounted */ } });
}

/** The outbox (or a test) reports its state. */
export function publish(partial) {
  Object.assign(state, partial, { ready: true });
  emit();
}

export const getStatus = () => snap;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

if (typeof window !== 'undefined') {
  const set = () => { const on = navigator.onLine !== false; if (on !== state.online) { state.online = on; emit(); } };
  window.addEventListener('online', set);
  window.addEventListener('offline', set);
}

// ── Lazy boot ────────────────────────────────────────────────────────────────

let booting = null;
const outbox = () => import('./outbox');

/** Start the outbox (read what is waiting, send it, watch the triggers) and
 *  the identity watch. Once per load, at idle so it never competes with the
 *  screen the person opened. Safe to call from anywhere. */
export function bootOffline() {
  if (booting) return booting;
  booting = new Promise((resolve) => {
    const go = () => {
      Promise.all([import('./store'), outbox(), import('./auth'), import('../../msalInstance')])
        .then(async ([store, ob, auth, msal]) => {
          await msal.msalReady.catch(() => {});
          await store.checkIdentity();
          auth.watchAuth();
          resolve(await ob.startOutbox());
        })
        .catch((e) => { console.warn('[offline] not started:', e?.message || e); resolve(null); });
    };
    if (typeof window === 'undefined') { go(); return; }
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(go, { timeout: 3000 });
    else setTimeout(go, 1500);
  });
  return booting;
}

/** Send what is waiting now (the Sync Now button). */
export function syncNow() { return outbox().then((m) => m.flush({ manual: true })).catch(() => null); }

/** Whether the shell's offline bar has anything to say. */
export const barShown = (s = snap) => !s.online || s.signedOut || s.waiting > 0 || s.conflicts > 0 || s.failed > 0 || (s.others?.length || 0) > 0;

/** Test seam. */
export function _resetStatus() {
  Object.assign(state, { online: true, ready: false, entries: [], waiting: 0, conflicts: 0, failed: 0, sending: 0, signedOut: false, others: [] });
  booting = null;
  emit();
}
export function _setOnline(on) { state.online = on; emit(); }
