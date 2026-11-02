// Board templates (Notes whiteboard, Phase 2 - Neil, 11/02/2026): what New
// Board starts from. Each is a plain scene (board/scene.js) built here with
// no engine import, so the picker costs nothing until a board opens. Dates
// are US format through lib/datetime.
import { emptyScene, serializeScene, FONT_SANS, NEXUS_COLORS } from './scene';
import { formatDate } from '../../lib/datetime';

const nonce = () => Math.floor(Math.random() * 0x7fffffff);
let seq = 0;
const id = (p) => `${p}${(seq += 1).toString(36)}${Date.now().toString(36)}`;

const base = (type, x, y, w, h, extra = {}) => ({
  id: id(type[0]), type, x, y, width: w, height: h, angle: 0,
  strokeColor: NEXUS_COLORS.ink, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid',
  roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: type === 'rectangle' ? { type: 3 } : null,
  seed: nonce(), version: 1, versionNonce: nonce(), isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
  ...extra,
});

/** A text element; width and height are estimates the engine re-measures. */
export const text = (x, y, value, { size = 20, color = NEXUS_COLORS.ink, align = 'left' } = {}) => base('text', x, y, Math.max(40, value.length * size * 0.56), Math.round(size * 1.25), {
  text: value, originalText: value, fontSize: size, fontFamily: FONT_SANS, textAlign: align, verticalAlign: 'top',
  containerId: null, autoResize: true, lineHeight: 1.25, strokeColor: color,
});
export const rect = (x, y, w, h, extra = {}) => base('rectangle', x, y, w, h, extra);
export const frame = (x, y, w, h, name) => base('frame', x, y, w, h, { name, roundness: null, strokeColor: '#bbb', backgroundColor: 'transparent' });
export const line = (x, y, dx, dy, extra = {}) => base('line', x, y, Math.abs(dx), Math.abs(dy), {
  points: [[0, 0], [dx, dy]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null, roundness: null, ...extra,
});

const withElements = (els, appState = {}) => {
  const s = emptyScene('clean');
  s.elements = els;
  s.appState = { ...s.appState, ...appState };
  return s;
};

function kanban() {
  const cols = ['To Do', 'Doing', 'Done'];
  const els = [];
  cols.forEach((name, i) => {
    const x = i * 400;
    els.push(frame(x, 0, 360, 720, name));
    els.push(text(x + 16, 16, name, { size: 24 }));
    els.push(line(x + 16, 56, 328, 0, { strokeColor: '#cfd4d1' }));
  });
  return withElements(els);
}

function timeline() {
  const start = new Date();
  start.setDate(start.getDate() - start.getDay());     // this week's Sunday
  const els = [text(0, -120, 'Timeline', { size: 28 }), line(0, 0, 1200, 0, { strokeWidth: 2 })];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(start); d.setDate(start.getDate() + i * 7);
    const x = i * 200;
    els.push(line(x, -12, 0, 24));
    els.push(text(x - 40, 24, formatDate(d), { size: 14, color: NEXUS_COLORS.slate }));
  }
  els.push(text(0, -60, 'Milestones above the line, work below it.', { size: 16, color: NEXUS_COLORS.slate }));
  return withElements(els);
}

function grid() {
  return withElements([text(0, -60, 'Grid', { size: 24 })], { gridModeEnabled: true, gridSize: 20 });
}

function floorPlan() {
  const els = [
    text(0, -80, 'Floor Plan', { size: 28 }),
    text(0, -40, '1 square = 1 ft (grid 20). Walls 2 pt, doors as arcs, notes in slate.', { size: 14, color: NEXUS_COLORS.slate }),
    rect(0, 0, 480, 360, { strokeWidth: 2 }),
    text(200, 160, 'Room', { size: 20, color: NEXUS_COLORS.slate }),
  ];
  return withElements(els, { gridModeEnabled: true, gridSize: 20 });
}

export const TEMPLATES = [
  { key: 'blank', label: 'Blank', hint: 'An empty board, Clean look', scene: () => emptyScene('clean') },
  { key: 'grid', label: 'Grid', hint: 'Snap to a 20 pt grid for diagrams', scene: grid },
  { key: 'kanban', label: 'Kanban', hint: 'To Do, Doing, Done as three frames', scene: kanban },
  { key: 'timeline', label: 'Timeline', hint: 'Seven weeks on a dated axis', scene: timeline },
  { key: 'floorplan', label: 'Floor Plan', hint: 'A 1 ft grid and a room to start from', scene: floorPlan },
];

export const templateByKey = (key) => TEMPLATES.find((t) => t.key === key) || TEMPLATES[0];

/** The saved scene string for a template, ready for createBoard({ scene }). */
export function templateScene(key) {
  const s = templateByKey(key).scene();
  return serializeScene({ elements: s.elements, appState: s.appState, filesMeta: s.files, look: s.look });
}
