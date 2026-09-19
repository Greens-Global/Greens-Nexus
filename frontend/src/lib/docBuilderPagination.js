// Visible page breaks in the editor canvas (Sagar, Sep 18: "why don't you
// break the pages, it's showing a single long page only for the Editor also").
//
// The canvas is one continuous ProseMirror document and stays that way - that
// is what keeps typing, undo, selection and copy/paste working across the whole
// document. What changes is where the blocks SIT: any top-level block that
// would straddle a sheet boundary is pushed down onto the next sheet with a
// margin, and the gap it leaves is painted as the page gutter.
//
// This is block-granular pagination, the same rule Word applies to a
// "keep with next" paragraph: a block moves whole rather than splitting across
// the boundary. A paragraph taller than a whole sheet is left alone - it has
// nowhere to move to - so it runs across the gutter instead of vanishing.
//
// Deliberately NOT a layout engine: nothing here re-measures text, hyphenates,
// or splits a paragraph mid-line. It positions blocks against the real page
// geometry (see textFlowPx in pageSetup.js) that the exporter uses too.
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DecorationSet, Decoration } from '@tiptap/pm/view';

export const paginationKey = new PluginKey('nexusPagination');

const buildDecorations = (doc, breaks) => {
  const decos = [];
  for (const b of breaks) {
    if (b.pos < 0 || b.pos >= doc.content.size) continue;
    const node = doc.nodeAt(b.pos);
    if (!node) continue;
    decos.push(Decoration.node(b.pos, b.pos + node.nodeSize, {
      class: 'doc-sheet-start',
      // The custom property drives the gutter band in style.css; the margin
      // is what actually moves the block.
      style: `margin-top:${Math.round(b.gap)}px;--doc-sheet-gap:${Math.round(b.gap)}px`,
    }));
  }
  return DecorationSet.create(doc, decos);
};

export const Pagination = Extension.create({
  name: 'nexusPagination',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: paginationKey,
        state: {
          init: () => ({ breaks: [], deco: DecorationSet.empty }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(paginationKey);
            if (meta) return { breaks: meta.breaks, deco: buildDecorations(newState.doc, meta.breaks) };
            if (!tr.docChanged) return value;
            // The document moved under the old break positions. Map them
            // forward so the gaps do not jump while typing; the next
            // measurement replaces them properly.
            const breaks = value.breaks
              .map((b) => ({ ...b, pos: tr.mapping.map(b.pos, -1) }))
              .filter((b) => b.pos >= 0);
            return { breaks, deco: buildDecorations(newState.doc, breaks) };
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
 * and in layout pixels - natural meaning with any gap this function previously
 * introduced already subtracted, otherwise each pass would stack another gap on
 * the last one and the document would walk down the screen.
 *
 * Returns [{ index, gap }] - the block that starts each new sheet and how far
 * it has to move to get there.
 */
export function planBreaks(heights, sheetPx, firstSheetPx) {
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
  heights.forEach((hRaw, index) => {
    const h = Math.max(0, hRaw || 0);
    const room = cap - used;
    // `used > 0` keeps a block that already sits at the top of a sheet where it
    // is; `h <= cap` leaves an over-tall block alone, since moving it would
    // only push the same overflow onto the next sheet.
    if (h > room && used > 0 && h <= cap) {
      out.push({ index, gap: room });
      used = 0;
      cap = sheet;
    }
    used += h;
    // A block taller than the sheet spills across several - advance past them.
    while (used >= cap) { used -= cap; cap = sheet; }
  });
  return out;
}
