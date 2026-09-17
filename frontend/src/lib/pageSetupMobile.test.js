// The phone rendering of the editor canvas (Sagar, Sep 17: "work on the mobile
// view optimizations for the Document module").
//
// The thing under test is a sizing decision, not a look: on a 375px screen the
// desktop padding spent a third of the display on white space, and the page's
// minHeight - derived from the fixed 850px baseline - kept a Letter page 1100px
// tall however narrow it actually rendered.
import { describe, it, expect } from 'vitest';
import { pageCanvasStyle, PAGE_SIZE_DIMS } from './pageSetup';

const PHONE_W = 375;   // iPhone SE / the narrow end we care about
const letter = { size: 'letter', orientation: 'portrait', margins: 'normal' };

describe('pageCanvasStyle - desktop is untouched', () => {
  it('still returns exactly the calibrated Letter/Normal numbers', () => {
    const s = pageCanvasStyle(letter);
    expect(s.maxWidth).toBe(850);
    expect(s.padding).toBe('56px 64px');
    expect(s.minHeight).toBe(1100);
    expect(s.aspectRatio).toBeUndefined();
  });

  it('an explicit compact:false is the same as omitting it', () => {
    expect(pageCanvasStyle(letter, { compact: false })).toEqual(pageCanvasStyle(letter));
  });
});

describe('pageCanvasStyle - compact (phone)', () => {
  it('leaves a usable text column on a 375px screen', () => {
    const s = pageCanvasStyle(letter, { compact: true });
    const hPad = Number(s.padding.split(' ')[1].replace('px', ''));
    const column = PHONE_W - hPad * 2;
    // The desktop padding (64px a side) left ~247px here. Anything under ~300
    // is the cramped column this change exists to fix.
    expect(column).toBeGreaterThan(300);
  });

  it('drops the 850px-derived minHeight for a real aspect ratio', () => {
    const s = pageCanvasStyle(letter, { compact: true });
    expect(s.minHeight).toBeUndefined();
    expect(s.aspectRatio).toBe(`${PAGE_SIZE_DIMS.letter.wIn} / ${PAGE_SIZE_DIMS.letter.hIn}`);
  });

  it('keeps the page a page - the ratio still matches the paper', () => {
    const s = pageCanvasStyle(letter, { compact: true });
    const [w, h] = s.aspectRatio.split('/').map(n => Number(n.trim()));
    expect(w / h).toBeCloseTo(PAGE_SIZE_DIMS.letter.wIn / PAGE_SIZE_DIMS.letter.hIn, 5);
  });

  it('landscape swaps the ratio, same as the desktop path', () => {
    const s = pageCanvasStyle({ ...letter, orientation: 'landscape' }, { compact: true });
    const [w, h] = s.aspectRatio.split('/').map(n => Number(n.trim()));
    expect(w).toBeGreaterThan(h);
  });

  it('the margin preset still means something - Narrow is tighter than Wide', () => {
    const pad = (m) => Number(pageCanvasStyle({ ...letter, margins: m }, { compact: true })
      .padding.split(' ')[1].replace('px', ''));
    expect(pad('narrow')).toBeLessThan(pad('normal'));
    expect(pad('normal')).toBeLessThan(pad('wide'));
  });

  it('even Wide margins leave more room than the desktop padding did', () => {
    const wide = Number(pageCanvasStyle({ ...letter, margins: 'wide' }, { compact: true })
      .padding.split(' ')[1].replace('px', ''));
    expect(wide).toBeLessThan(64);
  });

  it('page size still changes the canvas width', () => {
    const a4 = pageCanvasStyle({ ...letter, size: 'a4' }, { compact: true });
    expect(a4.maxWidth).toBeLessThan(pageCanvasStyle(letter, { compact: true }).maxWidth);
  });
});
