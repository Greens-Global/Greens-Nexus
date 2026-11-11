import { describe, it, expect } from 'vitest';
import { recognizeInk, shapeFromInk, INK_MIN_POINTS } from './inkShape';

// Seeded so every run draws the same "hand".
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A freedraw element from board-space points, jittered by up to `jitter` px.
function stroke(abs, { jitter = 2, seed = 1, x0 = 100, y0 = 50 } = {}) {
  const r = rng(seed);
  const pts = abs.map(([x, y]) => [x + (r() - 0.5) * 2 * jitter, y + (r() - 0.5) * 2 * jitter]);
  const ox = pts[0][0] + x0, oy = pts[0][1] + y0;
  const shifted = pts.map(([x, y]) => [x + x0, y + y0]);
  return {
    type: 'freedraw', id: 'f1', x: ox, y: oy, width: 0, height: 0, angle: 0,
    points: shifted.map(([x, y]) => [x - ox, y - oy]),
    strokeColor: '#c0392b', strokeWidth: 4, opacity: 80, roughness: 1, groupIds: ['g1'], frameId: 'fr1',
  };
}

// Points every `step` px along a polyline.
function along(vertices, step = 5) {
  const out = [];
  for (let i = 1; i < vertices.length; i += 1) {
    const [ax, ay] = vertices[i - 1], [bx, by] = vertices[i];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k += 1) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(vertices[vertices.length - 1]);
  return out;
}

// A closed polygon drawn starting `from` of the way along its first edge,
// ending `overshoot` px past where it started (people overshoot the close).
function closedPoly(vs, { from = 0, overshoot = 0, step = 5 } = {}) {
  const [a, b] = vs;
  const start = [a[0] + (b[0] - a[0]) * from, a[1] + (b[1] - a[1]) * from];
  const pts = along([start, ...vs.slice(1), ...vs.slice(0, 1), start], step);
  if (overshoot) {
    const len = Math.hypot(b[0] - start[0], b[1] - start[1]) || 1;
    pts.push([start[0] + ((b[0] - start[0]) / len) * overshoot, start[1] + ((b[1] - start[1]) / len) * overshoot]);
  }
  return pts;
}

const rectPts = (w, h, opts) => closedPoly([[0, 0], [w, 0], [w, h], [0, h]], opts);
const ellipsePts = (rx, ry, n = 80, sweep = 1) => Array.from({ length: n + 1 }, (_, i) => {
  const t = (i / n) * Math.PI * 2 * sweep - Math.PI / 2;
  return [rx + rx * Math.cos(t), ry + ry * Math.sin(t)];
});

describe('recognizeInk', () => {
  it.each([
    [200, 120, 1], [60, 60, 2], [300, 90, 3], [80, 160, 4],
  ])('a rectangle %ix%i', (w, h, seed) => {
    const rec = recognizeInk(stroke(rectPts(w, h, { overshoot: 6 }), { seed }));
    expect(rec?.kind).toBe('rectangle');
    expect(rec.width).toBeGreaterThan(w - 8);
    expect(rec.width).toBeLessThan(w + 8);
    expect(rec.height).toBeGreaterThan(h - 8);
    expect(rec.x).toBeGreaterThan(100 - 6);
    expect(rec.x).toBeLessThan(100 + 6);
  });

  it('a rectangle started mid-edge', () => {
    expect(recognizeInk(stroke(rectPts(180, 110, { from: 0.5 }), { seed: 7 }))?.kind).toBe('rectangle');
  });

  it.each([
    [80, 50, 11], [30, 30, 12], [120, 40, 13], [40, 90, 14],
  ])('an ellipse rx %i ry %i', (rx, ry, seed) => {
    const rec = recognizeInk(stroke(ellipsePts(rx, ry), { seed }));
    expect(rec?.kind).toBe('ellipse');
    expect(rec.width).toBeGreaterThan(rx * 2 - 8);
    expect(rec.height).toBeLessThan(ry * 2 + 8);
  });

  it('an ellipse whose ends miss each other a little', () => {
    expect(recognizeInk(stroke(ellipsePts(70, 50, 80, 0.95), { seed: 15 }))?.kind).toBe('ellipse');
  });

  it.each([[160, 100, 21], [80, 120, 22]])('a hand-drawn diamond %ix%i', (w, h, seed) => {
    // Corners a few px off the true midpoints, closed with an overshoot.
    const vs = [[w / 2 + 4, 0], [w, h / 2 - 3], [w / 2 - 3, h], [2, h / 2 + 4]];
    expect(recognizeInk(stroke(closedPoly(vs, { from: 0.3, overshoot: 5 }), { seed, jitter: 2.5 }))?.kind).toBe('diamond');
  });

  it.each([
    [[[0, 120], [70, 0], [140, 120]], 31],
    [[[0, 0], [200, 40], [30, 110]], 32],
  ])('a triangle', (vs, seed) => {
    const rec = recognizeInk(stroke(closedPoly(vs, { from: 0.4 }), { seed }));
    expect(rec?.kind).toBe('triangle');
    expect(rec.points).toHaveLength(4);
    expect(rec.points[0]).toEqual(rec.points[3]);
    // Each corner lands within a few px of where it was drawn.
    const abs = rec.points.slice(0, 3).map(([x, y]) => [x + rec.x - 100, y + rec.y - 50]);
    vs.forEach((v) => expect(Math.min(...abs.map((c) => Math.hypot(c[0] - v[0], c[1] - v[1])))).toBeLessThan(10));
  });

  it('a straight line at an angle', () => {
    const rec = recognizeInk(stroke(along([[0, 0], [150, 90]]), { seed: 41 }));
    expect(rec?.kind).toBe('line');
    expect(rec.points[0]).toEqual([0, 0]);
    expect(rec.points[1][0]).toBeGreaterThan(140);
    expect(rec.points[1][1]).toBeGreaterThan(80);
  });

  it('a line drawn right to left', () => {
    const rec = recognizeInk(stroke(along([[200, 10], [0, 0]]), { seed: 42 }));
    expect(rec?.kind).toBe('line');
    expect(rec.points[1][0]).toBeLessThan(-190);
  });

  it('leaves a zigzag alone', () => {
    const vs = Array.from({ length: 9 }, (_, i) => [i * 25, i % 2 ? 40 : 0]);
    expect(recognizeInk(stroke(along(vs), { seed: 51 }))).toBeNull();
  });

  it('leaves a shallow zigzag alone', () => {
    const vs = Array.from({ length: 13 }, (_, i) => [i * 20, i % 2 ? 14 : 0]);
    expect(recognizeInk(stroke(along(vs), { seed: 52 }))).toBeNull();
  });

  it('leaves a spiral alone', () => {
    const pts = Array.from({ length: 150 }, (_, i) => {
      const t = (i / 150) * Math.PI * 6;
      const r = 5 + t * 6;
      return [r * Math.cos(t), r * Math.sin(t)];
    });
    expect(recognizeInk(stroke(pts, { seed: 53 }))).toBeNull();
  });

  it('leaves an open arc (a U) alone', () => {
    const pts = Array.from({ length: 60 }, (_, i) => {
      const t = Math.PI - (i / 59) * Math.PI;
      return [80 + 80 * Math.cos(t), 80 * Math.sin(t)];
    });
    expect(recognizeInk(stroke(pts, { seed: 54 }))).toBeNull();
  });

  it('leaves a tiny dot alone', () => {
    expect(recognizeInk(stroke(ellipsePts(5, 5, 20), { seed: 55, jitter: 0.5 }))).toBeNull();
  });

  it('leaves handwriting alone', () => {
    // Cursive loops, like "eeee".
    const pts = Array.from({ length: 200 }, (_, i) => {
      const t = (i / 200) * Math.PI * 8;
      return [t * 8 - 14 * Math.sin(t), -14 * Math.cos(t)];
    });
    expect(recognizeInk(stroke(pts, { seed: 56 }))).toBeNull();
  });

  it('leaves a closed figure 8 alone', () => {
    const pts = Array.from({ length: 121 }, (_, i) => {
      const t = (i / 120) * Math.PI * 2;
      return [80 + 80 * Math.sin(t), 40 + 40 * Math.sin(t) * Math.cos(t)];
    });
    expect(recognizeInk(stroke(pts, { seed: 57 }))).toBeNull();
  });

  it('leaves a shape drawn twice round alone', () => {
    expect(recognizeInk(stroke(ellipsePts(60, 40, 160, 2), { seed: 58 }))).toBeNull();
  });

  it('leaves a closed scribble alone', () => {
    const r = rng(59);
    const vs = Array.from({ length: 14 }, () => [r() * 120, r() * 80]);
    vs.push(vs[0]);
    expect(recognizeInk(stroke(along(vs), { seed: 59 }))).toBeNull();
  });

  it.each([10, 20, 30])('leaves a square tilted %i degrees alone', (deg) => {
    const a = (deg * Math.PI) / 180;
    const vs = [[0, 0], [100, 0], [100, 100], [0, 100]].map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]);
    expect(recognizeInk(stroke(closedPoly(vs), { seed: deg }))).toBeNull();
  });

  it('leaves a hexagon and a star alone', () => {
    const hex = Array.from({ length: 6 }, (_, i) => [100 * Math.cos((i * Math.PI) / 3), 100 * Math.sin((i * Math.PI) / 3)]);
    expect(recognizeInk(stroke(closedPoly(hex), { seed: 60 }))).toBeNull();
    const star = Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 ? 40 : 100, t = (i * Math.PI) / 5 - Math.PI / 2;
      return [r * Math.cos(t), r * Math.sin(t)];
    });
    expect(recognizeInk(stroke(closedPoly(star), { seed: 61 }))).toBeNull();
  });

  it('needs enough points', () => {
    const vs = [[0, 0], [100, 0], [100, 60], [0, 60], [0, 2]];
    expect(vs.length).toBeLessThan(INK_MIN_POINTS);
    expect(recognizeInk(stroke(vs, { jitter: 0 }))).toBeNull();
  });

  it('ignores anything that is not a freedraw or is rotated', () => {
    expect(recognizeInk(null)).toBeNull();
    expect(recognizeInk({ ...stroke(rectPts(100, 60)), type: 'line' })).toBeNull();
    expect(recognizeInk({ ...stroke(rectPts(100, 60)), angle: 0.3 })).toBeNull();
  });
});

describe('shapeFromInk', () => {
  const now = 1_700_000_000_000;

  it.each([
    ['rectangle', rectPts(150, 90), 'rectangle'],
    ['ellipse', ellipsePts(60, 40), 'ellipse'],
    ['diamond', closedPoly([[60, 0], [120, 40], [60, 80], [0, 40]]), 'diamond'],
  ])('a %s keeps the ink look', (kind, pts, type) => {
    const ink = stroke(pts);
    const rec = recognizeInk(ink);
    expect(rec?.kind).toBe(kind);
    const [el] = shapeFromInk(ink, rec, { now });
    expect(el).toMatchObject({
      type, x: rec.x, y: rec.y, width: rec.width, height: rec.height,
      strokeColor: '#c0392b', strokeWidth: 4, opacity: 80, roughness: 1, groupIds: ['g1'], frameId: 'fr1',
      backgroundColor: 'transparent', version: 1, isDeleted: false, updated: now, customData: { nexusInk: true },
    });
    expect(el.roundness).toEqual(type === 'rectangle' ? { type: 3 } : null);
    expect(el.id).not.toBe(ink.id);
    expect(ink.isDeleted).toBeUndefined();
  });

  it('a line and a triangle become line elements', () => {
    const ink = stroke(along([[0, 0], [150, 90]]));
    const [line] = shapeFromInk(ink, recognizeInk(ink), { now });
    expect(line.type).toBe('line');
    expect(line.points).toHaveLength(2);
    expect(line.strokeColor).toBe('#c0392b');

    const tri = stroke(closedPoly([[0, 120], [70, 0], [140, 120]]));
    const [poly] = shapeFromInk(tri, recognizeInk(tri), { now });
    expect(poly.type).toBe('line');
    expect(poly.points).toHaveLength(4);
    expect(poly.points[0]).toEqual(poly.points[3]);
    expect(poly.strokeWidth).toBe(4);
  });

  it('two shapes get different ids', () => {
    const ink = stroke(rectPts(100, 60));
    const rec = recognizeInk(ink);
    expect(shapeFromInk(ink, rec)[0].id).not.toBe(shapeFromInk(ink, rec)[0].id);
  });

  it('nothing to replace without a recognition', () => {
    expect(shapeFromInk(stroke(rectPts(100, 60)), null)).toEqual([]);
  });
});
