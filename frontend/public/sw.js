// Nexus service worker (Frontline Reach, Neil 11/02/2026).
//
// It does ONE job: Web Push. A push from the server (push.py) carries the same
// notice the bell shows - title, body, the screen to open - and this shows it
// as a system notification; a tap opens or focuses Nexus on that screen.
//
// Deliberately NO fetch handler and NO caching: offline was deferred (Neil),
// and a caching worker on top of Vite's hashed assets is a second thing to
// get wrong. Installing a PWA needs a worker to exist, not to cache.
//
// Served from /sw.js (frontend/public), scope '/'. Registered by
// src/lib/pwa.js once the person is signed in.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

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
