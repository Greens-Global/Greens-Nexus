// A board's local draft (Neil, 11/02/2026): the drawing in progress, kept in
// this browser's IndexedDB per note id, so a save that never went out (the
// tab closed inside the save delay, offline, the API down, a crash) is
// offered back on the next open - "You have unsaved drawing from <when> -
// Restore / Discard" - and cleared when a save lands. IndexedDB, not
// localStorage: a scene can be 2 MB, and localStorage is ~5 MB for the whole
// origin (useNoteSync's draft keeps a scene only under 500 KB).
//
// Every access is guarded: a browser without IndexedDB (jsdom, a locked-down
// private window), a blocked open or a failing request means "no draft" and
// never an error on the board. A record is { id, scene, rev, at }: the
// serialized scene, the rev it was drawn over, and when.
export const DB_NAME = 'nexus-board-drafts';
export const STORE = 'drafts';
const VERSION = 1;
/** Beyond this a draft is not worth keeping (the API refuses 2 MB anyway). */
export const DRAFT_MAX = 8_000_000;
const OPEN_MS = 4000;

function openDb() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => done(null), OPEN_MS);
    try {
      const idb = globalThis.indexedDB;
      if (!idb) return done(null);
      const req = idb.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        try { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); } catch { /* the open fails next */ }
      };
      req.onsuccess = () => done(req.result || null);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch { done(null); }
  });
}

function run(db, mode, op) {
  return new Promise((resolve) => {
    try {
      const store = db.transaction(STORE, mode).objectStore(STORE);
      const req = op(store);
      req.onsuccess = () => resolve({ ok: true, value: req.result });
      req.onerror = () => resolve({ ok: false });
    } catch { resolve({ ok: false }); }
  }).finally(() => { try { db.close(); } catch { /* already closed */ } });
}

/** Keep the drawing as it is now. True when it was stored. */
export async function saveDraft(noteId, scene, { rev = 0 } = {}) {
  if (!noteId || typeof scene !== 'string' || !scene || scene.length > DRAFT_MAX) return false;
  const db = await openDb();
  if (!db) return false;
  const r = await run(db, 'readwrite', (s) => s.put({ id: noteId, scene, rev: Number(rev) || 0, at: Date.now() }));
  return r.ok;
}

/** The draft for a note: { scene, rev, at } or null. */
export async function loadDraft(noteId) {
  if (!noteId) return null;
  const db = await openDb();
  if (!db) return null;
  const r = await run(db, 'readonly', (s) => s.get(noteId));
  const v = r.ok ? r.value : null;
  if (!v || typeof v.scene !== 'string' || !v.scene) return null;
  return { scene: v.scene, rev: Number(v.rev) || 0, at: Number(v.at) || 0 };
}

export async function clearDraft(noteId) {
  if (!noteId) return;
  const db = await openDb();
  if (!db) return;
  await run(db, 'readwrite', (s) => s.delete(noteId));
}
