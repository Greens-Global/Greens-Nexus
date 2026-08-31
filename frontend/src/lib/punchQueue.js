import { api } from '../api';

// ── A punch must never be lost ────────────────────────────────────────────────
// The day-message gate posts to Teams BEFORE the punch (BodModal.send() ->
// onSent -> actualPunch), and that Teams post is delivered SERVER-side with its
// own retry queue - so the durable half ran first and the fragile half second.
// api.js deliberately never retries a mutation, so a single blip on a phone left
// the employee looking at a Teams message saying they were back from lunch while
// Nexus had no punch at all (Beth, Aug 29: `time_bod` break_end recorded and
// sent at 20:31:53, no punch until she redid it from her desktop at 20:37).
//
// This module closes that gap in three steps:
//   1. RETRY the punch POST. Safe for this endpoint specifically - the server's
//      state machine only accepts a kind that is currently allowed and rejects an
//      identical punch within 60s, so a re-send can land at most once. A 409 is
//      therefore evidence our earlier attempt DID commit; we confirm against
//      /status before calling it a success.
//   2. If it still fails, PARK it along with the time it was meant for.
//   3. REPLAY it on the next load, at the RIGHT time either way: inside the
//      server's 15-minute clicked_at window as a normal punch, and after that as
//      a flagged self_manual backfill.
//
// A punch the server REFUSED is never parked. That one is not lost, it is wrong,
// and replaying it later would only make it wrong later.

const KEY = 'nexus:pendingPunch';
const ATTEMPTS = 3;
// The server honors clicked_at up to 15 minutes back; stay comfortably inside it.
const CLICKED_AT_WINDOW_SEC = 14 * 60;

// The punch endpoint's own wire format: 'YYYY-MM-DDTHH:MM:SS', UTC, no suffix.
export const utcStamp = (d = new Date()) => d.toISOString().slice(0, 19);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// One slot, not a queue: while a punch is parked the server's state is still the
// one BEFORE it, so the only punch the employee can make next is that same one -
// which is the retry. A second parked punch can't arise.
export function readPending() {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && p.kind && p.at ? p : null;
  } catch { return null; }
}
export function clearPending() {
  try { localStorage.removeItem(KEY); } catch { /* private mode - nothing to clear */ }
}
function writePending(entry) {
  try { localStorage.setItem(KEY, JSON.stringify(entry)); return true; }
  catch { return false; }   // storage full/blocked: the caller still surfaces the failure
}

// A network error carries no status; a 5xx may or may not have committed. Both
// are "unknown", which is what makes a retry worth attempting. A 4xx is a real
// answer from the server and must be shown to the person as-is.
const isUnknownOutcome = (e) => !e?.status || e.status >= 500;

// Did the punch actually land? Asked whenever the outcome is ambiguous, so we
// never park (and later replay) a punch that already committed.
async function landedPunch(kind) {
  try {
    const s = await api.timeStatus();
    return s?.lastPunch?.kind === kind ? s : null;
  } catch { return null; }
}

/**
 * Record a punch, durably.
 * Returns { ok: true, punch, allowed, recovered? }
 *      or { ok: false, error, unreachable?, queued? } - unreachable means the
 *      server never gave an answer, queued means it is parked for replay.
 */
export async function punchDurable({ kind, tzOffsetMin, clickedAt = '', pos = null, extra = null }) {
  const body = {
    kind, ...(pos || {}), tz_offset_min: tzOffsetMin,
    ...(clickedAt ? { clicked_at: clickedAt } : {}),
    ...(extra || {}),
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const r = await api.timePunch(body);
      clearPending();
      return { ok: true, punch: r.punch, allowed: r.allowed, result: r };
    } catch (e) {
      lastErr = e;
      // 409 = the server refused the transition. Either our own earlier attempt
      // already made it (retry), or their state genuinely doesn't allow it.
      if (e?.status === 409) {
        const s = await landedPunch(kind);
        if (s) { clearPending(); return { ok: true, punch: s.lastPunch, allowed: s.allowed, recovered: true }; }
        return { ok: false, error: e };
      }
      if (!isUnknownOutcome(e)) return { ok: false, error: e };   // 400/403 - a real refusal
      if (attempt < ATTEMPTS) await sleep(700 * attempt);
    }
  }
  // Every attempt ended unknown. Confirm once more before parking - a 5xx can
  // arrive after the write committed, and a duplicate is worse than a retry.
  const s = await landedPunch(kind);
  if (s) { clearPending(); return { ok: true, punch: s.lastPunch, allowed: s.allowed, recovered: true }; }
  const queued = writePending({
    kind, at: clickedAt || utcStamp(), tz_offset_min: tzOffsetMin,
    ...(pos || {}), queued_at: utcStamp(),
  });
  // `extra` (the shared-PC pair nonce) is deliberately NOT parked: it belongs to
  // this browser's live pairing challenge and is meaningless on a later replay.
  return { ok: false, error: lastErr, unreachable: true, queued };
}

/**
 * Replay a parked punch. Called on load, so a punch lost to a dead connection
 * lands as soon as anything reaches the server again.
 * Returns null when there was nothing to do (or it is still unreachable),
 * { restored: true, punch, backfilled } on success, or { dropped: true } when
 * the punch is no longer wanted or can no longer be placed.
 */
let replayInFlight = null;
export function replayPending() {
  // Both this page and the global mini-timer replay on load. Share one attempt
  // so they can't each send the same parked punch.
  if (!replayInFlight) replayInFlight = _replayPending().finally(() => { replayInFlight = null; });
  return replayInFlight;
}

async function _replayPending() {
  const p = readPending();
  if (!p) return null;
  let status;
  try { status = await api.timeStatus(); } catch { return null; }   // still offline - keep it parked
  // The state has already moved past it - they redid the punch on another device,
  // or an approver fixed the day. The parked copy is stale, not missing.
  if (!Array.isArray(status?.allowed) || !status.allowed.includes(p.kind)) {
    clearPending();
    return { dropped: true, entry: p, stale: true };
  }
  // CLAIM it before sending, and write it back only if the send ends unknown.
  // Another TAB could otherwise replay the same punch, and the self_manual
  // backfill below has no server-side duplicate guard to catch that.
  clearPending();
  const ageSec = (Date.now() - Date.parse(`${p.at}Z`)) / 1000;
  try {
    if (ageSec <= CLICKED_AT_WINDOW_SEC) {
      // Still inside the window the server credits, so it lands as an ordinary
      // punch stamped at the moment the button was actually pressed.
      const r = await api.timePunch({
        kind: p.kind, lat: p.lat, lng: p.lng, accuracy_m: p.accuracy_m,
        tz_offset_min: p.tz_offset_min, clicked_at: p.at,
      });
      return { restored: true, punch: r.punch, entry: p };
    }
    // Past the window: the only way to keep the REAL time is the backfill path,
    // which records source=self_manual and so is flagged for approver review -
    // correct, and visibly not a silent edit.
    const punch = await api.timeSelfPunch({
      kind: p.kind, at: p.at, tz_offset_min: p.tz_offset_min,
      note: 'Recorded offline - Nexus could not reach the server when this punch was made.',
    });
    return { restored: true, backfilled: true, punch, entry: p };
  } catch (e) {
    if (isUnknownOutcome(e)) { writePending(p); return null; }   // unreachable again - next load
    // A 409 here means it landed after all (the retry raced its own first send),
    // or the sequence moved on: either way it is no longer ours to carry.
    if (e.status === 409) return { dropped: true, entry: p, stale: true };
    // The server answered and said no (too old to backfill, bad request): it can
    // never succeed on a later try, so stop carrying it and tell the caller.
    return { dropped: true, entry: p, error: e };
  }
}
