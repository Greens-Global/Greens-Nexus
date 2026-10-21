import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The save queue: one request per burst of edits, rows only; a transient
// failure keeps the batch under whatever came next; a 4xx drops it and says so;
// a conflict re-pulls and tells the app.
const calls = { save: [], get: 0 };
let saveImpl = async () => ({ ok: true, _ts: 5, conflicts: [] });
vi.mock('../../api.js', () => ({ api: {
  saveAssetChanges: (ops) => { calls.save.push(ops); return saveImpl(ops); },
  getPropertyWorkspace: async () => { calls.get += 1; return { properties: [{ id: 'a', name: 'server' }], logs: [], _ts: 9 }; },
  getPropertyWorkspaceTs: async () => ({ _ts: 9 }),
} }));

describe('sync queue', () => {
  let sync;
  beforeEach(async () => {
    vi.useFakeTimers();
    calls.save = []; calls.get = 0;
    saveImpl = async () => ({ ok: true, _ts: 5, conflicts: [] });
    sync = await import('./sync.js');
    sync._resetQueue();
  });
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of edits into one request of changed rows', async () => {
    sync.queueOps({ properties: { upsert: [{ id: 'a', name: 'A1' }], delete: [] } });
    sync.queueOps({ properties: { upsert: [{ id: 'a', name: 'A2' }], delete: [] }, logs: { append: [{ id: 'l1' }] } });
    expect(sync.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.save).toHaveLength(1);
    expect(calls.save[0].properties.upsert).toEqual([{ id: 'a', name: 'A2' }]);
    expect(calls.save[0].logs.append).toEqual([{ id: 'l1' }]);
    expect(sync.hasPending()).toBe(false);
    expect(sync.getLastTs()).toBe(5);
  });

  it('hands the store the revs every written row now carries', async () => {
    saveImpl = async () => ({ ok: true, _ts: 5, conflicts: [], revs: { a: '2026-10-21T10:00:00Z' } });
    const got = [];
    sync.setRevHandler((revs) => got.push(revs));
    sync.queueOps({ properties: { upsert: [{ id: 'a', name: 'A', _rev: 'old' }], delete: [] } });
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(10);
    expect(got).toEqual([{ a: '2026-10-21T10:00:00Z' }]);
    sync.setRevHandler(null);
  });

  it('keeps the batch on a network failure and folds later edits into it', async () => {
    saveImpl = async () => { const e = new Error('net'); e.status = 0; throw e; };
    sync.queueOps({ properties: { upsert: [{ id: 'a', name: 'A1' }], delete: [] } });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.save).toHaveLength(1);
    sync.queueOps({ warranties: { upsert: [{ id: 'w1', propertyId: 'a' }], delete: [] } });
    saveImpl = async () => ({ ok: true, _ts: 6, conflicts: [] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.save).toHaveLength(2);
    expect(calls.save[1].properties.upsert).toEqual([{ id: 'a', name: 'A1' }]);
    expect(calls.save[1].warranties.upsert).toHaveLength(1);
    expect(sync.hasPending()).toBe(false);
  });

  it('drops a batch the server refuses and raises the save-failed event', async () => {
    saveImpl = async () => { const e = new Error('outside your access'); e.status = 403; throw e; };
    const seen = [];
    window.addEventListener('nexus:asset-save-failed', (e) => seen.push(e.detail));
    sync.queueOps({ properties: { upsert: [{ id: 'home', name: 'X' }], delete: [] } });
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe(403);
    expect(sync.hasPending()).toBe(false);
  });

  it('re-pulls and tells the app when the server kept someone else\'s row', async () => {
    saveImpl = async () => ({ ok: true, _ts: 7, conflicts: ['a'] });
    const applied = [];
    const stop = sync.wireBackgroundSync((ws) => applied.push(ws));
    const seen = [];
    window.addEventListener('nexus:asset-save-conflict', (e) => seen.push(e.detail.ids));
    sync.queueOps({ properties: { upsert: [{ id: 'a', name: 'mine', _rev: 'old' }], delete: [] } });
    await vi.advanceTimersByTimeAsync(900);
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toEqual([['a']]);
    expect(calls.get).toBe(1);
    expect(applied[0].properties[0].name).toBe('server');
    stop();
  });
});
