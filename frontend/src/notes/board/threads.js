// Comment threads on a Board (Neil, 11/10/2026 - "comment - yes"): a numbered
// pin (markupTools.js commentPin) carries its whole conversation in
// `customData.nexusThread = { by, name, at, text, resolved, replies: [{ id, by,
// name, at, text }] }`, so a thread saves, syncs live and exports like any
// shape - no second store. Replies, Resolve / Reopen and @mentions: a mention
// of someone who can open the board sends them a bell (POST
// /notes/{id}/board-mentions, server-side - the one exception to Notes' "a
// mention notifies nobody", for board comments only). Engine-free.
import { commentPin, MARKUP_COLORS } from './markupTools';

export const REPLY_MAX = 1000;
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Each live pin: Map boxId -> { box, text }. */
export function pinParts(elements) {
  const out = new Map();
  for (const e of elements || []) {
    if (e && !e.isDeleted && e.type === 'rectangle' && e.customData?.nexusComment) out.set(e.id, { box: e, text: null });
  }
  for (const e of elements || []) {
    if (e && !e.isDeleted && e.type === 'text' && e.containerId && out.has(e.containerId)) out.get(e.containerId).text = e;
  }
  return out;
}

/** The pin the selection is (its box or its words), else ''. */
export function selectedPin(elements, ids) {
  const pick = Object.keys(ids || {}).filter((k) => ids[k]);
  if (!pick.length || pick.length > 2) return '';
  for (const [id, p] of pinParts(elements)) {
    if (pick.every((k) => k === id || k === p.text?.id)) return id;
  }
  return '';
}

/** A pin's thread; a pin from before threads reads its words as the first comment. */
export function threadOf(part) {
  const t = part?.box?.customData?.nexusThread;
  if (t && typeof t === 'object') return { ...t, replies: Array.isArray(t.replies) ? t.replies : [] };
  const words = String(part?.text?.originalText || part?.text?.text || '').replace(/^\d+\.\s*/, '').replace(/\n\d+ Repl(y|ies)$/, '');
  return { by: '', name: '', at: 0, text: words, resolved: null, replies: [] };
}

const colorKeyOf = (box) => (MARKUP_COLORS.find((c) => c.color === box?.strokeColor) || MARKUP_COLORS[1]).key;

/** The pin drawn again with `thread` - same ids, same place, newer versions. */
export function withThread(elements, boxId, thread, { look = 'clean', measure, now = Date.now(), prepare = (x) => x } = {}) {
  const p = pinParts(elements).get(boxId);
  if (!p) return elements;
  const version = Math.max(p.box.version || 1, p.text?.version || 1) + 1;
  const [box, text] = prepare(commentPin({
    x: p.box.x, y: p.box.y, text: thread.text, number: Number(p.box.customData.nexusComment), colorKey: colorKeyOf(p.box),
    look, measure, now, ids: { box: p.box.id, text: p.text?.id }, thread, version,
  }));
  const keep = { groupIds: p.box.groupIds || [], frameId: p.box.frameId || null };
  // The pin stays tied to the item it sits on (rideAlong.js).
  const on = p.box.customData?.nexusOn;
  const tied = on ? { ...box, ...keep, customData: { ...box.customData, nexusOn: on } } : { ...box, ...keep };
  return elements.map((e) => (e.id === box.id ? tied : p.text && e.id === p.text.id ? { ...text, ...keep } : e));
}

export const newThread = (text, who, now = Date.now()) => ({ by: who.email || '', name: who.name || '', at: now, text: String(text).trim().slice(0, REPLY_MAX), resolved: null, replies: [] });
export const withReply = (thread, text, who, now = Date.now()) => ({
  ...thread, resolved: null,
  replies: [...thread.replies, { id: rid(), by: who.email || '', name: who.name || '', at: now, text: String(text).trim().slice(0, REPLY_MAX) }],
});
export const withResolved = (thread, on, who, now = Date.now()) => ({ ...thread, resolved: on ? { by: who.email || '', name: who.name || '', at: now } : null });

/** The people a message mentions: everyone whose "@Full Name" is in it. */
export function mentionsIn(text, people) {
  const s = String(text || '').toLowerCase();
  return (people || []).filter((p) => p?.email && p?.name && s.includes(`@${p.name.toLowerCase()}`)).map((p) => p.email.toLowerCase());
}

/** The "@word" being typed at the caret, or null: { start, query }. */
export function mentionAt(text, caret) {
  const before = String(text || '').slice(0, caret);
  const m = before.match(/(^|\s)@([\w.'-]*(?: [\w.'-]*)?)$/);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}
