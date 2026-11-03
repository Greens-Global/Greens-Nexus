// ONE outbox for every change made in the field (full offline, Neil
// 11/03/2026; guide docs/Offline.md). It is the punch queue's rules
// (lib/punchQueue.js, lib/bodQueue.js) made general:
//
//   * an id made ON THE PHONE when the change is saved, sent to the server
//     with every try (the Idempotency-Key header, or the route's own key such
//     as a form's entryKey), so a resend of a change that already landed is
//     answered with the first result, never a second row;
//   * SAVED BEFORE IT IS SENT: enqueue writes the entry (and its photos) to
//     IndexedDB first, so a sign-in redirect, a closed tab or a dead battery
//     cannot lose it;
//   * RETRY with backoff while the outcome is unknown (no answer, a 5xx, a
//     429), then PARK it and REPLAY on load, when the phone is back online,
//     when the tab is visible again and after sign-in;
//   * a 401 is not an answer: the entry parks and the bar says "Signed out -
//     sign in when you have signal to send"; it replays after sign-in;
//   * a 409 is a CONFLICT: the server's current value is kept beside the
//     change and the person chooses Keep Mine or Use Theirs - nothing is
//     ever silently overwritten;
//   * any other 4xx is an answer: the entry is FAILED with the server's
//     message (Retry or Discard), never resent by itself.
//
// Entries: { id, kind, group, payload, blobs: [blobId], after: [entryId],
// label, owner, createdAt, attempts, nextAt, state, error, server, result,
// progress, sentAt }. state: pending | sending | parked | conflict | failed |
// sent. Entries of one `group` (default: the kind) go in the order they were
// made; `after` waits for other entries (a log before the photos on it).
// A kind is a handler registered by the module that owns it (kinds.js lists
// the loaders, so a change queued yesterday can send before its screen is
// opened today):
//
//   registerKind('forms:entry', {
//     send: async (entry, ctx) => result,       // throw api.js's error as is
//     rebase: (payload, server) => payload,      // Keep Mine (optional)
//     useTheirs: async (entry, server) => {},    // Use Theirs (optional)
//     describe: (entry) => ({ title, detail }),  // the list's words (optional)
//   });
//
// ctx: { idempotencyKey, headers, blob(id), uploadOnce(id, upload), result(id) }.
import * as idb from './idb';
import { identityKey } from './identity';
import { putBlob, adoptBlobs, deleteBlob, blobBytes, MAX_BLOB_BYTES, OfflineError, isOffline, sweepBlobs, getBlob } from './store';
import { publish } from './status';
import { loadKind } from './kinds';

export const MAX_ENTRIES = 300;
const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000, 120000, 300000];
const MAX_TRIES_BEFORE_PARK = BACKOFF_MS.length;      // then wait for online / visibility / sign-in
const SENT_KEEP_MS = 24 * 3600 * 1000;               // "Sent" stays on the list a day
const WAITING = new Set(['pending', 'sending', 'parked']);

const kinds = new Map();
let entries = [];            // every entry of every person, as last read
let loaded = null;
let flushing = null;
let queuedRun = null;
let queuedOpts = null;
let timer = null;
let signedOut = false;
let channel = null;

export const newOutboxId = () => {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
};

/** Register what sends one kind of change. */
export function registerKind(kind, handler) {
  if (!kind || typeof handler?.send !== 'function') throw new Error('registerKind needs a kind and a send function');
  kinds.set(kind, handler);
}
export const kindHandler = (kind) => kinds.get(kind) || null;

// ── State ────────────────────────────────────────────────────────────────────

const mine = () => { const who = identityKey(); return who ? entries.filter((e) => e.owner === who) : []; };

// Made order: `seq` (strictly increasing on this phone), else the time made.
let lastSeq = 0;
function nextSeq() { lastSeq = Math.max(Date.now() * 1000, lastSeq + 1); return lastSeq; }
const madeOrder = (a, b) => (a.seq || Date.parse(a.createdAt) * 1000) - (b.seq || Date.parse(b.createdAt) * 1000);

function snapshot() {
  const list = mine().slice().sort(madeOrder);
  const count = (pred) => list.filter(pred).length;
  return {
    entries: list,
    waiting: count((e) => WAITING.has(e.state)),
    conflicts: count((e) => e.state === 'conflict'),
    failed: count((e) => e.state === 'failed'),
    sending: count((e) => e.state === 'sending'),
    signedOut,
  };
}

function announce() {
  publish(snapshot());
  try { channel?.postMessage({ type: 'changed' }); } catch { /* closed */ }
}

// Every read and write of the disk copy goes through one queue, in order, so
// a re-read never lands between a change and its write (and loses it).
let chain = Promise.resolve();
function serial(fn) { const p = chain.then(fn); chain = p.catch(() => {}); return p; }

function save(entry) {
  return serial(async () => {
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) entries[i] = entry; else entries.push(entry);
    await idb.put('outbox', entry);
    announce();
    return entry;
  });
}

function remove(id) {
  return serial(async () => {
    entries = entries.filter((e) => e.id !== id);
    try { await idb.del('outbox', id); } catch { /* gone */ }
    announce();
  });
}

// What is on disk is the truth: another tab may have queued or sent since.
// A 'sending' entry read here was cut off (a closed tab, a redirect) or is
// another tab's - flushes run one at a time under a Web Lock, so inside a
// flush it is sent again; the idempotency key makes that safe.
function reread() {
  return serial(async () => {
    try { entries = await idb.getAll('outbox'); } catch { /* keep what we have */ }
    publish(snapshot());
    return entries;
  });
}

function load() {
  if (!loaded) loaded = reread();
  return loaded;
}

/** Entries for the signed-in person, oldest first. */
export async function listEntries() { await load(); return snapshot().entries; }
export async function getEntry(id) { await load(); return mine().find((e) => e.id === id) || null; }

// ── Queueing ─────────────────────────────────────────────────────────────────

/**
 * Save a change on the phone and send it as soon as possible.
 *   enqueue({ kind, payload, blobs?: [File], blobIds?: [id], after?: [id], group?, label?, id? })
 * `blobs` are saved now; `blobIds` are blobs already on the phone (a form's
 * photos) and are handed over to this entry. Resolves with the entry once it
 * is ON DISK - the send happens after. Throws an OfflineError when the phone
 * is full or IndexedDB is not available (the caller keeps its own draft).
 */
export async function enqueue({ kind, payload, blobs = [], blobIds = [], after = [], group = '', label = '', id = '' }) {
  if (!kind) throw new Error('enqueue needs a kind');
  const owner = identityKey();
  if (!owner) throw new OfflineError('Sign in to save changes on this phone.', 'signed-out');
  await load();
  try { await idb.openDb(); } catch { throw new OfflineError('This browser cannot keep changes on the phone (private browsing or blocked site data). Send it when you have signal.', 'no-storage'); }
  if (mine().filter((e) => e.state !== 'sent').length >= MAX_ENTRIES) {
    throw new OfflineError(`This phone already holds ${MAX_ENTRIES} changes waiting to send. Send them when you have signal, then try again.`, 'outbox-full');
  }
  const extra = blobs.reduce((n, b) => n + (b?.size || 0), 0);
  if (extra && (await blobBytes()) + extra > MAX_BLOB_BYTES) {
    throw new OfflineError(`This phone is holding the most photos and files it can (${Math.round(MAX_BLOB_BYTES / 1024 / 1024)} MB). Send what is waiting when you have signal, then try again.`, 'blobs-full');
  }
  const entryId = id || newOutboxId();
  const existing = entries.find((e) => e.id === entryId);
  if (existing) return existing;          // the same change queued twice is one entry
  const ref = `outbox:${entryId}`;
  const ids = [...blobIds];
  for (const b of blobs) ids.push(await putBlob(b, { ref, name: b.name }));
  if (blobIds.length) await adoptBlobs(blobIds, ref);
  const entry = {
    id: entryId, kind, group: group || kind, payload, blobs: ids, after: [...after], label: label || '',
    owner, createdAt: new Date().toISOString(), seq: nextSeq(), attempts: 0, nextAt: 0,
    state: isOffline() ? 'parked' : 'pending', error: '', server: null, result: null, progress: {}, sentAt: '',
  };
  await save(entry);
  kick();
  return entry;
}

// ── Sending ──────────────────────────────────────────────────────────────────

/** What an api.js error means for a queued change. */
export function classify(e) {
  const s = e?.status;
  if (!s) return 'unknown';                    // no answer: offline, timeout, CORS
  if (s === 401) return 'signed-out';
  if (s === 409) return 'conflict';
  if (s === 408 || s === 425 || s === 429 || s >= 500) return 'unknown';
  return 'failed';                             // 400, 403, 404, 413, 422 ... an answer
}

const messageOf = (e) => (typeof e?.message === 'string' && e.message) || 'The server refused this change.';

function ctxFor(entry) {
  return {
    idempotencyKey: entry.id,
    headers: { 'Idempotency-Key': entry.id },
    blob: (id) => getBlob(id),
    // Upload a blob once: the URL is kept on the entry, so a retry after the
    // upload but before the registering call does not upload it again.
    uploadOnce: async (blobId, upload) => {
      if (entry.progress?.[blobId]) return entry.progress[blobId];
      const file = await getBlob(blobId);
      if (!file) throw Object.assign(new Error('A photo saved on this phone is missing - it may have been cleared by the browser.'), { status: 410 });
      const url = await upload(file);
      if (!url) throw new Error('The photo upload did not answer.');
      entry.progress = { ...(entry.progress || {}), [blobId]: url };
      await save(entry);
      return url;
    },
    result: (id) => entries.find((e) => e.id === id)?.result ?? null,
  };
}

async function sendOne(entry) {
  const handler = kinds.get(entry.kind) || await loadKind(entry.kind).then(() => kinds.get(entry.kind)).catch(() => null);
  if (!handler) return 'wait';                           // its module did not load (offline, old build)
  entry.state = 'sending';
  await save(entry);
  try {
    const result = await handler.send(entry, ctxFor(entry));
    for (const b of entry.blobs || []) await deleteBlob(b);
    await save({ ...entry, state: 'sent', result: result ?? null, sentAt: new Date().toISOString(), error: '', server: null, payload: entry.payload });
    signedOut = false;
    return 'sent';
  } catch (e) {
    const kind = classify(e);
    entry.attempts = (entry.attempts || 0) + 1;
    if (kind === 'signed-out') {
      signedOut = true;
      await save({ ...entry, state: 'parked', error: 'Signed out', nextAt: 0 });
      return 'stop-all';
    }
    if (kind === 'conflict') {
      await save({ ...entry, state: 'conflict', error: messageOf(e), server: e?.body ?? e?.detail ?? null });
      return 'answered';
    }
    if (kind === 'failed') {
      await save({ ...entry, state: 'failed', error: messageOf(e) });
      return 'answered';
    }
    // Unknown: try again later, then park until something changes.
    const park = isOffline() || entry.attempts >= MAX_TRIES_BEFORE_PARK;
    const delay = BACKOFF_MS[Math.min(entry.attempts - 1, BACKOFF_MS.length - 1)];
    await save({ ...entry, state: park ? 'parked' : 'pending', nextAt: park ? 0 : Date.now() + delay, error: e?.isNetworkError || !e?.status ? '' : messageOf(e) });
    return 'wait';
  }
}

function depsState(entry) {
  for (const id of entry.after || []) {
    const dep = entries.find((e) => e.id === id);
    if (!dep) return 'missing';
    if (dep.state !== 'sent') return 'waiting';
  }
  return 'ok';
}

async function runFlush({ manual = false } = {}) {
  await load();
  await reread();
  pruneSent();
  if (isOffline()) {
    // Nothing can go: show them as waiting for signal.
    for (const e of mine()) if (e.state === 'pending') await save({ ...e, state: 'parked' });
    return snapshot();
  }
  const now = Date.now();
  const tried = new Set();
  // Passes until nothing more moves: a change sent in one group can free a
  // change waiting on it in another (a log, then the photos on it).
  for (let pass = 0; pass < 6; pass += 1) {
    let moved = false;
    const groups = new Map();
    for (const e of mine().sort(madeOrder)) {
      if (!groups.has(e.group)) groups.set(e.group, []);
      groups.get(e.group).push(e);
    }
    for (const list of groups.values()) {
      for (const entry of list) {
        if (!WAITING.has(entry.state)) continue;                // sent, conflict, failed: answered
        if (tried.has(entry.id)) break;                         // one try per flush
        // A parked entry goes again on any trigger; a pending one waits out
        // its backoff unless the person pressed Sync Now.
        if (entry.state === 'pending' && entry.nextAt && entry.nextAt > now && !manual) break;
        const deps = depsState(entry);
        if (deps === 'missing') {
          await save({ ...entry, state: 'failed', error: 'The change this one depends on was discarded.' });
          moved = true;
          continue;
        }
        if (deps === 'waiting') break;                         // keep the group's order
        if (manual && entry.state === 'parked') entry.attempts = 0;
        tried.add(entry.id);
        const out = await sendOne(entry);
        if (out === 'stop-all') return snapshot();             // signed out: nothing else will go
        if (out !== 'sent') break;                             // keep the group's order
        moved = true;
      }
    }
    if (!moved) break;
  }
  return snapshot();
}

/** Send what can go now. One flush at a time (and one tab at a time where
 *  the browser has Web Locks); a call during a flush runs once more after. */
export function flush(opts = {}) {
  // During a flush: one more runs after it (with Sync Now's "now" kept), and
  // every caller in the meantime waits for that one.
  if (flushing) {
    queuedOpts = { manual: !!(queuedOpts?.manual || opts.manual) };
    if (!queuedRun) {
      queuedRun = flushing.then(() => { const o = queuedOpts; queuedOpts = null; queuedRun = null; return flush(o || {}); });
    }
    return queuedRun;
  }
  const run = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks?.request) {
        return await navigator.locks.request('nexus-outbox', { ifAvailable: true }, async (lock) => {
          if (lock) return runFlush(opts);
          // Another tab is sending; look again shortly (it may not know
          // about a change this tab just queued).
          setTimeout(() => flush(opts), 3000);
          return snapshot();
        });
      }
      return await runFlush(opts);
    } finally {
      schedule();
    }
  };
  flushing = run().finally(() => { flushing = null; });
  return flushing;
}

function kick() { if (!isOffline()) flush(); else announce(); }

function schedule() {
  clearTimeout(timer);
  timer = null;
  const next = mine().filter((e) => e.state === 'pending' && e.nextAt).map((e) => e.nextAt).sort((a, b) => a - b)[0];
  if (next) timer = setTimeout(() => flush(), Math.max(500, next - Date.now()));
}

function pruneSent() {
  const cut = Date.now() - SENT_KEEP_MS;
  for (const e of entries.slice()) {
    if (e.state !== 'sent' || Date.parse(e.sentAt || 0) >= cut) continue;
    // Keep a sent entry while something still waits on its result.
    if (entries.some((x) => x.state !== 'sent' && (x.after || []).includes(e.id))) continue;
    remove(e.id);
  }
}

// ── The person's choices ─────────────────────────────────────────────────────

/** A conflict: 'mine' sends this change again over the server's value (the
 *  kind's rebase decides how), 'theirs' drops this change and keeps the
 *  server's (the kind's useTheirs may refresh what the screen holds). */
export async function resolveConflict(id, choice) {
  await load();
  const entry = mine().find((e) => e.id === id);
  if (!entry || entry.state !== 'conflict') return null;
  const handler = kinds.get(entry.kind) || await loadKind(entry.kind).then(() => kinds.get(entry.kind)).catch(() => null);
  if (choice === 'theirs') {
    try { await handler?.useTheirs?.(entry, entry.server); } catch { /* the screen re-reads anyway */ }
    for (const b of entry.blobs || []) await deleteBlob(b);
    await remove(id);
    return null;
  }
  let payload = entry.payload;
  try { if (handler?.rebase) payload = handler.rebase(entry.payload, entry.server); } catch { /* keep as is */ }
  const next = await save({ ...entry, payload, state: 'pending', attempts: 0, nextAt: 0, error: '', server: null });
  flush({ manual: true });
  return next;
}

/** A failed (or stuck) change: try it again now. */
export async function retryEntry(id) {
  await load();
  const entry = mine().find((e) => e.id === id);
  if (!entry || !['failed', 'parked', 'pending'].includes(entry.state)) return null;
  const next = await save({ ...entry, state: 'pending', attempts: 0, nextAt: 0, error: '' });
  flush({ manual: true });
  return next;
}

/** Throw a change away (the person held Discard). Its photos go with it. */
export async function discardEntry(id) {
  await load();
  const entry = mine().find((e) => e.id === id);
  if (!entry || entry.state === 'sending') return false;
  for (const b of entry.blobs || []) await deleteBlob(b);
  await remove(id);
  return true;
}

// ── Start ────────────────────────────────────────────────────────────────────

let started = false;
/** Called once (status.js, at idle after boot): read what is waiting, send
 *  it, and send again on every trigger. */
export async function startOutbox() {
  if (started) return snapshot();
  started = true;
  await load();
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => flush({ manual: true }));
    window.addEventListener('offline', () => flush());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush({ manual: true }); });
    try {
      channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('nexus-outbox') : null;
      if (channel) channel.onmessage = () => { reread(); };
    } catch { channel = null; }
  }
  // Photos of drafts nobody came back to (the outbox keeps its own).
  sweepBlobs();
  return flush({ manual: true });
}

export const isSignedOut = () => signedOut;

/** After sign-in: the signed-out entries go. */
export function afterSignIn() { signedOut = false; announce(); return flush({ manual: true }); }

/** Test seam: forget everything in memory (the database is reset by the test). */
export function _resetOutbox() {
  entries = []; loaded = null; flushing = null; queuedRun = null; queuedOpts = null; signedOut = false; started = false;
  chain = Promise.resolve();
  clearTimeout(timer); timer = null; kinds.clear();
  try { channel?.close(); } catch { /* closed */ }
  channel = null;
}
