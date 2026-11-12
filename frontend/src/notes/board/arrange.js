// Arrange (Neil, 11/12/2026): Tidy Up for anything, plus Align and Space
// Evenly on a selection. Until now Tidy Up existed only for diagram boxes
// joined by arrows (Diagram > Tidy Up re-lays the flow); a meeting's stickies
// and pictures had nothing. This is the plain rule the best whiteboards use:
// measure what looks wrong (overlaps, uneven gaps, things poking out of
// their section) and fix it in the fewest moves, never by making anything
// again - the same elements, moved, so comments, votes, links and task
// states stay on them (rideAlong.js brings the riders).
//
// Engine-free. What moves is a UNIT: a sticky with its words and author
// line, a box with its label, an engine group, or a whole section with what
// it holds. Boxes joined by arrows are left to Diagram > Tidy Up, which
// knows how to route the arrows again; moving them here would leave the
// arrows behind.
export const ARRANGE_GAP = 24;
const PAD = 24;
const nonce = () => Math.floor(Math.random() * 0x7fffffff);
const bump = (e, patch, now) => ({ ...e, ...patch, version: (Number(e.version) || 0) + 1, versionNonce: nonce(), updated: now });
const live = (e) => !!e && !e.isDeleted;
const near = (a, b) => Math.abs(a - b) < 0.5;
const picked = (ids) => new Set(Object.keys(ids || {}).filter((k) => ids[k]));
const isArrow = (e) => e.type === 'arrow' || e.type === 'line';
const joined = (e) => (e.boundElements || []).some((b) => b?.type === 'arrow') || (isArrow(e) && (e.startBinding || e.endBinding));
const isRider = (e) => !!e.customData?.nexusComment || !!e.customData?.nexusVoteLine;

const boxOf = (members) => {
  const x1 = Math.min(...members.map((e) => e.x)), y1 = Math.min(...members.map((e) => e.y));
  const x2 = Math.max(...members.map((e) => e.x + (e.width || 0))), y2 = Math.max(...members.map((e) => e.y + (e.height || 0)));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
};

/**
 * The units a selection is made of: [{ key, members, x, y, w, h, frameId,
 * section }] in reading order. `skipped` counts the boxes joined by arrows
 * that were left out. A comment pin or a vote line is never a unit of its
 * own - it rides on its item.
 */
export function unitsOf(elements, ids) {
  const pick = picked(ids);
  const els = (elements || []).filter(live);
  const byId = new Map(els.map((e) => [e.id, e]));
  const units = new Map();
  let skipped = 0;
  const add = (key, members, extra = {}) => { if (members.length && !units.has(key)) units.set(key, { key, members, ...boxOf(members), ...extra }); };
  for (const id of pick) {
    const e = byId.get(id);
    if (!e || isRider(e)) continue;
    if (e.type === 'frame') {
      // a section moves with everything it holds
      const held = els.filter((x) => x.frameId === e.id);
      add(`f:${e.id}`, [e, ...held], { section: true, frameId: null });
      continue;
    }
    const root = e.containerId ? byId.get(e.containerId) || e : e;
    const groups = root.groupIds || [];
    const group = groups[groups.length - 1];
    const members = group
      ? els.filter((x) => (x.groupIds || []).includes(group) && !isRider(x))
      : [root, ...els.filter((x) => x.containerId === root.id)];
    if (members.some(joined)) { skipped += 1; continue; }
    add(group ? `g:${group}` : `e:${root.id}`, members, { frameId: root.frameId || null });
  }
  // A unit inside a selected section travels with the section, not by itself.
  const inSection = new Set([...units.values()].filter((u) => u.section).flatMap((u) => u.members.map((m) => m.id)));
  const out = [...units.values()].filter((u) => u.section || !u.members.some((m) => inSection.has(m.id)));
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return { units: out, skipped };
}

const shifted = (unit, dx, dy, now, moved) => {
  if (near(dx, 0) && near(dy, 0)) return;
  for (const m of unit.members) moved.set(m.id, bump(moved.get(m.id) || m, { x: (moved.get(m.id) || m).x + dx, y: (moved.get(m.id) || m).y + dy }, now));
};

const ALIGN = {
  left: (u, b) => [b.x - u.x, 0],
  center: (u, b) => [b.x + b.w / 2 - (u.x + u.w / 2), 0],
  right: (u, b) => [b.x + b.w - (u.x + u.w), 0],
  top: (u, b) => [0, b.y - u.y],
  middle: (u, b) => [0, b.y + b.h / 2 - (u.y + u.h / 2)],
  bottom: (u, b) => [0, b.y + b.h - (u.y + u.h)],
};
export const ARRANGE_ACTIONS = Object.freeze([
  { key: 'tidy', label: 'Tidy Up', min: 2 },
  { key: 'left', label: 'Align Left', min: 2 },
  { key: 'center', label: 'Align Center', min: 2 },
  { key: 'right', label: 'Align Right', min: 2 },
  { key: 'top', label: 'Align Top', min: 2 },
  { key: 'middle', label: 'Align Middle', min: 2 },
  { key: 'bottom', label: 'Align Bottom', min: 2 },
  { key: 'spread-x', label: 'Space Evenly Across', min: 3 },
  { key: 'spread-y', label: 'Space Evenly Down', min: 3 },
]);

/** Rows as a person reads them: a unit starting within half the row's first unit's height is on that row. */
function rowsOf(units) {
  const rows = [];
  for (const u of [...units].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && u.y - row[0].y < Math.max(1, row[0].h) / 2) row.push(u); else rows.push([u]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

/**
 * Tidy Up: the units in even rows - the rows a person already sees, each
 * left to right with the same gap, one row under the last, wrapped where a
 * row would run wider than its section (or, on open board, wider than a
 * rough square). A unit already where it belongs is not touched.
 */
function tidy(units, { frame, now, moved }) {
  const x0 = frame ? frame.x + PAD : Math.min(...units.map((u) => u.x));
  const y0 = frame ? Math.max(frame.y + PAD, Math.min(...units.map((u) => u.y))) : Math.min(...units.map((u) => u.y));
  const widest = Math.max(...units.map((u) => u.w));
  const room = frame
    ? Math.max(widest, frame.width - PAD * 2)
    : Math.max(widest, Math.ceil(Math.sqrt(units.length) + 0.999) * (widest + ARRANGE_GAP) - ARRANGE_GAP);
  const lines = [];
  for (const row of rowsOf(units)) {
    let line = [], w = 0;
    for (const u of row) {
      if (line.length && w + ARRANGE_GAP + u.w > room + 0.5) { lines.push(line); line = []; w = 0; }
      w += (line.length ? ARRANGE_GAP : 0) + u.w;
      line.push(u);
    }
    if (line.length) lines.push(line);
  }
  let y = y0, right = x0, bottom = y0;
  for (const line of lines) {
    let x = x0;
    const h = Math.max(...line.map((u) => u.h));
    for (const u of line) { shifted(u, x - u.x, y - u.y, now, moved); x += u.w + ARRANGE_GAP; }
    right = Math.max(right, x - ARRANGE_GAP);
    bottom = Math.max(bottom, y + h);
    y += h + ARRANGE_GAP;
  }
  return { right, bottom };
}

/**
 * One arrange action on the selection. Returns { elements, moved, skipped }:
 * `elements` is the same array when nothing had to move. `moved` counts the
 * units that changed place, `skipped` the arrow-joined boxes left alone.
 */
export function arrange(elements, ids, action, { now = Date.now() } = {}) {
  let { units, skipped } = unitsOf(elements, ids);
  const byId = new Map((elements || []).filter(live).map((e) => [e.id, e]));
  let frame = null;
  // One section picked: tidy what it holds, inside it.
  if (action === 'tidy' && units.length === 1 && units[0].section) {
    frame = units[0].members[0];
    const inside = Object.fromEntries(units[0].members.slice(1).map((m) => [m.id, true]));
    ({ units, skipped } = unitsOf(elements, inside));
  } else if (action === 'tidy' && units.length && units.every((u) => u.frameId && u.frameId === units[0].frameId)) {
    frame = byId.get(units[0].frameId) || null;   // all in one section: stay inside it
  }
  const need = ARRANGE_ACTIONS.find((a) => a.key === action)?.min || 2;
  if (units.length < need) return { elements, moved: 0, skipped };
  const moved = new Map();
  if (action === 'tidy') {
    const { right, bottom } = tidy(units, { frame, now, moved });
    // The section grows to hold what it holds - never the other way round.
    if (frame && moved.size) {
      const w = Math.max(frame.width, right + PAD - frame.x), h = Math.max(frame.height, bottom + PAD - frame.y);
      if (!near(w, frame.width) || !near(h, frame.height)) moved.set(frame.id, bump(frame, { width: w, height: h }, now));
    }
  } else if (ALIGN[action]) {
    const b = { x: Math.min(...units.map((u) => u.x)), y: Math.min(...units.map((u) => u.y)) };
    b.w = Math.max(...units.map((u) => u.x + u.w)) - b.x;
    b.h = Math.max(...units.map((u) => u.y + u.h)) - b.y;
    for (const u of units) { const [dx, dy] = ALIGN[action](u, b); shifted(u, dx, dy, now, moved); }
  } else if (action === 'spread-x' || action === 'spread-y') {
    const ax = action === 'spread-x';
    const at = (u) => (ax ? u.x : u.y), len = (u) => (ax ? u.w : u.h);
    const line = [...units].sort((a, b) => at(a) - at(b));
    const first = line[0], last = line[line.length - 1];
    const free = at(last) + len(last) - at(first) - line.reduce((s, u) => s + len(u), 0);
    const gap = free / (line.length - 1);
    let cursor = at(first);
    for (const u of line) { const d = cursor - at(u); shifted(u, ax ? d : 0, ax ? 0 : d, now, moved); cursor += len(u) + gap; }
  } else return { elements, moved: 0, skipped };
  if (!moved.size) return { elements, moved: 0, skipped };
  const touched = new Set(units.filter((u) => u.members.some((m) => moved.has(m.id))).map((u) => u.key));
  return { elements: elements.map((e) => moved.get(e.id) || e), moved: touched.size, skipped };
}
