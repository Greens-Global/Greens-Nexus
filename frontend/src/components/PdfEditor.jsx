import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, CheckCircle, Loader2, FileText, MousePointer2, Type, PenTool, Highlighter,
  Square, Circle, Minus, MoveUpRight, Image as ImageIcon, Eraser, EyeOff,
  Undo2, Redo2, ZoomIn, ZoomOut, Maximize, RotateCcw, RotateCw, Trash2,
  CopyPlus, FilePlus, Layers, TextCursorInput, Bold, Italic,
} from 'lucide-react';
import { docxToPdf, isDocx } from '../lib/docx2pdf';

// ── In-browser PDF editor ──────────────────────────────────────────────────────
// Renders pages with pdfjs (same worker pattern as PdfDoc in ESign.jsx — bytes
// in, never blob: fetches) and bakes every edit into brand-new PDF bytes with
// pdf-lib on save. Overlay coordinates are TOP-LEFT normalized (0..1), the same
// convention as the E-Sign field placer; bake converts to pdf-lib's
// bottom-left-origin user space per page, honouring page /Rotate.
//
// Elements (annotations) live in React state; pages are an ordered list of
// {source doc, page index, extra rotation} so reorder / rotate / delete /
// duplicate / blank / merge are all just list operations until bake time.

const RENDER_SCALE = 1.6;
const SEL = '#3b82f6'; // selection chrome color

const TOOL_DEFS = [
  ['select',    MousePointer2, 'Select — drag to move, corner to resize, Delete to remove'],
  ['edittext',  TextCursorInput, 'Edit text — click a line to rewrite it; click an edited block to change it again, drag to move it'],
  ['text',      Type,          'Text — click the page to add a text box'],
  ['pen',       PenTool,       'Pen — draw freehand'],
  ['highlight', Highlighter,   'Highlighter — thick translucent stroke'],
  ['rect',      Square,        'Rectangle'],
  ['ellipse',   Circle,        'Ellipse'],
  ['line',      Minus,         'Line'],
  ['arrow',     MoveUpRight,   'Arrow'],
  ['image',     ImageIcon,     'Image — insert a PNG or JPG'],
  ['whiteout',  Eraser,        'Whiteout — cover content with white'],
  ['redact',    EyeOff,        'Redact — cover content with black (a visual cover, not true removal)'],
];
const SWATCHES = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#ffffff'];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 32, 48];
const STROKES = [1, 1.5, 2, 3, 5, 8];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const hexRgb = (hex) => {
  const n = parseInt((hex || '#111827').slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};
// pdf-lib standard fonts are WinAnsi-only — swap smart punctuation, drop the rest.
const winAnsi = (s) => String(s)
  .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
  .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
  .replace(/[^\x00-\xFF]/g, '?');

const rotOf = (pg) => (((pg.baseRot || 0) + (pg.rot || 0)) % 360 + 360) % 360;
const dispDims = (pg) => {
  const R = rotOf(pg);
  return (R === 90 || R === 270) ? { w: pg.hu, h: pg.wu, R } : { w: pg.wu, h: pg.hu, R };
};

// User space (bottom-left origin, unrotated) → display points (top-left origin,
// /Rotate applied). Exact inverse of bake's mapPt, quadrant by quadrant.
const u2d = (pg, xu, yu) => {
  const R = rotOf(pg), Wu = pg.wu, Hu = pg.hu, X = xu - (pg.ox || 0), Y = yu - (pg.oy || 0);
  if (R === 90) return { x: Y, y: X };
  if (R === 180) return { x: Wu - X, y: Y };
  if (R === 270) return { x: Hu - Y, y: Wu - X };
  return { x: X, y: Hu - Y };
};
const lineBox = (pg, L) => {
  const a = u2d(pg, L.x0, L.y0), b = u2d(pg, L.x1, L.y1);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
};

// Text-element font styling — mirrored between preview (CSS) and bake (pdf-lib
// standard fonts), so what you type is what the saved PDF shows.
const famOf = (el) => el.mono ? '"Courier New",Courier,monospace'
  : el.serif ? '"Times New Roman",Times,serif' : 'Helvetica,Arial,sans-serif';
const FONT_NAMES = {
  h: 'Helvetica', hb: 'HelveticaBold', hi: 'HelveticaOblique', hbi: 'HelveticaBoldOblique',
  t: 'TimesRoman', tb: 'TimesRomanBold', ti: 'TimesRomanItalic', tbi: 'TimesRomanBoldItalic',
  c: 'Courier', cb: 'CourierBold', ci: 'CourierOblique', cbi: 'CourierBoldOblique',
};
const fkey = (el) => (el.mono ? 'c' : el.serif ? 't' : 'h') + (el.bold ? 'b' : '') + (el.italic ? 'i' : '');
let _mctx = null; // canvas 2d context for real text measurement (same font as preview)
const measureW = (el, text) => {
  if (!_mctx) _mctx = document.createElement('canvas').getContext('2d');
  _mctx.font = `${el.italic ? 'italic ' : ''}${el.bold ? '700 ' : ''}${el.fontSize}px ${famOf(el)}`;
  return _mctx.measureText(text).width;
};

// Turn pdfjs text items into editable LINES (user-space bboxes + merged text).
// Runs are clustered by their baseline (projected on the item's up-axis), so it
// also works on pages whose content is drawn rotated to match a /Rotate.
function buildLines(tc, pdfPage) {
  const styles = tc.styles || {};
  const runs = [];
  for (const it of tc.items || []) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]) || 10;
    const st = styles[it.fontName] || {};
    const asc = st.ascent || 0.8, desc = st.descent || -0.2;
    const dl = Math.hypot(t[0], t[1]) || 1, ul = Math.hypot(t[2], t[3]) || 1;
    const dx = t[0] / dl, dy = t[1] / dl, ux = t[2] / ul, uy = t[3] / ul;
    const w = it.width || it.str.length * size * 0.5;
    const cs = [0, 1].flatMap(k => [desc, asc].map(v => [
      t[4] + dx * w * k + ux * v * size, t[5] + dy * w * k + uy * v * size]));
    let fname = '';
    try { fname = String(pdfPage.commonObjs.get(it.fontName)?.name || ''); } catch { /* font not resolved yet */ }
    const pos = t[4] * dx + t[5] * dy;
    runs.push({
      x0: Math.min(...cs.map(c => c[0])), y0: Math.min(...cs.map(c => c[1])),
      x1: Math.max(...cs.map(c => c[0])), y1: Math.max(...cs.map(c => c[1])),
      key: t[4] * ux + t[5] * uy, pos, endPos: pos + w, str: it.str, size,
      bold: /bold|black|heavy|semi|demi/i.test(fname), italic: /italic|oblique/i.test(fname),
      serif: /^serif/.test(st.fontFamily || ''), mono: /mono/.test(st.fontFamily || ''),
    });
  }
  runs.sort((a, b) => b.key - a.key || a.pos - b.pos);
  const lines = [];
  for (const r of runs) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.key - r.key) < Math.max(L.size, r.size) * 0.45) {
      const gap = r.pos - L.endPos;
      L.text += (gap > r.size * 0.18 && !/\s$/.test(L.text) && !/^\s/.test(r.str) ? ' ' : '') + r.str;
      L.x0 = Math.min(L.x0, r.x0); L.y0 = Math.min(L.y0, r.y0);
      L.x1 = Math.max(L.x1, r.x1); L.y1 = Math.max(L.y1, r.y1);
      L.endPos = Math.max(L.endPos, r.endPos);
      L.size = Math.max(L.size, r.size);
    } else lines.push({ ...r, text: r.str });
  }
  return lines;
}

// Cluster consecutive lines into PARAGRAPH blocks (Acrobat-style edit units):
// same font size, horizontally overlapping, and a normal line pitch. Yields
// {x0,y0,x1,y1, text (unwrapped), size, lh (pitch ratio), bold/italic/serif/mono}.
function clusterParas(lines) {
  const paras = [];
  for (const L of lines) {
    const P = paras[paras.length - 1];
    const last = P && P.lines[P.lines.length - 1];
    const pitch = last ? last.key - L.key : 0;
    const sameSize = last && Math.abs(last.size - L.size) < Math.max(1, L.size * 0.16);
    const sameStyle = last && last.bold === L.bold && last.serif === L.serif;
    const hOverlap = last && Math.min(last.x1, L.x1) - Math.max(last.x0, L.x0) > -2;
    if (last && sameSize && sameStyle && hOverlap && pitch > 0 && pitch < L.size * 1.9) {
      P.lines.push(L);
      P.x0 = Math.min(P.x0, L.x0); P.y0 = Math.min(P.y0, L.y0);
      P.x1 = Math.max(P.x1, L.x1); P.y1 = Math.max(P.y1, L.y1);
    } else {
      paras.push({ lines: [L], x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y1,
                   size: L.size, bold: L.bold, italic: L.italic, serif: L.serif, mono: L.mono });
    }
  }
  for (const P of paras) {
    P.text = P.lines.map(l => l.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
    if (P.lines.length > 1) {
      const pitches = P.lines.slice(1).map((l, i) => P.lines[i].key - l.key);
      P.lh = Math.min(2, Math.max(1.05, (pitches.reduce((a, b) => a + b, 0) / pitches.length) / P.size));
    } else P.lh = 1.25;
  }
  return paras;
}

// Layout a text element's lines: block elements (blockW set) word-wrap each
// hard line to the block width with real measurement; plain ones just split.
function layoutLines(el) {
  const segs = String(el.text || '').split('\n');
  if (!el.blockW) return segs;
  const out = [];
  for (const seg of segs) {
    const words = seg.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (cur && measureW(el, t) > el.blockW) { out.push(cur); cur = w; }
      else cur = t;
    }
    out.push(cur);
  }
  return out;
}

// Rotating a page re-maps its overlay elements so they stay glued to the same
// spot on the (now rotated) content. dir 1 = 90° clockwise, -1 = counter.
// Text and images additionally accumulate `rot` — their CONTENT must rotate
// with the page (a box swap alone would leave text running across its own
// white cover and squeeze bitmaps into a swapped box).
const rotN = (r) => ((r || 0) % 360 + 360) % 360;
// Rotate an offset vector clockwise (display space, y down) by 0/90/180/270.
const rotOff = (u, v, r) =>
  r === 90 ? { x: -v, y: u } : r === 180 ? { x: -u, y: -v } : r === 270 ? { x: v, y: -u } : { x: u, y: v };
function rotateEls(els, pageId, dir) {
  const mp = dir === 1 ? (p) => ({ x: 1 - p.y, y: p.x }) : (p) => ({ x: p.y, y: 1 - p.x });
  const mb = dir === 1 ? (b) => ({ x: 1 - b.y - b.h, y: b.x, w: b.h, h: b.w })
                       : (b) => ({ x: b.y, y: 1 - b.x - b.w, w: b.h, h: b.w });
  const spin = (el) => rotN((el.rot || 0) + (dir === 1 ? 90 : 270));
  return els.map(el => {
    if (el.pageId !== pageId) return el;
    if (el.points) return { ...el, points: el.points.map(mp) };
    if (el.x1 !== undefined) {
      const a = mp({ x: el.x1, y: el.y1 }), b = mp({ x: el.x2, y: el.y2 });
      return { ...el, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
    if (el.type === 'text') {
      // The anchor (text box top-left) maps as a point; rendering rotates the
      // glyphs about that anchor by `rot`, so the ink lands exactly where the
      // original line now lies.
      const p = mp({ x: el.x, y: el.y });
      return { ...el, x: p.x, y: p.y, rot: spin(el), ...(el.bg ? { bg: mb(el.bg) } : {}) };
    }
    if (el.type === 'image') return { ...el, ...mb(el), rot: spin(el) };
    return { ...el, ...mb(el) }; // rects/ellipses/covers are symmetric under the box swap
  });
}

const textLines = (el) => String(el.text || '').split('\n');
const arrowHead = (x1, y1, x2, y2, w) => {
  const len = Math.max(9, w * 3.4), ang = Math.atan2(y2 - y1, x2 - x1), spread = 0.46;
  return [
    { x: x2 - len * Math.cos(ang - spread), y: y2 - len * Math.sin(ang - spread) },
    { x: x2 - len * Math.cos(ang + spread), y: y2 - len * Math.sin(ang + spread) },
  ];
};

// Element bounding box in display points (for selection chrome + hit rects).
function bboxOf(el, W, H) {
  if (el.points) {
    const xs = el.points.map(p => p.x * W), ys = el.points.map(p => p.y * H);
    const pad = (el.w || 2) / 2 + 2;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (el.x1 !== undefined) {
    const x = Math.min(el.x1, el.x2) * W, y = Math.min(el.y1, el.y2) * H;
    return { x: x - 4, y: y - 4, w: Math.abs(el.x2 - el.x1) * W + 8, h: Math.abs(el.y2 - el.y1) * H + 8 };
  }
  if (el.type === 'text') {
    const fs = el.fontSize, lines = layoutLines(el), lh = el.lh || 1.25;
    const w = el.blockW || Math.max(30, ...lines.map(l => measureW(el, l))) + 6;
    return { x: el.x * W, y: el.y * H, w, h: Math.max(1, lines.length) * fs * lh + 4 };
  }
  return { x: el.x * W, y: el.y * H, w: el.w * W, h: el.h * H };
}

export function PdfEditor({ file, url, fileName, onSave, onClose, toastErr }) {
  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState([]);          // [{id, src, idx, wu, hu, ox, oy, baseRot, rot} | {id, blank:true, ...}]
  const [elements, setElements] = useState([]);    // annotations, array order = z-order
  const [tool, setTool] = useState('select');
  const [color, setColor] = useState('#111827');
  const [strokeW, setStrokeW] = useState(2);
  const [fontSize, setFontSize] = useState(14);
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null); // text element being typed into
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [draft, setDraft] = useState(null);        // in-progress drawing preview
  const [pendingImg, setPendingImg] = useState(null);
  const [, setTick] = useState(0);                 // bump when the render cache gains a page

  const sourcesRef = useRef([]);   // Uint8Array per source doc (original + merged)
  const docsRef = useRef([]);      // pdfjs document handles, same indexing
  const pdfjsRef = useRef(null);
  const cacheRef = useRef(new Map());  // `${src}:${idx}:${rot}` -> dataUrl
  const linesRef = useRef(new Map());  // `${src}:${idx}` -> editable text lines
  const idRef = useRef(0);
  const stateRef = useRef({ pages: [], elements: [] });
  const dragRef = useRef(null);    // select-tool move/resize drag
  const drawRef = useRef(null);    // draw-tool in-progress stroke/shape
  const editSnapRef = useRef(null);
  const dragPageIdx = useRef(null); // thumbnail reorder
  const pageRefs = useRef({});
  const imgInputRef = useRef(null);
  const mergeInputRef = useRef(null);
  stateRef.current = { pages, elements };
  const stacksRef = useRef({ u: [], r: [] }); // mirrors for undo/redo (updaters must stay pure)
  stacksRef.current = { u: undoStack, r: redoStack };

  const nid = (p) => `${p}${++idRef.current}`;
  const takeSnap = () => ({ pages: stateRef.current.pages, elements: stateRef.current.elements });
  const pushSnapshot = (snap) => { setUndoStack(s => [...s.slice(-79), snap]); setRedoStack([]); };

  // ── Load the document (bytes → pdfjs; keep bytes for pdf-lib) ───────────────
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const buf = file ? await file.arrayBuffer() : await (await fetch(url)).arrayBuffer();
        const bytes = new Uint8Array(buf);
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjsRef.current = pdfjs;
        // pdfjs transfers the buffer to its worker (detaching it) — hand it a
        // copy so the original bytes stay intact for the pdf-lib bake.
        const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        if (!live) return;
        sourcesRef.current = [bytes];
        docsRef.current = [doc];
        const pgs = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i);
          pgs.push({ id: nid('pg'), src: 0, idx: i - 1, wu: p.view[2] - p.view[0], hu: p.view[3] - p.view[1],
                     ox: p.view[0], oy: p.view[1], baseRot: p.rotate || 0, rot: 0 });
        }
        if (!live) return;
        setPages(pgs); setLoading(false);
      } catch (e) {
        if (!live) return;
        toastErr(e?.message || 'Could not open the PDF.'); onClose();
      }
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render page bitmaps on demand (cached per source/page/rotation) ─────────
  useEffect(() => {
    let live = true;
    (async () => {
      for (const pg of pages) {
        if (pg.blank) continue;
        const key = `${pg.src}:${pg.idx}:${rotOf(pg)}`;
        if (cacheRef.current.has(key)) continue;
        try {
          const doc = docsRef.current[pg.src]; if (!doc) continue;
          const p = await doc.getPage(pg.idx + 1);
          const vp = p.getViewport({ scale: RENDER_SCALE, rotation: rotOf(pg) });
          const canvas = document.createElement('canvas');
          canvas.width = vp.width; canvas.height = vp.height;
          await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
          if (!live) return;
          cacheRef.current.set(key, canvas.toDataURL());
        } catch { if (live) cacheRef.current.set(key, ''); }
        if (live) setTick(t => t + 1);
      }
    })();
    return () => { live = false; };
  }, [pages]);

  // ── Extract editable text lines (lazy, on entering Edit-text mode) ──────────
  useEffect(() => {
    if (tool !== 'edittext') return;
    let live = true;
    (async () => {
      setExtracting(true);
      for (const pg of stateRef.current.pages) {
        if (pg.blank) continue;
        const key = `${pg.src}:${pg.idx}`;
        if (linesRef.current.has(key)) continue;
        try {
          const doc = docsRef.current[pg.src]; if (!doc) continue;
          const p = await doc.getPage(pg.idx + 1);
          const tc = await p.getTextContent();
          if (!live) return;
          linesRef.current.set(key, clusterParas(buildLines(tc, p)));
        } catch { if (live) linesRef.current.set(key, []); }
        if (live) setTick(t => t + 1);
      }
      if (live) setExtracting(false);
    })();
    return () => { live = false; };
  }, [tool, pages]);

  // ── History ─────────────────────────────────────────────────────────────────
  // No side effects inside state updaters — StrictMode double-invokes them,
  // which was duplicating stack entries in dev. Read via refs, set plainly.
  const undo = useCallback(() => {
    const { u } = stacksRef.current;
    if (!u.length) return;
    const last = u[u.length - 1];
    const cur = { pages: stateRef.current.pages, elements: stateRef.current.elements };
    setUndoStack(u.slice(0, -1));
    setRedoStack(r => [...r, cur]);
    setPages(last.pages); setElements(last.elements); setSelectedId(null); setEditingId(null);
  }, []);
  const redo = useCallback(() => {
    const { r } = stacksRef.current;
    if (!r.length) return;
    const last = r[r.length - 1];
    const cur = { pages: stateRef.current.pages, elements: stateRef.current.elements };
    setRedoStack(r.slice(0, -1));
    setUndoStack(s => [...s, cur]);
    setPages(last.pages); setElements(last.elements); setSelectedId(null); setEditingId(null);
  }, []);

  const deleteSelected = useCallback(() => {
    const id = selectedId; if (!id) return;
    pushSnapshot(takeSnap());
    setElements(es => es.filter(e => e.id !== id));
    setSelectedId(null);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); deleteSelected(); }
      else if (e.key === 'Escape') { setSelectedId(null); setPendingImg(null); if (tool !== 'select') setTool('select'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, deleteSelected, selectedId, tool]);

  // ── Select-tool drag (move / resize / line endpoints) ───────────────────────
  const onDragMove = useCallback((e) => {
    const d = dragRef.current; if (!d) return;
    const dx = (e.clientX - d.startX) / d.rect.width, dy = (e.clientY - d.startY) / d.rect.height;
    if (Math.abs(dx) + Math.abs(dy) > 0.001) d.moved = true;
    setElements(es => es.map(el => {
      if (el.id !== d.id) return el;
      const o = d.orig;
      if (d.mode === 'resize') {
        return { ...el, w: Math.min(1 - o.x, Math.max(0.01, o.w + dx)), h: Math.min(1 - o.y, Math.max(0.01, o.h + dy)) };
      }
      if (d.mode === 'blockw') { // paragraph block: dragging the handle reflows the text
        const pg = stateRef.current.pages.find(x => x.id === el.pageId);
        const Wd = pg ? dispDims(pg).w : 612;
        return { ...el, blockW: Math.max(40, (o.blockW || 100) + dx * Wd) };
      }
      if (d.mode === 'p1') return { ...el, x1: clamp01(o.x1 + dx), y1: clamp01(o.y1 + dy) };
      if (d.mode === 'p2') return { ...el, x2: clamp01(o.x2 + dx), y2: clamp01(o.y2 + dy) };
      // move
      if (o.points) return { ...el, points: o.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
      if (o.x1 !== undefined) return { ...el, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
      if (el.type === 'text') return { ...el, x: Math.min(0.98, Math.max(0, o.x + dx)), y: Math.min(0.98, Math.max(0, o.y + dy)) };
      return { ...el, x: Math.min(1 - o.w, Math.max(0, o.x + dx)), y: Math.min(1 - o.h, Math.max(0, o.y + dy)) };
    }));
  }, []);
  const editTapRef = useRef(null); // set to startTextEdit below (defined later)
  const onDragEnd = useCallback(() => {
    const d = dragRef.current;
    if (d?.moved) pushSnapshot(d.snap);
    else if (d?.editOnTap) { // Edit-text mode: a tap (no drag) opens the text
      const el = stateRef.current.elements.find(x => x.id === d.id);
      if (el) editTapRef.current?.(el);
    }
    dragRef.current = null;
    window.removeEventListener('pointermove', onDragMove);
  }, [onDragMove]); // eslint-disable-line react-hooks/exhaustive-deps
  const startDrag = (e, el, mode) => {
    // Elements are directly manipulable in select AND Edit-text mode (Acrobat
    // style): drag moves; in Edit-text, a click without movement opens the text.
    if (tool !== 'select' && tool !== 'edittext') return;
    e.stopPropagation(); e.preventDefault();
    if (editingId) commitTextEdit();
    setSelectedId(el.id);
    const pageEl = pageRefs.current[el.pageId]; if (!pageEl) return;
    dragRef.current = { id: el.id, mode, startX: e.clientX, startY: e.clientY,
      editOnTap: tool === 'edittext' && el.type === 'text' && mode === 'move',
      rect: pageEl.getBoundingClientRect(), orig: { ...el, points: el.points ? [...el.points] : undefined }, snap: takeSnap(), moved: false };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
  };

  // ── Draw tools (pointer events on each page's SVG) ──────────────────────────
  const norm = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  function pageDown(e, pg, d) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // The browser applies mousedown's DEFAULT focus action after handlers run:
    // the svg isn't focusable, so it would move focus to <body> — instantly
    // blurring the textarea we're about to mount (blur → commit → the new
    // element evaporates before pointerup). Suppress it; clicks that should
    // commit an open edit are handled explicitly below (the textarea's own
    // pointerdown never reaches here — it stops propagation).
    e.preventDefault();
    if (editingId) commitTextEdit();
    const p = norm(e);
    if (tool === 'select') { setSelectedId(null); return; }
    if (tool === 'edittext') {
      // Click a detected PARAGRAPH → cover the original block with white and
      // hand the user the whole paragraph in a wrapping editor at the block's
      // width, size and line pitch. Commit re-wraps within the block.
      const Ps = pg.blank ? [] : (linesRef.current.get(`${pg.src}:${pg.idx}`) || []);
      const px = p.x * d.w, py = p.y * d.h;
      const hit = Ps.find(P => {
        const b = lineBox(pg, P);
        return px >= b.x - 2 && px <= b.x + b.w + 2 && py >= b.y - 2 && py <= b.y + b.h + 2;
      });
      if (!hit) return;
      const b = lineBox(pg, hit);
      editSnapRef.current = takeSnap();
      const el = { id: nid('el'), pageId: pg.id, type: 'text', text: hit.text, origText: hit.text,
        fontSize: Math.max(6, Math.round(hit.size * 10) / 10), color: '#111827',
        blockW: Math.max(40, b.w + 3), lh: hit.lh || 1.25,
        x: b.x / d.w, y: b.y / d.h, bold: hit.bold, italic: hit.italic, serif: hit.serif, mono: hit.mono,
        bg: { x: (b.x - 2) / d.w, y: (b.y - 2) / d.h, w: (b.w + 5) / d.w, h: (b.h + 4) / d.h } };
      setElements(es => [...es, el]);
      // Stay in Edit-text mode (Acrobat-style): commit this block, click the next.
      setSelectedId(el.id); setEditingId(el.id);
      return;
    }
    if (tool === 'text') {
      editSnapRef.current = takeSnap();
      const el = { id: nid('el'), pageId: pg.id, type: 'text', x: p.x, y: p.y, fontSize, color, bold, italic, text: '' };
      setElements(es => [...es, el]);
      setSelectedId(el.id); setEditingId(el.id); setTool('select');
      return;
    }
    if (tool === 'image') {
      const img = pendingImg; if (!img) return;
      const wPt = Math.min(d.w * 0.5, img.w * 0.75);
      const hPt = wPt * (img.h / img.w);
      const w = wPt / d.w, h = hPt / d.h;
      const el = { id: nid('el'), pageId: pg.id, type: 'image', dataUrl: img.dataUrl, bytes: img.bytes, mime: img.mime,
        x: Math.min(1 - w, Math.max(0, p.x - w / 2)), y: Math.min(1 - h, Math.max(0, p.y - h / 2)), w, h };
      pushSnapshot(takeSnap());
      setElements(es => [...es, el]);
      setPendingImg(null); setSelectedId(el.id); setTool('select');
      return;
    }
    // freehand + shape tools
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawRef.current = { pageId: pg.id };
    if (tool === 'pen' || tool === 'highlight') {
      const c = tool === 'highlight' && color === '#111827' ? '#facc15' : color;
      setDraft({ type: tool, pageId: pg.id, points: [p], color: c, w: tool === 'highlight' ? strokeW * 6 : strokeW });
    } else {
      setDraft({ type: tool, pageId: pg.id, sx: p.x, sy: p.y, ex: p.x, ey: p.y, color, strokeW });
    }
  }
  function pageMove(e) {
    if (!drawRef.current) return;
    const p = norm(e);
    setDraft(dr => {
      if (!dr) return dr;
      if (dr.points) {
        const last = dr.points[dr.points.length - 1];
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.0015) return dr;
        return { ...dr, points: [...dr.points, p] };
      }
      return { ...dr, ex: p.x, ey: p.y };
    });
  }
  function pageUp() {
    const dr = draft; drawRef.current = null;
    if (!dr) return;
    setDraft(null);
    let el = null;
    if (dr.points) {
      if (dr.points.length > 1) el = { id: nid('el'), pageId: dr.pageId, type: dr.type, points: dr.points, color: dr.color, w: dr.w };
    } else if (dr.type === 'line' || dr.type === 'arrow') {
      if (Math.abs(dr.ex - dr.sx) + Math.abs(dr.ey - dr.sy) > 0.004)
        el = { id: nid('el'), pageId: dr.pageId, type: dr.type, x1: dr.sx, y1: dr.sy, x2: dr.ex, y2: dr.ey, color: dr.color, strokeW: dr.strokeW };
    } else {
      const x = Math.min(dr.sx, dr.ex), y = Math.min(dr.sy, dr.ey), w = Math.abs(dr.ex - dr.sx), h = Math.abs(dr.ey - dr.sy);
      if (w > 0.004 && h > 0.004)
        el = { id: nid('el'), pageId: dr.pageId, type: dr.type, x, y, w, h, color: dr.color, strokeW: dr.strokeW };
    }
    if (el) { pushSnapshot(takeSnap()); setElements(es => [...es, el]); setSelectedId(el.id); }
  }

  // ── Text editing ────────────────────────────────────────────────────────────
  function commitTextEdit() {
    const id = editingId; if (!id) return;
    setEditingId(null);
    const el = stateRef.current.elements.find(x => x.id === id);
    const snap = editSnapRef.current; editSnapRef.current = null;
    if (!el) return;
    const prev = snap?.elements.find(x => x.id === id);
    // Clicked a line but changed nothing → drop the replacement entirely, so
    // the untouched original (exact font and spacing) stays in the PDF.
    if (!prev && el.bg && el.text === el.origText) {
      setElements(es => es.filter(x => x.id !== id));
      setSelectedId(null);
      return;
    }
    if (!String(el.text || '').trim()) {
      if (el.bg) { // emptied an edited line — keep the white cover: the line is deleted
        if (snap && (!prev || prev.text !== el.text)) pushSnapshot(snap);
        return;
      }
      setElements(es => es.filter(x => x.id !== id));
      if (prev && snap) pushSnapshot(snap); // deleting pre-existing text is undoable
      setSelectedId(null);
      return;
    }
    if (snap && (!prev || prev.text !== el.text)) pushSnapshot(snap);
  }
  const startTextEdit = (el) => { editSnapRef.current = takeSnap(); setEditingId(el.id); setSelectedId(el.id); };
  editTapRef.current = startTextEdit;

  // ── Toolbar property changes apply to the selection too ─────────────────────
  const applyToSelected = (patchFor) => {
    if (!selectedId) return;
    const el = stateRef.current.elements.find(x => x.id === selectedId);
    const patch = el && patchFor(el);
    if (!patch) return;
    pushSnapshot(takeSnap());
    setElements(es => es.map(x => x.id === selectedId ? { ...x, ...patch } : x));
  };
  const changeColor = (c) => {
    setColor(c);
    applyToSelected(el => (['whiteout', 'redact', 'image'].includes(el.type) ? null : { color: el.type === 'highlight' && c === '#111827' ? '#facc15' : c }));
  };
  const changeStroke = (w) => {
    setStrokeW(w);
    applyToSelected(el =>
      el.type === 'pen' ? { w } : el.type === 'highlight' ? { w: w * 6 }
      : ['rect', 'ellipse', 'line', 'arrow'].includes(el.type) ? { strokeW: w } : null);
  };
  const changeFont = (fs) => {
    setFontSize(fs);
    applyToSelected(el => el.type === 'text' ? { fontSize: fs } : null);
  };
  const changeBold = () => {
    const sel = stateRef.current.elements.find(x => x.id === selectedId);
    const v = sel?.type === 'text' ? !sel.bold : !bold;
    setBold(v);
    applyToSelected(el => el.type === 'text' ? { bold: v } : null);
  };
  const changeItalic = () => {
    const sel = stateRef.current.elements.find(x => x.id === selectedId);
    const v = sel?.type === 'text' ? !sel.italic : !italic;
    setItalic(v);
    applyToSelected(el => el.type === 'text' ? { italic: v } : null);
  };

  // ── Image + merge pickers ───────────────────────────────────────────────────
  async function pickImage(fl) {
    if (!fl) return;
    if (!/^image\/(png|jpe?g)$/.test(fl.type)) { toastErr('PNG or JPG images only.'); return; }
    try {
      const bytes = new Uint8Array(await fl.arrayBuffer());
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(fl);
      });
      const dims = await new Promise((res, rej) => {
        const im = new window.Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = rej; im.src = dataUrl;
      });
      if (!dims.w || !dims.h) throw new Error();
      setPendingImg({ bytes, dataUrl, mime: fl.type, ...dims });
      setTool('image'); setSelectedId(null);
    } catch { toastErr('Could not read that image.'); }
  }
  async function mergePdf(fl) {
    if (!fl) return;
    try {
      if (isDocx(fl)) fl = await docxToPdf(fl);
      else if (fl.type !== 'application/pdf') { toastErr('Choose a PDF or Word (.docx) file.'); return; }
      const bytes = new Uint8Array(await fl.arrayBuffer());
      const doc = await pdfjsRef.current.getDocument({ data: bytes.slice() }).promise;
      const srcIdx = sourcesRef.current.length;
      sourcesRef.current.push(bytes); docsRef.current.push(doc);
      const add = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i);
        add.push({ id: nid('pg'), src: srcIdx, idx: i - 1, wu: p.view[2] - p.view[0], hu: p.view[3] - p.view[1],
                   ox: p.view[0], oy: p.view[1], baseRot: p.rotate || 0, rot: 0 });
      }
      pushSnapshot(takeSnap());
      setPages(ps => [...ps, ...add]);
    } catch { toastErr('Could not read that PDF — is it a valid, unencrypted file?'); }
  }

  // ── Page operations ─────────────────────────────────────────────────────────
  const rotatePage = (pgId, dir) => {
    const snap = takeSnap();
    setPages(ps => ps.map(p => p.id === pgId ? { ...p, rot: ((p.rot || 0) + (dir === 1 ? 90 : 270)) % 360 } : p));
    setElements(es => rotateEls(es, pgId, dir));
    pushSnapshot(snap);
  };
  const deletePage = (pgId) => {
    if (pages.length <= 1) { toastErr('A PDF needs at least one page.'); return; }
    pushSnapshot(takeSnap());
    setPages(ps => ps.filter(p => p.id !== pgId));
    setElements(es => es.filter(e => e.pageId !== pgId));
    setSelectedId(null);
  };
  const duplicatePage = (pgId) => {
    pushSnapshot(takeSnap());
    const i = pages.findIndex(p => p.id === pgId); if (i < 0) return;
    const copy = { ...pages[i], id: nid('pg') };
    setPages(ps => [...ps.slice(0, i + 1), copy, ...ps.slice(i + 1)]);
    setElements(es => [...es, ...es.filter(e => e.pageId === pgId).map(e => ({ ...e, id: nid('el'), pageId: copy.id, points: e.points ? [...e.points] : undefined }))]);
  };
  const insertBlankAfter = (pgId) => {
    pushSnapshot(takeSnap());
    const i = pages.findIndex(p => p.id === pgId); if (i < 0) return;
    const d = dispDims(pages[i]);
    setPages(ps => [...ps.slice(0, i + 1), { id: nid('pg'), blank: true, wu: d.w, hu: d.h, ox: 0, oy: 0, baseRot: 0, rot: 0 }, ...ps.slice(i + 1)]);
  };
  const reorderPages = (from, to) => {
    if (from === to || from == null || to == null) return;
    pushSnapshot(takeSnap());
    setPages(ps => {
      const next = [...ps];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // ── Bake: build a fresh PDF via pdf-lib with every edit applied ─────────────
  async function bake() {
    const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = await import('pdf-lib');
    const srcDocs = await Promise.all(sourcesRef.current.map(b => PDFDocument.load(b, { ignoreEncryption: true })));
    const out = await PDFDocument.create();
    const fontCache = new Map();
    const getFont = async (el) => {
      const k = fkey(el);
      if (!fontCache.has(k)) fontCache.set(k, await out.embedFont(StandardFonts[FONT_NAMES[k]]));
      return fontCache.get(k);
    };
    const imgCache = new Map();

    for (const pg of stateRef.current.pages) {
      let page;
      if (pg.blank) page = out.addPage([pg.wu, pg.hu]);
      else {
        const [cp] = await out.copyPages(srcDocs[pg.src], [pg.idx]);
        page = out.addPage(cp);
      }
      const R = rotOf(pg);
      page.setRotation(degrees(R));
      const { w: Wd, h: Hd } = dispDims(pg);
      const Wu = pg.wu, Hu = pg.hu, ox = pg.ox || 0, oy = pg.oy || 0;
      // Display-space points (top-left origin, rotation applied) → user space
      // (bottom-left origin, unrotated). Derived per /Rotate quadrant.
      const mapPt = (xd, yd) => {
        if (R === 90) return { x: yd + ox, y: xd + oy };
        if (R === 180) return { x: Wu - xd + ox, y: yd + oy };
        if (R === 270) return { x: Wu - yd + ox, y: Hu - xd + oy };
        return { x: xd + ox, y: Hu - yd + oy };
      };
      const mapRect = (xd, yd, wd, hd) => {
        if (R === 90) return { x: yd + ox, y: xd + oy, w: hd, h: wd };
        if (R === 180) return { x: Wu - xd - wd + ox, y: yd + oy, w: wd, h: hd };
        if (R === 270) return { x: Wu - yd - hd + ox, y: Hu - xd - wd + oy, w: hd, h: wd };
        return { x: xd + ox, y: Hu - yd - hd + oy, w: wd, h: hd };
      };

      for (const el of stateRef.current.elements) {
        if (el.pageId !== pg.id) continue;
        try {
          const c = hexRgb(el.color);
          const col = rgb(c.r, c.g, c.b);
          if (el.type === 'text') {
            if (el.bg) { // white cover over the original line this text replaces
              const r = mapRect(el.bg.x * Wd, el.bg.y * Hd, el.bg.w * Wd, el.bg.h * Hd);
              page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(1, 1, 1) });
            }
            const fs = el.fontSize, lh = el.lh || 1.25;
            const font = await getFont(el);
            const er = rotN(el.rot); // element spin from page rotations after placement
            layoutLines(el).forEach((line, i) => {
              const txt = winAnsi(line); if (!txt.trim()) return;
              const off = rotOff(0, fs * 0.8 + i * fs * lh, er);
              const p = mapPt(el.x * Wd + off.x, el.y * Hd + off.y);
              page.drawText(txt, { x: p.x, y: p.y, size: fs, font, color: col, rotate: degrees(R - er) });
            });
          } else if (el.type === 'pen' || el.type === 'highlight') {
            const pts = el.points.map(p => mapPt(p.x * Wd, p.y * Hd));
            const opacity = el.type === 'highlight' ? 0.4 : 1;
            if (pts.length > 1) {
              // ONE stroked path, like the preview — per-segment drawLine stacks
              // translucent ink at every joint (visible highlighter blobs).
              // drawSvgPath's y grows downward from its origin, so negate y.
              const dPath = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`).join(' ');
              page.drawSvgPath(dPath, { x: 0, y: 0, borderColor: col, borderWidth: el.w, borderOpacity: opacity, borderLineCap: LineCapStyle.Round });
            } else if (pts.length === 1)
              page.drawLine({ start: pts[0], end: { x: pts[0].x + 0.1, y: pts[0].y }, thickness: el.w, color: col, opacity, lineCap: LineCapStyle.Round });
          } else if (el.type === 'rect' || el.type === 'whiteout' || el.type === 'redact') {
            const r = mapRect(el.x * Wd, el.y * Hd, el.w * Wd, el.h * Hd);
            if (el.type === 'rect') page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, borderColor: col, borderWidth: el.strokeW });
            else page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: el.type === 'whiteout' ? rgb(1, 1, 1) : rgb(0, 0, 0) });
          } else if (el.type === 'ellipse') {
            const r = mapRect(el.x * Wd, el.y * Hd, el.w * Wd, el.h * Hd);
            page.drawEllipse({ x: r.x + r.w / 2, y: r.y + r.h / 2, xScale: r.w / 2, yScale: r.h / 2, borderColor: col, borderWidth: el.strokeW });
          } else if (el.type === 'line' || el.type === 'arrow') {
            const a = mapPt(el.x1 * Wd, el.y1 * Hd), b = mapPt(el.x2 * Wd, el.y2 * Hd);
            page.drawLine({ start: a, end: b, thickness: el.strokeW, color: col, lineCap: LineCapStyle.Round });
            if (el.type === 'arrow') {
              for (const hp of arrowHead(el.x1 * Wd, el.y1 * Hd, el.x2 * Wd, el.y2 * Hd, el.strokeW)) {
                const h = mapPt(hp.x, hp.y);
                page.drawLine({ start: h, end: b, thickness: el.strokeW, color: col, lineCap: LineCapStyle.Round });
              }
            }
          } else if (el.type === 'image') {
            let emb = imgCache.get(el.dataUrl);
            if (!emb) {
              emb = /png/.test(el.mime) ? await out.embedPng(el.bytes) : await out.embedJpg(el.bytes);
              imgCache.set(el.dataUrl, emb);
            }
            // Spin the bitmap with the page: content dims (swapped for 90/270)
            // rotated about the footprint centre — mirrors the SVG preview.
            const er = rotN(el.rot);
            const bw = el.w * Wd, bh = el.h * Hd, cx = el.x * Wd + bw / 2, cy = el.y * Hd + bh / 2;
            const iw = er % 180 ? bh : bw, ih = er % 180 ? bw : bh;
            const bl = rotOff(-iw / 2, ih / 2, er); // content bottom-left, offset from centre
            const p = mapPt(cx + bl.x, cy + bl.y);
            page.drawImage(emb, { x: p.x, y: p.y, width: iw, height: ih, rotate: degrees(R - er) });
          }
        } catch { /* one bad element must never sink the export */ }
      }
    }
    return out.save();
  }

  async function save() {
    if (busy || loading) return;
    if (!pages.length) { toastErr('Nothing to save — the document has no pages.'); return; }
    if (editingId) commitTextEdit();
    setBusy(true);
    try {
      const bytes = await bake();
      const edited = new File([bytes], fileName || 'edited.pdf', { type: 'application/pdf' });
      await onSave(edited);
      onClose();
    } catch (e) {
      toastErr(e?.message || 'Could not save the edited PDF.');
      setBusy(false);
    }
  }
  const requestClose = () => {
    if (busy) return;
    if ((undoStack.length || elements.length) && !window.confirm('Discard your PDF edits?')) return;
    onClose();
  };

  // ── Element rendering (SVG, viewBox units = PDF points → zoom-proof) ────────
  const elCursor = tool === 'select' ? 'move' : tool === 'edittext' ? 'text' : undefined;
  function renderEl(el, W, H) {
    const common = { style: { cursor: elCursor }, onPointerDown: (e) => startDrag(e, el, 'move') };
    if (el.type === 'pen' || el.type === 'highlight') {
      const dPath = el.points.map((p, i) => `${i ? 'L' : 'M'}${(p.x * W).toFixed(2)} ${(p.y * H).toFixed(2)}`).join(' ');
      return <path key={el.id} d={dPath} fill="none" stroke={el.color} strokeWidth={el.w} opacity={el.type === 'highlight' ? 0.4 : 1}
        strokeLinecap="round" strokeLinejoin="round" {...common} />;
    }
    if (el.type === 'line' || el.type === 'arrow') {
      const x1 = el.x1 * W, y1 = el.y1 * H, x2 = el.x2 * W, y2 = el.y2 * H;
      const head = el.type === 'arrow' ? arrowHead(x1, y1, x2, y2, el.strokeW) : [];
      return (
        <g key={el.id} {...common}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(10, el.strokeW)} />
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={el.color} strokeWidth={el.strokeW} strokeLinecap="round" />
          {head.map((h, i) => <line key={i} x1={h.x} y1={h.y} x2={x2} y2={y2} stroke={el.color} strokeWidth={el.strokeW} strokeLinecap="round" />)}
        </g>
      );
    }
    if (el.type === 'rect' || el.type === 'whiteout' || el.type === 'redact') {
      const fill = el.type === 'whiteout' ? '#ffffff' : el.type === 'redact' ? '#000000' : 'none';
      return <rect key={el.id} x={el.x * W} y={el.y * H} width={el.w * W} height={el.h * H}
        fill={fill === 'none' ? 'transparent' : fill} stroke={el.type === 'rect' ? el.color : 'none'} strokeWidth={el.strokeW || 0} {...common} />;
    }
    if (el.type === 'ellipse') {
      return <g key={el.id} {...common}>
        <ellipse cx={el.x * W + el.w * W / 2} cy={el.y * H + el.h * H / 2} rx={el.w * W / 2} ry={el.h * H / 2}
          fill="transparent" stroke={el.color} strokeWidth={el.strokeW} />
      </g>;
    }
    if (el.type === 'image') {
      // `rot` spins the bitmap with the page: draw at content dims (swapped for
      // 90/270) rotated about the box centre, filling the remapped footprint.
      const er = rotN(el.rot);
      const bw = el.w * W, bh = el.h * H, cx = el.x * W + bw / 2, cy = el.y * H + bh / 2;
      const iw = er % 180 ? bh : bw, ih = er % 180 ? bw : bh;
      return <image key={el.id} href={el.dataUrl} x={cx - iw / 2} y={cy - ih / 2} width={iw} height={ih}
        transform={er ? `rotate(${er} ${cx} ${cy})` : undefined}
        preserveAspectRatio="none" {...common} />;
    }
    if (el.type === 'text') {
      if (el.id === editingId) {
        // the textarea takes over while typing — keep only the white cover
        return el.bg ? <rect key={el.id} x={el.bg.x * W} y={el.bg.y * H} width={el.bg.w * W} height={el.bg.h * H} fill="#fff" pointerEvents="none" /> : null;
      }
      const fs = el.fontSize, lines = layoutLines(el), bb = bboxOf(el, W, H);
      return (
        <g key={el.id} {...common} onDoubleClick={(e) => { e.stopPropagation(); startTextEdit(el); }}>
          {el.bg && <rect x={el.bg.x * W} y={el.bg.y * H} width={el.bg.w * W} height={el.bg.h * H} fill="#fff" />}
          <g transform={rotN(el.rot) ? `rotate(${rotN(el.rot)} ${el.x * W} ${el.y * H})` : undefined}>
          <rect x={bb.x - 2} y={bb.y - 2} width={bb.w + 4} height={bb.h + 4} fill="transparent" />
          <text x={el.x * W} y={el.y * H + fs * 0.8} fontSize={fs} fill={el.color}
            fontFamily={famOf(el)} fontWeight={el.bold ? 700 : 400} fontStyle={el.italic ? 'italic' : 'normal'}
            style={{ userSelect: 'none', whiteSpace: 'pre' }}>
            {lines.map((ln, i) => <tspan key={i} x={el.x * W} dy={i === 0 ? 0 : fs * (el.lh || 1.25)}>{ln || ' '}</tspan>)}
          </text>
          </g>
        </g>
      );
    }
    return null;
  }

  function renderSelection(el, W, H) {
    const bb = bboxOf(el, W, H);
    const boxTypes = ['rect', 'ellipse', 'image', 'whiteout', 'redact'];
    // Rotated text draws its glyphs spun about the anchor — spin the chrome too
    const er = el.type === 'text' ? rotN(el.rot) : 0;
    return (
      <g key="sel" transform={er ? `rotate(${er} ${el.x * W} ${el.y * H})` : undefined}>
        <rect x={bb.x - 3} y={bb.y - 3} width={bb.w + 6} height={bb.h + 6} fill="none"
          stroke={SEL} strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        {boxTypes.includes(el.type) && (
          <rect x={el.x * W + el.w * W - 5} y={el.y * H + el.h * H - 5} width={10} height={10} rx={2}
            fill="#fff" stroke={SEL} strokeWidth={1.5} style={{ cursor: 'nwse-resize' }}
            onPointerDown={(e) => startDrag(e, el, 'resize')} />
        )}
        {el.type === 'text' && el.blockW && (
          <rect x={el.x * W + el.blockW - 5} y={bb.y + bb.h - 5} width={10} height={10} rx={2}
            fill="#fff" stroke={SEL} strokeWidth={1.5} style={{ cursor: 'ew-resize' }}
            onPointerDown={(e) => startDrag(e, el, 'blockw')} />
        )}
        {el.x1 !== undefined && (['p1', 'p2']).map(m => (
          <circle key={m} cx={(m === 'p1' ? el.x1 : el.x2) * W} cy={(m === 'p1' ? el.y1 : el.y2) * H} r={6}
            fill="#fff" stroke={SEL} strokeWidth={1.5} style={{ cursor: 'crosshair' }}
            onPointerDown={(e) => startDrag(e, el, m)} />
        ))}
        <g style={{ cursor: 'pointer' }} onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); deleteSelected(); }}>
          <circle cx={bb.x + bb.w + 12} cy={bb.y - 10} r={9} fill="#111827" />
          <line x1={bb.x + bb.w + 8.5} y1={bb.y - 13.5} x2={bb.x + bb.w + 15.5} y2={bb.y - 6.5} stroke="#fff" strokeWidth={1.6} />
          <line x1={bb.x + bb.w + 15.5} y1={bb.y - 13.5} x2={bb.x + bb.w + 8.5} y2={bb.y - 6.5} stroke="#fff" strokeWidth={1.6} />
        </g>
      </g>
    );
  }

  const renderDraft = (dr, W, H) => {
    if (!dr) return null;
    if (dr.points) return <path d={dr.points.map((p, i) => `${i ? 'L' : 'M'}${p.x * W} ${p.y * H}`).join(' ')}
      fill="none" stroke={dr.color} strokeWidth={dr.w} opacity={dr.type === 'highlight' ? 0.4 : 1} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />;
    if (dr.type === 'line' || dr.type === 'arrow')
      return <line x1={dr.sx * W} y1={dr.sy * H} x2={dr.ex * W} y2={dr.ey * H} stroke={dr.color} strokeWidth={dr.strokeW} strokeLinecap="round" pointerEvents="none" />;
    const x = Math.min(dr.sx, dr.ex) * W, y = Math.min(dr.sy, dr.ey) * H, w = Math.abs(dr.ex - dr.sx) * W, h = Math.abs(dr.ey - dr.sy) * H;
    if (dr.type === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill="none" stroke={dr.color} strokeWidth={dr.strokeW} pointerEvents="none" />;
    const fill = dr.type === 'whiteout' ? 'rgba(255,255,255,0.85)' : dr.type === 'redact' ? 'rgba(0,0,0,0.8)' : 'none';
    return <rect x={x} y={y} width={w} height={h} fill={fill} stroke={dr.type === 'rect' ? dr.color : SEL} strokeWidth={dr.type === 'rect' ? dr.strokeW : 1} strokeDasharray={dr.type === 'rect' ? undefined : '4 3'} pointerEvents="none" />;
  };

  // ── UI chrome ───────────────────────────────────────────────────────────────
  const toolBtn = ([id, Icon, tip]) => (
    <button key={id} title={tip}
      onClick={() => { if (id === 'image') { imgInputRef.current?.click(); return; } setTool(id); setSelectedId(null); }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 30, borderRadius: 8, cursor: 'pointer',
        border: tool === id ? '1.5px solid var(--pine)' : '1.5px solid transparent',
        background: tool === id ? 'var(--pine)' : 'transparent', color: tool === id ? '#fff' : 'var(--ink)' }}>
      <Icon size={15} />
    </button>
  );
  const iconBtn = (Icon, tip, onClick, disabled = false) => (
    <button title={tip} onClick={onClick} disabled={disabled}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 28, borderRadius: 7, cursor: disabled ? 'default' : 'pointer',
        border: 'none', background: 'transparent', color: disabled ? 'var(--line)' : 'var(--muted)' }}>
      <Icon size={14} />
    </button>
  );
  const selectedEl = elements.find(e => e.id === selectedId);
  const hint = pendingImg ? 'Click on a page to place the image.'
    : tool === 'edittext' && extracting ? 'Reading the document text…'
    : (TOOL_DEFS.find(t => t[0] === tool)?.[2] || '');
  const cursorFor = tool === 'select' ? 'default' : (tool === 'text' || tool === 'edittext') ? 'text' : 'crosshair';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1380, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, animation: 'fadeIn 0.12s ease' }}>
      <div style={{ background: 'var(--bg, #f3f4f6)', borderRadius: 16, width: '100%', maxWidth: 1400, height: 'min(94dvh, 960px)', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-lg)', animation: 'pdfEditorIn 0.2s cubic-bezier(.16,1,.3,1)', fontFamily: 'Inter,sans-serif' }}>

        {/* Header row — file + history + zoom + actions */}
        <div style={{ padding: '9px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}>
          <FileText size={16} style={{ color: 'var(--pine)', flexShrink: 0 }} />
          <div style={{ flex: '0 1 auto', minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName || 'Document.pdf'}</div>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>PDF editor · {pages.length} page{pages.length === 1 ? '' : 's'}{elements.length ? ` · ${elements.length} edit${elements.length === 1 ? '' : 's'}` : ''}</div>
          </div>
          <div style={{ flex: 1 }} />
          {iconBtn(Undo2, 'Undo (Ctrl+Z)', undo, !undoStack.length)}
          {iconBtn(Redo2, 'Redo (Ctrl+Y)', redo, !redoStack.length)}
          <span style={{ width: 1, height: 20, background: 'var(--line)' }} />
          {iconBtn(ZoomOut, 'Zoom out', () => setZoom(z => Math.max(0.5, +(z - 0.15).toFixed(2))))}
          <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)', width: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          {iconBtn(ZoomIn, 'Zoom in', () => setZoom(z => Math.min(2, +(z + 0.15).toFixed(2))))}
          {iconBtn(Maximize, 'Fit width', () => setZoom(1))}
          <span style={{ width: 1, height: 20, background: 'var(--line)' }} />
          <button className="secondary-btn" onClick={requestClose} disabled={busy} style={{ fontSize: 12.5 }}>Cancel</button>
          <button className="primary-btn" onClick={save} disabled={busy || loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, opacity: busy || loading ? 0.6 : 1 }}>
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle size={13} />} Save changes
          </button>
        </div>

        {/* Tool row */}
        <div style={{ padding: '7px 16px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 6, background: 'var(--card)', flexShrink: 0, flexWrap: 'wrap' }}>
          {TOOL_DEFS.map(toolBtn)}
          <span style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
          {SWATCHES.map(c => (
            <button key={c} title={c} onClick={() => changeColor(c)}
              style={{ width: 18, height: 18, borderRadius: '50%', cursor: 'pointer', background: c, padding: 0,
                border: color === c ? `2px solid ${SEL}` : c === '#ffffff' ? '1.5px solid var(--line)' : '1.5px solid transparent',
                boxShadow: color === c ? '0 0 0 2px var(--card)' : 'none' }} />
          ))}
          <input type="color" value={color} onChange={e => changeColor(e.target.value)} title="Custom colour"
            style={{ width: 24, height: 22, padding: 0, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--card)', cursor: 'pointer' }} />
          <span style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
          <label style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>Stroke</label>
          <select className="form-input" value={strokeW} onChange={e => changeStroke(+e.target.value)}
            style={{ fontSize: 11.5, padding: '2px 6px', height: 26, width: 56 }}>
            {STROKES.map(s => <option key={s} value={s}>{s}pt</option>)}
          </select>
          <label style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>Text</label>
          <select className="form-input" value={fontSize} onChange={e => changeFont(+e.target.value)}
            style={{ fontSize: 11.5, padding: '2px 6px', height: 26, width: 60 }}>
            {FONT_SIZES.map(s => <option key={s} value={s}>{s}pt</option>)}
          </select>
          {[[Bold, 'Bold', bold, changeBold], [Italic, 'Italic', italic, changeItalic]].map(([Icon, tip, on, fn]) => {
            const sel = selectedEl?.type === 'text' ? selectedEl : null;
            const active = sel ? (tip === 'Bold' ? sel.bold : sel.italic) : on;
            return (
              <button key={tip} title={tip} onClick={fn}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 7, cursor: 'pointer',
                  border: '1.5px solid ' + (active ? 'var(--pine)' : 'var(--line)'), background: active ? 'var(--pine)' : 'transparent', color: active ? '#fff' : 'var(--ink)' }}>
                <Icon size={13} />
              </button>
            );
          })}
          {selectedEl && (
            <>
              <span style={{ width: 1, height: 20, background: 'var(--line)', margin: '0 4px' }} />
              <button className="secondary-btn" onClick={deleteSelected}
                style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', color: 'hsl(var(--color-red))' }}>
                <Trash2 size={12} /> Delete
              </button>
            </>
          )}
        </div>

        {/* Body: thumbnails + document */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: 148, borderRight: '1px solid var(--line)', background: 'var(--card)', overflowY: 'auto', padding: '12px 10px', flexShrink: 0 }}>
            {pages.map((pg, i) => {
              const d = dispDims(pg);
              const img = pg.blank ? null : cacheRef.current.get(`${pg.src}:${pg.idx}:${d.R}`);
              return (
                <div key={pg.id} draggable
                  onDragStart={() => { dragPageIdx.current = i; }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); reorderPages(dragPageIdx.current, i); dragPageIdx.current = null; }}
                  style={{ marginBottom: 12, cursor: 'grab' }}>
                  <div onClick={() => pageRefs.current[pg.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    style={{ position: 'relative', aspectRatio: `${d.w} / ${d.h}`, background: '#fff', borderRadius: 6, border: '1.5px solid var(--line)', overflow: 'hidden', boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                    {img ? <img src={img} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                      : !pg.blank && <Loader2 size={13} style={{ position: 'absolute', top: '46%', left: '46%', color: 'var(--muted)', animation: 'spin 1s linear infinite' }} />}
                    <span style={{ position: 'absolute', bottom: 3, right: 5, fontSize: 9.5, fontWeight: 800, color: 'var(--muted)', background: 'rgba(255,255,255,0.85)', borderRadius: 4, padding: '0 4px' }}>{i + 1}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 1, marginTop: 3 }}>
                    {[[RotateCcw, 'Rotate left', () => rotatePage(pg.id, -1)],
                      [RotateCw, 'Rotate right', () => rotatePage(pg.id, 1)],
                      [CopyPlus, 'Duplicate page', () => duplicatePage(pg.id)],
                      [FilePlus, 'Insert blank page after', () => insertBlankAfter(pg.id)],
                      [Trash2, 'Delete page', () => deletePage(pg.id)]].map(([Icon, tip, fn], j) => (
                      <button key={j} title={tip} onClick={fn}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: j === 4 ? 'hsl(var(--color-red))' : 'var(--muted)', display: 'flex', padding: 3 }}>
                        <Icon size={12} />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <button className="secondary-btn" onClick={() => mergeInputRef.current?.click()}
              style={{ width: '100%', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, padding: '6px 4px' }}
              title="Append another PDF or Word (.docx) file to the end of this one">
              <Layers size={12} /> Merge file
            </button>
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '26px 20px', minWidth: 0, userSelect: 'none' }}>
            {loading ? (
              <div style={{ padding: 60, textAlign: 'center', color: 'var(--muted)' }}>
                <Loader2 size={22} style={{ animation: 'spin 1s linear infinite' }} />
                <div style={{ fontSize: 12, marginTop: 8 }}>Opening document…</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 26, justifyItems: 'center' }}>
                {pages.map((pg, i) => {
                  const d = dispDims(pg);
                  const img = pg.blank ? null : cacheRef.current.get(`${pg.src}:${pg.idx}:${d.R}`);
                  const pageEls = elements.filter(e => e.pageId === pg.id);
                  const editingEl = editingId ? pageEls.find(e => e.id === editingId) : null;
                  return (
                    <div key={pg.id} ref={el => { pageRefs.current[pg.id] = el; }}
                      style={{ position: 'relative', width: `${Math.round(zoom * 100)}%`, maxWidth: 980 * zoom, aspectRatio: `${d.w} / ${d.h}`, background: '#fff', boxShadow: '0 2px 12px rgba(0,0,0,0.14)', borderRadius: 4 }}>
                      {img && <img src={img} alt={`Page ${i + 1}`} draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', borderRadius: 4 }} />}
                      {!img && !pg.blank && <Loader2 size={18} style={{ position: 'absolute', top: '48%', left: '48%', color: 'var(--muted)', animation: 'spin 1s linear infinite' }} />}
                      <svg viewBox={`0 0 ${d.w} ${d.h}`} preserveAspectRatio="none"
                        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', cursor: cursorFor, touchAction: 'none', overflow: 'visible' }}
                        onPointerDown={e => pageDown(e, pg, d)} onPointerMove={pageMove} onPointerUp={pageUp}>
                        {tool === 'edittext' && !pg.blank && (linesRef.current.get(`${pg.src}:${pg.idx}`) || []).map((L, li) => {
                          const b = lineBox(pg, L);
                          return <rect key={`tl${li}`} x={b.x - 2} y={b.y - 1.5} width={b.w + 4} height={b.h + 3} rx={2}
                            fill="rgba(59,130,246,0.05)" stroke={SEL} strokeOpacity={0.4} strokeWidth={0.7}
                            strokeDasharray="3 2.5" pointerEvents="none" />;
                        })}
                        <g style={{ pointerEvents: (tool === 'select' || tool === 'edittext') ? 'auto' : 'none' }}>
                          {pageEls.map(el => renderEl(el, d.w, d.h))}
                          {selectedEl && selectedEl.pageId === pg.id && !editingEl && renderSelection(selectedEl, d.w, d.h)}
                        </g>
                        {draft && draft.pageId === pg.id && renderDraft(draft, d.w, d.h)}
                        {editingEl && (() => {
                          // WYSIWYG editing. Paragraph blocks (blockW) get a
                          // WRAPPING editor at the block's width and line pitch;
                          // plain text boxes stay no-wrap (Enter breaks lines,
                          // exactly like the baked output). Offset so the first
                          // line sits on the committed baseline.
                          const fs = editingEl.fontSize, lh = editingEl.lh || 1.25;
                          const block = !!editingEl.blockW;
                          const lines = layoutLines(editingEl);
                          const wMax = block ? editingEl.blockW
                            : Math.max(40, ...lines.map(l => measureW(editingEl, l)));
                          const foW = block ? wMax + 12 : wMax + Math.max(50, wMax * 0.25) + 9;
                          const foH = (lines.length + (block ? 1 : 0)) * fs * lh + 10;
                          const er = rotN(editingEl.rot);
                          return (
                            <foreignObject x={editingEl.x * d.w - 4.5} y={editingEl.y * d.h - fs * 0.125 - 4.5} width={foW} height={foH}
                              transform={er ? `rotate(${er} ${editingEl.x * d.w} ${editingEl.y * d.h})` : undefined}>
                              <textarea autoFocus value={editingEl.text} wrap={block ? 'soft' : 'off'} spellCheck={false}
                                onChange={e => setElements(es => es.map(x => x.id === editingEl.id ? { ...x, text: e.target.value } : x))}
                                onBlur={commitTextEdit}
                                onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.currentTarget.blur(); } }}
                                onPointerDown={e => e.stopPropagation()}
                                placeholder="Type here…"
                                style={{ width: '100%', height: '100%', fontSize: fs, lineHeight: lh, fontFamily: famOf(editingEl),
                                  fontWeight: editingEl.bold ? 700 : 400, fontStyle: editingEl.italic ? 'italic' : 'normal',
                                  color: editingEl.color, background: editingEl.bg ? 'rgba(255,255,255,0.97)' : 'rgba(255,255,255,0.75)',
                                  border: `1.5px dashed ${SEL}`, borderRadius: 3, whiteSpace: block ? 'pre-wrap' : 'pre',
                                  outline: 'none', resize: 'none', padding: '3px 3px', boxSizing: 'border-box', overflow: 'hidden' }} />
                            </foreignObject>
                          );
                        })()}
                      </svg>
                      <span style={{ position: 'absolute', top: -19, right: 2, fontSize: 10.5, color: 'var(--muted)', fontWeight: 600 }}>Page {i + 1} of {pages.length}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <div style={{ padding: '6px 16px', borderTop: '1px solid var(--line)', background: 'var(--card)', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{hint}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Saving bakes every edit into a new PDF — signature fields are placed afterwards.</span>
        </div>
      </div>

      <input ref={imgInputRef} type="file" accept="image/png,image/jpeg" style={{ display: 'none' }}
        onChange={e => { pickImage(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={mergeInputRef} type="file" accept="application/pdf,.docx" style={{ display: 'none' }}
        onChange={e => { mergePdf(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
  );
}
