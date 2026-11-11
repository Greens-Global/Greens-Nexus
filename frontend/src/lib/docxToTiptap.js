// Direct OOXML -> TipTap JSON converter (Phase 16 - "robust import").
//
// Why this exists instead of just using mammoth: mammoth's convertToHtml()
// deliberately discards DIRECT (manually-applied, not named-style) run
// formatting - font family, font size, text color, highlight, and paragraph
// alignment all vanish by design (mammoth's own docs: it only preserves
// content it can map to *semantic* HTML via named Word styles). Most
// everyday Word documents use direct formatting, not named character
// styles, so that's the actual cause of "the font/size changed on import".
//
// This module reads the raw docx (a zip of OOXML parts) directly with
// JSZip + DOMParser and builds TipTap JSON nodes itself, so what Word shows
// comes straight from the source XML: fonts (theme fonts included), sizes,
// colors, highlight, caps, sub/superscript, paragraph alignment, spacing,
// line spacing and indents (through the full style cascade: docDefaults ->
// default style -> basedOn chain -> paragraph -> character style -> run),
// heading levels, bullet/numbered lists with their numbering format, tables
// with merged cells, column widths and borderless tables, hyperlinks (both
// forms Word writes), pictures, text boxes, page breaks, headers and
// footers, and the page size/orientation/margins.
//
// Explicit, permanent limits (this editor's schema has no equivalent, so no
// importer could preserve them without a different editor): footnotes and
// endnotes, per-section headers/footers beyond the first section, tracked
// changes and comments (insertions are kept, deletions are dropped - i.e.
// imported "as if accepted"), floating shapes/WordArt/embedded objects, drop
// caps and kerning. Tabs and tab stops come through since 11/11/2026.

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
};

// ── OOXML measurements ─────────────────────────────────────────────────────
// Almost every length in OOXML is a UNION type: either a bare integer in some
// type-specific unit (half-points for w:sz, twentieths of a point for page
// geometry), OR an ST_UniversalMeasure - a decimal with a unit suffix, e.g.
// "4.3mm", "1in", "12pt". Both forms are valid and Word writes both.
//
// Reading only the bare form is what made a Teams transcript import at 2pt:
// its exporter writes <w:sz w:val="4.3mm"/>, and parseInt("4.3mm") is 4, which
// then got halved to 2pt. The same file writes <w:pgMar w:top="1in"/>, which
// parsed as 1 twip and made a 1-inch document look like narrow margins.
const PT_PER_UNIT = { mm: 72 / 25.4, cm: 72 / 2.54, in: 72, pt: 1, pc: 12, pi: 12 };
const UNIVERSAL_MEASURE = /^\s*(-?\d*\.?\d+)\s*(mm|cm|in|pt|pc|pi)\s*$/i;

// Points if the value carries a unit, else null ("it is the bare form").
function universalMeasurePt(raw) {
  const m = UNIVERSAL_MEASURE.exec(String(raw ?? ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n * PT_PER_UNIT[m[2].toLowerCase()] : null;
}

// w:sz and friends: half-points when bare, a real measure when suffixed.
function fontSizePt(raw) {
  const united = universalMeasurePt(raw);
  if (united != null) return united > 0 ? united : null;
  const half = parseFloat(raw);
  return Number.isFinite(half) && half > 0 ? half / 2 : null;
}

// Page geometry: twentieths of a point when bare, a real measure when suffixed.
function measureInches(raw) {
  const united = universalMeasurePt(raw);
  if (united != null) return united / 72;
  const twips = parseFloat(raw);
  return Number.isFinite(twips) ? twips / 1440 : 0;
}

// Paragraph spacing and indents: twips when bare, a real measure when suffixed.
function twipsPt(raw) {
  if (raw == null || raw === '') return null;
  const united = universalMeasurePt(raw);
  if (united != null) return united;
  const twips = parseFloat(raw);
  return Number.isFinite(twips) ? twips / 20 : null;
}

// Trailing zeros off, so a plain 11pt stays "11pt" and 4.3mm reads "12.2pt" -
// the same one-decimal precision Word's own size box shows.
const ptLabel = (pt) => `${+pt.toFixed(1)}pt`;
const round1 = (n) => Math.round(n * 10) / 10;

function els(parent, ns, tag) {
  return parent ? Array.from(parent.getElementsByTagNameNS(NS[ns], tag)) : [];
}
function childEls(parent, ns, tag) {
  if (!parent) return [];
  return Array.from(parent.childNodes).filter(n => n.nodeType === 1 && n.localName === tag && n.namespaceURI === NS[ns]);
}
function firstChild(parent, ns, tag) {
  return childEls(parent, ns, tag)[0] || null;
}
function attr(el, ns, name) {
  return el ? el.getAttributeNS(NS[ns], name) : null;
}
function parseXml(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}
const isW = (el, tag) => el.nodeType === 1 && el.localName === tag && el.namespaceURI === NS.w;

// ── theme1.xml: the fonts behind "Aptos (Body)" / "Aptos Display (Headings)".
// Most Word documents never name a font on a run at all - they say
// w:asciiTheme="minorHAnsi" and the theme part says what that is. Reading only
// w:ascii left those documents in the editor's own font. ───────────────────
function readTheme(themeXmlText) {
  if (!themeXmlText) return { major: null, minor: null };
  const doc = parseXml(themeXmlText);
  const latin = (tag) => {
    const font = els(doc, 'a', tag)[0];
    const l = font && els(font, 'a', 'latin')[0];
    return (l && l.getAttribute('typeface')) || null;
  };
  return { major: latin('majorFont'), minor: latin('minorFont') };
}

// ── styles.xml: resolve a paragraph style's effective run/paragraph
// defaults, walking w:basedOn chains (Word styles inherit like CSS). ───────
function readStyles(stylesXmlText, theme) {
  const out = { byId: {}, docDefaults: {}, defaultParagraphStyleId: null, theme: theme || { major: null, minor: null } };
  if (!stylesXmlText) return out;
  const doc = parseXml(stylesXmlText);
  for (const styleEl of els(doc, 'w', 'style')) {
    const id = attr(styleEl, 'w', 'styleId');
    if (!id) continue;
    const nameEl = firstChild(styleEl, 'w', 'name');
    const basedOnEl = firstChild(styleEl, 'w', 'basedOn');
    out.byId[id] = {
      name: (attr(nameEl, 'w', 'val') || '').toLowerCase(),
      basedOn: attr(basedOnEl, 'w', 'val') || null,
      pPr: firstChild(styleEl, 'w', 'pPr'),
      rPr: firstChild(styleEl, 'w', 'rPr'),
      tblPr: firstChild(styleEl, 'w', 'tblPr'),
    };
    // The style marked w:default="1" is what every paragraph without an
    // explicit w:pStyle actually inherits (usually "Normal"). Without it a
    // document whose body size lives only on Normal imported at the editor's
    // own CSS default instead of the document's.
    if (attr(styleEl, 'w', 'type') === 'paragraph' && attr(styleEl, 'w', 'default') === '1') {
      out.defaultParagraphStyleId = id;
    }
  }
  if (!out.defaultParagraphStyleId && out.byId.Normal) out.defaultParagraphStyleId = 'Normal';
  const docDefaultsEl = firstChild(doc.documentElement, 'w', 'docDefaults');
  out.docDefaults = {
    rPr: docDefaultsEl && firstChild(firstChild(docDefaultsEl, 'w', 'rPrDefault'), 'w', 'rPr'),
    pPr: docDefaultsEl && firstChild(firstChild(docDefaultsEl, 'w', 'pPrDefault'), 'w', 'pPr'),
  };
  return out;
}

// Walks a style's w:basedOn chain, folding `fold(styleEntry, acc)` from the
// root of the chain down to `styleId` itself.
function foldStyleChain(styleId, styles, base, fold, seen = new Set()) {
  if (!styleId || seen.has(styleId)) return { ...base };
  seen.add(styleId);
  const s = styles.byId[styleId];
  if (!s) return { ...base };
  const parent = s.basedOn ? foldStyleChain(s.basedOn, styles, base, fold, seen) : base;
  return fold(s, parent);
}

// Resolves a style's effective run properties on top of `base`. `base` is
// what the style inherits from the level below it in Word's cascade
// (docDefaults -> default paragraph style -> this style).
function resolvedRunProps(styleId, styles, base = {}) {
  return foldStyleChain(styleId, styles, base, (s, parent) => runPropsFrom(s.rPr, parent, styles.theme));
}
function resolvedParaProps(styleId, styles, base = {}) {
  return foldStyleChain(styleId, styles, base, (s, parent) => paraPropsFrom(s.pPr, parent));
}

// Word's real cascade, bottom two levels: w:docDefaults, then the paragraph
// style marked as the document default. Everything a paragraph or run says
// later layers on top of this.
function baseRunPropsOf(styles) {
  const fromDefaults = runPropsFrom(styles.docDefaults?.rPr, {}, styles.theme);
  return styles.defaultParagraphStyleId
    ? resolvedRunProps(styles.defaultParagraphStyleId, styles, fromDefaults)
    : fromDefaults;
}
function baseParaPropsOf(styles) {
  const fromDefaults = paraPropsFrom(styles.docDefaults?.pPr, {});
  return styles.defaultParagraphStyleId
    ? resolvedParaProps(styles.defaultParagraphStyleId, styles, fromDefaults)
    : fromDefaults;
}

// Word's built-in "List Bullet"/"List Number" styles (and many custom list
// styles) carry their <w:numPr> on the STYLE's own paragraph properties, not
// on the paragraph itself - a paragraph using style="ListBullet" has no
// numPr in its own w:pPr at all. Falls back through w:basedOn same as
// outlineLevel/resolvedRunProps, so a custom style derived from one of these
// is still recognized as a list paragraph.
function styleNumPr(styleId, styles, seen = new Set()) {
  if (!styleId || seen.has(styleId)) return null;
  seen.add(styleId);
  const s = styles.byId[styleId];
  if (!s) return null;
  const numPr = firstChild(s.pPr, 'w', 'numPr');
  if (numPr) return numPr;
  return s.basedOn ? styleNumPr(s.basedOn, styles, seen) : null;
}

function outlineLevel(styleId, styles, seen = new Set()) {
  if (!styleId || seen.has(styleId)) return null;
  seen.add(styleId);
  const s = styles.byId[styleId];
  if (!s) return null;
  const lvl = firstChild(s.pPr, 'w', 'outlineLvl');
  if (lvl) return parseInt(attr(lvl, 'w', 'val'), 10);
  const m = /^heading\s*(\d)$/i.exec(s.name || '') || /^Heading(\d)$/i.exec(styleId);
  if (m) return parseInt(m[1], 10) - 1;
  return s.basedOn ? outlineLevel(s.basedOn, styles, seen) : null;
}

// ── run properties (w:rPr) -> our mark attrs ────────────────────────────────
const HIGHLIGHT_HEX = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
  blue: '#0000ff', red: '#ff0000', darkblue: '#000080', darkcyan: '#008080',
  darkgreen: '#008000', darkmagenta: '#800080', darkred: '#800000',
  darkyellow: '#808000', darkgray: '#808080', lightgray: '#c0c0c0', black: '#000000',
};

// An OOXML on/off toggle (w:b, w:i, w:strike): present means on unless it
// carries an explicit off value. Returns undefined when the element is absent
// - "says nothing", which must leave whatever was inherited alone, as opposed
// to `false`, which is a style-defeating "explicitly off".
function toggle(rPr, name) {
  const el = firstChild(rPr, 'w', name);
  if (!el) return undefined;
  const v = attr(el, 'w', 'val');
  return !(v === '0' || v === 'false' || v === 'off');
}

function themeFont(fonts, theme) {
  const t = attr(fonts, 'w', 'asciiTheme') || attr(fonts, 'w', 'hAnsiTheme');
  if (!t || !theme) return null;
  return /^major/i.test(t) ? theme.major : theme.minor;
}

function runPropsFrom(rPr, inherited = {}, theme = null) {
  if (!rPr) return { ...inherited };
  const out = { ...inherited };
  const fonts = firstChild(rPr, 'w', 'rFonts');
  const font = fonts && (attr(fonts, 'w', 'ascii') || attr(fonts, 'w', 'hAnsi') || themeFont(fonts, theme) || attr(fonts, 'w', 'cs'));
  if (font) out.fontFamily = font;
  const sz = firstChild(rPr, 'w', 'sz');
  if (sz) { const pt = fontSizePt(attr(sz, 'w', 'val')); if (pt) out.fontSize = ptLabel(pt); }
  const b = toggle(rPr, 'b'); if (b !== undefined) out.bold = b;
  const i = toggle(rPr, 'i'); if (i !== undefined) out.italic = i;
  const u = firstChild(rPr, 'w', 'u');
  if (u) out.underline = (attr(u, 'w', 'val') || 'single') !== 'none';
  const strike = toggle(rPr, 'strike'); if (strike !== undefined) out.strike = strike;
  const dstrike = toggle(rPr, 'dstrike'); if (dstrike !== undefined) out.strike = dstrike;
  const caps = toggle(rPr, 'caps'); if (caps !== undefined) out.caps = caps;
  const smallCaps = toggle(rPr, 'smallCaps'); if (smallCaps !== undefined) out.caps = smallCaps;
  const vert = firstChild(rPr, 'w', 'vertAlign');
  if (vert) out.vertAlign = attr(vert, 'w', 'val') || 'baseline';
  const color = firstChild(rPr, 'w', 'color');
  const colorVal = color && attr(color, 'w', 'val');
  if (colorVal && colorVal !== 'auto') out.color = `#${colorVal}`;
  const hl = firstChild(rPr, 'w', 'highlight');
  const hlVal = hl && attr(hl, 'w', 'val');
  if (hl) out.highlight = HIGHLIGHT_HEX[hlVal] || null;
  const shd = firstChild(rPr, 'w', 'shd');
  const fill = shd && attr(shd, 'w', 'fill');
  if (fill && fill !== 'auto') out.shading = `#${fill}`;
  return out;
}

function marksFor(props, link, change = null) {
  const marks = [];
  if (props.bold) marks.push({ type: 'bold' });
  if (props.italic) marks.push({ type: 'italic' });
  if (props.underline) marks.push({ type: 'underline' });
  if (props.strike) marks.push({ type: 'strike' });
  if (props.vertAlign === 'superscript') marks.push({ type: 'superscript' });
  if (props.vertAlign === 'subscript') marks.push({ type: 'subscript' });
  const textStyleAttrs = {};
  if (props.fontFamily) textStyleAttrs.fontFamily = props.fontFamily;
  if (props.fontSize) textStyleAttrs.fontSize = props.fontSize;
  if (props.color) textStyleAttrs.color = props.color;
  if (props.shading) textStyleAttrs.backgroundColor = props.shading;
  if (Object.keys(textStyleAttrs).length) marks.push({ type: 'textStyle', attrs: textStyleAttrs });
  if (props.highlight) marks.push({ type: 'highlight', attrs: { color: props.highlight } });
  if (link) marks.push({ type: 'link', attrs: { href: link } });
  if (change) marks.push(change);   // a tracked insertion / deletion (Review > Track Changes)
  return marks;
}

// ── paragraph properties (w:pPr) -> paragraph attrs ─────────────────────────
// Word's single line spacing is the font's own line height, not 1.0 - a
// browser's `line-height: normal`, about 1.2 for the fonts Word ships with.
// shortcut: every "auto" multiple is scaled by that 1.2, upgrade to measuring
// the real font metrics if a document ever needs it exact.
const LINE_NORMAL = 1.2;

function paraPropsFrom(pPr, inherited = {}) {
  if (!pPr) return { ...inherited };
  const out = { ...inherited };
  const jc = firstChild(pPr, 'w', 'jc');
  if (jc) {
    const v = attr(jc, 'w', 'val');
    out.align = v === 'both' || v === 'distribute' ? 'justify' : v === 'center' ? 'center' : (v === 'right' || v === 'end') ? 'right' : null;
  }
  const spacing = firstChild(pPr, 'w', 'spacing');
  if (spacing) {
    const before = twipsPt(attr(spacing, 'w', 'before')); if (before != null) out.spacingBefore = round1(before);
    const after = twipsPt(attr(spacing, 'w', 'after')); if (after != null) out.spacingAfter = round1(after);
    const line = attr(spacing, 'w', 'line');
    if (line != null && line !== '') {
      const rule = attr(spacing, 'w', 'lineRule') || 'auto';
      const n = parseFloat(line);
      if (Number.isFinite(n) && n > 0) {
        out.lineHeight = rule === 'auto' ? String(Math.round((n / 240) * LINE_NORMAL * 100) / 100) : `${round1(n / 20)}pt`;
      }
    }
  }
  const ind = firstChild(pPr, 'w', 'ind');
  if (ind) {
    const left = twipsPt(attr(ind, 'w', 'left') ?? attr(ind, 'w', 'start'));
    if (left != null) out.indentLeft = round1(left);
    const right = twipsPt(attr(ind, 'w', 'right') ?? attr(ind, 'w', 'end'));
    if (right != null) out.indentRight = round1(right);
    const hanging = twipsPt(attr(ind, 'w', 'hanging'));
    const firstLine = twipsPt(attr(ind, 'w', 'firstLine'));
    if (hanging != null && hanging > 0) out.indentFirst = -round1(hanging);
    else if (firstLine != null) out.indentFirst = round1(firstLine);
  }
  const shd = firstChild(pPr, 'w', 'shd');
  const fill = shd && attr(shd, 'w', 'fill');
  if (fill && fill !== 'auto') out.backgroundColor = `#${fill}`;
  const pbb = toggle(pPr, 'pageBreakBefore'); if (pbb !== undefined) out.pageBreakBefore = pbb;
  // Tab stops (w:tabs, positions from the page margin in twips). A style's
  // stops are inherited; a paragraph's "clear" takes one of them away.
  const tabsEl = firstChild(pPr, 'w', 'tabs');
  if (tabsEl) {
    let stops = Array.isArray(inherited.tabStops) ? [...inherited.tabStops] : [];
    for (const t of els(tabsEl, 'w', 'tab')) {
      const pos = twipsPt(attr(t, 'w', 'pos'));
      if (pos == null) continue;
      const val = attr(t, 'w', 'val') || 'left';
      stops = stops.filter((st) => Math.abs(st.pos - pos) >= 0.5);
      if (val === 'clear' || val === 'bar' || val === 'num' || pos <= 0) continue;
      const align = val === 'right' || val === 'end' ? 'right' : val === 'center' ? 'center' : val === 'decimal' ? 'decimal' : 'left';
      stops.push({ pos: round1(pos), align });
    }
    out.tabStops = stops.sort((a, b) => a.pos - b.pos);
  }
  return out;
}

function paragraphAttrsFrom(props, { isListItem } = {}) {
  const attrs = { textAlign: props.align || null };
  if (props.spacingBefore) attrs.spacingBefore = props.spacingBefore;
  if (props.spacingAfter != null) attrs.spacingAfter = props.spacingAfter;
  if (props.lineHeight) attrs.lineHeight = props.lineHeight;
  if (props.backgroundColor) attrs.backgroundColor = props.backgroundColor;
  if (Array.isArray(props.tabStops) && props.tabStops.length) attrs.tabStops = props.tabStops;
  // A list paragraph's indent is the list's own (Word's "List Paragraph" says
  // left 720, hanging 360 for the bullet); the editor's list already indents.
  if (!isListItem) {
    if (props.indentLeft) attrs.indentLeft = props.indentLeft;
    if (props.indentFirst) attrs.indentFirst = props.indentFirst;
    if (props.indentRight) attrs.indentRight = props.indentRight;
  }
  return attrs;
}

// ── numbering.xml: numId -> bullet | ordered (+ format and start), per level ─
const NUM_FMT_TYPE = { lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };

function readNumbering(numberingXmlText) {
  if (!numberingXmlText) return { numToAbstract: {}, abstractFormats: {}, startOverrides: {} };
  const doc = parseXml(numberingXmlText);
  const numToAbstract = {};
  const startOverrides = {};
  for (const numEl of els(doc, 'w', 'num')) {
    const numId = attr(numEl, 'w', 'numId');
    const abstractEl = firstChild(numEl, 'w', 'abstractNumId');
    if (numId && abstractEl) numToAbstract[numId] = attr(abstractEl, 'w', 'val');
    for (const ov of childEls(numEl, 'w', 'lvlOverride')) {
      const st = firstChild(ov, 'w', 'startOverride');
      if (st) startOverrides[`${numId}:${attr(ov, 'w', 'ilvl') || '0'}`] = parseInt(attr(st, 'w', 'val'), 10);
    }
  }
  const abstractFormats = {};
  for (const abEl of els(doc, 'w', 'abstractNum')) {
    const id = attr(abEl, 'w', 'abstractNumId');
    if (!id) continue;
    const perLevel = {};
    for (const lvlEl of childEls(abEl, 'w', 'lvl')) {
      const ilvl = attr(lvlEl, 'w', 'ilvl') || '0';
      const fmtEl = firstChild(lvlEl, 'w', 'numFmt');
      const fmt = fmtEl && attr(fmtEl, 'w', 'val');
      const startEl = firstChild(lvlEl, 'w', 'start');
      perLevel[ilvl] = {
        kind: fmt === 'bullet' ? 'bullet' : 'ordered',
        type: NUM_FMT_TYPE[fmt] || null,   // decimal and everything else count 1, 2, 3
        start: startEl ? parseInt(attr(startEl, 'w', 'val'), 10) : 1,
      };
    }
    abstractFormats[id] = perLevel;
  }
  return { numToAbstract, abstractFormats, startOverrides };
}

function listInfoFor(numId, ilvl, numbering) {
  const abstractId = numbering.numToAbstract[numId];
  const perLevel = abstractId && numbering.abstractFormats[abstractId];
  const lvl = (perLevel && perLevel[String(ilvl)]) || { kind: 'bullet', type: null, start: 1 };
  const override = numbering.startOverrides[`${numId}:${ilvl}`];
  return { numId, ilvl, kind: lvl.kind, type: lvl.type, start: Number.isFinite(override) ? override : lvl.start };
}

// ── relationships (word/_rels/document.xml.rels): rId -> target path ──────
function readRelationships(relsXmlText) {
  const map = {};
  if (!relsXmlText) return map;
  const doc = parseXml(relsXmlText);
  for (const relEl of els(doc, 'rel', 'Relationship')) {
    const id = relEl.getAttribute('Id');
    const target = relEl.getAttribute('Target');
    const type = (relEl.getAttribute('Type') || '').split('/').pop();
    if (id && target) map[id] = { target: target.replace(/^\/?/, ''), type, external: relEl.getAttribute('TargetMode') === 'External' };
  }
  return map;
}

// ── run -> TipTap text/image/hardBreak nodes ────────────────────────────────
// How big an image may be before we refuse to inline it as a data URI. Above
// this, a dropped image beats a document JSON blob so large it fails to save.
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

function dataUriOf(bytes, mime) {
  const view = new Uint8Array(bytes);
  let binary = '';
  // Chunked: String.fromCharCode(...arr) blows the argument limit on a
  // multi-hundred-KB image and throws RangeError.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

// A Word drawing carries its DISPLAY size in EMU (914400 per inch) on
// wp:extent - the size the picture was scaled to on the page, which is not
// the picture's own pixel size. Dropping it left every image to render at its
// natural size: a Teams transcript's 16px speaker avatar is a 240px PNG, so
// each one came in fifteen times too big and shoved the text around it.
const EMU_PER_PX = 9525; // 914400 EMU per inch / 96 CSS px per inch

// Word's own picture format, kept as the editor's attrs (Pranshu,
// 11/05/2026: "the format is maintained"): a:srcRect is the crop in
// thousandths of a percent, a:xfrm carries rot (60000ths of a degree) and
// the flips, a:ln the border, and wp:anchor's wrap says how text goes
// around it. The exporter writes the same elements back.
function pictureFormatFrom(drawingEl) {
  const out = {};
  const src = els(drawingEl, 'a', 'srcRect')[0];
  if (src) {
    const pct = (k) => (parseInt(src.getAttribute(k), 10) || 0) / 1000;
    const crop = { top: pct('t'), right: pct('r'), bottom: pct('b'), left: pct('l') };
    if (Object.values(crop).some(Boolean)) out.crop = crop;
  }
  const xfrm = els(drawingEl, 'a', 'xfrm')[0];
  if (xfrm) {
    const rot = Math.round((parseInt(xfrm.getAttribute('rot'), 10) || 0) / 60000) % 360;
    if (rot) out.rotation = rot;
    if (xfrm.getAttribute('flipH') === '1') out.flipH = true;
    if (xfrm.getAttribute('flipV') === '1') out.flipV = true;
  }
  const ln = els(drawingEl, 'a', 'ln')[0];
  const clr = ln && !els(ln, 'a', 'noFill').length ? els(ln, 'a', 'srgbClr')[0] : null;
  if (clr && /^[0-9a-f]{6}$/i.test(clr.getAttribute('val') || '')) out.borderColor = `#${clr.getAttribute('val').toLowerCase()}`;
  const anchor = els(drawingEl, 'wp', 'anchor')[0];
  if (anchor) {
    if (els(anchor, 'wp', 'wrapNone').length) out.wrapMode = anchor.getAttribute('behindDoc') === '1' ? 'behind' : 'front';
    else if (els(anchor, 'wp', 'wrapSquare').length || els(anchor, 'wp', 'wrapTight').length) {
      const align = els(els(anchor, 'wp', 'positionH')[0], 'wp', 'align')[0];
      out.wrapMode = align && align.textContent.trim() === 'right' ? 'squareRight' : 'square';
    }
  }
  return out;
}

function drawingSizePx(drawingEl) {
  const extent = els(drawingEl, 'wp', 'extent')[0] || els(drawingEl, 'a', 'ext')[0];
  if (!extent) return null;
  const cx = parseInt(extent.getAttribute('cx'), 10);
  const cy = parseInt(extent.getAttribute('cy'), 10);
  if (!cx || !cy) return null;
  return { width: Math.round(cx / EMU_PER_PX), height: Math.round(cy / EMU_PER_PX) };
}

// VML (w:pict / mc:Fallback) sizes its shape in CSS: style="width:200pt;height:80pt".
function vmlSizePx(pictEl) {
  const shape = Array.from(pictEl.getElementsByTagName('*')).find(e => /^(shape|rect|roundrect)$/.test(e.localName) && e.getAttribute('style'));
  const style = shape && shape.getAttribute('style');
  if (!style) return null;
  const read = (k) => { const m = new RegExp(`${k}:\\s*([\\d.]+)(pt|px|in|cm|mm)?`).exec(style); return m ? universalMeasurePt(`${m[1]}${m[2] || 'pt'}`) * (96 / 72) : null; };
  const width = read('width'), height = read('height');
  return width && height ? { width: Math.round(width), height: Math.round(height) } : null;
}

// Word can hold a picture wider than the text column (it just spills into the
// margin); this editor's canvas cannot, so scale those down proportionally.
// Anything already inside the column is left exactly as the document sized it.
function fitToColumn(size, columnPx) {
  if (!size || !columnPx || size.width <= columnPx) return size;
  const ratio = columnPx / size.width;
  return { width: columnPx, height: Math.max(1, Math.round(size.height * ratio)) };
}

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

async function imageNodeFor(rId, size, ctx) {
  const rel = rId && ctx.rels[rId];
  if (!rel) return null;
  try {
    const mediaPath = `word/${rel.target.replace(/^word\//, '')}`;
    const file = ctx.zip.file(mediaPath) || ctx.zip.file(rel.target);
    if (!file) return null;
    const bytes = await file.async('arraybuffer');
    const ext = (mediaPath.split('.').pop() || 'png').toLowerCase();
    const mime = IMAGE_MIME[ext] || '';   // WMF/EMF: no browser can draw it
    if (!mime) return null;
    ctx.imgCounter.n += 1;
    // Hosted if we can (keeps the document JSON small), inline if we cannot.
    // It used to be hosted-or-nothing, so on any deployment where the upload
    // failed - no storage configured, an offline laptop, a bucket permission -
    // every picture vanished AND left its paragraph behind as a blank line.
    let url = '';
    try { url = (await ctx.uploadImage?.(bytes, mime, ctx.imgCounter.n)) || ''; } catch { url = ''; }
    if (!url && bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
      try { url = dataUriOf(bytes, mime); } catch { url = ''; }
    }
    if (!url) { ctx.imgCounter.dropped = (ctx.imgCounter.dropped || 0) + 1; return null; }
    const fitted = fitToColumn(size, ctx.columnPx);
    return { type: 'image', attrs: fitted ? { src: url, ...fitted } : { src: url } };
  } catch {
    return null;   // a single unreadable image must not abort the whole import
  }
}

// A text box (Word's Insert > Text Box, or a shape with text): its content is
// a w:txbxContent anywhere inside the drawing. The editor's docTextbox holds
// paragraphs only, so headings and list items flatten to paragraphs.
async function textboxFrom(container, size, ctx) {
  const txbx = Array.from(container.getElementsByTagNameNS(NS.w, 'txbxContent'))[0];
  if (!txbx) return null;
  const blocks = await blocksFromContainer(txbx, ctx);
  const paras = [];
  const walk = (n) => {
    if (n.type === 'paragraph') paras.push(n);
    else if (n.type === 'heading') paras.push({ type: 'paragraph', attrs: n.attrs, content: n.content });
    else (n.content || []).forEach(walk);
  };
  blocks.forEach(walk);
  if (!paras.length) return null;
  const s = size || { width: 220, height: 120 };
  return { type: 'docTextbox', attrs: { width: s.width, height: Math.max(40, s.height) }, content: paras };
}

// Everything a single w:r turns into. `state` is the paragraph's field-code
// state machine (complex fields: w:fldChar begin / instrText / separate / end).
async function runToNodes(runEl, styleRunProps, link, ctx, state) {
  const nodes = [];
  const after = [];   // block-level things found inside the run (text boxes)
  const rPr = firstChild(runEl, 'w', 'rPr');
  // Cascade: paragraph-level props -> character style (w:rStyle) -> the run's
  // own direct formatting. The character style rung used to be missing, so a
  // document that carries its body size on a character style (what the Teams
  // transcript exporter does) fell all the way back to whatever the paragraph
  // style said - which is how 11pt text imported as 2pt.
  const rStyleEl = firstChild(rPr, 'w', 'rStyle');
  const rStyleId = rStyleEl && attr(rStyleEl, 'w', 'val');
  const inherited = rStyleId ? resolvedRunProps(rStyleId, ctx.styles, styleRunProps) : styleRunProps;
  const props = runPropsFrom(rPr, inherited, ctx.styles.theme);
  const marks = marksFor(props, link || state.fieldLink, state.change);
  const pushText = (text) => {
    if (!text) return;
    const t = props.caps ? text.toUpperCase() : text;
    nodes.push(marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
  };
  for (const child of Array.from(runEl.childNodes)) {
    if (child.nodeType !== 1) continue;
    const tag = child.namespaceURI === NS.w ? child.localName : '';
    if (tag === 'fldChar') {
      const kind = attr(child, 'w', 'fldCharType');
      if (kind === 'begin') { state.field = 'instr'; state.instr = ''; }
      else if (kind === 'separate') {
        state.field = 'result';
        const m = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(state.instr || '');
        state.fieldLink = m ? m[1] : null;
        if (/^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.test(state.instr || '')) state.pageField = true;
        marks.length = 0; marks.push(...marksFor(props, link || state.fieldLink, state.change));
      } else if (kind === 'end') { state.field = null; state.instr = ''; state.fieldLink = null; marks.length = 0; marks.push(...marksFor(props, link, state.change)); }
    } else if (tag === 'instrText') {
      state.instr = (state.instr || '') + child.textContent;
    } else if (state.field === 'instr') {
      // Between begin and separate there is only the field code; nothing to show.
    } else if (tag === 't' || tag === 'delText') {
      if (!state.pageField) pushText(child.textContent);
    } else if (tag === 'tab') {
      nodes.push({ type: 'tab' });   // a real tab, laid out to its stop (lib/docTabs.js)
    } else if (tag === 'br') {
      const brType = attr(child, 'w', 'type');
      if (brType === 'page') nodes.push({ type: '__pageBreak__' }); // hoisted to block level by the caller
      else nodes.push({ type: 'hardBreak' });
    } else if (tag === 'sym') {
      const code = parseInt(attr(child, 'w', 'char') || '', 16);
      if (Number.isFinite(code)) pushText(String.fromCodePoint(code >= 0xF000 && code <= 0xF0FF ? code - 0xF000 : code));
    } else if (tag === 'drawing' || tag === 'pict' || tag === 'object') {
      const blip = els(child, 'a', 'blip')[0];
      const imagedata = Array.from(child.getElementsByTagName('*')).find(e => e.localName === 'imagedata');
      const rId = (blip && blip.getAttributeNS(NS.r, 'embed')) || (imagedata && imagedata.getAttributeNS(NS.r, 'id'));
      const size = tag === 'drawing' ? drawingSizePx(child) : vmlSizePx(child);
      const img = rId ? await imageNodeFor(rId, size, ctx) : null;
      if (img) { Object.assign(img.attrs, pictureFormatFrom(child)); nodes.push(img); }
      else {
        const box = await textboxFrom(child, size, ctx);
        if (box) after.push(box);
      }
    }
  }
  return { nodes, after };
}

// The inline children of a paragraph, in order, with the wrappers Word puts
// around runs unwrapped: w:hyperlink (a link), w:ins (a tracked insertion -
// kept, as if accepted), w:del (a tracked deletion - dropped), w:sdt (a
// content control), w:smartTag, w:fldSimple (a simple field), and
// mc:AlternateContent (a newer drawing with a VML fallback). Only the runs a
// paragraph DIRECTLY held were read before, so every hyperlink's text, every
// tracked insertion and every content control's text vanished on import.
async function inlineNodes(parentEl, styleRunProps, link, ctx, state) {
  const nodes = [];
  const after = [];
  for (const child of Array.from(parentEl.childNodes)) {
    if (child.nodeType !== 1) continue;
    if (isW(child, 'r')) {
      const r = await runToNodes(child, styleRunProps, link, ctx, state);
      nodes.push(...r.nodes); after.push(...r.after);
    } else if (isW(child, 'hyperlink')) {
      const rId = child.getAttributeNS(NS.r, 'id');
      const anchor = attr(child, 'w', 'anchor');
      const rel = rId && ctx.rels[rId];
      const href = rel ? rel.target : anchor ? `#${anchor}` : null;
      const r = await inlineNodes(child, styleRunProps, href || link, ctx, state);
      nodes.push(...r.nodes); after.push(...r.after);
    } else if (isW(child, 'fldSimple')) {
      const instr = attr(child, 'w', 'instr') || '';
      if (/^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.test(instr)) { state.pageField = true; continue; }
      const m = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(instr);
      const r = await inlineNodes(child, styleRunProps, (m && m[1]) || link, ctx, state);
      nodes.push(...r.nodes); after.push(...r.after);
    } else if (isW(child, 'del') || isW(child, 'moveFrom') || isW(child, 'ins') || isW(child, 'moveTo')) {
      // A tracked change comes in as one (Review > Track Changes), author and
      // date kept, so Accept / Reject work on it here too.
      const type = isW(child, 'del') || isW(child, 'moveFrom') ? 'deletion' : 'insertion';
      if (type === 'deletion') ctx.stats.deletions = (ctx.stats.deletions || 0) + 1;
      const prev = state.change;
      state.change = { type, attrs: { author: attr(child, 'w', 'author') || '', name: attr(child, 'w', 'author') || '', at: attr(child, 'w', 'date') || '' } };
      const r = await inlineNodes(child, styleRunProps, link, ctx, state);
      state.change = prev;
      nodes.push(...r.nodes); after.push(...r.after);
    } else if (isW(child, 'smartTag') || isW(child, 'customXml') || isW(child, 'dir') || isW(child, 'bdo')) {
      const r = await inlineNodes(child, styleRunProps, link, ctx, state);
      nodes.push(...r.nodes); after.push(...r.after);
    } else if (isW(child, 'sdt')) {
      const content = firstChild(child, 'w', 'sdtContent');
      if (content) { const r = await inlineNodes(content, styleRunProps, link, ctx, state); nodes.push(...r.nodes); after.push(...r.after); }
    } else if (child.namespaceURI === NS.mc && child.localName === 'AlternateContent') {
      const choice = Array.from(child.childNodes).find(n => n.nodeType === 1 && n.localName === 'Choice');
      const fallback = Array.from(child.childNodes).find(n => n.nodeType === 1 && n.localName === 'Fallback');
      let r = choice ? await inlineNodes(choice, styleRunProps, link, ctx, state) : { nodes: [], after: [] };
      if (!r.nodes.length && !r.after.length && fallback) r = await inlineNodes(fallback, styleRunProps, link, ctx, state);
      nodes.push(...r.nodes); after.push(...r.after);
    }
  }
  return { nodes, after };
}

// ── paragraph -> heading|paragraph node (+ any hoisted blocks) ──────────────
async function paragraphToNode(pEl, ctx) {
  const pPr = firstChild(pEl, 'w', 'pPr');
  const pStyleEl = firstChild(pPr, 'w', 'pStyle');
  const styleId = pStyleEl && attr(pStyleEl, 'w', 'val');
  const styleRunProps = resolvedRunProps(styleId, ctx.styles, ctx.baseRunProps || {});
  const paraProps = paraPropsFrom(pPr, resolvedParaProps(styleId, ctx.styles, ctx.baseParaProps || {}));

  const state = { field: null, instr: '', fieldLink: null, pageField: false };
  const { nodes: inline, after } = await inlineNodes(pEl, styleRunProps, null, ctx, state);
  const content = [];
  const pageBreaksBefore = [];
  if (paraProps.pageBreakBefore) pageBreaksBefore.push({ type: 'pageBreak' });
  for (const n of inline) {
    if (n.type === '__pageBreak__') pageBreaksBefore.push({ type: 'pageBreak' });
    else content.push(n);
  }
  // Did the SOURCE paragraph carry anything at all? A paragraph Word left
  // empty is a real blank line and must survive - dropping those would be its
  // own alteration. But a paragraph that held only a picture we could not
  // embed, or only a page-number field, must not be left behind as a blank
  // line.
  const hadRuns = els(pEl, 'w', 'r').length > 0;
  if (state.pageField) {
    // "Page 3 of 9": the whole line is the page number, which the editor and
    // every export draw themselves - kept, it would print as "Page  of ".
    ctx.stats.pageNumberLines = (ctx.stats.pageNumberLines || 0) + 1;
    return { nodes: [], listInfo: null, pageBreaksBefore, after };
  }
  if (!content.length && hadRuns && !after.length && pageBreaksBefore.length === 0) {
    return { nodes: [], listInfo: null, pageBreaksBefore, after };
  }

  const numPr = firstChild(pPr, 'w', 'numPr') || styleNumPr(styleId, ctx.styles);
  let listInfo = null;
  if (numPr) {
    const numIdEl = firstChild(numPr, 'w', 'numId');
    const ilvlEl = firstChild(numPr, 'w', 'ilvl');
    const numId = numIdEl && attr(numIdEl, 'w', 'val');
    const ilvl = parseInt((ilvlEl && attr(ilvlEl, 'w', 'val')) || '0', 10);
    // numId 0 is Word's "this paragraph is NOT in a list" override.
    if (numId && numId !== '0') listInfo = listInfoFor(numId, ilvl, ctx.numbering);
  }

  const level = outlineLevel(styleId, ctx.styles);
  const attrs = paragraphAttrsFrom(paraProps, { isListItem: !!listInfo });
  const wrap = (inline) => (level != null && level >= 0 && level <= 5
    ? { type: 'heading', attrs: { level: level + 1, ...attrs }, content: inline }
    : { type: 'paragraph', attrs, content: inline });

  // Word puts a picture INSIDE the run where it sits, and the editor's image
  // node is inline for exactly that reason - so the paragraph is kept whole
  // and every picture stays at its own position in the run order. A Teams
  // transcript's speaker avatar therefore imports beside the name, as Word
  // draws it, not on a line of its own.
  const nodes = content.length || !after.length ? [wrap(content.length ? content : undefined)] : [];
  return { nodes, listInfo, pageBreaksBefore, after };
}

// Groups a flat sequence of {node, listInfo} into real nested
// bulletList/orderedList>listItem structures - consecutive list paragraphs
// at ilvl 0 become one list; a jump to a deeper ilvl nests a new list inside
// the previous item (approximating Word's Tab-to-indent multilevel lists).
function groupLists(items) {
  const out = [];
  const stack = []; // [{ilvl, listNode, kind, numId}]

  const closeTo = (ilvl) => { while (stack.length && stack[stack.length - 1].ilvl >= ilvl) stack.pop(); };
  const openList = (info) => {
    const listNode = info.kind === 'bullet'
      ? { type: 'bulletList', content: [] }
      : { type: 'orderedList', attrs: { start: info.start || 1, type: info.type || null }, content: [] };
    if (stack.length) {
      const parentItem = stack[stack.length - 1].listNode.content.slice(-1)[0];
      (parentItem.content ||= []).push(listNode);
    } else {
      out.push(listNode);
    }
    stack.push({ ilvl: info.ilvl, listNode, kind: info.kind, numId: info.numId });
  };

  for (const item of items) {
    if (!item.listInfo) {
      stack.length = 0;
      out.push(...item.nodes);
      continue;
    }
    const info = item.listInfo;
    closeTo(info.ilvl + 1);
    let top = stack[stack.length - 1];
    // Reuse the current list at this level only if it is the SAME list (same
    // numbering instance and kind); a new instance restarts its numbers, as
    // Word's does.
    if (!top || top.ilvl !== info.ilvl) {
      openList(info);
    } else if (top.kind !== info.kind || top.numId !== info.numId) {
      stack.pop();
      openList(info);
    }
    top = stack[stack.length - 1];
    // Every block the paragraph produced belongs to the SAME list item - a
    // picture in a bullet stays in that bullet rather than starting a new one.
    top.listNode.content.push({ type: 'listItem', content: item.nodes });
  }
  return out;
}

// ── tables ──────────────────────────────────────────────────────────────────
const BORDER_SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV', 'start', 'end'];

// true / false when the element says, undefined when it says nothing.
function visibleBorders(bordersEl) {
  if (!bordersEl) return undefined;
  let any = false;
  for (const side of BORDER_SIDES) {
    const el = firstChild(bordersEl, 'w', side);
    if (!el) continue;
    any = true;
    const v = attr(el, 'w', 'val') || 'single';
    if (v !== 'none' && v !== 'nil') return true;
  }
  return any ? false : undefined;
}

function tableHasBorders(tblPr, styles) {
  const own = visibleBorders(firstChild(tblPr, 'w', 'tblBorders'));
  if (own !== undefined) return own;
  const styleEl = firstChild(tblPr, 'w', 'tblStyle');
  let styleId = styleEl && attr(styleEl, 'w', 'val');
  const seen = new Set();
  while (styleId && !seen.has(styleId)) {
    seen.add(styleId);
    const s = styles.byId[styleId];
    if (!s) break;
    const v = visibleBorders(firstChild(s.tblPr, 'w', 'tblBorders'));
    if (v !== undefined) return v;
    styleId = s.basedOn;
  }
  // No borders stated anywhere: Word draws none (the "Table Normal" default).
  return false;
}

async function tableToNode(tblEl, ctx) {
  const tblPr = firstChild(tblEl, 'w', 'tblPr');
  const grid = childEls(firstChild(tblEl, 'w', 'tblGrid'), 'w', 'gridCol')
    .map(g => Math.round(measureInches(attr(g, 'w', 'w')) * 96))
    .map(px => (px > 0 ? px : null));
  const rows = [];
  const open = {};   // column index -> the cell a vertical merge continues
  for (const trEl of childEls(tblEl, 'w', 'tr')) {
    const cells = [];
    let col = 0;
    for (const tcEl of childEls(trEl, 'w', 'tc')) {
      const tcPr = firstChild(tcEl, 'w', 'tcPr');
      const spanEl = firstChild(tcPr, 'w', 'gridSpan');
      const span = Math.max(1, parseInt((spanEl && attr(spanEl, 'w', 'val')) || '1', 10) || 1);
      const vMerge = firstChild(tcPr, 'w', 'vMerge');
      const continues = vMerge && (attr(vMerge, 'w', 'val') || 'continue') !== 'restart';
      if (continues && open[col]) {
        // The cell above spans down over this one; this one is not a cell.
        open[col].attrs.rowspan = (open[col].attrs.rowspan || 1) + 1;
        col += span;
        continue;
      }
      const shd = firstChild(tcPr, 'w', 'shd');
      const fill = shd && attr(shd, 'w', 'fill');
      const attrs = {};
      if (fill && fill !== 'auto') attrs.backgroundColor = `#${fill}`;
      if (span > 1) attrs.colspan = span;
      const widths = grid.slice(col, col + span);
      if (widths.length === span && widths.every(Boolean)) attrs.colwidth = widths;
      else {
        const tcW = firstChild(tcPr, 'w', 'tcW');
        const w = tcW && (attr(tcW, 'w', 'type') || 'dxa') === 'dxa' ? Math.round(measureInches(attr(tcW, 'w', 'w')) * 96) : 0;
        if (w > 0 && span === 1) attrs.colwidth = [w];
      }
      const blockNodes = await blocksFromContainer(tcEl, ctx);
      const cell = { type: 'tableCell', attrs, content: blockNodes.length ? blockNodes : [{ type: 'paragraph' }] };
      if (vMerge && !continues) open[col] = cell; else delete open[col];
      cells.push(cell);
      col += span;
    }
    if (cells.length) rows.push({ type: 'tableRow', content: cells });
  }
  const attrs = tableHasBorders(tblPr, ctx.styles) ? {} : { borders: 'none' };
  return { type: 'table', attrs, content: rows };
}

// Walks the direct block-level children of a body/cell element (w:p, w:tbl),
// producing final TipTap block nodes with lists already grouped and page
// breaks hoisted to their own sibling nodes.
async function blocksFromContainer(containerEl, ctx) {
  const flatItems = [];
  for (const child of Array.from(containerEl.childNodes)) {
    if (child.nodeType !== 1) continue;
    if (isW(child, 'p')) {
      const { nodes, listInfo, pageBreaksBefore, after } = await paragraphToNode(child, ctx);
      for (const pb of pageBreaksBefore) flatItems.push({ nodes: [pb], listInfo: null });
      if (nodes.length) flatItems.push({ nodes, listInfo });
      for (const b of after) flatItems.push({ nodes: [b], listInfo: null });
    } else if (isW(child, 'tbl')) {
      flatItems.push({ nodes: [await tableToNode(child, ctx)], listInfo: null });
    } else if (isW(child, 'sdt')) {
      const content = firstChild(child, 'w', 'sdtContent');
      if (content) flatItems.push(...(await blocksFromContainer(content, ctx)).map(n => ({ nodes: [n], listInfo: null })));
    }
  }
  return groupLists(flatItems);
}

// ── w:sectPr -> page setup ──────────────────────────────────────────────────
const MARGIN_PRESET_IN = { normal: 1.0, narrow: 0.5, wide: 1.5 };

function sectionMargins(sectPr) {
  const pgMar = firstChild(sectPr, 'w', 'pgMar');
  if (!pgMar) return null;
  const side = (name) => Math.round(measureInches(attr(pgMar, 'w', name)) * 100) / 100;
  const m = { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
  if (!Object.values(m).every(v => v > 0 && v < 5)) return null;
  return m;
}

// How wide the document's own text column is, in CSS px - the ceiling for an
// imported picture. Letter with 1in margins (6.5in) when the section says
// nothing, which is what this editor's canvas defaults to anyway.
function textColumnPx(bodyEl) {
  const DEFAULT_COLUMN_PX = Math.round(6.5 * 96);
  const sectPr = firstChild(bodyEl, 'w', 'sectPr');
  const pgSz = firstChild(sectPr, 'w', 'pgSz');
  const width = pgSz ? measureInches(attr(pgSz, 'w', 'w')) : 0;
  if (!width) return DEFAULT_COLUMN_PX;
  const m = sectionMargins(sectPr) || { left: 1, right: 1 };
  const column = width - m.left - m.right;
  if (column <= 0) return DEFAULT_COLUMN_PX;
  return Math.round(column * 96);
}

// Best-effort; falls back to Letter/Portrait/Normal if the section properties
// are missing or unrecognized. Margins that match a preset within a twentieth
// of an inch take the preset; anything else is kept exactly as custom margins.
function readPageSetup(bodyEl) {
  const sectPr = firstChild(bodyEl, 'w', 'sectPr');
  if (!sectPr) return undefined;
  const pgSz = firstChild(sectPr, 'w', 'pgSz');
  let size = 'letter', orientation = 'portrait';
  if (pgSz) {
    const w = measureInches(attr(pgSz, 'w', 'w'));
    const h = measureInches(attr(pgSz, 'w', 'h'));
    orientation = attr(pgSz, 'w', 'orient') === 'landscape' || w > h ? 'landscape' : 'portrait';
    const long = Math.max(w, h), short = Math.min(w, h);
    // Kept in step with pageSetup.js PAGE_SIZES and doc_export.py PAGE_SIZES_IN.
    const SIZES = [['legal', 14, 8.5], ['tabloid', 17, 11], ['a4', 11.69, 8.27], ['a3', 16.54, 11.69], ['a5', 8.27, 5.83], ['b5', 9.84, 6.93], ['executive', 10.5, 7.25]];
    const hit = SIZES.find(([, l, s]) => Math.abs(long - l) < 0.3 && Math.abs(short - s) < 0.3);
    if (hit) size = hit[0];
  }
  const setup = { size, orientation, margins: 'normal' };
  const m = sectionMargins(sectPr);
  if (m) {
    const preset = Object.entries(MARGIN_PRESET_IN).find(([, inches]) => Object.values(m).every(v => Math.abs(v - inches) <= 0.05));
    if (preset) setup.margins = preset[0];
    else { setup.margins = 'custom'; setup.marginIn = m; }
  }
  return setup;
}

// The first section's default header / footer part, converted like the body.
async function headerFooterFrom(bodyEl, kind, ctx, readText) {
  const sectPr = firstChild(bodyEl, 'w', 'sectPr');
  const refs = childEls(sectPr, 'w', `${kind}Reference`);
  const ref = refs.find(r => attr(r, 'w', 'type') === 'default') || refs[0];
  const rel = ref && ctx.rels[ref.getAttributeNS(NS.r, 'id')];
  if (!rel) return null;
  const path = `word/${rel.target.replace(/^word\//, '')}`;
  const xml = await readText(path);
  if (!xml) return null;
  const partRels = readRelationships(await readText(path.replace(/^word\//, 'word/_rels/') + '.rels'));
  const doc = parseXml(xml);
  const content = await blocksFromContainer(doc.documentElement, { ...ctx, rels: partRels });
  const hasSomething = (nodes) => nodes.some(n => (n.type === 'text' && n.text.trim()) || n.type === 'image' || n.type === 'table' || hasSomething(n.content || []));
  if (!hasSomething(content)) return null;
  return { type: 'doc', content };
}

async function countFootnotes(readText) {
  const xml = await readText('word/footnotes.xml');
  if (!xml) return 0;
  const doc = parseXml(xml);
  // Word always writes two housekeeping notes (ids -1 and 0: the separators).
  return els(doc, 'w', 'footnote').filter(f => !['-1', '0'].includes(attr(f, 'w', 'id'))).length;
}

export async function convertDocxToTiptap(file, { uploadImage } = {}) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const readText = async (path) => {
    const f = zip.file(path);
    return f ? f.async('string') : null;
  };

  const [documentXml, stylesXml, numberingXml, relsXml, themeXml] = await Promise.all([
    readText('word/document.xml'),
    readText('word/styles.xml'),
    readText('word/numbering.xml'),
    readText('word/_rels/document.xml.rels'),
    readText('word/theme/theme1.xml'),
  ]);
  if (!documentXml) throw new Error('This file does not look like a valid .docx (word/document.xml missing).');

  const styles = readStyles(stylesXml, readTheme(themeXml));
  const numbering = readNumbering(numberingXml);
  const rels = readRelationships(relsXml);
  const doc = parseXml(documentXml);
  const bodyEl = firstChild(doc.documentElement, 'w', 'body');

  const ctx = {
    styles, numbering, rels, zip, uploadImage, imgCounter: { n: 0 }, stats: {},
    baseRunProps: baseRunPropsOf(styles),
    baseParaProps: baseParaPropsOf(styles),
    columnPx: textColumnPx(bodyEl),
  };
  const content = await blocksFromContainer(bodyEl, ctx);
  const pageSetup = readPageSetup(bodyEl);
  const header = await headerFooterFrom(bodyEl, 'header', ctx, readText);
  const footer = await headerFooterFrom(bodyEl, 'footer', ctx, readText);

  const warnings = [];
  const footnotes = await countFootnotes(readText);
  if (footnotes) warnings.push(`${footnotes} footnote${footnotes === 1 ? '' : 's'} could not be brought in - the editor has no footnotes.`);
  if (ctx.stats.deletions) warnings.push('Tracked changes came in as changes: accept or reject them on the Review tab.');
  if (ctx.imgCounter.dropped) warnings.push(`${ctx.imgCounter.dropped} picture${ctx.imgCounter.dropped === 1 ? '' : 's'} could not be read.`);
  if (ctx.stats.pageNumberLines) warnings.push('Page numbers come from Nexus and were left out of the header and footer.');

  return {
    body: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
    pageSetup,
    header,
    footer,
    warnings,
  };
}
