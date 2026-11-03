// The one IndexedDB database behind field offline (Neil, 11/03/2026;
// docs/Offline.md). Hand-written, idb-keyval sized: open once, then a
// promise per request. Four object stores:
//   cache  - named datasets the field reads offline (store.js readThrough)
//   blobs  - photos and files waiting to upload (store.js putBlob)
//   outbox - every change waiting to send (outbox.js)
//   meta   - small facts (the last signed-in identity)
//
// Every caller treats a rejection as "no offline here" (a private window,
// blocked site data, an old browser): the screen still works online, it just
// cannot keep anything on the phone.
const DB_NAME = 'nexus-offline';
const DB_VERSION = 1;
export const STORES = ['cache', 'blobs', 'outbox', 'meta'];

let opening = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });
}

export function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    let r;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB is not available here');
      r = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) { reject(e); return; }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : name === 'cache' ? 'key' : 'id' });
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another tab upgraded the database (a newer build): let it, and open
      // again next time instead of blocking it.
      db.onversionchange = () => { try { db.close(); } catch { /* closed */ } opening = null; };
      resolve(db);
    };
    r.onerror = () => reject(r.error || new Error('IndexedDB did not open'));
    r.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).catch((e) => { opening = null; throw e; });
  return opening;
}

/** Run `fn(store)` in one transaction; resolves with fn's value once the
 *  transaction has committed (so a write is on disk before we go on). */
export async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let out;
    let t;
    try { t = db.transaction(storeName, mode); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    try {
      const store = t.objectStore(storeName);
      Promise.resolve(fn(store)).then((v) => { out = v; }, (e) => { try { t.abort(); } catch { /* done */ } reject(e); });
    } catch (e) { try { t.abort(); } catch { /* done */ } reject(e); }
  });
}

export const get = (s, key) => tx(s, 'readonly', (st) => req(st.get(key)));
export const getAll = (s) => tx(s, 'readonly', (st) => req(st.getAll()));
export const put = (s, value) => tx(s, 'readwrite', (st) => req(st.put(value)));
export const del = (s, key) => tx(s, 'readwrite', (st) => req(st.delete(key)));
export const clear = (s) => tx(s, 'readwrite', (st) => req(st.clear()));

/** Test seam: forget the open connection (fake-indexeddb is reset per test). */
export function _resetDb() {
  if (opening) opening.then((db) => { try { db.close(); } catch { /* closed */ } }).catch(() => {});
  opening = null;
}
