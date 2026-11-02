// Nexus as an installable app with push (Frontline Reach, Neil 11/02/2026).
//
// Three small pieces, all browser-API thin:
//   registerServiceWorker()  - /sw.js (public/), push only, no caching; called
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
    registering = navigator.serviceWorker.register(SW_URL, { scope: '/' })
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

/** Install Nexus to the home screen. `canInstall` only ever turns on where the
 *  browser offered a prompt (Chrome, Edge, Android); iOS is `isIos` + not
 *  standalone, which the UI turns into the Share > Add to Home Screen hint. */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [standalone, setStandalone] = useState(isStandalone);
  useEffect(() => {
    if (!hasWindow()) return undefined;
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => { setDeferred(null); setStandalone(true); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const install = useCallback(async () => {
    if (!deferred) return 'unavailable';
    try {
      deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice?.outcome === 'accepted') { setDeferred(null); return 'accepted'; }
      return 'dismissed';
    } catch { return 'unavailable'; }
  }, [deferred]);
  return { canInstall: !!deferred && !standalone, install, isStandalone: standalone, isIos: isIos() };
}

/** Push on this device. `enabled` is the server (keys present); `subscribed`
 *  is this browser's own subscription, checked against the registration. */
export function usePushSubscription() {
  const supported = pushSupported();
  const [enabled, setEnabled] = useState(false);
  const [publicKey, setPublicKey] = useState('');
  const [subscribed, setSubscribed] = useState(false);
  const [permission, setPermission] = useState(() => (hasWindow() && 'Notification' in window ? Notification.permission : 'default'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api.pushConfig();
        if (!alive) return;
        setEnabled(!!cfg?.enabled);
        setPublicKey(cfg?.publicKey || '');
      } catch { /* the server did not answer; the row says not set up */ }
      if (supported) {
        try {
          const reg = await readyRegistration();
          const sub = reg ? await reg.pushManager.getSubscription() : null;
          if (alive) setSubscribed(!!sub);
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
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      const json = sub.toJSON();
      await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys, userAgent: navigator.userAgent || '' });
      setSubscribed(true);
      return true;
    } catch (e) {
      setError(e?.message || 'Could not turn push on.');
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
      setError(e?.message || 'Could not turn push off.');
      return false;
    } finally { setBusy(false); }
  }, []);

  return { supported, enabled, subscribed, permission, busy, error, loaded, subscribe, unsubscribe };
}
