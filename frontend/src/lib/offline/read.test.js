import { describe, it, expect, vi } from 'vitest';

// clearOfflineReadCache (field offline, Neil 11/03/2026): sign out waits for
// it, so it must finish - and must never hold a sign out up for long when
// IndexedDB is stuck.
const store = vi.hoisted(() => ({ clearReadCache: null }));
vi.mock('./store', () => ({ clearReadCache: (...a) => store.clearReadCache(...a) }));
const { clearOfflineReadCache } = await import('./read');

describe('clearOfflineReadCache', () => {
  it('waits for the clear', async () => {
    let done = false;
    store.clearReadCache = vi.fn(() => new Promise((r) => setTimeout(() => { done = true; r(true); }, 20)));
    await clearOfflineReadCache();
    expect(done).toBe(true);
  });

  it('gives up after the bound when IndexedDB hangs, and never throws', async () => {
    store.clearReadCache = vi.fn(() => new Promise(() => {}));
    const t = Date.now();
    await clearOfflineReadCache(50);
    expect(Date.now() - t).toBeLessThan(1000);
    store.clearReadCache = vi.fn(() => Promise.reject(new Error('blocked')));
    await expect(clearOfflineReadCache(50)).resolves.toBeUndefined();
  });
});
