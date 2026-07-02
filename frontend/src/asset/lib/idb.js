// Thin IndexedDB key/value wrapper used as a second, larger-quota persistence tier alongside
// localStorage. Why this exists: localStorage has a ~5MB quota, and Nexus state (base64 asset
// images included) can exceed that. A blown quota makes `localStorage.setItem` throw — if that
// throw is swallowed (as it is, deliberately, at the call sites) edits silently fail to persist.
// IndexedDB has a much higher quota, so it's used as the durable store; localStorage is kept
// only as a fast-path/fallback read on boot. See sync.js for how the two are reconciled on load.
//
// Every function here is defensive: any failure (IndexedDB unavailable, blocked, private
// browsing, transaction error) resolves to `null`/`undefined` instead of rejecting, so callers
// never need try/catch — a missing IndexedDB just degrades to "no cached value".

const DB_NAME = 'nexus_store';
const STORE_NAME = 'kv';
const OPEN_TIMEOUT_MS = 2500;

/** Cached DB-open promise (module singleton) so we only open the connection once. */
let _dbPromise;

/**
 * Opens (or returns the cached open promise for) the single IndexedDB database used for
 * persistence. Resolves to `null` — never rejects — if IndexedDB is unavailable, blocked,
 * errors, or doesn't respond within `OPEN_TIMEOUT_MS` (e.g. a hung `onblocked` from another
 * open tab holding a version-change lock).
 */
export function idbDB() {
  if (_dbPromise !== undefined) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const timeout = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          req.result.createObjectStore(STORE_NAME);
        } catch (e) {
          // store already exists or creation failed — onsuccess/onerror below still fires
        }
      };
      req.onsuccess = () => {
        clearTimeout(timeout);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timeout);
        resolve(null);
      };
      req.onblocked = () => {
        clearTimeout(timeout);
        resolve(null);
      };
    } catch (e) {
      resolve(null);
    }
  });
  return _dbPromise;
}

/** Read a value by key. Resolves to `null` if the DB is unavailable, the key is missing, or on any error. */
export function idbGet(key) {
  return idbDB()
    .then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
          req.onsuccess = () => resolve(req.result == null ? null : req.result);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    })
    .catch(() => null);
}

/** Write a value by key. Resolves (no return value) once the write transaction completes, aborts, or errors — never rejects. */
export function idbSet(key, value) {
  return idbDB()
    .then((db) => {
      if (!db) return;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    })
    .catch(() => {});
}
