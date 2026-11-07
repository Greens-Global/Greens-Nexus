// Board diagrams (Neil, 11/06/2026): the engine-free half of the diagram
// builder. A diagram is a plain graph - nodes { id, label, shape } and edges
// { from, to, label } - that the text box parses, the Nexus data sources
// produce, Tidy Up reads back off the board, and `layout` places. The
// engine adapter (`diagram.build`) turns a placed graph into board elements,
// so nothing here knows the engine.
//
// Shapes: step (rounded box), decision (diamond), terminal (oval - start /
// end), note (yellow box).

export const SHAPES = Object.freeze(['step', 'decision', 'terminal', 'note']);
export const SHAPE_LABEL = Object.freeze({ step: 'Step', decision: 'Decision', terminal: 'Start / End', note: 'Note' });
/** A new box's colors (Tidy Up keeps whatever a box already has). */
export const SHAPE_STYLE = Object.freeze({
  step: { stroke: '#1971c2', fill: '#e7f5ff' },
  decision: { stroke: '#e8590c', fill: '#fff4e6' },
  terminal: { stroke: '#2f9e44', fill: '#ebfbee' },
  note: { stroke: '#e67700', fill: '#fff9db' },
});
export const MAX_NODES = 200;

// ---- Text -> graph ---------------------------------------------------------
//
// One idea per line:
//   Request Time Off -> Manager Review -> Approved?
//   Approved? -yes-> Booked
//   Approved? -no-> (Declined)
// `->` joins steps (a label goes between the dashes: `-yes->`); a label that
// ends in `?` or is written <like this> is a decision, (like this) a start /
// end, [like this] a step, {like this} a note. A line with no arrow is a
// node; indent it under another line to hang it from that one (an outline
// becomes a tree - an org chart, a mind map). `//` starts a comment.

// A labeled arrow needs a space before its dash, so "Sign-Off" stays a name.
const ARROW = /\s+-([^>-]+)->\s*|\s*(?:->|→)\s*/;

/** One written node -> { key, label, shape }. The key is case-blind so
 *  "approved?" and "Approved?" are the same box. */
export function readNode(raw) {
  let s = String(raw || '').trim().replace(/^[-*•]\s+/, '');
  let shape = 'step';
  const wrap = s.match(/^([([<{])(.*)([)\]>}])$/);
  const pairs = { '(': ')', '[': ']', '<': '>', '{': '}' };
  if (wrap && pairs[wrap[1]] === wrap[3]) {
    s = wrap[2].trim();
    shape = { '(': 'terminal', '[': 'step', '<': 'decision', '{': 'note' }[wrap[1]];
  } else if (s.endsWith('?')) {
    shape = 'decision';
  }
  return s ? { key: s.toLowerCase(), label: s, shape } : null;
}

export function parseText(text) {
  const nodes = [];
  const byKey = new Map();
  const edges = [];
  const seenEdge = new Set();
  const stack = [];   // [{ indent, id }] - the outline's open parents
  const node = (n) => {
    const had = byKey.get(n.key);
    if (had) {
      if (n.shape !== 'step' && had.shape === 'step') had.shape = n.shape;   // a later (Start) marks it
      return had.id;
    }
    if (nodes.length >= MAX_NODES) return null;
    const made = { id: `n${nodes.length + 1}`, label: n.label, shape: n.shape };
    nodes.push(made); byKey.set(n.key, made);
    return made.id;
  };
  const edge = (from, to, label = '') => {
    if (!from || !to) return;
    const k = `${from}>${to}>${label}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from, to, label });
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s\/\/.*$|^\s*\/\/.*$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    const parts = line.split(ARROW);
    // split with one capture group: [node, label, node, label, node ...]
    const ids = [];
    const labels = [];
    for (let i = 0; i < parts.length; i += 2) {
      const n = readNode(parts[i]);
      ids.push(n ? node(n) : null);
      if (i + 1 < parts.length) labels.push((parts[i + 1] || '').trim());
    }
    for (let i = 0; i + 1 < ids.length; i += 1) edge(ids[i], ids[i + 1], labels[i]);
    // The outline: this line's first node hangs from the nearest line above
    // indented less than it.
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (ids[0] && stack.length && indent > 0) edge(stack[stack.length - 1].id, ids[0]);
    if (ids[0]) stack.push({ indent, id: ids[0] });
  }
  return { nodes, edges, truncated: nodes.length >= MAX_NODES };
}

// ---- Sizes -----------------------------------------------------------------

/** A node's box from its words: wide enough to read, wrapped past 220px.
 *  The engine wraps and measures the text itself; this only sizes the box. */
export function nodeSize(label, shape = 'step') {
  const chars = String(label || '').length || 1;
  const w = Math.min(220, Math.max(140, chars * 8.5 + 40));
  const lines = Math.max(1, Math.ceil((chars * 8.5) / (w - 32)));
  let h = Math.max(64, lines * 25 + 30);
  let width = w;
  if (shape === 'decision') { width = Math.round(w * 1.6); h = Math.round(h * 1.5); }   // a diamond's text room is its middle
  if (shape === 'terminal') { width = Math.round(w * 1.1); h = Math.max(h, 64); }
  return { w: Math.round(width), h };
}

// ---- Layout ----------------------------------------------------------------
//
// Layered, like a flowchart is drawn by hand: every node one rank below the
// furthest node pointing at it (loops are read as going back up), each rank
// ordered to keep crossings down (barycenter sweeps), each node centered
// under what points at it without overlapping its neighbors. `dir` is 'TB'
// (top to bottom) or 'LR' (left to right). Sizes already on a node (Tidy Up
// keeps a box's size) are kept.

const GAP_ALONG = 96;    // between ranks (room for an arrow label)
const GAP_ACROSS = 48;   // between neighbors in a rank

export function layout(graph, { dir = 'TB', origin = { x: 0, y: 0 } } = {}) {
  const nodes = (graph?.nodes || []).map((n) => {
    const size = n.w && n.h ? { w: n.w, h: n.h } : nodeSize(n.label, n.shape);
    return { ...n, ...size };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (graph?.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  if (!nodes.length) return { nodes: [], edges };
  const lr = dir === 'LR';
  // Work in "TB" terms: along = the rank axis, across = within a rank.
  const along = (n) => (lr ? n.w : n.h);
  const across = (n) => (lr ? n.h : n.w);
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const outs = nodes.map(() => []);
  for (const e of edges) outs[index.get(e.from)].push(index.get(e.to));

  // Back edges (loops) by DFS in reading order; ranking ignores them.
  const state = nodes.map(() => 0);   // 0 new, 1 on the path, 2 done
  const back = new Set();
  const visit = (start) => {
    const path = [[start, 0]];
    state[start] = 1;
    while (path.length) {
      const top = path[path.length - 1];
      const [v, k] = top;
      if (k < outs[v].length) {
        top[1] += 1;
        const w = outs[v][k];
        if (state[w] === 1) back.add(`${v}>${w}`);
        else if (state[w] === 0) { state[w] = 1; path.push([w, 0]); }
      } else { state[v] = 2; path.pop(); }
    }
  };
  // Sources first, so a loop back to the start does not make the start a middle.
  const indeg = nodes.map(() => 0);
  for (const e of edges) indeg[index.get(e.to)] += 1;
  nodes.forEach((_, i) => { if (!indeg[i] && !state[i]) visit(i); });
  nodes.forEach((_, i) => { if (!state[i]) visit(i); });
  const fwd = nodes.map(() => []);
  const ins = nodes.map(() => []);
  nodes.forEach((_, v) => outs[v].forEach((w) => { if (!back.has(`${v}>${w}`)) { fwd[v].push(w); ins[w].push(v); } }));

  // Longest-path ranks (Kahn).
  const rank = nodes.map(() => 0);
  const left = ins.map((l) => l.length);
  const queue = nodes.map((_, i) => i).filter((i) => !left[i]);
  for (let q = 0; q < queue.length; q += 1) {
    const v = queue[q];
    for (const w of fwd[v]) {
      rank[w] = Math.max(rank[w], rank[v] + 1);
      left[w] -= 1;
      if (!left[w]) queue.push(w);
    }
  }
  const ranks = [];
  queue.forEach((v) => { (ranks[rank[v]] ||= []).push(v); });

  // Order within ranks: barycenter of neighbors, a few sweeps down and up.
  const pos = nodes.map(() => 0);
  ranks.forEach((r) => r.forEach((v, i) => { pos[v] = i; }));
  const bary = (v, nbrs) => (nbrs.length ? nbrs.reduce((s, u) => s + pos[u], 0) / nbrs.length : pos[v]);
  for (let sweep = 0; sweep < 4; sweep += 1) {
    const down = sweep % 2 === 0;
    const order = down ? ranks.slice(1) : ranks.slice(0, -1).reverse();
    for (const r of order) {
      const key = new Map(r.map((v) => [v, bary(v, down ? ins[v] : fwd[v])]));
      r.sort((a, b) => key.get(a) - key.get(b) || pos[a] - pos[b]);
      r.forEach((v, i) => { pos[v] = i; });
    }
  }

  // Coordinates. Rank depth: each rank as deep as its deepest node.
  const depth = [];
  let at = 0;
  ranks.forEach((r, i) => {
    const d = Math.max(...r.map((v) => along(nodes[v])));
    depth[i] = { start: at, size: d };
    at += d + GAP_ALONG;
  });
  // Across: centered under what points at it, then pushed apart.
  const center = nodes.map(() => 0);
  ranks.forEach((r) => {
    let cursor = 0;
    const want = r.map((v) => {
      const width = across(nodes[v]);
      const parents = ins[v];
      const c = parents.length ? parents.reduce((s, u) => s + center[u], 0) / parents.length : cursor + width / 2;
      cursor += width + GAP_ACROSS;
      return c;
    });
    // Left to right, no overlaps.
    let edge = -Infinity;
    const placed = r.map((v, i) => {
      const half = across(nodes[v]) / 2;
      const c = Math.max(want[i], edge + GAP_ACROSS + half);
      edge = c + half;
      return c;
    });
    // Shift the rank back so it sits where it wanted to on average.
    const shift = r.length ? (want.reduce((s, c) => s + c, 0) - placed.reduce((s, c) => s + c, 0)) / r.length : 0;
    r.forEach((v, i) => { center[v] = placed[i] + shift; });
  });
  const minAcross = Math.min(...nodes.map((n, i) => center[i] - across(n) / 2));
  const out = nodes.map((n, i) => {
    const a = depth[rank[i]].start + (depth[rank[i]].size - along(n)) / 2;
    const c = center[i] - across(n) / 2 - minAcross;
    const x = Math.round(origin.x + (lr ? a : c));
    const y = Math.round(origin.y + (lr ? c : a));
    return { ...n, x, y };
  });
  return { nodes: out, edges, dir };
}

// ---- Board -> graph (Tidy Up) ----------------------------------------------
//
// The diagram to tidy: the selected boxes and every box tied to them by an
// arrow, or - nothing selected - every box tied by an arrow to another box.
// A box no arrow ties (a markup box round a problem on a picture, a loose
// note) never moves unless it is selected itself. `elements` is the board's
// element list; this reads only the element JSON every engine keeps (type,
// ids, bindings, the label text's containerId), never the engine.

const BOX = { rectangle: 'step', diamond: 'decision', ellipse: 'terminal' };
const STYLE_KEYS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness', 'angle', 'frameId', 'groupIds', 'link', 'customData'];

export function graphFromElements(elements, selectedIds = {}) {
  const live = (elements || []).filter((e) => e && !e.isDeleted);
  const anySelected = Object.values(selectedIds || {}).some(Boolean);
  const labelOf = new Map();   // container id -> its bound text element
  for (const e of live) if (e.type === 'text' && e.containerId) labelOf.set(e.containerId, e);
  const eligible = new Map(live.filter((e) => BOX[e.type] && !e.locked && !e.customData?.nexusComment).map((e) => [e.id, e]));
  const tied = live.filter((e) => e.type === 'arrow' && !e.locked
    && eligible.has(e.startBinding?.elementId) && eligible.has(e.endBinding?.elementId)
    && e.startBinding.elementId !== e.endBinding.elementId);
  // Grow from the start set along tied arrows, so no arrow is left with one
  // end moved and the other not.
  const picked = new Set(anySelected
    ? [...eligible.keys()].filter((id) => selectedIds[id])
    : tied.flatMap((a) => [a.startBinding.elementId, a.endBinding.elementId]));
  for (let grew = true; grew;) {
    grew = false;
    for (const a of tied) {
      const s = a.startBinding.elementId; const t = a.endBinding.elementId;
      if (picked.has(s) !== picked.has(t)) { picked.add(s); picked.add(t); grew = true; }
    }
  }
  const boxes = [...eligible.values()].filter((b) => picked.has(b.id));
  const arrows = tied.filter((a) => picked.has(a.startBinding.elementId));
  const nodes = boxes.map((b) => {
    const style = {};
    for (const k of STYLE_KEYS) if (b[k] !== undefined) style[k] = b[k];
    const t = labelOf.get(b.id);
    if (t) { style.fontSize = t.fontSize; style.fontFamily = t.fontFamily; style.textColor = t.strokeColor; style.textAlign = t.textAlign; style.verticalAlign = t.verticalAlign; }
    return { id: b.id, label: t?.originalText ?? t?.text ?? '', shape: BOX[b.type], w: b.width, h: b.height, style, version: b.version };
  });
  const edges = arrows.map((a) => {
    const t = labelOf.get(a.id);
    const style = {};
    for (const k of ['strokeColor', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness', 'frameId', 'groupIds']) if (a[k] !== undefined) style[k] = a[k];
    return { from: a.startBinding.elementId, to: a.endBinding.elementId, label: t?.originalText ?? t?.text ?? '', style };
  });
  // What the rebuild replaces: the boxes (kept ids), their labels, the arrows and theirs.
  const replaced = new Set([...boxes.map((b) => b.id), ...arrows.map((a) => a.id)]);
  for (const id of [...replaced]) { const t = labelOf.get(id); if (t) replaced.add(t.id); }
  const origin = boxes.length
    ? { x: Math.min(...boxes.map((b) => b.x)), y: Math.min(...boxes.map((b) => b.y)) }
    : { x: 0, y: 0 };
  return { graph: { nodes, edges }, replaced, origin };
}

/** Where an arrow between two placed boxes starts and ends: edge to edge
 *  along the flow (out the bottom, in the top - or right / left), `gap` clear
 *  of each box; an arrow going back up the flow leaves the top instead.
 *  Every shape here touches its box at the side midpoints, so the ends sit
 *  on the outline whatever the shape. */
export function edgePoints(a, c, dir = 'TB', gap = 0) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cc = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  if (dir === 'LR') {
    return c.x >= a.x + a.w ? [a.x + a.w + gap, ac.y, c.x - gap, cc.y] : [a.x - gap, ac.y, c.x + c.w + gap, cc.y];
  }
  return c.y >= a.y + a.h ? [ac.x, a.y + a.h + gap, cc.x, c.y - gap] : [ac.x, a.y - gap, cc.x, c.y + c.h + gap];
}

/** The bounds of a placed graph - where to put it, how big the preview is. */
export function bounds(placed) {
  const ns = placed?.nodes || [];
  if (!ns.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...ns.map((n) => n.x));
  const y = Math.min(...ns.map((n) => n.y));
  return { x, y, w: Math.max(...ns.map((n) => n.x + n.w)) - x, h: Math.max(...ns.map((n) => n.y + n.h)) - y };
}

/** Starters for the text box (they stand in for diagram templates). */
export const STARTERS = Object.freeze([
  { key: 'flow', label: 'Flowchart', text: '(Start) -> Gather the Details -> Ready?\nReady? -yes-> Do the Work -> (Done)\nReady? -no-> Ask for What Is Missing -> Gather the Details' },
  { key: 'approval', label: 'Approval Flow', text: '(Request Submitted) -> Manager Review -> Approved?\nApproved? -yes-> Finance Review -> Over Budget?\nOver Budget? -no-> (Approved)\nOver Budget? -yes-> Owner Sign-Off -> (Approved)\nApproved? -no-> (Sent Back)' },
  { key: 'decision', label: 'Decision Tree', text: 'Leak Reported?\n  Roof Leak?\n    Call the Roofer\n  Plumbing Leak?\n    Shut Off the Water\n    Call the Plumber' },
  { key: 'org', label: 'Org Chart', text: 'Owner\n  Operations Manager\n    Site Supervisor\n    Maintenance Lead\n  Finance Manager\n    Accountant' },
]);
