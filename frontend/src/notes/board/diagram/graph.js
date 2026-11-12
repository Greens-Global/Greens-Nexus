// Board diagrams (Neil, 11/06/2026): the engine-free half of the diagram
// builder. A diagram is a plain graph - nodes { id, label, shape, glyph },
// edges { from, to, label, kind } and groups { id, label, glyph, parent,
// members } - that the text box parses, the Nexus data sources produce, Tidy
// Up reads back off the board, and `layout` places. The engine adapter
// (`diagram.build`) turns a placed graph into board elements, so nothing here
// knows the engine.
//
// Shapes: step (rounded box), decision (diamond), terminal (oval - start /
// end), note (yellow box). Groups, arrow kinds, icons and arrows that never
// cross a label (Neil, 11/08/2026) follow caru-ini/stack-diagram (MIT): a
// group is a labeled box round its members (one more group may sit inside
// it), `=>` the main flow, `->` a normal arrow, `-.->` a dashed one, every
// arrow drawn in right angles round the boxes in its way.
import { readGlyph, glyphSize } from './glyphs';

export const SHAPES = Object.freeze(['step', 'decision', 'terminal', 'note']);
export const SHAPE_LABEL = Object.freeze({ step: 'Step', decision: 'Decision', terminal: 'Start / End', note: 'Note' });
/** A new box's colors (Tidy Up keeps whatever a box already has). */
export const SHAPE_STYLE = Object.freeze({
  step: { stroke: '#1971c2', fill: '#e7f5ff' },
  decision: { stroke: '#e8590c', fill: '#fff4e6' },
  terminal: { stroke: '#2f9e44', fill: '#ebfbee' },
  note: { stroke: '#e67700', fill: '#fff9db' },
});
/** The three arrows: the main flow in the brand accent and thicker, a
 *  normal arrow in ink, a dashed one in a quieter gray. */
export const EDGE_STYLE = Object.freeze({
  main: { stroke: '#15803d', width: 3, dash: false },
  normal: { stroke: '#1c2420', width: 2, dash: false },
  dashed: { stroke: '#6b7280', width: 2, dash: true },
});
/** A group's box: a thin outline on a light tint; a group inside a group a
 *  shade deeper, so the two read apart. */
export const GROUP_STYLE = Object.freeze({
  outer: { stroke: '#adb5bd', fill: '#f8f9fa', ink: '#495057' },
  inner: { stroke: '#ced4da', fill: '#eef1f4', ink: '#495057' },
});
export const MAX_NODES = 200;
export const MAX_GROUPS = 40;

// ---- Text -> graph ---------------------------------------------------------
//
// One idea per line:
//   Request Time Off -> Manager Review -> Approved?
//   Approved? -yes-> Booked
//   Approved? -no-> (Declined)
// Three arrows: `=>` the main flow, `->` a normal arrow, `-.->` a dashed one
// (setup, a sync, an occasional link). Each takes a label: `=yes=>`,
// `-yes->`, `-.nightly.->` (a labeled arrow needs a space before it, so
// "Sign-Off" stays a name). `→` is `->`.
// A label that ends in `?` or is written <like this> is a decision, (like
// this) a start / end, [like this] a step, {like this} a note. `Gate | lock`
// (or `[Gate | lock]`) puts an icon on the box - a Lucide name, or
// `drawing:gate` for a Training drawing (glyphs.jsx).
// A line ending in `:` opens a GROUP (`Escondido:` or `Azure | cloud:`): the
// lines indented under it are its members, and a group may hold one more
// group inside it. A line with no arrow is a node; indent it under another
// node to hang it from that one (an outline becomes a tree - an org chart, a
// mind map). `//` starts a comment.

const ARROWS = /\s+-\.([^.>]+?)\.->\s*|\s*-\.->\s*|\s+=([^=>]+?)=>\s*|\s*=>\s*|\s+-([^>]+?)->\s*|\s*(?:->|→)\s*/g;

/** A line -> its node texts and the arrows between them ({ kind, label }). */
export function splitArrows(line) {
  const parts = [];
  const links = [];
  let last = 0;
  ARROWS.lastIndex = 0;
  for (let m = ARROWS.exec(line); m; m = ARROWS.exec(line)) {
    if (!m[0].length) { ARROWS.lastIndex += 1; continue; }
    parts.push(line.slice(last, m.index));
    const kind = m[1] !== undefined || m[0].includes('-.->') ? 'dashed' : m[2] !== undefined || m[0].includes('=>') ? 'main' : 'normal';
    links.push({ kind, label: (m[1] ?? m[2] ?? m[3] ?? '').trim() });
    last = ARROWS.lastIndex;
  }
  parts.push(line.slice(last));
  return { parts, links };
}

/** `Name | icon` -> [name, icon words]. */
function splitGlyph(s) {
  const at = s.lastIndexOf('|');
  return at < 0 ? [s, ''] : [s.slice(0, at).trim(), s.slice(at + 1).trim()];
}

/** One written node -> { key, label, shape, glyph, unknown }. The key is
 *  case-blind so "approved?" and "Approved?" are the same box. */
export function readNode(raw) {
  let s = String(raw || '').trim().replace(/^[-*•]\s+/, '');
  let shape = 'step';
  const pairs = { '(': ')', '[': ']', '<': '>', '{': '}' };
  const wrapOf = (t) => { const m = t.match(/^([([<{])(.*)([)\]>}])$/); return m && pairs[m[1]] === m[3] ? m : null; };
  // `[Gate | lock]` or `(Start) | flag`: the icon may sit inside the marks or after them.
  let icon = '';
  let wrap = wrapOf(s);
  if (!wrap) { [s, icon] = splitGlyph(s); wrap = wrapOf(s); }
  if (wrap) {
    s = wrap[2].trim();
    shape = { '(': 'terminal', '[': 'step', '<': 'decision', '{': 'note' }[wrap[1]];
    if (!icon) [s, icon] = splitGlyph(s);
  } else if (s.endsWith('?')) {
    shape = 'decision';
  }
  const { glyph, unknown } = readGlyph(icon);
  return s ? { key: s.toLowerCase(), label: s, shape, glyph, unknown } : null;
}

export function parseText(text) {
  const nodes = [];
  const byKey = new Map();
  const edges = [];
  const seenEdge = new Set();
  const groups = [];
  const groupByKey = new Map();
  const grouped = new Set();   // node ids already in a group (the first group a node is written in keeps it)
  const notes = [];
  const note = (t) => { if (!notes.includes(t) && notes.length < 6) notes.push(t); };
  const stack = [];   // [{ indent, id } | { indent, group }] - the outline's open parents
  const node = (n) => {
    if (n.unknown) note(`No icon is called "${n.unknown}" - "${n.label}" has none.`);
    const had = byKey.get(n.key);
    if (had) {
      if (n.shape !== 'step' && had.shape === 'step') had.shape = n.shape;   // a later (Start) marks it
      if (n.glyph && !had.glyph) had.glyph = n.glyph;
      return had.id;
    }
    if (nodes.length >= MAX_NODES) return null;
    const made = { id: `n${nodes.length + 1}`, label: n.label, shape: n.shape };
    if (n.glyph) made.glyph = n.glyph;
    nodes.push(made); byKey.set(n.key, made);
    return made.id;
  };
  const edge = (from, to, label = '', kind = 'normal') => {
    if (!from || !to) return;
    const k = `${from}>${to}>${label}>${kind}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push(kind === 'normal' ? { from, to, label } : { from, to, label, kind });
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s\/\/.*$|^\s*\/\/.*$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const inGroup = [...stack].reverse().find((e) => e.group)?.group || '';
    const { parts, links } = splitArrows(line);
    // A group: a line ending in ':' with no arrow in it.
    const head = !links.length && line.trim().match(/^(.*[^:\s])\s*:$/);
    if (head) {
      const [name, icon] = splitGlyph(head[1].trim());
      const parent = groups.find((g) => g.id === inGroup);
      if (parent?.parent) {   // a third level folds into the group it is in
        note(`Groups go two levels deep - "${name}" is part of "${parent.label}".`);
        stack.push({ indent, group: inGroup });
        continue;
      }
      let g = groupByKey.get(name.toLowerCase());
      if (!g && groups.length < MAX_GROUPS) {
        const { glyph, unknown } = readGlyph(icon);
        if (unknown) note(`No icon is called "${unknown}" - "${name}" has none.`);
        g = { id: `g${groups.length + 1}`, label: name, glyph, parent: inGroup, members: [] };
        groups.push(g); groupByKey.set(name.toLowerCase(), g);
      }
      stack.push({ indent, group: g ? g.id : inGroup });
      continue;
    }
    // [node, node, node ...] and the arrows between them
    const ids = parts.map((p) => { const n = readNode(p); return n ? node(n) : null; });
    for (let i = 0; i + 1 < ids.length; i += 1) edge(ids[i], ids[i + 1], links[i].label, links[i].kind);
    if (inGroup) {
      const g = groups.find((x) => x.id === inGroup);
      for (const id of ids) if (id && !grouped.has(id)) { grouped.add(id); g.members.push(id); }
    }
    // The outline: this line's first node hangs from the nearest node line
    // above indented less than it (a group above it holds it instead).
    const top = stack[stack.length - 1];
    if (ids[0] && top?.id && indent > 0) edge(top.id, ids[0]);
    if (ids[0]) stack.push({ indent, id: ids[0] });
  }
  // A group with nothing in it (and no group with something in it) is dropped.
  const full = new Set(groups.filter((g) => g.members.length).map((g) => g.id));
  for (const g of groups) if (g.parent && full.has(g.id)) full.add(g.parent);
  return { nodes, edges, groups: groups.filter((g) => full.has(g.id)), notes, truncated: nodes.length >= MAX_NODES };
}

// ---- Sizes -----------------------------------------------------------------

const GLYPH_PAD = 10;   // above a box's glyph
const GLYPH_GAP = 4;    // between the glyph and the words

/** A node's box from its words: wide enough to read, wrapped past 220px.
 *  The engine wraps and measures the text itself; this only sizes the box.
 *  A box with a glyph is taller: the glyph sits above the words. */
export function nodeSize(label, shape = 'step', glyph = '') {
  const chars = String(label || '').length || 1;
  const w = Math.min(220, Math.max(140, chars * 8.5 + 40));
  const lines = Math.max(String(label || '').split('\n').length, Math.ceil((chars * 8.5) / (w - 32)));
  let h = Math.max(64, lines * 25 + 30);
  if (glyph) h = Math.max(h, lines * 23 + 2 * (glyphSize(glyph).h + GLYPH_GAP + GLYPH_PAD));
  let width = w;
  if (shape === 'decision') { width = Math.round(w * 1.6); h = Math.round(h * 1.5); }   // a diamond's text room is its middle
  if (shape === 'terminal') { width = Math.round(w * 1.1); h = Math.max(h, 64); }
  return { w: Math.round(width), h };
}

/** Where a placed box's glyph goes: centered, above the words. */
export function glyphBox(n) {
  const { w, h } = glyphSize(n.glyph);
  const top = n.shape === 'decision' ? n.h * 0.2 : n.shape === 'terminal' ? n.h * 0.16 : GLYPH_PAD;
  return { x: Math.round(n.x + (n.w - w) / 2), y: Math.round(n.y + top), w, h };
}

// ---- Layout ----------------------------------------------------------------
//
// Layered, like a flowchart is drawn by hand: every node one rank below the
// furthest node pointing at it (loops are read as going back up), each rank
// ordered to keep crossings down (barycenter sweeps), each node centered
// under what points at it without overlapping its neighbors. `dir` is 'TB'
// (top to bottom) or 'LR' (left to right). Sizes already on a node (Tidy Up
// keeps a box's size) are kept. With groups, each group is laid out on its
// own first (inner groups before outer) and then stands in as one box at
// the level above, so its members stay together and nothing sticks out.

const GAP_ALONG = 96;    // between ranks (room for an arrow label)
const GAP_ACROSS = 48;   // between neighbors in a rank
export const GROUP_PAD = 24;    // a group box's padding, left, right and bottom
export const GROUP_HEAD = 60;   // its top: the label row, then a band an arrow can come in along
export const GROUP_LABEL = { dx: 12, dy: 10, size: 16, glyph: 16 };

export function layout(graph, opts = {}) {
  const groups = (graph?.groups || []).filter((g) => g?.id && (g.members?.length || (graph.groups || []).some((x) => x.parent === g.id)));
  if (!groups.length) return { ...layoutFlat(graph, opts), groups: [] };
  return layoutGroups(graph, groups, opts);
}

/** A group label's width: its words, and its glyph. */
export function groupLabelWidth(g) {
  return Math.round(String(g.label || '').length * 8.6 + (g.glyph ? GROUP_LABEL.glyph + 6 : 0) + GROUP_LABEL.dx * 2);
}

function layoutGroups(graph, groupList, { dir = 'TB', origin = { x: 0, y: 0 } } = {}) {
  const nodes = (graph?.nodes || []).map((n) => {
    const size = n.w && n.h ? { w: n.w, h: n.h } : nodeSize(n.label, n.shape, n.glyph);
    return { ...n, ...size };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const byId = new Map(groupList.map((g) => [g.id, g]));
  // One level of nesting: a parent that is missing, or itself inside a group, is dropped.
  const parentOf = new Map(groupList.map((g) => [g.id, byId.has(g.parent) && !byId.get(g.parent).parent ? g.parent : '']));
  const groupOf = new Map();
  for (const g of groupList) for (const m of g.members || []) if (nodeIds.has(m) && !groupOf.has(m)) groupOf.set(m, g.id);
  const gkey = (id) => `group:${id}`;
  const itemParent = (item) => (item.startsWith('group:') ? parentOf.get(item.slice(6)) : groupOf.get(item) || '');
  // An endpoint seen from level L: the node, or the group holding it that sits at L.
  const liftTo = (nid, level) => {
    let item = nid;
    for (let hops = 0; hops < 3 && item; hops += 1) {
      const p = itemParent(item);
      if (p === level) return item;
      if (!p) return null;
      item = gkey(p);
    }
    return null;
  };
  const kids = new Map();
  const addKid = (level, item) => { if (!kids.has(level)) kids.set(level, []); kids.get(level).push(item); };
  nodes.forEach((n) => addKid(groupOf.get(n.id) || '', n.id));
  groupList.forEach((g) => addKid(parentOf.get(g.id), gkey(g.id)));
  const size = new Map(nodes.map((n) => [n.id, { w: n.w, h: n.h }]));
  const local = new Map();   // item -> its place inside its group
  const levelPlaced = (level, origin0) => {
    const items = (kids.get(level) || []).filter((id) => size.has(id)).map((id) => ({ id, label: '', ...size.get(id) }));
    const seen = new Set();
    const edges = [];
    for (const e of graph.edges || []) {
      const a = liftTo(e.from, level); const b = liftTo(e.to, level);
      if (!a || !b || a === b || seen.has(`${a}>${b}`)) continue;
      seen.add(`${a}>${b}`);
      edges.push({ from: a, to: b });
    }
    return layoutFlat({ nodes: items, edges }, { dir, origin: origin0, wrap: true }).nodes;
  };
  // Inner groups first, then the outer ones: each is its content plus the padding and its label.
  const order = [...groupList.filter((g) => parentOf.get(g.id)), ...groupList.filter((g) => !parentOf.get(g.id))];
  for (const g of order) {
    const placed = levelPlaced(g.id, { x: 0, y: 0 });
    if (!placed.length) continue;
    const minX = Math.min(...placed.map((p) => p.x)); const minY = Math.min(...placed.map((p) => p.y));
    const cw = Math.max(...placed.map((p) => p.x + p.w)) - minX;
    const ch = Math.max(...placed.map((p) => p.y + p.h)) - minY;
    const w = Math.max(cw + GROUP_PAD * 2, groupLabelWidth(g));
    const h = ch + GROUP_HEAD + GROUP_PAD;
    const dx = Math.round((w - cw) / 2) - minX; const dy = GROUP_HEAD - minY;
    for (const p of placed) local.set(p.id, { x: p.x + dx, y: p.y + dy });
    size.set(gkey(g.id), { w, h });
  }
  // The top level, then everything inside it by its group's place.
  const abs = new Map();
  for (const p of levelPlaced('', origin)) abs.set(p.id, { x: p.x, y: p.y });
  const place = (item) => {
    if (!item.startsWith('group:')) return;
    const at = abs.get(item);
    for (const k of kids.get(item.slice(6)) || []) {
      const l = local.get(k);
      if (!l || !at) continue;
      abs.set(k, { x: at.x + l.x, y: at.y + l.y });
      place(k);
    }
  };
  for (const k of kids.get('') || []) place(k);
  const outNodes = nodes.map((n) => ({ ...n, ...(abs.get(n.id) || { x: origin.x, y: origin.y }) }));
  const ids = new Set(outNodes.map((n) => n.id));
  const edges = (graph?.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const groups = order.slice().reverse()   // outer first: they are drawn behind the inner ones
    .filter((g) => abs.has(gkey(g.id)))
    .map((g) => ({
      id: g.id, label: g.label, glyph: g.glyph || '', parent: parentOf.get(g.id), ...(g.named ? { named: true } : {}),
      members: (g.members || []).filter((m) => groupOf.get(m) === g.id),
      ...abs.get(gkey(g.id)), ...size.get(gkey(g.id)),
    }));
  return { nodes: outNodes, edges, dir, groups };
}

function layoutFlat(graph, { dir = 'TB', origin = { x: 0, y: 0 }, wrap = false } = {}) {
  const nodes = (graph?.nodes || []).map((n) => {
    const size = n.w && n.h ? { w: n.w, h: n.h } : nodeSize(n.label, n.shape, n.glyph);
    return { ...n, ...size };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (graph?.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  if (!nodes.length) return { nodes: [], edges };
  // Inside a group, members with no arrow between them sit in a grid, not one long row.
  if (wrap && !edges.length && nodes.length > 3) return gridLayout(nodes, origin, dir);
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

  // A long straight run wraps (Neil, 11/12/2026): past CHAIN_WRAP boxes a
  // process takes the next row, starting again at the start - never one line
  // longer than a person reads without scrolling. Only a plain chain (one
  // box after another, no branch, no loop); anything else keeps its layers.
  if (ranks.length > CHAIN_WRAP && ranks.every((r) => r.length === 1) && !back.size && edges.length === nodes.length - 1) {
    return chainLayout(ranks.map((r) => nodes[r[0]]), edges, { dir, origin });
  }

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

export const CHAIN_WRAP = 6;
/** A chain in lines of CHAIN_WRAP: rows for Left to Right (each starting
 *  again at the left), columns for Top to Bottom (each starting again at
 *  the top). Every box sits centered in a cell the size of the largest. */
function chainLayout(chain, edges, { dir, origin }) {
  const lr = dir === 'LR';
  const cellW = Math.max(...chain.map((n) => n.w));
  const cellH = Math.max(...chain.map((n) => n.h));
  const out = chain.map((n, i) => {
    const step = i % CHAIN_WRAP, line = Math.floor(i / CHAIN_WRAP);
    const col = lr ? step : line, row = lr ? line : step;
    // along the flow: room for an arrow label; between the lines: room for the arrow that comes back
    const gapX = lr ? GAP_ALONG : GAP_ALONG;
    const gapY = lr ? GAP_ALONG : GAP_ALONG;
    return { ...n, x: Math.round(origin.x + col * (cellW + gapX) + (cellW - n.w) / 2), y: Math.round(origin.y + row * (cellH + gapY) + (cellH - n.h) / 2) };
  });
  return { nodes: out, edges, dir };
}

/** Unconnected boxes in rows (columns, left to right), each cell centered. */
function gridLayout(nodes, origin, dir) {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const lines = [];
  nodes.forEach((n, i) => { (lines[Math.floor(i / cols)] ||= []).push(n); });
  const cellW = Math.max(...nodes.map((n) => n.w));
  const cellH = Math.max(...nodes.map((n) => n.h));
  const out = [];
  lines.forEach((line, r) => line.forEach((n, c) => {
    const [col, row] = dir === 'LR' ? [r, c] : [c, r];
    out.push({ ...n, x: Math.round(origin.x + col * (cellW + GAP_ACROSS) + (cellW - n.w) / 2), y: Math.round(origin.y + row * (cellH + GAP_ACROSS) + (cellH - n.h) / 2) });
  }));
  return { nodes: out, edges: [], dir };
}

// ---- Arrows ----------------------------------------------------------------
//
// Every arrow is drawn in right angles (an elbow arrow on the board) from the
// side of one box to the side of the next: out the bottom and in the top
// along the flow (right / left for Left to Right), a loop back out the side.
// The way round is chosen so the arrow never runs through another box or a
// group's label: straight down if it can, else a Z through the gap between
// the ranks, else down a free lane beside the boxes in its way.

const CLEAR = 8;   // how far an arrow keeps from a box it passes

/** How many of `rects` a route runs through (0 = a clean way round),
 *  counting no further than `stopAt`. */
export function crossings(pts, rects, stopAt = Infinity) {
  let n = 0;
  for (const r of rects) {
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const [x1, y1] = pts[i]; const [x2, y2] = pts[i + 1];
      if (Math.min(x1, x2) < r.x + r.w && Math.max(x1, x2) > r.x && Math.min(y1, y2) < r.y + r.h && Math.max(y1, y2) > r.y) { n += 1; break; }
    }
    if (n >= stopAt) break;
  }
  return n;
}
/** The first clean route of `tries`, else the one through the fewest things. */
export function bestRoute(tries, obs) {
  let best = tries[0]; let fewest = Infinity;
  for (const p of tries) {
    const n = crossings(p, obs, fewest);
    if (n === 0) return p;
    if (n < fewest) { best = p; fewest = n; }
  }
  return best;
}
const flip = (r) => ({ x: r.y, y: r.x, w: r.h, h: r.w });

/** What the arrows of one placed diagram may have to miss, worked out once:
 *  each box with its clearance, each group's label row, and each group's
 *  wall with the boxes it holds (an arrow goes round a group holding
 *  neither of its ends rather than through it). */
function obstacleSet(placed) {
  const groups = placed?.groups || [];
  return {
    boxes: (placed?.nodes || []).map((n) => ({ id: n.id, r: { x: n.x - CLEAR, y: n.y - CLEAR, w: n.w + 2 * CLEAR, h: n.h + 2 * CLEAR } })),
    labels: groups.map((g) => ({ x: g.x + GROUP_LABEL.dx - 4, y: g.y + GROUP_LABEL.dy - 4, w: groupLabelWidth(g) - GROUP_LABEL.dx, h: GROUP_LABEL.size + 12 })),
    walls: groups.map((g) => ({
      holds: new Set([...(g.members || []), ...groups.filter((k) => k.parent === g.id).flatMap((k) => k.members || [])]),
      r: { x: g.x - 4, y: g.y - 4, w: g.w + 8, h: g.h + 8 },
    })),
  };
}
function obstaclesFor(set, except) {
  return [
    ...set.boxes.filter((b) => !except.includes(b.id)).map((b) => b.r),
    ...set.labels,
    ...(except.length ? set.walls.filter((w) => !except.some((id) => w.holds.has(id))).map((w) => w.r) : []),
  ];
}

/** The obstacles an arrow must miss: every box but its own two, every
 *  group's label row, and every group holding neither end. */
export function obstacles(placed, except = []) {
  return obstaclesFor(obstacleSet(placed), except);
}

function routeWith(a, c, obs, lr, gap, port) {
  const T = lr ? flip : (r) => r;
  const pts = routeTB(T(a), T(c), lr ? obs.map(flip) : obs, gap, port?.from ?? 0.5, port?.to ?? 0.5, port?.bend);
  const clean = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  return lr ? clean.map(([x, y]) => [y, x]) : clean;
}

/** The way an arrow goes from box `a` to box `c`: a list of [x, y] points,
 *  all turns right angles, its ends `gap` clear of the two boxes. `port`
 *  ({ from, to }, 0..1 along the side, edgePorts) keeps two arrows leaving
 *  one side from starting on top of each other. */
export function edgeRoute(a, c, placed = null, gap = 0, port = null) {
  return routeWith(a, c, obstacles(placed, [a.id, c.id]), placed?.dir === 'LR', gap, port);
}

/** Every arrow's route at once (the board build and the preview): the
 *  obstacles and the ports are worked out once for the whole diagram. One
 *  route per edge of `placed.edges`, null where an end is missing. */
export function routeAll(placed, gap = 0) {
  const set = obstacleSet(placed);
  const at = new Map((placed?.nodes || []).map((n) => [n.id, n]));
  const ports = edgePorts(placed);
  const lr = placed?.dir === 'LR';
  return (placed?.edges || []).map((e, i) => {
    const a = at.get(e.from); const c = at.get(e.to);
    return a && c ? routeWith(a, c, obstaclesFor(set, [a.id, c.id]), lr, gap, ports[i]) : null;
  });
}

/** Where each arrow leaves and meets its boxes along the flow: arrows that
 *  share a side of a box are spread over its middle half, in the order of
 *  where they go, so none starts on top of another. A diamond or an oval
 *  keeps its tip. One { from, to } per edge of `placed.edges`. */
export function edgePorts(placed) {
  const edges = placed?.edges || [];
  const at = new Map((placed?.nodes || []).map((n) => [n.id, n]));
  const lr = placed?.dir === 'LR';
  const res = edges.map(() => ({ from: 0.5, to: 0.5 }));
  const outs = new Map(); const ins = new Map();
  const push = (m, k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); };
  edges.forEach((e, i) => {
    const a = at.get(e.from); const c = at.get(e.to);
    if (!a || !c || !(lr ? c.x >= a.x + a.w : c.y >= a.y + a.h)) return;
    push(outs, e.from, i); push(ins, e.to, i);
  });
  const mid = (n) => (lr ? n.y + n.h / 2 : n.x + n.w / 2);
  const spread = (m, side, other) => {
    for (const [id, list] of m) {
      const n = at.get(id);
      if (list.length < 2 || n.shape === 'decision' || n.shape === 'terminal') continue;
      list.sort((p, q) => mid(at.get(edges[p][other])) - mid(at.get(edges[q][other])));
      list.forEach((i, k) => { res[i][side] = 0.3 + (0.4 * k) / (list.length - 1); });
    }
  };
  spread(outs, 'from', 'to');
  spread(ins, 'to', 'from');
  // Arrows fanning out of one box turn at different heights, the one going
  // furthest out first, so their runs never lie on top of each other or cross.
  for (const [id, list] of outs) {
    if (list.length < 2) continue;
    const a = at.get(id);
    const reach = (i) => mid(at.get(edges[i].to)) - mid(a);
    const left = list.filter((i) => reach(i) < -1).sort((p, q) => reach(p) - reach(q));
    const right = list.filter((i) => reach(i) > 1).sort((p, q) => reach(q) - reach(p));
    for (const side of [left, right]) side.forEach((i, k) => { res[i].bend = k; });
  }
  return res;
}

function routeTB(a, c, obs, gap, pa = 0.5, pc = 0.5, bend = undefined) {
  const ax = Math.round(a.x + a.w * pa); const cx = Math.round(c.x + c.w * pc);
  const aBottom = a.y + a.h + gap; const cTop = c.y - gap;
  const tries = [];
  if (c.y >= a.y + a.h) {
    // Along the flow: down, across in a gap, down.
    if (Math.abs(ax - cx) < 1) tries.push([[ax, aBottom], [cx, cTop]]);
    const span = c.y - (a.y + a.h);
    if (bend !== undefined && 16 + bend * 12 < span - CLEAR) {   // one of a fan: its own height, just under the box
      const my = Math.round(a.y + a.h + 16 + bend * 12);
      tries.push([[ax, aBottom], [ax, my], [cx, my], [cx, cTop]]);
      for (const lx of lanes(obs, cx)) tries.push([[ax, aBottom], [ax, my], [lx, my], [lx, c.y - 16], [cx, c.y - 16], [cx, cTop]]);
    }
    for (const t of [0.5, 0.25, 0.75, 0.12, 0.88]) {
      const my = Math.round(a.y + a.h + span * t);
      tries.push([[ax, aBottom], [ax, my], [cx, my], [cx, cTop]]);
    }
    // Down a lane beside whatever is in the way.
    const y1 = Math.round(a.y + a.h + Math.min(24, span / 2)); const y2 = Math.round(c.y - Math.min(16, span / 2));
    const free = lanes(obs, (ax + cx) / 2);
    for (const lx of free) tries.push([[ax, aBottom], [ax, y1], [lx, y1], [lx, y2], [cx, y2], [cx, cTop]]);
    // Into the box's side when its top is shut (a group's label above it).
    const cy = Math.round(c.y + c.h / 2);
    for (const lx of [c.x + c.w + 24, c.x - 24, ...free]) {
      if (lx > c.x - 4 && lx < c.x + c.w + 4) continue;
      const side = lx > c.x + c.w / 2 ? c.x + c.w + gap : c.x - gap;
      tries.push([[ax, aBottom], [ax, y1], [lx, y1], [lx, cy], [side, cy]]);
    }
    return bestRoute(tries, obs);
  }
  // Against the flow (a loop back up) or side by side: out one side, round, into the same side.
  const ay = a.y + a.h / 2; const cy = c.y + c.h / 2;
  const right = Math.max(a.x + a.w, c.x + c.w); const leftEdge = Math.min(a.x, c.x);
  for (let k = 1; k <= 8; k += 1) {
    const rx = right + 24 * k; const lx = leftEdge - 24 * k;
    tries.push([[a.x + a.w + gap, ay], [rx, ay], [rx, cy], [c.x + c.w + gap, cy]]);
    tries.push([[a.x - gap, ay], [lx, ay], [lx, cy], [c.x - gap, cy]]);
  }
  return bestRoute(tries, obs);
}

/** Lanes beside the obstacles, nearest `near` first. */
function lanes(obs, near) {
  const xs = [];
  for (const r of obs) xs.push(r.x - 6, r.x + r.w + 6);
  return [...new Set(xs.map(Math.round))].sort((p, q) => Math.abs(p - near) - Math.abs(q - near)).slice(0, 24);
}

/** The point halfway along a route (where an arrow's label sits). */
export function routeMid(pts) {
  const seg = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i += 1) { const l = Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]); seg.push(l); total += l; }
  let left = total / 2;
  for (let i = 0; i < seg.length; i += 1) {
    if (left <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, left / seg[i]) : 0;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    }
    left -= seg[i];
  }
  return pts[0] || [0, 0];
}

// ---- Board -> graph (Tidy Up) ----------------------------------------------
//
// The diagram to tidy: the selected boxes and every box tied to them by an
// arrow, or - nothing selected - every box tied by an arrow to another box
// and every box in a group the builder drew. A box no arrow ties (a markup
// box round a problem on a picture, a loose note) never moves unless it is
// selected itself. A group's box moves with all of its members. `elements`
// is the board's element list; this reads only the element JSON every
// engine keeps (type, ids, bindings, groupIds, customData, the label text's
// containerId), never the engine.

const BOX = { rectangle: 'step', diamond: 'decision', ellipse: 'terminal' };
const STYLE_KEYS = ['strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'roundness', 'angle', 'frameId', 'groupIds', 'link', 'customData'];
/** The builder's own marks on what it draws (customData keys). */
export const MARKS = Object.freeze({ group: 'nexusGroup', groupLabel: 'nexusGroupLabel', glyphOf: 'nexusGlyphOf', edge: 'nexusEdge' });

export function graphFromElements(elements, selectedIds = {}) {
  const live = (elements || []).filter((e) => e && !e.isDeleted);
  const anySelected = Object.values(selectedIds || {}).some(Boolean);
  const labelOf = new Map();   // container id -> its bound text element
  for (const e of live) if (e.type === 'text' && e.containerId) labelOf.set(e.containerId, e);
  // The builder's groups: the box it drew ({ gid, label, glyph, parent } on
  // it) and the label over it. The words on the board win, so a group renamed
  // there keeps its name (`named`); a group whose box was deleted but whose
  // label still says something is drawn again - nothing typed is lost.
  const groupInfo = new Map();
  for (const e of live) {
    const d = e.type === 'rectangle' ? e.customData?.[MARKS.group] : null;
    if (d?.gid) groupInfo.set(d.gid, { ...d, box: e });
  }
  for (const t of live) {
    const gid = t.type === 'text' ? t.customData?.[MARKS.groupLabel] : '';
    if (!gid) continue;
    const said = t.originalText ?? t.text;
    const info = groupInfo.get(gid);
    if (info) {
      info.labelEl = t;
      if (said != null && said !== info.label) { info.label = said; info.named = true; }
    } else if (String(said || '').trim()) {
      groupInfo.set(gid, { gid, label: said, glyph: t.customData.nexusGlyph || '', parent: (t.groupIds || [])[1] || '', named: true, box: null, labelEl: t });
    }
  }
  // What is left of a group that is gone (its box and its words deleted): an
  // icon or an empty label. Those pieces are removed, and their group id is
  // dropped from the boxes this rebuilds (a box left out keeps it - harmless,
  // it reads as a group of the person's own).
  const liveIds = new Set(live.map((e) => e.id));
  const orphans = live.filter((e) => {
    const of = e.customData?.[MARKS.groupLabel] || e.customData?.[MARKS.glyphOf];
    return of && !groupInfo.has(of) && !liveIds.has(of);
  });
  const orphanGids = new Set(orphans.map((e) => e.customData[MARKS.groupLabel] || e.customData[MARKS.glyphOf]));
  const builderGroup = (g) => groupInfo.has(g) || orphanGids.has(g);
  const eligible = new Map(live.filter((e) => BOX[e.type] && !e.locked && !e.customData?.nexusComment && !e.customData?.[MARKS.group] && !e.customData?.[MARKS.glyphOf]).map((e) => [e.id, e]));
  const tied = live.filter((e) => e.type === 'arrow' && !e.locked
    && eligible.has(e.startBinding?.elementId) && eligible.has(e.endBinding?.elementId)
    && e.startBinding.elementId !== e.endBinding.elementId);
  // A box's diagram groups, innermost first (its groupIds that name a group box).
  const chainOf = (b) => (b.groupIds || []).filter((g) => groupInfo.has(g));
  const outerOf = (b) => { const c = chainOf(b); return c.length ? (groupInfo.get(c[c.length - 1]).parent || c[c.length - 1]) : ''; };
  const membersOf = new Map();   // outermost gid -> box ids
  for (const b of eligible.values()) { const o = outerOf(b); if (o) { if (!membersOf.has(o)) membersOf.set(o, []); membersOf.get(o).push(b.id); } }
  // Grow from the start set along tied arrows and whole groups, so no arrow
  // is left with one end moved and no group with half its members.
  const picked = new Set(anySelected
    ? [...eligible.keys()].filter((id) => selectedIds[id])
    : [...tied.flatMap((a) => [a.startBinding.elementId, a.endBinding.elementId]), ...[...membersOf.values()].flat()]);
  if (anySelected) for (const [gid, info] of groupInfo) if ((info.box && selectedIds[info.box.id]) || (info.labelEl && selectedIds[info.labelEl.id])) for (const id of membersOf.get(info.parent || gid) || []) picked.add(id);
  for (let grew = true; grew;) {
    grew = false;
    for (const a of tied) {
      const s = a.startBinding.elementId; const t = a.endBinding.elementId;
      if (picked.has(s) !== picked.has(t)) { picked.add(s); picked.add(t); grew = true; }
    }
    for (const id of [...picked]) {
      for (const m of membersOf.get(outerOf(eligible.get(id))) || []) if (!picked.has(m)) { picked.add(m); grew = true; }
    }
  }
  const boxes = [...eligible.values()].filter((b) => picked.has(b.id));
  const arrows = tied.filter((a) => picked.has(a.startBinding.elementId));
  const usedGroups = new Set();
  const nodes = boxes.map((b) => {
    const style = {};
    for (const k of STYLE_KEYS) if (b[k] !== undefined) style[k] = b[k];
    // The builder's own groups are drawn again from `groups`; a box keeps any group of its own.
    const chain = chainOf(b);
    chain.forEach((g) => usedGroups.add(g));
    if (style.groupIds) style.groupIds = style.groupIds.filter((g) => !builderGroup(g) && g !== `${b.id}:glyph`);
    const t = labelOf.get(b.id);
    if (t) { style.fontSize = t.fontSize; style.fontFamily = t.fontFamily; style.textColor = t.strokeColor; style.textAlign = t.textAlign; style.verticalAlign = t.verticalAlign; }
    const n = { id: b.id, label: t?.originalText ?? t?.text ?? '', shape: BOX[b.type], w: b.width, h: b.height, style, version: b.version };
    if (b.customData?.nexusGlyph) n.glyph = b.customData.nexusGlyph;
    return n;
  });
  const groupOut = (gid, parent, members) => {
    const info = groupInfo.get(gid);
    return { id: gid, label: info.label || '', glyph: info.glyph || '', parent, members, ...(info.named ? { named: true } : {}) };
  };
  const groups = [...usedGroups].map((gid) => {
    const p = groupInfo.get(gid).parent;
    return groupOut(gid, p && groupInfo.has(p) ? p : '', boxes.filter((b) => chainOf(b)[0] === gid).map((b) => b.id));
  });
  for (const g of groups) if (g.parent) usedGroups.add(g.parent);
  for (const gid of usedGroups) if (!groups.some((g) => g.id === gid)) groups.push(groupOut(gid, '', []));
  const edges = arrows.map((a) => {
    const t = labelOf.get(a.id);
    const style = {};
    for (const k of ['strokeColor', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'frameId', 'groupIds']) if (a[k] !== undefined) style[k] = a[k];
    if (style.groupIds) style.groupIds = style.groupIds.filter((g) => !builderGroup(g));
    const e = { from: a.startBinding.elementId, to: a.endBinding.elementId, label: t?.originalText ?? t?.text ?? '', style };
    if (a.customData?.[MARKS.edge] && a.customData[MARKS.edge] !== 'normal') e.kind = a.customData[MARKS.edge];
    return e;
  });
  // What the rebuild replaces: the boxes (kept ids), their labels and glyphs,
  // the arrows and theirs, the group boxes with their labels and glyphs, and
  // the pieces of groups that are gone.
  const replaced = new Set([...boxes.map((b) => b.id), ...arrows.map((a) => a.id), ...[...usedGroups].map((g) => groupInfo.get(g).box?.id).filter(Boolean), ...orphans.map((e) => e.id)]);
  for (const id of [...replaced]) { const t = labelOf.get(id); if (t) replaced.add(t.id); }
  for (const e of live) {
    const owner = e.customData?.[MARKS.glyphOf] || e.customData?.[MARKS.groupLabel];
    if (owner && (replaced.has(owner) || usedGroups.has(owner))) replaced.add(e.id);
  }
  // A group drawn again from its label alone sits where that label puts it.
  const frameOf = (info) => info.box || { x: info.labelEl.x - GROUP_LABEL.dx - (info.glyph ? GROUP_LABEL.glyph + 6 : 0), y: info.labelEl.y - GROUP_LABEL.dy };
  const framed = [...boxes, ...[...usedGroups].map((g) => frameOf(groupInfo.get(g)))];
  const origin = framed.length
    ? { x: Math.min(...framed.map((b) => b.x)), y: Math.min(...framed.map((b) => b.y)) }
    : { x: 0, y: 0 };
  return { graph: { nodes, edges, groups }, replaced, origin };
}

/** The bounds of a placed graph - where to put it, how big the preview is. */
export function bounds(placed) {
  const ns = [...(placed?.nodes || []), ...(placed?.groups || [])];
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
  { key: 'site', label: 'Site Map', text: 'Escondido | map-pin:\n  Office | building -> Gate | lock\n  Units A-C:\n    Drive-Up Units | warehouse\n    Climate Units | thermometer\nGate => Drive-Up Units\nGate => Climate Units\nGate -.-> Cameras | cctv' },
]);
