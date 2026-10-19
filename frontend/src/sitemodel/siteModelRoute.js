// "How to Get There" as a path (Oct 20 2026, Ops review): from the main gate to
// a unit, around the buildings, in the model's own frame (u, v meters). Pure -
// no three.js, so the 3D viewer, the 2D plan fallback and the tests share it.
//
// The model has no drive-aisle network, so the path is found on a grid: every
// building footprint (plus a little clearance) is a wall, everything else is
// open ground, and A* walks the grid from the gate to the unit's door. The
// result is pulled straight wherever a straight line clears the walls, so it
// reads as "drive here, turn there", not a staircase.

/** Where a person stands to reach the unit: outside a drive-up door, at the
 *  stall, or at the nearest wall of the building for a hallway unit (then the
 *  last leg goes inside to the unit itself). */
export function routeGoal(model, u) {
  const own = (model.buildings || []).find((b) => b.id === u.b);
  const cu = u.u + u.wu / 2, cv = u.v + u.dv / 2; const out = 1.8;
  if (!own || u.k === 'park') return { goal: [cu, cv], inside: null };
  if (u.k === 'du' || u.k === 'ccdu') {
    const goal = u.door === 'ne' ? [cu, u.v + u.dv + out] : u.door === 'e' ? [u.u + u.wu + out, cv] : u.door === 'w' ? [u.u - out, cv] : [cu, u.v - out];
    return { goal, inside: null };
  }
  const edges = [[cu - own.u[0], [own.u[0] - out, cv]], [own.u[1] - cu, [own.u[1] + out, cv]], [cv - own.v[0], [cu, own.v[0] - out]], [own.v[1] - cv, [cu, own.v[1] + out]]];
  edges.sort((a, b) => a[0] - b[0]);
  return { goal: edges[0][1], inside: [cu, cv] };
}

class Heap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p; let i = k.length; k.push(key); p.push(pri);
    while (i > 0) { const j = (i - 1) >> 1; if (p[j] <= pri) break; k[i] = k[j]; p[i] = p[j]; i = j; }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const k = this.k, p = this.p; const top = k[0]; const lk = k.pop(), lp = p.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && p[c + 1] < p[c]) c++; if (p[c] >= lp) break; k[i] = k[c]; p[i] = p[c]; i = c; }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}

/** The grid: blocked cells for every building footprint except `skip`. */
function makeGrid(model, pts, skip) {
  const rects = (model.buildings || []).filter((b) => b.id !== skip).map((b) => [b.u[0] - 0.6, b.u[1] + 0.6, b.v[0] - 0.6, b.v[1] + 0.6]);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const take = (u, v) => { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); };
  pts.forEach((p) => take(p[0], p[1]));
  rects.forEach((r) => { take(r[0], r[2]); take(r[1], r[3]); });
  u0 -= 20; v0 -= 20; u1 += 20; v1 += 20;
  const cell = Math.max(1.5, Math.max(u1 - u0, v1 - v0) / 260);
  const nu = Math.ceil((u1 - u0) / cell) + 1, nv = Math.ceil((v1 - v0) / cell) + 1;
  const blocked = new Uint8Array(nu * nv);
  rects.forEach(([a, b, c, d]) => {
    for (let i = Math.max(0, Math.floor((a - u0) / cell)); i <= Math.min(nu - 1, Math.ceil((b - u0) / cell)); i++)
      for (let j = Math.max(0, Math.floor((c - v0) / cell)); j <= Math.min(nv - 1, Math.ceil((d - v0) / cell)); j++) {
        const cu = u0 + i * cell, cv = v0 + j * cell;
        if (cu >= a && cu <= b && cv >= c && cv <= d) blocked[j * nu + i] = 1;
      }
  });
  return { u0, v0, cell, nu, nv, blocked, rects };
}

const cellOf = (g, p) => [Math.min(g.nu - 1, Math.max(0, Math.round((p[0] - g.u0) / g.cell))), Math.min(g.nv - 1, Math.max(0, Math.round((p[1] - g.v0) / g.cell)))];
const at = (g, i, j) => [g.u0 + i * g.cell, g.v0 + j * g.cell];

function freeNear(g, [i, j]) {
  if (!g.blocked[j * g.nu + i]) return [i, j];
  for (let r = 1; r < 40; r++)
    for (let di = -r; di <= r; di++)
      for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < g.nu && b < g.nv && !g.blocked[b * g.nu + a]) return [a, b];
      }
  return [i, j];
}

/** Does a straight line from p to q stay off every wall? */
function clear(g, p, q) {
  const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (g.cell * 0.5));
  for (let s = 1; s < n; s++) {
    const u = p[0] + (q[0] - p[0]) * s / n, v = p[1] + (q[1] - p[1]) * s / n;
    if (g.rects.some((r) => u > r[0] && u < r[1] && v > r[2] && v < r[3])) return false;
  }
  return true;
}

function astar(g, s, t) {
  const N = g.nu * g.nv; const gs = new Float32Array(N).fill(Infinity); const from = new Int32Array(N).fill(-1); const done = new Uint8Array(N);
  const si = s[1] * g.nu + s[0], ti = t[1] * g.nu + t[0];
  const h = (i) => { const du = Math.abs((i % g.nu) - t[0]), dv = Math.abs(Math.floor(i / g.nu) - t[1]); return Math.max(du, dv) + 0.414 * Math.min(du, dv); };
  const heap = new Heap(); gs[si] = 0; heap.push(si, h(si));
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  while (heap.size) {
    const c = heap.pop(); if (done[c]) continue; done[c] = 1;
    if (c === ti) break;
    const ci = c % g.nu, cj = Math.floor(c / g.nu);
    for (const [di, dj, w] of D) {
      const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= g.nu || b >= g.nv) continue;
      const n = b * g.nu + a; if (g.blocked[n] || done[n]) continue;
      if (di && dj && (g.blocked[cj * g.nu + a] || g.blocked[b * g.nu + ci])) continue;   // no cutting a wall's corner
      const ng = gs[c] + w; if (ng < gs[n]) { gs[n] = ng; from[n] = c; heap.push(n, ng + h(n)); }
    }
  }
  if (from[ti] < 0 && si !== ti) return null;
  const out = []; for (let c = ti; c >= 0; c = c === si ? -1 : from[c]) out.push([c % g.nu, Math.floor(c / g.nu)]);
  return out.reverse();
}

/** [[u, v], ...] from the main gate to the unit, or null without a gate. */
export function routePath(model, u) {
  const gate = model.gates && model.gates[0] && model.gates[0].uv;
  if (!gate || !u) return null;
  const { goal, inside } = routeGoal(model, u);
  // Every footprint is a wall, the unit's own building too: a hallway unit is
  // reached at that building's wall, and the last leg goes inside.
  const g = makeGrid(model, [gate, goal], null);
  const s = freeNear(g, cellOf(g, gate)), t = freeNear(g, cellOf(g, goal));
  const cells = astar(g, s, t);
  let pts = cells ? cells.map(([i, j]) => at(g, i, j)) : [];
  pts = [gate, ...pts.slice(1, -1), goal];
  // Pull the string tight: keep a corner only where the straight line would hit a wall.
  const tight = [pts[0]]; let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clear(g, pts[i], pts[j])) j--;
    tight.push(pts[j]); i = j;
  }
  if (inside) tight.push(inside);
  return tight.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]);
}

/** The route: the path plus one stop per step of `steps` (routeSteps output),
 *  each with where it is, so a step can be clicked to move the camera there. */
export function planRoute(model, u, steps) {
  const points = routePath(model, u);
  if (!points) return null;
  const { goal } = routeGoal(model, u);
  const cu = u.u + u.wu / 2, cv = u.v + u.dv / 2;
  let length = 0; for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const stops = (steps || []).map((s, i) => ({ ...s, uv: i === 0 ? points[0] : s.end ? [cu, cv] : goal }));
  return { points, stops, length: Math.round(length) };
}
