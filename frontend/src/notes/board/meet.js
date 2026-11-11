// Running a meeting on a Board (Neil, 11/10/2026 - the Miro / FigJam
// facilitation kit): a shared timer, named dot voting and Private Writing.
// The state is a Yjs map ('meet') in the board's OWN shared document, so it
// rides the same encrypted live channel as the drawing and is kept with the
// board's live state on every save - never a second channel or a table. A
// board with no live session (not shared) gets a local map, so the timer
// still works for one person.
//
// Keys:
//   timer      { endsAt, total, by, name } running, or { left, total, paused: true, by, name }
//   vote       { id, by, name, perPerson, at }
//   v:<voteId>:<email>   { name, ids: [elementId] } - one row per voter, so two
//                        people voting at once never overwrite each other
//   silent     { by, name, at } - Private Writing: new stickies stay with
//              their author (Board's tray) until the host reveals them
//
// Votes are NAMED (Neil, 11/10/2026): while the vote is open each person sees
// only their own dots and the number cast; Show Results stamps every voted
// item with its count and the voters' names (`customData.nexusVotes` + a
// small line under it) and clears the vote.
//
// shortcut: the timer's end is the starter's clock; a few seconds of clock skew between computers shows as a few seconds - server time if anyone notices.
import { FONT_SANS } from './scene';

export const MEET = 'meet';
export const VOTE_PER_PERSON = [3, 5, 10];
export const TIMER_MINUTES = [1, 3, 5, 10, 15];

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const nonce = () => Math.floor(Math.random() * 0x7fffffff);
const plain = (v) => JSON.parse(JSON.stringify(v));

// ---- Timer -------------------------------------------------------------------
export function startTimer(map, seconds, who = {}, now = Date.now()) {
  const total = Math.max(10, Math.min(3 * 3600, Math.round(seconds))) * 1000;
  map.set('timer', { endsAt: now + total, total, by: who.email || '', name: who.name || '' });
}
export function timeLeft(t, now = Date.now()) {
  if (!t) return 0;
  return t.paused ? Math.max(0, t.left || 0) : Math.max(0, (t.endsAt || 0) - now);
}
export function addMinute(map, now = Date.now()) {
  const t = map.get('timer');
  if (!t) return;
  map.set('timer', t.paused
    ? { ...t, left: t.left + 60000, total: t.total + 60000 }
    : { ...t, endsAt: Math.max(t.endsAt, now) + 60000, total: t.total + 60000 });
}
export function pauseTimer(map, now = Date.now()) {
  const t = map.get('timer');
  if (t && !t.paused) map.set('timer', { left: timeLeft(t, now), total: t.total, paused: true, by: t.by, name: t.name });
}
export function resumeTimer(map, now = Date.now()) {
  const t = map.get('timer');
  if (t?.paused) map.set('timer', { endsAt: now + t.left, total: t.total, by: t.by, name: t.name });
}
export function stopTimer(map) { map.delete('timer'); }
/** 4:05, 0:09, 1:02:00. */
export function clock(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// ---- Votes -------------------------------------------------------------------
const voterKey = (voteId, email) => `v:${voteId}:${String(email || '').toLowerCase()}`;

export function startVote(map, { perPerson = 3, email = '', name = '' } = {}, now = Date.now()) {
  clearVotes(map);
  map.set('vote', { id: rid(), by: email, name, perPerson: Math.max(1, Math.min(20, perPerson)), at: now });
}
export function myVotes(map, vote, email) {
  if (!vote) return [];
  return [...(map.get(voterKey(vote.id, email))?.ids || [])];
}
/** One dot on (or off) an item; false when the person has used all their dots. */
export function toggleVote(map, vote, { email, name }, id) {
  if (!vote || !email || !id) return false;
  const mine = myVotes(map, vote, email);
  const has = mine.includes(id);
  if (!has && mine.length >= vote.perPerson) return false;
  map.set(voterKey(vote.id, email), { name: name || email, ids: has ? mine.filter((x) => x !== id) : [...mine, id] });
  return true;
}
/** Map itemId -> [{ email, name }] for the open vote. */
export function tally(map, vote) {
  const out = new Map();
  if (!vote) return out;
  const prefix = `v:${vote.id}:`;
  map.forEach((row, key) => {
    if (!key.startsWith(prefix) || !Array.isArray(row?.ids)) return;
    const email = key.slice(prefix.length);
    for (const id of new Set(row.ids)) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push({ email, name: row.name || email });
    }
  });
  return out;
}
export const castCount = (t) => [...t.values()].reduce((n, v) => n + v.length, 0);
export function clearVotes(map) {
  const drop = [];
  map.forEach((_, key) => { if (key === 'vote' || key.startsWith('v:')) drop.push(key); });
  for (const k of drop) map.delete(k);
}

const first = (n) => String(n || '').trim().split(/\s+/)[0] || n;
export const voteLine = (voters) => `${voters.length} ${voters.length === 1 ? 'Vote' : 'Votes'} - ${voters.map((v) => first(v.name)).join(', ')}`;

/**
 * The board with a vote's results on it: every earlier result line goes, each
 * voted item gets `customData.nexusVotes = { count, names }` and a line under
 * it in its own engine group (so it moves with a sticky). Plain elements.
 */
export function stampVotes(elements, results, { now = Date.now() } = {}) {
  const byId = new Map((elements || []).map((e) => [e.id, e]));
  const out = (elements || []).map((e) => {
    if (e.isDeleted) return e;
    if (e.customData?.nexusVoteLine) return { ...e, isDeleted: true, version: (e.version || 0) + 1, versionNonce: nonce(), updated: now };
    if (e.customData?.nexusVotes && !results.has(e.id)) {
      const { nexusVotes, ...rest } = e.customData;   // eslint-disable-line no-unused-vars
      return { ...e, customData: rest, version: (e.version || 0) + 1, versionNonce: nonce(), updated: now };
    }
    return e;
  });
  const lines = [];
  for (const [id, voters] of results) {
    const box = byId.get(id);
    if (!box || box.isDeleted || !voters.length) continue;
    const i = out.findIndex((e) => e.id === id);
    out[i] = { ...out[i], customData: { ...(out[i].customData || {}), nexusVotes: plain({ count: voters.length, names: voters.map((v) => v.name) }) }, version: (out[i].version || 0) + 1, versionNonce: nonce(), updated: now };
    const words = voteLine(voters);
    lines.push({
      id: `vl${rid()}`, type: 'text', x: box.x, y: box.y + box.height + 6, width: Math.min(box.width + 120, words.length * 14 * 0.56), height: 18,
      angle: 0, strokeColor: '#1971c2', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0,
      opacity: 100, groupIds: [...(box.groupIds || [])], frameId: box.frameId || null, roundness: null, seed: nonce(), version: 1, versionNonce: nonce(),
      isDeleted: false, boundElements: null, updated: now, link: null, locked: false, text: words, originalText: words, fontSize: 14,
      fontFamily: FONT_SANS, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25,
      customData: { nexusVoteLine: id },
    });
  }
  return [...out, ...lines];
}

// ---- Private Writing -----------------------------------------------------------
export function startSilent(map, who = {}, now = Date.now()) { map.set('silent', { by: who.email || '', name: who.name || '', at: now }); }
export function endSilent(map) { map.delete('silent'); }

/** The meet map as plain state for rendering. */
export function readMeet(map) {
  if (!map) return { timer: null, vote: null, silent: null };
  return { timer: map.get('timer') || null, vote: map.get('vote') || null, silent: map.get('silent') || null };
}
