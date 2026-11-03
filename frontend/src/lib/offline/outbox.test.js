import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// ONE outbox for field changes (Neil, 11/03/2026) - the punch queue's rules
// made general: saved on the phone BEFORE it is sent, an id made on the phone
// sent as the idempotency key on every try, retry with backoff while the
// outcome is unknown, park with no signal or on a 401 and replay on online /
// visibility / sign-in, a 409 kept for Keep Mine / Use Theirs, any other 4xx
// failed with the server's words, order kept per group, dependencies waited
// on, photos uploaded once, caps, and only ever the signed-in person's.
vi.mock('../../msalInstance', () => ({ msalInstance: { getActiveAccount: () => null, getAllAccounts: () => [] }, msalReady: Promise.resolve() }));
vi.mock('../../api', () => ({ getActAsSessionId: () => null }));
vi.mock('./kinds', () => ({ loadKind: async () => false }));

const idb = await import('./idb');
const ob = await import('./outbox');
const store = await import('./store');
const status = await import('./status');
const { _setIdentity } = await import('./identity');

let online = true;
const netErr = () => Object.assign(new Error("Can't reach Nexus right now."), { isNetworkError: true });
const httpErr = (status, message = `HTTP ${status}`, body) => Object.assign(new Error(message), { status, body });
const disk = async (id) => idb.get('outbox', id);
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  idb._resetDb();
  ob._resetOutbox();
  status._resetStatus();
  online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  _setIdentity({ email: 'crew@greensglobal.com' });
});
afterEach(() => { ob._resetOutbox(); _setIdentity(undefined); vi.useRealTimers(); });

describe('outbox', () => {
  it('saves the change on the phone before it is sent, then sends it once with its idempotency key', async () => {
    const seen = [];
    let onDiskWhenSent = null;
    ob.registerKind('test:note', {
      send: async (entry, ctx) => { onDiskWhenSent = await disk(entry.id); seen.push(ctx.headers['Idempotency-Key']); return { id: 'n1' }; },
    });
    const e = await ob.enqueue({ kind: 'test:note', payload: { text: 'gate stuck' }, label: 'Note' });
    await ob.flush();
    expect(onDiskWhenSent).toBeTruthy();
    expect(seen).toEqual([e.id]);
    const after = await ob.getEntry(e.id);
    expect(after.state).toBe('sent');
    expect(after.result).toEqual({ id: 'n1' });
    expect(status.getStatus().waiting).toBe(0);
  });

  it('no answer: retries with backoff using the SAME key, then sends when it can', async () => {
    const keys = [];
    const send = vi.fn(async (entry, ctx) => { keys.push(ctx.idempotencyKey); if (keys.length < 3) throw netErr(); return 'ok'; });
    ob.registerKind('test:retry', { send });
    const e = await ob.enqueue({ kind: 'test:retry', payload: {} });
    await ob.flush();
    let now = await ob.getEntry(e.id);
    expect(now.state).toBe('pending');
    expect(now.attempts).toBe(1);
    expect(now.nextAt).toBeGreaterThan(Date.now());
    await ob.flush();                     // inside the backoff: nothing goes
    expect(send).toHaveBeenCalledTimes(1);
    await ob.flush({ manual: true });     // Sync Now
    await ob.flush({ manual: true });
    now = await ob.getEntry(e.id);
    expect(now.state).toBe('sent');
    expect(new Set(keys)).toEqual(new Set([e.id]));
  });

  it('a 5xx and a 429 are "unknown" too; after enough tries it parks until something changes', async () => {
    ob.registerKind('test:5xx', { send: async () => { throw httpErr(503); } });
    const e = await ob.enqueue({ kind: 'test:5xx', payload: {} });
    await ob.flush();
    for (let i = 0; i < 6; i++) await ob.flush({ manual: true });
    const now = await ob.getEntry(e.id);
    expect(now.state).toBe('parked');
    expect(ob.classify(httpErr(429))).toBe('unknown');
    expect(ob.classify(httpErr(500))).toBe('unknown');
    expect(ob.classify(netErr())).toBe('unknown');
  });

  it('with no signal it parks without trying, and the online event replays it', async () => {
    const send = vi.fn().mockResolvedValue('ok');
    ob.registerKind('test:offline', { send });
    online = false;
    await ob.startOutbox();
    const e = await ob.enqueue({ kind: 'test:offline', payload: {} });
    await ob.flush();
    expect((await ob.getEntry(e.id)).state).toBe('parked');
    expect(send).not.toHaveBeenCalled();
    expect(status.getStatus().waiting).toBe(1);
    online = true;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(async () => expect((await ob.getEntry(e.id)).state).toBe('sent'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('becoming visible replays a parked change too', async () => {
    let fail = true;
    ob.registerKind('test:vis', { send: async () => { if (fail) throw httpErr(502); return 'ok'; } });
    await ob.startOutbox();
    const e = await ob.enqueue({ kind: 'test:vis', payload: {} });
    await ob.flush();
    for (let i = 0; i < 6; i++) await ob.flush({ manual: true });
    expect((await ob.getEntry(e.id)).state).toBe('parked');
    fail = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(async () => expect((await ob.getEntry(e.id)).state).toBe('sent'));
  });

  it('a 401 parks everything, says signed out, and the sign-in sends it', async () => {
    let signedIn = false;
    const send = vi.fn(async () => { if (!signedIn) throw httpErr(401, 'Not signed in'); return 'ok'; });
    ob.registerKind('test:auth', { send });
    const a = await ob.enqueue({ kind: 'test:auth', payload: { n: 1 }, group: 'g1' });
    const b = await ob.enqueue({ kind: 'test:auth', payload: { n: 2 }, group: 'g2' });
    await ob.flush();
    // The first to go got the 401 and parked; a 401 stops the flush, so the
    // other was never tried.
    const states = [(await ob.getEntry(a.id)).state, (await ob.getEntry(b.id)).state].sort();
    expect(states).toEqual(['parked', 'pending']);
    expect(send.mock.calls.every(([entry]) => entry.id === send.mock.calls[0][0].id)).toBe(true);
    expect(status.getStatus().signedOut).toBe(true);
    signedIn = true;
    await ob.afterSignIn();
    await vi.waitFor(async () => expect((await ob.getEntry(b.id)).state).toBe('sent'));
    expect((await ob.getEntry(a.id)).state).toBe('sent');
    expect(status.getStatus().signedOut).toBe(false);
  });

  it('a 409 keeps the server value for the person: Keep Mine resends (rebased), Use Theirs drops it', async () => {
    const sent = [];
    let conflict = true;
    const useTheirs = vi.fn();
    ob.registerKind('test:conflict', {
      send: async (entry) => { sent.push(entry.payload); if (conflict) throw httpErr(409, 'Changed since you read it', { current: { notes: 'theirs' }, rev: 7 }); return 'ok'; },
      rebase: (payload, server) => ({ ...payload, rev: server.rev }),
      useTheirs,
    });
    const mine = await ob.enqueue({ kind: 'test:conflict', payload: { notes: 'mine', rev: 6 }, group: 'a' });
    const drop = await ob.enqueue({ kind: 'test:conflict', payload: { notes: 'mine too', rev: 6 }, group: 'b' });
    await ob.flush();
    const c = await ob.getEntry(mine.id);
    expect(c.state).toBe('conflict');
    expect(c.server).toEqual({ current: { notes: 'theirs' }, rev: 7 });
    expect(c.error).toBe('Changed since you read it');
    expect(status.getStatus().conflicts).toBe(2);
    conflict = false;
    await ob.resolveConflict(mine.id, 'mine');
    await vi.waitFor(async () => expect((await ob.getEntry(mine.id)).state).toBe('sent'));
    expect(sent.at(-1)).toEqual({ notes: 'mine', rev: 7 });
    await ob.resolveConflict(drop.id, 'theirs');
    expect(await ob.getEntry(drop.id)).toBeNull();
    expect(useTheirs).toHaveBeenCalledWith(expect.objectContaining({ id: drop.id }), { current: { notes: 'theirs' }, rev: 7 });
  });

  it('any other 4xx is an answer: failed with the server words, never resent by itself; Retry sends again', async () => {
    let refuse = true;
    const send = vi.fn(async () => { if (refuse) throw httpErr(422, 'Odometer: must be a number'); return 'ok'; });
    ob.registerKind('test:422', { send });
    const e = await ob.enqueue({ kind: 'test:422', payload: {} });
    await ob.flush();
    await ob.flush({ manual: true });
    const f = await ob.getEntry(e.id);
    expect(f.state).toBe('failed');
    expect(f.error).toBe('Odometer: must be a number');
    expect(send).toHaveBeenCalledTimes(1);
    refuse = false;
    await ob.retryEntry(e.id);
    await vi.waitFor(async () => expect((await ob.getEntry(e.id)).state).toBe('sent'));
  });

  it('keeps the order within a group: a later change waits while an earlier one cannot go', async () => {
    const order = [];
    let down = true;
    ob.registerKind('test:order', { send: async (entry) => { if (down && entry.payload.n === 1) throw netErr(); order.push(entry.payload.n); return entry.payload.n; } });
    await ob.enqueue({ kind: 'test:order', payload: { n: 1 } });
    await ob.enqueue({ kind: 'test:order', payload: { n: 2 } });
    await ob.flush();
    expect(order).toEqual([]);
    down = false;
    await ob.flush({ manual: true });
    expect(order).toEqual([1, 2]);
  });

  it('waits on a dependency and hands its result on (a log before the photo on it)', async () => {
    let logUp = false;
    ob.registerKind('test:log', { send: async () => { if (!logUp) throw netErr(); return { id: 'log-9' }; } });
    const photoSend = vi.fn(async (entry, ctx) => ({ on: ctx.result(entry.after[0]).id }));
    ob.registerKind('test:photo', { send: photoSend });
    const log = await ob.enqueue({ kind: 'test:log', payload: {} });
    const photo = await ob.enqueue({ kind: 'test:photo', payload: {}, after: [log.id] });
    await ob.flush();
    expect(photoSend).not.toHaveBeenCalled();
    logUp = true;
    await ob.flush({ manual: true });
    expect((await ob.getEntry(photo.id)).result).toEqual({ on: 'log-9' });
  });

  it('a dependency that was discarded fails the change that needed it', async () => {
    ob.registerKind('test:dep', { send: async () => { throw netErr(); } });
    ob.registerKind('test:child', { send: async () => 'ok' });
    const parent = await ob.enqueue({ kind: 'test:dep', payload: {} });
    const child = await ob.enqueue({ kind: 'test:child', payload: {}, after: [parent.id] });
    await ob.flush();
    expect(await ob.discardEntry(parent.id)).toBe(true);
    await ob.flush({ manual: true });
    expect((await ob.getEntry(child.id)).state).toBe('failed');
  });

  it('uploads each photo once even when the send after it has to be retried, and frees the photos once sent', async () => {
    const upload = vi.fn(async (file) => `https://store/${file.name}`);
    let tries = 0;
    ob.registerKind('test:upload', {
      send: async (entry, ctx) => {
        const url = await ctx.uploadOnce(entry.blobs[0], upload);
        tries += 1;
        if (tries === 1) throw netErr();
        return { url };
      },
    });
    const photo = new File([new Uint8Array(50)], 'gate.jpg', { type: 'image/jpeg' });
    const e = await ob.enqueue({ kind: 'test:upload', payload: {}, blobs: [photo] });
    await ob.flush();
    await ob.flush({ manual: true });
    expect(upload).toHaveBeenCalledTimes(1);
    const done = await ob.getEntry(e.id);
    expect(done.result).toEqual({ url: 'https://store/gate.jpg' });
    expect(await store.getBlob(done.blobs[0])).toBeNull();
  });

  it('the same id queued twice is one change', async () => {
    ob.registerKind('test:dup', { send: async () => 'ok' });
    online = false;
    const a = await ob.enqueue({ kind: 'test:dup', payload: {}, id: 'entry-key-1' });
    const b = await ob.enqueue({ kind: 'test:dup', payload: {}, id: 'entry-key-1' });
    expect(a.id).toBe(b.id);
    expect((await ob.listEntries()).length).toBe(1);
  });

  it('refuses past the caps with a clear notice, and keeps what is already there', async () => {
    ob.registerKind('test:cap', { send: async () => 'ok' });
    const big = { size: store.MAX_BLOB_BYTES + 1, type: 'image/jpeg', name: 'x.jpg' };
    const err = await ob.enqueue({ kind: 'test:cap', payload: {}, blobs: [big] }).catch((e) => e);
    expect(err.code).toBe('blobs-full');
    expect(err.message).toMatch(/Send what is waiting when you have signal/);
    expect(await ob.listEntries()).toEqual([]);
  });

  it("only the signed-in person's changes are listed or sent", async () => {
    const send = vi.fn().mockResolvedValue('ok');
    ob.registerKind('test:owner', { send });
    online = false;
    const mine = await ob.enqueue({ kind: 'test:owner', payload: {} });
    _setIdentity({ email: 'other@greensglobal.com' });
    online = true;
    expect(await ob.listEntries()).toEqual([]);
    await ob.flush({ manual: true });
    expect(send).not.toHaveBeenCalled();
    _setIdentity({ email: 'crew@greensglobal.com' });
    await ob.flush({ manual: true });
    expect((await ob.getEntry(mine.id)).state).toBe('sent');
  });

  it('nobody signed in: nothing can be queued', async () => {
    _setIdentity(null);
    await expect(ob.enqueue({ kind: 'x', payload: {} })).rejects.toMatchObject({ code: 'signed-out' });
  });

  it('Discard throws a waiting change and its photos away', async () => {
    ob.registerKind('test:discard', { send: async () => 'ok' });
    online = false;
    const photo = new File([new Uint8Array(5)], 'a.jpg', { type: 'image/jpeg' });
    const e = await ob.enqueue({ kind: 'test:discard', payload: {}, blobs: [photo] });
    const blob = e.blobs[0];
    expect(await ob.discardEntry(e.id)).toBe(true);
    expect(await ob.getEntry(e.id)).toBeNull();
    expect(await store.getBlob(blob)).toBeNull();
  });

  it('a send cut off mid-way (a closed tab) goes again on the next flush', async () => {
    ob.registerKind('test:cut', { send: async () => 'ok' });
    online = false;
    const e = await ob.enqueue({ kind: 'test:cut', payload: {} });
    await idb.put('outbox', { ...(await disk(e.id)), state: 'sending' });
    ob._resetOutbox();
    ob.registerKind('test:cut', { send: async () => 'ok' });
    online = true;
    await ob.flush();
    expect((await ob.getEntry(e.id)).state).toBe('sent');
    await tick();
  });
});
