// Meeting Notes (Neil, 11/12/2026) - the pure parts: a day's bounds for the
// calendar read, where a meeting is in time, and which transcript cue a note
// line's stamp points at. No React, no network - meetings.test.jsx covers them.

/** The person's local day 'YYYY-MM-DD' as the two instants the server reads. */
export function dayBounds(day) {
  const [y, m, d] = String(day || '').split('-').map(Number);
  const start = new Date(y, (m || 1) - 1, d || 1);
  const end = new Date(y, (m || 1) - 1, (d || 1) + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

const ms = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};

/** { startMs, endMs } of a meeting from the server's ISO times (0 when unknown). */
export const meetingTimes = (m) => ({ startMs: ms(m?.start), endMs: ms(m?.end) });

/** 'upcoming' | 'live' | 'ended' - live is the meeting's own hours, nothing either side. */
export function meetingPhase(m, now = Date.now()) {
  const { startMs, endMs } = meetingTimes(m);
  if (!startMs || now < startMs) return 'upcoming';
  if (now <= endMs) return 'live';
  return 'ended';
}

/** The Join button is for the meeting's hours and the quarter hour either side. */
export function joinable(m, now = Date.now()) {
  const { startMs, endMs } = meetingTimes(m);
  return !!m?.joinUrl && !!startMs && now >= startMs - 15 * 60 * 1000 && now <= endMs + 15 * 60 * 1000;
}

/** The cue a note line stamped `at` (Unix seconds) points at: the last one
 *  that started at or before it - a line is written after the words it is
 *  about were said. The first cue when the line came before any of them. */
export function cueIndexAt(cues, at) {
  if (!cues?.length || !Number.isFinite(at)) return -1;
  let best = 0;
  for (let k = 0; k < cues.length; k += 1) {
    if (cues[k].at <= at) best = k;
    else break;
  }
  return best;
}

/** The invite's people as the screen names them: Nexus People's names first,
 *  the invite's own name next, the address last; the caller left out. */
export function attendeeList(meeting, people = [], me = '') {
  const mine = String(me || '').toLowerCase();
  const byEmail = new Map((people || []).map((p) => [String(p.email || '').toLowerCase(), p]));
  const out = [];
  const seen = new Set();
  for (const a of meeting?.attendees || []) {
    const email = String(a?.email || '').toLowerCase();
    if (!email || seen.has(email) || email === mine) continue;
    seen.add(email);
    const p = byEmail.get(email);
    out.push({ email, name: p?.name || a.name || email, inNexus: !!p });
  }
  return out;
}

/** The talk-time line under the transcript: each speaker's share of the cues' words. */
export function speakerShares(cues) {
  const words = new Map();
  let total = 0;
  for (const c of cues || []) {
    const n = String(c.text || '').split(/\s+/).filter(Boolean).length;
    const who = c.speaker || 'Unknown Speaker';
    words.set(who, (words.get(who) || 0) + n);
    total += n;
  }
  if (!total) return [];
  return [...words.entries()]
    .map(([name, n]) => ({ name, pct: Math.round((n * 100) / total) }))
    .sort((a, b) => b.pct - a.pct);
}
