import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// public/sw.js: Web Push (Frontline Reach, 11/02/2026) and the offline app
// shell (full offline for field work, Neil 11/03/2026). Nothing imports it, so
// a syntax error or a broken handler would ship silently and break install,
// push and offline on every device. This runs the file against a stub `self`
// (and a stub Cache API) and fires the events it handles - both as the source
// file (no manifest: push only, no request is ever answered) and as the
// build writes it (scripts/offline-manifest.mjs fills MANIFEST).
const raw = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
const ORIGIN = 'https://nexus.example.test';
const MANIFEST = {
  build: 'b2',
  assets: ['/assets/index-nx2-aaa.js', '/assets/index-nx2-aaa.css', '/assets/FillForm-nx2-bbb.js'],
  static: ['/guard.js', '/manifest.webmanifest'],
};
const built = raw.replace(/const MANIFEST = null;[^\n]*/, `const MANIFEST = ${JSON.stringify(MANIFEST)};`);

// A Response stand-in: enough of the shape the worker reads.
function res(body = '', { status = 200, type = 'basic', redirected = false, ct = 'application/javascript' } = {}) {
  return {
    body, status, ok: status >= 200 && status < 300, type, redirected,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
    clone() { return res(body, { status, type, redirected, ct }); },
    json: async () => JSON.parse(body),
  };
}
class FakeResponse { constructor(body, init = {}) { Object.assign(this, res(body, { status: init.status || 200, ct: init.headers?.['Content-Type'] || '' })); } }

function fakeCaches() {
  const store = new Map();   // name -> Map(url -> response)
  const keyOf = (r, ignoreSearch) => {
    const u = new URL(typeof r === 'string' ? r : r.url, ORIGIN);
    return ignoreSearch ? u.origin + u.pathname : u.href;
  };
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      match: async (r, opts = {}) => {
        // A real cache honors Vary: a stored `Vary: Origin` answer misses a
        // request with another Origin unless ignoreVary is set.
        if (!opts.ignoreVary && [...m.values()].some((v) => v.vary)) return undefined;
        if (!opts.ignoreSearch) return m.get(keyOf(r)) || undefined;
        const want = keyOf(r, true);
        for (const [k, v] of m) if (keyOf(k, true) === want) return v;
        return undefined;
      },
      put: async (r, v) => { m.set(keyOf(r), v); },
    };
  };
  return {
    store,
    api: {
      open,
      keys: async () => [...store.keys()],
      delete: async (n) => store.delete(n),
    },
  };
}

function boot(source = built) {
  const handlers = {};
  const clients = [];
  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    skipWaiting: vi.fn(() => Promise.resolve()),
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve(clients)),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
  };
  const c = fakeCaches();
  const fetch = vi.fn(async () => res('net'));
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Response', source)(self, c.api, fetch, FakeResponse);
  return { self, handlers, clients, caches: c, fetch };
}

const waitUntil = async (fn, ev) => { const pending = []; ev.waitUntil = (p) => pending.push(p); fn(ev); await Promise.all(pending); };
const req = (path, { method = 'GET', mode = 'cors', origin = ORIGIN } = {}) => ({ url: `${origin}${path}`, method, mode });
// Fire a fetch event; resolves with the response the worker gave, or 'pass'.
async function fire(ctx, request) {
  let answered = null;
  ctx.handlers.fetch({ request, respondWith: (p) => { answered = p; } });
  return answered ? await answered : 'pass';
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('public/sw.js - push', () => {
  let ctx;
  beforeEach(() => { ctx = boot(); });

  it('parses and registers install, activate, fetch, push and notificationclick', async () => {
    expect(Object.keys(ctx.handlers).sort()).toEqual(['activate', 'fetch', 'install', 'notificationclick', 'push']);
    await waitUntil(ctx.handlers.install, {});
    expect(ctx.self.skipWaiting).toHaveBeenCalled();
  });

  it('a push shows the notice with the Nexus icon and badge and keeps the screen to open', async () => {
    const payload = { title: 'Task Assigned', body: 'Fix the gate at Austin', url: '/tasks/t1', tag: 'task:t1' };
    await waitUntil(ctx.handlers.push, { data: { json: () => payload } });
    expect(ctx.self.registration.showNotification).toHaveBeenCalledWith('Task Assigned', expect.objectContaining({
      body: 'Fix the gate at Austin',
      tag: 'task:t1',
      icon: '/icons/nexus-192.png',
      badge: '/icons/nexus-badge-96.png',
      data: { url: '/tasks/t1' },
    }));
  });

  it('a push that is not JSON still shows as a Nexus notice', async () => {
    await waitUntil(ctx.handlers.push, { data: { json: () => { throw new Error('not json'); }, text: () => 'plain text' } });
    expect(ctx.self.registration.showNotification).toHaveBeenCalledWith('Nexus', expect.objectContaining({ body: 'plain text' }));
  });

  it('a tap opens the screen on this origin when no Nexus window is open', async () => {
    const ev = { notification: { close: vi.fn(), data: { url: '/tickets/42' } } };
    await waitUntil(ctx.handlers.notificationclick, ev);
    expect(ev.notification.close).toHaveBeenCalled();
    expect(ctx.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/tickets/42`);
  });

  it('a tap focuses an open Nexus window and moves it to the screen', async () => {
    const client = { url: `${ORIGIN}/home`, focus: vi.fn(() => Promise.resolve()), navigate: vi.fn(() => Promise.resolve()) };
    ctx.clients.push(client);
    await waitUntil(ctx.handlers.notificationclick, { notification: { close: vi.fn(), data: { url: '/tickets/42' } } });
    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith(`${ORIGIN}/tickets/42`);
    expect(ctx.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a url off this origin - absolute or protocol-relative - opens Nexus home, never the other site', async () => {
    for (const url of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)']) {
      ctx = boot();
      await waitUntil(ctx.handlers.notificationclick, { notification: { close: vi.fn(), data: { url } } });
      expect(ctx.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
    }
  });
});

describe('public/sw.js - offline routing', () => {
  it('as the source file (npm run dev, no manifest) it answers no request at all', async () => {
    const ctx = boot(raw);
    for (const r of [req('/', { mode: 'navigate' }), req('/assets/index-nx2-aaa.js'), req('/guard.js')]) {
      expect(await fire(ctx, r)).toBe('pass');
    }
    await waitUntil(ctx.handlers.install, {});
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it('routes: pages network first, hashed assets cache first, the API and everything else straight through', () => {
    const route = boot().self.__nxRoute;
    expect(route(req('/workday', { mode: 'navigate' }))).toBe('page');
    expect(route(req('/assets/x-nx2-1.js'))).toBe('asset');
    expect(route(req('/guard.js'))).toBe('static');
    // The API is never cached: another origin, or the BFF proxy on this one.
    expect(route(req('/forms/mine', { origin: 'https://greens-nexus-api.azurewebsites.net' }))).toBe('pass');
    expect(route(req('/api/forms/mine'))).toBe('pass');
    expect(route(req('/api/auth/me', { mode: 'navigate' }))).toBe('pass');
    expect(route(req('/storage/v1/object/x', { origin: 'https://proj.supabase.co' }))).toBe('pass');
    // Writes, the build stamp, sign-in pages and other HTML apps pass too.
    expect(route(req('/assets/x.js', { method: 'POST' }))).toBe('pass');
    expect(route(req('/version.json'))).toBe('pass');
    expect(route(req('/auth-popup', { mode: 'navigate' }))).toBe('pass');
    expect(route(req('/outlook-addin/commands.html', { mode: 'navigate' }))).toBe('pass');
    expect(route(req('/pdf-editor-app/index.html', { mode: 'navigate' }))).toBe('pass');
    expect(route(req('/careers/apply', { mode: 'navigate' }))).toBe('pass');
    expect(route(req('/excalidraw-assets/font.woff2'))).toBe('pass');
  });

  it('an API request is never answered or fetched by the worker', async () => {
    const ctx = boot();
    expect(await fire(ctx, req('/forms/mine', { origin: 'https://greens-nexus-api.azurewebsites.net' }))).toBe('pass');
    expect(await fire(ctx, req('/api/forms/t1/entries', { method: 'POST' }))).toBe('pass');
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect([...ctx.caches.store.values()].every((m) => m.size === 0)).toBe(true);
  });

  it('a page online is always the network copy, and that copy is kept for offline', async () => {
    const ctx = boot();
    ctx.fetch.mockResolvedValueOnce(res('<html>new</html>', { ct: 'text/html' }));
    const out = await fire(ctx, req('/workday', { mode: 'navigate' }));
    expect(out.body).toBe('<html>new</html>');
    await settle();
    expect(ctx.caches.store.get('nexus-shell-b2').get(`${ORIGIN}/index.html`).body).toBe('<html>new</html>');
  });

  it('a page with no signal opens the kept shell; with nothing kept, a plain offline page (never blank)', async () => {
    const ctx = boot();
    ctx.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const none = await fire(ctx, req('/workday', { mode: 'navigate' }));
    expect(none.status).toBe(503);
    expect(none.body).toContain('You Are Offline');
    const c = await ctx.caches.api.open('nexus-shell-b1');
    await c.put('/index.html', res('<html>kept</html>', { ct: 'text/html' }));
    const kept = await fire(ctx, req('/tasks', { mode: 'navigate' }));
    expect(kept.body).toBe('<html>kept</html>');
  });

  it('a redirect or an error page is never kept as the shell', async () => {
    const ctx = boot();
    ctx.fetch.mockResolvedValueOnce(res('<html>moved</html>', { ct: 'text/html', redirected: true }));
    await fire(ctx, req('/', { mode: 'navigate' }));
    ctx.fetch.mockResolvedValueOnce(res('<html>oops</html>', { ct: 'text/html', status: 500 }));
    await fire(ctx, req('/', { mode: 'navigate' }));
    await settle();
    expect(ctx.caches.store.get('nexus-shell-b2')?.get(`${ORIGIN}/index.html`)).toBeUndefined();
  });

  it('hashed assets come from the cache first, and one fetched online is kept', async () => {
    const ctx = boot();
    const c = await ctx.caches.api.open('nexus-shell-b2');
    await c.put('/assets/index-nx2-aaa.js', res('cached js'));
    expect((await fire(ctx, req('/assets/index-nx2-aaa.js'))).body).toBe('cached js');
    expect(ctx.fetch).not.toHaveBeenCalled();
    ctx.fetch.mockResolvedValueOnce(res('fresh chunk'));
    expect((await fire(ctx, req('/assets/Other-nx2-ccc.js'))).body).toBe('fresh chunk');
    await settle();
    expect(await c.match('/assets/Other-nx2-ccc.js')).toBeTruthy();
    // An HTML page served under a chunk's name is never kept.
    ctx.fetch.mockResolvedValueOnce(res('<html>', { ct: 'text/html' }));
    await fire(ctx, req('/assets/Bad-nx2-ddd.js'));
    await settle();
    expect(await c.match('/assets/Bad-nx2-ddd.js')).toBeUndefined();
  });

  it('a saved file answers whatever headers the page asks with (Vary is ignored)', async () => {
    const ctx = boot();
    const c = await ctx.caches.api.open('nexus-shell-b2');
    await c.put('/assets/index-nx2-aaa.js', { ...res('saved js'), vary: 'Origin' });
    ctx.fetch.mockRejectedValue(new TypeError('offline'));
    expect((await fire(ctx, req('/assets/index-nx2-aaa.js'))).body).toBe('saved js');
  });

  it('install saves the manifest (assets, stamped static files and the shell) and takes over', async () => {
    const ctx = boot();
    ctx.fetch.mockImplementation(async (u) => (String(u) === '/' ? res('<html>shell</html>', { ct: 'text/html' }) : res(`file ${u}`)));
    await waitUntil(ctx.handlers.install, {});
    const c = ctx.caches.store.get('nexus-shell-b2');
    for (const a of MANIFEST.assets) expect(c.get(`${ORIGIN}${a}`)).toBeTruthy();
    expect(c.get(`${ORIGIN}/guard.js?v=b2`)).toBeTruthy();
    expect(c.get(`${ORIGIN}/index.html`).body).toBe('<html>shell</html>');
    expect(ctx.self.skipWaiting).toHaveBeenCalled();
    // guard.js with no signal: any saved build's copy answers.
    ctx.fetch.mockRejectedValue(new TypeError('offline'));
    expect((await fire(ctx, req('/guard.js?v=b2'))).body).toBe('file /guard.js?v=b2');
  });

  it('activate keeps this build and the one before, and removes older ones', async () => {
    const ctx = boot();
    const prev = await ctx.caches.api.open('nexus-shell-b1');
    await prev.put('/__nexus-shell-order', new FakeResponse(JSON.stringify(['nexus-shell-b1', 'nexus-shell-b0'])));
    await ctx.caches.api.open('nexus-shell-b0');
    await ctx.caches.api.open('other-cache');
    await waitUntil(ctx.handlers.activate, {});
    expect([...ctx.caches.store.keys()].sort()).toEqual(['nexus-shell-b1', 'nexus-shell-b2', 'other-cache']);
    expect(ctx.self.clients.claim).toHaveBeenCalled();
  });
});
