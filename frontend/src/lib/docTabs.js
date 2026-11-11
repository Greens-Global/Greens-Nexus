// Word's tabs and tab stops (Neil, 11/11/2026: "Make sure it's fully word
// compatible"). Before this, a tab became four spaces on import and the Tab
// key had nothing to insert.
//
// A paragraph (or heading) carries `tabStops`: [{ pos, align }] - `pos` in
// points from the LEFT MARGIN (Word's own measure, w:tab w:pos / 20), `align`
// left | center | right | decimal. Past the last stop, Word's default stops
// fall every half inch.
//
// A tab is an inline `tab` node. After every render it is laid out like
// Word's: its width runs from where it starts to the next stop - less the
// text after it for a right stop, half of it for a center stop, the part
// before the decimal point for a decimal stop. The node view ignores its own
// width changes, so ProseMirror never redraws for them.
import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

export const TAB_ALIGNS = ['left', 'center', 'right', 'decimal'];
export const DEFAULT_TAB_PT = 36;   // Word's default stops: every 0.5 inch
const PT_TO_PX = 96 / 72;

// The stops a paragraph stores, cleaned: numbers, known alignments, sorted,
// no two within half a point of each other.
export function cleanTabStops(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    const pos = Math.round(Number(s?.pos) * 2) / 2;
    if (!Number.isFinite(pos) || pos <= 0 || pos > 1584) continue;   // 22 inches, Word's own limit
    const align = TAB_ALIGNS.includes(s?.align) ? s.align : 'left';
    if (out.some((o) => Math.abs(o.pos - pos) < 0.5)) continue;
    out.push({ pos, align });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

export const TAB_STOPS_ATTR = {
  tabStops: {
    default: null,
    parseHTML: (el) => {
      try { const v = cleanTabStops(JSON.parse(el.getAttribute('data-tab-stops') || 'null')); return v.length ? v : null; } catch { return null; }
    },
    renderHTML: (attrs) => {
      const v = cleanTabStops(attrs.tabStops);
      return v.length ? { 'data-tab-stops': JSON.stringify(v) } : {};
    },
  },
};

// Where the tab that starts at `x` (px from the margin) ends: the first stop
// past it, else the next default stop.
export function nextStop(x, stops) {
  const custom = cleanTabStops(stops).find((s) => s.pos * PT_TO_PX > x + 0.5);
  if (custom) return { px: custom.pos * PT_TO_PX, align: custom.align };
  const step = DEFAULT_TAB_PT * PT_TO_PX;
  return { px: (Math.floor((x + 0.5) / step) + 1) * step, align: 'left' };
}

// The width of the text after a tab, up to the next tab or the end of the
// block (and, for a decimal stop, up to its first '.').
function segmentAfter(tab, block, scale, decimal) {
  const range = document.createRange();
  range.setStartAfter(tab);
  let end = null;
  for (let n = tab.nextSibling; n; n = n.nextSibling) { if (n.nodeType === 1 && n.classList?.contains('doc-tab')) { end = n; break; } }
  if (end) range.setEndBefore(end); else range.setEnd(block, block.childNodes.length);
  if (decimal) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!range.intersectsNode(t)) continue;
      const i = t.textContent.indexOf('.');
      if (i >= 0) { range.setEnd(t, i); break; }
    }
  }
  const rects = range.getClientRects();
  return rects.length ? rects[0].width / scale : 0;
}

export function layoutTabs(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const tabs = root.querySelectorAll('.doc-tab');
  if (!tabs.length) return;
  const rect = root.getBoundingClientRect();
  if (!rect.width) return;   // not laid out (a test, a hidden page)
  const scale = root.offsetWidth ? rect.width / root.offsetWidth : 1;   // CSS zoom on an ancestor
  const pad = parseFloat(getComputedStyle(root).paddingLeft) || 0;
  const origin = rect.left + pad * scale;
  for (const tab of tabs) {
    tab.style.width = '0px';
    const block = tab.closest('p, h1, h2, h3, h4, h5, h6, li') || root;
    let stops = [];
    try { stops = JSON.parse(block.getAttribute('data-tab-stops') || '[]'); } catch { stops = []; }
    const x = (tab.getBoundingClientRect().left - origin) / scale;
    let stop = nextStop(x, stops);
    let width = stop.px - x;
    if (stop.align !== 'left') {
      const seg = segmentAfter(tab, block, scale, stop.align === 'decimal');
      width -= stop.align === 'center' ? seg / 2 : seg;
    }
    // A tab always moves the text on; too little room goes to the next stop.
    if (width < 2) { stop = nextStop(stop.px, stops); width = Math.max(2, stop.px - x); }
    tab.style.width = `${Math.round(width * 100) / 100}px`;
  }
}

export const Tab = Node.create({
  name: 'tab',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'span[data-tab]' }, { tag: 'span.doc-tab' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'doc-tab', 'data-tab': '' }), ' '];
  },

  renderText() { return '\t'; },

  addNodeView() {
    return () => {
      const dom = document.createElement('span');
      dom.className = 'doc-tab';
      dom.setAttribute('data-tab', '');
      dom.contentEditable = 'false';
      dom.textContent = ' ';
      return { dom, ignoreMutation: () => true };
    };
  },

  // Tab inserts a tab, as in Word - after the list (sink a list item) and
  // the table (next cell) have had their turn, which is why this runs last.
  priority: 10,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (!this.editor.isEditable) return false;
        if (this.editor.isActive('table')) return false;
        return this.editor.commands.insertContent({ type: 'tab' });
      },
    };
  },

  addProseMirrorPlugins() {
    let raf = 0;
    const schedule = (view) => {
      if (typeof requestAnimationFrame !== 'function') return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => layoutTabs(view.dom));
    };
    return [new Plugin({
      view: (view) => {
        schedule(view);
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule(view)) : null;
        ro?.observe(view.dom);
        return { update: (v) => schedule(v), destroy: () => { cancelAnimationFrame(raf); ro?.disconnect(); } };
      },
    })];
  },
});
