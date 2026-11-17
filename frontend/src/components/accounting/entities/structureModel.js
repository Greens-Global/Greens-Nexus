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
  { key: 'lender', label: 'Lender', note: 'From Loans' },
  { key: 'unknown', label: 'Type Not Set', note: 'Type not recorded yet' },
  { key: 'hidden', label: 'Outside Your Access', note: 'An entity your accounting access does not include' },
]

// Node sizes (px): every node is a card; the tax shape is its glyph.
export const SIZE = {
  entity: [236, 78], investor: [196, 60], person: [196, 60], group: [196, 60],
  property: [208, 60], lender: [208, 60], hidden: [212, 60],
};
const GAP_X = 28;
const GAP_BESIDE = 168;   // room for a lender's label on the line beside the entity
const GAP_Y = 96;
const PAD = 32;
export const sizeOf = (n) => SIZE[n.kind] || SIZE.entity;

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
export function wholeGraph(graph, { tops = null, properties = true, max = 2 } = {}) {
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

  // Layers: longest path from a root (loop-safe), then every owner pulled
  // down to sit right above the highest thing it owns - no line drops past
  // a whole row to reach its entity.
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
  for (let pass = 0; pass < 3; pass += 1) {
    [...ids].filter((id) => !beside[id] && children[id].length).sort((a, b) => layer[b] - layer[a]).forEach((id) => {
      const lowest = Math.min(...children[id].map((c) => layer[c])) - 1;
      const highestParent = parents[id].length ? Math.max(...parents[id].map((p) => layer[p])) + 1 : 0;
      if (lowest > layer[id] && lowest >= highestParent) layer[id] = lowest;
    });
  }
  Object.entries(beside).forEach(([id, anchor]) => { if (nmap[id]) layer[id] = layer[anchor] ?? 0; });

  const rows = [];
  ids.forEach((id) => { (rows[layer[id]] = rows[layer[id]] || []).push(id); });
  for (let i = 0; i < rows.length; i += 1) rows[i] = rows[i] || [];

  // Order within each row: barycenter sweeps, four each way.
  const order = {};
  const setOrder = () => rows.forEach((r) => r.forEach((id, i) => { order[id] = i; }));
  rows.forEach((r) => r.sort((a, b) => String(nmap[a].label || '').localeCompare(String(nmap[b].label || ''))));
  setOrder();
  // Positions as a fraction of their row, so rows of different lengths
  // compare; a node with nothing on the side being swept follows the other
  // side (a subsidiary with no holdings stays with its siblings).
  const rowLen = (id) => rows[layer[id]]?.length || 1;
  const pos = (id) => (order[id] + 0.5) / rowLen(id);
  const avg = (list) => list.reduce((s, x) => s + pos(x), 0) / list.length;
  const bary = (id, side) => {
    const near = side === 'up' ? parents[id] : children[id];
    const far = side === 'up' ? children[id] : parents[id];
    return near.length ? avg(near) : far.length ? avg(far) : pos(id);
  };
  for (let pass = 0; pass < 4; pass += 1) {
    for (let i = 1; i < rows.length; i += 1) { rows[i].sort((a, b) => bary(a, 'up') - bary(b, 'up')); setOrder(); }
    for (let i = rows.length - 2; i >= 0; i -= 1) { rows[i].sort((a, b) => bary(a, 'down') - bary(b, 'down')); setOrder(); }
  }
  rows.forEach((r) => {
    Object.entries(beside).forEach(([id, anchor]) => {
      const i = r.indexOf(id);
      if (i < 0 || r.indexOf(anchor) < 0) return;
      r.splice(i, 1);
      r.splice(r.indexOf(anchor) + 1, 0, id);
    });
  });

  // Horizontal places: packed first, then each node pulled toward the center
  // of what it connects to (parents on the way down, children on the way
  // up), keeping its order and the gap - so an owner sits over what it owns.
  const w = (id) => sizeOf(nmap[id])[0];
  const gapBefore = (id, k) => (k > 0 && beside[id] ? GAP_BESIDE : GAP_X);
  const cx = {};
  rows.forEach((r) => { let x = 0; r.forEach((id, k) => { x += k ? gapBefore(id, k) : 0; cx[id] = x + w(id) / 2; x += w(id); }); });
  // The closest places to `want` that keep the row's order and gaps: pool
  // adjacent violators (isotonic regression, PAVA) - optimal, not greedy, so a
  // crowded row spreads evenly around the parents above it.
  const settle = (r, want) => {
    if (!r.length) return;
    const off = [0];
    for (let k = 1; k < r.length; k += 1) off[k] = off[k - 1] + (w(r[k - 1]) + w(r[k])) / 2 + gapBefore(r[k], k);
    const blocks = [];
    r.forEach((id, k) => {
      blocks.push({ sum: (want[id] ?? cx[id]) - off[k], n: 1 });
      while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
        const last = blocks.pop();
        blocks[blocks.length - 1].sum += last.sum;
        blocks[blocks.length - 1].n += last.n;
      }
    });
    let k = 0;
    blocks.forEach((bl) => { const q = bl.sum / bl.n; for (let j = 0; j < bl.n; j += 1, k += 1) cx[r[k]] = q + off[k]; });
  };
  const centerOf = (list) => list.reduce((s, x) => s + cx[x], 0) / list.length;
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 1; i < rows.length; i += 1) {
      const want = {};
      rows[i].forEach((id) => { if (parents[id].length) want[id] = centerOf(parents[id]); else if (beside[id]) want[id] = cx[beside[id]] + w(beside[id]) / 2 + GAP_BESIDE + w(id) / 2; });
      settle(rows[i], want);
    }
    for (let i = rows.length - 2; i >= 0; i -= 1) {
      const want = {};
      rows[i].forEach((id) => { if (children[id].length) want[id] = centerOf(children[id]); });
      settle(rows[i], want);
    }
  }
  const minX = Math.min(...ids.map((id) => cx[id] - w(id) / 2));
  const maxX = Math.max(...ids.map((id) => cx[id] + w(id) / 2));

  const heights = rows.map((r) => Math.max(0, ...r.map((id) => sizeOf(nmap[id])[1])));
  const placed = {};
  let y = PAD;
  rows.forEach((r, i) => {
    r.forEach((id) => {
      const [nw, nh] = sizeOf(nmap[id]);
      placed[id] = { ...nmap[id], x: cx[id] - nw / 2 - minX + PAD, y: y + (heights[i] - nh) / 2, w: nw, h: nh, layer: i };
    });
    y += heights[i] + GAP_Y;
  });

  // Entry and exit points spread along each card's edge, in the order of the
  // other end; each downward line gets its own height for its sideways run.
  const ins = {};
  const outs = {};
  down.forEach((e) => { (ins[e.to] = ins[e.to] || []).push(e); (outs[e.from] = outs[e.from] || []).push(e); });
  const port = (list, e, node, other) => {
    const sorted = [...list].sort((a, b) => placed[other(a)].x - placed[other(b)].x);
    const k = sorted.indexOf(e);
    return node.x + node.w / 2 + (sorted.length > 1 ? (k / (sorted.length - 1) - 0.5) * node.w * 0.62 : 0);
  };
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
      const y1 = a.y + a.h;
      const y2 = b.y;
      const top = Math.max(y1 + 14, b.y - GAP_Y + 18);
      const mid = Math.abs(x1 - x2) < 1 ? (y1 + y2) / 2 : top + (b.y - 42 - top) * (laneOf.get(e) ?? 0.5);
      outEdges.push({ ...e, points: [[x1, y1], [x1, mid], [x2, mid], [x2, y2]], labelAt: [x2, b.y - 11] });
    } else if (e.kind === 'manages' && !beside[e.from] && !beside[e.to]) {
      // A manager's dashed line runs the way an owner's does - out of the
      // card, along a lane of its own, into the near corner of the managed
      // card - so it never crosses another card.
      const toRight = a.x + a.w / 2 < b.x + b.w / 2;
      const x2 = b.x + b.w * (toRight ? 0.06 : 0.94);
      if (a.layer < b.layer) {
        const x1 = a.x + a.w * (toRight ? 0.9 : 0.1);
        const lane = b.y - GAP_Y + 9;
        outEdges.push({ ...e, points: [[x1, a.y + a.h], [x1, lane], [x2, lane], [x2, b.y]], labelAt: [(x1 + x2) / 2, lane + 4], side: true });
      } else {
        const x1 = a.x + a.w / 2;
        const lane = a.layer === b.layer ? Math.max(a.y + a.h, b.y + b.h) + 18 : a.y - 18;
        const y1 = a.layer === b.layer ? a.y + a.h : a.y;
        outEdges.push({ ...e, points: [[x1, y1], [x1, lane], [x2, lane], [x2, b.y + b.h]], labelAt: [(x1 + x2) / 2, lane - 7], side: true });
      }
    } else {
      const ax = a.x + a.w / 2;
      const bx = b.x + b.w / 2;
      const p1 = [ax < bx ? a.x + a.w : a.x, a.y + a.h / 2];
      const p2 = [ax < bx ? b.x : b.x + b.w, b.y + b.h / 2];
      outEdges.push({ ...e, points: [p1, [(p1[0] + p2[0]) / 2, p1[1]], [(p1[0] + p2[0]) / 2, p2[1]], p2], labelAt: [(p1[0] + p2[0]) / 2, Math.min(p1[1], p2[1]) - 9], side: true });
    }
  });
  // Percentages arriving close together on one card step up in turn, so no
  // two labels touch.
  const byTarget = {};
  outEdges.forEach((e) => { if (e.kind === 'owns' && !e.side) (byTarget[e.to] = byTarget[e.to] || []).push(e); });
  Object.values(byTarget).forEach((list) => {
    list.sort((p, q) => p.labelAt[0] - q.labelAt[0]);
    for (let i = 1; i < list.length; i += 1) {
      const need = (pctText(list[i - 1].pct).length + pctText(list[i].pct).length) * 3.6 + 8;
      if (list[i].labelAt[0] - list[i - 1].labelAt[0] < need && list[i - 1].labelAt[1] === list[i].labelAt[1]) {
        list[i].labelAt = [list[i].labelAt[0], list[i].labelAt[1] - 14];
      }
    }
  });
  return { nodes: Object.values(placed), edges: outEdges, width: maxX - minX + PAD * 2, height: Math.max(y - GAP_Y + PAD, PAD * 2) };
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
