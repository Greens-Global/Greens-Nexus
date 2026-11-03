import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// The phone's read cache and blobs (field offline, Neil 11/03/2026):
// readThrough asks the server with signal and saves the answer, answers from
// the phone with none (or when the request got no answer), never covers a
// refusal; every saved dataset is the signed-in person's alone and is cleared
// when the person changes; blobs are capped.
vi.mock('../../msalInstance', () => ({ msalInstance: { getActiveAccount: () => null, getAllAccounts: () => [] }, msalReady: Promise.resolve() }));
vi.mock('../../api', () => ({ getActAsSessionId: () => null }));

const idb = await import('./idb');
const store = await import('./store');
const { _setIdentity } = await import('./identity');

let online = true;
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  idb._resetDb();
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  _setIdentity({ email: 'crew@greensglobal.com' });
});
afterEach(() => { _setIdentity(undefined); });

const flushDisk = () => new Promise((r) => setTimeout(r, 20));

describe('readThrough', () => {
  it('online: asks the server and keeps the answer for later', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 'f1' }]);
    expect(await store.readThrough('forms:mine', fetcher)).toEqual([{ id: 'f1' }]);
    await flushDisk();
    expect((await store.getCached('forms:mine')).data).toEqual([{ id: 'f1' }]);
  });

  it('no signal: answers from the phone without asking, and says when it was saved', async () => {
    await store.putCached('forms:mine', [{ id: 'f1' }]);
    online = false;
    const fetcher = vi.fn();
    const onCache = vi.fn();
    expect(await store.readThrough('forms:mine', fetcher, { onCache })).toEqual([{ id: 'f1' }]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(onCache).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-/));
  });

  it('a request that got no answer falls back to the phone; a refusal is never covered up', async () => {
    await store.putCached('forms:mine', ['kept']);
    const dropped = Object.assign(new Error("Can't reach Nexus right now."), { isNetworkError: true });
    expect(await store.readThrough('forms:mine', () => Promise.reject(dropped))).toEqual(['kept']);
    const refused = Object.assign(new Error('Forbidden'), { status: 403 });
    await expect(store.readThrough('forms:mine', () => Promise.reject(refused))).rejects.toBe(refused);
  });

  it('offline with nothing saved: a clear error, flagged as a network error for the screen', async () => {
    online = false;
    const err = await store.readThrough('forms:none', vi.fn()).catch((e) => e);
    expect(err).toBeInstanceOf(store.OfflineError);
    expect(err.code).toBe('not-cached');
    expect(err.isNetworkError).toBe(true);
    expect(err.message).toMatch(/offline/);
  });

  it("another person never reads what this one saved, and nobody signed in reads nothing", async () => {
    await store.putCached('construction:my-jobs', ['mine']);
    _setIdentity({ email: 'other@greensglobal.com' });
    expect(await store.getCached('construction:my-jobs')).toBeNull();
    _setIdentity({ email: 'crew@greensglobal.com', actAs: 'session-1' });
    expect(await store.getCached('construction:my-jobs')).toBeNull();   // Act As is another identity
    _setIdentity(null);
    expect(await store.getCached('construction:my-jobs')).toBeNull();
    expect(await store.putCached('x', 1)).toBe(false);
  });

  it('a different person signing in clears the whole read cache; the same person keeps it', async () => {
    await store.checkIdentity();
    await store.putCached('tasks:today', ['t']);
    await store.checkIdentity();
    expect(await store.getCached('tasks:today')).not.toBeNull();
    _setIdentity({ email: 'next@greensglobal.com' });
    await store.checkIdentity();
    _setIdentity({ email: 'crew@greensglobal.com' });
    expect(await store.getCached('tasks:today')).toBeNull();
  });

  it('with no IndexedDB at all the screen still reads online', async () => {
    delete globalThis.indexedDB;
    idb._resetDb();
    expect(await store.readThrough('forms:mine', () => Promise.resolve(['live']))).toEqual(['live']);
    expect(await store.getCached('forms:mine')).toBeNull();
  });
});

describe('blobs', () => {
  const file = (bytes, name = 'p.jpg') => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });

  it('a photo goes on the phone and comes back with its name and type', async () => {
    const id = await store.putBlob(file(1000), { ref: 'draft:k1' });
    const back = await store.getBlob(id);
    expect(back.size).toBe(1000);
    expect(back.type).toBe('image/jpeg');
    expect(back.name).toBe('p.jpg');
    expect(store.blobIdOf(store.blobRef(id))).toBe(id);
  });

  it('refuses past the caps with words a person can act on', async () => {
    const big = { size: store.MAX_ONE_BLOB_BYTES + 1, type: 'video/mp4', name: 'clip.mp4' };
    await expect(store.putBlob(big)).rejects.toMatchObject({ code: 'blob-too-big' });
    const spy = vi.spyOn(idb, 'getAll').mockResolvedValueOnce([{ size: store.MAX_BLOB_BYTES - 10, identity: 'crew@greensglobal.com|' }]);
    const err = await store.putBlob(file(100)).catch((e) => e);
    expect(err.code).toBe('blobs-full');
    expect(err.message).toMatch(/Send what is waiting when you have signal/);
    spy.mockRestore();
  });

  it('the budget is per person: one crew member\'s backlog never blocks the next', async () => {
    const spy = vi.spyOn(idb, 'getAll').mockResolvedValue([{ size: store.MAX_BLOB_BYTES - 10, identity: 'other@greensglobal.com|' }]);
    expect(await store.blobBytes('crew@greensglobal.com|')).toBe(0);
    spy.mockRestore();
    expect(await store.putBlob(file(100))).toBeTruthy();
  });

  it('an uploaded blob remembers its URL on its own row', async () => {
    const id = await store.putBlob(file(10), { ref: 'outbox:e1' });
    expect(await store.blobUploadedUrl(id)).toBe('');
    await store.markBlobUploaded(id, 'https://up/a.jpg');
    expect(await store.blobUploadedUrl(id)).toBe('https://up/a.jpg');
  });

  it('outbox photos whose change is gone are swept; drafts and live entries are kept', async () => {
    const live = await store.putBlob(file(10), { ref: 'outbox:live' });
    const orphan = await store.putBlob(file(10), { ref: 'outbox:gone' });
    const draft = await store.putBlob(file(10), { ref: 'draft:k1' });
    await store.sweepOrphanOutboxBlobs(new Set(['live']));
    expect(await store.getBlob(live)).not.toBeNull();
    expect(await store.getBlob(orphan)).toBeNull();
    expect(await store.getBlob(draft)).not.toBeNull();
  });

  it('finds and swaps blob references anywhere in an answer tree', async () => {
    const answers = { photos: ['https://x/1.jpg', 'nexus-offline:a'], tires: [{ pic: 'nexus-offline:b' }], sig: 'nexus-offline:c' };
    expect(store.blobIdsIn(answers).sort()).toEqual(['a', 'b', 'c']);
    const out = await store.swapBlobRefs(answers, async (id) => `https://up/${id}.jpg`);
    expect(out).toEqual({ photos: ['https://x/1.jpg', 'https://up/a.jpg'], tires: [{ pic: 'https://up/b.jpg' }], sig: 'https://up/c.jpg' });
  });

  it('a discarded draft frees its photos; a queued entry adopts them', async () => {
    const a = await store.putBlob(file(10), { ref: 'draft:k1' });
    const b = await store.putBlob(file(10), { ref: 'draft:k2' });
    await store.adoptBlobs([b], 'outbox:k2');
    await store.deleteBlobsFor('draft:k1');
    await store.deleteBlobsFor('draft:k2');
    expect(await store.getBlob(a)).toBeNull();
    expect(await store.getBlob(b)).not.toBeNull();
  });
});
