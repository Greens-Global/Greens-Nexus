// 11/18 (Urmi: Browse "works well, then after three / four attempts it again
// works slow"): warm-ups never pile up behind the folder a person asked for.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const pending = [];
vi.mock('../api', () => ({
  api: {
    egnyteFolder: vi.fn((path) => new Promise((resolve) => pending.push({ path, resolve }))),
  },
}));

import { api } from '../api';
import { _pendingPrefetch, getFolderCached, prefetchChildren } from './lib';

const listing = (base, n) => ({ folders: Array.from({ length: n }, (_v, i) => ({ path: `${base}/F${i}` })), files: [] });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Egnyte folder warm-ups', () => {
  beforeEach(() => { pending.length = 0; api.egnyteFolder.mockClear(); });

  it('a new listing replaces the waiting warm-ups, and warms only a few', async () => {
    const asked = getFolderCached('/Shared/A');          // a folder being opened
    prefetchChildren(listing('/Shared/A', 30));
    expect(_pendingPrefetch()).toHaveLength(8);
    prefetchChildren(listing('/Shared/B', 3));
    expect(_pendingPrefetch()).toEqual(['/Shared/B/F0', '/Shared/B/F1', '/Shared/B/F2']);
    // Nothing is warmed while the folder the person asked for is loading.
    expect(api.egnyteFolder).toHaveBeenCalledTimes(1);
    pending[0].resolve({ folders: [], files: [] });
    await asked;
    await flush();
    expect(api.egnyteFolder).toHaveBeenCalledTimes(3);   // two at a time
  });
});
