// Sticky notes on a Board (Neil, 11/10/2026 - the FigJam / Miro sticky, done
// properly): a square of colored paper with its words bound inside and the
// author's name in small type at its foot. Engine-free: plain elements, like
// a comment pin (markupTools.js), so a sticky saves, syncs, exports and
// undoes like any shape. What makes a box a sticky is
// `customData.nexusSticky = { by, name, color }`; its words are the box's
// bound text (double-click edits them, the engine re-wraps), the author line
// is a small text in the same engine group (`customData.nexusStickyFoot`).
//
// Sort Stickies is plain sorting, never AI: by color, by author, or by the
// word the most stickies share - each group in a SECTION of its own (Neil,
// 11/12/2026, sections.js), so a column moves as one and is already a slide.
// Make Tasks links each sticky to the task the
// import engine made from it (`customData.nexusRecord`, the record-card
// mark) and its foot then reads "Task - Open" / "Task - Done".
import { FONT_HAND, FONT_SANS } from './scene';
import { wrapWords } from './markupTools';
import { safeRef, splitRef } from '../recordLink';
import { recordHref } from '../../lib/recordRef';
import { formatDate } from '../../lib/datetime';

export const STICKY_COLORS = Object.freeze([
  { key: 'yellow', label: 'Yellow', fill: '#fff3bf' },
  { key: 'green', label: 'Green', fill: '#d3f9d8' },
  { key: 'blue', label: 'Blue', fill: '#d0ebff' },
  { key: 'pink', label: 'Pink', fill: '#ffdeeb' },
  { key: 'orange', label: 'Orange', fill: '#ffe8cc' },
  { key: 'purple', label: 'Purple', fill: '#e5dbff' },
]);
export const stickyColor = (key) => STICKY_COLORS.find((c) => c.key === key) || STICKY_COLORS[0];

export const STICKY_SIZE = 200;
export const STICKY_GAP = 24;
export const STICKY_MAX = 500;
const PAD = 16;
const FOOT = 12;
const FOOT_ROOM = 22;
const LINE = 1.25;
const SIZES = [20, 16, 13];
const SLATE = '#868e96';
const INK = '#1e1e1e';

const rid = () => {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 20); } catch { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
};
const nonce = () => Math.floor(Math.random() * 0x7fffffff);
const bump = (e, patch, now) => ({ ...e, ...patch, version: (Number(e.version) || 0) + 1, versionNonce: nonce(), updated: now });
const live = (els) => (els || []).filter((e) => e && !e.isDeleted);

export const isSticky = (e) => !!e && !e.isDeleted && e.type === 'rectangle' && !!e.customData?.nexusSticky;

/** The words laid out to fit the paper: the largest size whose lines fit, wrapped at spaces. */
export function fitWords(text, measureAt = (t, size) => String(t).length * size * 0.55) {
  const body = String(text || '').slice(0, STICKY_MAX);
  const room = STICKY_SIZE - PAD * 2;
  for (const size of SIZES) {
    const lines = wrapWords(body, room, (t) => measureAt(t, size));
    if (lines.length * size * LINE <= STICKY_SIZE - PAD * 2 - FOOT_ROOM || size === SIZES[SIZES.length - 1]) {
      const w = Math.ceil(Math.max(1, ...lines.map((l) => measureAt(l, size))));
      return { lines, size, width: Math.min(room, w), height: Math.round(lines.length * size * LINE) };
    }
  }
  return null;   // not reached
}

const textPatch = (box, text, look, measureAt) => {
  const fit = fitWords(text, measureAt);
  return {
    text: fit.lines.join('\n'), originalText: String(text || '').slice(0, STICKY_MAX), fontSize: fit.size,
    width: fit.width, height: fit.height, lineHeight: LINE,
    x: box.x + (box.width - fit.width) / 2, y: box.y + (box.height - FOOT_ROOM - fit.height) / 2 + 4,
    fontFamily: look === 'sketch' ? FONT_HAND : FONT_SANS,
  };
};

/** A sticky at a board point: [paper, words, author line], one engine group.
 *  `frameId` puts it in the section it was placed on (sections.js). */
export function sticky({ x, y, text = '', colorKey = 'yellow', by = '', name = '', look = 'clean', now = Date.now(), measureAt, frameId = null }) {
  const c = stickyColor(colorKey);
  const boxId = rid(), textId = rid(), footId = rid(), group = rid();
  const base = {
    angle: 0, strokeColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
    roughness: look === 'sketch' ? 1 : 0, opacity: 100, groupIds: [group], frameId: frameId || null, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false, updated: now, link: null, locked: false,
  };
  const box = {
    ...base, id: boxId, type: 'rectangle', x, y, width: STICKY_SIZE, height: STICKY_SIZE,
    backgroundColor: c.fill, roundness: { type: 3, value: 6 }, boundElements: [{ id: textId, type: 'text' }],
    customData: { nexusSticky: { by: String(by || '').toLowerCase(), name: String(name || ''), color: c.key } },
  };
  const words = {
    ...base, id: textId, type: 'text', backgroundColor: 'transparent', roundness: null, boundElements: null, strokeColor: INK,
    textAlign: 'center', verticalAlign: 'middle', containerId: boxId, autoResize: true,
    ...textPatch(box, text, look, measureAt),
  };
  const foot = footLine(box, footWords(name), { base: { ...base, seed: nonce() }, id: footId, look });
  return [box, words, foot];
}

const footWords = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).join(' ');
function footLine(box, words, { base, id, look }) {
  return {
    ...base, id, type: 'text', x: box.x + PAD - 4, y: box.y + box.height - FOOT - 10, width: Math.max(10, words.length * FOOT * 0.55), height: Math.round(FOOT * LINE),
    backgroundColor: 'transparent', roundness: null, boundElements: null, strokeColor: SLATE, strokeWidth: 1,
    text: words, originalText: words, fontSize: FOOT, fontFamily: look === 'sketch' ? FONT_HAND : FONT_SANS,
    textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: LINE,
    customData: { nexusStickyFoot: box.id },
  };
}

/** Each live sticky's parts: Map boxId -> { box, text, foot }. */
export function stickyParts(elements) {
  const out = new Map();
  const els = live(elements);
  for (const e of els) if (isSticky(e)) out.set(e.id, { box: e, text: null, foot: null });
  for (const e of els) {
    if (e.type !== 'text') continue;
    if (e.containerId && out.has(e.containerId)) out.get(e.containerId).text = e;
    const f = e.customData?.nexusStickyFoot;
    if (f && out.has(f)) out.get(f).foot = e;
  }
  return out;
}

/** The elements with one sticky's words replaced (refit, re-centered, a new version). */
export function withStickyText(elements, boxId, text, { look = 'clean', now = Date.now(), measureAt } = {}) {
  const p = stickyParts(elements).get(boxId);
  if (!p?.text) return elements;
  const next = bump(p.text, textPatch(p.box, text, look, measureAt), now);
  return elements.map((e) => (e.id === next.id ? next : e));
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Where the next sticky goes beside `box` (right or down), past any sticky already there. */
export function nextSpot(box, dir = 'right', elements = []) {
  const step = STICKY_SIZE + STICKY_GAP;
  const others = [...stickyParts(elements).values()].map((p) => p.box);
  let at = dir === 'down' ? { x: box.x, y: box.y + step } : { x: box.x + step, y: box.y };
  for (let i = 0; i < 50 && others.some((o) => overlaps({ ...at, width: STICKY_SIZE, height: STICKY_SIZE }, o)); i += 1) {
    at = dir === 'down' ? { x: at.x, y: at.y + step } : { x: at.x + step, y: at.y };
  }
  return at;
}

const STOP = new Set('the and for with that this from have will what when where were they them then than there their about into your our are was not but can all any its has had out who how why also just more most some such very each only over under after before need needs make made get got'.split(' '));
const wordsOf = (t) => [...new Set(String(t || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])].filter((w) => !STOP.has(w));
const title = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** The group key of each sticky for a sort: Map boxId -> heading. */
export function sortKeys(parts, by) {
  const keys = new Map();
  if (by === 'color') { for (const [id, p] of parts) keys.set(id, stickyColor(p.box.customData.nexusSticky.color).label); return keys; }
  if (by === 'author') { for (const [id, p] of parts) keys.set(id, p.box.customData.nexusSticky.name || 'Someone'); return keys; }
  // by word: each sticky goes under the word the most stickies share
  const count = new Map();
  const words = new Map();
  for (const [id, p] of parts) {
    const w = wordsOf(p.text?.originalText || p.text?.text);
    words.set(id, w);
    for (const x of w) count.set(x, (count.get(x) || 0) + 1);
  }
  for (const [id] of parts) {
    let best = '', n = 1;
    for (const x of words.get(id)) { const c = count.get(x); if (c > n || (c === n && n > 1 && x < best)) { best = x; n = c; } }
    keys.set(id, best ? title(best) : 'Other');
  }
  return keys;
}

export const SECTION_PAD = 24;
const SORT_DROP = 96;   // how far under the board's last thing a sort lands when it leaves someone's sections

/**
 * Stickies sorted into SECTIONS (`by` color | author | word), one named
 * section per group: the selected stickies (or every sticky), from where the
 * first of them sits. Each sticky joins its section (`frameId`), so the
 * column moves as one, is a slide in Present and a heading in Wrap Up. The
 * sections (and, on an older board, the loose headings) of their last sort
 * go once nothing is left in them; a section someone drew is never touched -
 * stickies sorted out of one land under everything on the board instead of
 * on top of it. Nothing is made again: the same stickies, moved. Returns the
 * elements, or the same array when there is nothing to sort.
 */
export function sortStickies(elements, ids, by = 'color', { now = Date.now() } = {}) {
  const all = stickyParts(elements);
  const pick = ids && Object.keys(ids).some((k) => ids[k]) ? new Set(Object.keys(ids).filter((k) => ids[k])) : null;
  const parts = new Map([...all].filter(([id, p]) => !pick || pick.has(id) || (p.text && pick.has(p.text.id)) || (p.foot && pick.has(p.foot.id))));
  if (parts.size < 2) return elements;
  const keys = sortKeys(parts, by);
  const groups = new Map();
  for (const [id, p] of [...parts].sort((a, b) => a[1].box.y - b[1].box.y || a[1].box.x - b[1].box.x)) {
    const k = keys.get(id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || groups.get(b).length - groups.get(a).length || a.localeCompare(b));
  const sortId = rid();
  const oldSorts = new Set([...parts.values()].map((p) => p.box.customData.nexusSticky.sortId).filter(Boolean));
  const frames = new Map(live(elements).filter((e) => e.type === 'frame').map((e) => [e.id, e]));
  const isOldSort = (f) => !!f?.customData?.nexusSortFrame && oldSorts.has(f.customData.nexusSortFrame);
  const fromSomeones = [...parts.values()].some((p) => p.box.frameId && frames.has(p.box.frameId) && !isOldSort(frames.get(p.box.frameId)));
  let x0 = Math.min(...[...parts.values()].map((p) => p.box.x));
  let y0 = Math.min(...[...parts.values()].map((p) => p.box.y));
  if (fromSomeones) {
    const els = live(elements);
    x0 = Math.min(...els.map((e) => e.x)) + SECTION_PAD;
    y0 = Math.max(...els.map((e) => e.y + (e.height || 0))) + SORT_DROP;
  }
  const moved = new Map();     // id -> its newer copy
  const columns = [];          // [{ frame, ids: [member ids in order] }]
  const step = STICKY_SIZE + STICKY_GAP;
  const colStep = STICKY_SIZE + SECTION_PAD * 2 + STICKY_GAP;
  order.forEach((k, col) => {
    const x = x0 + col * colStep;
    const rows = groups.get(k);
    const frame = {
      id: rid(), type: 'frame', x: x - SECTION_PAD, y: y0 - SECTION_PAD, width: STICKY_SIZE + SECTION_PAD * 2,
      height: rows.length * STICKY_SIZE + (rows.length - 1) * STICKY_GAP + SECTION_PAD * 2, angle: 0, name: k,
      strokeColor: '#bbb', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0,
      opacity: 100, groupIds: [], frameId: null, roundness: null, seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false,
      boundElements: null, updated: now, link: null, locked: false, customData: { nexusSortFrame: sortId },
    };
    const members = [];
    rows.forEach((p, row) => {
      const dx = x - p.box.x, dy = y0 + row * step - p.box.y;
      const shift = (e, extra = {}) => { if (!e) return; moved.set(e.id, bump(e, { x: e.x + dx, y: e.y + dy, frameId: frame.id, ...extra }, now)); members.push(e.id); };
      shift(p.box, { customData: { ...p.box.customData, nexusSticky: { ...p.box.customData.nexusSticky, sortId } } });
      shift(p.text); shift(p.foot);
    });
    columns.push({ frame, ids: members });
  });
  // What the last sort left behind: its loose headings (boards sorted before
  // sections), and its sections once nothing of theirs is left in them.
  const stillIn = new Set();
  for (const e of elements) if (e && !e.isDeleted && e.frameId && !moved.has(e.id)) stillIn.add(e.frameId);
  const rest = [];
  for (const e of elements) {
    if (moved.has(e.id)) continue;   // drawn again below, with its section
    if (!e.isDeleted && e.customData?.nexusSortHead && oldSorts.has(e.customData.nexusSortHead)) rest.push(bump(e, { isDeleted: true }, now));
    else if (!e.isDeleted && e.type === 'frame' && isOldSort(e) && !stillIn.has(e.id)) rest.push(bump(e, { isDeleted: true }, now));
    else rest.push(e);
  }
  // A section is drawn after what it holds (the engine reads a frame's members before it).
  return [...rest, ...columns.flatMap((c) => [...c.ids.map((id) => moved.get(id)), c.frame])];
}

/** Stickies in a selection (by any of their parts), top to bottom, left to right. */
export function selectedStickies(elements, ids) {
  const pick = new Set(Object.keys(ids || {}).filter((k) => ids[k]));
  if (!pick.size) return [];
  return [...stickyParts(elements).values()]
    .filter((p) => pick.has(p.box.id) || (p.text && pick.has(p.text.id)) || (p.foot && pick.has(p.foot.id)))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

export const stickyWords = (p) => String(p.text?.originalText ?? p.text?.text ?? '').replace(/\s+/g, ' ').trim();

const taskFoot = (state) => (!state ? 'Task' : state.done ? 'Task - Done' : `Task - Open${state.dueOn ? ` - Due ${formatDate(state.dueOn)}` : ''}`);

/** Each sticky linked to its task (in order): the link opens the task, the foot says so. */
export function linkStickies(elements, pairs, { now = Date.now() } = {}) {
  const parts = stickyParts(elements);
  const next = new Map();
  for (const { boxId, taskId } of pairs) {
    const p = parts.get(boxId);
    const ref = safeRef(`task:${taskId}`);
    if (!p || !ref) continue;
    next.set(p.box.id, bump(p.box, { link: recordHref(ref), customData: { ...p.box.customData, nexusRecord: { ref } } }, now));
    if (p.foot) next.set(p.foot.id, bump(p.foot, { text: taskFoot(null), originalText: taskFoot(null), width: taskFoot(null).length * FOOT * 0.55 }, now));
  }
  return elements.map((e) => next.get(e.id) || e);
}

/** The stickies linked to tasks: [{ foot, taskId }]. */
export function taskStickies(elements) {
  return [...stickyParts(elements).values()]
    .map((p) => ({ foot: p.foot, taskId: splitRef(p.box.customData?.nexusRecord?.ref || '').kind === 'task' ? splitRef(p.box.customData.nexusRecord.ref).id : '' }))
    .filter((x) => x.foot && x.taskId);
}

/** The feet whose task line changed, as newer versions. `states`: { taskId: { done, dueOn } }. */
export function refreshedStickyFeet(elements, states, { now = Date.now() } = {}) {
  const out = [];
  for (const { foot, taskId } of taskStickies(elements)) {
    const s = states?.[taskId];
    if (!s) continue;
    const words = taskFoot(s);
    if (words === foot.text) continue;
    out.push(bump(foot, { text: words, originalText: words, width: words.length * FOOT * 0.55 }, now));
  }
  return out;
}

/** Something a vote can land on: a sticky, or a box with words in it (never a comment pin or a group frame). */
export function votable(e, boundText) {
  if (!e || e.isDeleted) return false;
  if (isSticky(e)) return true;
  if (!['rectangle', 'ellipse', 'diamond'].includes(e.type)) return false;
  if (e.customData?.nexusComment || e.customData?.nexusGroup) return false;
  return !!boundText;
}
