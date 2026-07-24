import { Node } from '@tiptap/core';
import TiptapImage from '@tiptap/extension-image';

// ── Document Builder custom nodes (Phase 2) ──────────────────────────────────
// Merge-field vocabulary mirrors ESign.jsx's TemplateEditorModal (MERGE_TOKENS/
// FRIENDLY_MERGE) so the two editors feel like the same product — duplicated
// here (short const lists) rather than imported, to avoid reaching into
// another module's file for it.
export const MERGE_TOKENS = ['first_name', 'last_name', 'full_name', 'email', 'job_title',
  'department', 'start_date', 'salary', 'company', 'company_legal', 'company_address',
  'signatory', 'manager', 'today'];

export const FRIENDLY_MERGE = {
  first_name: 'First name', last_name: 'Last name', full_name: 'Full name',
  email: 'Email', job_title: 'Job title', department: 'Department',
  start_date: 'Start date', salary: 'Salary', company: 'Company',
  company_legal: 'Company legal name', company_address: 'Company address',
  signatory: 'Company signatory', manager: 'Manager', today: "Today's date",
};

// Inline, non-editable "{{token}}" chip — reuses the existing .tpl-chip CSS
// class (style.css) so it renders identically to E-Sign's merge chips.
export const MergeField = Node.create({
  name: 'mergeField',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { token: { default: null } };
  },

  parseHTML() {
    return [{ tag: 'span[data-merge-token]', getAttrs: el => ({ token: el.getAttribute('data-merge-token') }) }];
  },

  renderHTML({ node }) {
    return ['span', {
      class: 'tpl-chip',
      'data-merge-token': node.attrs.token,
      contenteditable: 'false',
    }, FRIENDLY_MERGE[node.attrs.token] || node.attrs.token];
  },
});

// Block, non-editable divider — visual-only for now; Phase 4's PDF export
// will honor it as an actual page boundary.
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div[data-page-break]' }];
  },

  renderHTML() {
    return ['div', { class: 'doc-pagebreak', 'data-page-break': '', contenteditable: 'false' }, 'Page Break'];
  },
});

// Sensible fixed insert sizes per shape type (Phase 8) — no post-insert
// resize, matching the project's existing "images aren't resizable either"
// stance rather than building a drag-resize interaction.
export const SHAPE_DEFAULTS = {
  rectangle: { width: 160, height: 100 },
  circle: { width: 120, height: 120 },
  line: { width: 200, height: 20 },
  triangle: { width: 120, height: 100 },
  arrow: { width: 180, height: 40 },
};

// ProseMirror's renderSpec creates DOM via plain document.createElement() by
// default — an <svg> made that way is an inert HTMLUnknownElement, not a real
// SVGElement, so it (and its children) never render (0 height, silently
// invisible). Prefixing a DOMOutputSpec tag with "<namespace-uri> tagname"
// makes renderSpec use createElementNS instead, and that namespace cascades
// to every nested child automatically. Used by DocShape's renderHTML (kept
// for clipboard/getHTML serialization only — the NodeView below governs live
// rendering and builds real SVG via createElementNS directly).
const SVG_NS = 'http://www.w3.org/2000/svg';

// Pure shape-geometry builder shared by renderHTML's DOMOutputSpec (static
// serialization) and the NodeView's imperative DOM build (live editing) — one
// source of truth for what each shape type looks like. Returns a flat list of
// [tag, attrs] pairs (no nesting needed, every shape is flat SVG primitives).
function shapeSvgSpec(shapeType, w, h, fillColor, strokeColor) {
  if (shapeType === 'circle') {
    return [['ellipse', { cx: w / 2, cy: h / 2, rx: (w - 4) / 2, ry: (h - 4) / 2, fill: fillColor, stroke: strokeColor, 'stroke-width': 2 }]];
  }
  if (shapeType === 'line') {
    return [['line', { x1: 4, y1: h / 2, x2: w - 4, y2: h / 2, stroke: strokeColor, 'stroke-width': 3 }]];
  }
  if (shapeType === 'triangle') {
    return [['polygon', { points: `${w / 2},4 ${w - 4},${h - 4} 4,${h - 4}`, fill: fillColor, stroke: strokeColor, 'stroke-width': 2 }]];
  }
  if (shapeType === 'arrow') {
    return [
      ['line', { x1: 4, y1: h / 2, x2: w - 16, y2: h / 2, stroke: strokeColor, 'stroke-width': 3 }],
      ['polygon', { points: `${w - 16},${h / 2 - 6} ${w - 2},${h / 2} ${w - 16},${h / 2 + 6}`, fill: strokeColor }],
    ];
  }
  return [['rect', { x: 2, y: 2, width: w - 4, height: h - 4, rx: 4, fill: fillColor, stroke: strokeColor, 'stroke-width': 2 }]];
}

function buildSvgElement(shapeType, w, h, fillColor, strokeColor) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  for (const [tag, attrs] of shapeSvgSpec(shapeType, w, h, fillColor, strokeColor)) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

// Word-style text-wrap modes shared by DocShape and DocTextbox (Phase 9).
// "Through" and "Top and Bottom" are deliberately not implemented — Through
// would need arbitrary contour paths we don't have (folds into Tight's
// bounding-box approximation), Top and Bottom forces its own line without
// side-wrap (folds into Inline's existing behavior).
export const WRAP_MODES = [
  { value: 'inline', label: 'In line with text' },
  { value: 'square', label: 'Square' },
  { value: 'tight', label: 'Tight' },
  { value: 'behind', label: 'Behind text' },
  { value: 'front', label: 'In front of text' },
];

// Applies the live CSS for a node's current wrapMode/x/y. Inline (default)
// is normal block flow — no positioning, not draggable. Square/Tight float
// left with a position:relative offset (so a drag can still nudge them
// without breaking float-based wrapping). Behind/Front are position:absolute,
// anchored to .doc-page (which gets position:relative in style.css) via x/y.
function applyWrapStyle(dom, attrs) {
  const { wrapMode, x = 0, y = 0, shapeType, rotation = 0 } = attrs;
  dom.style.position = '';
  dom.style.float = '';
  dom.style.left = '';
  dom.style.top = '';
  dom.style.zIndex = '';
  dom.style.pointerEvents = '';
  dom.style.shapeOutside = '';
  dom.style.margin = '';
  if (wrapMode === 'square' || wrapMode === 'tight') {
    dom.style.float = 'left';
    dom.style.position = 'relative';
    dom.style.left = `${x}px`;
    dom.style.top = `${y}px`;
    dom.style.margin = '4px 12px 4px 0';
    if (wrapMode === 'tight') {
      dom.style.shapeOutside = shapeType === 'circle' ? 'circle(50%)' : 'inset(0)';
    }
  } else if (wrapMode === 'behind' || wrapMode === 'front') {
    dom.style.position = 'absolute';
    dom.style.left = `${x}px`;
    dom.style.top = `${y}px`;
    dom.style.zIndex = wrapMode === 'front' ? '10' : '0';
    dom.style.pointerEvents = wrapMode === 'behind' ? 'none' : 'auto';
  }
  dom.classList.toggle('doc-draggable', wrapMode !== 'inline' && !!wrapMode);
  dom.style.transform = rotation ? `rotate(${rotation}deg)` : '';
}

// Creates the small drag-grip element and wires pointer-drag → live style
// feedback → commit as a real ProseMirror transaction on release. Shared by
// DocShape's and DocTextbox's NodeViews. `getAttrs`/`getPos`/`view` are read
// live (via closures into the NodeView's mutable state) rather than captured
// once, since the node's position can shift as the document above it edits.
function createDragHandle({ view, getPos, getAttrs }) {
  const handle = document.createElement('div');
  handle.className = 'doc-drag-handle';
  handle.setAttribute('data-drag-handle', '');
  handle.title = 'Drag to reposition';
  handle.textContent = '✥';

  let dragging = false;
  let startX = 0, startY = 0, baseX = 0, baseY = 0;
  let dom = null;

  handle.addEventListener('pointerdown', (e) => {
    const attrs = getAttrs();
    if (!attrs.wrapMode || attrs.wrapMode === 'inline') return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    dom = handle.parentElement;
    startX = e.clientX;
    startY = e.clientY;
    baseX = attrs.x || 0;
    baseY = attrs.y || 0;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging || !dom) return;
    const nx = baseX + (e.clientX - startX);
    const ny = baseY + (e.clientY - startY);
    dom.style.left = `${nx}px`;
    dom.style.top = `${ny}px`;
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    const nx = baseX + (e.clientX - startX);
    const ny = baseY + (e.clientY - startY);
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, x: nx, y: ny });
    view.dispatch(tr);
  }

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  return handle;
}

// Bottom-right resize grip — same pointer-drag → live style → commit-on-
// release shape as createDragHandle, adjusting width/height instead of x/y.
// Unlike the drag handle, this works in EVERY wrap mode (including inline),
// since resizing an inline shape/textbox/image doesn't require it to be
// position:relative/absolute the way repositioning does.
function createResizeHandle({ view, getPos, getAttrs, minW = 24, minH = 24 }) {
  const handle = document.createElement('div');
  handle.className = 'doc-resize-handle';
  handle.title = 'Drag to resize';

  let resizing = false;
  let startX = 0, startY = 0, baseW = 0, baseH = 0;
  let dom = null;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    dom = handle.parentElement;
    startX = e.clientX;
    startY = e.clientY;
    const attrs = getAttrs();
    baseW = attrs.width || 160;
    baseH = attrs.height || 100;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!resizing || !dom) return;
    const w = Math.max(minW, baseW + (e.clientX - startX));
    const h = Math.max(minH, baseH + (e.clientY - startY));
    dom.style.width = `${w}px`;
    dom.style.height = `${h}px`;
  });

  function endResize(e) {
    if (!resizing) return;
    resizing = false;
    const w = Math.max(minW, Math.round(baseW + (e.clientX - startX)));
    const h = Math.max(minH, Math.round(baseH + (e.clientY - startY)));
    const pos = getPos();
    if (typeof pos !== 'number') return;
    const node = view.state.doc.nodeAt(pos);
    if (!node) return;
    const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: w, height: h });
    view.dispatch(tr);
  }

  handle.addEventListener('pointerup', endResize);
  handle.addEventListener('pointercancel', endResize);

  return handle;
}

// Block, non-editable shape. Rendered live via a NodeView (Phase 9 — plain
// JS/DOM, no React NodeView) so it can support pointer-drag repositioning;
// renderHTML/parseHTML are kept only for clipboard copy/paste and getHTML()
// serialization, not for live editing. Arrow is a line + a small triangle
// polygon "head" (not an SVG <marker>) so multiple arrows never fight over a
// shared marker id. Backend export (doc_export.py) draws the same shapeType
// as real reportlab vector graphics for PDF, and rasterizes via Pillow for
// DOCX (python-docx has no vector-drawing API) — see that file for the split;
// export renders shapes/textboxes in document order, not at their floating
// x/y (documented scope trim, Phase 9).
export const DocShape = Node.create({
  name: 'docShape',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      shapeType: { default: 'rectangle' },
      width: { default: 160 },
      height: { default: 100 },
      fillColor: { default: '#dbeafe' },
      strokeColor: { default: '#2563eb' },
      x: { default: 0 },
      y: { default: 0 },
      wrapMode: { default: 'inline' },
      rotation: { default: 0 },
    };
  },

  parseHTML() {
    return [{
      tag: 'div[data-shape-type]',
      getAttrs: el => ({
        shapeType: el.getAttribute('data-shape-type') || 'rectangle',
        width: parseInt(el.getAttribute('data-width'), 10) || 160,
        height: parseInt(el.getAttribute('data-height'), 10) || 100,
        fillColor: el.getAttribute('data-fill') || '#dbeafe',
        strokeColor: el.getAttribute('data-stroke') || '#2563eb',
        x: parseInt(el.getAttribute('data-x'), 10) || 0,
        y: parseInt(el.getAttribute('data-y'), 10) || 0,
        wrapMode: el.getAttribute('data-wrap') || 'inline',
        rotation: parseInt(el.getAttribute('data-rotation'), 10) || 0,
      }),
    }];
  },

  renderHTML({ node }) {
    const { shapeType, width: w, height: h, fillColor, strokeColor, x, y, wrapMode } = node.attrs;
    return ['div', {
      class: 'doc-shape',
      'data-shape-type': shapeType, 'data-width': w, 'data-height': h,
      'data-fill': fillColor, 'data-stroke': strokeColor,
      'data-x': x, 'data-y': y, 'data-wrap': wrapMode,
      contenteditable: 'false', style: `width:${w}px;height:${h}px;`,
    }, [`${SVG_NS} svg`, { viewBox: `0 0 ${w} ${h}`, width: w, height: h }, ...shapeSvgSpec(shapeType, w, h, fillColor, strokeColor)]];
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      let currentNode = node;

      const dom = document.createElement('div');
      dom.className = 'doc-shape doc-floatable';
      dom.setAttribute('contenteditable', 'false');

      const svgHost = document.createElement('div');
      svgHost.className = 'doc-shape-svg-host';
      dom.appendChild(svgHost);

      const handle = createDragHandle({
        view, getPos, getAttrs: () => currentNode.attrs,
      });
      dom.appendChild(handle);
      const resizeHandle = createResizeHandle({
        view, getPos, getAttrs: () => currentNode.attrs, minW: 24, minH: 24,
      });
      dom.appendChild(resizeHandle);

      function render(attrs) {
        const { shapeType, width: w, height: h, fillColor, strokeColor } = attrs;
        dom.style.width = `${w}px`;
        dom.style.height = `${h}px`;
        svgHost.innerHTML = '';
        svgHost.appendChild(buildSvgElement(shapeType, w, h, fillColor, strokeColor));
        applyWrapStyle(dom, attrs);
      }

      render(currentNode.attrs);

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'docShape') return false;
          currentNode = updatedNode;
          render(updatedNode.attrs);
          return true;
        },
        // Only swallow events that originate on the drag/resize handles —
        // everything else (plain clicks) must fall through to ProseMirror's
        // normal node-selection/deletion handling, or selecting/deleting the
        // shape via the keyboard/toolbar would silently stop working.
        stopEvent(event) {
          return handle.contains(event.target) || resizeHandle.contains(event.target);
        },
      };
    };
  },
});

// Floating text box (Phase 9) — real nested editable rich text (content:
// 'paragraph+'), not a static leaf, so bold/italic/color/etc. all work
// inside it via the same schema as the body editor, with no separate editor
// instance. Uses the same drag/wrap mechanics as DocShape via a real
// ProseMirror contentDOM managed by the NodeView.
export const DocTextbox = Node.create({
  name: 'docTextbox',
  group: 'block',
  content: 'paragraph+',
  defining: true,

  addAttributes() {
    return {
      width: { default: 220 },
      height: { default: 120 },
      x: { default: 0 },
      y: { default: 0 },
      wrapMode: { default: 'inline' },
      rotation: { default: 0 },
      borderColor: { default: '#9ca3af' },
      fillColor: { default: 'transparent' },
    };
  },

  parseHTML() {
    return [{
      tag: 'div[data-textbox]',
      getAttrs: el => ({
        width: parseInt(el.getAttribute('data-width'), 10) || 220,
        height: parseInt(el.getAttribute('data-height'), 10) || 120,
        x: parseInt(el.getAttribute('data-x'), 10) || 0,
        y: parseInt(el.getAttribute('data-y'), 10) || 0,
        wrapMode: el.getAttribute('data-wrap') || 'inline',
        rotation: parseInt(el.getAttribute('data-rotation'), 10) || 0,
        borderColor: el.getAttribute('data-border') || '#9ca3af',
        fillColor: el.getAttribute('data-fill') || 'transparent',
      }),
    }];
  },

  renderHTML({ node }) {
    const { width: w, height: h, x, y, wrapMode, borderColor, fillColor } = node.attrs;
    return ['div', {
      class: 'doc-textbox',
      'data-textbox': '', 'data-width': w, 'data-height': h,
      'data-x': x, 'data-y': y, 'data-wrap': wrapMode,
      'data-border': borderColor, 'data-fill': fillColor,
      style: `width:${w}px;height:${h}px;border-color:${borderColor};background:${fillColor};`,
    }, 0];
  },

  addNodeView() {
    return ({ node, getPos, view }) => {
      let currentNode = node;

      const dom = document.createElement('div');
      dom.className = 'doc-textbox doc-floatable';

      const contentDOM = document.createElement('div');
      contentDOM.className = 'doc-textbox-content';
      dom.appendChild(contentDOM);

      const handle = createDragHandle({
        view, getPos, getAttrs: () => currentNode.attrs,
      });
      dom.appendChild(handle);
      const resizeHandle = createResizeHandle({
        view, getPos, getAttrs: () => currentNode.attrs, minW: 60, minH: 40,
      });
      dom.appendChild(resizeHandle);

      function render(attrs) {
        dom.style.width = `${attrs.width}px`;
        dom.style.height = `${attrs.height}px`;
        dom.style.borderColor = attrs.borderColor || '#9ca3af';
        dom.style.background = attrs.fillColor || 'transparent';
        applyWrapStyle(dom, attrs);
      }

      render(currentNode.attrs);

      return {
        dom,
        contentDOM,
        update(updatedNode) {
          if (updatedNode.type.name !== 'docTextbox') return false;
          currentNode = updatedNode;
          render(updatedNode.attrs);
          return true;
        },
        stopEvent(event) {
          return handle.contains(event.target) || resizeHandle.contains(event.target);
        },
      };
    };
  },
});

// Word-parity image: resize (drag handle), reposition + text wrap (same
// mechanics as DocShape/DocTextbox — square/tight/behind/front/inline), and
// a real `alt` attribute exposed in the UI (stock @tiptap/extension-image
// already has the `alt`/`title` attrs, just no way to set them after
// insert). Extends Image rather than replacing it, so the inherited
// `setImage` command keeps working unchanged for the existing upload/paste
// insert path.
export const ResizableImage = TiptapImage.extend({
  name: 'image',

  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null },
      height: { default: null },
      x: { default: 0 },
      y: { default: 0 },
      wrapMode: { default: 'inline' },
      rotation: { default: 0 },
    };
  },

  addNodeView() {
    return ({ node, view, getPos }) => {
      let currentNode = node;

      const dom = document.createElement('span');
      dom.className = 'doc-image-wrap doc-floatable';
      dom.setAttribute('contenteditable', 'false');

      const img = document.createElement('img');
      dom.appendChild(img);

      const handle = createDragHandle({ view, getPos, getAttrs: () => currentNode.attrs });
      dom.appendChild(handle);
      const resizeHandle = createResizeHandle({ view, getPos, getAttrs: () => currentNode.attrs, minW: 30, minH: 30 });
      dom.appendChild(resizeHandle);

      function render(attrs) {
        img.src = attrs.src || '';
        img.alt = attrs.alt || '';
        if (attrs.title) img.title = attrs.title;
        if (attrs.width) { dom.style.width = `${attrs.width}px`; img.style.width = '100%'; }
        else { dom.style.width = ''; img.style.width = ''; }
        if (attrs.height) { dom.style.height = `${attrs.height}px`; img.style.height = '100%'; }
        else { dom.style.height = ''; img.style.height = ''; }
        applyWrapStyle(dom, attrs);
      }

      render(currentNode.attrs);

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type.name !== 'image') return false;
          currentNode = updatedNode;
          render(updatedNode.attrs);
          return true;
        },
        stopEvent(event) {
          return handle.contains(event.target) || resizeHandle.contains(event.target);
        },
      };
    };
  },
});
