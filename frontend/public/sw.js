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
// Form on Workday, the outbox screens - OFFLINE_SCREENS in that script), and
// the few unhashed files the shell needs (guard.js, the manifest, the icons).
// Install saves them in a cache named for the build (a hashed file the
// previous build already holds is copied over, not fetched again).
// Routing, and nothing else:
//   * the page itself (a navigation) - NETWORK FIRST. Online it is always
//     the server's copy (index.html is no-cache), never a stale one. The saved
//     copy answers when the network does not (no signal) and, on a signal so
//     weak the page has not come back in NAV_TIMEOUT_MS, the CURRENT build's
//     saved copy answers (never an older build's - its files may be gone);
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
// That is safe for an open tab: pages stay network first, and EXACTLY the
// build before is kept (the order is recorded in META_CACHE, never guessed
// from cache names), so a tab still on it can open its old chunks; every
// other shell cache is removed. The tab learns of the new build from the
// existing "new version" bar (lib/useBuildVersion.js) and reloads when the
// person chooses - nothing here reloads a page.
//
// KILL SWITCH (docs/Offline.md runbook): a build with VITE_OFFLINE_SHELL=off
// writes KILL = true and no MANIFEST. That worker deletes every shell cache
// on activate, answers no request (everything goes to the network as if there
// were no worker) and keeps push. It is never unregistered - that would drop
// every phone's push subscription.
//
// SHARE TO NEXUS (the manifest's share_target; app side src/lib/shareTarget.js).
// An installed Nexus is in the phone's share sheet (Chrome / Edge only - iOS
// has no Web Share Target). The share arrives as ONE request, a multipart
// POST to /share-target, and that is the only write this worker ever answers:
// the words and files are kept in their own cache (SHARE_CACHE - synthetic
// entries, never an API answer, never the outbox) and the browser is sent to
// /?share=1 with a 303, where the app asks what to start with them. Nothing
// is uploaded here; the app clears the cache when the share is used or
// dismissed, on sign out, and after a day. Whatever goes wrong, the answer is
// still the redirect home (the app then says nothing came through) - never
// an error page. With the kill switch on, the POST goes to the network like
// everything else (functions/share-target.js sends it home) and activate
// removes the share cache with the shell caches.
//
// Served from /sw.js (frontend/public), scope '/'. Registered by
// src/lib/pwa.js. In `npm run dev` MANIFEST stays null and this worker never
// touches a page, a file or the API (push and Share to Nexus only).
const MANIFEST = null; // @nx-offline-manifest (replaced by the build)
const KILL = false; // @nx-offline-kill (true when built with VITE_OFFLINE_SHELL=off)

const PREFIX = 'nexus-shell-';
const META_CACHE = 'nexus-offline-meta';     // { current, previous } - the one record of build order
const META_KEY = '/__nexus-shell-builds';
const SHELL_KEY = '/index.html';
const CURRENT = MANIFEST ? `${PREFIX}${MANIFEST.build}` : '';
const NAV_TIMEOUT_MS = 10000;
// Never answered here, whatever they are.
const PASS_PREFIXES = ['/api/', '/auth-popup', '/outlook-addin/', '/pdf-editor-app/', '/careers', '/outside/', '/assets-404'];
const PASS_EXACT = new Set(['/api', '/version.json', '/sw.js']);

function route(request) {
  if (KILL || !MANIFEST || request.method !== 'GET') return 'pass';
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

async function readBuilds() {
  try {
    const r = await (await caches.open(META_CACHE)).match(META_KEY);
    const v = r ? await r.json() : null;
    return v && typeof v === 'object' ? { current: v.current || '', previous: v.previous || '' } : { current: '', previous: '' };
  } catch { return { current: '', previous: '' }; }
}

// Vary is ignored: a module script asks with an Origin header the install
// fetch did not send, and a `Vary: Origin` answer would otherwise never match
// - every saved file would miss offline (found on the first offline run,
// 11/03/2026). The files are content-hashed or this build's own.
async function matchIn(name, request, opts = {}) {
  if (!name || !(await caches.has(name))) return null;
  return (await (await caches.open(name)).match(request, { ignoreVary: true, ...opts })) || null;
}

// This build's cache, then the one build before it - the only two kept.
async function matchAny(request, opts = {}) {
  const hit = await matchIn(CURRENT, request, opts);
  if (hit) return hit;
  const { previous } = await readBuilds();
  return previous && previous !== CURRENT ? matchIn(previous, request, opts) : null;
}

const isHtml = (res) => (res.headers.get('content-type') || '').includes('text/html');

function keepShell(res) {
  // Keep the newest shell for when there is no signal - only the real page
  // (a 200 from this origin, not a redirect, not an error page).
  if (res.ok && res.type === 'basic' && !res.redirected && isHtml(res)) {
    const copy = res.clone();
    caches.open(CURRENT).then((c) => c.put(SHELL_KEY, copy)).catch(() => {});
  }
  return res;
}

const offlinePage = () => new Response(
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Nexus</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;'
  + 'display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f6f7fb;color:#323338">'
  + '<div style="text-align:center;max-width:340px;padding:24px"><h1 style="font-size:18px">You Are Offline</h1>'
  + '<p style="font-size:14px;line-height:1.5;color:#676879">Open this once with signal and it will open offline after that.</p></div>',
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

async function page(request) {
  const network = fetch(request).then(keepShell);
  network.catch(() => {});                       // a late failure after the timeout answered
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve('slow'), NAV_TIMEOUT_MS); });
  try {
    const first = await Promise.race([network, slow]);
    if (first !== 'slow') return first;
    // A signal too weak to bring the page back: this build's saved page
    // (its files are in this build's cache). Without one, keep waiting.
    const mine = await matchIn(CURRENT, SHELL_KEY);
    return mine || await network;
  } catch {
    // No signal at all: this build's page, else the one build before (its
    // files are kept with it), else a plain page - never blank.
    return (await matchAny(SHELL_KEY)) || offlinePage();
  } finally { clearTimeout(timer); }
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
    // guard.js is stamped ?v=<build>: this build's copy, else the one before.
    const hit = await matchAny(request, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

// ── Share to Nexus ───────────────────────────────────────────────────────────
// The names below are read by the app too (src/lib/shareTarget.js) - change
// both together (src/lib/shareTarget.test.js checks they match).
const SHARE_PATH = '/share-target';
const SHARE_CACHE = 'nexus-share';
const SHARE_META = '/__nexus-share/meta';
const SHARE_FILE = '/__nexus-share/file/';
const SHARE_MAX_FILES = 10;
const SHARE_MAX_BYTES = 100 * 1024 * 1024;   // every shared file together
const SHARE_MAX_TEXT = 20000;

function isShare(request) {
  if (KILL || request.method !== 'POST') return false;
  try {
    const url = new URL(request.url);
    return url.origin === self.location.origin && url.pathname === SHARE_PATH;
  } catch { return false; }
}

async function keepShare(request) {
  const form = await request.formData();
  const words = (k) => { const v = form.get(k); return typeof v === 'string' ? v.slice(0, SHARE_MAX_TEXT) : ''; };
  const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size > 0);
  await caches.delete(SHARE_CACHE);            // one share at a time: the newest replaces the last
  const cache = await caches.open(SHARE_CACHE);
  const kept = [];
  let bytes = 0;
  let skipped = 0;
  for (const f of files) {
    if (kept.length >= SHARE_MAX_FILES || bytes + f.size > SHARE_MAX_BYTES) { skipped += 1; continue; }
    const key = `${SHARE_FILE}${kept.length}`;
    try {
      await cache.put(key, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
      kept.push({ key, name: f.name || `Shared File ${kept.length + 1}`, type: f.type || '', size: f.size, lastModified: f.lastModified || 0 });
      bytes += f.size;
    } catch { skipped += 1; }                   // no room on the phone for this one
  }
  const meta = { at: Date.now(), title: words('title'), text: words('text'), url: words('url'), files: kept, skipped };
  await cache.put(SHARE_META, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
}

async function share(request) {
  try { await keepShare(request); } catch { /* nothing kept: the app says so */ }
  return Response.redirect(new URL('/?share=1', self.location.origin).href, 303);
}

self.addEventListener('fetch', (event) => {
  if (isShare(event.request)) { event.respondWith(share(event.request)); return; }
  const kind = route(event.request);
  if (kind === 'pass') return;                 // the browser handles it as if there were no worker
  if (kind === 'page') event.respondWith(page(event.request));
  else if (kind === 'asset') event.respondWith(asset(event.request));
  else if (kind === 'static') event.respondWith(staticFile(event.request));
});

async function precache() {
  const cache = await caches.open(CURRENT);
  const { current: before } = await readBuilds();   // the build this one replaces
  const urls = [...(MANIFEST.assets || []), ...(MANIFEST.static || []).map((p) => `${p}?v=${MANIFEST.build}`)];
  // One failed file does not stop the rest (a retry happens on the next load).
  await Promise.allSettled(urls.map(async (u) => {
    const hashed = u.startsWith('/assets/');
    if (await cache.match(u, { ignoreSearch: !hashed, ignoreVary: true })) return;
    // A hashed file the build before already holds is the same bytes: copy it.
    if (hashed && before && before !== CURRENT) {
      const old = await matchIn(before, u);
      if (old) { await cache.put(u, old); return; }
    }
    const res = await fetch(u, { cache: hashed ? 'default' : 'reload' });
    if (res.ok && !(hashed && isHtml(res))) await cache.put(u, res);
  }));
  try {
    const shell = await fetch('/', { cache: 'reload' });
    if (shell.ok && !shell.redirected && isHtml(shell)) await cache.put(SHELL_KEY, shell);
  } catch { /* offline install: the first page load saves it */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    if (MANIFEST && !KILL) { try { await precache(); } catch { /* best effort - the shell still works online */ } }
    await self.skipWaiting();
  })());
});

// Keep exactly this build's cache and the one it replaced (an open tab may
// still be on it); remove every other shell cache. The order is recorded in
// META_CACHE as { current, previous } - never read from caches.keys(), whose
// order is creation order and would keep an ancient build forever.
async function cleanUp() {
  if (KILL) {
    for (const n of await caches.keys()) if (n.startsWith(PREFIX) || n === META_CACHE || n === SHARE_CACHE) await caches.delete(n);
    return;
  }
  if (!MANIFEST) return;
  const was = await readBuilds();
  const previous = was.current && was.current !== CURRENT ? was.current : (was.previous !== CURRENT ? was.previous : '');
  await (await caches.open(META_CACHE)).put(META_KEY, new Response(JSON.stringify({ current: CURRENT, previous }), { headers: { 'Content-Type': 'application/json' } }));
  for (const n of await cacheNames()) if (n !== CURRENT && n !== previous) await caches.delete(n);
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
