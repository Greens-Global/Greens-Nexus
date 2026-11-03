// Nexus as an installable app with push (Frontline Reach, Neil 11/02/2026).
//
// Three small pieces, all browser-API thin:
//   registerServiceWorker()  - /sw.js (public/): push, and the offline app
//                              shell (Neil 11/03/2026, docs/Offline.md); called
//                              once the person is signed in (main.jsx). Skipped
//                              on a localhost dev server unless VITE_PWA_DEV=1,
//                              so `npm run dev` never gets a worker stuck on it.
//   useInstallPrompt()       - Chrome / Edge / Android hand us a deferred
//                              install prompt; iOS never does, so the hook also
//                              says "this is iOS and not installed yet" for the
//                              Share > Add to Home Screen hint.
//   usePushSubscription()    - is push supported here, set up on the server
//                              (GET /push/config), subscribed on THIS device,
//                              and the permission state; subscribe() asks the
//                              browser and tells the server, unsubscribe() the
//                              reverse.
// Push itself is the bell's notices (push.py); nothing here decides what is
// sent. Everything is wrapped so a browser without one of these APIs (an old
// Safari, a desktop without notification support) renders the rows as
// "not available here" instead of throwing.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export const SW_URL = '/sw.js';

const hasWindow = () => typeof window !== 'undefined' && typeof navigator !== 'undefined';

export function isStandalone() {
  if (!hasWindow()) return false;
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches === true
      || window.navigator.standalone === true;    // iOS Safari's own flag
  } catch { return false; }
}

export function isIos() {
  if (!hasWindow()) return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as a Mac; the touch points give it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

export function pushSupported() {
  return hasWindow() && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function devWithoutOptIn() {
  try {
    const host = window.location.hostname;
    const local = host === 'localhost' || host === '127.0.0.1';
    return local && import.meta.env?.VITE_PWA_DEV !== '1';
  } catch { return false; }
}

let registration = null;
let registering = null;

/** Register /sw.js once; resolves to the registration (or null where there is none). */
export function registerServiceWorker() {
  if (!hasWindow() || !('serviceWorker' in navigator)) return Promise.resolve(null);
  if (devWithoutOptIn()) return Promise.resolve(null);
  if (registration) return Promise.resolve(registration);
  if (!registering) {
    // updateViaCache 'none': the browser always asks the server for /sw.js,
    // so a deploy's new offline shell is picked up on the next load.
    registering = navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' })
      .then((reg) => { registration = reg; return reg; })
      .catch((e) => { console.warn('[pwa] service worker not registered:', e?.message || e); registering = null; return null; });
  }
  return registering;
}

/** The registration, waiting for it to be ready where it exists. */
async function readyRegistration() {
  if (!hasWindow() || !('serviceWorker' in navigator)) return null;
  const reg = registration || await registerServiceWorker();
  if (!reg) return null;
  try { return await navigator.serviceWorker.ready; } catch { return reg; }
}

// The browser's base64url key -> the Uint8Array subscribe() wants.
export function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// Chrome / Edge / Android fire `beforeinstallprompt` ONCE, during page load,
// long before My Profile mounts - so the event is caught here, at module load
// (main.jsx imports this file first thing), and the hook reads the kept event.
let deferredPrompt = null;
const promptWatchers = new Set();
function notifyPromptWatchers() { promptWatchers.forEach((fn) => { try { fn(deferredPrompt); } catch { /* a watcher that unmounted mid-call */ } }); }
if (hasWindow()) {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; notifyPromptWatchers(); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; notifyPromptWatchers(); });
}
/** Test seam: forget a kept prompt. */
export function _resetInstallPrompt() { deferredPrompt = null; }

/** Install Nexus to the home screen. `canInstall` only ever turns on where the
 *  browser offered a prompt (Chrome, Edge, Android); iOS is `isIos` + not
 *  standalone, which the UI turns into the Share > Add to Home Screen hint. */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(() => deferredPrompt);
  const [standalone, setStandalone] = useState(isStandalone);
  useEffect(() => {
    if (!hasWindow()) return undefined;
    // A prompt that fired before this render (the usual case), or a re-fire later.
    setDeferred(deferredPrompt);
    const watch = (ev) => setDeferred(ev);
    promptWatchers.add(watch);
    const onInstalled = () => { setDeferred(null); setStandalone(true); };
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      promptWatchers.delete(watch);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const install = useCallback(async () => {
    if (!deferred) return 'unavailable';
    try {
      deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice?.outcome === 'accepted') { deferredPrompt = null; setDeferred(null); return 'accepted'; }
      return 'dismissed';
    } catch { return 'unavailable'; }
  }, [deferred]);
  return { canInstall: !!deferred && !standalone, install, isStandalone: standalone, isIos: isIos() };
}

export const SUBSCRIBE_ERROR = 'Could not turn this on. Try again, or reload Nexus.';

function readPermission() {
  try { return hasWindow() && 'Notification' in window ? Notification.permission : 'default'; } catch { return 'default'; }
}

/** The server's copy of THIS browser's subscription, by endpoint: `none` (the
 *  server never heard of it, or dropped it), `disabled` (it failed too often),
 *  or `ok`. Any other person's rows are not in the list, so a device another
 *  person signed in on reads `none` too and is re-posted under the caller. */
async function serverStateFor(endpoint) {
  const rows = await api.pushSubscriptions();
  const list = Array.isArray(rows) ? rows : (rows?.subscriptions || rows?.items || []);
  const mine = list.find((r) => r && r.endpoint === endpoint);
  if (!mine) return 'none';
  return mine.disabled ? 'disabled' : 'ok';
}

async function postSubscription(sub) {
  const json = sub.toJSON();
  await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent || '' });
}

/** Push on this device. `enabled` is the server (keys present); `subscribed`
 *  is this browser's own subscription AND the server holding it - a browser
 *  subscription the server lacks (dropped after failures, or taken over by
 *  another person who signed in here) is re-posted on load so the switch and
 *  the server agree. */
export function usePushSubscription() {
  const supported = pushSupported();
  const [enabled, setEnabled] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState(readPermission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  // The person allows notifications in the browser's settings and comes back:
  // read the permission again so the Blocked copy does not need a reload.
  useEffect(() => {
    if (!hasWindow()) return undefined;
    const refresh = () => setPermission(readPermission());
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      let on = false;
      try {
        const cfg = await api.pushConfig();
        if (!alive) return;
        on = !!cfg?.enabled;
        setEnabled(on);
        setPublicKey(cfg?.publicKey || '');
      } catch { /* the server did not answer; the row says not set up */ }
      if (supported) {
        try {
          const reg = await readyRegistration();
          const sub = reg ? await reg.pushManager.getSubscription() : null;
          let have = false;
          if (sub) {
            let state = 'none';
            try { state = await serverStateFor(sub.endpoint); } catch { state = 'unknown'; }
            if (state === 'ok') have = true;
            else if (state === 'unknown') have = true;      // the list did not answer; trust the browser
            else if (on) {
              // Self-heal: the browser is subscribed, the server is not (or
              // disabled it) - post it again under this person.
              try { await postSubscription(sub); have = true; } catch (e) { console.warn('[pwa] could not re-register this device:', e?.message || e); }
            }
          }
          if (alive) setSubscribed(have);
        } catch { /* no registration here */ }
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported || !enabled || !publicKey) return false;
    setBusy(true); setError('');
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') { setBusy(false); return false; }
      const reg = await readyRegistration();
      if (!reg) throw new Error('No service worker here.');
      const opts = { userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) };
      let sub;
      try {
        sub = await reg.pushManager.subscribe(opts);
      } catch (e) {
        // An older subscription made with another server key: drop it and try once more.
        if (e?.name !== 'InvalidStateError') throw e;
        const old = await reg.pushManager.getSubscription();
        if (old) { try { await old.unsubscribe(); } catch { /* gone already */ } }
        sub = await reg.pushManager.subscribe(opts);
      }
      await postSubscription(sub);
      setSubscribed(true);
      return true;
    } catch (e) {
      console.warn('[pwa] subscribe failed:', e?.message || e);
      setError(SUBSCRIBE_ERROR);
      return false;
    } finally { setBusy(false); }
  }, [supported, enabled, publicKey]);

  const unsubscribe = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const reg = await readyRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        try { await api.pushUnsubscribe(sub.endpoint); } catch { /* the server copy goes when it next fails anyway */ }
        await sub.unsubscribe();
      }
      setSubscribed(false);
      return true;
    } catch (e) {
      console.warn('[pwa] unsubscribe failed:', e?.message || e);
      setError('Could not turn this off. Try again, or reload Nexus.');
      return false;
    } finally { setBusy(false); }
  }, []);

  return { supported, enabled, subscribed, permission, busy, error, loaded, subscribe, unsubscribe };
}
