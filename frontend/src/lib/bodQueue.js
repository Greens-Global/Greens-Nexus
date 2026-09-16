import { api } from '../api';

// ── A day message must never be lost ─────────────────────────────────────────
// The BOD/EOD/break message is composed in the browser and handed to the server
// in ONE POST (/timeclock/bod); from there teams_post.py delivers it to Teams
// with its own retry queue. That server-side half is durable. The browser half
// was not: api.js never retries a mutation, so a single dropped request on a
// phone lost the message with no trace - no time_bod row, nothing to retry,
// while the punch a few seconds later went through (Amy and Vicki, 09/16/2026,
// 8:31 and 8:33 AM PT, both on iPhones that had posted fine every other day).
//
// Same shape as punchQueue.js, made safe by an idempotent row id:
//   1. every message carries a client-generated uuid as its row id, so the
//      server answers a re-send of a message it already has with that row
//      instead of a second row and a second Teams post;
//   2. RETRY the POST a few times while the outcome is unknown (no answer, or
//      a 5xx that may or may not have committed);
//   3. if it still fails, PARK it, and REPLAY on the next load, when the
//      connection is back, or when the tab becomes visible again.
//
// A message the server REFUSED (4xx) is never parked - that is an answer.

const KEY = 'nexus:pendingBods';
const ATTEMPTS = 3;
// teams_post.py stops delivering a row older than 48h; a parked message older
// than that is stale on the server's own terms.
const MAX_AGE_MS = 48 * 3600 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isUnknownOutcome = (e) => !e?.status || e.status >= 500;

export function newBodId() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function readPendingBods() {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(p => p && p.id && p.body) : [];
  } catch { return []; }
}
function writePendingBods(list) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
    return true;
  } catch { return false; }   // storage full/blocked: the caller still surfaces the failure
}
export function clearPendingBods() { writePendingBods([]); }
function park(entry) {
  const list = readPendingBods().filter(p => p.id !== entry.id);
  list.push(entry);
  return writePendingBods(list);
}
function unpark(id) {
  writePendingBods(readPendingBods().filter(p => p.id !== id));
}

/**
 * Record a day message, durably. `body` is the /timeclock/bod payload; its
 * `id` is set here when the caller did not pass one.
 * Returns { ok: true, resp } or { ok: false, error, unreachable?, queued? } -
 * unreachable means the server never gave an answer, queued means it is
 * parked for replay.
 */
export async function bodDurable(body) {
  const payload = { ...body, id: body.id || newBodId() };
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const resp = await api.timeBodRecord(payload);
      unpark(payload.id);
      return { ok: true, resp, id: payload.id };
    } catch (e) {
      lastErr = e;
      if (!isUnknownOutcome(e)) return { ok: false, error: e, id: payload.id };   // a real refusal
      if (attempt < ATTEMPTS) await sleep(700 * attempt);
    }
  }
  const queued = park({ id: payload.id, body: payload, queued_at: new Date().toISOString() });
  return { ok: false, error: lastErr, unreachable: true, queued, id: payload.id };
}

/**
 * Replay every parked message. Called on load, on 'online' and when the tab
 * becomes visible, so a message lost to a dead connection lands as soon as
 * anything reaches the server again. Shares one attempt across callers so two
 * surfaces (Time Clock page, floating timer) can't both send the same one.
 * Returns { sent: n, dropped: n, remaining: n } or null when nothing was parked.
 */
let replayInFlight = null;
export function replayPendingBods() {
  if (!replayInFlight) replayInFlight = _replay().finally(() => { replayInFlight = null; });
  return replayInFlight;
}

async function _replay() {
  const list = readPendingBods();
  if (!list.length) return null;
  const out = { sent: 0, dropped: 0, remaining: 0 };
  for (const p of list) {
    const age = Date.now() - Date.parse(p.queued_at || 0);
    if (!Number.isFinite(age) || age > MAX_AGE_MS) { unpark(p.id); out.dropped++; continue; }
    try {
      await api.timeBodRecord(p.body);
      unpark(p.id);
      out.sent++;
    } catch (e) {
      if (isUnknownOutcome(e)) { out.remaining++; continue; }   // still unreachable - next time
      unpark(p.id);                                             // the server answered no
      out.dropped++;
    }
  }
  return out;
}
