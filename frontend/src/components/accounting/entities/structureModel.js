// Accounting > Entities (Neil, 11/17/2026): the structure charts, as data.
//
// The server (routers/accounting_entities.py `structure`) sends one graph:
// nodes (our entities, investors, people, member groups, properties) and
// edges - `owns` (owner -> owned, with the percentage), `manages` (a
// Management Fee agreement or the record's manager) and `holds` (an entity ->
// the property it owns). This file picks the part a chart shows and lays it
// out; StructureChart.jsx only draws what comes back. Pure functions, so the
// layout is tested without a browser.
//
// The shapes follow the convention tax and legal teams draw structure charts
// in, by what the IRS sees the entity as (backend legal_entities.shape_of is
// the one rule; this is only the legend's words).

export const SHAPES = [
  { key: 'corporation', label: 'Corporation', note: 'C or S corporation - an S corporation is marked S' },
  { key: 'partnership', label: 'Partnership', note: 'Multi-member LLC, LP or GP taxed as a partnership' },
  { key: 'disregarded', label: 'Disregarded Entity', note: 'Single-member LLC - its owner reports it' },
  { key: 'trust', label: 'Trust', note: '' },
  { key: 'individual', label: 'Individual', note: 'A person or an IRA' },
  { key: 'group', label: 'Investors', note: 'Outside investors in a deal, counted together' },
  { key: 'property', label: 'Property', note: 'Held in Asset Management' },
  { key: 'unknown', label: 'Not Set Yet', note: 'Type not recorded' },
];

// Node sizes per shape (px). A triangle needs the height for its words.
export const SIZE = {
  corporation: [176, 60], partnership: [196, 92], disregarded: [184, 64], trust: [176, 66], individual: [164, 58],
  group: [164, 58], property: [150, 66], unknown: [176, 60], hidden: [176, 60], lender: [176, 60],
};
const GAP_X = 36;
const GAP_BESIDE = 170;   // room for a lender's or manager's label on the line beside the entity
const GAP_Y = 76;
const PAD = 28;
export const sizeOf = (n) => SIZE[n.shape] || SIZE[n.kind] || SIZE.unknown;

/** "40%" / "33.33%" / "" - a percentage as the chart writes it. */
export function pctText(p) {
  if (p === null || p === undefined || p === '') return '';
  const n = Number(p);
  return Number.isFinite(n) ? `${parseFloat(n.toFixed(2))}%` : '';
}

/** Up to `lines` lines of about `chars` characters, broken at spaces; the last one ends in "..." when cut. */
export function wrapText(text, chars, lines = 2) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= chars || !cur) { cur = next; continue; }
    out.push(cur);
    cur = w;
    if (out.length === lines) break;
  }
  if (out.length < lines && cur) out.push(cur);
  const used = out.join(' ').split(/\s+/).filter(Boolean).length;
  if (used < words.length || (out[out.length - 1] || '').length > chars) {
    const last = out[lines - 1] ?? out[out.length - 1] ?? '';
    out[out.length - 1] = `${last.slice(0, Math.max(1, chars - 3)).replace(/\s+$/, '')}...`;
  }
  return out;
}

const byId = (nodes) => Object.fromEntries(nodes.map((n) => [n.id, n]));

/**
 * The part of the graph one entity's chart shows: every owner above it (and
 * their owners, `up` levels), everything it owns below (`down` levels), who
 * manages it, and the properties of the entities shown.
 */
export function focusGraph(graph, code, { up = 6, down = 3 } = {}) {
  const nodes = byId(graph?.nodes || []);
  const edges = graph?.edges || [];
  const focus = `e:${code}`;
  if (!nodes[focus]) return { nodes: [], edges: [], focus };
  const keep = new Set([focus]);
  const owns = edges.filter((e) => e.kind === 'owns');
  let frontier = [focus];
  for (let i = 0; i < up && frontier.length; i += 1) {
    const next = [];
    owns.forEach((e) => { if (frontier.includes(e.to) && !keep.has(e.from)) { keep.add(e.from); next.push(e.from); } });
    frontier = next;
  }
  frontier = [focus];
  for (let i = 0; i < down && frontier.length; i += 1) {
    const next = [];
    owns.forEach((e) => { if (frontier.includes(e.from) && !keep.has(e.to)) { keep.add(e.to); next.push(e.to); } });
    frontier = next;
  }
  edges.forEach((e) => { if (e.kind === 'manages' && e.to === focus) keep.add(e.from); });
  edges.forEach((e) => { if (e.kind === 'holds' && keep.has(e.from)) keep.add(e.to); });
  const out = edges.filter((e) => keep.has(e.from) && keep.has(e.to)
    && (e.kind !== 'manages' || e.to === focus || e.from === focus));
  return { nodes: [...keep].map((id) => nodes[id]).filter(Boolean), edges: out, focus };
}

/**
 * Outside investors of one entity counted together once there are more than
 * `max` of them ("13 Investors", their percentages added) - the chart stays
 * readable and the look-through still has every name.
 */
export function groupInvestors({ nodes, edges, ...rest }, max = 5) {
  const nmap = byId(nodes);
  const outsideTo = {};
  edges.forEach((e) => {
    const n = nmap[e.from];
    if (e.kind === 'owns' && n?.kind === 'investor' && n.outside) (outsideTo[e.to] = outsideTo[e.to] || []).push(e);
  });
  const drop = new Set();
  const addNodes = [];
  const addEdges = [];
  Object.entries(outsideTo).forEach(([to, list]) => {
    if (list.length <= max) return;
    // An investor who also owns something else in the chart stays drawn on its own.
    const solo = list.filter((e) => edges.some((x) => x.from === e.from && x.to !== to));
    const pack = list.filter((e) => !solo.includes(e));
    if (pack.length <= 1) return;
    pack.forEach((e) => { drop.add(e); drop.add(e.from); });
    const known = pack.filter((e) => e.pct !== null && e.pct !== undefined);
    const id = `grp:${to}`;
    addNodes.push({ id, kind: 'group', shape: 'group', label: `${pack.length} Investors`, sub: 'Investor Relations', count: pack.length });
    addEdges.push({ from: id, to, kind: 'owns', source: 'ir', pct: known.length ? Math.round(known.reduce((s, e) => s + Number(e.pct), 0) * 10000) / 10000 : null });
  });
  if (!addNodes.length) return { nodes, edges, ...rest };
  const stillUsed = new Set(edges.filter((e) => !drop.has(e)).flatMap((e) => [e.from, e.to]));
  return {
    ...rest,
    nodes: [...nodes.filter((n) => !drop.has(n.id) || stillUsed.has(n.id)), ...addNodes],
    edges: [...edges.filter((e) => !drop.has(e)), ...addEdges],
  };
}

/**
 * The whole structure, or the part under one or more tops: every legal
 * entity, people and investors who own them (grouped per deal past `max`),
 * management lines and properties.
 */
export function wholeGraph(graph, { tops = null, properties = true, max = 4 } = {}) {
  let nodes = graph?.nodes || [];
  let edges = graph?.edges || [];
  if (!properties) {
    nodes = nodes.filter((n) => n.kind !== 'property');
    edges = edges.filter((e) => e.kind !== 'holds');
  }
  if (tops?.length) {
    const keep = new Set(tops);
    let frontier = [...tops];
    while (frontier.length) {
      const next = [];
      edges.forEach((e) => { if (e.kind !== 'manages' && frontier.includes(e.from) && !keep.has(e.to)) { keep.add(e.to); next.push(e.to); } });
      frontier = next;
    }
    // The owners of what is shown, one level, so a percentage is never orphaned.
    edges.forEach((e) => { if (e.kind === 'owns' && keep.has(e.to) && !keep.has(e.from)) keep.add(e.from); });
    nodes = nodes.filter((n) => keep.has(n.id));
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  // An entity with no owner, holding and line recorded is listed, not drawn alone.
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const loose = nodes.filter((n) => !linked.has(n.id) && n.kind === 'entity');
  nodes = nodes.filter((n) => linked.has(n.id));
  return { ...groupInvestors({ nodes, edges }, max), loose };
}

/**
 * Layers, top down: an owner sits above what it owns and an entity above its
 * property (longest path from the top, so a chain reads as a chain); a
 * management line does not move anything. Within a layer, nodes are ordered
 * by the average place of what they connect to (two sweeps), then placed and
 * each layer centered. Edges come back as orthogonal paths with their own
 * entry point along the child's top edge, so two owners of one entity never
 * share a line or a label.
 *
 * `beside`: {nodeId: anchorId} puts a node (a lender, a manager from outside
 * the chart) on its anchor's layer, just after it.
 */
export function layout({ nodes, edges }, { beside = {} } = {}) {
  const ids = nodes.map((n) => n.id);
  const nmap = byId(nodes);
  const down = edges.filter((e) => (e.kind === 'owns' || e.kind === 'holds') && nmap[e.from] && nmap[e.to] && !beside[e.from] && !beside[e.to]);
  const parents = Object.fromEntries(ids.map((id) => [id, []]));
  const children = Object.fromEntries(ids.map((id) => [id, []]));
  down.forEach((e) => { parents[e.to].push(e.from); children[e.from].push(e.to); });

  // Longest path from a root, loop-safe.
  const layer = {};
  const visiting = new Set();
  const depth = (id) => {
    if (layer[id] !== undefined) return layer[id];
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = parents[id].length ? Math.max(...parents[id].map((p) => depth(p) + 1)) : 0;
    visiting.delete(id);
    layer[id] = d;
    return d;
  };
  ids.filter((id) => !beside[id]).forEach(depth);
  // A property always sits one layer under its deepest holder.
  ids.forEach((id) => { if (nmap[id].kind === 'property' && parents[id].length) layer[id] = Math.max(...parents[id].map((p) => layer[p] + 1)); });
  Object.entries(beside).forEach(([id, anchor]) => { if (nmap[id]) layer[id] = layer[anchor] ?? 0; });

  const rows = [];
  ids.forEach((id) => { (rows[layer[id]] = rows[layer[id]] || []).push(id); });
  for (let i = 0; i < rows.length; i += 1) rows[i] = rows[i] || [];
  const order = {};
  const setOrder = () => rows.forEach((r) => r.forEach((id, i) => { order[id] = i; }));
  rows.forEach((r) => r.sort((a, b) => String(nmap[a].label || '').localeCompare(String(nmap[b].label || ''))));
  setOrder();
  const bary = (id, side) => {
    const near = side === 'up' ? parents[id] : children[id];
    return near.length ? near.reduce((s, p) => s + order[p], 0) / near.length : order[id];
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 1; i < rows.length; i += 1) { rows[i].sort((a, b) => bary(a, 'up') - bary(b, 'up')); setOrder(); }
    for (let i = rows.length - 2; i >= 0; i -= 1) { rows[i].sort((a, b) => bary(a, 'down') - bary(b, 'down')); setOrder(); }
  }
  // Beside-nodes go right after their anchor.
  rows.forEach((r) => {
    Object.entries(beside).forEach(([id, anchor]) => {
      const i = r.indexOf(id);
      const j = r.indexOf(anchor);
      if (i < 0 || j < 0) return;
      r.splice(i, 1);
      r.splice(r.indexOf(anchor) + 1, 0, id);
    });
  });

  const widths = rows.map((r) => r.reduce((s, id, k) => s + sizeOf(nmap[id])[0] + (k > 0 && beside[id] ? GAP_BESIDE - GAP_X : 0), 0) + GAP_X * Math.max(0, r.length - 1));
  const maxW = Math.max(0, ...widths);
  const heights = rows.map((r) => Math.max(0, ...r.map((id) => sizeOf(nmap[id])[1])));
  const placed = {};
  let y = PAD;
  rows.forEach((r, i) => {
    let x = PAD + (maxW - widths[i]) / 2;
    r.forEach((id, k) => {
      const [w, h] = sizeOf(nmap[id]);
      if (k > 0 && beside[id]) x += GAP_BESIDE - GAP_X;
      placed[id] = { ...nmap[id], x, y: y + (heights[i] - h), w, h, layer: i };
      x += w + GAP_X;
    });
    y += heights[i] + GAP_Y;
  });

  // Entry and exit points spread along each node's edge, in the order of the other end.
  const ins = {};
  const outs = {};
  down.forEach((e) => { (ins[e.to] = ins[e.to] || []).push(e); (outs[e.from] = outs[e.from] || []).push(e); });
  const port = (list, e, node, other) => {
    const sorted = [...list].sort((a, b) => placed[other(a)].x - placed[other(b)].x);
    const k = sorted.indexOf(e);
    const usable = node.shape === 'partnership' ? node.w * 0.34 : node.w * 0.7;
    return node.x + node.w / 2 + (sorted.length > 1 ? (k / (sorted.length - 1) - 0.5) * usable : 0);
  };
  // Each downward line gets its own height for its sideways run, so two
  // lines into one row never share a horizontal stretch.
  const lanes = {};
  down.forEach((e) => { if (placed[e.from] && placed[e.to]) (lanes[placed[e.to].layer] = lanes[placed[e.to].layer] || []).push(e); });
  const laneOf = new Map();
  Object.values(lanes).forEach((list) => {
    const sorted = [...list].sort((a, b) => (placed[a.from].x - placed[b.from].x) || (placed[a.to].x - placed[b.to].x));
    sorted.forEach((e, i) => laneOf.set(e, sorted.length > 1 ? i / (sorted.length - 1) : 0.5));
  });
  const outEdges = [];
  edges.forEach((e) => {
    const a = placed[e.from];
    const b = placed[e.to];
    if (!a || !b) return;
    if ((e.kind === 'owns' || e.kind === 'holds') && !beside[e.from] && !beside[e.to] && a.layer < b.layer) {
      const x1 = port(outs[e.from], e, a, (x) => x.to);
      const x2 = port(ins[e.to], e, b, (x) => x.from);
      const y1 = edgeY(a, x1, 'bottom');
      const y2 = edgeY(b, x2, 'top');
      const mid = b.y - 22 - (GAP_Y - 40) * (laneOf.get(e) ?? 0.5);
      outEdges.push({ ...e, points: [[x1, y1], [x1, mid], [x2, mid], [x2, y2]], labelAt: [x2, b.y - 8] });
    } else {
      // Beside, or a line that does not run downward: a straight dashed connector between the nearest sides.
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;
      const sameRow = Math.abs(a.y - b.y) < 2;
      const level = (n) => n.y + n.h * (n.shape === 'partnership' ? 0.72 : 0.5);
      const sideX = (n, right) => (n.shape === 'partnership' ? n.x + n.w / 2 + (right ? 1 : -1) * n.w * 0.36 : right ? n.x + n.w : n.x);
      const p1 = sameRow ? [sideX(a, ax < bx), level(a)] : [ax, a.y < b.y ? a.y + a.h : a.y];
      const p2 = sameRow ? [sideX(b, ax >= bx), level(b)] : [bx, a.y < b.y ? b.y : b.y + b.h];
      outEdges.push({ ...e, points: [p1, p2], labelAt: [(p1[0] + p2[0]) / 2, sameRow ? Math.min(p1[1], p2[1]) - 8 : (p1[1] + p2[1]) / 2 + 4], side: true });
    }
  });
  return { nodes: Object.values(placed), edges: outEdges, width: maxW + PAD * 2, height: Math.max(y - GAP_Y + PAD, PAD * 2) };
}

/** Where a line meets a shape's top or bottom edge at `x`: the slope of a
 *  triangle or a roof, the curve of an oval, else the flat side. */
function edgeY(n, x, side) {
  const cx = n.x + n.w / 2;
  const t = Math.min(1, Math.abs(x - cx) / (n.w / 2));
  if (n.shape === 'individual' || n.shape === 'group') {
    const dy = (n.h / 2) * Math.sqrt(Math.max(0, 1 - t * t));
    return side === 'top' ? n.y + n.h / 2 - dy : n.y + n.h / 2 + dy;
  }
  if (side === 'top' && n.shape === 'partnership') return n.y + n.h * t;
  if (side === 'top' && n.shape === 'property') return n.y + n.h * 0.34 * t;
  return side === 'top' ? n.y : n.y + n.h;
}

/** The entity chart's extras: its lenders (from Loans) as nodes beside it. */
export function withLenders(g, code, loans = []) {
  const focus = `e:${code}`;
  const byLender = {};
  (loans || []).forEach((l) => {
    const k = String(l.lender || 'Lender').trim();
    const cur = byLender[k] || (byLender[k] = { lender: k, balance: 0, rates: [], internal: !!l.internal, count: 0 });
    cur.balance += Number(l.balance) || 0;
    if (l.ratePct) cur.rates.push(Number(l.ratePct));
    cur.count += 1;
  });
  const lenders = Object.values(byLender).slice(0, 4);
  const beside = {};
  const nodes = [...g.nodes];
  const edges = [...g.edges];
  let anchor = focus;
  lenders.forEach((l, i) => {
    const id = `lender:${i}`;
    nodes.push({ id, kind: 'lender', shape: 'lender', label: l.lender, sub: l.internal ? 'Intercompany lender' : 'Lender' });
    edges.push({ from: id, to: focus, kind: 'lends', balance: l.balance, rate: l.rates.length === 1 ? l.rates[0] : null, count: l.count });
    beside[id] = anchor;
    anchor = id;
  });
  return { graph: { ...g, nodes, edges }, beside };
}

/** "$5.9M" - a short amount for a line's label (the figure itself is on the page). */
export function shortMoney(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}
