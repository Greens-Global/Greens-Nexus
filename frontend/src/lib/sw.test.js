import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// public/sw.js is the push-only service worker (Frontline Reach, 11/02/2026).
// Nothing imports it, so a syntax error or a broken handler would ship
// silently and break install + push on every device. This runs the file
// against a stub `self` and fires the two events it handles.
const src = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

function boot(origin = 'https://nexus.example.test') {
  const handlers = {};
  const clients = [];
  const self = {
    location: { origin, href: `${origin}/sw.js` },
    addEventListener: (name, fn) => { handlers[name] = fn; },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve(clients)),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('self', src)(self);
  return { self, handlers, clients };
}

const waitUntil = async (fn, ev) => { const pending = []; ev.waitUntil = (p) => pending.push(p); fn(ev); await Promise.all(pending); };

describe('public/sw.js', () => {
  let ctx;
  beforeEach(() => { ctx = boot(); });

  it('parses and registers install, activate, push and notificationclick', () => {
    expect(Object.keys(ctx.handlers).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
    ctx.handlers.install({});
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
    expect(ctx.self.clients.openWindow).toHaveBeenCalledWith('https://nexus.example.test/tickets/42');
  });

  it('a tap focuses an open Nexus window and moves it to the screen', async () => {
    const client = { url: 'https://nexus.example.test/home', focus: vi.fn(() => Promise.resolve()), navigate: vi.fn(() => Promise.resolve()) };
    ctx.clients.push(client);
    await waitUntil(ctx.handlers.notificationclick, { notification: { close: vi.fn(), data: { url: '/tickets/42' } } });
    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith('https://nexus.example.test/tickets/42');
    expect(ctx.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('a url off this origin - absolute or protocol-relative - opens Nexus home, never the other site', async () => {
    for (const url of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)']) {
      ctx = boot();
      await waitUntil(ctx.handlers.notificationclick, { notification: { close: vi.fn(), data: { url } } });
      expect(ctx.self.clients.openWindow).toHaveBeenCalledWith('https://nexus.example.test/');
    }
  });
});
