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
const buildOf = (m) => raw.replace(/const MANIFEST = null;[^\n]*/, `const MANIFEST = ${JSON.stringify(m)};`);
const built = buildOf(MANIFEST);
const killed = raw.replace(/const KILL = false;[^\n]*/, 'const KILL = true;');

// A Response stand-in: enough of the shape the worker reads.
function res(body = '', { status = 200, type = 'basic', redirected = false, ct = 'application/javascript' } = {}) {
  return {
    body, status, ok: status >= 200 && status < 300, type, redirected,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ct : null) },
    clone() { return res(body, { status, type, redirected, ct }); },
    json: async () => JSON.parse(body),
  };
}
class FakeResponse {
  constructor(body, init = {}) { Object.assign(this, res(body, { status: init.status || 200, ct: init.headers?.['Content-Type'] || '' })); }
  static redirect(url, status) { return { status, redirectTo: url }; }
}

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
      has: async (n) => store.has(n),
      delete: async (n) => store.delete(n),
    },
  };
}

function boot(source = built, shared = null) {
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
  const c = shared || fakeCaches();
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
    // The build before this one (recorded in the meta cache) still answers.
    await (await ctx.caches.api.open('nexus-offline-meta')).put('/__nexus-shell-builds', new FakeResponse(JSON.stringify({ current: 'nexus-shell-b2', previous: 'nexus-shell-b1' })));
    const c = await ctx.caches.api.open('nexus-shell-b1');
    await c.put('/index.html', res('<html>kept</html>', { ct: 'text/html' }));
    const kept = await fire(ctx, req('/tasks', { mode: 'navigate' }));
    expect(kept.body).toBe('<html>kept</html>');
    // ...but a build that is neither this one nor the one before never does.
    const ctx2 = boot();
    ctx2.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await (await ctx2.caches.api.open('nexus-shell-b0')).put('/index.html', res('<html>ancient</html>', { ct: 'text/html' }));
    expect((await fire(ctx2, req('/tasks', { mode: 'navigate' }))).status).toBe(503);
  });

  it('a weak signal: after 10 s the CURRENT build\'s saved page answers, never an older build\'s', async () => {
    vi.useFakeTimers();
    try {
      const ctx = boot();
      let release;
      ctx.fetch.mockImplementation(() => new Promise((r) => { release = r; }));
      await (await ctx.caches.api.open('nexus-shell-b2')).put('/index.html', res('<html>current</html>', { ct: 'text/html' }));
      let out = null;
      ctx.handlers.fetch({ request: req('/workday', { mode: 'navigate' }), respondWith: (p) => { p.then((r) => { out = r; }); } });
      await vi.advanceTimersByTimeAsync(9000);
      expect(out).toBeNull();                                   // still waiting on the network
      await vi.advanceTimersByTimeAsync(1500);
      expect(out.body).toBe('<html>current</html>');

      // Only an older build's page saved: keep waiting for the network.
      const ctx2 = boot();
      ctx2.fetch.mockImplementation(() => new Promise((r) => { release = r; }));
      await (await ctx2.caches.api.open('nexus-offline-meta')).put('/__nexus-shell-builds', new FakeResponse(JSON.stringify({ current: 'nexus-shell-b2', previous: 'nexus-shell-b1' })));
      await (await ctx2.caches.api.open('nexus-shell-b1')).put('/index.html', res('<html>older</html>', { ct: 'text/html' }));
      let out2 = null;
      ctx2.handlers.fetch({ request: req('/workday', { mode: 'navigate' }), respondWith: (p) => { p.then((r) => { out2 = r; }); } });
      await vi.advanceTimersByTimeAsync(15000);
      expect(out2).toBeNull();
      release(res('<html>network</html>', { ct: 'text/html' }));
      await vi.advanceTimersByTimeAsync(10);
      expect(out2.body).toBe('<html>network</html>');
    } finally { vi.useRealTimers(); }
  });

  it('a responsive network always wins (never stale online)', async () => {
    const ctx = boot();
    await (await ctx.caches.api.open('nexus-shell-b2')).put('/index.html', res('<html>saved</html>', { ct: 'text/html' }));
    ctx.fetch.mockResolvedValueOnce(res('<html>fresh</html>', { ct: 'text/html' }));
    expect((await fire(ctx, req('/workday', { mode: 'navigate' }))).body).toBe('<html>fresh</html>');
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

  it('deploy after deploy, activate keeps exactly this build and the one it replaced', async () => {
    const shared = fakeCaches();
    await shared.api.open('other-cache');
    const builds = ['a1', 'a2', 'a3', 'a4', 'a5'];
    for (const [i, b] of builds.entries()) {
      const ctx = boot(buildOf({ ...MANIFEST, build: b }), shared);
      ctx.fetch.mockImplementation(async (u) => (String(u) === '/' ? res('<html></html>', { ct: 'text/html' }) : res(`file ${u}`)));
      await waitUntil(ctx.handlers.install, {});
      await waitUntil(ctx.handlers.activate, {});
      const shells = [...shared.store.keys()].filter((n) => n.startsWith('nexus-shell-')).sort();
      expect(shells).toEqual(i === 0 ? ['nexus-shell-a1'] : [`nexus-shell-${builds[i - 1]}`, `nexus-shell-${b}`].sort());
      expect(ctx.self.clients.claim).toHaveBeenCalled();
    }
    expect(shared.store.has('other-cache')).toBe(true);
    // Activating the same build again (a second tab) keeps the same pair.
    const again = boot(buildOf({ ...MANIFEST, build: 'a5' }), shared);
    await waitUntil(again.handlers.activate, {});
    expect([...shared.store.keys()].filter((n) => n.startsWith('nexus-shell-')).sort()).toEqual(['nexus-shell-a4', 'nexus-shell-a5']);
  });

  it('install copies an unchanged hashed file from the build before instead of fetching it', async () => {
    const shared = fakeCaches();
    const first = boot(buildOf({ ...MANIFEST, build: 'c1' }), shared);
    first.fetch.mockImplementation(async (u) => res(`file ${u}`, { ct: String(u) === '/' ? 'text/html' : 'application/javascript' }));
    await waitUntil(first.handlers.install, {});
    await waitUntil(first.handlers.activate, {});
    const next = boot(buildOf({ ...MANIFEST, build: 'c2', assets: [...MANIFEST.assets, '/assets/New-nx2-zzz.js'] }), shared);
    next.fetch.mockImplementation(async (u) => res(`file ${u}`, { ct: String(u) === '/' ? 'text/html' : 'application/javascript' }));
    await waitUntil(next.handlers.install, {});
    const fetched = next.fetch.mock.calls.map(([u]) => String(u));
    expect(fetched.filter((u) => u.startsWith('/assets/'))).toEqual(['/assets/New-nx2-zzz.js']);
    expect(shared.store.get('nexus-shell-c2').get(`${ORIGIN}/assets/index-nx2-aaa.js`).body).toBe('file /assets/index-nx2-aaa.js');
  });
});

describe('public/sw.js - the kill switch (VITE_OFFLINE_SHELL=off)', () => {
  it('empties every shell cache on activate, answers no request, keeps push and never unregisters', async () => {
    const shared = fakeCaches();
    await (await shared.api.open('nexus-shell-b1')).put('/index.html', res('<html></html>', { ct: 'text/html' }));
    await shared.api.open('nexus-shell-b2');
    await (await shared.api.open('nexus-offline-meta')).put('/__nexus-shell-builds', new FakeResponse('{"current":"nexus-shell-b2","previous":"nexus-shell-b1"}'));
    await shared.api.open('other-cache');
    const ctx = boot(killed, shared);
    ctx.self.registration.unregister = vi.fn();
    await waitUntil(ctx.handlers.install, {});
    await waitUntil(ctx.handlers.activate, {});
    expect([...shared.store.keys()]).toEqual(['other-cache']);
    expect(ctx.self.clients.claim).toHaveBeenCalled();
    for (const r of [req('/', { mode: 'navigate' }), req('/assets/index-nx2-aaa.js'), req('/guard.js')]) expect(await fire(ctx, r)).toBe('pass');
    expect(ctx.fetch).not.toHaveBeenCalled();
    await waitUntil(ctx.handlers.push, { data: { json: () => ({ title: 'Task Assigned' }) } });
    expect(ctx.self.registration.showNotification).toHaveBeenCalledWith('Task Assigned', expect.anything());
    expect(ctx.self.registration.unregister).not.toHaveBeenCalled();
  });
});

describe('public/sw.js - Share to Nexus (the share_target POST)', () => {
  const file = (name, type, size) => ({ name, type, size, lastModified: 1700000000000 });
  const shareReq = (fields, { path = '/share-target', method = 'POST', origin = ORIGIN } = {}) => ({
    url: `${origin}${path}`, method, mode: 'navigate',
    formData: async () => ({
      get: (k) => (k in fields && k !== 'files' ? fields[k] : null),
      getAll: (k) => (k === 'files' ? fields.files || [] : []),
    }),
  });
  const kept = async (ctx) => {
    const c = ctx.caches.store.get('nexus-share');
    const meta = c?.get(`${ORIGIN}/__nexus-share/meta`);
    return meta ? { meta: JSON.parse(meta.body), cache: c } : null;
  };

  it('keeps the words and files in its own cache and sends the app to /?share=1 with a 303', async () => {
    for (const source of [built, raw]) {      // with the offline shell, and as the source file (no manifest)
      const ctx = boot(source);
      const photo = file('gate.jpg', 'image/jpeg', 2048);
      const out = await fire(ctx, shareReq({ title: 'Gate', text: 'Keypad is dead', url: 'https://example.com/x', files: [photo] }));
      expect(out).toEqual({ status: 303, redirectTo: `${ORIGIN}/?share=1` });
      const { meta, cache } = await kept(ctx);
      expect(meta).toMatchObject({ title: 'Gate', text: 'Keypad is dead', url: 'https://example.com/x', skipped: 0 });
      expect(meta.files).toEqual([{ key: '/__nexus-share/file/0', name: 'gate.jpg', type: 'image/jpeg', size: 2048, lastModified: 1700000000000 }]);
      expect(cache.get(`${ORIGIN}/__nexus-share/file/0`).body).toBe(photo);
      expect(typeof meta.at).toBe('number');
      // Nothing was fetched, and no shell or API entry was written.
      expect(ctx.fetch).not.toHaveBeenCalled();
      expect([...ctx.caches.store.keys()]).toEqual(['nexus-share']);
    }
  });

  it('a new share replaces the last one; empty files, an eleventh file and anything over the size are left out and counted', async () => {
    const ctx = boot();
    await fire(ctx, shareReq({ text: 'first', files: [file('a.pdf', 'application/pdf', 10)] }));
    const many = Array.from({ length: 11 }, (_, i) => file(`p${i}.png`, 'image/png', 100));
    await fire(ctx, shareReq({ text: 'second', files: [file('empty.txt', 'text/plain', 0), ...many] }));
    let { meta } = await kept(ctx);
    expect(meta.text).toBe('second');
    expect(meta.files.map((f) => f.name)).toEqual(many.slice(0, 10).map((f) => f.name));
    expect(meta.skipped).toBe(1);
    await fire(ctx, shareReq({ files: [file('big.pdf', 'application/pdf', 101 * 1024 * 1024), file('ok.pdf', 'application/pdf', 5)] }));
    ({ meta } = await kept(ctx));
    expect(meta.files.map((f) => f.name)).toEqual(['ok.pdf']);
    expect(meta.skipped).toBe(1);
  });

  it('whatever goes wrong, the answer is still the redirect home - never an error', async () => {
    const ctx = boot();
    const bad = { url: `${ORIGIN}/share-target`, method: 'POST', mode: 'navigate', formData: async () => { throw new TypeError('not multipart'); } };
    expect(await fire(ctx, bad)).toEqual({ status: 303, redirectTo: `${ORIGIN}/?share=1` });
    expect(await kept(ctx)).toBeNull();
    // No room for one file: it is counted, the rest is kept.
    const ctx2 = boot();
    const open = ctx2.caches.api.open;
    ctx2.caches.api.open = async (name) => {
      const c = await open(name);
      const put = c.put;
      return { ...c, put: async (k, v) => { if (String(k).endsWith('/file/0')) throw new Error('QuotaExceededError'); return put(k, v); } };
    };
    expect((await fire(ctx2, shareReq({ text: 'hi', files: [file('a.png', 'image/png', 5)] }))).status).toBe(303);
    expect((await kept(ctx2)).meta).toMatchObject({ text: 'hi', files: [], skipped: 1 });
  });

  it('answers only that one POST: other writes, other paths and other origins still pass', async () => {
    const ctx = boot();
    expect(await fire(ctx, shareReq({ text: 'x' }, { path: '/api/share-target' }))).toBe('pass');
    expect(await fire(ctx, shareReq({ text: 'x' }, { path: '/share-target/more' }))).toBe('pass');
    expect(await fire(ctx, shareReq({ text: 'x' }, { origin: 'https://evil.example' }))).toBe('pass');
    expect(await fire(ctx, req('/api/forms/t1/entries', { method: 'POST' }))).toBe('pass');
    expect(ctx.caches.store.has('nexus-share')).toBe(false);
  });

  it('with the kill switch on, the share goes to the network like everything else and its cache is emptied', async () => {
    const shared = fakeCaches();
    await (await shared.api.open('nexus-share')).put('/__nexus-share/meta', new FakeResponse('{"at":1}'));
    const ctx = boot(killed, shared);
    await waitUntil(ctx.handlers.activate, {});
    expect(shared.store.has('nexus-share')).toBe(false);
    expect(await fire(ctx, shareReq({ text: 'x' }))).toBe('pass');
    expect(shared.store.has('nexus-share')).toBe(false);
  });

  it('a deploy keeps a share that is waiting (activate removes shell caches only)', async () => {
    const shared = fakeCaches();
    await (await shared.api.open('nexus-share')).put('/__nexus-share/meta', new FakeResponse('{"at":1}'));
    const ctx = boot(buildOf({ ...MANIFEST, build: 'z9' }), shared);
    await waitUntil(ctx.handlers.activate, {});
    expect(shared.store.has('nexus-share')).toBe(true);
  });
});

describe('scripts/offline-manifest.mjs writeWorker', () => {
  it('writes the file list, or - with the switch off - KILL and no list', async () => {
    const { writeWorker, shellKilled } = await import('../../scripts/offline-manifest.mjs');
    const on = writeWorker(raw, { buildId: 'x9', assets: ['/assets/a.js'], killed: false });
    expect(on).toContain('const MANIFEST = {"build":"x9"');
    expect(on).toContain('const KILL = false;');
    const off = writeWorker(raw, { buildId: 'x9', assets: ['/assets/a.js'], killed: true });
    expect(off).toContain('const MANIFEST = null;');
    expect(off).toContain('const KILL = true;');
    expect(shellKilled({ VITE_OFFLINE_SHELL: 'off' })).toBe(true);
    expect(shellKilled({ VITE_OFFLINE_SHELL: 'OFF ' })).toBe(true);
    expect(shellKilled({})).toBe(false);
  });
});
