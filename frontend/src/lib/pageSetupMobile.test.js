// The phone rendering of the editor canvas (Sagar, Sep 17: "work on the mobile
// view optimizations for the Document module").
//
// The thing under test is a sizing decision, not a look: on a 375px screen the
// desktop padding spent a third of the display on white space, and the page's
// minHeight - derived from the fixed 850px baseline - kept a Letter page 1100px
// tall however narrow it actually rendered.
import { describe, it, expect, afterEach } from 'vitest';
import { pageCanvasStyle, PAGE_SIZE_DIMS, textFlowPx, textColumnPx, sheetPadding, sheetsFor, scrollableAncestor, measureHtmlHeight } from './pageSetup';

const PHONE_W = 375;   // iPhone SE / the narrow end we care about
const letter = { size: 'letter', orientation: 'portrait', margins: 'normal' };

describe('pageCanvasStyle - the desktop canvas is a real page', () => {
  // Sagar, Sep 18: "both (editor and preview) should be using the same sizes."
  // 96px to the inch, the scale CSS pt actually resolves against, so the page
  // on screen and the page in the PDF are the same page.
  it('is Letter at 96dpi: 816 x 1056 with 1in margins', () => {
    const s = pageCanvasStyle(letter);
    expect(s.maxWidth).toBe(8.5 * 96);
    expect(s.minHeight).toBe(11 * 96);
    expect(s.padding).toBe('96px 96px');
    expect(s.aspectRatio).toBeUndefined();
  });

  it('its text area IS the page text area - no correction needed anywhere', () => {
    const s = pageCanvasStyle(letter);
    const { padV, padH } = sheetPadding(s);
    expect(s.maxWidth - padH * 2).toBe(textColumnPx(letter));
    expect(s.minHeight - padV * 2).toBe(textFlowPx(letter));
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
    // A true 1in margin would take 192px of a 375px screen. Anything under
    // ~300px of column is the cramped reading this exists to avoid.
    expect(column).toBeGreaterThan(300);
  });

  it('drops minHeight for a real aspect ratio, so it tracks the actual width', () => {
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

  it('even Wide margins stay far tighter than a true 1in margin', () => {
    const wide = Number(pageCanvasStyle({ ...letter, margins: 'wide' }, { compact: true })
      .padding.split(' ')[1].replace('px', ''));
    expect(wide).toBeLessThan(96);
  });

  it('page size still changes the canvas width', () => {
    const a4 = pageCanvasStyle({ ...letter, size: 'a4' }, { compact: true });
    expect(a4.maxWidth).toBeLessThan(pageCanvasStyle(letter, { compact: true }).maxWidth);
  });
});

// ── Page rail: how many sheets the content fills ────────────────────────────
// Sagar, Sep 17, twice: "it's a 6 page document but the left panel shows only
// one page", then "in the preview it's 6 pages but in the editor it's 5".
//
// The second one is the interesting bug. The canvas is drawn at THREE scales -
// 100px/in wide, 56px/in of vertical padding, 64px/in horizontal - none of
// which is the 96px/in that CSS `pt` text actually flows at. Counting against
// the box gave each sheet ~14% more room than a real page and swallowed a page.
describe('textFlowPx - the usable height of a real sheet', () => {
  it('is the paper minus its margins, at the 96dpi text flows in', () => {
    // Letter portrait, 1in margins: (11 - 2) x 96
    expect(textFlowPx(letter)).toBe(864);
  });

  it('now equals the canvas box exactly - the mismatch is gone by construction', () => {
    const canvas = pageCanvasStyle(letter);
    const { padV } = sheetPadding(canvas);
    // It used to be 988 against 864 - ~14% roomier, enough to lose a page in six.
    expect(canvas.minHeight - padV * 2).toBe(textFlowPx(letter));
  });

  it('narrow margins leave more text height than wide', () => {
    expect(textFlowPx({ ...letter, margins: 'narrow' }))
      .toBeGreaterThan(textFlowPx({ ...letter, margins: 'wide' }));
  });

  it('landscape is shorter than portrait', () => {
    expect(textFlowPx({ ...letter, orientation: 'landscape' })).toBeLessThan(textFlowPx(letter));
  });

  it('Legal is taller than Letter', () => {
    expect(textFlowPx({ ...letter, size: 'legal' })).toBeGreaterThan(textFlowPx(letter));
  });
});

describe('sheetsFor', () => {
  it('an empty document is still one page, never zero', () => {
    expect(sheetsFor(0, letter)).toBe(1);
    expect(sheetsFor(undefined, letter)).toBe(1);
  });

  it('content shorter than a sheet stays one page', () => {
    expect(sheetsFor(400, letter)).toBe(1);
  });

  it('one pixel past a sheet starts the next page', () => {
    expect(sheetsFor(864, letter)).toBe(1);
    expect(sheetsFor(865, letter)).toBe(2);
  });

  it('six sheets of content report six, not five - the reported case', () => {
    expect(sheetsFor(864 * 5 + 10, letter)).toBe(6);
    // The old canvas gave each sheet 988px instead of 864 and said five.
    expect(Math.ceil((864 * 5 + 10) / 988)).toBe(5);
  });

  it('wider margins mean more sheets for the same content', () => {
    const h = 6000;
    expect(sheetsFor(h, { ...letter, margins: 'wide' }))
      .toBeGreaterThanOrEqual(sheetsFor(h, { ...letter, margins: 'narrow' }));
  });

  it('a taller page needs fewer sheets', () => {
    expect(sheetsFor(6000, { ...letter, size: 'legal' })).toBeLessThanOrEqual(sheetsFor(6000, letter));
  });
});

describe('sheetPadding - drawing the thumbnail to match the canvas', () => {
  it('reads both axes out of the padding string', () => {
    expect(sheetPadding(pageCanvasStyle(letter))).toEqual({ padV: 96, padH: 96 });
  });

  it('survives a compact canvas and a missing padding', () => {
    expect(() => sheetPadding(pageCanvasStyle(letter, { compact: true }))).not.toThrow();
    expect(sheetPadding({})).toEqual({ padV: 0, padH: 0 });
  });
});

// ── Finding the thing that actually scrolls ─────────────────────────────────
// The page rail's navigation silently did nothing for pages 2+. The cause was
// not the offset arithmetic but the TARGET: .viewport carries overflow-y:auto
// yet has no height outside .viewport-flush, so it never becomes a scroll
// container - the document scrolls instead, and scrollTo() on .viewport is a
// no-op. Page 1 used scrollIntoView and appeared to work, which hid it.
describe('scrollableAncestor', () => {
  const build = ({ overflowY, scrollH, clientH }) => {
    const parent = document.createElement('div');
    parent.className = 'viewport';
    parent.style.overflowY = overflowY;
    Object.defineProperty(parent, 'scrollHeight', { value: scrollH, configurable: true });
    Object.defineProperty(parent, 'clientHeight', { value: clientH, configurable: true });
    const child = document.createElement('div');
    parent.appendChild(child);
    document.body.appendChild(parent);
    return { parent, child };
  };

  afterEach(() => { document.body.innerHTML = ''; });

  it('falls back to the document when the ancestor cannot scroll', () => {
    // overflow-y:auto but content fits - exactly .viewport on most screens.
    const { child } = build({ overflowY: 'auto', scrollH: 500, clientH: 500 });
    expect(scrollableAncestor(child)).toBe(document.scrollingElement || document.documentElement);
  });

  it('uses the ancestor when it really does scroll', () => {
    const { parent, child } = build({ overflowY: 'auto', scrollH: 5000, clientH: 500 });
    expect(scrollableAncestor(child)).toBe(parent);
  });

  it('ignores an overflowing ancestor that is set to visible', () => {
    const { child } = build({ overflowY: 'visible', scrollH: 5000, clientH: 500 });
    expect(scrollableAncestor(child)).toBe(document.scrollingElement || document.documentElement);
  });

  it('never throws on a detached or missing node', () => {
    expect(() => scrollableAncestor(null)).not.toThrow();
    expect(() => scrollableAncestor(document.createElement('div'))).not.toThrow();
  });
});

// ── The text column, and why the editor under-counted pages ─────────────────
// Sagar, Sep 18: "why are there 5 pages but in the preview it's 6?"
//
// Two separate scale errors, both from the canvas not being drawn to scale.
// The vertical one (counting against the 988px box instead of 864px of real
// text height) is covered above. This is the horizontal one: the canvas wraps
// text in a 722px column where the page gives 624px, so the same words take
// ~13% fewer lines and the content measures short by about a page in six.
describe('textColumnPx', () => {
  it('is the paper minus its margins, at 96dpi', () => {
    expect(textColumnPx(letter)).toBe(624);          // (8.5 - 2) x 96
  });

  it('is what the canvas now draws - it used to be 722 against 624', () => {
    const canvas = pageCanvasStyle(letter);
    const { padH } = sheetPadding(canvas);
    expect(canvas.maxWidth - padH * 2).toBe(textColumnPx(letter));
    // The old canvas wrapped at 722px, 15.7% wide, so lines broke in the wrong
    // places and the content measured about a page short in six.
    expect(722 / textColumnPx(letter)).toBeGreaterThan(1.15);
  });

  it('narrow margins widen the column, wide margins narrow it', () => {
    expect(textColumnPx({ ...letter, margins: 'narrow' }))
      .toBeGreaterThan(textColumnPx({ ...letter, margins: 'wide' }));
  });

  it('landscape is wider than portrait', () => {
    expect(textColumnPx({ ...letter, orientation: 'landscape' })).toBeGreaterThan(textColumnPx(letter));
  });

  it('column and flow height together describe a real page, not the canvas', () => {
    // 6.5in x 9in of usable Letter paper.
    expect(textColumnPx(letter) / 96).toBeCloseTo(6.5, 5);
    expect(textFlowPx(letter) / 96).toBeCloseTo(9, 5);
  });
});

// ── measureHtmlHeight ───────────────────────────────────────────────────────
// The regression this exists for: the rail collapsed to a single thumbnail
// because the measurement ran inside a setState updater, which React calls
// during a LATER render - after the probe had been detached. scrollHeight on a
// detached element is 0, so every page came back as one sheet.
describe('measureHtmlHeight', () => {
  const withScrollHeightSpy = (fn) => {
    const seen = [];
    // scrollHeight is defined on Element.prototype, not on the div's immediate
    // prototype - looking it up on the wrong one left the stub installed for
    // the rest of the file.
    const proto = Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get() { seen.push(this.isConnected); return 1234; },
    });
    try { return { result: fn(), seen }; } finally {
      if (original) Object.defineProperty(proto, 'scrollHeight', original);
      else delete proto.scrollHeight;
    }
  };

  it('reads the height while the probe is still IN the document', () => {
    const { result, seen } = withScrollHeightSpy(() => measureHtmlHeight('<p>hi</p>', 624));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);   // never read after detaching
    expect(result).toBe(1234);
  });

  it('returns a number, so the read cannot be deferred by a caller', () => {
    expect(typeof measureHtmlHeight('<p>hi</p>', 624)).toBe('number');
  });

  it('leaves nothing behind in the document', () => {
    const before = document.body.childElementCount;
    measureHtmlHeight('<p>hi</p>', 624);
    expect(document.body.childElementCount).toBe(before);
  });

  it('tolerates empty and malformed input', () => {
    expect(measureHtmlHeight('', 624)).toBe(0);
    expect(() => measureHtmlHeight(null, 0)).not.toThrow();
  });
});

describe('sheetsFor with a letterhead on page 1', () => {
  const SHEET = 864;
  it('counts the shorter first sheet, so the rail agrees with the PDF', () => {
    const first = SHEET - 200;
    // Content that fits two full sheets needs three once page 1 is shorter.
    expect(sheetsFor(SHEET * 2, letter)).toBe(2);
    expect(sheetsFor(SHEET * 2, letter, first)).toBe(3);
  });

  it('is unchanged when there is no letterhead', () => {
    expect(sheetsFor(3000, letter, undefined)).toBe(sheetsFor(3000, letter));
    expect(sheetsFor(3000, letter, SHEET)).toBe(sheetsFor(3000, letter));
  });

  it('content inside the shortened first sheet is still one page', () => {
    expect(sheetsFor(500, letter, SHEET - 200)).toBe(1);
  });

  it('never returns zero or loops on a nonsense first sheet', () => {
    expect(sheetsFor(1000, letter, 0)).toBeGreaterThanOrEqual(1);
    expect(sheetsFor(1000, letter, -10)).toBeGreaterThanOrEqual(1);
  });
});
