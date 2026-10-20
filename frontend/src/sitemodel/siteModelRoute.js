// "How to Get There" as a path (Oct 20 2026, Ops review): from an entrance gate
// to a unit, along the drive aisles, in the model's own frame (u, v meters).
// Pure - no three.js, so the 3D viewer, the 2D plan fallback and the tests share it.
//
// The model has no drive-aisle network, so the path is found on a grid
// (Visesh, Oct 20: the first cut drew a straight line across parked RVs):
//   - outside the lot (the pads, the sections, a margin around buildings that
//     sit off the pad) is a wall, the entrance gates are the openings;
//   - every building, shelter, container and unit footprint is a wall - parked
//     vehicles block - except the unit being routed to;
//   - a vehicle needs room: cells closer than ~1.2 m to a wall are closed, and
//     a cost that grows near walls keeps the path on the aisle centerlines
//     instead of grazing stall corners.
// A* runs from the MAIN gate only (Visesh, Oct 20: customers always come in
// through the main gate, never a side entrance). The result is pulled straight
// wherever a straight line keeps the same clearance, so it reads as "drive
// here, turn there", not a staircase. The static grid is cached per model; a
// query only carves its own unit out and redoes the distance transform.

const WALL_GAP = 0.6;          // m, margin of the old buildings-only fallback grid
const CLEARANCES = [1.2, 0.8, 0.4];   // m, half a vehicle's width; tried in order
const PREFER = 3.5;            // m, clearance below which a cell costs more
const NEAR_COST = 4;           // extra cost per meter at a wall's edge
const ORPHAN_MARGIN = 8;       // m of open ground kept around a building / unit off the pad
const GATE_RADIUS = 5;         // m of opening at each gate
const GOAL_RADIUS = 3;         // m of ground opened around a goal past the lot outline
const OUT = 1.8;               // m, where a person stands outside a door or wall
const STALL_OUT = 1.5;         // m, into the aisle past a stall's open end

const rad = (d) => (d * Math.PI) / 180;

/** A unit's footprint: center, half sizes and turn (rot: degrees CCW in u, v). */
function footprint(u) {
  const r = rad(u.rot || 0);
  return { cu: u.u + u.wu / 2, cv: u.v + u.dv / 2, hu: u.wu / 2, hv: u.dv / 2, c: Math.cos(r), s: Math.sin(r) };
}
/** Local (along u, along v before the turn) offset -> model u, v. */
const local = (f, a, b) => [f.cu + a * f.c - b * f.s, f.cv + a * f.s + b * f.c];

/** The unit's own building (a unit inside one sits under its roof), or null. */
const ownBuilding = (model, u) => (model.buildings || []).find((b) => b.id === u.b) || null;

// ---------------------------------------------------------------- the grid

function pip(poly, u, v) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((b[1] > v) !== (a[1] > v) && u < ((a[0] - b[0]) * (v - b[1])) / (a[1] - b[1]) + b[0]) inside = !inside;
  }
  return inside;
}

/** Every polygon of open ground: the pads and the sections. */
function lotPolys(model) {
  const out = [];
  (model.pads || (model.pad ? [model.pad] : [])).forEach((p) => { if (p && p.length > 2) out.push(p); });
  (model.zones || []).forEach((z) => (z.polys && z.polys.length ? z.polys : [z.uv]).forEach((p) => { if (p && p.length > 2) out.push(p); }));
  return out;
}

/** Fill a polygon into a mask (scanline over cell centers). */
function fillPoly(g, poly, mask) {
  let v0 = Infinity, v1 = -Infinity; poly.forEach((p) => { v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]); });
  const j0 = Math.max(0, Math.ceil((v0 - g.v0) / g.cell)), j1 = Math.min(g.nv - 1, Math.floor((v1 - g.v0) / g.cell));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const v = g.v0 + j * g.cell; xs.length = 0;
    for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
      const a = poly[k], b = poly[i];
      if ((b[1] > v) !== (a[1] > v)) xs.push(a[0] + ((v - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let x = 0; x + 1 < xs.length; x += 2) {
      const i0 = Math.max(0, Math.ceil((xs[x] - g.u0) / g.cell)), i1 = Math.min(g.nu - 1, Math.floor((xs[x + 1] - g.u0) / g.cell));
      for (let i = i0; i <= i1; i++) mask[j * g.nu + i] = 1;
    }
  }
}

/** Visit every cell whose center lies in a (turned) rectangle grown by `pad`. */
function eachInRect(g, f, pad, fn) {
  const hu = f.hu + pad, hv = f.hv + pad;
  const eu = Math.abs(hu * f.c) + Math.abs(hv * f.s), ev = Math.abs(hu * f.s) + Math.abs(hv * f.c);
  const i0 = Math.max(0, Math.ceil((f.cu - eu - g.u0) / g.cell)), i1 = Math.min(g.nu - 1, Math.floor((f.cu + eu - g.u0) / g.cell));
  const j0 = Math.max(0, Math.ceil((f.cv - ev - g.v0) / g.cell)), j1 = Math.min(g.nv - 1, Math.floor((f.cv + ev - g.v0) / g.cell));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const du = g.u0 + i * g.cell - f.cu, dv = g.v0 + j * g.cell - f.cv;
      const a = du * f.c + dv * f.s, b = -du * f.s + dv * f.c;
      if (Math.abs(a) <= hu && Math.abs(b) <= hv) fn(j * g.nu + i);
    }
}

const buildingPrint = (b) => ({ cu: (b.u[0] + b.u[1]) / 2, cv: (b.v[0] + b.v[1]) / 2, hu: (b.u[1] - b.u[0]) / 2, hv: (b.v[1] - b.v[0]) / 2, c: 1, s: 0 });

/** The static grid of one model: how many footprints cover each cell (the lot
 *  edge counts as one more), so a query can lift its own unit out. */
function buildStatic(model) {
  const lots = lotPolys(model);
  const inLot = (u, v) => lots.some((p) => pip(p, u, v));
  const prints = [];   // [footprint, unit or null]
  (model.buildings || []).forEach((b) => prints.push([buildingPrint(b), null]));
  (model.units || []).forEach((u) => {
    if (ownBuilding(model, u)) return;   // under its building's roof: the building is the wall
    if (!(u.wu > 0 && u.dv > 0)) return;
    prints.push([footprint(u), u]);
  });
  const gates = (model.gates || []).filter((x) => x && x.uv);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const take = (u, v) => { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); };
  lots.forEach((p) => p.forEach((q) => take(q[0], q[1])));
  prints.forEach(([f]) => { take(f.cu - f.hu - f.hv, f.cv - f.hu - f.hv); take(f.cu + f.hu + f.hv, f.cv + f.hu + f.hv); });
  gates.forEach((x) => take(x.uv[0], x.uv[1]));
  if (!Number.isFinite(u0)) return null;
  const m = ORPHAN_MARGIN + 4; u0 -= m; v0 -= m; u1 += m; v1 += m;
  const cell = Math.min(1, Math.max(0.5, Math.sqrt(((u1 - u0) * (v1 - v0)) / 110000)));
  const nu = Math.ceil((u1 - u0) / cell) + 1, nv = Math.ceil((v1 - v0) / cell) + 1;
  const g = { u0, v0, cell, nu, nv };
  const N = nu * nv;
  // Open ground: the lot polygons, a margin around anything that sits off them, the gates.
  const open = new Uint8Array(N);
  lots.forEach((p) => fillPoly(g, p, open));
  if (!lots.length) open.fill(1);
  prints.forEach(([f]) => { if (!inLot(f.cu, f.cv)) eachInRect(g, f, ORPHAN_MARGIN, (k) => { open[k] = 1; }); });
  gates.forEach((x) => {
    const [gu, gv] = x.uv; const r = Math.ceil(GATE_RADIUS / cell);
    const ci = Math.round((gu - u0) / cell), cj = Math.round((gv - v0) / cell);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= nu || j >= nv) continue;
      if (Math.hypot(di, dj) * cell <= GATE_RADIUS) open[j * nu + i] = 1;
    }
  });
  const count = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (!open[k]) count[k] = 1;
  const byUnit = new Map();
  prints.forEach(([f, u]) => {
    const cells = [];
    eachInRect(g, f, cell * 0.5, (k) => { if (count[k] < 255) count[k]++; cells.push(k); });   // half a cell more: a wall cell never stops short of the real edge
    if (u) byUnit.set(u, cells);
  });
  const st = { ...g, count, byUnit, gates, outside: Uint8Array.from(open, (x) => (x ? 0 : 1)) };
  // Which open areas a vehicle can reach at all (the narrowest clearance, every
  // unit a wall): a unit in an area no gate opens to (a schematic "unmapped"
  // block off the lot) skips the search and takes the fallback at once.
  const wall = new Uint8Array(N); for (let k = 0; k < N; k++) wall[k] = count[k] ? 1 : 0;
  st.dist = distanceField(g, wall);
  const R = CLEARANCES.at(-1); const label = new Int32Array(N).fill(-1); let next = 0; const stack = [];
  for (let k0 = 0; k0 < N; k0++) {
    if (label[k0] >= 0 || st.dist[k0] < R) continue;
    label[k0] = next; stack.push(k0);
    while (stack.length) {
      const k = stack.pop(); const i = k % nu, j = (k / nu) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nu || b >= nv) continue;
        const n = b * nu + a; if (label[n] < 0 && st.dist[n] >= R) { label[n] = next; stack.push(n); }
      }
    }
    next++;
  }
  const free = (k) => st.dist[k] < R;
  st.reach = (p) => { const c = freeNear(st, free, cellOf(st, p)); return c ? label[c[1] * nu + c[0]] : -1; };
  st.gateAreas = new Set(gates.map((x) => st.reach(x.uv)).filter((x) => x >= 0));
  return st;
}

const statics = new WeakMap();
function staticGrid(model) {
  if (!statics.has(model)) statics.set(model, buildStatic(model));
  return statics.get(model);
}

/** Two-pass chamfer distance (meters) from every cell to the nearest wall cell. */
function distanceField(g, wall) {
  const { nu, nv, cell } = g; const N = nu * nv; const d = new Float32Array(N);
  const BIG = 1e6; const a = cell, b = cell * Math.SQRT2;
  for (let k = 0; k < N; k++) d[k] = wall[k] ? 0 : BIG;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const k = j * nu + i; let x = d[k]; if (!x) continue;
    if (i > 0) x = Math.min(x, d[k - 1] + a);
    if (j > 0) {
      x = Math.min(x, d[k - nu] + a);
      if (i > 0) x = Math.min(x, d[k - nu - 1] + b);
      if (i < nu - 1) x = Math.min(x, d[k - nu + 1] + b);
    }
    d[k] = x;
  }
  for (let j = nv - 1; j >= 0; j--) for (let i = nu - 1; i >= 0; i--) {
    const k = j * nu + i; let x = d[k]; if (!x) continue;
    if (i < nu - 1) x = Math.min(x, d[k + 1] + a);
    if (j < nv - 1) {
      x = Math.min(x, d[k + nu] + a);
      if (i < nu - 1) x = Math.min(x, d[k + nu + 1] + b);
      if (i > 0) x = Math.min(x, d[k + nu - 1] + b);
    }
    d[k] = x;
  }
  return d;
}

/** The grid for one unit: its own footprint lifted out, then the clearance field. */
function queryGrid(model, u) {
  const s = staticGrid(model); if (!s) return null;
  const wall = new Uint8Array(s.count.length);
  for (let k = 0; k < wall.length; k++) wall[k] = s.count[k] ? 1 : 0;
  const own = s.byUnit.get(u);
  if (own) own.forEach((k) => { if (s.count[k] <= 1) wall[k] = 0; });
  return { ...s, wall, dist: distanceField(s, wall) };
}

/** A door or stall end just past the lot outline (the outline is traced from
 *  the parcel and runs tight): open the ground around it, footprints stay walls. */
function openAround(g, p) {
  const r = Math.ceil(GOAL_RADIUS / g.cell); const [ci, cj] = cellOf(g, p); let changed = false;
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= g.nu || j >= g.nv || Math.hypot(di, dj) * g.cell > GOAL_RADIUS) continue;
    const k = j * g.nu + i;
    if (g.wall[k] && g.outside[k] && g.count[k] === 1) { g.wall[k] = 0; changed = true; }
  }
  if (changed) g.dist = distanceField(g, g.wall);
}

const cellOf = (g, p) => [Math.min(g.nu - 1, Math.max(0, Math.round((p[0] - g.u0) / g.cell))), Math.min(g.nv - 1, Math.max(0, Math.round((p[1] - g.v0) / g.cell)))];
const at = (g, i, j) => [g.u0 + i * g.cell, g.v0 + j * g.cell];
const clearAt = (g, p) => { const [i, j] = cellOf(g, p); return g.dist[j * g.nu + i]; };

// ---------------------------------------------------------------- the goal

/** Where a person stands to reach the unit: outside a drive-up door, in the
 *  aisle at a stall's open end, or at the nearest wall of the building for a
 *  hallway unit (then the last leg goes inside to the unit itself). */
export function routeGoal(model, u) {
  return goalFor(model, u, null);
}

/** The middle of the site: the center of every unit and building, cached per model. */
const CENTERS = new WeakMap();
function siteCenter(model) {
  if (CENTERS.has(model)) return CENTERS.get(model);
  let su = 0, sv = 0, n = 0;
  for (const x of model.units || []) { su += x.u + x.wu / 2; sv += x.v + x.dv / 2; n++; }
  for (const b of model.buildings || []) { su += (b.u[0] + b.u[1]) / 2 * 4; sv += (b.v[0] + b.v[1]) / 2 * 4; n += 4; }
  const c = n ? [su / n, sv / n] : [0, 0]; CENTERS.set(model, c); return c;
}

function goalFor(model, u, g) {
  const own = ownBuilding(model, u);
  const f = footprint(u); const cu = f.cu, cv = f.cv;
  const inAny = (q) => (model.buildings || []).some((x) => q[0] > x.u[0] && q[0] < x.u[1] && q[1] > x.v[0] && q[1] < x.v[1]);
  // The building's walls, nearest first; a wall that backs onto another building is no way in.
  const wallSides = (b) => {
    const w = [[cu - b.u[0], [b.u[0] - OUT, cv]], [b.u[1] - cu, [b.u[1] + OUT, cv]], [cv - b.v[0], [cu, b.v[0] - OUT]], [b.v[1] - cv, [cu, b.v[1] + OUT]]].sort((x, y) => x[0] - y[0]);
    return w.filter((x) => !inAny(x[1])).concat(w.filter((x) => inAny(x[1])));
  };
  if (own && u.k !== 'park') {
    if (u.k === 'du' || u.k === 'ccdu') return { goal: driveUpPoint(model, u, f, own, wallSides), inside: null };
    return { goal: wallSides(own)[0][1], inside: [cu, cv] };
  }
  if (!g) g = queryGrid(model, u);
  if (!g) return { goal: u.k === 'park' || !u.door ? [cu, cv] : doorPoint(u, f), inside: null };
  const room = (p) => clearAt(g, p) + 0.25 * clearAt(g, [p[0] + (p[0] - cu) * 0.6, p[1] + (p[1] - cv) * 0.6]);
  if (u.k === 'park' || !u.door) {
    // An open stall (or anything without a door): the short end that opens to
    // an aisle - the end with the most room in front of it.
    const along = f.hu >= f.hv;   // the long axis runs along u before the turn
    const ends = along ? [local(f, f.hu + STALL_OUT, 0), local(f, -f.hu - STALL_OUT, 0)] : [local(f, 0, f.hv + STALL_OUT), local(f, 0, -f.hv - STALL_OUT)];
    // Both ends open: the one that faces INTO the site, never the end on the
    // fence / road side (Visesh, Oct 20 - the route ran outside the fence to
    // reach a stall on the edge of the lot). Only room decides when one end is
    // walled in.
    const r = ends.map(room);
    const open = r.map((x) => x >= 1.2);
    if (open[0] && open[1]) {
      const c = siteCenter(model); const d = ends.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1]));
      return { goal: d[1] < d[0] ? ends[1] : ends[0], inside: null, stall: true };
    }
    return { goal: r[1] > r[0] + 0.05 ? ends[1] : ends[0], inside: null, stall: true };
  }
  // A container or shed on the lot: in front of its door - unless the plan
  // puts the door against the next box, then the side with the most room.
  const door = doorPoint(u, f);
  if (clearAt(g, door) >= 1.6) return { goal: door, inside: null };
  const sides = [local(f, 0, f.hv + OUT), local(f, f.hu + OUT, 0), local(f, -f.hu - OUT, 0), local(f, 0, -f.hv - OUT)];
  let best = door, br = room(door);
  sides.forEach((p) => { const r = room(p); if (r > br + 0.3) { best = p; br = r; } });
  return { goal: best, inside: null };
}

/** Just outside the door side (ne = +v, sw = -v, e = +u, w = -u, turned with the unit). */
function doorPoint(u, f) {
  return u.door === 'ne' ? local(f, 0, f.hv + OUT) : u.door === 'e' ? local(f, f.hu + OUT, 0) : u.door === 'w' ? local(f, -f.hu - OUT, 0) : local(f, 0, -f.hv - OUT);
}

/** Outside a drive-up door. When the plan leaves the door point inside a
 *  building's outline (outlines are a little generous, and some touch), it
 *  moves out through the door side - or, if open ground is far that way (the
 *  door faces into the building), to the unit's nearest outside wall. */
function driveUpPoint(model, u, f, b, wallSides) {
  const p = doorPoint(u, f);
  const inB = (q) => (model.buildings || []).some((x) => q[0] > x.u[0] && q[0] < x.u[1] && q[1] > x.v[0] && q[1] < x.v[1]);
  if (!inB(p)) return p;
  const dir = [p[0] - f.cu, p[1] - f.cv]; const L = Math.hypot(dir[0], dir[1]) || 1; dir[0] /= L; dir[1] /= L;
  for (let s = 0.5; s <= 8; s += 0.5) { const q = [p[0] + dir[0] * s, p[1] + dir[1] * s]; if (!inB(q)) return [q[0] + dir[0] * OUT * 0.5, q[1] + dir[1] * OUT * 0.5]; }
  return wallSides(b)[0][1];
}

// ---------------------------------------------------------------- search

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

/** The free cell nearest to [i, j] (itself when free). */
function freeNear(g, blocked, [i, j]) {
  if (!blocked(j * g.nu + i)) return [i, j];
  for (let r = 1; r < 60; r++)
    for (let di = -r; di <= r; di++)
      for (let dj = -r; dj <= r; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const a = i + di, b = j + dj;
        if (a >= 0 && b >= 0 && a < g.nu && b < g.nv && !blocked(b * g.nu + a)) return [a, b];
      }
  return null;
}

/** A* from every source (each with a head start cost) to the target; cells
 *  nearer a wall cost more. Returns { cells (source to target), source index } or null. */
function search(g, blocked, sources, t) {
  const { nu, nv, cell, dist } = g; const N = nu * nv;
  const gs = new Float32Array(N).fill(Infinity); const from = new Int32Array(N).fill(-1); const done = new Uint8Array(N);
  const origin = new Map();
  const h = (k) => { const du = Math.abs((k % nu) - t[0]), dv = Math.abs(((k / nu) | 0) - t[1]); return (Math.max(du, dv) + 0.414 * Math.min(du, dv)) * cell; };
  const pen = (k) => { const d = dist[k]; return d >= PREFER ? 1 : 1 + NEAR_COST * ((PREFER - d) / PREFER) ** 2; };
  const heap = new Heap();
  sources.forEach((s, n) => {
    if (!s) return; const k = s.cell[1] * nu + s.cell[0];
    if (s.cost < gs[k]) { gs[k] = s.cost; origin.set(k, n); heap.push(k, s.cost + h(k)); }
  });
  const ti = t[1] * nu + t[0];
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  let hit = false;
  while (heap.size) {
    const c = heap.pop(); if (done[c]) continue; done[c] = 1;
    if (c === ti) { hit = true; break; }
    const ci = c % nu, cj = (c / nu) | 0; const pc = pen(c);
    for (const [di, dj, w] of D) {
      const a = ci + di, b = cj + dj; if (a < 0 || b < 0 || a >= nu || b >= nv) continue;
      const n = b * nu + a; if (done[n] || blocked(n)) continue;
      if (di && dj && (blocked(cj * nu + a) || blocked(b * nu + ci))) continue;   // no cutting a wall's corner
      const ng = gs[c] + w * cell * (pc + pen(n)) / 2;
      if (ng < gs[n]) { gs[n] = ng; from[n] = c; heap.push(n, ng + h(n)); }
    }
  }
  if (!hit) return null;
  const out = []; let c = ti;
  for (;;) { out.push([c % nu, (c / nu) | 0]); if (from[c] < 0) break; c = from[c]; }
  return { cells: out.reverse(), source: origin.get(c) };
}

/** The smallest clearance along a straight line from p to q (meters). */
function lineClear(g, p, q) {
  const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (g.cell * 0.5)));
  let m = Infinity;
  for (let s = 0; s <= n; s++) m = Math.min(m, clearAt(g, [p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n]));
  return m;
}

/** Pull the string tight: a shortcut is taken only where it keeps (nearly)
 *  the clearance the grid path had over the same stretch, so the line stays
 *  in the middle of the aisle instead of cutting stall corners. */
function pullTight(g, pts, floor) {
  const cl = pts.map((p) => clearAt(g, p));
  const tight = [pts[0]]; let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    for (; j > i + 1; j--) {
      let need = Infinity; for (let k = i; k <= j; k++) need = Math.min(need, cl[k]);
      need = Math.max(floor, Math.min(need - 0.35, PREFER - 0.5));
      if (lineClear(g, pts[i], pts[j]) >= need) break;
    }
    tight.push(pts[j]); i = j;
  }
  // Drop near-straight joints (less than ~8 degrees) where the merged line still clears.
  for (let k = 1; k < tight.length - 1; k++) {
    const a = tight[k - 1], b = tight[k], c = tight[k + 1];
    const t = Math.abs(turnAngle(a, b, c));
    if (t < 8 && lineClear(g, a, c) >= floor) { tight.splice(k, 1); k--; }
  }
  return tight;
}

/** Signed turn at b going a -> b -> c, degrees (positive = left, u/v is right-handed). */
function turnAngle(a, b, c) {
  const x1 = b[0] - a[0], y1 = b[1] - a[1], x2 = c[0] - b[0], y2 = c[1] - b[1];
  return (Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2) * 180) / Math.PI;
}

// ---------------------------------------------------------------- the old grid (fallback)

/** The first cut: buildings only, from the first gate. Used when the lot grid finds no way. */
function legacyPath(model, gate, goal) {
  const rects = (model.buildings || []).map((b) => [b.u[0] - WALL_GAP, b.u[1] + WALL_GAP, b.v[0] - WALL_GAP, b.v[1] + WALL_GAP]);
  let u0 = Math.min(gate[0], goal[0]), u1 = Math.max(gate[0], goal[0]), v0 = Math.min(gate[1], goal[1]), v1 = Math.max(gate[1], goal[1]);
  rects.forEach((r) => { u0 = Math.min(u0, r[0]); u1 = Math.max(u1, r[1]); v0 = Math.min(v0, r[2]); v1 = Math.max(v1, r[3]); });
  u0 -= 20; v0 -= 20; u1 += 20; v1 += 20;
  const cell = Math.max(1.5, Math.max(u1 - u0, v1 - v0) / 260);
  const nu = Math.ceil((u1 - u0) / cell) + 1, nv = Math.ceil((v1 - v0) / cell) + 1;
  const wall = new Uint8Array(nu * nv);
  rects.forEach(([a, b, c, d]) => {
    for (let i = Math.max(0, Math.floor((a - u0) / cell)); i <= Math.min(nu - 1, Math.ceil((b - u0) / cell)); i++)
      for (let j = Math.max(0, Math.floor((c - v0) / cell)); j <= Math.min(nv - 1, Math.ceil((d - v0) / cell)); j++) {
        const cu = u0 + i * cell, cv = v0 + j * cell;
        if (cu >= a && cu <= b && cv >= c && cv <= d) wall[j * nu + i] = 1;
      }
  });
  const g = { u0, v0, cell, nu, nv }; g.dist = distanceField(g, wall);
  const blocked = (k) => wall[k] === 1;
  const s = freeNear(g, blocked, cellOf(g, gate)), t = freeNear(g, blocked, cellOf(g, goal));
  const r = s && t ? search(g, blocked, [{ cell: s, cost: 0 }], t) : null;
  const pts = [gate, ...(r ? r.cells.slice(1, -1).map(([i, j]) => at(g, i, j)) : []), goal];
  const inRect = (p) => rects.some((q) => p[0] > q[0] && p[0] < q[1] && p[1] > q[2] && p[1] < q[3]);
  const clearLine = (p, q) => { const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (cell * 0.5)); for (let k = 1; k < n; k++) if (inRect([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n])) return false; return true; };
  const tight = [pts[0]]; let i = 0;
  while (i < pts.length - 1) { let j = pts.length - 1; while (j > i + 1 && !clearLine(pts[i], pts[j])) j--; tight.push(pts[j]); i = j; }
  return tight;
}

// ---------------------------------------------------------------- the route

const routes = new WeakMap();   // model -> Map(unit -> route)

/** The whole route for a unit: { points, gate, goal, inside, fallback }, cached. */
export function findRoute(model, u) {
  const gates = (model && model.gates || []).filter((x) => x && x.uv);
  if (!gates.length || !u) return null;
  if (!routes.has(model)) routes.set(model, new Map());
  const memo = routes.get(model);
  if (memo.has(u)) return memo.get(u);
  const r = computeRoute(model, u, gates);
  if (memo.size > 64) memo.clear();
  memo.set(u, r);
  return r;
}

/** The gate every route starts from: the one with id 'main', else the first. */
export function mainGate(gates) {
  return (gates || []).find((x) => x && x.id === 'main') || gates[0];
}

function computeRoute(model, u, gates) {
  const g = queryGrid(model, u);
  const { goal, inside, stall } = goalFor(model, u, g);
  if (g) openAround(g, goal);
  const st = staticGrid(model);
  if (g && st && st.gateAreas.has(st.reach(goal))) {
    for (const R of CLEARANCES) {
      const blocked = (k) => g.dist[k] < R;
      const t = freeNear(g, blocked, cellOf(g, goal)); if (!t) continue;
      // Always the main gate (Visesh, Oct 20) - side entrances are not for customers.
      const gate = mainGate(gates);
      const c0 = freeNear(g, blocked, cellOf(g, gate.uv));
      const r = c0 && search(g, blocked, [{ cell: c0, cost: 0 }], t);
      if (!r) continue;
      const pts = [gate.uv, ...r.cells.map(([i, j]) => at(g, i, j)), goal];
      const tight = pullTight(g, pts, Math.min(R, 0.8));
      return { points: finish(tight, inside), gate, goal, inside, stall: !!stall, fallback: false };
    }
  }
  // No way through the lot (a model with gaps in it): the old buildings-only path, flagged.
  const gate = mainGate(gates);
  return { points: finish(legacyPath(model, gate.uv, goal), inside), gate, goal, inside, stall: !!stall, fallback: true };
}

function finish(pts, inside) {
  const out = pts.slice(); if (inside) out.push(inside);
  // drop zero-length legs
  const clean = [out[0]];
  for (let i = 1; i < out.length; i++) if (Math.hypot(out[i][0] - clean.at(-1)[0], out[i][1] - clean.at(-1)[1]) > 0.05 || i === out.length - 1) clean.push(out[i]);
  return clean.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]);
}

/** [[u, v], ...] from the best entrance gate to the unit, or null without a gate. */
export function routePath(model, u) {
  const r = findRoute(model, u);
  return r ? r.points : null;
}

// ---------------------------------------------------------------- turn-by-turn

const FT = 3.28084;
/** Meters as a spoken distance in feet: to the nearest 5 ft, 10 ft past 100. */
export function feet(m) {
  const f = m * FT; const step = f >= 100 ? 10 : 5;
  return `${Math.max(step, Math.round(f / step) * step)} ft`;
}

/** The name of what a leg runs along: the section it is in, else the group of the units beside it. */
function legName(model, a, b) {
  const groups = new Map();
  (model.zones || []).forEach((z) => groups.set(z.id, z));
  (model.buildings || []).forEach((x) => groups.set(x.id, x));
  const votes = new Map();
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
  for (let s = 1; s < n; s++) {
    const p = [a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n];
    let best = null, bd = 12;
    (model.units || []).forEach((x) => { const d = Math.hypot(x.u + x.wu / 2 - p[0], x.v + x.dv / 2 - p[1]); if (d < bd) { bd = d; best = x.b; } });
    if (!best) (model.zones || []).forEach((z) => { if ((z.polys && z.polys.length ? z.polys : [z.uv]).some((q) => q && q.length > 2 && pip(q, p[0], p[1]))) best = z.id; });
    if (best) votes.set(best, (votes.get(best) || 0) + 1);
  }
  let top = null, tv = 0; votes.forEach((v, k) => { if (v > tv) { tv = v; top = k; } });
  const grp = top && groups.get(top);
  if (!grp || top === 'UNMAPPED' || tv < (n - 1) / 2) return '';
  return grp.name || '';
}

/** Douglas-Peucker: the path's shape for spoken steps, wiggles under `tol` m dropped. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const [a, b] = [pts[0], pts.at(-1)]; const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1;
  let worst = -1, wd = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = L > 1e-6 ? Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / L : Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]);
    if (d > wd) { wd = d; worst = i; }
  }
  if (wd <= tol) return [a, b];
  return simplify(pts.slice(0, worst + 1), tol).slice(0, -1).concat(simplify(pts.slice(worst), tol));
}

function turnWord(t) {
  const a = Math.abs(t); const side = t > 0 ? 'left' : 'right';
  if (a < 30) return null;
  if (a < 60) return `Bear ${side}`;
  if (a > 150) return 'Turn around';
  return `Turn ${side}`;
}

/** Plain turn-by-turn steps for a route: [{ text, uv, kind }]. kind is
 *  start | drive | turn | arrive | inside. US units, no em dashes. */
export function routeDirections(model, u, route) {
  const r = route || findRoute(model, u);
  if (!r) return [];
  const path = r.inside ? r.points.slice(0, -1) : r.points.slice();
  const pts = simplify(path, 3);
  const out = [];
  const gates = (model.gates || []).filter((x) => x && x.uv);
  const notMain = gates.length > 1 && r.gate !== gates[0];
  out.push({ kind: 'start', uv: pts[0], text: `Enter at ${r.gate.name || 'the Gate'}${notMain ? ` (the closest entrance to ${u.n})` : ''}` });
  // Merge legs: a joint that barely turns does not get its own step.
  const legs = []; let start = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const t = i < pts.length - 1 ? turnAngle(pts[i - 1], pts[i], pts[i + 1]) : 0;
    if (i === pts.length - 1 || turnWord(t)) { legs.push({ a: start, b: pts[i], turn: i < pts.length - 1 ? t : 0 }); start = pts[i]; }
  }
  legs.forEach((l, i) => {
    const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]);
    if (len >= 1) {
      const name = legName(model, l.a, l.b);
      out.push({ kind: 'drive', uv: l.a, text: `${i === 0 ? 'Drive' : 'Continue'} ${feet(len)}${name ? ` along ${name}` : ''}` });
    }
    if (i < legs.length - 1) { const w = turnWord(l.turn); if (w) out.push({ kind: 'turn', uv: l.b, text: w }); }
  });
  const f = footprint(u); const end = path.at(-1); const prev = path.length > 1 ? path.at(-2) : null;
  const own = ownBuilding(model, u);
  if (r.inside && own) {
    out.push({ kind: 'inside', uv: end, text: `Park at ${own.name || 'the Building'} and go inside` });
    if (own.floors > 1) out.push({ kind: 'inside', uv: r.inside, text: u.f > 1 ? `Take the elevator or stairs to Level ${u.f}` : 'Stay on the ground floor' });
    out.push({ kind: 'arrive', uv: r.inside, text: `Unit ${u.n} is inside` });
    return out;
  }
  let side = 'ahead';
  if (prev) {
    const t = turnAngle(prev, end, [f.cu, f.cv]);
    side = Math.abs(t) < 35 ? 'ahead' : Math.abs(t) > 145 ? 'behind you' : t > 0 ? 'on your left' : 'on your right';
  }
  out.push({ kind: 'arrive', uv: end, text: `Unit ${u.n} is ${side}` });
  return out;
}

/** The route: the path plus one stop per step of `steps` (routeSteps output),
 *  each with where it is, so a step can be clicked to move the camera there.
 *  Also: `directions` (turn-by-turn, see routeDirections), `gate` (the entrance
 *  used) and `fallback` (true when the lot grid found no way and the old
 *  buildings-only path is shown). */
export function planRoute(model, u, steps) {
  const r = findRoute(model, u);
  if (!r) return null;
  const points = r.points; const f = footprint(u);
  let length = 0; for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  const stops = (steps || []).map((s, i) => {
    if (i === 0) return { ...s, label: r.gate.name || s.label, uv: points[0] };
    return { ...s, uv: s.end ? [f.cu, f.cv] : r.goal };
  });
  return { points, stops, length: Math.round(length), directions: routeDirections(model, u, r), gate: { id: r.gate.id, name: r.gate.name, uv: r.gate.uv }, fallback: r.fallback };
}
