// Sagar, Sep 18: "why don't you break the pages, it's showing a single long
// page only for the Editor also."
//
// planBreaks is the whole decision: given the natural heights of the top-level
// blocks and the height of one sheet, which blocks start a new sheet and how
// far do they move. Everything else is measurement and decoration.
import { describe, it, expect } from 'vitest';
import { planBreaks } from './docBuilderPagination';

const SHEET = 864;   // Letter, 1in margins, at 96dpi

describe('planBreaks', () => {
  it('leaves a document that fits on one sheet alone', () => {
    expect(planBreaks([100, 200, 300], SHEET)).toEqual([]);
  });

  it('pushes the block that would straddle the boundary onto the next sheet', () => {
    // 800 used, then a 100-tall block: 64 of room left, so it moves down 64.
    expect(planBreaks([800, 100], SHEET)).toEqual([{ index: 1, gap: 64 }]);
  });

  it('does not move a block that ends exactly on the boundary', () => {
    expect(planBreaks([SHEET, 100], SHEET)).toEqual([]);
  });

  it('does not move the very first block, which has nowhere to go', () => {
    expect(planBreaks([SHEET + 500], SHEET)).toEqual([]);
  });

  it('leaves an over-tall block where it is rather than shunting it forever', () => {
    // Taller than a whole sheet: moving it just puts the same overflow on the
    // next sheet, so it runs across the gutter instead of disappearing.
    const plan = planBreaks([100, SHEET + 400], SHEET);
    expect(plan).toEqual([]);
  });

  it('keeps accumulating across several sheets', () => {
    const plan = planBreaks([500, 500, 500, 500], SHEET);
    // Only ONE 500-tall block fits a 864 sheet: it leaves 364 of room and the
    // next block needs 500, so every following block moves down in turn.
    expect(plan.map(b => b.index)).toEqual([1, 2, 3]);
    expect(plan.every(b => b.gap === SHEET - 500)).toBe(true);
  });

  it('a run of blocks that exactly fills sheets needs no gaps at all', () => {
    const third = SHEET / 3;
    expect(planBreaks([third, third, third, third, third, third], SHEET)).toEqual([]);
  });

  it('is stable - re-planning the same natural heights gives the same answer', () => {
    const heights = [300, 400, 250, 700, 120];
    expect(planBreaks(heights, SHEET)).toEqual(planBreaks(heights, SHEET));
  });

  it('survives junk input instead of throwing into the editor', () => {
    expect(() => planBreaks([], SHEET)).not.toThrow();
    expect(planBreaks([undefined, null, NaN], SHEET)).toEqual([]);
    expect(() => planBreaks([100], 0)).not.toThrow();
  });

  it('a taller sheet needs fewer breaks for the same content', () => {
    const heights = [400, 400, 400, 400, 400];
    expect(planBreaks(heights, 1200).length).toBeLessThanOrEqual(planBreaks(heights, SHEET).length);
  });
});

// ── A letterhead makes the FIRST sheet shorter ─────────────────────────────
// Sagar, Sep 18: "there are 5 pages on editor but 6 pages in preview."
//
// Once the letterhead moved into page 1's header, the exporter gave page 1 a
// shorter text frame - but the editor still handed sheet 1 the full height, so
// it fitted more onto page 1 than the PDF did and came out a page short. The
// first sheet's capacity is now its own number.
describe('planBreaks with a shorter first sheet', () => {
  const FIRST = SHEET - 200;   // 200px of letterhead on page 1

  it('breaks earlier on page 1 than it would without a letterhead', () => {
    const heights = [400, 400];
    expect(planBreaks(heights, SHEET)).toEqual([]);                 // 800 fits 864
    expect(planBreaks(heights, SHEET, FIRST)).toEqual([{ index: 1, gap: FIRST - 400 }]);
  });

  it('later sheets get the full height back', () => {
    // 600 fills page 1 (cap 664), then 400 + 400 share page 2 (cap 864).
    const plan = planBreaks([600, 400, 400], SHEET, FIRST);
    expect(plan.map(b => b.index)).toEqual([1]);
    expect(plan[0].gap).toBe(FIRST - 600);
  });

  it('no letterhead means the first sheet is a normal sheet', () => {
    const heights = [300, 300, 300, 300];
    expect(planBreaks(heights, SHEET, SHEET)).toEqual(planBreaks(heights, SHEET));
    expect(planBreaks(heights, SHEET, undefined)).toEqual(planBreaks(heights, SHEET));
  });

  it('a letterhead taller than the sheet cannot make the capacity zero', () => {
    expect(() => planBreaks([100, 100], SHEET, -50)).not.toThrow();
    expect(() => planBreaks([100, 100], SHEET, 0)).not.toThrow();
  });

  it('an over-tall block still spills rather than looping forever', () => {
    const plan = planBreaks([SHEET * 3 + 50, 100], SHEET, FIRST);
    expect(Array.isArray(plan)).toBe(true);
  });
});
