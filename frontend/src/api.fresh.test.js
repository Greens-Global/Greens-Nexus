// 10/23 Accounting meeting, item 13 (Neil: "sync should be table level and not
// just overall"): a table's Sync wraps its reads in withFreshReads, and every
// GET started inside - until the read settles - carries fresh=1, so the
// backend skips its short accounting cache. Nothing else is touched: plain
// reads and writes go out as before.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./msalInstance', () => ({ msalInstance: {}, msalReady: Promise.resolve() }));
vi.mock('./authConfig', () => ({ apiTokenRequest: {}, loginRequest: {} }));
vi.mock('./bffAuth', () => ({ BFF_MODE: true, csrfToken: () => 'csrf', bffLogin: vi.fn() }));

import { api, withFreshReads } from './api';

const okFetch = () => vi.fn(async () => ({
  ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
  text: async () => '{"rows":[]}', json: async () => ({ rows: [] }),
}));
const urls = (f) => f.mock.calls.map(([u]) => String(u));

describe('withFreshReads', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('adds fresh=1 to the reads a Sync starts, and only to those', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await api.getAmaSummary(2026, 'ytd');
    await withFreshReads(() => api.getAmaSummary(2026, 'ytd'));
    await api.getAmaSummary(2026, 'ytd');
    const [plain, fresh, after] = urls(f);
    expect(plain).not.toContain('fresh=');
    expect(fresh).toMatch(/[?&]fresh=1(&|$)/);
    expect(after).not.toContain('fresh=');
  });

  it('keeps fresh on for a read made in several steps, until it settles', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await withFreshReads(async () => {
      await api.getAmaSummary(2026, 'ytd');
      await api.getAccountingLocations();
    });
    expect(urls(f).every((u) => /[?&]fresh=1/.test(u))).toBe(true);
  });

  it('never marks a write', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    await withFreshReads(() => api.deleteAmaAgreement('A1'));
    expect(urls(f)[0]).not.toContain('fresh=');
  });

  it('a read that throws at once still ends the fresh window', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    expect(() => withFreshReads(() => { throw new Error('x'); })).toThrow('x');
    await api.getAmaSummary(2026, 'ytd');
    expect(urls(f)[0]).not.toContain('fresh=');
  });
});
