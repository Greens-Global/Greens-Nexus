import { describe, it, expect } from 'vitest';
import { readGlyph, drawingName, pathPolylines, glyphShapes, ICON_NAMES } from './glyphs';

describe('glyph names', () => {
  it('reads icons, aliases and drawings, and leaves the unknown ones unknown', () => {
    expect(readGlyph('lock')).toEqual({ glyph: 'lock', unknown: '' });
    expect(readGlyph(' Trash ')).toEqual({ glyph: 'trash-2', unknown: '' });
    expect(readGlyph('drawing:gate')).toEqual({ glyph: 'drawing:facility-gate', unknown: '' });
    expect(readGlyph('drawing: roll-up door')).toEqual({ glyph: 'drawing:door-roll-up', unknown: '' });
    expect(readGlyph('drawing:drive-up').glyph).toBe('');   // two drawings end that way: ambiguous, so none
    expect(readGlyph('acme-logo')).toEqual({ glyph: '', unknown: 'acme-logo' });
    expect(readGlyph('')).toEqual({ glyph: '', unknown: '' });
    expect(drawingName('padlock')).toBe('lock-padlock');
    expect(ICON_NAMES).toEqual(expect.arrayContaining(['lock', 'warehouse', 'thermometer', 'cctv', 'building']));
  });
});

describe('pathPolylines', () => {
  it('flattens lines, curves and arcs, absolute and relative, and closes subpaths', () => {
    const [box] = pathPolylines('M0 0 H10 V10 h-10 Z');
    expect(box.closed).toBe(true);
    expect(box.points).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    const subs = pathPolylines('M7 11V7a5 5 0 0 1 10 0v4 M2 2 c1 1 2 2 3 3');
    expect(subs).toHaveLength(2);
    const arcPts = subs[0].points;
    expect(arcPts[0]).toEqual([7, 11]);
    expect(arcPts[arcPts.length - 1]).toEqual([17, 11]);
    // the arc's top is 5 above its ends' line (a half circle of radius 5)
    expect(Math.min(...arcPts.map((p) => p[1]))).toBeCloseTo(2, 0);
    expect(subs[1].points[subs[1].points.length - 1]).toEqual([5, 5]);
  });
});

describe('glyphShapes', () => {
  it('turns a Lucide icon into plain shapes placed and scaled on the box', () => {
    const shapes = glyphShapes('lock', { x: 100, y: 50, w: 20, h: 20, ink: '#111111' });
    expect(shapes.length).toBeGreaterThanOrEqual(2);
    expect(shapes.some((s) => s.kind === 'rect')).toBe(true);
    for (const s of shapes) {
      expect(s.stroke).toBe('#111111');
      const xs = s.kind === 'line' ? s.points.map((p) => p[0]) : [s.x, s.x + s.w];
      const ys = s.kind === 'line' ? s.points.map((p) => p[1]) : [s.y, s.y + s.h];
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(100);
      expect(Math.max(...xs)).toBeLessThanOrEqual(120);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(50);
      expect(Math.max(...ys)).toBeLessThanOrEqual(70);
    }
  });
  it('turns a Training drawing into shapes too, its theme colors fixed', () => {
    const shapes = glyphShapes('drawing:facility-gate', { x: 0, y: 0, w: 64, h: 35, ink: '#222222' });
    expect(shapes.length).toBeGreaterThan(3);
    expect(shapes.every((s) => !String(s.stroke || '').startsWith('var(') && !String(s.fill || '').startsWith('var('))).toBe(true);
  });
  it('is empty for no glyph', () => {
    expect(glyphShapes('', { x: 0, y: 0, w: 20, h: 20 })).toEqual([]);
  });
});
