// Markup tools for a Board (Neil, 11/06/2026): the short, opinionated set
// Claude's design markup gives a reviewer - point, pan, pen, highlighter,
// arrow, box, text, a numbered comment pin and the eraser - with six inks
// and three widths, over the full whiteboard engine. Engine-free: this
// module only describes the tools; Board.jsx hands the chosen one to the
// engine through the adapter's `markup` member (engine/index.js), so a new
// engine keeps the same bar.
//
// What each tool means for the engine:
//   engine     the engine's tool id ('comment' is ours: the board places a
//              pin where the next tap lands, see commentPin below)
//   locked     stays on after a stroke (markup is many strokes in a row);
//              text and comment drop back to Select once placed
//   style      what the next stroke is drawn with - the highlighter is the
//              pen drawn wide and see-through
import { FONT_HAND, FONT_SANS } from './scene';

export const MARKUP_TOOLS = Object.freeze([
  { key: 'select', label: 'Select', hint: 'V', engine: 'selection', locked: false },
  { key: 'hand', label: 'Move Around', hint: 'H', engine: 'hand', locked: true },
  { key: 'pen', label: 'Pen', hint: 'P', engine: 'freedraw', locked: true },
  { key: 'highlight', label: 'Highlighter', hint: 'I', engine: 'freedraw', locked: true },
  { key: 'arrow', label: 'Arrow', hint: 'A', engine: 'arrow', locked: true },
  { key: 'box', label: 'Box', hint: 'R', engine: 'rectangle', locked: true },
  { key: 'text', label: 'Text', hint: 'T', engine: 'text', locked: false },
  { key: 'comment', label: 'Comment', hint: 'C', engine: 'selection', locked: false },
  { key: 'eraser', label: 'Eraser', hint: 'E', engine: 'eraser', locked: true },
]);
export const TOOL_KEYS = MARKUP_TOOLS.map((t) => t.key);
export const toolByKey = (key) => MARKUP_TOOLS.find((t) => t.key === key) || MARKUP_TOOLS[0];

// The inks: the engine's own palette values where the Nexus palette has a
// match, so a stroke drawn here reads the same in the engine's picker and
// dark mode inverts it the way it inverts every engine color. `tint` is the
// pin's paper for that ink.
export const MARKUP_COLORS = Object.freeze([
  { key: 'ink', label: 'Black', color: '#1e1e1e', tint: '#f1f3f5' },
  { key: 'red', label: 'Red', color: '#e03131', tint: '#ffe3e3' },
  { key: 'amber', label: 'Amber', color: '#f08c00', tint: '#fff4e6' },
  { key: 'yellow', label: 'Yellow', color: '#fab005', tint: '#fff9db' },
  { key: 'green', label: 'Green', color: '#2f9e44', tint: '#ebfbee' },
  { key: 'blue', label: 'Blue', color: '#1971c2', tint: '#e7f5ff' },
]);
export const colorByKey = (key) => MARKUP_COLORS.find((c) => c.key === key) || MARKUP_COLORS[0];

export const MARKUP_SIZES = Object.freeze([
  { key: 'fine', label: 'Fine', width: 1 },
  { key: 'medium', label: 'Medium', width: 2 },
  { key: 'bold', label: 'Bold', width: 4 },
]);
export const sizeByKey = (key) => MARKUP_SIZES.find((s) => s.key === key) || MARKUP_SIZES[1];

// Red is the reviewer's ink; the highlighter starts yellow the first time.
export const DEFAULT_MARKUP = Object.freeze({ tool: 'pen', color: 'red', size: 'medium', highlightColor: 'yellow' });
const HIGHLIGHT_OPACITY = 35;

/** The engine app-state the next stroke is drawn with, for a tool + ink + width. */
export function strokeStyle(toolKey, colorKey, sizeKey) {
  const c = colorByKey(colorKey);
  if (toolKey === 'highlight') {
    return { currentItemStrokeColor: c.color, currentItemStrokeWidth: 4, currentItemOpacity: HIGHLIGHT_OPACITY, currentItemBackgroundColor: 'transparent' };
  }
  return {
    currentItemStrokeColor: c.color,
    currentItemStrokeWidth: sizeByKey(sizeKey).width,
    currentItemOpacity: 100,
    currentItemBackgroundColor: 'transparent',
  };
}

/** Which of our tools the engine's live tool id is (the engine's own strip on
 *  a computer can change it). A freedraw keeps the pen / highlighter we last
 *  picked; anything we do not offer reads as null (no button lit). */
export function toolFromEngine(engineTool, current) {
  if (!engineTool) return null;
  if (engineTool === 'freedraw') return current === 'highlight' ? 'highlight' : 'pen';
  if (engineTool === 'selection') return current === 'comment' ? 'comment' : 'select';
  const hit = MARKUP_TOOLS.find((t) => t.engine === engineTool && t.key !== 'comment');
  return hit ? hit.key : null;
}

const rid = () => {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 20); } catch { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
};
const nonce = () => Math.floor(Math.random() * 0x7fffffff);

/** The next pin's number: one more than the highest live pin on the board. */
export function nextCommentNumber(elements) {
  let n = 0;
  for (const e of elements || []) {
    if (!e || e.isDeleted) continue;
    const k = Number(e.customData?.nexusComment);
    if (Number.isFinite(k) && k > n) n = k;
  }
  return n + 1;
}

export const PIN_MAX = 280;
const PIN_FONT = 16;
const PIN_PAD = 10;

/**
 * A numbered comment pin at a board point, as plain engine elements: a
 * rounded paper box in the ink's tint with the ink as its edge and the text
 * bound inside it (`customData.nexusComment` = its number). The caller runs
 * them through the engine's repair, which measures the text and sizes the
 * box around it - nothing here imports the engine.
 */
export function commentPin({ x, y, text, number, colorKey = 'red', look = 'clean', now = Date.now() }) {
  const c = colorByKey(colorKey);
  const body = String(text || '').trim().slice(0, PIN_MAX);
  const label = `${number}. ${body}`;
  const width = Math.max(140, Math.min(300, Math.round(label.length * PIN_FONT * 0.55) + PIN_PAD * 2));
  const lines = Math.max(1, Math.ceil((label.length * PIN_FONT * 0.55) / (width - PIN_PAD * 2)));
  const height = Math.round(lines * PIN_FONT * 1.25 + PIN_PAD * 2);
  const boxId = rid(), textId = rid();
  const base = {
    angle: 0, strokeColor: c.color, fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: look === 'sketch' ? 1 : 0, opacity: 100, groupIds: [], frameId: null, seed: nonce(),
    version: 1, versionNonce: nonce(), isDeleted: false, updated: now, link: null, locked: false,
    customData: { nexusComment: number },
  };
  const box = {
    ...base, id: boxId, type: 'rectangle', x, y, width, height,
    backgroundColor: c.tint, roundness: { type: 3 }, boundElements: [{ id: textId, type: 'text' }],
  };
  const label_ = {
    ...base, id: textId, type: 'text', x: x + PIN_PAD, y: y + PIN_PAD, width: width - PIN_PAD * 2, height: height - PIN_PAD * 2,
    backgroundColor: 'transparent', roundness: null, boundElements: null, strokeColor: '#1e1e1e',
    text: label, originalText: label, fontSize: PIN_FONT, fontFamily: look === 'sketch' ? FONT_HAND : FONT_SANS,
    textAlign: 'left', verticalAlign: 'middle', containerId: boxId, autoResize: true, lineHeight: 1.25,
  };
  return [box, label_];
}

/** A board point from a tap on the stage: the engine's scroll and zoom undone. */
export function stageToBoard({ clientX, clientY }, rect, appState) {
  const zoom = Number(appState?.zoom?.value) || 1;
  return {
    x: (clientX - (rect?.left || 0)) / zoom - (Number(appState?.scrollX) || 0),
    y: (clientY - (rect?.top || 0)) / zoom - (Number(appState?.scrollY) || 0),
  };
}

/** Elements re-inked: the selection takes the picked ink (and width, for a
 *  stroke), each with a new version so the live session carries it. Text
 *  keeps its size. Untouched elements come back as the same object. */
export function restyle(elements, ids, { colorKey, sizeKey } = {}) {
  const pick = ids instanceof Set ? ids : new Set(Object.keys(ids || {}).filter((k) => ids[k]));
  if (!pick.size) return elements;
  const c = colorKey ? colorByKey(colorKey) : null;
  const w = sizeKey ? sizeByKey(sizeKey).width : null;
  const now = Date.now();
  return (elements || []).map((e) => {
    if (!e || e.isDeleted || !pick.has(e.id)) return e;
    const next = {};
    if (c && e.strokeColor !== c.color) next.strokeColor = c.color;
    if (c && e.customData?.nexusComment && e.type === 'rectangle' && e.backgroundColor !== c.tint) next.backgroundColor = c.tint;
    if (c && e.customData?.nexusComment && e.type === 'text') delete next.strokeColor;
    if (w && e.type !== 'text' && e.strokeWidth !== w) next.strokeWidth = w;
    if (!Object.keys(next).length) return e;
    return { ...e, ...next, version: (Number(e.version) || 0) + 1, versionNonce: nonce(), updated: now };
  });
}

/** Elements with the selection deleted (a new version each, so Undo and the live session both see it). */
export function removeSelected(elements, ids) {
  const pick = ids instanceof Set ? ids : new Set(Object.keys(ids || {}).filter((k) => ids[k]));
  if (!pick.size) return elements;
  // A box takes its bound text with it, and a text its box.
  for (const e of elements || []) {
    if (!e || e.isDeleted) continue;
    if (pick.has(e.id) && e.containerId) pick.add(e.containerId);
    if (pick.has(e.id)) for (const b of e.boundElements || []) if (b?.type === 'text') pick.add(b.id);
  }
  const now = Date.now();
  return (elements || []).map((e) => (e && !e.isDeleted && pick.has(e.id)
    ? { ...e, isDeleted: true, version: (Number(e.version) || 0) + 1, versionNonce: nonce(), updated: now }
    : e));
}
