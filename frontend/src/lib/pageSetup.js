// Document Builder - Page Setup (Phase 14). Mirrors
// backend/services/doc_export.py's PAGE_SIZES_IN/MARGINS_IN (not imported -
// different languages) so the on-screen canvas and the exported PDF/DOCX
// agree on what "Letter, Portrait, Normal" actually means. Stored as
// content.pageSetup, a sibling of body/header/footer in the same JSON blob -
// no backend schema change needed, `_export_prep` just reads the key.

export const PAGE_SIZES = [
  { value: 'letter', label: 'Letter (8.5 × 11 in)', wIn: 8.5, hIn: 11.0 },
  { value: 'legal', label: 'Legal (8.5 × 14 in)', wIn: 8.5, hIn: 14.0 },
  { value: 'tabloid', label: 'Tabloid (11 × 17 in)', wIn: 11.0, hIn: 17.0 },
  { value: 'a4', label: 'A4 (International)', wIn: 8.27, hIn: 11.69 },
];
export const PAGE_SIZE_DIMS = Object.fromEntries(PAGE_SIZES.map((s) => [s.value, { wIn: s.wIn, hIn: s.hIn }]));

export const ORIENTATIONS = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
];

export const MARGIN_PRESETS = [
  { value: 'normal', label: 'Normal (1 in)', in: 1.0 },
  { value: 'narrow', label: 'Narrow (0.5 in)', in: 0.5 },
  { value: 'wide', label: 'Wide (1.5 in)', in: 1.5 },
];
export const MARGIN_IN = Object.fromEntries(MARGIN_PRESETS.map((m) => [m.value, m.in]));

export const DEFAULT_PAGE_SETUP = { size: 'letter', orientation: 'portrait', margins: 'normal' };

// The canvas is a REAL page, at one scale: 96px to the inch, everywhere.
//
// Sagar, Sep 18: "both (editor and preview) should be using the same sizes."
//
// It used to be drawn at three different scales - 100px/in wide (a chosen
// 850px default, never 8.5in x 96dpi), 56px/in of vertical padding and 64px/in
// horizontal - picked for editing comfort. The text inside never played along:
// CSS `pt` is absolute, so type always flows at 96px to the inch whatever the
// box does. The result was an editor whose text column ran 722px where the
// page gives 624px (15.7% wide) and whose sheet held 988px of text where a
// page holds 864px (14% tall). The same words therefore filled about one page
// fewer on screen than in the PDF - the "5 pages here, 6 in the preview" bug -
// and no amount of correcting the page COUNT could fix the fact that the line
// breaks themselves were in the wrong places.
//
// At 96px/in the canvas and the exported page are the same page: Letter
// portrait is 816 x 1056 with 96px margins, a 624 x 864 text area, which is
// exactly 8.5 x 11in with 1in margins. Lines wrap where they will wrap in the
// PDF. The page is ~4% narrower on screen than it used to be; that is the cost
// of it being true.
const CSS_PX_PER_IN = 96;
const WIDTH_PX_PER_IN = CSS_PX_PER_IN;
const PADDING_PX_PER_IN = { v: CSS_PX_PER_IN, h: CSS_PX_PER_IN };

// The phone canvas stays deliberately untrue: at 96px/in a 1in margin would
// eat half a 375px screen. Readability wins there, and the page rail (the one
// thing that depends on exact pagination) is hidden on phones anyway.
const COMPACT_PADDING_PX_PER_IN = { v: 28, h: 20 };

export function pageCanvasStyle(pageSetup, { compact = false } = {}) {
  const ps = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const dims = PAGE_SIZE_DIMS[ps.size] || PAGE_SIZE_DIMS.letter;
  let { wIn, hIn } = dims;
  if (ps.orientation === 'landscape') { [wIn, hIn] = [hIn, wIn]; }
  const marginIn = MARGIN_IN[ps.margins] ?? MARGIN_IN.normal;
  const widthPx = Math.round(wIn * WIDTH_PX_PER_IN);
  if (compact) {
    const pad = COMPACT_PADDING_PX_PER_IN;
    return {
      maxWidth: widthPx,
      // aspectRatio, NOT minHeight. minHeight is derived from the 850px
      // baseline, so on a phone - where the page actually renders at whatever
      // the container allows, ~340px - a Letter page kept an 1100px floor and
      // read as a tall, almost entirely empty sheet. aspect-ratio is relative
      // to the REAL width at every size, and because min-height stays auto it
      // still grows past the ratio once the content is longer than a page.
      aspectRatio: `${wIn} / ${hIn}`,
      padding: `${Math.round(marginIn * pad.v)}px ${Math.round(marginIn * pad.h)}px`,
    };
  }
  return {
    maxWidth: widthPx,
    // minHeight (not height) - the canvas is a continuous, unpaginated
    // single box that grows with content (no live pagination exists), but
    // without this it always looked exactly as tall as its content and never
    // read as "a Letter/Portrait page" at all for short documents. box-sizing
    // is border-box app-wide, so widthPx already includes padding - the
    // aspect ratio math is just widthPx * (hIn/wIn), no separate border-box
    // correction needed.
    minHeight: Math.round(widthPx * (hIn / wIn)),
    padding: `${Math.round(marginIn * PADDING_PX_PER_IN.v)}px ${Math.round(marginIn * PADDING_PX_PER_IN.h)}px`,
  };
}

// How many sheets a run of content fills.
//
// Used by the Document Builder's page rail, which draws one thumbnail per
// sheetful (Sagar, Sep 17: "it's a 6 page document but the left panel shows
// only one page").
//
// The subtlety that made the first attempt read 5 pages where the PDF had 6:
// the canvas is NOT drawn at a single scale. Its width is 100px/in (850/8.5),
// its vertical padding 56px/in and its horizontal padding 64px/in - those are
// editing-comfort numbers, chosen to preserve the original look, not a
// faithful page. The TEXT, though, is sized in pt, and CSS pt is absolute:
// 1pt = 1/72in = 1.333px at 96dpi. So text always flows at 96px to the inch
// whatever the box around it is doing.
//
// Counting against the box (minHeight - 2 x padding = 988px for Letter/Normal)
// therefore allowed ~14% more text per sheet than a real page holds, and lost
// a page on anything long. Count against the real geometry instead: the usable
// inches of paper, at the 96dpi the text is actually laid out in.

/** Usable WIDTH of one sheet - the text column - in the same CSS pixels.
 *
 * The canvas draws this column 722px wide for Letter/Normal (850 minus 64 of
 * padding a side) where the real page gives 6.5in = 624px. 15.7% wider, so the
 * same words wrap into ~13% fewer lines, the content measures short, and the
 * page count comes up one light on a six-page document. Anything counting
 * pages has to lay the text out at THIS width, not the canvas's. */
export function textColumnPx(pageSetup) {
  const ps = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const dims = PAGE_SIZE_DIMS[ps.size] || PAGE_SIZE_DIMS.letter;
  let { wIn, hIn } = dims;
  if (ps.orientation === 'landscape') { [wIn, hIn] = [hIn, wIn]; }
  const marginIn = MARGIN_IN[ps.margins] ?? MARGIN_IN.normal;
  return Math.max(1, Math.round((wIn - marginIn * 2) * CSS_PX_PER_IN));
}

/** Usable height of one sheet, in the CSS pixels the text flows in. */
export function textFlowPx(pageSetup) {
  const ps = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const dims = PAGE_SIZE_DIMS[ps.size] || PAGE_SIZE_DIMS.letter;
  let { wIn, hIn } = dims;
  if (ps.orientation === 'landscape') { [wIn, hIn] = [hIn, wIn]; }
  const marginIn = MARGIN_IN[ps.margins] ?? MARGIN_IN.normal;
  return Math.max(1, Math.round((hIn - marginIn * 2) * CSS_PX_PER_IN));
}

/** The canvas box's own padding, for drawing a thumbnail that matches it. */
export function sheetPadding(canvasStyle) {
  const parts = String(canvasStyle?.padding || '0px').trim().split(/\s+/);
  const padV = parseFloat(parts[0]) || 0;
  return { padV, padH: parseFloat(parts[1] ?? parts[0]) || 0 };
}

export function sheetsFor(contentHeightPx, pageSetup, firstSheetPx) {
  const h = Number(contentHeightPx) || 0;
  const sheet = textFlowPx(pageSetup);
  // The first sheet is shorter when a letterhead occupies page 1's header -
  // the exporter reserves that band, so the rail has to count it the same way.
  const first = Math.max(1, Number(firstSheetPx) || sheet);
  if (h <= first) return 1;
  return 1 + Math.ceil((h - first) / sheet);
}

// The element that actually scrolls `el`.
//
// Do NOT assume .viewport: it carries overflow-y:auto but no height, so it
// only becomes a scroll container in the one module that also sets a height
// (.viewport-flush). Everywhere else it grows with its content and the
// DOCUMENT scrolls - its scrollTop stays 0 and scrollTo() on it silently does
// nothing, which is exactly how the page rail's navigation failed. Walk up and
// find the first ancestor that can and does scroll; fall back to the document.
export function scrollableAncestor(el) {
  let n = el?.parentElement;
  while (n) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight > n.clientHeight + 1) return n;
    n = n.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * Lay `html` out at `widthPx` off-screen and return its height, synchronously.
 *
 * Returns a NUMBER on purpose. The page rail first did this inline inside a
 * setPageSpans(prev => ...) updater, which React runs during a later render -
 * long after the enclosing finally had detached the probe. A detached element
 * reports scrollHeight 0, so every page measured as one sheet and the rail
 * silently collapsed to a single thumbnail. Handing back a plain number leaves
 * no way to defer the read past the element's lifetime.
 *
 * The probe carries `className` (.doc-page) so it inherits the editor's
 * typography, with the box overridden to the real text column - see
 * textColumnPx for why the canvas's own width is the wrong one to measure at.
 */
export function measureHtmlHeight(html, widthPx, { className = 'doc-page' } = {}) {
  if (typeof document === 'undefined') return 0;
  const probe = document.createElement('div');
  probe.className = className;
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = [
    'position:absolute', 'left:-99999px', 'top:0', 'visibility:hidden',
    'pointer-events:none', `width:${Math.max(1, widthPx)}px`, 'max-width:none',
    'min-height:0', 'padding:0', 'margin:0', 'box-shadow:none', 'border:0',
  ].join(';');
  document.body.appendChild(probe);
  try {
    probe.innerHTML = html || '';
    return probe.scrollHeight || 0;
  } catch {
    return 0;
  } finally {
    probe.remove();
  }
}
