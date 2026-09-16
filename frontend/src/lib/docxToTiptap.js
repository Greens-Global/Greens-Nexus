// Direct OOXML -> TipTap JSON converter (Phase 16 - "robust import").
//
// Why this exists instead of just using mammoth: mammoth's convertToHtml()
// deliberately discards DIRECT (manually-applied, not named-style) run
// formatting - font family, font size, text color, highlight, and paragraph
// alignment all vanish by design (mammoth's own docs: it only preserves
// content it can map to *semantic* HTML via named Word styles). Most
// everyday Word documents use direct formatting, not named character
// styles, so that's the actual cause of "the font/size changed on import".
// Mammoth's own internal document model DOES parse this info from the XML
// (see its Run.font/fontSize) - it just never surfaces it in the HTML
// writer, and there's no supported public option to make it do so.
//
// This module reads the raw docx (a zip of OOXML parts) directly with
// JSZip + DOMParser and builds TipTap JSON nodes itself, so font/size/
// color/highlight/alignment/heading-level/list-type/table-shading/page-size
// all come straight from the source XML instead of round-tripping through
// an intermediate format that throws them away.
//
// Explicit, permanent limits (not "not implemented yet" - this editor's
// schema has no equivalent for these, so no importer could preserve them
// without a from-scratch editor rewrite): footnotes/endnotes, per-section
// multiple headers/footers (this editor has exactly one of each), tracked
// changes/comments (insertions are kept, deletions are dropped - i.e.
// imported "as if accepted"), multi-level numbering formats beyond
// bullet/decimal (roman/alpha numerals import as a plain decimal ordered
// list), floating shapes/WordArt/embedded objects, drop caps, kerning, and
// exact line-spacing values (only alignment + font/size/color/bold/italic/
// underline/strike/highlight are run-level attributes this schema has marks
// for).

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
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

// Trailing zeros off, so a plain 11pt stays "11pt" and 4.3mm reads "12.2pt" -
// the same one-decimal precision Word's own size box shows.
const ptLabel = (pt) => `${+pt.toFixed(1)}pt`;

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

// ── styles.xml: resolve a paragraph style's effective run/paragraph
// defaults, walking w:basedOn chains (Word styles inherit like CSS). ───────
function readStyles(stylesXmlText) {
  if (!stylesXmlText) return { byId: {}, docDefaults: {}, defaultParagraphStyleId: null };
  const doc = parseXml(stylesXmlText);
  const byId = {};
  let defaultParagraphStyleId = null;
  for (const styleEl of els(doc, 'w', 'style')) {
    const id = attr(styleEl, 'w', 'styleId');
    if (!id) continue;
    const nameEl = firstChild(styleEl, 'w', 'name');
    const basedOnEl = firstChild(styleEl, 'w', 'basedOn');
    byId[id] = {
      name: (attr(nameEl, 'w', 'val') || '').toLowerCase(),
      basedOn: attr(basedOnEl, 'w', 'val') || null,
      pPr: firstChild(styleEl, 'w', 'pPr'),
      rPr: firstChild(styleEl, 'w', 'rPr'),
    };
    // The style marked w:default="1" is what every paragraph without an
    // explicit w:pStyle actually inherits (usually "Normal"). Without it a
    // document whose body size lives only on Normal imported at the editor's
    // own CSS default instead of the document's.
    if (attr(styleEl, 'w', 'type') === 'paragraph' && attr(styleEl, 'w', 'default') === '1') {
      defaultParagraphStyleId = id;
    }
  }
  if (!defaultParagraphStyleId && byId.Normal) defaultParagraphStyleId = 'Normal';
  const docDefaultsEl = firstChild(doc.documentElement, 'w', 'docDefaults');
  const rPrDefault = docDefaultsEl && firstChild(firstChild(docDefaultsEl, 'w', 'rPrDefault'), 'w', 'rPr');
  return { byId, docDefaults: { rPr: rPrDefault }, defaultParagraphStyleId };
}

// Resolves a style's effective run properties on top of `base`, walking the
// w:basedOn chain. `base` is what the style inherits from the level below it
// in Word's cascade (docDefaults -> default paragraph style -> this style).
function resolvedRunProps(styleId, styles, base = {}, seen = new Set()) {
  if (!styleId || seen.has(styleId)) return { ...base };
  seen.add(styleId);
  const s = styles.byId[styleId];
  if (!s) return { ...base };
  const parent = s.basedOn ? resolvedRunProps(s.basedOn, styles, base, seen) : base;
  return runPropsFrom(s.rPr, parent);
}

// Word's real cascade, bottom two levels: w:docDefaults, then the paragraph
// style marked as the document default. Everything a paragraph or run says
// later layers on top of this.
function baseRunPropsOf(styles) {
  const fromDefaults = runPropsFrom(styles.docDefaults?.rPr, {});
  return styles.defaultParagraphStyleId
    ? resolvedRunProps(styles.defaultParagraphStyleId, styles, fromDefaults)
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

function runPropsFrom(rPr, inherited = {}) {
  if (!rPr) return { ...inherited };
  const out = { ...inherited };
  const fonts = firstChild(rPr, 'w', 'rFonts');
  const font = fonts && (attr(fonts, 'w', 'ascii') || attr(fonts, 'w', 'hAnsi') || attr(fonts, 'w', 'cs'));
  if (font) out.fontFamily = font;
  const sz = firstChild(rPr, 'w', 'sz');
  if (sz) { const pt = fontSizePt(attr(sz, 'w', 'val')); if (pt) out.fontSize = ptLabel(pt); }
  const b = toggle(rPr, 'b'); if (b !== undefined) out.bold = b;
  const i = toggle(rPr, 'i'); if (i !== undefined) out.italic = i;
  const u = firstChild(rPr, 'w', 'u');
  if (u) out.underline = (attr(u, 'w', 'val') || 'single') !== 'none';
  const strike = toggle(rPr, 'strike'); if (strike !== undefined) out.strike = strike;
  const color = firstChild(rPr, 'w', 'color');
  const colorVal = color && attr(color, 'w', 'val');
  if (colorVal && colorVal !== 'auto') out.color = `#${colorVal}`;
  const hl = firstChild(rPr, 'w', 'highlight');
  const hlVal = hl && attr(hl, 'w', 'val');
  if (hlVal && HIGHLIGHT_HEX[hlVal]) out.highlight = HIGHLIGHT_HEX[hlVal];
  return out;
}

function marksFor(props) {
  const marks = [];
  if (props.bold) marks.push({ type: 'bold' });
  if (props.italic) marks.push({ type: 'italic' });
  if (props.underline) marks.push({ type: 'underline' });
  if (props.strike) marks.push({ type: 'strike' });
  const textStyleAttrs = {};
  if (props.fontFamily) textStyleAttrs.fontFamily = props.fontFamily;
  if (props.fontSize) textStyleAttrs.fontSize = props.fontSize;
  if (props.color) textStyleAttrs.color = props.color;
  if (Object.keys(textStyleAttrs).length) marks.push({ type: 'textStyle', attrs: textStyleAttrs });
  // Highlight has no dedicated mark in this schema - approximated as a
  // background-color via the same textStyle span so it isn't silently
  // dropped (renders visibly, even if not a distinct "highlight" concept
  // in the editor's UI).
  if (props.highlight) marks.push({ type: 'textStyle', attrs: { backgroundColor: props.highlight } });
  return marks;
}

// ── numbering.xml: numId -> bullet | ordered, per indent level ─────────────
function readNumbering(numberingXmlText) {
  if (!numberingXmlText) return { numToAbstract: {}, abstractFormats: {} };
  const doc = parseXml(numberingXmlText);
  const numToAbstract = {};
  for (const numEl of els(doc, 'w', 'num')) {
    const numId = attr(numEl, 'w', 'numId');
    const abstractEl = firstChild(numEl, 'w', 'abstractNumId');
    if (numId && abstractEl) numToAbstract[numId] = attr(abstractEl, 'w', 'val');
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
      perLevel[ilvl] = fmt === 'bullet' ? 'bullet' : 'ordered'; // decimal/roman/alpha/etc. all approximate to ordered
    }
    abstractFormats[id] = perLevel;
  }
  return { numToAbstract, abstractFormats };
}

function listTypeFor(numId, ilvl, numbering) {
  const abstractId = numbering.numToAbstract[numId];
  const perLevel = abstractId && numbering.abstractFormats[abstractId];
  return (perLevel && perLevel[String(ilvl)]) || 'bullet';
}

// ── relationships (word/_rels/document.xml.rels): rId -> target path ──────
function readRelationships(relsXmlText) {
  const map = {};
  if (!relsXmlText) return map;
  const doc = parseXml(relsXmlText);
  for (const relEl of els(doc, 'rel', 'Relationship')) {
    const id = relEl.getAttribute('Id');
    const target = relEl.getAttribute('Target');
    if (id && target) map[id] = target.replace(/^\/?/, '');
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

function drawingSizePx(drawingEl) {
  const extent = els(drawingEl, 'wp', 'extent')[0] || els(drawingEl, 'a', 'ext')[0];
  if (!extent) return null;
  const cx = parseInt(extent.getAttribute('cx'), 10);
  const cy = parseInt(extent.getAttribute('cy'), 10);
  if (!cx || !cy) return null;
  return { width: Math.round(cx / EMU_PER_PX), height: Math.round(cy / EMU_PER_PX) };
}

// Word can hold a picture wider than the text column (it just spills into the
// margin); this editor's canvas cannot, so scale those down proportionally.
// Anything already inside the column is left exactly as the document sized it.
function fitToColumn(size, columnPx) {
  if (!size || !columnPx || size.width <= columnPx) return size;
  const ratio = columnPx / size.width;
  return { width: columnPx, height: Math.max(1, Math.round(size.height * ratio)) };
}

async function runToNodes(runEl, styles, styleRunProps, rels, zip, uploadImage, imgCounter, columnPx) {
  const nodes = [];
  const rPr = firstChild(runEl, 'w', 'rPr');
  // Cascade: paragraph-level props -> character style (w:rStyle) -> the run's
  // own direct formatting. The character style rung used to be missing, so a
  // document that carries its body size on a character style (what the Teams
  // transcript exporter does) fell all the way back to whatever the paragraph
  // style said - which is how 11pt text imported as 2pt.
  const rStyleEl = firstChild(rPr, 'w', 'rStyle');
  const rStyleId = rStyleEl && attr(rStyleEl, 'w', 'val');
  const inherited = rStyleId ? resolvedRunProps(rStyleId, styles, styleRunProps) : styleRunProps;
  const props = runPropsFrom(rPr, inherited);
  const marks = marksFor(props);
  for (const child of Array.from(runEl.childNodes)) {
    if (child.nodeType !== 1) continue;
    if (child.localName === 't' && child.namespaceURI === NS.w) {
      const text = child.textContent;
      if (text) nodes.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    } else if (child.localName === 'tab' && child.namespaceURI === NS.w) {
      nodes.push({ type: 'text', text: '    ' });
    } else if (child.localName === 'br' && child.namespaceURI === NS.w) {
      const brType = attr(child, 'w', 'type');
      if (brType === 'page') nodes.push({ type: '__pageBreak__' }); // hoisted to block level by the caller
      else nodes.push({ type: 'hardBreak' });
    } else if (child.localName === 'drawing' && child.namespaceURI === NS.w) {
      const blip = els(child, 'a', 'blip')[0];
      const rId = blip && blip.getAttributeNS(NS.r, 'embed');
      const target = rId && rels[rId];
      if (target) {
        try {
          const mediaPath = `word/${target.replace(/^word\//, '')}`;
          const file = zip.file(mediaPath) || zip.file(target);
          if (file) {
            const bytes = await file.async('arraybuffer');
            const ext = (mediaPath.split('.').pop() || 'png').toLowerCase();
            const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', emf: '', wmf: '' }[ext] || '';
            if (mime) {
              imgCounter.n += 1;
              // Hosted if we can (keeps the document JSON small), inline if we
              // cannot. It used to be hosted-or-nothing, so on any deployment
              // where the upload failed - no storage configured, an offline
              // laptop, a bucket permission - every picture vanished AND left
              // its paragraph behind as a blank line. A Teams transcript is
              // one speaker avatar per turn, which is exactly why an imported
              // transcript came out as tiny text separated by huge gaps.
              let url = '';
              try { url = (await uploadImage?.(bytes, mime, imgCounter.n)) || ''; } catch { url = ''; }
              if (!url && bytes.byteLength <= MAX_INLINE_IMAGE_BYTES) {
                try { url = dataUriOf(bytes, mime); } catch { url = ''; }
              }
              const size = fitToColumn(drawingSizePx(child), columnPx);
              if (url) nodes.push({ type: 'image', attrs: size ? { src: url, ...size } : { src: url } });
              else imgCounter.dropped = (imgCounter.dropped || 0) + 1;
            }
          }
        } catch { /* a single unreadable image must not abort the whole import */ }
      }
    }
  }
  return nodes;
}

// ── paragraph -> heading|paragraph node (+ any hoisted pageBreak nodes) ────
async function paragraphToNode(pEl, ctx) {
  const pPr = firstChild(pEl, 'w', 'pPr');
  const pStyleEl = firstChild(pPr, 'w', 'pStyle');
  const styleId = pStyleEl && attr(pStyleEl, 'w', 'val');
  const styleRunProps = resolvedRunProps(styleId, ctx.styles, ctx.baseRunProps || {});
  const jcEl = firstChild(pPr, 'w', 'jc');
  const jc = jcEl && attr(jcEl, 'w', 'val');
  const align = jc === 'both' ? 'justify' : (jc === 'center' || jc === 'right') ? jc : null;

  let content = [];
  const pageBreaksBefore = [];
  // Did the SOURCE paragraph carry anything at all? A paragraph Word left
  // empty is a real blank line and must survive - dropping those would be its
  // own alteration. But a paragraph that held only a picture we could not
  // embed must not be left behind as a phantom blank line.
  let hadRuns = false;
  for (const child of childEls(pEl, 'w', 'r')) {
    hadRuns = true;
    const runNodes = await runToNodes(child, ctx.styles, styleRunProps, ctx.rels, ctx.zip, ctx.uploadImage, ctx.imgCounter, ctx.columnPx);
    for (const n of runNodes) {
      if (n.type === '__pageBreak__') pageBreaksBefore.push({ type: 'pageBreak' });
      else content.push(n);
    }
  }
  if (!content.length && hadRuns && pageBreaksBefore.length === 0) {
    // Content went in, nothing came out: the paragraph existed only to hold
    // something we could not represent. Skip it rather than emitting a phantom
    // blank line - an empty `nodes` is what the caller filters on.
    return { nodes: [], listInfo: null, pageBreaksBefore };
  }

  const level = outlineLevel(styleId, ctx.styles);
  const wrap = (inline) => (level != null && level >= 0 && level <= 5
    ? { type: 'heading', attrs: { level: level + 1, textAlign: align }, content: inline }
    : { type: 'paragraph', attrs: { textAlign: align }, content: inline });

  // Word puts a picture INSIDE the run where it sits, and the editor's image
  // node is inline for exactly that reason - so the paragraph is kept whole
  // and every picture stays at its own position in the run order. A Teams
  // transcript's speaker avatar therefore imports beside the name, as Word
  // draws it, not on a line of its own.
  const nodes = [wrap(content.length ? content : undefined)];

  const numPr = firstChild(pPr, 'w', 'numPr') || styleNumPr(styleId, ctx.styles);
  let listInfo = null;
  if (numPr) {
    const numIdEl = firstChild(numPr, 'w', 'numId');
    const ilvlEl = firstChild(numPr, 'w', 'ilvl');
    const numId = numIdEl && attr(numIdEl, 'w', 'val');
    const ilvl = parseInt((ilvlEl && attr(ilvlEl, 'w', 'val')) || '0', 10);
    if (numId) listInfo = { type: listTypeFor(numId, ilvl, ctx.numbering), ilvl };
  }

  return { nodes, listInfo, pageBreaksBefore };
}

// Groups a flat sequence of {node, listInfo} into real nested
// bulletList/orderedList>listItem structures - consecutive list paragraphs
// at ilvl 0 become one list; a jump to a deeper ilvl nests a new list inside
// the previous item (approximating Word's Tab-to-indent multilevel lists).
function groupLists(items) {
  const out = [];
  const stack = []; // [{ilvl, listNode}]

  const closeTo = (ilvl) => { while (stack.length && stack[stack.length - 1].ilvl >= ilvl) stack.pop(); };

  for (const item of items) {
    if (!item.listInfo) {
      stack.length = 0;
      out.push(...item.nodes);
      continue;
    }
    const { type, ilvl } = item.listInfo;
    closeTo(ilvl + 1);
    // Reuse the current list at this level only if type matches; otherwise
    // start a fresh one (Word lets bullet/decimal alternate at the same level).
    let top = stack[stack.length - 1];
    if (!top || top.ilvl !== ilvl) {
      const listNode = { type: type === 'bullet' ? 'bulletList' : 'orderedList', content: [] };
      if (stack.length) {
        const parentItem = stack[stack.length - 1].listNode.content.slice(-1)[0];
        (parentItem.content ||= []).push(listNode);
      } else {
        out.push(listNode);
      }
      stack.push({ ilvl, listNode, type });
      top = stack[stack.length - 1];
    } else if (top.type !== type) {
      // type changed at the same level - close and reopen
      stack.pop();
      const listNode = { type: type === 'bullet' ? 'bulletList' : 'orderedList', content: [] };
      if (stack.length) {
        const parentItem = stack[stack.length - 1].listNode.content.slice(-1)[0];
        (parentItem.content ||= []).push(listNode);
      } else {
        out.push(listNode);
      }
      stack.push({ ilvl, listNode, type });
      top = stack[stack.length - 1];
    }
    // Every block the paragraph produced belongs to the SAME list item - a
    // picture in a bullet stays in that bullet rather than starting a new one.
    top.listNode.content.push({ type: 'listItem', content: item.nodes });
  }
  return out;
}

async function tableToNode(tblEl, ctx) {
  const rows = [];
  for (const trEl of childEls(tblEl, 'w', 'tr')) {
    const cells = [];
    for (const tcEl of childEls(trEl, 'w', 'tc')) {
      const tcPr = firstChild(tcEl, 'w', 'tcPr');
      const shd = firstChild(tcPr, 'w', 'shd');
      const fill = shd && attr(shd, 'w', 'fill');
      const bg = fill && fill !== 'auto' ? `#${fill}` : null;
      const blockNodes = await blocksFromContainer(tcEl, ctx);
      cells.push({ type: 'tableCell', attrs: bg ? { backgroundColor: bg } : {}, content: blockNodes.length ? blockNodes : [{ type: 'paragraph' }] });
    }
    rows.push({ type: 'tableRow', content: cells });
  }
  return { type: 'table', content: rows };
}

// Walks the direct block-level children of a body/cell element (w:p, w:tbl),
// producing final TipTap block nodes with lists already grouped and page
// breaks hoisted to their own sibling nodes.
async function blocksFromContainer(containerEl, ctx) {
  const flatItems = [];
  const finalNodes = [];
  for (const child of Array.from(containerEl.childNodes)) {
    if (child.nodeType !== 1) continue;
    if (child.localName === 'p' && child.namespaceURI === NS.w) {
      const { nodes, listInfo, pageBreaksBefore } = await paragraphToNode(child, ctx);
      for (const pb of pageBreaksBefore) flatItems.push({ nodes: [pb], listInfo: null });
      if (nodes.length) flatItems.push({ nodes, listInfo });
    } else if (child.localName === 'tbl' && child.namespaceURI === NS.w) {
      flatItems.push({ nodes: [await tableToNode(child, ctx)], listInfo: null });
    }
  }
  finalNodes.push(...groupLists(flatItems));
  return finalNodes;
}

// How wide the document's own text column is, in CSS px - the ceiling for an
// imported picture. Letter with 1in margins (6.5in) when the section says
// nothing, which is what this editor's canvas defaults to anyway.
function textColumnPx(bodyEl) {
  const DEFAULT_COLUMN_PX = Math.round(6.5 * 96);
  const pgSz = firstChild(firstChild(bodyEl, 'w', 'sectPr'), 'w', 'pgSz');
  const pgMar = firstChild(firstChild(bodyEl, 'w', 'sectPr'), 'w', 'pgMar');
  const inches = (el, name) => (el ? measureInches(attr(el, 'w', name)) : 0);
  const width = inches(pgSz, 'w');
  if (!width) return DEFAULT_COLUMN_PX;
  const column = width - inches(pgMar, 'left') - inches(pgMar, 'right');
  if (column <= 0) return DEFAULT_COLUMN_PX;
  return Math.round(column * 96);
}

// ── w:sectPr -> our pageSetup shape (best-effort; falls back to Letter/
// Portrait/Normal if the section properties are missing or unrecognized) ──
function readPageSetup(bodyEl) {
  const sectPr = firstChild(bodyEl, 'w', 'sectPr');
  if (!sectPr) return undefined;
  const pgSz = firstChild(sectPr, 'w', 'pgSz');
  const pgMar = firstChild(sectPr, 'w', 'pgMar');
  let size = 'letter', orientation = 'portrait';
  if (pgSz) {
    const w = measureInches(attr(pgSz, 'w', 'w'));
    const h = measureInches(attr(pgSz, 'w', 'h'));
    orientation = attr(pgSz, 'w', 'orient') === 'landscape' || w > h ? 'landscape' : 'portrait';
    const long = Math.max(w, h), short = Math.min(w, h);
    if (Math.abs(long - 14) < 0.3 && Math.abs(short - 8.5) < 0.3) size = 'legal';
    else if (Math.abs(long - 17) < 0.3 && Math.abs(short - 11) < 0.3) size = 'tabloid';
    else if (Math.abs(long - 11.69) < 0.3 && Math.abs(short - 8.27) < 0.3) size = 'a4';
  }
  let margins = 'normal';
  if (pgMar) {
    const top = measureInches(attr(pgMar, 'w', 'top'));
    if (top <= 0.6) margins = 'narrow';
    else if (top >= 1.3) margins = 'wide';
  }
  return { size, orientation, margins };
}

export async function convertDocxToTiptap(file, { uploadImage } = {}) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());

  const readText = async (path) => {
    const f = zip.file(path);
    return f ? f.async('string') : null;
  };

  const [documentXml, stylesXml, numberingXml, relsXml] = await Promise.all([
    readText('word/document.xml'),
    readText('word/styles.xml'),
    readText('word/numbering.xml'),
    readText('word/_rels/document.xml.rels'),
  ]);
  if (!documentXml) throw new Error('This file does not look like a valid .docx (word/document.xml missing).');

  const styles = readStyles(stylesXml);
  const numbering = readNumbering(numberingXml);
  const rels = readRelationships(relsXml);
  const doc = parseXml(documentXml);
  const bodyEl = firstChild(doc.documentElement, 'w', 'body');

  const ctx = {
    styles, numbering, rels, zip, uploadImage, imgCounter: { n: 0 },
    baseRunProps: baseRunPropsOf(styles),
    columnPx: textColumnPx(bodyEl),
  };
  const content = await blocksFromContainer(bodyEl, ctx);
  const pageSetup = readPageSetup(bodyEl);

  return {
    body: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
    pageSetup,
  };
}
