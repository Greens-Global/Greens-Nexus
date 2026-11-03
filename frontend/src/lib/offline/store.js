// What the phone keeps for field work offline (Neil, 11/03/2026; guide
// docs/Offline.md). Two things, both in the one IndexedDB database (idb.js):
//
//   (a) a READ CACHE of named datasets the field needs - 'forms:mine',
//       'forms:template:<id>', 'construction:my-jobs', 'tasks:today' - each
//       with the time it was saved and WHOSE it is (identity.js). A read for
//       another person finds nothing, and the whole cache is cleared on sign
//       out, on a different account signing in and on every Act As change
//       (watchIdentity below) - a shared crew tablet never shows one
//       person's data to the next.
//   (b) BLOBS - photos and files taken offline, waiting for the outbox to
//       upload them (outbox.js). Kept as ArrayBuffers (old iOS Safari lost
//       Blob values in IndexedDB), capped at MAX_BLOB_BYTES in total.
//
// readThrough(name, fetcher) is the one way a screen reads: online it asks
// the server (through api.js - its GET retries are the only retry layer) and
// saves the answer; with no signal, or when the request never got an answer,
// it hands back the saved copy. A refusal (403, 404) is never covered up by
// the cache. Everything is best effort: where IndexedDB is unavailable the
// screen behaves exactly as it did before offline existed.
import * as idb from './idb';
import { currentIdentity, identityKey } from './identity';

export const MAX_BLOB_BYTES = 200 * 1024 * 1024;     // every photo and file waiting, together
export const MAX_ONE_BLOB_BYTES = 100 * 1024 * 1024;  // the largest single file (a construction clip)
export const BLOB_PREFIX = 'nexus-offline:';          // how an answer points at a blob still on the phone
const CACHE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;       // a saved copy older than this is not shown

export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** An error the caller can show as is. `code` says which. */
export class OfflineError extends Error {
  constructor(message, code) { super(message); this.name = 'OfflineError'; this.code = code; this.isNetworkError = code === 'not-cached'; }
}

const MB = (n) => Math.round(n / 1024 / 1024);
const unanswered = (e) => !!e && (e.isNetworkError || !e.status);

// ── (a) The read cache ───────────────────────────────────────────────────────

const cacheKey = (name, who) => `${who}::${name}`;

/** The saved copy of `name` for the signed-in person: { data, savedAt } or null. */
export async function getCached(name) {
  const who = identityKey();
  if (!who) return null;
  try {
    const row = await idb.get('cache', cacheKey(name, who));
    if (!row || row.identity !== who) return null;
    if (Date.now() - Date.parse(row.savedAt || 0) > CACHE_MAX_AGE_MS) return null;
    return { data: row.data, savedAt: row.savedAt };
  } catch { return null; }
}

/** Save `data` as the signed-in person's copy of `name`. */
export async function putCached(name, data) {
  const who = identityKey();
  if (!who) return false;
  try {
    await idb.put('cache', { key: cacheKey(name, who), name, identity: who, data, savedAt: new Date().toISOString() });
    return true;
  } catch { return false; }
}

/**
 * Read `name` through the server when there is signal, else from the phone.
 *   readThrough('forms:mine', () => api.getFormsMine(), { onCache: (savedAt) => ... })
 * `onCache(savedAt)` is called when the answer came from the phone, so the
 * screen can say "Saved on this phone 11/03/2026 2:14 PM". With no signal and
 * nothing saved it throws an OfflineError ('not-cached'), which reads like
 * any network error to the screen.
 */
export async function readThrough(name, fetcher, { onCache } = {}) {
  const fromPhone = async (cause) => {
    const hit = await getCached(name);
    if (!hit) {
      if (cause) throw cause;
      throw new OfflineError('You are offline, and this is not saved on this phone yet.', 'not-cached');
    }
    try { onCache?.(hit.savedAt); } catch { /* the caller's note only */ }
    return hit.data;
  };
  // No signal at all: do not wait on a request that cannot go anywhere.
  if (isOffline()) return fromPhone(null);
  let data;
  try {
    data = await fetcher();
  } catch (e) {
    if (unanswered(e)) return fromPhone(e);
    throw e;                        // the server answered - the answer stands
  }
  putCached(name, data);            // not awaited: the screen never waits on the disk
  return data;
}

/** Forget every saved dataset (every person) - sign out, account switch, Act As. */
export async function clearReadCache() {
  try { await idb.clear('cache'); return true; } catch { return false; }
}

// ── (b) Blobs waiting to upload ──────────────────────────────────────────────

const newId = () => {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

async function toBuffer(blob) {
  if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('The file could not be read.'));
    r.readAsArrayBuffer(blob);
  });
}

/** Bytes the blobs on this phone take - one person's (the budget is per
 *  person, so one crew member's backlog never blocks the next), or all. */
export async function blobBytes(identity) {
  try {
    return (await idb.getAll('blobs'))
      .filter((b) => identity === undefined || b.identity === identity)
      .reduce((n, b) => n + (b.size || 0), 0);
  } catch { return 0; }
}

/**
 * Keep a photo or file on the phone until it can be uploaded. `ref` names
 * what holds it ('draft:<entryKey>' while a form is open, 'outbox:<id>' once
 * it is queued). Returns the blob id; `blobRef(id)` is the value an answer
 * carries in the meantime. Throws an OfflineError when it would not fit.
 */
export async function putBlob(blob, { ref = '', name = '' } = {}) {
  const size = blob?.size || 0;
  if (size > MAX_ONE_BLOB_BYTES) {
    throw new OfflineError(`That file is ${MB(size)} MB - the most this phone keeps for one file is ${MB(MAX_ONE_BLOB_BYTES)} MB.`, 'blob-too-big');
  }
  const used = await blobBytes(identityKey());
  if (used + size > MAX_BLOB_BYTES) {
    throw new OfflineError(`This phone is already holding ${MB(used)} MB of photos and files waiting to send (the limit is ${MB(MAX_BLOB_BYTES)} MB). Send what is waiting when you have signal, then try again.`, 'blobs-full');
  }
  const id = newId();
  const buf = await toBuffer(blob);
  await idb.put('blobs', {
    id, data: buf, size, type: blob.type || 'application/octet-stream', name: name || blob.name || 'file',
    ref, identity: identityKey(), createdAt: new Date().toISOString(),
  });
  askPersistent();
  return id;
}

/** The blob back as a File (name and type kept), or null. */
export async function getBlob(id) {
  try {
    const row = await idb.get('blobs', id);
    if (!row) return null;
    const opts = { type: row.type };
    try { return new File([row.data], row.name || 'file', opts); } catch { return new Blob([row.data], opts); }
  } catch { return null; }
}

export async function deleteBlob(id) { try { await idb.del('blobs', id); } catch { /* gone */ } }

/** The blob was uploaded to `url`: kept on its own row, so it is never
 *  uploaded twice (another try, another tab, the same photo queued again). */
export async function markBlobUploaded(id, url) {
  try {
    const row = await idb.get('blobs', id);
    if (row) await idb.put('blobs', { ...row, url });
  } catch { /* the entry's own note still has it */ }
}
export async function blobUploadedUrl(id) {
  try { return (await idb.get('blobs', id))?.url || ''; } catch { return ''; }
}

/** Outbox photos whose change is gone (a crash between steps, another
 *  identity's leftovers): `entryIds` is every entry on the phone. */
export async function sweepOrphanOutboxBlobs(entryIds) {
  try {
    for (const b of await idb.getAll('blobs')) {
      const ref = String(b.ref || '');
      if (ref.startsWith('outbox:') && !entryIds.has(ref.slice(7))) await idb.del('blobs', b.id);
    }
  } catch { /* best effort */ }
}

/** Point blobs at a new holder (a draft's photos becoming a queued entry's). */
export async function adoptBlobs(ids, ref) {
  for (const id of ids || []) {
    try {
      const row = await idb.get('blobs', id);
      if (row) await idb.put('blobs', { ...row, ref });
    } catch { /* a blob already gone is the outbox's problem to report */ }
  }
}

/** Delete every blob held by `ref` (a discarded draft). */
export async function deleteBlobsFor(ref) {
  try {
    const all = await idb.getAll('blobs');
    for (const b of all) if (b.ref === ref) await idb.del('blobs', b.id);
  } catch { /* nothing to free */ }
}

export const blobRef = (id) => `${BLOB_PREFIX}${id}`;
export const blobIdOf = (value) => (typeof value === 'string' && value.startsWith(BLOB_PREFIX) ? value.slice(BLOB_PREFIX.length) : '');

/** Every blob id an answer tree points at (photos inside repeat rows too). */
export function blobIdsIn(value, out = []) {
  if (typeof value === 'string') { const id = blobIdOf(value); if (id) out.push(id); }
  else if (Array.isArray(value)) value.forEach((v) => blobIdsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => blobIdsIn(v, out));
  return out;
}

/** A copy of `value` with every blob reference swapped by `swap(id)` (async). */
export async function swapBlobRefs(value, swap) {
  if (typeof value === 'string') { const id = blobIdOf(value); return id ? swap(id) : value; }
  if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await swapBlobRefs(v, swap)); return out; }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await swapBlobRefs(v, swap);
    return out;
  }
  return value;
}

/** Drafts' blobs nobody came back for (14 days), so the phone never fills up. */
export async function sweepBlobs(keepRefs = new Set(), maxAgeMs = 14 * 24 * 3600 * 1000) {
  try {
    const all = await idb.getAll('blobs');
    const now = Date.now();
    for (const b of all) {
      if (keepRefs.has(b.ref)) continue;
      if (String(b.ref || '').startsWith('outbox:')) continue;    // the outbox decides about its own
      if (now - Date.parse(b.createdAt || 0) > maxAgeMs) await idb.del('blobs', b.id);
    }
  } catch { /* best effort */ }
}

let askedPersist = false;
function askPersistent() {
  // Ask the browser not to evict what is waiting (an installed app usually
  // gets it without a prompt). Once per load; the answer does not matter.
  if (askedPersist) return;
  askedPersist = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* not offered */ }
}

// ── Whose data it is ─────────────────────────────────────────────────────────

/** Clear the read cache when the person changes. Called once at boot
 *  (status.js): a different account than last time -> clear; then on every
 *  sign out (MSAL LOGOUT_START) and every Act As start / stop (api.js fires
 *  'nexus:identity-change'). */
export async function checkIdentity() {
  const now = identityKey();
  // Nobody known yet (MSAL still loading its cache): decide nothing. A real
  // sign out is caught by LOGOUT_START, and a read with no identity finds
  // nothing anyway.
  if (!now) return now;
  try {
    const last = await idb.get('meta', 'identity');
    if (last && last.value !== now) await clearReadCache();
    await idb.put('meta', { key: 'identity', value: now });
  } catch { /* no offline here */ }
  return now;
}

export function signedInEmail() { return currentIdentity()?.email || ''; }
