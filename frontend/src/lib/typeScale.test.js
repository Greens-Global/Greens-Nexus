// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { FS, TYPE_SCALE, SNAP, onScale, snapFor } from './typeScale';

// The type scale (Neil, 11/12/2026): one list of sizes, read by JSX (FS),
// CSS (--fs-*) and the lint guard (scripts/check-type.mjs).
describe('type scale', () => {
  it('has the decided sizes', () => {
    expect(Object.values(FS)).toEqual([11, 12, 13, 14, 15, 18, 24, 32]);
  });

  it('the --fs-* tokens in style.css carry the same numbers as FS', () => {
    const css = readFileSync(fileURLToPath(new URL('../style.css', import.meta.url)), 'utf8');
    for (const [name, px] of Object.entries(FS)) {
      const m = css.match(new RegExp(`--fs-${name}:\\s*(\\d+)px`));
      expect(m, `--fs-${name} missing`).toBeTruthy();
      expect(Number(m[1])).toBe(px);
    }
  });

  it('12.5 rounds up to body (Neil, 11/12/2026)', () => {
    expect(SNAP[12.5]).toBe(FS.body);
    expect(snapFor(12.5)).toBe(13);
  });

  it('every SNAP target is on the scale', () => {
    for (const to of Object.values(SNAP)) expect(onScale(to)).toBe(true);
  });

  it('snapFor handles rem leftovers and outliers', () => {
    expect(snapFor(12.48)).toBe(13);   // 0.78rem
    expect(snapFor(12)).toBe(12);
    expect(snapFor(44)).toBe(32);
    expect(TYPE_SCALE).toContain(0);
  });
});
