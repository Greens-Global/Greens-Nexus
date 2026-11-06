// Sheets: the workbook on screen - toolbar, name box and formula bar, the
// grid and the tab strip - drawn from the shared document it is given.
//
// The grid is virtualized: only the rows and columns in view are drawn, at
// their real offsets inside one scrolling canvas. The header row (with any
// frozen rows) is a band stuck to the top, the row numbers (with any frozen
// columns) a band stuck to the left, the corner both. Every cell draws its
// own selection, fill-handle and other people's selection edges, so the
// frozen bands need no overlay of their own.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Undo2, Redo2, Bold, Italic, Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, WrapText,
  Baseline, PaintBucket, ArrowDownAZ, ArrowUpZA, Search, ChevronUp, ChevronDown, X, Plus, MoreVertical,
  FileUp, FileDown, Snowflake,
} from 'lucide-react';
import { Menu, SmallBtn, ColorGrid, THEME_COLORS, STANDARD_COLORS, useDismiss } from '../components/docRibbon/ui';
import { dialog } from '../ui/dialog';
import {
  ROW_H, COL_W, buildCtx, writeCells, styleRange, clearRange, insertLines, deleteLines, setSize, setTabMeta,
  addTab, duplicateTab, deleteTab, moveTab, loadSnapshot, blockAt, placeRaw, undoManagerFor, formulaText,
} from './model.js';
import { a1, colName, colIndex } from './formula/parse.js';
import { createEngine, isErr, compare } from './formula/eval.js';
import { SIGS } from './formula/functions.js';
import { formatValue, parseInput, editText, NUMBER_FORMATS, DEFAULT_DECIMALS } from './format.js';
import { parseTSV, toTSV, toHTML, parseHTMLTable } from './clipboard.js';
import { importSheetFile, exportSheetFile } from './io.js';
import './sheets.css';

const RH = 46;          // row number column
const CH = 24;          // column letter row
const REMOTE = 'nx-remote';
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const COLOR_ROWS = [THEME_COLORS.map((h) => [h]), STANDARD_COLORS.map((h) => [h])];

/** Largest i with off[i] <= y, within 0..n-1. */
function idxAt(off, y) {
  let lo = 0, hi = off.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (off[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}
const norm = (s) => ({ r1: Math.min(s.r, s.r2), r2: Math.max(s.r, s.r2), c1: Math.min(s.c, s.c2), c2: Math.max(s.c, s.c2) });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** "B3" or "A1:C9" -> a selection, or null. */
function parseA1(text) {
  const m = String(text).trim().toUpperCase().match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/);
  if (!m) return null;
  const r = +m[2] - 1, c = colIndex(m[1]);
  return m[3] ? { r, c, r2: +m[4] - 1, c2: colIndex(m[3]) } : { r, c, r2: r, c2: c };
}

/** The function the caret is inside, for the signature hint. */
function openFunction(text) {
  const stack = [];
  let word = '', inStr = false;
  for (const ch of text) {
    if (inStr) { if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; word = ''; continue; }
    if (/[A-Za-z0-9_.]/.test(ch)) { word += ch; continue; }
    if (ch === '(') stack.push(word.toUpperCase());
    else if (ch === ')') stack.pop();
    word = '';
  }
  return stack.length ? stack[stack.length - 1] : '';
}

/** A small menu at a point on screen (right-click, the tab menu). */
function PopMenu({ at, items, onClose, children }) {
  const ref = useRef(null);
  useDismiss(ref, true, onClose);
  const style = { position: 'fixed', left: clamp(at.x, 8, window.innerWidth - 230), zIndex: 1000 };
  if (at.up) style.bottom = window.innerHeight - at.y; else style.top = clamp(at.y, 8, window.innerHeight - 40);
  return (
    <div ref={ref} className="doc-ribbon-panel nxs-pop" style={style} role="menu">
      {items.map((it, i) => (it === '-' ? <div key={i} className="doc-ribbon-sep" /> : (
        <button key={it.label} type="button" role="menuitem" className="doc-ribbon-item" disabled={it.disabled}
          onClick={() => { onClose(); it.onClick(); }}>
          {it.icon && <it.icon size={14} />}<span>{it.label}</span>
        </button>
      )))}
      {children}
    </div>
  );
}

// `me` is the host's: it puts who you are into the awareness the others read.
export default function SheetEditor({ doc, awareness = null, canEdit = true, title = '', onChange, toastErr }) {
  const scroller = useRef(null);
  const barRef = useRef(null);
  const fileRef = useRef(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // ── the document ────────────────────────────────────────────────────
  const [ver, setVer] = useState(0);
  const umRef = useRef(null);
  const [stacks, setStacks] = useState({ undo: 0, redo: 0 });
  useEffect(() => {
    const u = undoManagerFor(doc);
    umRef.current = u.um;
    const stacks = () => setStacks({ undo: u.um.undoStack.length, redo: u.um.redoStack.length });
    for (const ev of ['stack-item-added', 'stack-item-popped', 'stack-cleared']) u.um.on(ev, stacks);
    const f = (_update, origin) => {
      setVer((v) => v + 1);
      if (origin !== REMOTE) onChangeRef.current?.();
    };
    doc.on('update', f);
    return () => { doc.off('update', f); u.destroy(); umRef.current = null; };
  }, [doc]);
  const ctx = useMemo(() => buildCtx(doc), [doc, ver]); // eslint-disable-line react-hooks/exhaustive-deps
  const eng = useMemo(() => createEngine(ctx), [ctx]);
  const [tabId, setTabId] = useState('');
  const tab = ctx.tabById(tabId) || ctx.tabs[0];
  const R = tab.rows.length, C = tab.cols.length;
  const fr = Math.min(tab.frozenRows, R - 1), fc = Math.min(tab.frozenCols, C - 1);

  // ── selection, editing ──────────────────────────────────────────────
  const [selRaw, setSel] = useState({ r: 0, c: 0, r2: 0, c2: 0 });
  const sel = { r: clamp(selRaw.r, 0, R - 1), c: clamp(selRaw.c, 0, C - 1), r2: clamp(selRaw.r2, 0, R - 1), c2: clamp(selRaw.c2, 0, C - 1) };
  const b = norm(sel);
  const [edit, setEdit] = useState(null);       // { r, c, text, mode: 'enter' | 'edit', from: 'cell' | 'bar' }
  const [pick, setPick] = useState(0);          // highlighted autocomplete row
  const [menu, setMenu] = useState(null);       // { x, y, kind }
  const [find, setFind] = useState(null);       // { q, i }
  const [fillTo, setFillTo] = useState(null);
  const [renaming, setRenaming] = useState('');
  const [resize, setResize] = useState(null);   // { id, px } while a header edge is dragged
  const dragRef = useRef(null);
  const clipRef = useRef(null);

  const cellAt = (r, c) => ctx.cell(tab, r, c);
  const textOf = (r, c) => {
    const cell = cellAt(r, c);
    if (!cell) return '';
    return cell.f ? formulaText(ctx, tab.id, cell.f) : editText(cell.v, cell.s);
  };
  const shown = (r, c) => {
    const cell = cellAt(r, c);
    return cell ? formatValue(eng.cellValue(tab, r, c), cell.s) : '';
  };
  const focusGrid = () => scroller.current?.focus({ preventScroll: true });

  // ── geometry ────────────────────────────────────────────────────────
  const geo = useMemo(() => {
    const rowY = new Float64Array(R + 1), colX = new Float64Array(C + 1);
    for (let i = 0; i < R; i += 1) rowY[i + 1] = rowY[i] + (resize?.id === tab.rows[i] ? resize.px : ctx.size(tab, tab.rows[i], ROW_H));
    for (let j = 0; j < C; j += 1) colX[j + 1] = colX[j] + (resize?.id === tab.cols[j] ? resize.px : ctx.size(tab, tab.cols[j], COL_W));
    return { rowY, colX };
  }, [ctx, tab, R, C, resize]);
  const { rowY, colX } = geo;
  const frozenH = rowY[fr], frozenW = colX[fc];
  const ADD_ROWS_H = canEdit ? 52 : 0;
  const totalW = RH + colX[C], totalH = CH + rowY[R] + ADD_ROWS_H;

  const [vp, setVp] = useState({ w: 1000, h: 520, top: 0, left: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const measure = () => setVp((v) => ({ ...v, w: el.clientWidth || v.w, h: el.clientHeight || v.h }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rafRef = useRef(0);
  const onScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = scroller.current;
      if (el) setVp((v) => ({ ...v, top: el.scrollTop, left: el.scrollLeft }));
    });
  };
  const rA = Math.max(fr, idxAt(rowY, vp.top + frozenH)), rB = Math.min(R - 1, idxAt(rowY, vp.top + vp.h - CH) + 1);
  const cA = Math.max(fc, idxAt(colX, vp.left + frozenW)), cB = Math.min(C - 1, idxAt(colX, vp.left + vp.w - RH) + 1);

  const ensureVisible = useCallback((r, c) => {
    const el = scroller.current;
    if (!el) return;
    if (r >= fr) {
      const top = rowY[r], bot = rowY[r + 1], viewH = el.clientHeight - CH;
      if (top < el.scrollTop + frozenH) el.scrollTop = top - frozenH;
      else if (bot > el.scrollTop + viewH) el.scrollTop = bot - viewH;
    }
    if (c >= fc) {
      const l = colX[c], rr = colX[c + 1], viewW = el.clientWidth - RH;
      if (l < el.scrollLeft + frozenW) el.scrollLeft = l - frozenW;
      else if (rr > el.scrollLeft + viewW) el.scrollLeft = rr - viewW;
    }
  }, [rowY, colX, fr, fc, frozenH, frozenW]);

  const select = (next, scroll = true) => {
    setSel(next);
    if (scroll) requestAnimationFrame(() => ensureVisible(next.r2, next.c2));
  };

  // ── presence ────────────────────────────────────────────────────────
  const [remote, setRemote] = useState([]);
  useEffect(() => {
    if (!awareness) return undefined;
    const f = () => {
      const out = [];
      awareness.getStates().forEach((st, id) => {
        if (id === awareness.clientID) return;
        const s = st?.sel, u = st?.user;
        if (!s || typeof s !== 'object' || ['tab', 'r', 'c', 'r2', 'c2'].some((k) => typeof s[k] !== 'string')) return;
        out.push({ id, ...s, name: String(u?.name || u?.email || 'Someone').slice(0, 40), color: COLOR_RE.test(u?.color || '') ? u.color : '#64748b' });
      });
      setRemote(out);
    };
    f();
    awareness.on('change', f);
    return () => awareness.off('change', f);
  }, [awareness]);
  const remoteBoxes = useMemo(() => remote.filter((x) => x.tab === tab.id).map((x) => {
    const r = ctx.rowIndex(tab, x.r), c = ctx.colIndex(tab, x.c), r2 = ctx.rowIndex(tab, x.r2), c2 = ctx.colIndex(tab, x.c2);
    if ([r, c, r2, c2].some((v) => v < 0)) return null;
    return { ...norm({ r, c, r2, c2 }), ar: r, ac: c, name: x.name, color: x.color, id: x.id };
  }).filter(Boolean), [remote, ctx, tab]);
  const selKey = `${tab.id}|${tab.rows[sel.r]}|${tab.cols[sel.c]}|${tab.rows[sel.r2]}|${tab.cols[sel.c2]}`;
  useEffect(() => {
    if (!awareness) return undefined;
    const t = setTimeout(() => {
      const [tb, r, c, r2, c2] = selKey.split('|');
      try { awareness.setLocalStateField('sel', { tab: tb, r, c, r2, c2 }); } catch { /* the session is closing */ }
    }, 50);
    return () => clearTimeout(t);
  }, [awareness, selKey]);

  // ── editing ─────────────────────────────────────────────────────────
  const startEdit = (text, mode, from = 'cell') => {
    if (!canEdit) return;
    setEdit({ r: sel.r, c: sel.c, text: text ?? textOf(sel.r, sel.c), mode, from });
    setPick(0);
  };
  const commit = (dr = 0, dc = 0) => {
    if (!edit) return;
    const { r, c, text } = edit;
    if (text !== textOf(r, c)) {
      const cur = cellAt(r, c);
      const p = parseInput(text, cur?.s?.nf);
      let s = cur?.s || null;
      if (p.nf && !s?.nf) s = { ...(s || {}), nf: p.nf, ...(p.d != null ? { d: p.d } : {}) };
      writeCells(doc, tab.id, [{ r, c, v: p.v ?? null, f: p.f || null, s }]);
    }
    setEdit(null);
    if (dr || dc) select({ r: clamp(r + dr, 0, R - 1), c: clamp(c + dc, 0, C - 1), r2: clamp(r + dr, 0, R - 1), c2: clamp(c + dc, 0, C - 1) });
    focusGrid();
  };
  const cancel = () => { setEdit(null); focusGrid(); };

  const word = edit && edit.text.startsWith('=') ? (edit.text.match(/(?:^=|[^A-Za-z0-9_.])([A-Za-z][A-Za-z0-9.]*)$/) || [])[1] : '';
  const suggestions = word ? Object.keys(SIGS).filter((n) => n.startsWith(word.toUpperCase()) && n !== word.toUpperCase()).slice(0, 6) : [];
  const hint = edit && edit.text.startsWith('=') ? SIGS[openFunction(edit.text)] : '';
  const accept = (name) => {
    setEdit((e) => ({ ...e, text: e.text.replace(/([A-Za-z][A-Za-z0-9.]*)$/, name + '(') }));
    setPick(0);
  };

  const editKey = (e) => {
    e.stopPropagation();
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
      return;
    }
    if (suggestions.length && e.key === 'Tab') { e.preventDefault(); accept(suggestions[pick] || suggestions[0]); return; }
    if (e.key === 'Enter') { e.preventDefault(); commit(e.shiftKey ? -1 : 1, 0); return; }
    if (e.key === 'Tab') { e.preventDefault(); commit(0, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
    if (edit?.mode === 'enter' && edit.from === 'cell' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      commit(e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0);
    }
  };

  // ── changes ─────────────────────────────────────────────────────────
  const guard = () => { if (!canEdit) return false; if (edit) commit(); return true; };
  const active = cellAt(sel.r, sel.c);
  const applyStyle = (patch) => { if (guard()) styleRange(doc, tab.id, b, patch); };
  const toggle = (k) => applyStyle({ [k]: !active?.s?.[k] });
  const decimals = (delta) => {
    let nf = active?.s?.nf || '';
    if (['date', 'time', 'datetime', 'text'].includes(nf)) return;
    if (!nf) nf = 'number';
    const v = eng.cellValue(tab, sel.r, sel.c);
    const cur = Number.isInteger(active?.s?.d) ? active.s.d : (DEFAULT_DECIMALS[nf] ?? (typeof v === 'number' ? (String(v).split('.')[1] || '').length : 0));
    applyStyle({ nf, d: clamp(cur + delta, 0, 10) });
  };
  const usedExtent = () => {
    let r = -1, c = -1;
    tab.cells.forEach((_, k) => { const [ri, ci] = k.split('.'); r = Math.max(r, ctx.rowIndex(tab, ri)); c = Math.max(c, ctx.colIndex(tab, ci)); });
    return { r, c };
  };
  const sortBy = (desc) => {
    if (!guard()) return;
    const whole = b.r1 === b.r2;
    const ext = usedExtent();
    const r1 = whole ? fr : b.r1, r2 = whole ? ext.r : b.r2, c1 = whole ? 0 : b.c1, c2 = whole ? ext.c : b.c2;
    if (r2 <= r1 || c2 < c1) return;
    const rows = [];
    for (let r = r1; r <= r2; r += 1) {
      const cells = [];
      for (let c = c1; c <= c2; c += 1) cells.push(cellAt(r, c) || null);
      rows.push({ key: eng.cellValue(tab, r, sel.c), cells, r });
    }
    rows.sort((x, y) => {
      const bx = x.key == null || x.key === '', by = y.key == null || y.key === '';
      if (bx || by) return bx === by ? x.r - y.r : bx ? 1 : -1;      // blanks always last
      const k = compare(isErr(x.key) ? x.key.code : x.key, isErr(y.key) ? y.key.code : y.key);
      return (desc ? -k : k) || x.r - y.r;
    });
    const list = [];
    rows.forEach((row, i) => row.cells.forEach((cell, j) => list.push({ r: r1 + i, c: c1 + j, cell })));
    placeRaw(doc, tab.id, list);
  };
  const lines = (axis, where) => {
    if (!guard()) return;
    const n = axis === 'rows' ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1;
    const start = axis === 'rows' ? b.r1 : b.c1, end = axis === 'rows' ? b.r2 : b.c2;
    if (where === 'delete') deleteLines(doc, tab.id, axis, start, n);
    else insertLines(doc, tab.id, axis, where === 'before' ? start : end + 1, n);
  };
  const undo = () => { if (guard()) umRef.current?.undo(); };
  const redo = () => { if (guard()) umRef.current?.redo(); };

  // ── fill handle ─────────────────────────────────────────────────────
  const fillArea = fillTo ? (() => {
    const down = fillTo.r - b.r2, right = fillTo.c - b.c2;
    if (down > 0 && down >= right) return { r1: b.r2 + 1, r2: fillTo.r, c1: b.c1, c2: b.c2, dir: 'down' };
    if (right > 0) return { r1: b.r1, r2: b.r2, c1: b.c2 + 1, c2: fillTo.c, dir: 'right' };
    return null;
  })() : null;
  const doFill = (area) => {
    if (!area || !guard()) return;
    const list = [];
    const down = area.dir === 'down';
    const lanes = down ? [b.c1, b.c2] : [b.r1, b.r2];
    for (let lane = lanes[0]; lane <= lanes[1]; lane += 1) {
      const src = [];
      const n = down ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1;
      for (let k = 0; k < n; k += 1) src.push(down ? { r: b.r1 + k, c: lane } : { r: lane, c: b.c1 + k });
      const cells = src.map((p) => cellAt(p.r, p.c));
      const series = n >= 2 && cells.every((x) => x && x.f == null && typeof x.v === 'number');
      const step = series ? (cells[n - 1].v - cells[0].v) / (n - 1) : 0;
      const count = down ? area.r2 - area.r1 + 1 : area.c2 - area.c1 + 1;
      for (let k = 0; k < count; k += 1) {
        const p = src[k % n], cell = cells[k % n];
        const r = down ? area.r1 + k : lane, c = down ? lane : area.c1 + k;
        if (series) { list.push({ r, c, v: cells[n - 1].v + step * (k + 1), s: cell.s || null }); continue; }
        const block = [[cell ? { v: cell.v, f: cell.f ? formulaText(ctx, tab.id, cell.f) : null, s: cell.s } : null]];
        list.push(...blockAt(block, r, c, r - p.r, c - p.c));
      }
    }
    writeCells(doc, tab.id, list);
    select({ r: Math.min(b.r1, area.r1), c: Math.min(b.c1, area.c1), r2: Math.max(b.r2, area.r2), c2: Math.max(b.c2, area.c2) }, false);
  };

  // ── mouse ───────────────────────────────────────────────────────────
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d === 'fill') { setFillTo(null); doFill(fillArea); }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  });

  const startResize = (e, axis, i) => {
    e.preventDefault(); e.stopPropagation();
    if (!canEdit) return;
    const id = axis === 'col' ? tab.cols[i] : tab.rows[i];
    const start = axis === 'col' ? e.clientX : e.clientY;
    const base = axis === 'col' ? colX[i + 1] - colX[i] : rowY[i + 1] - rowY[i];
    let px = base;
    const move = (ev) => { px = Math.max(16, base + ((axis === 'col' ? ev.clientX : ev.clientY) - start)); setResize({ id, px }); };
    const done = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', done);
      setResize(null);
      if (px !== base) setSize(doc, tab.id, id, px);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', done);
  };

  const onMouseDown = (e) => {
    const t = e.target;
    if (t.closest('input')) return;
    const rz = t.closest('[data-resize]');
    if (rz) { const [axis, i] = rz.dataset.resize.split(':'); startResize(e, axis, +i); return; }
    if (t.closest('[data-fill]')) { e.preventDefault(); dragRef.current = 'fill'; setFillTo(null); return; }
    if (t.closest('[data-add-rows]')) return;
    const right = e.button === 2;
    const cellEl = t.closest('[data-r]');
    const colEl = t.closest('[data-col]');
    const rowEl = t.closest('[data-row]');
    const all = t.closest('[data-all]');
    if (!cellEl && !colEl && !rowEl && !all) return;
    e.preventDefault();
    if (edit) commit();
    focusGrid();
    if (all) { select({ r: 0, c: 0, r2: R - 1, c2: C - 1 }, false); return; }
    if (colEl) {
      const c = +colEl.dataset.col;
      if (right && c >= b.c1 && c <= b.c2 && b.r1 === 0 && b.r2 === R - 1) return;
      select(e.shiftKey ? { ...sel, r: 0, r2: R - 1, c2: c } : { r: 0, c, r2: R - 1, c2: c }, false);
      dragRef.current = 'cols';
      return;
    }
    if (rowEl) {
      const r = +rowEl.dataset.row;
      if (right && r >= b.r1 && r <= b.r2 && b.c1 === 0 && b.c2 === C - 1) return;
      select(e.shiftKey ? { ...sel, c: 0, c2: C - 1, r2: r } : { r, c: 0, r2: r, c2: C - 1 }, false);
      dragRef.current = 'rows';
      return;
    }
    const r = +cellEl.dataset.r, c = +cellEl.dataset.c;
    if (right && r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2) return;
    select(e.shiftKey ? { ...sel, r2: r, c2: c } : { r, c, r2: r, c2: c }, false);
    dragRef.current = 'cells';
  };
  const onMouseOver = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const t = e.target;
    if (d === 'cols') { const el = t.closest('[data-col]') || t.closest('[data-c]'); if (el) setSel((s) => ({ ...s, c2: +(el.dataset.col ?? el.dataset.c) })); return; }
    if (d === 'rows') { const el = t.closest('[data-row]') || t.closest('[data-r]'); if (el) setSel((s) => ({ ...s, r2: +(el.dataset.row ?? el.dataset.r) })); return; }
    const el = t.closest('[data-r]');
    if (!el) return;
    const r = +el.dataset.r, c = +el.dataset.c;
    if (d === 'cells') setSel((s) => ({ ...s, r2: r, c2: c }));
    else if (d === 'fill') setFillTo({ r, c });
  };
  const onDoubleClick = (e) => {
    if (e.target.closest('[data-r]') && !e.target.closest('input')) startEdit(undefined, 'edit');
  };
  const onContextMenu = (e) => {
    if (e.target.closest('input')) return;
    const kind = e.target.closest('[data-col]') ? 'col' : e.target.closest('[data-row]') ? 'row' : e.target.closest('[data-r]') ? 'cell' : '';
    if (!kind) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, kind });
  };

  // ── clipboard ───────────────────────────────────────────────────────
  const copyBlock = (e, cut) => {
    if (e.target !== scroller.current) return;
    e.preventDefault();
    const block = [], texts = [], html = [];
    for (let r = b.r1; r <= b.r2; r += 1) {
      const br = [], tr = [], hr = [];
      for (let c = b.c1; c <= b.c2; c += 1) {
        const cell = cellAt(r, c);
        br.push(cell ? { v: cell.v, f: cell.f ? formulaText(ctx, tab.id, cell.f) : null, s: cell.s } : null);
        const t = shown(r, c);
        tr.push(t); hr.push({ text: t, s: cell?.s });
      }
      block.push(br); texts.push(tr); html.push(hr);
    }
    const tsv = toTSV(texts);
    e.clipboardData.setData('text/plain', tsv);
    e.clipboardData.setData('text/html', toHTML(html));
    clipRef.current = { tsv, block, r1: b.r1, c1: b.c1, cut };
    if (cut && canEdit) clearRange(doc, tab.id, b, { formats: true });
  };
  const pasteText = (text, html) => {
    if (!guard()) return;
    const clip = clipRef.current;
    let list;
    let h, w;
    if (clip && (text || '').replace(/\r/g, '').replace(/\n$/, '') === clip.tsv) {
      h = clip.block.length; w = clip.block[0].length;
      if (h === 1 && w === 1 && (b.r2 > b.r1 || b.c2 > b.c1)) {
        list = [];
        for (let r = b.r1; r <= b.r2; r += 1) for (let c = b.c1; c <= b.c2; c += 1) list.push(...blockAt(clip.block, r, c, r - clip.r1, c - clip.c1, clip.cut));
        h = b.r2 - b.r1 + 1; w = b.c2 - b.c1 + 1;
      } else list = blockAt(clip.block, b.r1, b.c1, b.r1 - clip.r1, b.c1 - clip.c1, clip.cut);
      if (clip.cut) clipRef.current = null;
    } else {
      const rows = text ? parseTSV(text) : html ? parseHTMLTable(html) : null;
      if (!rows || !rows.length) return;
      const single = rows.length === 1 && rows[0].length === 1;
      const area = single ? b : { r1: b.r1, c1: b.c1, r2: b.r1 + rows.length - 1, c2: b.c1 + Math.max(...rows.map((x) => x.length)) - 1 };
      list = [];
      for (let r = area.r1; r <= area.r2; r += 1) {
        for (let c = area.c1; c <= area.c2; c += 1) {
          const raw = single ? rows[0][0] : rows[r - area.r1]?.[c - area.c1];
          if (raw == null) continue;
          const cur = r < R && c < C ? cellAt(r, c) : null;
          const p = parseInput(raw, cur?.s?.nf);
          const s = p.nf && !cur?.s?.nf ? { ...(cur?.s || {}), nf: p.nf, ...(p.d != null ? { d: p.d } : {}) } : undefined;
          list.push({ r, c, v: p.v ?? null, f: p.f || null, s });
        }
      }
      h = area.r2 - area.r1 + 1; w = area.c2 - area.c1 + 1;
    }
    writeCells(doc, tab.id, list);
    select({ r: b.r1, c: b.c1, r2: b.r1 + h - 1, c2: b.c1 + w - 1 }, false);
  };
  const onPaste = (e) => {
    if (e.target !== scroller.current) return;
    e.preventDefault();
    pasteText(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'));
  };
  const pasteFromMenu = async () => {
    try { pasteText(await navigator.clipboard.readText(), ''); }
    catch { toastErr?.(`Press ${isMac ? 'Cmd' : 'Ctrl'}+V to paste.`); }
  };

  // ── find ────────────────────────────────────────────────────────────
  const matches = useMemo(() => {
    const q = (find?.q || '').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    tab.cells.forEach((cell, k) => {
      const [ri, ci] = k.split('.');
      const r = ctx.rowIndex(tab, ri), c = ctx.colIndex(tab, ci);
      if (r < 0 || c < 0) return;
      if (formatValue(eng.cellValue(tab, r, c), cell.s).toLowerCase().includes(q)) out.push({ r, c });
    });
    return out.sort((x, y) => x.r - y.r || x.c - y.c);
  }, [find?.q, tab, ctx, eng]);
  const findStep = (d) => {
    if (!matches.length) return;
    const i = ((find?.i ?? -1) + d + matches.length) % matches.length;
    setFind((f) => ({ ...f, i }));
    const m = matches[i];
    select({ r: m.r, c: m.c, r2: m.r, c2: m.c });
  };

  // ── keyboard ────────────────────────────────────────────────────────
  const edgeFrom = (r, c, dr, dc) => {
    const filled = (rr, cc) => { const x = cellAt(rr, cc); return !!x && (x.f != null || (x.v != null && x.v !== '')); };
    let rr = r, cc = c;
    const inside = (a, b2) => a >= 0 && a < R && b2 >= 0 && b2 < C;
    if (!inside(rr + dr, cc + dc)) return { r: rr, c: cc };
    if (filled(rr, cc) && filled(rr + dr, cc + dc)) {
      while (inside(rr + dr, cc + dc) && filled(rr + dr, cc + dc)) { rr += dr; cc += dc; }
      return { r: rr, c: cc };
    }
    rr += dr; cc += dc;
    while (inside(rr, cc) && !filled(rr, cc)) { if (!inside(rr + dr, cc + dc)) return { r: rr, c: cc }; rr += dr; cc += dc; }
    return { r: rr, c: cc };
  };
  const onKeyDown = (e) => {
    if (e.target !== scroller.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const moveTo = (r, c) => {
      r = clamp(r, 0, R - 1); c = clamp(c, 0, C - 1);
      select(e.shiftKey ? { ...sel, r2: r, c2: c } : { r, c, r2: r, c2: c });
    };
    const from = e.shiftKey ? { r: sel.r2, c: sel.c2 } : { r: sel.r, c: sel.c };
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[k]) {
      e.preventDefault();
      const [dr, dc] = arrows[k];
      if (mod) { const p = edgeFrom(from.r, from.c, dr, dc); moveTo(p.r, p.c); } else moveTo(from.r + dr, from.c + dc);
      return;
    }
    if (mod) {
      const lk = k.toLowerCase();
      if (lk === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (lk === 'y') { e.preventDefault(); redo(); return; }
      if (lk === 'b') { e.preventDefault(); toggle('b'); return; }
      if (lk === 'i') { e.preventDefault(); toggle('i'); return; }
      if (lk === 'u') { e.preventDefault(); toggle('u'); return; }
      if (lk === 'a') { e.preventDefault(); select({ r: 0, c: 0, r2: R - 1, c2: C - 1 }, false); return; }
      if (lk === 'f') { e.preventDefault(); setFind((f) => f || { q: '', i: -1 }); return; }
      if (k === 'Home') { e.preventDefault(); moveTo(0, 0); return; }
      return;
    }
    const page = Math.max(1, Math.floor((vp.h - CH - frozenH) / ROW_H) - 1);
    switch (k) {
      case 'Enter': { e.preventDefault(); const r = clamp(sel.r + (e.shiftKey ? -1 : 1), 0, R - 1); select({ r, c: sel.c, r2: r, c2: sel.c }); return; }
      case 'Tab': e.preventDefault(); select({ r: sel.r, c: clamp(sel.c + (e.shiftKey ? -1 : 1), 0, C - 1), r2: sel.r, c2: clamp(sel.c + (e.shiftKey ? -1 : 1), 0, C - 1) }); return;
      case 'F2': e.preventDefault(); startEdit(undefined, 'edit'); return;
      case 'Escape': setFind(null); return;
      case 'Delete': case 'Backspace': e.preventDefault(); if (canEdit) clearRange(doc, tab.id, b); return;
      case 'PageDown': e.preventDefault(); moveTo(from.r + page, from.c); return;
      case 'PageUp': e.preventDefault(); moveTo(from.r - page, from.c); return;
      case 'Home': e.preventDefault(); moveTo(from.r, 0); return;
      case 'End': e.preventDefault(); moveTo(from.r, Math.max(0, usedExtent().c)); return;
      default:
        if (k.length === 1 && !e.altKey && canEdit) { e.preventDefault(); startEdit(k, 'enter'); }
    }
  };

  // ── tabs ────────────────────────────────────────────────────────────
  const switchTab = (id) => { if (edit) commit(); setTabId(id); setSel({ r: 0, c: 0, r2: 0, c2: 0 }); setFind(null); scroller.current?.scrollTo?.(0, 0); };
  const renameTab = (id, name) => {
    setRenaming('');
    const n = String(name || '').trim().slice(0, 100);
    const t = ctx.tabById(id);
    if (!n || !t || n === t.name) return;
    if (ctx.tabs.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) { toastErr?.('Another tab already has that name.'); return; }
    setTabMeta(doc, id, { name: n });
  };
  const removeTab = async (id) => {
    const t = ctx.tabById(id);
    if (!t || ctx.tabs.length <= 1) return;
    const ok = await dialog.confirm(`Delete the tab "${t.name}"? Formulas on other tabs that use it will show #REF!. Undo brings it back.`, { title: 'Delete Tab', confirmText: 'Delete', danger: true });
    if (!ok) return;
    const i = ctx.tabs.findIndex((x) => x.id === id);
    deleteTab(doc, id);
    if (id === tab.id) setTabId(ctx.tabs[i === 0 ? 1 : i - 1]?.id || '');
  };

  const importFile = async (file, replace) => {
    if (!file || !guard()) return;
    try {
      const snap = await importSheetFile(file);
      loadSnapshot(doc, snap, { replace });
      setTabId(snap.tabs[0]?.id || '');
      setSel({ r: 0, c: 0, r2: 0, c2: 0 });
    } catch (err) { toastErr?.(err?.message || 'That file could not be read.'); }
  };
  const importMode = useRef(true);
  const askImport = async (replace) => {
    if (replace && !(await dialog.confirm('Replace every tab in this sheet with the file? Undo brings the old tabs back.', { title: 'Import and Replace', confirmText: 'Replace' }))) return;
    importMode.current = replace;
    fileRef.current?.click();
  };
  const download = (kind) => exportSheetFile(doc, title, kind, tab.id).catch((err) => toastErr?.(err?.message || 'The download did not work.'));

  // ── drawing ─────────────────────────────────────────────────────────
  const fillBox = fillArea;
  const single = b.r1 === b.r2 && b.c1 === b.c2;
  const renderCell = (r, c, x, y) => {
    const w = colX[c + 1] - colX[c], h = rowY[r + 1] - rowY[r];
    const raw = cellAt(r, c);
    const s = raw?.s || {};
    const isEdit = edit && edit.r === r && edit.c === c;
    const v = raw ? eng.cellValue(tab, r, c) : null;
    const text = isEdit ? edit.text : raw ? formatValue(v, s) : '';
    const shadows = [];
    const inSel = r >= b.r1 && r <= b.r2 && c >= b.c1 && c <= b.c2;
    if (r === sel.r && c === sel.c) shadows.push('inset 0 0 0 2px var(--nx-primary)');
    else if (inSel) {
      if (r === b.r1) shadows.push('inset 0 1px 0 0 var(--nx-primary)');
      if (r === b.r2) shadows.push('inset 0 -1px 0 0 var(--nx-primary)');
      if (c === b.c1) shadows.push('inset 1px 0 0 0 var(--nx-primary)');
      if (c === b.c2) shadows.push('inset -1px 0 0 0 var(--nx-primary)');
    }
    let tag = null;
    for (const x of remoteBoxes) {
      if (r < x.r1 || r > x.r2 || c < x.c1 || c > x.c2) continue;
      if (r === x.r1) shadows.push(`inset 0 2px 0 0 ${x.color}`);
      if (r === x.r2) shadows.push(`inset 0 -2px 0 0 ${x.color}`);
      if (c === x.c1) shadows.push(`inset 2px 0 0 0 ${x.color}`);
      if (c === x.c2) shadows.push(`inset -2px 0 0 0 ${x.color}`);
      if (r === x.r1 && c === x.c2) tag = x;
    }
    const inFill = fillBox && r >= fillBox.r1 && r <= fillBox.r2 && c >= fillBox.c1 && c <= fillBox.c2;
    const align = s.ha || (typeof v === 'number' ? 'right' : typeof v === 'boolean' || isErr(v) ? 'center' : 'left');
    const cls = `nxs-cell${inSel && !single ? ' is-in' : ''}${inFill ? ' is-fill' : ''}${tag ? ' has-tag' : ''}`;
    return (
      <div key={`${r}:${c}`} className={cls} data-r={r} data-c={c}
        aria-label={r === sel.r && c === sel.c ? `${a1(r, c)}, ${text || 'blank'}` : undefined}
        title={isErr(v) && v.note ? v.note : undefined}
        style={{
          left: x, top: y, width: w, height: h, boxShadow: shadows.join(', ') || undefined,
          background: s.bg || undefined, color: s.fc || (isErr(v) ? 'hsl(var(--color-red, 4 74% 49%))' : undefined),
          fontWeight: s.b ? 700 : undefined, fontStyle: s.i ? 'italic' : undefined,
          textDecoration: [s.u && 'underline', s.st && 'line-through'].filter(Boolean).join(' ') || undefined,
          justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
          whiteSpace: s.wrap ? 'normal' : 'nowrap', alignItems: s.wrap ? 'flex-start' : 'center',
        }}>
        {isEdit && edit.from === 'cell' ? (
          <input className="nxs-cell-input" autoFocus value={edit.text} spellCheck={false} aria-label={`Edit ${a1(r, c)}`}
            style={{ textAlign: edit.text.startsWith('=') ? 'left' : align, minWidth: w }}
            onChange={(e) => { setEdit({ ...edit, text: e.target.value }); setPick(0); }} onKeyDown={editKey} />
        ) : <span className="nxs-text">{text}</span>}
        {tag && <span className="nxs-tag" style={{ background: tag.color }}>{tag.name}</span>}
        {canEdit && !edit && r === b.r2 && c === b.c2 && <span className="nxs-fill" data-fill="1" aria-hidden="true" />}
      </div>
    );
  };
  const colHead = (c, x) => (
    <div key={`h${c}`} className={`nxs-head nxs-colhead${c >= b.c1 && c <= b.c2 ? ' is-on' : ''}`} data-col={c}
      style={{ left: x, top: 0, width: colX[c + 1] - colX[c], height: CH }}>
      {colName(c)}
      {canEdit && <span className="nxs-rz nxs-rz-col" data-resize={`col:${c}`} aria-hidden="true" />}
    </div>
  );
  const rowHead = (r, y) => (
    <div key={`r${r}`} className={`nxs-head nxs-rowhead${r >= b.r1 && r <= b.r2 ? ' is-on' : ''}`} data-row={r}
      style={{ left: 0, top: y, width: RH, height: rowY[r + 1] - rowY[r] }}>
      {r + 1}
      {canEdit && <span className="nxs-rz nxs-rz-row" data-resize={`row:${r}`} aria-hidden="true" />}
    </div>
  );

  const bodyRows = [], bodyCols = [];
  for (let r = rA; r <= rB; r += 1) bodyRows.push(r);
  for (let c = cA; c <= cB; c += 1) bodyCols.push(c);
  const frozenRowList = Array.from({ length: fr }, (_, i) => i);
  const frozenColList = Array.from({ length: fc }, (_, i) => i);

  const s0 = active?.s || {};
  const barText = edit ? edit.text : textOf(sel.r, sel.c);
  const [nameText, setNameText] = useState(null);
  const nameBox = nameText ?? (single ? a1(sel.r, sel.c) : `${a1(b.r1, b.c1)}:${a1(b.r2, b.c2)}`);
  const n = (axis) => (axis === 'rows' ? b.r2 - b.r1 + 1 : b.c2 - b.c1 + 1);
  const many = (k, word1) => (k === 1 ? `1 ${word1}` : `${k} ${word1}s`);

  const cellMenu = [
    { label: 'Cut', onClick: () => { focusGrid(); document.execCommand?.('cut'); }, disabled: !canEdit },
    { label: 'Copy', onClick: () => { focusGrid(); document.execCommand?.('copy'); } },
    { label: 'Paste', onClick: pasteFromMenu, disabled: !canEdit },
    '-',
    { label: `Insert ${many(n('rows'), 'Row')} Above`, onClick: () => lines('rows', 'before'), disabled: !canEdit },
    { label: `Insert ${many(n('rows'), 'Row')} Below`, onClick: () => lines('rows', 'after'), disabled: !canEdit },
    { label: `Insert ${many(n('cols'), 'Column')} Left`, onClick: () => lines('cols', 'before'), disabled: !canEdit },
    { label: `Insert ${many(n('cols'), 'Column')} Right`, onClick: () => lines('cols', 'after'), disabled: !canEdit },
    '-',
    { label: n('rows') === 1 ? 'Delete Row' : `Delete ${n('rows')} Rows`, onClick: () => lines('rows', 'delete'), disabled: !canEdit || n('rows') >= R },
    { label: n('cols') === 1 ? 'Delete Column' : `Delete ${n('cols')} Columns`, onClick: () => lines('cols', 'delete'), disabled: !canEdit || n('cols') >= C },
    '-',
    { label: 'Clear Contents', onClick: () => clearRange(doc, tab.id, b), disabled: !canEdit },
    { label: 'Clear Formatting', onClick: () => applyStyle({ b: null, i: null, u: null, st: null, fc: null, bg: null, ha: null, wrap: null, nf: null, d: null }), disabled: !canEdit },
    '-',
    { label: 'Sort A to Z', icon: ArrowDownAZ, onClick: () => sortBy(false), disabled: !canEdit },
    { label: 'Sort Z to A', icon: ArrowUpZA, onClick: () => sortBy(true), disabled: !canEdit },
  ];
  const menuItems = menu?.kind === 'col' ? cellMenu.filter((it) => it === '-' || !/Row/.test(it.label))
    : menu?.kind === 'row' ? cellMenu.filter((it) => it === '-' || !/Column|Sort/.test(it.label)) : cellMenu;

  const freezeItems = (axis) => {
    const cur = axis === 'rows' ? fr : fc, at = axis === 'rows' ? sel.r + 1 : sel.c + 1;
    const key = axis === 'rows' ? 'frozenRows' : 'frozenCols';
    const word1 = axis === 'rows' ? 'Row' : 'Column';
    const opts = [[0, `No ${word1}s`], [1, `1 ${word1}`], [2, `2 ${word1}s`]];
    if (at > 2) opts.push([at, `Up to ${axis === 'rows' ? `Row ${at}` : `Column ${colName(at - 1)}`}`]);
    return opts.map(([k, label]) => ({ label: `Freeze ${label}`, active: cur === k, onClick: () => canEdit && setTabMeta(doc, tab.id, { [key]: k }), disabled: !canEdit }));
  };

  return (
    <div className="nx-sheet">
      <div className="doc-toolbar doc-ribbon nxs-toolbar" role="toolbar" aria-label="Sheet tools">
        <SmallBtn icon={Undo2} title={`Undo (${isMac ? 'Cmd' : 'Ctrl'}+Z)`} onClick={undo} disabled={!canEdit || !stacks.undo} />
        <SmallBtn icon={Redo2} title={`Redo (${isMac ? 'Cmd' : 'Ctrl'}+Y)`} onClick={redo} disabled={!canEdit || !stacks.redo} />
        <span className="doc-toolbar-sep" />
        <Menu label="File" title="File" items={[
          { label: 'Import and Replace', icon: FileUp, onClick: () => askImport(true), disabled: !canEdit },
          { label: 'Import as New Tabs', icon: FileUp, onClick: () => askImport(false), disabled: !canEdit },
          '-',
          { label: 'Download as .xlsx', icon: FileDown, onClick: () => download('xlsx') },
          { label: 'Download This Tab as .csv', icon: FileDown, onClick: () => download('csv') },
        ]} />
        <Menu label="View" title="View" items={[...freezeItems('rows'), '-', ...freezeItems('cols')]} />
        <span className="doc-toolbar-sep" />
        <select className="nxs-select" aria-label="Number Format" value={s0.nf || ''} disabled={!canEdit}
          onChange={(e) => applyStyle({ nf: e.target.value || null, d: null })}>
          {NUMBER_FORMATS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <SmallBtn title="Fewer Decimal Places" onClick={() => decimals(-1)} disabled={!canEdit}><span className="nxs-dec">.0</span></SmallBtn>
        <SmallBtn title="More Decimal Places" onClick={() => decimals(1)} disabled={!canEdit}><span className="nxs-dec">.00</span></SmallBtn>
        <span className="doc-toolbar-sep" />
        <SmallBtn icon={Bold} title="Bold" active={!!s0.b} onClick={() => toggle('b')} disabled={!canEdit} />
        <SmallBtn icon={Italic} title="Italic" active={!!s0.i} onClick={() => toggle('i')} disabled={!canEdit} />
        <SmallBtn icon={Underline} title="Underline" active={!!s0.u} onClick={() => toggle('u')} disabled={!canEdit} />
        <SmallBtn icon={Strikethrough} title="Strikethrough" active={!!s0.st} onClick={() => toggle('st')} disabled={!canEdit} />
        <Menu icon={Baseline} title="Text Color" disabled={!canEdit}>
          {(close) => <ColorGrid rows={COLOR_ROWS} current={s0.fc} onPick={(hex) => { applyStyle({ fc: hex.toLowerCase() }); close(); }} onNone={() => { applyStyle({ fc: null }); close(); }} noneLabel="Automatic" />}
        </Menu>
        <Menu icon={PaintBucket} title="Fill Color" disabled={!canEdit}>
          {(close) => <ColorGrid rows={COLOR_ROWS} current={s0.bg} onPick={(hex) => { applyStyle({ bg: hex.toLowerCase() }); close(); }} onNone={() => { applyStyle({ bg: null }); close(); }} />}
        </Menu>
        <span className="doc-toolbar-sep" />
        <SmallBtn icon={AlignLeft} title="Align Left" active={s0.ha === 'left'} onClick={() => applyStyle({ ha: s0.ha === 'left' ? null : 'left' })} disabled={!canEdit} />
        <SmallBtn icon={AlignCenter} title="Align Center" active={s0.ha === 'center'} onClick={() => applyStyle({ ha: s0.ha === 'center' ? null : 'center' })} disabled={!canEdit} />
        <SmallBtn icon={AlignRight} title="Align Right" active={s0.ha === 'right'} onClick={() => applyStyle({ ha: s0.ha === 'right' ? null : 'right' })} disabled={!canEdit} />
        <SmallBtn icon={WrapText} title="Wrap Text" active={!!s0.wrap} onClick={() => toggle('wrap')} disabled={!canEdit} />
        <span className="doc-toolbar-sep" />
        <SmallBtn icon={ArrowDownAZ} title="Sort A to Z" onClick={() => sortBy(false)} disabled={!canEdit} />
        <SmallBtn icon={ArrowUpZA} title="Sort Z to A" onClick={() => sortBy(true)} disabled={!canEdit} />
        <SmallBtn icon={Search} title={`Find (${isMac ? 'Cmd' : 'Ctrl'}+F)`} active={!!find} onClick={() => setFind((f) => (f ? null : { q: '', i: -1 }))} />
        {(fr > 0 || fc > 0) && <span className="nxs-frozen" title="Rows or columns are frozen (View menu)"><Snowflake size={13} /></span>}
        {!canEdit && <span className="nxs-readonly">View Only</span>}
      </div>

      <div className="nxs-bar">
        <input className="nxs-namebox" aria-label="Name Box" value={nameBox} spellCheck={false}
          onFocus={(e) => { setNameText(nameBox); e.target.select(); }}
          onChange={(e) => setNameText(e.target.value)}
          onBlur={() => setNameText(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setNameText(null); focusGrid(); }
            if (e.key !== 'Enter') return;
            const p = parseA1(nameText ?? '');
            setNameText(null);
            if (p) select({ r: clamp(p.r, 0, R - 1), c: clamp(p.c, 0, C - 1), r2: clamp(p.r2, 0, R - 1), c2: clamp(p.c2, 0, C - 1) });
            focusGrid();
          }} />
        <span className="nxs-fx" aria-hidden="true">fx</span>
        <div className="nxs-formula-wrap">
          <input ref={barRef} className="nxs-formula" aria-label="Formula Bar" value={barText} readOnly={!canEdit} spellCheck={false}
            onFocus={() => { if (canEdit && !edit) startEdit(undefined, 'edit', 'bar'); else if (edit) setEdit((ed) => ({ ...ed, from: 'bar' })); }}
            onChange={(e) => { setEdit((ed) => ({ ...(ed || { r: sel.r, c: sel.c, mode: 'edit' }), from: 'bar', text: e.target.value })); setPick(0); }}
            onKeyDown={editKey} />
          {(suggestions.length > 0 || hint) && (
            <div className="nxs-suggest" role="listbox" aria-label="Functions">
              {suggestions.map((name, i) => (
                <button key={name} type="button" role="option" aria-selected={i === pick} className={i === pick ? 'is-on' : ''}
                  onMouseDown={(e) => { e.preventDefault(); accept(name); }}>
                  <b>{name}</b><span>{SIGS[name]}</span>
                </button>
              ))}
              {!suggestions.length && hint && <div className="nxs-hint">{hint}</div>}
            </div>
          )}
        </div>
      </div>

      {find && (
        <div className="nxs-find">
          <Search size={14} />
          <input autoFocus placeholder="Find in this tab" aria-label="Find in this tab" value={find.q}
            onChange={(e) => setFind({ q: e.target.value, i: -1 })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { setFind(null); focusGrid(); } }} />
          <span className="nxs-find-count">{find.q ? `${matches.length ? (find.i >= 0 ? find.i + 1 : 0) : 0} of ${matches.length}` : ''}</span>
          <button type="button" aria-label="Previous Match" title="Previous Match" onClick={() => findStep(-1)}><ChevronUp size={15} /></button>
          <button type="button" aria-label="Next Match" title="Next Match" onClick={() => findStep(1)}><ChevronDown size={15} /></button>
          <button type="button" aria-label="Close Find" title="Close Find" onClick={() => { setFind(null); focusGrid(); }}><X size={15} /></button>
        </div>
      )}

      <div ref={scroller} className="nxs-scroll" tabIndex={0} role="grid" aria-rowcount={R} aria-colcount={C}
        aria-label={`${tab.name}, ${a1(sel.r, sel.c)}, ${shown(sel.r, sel.c) || 'blank'}`}
        onScroll={onScroll} onKeyDown={onKeyDown} onMouseDown={onMouseDown} onMouseOver={onMouseOver}
        onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
        onCopy={(e) => copyBlock(e, false)} onCut={(e) => copyBlock(e, true)} onPaste={onPaste}>
        <div className="nxs-canvas" style={{ width: totalW, height: totalH }}>
          <div className="nxs-band-top" style={{ height: CH + frozenH }}>
            <div className="nxs-corner" style={{ width: RH + frozenW, height: CH + frozenH }}>
              <div className="nxs-head nxs-all" data-all="1" title="Select All" style={{ left: 0, top: 0, width: RH, height: CH }} />
              {frozenColList.map((c) => colHead(c, RH + colX[c]))}
              {frozenRowList.map((r) => rowHead(r, CH + rowY[r]))}
              {frozenRowList.map((r) => frozenColList.map((c) => renderCell(r, c, RH + colX[c], CH + rowY[r])))}
            </div>
            {bodyCols.map((c) => colHead(c, RH + colX[c]))}
            {frozenRowList.map((r) => bodyCols.map((c) => renderCell(r, c, RH + colX[c], CH + rowY[r])))}
          </div>
          <div className="nxs-band-left" style={{ width: RH + frozenW }}>
            {bodyRows.map((r) => rowHead(r, rowY[r] - frozenH))}
            {bodyRows.map((r) => frozenColList.map((c) => renderCell(r, c, RH + colX[c], rowY[r] - frozenH)))}
          </div>
          {bodyRows.map((r) => bodyCols.map((c) => renderCell(r, c, RH + colX[c], CH + rowY[r])))}
          {canEdit && (
            <div className="nxs-more" data-add-rows="1" style={{ top: CH + rowY[R] + 10, left: RH + 10 }}>
              <button type="button" onClick={() => insertLines(doc, tab.id, 'rows', R, 1000)}>Add 1,000 More Rows</button>
            </div>
          )}
        </div>
      </div>

      <div className="nxs-tabs" role="tablist" aria-label="Tabs">
        {canEdit && (
          <button type="button" className="nxs-tab-add" title="Add Tab" aria-label="Add Tab"
            onClick={() => { const id = addTab(doc, null); switchTab(id); }}><Plus size={15} /></button>
        )}
        {ctx.tabs.map((t) => {
          const on = t.id === tab.id;
          return (
            <div key={t.id} className={`nxs-tab${on ? ' is-on' : ''}`} style={{ borderBottomColor: t.color || undefined }}>
              {renaming === t.id ? (
                <input autoFocus defaultValue={t.name} aria-label="Tab Name" maxLength={100}
                  onBlur={(e) => renameTab(t.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(''); }} />
              ) : (
                <button type="button" role="tab" aria-selected={on} onClick={() => switchTab(t.id)}
                  onDoubleClick={() => canEdit && setRenaming(t.id)}>{t.name}</button>
              )}
              {on && canEdit && renaming !== t.id && (
                <button type="button" className="nxs-tab-menu" aria-label={`${t.name} Options`} title="Tab Options"
                  onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.top - 4, kind: 'tab', up: true }); }}>
                  <MoreVertical size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importFile(f, importMode.current); }} />

      {menu && menu.kind !== 'tab' && <PopMenu at={menu} items={menuItems} onClose={() => setMenu(null)} />}
      {menu?.kind === 'tab' && (
        <PopMenu at={menu} onClose={() => setMenu(null)} items={[
          { label: 'Rename', onClick: () => setRenaming(tab.id) },
          { label: 'Duplicate', onClick: () => { const id = duplicateTab(doc, tab.id); if (id) switchTab(id); } },
          { label: 'Move Left', onClick: () => moveTab(doc, tab.id, -1), disabled: ctx.tabs[0]?.id === tab.id },
          { label: 'Move Right', onClick: () => moveTab(doc, tab.id, 1), disabled: ctx.tabs[ctx.tabs.length - 1]?.id === tab.id },
          '-',
          { label: 'Delete', onClick: () => removeTab(tab.id), disabled: ctx.tabs.length <= 1 },
        ]}>
          <div className="doc-ribbon-sep" />
          <div className="nxs-pop-label">Tab Color</div>
          <ColorGrid rows={[STANDARD_COLORS.map((h) => [h])]} more={false} current={tab.color}
            onPick={(hex) => { setTabMeta(doc, tab.id, { color: hex.toLowerCase() }); setMenu(null); }}
            onNone={() => { setTabMeta(doc, tab.id, { color: '' }); setMenu(null); }} />
        </PopMenu>
      )}
    </div>
  );
}

