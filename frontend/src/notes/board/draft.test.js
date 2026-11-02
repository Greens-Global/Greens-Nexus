import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveDraft, loadDraft, clearDraft, DB_NAME, STORE } from './draft';

// jsdom has no IndexedDB. This is the smallest stand-in for what draft.js
// uses: open (with the upgrade), one object store keyed on `id`, get / put /
// delete requests that answer on the next tick.
function memoryIndexedDB() {
  const dbs = new Map();
  const request = (run) => {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    setTimeout(() => {
      try { req.result = run(); req.onsuccess?.({ target: req }); } catch (e) { req.error = e; req.onerror?.({ target: req }); }
    }, 0);
    return req;
  };
  const makeDb = (name) => {
    const stores = new Map();
    return {
      name,
      objectStoreNames: { contains: (s) => stores.has(s) },
      createObjectStore: (s, { keyPath }) => { stores.set(s, { keyPath, rows: new Map() }); },
      transaction: () => ({
        objectStore: (n) => {
          const st = stores.get(n);
          if (!st) throw new Error(`no store ${n}`);
          return {
            get: (k) => request(() => st.rows.get(k)),
            put: (v) => request(() => { st.rows.set(v[st.keyPath], v); return v[st.keyPath]; }),
            delete: (k) => request(() => { st.rows.delete(k); }),
          };
        },
      }),
      close() {},
      _stores: stores,
    };
  };
  return {
    open(name, version) {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined };
      setTimeout(() => {
        let db = dbs.get(name);
        if (!db) { db = makeDb(name); dbs.set(name, db); req.result = db; req.onupgradeneeded?.({ target: req, oldVersion: 0, newVersion: version }); }
        req.result = db;
        req.onsuccess?.({ target: req });
      }, 0);
      return req;
    },
    _dbs: dbs,
  };
}

describe('draft - the drawing in progress, kept in this browser', () => {
  let idb;
  beforeEach(() => { idb = memoryIndexedDB(); globalThis.indexedDB = idb; });
  afterEach(() => { delete globalThis.indexedDB; });

  it('saves a draft per note with its rev and the time, and loads it back', async () => {
    const before = Date.now();
    expect(await saveDraft('note_1', '{"type":"nexus-board"}', { rev: 4 })).toBe(true);
    const d = await loadDraft('note_1');
    expect(d.scene).toBe('{"type":"nexus-board"}');
    expect(d.rev).toBe(4);
    expect(d.at).toBeGreaterThanOrEqual(before);
    expect(await loadDraft('note_2')).toBeNull();
    expect(idb._dbs.get(DB_NAME)._stores.has(STORE)).toBe(true);
  });

  it('a later save replaces the draft; clear removes it', async () => {
    await saveDraft('note_1', 'a', { rev: 1 });
    await saveDraft('note_1', 'b', { rev: 2 });
    expect((await loadDraft('note_1')).scene).toBe('b');
    await clearDraft('note_1');
    expect(await loadDraft('note_1')).toBeNull();
    await expect(clearDraft('note_1')).resolves.toBeUndefined();   // clearing nothing is fine
  });

  it('never throws without IndexedDB or when it misbehaves', async () => {
    delete globalThis.indexedDB;
    expect(await saveDraft('note_1', 'a', { rev: 1 })).toBe(false);
    expect(await loadDraft('note_1')).toBeNull();
    await expect(clearDraft('note_1')).resolves.toBeUndefined();
    globalThis.indexedDB = { open() { throw new Error('blocked'); } };
    expect(await saveDraft('note_1', 'a', { rev: 1 })).toBe(false);
    expect(await loadDraft('note_1')).toBeNull();
    globalThis.indexedDB = { open() { const r = {}; setTimeout(() => r.onerror?.({ target: r }), 0); return r; } };
    expect(await loadDraft('note_1')).toBeNull();
  });

  it('refuses what is not a draft: no note id, no scene, a scene too large to be worth keeping', async () => {
    expect(await saveDraft('', 'a', { rev: 1 })).toBe(false);
    expect(await saveDraft('note_1', '', { rev: 1 })).toBe(false);
    expect(await saveDraft('note_1', 'x'.repeat(8_000_001), { rev: 1 })).toBe(false);
    expect(await loadDraft('')).toBeNull();
  });
});
