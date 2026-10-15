import { describe, it, expect, vi } from 'vitest';
import { spring, sample, planFor, playPlan, FLOURISH_MS } from './flourishMotion';

// The flourish motion (Neil, Oct 14 2026: "jittery ... needs more frames").
// Smooth means: a sample every frame at 60fps, and no jump between frames.
const parse = (f) => {
  const m = f.transform.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px.*rotate\(([-\d.]+)deg\) scale\(([-\d.]+)/);
  return { x: +m[1], y: +m[2], r: +m[3], s: +m[4], o: f.opacity };
};

describe('flourish motion', () => {
  it('a spring settles at 1 after overshooting it', () => {
    expect(spring(0)).toBe(0);
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => spring(i / 100, 0.42, 2.6)));
    expect(peak).toBeGreaterThan(1);
    expect(spring(3, 0.42, 2.6)).toBeCloseTo(1, 2);
  });

  it('samples 60 frames a second', () => {
    expect(sample(1000, () => ({}))).toHaveLength(61);
  });

  for (const kind of ['coffee', 'check', 'in', 'out']) {
    it(`${kind}: every track is smooth (no jump between frames), starts and ends invisible`, () => {
      for (const step of planFor(kind).filter((s) => s.frames)) {
        const f = step.frames.map(parse);
        expect(f[0].o).toBe(0);
        expect(f[f.length - 1].o).toBeLessThan(0.05);
        for (let i = 1; i < f.length; i += 1) {
          expect(Math.abs(f[i].x - f[i - 1].x)).toBeLessThan(4);      // px per frame
          expect(Math.abs(f[i].y - f[i - 1].y)).toBeLessThan(4);
          expect(Math.abs(f[i].r - f[i - 1].r)).toBeLessThan(12);     // deg per frame
          expect(Math.abs(f[i].o - f[i - 1].o)).toBeLessThan(0.2);
        }
      }
      expect(FLOURISH_MS[kind]).toBeGreaterThan(1400);
    });
  }

  it('the cup ends to the RIGHT of where it started (clear of the tooltip above)', () => {
    const cup = planFor('coffee')[0].frames.map(parse);
    expect(cup[cup.length - 1].x).toBeGreaterThan(55);
  });

  it('plays transforms linearly (the samples carry the easing) and stops cleanly', () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    const el = { animate };
    const root = { querySelectorAll: () => [el] };
    const stop = playPlan(root, [{ sel: 'x', frames: [{ opacity: 0 }, { opacity: 1 }], ms: 500 }, { sel: 'y', draw: true, ms: 300, delay: 100 }]);
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 500, easing: 'linear', fill: 'both' });
    expect(animate.mock.calls[1][0]).toEqual([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }]);
    stop();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
