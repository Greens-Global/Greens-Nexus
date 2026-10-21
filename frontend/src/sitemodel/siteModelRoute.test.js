// The route from the gate to a unit (siteModelRoute.js): pure, so it is tested
// here without WebGL. It must start at the gate, end at the unit, never cross a
// building or another unit's footprint (parked vehicles block - Visesh, Oct 20),
// keep to the middle of the aisles, and carry one stop per route step for the
// step buttons.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { feet, findRoute, planRoute, routeDirections, routeGoal, routePath } from './siteModelRoute.js';
import { baseUnitColor, mixHex, routeSteps } from './siteModelViewer.js';

const model = {
  gates: [{ id: 'main', name: 'Main Gate', uv: [0, 0] }],
  buildings: [
    { id: 'A', name: 'Building A', u: [20, 60], v: [-10, 10], height: 4, floors: 1 },     // a wall between the gate and B
    { id: 'B', name: 'Building B', u: [80, 120], v: [-10, 10], height: 7, floors: 2 },
  ],
  zones: [],
  units: [
    { n: 'B201', b: 'B', f: 2, u: 100, v: 0, wu: 3, dv: 3, door: 'ne', k: 'cc', w: 10, d: 10 },
    { n: 'B001', b: 'B', f: 1, u: 90, v: -10, wu: 3, dv: 6, door: 'sw', k: 'du', w: 10, d: 20 },
  ],
};
const inside = (p, b) => p[0] > b.u[0] && p[0] < b.u[1] && p[1] > b.v[0] && p[1] < b.v[1];

describe('routePath', () => {
  it('goes from the gate around the building in the way to the drive-up door', () => {
    const u = model.units[1];
    const pts = routePath(model, u);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual(routeGoal(model, u).goal);
    expect(pts.length).toBeGreaterThan(2);   // it had to turn: A blocks the straight line
    // sample every leg: no point falls inside Building A
    for (let i = 1; i < pts.length; i++) for (let k = 0; k <= 20; k++) {
      const p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k / 20, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k / 20];
      expect(inside(p, model.buildings[0])).toBe(false);
    }
  });
  it('ends inside the building for a hallway unit, after reaching its wall', () => {
    const u = model.units[0];
    const pts = routePath(model, u);
    expect(pts.at(-1)).toEqual([101.5, 1.5]);
    expect(inside(pts.at(-2), model.buildings[1])).toBe(false);
  });
  it('is null without a gate', () => {
    expect(routePath({ ...model, gates: [] }, model.units[0])).toBeNull();
  });
});

describe('planRoute', () => {
  it('puts each route step somewhere the camera can go', () => {
    const u = model.units[0];
    const plan = planRoute(model, u, routeSteps(model, u));
    expect(plan.stops.map((s) => s.label)).toEqual(['Main Gate', 'Building B', 'Level 2', 'B201']);
    expect(plan.stops[0].uv).toEqual([0, 0]);
    expect(plan.stops.at(-1).uv).toEqual([101.5, 1.5]);
    expect(plan.length).toBeGreaterThan(100);
  });
});

// ---- a small RV lot: two stall rows, the drive aisle between them
// Lot 0..60 x 8..40; row 1 backs onto the south fence (v 8..14), row 2 faces it
// across a 7 m aisle (v 21..27); the gate is at the west end of the aisle.
const stall = (n, u, v) => ({ n, b: 'R', k: 'park', f: 1, u, v, wu: 3, dv: 6, door: 'ne' });
const lot = {
  gates: [{ id: 'main', name: 'Main Entrance Gate', uv: [1, 17.5] }],
  pads: [[[0, 8], [60, 8], [60, 40], [0, 40]]],
  zones: [{ id: 'R', name: 'Section R', uv: [[0, 8], [60, 8], [60, 40], [0, 40]] }],
  buildings: [],
  units: [
    ...Array.from({ length: 14 }, (_, i) => stall(`R1${String(i).padStart(2, '0')}`, 10 + i * 3, 8)),
    ...Array.from({ length: 14 }, (_, i) => stall(`R2${String(i).padStart(2, '0')}`, 10 + i * 3, 21)),
  ],
};
/** Distance from a point to a unit's (turned) footprint, 0 inside it. */
function distTo(x, p) {
  const r = ((x.rot || 0) * Math.PI) / 180, cu = x.u + x.wu / 2, cv = x.v + x.dv / 2;
  const du = p[0] - cu, dv = p[1] - cv; const a = du * Math.cos(r) + dv * Math.sin(r), b = -du * Math.sin(r) + dv * Math.cos(r);
  return Math.hypot(Math.max(0, Math.abs(a) - x.wu / 2), Math.max(0, Math.abs(b) - x.dv / 2));
}
/** Points every ~0.25 m along a polyline. */
function samples(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) / 0.25));
    for (let k = 0; k <= n; k++) out.push([pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / n, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / n]);
  }
  return out;
}

describe('routing on a stall lot', () => {
  const target = lot.units[11];   // R111, row 1, opens north onto the aisle
  it('ends at the stall end that opens onto the aisle, not the fence end', () => {
    const { goal } = routeGoal(lot, target);
    expect(goal[0]).toBeCloseTo(target.u + 1.5, 5);
    expect(goal[1]).toBeGreaterThan(14);   // north of the stall, in the aisle
    expect(goal[1]).toBeLessThan(17);
  });
  it('never crosses another stall and keeps to the middle of the aisle', () => {
    const pts = routePath(lot, target);
    expect(pts[0]).toEqual([1, 17.5]);
    const along = samples(pts);
    const crossed = along.filter((p) => lot.units.some((x) => x !== target && distTo(x, p) === 0));
    expect(crossed).toEqual([]);
    // The straight run down the aisle sits near its centerline (v 17.5), not grazing a row.
    const run = along.filter((p) => p[0] > 12 && p[0] < target.u - 2);
    expect(run.length).toBeGreaterThan(10);
    expect(Math.max(...run.map((p) => Math.abs(p[1] - 17.5)))).toBeLessThan(1.2);
  });
  it('speaks the route as plain steps in feet', () => {
    const steps = routeDirections(lot, target).map((s) => s.text);
    expect(steps[0]).toBe('Enter at Main Entrance Gate');
    expect(steps.some((t) => /^Drive \d+ ft along Section R$/.test(t))).toBe(true);
    expect(steps.at(-1)).toBe('Unit R111 is on your right');
    expect(steps.join(' ')).not.toMatch(/—/);   // no em dashes
  });
  it('flags the fallback when no way through exists', () => {
    const walled = { ...lot, units: [...lot.units, { n: 'WALL', b: 'R', k: 'in', f: 1, u: 4, v: 8, wu: 2, dv: 32, door: 'e' }] };
    const r = findRoute(walled, walled.units[11]);
    expect(r.fallback).toBe(true);
    expect(r.points[0]).toEqual([1, 17.5]);
  });
  it('rounds distances to feet the way people say them', () => {
    expect(feet(18.3)).toBe('60 ft');
    expect(feet(5)).toBe('15 ft');
    expect(feet(100)).toBe('330 ft');
  });
});

// ---- the real Temecula lot (Visesh's screenshot: the line ran across parked RVs)
const temeculaPath = path.resolve(process.cwd(), '../backend/site_models/greens-storage-temecula.json');   // vitest runs from frontend/
const temecula = fs.existsSync(temeculaPath) ? JSON.parse(fs.readFileSync(temeculaPath, 'utf8')) : null;

describe.skipIf(!temecula)('Temecula', () => {
  const byName = (n) => temecula.units.find((x) => x.n === n);
  const blocks = (u) => temecula.units.filter((x) => x !== u && !temecula.buildings.some((b) => b.id === x.b));
  it('routes A048 along the aisles, around every stall and building', () => {
    const u = byName('A048');
    const plan = planRoute(temecula, u, [{ label: 'Gate' }, { label: 'A048', end: true }]);
    expect(plan.fallback).toBe(false);
    const along = samples(plan.points);
    const others = blocks(u);
    const clearOf = (p) => Math.min(...others.map((x) => distTo(x, p)));
    const inBuilding = along.filter((p) => temecula.buildings.some((b) => p[0] > b.u[0] && p[0] < b.u[1] && p[1] > b.v[0] && p[1] < b.v[1]));
    expect(inBuilding).toEqual([]);
    expect(Math.min(...along.map(clearOf))).toBeGreaterThan(0.3);
    // Away from the two ends (gate, stall) the path keeps a vehicle's half width clear.
    const mid = along.slice(Math.floor(along.length * 0.15), Math.floor(along.length * 0.85));
    expect(Math.min(...mid.map(clearOf))).toBeGreaterThan(0.9);
    expect(plan.directions[0].text).toMatch(/^Enter at /);
    expect(plan.stops[0].label).toBe(plan.gate.name);
  });
  it('never crosses a footprint for any unit (sampled), without blowing up in time', () => {
    const units = temecula.units.filter((_, i) => i % 9 === 0);
    const t0 = performance.now();
    const routes = units.map((u) => [u, findRoute(temecula, u)]);
    const per = (performance.now() - t0) / units.length;
    // A wall-clock guard only against a runaway search (seconds per route): a
    // route takes ~10ms alone but several times that with the suite in parallel.
    expect(per).toBeLessThan(500);
    const crossing = [];
    for (const [u, r] of routes) {
      if (r.fallback) continue;   // the schematic "Unmapped Stalls" block off the lot
      const others = blocks(u);
      const pts = samples(r.inside ? r.points.slice(0, -1) : r.points);
      const hit = others.find((x) => pts.some((p) => distTo(x, p) === 0));
      if (hit) crossing.push(`${u.n} -> ${hit.n}`);
    }
    expect(crossing).toEqual([]);
  });
});

describe('unit colors', () => {
  it('uses a layer color for owners and never for customers', () => {
    const u = { n: 'B201', l: 1, r: 1, k: 'cc' };
    expect(baseUnitColor(u, 'owner', null)).toBe(0x5fae7d);
    expect(baseUnitColor(u, 'owner', { B201: '#2563eb' })).toBe(0x2563eb);
    expect(baseUnitColor(u, 'customer', { B201: '#2563eb' })).not.toBe(0x2563eb);
  });
  it('mixes toward gray for dimming', () => {
    expect(mixHex(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(mixHex(0x123456, 0xffffff, 0)).toBe(0x123456);
  });
});
