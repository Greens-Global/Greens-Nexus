// The route from the gate to a unit (siteModelRoute.js): pure, so it is tested
// here without WebGL. It must start at the gate, end at the unit, never cross a
// building footprint, and carry one stop per route step for the step buttons.
import { describe, expect, it } from 'vitest';
import { planRoute, routeGoal, routePath } from './siteModelRoute.js';
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
