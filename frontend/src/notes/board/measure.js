// Measure on a Board (Neil, 11/10/2026): Bluebeam-style takeoffs on the
// drawings, floor plans and PDF pages placed on a board. The person sets a
// scale by drawing a line across a known dimension and typing its real
// length; after that, length and area measurements read in feet.
//
// Everything lives on ordinary board elements, so it syncs live and saves
// with no change to the scene format:
//   a measure    an arrow (length, scale) or a closed line (area) carrying
//                customData.nexusMeasure = { kind, pxPerFt, on, onW }
//   its label    a text element grouped with it, customData.nexusMeasureLabel
//                = the measure's id
//   the scale    a measure of kind 'scale': `on` is the image it was drawn
//                over ('' = the whole board) and `onW` that image's width
//                then, so resizing the image rescales what is read on it
// Engine-free: plain elements built here, never an engine import.
import { FONT_HAND, FONT_SANS } from './scene';
import { MARKUP_COLORS } from './markupTools';

const rid = () => {
  try { return crypto.randomUUID().replace(/-/g, '').slice(0, 20); } catch { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
};
const nonce = () => Math.floor(Math.random() * 0x7fffffff);

const FONT = 16;
const LINE_HEIGHT = 1.25;
const OFFSET = 14;          // a length label sits this far above its line
const NUM = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
const IMPERIAL = new RegExp(`^(?:${NUM}\\s*(?:'|ft|feet|foot)\\.?)?\\s*-?\\s*(?:${NUM}\\s*("|''|in|inch|inches)?\\.?)?$`);
const METRIC = new RegExp(`^${NUM}\\s*(mm|cm|m|meters?)$`);
const PER_FOOT = { mm: 304.8, cm: 30.48, m: 0.3048, meter: 0.3048, meters: 0.3048 };

/** Feet from what a person types ("24' 6\"", "24 ft 6 in", "7.5 m"...), or null. */
export function parseLength(str) {
  const s = String(str ?? '').trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  if (!s || s.startsWith('-')) return null;
  let ft;
  const m = METRIC.exec(s);
  if (m) ft = Number(m[1]) / PER_FOOT[m[2]];
  else {
    const i = IMPERIAL.exec(s);
    if (!i || (i[1] == null && i[2] == null)) return null;
    if (i[1] == null && !i[3]) ft = Number(i[2]);              // a bare number is feet
    else ft = Number(i[1] || 0) + Number(i[2] || 0) / 12;
  }
  return Number.isFinite(ft) && ft > 0 ? ft : null;
}

// Explicit grouping: Intl output differs between local Node and CI's.
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** US architectural feet and inches to the nearest inch: 24' 6", 24', 6". */
export function formatLength(ft) {
  if (!Number.isFinite(ft)) return '';
  const total = Math.round(Math.abs(ft) * 12);
  const f = Math.floor(total / 12), i = total % 12;
  if (!f) return `${i}"`;
  return i ? `${group(f)}' ${i}"` : `${group(f)}'`;
}

/** Square feet: whole and grouped, one decimal under 10. */
export function formatArea(sqft) {
  if (!Number.isFinite(sqft)) return '';
  return sqft < 10 ? `${sqft.toFixed(1)} sq ft` : `${group(Math.round(sqft))} sq ft`;
}

/** The status line's scale: "1 ft = 12.0 px". */
export const formatScale = (pxPerFt) => `1 ft = ${Number(pxPerFt).toFixed(1)} px`;

const measureOf = (e) => (e && !e.isDeleted ? e.customData?.nexusMeasure : null);
const newest = (a, b) => (!a || (Number(b.updated) || 0) >= (Number(a.updated) || 0) ? b : a);

/**
 * Pixels per foot at a board point: the scale set on the top-most image
 * under the point (adjusted for how far that image was resized since), else
 * the newest board-wide scale, else null.
 */
export function scaleAt(elements, { x, y }) {
  const els = elements || [];
  const scales = els.filter((e) => measureOf(e)?.kind === 'scale' && Number(e.customData.nexusMeasure.pxPerFt) > 0);
  if (!scales.length) return null;
  for (let k = els.length - 1; k >= 0; k -= 1) {
    const img = els[k];
    if (!img || img.isDeleted || img.type !== 'image') continue;
    if (x < img.x || y < img.y || x > img.x + img.width || y > img.y + img.height) continue;
    const s = scales.filter((e) => e.customData.nexusMeasure.on === img.id).reduce(newest, null);
    if (!s) continue;
    const { pxPerFt, onW } = s.customData.nexusMeasure;
    return pxPerFt * (Number(onW) > 0 ? img.width / onW : 1);
  }
  const board = scales.filter((e) => !e.customData.nexusMeasure.on).reduce(newest, null);
  return board ? board.customData.nexusMeasure.pxPerFt : null;
}

// --- geometry -------------------------------------------------------------

const pathLength = (pts) => pts.slice(1).reduce((sum, p, k) => sum + Math.hypot(p[0] - pts[k][0], p[1] - pts[k][1]), 0);
const shoelace = (pts) => {
  let a = 0;
  for (let k = 0; k < pts.length; k += 1) {
    const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const centroid = (pts) => {
  const a = shoelace(pts);
  if (Math.abs(a) < 1e-9) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  let cx = 0, cy = 0;
  for (let k = 0; k < pts.length; k += 1) {
    const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % pts.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
};
const labelSize = (text) => ({ width: text.length * FONT * 0.55, height: Math.round(FONT * LINE_HEIGHT) });

/** Where a length label goes: centered at the midpoint, OFFSET above the line. */
function lengthLabelBox(x, y, points, text) {
  const [a, b] = [points[0], points[points.length - 1]];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  let nx = dy / len, ny = -dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; }                          // "above" = toward smaller y
  const { width, height } = labelSize(text);
  const cx = x + (a[0] + b[0]) / 2 + nx * OFFSET, cy = y + (a[1] + b[1]) / 2 + ny * OFFSET;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}
function areaLabelBox(x, y, points, text) {
  const [cx, cy] = centroid(points);
  const { width, height } = labelSize(text);
  return { x: x + cx - width / 2, y: y + cy - height / 2, width, height };
}
const lengthText = (points, pxPerFt) => formatLength(pathLength(points) / pxPerFt);
const areaText = (points, pxPerFt) => formatArea(Math.abs(shoelace(points)) / (pxPerFt * pxPerFt));

// --- elements -------------------------------------------------------------

function shared(color, look, now, groupId) {
  return {
    angle: 0, strokeColor: color, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: look === 'sketch' ? 1 : 0, opacity: 100, groupIds: [groupId], frameId: null, roundness: null,
    seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: now, link: null, locked: false,
  };
}
function label(measureId, text, box, color, look, now, groupId) {
  return {
    ...shared(color, look, now, groupId), id: rid(), type: 'text', ...box,
    text, originalText: text, fontSize: FONT, fontFamily: look === 'sketch' ? FONT_HAND : FONT_SANS,
    textAlign: 'center', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: LINE_HEIGHT,
    customData: { nexusMeasureLabel: measureId },
  };
}

/** A length (or scale) dimension from one board point to another: [arrow, label]. */
export function dimension({ x1, y1, x2, y2, pxPerFt, color = '#e03131', kind = 'length', on = '', onW = 0, look = 'clean', now = Date.now() }) {
  const g = rid();
  const points = [[0, 0], [x2 - x1, y2 - y1]];
  const arrow = {
    ...shared(color, look, now, g), id: rid(), type: 'arrow', x: x1, y: y1, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
    points, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: 'bar', endArrowhead: 'bar', elbowed: false,
    customData: { nexusMeasure: { kind, pxPerFt, on, onW } },
  };
  const text = lengthText(points, pxPerFt);
  return [arrow, label(arrow.id, text, lengthLabelBox(x1, y1, points, text), color, look, now, g)];
}

/** An area takeoff over board points (3 or more): [closed polygon, label]. */
export function area({ points, pxPerFt, color = '#e03131', look = 'clean', now = Date.now(), on = '', onW = 0 }) {
  const g = rid();
  const [ox, oy] = points[0];
  const rel = [...points, points[0]].map(([px, py]) => [px - ox, py - oy]);
  const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const tint = MARKUP_COLORS.find((c) => c.color === color)?.tint || color;
  const poly = {
    ...shared(color, look, now, g), id: rid(), type: 'line', x: ox, y: oy,
    width: Math.max(...xs) - minX, height: Math.max(...ys) - minY,
    points: rel, lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
    backgroundColor: tint, fillStyle: 'solid', opacity: 70,
    customData: { nexusMeasure: { kind: 'area', pxPerFt, on, onW } },
  };
  const text = areaText(rel, pxPerFt);
  return [poly, label(poly.id, text, areaLabelBox(ox, oy, rel, text), color, look, now, g)];
}

const bump = (e, next, now) => ({ ...e, ...next, version: (Number(e.version) || 0) + 1, versionNonce: nonce(), updated: now });
const near = (a, b) => Math.abs(a - b) < 0.5;

/**
 * The elements a change on the board made stale, and only those: a label
 * whose measure was stretched, moved or recalibrated (new text and place),
 * and a measure whose scale moved (its stored pxPerFt). A scale line keeps
 * its own pxPerFt - stretched, it now reads a different length.
 */
export function refreshMeasures(elements, { now = Date.now() } = {}) {
  const els = elements || [];
  const labels = new Map();
  for (const e of els) if (e && !e.isDeleted && e.customData?.nexusMeasureLabel) labels.set(e.customData.nexusMeasureLabel, e);
  const out = [];
  for (const e of els) {
    const m = measureOf(e);
    if (!m || !['length', 'scale', 'area'].includes(m.kind) || !Array.isArray(e.points) || e.points.length < 2) continue;
    const at = { x: e.x + e.points[0][0], y: e.y + e.points[0][1] };
    const px = m.kind === 'scale' ? m.pxPerFt : (scaleAt(els, at) || m.pxPerFt);
    if (!(px > 0)) continue;
    if (px !== m.pxPerFt) out.push(bump(e, { customData: { ...e.customData, nexusMeasure: { ...m, pxPerFt: px } } }, now));
    const lab = labels.get(e.id);
    if (!lab) continue;
    const isArea = m.kind === 'area';
    const text = isArea ? areaText(e.points, px) : lengthText(e.points, px);
    const box = (isArea ? areaLabelBox : lengthLabelBox)(e.x, e.y, e.points, text);
    if (lab.text === text && near(lab.x, box.x) && near(lab.y, box.y)) continue;
    out.push(bump(lab, { text, originalText: text, x: box.x, y: box.y, width: box.width }, now));
  }
  return out;
}
