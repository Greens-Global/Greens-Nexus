import { describe, it, expect } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, fitView, openingView, panBy, toScreen, toWorld, zoomAt } from './viewport';

const box = { left: 100, top: 50, width: 1000, height: 700 };

describe('viewport', () => {
  it('clamps zoom to the allowed range and keeps the point under the pointer still', () => {
    let v = { x: 0, y: 0, s: 1 };
    for (let i = 0; i < 20; i++) v = zoomAt(v, 1.5, 500, 350);
    expect(v.s).toBe(MAX_ZOOM);
    for (let i = 0; i < 40; i++) v = zoomAt(v, 0.5, 500, 350);
    expect(v.s).toBe(MIN_ZOOM);
    // the sheet point under (500, 350) stays under it across a zoom
    const before = toWorld({ x: 40, y: 20, s: 1 }, { left: 0, top: 0 }, 500, 350);
    const after = toWorld(zoomAt({ x: 40, y: 20, s: 1 }, 1.25, 500, 350), { left: 0, top: 0 }, 500, 350);
    expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y);
  });

  it('leaves the view alone on a bad factor or a broken scale', () => {
    const v = { x: 10, y: 20, s: 1 };
    expect(zoomAt(v, NaN, 100, 100)).toBe(v);
    expect(zoomAt(v, Infinity, 100, 100)).toBe(v);
    expect(zoomAt(v, 0, 100, 100)).toBe(v);
    expect(zoomAt(v, -1, 100, 100)).toBe(v);
    expect(zoomAt({ x: 0, y: 0, s: 0 }, 1.2, 100, 100)).toEqual({ x: 0, y: 0, s: 0 });
    expect(zoomAt(v, 1.2, NaN, 100)).toBe(v);
    const ok = zoomAt(v, 1.2, 100, 100);
    expect(Number.isFinite(ok.x) && Number.isFinite(ok.y) && ok.s === 1.2).toBe(true);
  });

  it('fits the whole sheet inside the box, centered, never above 100%', () => {
    const v = fitView({ w: 2000, h: 1400 }, box);
    expect(v.s).toBeCloseTo(Math.min((1000 - 40) / 2000, (700 - 40) / 1400));
    expect(v.x + 2000 * v.s).toBeCloseTo(1000 - v.x);
    expect(fitView({ w: 200, h: 100 }, box).s).toBe(1);
    expect(fitView({ w: 200, h: 100 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, s: 1 });
  });

  it('opens at reading size with the trigger column centered, or the identity view without a box', () => {
    const trigger = { x: 60, y: 60, w: 264, h: 68 };
    const v = openingView({ w: 1200, h: 900 }, box, trigger);
    expect(v.s).toBe(0.85);
    expect(toScreen(v, { left: 0, top: 0 }, trigger.x + trigger.w / 2, 0).x).toBeCloseTo(500);
    expect(openingView({ w: 1200, h: 900 }, null, trigger)).toEqual({ x: 0, y: 0, s: 1 });
  });

  it('round-trips screen and sheet points and pans by a delta', () => {
    const v = { x: 33, y: -12, s: 0.7 };
    const p = toScreen(v, box, 400, 250);
    const w = toWorld(v, box, p.x, p.y);
    expect(w.x).toBeCloseTo(400); expect(w.y).toBeCloseTo(250);
    expect(panBy(v, 10, -5)).toEqual({ x: 43, y: -17, s: 0.7 });
  });
});
