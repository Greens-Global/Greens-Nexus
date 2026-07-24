// Document Builder — Page Setup (Phase 14). Mirrors
// backend/services/doc_export.py's PAGE_SIZES_IN/MARGINS_IN (not imported —
// different languages) so the on-screen canvas and the exported PDF/DOCX
// agree on what "Letter, Portrait, Normal" actually means. Stored as
// content.pageSetup, a sibling of body/header/footer in the same JSON blob —
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

// The live editor's ".doc-page" canvas is an editing-comfort width, not a
// literal-scale page (850px was always a chosen default, not 8.5in*96dpi) —
// scale everything relative to that Letter/Normal baseline so switching page
// size/margins visibly changes the canvas without disturbing the existing
// look for the common case (Letter, Portrait, Normal).
const WIDTH_PX_PER_IN = 850 / PAGE_SIZE_DIMS.letter.wIn; // calibrated so Letter/Portrait keeps today's 850px width exactly
const PADDING_PX_PER_IN = { v: 56, h: 64 }; // calibrated so Normal (1in) keeps today's 56px/64px padding exactly

export function pageCanvasStyle(pageSetup) {
  const ps = { ...DEFAULT_PAGE_SETUP, ...(pageSetup || {}) };
  const dims = PAGE_SIZE_DIMS[ps.size] || PAGE_SIZE_DIMS.letter;
  let { wIn, hIn } = dims;
  if (ps.orientation === 'landscape') { [wIn, hIn] = [hIn, wIn]; }
  const marginIn = MARGIN_IN[ps.margins] ?? MARGIN_IN.normal;
  const widthPx = Math.round(wIn * WIDTH_PX_PER_IN);
  return {
    maxWidth: widthPx,
    // minHeight (not height) — the canvas is a continuous, unpaginated
    // single box that grows with content (no live pagination exists), but
    // without this it always looked exactly as tall as its content and never
    // read as "a Letter/Portrait page" at all for short documents. box-sizing
    // is border-box app-wide, so widthPx already includes padding — the
    // aspect ratio math is just widthPx * (hIn/wIn), no separate border-box
    // correction needed.
    minHeight: Math.round(widthPx * (hIn / wIn)),
    padding: `${Math.round(marginIn * PADDING_PX_PER_IN.v)}px ${Math.round(marginIn * PADDING_PX_PER_IN.h)}px`,
  };
}
