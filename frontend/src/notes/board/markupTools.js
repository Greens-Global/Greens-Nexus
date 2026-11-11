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
  // Ours (Neil, 11/10/2026): a tap places a sticky and opens its words (stickies.js).
  { key: 'sticky', label: 'Sticky Note', hint: '', engine: 'selection', locked: false },
  { key: 'arrow', label: 'Arrow', hint: 'A', engine: 'arrow', locked: true },
  { key: 'box', label: 'Box', hint: 'R', engine: 'rectangle', locked: true },
  { key: 'text', label: 'Text', hint: 'T', engine: 'text', locked: false },
  { key: 'comment', label: 'Comment', hint: 'C', engine: 'selection', locked: false },
  { key: 'eraser', label: 'Eraser', hint: 'E', engine: 'eraser', locked: true },
]);
// The rest of the engine's tools, one tap away under More Tools (Neil,
// 11/06/2026: the best of both - Claude's short set up front, the full
// whiteboard behind it, one bar, never two strips). Single-use like the
// engine's own: a shape drawn, back to Select.
export const MORE_TOOLS = Object.freeze([
  { key: 'ellipse', label: 'Ellipse', hint: 'O', engine: 'ellipse', locked: false },
  { key: 'diamond', label: 'Diamond', hint: 'D', engine: 'diamond', locked: false },
  { key: 'line', label: 'Line', hint: 'L', engine: 'line', locked: false },
  { key: 'image', label: 'Image', hint: '9', engine: 'image', locked: false },
  { key: 'frame', label: 'Frame', hint: 'F', engine: 'frame', locked: false },
  { key: 'laser', label: 'Laser Pointer', hint: 'K', engine: 'laser', locked: true },
  // Measure (Neil, 11/10/2026, measure.js): taps on the stage, ours like Comment.
  { key: 'measure', label: 'Measure Length', hint: '', engine: 'selection', locked: true },
  { key: 'area', label: 'Measure Area', hint: '', engine: 'selection', locked: true },
  { key: 'scale', label: 'Set Scale', hint: '', engine: 'selection', locked: false },
]);
/** Our tools: the engine stays on Select while the board takes the taps (Board's place layer). */
export const PLACE_TOOLS = new Set(['comment', 'sticky', 'measure', 'area', 'scale']);
const ALL_TOOLS = [...MARKUP_TOOLS, ...MORE_TOOLS];
export const TOOL_KEYS = ALL_TOOLS.map((t) => t.key);
export const isMoreTool = (key) => MORE_TOOLS.some((t) => t.key === key);
export const toolByKey = (key) => ALL_TOOLS.find((t) => t.key === key) || MARKUP_TOOLS[0];

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

/** Which of our tools the engine's live tool id is (a shortcut key can
 *  change it). A freedraw keeps the pen / highlighter we last
 *  picked; anything we do not offer reads as null (no button lit). */
export function toolFromEngine(engineTool, current) {
  if (!engineTool) return null;
  if (engineTool === 'freedraw') return current === 'highlight' ? 'highlight' : 'pen';
  if (engineTool === 'selection') return PLACE_TOOLS.has(current) ? current : 'select';
  const hit = ALL_TOOLS.find((t) => t.engine === engineTool && !PLACE_TOOLS.has(t.key));
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
const PIN_LINE = 1.25;
const PIN_PAD_X = 14;
const PIN_PAD_Y = 10;
const PIN_TEXT_MAX = 260;      // the widest a line runs before it wraps
const PIN_MIN_W = 120;
const FONT_NAME = { [FONT_SANS]: 'Nunito', [FONT_HAND]: 'Excalifont' };

/** A rough width when there is no canvas to measure with (tests, a server). */
const roughMeasure = (text) => String(text).length * PIN_FONT * 0.55;

/** Text in lines no wider than `max`, broken at spaces (a word longer than a line keeps its own line). */
export function wrapWords(text, max, measure = roughMeasure) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > max) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** A canvas text measurer for the pin's face, or the rough one where there is no canvas. */
export function pinMeasurer(look = 'clean') {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return roughMeasure;
    ctx.font = `${PIN_FONT}px ${FONT_NAME[look === 'sketch' ? FONT_HAND : FONT_SANS]}, sans-serif`;
    return (t) => ctx.measureText(String(t)).width;
  } catch { return roughMeasure; }
}

/**
 * A numbered comment pin at a board point, as plain engine elements: a
 * rounded paper box in the ink's tint with the ink as its edge and the text
 * bound inside it, centered (`customData.nexusComment` = its number). Sized
 * to its words - `measure` (pinMeasurer) is the face's real width - so the
 * engine draws it exactly where it is placed; nothing here imports the engine.
 */
export function commentPin({ x, y, text, number, colorKey = 'red', look = 'clean', now = Date.now(), measure = roughMeasure, ids = null, thread = null, version = 1 }) {
  const c = colorByKey(colorKey);
  const body = String(text || '').trim().slice(0, PIN_MAX);
  // A thread (threads.js, 11/10/2026) adds its reply count; a resolved one fades.
  const n = thread?.replies?.length || 0;
  const label = `${number}. ${body}${n ? `\n${n} ${n === 1 ? 'Reply' : 'Replies'}` : ''}`;
  const lines = wrapWords(label, PIN_TEXT_MAX, measure);
  const textW = Math.ceil(Math.max(...lines.map((l) => measure(l)), 1));
  const textH = Math.round(lines.length * PIN_FONT * PIN_LINE);
  const width = Math.max(PIN_MIN_W, textW + PIN_PAD_X * 2);
  const height = textH + PIN_PAD_Y * 2;
  const boxId = ids?.box || rid(), textId = ids?.text || rid();
  const base = {
    angle: 0, strokeColor: c.color, fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: look === 'sketch' ? 1 : 0, opacity: thread?.resolved ? 45 : 100, groupIds: [], frameId: null, seed: nonce(),
    version, versionNonce: nonce(), isDeleted: false, updated: now, link: null, locked: false,
    customData: { nexusComment: number },
  };
  const box = {
    ...base, id: boxId, type: 'rectangle', x, y, width, height,
    backgroundColor: c.tint, roundness: { type: 3 }, boundElements: [{ id: textId, type: 'text' }],
    ...(thread ? { customData: { nexusComment: number, nexusThread: thread } } : {}),
  };
  const label_ = {
    ...base, id: textId, type: 'text', x: x + (width - textW) / 2, y: y + PIN_PAD_Y, width: textW, height: textH,
    backgroundColor: 'transparent', roundness: null, boundElements: null, strokeColor: '#1e1e1e',
    text: lines.join('\n'), originalText: label, fontSize: PIN_FONT, fontFamily: look === 'sketch' ? FONT_HAND : FONT_SANS,
    textAlign: 'center', verticalAlign: 'middle', containerId: boxId, autoResize: true, lineHeight: PIN_LINE,
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
