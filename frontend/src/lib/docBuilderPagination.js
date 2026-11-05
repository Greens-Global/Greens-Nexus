// Real pages in the editor canvas.
//
// Sagar, Sep 18: "why don't you break the pages, it's showing a single long
// page only for the Editor also". Pranshu, Nov 4: a page must look like a
// page - text that reaches the bottom margin and stops, a paragraph that
// carries on at the top of the next sheet, the header and footer repeated
// on every sheet, and "Page 3 of 9" where Word puts it.
//
// The canvas is one continuous ProseMirror document and stays that way - that
// is what keeps typing, undo, selection and copy/paste working across the whole
// document. What changes is where the content SITS: at every sheet boundary a
// widget decoration (a block the editor does not own) is laid into the flow,
// exactly as tall as [the room left under the last line] + [bottom margin] +
// [the gray gap between sheets] + [top margin], painted as the end of one
// sheet and the start of the next. Text before it stays put; text after it
// starts at the next sheet's first line.
//
// A paragraph splits BETWEEN LINES, the way Word's does, with Word's default
// widow/orphan control (never fewer than two lines on either side). A block
// that cannot split (a table, a picture, a shape, a signature line) moves
// whole, like a "keep together" paragraph, and one taller than a whole sheet
// runs across the gutter rather than vanishing.
//
// Deliberately NOT a layout engine: nothing here re-measures text, hyphenates
// or re-wraps. It places gaps against the real page geometry (pageSetup.js)
// that the exporter uses too, so the screen and the PDF break in nearly the
// same places.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DecorationSet, Decoration } from '@tiptap/pm/view';

export const paginationKey = new PluginKey('nexusPagination');

/** The gray gap drawn between two sheets, in layout px. */
export const SHEET_SPACE_PX = 28;

/** Word's default widow/orphan control: a split leaves at least this many lines on each side. */
export const MIN_LINES = 2;

/**
 * How much a margin must grow so its header or footer fits (Word pushes the
 * body down rather than letting the header run over it): the content sits
 * `pad` px into the margin and needs `gap` px of air before the text.
 */
export function marginGrowth(marginPx, pad, contentPx, gap = 6) {
  return Math.max(0, Math.round(pad + (contentPx || 0) + gap - marginPx));
}

// The gutter widget. `b` is one break ({ gap }), `n` the number of the sheet
// that ENDS at it, `info` what every band shows (geometry, header/footer
// HTML, page total). Everything inside is static, non-editable chrome.
function gutterDom(b, n, info) {
  const g = info.geometry;
  const total = Math.round(b.gap + g.mb + SHEET_SPACE_PX + g.mt);
  const root = document.createElement('div');
  root.className = 'doc-sheet-gutter';
  root.style.height = `${total}px`;
  const band = document.createElement('div');
  band.className = 'doc-sheet-band';
  band.style.height = `${total}px`;

  const foot = document.createElement('div');
  foot.className = 'doc-sheet-foot';
  foot.style.height = `${Math.round(b.gap + g.mb)}px`;
  foot.style.padding = `0 ${g.pr}px ${g.footPad ?? Math.round(g.mb * 0.38)}px ${g.pl}px`;
  foot.style.background = g.pageColor || '#fff';
  const footText = document.createElement('div');
  footText.className = 'doc-sheet-foot-text';
  footText.innerHTML = info.footerHtml || '';
  // Where Insert > Page Numbers put the number (bottom right by default).
  const where = info.pageNumbers || 'bottom-right';
  const pageNo = document.createElement('div');
  pageNo.className = `doc-sheet-pageno is-${where.split('-')[1] || 'right'}`;
  pageNo.textContent = `Page ${n} of ${info.total}`;
  foot.append(footText);
  if (where.startsWith('bottom')) foot.append(pageNo);

  const space = document.createElement('div');
  space.className = 'doc-sheet-space';
  space.style.height = `${SHEET_SPACE_PX}px`;

  const head = document.createElement('div');
  head.className = 'doc-sheet-head';
  head.style.height = `${Math.round(g.mt)}px`;
  head.style.padding = `${g.headPad ?? Math.round(g.mt * 0.38)}px ${g.pr}px 0 ${g.pl}px`;
  head.style.background = g.pageColor || '#fff';
  const headText = document.createElement('div');
  headText.className = 'doc-sheet-head-text';
  headText.innerHTML = info.headerHtml || '';
  head.append(headText);
  if (where.startsWith('top')) {
    const topNo = pageNo.cloneNode(true);
    topNo.textContent = `Page ${n + 1} of ${info.total}`;   // the sheet that STARTS under this band
    head.append(topNo);
  }

  band.append(foot, space, head);
  root.append(band);
  return root;
}

const EMPTY_INFO = { geometry: { mb: 0, mt: 0, pl: 0, pr: 0, pageColor: '' }, headerHtml: '', footerHtml: '', base: 0, total: 1, rev: 0 };

const buildDecorations = (doc, breaks, info) => {
  const decos = [];
  breaks.forEach((b, i) => {
    if (b.pos < 0 || b.pos > doc.content.size) return;
    const n = (info.base || 0) + i + 1;
    decos.push(Decoration.widget(b.pos, () => gutterDom(b, n, info), {
      // Before the cursor at this position, so typing there lands on the new
      // sheet; no marks, so the band never inherits bold from the text.
      side: -1, marks: [], ignoreSelection: true,
      key: `sheet-${i}-${Math.round(b.gap)}-${info.rev || 0}-${info.total}-${info.base || 0}-${info.pageNumbers || ''}`,
    }));
  });
  return DecorationSet.create(doc, decos);
};

export const Pagination = Extension.create({
  name: 'nexusPagination',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: paginationKey,
        state: {
          init: () => ({ breaks: [], info: EMPTY_INFO, deco: DecorationSet.empty }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(paginationKey);
            if (meta) {
              const breaks = meta.breaks || value.breaks;
              const info = meta.info || value.info;
              return { breaks, info, deco: buildDecorations(newState.doc, breaks, info) };
            }
            if (!tr.docChanged) return value;
            // The document moved under the old break positions. Map them
            // forward so the gaps do not jump while typing; the next
            // measurement replaces them properly.
            const breaks = value.breaks
              .map((b) => ({ ...b, pos: tr.mapping.map(b.pos, -1) }))
              .filter((b) => b.pos >= 0);
            return { breaks, info: value.info, deco: buildDecorations(newState.doc, breaks, value.info) };
          },
        },
        props: {
          decorations(state) { return paginationKey.getState(state)?.deco || DecorationSet.empty; },
        },
      }),
    ];
  },
});

/**
 * Where the sheet boundaries fall, given the editor's own laid-out blocks.
 *
 * `heights` are the NATURAL heights of the top-level blocks, in document order
 * and in layout pixels - natural meaning with any gutter this function
 * previously laid in already subtracted, otherwise each pass would stack
 * another gap on the last one and the document would walk down the screen.
 *
 * `linesOf(index)` returns the block's lines - [{ top, height }] in layout px
 * from the block's own top, in order - or null for a block that must not split.
 * It is only called for a block that straddles a boundary.
 *
 * Returns [{ index, gap, line }]: a new sheet starts before block `index`
 * (line null) or before `line` inside it, and `gap` is the room left under
 * the last line kept on the sheet before it.
 */
export function planBreaks(heights, sheetPx, firstSheetPx, linesOf = () => null, forced = () => false) {
  const sheet = Math.max(1, sheetPx);
  // The FIRST sheet can be shorter than the rest: a letterhead is drawn into
  // page 1's header, so the exporter gives page 1 a shorter text frame. The
  // editor has to reserve the same band or it fits more onto page 1 than the
  // PDF does - which is the "5 pages here, 6 in the preview" gap that survived
  // the 96dpi fix. Sagar, Sep 18.
  const first = Math.max(1, firstSheetPx || sheet);
  const out = [];
  let used = 0;
  let cap = first;
  // A sheet filled to the last pixel is done: the next block starts a fresh
  // one with no gap to lay in. (An unsplittable block taller than the sheet
  // spills across several - this advances past them too.)
  const settle = () => { while (used >= cap) { used -= cap; cap = sheet; } };
  heights.forEach((hRaw, index) => {
    const h = Math.max(0, hRaw || 0);
    // `forced(index)`: a page break marker sits right before this block.
    if (forced(index) && used > 0) { out.push({ index, gap: cap - used }); used = 0; cap = sheet; }
    if (h <= cap - used) { used += h; settle(); return; }

    const lines = linesOf(index);
    if (lines && lines.length) {
      // Split between lines. `k` is the first line not yet placed, `offset`
      // its distance from the block's top.
      let k = 0;
      let offset = 0;
      for (;;) {
        const remaining = h - offset;
        const room = cap - used;
        if (remaining <= room) { used += remaining; settle(); return; }
        let j = k;
        while (j < lines.length && lines[j].top + lines[j].height - offset <= room) j++;
        if (lines.length - j < MIN_LINES) j = lines.length - MIN_LINES;   // no orphan
        if (j - k < MIN_LINES) {
          // Too little fits for a clean split. Push the whole block onto a
          // fresh sheet when it fits one; otherwise it has nowhere to go, so
          // split as low as the room allows (one line is still better than a
          // paragraph running across the gutter).
          if (k === 0 && used > 0 && h <= cap) { out.push({ index, gap: room }); used = h; cap = sheet; settle(); return; }
          j = Math.max(k + 1, j);
          if (j >= lines.length) { used += remaining; settle(); return; }
        }
        out.push({ index, gap: room - (lines[j].top - offset), line: lines[j] });
        offset = lines[j].top;
        k = j;
        used = 0;
        cap = sheet;
      }
    }

    // A block that cannot split: `used > 0` keeps one already at the top of a
    // sheet where it is; `h <= cap` leaves an over-tall block alone, since
    // moving it would only push the same overflow onto the next sheet.
    if (used > 0 && h <= cap) {
      out.push({ index, gap: cap - used });
      used = 0;
      cap = sheet;
    }
    used += h;
    settle();
  });
  return out;
}

// ── Measuring the live DOM ───────────────────────────────────────────────────
// Blocks the editor must never cut: tables (a row split would be half a
// table), pictures, shapes, text boxes, signature lines, page-break markers.
const UNSPLITTABLE = /^(TABLE|IMG|FIGURE)$/;
const UNSPLITTABLE_CLASS = /\b(doc-shape|doc-textbox|doc-signature-block|doc-pagebreak|doc-image-wrap|doc-section-box)\b/;

const ATOM_SELECTOR = '.doc-image-wrap, .tpl-chip, .doc-bookmark, img';

/**
 * The lines of a block as the browser laid them out: [{ top, height,
 * clientTop, clientLeft }] in layout px from the block's top (client values
 * raw, for finding the document position later), or null for a block that
 * must not split. `zoom` is the canvas zoom the rects are scaled by.
 */
export function measureLines(el, zoom = 1) {
  if (!el || UNSPLITTABLE.test(el.tagName) || UNSPLITTABLE_CLASS.test(el.className || '')) return null;
  if (el.querySelector('table')) return null;
  const z = zoom || 1;
  const blockTop = el.getBoundingClientRect().top;
  const rects = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) if (r.height > 0) rects.push(r);
  }
  for (const atom of el.querySelectorAll(ATOM_SELECTOR)) {
    const r = atom.getBoundingClientRect();
    if (r.height > 0) rects.push(r);
  }
  if (!rects.length) return null;
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  for (const r of rects) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.top - last.clientTop) < 2) {
      last.bottom = Math.max(last.bottom, r.bottom);
      last.clientLeft = Math.min(last.clientLeft, r.left);
    } else {
      lines.push({ clientTop: r.top, clientLeft: r.left, bottom: r.bottom });
    }
  }
  // A gutter already laid into this block pushes the lines under it down; the
  // planner wants the NATURAL layout, so that height comes back off.
  const gutters = Array.from(el.querySelectorAll('.doc-sheet-gutter')).map((g) => g.getBoundingClientRect());
  const laidAbove = (clientTop) => gutters.reduce((sum, g) => (g.top < clientTop ? sum + g.height : sum), 0);
  return lines.map((l) => ({
    top: (l.clientTop - blockTop - laidAbove(l.clientTop)) / z,
    height: (l.bottom - l.clientTop) / z,
    clientTop: l.clientTop,
    clientLeft: l.clientLeft,
  }));
}

/**
 * The document position where `line` (from measureLines) starts: the first
 * character whose box sits on that line. Walks the block's text in order, so
 * it works for lines scrolled off screen (posAtCoords needs them visible).
 * null when the line starts with nothing a position can be read from.
 */
export function posAtLineStart(view, el, line) {
  const target = line.clientTop - 1;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.nodeValue ? node.nodeValue.length : 0;
    if (!len) continue;
    // Skip a node that ends above the line without reading every character.
    range.setStart(node, len - 1); range.setEnd(node, len);
    const lastRect = range.getClientRects()[0];
    if (lastRect && lastRect.bottom <= target) continue;
    for (let i = 0; i < len; i++) {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (!r || r.height === 0) continue;
      if (r.top >= target) {
        try { return view.posAtDOM(node, i); } catch { return null; }
      }
    }
  }
  for (const atom of el.querySelectorAll(ATOM_SELECTOR)) {
    const r = atom.getBoundingClientRect();
    if (r.height > 0 && r.top >= target) {
      try { return view.posAtDOM(atom.parentNode, Array.prototype.indexOf.call(atom.parentNode.childNodes, atom)); } catch { return null; }
    }
  }
  return null;
}
