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
  // Every template says what it is and what to do with it, at the top (Neil,
  // 11/12/2026 - a board is read by its shape and its first line).
  const els = [...heading('Kanban', 'One sticky per piece of work. Move it right as it moves on.')];
  // The frame's own name is the column heading; nothing drawn inside repeats it.
  cols.forEach((name, i) => { els.push(frame(i * 400, 0, 360, 720, name)); });
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
  return withElements([], { gridModeEnabled: true, gridSize: 20 });
}

function floorPlan() {
  const els = [
    text(0, -80, 'Floor Plan', { size: 28 }),
    text(0, -40, 'Each grid square is 1 ft. Draw walls with the thick line, doors as arcs, and labels in gray.', { size: 14, color: NEXUS_COLORS.slate }),
    rect(0, 0, 480, 360, { strokeWidth: 2 }),
    text(200, 160, 'Room', { size: 20, color: NEXUS_COLORS.slate }),
  ];
  return withElements(els, { gridModeEnabled: true, gridSize: 20 });
}

// Named frames on a grid of 360-wide columns, the Kanban spacing (400 apart).
const frames = (names, perRow, h, top = 0) => names.map((name, i) => frame((i % perRow) * 400, top + Math.floor(i / perRow) * (h + 40), 360, h, name));

function heading(title, sub) {
  return [
    text(0, -100, title, { size: 28 }),
    text(0, -50, sub, { size: 16, color: NEXUS_COLORS.slate }),
  ];
}

function retro() {
  return withElements([
    ...heading('Retro', 'One sticky per thought. Vote on what to try next.'),
    ...frames(['What Went Well', 'What Did Not', 'What We Will Try'], 3, 720),
  ]);
}

function kickoff() {
  return withElements([
    ...heading('Kickoff', 'One sticky per point in each section. Agree the first milestones before you close.'),
    ...frames(['Goals', 'Scope', 'People and Roles', 'Risks', 'First Milestones'], 3, 400),
  ]);
}

function swot() {
  return withElements([
    ...heading('SWOT', 'What helps and what hurts, inside and out. One sticky per point.'),
    ...frames(['Strengths', 'Weaknesses', 'Opportunities', 'Threats'], 2, 400),
  ]);
}

function fishbone() {
  const els = [
    ...heading('Fishbone', 'Write each cause on a sticky along its bone.'),
    line(0, 300, 1000, 0, { strokeWidth: 2 }),
    rect(1020, 260, 200, 80, { strokeWidth: 2 }),
    text(1060, 285, 'Problem', { size: 20 }),
  ];
  // Three bones above the spine and three below, each angled in toward the head.
  [['People', -1], ['Process', -1], ['Equipment', -1], ['Materials', 1], ['Site', 1], ['Weather', 1]].forEach(([name, side], i) => {
    const x = 300 + (i % 3) * 300;
    const y = 300 + side * 220;
    els.push(line(x - 160, y, 160, -side * 220));
    els.push(text(x - 200, side < 0 ? y - 30 : y + 8, name, { size: 18 }));
  });
  return withElements(els);
}

function siteWalk() {
  return withElements([
    text(0, -130, 'Site Walk', { size: 28 }),
    text(0, -84, formatDate(new Date()), { size: 16, color: NEXUS_COLORS.slate }),
    text(0, -50, 'Drop a photo and a sticky in each stop.', { size: 16, color: NEXUS_COLORS.slate }),
    ...frames(['Stop 1', 'Stop 2', 'Stop 3', 'Stop 4', 'Stop 5', 'Stop 6'], 3, 360),
  ]);
}

function huddle() {
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return withElements([
    ...heading('Weekly Huddle', `Week of ${formatDate(monday)}`),
    ...frames(['Wins', 'Priorities This Week', 'Blockers', 'Shout-Outs'], 4, 600),
  ]);
}

export const TEMPLATES = [
  { key: 'blank', label: 'Blank', hint: 'An empty board, Clean look', scene: () => emptyScene('clean') },
  { key: 'grid', label: 'Grid', hint: 'Snaps to a grid for tidy diagrams', scene: grid },
  { key: 'kanban', label: 'Kanban', hint: 'To Do, Doing and Done columns', scene: kanban },
  { key: 'timeline', label: 'Timeline', hint: 'Seven weeks from this Sunday, dated', scene: timeline },
  { key: 'floorplan', label: 'Floor Plan', hint: 'A 1 ft grid and a room to start from', scene: floorPlan },
  { key: 'retro', label: 'Retro', hint: 'What went well, what did not, what to try', scene: retro },
  { key: 'kickoff', label: 'Kickoff', hint: 'Goals, scope, people, risks and milestones', scene: kickoff },
  { key: 'swot', label: 'SWOT', hint: 'Strengths, weaknesses, opportunities, threats', scene: swot },
  { key: 'fishbone', label: 'Fishbone', hint: 'Find the root cause of an incident', scene: fishbone },
  { key: 'sitewalk', label: 'Site Walk', hint: 'Six stops for photos and notes, dated today', scene: siteWalk },
  { key: 'huddle', label: 'Weekly Huddle', hint: 'Wins, priorities, blockers and shout-outs', scene: huddle },
];

export const templateByKey = (key) => TEMPLATES.find((t) => t.key === key) || TEMPLATES[0];

/** The saved scene string for a template, ready for createBoard({ scene }). */
export function templateScene(key) {
  const s = templateByKey(key).scene();
  return serializeScene({ elements: s.elements, appState: s.appState, filesMeta: s.files, look: s.look });
}
