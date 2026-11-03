// Nexus service worker: Web Push (Frontline Reach, Neil 11/02/2026) and the
// offline app shell (FULL OFFLINE for field work, Neil 11/03/2026 - this
// replaces the earlier "offline is deferred, no caching" note; guide
// docs/Offline.md).
//
// PUSH (unchanged): a push from the server (push.py) carries the same notice
// the bell shows - title, body, the screen to open - and this shows it as a
// system notification; a tap opens or focuses Nexus on that screen.
//
// OFFLINE APP SHELL. The build writes MANIFEST below (scripts/offline-
// manifest.mjs): the build id, the app shell's hashed JS / CSS (the entry and
// everything it imports statically) plus the field screens' chunks (Fill a
// Form, Workday, My Shifts, the outbox screens - OFFLINE_SCREENS in that
// script), and the few unhashed files the shell needs (guard.js, the
// manifest, the icons). Install saves them in a cache named for the build.
// Routing, and nothing else:
//   * the page itself (a navigation) - NETWORK FIRST. Online it is always
//     the server's copy (index.html is no-cache), never a stale one; the saved
//     copy answers only when the network does not (no signal);
//   * /assets/* (content-hashed, immutable) - CACHE FIRST, and a hashed file
//     fetched while online is saved too, so a screen used online opens offline;
//   * the API - NEVER cached here: it is another origin (the Azure API) or
//     /api/* (the BFF proxy), and both pass straight through. What the field
//     needs offline is kept by the app itself (src/lib/offline/store.js, per
//     person, cleared on sign out), never by this worker;
//   * anything else (another origin, /version.json, the Microsoft sign-in
//     popup page, the Outlook add-in, the PDF engine, Pages Functions) passes
//     straight through.
// Updates: a new deploy is a new sw.js (the manifest changes), installed in the
// background; once its files are saved it takes over (skipWaiting + claim).
// That is safe for an open tab: pages stay network first, and the previous
// build's cache is kept one generation, so a tab still on the old build can
// open its old chunks; older caches are removed. The tab learns of the new
// build from the existing "new version" bar (lib/useBuildVersion.js) and
// reloads when the person chooses - nothing here reloads a page.
//
// Served from /sw.js (frontend/public), scope '/'. Registered by
// src/lib/pwa.js. In `npm run dev` MANIFEST stays null and this worker never
// touches a request (push only).
const MANIFEST = null; // @nx-offline-manifest (replaced by the build)

const PREFIX = 'nexus-shell-';
const SHELL_KEY = '/index.html';
const CURRENT = MANIFEST ? `${PREFIX}${MANIFEST.build}` : '';
const ORDER_KEY = '/__nexus-shell-order';
// Never answered here, whatever they are.
const PASS_PREFIXES = ['/api/', '/auth-popup', '/outlook-addin/', '/pdf-editor-app/', '/careers', '/assets-404'];
const PASS_EXACT = new Set(['/api', '/version.json', '/sw.js']);

function route(request) {
  if (!MANIFEST || request.method !== 'GET') return 'pass';
  let url;
  try { url = new URL(request.url); } catch { return 'pass'; }
  if (url.origin !== self.location.origin) return 'pass';           // the API host, Supabase, fonts, Microsoft
  const p = url.pathname;
  if (PASS_EXACT.has(p) || PASS_PREFIXES.some((x) => p.startsWith(x))) return 'pass';
  if (request.mode === 'navigate') return 'page';
  if (p.startsWith('/assets/')) return 'asset';
  if ((MANIFEST.static || []).includes(p)) return 'static';
  return 'pass';
}
self.__nxRoute = route;   // for the unit test (src/lib/sw.test.js)

async function cacheNames() {
  const all = await caches.keys();
  return all.filter((n) => n.startsWith(PREFIX));
}

// The current build's cache first, then the ones kept from before. Vary is
// ignored: a module script asks with an Origin header the install fetch did
// not send, and a `Vary: Origin` answer would otherwise never match - every
// saved file would miss offline (found on the first offline run, 11/03/2026).
// The files are content-hashed or this build's own, so one copy fits all.
async function matchAny(request, opts = {}) {
  opts = { ignoreVary: true, ...opts };
  const names = await cacheNames();
  names.sort((a, b) => (a === CURRENT ? -1 : b === CURRENT ? 1 : 0));
  for (const n of names) {
    const c = await caches.open(n);
    const hit = await c.match(request, opts);
    if (hit) return hit;
  }
  return null;
}

const isHtml = (res) => (res.headers.get('content-type') || '').includes('text/html');

async function page(request) {
  try {
    const res = await fetch(request);
    // Keep the newest shell for when there is no signal - only the real page
    // (a 200 from this origin, not a redirect, not an error page).
    if (res.ok && res.type === 'basic' && !res.redirected && isHtml(res)) {
      const copy = res.clone();
      caches.open(CURRENT).then((c) => c.put(SHELL_KEY, copy)).catch(() => {});
    }
    return res;
  } catch {
    const hit = await matchAny(SHELL_KEY);
    if (hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Nexus</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;'
      + 'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f7fb;color:#323338">'
      + '<div style="text-align:center;max-width:340px;padding:24px"><h1 style="font-size:18px">You Are Offline</h1>'
      + '<p style="font-size:14px;line-height:1.5;color:#676879">Open this once with signal and it will open offline after that.</p></div>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

async function asset(request) {
  const hit = await matchAny(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Hashed files never change: keep any good one (never an HTML error page
  // served under a chunk's name - functions/assets/[[path]].js makes those 404).
  if (res.ok && res.type === 'basic' && !isHtml(res)) {
    const copy = res.clone();
    caches.open(CURRENT).then((c) => c.put(request, copy)).catch(() => {});
  }
  return res;
}

async function staticFile(request) {
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CURRENT).then((c) => c.put(request, copy)).catch(() => {});
    }
    return res;
  } catch (e) {
    // guard.js is stamped ?v=<build>: any saved build's copy is better than none.
    const hit = await matchAny(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const kind = route(event.request);
  if (kind === 'pass') return;                 // the browser handles it as if there were no worker
  if (kind === 'page') event.respondWith(page(event.request));
  else if (kind === 'asset') event.respondWith(asset(event.request));
  else if (kind === 'static') event.respondWith(staticFile(event.request));
});

async function precache() {
  const cache = await caches.open(CURRENT);
  const urls = [...(MANIFEST.assets || []), ...(MANIFEST.static || []).map((p) => `${p}?v=${MANIFEST.build}`)];
  // One failed file does not stop the rest (a retry happens on the next load).
  await Promise.allSettled(urls.map(async (u) => {
    if (await cache.match(u, { ignoreSearch: !u.startsWith('/assets/'), ignoreVary: true })) return;
    const res = await fetch(u, { cache: u.startsWith('/assets/') ? 'default' : 'reload' });
    if (res.ok && !(u.startsWith('/assets/') && isHtml(res))) await cache.put(u, res);
  }));
  try {
    const shell = await fetch('/', { cache: 'reload' });
    if (shell.ok && !shell.redirected && isHtml(shell)) await cache.put(SHELL_KEY, shell);
  } catch { /* offline install: the first page load saves it */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (MANIFEST) { try { await precache(); } catch { /* best effort - the shell still works online */ } }
    await self.skipWaiting();
  })());
});

// Keep this build's cache and the one before it (an open tab may still be on
// it); remove the rest. The order lives in a tiny entry of the current cache.
async function cleanUp() {
  if (!MANIFEST) return;
  const cache = await caches.open(CURRENT);
  let order = [];
  try {
    const all = await cacheNames();
    for (const n of all) {
      const c = await caches.open(n);
      const r = await c.match(ORDER_KEY);
      if (r) { const list = await r.json(); if (Array.isArray(list) && list.length > order.length) order = list; }
    }
  } catch { order = []; }
  order = [CURRENT, ...order.filter((n) => n !== CURRENT)].slice(0, 2);
  await cache.put(ORDER_KEY, new Response(JSON.stringify(order), { headers: { 'Content-Type': 'application/json' } }));
  for (const n of await cacheNames()) if (!order.includes(n)) await caches.delete(n);
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await cleanUp(); } catch { /* next activate */ }
    await self.clients.claim();
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Nexus', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Nexus';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
    icon: '/icons/nexus-192.png',
    badge: '/icons/nexus-badge-96.png',
    renotify: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  // The payload's url is a Nexus screen, never another site: anything that
  // resolves off this origin (an absolute link, a protocol-relative //host)
  // opens Nexus home instead.
  let target = new URL('/', self.location.origin).href;
  try {
    const parsed = new URL(url, self.location.origin);
    if (parsed.origin === self.location.origin) target = parsed.href;
  } catch { /* an unparsable url: home */ }
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // An open Nexus window takes the tap: focus it and move it to the screen.
    for (const client of all) {
      if (new URL(client.url).origin === self.location.origin) {
        if ('focus' in client) await client.focus();
        if ('navigate' in client && client.url !== target) {
          try { await client.navigate(target); } catch { /* a cross-document client we cannot steer; focused is enough */ }
        }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
